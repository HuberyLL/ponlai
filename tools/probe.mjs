// A page probe without a screenshot: loads the scene, runs JavaScript in it and prints the values as
// JSON, so a question about the running page (a diagnostic, a timing, a uniform, the pipelines an
// action creates) needs no Playwright script of its own.
//
//   node tools/probe.mjs [url] [--q "paused&t=12&dpr=1"] [--query q2]... [--init js|@file]...
//       [--eval js|@file] [--until js|@file] [--frames n] [--sleep ms] ...  (steps, in order)
//       [--w 1600 --h 900 --scale 1] [--timeout 60000] [--exclusive] [--fresh] [--console [prefix]]
//
// url: the server (default http://127.0.0.1:5190/, the dev server); a production preview needs
// `debug` in the query for `window.__PONLAI__` and the diagnostics (docs/tools.md, Page).
//
// Steps. `--eval`, `--until`, `--frames` and `--sleep` run in the order given, for every query:
// - `--eval js`: runs in the page and records its value. `js` is an expression (`D.timings`), a
//   function (`async () => { ... }`, called), or statements with a `return`; `await` works in all
//   three. `@file` reads it from a file. In scope: `P` = `window.__PONLAI__`, `D` =
//   `window.__THREE_GAME_DIAGNOSTICS__` as the step starts (the page rebuilds that object every 30
//   frames, so most of its counters lag by up to 30 frames: `D.frame` is the frame it was built on;
//   `settled`, `settle` and `taa` are current every frame; read live counters from `P`, such as
//   `P.renderer.info.frame` or `P.pipelines.total`), `frames( n )` (resolves after n rendered frames), `sleep(
//   ms )`, `until( fn, timeoutMs )`. The value is serialised in the page: cycles become "[cycle]",
//   functions "[function]", typed arrays plain arrays (the first 64 entries), three's vectors,
//   colours and matrices their `toArray()`.
// - `--until js`: waits until the expression (same forms and scope) is truthy, checked every
//   rendered frame (every 100 ms while the loop is stopped), up to --timeout; records the wait in ms
//   and frames. Examples: `D.settled` (the paused page will draw the same frame from now on),
//   `D.taa?.converged`, `D.frame > 300`.
// - `--frames n`: waits for n rendered frames; `--sleep ms` waits that long.
// Before the steps, every query waits until the page is up: `__PONLAI__` and the diagnostics exist,
// one frame rendered, and the loading screen gone (its fade finished, tools/capture-browser.mjs
// `waitForScene`). The page is not stopped or settled further: add an `--until` for that.
// `--init js` runs before any of the page's scripts on every load (Playwright's addInitScript), for
// hooks that must see the start, such as wrapping `GPUDevice.prototype.createRenderPipeline`.
//
// Queries. `--q` (or the first `--query`) is loaded; each further `--query` is reached in the same
// page by the exact scene jump (`await __PONLAI__.establishScene( query )`, the loop started, one
// frame rendered: src/main.ts), as tools/parity/capture-set.mjs reaches its views. A query whose
// load-time options differ (quality, aa, dpr, debug switches: establishScene refuses it) and builds
// without the jump (`__PONLAI__.sceneJump`) get a fresh load instead. Each query runs every step.
//
// Output (stdout, JSON): the url, the browser, the profile slot, the GPU lock's wait, and per query
// its `mode` (load|jump), `readyMs` (load or jump until up), `ms` (the whole query), `steps`
// (`{ eval, value }`, `{ eval, error }`, `{ until, ms, frames }`, `{ frames }`, `{ sleep }`),
// the console's errors and warnings and the failed requests; `--console` adds every console line
// (or those starting with the prefix) as `console`. Exits 1 when an eval failed, an `--until`
// timed out or the page threw.
//
// The browser is the capture tools' (tools/capture-browser.mjs): headless, in a persistent profile
// slot, so the world cache and the shader cache are warm from the second probe on. `--fresh` runs in
// a new empty profile instead (a cold load: the island generated, every shader compiled), deleted
// afterwards. The GPU lock is held from before the load to the end of the last query: shared,
// since a probe's values do not depend on what else renders; `--exclusive` takes it alone, for
// frame times (`D.frameMs`) or GPU timings that others' work would disturb.
import { acquireGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { launchCapture, waitForScene } from './capture-browser.mjs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const usage = 'usage: node tools/probe.mjs [url] [--q query] [--query q]... [--init js|@file]... [--eval js|@file] [--until js] [--frames n] [--sleep ms] ... [--w --h --scale] [--timeout ms] [--exclusive] [--fresh] [--console [prefix]] (see the file header)';
const argv = process.argv.slice( 2 );
const options = { w: '1600', h: '900', scale: '1', timeout: '60000' };
const queries = [], inits = [], steps = [];
let url = 'http://127.0.0.1:5190/', consoleFilter = null;
const source = ( text ) => text.startsWith( '@' ) ? readFileSync( text.slice( 1 ), 'utf8' ) : text;
for ( let i = 0; i < argv.length; i ++ ) {

	const a = argv[ i ];
	if ( ! a.startsWith( '--' ) ) { url = a; continue; }
	const k = a.slice( 2 );
	if ( k === 'exclusive' || k === 'fresh' ) { options[ k ] = true; continue; }
	if ( k === 'console' ) { consoleFilter = argv[ i + 1 ] && ! argv[ i + 1 ].startsWith( '--' ) ? argv[ ++ i ] : ''; continue; }
	const v = argv[ ++ i ];
	if ( v === undefined ) { console.error( `--${ k } needs a value\n${ usage }` ); process.exit( 2 ); }
	if ( k === 'q' ) queries.unshift( v );
	else if ( k === 'query' ) queries.push( v );
	else if ( k === 'init' ) inits.push( source( v ) );
	else if ( k === 'eval' || k === 'until' ) steps.push( { [ k ]: v, js: source( v ) } );
	else if ( k === 'frames' || k === 'sleep' ) steps.push( { [ k ]: Number( v ) } );
	else if ( [ 'w', 'h', 'scale', 'timeout' ].includes( k ) ) options[ k ] = v;
	else { console.error( `unknown option --${ k }\n${ usage }` ); process.exit( 2 ); }

}
if ( queries.length === 0 ) queries.push( 'paused&t=12&dpr=1' );
if ( ! url.endsWith( '/' ) && ! url.includes( '?' ) ) url += '/';
const timeout = Number( options.timeout );

/** Runs a step's js in the page with the probe's scope (see the header) and returns its value,
 * serialised in the page. `mode` 'until' polls it until truthy. */
function runInPage( page, js, mode = 'eval' ) {

	return page.evaluate( async ( { js, mode, timeout } ) => {

		const frameNow = () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0;
		const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
		// a frame, or 100 ms when the loop stands (rAF still fires, but no frame is rendered)
		const tick = () => new Promise( ( resolve ) => { const t = setTimeout( resolve, 100 ); requestAnimationFrame( () => { clearTimeout( t ); resolve(); } ); } );
		const until = async ( fn, ms = timeout ) => {

			const deadline = performance.now() + ms;
			for ( ;; ) {

				const v = await fn();
				if ( v ) return v;
				if ( performance.now() > deadline ) throw new Error( `until: not true within ${ ms } ms` );
				await tick();

			}

		};
		const frames = ( n ) => { const target = frameNow() + n; return until( () => frameNow() >= target ); };
		// an expression, else statements; a function value is called
		let body;
		try { new Function( `return (${ js }\n)` ); body = `return (${ js }\n);`; } catch { body = js; }
		const AsyncFunction = ( async () => {} ).constructor;
		const fn = new AsyncFunction( 'P', 'D', 'frames', 'sleep', 'until', body );
		const value = async () => {

			const v = await fn( window.__PONLAI__, window.__THREE_GAME_DIAGNOSTICS__, frames, sleep, until );
			return typeof v === 'function' ? await v() : v;

		};
		const serialise = ( v ) => {

			const seen = new WeakSet();
			return JSON.stringify( v, function ( key, x ) {

				if ( typeof x === 'function' ) return '[function]';
				if ( typeof x === 'bigint' ) return String( x );
				if ( x === undefined && key === '' ) return null;
				if ( x && typeof x === 'object' ) {

					if ( ArrayBuffer.isView( x ) ) return Array.from( x.length > 64 ? x.subarray( 0, 64 ) : x );
					if ( ( x.isVector2 || x.isVector3 || x.isVector4 || x.isColor || x.isQuaternion || x.isMatrix3 || x.isMatrix4 || x.isEuler ) && x.toArray ) return x.toArray();
					if ( seen.has( x ) ) return '[cycle]';
					seen.add( x );

				}
				return x;

			} );

		};
		if ( mode === 'eval' ) return serialise( await value() );
		const from = frameNow(), start = performance.now();
		await until( value );
		return JSON.stringify( { ms: Math.round( performance.now() - start ), frames: frameNow() - from } );

	}, { js, mode, timeout } ).then( ( text ) => text === undefined ? undefined : JSON.parse( text ) );

}

// the page's own frame counter (rendered frames)
const renderedFrame = ( page ) => page.evaluate( () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 );

async function load( page, query ) {

	await page.goto( `${ url }?${ query }` );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } ).catch( async ( error ) => {

		// where the load stood: the loading screen's status line
		const status = await page.evaluate( () => document.querySelector( '#loading span' )?.textContent ?? null ).catch( () => null );
		throw new Error( `page not up within ${ timeout } ms (loading screen: ${ JSON.stringify( status ) }; a production build needs debug in the query): ${ error.message.split( '\n' )[ 0 ] }` );

	} );

}

// the exact scene jump (as capture.mjs's worker makes it); false when the page refuses the query
async function jump( page, query ) {

	const jumped = await page.evaluate( async ( q ) => {

		const s = window.__PONLAI__;
		if ( s.sceneJump !== 1 ) return - 1;
		try { await s.establishScene( q ); } catch ( error ) {

			if ( /reload the page/.test( error.message ) ) return - 1;
			throw error;

		}
		s.loop.start();
		return s.renderer.info.frame;

	}, query );
	if ( jumped < 0 ) return false;
	await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout, polling: 'raf' } );
	return true;

}

const started = Date.now();
const fresh = options.fresh ? mkdtempSync( path.join( tmpdir(), 'ponlai-probe-' ) ) : null;
if ( fresh ) process.env.PONLAI_CAPTURE_PROFILES = fresh;
const lockMs = await acquireGpuLock( `probe ${ queries[ 0 ] }`, { shared: ! options.exclusive } );
const capture = await launchCapture( { viewport: { width: Number( options.w ), height: Number( options.h ) }, deviceScaleFactor: Number( options.scale ) } );
const { page } = capture;
for ( const js of inits ) await capture.context.addInitScript( js );
let record = null;
page.on( 'console', ( m ) => {

	if ( ! record ) return;
	const line = `${ m.type() }: ${ m.text() }`;
	if ( m.type() === 'error' || m.type() === 'warning' ) record.errors.push( line );
	if ( consoleFilter !== null && m.text().startsWith( consoleFilter ) ) record.console.push( consoleFilter ? m.text() : line );

} );
page.on( 'pageerror', ( e ) => record?.errors.push( 'pageerror: ' + e.message ) );
page.on( 'crash', () => record?.errors.push( 'pageerror: the page crashed' ) );
page.on( 'response', ( r ) => { if ( r.status() >= 400 ) record?.failures.push( `${ r.status() } ${ r.url() }` ); } );
page.on( 'requestfailed', ( r ) => record?.failures.push( `${ r.failure()?.errorText } ${ r.url() }` ) );

const out = { url, browser: capture.version, slot: fresh ? 'fresh' : capture.slot, lock: options.exclusive ? 'exclusive' : 'shared', lockMs, queries: [] };
let failed = false;
try {

	for ( let index = 0; index < queries.length; index ++ ) {

		const query = queries[ index ];
		record = { query, mode: null, readyMs: 0, ms: 0, steps: [], errors: [], failures: [], ...( consoleFilter !== null ? { console: [] } : {} ) };
		out.queries.push( record );
		const t0 = Date.now();
		try {

			// (a page whose last query failed is not trusted: a fresh load)
			record.mode = index > 0 && ! out.queries[ index - 1 ].broken && await jump( page, query ) ? 'jump' : 'load';
			if ( record.mode === 'load' ) await load( page, query );
			await waitForScene( page, { frames: 1, timeout } );
			record.readyMs = Date.now() - t0;
			for ( const step of steps ) {

				if ( step.eval !== undefined ) {

					try { record.steps.push( { eval: step.eval, value: await runInPage( page, step.js ) } ); } catch ( error ) {

						record.steps.push( { eval: step.eval, error: error.message.split( '\n' )[ 0 ] } );
						failed = true;

					}

				} else if ( step.until !== undefined ) {

					try { record.steps.push( { until: step.until, ...( await runInPage( page, step.js, 'until' ) ) } ); } catch ( error ) {

						record.steps.push( { until: step.until, error: error.message.split( '\n' )[ 0 ] } );
						failed = true;

					}

				} else if ( step.frames !== undefined ) {

					const from = await renderedFrame( page );
					await page.waitForFunction( ( f ) => ( window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 ) >= f, from + step.frames, { timeout, polling: 'raf' } );
					record.steps.push( { frames: step.frames } );

				} else {

					await page.waitForTimeout( step.sleep );
					record.steps.push( { sleep: step.sleep } );

				}

			}

		} catch ( error ) {

			record.errors.push( `probe: ${ error.message.split( '\n' )[ 0 ] }` );
			failed = true;

		}
		record.ms = Date.now() - t0;
		if ( record.errors.some( ( e ) => e.startsWith( 'pageerror:' ) || e.startsWith( 'probe:' ) ) ) {

			failed = true;
			Object.defineProperty( record, 'broken', { value: true } );

		}

	}

} finally {

	record = null;
	await capture.close().catch( () => {} );
	releaseGpuLock();
	if ( fresh ) rmSync( fresh, { recursive: true, force: true } );

}
out.ms = Date.now() - started;
console.log( JSON.stringify( out, null, 2 ) );
if ( failed ) process.exitCode = 1;
