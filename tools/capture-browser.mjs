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
// Readiness by stability. A paused page is ready when its image stops changing, however many
// frames that takes: after the evals, `min` frames (10) and the loading screen gone (waitForScene),
// the capture stops the loop, grabs the image, and then repeatedly runs `every` frames (2), stops
// and grabs again (waitForStable). It shoots once `repeats` comparisons (2) in a row found the image
// unchanged, on the frame grabbed last ("exact"). A paused page still differs from frame to frame
// on a few views (single frames that leave the settled image and come back to it, from a few
// pixels to 0.9 M; task D3 looks for the source), so after `patience` frames (40) a comparison
// within the tolerance also counts ("tolerance": at most 5000 pixels differ at all); a page still
// changing after `cap` frames (120) is shot anyway and marked "capped". The capture's JSON keeps
// the record (`ready`: status, frames waited, comparisons, the largest difference seen, per
// comparison its pixel counts).
// - Change is any pixel by default because the frame noise never repeats: two equal grabs are the
//   settled image, the frame most loads agree on. The tolerance counts pixels that differ at all,
//   not levels: a settling flowers-close differed by 1 level over 5.1 M pixels. The smallest
//   settling step seen was 45 k pixels, the noise between consecutive frames 1 pixel to 0.9 M, so
//   5000 accepts much of the noise and no settling step.
// - Measured: traces of the 24 parity views, two loads
//   each, every frame grabbed for 150 frames, showed every page on its settled image within 1-11
//   frames and changing afterwards only by the single-frame noise. On the GPU, two sets of the 24
//   views with --repeat (96 loads) were all shot exact, 4-32 frames after the floor (median 4,
//   about 1.4 s of grabbing), every one on the frame most loads of the earlier tools agreed on: no
//   A/A difference, where the fixed waits left 15-17 % of loads off it.
// - The grab is the compositor's image through CDP (`Page.captureScreenshot`, PNG optimised for
//   speed, at the page's pixel ratio): about 0.27 s at 3456x2234, its pixels equal to Playwright's
//   screenshot's (which spends 1.3 s on its PNG), and taking it does not change the next shot.
//   Equal PNG bytes are equal pixels; only a changed frame is decoded (about 0.12 s). Reading the
//   canvas in the page (drawImage) gives a blank image once the frame is presented: WebGPU drops
//   its drawing buffer.
// - Stopping the loop for each grab also waits for a sky bake in flight and drains the GPU queue,
//   so work landing late on a busy GPU is in the next grab rather than frames later.
// - A paused page of the temporal modes (taa, taau, gt) shows its rest image, so its comparisons
//   are between converged rests: the loop's start restarts the rest, so each grab waits for it to
//   converge again (about 40 frames for taa and taau). Two rests of a settled page are often equal
//   and otherwise differ by a few pixels (3 views, 2 loads each: 0-52 pixels, once 37 k), so the
//   tolerance counts at once and the cap is 400 frames, about 10 rests (STABLE_TEMPORAL), a
//   temporal capture's stability taking 3-13 s. capture.mjs waits for the first rest itself (after
//   restarting it for the evals); otherwise the first grab waits for one.
// - A running (not paused) capture, or one given --ready-frames n, waits for that fixed count of
//   rendered frames instead (READY_FRAMES, 60, for a running one). `wait` and `settle` (ms) add
//   fixed delays before and after the floor. Later the page's own settled signal joins the stable
//   image.
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
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

/** The rendered frames a running capture, or one given --ready-frames, waits for after the evals. */
export const READY_FRAMES = 60;

/** Readiness by stability's defaults (see the header): the floor before the first grab, frames
 * between grabs, comparisons in a row, the tolerance ({ level, pixels } or null), the frames before
 * the tolerance is accepted, the cap. */
export const STABLE = { min: 10, every: 2, repeats: 2, tolerance: { level: 0, pixels: 5000 }, patience: 40, cap: 120 };
/** A temporal page's own patience and cap (each comparison also waits for its rest to converge
 * again, about 40 frames for taa/taau): its rests are never byte-repeatable, so the tolerance
 * counts at once, and the cap allows about 10 rests. */
export const STABLE_TEMPORAL = { patience: 0, cap: 400 };

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

/** Parses `--stable-tolerance`: `exact` (or `0`) for none, else `<level>:<pixels>`. */
export function parseTolerance( text ) {

	if ( text === undefined ) return STABLE.tolerance;
	if ( text === 'exact' || text === '0' ) return null;
	const m = /^(\d+):(\d+)$/.exec( text );
	if ( ! m ) throw new Error( `bad --stable-tolerance ${ text } (exact, or <level>:<pixels>)` );
	return { level: Number( m[ 1 ] ), pixels: Number( m[ 2 ] ) };

}

/** The stability options of capture.mjs and capture-clip.mjs, from their parsed options (`opt( k )`
 * returns the option's text or undefined). */
export function stableOptions( opt ) {

	const num = ( k, d ) => {

		const t = opt( k );
		if ( t === undefined ) return d;
		const v = Number( t );
		if ( ! Number.isInteger( v ) || v < 0 ) throw new Error( `bad --${ k } ${ t }` );
		return v;

	};
	return {
		min: num( 'stable-min', STABLE.min ), every: Math.max( 1, num( 'stable-every', STABLE.every ) ), repeats: Math.max( 1, num( 'stable-repeats', STABLE.repeats ) ),
		// (patience and cap left undefined when not given: a temporal page has its own defaults)
		tolerance: parseTolerance( opt( 'stable-tolerance' ) ), patience: num( 'stable-patience', undefined ), cap: num( 'stable-cap', undefined ),
		trace: opt( 'stable-trace' ) !== undefined,
	};

}

// ------------------------------------------------------------------ PNG decoding (8-bit RGB or RGBA,
// non-interlaced: what Chrome's screenshots are)

/** Decodes a PNG into { width, height, data } with `data` RGB, 3 bytes per pixel. */
export function decodePng( buffer ) {

	let pos = 8, width = 0, height = 0, colorType = 0, depth = 0;
	const idat = [];
	while ( pos < buffer.length ) {

		const length = buffer.readUInt32BE( pos ), type = buffer.toString( 'latin1', pos + 4, pos + 8 );
		const data = buffer.subarray( pos + 8, pos + 8 + length );
		if ( type === 'IHDR' ) {

			width = data.readUInt32BE( 0 ); height = data.readUInt32BE( 4 ); depth = data[ 8 ]; colorType = data[ 9 ];
			if ( depth !== 8 || data[ 12 ] !== 0 || ( colorType !== 2 && colorType !== 6 ) ) throw new Error( `unsupported PNG (depth ${ depth }, colour type ${ colorType }, interlace ${ data[ 12 ] })` );

		} else if ( type === 'IDAT' ) idat.push( data );
		else if ( type === 'IEND' ) break;
		pos += 12 + length;

	}
	const channels = colorType === 6 ? 4 : 3, stride = width * channels;
	const raw = zlib.inflateSync( Buffer.concat( idat ) );
	const out = new Uint8Array( width * height * 3 );
	const prev = new Uint8Array( stride ), line = new Uint8Array( stride );
	for ( let y = 0; y < height; y ++ ) {

		const filter = raw[ y * ( stride + 1 ) ], src = raw.subarray( y * ( stride + 1 ) + 1, ( y + 1 ) * ( stride + 1 ) );
		for ( let x = 0; x < stride; x ++ ) {

			const a = x >= channels ? line[ x - channels ] : 0, b = prev[ x ], c = x >= channels ? prev[ x - channels ] : 0;
			let v = src[ x ];
			if ( filter === 1 ) v += a;
			else if ( filter === 2 ) v += b;
			else if ( filter === 3 ) v += ( a + b ) >> 1;
			else if ( filter === 4 ) { const p = a + b - c, pa = Math.abs( p - a ), pb = Math.abs( p - b ), pc = Math.abs( p - c ); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
			line[ x ] = v & 255;

		}
		for ( let x = 0, o = y * width * 3; x < width; x ++ ) for ( let k = 0; k < 3; k ++ ) out[ o ++ ] = line[ x * channels + k ];
		prev.set( line );

	}
	return { width, height, data: out };

}

// the steps of a comparison's histogram: pixels whose largest channel difference exceeds each
const STEPS = [ 0, 1, 2, 4, 8, 16, 32 ];

/** Compares two decoded frames: the largest channel difference, the pixels above each of STEPS'
 * levels, and the pixels above `level`. */
export function compareFrames( a, b, level = 0 ) {

	if ( a.width !== b.width || a.height !== b.height ) return { max: 255, over: STEPS.map( () => a.width * a.height ), overLevel: a.width * a.height };
	const x = a.data, y = b.data, over = new Array( STEPS.length ).fill( 0 );
	let max = 0, overLevel = 0;
	for ( let i = 0; i < x.length; i += 3 ) {

		const d = Math.max( Math.abs( x[ i ] - y[ i ] ), Math.abs( x[ i + 1 ] - y[ i + 1 ] ), Math.abs( x[ i + 2 ] - y[ i + 2 ] ) );
		if ( d === 0 ) continue;
		if ( d > max ) max = d;
		if ( d > level ) overLevel ++;
		for ( let j = 0; j < STEPS.length && d > STEPS[ j ]; j ++ ) over[ j ] ++;

	}
	return { max, over, overLevel };

}

/** Waits until the rendered image stops changing (see Readiness by stability above) and returns
 * the record a capture's JSON keeps; the loop is stopped on return, on the frame compared last.
 * Call it once the page is up (waitForScene with the floor's frames) and, in the temporal modes,
 * once its rest has converged. */
export async function waitForStable( page, { every = STABLE.every, repeats = STABLE.repeats, tolerance = STABLE.tolerance, patience, cap,
	trace = false, timeout = 60000 } = {} ) {

	// a paused page of the temporal modes shows its rest image: compare converged rests
	const temporal = await page.evaluate( () => {

		const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
		return !! ( t && t.restTarget > 0 && window.__PONLAI__.taa );

	} );
	patience ??= temporal ? STABLE_TEMPORAL.patience : STABLE.patience;
	cap ??= temporal ? STABLE_TEMPORAL.cap : STABLE.cap;
	const cdp = await page.context().newCDPSession( page );
	// the viewport at the device's pixel ratio, as Playwright's own screenshot asks for it
	// (a CDP session of its own has no device metrics override: its scale 1 is CSS pixels, so the
	// clip's scale is the page's ratio; the pixels then equal Playwright's screenshot's)
	const { width, height } = page.viewportSize();
	const clip = { x: 0, y: 0, width, height, scale: await page.evaluate( () => devicePixelRatio ) };
	const ms = { cycle: 0, grab: 0, decode: 0, compare: 0 };
	let decodes = 0;
	// the page's current image as the compositor shows it (the loop is stopped: the frame a screenshot
	// takes next), PNG encoded for speed; equal bytes are equal pixels, so only a frame that changed
	// is decoded
	const grab = async () => {

		const t = performance.now();
		const { data } = await cdp.send( 'Page.captureScreenshot', { format: 'png', optimizeForSpeed: true, clip, captureBeyondViewport: false } );
		ms.grab += performance.now() - t;
		return { png: Buffer.from( data, 'base64' ), pixels: null };

	};
	const pixels = ( shot ) => {

		if ( ! shot.pixels ) {

			const t = performance.now();
			shot.pixels = decodePng( shot.png );
			ms.decode += performance.now() - t;
			decodes ++;

		}
		return shot.pixels;

	};
	// the loop runs `every` frames (and, for a temporal page, until its rest has converged again: the
	// loop's start restarts it), then stops with the GPU queue drained; returns the frame count
	const advance = ( every ) => page.evaluate( async ( { every, temporal, timeout } ) => {

		const s = window.__PONLAI__, frameNow = () => s.renderer.info.frame;
		const converged = () => {

			const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
			return ! t || t.restTarget === 0 || ( t.converged && t.restEpoch === s.taa.epoch.value );

		};
		const target = frameNow() + every, deadline = performance.now() + timeout;
		s.loop.start();
		await new Promise( ( resolve, reject ) => {

			const tick = () => {

				if ( frameNow() >= target && ( ! temporal || converged() ) ) resolve();
				else if ( performance.now() > deadline ) reject( new Error( `waitForStable: no frame ${ target }${ temporal ? ' and converged rest' : '' } within ${ timeout } ms (at ${ frameNow() })` ) );
				else requestAnimationFrame( tick );

			};
			tick();

		} );
		await s.loop.stop();
		return frameNow();

	}, { every, temporal, timeout } );
	try {

		const start = performance.now();
		// (a temporal page's first grab is a converged rest too, whether or not the caller waited for one)
		const first = await page.evaluate( async ( temporal ) => {

			const s = window.__PONLAI__, t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
			if ( temporal && ! ( t.converged && t.restEpoch === s.taa.epoch.value ) ) return null;
			await s.loop.stop();
			return s.renderer.info.frame;

		}, temporal ) ?? await advance( 0 );
		let previous = await grab();
		const history = [];
		let inExact = 0, inTolerance = 0, status = null, maxSeen = 0, waited = 0;
		while ( status === null ) {

			let t = performance.now();
			waited = ( await advance( every ) ) - first;
			ms.cycle += performance.now() - t;
			const current = await grab();
			let c = { max: 0, over: STEPS.map( () => 0 ), overLevel: 0 };
			if ( ! current.png.equals( previous.png ) ) {

				const a = pixels( previous ), b = pixels( current );
				t = performance.now();
				c = compareFrames( a, b, tolerance ? tolerance.level : 0 );
				ms.compare += performance.now() - t;

			}
			previous.pixels = null;
			previous = current;
			history.push( [ waited, c.max, ...c.over, ...( trace ? [ createHash( 'sha1' ).update( current.png ).digest( 'hex' ).slice( 0, 8 ) ] : [] ) ] );
			maxSeen = Math.max( maxSeen, c.max );
			const exact = c.max === 0, within = tolerance !== null && c.overLevel <= tolerance.pixels;
			inExact = exact ? inExact + 1 : 0;
			inTolerance = exact || within ? inTolerance + 1 : 0;
			if ( inExact >= repeats ) status = 'exact';
			else if ( inTolerance >= repeats && waited >= patience ) status = 'tolerance';
			else if ( waited >= cap ) status = 'capped';
			else if ( performance.now() - start > timeout ) throw new Error( `waitForStable: not stable within ${ timeout } ms (${ waited } frames)` );

		}
		const n = history.length;
		return {
			rule: 'stable', status, every, repeats, tolerance, patience, cap, temporal,
			framesWaited: waited, comparisons: n, maxSeen, wallMs: Math.round( performance.now() - start ),
			ms: { cycle: + ( ms.cycle / n ).toFixed( 1 ), grab: + ( ms.grab / ( n + 1 ) ).toFixed( 1 ), decode: decodes ? + ( ms.decode / decodes ).toFixed( 1 ) : 0, compare: + ( ms.compare / n ).toFixed( 1 ) },
			// per comparison: [ frames waited, largest channel difference, pixels differing by more than 0, 1, 2, 4, 8, 16, 32 levels
			// (, with `trace`, the grab's PNG hash) ]
			history,
		};

	} finally {

		await cdp.detach().catch( () => {} );

	}

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
