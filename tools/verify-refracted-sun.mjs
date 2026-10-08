// GPU regression: air blockers bend at the water surface and submerged blockers occlude
// the separate refracted leg; horizontal-floor irradiance preserves transmitted power.
// Usage: node tools/verify-refracted-sun.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// one rendering browser at a time on this machine (released when the process exits)
await acquireGpuLock( 'verify-refracted-sun' );
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
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/refracted-sun.json', JSON.stringify( { result, errors }, null, 2 ) );
	console.log( JSON.stringify( { ...result, errors } ) );
	assert.equal( result.failure, undefined );
	assert.equal( result.probe?.passed, true, 'Refracted sun geometry/irradiance probe failed' );
	assert.ok( result.productionMap.metresPerTexel.every( length => length <= 0.08 ), 'Local submerged shadow texel exceeds8cm' );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
