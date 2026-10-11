// Chunk checks for the world generator (plain node, CPU only):
//   node tools/verify-world-chunks.mjs [--seeds 1,2] [--steps 12] [--threads n] [--long] [--bench]
//                                      [--sheets dir]
// Run it before captures after any change to the world's generator.
//
// The world is generated per chunk (src/world/Chunks.ts): S = 16 m squares on the world grid, each
// from its window (the chunk grown by R = 32 m) of the land field alone. For every seed the runner
// grows the land step by step (0 .. --steps), builds every chunk of every step on a pool of worker
// threads (`buildChunk`, each job handed its window as the page's workers will be), and runs the
// checks below on the hashes and, at the S steps, on what the chunks hold. A check prints `ok` /
// `FAIL` lines and returns whether it passed; any failure sets the exit code. The default run builds
// 1219 chunks (seeds 1 - 2, steps 0 - 12; about half a second each on one thread, a coastal chunk up
// to two); `--long` adds what the default leaves out (marked below). docs/tools.md has the times.
//
//   D1  incremental equals scratch: step n's chunks built incrementally (every chunk of step 0,
//       then at each step only `dirtyChunks` from the step before, the others kept) hash as step n
//       built from scratch in a fresh process, one chunk after another in reverse key order. The
//       default builds the last step from scratch, --long every step.
//   D2  thread counts: the last step's chunks built on pools of 1 and of 4 workers hash as on the
//       main pool (the default the first seed's 15 costliest chunks by the main pool's time, the
//       coastal ones, --long all, both seeds).
//   D3  the land does not depend on the order its pieces are applied: a piece is the cells a growth
//       step adds, immutable once placed (IslandGrowth.ts). Which piece comes next depends on the
//       land before it, so the growth itself has one order; "piece order" here is the order a land
//       is assembled from its pieces (a save loaded, a worker handed the pieces): the union of the
//       cells. The last step's pieces applied in reverse, shuffled, and with the starting island
//       last give the same cells, chunk keys and land field as the grown land, bit for bit (the
//       recent headings a land also keeps do follow the order: no chunk reads them).
//   D4  the dirty set: between consecutive steps every chunk whose hash changed (or that is new)
//       is in `dirtyChunks`, and none outside it changed. Prints the chunks, how many are dirty,
//       how many changed, and how far the farthest changed chunk lies from the changed land; it
//       warns (no failure) when that is more than 30 m, close to the rule's 34 m.
//   D5  beyond the dirty bound: at the last step, for each coastal chunk and each axis direction,
//       a 2 m disc of land on the coast and a 2.5 m disc 6 - 16 m offshore, placed so its nearest
//       cell lies 34.6 - 44 m from the chunk: the chunk is not in `dirtyChunks`, and rebuilt from
//       the new land field it hashes as before. Prints the discs, how many changed the chunk's
//       window (the far reads had something to see) and how many changed the chunk.
//   At the S steps (0 and the last; --long every fourth):
//   S1  the welded union of the chunks' island and stone meshes is closed: no boundary edge, and
//       at most 1.3 non-manifold edges per 1000 triangles (the ambiguous cells of surface nets).
//       The page's single island mesh has 0.65 - 0.88 per 1000 on seeds 1 - 2 at steps 0 and 12
//       once its bottom face is left out: x 1.5. The chunks leave the bottom face out by design
//       (SurfaceNets.ts: never seen below the sea floor), so the walls end open at the lattice's
//       bottom row: a boundary edge with both ends in that row (y < -5.1 + one voxel) is counted
//       as the open foot instead.
//   S2  island seams. Every island vertex two chunks share (the same position bits) carries the
//       same bits in every attribute in both, contact shade included; and the 2 x 2 block of chunks
//       holding the most triangles, meshed in one call from its own window on the same lattice
//       (`chunkIsland`), has exactly the vertices (all attributes) and triangles of its four chunks.
//   S3  floor seams: the lattice points two (or four) neighbouring floor tiles both compute (their
//       common border rows, corners) are bit-identical in height, normal, ao and bed. Every floor
//       point off the land (land distance > 0) lies at or below -1.6 m, and every tile side with no
//       chunk beyond it, where the far floor meets the tile, is the open sea's lattice bit for bit
//       (openSeaHeight, the far floor's normals, openSeaBeds, ao 1).
//   S4  skirt seams: every piece of the turf skirt that ends on a chunk border meets exactly one
//       piece that starts there in a neighbouring chunk, with the same crossing sample (ring
//       points, normals, coast data) to 1e-5 (the count of bit-identical ones is printed); no piece
//       ends inside its chunk.
//   S5  shared-out content: the 2 x 2 block with the most rim items, made in one pass from its own
//       window (`chunkBlock`) and shared out by chunk, equals its four chunks bit for bit in the
//       rim ground, shore and walk texels, the anchors, the bushes and the trail patches.
//   S6  stones: every stone is owned once, by the chunk its centre lies in; and every stone a chunk
//       places round itself for the contact shade (`contactStones`) whose centre lies in another
//       chunk is that chunk's own stone, bit for bit, so two chunks shade with the same stone.
//   I1  no buried wall inland: where the land distance is below -3.5 m (inland, the island mesh's
//       column range: no wall, only the meadow's top) the window's island SDF is solid from the
//       lattice's bottom to 0.35 m below the meadow's top and clear 0.6 m above it, sampled every
//       0.5 m across and 0.25 m down; and no inland island vertex lies below that. A wall left
//       standing inside land that grew over the old coast would show as an open sample.
//   columns  (--long) every chunk with inland columns meshed with the inland column range
//       (WorldShapes.islandColumnRange) is byte-identical to the chunk meshed with whole columns.
//
// `--bench` skips D1 - D3 and the S checks and prints per growth piece the land field's time, the
// chunks `dirtyChunks` rebuilds, how many come out changed, their CPU time (summed over the jobs,
// on a loaded pool more than alone) and their bytes. Every run writes the chunk sheet, one PNG per
// seed (`sheet`), to --sheets (default artifacts/captures/world-chunks/).
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { LandLattice, nextPiece, GROWTH } from '../src/world/IslandGrowth.ts';
import {
	buildChunk, chunkBlock, chunkBox, chunkIsland, chunkKeys, contactStones, dirtyChunks, landField, landWindow,
	parseChunkKey, windowFootprint, R, S,
} from '../src/world/Chunks.ts';
import { ISLAND_BOTTOM, islandSurfaceHeight, makeIslandSDF } from '../src/world/WorldShapes.ts';
import { SKIRT_INFO, SKIRT_RING } from '../src/world/RimGround.ts';
import { TILE_SIDE } from '../src/world/SeabedTile.ts';
import { openSeaBeds, openSeaHeight, FLOOR_STEP, SHELF_CEILING } from '../src/world/Bathymetry.ts';
import { BUSH_STRIDE } from '../src/world/FoliageSites.ts';
import { VEGETATION_STRIDE } from '../src/world/types.ts';
import { hashBuffers, meshClosure, positionKey } from './world-node.mjs';

// the island mesh's lattice (Chunks.ts)
const VOXEL = 0.125, Y0 = ISLAND_BOTTOM + 0.5;

// ------------------------------------------------------------------ the worker

// A job: one chunk from its window and the land; the reply carries its hash, timings and size, and
// at the S steps what the seam checks compare (its meshes, floor tile, skirt, rasters, items, the
// stones it places round it, the inland columns). A `block` job makes a 2 x 2 block's share-out
// instead (S5), an `islandBlock` job its island mesh (S2).
if ( ! isMainThread ) {

	let land = null, version = - 1;
	parentPort.on( 'message', ( job ) => {

		if ( job.block ) {

			const t = performance.now(), members = chunkBlock( job.window, job.ci, job.cj, 2 );
			parentPort.postMessage( { id: job.id, members, ms: performance.now() - t } );
			return;

		}
		if ( job.islandBlock ) {

			const t = performance.now(), island = chunkIsland( job.window, job.ci, job.cj, 2 );
			parentPort.postMessage( { id: job.id, island, ms: performance.now() - t } );
			return;

		}
		if ( job.version !== version ) { land = LandLattice.fromBytes( job.land ); version = job.version; }
		const c = buildChunk( job.window, land, job.ci, job.cj, { version: job.version } );
		const { key, land: v, hash, timings, ...content } = c;
		const reply = { id: job.id, hash: c.hash, timings: c.timings, bytes: bytesOf( content ) };
		const transfer = [];
		if ( job.keep ) {

			reply.island = c.island;
			reply.stones = c.stones.mesh;
			for ( const m of [ c.island, c.stones.mesh ] ) if ( m ) for ( const a of Object.values( m ) ) if ( ! transfer.includes( a.buffer ) ) transfer.push( a.buffer );
			Object.assign( reply, {
				floor: c.floor, skirt: c.skirt, rimGround: c.rimGround, shore: c.shore, walk: c.walk,
				anchors: c.anchors, bushes: c.bushes, strands: c.strands, rocks: c.stones.rocks,
				contact: contactStones( job.window, job.ci, job.cj ),
				inland: inlandColumns( job.window, job.ci, job.cj, c.island ),
			} );

		}
		parentPort.postMessage( reply, transfer );

	} );

}

// The bytes a chunk's content takes packed: its buffers, and 4 bytes per plain number.
function bytesOf( v ) {

	if ( v === null || v === undefined ) return 0;
	if ( typeof v === 'number' ) return 4;
	if ( ArrayBuffer.isView( v ) ) return v.byteLength;
	if ( typeof v === 'object' ) return Object.values( v ).reduce( ( sum, item ) => sum + bytesOf( item ), 0 );
	return 0;

}

// I1's sampling, in the job: the chunk's inland columns (land distance below INLAND, the island
// mesh's column range) on a COLUMN grid, the window's island SDF solid at every LAYER from the
// lattice's bottom to 0.35 m below the meadow's top and clear 0.6 m above it; and no island vertex
// inland (a voxel farther in) below that floor. Returns the counts and the first few failures.
const INLAND = - 3.5, COLUMN = 0.5, LAYER = 0.25;
function inlandColumns( window, ci, cj, island ) {

	const fp = windowFootprint( window ), box = chunkBox( ci, cj );
	const sdf = makeIslandSDF( fp, { x0: box.x0 - R, z0: box.z0 - R, x1: box.x1 + R, z1: box.z1 + R }, { local: true } );
	let columns = 0, samples = 0, vertices = 0;
	const bad = [];
	for ( let z = box.z0 + COLUMN / 2; z < box.z1; z += COLUMN ) for ( let x = box.x0 + COLUMN / 2; x < box.x1; x += COLUMN ) {

		if ( fp.dist( x, z ) >= INLAND ) continue;
		columns ++;
		const top = islandSurfaceHeight( x, z );
		for ( let y = Y0; y <= top - 0.35; y += LAYER ) {

			samples ++;
			if ( sdf( x, y, z ) >= 0 ) { bad.push( `open at ( ${ x }, ${ y.toFixed( 2 ) }, ${ z } )` ); break; }

		}
		if ( sdf( x, top + 0.6, z ) <= 0 ) bad.push( `solid above the top at ( ${ x }, ${ z } )` );

	}
	if ( island ) for ( let v = 0; v < island.positions.length; v += 3 ) {

		const x = island.positions[ v ], y = island.positions[ v + 1 ], z = island.positions[ v + 2 ];
		if ( fp.dist( x, z ) >= INLAND - VOXEL ) continue;
		vertices ++;
		if ( y < islandSurfaceHeight( x, z ) - 0.35 ) bad.push( `a vertex below the top at ( ${ x.toFixed( 2 ) }, ${ y.toFixed( 2 ) }, ${ z.toFixed( 2 ) } )` );

	}
	return { columns, samples, vertices, failures: bad.length, bad: bad.slice( 0, 3 ) };

}

// ------------------------------------------------------------------ the land, step by step

// The land after each step 0 .. steps, and the pieces (step 0 first).
function grow( seed, steps ) {

	const land = new LandLattice(), lands = [], pieces = [];
	for ( let step = 0; step <= steps; step ++ ) {

		const piece = nextPiece( seed, land, step );
		land.add( piece );
		pieces.push( piece );
		lands.push( LandLattice.fromBytes( land.toBytes() ) );

	}
	return { lands, pieces };

}

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return i < 0 ? fallback : process.argv[ i + 1 ];

};

// ------------------------------------------------------------------ scratch (D1's fresh process)

// `--scratch seed steps`: builds every chunk of each step from scratch, one after another in
// reverse key order, and prints one JSON line per step: { seed, step, hashes: { key: hash } }.
if ( isMainThread && process.argv.includes( '--scratch' ) ) {

	const i = process.argv.indexOf( '--scratch' ), seed = Number( process.argv[ i + 1 ] );
	const steps = process.argv[ i + 2 ].split( ',' ).map( Number );
	const { lands } = grow( seed, Math.max( ...steps ) );
	for ( const step of steps ) {

		const land = lands[ step ], field = landField( land ), hashes = {};
		for ( const key of chunkKeys( land ).reverse() ) {

			const [ ci, cj ] = parseChunkKey( key );
			hashes[ key ] = buildChunk( landWindow( field, ci, cj ), land, ci, cj, { version: seed * 1000 + step } ).hash;

		}
		process.stdout.write( JSON.stringify( { seed, step, hashes } ) + '\n' );

	}
	process.exit( 0 );

}

// ------------------------------------------------------------------ the run

async function main() {

	const start = performance.now();
	const long = process.argv.includes( '--long' ), bench = process.argv.includes( '--bench' );
	const seeds = argument( '--seeds', '1,2' ).split( ',' ).map( Number );
	const last = Number( argument( '--steps', '12' ) );
	const threads = Number( argument( '--threads', String( Math.max( 1, Math.min( 8, availableParallelism() - 4 ) ) ) ) );
	const sSteps = bench ? [] : long ? [ ...new Set( [ ...Array.from( { length: Math.floor( last / 4 ) + 1 }, ( _, k ) => k * 4 ), last ] ) ] : [ ...new Set( [ 0, last ] ) ];
	const scratchSteps = long ? Array.from( { length: last + 1 }, ( _, k ) => k ) : [ last ];
	console.log( `seeds ${ seeds.join( ', ' ) }, steps 0 - ${ last }, ${ threads } threads${ long ? ', long' : '' }${ bench ? ', bench (D4 and the per-piece costs only)' : '' }` );

	// D1's fresh processes, one per seed, run alongside the pool
	const scratch = bench ? [] : seeds.map( ( seed ) => runScratch( seed, scratchSteps ) );

	const pool = new Pool( threads );
	// D2's pools of 1 and 4 workers (their own threads, alongside the main pool)
	const pools = bench ? [] : [ new Pool( 1 ), new Pool( 4 ) ];
	const others = [];
	const runs = [];
	for ( const seed of seeds ) {

		const { lands, pieces } = grow( seed, last );
		const steps = [];
		for ( let step = 0; step <= last; step ++ ) {

			const t = performance.now();
			const land = lands[ step ], field = landField( land ), keys = chunkKeys( land ), keep = sSteps.includes( step );
			const fieldMs = performance.now() - t;
			const bytes = land.toBytes();
			const version = seed * 1000 + step;
			const job = ( ci, cj, keep ) => () => ( { window: landWindow( field, ci, cj ), land: bytes, ci, cj, version, keep } );
			steps.push( { step, land, keys, fieldMs, field: keep ? field : null, chunks: Promise.all( keys.map( ( key ) => {

				const [ ci, cj ] = parseChunkKey( key );
				return pool.run( job( ci, cj, keep ) ).then( ( reply ) => ( { key, ci, cj, ...reply } ) );

			} ) ) } );
			// D2 and D5 build more of the last step's chunks once the main pool's are in
			if ( step === last ) steps[ step ].job = job;
			// let the pool's replies in: a land field takes the main thread a moment
			await new Promise( ( resolve ) => setImmediate( resolve ) );

		}
		runs.push( { seed, lands, pieces, steps } );

	}

	let failed = 0;
	const timings = {}, beyondBound = [];
	let built = 0;
	for ( const run of runs ) {

		for ( const s of run.steps ) {

			s.chunks = await s.chunks;
			s.hashes = new Map( s.chunks.map( ( c ) => [ c.key, c.hash ] ) );
			for ( const c of s.chunks ) { built ++; for ( const [ k, v ] of Object.entries( c.timings ) ) timings[ k ] = ( timings[ k ] ?? 0 ) + v; }

		}
		const final = run.steps[ last ];
		// D2: the last step's chunks on both pools (the default the first seed's 15 costliest by
		// the main pool's time, the coastal ones, where most of the work and its order lie)
		if ( pools.length && ( long || run.seed === seeds[ 0 ] ) ) {

			const sample = long ? final.keys : [ ...final.chunks ].sort( ( a, b ) => b.timings.total - a.timings.total ).slice( 0, 15 ).map( ( c ) => c.key );
			for ( const p of pools ) others.push( Promise.all( sample.map( ( key ) => p.run( final.job( ...parseChunkKey( key ), false ) ).then( ( r ) => [ key, r.hash ] ) ) )
				.then( ( hashes ) => ( { seed: run.seed, step: last, threads: p.size, hashes } ) ) );

		}
		final.job = null;
		// D5 runs on the main pool alongside the checks below
		if ( ! bench ) beyondBound.push( beyond( run, pool ) );
		console.log( `---- seed ${ run.seed }: ${ run.steps.map( ( s ) => s.keys.length ).join( ', ' ) } chunks at steps 0 - ${ last } (${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s)` );
		if ( ! dirtySet( run ) ) failed ++;
		if ( bench ) costs( run );
		sheet( run );
		if ( bench ) continue;
		if ( ! pieceOrder( run ) ) failed ++;
		for ( const s of run.steps ) if ( sSteps.includes( s.step ) ) {

			const ctx = { label: `seed ${ run.seed } step ${ s.step }`, field: s.field, chunks: s.chunks };
			for ( const check of [ closed, seams, floorSeams, skirtSeams, blockShare, stoneOwners, inland, ...( long ? [ columns ] : [] ) ] ) if ( ! await check( ctx, pool ) ) failed ++;
			s.field = null;
			// the meshes and rasters are not needed past this step
			for ( const c of s.chunks ) for ( const k of [ 'island', 'stones', 'floor', 'skirt', 'rimGround', 'shore', 'walk', 'anchors', 'bushes', 'strands', 'contact' ] ) delete c[ k ];

		}

	}
	for ( const ok of await Promise.all( beyondBound ) ) if ( ! ok ) failed ++;
	pool.close();
	const per = Object.entries( timings ).map( ( [ k, v ] ) => `${ k } ${ ( v / built ).toFixed( 0 ) }` ).join( ', ' );
	console.log( `     ${ built } chunks built on the pool, ms per chunk: ${ per }` );

	if ( ! bench ) {

		if ( ! threadCounts( runs, await Promise.all( others ) ) ) failed ++;
		for ( const p of pools ) p.close();
		for ( const [ n, run ] of runs.entries() ) if ( ! incremental( run, await scratch[ n ] ) ) failed ++;

	}

	console.log( `     done in ${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s` );
	if ( failed ) {

		console.log( `${ failed } checks failed.` );
		process.exit( 1 );

	}
	console.log( bench ? 'D4 passed.' : 'All chunk checks passed.' );

}

// A pool of worker threads. `run( make, first )` queues a job (`first`: ahead of the others, for a
// check waiting on it); `make` builds its message when a worker takes it (a window is 4 MB: they
// are cut only then). Each worker holds up to DEPTH jobs, so it keeps working while the main
// thread is busy with a check and cannot hand it the next one.
const DEPTH = 2;
class Pool {

	constructor( n ) {

		this.size = n;
		this.queue = [];
		this.waiting = new Map();
		this.id = 0;
		this.workers = Array.from( { length: n }, () => {

			const worker = new Worker( fileURLToPath( import.meta.url ) );
			worker.jobs = 0;
			worker.on( 'message', ( reply ) => {

				const resolve = this.waiting.get( reply.id );
				this.waiting.delete( reply.id );
				worker.jobs --;
				this.next();
				resolve( reply );

			} );
			worker.on( 'error', ( error ) => { throw error; } );
			return worker;

		} );

	}

	run( make, first = false ) {

		return new Promise( ( resolve ) => {

			this.queue[ first ? 'unshift' : 'push' ]( { make, resolve } );
			this.next();

		} );

	}

	next() {

		while ( this.queue.length ) {

			// the least loaded worker
			const worker = this.workers.reduce( ( a, b ) => b.jobs < a.jobs ? b : a );
			if ( worker.jobs >= DEPTH ) return;
			const { make, resolve } = this.queue.shift(), id = this.id ++;
			const job = { id, ...make() };
			this.waiting.set( id, resolve );
			worker.jobs ++;
			worker.postMessage( job, [ job.window.data.buffer ] );

		}

	}

	close() {

		// every job is answered by now
		for ( const worker of this.workers ) worker.terminate();

	}

}

// D1's fresh process for one seed: the hashes of every chunk of each step, by step.
function runScratch( seed, steps ) {

	return new Promise( ( resolve, reject ) => {

		const child = spawn( process.execPath, [ fileURLToPath( import.meta.url ), '--scratch', String( seed ), steps.join( ',' ) ], { stdio: [ 'ignore', 'pipe', 'inherit' ] } );
		let out = '';
		child.stdout.on( 'data', ( d ) => out += d );
		child.on( 'error', reject );
		child.on( 'close', ( code ) => {

			if ( code !== 0 ) return reject( new Error( `the scratch process for seed ${ seed } exited with ${ code }` ) );
			const byStep = new Map();
			for ( const line of out.trim().split( '\n' ) ) {

				const { step, hashes } = JSON.parse( line );
				byStep.set( step, new Map( Object.entries( hashes ) ) );

			}
			resolve( byStep );

		} );

	} );

}

// ------------------------------------------------------------------ the checks

const ms = ( t ) => `${ t.toFixed( 0 ) } ms`;

// The land cells that differ between two lands, as squares [ x0, z0 ] (GROWTH.cell wide).
function changedCells( before, after ) {

	const N = Math.round( 2 * GROWTH.half / GROWTH.cell ), cells = [];
	for ( let w = 0; w < after.words.length; w ++ ) for ( let v = ( after.words[ w ] ^ before.words[ w ] ) >>> 0; v !== 0; v &= v - 1 ) {

		const k = w * 32 + 31 - Math.clz32( v & - v ), i = k % N;
		cells.push( - GROWTH.half + i * GROWTH.cell, - GROWTH.half + ( k - i ) / N * GROWTH.cell );

	}
	return cells;

}

// The distance (m) from chunk ( ci, cj )'s square to the nearest of the cells.
function distanceTo( cells, ci, cj ) {

	let best = Infinity;
	for ( let k = 0; k < cells.length; k += 2 ) {

		const dx = Math.max( ci * S - cells[ k ] - GROWTH.cell, 0, cells[ k ] - ci * S - S );
		const dz = Math.max( cj * S - cells[ k + 1 ] - GROWTH.cell, 0, cells[ k + 1 ] - cj * S - S );
		best = Math.min( best, dx * dx + dz * dz );

	}
	return Math.sqrt( best );

}

// D4: what changed between consecutive steps lies in the dirty set.
const MARGIN = 30;
function dirtySet( run ) {

	let ok = true, sumDirty = 0, sumChanged = 0, farthest = 0;
	const lines = [];
	for ( let n = 1; n < run.steps.length; n ++ ) {

		const before = run.steps[ n - 1 ], after = run.steps[ n ];
		const dirty = new Set( dirtyChunks( before.land, after.land ) );
		const changed = after.keys.filter( ( key ) => before.hashes.get( key ) !== after.hashes.get( key ) );
		const added = after.keys.filter( ( key ) => ! before.hashes.has( key ) ).length;
		const outside = changed.filter( ( key ) => ! dirty.has( key ) );
		const cells = changedCells( before.land, after.land );
		let far = 0;
		for ( const key of changed ) far = Math.max( far, distanceTo( cells, ...parseChunkKey( key ) ) );
		farthest = Math.max( farthest, far );
		sumDirty += dirty.size; sumChanged += changed.length;
		if ( outside.length ) {

			ok = false;
			console.log( `FAIL D4 seed ${ run.seed } step ${ n }: ${ outside.length } chunks changed outside the dirty set: ` +
				outside.slice( 0, 6 ).map( ( key ) => `( ${ key } ) ${ distanceTo( cells, ...parseChunkKey( key ) ).toFixed( 1 ) } m from the changed land` ).join( ', ' ) );

		}
		lines.push( `${ n }: ${ after.keys.length } / ${ dirty.size } / ${ changed.length }${ added ? ` (${ added } new)` : '' }, ${ far.toFixed( 1 ) } m` );

	}
	console.log( `${ ok ? 'ok  ' : 'FAIL' } D4 seed ${ run.seed }: changed chunks lie in the dirty set; per step chunks / dirty / changed, farthest changed chunk from the changed land:` );
	console.log( `       ${ lines.join( '; ' ) }` );
	console.log( `       in all ${ sumDirty } dirty, ${ sumChanged } changed (${ ( 100 * sumChanged / sumDirty ).toFixed( 0 ) } %), the farthest ${ farthest.toFixed( 1 ) } m from the changed land` );
	// the dirty rule's bound is 34 m: a change creeping towards it is worth a look before it fails
	if ( farthest > MARGIN ) console.log( `warn D4 seed ${ run.seed }: a chunk ${ farthest.toFixed( 1 ) } m from the changed land changed, more than ${ MARGIN } m (the dirty bound is ${ R + 2 } m)` );
	return ok;

}

// D5: land added just beyond the dirty bound changes nothing. At the last step, for each coastal
// chunk (a point within 1 m of the coast in it) and each axis direction, two discs of land: one on
// the coast (COAST_DISC, its centre just off the coast) and one offshore (SEA_DISC, its edge 6 -
// 16 m out), each placed where its nearest cell lies BEYOND_NEAR - BEYOND_FAR from the chunk's
// square, so `dirtyChunks` leaves the chunk out; it is rebuilt on the pool from the new land field
// and must hash as before. D4 sees only what the growth happens to add; this places land where the
// window's far reads (the stones, the trails, the shore) would show.
const COAST_DISC = 2, SEA_DISC = 2.5, BEYOND_NEAR = 34.6, BEYOND_FAR = 44;
async function beyond( run, pool ) {

	const land = run.lands[ run.lands.length - 1 ], step = run.lands.length - 1, hashes = run.steps[ step ].hashes;
	const field = landField( land ), fp = windowFootprint( field );
	const N = Math.round( 2 * GROWTH.half / GROWTH.cell ), X0 = - GROWTH.half, cell = GROWTH.cell;
	const coastal = chunkKeys( land ).filter( ( key ) => {

		const [ ci, cj ] = parseChunkKey( key );
		for ( let z = cj * S + 0.5; z < cj * S + S; z ++ ) for ( let x = ci * S + 0.5; x < ci * S + S; x ++ ) if ( Math.abs( fp.dist( x, z ) ) < 1 ) return true;
		return false;

	} );
	// the disc's cells not yet land, and the nearest one's distance from the chunk's square (the
	// larger of the gaps along x and z: the window is a square)
	const disc = ( p, radius, b ) => {

		const cells = [];
		let near = Infinity;
		for ( let j = Math.floor( ( p[ 1 ] - radius - X0 ) / cell ); j <= Math.ceil( ( p[ 1 ] + radius - X0 ) / cell ); j ++ ) {

			for ( let i = Math.floor( ( p[ 0 ] - radius - X0 ) / cell ); i <= Math.ceil( ( p[ 0 ] + radius - X0 ) / cell ); i ++ ) {

				const x = X0 + ( i + 0.5 ) * cell, z = X0 + ( j + 0.5 ) * cell;
				if ( i < 0 || j < 0 || i >= N || j >= N || Math.hypot( x - p[ 0 ], z - p[ 1 ] ) > radius || land.has( i, j ) ) continue;
				cells.push( j * N + i );
				const gx = Math.max( b.x0 - x - cell / 2, 0, x - cell / 2 - b.x1 ), gz = Math.max( b.z0 - z - cell / 2, 0, z - cell / 2 - b.z1 );
				near = Math.min( near, Math.max( gx, gz ) );

			}

		}
		return { cells, near };

	};
	const placed = [];
	let n = 0, windowSame = 0;
	for ( const key of coastal ) {

		const [ ci, cj ] = parseChunkKey( key ), b = chunkBox( ci, cj );
		for ( const [ ax, sg ] of [ [ 0, - 1 ], [ 0, 1 ], [ 1, - 1 ], [ 1, 1 ] ] ) for ( const [ kind, radius, fits ] of [
			[ 'coast', COAST_DISC, ( d ) => d > COAST_DISC - 1 && d < COAST_DISC - 0.3 ],
			[ 'sea', SEA_DISC, ( d ) => d > SEA_DISC + 6 && d < SEA_DISC + 16 ],
		] ) {

			// the first centre out along the axis, then across the chunk's span and 16 m either side
			let found = null;
			for ( let t = BEYOND_NEAR + radius; t <= BEYOND_FAR + radius && ! found; t += 0.25 ) for ( let u = - S; u <= 2 * S && ! found; u += 0.25 ) {

				const along = sg < 0 ? ( ax === 0 ? b.x0 : b.z0 ) - t : ( ax === 0 ? b.x1 : b.z1 ) + t;
				const across = ( ax === 0 ? b.z0 : b.x0 ) + u;
				const p = ax === 0 ? [ along, across ] : [ across, along ];
				if ( ! fits( fp.dist( p[ 0 ], p[ 1 ] ) ) ) continue;
				const d = disc( p, radius, b );
				if ( d.cells.length && d.near >= BEYOND_NEAR && d.near <= BEYOND_FAR ) found = { p, ...d };

			}
			if ( ! found ) continue;
			const after = LandLattice.fromBytes( land.toBytes() );
			for ( const k of found.cells ) after.words[ k >>> 5 ] |= 1 << ( k & 31 );
			const where = `( ${ key } ) ${ kind } disc ${ ax ? 'z' : 'x' }${ sg > 0 ? '+' : '-' } at ( ${ found.p[ 0 ].toFixed( 1 ) }, ${ found.p[ 1 ].toFixed( 1 ) } ), ${ found.near.toFixed( 1 ) } m out`;
			if ( dirtyChunks( land, after ).includes( key ) ) { placed.push( { where, dirty: true } ); continue; }
			const window = landWindow( landField( after ), ci, cj ), before = landWindow( field, ci, cj );
			let differ = 0;
			for ( let k = 0; k < window.data.length; k ++ ) if ( window.data[ k ] !== before.data[ k ] ) differ ++;
			if ( ! differ ) windowSame ++;
			const bytes = after.toBytes(), version = - ( run.seed * 10000 + ++ n );
			placed.push( pool.run( () => ( { window, land: bytes, ci, cj, version, keep: false } ), true )
				.then( ( r ) => ( { where, cells: found.cells.length, differ, same: r.hash === hashes.get( key ) } ) ) );
			// let the pool's replies in between the land fields
			await new Promise( ( resolve ) => setImmediate( resolve ) );

		}

	}
	const results = await Promise.all( placed );
	const dirty = results.filter( ( r ) => r.dirty ), changed = results.filter( ( r ) => ! r.dirty && ! r.same );
	for ( const r of [ ...dirty, ...changed ].slice( 0, 6 ) ) console.log( `FAIL D5 seed ${ run.seed }: ${ r.where }: ${ r.dirty ? 'dirtyChunks lists the chunk' : `${ r.cells } cells, ${ r.differ } window cells differ, the chunk changed` }` );
	const most = Math.max( 0, ...results.map( ( r ) => r.differ ?? 0 ) );
	const ok = ! dirty.length && ! changed.length;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } D5 seed ${ run.seed } step ${ step }: ${ coastal.length } coastal chunks, ${ results.length } discs placed ${ BEYOND_NEAR } - ${ BEYOND_FAR } m out ` +
		`(${ results.filter( ( r ) => r.where.includes( 'coast disc' ) ).length } on the coast, ${ results.filter( ( r ) => r.where.includes( 'sea disc' ) ).length } offshore): ` +
		`${ dirty.length } in the dirty set, ${ results.length - dirty.length - windowSame } changed the chunk's window (up to ${ most } cells), ${ changed.length } chunks changed` );
	return ok;

}

// D3: the land is the union of its pieces, whatever order they come in.
function pieceOrder( run ) {

	const land = run.lands[ run.lands.length - 1 ], pieces = run.pieces;
	// a fixed shuffle (a linear congruential stream from the seed)
	let r = run.seed * 2654435761 >>> 0;
	const shuffled = pieces.map( ( p ) => [ ( r = Math.imul( r, 1664525 ) + 1013904223 >>> 0 ), p ] ).sort( ( a, b ) => a[ 0 ] - b[ 0 ] ).map( ( [ , p ] ) => p );
	const orders = { reversed: [ ...pieces ].reverse(), shuffled, 'starting island last': [ ...pieces.slice( 1 ), pieces[ 0 ] ] };
	const field = hashBuffers( landField( land ) ), keys = chunkKeys( land ).join( ' ' );
	let ok = true;
	for ( const [ name, order ] of Object.entries( orders ) ) {

		const other = new LandLattice();
		for ( const p of order ) other.add( p );
		const bytes = ( w ) => Buffer.from( w.buffer, w.byteOffset, w.byteLength );
		const same = Buffer.compare( bytes( other.words ), bytes( land.words ) ) === 0;
		const sameKeys = chunkKeys( other ).join( ' ' ) === keys, sameField = hashBuffers( landField( other ) ) === field;
		if ( ! same || ! sameKeys || ! sameField ) {

			ok = false;
			console.log( `FAIL D3 seed ${ run.seed }: the pieces ${ name } give ${ same ? '' : 'other cells, ' }${ sameKeys ? '' : 'other chunk keys, ' }${ sameField ? '' : 'another land field' }` );

		}

	}
	console.log( `${ ok ? 'ok  ' : 'FAIL' } D3 seed ${ run.seed }: the ${ pieces.length } pieces of step ${ pieces.length - 1 } ${ Object.keys( orders ).join( ', ' ) } give the same cells, chunk keys and land field` );
	return ok;

}

// D1: the incremental chunks equal the fresh process's scratch build.
function incremental( run, scratch ) {

	let ok = true, kept = 0, compared = 0;
	let map = run.steps[ 0 ].hashes;
	const steps = [];
	for ( let n = 0; n < run.steps.length; n ++ ) {

		const s = run.steps[ n ];
		if ( n > 0 ) {

			const dirty = new Set( dirtyChunks( run.steps[ n - 1 ].land, s.land ) ), next = new Map();
			for ( const key of s.keys ) {

				if ( dirty.has( key ) ) next.set( key, s.hashes.get( key ) );
				else if ( map.has( key ) ) { next.set( key, map.get( key ) ); kept ++; }
				else { ok = false; console.log( `FAIL D1 seed ${ run.seed } step ${ n }: chunk ( ${ key } ) is new but not dirty` ); }

			}
			map = next;

		}
		const fresh = scratch.get( n );
		if ( ! fresh ) continue;
		steps.push( n );
		const keys = [ ...fresh.keys() ].sort().join( ' ' );
		if ( keys !== [ ...map.keys() ].sort().join( ' ' ) ) { ok = false; console.log( `FAIL D1 seed ${ run.seed } step ${ n }: the scratch build has other chunks` ); continue; }
		const differ = [ ...map.keys() ].filter( ( key ) => map.get( key ) !== fresh.get( key ) );
		compared += map.size;
		if ( differ.length ) { ok = false; console.log( `FAIL D1 seed ${ run.seed } step ${ n }: ${ differ.length } chunks differ from the scratch build: ${ differ.slice( 0, 6 ).join( '; ' ) }` ); }

	}
	console.log( `${ ok ? 'ok  ' : 'FAIL' } D1 seed ${ run.seed }: incremental (${ kept } chunks kept over steps 1 - ${ run.steps.length - 1 }) equals the scratch build ` +
		`in a fresh process in reverse key order at step${ steps.length > 1 ? 's' : '' } ${ steps.join( ', ' ) } (${ compared } chunks)` );
	return ok;

}

const NON_MANIFOLD_PER_1000 = 1.3;

// S1: the welded chunks close up.
function closed( ctx ) {

	const foot = Y0 + VOXEL;
	const meshes = ctx.chunks.flatMap( ( k ) => k.island ? [ k.island, k.stones ] : [ k.stones ] );
	const c = meshClosure( meshes, { open: ( p, q ) => p[ 1 ] < foot && q[ 1 ] < foot } );
	const rate = 1000 * c.nonManifold / c.triangles;
	const ok = c.boundary === 0 && rate <= NON_MANIFOLD_PER_1000;
	const islands = ctx.chunks.filter( ( k ) => k.island ).length;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } S1 ${ ctx.label }: ${ ctx.chunks.length } chunks (${ islands } with island nets), ${ c.triangles } triangles with the stones, ${ c.welded } welded vertices: ` +
		`${ c.boundary } boundary edges (+ ${ c.open } along the open foot), ${ c.nonManifold } non-manifold (${ rate.toFixed( 2 ) } per 1000 triangles, at most ${ NON_MANIFOLD_PER_1000 }), ` +
		`${ c.flipped } flipped, ${ c.degenerate } degenerate` );
	return ok;

}

// Every attribute of vertex v as one key per attribute, by its float bits.
const ATTRIBUTES = [ [ 'normals', 3 ], [ 'ao', 1 ], [ 'tint', 1 ], [ 'curv', 1 ], [ 'detail', 4 ], [ 'detail2', 3 ] ];
function attributes( mesh, v ) {

	return ATTRIBUTES.map( ( [ name, n ] ) => {

		const a = mesh[ name ], bits = new Uint32Array( a.buffer, a.byteOffset, a.length );
		return Array.from( bits.subarray( v * n, v * n + n ) ).join( ',' );

	} );

}

// The vertices of a mesh by position key (a position twice in one mesh keeps every copy).
function byPosition( mesh ) {

	const map = new Map();
	for ( let v = 0; v < mesh.positions.length / 3; v ++ ) {

		const key = positionKey( mesh.positions, v );
		const list = map.get( key );
		if ( list ) list.push( v ); else map.set( key, [ v ] );

	}
	return map;

}

// Whether the copies of one position in two meshes agree: every copy on the side with fewer
// copies must equal one on the other side (a position duplicated in one chunk may be used by
// only one of the chunks across the border). Returns the first differing attribute's name or null.
function sameVertex( ma, va, mb, vb ) {

	const [ small, sv, large, lv ] = va.length <= vb.length ? [ ma, va, mb, vb ] : [ mb, vb, ma, va ];
	const others = lv.map( ( v ) => attributes( large, v ) );
	for ( const v of sv ) {

		const mine = attributes( small, v );
		if ( others.some( ( o ) => o.every( ( a, i ) => a === mine[ i ] ) ) ) continue;
		const nearest = others[ 0 ];
		return ATTRIBUTES[ mine.findIndex( ( a, i ) => a !== nearest[ i ] ) ][ 0 ];

	}
	return null;

}

// S2: chunks agree on their shared vertices, and a 2 x 2 block meshed whole equals its chunks.
async function seams( ctx, pool ) {

	let ok = true;
	const chunks = ctx.chunks.filter( ( c ) => c.island );
	const maps = chunks.map( ( c ) => byPosition( c.island ) );
	const index = new Map( chunks.map( ( c, n ) => [ c.key, n ] ) );

	// shared vertices between every pair of neighbouring chunks (8-neighbourhood)
	let shared = 0, duplicated = 0, failures = 0;
	const differs = {};
	for ( let n = 0; n < chunks.length; n ++ ) {

		const a = chunks[ n ];
		for ( const [ di, dj ] of [ [ 1, 0 ], [ 0, 1 ], [ 1, 1 ], [ 1, - 1 ] ] ) {

			const m = index.get( `${ a.ci + di },${ a.cj + dj }` );
			if ( m === undefined ) continue;
			const mapB = maps[ m ];
			for ( const [ key, va ] of maps[ n ] ) {

				const vb = mapB.get( key );
				if ( ! vb ) continue;
				shared ++;
				if ( va.length > 1 || vb.length > 1 ) duplicated ++;
				const bad = sameVertex( a.island, va, chunks[ m ].island, vb );
				if ( bad ) {

					differs[ bad ] = ( differs[ bad ] ?? 0 ) + 1;
					if ( ++ failures <= 3 ) console.log( `FAIL S2 ${ ctx.label }: chunks ( ${ a.key } ) and ( ${ chunks[ m ].key } ) differ in ${ bad } at a shared vertex` );

				}

			}

		}

	}
	if ( failures ) ok = false;
	console.log( `${ failures ? 'FAIL' : 'ok  ' } S2 ${ ctx.label }: ${ shared } vertices shared by neighbouring chunks compared in position and ${ ATTRIBUTES.length } attributes, ` +
		`${ failures } differ${ failures ? ` (${ JSON.stringify( differs ) })` : '' }; ${ duplicated } of them sit twice at one position in a chunk` );

	// the 2 x 2 block whose chunks hold the most triangles, meshed in one call
	let best = null, most = - 1;
	for ( const c of chunks ) {

		const quad = [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ].map( ( [ di, dj ] ) => index.get( `${ c.ci + di },${ c.cj + dj }` ) );
		const tris = quad.reduce( ( sum, m ) => sum + ( m === undefined ? 0 : chunks[ m ].island.indices.length / 3 ), 0 );
		if ( tris > most ) { most = tris; best = { ci: c.ci, cj: c.cj, members: quad.filter( ( m ) => m !== undefined ) }; }

	}
	const { island: block, ms: netsMs } = await pool.run( () => ( { islandBlock: true, window: landWindow( ctx.field, best.ci, best.cj, 2 ), ci: best.ci, cj: best.cj } ), true );
	const blockMap = byPosition( block );
	let compared = 0, missing = 0, wrong = 0;
	const wrongBy = {};
	const triangles = new Map();
	const triangleKeys = ( mesh, sign ) => {

		for ( let k = 0; k < mesh.indices.length; k += 3 ) {

			const key = [ 0, 1, 2 ].map( ( o ) => positionKey( mesh.positions, mesh.indices[ k + o ] ) ).join( '|' );
			triangles.set( key, ( triangles.get( key ) ?? 0 ) + sign );

		}

	};
	triangleKeys( block, 1 );
	const chunkVertices = new Set();
	for ( const m of best.members ) {

		const c = chunks[ m ];
		triangleKeys( c.island, - 1 );
		for ( const [ key, va ] of maps[ m ] ) {

			chunkVertices.add( key );
			const vb = blockMap.get( key );
			compared ++;
			if ( ! vb ) { missing ++; continue; }
			const bad = sameVertex( c.island, va, block, vb );
			if ( bad ) { wrong ++; wrongBy[ bad ] = ( wrongBy[ bad ] ?? 0 ) + 1; }

		}

	}
	let unmatched = 0;
	for ( const n of triangles.values() ) unmatched += Math.abs( n );
	const extra = [ ...blockMap.keys() ].filter( ( key ) => ! chunkVertices.has( key ) ).length;
	const blockOk = missing === 0 && wrong === 0 && unmatched === 0 && extra === 0;
	if ( ! blockOk ) ok = false;
	console.log( `${ blockOk ? 'ok  ' : 'FAIL' } S2 ${ ctx.label }: block ( ${ best.ci }, ${ best.cj } ) - ( ${ best.ci + 1 }, ${ best.cj + 1 } ) in one call ` +
		`(${ block.indices.length / 3 } triangles, ${ ms( netsMs ) }) against its ${ best.members.length } chunks: ` +
		`${ compared } chunk vertices compared, ${ missing } missing, ${ wrong } differ${ wrong ? ` (${ JSON.stringify( wrongBy ) })` : '' }, ${ extra } block vertices in no chunk, ${ unmatched } triangles unmatched` );
	return ok;

}

// columns (--long): the inland column range must not change a bit.
function columns( ctx ) {

	let ok = true, inlandChunks = 0;
	for ( const c of ctx.chunks ) {

		if ( ! c.island ) continue;
		const window = landWindow( ctx.field, c.ci, c.cj );
		const whole = chunkIsland( window, c.ci, c.cj, 1, { columns: false } );
		inlandChunks ++;
		if ( hashBuffers( whole ) !== hashBuffers( c.island ) ) {

			ok = false;
			console.log( `FAIL columns ${ ctx.label } chunk ( ${ c.key } ): the column range changes the mesh` );

		}

	}
	console.log( `${ ok ? 'ok  ' : 'FAIL' } columns ${ ctx.label }: ${ inlandChunks } island chunks identical with whole columns` );
	return ok;

}

// D2: the chunks the pools of 1 and 4 workers built hash as the main pool's.
function threadCounts( runs, results ) {

	let ok = true;
	for ( const { seed, step, threads, hashes } of results ) {

		const main = runs.find( ( r ) => r.seed === seed ).steps[ step ].hashes;
		const differ = hashes.filter( ( [ key, hash ] ) => main.get( key ) !== hash ).map( ( [ key ] ) => key );
		if ( differ.length ) ok = false;
		console.log( `${ differ.length ? 'FAIL' : 'ok  ' } D2 seed ${ seed } step ${ step }: a pool of ${ threads } worker${ threads > 1 ? 's' : '' } built ${ hashes.length } chunks, ` +
			`${ differ.length } differ from the main pool's${ differ.length ? `: ${ differ.slice( 0, 6 ).join( '; ' ) }` : '' }` );

	}
	return ok;

}

const chunkMap = ( chunks ) => new Map( chunks.map( ( c ) => [ c.key, c ] ) );
const f32bits = ( a ) => new Uint32Array( a.buffer, a.byteOffset, a.length );
const sameBits = ( a, b ) => a.length === b.length && Buffer.compare( Buffer.from( a.buffer, a.byteOffset, a.byteLength ), Buffer.from( b.buffer, b.byteOffset, b.byteLength ) ) === 0;

// S3: the floor tiles' border lattice points, which two (or four) tiles both compute.
function floorSeams( ctx ) {

	const N = TILE_SIDE, map = chunkMap( ctx.chunks );
	const bits = ( f, v ) => [ ...f32bits( f.height ).subarray( v, v + 1 ), ...f32bits( f.normal ).subarray( v * 3, v * 3 + 3 ), ...f32bits( f.ao ).subarray( v, v + 1 ), ...f32bits( f.bed ).subarray( v * 2, v * 2 + 2 ) ].join( ',' );
	let shared = 0, differ = 0, tiles = 0;
	for ( const a of ctx.chunks ) {

		if ( ! a.floor ) continue;
		tiles ++;
		// the neighbour's offset, then the pairs of point indices on the common border
		const pairs = [
			[ 1, 0, Array.from( { length: N }, ( _, k ) => [ k * N + N - 1, k * N ] ) ],
			[ 0, 1, Array.from( { length: N }, ( _, k ) => [ ( N - 1 ) * N + k, k ] ) ],
			[ 1, 1, [ [ N * N - 1, 0 ] ] ],
			[ 1, - 1, [ [ N - 1, ( N - 1 ) * N ] ] ],
		];
		for ( const [ di, dj, list ] of pairs ) {

			const b = map.get( `${ a.ci + di },${ a.cj + dj }` );
			if ( ! b?.floor ) continue;
			for ( const [ va, vb ] of list ) {

				shared ++;
				if ( bits( a.floor, va ) !== bits( b.floor, vb ) && ++ differ <= 3 ) console.log( `FAIL S3 ${ ctx.label }: floor tiles ( ${ a.key } ) and ( ${ b.key } ) differ at a shared point` );

			}

		}

	}
	console.log( `${ differ ? 'FAIL' : 'ok  ' } S3 ${ ctx.label }: ${ tiles } floor tiles, ${ shared } shared lattice points compared in height, normal, ao and bed: ${ differ } differ` );

	// Off the land the floor stays at or below the shelf's ceiling (Bathymetry.ts SHELF_CEILING), and
	// a tile side with no tile beyond it meets the far floor there: it must lie on the open sea's
	// lattice, bit for bit (the far floor's heights, its normals by the same differences, its beds,
	// unshaded), or the seam between the near tiles and the far floor cracks.
	const fp = windowFootprint( ctx.field ), h = openSeaHeight;
	const open = new Float32Array( 7 ), tile = new Float32Array( 7 );
	let points = 0, high = 0, highest = - Infinity, border = 0, off = 0, sides = 0;
	for ( const a of ctx.chunks ) {

		if ( ! a.floor ) continue;
		const { height, normal, ao, bed } = a.floor;
		for ( let v = 0; v < N * N; v ++ ) {

			const x = a.ci * S + ( v % N ) * FLOOR_STEP, z = a.cj * S + Math.floor( v / N ) * FLOOR_STEP;
			if ( fp.dist( x, z ) <= 0 ) continue;
			points ++;
			highest = Math.max( highest, height[ v ] );
			if ( height[ v ] > SHELF_CEILING && ++ high <= 3 ) console.log( `FAIL S3 ${ ctx.label }: floor tile ( ${ a.key } ) rises to ${ height[ v ] } m off the land at ( ${ x }, ${ z } )` );

		}
		for ( const [ di, dj ] of [ [ - 1, 0 ], [ 1, 0 ], [ 0, - 1 ], [ 0, 1 ] ] ) {

			// a neighbouring chunk (with a tile, or under the land) is no border with the far floor
			if ( map.has( `${ a.ci + di },${ a.cj + dj }` ) ) continue;
			sides ++;
			for ( let k = 0; k < N; k ++ ) {

				const i = di === - 1 ? 0 : di === 1 ? N - 1 : k, j = dj === - 1 ? 0 : dj === 1 ? N - 1 : k, v = j * N + i;
				const x = a.ci * S + i * FLOOR_STEP, z = a.cj * S + j * FLOOR_STEP;
				// as SeabedTile.ts buildFarFloor makes a node, in float32
				const nx = ( h( x - FLOOR_STEP, z ) - h( x + FLOOR_STEP, z ) ) / ( 2 * FLOOR_STEP ), nz = ( h( x, z - FLOOR_STEP ) - h( x, z + FLOOR_STEP ) ) / ( 2 * FLOOR_STEP );
				const l = Math.hypot( nx, 1, nz );
				open.set( [ h( x, z ), nx / l, 1 / l, nz / l, ...openSeaBeds( x, z ), 1 ] );
				tile.set( [ height[ v ], ...normal.subarray( v * 3, v * 3 + 3 ), ...bed.subarray( v * 2, v * 2 + 2 ), ao[ v ] ] );
				border ++;
				if ( ! sameBits( open, tile ) && ++ off <= 3 ) console.log( `FAIL S3 ${ ctx.label }: floor tile ( ${ a.key } ) leaves the open sea's lattice at its outer border ( ${ x }, ${ z } ): ${ [ ...tile ].join( ', ' ) } against ${ [ ...open ].join( ', ' ) }` );

			}

		}

	}
	console.log( `${ high ? 'FAIL' : 'ok  ' } S3 ${ ctx.label }: ${ points } floor points off the land (land distance > 0), the highest at ${ highest.toFixed( 3 ) } m: ${ high } above ${ SHELF_CEILING } m` );
	console.log( `${ off ? 'FAIL' : 'ok  ' } S3 ${ ctx.label }: ${ sides } tile sides with no chunk beyond, ${ border } points compared with the open sea's lattice in height, normal, bed and ao (1): ${ off } differ` );
	return differ === 0 && high === 0 && off === 0;

}

// S4: the turf skirt's pieces that cross a chunk border meet a piece of the neighbour there, with
// the same crossing sample (ring points, normals, coast data).
const RING = 1e-5;
function skirtSeams( ctx ) {

	const map = chunkMap( ctx.chunks );
	const endsOf = ( c ) => {

		const { points, normals, info, pieces } = c.skirt, ends = [];
		const sample = ( q, start ) => ( {
			key: c.key, start, x: info[ q * SKIRT_INFO ], z: info[ q * SKIRT_INFO + 1 ],
			data: [ ...points.subarray( q * SKIRT_RING * 3, ( q + 1 ) * SKIRT_RING * 3 ), ...normals.subarray( q * SKIRT_RING * 3, ( q + 1 ) * SKIRT_RING * 3 ), ...info.subarray( q * SKIRT_INFO, ( q + 1 ) * SKIRT_INFO ) ],
		} );
		for ( let k = 0; k < pieces.length; k += 2 ) {

			const a = sample( pieces[ k ], true ), b = sample( pieces[ k ] + pieces[ k + 1 ] - 1, false );
			// a loop inside the chunk ends where it starts
			if ( a.x !== b.x || a.z !== b.z ) ends.push( a, b );

		}
		return ends;

	};
	const ends = new Map( ctx.chunks.map( ( c ) => [ c.key, endsOf( c ) ] ) );
	let crossings = 0, identical = 0, worst = 0, failures = 0;
	const fail = ( text ) => { if ( ++ failures <= 3 ) console.log( `FAIL S4 ${ ctx.label }: ${ text }` ); };
	for ( const c of ctx.chunks ) for ( const e of ends.get( c.key ) ) {

		const b = chunkBox( c.ci, c.cj ), on = ( v, line ) => Math.abs( v - line ) < 1e-9;
		if ( ! ( on( e.x, b.x0 ) || on( e.x, b.x1 ) || on( e.z, b.z0 ) || on( e.z, b.z1 ) ) ) { fail( `chunk ( ${ c.key } ): a skirt piece ends inside it at ( ${ e.x }, ${ e.z } )` ); continue; }
		// a start meets an end: count each crossing once, at its start
		if ( ! e.start ) continue;
		const found = [];
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

			if ( ! di && ! dj ) continue;
			const n = map.get( `${ c.ci + di },${ c.cj + dj }` );
			if ( n ) for ( const o of ends.get( n.key ) ) if ( ! o.start && Math.abs( o.x - e.x ) <= RING && Math.abs( o.z - e.z ) <= RING ) found.push( o );

		}
		if ( found.length !== 1 ) { fail( `chunk ( ${ c.key } ): a skirt piece starting at ( ${ e.x }, ${ e.z } ) meets ${ found.length } pieces across the border` ); continue; }
		crossings ++;
		let d = 0;
		for ( let k = 0; k < e.data.length; k ++ ) d = Math.max( d, Math.abs( e.data[ k ] - found[ 0 ].data[ k ] ) );
		worst = Math.max( worst, d );
		if ( d === 0 ) identical ++;
		else if ( d > RING ) fail( `chunks ( ${ c.key } ) and ( ${ found[ 0 ].key } ): the crossing at ( ${ e.x }, ${ e.z } ) differs by ${ d }` );

	}
	// every end was paired: as many ends as starts were matched
	const unpaired = ctx.chunks.reduce( ( n, c ) => n + ends.get( c.key ).filter( ( e ) => ! e.start ).length, 0 ) - crossings;
	if ( unpaired && ! failures ) fail( `${ unpaired } skirt pieces end on a border where none starts` );
	console.log( `${ failures ? 'FAIL' : 'ok  ' } S4 ${ ctx.label }: ${ crossings } skirt crossings of chunk borders, each one piece ending where one starts across it; ` +
		`${ identical } bit-identical, the largest difference ${ worst.toExponential( 1 ) } (at most ${ RING })` );
	return failures === 0;

}

// S6: every stone is owned by the one chunk its centre lies in, and the stones a chunk places
// round itself for the contact shade are, bit for bit, the stones their own chunks keep.
const ROCK = [ 'x', 'z', 's', 'sy', 'y', 'floor', 'rot', 'seed' ];
function stoneOwners( ctx ) {

	const map = chunkMap( ctx.chunks ), owner = new Map();
	const at = ( r ) => `${ r.x },${ r.z }`;
	let owned = 0, twice = 0, astray = 0, compared = 0, differ = 0, missing = 0, nowhere = 0, own = 0;
	for ( const c of ctx.chunks ) for ( const r of c.rocks ) {

		const b = chunkBox( c.ci, c.cj );
		owned ++;
		if ( r.x < b.x0 || r.x >= b.x1 || r.z < b.z0 || r.z >= b.z1 ) astray ++;
		if ( owner.has( at( r ) ) ) twice ++;
		owner.set( at( r ), r );

	}
	for ( const c of ctx.chunks ) for ( const r of c.contact ) {

		// the chunk's own stones are among those it places round itself: no other chunk to compare with
		if ( Math.floor( r.x / S ) === c.ci && Math.floor( r.z / S ) === c.cj ) { own ++; continue; }
		if ( ! map.has( `${ Math.floor( r.x / S ) },${ Math.floor( r.z / S ) }` ) ) { nowhere ++; continue; }
		const o = owner.get( at( r ) );
		compared ++;
		if ( ! o ) missing ++;
		else if ( ! ROCK.every( ( k ) => Object.is( o[ k ], r[ k ] ) ) ) differ ++;

	}
	const ok = twice === 0 && astray === 0 && missing === 0 && differ === 0;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } S6 ${ ctx.label }: ${ owned } stones owned, ${ twice } twice, ${ astray } outside their chunk; ` +
		`${ compared } contact copies of neighbours' stones held by chunks against their owners: ${ missing } unowned, ${ differ } differ (${ nowhere } more lie in no chunk, ${ own } are the chunk's own)` );
	return ok;

}

// I1: no buried wall inland (inlandColumns, in the job).
function inland( ctx ) {

	let columns = 0, samples = 0, vertices = 0, failures = 0;
	const bad = [];
	for ( const c of ctx.chunks ) {

		const r = c.inland;
		columns += r.columns; samples += r.samples; vertices += r.vertices; failures += r.failures;
		for ( const b of r.bad ) if ( bad.length < 3 ) bad.push( `chunk ( ${ c.key } ): ${ b }` );

	}
	for ( const b of bad ) console.log( `FAIL I1 ${ ctx.label }: ${ b }` );
	console.log( `${ failures ? 'FAIL' : 'ok  ' } I1 ${ ctx.label }: ${ columns } inland columns (land distance < ${ INLAND } m, every ${ COLUMN } m) solid from the lattice's bottom to 0.35 m below the top ` +
		`(${ samples } samples every ${ LAYER } m) and clear 0.6 m above it, ${ vertices } inland island vertices none below that: ${ failures } failures` );
	return failures === 0;

}

// S5: the 2 x 2 block with the most rim items (bushes and trail patches), made in one pass from its
// own window (`chunkBlock`), shares out exactly its four chunks' rim ground, shore and walk texels,
// anchors, bushes and trail patches.
async function blockShare( ctx, pool ) {

	const map = chunkMap( ctx.chunks );
	let best = null, most = - 1;
	for ( const c of ctx.chunks ) {

		const quad = [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ].map( ( [ di, dj ] ) => map.get( `${ c.ci + di },${ c.cj + dj }` ) );
		if ( quad.some( ( q ) => ! q ) ) continue;
		const items = quad.reduce( ( n, q ) => n + q.bushes.length / BUSH_STRIDE + q.strands.length, 0 );
		if ( items > most ) { most = items; best = c; }

	}
	// (the worker's own time: queueing behind the pool's other jobs left out)
	const { members, ms: blockMs } = await pool.run( () => ( { block: true, window: landWindow( ctx.field, best.ci, best.cj, 2 ), ci: best.ci, cj: best.cj } ), true );
	const strandText = ( list ) => JSON.stringify( list, ( _, v ) => ArrayBuffer.isView( v ) ? Array.from( f32bits( v ) ) : v );
	const fields = [ 'rimGround', 'shore', 'walk', 'anchors', 'bushes', 'strands' ];
	const differ = [], counts = { texels: 0, anchors: 0, bushes: 0, strands: 0 };
	for ( const m of members ) {

		const c = map.get( m.key );
		counts.texels += c.rimGround.length / 4 + c.shore.length + c.walk.length;
		counts.anchors += c.anchors.length / VEGETATION_STRIDE; counts.bushes += c.bushes.length / BUSH_STRIDE; counts.strands += c.strands.length;
		for ( const f of fields ) {

			const same = f === 'strands' ? strandText( m.strands ) === strandText( c.strands ) : sameBits( m[ f ], c[ f ] );
			if ( ! same ) differ.push( `${ f } of ( ${ m.key } )` );

		}

	}
	const ok = differ.length === 0;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } S5 ${ ctx.label }: block ( ${ best.ci }, ${ best.cj } ) - ( ${ best.ci + 1 }, ${ best.cj + 1 } ) in one pass (${ ms( blockMs ) }) against its chunks: ` +
		`${ counts.texels } texels (rim ground, shore, walk), ${ counts.anchors } anchors, ${ counts.bushes } bushes, ${ counts.strands } trail patches: ` +
		`${ ok ? 'all equal, bit for bit' : `differ in ${ differ.join( ', ' ) }` }` );
	return ok;

}

// --bench: what each growth piece costs: the land field (main thread), the chunks `dirtyChunks`
// rebuilds (CPU time summed over their jobs, how many come out changed) and their bytes.
function costs( run ) {

	const lines = [];
	let cpu = 0, rebuilt = 0, changedAll = 0, bytesAll = 0;
	for ( let n = 0; n < run.steps.length; n ++ ) {

		const s = run.steps[ n ], before = run.steps[ n - 1 ];
		const keys = n ? dirtyChunks( before.land, s.land ) : s.keys;
		const byKey = chunkMap( s.chunks );
		const ms = keys.reduce( ( sum, key ) => sum + byKey.get( key ).timings.total, 0 );
		const bytes = keys.reduce( ( sum, key ) => sum + byKey.get( key ).bytes, 0 );
		const changed = n ? keys.filter( ( key ) => before.hashes.get( key ) !== s.hashes.get( key ) ).length : keys.length;
		if ( n ) { cpu += ms; rebuilt += keys.length; changedAll += changed; bytesAll += bytes; }
		lines.push( `       ${ n ? `piece ${ n }` : 'start  ' }: land field ${ s.fieldMs.toFixed( 0 ) } ms, ${ keys.length } chunks rebuilt, ${ changed } changed, ` +
			`CPU ${ ( ms / 1000 ).toFixed( 1 ) } s (${ ( ms / keys.length ).toFixed( 0 ) } ms per chunk), ${ ( bytes / 1048576 ).toFixed( 1 ) } MB` );

	}
	const pieces = run.steps.length - 1;
	console.log( `     bench seed ${ run.seed }: per growth piece (CPU time summed over the chunks' jobs on the pool):` );
	console.log( lines.join( '\n' ) );
	console.log( `       mean per piece: ${ ( rebuilt / pieces ).toFixed( 1 ) } chunks rebuilt, ${ ( changedAll / pieces ).toFixed( 1 ) } changed, CPU ${ ( cpu / pieces / 1000 ).toFixed( 1 ) } s, ${ ( bytesAll / pieces / 1048576 ).toFixed( 1 ) } MB` );

}

// ------------------------------------------------------------------ the chunk sheet

// One PNG per seed, a panel per step left to right, then down: the sea, the chunks (lighter), the
// land, the step's new piece (orange), the 16 m grid, the dirty chunks outlined (yellow) and the
// chunks that changed tinted red. Written to --sheets (default artifacts/captures/world-chunks/).
const PX = 3, GAP = 12, COLUMNS = 4;
function sheet( run ) {

	const lastKeys = run.steps[ run.steps.length - 1 ].keys.map( parseChunkKey );
	const ci0 = Math.min( ...lastKeys.map( ( k ) => k[ 0 ] ) ), ci1 = Math.max( ...lastKeys.map( ( k ) => k[ 0 ] ) ) + 1;
	const cj0 = Math.min( ...lastKeys.map( ( k ) => k[ 1 ] ) ), cj1 = Math.max( ...lastKeys.map( ( k ) => k[ 1 ] ) ) + 1;
	const pw = ( ci1 - ci0 ) * S * PX, ph = ( cj1 - cj0 ) * S * PX;
	const rows = Math.ceil( run.steps.length / COLUMNS );
	const W = COLUMNS * pw + ( COLUMNS + 1 ) * GAP, H = rows * ph + ( rows + 1 ) * GAP;
	const image = new Uint8Array( W * H * 3 ).fill( 24 );
	const N = Math.round( 2 * GROWTH.half / GROWTH.cell );
	const bit = ( land, x, z ) => {

		const i = Math.floor( ( x + GROWTH.half ) / GROWTH.cell ), j = Math.floor( ( z + GROWTH.half ) / GROWTH.cell );
		if ( i < 0 || j < 0 || i >= N || j >= N ) return 0;
		const k = j * N + i;
		return ( land.words[ k >>> 5 ] >>> ( k & 31 ) ) & 1;

	};
	run.steps.forEach( ( s, n ) => {

		const before = run.steps[ n - 1 ];
		const keys = new Set( s.keys ), dirty = new Set( n ? dirtyChunks( before.land, s.land ) : [] );
		const changed = new Set( n ? s.keys.filter( ( key ) => before.hashes.get( key ) !== s.hashes.get( key ) ) : [] );
		const ox = GAP + ( n % COLUMNS ) * ( pw + GAP ), oy = GAP + Math.floor( n / COLUMNS ) * ( ph + GAP );
		for ( let py = 0; py < ph; py ++ ) for ( let px = 0; px < pw; px ++ ) {

			const x = ci0 * S + ( px + 0.5 ) / PX, z = cj0 * S + ( py + 0.5 ) / PX;
			const ci = Math.floor( x / S ), cj = Math.floor( z / S ), key = `${ ci },${ cj }`;
			let c = keys.has( key ) ? [ 38, 78, 100 ] : [ 22, 46, 62 ];
			if ( bit( s.land, x, z ) ) c = n && ! bit( before.land, x, z ) ? [ 240, 150, 40 ] : [ 140, 170, 100 ];
			if ( changed.has( key ) ) c = [ c[ 0 ] * 0.6 + 200 * 0.4, c[ 1 ] * 0.6 + 40 * 0.4, c[ 2 ] * 0.6 + 40 * 0.4 ];
			const lx = px % ( S * PX ), ly = py % ( S * PX );
			if ( lx === 0 || ly === 0 ) c = [ 12, 24, 32 ];
			if ( dirty.has( key ) && ( lx < 2 || ly < 2 || lx >= S * PX - 2 || ly >= S * PX - 2 ) ) c = [ 250, 220, 60 ];
			image.set( c.map( Math.round ), ( ( oy + py ) * W + ox + px ) * 3 );

		}

	} );
	const dir = argument( '--sheets', fileURLToPath( new URL( '../artifacts/captures/world-chunks/', import.meta.url ) ) );
	mkdirSync( dir, { recursive: true } );
	const path = join( dir, `chunks-seed${ run.seed }.png` );
	writeFileSync( path, png( image, W, H ) );
	console.log( `     sheet ${ path } (${ W } x ${ H }, steps 0 - ${ run.steps.length - 1 })` );

}

// An 8-bit RGB PNG.
function png( rgb, w, h ) {

	const raw = Buffer.alloc( ( w * 3 + 1 ) * h );
	for ( let y = 0; y < h; y ++ ) Buffer.from( rgb.buffer, y * w * 3, w * 3 ).copy( raw, y * ( w * 3 + 1 ) + 1 );
	const chunk = ( type, data ) => {

		const out = Buffer.alloc( data.length + 12 );
		out.writeUInt32BE( data.length, 0 );
		out.write( type, 4, 'latin1' );
		data.copy( out, 8 );
		out.writeUInt32BE( crc32( out.subarray( 4, 8 + data.length ) ), 8 + data.length );
		return out;

	};
	const header = Buffer.alloc( 13 );
	header.writeUInt32BE( w, 0 ); header.writeUInt32BE( h, 4 );
	header[ 8 ] = 8; header[ 9 ] = 2;
	return Buffer.concat( [ Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ), chunk( 'IHDR', header ), chunk( 'IDAT', deflateSync( raw ) ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] );

}

if ( isMainThread && ! process.argv.includes( '--scratch' ) ) await main();
