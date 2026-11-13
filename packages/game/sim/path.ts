import type { Grid } from './grid.ts';
import { planar } from './maths.ts';
import type { Vec2 } from './types.ts';

// Paths over the ground grid: A* across 8 neighbours, then pulled straight.
//
// Paths over the ground grid: A* across 8 neighbours without cutting corners, then pulled
// straight wherever a body-wide line stays on walkable cells. A path to a point ends on it, or on
// the nearest walkable cell when the point itself is blocked.

/** half a body's width: a straightened path keeps this clear of blocked cells */
const CLEARANCE = 0.15;
const SQRT2 = Math.SQRT2;

export interface Goal {
	/** cell indices that count as arrived */
	cells: number[];
	/** the target's point, for the heuristic */
	point: Vec2;
	/** farthest goal cell centre from the point (m), keeps the heuristic admissible */
	slack: number;
	/** where to stand at the end, when not the goal cell's centre */
	exact: Vec2 | null;
}

function distance( a: Vec2, b: Vec2 ): number {

	return planar( a.x - b.x, a.z - b.z );

}

/** Where to stand to reach a point: its own cell if walkable, else the nearest walkable one; null when none is near. */
export function goalAt( grid: Grid, target: Vec2 ): Goal | null {

	const k = grid.nearestOpen( grid.indexAt( target.x, target.z ) );
	if ( k < 0 ) return null;
	const exact = grid.indexAt( target.x, target.z ) === k ? { x: target.x, z: target.z } : null;
	return { cells: [ k ], point: grid.centreOf( k ), slack: 0, exact };

}

/** Where to stand at a place (places.ts: what it reaches, round what it is near): its open cells on
 * the main ground, the nearest by the walk; null when it has none. */
export function placeGoal( grid: Grid, place: { near(): number[]; reaches( k: number ): boolean } ): Goal | null {

	const cells = place.near().filter( ( k ) => grid.region[ k ] === grid.main && place.reaches( k ) );
	if ( cells.length === 0 ) return null;
	// no target point: the nearest cell by the walk (a search without a heuristic)
	return { cells, point: { x: 0, z: 0 }, slack: Infinity, exact: null };

}

/** True when a body can walk the straight segment from a to b on walkable cells. */
export function lineClear( grid: Grid, a: Vec2, b: Vec2 ): boolean {

	const dx = b.x - a.x, dz = b.z - a.z;
	const len = planar( dx, dz );
	if ( len < 1e-6 ) return grid.openAt( a.x, a.z );
	const steps = Math.ceil( len / 0.1 );
	const px = - dz / len * CLEARANCE, pz = dx / len * CLEARANCE;
	for ( let s = 0; s <= steps; s ++ ) {

		const t = s / steps;
		const x = a.x + dx * t, z = a.z + dz * t;
		if ( ! grid.openAt( x, z ) || ! grid.openAt( x + px, z + pz ) || ! grid.openAt( x - px, z - pz ) ) return false;

	}
	return true;

}

function heapPush( grid: Grid, size: number, k: number, f: number ): number {

	const idx = grid.heapIndex, cost = grid.heapCost;
	let n = size;
	idx[ n ] = k;
	cost[ n ] = f;
	while ( n > 0 ) {

		const p = ( n - 1 ) >> 1;
		if ( cost[ p ] <= cost[ n ] ) break;
		const ti = idx[ p ], tc = cost[ p ];
		idx[ p ] = idx[ n ]; cost[ p ] = cost[ n ];
		idx[ n ] = ti; cost[ n ] = tc;
		n = p;

	}
	return size + 1;

}

function heapPop( grid: Grid, size: number ): number {

	const idx = grid.heapIndex, cost = grid.heapCost;
	const top = idx[ 0 ];
	const last = size - 1;
	idx[ 0 ] = idx[ last ];
	cost[ 0 ] = cost[ last ];
	let n = 0;
	for ( ;; ) {

		const l = 2 * n + 1, r = l + 1;
		let m = n;
		if ( l < last && cost[ l ] < cost[ m ] ) m = l;
		if ( r < last && cost[ r ] < cost[ m ] ) m = r;
		if ( m === n ) break;
		const ti = idx[ m ], tc = cost[ m ];
		idx[ m ] = idx[ n ]; cost[ m ] = cost[ n ];
		idx[ n ] = ti; cost[ n ] = tc;
		n = m;

	}
	return top;

}

/**
 * Waypoints from `from` to the goal (the start excluded), or null when no walkable route exists.
 * An empty list means the body already stands where it needs to.
 */
export function findPath( grid: Grid, from: Vec2, goal: Goal ): Vec2[] | null {

	const cols = grid.cols;
	let start = grid.indexAt( from.x, from.z );
	const lead: Vec2[] = [];
	if ( start < 0 || ! grid.open[ start ] ) {

		// standing on a blocked cell (placed there by hand, or a game from before the ground changed):
		// step out to the nearest open one, onto the main ground rather than a pocket by the rim if it can
		const k = start < 0 ? grid.indexAt( Math.min( Math.max( from.x, grid.x0 ), grid.x0 + cols * grid.size - 1e-6 ), Math.min( Math.max( from.z, grid.z0 ), grid.z0 + grid.rows * grid.size - 1e-6 ) ) : start;
		start = grid.nearestOpen( k, 24, grid.main );
		if ( start < 0 ) start = grid.nearestOpen( k );
		if ( start < 0 ) return null;
		lead.push( grid.centreOf( start ) );

	}
	const gen = ++ grid.generation;
	for ( const k of goal.cells ) grid.goal[ k ] = gen;
	if ( grid.goal[ start ] === gen ) {

		const out = lead;
		if ( goal.exact && distance( lead.length ? lead[ 0 ] : from, goal.exact ) > 0.02 ) out.push( { x: goal.exact.x, z: goal.exact.z } );
		return out;

	}
	const h = ( k: number ) => Math.max( 0, planar( grid.centreX( k ) - goal.point.x, grid.centreZ( k ) - goal.point.z ) - goal.slack );
	const { g, parent, seen, closed, open } = grid;
	g[ start ] = 0;
	parent[ start ] = - 1;
	seen[ start ] = gen;
	let size = heapPush( grid, 0, start, h( start ) );
	let found = - 1;
	while ( size > 0 ) {

		const k = heapPop( grid, size );
		size --;
		if ( closed[ k ] === gen ) continue;
		closed[ k ] = gen;
		if ( grid.goal[ k ] === gen ) {

			found = k;
			break;

		}
		const i = k % cols, j = ( k - i ) / cols;
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

			if ( di === 0 && dj === 0 ) continue;
			const ni = i + di, nj = j + dj;
			if ( ! grid.inBounds( ni, nj ) ) continue;
			const n = k + dj * cols + di;
			if ( ! open[ n ] || closed[ n ] === gen ) continue;
			// no corner cutting: a diagonal step needs both side cells open
			if ( di !== 0 && dj !== 0 && ( ! open[ k + di ] || ! open[ k + dj * cols ] ) ) continue;
			const ng = g[ k ] + ( di !== 0 && dj !== 0 ? SQRT2 : 1 ) * grid.size;
			if ( seen[ n ] === gen && ng >= g[ n ] ) continue;
			seen[ n ] = gen;
			g[ n ] = ng;
			parent[ n ] = k;
			size = heapPush( grid, size, n, ng + h( n ) );

		}

	}
	if ( found < 0 ) return null;
	const cells: number[] = [];
	for ( let k = found; k >= 0; k = parent[ k ] ) cells.push( k );
	cells.reverse();
	const points = cells.map( ( k ) => grid.centreOf( k ) );
	if ( goal.exact ) points.push( { x: goal.exact.x, z: goal.exact.z } );
	return lead.concat( pull( grid, lead.length ? lead[ 0 ] : from, points ) );

}

// string pulling: from each anchor, run on to the farthest point still in a clear line
function pull( grid: Grid, from: Vec2, points: Vec2[] ): Vec2[] {

	const out: Vec2[] = [];
	let anchor = from;
	let i = 0;
	while ( i < points.length ) {

		let j = i;
		while ( j + 1 < points.length && lineClear( grid, anchor, points[ j + 1 ] ) ) j ++;
		if ( distance( anchor, points[ j ] ) > 1e-6 ) out.push( points[ j ] );
		anchor = points[ j ];
		i = j + 1;

	}
	return out;

}
