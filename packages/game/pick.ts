import * as THREE from 'three/webgpu';
import { ISLAND_PEAK, ISLAND_TOP, SWELL } from '../island/land.ts';
import type { GridApi, Vec2 } from './sim/types.ts';

// The point of the island's ground under the pointer, for the controls and the debug panel.
//
// The point of the island's ground under the pointer, shared by the player's controls and the
// debug panel's send-to-click.

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const STEP = 0.25;

/** The ray through a pointer position (client pixels) on the canvas. */
export function pointerRay( canvas: HTMLCanvasElement, camera: THREE.Camera, clientX: number, clientY: number ): THREE.Ray {

	const r = canvas.getBoundingClientRect();
	ndc.set( ( clientX - r.left ) / r.width * 2 - 1, - ( clientY - r.top ) / r.height * 2 + 1 );
	raycaster.setFromCamera( ndc, camera );
	return raycaster.ray;

}

/** The ray on the turf: from where it comes down through the island's highest top, stepped along
 * (STEP m) to the first point under the ground's height, then halved to it, as the swells' slopes
 * and a low camera would carry a guess off the ground. */
export function groundPoint( ray: THREE.Ray, grid: GridApi ): Vec2 | null {

	const o = ray.origin, d = ray.direction;
	if ( d.y > - 1e-4 ) return null;
	const below = ( t: number ) => o.y + d.y * t <= grid.height( o.x + d.x * t, o.z + d.z * t );
	let a = Math.max( 0, ( ISLAND_PEAK - o.y ) / d.y );
	const end = ( ISLAND_TOP - SWELL.height - 0.5 - o.y ) / d.y;
	for ( let b = a + STEP; a < end; a = b, b += STEP ) {

		if ( ! below( b ) ) continue;
		for ( let k = 0; k < 20; k ++ ) {

			const m = ( a + b ) / 2;
			if ( below( m ) ) b = m; else a = m;

		}
		return { x: o.x + d.x * b, z: o.z + d.z * b };

	}
	return null;

}
