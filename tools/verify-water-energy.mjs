// Actual WebGPU helper regression: foam hemispheric energy and separated solar/sky column sources.
// Apply water-volume-transport.patch and water-foam-lambert.patch so the material uses these helpers.
// Usage: node tools/verify-water-energy.mjs http://127.0.0.1:5190
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

const waterSource = await readFile( new URL( '../src/ocean/Water.ts', import.meta.url ), 'utf8' );
for ( const call of [ "from './WaterTransport.ts'", 'foamLambertRadiance(', 'waterIncidentSun(', 'waterColumnRadiance(' ] ) {

	assert.ok( waterSource.includes( call ), `Apply the WaterTransport integration patch first: missing ${ call }` );

}
const errors = [];
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

			const { renderer, shared, water } = window.__SOOMI__;
			const module = await import( '/src/ocean/WaterTransport.ts' );
			return { probe: await module.verifyWaterEnergy( renderer, {
				sigA: shared.sigA.value.toArray(), sigS: shared.sigS.value.toArray(),
				backscatter: water.uniforms.backscatter.value,
			} ) };

		} catch ( error ) { return { failure: error.message }; }

	} );
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/water-energy.json', JSON.stringify( { result, errors }, null, 2 ) );
	console.log( JSON.stringify( { ...result, errors } ) );
	assert.equal( result.failure, undefined );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
