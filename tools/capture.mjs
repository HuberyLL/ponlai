// Full-resolution captures of the running dev server (or a preview build) for visual review.
//   node tools/capture.mjs [name] [--w 1600 --h 900] [--q "query"] [--eval "js"] [--verbose] [--exclusive]
//                          [--wait-for "js expression"] [--frames n --every k] [--timeout 60000]
//                          [--stable-min 1] [--stable-every 2] [--stable-repeats 1] [--stable-tolerance 0:5000|exact]
//                          [--stable-patience 40] [--stable-cap 120] [--stable-trace] [--ready-frames n] [--wait ms] [--settle ms]
//   node tools/capture.mjs --worker --url <base> [--w --h --scale --timeout, the options above] [--page-per-view]
// Writes artifacts/captures/<name>.png and prints the page's console errors and diagnostics.
// The browser runs in a persistent profile slot and a paused capture (MSAA or off) is taken once its
// image has stopped changing (tools/capture-browser.mjs, "readiness by stability"): after the evals, the
// floor's frames (--stable-min) and the loading screen gone, the image is grabbed every
// --stable-every frames, with the loop stopped for each grab, and shot once --stable-repeats
// comparisons in a row found it unchanged; after --stable-patience frames a comparison with at most
// <pixels> pixels differing by more than <level> (--stable-tolerance) counts too, and after
// --stable-cap frames the page is shot anyway (printed as unstable). The JSON's `ready` records it
// (status exact|tolerance|capped, frames waited, comparisons, the largest difference, per
// comparison its pixel counts; --stable-trace adds each grab's PNG hash). --ready-frames n waits for
// n rendered frames instead, as a running (not paused) capture does (60). --wait and --settle (ms)
// add fixed delays before and after the floor. The frame loop is stopped (the GPU queue drained)
// for the shot, which is the compositor's image PNG-encoded for speed (the pixels of Playwright's
// screenshot, not its bytes: compare captures by decoded pixels; tools/capture-browser.mjs).
// --wait-for polls the expression in the page (up to 60 s) once it is up (before the stability wait) and captures once it
// is truthy (e.g. a temporal resolve's convergence flag). --frames n captures n frames, k rendered
// frames apart (default 1): <name>.png, then <name>.f1.png ... <name>.f<n-1>.png; the loop runs
// between them and stops for each shot.
// --timeout (ms) bounds each wait for the page (its load, its readiness, a screenshot);
// raise it when other pages keep the GPU busy. The JSON holds the page's `window.__PONLAI_CROPS__`
// (tools/parity/views.mjs) as `crops` when it is set, and the profile slot it ran in (`slot`).
// --eval may be given more than once: each runs in the page in order, awaited (tools/parity's
// capture-set passes the view's own first, then any given after its `--`).
// A paused capture takes the GPU lock shared (its pixels do not depend on what else renders);
// a running one, or --exclusive, takes it to itself, since its frame times are reported too.
// A paused page of the temporal modes (aa=taa|taau|gt) shows its rest image once that has
// converged (src/post/TemporalRest.ts): once up the rest is started over (its epoch: what the
// evals changed need not be in its key) and the capture waits for `diag.taa.converged`, stops the
// loop on the held rest and shoots it, with no image comparison (the --stable-* options do not
// apply; `ready.status` is `converged`). With `tier.taa.restSequence=0` there is no rest: the page
// is compared for stability like an MSAA one.
//
// Worker (--worker): one page for many views, driven by tools/parity/capture-set.mjs over the IPC
// channel it opens (plan item #9, "one page per set"). The worker asks for a view, captures it,
// reports and asks again, until told it is done; the first view is a fresh load of
// `<url>?<query>`, each later one is reached in place by the exact scene jump:
// `await __PONLAI__.establishScene( <the view's query> )`, the loop started, one frame rendered at
// the jump's camera, then the view's evals and everything above, as after a load (src/main.ts:
// the frame then equals a fresh load's, byte for byte wherever the fresh load repeats). Only
// load-time options (quality, aa, size and dpr, the debug switches) need a new page, and every view
// of a set shares them.
// - Capability: the page must say it keeps that contract (`__PONLAI__.sceneJump === SCENE_JUMP`);
//   older builds have an `establishScene` that takes only an options form and leaves state behind,
//   so on them (and with --page-per-view) the worker stops after its first view, and capture-set
//   starts a fresh worker per view: a page per view, as before.
// - The GPU lock's slot is held per view (from the load or jump to the shot), not per page: the
//   page stands stopped between views, and a set and another task's one-view probe interleave.
// - A view that fails (a timeout, a page or console error, a crash, no answer within the view's
//   deadline: three times --timeout plus a minute) ends the worker: the page is not trusted after
//   it. capture-set retries that view (--retries) and the views still to come on a fresh page.
// - Each view's files go straight to the path capture-set names (`<out>.png`, `.json`, `.f<i>.png`);
//   the JSON adds `page`: the visit's index on the page, `load` or `jump`, the view before, the wait
//   for the GPU lock and the time from then to the written shot (ms), and the page's memory then (JS heap, DOM nodes, listeners, renderer.info's geometries and textures).
import { acquireGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { launchCapture, waitForScene, waitForStable, stableOptions, stopLoop, startLoop, pngShooter, READY_FRAMES } from './capture-browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

/** The scene jump contract's version this tool drives (`__PONLAI__.sceneJump`, src/main.ts). */
const SCENE_JUMP = 1;

const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const worker = args.includes( '--worker' );
const name = ! worker && args[ 0 ] && ! args[ 0 ].startsWith( '--' ) ? args[ 0 ] : 'shot';
const W = Number( opt( 'w', 1600 ) ), H = Number( opt( 'h', 900 ) );
const argEvals = args.flatMap( ( a, i ) => a === '--eval' && args[ i + 1 ] ? [ args[ i + 1 ] ] : [] );
const wait = Number( opt( 'wait', 0 ) ), settle = Number( opt( 'settle', 0 ) );
const stable = stableOptions( ( k ) => k === 'stable-trace' ? ( args.includes( '--stable-trace' ) ? '' : undefined ) : opt( k ) );
const baseUrl = opt( 'url', 'http://127.0.0.1:5190/' );
const sampleCount = Number( opt( 'samples', 1 ) );
const waitFor = opt( 'wait-for', '' );
const timeout = Number( opt( 'timeout', 60000 ) );
const frameCount = Math.max( 1, Number( opt( 'frames', 1 ) ) );
const frameEvery = Math.max( 1, Number( opt( 'every', 1 ) ) );
const verbose = args.includes( '--verbose' );
const paused = ( query ) => new URLSearchParams( query ).has( 'paused' );
// the fixed frame count instead of stability: --ready-frames n, or a running scene (it never stands still)
const readyFramesFor = ( query ) => args.includes( '--ready-frames' ) ? Number( opt( 'ready-frames' ) ) : paused( query ) ? null : READY_FRAMES;
// tools/gpu-lock.mjs: shared for a paused scene, exclusive otherwise
const sharedFor = ( query ) => paused( query ) && ! args.includes( '--exclusive' );

// a promise that rejects after `ms` (a page that stopped answering)
function within( promise, ms, what ) {

	let timer;
	return Promise.race( [
		promise.finally( () => clearTimeout( timer ) ),
		new Promise( ( resolve, reject ) => { timer = setTimeout( () => reject( new Error( `${ what }: no answer within ${ ms } ms` ) ), ms ); } ),
	] );

}

/** Opens the capture page and listens to it: `begin()` starts a view's error record. */
async function openPage( viewport ) {

	const capture = await launchCapture( viewport );
	const page = capture.page;
	let current = { errors: [], failures: [] };
	page.on( 'console', ( m ) => { if ( verbose || m.type() === 'error' || m.type() === 'warning' ) current.errors.push( m.type() + ': ' + m.text() ); } );
	page.on( 'pageerror', ( e ) => current.errors.push( 'pageerror: ' + e.message ) );
	page.on( 'crash', () => current.errors.push( 'pageerror: the page crashed' ) );
	page.on( 'response', ( r ) => { if ( r.status() >= 400 ) current.failures.push( `${ r.status() } ${ r.url() }` ); } );
	page.on( 'requestfailed', ( r ) => current.failures.push( `${ r.failure()?.errorText } ${ r.url() }` ) );
	return { capture, page, begin: () => ( current = { errors: [], failures: [] } ) };

}

const failed = ( record ) => record.errors.some( ( e ) => e.startsWith( 'pageerror:' ) || e.startsWith( 'error:' ) ) || record.failures.length > 0;

// the renderer's frame counter (three's animation loop: rendered frames only)
const renderedFrame = ( page ) => page.evaluate( () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 );

/** Brings the page to the view (`load`: a fresh load of `url`; `jump`: the scene jump to `query`),
 * waits until it is ready and shoots it into `<out>.png` (and further frames), `<out>.json`.
 * `pageInfo` (async) adds the JSON's `page`. Returns { out, ready, diag, record }. */
async function captureView( session, { url, query, evals, out, mode, pageInfo = null } ) {

	const { capture, page } = session;
	const record = session.begin();
	if ( mode === 'load' ) {

		await page.goto( url );
		await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );

	} else {

		// the scene jump (src/main.ts `establishScene`), then a frame at the jump's camera before the
		// evals move it, as a fresh load's first frames are
		const jumped = await within( page.evaluate( async ( q ) => {

			const s = window.__PONLAI__;
			await s.establishScene( q );
			s.loop.start();
			return s.renderer.info.frame;

		}, query ), timeout, 'establishScene' );
		await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout, polling: 'raf' } );

	}
	for ( const js of evals ) await page.evaluate( js );
	const readyFrames = readyFramesFor( query );
	// up: the floor's frames after the evals, the loading screen gone (an edit can trigger a Vite reload)
	await waitForScene( page, { frames: readyFrames ?? stable.min, wait, settle, timeout } );
	// a paused temporal page: its rest, started over after the evals, converged
	if ( paused( query ) ) {

		await page.evaluate( () => window.__PONLAI__?.taa?.epoch.bump( 'capture' ) );
		await page.waitForFunction( () => {

			const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
			return ! t || t.restTarget === 0 || ( t.converged && t.restEpoch === window.__PONLAI__.taa.epoch.value );

		}, null, { timeout, polling: 100 } );

	}
	if ( waitFor ) await page.waitForFunction( waitFor, null, { timeout: 60000, polling: 100 } );
	// ready: the image stopped changing, or a temporal page's rest converged (or the fixed count
	// above); the loop is stopped
	const ready = readyFrames === null ? await waitForStable( page, { ...stable, timeout } ) : { rule: 'frames', frames: readyFrames };
	const samples = [];
	for ( let i = 0; i < sampleCount; i ++ ) {

		if ( i > 0 ) await page.waitForTimeout( 1000 );
		samples.push( await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) ) );

	}
	const frames = [];
	// the shot: the compositor's image, PNG encoded for speed (tools/capture-browser.mjs, "The shot")
	const shooter = await pngShooter( page, { timeout } );
	for ( let i = 0; i < frameCount; i ++ ) {

		if ( i > 0 ) {

			await startLoop( page );
			await page.waitForFunction( ( f ) => ( window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 ) >= f,
				frames[ i - 1 ].frame + frameEvery, { timeout, polling: 'raf' } );

		}
		// no frames queued behind the shot (tools/capture-browser.mjs)
		await stopLoop( page );
		const frame = await renderedFrame( page );
		const file = i === 0 ? `${ out }.png` : `${ out }.f${ i }.png`;
		await writeFile( file, await shooter.shoot() );
		frames.push( { file, frame } );

	}
	// (the device metrics back before the crop anchors read the page's ratio)
	await shooter.close();
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const crops = await page.evaluate( () => window.__PONLAI_CROPS__ ?? null );
	session.gpu ??= await page.evaluate( async () => {

		const adapter = await navigator.gpu.requestAdapter();
		return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null;

	} );
	const visit = pageInfo ? await pageInfo() : null;
	const json = {
		url, viewport: { width: W, height: H }, browser: capture.version, slot: capture.slot, ready, samples, diag, gpu: session.gpu,
		errors: record.errors, failures: record.failures,
		meanFrameMs: samples.reduce( ( s, d ) => s + d.frameMs, 0 ) / samples.length,
		...( frameCount > 1 ? { frames } : {} ), ...( crops ? { crops } : {} ), ...( visit ? { page: visit } : {} ),
	};
	await writeFile( `${ out }.json`, JSON.stringify( json, null, 2 ) );
	return { out: `${ out }.png`, ready, diag, record };

}

// the lines capture.mjs prints for a view
function report( { out, ready, diag, record } ) {

	const lines = [];
	if ( ready.status === 'capped' ) lines.push( `unstable: still changing after ${ ready.framesWaited } frames (max ${ ready.maxSeen } levels), captured at the cap` );
	lines.push( `${ out } ${ JSON.stringify( diag ) }` );
	if ( record.errors.length ) lines.push( record.errors.slice( 0, verbose ? 60 : 12 ).join( '\n' ) );
	if ( record.failures.length ) lines.push( record.failures.join( '\n' ) );
	return lines.join( '\n' );

}

// the page's memory after a shot (JS heap, DOM, renderer counts), for the worker's JSON
async function pageMemory( page ) {

	const cdp = await page.context().newCDPSession( page );
	try {

		await cdp.send( 'Performance.enable' );
		const { metrics } = await cdp.send( 'Performance.getMetrics' );
		await cdp.send( 'Performance.disable' );
		const m = Object.fromEntries( metrics.map( ( x ) => [ x.name, x.value ] ) );
		const info = await page.evaluate( () => {

			const r = window.__PONLAI__.renderer;
			return { geometries: r.info.memory.geometries, textures: r.info.memory.textures, frame: r.info.frame };

		} );
		return { jsHeapUsed: m.JSHeapUsedSize, jsHeapTotal: m.JSHeapTotalSize, nodes: m.Nodes, listeners: m.JSEventListeners, ...info };

	} finally {

		await cdp.detach().catch( () => {} );

	}

}

if ( ! worker ) {

	const query = opt( 'q', 'paused&t=12&dpr=1' );
	const url = `${ baseUrl }?${ query }`;
	await mkdir( 'artifacts/captures', { recursive: true } );
	await acquireGpuLock( `capture ${ name }`, { shared: sharedFor( query ) } );
	const session = await openPage( { viewport: { width: W, height: H }, deviceScaleFactor: Number( opt( 'scale', 1 ) ) } );
	try {

		const shot = await captureView( session, { url, query, evals: argEvals, out: `artifacts/captures/${ name }`, mode: 'load' } );
		console.log( report( shot ) );
		if ( failed( shot.record ) ) process.exitCode = 1;

	} finally {

		await session.capture.close();
		releaseGpuLock();

	}

} else {

	// capture-set's worker (see the header): views arrive over IPC
	if ( ! process.send ) { console.error( 'capture.mjs --worker runs under tools/parity/capture-set.mjs (an IPC channel)' ); process.exit( 2 ); }
	const send = ( message ) => new Promise( ( resolve ) => process.send( message, () => resolve() ) );
	const next = () => new Promise( ( resolve ) => {

		process.once( 'message', resolve );
		process.send( { type: 'next' } );

	} );
	// (capture-set gone: no orphaned browser; Playwright closes it on exit)
	process.on( 'disconnect', () => process.exit( 1 ) );
	const onePerPage = args.includes( '--page-per-view' );
	const viewDeadline = timeout * 3 + 60000;
	const session = await openPage( { viewport: { width: W, height: H }, deviceScaleFactor: Number( opt( 'scale', 1 ) ) } );
	let jump = false, previous = null;
	try {

		for ( let index = 0; ; index ++ ) {

			const message = await next();
			if ( message.type !== 'view' ) break;
			const { key, query, evals, out } = message.view;
			const mode = index === 0 ? 'load' : 'jump';
			const url = `${ baseUrl }?${ query }`;
			const started = Date.now();
			const lockMs = await acquireGpuLock( `capture ${ key }`, { shared: sharedFor( query ) } );
			let result;
			try {

				const shot = await within( captureView( session, { url, query, evals: [ ...evals, ...argEvals ], out, mode,
					pageInfo: async () => ( { visit: index, mode, from: previous, pid: process.pid, lockMs, ms: Date.now() - started - lockMs, memory: await pageMemory( session.page ) } ) } ), viewDeadline, `view ${ key }` );
				result = { ok: ! failed( shot.record ), log: report( shot ) };

			} catch ( error ) {

				result = { ok: false, log: `${ key }: ${ error.message ?? error }` };

			} finally {

				releaseGpuLock();

			}
			if ( index === 0 && result.ok ) {

				const marker = await session.page.evaluate( () => window.__PONLAI__?.sceneJump ?? null ).catch( () => null );
				jump = marker === SCENE_JUMP;
				await send( { type: 'page', jump, marker } );

			}
			await send( { type: 'shot', key, mode, from: previous, seconds: ( Date.now() - started - lockMs ) / 1000, lockSeconds: lockMs / 1000, ...result } );
			// a failed view leaves a page not to be trusted; without the jump, a page per view
			if ( ! result.ok || ! jump || onePerPage ) break;
			previous = key;

		}

	} finally {

		await within( session.capture.close(), 30000, 'close' ).catch( () => {} );
		process.removeAllListeners( 'disconnect' );
		process.disconnect?.();

	}

}
