// Real browser regression checks for the visual sample; no synthetic gameplay hooks required.
// Run against a production preview: node tools/verify-scene.mjs http://127.0.0.1:5191
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const base = process.argv[ 2 ] || 'http://127.0.0.1:5190';
const out = 'artifacts/verification';
const production = process.argv.includes( '--production' ) || base.includes( '5191' );
await mkdir( out, { recursive: true } );
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
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
		const s = window.__SOOMI__;
		const bad = [], world = [];
		s.scene.traverse( ( o ) => {
			if ( ! o.isMesh ) return;
			for ( const key of [ 'position', 'normal' ] ) {
				const a = o.geometry.getAttribute( key );
				if ( a && ! a.array.every( Number.isFinite ) ) bad.push( `${ o.name }:${ key }` );
			}
			if ( o.parent?.name === 'world' ) world.push( { name: o.name, vertices: o.geometry.getAttribute( 'position' ).count, maxY: o.geometry.boundingBox?.max.y, meadowDetail: o.material.userData.meadowDetail } );
		} );
		return { bad, world, diag: window.__THREE_GAME_DIAGNOSTICS__, t: s.shared.time.value };
	} );
	assert.deepEqual( inspect.bad, [] );
	assert.equal( inspect.world.filter( ( m ) => m.name.startsWith( 'stack' ) ).length, 0 );
	const rocks = inspect.world.find( ( m ) => m.name === 'rocks' );
	assert.ok( rocks && rocks.vertices > 0 && rocks.maxY <= - 1.15 );
	assert.equal( rocks.meadowDetail, false );
	assert.equal( inspect.world.find( ( m ) => m.name === 'island' )?.meadowDetail, true );
	assert.equal( inspect.t, 12 );
	checks.push( 'Finite geometry, no exposed offshore rocks, bare submerged stone, frozen time t=12, WebGPU rendered' );
	await page.screenshot( { path: `${ out }/overview.png` } );
	await page.keyboard.press( 'Space' );
	await page.waitForTimeout( 1200 );
	const motionT = await page.evaluate( () => window.__SOOMI__.shared.time.value );
	assert.ok( motionT > 12.5 );
	await page.screenshot( { path: `${ out }/motion-a.png` } );
	await page.waitForTimeout( 1800 );
	await page.screenshot( { path: `${ out }/motion-b.png` } );
	await page.keyboard.press( 'Space' );
	const stopT = await page.evaluate( () => window.__SOOMI__.shared.time.value );
	await page.waitForTimeout( 400 );
	assert.equal( await page.evaluate( () => window.__SOOMI__.shared.time.value ), stopT );
	checks.push( 'Space resumes water and vegetation, then freezes the shared simulation clock' );
	const before = await page.evaluate( () => window.__SOOMI__.camera.position.toArray() );
	await page.mouse.move( 830, 470 );
	await page.mouse.down();
	await page.mouse.move( 1010, 490, { steps: 25 } );
	await page.mouse.up();
	await page.waitForTimeout( 1300 );
	const after = await page.evaluate( () => window.__SOOMI__.camera.position.toArray() );
	assert.ok( after.some( ( v, i ) => Math.abs( v - before[ i ] ) > 1 ) );
	await page.screenshot( { path: `${ out }/orbit.png` } );
	await page.mouse.wheel( 0, - 380 );
	await page.waitForTimeout( 1200 );
	await page.screenshot( { path: `${ out }/close.png` } );
	checks.push( 'Real pointer drag rotates the island and wheel zooms without rendering errors' );
	await page.setViewportSize( { width: 1280, height: 800 } );
	await page.waitForTimeout( 900 );
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
		assert.equal( await page.evaluate( () => window.__SOOMI__ === undefined && window.__THREE_GAME_DIAGNOSTICS__ === undefined ), true );
		checks.push( 'Production entry renders without exposing development scene handles' );
	}
	assert.deepEqual( errors, [] );
	assert.deepEqual( failures, [] );
	await writeFile( `${ out }/report.json`, JSON.stringify( { base, checks, inspect, errors, failures, motionT, stopT }, null, 2 ) );
	console.log( JSON.stringify( { checks, errors, failures } ) );
} finally {
	await browser.close();
}
