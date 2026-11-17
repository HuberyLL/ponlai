// The world's worker: each job builds one chunk from the land's window round it, or the land.
//
// The world's worker: WorldChunks.ts runs a pool of these, and each job
// is one chunk, built from the land field's window round it (Chunks.ts `buildChunk`), or the land
// itself. Any worker can run any job; a job's result depends only on what it names (the chunk, the
// land version, the options) and the land the main thread gave this worker, never on the jobs before it.
//
// - `land`: the grown land of a seed and step (IslandGrowth.ts), with what the main thread needs before
//   any chunk arrives (ChunkMerge.ts `LandData`: the chunks, the steps each chunk's cache key
//   names, the far floor, the floor's fields over the fields' bounds, the walking loop). Cached
//   under its own key.
// - `field`: the land field of a land version (Chunks.ts `landField`, the costliest part of the
//   land: a few tenths of a second), once per version, and only when the land or a chunk was not
//   in the cache.
//   The worker keeps it, and its reply carries a copy for every other worker, which the main thread hands
//   on (`use`); each cuts the chunks' windows from its own.
// - `chunk`: the chunk from the cache when it holds it, else built (when the worker has the field,
//   once the island's simplifier is ready: IslandSimplify.ts) and stored; without the field the worker answers `need` and the main thread sends the job again once
//   it has the field. The cache (WorldCache.ts) is read and written here, off the main thread.
// - `keep`: after a load, the keys of every record of its land version (the land's first): the
//   cache keeps them and the version loaded before, and deletes the rest (WorldCache.ts `keep`).
// - `close`: closes the worker once every write has reached the cache.
//
// `buildLand` is a plain function, so the node tools build the same land (tools/island/world-node.mjs).
//
// A reply transfers every buffer under it (`post`), which detaches them here: a reply never holds a
// view of a module-level or cached array (a table, a lattice kept for the next job, the field), only
// what the job built or read from the cache for it.

import { buildChunk, landField, landWindow, windowCells, CellCount, S, type ChunkData, type LandField } from './Chunks.ts';
import { simplifierReady } from './IslandSimplify.ts';
import { growLand, LandLattice, type Piece } from './IslandGrowth.ts';
import { buildFarFloor, nearLandCells, underLand } from './SeabedTile.ts';
import { openSeaBeds, openSeaHeight, SHELF_CEILING } from './Bathymetry.ts';
import { fieldBounds, BED_CELL, FLOOR_CELL, type LandData } from './ChunkMerge.ts';
import { openChunkStore, type ChunkStore } from './WorldCache.ts';
import { walkLoop } from './WalkLoop.ts';

/** The land of `seed` after `step` growth steps, and what the main thread needs of it before its chunks. */
export function buildLand( seed: number, step: number ): LandData {

	const { land, pieces } = growLand( seed, step );
	const near = nearLandCells( land );
	const chunks = new Int32Array( near.flat() );
	const steps = windowSteps( pieces, near );
	const bounds = fieldBounds( land );
	const w = bounds.x1 - bounds.x0, h = bounds.z1 - bounds.z0;
	const fx = w / FLOOR_CELL, fz = h / FLOOR_CELL, bx = w / BED_CELL, bz = h / BED_CELL;
	const floor = new Float32Array( fx * fz ), beds = new Float32Array( bx * bz * 2 );
	for ( let j = 0; j < fz; j ++ ) for ( let i = 0; i < fx; i ++ ) {

		floor[ j * fx + i ] = openSeaHeight( bounds.x0 + ( i + 0.5 ) * FLOOR_CELL, bounds.z0 + ( j + 0.5 ) * FLOOR_CELL );

	}
	for ( let j = 0; j < bz; j ++ ) for ( let i = 0; i < bx; i ++ ) {

		const [ grass, pale ] = openSeaBeds( bounds.x0 + ( i + 0.5 ) * BED_CELL, bounds.z0 + ( j + 0.5 ) * BED_CELL );
		beds[ ( j * bx + i ) * 2 ] = grass; beds[ ( j * bx + i ) * 2 + 1 ] = pale;

	}
	// under the land: its floor lies inside the island's solid, never seen
	for ( const [ ci, cj ] of near ) {

		if ( ! underLand( land, ci, cj ) ) continue;
		const fi = ( ci * S - bounds.x0 ) / FLOOR_CELL, fj = ( cj * S - bounds.z0 ) / FLOOR_CELL, fn = S / FLOOR_CELL;
		for ( let j = 0; j < fn; j ++ ) floor.fill( SHELF_CEILING, ( fj + j ) * fx + fi, ( fj + j ) * fx + fi + fn );
		const bi = ( ci * S - bounds.x0 ) / BED_CELL, bj = ( cj * S - bounds.z0 ) / BED_CELL, bn = S / BED_CELL;
		for ( let j = 0; j < bn; j ++ ) for ( let i = 0; i < bn; i ++ ) {

			const k = ( ( bj + j ) * bx + bi + i ) * 2;
			beds[ k ] = 0; beds[ k + 1 ] = 1;

		}

	}
	return { seed, step, land: land.toBytes(), chunks, steps, far: buildFarFloor( near ), bounds, floor, beds, walk: new Float64Array( walkLoop( land ).flat() ) };

}

// Per chunk ( ci, cj ), the growth steps whose pieces hold a cell that Chunks.ts `dirtyChunks`
// would count for it (`windowCells`: grown by 2 m, meeting its window): the land a chunk reads is
// the union of those pieces' cells there, so with the seed they name it in the chunk's cache key.
// A piece's cells, not its box: a piece that grows past a chunk's corner leaves it reused.
function windowSteps( pieces: Piece[], near: [ number, number ][] ): number[][] {

	const cells = pieces.map( ( p ) => new CellCount( p.window, p.bits ) );
	return near.map( ( [ ci, cj ] ) => {

		const w = windowCells( ci, cj );
		return pieces.filter( ( _, k ) => cells[ k ].any( w ) ).map( ( p ) => p.step );

	} );

}

// ------------------------------------------------------------------ messages

export type ChunkJob =
	| { kind: 'init'; generator: string | null }
	| { kind: 'land'; seed: number; step: number; key: string | null }
	| { kind: 'field'; land: Uint8Array; copies: number }
	| { kind: 'use'; land: Uint8Array; field: LandField }
	| { kind: 'chunk'; ci: number; cj: number; version: number; key: string | null; contactOcclusion: boolean; canopyShadow: boolean }
	| { kind: 'keep'; keys: string[] }
	| { kind: 'close' };

// 'hit': read from the cache; 'miss': built and stored; 'error': built, the cache is unavailable;
// 'off': built without the cache
export type CacheResult = 'hit' | 'miss' | 'error' | 'off';

export type ChunkReply =
	| { kind: 'land'; data: LandData; cache: CacheResult }
	| { kind: 'field'; copies: LandField[] }
	| { kind: 'chunk'; data: ChunkData; cache: CacheResult; ms: number }
	| { kind: 'need'; ci: number; cj: number };

let store: Promise<ChunkStore | null> | null = null;
let land: LandLattice | null = null, field: LandField | null = null;
const writes = new Set<Promise<void>>();

// Every buffer under a value, once each, to transfer it.
function buffersOf( value: unknown, out = new Set<ArrayBufferLike>() ): ArrayBuffer[] {

	if ( ArrayBuffer.isView( value ) ) out.add( value.buffer );
	else if ( value && typeof value === 'object' ) for ( const v of Object.values( value ) ) buffersOf( v, out );
	return [ ...out ] as ArrayBuffer[];

}

function post( reply: ChunkReply ): void {

	self.postMessage( reply, { transfer: buffersOf( reply ) } );

}

// Holds a write to the cache until it lands, so `close` waits for it.
function track( write: Promise<void> ): void {

	writes.add( write );
	void write.then( () => writes.delete( write ) );

}

async function run( job: ChunkJob ): Promise<void> {

	switch ( job.kind ) {

		case 'init':
			store = job.generator !== null ? openChunkStore( job.generator ) : null;
			break;

		case 'land': {

			const cache = job.key !== null ? await store : null;
			const hit = cache ? await cache.read<LandData>( job.key! ) : undefined;
			if ( hit ) { post( { kind: 'land', data: hit, cache: 'hit' } ); break; }
			const data = buildLand( job.seed, job.step );
			if ( cache ) track( cache.write( job.key!, data ) );
			post( { kind: 'land', data, cache: cache ? 'miss' : job.key !== null ? 'error' : 'off' } );
			break;

		}

		case 'field': {

			// kept here, and copied for the other workers
			land = LandLattice.fromBytes( job.land );
			field = landField( land );
			const copies = Array.from( { length: job.copies }, () => ( { ...field!, data: field!.data.slice() } ) );
			post( { kind: 'field', copies } );
			break;

		}

		case 'use':
			land = LandLattice.fromBytes( job.land );
			field = job.field;
			break;

		case 'chunk': {

			// eslint-disable-next-line ponlai/scene-clock -- a chunk's build time, a readout
			const t = performance.now();
			const cache = job.key !== null ? await store : null;
			const hit = cache ? await cache.read<ChunkData>( job.key! ) : undefined;
			if ( hit ) {

				// the land version is not part of the content (Chunks.ts hashChunk)
				hit.land = job.version;
				// eslint-disable-next-line ponlai/scene-clock -- a chunk's build time, a readout
				post( { kind: 'chunk', data: hit, cache: 'hit', ms: performance.now() - t } );
				break;

			}
			if ( ! land || ! field ) { post( { kind: 'need', ci: job.ci, cj: job.cj } ); break; }
			await simplifierReady;
			const data = buildChunk( landWindow( field, job.ci, job.cj ), land, job.ci, job.cj, { version: job.version, contactOcclusion: job.contactOcclusion, canopyShadow: job.canopyShadow } );
			if ( cache ) track( cache.write( job.key!, data ) );
			// eslint-disable-next-line ponlai/scene-clock -- a chunk's build time, a readout
			post( { kind: 'chunk', data, cache: cache ? 'miss' : job.key !== null ? 'error' : 'off', ms: performance.now() - t } );
			break;

		}

		case 'keep': {

			const cache = await store;
			if ( cache ) track( cache.keep( job.keys ) );
			break;

		}

		case 'close':
			await Promise.all( writes );
			( await store )?.close();
			self.close();
			break;

	}

}

// Only in a worker: the node tools import this module for `buildLand`.
if ( 'WorkerGlobalScope' in globalThis ) {

	// one job at a time, in the order they came (a cache read awaits)
	let queue = Promise.resolve();
	self.onmessage = ( e: MessageEvent<ChunkJob> ) => {

		queue = queue.then( () => run( e.data ) ).catch( ( error: unknown ) => {

			// an uncaught error reaches the main thread's worker.onerror; a rejected promise would not
			setTimeout( () => { throw error; } );

		} );

	};

}
