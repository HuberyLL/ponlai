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
import { FramingGlide, IslandTurn, frameIsland, landFitDistance, landOutline } from './camera/IslandFraming.ts';
import { Sky } from './sky/Sky.ts';
import { DayCycle, DAY_PRESETS, nightAmbientShare, sunRising, type DayPreset } from './sky/DayCycle.ts';
import { Weather, WEATHER_PRESETS, WIND_LEVELS, cloudedShare, deckLight, deckSkyGain, deckSkyGap, isParkedWeather, isWindLevel, type WeatherName, type WeatherState, type WindChoice, type WindLevel } from './sky/Weather.ts';
import { ACTIVE_QUALITY, qualityProfile, type QualityProfile, type QualityTier } from './Quality.ts';
import { qualityLines, rememberQuality, QualityDetector } from './QualityDetect.ts';
import { keyDeckShare } from './lighting/KeyCloud.ts';
import { Wind, weatherWind } from './weather/Wind.ts';
import { Rain, setRainShading } from './weather/Rain.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { seaState } from './ocean/OceanSpectrum.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { WaveMaps } from './ocean/WaveMaps.ts';
import { SeaDetail } from './ocean/SeaDetail.ts';
import { showUnderwater } from './ocean/Refraction.ts';
import { Wenyao } from './life/Wenyao.ts';
import { FallingLeaves } from './weather/FallingLeaves.ts';
import { Water, keyChroma, updateShelfScatter } from './ocean/Water.ts';
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
import { buildGrass, grassKind, plantGrass } from './world/Grass.ts';
import { buildYunpeng, yunpengKind, yunpengNight } from './world/Yunpeng.ts';
import { updateLeafLight } from './world/vegetation/LeafLight.ts';
import { updateSwardTint } from './materials/SwardTint.ts';
import { meadowCanopy } from './lighting/MeadowCanopy.ts';
import { Pipeline, postOptionsFromURL, WHITE_BALANCE } from './post/Pipeline.ts';
import { LOCAL_TONE } from './post/LocalTone.ts';
import type { HazeFrame } from './weather/VolumetricHaze.ts';
import { hazeKeyAt, type HazeKey } from './weather/HazeKeys.ts';
import type { GradeChanges } from './post/GradeLut.ts';
import { renderPixelRatio, dynamicRange, outputPixelRatio, OUTPUT_PIXEL_RATIO_CAP } from './post/RenderScale.ts';
import { DynamicResolution, GpuFrameTimer, PassScaling, PeriodicWork, TAAU_MAX_UPSCALE, renderScaleKey } from './post/DynamicResolution.ts';
import { FramePacer } from './post/FramePacer.ts';
import { SubmitBatch } from './post/SubmitBatch.ts';
import { installBindingPatches, installCacheKeyPatches, primeSharedNodes } from './post/graph/ThreePatches.ts';
import { FrameStats } from './debug/FrameStats.ts';
import { shared } from './shared.ts';
import { installOpenShadow } from './lighting/SolarShadow.ts';
import { SunShadow } from './lighting/SunShadow.ts';
import { RefractedSun } from './lighting/RefractedSun.ts';
import { GroundBounce, installGroundBounce } from './lighting/GroundBounce.ts';
import { AMBIENT_KNOBS, ambientGrade } from './lighting/AmbientGrade.ts';
import { localLights, testSources } from './lighting/LocalLights.ts';
import { liftedKeyDirection, liftedKeyHeight, updateKeyLift } from './lighting/KeyLift.ts';
import { keyGlint } from './lighting/SurfaceBRDF.ts';
import { AmbientVolume, type AmbientView } from './lighting/AmbientVolume.ts';
import { installAmbientVolume, installEnvironmentHarmonics } from './lighting/AmbientSample.ts';
import { AmbientRelight, AmbientSky, lowSunSkyLift } from './lighting/AmbientRelight.ts';
import { islandSurfaceHeight, landBounds } from './world/WorldShapes.ts';
import { LandLattice } from './world/IslandGrowth.ts';
import { walkPoints } from './world/WalkPath.ts';
import { bambooKinds, buildBamboo } from './world/Bamboo.ts';
import { loadBambooLook } from './world/BambooGroves.ts';
import { leafAtlas as bambooAtlas, singleLeaf } from './world/BambooMaterials.ts';
import { Villagers, loadVillager } from './characters/Villagers.ts';
import { Trample } from './world/vegetation/Trample.ts';
import { PROPORTIONS, PROPORTION_NAMES, type ProportionName } from './characters/Proportions.ts';
import { parseBodies, type Body, type Sex } from './characters/Ages.ts';
import { CharacterShadow } from './characters/CharacterShadow.ts';
import { characterLook } from './characters/CharacterMaterial.ts';
import { debugFlags } from './debug/DebugFlags.ts';
import { TEST_MODE } from './debug/TestMode.ts';
import { tune, tuneApi } from './debug/Tune.ts';
import { markSkyRetune, skyRetune } from './sky/SkyRetune.ts';
import { AA_MODE, AA_SOURCE, AFTER_RESOLVE, QUALITY_CHOICE, TEMPORAL, type AAMode } from './post/Antialiasing.ts';
import type { LatentRegistry } from './post/graph/FrameGraph.ts';
import { MOTION_CLASS, motionCheck, motionState, motionUniforms, onTaaCut, taaCut } from './post/Motion.ts';
import { jitter } from './post/Jitter.ts';
import { restEpoch } from './post/TemporalRest.ts';
import { PRE_EXPOSURE_PENDING, preExposure } from './post/PreExposure.ts';
import { sceneEvent } from './post/SceneEvents.ts';
import { TemporalAA, type TemporalFrame } from './post/TemporalAA.ts';
import { watchPipelines, type SettleFrame } from './post/Settled.ts';
import { SCENE_RADIANCE_SCALE, MOON_GLINT_RADIUS } from './lighting/Radiometry.ts';
import { SUN_GLINT_DISC } from './lighting/SunDisc.ts';
import { debugViewChoices, debugViewFromURL, installDebugView } from './post/graph/DebugView.ts';
import { installVegetationPrepass, prepassScene } from './world/VegetationPrepass.ts';
import { displacementField } from './world/vegetation/Displacement.ts';
import { installOpaquePrepass, opaquePrepassScene } from './world/OpaquePrepass.ts';
import { GTAO, gtaoUniforms } from './post/GTAO.ts';
import { SS_SHADOW } from './post/MeadowShade.ts';
import { Vegetation } from './world/vegetation/Registry.ts';
import { installWindMotionFlag } from './world/WindMotion.ts';
import { HANMING, HANMING_LOOKS, ISLANDER, ISLANDER_LOOKS } from './characters/looks.ts';
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
// The views are framed on the land once the world has loaded (frameLand): the island view just
// holds the land and its ring of shallows (IslandFraming.ts); the others take the first island's
// framing, moved to the land's centroid and scaled by its size. An explicit `dist` is in metres.
const target = new THREE.Vector3();
// the island's camera: it starts at the island view's pose and the hand moves it (pans within the
// land's soft bounds, turns, tilts and zooms out from the island view's framing to 70 m or the
// framing's own distance, never in past the framing: IslandCameraControls.ts), the
// drags followed on the frame that draws them; `cameraInput=off` (or the GUI's 'move by hand')
// holds the view at its framing
const controls = new IslandCameraControls( camera, renderer.domElement );
controls.handInput = params.get( 'cameraInput' ) !== 'off';
controls.minDistance = 22;
controls.maxPolarAngle = THREE.MathUtils.degToRad( 82 );
// the island view's pose (the R key, `setCameraView( 'island' )`); a scene jump, a growth step and
// a resize set it anew
const initialCameraPosition = new THREE.Vector3();
const initialCameraQuaternion = new THREE.Quaternion();
const initialCameraTarget = new THREE.Vector3();
// the camera's glide to the island view's new framing when the land grows
const framingGlide = new FramingGlide();
// the island view's input: a turn about its pivot (Q / E, a right or middle drag) and a zoom (the
// wheel); how far it has turned from the query's heading (rad), and its zoom (0 the farthest, 1
// the nearest: IslandFraming.ts)
const islandTurn = new IslandTurn( renderer.domElement );
// (the island view never zooms in past its framing, held or by hand: `islandNearest`)
islandTurn.wheelZoom = 0;
let islandTurned = 0, islandZoom = 0;
const initialCameraFov = camera.fov;
const orbitMaxPolar = controls.maxPolarAngle;
const orbitMinDistance = controls.minDistance;
// the island view's nearest zoom: its pose's own distance (frameLand, poseIslandView), so the
// hand zooms out from the framing but never in past it; the review views keep `orbitMinDistance`
let islandNearest = orbitMinDistance;
// The island view starts where it frames the land alone (without its ring of shallows) from its own
// heading, looking 50 degrees down (`polar` 40): the whole island in view with a margin of sea, the
// ground read as a map while the cliff's depth still shows (IslandFraming.ts `landFitDistance`).
// Framing the shallows too, or the land from every heading, stood half as far again and left the
// island small in the frame; a fixed 45 m held the first island of 400 m^2 but not one of 1000.
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
// whose weather is the page's. The wind (Weather.ts) takes `wind` (a level) and `windDir` (a
// heading, degrees in WeatherState's convention), each over the sky's own wind; naming the
// weather or either of them holds the weather, its wind included.
function sceneOptions( options: URLSearchParams ) {

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
		day: { hour: numberParam( 'hour', params.has( 'game' ) ? 8 : 16, options ),
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
const dayCycle = new DayCycle( loaded.day );
const weather = new Weather( loaded.weather, loaded.wind );
const weatherEffects = { rain: true, wetness: true };
weather.auto = loaded.autoWeather;
// The land's floor under a deck per clouded sky (Weather.ts `deckFloor`), tunable on debug pages
// without a reload: the presets the weather moves between take it, and the state that stands on
// that sky follows (`setDeckFloor`). A `?tune=` value is the start, applied here as a load would.
for ( const name of [ 'cloudy', 'overcast' ] as const ) {

	const floor = tune( `sky.deckFloor@${ name }`, WEATHER_PRESETS[ name ].deckFloor, { min: 0, max: 1, onChange: ( value ) => {

		weather.setDeckFloor( name, value );
		markSkyRetune();

	} } );
	weather.setDeckFloor( name, floor() );

}
const requestedPreset = params.get( 'preset' );
if ( loaded.preset ) dayCycle.setPreset( loaded.preset );
let manualSun = false;
let paused = loaded.paused;
let simTime = loaded.time;
const wind = new Wind( shared.wind, { ...weatherWind( weather.state ), time: simTime } );
// Across a cut of the temporal modes' history (Motion.ts) the vegetation's wind has no motion either:
// its previous state becomes the current one.
if ( TEMPORAL ) onTaaCut( () => wind.cut() );
// The islanders' trail through the meadow (world/vegetation/Trample.ts), drawn after they move each
// frame into the displacement field (world/vegetation/Displacement.ts): fixed over the whole
// island, drawn again each frame; across a cut its frame before is not read.
const trample = new Trample( displacementField );
if ( TEMPORAL ) onTaaCut( () => displacementField?.cut() );
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
sunShadow.install();
// Cloud shadowing shares the density field in the visible/reflected sky. Bake its long solar
// path once at low resolution, then sample the same transmission on every receiver, including
// those beyond the island's shadow map (the sea floor seen through the water).
installOpenShadow( sun, ( position ) => sky.keyDirectVisibility( position ), sky.castShadow );
// Moving figures cast through a small map of their own that every receiver multiplies in. It
// must be installed before any receiving material is built.
const characterShadow = new CharacterShadow();
characterShadow.install( sun );
// Vegetation casts its rest pose; wind only changes the visible mesh. The key light's steps
// redraw the map; a jump of the light or an edit to the casters redraws it from scratch.
function invalidateSunShadow(): void { sunShadow.invalidate(); }
scene.add( sun, sun.target );
// the direction the sun's map and the figures' are drawn along: the key's, lifted under a low key
// (lighting/KeyLift.ts)
const shadowDirection = new THREE.Vector3( 0, 1, 0 );
characterShadow.along = shadowDirection;

function fresnel( cosI: number, eta: number ): number {

	const g = Math.sqrt( eta * eta - 1 + cosI * cosI );
	const a = ( g - cosI ) / ( g + cosI ), b = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
	return 0.5 * a * a * ( b * b + 1 );

}

let sunUpdates = Promise.resolve();
// The haze by the hour and the weather (weather/HazeKeys.ts): its amount over the weather's, the
// morning mist beside the weather's sea fog, its spectral extinction and its light, set on the
// medium the frame and the environment's bake read (the bake lays it over its source: Sky.ts
// `fogEnvironment`), so a bake sees the haze of the state it bakes.
// (the first bake runs before the pipeline holds the haze: `hazeReady` below)
let hazeReady = false;
function prepareHaze( state: Readonly<WeatherState> ): void {

	if ( ! hazeReady ) return;
	hazeKeyAt( sky.elevation, sunRising( sky.sunDir ), weather.skyMix, sky.weather.windSpeed, sky.weather.rain, hazeKey );
	pipeline.air.haze.value = sky.weather.haze * hazeKey.amount;
	pipeline.air.fog.value = Math.max( sky.weather.fog, hazeKey.mist );
	pipeline.air.setLook( hazeKey );
	// the air's sunlit haze takes the key the land does, through the clouds' shadow (its own read)
	pipeline.air.weatherLight.direct = state.directVisibility;
	pipeline.air.weatherLight.ambient = state.ambientGain;
	pipeline.air.prepareMedium();

}

function prepareSkyState(): void {

	const celestial = manualSun ? null : dayCycle.snapshot();
	const state = weather.snapshot();
	if ( cloudOverride !== null ) state.coverage = cloudOverride;
	sky.setWeather( state );
	keyGlint.spread.value = state.glintSpread ?? 0;
	sky.track( celestial, state, cloudOverride, weather.front, weather.skyMix );
	prepareHaze( state );
	lastWeatherSignature = `${ state.coverage },${ state.density },${ state.directVisibility },${ state.ambientGain },${ state.haze }`;

}

function publishLighting(): void {

	// three's sun: the direct key, the sky's, which the clouds' shadow cuts per point over the land's
	// floor, the deck's key gain on that floor (Sky.ts `keyDirectVisibility`, OVERCAST_KEY_GAIN); the
	// land's key (shared.landKey) and the sea's (shared.sunColor): both the sky's key, the sea's cut
	// by the clouds' own transmittance (lighting/KeyCloud.ts)
	const overcast = weather.skyMix[ 3 ] ?? 0;
	sun.color.copy( sky.keyColor );
	// how far the open key on the land is its floor's under a deck: the islanders read their cast
	// shadow against it (lighting/KeyCloud.ts `keyDeckShare`)
	keyDeckShare.value = deckLight( sky.elevation, cloudedShare( weather.skyMix ), overcast );
	shared.landKey.value.set( sun.color.r, sun.color.g, sun.color.b );
	// a low sun's lift of the sky's light on what it lights: the land's ambient, the water's sky
	// light and the sea's reflection (lighting/AmbientRelight.ts `lowSunSkyLift`)
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
	sky.reset( shared.wind.direction.value, simTime );
	skyRetune.dirty = false;
	if ( hazeReady ) pipeline.air.noteBake();
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

// An explicit bake (a jump of the hour, the weather or the whole scene, a seek, a retune of what the
// bake depends on) shows at once, its sky's light read back before it publishes (Sky.ts `bake`).
// The state it bakes changes before it is called and the readback takes a frame or two, so the loop
// draws no frame from that change until the bake has published (`tick`): the frame on screen holds
// the old state, and the first frame drawn after it shows the new weather or hour in its own light.
// (a count: the requests queue on `sunUpdates`, and a scene jump holds from its first change.) A
// held tick still advances three's frame count (`renderer.info.frame`, which probe.mjs `--frames`
// counts as drawn frames), and the first frame drawn after a hold records the whole hold as one
// interval in the frame statistics.
let jumpsInFlight = 0;
function bakeExplicitly(): Promise<void> {

	jumpsInFlight ++;
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( () => bakeEnvironment() )
		.finally( () => { jumpsInFlight --; } );
	return sunUpdates;

}

// A value the environment's bakes depend on has changed since they ran (sky/SkyRetune.ts: a
// tunable's mark, or a haze setting the bake reads: VolumetricHaze.ts `bakeStale`): bake again
// explicitly, as the load does, and raise the `retune` event. Run by the `tune` handle's `set` and
// before each frame (`tick`, `loop.step`), so the GUI and scripts take the same path; true when it
// started a bake.
function retuneSky(): boolean {

	if ( hazeReady && pipeline.air.bakeStale ) markSkyRetune();
	if ( ! skyRetune.dirty ) return false;
	skyRetune.dirty = false;
	sceneEvent( 'retune' );
	void bakeExplicitly();
	return true;

}

function refreshEnvironment(): Promise<void> {

	manualSun = false;
	return bakeExplicitly();

}

function applySun(): Promise<void> {

	manualSun = true;
	return bakeExplicitly();

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
// The wind alone (its level, its heading or both), the sky keeping its course; as setWeather, it
// holds the weather.
const setWind = async ( choice: WindChoice, seconds = 20 ) => {

	weather.auto = false;
	weather.setWind( choice, seconds );
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

// the sky's harmonics for the ambient light's relight (lighting/AmbientRelight.ts), projected from
// every bake's environment source from the first on
const ambientSky = new AmbientSky( renderer );
sky.onEnvironmentSource = ( source, atlases ) => ambientSky.project( source, atlases );

setStatus( 'Lighting the sky…' );
await refreshEnvironment();
mark( 'sky' );
// (the sky's light on what it lights takes a low sun's lift, shared.ts `skyLift`; the sky drawn and
// its meter never do)
shared.skyIrradianceSource = sky.irradianceNode.mul( shared.skyFill ).mul( shared.skyLift );
shared.islandIrradianceSource = sky.islandIrradianceNode.mul( shared.skyFill );
shared.skyMeterLog2 = sky.meterLog2Node;

// the bamboo's groves (`bamboo=cover,height` loads another look of them), which the ground's
// floor follows (the textures' grove field) and the meadow thins under and the bamboo stands in
loadBambooLook( params.get( 'bamboo' ) );
const textures = await bakeProceduralTextures( renderer );
// tidewater's two wave systems at the prevailing heading (Wind.ts `spectrumWind`) and tidewater's
// sea state for the wind (OceanSpectrum.ts `seaState`: its fetch, choppiness and swell), rebuilt
// whenever the weather's wind speed or heading changes (`setWind`, below in the frame loop: the
// wind sea turns with the heading, the swell keeps the prevailing one).
const sea = seaState( wind.spectrumWind.windSpeed );
const fft = new OceanFFT( renderer, {
	...wind.spectrumWind, fetch: sea.fetch, choppiness: sea.choppiness, distantSwell: { scale: sea.swell },
	anisotropy: quality.water.fftAnisotropy,
} );
const waveMaps = new WaveMaps( renderer );
// the sea's gusts, slicks and windrows (the water's roughness)
const seaDetail = new SeaDetail( shared );
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
	// (the targets hold scene radiance pre-exposed: PreExposure.ts)
	exposure: () => pipeline.settings.exposure / SCENE_RADIANCE_SCALE * preExposure.inverse.value,
	// (the resolve exists while the pipeline compiles its graph, before `pipeline` is assigned)
	temporal: () => TemporalAA.current,
	motion: {
		previousViewProjection: motionUniforms.previousViewProjection, projectionInverse: jitter.uniforms.unjitteredProjectionInverse,
		jitterNdc: jitter.uniforms.ndc, opaqueBelow: ( MOTION_CLASS.opaque + MOTION_CLASS.vegetation ) / 2,
	},
} );
const pipeline = new Pipeline( renderer, sky, sunShadow, rain, postOptionsFromURL( location.search, quality.post ), quality.taa );
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
// its pipelines' keys), with the objects their owners register as drawn only at times; the sky
// compiles its own renders. The storm's foam and spray need the world's shore fields and register
// with it.
const warming = Promise.all( [
	sky.warm( renderer ),
	// the drops and splashes, and the bolts, registered with the passes they draw in before the
	// graph's warm-up starts, which compiles them with every pass (graph/FrameGraph.ts `warm`)
	rain.registerLatent( overlayLatents ),
	sky.lightning.registerLatent( pipeline.graph ),
	pipeline.graph.warm( { scene, waterScene, rainScene, afterScene: AFTER_RESOLVE ? afterScene : undefined, camera, water: null, sun, time: simTime } ).then( () => pipeline.resolver?.warm() ),
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

	return { box: landBounds( next ), framing: landFraming( next ), outline: landOutline( next ) };

}
let { centroid, scale: landScale, onLand } = landFraming( land );
// the land's convex hull, which the island view frames (IslandFraming.ts)
let outline: number[] = [];
// the land for the tools: its seed and step, box, centroid, the framing's scale against the first
// island and the default pivot
const landInfo = { seed: landOptions.worldSeed, step: landOptions.step, bounds: landBox, centroid, scale: landScale, target: [ 0, 0, 0 ] };
// (`measured`: the land's box and framing found ahead, as Growth.ts's preparation finds them)
function setLand( next: LandLattice, step: number, measured = measureLand( next ) ): void {

	land = next;
	landBox = measured.box;
	outline = measured.outline;
	( { centroid, scale: landScale, onLand } = measured.framing );
	target.copy( onLand( 1.5, 0.5, 1 ) );
	Object.assign( landInfo, { step, bounds: landBox, centroid, scale: landScale, target: target.toArray() } );

}
setLand( land, landOptions.step );
// The world fields' textures (WorldFields.ts), sampled through one node each: the shore's distance
// (its transform is the shared shoreXform), the floor's height and beds over the same bounds, the
// rim ground over its own.
const fields = new WorldFields( data, shared.shoreXform.value );
// the sunlight the ground bounces up (lighting/GroundBounce.ts), which every lit material adds: so
// installed before any of them builds; its map shares the wave maps' target
const groundBounce = new GroundBounce( { renderer, shared, sunShadow, fields, soil: textures.soil, target: waveMaps.target, layer: waveMaps.bounceLayer, cloud: ( position ) => sky.keyDirectVisibility( position ), seaCloud: ( position ) => sky.cloudVisibility( position ) } );
installGroundBounce( groundBounce );
const shoreWaves = new ShoreWaves( renderer, data, shared, fields.shore, fft, fields.floor );
const walk = walkPoints( data.walk );
const world = buildWorldMeshes( data, textures, shared, waveMaps, fields );
scene.add( world.group );
// The wenyao's schools off the island (life/Wenyao.ts): swimmers (Refraction.ts markSwimmer), which
// the opaque pass draws where the eye sees them through the waves (Water.ts swimmerSway).
const wenyao = new Wenyao( data, shared, waveMaps, fft );
scene.add( wenyao.mesh );
// The bamboo leaves the wind takes off the island (weather/FallingLeaves.ts): stepped by their pass on
// the frame graph, drawn in the opaque scene; the test mode leaves them out (debug/TestMode.ts).
const fallingLeaves = TEST_MODE ? null : new FallingLeaves( { shared, fields, soil: textures.soil, wind, atlas: singleLeaf() } );
pipeline.fallingLeaves = fallingLeaves;
if ( fallingLeaves ) scene.add( fallingLeaves.mesh );
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
// The ambient light's probes on the GPU (lighting/AmbientVolume.ts), relit every frame into their
// irradiance (lighting/AmbientRelight.ts), which every lit island material reads for its ambient
// diffuse (lighting/AmbientSample.ts: installed before any of them builds), and their debug view
// (`ambientProbes=sky|bounce|irradiance` on a debug page, the GUI's Ground folder), built on first
// show.
const ambient = new AmbientVolume( renderer, data.ambient );
installAmbientVolume( ambient );
const ambientRelight = new AmbientRelight( { renderer, volume: ambient, shared, sky: ambientSky, weights: () => sky.environmentWeights(), cloud: ( position ) => sky.keyDirectVisibility( position ), seaCloud: ( position ) => sky.cloudVisibility( position ), keyHeight: () => liftedKeyHeight( sky.keyDir, sky.keyIsMoon ), sunElevation: () => sky.elevation, rising: () => sky.rising, clouded: () => cloudedShare( weather.skyMix ), overcast: () => weather.skyMix[ 3 ] ?? 0 } );
// the environment's own harmonics, which the specular's relight divides by (AmbientSample.ts)
installEnvironmentHarmonics( ambientRelight );
// the haze's shadow kernels read the probes' sky visibility, so they compile now (Pipeline.ts)
const hazeShadowCompiled = pipeline.compileHazeShadow();
const ambientView = { mode: ( DEBUG && params.get( 'ambientProbes' ) || 'off' ) as AmbientView };
ambient.show( ambientView.mode, scene );
const refractedSun = new RefractedSun( renderer, shared );
runtime.refractedSun = refractedSun;
refractedSun.angleGate = THREE.MathUtils.degToRad( runtimeQuality.refractedSun.angleGate );
// the stones', floor's and island parts' triangles under the water come with the chunks (World.ts)
refractedSun.setCasters( world.group, world.subsets );
refractedSun.bindTerrain( world.group, waveMaps );
await refractedSun.prepare();
const grass = buildGrass( plantGrass( data.vegetation ), shared );
// The vegetation's kinds (vegetation/Registry.ts), in the order the scene draws them; every list
// of vegetation below reads it.
const vegetation = new Vegetation();
vegetation.add( grassKind( grass ) );
// the yunpeng's clumps in the meadow, instances of a few prototypes at two levels (Yunpeng.ts)
const yunpeng = buildYunpeng( data, shared );
vegetation.add( yunpengKind( yunpeng ) );
// its light by night, a local light per clump (lighting/LocalLights.ts), moved as the island grows
// (`onSwap`); `flags=lightTest:N`: N white test sources over the meadow, for the local lights' cost
// tests, loaded once, with the light of stand-in clumps (the island may hold none)
const testLights = typeof debugFlags.lightTest === 'number' ? testSources( debugFlags.lightTest, landBox, ( x, z ) => land.inside( x, z ), islandSurfaceHeight, yunpeng.sampleLights() ) : [];
const setLocalSources = () => {

	localLights.sources = [ ...yunpeng.lights(), ...testLights ];

};
setLocalSources();
// the bamboo over the whole island, instances of a few prototypes at two levels (Bamboo.ts,
// vegetation/PlantInstances.ts), its leaves drawn once here (BambooMaterials.ts)
const bamboo = buildBamboo( data, { shared, atlas: bambooAtlas() } );
for ( const kind of bambooKinds( bamboo ) ) vegetation.add( kind );
scene.add( ...vegetation.roots() );
installWindMotionFlag( scene );
installVegetationPrepass( scene, vegetation.roots( ( kind ) => kind.prepass ) );
// the opaque scene's depth for the ambient occlusion (post/GTAO.ts, high's `ao` knob) and the
// screen-space shade over the whole scene (post/MeadowShade.ts `SS_SHADOW`): the island, its stones
// and floor, and the plants without a prepass of their own
if ( GTAO || SS_SHADOW ) installOpaquePrepass( [ world.group, ...vegetation.roots( ( kind ) => ! kind.prepass ) ] );
// Everything that casts into the sun's map: the figures cast through their own map, and the sea
// floor's stones only into the refracted one. The game's props grow it (holdOpaque below), and so
// does the island (setSunCasters again at each growth step).
const sunCasters = new THREE.Box3();
// the boxes the game's props hold (holdOpaque), kept over the island's growth
const heldOpaque: THREE.Box3[] = [];
// the bamboo's crown and the yunpeng's stalks rise above the island too (their boxes follow the
// growth: `onSwap`)
const bambooBox = new THREE.Box3(), yunpengBox = new THREE.Box3();
const holdPlants = () => {

	bambooBox.setFromObject( bamboo.culms ).union( new THREE.Box3().setFromObject( bamboo.leaves ) ).expandByScalar( 0.6 );
	yunpengBox.setFromObject( yunpeng.root );

};
holdPlants();
heldOpaque.push( bambooBox, yunpengBox );
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
// and its ring of shallows (the land's hull)
controls.setIsland( world.grounds, outline );
let islandMaxDistance = controls.maxDistance;
frameLand();
// Drops stop on the first surface they meet: rock, turf, leaves (the meadow's blades are generated
// as they draw, Grass.ts, and stay out of the bake).
rain.collision.setArea( landBox );
rain.bakeCollision( renderer, [ world.group, ...vegetation.roots( ( kind ) => kind.rainBake ) ] );
mark( 'meshes' );
setStatus( 'Waking the villagers…' );
// The islanders are the Hanming people (src/characters/looks.ts HANMING: a woven bamboo hat, a
// short-sleeved feather top worn open and feather shorts, lit as the island is); `look=kit` brings
// back the kit-dressed islander (bare head, so the pointed ears read, linen shirt, plain trousers,
// leather shoes, in cel steps). The game dresses its islanders in the look's variants.
// Their proportions (`islander` URL option, GUI Islander folder) are the look's build of
// Proportions.ts by default (the Hanming's realistic `real`, the kit figure's chunkier `medium`);
// the kit's own (`stock`) and the other builds stay selectable for comparison. A Hanming islander
// has a sex and an age (characters/Ages.ts, FigureAge.ts), the build that of its adult man: the
// scene's walker the `body` URL option's (`F6`: a girl of six; a man of 30 by default, GUI
// Islander folder), the game's from the game (Game.ts).
const KIT_LOOK = params.get( 'look' ) === 'kit';
const SCENE_LOOK = KIT_LOOK ? ISLANDER : HANMING;
const GAME_LOOKS = KIT_LOOK ? ISLANDER_LOOKS : HANMING_LOOKS;
const islanderBuild = { proportions: ( PROPORTION_NAMES as string[] ).includes( params.get( 'islander' ) ?? '' ) ? params.get( 'islander' ) as ProportionName : SCENE_LOOK.build ?? 'medium' };
const sceneBody: Body = { ...parseBodies( params.get( 'body' ) )[ 0 ] ?? { sex: 'male', age: 30 } };
const buildIslander = ( name: ProportionName ) => loadVillager( SCENE_LOOK.base, SCENE_LOOK.parts, shared, PROPORTIONS[ name ], SCENE_LOOK.lit, SCENE_LOOK.ages ? sceneBody : undefined );
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
// ?game turns the island into the game: its own islanders, a clock that drives the sky and the
// player's interface (src/game/ui/GameUi.ts); the GUI's Game folder and window.__PONLAI__.game
// drive the rest. Without it the scene stays the art-review scene with one islander walking a loop.
const GAME = params.has( 'game' );
let characters: Villagers | null = null;
let game: Game | null = null;
if ( GAME ) {

	// loaded only here, so the art-review page does not carry the game's code
	const { Game } = await import( './game/Game.ts' );
	game = await Game.start( {
		params, scene, camera, canvas: renderer.domElement, land, top: topFromTiles( worldCache.version.chunks ),
		dayCycle, weather, characterShadow, invalidateSunShadow, refreshEnvironment, sceneEvent,
		// the island grows with the population (Growth.ts, made below: called from the frame loop on)
		pieces: landOptions.step,
		island: { approach: ( p ) => growth.approach( p ), grow: () => growth.grow() },
		// A prop can rise above all the island grows: the sun's map fits its casters and the sea's reflection marches its box, so both grow to hold it.
		holdOpaque: ( box ) => {

			heldOpaque.push( box.clone() );
			if ( ! sunCasters.containsBox( box ) ) sunShadow.setCasters( sunCasters.union( box ) );
			water?.hold( box );

		},
		// the game's props, for the scene's pass and the sun's map (see compileDraws)
		compileDraws,
		// every islander in the scene islander's proportions (the `islander` URL option). A figure
		// is handed over once its pipelines are built, off the frame (GameView "First draws"): it
		// arrives after the game's first frame, and each load brings its own material, so the frame
		// that first drew it built its skinned pipelines (the scene's pass, then the figures' map).
		loadLook: async ( look, body ) => {

			const dress = GAME_LOOKS[ look % GAME_LOOKS.length ];
			const figure = await loadVillager( dress.base, dress.parts, shared, PROPORTIONS[ islanderBuild.proportions ], dress.lit, dress.ages ? body : undefined );
			await pipeline.graph.latent( 'opaque', [ figure.group ] );
			await characterShadow.compile( renderer, scene, figure.group );
			return figure;

		},
		lookColours: ( look ) => GAME_LOOKS[ look % GAME_LOOKS.length ].colours,
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
	land: landBox, sunShadow, storm: stormSea, detail: seaDetail,
	sceneColor: pipeline.opaqueRT.texture, linearDepth: pipeline.depthRT.texture, underwater: pipeline.textures.underwater, quality: quality.water,
	refraction: { color: pipeline.textures.refraction, depth: pipeline.textures.refractionDepth },
} );
pipeline.seaLevel.value = shared.waterLevel.value;
// the boxes held so far (the plants', a game's props shown before the sea was made)
for ( const box of heldOpaque ) water.hold( box );
// the light under the water follows the long waves the sea's surface shows (WaveMaps.ts)
waveMaps.attachWaves( { fft, shared, shore: fields.shore, seabedHeight: fields.floor, shoreWaves } );
applySkyFill();
waterScene.add( water.mesh );
( AFTER_RESOLVE ? afterScene : TEMPORAL ? rainScene : waterScene ).add( stormSea.spray.mesh );

console.info( `world: ${ worldCache.hits } of ${ worldCache.chunks + 1 } records from the cache (${ worldCache.cache })`, data.timings, 'triangles', world.triangles, 'in', Math.round( performance.now() - t0 ), 'ms' );

// The island grows in place (Growth.ts): the next piece is generated ahead, and a Grow (the GUI's
// Island folder, `__PONLAI__.growth.grow()`) swaps it in, every dependent following. The page's own
// part of a swap: the land's framing and the fog's clearing (setLand), the sea's reflection box (and
// the box its gusts take the meadow's within, Water.setLand) and
// the sun's casters (the game's held props kept), the camera's ground; the scene event keeps the
// temporal modes' history (the new land is a change of the scene, which the resolve's clip handles,
// as a placed prop's) and restarts a paused frame's rest.
// (for the diagnostics, which follow a grown island)
const worldInfo = { worldTriangles: world.triangles };
const growth = new Growth( {
	renderer, world, fields, vegetation, shoreWaves, refractedSun, ambient, rain, characters, game,
	measure: measureLand,
	onSwap: ( next, version, measured ) => {

		setLand( next, growth.state.step, measured );
		water!.setLand( landBox );
		holdPlants();
		setLocalSources();
		for ( const box of heldOpaque ) water!.hold( box );
		setSunCasters();
		groundBounce.invalidate();
		// (asked before the pose changes: whether the camera holds the island view)
		const follow = holdsFraming();
		controls.setIsland( world.grounds, outline );
		islandMaxDistance = controls.maxDistance;
		poseIslandView( islandViewOptions, islandTurned, islandZoom );
		if ( follow ) followFraming();
		shownData = version;
		wenyao.setWorld( version );
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
const viewDirection = new THREE.Vector3();

// The island view on this land at the `polar` and `az` options (degrees): the camera that just
// frames the land and its ring of shallows from there (IslandFraming.ts), at the camera's aspect,
// brought in to where it frames the land alone from its heading (`landFitDistance`; the zoom then runs from there to the
// least distance); with a `dist` option (m),
// the camera on its sphere about the default pivot at that distance instead. Then a settle within
// the orbit's limits, the farthest zoom raised to the framing's distance (from the land's own each
// time, so it never only grows). At rest the pose depends only on the pivot, the position and the
// limits, so a scene jump (`establishScene`) repeats it on a camera and controls of its own with the
// page's limits, and its pose is the load's to the bit.
// The default azimuth (180: the view looks along +z, about 23 degrees east of the meridian the sun
// and the full moon culminate on) is fixed, never following the clock, so the R key always returns
// to the same view. It was 318, looking away from the meridian: the morning sun lit the island
// flat from behind the camera and the moon path never entered the frame. From 180 the moon's path
// is in view all night (the moon stands at its culmination's azimuth: lighting/KeyLift.ts), while the sun lights the cliffs from the side at 9:00
// and 16:00 (a lit and a shaded side) and its glints at noon keep to a corner of the frame.
function placeOrbit( on: THREE.PerspectiveCamera, orbit: IslandCameraControls, options: URLSearchParams, turn = 0, zoom = 0 ): void {

	const polar = THREE.MathUtils.degToRad( Number( options.get( 'polar' ) ?? 40 ) ), azimuth = THREE.MathUtils.degToRad( Number( options.get( 'az' ) ?? 180 ) ) + turn;
	if ( options.has( 'dist' ) ) {

		orbit.target.copy( target );
		on.position.setFromSphericalCoords( Number( options.get( 'dist' ) ), polar, azimuth ).add( target );
		orbit.maxDistance = Math.max( islandMaxDistance, Number( options.get( 'dist' ) ) );

	} else {

		// (a window of no size, such as a hidden pane's, has no aspect: square until it has one)
		const aspect = on.aspect > 0 && Number.isFinite( on.aspect ) ? on.aspect : 1;
		const view = { polar, azimuth, fov: initialCameraFov, aspect };
		frameIsland( outline, view, on.position, orbit.target );
		const framed = on.position.distanceTo( orbit.target );
		const start = Math.min( framed, landFitDistance( outline, view ) );
		orbit.maxDistance = Math.max( islandMaxDistance, start );
		// (from the start distance at zoom 0 to the least at 1, eased on the log as the framing's zoom)
		on.position.sub( orbit.target ).setLength( start * Math.pow( Math.min( orbit.minDistance / start, 1 ), zoom ) ).add( orbit.target );

	}
	orbit.settle();

}

function frameLand(): void {

	placeOrbit( camera, controls, params );
	initialCameraPosition.copy( camera.position );
	initialCameraQuaternion.copy( camera.quaternion );
	initialCameraTarget.copy( controls.target );
	controls.minDistance = islandNearest = camera.position.distanceTo( controls.target );

}

// The island view's pose (the R key, `setCameraView( 'island' )`) at the dist / polar / az of
// `options`, the heading turned by `turn` (rad) at `zoom`, placed as the load places it on a camera and
// controls of its own with the page's limits, the camera left where it is: a scene jump's
// (`establishScene`), and again for the same options and turn when the island grows (Growth.ts) or
// the window's shape changes, so the view frames the land shown, and at every step of a turn.
let islandViewOptions = params;
function poseIslandView( options: URLSearchParams, turn = 0, zoom = 0 ): void {

	islandViewOptions = options;
	islandTurned = turn;
	islandZoom = zoom;
	const probe = camera.clone();
	const orbit = new IslandCameraControls( probe, document.createElement( 'div' ) );
	orbit.minDistance = orbitMinDistance;
	orbit.maxPolarAngle = orbitMaxPolar;
	placeOrbit( probe, orbit, options, turn, zoom );
	orbit.dispose();
	initialCameraPosition.copy( probe.position );
	initialCameraQuaternion.copy( probe.quaternion );
	initialCameraTarget.copy( orbit.target );
	controls.maxDistance = orbit.maxDistance;
	islandNearest = probe.position.distanceTo( orbit.target );
	applyOrbitLimit();

}

// Whether the camera holds the island view's pose, or glides toward it: only then does it follow
// the pose when the land grows or the window's shape changes (a pose the hand or the tools moved
// it from stays).
function holdsFraming(): boolean {

	if ( ! controls.enabled || reviewView.camera !== 'island' ) return false;
	return framingGlide.running || ( camera.position.distanceTo( initialCameraPosition ) < 1e-3 && controls.target.distanceTo( initialCameraTarget ) < 1e-3 );

}

// Takes the camera to the island view's pose: a glide on the scene clock (the tick's
// `framingGlide.advance`), at once on a paused page, so a paused frame is the fresh load's.
function followFraming( glide = ! paused ): void {

	if ( glide ) {

		framingGlide.start( camera.position, controls.target, initialCameraPosition, initialCameraTarget );
		controls.maxDistance = Math.max( controls.maxDistance, camera.position.distanceTo( controls.target ) );
		return;

	}
	framingGlide.stop();
	camera.position.copy( initialCameraPosition );
	camera.quaternion.copy( initialCameraQuaternion );
	controls.target.copy( initialCameraTarget );
	controls.settle();

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
	controls.minDistance = sky ? 0.01 : reviewView.camera === 'island' ? islandNearest : orbitMinDistance;
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

	framingGlide.stop();
	if ( controls.enabled ) settleOrbit();
	if ( mode === 'free' ) unwidenFov();
	if ( mode === 'orbit' && freeControls.enabled ) {

		camera.getWorldDirection( viewDirection );
		controls.target.copy( camera.position ).addScaledVector( viewDirection, 58 * landScale );

	}
	cameraSettings.mode = mode;
	sceneEvent( 'camera mode' );
	controls.enabled = mode === 'orbit';
	freeControls.enabled = mode === 'free';
	applyOrbitLimit();
	if ( controls.enabled ) controls.settle();
	renderer.domElement.style.cursor = freeControls.enabled ? 'grab' : '';

}

function setCameraView( view: CameraView ): void {

	framingGlide.stop();
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

		// (back to the query's heading, at the farthest zoom)
		if ( islandTurned !== 0 || islandZoom !== 0 ) poseIslandView( islandViewOptions );
		controls.target.copy( initialCameraTarget );
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
// (off again, the view returns to its framing)
cameraF.add( controls, 'handInput' ).name( 'move by hand' ).onChange( () => {

	if ( ! controls.handInput ) setCameraView( 'island' );

} );
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
// the tier's default or the URL's (`msaa`, high's, first), and the ground truth (URL only) is listed
// while it runs.
const antialiasingF = gui.addFolder( 'Antialiasing' );
const aaChoices: Record<string, AAMode> = { 'MSAA 4x': 'msaa', 'TAAU': 'taau', 'FSR 3.1': 'fsr3', 'TAA': 'taa', 'Off': 'off' };
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
// FSR 3's sharpness (RCAS: 0 the least, 1 the most), live: a change restarts its rest
if ( pipeline.fsr3 ) antialiasingF.add( pipeline.fsr3.settings.fsr3, 'sharpness', 0, 1, 0.01 ).name( 'FSR sharpness' );
if ( pipeline.temporal ) {

	const T = pipeline.temporal.settings;
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
groundF.add( ambientView, 'mode', [ 'off', 'sky', 'bounce', 'irradiance' ] ).name( 'ambient probes' ).onChange( ( mode: AmbientView ) => ambient.show( mode, scene ) );
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
// the wind's level and heading (Weather.ts), shown as the weather's target: written only when the
// target changes, so a drag of the heading is not overwritten while it lasts
const windView = { ...weather.windTarget };
let shownWind = `${ windView.level },${ windView.heading }`;
weatherF.add( windView, 'level', Object.keys( WIND_LEVELS ) ).name( 'wind' ).listen().onChange( ( level: WindLevel ) => { void setWind( { level }, weatherView.seconds ); } );
weatherF.add( windView, 'heading', 0, 360, 1 ).name( 'wind heading' ).listen().onFinishChange( ( heading: number ) => { void setWind( { heading }, weatherView.seconds ); } );
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
sunF.add( sky.atmosphere.mieScale, 'value', 0.1, 5, 0.01 ).name( 'aerosol scattering' ).onFinishChange( applySun );
sunF.add( lighting, 'skyFill', 0, 3, 0.01 ).name( 'sky fill' ).onChange( applySkyFill );
sunF.add( groundBounce.strength, 'value', 0, 2, 0.01 ).name( 'ground bounce' );
// the ambient grade (lighting/AmbientGrade.ts): the values the table gives now, and an override
// whose sliders replace them while it is on, for live tuning
const ambientF = gui.addFolder( 'Ambient' );
for ( const key of AMBIENT_KNOBS ) ambientF.add( ambientGrade.current, key ).name( key ).listen().disable();
const retuneAmbient = () => sceneEvent( 'retune' );
ambientF.add( ambientGrade, 'override' ).name( 'override' ).onChange( retuneAmbient );
for ( const key of AMBIENT_KNOBS ) ambientF.add( ambientGrade.manual, key, 0, key === 'directionality' || key === 'aoStrength' ? 1 : 3, 0.01 ).name( `${ key } (override)` ).onChange( retuneAmbient );
ambientF.close();
// the local lights (lighting/LocalLights.ts): on or off, and the art gain over the sources' light
const localLightsF = gui.addFolder( 'Local lights' );
localLightsF.add( localLights, 'enabled' ).name( 'on' ).onChange( retuneAmbient );
localLightsF.add( localLights, 'gain', 0, 16, 0.1 ).name( 'gain' ).onChange( retuneAmbient );
localLightsF.close();
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
waterF.add( W.sss, 'value', 0, 3, 0.01 ).name( 'crest translucency' );
waterF.add( W.foamIntensity, 'value', 0, 2, 0.01 ).name( 'foam' );
waterF.add( W.ssr, 'value', 0, 1, 1 ).name( 'SSR' );
const waveF = gui.addFolder( 'Waves' );
const rebuild = () => fft.rebuildSpectrum();
waveF.add( fft.params, 'windSpeed', 1, 14, 0.1 ).onFinishChange( rebuild );
waveF.add( fft.params, 'windDirection', - 180, 180, 1 ).onFinishChange( rebuild );
waveF.add( fft.params, 'amplitude', 0, 3, 0.01 ).onFinishChange( rebuild );
waveF.add( fft.params, 'choppiness', 0, 1.5, 0.01 ).onFinishChange( rebuild );
const islanderF = gui.addFolder( 'Islander' );
const proportionsControl = islanderF.add( islanderBuild, 'proportions', PROPORTION_NAMES ).onChange( async ( name: ProportionName ) => characters?.setWalker( await buildIslander( name ) ) );
// the scene walker's body: a new sex dresses it again, a new age builds it again in place
// (FigureAge.ts); the game's islanders take their build and bodies as they load
const sexControl = islanderF.add( sceneBody, 'sex', [ 'male', 'female' ] satisfies Sex[] ).onChange( async () => characters?.setWalker( await buildIslander( islanderBuild.proportions ) ) );
const ageControl = islanderF.add( sceneBody, 'age', 2, 100, 0.25 ).onChange( ( age: number ) => characters?.walker.age?.set( age ) );
if ( game || ! SCENE_LOOK.ages ) {

	sexControl.disable();
	ageControl.disable();

}
if ( game ) proportionsControl.disable();
// the game's developer controls (GameDebug.ts)
if ( game ) await game.addDebugFolder( gui );
islanderF.add( characterLook.albedo, 'value', 0.05, 1, 0.01 ).name( 'palette exposure' );
islanderF.add( characterLook.sunGain, 'value', 0, 2, 0.01 ).name( 'sun' );
islanderF.add( characterLook.fillGain, 'value', 0, 10, 0.05 ).name( 'shade fill' );
islanderF.add( characterLook.formFloor, 'value', 0, 1, 0.01 ).name( 'lit form floor' );
islanderF.add( characterLook.softCloth, 'value', 0.005, 0.4, 0.005 ).name( 'cloth edge' );
islanderF.add( characterLook.softSkin, 'value', 0.005, 0.4, 0.005 ).name( 'skin edge' );
islanderF.add( characterLook.skyRimGain, 'value', 0, 4, 0.01 ).name( 'sky rim' );
islanderF.add( characterLook.shadowSaturation, 'value', 0.5, 2, 0.01 ).name( 'shade saturation' );
// the display chain (Pipeline.ts): tidewater's grade (TIDEWATER_GRADE), its exposure from the clock
// and the weather, the white balance, the local tone mapping and the grade's tables
const postF = gui.addFolder( 'Post' );
postF.add( S, 'exposureOffset', - 3, 3, 0.05 ).name( 'exposure offset (stops)' );
postF.add( S, 'bloom', 0, 3, 0.05 ).name( 'bloom strength' );
{

	// the high sun's white balance (Pipeline.ts WHITE_BALANCE)
	const day = WHITE_BALANCE.day[ WHITE_BALANCE.day.length - 1 ].values;
	postF.add( day, 'r', 0.4, 1.5, 0.005 ).name( 'white balance red (high sun)' );
	postF.add( day, 'b', 0.5, 1.5, 0.005 ).name( 'white balance blue (high sun)' );

}
{

	// the tone curve (ToneCurve.ts): its slope at black, what mid grey shows (linear) and the input
	// that shows white; a set the solve cannot meet warns and keeps the last good curve (only the
	// default set failing throws, on the dev server)
	const curveF = postF.addFolder( 'Tone curve' );
	curveF.add( S.curve, 'toe', 1.5, 3, 0.01 ).name( 'slope at black' );
	curveF.add( S.curve, 'mid', 0.12, 0.22, 0.0005 ).name( 'mid grey shown (linear)' );
	curveF.add( S.curve, 'white', 8, 32, 0.1 ).name( 'white (input)' );
	curveF.close();

}
if ( pipeline.localTone ) {

	// the local tone mapping's smooth hinge (LocalTone.ts): the high sun's key, the last of the
	// day's (the frame's values are keyed by the sun every frame)
	const high = LOCAL_TONE.keys.day[ LOCAL_TONE.keys.day.length - 1 ].values;
	postF.add( high, 'hinge', - 3, 2, 0.01 ).name( 'local hinge (stops over mid grey, high sun)' );
	postF.add( high, 'high', - 0.6, 0.2, 0.01 ).name( 'local slope over the hinge (high sun)' );
	postF.add( high, 'low', - 0.4, 0.4, 0.01 ).name( 'local slope under the hinge (high sun)' );
	postF.add( high, 'width', 0.05, 2, 0.01 ).name( 'local knee width (stops, high sun)' );

}
postF.add( S, 'lut', 0, 1, 0.01 ).name( 'grade table blend' );
// the meadow's albedo against its lawn colour (shared.lawnGain), tuned with the exposure
postF.add( shared.lawnGain, 'value', 0.5, 3, 0.01 ).name( 'meadow albedo (x)' ).onChange( () => groundBounce.invalidate() );
postF.add( shared.rockGain, 'value', 0.5, 3, 0.01 ).name( 'cliff albedo (x)' );
postF.add( shared.leafGain, 'value', 0.5, 3, 0.01 ).name( 'tree leaves albedo (x)' );
{

	// the first table's grade (GradeLut.ts), its table filled anew on every change
	const grade = pipeline.grade, fill = () => pipeline.setGrade();
	const gradeF = postF.addFolder( 'Grade table' );
	gradeF.add( grade, 'contrast', 0.8, 1.3, 0.005 ).onChange( fill );
	gradeF.add( grade, 'saturation', 0.5, 1.6, 0.005 ).onChange( fill );
	gradeF.add( grade.split, '0', 0.1, 0.8, 0.01 ).name( 'shadows end (L)' ).onChange( fill );
	gradeF.add( grade.split, '1', 0.3, 0.98, 0.01 ).name( 'highlights begin (L)' ).onChange( fill );
	for ( const name of [ 'shadows', 'midtones', 'highlights' ] as const ) {

		const zoneF = gradeF.addFolder( name ), zone = grade[ name ];
		zoneF.add( zone, 'value', - 1, 1, 0.01 ).name( 'value (stops)' ).onChange( fill );
		zoneF.addColor( zone, 'tint' ).onChange( fill );
		zoneF.add( zone, 'saturation', 0.5, 1.6, 0.005 ).onChange( fill );
		zoneF.close();

	}
	for ( const [ name, band ] of Object.entries( grade.bands ) ) {

		const bandF = gradeF.addFolder( `${ name } (hue band)` );
		bandF.add( band, 'hue', 0, 360, 1 ).onChange( fill );
		bandF.add( band, 'width', 5, 90, 1 ).onChange( fill );
		bandF.add( band, 'saturation', 0, 2, 0.01 ).onChange( fill );
		bandF.add( band, 'value', - 1, 1, 0.01 ).name( 'value (stops)' ).onChange( fill );
		bandF.add( band, 'shift', - 30, 30, 0.5 ).name( 'hue turn' ).onChange( fill );
		bandF.add( band, 'ceiling', 0.03, 1, 0.005 ).name( 'chroma ceiling' ).onChange( fill );
		bandF.close();

	}
	gradeF.close();

}
postF.add( S, 'tone', 0, 1, 0.01 );
postF.add( S, 'vignette', 0, 1, 0.01 );
// the haze (weather/VolumetricHaze.ts): its slices, its medium (the weather and the hour's key set the
// haze's amount, colour and shape, the fog's and the mist's amount: weather/HazeKeys.ts), its light, the
// shadow's filter and the A/B switches
const hazeF = gui.addFolder( 'Haze' );
const H = pipeline.air.settings;
// the hour's and the weather's key, written each frame (weather/HazeKeys.ts)
const hazeKey: HazeKey = { deck: 0, overcastDeck: 0, amount: 1, sigmaRed: 1, sigmaGreen: 1, sigmaBlue: 1, desaturate: 0, gain: 1, mist: 0, sunRayleigh: 0, rayleighWeight: 1, mieWeight: 1,
	top: 10, width: 50, widthSlope: 0, aerosolShare: 0.035, aerosolHeight: 1400, aerosolTop: Infinity, skyDepth: 0, nearScale: 1, nearDensity: 1, nearStart: 250, nearEnd: 600 };
// the haze exists now: bake the environment again, so it holds the haze every later bake lays over
// it (Sky.ts `fogEnvironment`) and a fresh load equals a jump
hazeReady = true;
await bakeEnvironment();
hazeF.add( H, 'near', 0.05, 20, 0.05 ).name( 'grid near (m)' );
hazeF.add( H, 'far', 1000, 200000, 1000 ).name( 'grid far (m)' );
hazeF.add( H, 'growth', 1.02, 1.4, 0.01 ).name( 'slice growth' );
hazeF.add( H, 'fogExtinction', 0, 0.05, 0.0001 ).name( 'fog extinction (1/m)' );
hazeF.add( H, 'albedo', 0, 1, 0.01 );
hazeF.add( H, 'anisotropy', - 0.5, 0.95, 0.01 ).name( 'phase anisotropy' );
hazeF.add( H, 'gain', 0, 4, 0.01 ).name( 'brightness gain' );
hazeF.add( H, 'ambientFloor', 0, 1, 0.01 ).name( 'ambient floor under cover' );
hazeF.add( H, 'ambientSoftness', 0.1, 10, 0.1 ).name( 'cover top half-width (m)' );
hazeF.add( H, 'blend', 0.01, 1, 0.01 ).name( 'shadow blend' );
hazeF.add( H, 'restFrames', 1, 64, 1 ).name( 'rest frames' );
hazeF.add( H, 'jitter' );
hazeF.add( H, 'tricubic' );
hazeF.add( H, 'densityAA' ).name( 'density AA' );
hazeF.add( H, 'sky' ).name( 'haze over the sky' );
hazeF.add( H, 'nearHaze' ).name( 'thinner near haze' );
hazeF.add( H, 'debug', { off: 0, 'key light visibility': 1 } ).name( 'debug view' );
// the screen-space rays (off by default: the haze shows the shafts) and the sun's flare, for A/Bs
hazeF.add( pipeline.shafts.strength, 'value', 0, 2, 0.01 ).name( 'screen-space rays' ).onChange( () => sceneEvent( 'retune' ) );
hazeF.add( pipeline.shafts.glare, 'value', 0, 4, 0.01 ).name( 'sun flare' ).onChange( () => sceneEvent( 'retune' ) );
hazeF.close();
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

// High's render scale is dynamic (DynamicResolution.ts): it starts at its baseline (the nominal:
// 2K's pixel count, native at 2K output and 1440p at 4K output), moves between the display's ratio
// and a floor (about 1080p's pixel count) by the GPU's frame time, and renders at the baseline
// while the scene is paused, so paused frames and captures render at the scale its trade-offs are
// judged at (pinned, ?dpr or full resolution, at that ratio).
// (the ground truth renders at the canvas's resolution: no dynamic scale)
const dynamicRule = 'dynamic' in quality.render && AA_MODE !== 'gt' ? quality.render : null;
// Under TAAU and FSR 3 the floor rises so the canvas is at most TAAU_MAX_UPSCALE times the render per axis
// (DynamicResolution.ts).
const dynamicResolution = dynamicRule ? new DynamicResolution( { ...dynamicRange( innerWidth, innerHeight, devicePixelRatio, dynamicRule, DPR_CAP ), step: dynamicRule.dynamic.step, maxUpscale: AA_MODE === 'taau' || AA_MODE === 'fsr3' ? TAAU_MAX_UPSCALE : Infinity } ) : null;
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
	// the dynamic range for this view: from the display's ratio (a pinned one's) down to the floor,
	// its baseline among them
	if ( dynamicResolution && dynamicRule ) dynamicResolution.setRange( dynamicRange( w, h, resolution.full ? nominalScale : devicePixelRatio, dynamicRule, DPR_CAP ) );
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
	resolution.render = `${ rw }x${ rh } → ${ canvasSize.x }x${ canvasSize.y }` + ( pipeline.upscaling || ( pipeline.fsr3 && rw !== canvasSize.x ) ? ` (${ Math.round( rw / canvasSize.x * 100 ) } %, ${ pipeline.fsr3 ? 'FSR 3' : 'FSR' })` : '' );
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
addEventListener( 'resize', () => {

	sceneEvent( 'resize' );
	// the island view's framing follows the window's aspect, at once
	const follow = holdsFraming();
	resize();
	poseIslandView( islandViewOptions, islandTurned, islandZoom );
	if ( follow ) followFraming( false );

} );
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
function temporalFrame( dt: number, step: number ): TemporalFrame | undefined {

	if ( ! pipeline.resolver ) return undefined;
	// (FSR 3's frame time: the scene clock's step, the pacer's nominal interval while paused)
	// The temporal rest starts once the haze's has ended, so it averages frames of the finished haze.
	return { signature: [ strikeSignature() ], stable: restStable() && ! pipeline.air.pending, dt, step, interval: pacer.target > 0 ? 1000 / pacer.target : 1000 / 60 };

}
// The haze's rest (weather/VolumetricHaze.ts): the temporal rest's signature and the sun maps' redraw
// counts (a redraw changes its shadow without changing the key), and whether the frame may rest.
function hazeFrame(): HazeFrame {

	return { time: simTime, signature: [ strikeSignature(), sunShadow.draws, refractedSun.draws ], stable: restStable() };

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
	if ( jumpsInFlight > 0 || retuneSky() ) return;
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
	if ( paused && game && ! game.sim.paused ) paused = false;
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
	const windTarget = weather.windTarget;
	if ( `${ windTarget.level },${ windTarget.heading }` !== shownWind ) {

		Object.assign( windView, windTarget );
		shownWind = `${ windTarget.level },${ windTarget.heading }`;

	}
	if ( freeControls.enabled ) freeControls.update( rawDt );
	else {

		// the glide to a grown land's framing (finished at once if the page was paused meanwhile)
		if ( framingGlide.advance( paused ? Infinity : dt, camera.position, controls.target ) ) camera.lookAt( controls.target );
		// a turn or zoom of the island view: the framing at the new heading and zoom, taken at once
		islandTurn.enabled = controls.enabled && ! controls.handInput && reviewView.camera === 'island';
		const turn = islandTurn.advance( dt ), zoom = THREE.MathUtils.clamp( islandZoom + islandTurn.zoom( dt ), 0, 1 );
		if ( zoom === 0 || zoom === 1 ) islandTurn.stopZoom();
		if ( turn !== 0 || zoom !== islandZoom ) {

			poseIslandView( islandViewOptions, islandTurned + turn, zoom );
			followFraming( false );

		}
		controls.advance( dt, time );

	}

	renderer.info.reset();
	// Sun, moon, key light and grade follow the clock every frame; only the baked reflection,
	// environment and cloud products cross-fade between bakes.
	sky.track( manualSun ? null : dayCycle.snapshot(), weather.state, cloudOverride, weather.front, weather.skyMix );
	sky.advance( environmentDt );
	publishLighting();
	// the ambient grade by the sun and the weather's blend of the kept skies (lighting/AmbientGrade.ts)
	ambientGrade.update( sky.elevation, weather.skyMix, sky.rising );
	shared.clouded.value = cloudedShare( weather.skyMix );
	shared.deckSky.value = deckSkyGain( sky.elevation, shared.clouded.value, weather.skyMix[ 3 ] ?? 0 );
	shared.deckSkyGap.value = deckSkyGap( sky.elevation, shared.clouded.value, weather.skyMix[ 3 ] ?? 0 );
	updateShelfScatter( sky.keyColor, sky.keyIsMoon ? 0 : 1 - shared.clouded.value, sky.elevation );
	// the yunpeng's glow and its local lights by the night's share, a clear twilight's with the
	// display's night (sky/DayCycle.ts `nightAmbientShare`; lighting/LocalLights.ts: its pass sorts
	// the sources in view)
	yunpengNight.value = nightAmbientShare( sky.elevation, sky.rising, shared.clouded.value );
	localLights.update( yunpengNight.value );
	// what the crowns' leaves pass on of the key (world/vegetation/LeafLight.ts)
	updateLeafLight( sky.elevation, yunpengNight.value, shared.clouded.value );
	// what a closed sky's light turns into in the sward (materials/SwardTint.ts)
	updateSwardTint( shared.swardTint.value, shared.clouded.value, yunpengNight.value );
	prepareHaze( weather.state );
	pipeline.air.keyDir.value.copy( sky.keyDir );
	pipeline.air.keyColor.value.copy( sky.keyColor ).multiplyScalar( 1 - THREE.MathUtils.smoothstep( sky.clouds.coverage.value, 0.7, 0.97 ) );
	pipeline.shafts.setSun( sky.sunDir, sky.sunColor );
	pipeline.shafts.setMoon( sky.moonDir, sky.keyColor, sky.keyIsMoon );
	wind.update( paused ? 0 : dt, weather.state.windSpeed, weather.state.windDirection, weather.state.gustiness );
	// Lightning follows the scene clock, so a paused frame holds its strike; it lights the clouds'
	// march below, so it goes first.
	// (the scene's render size: the canvas is larger while the frame is upscaled)
	sky.lightning.update( simTime, weather.state.storm, camera, pipeline.height, sky.clouds );
	sky.updateClouds( camera, pipeline.width, pipeline.height, shared.wind.direction.value, simTime );
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
	fft.setWind( wind.speed, wind.heading );
	rain!.uniforms.rain.value = shared.rain.value;
	rain!.uniforms.wind.value.copy( shared.wind.velocity.value );
	rain!.uniforms.waterLevel.value = shared.waterLevel.value;
	rain!.update( renderer, camera, simTime, shared.wind.displacement.value, pipeline.height, AFTER_RESOLVE ? pipeline.outputHeight : pipeline.height );
	if ( ! manualSun && environmentLook.exposure ) {

		S.exposure = sky.grade.exposure;
		// the night's grade (Pipeline NIGHT)
		S.night = sky.grade.night;

	}
	// the weather's stops of the exposure and the clouded day's keys (Pipeline `skyMix`)
	const skyMix = weather.skyMix;
	for ( let i = 0; i < skyMix.length; i ++ ) S.skyMix[ i ] = skyMix[ i ];
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
	// smoothly without re-rasterising sub-texel casters every frame; it is drawn along the lifted
	// key. The underwater map keeps the quality cadence.
	sunShadow.update( renderer, scene, camera, shadowDirection );
	shadowElapsed += environmentDt;
	if ( shadowElapsed >= runtimeQuality.refractedSun.interval && refractedSun.update() ) shadowElapsed = 0;
	shared.time.value = simTime;
	fft.update( paused ? 0 : dt, simTime );
	stormSea.update( simTime, weather.state.storm, camera );
	shoreWaves.update( fft, simTime );
	// Whitewater is disabled in this scene; leave its history idle.
	waveMaps.update( camera );
	// (their schools take flight more often by night)
	wenyao.update( paused ? 0 : dt, sky.grade.night );
	fallingLeaves?.update( simTime, freeControls.enabled ? camera.position : controls.target, camera.position );
	groundBounce.update( sky.seaRadiance );
	ambientRelight.update();
	characters?.update( renderer, scene, sun, simTime, paused ? 0 : dt );
	game?.render( renderer, sun, paused ? 0 : rawDt );
	trample.update( game ? game.walkers() : characters ? [ characters ] : [], controls.target );

	// (the ground truth draws the storm's spray with the rain, in the overlay pass; taa and taau draw
	// it with the streaks after the resolve)
	const overlay = ! AFTER_RESOLVE && ( rain!.mesh.visible || ( TEMPORAL && stormSea.spray.mesh.visible ) );
	const after = AFTER_RESOLVE && ( rain!.mesh.visible || stormSea.spray.mesh.visible );
	pipeline.render( { scene, prepassScene, opaquePrepassScene, waterScene, rainScene: overlay ? rainScene : undefined, overlay, afterScene: after ? afterScene : undefined, camera, water: water!, sun, keyDirection: shadowDirection, time: simTime, temporal: temporalFrame( rawDt, paused ? 0 : dt ), settle: settleFrame( bakeDue ), haze: hazeFrame() } );
	steerRenderScale( rawDt );
	submitBatch.flush();
	frame ++;
	diagnostics();

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

		// the temporal resolve's state, the settled signal and the pre-exposure on every frame: the
		// capture tools wait for them
		if ( current && pipeline.resolver ) current.taa = pipeline.resolver.diagnostics();
		if ( current ) Object.assign( current, { settled: pipeline.settled.value, settle: pipeline.settled.diagnostics(), preExposure: preExposure.diagnostics() } );
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
		// the ambient grade's values (lighting/AmbientGrade.ts) and whether the GUI overrides them
		ambient: { ...ambientGrade.current, override: ambientGrade.override },
		weatherProgress: + weather.progress.toFixed( 3 ),
		rain: + sky.weather.rain.toFixed( 3 ),
		wetness: + shared.wetness.value.toFixed( 3 ),
		windSpeed: + wind.speed.toFixed( 3 ),
		windHeading: + wind.heading.toFixed( 2 ),
		windTarget: weather.windTarget,
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
		taa: pipeline.resolver?.diagnostics() ?? null,
		// whether the paused page will draw the same frame from now on, and why not (post/Settled.ts)
		settled: pipeline.settled.value,
		settle: pipeline.settled.diagnostics(),
		// the pre-exposure's stops, the P the last reading asks for, whether it is pending, the
		// exposure EV last read back, its changes and its readings, the view and its quiet frames
		// (post/PreExposure.ts)
		preExposure: preExposure.diagnostics(),
	};

}

// The storm's foam and spray need the world's shore fields, so they register (and compile) last;
// the loop then waits for every first-use pipeline (see "first-use pipelines"), the haze's shadow
// kernels' included.
await Promise.all( [ warming, hazeShadowCompiled, stormSea.registerLatent( overlayLatents ) ] );

// The temporal modes' debug check (Motion.ts): the materials whose velocity is missing or partial,
// for the movers' motion vectors still to come.
const motionPasses = () => [ { pass: 'opaque', scene, keeps: false }, { pass: 'water', scene: waterScene, keeps: false }, { pass: 'overlay', scene: rainScene, keeps: true } ];
if ( DEBUG && TEMPORAL ) console.info( 'motion check', motionCheck( motionPasses() ) );

if ( profiler ) {

	const { labelPonlaiPasses } = await import( './debug/FrameProfiler.ts' );
	labelPonlaiPasses( profiler, { scene, waterScene, rainScene, pipeline, sky, rain, sunShadow, refractedSun, fft, stormSea, shoreWaves, waveMaps, groundBounce, characters } );

}
// the nodes r186 makes inside the first lit build, made by a throwaway one, so the frame's receivers
// build the same code whichever comes first (graph/ThreePatches.ts)
primeSharedNodes( renderer, scene, camera );
// The falling leaves, which the warm-up ran before they existed, and their kernels compile ahead
// as latents of the opaque pass, so the view that first finds them builds no pipeline.
if ( fallingLeaves ) await pipeline.graph.latent( 'opaque', [ fallingLeaves.mesh ], [ fallingLeaves.kernel, fallingLeaves.prewarm ] );
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
// few frames in (SunShadow). And the ambient light: its volume holds zeros until its first relight,
// once the sky has been projected (AmbientRelight `ready`).
const REVEAL_WAIT = 3000;
const revealAt = performance.now() + REVEAL_WAIT;
const reveal = () => {

	const waiting = ! approachWritten || sunShadow.draws === 0 || ! ambientRelight.ready || ( detector !== null && ( detector.pending || ( detector.result !== null && detector.result.tier !== qualityTier ) ) ) || ( game !== null && ! game.ready() ) || dynamicResolution !== null && dynamicResolution.settling && ( gpuTimer !== null || profiler?.timestamps === true ) &&
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
	wind.reset( { ...weatherWind( weather.state ), time: t } );
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
//   places it) and the controls' limits restored, in the query's camera mode.
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
const SCENE_OPTIONS = [ 'weather', 'wind', 'windDir', 'preset', 'hour', 'moon', 't', 'dist', 'polar', 'az', 'camera', 'clouds', 'dayLength', 'paused', 'clock', 'approach' ];
type SceneRequest = string | URLSearchParams | { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number };
// (the loop draws no frame from its first change until its bake has published: `bakeExplicitly`)
const establishScene = async ( scene: SceneRequest ): Promise<void> => {

	jumpsInFlight ++;
	try {

		await changeScene( scene );

	} finally {

		jumpsInFlight --;

	}

};
const changeScene = async ( scene: SceneRequest ): Promise<void> => {

	const query = typeof scene === 'string' ? new URLSearchParams( scene ) : scene instanceof URLSearchParams ? scene : null;
	if ( query ) {

		// (the land's `grow` against the step shown: a page grown in place draws a fresh load of that step)
		const pageValues = ( key: string ) => key === 'grow' ? [ String( growth.state.step ) ] : params.getAll( key );
		const fixed = [ ...new Set( query.keys() ) ].filter( ( key ) => ! SCENE_OPTIONS.includes( key ) && query.getAll( key ).join( '&' ) !== pageValues( key ).join( '&' ) );
		if ( fixed.length ) throw new Error( `establishScene: ${ fixed.join( ', ' ) } differ from the page's and are read once at load: reload the page with them` );
		const next = sceneOptions( query );
		cloudOverride = next.clouds;
		weather.establish( next.weather, next.wind );
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
	wind.reset( { ...weatherWind( weather.state ), time: simTime } );
	sky.lightning.reset();
	stormSea.reset();
	characters?.reset();
	wenyao.reset();
	fallingLeaves?.reset();
	pipeline.air.invalidate();
	groundBounce.invalidate();
	shadowElapsed = 0;
	// a fresh load starts at the held frame rate, not at a fallback the last scene fell to
	pacer.reset();
	sceneEvent( 'establish scene' );
	manualSun = false;
	await bakeExplicitly();
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
// - a periodic bake reads its sky irradiance back from the GPU (`Sky.skyIrradiance`, which sets
//   a lightning strike's fill light), landing whenever the GPU answers:
//   stepped, the next frame waits for the value, so it lands on the frame after the bake however
//   long the frames took.
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
	skyElapsed = 0;
	shadowElapsed = 0;
	const t0 = Math.round( performance.now() );
	try {

		// one tick of the loop at `time`, with the bookkeeping three's animation loop does around it
		const tickAt = async ( time: number ): Promise<void> => {

			// an explicit bake in flight holds the loop (`bakeExplicitly`), so its tick would draw
			// nothing: start a retune's (`retuneSky`), wait for the bakes queued, and refuse a scene
			// jump still on its way to one
			retuneSky();
			await sunUpdates.catch( () => {} );
			if ( jumpsInFlight > 0 ) throw new Error( 'loop.step: a scene jump is in flight; await establishScene before stepping' );
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
			const temporal = pipeline.resolver;
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

if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__PONLAI__ = { land: landInfo, renderer, scene, camera, controls, freeControls, cameraSettings, setCameraMode, setCameraView, sky, sun, fft, shoreWaves, stormSea, waveMaps, water, pipeline, shared, refractedSun, groundBounce,
	// the direction the surfaces take the key's light from, the low key's lift included (lighting/KeyLift.ts)
	keyShading: () => liftedKeyDirection( sky.keyDir, sky.keyIsMoon, new THREE.Vector3() ),
	// the ambient grade (lighting/AmbientGrade.ts): `current`, `table`, `override` and `manual`
	ambient: ambientGrade,
	// the local lights (lighting/LocalLights.ts): `sources`, `gain`, `enabled`, `info()` (a promise: the
	// sources in view, the fullest cluster, the clusters that overflowed)
	localLights,
	// the screen-space ambient occlusion's knobs (post/GTAO.ts `gtaoUniforms`: cutoff, recede, base, maxTexels, fullDistance)
	gtao: gtaoUniforms,
	// the ambient light's probes (lighting/AmbientVolume.ts): `info()` and `hash()`
	ambientVolume: ambient,
	// their relight (lighting/AmbientRelight.ts): `readback()` and `hash()` of its output
	ambientRelight,
	// the look's knobs from a script (the GUI's raise their own events): the first table's grade
	// (Pipeline.setGrade, GradeLut.ts), the meadow's albedo (shared.lawnGain), the cliff's
	// (shared.rockGain) and the trees' leaves' (shared.leafGain)
	setGrade: ( changes?: GradeChanges ) => { pipeline.setGrade( changes ); sceneEvent( 'retune' ); },
	setLawnGain: ( gain: number ) => { shared.lawnGain.value = gain; groundBounce.invalidate(); sceneEvent( 'retune' ); },
	setRockGain: ( gain: number ) => { shared.rockGain.value = gain; sceneEvent( 'retune' ); },
	setLeafGain: ( gain: number ) => { shared.leafGain.value = gain; sceneEvent( 'retune' ); }, grass, wenyao, fallingLeaves, meadowCanopy, characters, game, soilUniforms, dayCycle, weather, weatherEffects, wind, rain, setWeather, setWind, establishScene, sceneJump: 1, applySun, refreshEnvironment, setHour, setPreset, sunShadow, invalidateSunShadow, setTime, clockTime: () => simTime, nominalScale: () => nominalScale, loop: Object.assign( loop, { step } ), pipelines: pipelineCount, flags: debugFlags,
	// the tunable parameters (debug/Tune.ts): set( { name: value } ), get, list, reset, query; a value
	// the environment's bakes depend on rebakes them at once (`retuneSky`, sky/SkyRetune.ts), as the
	// load bakes
	tune: tuneApi( () => {

		if ( ! retuneSky() ) sceneEvent( 'retune' );

	} ),
	// the scene's linear radiance over screen boxes (debug/Radiance.ts), loaded on first call
	radiance: async ( options?: import( './debug/Radiance.ts' ).RadianceOptions ) => ( await import( './debug/Radiance.ts' ) ).readRadiance( renderer, pipeline, options, camera ),
	// the meadow map (world/SwardField.ts: RGBA bytes, G the sward's cover) and the extent it spans
	// round the origin, for tools that pick a view over the meadow
	meadowMap: async () => {

		const [ { swardField }, { MEADOW_EXTENT } ] = await Promise.all( [ import( './world/SwardField.ts' ), import( './materials/Meadow.ts' ) ] );
		const image = swardField.value.image as { data: Uint8Array; width: number };
		return { data: image.data, size: image.width, extent: MEADOW_EXTENT };

	},
	// where the bamboo's culms and shoots stand on the current land ( x, z, ... flat), for tools that keep a
	// view clear of the groves
	bambooSites: () => {

		const { culms, shoots } = bamboo.sites();
		return [ ...culms, ...shoots ].flatMap( ( c ) => [ c.x, c.z ] );

	},
	// where the yunpeng's clumps stand on the current land ( x, z, size per clump) and their lights
	yunpengSites: () => ( { clumps: yunpeng.sites().flatMap( ( c ) => [ c.x, c.z, c.size ] ), lights: yunpeng.lights().map( ( l ) => ( { position: l.position.toArray(), intensity: l.intensity.toArray(), range: l.range } ) ) } ),
	// the ambient light's irradiance on open level ground, from the probes (debug/AmbientProbe.ts)
	ambientProbe: async ( options?: Record<string, number> ) => ( await import( './debug/AmbientProbe.ts' ) ).ambientProbe( { renderer, heightAt: ( x, z ) => controls.ground.heightAt( x, z ), land: landBox }, options ),
	// the wind's numbers for the vegetation (debug/WindProbe.ts), loaded on first call
	windProbe: async ( options?: Record<string, unknown> ) => ( await import( './debug/WindProbe.ts' ) ).windProbe( { renderer, scene, shared, wind, weather, sky, fft, establishScene, setTime, data: () => shownData, seaDetail, land: () => landBox }, options ),
	// the island's growth: grow(), state, chunkHashes(), and the world fields' GPU bytes
	growth: Object.assign( growth, { fieldBytes: () => fields.bytes() } ),
	quality, dynamicResolution, pacer, submitBatch, jitter, motion: motionState, taaCut, motionCheck: () => motionCheck( motionPasses() ), applyQuality: ( overrides: Partial<QualityProfile> ) => applySkyQuality( { ...quality, ...overrides } ),
	// the temporal resolve (TemporalAA.ts, TemporalRest.ts): its live settings and knobs, the rest, the
	// epoch, and `restart()`, which starts the history and the rest over (a cut and an epoch bump)
	// (under fsr3 the same handles from FSR 3's upscaler, which has no knobs: the capture tools wait on
	// its rest through them)
	taa: pipeline.resolver ? {
		resolve: pipeline.resolver, settings: pipeline.resolver.settings, knobs: pipeline.temporal?.knobs ?? null, rest: pipeline.resolver.rest, epoch: restEpoch,
		get converged() { return pipeline.resolver!.converged; },
		restart: () => sceneEvent( 'restart' ),
	} : null,
	// FSR 3 (post/fsr3/Fsr3Upscaler.ts, aa=fsr3): its rest, live settings and diagnostics()
	fsr3: pipeline.fsr3,
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
