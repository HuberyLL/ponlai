// Full-resolution captures of the running dev server (or a preview build) for visual review.
//   node tools/capture.mjs [name] [--w 1600 --h 900] [--q "query"] [--eval "js"] [--verbose] [--exclusive]
//                          [--wait-for "js expression"] [--frames n --every k] [--timeout 60000]
//                          [--stable-min 10] [--stable-every 2] [--stable-repeats 2] [--stable-tolerance 0:5000|exact]
//                          [--stable-patience 40] [--stable-cap 120] [--stable-trace] [--ready-frames n] [--wait ms] [--settle ms]
// Writes artifacts/captures/<name>.png and prints the page's console errors and diagnostics.
// The browser runs in a persistent profile slot and a paused capture is taken once its image has
// stopped changing (tools/capture-browser.mjs, "readiness by stability"): after the evals, the
// floor's frames (--stable-min) and the loading screen gone, the image is grabbed every
// --stable-every frames, with the loop stopped for each grab, and shot once --stable-repeats
// comparisons in a row found it unchanged; after --stable-patience frames a comparison with at most
// <pixels> pixels differing by more than <level> (--stable-tolerance) counts too, and after
// --stable-cap frames the page is shot anyway (printed as unstable). The JSON's `ready` records it
// (status exact|tolerance|capped, frames waited, comparisons, the largest difference, per
// comparison its pixel counts; --stable-trace adds each grab's PNG hash). --ready-frames n waits for
// n rendered frames instead, as a running (not paused) capture does (60). --wait and --settle (ms)
// add fixed delays before and after the floor. The frame loop is stopped (the GPU queue drained)
// for the shot.
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
// evals changed need not be in its key) and the capture waits for `diag.taa.converged` (not with
// `tier.taa.restSequence=0`, where there is no rest), then for stability.
import { acquireGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { launchCapture, waitForScene, waitForStable, stableOptions, stopLoop, startLoop, READY_FRAMES } from './capture-browser.mjs';
import { mkdir, writeFile } from 'node:fs/promises';

const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const name = args[ 0 ] && ! args[ 0 ].startsWith( '--' ) ? args[ 0 ] : 'shot';
const W = Number( opt( 'w', 1600 ) ), H = Number( opt( 'h', 900 ) );
const query = opt( 'q', 'paused&t=12&dpr=1' );
const evals = args.flatMap( ( a, i ) => a === '--eval' && args[ i + 1 ] ? [ args[ i + 1 ] ] : [] );
const wait = Number( opt( 'wait', 0 ) ), settle = Number( opt( 'settle', 0 ) );
// the fixed frame count instead of stability: --ready-frames n, or a running scene (it never stands still)
const paused = new URLSearchParams( query ).has( 'paused' );
const readyFrames = args.includes( '--ready-frames' ) ? Number( opt( 'ready-frames' ) ) : paused ? null : READY_FRAMES;
const stable = stableOptions( ( k ) => k === 'stable-trace' ? ( args.includes( '--stable-trace' ) ? '' : undefined ) : opt( k ) );
const url = `${ opt( 'url', 'http://127.0.0.1:5190/' ) }?${ query }`;
const sampleCount = Number( opt( 'samples', 1 ) );
const waitFor = opt( 'wait-for', '' );
const timeout = Number( opt( 'timeout', 60000 ) );
// Playwright's own screenshot timeout (30 s) unless --timeout is given
const shotTimeout = args.includes( '--timeout' ) ? timeout : undefined;
const frameCount = Math.max( 1, Number( opt( 'frames', 1 ) ) );
const frameEvery = Math.max( 1, Number( opt( 'every', 1 ) ) );

await mkdir( 'artifacts/captures', { recursive: true } );
// tools/gpu-lock.mjs: shared for a paused scene, exclusive otherwise
const sharedLock = new URLSearchParams( query ).has( 'paused' ) && ! args.includes( '--exclusive' );
await acquireGpuLock( `capture ${ name }`, { shared: sharedLock } );
const capture = await launchCapture( { viewport: { width: W, height: H }, deviceScaleFactor: Number( opt( 'scale', 1 ) ) } );
const page = capture.page;
const errors = [];
const failures = [];
const verbose = args.includes( '--verbose' );
page.on( 'console', ( m ) => { if ( verbose || m.type() === 'error' || m.type() === 'warning' ) errors.push( m.type() + ': ' + m.text() ); } );
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
page.on( 'response', ( r ) => { if ( r.status() >= 400 ) failures.push( `${ r.status() } ${ r.url() }` ); } );
page.on( 'requestfailed', ( r ) => failures.push( `${ r.failure()?.errorText } ${ r.url() }` ) );
try {
	await page.goto( url );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
	for ( const js of evals ) await page.evaluate( js );
	// up: the floor's frames after the evals, the loading screen gone (an edit can trigger a Vite reload)
	await waitForScene( page, { frames: readyFrames ?? stable.min, wait, settle, timeout } );
	// a paused temporal page: its rest, started over after the evals, converged
	if ( new URLSearchParams( query ).has( 'paused' ) ) {
		await page.evaluate( () => window.__PONLAI__?.taa?.epoch.bump( 'capture' ) );
		await page.waitForFunction( () => {
			const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
			return ! t || t.restTarget === 0 || ( t.converged && t.restEpoch === window.__PONLAI__.taa.epoch.value );
		}, null, { timeout, polling: 100 } );
	}
	if ( waitFor ) await page.waitForFunction( waitFor, null, { timeout: 60000, polling: 100 } );
	// ready: the image stopped changing (or the fixed count above); the loop is stopped
	const ready = readyFrames === null ? await waitForStable( page, { ...stable, timeout } ) : { rule: 'frames', frames: readyFrames };
	if ( ready.status === 'capped' ) console.log( `unstable: still changing after ${ ready.framesWaited } frames (max ${ ready.maxSeen } levels), captured at the cap` );
	const samples = [];
	for ( let i = 0; i < sampleCount; i ++ ) {
		if ( i > 0 ) await page.waitForTimeout( 1000 );
		samples.push( await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) ) );
	}
	const out = `artifacts/captures/${ name }.png`;
	// the renderer's frame counter (three's animation loop: rendered frames only)
	const renderedFrame = () => page.evaluate( () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 );
	const frames = [];
	for ( let i = 0; i < frameCount; i ++ ) {
		if ( i > 0 ) {
			await startLoop( page );
			await page.waitForFunction( ( f ) => ( window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 ) >= f,
				frames[ i - 1 ].frame + frameEvery, { timeout, polling: 'raf' } );
		}
		// no frames queued behind the shot (tools/capture-browser.mjs)
		await stopLoop( page );
		const frame = await renderedFrame();
		const file = i === 0 ? out : `artifacts/captures/${ name }.f${ i }.png`;
		await page.screenshot( { path: file, timeout: shotTimeout } );
		frames.push( { file, frame } );
	}
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const crops = await page.evaluate( () => window.__PONLAI_CROPS__ ?? null );
	const gpu = await page.evaluate( async () => {
		const adapter = await navigator.gpu.requestAdapter();
		return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null;
	} );
	await writeFile( `artifacts/captures/${ name }.json`, JSON.stringify( {
		url, viewport: { width: W, height: H }, browser: capture.version, slot: capture.slot, ready, samples, diag, gpu, errors, failures,
		meanFrameMs: samples.reduce( ( s, d ) => s + d.frameMs, 0 ) / samples.length,
		...( frameCount > 1 ? { frames } : {} ), ...( crops ? { crops } : {} ),
	}, null, 2 ) );
	console.log( out, JSON.stringify( diag ) );
	if ( errors.length ) console.log( errors.slice( 0, verbose ? 60 : 12 ).join( '\n' ) );
	if ( failures.length ) console.log( failures.join( '\n' ) );
	if ( errors.some( ( e ) => e.startsWith( 'pageerror:' ) || e.startsWith( 'error:' ) ) || failures.length ) process.exitCode = 1;
} finally {
	await capture.close();
	releaseGpuLock();
}
