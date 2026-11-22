// Runs real-browser regression checks of the visual sample on a production preview, with no synthetic gameplay hooks.
//
// It answers "does the built page load, draw, move, pause and take its keys as it should, without
// errors", in a real browser, on `?debug&paused&t=12&dpr=1`. The island camera: a left drag and W
// pan it (the hand moves it by default), the wheel never zooms the island view in past its start
// but zooms out from a nearer start (`dist=50`) to the farthest zoom, and `cameraInput=off` holds
// it; each input step waits for the page's rendered frames.
//
// Usage:
//   node tools/island/verify-scene.mjs [url] [--production]
//
// Options:
//   url            the server (http://127.0.0.1:5190); the intended target is a production preview
//                  (http://127.0.0.1:5191, `npm run preview`)
//   --production   also checks that the page without `debug` exposes no scene handles (assumed when
//                  the url holds 5191)
//
// Output: in artifacts/verification/, overview.png, motion-a.png, motion-b.png, close.png and
// report.json (the checks, the page's inspection, errors and failed requests); stdout, the checks as
// JSON.
//
// GPU lock and browser: it takes the GPU lock itself, shared (docs/reference/gpu-lock.md), and drives
// one headless Chromium page at 1672 x 941 through Playwright; no server (it needs one running).
//
// Cost: a few page loads and the checks' frames.
//
// Exit codes: 0 every check passed; 1 a check failed or the run broke.
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { renderedFrames } from '../kit/page-eval.mjs';
import { reviewUrl } from '../kit/page-query.mjs';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification';
const production = process.argv.includes( '--production' ) || base.includes( '5191' );
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/kit/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-scene', { shared: true } );
const browser = await chromium.launch( {
	headless: true, channel: 'chromium',
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
const errors = [], failures = [], checks = [];
try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 } } );
	page.on( 'pageerror', ( e ) => errors.push( e.message ) );
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	page.on( 'response', ( r ) => { if ( r.status() >= 400 ) failures.push( `${ r.status() } ${ r.url() }` ); } );
	page.on( 'requestfailed', ( r ) => failures.push( r.url() ) );
	await page.goto( reviewUrl( `${ base }/?debug&paused&t=12&dpr=1` ) );
	await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.frame > 150, null, { timeout: 60000 } );
	const inspect = await page.evaluate( () => {
		const s = window.__PONLAI__;
		const bad = [], world = [];
		s.scene.traverse( ( o ) => {
			if ( ! o.isMesh ) return;
			for ( const key of [ 'position', 'normal' ] ) {
				const a = o.geometry.getAttribute( key );
				if ( a && ! a.array.every( Number.isFinite ) ) bad.push( `${ o.name }:${ key }` );
			}
			// the stones and the floor, and the island's parts (a mesh per land chunk, under 'island')
			if ( o.parent?.name === 'world' || o.parent?.name === 'island' ) world.push( { name: o.name, vertices: o.geometry.getAttribute( 'position' ).count, maxY: o.geometry.boundingBox?.max.y, meadowDetail: o.material.userData.meadowDetail } );
		} );
		return { bad, world, diag: window.__THREE_GAME_DIAGNOSTICS__, t: s.shared.time.value };
	} );
	assert.deepEqual( inspect.bad, [] );
	assert.equal( inspect.world.filter( ( m ) => m.name.startsWith( 'stack' ) ).length, 0 );
	const rocks = inspect.world.find( ( m ) => m.name === 'rocks' );
	assert.ok( rocks && rocks.vertices > 0 && rocks.maxY <= - 1.15 );
	assert.equal( rocks.meadowDetail, false );
	const island = inspect.world.filter( ( m ) => m.name.startsWith( 'island ' ) );
	assert.ok( island.length > 0 && island.every( ( m ) => m.meadowDetail === true ) );
	assert.equal( inspect.t, 12 );
	checks.push( 'Finite geometry, no exposed offshore rocks, bare submerged stone, frozen time t=12, WebGPU rendered' );
	await page.screenshot( { path: `${ out }/overview.png` } );
	await page.keyboard.press( 'Space' );
	await page.waitForTimeout( 1200 );
	const motionT = await page.evaluate( () => window.__PONLAI__.shared.time.value );
	assert.ok( motionT > 12.5 );
	await page.screenshot( { path: `${ out }/motion-a.png` } );
	await page.waitForTimeout( 1800 );
	await page.screenshot( { path: `${ out }/motion-b.png` } );
	await page.keyboard.press( 'Space' );
	const stopT = await page.evaluate( () => window.__PONLAI__.shared.time.value );
	await page.waitForTimeout( 400 );
	assert.equal( await page.evaluate( () => window.__PONLAI__.shared.time.value ), stopT );
	checks.push( 'Space resumes water and vegetation, then freezes the shared simulation clock' );
	// The hand moves the island camera by default (IslandCameraControls.ts; `cameraInput=off` holds
	// it). Input is applied on the frames that draw it, so each step waits for rendered frames: after
	// the running page above, the paused page's next frames wait behind the GPU work it queued
	// (FramePacer.ts, "A paused page's queue"), and a fixed wait could see no frame and no motion.
	const drawn = ( n = 20 ) => renderedFrames( page, n );
	const pose = () => page.evaluate( () => {
		const s = window.__PONLAI__, c = s.controls, e = s.camera.matrixWorld.elements;
		return { position: s.camera.position.toArray(), target: c.target.toArray(), distance: s.camera.position.distanceTo( c.target ),
			right: [ e[ 0 ], e[ 1 ], e[ 2 ] ], back: [ e[ 8 ], e[ 9 ], e[ 10 ] ], farthest: c.maxDistance };
	} );
	const moved = ( a, b ) => b.target.map( ( v, i ) => v - a.target[ i ] );
	const dot = ( u, v ) => u[ 0 ] * v[ 0 ] + u[ 1 ] * v[ 1 ] + u[ 2 ] * v[ 2 ];
	// a pan moves the camera and its pivot together: the offset between them (the distance, the
	// heading and the tilt) stays
	const panned = ( a, b ) => a.position.every( ( v, i ) => Math.abs( ( b.position[ i ] - b.target[ i ] ) - ( v - a.target[ i ] ) ) < 1e-3 );
	const still = ( a, b ) => a.position.every( ( v, i ) => Math.abs( v - b.position[ i ] ) < 1e-3 ) && a.target.every( ( v, i ) => Math.abs( v - b.target[ i ] ) < 1e-3 );
	const dragRight = async () => {
		await page.mouse.move( 830, 470 );
		await page.mouse.down();
		await page.mouse.move( 1010, 470, { steps: 25 } );
		await page.mouse.up();
		await drawn();
	};
	const holdW = async () => {
		await page.keyboard.down( 'KeyW' );
		await drawn();
		await page.keyboard.up( 'KeyW' );
		await drawn();
	};
	await drawn();
	const start = await pose();
	await dragRight();
	const dragged = await pose();
	// the grabbed ground follows the cursor to the right, so the view moves left
	assert.ok( panned( start, dragged ) && dot( moved( start, dragged ), start.right ) < - 0.5, `a left drag pans the island camera (moved ${ moved( start, dragged ) })` );
	await holdW();
	const forward = await pose();
	const ahead = [ - start.back[ 0 ], 0, - start.back[ 2 ] ];
	assert.ok( panned( dragged, forward ) && dot( moved( dragged, forward ), ahead ) > 0.5, `W pans the island camera forward (moved ${ moved( dragged, forward ) })` );
	checks.push( 'A real left drag and W pan the island camera, keeping its distance, heading and tilt' );
	// The island view starts where it frames the land and never zooms in past that start
	// (CameraViews.ts `placeOrbit`): the farthest zoom is 70 m, or the start where it stands farther.
	await page.mouse.move( 836, 470 );
	await page.mouse.wheel( 0, - 380 );
	await drawn( 30 );
	const zoomedIn = await pose();
	assert.ok( zoomedIn.distance >= start.distance - 1e-3 && zoomedIn.distance <= forward.distance + 1e-3, `the wheel never zooms the island view in past its start (${ forward.distance } to ${ zoomedIn.distance }, start ${ start.distance })` );
	await page.screenshot( { path: `${ out }/close.png` } );
	checks.push( `The wheel never zooms the island view in past its start (${ start.distance.toFixed( 1 ) } m; farthest ${ start.farthest.toFixed( 1 ) } m)` );
	await page.setViewportSize( { width: 1280, height: 800 } );
	// The diagnostics refresh every 30 frames (main.ts), so a fixed wait reads a stale snapshot
	// whenever fewer frames fit in it: wait for the first snapshot taken after the resize.
	const resizedAt = await page.evaluate( () => window.__THREE_GAME_DIAGNOSTICS__.frame );
	await page.waitForFunction( ( f ) => window.__THREE_GAME_DIAGNOSTICS__.frame > f, resizedAt, { timeout: 30000 } );
	assert.deepEqual( await page.evaluate( () => window.__THREE_GAME_DIAGNOSTICS__.canvas ), [ 1280, 800 ] );
	checks.push( 'Resize updates camera and all render targets to 1280 × 800' );
	await page.keyboard.press( 'h' );
	await page.locator( '.lil-gui.lil-root' ).waitFor( { state: 'visible' } );
	assert.equal( await page.locator( '.lil-gui.lil-root' ).isVisible(), true );
	await page.keyboard.press( 'h' );
	await page.locator( '.lil-gui.lil-root' ).waitFor( { state: 'hidden' } );
	assert.equal( await page.locator( '.lil-gui.lil-root' ).isVisible(), false );
	checks.push( 'H toggles the hidden tuning controls' );
	// From a start nearer than the farthest zoom (`dist`, m) the wheel zooms out, to 70 m at most, and
	// back in no nearer than the start.
	const loadAt = async ( query ) => {
		await page.goto( reviewUrl( `${ base }/?debug&paused&t=12&dpr=1&${ query }` ) );
		await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.frame > 150, null, { timeout: 60000 } );
		await drawn();
	};
	await loadAt( 'dist=50' );
	const near = await pose();
	assert.ok( Math.abs( near.distance - 50 ) < 1e-3 && near.farthest > 60, `dist=50 starts at 50 m with room to zoom out (${ JSON.stringify( near ) })` );
	await page.mouse.move( 640, 400 );
	await page.mouse.wheel( 0, 380 );
	await drawn( 30 );
	const out1 = await pose();
	assert.ok( out1.distance > near.distance + 1 && out1.distance <= near.farthest + 1e-3, `the wheel zooms the island view out (${ near.distance } to ${ out1.distance }, farthest ${ near.farthest })` );
	for ( let i = 0; i < 3; i ++ ) await page.mouse.wheel( 0, - 380 );
	await drawn( 30 );
	const back = await pose();
	assert.ok( back.distance < out1.distance - 1 && back.distance >= near.distance - 1e-3, `the wheel zooms back in no nearer than the start (${ out1.distance } to ${ back.distance })` );
	checks.push( 'The wheel zooms the island view out to the farthest zoom and back in no nearer than its start' );
	// `cameraInput=off` holds the island view: a drag, W and the wheel leave it where it is
	await loadAt( 'cameraInput=off' );
	const held = await pose();
	await dragRight();
	await holdW();
	await page.mouse.wheel( 0, 380 );
	await drawn( 30 );
	assert.ok( still( held, await pose() ), 'cameraInput=off: a drag, W and the wheel leave the island camera where it is' );
	checks.push( 'cameraInput=off: a left drag, W and the wheel leave the island camera where it is' );
	if ( production ) {
		await page.goto( reviewUrl( base ) );
		await page.waitForFunction( () => document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 60000 } );
		assert.equal( await page.evaluate( () => window.__PONLAI__ === undefined && window.__THREE_GAME_DIAGNOSTICS__ === undefined ), true );
		checks.push( 'Production entry renders without exposing development scene handles' );
	}
	assert.deepEqual( errors, [] );
	assert.deepEqual( failures, [] );
	await writeFile( `${ out }/report.json`, JSON.stringify( { base, checks, inspect, errors, failures, motionT, stopT }, null, 2 ) );
	console.log( JSON.stringify( { checks, errors, failures } ) );
} finally {
	await browser.close();
}
