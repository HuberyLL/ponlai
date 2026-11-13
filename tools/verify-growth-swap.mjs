// Regression probe for the island's growth in place (packages/island/world/Growth.ts): a page grown by N steps
// must draw what a page freshly loaded on that land draws, bit for bit, in the test mode (paused,
// MSAA: docs/reference/tools.md, Test mode; AGENTS.md, "The island grows in place"), and no swap may build a
// pipeline.
//
//   node tools/verify-growth-swap.mjs <base url> [--steps 6] [--views island,cliffs,meadow]
//     [--q "extra&query"] [--fresh-grow M] [--out dir] [--timeout 240000]
//
// Two pages, one after the other, in one capture browser (tools/capture-browser.mjs, a warm profile
// slot), headless, 1600 x 900 at dpr 1, on the query
// `debug&paused&t=12&dpr=1&quality=high&weather=fair&preset=noon&seed=1` (then --q, then the first
// view's own query):
// - G, the grown page: loaded with `grow=0`, then grown N times by `__PONLAI__.growth.grow()`.
//   Before each grow the page prepares the next piece (`growth.start()`, until `growth.state.phase`
//   is ready) with its loop stopped and the GPU lock released; the grow and the frames after it
//   (the swap's own frames, then 10 more) run with the loop going under the lock. Per step it
//   records the pipelines before and after, the swap's time (`state.last.ms.swap`), the wall time
//   of the grow, renderer.info.memory (geometries, textures, uniformBuffers, renderTargets,
//   attributes and their sizes) and the world fields' bytes.
// - F, the fresh page: loaded with `grow=N` (or `grow=M` with --fresh-grow, which exists only to
//   prove the check can fail: run it with M != N and every item below that depends on the land
//   must come out different).
// Then on both pages alike: the pending piece prepared (so neither page has idle-time work running
// while it is measured; the page keeps one piece ahead after a grow), 30 frames, and then the chunk
// hashes (`growth.chunkHashes()`), the world fields' bytes, the ambient light's probes
// (`ambientVolume.hash()` and `ambientVolume.info()`: lighting/AmbientVolume.ts) and their
// relit irradiance (`ambientRelight.hash()`, lighting/AmbientRelight.ts: its readback builds one
// compute pipeline on each page alike),
// renderer.info.memory, the pipeline count, the camera's ground grid (`controls.ground`: its
// lattice and heights) and the rain's collision map (`rain.collision.target`, read back with
// readRenderTargetPixelsAsync, its size and placement `xform`). The ground's heights and the rain
// map's texels are shipped to node and compared there (no store in the page). Then each view is
// shot: the first on the page as it loaded (or grew: no scene jump, so state a grow leaves behind
// is not cleared before it is seen), each later one reached by the exact scene jump
// (`establishScene`, the page's step standing for `grow`) on both pages alike. Before its own eval
// every view puts the camera on the island view's pose (`setCameraMode( 'orbit' )`, `setCameraView(
// 'island' )`): a grow leaves the player's camera where it was by design, while the pose follows
// the land, so without it the first view of the grown page is framed on the land it loaded with. A
// view is ready once the diagnostics' `settled` signal holds and the image stops changing
// (capture-browser's waitForStable); it is shot, two more frames are drawn and it is shot again
// (`stable`: whether both are the same pixels, and how many differ). A paused page still leaves its
// settled image for single frames now and then (capture-browser's header: from a few pixels up), so
// a view passes when its first shots on G and F, or its second shots, are the same pixels: a real
// difference shows in both pairs, the frame noise in one at most (the 12-step check saw 1 and 2
// pixels change between the shots of two views of G, and G's first shots equal F's).
//
// Views: parity view names (tools/parity/views.mjs; their query joins the common one), with the
// aliases island = island-fair-noon, cliffs = water-skim-cliffs, meadow = meadow-close. Views
// whose load-time options differ cannot share a page (establishScene refuses them).
//
// Verdicts (report.json `verdicts`, each pass or fail):
// - views: each view's first shots on G and F the same pixels, or its second shots (decoded; PNG
//   bytes depend on the encoder);
// - hashes: the same chunks with the same hashes;
// - rain: the rain map's size and xform equal and 0 texels differing (all four half-float channels);
// - ground: the ground grid's lattice equal and every height equal (compared cell by cell over the
//   union of both grids, as the camera reads them: the sea, 0, outside a grid);
// - fields: the world fields' bytes equal;
// - ambient: the ambient light's probe lattice equal (its SHA-256 and its description), and the
//   relight's output (its SHA-256);
// - pipelines: the count the same before and after every grow on G, the same at every step, and
//   equal on G and F both when measured and after the views;
// - memory: renderer.info.memory's uniformBuffers and textures on G at most MEMORY_TOLERANCE (2)
//   above F's. A leak shows as G above F (M13's leak added 23-37 uniform buffers per swap); counts
//   that a growth path leaves one or two apart are not one (M13's final check saw 254 / 255 uniform
//   buffers and 130 / 130 textures after four steps). G below F is reported, not judged: the grown
//   page holds fewer uniform buffers than a fresh load (293 / 297 after 12 steps, the gap growing
//   with the steps), which is not a leak, and anything missing from the drawing shows in the views.
//   The other columns are recorded, not judged.
// - console: no console error and no page error on either page (warnings are listed, not judged).
// Exit codes (docs/how-to/write-a-tool.md): 0 every verdict passed, 1 one failed (or the run
// broke), 2 a usage error. The shots are paused frames under a shared GPU slot: other load on the
// GPU does not change their pixels, so nothing here is contended and 3 is never returned.
//
// GPU lock (tools/gpu-lock.mjs): shared, and held only while the page renders: each page's load
// takes it once the page has its world (the same gate as tools/capture.mjs, "The slot after the
// world": the page's `requestDevice` waits until the slot is taken), the grows, the measurement and
// the views lease it (leaseGpuLock, a 20 s budget, as capture.mjs's views); while a page prepares
// its next piece (worker generation and idle-time preparation, seconds to minutes of CPU) its loop
// is stopped and the lock released, so the page draws no frame without the lock and holds no slot
// while the GPU idles.
//
// Outputs: --out (default `artifacts/captures/growth-swap/<time>-<pid>/`, one folder per run):
// `report.json` (the query, the options, per page its record, `compare` and `verdicts`), the shots
// (`G-<view>.png`, `G-<view>-b.png`, `F-...`), and a summary on stdout; progress lines with the
// time of day as the run goes, for `node tools/job.mjs wait`. The rain maps and ground grids are
// not kept (megabytes per page); their comparison is in the report.
import './qos.mjs'; // first: the PNG decodes and the map comparisons run here
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchCapture, waitForStable, pngShooter, stopLoop, startLoop, decodePng, compareFrames, samePixels } from './capture-browser.mjs';
import { leaseGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { VIEWS, viewEval } from './parity/views.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const LABEL = 'verify-growth-swap';
const MEMORY_TOLERANCE = 2;
const ALIASES = { island: 'island-fair-noon', cliffs: 'water-skim-cliffs', meadow: 'meadow-close' };
const COMMON = 'debug&paused&t=12&dpr=1&quality=high&weather=fair&preset=noon&seed=1';
const W = 1600, H = 900;
// the camera's ground cell (packages/island/camera/IslandGround.ts CELL)
const GROUND_CELL = 0.5;

// ------------------------------------------------------------------ options

const usage = () => {

	console.error( 'usage: node tools/verify-growth-swap.mjs <base url> [--steps 6] [--views island,cliffs,meadow] [--q "extra&query"] [--fresh-grow M] [--out dir] [--timeout 240000]' );
	process.exit( 2 );

};
const KNOWN = [ 'steps', 'views', 'q', 'fresh-grow', 'out', 'timeout' ];
const args = process.argv.slice( 2 );
const options = {};
let base = null;
for ( let i = 0; i < args.length; i ++ ) {

	const a = args[ i ];
	if ( a.startsWith( '--' ) ) {

		const key = a.slice( 2 );
		if ( ! KNOWN.includes( key ) || i + 1 >= args.length ) { console.error( `unknown or incomplete option ${ a }` ); usage(); }
		options[ key ] = args[ ++ i ];

	} else if ( base === null ) base = a;
	else { console.error( `unexpected argument ${ a }` ); usage(); }

}
if ( ! base ) usage();
const steps = Number( options.steps ?? 6 );
const freshGrow = Number( options[ 'fresh-grow' ] ?? steps );
const timeout = Number( options.timeout ?? 240000 );
if ( ! Number.isInteger( steps ) || steps < 1 || ! Number.isInteger( freshGrow ) || freshGrow < 0 || ! ( timeout > 0 ) ) usage();
const views = ( options.views ?? 'island,cliffs,meadow' ).split( ',' ).filter( Boolean ).map( ( v ) => ALIASES[ v ] ?? v );
for ( const v of views ) if ( ! VIEWS[ v ] ) { console.error( `unknown view ${ v } (tools/parity/views.mjs names, or island, cliffs, meadow)` ); usage(); }
if ( views.length === 0 ) usage();
const out = path.resolve( options.out ?? path.join( ROOT, 'artifacts/captures/growth-swap', `${ new Date().toISOString().slice( 0, 19 ).replace( /[:T]/g, '-' ) }-${ process.pid }` ) );
mkdirSync( out, { recursive: true } );

// later keys replace earlier ones
const merge = ( ...queries ) => {

	const q = new URLSearchParams();
	for ( const given of queries ) for ( const key of new Set( new URLSearchParams( given ).keys() ) ) {

		q.delete( key );
		for ( const value of new URLSearchParams( given ).getAll( key ) ) q.append( key, value );

	}
	return q.toString().replace( /=(?=&|$)/g, '' );

};
const viewQuery = ( view ) => merge( COMMON, options.q ?? '', VIEWS[ view ].q ?? '' );

const log = ( ...a ) => console.log( new Date().toISOString().slice( 11, 19 ), ...a );

// ------------------------------------------------------------------ the GPU lock, held while rendering

let held = false;
async function lock() {

	const t = Date.now();
	const { waitMs } = await leaseGpuLock( LABEL, { shared: true, budget: 20000, quiet: true } );
	if ( ! held || waitMs > 1000 ) log( `lock taken after ${ ( ( Date.now() - t ) / 1000 ).toFixed( 0 ) } s` );
	held = true;

}
function unlock() {

	if ( ! held ) return;
	releaseGpuLock();
	held = false;

}

/** Runs `fn` with the lock held and the loop running; the loop is stopped again afterwards (the lock
 * stays leased until the next CPU wait or the next piece's lease gives it up). */
async function rendering( page, fn ) {

	await lock();
	try {

		await startLoop( page );
		return await fn();

	} finally {

		await stopLoop( page );

	}

}

// ------------------------------------------------------------------ page steps

/** Loads `url` up to its world without the GPU, then takes the lock, lets the page have its device
 * and waits until it is up (loading screen done); the loop is stopped and the lock released. */
async function loadPage( page, url ) {

	const t = Date.now();
	await page.goto( url, { waitUntil: 'domcontentloaded', timeout: timeout * 5 } );
	await page.waitForFunction( () => window.__PONLAI_WORLD__?.ready || ( ! window.__PONLAI_WORLD__ && window.__PONLAI_GPU_GATE__?.asked ),
		null, { timeout: timeout * 5, polling: 100 } );
	const worldMs = Date.now() - t;
	await lock();
	await page.evaluate( () => window.__PONLAI_GPU_GATE__?.open() );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__ && document.getElementById( 'loading' )?.classList.contains( 'done' ),
		null, { timeout, polling: 250 } );
	await stopLoop( page );
	unlock();
	return { worldMs, upMs: Date.now() - t };

}

/** Waits, the loop stopped and the lock released, until the page has its next piece prepared (or
 * stands at the growth horizon), with a progress line every 30 s. */
async function untilReady( page, side ) {

	await stopLoop( page );
	unlock();
	const t = Date.now();
	let said = t;
	for ( ;; ) {

		const s = await page.evaluate( () => {

			const g = window.__PONLAI__.growth;
			// (a page generates the next piece only once asked: Growth.start)
			g.start();
			return { phase: g.state.phase, step: g.state.step, pending: g.state.pending, error: g.state.error };

		} );
		if ( s.phase === 'ready' || s.step >= 36 ) return Date.now() - t;
		if ( s.phase === 'failed' ) throw new Error( `${ side }: the next piece failed: ${ s.error }` );
		if ( Date.now() - said > 30000 ) { said = Date.now(); log( side, `preparing step ${ s.pending } (${ s.phase }), ${ ( ( Date.now() - t ) / 1000 ).toFixed( 0 ) } s` ); }
		await new Promise( ( r ) => setTimeout( r, 1000 ) );

	}

}

/** Waits until `n` more frames have been rendered (the loop running). */
const frames = ( page, n ) => page.evaluate( ( { n, timeout } ) => new Promise( ( resolve, reject ) => {

	const s = window.__PONLAI__, target = s.renderer.info.frame + n, deadline = performance.now() + timeout;
	const tick = () => {

		if ( s.renderer.info.frame >= target ) resolve();
		else if ( performance.now() > deadline ) reject( new Error( `no frame ${ target } within ${ timeout } ms` ) );
		else requestAnimationFrame( tick );

	};
	tick();

} ), { n, timeout } );

const memory = ( page ) => page.evaluate( () => {

	const s = window.__PONLAI__, m = s.renderer.info.memory;
	return { step: s.growth.state.step, geometries: m.geometries, textures: m.textures, uniformBuffers: m.uniformBuffers, renderTargets: m.renderTargets,
		attributes: m.attributes, texturesMB: + ( m.texturesSize / 1e6 ).toFixed( 1 ), attributesMB: + ( m.attributesSize / 1e6 ).toFixed( 1 ),
		pipelines: s.pipelines.total, fieldBytes: s.growth.fieldBytes().total };

} );

/** The page's land-dependent state: hashes, fields, memory, pipelines, the ground grid and the rain
 * map (their data as base64, decoded here). */
async function measure( page ) {

	const m = await page.evaluate( async () => {

		const s = window.__PONLAI__;
		const b64 = ( view ) => new Promise( ( resolve ) => {

			const reader = new FileReader();
			reader.onload = () => resolve( reader.result.slice( reader.result.indexOf( ',' ) + 1 ) );
			reader.readAsDataURL( new Blob( [ view ] ) );

		} );
		const g = s.controls.ground;
		const tgt = s.rain.collision.target, w = tgt.width, h = tgt.height;
		const raw = await s.renderer.readRenderTargetPixelsAsync( tgt, 0, 0, w, h );
		// rows may come padded to 256 bytes
		const stride = raw.length / h, map = new Uint16Array( w * h * 4 );
		for ( let y = 0; y < h; y ++ ) map.set( raw.subarray( y * stride, y * stride + w * 4 ), y * w * 4 );
		return {
			step: s.growth.state.step,
			hashes: s.growth.chunkHashes(),
			fields: s.growth.fieldBytes(),
			ambient: { hash: await s.ambientVolume.hash(), ...s.ambientVolume.info(), irradiance: await s.ambientRelight.hash() },
			memory: { ...s.renderer.info.memory },
			pipelines: s.pipelines.total,
			ground: { nx: g.nx, nz: g.nz, x0: g.x0, z0: g.z0, heights: await b64( g.heights ) },
			rain: { w, h, xform: s.rain.collision.xform.value.toArray(), data: await b64( map ) },
		};

	} );
	const buf = ( text ) => Buffer.from( text, 'base64' );
	const g = buf( m.ground.heights ), r = buf( m.rain.data );
	m.ground.heights = new Float32Array( g.buffer, g.byteOffset, g.byteLength / 4 );
	m.rain.data = new Uint16Array( r.buffer, r.byteOffset, r.byteLength / 2 );
	return m;

}

/** Brings the page to `view` (`jump`: by the scene jump; otherwise as loaded), waits until it is
 * ready and shoots it twice, two frames apart. */
async function shoot( page, side, view, jump ) {

	const t = Date.now();
	await lock();
	// the jump with the loop stopped, then the loop started (as capture.mjs's worker jumps)
	if ( jump ) await page.evaluate( ( q ) => window.__PONLAI__.establishScene( q ), viewQuery( view ) );
	const settle = await rendering( page, async () => {

		await frames( page, 1 );
		// a grow keeps the player's camera where it is; the island view's pose follows the land (the
		// R key), so the view starts from it on both pages
		await page.evaluate( () => { const s = window.__PONLAI__; s.setCameraMode( 'orbit' ); s.setCameraView( 'island' ); } );
		await page.evaluate( viewEval( view ) );
		await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.settled === true, null, { timeout, polling: 'raf' } );
		return waitForStable( page, { timeout } );

	} );
	const shooter = await pngShooter( page, { timeout } );
	try {

		const a = await shooter.shoot();
		await startLoop( page );
		await frames( page, 2 );
		await stopLoop( page );
		const b = await shooter.shoot();
		writeFileSync( path.join( out, `${ side }-${ view }.png` ), a );
		writeFileSync( path.join( out, `${ side }-${ view }-b.png` ), b );
		const stable = samePixels( a, b ) ? 0 : compareFrames( decodePng( a ), decodePng( b ) ).over[ 0 ];
		log( side, view, `ready ${ settle.status } after ${ settle.framesWaited ?? 0 } frames, ${ stable === 0 ? 'stable' : `${ stable } px changed in two frames` } (${ ( ( Date.now() - t ) / 1000 ).toFixed( 0 ) } s)` );
		return { png: [ a, b ], record: { jump, ready: settle.status, framesWaited: settle.framesWaited, stable: stable === 0, changedPixels: stable } };

	} finally {

		await shooter.close();

	}

}

// ------------------------------------------------------------------ the two pages

const report = { base, steps, freshGrow, views, query: viewQuery( views[ 0 ] ), memoryTolerance: MEMORY_TOLERANCE, pages: {} };
const shots = { G: {}, F: {} };
const measured = {};
let failure = null;
const capture = await launchCapture( { viewport: { width: W, height: H }, deviceScaleFactor: 1, url: base } );
try {

	const page = capture.page;
	// the GPU gate (as capture.mjs's, "The slot after the world"): the page gets its device only once
	// the lock is held
	await page.addInitScript( () => {

		if ( ! window.GPUAdapter || window !== window.top ) return;
		let open;
		const gate = new Promise( ( resolve ) => { open = resolve; } );
		const state = window.__PONLAI_GPU_GATE__ = { open: () => open(), asked: false };
		const proto = GPUAdapter.prototype, requestDevice = proto.requestDevice;
		proto.requestDevice = async function ( ...a ) {

			state.asked = true;
			await gate;
			return requestDevice.apply( this, a );

		};

	} );
	for ( const side of [ 'G', 'F' ] ) {

		const grow = side === 'G' ? 0 : freshGrow;
		const rec = report.pages[ side ] = { url: `${ base }?${ merge( report.query, `grow=${ grow }` ) }`, console: { errors: [], warnings: [] } };
		const onConsole = ( m ) => {

			if ( m.type() === 'error' ) rec.console.errors.push( m.text().slice( 0, 400 ) );
			else if ( m.type() === 'warning' ) rec.console.warnings.push( m.text().slice( 0, 400 ) );

		};
		const onError = ( e ) => rec.console.errors.push( `pageerror: ${ e.message.slice( 0, 400 ) }` );
		page.on( 'console', onConsole );
		page.on( 'pageerror', onError );
		try {

			log( side, 'loading', rec.url );
			rec.load = await loadPage( page, rec.url );
			rec.memory = [ await memory( page ) ];
			log( side, `up in ${ ( rec.load.upMs / 1000 ).toFixed( 0 ) } s (world ${ ( rec.load.worldMs / 1000 ).toFixed( 0 ) } s), step ${ rec.memory[ 0 ].step }, pipelines ${ rec.memory[ 0 ].pipelines }` );
			if ( side === 'G' ) {

				rec.grows = [];
				for ( let k = 0; k < steps; k ++ ) {

					const prepareMs = await untilReady( page, side );
					const g = await rendering( page, async () => {

						const r = await page.evaluate( async () => {

							const s = window.__PONLAI__;
							const before = s.pipelines.total, t = performance.now();
							await s.growth.grow();
							return { step: s.growth.state.step, ms: Math.round( performance.now() - t ), pipelinesBefore: before, swapMs: s.growth.state.last?.ms.swap ?? null };

						} );
						// a few frames after the swap's own
						await frames( page, 10 );
						r.pipelinesAfter = await page.evaluate( () => window.__PONLAI__.pipelines.total );
						return r;

					} );
					g.prepareMs = prepareMs;
					rec.grows.push( g );
					rec.memory.push( await memory( page ) );
					const m = rec.memory.at( - 1 );
					log( side, `grew to step ${ g.step } (prepared ${ ( prepareMs / 1000 ).toFixed( 0 ) } s, grow ${ g.ms } ms, swap ${ g.swapMs?.toFixed?.( 1 ) ?? g.swapMs } ms), pipelines ${ g.pipelinesBefore } -> ${ g.pipelinesAfter }, uniformBuffers ${ m.uniformBuffers }, textures ${ m.textures }` );

				}

			}
			// the pending piece prepared on both pages, then frames, then the measures
			await untilReady( page, side );
			const m = await rendering( page, async () => {

				await frames( page, 30 );
				return measure( page );

			} );
			measured[ side ] = m;
			rec.step = m.step;
			rec.measured = { pipelines: m.pipelines, memory: m.memory, fields: m.fields, ambient: m.ambient, chunks: Object.keys( m.hashes ).length,
				ground: { nx: m.ground.nx, nz: m.ground.nz, x0: m.ground.x0, z0: m.ground.z0 }, rain: { w: m.rain.w, h: m.rain.h, xform: m.rain.xform } };
			log( side, `measured at step ${ m.step }: ${ rec.measured.chunks } chunks, pipelines ${ m.pipelines }, uniformBuffers ${ m.memory.uniformBuffers }, textures ${ m.memory.textures }, rain map ${ m.rain.w } x ${ m.rain.h }` );
			rec.shots = {};
			for ( const [ i, view ] of views.entries() ) {

				const s = await shoot( page, side, view, i > 0 );
				shots[ side ][ view ] = s.png;
				rec.shots[ view ] = s.record;

			}
			rec.pipelinesAfterViews = await page.evaluate( () => window.__PONLAI__.pipelines.total );
			unlock();

		} finally {

			page.off( 'console', onConsole );
			page.off( 'pageerror', onError );

		}

	}

} catch ( error ) {

	failure = error;

} finally {

	unlock();
	await capture.close().catch( () => {} );

}

// ------------------------------------------------------------------ comparison

const half = ( u ) => { const e = ( u >> 10 ) & 31, m = u & 1023, s = u >> 15 ? - 1 : 1; return e === 0 ? s * m * 2 ** - 24 : e === 31 ? NaN : s * ( 1 + m / 1024 ) * 2 ** ( e - 15 ); };

function compareRain( a, b ) {

	const r = { size: [ [ a.w, a.h ], [ b.w, b.h ] ], sameSize: a.w === b.w && a.h === b.h, sameXform: a.xform.every( ( v, i ) => v === b.xform[ i ] ) };
	if ( ! r.sameSize ) return r;
	let differ = 0, maxHeightDiff = 0;
	const box = [ Infinity, Infinity, - Infinity, - Infinity ];
	for ( let y = 0; y < a.h; y ++ ) for ( let x = 0; x < a.w; x ++ ) {

		const i = ( y * a.w + x ) * 4;
		if ( a.data[ i ] === b.data[ i ] && a.data[ i + 1 ] === b.data[ i + 1 ] && a.data[ i + 2 ] === b.data[ i + 2 ] && a.data[ i + 3 ] === b.data[ i + 3 ] ) continue;
		differ ++;
		maxHeightDiff = Math.max( maxHeightDiff, Math.abs( half( a.data[ i ] ) - half( b.data[ i ] ) ) || 0 );
		box[ 0 ] = Math.min( box[ 0 ], x ); box[ 1 ] = Math.min( box[ 1 ], y ); box[ 2 ] = Math.max( box[ 2 ], x ); box[ 3 ] = Math.max( box[ 3 ], y );

	}
	return Object.assign( r, { texels: a.w * a.h, differ, maxHeightDiff: + maxHeightDiff.toFixed( 3 ), boxTexels: differ ? box : null } );

}

function compareGround( a, b ) {

	// the height at ( x, z ) as the camera reads it: the sea (0) outside the grid
	const at = ( g, x, z ) => {

		const i = Math.floor( ( x - g.x0 ) / GROUND_CELL ), k = Math.floor( ( z - g.z0 ) / GROUND_CELL );
		return i < 0 || k < 0 || i >= g.nx || k >= g.nz ? 0 : Math.max( g.heights[ k * g.nx + i ], 0 );

	};
	const x0 = Math.min( a.x0, b.x0 ), z0 = Math.min( a.z0, b.z0 );
	const x1 = Math.max( a.x0 + a.nx * GROUND_CELL, b.x0 + b.nx * GROUND_CELL ), z1 = Math.max( a.z0 + a.nz * GROUND_CELL, b.z0 + b.nz * GROUND_CELL );
	let cells = 0, differ = 0, maxDiff = 0;
	for ( let z = z0 + GROUND_CELL / 2; z < z1; z += GROUND_CELL ) for ( let x = x0 + GROUND_CELL / 2; x < x1; x += GROUND_CELL ) {

		cells ++;
		const d = Math.abs( at( a, x, z ) - at( b, x, z ) );
		if ( d > 0 ) { differ ++; maxDiff = Math.max( maxDiff, d ); }

	}
	return { sameGrid: a.nx === b.nx && a.nz === b.nz && a.x0 === b.x0 && a.z0 === b.z0, grids: [ [ a.nx, a.nz, a.x0, a.z0 ], [ b.nx, b.nz, b.x0, b.z0 ] ], cells, differ, maxDiff: + maxDiff.toFixed( 3 ) };

}

const verdicts = {};
const compare = report.compare = {};
if ( failure ) {

	report.error = failure.stack ?? String( failure );
	log( 'run failed:', failure.message );

} else {

	const G = measured.G, F = measured.F, pg = report.pages.G, pf = report.pages.F;
	compare.views = {};
	let viewsOk = true;
	for ( const view of views ) {

		const pair = ( k ) => {

			const a = shots.G[ view ][ k ], b = shots.F[ view ][ k ];
			return samePixels( a, b ) ? { identical: true } : { identical: false, ...compareFrames( decodePng( a ), decodePng( b ) ) };

		};
		const first = pair( 0 );
		const c = { ...first, second: pair( 1 ).identical, changedPixels: { G: pg.shots[ view ].changedPixels, F: pf.shots[ view ].changedPixels } };
		c.pass = c.identical || c.second;
		compare.views[ view ] = c;
		viewsOk &&= c.pass;

	}
	verdicts.views = viewsOk;
	const keys = [ ...new Set( [ ...Object.keys( G.hashes ), ...Object.keys( F.hashes ) ] ) ].sort();
	compare.hashes = { chunks: [ Object.keys( G.hashes ).length, Object.keys( F.hashes ).length ], differ: keys.filter( ( k ) => G.hashes[ k ] !== F.hashes[ k ] ) };
	verdicts.hashes = compare.hashes.differ.length === 0;
	compare.rain = compareRain( G.rain, F.rain );
	verdicts.rain = compare.rain.sameSize && compare.rain.sameXform && compare.rain.differ === 0;
	compare.ground = compareGround( G.ground, F.ground );
	verdicts.ground = compare.ground.sameGrid && compare.ground.differ === 0;
	compare.fields = { G: G.fields, F: F.fields };
	verdicts.fields = JSON.stringify( G.fields ) === JSON.stringify( F.fields );
	compare.ambient = { G: G.ambient, F: F.ambient };
	verdicts.ambient = JSON.stringify( G.ambient ) === JSON.stringify( F.ambient );
	const perStep = pg.grows.flatMap( ( g ) => [ g.pipelinesBefore, g.pipelinesAfter ] );
	compare.pipelines = { grows: perStep, measured: [ G.pipelines, F.pipelines ], afterViews: [ pg.pipelinesAfterViews, pf.pipelinesAfterViews ] };
	verdicts.pipelines = perStep.every( ( p ) => p === perStep[ 0 ] ) && G.pipelines === F.pipelines && pg.pipelinesAfterViews === pf.pipelinesAfterViews;
	compare.memory = Object.fromEntries( [ 'geometries', 'textures', 'uniformBuffers', 'renderTargets', 'attributes', 'programs' ].filter( ( k ) => k in G.memory ).map( ( k ) => [ k, [ G.memory[ k ], F.memory[ k ] ] ] ) );
	verdicts.memory = [ 'uniformBuffers', 'textures' ].every( ( k ) => G.memory[ k ] - F.memory[ k ] <= MEMORY_TOLERANCE );
	compare.console = { errors: [ pg.console.errors.length, pf.console.errors.length ], warnings: [ pg.console.warnings.length, pf.console.warnings.length ] };
	verdicts.console = pg.console.errors.length === 0 && pf.console.errors.length === 0;
	compare.steps = [ G.step, F.step ];

}
report.verdicts = verdicts;
report.passed = ! failure && Object.values( verdicts ).every( Boolean );
writeFileSync( path.join( out, 'report.json' ), JSON.stringify( report, null, 1 ) );

if ( ! failure ) {

	const c = compare;
	const line = ( name, text ) => console.log( `${ verdicts[ name ] ? 'pass' : 'FAIL' }  ${ name.padEnd( 9 ) } ${ text }` );
	console.log( `\ngrown 0 -> ${ c.steps[ 0 ] } against a fresh load of step ${ c.steps[ 1 ] }` );
	const viewText = ( v ) => {

		const x = c.views[ v ], noise = x.changedPixels.G + x.changedPixels.F;
		const text = x.identical ? 'identical' : x.second ? 'second shots identical' : `${ x.over[ 0 ] } px differ (max ${ x.max })`;
		return `${ v } ${ text }${ noise ? ` (${ x.changedPixels.G } / ${ x.changedPixels.F } px changed between shots)` : '' }`;

	};
	line( 'views', views.map( viewText ).join( ', ' ) );
	line( 'hashes', `${ c.hashes.chunks.join( ' / ' ) } chunks, ${ c.hashes.differ.length } differ` );
	line( 'rain', c.rain.sameSize ? `${ c.rain.differ } of ${ c.rain.texels } texels differ${ c.rain.sameXform ? '' : ', xform differs' }` : `sizes differ ${ JSON.stringify( c.rain.size ) }` );
	line( 'ground', `${ c.ground.differ } of ${ c.ground.cells } cells differ${ c.ground.sameGrid ? '' : ', grids differ' }` );
	line( 'fields', `${ c.fields.G.total } / ${ c.fields.F.total } bytes` );
	line( 'ambient', `${ c.ambient.G.probes } / ${ c.ambient.F.probes } probes, ${ verdicts.ambient ? 'equal' : 'differ' }` );
	line( 'pipelines', `grows ${ [ ...new Set( c.pipelines.grows ) ].join( ', ' ) }, measured ${ c.pipelines.measured.join( ' / ' ) }, after views ${ c.pipelines.afterViews.join( ' / ' ) }` );
	line( 'memory', `uniformBuffers ${ c.memory.uniformBuffers.join( ' / ' ) }, textures ${ c.memory.textures.join( ' / ' ) } (G at most ${ MEMORY_TOLERANCE } above F)` );
	line( 'console', `errors ${ c.console.errors.join( ' / ' ) }, warnings ${ c.console.warnings.join( ' / ' ) }` );

}
console.log( `\n${ report.passed ? 'PASS' : 'FAIL' }: ${ path.join( out, 'report.json' ) }` );
process.exit( report.passed ? 0 : 1 );
