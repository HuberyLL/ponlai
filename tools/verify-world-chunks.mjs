// Chunk checks for the world generator (plain node, CPU only):
//   node tools/verify-world-chunks.mjs [--seeds 1,2] [--steps 12] [--threads n] [--long]
//
// The world is generated per chunk (src/world/Chunks.ts): S = 16 m squares on the world grid, each
// from its window (the chunk grown by R = 32 m) of the land field alone. For every seed the runner
// grows the land step by step (0 .. --steps), builds every chunk of every step on a pool of worker
// threads (`buildChunk`, each job handed its window as the page's workers will be), and runs the
// checks below on the hashes and, at the S steps, on the chunks' meshes. A check prints `ok` /
// `FAIL` lines and returns whether it passed; any failure sets the exit code. The default run builds
// 1219 chunks (seeds 1 - 2, steps 0 - 12; about half a second each on one thread, a coastal chunk up
// to two) and took 230 s on 8 threads of a machine busy with other work; `--long` adds what the
// default leaves out (marked below) and took 16 minutes there.
//
//   D1  incremental equals scratch: step n's chunks built incrementally (every chunk of step 0,
//       then at each step only `dirtyChunks` from the step before, the others kept) hash as step n
//       built from scratch in a fresh process, one chunk after another in reverse key order. The
//       default builds the last step from scratch, --long every step.
//   D3  the land does not depend on the order its pieces are applied: a piece is the cells a growth
//       step adds, immutable once placed (IslandGrowth.ts). Which piece comes next depends on the
//       land before it, so the growth itself has one order; "piece order" here is the order a land
//       is assembled from its pieces (a save loaded, a worker handed the pieces): the union of the
//       cells. The last step's pieces applied in reverse, shuffled, and with the starting island
//       last give the same cells, chunk keys and land field as the grown land, bit for bit (the
//       recent headings a land also keeps do follow the order: no chunk reads them).
//   D4  the dirty set: between consecutive steps every chunk whose hash changed (or that is new)
//       is in `dirtyChunks`, and none outside it changed. Prints the chunks, how many are dirty,
//       how many changed, and how far the farthest changed chunk lies from the changed land.
//   S1  at the S steps (0 and the last; --long every fourth): the welded union of the chunks'
//       island and stone meshes is closed: no boundary edge, and at most 1.3 non-manifold edges per
//       1000 triangles (the ambiguous cells of surface nets). The page's single island mesh has
//       0.65 - 0.88 per 1000 on seeds 1 - 2 at steps 0 and 12 once its bottom face is left out:
//       x 1.5. The chunks leave the bottom face out by design (SurfaceNets.ts: never seen below the
//       sea floor), so the walls end open at the lattice's bottom row: a boundary edge with both ends
//       in that row (y < -5.1 + one voxel) is counted as the open foot instead.
//   S2  at the S steps: seams. Every island vertex two chunks share (the same position bits)
//       carries the same bits in every attribute in both, contact shade included; and the 2 x 2
//       block of chunks holding the most triangles, meshed in one call from its own window on the
//       same lattice (`chunkIsland`), has exactly the vertices (all attributes) and triangles of
//       its four chunks.
//   columns  (--long, at the S steps) every chunk with inland columns meshed with the inland column
//       range (WorldShapes.islandColumnRange) is byte-identical to the chunk meshed with whole
//       columns.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { spawn } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { LandLattice, nextPiece, GROWTH } from '../src/world/IslandGrowth.ts';
import {
	buildChunk, chunkIsland, chunkKeys, dirtyChunks, landField, landWindow, parseChunkKey, S,
} from '../src/world/Chunks.ts';
import { ISLAND_BOTTOM } from '../src/world/WorldShapes.ts';
import { hashBuffers, meshClosure, positionKey } from './world-node.mjs';

// ------------------------------------------------------------------ the worker

// A job: one chunk from its window and the land; the reply carries its hash and timings, and its
// meshes when the S checks need them.
if ( ! isMainThread ) {

	let land = null, version = - 1;
	parentPort.on( 'message', ( job ) => {

		if ( job.version !== version ) { land = LandLattice.fromBytes( job.land ); version = job.version; }
		const c = buildChunk( job.window, land, job.ci, job.cj, { version: job.version } );
		const reply = { id: job.id, hash: c.hash, timings: c.timings };
		const transfer = [];
		if ( job.keep ) {

			reply.island = c.island;
			reply.stones = c.stones.mesh;
			for ( const m of [ c.island, c.stones.mesh ] ) if ( m ) for ( const a of Object.values( m ) ) if ( ! transfer.includes( a.buffer ) ) transfer.push( a.buffer );

		}
		parentPort.postMessage( reply, transfer );

	} );

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
	const long = process.argv.includes( '--long' );
	const seeds = argument( '--seeds', '1,2' ).split( ',' ).map( Number );
	const last = Number( argument( '--steps', '12' ) );
	const threads = Number( argument( '--threads', String( Math.max( 1, Math.min( 8, availableParallelism() - 4 ) ) ) ) );
	const sSteps = long ? [ ...new Set( [ ...Array.from( { length: Math.floor( last / 4 ) + 1 }, ( _, k ) => k * 4 ), last ] ) ] : [ ...new Set( [ 0, last ] ) ];
	const scratchSteps = long ? Array.from( { length: last + 1 }, ( _, k ) => k ) : [ last ];
	console.log( `seeds ${ seeds.join( ', ' ) }, steps 0 - ${ last }, ${ threads } threads${ long ? ', long' : '' }` );

	// D1's fresh processes, one per seed, run alongside the pool
	const scratch = seeds.map( ( seed ) => runScratch( seed, scratchSteps ) );

	const pool = new Pool( threads );
	const runs = [];
	for ( const seed of seeds ) {

		const { lands, pieces } = grow( seed, last );
		const steps = [];
		for ( let step = 0; step <= last; step ++ ) {

			const land = lands[ step ], field = landField( land ), keys = chunkKeys( land ), keep = sSteps.includes( step );
			const bytes = land.toBytes();
			const version = seed * 1000 + step;
			steps.push( { step, land, keys, field: keep ? field : null, chunks: Promise.all( keys.map( ( key ) => {

				const [ ci, cj ] = parseChunkKey( key );
				return pool.run( () => ( { window: landWindow( field, ci, cj ), land: bytes, ci, cj, version, keep } ) )
					.then( ( reply ) => ( { key, ci, cj, ...reply } ) );

			} ) ) } );
			// let the pool's replies in: a land field takes the main thread a moment
			await new Promise( ( resolve ) => setImmediate( resolve ) );

		}
		runs.push( { seed, lands, pieces, steps } );

	}

	let failed = 0;
	const timings = {};
	let built = 0;
	for ( const run of runs ) {

		for ( const s of run.steps ) {

			s.chunks = await s.chunks;
			s.hashes = new Map( s.chunks.map( ( c ) => [ c.key, c.hash ] ) );
			for ( const c of s.chunks ) { built ++; for ( const [ k, v ] of Object.entries( c.timings ) ) timings[ k ] = ( timings[ k ] ?? 0 ) + v; }

		}
		console.log( `---- seed ${ run.seed }: ${ run.steps.map( ( s ) => s.keys.length ).join( ', ' ) } chunks at steps 0 - ${ last } (${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s)` );
		if ( ! dirtySet( run ) ) failed ++;
		if ( ! pieceOrder( run ) ) failed ++;
		for ( const s of run.steps ) if ( sSteps.includes( s.step ) ) {

			const ctx = { label: `seed ${ run.seed } step ${ s.step }`, field: s.field, chunks: s.chunks };
			for ( const check of long ? [ closed, seams, columns ] : [ closed, seams ] ) if ( ! check( ctx ) ) failed ++;
			s.field = null;

		}

	}
	pool.close();
	const per = Object.entries( timings ).map( ( [ k, v ] ) => `${ k } ${ ( v / built ).toFixed( 0 ) }` ).join( ', ' );
	console.log( `     ${ built } chunks built on the pool, ms per chunk: ${ per }` );

	for ( const [ n, run ] of runs.entries() ) if ( ! incremental( run, await scratch[ n ] ) ) failed ++;

	console.log( `     done in ${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s` );
	if ( failed ) {

		console.log( `${ failed } checks failed.` );
		process.exit( 1 );

	}
	console.log( 'All chunk checks passed.' );

}

// A pool of worker threads, each building one chunk at a time. `run( make )` queues a job; `make`
// builds its message when a worker takes it (a window is 4 MB: they are cut only then).
class Pool {

	constructor( n ) {

		this.queue = [];
		this.waiting = new Map();
		this.id = 0;
		this.idle = Array.from( { length: n }, () => {

			const worker = new Worker( fileURLToPath( import.meta.url ) );
			worker.on( 'message', ( reply ) => {

				const resolve = this.waiting.get( reply.id );
				this.waiting.delete( reply.id );
				this.idle.push( worker );
				this.next();
				resolve( reply );

			} );
			worker.on( 'error', ( error ) => { throw error; } );
			return worker;

		} );

	}

	run( make ) {

		return new Promise( ( resolve ) => {

			this.queue.push( { make, resolve } );
			this.next();

		} );

	}

	next() {

		while ( this.idle.length && this.queue.length ) {

			const worker = this.idle.pop(), { make, resolve } = this.queue.shift(), id = this.id ++;
			const job = { id, ...make() };
			this.waiting.set( id, resolve );
			worker.postMessage( job, [ job.window.data.buffer ] );

		}

	}

	close() {

		for ( const worker of this.idle ) worker.terminate();

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

// the island mesh's lattice (Chunks.ts)
const VOXEL = 0.125, Y0 = ISLAND_BOTTOM + 0.5;
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
function seams( ctx ) {

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
	const t = performance.now();
	const block = chunkIsland( landWindow( ctx.field, best.ci, best.cj, 2 ), best.ci, best.cj, 2 );
	const netsMs = performance.now() - t;
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

if ( isMainThread && ! process.argv.includes( '--scratch' ) ) await main();
