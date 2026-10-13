// Regression probe for the exact scene jump (src/main.ts `establishScene`): a parity view reached by
// a jump within one page must be the frame a fresh load of its query draws. It captures the views
// both ways, in the layout of tools/parity/capture-set.mjs, so tools/parity/diff-set.py judges them:
//
//   node tools/verify-scene-jump.mjs <baseUrl> <outDir> [--fresh | --legacy] [--views parity|taa|all|a,b,c]
//       [--order list|reverse] [--from <view or query>]... [--between <view or query>]...
//       [--suffix .repeat] [--quality high]
//       [--aa mode] [--q "extra&query"] [--size 1728x1117@2] [--frames 40] [--profile dir]
//       [--timeout 240000]
//
// --fresh: one fresh page load per view (a new page in the same browser), as capture-set loads it.
// Otherwise one page for the whole list: it loads the first scene (the first `--from`, else the
// first view), then visits each `--from` scene in turn without capturing it (a view's name, or a
// query of its own such as "weather=storm&preset=noon&t=5"), then each view in `--order`, each one
// after the `--between` scenes if any (so every view is reached from them): the jump
// `await __PONLAI__.establishScene( query )` (the view's full query: the common part and its own),
// a frame rendered at the jump's camera, the view's eval, readiness, the shot.
// --legacy jumps the way builds before the exact jump could: establishScene's options (weather,
// preset or hour, time) and the camera reset to the island view (capture-tooling plan 3.2).
// Readiness is capture fast mode as it stood at the jump's commit: `--frames` rendered frames after
// the evals and the loading screen gone (its fade finished), a temporal page's rest restarted
// and converged, then the loop stopped (its last frame on the canvas) before the screenshot; the
// next jump starts it again. A persistent browser profile (`--profile`, one browser at a time)
// keeps the world cache and the shader cache across runs. Where tools/capture-browser.mjs exists
// (readiness by stability, profile slots), the jump's proof shot both sides with it instead; this
// probe should move onto it with the capture tools' one page per set.
// Writes `<outDir>/<view><suffix>.png` and `.json` (the page's diagnostics, the crop anchors, the
// scene it was reached from). Compare two sets with diff-set.py: the fresh set taken twice
// (`--suffix .repeat`) as the reference, and a jump set in two orders (list, then reverse with
// `--suffix .repeat`) as the test, `--aa-floor` for MSAA, `--temporal` for taa and taau.
// The page renders paused, so the GPU lock is taken shared.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { acquireGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { VIEWS, viewNames, viewEval } from './parity/views.mjs';

const argv = process.argv.slice( 2 );
const flags = new Set( [ 'fresh', 'legacy' ] );
const options = {}, positional = [], from = [], between = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( ! argv[ i ].startsWith( '--' ) ) { positional.push( argv[ i ] ); continue; }
	const k = argv[ i ].slice( 2 );
	if ( flags.has( k ) ) options[ k ] = true;
	else if ( k === 'from' ) from.push( argv[ ++ i ] );
	else if ( k === 'between' ) between.push( argv[ ++ i ] );
	else options[ k ] = argv[ ++ i ];

}
const known = [ 'fresh', 'legacy', 'views', 'order', 'suffix', 'quality', 'aa', 'q', 'size', 'frames', 'profile', 'timeout' ];
const unknown = Object.keys( options ).filter( ( k ) => ! known.includes( k ) );
if ( positional.length !== 2 || unknown.length ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : 'usage: verify-scene-jump.mjs <baseUrl> <outDir> [options] (see the file header)' );
	process.exit( 2 );

}
let [ base, outDir ] = positional;
if ( ! base.endsWith( '/' ) && ! base.includes( '?' ) ) base += '/';
outDir = path.resolve( outDir );
const views = ( () => {

	const v = options.views ?? 'all';
	if ( [ 'parity', 'taa', 'all' ].includes( v ) ) return viewNames( v );
	const list = v.split( ',' ).filter( Boolean );
	const bad = list.filter( ( name ) => ! VIEWS[ name ] );
	if ( bad.length ) { console.error( `unknown view ${ bad.join( ', ' ) }` ); process.exit( 2 ); }
	return list;

} )();
if ( options.order === 'reverse' ) views.reverse();
const size = ( options.size ?? '1728x1117@2' ).match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
if ( ! size ) { console.error( `bad --size ${ options.size }` ); process.exit( 2 ); }
const [ , W, H, scale = '1' ] = size.map( ( s, i ) => i ? Number( s ) : s );
let common = `debug&paused&t=12&quality=${ options.quality ?? 'high' }`;
if ( options.aa ) common += `&aa=${ options.aa }`;
if ( options.q ) common += `&${ options.q }`;
const suffix = options.suffix ?? '';
const frames = Number( options.frames ?? 40 );
const timeout = Number( options.timeout ?? 240000 );
const profile = path.resolve( options.profile ?? 'artifacts/.capture-profiles/scene-jump' );
// a view's scene: its full query and eval; a raw query (a `--from` scene) has no eval
// (whose options replace the common ones: the page reads the first of a repeated option)
const merged = ( q ) => { const p = new URLSearchParams( common ); for ( const [ k, value ] of new URLSearchParams( q ) ) p.set( k, value ); return p.toString(); };
const scene = ( v ) => VIEWS[ v ] ? { name: v, q: `${ common }&${ VIEWS[ v ].q }`, eval: viewEval( v ) } : { name: v, q: merged( v ), eval: null };

await mkdir( outDir, { recursive: true } );
await mkdir( profile, { recursive: true } );
await acquireGpuLock( `verify-scene-jump ${ path.basename( outDir ) }`, { shared: true } );
const context = await chromium.launchPersistentContext( profile, {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
	viewport: { width: W, height: H }, deviceScaleFactor: scale,
} );
const browser = context.browser()?.version() ?? null;
let failed = 0;
const started = Date.now();

async function open( q ) {

	const page = await context.newPage();
	const errors = [];
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( 'error: ' + m.text() ); } );
	page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
	await page.goto( `${ base }?${ q }` );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
	return { page, errors };

}

// the view's evals run, then `frames` rendered frames, the rest (temporal), the loop stopped
async function settle( page, js ) {

	if ( js ) await page.evaluate( js );
	const evalFrame = await page.evaluate( () => window.__PONLAI__.renderer.info.frame );
	// the loading screen gone: its computed opacity 0 (its `done` class only starts a 1 s fade, and a
	// shot during the fade carries the screen over the frame)
	await page.waitForFunction( ( f ) => {

		const loading = document.getElementById( 'loading' );
		return window.__PONLAI__.renderer.info.frame >= f && ( ! loading || getComputedStyle( loading ).opacity === '0' );

	}, evalFrame + frames, { timeout, polling: 'raf' } );
	await page.evaluate( () => window.__PONLAI__.taa?.epoch.bump( 'capture' ) );
	await page.waitForFunction( () => {

		const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
		return ! t || t.restTarget === 0 || ( t.converged && t.restEpoch === window.__PONLAI__.taa.epoch.value );

	}, null, { timeout, polling: 100 } );
	await page.evaluate( () => window.__PONLAI__.loop.stop() );

}

async function shoot( page, view, extra ) {

	const file = path.join( outDir, `${ view }${ suffix }.png` );
	await page.screenshot( { path: file, timeout } );
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const crops = await page.evaluate( () => window.__PONLAI_CROPS__ ?? null );
	await writeFile( path.join( outDir, `${ view }${ suffix }.json` ), JSON.stringify( { browser, viewport: { width: W, height: H }, ...extra, diag, ...( crops ? { crops } : {} ) }, null, 1 ) );

}

try {

	if ( options.fresh ) {

		for ( const v of views ) {

			const s = scene( v );
			const t0 = Date.now();
			const { page, errors } = await open( s.q );
			try {

				await settle( page, s.eval );
				await shoot( page, v, { mode: 'fresh', query: s.q, errors } );
				console.log( `${ v }${ suffix } fresh ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s${ errors.length ? ' ERRORS ' + errors.slice( 0, 3 ).join( ' | ' ) : '' }` );
				if ( errors.length ) failed ++;

			} finally {

				await page.close();

			}

		}

	} else {

		const visits = [ ...from.map( ( v ) => ( { v, capture: false } ) ),
			...views.flatMap( ( v ) => [ ...between.map( ( b ) => ( { v: b, capture: false } ) ), { v, capture: true } ] ) ];
		const t0 = Date.now();
		const { page, errors } = await open( scene( visits[ 0 ].v ).q );
		console.log( `loaded ${ visits[ 0 ].v } in ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );
		let previous = null;
		for ( let i = 0; i < visits.length; i ++ ) {

			const { v, capture } = visits[ i ];
			const s = scene( v );
			const t1 = Date.now();
			if ( i > 0 ) {

				const jumped = await page.evaluate( async ( { q, legacy } ) => {

					const p = window.__PONLAI__;
					if ( legacy ) {

						const o = new URLSearchParams( q );
						await p.establishScene( { weather: o.get( 'weather' ) ?? undefined, preset: o.get( 'preset' ) ?? undefined,
							hour: o.has( 'hour' ) ? Number( o.get( 'hour' ) ) : undefined, time: Number( o.get( 't' ) ?? 0 ) } );
						p.setCameraMode( 'orbit' );
						p.setCameraView( 'island' );

					} else await p.establishScene( q );
					p.loop.start();
					return p.renderer.info.frame;

				}, { q: s.q, legacy: options.legacy === true } );
				// a frame at the jump's camera before the eval moves it, as a fresh load renders its
				// first frames before a capture's eval runs (main.ts `establishScene`)
				await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout, polling: 'raf' } );

			}
			await settle( page, s.eval );
			if ( capture ) await shoot( page, v, { mode: i > 0 ? 'jump' : 'load', query: s.q, from: previous, errors: errors.splice( 0 ) } );
			console.log( `${ v }${ capture ? suffix : ' (not captured)' } ${ i > 0 ? `jump from ${ previous }` : 'load' } ${ ( ( Date.now() - t1 ) / 1000 ).toFixed( 1 ) } s` );
			previous = v;

		}
		if ( errors.length ) { console.log( 'page errors: ' + errors.slice( 0, 6 ).join( ' | ' ) ); failed ++; }
		await page.close();

	}

} finally {

	await context.close();
	releaseGpuLock();

}
console.log( `${ views.length } views in ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) } s${ failed ? `, ${ failed } with page errors` : '' }` );
if ( failed ) process.exitCode = 1;
