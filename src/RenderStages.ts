// The renderer's stages: the page's renderer built a stage at a time, in the order the entry
// (main.ts) calls them. Each stage is a plain function that puts what it builds on the one
// RenderParts object, which the later stages, the island's stages (IslandStages.ts) and the page
// read. The stages come in three groups: those that need no land (the renderer, the scenes, the
// sky, the sun's light, the environment, the sea's waves and the frame's passes), those the
// island's data builds (the ground's bounce and the shore's waves, the ambient light's probes, the
// water) and those that close the build (the haze's bake, the warm-up, the shared builds).
// - The order of the statements inside a stage and of the stages is part of the image: the order
//   materials first build in decides their shader code (AGENTS.md, WebGPU / TSL pitfalls). A new
//   statement goes where its build belongs, never at the end by habit.
// - A stage that ends in a wait returns its promise, which the entry awaits before the next stage:
//   a stage holds no await of its own, so the frames and microtasks between two stages stay the
//   entry's to order.
// - What the island gives a stage comes as an argument typed by the renderer's own types: this
//   file names nothing of the island's.
import { settings as params, type SettingName, type SettingsQuery } from './Settings.ts';
import * as THREE from 'three/webgpu';
import { Sky } from './sky/Sky.ts';
import { DAY_PRESETS, type DayPreset, DayCycle, sunRising } from './sky/DayCycle.ts';
import { isParkedWeather, WEATHER_PRESETS, type WeatherName, isWindLevel, type WindLevel, Weather, type TunedField, type WeatherState, deckLight, cloudedShare, type WindChoice } from './sky/Weather.ts';
import type { QualityProfile, QualityTier } from './Quality.ts';
import { keyDeckShare } from './lighting/KeyCloud.ts';
import { Wind, weatherWind } from './weather/Wind.ts';
import { Rain, setRainShading } from './weather/Rain.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { seaState } from './ocean/OceanSpectrum.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { WaveMaps } from './ocean/WaveMaps.ts';
import { SeaDetail } from './ocean/SeaDetail.ts';
import { showUnderwater } from './ocean/Refraction.ts';
import { keyChroma, Water } from './ocean/Water.ts';
import { StormSea } from './ocean/StormSea.ts';
import { Pipeline, postOptionsFromURL } from './post/Pipeline.ts';
import { hazeKeyAt, type HazeKey } from './weather/HazeKeys.ts';
import { OUTPUT_PIXEL_RATIO_CAP, outputPixelRatio } from './post/RenderScale.ts';
import { SubmitBatch } from './post/SubmitBatch.ts';
import { installCacheKeyPatches, installBindingPatches, primeSharedNodes } from './three/ThreePatches.ts';
import { checkRenderer } from './three/Internals.ts';
import { isWebGPU, gpuDevice } from './three/Backend.ts';
import { shared } from './shared.ts';
import { installOpenShadow } from './lighting/SolarShadow.ts';
import { SunShadow } from './lighting/SunShadow.ts';
import { RefractedSun } from './lighting/RefractedSun.ts';
import { installGroundBounce, GroundBounce } from './lighting/GroundBounce.ts';
import { updateKeyLift, liftedKeyDirection, liftedKeyHeight } from './lighting/KeyLift.ts';
import { keyGlint } from './lighting/SurfaceBRDF.ts';
import { AmbientVolume, type AmbientView } from './lighting/AmbientVolume.ts';
import { installAmbientVolume, installEnvironmentHarmonics } from './lighting/AmbientSample.ts';
import { lowSunSkyLift, AmbientSky, AmbientRelight } from './lighting/AmbientRelight.ts';
import { type TuneOptions, tune } from './debug/Tune.ts';
import { markSkyRetune, skyRetune } from './sky/SkyRetune.ts';
import { TEMPORAL, AFTER_RESOLVE } from './post/Antialiasing.ts';
import type { LatentRegistry } from './post/graph/FrameGraph.ts';
import { onTaaCut, motionUniforms, MOTION_CLASS, motionCheck } from './post/Motion.ts';
import { jitter } from './post/Jitter.ts';
import { preExposure } from './post/PreExposure.ts';
import { sceneEvent } from './post/SceneEvents.ts';
import { TemporalAA } from './post/TemporalAA.ts';
import { watchPipelines } from './post/Settled.ts';
import { MOON_GLINT_RADIUS, SCENE_RADIANCE_SCALE } from './lighting/Radiometry.ts';
import { SUN_GLINT_DISC } from './lighting/SunDisc.ts';
import { debugViewFromURL, installDebugView } from './post/graph/DebugView.ts';

/** A scene as the query names it: what a load and a scene jump both establish. */
type SceneOptions = { weather: WeatherName; wind: { level: WindLevel | undefined; heading: number | undefined }; autoWeather: boolean; day: { hour: number; dayLength: number; paused: boolean; moonPhase: number }; preset: DayPreset | null; paused: boolean; time: number; clouds: number | null; camera: string };

export interface RenderParts {
	profiler: ReturnType<typeof import( './debug/FrameProfiler.ts' ).createFrameProfiler> | null;
	mark: ( name: string ) => void | undefined;
	DEBUG: boolean;
	qualityTier: QualityTier;
	quality: Readonly<QualityProfile>;
	setStatus: ( s: string ) => void;
	gpuTiming: boolean;
	renderer: THREE.WebGPURenderer;
	submitBatch: SubmitBatch;
	DPR_CAP: number;
	resolution: { full: boolean; render: string; scale: string; gpu: string };
	scene: THREE.Scene;
	waterScene: THREE.Scene;
	rainScene: THREE.Scene;
	afterScene: THREE.Scene;
	camera: THREE.PerspectiveCamera;
	sky: Sky;
	numberParam: ( name: SettingName, fallback: number, options?: SettingsQuery ) => number;
	sceneOptions: ( options: SettingsQuery ) => SceneOptions;
	loaded: SceneOptions;
	dayCycle: DayCycle;
	weather: Weather;
	weatherEffects: { rain: boolean; wetness: boolean };
	seaFogView: { on: boolean };
	dayFogView: { on: boolean };
	requestedPreset: string | null;
	manualSun: boolean;
	paused: boolean;
	simTime: number;
	wind: Wind;
	rain: Rain;
	skyElapsed: number;
	lastSkyTime: number;
	lastSkyHour: number;
	lastWeatherSignature: string;
	cloudOverride: number | null;
	skyQuality: { value: QualityTier };
	runtime: { refractedSun: RefractedSun | null };
	applySkyQuality: ( q?: Readonly<QualityProfile> ) => void;
	runtimeQuality: Readonly<QualityProfile>;
	lighting: { skyFill: number };
	applyEnvironmentFill: ( fill: number ) => void;
	sun: THREE.DirectionalLight;
	sunShadow: SunShadow;
	invalidateSunShadow: () => void;
	shadowDirection: THREE.Vector3;
	sunUpdates: Promise<void>;
	hazeReady: boolean;
	prepareHaze: ( state: Readonly<WeatherState> ) => void;
	prepareSkyState: () => void;
	publishLighting: () => void;
	bakeEnvironment: () => Promise<void>;
	jumpsInFlight: number;
	bakeExplicitly: () => Promise<void>;
	retuneSky: () => boolean;
	refreshEnvironment: () => Promise<void>;
	applySun: () => Promise<void>;
	setHour: ( hour: number ) => Promise<void>;
	setPreset: ( preset: DayPreset ) => Promise<void>;
	setWeather: ( name: WeatherName, seconds?: number ) => Promise<void>;
	setWind: ( choice: WindChoice, seconds?: number ) => Promise<void>;
	applySkyFill: () => void;
	water: Water;
	ambientSky: AmbientSky;
	fft: OceanFFT;
	waveMaps: WaveMaps;
	seaDetail: SeaDetail;
	fgview: string | null;
	pipeline: Pipeline;
	overlayLatents: LatentRegistry;
	warming: Promise<[ void, void, void, void, void | undefined ]>;
	groundBounce: GroundBounce;
	shoreWaves: ShoreWaves;
	ambient: AmbientVolume;
	ambientRelight: AmbientRelight;
	hazeShadowCompiled: Promise<void>;
	ambientView: { mode: AmbientView };
	refractedSun: RefractedSun;
	stormSea: StormSea;
	hazeKey: HazeKey;
	motionPasses: () => { pass: string; scene: THREE.Scene; keeps: boolean }[];
}

/** The renderer itself. Returns its init, which the entry awaits. */
export function createRenderer( render: RenderParts ) {

	const { profiler, quality } = render;

	// ------------------------------------------------------------------ renderer

	// A dynamic render scale steers by the GPU's frame time, read from timestamp queries
	// (`gpuTimer=off` leaves them out: it then steers by the frame intervals, as where they are missing).
	const gpuTiming = ( profiler?.timestamps ?? false ) || ( 'dynamic' in quality.render && params.get( 'gpuTimer' ) !== 'off' );
	render.gpuTiming = gpuTiming;
	const renderer = new THREE.WebGPURenderer( { antialias: false, powerPreference: 'high-performance', trackTimestamp: gpuTiming } );
	render.renderer = renderer;
	if ( profiler ) renderer.inspector = profiler;
	return renderer.init();

}

/** What must hold before any material builds: WebGPU, three's patches, the submit batching. */
export function setUpRenderer( render: RenderParts ) {

	const { mark, DEBUG, setStatus, renderer } = render;
	mark( 'renderer' );
	if ( ! isWebGPU( renderer ) ) {

		setStatus( 'This scene needs WebGPU (Chrome / Edge 113+, Safari 26+).' );
		throw new Error( 'WebGPU is not available' );

	}
	// the members of three's renderer the page reaches beyond its interface: a three without one stops
	// the page here, naming it (three/Internals.ts)
	checkRenderer( renderer );
	// three r186 keys its node builds and pipelines by the first attachment, not the whole layout (an
	// MRT picks its outputs by the textures' names): patched before any material builds, so a material
	// drawn into two layouts gets a build each (three/ThreePatches.ts)
	installCacheKeyPatches( renderer );
	// a new render object's texture bindings start at their node's current texture, so a texture the
	// growth replaced and disposed is not uploaded again (three/ThreePatches.ts)
	installBindingPatches( renderer );
	// three submits every pass on its own; the frame reaches the GPU in a few submits instead
	// (SubmitBatch.ts: a submit per pass kept Chrome's GPU process from presenting the page on time)
	render.submitBatch = new SubmitBatch( gpuDevice<ConstructorParameters<typeof SubmitBatch>[ 0 ]>( renderer ), { debug: DEBUG } );
	// the settled signal counts the async pipeline compiles in flight (post/Settled.ts; debug only)
	if ( DEBUG ) watchPipelines( gpuDevice( renderer ) );

}

/** The canvas at its starting size, the scenes the frame draws and the camera. */
export function createScenes( render: RenderParts, { viewport }: { viewport: { host: HTMLElement; width: number; height: number } } ) {

	const { renderer } = render;
	// The scene renders at a pixel ratio set by the quality tier (see RenderScale.ts), at most the
	// display's and DPR_CAP (the canvas's cap: native 4K on a 2x display at high's maximum, or `?dpr`);
	// the canvas matches the display and the frame graph upscales to it.
	// Explicit DPR captures and the full-resolution control lift the tier's pixel budget and pin a
	// dynamic scale at its nominal.
	render.DPR_CAP = params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : OUTPUT_PIXEL_RATIO_CAP;
	render.resolution = { full: params.has( 'dpr' ), render: '', scale: '', gpu: '–' };
	renderer.setPixelRatio( outputPixelRatio( 1 ) );
	renderer.setSize( viewport.width, viewport.height );
	renderer.shadowMap.enabled = true;
	renderer.shadowMap.type = THREE.PCFShadowMap;
	renderer.info.autoReset = false;
	viewport.host.appendChild( renderer.domElement );

	render.scene = new THREE.Scene();
	render.waterScene = new THREE.Scene();
	render.rainScene = new THREE.Scene();
	// under taa and taau, what draws after the resolve: the rain's streaks and the storm's spray
	// (post/AfterResolve.ts)
	render.afterScene = new THREE.Scene();

	// The far plane reaches past the horizon so the sea's skirt meets the sky (the resolved sky
	// depth, -1e5, and the passes' sky threshold, -9e4, stay beyond it).
	render.camera = new THREE.PerspectiveCamera( 27, viewport.width / viewport.height, 1, 60000 );

}

/**
 * The scene the query names, the sky, the day and the weather, the wind, the rain and the sky's
 * quality knobs.
 */
export function createSky( render: RenderParts ) {

	const { DEBUG, quality, renderer } = render;
	render.sceneOptions = sceneOptions;

	// ------------------------------------------------------------------ sky, light, water optics

	const sky = new Sky( renderer, { elevation: 32, azimuth: - 8 } );
	render.sky = sky;
	sky.setEnvironmentSource( quality.environmentSource );
	const numberParam = ( name: SettingName, fallback: number, options: SettingsQuery = params ) => {

		const value = Number( options.get( name ) ?? fallback );
		return Number.isFinite( value ) ? value : fallback;

	};
	render.numberParam = numberParam;
	// The scene a query's options set: the weather (held when one is asked for, else evolving on its
	// own), the day clock and its preset, the scene clock and the cloud override. The load reads its
	// own query with it, and a scene jump (`establishScene`) the query it is given, so the two agree.
	// A 48-minute day, as in many open-world games: slow enough to watch the light change. The game's
	// day is 24 minutes at 1x, so a day's work and its evening fit one sitting. The moon (a full one
	// by default) and the stars stand fixed in the sky (DayCycle.ts MOON, STARS); the phase shapes only
	// the drawn moon. The game starts at 8 (see Game.ts), so the sky is lit
	// once for that hour. A parked weather (Weather.ts `PARKED_WEATHER`) is refused outside a debug
	// build and falls back to fair; the load and a scene jump read it here alike, and so does ?game,
	// whose weather is the page's. The wind (Weather.ts) takes `wind` (a level) and `windDir` (a
	// heading, degrees in WeatherState's convention), each over the sky's own wind; naming the
	// weather or either of them holds the weather, its wind included.
	function sceneOptions( options: SettingsQuery ) {

		let weather = options.get( 'weather' ) ?? 'fair';
		const preset = options.get( 'preset' );
		if ( ! DEBUG && isParkedWeather( weather ) ) {

			console.warn( `weather=${ weather } is parked (debug builds only, ?debug): showing fair` );
			weather = 'fair';

		}
		return {
			weather: Object.hasOwn( WEATHER_PRESETS, weather ) ? weather as WeatherName : 'fair',
			wind: {
				level: isWindLevel( options.get( 'wind' ) ) ? options.get( 'wind' ) as WindLevel : undefined,
				heading: options.has( 'windDir' ) && Number.isFinite( Number( options.get( 'windDir' ) ) ) ? Number( options.get( 'windDir' ) ) : undefined,
			},
			autoWeather: ! options.has( 'weather' ) && ! options.has( 'wind' ) && ! options.has( 'windDir' ),
			day: { hour: numberParam( 'hour', params.has( 'game' ) ? 8 : DAY_PRESETS[ 'golden-hour' ], options ),
				dayLength: Math.max( 30, numberParam( 'dayLength', params.has( 'game' ) ? 1440 : 2880, options ) ),
				paused: options.has( 'paused' ) || options.get( 'clock' ) === 'paused', moonPhase: numberParam( 'moon', 0.5, options ) },
			preset: preset && Object.hasOwn( DAY_PRESETS, preset ) ? preset as DayPreset : null,
			paused: options.has( 'paused' ),
			time: Math.max( 0, numberParam( 't', 0, options ) ),
			// Explicit cloud tuning is a review override; selecting a weather preset restores authored coverage.
			clouds: options.has( 'clouds' ) ? THREE.MathUtils.clamp( numberParam( 'clouds', 0.32, options ), 0, 1 ) : null,
			camera: options.get( 'camera' ) === 'free' ? 'free' : 'orbit',
		};

	}
	const loaded = sceneOptions( params );
	render.loaded = loaded;
	const dayCycle = new DayCycle( loaded.day );
	render.dayCycle = dayCycle;
	const weather = new Weather( loaded.weather, loaded.wind );
	render.weather = weather;
	render.weatherEffects = { rain: true, wetness: true };
	// The deep sea fog (weather/HazeKeys.ts SEA_FOG): a switch beside the weather, off unless `?seaFog`
	// or the GUI turns it on, whatever the sky.
	render.seaFogView = { on: params.has( 'seaFog' ) };
	// The day's fog layer under a clear or fair sky (weather/HazeKeys.ts `fogLayer`): a switch, off
	// unless `?dayFog` or the GUI turns it on.
	render.dayFogView = { on: params.has( 'dayFog' ) };
	weather.auto = loaded.autoWeather;
	// The day sky's level and exponent per clouded sky (Weather.ts `daySky`, `daySkyExponent`),
	// tunable on debug pages
	// without a reload: the presets the weather moves between take them, and the state that stands on
	// that sky follows (`setPresetValue`); the sky rebakes. A `?tune=` value is the start, applied
	// here as a load would.
	const PRESET_TUNABLES: ReadonlyArray<readonly [ TunedField, TuneOptions ]> = [
		[ 'daySky', { min: 0.005, max: 2, scale: 'log' } ],
		[ 'daySkyExponent', { min: 0, max: 3 } ],
	];
	for ( const name of [ 'cloudy', 'overcast' ] as const ) for ( const [ field, range ] of PRESET_TUNABLES ) {

		const value = tune( `sky.${ field }@${ name }`, WEATHER_PRESETS[ name ][ field ], { ...range, onChange: ( next ) => {

			weather.setPresetValue( name, field, next );
			markSkyRetune();

		} } );
		weather.setPresetValue( name, field, value() );

	}
	render.requestedPreset = params.get( 'preset' );
	if ( loaded.preset ) dayCycle.setPreset( loaded.preset );
	render.manualSun = false;
	render.paused = loaded.paused;
	render.simTime = loaded.time;
	const wind = new Wind( shared.wind, { ...weatherWind( weather.state ), time: render.simTime } );
	render.wind = wind;
	// Across a cut of the temporal modes' history (Motion.ts) the vegetation's wind has no motion either:
	// its previous state becomes the current one.
	if ( TEMPORAL ) onTaaCut( () => wind.cut() );

}

/** The sky's runtime quality, the environment's fill, the sun's light and its shadow map. */
export function createLight( render: RenderParts ) {

	const { qualityTier, quality, scene, sky, loaded, dayCycle } = render;
	render.applySkyQuality = applySkyQuality;
	render.applyEnvironmentFill = applyEnvironmentFill;

	render.skyElapsed = 0;
	render.lastSkyTime = render.simTime;
	render.lastSkyHour = dayCycle.hour;
	render.lastWeatherSignature = '';
	render.cloudOverride = loaded.clouds;
	render.skyQuality = { value: qualityTier };
	// The tier's runtime knobs (a debug override may replace some of them: `s.applyQuality( { ... } )`).
	const runtime = { refractedSun: null as RefractedSun | null };
	render.runtime = runtime;
	function applySkyQuality( q: Readonly<QualityProfile> = quality ): void {

		sky.setCloudView( q.cloudView );
		sky.clouds.setDome( q.cloudDome.width, q.cloudDome.height, q.cloudDome.strideX, q.cloudDome.strideY );
		sky.clouds.setMarch( q.cloudMarch );
		sky.clouds.setShadowRefresh( q.cloudShadowRows );
		sky.setEnvironmentCadence( q.environmentEvery );
		render.rain?.setQuality( q.rainDrops );
		if ( runtime.refractedSun ) runtime.refractedSun.angleGate = THREE.MathUtils.degToRad( q.refractedSun.angleGate );
		render.runtimeQuality = q;
		sceneEvent( 'apply quality' );

	}
	render.runtimeQuality = quality;
	applySkyQuality();
	scene.add( sky.dome, sky.lightning.group );
	render.lighting = { skyFill: 1 };
	// The environment's intensity: the fill times what takes the displayed environment's texels to
	// scene units (its atlases store the sky's radiance at a power of two, under the debug press:
	// Sky.ts `environmentRead`), so a fill of 1 lights as the sky stands. A bake that publishes after
	// the frame set it sets it again, before the frame renders (`onEnvironmentStore`).
	let environmentFill = 1;
	function applyEnvironmentFill( fill: number ): void {

		environmentFill = fill;
		scene.environmentIntensity = fill * sky.environmentRead;

	}
	applyEnvironmentFill( 1 );
	sky.onEnvironmentStore = () => applyEnvironmentFill( environmentFill );

	const sun = new THREE.DirectionalLight( 0xffffff, 1 );
	render.sun = sun;
	sun.castShadow = true;
	// (the water's refraction source draws the world under the sea lit by it: ocean/Refraction.ts)
	showUnderwater( sun );
	sun.shadow.mapSize.set( 2048, 2048 );
	// The map is fitted to the island's casters once the world exists, and redrawn in small steps of
	// the key light with a cross-fade (SunShadow). Its bias, 1 cm along the light ray, follows each
	// fit's depth range; receiver-plane correction in the shared filter keeps contacts sharp without
	// a wide blur. The normal offset is SunShadow's (in texels, growing with view depth): three's
	// own stays 0.
	sun.shadow.normalBias = 0;
	const sunShadow = new SunShadow( sun, { bias: 0.01 } );
	render.sunShadow = sunShadow;
	sunShadow.install();
	// Cloud shadowing shares the density field in the visible/reflected sky. Bake its long solar
	// path once at low resolution, then sample the same transmission on every receiver, including
	// those beyond the island's shadow map (the sea floor seen through the water).
	installOpenShadow( sun, ( position ) => sky.keyDirectVisibility( position ), sky.castShadow );

}

/** The sun in the scene, and the direction the sun's map and the figures' are drawn along. */
export function createKey( render: RenderParts ) {

	const { scene, sun, sunShadow } = render;
	render.invalidateSunShadow = invalidateSunShadow;
	// Vegetation casts its rest pose; wind only changes the visible mesh. The key light's steps
	// redraw the map; a jump of the light or an edit to the casters redraws it from scratch.
	function invalidateSunShadow(): void { sunShadow.invalidate(); }
	scene.add( sun, sun.target );
	// the direction the sun's map and the figures' are drawn along: the key's, lifted under a low key
	// (lighting/KeyLift.ts)
	render.shadowDirection = new THREE.Vector3( 0, 1, 0 );

}

/**
 * The sky's bakes and the lighting they publish, and the operations that change the hour, the
 * weather and the wind. Returns the first refresh, which the entry awaits.
 */
export function createEnvironment( render: RenderParts ) {

	const { setStatus, renderer, scene, sky, dayCycle, weather, seaFogView, dayFogView, lighting, applyEnvironmentFill, sun, invalidateSunShadow, shadowDirection } = render;
	render.prepareHaze = prepareHaze;
	render.prepareSkyState = prepareSkyState;
	render.publishLighting = publishLighting;
	render.bakeEnvironment = bakeEnvironment;
	render.bakeExplicitly = bakeExplicitly;
	render.retuneSky = retuneSky;
	render.refreshEnvironment = refreshEnvironment;
	render.applySun = applySun;
	render.applySkyFill = applySkyFill;

	function fresnel( cosI: number, eta: number ): number {

		const g = Math.sqrt( eta * eta - 1 + cosI * cosI );
		const a = ( g - cosI ) / ( g + cosI ), b = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
		return 0.5 * a * a * ( b * b + 1 );

	}

	render.sunUpdates = Promise.resolve();
	// The haze by the hour and the weather (weather/HazeKeys.ts): its amount over the weather's, the
	// morning mist beside the weather's sea fog, its spectral extinction and its light, set on the
	// medium the frame and the environment's bake read (the bake lays it over its source: Sky.ts
	// `fogEnvironment`), so a bake sees the haze of the state it bakes.
	// (the first bake runs before the pipeline holds the haze: `hazeReady` below)
	render.hazeReady = false;
	function prepareHaze( state: Readonly<WeatherState> ): void {

		if ( ! render.hazeReady ) return;
		const rising = sunRising( sky.sunDir );
		// the parked fog weather's share of the sky, by the front's smoothstep as `skyMix` blends: exact
		// at rest and, for the sun's Rayleigh beam, on a front between the fog and the overcast sky, for
		// the fog layer's droplets on one between the fog and the cloudy or overcast sky
		// (weather/HazeKeys.ts `hazeKeyAt`)
		const progress = weather.progress, blend = progress * progress * ( 3 - 2 * progress );
		const fogWeather = ( weather.origin === 'fog' ? 1 - blend : 0 ) + ( weather.target === 'fog' ? blend : 0 );
		hazeKeyAt( sky.elevation, rising, weather.skyMix, sky.weather.windSpeed, sky.weather.rain, dayFogView.on ? 1 : 0, seaFogView.on ? 1 : 0, fogWeather, render.hazeKey );
		render.pipeline.air.haze.value = sky.weather.haze * render.hazeKey.amount;
		render.pipeline.air.fog.value = Math.max( sky.weather.fog, render.hazeKey.mist );
		render.pipeline.air.setLook( render.hazeKey );
		// the air's sunlit haze takes the key the land does, through the clouds' shadow (its own read),
		// and its sky light the weather's sky as the sky takes it; the weather's day sky comes in with
		// the sun's light the sky lends the air (Sky.ts `skyGain`)
		render.pipeline.air.weatherLight.direct = state.directVisibility;
		render.pipeline.air.weatherLight.ambient = state.ambientGain;
		// the floor of the key under a closed deck (Sky.ts `deckKeyFloor`), which the seen panorama's
		// bake reads as the frame's air does: set with the medium, so a bake takes its own scene's
		render.pipeline.air.keyFloor.value = sky.deckKeyFloor;
		render.pipeline.air.prepareMedium();

	}

	function prepareSkyState(): void {

		const celestial = render.manualSun ? null : dayCycle.snapshot();
		const state = weather.snapshot();
		if ( render.cloudOverride !== null ) state.coverage = render.cloudOverride;
		sky.setWeather( state );
		keyGlint.spread.value = state.glintSpread ?? 0;
		sky.track( celestial, state, render.cloudOverride, weather.skyMix );
		prepareHaze( state );
		render.lastWeatherSignature = `${ state.coverage },${ state.density },${ state.directVisibility },${ state.ambientGain },${ state.daySky },${ state.daySkyExponent },${ state.haze }`;

	}

	function publishLighting(): void {

		// three's sun: the direct key, the sky's, which the clouds' shadow cuts per point over the land's
		// floor, the share of the key a cloud passes on (Sky.ts `keyDirectVisibility`, KEY_THROUGH_CLOUD); the
		// land's key (shared.landKey) and the sea's (shared.sunColor): both the sky's key, the sea's cut
		// by the clouds' own transmittance over the land's floor (Sky.ts `seaKeyVisibility`,
		// lighting/KeyCloud.ts)
		const overcast = weather.skyMix[ 3 ] ?? 0;
		sun.color.copy( sky.keyColor );
		// how far the open key on the land is its floor's under a deck: the islanders read their cast
		// shadow against it (lighting/KeyCloud.ts `keyDeckShare`)
		keyDeckShare.value = deckLight( sky.elevation, cloudedShare( weather.skyMix ), overcast );
		shared.landKey.value.set( sun.color.r, sun.color.g, sun.color.b );
		// a low sun's lift of the sky's light on the water: the sea's bounce onto the land, the water's
		// sky light and the sea's reflection (lighting/AmbientRelight.ts `lowSunSkyLift`)
		shared.skyLift.value = lowSunSkyLift( sky.elevation, cloudedShare( weather.skyMix ) );
		sun.intensity = 1;
		sun.position.copy( sky.keyDir ).multiplyScalar( 120 ).add( sun.target.position );
		shared.sunDir.value.copy( sky.keyDir );
		updateKeyLift( sky.keyDir, sky.keyIsMoon );
		keyGlint.radius.value = sky.keyIsMoon ? MOON_GLINT_RADIUS : SUN_GLINT_DISC;
		liftedKeyDirection( sky.keyDir, sky.keyIsMoon, shadowDirection );
		shared.sunColor.value.set( sun.color.r, sun.color.g, sun.color.b );
		keyChroma.value = sky.keyIsMoon ? 0 : 1;
		const cosI = Math.max( sky.keyDir.y, 0 );
		shared.sunIntoWater.value = sky.keyDir.y > 0 ? 1 - fresnel( cosI, 1.333 ) : 0;
		const eta = 1 / 1.333;
		shared.muSun.value = Math.sqrt( 1 - eta * eta * ( 1 - cosI * cosI ) );
		applySkyFill();

	}

	async function bakeEnvironment(): Promise<void> {

		// Explicit preset changes settle any in-flight bake first. The running clock uses a single
		// coalesced request below, never a growing async queue or a suspended animation loop.
		if ( sky.busy ) await sky.update();
		// Every explicit bake bakes as the page's first does, the clouds at the scene clock (Sky.reset):
		// a paused page keeps its products, so the load, a jump, a seek, a new hour or weather and a
		// retune each make the ones a fresh load of the same scene makes, whatever the frames before
		// left in the sky. It takes every value as it stands (`retuneSky`).
		sky.reset( shared.wind.direction.value, render.simTime );
		skyRetune.dirty = false;
		if ( render.hazeReady ) render.pipeline.air.noteBake();
		prepareSkyState();
		await sky.update();
		scene.environment = sky.envMap!.texture;
		( scene as unknown as { environmentNode: THREE.Node<'vec3'> | null } ).environmentNode = sky.environmentNode;
		publishLighting();
		invalidateSunShadow();
		render.lastSkyHour = dayCycle.hour;
		render.lastSkyTime = render.simTime;
		render.skyElapsed = 0;

	}

	// An explicit bake (a jump of the hour, the weather or the whole scene, a seek, a retune of what the
	// bake depends on) shows at once, its sky's light read back before it publishes (Sky.ts `bake`).
	// The state it bakes changes before it is called and the readback takes a frame or two, so the loop
	// draws no frame from that change until the bake has published (`tick`): the frame on screen holds
	// the old state, and the first frame drawn after it shows the new weather or hour in its own light.
	// (a count: the requests queue on `sunUpdates`, and a scene jump holds from its first change.) A
	// held tick still advances three's frame count (`renderer.info.frame`, which probe.mjs `--frames`
	// counts as drawn frames), and the first frame drawn after a hold records the whole hold as one
	// interval in the frame statistics.
	render.jumpsInFlight = 0;
	function bakeExplicitly(): Promise<void> {

		render.jumpsInFlight ++;
		render.sunUpdates = render.sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( () => bakeEnvironment() )
			.finally( () => { render.jumpsInFlight --; } );
		return render.sunUpdates;

	}

	// A value the environment's bakes depend on has changed since they ran (sky/SkyRetune.ts: a
	// tunable's mark, or a haze setting the bake reads: VolumetricHaze.ts `bakeStale`): bake again
	// explicitly, as the load does, and raise the `retune` event. Run by the `tune` handle's `set` and
	// before each frame (`tick`, `loop.step`), so the GUI and scripts take the same path; true when it
	// started a bake.
	function retuneSky(): boolean {

		if ( render.hazeReady && render.pipeline.air.bakeStale ) markSkyRetune();
		if ( ! skyRetune.dirty ) return false;
		skyRetune.dirty = false;
		sceneEvent( 'retune' );
		void bakeExplicitly();
		return true;

	}

	function refreshEnvironment(): Promise<void> {

		render.manualSun = false;
		return bakeExplicitly();

	}

	function applySun(): Promise<void> {

		render.manualSun = true;
		return bakeExplicitly();

	}

	render.setHour = async ( hour: number ) => { dayCycle.setHour( hour ); sceneEvent( 'set hour' ); await refreshEnvironment(); };
	render.setPreset = async ( preset: DayPreset ) => { dayCycle.setPreset( preset ); sceneEvent( 'set preset' ); await refreshEnvironment(); };
	render.setWeather = async ( name: WeatherName, seconds = 20 ) => {

		render.cloudOverride = null;
		weather.auto = false;
		weather.setWeather( name, seconds );
		sceneEvent( seconds === 0 ? 'weather jump' : 'weather front' );
		if ( seconds === 0 ) await refreshEnvironment();

	};
	// The wind alone (its level, its heading or both), the sky keeping its course; as setWeather, it
	// holds the weather.
	render.setWind = async ( choice: WindChoice, seconds = 20 ) => {

		weather.auto = false;
		weather.setWind( choice, seconds );
		sceneEvent( seconds === 0 ? 'weather jump' : 'weather front' );
		if ( seconds === 0 ) await refreshEnvironment();

	};
	// (a whole scene at once, as a query loads it: `establishScene`, below the frame loop)

	function applySkyFill(): void {

		// One artistic fill gain drives PBR ambient, water scattering and sky reflections alike.
		applyEnvironmentFill( lighting.skyFill );
		shared.skyFill.value = lighting.skyFill;
		shared.skyIrradiance.value.set( sky.skyIrradiance.r, sky.skyIrradiance.g, sky.skyIrradiance.b ).multiplyScalar( lighting.skyFill );
		if ( render.water ) render.water.uniforms.reflection.value = lighting.skyFill;

	}



	// the sky's harmonics for the ambient light's relight (lighting/AmbientRelight.ts), projected from
	// every bake's environment source from the first on
	const ambientSky = new AmbientSky( renderer );
	render.ambientSky = ambientSky;
	sky.onEnvironmentSource = ( source, atlases, read ) => ambientSky.project( source, atlases, read );

	setStatus( 'Lighting the sky…' );
	return refreshEnvironment();

}

/** The sky's light as the nodes every material reads. */
export function publishSkyLight( render: RenderParts ) {

	const { mark, sky } = render;
	mark( 'sky' );
	// (the sky's light on what it lights takes a low sun's lift, shared.ts `skyLift`; the sky drawn and
	// its meter never do)
	shared.skyIrradianceSource = sky.irradianceNode.mul( shared.skyFill ).mul( shared.skyLift );
	shared.islandIrradianceSource = sky.islandIrradianceNode.mul( shared.skyFill );
	shared.skyMeterLog2 = sky.meterLog2Node;

}

/** The sea's waves and detail, then the frame's passes with the passes the entry adds. */
export function createSeaAndPipeline( render: RenderParts, { rainCeiling, extraPasses }: { rainCeiling: number; extraPasses: ConstructorParameters<typeof Pipeline>[ 6 ] } ) {

	const { profiler, DEBUG, quality, renderer, scene, waterScene, rainScene, afterScene, camera, sky, wind, sun, sunShadow } = render;
	// tidewater's two wave systems at the prevailing heading (Wind.ts `spectrumWind`) and tidewater's
	// sea state for the wind (OceanSpectrum.ts `seaState`: its fetch, choppiness and swell), rebuilt
	// whenever the weather's wind speed or heading changes (`setWind`, below in the frame loop: the
	// wind sea turns with the heading, the swell keeps the prevailing one).
	const sea = seaState( wind.spectrumWind.windSpeed );
	const fft = new OceanFFT( renderer, {
		...wind.spectrumWind, fetch: sea.fetch, choppiness: sea.choppiness, distantSwell: { scale: sea.swell },
		anisotropy: quality.water.fftAnisotropy,
	} );
	render.fft = fft;
	const waveMaps = new WaveMaps( renderer, fft );
	render.waveMaps = waveMaps;
	// the sea's gusts, slicks and windrows (the water's roughness)
	render.seaDetail = new SeaDetail( shared );
	// the veil's shells and the sea's ripple layers are built into the rain's and the water's materials
	setRainShading( quality.rainShading );
	render.rain = new Rain( { count: render.runtimeQuality.rainDrops, ceiling: rainCeiling } );
	// Drops scatter the same linear environment and key light as the island, without an emissive
	// floor. Using the GPU integral keeps their light in step with the displayed sky transition.
	// A strike's fill lights the ground they show in full; the sky they show and reflect takes it
	// damped (like the storm spray's), since the displayed deck brightens far less than the fill.
	render.rain.setLightNode( shared.skyIrradianceSource, shared.sunDir, shared.sunColor, shared.skyIrradianceSource.div( shared.skyFill.max( 1 ).pow( 0.35 ) ) );
	// `fgview=<resource>[.<output>]` (debug builds): the frame graph's debug view shows one of its
	// resources on the canvas (src/post/graph/DebugView.ts): only then it appends its pass to the graph
	// before the pipeline compiles it.
	const fgview = DEBUG ? debugViewFromURL() : null;
	render.fgview = fgview;
	if ( fgview ) installDebugView( fgview, {
		// (the targets hold scene radiance pre-exposed: PreExposure.ts)
		exposure: () => pipeline.settings.exposure / SCENE_RADIANCE_SCALE * preExposure.inverse.value,
		// (the resolve exists while the pipeline compiles its graph, before `pipeline` is assigned)
		temporal: () => TemporalAA.current,
		motion: {
			previousViewProjection: motionUniforms.previousViewProjection, projectionInverse: jitter.uniforms.unjitteredProjectionInverse,
			jitterNdc: jitter.uniforms.ndc, opaqueBelow: ( MOTION_CLASS.opaque + MOTION_CLASS.vegetation ) / 2,
		},
	} );
	const pipeline = new Pipeline( renderer, sky, sunShadow, render.rain, postOptionsFromURL( params, quality.post ), quality.taa, extraPasses );
	render.pipeline = pipeline;
	// The profiler labels each pass the graph runs by the pass's label (its groups), unless a
	// target or object it knows labels it otherwise (the passes inside the display chain).
	if ( profiler ) {

		const hooks = pipeline.graph.hooks, begin = hooks.onPassBegin, end = hooks.onPassEnd;
		hooks.onPassBegin = ( pass, f ) => {

			begin?.( pass, f );
			profiler.graphPass( pass.label );

		};
		hooks.onPassEnd = ( pass, f ) => {

			profiler.graphPass( null );
			end?.( pass, f );

		};

	}
	render.rain.bindOpaqueDepth( pipeline.depthRT.texture, pipeline.surfaceRT.texture );
	rainScene.add( render.rain.group );
	if ( render.rain.afterGroup ) afterScene.add( render.rain.afterGroup );
	// Under the ground truth the rain and the storm's spray draw in the overlay pass (rainScene,
	// Pipeline.ts), which keeps the motion vectors of the surfaces under them; under taa and taau they
	// draw after the resolve (afterScene, the `rainAfter` pass). Their owners register their latent
	// draws for those passes.
	const overlayLatents: LatentRegistry = TEMPORAL
		? { latent: ( pass, objects, kernels ) => pipeline.graph.latent( pass === 'rainAfter' || ( pass === 'water' && AFTER_RESOLVE ) ? 'rainAfter' : 'overlay', objects, kernels ) }
		: pipeline.graph;
	render.overlayLatents = overlayLatents;

	// ------------------------------------------------------------------ first-use pipelines

	// A weather change, the first bolt and the sky's first periodic bake used to build their
	// pipelines in the frame they first drew (rain's drops and splashes, the bolt's two passes, the
	// sky's blends and filters, the fog's passes: a dropped frame each). They are compiled ahead
	// instead, through the async pipeline calls, so the GPU process builds them off the main thread
	// while the world is generated and built; the loop starts once they are ready. The frame graph's
	// warm-up compiles every pass the frame may run, those that run only at times included (fog, rain,
	// the view distance, either output), each under its own binding (its target and MRT are part of
	// its pipelines' keys), with the objects their owners register as drawn only at times; the sky
	// and the caustics' splats (drawn only while the sun lights them) compile their own renders. The
	// storm's foam and spray need the world's shore fields and register with it.
	const warming = Promise.all( [
		sky.warm( renderer ),
		waveMaps.warm(),
		// the drops and splashes, and the bolts, registered with the passes they draw in before the
		// graph's warm-up starts, which compiles them with every pass (graph/FrameGraph.ts `warm`)
		render.rain.registerLatent( overlayLatents ),
		sky.lightning.registerLatent( pipeline.graph ),
		pipeline.graph.warm( { scene, waterScene, rainScene, afterScene: AFTER_RESOLVE ? afterScene : undefined, camera, water: null, sun, time: render.simTime } ).then( () => pipeline.resolver?.warm() ),
	] );
	render.warming = warming;
	warming.catch( () => undefined ); // reported where it is awaited, before the loop

}

/** What the island's fields build first: the ground's bounce and the shore's waves. */
export function createBounceAndShore( render: RenderParts, { fields, bounceGround, shoreData }: { fields: ConstructorParameters<typeof GroundBounce>[ 0 ][ 'fields' ] & { shore: ConstructorParameters<typeof ShoreWaves>[ 3 ]; floor: ConstructorParameters<typeof ShoreWaves>[ 5 ] }; bounceGround: ConstructorParameters<typeof GroundBounce>[ 0 ][ 'ground' ]; shoreData: ConstructorParameters<typeof ShoreWaves>[ 1 ] } ) {

	const { renderer, sky, sunShadow, fft, waveMaps } = render;
	// the sunlight the ground bounces up (lighting/GroundBounce.ts), which every lit material adds: so
	// installed before any of them builds; its map shares the wave maps' target
	render.groundBounce = installGroundBounce( new GroundBounce( { renderer, shared, sunShadow, fields, ground: bounceGround, target: waveMaps.target, layer: waveMaps.bounceLayer, cloud: ( position ) => sky.keyDirectVisibility( position ) } ) );
	render.shoreWaves = new ShoreWaves( renderer, shoreData, shared, fields.shore, fft, fields.floor );

}

/**
 * The ambient light's probes and their relight, the refracted sun and the storm sea. Returns the
 * refracted sun's first map, which the entry awaits.
 */
export function createAmbient( render: RenderParts, { ambientData, world }: { ambientData: ConstructorParameters<typeof AmbientVolume>[ 1 ]; world: { group: THREE.Group; subsets: Parameters<RefractedSun[ 'setCasters' ]>[ 1 ] } } ) {

	const { DEBUG, renderer, scene, sky, weather, runtime, ambientSky, waveMaps, pipeline } = render;
	// The ambient light's probes on the GPU (lighting/AmbientVolume.ts), relit every frame into their
	// irradiance (lighting/AmbientRelight.ts), which every lit island material reads for its ambient
	// diffuse (lighting/AmbientSample.ts: installed before any of them builds), and their debug view
	// (`ambientProbes=sky|bounce|irradiance` on a debug page, the GUI's Ground folder), built on first
	// show.
	const ambient = new AmbientVolume( renderer, ambientData );
	render.ambient = ambient;
	installAmbientVolume( ambient );
	const ambientRelight = new AmbientRelight( { renderer, volume: ambient, shared, sky: ambientSky, weights: () => sky.environmentWeights(), cloud: ( position ) => sky.keyDirectVisibility( position ), seaCloud: ( position ) => sky.cloudVisibility( position ), keyHeight: () => liftedKeyHeight( sky.keyDir, sky.keyIsMoon ), sunElevation: () => sky.elevation, rising: () => sky.rising, clouded: () => cloudedShare( weather.skyMix ), overcast: () => weather.skyMix[ 3 ] ?? 0, moon: () => ( { elevation: sky.moonElevation, skyShare: sky.moonSkyShare } ) } );
	render.ambientRelight = ambientRelight;
	// the environment's own harmonics, which the specular's relight divides by (AmbientSample.ts)
	installEnvironmentHarmonics( ambientRelight );
	// the haze's shadow kernels read the probes' sky visibility, so they compile now (Pipeline.ts)
	render.hazeShadowCompiled = pipeline.compileHazeShadow();
	const ambientView = { mode: ( DEBUG && params.get( 'ambientProbes' ) || 'off' ) as AmbientView };
	render.ambientView = ambientView;
	ambient.show( ambientView.mode, scene );
	const refractedSun = new RefractedSun( renderer, shared );
	render.refractedSun = refractedSun;
	runtime.refractedSun = refractedSun;
	refractedSun.angleGate = THREE.MathUtils.degToRad( render.runtimeQuality.refractedSun.angleGate );
	// the stones', floor's and island parts' triangles under the water come with the chunks (World.ts)
	refractedSun.setCasters( world.group, world.subsets );
	refractedSun.bindTerrain( world.group, waveMaps );
	return refractedSun.prepare();

}

/** The water's surface, over the land's box and what the game holds above it. */
export function createWater( render: RenderParts, { fields, landBox, islandSea, heldOpaque }: { fields: { shore: ConstructorParameters<typeof ShoreWaves>[ 3 ]; floor: ConstructorParameters<typeof ShoreWaves>[ 5 ] }; landBox: ConstructorParameters<typeof Water>[ 0 ][ 'land' ]; islandSea: { readonly openSea: { readonly from: number; readonly to: number }; readonly reflectorTop: number }; heldOpaque: THREE.Box3[] } ) {

	const { quality, renderer, waterScene, rainScene, afterScene, sky, sunShadow, applySkyFill, fft, waveMaps, seaDetail, pipeline, shoreWaves } = render;

	// Storm whitecap foam with a memory, and the spray torn off breaking crests (idle in calm weather).
	const stormSea = new StormSea( renderer, fft, shared, fields.shore, shoreWaves, {
		sunDir: shared.sunDir, sunColor: shared.sunColor,
		sky: shared.skyIrradianceSource.div( shared.skyFill.max( 1 ).sqrt() ),
		// (after the resolve the spray tests the nearest surface, the sea's included: it has no depth buffer)
		sunVisibility: ( p ) => sky.seaKeyVisibility( p ), opaqueDepth: AFTER_RESOLVE ? pipeline.surfaceRT.texture : pipeline.depthRT.texture,
	} );
	render.stormSea = stormSea;
	render.water = new Water( {
		fft, sky, shared, shore: fields.shore, seabedHeight: fields.floor, shoreWaves,
		land: landBox, ...islandSea, sunShadow, storm: stormSea, detail: seaDetail,
		sceneColor: pipeline.opaqueRT.texture, linearDepth: pipeline.depthRT.texture, underwater: pipeline.textures.underwater, quality: quality.water,
		refraction: { color: pipeline.textures.refraction, depth: pipeline.textures.refractionDepth },
	} );
	pipeline.seaLevel.value = shared.waterLevel.value;
	// the boxes held so far (the plants', a game's props shown before the sea was made)
	for ( const box of heldOpaque ) render.water.hold( box );
	// the light under the water follows the long waves the sea's surface shows (WaveMaps.ts)
	waveMaps.attachWaves( { fft, shared, shore: fields.shore, seabedHeight: fields.floor, shoreWaves } );
	applySkyFill();
	waterScene.add( render.water.mesh );
	( AFTER_RESOLVE ? afterScene : TEMPORAL ? rainScene : waterScene ).add( stormSea.spray.mesh );

}

/**
 * The haze's key for the scene, then the environment's bake with it. Returns the bake, which the
 * entry awaits.
 */
export function bakeWithHaze( render: RenderParts ) {

	const { bakeEnvironment } = render;
	// the hour's and the weather's key, written each frame (weather/HazeKeys.ts)
	render.hazeKey = { deck: 0, overcastDeck: 0, amount: 1, sigmaRed: 1, sigmaGreen: 1, sigmaBlue: 1, desaturate: 0, gain: 1, mist: 0, sunRayleigh: 0, rayleighWeight: 1, mieWeight: 1,
		top: 10, width: 50, aerosolShare: 0.035, aerosolHeight: 1400, aerosolTop: Infinity, skyDepth: 0 };
	// the haze exists now: bake the environment again, so it holds the haze every later bake lays over
	// it (Sky.ts `fogEnvironment`) and a fresh load equals a jump
	render.hazeReady = true;
	return bakeEnvironment();

}

/** Returns the warm-up of every pipeline the frame draws with, which the entry awaits. */
export function awaitWarmUp( render: RenderParts ) {

	const { overlayLatents, warming, hazeShadowCompiled, stormSea } = render;

	// The storm's foam and spray need the world's shore fields, so they register (and compile) last;
	// the loop then waits for every first-use pipeline (see "first-use pipelines"), the haze's shadow
	// kernels' included.
	return Promise.all( [ warming, hazeShadowCompiled, stormSea.registerLatent( overlayLatents ) ] );

}

/** Checks that every scene material writes its velocity (the temporal modes, debug only). */
export function checkMotion( render: RenderParts ) {

	const { DEBUG, scene, waterScene, rainScene } = render;

	// The temporal modes' debug check (Motion.ts): the materials whose velocity is missing or partial,
	// for the movers' motion vectors still to come.
	const motionPasses = () => [ { pass: 'opaque', scene, keeps: false }, { pass: 'water', scene: waterScene, keeps: false }, { pass: 'overlay', scene: rainScene, keeps: true } ];
	render.motionPasses = motionPasses;
	if ( DEBUG && TEMPORAL ) console.info( 'motion check', motionCheck( motionPasses() ) );

}

/** Builds the nodes every lit receiver shares, ahead of the first frame. */
export function primeSharedBuilds( render: RenderParts ) {

	const { renderer, scene, camera } = render;
	// the nodes r186 makes inside the first lit build, made by a throwaway one, so the frame's receivers
	// build the same code whichever comes first (three/ThreePatches.ts)
	primeSharedNodes( renderer, scene, camera );

}
