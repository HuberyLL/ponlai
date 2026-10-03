// Full-resolution captures of the running dev server for visual review.
//   node tools/capture.mjs [name] [--w 1600 --h 900] [--q "query"] [--eval "js"] [--wait 6000] [--verbose]
// Writes artifacts/captures/<name>.png and prints the page's console errors and diagnostics.
import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';

const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const name = args[ 0 ] && ! args[ 0 ].startsWith( '--' ) ? args[ 0 ] : 'shot';
const W = Number( opt( 'w', 1600 ) ), H = Number( opt( 'h', 900 ) );
const query = opt( 'q', 'paused&t=12&dpr=1' );
const evalJs = opt( 'eval', '' );
const wait = Number( opt( 'wait', 7000 ) );
const url = `${ opt( 'url', 'http://127.0.0.1:5190/' ) }?${ query }`;
const sampleCount = Number( opt( 'samples', 1 ) );

await mkdir( 'artifacts/captures', { recursive: true } );
// Playwright's full Chromium (`npx playwright install chromium`; the headless shell may lack
// WebGPU), or another build through CHROME_PATH
const browser = await chromium.launch( {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	// (no vsync, so frame times measure the GPU work rather than the display rate)
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
} );
const page = await browser.newPage( { viewport: { width: W, height: H }, deviceScaleFactor: Number( opt( 'scale', 1 ) ) } );
const errors = [];
const failures = [];
const verbose = args.includes( '--verbose' );
page.on( 'console', ( m ) => { if ( verbose || m.type() === 'error' || m.type() === 'warning' ) errors.push( m.type() + ': ' + m.text() ); } );
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
page.on( 'response', ( r ) => { if ( r.status() >= 400 ) failures.push( `${ r.status() } ${ r.url() }` ); } );
page.on( 'requestfailed', ( r ) => failures.push( `${ r.failure()?.errorText } ${ r.url() }` ) );
try {
	await page.goto( url );
	await page.waitForFunction( () => window.__SOOMI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout: 60000 } );
	if ( evalJs ) await page.evaluate( evalJs );
	await page.waitForTimeout( wait );
	// An edit can trigger a Vite reload during the settling delay. Never accept a loading screen.
	await page.waitForFunction( () => window.__THREE_GAME_DIAGNOSTICS__?.frame > 150 &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 60000 } );
	await page.waitForTimeout( 1100 );
	const samples = [];
	for ( let i = 0; i < sampleCount; i ++ ) {
		if ( i > 0 ) await page.waitForTimeout( 1000 );
		samples.push( await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) ) );
	}
	const out = `artifacts/captures/${ name }.png`;
	await page.screenshot( { path: out } );
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const gpu = await page.evaluate( async () => {
		const adapter = await navigator.gpu.requestAdapter();
		return adapter ? { vendor: adapter.info.vendor, architecture: adapter.info.architecture, device: adapter.info.device, description: adapter.info.description } : null;
	} );
	await writeFile( `artifacts/captures/${ name }.json`, JSON.stringify( {
		url, viewport: { width: W, height: H }, samples, diag, gpu, errors, failures,
		meanFrameMs: samples.reduce( ( s, d ) => s + d.frameMs, 0 ) / samples.length,
	}, null, 2 ) );
	console.log( out, JSON.stringify( diag ) );
	if ( errors.length ) console.log( errors.slice( 0, verbose ? 60 : 12 ).join( '\n' ) );
	if ( failures.length ) console.log( failures.join( '\n' ) );
	if ( errors.some( ( e ) => e.startsWith( 'pageerror:' ) || e.startsWith( 'error:' ) ) || failures.length ) process.exitCode = 1;
} finally {
	await browser.close();
}
