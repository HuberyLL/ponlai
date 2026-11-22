// Checks on the GPU that the sun's shadow keeps one penumbra width and spares receivers at a low sun.
//
// It loads a paused page and runs the probes in packages/render/lighting/SolarShadow.ts
// (`verifySolarShadow`, `verifySolarShadowRamp`): the disk filter of the sun's shadow keeps one
// penumbra width at any caster distance, and receiver planes stay unoccluded at a low sun. Run it
// after a change to the sun's shadow or its filter.
//
// Usage:
//   node tools/render/verify-solar-shadows.mjs [url] [query]
//   node tools/render/verify-solar-shadows.mjs http://127.0.0.1:5190 aa=taa
//
// Options:
//   url     the dev server (default http://127.0.0.1:5190)
//   query   extra URL options added to the page's `paused&t=12&dpr=1` (default none)
//
// Output: the probes' results (their profiles left out) and the page's errors as JSON on stdout;
// the whole result in artifacts/verification/solar-shadow.json.
//
// GPU lock and browser: takes the GPU lock shared (docs/reference/gpu-lock.md; its pixels do not
// depend on the GPU's load) and opens headless Chrome (CHROME_PATH, else Playwright's Chromium). It
// imports the source modules into the page, so it needs the dev server: on any other server it
// stops before the lock (tools/kit/dev-server.mjs).
//
// Cost: a page load and its first 80 frames, then the probes: seconds.
//
// Exit codes: 0 the probes ran and the page logged no error; 1 a probe threw, the page logged an
// error, or the url is not the dev server (a failed assertion is thrown).
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { requireDevServer } from '../kit/dev-server.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { reviewUrl } from '../kit/page-query.mjs';

const errors = [];
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/kit/gpu-lock.mjs; released when the process exits)
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
	await page.goto( reviewUrl( `${ process.argv[ 2 ] || 'http://127.0.0.1:5190' }/?paused&t=12&dpr=1${ process.argv[ 3 ] ? '&' + process.argv[ 3 ] : '' }` ) );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const module = await import( '/packages/render/lighting/SolarShadow.ts' );
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
