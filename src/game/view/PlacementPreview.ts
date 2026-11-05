import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { GridApi, Vec2 } from '../sim/types.ts';

// Where a building would stand under the pointer while the player places it: a ring the size
// of the ground its kind blocks (its footprint radius, sim/registry.ts BuildingDef), laid on the
// turf, light green where it can go and red where it cannot. It is drawn over the meadow (no depth
// test), so tall grass never hides it, and casts nothing. It shows only while placing. `show` says whether the ring changed (the page's temporal
// anti-aliasing converges a paused frame again only when told: Placement.ts).

const SEGMENTS = 48;
const WIDTH = 0.07;
// above the ground, so the ring follows the turf rather than cutting into it
const LIFT = 0.05;
const OK = new THREE.Color( 0.45, 1.0, 0.5 ).multiplyScalar( 0.6 );
const REFUSED = new THREE.Color( 1.0, 0.3, 0.2 ).multiplyScalar( 0.6 );

export class PlacementPreview {

	readonly mesh: THREE.Mesh;
	private readonly colour = uniform( new THREE.Color() );
	private readonly positions: Float32Array;
	private readonly attribute: THREE.BufferAttribute;
	// what the ring shows now: a point, its radius and whether it is allowed there, or null (hidden)
	private shown: { x: number; z: number; radius: number; ok: boolean } | null = null;

	constructor() {

		// two vertices per step round the ring (inner, outer), as a triangle strip of quads
		this.positions = new Float32Array( ( SEGMENTS + 1 ) * 2 * 3 );
		const index: number[] = [];
		for ( let k = 0; k < SEGMENTS; k ++ ) {

			const a = k * 2, b = a + 2;
			index.push( a, b, a + 1, a + 1, b, b + 1 );

		}
		const geometry = new THREE.BufferGeometry();
		this.attribute = new THREE.BufferAttribute( this.positions, 3 );
		geometry.setAttribute( 'position', this.attribute );
		geometry.setIndex( index );
		geometry.name = 'chestPreview';
		const material = new THREE.MeshBasicNodeMaterial( { side: THREE.DoubleSide, depthTest: false, depthWrite: false } );
		material.colorNode = this.colour;
		material.name = 'chestPreview';
		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.name = 'chestPreview';
		this.mesh.frustumCulled = false;
		// after the opaque scene it lies on
		this.mesh.renderOrder = 10;
		this.mesh.visible = false;

	}

	/** Show the ring of a footprint radius at a point (null: hide it), green when the building can
	 * go there; true when that changed what it shows. */
	show( p: Vec2 | null, radius: number, ok: boolean, grid: GridApi ): boolean {

		const was = this.shown;
		if ( p === null ? was === null : was !== null && was.x === p.x && was.z === p.z && was.radius === radius && was.ok === ok ) return false;
		this.shown = p && { x: p.x, z: p.z, radius, ok };
		this.mesh.visible = p !== null;
		if ( ! p ) return true;
		this.colour.value.copy( ok ? OK : REFUSED );
		const a = this.positions;
		for ( let k = 0; k <= SEGMENTS; k ++ ) {

			const angle = k / SEGMENTS * Math.PI * 2, c = Math.cos( angle ), s = Math.sin( angle );
			for ( let side = 0; side < 2; side ++ ) {

				const r = radius + ( side - 0.5 ) * WIDTH;
				const x = p.x + c * r, z = p.z + s * r, i = ( k * 2 + side ) * 3;
				a[ i ] = x;
				a[ i + 1 ] = grid.height( x, z ) + LIFT;
				a[ i + 2 ] = z;

			}

		}
		this.attribute.needsUpdate = true;
		return true;

	}

	dispose(): void {

		this.mesh.removeFromParent();
		this.mesh.geometry.dispose();
		( this.mesh.material as THREE.Material ).dispose();

	}

}
