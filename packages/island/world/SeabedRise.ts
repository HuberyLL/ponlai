import * as THREE from 'three/webgpu';
import { fromTile, BED_CELL, FLOOR_CELL } from './ChunkMerge.ts';
import { OPEN_LATTICE } from './Bathymetry.ts';
import { pendingFloors, riseTile, mix, FAR_HALF, SEABED_TILE, TILE_SIDE, type PendingFloor } from './SeabedTile.ts';
import type { ChunkData } from './Chunks.ts';
import type { Square, WorldFields } from './WorldFields.ts';
import type { RefractedSun } from '../../render/index.ts';

// The shoal: the sea floor under the next piece rises toward its grown form as the piece
// nears, so the coming land shows as a shallow before it is swapped in. Only the floor's near tiles
// move; the stones, the contact shade and every other kind change at the swap (Growth.ts), as
// before. There is no rise of the land itself: the swap stays instant.
//
// - The tiles: once the next version is generated, each shown tile whose chunk changed and whose
//   floor differs from the next version's (the next tile, or `floorUnder` where the new land covers
//   the cell) becomes a pending tile (`plan`, a tile a step in Growth's preparation). The cells the
//   next version adds a tile on (cells the new land brings within reach), drawn by the far floor
//   until the swap, rise with the far floor's nodes on them; a pending tile's side along one rises
//   to the straight line between those nodes, so the floor never parts (SeabedTile.ts).
// - R (0 .. 1) eases toward its target with a time constant of TAU s of scene time, and holds while
//   the clock is paused. The target is 0 until the pending tiles are installed, then the approach
//   (`approach`, 0 .. 1: the progress toward the next piece, which the game or the GUI's Approach
//   slider sets). `snap` puts R on its target at once, as soon as the tiles are installed: the URL's
//   `approach` option at load and a scene jump (app/Scene.ts `establishScene`) take it, so a paused
//   frame repeats whatever path led to it.
// - Whenever the shown R has moved by STEP_M of the largest rise since the last write (or reached
//   its target), the pending tiles are written at it: their heights, normals (mixed, normalised)
//   and beds on the CPU into the merged floor's attributes, uploaded by update ranges over the rows
//   that move (static usage: DynamicDrawUsage would upload the whole floor at every draw), and the
//   floor's height and beds fields over their squares (WorldFields `writeSquares`, copies on the
//   GPU); the far floor's nodes likewise, by update ranges over their runs (the fields there are
//   left: those cells may lie outside them until the swap). The refracted sun's map is
//   drawn again (its proxies of the floor draw the merged geometry itself). A write is split into
//   steps of a part of a tile each, run within BUDGET ms of a frame (about 1 ms in all, over two
//   frames), and the floor uploaded once whole, so no frame shows tiles at two heights (its fields
//   follow within a frame); a snap writes at once.
// - R = 0 is the shown floor and R = 1 the next version's, bit for bit (`mix`; SeabedTile.ts), but
//   for the straightened sides and the added cells between the nodes, which take the next tile's
//   detail at the swap. No shader changes, no pipeline: the same draws read other values.
// - At the swap the committed tiles replace the pending ones and R and the approach start again at
//   0 (`clear`): the new geometry is the next version's, and the field squares the swap does not
//   write (their texels the same in both versions) are written back to the shown ones.

/** The time constant of R's easing (s of scene time). */
const TAU = 4;
/** R is written again once it has moved this far, in metres of the largest rise. */
const STEP_M = 0.02;
/** A write's share of a frame (ms): it goes on in the next frame past this. */
const BUDGET = 0.6;

interface FieldSquare { i0: number; j0: number; side: number; from: Float32Array; to: Float32Array }

/** A pending tile (SeabedTile.ts PendingFloor) and its squares of the height and beds fields. */
export interface PendingTile extends PendingFloor {
	floor: FieldSquare; beds: FieldSquare;
}

/** The far floor's nodes on the added cells: their vertices in the merged floor, their height,
 * normal and beds now and in the next version (6 per node), and the runs of consecutive vertices
 * ( first, count ) the uploads cover. */
interface FarNodes { index: Uint32Array; from: Float32Array; to: Float32Array; runs: [ number, number ][] }

/** What a growth step moves of the shown floor. */
export interface Pending { tiles: PendingTile[]; far: FarNodes; rise: number }

export class SeabedRise {

	/** approach: the progress toward the next piece (0 .. 1); target: R's; r: R shown; written: R last
	 * written; tiles: pending tiles; nodes: the far floor's nodes that move; rise: the largest rise
	 * (m); writes: writes uploaded; ms: the
	 * last write's main-thread time; frameMs: the most a frame's update took since the tiles were
	 * installed (a snap's write not included). */
	readonly state = { approach: 0, target: 0, r: 0, written: 0, tiles: 0, nodes: 0, rise: 0, writes: 0, ms: 0, frameMs: 0 };
	private pending: Pending | null = null;
	private writing: Generator<void, void> | null = null;
	private writeMs = 0;
	private snapping = false;
	private waiters: ( () => void )[] = [];
	// the staging buffers of the last write, destroyed at the next (its copies have run by then)
	private staging: ( () => void )[] = [];

	constructor( private readonly mesh: THREE.Mesh, private readonly fields: WorldFields, private readonly refractedSun: RefractedSun,
		private readonly renderer: THREE.WebGPURenderer, private readonly onWrite: () => void ) {}

	/**
	 * What a growth step moves (SeabedTile.ts `pendingFloors`), a tile a step: from the shown
	 * version's chunks (in their order: the merged floor's), the next version's (a chunk equal to the
	 * shown one is the same object), the fields shown and the merged floor shown; each tile with its
	 * squares of the height and beds fields.
	 */
	static * plan( shown: readonly ChunkData[], next: readonly ChunkData[], fields: WorldFields, geometry: THREE.BufferGeometry ): Generator<void, Pending> {

		const moved = yield* pendingFloors( shown, next );
		const tiles: PendingTile[] = [];
		for ( const t of moved.tiles ) {

			const square = ( name: 'floor' | 'beds', cell: number, channels: number, values: Float32Array ): FieldSquare => {

				const shownSquare = fields.tileSquare( name, t.ci, t.cj ), side = shownSquare.side;
				const to = new Float32Array( side * side * channels );
				fromTile( to, side, values, channels, cell, 0, 0 );
				return { i0: shownSquare.i0, j0: shownSquare.j0, side, from: shownSquare.texels, to };

			};
			tiles.push( { ...t, floor: square( 'floor', FLOOR_CELL, 1, t.to.height ), beds: square( 'beds', BED_CELL, 2, t.to.bed ) } );
			yield;

		}
		// the far floor's nodes, after the tiles in the merged floor (SeabedTile.ts buildFarFloor)
		const first = shown.filter( ( c ) => c.floor ).length * TILE_SIDE * TILE_SIDE, side = 2 * FAR_HALF / OPEN_LATTICE + 1;
		const nodes = moved.nodes.map( ( node ) => ( { node, v: first + ( node.z + FAR_HALF ) / OPEN_LATTICE * side + ( node.x + FAR_HALF ) / OPEN_LATTICE } ) ).sort( ( a, b ) => a.v - b.v );
		const position = geometry.getAttribute( 'position' ).array as Float32Array, normal = geometry.getAttribute( 'normal' ).array as Float32Array, bed = geometry.getAttribute( 'bed' ).array as Float32Array;
		const far: FarNodes = { index: new Uint32Array( nodes.length ), from: new Float32Array( nodes.length * 6 ), to: new Float32Array( nodes.length * 6 ), runs: [] };
		let rise = tiles.reduce( ( m, t ) => Math.max( m, t.rise ), 0 );
		nodes.forEach( ( { node, v }, k ) => {

			far.index[ k ] = v;
			far.from.set( [ position[ v * 3 + 1 ], normal[ v * 3 ], normal[ v * 3 + 1 ], normal[ v * 3 + 2 ], bed[ v * 2 ], bed[ v * 2 + 1 ] ], k * 6 );
			far.to.set( [ node.height, ...node.normal, ...node.bed ], k * 6 );
			rise = Math.max( rise, Math.abs( node.height - position[ v * 3 + 1 ] ) );
			const run = far.runs[ far.runs.length - 1 ];
			if ( run && run[ 0 ] + run[ 1 ] === v ) run[ 1 ] ++;
			else far.runs.push( [ v, 1 ] );

		} );
		return { tiles, far, rise };

	}

	/** What the next piece moves is ready: R's target is the approach from now on. */
	install( pending: Pending ): void {

		this.pending = pending;
		this.state.tiles = pending.tiles.length;
		this.state.nodes = pending.far.index.length;
		this.state.rise = pending.rise;
		this.state.target = this.state.approach;
		this.state.frameMs = 0;
		if ( this.snapping ) this.snapNow();

	}

	/** Sets the approach (0 .. 1); R eases toward it. */
	approach( p: number ): void {

		this.state.approach = Math.min( 1, Math.max( 0, p ) );
		if ( this.pending ) this.state.target = this.state.approach;

	}

	/** Sets the approach and puts R on it at once, as soon as the pending tiles are installed: resolves
	 * once it is written (at once when there are none to wait for: `waits` false). */
	snap( p: number, waits: boolean ): Promise<void> {

		this.approach( p );
		const done = new Promise<void>( ( resolve ) => this.waiters.push( resolve ) );
		this.snapping = true;
		if ( this.pending ) this.snapNow();
		else if ( ! waits ) this.release();
		return done;

	}

	/** The next piece will not come (its generation failed): a snap waiting for its tiles resolves
	 * now and leaves the floor where it is, so a scene jump that waits for it ends (app/Scene.ts
	 * `establishScene` draws no frame until it has). */
	abandon(): void {

		this.snapping = false;
		this.release();

	}

	private snapNow(): void {

		this.snapping = false;
		this.writing = null;
		this.state.r = this.state.target;
		if ( this.state.r !== this.state.written ) this.drain( this.write( this.state.r ) );
		this.release();

	}

	private release(): void {

		for ( const resolve of this.waiters.splice( 0 ) ) resolve();

	}

	/** Once a frame: R eased over `dt` s of scene time, and a write begun or continued. */
	update( dt: number ): void {

		const s = this.state;
		if ( ! this.pending || s.rise === 0 ) return;
		if ( dt > 0 && s.r !== s.target ) {

			s.r += ( s.target - s.r ) * ( 1 - Math.exp( - dt / TAU ) );
			if ( Math.abs( s.target - s.r ) * s.rise < STEP_M / 4 ) s.r = s.target;

		}
		if ( ! this.writing && ( Math.abs( s.r - s.written ) * s.rise >= STEP_M || ( s.r === s.target && s.r !== s.written ) ) ) {

			this.writeMs = 0;
			this.writing = this.write( s.r );

		}
		if ( this.writing ) {

			// eslint-disable-next-line ponlai/scene-clock -- the time budget of a frame's writes: how many it makes, not their result
			const t = performance.now(), until = t + BUDGET;
			// eslint-disable-next-line ponlai/scene-clock -- the time budget of a frame's writes: how many it makes, not their result
			while ( performance.now() < until ) if ( this.writing.next().done ) { this.writing = null; break; }
			// eslint-disable-next-line ponlai/scene-clock -- the writes' time, a readout
			const ms = performance.now() - t;
			this.writeMs += ms;
			s.frameMs = Math.max( s.frameMs, + ms.toFixed( 3 ) );
			if ( ! this.writing ) s.ms = + this.writeMs.toFixed( 3 );

		}

	}

	private drain( steps: Generator<void, void> ): void {

		// eslint-disable-next-line ponlai/scene-clock -- the writes' time, a readout
		const t = performance.now();
		while ( ! steps.next().done );
		// eslint-disable-next-line ponlai/scene-clock -- the writes' time, a readout
		this.state.ms = + ( performance.now() - t ).toFixed( 3 );

	}

	// The pending tiles and nodes at R = r, a tile a step, uploaded once all are written.
	private * write( r: number ): Generator<void, void> {

		const { tiles, far } = this.pending!, geometry = this.mesh.geometry;
		const position = geometry.getAttribute( 'position' ) as THREE.BufferAttribute;
		const normal = geometry.getAttribute( 'normal' ) as THREE.BufferAttribute;
		const bed = geometry.getAttribute( 'bed' ) as THREE.BufferAttribute;
		const floors: Square[] = [], beds: Square[] = [];
		for ( const t of tiles ) {

			riseTile( t.from, t.to, r, position.array as Float32Array, normal.array as Float32Array, bed.array as Float32Array, t.v0 );
			yield;
			floors.push( [ t.floor.i0, t.floor.j0, mixSquare( t.floor, r, false ) ] );
			yield;
			beds.push( [ t.beds.i0, t.beds.j0, mixSquare( t.beds, r, true ) ] );
			yield;

		}
		for ( let k = 0; k < far.index.length; k ++ ) {

			const v = far.index[ k ], at = ( c: number ) => mix( far.from[ k * 6 + c ], far.to[ k * 6 + c ], r );
			const p = position.array as Float32Array, nm = normal.array as Float32Array, b = bed.array as Float32Array;
			p[ v * 3 + 1 ] = at( 0 );
			const nx = at( 1 ), ny = at( 2 ), nz = at( 3 ), l = r === 0 || r === 1 ? 1 : Math.hypot( nx, ny, nz );
			nm[ v * 3 ] = nx / l; nm[ v * 3 + 1 ] = ny / l; nm[ v * 3 + 2 ] = nz / l;
			b[ v * 2 ] = at( 4 ); b[ v * 2 + 1 ] = at( 5 );

		}
		yield;
		const n = TILE_SIDE;
		for ( const attribute of [ position, normal, bed ] ) {

			const size = attribute.itemSize;
			for ( const t of tiles ) attribute.addUpdateRange( ( t.v0 + t.row0 * n ) * size, ( t.row1 - t.row0 ) * n * size );
			for ( const [ first, count ] of far.runs ) attribute.addUpdateRange( first * size, count * size );
			attribute.needsUpdate = true;

		}
		for ( const dispose of this.staging.splice( 0 ) ) dispose();
		for ( const [ key, squares ] of [ [ 'floor', floors ], [ 'beds', beds ] ] as const ) {

			yield;
			const dispose = this.fields.writeSquares( key, squares, SEABED_TILE / ( key === 'floor' ? FLOOR_CELL : BED_CELL ), this.renderer );
			if ( dispose ) this.staging.push( dispose );

		}
		this.refractedSun.invalidate();
		this.state.written = r;
		this.state.writes ++;
		this.onWrite();

	}

	/**
	 * The swap (Growth.ts, before the fields take the next version's squares): the pending tiles are
	 * gone with the geometry they moved; the field squares the swap leaves as they are (`kept`: per
	 * field, whether its texture is kept, and the origins of the squares it writes) are written back
	 * to the shown texels, which are the next version's there. R and the approach start again at 0.
	 */
	clear( kept: { floor: Set<string> | null; beds: Set<string> | null } ): void {

		const tiles = this.pending?.tiles;
		this.writing = null;
		if ( tiles && this.state.written !== 0 ) {

			for ( const [ key, keep ] of [ [ 'floor', kept.floor ], [ 'beds', kept.beds ] ] as const ) {

				if ( ! keep ) continue;
				const squares: Square[] = [];
				for ( const t of tiles ) {

					const f = t[ key ];
					if ( ! keep.has( `${ f.i0 },${ f.j0 }` ) ) squares.push( [ f.i0, f.j0, mixSquare( f, 0, key === 'beds' ) ] );

				}
				const dispose = this.fields.writeSquares( key, squares, SEABED_TILE / ( key === 'floor' ? FLOOR_CELL : BED_CELL ), this.renderer );
				if ( dispose ) this.staging.push( dispose );

			}

		}
		this.pending = null;
		Object.assign( this.state, { approach: 0, target: 0, r: 0, written: 0, tiles: 0, nodes: 0, rise: 0 } );

	}

}

// A field square at R = r, as floats or (`half`) half floats.
function mixSquare( f: FieldSquare, r: number, half: boolean ): Float32Array | Uint16Array {

	const out = half ? new Uint16Array( f.from.length ) : new Float32Array( f.from.length );
	for ( let k = 0; k < f.from.length; k ++ ) {

		const v = mix( f.from[ k ], f.to[ k ], r );
		out[ k ] = half ? THREE.DataUtils.toHalfFloat( v ) : v;

	}
	return out;

}
