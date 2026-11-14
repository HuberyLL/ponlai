import type { Grid } from './grid.ts';
import { planar } from './maths.ts';
import type { Vec2 } from './types.ts';

// What the game reads off the island's ground: distance to the edge, the shore band, clearance.
//
// What the game reads off the island's ground for its places (places.ts): how far each cell lies
// inside the island top's edge, the shore band along that edge, and whether a patch of ground is
// clear for something to stand on it. Everything derives from the grid (the world's own island and
// obstacles), never from coordinates placed by hand, so a grown island gets the same rules on its
// new ground. The edge and the shore are kept per island top (Grid.top, which a grown island
// replaces while its grid stays: Grid.setIsland), so a grown game's shore is a fresh load's.

/** the shore: walkable ground within this distance (m) of the island top's edge (two cells) */
export const SHORE_BAND = 1.0;
/** open ground a building needs round the ground it blocks (m), for clearAround */
export const CLEAR_RING = 1.0;

// per island top (Grid.top): the distance field and the shore's base cells (before the game's own
// obstacles)
const edges = new WeakMap<Uint8Array, Float32Array>();
const shores = new WeakMap<Uint8Array, Uint8Array>();

/**
 * Metres from each cell's centre to the nearest cell off the island top (a two-pass chamfer
 * distance, steps of one cell and a diagonal): 0 off the top, one cell size on its outermost ring.
 */
export function edgeDistance( grid: Grid ): Float32Array {

	const { cols, rows, top, size } = grid;
	let d = edges.get( top );
	if ( d ) return d;
	d = new Float32Array( cols * rows );
	const diag = size * Math.SQRT2;
	for ( let k = 0; k < d.length; k ++ ) d[ k ] = top[ k ] ? Infinity : 0;
	// off the grid counts as off the top
	const at = ( i: number, j: number ) => grid.inBounds( i, j ) ? d![ j * cols + i ] : 0;
	for ( let j = 0; j < rows; j ++ ) for ( let i = 0; i < cols; i ++ ) {

		const k = j * cols + i;
		if ( d[ k ] === 0 ) continue;
		d[ k ] = Math.min( d[ k ], at( i - 1, j ) + size, at( i, j - 1 ) + size, at( i - 1, j - 1 ) + diag, at( i + 1, j - 1 ) + diag );

	}
	for ( let j = rows - 1; j >= 0; j -- ) for ( let i = cols - 1; i >= 0; i -- ) {

		const k = j * cols + i;
		if ( d[ k ] === 0 ) continue;
		d[ k ] = Math.min( d[ k ], at( i + 1, j ) + size, at( i, j + 1 ) + size, at( i + 1, j + 1 ) + diag, at( i - 1, j + 1 ) + diag );

	}
	edges.set( top, d );
	return d;

}

/** 1 for the island top's cells within SHORE_BAND of its edge, whatever stands on them. */
export function shoreMask( grid: Grid ): Uint8Array {

	let m = shores.get( grid.top );
	if ( m ) return m;
	const d = edgeDistance( grid );
	m = new Uint8Array( d.length );
	for ( let k = 0; k < d.length; k ++ ) m[ k ] = d[ k ] > 0 && d[ k ] <= SHORE_BAND + 1e-4 ? 1 : 0;
	shores.set( grid.top, m );
	return m;

}

/** The cell indices whose centres lie within r of a point (on the grid). */
export function cellsWithin( grid: Grid, p: Vec2, r: number ): number[] {

	const out: number[] = [];
	const i0 = Math.floor( ( p.x - r - grid.x0 ) / grid.size ), i1 = Math.floor( ( p.x + r - grid.x0 ) / grid.size );
	const j0 = Math.floor( ( p.z - r - grid.z0 ) / grid.size ), j1 = Math.floor( ( p.z + r - grid.z0 ) / grid.size );
	for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

		if ( ! grid.inBounds( i, j ) ) continue;
		const k = j * grid.cols + i;
		if ( planar( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= r ) out.push( k );

	}
	return out;

}

/**
 * Whether all the ground within r of a point is open main ground. Something blocking a disc with
 * such a clear ring round it cannot cut the main ground in two: every way across goes round.
 */
export function clearAround( grid: Grid, p: Vec2, r: number ): boolean {

	const k = grid.indexAt( p.x, p.z );
	if ( k < 0 || grid.region[ k ] !== grid.main ) return false;
	return cellsWithin( grid, p, r ).every( ( c ) => grid.region[ c ] === grid.main );

}
