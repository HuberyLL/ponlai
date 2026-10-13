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
//
// `tools/verify-frame-graph-gpu.mjs` checks the patches (both orders of an MRT and a plain draw, a
// swapped layout). They refuse another three revision with a warning, and `Antialiasing.ts` then
// refuses the temporal modes, which need them: re-check them on a three upgrade.
//
// One more patch, of the bindings (`installBindingPatches`): a render object's bind groups are cloned
// from its build's (NodeBuilderState.createBindings), and a cloned texture binding starts with the
// texture its node held when the material was built; `_createBindings` makes that texture ready on
// the GPU before the first update moves the binding to the node's current one. Once the page has
// put another texture in the node and disposed the first (the island's growth replaces its fields
// and wave fields: world/Growth.ts), every new render object of the material (a grown chunk's
// shadow draw) uploads the disposed texture again, and it stays on the GPU for good, since its
// dispose event has already fired (13.6 MB from a twelve-step growth). The patch starts each
// texture binding at its node's current texture, which is where the first update would move it.
// There is no public path: the build's bindings are three's internal state.

type Texture = { format: unknown; type: unknown; name: string };
type RenderContext = { mrt?: { id: number } | null; textures: Texture[] | null };
type RenderObject = { initialCacheKey: unknown; context: RenderContext };
type Callable = ( this: unknown, ...args: unknown[] ) => unknown;
type Host = Record<string, unknown>;
type BindGroup = { bindings: { isSampledTexture?: boolean; textureNode?: { value: unknown } | null; texture: unknown }[] };

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

/** Patches the renderer's bindings (an instance) so that a new bind group's texture bindings start at
 * their node's current texture, not the one the material was built with (see the header). Call after
 * `renderer.init()`. Returns false (and warns) on a three revision other than 186, or before init. */
export function installBindingPatches( renderer: unknown, revision: string = REVISION ): boolean {

	if ( ! /^186(\.|$)/.test( revision ) ) {

		console.warn( `installBindingPatches: written for three r186, this is r${ revision }; not installed` );
		return false;

	}
	const bindings = ( renderer as { _bindings?: Host | null } )._bindings;
	if ( ! bindings || typeof bindings._createBindings !== 'function' ) {

		console.warn( 'installBindingPatches: the renderer is not initialised (or not WebGPU); not installed' );
		return false;

	}
	if ( patched.has( bindings ) ) return true;
	patched.add( bindings );

	const create = bindings._createBindings as Callable;
	bindings._createBindings = function ( this: unknown, groups: BindGroup[] ) {

		for ( const group of groups ) for ( const binding of group.bindings ) {

			// (the setter resets the binding's version when the texture changes)
			if ( binding.isSampledTexture && binding.textureNode ) binding.texture = binding.textureNode.value;

		}
		return create.call( this, groups );

	};
	return true;

}
