import type * as THREE from 'three/webgpu';
import { debugFlags } from '../debug/DebugFlags.ts';

// Under the temporal modes the vegetation's materials also write the wind's motion (their previous
// sway, VegetationShadow.ts); `debugFlags.mv.wind = false` rebuilds them without it
// (`userData.windMotion = false`): no wind motion in the velocity and no second sway in the vertex
// stage, for MV-UNIT and for timing that sway with --toggle "s.flags.mv.wind = off". Each
// vegetation material registers itself with `followWindMotionFlag` as it is built (the grass, the plateau plants, the
// bushes, the flowers, the rim leaves, the turf skirt, the game's palm), so meshes made later (a
// grown island's, the palm) share the state of the material they draw with.

// the materials that follow `debugFlags.mv.wind`
const followers = new Set<THREE.Material>();

function setWindMotion( m: THREE.Material, windStill: boolean ): void {

	if ( m.userData.previousPosition !== true || ( m.userData.windMotion === false ) === windStill ) return;
	m.userData.windMotion = ! windStill;
	m.needsUpdate = true;

}

/** Let `material` (one with a previous position, VegetationShadow.ts) follow `debugFlags.mv.wind`. */
export function followWindMotionFlag( material: THREE.Material ): void {

	followers.add( material );
	setWindMotion( material, debugFlags.mv.wind === false );

}

/** Apply `debugFlags.mv.wind` to every following material before each render of the scene, so a
 * change of the flag takes effect at run time. */
export function installWindMotionFlag( scene: THREE.Scene ): void {

	let still: boolean | undefined;
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = ( ...args ) => {

		const windStill = debugFlags.mv.wind === false;
		if ( windStill !== still ) {

			still = windStill;
			for ( const m of followers ) setWindMotion( m, windStill );

		}
		previous.apply( scene, args );

	};

}
