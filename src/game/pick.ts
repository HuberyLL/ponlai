import * as THREE from 'three/webgpu';
import { ISLAND_TOP } from '../world/WorldShapes.ts';
import type { GridApi, Vec2 } from './sim/types.ts';

// The point of the island's ground under the pointer, shared by the player's controls and the
// debug panel's send-to-click.

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();

/** The ray through a pointer position (client pixels) on the canvas. */
export function pointerRay( canvas: HTMLCanvasElement, camera: THREE.Camera, clientX: number, clientY: number ): THREE.Ray {

	const r = canvas.getBoundingClientRect();
	ndc.set( ( clientX - r.left ) / r.width * 2 - 1, - ( clientY - r.top ) / r.height * 2 + 1 );
	raycaster.setFromCamera( ndc, camera );
	return raycaster.ray;

}

/** The ray on the turf: the island's top plane, then the ground height under it. */
export function groundPoint( ray: THREE.Ray, grid: GridApi ): Vec2 | null {

	const o = ray.origin, d = ray.direction;
	if ( d.y > - 1e-4 ) return null;
	let t = ( ISLAND_TOP - o.y ) / d.y;
	for ( let k = 0; k < 3; k ++ ) t = ( grid.height( o.x + d.x * t, o.z + d.z * t ) - o.y ) / d.y;
	return t < 0 ? null : { x: o.x + d.x * t, z: o.z + d.z * t };

}
