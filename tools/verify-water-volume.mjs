// Isolated GPU regression for depth-varying water shadows and RGB transport weights.
// Usage: node tools/verify-water-volume.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// one rendering browser at a time on this machine (released when the process exits)
await acquireGpuLock( 'verify-water-volume' );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {

	const page = await browser.newPage( { viewport: { width: 1672, height: 941 } } );
	page.on( 'pageerror', error => errors.push( error.message ) );
	page.on( 'console', message => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	await page.goto( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?debug&paused&t=12&dpr=1` );
	await page.waitForFunction( () => window.__SOOMI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const { verifyWaterVolume } = await import( '/src/ocean/WaterVolumeProbe.ts' );
			const { renderer } = window.__SOOMI__;
			return { probe: await verifyWaterVolume( renderer ) };

		} catch ( error ) { return { failure: error.message }; }

	} );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/water-volume.json', JSON.stringify( { result, errors }, null, 2 ) );
	console.log( JSON.stringify( { ...result, errors } ) );
	assert.equal( result.failure, undefined );
	assert.equal( result.probe?.passed, true, 'Depth-varying water volume GPU probe failed' );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
