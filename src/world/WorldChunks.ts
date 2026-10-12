// The page's world (chunk design, section 10): the land and its chunks generated on a pool of
// chunk workers (chunkWorker.ts), read from the per-chunk cache where it holds them
// (WorldCache.ts), and merged into one WorldData (ChunkMerge.ts) that the page draws (World.ts:
// the island a mesh per land chunk, every other kind merged).
//
// - The pool: min( 6, max( 1, hardwareConcurrency - 2 ) ) workers, leaving the page and the
//   compositor a core each (the single world worker's split also used up to six).
// - Order of work: the land first (one job: the grown land, the chunks it has, each chunk's cache
//   key, the far floor), then every chunk, nearest the camera's pivot first. A chunk job looks the
//   chunk up in the cache; the first one that misses asks for the land field (a few tenths of a
//   second, once per land version), which the page hands to every worker, and the chunks that
//   missed run again and are built. A land that missed the cache (a new land version: some chunk
//   will miss too) asks for the field at once, before any chunk's lookup has come back. A reload
//   that finds the land and every chunk never builds the field. A lookup of a key the cache did not
//   hold when the worker opened it misses without asking IndexedDB (WorldCache.ts), so a chunk run
//   again after the field never waits for the other workers' writes, and a cold load costs what
//   one with `worldCache=off` does.
//   (The field is cloned to every worker rather than each job sent its window: a window is 4 MB,
//   so a load would copy several times the field's bytes on the main thread.)
// - The merge runs once every chunk has arrived, in rows ( cj, then ci ), so the world is the same
//   whatever order the workers finish in, and the same as the node tools' serial path
//   (tools/world-node.mjs).
// - Cache keys: a format version, the generator's hash (tools/vite-world-generator.mjs: every
//   source the worker imports), the options, the browser, the chunk and the growth steps whose
//   pieces hold cells the chunk reads (chunkWorker.ts, by Chunks.ts `windowCells`), so a land
//   grown by a piece finds every chunk the dirty rule keeps. `worldCache=off` (main.ts) builds
//   every chunk and stores none.
// - Eviction: once every chunk has arrived, one worker gets a `keep` job with this load's keys (the
//   land's first), and the cache keeps only the records of this land version and the one loaded
//   before it (WorldCache.ts). A game's growth thus holds two versions on disk, not every one.

import { WORLD_GENERATOR_HASH } from 'virtual:world-generator';
import { mergeChunks, type LandData } from './ChunkMerge.ts';
import { landCentroid } from './WorldShapes.ts';
import { LandLattice } from './IslandGrowth.ts';
import type { ChunkData, LandField } from './Chunks.ts';
import type { ChunkJob, ChunkReply, CacheResult } from './chunkWorker.ts';
import type { WorldData, WorldOptions } from './types.ts';

// bumped whenever what a record holds changes without the generator's sources changing
const CACHE_FORMAT = 4;
// the chunk's side (m): Chunks.ts S
const CHUNK = 16;

export interface LoadedWorld {
	data: WorldData;
	// 'hit': the land and every chunk from the cache; 'partial': some of them; 'miss': none (all
	// generated and stored); 'error': generated, the cache is unavailable; 'off': without the cache
	cache: 'hit' | 'partial' | 'miss' | 'error' | 'off';
	// records read from the cache, of chunks + 1 (the land)
	hits: number;
	chunks: number;
	// from the request to the merged world
	ms: number;
}

export interface LoadOptions {
	cache?: boolean;
	// the point the camera turns round on this land (by default its centroid): the chunks nearest
	// it come first
	pivot?: ( land: LandLattice ) => { x: number; z: number };
	// called as chunks arrive
	progress?: ( done: number, total: number ) => void;
}

interface Slot { worker: Worker; job: ChunkJob[ 'kind' ] | null }
interface Pending { ci: number; cj: number; steps: number[]; distance: number }

/** The world of `options`' land, from its chunks. */
export function loadWorld( options: WorldOptions = {}, { cache = true, pivot, progress }: LoadOptions = {} ): Promise<LoadedWorld> {

	const t0 = performance.now();
	const { worldSeed = 1, step = 0, contactOcclusion = true } = options;
	const generator = cache ? WORLD_GENERATOR_HASH : null;
	const key = ( ...parts: unknown[] ) => generator === null ? null
		: JSON.stringify( [ CACHE_FORMAT, generator, { worldSeed, contactOcclusion }, navigator.userAgent, ...parts ] );
	const threads = Math.min( 6, Math.max( 1, ( navigator.hardwareConcurrency || 4 ) - 2 ) );

	return new Promise( ( resolve, reject ) => {

		const pool: Slot[] = [];
		let settled = false;
		let land: LandData | null = null, landCache: CacheResult = 'off', field: LandField | null = null, fieldAsked = false;
		// every chunk by its key; those not yet asked for, nearest first; those that missed the cache
		// before the field came
		const chunks = new Map<string, Pending>(), queue: Pending[] = [], needs: Pending[] = [];
		const done = new Map<string, ChunkData>();
		let hits = 0, built = 0, buildMs = 0;
		const marks: Record<string, number> = {};
		const mark = ( name: string ) => { marks[ name ] = Math.round( performance.now() - t0 ); };

		const fail = ( error: unknown ) => {

			if ( settled ) return;
			settled = true;
			for ( const slot of pool ) slot.worker.terminate();
			reject( error );

		};
		const send = ( slot: Slot, job: ChunkJob, transfer: Transferable[] = [] ) => {

			if ( job.kind !== 'use' ) slot.job = job.kind;
			slot.worker.postMessage( job, { transfer } );

		};
		// gives every idle worker its next job
		const pump = () => {

			for ( const slot of pool ) {

				if ( slot.job || ! land ) continue;
				// without the cache every chunk needs the field, and a land that missed it is new
				if ( ! fieldAsked && ( needs.length > 0 || landCache !== 'hit' ) ) {

					fieldAsked = true;
					send( slot, { kind: 'field', land: land.land.slice() } );
					continue;

				}
				const next = field ? needs.shift() ?? queue.shift() : generator !== null ? queue.shift() : undefined;
				if ( ! next ) continue;
				send( slot, { kind: 'chunk', ci: next.ci, cj: next.cj, version: step, key: key( next.ci, next.cj, next.steps ), contactOcclusion } );

			}

		};
		const finish = () => {

			mark( 'chunks' );
			// the cache keeps this version's records and the last version's, and deletes the rest;
			// sent before `close`, which waits for it
			if ( generator !== null ) {

				const keys = [ key( 'land', step )!, ...[ ...chunks.values() ].map( ( c ) => key( c.ci, c.cj, c.steps )! ) ];
				pool[ 0 ].worker.postMessage( { kind: 'keep', keys } satisfies ChunkJob );

			}
			// the workers close once their writes have reached the cache
			for ( const slot of pool ) slot.worker.postMessage( { kind: 'close' } satisfies ChunkJob );
			// settled only once merged, so a merge that throws still rejects the load (`fail`)
			const data = mergeChunks( land!, [ ...done.values() ] );
			settled = true;
			data.timings = { ...marks, build: Math.round( buildMs ), built, hits, merge: data.timings.merge, total: Math.round( performance.now() - t0 ) };
			const records = done.size + 1, read = hits + ( landCache === 'hit' ? 1 : 0 );
			resolve( {
				data, hits: read, chunks: done.size,
				cache: generator === null ? 'off' : landCache === 'error' ? 'error' : read === records ? 'hit' : read === 0 ? 'miss' : 'partial',
				ms: performance.now() - t0,
			} );

		};
		const receive = ( slot: Slot, reply: ChunkReply ) => {

			if ( settled ) return;
			slot.job = null;
			switch ( reply.kind ) {

				case 'land': {

					land = reply.data;
					landCache = reply.cache;
					mark( 'land' );
					const lattice = LandLattice.fromBytes( land.land );
					const p = pivot?.( lattice ) ?? landCentroid( lattice );
					for ( let k = 0; k < land.chunks.length / 2; k ++ ) {

						const ci = land.chunks[ k * 2 ], cj = land.chunks[ k * 2 + 1 ];
						const chunk = { ci, cj, steps: land.steps[ k ], distance: Math.hypot( ( ci + 0.5 ) * CHUNK - p.x, ( cj + 0.5 ) * CHUNK - p.z ) };
						chunks.set( `${ ci },${ cj }`, chunk );
						queue.push( chunk );

					}
					queue.sort( ( a, b ) => a.distance - b.distance );
					break;

				}
				case 'field':
					field = reply.field;
					mark( 'field' );
					// every worker cuts its chunks' windows from it (the last one takes the buffer)
					pool.forEach( ( other, k ) => send( other, { kind: 'use', land: land!.land, field: field! }, k === pool.length - 1 ? [ field!.data.buffer ] : [] ) );
					needs.sort( ( a, b ) => a.distance - b.distance );
					break;
				case 'need':
					needs.push( chunks.get( `${ reply.ci },${ reply.cj }` )! );
					break;
				case 'chunk':
					done.set( `${ reply.data.ci },${ reply.data.cj }`, reply.data );
					if ( reply.cache === 'hit' ) hits ++;
					else { built ++; buildMs += reply.data.timings.total ?? 0; }
					progress?.( done.size, chunks.size );
					if ( done.size === chunks.size ) { finish(); return; }
					break;

			}
			pump();

		};

		for ( let i = 0; i < threads; i ++ ) {

			const slot: Slot = { worker: new Worker( new URL( './chunkWorker.ts', import.meta.url ), { type: 'module' } ), job: null };
			// a throw here (the merge, the land's bytes, the caller's pivot or progress) would end in
			// the event loop and leave the load pending for ever: it rejects the load instead
			slot.worker.onmessage = ( e: MessageEvent<ChunkReply> ) => {

				try {

					receive( slot, e.data );

				} catch ( error ) {

					fail( error );

				}

			};
			slot.worker.onerror = ( e ) => fail( e );
			slot.worker.onmessageerror = () => fail( new Error( 'A chunk worker\'s reply could not be read' ) );
			slot.worker.postMessage( { kind: 'init', generator } satisfies ChunkJob );
			pool.push( slot );

		}
		send( pool[ 0 ], { kind: 'land', seed: worldSeed, step, key: key( 'land', step ) } );

	} );

}
