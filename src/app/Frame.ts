// The page's frame: the canvas's size and the render scale (fixed, dynamic or stepped), the tick,
// the loop that paces it, and the controls a tool holds, resumes and steps it by (`loop`, `step`,
// `setTime`).
// The tick is the order of a frame. It calls the renderer's frame stages (RenderStages.ts
// `createFrameStages`) and the island's (IslandStages.ts `createIslandFrame`) in turn, and does
// the page's own between them: the timer and the frame's deltas, the game's update and its draw,
// the GUI's mirrors of the weather and the wind, the dynamic render scale, the pacer's queue and
// the diagnostics. The order is part of the image: a stage reads what the ones before it wrote in
// the same frame, so a new call goes where its statements belong. The page writes no uniform and
// no cadence of the renderer's here; it sets the scene's pause (`render.paused`, the day clock's)
// and reads the rest.
import { pageStore } from '../PageSettings.ts';
import { DynamicResolution, TAAU_MAX_UPSCALE, GpuFrameTimer, PassScaling, renderScaleKey, FramePacer, PAUSED_QUEUE, gpuDevice, threeAnimation, frameBookkeeping, TEST_MODE, AA_MODE, renderEvent, createFrameStages, type RenderParts } from '../render.ts';
import { settings as params, dynamicRange, renderPixelRatio, outputPixelRatio } from '../renderSetup.ts';
import * as THREE from 'three/webgpu';
import { isCameraInputTarget, createIslandFrame, type IslandParts } from '../island.ts';
import { QualityDetector, qualityLines, rememberQuality } from '../QualityDetect.ts';
import type { PageParts } from './Page.ts';

// Deterministic stepping for the clip tools (tools/capture-clip.mjs; debug builds only): stops the
// live loop and drives the tick itself, `frames` times, `dt` seconds apart, with nothing taken from
// the wall clock. Each frame gets the timestamp t0 + i * dt * 1000 and a delta of exactly `dt`
// (three's Timer would take it from the timestamps less its own start time, which rounds
// differently from load to load), does the node-frame bookkeeping three's animation loop does,
// bypasses the frame pacer and renders at `scale` (a render pixel ratio, as `dpr`; one value, or
// one per frame with the last repeated; the tier's nominal by default) with the dynamic controller
// out of the loop. `camera( i )` runs before frame i's tick and `onFrame( i )` is awaited after it
// (a screenshot then sees that frame: nothing renders until it returns). `clock` pauses or runs the
// scene clock for the clip; left out, it keeps the page's. The loop stays stopped afterwards:
// `loop.start()` brings the live one back.
// What would still follow the wall clock or the page's history is pinned too, so a clip is the
// same however long its frames, its `onFrame` or the wait before it took:
// - a whole sky bake (a seek, a preset, a weather jump) publishes after a GPU readback, so the next
//   frame waits for it (the live loop shows the old sky for a few frames first);
// - the timer that completes a periodic bake spread over frames once the loop stalls is cancelled
//   after each frame, so the bake takes its share of every frame as in a running loop;
// - the clouds pick their trace slot and map refresh phase from the frames rendered since the load
//   (Clouds.ts), and the periodic sky bake and the refracted sun's map count wall-clock seconds
//   that grow while a paused page waits: all three restart with each call, as after a seek;
// - a periodic bake reads its sky irradiance back from the GPU (`Sky.skyIrradiance`, which sets
//   a lightning strike's fill light), landing whenever the GPU answers:
//   stepped, the next frame waits for the value, so it lands on the frame after the bake however
//   long the frames took.
// - `converge( i )` (the temporal modes' ground truth, capture-clip.mjs --aa gt): after frame i's tick
//   the scene is held still (the clock paused, nothing advancing with time: a delta of 0, the sky's
//   transitions and wall-clock cadences included) and rendered again until the temporal rest has
//   converged on it (TemporalRest.ts), so `onFrame( i )` sees frame i's scene averaged over the rest's
//   jitters. The clock and the cadences continue afterwards as if the hold had not happened.
export interface StepOptions {
	frames: number;
	dt?: number;
	scale?: number | number[];
	camera?: ( i: number ) => void;
	onFrame?: ( i: number ) => Promise<void> | void;
	clock?: 'paused' | 'running';
	converge?: ( i: number ) => boolean;
}

/** The canvas's size and the render scale's operations. */
export function createFrameSizing( render: RenderParts, page: PageParts ) {

	const { profiler, qualityTier, quality, renderer, DPR_CAP, resolution, camera, pipeline } = render;
	page.resize = resize;
	page.refreshStoreKey = refreshStoreKey;
	page.applyRenderScale = applyRenderScale;
	page.describeRenderScale = describeRenderScale;
	function resize(): void {

		const w = innerWidth, h = innerHeight;
		page.nominalScale = renderPixelRatio( w, h, quality.render, resolution.full, DPR_CAP );
		// the ground truth renders at the canvas's ratio, every pixel of it
		if ( AA_MODE === 'gt' ) page.nominalScale = outputPixelRatio( page.nominalScale );
		// the dynamic range for this view: from the display's ratio (a pinned one's) down to the floor,
		// its baseline among them
		if ( page.dynamicResolution && page.dynamicRule ) page.dynamicResolution.setRange( dynamicRange( w, h, resolution.full ? page.nominalScale : devicePixelRatio, page.dynamicRule, DPR_CAP ) );
		renderer.setPixelRatio( outputPixelRatio( page.nominalScale ) );
		page.dynamicResolution?.setCanvasRatio( renderer.getPixelRatio() );
		renderer.setSize( w, h );
		camera.aspect = w / h;
		camera.updateProjectionMatrix();
		applyRenderScale( true );
		refreshStoreKey();

	}

	// The key the dynamic scale remembers its scales under (the frame rate's in it): set on a resize and
	// whenever the pacer's rate changes (`generation`).
	page.storeKeyGeneration = NaN;
	function refreshStoreKey(): void {

		page.storeKeyGeneration = page.pacer.generation;
		if ( page.scaleMemory ) page.dynamicResolution?.setStoreKey( renderScaleKey( renderer, qualityTier, AA_MODE, page.pacer.rate, page.canvasSize.x, page.canvasSize.y, page.gpuTimer !== null || profiler?.timestamps === true ? 'gpu' : 'frames' ) );

	}

	/** The scale this frame renders at: the dynamic one, unless pinned or paused. */
	function currentRenderScale(): number {

		if ( page.steppedScale !== null ) return page.steppedScale;
		if ( ! page.dynamicResolution || resolution.full || render.paused ) return page.nominalScale;
		return page.dynamicResolution.scale;

	}

	// Sizes the frame graph to the render scale when it changed (a resize sets the canvas first).
	function applyRenderScale( force = false ): void {

		const ratio = currentRenderScale();
		if ( ! force && ratio === page.renderScale ) return;
		page.renderScale = ratio;
		if ( profiler ) profiler.renderScale = ratio;
		renderer.getDrawingBufferSize( page.canvasSize );
		const w = innerWidth, h = innerHeight;
		// at the display's ratio the render is the canvas, to the pixel, and nothing is upscaled
		const rw = ratio === renderer.getPixelRatio() ? page.canvasSize.x : Math.floor( w * ratio );
		const rh = ratio === renderer.getPixelRatio() ? page.canvasSize.y : Math.floor( h * ratio );
		pipeline.setSize( rw, rh, page.canvasSize.x, page.canvasSize.y );
		page.passScaling?.setSize( rw, rh );
		resolution.render = `${ rw }x${ rh } → ${ page.canvasSize.x }x${ page.canvasSize.y }` + ( pipeline.upscaling || ( pipeline.fsr3 && rw !== page.canvasSize.x ) ? ` (${ Math.round( rw / page.canvasSize.x * 100 ) } %, ${ pipeline.fsr3 ? 'FSR 3' : 'FSR' })` : '' );
		describeRenderScale();

	}

	// The GUI's lines: the scale and how it is set, and (dynamic) the GPU's recent frame time.
	function describeRenderScale(): void {

		const d = page.dynamicResolution;
		const how = ! d ? 'fixed' : resolution.full ? 'pinned' : render.paused ? 'paused' : `${ d.floor }–${ d.max }`;
		resolution.scale = `${ page.renderScale.toFixed( 2 ) } (${ how })`;
		resolution.gpu = d && d.observed.length ? `${ [ ...d.observed ].sort( ( a, b ) => a - b )[ d.observed.length >> 1 ].toFixed( 1 ) } ms` : '–';

	}

}

/** The dynamic resolution, the pacer and the tick. */
export function createFrame( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { profiler, DEBUG, quality, gpuTiming, renderer, DPR_CAP, resolution, dayCycle, weather, sun, pipeline } = render;
	const { framingGlide } = island;
	const { poseIslandView, holdsFraming, followFraming } = page.framing;
	const { qualityChoice, loading, gui, reviewView, setCameraView, environmentLook, frameStats, weatherEffects, weatherView, windView, resize, refreshStoreKey, applyRenderScale, describeRenderScale } = page;
	page.tick = tick;

	// ------------------------------------------------------------------ loop

	// High's render scale is dynamic (DynamicResolution.ts): it starts at its baseline (the nominal:
	// 2K's pixel count, native at 2K output and 1440p at 4K output), moves between the display's ratio
	// and a floor (about 1080p's pixel count) by the GPU's frame time, and renders at the baseline
	// while the scene is paused, so paused frames and captures render at the scale its trade-offs are
	// judged at (pinned, ?dpr or full resolution, at that ratio).
	// (the ground truth renders at the canvas's resolution: no dynamic scale)
	const dynamicRule = 'dynamic' in quality.render && AA_MODE !== 'gt' ? quality.render : null;
	page.dynamicRule = dynamicRule;
	// Under TAAU and FSR 3 the floor rises so the canvas is at most TAAU_MAX_UPSCALE times the render per axis
	// (DynamicResolution.ts).
	const dynamicResolution = dynamicRule ? new DynamicResolution( { ...dynamicRange( innerWidth, innerHeight, devicePixelRatio, dynamicRule, DPR_CAP ), step: dynamicRule.dynamic.step, maxUpscale: AA_MODE === 'taau' || AA_MODE === 'fsr3' ? TAAU_MAX_UPSCALE : Infinity, store: pageStore } ) : null;
	page.dynamicResolution = dynamicResolution;
	// The tier's frame rate is held on a faster display (FramePacer.ts), which then shows each frame for
	// the same number of refreshes, falling back to the next divisor when the dynamic scale's floor
	// cannot hold it. `frameRate=auto` is that default; `frameRate=<fps>` holds a fixed rate (0 renders on
	// every refresh: the profiler's uncapped runs, where the animation frames' intervals measure the
	// work, not a display); `frameFallback=0` keeps 'auto' from falling back (A/B runs). A settings menu
	// sets the rate through the pacer (`choices()`, `setRate()`, `mode`, `fps`): `__PONLAI__.pacer` in
	// debug builds; a production `?game` menu needs the game to be handed the pacer (not wired yet).
	const frameRateParam = params.get( 'frameRate' );
	// (the queue whose completed work bounds a paused page's frames in flight)
	const gpuQueue = gpuDevice<{ queue: { onSubmittedWorkDone(): Promise<void> } }>( renderer ).queue;
	page.gpuQueue = gpuQueue;
	const pacer = new FramePacer( quality.frameRate, {
		rate: frameRateParam === null || frameRateParam === 'auto' ? 'auto' : Number( frameRateParam ),
		allowFallback: params.get( 'frameFallback' ) !== '0',
	} );
	page.pacer = pacer;
	// the render scale each frame was drawn at and its periodic work (by three's frame id), for the
	// GPU times read back later
	const frameScales = new Map<number, { scale: number; heavy: number }>();
	page.gpuTimer = null;
	// A load that measures the GPU for its tier (QualityDetect.ts), set up below once the timer is known.
	page.detector = null;
	// which passes follow the render's pixel count: the GPU time's split into a fixed part and one
	// that follows the scale
	const passScaling = dynamicResolution && gpuTiming ? PassScaling.install( renderer ) : null;
	page.passScaling = passScaling;
	if ( passScaling ) passScaling.graph = pipeline.graph;
	if ( dynamicResolution ) {

		const sample = ( frame: number, ms: number, pixel: number ) => {

			page.detector?.gpu( frame, ms );
			const drawn = frameScales.get( frame );
			if ( drawn !== undefined ) dynamicResolution.sample( ms, drawn.scale, { pixel, heavy: drawn.heavy } );

		};
		// the frame profiler owns the timestamp queries while it times passes
		if ( profiler?.timestamps ) {

			if ( passScaling ) profiler.pixelPass = ( uid ) => passScaling.take( uid );
			profiler.onRecord = ( record ) => { if ( record.missing === 0 && record.passes > 0 ) sample( record.id, record.gpu, record.pixel ); };

		} else if ( passScaling ) {

			page.gpuTimer = GpuFrameTimer.create( renderer, passScaling );
			if ( page.gpuTimer ) page.gpuTimer.onFrame = sample;

		}
		if ( DEBUG ) dynamicResolution.onWarning = ( message ) => console.warn( message );
		// the dynamic scale decides when the pacer falls back to its slower rate and returns
		dynamicResolution.pacer = pacer;

	}

	// The measuring load holds the dynamic scale at its nominal until it is done, and reads the GPU's
	// time from the timer above, or times frames on an idle queue where there is none.
	if ( qualityChoice.source === 'detect' ) {

		const view = () => ( { paused: render.paused, hidden: document.hidden, scale: page.renderScale, interval: pacer.rate > 0 ? pacer.interval : 1000 / 60, width: innerWidth, height: innerHeight, cap: DPR_CAP } );
		page.detector = new QualityDetector( qualityChoice, view, page.gpuTimer !== null || profiler?.timestamps === true, () => gpuQueue.onSubmittedWorkDone(), () => renderer.info.frame );
		if ( dynamicResolution ) dynamicResolution.enabled = false;

	}

	page.canvasSize = new THREE.Vector2();
	// High remembers the scale it held (DynamicResolution.ts), except in an automated browser: a
	// profile or capture would start where the last run on the same origin ended, so its start-up and
	// first decision would depend on run history (QualityDetect.ts skips them for the same reason).
	// `drsStore=on` turns it on there (a returning load's test), `off` turns it off anywhere (neither
	// restored nor saved: an A/B between modes or builds starts both sides from the nominal scale).
	const drsStoreParam = params.get( 'drsStore' );
	page.scaleMemory = drsStoreParam === 'on' || ( drsStoreParam !== 'off' && ! navigator.webdriver );
	page.nominalScale = 1; page.renderScale = 1;
	// the render scale `loop.step` holds for the frame it draws (debug only; null otherwise)
	page.steppedScale = null;

	// a resize of the canvas cuts the history; resize() itself also serves render-scale changes, which do not
	addEventListener( 'resize', () => {

		renderEvent( 'resize' );
		// the island view's framing follows the window's aspect, at once
		const follow = holdsFraming();
		resize();
		poseIslandView( page.framing.viewOptions, island.islandTurned, island.islandZoom );
		if ( follow ) followFraming( false );

	} );
	resize();
	// High starts from the scale it last held on this display, tier and frame rate (remembered in the
	// browser, unless `scaleMemory` is off), and settles from there once its first frames are in; a
	// load that measures the GPU for its tier measures at the nominal scale.
	if ( dynamicResolution && ! page.detector ) {

		dynamicResolution.restore();
		applyRenderScale();

	}

	const clock = new THREE.Timer();
	page.clock = clock;
	clock.connect( document );
	page.frame = 0;
	addEventListener( 'keydown', ( e ) => {

		if ( e.repeat || e.ctrlKey || e.metaKey || e.altKey || isCameraInputTarget( e.target ) ) return;
		if ( e.code === 'Space' ) {

			e.preventDefault();
			// the game pauses its own clock; the sea keeps moving
			if ( page.game ) page.game.togglePause();
			else { render.paused = ! render.paused; dayCycle.paused = render.paused; }
			renderEvent( 'key toggle' );

		}
		if ( e.code === 'KeyH' ) { gui.show( gui._hidden ); renderEvent( 'key toggle' ); }
		if ( e.code === 'KeyR' || e.code === 'Digit1' ) setCameraView( 'island' );
		if ( e.code === 'Digit2' ) setCameraView( 'horizon' );
		if ( e.code === 'Digit3' ) setCameraView( 'sky' );

	} );

	const frameTimes: number[] = [];
	page.frameTimes = frameTimes;
	// The frame's stages: the renderer's (RenderStages.ts `createFrameStages`) and the island's
	// (IslandStages.ts `createIslandFrame`), which the tick calls in turn. The page gives the
	// renderer's what only it knows: its switches, the pacer's interval, the camera's glide and
	// whether the loading screen still covers the canvas.
	let revealed = false;
	const frames = createFrameStages( render, {
		weatherEffects,
		environmentLook,
		interval: () => pacer.target > 0 ? 1000 / pacer.target : 1000 / 60,
		pending( reasons ) {

			if ( framingGlide.running ) reasons.push( 'camera glide' );

		},
		shown() {

			// the loading screen covers the canvas until its fade (index.html) has ended
			if ( ! revealed ) revealed = loading === null || ( loading.classList.contains( 'done' ) && getComputedStyle( loading ).opacity === '0' );
			return revealed;

		},
	} );
	page.frames = frames;
	const islandFrame = createIslandFrame( render, island, { framing: page.framing, view: reviewView } );
	// the sky shows the simulation's hour, whatever else moved the day clock
	const gameHour = () => page.game!.hour();
	function tick( time: number ): void {

		// the frame's own vblank time, not the moment the tick starts: the main thread reaches the tick a
		// few milliseconds into the frame, by a varying amount, which made the scene's steps uneven
		clock.update( time );
		// a jump's explicit bake in flight: no frame, and the clock holds
		if ( frames.held() ) return;
		frameStats.record( time, pacer.interval, pacer.period );
		// The clock never runs backwards. Timer.reset() restarts it at performance.now(): `loop.start()`
		// does so, and so does the timer itself when the page shows again (`connect( document )`). The
		// next animation frame's timestamp (its vblank) can be earlier than that moment, which made its
		// delta negative (DayCycle.advance rejects it); that frame counts as the restart's first, with a
		// delta of 0, whichever reset came before it.
		const rawDt = Math.max( clock.getDelta(), 0 );
		frameTimes.push( rawDt * 1000 );
		if ( frameTimes.length > 120 ) frameTimes.shift();
		const dt = Math.min( rawDt, 1 / 20 );
		// Lighting cadence follows wall time even below 20 FPS. Bound a resumed/stalled frame;
		// the scheduler still submits at most one coalesced bake instead of catching up a queue.
		const environmentDt = Math.min( rawDt, 1 );
		// ?game&paused starts the game paused; once the game runs, so does the scene
		if ( render.paused && page.game && ! page.game.sim.paused ) render.paused = false;
		frames.advanceClock( dt );
		// In the game the simulation's clock sets the pace of the day (and so of the page's weather).
		const clockDt = page.game ? page.game.update( rawDt ) : rawDt;
		islandFrame.grow();
		frames.advanceDay( clockDt, page.game ? gameHour : null );
		weatherView.preset = weather.target;
		const windTarget = weather.windTarget;
		if ( `${ windTarget.level },${ windTarget.heading }` !== page.shownWind ) {

			Object.assign( windView, windTarget );
			page.shownWind = `${ windTarget.level },${ windTarget.heading }`;

		}
		islandFrame.moveCamera( time, dt, rawDt );

		const nightAmbient = frames.trackSky( environmentDt );
		frames.lightNight( islandFrame.night(), nightAmbient );
		islandFrame.tintSward( nightAmbient );
		frames.advanceWeatherAndSea( dt, environmentDt );
		islandFrame.advanceLife( dt );
		frames.relight();
		islandFrame.advanceIslanders( dt );
		page.game?.render( renderer, sun, render.paused ? 0 : rawDt );
		islandFrame.trample( page.game ? page.game.walkers() : null );

		frames.draw( rawDt, dt );
		steerRenderScale( rawDt );
		frames.submit();
		// a paused page in the test mode keeps at most PAUSED_QUEUE frames queued on the GPU
		// (FramePacer.ts, "A paused page's queue")
		const bounded = render.paused && TEST_MODE;
		pacer.queueLimit = bounded ? PAUSED_QUEUE : 0;
		if ( bounded ) pacer.submitted( gpuQueue.onSubmittedWorkDone() );
		page.frame ++;
		page.diagnostics();

	}

	// After the frame's passes: read the GPU times back and move the dynamic scale (it applies from the
	// next frame on). Paused or pinned, the window keeps no samples and the scale holds.
	// whether the last rendered frame steered the scale (false again at a loop start)
	page.steeredLast = false;
	function steerRenderScale( rawDt: number ): void {

		if ( ! dynamicResolution ) return;
		if ( pacer.generation !== page.storeKeyGeneration ) refreshStoreKey();
		// the GPU's budget follows the paced frame interval (a 60 Hz frame unpaced)
		dynamicResolution.setFrameInterval( pacer.rate > 0 ? pacer.interval : 1000 / 60 );
		const steering = page.steppedScale === null && ! render.paused && ! resolution.full && page.renderScale === dynamicResolution.scale;
		frameScales.set( renderer.info.frame, { scale: steering ? page.renderScale : NaN, heavy: frames.periodicWork() } );
		if ( frameScales.size > 240 ) frameScales.delete( frameScales.keys().next().value! );
		page.gpuTimer?.resolve();
		if ( steering ) {

			// an interval since a frame that did not steer (or a loop start) spans the break
			if ( page.steeredLast ) dynamicResolution.sampleInterval( rawDt * 1000 );
			else dynamicResolution.resume();
			dynamicResolution.update();

		}
		page.steeredLast = steering;
		applyRenderScale();
		if ( page.frame % 30 === 0 ) describeRenderScale();

	}

}

/** Starts the frame loop, behind the quality detector's timing when it runs. */
export function startLoop( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { profiler, mark, qualityTier, renderer, resolution, sunShadow, ambientRelight } = render;
	const { growth } = island;
	const { loading, reloadWithQuality, GAME, autoQuality, frameStats, dynamicResolution, pacer, tick } = page;
	mark( 'loop' );
	const measuring = page.detector;
	const loopBody = profiler ? profiler.wrapLoop( tick ) : tick;
	page.loopBody = loopBody;
	const animationLoop = measuring ? ( time: number ) => measuring.frame( loopBody, time ) : loopBody;
	if ( measuring ) measuring.onDone = ( record ) => {

		Object.assign( autoQuality, qualityLines( record?.tier ?? qualityTier, record ? 'measured on this load' : measuring.why, record ) );
		// its frames were drawn at the nominal scale, so the dynamic scale's first decision follows at once
		if ( dynamicResolution ) dynamicResolution.enabled = true;
		// a lower tier reloads into it (from storage, or by ?quality where nothing can be stored)
		const stored = record !== null && rememberQuality( record );
		if ( record && record.tier !== qualityTier ) reloadWithQuality( stored ? null : record.tier );

	};
	dynamicResolution?.begin();
	// three's loop asks the pacer for its animation frames, so the frames it skips never reach it
	const animation = threeAnimation( renderer );
	page.animation = animation;
	animation.setContext( pacer.context );
	renderer.setAnimationLoop( animationLoop );
	renderEvent( 'loop start' );
	// High's first frames find its render scale behind the loading screen: from the nominal it jumps
	// to the scale the GPU's times call for within a second, out of sight (at most REVEAL_WAIT ms).
	// The game's islanders show before it lifts too: their figures arrive after the first frames once
	// their pipelines are compiled (GameView "First draws"), which on a cold shader cache took seconds.
	// So do the sun's shadows: its map draws for the first time once its casters' pipelines exist, a
	// few frames in (SunShadow). And the ambient light: its volume holds zeros until its first relight,
	// once the sky has been projected (AmbientRelight `ready`).
	const REVEAL_WAIT = 3000;
	const revealAt = performance.now() + REVEAL_WAIT;
	const reveal = () => {

		const waiting = ! island.approachWritten || sunShadow.draws === 0 || ! ambientRelight.ready || ( page.detector !== null && ( page.detector.pending || ( page.detector.result !== null && page.detector.result.tier !== qualityTier ) ) ) || ( page.game !== null && ! page.game.ready() ) || dynamicResolution !== null && dynamicResolution.settling && ( page.gpuTimer !== null || profiler?.timestamps === true ) &&
			! render.paused && ! resolution.full && performance.now() < revealAt;
		if ( waiting ) setTimeout( reveal, 50 );
		else {

			// A paused page lifts the loading screen at once, without its fade (index.html): the frame
			// holds still, and the captures and reviews of paused frames shoot it as soon as it is
			// ready, which for a temporal rest is about 40 frames after a view's eval, well inside the
			// second the fade takes. A rest shot so showed up to 2 % of the loading screen's colour over
			// the whole image (a converged rest is the canvas alone: TemporalRest.ts).
			if ( render.paused && loading ) loading.style.transition = 'none';
			loading?.classList.add( 'done' );
			// the counts start where the scene shows
			frameStats.reset();
			// the game's island grows as its people need: its next piece is generated from here on; any
			// other page generates one only once it is asked to grow (Growth.ts)
			if ( GAME ) growth.start();

		}

	};
	reveal();

}

/** The loop's controls for the tools: hold, resume, set the scene clock, step. */
export function createLoopControls( render: RenderParts, page: PageParts ) {

	const { renderer, sky, dayCycle, retuneSky, pipeline } = render;
	const { dynamicResolution, gpuQueue, applyRenderScale, clock, diagnostics, loopBody, animation, frames: stages } = page;
	// set while the loop stands still because the page is hidden (see below)
	let hiddenStop = false;
	// Stops and restarts the frame loop, so the profiler can keep two pages in one browser and time one
	// at a time: stopped, the page requests no frames and leaves the GPU idle once the frames already
	// queued and a sky bake in flight are done (the bake is given 2 s). The clock resumes where it
	// stopped. Chrome let one page's stream of frames starve another's queue, so the profiler stops
	// one page and waits for this before it starts the other.
	const loop = {
		running: true,
		async stop(): Promise<void> {

			hiddenStop = false;
			if ( ! loop.running ) return;
			loop.running = false;
			animation.stop();
			const until = performance.now() + 2000;
			while ( sky.busy && performance.now() < until ) await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
			await gpuQueue.onSubmittedWorkDone();

		},
		start(): void {

			hiddenStop = false;
			if ( loop.running ) return;
			loop.running = true;
			page.steeredLast = false;
			renderEvent( 'loop start' );
			clock.reset();
			animation.start();

		},
	};
	page.loop = loop;
	// A hidden page draws nothing. Browsers stop a hidden tab's animation frames, but an app's embedded
	// browser can keep running them: a page left in a hidden pane rendered at 60 fps and took half the
	// GPU from the page on screen, whose dynamic scale fell to its floor. The loop stops while the
	// document is hidden and starts again when it shows, unless it was stopped or started otherwise
	// meanwhile (the profiler's two pages).
	document.addEventListener( 'visibilitychange', () => {

		if ( document.hidden ) {

			if ( ! loop.running ) return;
			void loop.stop();
			hiddenStop = true;

		} else {

			renderEvent( 'visible' );
			if ( ! hiddenStop ) return;
			loop.start();
			// its first frames (cloud history, a whole bake) do not steer the scale
			dynamicResolution?.begin();

		}

	} );
	page.step = async ( options: StepOptions ): Promise<{ frames: number; t0: number; simTime: number; frameId: number }> => {

		const { frames, dt = 1 / 60, scale, camera: moveCamera, onFrame, clock: clockMode, converge } = options;
		if ( ! Number.isInteger( frames ) || frames < 0 ) throw new RangeError( 'frames must be a whole number, 0 or more' );
		if ( ! Number.isFinite( dt ) || dt <= 0 ) throw new RangeError( 'dt must be finite and positive' );
		const scales = scale === undefined ? [] : Array.isArray( scale ) ? scale : [ scale ];
		if ( scales.some( ( s ) => ! Number.isFinite( s ) || s <= 0 ) ) throw new RangeError( 'scale must be positive' );
		await loop.stop();
		if ( clockMode !== undefined ) {

			render.paused = clockMode === 'paused';
			dayCycle.paused = render.paused;

		}
		const bookkeeping = frameBookkeeping( renderer );
		const timer = clock as unknown as { update( time?: number ): unknown; getDelta(): number };
		timer.update = () => timer;
		timer.getDelta = () => dt;
		const skyBake = sky as unknown as { slices: unknown[]; sliceTimer: ReturnType<typeof setTimeout> | null; pendingUpdate: Promise<void> | null };
		// the sky irradiance readbacks in flight, if any, have landed (each resolves once the GPU
		// answers; a map is not expected to take seconds, so a hang is reported rather than waited out)
		const settleSkyReadback = async (): Promise<void> => {

			const start = performance.now();
			while ( sky.readbacks > 0 ) {

				if ( performance.now() - start > 10000 ) throw new Error( 'loop.step: the sky irradiance readback did not land within 10 s' );
				await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

			}

		};
		await settleSkyReadback();
		stages.restartCadences();
		const t0 = Math.round( performance.now() );
		try {

			// one tick of the loop at `time`, with the bookkeeping three's animation loop does around it
			const tickAt = async ( time: number ): Promise<void> => {

				// an explicit bake in flight holds the loop (`bakeExplicitly`), so its tick would draw
				// nothing: start a retune's (`retuneSky`), wait for the bakes queued, and refuse a scene
				// jump still on its way to one
				retuneSky();
				await render.sunUpdates.catch( () => {} );
				if ( render.jumpsInFlight > 0 ) throw new Error( 'loop.step: a scene jump is in flight; await establishScene before stepping' );
				// three's Animation does this before each frame of its loop
				bookkeeping.begin();
				// (the frame's size follows `steppedScale` from this tick's start: applyRenderScale)
				applyRenderScale();
				loopBody( time );
				bookkeeping.end();
				if ( skyBake.sliceTimer !== null ) {

					clearTimeout( skyBake.sliceTimer );
					skyBake.sliceTimer = null;

				}
				await settleSkyReadback();

			};
			for ( let i = 0; i < frames; i ++ ) {

				if ( sky.busy && skyBake.slices.length === 0 ) await skyBake.pendingUpdate?.catch( () => {} );

				// never above the canvas's ratio: the render would outgrow the canvas it is shown on
				const ratio = scales.length ? scales[ Math.min( i, scales.length - 1 ) ] : page.nominalScale;
				page.steppedScale = Math.min( ratio, renderer.getPixelRatio() );
				moveCamera?.( i );
				await tickAt( t0 + i * dt * 1000 );
				const temporal = pipeline.resolver;
				if ( temporal && converge?.( i ) ) {

					// hold the frame's scene still until the rest has converged on it
					const release = stages.holdStill();
					timer.getDelta = () => 0;
					try {

						for ( let k = 0; k < temporal.rest.target + 4 && ! temporal.converged; k ++ ) {

							if ( sky.busy && skyBake.slices.length === 0 ) await skyBake.pendingUpdate?.catch( () => {} );
							await tickAt( t0 + i * dt * 1000 );

						}

					} finally {

						timer.getDelta = () => dt;
						release();

					}
					if ( ! temporal.converged ) console.warn( `loop.step: frame ${ i } did not converge (the rest's ${ temporal.rest.frames } of ${ temporal.rest.target } frames)` );

				}
				await onFrame?.( i );

			}

		} finally {

			delete ( timer as Partial<typeof timer> ).update;
			delete ( timer as Partial<typeof timer> ).getDelta;
			page.steppedScale = null;
			applyRenderScale();
			diagnostics( true );

		}
		return { frames, t0, simTime: render.simTime, frameId: renderer.info.frame };

	};

}
