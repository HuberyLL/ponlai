// Counts the render and compute pipelines a loaded page still creates in each step a player may take.
//
// A frame that creates a pipeline stalls on it, so once the page has loaded (its warm-up and first
// frames behind it) no step a player or the GUI may take should create one (docs/reference/three-behaviour.md,
// Pipeline precompilation). Run it after a change that adds a material, a pass or a kernel, or changes
// when one is built. The frame time itself is measured by tools/render/profile-frame.mjs.
//
// Usage:
//   node tools/render/verify-first-use.mjs --url <base> [--quality high] [--aa msaa,taa,taau,fsr3,off]
//       [--q "extra&query"] [--steps rest,events,wind,idle,gui,camera,scale,resize,presets,pause]
//       [--frames 20] [--out file.json] [--compare ref.json] [--strict] [--fresh]
//   node tools/render/verify-first-use.mjs --url http://127.0.0.1:5191/ --aa msaa,taa,taau,off --quality high,medium,low
//
// Options:
//   --url base     the server to load (required): the dev server or a production preview
//   --quality t    a tier or a list of tiers (default high; medium and low are parked, reached by name)
//   --aa m         an anti-aliasing mode or a list (default: the page's own mode)
//   --q query      extra URL options for every page
//   --steps list   the steps to run, in order (default rest,events,wind,idle,gui,camera,scale,resize,presets,pause);
//                  also weather, bolt, preset:<name> and weather:<name>
//   --frames n     the frames each step's counting window waits beyond its fixed 31 (default 20, at least 4)
//   --out file     writes the results as JSON
//   --compare f    judges every step against another run's JSON (the reference build, same options)
//   --strict       exits 1 on a FAIL
//   --fresh        loads in a throwaway browser profile instead of a capture profile slot
//
// Steps. The load is judged first, as the step `load`: the first frame may build what nothing
// warmed (the world's materials), but no frame of the 60 after it may create a pipeline
// synchronously, nor may the first frame's draws into the sun's shadow map (found by their stack:
// `SunShadow.update`; packages/render/lighting/SunShadow.ts compiles its casters asynchronously and
// draws once they exist, and an asynchronous creation does not stall the frame). Then the steps,
// which count every creation, asynchronous ones included: the first pause and the temporal rest it
// settles into (`rest`), scene events (`events`: a time preset and a jump to clear, paused and
// running), the wind's levels and headings (`wind`: each level jumped to with a turned heading,
// then changes over seconds), idle frames, the GUI's exposure offset moved and back, the camera's
// modes and views, a sweep of the render scale (upscaled and not), a resized window, the time
// presets, and a pause and the rest after it. The rest and the events come first, so the first use
// of what they draw is counted there. `weather` (every weather jumped to and changing over seconds)
// and `bolt` (a forced bolt in a storm) reach the parked weathers (packages/render/sky/Weather.ts
// PARKED_WEATHER) and run only when `--steps` names them. `preset:<name>` and `weather:<name>` jump to
// one preset or weather, so a load with `--q preset=midnight` and `--steps preset:sunrise` checks the
// switch from night to day. The steps' waits are part of what is measured and stay fixed: the 60
// frames, every step's seconds of running, the sky's bakes and the counting window.
//
// Pipelines are counted from WebGPU's device by the shared tracer (tools/render/pipeline-trace.mjs,
// installed before the page runs on GPUDevice's create*Pipeline and create*PipelineAsync), so any
// build can be measured the same way, the reference included; each is listed with its label,
// frame, material, object and stack. The frame graph's `rebuilds` and the temporal resolve's
// `historyResets`, where the page's diagnostics have them, are reported per step too (neither
// should move through the scale sweep).
//
// A list in `--quality` or `--aa` runs every tier with every mode, each in a new page of the one
// browser. `--compare` takes the reference's run of the same tier and mode (or its only run): a
// step passes when it created no pipeline, or no more than the reference did.
//
// Output: on stdout, per run the load's counts and per step the render and compute pipelines (the
// first 12 listed) with the graph's rebuilds and history resets; with `--compare` a verdict per
// step; with several runs a summary table. `--out` writes the results (`{ runs: [ ... ] }` for
// several), each run's `wallMs` with the time to the loaded page, to the end of the 60 frames, per
// step and in all, and its `load` with the labels of the pipelines built before the loop
// (`beforeLoopLabels`) and in the first frame (`firstFrameLabels`), to diff two builds' loads.
//
// GPU lock and browser: takes the GPU lock shared (docs/reference/gpu-lock.md), as paused captures
// and probes do, since it measures no time. It opens headless Chrome (CHROME_PATH, else
// Playwright's Chromium) with vsync on, in a profile slot of the captures
// (tools/kit/capture-browser.mjs `launchCapture`), so the island loads from the world cache. The
// cache is per slot and per origin: the first run on a new preview port in a slot still generates
// the island. The slot's shader cache does not change the counts: they are the page's
// create*Pipeline calls, made whether the browser then compiles or finds the shader in its cache
// (a fresh profile, a warm slot and a slot with its shader caches wiped counted the same pipelines
// with the same labels).
//
// Cost: a page load per run (from the world cache about half the time of a generating load; the
// island's generation takes a minute under a busy CPU), then each step's fixed seconds.
//
// Exit codes: 0 done; 1 a page error or console error in any run, or with `--strict` a FAIL against
// the reference (without `--compare`, any step that created a pipeline); 2 no `--url`.
import '../kit/help.mjs';
import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireGpuLock } from '../kit/gpu-lock.mjs';
import { launchCapture } from '../kit/capture-browser.mjs';
import { installScript } from './pipeline-trace.mjs';
import { installWaitFrames } from '../kit/page-eval.mjs';
import { reviewUrl } from '../kit/page-query.mjs';

const args = process.argv.slice( 2 );
const opt = ( name, fallback = null ) => {

	const i = args.indexOf( `--${ name }` );
	return i >= 0 && i + 1 < args.length ? args[ i + 1 ] : fallback;

};
const base = opt( 'url' );
if ( ! base ) {

	console.error( 'usage: node tools/render/verify-first-use.mjs --url <base> [--quality tier] [--aa mode] [--q extra] [--steps list] [--frames n] [--out file] [--compare ref.json] [--strict] [--fresh]' );
	process.exit( 2 );

}
const QUALITIES = opt( 'quality', 'high' ).split( ',' ).filter( Boolean );
const MODES = ( opt( 'aa' ) ?? '' ).split( ',' ).filter( Boolean );
const EXTRA = opt( 'q', '' );
const FRAMES = Math.max( 4, Number( opt( 'frames', 20 ) ) );
const STEPS = ( opt( 'steps', 'rest,events,wind,idle,gui,camera,scale,resize,presets,pause' ) ).split( ',' ).filter( Boolean );
const OUT = opt( 'out' );
const COMPARE = opt( 'compare' );
const STRICT = args.includes( '--strict' );
const FRESH = args.includes( '--fresh' );
const VIEWPORT = { width: 1280, height: 800 };

// Counts every pipeline the page asks WebGPU for, from its first one: the shared tracer
// (tools/render/pipeline-trace.mjs, probes' `pipelines`) installed before the page runs, on GPUDevice's
// prototype, so each is listed with its label and frame, and with its material, object, target and
// the app's stack once `__PONLAI__` exists.
const COUNTER = installScript( { early: true } );

function pageUrl( quality, aa ) {

	const url = new URL( base );
	url.search = [ url.search.slice( 1 ), 'debug', `quality=${ quality }`, aa ? `aa=${ aa }` : '', EXTRA ].filter( Boolean ).join( '&' );
	return url.href;

}

// (the browser's own frame rate, vsync on: unlike the captures, whose LAUNCH_ARGS turn it off)
const ARGS = [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu' ];
await acquireGpuLock( 'verify-first-use', { shared: true } );
let newPage, close, profile;
if ( FRESH ) {

	const browser = await chromium.launch( {
		headless: true,
		...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
		args: ARGS,
	} );
	newPage = () => browser.newPage( { viewport: VIEWPORT, deviceScaleFactor: 2 } );
	close = () => browser.close();
	profile = 'fresh';

} else {

	const capture = await launchCapture( { viewport: VIEWPORT, deviceScaleFactor: 2, args: ARGS, url: base } );
	newPage = () => capture.context.newPage();
	close = capture.close;
	profile = `slot ${ capture.slot }`;

}
// every tier with every mode, each in a new page (the page's default mode when none is given)
const results = [];
try {

	for ( const quality of QUALITIES ) for ( const aa of MODES.length ? MODES : [ null ] ) results.push( await runOne( quality, aa ) );

} finally {

	await close();

}
if ( OUT ) {

	await mkdir( path.dirname( path.resolve( OUT ) ), { recursive: true } );
	await writeFile( OUT, JSON.stringify( results.length === 1 ? results[ 0 ] : { runs: results }, null, 2 ) );

}
let failed = results.some( ( r ) => r.errors.length > 0 );
if ( COMPARE ) {

	const refJson = JSON.parse( await readFile( COMPARE, 'utf8' ) );
	const refs = refJson.runs ?? [ refJson ];
	for ( const result of results ) {

		const ref = refs.find( ( r ) => r.quality === result.quality && r.aa === result.aa ) ?? ( refs.length === 1 ? refs[ 0 ] : null );
		console.log( `\n${ result.aa } ${ result.quality } against ${ COMPARE }${ ref ? '' : ': no run of that mode and tier' }` );
		if ( ! ref ) {

			failed = true;
			continue;

		}
		console.log( `load: ${ result.load.firstFrame } pipelines in the first frame (reference ${ ref.load?.firstFrame }), ${ result.load.total } in all (reference ${ ref.load?.total })` );
		for ( const s of result.steps ) {

			const r = ref.steps.find( ( x ) => x.step === s.step );
			const n = s.render + s.compute, m = r ? r.render + r.compute : null;
			const verdict = n === 0 ? 'PASS' : m !== null && n <= m ? 'PASS (<= reference)' : 'FAIL';
			if ( verdict === 'FAIL' ) failed = true;
			console.log( `${ s.step.padEnd( 18 ) } ${ String( n ).padStart( 3 ) } vs ${ m === null ? '  -' : String( m ).padStart( 3 ) }  ${ verdict }` );

		}

	}

} else if ( results.some( ( r ) => r.steps.some( ( s ) => s.render + s.compute > 0 ) ) ) failed = true;
if ( results.length > 1 ) {

	console.log( '\nsummary (pipelines per step)' );
	for ( const r of results ) console.log( `${ String( r.aa ).padEnd( 8 ) } ${ r.quality.padEnd( 7 ) } ${ r.steps.map( ( s ) => `${ s.step } ${ s.render + s.compute }` ).join( ', ' ) }${ r.errors.length ? `  (${ r.errors.length } errors)` : '' }` );

}
process.exitCode = results.some( ( r ) => r.errors.length > 0 ) || ( STRICT && failed ) ? 1 : 0;

async function runOne( quality, aa ) {

	const errors = [];
	const result = { url: pageUrl( quality, aa ), quality, aa: aa ?? 'default', frames: FRAMES, profile, load: null, steps: [] };
	const t0 = performance.now();
	const ms = ( t ) => Math.round( performance.now() - t );
	const page = await newPage();
	try {

		await installWaitFrames( page );
		page.on( 'pageerror', ( e ) => errors.push( `pageerror: ${ e.message }` ) );
		page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( `console: ${ m.text() }` ); } );
		await page.addInitScript( COUNTER );
		await page.goto( reviewUrl( result.url ) );
		await page.waitForFunction( () => window.__PONLAI__?.renderer?.info && document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 'raf' } );
		const ready = ms( t0 );
		// the first frame builds what nothing warmed (the world's materials, the shadow maps' nodes);
		// the steps count from after the 60 (the `load` step judges what they built: see the header)
		await frames( page, 60 );
		const warm = ms( t0 );
		result.load = await page.evaluate( () => {

			const log = window.__pipelineTrace.log;
			const firstFrame = Math.min( ...log.filter( ( p ) => p.frame > 0 ).map( ( p ) => p.frame ) );
			const d = window.__THREE_GAME_DIAGNOSTICS__ ?? {};
			return {
				total: log.length,
				beforeLoop: log.filter( ( p ) => p.frame <= 0 ).length,
				firstFrameAt: Number.isFinite( firstFrame ) ? firstFrame : null,
				// the frame the counts start from (60 after the loading screen lifted)
				countedFrom: window.__PONLAI__.renderer.info.frame,
				firstFrame: Number.isFinite( firstFrame ) ? log.filter( ( p ) => p.frame === firstFrame ).length : 0,
				later: log.filter( ( p ) => p.frame > firstFrame ).length,
				// what the load built before the loop, by label and with the material and target three
				// built it for, and what the first frames still built, by label
				beforeLoopLabels: log.filter( ( p ) => p.frame <= 0 ).map( ( p ) => [ p.label, p.material?.name, p.target ].filter( Boolean ).map( ( x ) => typeof x === 'string' ? x : JSON.stringify( x ) ).join( ' ' ) ),
				firstFrameLabels: log.filter( ( p ) => p.frame === firstFrame ).map( ( p ) => p.label ),
				laterLabels: log.filter( ( p ) => p.frame > firstFrame ).map( ( p ) => `${ p.label } (frame ${ p.frame })` ),
				// judged as the `load` step below: what the frames after the first created synchronously,
				// and the first frame's synchronous draws into the sun's map
				loadPipelines: log.filter( ( p ) => ! p.async && ( p.frame > firstFrame || ( p.frame === firstFrame && ( p.stack ?? [] ).some( ( s ) => s.startsWith( 'SunShadow.update ' ) ) ) ) ),
				render: d.render, canvas: d.canvas, upscaled: d.upscaled, quality: d.quality, aa: d.aa ?? null,
				warm: window.__PONLAI__.pipeline?.graph?.warmStats ?? null,
				worldCache: d.worldCache ?? null,
			};

		} );
		result.wallMs = { ready, warm };
		console.log( `loaded ${ result.url }: ${ result.load.total } pipelines (${ result.load.beforeLoop } before the loop, ${ result.load.firstFrame } in the first frame, ${ result.load.later } in the next 60)` );
		const loaded = result.load.loadPipelines;
		delete result.load.loadPipelines;
		const loadStep = {
			step: 'load', render: loaded.filter( ( p ) => p.kind === 'render' ).length, compute: loaded.filter( ( p ) => p.kind === 'compute' ).length,
			pipelines: loaded, rebuilds: null, historyResets: null, notes: [], wallMs: warm - ready,
		};
		report( loadStep );
		for ( const step of STEPS ) {

			const t = performance.now();
			const counted = await measure( page, step );
			counted.wallMs = ms( t );
			report( counted );

		}

	} finally {

		await page.close();
		if ( result.wallMs ) result.wallMs.total = ms( t0 );

	}
	result.errors = errors;
	if ( errors.length ) console.log( `errors:\n  ${ errors.slice( 0, 20 ).join( '\n  ' ) }` );
	return result;

	function report( counted ) {

		const step = counted.step;
		result.steps.push( counted );
		const extra = [ ...counted.notes, ...( counted.rebuilds ? [ `graph rebuilds +${ counted.rebuilds }` ] : [] ), ...( counted.historyResets ? [ `history resets +${ counted.historyResets }` ] : [] ) ];
		console.log( `${ step.padEnd( 18 ) } ${ String( counted.render ).padStart( 3 ) } render, ${ String( counted.compute ).padStart( 3 ) } compute${ extra.length ? `  (${ extra.join( '; ' ) })` : '' }` );
		for ( const p of counted.pipelines.slice( 0, 12 ) ) console.log( `                     ${ p.kind } ${ p.label } (frame ${ p.frame })${ p.object ? ` ${ p.object.type } '${ p.object.name }'` : '' }${ p.material ? ` / ${ p.material.type } '${ p.material.name }'` : '' }` );

	}

}

// ---------------------------------------------------------------- steps

async function frames( page, n ) {

	const start = await page.evaluate( () => window.__PONLAI__.renderer.info.frame );
	await page.waitForFunction( ( target ) => window.__PONLAI__.renderer.info.frame >= target, start + n, { timeout: 60000, polling: 'raf' } );

}

// seconds of running frames (at least `n` frames)
async function run( page, seconds, n = FRAMES ) {

	const until = Date.now() + seconds * 1000;
	await frames( page, n );
	while ( Date.now() < until ) await frames( page, 4 );

}

// the sky's bakes (whole and spread over frames) have landed
async function settled( page ) {

	await page.waitForFunction( () => ! window.__PONLAI__.sky.busy, null, { timeout: 30000, polling: 100 } ).catch( () => undefined );

}

// a paused temporal page's rest has converged (at once without the temporal modes, after a few
// frames); false when it did not within 10 s
async function converged( page ) {

	await frames( page, 4 );
	return page.waitForFunction( () => {

		const taa = window.__PONLAI__.taa;
		return ! taa || taa.converged;

	}, null, { timeout: 10000, polling: 'raf' } ).then( () => true, () => false );

}

async function measure( page, step ) {

	const before = await page.evaluate( () => ( {
		count: window.__pipelineTrace.mark(),
		rebuilds: window.__THREE_GAME_DIAGNOSTICS__?.graph?.rebuilds ?? null,
		resets: window.__THREE_GAME_DIAGNOSTICS__?.taa?.historyResets ?? null,
	} ) );
	const notes = [];
	await apply( page, step, notes );
	await settled( page );
	await frames( page, FRAMES );
	// (the diagnostics refresh every 30 frames)
	await frames( page, 31 );
	const after = await page.evaluate( ( from ) => ( {
		pipelines: window.__pipelineTrace.since( from ),
		rebuilds: window.__THREE_GAME_DIAGNOSTICS__?.graph?.rebuilds ?? null,
		resets: window.__THREE_GAME_DIAGNOSTICS__?.taa?.historyResets ?? null,
	} ), before.count );
	return {
		step,
		render: after.pipelines.filter( ( p ) => p.kind === 'render' ).length,
		compute: after.pipelines.filter( ( p ) => p.kind === 'compute' ).length,
		pipelines: after.pipelines,
		rebuilds: before.rebuilds === null || after.rebuilds === null ? null : after.rebuilds - before.rebuilds,
		historyResets: before.resets === null || after.resets === null ? null : after.resets - before.resets,
		notes,
	};

}

async function apply( page, step, notes ) {

	const [ name, arg ] = step.split( ':' );
	switch ( name ) {

		case 'idle':
			await run( page, 0.5 );
			break;
		case 'gui': {

			// the exposure offset moved and back, as the GUI sets it
			const done = await page.evaluate( async () => {

				const s = window.__PONLAI__, p = s.pipeline, S = p.settings;
				// n of the page's rendered frames (tools/kit/page-eval.mjs WAIT_FRAMES)
				const wait = ( n ) => window.__waitFrames( n );
				const offset = S.exposureOffset;
				S.exposureOffset = offset + 1; await wait( 3 ); S.exposureOffset = offset;
				return true;

			} );
			if ( ! done ) notes.push( 'gui: not applied' );
			await run( page, 0.3 );
			break;

		}
		case 'camera':
			for ( const js of [ "s.setCameraMode( 'free' )", "s.setCameraMode( 'orbit' )", "s.setCameraView?.( 'horizon' )", "s.setCameraView?.( 'sky' )", "s.setCameraView?.( 'island' )" ] ) {

				await page.evaluate( `( () => { const s = window.__PONLAI__; ${ js }; } )()` );
				await run( page, 0.3 );

			}
			break;
		case 'scale': {

			// the render at the canvas's size and below it (upscaled), as the dynamic resolution and
			// the GUI's full resolution set it, then back to the scale the page chose
			const restore = await page.evaluate( () => [ window.__PONLAI__.pipeline.width, window.__PONLAI__.pipeline.height ] );
			for ( const k of [ 1, 0.75, 0.6, 0.9, 1 ] ) {

				await page.evaluate( ( k ) => {

					const s = window.__PONLAI__, c = s.renderer.domElement;
					s.pipeline.setSize( Math.floor( c.width * k ), Math.floor( c.height * k ), c.width, c.height );

				}, k );
				await run( page, 0.25, 8 );

			}
			await page.evaluate( ( [ w, h ] ) => {

				const s = window.__PONLAI__, c = s.renderer.domElement;
				s.pipeline.setSize( w, h, c.width, c.height );

			}, restore );
			await run( page, 0.25, 8 );
			break;

		}
		case 'resize':
			// a smaller window and back (the canvas and every target resized)
			await page.setViewportSize( { width: 1024, height: 700 } );
			await run( page, 0.5 );
			await page.setViewportSize( VIEWPORT );
			await run( page, 0.5 );
			break;
		case 'presets':
			for ( const preset of [ 'midnight', 'dawn', 'sunrise', 'noon', 'golden-hour', 'sunset', 'dusk' ] ) {

				await page.evaluate( ( preset ) => window.__PONLAI__.setPreset( preset ), preset );
				await settled( page );
				await run( page, 0.3 );

			}
			break;
		case 'preset':
			await page.evaluate( ( preset ) => window.__PONLAI__.setPreset( preset ), arg );
			await settled( page );
			await run( page, 1 );
			break;
		case 'weather':
			if ( arg ) {

				await page.evaluate( ( w ) => window.__PONLAI__.setWeather( w, 0 ), arg );
				await settled( page );
				await run( page, 1 );
				break;

			}
			// jumps, then fronts sweeping in over a few seconds (the periodic bakes spread over frames)
			for ( const w of [ 'clear', 'fair', 'cloudy', 'overcast', 'rain', 'storm', 'fog' ] ) {

				await page.evaluate( ( w ) => window.__PONLAI__.setWeather( w, 0 ), w );
				await settled( page );
				await run( page, 0.4 );

			}
			for ( const w of [ 'fair', 'rain', 'storm', 'fog', 'clear' ] ) {

				await page.evaluate( ( w ) => window.__PONLAI__.setWeather( w, 2 ), w );
				await run( page, 2.5 );

			}
			break;
		case 'wind': {

			// the wind's levels jumped to, each from another heading, then changes over seconds and
			// back to the page's wind (a build without levels has no setWind)
			const initial = await page.evaluate( () => window.__PONLAI__.weather.windTarget ?? null );
			if ( ! initial ) { notes.push( 'no wind levels' ); break; }
			for ( const [ level, heading ] of [ [ 'strong', 130 ], [ 'light', 220 ], [ 'fresh', 10 ], [ 'gentle', 80 ] ] ) {

				await page.evaluate( ( wind ) => window.__PONLAI__.setWind( wind, 0 ), { level, heading } );
				await settled( page );
				await run( page, 0.4 );

			}
			for ( const [ level, heading ] of [ [ 'strong', 300 ], [ 'light', 40 ] ] ) {

				await page.evaluate( ( wind ) => window.__PONLAI__.setWind( wind, 2 ), { level, heading } );
				await run( page, 2.5 );

			}
			await page.evaluate( ( wind ) => window.__PONLAI__.setWind( wind, 0 ), initial );
			await settled( page );
			await run( page, 0.5 );
			break;

		}
		case 'bolt': {

			// a strike forced ahead of the camera in a storm, watched for its whole life
			await page.evaluate( () => window.__PONLAI__.setWeather( 'storm', 0 ) );
			await settled( page );
			const ok = await page.evaluate( () => {

				const s = window.__PONLAI__;
				if ( ! s.sky.lightning?.force ) return false;
				const t = 200;
				s.setTime( t );
				const dir = new s.camera.position.constructor();
				s.camera.getWorldDirection( dir );
				s.sky.lightning.force( { start: t + 0.1, azimuth: Math.atan2( dir.z, dir.x ), distance: 2500 } );
				return true;

			} );
			if ( ! ok ) notes.push( 'no lightning.force' );
			await run( page, 2.2 );
			await page.evaluate( () => window.__PONLAI__.sky.lightning?.force?.( null ) );
			break;

		}
		case 'rest':
			// the page's first pause, held until the temporal rest has converged on it (the rest's
			// sequence and its show pass run only then), and the clock running again
			await page.keyboard.press( 'Space' );
			if ( ! await converged( page ) ) notes.push( 'rest: did not converge' );
			await run( page, 0.5, 40 );
			await page.keyboard.press( 'Space' );
			await run( page, 0.5 );
			break;
		case 'events': {

			// scene events while paused (each restarts the rest on the new scene, and the temporal
			// modes cut their history), then the same while running: a time preset, and a jump into
			// clear (the other kept weather: the page loads fair) and back to the page's weather
			const initial = await page.evaluate( () => window.__PONLAI__.weather.target );
			await page.keyboard.press( 'Space' );
			for ( const [ fn, arg ] of [ [ 'setPreset', 'golden-hour' ], [ 'setWeather', 'clear' ] ] ) {

				await page.evaluate( ( [ fn, arg ] ) => fn === 'setWeather' ? window.__PONLAI__.setWeather( arg, 0 ) : window.__PONLAI__.setPreset( arg ), [ fn, arg ] );
				await settled( page );
				if ( ! await converged( page ) ) notes.push( `${ fn } ${ arg }: the rest did not converge` );

			}
			await page.keyboard.press( 'Space' );
			await run( page, 0.5 );
			await page.evaluate( () => window.__PONLAI__.setPreset( 'noon' ) );
			await settled( page );
			await run( page, 0.5 );
			await page.evaluate( ( w ) => window.__PONLAI__.setWeather( w, 0 ), initial );
			await settled( page );
			await run( page, 0.5 );
			break;

		}
		case 'pause':
			await page.keyboard.press( 'Space' );
			await run( page, 1.5, 40 );
			await page.keyboard.press( 'Space' );
			await run( page, 0.5 );
			break;
		default:
			throw new Error( `unknown step '${ step }'` );

	}

}
