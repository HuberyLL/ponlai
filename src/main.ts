import * as THREE from 'three/webgpu';
import GUI from 'lil-gui';
import { FreeCameraControls, isCameraInputTarget } from './camera/FreeCameraControls.ts';
import { OrbitFrameControls } from './camera/OrbitFrameControls.ts';
import { Sky } from './sky/Sky.ts';
import { DayCycle, DAY_PRESETS, type DayPreset } from './sky/DayCycle.ts';
import { Weather, WEATHER_PRESETS, type WeatherName } from './sky/Weather.ts';
import { QUALITY_TIERS, qualityFromURL, qualityProfile, type QualityProfile, type QualityTier } from './Quality.ts';
import { Wind } from './weather/Wind.ts';
import { Rain, setRainShading } from './weather/Rain.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { Caustics } from './ocean/Caustics.ts';
import { Water } from './ocean/Water.ts';
import { StormSea } from './ocean/StormSea.ts';
import { bakeProceduralTextures } from './materials/ProceduralTextures.ts';
import { soilUniforms } from './materials/Soil.ts';
import { loadWorld, buildWorldMeshes, shoreTextureFrom, type LoadedWorld } from './world/World.ts';
import { buildGrass, setGrassQuality } from './world/Grass.ts';
import { meadowCanopy, trackMeadowCanopy } from './lighting/MeadowCanopy.ts';
import { buildFoliage } from './world/Foliage.ts';
import { buildRimFoliage } from './world/RimFoliage.ts';
import { buildTurfSkirt } from './world/RimSkirt.ts';
import { buildFlowers } from './world/Flowers.ts';
import { pickPlantSites, bakeGroundContact, bakeAnchorContact } from './world/PlantSites.ts';
import { buildPlants } from './world/Plants.ts';
import { Pipeline, TONE_CURVES, LOOKS, DEFAULT_LOOK, postOptionsFromURL, type ToneCurve, type LookName } from './post/Pipeline.ts';
import { renderPixelRatio, outputPixelRatio } from './post/RenderScale.ts';
import { DynamicResolution, GpuFrameTimer } from './post/DynamicResolution.ts';
import { shared } from './shared.ts';
import { installOpenShadow } from './lighting/SolarShadow.ts';
import { SunShadow } from './lighting/SunShadow.ts';
import { RefractedSun } from './lighting/RefractedSun.ts';
import { islandSurfaceHeight, ISLAND_TOP } from './world/WorldShapes.ts';
import { WALK_LOOP, walkLoopDistance } from './world/WalkLoop.ts';
import { Villagers, loadVillager } from './characters/Villagers.ts';
import { CharacterShadow } from './characters/CharacterShadow.ts';
import { characterLook, KIND } from './characters/CharacterMaterial.ts';
import { debugFlags } from './debug/DebugFlags.ts';
import { installVegetationPrepass } from './world/VegetationPrepass.ts';

const params = new URLSearchParams( location.search );
// The world's generation needs nothing from the page, so its workers start first and run while
// the renderer, sky, textures and frame graph are set up; its result is awaited below. The world
// worker's last result comes from IndexedDB while the generator and its options are unchanged
// (src/world/WorldCache.ts); ?worldCache=off generates it regardless, as on a first visit. A
// browser without WebGPU stops at the renderer below, so it starts no workers.
const worldJob: Promise<LoadedWorld> = 'gpu' in navigator ? loadWorld( {}, { cache: ! params.getAll( 'worldCache' ).some( ( v ) => v === 'off' || v === '0' ) } )
	: new Promise( () => undefined );
worldJob.catch( () => undefined ); // reported where it is awaited, under the world section
const ground = { soil: params.get( 'soil' ) !== '0' };
soilUniforms.strength.value = ground.soil ? 1 : 0;
soilUniforms.blend.value = params.get( 'blend' ) === '0' ? 0 : 1;
// GPU time per pass, tick time and startup marks for tools/profile-frame.mjs (?profile, or
// ?profile=frames without the GPU timestamps). The profiler loads only then; without it the
// renderer, its pipelines and the image are unchanged.
const profiler = params.has( 'profile' ) ? ( await import( './debug/FrameProfiler.ts' ) ).createFrameProfiler( THREE.InspectorBase, { timestamps: params.get( 'profile' ) !== 'frames' } ) : null;
const mark = ( name: string ) => profiler?.mark( name );
// scene handles and frame diagnostics on window, for the capture tool and the console: dev server,
// ?debug or ?profile only
const DEBUG = import.meta.env.DEV || params.has( 'debug' ) || profiler !== null;
// The quality tier (Quality.ts): its load knobs are read below as the parts they shape are built,
// its runtime ones applied by applySkyQuality. A change of tier reloads the page.
const qualityTier: QualityTier = qualityFromURL();
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

// The scene renders at a pixel ratio set by the quality tier (see RenderScale.ts), at most the
// display's and DPR_CAP; the canvas matches the display and the frame graph upscales to it.
// Explicit DPR captures and the full-resolution control lift the tier's pixel budget and pin a
// dynamic scale at its nominal.
const DPR_CAP = params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : 1.5;
const resolution = { full: params.has( 'dpr' ), render: '', scale: '' };
renderer.setPixelRatio( outputPixelRatio( 1 ) );
renderer.setSize( innerWidth, innerHeight );
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
document.getElementById( 'app' )!.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const waterScene = new THREE.Scene();
const rainScene = new THREE.Scene();

// The far plane reaches past the horizon so the sea's skirt meets the sky (the resolved sky
// depth, -1e5, stays beyond it).
const camera = new THREE.PerspectiveCamera( 27, innerWidth / innerHeight, 1, 60000 );
const target = new THREE.Vector3( 1.5, 0.5, 1.0 );
const view = { distance: Number( params.get( 'dist' ) ?? 58 ), polar: Number( params.get( 'polar' ) ?? 50 ), azimuth: Number( params.get( 'az' ) ?? 318 ) };
camera.position.setFromSphericalCoords( view.distance, THREE.MathUtils.degToRad( view.polar ), THREE.MathUtils.degToRad( view.azimuth ) ).add( target );
// the orbit's damping advances once per rendered frame, by its length (OrbitFrameControls.ts)
const controls = new OrbitFrameControls( camera, renderer.domElement );
controls.target.copy( target );
controls.enableDamping = true;
controls.damping = 0.06;
controls.minDistance = 22;
controls.maxDistance = 190;
controls.maxPolarAngle = THREE.MathUtils.degToRad( 82 );
controls.settle();
const initialCameraPosition = camera.position.clone();
const initialCameraQuaternion = camera.quaternion.clone();
const initialCameraFov = camera.fov;
const orbitMaxPolar = controls.maxPolarAngle;
const orbitMinDistance = controls.minDistance;
const freeControls = new FreeCameraControls( camera, renderer.domElement );

// ------------------------------------------------------------------ sky, light, water optics

const sky = new Sky( renderer, { elevation: 32, azimuth: - 8 } );
sky.setEnvironmentSource( quality.environmentSource );
const numberParam = ( name: string, fallback: number ) => {

	const value = Number( params.get( name ) ?? fallback );
	return Number.isFinite( value ) ? value : fallback;

};
// A 48-minute day, as in many open-world games: slow enough to watch the light and the stars
// turn. The default first-quarter moon lights the evening and sets at midnight, leaving the
// small hours dark enough for the Milky Way.
const dayCycle = new DayCycle( { hour: numberParam( 'hour', 16 ), dayLength: Math.max( 30, numberParam( 'dayLength', 2880 ) ),
	paused: params.has( 'paused' ) || params.get( 'clock' ) === 'paused', moonPhase: numberParam( 'moon', 0.25 ) } );
const requestedWeather = params.get( 'weather' ) ?? 'fair';
const weather = new Weather( Object.hasOwn( WEATHER_PRESETS, requestedWeather ) ? requestedWeather as WeatherName : 'fair' );
const weatherEffects = { rain: true, wetness: true };
// Without a requested preset the weather evolves on its own; choosing one holds it.
weather.auto = ! params.has( 'weather' );
const requestedPreset = params.get( 'preset' );
if ( requestedPreset && Object.hasOwn( DAY_PRESETS, requestedPreset ) ) dayCycle.setPreset( requestedPreset as DayPreset );
let manualSun = false;
let paused = params.has( 'paused' );
let simTime = Math.max( 0, numberParam( 't', 0 ) );
const wind = new Wind( shared.wind, { speed: weather.state.windSpeed, heading: weather.state.windDirection, time: simTime } );
let rain: Rain | undefined;
let skyElapsed = 0;
let lastSkyTime = simTime;
let lastSkyHour = dayCycle.hour;
let lastWeatherSignature = '';
// Explicit cloud tuning is a review override; selecting a weather preset restores authored coverage.
let cloudOverride: number | null = params.has( 'clouds' ) ? THREE.MathUtils.clamp( numberParam( 'clouds', 0.32 ), 0, 1 ) : null;
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

}
let runtimeQuality: Readonly<QualityProfile> = quality;
// A tier change rebuilds materials and the frame graph: reload with the tier and the page's options.
function reloadWithQuality( tier: QualityTier ): void {

	const url = new URL( location.href );
	url.searchParams.set( 'quality', tier );
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
	trackMeadowCanopy( sky.keyDir );
	shared.sunColor.value.set( sky.keyColor.r, sky.keyColor.g, sky.keyColor.b );
	shared.glintScale.value = sky.glintScale;
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
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( bakeEnvironment );
	return sunUpdates;

}

function applySun(): Promise<void> {

	manualSun = true;
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( bakeEnvironment );
	return sunUpdates;

}

const setHour = async ( hour: number ) => { dayCycle.setHour( hour ); await refreshEnvironment(); };
const setPreset = async ( preset: DayPreset ) => { dayCycle.setPreset( preset ); await refreshEnvironment(); };
const setWeather = async ( name: WeatherName, seconds = 20 ) => {

	cloudOverride = null;
	weather.auto = false;
	weather.setWeather( name, seconds );
	if ( seconds === 0 ) await refreshEnvironment();

};
// A scene as its URL options load it, for the frame profiler's scene switches within one page
// load: the weather established at once (wet in rain), the time preset or hour, the scene clock
// (and the wind integrated to it), with one bake of the environment.
const establishScene = async ( options: { weather?: WeatherName; preset?: DayPreset; hour?: number; time?: number } ) => {

	cloudOverride = null;
	if ( options.weather ) {

		weather.auto = false;
		weather.establish( options.weather );

	}
	if ( options.preset ) dayCycle.setPreset( options.preset );
	else if ( options.hour !== undefined ) dayCycle.setHour( options.hour );
	if ( options.time !== undefined ) simTime = options.time;
	wind.reset( { speed: weather.state.windSpeed, heading: weather.state.windDirection, time: simTime } );
	await refreshEnvironment();

};

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
	swell: { height: 0.18 },
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
const pipeline = new Pipeline( renderer, sky, rain, postOptionsFromURL( location.search, quality.post ) );
const requestedTone = params.get( 'tone' ) as ToneCurve | null;
if ( requestedTone && TONE_CURVES.includes( requestedTone ) ) pipeline.setToneMapping( requestedTone );
const requestedLook = params.get( 'look' ) as LookName | null;
pipeline.setLook( requestedLook && LOOKS.includes( requestedLook ) ? requestedLook : DEFAULT_LOOK );
rain.bindOpaqueDepth( pipeline.depthRT.texture, pipeline.surfaceRT.texture );
rainScene.add( rain.group );

// ------------------------------------------------------------------ first-use pipelines

// A weather change, the first bolt and the sky's first periodic bake used to build their
// pipelines in the frame they first drew (rain's drops and splashes, the bolt's two passes, the
// sky's blends and filters, the fog's passes: a dropped frame each). They are compiled ahead
// instead, through the async pipeline calls, so the GPU process builds them off the main thread
// while the world is generated and built; the loop starts once they are ready. The scene's draws
// compile for the scene's multisampled target (`Pipeline.sceneRT`), which is part of their
// pipelines' keys. The storm's foam and spray need the world's shore fields and compile with it.
const warming = Promise.all( [
	rain.warm( renderer, rainScene, camera, pipeline.sceneRT ),
	sky.lightning.warm( renderer, scene, camera, pipeline.sceneRT ),
	sky.warm( renderer ),
	pipeline.warm(),
] );
warming.catch( () => undefined ); // reported where it is awaited, before the loop

// ------------------------------------------------------------------ world

setStatus( 'Generating the island…' );
const t0 = performance.now();
const worldCache = await worldJob;
const data = worldCache.data;
mark( 'world' );
const shore = shoreTextureFrom( data.shore );
shared.shoreXform.value.copy( shore.xform );
// The floor's height shares the shoreline field's bounds, and so its transform.
const seabedField = shoreTextureFrom( data.seabedField );
const shoreWaves = new ShoreWaves( renderer, data, shared, shore.tex, fft );
// Shrubs, small trees, tussocks and tall flowers keep clear of the islander's walking loop.
const walkDistance = walkLoopDistance( WALK_LOOP );
// Shrubs and small trees on the island top, and the ambient shade they cast on the turf around
// them, baked into the island's occlusion before its mesh is built.
const plantSites = pickPlantSites( data.vegetation, walkDistance );
for ( const m of data.meshes ) if ( m.kind === 'cliff' ) bakeGroundContact( m, plantSites, ISLAND_TOP );
const world = buildWorldMeshes( data, textures, shared, caustics, shore.tex );
scene.add( world.group );
const refractedSun = new RefractedSun( renderer, shared );
runtime.refractedSun = refractedSun;
refractedSun.angleGate = THREE.MathUtils.degToRad( runtimeQuality.refractedSun.angleGate );
refractedSun.setCasters( world.group );
refractedSun.bindTerrain( world.group );
await refractedSun.prepare();
const foliage = buildFoliage( data.vegetation, shared );
// The grass and flowers read the anchors' sky visibility with the plants' shade in it.
bakeAnchorContact( data.vegetation, plantSites );
setGrassQuality( quality.grass );
const grass = buildGrass( data.vegetation, shared, data.rimGround, walkDistance );
const flowers = buildFlowers( data.vegetation, shared, walkDistance );
const rimFoliage = buildRimFoliage( data.rimStrands, shared, foliage );
const turfSkirt = buildTurfSkirt( data.rimSkirt, shared );
const plants = buildPlants( plantSites, shared );
scene.add( grass, foliage, flowers, rimFoliage, turfSkirt, plants );
installVegetationPrepass( scene, [ grass, foliage, rimFoliage, plants ] );
{

	// Everything that casts into the sun's map: the figures cast through their own map, and the
	// sea floor's stones only into the refracted one.
	const casters = new THREE.Box3();
	for ( const root of [ world.group, foliage, flowers, rimFoliage, turfSkirt, plants ] ) {

		root.updateWorldMatrix( true, true );
		root.traverse( ( object ) => { if ( ( object as THREE.Mesh ).isMesh && object.castShadow ) casters.expandByObject( object ); } );

	}
	sunShadow.setCasters( casters );

}
// Drops stop on the first surface they meet: rock, turf, blades, leaves.
rain.bakeCollision( renderer, [ world.group, grass, foliage, flowers, rimFoliage, turfSkirt, plants ] );
mark( 'meshes' );
setStatus( 'Waking the villagers…' );
// Local, unversioned assets (artifacts/ is git-ignored) served by the dev server while the
// character art is still changing.
const umc = ( name: string ) => `/artifacts/assets/quaternius/ultimate-modular-characters/${ name }.gltf`;
// A plain villager while the islanders' basic look settles: bare head (so the pointed ears read),
// an undyed linen shirt, muted warm brown trousers and dark leather shoes, all repainted in the
// island's palette (sRGB, as they should read in sunlight). The kit's pockets, trims and two-tone
// panels are painted over in one colour.
const islander = await loadVillager( umc( 'Farmer' ), [
	{ from: umc( 'Casual_2' ), part: 'Casual2_Head', paint: { Skin: [ '#e2a882', KIND.skin ], Skin_Darker: [ '#e2a882', KIND.skin ], Eyebrows: [ '#4a2f22', KIND.hair ], Hair: [ '#5a3a26', KIND.hair ], Eye: [ '#2a1d18', KIND.cloth ] } },
	{ from: umc( 'Adventurer' ), part: 'Adventurer_Body', paint: { Skin: [ '#e2a882', KIND.skin ], Green: [ '#dccfae', KIND.cloth ], LightGreen: [ '#dccfae', KIND.cloth ] }, hands: [ '#e2a882', KIND.skin ] },
	{ from: umc( 'Adventurer' ), part: 'Adventurer_Legs', paint: { Brown: [ '#634a36', KIND.cloth ], Brown2: [ '#634a36', KIND.cloth ] } },
	{ from: umc( 'Farmer' ), part: 'Farmer_Feet', paint: { Brown: [ '#4a3626', KIND.leather ], Brown2: [ '#2e241c', KIND.leather ] } },
], shared );
const characters = new Villagers( islander, WALK_LOOP, islandSurfaceHeight, characterShadow );
scene.add( characters.group );
mark( 'villagers' );

// Storm whitecap foam with a memory, and the spray torn off breaking crests (idle in calm weather).
const stormSea = new StormSea( renderer, fft, shared, shore.tex, shoreWaves, {
	sunDir: shared.sunDir, sunColor: shared.sunColor,
	sky: shared.skyIrradianceSource.div( shared.skyFill.max( 1 ).sqrt() ),
	sunVisibility: ( p ) => sky.cloudVisibility( p ), opaqueDepth: pipeline.depthRT.texture,
} );
water = new Water( {
	fft, sky, shared, shore: shore.tex, seabedHeight: seabedField.tex, shoreWaves, refractedSun, sunShadow, storm: stormSea,
	sceneColor: pipeline.opaqueRT.texture, linearDepth: pipeline.depthRT.texture, quality: quality.water,
} );
applySkyFill();
waterScene.add( water.mesh, stormSea.spray.mesh );

console.info( worldCache.cache === 'hit' ? 'world from the cache' : 'world generated', data.timings, 'triangles', world.triangles, 'in', Math.round( performance.now() - t0 ), 'ms' );

// ------------------------------------------------------------------ GUI

const gui = new GUI( { title: 'Soomi · lighting & water' } );
if ( ! params.has( 'gui' ) ) gui.hide();
const S = pipeline.settings;
type CameraView = 'island' | 'horizon' | 'sky';
const cameraSettings = { mode: params.get( 'camera' ) === 'free' ? 'free' : 'orbit' };
const reviewView = { camera: 'island' as CameraView };
let orbitDof = S.dof;
const viewDirection = new THREE.Vector3();

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

}

function setCameraMode( mode: string ): void {

	if ( controls.enabled ) settleOrbit();
	if ( mode === 'free' && ! freeControls.enabled ) orbitDof = S.dof;
	if ( mode === 'orbit' && freeControls.enabled ) {

		camera.getWorldDirection( viewDirection );
		controls.target.copy( camera.position ).addScaledVector( viewDirection, 58 );

	}
	cameraSettings.mode = mode;
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
	if ( view === 'sky' ) {

		camera.position.set( 0, 15, 0 );
		viewDirection.copy( sky.sunDir.y > 0 ? sky.sunDir : sky.moonDir );
		// At new moon both bodies can be below the horizon; keep the review aimed at the sky.
		if ( viewDirection.y <= 0 ) viewDirection.set( 0.6, 0.72, 0.35 ).normalize();
		controls.target.copy( camera.position ).addScaledVector( viewDirection, 0.05 );
		camera.fov = 65;
		camera.lookAt( controls.target );

	} else if ( view === 'horizon' ) {

		controls.target.copy( target );
		camera.position.setFromSphericalCoords( 110, THREE.MathUtils.degToRad( 82 ), THREE.MathUtils.degToRad( 125 ) ).add( target );
		camera.fov = 55;
		camera.lookAt( controls.target );

	} else {

		controls.target.copy( target );
		camera.position.copy( initialCameraPosition );
		camera.quaternion.copy( initialCameraQuaternion );
		camera.fov = initialCameraFov;

	}
	camera.updateProjectionMatrix();
	applyOrbitLimit();
	if ( controls.enabled ) controls.settle();

}

setCameraMode( cameraSettings.mode );
const cameraF = gui.addFolder( 'Camera' );
cameraF.add( cameraSettings, 'mode', [ 'free', 'orbit' ] ).name( 'camera mode' ).listen().onChange( setCameraMode );
cameraF.add( reviewView, 'camera', [ 'island', 'horizon', 'sky' ] ).name( 'view' ).listen().onChange( setCameraView );
cameraF.add( freeControls, 'speed', 1, 160, 1 ).name( 'flight speed' ).listen();
cameraF.add( camera, 'fov', 15, 100, 1 ).name( 'field of view' ).listen().onChange( () => camera.updateProjectionMatrix() );
cameraF.add( { reset: () => setCameraView( 'island' ) }, 'reset' ).name( 'return to island (R)' );
const environmentLook = { exposure: true };
const W = water.uniforms;
// The quality tier sets every knob of the frame's cost (Quality.ts); a change reloads the page.
const performanceF = gui.addFolder( 'Performance' );
performanceF.add( skyQuality, 'value', QUALITY_TIERS ).name( 'quality (reloads)' ).onFinishChange( ( tier: QualityTier ) => { if ( tier !== qualityTier ) reloadWithQuality( tier ); } );
performanceF.add( resolution, 'full' ).name( 'full resolution' ).onChange( resize );
performanceF.add( pipeline.sharpness, 'value', 0, 2, 0.05 ).name( 'upscale softness' );
performanceF.add( resolution, 'scale' ).name( 'render scale' ).listen().disable();
performanceF.add( resolution, 'render' ).name( 'render → canvas' ).listen().disable();
const groundF = gui.addFolder( 'Ground' );
groundF.add( ground, 'soil' ).name( 'soil layer' ).onChange( ( enabled: boolean ) => {

	soilUniforms.strength.value = enabled ? 1 : 0;
	invalidateSunShadow();

} );
groundF.add( soilUniforms.depth, 'value', 0.5, 1.75, 0.05 ).name( 'soil depth' ).onChange( invalidateSunShadow );
groundF.add( soilUniforms.blend, 'value', 0, 1, 0.01 ).name( 'grass / soil' ).onChange( invalidateSunShadow );
const sunF = gui.addFolder( 'Sun' );
const cloudF = gui.addFolder( 'Sky & clouds' );
cloudF.add( sky.clouds.coverage, 'value', 0, 1, 0.01 ).name( 'cloud cover override' ).onFinishChange( ( value: number ) => { cloudOverride = value; void refreshEnvironment(); } );
const weatherF = gui.addFolder( 'Weather' );
const weatherView = { preset: weather.target, seconds: 20 };
weatherF.add( weatherView, 'preset', Object.keys( WEATHER_PRESETS ) ).name( 'weather' ).listen().onChange( ( name: WeatherName ) => { void setWeather( name, weatherView.seconds ); } );
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

// ------------------------------------------------------------------ loop

// High's render scale is dynamic (DynamicResolution.ts): it moves between the tier's nominal and
// a floor by the GPU's frame time, and renders at the nominal while it is pinned (?dpr, full
// resolution) or the scene is paused, so paused frames and captures render at the reference scale.
const dynamicRule = 'dynamic' in quality.render ? quality.render.dynamic : null;
const dynamicResolution = dynamicRule ? new DynamicResolution( dynamicRule ) : null;
// the render scale each frame was drawn at (by three's frame id), for the GPU times read back later
const frameScales = new Map<number, number>();
let gpuTimer: GpuFrameTimer | null = null;
if ( dynamicResolution ) {

	const sample = ( frame: number, ms: number ) => {

		const scale = frameScales.get( frame );
		if ( scale !== undefined ) dynamicResolution.sample( ms, scale );

	};
	// the frame profiler owns the timestamp queries while it times passes
	if ( profiler?.timestamps ) profiler.onRecord = ( record ) => { if ( record.missing === 0 && record.passes > 0 ) sample( record.id, record.gpu ); };
	else {

		gpuTimer = GpuFrameTimer.create( renderer );
		if ( gpuTimer ) gpuTimer.onFrame = sample;

	}

}

const canvasSize = new THREE.Vector2();
let nominalScale = 1, renderScale = 1;
function resize(): void {

	const w = innerWidth, h = innerHeight;
	nominalScale = renderPixelRatio( w, h, quality.render, resolution.full, DPR_CAP );
	dynamicResolution?.setMax( nominalScale );
	renderer.setPixelRatio( outputPixelRatio( nominalScale ) );
	renderer.setSize( w, h );
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	applyRenderScale( true );

}

/** The scale this frame renders at: the dynamic one, unless pinned or paused. */
function currentRenderScale(): number {

	if ( ! dynamicResolution || resolution.full || paused ) return nominalScale;
	return Math.min( dynamicResolution.scale, nominalScale );

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
	resolution.render = `${ rw }x${ rh } → ${ canvasSize.x }x${ canvasSize.y }` + ( pipeline.upscaling ? ` (${ Math.round( rw / canvasSize.x * 100 ) } %, FSR)` : '' );
	describeRenderScale();

}

// The GUI's line: the scale, how it is set and (dynamic) the GPU's recent frame time.
function describeRenderScale(): void {

	const d = dynamicResolution;
	const how = ! d ? 'fixed' : resolution.full ? 'pinned' : paused ? 'paused: nominal' : `dynamic ${ d.floor }-${ d.max }`;
	const gpu = d && d.observed.length ? `, GPU ${ [ ...d.observed ].sort( ( a, b ) => a - b )[ d.observed.length >> 1 ].toFixed( 1 ) } ms` : '';
	resolution.scale = `${ renderScale.toFixed( 2 ) } (${ how }${ gpu })`;

}

addEventListener( 'resize', resize );
resize();

const clock = new THREE.Timer();
clock.connect( document );
let frame = 0;
addEventListener( 'keydown', ( e ) => {

	if ( e.repeat || e.ctrlKey || e.metaKey || e.altKey || isCameraInputTarget( e.target ) ) return;
	if ( e.code === 'Space' ) { e.preventDefault(); paused = ! paused; dayCycle.paused = paused; }
	if ( e.code === 'KeyH' ) gui.show( gui._hidden );
	if ( e.code === 'KeyR' || e.code === 'Digit1' ) setCameraView( 'island' );
	if ( e.code === 'Digit2' ) setCameraView( 'horizon' );
	if ( e.code === 'Digit3' ) setCameraView( 'sky' );

} );

const frameTimes: number[] = [];
let shadowElapsed = 0;
function tick(): void {

	clock.update();
	const rawDt = clock.getDelta();
	frameTimes.push( rawDt * 1000 );
	if ( frameTimes.length > 120 ) frameTimes.shift();
	const dt = Math.min( rawDt, 1 / 20 );
	// Lighting cadence follows wall time even below 20 FPS. Bound a resumed/stalled frame;
	// the scheduler still submits at most one coalesced bake instead of catching up a queue.
	const environmentDt = Math.min( rawDt, 1 );
	if ( ! paused ) simTime += dt;
	dayCycle.advance( rawDt );
	weather.update( paused ? 0 : rawDt );
	weatherView.preset = weather.target;
	if ( freeControls.enabled ) freeControls.update( rawDt );
	else controls.advance( dt );

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
	shared.wetness.value = weatherEffects.wetness ? weather.state.wetness : 0;
	fft.weatherGain.value.copy( shared.wind.oceanGain.value );
	rain!.uniforms.rain.value = shared.rain.value;
	rain!.uniforms.wind.value.copy( shared.wind.velocity.value );
	rain!.uniforms.waterLevel.value = shared.waterLevel.value;
	rain!.update( renderer, camera, simTime, shared.wind.displacement.value, pipeline.height );
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
	characters.update( renderer, scene, sun, simTime, paused ? 0 : dt );
	S.focusDistance = camera.position.distanceTo( controls.target );
	rain!.setFocus( S.focusDistance, S.dofRange, S.dofMaxRadius * pipeline.height / 900, S.dof );

	pipeline.render( { scene, waterScene, rainScene: rain!.mesh.visible ? rainScene : undefined, camera, water: water!, sun, time: simTime } );
	steerRenderScale( rawDt );
	frame ++;
	diagnostics();

}

// After the frame's passes: read the GPU times back and move the dynamic scale (it applies from the
// next frame on). Paused or pinned, the window keeps no samples and the scale holds.
function steerRenderScale( rawDt: number ): void {

	if ( ! dynamicResolution ) return;
	const steering = ! paused && ! resolution.full && renderScale === dynamicResolution.scale;
	frameScales.set( renderer.info.frame, steering ? renderScale : NaN );
	if ( frameScales.size > 240 ) frameScales.delete( frameScales.keys().next().value! );
	gpuTimer?.resolve();
	if ( steering ) {

		dynamicResolution.sampleInterval( rawDt * 1000 );
		dynamicResolution.update();

	}
	applyRenderScale();
	if ( frame % 30 === 0 ) describeRenderScale();

}

function diagnostics(): void {

	if ( ! DEBUG || frame % 30 !== 1 ) return;
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
		canvasDpr: renderer.getPixelRatio(),
		worldTriangles: world.triangles,
		rimStrands: data.rimStrands.length,
		timings: data.timings,
		worldCache: worldCache.cache === 'off' ? 'off' : { cache: worldCache.cache, ms: + worldCache.ms.toFixed( 1 ) },
		backend: 'webgpu',
		hour: + dayCycle.hour.toFixed( 4 ),
		clockPaused: dayCycle.paused,
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
	};

}

// The storm's foam and spray need the world's shore fields, so they compile last; the loop then
// waits for every first-use pipeline (see "first-use pipelines").
await Promise.all( [ warming, stormSea.warm( renderer, waterScene, camera, pipeline.sceneRT ) ] );

if ( profiler ) {

	const { labelSoomiPasses } = await import( './debug/FrameProfiler.ts' );
	labelSoomiPasses( profiler, { scene, waterScene, rainScene, pipeline, sky, rain, sunShadow, refractedSun, fft, stormSea, shoreWaves, caustics, characters } );

}
mark( 'loop' );
const animationLoop = profiler ? profiler.wrapLoop( tick ) : tick;
renderer.setAnimationLoop( animationLoop );
loading?.classList.add( 'done' );
// setTime moves the (paused) clock, so captures can step through an animation in one page load
const setTime = ( t: number ) => {

	if ( ! Number.isFinite( t ) || t < 0 ) throw new RangeError( 'Scene time must be finite and non-negative' );
	simTime = t;
	wind.reset( { speed: sky.weather.windSpeed, heading: sky.weather.windDirection, time: t } );
	return refreshEnvironment();

};
// Stops and restarts the frame loop, so the profiler can keep two pages in one browser and time one
// at a time: stopped, the page requests no frames and leaves the GPU idle once the frames already
// queued and a sky bake in flight are done (the bake is given 2 s). The clock resumes where it
// stopped. Chrome let one page's stream of frames starve another's queue, so the profiler stops
// one page and waits for this before it starts the other.
const animation = ( renderer as unknown as { _animation: { start(): void; stop(): void } } )._animation;
const loop = {
	running: true,
	async stop(): Promise<void> {

		if ( ! loop.running ) return;
		loop.running = false;
		animation.stop();
		const until = performance.now() + 2000;
		while ( sky.busy && performance.now() < until ) await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		await ( renderer.backend as unknown as { device: { queue: { onSubmittedWorkDone(): Promise<void> } } } ).device.queue.onSubmittedWorkDone();

	},
	start(): void {

		if ( loop.running ) return;
		loop.running = true;
		clock.reset();
		animation.start();

	},
};
if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__SOOMI__ = { renderer, scene, camera, controls, freeControls, cameraSettings, setCameraMode, setCameraView, sky, sun, fft, shoreWaves, stormSea, caustics, water, pipeline, shared, refractedSun, grass, meadowCanopy, foliage, flowers, rimFoliage, turfSkirt, plants, characters, soilUniforms, dayCycle, weather, weatherEffects, wind, rain, setWeather, establishScene, applySun, refreshEnvironment, setHour, setPreset, sunShadow, invalidateSunShadow, setTime, loop, flags: debugFlags,
	quality, dynamicResolution, applyQuality: ( overrides: Partial<QualityProfile> ) => applySkyQuality( { ...quality, ...overrides } ) };
