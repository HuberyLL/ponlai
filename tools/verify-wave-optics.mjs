// GPU regression: FFT-filtered slope energy and physically normalized Gaussian sea optics.
// Needs the Vite dev server: it imports /src/ modules into the page (tools/dev-server.mjs).
// Usage: node tools/verify-wave-optics.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { requireDevServer } from './dev-server.mjs';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';

const errors = [];
// shared with other probes (their pixels do not depend on the GPU load), never during a timing
// run (tools/gpu-lock.mjs; released when the process exits)
await requireDevServer( process.argv[ 2 ] || 'http://127.0.0.1:5190', 'verify-wave-optics' );
await acquireGpuLock( 'verify-wave-optics', { shared: true } );
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
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 80, null, { timeout: 90000 } );
	const result = await page.evaluate( async () => {

		try {

			const module = await import( '/src/ocean/WaveOptics.ts' );
			const { renderer, fft } = window.__PONLAI__;
			return {
				probe: await module.verifyWaveOptics( renderer, fft ),
				covarianceCorrections: await module.verifyWaveCovarianceCorrections( renderer ),
			};

		} catch ( error ) { return { failure: error.message }; }

	} );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/wave-optics.json', JSON.stringify( { result, errors }, null, 2 ) );
	const p = result.probe;
	console.log( JSON.stringify( p ? {
		additionalTargets: p.additionalTargets, maximumNormalResidual: p.maximumNormalResidual,
		maximumJacobianError: p.maximumJacobianError, signedCrossRange: [ p.crossMinimum, p.crossMaximum ],
		globalSlopeVariance: p.reports.filter( r => r.mip === 8 ).map( r => ( { cascade: r.cascade, trace: r.trace } ) ),
		beckmann: p.beckmann, furnace: p.furnace, covarianceCorrections: result.covarianceCorrections, errors,
	} : { ...result, errors } ) );
	assert.equal( result.failure, undefined );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
