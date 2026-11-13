// The page's world: the land and its chunks generated on a pool of
// chunk workers (chunkWorker.ts), read from the per-chunk cache where it holds them
// (WorldCache.ts), and merged into one WorldData (ChunkMerge.ts) that the page draws (World.ts:
// the island a mesh per land chunk, every other kind merged).
//
// - The pool: min( 6, max( 1, hardwareConcurrency - 2 ) ) workers, leaving the page and the
//   compositor a core each (the single world worker's split also used up to six); a grown island's
//   next version (Growth.ts) runs on two, in the background.
// - Versions (`generateVersion`): a land step's chunks, unmerged. A version grown from another
//   (`from`) takes over every chunk whose window holds the same growth steps (its cache key's
//   changing part: Chunks.ts dirtyChunks), so only the rebuild set is read from the cache or built.
//   `loadWorld` is a version merged at once (the page's load).
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
//   (The worker that builds the field keeps it and sends a copy for every other worker, which the
//   page passes on without copying: rather than each job sent its window, as a window is 4 MB and
//   a load would copy several times the field's bytes, and rather than the page cloning it, about
//   10 MB on the main thread, in a frame of a page that grows.)
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
import type { ChunkData } from './Chunks.ts';
import { cacheBrowser } from './WorldCache.ts';
import type { ChunkJob, ChunkReply, CacheResult } from './chunkWorker.ts';
import type { WorldData, WorldOptions } from './types.ts';
import { CANOPY_SHADE } from '../../render/index.ts';

// bumped whenever what a record holds changes without the generator's sources changing
const CACHE_FORMAT = 6;
// the chunk's side (m): Chunks.ts S
const CHUNK = 16;

export interface LoadedWorld {
	data: WorldData;
	// the version it was merged from (Growth.ts keeps it, to grow from)
	version: VersionChunks;
	// 'hit': the land and every chunk from the cache; 'partial': some of them; 'miss': none (all
	// generated and stored); 'error': generated, the cache is unavailable; 'off': without the cache
	cache: 'hit' | 'partial' | 'miss' | 'error' | 'off';
	// records read from the cache, of chunks + 1 (the land)
	hits: number;
	chunks: number;
	// from the request to the merged world
	ms: number;
}

/** A land version's chunks, before the merge. */
export interface VersionChunks {
	step: number;
	land: LandData;
	// in rows ( cj, then ci ), as the land lists them
	chunks: ChunkData[];
	// per chunk ( `ci,cj` ), the growth steps whose pieces its window reads (its cache key's part
	// that changes as the land grows): a chunk of another version with the same steps is the same
	steps: Map<string, string>;
	// chunks taken from the version grown from, unbuilt
	reused: number;
}

export interface LoadOptions {
	cache?: boolean;
	// the point the camera turns round on this land (by default its centroid): the chunks nearest
	// it come first
	pivot?: ( land: LandLattice ) => { x: number; z: number };
	// called as chunks arrive
	progress?: ( done: number, total: number ) => void;
	// workers (default: min( 6, max( 1, hardwareConcurrency - 2 ) ))
	threads?: number;
	// the version this one grows from: its chunks whose steps are the same are taken as they are
	from?: VersionChunks;
	// given the main thread's time (ms) handling each of the workers' replies
	clock?: ( ms: number ) => void;
}

interface Slot { worker: Worker; job: ChunkJob[ 'kind' ] | null }
interface Pending { ci: number; cj: number; steps: number[]; distance: number }

interface Generated { version: VersionChunks; cache: LoadedWorld[ 'cache' ]; hits: number; ms: number; marks: Record<string, number>; built: number; buildMs: number }

/** The world of `options`' land, from its chunks. */
export function loadWorld( options: WorldOptions = {}, load: LoadOptions = {} ): Promise<LoadedWorld> {

	return generateVersion( options, load ).then( ( g ) => {

		const data = mergeChunks( g.version.land, g.version.chunks );
		data.timings = { ...g.marks, build: Math.round( g.buildMs ), built: g.built, hits: g.hits, merge: data.timings.merge, total: Math.round( g.ms + data.timings.merge ) };
		return { data, version: g.version, cache: g.cache, hits: g.hits, chunks: g.version.chunks.length, ms: g.ms + data.timings.merge };

	} );

}

/** The chunks of `options`' land, generated (or read from the cache, or taken from `from`). */
export function generateVersion( options: WorldOptions = {}, { cache = true, pivot, progress, threads: wanted, from, clock }: LoadOptions = {} ): Promise<Generated> {

	// eslint-disable-next-line ponlai/scene-clock -- the load's timings, a readout
	const t0 = performance.now();
	const { worldSeed = 1, step = 0, contactOcclusion = true, canopyShade = CANOPY_SHADE } = options;
	const generator = cache ? WORLD_GENERATOR_HASH : null;
	const key = ( ...parts: unknown[] ) => generator === null ? null
		: JSON.stringify( [ CACHE_FORMAT, generator, { worldSeed, contactOcclusion, canopyShade }, cacheBrowser(), ...parts ] );
	const threads = wanted ?? Math.min( 6, Math.max( 1, ( navigator.hardwareConcurrency || 4 ) - 2 ) );

	return new Promise( ( resolve, reject ) => {

		const pool: Slot[] = [];
		let settled = false;
		let land: LandData | null = null, landCache: CacheResult = 'off', field = false, fieldAsked = false;
		// every chunk by its key; those not yet asked for, nearest first; those that missed the cache
		// before the field came
		const chunks = new Map<string, Pending>(), queue: Pending[] = [], needs: Pending[] = [];
		const done = new Map<string, ChunkData>();
		const steps = new Map<string, string>();
		let hits = 0, built = 0, buildMs = 0, reused = 0;
		const marks: Record<string, number> = {};
		// eslint-disable-next-line ponlai/scene-clock -- the load's timings, a readout
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
				// without the cache every chunk needs the field, and a land that missed it is new (a
				// land whose chunks are all taken from the version grown from needs none)
				if ( ! fieldAsked && ( needs.length > 0 || ( landCache !== 'hit' && queue.length > 0 ) ) ) {

					fieldAsked = true;
					send( slot, { kind: 'field', land: land.land.slice(), copies: pool.length - 1 } );
					continue;

				}
				const next = field ? needs.shift() ?? queue.shift() : generator !== null ? queue.shift() : undefined;
				if ( ! next ) continue;
				send( slot, { kind: 'chunk', ci: next.ci, cj: next.cj, version: step, key: key( next.ci, next.cj, next.steps ), contactOcclusion, canopyShade } );

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
			settled = true;
			// in the land's order: rows ( cj, then ci )
			const ordered: ChunkData[] = [];
			for ( let k = 0; k < land!.chunks.length; k += 2 ) ordered.push( done.get( `${ land!.chunks[ k ] },${ land!.chunks[ k + 1 ] }` )! );
			const records = done.size - reused + 1, read = hits + ( landCache === 'hit' ? 1 : 0 );
			resolve( {
				version: { step, land: land!, chunks: ordered, steps, reused },
				cache: generator === null ? 'off' : landCache === 'error' ? 'error' : read === records ? 'hit' : read === 0 ? 'miss' : 'partial',
				// eslint-disable-next-line ponlai/scene-clock -- the load's timings, a readout
				hits: read, ms: performance.now() - t0, marks, built, buildMs,
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

						const ci = land.chunks[ k * 2 ], cj = land.chunks[ k * 2 + 1 ], name = `${ ci },${ cj }`;
						const chunk = { ci, cj, steps: land.steps[ k ], distance: Math.hypot( ( ci + 0.5 ) * CHUNK - p.x, ( cj + 0.5 ) * CHUNK - p.z ) };
						chunks.set( name, chunk );
						steps.set( name, chunk.steps.join( ',' ) );
						// a chunk whose window holds the same pieces as in the version grown from is that
						// chunk (Chunks.ts dirtyChunks)
						const before = from?.steps.get( name ) === steps.get( name ) ? from!.chunks.find( ( c ) => c.ci === ci && c.cj === cj ) : undefined;
						if ( before ) {

							done.set( name, before );
							reused ++;

						} else queue.push( chunk );

					}
					queue.sort( ( a, b ) => a.distance - b.distance );
					if ( done.size === chunks.size ) { finish(); return; }
					break;

				}
				case 'field': {

					field = true;
					mark( 'field' );
					// every other worker cuts its chunks' windows from a copy (made by the worker that
					// built it, which keeps its own: the page only passes the buffers on)
					const copies = [ ...reply.copies ];
					for ( const other of pool ) {

						if ( other === slot ) continue;
						const copy = copies.pop()!;
						send( other, { kind: 'use', land: land!.land, field: copy }, [ copy.data.buffer ] );

					}
					needs.sort( ( a, b ) => a.distance - b.distance );
					break;

				}
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
			// a throw here (the land's bytes, the caller's pivot or progress) would end in the event
			// loop and leave the load pending for ever: it rejects the load instead
			slot.worker.onmessage = ( e: MessageEvent<ChunkReply> ) => {

				// eslint-disable-next-line ponlai/scene-clock -- the time the page spent on a chunk's reply, charged to the growth's log
				const t = performance.now();
				try {

					receive( slot, e.data );

				} catch ( error ) {

					fail( error );

				}
				// eslint-disable-next-line ponlai/scene-clock -- the time the page spent on a chunk's reply, charged to the growth's log
				clock?.( performance.now() - t );

			};
			// (an ErrorEvent names the throw; a plain Event, a worker that could not load: a page left
			// open over a rebuild of its bundle asks for a worker script that is gone)
			slot.worker.onerror = ( e ) => fail( new Error( e.message ? `A chunk worker failed: ${ e.message } (${ e.filename }:${ e.lineno })` : 'A chunk worker could not start' ) );
			slot.worker.onmessageerror = () => fail( new Error( 'A chunk worker\'s reply could not be read' ) );
			slot.worker.postMessage( { kind: 'init', generator } satisfies ChunkJob );
			pool.push( slot );

		}
		send( pool[ 0 ], { kind: 'land', seed: worldSeed, step, key: key( 'land', step ) } );

	} );

}
