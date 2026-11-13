// Regression probe for the island camera's anchors (packages/island/camera/IslandCameraControls.ts): a wheel
// zoom and a pinch move out from the ground under the cursor, and a drag keeps the grabbed ground
// under it, so that point stays at the cursor's pixel on every frame.
//
//   node tools/island/verify-zoom-anchor.mjs [url] [--runs 24] [--q "extra&query"] [--out file.json] [--timeout 600000]
//
// url: the server (default http://127.0.0.1:5190/, the dev server); a production preview needs
// `debug` in --q for `window.__PONLAI__`. One page (tools/kit/probe.mjs, the GPU lock shared, 1600x900)
// runs the cases, each from a scene jump to its start view, with synthetic input dispatched on the
// canvas between rendered frames:
//   wheel-sea    a macOS wheel notch out (deltaY +4.000244140625) every 3 frames from 40 m to the
//                farthest zoom, the cursor at 72 % / 62 % over the water (the island view zooms
//                out only, from its pose's distance: IslandStages.ts `islandNearest`); `--runs` times, as a
//                per-anchor failure of a few in a hundred needs that many notches to show (the sea's
//                hit once rounded to a miss for 2 % of anchors: IslandGround.ts)
//   wheel-land   the same from 22 m with the cursor at 45 % / 50 % over the island, a quarter as
//                many runs
//   pinch-out    a ctrl wheel (Chrome's pinch) of +4 every frame from 22 m, the cursor at 30 % / 70 %
//   pinch-fast   a ctrl wheel of +8 every frame from 22 m, the cursor at 55 % / 45 %
//   drag         a left drag of 6 px right and 3 px up per frame for 30 frames, at 22 m
// Per case the ground under the cursor is taken once before the input (`controls.groundAt`) and
// projected after every frame; its distance from the cursor is the drift. Every anchor a zoom takes
// (`anchorZoom`) is recorded, and one that found no ground is a loss. A case passes with no loss and
// a worst drift under 0.5 px (the anchors are exact solutions; over land each notch takes its anchor
// again from the coarse height grid, which moved the first one by up to 0.15 px).
// Prints one line per case; `--out` writes the whole record (each case's runs, the losses with the
// camera's position, quaternion, fov and the ray). Exit 0 passed, 1 failed, 2 bad arguments.
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice( 2 );
const options = {}, positional = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( argv[ i ].startsWith( '--' ) ) options[ argv[ i ].slice( 2 ) ] = argv[ ++ i ];
	else positional.push( argv[ i ] );

}
const unknown = Object.keys( options ).filter( ( k ) => ! [ 'runs', 'q', 'out', 'timeout' ].includes( k ) );
const runs = Number( options.runs ?? 24 );
if ( positional.length > 1 || unknown.length || ! ( runs >= 1 ) ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : 'usage: verify-zoom-anchor.mjs [url] [--runs 24] [--q extra] [--out file.json] (see the file header)' );
	process.exit( 2 );

}
const url = positional[ 0 ] ?? 'http://127.0.0.1:5190/';
// (the island camera takes the hand's input only with `cameraInput`)
const query = options.q ? `paused&cameraInput&${ options.q }` : 'paused&cameraInput';
const MAX_DRIFT = 0.5;

const cases = [
	{ name: 'wheel-sea', start: 'paused&dist=40&polar=50&az=318', at: [ 0.72, 0.62 ], input: 'wheel', delta: 4.000244140625, every: 3, frames: 60, runs },
	{ name: 'wheel-land', start: 'paused&dist=22&polar=50&az=318', at: [ 0.45, 0.5 ], input: 'wheel', delta: 4.000244140625, every: 3, frames: 60, runs: Math.max( 1, Math.ceil( runs / 4 ) ) },
	{ name: 'pinch-out', start: 'paused&dist=22&polar=78&az=318', at: [ 0.3, 0.7 ], input: 'pinch', delta: 4, every: 1, frames: 30, runs: 1 },
	{ name: 'pinch-fast', start: 'paused&dist=22&polar=50&az=318', at: [ 0.55, 0.45 ], input: 'pinch', delta: 8, every: 1, frames: 30, runs: 1 },
	{ name: 'drag', start: 'paused&dist=22&polar=60&az=300', at: [ 0.4, 0.55 ], input: 'drag', frames: 30, runs: 1 },
];

// Runs in the page (tools/kit/page-eval.mjs scope: P, frames).
async function pageCheck( cases ) {

	const c = P.controls, cam = P.camera, el = P.renderer.domElement;
	const r = el.getBoundingClientRect();
	const pixel = ( p ) => { cam.updateMatrixWorld(); const q = p.clone().project( cam ); return [ ( q.x + 1 ) / 2 * r.width, ( 1 - q.y ) / 2 * r.height ]; };
	const wheel = ( x, y, dy, ctrl ) => el.dispatchEvent( new WheelEvent( 'wheel', { deltaY: dy, deltaMode: 0, ctrlKey: ctrl, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true } ) );
	const pointer = ( type, x, y ) => el.dispatchEvent( new PointerEvent( type, { pointerId: 7, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1, clientX: r.left + x, clientY: r.top + y, bubbles: true, cancelable: true } ) );
	// every anchor a zoom takes, and the camera and ray of one that found no ground
	let current = null;
	const anchorZoom = c.anchorZoom.bind( c );
	c.anchorZoom = () => {

		anchorZoom();
		if ( ! current ) return;
		current.anchors ++;
		if ( c.zoomAnchored ) return;
		const dir = cam.position.clone();
		c.ray( c.zoomNdcX, c.zoomNdcY, dir );
		current.losses.push( { run: current.run, frame: current.frame, position: cam.position.toArray(), quaternion: cam.quaternion.toArray(), fov: cam.fov, maxDistance: c.maxDistance, ray: dir.toArray() } );

	};
	const out = [];
	try {

		for ( const k of cases ) {

			const x = r.width * k.at[ 0 ], y = r.height * k.at[ 1 ];
			const result = { name: k.name, anchors: 0, losses: [], worstPx: 0, runs: [] };
			current = result;
			for ( let run = 0; run < k.runs; run ++ ) {

				current.run = run;
				await P.establishScene( k.start );
				await frames( 2 );
				const ground = c.groundAt( x, y, cam.position.clone() );
				if ( ! ground ) { result.error = 'no ground under the cursor'; break; }
				let worst = 0;
				if ( k.input === 'drag' ) {

					pointer( 'pointerdown', x, y );
					await frames( 1 );
					for ( let i = 1; i <= k.frames; i ++ ) {

						current.frame = i;
						pointer( 'pointermove', x + i * 6, y - i * 3 );
						await frames( 1 );
						const [ px, py ] = pixel( ground );
						worst = Math.max( worst, Math.hypot( px - x - i * 6, py - y + i * 3 ) );

					}
					pointer( 'pointerup', x + k.frames * 6, y - k.frames * 3 );
					await frames( 1 );

				} else {

					// the input stops 15 frames before the end, so the last notch's glide is measured
					for ( let i = 0; i < k.frames; i ++ ) {

						current.frame = i;
						if ( i % k.every === 0 && i < k.frames - 15 ) wheel( x, y, k.delta, k.input === 'pinch' );
						await frames( 1 );
						const [ px, py ] = pixel( ground );
						worst = Math.max( worst, Math.hypot( px - x, py - y ) );

					}

				}
				c.settle();
				result.worstPx = Math.max( result.worstPx, worst );
				result.runs.push( { over: ground.y > 1e-6 ? 'land' : 'sea', ground: ground.toArray(), end: cam.position.distanceTo( c.target ), driftPx: worst } );

			}
			out.push( result );

		}

	} finally {

		current = null;
		delete c.anchorZoom;
		await P.establishScene( 'paused' );

	}
	return out;

}

const probe = fileURLToPath( new URL( '../kit/probe.mjs', import.meta.url ) );
const evalJs = `async () => ( ${ pageCheck.toString() } )( ${ JSON.stringify( cases ) } )`;
const child = spawn( process.execPath, [ probe, url, '--q', query, '--w', '1600', '--h', '900', '--timeout', options.timeout ?? '600000', '--eval', evalJs ], { stdio: [ 'ignore', 'pipe', 'inherit' ] } );
let stdout = '';
child.stdout.on( 'data', ( d ) => { stdout += d; } );
const code = await new Promise( ( resolve ) => child.on( 'close', resolve ) );
let record;
try { record = JSON.parse( stdout ); } catch { console.error( `probe.mjs exited ${ code } without its JSON` ); process.exit( 1 ); }
const step = record.queries?.[ 0 ]?.steps?.[ 0 ];
if ( ! step || step.error || ! Array.isArray( step.value ) ) { console.error( `the page check failed: ${ step?.error ?? `probe.mjs exited ${ code }` }` ); process.exit( 1 ); }
if ( options.out ) await writeFile( path.resolve( options.out ), JSON.stringify( { url, query, cases: step.value }, null, '\t' ) );

let failed = false;
for ( const k of step.value ) {

	const over = [ ...new Set( k.runs.map( ( r ) => r.over ) ) ].join( '+' );
	const pass = ! k.error && k.losses.length === 0 && k.worstPx < MAX_DRIFT;
	failed ||= ! pass;
	const drifting = k.runs.filter( ( r ) => r.driftPx >= MAX_DRIFT ).length;
	console.log( `${ pass ? 'pass' : 'FAIL' }  ${ k.name.padEnd( 10 ) } ${ k.error ?? `${ k.runs.length } run(s) over ${ over }, ${ k.losses.length } of ${ k.anchors } anchors lost, worst drift ${ k.worstPx.toFixed( 3 ) } px${ drifting ? ` (${ drifting } run(s) at ${ MAX_DRIFT } px or more)` : '' }` }` );

}
process.exit( failed ? 1 : 0 );
