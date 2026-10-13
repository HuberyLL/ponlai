// First-use pipelines (FU): once the page has loaded (its warm-up and first frames behind it), every
// step a player or the GUI may take should create no render or compute pipeline, since a frame that
// creates one stalls on it. The steps: the first pause and the temporal rest it settles into, scene
// events (a time preset and a weather jump, paused and running), idle frames, the GUI's tone curves
// and looks, the depth of field and grain switched off and on, the camera's modes and views, a
// sweep of the render scale (upscaled and not), a resized window, the time presets, every weather
// (jumped to and changing over seconds), a forced bolt, a pause and the rest after it. The rest and
// the events come first, so the first use of what they draw is counted there. Pipelines are counted
// from WebGPU's device (an init script wraps GPUDevice's create*Pipeline and create*PipelineAsync),
// so any build can be measured the same way, the reference included; each is listed with its label.
// The frame graph's `rebuilds` and the temporal resolve's `historyResets`, where the page's
// diagnostics have them, are reported per step too (both should not move through the scale sweep).
//
//   node tools/verify-first-use.mjs --url <base> [--quality high,medium,low] [--aa msaa,taa,taau,off]
//        [--q "extra&query"] [--steps rest,events,idle,gui,camera,scale,resize,presets,weather,bolt,pause]
//        [--frames 20] [--out file.json] [--compare ref.json] [--strict] [--fresh]
//
// `--quality` and `--aa` take one value or a list: every tier with every mode, each in a fresh page
// (the output JSON is then `{ runs: [ ... ] }`, with a summary table at the end).
// `--steps` also takes `preset:<name>` and `weather:<name>` (a jump to one preset or weather), so a
// load with `--q preset=midnight` and `--steps preset:sunrise` checks the switch from night to day.
// `--compare` reads another run's JSON (the reference build, same options; a run of the same tier
// and mode, or its only run) and judges every step: PASS when it created no pipeline, or no more
// than the reference did. `--strict` exits with 1 on a FAIL. Headless (system Chrome through
// CHROME_PATH, else Playwright's Chromium), under the GPU lock shared with paused captures and
// probes (no timing is measured).
//
// The browser runs in a profile slot of the captures (tools/capture-browser.mjs, launchCapture),
// with this tool's own switches (vsync on), so the island loads from the world cache instead of
// being generated again (task FU: the loaded page 5-7 s after launch instead of 11-14 s under light
// sharing; the world's generation takes a minute under a busy CPU). The cache is per slot and per
// origin, so the first run on a new preview port in a slot still generates. The slot also keeps the
// browser's GPU shader cache (Dawn's), which cannot hide a first-use pipeline from the counts: they
// are the page's create*Pipeline calls, made whether the browser then compiles or finds the
// shader in its cache; only the time a call takes changes. Measured:
// a fresh profile, a warm slot and a slot with its shader caches wiped
// counted the same pipelines with the same labels at load and in every step, the resize step's
// cloud kernels included. `--fresh` loads in a throwaway profile, as the tool did before. The
// matrix's runs share the one browser (a new page each), so its later pages also load from the
// cache. What follows the load stays as it was: the 60 frames, every step's seconds of running,
// the sky's bakes and the counting window of FRAMES + 31 frames are what is measured, not waits to
// shorten. Each run's `wallMs` keeps the time from its new page to the loaded page, to the end of
// the 60 frames, per step and in all.

import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireGpuLock } from './gpu-lock.mjs';
import { launchCapture } from './capture-browser.mjs';

const args = process.argv.slice( 2 );
const opt = ( name, fallback = null ) => {

	const i = args.indexOf( `--${ name }` );
	return i >= 0 && i + 1 < args.length ? args[ i + 1 ] : fallback;

};
const base = opt( 'url' );
if ( ! base ) {

	console.error( 'usage: node tools/verify-first-use.mjs --url <base> [--quality tier] [--aa mode] [--q extra] [--steps list] [--frames n] [--out file] [--compare ref.json] [--strict] [--fresh]' );
	process.exit( 2 );

}
const QUALITIES = opt( 'quality', 'high' ).split( ',' ).filter( Boolean );
const MODES = ( opt( 'aa' ) ?? '' ).split( ',' ).filter( Boolean );
const EXTRA = opt( 'q', '' );
const FRAMES = Math.max( 4, Number( opt( 'frames', 20 ) ) );
const STEPS = ( opt( 'steps', 'rest,events,idle,gui,camera,scale,resize,presets,weather,bolt,pause' ) ).split( ',' ).filter( Boolean );
const OUT = opt( 'out' );
const COMPARE = opt( 'compare' );
const STRICT = args.includes( '--strict' );
const FRESH = args.includes( '--fresh' );
const VIEWPORT = { width: 1280, height: 800 };

// Counts every pipeline the page asks WebGPU for, with its label and the frame it came in.
const COUNTER = `( () => {
	const log = [];
	window.__fuPipelines = log;
	const proto = globalThis.GPUDevice && GPUDevice.prototype;
	if ( ! proto ) return;
	for ( const [ method, kind ] of [ [ 'createRenderPipeline', 'render' ], [ 'createRenderPipelineAsync', 'render' ], [ 'createComputePipeline', 'compute' ], [ 'createComputePipelineAsync', 'compute' ] ] ) {
		const original = proto[ method ];
		if ( typeof original !== 'function' ) continue;
		proto[ method ] = function ( descriptor ) {
			const s = window.__PONLAI__;
			log.push( { kind, async: method.endsWith( 'Async' ), label: descriptor?.label ?? '', at: performance.now(), frame: s?.renderer?.info?.frame ?? -1 } );
			return original.apply( this, arguments );
		};
	}
} )();`;

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

		page.on( 'pageerror', ( e ) => errors.push( `pageerror: ${ e.message }` ) );
		page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( `console: ${ m.text() }` ); } );
		await page.addInitScript( COUNTER );
		await page.goto( result.url );
		await page.waitForFunction( () => window.__PONLAI__?.renderer?.info && document.getElementById( 'loading' )?.classList.contains( 'done' ), null, { timeout: 180000, polling: 'raf' } );
		const ready = ms( t0 );
		// the first frames build what nothing warmed (the world's materials, the shadow maps); the steps
		// count from after them
		await frames( page, 60 );
		const warm = ms( t0 );
		result.load = await page.evaluate( () => {

			const log = window.__fuPipelines;
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
				// what the first frames still built, by label
				firstFrameLabels: log.filter( ( p ) => p.frame === firstFrame ).map( ( p ) => p.label ),
				laterLabels: log.filter( ( p ) => p.frame > firstFrame ).map( ( p ) => `${ p.label } (frame ${ p.frame })` ),
				render: d.render, canvas: d.canvas, upscaled: d.upscaled, quality: d.quality, aa: d.aa ?? null,
				warm: window.__PONLAI__.pipeline?.graph?.warmStats ?? null,
				worldCache: d.worldCache ?? null,
			};

		} );
		result.wallMs = { ready, warm };
		console.log( `loaded ${ result.url }: ${ result.load.total } pipelines (${ result.load.beforeLoop } before the loop, ${ result.load.firstFrame } in the first frame, ${ result.load.later } in the next 60)` );
		for ( const step of STEPS ) {

			const t = performance.now();
			const counted = await measure( page, step );
			counted.wallMs = ms( t );
			result.steps.push( counted );
			const extra = [ ...counted.notes, ...( counted.rebuilds ? [ `graph rebuilds +${ counted.rebuilds }` ] : [] ), ...( counted.historyResets ? [ `history resets +${ counted.historyResets }` ] : [] ) ];
			console.log( `${ step.padEnd( 18 ) } ${ String( counted.render ).padStart( 3 ) } render, ${ String( counted.compute ).padStart( 3 ) } compute${ extra.length ? `  (${ extra.join( '; ' ) })` : '' }` );
			for ( const p of counted.pipelines.slice( 0, 12 ) ) console.log( `                     ${ p.kind } ${ p.label } (frame ${ p.frame })` );

		}

	} finally {

		await page.close();
		if ( result.wallMs ) result.wallMs.total = ms( t0 );

	}
	result.errors = errors;
	if ( errors.length ) console.log( `errors:\n  ${ errors.slice( 0, 20 ).join( '\n  ' ) }` );
	return result;

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
		count: window.__fuPipelines.length,
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
		pipelines: window.__fuPipelines.slice( from ),
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

			// the tone curves, the looks (fantasy ones run the look's glow chain), the depth of field
			// and the grain off and on: each as the GUI sets it
			const done = await page.evaluate( async () => {

				const s = window.__PONLAI__, p = s.pipeline, S = p.settings;
				const wait = ( n ) => new Promise( ( resolve ) => { const end = s.renderer.info.frame + n; const tick = () => s.renderer.info.frame >= end ? resolve() : requestAnimationFrame( tick ); tick(); } );
				const curve = S.toneMapping, look = S.look, dof = S.dof, grain = S.grain;
				for ( const c of [ 'neutral-hue', 'agx-hue', 'agx', 'neutral' ] ) { p.setToneMapping( c ); await wait( 3 ); }
				for ( const l of [ 'realistic', 'soft-fantasy', 'rich-fantasy' ] ) { p.setLook( l ); await wait( 3 ); }
				S.dof = 0; await wait( 3 ); S.dof = dof;
				S.grain = 0; await wait( 3 ); S.grain = grain;
				p.setToneMapping( curve ); p.setLook( look );
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
			// rain and back to the page's weather
			const initial = await page.evaluate( () => window.__PONLAI__.weather.target );
			await page.keyboard.press( 'Space' );
			for ( const [ fn, arg ] of [ [ 'setPreset', 'golden-hour' ], [ 'setWeather', 'rain' ] ] ) {

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
