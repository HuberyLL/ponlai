// Compare production URLs in one browser/page, alternating A/B/B/A to reduce clock drift.
// Usage: node tools/benchmark-lighting.mjs <before URL> <after URL>
// Its pages are paused in the test mode, which bound their GPU queue to two frames
// (src/post/FramePacer.ts, "A paused page's queue"): a build from before that bound queues without
// limit, so between builds on either side of it the paused pages' back-pressure differs, and so may
// their frame times.
import { chromium } from 'playwright';
import { acquireGpuLock } from './gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';

const urls = process.argv.slice( 2 );
assert.equal( urls.length, 2 );
const errors = [], measurements = [];
// one rendering browser at a time on this machine (released when the process exits)
await acquireGpuLock( 'benchmark-lighting' );
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
try {
	const page = await browser.newPage( { viewport: { width: 2400, height: 1500 }, deviceScaleFactor: 1.5 } );
	page.on( 'pageerror', error => errors.push( error.message ) );
	page.on( 'console', message => { if ( message.type() === 'error' ) errors.push( message.text() ); } );
	for ( const version of [ 0, 1, 1, 0 ] ) {

		await page.goto( `${ urls[ version ].replace( /\/$/, '' ) }/?debug&paused&t=12&dpr=1.5&frameRate=0` );
		await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.frame > 350, null, { timeout: 90000 } );
		const samples = [];
		for ( let i = 0; i < 4; i ++ ) {

			await page.waitForTimeout( 1000 );
			samples.push( await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) ) );

		}
		measurements.push( { version, meanFrameMs: samples.reduce( ( sum, sample ) => sum + sample.frameMs, 0 ) / samples.length, samples } );

	}
	const mean = version => {

		const runs = measurements.filter( measurement => measurement.version === version );
		return runs.reduce( ( sum, run ) => sum + run.meanFrameMs, 0 ) / runs.length;

	};
	const summary = { beforeMs: mean( 0 ), afterMs: mean( 1 ), deltaMs: mean( 1 ) - mean( 0 ) };
	await mkdir( 'artifacts/verification', { recursive: true } );
	await writeFile( 'artifacts/verification/lighting-performance.json', JSON.stringify( { urls, summary, measurements, errors }, null, 2 ) );
	console.log( JSON.stringify( { summary, runs: measurements.map( ( { version, meanFrameMs } ) => ( { version, meanFrameMs } ) ), errors } ) );
	assert.deepEqual( errors, [] );

} finally { await browser.close(); }
