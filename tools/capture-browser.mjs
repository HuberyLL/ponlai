// The browser and the readiness that tools/capture.mjs and tools/capture-clip.mjs share ("fast
// mode").
//
// Profile slots. Each capture runs in a persistent browser profile instead of a fresh one, so the
// page's world cache (IndexedDB, src/world/WorldCache.ts) and the browser's GPU shader cache hit
// from the second load on: a cache miss generates the island again (about 3 s alone, a minute
// under a busy CPU) and compiles every shader again. A profile serves one browser at a time, so
// the profiles are slots, `<root>/<browser build>/<n>`, each taken with its own lock: the
// directory `<n>.lock` (mkdir is atomic) holding owner.json (pid), stale once that process is gone.
// A capture takes the lowest free slot, so n jobs at once use slots 0..n-1 and keep them warm. The
// slots are independent of tools/gpu-lock.mjs (taken after it, held only while the browser runs).
// - The browser build is in the path because a profile does not move between browser versions:
//   Playwright's Chromium is named by its install folder (`chromium-1243`), a CHROME_PATH browser
//   by its `--version` output.
// - The root is `artifacts/.capture-profiles` of the main checkout (git's common directory), so
//   every worktree shares the warm slots; PONLAI_CAPTURE_PROFILES moves it. Safe to delete.
// - What the profile keeps cannot change a capture: the world cache is keyed on the generator's
//   sources, options and browser (a hit is byte-identical to a miss), and each preview port is its
//   own origin with its own entry; the shader cache is keyed on the shader. The HTTP cache
//   revalidates (Vite's dev and preview servers send `no-cache`). localStorage and sessionStorage
//   (the remembered quality tier, a saved game) are cleared before every page's scripts run.
//
// Readiness. After the page is up and the evals have run, the capture waits for `frames`
// (READY_FRAMES, 60) frames rendered after the evals (the renderer's frame counter) and the loading
// screen gone, instead of the old fixed 7 s, frame > 150 and 1.1 s more. 30 frames left weather and
// night views unsettled; 40 reproduced the old tool's frames except on flowers-close, whose whole
// frame was still about 2 levels darker after 40 frames on 5 of 22 loads and never after 50 (0 of
// 14 loads, the shifted ones included), so 60 keeps a margin. More frames do not make the sparse
// A/A noise of some views rarer (a few pixels of vegetation or sea, at any frame count, as with
// the old tool).
// `wait` and `settle` (ms) bring the fixed delays back, before and after the frame count, for a
// view that needs longer (a bake landing late under a busy GPU). Later the page's own settled
// signal replaces the count.
//
// Stopping the loop. Headless, nothing back-pressures the page: the frame pacer meets 60 fps on the
// JS side while the GPU completes far fewer, so seconds of work pile up in the queue and a
// screenshot waits for the compositor frame behind them. `stopLoop` stops the frame loop
// (`__PONLAI__.loop.stop()`: no more frames, then the queue drained) before the shot; the pixels are
// the same frame's, the shot takes about a second instead of 4-11, and the GPU is free for other
// captures meanwhile. Builds without `loop` are shot with the loop running.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/** The rendered frames a capture waits for after the evals (see Readiness above). */
export const READY_FRAMES = 60;

export const LAUNCH_ARGS = [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ];

function profileRoot() {

	if ( process.env.PONLAI_CAPTURE_PROFILES ) return path.resolve( process.env.PONLAI_CAPTURE_PROFILES );
	let main = REPO;
	try {

		const common = execFileSync( 'git', [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], { cwd: REPO, encoding: 'utf8', timeout: 5000 } ).trim();
		if ( path.basename( common ) === '.git' ) main = path.dirname( common );

	} catch { /* not a git checkout: this one */ }
	return path.join( main, 'artifacts/.capture-profiles' );

}

// a folder name for the browser that will run: profiles do not move between versions
function browserBuild() {

	const exe = process.env.CHROME_PATH || chromium.executablePath();
	if ( ! process.env.CHROME_PATH ) {

		const install = exe.split( path.sep ).find( ( part ) => /^chromium[-_]\d+$/.test( part ) );
		if ( install ) return install;

	}
	let version = '';
	try { version = execFileSync( exe, [ '--version' ], { encoding: 'utf8', timeout: 10000 } ).trim(); } catch { /* named by its path alone */ }
	return ( version || exe ).replace( /[^A-Za-z0-9.]+/g, '-' ).replace( /^-|-$/g, '' ).slice( 0, 80 );

}

function alive( pid ) {

	if ( ! ( pid > 0 ) ) return false;
	try { process.kill( pid, 0 ); return true; } catch ( error ) { return error.code === 'EPERM'; }

}

const readJson = ( file ) => {

	try { return JSON.parse( readFileSync( file, 'utf8' ) ); } catch { return null; }

};

// takes slot n's lock, or returns false when another live process holds it
function tryTake( lock ) {

	try {

		mkdirSync( lock );

	} catch ( error ) {

		if ( error.code !== 'EEXIST' ) throw error;
		const owner = readJson( path.join( lock, 'owner.json' ) );
		// (a lock without its owner file yet is being taken; after 10 s it was abandoned)
		let age = 0;
		try { age = Date.now() - statSync( lock ).mtimeMs; } catch { return false; }
		if ( owner ? alive( owner.pid ) : age < 10000 ) return false;
		// stale: move it aside, then check it is still the one judged stale (two processes may both
		// find it stale, and the slower must not delete the faster one's fresh lock)
		const aside = `${ lock }.stale-${ process.pid }-${ Date.now() }`;
		try { renameSync( lock, aside ); } catch { return false; }
		const moved = readJson( path.join( aside, 'owner.json' ) );
		if ( moved && moved.pid !== owner?.pid && alive( moved.pid ) ) {

			try { renameSync( aside, lock ); } catch { /* its place was taken meanwhile */ }
			return false;

		}
		rmSync( aside, { recursive: true, force: true } );
		return tryTake( lock );

	}
	writeFileSync( path.join( lock, 'owner.json' ), JSON.stringify( { pid: process.pid, label: path.basename( process.argv[ 1 ] ?? 'node' ), start: new Date().toISOString() } ) );
	return true;

}

let held = null;
function release() {

	if ( held ) rmSync( held, { recursive: true, force: true } );
	held = null;

}
let installed = false;
function installRelease() {

	if ( installed ) return;
	installed = true;
	process.on( 'exit', release );
	for ( const [ signal, code ] of [ [ 'SIGINT', 130 ], [ 'SIGTERM', 143 ], [ 'SIGHUP', 129 ] ] ) {

		process.on( signal, () => { release(); process.exit( code ); } );

	}

}

/** Launches the capture browser in the lowest free profile slot, with one page of the given
 * viewport and device scale factor. Returns { context, page, version, slot, profile, close }:
 * `version` as Playwright's browser.version() reports it (the parity tools compare it between
 * sets), `close()` closes the browser and frees the slot. */
export async function launchCapture( { viewport, deviceScaleFactor = 1 } ) {

	const dir = path.join( profileRoot(), browserBuild() );
	mkdirSync( dir, { recursive: true } );
	installRelease();
	let slot = 0;
	while ( ! tryTake( path.join( dir, `${ slot }.lock` ) ) ) slot ++;
	held = path.join( dir, `${ slot }.lock` );
	const profile = path.join( dir, String( slot ) );
	let context;
	try {

		// Playwright's full Chromium (`npx playwright install chromium`; the headless shell may lack
		// WebGPU), or another build through CHROME_PATH; no vsync, so frame times measure the GPU
		context = await chromium.launchPersistentContext( profile, {
			headless: true,
			...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
			args: LAUNCH_ARGS, viewport, deviceScaleFactor,
		} );

	} catch ( error ) {

		release();
		throw error;

	}
	await context.addInitScript( () => {

		if ( window !== window.top ) return;
		try { localStorage.clear(); sessionStorage.clear(); } catch { /* storage unavailable */ }

	} );
	const page = context.pages()[ 0 ] ?? await context.newPage();
	// (a persistent context has no Browser object to ask: the same string through the protocol)
	const cdp = await context.newCDPSession( page );
	const { product } = await cdp.send( 'Browser.getVersion' );
	await cdp.detach();
	const version = product.slice( product.indexOf( '/' ) + 1 );
	return {
		context, page, version, slot, profile,
		async close() {

			try { await context.close(); } finally { release(); }

		},
	};

}

/** Waits until the page is ready to capture after the evals: `frames` frames rendered since this
 * call and the loading screen gone, with the optional fixed delays `wait` (before) and `settle`
 * (after), in ms. Call it right after the evals. */
export async function waitForScene( page, { frames = READY_FRAMES, wait = 0, settle = 0, timeout = 60000 } = {} ) {

	const from = await page.evaluate( () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 );
	if ( wait > 0 ) await page.waitForTimeout( wait );
	await page.waitForFunction( ( f ) => ( window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0 ) >= f &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ), from + frames, { timeout, polling: 'raf' } );
	if ( settle > 0 ) await page.waitForTimeout( settle );

}

/** Stops the page's frame loop and waits for the GPU queue to drain (see the header); false when
 * the build has no `loop`. */
export function stopLoop( page ) {

	return page.evaluate( async () => {

		const loop = window.__PONLAI__?.loop;
		if ( ! loop ) return false;
		await loop.stop();
		return true;

	} );

}

/** Starts the frame loop again after stopLoop. */
export function startLoop( page ) {

	return page.evaluate( () => window.__PONLAI__?.loop?.start() );

}
