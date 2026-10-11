// The sea floor's meshes: a near tile for every world-anchored 16 m cell of floor the land shapes
// (but those under the land), and one far mesh on the open sea's 4 m lattice round them. A tile is
// a function of its cell and the land within LAND_REACH (plus the contact shade's 1.5 m) of it
// alone: its lattice is anchored to the world, its normals are differences of the floor function
// rather than of its own triangles, so two tiles compute their shared border vertices alike, bit
// for bit, and a tile stays as it was wherever the land changes farther away.

import { FLOOR_STEP, OPEN_LATTICE, openSeaBeds, openSeaHeight, seabedBeds, seabedFloor } from './Bathymetry.ts';
import { LAND_REACH, type Footprint } from './WorldShapes.ts';
import { GROWTH, type LandLattice } from './IslandGrowth.ts';
import { contactVisibilitySampler, type SolidBounds } from '../lighting/SkyOcclusion.ts';

export const SEABED_TILE = 16;
// vertices along a tile's side
export const TILE_SIDE = SEABED_TILE / FLOOR_STEP + 1;
// A cell gets a tile when land lies this close to it (m): LAND_REACH, and 2 m for the footprint's
// rounded corners and raster. Farther out the floor is the open sea's, which the far floor draws.
const TILE_REACH = LAND_REACH + 2;
// The far floor covers the land lattice and 128 m round it: this far from the world's centre (m).
export const FAR_HALF = GROWTH.half + 128;

export interface FloorTile {
	ci: number; cj: number;
	// TILE_SIDE x TILE_SIDE vertices, row by row (z, then x)
	positions: Float32Array;
	normals: Float32Array;
	// contact visibility of the island and stones
	ao: Float32Array;
	// seagrass cover and pale-sand share (seabedBeds)
	bed: Float32Array;
}

// The normal of a heightfield from its slopes, by central differences 2 * FLOOR_STEP wide.
function normalOf( out: Float32Array, o: number, west: number, east: number, south: number, north: number ): void {

	const nx = ( west - east ) / ( 2 * FLOOR_STEP ), nz = ( south - north ) / ( 2 * FLOOR_STEP );
	const l = Math.hypot( nx, 1, nz );
	out[ o ] = nx / l; out[ o + 1 ] = 1 / l; out[ o + 2 ] = nz / l;

}

/**
 * The near tile of cell ( ci, cj ): the floor over x in [ 16 ci, 16 ci + 16 ], z likewise, on the
 * world's 0.5 m lattice (shared with the neighbours on the borders), with its contact shade from
 * `solids` (those that shade the floor: the island and its stones).
 */
export function buildFloorTile( ci: number, cj: number, fp: Footprint, solids: readonly SolidBounds[] ): FloorTile {

	const n = TILE_SIDE, step = FLOOR_STEP;
	const x0 = ci * SEABED_TILE, z0 = cj * SEABED_TILE;
	// the floor's heights with one point of apron round the tile, for the border normals
	const floor = seabedFloor( fp ), beds = seabedBeds( fp );
	const m = n + 2, h = new Float64Array( m * m );
	for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) h[ j * m + i ] = floor( x0 + ( i - 1 ) * step, z0 + ( j - 1 ) * step );

	const positions = new Float32Array( n * n * 3 ), normals = new Float32Array( n * n * 3 );
	const ao = new Float32Array( n * n ), bed = new Float32Array( n * n * 2 );
	// only the solids within the contact radius of the tile can shade it
	const radius = 1.5;
	const near = solids.filter( ( s ) => s.min[ 0 ] < x0 + SEABED_TILE + radius && s.max[ 0 ] > x0 - radius
		&& s.min[ 2 ] < z0 + SEABED_TILE + radius && s.max[ 2 ] > z0 - radius );
	const contact = contactVisibilitySampler( near, undefined, { radius } );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const v = j * n + i, k = ( j + 1 ) * m + i + 1;
		const x = x0 + i * step, z = z0 + j * step;
		positions[ v * 3 ] = x; positions[ v * 3 + 1 ] = h[ k ]; positions[ v * 3 + 2 ] = z;
		normalOf( normals, v * 3, h[ k - 1 ], h[ k + 1 ], h[ k - m ], h[ k + m ] );
		ao[ v ] = near.length ? contact( x, positions[ v * 3 + 1 ], z, normals[ v * 3 ], normals[ v * 3 + 1 ], normals[ v * 3 + 2 ] ) : 1;
		const [ grass, pale ] = beds( x, z );
		bed[ v * 2 ] = grass; bed[ v * 2 + 1 ] = pale;

	}
	return { ci, cj, positions, normals, ao, bed };

}

/**
 * The cells ( ci, cj ) the land shapes the floor in, in row order: every 16 m cell with land within
 * 26 m. The far floor leaves them out; all but those under the land get a near tile.
 */
export function nearLandCells( land: LandLattice ): [ number, number ][] {

	const w = land.cells(), cell = GROWTH.cell, X0 = - GROWTH.half;
	const S = SEABED_TILE, R = TILE_REACH;
	const near = new Set<number>();
	const key = ( ci: number, cj: number ) => ( ci + 1024 ) * 2048 + cj + 1024;
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) {

		if ( ! land.has( i, j ) ) continue;
		// the land cell's square, and the tiles whose square lies within the reach of it
		const x0 = X0 + i * cell, z0 = X0 + j * cell, x1 = x0 + cell, z1 = z0 + cell;
		for ( let cj = Math.floor( ( z0 - R ) / S ); cj <= Math.floor( ( z1 + R ) / S ); cj ++ ) {

			const dz = Math.max( cj * S - z1, 0, z0 - ( cj + 1 ) * S );
			for ( let ci = Math.floor( ( x0 - R ) / S ); ci <= Math.floor( ( x1 + R ) / S ); ci ++ ) {

				const dx = Math.max( ci * S - x1, 0, x0 - ( ci + 1 ) * S );
				if ( dx * dx + dz * dz <= R * R ) near.add( key( ci, cj ) );

			}

		}

	}
	return [ ...near ].sort( ( a, b ) => ( a % 2048 ) - ( b % 2048 ) || a - b ).map( ( k ) => [ Math.floor( k / 2048 ) - 1024, k % 2048 - 1024 ] );

}

/** Whether the land covers cell ( ci, cj ) and 2 m round it: its floor lies inside the island's
 * solid, never seen, and its neighbours' borders with it too. */
export function underLand( land: LandLattice, ci: number, cj: number ): boolean {

	const cell = GROWTH.cell, X0 = - GROWTH.half, S = SEABED_TILE, m = 2;
	const i0 = Math.floor( ( ci * S - m - X0 ) / cell ), i1 = Math.ceil( ( ci * S + S + m - X0 ) / cell );
	const j0 = Math.floor( ( cj * S - m - X0 ) / cell ), j1 = Math.ceil( ( cj * S + S + m - X0 ) / cell );
	for ( let j = j0; j < j1; j ++ ) for ( let i = i0; i < i1; i ++ ) {

		if ( ! land.inside( X0 + ( i + 0.5 ) * cell, X0 + ( j + 0.5 ) * cell ) ) return false;

	}
	return true;

}

/** The cells ( ci, cj ) that get a near tile, in row order: those of `nearLandCells` not under the land. */
export function floorTileCells( land: LandLattice ): [ number, number ][] {

	return nearLandCells( land ).filter( ( [ ci, cj ] ) => ! underLand( land, ci, cj ) );

}

export interface FarFloor {
	positions: Float32Array;
	normals: Float32Array;
	bed: Float32Array;
	// the lattice's cells but those under near tiles
	indices: Uint32Array;
}


/**
 * The far floor: the open sea's lattice over the land lattice and 128 m round it, its cells in
 * the 16 m cells `near` (`nearLandCells`) left out: the near tiles meet it there at the same
 * heights, and the cells without a tile lie under the land.
 */
export function buildFarFloor( near: readonly [ number, number ][] ): FarFloor {

	const L = OPEN_LATTICE, X0 = - FAR_HALF, n = 2 * FAR_HALF / L;
	const positions = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 ), normals = new Float32Array( positions.length );
	const bed = new Float32Array( ( n + 1 ) * ( n + 1 ) * 2 );
	for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const v = j * ( n + 1 ) + i, x = X0 + i * L, z = X0 + j * L;
		positions[ v * 3 ] = x; positions[ v * 3 + 1 ] = openSeaHeight( x, z ); positions[ v * 3 + 2 ] = z;
		// by the same differences as a tile's, so a tile and the far floor shade the nodes they
		// share alike
		const h = openSeaHeight;
		normalOf( normals, v * 3, h( x - FLOOR_STEP, z ), h( x + FLOOR_STEP, z ), h( x, z - FLOOR_STEP ), h( x, z + FLOOR_STEP ) );
		const [ grass, pale ] = openSeaBeds( x, z );
		bed[ v * 2 ] = grass; bed[ v * 2 + 1 ] = pale;

	}
	const covered = new Set( near.map( ( [ ci, cj ] ) => `${ ci },${ cj }` ) );
	const indices: number[] = [];
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const ci = Math.floor( ( X0 + i * L ) / SEABED_TILE ), cj = Math.floor( ( X0 + j * L ) / SEABED_TILE );
		if ( covered.has( `${ ci },${ cj }` ) ) continue;
		const a = j * ( n + 1 ) + i;
		indices.push( a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2 );

	}
	return { positions, normals, bed, indices: new Uint32Array( indices ) };

}

// Two triangles per lattice cell of a tile, split as the open sea's lattice is.
export function tileIndices(): Uint32Array {

	const n = TILE_SIDE, idx = new Uint32Array( ( n - 1 ) * ( n - 1 ) * 6 );
	for ( let j = 0, k = 0; j < n - 1; j ++ ) for ( let i = 0; i < n - 1; i ++ ) {

		const a = j * n + i;
		idx[ k ++ ] = a; idx[ k ++ ] = a + n; idx[ k ++ ] = a + 1;
		idx[ k ++ ] = a + 1; idx[ k ++ ] = a + n; idx[ k ++ ] = a + n + 1;

	}
	return idx;

}
