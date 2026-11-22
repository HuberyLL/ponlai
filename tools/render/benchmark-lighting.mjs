// Times a paused page of two builds in one browser page, alternating A B B A against clock drift.
//
// It loads each build's paused debug page (`paused&t=12&dpr=1.5&frameRate=0`: the loop drawing at
// every refresh, in a browser without vsync) at a 2400 by 1500 viewport in the order before, after, after, before, waits 350 frames, and averages the
// diagnostics' `frameMs` over four one-second samples per load. It gives a quick frame-time delta
// of a paused frame; a change's frame time is measured with tools/render/profile-frame.mjs
// (`--compare`), which reports per-pass GPU times and intervals.
//
// Usage:
//   node tools/render/benchmark-lighting.mjs <before url> <after url>
//
// Options:
//   before url, after url   the two servers (production previews: tools/kit/serve.mjs preview)
//
// Its pages are paused in the test mode, which bounds their GPU queue to two frames
// (packages/render/post/FramePacer.ts, A paused page's queue): a build from before that bound
// queues without limit, so between builds on either side of it the paused pages' back-pressure
// differs, and so may their frame times.
//
// Output: the summary (before, after and delta in ms), each load's mean and the page's errors as
// JSON on stdout; the samples too in artifacts/verification/lighting-performance.json.
//
// GPU lock and browser: takes the GPU lock alone (docs/reference/gpu-lock.md), since it times
// frames, and opens headless Chrome (CHROME_PATH, else Playwright's Chromium).
//
// Cost: four page loads of about 350 frames each, plus four seconds of samples per load.
//
// Exit codes: 0 done; 1 not two urls, or a page logged an error (a failed assertion is thrown).
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { reviewUrl } from '../kit/page-query.mjs';

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

		await page.goto( reviewUrl( `${ urls[ version ].replace( /\/$/, '' ) }/?debug&paused&t=12&dpr=1.5&frameRate=0` ) );
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
