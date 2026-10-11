import * as THREE from 'three/webgpu';

// Ahead-of-time pipeline compiles for draws that would otherwise build their pipelines in the
// frame that first shows them (a weather change, the first bolt, a storm's spray, fog setting in).
// The rain, the spray, the lightning, the sky and the frame graph use them in their warm() hooks,
// which startup calls (main.ts), so a weather change or the first bolt builds none.
//
// `renderer.compileAsync` collects its draws and reads the render target synchronously, before its
// first await: set the target, call it, restore the target at once, then await (`compileDraws`).
// It builds a transparent double-sided material's two passes after restoring its side, as one
// unused double-sided pipeline (r186): compile a copy of the material per side and keep the copies
// (disposing them releases the shared pipelines; see `Lightning.warm`).

/** `renderer.compileAsync( object, camera, scene )` for draws into `target` (null: the canvas),
 * leaving the renderer's own target as it was. three r186's compileAsync describes the target's
 * depth attachment by the renderer's `depth` and `stencil` flags, where a render takes the
 * target's own, so a target without a depth buffer (a post pass's) compiled a pipeline its draws
 * never use; the flags follow the target while the compile collects its draws, which it does
 * before its first await, and are restored at once. */
export function compileInto( renderer: THREE.WebGPURenderer, object: THREE.Object3D, camera: THREE.Camera,
	target: THREE.RenderTarget | null, scene: THREE.Scene | null = null ): Promise<void> {

	const previous = renderer.getRenderTarget();
	const { depth, stencil } = renderer;
	renderer.setRenderTarget( target );
	if ( target ) {

		renderer.depth = target.depthBuffer;
		renderer.stencil = target.stencilBuffer;

	}
	try {

		return renderer.compileAsync( object, camera, scene );

	} finally {

		renderer.setRenderTarget( previous );
		renderer.depth = depth;
		renderer.stencil = stencil;

	}

}

/** Compile the pipelines `objects` draw with as `scene` would draw them for `camera` into
 * `target` (null: the canvas), whether they are shown now or not, so that their first frame
 * does not stall on pipeline creation. The objects' visibility and culling are restored before
 * this returns its promise: compileAsync reads them only while it is collecting the draws. */
export function compileDraws( renderer: THREE.WebGPURenderer, objects: THREE.Object3D[], scene: THREE.Scene, camera: THREE.Camera,
	target: THREE.RenderTarget | null ): Promise<void> {

	const saved: [ THREE.Object3D, boolean, boolean ][] = [];
	for ( const root of objects ) root.traverse( ( object ) => {

		saved.push( [ object, object.visible, object.frustumCulled ] );
		object.visible = true;
		object.frustumCulled = false;

	} );
	let pending: Promise<void>[];
	try {

		pending = objects.map( ( object ) => compileInto( renderer, object, camera, target, scene ) );

	} finally {

		for ( const [ object, visible, culled ] of saved ) {

			object.visible = visible;
			object.frustumCulled = culled;

		}

	}
	return Promise.all( pending ).then( () => undefined );

}
