import { REVISION } from 'three/webgpu';

// Cache-key patches for three r186's node and pipeline caches, so a material drawn into targets
// of different layouts (another MRT, other attachment formats or names) gets a shader and a
// pipeline per layout. Installed by main.ts right after `renderer.init()`, before any material
// builds.
//
// In r186 a draw's node build is cached by `NodeManager.getForRenderCacheKey( renderObject )`, the
// render object's initial cache key. That key ends in its render context's id, and the contexts are
// keyed by the attachment count, the first attachment's format and type, samples, depth, the MRT
// and the call depth, so those already tell builds apart; the other attachments' formats and the
// textures' names do not, though the node builder reads them while it builds (an MRT picks its
// outputs by name): two targets of one such layout whose later attachments differ shared the first
// one's build. The backend's `getRenderCacheKey` takes only the first colour attachment's format,
// and nothing of the context MRT, which carries the per-attachment blend modes (WebGPUPipelineUtils
// reads `context.mrt.getBlendMode( texture.name )`). Both keys gain the MRT and every attachment's
// format, type and name.
//
// A render object keeps the node key it was first built under: three asks for it again when it
// disposes the object (NodeManager.delete), when its shared context may hold another target's
// textures, and a key read then would miss the build's cache entry (leaking it) or evict another
// layout's. (A render object never changes its build: three makes a new one when its key changes.)

type Texture = { format: unknown; type: unknown; name: string };
type RenderContext = { mrt?: { id: number } | null; textures: Texture[] | null };
type RenderObject = { initialCacheKey: unknown; context: RenderContext };
type Callable = ( this: unknown, ...args: unknown[] ) => unknown;
type Host = Record<string, unknown>;

// the attachment layout: their count, and each texture's format, type and name
function layoutKey( context: RenderContext ): string {

	const textures = context.textures;
	if ( textures === null ) return 'canvas';
	return `${ textures.length }:${ textures.map( ( t ) => `${ t.format }/${ t.type }/${ t.name }` ).join( ',' ) }`;

}

const patched = new WeakSet<object>();

/** Patches the renderer's node manager and backend (instances) so their cache keys include the
 * context MRT and the whole attachment layout (the node key fixed per render object). Call after `renderer.init()`. Returns false (and warns)
 * on a three revision other than 186, whose internals it was written against, or before init. */
export function installCacheKeyPatches( renderer: unknown, revision: string = REVISION ): boolean {

	if ( ! /^186(\.|$)/.test( revision ) ) {

		console.warn( `installCacheKeyPatches: written for three r186, this is r${ revision }; not installed` );
		return false;

	}
	const r = renderer as { _nodes?: Host | null; backend?: Host & { utils?: { getCurrentColorFormats?( context: RenderContext ): string[] } } };
	const nodes = r._nodes, backend = r.backend;
	if ( ! nodes || ! backend || typeof nodes.getForRenderCacheKey !== 'function' || typeof backend.getRenderCacheKey !== 'function' ) {

		console.warn( 'installCacheKeyPatches: the renderer is not initialised (or not WebGPU); not installed' );
		return false;

	}
	if ( patched.has( nodes ) ) return true;
	patched.add( nodes );

	const nodeKey = nodes.getForRenderCacheKey as Callable;
	const keys = new WeakMap<RenderObject, string>();
	nodes.getForRenderCacheKey = function ( this: unknown, renderObject: RenderObject ) {

		let key = keys.get( renderObject );
		if ( key === undefined ) {

			const context = renderObject.context;
			key = `${ nodeKey.call( this, renderObject ) }|${ context.mrt?.id ?? '-' }|${ layoutKey( context ) }`;
			keys.set( renderObject, key );

		}
		return key;

	};
	const pipelineKey = backend.getRenderCacheKey as Callable;
	backend.getRenderCacheKey = function ( this: unknown, renderObject: RenderObject ) {

		const context = renderObject.context;
		const formats = backend.utils?.getCurrentColorFormats?.( context ) ?? [ layoutKey( context ) ];
		return `${ pipelineKey.call( this, renderObject ) },${ formats.join( '/' ) },${ context.mrt?.id ?? '-' }`;

	};
	return true;

}
