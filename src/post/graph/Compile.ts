import * as THREE from 'three/webgpu';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';

// Ahead-of-time pipeline compiles (the frame graph's warm-up, FrameGraph.warm, the sky's and the
// shadow maps', `compileLatentInto`, and the sun map's first redraw, `compileByRendering`):
// every draw the frame will make, built and handed to WebGPU's async pipeline creation before the
// frame that first shows it, so no frame stalls on a pipeline (a weather change, the first bolt, a
// storm's spray, fog setting in, the upscale switching on).
//
// three r186's `renderer.compileAsync` does not compile what a render later draws:
// - it collects its draws synchronously but builds their node states and pipeline keys one await
//   at a time, from whatever the renderer holds by then: the render target (its depth buffer, its
//   formats, its texture names, which pick an MRT's outputs), the MRT, a double-sided draw's side
//   (restored to DoubleSide before the builds: its two passes compiled as one pipeline no draw
//   uses) and, for the canvas, the output colour space that keys its pipeline. A build made under
//   the wrong state is cached under the right key and served to the real draw (an MRT draw would
//   find a shader without its velocity output);
// - it collects in the top-level render context, while a pass rendered inside another (an rtt()
//   or bloom pass inside a chain) draws in its call depth's context, whose id is part of the
//   material's node key;
// - it compiles a QuadMesh without the vertex node QuadMesh.render sets for the draw.
// Each miss builds the material again in its first frame, and a second build of a material under
// another key may emit a layout function with the first build's uniform names (r186): an invalid
// shader. `compileBound` builds every draw while the binding is in place, inside the collection
// (standing in for three's `_createObjectPipeline` for that call), at the call depth and with the
// quad's vertex node of the real draw, and leaves only the pipelines' creation asynchronous. Its
// result names the nodes that render passes of their own before the draw (`updateBeforeNodes`:
// a bloom), which `compileQuad` compiles in turn; `compileNodes` compiles those a frame-graph pass
// runs itself. Without those internals (another three
// revision) it falls back to `compileAsync`, and the frame graph primes the chains instead.

type NodeState = { updateBeforeNodes: THREE.Node[] };
type RenderObject = { drawRange: unknown; group: unknown };
type RenderContext = { textures: unknown; depthTexture: unknown; depth: boolean; stencil: boolean };
type Internals = {
	_objects?: { get( ...args: unknown[] ): RenderObject };
	_nodes?: { getForRender( renderObject: RenderObject ): NodeState; updateForRender( renderObject: RenderObject ): void };
	_geometries?: { updateForRender( renderObject: RenderObject ): void };
	_bindings?: { updateForRender( renderObject: RenderObject ): void };
	_pipelines?: { getForRender( renderObject: RenderObject, promises: Promise<unknown>[] | null ): unknown };
	_currentRenderContext?: RenderContext;
	_renderContexts?: { get( target: THREE.RenderTarget | null, mrt: THREE.MRTNode | null, callDepth: number ): RenderContext };
	_isPreCompiling?: boolean;
	_createObjectPipeline?: ( ...args: unknown[] ) => void;
	_compilationPromises?: unknown;
};
type CreateObjectPipeline = ( this: Internals, object: THREE.Object3D, material: THREE.Material, scene: THREE.Scene, camera: THREE.Camera,
	lightsNode: unknown, group: unknown, clippingContext: unknown, passId: unknown ) => void;

/** Whether the renderer has the internals `compileBound` builds through (three r186). */
export function boundCompileAvailable( renderer: THREE.WebGPURenderer ): boolean {

	const r = renderer as unknown as Internals;
	return typeof r._createObjectPipeline === 'function' && typeof r._objects?.get === 'function' && typeof r._nodes?.getForRender === 'function'
		&& typeof r._nodes.updateForRender === 'function' && typeof r._geometries?.updateForRender === 'function'
		&& typeof r._bindings?.updateForRender === 'function' && typeof r._pipelines?.getForRender === 'function' && '_compilationPromises' in r
		&& typeof r._renderContexts?.get === 'function';

}

// QuadMesh.render draws with a vertex node of its own (a clip-space triangle, no camera), set on
// the material only for the draw; it is part of the material's cache key and code, so a compile
// sets it too. The node is private to three's module: a stand-in renderer catches it.
let quadVertex: THREE.Node | null | undefined;
function quadVertexNode( quad: THREE.QuadMesh ): THREE.Node | null {

	if ( quadVertex === undefined ) {

		const material = quad.material as THREE.NodeMaterial;
		quadVertex = null;
		quad.render( { render: () => { quadVertex = material.vertexNode ?? null; } } as unknown as THREE.WebGPURenderer );

	}
	return quadVertex;

}

/** What a compile built: the node states of its draws (null on the fallback, which builds them
 * later), and a promise that resolves once their pipelines exist. */
export interface Compiled { states: NodeState[] | null; done: Promise<void> }

/** Compiles the draws of `object` (a scene, or an object to be drawn as part of `scene`) for
 * `camera` with the renderer's binding as it is now (render target, MRT, depth flags, tone mapping
 * and colour space): node states and pipeline keys are made before this returns, the pipelines
 * asynchronously. `callDepth` is how deep in nested renders the draw comes (0: a top-level render;
 * 1: a pass a top-level material renders before itself). As `compileAsync`, it draws only what is
 * visible and in the camera's view, and calls the scene's and the objects' `onBeforeRender`. */
export function compileBound( renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene | null = null, callDepth = 0 ): Compiled {

	// a full-screen quad compiles with the vertex node its render() sets
	const quad = ( object as THREE.QuadMesh ).isQuadMesh === true ? ( object as THREE.QuadMesh ).material as THREE.NodeMaterial : null;
	const vertexNode = quad ? quad.vertexNode : null;
	if ( quad ) quad.vertexNode = quadVertexNode( object as THREE.QuadMesh );
	try {

		return compileNow( renderer, object, camera, scene, callDepth );

	} finally {

		if ( quad ) quad.vertexNode = vertexNode;

	}

}

function compileNow( renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera, scene: THREE.Scene | null, callDepth: number ): Compiled {

	if ( ! boundCompileAvailable( renderer ) ) return { states: null, done: renderer.compileAsync( object, camera, scene ) as Promise<void> };
	const r = renderer as unknown as Required<Internals>;
	const states: NodeState[] = [];
	const pending: Promise<unknown>[] = [];
	const own = Object.prototype.hasOwnProperty.call( r, '_createObjectPipeline' ) ? r._createObjectPipeline : null;
	// A pass rendered inside another (`callDepth` > 0) draws in its call depth's render context, filled
	// as a render fills it; compileAsync collects in the top level's.
	let nested: RenderContext | null = null;
	// three's own steps for a draw being compiled (its compileAsync loop's and _createObjectPipeline's),
	// in this call instead of after an await; without updateBefore, which would render the rtt() and
	// bloom passes a material holds (compileQuad compiles those)
	const build: CreateObjectPipeline = function ( object, material, scene, camera, lightsNode, group, clippingContext, passId ) {

		// (compileAsync's own context, filled for this collection)
		let context = r._currentRenderContext;
		if ( callDepth > 0 ) {

			if ( ! nested ) {

				nested = r._renderContexts.get( renderer.getRenderTarget(), renderer.getMRT(), callDepth );
				nested.textures = context.textures;
				nested.depthTexture = context.depthTexture;
				nested.depth = context.depth;
				nested.stencil = context.stencil;

			}
			context = nested;

		}
		const ro = r._objects.get( object, material, scene, camera, lightsNode, context, clippingContext, passId );
		ro.drawRange = ( object as THREE.Mesh ).geometry.drawRange;
		ro.group = group;
		r._isPreCompiling = true;
		try {

			states.push( r._nodes.getForRender( ro ) );
			r._geometries.updateForRender( ro );
			r._nodes.updateForRender( ro );
			r._bindings.updateForRender( ro );

		} finally {

			r._isPreCompiling = false;

		}
		r._pipelines.getForRender( ro, pending );

	};
	r._createObjectPipeline = build as unknown as ( ...args: unknown[] ) => void;
	let collected: Promise<void>;
	try {

		// collects synchronously (its own queue stays empty: `build` did the work)
		collected = renderer.compileAsync( object, camera, scene ) as Promise<void>;

	} finally {

		if ( own ) r._createObjectPipeline = own;
		else delete ( r as Internals )._createObjectPipeline;

	}
	return { states, done: Promise.all( [ collected, ...pending ] ).then( () => undefined ) };

}

/** Compiles `object` as `scene` would draw it for `camera` into `target` (null: the canvas) with
 * `mrt`, leaving the renderer's binding as it was. Draws into a render target take its own depth
 * and stencil flags, as a render does (compileAsync would take the renderer's). */
export function compileInto( renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera,
	target: THREE.RenderTarget | null, scene: THREE.Scene | null = null, mrt: THREE.MRTNode | null = null ): Promise<void> {

	return compileTargeted( renderer, object, camera, target, scene, mrt ).done;

}

function compileTargeted( renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera,
	target: THREE.RenderTarget | null, scene: THREE.Scene | null, mrt: THREE.MRTNode | null, callDepth = 0 ): Compiled {

	return withBinding( renderer, target, mrt, () => compileBound( renderer, object, camera, scene, callDepth ) );

}

// Runs `compile` with the renderer bound to `target` and `mrt`, the depth and stencil flags the
// target's own, and restores the binding before it returns.
function withBinding<T>( renderer: THREE.WebGPURenderer, target: THREE.RenderTarget | null, mrt: THREE.MRTNode | null, compile: () => T ): T {

	const previous = renderer.getRenderTarget(), previousMrt = renderer.getMRT();
	const { depth, stencil } = renderer;
	renderer.setRenderTarget( target );
	renderer.setMRT( mrt );
	if ( target ) {

		renderer.depth = target.depthBuffer;
		renderer.stencil = target.stencilBuffer;

	}
	try {

		return compile();

	} finally {

		renderer.setRenderTarget( previous );
		renderer.setMRT( previousMrt );
		renderer.depth = depth;
		renderer.stencil = stencil;

	}

}

// One copy of a double-sided mesh's material per side, kept for the page's life: disposing one
// would release the node builds and pipelines the real draws share with it.
const sideCopies = new WeakMap<THREE.Mesh, THREE.Mesh[]>();

// A transparent double-sided mesh draws in two passes (back faces, then front faces), each with
// its own pipeline; compileAsync would build both after restoring the side. Compiled as a copy
// per side instead, its draws find their node builds and pipelines by key (the copies generate the
// same code and keys). Not for instanced meshes: their node key names the mesh itself.
function perSide( mesh: THREE.Mesh ): THREE.Mesh[] | null {

	const material = mesh.material as THREE.Material;
	if ( Array.isArray( mesh.material ) || ! material.transparent || material.side !== THREE.DoubleSide || material.forceSinglePass ) return null;
	if ( ( ( mesh as THREE.InstancedMesh ).count ?? 1 ) > 1 ) return null;
	let copies = sideCopies.get( mesh );
	if ( ! copies ) sideCopies.set( mesh, copies = [ THREE.BackSide, THREE.FrontSide ].map( ( side ) => {

		const copy = material.clone();
		copy.side = side as THREE.Side;
		const m = new THREE.Mesh( mesh.geometry, copy );
		// never drawn: placed by hand, never culled
		m.matrixAutoUpdate = false;
		m.frustumCulled = false;
		return m;

	} ) );
	for ( const copy of copies ) {

		// (a mirrored transform takes another pipeline: the copies keep the mesh's)
		copy.matrix.copy( mesh.matrixWorld );
		copy.matrixWorld.copy( mesh.matrixWorld );
		copy.castShadow = mesh.castShadow;
		copy.receiveShadow = mesh.receiveShadow;
		copy.renderOrder = mesh.renderOrder;

	}
	return copies;

}

/** The scene an object is part of (its root), if it is in one. */
export function sceneOf( object: THREE.Object3D ): THREE.Scene | null {

	let o: THREE.Object3D | null = object;
	while ( o.parent ) o = o.parent;
	return ( o as THREE.Scene ).isScene === true ? o as THREE.Scene : null;

}

/** Compiles the draws of `objects` as `scene` draws them for `camera` with the renderer's binding
 * as it is now, whether they are shown now or not (visibility and culling are forced for the
 * collection and restored before this returns). A transparent double-sided mesh compiles one copy
 * of its material per side. */
export function compileLatent( renderer: THREE.WebGPURenderer, objects: readonly THREE.Object3D[], scene: THREE.Scene, camera: THREE.Camera ): Compiled {

	const saved: [ THREE.Object3D, boolean, boolean ][] = [];
	const roots: THREE.Object3D[] = [];
	for ( const root of objects ) root.traverse( ( object ) => {

		saved.push( [ object, object.visible, object.frustumCulled ] );
		object.visible = true;
		object.frustumCulled = false;

	} );
	const states: NodeState[] = [];
	const pending: Promise<void>[] = [];
	try {

		for ( const root of objects ) {

			root.updateMatrixWorld( true );
			// the double-sided meshes go as their copies, the rest as they are
			const copies: THREE.Mesh[] = [];
			root.traverse( ( object ) => {

				const sides = ( object as THREE.Mesh ).isMesh ? perSide( object as THREE.Mesh ) : null;
				if ( ! sides ) return;
				copies.push( ...sides );
				object.visible = false;

			} );
			roots.push( root, ...copies );

		}
		for ( const object of roots ) {

			const c = compileBound( renderer, object, camera, scene );
			if ( c.states ) states.push( ...c.states );
			pending.push( c.done );

		}

	} finally {

		for ( const [ object, visible, culled ] of saved ) {

			object.visible = visible;
			object.frustumCulled = culled;

		}

	}
	return { states: boundCompileAvailable( renderer ) ? states : null, done: Promise.all( pending ).then( () => undefined ) };

}

/** `compileLatent` into a target outside the frame graph (null: the canvas), with no MRT: draws a
 * renderer makes of its own, such as a shadow map's (`SunShadow.compileCasters`,
 * `CharacterShadow.compile`). A draw in a frame-graph pass registers as a latent of that pass
 * instead (`FrameGraph.latent`), which binds the pass's target and MRT. Resolves once the
 * pipelines exist. */
export function compileLatentInto( renderer: THREE.WebGPURenderer, objects: readonly THREE.Object3D[], scene: THREE.Scene, camera: THREE.Camera,
	target: THREE.RenderTarget | null ): Promise<void> {

	return withBinding( renderer, target, null, () => compileLatent( renderer, objects, scene, camera ) ).done;

}

/** Runs `render`, a render the renderer makes of its own (a shadow map's redraw), with the
 * pipelines its draws need created asynchronously, as `compileAsync` creates them: a draw whose
 * pipeline is not ready draws nothing. Its node builds are the render's own, made by its own path
 * and in its order, which a compile of the same draws ahead cannot match: three r186 emits a shader
 * from shared node state, so the order in which materials first build can change the code of
 * later builds (a temporary inlined or kept), and with it a few pixels of the image. Resolves once
 * the pipelines exist: then the render, made again, draws. Stands in for three's
 * `Pipelines.updateForRender` (r186) for the call. */
export function compileByRendering( renderer: THREE.WebGPURenderer, render: () => void ): Promise<void> {

	const pipelines = ( renderer as unknown as { _pipelines?: PipelineCache } )._pipelines;
	if ( typeof pipelines?.getForRender !== 'function' || typeof pipelines.updateForRender !== 'function' ) {

		render();
		return Promise.resolve();

	}
	const promises: Promise<unknown>[] = [];
	const own = Object.prototype.hasOwnProperty.call( pipelines, 'updateForRender' ) ? pipelines.updateForRender : null;
	pipelines.updateForRender = ( renderObject ) => void pipelines.getForRender( renderObject, promises );
	try {

		render();

	} finally {

		if ( own ) pipelines.updateForRender = own;
		else delete ( pipelines as Partial<PipelineCache> ).updateForRender;

	}
	return Promise.all( promises ).then( () => undefined );

}
type PipelineCache = { getForRender( renderObject: RenderObject, promises: Promise<unknown>[] | null ): unknown; updateForRender( renderObject: RenderObject ): void };

// ---- chains: the passes a full-screen material renders before itself

/** What compiling a chain found: the pipelines' promise, and the passes it could not reach
 * (nodes that render in `updateBefore` which the walker does not know, or a fallback build that
 * named none): the frame graph primes the chain instead. */
export interface ChainCompile { done: Promise<void>; unreached: string[] }

// BloomNode draws its passes with a QuadMesh of its own module: the same geometry and camera as
// any QuadMesh, so a quad of ours finds the same node builds and pipelines by key.
const bloomQuad = new THREE.QuadMesh( new THREE.NodeMaterial() );

type Bloom = BloomNode & {
	_highPassFilterMaterial: THREE.NodeMaterial | null; _separableBlurMaterials: THREE.NodeMaterial[]; _compositeMaterial: THREE.NodeMaterial | null;
	_renderTargetBright: THREE.RenderTarget; _renderTargetsHorizontal: THREE.RenderTarget[]; _renderTargetsVertical: THREE.RenderTarget[]; _nMips: number;
};

// The walker: compiles the passes three's display nodes render in a chain (`updateBefore`: a
// BloomNode's high pass, blurs and composite) as they draw them, at the call depth they draw at,
// and the passes those draws render in turn (depth first, in each material's order, as the frame
// renders them: a pass renders inside the first material that names it, one level deeper). The frame graph runs every
// other pass of the frame itself (an rtt() pass is a quad pass of the graph's), so any other node
// that renders inside a pass is listed in `unreached`, for the graph to prime.
class Walker {

	readonly pending: Promise<void>[] = [];
	readonly unreached: string[] = [];
	private readonly seen = new Set<THREE.Node>();
	private readonly renderer: THREE.WebGPURenderer;

	constructor( renderer: THREE.WebGPURenderer ) {

		this.renderer = renderer;

	}

	nodes( nodes: Iterable<THREE.Node>, depth: number ): void {

		for ( const node of nodes ) {

			if ( this.seen.has( node ) ) continue;
			this.seen.add( node );
			if ( node instanceof BloomNode ) this.bloom( node as Bloom, depth );
			else this.unreached.push( node.type );

		}

	}

	states( states: NodeState[] | null, depth: number ): void {

		for ( const state of states ?? [] ) this.nodes( state.updateBeforeNodes, depth );

	}

	private draw( quad: THREE.QuadMesh, target: THREE.RenderTarget, depth: number ): void {

		const c = compileTargeted( this.renderer, quad, ( quad as unknown as { camera: THREE.Camera } ).camera, target, null, null, depth );
		this.pending.push( c.done );
		this.states( c.states, depth + 1 );

	}

	// as updateBefore draws them: the high pass, each mip's two blur passes (their input set as it
	// sets it), the composite; only the first mips' blur materials are drawn (setup appends a set per
	// build of the material that holds the bloom)
	private bloom( bloom: Bloom, depth: number ): void {

		const draws: [ THREE.NodeMaterial | null, THREE.RenderTarget, THREE.Texture | null ][] = [ [ bloom._highPassFilterMaterial, bloom._renderTargetBright, null ] ];
		let input = bloom._renderTargetBright;
		for ( let i = 0; i < bloom._nMips; i ++ ) {

			const material = bloom._separableBlurMaterials[ i ] ?? null;
			draws.push( [ material, bloom._renderTargetsHorizontal[ i ], input.texture ], [ material, bloom._renderTargetsVertical[ i ], bloom._renderTargetsHorizontal[ i ].texture ] );
			input = bloom._renderTargetsVertical[ i ];

		}
		draws.push( [ bloom._compositeMaterial, bloom._renderTargetsHorizontal[ 0 ], null ] );
		for ( const [ material, target, colour ] of draws ) {

			if ( ! material ) {

				this.unreached.push( `${ bloom.type } (not set up)` );
				continue;

			}
			const blur = material as THREE.NodeMaterial & { colorTexture?: THREE.TextureNode };
			if ( colour && blur.colorTexture ) blur.colorTexture.value = colour;
			bloomQuad.material = material;
			this.draw( bloomQuad, target, depth );

		}

	}

	get result(): ChainCompile {

		return { done: Promise.all( this.pending ).then( () => undefined ), unreached: this.unreached };

	}

}

/** Compiles a full-screen `quad` with the renderer's binding as it is now, then the passes its
 * material renders before it (a bloom: its high-pass, blur and composite materials into their
 * targets), and theirs in turn. Each nested pass compiles with the state its updateBefore draws
 * with (its target and its depth flags, no MRT). */
export function compileQuad( renderer: THREE.WebGPURenderer, quad: THREE.QuadMesh ): ChainCompile {

	const first = compileBound( renderer, quad, ( quad as unknown as { camera: THREE.Camera } ).camera );
	if ( ! first.states ) return { done: first.done, unreached: [ 'nested passes (no bound compile on this three)' ] };
	const walker = new Walker( renderer );
	walker.pending.push( first.done );
	walker.states( first.states, 1 );
	return walker.result;

}

/** Compiles the passes of nodes a frame-graph pass runs itself (their `updateBefore`, at the top
 * level: a bloom's high pass, blurs and composite into their targets), and the passes those draws
 * render in turn. */
export function compileNodes( renderer: THREE.WebGPURenderer, nodes: readonly THREE.Node[] ): ChainCompile {

	if ( ! boundCompileAvailable( renderer ) ) return { done: Promise.resolve(), unreached: nodes.map( ( node ) => `${ node.type } (no bound compile on this three)` ) };
	const walker = new Walker( renderer );
	walker.nodes( nodes, 0 );
	return walker.result;

}

/** Compiles a render pipeline's full-screen pass (and the passes it renders before it) with the
 * renderer's binding as it is now, under the state its `render()` sets: no tone mapping and the
 * working colour space, which key a canvas pipeline. */
export function compileChain( renderer: THREE.WebGPURenderer, pipeline: THREE.RenderPipeline ): ChainCompile {

	const p = pipeline as unknown as { _update?(): void; _quadMesh?: THREE.QuadMesh };
	if ( typeof p._update !== 'function' || ! p._quadMesh ) return { done: Promise.resolve(), unreached: [ 'RenderPipeline (no quad on this three)' ] };
	// (sets the quad's material from the output node as its first render would, before the state
	// below: it compares the renderer's tone mapping and colour space with its own)
	p._update();
	const { toneMapping, outputColorSpace } = renderer;
	renderer.toneMapping = THREE.NoToneMapping;
	renderer.outputColorSpace = THREE.ColorManagement.workingColorSpace;
	try {

		return compileQuad( renderer, p._quadMesh );

	} finally {

		renderer.toneMapping = toneMapping;
		renderer.outputColorSpace = outputColorSpace;

	}

}
