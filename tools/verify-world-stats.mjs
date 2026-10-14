// Statistical checks for the chunked world generator (plain node, CPU only):
//   node tools/verify-world-stats.mjs [--seeds 1,2] [--grow 0,8] [--threads n]
//
// tools/verify-world-chunks.mjs proves the chunks' seams and locality (a chunk equals itself built
// incrementally, from scratch and as part of a block), not that what they make still has the
// statistics the island's look was tuned on. This probe keeps those: for every seed and growth
// step it builds every chunk of the whole island (`buildChunk` on a pool of worker threads, each
// job handed its window of the land field) and measures the union of the chunks' owned items.
// The contact shade is off (`contactOcclusion: false`): it only sets the anchors' and bushes' sky
// visibility, which no statistic counts.
//
//   meadow  the turf anchors of every chunk, the grass tufts and wildflowers planted on them (from
//           the chunks' rim ground texels, assembled), per m^2 of land, against the counts before
//           the anchors were hashed (M2; the lawn's extra tufts, since picked by
//           hash rather than a field, keep its count). Starting islands are printed only (a fresh
//           draw moves their 250 flower beds and the extra tufts by up to 25 %); the sum over
//           the grown islands run (step 8 on) is within 5 % for every kind.
//   rim     the chunks' bushes and trail strands. Per island: every trail patch (the strands rooted
//           at one lip) holds 1 - 9 strands, no node sinks below a quarter of its root's height
//           above the sea, the median bare run along the coast between patches is 0.4 - 4 m and
//           none is longer than 4 m (a run that cuts across a notch counts at the notch's mouth:
//           `trailStats`). Against integrate/isle-m3 (M3, one running stream): bushes on each grown
//           island within 10 %; bushes, root strands and the length hanging more than a quarter
//           metre below the turf, summed over the islands run, within 10 %. The coast the runs are
//           measured along is traced on one lattice over the land field the chunks window, with
//           the island solid every chunk evaluates (its values are functions of the point).
//   stones  on each seed and step run: no two stones overlap, every crown lies at or below
//           -1.30 m, every stone lies within its class's reach of its cell (`checkStones`). Once
//           per run, over seeds 1 - 6 at steps 0, 8 and 16, per 100 m of coast against today's
//           placement (one running stream) on the same islands: each class within 20 % (TODAY),
//           so are the large stones (SIZES), and stones of 0.6 m or more within 2.5 m of the coast
//           lie denser below the wall's scars than elsewhere (today 1.4 times). The density islands
//           place each chunk's stones from its window exactly as `buildChunk` does (its footprint,
//           local island solid and floor), with their classes; on the seeds and steps run, those
//           are checked equal to the built chunks' stones.
//   scars   on each seed and step run, every scar of the cliff, measured in the chunk that holds
//           its anchor on that chunk's own wall (a CliffWall over its window): the rock it cuts lies
//           within its reach of its anchor (tier A 4.5 m, tier B 3 m), so the clamp of its box
//           trims nothing, and where it breaks off along the octagon round its anchor the rock its
//           own planes would have cut beyond it above y -1 is at most 0.6 m thick (`chunkScars`).
//
// Every failed bound prints FAIL and sets the exit code; the run goes on to print every number.
// A pass is recorded (tools/verify-cache.mjs): a later run with the same arguments, node and source
// files (the script's whole import graph) prints that it was skipped and exits 0; --force runs it.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { growLand, LandLattice } from '../src/world/IslandGrowth.ts';
import { buildChunk, chunkKeys, landField, landWindow, parseChunkKey, windowFootprint, R, S } from '../src/world/Chunks.ts';
import { coastWobble, islandSurfaceHeight, landArea, landBounds, makeIslandSDF, ISLAND_BOTTOM } from '../src/world/WorldShapes.ts';
import { CliffWall } from '../src/world/Cliff.ts';
import { floorAt } from '../src/world/Bathymetry.ts';
import { placeStones, rockExtent, CELL, REACH } from '../src/world/Stones.ts';
import { assembleRimGround, coastChains, rimBoxes, RIM_CELL } from '../src/world/RimGround.ts';
import { hanging } from '../src/world/RimTrails.ts';
import { BUSH_STRIDE } from '../src/world/FoliageSites.ts';
import { VEGETATION_STRIDE } from '../src/world/types.ts';
import { verifyCache } from './verify-cache.mjs';
import { simplifierReady } from '../src/world/IslandSimplify.ts';

// the island's simplifier (wasm) is ready before any chunk is built, in every thread
await simplifierReady;

const grow = ( b, m ) => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

// ------------------------------------------------------------------ the stones of one chunk

// Where the wall above a coast point counts as scarred (the island's shed), for the blocks gathered
// below its scars.
const SCAR = 0.4;
// the coast's sampling step (m): the band of points just outside the footprint's edge
const COAST_STEP = 0.25;

// Today's stones per 100 m of coast by class (the cobbles with their blocks), from the running
// stream's placement on seeds 1 - 6 at steps 0, 8 and 16 (3603 m of coast): 255 in all, as main's
// 258 on the tile island.
const CLASS = [ 'fallen blocks', 'near patches', 'outer patches', 'isolated' ];
const TODAY = [ 71.6, 136.9, 35.9, 11.0 ];

// Today's large stones per 100 m of coast on the same islands: fallen blocks of size 0.6 m or more
// (the size the cobbles stay below), stones of 0.6 m or more within 2.5 m and within 8 m of the
// coast, and stones over 1.7 m within 8 m (the largest blocks and the patches' main fragments).
const SIZES = [
	{ label: 'fallen blocks', today: 28.6, test: ( r, c ) => c === 0 && r.s >= 0.6 },
	{ label: 'stones of 0.6 m or more within 2.5 m', today: 26.4, test: ( r, c, d ) => r.s >= 0.6 && d < 2.5 },
	{ label: 'stones of 0.6 m or more within 8 m', today: 58.0, test: ( r, c, d ) => r.s >= 0.6 && d < 8 },
	{ label: 'stones over 1.7 m within 8 m', today: 4.8, test: ( r, c, d ) => r.s > 1.7 && d < 8 },
];

// The chunk's stones as `buildChunk` places them (its window's footprint, the island solid over the
// chunk and R round it, the floor), owned by their centre, with their cells ( class, ci, cj ), and
// the chunk's share of the density statistics: the coast's length and its scarred part (the sample
// points in the chunk), the large stones by SIZES, and the stones of 0.6 m or more within 2.5 m
// below the scars and elsewhere.
function chunkStones( window, ci, cj ) {

	const box = { x0: ci * S, z0: cj * S, x1: ci * S + S, z1: cj * S + S };
	const fp = windowFootprint( window ), island = makeIslandSDF( fp, grow( box, R ) );
	const cells = [], rocks = placeStones( fp, floorAt( fp ), island, box, cells );
	const sizes = SIZES.map( () => 0 );
	let nearScar = 0, nearOther = 0;
	rocks.forEach( ( r, i ) => {

		const c = cells[ i * 3 ], d = fp.dist( r.x, r.z );
		SIZES.forEach( ( k, n ) => sizes[ n ] += k.test( r, c, d ) ? 1 : 0 );
		if ( r.s < 0.6 || d >= 2.5 ) return;
		// the wall above the stone: its coast point, half a metre in
		const e = 0.2, nx = fp.dist( r.x + e, r.z ) - fp.dist( r.x - e, r.z ), nz = fp.dist( r.x, r.z + e ) - fp.dist( r.x, r.z - e );
		const l = Math.hypot( nx, nz ) || 1;
		if ( island.shed( r.x - nx / l * ( d - 0.5 ), r.z - nz / l * ( d - 0.5 ) ) > SCAR ) nearScar ++; else nearOther ++;

	} );
	let coast = 0, scarred = 0;
	const n = S / COAST_STEP, a = COAST_STEP * COAST_STEP;
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const x = box.x0 + i * COAST_STEP, z = box.z0 + j * COAST_STEP, d = fp.dist( x, z );
		if ( d < 0 || d >= 1 ) continue;
		coast += a;
		if ( island.shed( x, z ) > SCAR ) scarred += a;

	}
	return { rocks, cells, sizes, nearScar, nearOther, coast, scarred };

}

// ------------------------------------------------------------------ the scars of one chunk

// How far a scar may cut from its anchor (m, in x or z; Cliff.ts REACH_A, REACH_B): the joint faces
// and gullies (tier A), the smaller generations (tier B).
const SCAR_REACH = ( s ) => s.level === 0 || s.kind === 'gully' ? 4.5 : 3.0;
// The deepest rock the octagon may keep above y -1 (m): a scar that would cut further keeps a
// step this thick at most where it breaks off. Over seeds 1 - 5 up to step 36 the deepest were
// 0.3 - 0.45 m; two checked in captures (one a joint face broken off up to the lip) read as a
// cross joint.
const TRIM_ABOVE = 0.6;

// The scar's polytope's box: its vertices, the triple plane intersections inside every plane.
function polytopeBox( p, n ) {

	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( let a = 0; a < n; a ++ ) for ( let b = a + 1; b < n; b ++ ) for ( let c = b + 1; c < n; c ++ ) {

		const [ ax, ay, az, ac ] = p.subarray( a * 4, a * 4 + 4 ), [ bx, by, bz, bc ] = p.subarray( b * 4, b * 4 + 4 ), [ cx, cy, cz, cc ] = p.subarray( c * 4, c * 4 + 4 );
		const det = ax * ( by * cz - bz * cy ) - ay * ( bx * cz - bz * cx ) + az * ( bx * cy - by * cx );
		if ( Math.abs( det ) < 1e-6 ) continue;
		const x = ( ac * ( by * cz - bz * cy ) - ay * ( bc * cz - bz * cc ) + az * ( bc * cy - by * cc ) ) / det;
		const y = ( ax * ( bc * cz - bz * cc ) - ac * ( bx * cz - bz * cx ) + az * ( bx * cc - bc * cx ) ) / det;
		const z = ( ax * ( by * cc - bc * cy ) - ay * ( bx * cc - bc * cx ) + ac * ( bx * cy - by * cx ) ) / det;
		let inside = true;
		for ( let k = 0; k < n && inside; k ++ ) if ( p[ k * 4 ] * x + p[ k * 4 + 1 ] * y + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ] > 1e-6 ) inside = false;
		if ( ! inside ) continue;
		x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z );

	}
	return { x0, x1, z0, z1 };

}

// How many of the scar's planes are its own: Cliff.ts `bounds()` appends the vertical end planes of
// the octagon round the anchor last, each at the octagon's apothem from it.
function ownPlanes( s ) {

	const apothem = ( SCAR_REACH( s ) - 0.15 ) * Math.cos( Math.PI / 8 ), p = s.planes;
	let n = s.n;
	while ( n > 0 && p[ n * 4 - 3 ] === 0 && Math.abs( p[ n * 4 - 1 ] - p[ n * 4 - 4 ] * s.cx - p[ n * 4 - 2 ] * s.cz - apothem ) < 1e-9 ) n --;
	return n;

}

// The column ( x, z )'s span inside the first n planes grown by e, below the meadow's top.
function span( p, n, e, x, z ) {

	let lo = ISLAND_BOTTOM, hi = islandSurfaceHeight( x, z ) + 0.6;
	for ( let k = 0; k < n && lo <= hi; k ++ ) {

		const ny = p[ k * 4 + 1 ], rest = p[ k * 4 + 3 ] + e - p[ k * 4 ] * x - p[ k * 4 + 2 ] * z;
		if ( Math.abs( ny ) < 1e-9 ) { if ( rest < 0 ) hi = - Infinity; } else if ( ny > 0 ) hi = Math.min( hi, rest / ny ); else lo = Math.max( lo, rest / ny );

	}
	return [ lo, hi ];

}

// The scars the chunk's wall cuts (a CliffWall over its window, as its island SDF builds it) whose
// anchor lies in the chunk, each measured once over the island, on the surface it was placed on:
// tier A on the plain face, tier B on the face with tier A cut out (design section 15 d).
//   reach  how far from its anchor (in x or z) the block as cut, end planes and all, takes rock: the
//          reach clamp of the scar's box in `bounds()` must trim nothing (the octagon's corners lie
//          0.15 m inside the reach by construction: this guards that construction, which is what
//          bounds the wall's dependence on the land);
//   trim   where the octagon broke a scar off, how thick the rock is that its own planes would have
//          cut beyond the octagon (the least of its depth inside the rock and inside the block), the
//          deepest above y -1 held to TRIM_ABOVE: what the bounded reach costs in the image.
function chunkScars( window, ci, cj ) {

	const box = { x0: ci * S, z0: cj * S, x1: ci * S + S, z1: cj * S + S };
	const fp = windowFootprint( window ), dist = ( x, z ) => fp.dist( x, z );
	const wall = new CliffWall( dist, coastWobble, islandSurfaceHeight, grow( box, R ) );
	const far = { x0: 1e5, z0: 1e5, x1: 1e5 + 1, z1: 1e5 + 1 }; // no coast: no scars
	const plain = new CliffWall( dist, coastWobble, islandSurfaceHeight, far );
	const tierA = new CliffWall( dist, coastWobble, islandSurfaceHeight, far );
	// `add` is private in Cliff.ts; the scars come in their canonical order already
	for ( const s of wall.scars ) if ( SCAR_REACH( s ) === 4.5 ) tierA.add( s );
	const largest = {}, beyond = [], trims = [];
	let scars = 0, met = 0;
	for ( const s of wall.scars ) {

		if ( s.cx < box.x0 || s.cx >= box.x1 || s.cz < box.z0 || s.cz >= box.z1 ) continue;
		scars ++;
		const base = SCAR_REACH( s ) === 4.5 ? plain : tierA, p = s.planes, h = 0.1, kind = `${ s.kind }${ s.level }`;
		const where = `a ${ s.kind } (level ${ s.level }) at ( ${ s.cx.toFixed( 2 ) }, ${ s.cz.toFixed( 2 ) } )`;
		let b = polytopeBox( p, s.n ), reach = 0;
		for ( let z = Math.floor( b.z0 / h ) * h; z <= b.z1; z += h ) for ( let x = Math.floor( b.x0 / h ) * h; x <= b.x1; x += h ) {

			const r = Math.max( Math.abs( x - s.cx ), Math.abs( z - s.cz ) );
			if ( r <= reach ) continue;
			const [ lo, hi ] = span( p, s.n, 0.05, x, z );
			for ( let y = lo; y <= hi; y += 0.05 ) if ( base.solid( x, y, z ) < 0 ) { reach = r; break; }

		}
		largest[ kind ] = Math.max( largest[ kind ] ?? 0, reach );
		if ( reach > SCAR_REACH( s ) ) beyond.push( `${ where } cuts rock ${ reach.toFixed( 2 ) } m from its anchor, beyond its ${ SCAR_REACH( s ) } m reach` );

		const own = ownPlanes( s );
		if ( own === s.n ) continue;
		b = polytopeBox( p, own );
		let deep = 0, top = - Infinity;
		for ( let z = Math.floor( b.z0 / h ) * h; z <= b.z1; z += h ) for ( let x = Math.floor( b.x0 / h ) * h; x <= b.x1; x += h ) {

			let out = false;
			for ( let k = own; k < s.n && ! out; k ++ ) out = p[ k * 4 ] * x + p[ k * 4 + 2 ] * z > p[ k * 4 + 3 ];
			if ( ! out ) continue;
			const [ lo, hi ] = span( p, own, 0, x, z );
			for ( let y = Math.max( lo, - 1 ); y <= hi; y += 0.02 ) {

				let block = - Infinity;
				for ( let k = 0; k < own; k ++ ) block = Math.max( block, p[ k * 4 ] * x + p[ k * 4 + 1 ] * y + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ] );
				const d = Math.min( - base.solid( x, y, z ), - block );
				if ( d > deep ) { deep = d; top = y; }

			}

		}
		met ++;
		if ( deep > 0.01 ) trims.push( { kind, deep, where, top } );

	}
	return { scars, met, largest, beyond, trims };

}

// ------------------------------------------------------------------ the worker

// A job: 'chunk' builds chunk ( ci, cj ) and replies with its owned items and its stones' share;
// 'stones' replies with the stones' share alone.
if ( ! isMainThread ) {

	let land = null, version = - 1;
	parentPort.on( 'message', ( job ) => {

		const stones = chunkStones( job.window, job.ci, job.cj );
		const reply = { id: job.id, stones };
		if ( job.kind === 'chunk' ) {

			if ( job.version !== version ) { land = LandLattice.fromBytes( job.land ); version = job.version; }
			const c = buildChunk( job.window, land, job.ci, job.cj, { version: job.version, contactOcclusion: false } );
			// the chunk's stones against the placement whose classes the statistics read
			let differs = c.stones.rocks.length === stones.rocks.length ? 0 : Infinity;
			if ( differs === 0 ) c.stones.rocks.forEach( ( r, i ) => {

				const o = stones.rocks[ i ];
				differs = Math.max( differs, r.seed === o.seed ? Math.max( ...[ 'x', 'z', 's', 'sy', 'y', 'floor', 'rot' ].map( ( f ) => Math.abs( r[ f ] - o[ f ] ) ) ) : Infinity );

			} );
			Object.assign( reply, { scars: chunkScars( job.window, job.ci, job.cj ), anchors: c.anchors, bushes: c.bushes, strands: c.strands, rimGround: c.rimGround, rocksDiffer: differs, ms: c.timings.total } );

		}
		parentPort.postMessage( reply );

	} );

}

// A pool of worker threads, each on one job at a time. `run( make )` queues a job; `make` builds its
// message when a worker takes it (a window is 4 MB: they are cut only then).
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

// ------------------------------------------------------------------ reporting

let failures = 0;
function judge( ok, line ) {

	console.log( `${ ok ? 'ok  ' : 'FAIL' } ${ line }` );
	if ( ! ok ) failures ++;

}

const percent = ( n, m ) => `${ ( ( n / m - 1 ) * 100 ).toFixed( 1 ) } %`;

// ------------------------------------------------------------------ the meadow

// Counts on the whole island before the hashes (the world worker's
// anchors, then buildGrass and buildFlowers with the walking loop), by seed / growth step.
const M2 = {
	'1/0': { anchors: 7105, lawn: 7004, thin: 1789, flowers: 1556 },
	'1/8': { anchors: 36163, lawn: 35910, thin: 10150, flowers: 8227 },
	'1/12': { anchors: 49465, lawn: 49189, thin: 13931, flowers: 11779 },
	'2/0': { anchors: 7081, lawn: 7013, thin: 1555, flowers: 1702 },
	'2/8': { anchors: 38584, lawn: 38349, thin: 9271, flowers: 9008 },
	'2/12': { anchors: 52357, lawn: 52084, thin: 13629, flowers: 12921 },
};

// Grass.ts, Flowers.ts and WalkLoop.ts build three.js objects (and import modules plain node cannot
// strip), so they load through Vite's SSR loader, on the main thread only.
async function loadPlanting() {

	globalThis.location ??= { search: '', href: 'http://localhost/' };
	const { createServer } = await import( 'vite' );
	const server = await createServer( {
		root: new URL( '../', import.meta.url ).pathname, configFile: false, logLevel: 'error', appType: 'custom',
		server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
	} );
	const { plantGrass } = await server.ssrLoadModule( '/src/world/Grass.ts' );
	const { plantFlowers } = await server.ssrLoadModule( '/src/world/Flowers.ts' );
	const { walkLoop } = await server.ssrLoadModule( '/src/world/WalkLoop.ts' );
	const { walkLoopDistance } = await server.ssrLoadModule( '/src/world/WalkPath.ts' );
	await server.close();
	return { plantGrass, plantFlowers, walkLoop, walkLoopDistance };

}

function meadow( planting, island, chunks, pooled ) {

	const { seed, step, land } = island;
	const anchors = concat( chunks.map( ( c ) => c.anchors ) );
	// the chunks' rim ground texels (160 x 160 over each chunk with island), assembled
	const n = Math.round( S / RIM_CELL );
	const rimGround = assembleRimGround( chunks.filter( ( c ) => c.rimGround.length > 0 ).map( ( c ) => ( { data: c.rimGround, nx: n, nz: n, x0: c.ci * S, z0: c.cj * S, cell: RIM_CELL } ) ) );
	const walkDistance = planting.walkLoopDistance( planting.walkLoop( land ) );
	const tufts = planting.plantGrass( anchors, rimGround ), flowers = planting.plantFlowers( anchors, walkDistance );
	const counts = { anchors: anchors.length / VEGETATION_STRIDE, lawn: tufts.lawn.length, thin: tufts.lawnThin.length, flowers: flowers.flat().length };
	const area = landArea( land ), reference = M2[ `${ seed }/${ step }` ];
	console.log( `     meadow seed ${ seed } grow ${ step }: ${ Object.entries( counts ).map( ( [ kind, k ] ) =>
		`${ kind } ${ ( k / area ).toFixed( 2 ) }/m2${ reference ? ` (${ percent( k, reference[ kind ] ) })` : '' }` ).join( ', ' ) }${ reference ? ' against M2' : '' }` );
	if ( reference && step >= 8 ) for ( const kind in counts ) {

		pooled[ kind ] ??= [ 0, 0 ];
		pooled[ kind ][ 0 ] += counts[ kind ];
		pooled[ kind ][ 1 ] += reference[ kind ];

	}

}

function judgeMeadow( pooled ) {

	if ( ! Object.keys( pooled ).length ) {

		console.log( '     meadow density not judged: no grown island run (step 8 on) has M2 counts' );
		return;

	}
	const off = Object.values( pooled ).some( ( [ n, m ] ) => Math.abs( n / m - 1 ) > 0.05 );
	judge( ! off, `meadow density over the grown islands run against M2 (within 5 %): ${ Object.entries( pooled ).map( ( [ kind, [ n, m ] ] ) => `${ kind } ${ percent( n, m ) }` ).join( ', ' ) }` );

}

function concat( parts ) {

	const out = new Float32Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
	parts.reduce( ( offset, p ) => { out.set( p, offset ); return offset + p.length; }, 0 );
	return out;

}

// ------------------------------------------------------------------ the rim

// integrate/isle-m3 at ad0c6ea, the worker's rim on the whole island, by seed / growth step: the
// bushes drawn, the trails' strands rooted in the turf and their hanging length (m).
const M3 = {
	'1/0': { bushes: 70, strands: 213, hang: 203.6 },
	'1/8': { bushes: 180, strands: 586, hang: 458.9 },
	'1/12': { bushes: 205, strands: 821, hang: 645.2 },
	'2/0': { bushes: 64, strands: 221, hang: 161.3 },
	'2/8': { bushes: 179, strands: 572, hang: 481.5 },
	'2/12': { bushes: 217, strands: 691, hang: 578.6 },
	'3/0': { bushes: 77, strands: 219, hang: 187.2 },
	'3/8': { bushes: 164, strands: 589, hang: 476.3 },
	'3/12': { bushes: 222, strands: 803, hang: 671.6 },
	'4/0': { bushes: 58, strands: 216, hang: 183.9 },
	'4/8': { bushes: 165, strands: 620, hang: 500.3 },
	'4/12': { bushes: 207, strands: 749, hang: 631.3 },
	'5/0': { bushes: 56, strands: 197, hang: 172.0 },
	'5/8': { bushes: 191, strands: 641, hang: 508.8 },
	'5/12': { bushes: 237, strands: 842, hang: 706.6 },
};

// The trails' statistics on the chunks' strands (a fork's parent re-indexed into the union), along
// the coast's closed loops.
function trailStats( strands, coastLoops, fp ) {

	// the coast's closed loops, with each vertex's arc position
	const loops = coastLoops.filter( ( c ) => c.closed && c.x.length > 20 ).map( ( c ) => {

		const arc = [ 0 ];
		for ( let k = 1; k < c.x.length; k ++ ) arc.push( arc[ k - 1 ] + Math.hypot( c.x[ k ] - c.x[ k - 1 ], c.z[ k ] - c.z[ k - 1 ] ) );
		const n = c.x.length;
		return { c, arc, length: arc[ n - 1 ] + Math.hypot( c.x[ 0 ] - c.x[ n - 1 ], c.z[ 0 ] - c.z[ n - 1 ] ) };

	} );
	const cells = new Map(), key = ( i, j ) => `${ i },${ j }`;
	loops.forEach( ( { c }, l ) => c.x.forEach( ( x, k ) => {

		const id = key( Math.floor( x ), Math.floor( c.z[ k ] ) );
		if ( ! cells.has( id ) ) cells.set( id, [] );
		cells.get( id ).push( [ l, k ] );

	} ) );
	const locate = ( x, z ) => {

		let best = null, bestD = 1.5;
		for ( let j = Math.floor( z ) - 2; j <= Math.floor( z ) + 2; j ++ ) for ( let i = Math.floor( x ) - 2; i <= Math.floor( x ) + 2; i ++ ) {

			for ( const [ l, k ] of cells.get( key( i, j ) ) ?? [] ) {

				const d = Math.hypot( loops[ l ].c.x[ k ] - x, loops[ l ].c.z[ k ] - z );
				if ( d < bestD ) { bestD = d; best = [ l, k ]; }

			}

		}
		return best;

	};
	// patches: the strands rooted at one lip, named by its anchor cell (forks belong to their
	// parent's)
	const byAnchor = new Map();
	for ( const s of strands ) {

		if ( s.parent !== undefined ) continue;
		const id = key( ...s.anchor );
		if ( ! byAnchor.has( id ) ) byAnchor.set( id, [] );
		byAnchor.get( id ).push( s );

	}
	const patches = [ ...byAnchor.values() ];
	const sizes = patches.map( ( p ) => p.length );
	// the lowest node against its root's height above the sea (a fork against its parent's root)
	let lowest = Infinity;
	for ( const s of strands ) {

		const root = ( s.parent === undefined ? s : strands[ s.parent ] ).points[ 1 ];
		for ( let k = 1; k < s.points.length; k += 6 ) lowest = Math.min( lowest, s.points[ k ] / root );

	}
	// each patch's span along its loop (its strands' lip nodes, 8 cm either side), merged
	const spans = loops.map( () => [] );
	for ( const patch of patches ) {

		let loop = - 1, first = 0, lo = Infinity, hi = - Infinity;
		for ( const s of patch ) {

			const at = locate( s.points[ s.lip * 6 ], s.points[ s.lip * 6 + 2 ] );
			if ( ! at ) continue;
			if ( loop < 0 ) { loop = at[ 0 ]; first = loops[ loop ].arc[ at[ 1 ] ]; }
			if ( at[ 0 ] !== loop ) continue;
			const L = loops[ loop ].length;
			let a = loops[ loop ].arc[ at[ 1 ] ];
			while ( a - first > L / 2 ) a -= L;
			while ( first - a > L / 2 ) a += L;
			lo = Math.min( lo, a ); hi = Math.max( hi, a );

		}
		if ( loop >= 0 ) spans[ loop ].push( [ lo - 0.08, hi + 0.08 ] );

	}
	// the point at arc position a on a loop
	const pointAt = ( { c, arc, length }, a ) => {

		a = ( ( a % length ) + length ) % length;
		let k = 0;
		while ( k + 1 < arc.length && arc[ k + 1 ] < a ) k ++;
		const e = ( k + 1 ) % c.x.length, l = ( k + 1 < arc.length ? arc[ k + 1 ] : length ) - arc[ k ], f = l > 0 ? ( a - arc[ k ] ) / l : 0;
		return [ c.x[ k ] + ( c.x[ e ] - c.x[ k ] ) * f, c.z[ k ] + ( c.z[ e ] - c.z[ k ] ) * f ];

	};
	// whether the run from arc position a to b, whose ends are ( ax, az ) and ( bx, bz ), bulges
	// into the land: its point farthest from the mouth (the line between its ends) lies inside the
	// footprint, deeper than the mouth's midpoint
	const notch = ( loop, a, b, ax, az, bx, bz ) => {

		const ux = bx - ax, uz = bz - az, u = Math.hypot( ux, uz ) || 1;
		let deep = [ ax, az ], depth = - 1;
		for ( let t = a; t <= b; t += 0.05 ) {

			const [ x, z ] = pointAt( loop, t );
			const d = Math.abs( ( x - ax ) * uz - ( z - az ) * ux ) / u;
			if ( d > depth ) { depth = d; deep = [ x, z ]; }

		}
		const inside = fp.dist( deep[ 0 ], deep[ 1 ] );
		return inside < 0 && inside < fp.dist( ( ax + bx ) / 2, ( az + bz ) / 2 );

	};
	const runs = [];
	let coast = 0;
	loops.forEach( ( loop, l ) => {

		coast += loop.length;
		const L = loop.length;
		const list = spans[ l ].map( ( [ a, b ] ) => {

			const s = ( ( a % L ) + L ) % L;
			return [ s, s + b - a ];

		} ).sort( ( p, q ) => p[ 0 ] - q[ 0 ] );
		const merged = [];
		for ( const [ a, b ] of list ) {

			if ( merged.length && a <= merged[ merged.length - 1 ][ 1 ] ) merged[ merged.length - 1 ][ 1 ] = Math.max( merged[ merged.length - 1 ][ 1 ], b );
			else merged.push( [ a, b ] );

		}
		if ( ! merged.length ) {

			runs.push( { along: L, counted: L } );
			return;

		}
		for ( let i = 0; i < merged.length; i ++ ) {

			const from = merged[ i ][ 1 ], to = i + 1 < merged.length ? merged[ i + 1 ][ 0 ] : merged[ 0 ][ 0 ] + L;
			if ( to <= from ) continue;
			const [ ax, az ] = pointAt( loop, from ), [ bx, bz ] = pointAt( loop, to );
			const along = to - from, straight = Math.hypot( ax - bx, az - bz );
			runs.push( { along, counted: straight < along / 2 && notch( loop, from, to, ax, az, bx, bz ) ? straight : along } );

		}

	} );
	runs.sort( ( a, b ) => a.counted - b.counted );
	const median = runs.length ? runs[ Math.floor( runs.length / 2 ) ].counted : 0;
	return {
		coast, patches: patches.length, sizes, lowest, runs: runs.length, median,
		longest: Math.max( 0, ...runs.map( ( r ) => r.counted ) ), longestAlong: Math.max( 0, ...runs.map( ( r ) => r.along ) ),
		notches: runs.filter( ( r ) => r.counted < r.along ).length,
		strands: strands.filter( ( s ) => s.parent === undefined ).length, forks: strands.filter( ( s ) => s.parent !== undefined ).length,
		hang: hanging( strands, 0 ),
	};

}

function rim( island, chunks, field, pooled ) {

	const { seed, step, land } = island;
	const strands = [];
	for ( const c of chunks ) {

		const offset = strands.length;
		for ( const s of c.strands ) strands.push( s.parent === undefined ? s : { ...s, parent: s.parent + offset } );

	}
	// the coast every chunk's trails see, on one lattice: the land field's footprint and the island
	// solid the chunks evaluate (local: every value a function of the point)
	const fp = windowFootprint( field ), b = grow( landBounds( land ), 4 );
	const { lattice } = rimBoxes( makeIslandSDF( fp, grow( b, R ) ), b );
	const st = trailStats( strands, coastChains( lattice.signs(), 1 ), fp );
	const label = `rim seed ${ seed } grow ${ step }`;
	judge( st.sizes.every( ( n ) => n >= 1 && n <= 9 ), `${ label }: ${ st.patches } trail patches of ${ Math.min( ...st.sizes ) } - ${ Math.max( ...st.sizes ) } strands (1 - 9)` );
	judge( st.lowest >= 0.25, `${ label }: lowest node at ${ st.lowest.toFixed( 3 ) } of its root's height (0.25 or more)` );
	judge( st.median >= 0.4 && st.median <= 4 && st.longest <= 4, `${ label }: ${ st.runs } bare runs, median ${ st.median.toFixed( 2 ) } m (0.4 - 4), longest ${ st.longest.toFixed( 2 ) } m (4 or less; ` +
		`${ st.longestAlong.toFixed( 2 ) } m along the coast, ${ st.notches } across notches)` );
	const counts = { bushes: concat( chunks.map( ( c ) => c.bushes ) ).length / BUSH_STRIDE, strands: st.strands, hang: st.hang };
	const reference = M3[ `${ seed }/${ step }` ];
	console.log( `     ${ label }: ${ counts.bushes } bushes, ${ st.strands } strands, ${ st.forks } forks, ${ st.hang.toFixed( 1 ) } m hanging, ` +
		`${ ( st.strands / st.coast ).toFixed( 2 ) } strands per m of ${ st.coast.toFixed( 1 ) } m of coast${ reference ? ` (${ Object.keys( counts ).map( ( kind ) => `${ kind } ${ percent( counts[ kind ], reference[ kind ] ) }` ).join( ', ' ) } against M3)` : '' }` );
	if ( ! reference ) return;
	for ( const kind of Object.keys( counts ) ) {

		const sum = pooled.all[ kind ] ??= [ 0, 0 ];
		sum[ 0 ] += counts[ kind ]; sum[ 1 ] += reference[ kind ];

	}
	if ( step >= 8 ) pooled.grown.push( [ `${ seed }/${ step }`, counts.bushes, reference.bushes ] );

}

function judgeRim( pooled ) {

	const sums = Object.entries( pooled.all );
	if ( ! sums.length ) {

		console.log( '     rim counts not judged: no island run has M3 counts' );
		return;

	}
	const off = sums.some( ( [ , [ n, m ] ] ) => Math.abs( n / m - 1 ) > 0.1 ) || pooled.grown.some( ( [ , n, m ] ) => Math.abs( n / m - 1 ) > 0.1 );
	judge( ! off, `rim counts against M3 (within 10 %), summed over the islands run: ${ sums.map( ( [ kind, [ n, m ] ] ) => `${ kind } ${ percent( n, m ) }` ).join( ', ' ) }; ` +
		`bushes on the grown islands: ${ pooled.grown.length ? pooled.grown.map( ( [ id, n, m ] ) => `${ id } ${ percent( n, m ) }` ).join( ', ' ) : 'none run' }` );

}

// ------------------------------------------------------------------ the stones

// The land's stones (every chunk's, with their cells): clear of each other, crowns at or below
// -1.30 m, each within its class's reach of its cell.
function checkStones( island, shares ) {

	const label = `stones seed ${ island.seed } grow ${ island.step }`;
	const stones = shares.flatMap( ( s ) => s.rocks ), cells = shares.flatMap( ( s ) => s.cells );
	let pairs = 0, crowns = 0, reach = 0, overlaps = 0, highest = - Infinity;
	// neighbours through a 4 m grid: two stones farther apart than twice their sizes are not tested
	const grid = new Map(), G = 4, key = ( i, j ) => `${ i },${ j }`;
	stones.forEach( ( r, i ) => {

		const id = key( Math.floor( r.x / G ), Math.floor( r.z / G ) );
		if ( ! grid.has( id ) ) grid.set( id, [] );
		grid.get( id ).push( i );

	} );
	const largest = Math.max( 0, ...stones.map( ( r ) => r.s ) ), span = Math.ceil( 4 * largest / G );
	stones.forEach( ( r, i ) => {

		highest = Math.max( highest, r.y + 1.6 * r.sy );
		if ( r.y + 1.6 * r.sy > - 1.30 + 1e-9 ) crowns ++;
		const [ cls, ci, cj ] = cells.slice( i * 3, i * 3 + 3 ), c = CELL[ cls ];
		const out = Math.hypot( Math.max( ci * c - r.x, 0, r.x - ci * c - c ), Math.max( cj * c - r.z, 0, r.z - cj * c - c ) );
		if ( out > REACH[ cls ] ) reach ++;
		const gi = Math.floor( r.x / G ), gj = Math.floor( r.z / G );
		for ( let j = gj - span; j <= gj + span; j ++ ) for ( let k = gi - span; k <= gi + span; k ++ ) for ( const n of grid.get( key( k, j ) ) ?? [] ) {

			if ( n <= i ) continue;
			const o = stones[ n ], dx = o.x - r.x, dz = o.z - r.z, distance = Math.hypot( dx, dz );
			if ( distance > ( o.s + r.s ) * 2 ) continue;
			pairs ++;
			const ux = dx / distance, uz = dz / distance;
			if ( ! ( distance > 0 && distance >= ( rockExtent( r, ux, uz ) + rockExtent( o, ux, uz ) ) * 0.98 ) ) overlaps ++;

		}

	} );
	const n = [ 0, 0, 0, 0 ];
	for ( let i = 0; i < cells.length; i += 3 ) n[ cells[ i ] ] ++;
	const coast = shares.reduce( ( a, s ) => a + s.coast, 0 );
	judge( ! crowns && ! reach && ! overlaps, `${ label }: ${ stones.length } stones (${ n.map( ( k, c ) => `${ k } ${ CLASS[ c ] }` ).join( ', ' ) }) on ${ coast.toFixed( 1 ) } m of coast; ` +
		`${ pairs } near pairs, ${ overlaps } overlapping; crowns at most ${ highest.toFixed( 3 ) } m (${ crowns } above -1.30); ${ reach } beyond their class's reach` );

}

// The island's scars (each chunk's own, `chunkScars`): none cuts rock beyond its reach (the clamp
// trims nothing), none breaks off more than TRIM_ABOVE of rock above y -1 at its octagon.
function checkScars( island, shares ) {

	const label = `scars seed ${ island.seed } grow ${ island.step }`, largest = {};
	const beyond = shares.flatMap( ( s ) => s.beyond ), trims = shares.flatMap( ( s ) => s.trims ).sort( ( a, b ) => b.deep - a.deep );
	for ( const s of shares ) for ( const [ k, v ] of Object.entries( s.largest ) ) largest[ k ] = Math.max( largest[ k ] ?? 0, v );
	const scars = shares.reduce( ( a, s ) => a + s.scars, 0 ), met = shares.reduce( ( a, s ) => a + s.met, 0 );
	const thick = trims.filter( ( t ) => t.deep > TRIM_ABOVE );
	for ( const m of beyond.slice( 0, 5 ) ) console.log( `     ${ m }` );
	for ( const t of thick.slice( 0, 5 ) ) console.log( `     ${ t.where } breaks off ${ t.deep.toFixed( 2 ) } m of rock above y -1 at its octagon (at y ${ t.top.toFixed( 2 ) })` );
	judge( ! beyond.length, `${ label }: ${ scars } scars, ${ beyond.length } cut rock beyond their reach (tier A 4.5 m, tier B 3 m); largest per kind (m): ` +
		Object.entries( largest ).sort().map( ( [ k, v ] ) => `${ k } ${ v.toFixed( 2 ) }` ).join( ', ' ) );
	judge( ! thick.length, `${ label }: ${ met } scars meet their octagon, ${ trims.length } of them break off rock above y -1, ${ thick.length } more than ${ TRIM_ABOVE } m; deepest (m): ` +
		( trims.slice( 0, 3 ).map( ( t ) => `${ t.kind } ${ t.deep.toFixed( 2 ) }` ).join( ', ' ) || 'none' ) );

}

// Over the density islands: each class, the large stones and the scars' gathering, per 100 m of
// coast, against today's.
function checkDensity( islands ) {

	const total = [ 0, 0, 0, 0 ], sizes = SIZES.map( () => 0 );
	let coast = 0, scarred = 0, nearScar = 0, nearOther = 0;
	for ( const shares of islands ) for ( const s of shares ) {

		for ( let i = 0; i < s.cells.length; i += 3 ) total[ s.cells[ i ] ] ++;
		s.sizes.forEach( ( k, n ) => sizes[ n ] += k );
		coast += s.coast; scarred += s.scarred; nearScar += s.nearScar; nearOther += s.nearOther;

	}
	const per = total.map( ( n ) => n / coast * 100 );
	judge( per.every( ( p, c ) => Math.abs( p / TODAY[ c ] - 1 ) <= 0.2 ), `stones per 100 m of coast over seeds 1 - 6 at steps 0, 8, 16 (${ coast.toFixed( 0 ) } m), within 20 % of today's: ` +
		`${ per.map( ( p, c ) => `${ CLASS[ c ] } ${ p.toFixed( 1 ) } (today ${ TODAY[ c ] })` ).join( ', ' ) }; ${ per.reduce( ( a, b ) => a + b ).toFixed( 1 ) } in all` );
	const large = sizes.map( ( n ) => n / coast * 100 );
	judge( large.every( ( p, n ) => Math.abs( p / SIZES[ n ].today - 1 ) <= 0.2 ), `large stones per 100 m of coast, within 20 % of today's: ` +
		`${ large.map( ( p, n ) => `${ SIZES[ n ].label } ${ p.toFixed( 1 ) } (today ${ SIZES[ n ].today })` ).join( ', ' ) }` );
	const ratio = ( nearScar / scarred ) / ( nearOther / ( coast - scarred ) );
	judge( ratio > 1, `stones of 0.6 m or more within 2.5 m: ${ ratio.toFixed( 2 ) } times as dense below the scars (${ scarred.toFixed( 0 ) } m) as elsewhere (more than 1; today 1.40)` );

}

// ------------------------------------------------------------------ the run

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return i < 0 ? fallback : process.argv[ i + 1 ];

};

async function main() {

	const start = performance.now();
	const cache = verifyCache( import.meta.url );
	cache.check();
	const seeds = argument( '--seeds', '1,2' ).split( ',' ).map( Number );
	const steps = argument( '--grow', '0,8' ).split( ',' ).map( Number );
	const threads = Number( argument( '--threads', String( Math.max( 1, Math.min( 8, availableParallelism() - 4 ) ) ) ) );
	const planting = await loadPlanting();

	// the islands built whole (seeds x steps) and the stones' density islands (seeds 1 - 6 at steps
	// 0, 8, 16): every chunk of a built island is a 'chunk' job, of a density island a 'stones' job
	const islands = new Map();
	const add = ( seed, step, built ) => {

		const id = `${ seed }/${ step }`, island = islands.get( id );
		if ( island ) island.built ||= built;
		else islands.set( id, { seed, step, built, density: false } );
		return islands.get( id );

	};
	for ( const seed of seeds ) for ( const step of steps ) add( seed, step, true );
	for ( const seed of [ 1, 2, 3, 4, 5, 6 ] ) for ( const step of [ 0, 8, 16 ] ) add( seed, step, false ).density = true;
	console.log( `seeds ${ seeds.join( ', ' ) } at steps ${ steps.join( ', ' ) } built whole, ${ [ ...islands.values() ].filter( ( i ) => i.density ).length } islands for the stones' density, ${ threads } threads` );

	const pool = new Pool( threads );
	let jobs = 0;
	for ( const island of islands.values() ) {

		const land = growLand( island.seed, island.step ).land, field = landField( land ), bytes = land.toBytes();
		const version = island.seed * 1000 + island.step, kind = island.built ? 'chunk' : 'stones';
		Object.assign( island, { land, field: island.built ? field : null } );
		island.chunks = Promise.all( chunkKeys( land ).map( ( key ) => {

			const [ ci, cj ] = parseChunkKey( key );
			jobs ++;
			return pool.run( () => ( { kind, window: landWindow( field, ci, cj ), land: bytes, ci, cj, version } ) ).then( ( reply ) => ( { ci, cj, ...reply } ) );

		} ) );
		// let the pool's replies in: a land field takes the main thread a moment
		await new Promise( ( resolve ) => setImmediate( resolve ) );

	}

	const meadowPooled = {}, rimPooled = { all: {}, grown: [] }, density = [];
	let built = 0, ms = 0, rocksDiffer = 0;
	for ( const island of islands.values() ) {

		const chunks = await island.chunks;
		if ( island.density ) density.push( chunks.map( ( c ) => c.stones ) );
		if ( ! island.built ) continue;
		for ( const c of chunks ) { built ++; ms += c.ms; rocksDiffer = Math.max( rocksDiffer, c.rocksDiffer ); }
		console.log( `---- seed ${ island.seed } grow ${ island.step }: ${ chunks.length } chunks (${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s)` );
		meadow( planting, island, chunks, meadowPooled );
		rim( island, chunks, island.field, rimPooled );
		checkStones( island, chunks.map( ( c ) => c.stones ) );
		checkScars( island, chunks.map( ( c ) => c.scars ) );
		island.field = null;

	}
	pool.close();
	console.log( '---- over the islands run' );
	judge( rocksDiffer === 0, `the built chunks' stones are the placement the statistics read (largest difference ${ rocksDiffer })` );
	judgeMeadow( meadowPooled );
	judgeRim( rimPooled );
	checkDensity( density );
	console.log( `     ${ jobs } jobs, ${ built } chunks built (${ ( ms / Math.max( 1, built ) ).toFixed( 0 ) } ms each), done in ${ ( ( performance.now() - start ) / 1000 ).toFixed( 0 ) } s` );
	if ( failures ) {

		console.log( `${ failures } checks failed.` );
		process.exit( 1 );

	}
	console.log( 'All statistical checks passed.' );
	cache.record();
	process.exit( 0 );

}

if ( isMainThread ) await main();
