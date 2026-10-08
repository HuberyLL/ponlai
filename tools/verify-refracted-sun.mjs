// GPU regression: air blockers bend at the water surface and submerged blockers occlude
// the separate refracted leg; horizontal-floor irradiance preserves transmitted power.
// Usage: node tools/verify-refracted-sun.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await acquireGpuLock( 'verify-refracted-sun', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 } } );
	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	await page.goto( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?paused&t=12&dpr=1` );
	await page.waitForFunction( () => window.__SOOMI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const module = await import( '/src/lighting/RefractedSun.ts' );
			const map = window.__SOOMI__.refractedSun;
			if ( ! map ) throw new Error( 'RefractedSun integration is missing from the dev scene' );
			const span = map.worldSpan.value.toArray(), size = map.target.width;
			return { probe: await module.probeRefractedSun( window.__SOOMI__.renderer ),
				productionMap: { worldSpan: span, mapSize: size, metresPerTexel: span.map( length => length / size ), depthRange: map.depthRange.value } };

		} catch ( error ) { return { failure: error.message }; }

	} );
	// A paused clock moved by less than the map's angle gate (a capture's seek) must still leave
	// the map drawn at exactly the key light's direction, as a fresh load at that time would.
	const seek = await page.evaluate( async () => {

		const s = window.__SOOMI__, map = s.refractedSun;
		const before = map.lastSun.clone();
		await s.setHour( s.dayCycle.hour + 0.001 );
		const sun = s.shared.sunDir.value;
		const until = performance.now() + 1000;
		while ( performance.now() < until ) await new Promise( ( resolve ) => requestAnimationFrame( resolve ) );
		return { turnDegrees: before.angleTo( sun ) * 180 / Math.PI, gateDegrees: map.angleGate * 180 / Math.PI,
			drawnExactly: map.lastSun.equals( sun ) };

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
