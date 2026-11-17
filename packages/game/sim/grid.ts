import { buildFootprint, islandSurfaceHeight, GROWTH, type LandLattice } from '../../island/land.ts';
import { planar } from './maths.ts';
import type { Cell, GridApi, IslandInput, Vec2 } from './types.ts';

// The ground grid: 0.5 m world-anchored cells over the land, walkable on the island top.
//
// The ground grid: 0.5 m cells over the land lattice's whole extent, anchored to the world, so a
// grown island only opens cells and every index stays valid. A cell is walkable on the island top,
// clear of the cliff rim. Everything here is derived: the island from the world's own functions on
// the land, so a loaded game rebuilds the same grid. The app gives the island's top from the world's chunks (their walk
// tiles, `topFromTiles`, the same cells as the land's footprint 0.9 m inside its edge), so a grown
// island's grid (`setIsland`, Growth.ts and Sim.addPiece) is a fresh load's; without them (the node checks) it is
// found from the land. The game's own obstacles (the buildings) are added on top by
// `obstruct`, from the simulation's state.

const CELL = 0.5;
const SIDE = Math.round( 2 * GROWTH.half / CELL );
/** keep this far inside the island's edge (m), so feet never hang over the rim */
const RIM_MARGIN = 0.9;

// the island's top depends on the land alone: computed once per land (the footprint takes a
// while, a distance transform)
let islandTop: { land: LandLattice; mask: Uint8Array } | null = null;

function islandMask( land: LandLattice ): Uint8Array {

	if ( islandTop?.land === land ) return islandTop.mask;
	const fp = buildFootprint( land );
	const mask = new Uint8Array( SIDE * SIDE );
	for ( let j = 0; j < SIDE; j ++ ) for ( let i = 0; i < SIDE; i ++ ) mask[ j * SIDE + i ] = fp.dist( - GROWTH.half + ( i + 0.5 ) * CELL, - GROWTH.half + ( j + 0.5 ) * CELL ) < - RIM_MARGIN ? 1 : 0;
	islandTop = { land, mask };
	return mask;

}

/** The island's top clear of the rim for an island (a byte per ground cell): its own `top`, else
 * found from its land. */
export function topOf( input: IslandInput ): Uint8Array {

	return input.top ?? islandMask( input.land );

}

/** The island's top clear of the rim from the world's chunks' walk tiles (Chunks.ts: 32 x 32 cells
 * of 0.5 m per 16 m chunk, on this grid's lattice), as the app has them: a grown island's grid
 * comes from the same tiles as a fresh load's (Growth.ts). */
export function topFromTiles( tiles: readonly { ci: number; cj: number; walk: Uint8Array }[] ): Uint8Array {

	const top = new Uint8Array( SIDE * SIDE ), n = Math.round( Math.sqrt( tiles[ 0 ]?.walk.length ?? 0 ) );
	for ( const { ci, cj, walk } of tiles ) {

		const i0 = Math.round( ( ci * n * CELL + GROWTH.half ) / CELL ), j0 = Math.round( ( cj * n * CELL + GROWTH.half ) / CELL );
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const gi = i0 + i, gj = j0 + j;
			if ( gi >= 0 && gj >= 0 && gi < SIDE && gj < SIDE && walk[ j * n + i ] ) top[ gj * SIDE + gi ] = 1;

		}

	}
	return top;

}

export class Grid implements GridApi {

	readonly size = CELL;
	readonly cols: number;
	readonly rows: number;
	readonly x0: number;
	readonly z0: number;
	/** 1 on the island top, clear of the rim, whatever grows there (shared: never written) */
	top: Uint8Array;
	/** 1 where walkable: on the island top, clear of the rim, no building */
	readonly open: Uint8Array;
	/** connected walkable regions: a label per open cell, -1 elsewhere */
	readonly region: Int32Array;
	/** the largest region: the island's open ground, where the islanders live */
	main: number;

	// scratch for searches (path.ts), stamped by generation so nothing needs clearing
	readonly g: Float64Array;
	readonly parent: Int32Array;
	readonly seen: Uint32Array;
	readonly closed: Uint32Array;
	readonly goal: Uint32Array;
	readonly heapIndex: Int32Array;
	readonly heapCost: Float64Array;
	readonly queue: Int32Array;
	generation = 0;

	constructor( input: IslandInput ) {

		this.x0 = this.z0 = - GROWTH.half;
		this.cols = this.rows = SIDE;
		const n = this.cols * this.rows;
		this.top = topOf( input );
		this.open = this.top.slice();
		this.region = new Int32Array( n );
		this.g = new Float64Array( n );
		this.parent = new Int32Array( n );
		this.seen = new Uint32Array( n );
		this.closed = new Uint32Array( n );
		this.goal = new Uint32Array( n );
		this.heapIndex = new Int32Array( n * 8 );
		this.heapCost = new Float64Array( n * 8 );
		this.queue = new Int32Array( n );
		this.main = this.label();

	}

	/** The ground of a grown island: its top again (the indices stay: the grid spans the
	 * land lattice, so a piece only opens cells). The game's own obstacles are added again by the
	 * caller (Sim.addPiece). */
	setIsland( input: IslandInput ): void {

		this.top = topOf( input );
		this.open.set( this.top );
		this.main = this.label();

	}

	// ------------------------------------------------------------------ GridApi

	cellAt( p: Vec2 ): Cell {

		return { i: Math.floor( ( p.x - this.x0 ) / CELL ), j: Math.floor( ( p.z - this.z0 ) / CELL ) };

	}

	centre( c: Cell ): Vec2 {

		return { x: this.x0 + ( c.i + 0.5 ) * CELL, z: this.z0 + ( c.j + 0.5 ) * CELL };

	}

	walkable( c: Cell ): boolean {

		return this.inBounds( c.i, c.j ) && this.open[ c.j * this.cols + c.i ] === 1;

	}

	height( x: number, z: number ): number {

		return islandSurfaceHeight( x, z );

	}

	// ------------------------------------------------------------------ indices

	inBounds( i: number, j: number ): boolean {

		return i >= 0 && j >= 0 && i < this.cols && j < this.rows;

	}

	/** cell index under a world position, or -1 off the grid */
	indexAt( x: number, z: number ): number {

		const i = Math.floor( ( x - this.x0 ) / CELL ), j = Math.floor( ( z - this.z0 ) / CELL );
		return this.inBounds( i, j ) ? j * this.cols + i : - 1;

	}

	openAt( x: number, z: number ): boolean {

		const k = this.indexAt( x, z );
		return k >= 0 && this.open[ k ] === 1;

	}

	centreX( k: number ): number {

		return this.x0 + ( k % this.cols + 0.5 ) * CELL;

	}

	centreZ( k: number ): number {

		return this.z0 + ( Math.floor( k / this.cols ) + 0.5 ) * CELL;

	}

	centreOf( k: number ): Vec2 {

		return { x: this.centreX( k ), z: this.centreZ( k ) };

	}

	/**
	 * The walkable cell nearest to cell k by grid steps (k itself if open), or -1 within maxSteps;
	 * with a region, the nearest walkable cell of that region.
	 */
	nearestOpen( k: number, maxSteps = 24, region = - 1 ): number {

		if ( k < 0 ) return - 1;
		const fits = ( c: number ) => this.open[ c ] === 1 && ( region < 0 || this.region[ c ] === region );
		if ( fits( k ) ) return k;
		const gen = ++ this.generation;
		const q = this.queue, cols = this.cols;
		let head = 0, tail = 0;
		q[ tail ++ ] = k;
		this.seen[ k ] = gen;
		this.g[ k ] = 0;
		let best = - 1, bestD = Infinity;
		const cx = this.centreX( k ), cz = this.centreZ( k );
		while ( head < tail ) {

			const c = q[ head ++ ];
			if ( this.g[ c ] > maxSteps ) break;
			// finish the ring the first open cell was found on, then keep the closest
			if ( best >= 0 && this.g[ c ] > bestD ) break;
			if ( fits( c ) ) {

				const d = planar( this.centreX( c ) - cx, this.centreZ( c ) - cz );
				if ( best < 0 || d < planar( this.centreX( best ) - cx, this.centreZ( best ) - cz ) ) best = c;
				bestD = this.g[ c ];
				continue;

			}
			const i = c % cols, j = ( c - i ) / cols;
			for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

				if ( ( di === 0 && dj === 0 ) || ! this.inBounds( i + di, j + dj ) ) continue;
				const n = c + dj * cols + di;
				if ( this.seen[ n ] === gen ) continue;
				this.seen[ n ] = gen;
				this.g[ n ] = this.g[ c ] + 1;
				q[ tail ++ ] = n;

			}

		}
		return best;

	}

	// ------------------------------------------------------------------ blocking

	/** Block the cells within r of a point (and the one under it), then label the regions again. */
	obstruct( x: number, z: number, r: number ): void {

		this.block( x, z, r );
		this.main = this.label();

	}

	private block( x: number, z: number, r: number ): void {

		const k = this.indexAt( x, z );
		if ( k >= 0 ) this.open[ k ] = 0;
		const i0 = Math.floor( ( x - r - this.x0 ) / CELL ), i1 = Math.floor( ( x + r - this.x0 ) / CELL );
		const j0 = Math.floor( ( z - r - this.z0 ) / CELL ), j1 = Math.floor( ( z + r - this.z0 ) / CELL );
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			if ( ! this.inBounds( i, j ) ) continue;
			const cx = this.x0 + ( i + 0.5 ) * CELL, cz = this.z0 + ( j + 0.5 ) * CELL;
			if ( planar( cx - x, cz - z ) <= r ) this.open[ j * this.cols + i ] = 0;

		}

	}

	/**
	 * Label the connected areas of the open cells into `region` (-1 elsewhere) and return
	 * the largest one's label (-1 if none). A 4-connected flood fill: a diagonal step needs both
	 * side cells open (no corner cutting), so 8-way movement connects exactly what 4-way
	 * connectivity does.
	 */
	private label(): number {

		const { cols, rows, queue: q, open, region } = this;
		region.fill( - 1 );
		let label = 0, largest = - 1, largestSize = 0;
		for ( let s = 0; s < open.length; s ++ ) {

			if ( ! open[ s ] || region[ s ] >= 0 ) continue;
			let head = 0, tail = 0;
			q[ tail ++ ] = s;
			region[ s ] = label;
			while ( head < tail ) {

				const c = q[ head ++ ];
				const i = c % cols, j = ( c - i ) / cols;
				if ( i > 0 && open[ c - 1 ] && region[ c - 1 ] < 0 ) { region[ c - 1 ] = label; q[ tail ++ ] = c - 1; }
				if ( i < cols - 1 && open[ c + 1 ] && region[ c + 1 ] < 0 ) { region[ c + 1 ] = label; q[ tail ++ ] = c + 1; }
				if ( j > 0 && open[ c - cols ] && region[ c - cols ] < 0 ) { region[ c - cols ] = label; q[ tail ++ ] = c - cols; }
				if ( j < rows - 1 && open[ c + cols ] && region[ c + cols ] < 0 ) { region[ c + cols ] = label; q[ tail ++ ] = c + cols; }

			}
			if ( tail > largestSize ) {

				largest = label;
				largestSize = tail;

			}
			label ++;

		}
		return largest;

	}

}
