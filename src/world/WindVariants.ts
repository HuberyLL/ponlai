import type * as THREE from 'three/webgpu';
import { debugFlags } from '../debug/DebugFlags.ts';

// The vegetation's layered wind (`windField` in Wind.ts: a scrolling gust field, a whole-plant
// bend, branch sway and leaf flutter) replaced a few global sine phases. Each mesh keeps a
// material with the old sway as well, built beside the new one, for one-page A/Bs of its cost and
// look: `debugFlags.windLegacy = true` draws the old sway (tools/profile-frame.mjs
// --toggle "s.flags.windLegacy = on"), and so does the URL option `windLegacy` (read at load).
// A missing flag is the new wind. The depth prepass (VegetationPrepass.ts) builds its copy of
// both, so the copy always places every vertex exactly as the shaded draw does.

export interface WindVariants { shipped: THREE.Material; legacy: THREE.Material }

/** Remember `legacy` (the old sway) beside the mesh's current material. */
export function keepLegacyWind( mesh: THREE.Mesh, legacy: THREE.Material ): void {

	mesh.userData.windVariants = { shipped: mesh.material as THREE.Material, legacy } satisfies WindVariants;

}

export function windVariants( mesh: THREE.Object3D ): WindVariants | undefined {

	return mesh.userData.windVariants as WindVariants | undefined;

}

export const legacyWind = (): boolean => debugFlags.windLegacy === true;

/** Swap every registered mesh under `roots` to the variant the flag asks for, before each render
 * of the scene. */
export function installWindVariants( scene: THREE.Scene, roots: THREE.Object3D[] ): void {

	if ( new URLSearchParams( location.search ).has( 'windLegacy' ) ) debugFlags.windLegacy = true;
	const meshes: THREE.Mesh[] = [];
	for ( const root of roots ) root.traverse( ( object ) => { if ( windVariants( object ) ) meshes.push( object as THREE.Mesh ); } );
	let state: boolean | undefined;
	const previous = scene.onBeforeRender;
	scene.onBeforeRender = ( ...args ) => {

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
