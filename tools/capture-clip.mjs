// Stepped clips for the temporal anti-aliasing work: a parity view (tools/parity/views.mjs) set in
// motion by a named clip (tools/parity/clips.mjs), rendered frame by frame with the page's
// deterministic stepper (`__PONLAI__.loop.step`: fixed dt, no wall clock, the frame pacer and the
// dynamic scale bypassed), with crops of named subjects captured as they move.
//
//   node tools/capture-clip.mjs <name> --url U --clip <clip> [--aa msaa|off|taa|taau|gt|gt-hi]
//       [--view v] [--frames n] [--every k] [--dense a-b,c-d] [--crops a,b] [--full 0,30] [--q "extra&query"]
//       [--quality high] [--size 1728x1117@2] [--gt-jitters n] [--out dir] [--timeout ms] [--runs file.csv]
//       [--task name] [--anchors-from clip.json] [--stable-* (capture.mjs)] [--ready-frames n] [--wait ms] [--settle ms] [--verbose]
//
// The page loads `U?debug&paused&t=12&quality=<q>&aa=<mode>[&<extra>]&<view's query>[&<clip's
// query>]` (`aa=off` adds `msaa=1`; `aa` reaches builds that read it, others ignore it) in a
// persistent profile slot, runs the view's eval (the crop anchors' setup included), waits for the
// scene as capture.mjs does (tools/capture-browser.mjs: the image stopped changing, with the same
// --stable-* options, or --ready-frames' fixed count; --wait / --settle ms of fixed delay around the
// floor when given; the readiness record goes into clip.json as `ready`; the loop is left stopped,
// as the stepper wants it), runs the clip's eval, reads the crop anchors once at the base pose and then steps the clip. After each frame
// (every k-th with --every, and every frame of the --dense runs; frame 0 always) each anchor's world point is projected with that
// frame's camera into a box of 192 CSS px (384 device px at a pixel ratio of 2, clamped into the
// frame) and captured; an anchor behind the camera that frame is skipped. --full lists frames also
// captured whole. --anchors-from takes the anchors' world points from an earlier clip.json
// instead (the anchors pick their points by device pixels, so a GT run at another pixel ratio
// could pick others: pass the test run's to frame the same subjects).
//
// Output, under artifacts/clips/<name>/ (or --out): <crop>/<i>.png per crop and frame,
// full/<i>.png, and clip.json (the url, the clip, the boxes per frame, the page's diagnostics
// before and after, the pipelines created while stepping, the scene time, the browser build, wall
// time, console errors).
//
// --aa gt is the ground truth of the temporal modes (src/post/Antialiasing.ts, debug builds): the
// temporal graph at the canvas's resolution, each captured frame held still after its tick until
// the temporal rest has averaged `--gt-jitters` jittered renders of it with a box filter
// (`loop.step`'s `converge`; 32 by default, 64 for a clip of one frame, the rest GT), without
// sharpening or grain. Its crops are cut at the test's own size (no downsampling). It renders every
// frame at the canvas's ratio: a clip's scale schedule applies to the test and MSAA sides only.
// Ground-truth sets are shared per merge-base (`<parity root>/<sha>/gt/`).
//
// A clip of one frame (`--clip rest`) is the image at rest: under the other temporal modes (taa,
// taau) it is held still too until the rest has converged on it (`converge`, the tier's own rest
// sequence), as capture.mjs waits for `diag.taa.converged` on a paused page. MSAA and off have no
// rest and capture the frame as stepped.
//
// --aa gt-hi is the interim ground truth (plan section 3.3): MSAA on high at twice high's nominal
// ratio for the --size given (nominal = min( ratio, 1.5 ), so 3 at the default @2 and 2 at @1),
// box-downsampled 2x2. The page runs at that device pixel ratio with the same `dpr` (the canvas
// then holds the render; checked against the canvas's size). If the canvas does not reach it, the
// tool falls back to twice the CSS size at the nominal ratio (the same render, the CSS boxes
// doubled) and records `gtFallback`. Every crop and frame is box-downsampled 2x2, so a gt-hi crop
// is 192 x nominal px (288 at the default size, where the test's crop is 384): clip-metrics.py
// resamples the test to the GT's size. The ground truth renders every frame at its own fixed
// ratio: a clip's render scale schedule (drs-steps) applies to the test and MSAA sides only, and
// clip.json records it as ignored (`scaleSchedule`). Known bias: pixel-width vegetation rules (blades kept 2 px wide, the rim's
// 0.75 px, the coverage gain that fades in under 16 px) are in render pixels, so at 3x the blades
// are drawn a third narrower in scene terms than at 1.5 and fewer blades are widened: GT-HI's
// meadow is finer and slightly darker than any real 1.5x render. Judge vegetation look against
// MSAA, not GT-HI.
//
// Film grain is set to 0 on every side (plan section 3.3: it is re-seeded each frame, so it would
// add noise to F, TI and S, and the GT's 2x2 downsample would halve it); clip.json records it
// (`grain`). The per-pixel dither of a level stays: it is fixed per pixel.
//
// Stepped clips are deterministic (no wall clock), so the tool takes the GPU lock shared.
// Production builds need `?debug` (added here) and the islanders' assets linked into the build
// (tools/parity/README.md).
import { mkdir, readFile, writeFile, appendFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { acquireGpuLock, releaseGpuLock, gpuUtilisation } from './gpu-lock.mjs';
import { VIEWS, viewEval } from './parity/views.mjs';
import { CLIPS, clipEval } from './parity/clips.mjs';
import { launchCapture, waitForScene, waitForStable, stableOptions, decodePng } from './capture-browser.mjs';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const args = process.argv.slice( 2 );
const FLAGS = new Set( [ 'verbose', 'stable-trace' ] );
const options = {}, positional = [];
for ( let i = 0; i < args.length; i ++ ) {

	if ( args[ i ].startsWith( '--' ) ) {

		const k = args[ i ].slice( 2 );
		options[ k ] = FLAGS.has( k ) ? true : args[ ++ i ];

	} else positional.push( args[ i ] );

}
const KNOWN = [ 'url', 'aa', 'clip', 'view', 'frames', 'every', 'dense', 'crops', 'full', 'q', 'quality', 'size', 'out', 'timeout', 'runs', 'task', 'verbose', 'anchors-from', 'gt-jitters', 'ready-frames', 'wait', 'settle',
	'stable-min', 'stable-every', 'stable-repeats', 'stable-tolerance', 'stable-patience', 'stable-cap', 'stable-trace' ];
const unknown = Object.keys( options ).filter( ( k ) => ! KNOWN.includes( k ) );
const clip = CLIPS[ options.clip ];
if ( positional.length !== 1 || unknown.length || ! options.url || ! clip ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : ! clip && options.clip ? `unknown clip ${ options.clip }` : 'usage: capture-clip.mjs <name> --url U --clip <clip> [options] (see the file header)' );
	process.exit( 2 );

}
const name = positional[ 0 ];
const aa = options.aa ?? 'msaa';
const gt = aa === 'gt-hi';
// the temporal modes' ground truth: its jitters per frame (a clip of one frame is a rest GT)
const gtRest = aa === 'gt';
const quality = options.quality ?? 'high';
if ( gt && quality !== 'high' ) { console.error( 'gt-hi exists for high only' ); process.exit( 2 ); }
const viewName = options.view ?? clip.view;
const view = VIEWS[ viewName ];
if ( ! view ) { console.error( `unknown view ${ viewName }` ); process.exit( 2 ); }
const size = ( options.size ?? '1728x1117@2' ).match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
if ( ! size ) { console.error( `bad --size ${ options.size }` ); process.exit( 2 ); }
const W = Number( size[ 1 ] ), H = Number( size[ 2 ] ), DSF = Number( size[ 3 ] ?? 1 );
// high's nominal render ratio at this size (RenderScale.ts: the display's, up to 1.5), and gt-hi's
const NOMINAL_HIGH = Math.min( DSF, 1.5 ), GT_RATIO = 2 * NOMINAL_HIGH;
const frames = Number( options.frames ?? clip.frames );
const gtJitters = gtRest ? Number( options[ 'gt-jitters' ] ?? ( frames <= 1 ? 64 : 32 ) ) : null;
if ( gtRest && ! ( Number.isInteger( gtJitters ) && gtJitters > 0 ) ) { console.error( `bad --gt-jitters ${ options[ 'gt-jitters' ] }` ); process.exit( 2 ); }
const every = Math.max( 1, Number( options.every ?? 1 ) );
const full = new Set( ( options.full ?? '' ).split( ',' ).filter( Boolean ).map( Number ) );
// runs of frames captured whole-clip dense under --every (the ground truth's gtDense, clips.mjs)
const dense = ( options.dense ?? '' ).split( ',' ).filter( Boolean ).map( ( r ) => r.split( '-' ).map( Number ) );
if ( dense.some( ( r ) => r.length !== 2 || r.some( ( x ) => ! Number.isInteger( x ) ) ) ) { console.error( `bad --dense ${ options.dense }` ); process.exit( 2 ); }
// the clip's own crops (clips.mjs `crops`) over the view's
const crops = options.crops ? options.crops.split( ',' ).filter( Boolean ) : clip.crops ?? view.crops ?? [];
const timeout = Number( options.timeout ?? 240000 );
const outDir = path.resolve( options.out ?? path.join( REPO, 'artifacts/clips', name ) );
// the crop box in CSS px (384 device px at a ratio of 2, as the parity crops)
const BOX = 192;

// ------------------------------------------------------------------ PNG (8-bit, non-interlaced)

const CRC = new Int32Array( 256 ).map( ( _, n ) => { let c = n; for ( let k = 0; k < 8; k ++ ) c = c & 1 ? 0xedb88320 ^ ( c >>> 1 ) : c >>> 1; return c; } );
const crc32 = ( buf ) => { let c = - 1; for ( const b of buf ) c = CRC[ ( c ^ b ) & 255 ] ^ ( c >>> 8 ); return ( c ^ - 1 ) >>> 0; };
function chunk( type, data ) {

	const head = Buffer.alloc( 8 ); head.writeUInt32BE( data.length, 0 ); head.write( type, 4, 'latin1' );
	const crc = Buffer.alloc( 4 ); crc.writeUInt32BE( crc32( Buffer.concat( [ head.subarray( 4 ), data ] ) ), 0 );
	return Buffer.concat( [ head, data, crc ] );

}
function encodePng( { width, height, data } ) {

	const ihdr = Buffer.alloc( 13 ); ihdr.writeUInt32BE( width, 0 ); ihdr.writeUInt32BE( height, 4 ); ihdr[ 8 ] = 8; ihdr[ 9 ] = 2;
	const raw = Buffer.alloc( ( width * 3 + 1 ) * height );
	for ( let y = 0; y < height; y ++ ) Buffer.from( data.buffer, data.byteOffset + y * width * 3, width * 3 ).copy( raw, y * ( width * 3 + 1 ) + 1 );
	return Buffer.concat( [ Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ), chunk( 'IHDR', ihdr ), chunk( 'IDAT', zlib.deflateSync( raw, { level: 6 } ) ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] );

}

// 2x2 box filter (rounded to nearest), for gt-hi
function downsample2( { width, height, data } ) {

	const w = width >> 1, h = height >> 1, out = new Uint8Array( w * h * 3 );
	for ( let y = 0; y < h; y ++ ) for ( let x = 0; x < w; x ++ ) for ( let k = 0; k < 3; k ++ ) {

		const i = ( ( 2 * y ) * width + 2 * x ) * 3 + k;
		out[ ( y * w + x ) * 3 + k ] = ( data[ i ] + data[ i + 3 ] + data[ i + width * 3 ] + data[ i + width * 3 + 3 ] + 2 ) >> 2;

	}
	return { width: w, height: h, data: out };

}

// ------------------------------------------------------------------ the page

let query = `debug&paused&t=12&quality=${ quality }&aa=${ gt ? 'msaa' : aa }`;
if ( aa === 'off' ) query += '&msaa=1';
if ( gt ) query += `&dpr=${ GT_RATIO }`;
if ( gtRest ) query += `&tier.taa.gtJitters=${ gtJitters }`;
if ( options.q ) query += `&${ options.q }`;
query += `&${ view.q }`;
if ( clip.q ) query += `&${ clip.q }`;
let base = options.url;
if ( ! base.endsWith( '/' ) && ! base.includes( '?' ) ) base += '/';
const stable = stableOptions( ( k ) => options[ k ] === true ? '' : options[ k ] );
const url = `${ base }?${ query }`;

await mkdir( outDir, { recursive: true } );
const busy = await gpuUtilisation();
const started = Date.now();
await acquireGpuLock( `capture-clip ${ name }`, { shared: true } );
// the browser in its profile slot (one page; gt-hi's fallback relaunches it at another ratio)
let session = null, ready = null;
const errors = [];
let exitCode = 0;
try {

	// gt-hi: its ratio at the CSS size, or (if the canvas cannot hold it) twice the CSS size at the
	// nominal ratio
	let gtFallback = false;
	let page = await open( gt ? GT_RATIO : DSF, 1 );
	if ( gt ) {

		const canvas = await page.evaluate( () => [ window.__PONLAI__.renderer.domElement.width, window.__PONLAI__.renderer.domElement.height ] );
		if ( canvas[ 0 ] !== Math.round( W * GT_RATIO ) ) {

			console.log( `gt-hi: the canvas is ${ canvas.join( 'x' ) }, not ${ W * GT_RATIO } wide; falling back to twice the CSS size at a ratio of ${ NOMINAL_HIGH }` );
			await session.close();
			session = null;
			gtFallback = true;
			page = await open( NOMINAL_HIGH, 2 );

		}

	}
	const cssScale = gtFallback ? 2 : 1, ratio = gt ? ( gtFallback ? NOMINAL_HIGH : GT_RATIO ) : DSF;

	async function open( deviceScaleFactor, cssScale ) {

		session = await launchCapture( { viewport: { width: W * cssScale, height: H * cssScale }, deviceScaleFactor } );
		const p = session.page;
		p.on( 'console', ( m ) => { if ( options.verbose || m.type() === 'error' || m.type() === 'warning' ) errors.push( m.type() + ': ' + m.text() ); } );
		p.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
		await p.goto( url );
		await p.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
		if ( ! ( await p.evaluate( () => typeof window.__PONLAI__.loop.step === 'function' ) ) ) throw new Error( 'this build has no __PONLAI__.loop.step' );
		await p.evaluate( viewEval( viewName, crops ) );
		// ready as capture.mjs is: the image stopped changing after the floor's frames and the loading
		// screen gone (or --ready-frames' fixed count)
		const fixed = options[ 'ready-frames' ] !== undefined ? Number( options[ 'ready-frames' ] ) : null;
		await waitForScene( p, { frames: fixed ?? stable.min, wait: Number( options.wait ?? 0 ), settle: Number( options.settle ?? 0 ), timeout } );
		ready = fixed === null ? await waitForStable( p, { ...stable, timeout } ) : { rule: 'frames', frames: fixed };
		if ( ready.status === 'capped' ) console.log( `unstable: still changing after ${ ready.framesWaited } frames (max ${ ready.maxSeen } levels), stepped at the cap` );
		return p;

	}

	await page.evaluate( clipEval( options.clip, { frames } ) );
	// no film grain in a metric capture; the GT keeps its own fixed ratio (no scale schedule)
	const grain = await page.evaluate( ( gt ) => {

		const s = window.__PONLAI__, settings = s.pipeline?.settings;
		const before = settings && typeof settings.grain === 'number' ? settings.grain : null;
		if ( before !== null ) settings.grain = 0;
		if ( gt && window.__PONLAI_CLIP__.scale ) window.__PONLAI_CLIP__.scale = null;
		// (a temporal page's rest starts over: what the evals changed need not be in its key)
		s.taa?.epoch.bump( 'clip' );
		return before;

	}, gt || gtRest );
	if ( gtRest && ! ( await page.evaluate( () => window.__THREE_GAME_DIAGNOSTICS__?.aa === 'gt' && window.__PONLAI__.taa ) ) ) throw new Error( 'this build has no aa=gt (or it fell back to another mode)' );
	if ( grain === null ) throw new Error( 'this build has no __PONLAI__.pipeline.settings.grain to turn off' );
	const scaleSchedule = clip.scale ? ( gt || gtRest ? 'ignored: the ground truth renders at its fixed ratio' : 'applied' ) : 'none';
	const diagBefore = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	// the anchors' world points at the base pose, then their boxes per frame in CSS px
	const anchors = options[ 'anchors-from' ] ? Object.fromEntries( Object.entries( JSON.parse( await readFile( options[ 'anchors-from' ], 'utf8' ) ).anchors ).filter( ( [ n ] ) => crops.includes( n ) ) ) : await page.evaluate( ( names ) => {

		const all = window.__PONLAI_CROPS__ ?? {};
		return Object.fromEntries( names.map( ( n ) => [ n, all[ n ] ?? { missing: 'no such anchor in this view' } ] ) );

	}, crops );
	const tracked = Object.entries( anchors ).filter( ( [ , a ] ) => a.world ).map( ( [ n, a ] ) => ( { name: n, world: a.world } ) );
	for ( const t of tracked ) await mkdir( path.join( outDir, t.name ), { recursive: true } );
	if ( full.size ) await mkdir( path.join( outDir, 'full' ), { recursive: true } );

	const boxes = [];
	const shoot = async ( clipRect ) => {

		const png = await page.screenshot( { type: 'png', timeout, ...( clipRect ? { clip: clipRect } : {} ) } );
		return gt ? encodePng( downsample2( decodePng( png ) ) ) : png;

	};
	await page.exposeFunction( '__ponlaiClipFrame', async ( i, frameBoxes, time, state ) => {

		const record = { i, time, ...state, boxes: {} };
		for ( const [ n, b ] of Object.entries( frameBoxes ) ) {

			record.boxes[ n ] = b;
			if ( b.missing ) continue;
			await writeFile( path.join( outDir, n, `${ i }.png` ), await shoot( { x: b.x, y: b.y, width: b.w, height: b.h } ) );

		}
		if ( full.has( i ) ) await writeFile( path.join( outDir, 'full', `${ i }.png` ), await shoot( null ) );
		boxes.push( record );

	} );
	const stepped = await page.evaluate( async ( { tracked, every, dense, box, cssScale, fullFrames, gtRest } ) => {

		const s = window.__PONLAI__, clip = window.__PONLAI_CLIP__;
		const V = s.camera.position.constructor;
		const project = ( w ) => {

			const q = new V( w[ 0 ], w[ 1 ], w[ 2 ] ).project( s.camera );
			if ( q.z < - 1 || q.z > 1 ) return null;
			const r = s.renderer.domElement.getBoundingClientRect();
			return [ r.left + ( q.x + 1 ) / 2 * r.width, r.top + ( 1 - q.y ) / 2 * r.height ];

		};
		const b = box * cssScale;
		const t0 = performance.now();
		const before = s.pipelines?.total ?? null;
		const captured = ( i ) => i % every === 0 || fullFrames.includes( i ) || dense.some( ( [ a, b ] ) => i >= a && i <= b );
		const result = await s.loop.step( {
			frames: clip.frames, dt: clip.dt, clock: clip.clock, camera: clip.camera,
			...( clip.scale ? { scale: clip.scale } : {} ),
			// the ground truth: each captured frame held still until the rest has converged on it; a
			// clip of one frame is a rest image, so the other temporal modes wait for their rest too
			...( gtRest || ( s.taa && clip.frames <= 1 ) ? { converge: captured } : {} ),
			onFrame: async ( i ) => {

				if ( ! captured( i ) ) return;
				s.camera.updateMatrixWorld();
				const out = {};
				for ( const t of tracked ) {

					const p = project( t.world );
					if ( ! p ) { out[ t.name ] = { missing: 'behind the camera' }; continue; }
					// whole CSS px, so the device box starts on a whole pixel at any ratio
					const x = Math.round( Math.min( Math.max( p[ 0 ] - b / 2, 0 ), innerWidth - b ) ), y = Math.round( Math.min( Math.max( p[ 1 ] - b / 2, 0 ), innerHeight - b ) );
					out[ t.name ] = { x, y, w: b, h: b, anchor: [ + p[ 0 ].toFixed( 2 ), + p[ 1 ].toFixed( 2 ) ] };

				}
				// what the frame was drawn with, to tell a scene or camera difference from a GPU one
				const hash = ( list ) => { let h = 2166136261; for ( const x of list ) { const b = new Float64Array( [ x ] ), u = new Uint32Array( b.buffer ); h = Math.imul( h ^ u[ 0 ], 16777619 ) >>> 0; h = Math.imul( h ^ u[ 1 ], 16777619 ) >>> 0; } return h.toString( 16 ); };
				const state = { render: [ s.pipeline.width, s.pipeline.height ], view: hash( [ ...s.camera.matrixWorld.elements, ...s.camera.projectionMatrix.elements ] ), frame: s.renderer.info.frame,
					...( s.taa ? { taa: { converged: s.taa.converged, restFrames: s.taa.rest.frames, restTarget: s.taa.rest.target } } : {} ) };
				await window.__ponlaiClipFrame( i, out, s.clockTime(), state );

			},
		} );
		return { ...result, pipelines: before === null ? null : s.pipelines.total - before, wallMs: performance.now() - t0, notes: window.__PONLAI_CLIP_NOTES__ ?? [] };

	}, { tracked, every, dense, box: BOX, cssScale, fullFrames: [ ...full ], gtRest } );
	const diagAfter = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	await writeFile( path.join( outDir, 'clip.json' ), JSON.stringify( {
		name, url, clip: options.clip, clipDef: { ...clip, at: undefined, setup: undefined }, view: viewName, aa, quality, ...( gtRest ? { gtJitters } : {} ),
		viewport: { width: W * cssScale, height: H * cssScale, deviceScaleFactor: ratio }, gtFallback, downsample: gt ? 2 : 1,
		cropPx: gt ? BOX * cssScale * ratio / 2 : BOX * ratio, grain: { was: grain, captured: 0 }, scaleSchedule, frames, every, dense, full: [ ...full ],
		browser: session.version, slot: session.slot, ready, anchors, boxes, stepped, diagBefore, diagAfter, errors,
		wallMinutes: ( Date.now() - started ) / 60000, gpuBusyBefore: busy,
	}, null, 2 ) );
	console.log( `${ outDir }: ${ boxes.length } frames captured of ${ frames }, ${ tracked.length } crops, pipelines while stepping ${ stepped.pipelines }, ${ ( stepped.wallMs / 1000 ).toFixed( 1 ) } s` );
	if ( stepped.notes.length ) console.log( stepped.notes.join( '\n' ) );
	if ( errors.length ) console.log( errors.slice( 0, options.verbose ? 60 : 12 ).join( '\n' ) );
	if ( errors.some( ( e ) => e.startsWith( 'pageerror:' ) || e.startsWith( 'error:' ) ) ) exitCode = 1;

} catch ( error ) {

	console.error( error );
	if ( errors.length ) console.error( errors.slice( 0, 20 ).join( '\n' ) );
	exitCode = 1;

} finally {

	await session?.close();
	releaseGpuLock();

}

const minutes = ( Date.now() - started ) / 60000;
const runs = options.runs ?? process.env.PARITY_RUNS;
if ( runs ) {

	const header = 'date,task,procedure,sha,wall_min,contended,captures,failed,out\n';
	const field = ( s ) => /[",\n]/.test( s ) ? `"${ s.replace( /"/g, '""' ) }"` : s;
	const line = [ new Date( started ).toISOString(), options.task ?? '', `capture-clip ${ options.clip } ${ aa }`, '', minutes.toFixed( 2 ),
		busy === null ? '?' : busy > 15 ? 'y' : 'n', String( frames ), String( exitCode ), outDir ].map( field ).join( ',' ) + '\n';
	await mkdir( path.dirname( path.resolve( runs ) ), { recursive: true } );
	await appendFile( runs, existsSync( runs ) ? line : header + line );

}
process.exitCode = exitCode;
