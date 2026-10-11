import type * as THREE from 'three/webgpu';
import { debugFlags } from '../debug/DebugFlags.ts';

// The vegetation's layered wind (`windField` in Wind.ts: a scrolling gust field, a whole-plant
// bend, branch sway and leaf flutter) replaced a few global sine phases. Each mesh keeps a
// material with the old sway as well, built beside the new one, for one-page A/Bs of its cost and
// look: `debugFlags.windLegacy = true` draws the old sway (tools/profile-frame.mjs
// --toggle "s.flags.windLegacy = on"), and so does the URL option `windLegacy` (read at load).
// A missing flag is the new wind. The depth prepass (VegetationPrepass.ts) builds its copy of
// both, so the copy always places every vertex exactly as the shaded draw does.
//
// Under the temporal modes the shipped materials also write the wind's motion (their previous
// sway, VegetationShadow.ts); `debugFlags.mv.wind = false` swaps them to their build without it
// (`userData.windMotion = false`): no wind motion in the velocity and no second sway in the
// vertex stage, for MV-UNIT and for timing that sway with --toggle "s.flags.mv.wind = off".
// A material drawn by meshes made later (the game's palm) follows the flag through
// `followWindMotionFlag` instead.

export interface WindVariants { shipped: THREE.Material; legacy: THREE.Material }

/** Remember `legacy` (the old sway) beside the mesh's current material. */
export function keepLegacyWind( mesh: THREE.Mesh, legacy: THREE.Material ): void {

	mesh.userData.windVariants = { shipped: mesh.material as THREE.Material, legacy } satisfies WindVariants;

}

export function windVariants( mesh: THREE.Object3D ): WindVariants | undefined {

	return mesh.userData.windVariants as WindVariants | undefined;

}

// materials outside the registered meshes that follow `debugFlags.mv.wind` (followWindMotionFlag)
const followers = new Set<THREE.Material>();

function setWindMotion( m: THREE.Material, windStill: boolean ): void {

	if ( m.userData.previousPosition !== true || ( m.userData.windMotion === false ) === windStill ) return;
	m.userData.windMotion = ! windStill;
	m.needsUpdate = true;

}

/** Let `material` (one with a previous position, VegetationShadow.ts) follow `debugFlags.mv.wind`
 * as the registered meshes' shipped materials do, whenever its meshes are made. */
export function followWindMotionFlag( material: THREE.Material ): void {

	followers.add( material );
	setWindMotion( material, debugFlags.mv.wind === false );

}

export const legacyWind = (): boolean => debugFlags.windLegacy === true;

/** Swap every registered mesh under `roots` to the variant the flag asks for, before each render
 * of the scene. */
export function installWindVariants( scene: THREE.Scene, roots: THREE.Object3D[] ): void {

	if ( new URLSearchParams( location.search ).has( 'windLegacy' ) ) debugFlags.windLegacy = true;
	const meshes: THREE.Mesh[] = [];
	for ( const root of roots ) root.traverse( ( object ) => { if ( windVariants( object ) ) meshes.push( object as THREE.Mesh ); } );
	let state: boolean | undefined, still: boolean | undefined;
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = ( ...args ) => {

		const windStill = debugFlags.mv.wind === false;
		if ( windStill !== still ) {

			still = windStill;
			for ( const mesh of meshes ) setWindMotion( windVariants( mesh )!.shipped, windStill );
			for ( const m of followers ) setWindMotion( m, windStill );

		}
		const legacy = legacyWind();
		if ( legacy !== state ) {

			state = legacy;
			for ( const mesh of meshes ) {

				const v = windVariants( mesh )!;
				mesh.material = legacy ? v.legacy : v.shipped;

			}

		}
		previous.apply( scene, args );

	};

}
