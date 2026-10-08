// Frame profiler: plays a matrix of scenes (running clock, fixed weather, a slow camera orbit) in
// headless Chrome with an uncapped frame rate, and reports the frame interval, the GPU time per
// pass (timestamp queries, labelled by `src/debug/FrameProfiler.ts` through `?profile`), the tick's
// JS time, hitches with their cause, and the startup. Runs under the machine-wide GPU lock and
// first checks that nothing else keeps the GPU busy (its results are marked contended otherwise).
//
//   node tools/profile-frame.mjs [url] [--scenes a,b | --scene a] [--w 1920 --h 1080 --scale 2]
//        [--quality high] [--timestamps on|off|both] [--warmup 3] [--seconds 7] [--orbit 3]
//        [--eval "js"] [--repeat n] [--shots] [--detail] [--raw] [--fresh] [--out dir]
//        [--label name] [--q "extra=url&options"] [--hooks off] [--idle-threshold 15] [--idle-wait 60]
//   node tools/profile-frame.mjs --compare urlA urlB [--eval-a "js"] [--eval-b "js"] [--scenes ...]
//   node tools/profile-frame.mjs --report <dir>/profile.json     (re-renders its summary.md)
//   node tools/profile-frame.mjs --list
//
// The reference is a production build (`npm run build && npm run preview`, port 5191, the
// default url); the dev server works for quick checks. The default viewport is a generic 4K
// display (1920x1080 CSS at DPR 2). `--eval` runs in the page for every scene, after its camera
// is placed and before its warm-up, with `s` = window.__SOOMI__: an ablation, for example
// --eval "s.water.mesh.visible = false". `--compare` alternates A B B A per page load and reports
// each scene's deltas against the run-to-run spread; a url's own query options come first, so
// "http://host/?profile=frames" runs that side without timestamps. `--timestamps both` takes a
// scene's frame intervals from a run without GPU timestamps (the rate a player sees) and its
// passes from a run with them. `--hooks off` leaves out ?profile (frame intervals only, as for a
// build without the profiler). `--shots` saves a JPEG of each scene after its measurement,
// `--detail` adds each pass's own time and `--raw` every frame. Chrome comes from CHROME_PATH,
// else the system Chrome, else Playwright's Chromium. Writes <out>/profile.json and
// <out>/summary.md (default artifacts/perf/<label>).
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { withGpuLock, waitForIdleGpu, sampleGpuUtilisation } from './gpu-lock.mjs';

// ------------------------------------------------------------------ options

const argv = process.argv.slice( 2 );
const flags = new Set( argv.filter( ( a ) => a.startsWith( '--' ) ) );
const VALUE_FLAGS = new Set( [ 'report', 'scenes', 'scene', 'w', 'h', 'scale', 'quality', 'warmup', 'seconds', 'orbit', 'eval', 'eval-a', 'eval-b', 'repeat', 'out', 'label', 'q', 'compare', 'idle-wait', 'idle-threshold', 'timestamps', 'hooks' ] );
const opt = ( name, fallback ) => {

	const i = argv.indexOf( '--' + name );
	return i >= 0 ? argv[ i + 1 ] : fallback;

};
const positional = argv.filter( ( a, i ) => ! a.startsWith( '--' ) && ! ( i > 0 && VALUE_FLAGS.has( argv[ i - 1 ].slice( 2 ) ) ) );

// Every scene runs its clock (a paused, still scene settles its clouds once and skips the march
// and the shadow steps, so it under-measures) with fixed weather, the camera moving as in play.
// Scenes sharing a query run in one page load unless --fresh; `change` scenes run last.
export const SCENES = {
	'island-fair-noon': { q: 'weather=fair&preset=noon', view: 'island' },
	'island-clear-golden': { q: 'weather=clear&preset=golden-hour', view: 'island', faceSun: true },
	'horizon-fair-noon': { q: 'weather=fair&preset=noon', view: 'horizon' },
	'sky-cloudy': { q: 'weather=cloudy&preset=noon', view: 'sky' },
	'island-overcast': { q: 'weather=overcast&preset=noon', view: 'island' },
	'island-rain': { q: 'weather=rain&preset=noon', view: 'island' },
	'island-storm': { q: 'weather=storm&preset=noon', view: 'island' },
	'horizon-storm': { q: 'weather=storm&preset=noon', view: 'horizon' },
	'island-fog-dawn': { q: 'weather=fog&preset=dawn', view: 'island' },
	'island-night-clear': { q: 'weather=clear&preset=midnight', view: 'island' },
	// eye height over the meadow near the rim, looking out over the lip
	'meadow-close': { q: 'weather=fair&preset=noon', view: 'meadow' },
	// a front from fair to rain sweeps in during the measurement: pipeline compiles, bakes
	'weather-change': { q: 'weather=fair&preset=noon', view: 'island', change: { weather: 'rain', seconds: 6 } },
};

if ( flags.has( '--list' ) ) {

	for ( const [ name, s ] of Object.entries( SCENES ) ) console.log( name.padEnd( 22 ), s.q, s.view, s.change ? `-> ${ s.change.weather }` : '' );
	process.exit( 0 );

}

const W = Number( opt( 'w', 1920 ) ), H = Number( opt( 'h', 1080 ) ), SCALE = Number( opt( 'scale', 2 ) );
const QUALITY = opt( 'quality', 'high' );
const WARMUP = Number( opt( 'warmup', 3 ) ), SECONDS = Number( opt( 'seconds', 7 ) ), ORBIT = Number( opt( 'orbit', 3 ) );
const REPEAT = Math.max( 1, Number( opt( 'repeat', 1 ) ) );
const EXTRA_Q = opt( 'q', '' );
// GPU timestamps: on (the default: frame intervals and the GPU time per pass), off (frame intervals
// only), or both (each scene twice: its frame intervals from a run without timestamps, its passes
// from one with them). With timestamp queries on, Chrome on an Apple GPU ran the same frames up to
// a quarter faster (light scenes most, a GPU-bound heavy scene hardly at all), so the frame rate a
// player sees is the one without them; their per-pass split stays the reference for where the time
// goes, and A/B deltas in one mode cancel the bias.
const TIMESTAMP_MODE = opt( 'timestamps', 'on' );
if ( ! [ 'on', 'off', 'both' ].includes( TIMESTAMP_MODE ) ) throw new Error( '--timestamps on | off | both' );
// --hooks off: no ?profile, frame intervals only (to check what the hooks cost, or a build without them)
const HOOKS = opt( 'hooks', 'on' ) !== 'off';
// GPU utilisation (%) above which something outside the run is rendering, and how long to wait
// for it to stop before the run (and before each page load) goes on marked as contended
const IDLE_THRESHOLD = Number( opt( 'idle-threshold', 15 ) );
const IDLE_WAIT = Number( opt( 'idle-wait', 60 ) );
// (not again before every load when the run already found the GPU busy for a minute)
let idleWaitLoad = Math.min( IDLE_WAIT, 20 );
const DETAIL = flags.has( '--detail' );
const RAW = flags.has( '--raw' );
const FRESH = flags.has( '--fresh' );
// a JPEG of each scene after its measurement, to see what was measured
const SHOTS = flags.has( '--shots' );
const compareIndex = argv.indexOf( '--compare' );
const COMPARE = compareIndex >= 0 ? [ argv[ compareIndex + 1 ], argv[ compareIndex + 2 ] ] : null;
const URL_A = COMPARE ? COMPARE[ 0 ] : positional[ 0 ] ?? 'http://127.0.0.1:5191/';
const sceneNames = ( opt( 'scenes', opt( 'scene', '' ) ) || Object.keys( SCENES ).join( ',' ) ).split( ',' ).map( ( s ) => s.trim() ).filter( Boolean );
for ( const name of sceneNames ) if ( ! SCENES[ name ] ) throw new Error( `unknown scene ${ name } (--list)` );
const stamp = new Date().toISOString().replace( /[:.]/g, '-' ).slice( 0, 19 );
const LABEL = opt( 'label', COMPARE ? `compare-${ stamp }` : `profile-${ stamp }` );
const OUT = opt( 'out', path.join( 'artifacts/perf', LABEL ) );

const SYSTEM_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH || ( existsSync( SYSTEM_CHROME ) ? SYSTEM_CHROME : undefined );
const CHROME_ARGS = [
	'--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu',
	// uncapped: the frame interval measures the work, not the display's refresh
	'--disable-gpu-vsync', '--disable-frame-rate-limit',
	// unquantised timestamp queries (Chrome rounds them to 100 µs otherwise)
	'--enable-webgpu-developer-features', '--disable-dawn-features=timestamp_quantization',
	'--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows',
];

// ------------------------------------------------------------------ statistics

const sorted = ( values ) => [ ...values ].sort( ( a, b ) => a - b );
function quantile( values, q ) {

	if ( values.length === 0 ) return NaN;
	const s = sorted( values );
	const i = ( s.length - 1 ) * q, lo = Math.floor( i ), hi = Math.ceil( i );
	return s[ lo ] + ( s[ hi ] - s[ lo ] ) * ( i - lo );

}
const mean = ( values ) => values.length ? values.reduce( ( a, b ) => a + b, 0 ) / values.length : NaN;
const r2 = ( x ) => Number.isFinite( x ) ? Math.round( x * 100 ) / 100 : null;

function summarise( frames ) {

	const intervals = frames.map( ( f ) => f.interval );
	const of = ( key ) => frames.map( ( f ) => f[ key ] ).filter( Number.isFinite );
	const stats = ( values ) => ( { median: r2( quantile( values, 0.5 ) ), mean: r2( mean( values ) ), p95: r2( quantile( values, 0.95 ) ), p99: r2( quantile( values, 0.99 ) ), max: r2( values.length ? Math.max( ...values ) : NaN ) } );
	const groups = new Set( frames.flatMap( ( f ) => Object.keys( f.groups ) ) );
	const timed = frames.filter( ( f ) => f.missing === 0 && f.passes > 0 && Object.keys( f.groups ).length );
	const gpuGroups = {};
	for ( const g of groups ) {

		const all = timed.map( ( f ) => f.groups[ g ] ?? 0 );
		const present = timed.filter( ( f ) => g in f.groups ).map( ( f ) => f.groups[ g ] );
		gpuGroups[ g ] = {
			mean: r2( mean( all ) ), p95: r2( quantile( all, 0.95 ) ), max: r2( Math.max( ...all ) ),
			// work that runs on some frames only (bakes, shadow steps): how often, and its cost then
			share: r2( present.length / timed.length ), perRun: r2( mean( present ) ),
		};

	}
	const order = Object.entries( gpuGroups ).sort( ( a, b ) => b[ 1 ].mean - a[ 1 ].mean );
	const detail = {};
	if ( frames.some( ( f ) => f.detail ) ) {

		const keys = new Set( timed.flatMap( ( f ) => Object.keys( f.detail ?? {} ) ) );
		for ( const k of keys ) detail[ k ] = r2( mean( timed.map( ( f ) => f.detail?.[ k ] ?? 0 ) ) );

	}
	const medians = Object.fromEntries( [ ...groups ].map( ( g ) => [ g, quantile( timed.map( ( f ) => f.groups[ g ] ?? 0 ), 0.5 ) ] ) );
	const jsMedian = quantile( of( 'js' ), 0.5 );
	const intervalMedian = quantile( intervals, 0.5 );
	const gpuIntervals = of( 'gpuInterval' );
	const gpuIntervalMedian = quantile( gpuIntervals, 0.5 );
	// A hitch is a frame over 25 ms that also stands out from its neighbours (1.5 times the median),
	// so a scene that is slow throughout reports its slowness, not every frame as a hitch.
	const HITCH = Math.max( 25, intervalMedian * 1.5 ), GPU_HITCH = Math.max( 25, gpuIntervalMedian * 1.5 );
	// GPU hitches, on the GPU's own timeline: a frame whose work finished long after the previous
	// frame's, by the passes that rose most above their medians in that frame. Exact whatever the
	// queue depth (headless Chrome queues about two dozen frames, so a GPU spike reaches the frame
	// interval that much later).
	// A new pipeline compiles in Chrome's GPU process when first used, not in the JS call that
	// creates it: the GPU then idles until the compile is done.
	const gpuHitches = [];
	frames.forEach( ( f, i ) => {

		if ( ! ( f.gpuInterval > GPU_HITCH ) ) return;
		const rises = Object.entries( f.groups ).map( ( [ g, ms ] ) => [ g, ms - medians[ g ] ] ).filter( ( [ , d ] ) => d > 1 ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] );
		const compiled = frames.slice( Math.max( 0, i - 3 ), i + 1 ).reduce( ( a, w ) => a + w.pipelines, 0 );
		const idle = f.gpu < gpuIntervalMedian * 1.2;
		const cause = idle && compiled > 0 ? 'pipeline compile' : idle ? 'gpu idle (waiting for work)' : rises[ 0 ]?.[ 0 ] ?? 'spread over passes';
		gpuHitches.push( { t: r2( ( f.t - frames[ 0 ].t ) / 1000 ), at: f.t, gpuInterval: r2( f.gpuInterval ), gpu: r2( f.gpu ), cause, pipelines: compiled, rises: rises.slice( 0, 3 ).map( ( [ g, d ] ) => `${ g } +${ r2( d ) }` ) } );

	} );
	// Frame hitches: long rAF intervals. The tick's own work shows in its own frame (new pipelines,
	// a long JS tick), work issued after the previous tick (async bakes) in the next interval; a GPU
	// hitch reaches the interval through the queue up to a few seconds later (the largest one in
	// the 2.5 s before is taken as the cause); the rest is the browser's pacing.
	const outsideMedian = quantile( of( 'outsideJs' ), 0.5 );
	const hitches = [];
	frames.forEach( ( f, i ) => {

		if ( f.interval <= HITCH ) return;
		const before = frames[ i - 1 ];
		const outside = before ? before.outsideJs : 0;
		const queued = gpuHitches.filter( ( h ) => h.at <= f.t && h.at > f.t - 2500 ).sort( ( a, b ) => b.gpuInterval - a.gpuInterval )[ 0 ];
		const cause = f.pipelines > 0 && f.js > jsMedian + 4 ? 'pipeline compile' : f.js > jsMedian + 4 ? 'js tick' :
			outside > outsideMedian + 4 ? 'js after the tick (bakes)' : queued ? `${ queued.cause } (via the queue)` : 'pacing';
		hitches.push( { t: r2( ( f.t - frames[ 0 ].t ) / 1000 ), interval: r2( f.interval ), cause, js: r2( f.js ), outsideJs: r2( outside ), gap: r2( f.gap ), pipelines: f.pipelines, pipelineMs: r2( f.pipelineMs ) } );

	} );
	const tally = ( list ) => {

		const causes = {};
		for ( const h of list ) causes[ h.cause ] = ( causes[ h.cause ] ?? 0 ) + 1;
		return causes;

	};
	return {
		frames: frames.length,
		fps: r2( 1000 / mean( intervals ) ),
		interval: stats( intervals ),
		over16: r2( intervals.filter( ( x ) => x > 16.7 ).length / intervals.length ),
		over25: r2( intervals.filter( ( x ) => x > 25 ).length / intervals.length ),
		// GPU busy time per frame (the passes' charges) and the GPU's own frame-to-frame interval
		gpu: stats( timed.map( ( f ) => f.gpu ) ),
		gpuInterval: stats( gpuIntervals ),
		// the GPU's share of the frame: near 1 the frame is GPU-bound
		gpuShare: r2( mean( timed.map( ( f ) => f.gpu ) ) / mean( intervals ) ),
		span: stats( timed.map( ( f ) => f.span ) ),
		// the tick's own JS work, its wall time and the part of it spent blocked in queue.submit
		js: stats( of( 'js' ) ),
		jsWall: stats( of( 'jsWall' ) ),
		submitWait: stats( of( 'submitWait' ) ),
		// JS of the render and compute calls issued after the tick (the sky's bakes) and the gap
		// between ticks
		outsideJs: stats( of( 'outsideJs' ) ),
		gap: stats( of( 'gap' ) ),
		calls: Math.round( mean( frames.map( ( f ) => f.calls ) ) ), triangles: Math.round( mean( frames.map( ( f ) => f.triangles ) ) ),
		passes: Math.round( mean( frames.map( ( f ) => f.passes ) ) ),
		timedFrames: timed.length,
		missingPasses: frames.reduce( ( a, f ) => a + f.missing, 0 ),
		pipelinesCreated: frames.reduce( ( a, f ) => a + f.pipelines, 0 ),
		groups: Object.fromEntries( order ),
		...( Object.keys( detail ).length ? { detail: Object.fromEntries( Object.entries( detail ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ) ) } : {} ),
		hitchThreshold: r2( HITCH ),
		hitches: { count: hitches.length, causes: tally( hitches ), list: hitches.slice( 0, 30 ) },
		gpuHitchThreshold: r2( GPU_HITCH ),
		gpuHitches: { count: gpuHitches.length, causes: tally( gpuHitches ), list: gpuHitches.slice( 0, 30 ).map( ( { at, ...h } ) => h ) },
	};

}

// ------------------------------------------------------------------ the page

async function load( page, base, scene, timestamps ) {

	const url = new URL( base );
	// the url's own options first (the page reads the first of a repeated option), then the
	// scene's; `debug` too, so a build without the profiler still exposes its handles
	const query = [ url.search.slice( 1 ), HOOKS ? timestamps ? 'profile' : 'profile=frames' : '', 'debug', `quality=${ QUALITY }`, SCENES[ scene ].q, EXTRA_Q ].filter( Boolean ).join( '&' );
	url.search = query;
	const started = Date.now();
	await page.goto( url.href );
	await page.waitForFunction( () => window.__SOOMI__ && window.__THREE_GAME_DIAGNOSTICS__?.frame > 30 &&
		document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 250 } );
	const startup = await page.evaluate( () => {

		if ( ! window.__SOOMI_PROFILE__ ) {

			// A build without the profiler: frame intervals only, from a rAF callback of our own (it
			// runs in the same frames as the page's, so it sees the same intervals).
			let done = [], last = 0;
			const step = ( time ) => {

				if ( last ) done.push( { id: 0, t: performance.now(), interval: time - last, js: NaN, jsWall: NaN, submitWait: NaN, outsideJs: NaN, gap: NaN, gpu: NaN, gpuInterval: NaN, span: 0, passes: 0, missing: 0, pipelines: 0, pipelineMs: 0, calls: 0, triangles: 0, groups: {} } );
				last = time;
				requestAnimationFrame( step );

			};
			requestAnimationFrame( step );
			window.__SOOMI_PROFILE__ = {
				reset: () => { done = []; }, take: () => done.splice( 0, done.length ), setDetail: () => {}, setRaw: () => {}, pending: () => 0,
				info: () => ( { timestamps: false, profiler: false, lostPasses: 0, failedPasses: {}, readbackMs: [], marks: {}, startup: { frames: [] } } ),
			};

		}
		const info = window.__SOOMI_PROFILE__.info();
		const d = window.__THREE_GAME_DIAGNOSTICS__;
		return { ...info, diagnostics: { canvas: d.canvas, render: d.render, upscaled: d.upscaled, dpr: d.dpr, canvasDpr: d.canvasDpr, quality: d.quality, timings: d.timings, worldTriangles: d.worldTriangles } };

	} );
	if ( startup.profiler === false ) console.error( `[profile] ${ base } has no ?profile hooks: frame intervals only` );
	return { url: url.href, loadMs: Date.now() - started, startup };

}

async function gpuInfo( page ) {

	return page.evaluate( async () => {

		const a = await navigator.gpu?.requestAdapter( { powerPreference: 'high-performance' } );
		if ( ! a ) return null;
		const { vendor, architecture, device, description } = a.info ?? {};
		return { vendor, architecture, device, description, timestampQuery: a.features.has( 'timestamp-query' ) };

	} );

}

async function setupScene( page, scene, evalJs ) {

	const def = SCENES[ scene ];
	await page.evaluate( ( { def, orbit, evalJs } ) => {

		const s = window.__SOOMI__;
		window.__profileMotion?.stop();
		if ( def.view === 'meadow' ) {

			// a point on the meadow a little inside the rim (from the island mesh's bounds, so any
			// layout works), the eye 1.6 m up, looking out over the lip and down a little
			s.setCameraView( 'island' );
			s.setCameraMode( 'free' );
			const island = s.scene.getObjectByName( 'island' );
			island.geometry.computeBoundingBox();
			const box = island.geometry.boundingBox;
			const cx = ( box.min.x + box.max.x ) / 2, cz = ( box.min.z + box.max.z ) / 2;
			const rx = ( box.max.x - box.min.x ) / 2, rz = ( box.max.z - box.min.z ) / 2;
			const dir = { x: Math.cos( 0.7 ), z: Math.sin( 0.7 ) };
			s.camera.position.set( cx + dir.x * rx * 0.45, box.max.y + 1.6, cz + dir.z * rz * 0.45 );
			s.camera.lookAt( s.camera.position.x + dir.x * 10, s.camera.position.y - 2.2, s.camera.position.z + dir.z * 10 );
			s.camera.fov = 55;
			s.camera.updateProjectionMatrix();

		} else {

			if ( s.cameraSettings.mode !== 'orbit' ) s.setCameraMode( 'orbit' );
			s.setCameraView( def.view );
			if ( def.faceSun ) {

				// orbit to the island's far side from the sun: the view looks into the low sun
				const t = s.controls.target, p = s.camera.position, sun = s.sky.sunDir;
				const dx = p.x - t.x, dz = p.z - t.z, r = Math.hypot( dx, dz ), len = Math.hypot( sun.x, sun.z ) || 1;
				p.x = t.x - sun.x / len * r;
				p.z = t.z - sun.z / len * r;
				s.camera.lookAt( t );
				s.controls.update();

			}

		}
		if ( evalJs ) ( 0, eval )( `( ( s ) => { ${ evalJs } } )` )( s );
		// the slow orbit of play: about the target, or in place for the sky and meadow views
		let last = performance.now(), on = true;
		const inPlace = def.view === 'sky' || def.view === 'meadow';
		const step = ( now ) => {

			if ( ! on ) return;
			const a = orbit * Math.PI / 180 * Math.min( ( now - last ) / 1000, 0.1 );
			last = now;
			const c = Math.cos( a ), si = Math.sin( a );
			if ( inPlace && s.cameraSettings.mode === 'free' ) {

				s.camera.rotateOnWorldAxis( s.camera.up.clone().set( 0, 1, 0 ), a );

			} else {

				const pivot = inPlace ? s.camera.position : s.controls.target;
				const moved = inPlace ? s.controls.target : s.camera.position;
				const x = moved.x - pivot.x, z = moved.z - pivot.z;
				moved.x = pivot.x + x * c - z * si;
				moved.z = pivot.z + x * si + z * c;

			}
			requestAnimationFrame( step );

		};
		requestAnimationFrame( step );
		window.__profileMotion = { stop: () => { on = false; } };

	}, { def, orbit: ORBIT, evalJs } );

}

async function measure( page, scene ) {

	const def = SCENES[ scene ];
	await page.waitForTimeout( WARMUP * 1000 );
	const t0 = await page.evaluate( ( { change, detail, raw } ) => {

		window.__SOOMI_PROFILE__.setDetail( detail );
		window.__SOOMI_PROFILE__.setRaw( raw );
		window.__SOOMI_PROFILE__.reset();
		if ( change ) window.__SOOMI__.setWeather( change.weather, change.seconds );
		return performance.now();

	}, { change: def.change ?? null, detail: DETAIL, raw: RAW } );
	// the GPU's utilisation while measuring: near 100 % the scene keeps it saturated
	const [ utilisation ] = await Promise.all( [ sampleGpuUtilisation( Math.max( SECONDS - 0.5, 0.5 ) ), page.waitForTimeout( SECONDS * 1000 ) ] );
	const t1 = await page.evaluate( () => performance.now() );
	// the last frames' timestamps arrive a few frames later
	await page.waitForFunction( ( t1 ) => window.__SOOMI_PROFILE__.pending( t1 ) === 0, t1, { timeout: 6000, polling: 50 } ).catch( () => {} );
	const frames = ( await page.evaluate( () => window.__SOOMI_PROFILE__.take() ) ).filter( ( f ) => f.t >= t0 && f.t < t1 );
	const info = await page.evaluate( () => {

		window.__profileMotion?.stop();
		const { lostPasses, failedPasses, readbackMs } = window.__SOOMI_PROFILE__.info();
		return { lostPasses, failedPasses, readbackMs };

	} );
	return { frames, info: { ...info, utilisation } };

}

function plan( names ) {

	// page loads: scenes sharing a query share a load (a weather change last), unless --fresh
	const loads = [];
	for ( const name of names ) {

		const q = SCENES[ name ].q;
		const load = ! FRESH && loads.find( ( l ) => l.q === q && ! l.scenes.some( ( s ) => SCENES[ s ].change ) );
		if ( load ) load.scenes.push( name );
		else loads.push( { q, scenes: [ name ] } );

	}
	for ( const l of loads ) l.scenes.sort( ( a, b ) => ( SCENES[ a ].change ? 1 : 0 ) - ( SCENES[ b ].change ? 1 : 0 ) );
	return loads;

}

async function runVariant( page, base, evalJs, log, groups = plan( sceneNames ), shotSuffix = '', timestamps = TIMESTAMP_MODE !== 'off' ) {

	const results = {};
	const loads = [];
	for ( const group of groups ) {

		// between page loads the GPU should be idle: anything rendering now is outside this run
		await page.goto( 'about:blank' );
		await page.waitForTimeout( 1000 );
		const gpuIdle = await waitForIdleGpu( { threshold: IDLE_THRESHOLD, seconds: 2, wait: idleWaitLoad, log } );
		const loaded = await load( page, base, group.scenes[ 0 ], timestamps );
		loads.push( { scenes: group.scenes, loadMs: loaded.loadMs, url: loaded.url, gpuIdle, startup: loaded.startup } );
		const entry = loads[ loads.length - 1 ];
		for ( const scene of group.scenes ) {

			await setupScene( page, scene, evalJs );
			const { frames, info } = await measure( page, scene );
			if ( SHOTS ) await page.screenshot( { path: path.join( OUT, `${ scene }${ shotSuffix }.jpg` ), type: 'jpeg', quality: 70, scale: 'css' } );
			results[ scene ] = { ...summarise( frames ), profiler: info, gpuIdle: gpuIdle.idle?.mean ?? null, contended: gpuIdle.contended };
			if ( RAW ) results[ scene ].raw = frames;
			const r = results[ scene ];
			log( `${ scene.padEnd( 20 ) } [gpu ${ info.utilisation?.mean ?? '?' } %] median ${ r.interval.median } p95 ${ r.interval.p95 } p99 ${ r.interval.p99 } ms  gpu busy ${ r.gpu.median } (gpu interval ${ r.gpuInterval.median } p95 ${ r.gpuInterval.p95 })  js ${ r.js.median } (+ ${ r.submitWait.median } blocked)  frames ${ r.frames }  hitches ${ r.hitches.count } / gpu ${ r.gpuHitches.count }  missing ${ r.missingPasses }  top ${ topGroups( r, 3 ) }` );

		}
		// the startup frames' GPU completions arrive late with a deep queue: read them again now
		if ( entry.startup ) entry.startup.startup = await page.evaluate( () => window.__SOOMI_PROFILE__.info().startup );

	}
	return { scenes: results, loads };

}

// ------------------------------------------------------------------ reports

const fmt = ( x ) => x === null || x === undefined ? '–' : typeof x === 'number' ? x.toFixed( 2 ).replace( /\.?0+$/, '' ) || '0' : x;

function topGroups( r, n = 5 ) {

	return Object.entries( r.groups ).slice( 0, n ).map( ( [ g, v ] ) => `${ g } ${ fmt( v.mean ) }` ).join( ', ' );

}

function markdownProfile( meta, runs ) {

	const lines = [ `# Frame profile: ${ meta.label }`, '', `${ meta.url } at ${ meta.viewport.width }x${ meta.viewport.height } CSS, DPR ${ meta.viewport.scale }, quality ${ meta.quality }; ` +
		`render ${ meta.render ?? '?' }; warm-up ${ meta.warmup } s, ${ meta.seconds } s measured per scene, orbit ${ meta.orbit } deg/s; ` +
		`GPU utilisation before the run ${ meta.gpuIdle?.idle?.mean ?? '?' } %${ meta.gpuIdle?.contended ? ` (CONTENDED: something else was rendering${ meta.gpuIdle.clients?.length ? `: ${ meta.gpuIdle.clients.map( ( c ) => `${ c.name.replace( / \(pid \d+\)/, '' ) } ${ c.percent } %` ).join( ', ' ) }` : '' })` : '' }; GPU timestamps ${ meta.timestamps === 'both' ? 'both (frame intervals without them, passes with them)' : meta.timestamps ? 'on' : 'off' }.`, '',
		'Frame interval in ms (rAF to rAF, uncapped). GPU busy: the time the frame\'s passes add to the GPU\'s timeline (median); ' +
		'GPU p95: the 95th percentile of the GPU\'s own frame-to-frame interval. JS: the tick\'s own work (median), without the time it was ' +
		'blocked in queue.submit while the GPU caught up. Passes: mean GPU ms per frame. Hitches: frames over 25 ms and over 1.5 times the ' +
		'median, as frame intervals (cause: pipeline compile, JS tick, or GPU work through the queue) / on the GPU\'s timeline (cause: the pass ' +
		'that rose most above its median).', '' ];
	runs.forEach( ( run, k ) => {

		if ( runs.length > 1 ) lines.push( `## Run ${ k + 1 }`, '' );
		const both = meta.timestamps === 'both';
		lines.push( `| scene | median | p95 | p99 | max | >16.7 | >25 |${ both ? ' median (timestamps on) |' : '' } GPU busy | GPU p95 | JS | hitches frame / GPU | top passes (mean GPU ms) |`, `|---|---|---|---|---|---|---|${ both ? '---|' : '' }---|---|---|---|---|` );
		for ( const [ scene, r ] of Object.entries( run.scenes ) ) {

			const causes = ( h ) => {

				const list = Object.entries( h.causes ).sort( ( a, b ) => b[ 1 ] - a[ 1 ] ).map( ( [ c, n ] ) => `${ c } ${ n }` ).join( ', ' );
				return `${ h.count }${ list ? ` (${ list })` : '' }`;

			};
			lines.push( `| ${ scene }${ r.contended ? ' (contended)' : '' } | ${ fmt( r.interval.median ) } | ${ fmt( r.interval.p95 ) } | ${ fmt( r.interval.p99 ) } | ${ fmt( r.interval.max ) } | ${ Math.round( r.over16 * 100 ) } % | ${ Math.round( r.over25 * 100 ) } % |${ both ? ` ${ fmt( r.withTimestamps?.interval.median ) } |` : '' } ${ fmt( r.gpu.median ) } | ${ fmt( r.gpuInterval.p95 ) } | ${ fmt( r.js.median ) } | ${ causes( r.hitches ) } / ${ causes( r.gpuHitches ) } | ${ topGroups( r ) } |` );

		}
		lines.push( '' );
		const s = run.loads[ 0 ]?.startup;
		if ( s ) lines.push( `Startup (${ k === 0 ? 'first load, cold shader cache' : 'first load of this run' }): ${ startupLine( s ) }`, '' );
		const warm = run.loads.slice( 1 ).map( ( l ) => l.startup ).filter( Boolean );
		if ( warm.length ) lines.push( `Startup (later loads, median of ${ warm.length }): ${ startupLine( medianStartup( warm ) ) }`, '' );

	} );
	if ( runs.length > 1 ) {

		lines.push( '## Spread between runs (max - min of the run medians)', '', '| scene | median | p95 | p99 | GPU busy |', '|---|---|---|---|---|' );
		for ( const scene of Object.keys( runs[ 0 ].scenes ) ) {

			const spread = ( f ) => {

				const v = runs.map( ( run ) => f( run.scenes[ scene ] ) );
				return `${ fmt( Math.max( ...v ) - Math.min( ...v ) ) } (${ v.map( fmt ).join( ' / ' ) })`;

			};
			lines.push( `| ${ scene } | ${ spread( ( r ) => r.interval.median ) } | ${ spread( ( r ) => r.interval.p95 ) } | ${ spread( ( r ) => r.interval.p99 ) } | ${ spread( ( r ) => r.gpu.median ) } |` );

		}
		lines.push( '' );

	}
	return lines.join( '\n' );

}

// the median of several loads' startups, field by field
function medianStartup( list ) {

	const pick = ( f ) => quantile( list.map( f ).filter( Number.isFinite ), 0.5 );
	const frames = Array.from( { length: 12 }, ( _, i ) => ( {
		interval: pick( ( s ) => s.startup?.frames?.[ i ]?.interval ), wait: pick( ( s ) => s.startup?.frames?.[ i ]?.wait ), done: pick( ( s ) => s.startup?.frames?.[ i ]?.done ),
	} ) );
	return {
		marks: Object.fromEntries( [ 'renderer', 'sky', 'world', 'meshes', 'villagers', 'loop' ].map( ( k ) => [ k, pick( ( s ) => s.marks?.[ k ] ) ] ) ),
		diagnostics: { timings: { total: pick( ( s ) => s.diagnostics?.timings?.total ) } },
		startup: {
			firstFrame: Object.fromEntries( [ 'at', 'js', 'wait', 'pipelines', 'pipelineMs', 'done' ].map( ( k ) => [ k, pick( ( s ) => s.startup?.firstFrame?.[ k ] ) ] ) ),
			frames,
		},
	};

}

function startupLine( s ) {

	const m = s.marks ?? {};
	const f = s.startup?.firstFrame;
	const frames = s.startup?.frames ?? [];
	// frames[ i ].interval: from tick i - 1's start to tick i's
	const next10 = frames.slice( 2, 12 ).reduce( ( a, x ) => a + x.interval, 0 );
	const tickEnd = ( f?.at ?? NaN ) + ( f?.js ?? 0 ) + ( f?.wait ?? 0 );
	return `since navigation: renderer ${ fmt( m.renderer ) } ms, sky lit ${ fmt( m.sky ) }, world ${ fmt( m.world ) } (generation ${ fmt( s.diagnostics?.timings?.total ) } in the worker), ` +
		`meshes ${ fmt( m.meshes ) }, villagers ${ fmt( m.villagers ) }, first tick ${ fmt( f?.at ) }, first frame done on the GPU ${ fmt( f?.done ) }, tenth ${ fmt( frames[ 9 ]?.done ) }. ` +
		`The first tick took ${ fmt( ( f?.js ?? 0 ) + ( f?.wait ?? 0 ) ) } ms (building the materials' shaders; ${ f?.pipelines ?? '?' } pipelines, ${ fmt( f?.pipelineMs ) } ms of it in createRenderPipeline), ` +
		`then the GPU process compiled and ran it for ${ fmt( f?.done - tickEnd ) } ms; the next 10 ticks ${ fmt( next10 ) } ms`;

}

// ------------------------------------------------------------------ main

async function main() {

	await mkdir( OUT, { recursive: true } );
	const label = `profile-frame ${ LABEL }`;
	await withGpuLock( label, async () => {

		const gpuIdle = await waitForIdleGpu( { threshold: IDLE_THRESHOLD, wait: IDLE_WAIT } );
		if ( gpuIdle.contended ) idleWaitLoad = 0;
		console.error( `[profile] GPU idle ${ gpuIdle.idle?.mean ?? '?' } % (max ${ gpuIdle.idle?.max ?? '?' } %)${ gpuIdle.contended ? ', CONTENDED' : '' }; Chrome: ${ executablePath ?? 'Playwright Chromium' }` );
		const browser = await chromium.launch( { headless: true, ...( executablePath ? { executablePath } : { channel: 'chromium' } ), args: CHROME_ARGS } );
		const errors = [];
		try {

			const page = await browser.newPage( { viewport: { width: W, height: H }, deviceScaleFactor: SCALE } );
			page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
			page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( m.text() ); } );
			const version = browser.version();
			const log = ( line ) => console.error( `[profile] ${ line }` );
			const meta = {
				label: LABEL, url: URL_A, viewport: { width: W, height: H, scale: SCALE }, quality: QUALITY, warmup: WARMUP, seconds: SECONDS, orbit: ORBIT,
				chrome: version, args: CHROME_ARGS, gpuIdle, started: new Date().toISOString(), fresh: FRESH, eval: opt( 'eval', '' ), extraQuery: EXTRA_Q,
			};
			if ( ! COMPARE ) {

				const runs = [];
				for ( let k = 0; k < REPEAT; k ++ ) {

					if ( REPEAT > 1 ) log( `run ${ k + 1 } / ${ REPEAT }` );
					const suffix = REPEAT > 1 ? `-run${ k + 1 }` : '';
					if ( TIMESTAMP_MODE === 'both' ) {

						log( 'without timestamps (frame intervals)' );
						const off = await runVariant( page, URL_A, opt( 'eval', '' ), log, plan( sceneNames ), suffix, false );
						log( 'with timestamps (GPU time per pass)' );
						const on = await runVariant( page, URL_A, opt( 'eval', '' ), log, plan( sceneNames ), suffix, true );
						runs.push( mergeModes( off, on ) );

					} else {

						runs.push( await runVariant( page, URL_A, opt( 'eval', '' ), log, plan( sceneNames ), suffix ) );

					}

				}
				const s = runs[ 0 ].loads.find( ( l ) => l.startup?.timestamps )?.startup ?? runs[ 0 ].loads[ 0 ]?.startup;
				meta.timestamps = TIMESTAMP_MODE === 'both' ? 'both' : s?.timestamps;
				meta.render = s?.diagnostics ? `${ s.diagnostics.render.join( 'x' ) } -> ${ s.diagnostics.canvas.join( 'x' ) }${ s.diagnostics.upscaled ? ' (FSR)' : '' }` : null;
				meta.gpu = await gpuInfo( page );
				meta.finished = new Date().toISOString();
				await writeFile( path.join( OUT, 'profile.json' ), JSON.stringify( { meta, runs, errors }, null, 1 ) );
				await writeFile( path.join( OUT, 'summary.md' ), markdownProfile( meta, runs ) );

			} else {

				if ( TIMESTAMP_MODE === 'both' ) log( '--compare runs one mode: timestamps on' );
				// A B B A for each page load's scenes, so a drift of the machine over the run cancels
				const evals = [ opt( 'eval-a', opt( 'eval', '' ) ), opt( 'eval-b', opt( 'eval', '' ) ) ];
				const runs = { A: [], B: [] };
				for ( let k = 0; k < REPEAT; k ++ ) for ( const group of plan( sceneNames ) ) {

					for ( const v of [ 0, 1, 1, 0 ] ) {

						log( `variant ${ 'AB'[ v ] }: ${ COMPARE[ v ] }${ evals[ v ] ? ` eval ${ evals[ v ] }` : '' }` );
						const run = await runVariant( page, COMPARE[ v ], evals[ v ], log, [ group ], `-${ 'AB'[ v ] }` );
						// one entry per repetition, holding every scene
						const list = runs[ 'AB'[ v ] ];
						const slot = list.find( ( r ) => ! Object.keys( r.scenes ).some( ( s ) => group.scenes.includes( s ) ) );
						if ( slot ) { Object.assign( slot.scenes, run.scenes ); slot.loads.push( ...run.loads ); } else list.push( run );

					}

				}
				meta.compare = { A: COMPARE[ 0 ], B: COMPARE[ 1 ], evalA: evals[ 0 ], evalB: evals[ 1 ] };
				meta.finished = new Date().toISOString();
				const report = compareReport( runs );
				await writeFile( path.join( OUT, 'profile.json' ), JSON.stringify( { meta, runs, report, errors }, null, 1 ) );
				await writeFile( path.join( OUT, 'summary.md' ), compareMarkdown( meta, report ) );

			}
			if ( errors.length ) console.error( errors.slice( 0, 10 ).join( '\n' ) );

		} finally {

			await browser.close();

		}

	} );
	console.log( path.join( OUT, 'summary.md' ) );

}

// --timestamps both: a scene's frame intervals (and frame hitches) from the run without timestamps,
// everything else from the run with them, which keeps its own intervals under `withTimestamps`
function mergeModes( off, on ) {

	const scenes = {};
	for ( const [ scene, r ] of Object.entries( on.scenes ) ) {

		const o = off.scenes[ scene ];
		scenes[ scene ] = {
			...r, fps: o.fps, interval: o.interval, over16: o.over16, over25: o.over25, hitchThreshold: o.hitchThreshold, hitches: o.hitches,
			js: o.js, jsWall: o.jsWall, submitWait: o.submitWait, contended: o.contended || r.contended,
			withTimestamps: { fps: r.fps, interval: r.interval, over16: r.over16, over25: r.over25, hitches: r.hitches, js: r.js },
			...( r.raw ? { raw: r.raw, rawWithoutTimestamps: o.raw } : {} ),
		};

	}
	return { scenes, loads: [ ...off.loads.map( ( l ) => ( { ...l, timestamps: false } ) ), ...on.loads.map( ( l ) => ( { ...l, timestamps: true } ) ) ] };

}

function compareReport( runs ) {

	const report = {};
	for ( const scene of Object.keys( runs.A[ 0 ].scenes ) ) {

		const metric = ( f ) => {

			const a = runs.A.map( ( r ) => f( r.scenes[ scene ] ) ), b = runs.B.map( ( r ) => f( r.scenes[ scene ] ) );
			const noise = Math.max( Math.max( ...a ) - Math.min( ...a ), Math.max( ...b ) - Math.min( ...b ) );
			const delta = mean( b ) - mean( a );
			return { a: r2( mean( a ) ), b: r2( mean( b ) ), delta: r2( delta ), noise: r2( noise ), significant: Math.abs( delta ) > noise };

		};
		const groups = new Set( [ ...runs.A, ...runs.B ].flatMap( ( r ) => Object.keys( r.scenes[ scene ].groups ) ) );
		report[ scene ] = {
			median: metric( ( r ) => r.interval.median ), p95: metric( ( r ) => r.interval.p95 ), p99: metric( ( r ) => r.interval.p99 ),
			gpu: metric( ( r ) => r.gpu.median ), js: metric( ( r ) => r.js.median ),
			groups: Object.fromEntries( [ ...groups ].map( ( g ) => [ g, metric( ( r ) => r.groups[ g ]?.mean ?? 0 ) ] ).sort( ( x, y ) => Math.abs( y[ 1 ].delta ) - Math.abs( x[ 1 ].delta ) ) ),
		};

	}
	return report;

}

function compareMarkdown( meta, report ) {

	const lines = [ `# Frame profile compare: ${ meta.label }`, '', `A: ${ meta.compare.A }${ meta.compare.evalA ? ` (eval ${ meta.compare.evalA })` : '' }`, `B: ${ meta.compare.B }${ meta.compare.evalB ? ` (eval ${ meta.compare.evalB })` : '' }`, '',
		`${ meta.viewport.width }x${ meta.viewport.height } CSS, DPR ${ meta.viewport.scale }, quality ${ meta.quality }; A B B A per load; noise = the larger run-to-run spread of A or B; * marks a delta beyond it.`, '',
		'| scene | median A -> B (delta, noise) | p95 | p99 | GPU busy | JS tick | largest pass deltas |', '|---|---|---|---|---|---|---|' ];
	const cell = ( m ) => `${ fmt( m.a ) } -> ${ fmt( m.b ) } (${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) }, ±${ fmt( m.noise ) })${ m.significant ? ' *' : '' }`;
	for ( const [ scene, r ] of Object.entries( report ) ) {

		const passes = Object.entries( r.groups ).slice( 0, 3 ).map( ( [ g, m ] ) => `${ g } ${ m.delta > 0 ? '+' : '' }${ fmt( m.delta ) }${ m.significant ? '*' : '' }` ).join( ', ' );
		lines.push( `| ${ scene } | ${ cell( r.median ) } | ${ cell( r.p95 ) } | ${ cell( r.p99 ) } | ${ cell( r.gpu ) } | ${ cell( r.js ) } | ${ passes } |` );

	}
	return lines.join( '\n' ) + '\n';

}

if ( flags.has( '--report' ) ) {

	// re-render summary.md from a profile.json written earlier (after a change to the report)
	const file = opt( 'report' );
	const data = JSON.parse( await readFile( file, 'utf8' ) );
	const out = path.join( path.dirname( file ), 'summary.md' );
	await writeFile( out, data.report ? compareMarkdown( data.meta, data.report ) : markdownProfile( data.meta, data.runs ) );
	console.log( out );

} else {

	await main();

}
