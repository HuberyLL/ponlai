// GPU regression: air blockers bend at the water surface and submerged blockers occlude
// the separate refracted leg; horizontal-floor irradiance preserves transmitted power.
// Needs the Vite dev server: it imports the source modules into the page (tools/kit/dev-server.mjs).
// The paused seek's map is read on the page's rendered frames (tools/kit/page-eval.mjs, "Rendered frames").
// Usage: node tools/verify-refracted-sun.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './kit/gpu-lock.mjs';
import { requireDevServer } from './kit/dev-server.mjs';
import { installWaitFrames } from './kit/page-eval.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/kit/gpu-lock.mjs; released when the process exits)
await requireDevServer( process.argv[ 2 ] || 'http://127.0.0.1:5190', 'verify-refracted-sun' );
await acquireGpuLock( 'verify-refracted-sun', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 } } );
	await installWaitFrames( page );
	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	await page.goto( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?paused&t=12&dpr=1` );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const module = await import( '/packages/render/lighting/RefractedSun.ts' );
			const map = window.__PONLAI__.refractedSun;
			if ( ! map ) throw new Error( 'RefractedSun integration is missing from the dev scene' );
			const span = map.worldSpan.value.toArray(), size = map.target.width;
			return { probe: await module.probeRefractedSun( window.__PONLAI__.renderer ),
				productionMap: { worldSpan: span, mapSize: size, metresPerTexel: span.map( length => length / size ), depthRange: map.depthRange.value } };

		} catch ( error ) { return { failure: error.message }; }

	} );
	// A paused clock moved by less than the map's angle gate (a capture's seek) must still leave
	// the map drawn at exactly the key light's direction, as a fresh load at that time would.
	const seek = await page.evaluate( async () => {

		const s = window.__PONLAI__, map = s.refractedSun;
		const before = map.lastSun.clone();
		await s.setHour( s.dayCycle.hour + 0.001 );
		const sun = s.shared.sunDir.value;
		// polled on the page's rendered frames (tools/kit/page-eval.mjs WAIT_FRAMES) until the map is
		// drawn at the light, or 10 s: it redraws on its interval's update, a number of frames that
		// depends on their pace
		const from = s.renderer.info.frame, deadline = performance.now() + 10000;
		while ( ! map.lastSun.equals( sun ) && performance.now() < deadline ) await window.__waitFrames( 1, 10000 );
		return { turnDegrees: before.angleTo( sun ) * 180 / Math.PI, gateDegrees: map.angleGate * 180 / Math.PI,
			drawnExactly: map.lastSun.equals( sun ), frames: s.renderer.info.frame - from };

	} );
	result.pausedSeek = seek;
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/refracted-sun.json', JSON.stringify( { result, errors }, null, 2 ) );
	console.log( JSON.stringify( { ...result, errors } ) );
	assert.equal( result.failure, undefined );
	assert.equal( result.probe?.passed, true, 'Refracted sun geometry/irradiance probe failed' );
	assert.ok( result.productionMap.metresPerTexel.every( length => length <= 0.08 ), 'Local submerged shadow texel exceeds8cm' );
	assert.ok( seek.turnDegrees > 0 && seek.turnDegrees < seek.gateDegrees, `The paused seek did not test a turn below the gate: ${ JSON.stringify( seek ) }` );
	assert.equal( seek.drawnExactly, true, 'A paused seek below the angle gate left the refracted map behind the key light' );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
