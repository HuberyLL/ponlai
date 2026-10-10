import { REVISION } from 'three/webgpu';

// Cache-key patches for three r186's node and pipeline caches, so a material drawn into targets
// of different layouts (another MRT, other attachment formats) gets a shader and a pipeline per
// layout. Exported for the frame graph's warm-up (M4); not installed yet.
//
// In r186 `NodeManager.getForRenderCacheKey( renderObject )` is the render object's initial cache
// key (material and dynamic keys) alone. The node builder reads the renderer's MRT and the target's
// textures (their names pick the MRT outputs) while it builds, so the first build of a material,
// with or without an MRT, served every later layout: a warm-up compile without the MRT poisoned the
// MRT draw's shader. The backend's `getRenderCacheKey` takes only the first colour attachment's
// format, and nothing of the context MRT, which carries the per-attachment blend modes
// (WebGPUPipelineUtils reads `context.mrt.getBlendMode( texture.name )`).

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
 * context MRT and the attachment layout. Call after `renderer.init()`. Returns false (and warns)
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
	nodes.getForRenderCacheKey = function ( this: unknown, renderObject: RenderObject ) {

		const context = renderObject.context;
		return `${ nodeKey.call( this, renderObject ) }|${ context.mrt?.id ?? '-' }|${ layoutKey( context ) }`;

	};
	const pipelineKey = backend.getRenderCacheKey as Callable;
	backend.getRenderCacheKey = function ( this: unknown, renderObject: RenderObject ) {

		const context = renderObject.context;
		const formats = backend.utils?.getCurrentColorFormats?.( context ) ?? [ layoutKey( context ) ];
		return `${ pipelineKey.call( this, renderObject ) },${ formats.join( '/' ) },${ context.mrt?.id ?? '-' }`;

	};
	return true;

}
