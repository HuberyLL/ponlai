// The page's frame: the canvas's size and the render scale (fixed, dynamic or stepped), the tick
// that advances the scene clock, the day, the weather, the wind and everything that follows them,
// then renders, the loop that paces it, and the controls a tool holds, resumes and steps it by
// (`loop`, `step`, `setTime`).
import { pageStore } from '../PageSettings.ts';
import { settings as params, nightAmbientShare, duskForce, yunpengNightShare, cloudedShare, updateLeafLight, type HazeFrame, dynamicRange, renderPixelRatio, outputPixelRatio, DynamicResolution, TAAU_MAX_UPSCALE, GpuFrameTimer, PassScaling, renderScaleKey, PeriodicWork, FramePacer, PAUSED_QUEUE, gpuDevice, threeAnimation, frameBookkeeping, shared, ambientGrade, TEST_MODE, AA_MODE, AFTER_RESOLVE, TEMPORAL, preExposure, PRE_EXPOSURE_PENDING, sceneEvent, type TemporalFrame, type SettleFrame, prepassScene, opaquePrepassScene, type RenderParts } from '../render.ts';
import * as THREE from 'three/webgpu';
import { isCameraInputTarget, setYunpengNight, updateSwardTint, type IslandParts } from '../island.ts';
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

	const { profiler, DEBUG, quality, gpuTiming, renderer, submitBatch, DPR_CAP, resolution, scene, waterScene, rainScene, afterScene, camera, sky, dayCycle, weather, weatherEffects, wind, lighting, applyEnvironmentFill, sun, sunShadow, shadowDirection, prepareHaze, prepareSkyState, publishLighting, retuneSky, fft, waveMaps, pipeline, groundBounce, shoreWaves, ambientRelight, refractedSun, stormSea } = render;
	const { controls, framingGlide, islandTurn, freeControls, trample, wenyao, growth, poseIslandView, holdsFraming, followFraming } = island;
	const { qualityChoice, loading, gui, S, reviewView, setCameraView, environmentLook, frameStats, weatherView, windView, resize, refreshStoreKey, applyRenderScale, describeRenderScale } = page;
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

		sceneEvent( 'resize' );
		// the island view's framing follows the window's aspect, at once
		const follow = holdsFraming();
		resize();
		poseIslandView( island.islandViewOptions, island.islandTurned, island.islandZoom );
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
			sceneEvent( 'key toggle' );

		}
		if ( e.code === 'KeyH' ) { gui.show( gui._hidden ); sceneEvent( 'key toggle' ); }
		if ( e.code === 'KeyR' || e.code === 'Digit1' ) setCameraView( 'island' );
		if ( e.code === 'Digit2' ) setCameraView( 'horizon' );
		if ( e.code === 'Digit3' ) setCameraView( 'sky' );

	} );

	const frameTimes: number[] = [];
	page.frameTimes = frameTimes;
	page.shadowElapsed = 0;
	// The temporal resolve's per-frame inputs (TemporalAA.ts): what besides the camera, the clock and the
	// sizes keys a paused scene's rest (a forced strike: a review sets one while paused, and the rest
	// starts over for it), whether the frame may rest (not while a sky bake is in flight or a sky
	// transition runs, unless `loop.step` holds the frame still: see `holding`), and its delta.
	let strikeKey = 'null', strikeVersion = 0;
	// set while `loop.step` holds a frame for the rest to converge (nothing advances, a transition included)
	page.holding = false;
	function strikeSignature(): number {

		const forced = JSON.stringify( ( sky.lightning as unknown as { forced: unknown } ).forced ?? null );
		if ( forced !== strikeKey ) {

			strikeKey = forced;
			strikeVersion ++;

		}
		return strikeVersion;

	}
	const restStable = () => ! sky.busy && ( ! sky.transitioning || page.holding );
	function temporalFrame( dt: number, step: number ): TemporalFrame | undefined {

		if ( ! pipeline.resolver ) return undefined;
		// (FSR 3's frame time: the scene clock's step, the pacer's nominal interval while paused)
		// The temporal rest starts once the haze's has ended, so it averages frames of the finished haze.
		return { signature: [ strikeSignature() ], stable: restStable() && ! pipeline.air.pending, dt, step, interval: pacer.target > 0 ? 1000 / pacer.target : 1000 / 60 };

	}
	// The haze's rest (weather/VolumetricHaze.ts): the temporal rest's signature and the sun maps' redraw
	// counts (a redraw changes its shadow without changing the key), and whether the frame may rest.
	function hazeFrame(): HazeFrame {

		return { time: render.simTime, signature: [ strikeSignature(), sunShadow.draws, refractedSun.draws ], stable: restStable() };

	}
	// The settled signal's inputs (post/Settled.ts; debug builds): the rest's, the sun maps' redraw
	// counts, and what will still change the frame without changing the key.
	let revealed = false;
	function settleFrame( bakeDue: boolean ): SettleFrame | undefined {

		if ( ! DEBUG ) return undefined;
		const pending: string[] = [];
		if ( bakeDue ) pending.push( 'sky bake due' );
		if ( sky.readbacks > 0 ) pending.push( 'sky irradiance' );
		if ( refractedSun.pending ) pending.push( 'refracted sun' );
		if ( framingGlide.running ) pending.push( 'camera glide' );
		if ( sunShadow.pending ) pending.push( 'sun shadow' );
		if ( pipeline.air.pending ) pending.push( 'haze rest' );
		if ( pipeline.exposurePending ) pending.push( 'exposure' );
		if ( preExposure.pending ) pending.push( PRE_EXPOSURE_PENDING );
		if ( ! ambientRelight.ready ) pending.push( 'ambient relight' );
		// the loading screen covers the canvas until its fade (index.html) has ended
		if ( ! revealed ) revealed = loading === null || ( loading.classList.contains( 'done' ) && getComputedStyle( loading ).opacity === '0' );
		return { signature: [ strikeSignature(), sunShadow.draws, refractedSun.draws ], stable: restStable(), pending, shown: revealed };

	}
	function tick( time: number ): void {

		// the frame's own vblank time, not the moment the tick starts: the main thread reaches the tick a
		// few milliseconds into the frame, by a varying amount, which made the scene's steps uneven
		clock.update( time );
		// a jump's explicit bake in flight: no frame, and the clock holds (`bakeExplicitly`); a retune
		// starts one (`retuneSky`)
		if ( render.jumpsInFlight > 0 || retuneSky() ) return;
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
		if ( ! render.paused ) render.simTime += dt;
		// In the game the simulation's clock sets the pace of the day (and so of the page's weather).
		const clockDt = page.game ? page.game.update( rawDt ) : rawDt;
		// the island's growth: a swap, or one of the frames after it (before the camera and the shadows)
		growth.update( render.simTime );
		dayCycle.advance( clockDt );
		// the sky shows the simulation's hour, whatever else moved the day clock
		if ( page.game ) dayCycle.setHour( page.game.hour() );
		weather.update( render.paused ? 0 : clockDt );
		weatherView.preset = weather.target;
		const windTarget = weather.windTarget;
		if ( `${ windTarget.level },${ windTarget.heading }` !== page.shownWind ) {

			Object.assign( windView, windTarget );
			page.shownWind = `${ windTarget.level },${ windTarget.heading }`;

		}
		if ( freeControls.enabled ) freeControls.update( rawDt );
		else {

			// the glide to a grown land's framing (finished at once if the page was paused meanwhile)
			if ( framingGlide.advance( render.paused ? Infinity : dt, camera.position, controls.target ) ) camera.lookAt( controls.target );
			// a turn or zoom of the island view: the framing at the new heading and zoom, taken at once
			islandTurn.enabled = controls.enabled && ! controls.handInput && reviewView.camera === 'island';
			const turn = islandTurn.advance( dt ), zoom = THREE.MathUtils.clamp( island.islandZoom + islandTurn.zoom( dt ), 0, 1 );
			if ( zoom === 0 || zoom === 1 ) islandTurn.stopZoom();
			if ( turn !== 0 || zoom !== island.islandZoom ) {

				poseIslandView( island.islandViewOptions, island.islandTurned + turn, zoom );
				followFraming( false );

			}
			controls.advance( dt, time );

		}

		renderer.info.reset();
		// Sun, moon, key light and grade follow the clock every frame; only the baked reflection,
		// environment and cloud products cross-fade between bakes.
		sky.track( render.manualSun ? null : dayCycle.snapshot(), weather.state, render.cloudOverride, weather.skyMix );
		sky.advance( environmentDt );
		publishLighting();
		// the ambient grade by the sun and the weather's blend of the four skies (lighting/AmbientGrade.ts)
		ambientGrade.update( sky.elevation, weather.skyMix, sky.rising, sky.moonElevation, sky.moonKeyShare );
		shared.clouded.value = cloudedShare( weather.skyMix );
		// the yunpeng's glow and its local lights by their own share of the night (sky/DayCycle.ts
		// `yunpengNightShare`; lighting/LocalLights.ts: its pass sorts the sources in view), the leaves'
		// night key and the sward's by the night ambient's (`nightAmbientShare`); a debug page may force
		// each reader's (DayCycle.ts `duskForce`)
		const nightAmbient = nightAmbientShare( sky.elevation, sky.rising, shared.clouded.value );
		const yunpengShare = setYunpengNight( duskForce( 'yunpeng', yunpengNightShare( sky.elevation, sky.rising, shared.clouded.value ) ) );
		render.localLights.update( duskForce( 'localLights', yunpengShare ) );
		// what the crowns' leaves pass on of the key (world/vegetation/LeafLight.ts)
		updateLeafLight( sky.elevation, duskForce( 'nightAmbient', nightAmbient ), shared.clouded.value );
		// what a closed sky's light turns into in the sward (materials/SwardTint.ts)
		updateSwardTint( shared.swardTint.value, shared.clouded.value, duskForce( 'nightAmbient', nightAmbient ) );
		prepareHaze( weather.state );
		pipeline.air.keyDir.value.copy( sky.keyDir );
		pipeline.air.keyColor.value.copy( sky.keyColor ).multiplyScalar( 1 - THREE.MathUtils.smoothstep( sky.clouds.coverage.value, 0.7, 0.97 ) );
		pipeline.shafts.setSun( sky.sunDir, sky.sunColor );
		pipeline.shafts.setMoon( sky.moonDir, sky.keyColor, sky.keyIsMoon );
		wind.update( render.paused ? 0 : dt, weather.state.windSpeed, weather.state.windDirection, weather.state.gustiness );
		// Lightning follows the scene clock, so a paused frame holds its strike; it lights the clouds'
		// march below, so it goes first.
		// (the scene's render size: the canvas is larger while the frame is upscaled)
		sky.lightning.update( render.simTime, weather.state.storm, camera, pipeline.height, sky.clouds );
		sky.updateClouds( camera, pipeline.width, pipeline.height, shared.wind.direction.value, render.simTime );
		shared.rain.value = weatherEffects.rain ? sky.weather.rain : 0;
		shared.storm.value = weather.state.storm;
		// A strike lights the island for an instant through the sky's fill: the lit cloud deck adds its
		// radiance to the sky's, so a flash that barely shows by day floods a dark night.
		const skyLuma = sky.skyIrradiance.r * 0.2126 + sky.skyIrradiance.g * 0.7152 + sky.skyIrradiance.b * 0.0722;
		const strikeFill = lighting.skyFill * Math.min( 1 + sky.lightning.fill / Math.max( skyLuma, 1e-5 ), 60 );
		applyEnvironmentFill( strikeFill );
		shared.skyFill.value = strikeFill;
		shared.skyIrradiance.value.set( sky.skyIrradiance.r, sky.skyIrradiance.g, sky.skyIrradiance.b ).multiplyScalar( strikeFill );
		// the page's own wetness, in the game too (soaking and drying on the day clock)
		shared.wetness.value = weatherEffects.wetness ? weather.state.wetness : 0;
		fft.setWind( wind.speed, wind.heading );
		render.rain!.uniforms.rain.value = shared.rain.value;
		render.rain!.uniforms.wind.value.copy( shared.wind.velocity.value );
		render.rain!.uniforms.waterLevel.value = shared.waterLevel.value;
		render.rain!.update( renderer, camera, render.simTime, shared.wind.displacement.value, pipeline.height, AFTER_RESOLVE ? pipeline.outputHeight : pipeline.height );
		if ( ! render.manualSun && environmentLook.exposure ) {

			S.exposure = sky.grade.exposure;
			// the night's grade (Pipeline NIGHT)
			S.night = sky.grade.night;
			// the exposure's own night weight (its keys: look/ExposureLook.ts)
			S.exposureNight = sky.grade.exposureNight;

		}
		// the weather's stops of the exposure and the clouded day's keys (Pipeline `skyMix`)
		const skyMix = weather.skyMix;
		for ( let i = 0; i < skyMix.length; i ++ ) S.skyMix[ i ] = skyMix[ i ];
		render.skyElapsed += environmentDt;
		const skyInterval = render.runtimeQuality.skyUpdateInterval;
		const ws = weather.state;
		const weatherSignature = `${ render.cloudOverride ?? ws.coverage },${ ws.density },${ ws.directVisibility },${ ws.ambientGain },${ ws.daySky },${ ws.daySkyExponent },${ ws.haze }`;
		if ( ! sky.busy && ! sky.transitioning && render.skyElapsed >= skyInterval &&
			( render.simTime !== render.lastSkyTime || weatherSignature !== render.lastWeatherSignature || ( ! render.manualSun && dayCycle.hour !== render.lastSkyHour ) ) ) {

			render.skyElapsed = 0;
			render.lastSkyTime = render.simTime;
			render.lastSkyHour = dayCycle.hour;
			prepareSkyState();
			void sky.update( skyInterval ).catch( ( error: unknown ) => console.error( error ) );

		}
		// a periodic bake waits for its interval (the settled signal waits for it too)
		const bakeDue = ! sky.busy && ( render.simTime !== render.lastSkyTime || weatherSignature !== render.lastWeatherSignature || ( ! render.manualSun && dayCycle.hour !== render.lastSkyHour ) );
		// The sun's map steps with the key light and cross-fades between steps, so its shadows move
		// smoothly without re-rasterising sub-texel casters every frame; it is drawn along the lifted
		// key. The underwater map keeps the quality cadence.
		sunShadow.update( renderer, scene, camera, shadowDirection );
		page.shadowElapsed += environmentDt;
		if ( page.shadowElapsed >= render.runtimeQuality.refractedSun.interval && refractedSun.update() ) page.shadowElapsed = 0;
		shared.time.value = render.simTime;
		fft.update( render.paused ? 0 : dt, render.simTime );
		stormSea.update( render.simTime, weather.state.storm, camera );
		shoreWaves.update( fft, render.simTime );
		// Whitewater is disabled in this scene; leave its history idle.
		// (the wave maps and the caustics are drawn by their pass on the frame graph: WaveMaps.ts; the
		// caustics only while the sun is the key and gives light, and when the sea's time or the key moved)
		waveMaps.prepare( camera, sky.keyDir, ! sky.keyIsMoon && Math.max( shared.sunColor.value.x, shared.sunColor.value.y, shared.sunColor.value.z ) > 0, render.simTime, fft.spectrumRevision );
		// (their schools take flight more often by night)
		wenyao.update( render.paused ? 0 : dt, sky.grade.night );
		island.fallingLeaves?.update( render.simTime, freeControls.enabled ? camera.position : controls.target, camera.position );
		groundBounce.update( sky.seaRadiance );
		ambientRelight.update();
		island.characters?.update( renderer, scene, sun, render.simTime, render.paused ? 0 : dt );
		page.game?.render( renderer, sun, render.paused ? 0 : rawDt );
		trample.update( page.game ? page.game.walkers() : island.characters ? [ island.characters ] : [], controls.target );

		// (the ground truth draws the storm's spray with the rain, in the overlay pass; taa and taau draw
		// it with the streaks after the resolve)
		const overlay = ! AFTER_RESOLVE && ( render.rain!.mesh.visible || ( TEMPORAL && stormSea.spray.mesh.visible ) );
		const after = AFTER_RESOLVE && ( render.rain!.mesh.visible || stormSea.spray.mesh.visible );
		pipeline.render( { scene, prepassScene, opaquePrepassScene, waterScene, rainScene: overlay ? rainScene : undefined, overlay, afterScene: after ? afterScene : undefined, camera, water: render.water!, sun, keyDirection: shadowDirection, time: render.simTime, temporal: temporalFrame( rawDt, render.paused ? 0 : dt ), settle: settleFrame( bakeDue ), haze: hazeFrame() } );
		steerRenderScale( rawDt );
		submitBatch.flush();
		// a paused page in the test mode keeps at most PAUSED_QUEUE frames queued on the GPU
		// (FramePacer.ts, "A paused page's queue")
		const bounded = render.paused && TEST_MODE;
		pacer.queueLimit = bounded ? PAUSED_QUEUE : 0;
		if ( bounded ) pacer.submitted( gpuQueue.onSubmittedWorkDone() );
		page.frame ++;
		page.diagnostics();

	}

	// The periodic work in this frame (PeriodicWork bits): its frames stay out of the dynamic scale's
	// quantiles. A periodic sky bake runs its slices in the ticks while the sky is busy, from the one
	// that starts it to the one that publishes it.
	let skyWasBusy = false;
	const periodicCounts = { sunShadow: 0, refractedSun: 0 };
	function periodicWork(): number {

		let heavy = 0;
		if ( sky.busy || skyWasBusy ) heavy |= PeriodicWork.skyBake;
		skyWasBusy = sky.busy;
		if ( sunShadow.draws !== periodicCounts.sunShadow ) heavy |= PeriodicWork.sunShadow;
		if ( refractedSun.draws !== periodicCounts.refractedSun ) heavy |= PeriodicWork.refractedSun;
		periodicCounts.sunShadow = sunShadow.draws;
		periodicCounts.refractedSun = refractedSun.draws;
		return heavy;

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
		frameScales.set( renderer.info.frame, { scale: steering ? page.renderScale : NaN, heavy: periodicWork() } );
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
	sceneEvent( 'loop start' );
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
	const { dynamicResolution, gpuQueue, applyRenderScale, clock, diagnostics, loopBody, animation } = page;
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
			sceneEvent( 'loop start' );
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

			sceneEvent( 'visible' );
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
		( sky.clouds as unknown as { frame: number } ).frame = 0;
		render.skyElapsed = 0;
		page.shadowElapsed = 0;
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
					const was = { paused: render.paused, day: dayCycle.paused, skyElapsed: render.skyElapsed, shadowElapsed: page.shadowElapsed };
					render.paused = true;
					dayCycle.paused = true;
					page.holding = true;
					timer.getDelta = () => 0;
					try {

						for ( let k = 0; k < temporal.rest.target + 4 && ! temporal.converged; k ++ ) {

							if ( sky.busy && skyBake.slices.length === 0 ) await skyBake.pendingUpdate?.catch( () => {} );
							await tickAt( t0 + i * dt * 1000 );

						}

					} finally {

						timer.getDelta = () => dt;
						page.holding = false;
						render.paused = was.paused;
						dayCycle.paused = was.day;
						render.skyElapsed = was.skyElapsed;
						page.shadowElapsed = was.shadowElapsed;

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
