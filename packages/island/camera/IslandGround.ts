import * as THREE from 'three/webgpu';
import { GROUND_CELL as CELL, type GroundGrid } from '../world/ChunkDerived.ts';

// The island's ground for the camera on the CPU: a coarse top-down height grid of the island's own
// meshes (the highest vertex in each cell) over a flat sea, enough to find the point under the
// cursor that a drag grabs or a zoom closes in on. It derives from the meshes alone, so any tile
// layout works; plants are left out (a grab on a crown takes the ground under it). The page takes
// `fromGrids`: it merges the grids the world's workers made for the chunks' island meshes
// (ChunkDerived.ts) on the world's lattice, so the main thread walks none of their vertices.
// `build` walks the meshes' vertices on a grid from their box's corner, as the page did before;
// tools/verify-chunk-derived.mjs checks that the two differ by less than a cell.
// A ray that reaches the sea's distance meets the sea there: its height at that distance rounds an
// ulp or two above the sea for a few rays in a hundred, which a height test alone read as misses
// (a wheel zoom over the water lost its anchor and closed in on the pivot).

// the sea's height for the camera (the waves' few decimetres do not matter to a grab)
const SEA = 0;

const _box = new THREE.Box3();
const _p = new THREE.Vector3();

export class IslandGround {

	/** The island's extent (world units), empty until `build`. */
	readonly bounds = new THREE.Box3();
	private heights = new Float32Array( 0 );
	private nx = 0;
	private nz = 0;
	private x0 = 0;
	private z0 = 0;
	private top = SEA;

	/** Rasterises the meshes' vertices into the grid (their world matrices must be current). */
	build( meshes: readonly THREE.Mesh[] ): void {

		this.bounds.makeEmpty();
		for ( const mesh of meshes ) this.bounds.union( _box.setFromObject( mesh ) );
		if ( this.bounds.isEmpty() ) return;
		this.x0 = this.bounds.min.x;
		this.z0 = this.bounds.min.z;
		this.nx = Math.ceil( ( this.bounds.max.x - this.x0 ) / CELL ) + 1;
		this.nz = Math.ceil( ( this.bounds.max.z - this.z0 ) / CELL ) + 1;
		this.heights = new Float32Array( this.nx * this.nz ).fill( - Infinity );
		this.top = SEA;
		for ( const mesh of meshes ) {

			const position = mesh.geometry.getAttribute( 'position' );
			for ( let i = 0; i < position.count; i ++ ) {

				_p.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
				const k = this.cell( _p.x, _p.z );
				if ( k >= 0 && _p.y > this.heights[ k ] ) this.heights[ k ] = _p.y;
				if ( _p.y > this.top ) this.top = _p.y;

			}

		}

	}

	/** Merges the chunks' ground grids (ChunkDerived.ts) by their highest point per cell. */
	fromGrids( grids: readonly GroundGrid[] ): void {

		this.bounds.makeEmpty();
		let x1 = - Infinity, z1 = - Infinity;
		this.x0 = this.z0 = Infinity;
		for ( const grid of grids ) {

			if ( grid.nx === 0 ) continue;
			const b = grid.bounds;
			this.bounds.expandByPoint( _p.set( b[ 0 ], b[ 1 ], b[ 2 ] ) ).expandByPoint( _p.set( b[ 3 ], b[ 4 ], b[ 5 ] ) );
			this.x0 = Math.min( this.x0, grid.x0 );
			this.z0 = Math.min( this.z0, grid.z0 );
			x1 = Math.max( x1, grid.x0 + grid.nx * CELL );
			z1 = Math.max( z1, grid.z0 + grid.nz * CELL );

		}
		if ( this.bounds.isEmpty() ) return;
		this.nx = Math.round( ( x1 - this.x0 ) / CELL );
		this.nz = Math.round( ( z1 - this.z0 ) / CELL );
		this.heights = new Float32Array( this.nx * this.nz ).fill( - Infinity );
		this.top = Math.max( SEA, this.bounds.max.y );
		for ( const grid of grids ) {

			const oi = Math.round( ( grid.x0 - this.x0 ) / CELL ), oj = Math.round( ( grid.z0 - this.z0 ) / CELL );
			for ( let j = 0; j < grid.nz; j ++ ) for ( let i = 0; i < grid.nx; i ++ ) {

				const k = ( oj + j ) * this.nx + oi + i;
				this.heights[ k ] = Math.max( this.heights[ k ], grid.heights[ j * grid.nx + i ] );

			}

		}

	}

	/** The ground's height at ( x, z ): the island's top where it stands, else the sea. */
	heightAt( x: number, z: number ): number {

		const k = this.cell( x, z );
		return k >= 0 ? Math.max( this.heights[ k ], SEA ) : SEA;

	}

	/** Where the ray from `origin` along the unit `dir` first meets the ground (within `far`), into
	 * `out`; null when it rises above the horizon or runs out. */
	intersect( origin: THREE.Vector3, dir: THREE.Vector3, far: number, out: THREE.Vector3 ): THREE.Vector3 | null {

		if ( dir.y >= - 1e-6 ) return null;
		// from where the ray comes down to the island's top to where it meets the sea
		const sea = ( SEA - origin.y ) / dir.y;
		const t0 = Math.max( 0, ( this.top - origin.y ) / dir.y );
		const t1 = Math.min( far, sea );
		if ( t1 < t0 ) return null;
		const horizontal = Math.hypot( dir.x, dir.z );
		const step = horizontal > 1e-6 ? Math.min( CELL * 0.5 / horizontal, t1 - t0 ) : t1 - t0;
		let previous = t0;
		for ( let t = t0; ; t = Math.min( t + step, t1 ) ) {

			// (at the sea's distance the ray is on the sea, whatever its height there rounds to)
			if ( t >= sea || origin.y + dir.y * t <= this.heightAt( origin.x + dir.x * t, origin.z + dir.z * t ) ) {

				// bisect between the last point above the ground and this one
				let a = previous, b = t;
				for ( let i = 0; i < 12; i ++ ) {

					const m = ( a + b ) / 2;
					if ( origin.y + dir.y * m <= this.heightAt( origin.x + dir.x * m, origin.z + dir.z * m ) ) b = m;
					else a = m;

				}
				return out.copy( dir ).multiplyScalar( b ).add( origin );

			}
			if ( t >= t1 ) break;
			previous = t;

		}
		return null;

	}

	private cell( x: number, z: number ): number {

		const i = Math.floor( ( x - this.x0 ) / CELL ), j = Math.floor( ( z - this.z0 ) / CELL );
		return i >= 0 && i < this.nx && j >= 0 && j < this.nz ? j * this.nx + i : - 1;

	}

}
