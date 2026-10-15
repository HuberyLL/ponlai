// The page: renderer, camera, sun, GUI, frame loop and diagnostics. On the dev server and with
// ?debug (or ?profile) it hands the scene to the capture and profiling tools as
// `window.__PONLAI__`; among its handles `establishScene( query )` jumps to a whole scene as a fresh
// load of `?<query>` draws it (its contract is written where it is defined, after the frame loop;
// `sceneJump`, the contract's version, tells a capture tool that this page has it: builds without
// it have only the options form, so the tools load a page per view there),
// `loop.stop()` / `loop.start()` hold and resume the frame loop (`dynamicClock` holds the dynamic
// scale's clock with it, for the profiler's A/B) and `loop.step` steps the tick with fixed
// timestamps.
import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';
import { FreeCameraControls, isCameraInputTarget } from './camera/FreeCameraControls.ts';
import { IslandCameraControls } from './camera/IslandCameraControls.ts';
import { Sky } from './sky/Sky.ts';
import { DayCycle, DAY_PRESETS, type DayPreset } from './sky/DayCycle.ts';
import { Weather, WEATHER_PRESETS, isParkedWeather, type WeatherName } from './sky/Weather.ts';
import { ACTIVE_QUALITY, qualityProfile, type QualityProfile, type QualityTier } from './Quality.ts';
import { qualityLines, rememberQuality, QualityDetector } from './QualityDetect.ts';
import { Wind } from './weather/Wind.ts';
import { Rain, setRainShading } from './weather/Rain.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { Caustics } from './ocean/Caustics.ts';
import { Water } from './ocean/Water.ts';
import { StormSea } from './ocean/StormSea.ts';
import { bakeProceduralTextures } from './materials/ProceduralTextures.ts';
import { soilUniforms } from './materials/Soil.ts';
import { buildWorldMeshes } from './world/World.ts';
import { WorldFields } from './world/WorldFields.ts';
import { Growth } from './world/Growth.ts';
import { topFromTiles } from './game/sim/grid.ts';
// first of all that may wait as the modules load: the world's workers start here (WorldStart.ts)
import { worldJob, worldProgress, landOptions, landFraming, worldCacheOn } from './world/WorldStart.ts';
import { buildChunkBorders } from './debug/ChunkBorders.ts';
import { WIND_VIEW } from './debug/WindView.ts';
import { buildWindArrows, windArrowGeometry } from './debug/WindArrows.ts';
import { buildGrass, grassKind, plantGrass, setGrassQuality } from './world/Grass.ts';
import { meadowCanopy } from './lighting/MeadowCanopy.ts';
import { buildTurfSkirt, turfSkirtKind } from './world/RimSkirt.ts';
import { Pipeline, TONE_CURVES, LOOKS, DEFAULT_LOOK, postOptionsFromURL, type ToneCurve, type LookName } from './post/Pipeline.ts';
import { renderPixelRatio, dynamicMaxRatio, outputPixelRatio, OUTPUT_PIXEL_RATIO_CAP } from './post/RenderScale.ts';
import { DynamicResolution, GpuFrameTimer, PassScaling, PeriodicWork, TAAU_MAX_UPSCALE, renderScaleKey } from './post/DynamicResolution.ts';
import { FramePacer } from './post/FramePacer.ts';
import { SubmitBatch } from './post/SubmitBatch.ts';
import { installBindingPatches, installCacheKeyPatches } from './post/graph/ThreePatches.ts';
import { FrameStats } from './debug/FrameStats.ts';
import { shared } from './shared.ts';
import { installOpenShadow } from './lighting/SolarShadow.ts';
import { SunShadow } from './lighting/SunShadow.ts';
import { RefractedSun } from './lighting/RefractedSun.ts';
import { islandSurfaceHeight, landBounds } from './world/WorldShapes.ts';
import { LandLattice } from './world/IslandGrowth.ts';
import { walkLoopDistance, walkPoints } from './world/WalkPath.ts';
import { setIslandClearing } from './weather/AerialPerspective.ts';
import { Villagers, loadVillager } from './characters/Villagers.ts';
import { PROPORTIONS, PROPORTION_NAMES, type ProportionName } from './characters/Proportions.ts';
import { CharacterShadow } from './characters/CharacterShadow.ts';
import { characterLook } from './characters/CharacterMaterial.ts';
import { debugFlags } from './debug/DebugFlags.ts';
import { AA_MODE, AA_SOURCE, AFTER_RESOLVE, QUALITY_CHOICE, TEMPORAL, type AAMode } from './post/Antialiasing.ts';
import type { LatentRegistry } from './post/graph/FrameGraph.ts';
import { MOTION_CLASS, motionCheck, motionState, motionUniforms, onTaaCut, taaCut } from './post/Motion.ts';
import { jitter } from './post/Jitter.ts';
import { restEpoch } from './post/TemporalRest.ts';
import { sceneEvent } from './post/SceneEvents.ts';
import { TemporalAA, type TemporalFrame } from './post/TemporalAA.ts';
import { watchPipelines, type SettleFrame } from './post/Settled.ts';
import { SCENE_RADIANCE_SCALE } from './lighting/Radiometry.ts';
import { debugViewChoices, debugViewFromURL, installDebugView } from './post/graph/DebugView.ts';
import { installVegetationPrepass } from './world/VegetationPrepass.ts';
import { Vegetation } from './world/vegetation/Registry.ts';
import { installWindMotionFlag } from './world/WindMotion.ts';
import { ISLANDER, ISLANDER_LOOKS } from './characters/looks.ts';
import type { Game } from './game/Game.ts';

const params = new URLSearchParams( location.search );
const ground = { soil: params.get( 'soil' ) !== '0' };
soilUniforms.strength.value = ground.soil ? 1 : 0;
// GPU time per pass, tick time and startup marks for tools/profile-frame.mjs (?profile, or
// ?profile=frames without the GPU timestamps). The profiler loads only then; without it the
// renderer, its pipelines and the image are unchanged.
const profiler = params.has( 'profile' ) ? ( await import( './debug/FrameProfiler.ts' ) ).createFrameProfiler( THREE.InspectorBase, { timestamps: params.get( 'profile' ) !== 'frames' } ) : null;
const mark = ( name: string ) => profiler?.mark( name );
// scene handles and frame diagnostics on window, for the capture tool and the console: dev server,
// ?debug or ?profile only
const DEBUG = import.meta.env.DEV || params.has( 'debug' ) || profiler !== null;
// The quality tier (Quality.ts): its load knobs are read below as the parts they shape are built,
// its runtime ones applied by applySkyQuality. A change of tier reloads the page. Without ?quality
// it is the one measured on this GPU (QualityDetect.ts), or high while this load measures. It is
// chosen where the anti-aliasing mode is (post/Antialiasing.ts), since that mode is read as the
// vegetation's modules load, before this code runs.
const qualityChoice = QUALITY_CHOICE;
const qualityTier: QualityTier = qualityChoice.tier;
const quality: Readonly<QualityProfile> = qualityProfile( qualityTier );
const loading = document.getElementById( 'loading' );
const setStatus = ( s: string ) => { const el = loading?.querySelector( 'span' ); if ( el ) el.textContent = s; };

// ------------------------------------------------------------------ renderer

// A dynamic render scale steers by the GPU's frame time, read from timestamp queries
// (`gpuTimer=off` leaves them out: it then steers by the frame intervals, as where they are missing).
const gpuTiming = ( profiler?.timestamps ?? false ) || ( 'dynamic' in quality.render && params.get( 'gpuTimer' ) !== 'off' );
const renderer = new THREE.WebGPURenderer( { antialias: false, powerPreference: 'high-performance', trackTimestamp: gpuTiming } );
if ( profiler ) renderer.inspector = profiler;
await renderer.init();
mark( 'renderer' );
if ( ( renderer.backend as unknown as { isWebGPUBackend?: boolean } ).isWebGPUBackend !== true ) {

	setStatus( 'This scene needs WebGPU (Chrome / Edge 113+, Safari 26+).' );
	throw new Error( 'WebGPU is not available' );

}
// three r186 keys its node builds and pipelines by the first attachment, not the whole layout (an
// MRT picks its outputs by the textures' names): patched before any material builds, so a material
// drawn into two layouts gets a build each (graph/ThreePatches.ts)
// (the temporal modes' scene materials build one shader per MRT: Antialiasing.ts refuses them on a
// revision the patches are not written for, before the renderer exists; failing here for another
// reason, the page stops rather than draw them with another layout's shader outputs)
if ( ! installCacheKeyPatches( renderer ) && TEMPORAL ) {

	setStatus( `aa=${ AA_MODE } needs three's cache keys patched for its MRTs, which failed: load the page without aa=${ AA_MODE }.` );
	throw new Error( `three's cache keys could not be patched for aa=${ AA_MODE }` );

}
// a new render object's texture bindings start at their node's current texture, so a texture the
// growth replaced and disposed is not uploaded again (graph/ThreePatches.ts)
installBindingPatches( renderer );
// three submits every pass on its own; the frame reaches the GPU in a few submits instead
// (SubmitBatch.ts: a submit per pass kept Chrome's GPU process from presenting the page on time)
const submitBatch = new SubmitBatch( ( renderer.backend as unknown as { device: ConstructorParameters<typeof SubmitBatch>[ 0 ] } ).device, { debug: DEBUG } );
// the settled signal counts the async pipeline compiles in flight (post/Settled.ts; debug only)
if ( DEBUG ) watchPipelines( ( renderer.backend as unknown as { device: unknown } ).device );
// every render and compute pipeline the renderer creates, counted for the diagnostics (debug only)
const pipelineCount = DEBUG ? ( await import( './debug/PipelineCounter.ts' ) ).installPipelineCounter( renderer ) : null;

// The scene renders at a pixel ratio set by the quality tier (see RenderScale.ts), at most the
// display's and DPR_CAP (the canvas's cap: native 4K on a 2x display at high's maximum, or `?dpr`);
// the canvas matches the display and the frame graph upscales to it.
// Explicit DPR captures and the full-resolution control lift the tier's pixel budget and pin a
// dynamic scale at its nominal.
const DPR_CAP = params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : OUTPUT_PIXEL_RATIO_CAP;
const resolution = { full: params.has( 'dpr' ), render: '', scale: '', gpu: '–' };
renderer.setPixelRatio( outputPixelRatio( 1 ) );
renderer.setSize( innerWidth, innerHeight );
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
document.getElementById( 'app' )!.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const waterScene = new THREE.Scene();
const rainScene = new THREE.Scene();
// under taa and taau, what draws after the resolve: the rain's streaks and the storm's spray
// (post/AfterResolve.ts)
const afterScene = new THREE.Scene();

// The far plane reaches past the horizon so the sea's skirt meets the sky (the resolved sky
// depth, -1e5, and the passes' sky threshold, -9e4, stay beyond it).
const camera = new THREE.PerspectiveCamera( 27, innerWidth / innerHeight, 1, 60000 );
// The views are framed on the land once the world has loaded (frameLand): the first island's
// framing, moved to the land's centroid and scaled by its size. An explicit `dist` is in metres.
const target = new THREE.Vector3();
// the island's camera: drags follow the hand on the frame that draws them (IslandCameraControls.ts)
const controls = new IslandCameraControls( camera, renderer.domElement );
controls.minDistance = 22;
controls.maxPolarAngle = THREE.MathUtils.degToRad( 82 );
// the island view's pose (the R key, `setCameraView( 'island' )`); a scene jump and a growth step set it anew
const initialCameraPosition = new THREE.Vector3();
const initialCameraQuaternion = new THREE.Quaternion();
const initialCameraFov = camera.fov;
const orbitMaxPolar = controls.maxPolarAngle;
const orbitMinDistance = controls.minDistance;
const freeControls = new FreeCameraControls( camera, renderer.domElement );

// ------------------------------------------------------------------ sky, light, water optics

const sky = new Sky( renderer, { elevation: 32, azimuth: - 8 } );
sky.setEnvironmentSource( quality.environmentSource );
const numberParam = ( name: string, fallback: number, options = params ) => {

	const value = Number( options.get( name ) ?? fallback );
	return Number.isFinite( value ) ? value : fallback;

};
// The scene a query's options set: the weather (held when one is asked for, else evolving on its
// own), the day clock and its preset, the scene clock and the cloud override. The load reads its
// own query with it, and a scene jump (`establishScene`) the query it is given, so the two agree.
// A 48-minute day, as in many open-world games: slow enough to watch the light and the stars
// turn. The game's day is 24 minutes at 1x, so a day's work and its evening fit one sitting.
// The default first-quarter moon lights the evening and sets at midnight, leaving the small
// hours dark enough for the Milky Way. The game starts at 8 (see Game.ts), so the sky is lit
// once for that hour. A parked weather (Weather.ts `PARKED_WEATHER`) is refused outside a debug
// build and falls back to fair; the load and a scene jump read it here alike, and so does ?game,
// whose weather is the page's.
function sceneOptions( options: URLSearchParams ) {

	let weather = options.get( 'weather' ) ?? 'fair';
	const preset = options.get( 'preset' );
	if ( ! DEBUG && isParkedWeather( weather ) ) {

		console.warn( `weather=${ weather } is parked (debug builds only, ?debug): showing fair` );
		weather = 'fair';

	}
	return {
		weather: Object.hasOwn( WEATHER_PRESETS, weather ) ? weather as WeatherName : 'fair',
		autoWeather: ! options.has( 'weather' ),
		day: { hour: numberParam( 'hour', params.has( 'game' ) ? 8 : 16, options ),
			dayLength: Math.max( 30, numberParam( 'dayLength', params.has( 'game' ) ? 1440 : 2880, options ) ),
			paused: options.has( 'paused' ) || options.get( 'clock' ) === 'paused', moonPhase: numberParam( 'moon', 0.25, options ) },
		preset: preset && Object.hasOwn( DAY_PRESETS, preset ) ? preset as DayPreset : null,
		paused: options.has( 'paused' ),
		time: Math.max( 0, numberParam( 't', 0, options ) ),
		// Explicit cloud tuning is a review override; selecting a weather preset restores authored coverage.
		clouds: options.has( 'clouds' ) ? THREE.MathUtils.clamp( numberParam( 'clouds', 0.32, options ), 0, 1 ) : null,
		camera: options.get( 'camera' ) === 'free' ? 'free' : 'orbit',
	};

}
const loaded = sceneOptions( params );
const dayCycle = new DayCycle( loaded.day );
const weather = new Weather( loaded.weather );
const weatherEffects = { rain: true, wetness: true };
weather.auto = loaded.autoWeather;
const requestedPreset = params.get( 'preset' );
if ( loaded.preset ) dayCycle.setPreset( loaded.preset );
let manualSun = false;
let paused = loaded.paused;
let simTime = loaded.time;
const wind = new Wind( shared.wind, { speed: weather.state.windSpeed, heading: weather.state.windDirection, time: simTime } );
// Across a cut of the temporal modes' history (Motion.ts) the vegetation's wind has no motion either:
// its previous state becomes the current one.
if ( TEMPORAL ) onTaaCut( () => wind.cut() );
let rain: Rain | undefined;
let skyElapsed = 0;
let lastSkyTime = simTime;
let lastSkyHour = dayCycle.hour;
let lastWeatherSignature = '';
let cloudOverride: number | null = loaded.clouds;
const skyQuality = { value: qualityTier };
// The tier's runtime knobs (a debug override may replace some of them: `s.applyQuality( { ... } )`).
const runtime = { refractedSun: null as RefractedSun | null };
function applySkyQuality( q: Readonly<QualityProfile> = quality ): void {

	sky.setCloudView( q.cloudView );
	sky.clouds.setDome( q.cloudDome.width, q.cloudDome.height, q.cloudDome.strideX, q.cloudDome.strideY );
	sky.clouds.setMarch( q.cloudMarch );
	sky.clouds.setShadowRefresh( q.cloudShadowRows );
	sky.setEnvironmentCadence( q.environmentEvery );
	rain?.setQuality( q.rainDrops );
	if ( runtime.refractedSun ) runtime.refractedSun.angleGate = THREE.MathUtils.degToRad( q.refractedSun.angleGate );
	runtimeQuality = q;
	sceneEvent( 'apply quality' );

}
let runtimeQuality: Readonly<QualityProfile> = quality;
// A tier change rebuilds materials and the frame graph: reload with the tier and the page's options.
function reloadWithQuality( tier: QualityTier | null ): void {

	const url = new URL( location.href );
	if ( tier ) url.searchParams.set( 'quality', tier );
	else url.searchParams.delete( 'quality' );
	if ( url.searchParams.get( 'autoQuality' ) === 'detect' ) url.searchParams.delete( 'autoQuality' );
	if ( gui._hidden ) url.searchParams.delete( 'gui' );
	else url.searchParams.set( 'gui', '' );
	location.assign( url );

}
applySkyQuality();
scene.add( sky.dome, sky.lightning.group );
scene.environmentIntensity = 1;
const lighting = { skyFill: 1 };

const sun = new THREE.DirectionalLight( 0xffffff, 1 );
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
// The map is fitted to the island's casters once the world exists, and redrawn in small steps of
// the key light with a cross-fade (SunShadow). Its bias, 1 cm along the light ray, follows each
// fit's depth range; receiver-plane correction in the shared filter keeps contacts sharp without
// a wide blur.
sun.shadow.normalBias = 0.012;
const sunShadow = new SunShadow( sun, { bias: 0.01 } );
// compiled into every receiver's material, so set before any is built
sunShadow.setFilter( quality.shadow.surface, quality.shadow.vegetation );
sunShadow.install();
// Cloud shadowing shares the density field in the visible/reflected sky. Bake its long solar
// path once at low resolution, then sample the same transmission on every receiver, including
// those beyond the island's shadow map (the sea floor seen through the water).
installOpenShadow( sun, ( position ) => sky.cloudVisibility( position ) );
// Moving figures cast through a small map of their own that every receiver multiplies in. It
// must be installed before any receiving material is built.
const characterShadow = new CharacterShadow();
characterShadow.install( sun );
// Vegetation casts its rest pose; wind only changes the visible mesh. The key light's steps
// redraw the map; a jump of the light or an edit to the casters redraws it from scratch.
function invalidateSunShadow(): void { sunShadow.invalidate(); }
scene.add( sun, sun.target );

function fresnel( cosI: number, eta: number ): number {

	const g = Math.sqrt( eta * eta - 1 + cosI * cosI );
	const a = ( g - cosI ) / ( g + cosI ), b = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
	return 0.5 * a * a * ( b * b + 1 );

}

let sunUpdates = Promise.resolve();
function prepareSkyState(): void {

	const celestial = manualSun ? null : dayCycle.snapshot();
	sky.setCelestial( celestial );
	const state = weather.snapshot();
	if ( cloudOverride !== null ) state.coverage = cloudOverride;
	sky.setWeather( state );
	sky.track( celestial, state, cloudOverride, weather.front );
	lastWeatherSignature = `${ state.coverage },${ state.density },${ state.directVisibility },${ state.ambientGain },${ state.haze }`;

}

function publishLighting(): void {

	sun.color.copy( sky.keyColor );
	sun.intensity = 1;
	sun.position.copy( sky.keyDir ).multiplyScalar( 120 ).add( sun.target.position );
	shared.sunDir.value.copy( sky.keyDir );
	shared.sunColor.value.set( sky.keyColor.r, sky.keyColor.g, sky.keyColor.b );
	shared.glintScale.value = sky.glintScale;
	const cosI = Math.max( sky.keyDir.y, 0 );
	shared.sunIntoWater.value = sky.keyDir.y > 0 ? 1 - fresnel( cosI, 1.333 ) : 0;
	const eta = 1 / 1.333;
	shared.muSun.value = Math.sqrt( 1 - eta * eta * ( 1 - cosI * cosI ) );
	applySkyFill();

}

async function bakeEnvironment( first = false ): Promise<void> {

	// Explicit preset changes settle any in-flight bake first. The running clock uses a single
	// coalesced request below, never a growing async queue or a suspended animation loop.
	if ( sky.busy ) await sky.update();
	// a scene jump bakes as the page's first bake does (Sky.reset)
	if ( first ) sky.reset();
	prepareSkyState();
	await sky.update();
	scene.environment = sky.envMap!.texture;
	( scene as unknown as { environmentNode: THREE.Node<'vec3'> | null } ).environmentNode = sky.environmentNode;
	publishLighting();
	invalidateSunShadow();
	lastSkyHour = dayCycle.hour;
	lastSkyTime = simTime;
	skyElapsed = 0;

}

function refreshEnvironment(): Promise<void> {

	manualSun = false;
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( () => bakeEnvironment() );
	return sunUpdates;

}

function applySun(): Promise<void> {

	manualSun = true;
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( () => bakeEnvironment() );
	return sunUpdates;

}

const setHour = async ( hour: number ) => { dayCycle.setHour( hour ); sceneEvent( 'set hour' ); await refreshEnvironment(); };
const setPreset = async ( preset: DayPreset ) => { dayCycle.setPreset( preset ); sceneEvent( 'set preset' ); await refreshEnvironment(); };
const setWeather = async ( name: WeatherName, seconds = 20 ) => {

	cloudOverride = null;
	weather.auto = false;
	weather.setWeather( name, seconds );
	sceneEvent( seconds === 0 ? 'weather jump' : 'weather front' );
	if ( seconds === 0 ) await refreshEnvironment();

};
// (a whole scene at once, as a query loads it: `establishScene`, below the frame loop)

function applySkyFill(): void {

	// One artistic fill gain drives PBR ambient, water scattering and sky reflections alike.
	scene.environmentIntensity = lighting.skyFill;
	shared.skyFill.value = lighting.skyFill;
	shared.skyIrradiance.value.set( sky.skyIrradiance.r, sky.skyIrradiance.g, sky.skyIrradiance.b ).multiplyScalar( lighting.skyFill );
	if ( water ) water.uniforms.reflection.value = lighting.skyFill;

}

let water: Water | undefined;

setStatus( 'Lighting the sky…' );
await refreshEnvironment();
mark( 'sky' );
shared.skyIrradianceSource = sky.irradianceNode.mul( shared.skyFill );

const textures = await bakeProceduralTextures( renderer );
// Recover mid-scale wave volume through wind/fetch, while the spectrum still filters fine crests.
// Keep the swell broad and modest so it supports the body without becoming a dominant wave train.
const fft = new OceanFFT( renderer, {
	windSpeed: 3.8, windDirection: 40, fetch: 3500, amplitude: 0.76, choppiness: 0.55, spread: 0.52,
	swell: { height: 0.18 }, anisotropy: quality.water.fftAnisotropy,
} );
const caustics = new Caustics( renderer, fft );
// the veil's shells and the sea's ripple layers are built into the rain's and the water's materials
setRainShading( quality.rainShading );
rain = new Rain( { count: runtimeQuality.rainDrops } );
// Drops scatter the same linear environment and key light as the island, without an emissive
// floor. Using the GPU integral keeps their light in step with the displayed sky transition.
// A strike's fill lights the ground they show in full; the sky they show and reflect takes it
// damped (like the storm spray's), since the displayed deck brightens far less than the fill.
rain.setLightNode( shared.skyIrradianceSource, shared.sunDir, shared.sunColor, shared.skyIrradianceSource.div( shared.skyFill.max( 1 ).pow( 0.35 ) ) );
// `fgview=<resource>[.<output>]` (debug builds): the frame graph's debug view shows one of its
// resources on the canvas (src/post/graph/DebugView.ts): only then it appends its pass to the graph
// before the pipeline compiles it.
const fgview = DEBUG ? debugViewFromURL() : null;
if ( fgview ) installDebugView( fgview, {
	exposure: () => pipeline.settings.exposure / SCENE_RADIANCE_SCALE,
	// (the resolve exists while the pipeline compiles its graph, before `pipeline` is assigned)
	temporal: () => TemporalAA.current,
	motion: {
		previousViewProjection: motionUniforms.previousViewProjection, projectionInverse: jitter.uniforms.unjitteredProjectionInverse,
		jitterNdc: jitter.uniforms.ndc, opaqueBelow: ( MOTION_CLASS.opaque + MOTION_CLASS.vegetation ) / 2,
	},
} );
const pipeline = new Pipeline( renderer, sky, rain, postOptionsFromURL( location.search, quality.post ), quality.taa );
// The ground truth (aa=gt, debug builds) renders at the canvas's resolution (see resize) without
// film grain: an image of the scene alone.
if ( AA_MODE === 'gt' ) pipeline.settings.grain = 0;
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
const requestedTone = params.get( 'tone' ) as ToneCurve | null;
if ( requestedTone && TONE_CURVES.includes( requestedTone ) ) pipeline.setToneMapping( requestedTone );
const requestedLook = params.get( 'look' ) as LookName | null;
pipeline.setLook( requestedLook && LOOKS.includes( requestedLook ) ? requestedLook : DEFAULT_LOOK );
rain.bindOpaqueDepth( pipeline.depthRT.texture, pipeline.surfaceRT.texture );
rainScene.add( rain.group );
if ( rain.afterGroup ) afterScene.add( rain.afterGroup );
// Under the ground truth the rain and the storm's spray draw in the overlay pass (rainScene,
// Pipeline.ts), which keeps the motion vectors of the surfaces under them; under taa and taau they
// draw after the resolve (afterScene, the `rainAfter` pass). Their owners register their latent
// draws for those passes.
const overlayLatents: LatentRegistry = TEMPORAL
	? { latent: ( pass, objects, kernels ) => pipeline.graph.latent( pass === 'rainAfter' || ( pass === 'water' && AFTER_RESOLVE ) ? 'rainAfter' : 'overlay', objects, kernels ) }
	: pipeline.graph;

// ------------------------------------------------------------------ first-use pipelines

// A weather change, the first bolt and the sky's first periodic bake used to build their
// pipelines in the frame they first drew (rain's drops and splashes, the bolt's two passes, the
// sky's blends and filters, the fog's passes: a dropped frame each). They are compiled ahead
// instead, through the async pipeline calls, so the GPU process builds them off the main thread
// while the world is generated and built; the loop starts once they are ready. The frame graph's
// warm-up compiles every pass the frame may run, those that run only at times included (fog, rain,
// the view distance, either output), each under its own binding (its target and MRT are part of
// its pipelines' keys), with the objects their owners register as drawn only at times; the sky and
// the caustics compile their own renders. The storm's foam and spray need the world's shore fields
// and register with it.
const warming = Promise.all( [
	sky.warm( renderer ),
	caustics.warm(),
	// the drops and splashes, and the bolts, registered with the passes they draw in before the
	// graph's warm-up starts, which compiles them with every pass (graph/FrameGraph.ts `warm`)
	rain.registerLatent( overlayLatents ),
	sky.lightning.registerLatent( pipeline.graph ),
	pipeline.graph.warm( { scene, waterScene, rainScene, afterScene: AFTER_RESOLVE ? afterScene : undefined, camera, water: null, sun, time: simTime } ).then( () => pipeline.temporal?.warm() ),
] );
warming.catch( () => undefined ); // reported where it is awaited, before the loop

// ------------------------------------------------------------------ world

worldProgress.show = ( text ) => setStatus( `Generating the island…${ text }` );
worldProgress.show( worldProgress.text );
const t0 = performance.now();
// a failed world must not leave the loading screen saying it is still generating
const worldCache = await worldJob.catch( ( error: unknown ) => {

	setStatus( 'The island failed to generate (see the console).' );
	throw error;

} );
worldProgress.show = null;
const data = worldCache.data;
mark( 'world' );
// The grown land, and the framing it sets (again whenever the island grows: `setLand`).
let land = LandLattice.fromBytes( data.land );
let landBox = landBounds( land );
function measureLand( next: LandLattice ) {

	return { box: landBounds( next ), framing: landFraming( next ) };

}
let { centroid, scale: landScale, onLand } = landFraming( land );
// the land for the tools: its seed and step, box, centroid, the framing's scale against the first
// island and the default pivot
const landInfo = { seed: landOptions.worldSeed, step: landOptions.step, bounds: landBox, centroid, scale: landScale, target: [ 0, 0, 0 ] };
// (`measured`: the land's box and framing found ahead, as Growth.ts's preparation finds them)
function setLand( next: LandLattice, step: number, measured = measureLand( next ) ): void {

	land = next;
	landBox = measured.box;
	( { centroid, scale: landScale, onLand } = measured.framing );
	target.copy( onLand( 1.5, 0.5, 1 ) );
	// the sea fog thins over the island and in its lee
	const fogClearing = onLand( 0, 0, 0 );
	setIslandClearing( fogClearing.x, fogClearing.z, 20 * landScale, 100 * landScale );
	Object.assign( landInfo, { step, bounds: landBox, centroid, scale: landScale, target: target.toArray() } );

}
setLand( land, landOptions.step );
// The world fields' textures (WorldFields.ts), sampled through one node each: the shore's distance
// (its transform is the shared shoreXform), the floor's height and beds over the same bounds, the
// rim ground over its own.
const fields = new WorldFields( data, shared.shoreXform.value );
const shoreWaves = new ShoreWaves( renderer, data, shared, fields.shore, fft );
// The meadow's flowers keep clear of the islander's walking loop, 5 m in from the coast.
const walk = walkPoints( data.walk );
const walkDistance = walkLoopDistance( walk );
const world = buildWorldMeshes( data, textures, shared, caustics, fields );
scene.add( world.group );
// The chunks' borders (GUI Ground folder, ?chunkBorders), built on first show.
const chunkView = { borders: params.has( 'chunkBorders' ), lines: null as THREE.LineSegments | null };
// the version shown (a grown island's, once the island grows)
let shownData = data;
const showChunkBorders = ( on: boolean ) => {

	if ( on && ! chunkView.lines ) scene.add( chunkView.lines = buildChunkBorders( shownData ) );
	if ( chunkView.lines ) chunkView.lines.visible = on;

};
showChunkBorders( chunkView.borders );
// The wind view's arrows (`windView`, debug/WindView.ts), over the land shown: built only on a page
// that shows them, again after the island grows.
let windArrows: THREE.Mesh | null = null;
const showWindArrows = () => {

	if ( ! WIND_VIEW.arrows ) return;
	if ( windArrows ) {

		windArrows.geometry.dispose();
		windArrows.geometry = windArrowGeometry( shownData );

	} else scene.add( windArrows = buildWindArrows( shownData, shared.wind ) );

};
showWindArrows();
const refractedSun = new RefractedSun( renderer, shared );
runtime.refractedSun = refractedSun;
refractedSun.angleGate = THREE.MathUtils.degToRad( runtimeQuality.refractedSun.angleGate );
// the stones', floor's and island parts' triangles under the water come with the chunks (World.ts)
refractedSun.setCasters( world.group, world.subsets );
refractedSun.bindTerrain( world.group );
await refractedSun.prepare();
setGrassQuality( quality.grass );
const grass = buildGrass( plantGrass( data.vegetation, data.rimGround, walkDistance ), shared, sunShadow );
const turfSkirt = buildTurfSkirt( data.rimSkirt, shared );
// The vegetation's kinds (vegetation/Registry.ts), in the order the scene draws them; every list
// of vegetation below reads it.
const vegetation = new Vegetation();
vegetation.add( grassKind( grass, renderer ) );
vegetation.add( turfSkirtKind( turfSkirt ) );
scene.add( ...vegetation.roots() );
installWindMotionFlag( scene );
installVegetationPrepass( scene, vegetation.roots( ( kind ) => kind.prepass ) );
// Everything that casts into the sun's map: the figures cast through their own map, and the sea
// floor's stones only into the refracted one. The game's props grow it (holdOpaque below), and so
// does the island (setSunCasters again at each growth step).
const sunCasters = new THREE.Box3();
// the boxes the game's props hold (holdOpaque), kept over the island's growth
const heldOpaque: THREE.Box3[] = [];
function setSunCasters(): void {

	sunCasters.makeEmpty();
	for ( const root of [ world.group, ...vegetation.roots( ( kind ) => kind.sunCaster ) ] ) {

		root.updateWorldMatrix( true, true );
		root.traverse( ( object ) => { if ( ( object as THREE.Mesh ).isMesh && object.castShadow ) sunCasters.expandByObject( object ); } );

	}
	for ( const box of heldOpaque ) sunCasters.union( box );
	// (the island parts' caster columns come with the chunks, World.ts)
	sunShadow.setCasters( sunCasters, world.columns );

}
setSunCasters();
// the island's terrain is a closed solid: it casts its front faces (SunShadow)
sunShadow.castFrontFaces( world.group );
// the camera grabs the island's ground (the chunks' grids, World.ts) and keeps its pivot over the land
controls.setIsland( world.grounds, landBox );
frameLand();
// Drops stop on the first surface they meet: rock, turf, blades, leaves.
rain.collision.setArea( landBox );
rain.bakeCollision( renderer, [ world.group, ...vegetation.roots( ( kind ) => kind.rainBake ) ] );
mark( 'meshes' );
setStatus( 'Waking the villagers…' );
// A plain islander while the basic look settles (src/characters/looks.ts: bare head, so the
// pointed ears read, linen shirt, plain trousers, leather shoes); the game dresses its islanders
// in the same look's colour variants.
// Its proportions (`islander` URL option, GUI Islander folder) are the medium build of
// Proportions.ts by default: chunkier and stylised, as the people layer of the art asks; the kit's
// own (`stock`) and the other builds stay selectable for comparison.
const islanderBuild = { proportions: ( PROPORTION_NAMES as string[] ).includes( params.get( 'islander' ) ?? '' ) ? params.get( 'islander' ) as ProportionName : 'medium' };
const buildIslander = ( name: ProportionName ) => loadVillager( ISLANDER.base, ISLANDER.parts, shared, PROPORTIONS[ name ] );
// Compiles what `objects` draw in the frame's passes ahead, off the frame: the scene's pass (a latent
// of the frame graph's opaque pass, under its target and MRT: the temporal modes' velocity output is
// part of its pipelines' keys) and then the sun's map, one draw at a time and in the order a frame
// first draws them (the scene's pass, then the map's redraw): a pass into the map shares its
// material's nodes, and compiled the other way round or side by side, the game's chest came out
// shaded differently from the chest drawn without them. The game's props come this way; this also
// uploads their buffers. (A grown island's chunks need none: they draw with the loaded chunks' pipelines.)
async function compileDraws( objects: THREE.Object3D[] ): Promise<void> {

	for ( const object of objects ) await pipeline.graph.latent( 'opaque', [ object ] );
	const compiled = sunShadow.compileCasters( renderer, objects );
	if ( compiled ) await compiled;
	else console.warn( 'The sun\'s shadow map is not built yet: these draws compile their shadow pass when first drawn' );

}
// ?game turns the island into the game: its own islanders and a clock that drives the sky (no
// player interface yet: the GUI's Game folder and window.__PONLAI__.game drive it). Without it
// the scene stays the art-review scene with one islander walking a loop.
const GAME = params.has( 'game' );
let characters: Villagers | null = null;
let game: Game | null = null;
if ( GAME ) {

	// loaded only here, so the art-review page does not carry the game's code
	const { Game } = await import( './game/Game.ts' );
	game = await Game.start( {
		params, scene, camera, canvas: renderer.domElement, land, top: topFromTiles( worldCache.version.chunks ),
		dayCycle, characterShadow, invalidateSunShadow, refreshEnvironment, sceneEvent,
		// the island grows with the population (Growth.ts, made below: called from the frame loop on)
		pieces: landOptions.step,
		island: { approach: ( p ) => growth.approach( p ), grow: () => growth.grow() },
		// A prop can rise above all the island grows (the palm's crown): the sun's map fits its
		// casters and the sea's reflection marches its box, so both grow to hold it.
		holdOpaque: ( box ) => {

			heldOpaque.push( box.clone() );
			if ( ! sunCasters.containsBox( box ) ) sunShadow.setCasters( sunCasters.union( box ) );
			water?.reflectionBounds.union( box );

		},
		// the game's props, for the scene's pass and the sun's map (see compileDraws)
		compileDraws,
		// the game's palms join the vegetation's kinds while they are drawn
		vegetation,
		// every islander in the scene islander's proportions (the `islander` URL option). A figure
		// is handed over once its pipelines are built, off the frame (GameView "First draws"): it
		// arrives after the game's first frame, and each load brings its own material, so the frame
		// that first drew it built its skinned pipelines (the scene's pass, then the figures' map).
		loadLook: async ( look ) => {

			const dress = ISLANDER_LOOKS[ look % ISLANDER_LOOKS.length ];
			const figure = await loadVillager( dress.base, dress.parts, shared, PROPORTIONS[ islanderBuild.proportions ] );
			await pipeline.graph.latent( 'opaque', [ figure.group ] );
			await characterShadow.compile( renderer, scene, figure.group );
			return figure;

		},
	} );

} else {

	characters = new Villagers( await buildIslander( islanderBuild.proportions ), walk, islandSurfaceHeight, characterShadow );
	scene.add( characters.group );

}
mark( 'villagers' );

// Storm whitecap foam with a memory, and the spray torn off breaking crests (idle in calm weather).
const stormSea = new StormSea( renderer, fft, shared, fields.shore, shoreWaves, {
	sunDir: shared.sunDir, sunColor: shared.sunColor,
	sky: shared.skyIrradianceSource.div( shared.skyFill.max( 1 ).sqrt() ),
	// (after the resolve the spray tests the nearest surface, the sea's included: it has no depth buffer)
	sunVisibility: ( p ) => sky.cloudVisibility( p ), opaqueDepth: AFTER_RESOLVE ? pipeline.surfaceRT.texture : pipeline.depthRT.texture,
} );
water = new Water( {
	fft, sky, shared, shore: fields.shore, seabedHeight: fields.floor, shoreWaves,
	seabedLook: { beds: fields.beds, variation: textures.normalsB },
	land: landBox, refractedSun, sunShadow, storm: stormSea,
	sceneColor: pipeline.opaqueRT.texture, linearDepth: pipeline.depthRT.texture, quality: quality.water,
	shadowTaps: quality.shadow.water,
} );
applySkyFill();
waterScene.add( water.mesh );
( AFTER_RESOLVE ? afterScene : TEMPORAL ? rainScene : waterScene ).add( stormSea.spray.mesh );

console.info( `world: ${ worldCache.hits } of ${ worldCache.chunks + 1 } records from the cache (${ worldCache.cache })`, data.timings, 'triangles', world.triangles, 'in', Math.round( performance.now() - t0 ), 'ms' );

// The island grows in place (Growth.ts): the next piece is generated ahead, and a Grow (the GUI's
// Island folder, `__PONLAI__.growth.grow()`) swaps it in, every dependent following. The page's own
// part of a swap: the land's framing and the fog's clearing (setLand), the sea's reflection box and
// the sun's casters (the game's held props kept), the camera's ground; the scene event keeps the
// temporal modes' history (the new land is a change of the scene, which the resolve's clip handles,
// as a placed prop's) and restarts a paused frame's rest.
// (for the diagnostics, which follow a grown island)
const worldInfo = { worldTriangles: world.triangles };
const growth = new Growth( {
	renderer, world, fields, vegetation, shoreWaves, refractedSun, rain, characters, game,
	measure: measureLand,
	onSwap: ( next, version, measured ) => {

		setLand( next, growth.state.step, measured );
		water!.setLand( landBox );
		for ( const box of heldOpaque ) water!.reflectionBounds.union( box );
		setSunCasters();
		controls.setIsland( world.grounds, landBox );
		poseIslandView( islandViewOptions );
		shownData = version;
		sceneEvent( 'world swap' );

	},
	onSwapped: () => {

		// the chunks' borders follow, if built (made again on their next show otherwise)
		if ( chunkView.lines ) {

			scene.remove( chunkView.lines );
			chunkView.lines.geometry.dispose();
			chunkView.lines = null;
			showChunkBorders( chunkView.borders );

		}
		showWindArrows();
		worldInfo.worldTriangles = world.triangles;

	},
	onRise: () => sceneEvent( 'approach' ),
}, worldCache, { seed: landOptions.worldSeed, cache: worldCacheOn } );
// `approach=<0..1>`: the shoal under the next piece put on that progress at once (Growth.ts
// `approachNow`); the loading screen stays up until it is written, so a paused load repeats.
let approachWritten = true;
if ( params.has( 'approach' ) ) {

	approachWritten = false;
	void growth.approachNow( Number( params.get( 'approach' ) ) ).then( () => { approachWritten = true; } );

}

// ------------------------------------------------------------------ GUI

const gui = new GUI( { title: 'Ponlai · lighting & water' } );
// every control, in any folder, bubbles here
gui.onChange( () => sceneEvent( 'gui' ) );
if ( ! params.has( 'gui' ) ) gui.hide();
const S = pipeline.settings;
type CameraView = 'island' | 'horizon' | 'sky';
const cameraSettings = { mode: loaded.camera as string };
const reviewView = { camera: 'island' as CameraView };
// The island view's fov widens as it closes in (IslandCameraControls `widenFov`): `nearFov`
// (degrees) at the closest zoom, from `nearFovFrom` (m) inward; `nearFov=off` keeps the far fov.
const fovWidening = { on: params.get( 'nearFov' ) !== 'off' };
controls.nearFov = numberParam( 'nearFov', controls.nearFov );
controls.widenFrom = numberParam( 'nearFovFrom', controls.widenFrom );
let orbitDof = S.dof;
const viewDirection = new THREE.Vector3();

// The island view on this land: the default pivot, and the camera on its sphere about it at the
// `dist`, `polar` and `az` options (metres, degrees; the distance scaled with the land unless
// given), then a settle within the orbit's limits. At rest the pose depends only on the pivot, the
// position and the limits, so a scene jump (`establishScene`) repeats it on a camera and controls
// of its own with the page's limits, and its pose is the load's to the bit.
function placeOrbit( on: THREE.PerspectiveCamera, orbit: IslandCameraControls, options: URLSearchParams ): void {

	const distance = options.has( 'dist' ) ? Number( options.get( 'dist' ) ) : 58 * landScale;
	orbit.target.copy( target );
	on.position.setFromSphericalCoords( distance, THREE.MathUtils.degToRad( Number( options.get( 'polar' ) ?? 50 ) ), THREE.MathUtils.degToRad( Number( options.get( 'az' ) ?? 318 ) ) ).add( target );
	orbit.settle();

}

function frameLand(): void {

	placeOrbit( camera, controls, params );
	initialCameraPosition.copy( camera.position );
	initialCameraQuaternion.copy( camera.quaternion );

}

// The island view's pose (the R key, `setCameraView( 'island' )`) at the dist / polar / az of
// `options`, placed as the load places it on a camera and controls of its own with the page's
// limits, the camera left where it is: a scene jump's (`establishScene`), and again for the same
// options when the island grows (Growth.ts), so the view frames the land shown.
let islandViewOptions = params;
function poseIslandView( options: URLSearchParams ): void {

	islandViewOptions = options;
	const probe = camera.clone();
	const orbit = new IslandCameraControls( probe, document.createElement( 'div' ) );
	orbit.minDistance = orbitMinDistance;
	orbit.maxDistance = controls.maxDistance;
	orbit.maxPolarAngle = orbitMaxPolar;
	placeOrbit( probe, orbit, options );
	orbit.dispose();
	initialCameraPosition.copy( probe.position );
	initialCameraQuaternion.copy( probe.quaternion );

}

function settleOrbit(): void {

	// Drain residual orbit damping before changing ownership or jumping to a preset.
	controls.settle();

}

function applyOrbitLimit(): void {

	// Orbiting keeps the camera above the sea. The sky view instead turns the camera where it
	// stands: its target sits a few centimetres ahead, so even dragging the view straight up
	// cannot swing the camera round below its target and under the sea.
	const sky = reviewView.camera === 'sky';
	controls.maxPolarAngle = sky ? Math.PI : orbitMaxPolar;
	controls.minDistance = sky ? 0.01 : orbitMinDistance;
	controls.enableZoom = controls.enablePan = ! sky;
	// only the island view widens: the review views and the free flight keep their own fov
	controls.widenFov = fovWidening.on && controls.enabled && reviewView.camera === 'island';

}

// Leaving the widened island view (for the free flight, or with the widening switched off) takes
// back its far fov.
function unwidenFov(): void {

	if ( ! controls.widenFov ) return;
	camera.fov = controls.farFov;
	camera.updateProjectionMatrix();

}

function setCameraMode( mode: string ): void {

	if ( controls.enabled ) settleOrbit();
	if ( mode === 'free' && ! freeControls.enabled ) orbitDof = S.dof;
	if ( mode === 'free' ) unwidenFov();
	if ( mode === 'orbit' && freeControls.enabled ) {

		camera.getWorldDirection( viewDirection );
		controls.target.copy( camera.position ).addScaledVector( viewDirection, 58 * landScale );

	}
	cameraSettings.mode = mode;
	sceneEvent( 'camera mode' );
	controls.enabled = mode === 'orbit';
	freeControls.enabled = mode === 'free';
	// Sharp sky details are essential when inspecting stars and the lunar disk.
	S.dof = freeControls.enabled ? 0 : orbitDof;
	applyOrbitLimit();
	if ( controls.enabled ) controls.settle();
	renderer.domElement.style.cursor = freeControls.enabled ? 'grab' : '';

}

function setCameraView( view: CameraView ): void {

	freeControls.clearInput();
	settleOrbit();
	reviewView.camera = view;
	sceneEvent( 'view jump' );
	if ( view === 'sky' ) {

		camera.position.copy( onLand( 0, 15, 0 ) );
		viewDirection.copy( sky.sunDir.y > 0 ? sky.sunDir : sky.moonDir );
		// At new moon both bodies can be below the horizon; keep the review aimed at the sky.
		if ( viewDirection.y <= 0 ) viewDirection.set( 0.6, 0.72, 0.35 ).normalize();
		controls.target.copy( camera.position ).addScaledVector( viewDirection, 0.05 );
		camera.fov = 65;
		camera.lookAt( controls.target );

	} else if ( view === 'horizon' ) {

		controls.target.copy( target );
		camera.position.setFromSphericalCoords( 110 * landScale, THREE.MathUtils.degToRad( 82 ), THREE.MathUtils.degToRad( 125 ) ).add( target );
		camera.fov = 55;
		camera.lookAt( controls.target );

	} else {

		controls.target.copy( target );
		camera.position.copy( initialCameraPosition );
		camera.quaternion.copy( initialCameraQuaternion );
		camera.fov = controls.farFov = initialCameraFov;

	}
	camera.updateProjectionMatrix();
	applyOrbitLimit();
	if ( controls.enabled ) controls.settle();

}

setCameraMode( cameraSettings.mode );
const cameraF = gui.addFolder( 'Camera' );
cameraF.add( cameraSettings, 'mode', [ 'free', 'orbit' ] ).name( 'camera mode' ).listen().onChange( setCameraMode );
cameraF.add( reviewView, 'camera', [ 'island', 'horizon', 'sky' ] ).name( 'view' ).listen().onChange( setCameraView );
cameraF.add( controls, 'scrollMode', [ 'auto', 'zoom', 'pan' ] ).name( 'scroll / swipe' );
cameraF.add( controls, 'enableDamping' ).name( 'glide and ease' );
cameraF.add( controls, 'edgePan' ).name( 'pan at the edge' );
cameraF.add( freeControls, 'speed', 1, 160, 1 ).name( 'flight speed' ).listen();
// (in the widened island view the slider sets the far fov, which the view takes from `nearFovFrom` out)
cameraF.add( camera, 'fov', 15, 100, 1 ).name( 'field of view' ).listen().onChange( () => {

	if ( controls.widenFov ) controls.farFov = camera.fov;
	camera.updateProjectionMatrix();

} );
cameraF.add( fovWidening, 'on' ).name( 'widen fov up close' ).onChange( () => {

	if ( ! fovWidening.on ) unwidenFov();
	applyOrbitLimit();

} );
cameraF.add( controls, 'nearFov', 27, 60, 1 ).name( 'near fov' );
cameraF.add( controls, 'widenFrom', 22, 150, 1 ).name( 'widen from (m)' );
cameraF.add( { reset: () => setCameraView( 'island' ) }, 'reset' ).name( 'return to island (R)' );
const environmentLook = { exposure: true };
const W = water.uniforms;
// The quality tier sets every knob of the frame's cost (Quality.ts); a change reloads the page. It
// lists the active tiers (high alone while medium and low are parked), and the page's own tier when
// `?quality` loaded a parked one.
const performanceF = gui.addFolder( 'Performance' );
const qualityChoices = ACTIVE_QUALITY.includes( qualityTier ) ? [ ...ACTIVE_QUALITY ] : [ ...ACTIVE_QUALITY, qualityTier ];
performanceF.add( skyQuality, 'value', qualityChoices ).name( 'quality (reloads)' ).onFinishChange( ( tier: QualityTier ) => { if ( tier !== qualityTier ) reloadWithQuality( tier ); } );
// How the tier was chosen (QualityDetect.ts: `?quality` or high; the GPU is not measured while the
// lower tiers are parked).
const autoQuality = qualityLines( qualityTier, qualityChoice.why, qualityChoice.record );
performanceF.add( autoQuality, 'chosen' ).name( 'quality chosen' ).listen().disable();
performanceF.add( resolution, 'full' ).name( 'full resolution' ).onChange( resize );
performanceF.add( pipeline.sharpness, 'value', 0, 2, 0.05 ).name( 'upscale softness' );
// The live readout (FrameStats.ts): the rendered frames' cadence by their rAF timestamps, the render
// scale and the GPU's frame time, refreshed a few times a second while the folder shows (F toggles a
// corner overlay with the same numbers).
const frameStats = new FrameStats();
const statsF = [
	performanceF.add( frameStats.readout, 'fps' ).name( 'fps (1 s)' ),
	performanceF.add( frameStats.readout, 'p95' ).name( 'interval p95' ),
	performanceF.add( frameStats.readout, 'max' ).name( 'interval max' ),
	performanceF.add( frameStats.readout, 'late' ).name( 'late frames' ),
	performanceF.add( frameStats.readout, 'hitches' ).name( 'over 25 ms' ),
	performanceF.add( resolution, 'scale' ).name( 'render scale' ),
	performanceF.add( resolution, 'gpu' ).name( 'GPU (median)' ),
	performanceF.add( resolution, 'render' ).name( 'render → canvas' ),
];
for ( const c of statsF ) c.disable();
performanceF.add( { reset: () => frameStats.reset() }, 'reset' ).name( 'reset counts' );
frameStats.visible = () => ! gui._hidden && ! gui._closed && ! performanceF._closed;
frameStats.onReadout = () => { for ( const c of statsF ) c.updateDisplay(); };
frameStats.extra = () => `scale ${ resolution.scale }   GPU ${ resolution.gpu }`;
// The anti-aliasing mode (post/Antialiasing.ts) is built into materials and the frame graph, so a
// change reloads the page with `aa=` (the older `msaa` alias dropped). It shows the running mode,
// the tier's default or the URL's; `off` is offered in debug builds only, and the ground truth (URL
// only) is listed while it runs.
const antialiasingF = gui.addFolder( 'Antialiasing' );
const aaChoices: Record<string, AAMode> = { 'TAAU': 'taau', 'TAA': 'taa', 'MSAA 4x': 'msaa' };
if ( DEBUG ) aaChoices[ 'Off' ] = 'off';
if ( AA_MODE === 'gt' ) aaChoices[ 'Ground truth' ] = 'gt';
antialiasingF.add( { mode: AA_MODE }, 'mode', aaChoices ).name( 'mode (reloads)' ).onFinishChange( ( mode: AAMode ) => {

	if ( mode === AA_MODE ) return;
	const url = new URL( location.href );
	url.searchParams.set( 'aa', mode );
	url.searchParams.delete( 'msaa' );
	if ( gui._hidden ) url.searchParams.delete( 'gui' );
	else url.searchParams.set( 'gui', '' );
	location.assign( url );

} );
// The temporal resolve's knobs (TemporalAA.ts), live: the tier's `taa` table is where they start. A
// change restarts the rest of a paused scene (the rest's key holds them).
if ( pipeline.temporal ) {

	const T = pipeline.temporal.settings, K = pipeline.temporal.knobs;
	antialiasingF.add( T, 'framesStill', 1, 32, 1 ).name( 'history frames, still' );
	antialiasingF.add( T, 'framesMoving', 1, 32, 1 ).name( 'history frames, moving' );
	antialiasingF.add( T, 'speedFull', 1, 64, 1 ).name( 'moving from (px/frame)' );
	antialiasingF.add( T, 'gammaStill', 0.25, 3, 0.05 ).name( 'clip box, still (sd)' );
	antialiasingF.add( T, 'gammaMove', 0.25, 3, 0.05 ).name( 'clip box, moving (sd)' );
	antialiasingF.add( T, 'sigma', 0.2, 0.8, 0.01 ).name( 'filter sigma (px)' );
	antialiasingF.add( T, 'sigmaRest', 0.2, 0.8, 0.01 ).name( 'filter sigma at rest (px)' );
	antialiasingF.add( T.sharpness, 'taa', 0, 2, 0.05 ).name( 'taa sharpen softness' );
	antialiasingF.add( T.sharpness.taau, '0', 0, 2, 0.05 ).name( 'taau softness at 1:1' );
	antialiasingF.add( T.sharpness.taau, '1', 0, 2, 0.05 ).name( 'taau softness at 2:1' );
	antialiasingF.add( T, 'skyPassThrough' ).name( 'sky without history' );
	antialiasingF.add( K.dofCut, 'value', 0, 1, 0.05 ).name( 'history cut in DoF blur' );
	antialiasingF.add( T, 'restSettle', 0, 32, 1 ).name( 'rest: settle frames' );
	antialiasingF.add( T, 'restSequence', 0, 64, 1 ).name( 'rest: jitter frames' );

}
const groundF = gui.addFolder( 'Ground' );
groundF.add( ground, 'soil' ).name( 'soil layer' ).onChange( ( enabled: boolean ) => {

	soilUniforms.strength.value = enabled ? 1 : 0;
	invalidateSunShadow();

} );
groundF.add( soilUniforms.depth, 'value', 0.5, 1.75, 0.05 ).name( 'soil depth' ).onChange( invalidateSunShadow );
groundF.add( chunkView, 'borders' ).name( 'chunk borders' ).onChange( showChunkBorders );
// The island's growth (Growth.ts): Grow swaps in the next piece once it is generated and prepared.
const islandF = gui.addFolder( 'Island' );
islandF.add( growth.state, 'step' ).name( 'growth step' ).listen().disable();
islandF.add( growth.state, 'phase' ).name( 'next piece' ).listen().disable();
islandF.add( { grow: () => { void growth.grow(); } }, 'grow' ).name( 'Grow' );
// the progress toward the next piece: the shoal eases toward it, or (paused) is put on it at once
islandF.add( growth.rise.state, 'approach', 0, 1, 0.01 ).name( 'Approach' ).listen().onChange( ( value: number ) => {

	if ( paused ) void growth.approachNow( value );
	else growth.approach( value );

} );
const sunF = gui.addFolder( 'Sun' );
const cloudF = gui.addFolder( 'Sky & clouds' );
cloudF.add( sky.clouds.coverage, 'value', 0, 1, 0.01 ).name( 'cloud cover override' ).onFinishChange( ( value: number ) => { cloudOverride = value; void refreshEnvironment(); } );
const weatherF = gui.addFolder( 'Weather' );
const weatherView = { preset: weather.target, seconds: 20 };
// parked weathers are listed in debug builds only (Weather.ts)
weatherF.add( weatherView, 'preset', Object.keys( WEATHER_PRESETS ).filter( ( name ) => DEBUG || ! isParkedWeather( name ) ) ).name( 'weather' ).listen().onChange( ( name: WeatherName ) => { void setWeather( name, weatherView.seconds ); } );
weatherF.add( weatherView, 'seconds', 0, 120, 1 ).name( 'transition seconds' );
weatherF.add( weather, 'auto' ).name( 'auto weather' ).listen();
weatherF.add( weatherEffects, 'rain' ).name( 'rain & ripples' );
weatherF.add( weatherEffects, 'wetness' ).name( 'wet surfaces' );
const timeF = gui.addFolder( 'Time & moon' );
const timeView = { preset: requestedPreset ?? 'golden-hour' };
timeF.add( dayCycle, 'hour', 0, 24, 0.01 ).name( 'hour' ).listen().onFinishChange( refreshEnvironment );
timeF.add( dayCycle, 'dayLength', 30, 7200, 1 ).name( 'seconds per day' );
timeF.add( dayCycle, 'paused' ).name( 'pause clock' ).listen();
timeF.add( timeView, 'preset', Object.keys( DAY_PRESETS ) ).name( 'time preset' ).listen().onChange( ( preset: DayPreset ) => { void setPreset( preset ); } );
timeF.add( dayCycle, 'moonPhase', 0, 1, 0.01 ).name( 'moon phase' ).onFinishChange( refreshEnvironment );
timeF.add( dayCycle, 'advanceMoonPhase' ).name( 'lunar cycle' );
timeF.add( environmentLook, 'exposure' ).name( 'adapt exposure' );
// in the game the simulation owns the time of day (see tick)
if ( game ) for ( const c of timeF.controllers ) if ( c.object === timeView || ( c.object === dayCycle && ( c.property === 'hour' || c.property === 'paused' ) ) ) c.disable();
sunF.add( sky, 'elevation', - 6, 70, 0.5 ).onFinishChange( applySun );
sunF.add( sky, 'azimuth', - 180, 180, 1 ).onFinishChange( applySun );
sunF.add( sky, 'sunIlluminance', 2, 20, 0.1 ).name( 'illuminance' ).onFinishChange( applySun );
sunF.add( sky.atmosphere.mieScale, 'value', 0.1, 2, 0.01 ).name( 'aerosol scattering' ).onFinishChange( applySun );
sunF.add( lighting, 'skyFill', 0, 3, 0.01 ).name( 'sky fill' ).onChange( applySkyFill );
const waterF = gui.addFolder( 'Water' );
const optics = { clarity: 1.0, turbidity: 1.0 };
const baseA = shared.sigA.value.clone(), baseS = shared.sigS.value.clone();
const setOptics = () => {

	shared.sigA.value.copy( baseA ).multiplyScalar( 1 / optics.clarity );
	shared.sigS.value.copy( baseS ).multiplyScalar( optics.turbidity / optics.clarity );

};

waterF.add( optics, 'clarity', 0.3, 3, 0.01 ).onChange( setOptics );
waterF.add( optics, 'turbidity', 0.1, 4, 0.01 ).onChange( setOptics );
waterF.add( W.backscatter, 'value', 0, 0.2, 0.001 ).name( 'backscatter' );
waterF.add( W.roughness, 'value', 0.005, 0.2, 0.001 ).name( 'roughness' );
waterF.add( W.glitter, 'value', 0, 20, 0.1 ).name( 'glitter' );
waterF.add( W.skyCap, 'value', 0, 10, 0.1 ).name( 'sky glare cap (0 = off)' );
waterF.add( W.sheen, 'value', 0, 1, 0.005 ).name( 'sun sheen' );
waterF.add( W.ssr, 'value', 0, 1, 1 ).name( 'SSR' );
const waveF = gui.addFolder( 'Waves' );
const rebuild = () => fft.rebuildSpectrum();
waveF.add( fft.params, 'windSpeed', 1, 14, 0.1 ).onFinishChange( rebuild );
waveF.add( fft.params, 'windDirection', - 180, 180, 1 ).onFinishChange( rebuild );
waveF.add( fft.params, 'amplitude', 0, 3, 0.01 ).onFinishChange( rebuild );
waveF.add( fft.params, 'choppiness', 0, 1.5, 0.01 ).onFinishChange( rebuild );
const islanderF = gui.addFolder( 'Islander' );
const proportionsControl = islanderF.add( islanderBuild, 'proportions', PROPORTION_NAMES ).onChange( async ( name: ProportionName ) => characters?.setWalker( await buildIslander( name ) ) );
// the game's islanders take their build as they load (the `islander` URL option); the scene's
// walker is rebuilt in place
if ( game ) proportionsControl.disable();
// the game's developer controls (GameDebug.ts)
if ( game ) await game.addDebugFolder( gui );
islanderF.add( characterLook.albedo, 'value', 0.05, 1, 0.01 ).name( 'palette exposure' );
islanderF.add( characterLook.sunGain, 'value', 0, 2, 0.01 ).name( 'sun' );
islanderF.add( characterLook.fillGain, 'value', 0, 10, 0.05 ).name( 'shade fill' );
islanderF.add( characterLook.bounceGain, 'value', 0, 3, 0.01 ).name( 'turf bounce' );
islanderF.add( characterLook.formFloor, 'value', 0, 1, 0.01 ).name( 'lit form floor' );
islanderF.add( characterLook.softCloth, 'value', 0.005, 0.4, 0.005 ).name( 'cloth edge' );
islanderF.add( characterLook.softSkin, 'value', 0.005, 0.4, 0.005 ).name( 'skin edge' );
islanderF.add( characterLook.rimGain, 'value', 0, 4, 0.01 ).name( 'sun rim' );
islanderF.add( characterLook.skyRimGain, 'value', 0, 4, 0.01 ).name( 'sky rim' );
islanderF.add( characterLook.shadowSaturation, 'value', 0.5, 2, 0.01 ).name( 'shade saturation' );
const postF = gui.addFolder( 'Post' );
postF.add( S, 'toneMapping', TONE_CURVES ).name( 'tone curve' ).onChange( ( curve: ToneCurve ) => pipeline.setToneMapping( curve ) );
postF.add( S, 'exposure', 0.1, 5, 0.01 );
postF.add( S, 'saturation', 0, 2, 0.01 ).listen();
postF.add( S, 'vibrance', 0, 1, 0.01 ).listen();
postF.add( S, 'contrast', - 0.5, 1, 0.01 ).listen();
postF.add( S, 'split', 0, 1, 0.01 ).name( 'split tone' );
postF.addColor( S, 'lift' );
postF.add( S, 'bloomStrength', 0, 1.5, 0.01 );
postF.add( S, 'bloomThreshold', 0, 5, 0.01 );
postF.add( S, 'bloomMaxLum', 0.5, 50, 0.1 ).name( 'bloom clamp (sky)' );
postF.add( S, 'bloomSurfaceMaxLum', 0.5, 50, 0.1 ).name( 'bloom clamp (surfaces)' );
postF.add( S, 'glowStrength', 0, 1, 0.01 ).name( 'glow' );
postF.add( S, 'glowThreshold', 0, 3, 0.01 ).name( 'glow threshold' );
postF.add( S, 'dof', 0, 1, 0.01 ).name( 'tilt-shift' ).listen();
postF.add( S, 'dofRange', 0, 20, 0.1 );
postF.add( S, 'dofMaxRadius', 0, 20, 0.1 );
postF.add( S, 'vignette', 0, 1, 0.01 );
postF.add( S, 'grain', 0, 0.05, 0.001 );
const lookF = gui.addFolder( 'Look' );
const L = pipeline.look;
lookF.add( S, 'look', LOOKS ).name( 'preset' ).onChange( ( name: LookName ) => pipeline.setLook( name ) );
lookF.add( L, 'glow', 0, 1.5, 0.01 ).name( 'soft glow' ).listen();
lookF.add( L, 'glowThreshold', 0.1, 2, 0.01 ).name( 'glow from' ).listen();
lookF.add( L, 'glowRadius', 0, 1, 0.01 ).name( 'glow spread' ).listen();
lookF.add( L, 'glowWarmth', 0, 1, 0.01 ).name( 'glow warmth' ).listen();
lookF.add( L, 'glowHalo', 0, 1, 0.01 ).name( 'glow into shade' ).listen();
lookF.add( L, 'greenSaturation', - 0.5, 1, 0.01 ).name( 'green saturation' ).listen();
lookF.add( L, 'greenBrightness', - 0.3, 0.5, 0.01 ).name( 'green brightness' ).listen();
lookF.add( L, 'greenHue', - 0.4, 0.4, 0.01 ).name( 'green hue' ).listen();
lookF.add( L, 'tealSaturation', - 0.5, 1, 0.01 ).name( 'water saturation' ).listen();
lookF.add( L, 'tealBrightness', - 0.3, 0.5, 0.01 ).name( 'water brightness' ).listen();
lookF.add( L, 'tealHue', - 0.4, 0.4, 0.01 ).name( 'water hue' ).listen();
lookF.addColor( L, 'shadowTint' ).name( 'shadow colour' ).listen();
lookF.add( L, 'shadowTone', 0, 1, 0.01 ).name( 'shadow tint' ).listen();
lookF.addColor( L, 'highlightTint' ).name( 'highlight colour' ).listen();
lookF.add( L, 'highlightTone', 0, 1, 0.01 ).name( 'highlight tint' ).listen();
lookF.add( L, 'pivot', 0.02, 0.8, 0.01 ).name( 'split pivot' ).listen();
lookF.add( L, 'shadowLift', 0, 0.2, 0.001 ).name( 'shadow lift' ).listen();
lookF.add( L, 'contrast', - 0.3, 0.5, 0.01 ).name( 'depth (contrast)' ).listen();
lookF.add( L, 'vignette', 0, 0.6, 0.01 ).listen();
lookF.add( L, 'sky', 0, 1, 0.01 ).name( 'on the sky' ).listen();
lookF.add( L, 'overcast', 0, 1, 0.01 ).name( 'kept in bad weather' ).listen();
if ( DEBUG ) {

	// The frame graph's debug view (fgview): its choices from the graph's description. The graph
	// compiles once, so a choice reloads the page with it.
	const debugF = gui.addFolder( 'Debug' );
	const view = { fgview: fgview ?? 'off' };
	const choices = [ 'off', ...debugViewChoices( pipeline.graph.describe() ) ];
	if ( ! choices.includes( view.fgview ) ) choices.push( view.fgview );
	debugF.add( view, 'fgview', choices ).name( 'frame-graph view (reloads)' ).onFinishChange( ( value: string ) => {

		const url = new URL( location.href );
		if ( value === 'off' ) url.searchParams.delete( 'fgview' );
		else url.searchParams.set( 'fgview', value );
		url.searchParams.set( 'gui', '' );
		location.assign( url );

	} );
	debugF.close();

}

// ------------------------------------------------------------------ loop

// High's render scale is dynamic (DynamicResolution.ts): it starts at the baseline (the nominal:
// 1440p internal at 4K output), moves between the display's ratio and a floor (1080p) by the GPU's
// frame time, and renders at the baseline while the scene is paused, so paused frames and captures
// render at the scale every trade-off is judged at (pinned, ?dpr or full resolution, at that ratio).
// (the ground truth renders at the canvas's resolution: no dynamic scale)
const dynamicRule = 'dynamic' in quality.render && AA_MODE !== 'gt' ? quality.render.dynamic : null;
// Under TAAU the floor rises so the canvas is at most TAAU_MAX_UPSCALE times the render per axis
// (DynamicResolution.ts; below high's floor, half the canvas's ratio, at a 2x display).
const dynamicResolution = dynamicRule ? new DynamicResolution( { ...dynamicRule, maxUpscale: AA_MODE === 'taau' ? TAAU_MAX_UPSCALE : Infinity } ) : null;
// The tier's frame rate is held on a faster display (FramePacer.ts), which then shows each frame for
// the same number of refreshes, falling back to the next divisor when the dynamic scale's floor
// cannot hold it. `frameRate=auto` is that default; `frameRate=<fps>` holds a fixed rate (0 renders on
// every refresh: the profiler's uncapped runs, where the animation frames' intervals measure the
// work, not a display); `frameFallback=0` keeps 'auto' from falling back (A/B runs). A settings menu
// sets the rate through the pacer (`choices()`, `setRate()`, `mode`, `fps`): `__PONLAI__.pacer` in
// debug builds; a production `?game` menu needs the game to be handed the pacer (not wired yet).
const frameRateParam = params.get( 'frameRate' );
const pacer = new FramePacer( quality.frameRate, {
	rate: frameRateParam === null || frameRateParam === 'auto' ? 'auto' : Number( frameRateParam ),
	allowFallback: params.get( 'frameFallback' ) !== '0',
} );
// the render scale each frame was drawn at and its periodic work (by three's frame id), for the
// GPU times read back later
const frameScales = new Map<number, { scale: number; heavy: number }>();
let gpuTimer: GpuFrameTimer | null = null;
// A load that measures the GPU for its tier (QualityDetect.ts), set up below once the timer is known.
let detector: QualityDetector | null = null;
// which passes follow the render's pixel count: the GPU time's split into a fixed part and one
// that follows the scale
const passScaling = dynamicResolution && gpuTiming ? PassScaling.install( renderer ) : null;
if ( passScaling ) passScaling.graph = pipeline.graph;
if ( dynamicResolution ) {

	const sample = ( frame: number, ms: number, pixel: number ) => {

		detector?.gpu( frame, ms );
		const drawn = frameScales.get( frame );
		if ( drawn !== undefined ) dynamicResolution.sample( ms, drawn.scale, { pixel, heavy: drawn.heavy } );

	};
	// the frame profiler owns the timestamp queries while it times passes
	if ( profiler?.timestamps ) {

		if ( passScaling ) profiler.pixelPass = ( uid ) => passScaling.take( uid );
		profiler.onRecord = ( record ) => { if ( record.missing === 0 && record.passes > 0 ) sample( record.id, record.gpu, record.pixel ); };

	} else if ( passScaling ) {

		gpuTimer = GpuFrameTimer.create( renderer, passScaling );
		if ( gpuTimer ) gpuTimer.onFrame = sample;

	}
	if ( DEBUG ) dynamicResolution.onWarning = ( message ) => console.warn( message );
	// the dynamic scale decides when the pacer falls back to its slower rate and returns
	dynamicResolution.pacer = pacer;

}

// The measuring load holds the dynamic scale at its nominal until it is done, and reads the GPU's
// time from the timer above, or times frames on an idle queue where there is none.
if ( qualityChoice.source === 'detect' ) {

	const queue = ( renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } } ).device.queue;
	const view = () => ( { paused, hidden: document.hidden, scale: renderScale, interval: pacer.rate > 0 ? pacer.interval : 1000 / 60, width: innerWidth, height: innerHeight, cap: DPR_CAP } );
	detector = new QualityDetector( qualityChoice, view, gpuTimer !== null || profiler?.timestamps === true, () => queue.onSubmittedWorkDone(), () => renderer.info.frame );
	if ( dynamicResolution ) dynamicResolution.enabled = false;

}

const canvasSize = new THREE.Vector2();
// High remembers the scale it held (DynamicResolution.ts), except in an automated browser: a
// profile or capture would start where the last run on the same origin ended, so its start-up and
// first decision would depend on run history (QualityDetect.ts skips them for the same reason).
// `drsStore=on` turns it on there (a returning load's test), `off` turns it off anywhere (neither
// restored nor saved: an A/B between modes or builds starts both sides from the nominal scale).
const drsStoreParam = params.get( 'drsStore' );
const scaleMemory = drsStoreParam === 'on' || ( drsStoreParam !== 'off' && ! navigator.webdriver );
let nominalScale = 1, renderScale = 1;
// the render scale `loop.step` holds for the frame it draws (debug only; null otherwise)
let steppedScale: number | null = null;
function resize(): void {

	const w = innerWidth, h = innerHeight;
	nominalScale = renderPixelRatio( w, h, quality.render, resolution.full, DPR_CAP );
	// the ground truth renders at the canvas's ratio, every pixel of it
	if ( AA_MODE === 'gt' ) nominalScale = outputPixelRatio( nominalScale );
	// the dynamic range tops out at the display's ratio, above the baseline it starts from
	if ( dynamicResolution && 'dynamic' in quality.render ) dynamicResolution.setMax( resolution.full ? nominalScale : dynamicMaxRatio( quality.render, DPR_CAP ) );
	renderer.setPixelRatio( outputPixelRatio( nominalScale ) );
	dynamicResolution?.setCanvasRatio( renderer.getPixelRatio() );
	renderer.setSize( w, h );
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	applyRenderScale( true );
	refreshStoreKey();

}

// The key the dynamic scale remembers its scales under (the frame rate's in it): set on a resize and
// whenever the pacer's rate changes (`generation`).
let storeKeyGeneration = NaN;
function refreshStoreKey(): void {

	storeKeyGeneration = pacer.generation;
	if ( scaleMemory ) dynamicResolution?.setStoreKey( renderScaleKey( renderer, qualityTier, AA_MODE, pacer.rate, canvasSize.x, canvasSize.y, gpuTimer !== null || profiler?.timestamps === true ? 'gpu' : 'frames' ) );

}

/** The scale this frame renders at: the dynamic one, unless pinned or paused. */
function currentRenderScale(): number {

	if ( steppedScale !== null ) return steppedScale;
	if ( ! dynamicResolution || resolution.full || paused ) return nominalScale;
	return dynamicResolution.scale;

}

// Sizes the frame graph to the render scale when it changed (a resize sets the canvas first).
function applyRenderScale( force = false ): void {

	const ratio = currentRenderScale();
	if ( ! force && ratio === renderScale ) return;
	renderScale = ratio;
	if ( profiler ) profiler.renderScale = ratio;
	renderer.getDrawingBufferSize( canvasSize );
	const w = innerWidth, h = innerHeight;
	// at the display's ratio the render is the canvas, to the pixel, and nothing is upscaled
	const rw = ratio === renderer.getPixelRatio() ? canvasSize.x : Math.floor( w * ratio );
	const rh = ratio === renderer.getPixelRatio() ? canvasSize.y : Math.floor( h * ratio );
	pipeline.setSize( rw, rh, canvasSize.x, canvasSize.y );
	passScaling?.setSize( rw, rh );
	resolution.render = `${ rw }x${ rh } → ${ canvasSize.x }x${ canvasSize.y }` + ( pipeline.upscaling ? ` (${ Math.round( rw / canvasSize.x * 100 ) } %, FSR)` : '' );
	describeRenderScale();

}

// The GUI's lines: the scale and how it is set, and (dynamic) the GPU's recent frame time.
function describeRenderScale(): void {

	const d = dynamicResolution;
	const how = ! d ? 'fixed' : resolution.full ? 'pinned' : paused ? 'paused' : `${ d.floor }–${ d.max }`;
	resolution.scale = `${ renderScale.toFixed( 2 ) } (${ how })`;
	resolution.gpu = d && d.observed.length ? `${ [ ...d.observed ].sort( ( a, b ) => a - b )[ d.observed.length >> 1 ].toFixed( 1 ) } ms` : '–';

}

// a resize of the canvas cuts the history; resize() itself also serves render-scale changes, which do not
addEventListener( 'resize', () => { sceneEvent( 'resize' ); resize(); } );
resize();
// High starts from the scale it last held on this display, tier and frame rate (remembered in the
// browser, unless `scaleMemory` is off), and settles from there once its first frames are in; a
// load that measures the GPU for its tier measures at the nominal scale.
if ( dynamicResolution && ! detector ) {

	dynamicResolution.restore();
	applyRenderScale();

}

const clock = new THREE.Timer();
clock.connect( document );
let frame = 0;
addEventListener( 'keydown', ( e ) => {

	if ( e.repeat || e.ctrlKey || e.metaKey || e.altKey || isCameraInputTarget( e.target ) ) return;
	if ( e.code === 'Space' ) {

		e.preventDefault();
		// the game pauses its own clock; the sea keeps moving
		if ( game ) game.togglePause();
		else { paused = ! paused; dayCycle.paused = paused; }
		sceneEvent( 'key toggle' );

	}
	if ( e.code === 'KeyH' ) { gui.show( gui._hidden ); sceneEvent( 'key toggle' ); }
	if ( e.code === 'KeyR' || e.code === 'Digit1' ) setCameraView( 'island' );
	if ( e.code === 'Digit2' ) setCameraView( 'horizon' );
	if ( e.code === 'Digit3' ) setCameraView( 'sky' );

} );

const frameTimes: number[] = [];
let shadowElapsed = 0;
// The temporal resolve's per-frame inputs (TemporalAA.ts): what besides the camera, the clock and the
// sizes keys a paused scene's rest (a forced strike: a review sets one while paused, and the rest
// starts over for it), whether the frame may rest (not while a sky bake is in flight or a sky
// transition runs, unless `loop.step` holds the frame still: see `holding`), and its delta.
let strikeKey = 'null', strikeVersion = 0;
// set while `loop.step` holds a frame for the rest to converge (nothing advances, a transition included)
let holding = false;
function strikeSignature(): number {

	const forced = JSON.stringify( ( sky.lightning as unknown as { forced: unknown } ).forced ?? null );
	if ( forced !== strikeKey ) {

		strikeKey = forced;
		strikeVersion ++;

	}
	return strikeVersion;

}
const restStable = () => ! sky.busy && ( ! sky.transitioning || holding );
function temporalFrame( dt: number ): TemporalFrame | undefined {

	if ( ! pipeline.temporal ) return undefined;
	return { signature: [ strikeSignature() ], stable: restStable(), dt };

}
// The settled signal's inputs (post/Settled.ts; debug builds): the rest's, the sun maps' redraw
// counts, and what will still change the frame without changing the key.
let revealed = false;
function settleFrame( bakeDue: boolean ): SettleFrame | undefined {

	if ( ! DEBUG ) return undefined;
	const pending: string[] = [];
	if ( bakeDue ) pending.push( 'sky bake due' );
	if ( refractedSun.pending ) pending.push( 'refracted sun' );
	if ( sunShadow.pending ) pending.push( 'sun shadow' );
	// the loading screen covers the canvas until its fade (index.html) has ended
	if ( ! revealed ) revealed = loading === null || ( loading.classList.contains( 'done' ) && getComputedStyle( loading ).opacity === '0' );
	return { signature: [ strikeSignature(), sunShadow.draws, refractedSun.draws ], stable: restStable(), pending, shown: revealed };

}
function tick( time: number ): void {

	// the frame's own vblank time, not the moment the tick starts: the main thread reaches the tick a
	// few milliseconds into the frame, by a varying amount, which made the scene's steps uneven
	clock.update( time );
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
	if ( paused && game && game.sim.speed !== 0 ) paused = false;
	if ( ! paused ) simTime += dt;
	// In the game the simulation's clock sets the pace of the day (and so of the page's weather).
	const clockDt = game ? game.update( rawDt ) : rawDt;
	// the island's growth: a swap, or one of the frames after it (before the camera and the shadows)
	growth.update( simTime );
	dayCycle.advance( clockDt );
	// the sky shows the simulation's hour, whatever else moved the day clock
	if ( game ) dayCycle.setHour( game.hour() );
	weather.update( paused ? 0 : clockDt );
	weatherView.preset = weather.target;
	if ( freeControls.enabled ) freeControls.update( rawDt );
	else controls.advance( dt, time );

	renderer.info.reset();
	// Sun, moon, key light and grade follow the clock every frame; only the baked reflection,
	// environment and cloud products cross-fade between bakes.
	sky.track( manualSun ? null : dayCycle.snapshot(), weather.state, cloudOverride, weather.front );
	sky.advance( environmentDt );
	publishLighting();
	pipeline.air.haze.value = sky.weather.haze;
	pipeline.air.fog.value = sky.weather.fog;
	pipeline.air.fogOffset.value.copy( shared.wind.displacement.value ).negate();
	pipeline.air.fogTime.value = simTime;
	pipeline.air.keyDir.value.copy( sky.keyDir );
	pipeline.air.keyColor.value.copy( sky.keyColor ).multiplyScalar( 1 - THREE.MathUtils.smoothstep( sky.clouds.coverage.value, 0.7, 0.97 ) );
	pipeline.shafts.setSun( sky.sunDir, sky.sunColor );
	wind.update( paused ? 0 : dt, sky.weather.windSpeed, sky.weather.windDirection );
	// Lightning follows the scene clock, so a paused frame holds its strike; it lights the clouds'
	// march below, so it goes first.
	// (the scene's render size: the canvas is larger while the frame is upscaled)
	sky.lightning.update( simTime, weather.state.storm, camera, pipeline.height, sky.clouds );
	sky.updateClouds( camera, pipeline.width, pipeline.height, shared.wind.cloudOffset.value, shared.wind.direction.value, simTime );
	shared.rain.value = weatherEffects.rain ? sky.weather.rain : 0;
	shared.storm.value = weather.state.storm;
	// A strike lights the island for an instant through the sky's fill: the lit cloud deck adds its
	// radiance to the sky's, so a flash that barely shows by day floods a dark night.
	const skyLuma = sky.skyIrradiance.r * 0.2126 + sky.skyIrradiance.g * 0.7152 + sky.skyIrradiance.b * 0.0722;
	const strikeFill = lighting.skyFill * Math.min( 1 + sky.lightning.fill / Math.max( skyLuma, 1e-5 ), 60 );
	scene.environmentIntensity = strikeFill;
	shared.skyFill.value = strikeFill;
	shared.skyIrradiance.value.set( sky.skyIrradiance.r, sky.skyIrradiance.g, sky.skyIrradiance.b ).multiplyScalar( strikeFill );
	// the page's own wetness, in the game too (soaking and drying on the day clock)
	shared.wetness.value = weatherEffects.wetness ? weather.state.wetness : 0;
	fft.weatherGain.value.copy( shared.wind.oceanGain.value );
	rain!.uniforms.rain.value = shared.rain.value;
	rain!.uniforms.wind.value.copy( shared.wind.velocity.value );
	rain!.uniforms.waterLevel.value = shared.waterLevel.value;
	rain!.update( renderer, camera, simTime, shared.wind.displacement.value, pipeline.height, AFTER_RESOLVE ? pipeline.outputHeight : pipeline.height );
	if ( ! manualSun && environmentLook.exposure ) {

		const state = sky.grade;
		S.exposure = state.exposure;
		S.lift.setRGB( state.blackLift, state.blackLift, state.blackLift * 0.97 );
		S.split = 0.16 + state.daylight * 0.29;
		// The night returns to PBR Neutral's look as the sun sets: none while the sun is up (a low
		// sun's bright sky needs AgX's shoulder), fully from about -3 degrees. AgX's grade darkens a
		// dim frame, so a crossfade held back to -2 .. -6 degrees left the frame up to a fifth darker
		// than PBR Neutral's just after sunset, and darker than the night.
		S.nightLook = 1 - THREE.MathUtils.smoothstep( state.daylight, 0.2, 0.45 );

	}
	// the look's sunlit layers follow the weather's sunlight, as the key light does
	S.lookSunlight = weather.state.directVisibility;
	skyElapsed += environmentDt;
	const skyInterval = runtimeQuality.skyUpdateInterval;
	const ws = weather.state;
	const weatherSignature = `${ cloudOverride ?? ws.coverage },${ ws.density },${ ws.directVisibility },${ ws.ambientGain },${ ws.haze }`;
	if ( ! sky.busy && ! sky.transitioning && skyElapsed >= skyInterval &&
		( simTime !== lastSkyTime || weatherSignature !== lastWeatherSignature || ( ! manualSun && dayCycle.hour !== lastSkyHour ) ) ) {

		skyElapsed = 0;
		lastSkyTime = simTime;
		lastSkyHour = dayCycle.hour;
		prepareSkyState();
		void sky.update( skyInterval ).catch( ( error: unknown ) => console.error( error ) );

	}
	// a periodic bake waits for its interval (the settled signal waits for it too)
	const bakeDue = ! sky.busy && ( simTime !== lastSkyTime || weatherSignature !== lastWeatherSignature || ( ! manualSun && dayCycle.hour !== lastSkyHour ) );
	// The sun's map steps with the key light and cross-fades between steps, so its shadows move
	// smoothly without re-rasterising sub-texel casters every frame. The underwater map keeps the
	// quality cadence.
	sunShadow.update( renderer, scene, camera, sky.keyDir );
	shadowElapsed += environmentDt;
	if ( shadowElapsed >= runtimeQuality.refractedSun.interval && refractedSun.update() ) shadowElapsed = 0;
	shared.time.value = simTime;
	fft.update( paused ? 0 : dt, simTime );
	stormSea.update( simTime, weather.state.storm, camera );
	shoreWaves.update( fft, simTime );
	// Whitewater is disabled in this scene; leave its history idle.
	caustics.update( sky.keyDir );
	characters?.update( renderer, scene, sun, simTime, paused ? 0 : dt );
	game?.render( renderer, sun, paused ? 0 : rawDt );
	S.focusDistance = camera.position.distanceTo( controls.target );
	// (the drops blur by the depth of field in the pixels they are drawn at: the canvas's after the
	// resolve)
	rain!.setFocus( S.focusDistance, S.dofRange, S.dofMaxRadius * ( AFTER_RESOLVE ? pipeline.outputHeight : pipeline.height ) / 900, S.dof );

	// (the ground truth draws the storm's spray with the rain, in the overlay pass; taa and taau draw
	// it with the streaks after the resolve)
	const overlay = ! AFTER_RESOLVE && ( rain!.mesh.visible || ( TEMPORAL && stormSea.spray.mesh.visible ) );
	const after = AFTER_RESOLVE && ( rain!.mesh.visible || stormSea.spray.mesh.visible );
	pipeline.render( { scene, waterScene, rainScene: overlay ? rainScene : undefined, overlay, afterScene: after ? afterScene : undefined, camera, water: water!, sun, time: simTime, temporal: temporalFrame( rawDt ), settle: settleFrame( bakeDue ) } );
	steerRenderScale( rawDt );
	submitBatch.flush();
	frame ++;
	diagnostics();

}

// The periodic work in this frame (PeriodicWork bits): its frames stay out of the dynamic scale's
// quantiles. A periodic sky bake runs its slices in the ticks while the sky is busy, from the one
// that starts it to the one that publishes it.
let skyWasBusy = false;
const periodicCounts = { sunShadow: 0, refractedSun: 0, fogBank: 0 };
function periodicWork(): number {

	let heavy = 0;
	if ( sky.busy || skyWasBusy ) heavy |= PeriodicWork.skyBake;
	skyWasBusy = sky.busy;
	if ( sunShadow.draws !== periodicCounts.sunShadow ) heavy |= PeriodicWork.sunShadow;
	if ( refractedSun.draws !== periodicCounts.refractedSun ) heavy |= PeriodicWork.refractedSun;
	if ( pipeline.air.bankBakes !== periodicCounts.fogBank ) heavy |= PeriodicWork.fogBank;
	periodicCounts.sunShadow = sunShadow.draws;
	periodicCounts.refractedSun = refractedSun.draws;
	periodicCounts.fogBank = pipeline.air.bankBakes;
	return heavy;

}

// After the frame's passes: read the GPU times back and move the dynamic scale (it applies from the
// next frame on). Paused or pinned, the window keeps no samples and the scale holds.
// whether the last rendered frame steered the scale (false again at a loop start)
let steeredLast = false;
function steerRenderScale( rawDt: number ): void {

	if ( ! dynamicResolution ) return;
	if ( pacer.generation !== storeKeyGeneration ) refreshStoreKey();
	// the GPU's budget follows the paced frame interval (a 60 Hz frame unpaced)
	dynamicResolution.setFrameInterval( pacer.rate > 0 ? pacer.interval : 1000 / 60 );
	const steering = steppedScale === null && ! paused && ! resolution.full && renderScale === dynamicResolution.scale;
	frameScales.set( renderer.info.frame, { scale: steering ? renderScale : NaN, heavy: periodicWork() } );
	if ( frameScales.size > 240 ) frameScales.delete( frameScales.keys().next().value! );
	gpuTimer?.resolve();
	if ( steering ) {

		// an interval since a frame that did not steer (or a loop start) spans the break
		if ( steeredLast ) dynamicResolution.sampleInterval( rawDt * 1000 );
		else dynamicResolution.resume();
		dynamicResolution.update();

	}
	steeredLast = steering;
	applyRenderScale();
	if ( frame % 30 === 0 ) describeRenderScale();

}

// The frame graph's state for the diagnostics: whether it is compiled and sized, its variant, its
// passes (declared, culled, and run or skipped in the last frame), its graph-owned textures and
// their memory, and its dev counters.
function graphDiagnostics(): Record<string, unknown> {

	const g = pipeline.graph;
	const d = g.describe();
	const run = d.passes.filter( ( p ) => p.runs ).length;
	return {
		ready: d.ready,
		variant: d.variant,
		passes: d.passes.length,
		culled: d.culled,
		targets: d.resources.filter( ( r ) => ! r.imported ).map( ( r ) => ( { name: r.name, w: r.actual.width, h: r.actual.height, format: r.format, type: r.type, samples: r.samples } ) ),
		bytes: d.bytes,
		rebuilds: d.rebuilds,
		passesRun: run,
		passesSkipped: d.passes.length - d.culled.length - run,
		opsApplied: g.opsApplied,
		opsExpected: g.opsExpected,
		opsMismatchFrames: g.opsMismatchFrames,
		sizeErrors: g.sizeErrors,
	};

}

function diagnostics( now = false ): void {

	if ( ! DEBUG ) return;
	const current = ( window as unknown as Record<string, Record<string, unknown> | undefined> ).__THREE_GAME_DIAGNOSTICS__;
	if ( ! now && frame % 30 !== 1 ) {

		// the temporal resolve's state and the settled signal on every frame: the capture tools wait
		// for them
		if ( current && pipeline.temporal ) current.taa = pipeline.temporal.diagnostics();
		if ( current ) Object.assign( current, { settled: pipeline.settled.value, settle: pipeline.settled.diagnostics() } );
		return;

	}
	const info = renderer.info;
	( window as unknown as Record<string, unknown> ).__THREE_GAME_DIAGNOSTICS__ = {
		frame,
		frameMs: + ( frameTimes.reduce( ( a, b ) => a + b, 0 ) / frameTimes.length ).toFixed( 2 ),
		frameMsP95: + [ ...frameTimes ].sort( ( a, b ) => a - b )[ Math.floor( frameTimes.length * 0.95 ) ].toFixed( 2 ),
		canvas: [ renderer.domElement.width, renderer.domElement.height ],
		render: [ pipeline.width, pipeline.height ],
		upscaled: pipeline.upscaling,
		calls: info.render.drawCalls,
		triangles: info.render.triangles,
		computeCalls: info.compute.frameCalls,
		geometries: info.memory.geometries,
		textures: info.memory.textures,
		dpr: + ( pipeline.width / innerWidth ).toFixed( 4 ), // the render's pixel ratio
		renderScale,
		dynamicResolution: dynamicResolution ? { scale: dynamicResolution.scale, source: dynamicResolution.source, changes: dynamicResolution.changes.length } : null,
		pacing: { target: pacer.target, rate: pacer.rate, mode: pacer.mode, refreshMs: + pacer.period.toFixed( 3 ), divisor: pacer.divisor, base: pacer.base, fallback: pacer.fallen, falls: pacer.falls, returns: pacer.returns, rendered: pacer.rendered, skipped: pacer.skipped },
		submits: { ...submitBatch.stats, why: { ...submitBatch.stats.why } },
		canvasDpr: renderer.getPixelRatio(),
		worldTriangles: worldInfo.worldTriangles,
		timings: data.timings,
		worldCache: worldCache.cache === 'off' ? 'off' : { cache: worldCache.cache, hits: worldCache.hits, chunks: worldCache.chunks, ms: + worldCache.ms.toFixed( 1 ) },
		backend: 'webgpu',
		hour: + dayCycle.hour.toFixed( 4 ),
		clockPaused: dayCycle.paused,
		scalePinned: resolution.full,
		skyBakeMs: + sky.lastBakeMs.toFixed( 2 ),
		skyBusy: sky.busy,
		skyTransitioning: sky.transitioning,
		quality: qualityTier,
		weather: weather.target,
		weatherProgress: + weather.progress.toFixed( 3 ),
		rain: + sky.weather.rain.toFixed( 3 ),
		wetness: + shared.wetness.value.toFixed( 3 ),
		windSpeed: + wind.speed.toFixed( 3 ),
		cameraMode: cameraSettings.mode,
		// the scene's anti-aliasing, the pipelines created so far and the frame graph's state and
		// dev counters, for the clip and first-use tools
		aa: AA_MODE,
		// where the mode came from: the URL (`aa`, `msaa`) or the quality tier's `aa` knob
		aaSource: AA_SOURCE,
		pipelines: pipelineCount?.total ?? 0,
		graph: graphDiagnostics(),
		// the temporal resolve: its mode, the rest (converged, frames, target), the jitter, the history's
		// resets, the input and output sizes and whether reactive inputs are read (TemporalAA.ts)
		taa: pipeline.temporal?.diagnostics() ?? null,
		// whether the paused page will draw the same frame from now on, and why not (post/Settled.ts)
		settled: pipeline.settled.value,
		settle: pipeline.settled.diagnostics(),
	};

}

// The storm's foam and spray need the world's shore fields, so they register (and compile) last;
// the loop then waits for every first-use pipeline (see "first-use pipelines").
await Promise.all( [ warming, stormSea.registerLatent( overlayLatents ) ] );

// The temporal modes' debug check (Motion.ts): the materials whose velocity is missing or partial,
// for the movers' motion vectors still to come.
const motionPasses = () => [ { pass: 'opaque', scene, keeps: false }, { pass: 'water', scene: waterScene, keeps: false }, { pass: 'overlay', scene: rainScene, keeps: true } ];
if ( DEBUG && TEMPORAL ) console.info( 'motion check', motionCheck( motionPasses() ) );

if ( profiler ) {

	const { labelPonlaiPasses } = await import( './debug/FrameProfiler.ts' );
	labelPonlaiPasses( profiler, { scene, waterScene, rainScene, pipeline, sky, rain, sunShadow, refractedSun, fft, stormSea, shoreWaves, caustics, characters } );

}
mark( 'loop' );
const loopBody = profiler ? profiler.wrapLoop( tick ) : tick;
const animationLoop = detector ? ( time: number ) => detector.frame( loopBody, time ) : loopBody;
if ( detector ) detector.onDone = ( record ) => {

	Object.assign( autoQuality, qualityLines( record?.tier ?? qualityTier, record ? 'measured on this load' : detector.why, record ) );
	// its frames were drawn at the nominal scale, so the dynamic scale's first decision follows at once
	if ( dynamicResolution ) dynamicResolution.enabled = true;
	// a lower tier reloads into it (from storage, or by ?quality where nothing can be stored)
	const stored = record !== null && rememberQuality( record );
	if ( record && record.tier !== qualityTier ) reloadWithQuality( stored ? null : record.tier );

};
dynamicResolution?.begin();
// three's loop asks the pacer for its animation frames, so the frames it skips never reach it
const animation = ( renderer as unknown as { _animation: { start(): void; stop(): void; setContext( context: unknown ): void } } )._animation;
animation.setContext( pacer.context );
renderer.setAnimationLoop( animationLoop );
sceneEvent( 'loop start' );
// High's first frames find its render scale behind the loading screen: from the nominal it jumps
// to the scale the GPU's times call for within a second, out of sight (at most REVEAL_WAIT ms).
// The game's islanders show before it lifts too: their figures arrive after the first frames once
// their pipelines are compiled (GameView "First draws"), which on a cold shader cache took seconds.
// So do the sun's shadows: its map draws for the first time once its casters' pipelines exist, a
// few frames in (SunShadow).
const REVEAL_WAIT = 3000;
const revealAt = performance.now() + REVEAL_WAIT;
const reveal = () => {

	const waiting = ! approachWritten || sunShadow.draws === 0 || ( detector !== null && ( detector.pending || ( detector.result !== null && detector.result.tier !== qualityTier ) ) ) || ( game !== null && ! game.ready() ) || dynamicResolution !== null && dynamicResolution.settling && ( gpuTimer !== null || profiler?.timestamps === true ) &&
		! paused && ! resolution.full && performance.now() < revealAt;
	if ( waiting ) setTimeout( reveal, 50 );
	else {

		// A paused page lifts the loading screen at once, without its fade (index.html): the frame
		// holds still, and the captures and reviews of paused frames shoot it as soon as it is
		// ready, which for a temporal rest is about 40 frames after a view's eval, well inside the
		// second the fade takes. A rest shot so showed up to 2 % of the loading screen's colour over
		// the whole image (a converged rest is the canvas alone: TemporalRest.ts).
		if ( paused && loading ) loading.style.transition = 'none';
		loading?.classList.add( 'done' );
		// the counts start where the scene shows
		frameStats.reset();
		// the game's island grows as its people need: its next piece is generated from here on; any
		// other page generates one only once it is asked to grow (Growth.ts)
		if ( GAME ) growth.start();

	}

};
reveal();
// setTime moves the (paused) clock, so captures can step through an animation in one page load
const setTime = ( t: number ) => {

	if ( ! Number.isFinite( t ) || t < 0 ) throw new RangeError( 'Scene time must be finite and non-negative' );
	simTime = t;
	wind.reset( { speed: sky.weather.windSpeed, heading: sky.weather.windDirection, time: t } );
	sceneEvent( 'seek' );
	return refreshEnvironment();

};
// A whole scene at once, as a page loads it (the capture tools' one page per set; the profiler's
// scene switches). `establishScene( query )` (a string or URLSearchParams) leaves the page as a
// fresh load of `?<query>` would draw it, from any scene before: once the caller has rendered a
// frame at the jump's camera and then run what it runs after a load (a view's eval), the paused
// frame equals the fresh load's, to the byte wherever the fresh load repeats itself
// (tools/verify-scene-jump.mjs checks every parity view from several scenes before).
// - The scene's options (SCENE_OPTIONS) come from the query, each one left out at its load default
//   (`sceneOptions`): the weather established (wet in rain; auto weather without `weather`), the day
//   clock (hour or preset, moon phase, day length, paused), the scene clock (`t`, `paused`) and the
//   wind integrated to it, the cloud override.
// - The camera: the orbit's island view at the query's dist / polar / az (`placeOrbit`, as the load
//   places it), the controls' limits and depth of field restored, in the query's camera mode.
// - What the scenes before left behind is cleared: the sky bakes as the page's first bake (Sky.reset:
//   both endpoints and atlases, the clouds as before the first frame), the lightning forgets its
//   strikes, the storm sea its foam window, the islander its clips, the refracted sun its map
//   (back to its size and redrawn at once after the bake, as the load's `prepare` draws it), the
//   fog its bank; the sun's map redraws from scratch and the temporal modes cut their history
//   ('establish scene').
// - Load-time options the query names (quality, aa, dpr, the debug switches: read once when
//   materials and the frame graph are built; the land's `seed`, generated once) must equal the
//   page's own, or it throws: reload instead. `grow` must equal the land step shown (the URL's, or
//   a later one after Grow: a page grown in place draws what a fresh load of that step draws). Those it leaves out are the page's. GUI edits and console changes are not undone.
// The frame after the jump must render at the jump's camera before a view's eval moves it, as a
// fresh load's first frames do before a capture's eval runs: the storm's strikes take their
// bearings ahead of the camera of the frame that first sees them (Lightning.ts), the storm sea
// places its window there (StormSea.ts). (The art-review page only: under ?game the game owns the
// clock.)
// The options form `{ weather?, preset?, hour?, time? }` (tools/profile-frame.mjs) sets what it
// names, keeps the rest and the camera, and clears the leftovers all the same.
// `__PONLAI__.sceneJump` (1) marks a page that keeps this contract: tools/parity/capture-set.mjs
// captures a set in one page only where it is set (older builds' establishScene takes only the
// options form and leaves state behind). Raise it if the contract changes in a way callers see.
const SCENE_OPTIONS = [ 'weather', 'preset', 'hour', 'moon', 't', 'dist', 'polar', 'az', 'camera', 'clouds', 'dayLength', 'paused', 'clock', 'approach' ];
const establishScene = async ( scene: string | URLSearchParams | { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number } ): Promise<void> => {

	const query = typeof scene === 'string' ? new URLSearchParams( scene ) : scene instanceof URLSearchParams ? scene : null;
	if ( query ) {

		// (the land's `grow` against the step shown: a page grown in place draws a fresh load of that step)
		const pageValues = ( key: string ) => key === 'grow' ? [ String( growth.state.step ) ] : params.getAll( key );
		const fixed = [ ...new Set( query.keys() ) ].filter( ( key ) => ! SCENE_OPTIONS.includes( key ) && query.getAll( key ).join( '&' ) !== pageValues( key ).join( '&' ) );
		if ( fixed.length ) throw new Error( `establishScene: ${ fixed.join( ', ' ) } differ from the page's and are read once at load: reload the page with them` );
		const next = sceneOptions( query );
		cloudOverride = next.clouds;
		weather.establish( next.weather );
		weather.auto = next.autoWeather;
		dayCycle.reset( next.day );
		if ( next.preset ) dayCycle.setPreset( next.preset );
		timeView.preset = query.get( 'preset' ) ?? 'golden-hour';
		paused = next.paused;
		simTime = next.time;
		// the island view's pose, placed as the load places it, on a camera and controls of its own
		poseIslandView( query );
		controls.clearInput();
		setCameraMode( 'orbit' );
		setCameraView( 'island' );
		if ( next.camera === 'free' ) setCameraMode( 'free' );
		// the shoal at the query's approach (0 without one), put on it at once
		await growth.approachNow( Number( query.get( 'approach' ) ?? 0 ) );

	} else {

		const options = scene as { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number };
		cloudOverride = null;
		if ( options.weather ) {

			weather.auto = false;
			weather.establish( options.weather );

		}
		if ( options.preset ) dayCycle.setPreset( options.preset );
		else if ( options.hour !== undefined ) dayCycle.setHour( options.hour );
		if ( options.time !== undefined ) simTime = options.time;

	}
	wind.reset( { speed: weather.state.windSpeed, heading: weather.state.windDirection, time: simTime } );
	sky.lightning.reset();
	stormSea.reset();
	characters?.reset();
	pipeline.air.invalidate();
	shadowElapsed = 0;
	// a fresh load starts at the held frame rate, not at a fallback the last scene fell to
	pacer.reset();
	sceneEvent( 'establish scene' );
	manualSun = false;
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( () => bakeEnvironment( true ) );
	await sunUpdates;
	// The underwater map at its constructed size, drawn now for the jump's light (published by the
	// bake), as the load's `prepare` draws it before the first frame. Left to the loop's cadence
	// (wall time) a capture ready within a few frames shot the cleared map: the sea without its
	// refracted sun.
	refractedSun.reset();
	refractedSun.update();

};
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
		await ( renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } } ).device.queue.onSubmittedWorkDone();

	},
	start(): void {

		hiddenStop = false;
		if ( loop.running ) return;
		loop.running = true;
		steeredLast = false;
		sceneEvent( 'loop start' );
		clock.reset();
		animation.start();

	},
};
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
// - a periodic bake reads its sky irradiance back from the GPU (`Sky.skyIrradiance`, which sets a
//   lightning strike's fill light), at most every 2 s of wall clock and landing whenever the GPU
//   answers: stepped, every bake reads it back and the next frame waits for the value, so it
//   lands on the frame after the bake however long the frames took.
// - `converge( i )` (the temporal modes' ground truth, capture-clip.mjs --aa gt): after frame i's tick
//   the scene is held still (the clock paused, nothing advancing with time: a delta of 0, the sky's
//   transitions and wall-clock cadences included) and rendered again until the temporal rest has
//   converged on it (TemporalRest.ts), so `onFrame( i )` sees frame i's scene averaged over the rest's
//   jitters. The clock and the cadences continue afterwards as if the hold had not happened.
interface StepOptions {
	frames: number;
	dt?: number;
	scale?: number | number[];
	camera?: ( i: number ) => void;
	onFrame?: ( i: number ) => Promise<void> | void;
	clock?: 'paused' | 'running';
	converge?: ( i: number ) => boolean;
}
const step = async ( options: StepOptions ): Promise<{ frames: number; t0: number; simTime: number; frameId: number }> => {

	const { frames, dt = 1 / 60, scale, camera: moveCamera, onFrame, clock: clockMode, converge } = options;
	if ( ! Number.isInteger( frames ) || frames < 0 ) throw new RangeError( 'frames must be a whole number, 0 or more' );
	if ( ! Number.isFinite( dt ) || dt <= 0 ) throw new RangeError( 'dt must be finite and positive' );
	const scales = scale === undefined ? [] : Array.isArray( scale ) ? scale : [ scale ];
	if ( scales.some( ( s ) => ! Number.isFinite( s ) || s <= 0 ) ) throw new RangeError( 'scale must be positive' );
	await loop.stop();
	if ( clockMode !== undefined ) {

		paused = clockMode === 'paused';
		dayCycle.paused = paused;

	}
	const r = renderer as unknown as { _nodes: { nodeFrame: { update(): void; frameId: number } }; _inspector: { isRunning?: boolean; begin(): void; finish(): void } };
	const nodeFrame = r._nodes.nodeFrame, inspector = r._inspector;
	const timer = clock as unknown as { update( time?: number ): unknown; getDelta(): number };
	timer.update = () => timer;
	timer.getDelta = () => dt;
	const skyBake = sky as unknown as { slices: unknown[]; sliceTimer: ReturnType<typeof setTimeout> | null; pendingUpdate: Promise<void> | null;
		diagnosticPending: boolean; lastDiagnosticMs: number };
	// the sky irradiance readback in flight, if any, has landed (it resolves once the GPU answers;
	// a map is not expected to take seconds, so a hang is reported rather than waited out)
	const settleSkyReadback = async (): Promise<void> => {

		const start = performance.now();
		while ( skyBake.diagnosticPending ) {

			if ( performance.now() - start > 10000 ) throw new Error( 'loop.step: the sky irradiance readback did not land within 10 s' );
			await new Promise( ( resolve ) => setTimeout( resolve, 0 ) );

		}

	};
	await settleSkyReadback();
	( sky.clouds as unknown as { frame: number } ).frame = 0;
	skyElapsed = 0;
	shadowElapsed = 0;
	const t0 = Math.round( performance.now() );
	try {

		// one tick of the loop at `time`, with the bookkeeping three's animation loop does around it
		const tickAt = async ( time: number ): Promise<void> => {

			// every bake this frame reads its irradiance back (no wall-clock throttle)
			skyBake.lastDiagnosticMs = - Infinity;
			// three's Animation does this before each frame of its loop
			if ( inspector.isRunning ) inspector.finish();
			if ( renderer.info.autoReset ) renderer.info.reset();
			nodeFrame.update();
			( renderer.info as { frame: number } ).frame = nodeFrame.frameId;
			inspector.begin();
			// (the frame's size follows `steppedScale` from this tick's start: applyRenderScale)
			applyRenderScale();
			loopBody( time );
			inspector.finish();
			if ( skyBake.sliceTimer !== null ) {

				clearTimeout( skyBake.sliceTimer );
				skyBake.sliceTimer = null;

			}
			await settleSkyReadback();

		};
		for ( let i = 0; i < frames; i ++ ) {

			if ( sky.busy && skyBake.slices.length === 0 ) await skyBake.pendingUpdate?.catch( () => {} );

			// never above the canvas's ratio: the render would outgrow the canvas it is shown on
			const ratio = scales.length ? scales[ Math.min( i, scales.length - 1 ) ] : nominalScale;
			steppedScale = Math.min( ratio, renderer.getPixelRatio() );
			moveCamera?.( i );
			await tickAt( t0 + i * dt * 1000 );
			const temporal = pipeline.temporal;
			if ( temporal && converge?.( i ) ) {

				// hold the frame's scene still until the rest has converged on it
				const was = { paused, day: dayCycle.paused, skyElapsed, shadowElapsed };
				paused = true;
				dayCycle.paused = true;
				holding = true;
				timer.getDelta = () => 0;
				try {

					for ( let k = 0; k < temporal.rest.target + 4 && ! temporal.converged; k ++ ) {

						if ( sky.busy && skyBake.slices.length === 0 ) await skyBake.pendingUpdate?.catch( () => {} );
						await tickAt( t0 + i * dt * 1000 );

					}

				} finally {

					timer.getDelta = () => dt;
					holding = false;
					paused = was.paused;
					dayCycle.paused = was.day;
					skyElapsed = was.skyElapsed;
					shadowElapsed = was.shadowElapsed;

				}
				if ( ! temporal.converged ) console.warn( `loop.step: frame ${ i } did not converge (the rest's ${ temporal.rest.frames } of ${ temporal.rest.target } frames)` );

			}
			await onFrame?.( i );

		}

	} finally {

		delete ( timer as Partial<typeof timer> ).update;
		delete ( timer as Partial<typeof timer> ).getDelta;
		steppedScale = null;
		applyRenderScale();
		diagnostics( true );

	}
	return { frames, t0, simTime, frameId: renderer.info.frame };

};

if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__PONLAI__ = { land: landInfo, renderer, scene, camera, controls, freeControls, cameraSettings, setCameraMode, setCameraView, sky, sun, fft, shoreWaves, stormSea, caustics, water, pipeline, shared, refractedSun, grass, meadowCanopy, turfSkirt, characters, game, soilUniforms, dayCycle, weather, weatherEffects, wind, rain, setWeather, establishScene, sceneJump: 1, applySun, refreshEnvironment, setHour, setPreset, sunShadow, invalidateSunShadow, setTime, clockTime: () => simTime, nominalScale: () => nominalScale, loop: Object.assign( loop, { step } ), pipelines: pipelineCount, flags: debugFlags,
	// the wind's numbers for the vegetation (debug/WindProbe.ts), loaded on first call
	windProbe: async ( options?: Record<string, unknown> ) => ( await import( './debug/WindProbe.ts' ) ).windProbe( { renderer, scene, shared, wind, sky, fft, establishScene, data: () => shownData, vegetation }, options ),
	// the island's growth: grow(), state, chunkHashes(), and the world fields' GPU bytes
	growth: Object.assign( growth, { fieldBytes: () => fields.bytes() } ),
	quality, dynamicResolution, pacer, submitBatch, jitter, motion: motionState, taaCut, motionCheck: () => motionCheck( motionPasses() ), applyQuality: ( overrides: Partial<QualityProfile> ) => applySkyQuality( { ...quality, ...overrides } ),
	// the temporal resolve (TemporalAA.ts, TemporalRest.ts): its live settings and knobs, the rest, the
	// epoch, and `restart()`, which starts the history and the rest over (a cut and an epoch bump)
	taa: pipeline.temporal ? {
		resolve: pipeline.temporal, settings: pipeline.temporal.settings, knobs: pipeline.temporal.knobs, rest: pipeline.temporal.rest, epoch: restEpoch,
		get converged() { return pipeline.temporal!.converged; },
		restart: () => sceneEvent( 'restart' ),
	} : null,
	// the profiler's A/B (profile-frame --compare): while it keeps this page stopped for the other
	// page's slices, the dynamic scale's clock stands still (DynamicResolution.ts `clock`), so its
	// holds and bars do not run out while the page draws nothing
	dynamicClock: dynamicResolution ? dynamicClock( dynamicResolution ) : null };
// The debug hook above: `suspend()` holds the controller's clock where it is, `resume()` lets it run
// on from there (the time between is skipped).
function dynamicClock( d: DynamicResolution ): { suspend(): void; resume(): void; readonly suspended: boolean } {

	let skipped = 0, since = NaN;
	return {
		suspend() {

			if ( ! Number.isNaN( since ) ) return;
			since = performance.now() / 1000;
			const held = since - skipped;
			d.clock = () => held;

		},
		resume() {

			if ( Number.isNaN( since ) ) return;
			skipped += performance.now() / 1000 - since;
			since = NaN;
			d.clock = () => performance.now() / 1000 - skipped;

		},
		get suspended() { return ! Number.isNaN( since ); },
	};

}
