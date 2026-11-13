// Real browser regression checks for the visual sample; no synthetic gameplay hooks required.
// Run against a production preview: node tools/island/verify-scene.mjs http://127.0.0.1:5191
import { chromium } from 'playwright';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

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
	await page.goto( `${ base }/?debug&paused&t=12&dpr=1` );
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
	const before = await page.evaluate( () => window.__PONLAI__.camera.position.toArray() );
	await page.mouse.move( 830, 470 );
	await page.mouse.down();
	await page.mouse.move( 1010, 490, { steps: 25 } );
	await page.mouse.up();
	await page.waitForTimeout( 1300 );
	const after = await page.evaluate( () => window.__PONLAI__.camera.position.toArray() );
	await page.keyboard.down( 'KeyW' );
	await page.waitForTimeout( 600 );
	await page.keyboard.up( 'KeyW' );
	await page.waitForTimeout( 600 );
	const held = await page.evaluate( () => window.__PONLAI__.camera.position.toArray() );
	assert.ok( after.every( ( v, i ) => Math.abs( v - before[ i ] ) < 1e-3 ) && held.every( ( v, i ) => Math.abs( v - before[ i ] ) < 1e-3 ) );
	checks.push( 'A real left drag and the pan keys leave the framed island camera where it is' );
	const distance = () => page.evaluate( () => { const s = window.__PONLAI__; return s.camera.position.distanceTo( s.controls.target ); } );
	const far = await distance();
	await page.mouse.wheel( 0, - 380 );
	await page.waitForTimeout( 1200 );
	const near = await distance();
	assert.ok( near < far - 1 );
	await page.screenshot( { path: `${ out }/close.png` } );
	checks.push( 'The wheel zooms the framed island camera in' );
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
	if ( production ) {
		await page.goto( base );
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
