import * as THREE from 'three/webgpu';
import { markSwimmer } from '../../render/index.ts';

// One kind of the sea's creatures as an instanced mesh of a fixed capacity, its instances written
// from the CPU each frame (SeaLife.ts).
//
// The instances carry no matrix: iPose ( x, y, z, scale ), iTurn (a unit quaternion), iMotion
// ( the stroke's phase, its amplitude, the turn's bend, the paired fins' fold ) and iBefore ( the
// previous x, y, z and phase, for the temporal modes' motion vectors), which the material
// (SwimmerMaterial.ts) poses, turns and places. The buffers keep their capacity for the page's life
// (a Grow changes how many are drawn, never the buffers: the root AGENTS.md's instance rule).
//
// The mesh is a swimmer (Refraction.ts markSwimmer): drawn in the opaque pass only, its alpha 0
// telling the water that the pixel holds a creature under it, so the water shows it at the render's
// own resolution instead of the refraction image's. It casts no shadow and is never culled (its
// instances move anywhere round the island).

export interface Pose {
	x: number; y: number; z: number; scale: number;
	// the unit quaternion
	qx: number; qy: number; qz: number; qw: number;
	phase: number; amp: number; bend: number; fold: number;
	// the previous position and phase
	px: number; py: number; pz: number; pphase: number;
}

export class Swimmers {

	readonly mesh: THREE.Mesh;
	readonly capacity: number;
	private readonly attrs: Record<'iPose' | 'iTurn' | 'iMotion' | 'iBefore', THREE.InstancedBufferAttribute>;
	private n = 0;

	constructor( name: string, base: THREE.BufferGeometry, material: THREE.MeshStandardNodeMaterial, capacity: number ) {

		this.capacity = capacity;
		const geometry = new THREE.InstancedBufferGeometry();
		geometry.index = base.index;
		for ( const a of [ 'position', 'normal', 'aData' ] ) geometry.setAttribute( a, base.getAttribute( a ) );
		const attr = () => new THREE.InstancedBufferAttribute( new Float32Array( capacity * 4 ), 4 );
		this.attrs = { iPose: attr(), iTurn: attr(), iMotion: attr(), iBefore: attr() };
		for ( const [ a, b ] of Object.entries( this.attrs ) ) geometry.setAttribute( a, b );
		geometry.instanceCount = 0;
		markSwimmer( material );
		this.mesh = new THREE.Mesh( geometry, material );
		this.mesh.name = name;
		this.mesh.frustumCulled = false;
		this.mesh.castShadow = false;
		this.mesh.receiveShadow = false;

	}

	/** Starts a frame's writing. */
	begin(): void {

		this.n = 0;

	}

	/** Writes the next instance (past the capacity: left out). */
	push( p: Pose ): void {

		if ( this.n >= this.capacity ) return;
		const i = this.n ++ * 4;
		const pose = this.attrs.iPose.array as Float32Array, turn = this.attrs.iTurn.array as Float32Array;
		const motion = this.attrs.iMotion.array as Float32Array, before = this.attrs.iBefore.array as Float32Array;
		pose[ i ] = p.x; pose[ i + 1 ] = p.y; pose[ i + 2 ] = p.z; pose[ i + 3 ] = p.scale;
		turn[ i ] = p.qx; turn[ i + 1 ] = p.qy; turn[ i + 2 ] = p.qz; turn[ i + 3 ] = p.qw;
		motion[ i ] = p.phase; motion[ i + 1 ] = p.amp; motion[ i + 2 ] = p.bend; motion[ i + 3 ] = p.fold;
		before[ i ] = p.px; before[ i + 1 ] = p.py; before[ i + 2 ] = p.pz; before[ i + 3 ] = p.pphase;

	}

	/** Ends a frame's writing: draws what was written. */
	end(): void {

		( this.mesh.geometry as THREE.InstancedBufferGeometry ).instanceCount = this.n;
		// upload only the instances drawn
		for ( const a of Object.values( this.attrs ) ) {

			a.clearUpdateRanges();
			a.addUpdateRange( 0, this.n * 4 );
			a.needsUpdate = true;

		}

	}

}
