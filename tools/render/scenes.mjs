// Shoots, reads and checks the render pipeline's test scenes as paused pages in the test mode.
//
// A test scene (scenes.html, app/scenes/; docs/reference/url-options.md, The test scenes) is a few
// objects on level ground under the sky or in the open sea, built from the render pipeline alone,
// so it loads in a second or two and a whole scene is shot in a minute or two. Run it first after a
// change to the render pipeline, before the island is loaded at all: `--check` against the
// reference answers whether anything moved, and the readings give the scene's radiance, exposure
// and light.
//
// Usage:
//   node tools/render/scenes.mjs <baseUrl> <outDir> [--scenes ball,sea] [--times a,b] [--views a,b]
//       [--look neutral|ponlai] [--verify] [--rebuild n] [--write-ref | --check] [--ref <dir>]
//       [--q "extra&query"] [--size 1920x1080@2] [--timeout 240000]
//   node tools/render/scenes.mjs http://127.0.0.1:5190/ artifacts/scenes/run --check
//
// Options:
//   baseUrl       the server (the dev server or a production preview) outDir        the output
//   folder; the look's folder is made in it --scenes a,b  the scenes to shoot (default
//   ball,empty,plants) --times a,b   only these of each scene's times (default every one) --views
//   a,b   only these of each scene's views (default every one) --look l      neutral (the render
//   pipeline's neutral look, the default) or ponlai (the island's look) --verify      takes every
//   shot three ways, which must agree to the pixel --rebuild n   on each scene's page, disposes the
//   scene and starts it again n times, then takes
//                 every shot again, which must equal the first to the pixel
//   --check       compares every shot with the reference image of its name
//   --write-ref   writes the run's shots as the reference (with --verify, only when it passed)
//   --ref dir     the reference folder (default artifacts/scenes/reference/<look>/, git-ignored)
//   --q query     extra URL options for every page
//   --size WxH@s  the viewport in CSS pixels and its pixel ratio (default 1920x1080@2)
//   --timeout ms  each wait's limit (default 240000)
//
// For each scene it opens one page, and for each of the scene's times and views jumps to the time
// (`__PONLAI__.establishScene`, the first by the load itself), renders a frame at the jump's
// camera, moves to the view (`scenePage.setView`), waits until the page is ready and shoots it.
// The scenes, their views, times and readings are the page's own (`__PONLAI__.scenePage`): this
// tool names none. `--scenes`, `--times` and `--views` take the named ones only (a name no scene
// has is an error).
//
// The scenes it shoots without `--scenes` are those whose shots repeat to the pixel: `ball`,
// `empty` and `plants`. `sea` is shot only when `--scenes` names it, and is read by its readings:
// its shots differ between two loads by a level or so in scattered pixels over the water, so they
// are not compared with a reference and `--verify` does not hold for it. Named, it takes every
// option as the others do.
//
// Guarantees:
// - A shot is a paused page in the test mode (`debug&paused&t=12&quality=high`;
//   docs/reference/test-mode.md), taken once the page's settled signal holds and its image has
//   stopped changing (tools/kit/capture-browser.mjs, "Readiness by stability"), with the loop
//   stopped. A shot still changing at the cap fails the run.
// - Images are compared by their decoded pixels, exactly: no tolerance anywhere.
// - `--verify`: every shot is taken on one page in the listed order, on a second page in the
//   reverse order (so each shot is taken twice, each time after another scene before it), and on a
//   fresh page loaded at that time. So a shot repeats, and a jump to a time draws what a load of
//   that time draws.
// - `--rebuild n`: after the first page's shots, the page disposes its scene and starts a new one
//   n times (`__PONLAI__.rebuild()`: packages/render/assemble/StartScene.ts `dispose`,
//   packages/render/SceneDispose.ts), then every shot is taken again in the same order. Each must
//   equal the first to the pixel, with the same draw calls, triangles, geometries and textures in
//   the diagnostics (not the compute calls, which a bake in the frame shot adds to): so a scene
//   started after another's dispose draws as the page's first did, and the disposed one left
//   nothing drawing.
// - `--check`: a shot without a reference fails. `--write-ref` writes a `reference.json` in each
//   scene's folder (the commit served, the browser and the size), so a run that writes some scenes
//   leaves the others' records as they were. A reference holds for the browser and the size it was
//   shot with.
// - `--look ponlai` loads the scenes with `renderLook=ponlai`; each look has its own output folder
//   and reference.
//
// Readings: with the loop stopped on the shot's frame, `scenePage.read()` gives each reading the
// view's frame holds: its box, the scene's linear radiance there before the display chain
// (`opaque`: before the air; `hdr`: after the composite), the exposure and the light (the key's
// direction, colour and elevation, the sky's irradiance); this tool adds `code`, the mean of the
// shot's pixels over the box as fractions of 255 (the display's code values).
//
// Output, under <outDir>/<look>/:
//   <scene>/<time>.<view>.png, .json     the shot, and its readiness record, diagnostics and readings
//   readings.json                        every reading of the run: scene, time, view, light, readings
//   readings.tsv                         the same as a table: luminance (opaque, hdr) and code per reading
//   verify/<scene>/<time>.<view>.<reverse|fresh>.png   a shot of `--verify` that differs from the first
// stdout: a line per shot, the failures, a summary.
//
// GPU lock and browser: takes the GPU lock shared and leased from shot to shot
// (docs/reference/gpu-lock.md; tools/kit/gpu-lock.mjs `leaseGpuLock`), since a paused shot's pixels
// do not depend on what else renders. It opens the capture tools' headless browser in a profile
// slot (tools/kit/capture-browser.mjs `launchCapture`).
//
// Cost: a second or two per page load, a minute or two per scene; `--verify` takes every shot three
// times, `--rebuild` twice and n scene starts more.
//
// Exit codes: 0 passed; 1 a check failed (a difference, a missing reference, a shot still
// changing, a page error); 2 bad usage.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { leaseGpuLock, releaseGpuLock } from '../kit/gpu-lock.mjs';
import { launchCapture, waitForScene, waitForSettled, waitForStable, decodePng, compareFrames, samePixels } from '../kit/capture-browser.mjs';
import { renderedFrames } from '../kit/page-eval.mjs';

const argv = process.argv.slice( 2 );
const flags = new Set( [ 'verify', 'write-ref', 'check' ] );
const known = [ ...flags, 'scenes', 'times', 'views', 'look', 'ref', 'q', 'size', 'timeout', 'rebuild' ];
const options = {}, positional = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( ! argv[ i ].startsWith( '--' ) ) { positional.push( argv[ i ] ); continue; }
	const k = argv[ i ].slice( 2 );
	if ( flags.has( k ) ) options[ k ] = true;
	else options[ k ] = argv[ ++ i ];

}
const usage = ( message ) => {

	console.error( `${ message }\nusage: scenes.mjs <baseUrl> <outDir> [options] (see the file header)` );
	process.exit( 2 );

};
const unknown = Object.keys( options ).filter( ( k ) => ! known.includes( k ) );
if ( unknown.length ) usage( `unknown option --${ unknown[ 0 ] }` );
if ( positional.length !== 2 ) usage( 'a base URL and an output folder are needed' );
if ( options[ 'write-ref' ] && options.check ) usage( '--write-ref and --check exclude each other' );
const look = options.look ?? 'neutral';
if ( look !== 'neutral' && look !== 'ponlai' ) usage( `bad --look ${ look } (neutral, ponlai)` );
const size = ( options.size ?? '1920x1080@2' ).match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
if ( ! size ) usage( `bad --size ${ options.size }` );
const [ , W, H, scale = '1' ] = size.map( ( s, i ) => i ? Number( s ) : s );
const timeout = Number( options.timeout ?? 240000 );
const rebuilds = options.rebuild === undefined ? 0 : Number( options.rebuild );
if ( ! Number.isInteger( rebuilds ) || rebuilds < 0 ) usage( `bad --rebuild ${ options.rebuild } (a whole number)` );
let base = positional[ 0 ];
if ( ! base.endsWith( '/' ) ) base += '/';
const outDir = path.join( path.resolve( positional[ 1 ] ), look );
const refDir = path.resolve( options.ref ?? path.join( 'artifacts/scenes/reference', look ) );
const list = ( text ) => text === undefined ? null : text.split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
const wanted = { scenes: list( options.scenes ), times: list( options.times ), views: list( options.views ) };
// the scenes shot where none is named: the page's scenes (the `scene` option's values:
// packages/render/Settings.ts) whose shots repeat to the pixel, so all but `sea`
const DEFAULT_SCENES = [ 'ball', 'empty', 'plants' ];
const sceneNames = wanted.scenes ?? DEFAULT_SCENES;

let common = 'debug&paused&t=12&quality=high';
if ( look === 'ponlai' ) common += '&renderLook=ponlai';
if ( options.q ) common += `&${ options.q }`;
// a time's whole query: the common part, the scene and the time's own options over them
const queryOf = ( scene, time ) => {

	const p = new URLSearchParams( `scene=${ scene }&${ common }` );
	for ( const [ k, value ] of new URLSearchParams( time.query ) ) p.set( k, value );
	return p.toString();

};

// the slot lease from shot to shot (ms), as capture.mjs's worker's
const LEASE = 20000;
let lockWaited = 0;
async function slot( label ) {

	const { waitMs } = await leaseGpuLock( `scenes ${ label }`, { shared: true, budget: LEASE } );
	lockWaited += waitMs;

}

const started = Date.now();
const capture = await launchCapture( { viewport: { width: W, height: H }, deviceScaleFactor: scale, url: base } );
const failures = [];
const fail = ( message ) => { failures.push( message ); console.log( `FAIL ${ message }` ); };

async function open( query ) {

	const page = await capture.context.newPage();
	const errors = [];
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( 'error: ' + m.text() ); } );
	page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
	await page.goto( `${ base }scenes.html?${ query }` );
	await page.waitForFunction( () => window.__PONLAI__?.scenePage && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
	return { page, errors };

}

// Jumps the page to a time: the scene established, the loop running, a frame rendered at the
// jump's camera before a view moves it (as a load renders its first frames: packages/render/assemble/SceneJump.ts).
async function jump( page, query ) {

	await page.evaluate( async ( q ) => {

		const p = window.__PONLAI__;
		await p.establishScene( q );
		p.loop.start();

	}, query );
	await renderedFrames( page, 1, { timeout } );

}

// Moves to a view, waits until the page is ready (the floor's frames and the loading screen gone,
// the settled signal, the image stable with the loop stopped) and shoots it. Returns the PNG, the
// readiness record, the diagnostics and the readings.
async function captureView( page, view ) {

	await page.evaluate( ( v ) => {

		const p = window.__PONLAI__;
		p.loop.start();
		p.scenePage.setView( v );

	}, view );
	await waitForScene( page, { frames: 1, timeout } );
	const settled = await waitForSettled( page, { timeout } );
	const ready = await waitForStable( page, { timeout } );
	ready.settled = settled;
	const read = await page.evaluate( () => window.__PONLAI__.scenePage.read() );
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const png = await page.screenshot( { timeout } );
	return { png, ready, diag, read };

}

// the mean of a decoded image over a box (fractions of the frame from its top-left corner), as
// fractions of 255
function codeOver( image, [ bx, by, bw, bh ] ) {

	const x0 = Math.max( 0, Math.floor( bx * image.width ) ), x1 = Math.min( image.width, Math.ceil( ( bx + bw ) * image.width ) );
	const y0 = Math.max( 0, Math.floor( by * image.height ) ), y1 = Math.min( image.height, Math.ceil( ( by + bh ) * image.height ) );
	const sum = [ 0, 0, 0 ];
	for ( let y = y0; y < y1; y ++ ) for ( let x = x0; x < x1; x ++ ) for ( let c = 0; c < 3; c ++ ) sum[ c ] += image.data[ ( y * image.width + x ) * 3 + c ];
	const n = Math.max( 1, ( x1 - x0 ) * ( y1 - y0 ) ) * 255;
	return sum.map( ( s ) => + ( s / n ).toFixed( 4 ) );

}

// how two shots differ, for a failure's line
function difference( a, b ) {

	const c = compareFrames( decodePng( a ), decodePng( b ) );
	return `${ c.over[ 0 ] } pixels differ, by ${ c.max } levels at most`;

}

const selected = ( names, wantedNames, what, scene ) => {

	if ( ! wantedNames ) return names;
	const kept = names.filter( ( n ) => wantedNames.includes( n ) );
	if ( ! kept.length ) usage( `${ scene } has none of the ${ what } ${ wantedNames.join( ',' ) } (${ names.join( ', ' ) })` );
	return kept;

};

const all = [], shots = new Map(), counts = new Map();
// what the diagnostics count of a shot's frame: the work drawn and the memory held
const countsOf = ( diag ) => JSON.stringify( [ 'calls', 'triangles', 'geometries', 'textures' ].map( ( k ) => [ k, diag[ k ] ] ) );
const verifyDir = path.join( outDir, 'verify' );
let shotCount = 0;
try {

	for ( const scene of sceneNames ) {

		await mkdir( path.join( outDir, scene ), { recursive: true } );
		// ---------------------------------------------------------------- the scene's page: every shot
		await slot( scene );
		let t0 = Date.now();
		// (the page's lists first, from a load at the scene's defaults: the first time's query follows)
		let { page, errors } = await open( queryOf( scene, { query: '' } ) );
		const declared = await page.evaluate( () => { const s = window.__PONLAI__.scenePage; return { about: s.about, views: s.views, times: s.times }; } );
		const times = declared.times.filter( ( t ) => ! wanted.times || wanted.times.includes( t.name ) );
		if ( ! times.length ) usage( `${ scene } has none of the times ${ wanted.times.join( ',' ) } (${ declared.times.map( ( t ) => t.name ).join( ', ' ) })` );
		const views = selected( declared.views, wanted.views, 'views', scene );
		console.log( `${ scene }: ${ declared.about } (${ times.length } times, ${ views.length } views; loaded in ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s)` );
		const order = times.flatMap( ( time ) => views.map( ( view ) => ( { time, view, key: `${ scene }/${ time.name }.${ view }` } ) ) );
		for ( const { time, view, key } of order ) {

			await slot( key );
			t0 = Date.now();
			await jump( page, queryOf( scene, time ) );
			const shot = await captureView( page, view );
			shotCount ++;
			const image = decodePng( shot.png );
			const readings = {};
			for ( const [ name, box ] of Object.entries( shot.read.boxes ) ) readings[ name ] = { box, opaque: shot.read.opaque[ name ], hdr: shot.read.hdr[ name ], code: codeOver( image, box ) };
			const record = { scene, time: time.name, view, query: queryOf( scene, time ), look, light: shot.read.light, exposure: shot.read.exposure, preExposure: shot.read.preExposure, readings };
			all.push( record );
			shots.set( key, shot.png );
			counts.set( key, countsOf( shot.diag ) );
			await writeFile( path.join( outDir, `${ key }.png` ), shot.png );
			await writeFile( path.join( outDir, `${ key }.json` ), JSON.stringify( { browser: capture.version, viewport: { width: W, height: H, scale }, ...record, ready: shot.ready, diag: shot.diag, errors }, null, 1 ) );
			console.log( `${ key } ${ shot.ready.status } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );
			if ( shot.ready.status !== 'exact' ) fail( `${ key }: not still when shot (${ shot.ready.status } after ${ shot.ready.framesWaited } frames, ${ shot.ready.maxSeen } levels)` );

		}
		// ---------------------------------------------------------------- the same page, its scene started again
		if ( rebuilds ) {

			await slot( `${ scene } rebuild` );
			t0 = Date.now();
			for ( let i = 0; i < rebuilds; i ++ ) {

				await page.evaluate( () => window.__PONLAI__.rebuild() );
				await renderedFrames( page, 1, { timeout } );

			}
			console.log( `${ scene }: started ${ rebuilds } times more in ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );
			for ( const { time, view, key } of order ) {

				await slot( `${ key } rebuilt` );
				await jump( page, queryOf( scene, time ) );
				const shot = await captureView( page, view );
				shotCount ++;
				if ( ! samePixels( shots.get( key ), shot.png ) ) {

					await mkdir( path.dirname( path.join( verifyDir, key ) ), { recursive: true } );
					await writeFile( path.join( verifyDir, `${ key }.rebuilt.png` ), shot.png );
					fail( `${ key }: the shot after ${ rebuilds } scene starts differs from the first: ${ difference( shots.get( key ), shot.png ) }` );

				}
				const now = countsOf( shot.diag );
				if ( now !== counts.get( key ) ) fail( `${ key }: the counts after ${ rebuilds } scene starts differ from the first: ${ now } against ${ counts.get( key ) }` );
				console.log( `${ key } rebuilt ${ shot.ready.status }` );

			}

		}
		if ( errors.length ) fail( `${ scene }: page errors: ${ errors.slice( 0, 4 ).join( ' | ' ) }` );
		await page.close();
		if ( ! options.verify ) continue;

		// ---------------------------------------------------------------- a second page, in the reverse order
		const differs = async ( key, png, how ) => {

			if ( samePixels( shots.get( key ), png ) ) return;
			await mkdir( path.dirname( path.join( verifyDir, key ) ), { recursive: true } );
			await writeFile( path.join( verifyDir, `${ key }.${ how }.png` ), png );
			fail( `${ key }: the ${ how === 'reverse' ? 'second capture (reverse order)' : 'fresh load' } differs from the first capture: ${ difference( shots.get( key ), png ) }` );

		};
		const reverse = [ ...order ].reverse();
		await slot( `${ scene } reverse` );
		( { page, errors } = await open( queryOf( scene, reverse[ 0 ].time ) ) );
		for ( const { time, view, key } of reverse ) {

			await slot( `${ key } reverse` );
			t0 = Date.now();
			await jump( page, queryOf( scene, time ) );
			const shot = await captureView( page, view );
			shotCount ++;
			await differs( key, shot.png, 'reverse' );
			console.log( `${ key } reverse ${ shot.ready.status } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );

		}
		if ( errors.length ) fail( `${ scene } (reverse): page errors: ${ errors.slice( 0, 4 ).join( ' | ' ) }` );
		await page.close();

		// ---------------------------------------------------------------- a fresh page per time
		for ( const time of times ) {

			await slot( `${ scene }/${ time.name } fresh` );
			t0 = Date.now();
			( { page, errors } = await open( queryOf( scene, time ) ) );
			await renderedFrames( page, 1, { timeout } );
			for ( const view of views ) {

				const key = `${ scene }/${ time.name }.${ view }`;
				// (the first view by the load alone; the others after a jump to the same time, as on the first page)
				if ( view !== views[ 0 ] ) await jump( page, queryOf( scene, time ) );
				const shot = await captureView( page, view );
				shotCount ++;
				await differs( key, shot.png, 'fresh' );

			}
			if ( errors.length ) fail( `${ scene }/${ time.name } (fresh): page errors: ${ errors.slice( 0, 4 ).join( ' | ' ) }` );
			await page.close();
			console.log( `${ scene }/${ time.name } fresh ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );

		}

	}

} finally {

	await capture.close();
	releaseGpuLock();

}

// ------------------------------------------------------------------ the readings

await writeFile( path.join( outDir, 'readings.json' ), JSON.stringify( { browser: capture.version, viewport: { width: W, height: H, scale }, look, shots: all }, null, 1 ) );
const num = ( x ) => x === undefined || x === null ? '' : Number( x ).toPrecision( 4 );
const rows = [ [ 'scene', 'time', 'view', 'reading', 'Y opaque', 'Y hdr', 'code r', 'code g', 'code b', 'key elevation', 'exposure' ].join( '\t' ) ];
for ( const s of all ) for ( const [ name, r ] of Object.entries( s.readings ) ) rows.push( [ s.scene, s.time, s.view, name, num( r.opaque?.Y ), num( r.hdr?.Y ), ...r.code, num( s.light.keyElevation ), num( s.exposure?.exposure ) ].join( '\t' ) );
await writeFile( path.join( outDir, 'readings.tsv' ), rows.join( '\n' ) + '\n' );

// ------------------------------------------------------------------ the reference

if ( options.check ) {

	let same = 0;
	for ( const [ key, png ] of shots ) {

		let ref;
		try { ref = await readFile( path.join( refDir, `${ key }.png` ) ); } catch { fail( `${ key }: no reference image in ${ refDir }` ); continue; }
		if ( samePixels( ref, png ) ) same ++;
		else fail( `${ key }: differs from its reference: ${ difference( ref, png ) }` );

	}
	console.log( `check: ${ same } of ${ shots.size } shots equal their reference (${ refDir })` );

}
if ( options[ 'write-ref' ] ) {

	if ( failures.length ) console.log( 'the reference is not written: the run failed' );
	else {

		for ( const [ key, png ] of shots ) {

			await mkdir( path.dirname( path.join( refDir, key ) ), { recursive: true } );
			await writeFile( path.join( refDir, `${ key }.png` ), png );

		}
		let sha = null;
		try { sha = execFileSync( 'git', [ 'rev-parse', 'HEAD' ], { encoding: 'utf8' } ).trim(); } catch { /* not a checkout */ }
		let dirty = null;
		try { dirty = execFileSync( 'git', [ 'status', '--porcelain' ], { encoding: 'utf8' } ).trim() !== ''; } catch { /* not a checkout */ }
		for ( const scene of sceneNames ) {

			const keys = [ ...shots.keys() ].filter( ( key ) => key.startsWith( `${ scene }/` ) );
			await writeFile( path.join( refDir, scene, 'reference.json' ), JSON.stringify( { sha, dirty, browser: capture.version, viewport: { width: W, height: H, scale }, look, query: common, shots: keys }, null, 1 ) );

		}
		console.log( `reference: ${ shots.size } shots written to ${ refDir }` );

	}

}

console.log( `${ shots.size } shots (${ shotCount } captures) in ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) } s (${ ( lockWaited / 1000 ).toFixed( 1 ) } s of it waiting for the GPU lock), readings in ${ path.join( outDir, 'readings.tsv' ) }` );
console.log( failures.length ? `scenes FAIL: ${ failures.length } failures` : `scenes PASS${ options.verify ? ' (each shot twice and from a fresh load, to the pixel)' : '' }` );
if ( failures.length ) process.exitCode = 1;
