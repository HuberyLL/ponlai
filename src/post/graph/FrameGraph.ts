import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import {
	GraphDecl, GraphError, compileGraph, drawsOver, resolveSize, sizeClassKey, sizeScales, targetKey,
	type CompiledGraph, type Extents, type OpsTable, type PassBuilder, type PassFlags, type PassKind,
	type ResourceDecl, type ResourceDesc, type ResourceHandle, type Samples, type Size, type SizeClass, type TargetInfo,
} from './GraphCompiler.ts';
import { AttachmentOps } from './AttachmentOps.ts';

// The frame graph's runtime: it owns the graph's textures and render targets, their sizes and
// lifetimes, and executes the compiled passes in order with three's own executors (a scene render,
// a QuadMesh, a RenderPipeline and the rtt / bloom passes it updates on the way, a compute
// dispatch, or a callback). The graph decides which passes run (`when`), binds each pass's target
// and MRT, clears or loads its attachments, and rewrites the stores and resolves three records
// (AttachmentOps); at the frame's end it swaps ping-pong histories and makes the persistent copies.
// See GraphCompiler.ts for the model.
//
// Textures exist from their declaration (TSL nodes bind them while the passes are built), at 1x1
// until `setExtents` sizes them. Each distinct tuple of attachments a pass writes is one
// THREE.RenderTarget whose textures are the resources' own; a depth resource always lives in a
// render target (a DepthTexture outside one takes the renderer's sample count). `renderTarget`
// makes the target of a tuple ahead of the passes (code that still binds its targets by hand,
// probes and warm-ups); the passes that later draw into the same tuple use that target. Every
// target the graph makes follows its size class through `setExtents`, and passes the graph does
// not own (three's rtt and bloom chains inside a chain pass) follow it through `onResize`.
//
// A texture may sit in several of those render targets (a resource written alone by one pass and
// with a velocity attachment by another). In three r186 `RenderTarget.setSize` disposes the target,
// which destroys every texture in it, and each target's first `updateRenderTarget` after that
// recreates all its textures (its own record of the size is gone): a second target's first use in
// a frame would wipe what the first had drawn into the shared texture. So after any resize the
// targets that share a texture are initialised, in declaration order, before the next frame's
// first pass draws; the recreations then happen while nothing holds content. So are the targets
// no pass draws into (a frame-end copy's destination, a texture written by storage), whose first
// use is not a draw. Any other target initialises itself when a pass first draws into it, as
// before the graph: a pass that runs only now and then (the sea fog, the upscale) allocates
// nothing until it does. A depth texture's size is set by the graph itself, since three resizes it
// only through the one target that owns it.

export type { SizeClass, ResourceHandle, ResourceDesc, PassKind } from './GraphCompiler.ts';

type Uniform2 = THREE.UniformNode<'vec2', THREE.Vector2>;
// a resize hook and the size it last had (null: not called yet)
type ResizeHook = { size: SizeClass; hook: ( width: number, height: number ) => void; last: Size | null };

/** What a pass's setup returns: its flags and its executor. */
export interface PassDef<F> extends PassFlags {
	when?: ( f: F ) => boolean;
	mrt?: THREE.MRTNode | null;
	// scene: what to draw and from where, with a hook before the draw
	scene?: THREE.Object3D | ( ( f: F ) => THREE.Object3D );
	camera?: THREE.Camera | ( ( f: F ) => THREE.Camera );
	before?( f: F ): void;
	// scene: objects drawn only later (weather, effects), for the warm-up
	latent?(): THREE.Object3D[];
	// quad: a full-screen material
	quad?: THREE.QuadMesh;
	// chain: a render pipeline (with the rtt and bloom passes its output node updates)
	pipeline?: THREE.RenderPipeline;
	// compute: the kernels to dispatch
	compute?: THREE.ComputeNode | THREE.ComputeNode[] | ( ( f: F ) => THREE.ComputeNode | THREE.ComputeNode[] | null );
	// any kind: replaces the default executor (callback: required)
	run?( f: F, graph: FrameGraph<F> ): void;
}

export interface CurrentPass { readonly name: string; readonly label: string; readonly size: SizeClass | null; readonly scales: 'pixel' | 'fixed' }

/** What the owners of passes (the sea fog, the upscale) declare on the graph while it is built. */
export interface GraphResources {
	color( name: string, desc: ResourceDesc, persistent?: boolean ): ResourceHandle;
	renderTarget( colors: readonly ResourceHandle[], depth?: ResourceHandle | null ): THREE.RenderTarget;
	texture( h: ResourceHandle, parity?: 0 | 1 ): THREE.Texture;
	extent( size: SizeClass ): Uniform2;
	onResize( size: SizeClass, hook: ( width: number, height: number ) => void ): void;
}

export interface FrameGraphHooks<F> {
	onPassBegin?( pass: CurrentPass, f: F ): void;
	onPassEnd?( pass: CurrentPass, f: F ): void;
	// around the contiguous span of jittered passes that run (the TAA jitter, M6)
	jitterBegin?( f: F ): void;
	jitterEnd?( f: F ): void;
}

export interface FrameGraphOptions {
	// the scene's sample count, for `samples: 'scene'`
	sceneSamples: number;
	// the passes whose multisampled stores the legacy ops discard (default: the rain)
	legacyDiscard?: string[];
	// dev checks: target sizes against their classes, attachment counts
	dev?: boolean;
}

interface Physical {
	// the resource's texture, and the second one of a ping-pong resource
	textures: THREE.Texture[];
	// the render target (per ping-pong parity) that owns each texture
	owners: ( THREE.RenderTarget | null )[];
	// history valid (ping-pong, persistent copies): false after resetHistory (or a resize) until
	// written again
	valid: boolean;
	// a ping-pong resource: which of its two textures holds the newest content. It moves only at
	// the end of a frame that wrote the resource, so after a frame whose writer was skipped both
	// `previous` and the current version still read the newest history, and the next write goes
	// to the other texture instead of overwriting it.
	newest: 0 | 1;
	// imported render target or texture (not sized by the graph)
	imported: boolean;
	// the size it was last given (null: not yet)
	size?: { width: number; height: number } | null;
}

const filterOf = ( f: ResourceDesc[ 'filter' ] ) => f === 'nearest' ? THREE.NearestFilter : THREE.LinearFilter;

export class FrameGraph<F = unknown> {

	readonly renderer: THREE.WebGPURenderer;
	readonly decl = new GraphDecl();
	readonly hooks: FrameGraphHooks<F> = {};
	/** The pass executing, for the profiler and the dynamic resolution's pass scaling. */
	currentPass: CurrentPass | null = null;
	/** Dev counter: render pass descriptors whose store or resolve was rewritten in the last frame. */
	opsApplied = 0;
	/** The descriptors the last frame's ops table rewrites (`opsApplied` equals it while
	 * AttachmentOps is installed and nothing bypasses it). */
	opsExpected = 0;
	/** Dev counter: targets found at a size other than their class's (an executed pass's, or any
	 * graph target's in `validateSizes`). */
	sizeErrors = 0;
	/** Dev counter: frames whose rewritten descriptors (`opsApplied`) differed from the compiled
	 * table's `rewrites` while AttachmentOps was installed (bypassed by a later wrapper, a target
	 * of another layout, a pass re-begun on its encoder). */
	opsMismatchFrames = 0;
	readonly attachmentOps: AttachmentOps;
	private readonly options: Required<FrameGraphOptions>;
	private readonly defs: PassDef<F>[] = [];
	private readonly physical: Physical[] = [];
	private compiled: CompiledGraph | null = null;
	// per target key: its render target(s), one per ping-pong parity
	private readonly targets = new Map<string, THREE.RenderTarget[]>();
	// every render target the graph made, with the size class it follows
	private readonly targetSizes = new Map<THREE.RenderTarget, SizeClass>();
	// the targets of resources no live pass draws into (initialised after every resize)
	private readonly soloTargets = new Set<THREE.RenderTarget>();
	// passes the graph does not own, sized through onResize (`last`: the size each last had)
	private readonly resizeHooks: ResizeHook[] = [];
	private extentsSet = false;
	private extents: Extents = { render: { width: 1, height: 1 }, canvas: { width: 1, height: 1 } };
	private readonly extentNodes = new Map<string, { size: SizeClass; node: Uniform2 }>();
	private saved: {
		target: THREE.RenderTarget | null; mrt: THREE.MRTNode | null; depth: boolean; stencil: boolean;
		autoClear: boolean; autoClearColor: boolean; autoClearDepth: boolean; autoClearStencil: boolean;
	} | null = null;
	private executing = false;
	// the targets were resized (or made): initialise them all before the next frame draws
	private needsInit = true;
	// during execute: the resources some running pass writes this frame
	private frameWritten: Set<number> | null = null;
	private readonly drawingBuffer = new THREE.Vector2();

	constructor( renderer: THREE.WebGPURenderer, options: FrameGraphOptions ) {

		this.renderer = renderer;
		this.options = { legacyDiscard: [ 'rain' ], dev: false, ...options };
		this.attachmentOps = new AttachmentOps( renderer.backend, { dev: this.options.dev } );

	}

	// ---- resources

	private makeTexture( desc: ResourceDesc ): THREE.Texture {

		// as THREE.RenderTarget makes its textures (the render target is set when one owns it)
		const texture = new THREE.Texture( { width: 1, height: 1, depth: 1 } as unknown as HTMLImageElement );
		texture.isRenderTargetTexture = true;
		texture.flipY = false;
		texture.generateMipmaps = false;
		texture.minFilter = texture.magFilter = filterOf( desc.filter );
		if ( desc.format !== undefined ) texture.format = desc.format as THREE.AnyPixelFormat;
		if ( desc.type !== undefined ) texture.type = desc.type as THREE.TextureDataType;
		return texture;

	}

	private add( h: ResourceHandle, textures: THREE.Texture[], imported = false ): ResourceHandle {

		this.physical[ h.resource ] = { textures, owners: textures.map( () => null ), valid: true, imported, newest: 1 };
		return h;

	}

	/** A colour resource; `persistent` keeps its content across frames. */
	color( name: string, desc: ResourceDesc, persistent = false ): ResourceHandle {

		this.mutable( name );
		const h = this.decl.color( name, desc, persistent );
		const texture = this.makeTexture( desc );
		texture.name = name;
		return this.add( h, [ texture ] );

	}

	/** A depth resource (float depth by default), always in a render target of its own size. */
	depth( name: string, desc: { size: SizeClass; samples?: Samples; type?: THREE.TextureDataType } ): ResourceHandle {

		this.mutable( name );
		const h = this.decl.depth( name, { ...desc, type: desc.type ?? THREE.FloatType } );
		const texture = new THREE.DepthTexture( 1, 1 );
		texture.type = desc.type ?? THREE.FloatType;
		texture.name = name;
		return this.add( h, [ texture ] );

	}

	/** A texture or render target made outside the graph, or the canvas (`null`). */
	import( name: string, target: THREE.Texture | THREE.RenderTarget | null, size: SizeClass ): ResourceHandle {

		this.mutable( name );
		const texture = target === null ? null : ( target as THREE.RenderTarget ).isRenderTarget ? ( target as THREE.RenderTarget ).texture : target as THREE.Texture;
		const h = this.decl.import( name, { size, format: texture?.format, type: texture?.type, samples: ( target as THREE.RenderTarget | null )?.isRenderTarget ? Math.max( ( target as THREE.RenderTarget ).samples, 1 ) : 1 }, target === null );
		this.add( h, texture ? [ texture ] : [], true );
		if ( target && ( target as THREE.RenderTarget ).isRenderTarget ) this.physical[ h.resource ].owners = [ target as THREE.RenderTarget ];
		return h;

	}

	/** The resource's texture for TSL: stable for the graph's life. A ping-pong resource has two:
	 * `parity` picks one for the current version and the other for its `previous` handle (default:
	 * `parityOf( h )`). */
	texture( h: ResourceHandle, parity?: 0 | 1 ): THREE.Texture {

		const p = this.physical[ h.resource ];
		if ( ! p || p.textures.length === 0 ) throw new GraphError( `'${ h.name }' has no texture (the canvas)` );
		if ( p.textures.length === 1 ) return p.textures[ 0 ];
		const current = parity ?? this.parityOf( h );
		return p.textures[ h.previous ? 1 - current : current ];

	}

	/** Which texture holds a ping-pong resource's current version (0 for any other resource): a
	 * pass built once per texture runs the build of this parity. During a frame that writes the
	 * resource it is the texture written (the other holds `previous`); during a frame whose writer
	 * is skipped, the newest history, which the current version then is; outside a frame, the
	 * texture the next write goes to. */
	parityOf( h: ResourceHandle ): 0 | 1 {

		const p = this.physical[ h.resource ];
		if ( p.textures.length < 2 ) return 0;
		const writes = this.frameWritten ? this.frameWritten.has( h.resource ) : true;
		return ( writes ? 1 - p.newest : p.newest ) as 0 | 1;

	}

	/** The previous frame's version of a colour resource, kept in a second texture (see
	 * GraphDecl.previous: only for passes built once per texture). */
	previous( h: ResourceHandle ): ResourceHandle {

		this.mutable( h.name );
		if ( this.physical[ h.resource ]?.owners.some( Boolean ) ) throw new GraphError( `previous( '${ h.name }' ): a render target already holds it (declare previous() before renderTarget())` );
		const prev = this.decl.previous( h );
		const p = this.physical[ h.resource ];
		if ( p.textures.length === 1 ) {

			// a texture of its own (Texture.clone would share the first one's Source and image)
			const second = this.makeTexture( this.decl.get( h ).desc );
			second.name = `${ h.name }.previous`;
			p.textures.push( second );
			p.owners.push( null );

		}
		return prev;

	}

	/** Copies `src` into the persistent `dst` at the frame's end (copyTextureToTexture). */
	copyToPersistent( src: ResourceHandle, dst: ResourceHandle ): void {

		this.mutable( dst.name );
		this.decl.copyToPersistent( src, dst );

	}

	/** Marks a history (ping-pong or persistent) invalid until the graph writes it again. */
	resetHistory( h: ResourceHandle ): void {

		this.physical[ h.resource ].valid = false;

	}

	historyValid( h: ResourceHandle ): boolean {

		return this.physical[ h.resource ].valid;

	}

	/** A vec2 uniform holding a size class's pixel size, shared by every caller of that class. */
	extent( size: SizeClass ): Uniform2 {

		const key = sizeClassKey( size );
		let e = this.extentNodes.get( key );
		if ( ! e ) {

			const s = resolveSize( size, this.extents );
			e = { size, node: uniform( new THREE.Vector2( s.width, s.height ) ) as unknown as Uniform2 };
			this.extentNodes.set( key, e );

		}
		return e.node;

	}

	/** Calls `hook` with a size class's pixel size whenever `setExtents` changes it (and once
	 * extents are first set): for render targets the graph does not own, such as three's rtt and
	 * bloom passes inside a chain, so they follow the graph's extents with its rounding. */
	onResize( size: SizeClass, hook: ( width: number, height: number ) => void ): void {

		const entry: ResizeHook = { size, hook, last: null };
		this.resizeHooks.push( entry );
		if ( this.extentsSet ) this.runHook( entry );

	}

	private runHook( entry: ResizeHook ): void {

		const s = resolveSize( entry.size, this.extents );
		if ( entry.last && entry.last.width === s.width && entry.last.height === s.height ) return;
		entry.last = s;
		entry.hook( s.width, s.height );

	}

	/** The render target that holds these attachments: colour resources in attachment order and
	 * a depth resource, of one size class and sample count, none ping-pong or imported. It is the
	 * target the passes drawing into the same attachments use; made now if no pass or earlier call
	 * made it, for code that binds its targets by hand, probes and warm-ups. */
	renderTarget( colors: readonly ResourceHandle[], depth: ResourceHandle | null = null ): THREE.RenderTarget {

		const decls = colors.map( ( h ) => this.decl.get( h ) );
		const depthDecl = depth ? this.decl.get( depth ) : null;
		const all = depthDecl ? [ ...decls, depthDecl ] : decls;
		const what = `renderTarget( ${ all.map( ( r ) => `'${ r.name }'` ).join( ', ' ) } )`;
		if ( decls.length === 0 ) throw new GraphError( `${ what }: no colour attachment (three's render targets carry one)` );
		if ( decls.some( ( r ) => r.kind !== 'color' ) || ( depthDecl && depthDecl.kind !== 'depth' ) ) throw new GraphError( `${ what }: colour resources, then a depth resource` );
		if ( all.some( ( r ) => r.pingPong ) ) throw new GraphError( `${ what }: a ping-pong resource has a target per parity` );
		const key = targetKey( decls.map( ( r ) => r.name ), depthDecl ? depthDecl.name : null );
		const made = this.targets.get( key );
		if ( made ) return made[ 0 ];
		const size = all[ 0 ].desc.size, samples = this.samplesOfDecl( all[ 0 ] );
		for ( const r of all ) {

			if ( sizeClassKey( r.desc.size ) !== sizeClassKey( size ) ) throw new GraphError( `${ what }: attachments of different size classes` );
			if ( this.samplesOfDecl( r ) !== samples ) throw new GraphError( `${ what }: attachments of different sample counts` );

		}
		const rt = this.makeTarget( decls.map( ( r ) => this.physical[ r.id ].textures[ 0 ] ), depthDecl ? this.physical[ depthDecl.id ].textures[ 0 ] as THREE.DepthTexture : null, samples );
		this.targets.set( key, [ rt ] );
		this.targetSizes.set( rt, size );
		for ( const r of all ) this.physical[ r.id ].owners[ 0 ] ??= rt;
		if ( this.sizeTarget( rt, size ) ) this.needsInit = true;
		return rt;

	}

	/** The render target that holds a resource (the first that took it: a pass's, or one made by
	 * `renderTarget`); the current or previous parity's for a ping-pong resource. */
	target( h: ResourceHandle ): THREE.RenderTarget {

		const p = this.physical[ h.resource ];
		const parity = p && p.textures.length > 1 ? ( h.previous ? 1 - this.parityOf( h ) : this.parityOf( h ) ) : 0;
		const rt = p?.owners[ parity ];
		if ( ! rt ) throw new GraphError( `'${ h.name }' has no render target yet (compile the graph, or make one with renderTarget())` );
		return rt;

	}

	private samplesOfDecl( r: ResourceDecl ): number {

		const s = r.desc.samples ?? 1;
		return s === 'scene' ? this.options.sceneSamples : s;

	}

	// ---- passes

	/** Declares a pass (in execution order); `setup` declares its reads and writes and returns
	 * its flags and executor. */
	addPass( name: string, kind: PassKind, setup: ( b: PassBuilder ) => PassDef<F> ): PassDef<F> {

		this.mutable( name );
		const def = this.decl.addPass( name, kind, setup );
		const ok = kind === 'scene' ? def.scene && def.camera : kind === 'quad' ? def.quad : kind === 'chain' ? def.pipeline
			: kind === 'compute' ? def.compute : def.run;
		if ( ! ok && ! def.run ) throw new GraphError( `pass '${ name }' (${ kind }) has no executor` );
		this.defs.push( def );
		return def;

	}

	private mutable( what: string ): void {

		if ( this.compiled ) throw new GraphError( `'${ what }': the graph is compiled (declare everything before compile())` );

	}

	/** Validates, culls and derives the ops; makes the render targets. Once. */
	compile(): CompiledGraph {

		if ( this.compiled ) return this.compiled;
		const compiled = compileGraph( this.decl, { sceneSamples: this.options.sceneSamples, legacyDiscard: this.options.legacyDiscard } );
		// (a target made ahead by renderTarget() holds the same attachments, size class and samples)
		for ( const t of compiled.targets ) if ( ! t.canvas && ! this.targets.has( t.key ) ) this.targets.set( t.key, this.makeTargets( t ) );
		// a resource no live pass draws into still gets a render target of its own (a copy's
		// destination, a texture written by storage): its textures need one to be allocated
		// (a depth resource no live pass draws into needs none: nothing copies into depth)
		this.decl.resources.forEach( ( r, id ) => {

			const p = this.physical[ id ];
			if ( p.imported || r.kind === 'depth' ) return;
			p.textures.forEach( ( texture, parity ) => {

				if ( p.owners[ parity ] ) return;
				const solo = this.makeTarget( [ texture ], null, compiled.samplesOf( r ) );
				p.owners[ parity ] = solo;
				this.targets.set( `${ r.name }#solo${ parity }`, [ solo ] );
				this.targetSizes.set( solo, r.desc.size );
				this.soloTargets.add( solo );
				this.needsInit = true;

			} );

		} );
		this.compiled = compiled;
		this.applyExtents();
		return compiled;

	}

	private makeTarget( colors: THREE.Texture[], depth: THREE.DepthTexture | null, samples: number ): THREE.RenderTarget {

		const rt = new THREE.RenderTarget( 1, 1, { count: Math.max( colors.length, 1 ), samples: samples > 1 ? samples : 0, depthBuffer: depth !== null } );
		colors.forEach( ( texture, i ) => {

			rt.textures[ i ] = texture;
			if ( ! texture.renderTarget ) ( texture as { renderTarget: THREE.RenderTarget | null } ).renderTarget = rt;

		} );
		if ( depth ) rt.depthTexture = depth;
		return rt;

	}

	private makeTargets( t: TargetInfo ): THREE.RenderTarget[] {

		const parities = t.pingPong ? [ 0, 1 ] : [ 0 ];
		return parities.map( ( parity ) => {

			const colors = t.colors.map( ( id ) => {

				const p = this.physical[ id ];
				return p.textures[ p.textures.length > 1 ? parity : 0 ];

			} );
			const depth = t.depth === null ? null : this.physical[ t.depth ].textures[ 0 ] as THREE.DepthTexture;
			const imported = t.colors.length === 1 && this.physical[ t.colors[ 0 ] ].imported ? this.physical[ t.colors[ 0 ] ].owners[ 0 ] : null;
			const rt = imported ?? this.makeTarget( colors, depth, t.samples );
			if ( ! imported ) this.targetSizes.set( rt, t.size );
			for ( const id of t.depth === null ? t.colors : [ ...t.colors, t.depth ] ) {

				const p = this.physical[ id ];
				const slot = p.textures.length > 1 ? parity : 0;
				p.owners[ slot ] ??= rt;

			}
			return rt;

		} );

	}

	/** The render and canvas sizes (the canvas is never smaller than the render). */
	setExtents( extents: Extents ): void {

		this.extents = {
			render: { width: Math.max( extents.render.width, 1 ), height: Math.max( extents.render.height, 1 ) },
			canvas: { width: Math.max( extents.canvas.width, extents.render.width, 1 ), height: Math.max( extents.canvas.height, extents.render.height, 1 ) },
		};
		this.extentsSet = true;
		this.applyExtents();

	}

	// a target to its class's size at the current extents; true when it changed
	private sizeTarget( rt: THREE.RenderTarget, size: SizeClass ): boolean {

		const s = resolveSize( size, this.extents );
		const width = Math.max( s.width, 1 ), height = Math.max( s.height, 1 );
		if ( rt.width === width && rt.height === height ) return false;
		rt.setSize( width, height );
		return true;

	}

	private applyExtents(): void {

		for ( const { size, node } of this.extentNodes.values() ) {

			const s = resolveSize( size, this.extents );
			node.value.set( s.width, s.height );

		}
		if ( this.extentsSet ) for ( const entry of this.resizeHooks ) this.runHook( entry );
		for ( const [ rt, size ] of this.targetSizes ) if ( this.sizeTarget( rt, size ) ) this.needsInit = true;
		// the depth textures' own size (three sets it only through the target that owns one) and the
		// histories a resize emptied
		this.decl.resources.forEach( ( r, id ) => {

			const p = this.physical[ id ];
			if ( p.imported ) return;
			const s = resolveSize( r.desc.size, this.extents );
			const width = Math.max( s.width, 1 ), height = Math.max( s.height, 1 );
			for ( const texture of p.textures ) {

				const image = texture.image as { width: number; height: number };
				if ( r.kind === 'depth' && ( image.width !== width || image.height !== height ) ) {

					image.width = width;
					image.height = height;
					texture.needsUpdate = true;
					this.needsInit = true;

				}

			}
			if ( ( r.persistent || r.pingPong ) && p.size && ( p.size.width !== width || p.size.height !== height ) ) p.valid = false;
			p.size = { width, height };

		} );

	}

	// After a resize: the targets that share a texture with another, and those no pass draws into,
	// have their textures (re)created now, in declaration order, before any pass of the frame
	// draws (see the note at the top). The others initialise themselves on their next draw.
	private initTargets(): void {

		if ( ! this.needsInit ) return;
		this.needsInit = false;
		const attachments = ( rt: THREE.RenderTarget ) => rt.depthTexture ? [ ...rt.textures, rt.depthTexture ] : rt.textures;
		const holders = new Map<THREE.Texture, number>();
		for ( const rt of this.targetSizes.keys() ) for ( const texture of attachments( rt ) ) holders.set( texture, ( holders.get( texture ) ?? 0 ) + 1 );
		for ( const rts of this.targets.values() ) for ( const rt of rts ) {

			if ( ! this.targetSizes.has( rt ) ) continue; // imported
			if ( this.soloTargets.has( rt ) || attachments( rt ).some( ( texture ) => holders.get( texture )! > 1 ) ) this.renderer.initRenderTarget( rt );

		}

	}

	/** Dev check: every render target the graph made (and its depth texture) has its class's size
	 * at the current extents, so nothing resized one behind the graph's back. Counted in
	 * `sizeErrors`, with the first few reported. */
	validateSizes(): number {

		let errors = 0;
		for ( const [ rt, size ] of this.targetSizes ) {

			const s = resolveSize( size, this.extents );
			const width = Math.max( s.width, 1 ), height = Math.max( s.height, 1 );
			const depth = rt.depthTexture?.image as { width: number; height: number } | undefined;
			if ( rt.width === width && rt.height === height && ( ! depth || ( depth.width === width && depth.height === height ) ) ) continue;
			errors ++;
			if ( this.sizeErrors ++ < 8 ) console.error( `FrameGraph: the target of '${ rt.textures.map( ( t ) => t.name ).join( '+' ) }' is ${ rt.width }x${ rt.height }${ depth ? ` (depth ${ depth.width }x${ depth.height })` : '' }, its class ${ sizeClassKey( size ) } is ${ width }x${ height }` );

		}
		return errors;

	}

	/** The render target a pass draws into this frame (null: the canvas, or no attachment). */
	targetOf( index: number ): THREE.RenderTarget | null {

		const t = this.compiled?.targetOf[ index ];
		if ( ! t || t.canvas ) return null;
		const rts = this.targets.get( t.key )!;
		if ( rts.length === 1 ) return rts[ 0 ];
		// a ping-pong target: the parity of its ping-pong colours (written together, so equal)
		const id = t.colors.find( ( c ) => this.decl.resources[ c ].pingPong )!;
		return rts[ this.parityOf( { resource: id, version: 0, name: this.decl.resources[ id ].name } ) ];

	}

	// ---- execution

	/** Binds a pass's target, MRT, depth flags and clears; `unbind` restores the renderer. The
	 * warm-up uses the same binding. */
	bind( index: number, table: OpsTable | null = null ): void {

		const r = this.renderer;
		const decl = this.decl.passes[ index ];
		const def = this.defs[ index ];
		this.saved ??= {
			target: r.getRenderTarget(), mrt: r.getMRT(), depth: r.depth, stencil: r.stencil,
			autoClear: r.autoClear, autoClearColor: r.autoClearColor, autoClearDepth: r.autoClearDepth, autoClearStencil: r.autoClearStencil,
		};
		const t = this.compiled?.targetOf[ index ] ?? null;
		if ( ! t ) {

			// compute and callback passes without attachments keep the renderer's target
			r.setMRT( def.mrt ?? null );
			return;

		}
		const rt = this.targetOf( index );
		r.setRenderTarget( rt );
		r.setMRT( def.mrt ?? null );
		if ( rt ) {

			r.depth = rt.depthBuffer;
			r.stencil = rt.stencilBuffer;

		}
		// clear or load, as the compiled ops say (the same in both tables; a pass's colour writes
		// all clear or all load, as the compiler checks)
		const ops = table?.passes.find( ( p ) => p.index === index ) ?? null;
		const colourClear = ops ? ops.colors.some( ( c ) => c.load === 'clear' ) : decl.writes.some( ( w ) => drawsOver( decl, w ) );
		// A pass without a depth resource clears whatever depth its target holds that the graph
		// does not own: the canvas's depth buffer, and the depth of the targets a chain's own rtt()
		// passes draw into (they inherit the renderer's flags), as three's defaults do; with the flag
		// off each of those passes loaded a depth nothing reads. A graph target with depth always
		// holds a depth resource, which a pass that does not declare it keeps (loads).
		const foreignDepth = ! decl.depth && ! rt?.depthBuffer;
		const depthClear = ops?.depth ? ops.depth.load === 'clear' : decl.depth?.clear === true || foreignDepth;
		r.autoClear = colourClear || depthClear;
		r.autoClearColor = colourClear;
		r.autoClearDepth = depthClear;
		r.autoClearStencil = depthClear;

	}

	unbind(): void {

		const s = this.saved;
		if ( ! s ) return;
		const r = this.renderer;
		r.setRenderTarget( s.target );
		r.setMRT( s.mrt );
		r.depth = s.depth;
		r.stencil = s.stencil;
		r.autoClear = s.autoClear;
		r.autoClearColor = s.autoClearColor;
		r.autoClearDepth = s.autoClearDepth;
		r.autoClearStencil = s.autoClearStencil;
		this.saved = null;

	}

	/** The enabled mask: each conditional pass's `when`, evaluated once at the frame's start. */
	maskFor( f: F ): number {

		const compiled = this.compiled!;
		let mask = 0;
		compiled.conditional.forEach( ( index, bit ) => {

			if ( ( this.defs[ index ].when as ( f: F ) => boolean )( f ) ) mask |= 1 << bit;

		} );
		return mask;

	}

	/** Runs the frame: the passes the mask enables, in order, then the frame-end copies and swaps. */
	execute( f: F ): void {

		const compiled = this.compiled ?? this.compile();
		if ( this.executing ) throw new GraphError( 'execute() re-entered' );
		this.executing = true;
		const mask = this.maskFor( f );
		const ops = this.attachmentOps;
		const table = ops.mode === 'off' ? null : compiled.ops( ops.mode, mask );
		this.opsExpected = table ? table.rewrites : 0;
		const running = compiled.running( mask );
		const span = running.filter( ( i ) => this.decl.passes[ i ].jittered );
		const written = new Set<number>();
		for ( const i of running ) for ( const w of this.decl.passes[ i ].writes ) written.add( w.resource );
		const first = span[ 0 ], last = span[ span.length - 1 ];
		if ( this.options.dev ) this.validateSizes();
		this.initTargets();
		this.frameWritten = written;
		ops.begin( table );
		try {

			for ( const index of running ) {

				if ( index === first ) this.hooks.jitterBegin?.( f );
				this.runPass( index, f, table );
				if ( index === last ) this.hooks.jitterEnd?.( f );

			}

		} catch ( error ) {

			this.frameWritten = null;
			throw error;

		} finally {

			this.opsApplied = ops.applied;
			// dev: every rewrite the table expects reached WebGPU (AttachmentOps must be installed
			// after any wrapper of the device's createCommandEncoder that does not call through,
			// such as a command recorder; see AttachmentOps.ts)
			if ( this.options.dev && ops.installed && table && ops.applied !== table.rewrites ) {

				if ( this.opsMismatchFrames ++ < 8 ) console.warn( `FrameGraph: ${ ops.applied } descriptors rewritten, the ops table expects ${ table.rewrites }${ ops.overwrapped ? ' (createCommandEncoder was wrapped after AttachmentOps)' : '' }` );

			}
			ops.end();
			this.currentPass = null;
			this.unbind();
			this.executing = false;

		}
		this.endFrame( written );

	}

	private runPass( index: number, f: F, table: OpsTable | null ): void {

		const decl = this.decl.passes[ index ];
		const def = this.defs[ index ];
		const target = this.compiled!.targetOf[ index ];
		const size = decl.size ?? target?.size ?? null;
		const current: CurrentPass = { name: decl.name, label: decl.label, size, scales: sizeScales( size ) };
		this.currentPass = current;
		this.bind( index, table );
		const rt = target ? this.targetOf( index ) : undefined;
		if ( this.options.dev && target ) this.checkSize( current, rt ?? null, target.size );
		this.attachmentOps.enterPass( target ? rt ?? null : undefined, table?.passes.find( ( p ) => p.index === index ) ?? null );
		this.hooks.onPassBegin?.( current, f );
		try {

			this.executePass( decl.kind, def, f );

		} finally {

			this.hooks.onPassEnd?.( current, f );
			this.attachmentOps.leavePass();
			this.unbind();
			this.currentPass = null;

		}

	}

	private executePass( kind: PassKind, def: PassDef<F>, f: F ): void {

		const r = this.renderer;
		if ( def.run ) {

			def.run( f, this );
			return;

		}
		switch ( kind ) {

			case 'scene': {

				def.before?.( f );
				const scene = typeof def.scene === 'function' ? def.scene( f ) : def.scene!;
				const camera = typeof def.camera === 'function' ? ( def.camera as ( f: F ) => THREE.Camera )( f ) : def.camera!;
				r.render( scene, camera );
				break;

			}
			case 'quad': def.quad!.render( r ); break;
			case 'chain': def.pipeline!.render(); break;
			case 'compute': {

				const nodes = typeof def.compute === 'function' ? def.compute( f ) : def.compute!;
				if ( nodes ) r.compute( nodes );
				break;

			}
			default: throw new GraphError( `callback pass without run()` );

		}

	}

	// dev: the target a pass draws into must have its class's size
	private checkSize( pass: CurrentPass, rt: THREE.RenderTarget | null, size: SizeClass ): void {

		const want = resolveSize( size, this.extents );
		let width: number, height: number;
		if ( rt ) {

			width = rt.width;
			height = rt.height;

		} else {

			this.renderer.getDrawingBufferSize( this.drawingBuffer );
			width = this.drawingBuffer.x;
			height = this.drawingBuffer.y;

		}
		if ( width !== Math.max( want.width, 1 ) || height !== Math.max( want.height, 1 ) ) {

			if ( this.sizeErrors ++ < 8 ) console.error( `FrameGraph: '${ pass.name }' draws into ${ width }x${ height }, its class ${ sizeClassKey( size ) } is ${ want.width }x${ want.height }` );

		}

	}

	// the persistent copies, then the ping-pong swaps: only a history some pass wrote this frame
	// swaps (and becomes valid); one whose writer was skipped keeps its parity, so `previous` still
	// reads the newest history and the next write does not overwrite it
	private endFrame( written: Set<number> ): void {

		const r = this.renderer;
		try {

			for ( const { src, dst } of this.decl.copies ) {

				r.copyTextureToTexture( this.texture( src ), this.texture( dst ) );
				this.physical[ dst.resource ].valid = true;

			}

		} finally {

			this.decl.resources.forEach( ( res, id ) => {

				if ( ! res.pingPong || ! written.has( id ) ) return;
				const p = this.physical[ id ];
				p.newest = p.newest === 0 ? 1 : 0;
				p.valid = true;

			} );
			this.frameWritten = null;

		}

	}

	/** The ops table of a mask (introspection and the verifier). */
	opsTable( mask: number ): OpsTable | null {

		const mode = this.attachmentOps.mode;
		return this.compiled && mode !== 'off' ? this.compiled.ops( mode, mask ) : null;

	}

	/** Compiles every pass's pipelines ahead of its first frame. Not yet (M4: fg-warm). */
	warm(): Promise<void> {

		throw new GraphError( 'FrameGraph.warm: not yet' );

	}

	/** A description of the graph for diagnostics. Not yet (M4). */
	describe(): object {

		throw new GraphError( 'FrameGraph.describe: not yet' );

	}

	/** The graph in Graphviz's dot language. Not yet (M4). */
	dot(): string {

		throw new GraphError( 'FrameGraph.dot: not yet' );

	}

}
