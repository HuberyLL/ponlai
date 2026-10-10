import { buildFootprint, islandSurfaceHeight, layoutBounds } from '../../world/WorldShapes.ts';
import type { Cell, GridApi, IslandInput, Vec2 } from './types.ts';

// The ground grid: 0.5 m cells over the layout's bounds. A cell is walkable on the island top,
// clear of the cliff rim, and free of bushes, shrubs and trees. Everything here is derived: the
// island from the world's own functions, its bushes and plants from the world generator's input,
// so a loaded game rebuilds the same grid.

const CELL = 0.5;
/** keep this far inside the island's edge (m), so feet never hang over the rim */
const RIM_MARGIN = 0.9;
/** a bush or a plant blocks the cells within this fraction of its radius (and the cell under its centre) */
const BLOCK_FRACTION = 0.6;

// the island's top depends on the layout alone: computed once (the footprint takes a while, a
// distance transform)
let islandTop: Uint8Array | null = null;

function islandMask( cols: number, rows: number, x0: number, z0: number ): Uint8Array {

	if ( islandTop ) return islandTop;
	const fp = buildFootprint();
	const base = new Uint8Array( cols * rows );
	for ( let j = 0; j < rows; j ++ ) for ( let i = 0; i < cols; i ++ ) base[ j * cols + i ] = fp.dist( x0 + ( i + 0.5 ) * CELL, z0 + ( j + 0.5 ) * CELL ) < - RIM_MARGIN ? 1 : 0;
	return islandTop = base;

}

export class Grid implements GridApi {

	readonly size = CELL;
	readonly cols: number;
	readonly rows: number;
	readonly x0: number;
	readonly z0: number;
	/** 1 where walkable: on the island top, clear of the rim, no bush or plant */
	readonly open: Uint8Array;
	/** connected walkable regions: a label per open cell, -1 elsewhere */
	readonly region: Int32Array;
	/** the largest region: the island's open ground, where the islanders live */
	readonly main: number;

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

		// the layout's bounds in CELL steps
		const b = layoutBounds();
		this.x0 = b.x0;
		this.z0 = b.z0;
		this.cols = Math.round( ( b.x1 - b.x0 ) / CELL );
		this.rows = Math.round( ( b.z1 - b.z0 ) / CELL );
		const n = this.cols * this.rows;
		this.open = islandMask( this.cols, this.rows, this.x0, this.z0 ).slice();
		for ( const o of [ ...input.bushes, ...input.plants ] ) this.block( o.x, o.z, o.r * BLOCK_FRACTION );
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

				const d = Math.hypot( this.centreX( c ) - cx, this.centreZ( c ) - cz );
				if ( best < 0 || d < Math.hypot( this.centreX( best ) - cx, this.centreZ( best ) - cz ) ) best = c;
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

	private block( x: number, z: number, r: number ): void {

		const k = this.indexAt( x, z );
		if ( k >= 0 ) this.open[ k ] = 0;
		const i0 = Math.floor( ( x - r - this.x0 ) / CELL ), i1 = Math.floor( ( x + r - this.x0 ) / CELL );
		const j0 = Math.floor( ( z - r - this.z0 ) / CELL ), j1 = Math.floor( ( z + r - this.z0 ) / CELL );
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			if ( ! this.inBounds( i, j ) ) continue;
			const cx = this.x0 + ( i + 0.5 ) * CELL, cz = this.z0 + ( j + 0.5 ) * CELL;
			if ( Math.hypot( cx - x, cz - z ) <= r ) this.open[ j * this.cols + i ] = 0;

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
