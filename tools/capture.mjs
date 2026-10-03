// Full-resolution captures of the running dev server for visual review.
//   node tools/capture.mjs [name] [--w 1600 --h 900] [--q "query"] [--eval "js"] [--wait 6000] [--verbose]
// Writes artifacts/captures/<name>.png and prints the page's console errors and diagnostics.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const name = args[ 0 ] && ! args[ 0 ].startsWith( '--' ) ? args[ 0 ] : 'shot';
const W = Number( opt( 'w', 1600 ) ), H = Number( opt( 'h', 900 ) );
const query = opt( 'q', 'paused&t=12&dpr=1' );
const evalJs = opt( 'eval', '' );
const wait = Number( opt( 'wait', 7000 ) );
const url = `http://127.0.0.1:5190/?${ query }`;

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
const verbose = args.includes( '--verbose' );
page.on( 'console', ( m ) => { if ( verbose || m.type() === 'error' || m.type() === 'warning' ) errors.push( m.type() + ': ' + m.text() ); } );
page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
await page.goto( url );
await page.waitForFunction( () => window.__SOOMI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout: 60000 } );
if ( evalJs ) await page.evaluate( evalJs );
await page.waitForTimeout( wait );
const out = `artifacts/captures/${ name }.png`;
await page.screenshot( { path: out } );
const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
console.log( out, JSON.stringify( diag ) );
if ( errors.length ) console.log( errors.slice( 0, verbose ? 60 : 12 ).join( '\n' ) );
await browser.close();
