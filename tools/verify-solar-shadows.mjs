// GPU regression: the sun shadow's disk filter keeps one penumbra width at any caster distance,
// and receiver planes stay unoccluded at low solar elevation.
// Needs the Vite dev server: it imports /src/ modules into the page (tools/dev-server.mjs).
// Usage: node tools/verify-solar-shadows.mjs http://127.0.0.1:5190 [extra query]
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { requireDevServer } from './dev-server.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await requireDevServer( process.argv[ 2 ] || 'http://127.0.0.1:5190', 'verify-solar-shadows' );
await acquireGpuLock( 'verify-solar-shadows', { shared: true } );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {
	const page = await browser.newPage( { viewport: { width: 1672, height: 941 } } );
	page.on( 'pageerror', e => errors.push( e.message ) );
	page.on( 'console', m => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
	await page.goto( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?paused&t=12&dpr=1${ process.argv[ 3 ] ? '&' + process.argv[ 3 ] : '' }` );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const module = await import( '/src/lighting/SolarShadow.ts' );
			return { probe: await module.verifySolarShadow( window.__PONLAI__.renderer ),
				ramp: await module.verifySolarShadowRamp( window.__PONLAI__.renderer ) };

		} catch ( error ) { return { failure: error.message }; }

	} );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/solar-shadow.json', JSON.stringify( { result, errors }, null, 2 ) );
	console.log( JSON.stringify( { ...result, errors }, ( key, value ) => key === 'profiles' ? undefined : value ) );
	assert.equal( result.failure, undefined );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
