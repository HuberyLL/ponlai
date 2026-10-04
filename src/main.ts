import * as THREE from 'three/webgpu';
import { Fn, positionWorld } from 'three/tsl';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Sky } from './sky/Sky.ts';
import { DayCycle, DAY_PRESETS, type DayPreset } from './sky/DayCycle.ts';
import { Weather, WEATHER_PRESETS, WEATHER_QUALITY, type WeatherName, type WeatherQuality } from './sky/Weather.ts';
import { Wind } from './weather/Wind.ts';
import { Rain } from './weather/Rain.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { Caustics } from './ocean/Caustics.ts';
import { Water } from './ocean/Water.ts';
import { bakeProceduralTextures } from './materials/ProceduralTextures.ts';
import { soilUniforms } from './materials/Soil.ts';
import { generateWorld, buildWorldMeshes, shoreTextureFrom } from './world/World.ts';
import { buildGrass } from './world/Grass.ts';
import { buildFoliage } from './world/Foliage.ts';
import { buildRimFoliage } from './world/RimFoliage.ts';
import { buildFlowers } from './world/Flowers.ts';
import { Pipeline } from './post/Pipeline.ts';
import { shared } from './shared.ts';
import { installSolarShadowFilter } from './lighting/SolarShadow.ts';
import { RefractedSun } from './lighting/RefractedSun.ts';
import { islandSurfaceHeight } from './world/WorldShapes.ts';
import { Villagers, loadVillager } from './characters/Villagers.ts';
import { CharacterShadow } from './characters/CharacterShadow.ts';
import { characterLook, KIND } from './characters/CharacterMaterial.ts';

const params = new URLSearchParams( location.search );
const ground = { soil: params.get( 'soil' ) !== '0' };
soilUniforms.strength.value = ground.soil ? 1 : 0;
soilUniforms.blend.value = params.get( 'blend' ) === '0' ? 0 : 1;
// scene handles and frame diagnostics on window, for the capture tool and the console: dev server
// or ?debug only
const DEBUG = import.meta.env.DEV || params.has( 'debug' );
const loading = document.getElementById( 'loading' );
const setStatus = ( s: string ) => { const el = loading?.querySelector( 'span' ); if ( el ) el.textContent = s; };

// ------------------------------------------------------------------ renderer

const renderer = new THREE.WebGPURenderer( { antialias: false, powerPreference: 'high-performance' } );
await renderer.init();
if ( ( renderer.backend as unknown as { isWebGPUBackend?: boolean } ).isWebGPUBackend !== true ) {

	setStatus( 'This scene needs WebGPU (Chrome / Edge 113+, Safari 26+).' );
	throw new Error( 'WebGPU is not available' );

}

const DPR_CAP = params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : 1.5;
const resolution = { full: params.has( 'dpr' ) };
const DEFAULT_PIXEL_BUDGET = 1920 * 1080;
function renderPixelRatio( width: number, height: number ): number {

	const requested = Math.min( devicePixelRatio, DPR_CAP );
	// Ocean optics and post effects scale with pixel count. Bound the default workload on
	// large/high-DPI windows; explicit DPR captures and the full-resolution control opt out.
	return resolution.full ? requested : Math.min( requested, Math.sqrt( DEFAULT_PIXEL_BUDGET / ( width * height ) ) );

}
renderer.setPixelRatio( renderPixelRatio( innerWidth, innerHeight ) );
renderer.setSize( innerWidth, innerHeight );
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
document.getElementById( 'app' )!.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const waterScene = new THREE.Scene();
const rainScene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera( 27, innerWidth / innerHeight, 1, 2600 );
const target = new THREE.Vector3( 1.5, 0.5, 1.0 );
const view = { distance: Number( params.get( 'dist' ) ?? 58 ), polar: Number( params.get( 'polar' ) ?? 50 ), azimuth: Number( params.get( 'az' ) ?? 318 ) };
camera.position.setFromSphericalCoords( view.distance, THREE.MathUtils.degToRad( view.polar ), THREE.MathUtils.degToRad( view.azimuth ) ).add( target );
const controls = new OrbitControls( camera, renderer.domElement );
controls.target.copy( target );
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.minDistance = 22;
controls.maxDistance = 190;
controls.maxPolarAngle = THREE.MathUtils.degToRad( 82 );
controls.update();

// ------------------------------------------------------------------ sky, light, water optics

const sky = new Sky( renderer, { elevation: 32, azimuth: - 8 } );
const numberParam = ( name: string, fallback: number ) => {

	const value = Number( params.get( name ) ?? fallback );
	return Number.isFinite( value ) ? value : fallback;

};
const dayCycle = new DayCycle( { hour: numberParam( 'hour', 16 ), dayLength: Math.max( 30, numberParam( 'dayLength', 600 ) ),
	paused: params.has( 'paused' ) || params.get( 'clock' ) === 'paused', moonPhase: numberParam( 'moon', 0.5 ) } );
const requestedWeather = params.get( 'weather' ) ?? 'fair';
const weather = new Weather( Object.hasOwn( WEATHER_PRESETS, requestedWeather ) ? requestedWeather as WeatherName : 'fair' );
const weatherEffects = { rain: true, wetness: true };
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
sky.clouds.windOffset.value.copy( shared.wind.cloudOffset.value );
const requestedQuality = params.get( 'quality' ) ?? 'medium';
const skyQuality = { value: ( Object.hasOwn( WEATHER_QUALITY, requestedQuality ) ? requestedQuality : 'medium' ) as WeatherQuality };
function applySkyQuality(): void {

	sky.setQuality( skyQuality.value === 'low' ? 'low' : skyQuality.value === 'high' ? 'high' : 'medium' );
	rain?.setQuality( WEATHER_QUALITY[ skyQuality.value ].rainDrops );

}
applySkyQuality();
scene.add( sky.dome );
scene.environmentIntensity = 1;
const lighting = { skyFill: 1 };

const sun = new THREE.DirectionalLight( 0xffffff, 1 );
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
const sc = sun.shadow.camera;
sc.left = - 36; sc.right = 36; sc.top = 36; sc.bottom = - 36; sc.near = 1; sc.far = 220;
// Bias in metres along the light ray, converted to this orthographic map's depth range.
// Receiver-plane correction in the shared filter keeps contacts sharp without a wide blur.
sun.shadow.bias = - 0.01 / ( sc.far - sc.near );
sun.shadow.normalBias = 0.012;
installSolarShadowFilter( sun );
// Cloud shadowing shares the density field in the visible/reflected sky. Bake its long solar
// path once at low resolution, then sample the same transmission on every receiver.
type ShadowFilter = ( input: { depthTexture: THREE.DepthTexture; shadowCoord: THREE.Node<'vec3'> } ) => THREE.Node<'float'>;
const solarShadow = sun.shadow as unknown as { filterNode: ShadowFilter };
const islandShadow = solarShadow.filterNode;
solarShadow.filterNode = Fn( ( { depthTexture, shadowCoord }: Parameters<ShadowFilter>[0] ) =>
	islandShadow( { depthTexture, shadowCoord } ).mul( sky.cloudVisibility( positionWorld ) ) ) as unknown as ShadowFilter;
// Moving figures cast through a small map of their own that every receiver multiplies in. It
// must be installed before any receiving material is built.
const characterShadow = new CharacterShadow();
characterShadow.install( sun );
// Vegetation casts its rest pose; wind only changes the visible mesh. The first render
// builds the complete map, then sunlight or caster edits explicitly invalidate it.
sun.shadow.autoUpdate = false;
function invalidateSunShadow(): void { sun.shadow.needsUpdate = true; }
invalidateSunShadow();
scene.add( sun, sun.target );

function fresnel( cosI: number, eta: number ): number {

	const g = Math.sqrt( eta * eta - 1 + cosI * cosI );
	const a = ( g - cosI ) / ( g + cosI ), b = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
	return 0.5 * a * a * ( b * b + 1 );

}

let sunUpdates = Promise.resolve();
function prepareSkyState(): void {

	sky.setCelestial( manualSun ? null : dayCycle.snapshot() );
	const state = weather.snapshot();
	if ( cloudOverride !== null ) state.coverage = cloudOverride;
	sky.setWeather( state );
	sky.clouds.windOffset.value.copy( shared.wind.cloudOffset.value );
	lastWeatherSignature = `${ state.coverage },${ state.density },${ state.directVisibility },${ state.ambientGain },${ state.haze }`;

}

function publishLighting(): void {

	sun.color.copy( sky.keyColor );
	sun.intensity = 1;
	sun.position.copy( sky.keyDir ).multiplyScalar( 120 ).add( sun.target.position );
	shared.sunDir.value.copy( sky.keyDir );
	shared.sunColor.value.set( sky.keyColor.r, sky.keyColor.g, sky.keyColor.b );
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
	weather.setWeather( name, seconds );
	if ( seconds === 0 ) await refreshEnvironment();

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
shared.skyIrradianceSource = sky.irradianceNode.mul( shared.skyFill );

const textures = await bakeProceduralTextures( renderer );
// Recover mid-scale wave volume through wind/fetch, while the spectrum still filters fine crests.
// Keep the swell broad and modest so it supports the body without becoming a dominant wave train.
const fft = new OceanFFT( renderer, {
	windSpeed: 3.8, windDirection: 40, fetch: 3500, amplitude: 0.76, choppiness: 0.55, spread: 0.52,
	swell: { height: 0.18 },
} );
const caustics = new Caustics( renderer, fft );
const pipeline = new Pipeline( renderer, sky );
rain = new Rain( { count: WEATHER_QUALITY[ skyQuality.value ].rainDrops } );
rain.bindOpaqueDepth( pipeline.depthRT.texture );
// Drops scatter the same linear environment and key light as the island, without an emissive
// floor. Using the GPU integral keeps their light in step with the displayed sky transition.
rain.setLightNode( shared.skyIrradianceSource.mul( 0.65 ).add( shared.sunColor.mul( 0.045 ) ) );
rainScene.add( rain.mesh );

// ------------------------------------------------------------------ world

setStatus( 'Generating the island…' );
const t0 = performance.now();
const data = await generateWorld();
const shore = shoreTextureFrom( data.shore );
shared.shoreXform.value.copy( shore.xform );
const shoreWaves = new ShoreWaves( renderer, data, shared, shore.tex, fft );
const world = buildWorldMeshes( data, textures, shared, caustics, shore.tex );
scene.add( world.group );
const refractedSun = new RefractedSun( renderer, shared );
refractedSun.setCasters( world.group );
refractedSun.bindTerrain( world.group );
await refractedSun.prepare();
const grass = buildGrass( data.vegetation, shared, data.rimGround );
const foliage = buildFoliage( data.vegetation, shared );
const flowers = buildFlowers( data.vegetation, shared );
const rimFoliage = buildRimFoliage( data.rimStrands, shared, foliage );
scene.add( grass, foliage, flowers, rimFoliage );
setStatus( 'Waking the villagers…' );
// Local, unversioned assets (artifacts/ is git-ignored) served by the dev server while the
// character art is still changing.
const umc = ( name: string ) => `/artifacts/assets/quaternius/ultimate-modular-characters/${ name }.gltf`;
// A fisherman: the farmer's straw hat and bib trousers, the adventurer's boots, all repainted
// in the island's palette (sRGB, as they should read in sunlight).
const fisherman = await loadVillager( umc( 'Farmer' ), [
	{ from: umc( 'Farmer' ), part: 'Farmer_Head', paint: { Skin: [ '#e2a882', KIND.skin ], Eyebrows: [ '#4a2f22', KIND.hair ], Beige: [ '#e3c88a', KIND.cloth ], Red: [ '#d2654a', KIND.cloth ], Eye: [ '#2a1d18', KIND.cloth ] } },
	{ from: umc( 'Farmer' ), part: 'Farmer_Body', paint: { Skin: [ '#e2a882', KIND.skin ], LightBlue: [ '#285878', KIND.cloth ], Brown: [ '#ece0c4', KIND.cloth ], Beige: [ '#d8c8a4', KIND.cloth ] }, hands: [ '#e2a882', KIND.skin ] },
	{ from: umc( 'Farmer' ), part: 'Farmer_Pants', paint: { LightBlue: [ '#285878', KIND.cloth ] } },
	{ from: umc( 'Adventurer' ), part: 'Adventurer_Feet', paint: { Grey: [ '#3c4a3e', KIND.leather ], Black: [ '#2a2622', KIND.leather ] } },
], shared );
const characters = new Villagers( fisherman, [ [ - 5.5, 1.5 ], [ - 1.5, 3.3 ], [ 3, 2.6 ], [ 5.6, 0 ], [ 3.8, - 2.8 ], [ - 0.5, - 2.7 ], [ - 4.5, - 1.8 ] ], islandSurfaceHeight, characterShadow );
scene.add( characters.group );

water = new Water( {
	fft, sky, shared, shore: shore.tex, shoreWaves, refractedSun,
	sceneColor: pipeline.sceneRT.texture, linearDepth: pipeline.depthRT.texture,
} );
water.uniforms.wind.value = fft.params.windSpeed;
applySkyFill();
waterScene.add( water.mesh );

console.info( 'world generated', data.timings, 'triangles', world.triangles, 'in', Math.round( performance.now() - t0 ), 'ms' );

// ------------------------------------------------------------------ GUI

const gui = new GUI( { title: 'Soomi · lighting & water' } );
if ( ! params.has( 'gui' ) ) gui.hide();
const S = pipeline.settings;
const environmentLook = { exposure: true };
const W = water.uniforms;
gui.addFolder( 'Performance' ).add( resolution, 'full' ).name( 'full resolution' ).onChange( resize );
const groundF = gui.addFolder( 'Ground' );
groundF.add( ground, 'soil' ).name( 'soil layer' ).onChange( ( enabled: boolean ) => {

	soilUniforms.strength.value = enabled ? 1 : 0;
	invalidateSunShadow();

} );
groundF.add( soilUniforms.depth, 'value', 0.5, 1.75, 0.05 ).name( 'soil depth' ).onChange( invalidateSunShadow );
groundF.add( soilUniforms.blend, 'value', 0, 1, 0.01 ).name( 'grass / soil' ).onChange( invalidateSunShadow );
const sunF = gui.addFolder( 'Sun' );
const cloudF = gui.addFolder( 'Sky & clouds' );
const reviewView = { camera: 'island' };
cloudF.add( reviewView, 'camera', [ 'island', 'horizon', 'sky' ] ).name( 'review camera' ).onChange( ( view: string ) => {

	controls.maxPolarAngle = view === 'sky' ? 2.8 : THREE.MathUtils.degToRad( 82 );
	if ( view === 'sky' ) {

		controls.target.set( 0, 65, 0 );
		camera.position.set( - 80, 20, 55 );

	} else {

		controls.target.copy( target );
		camera.position.setFromSphericalCoords( view === 'horizon' ? 110 : 58,
			THREE.MathUtils.degToRad( view === 'horizon' ? 82 : 50 ),
			THREE.MathUtils.degToRad( view === 'horizon' ? 125 : 318 ) ).add( target );

	}
	controls.update();

} );
cloudF.add( sky.clouds.coverage, 'value', 0, 1, 0.01 ).name( 'cloud cover override' ).onFinishChange( ( value: number ) => { cloudOverride = value; void refreshEnvironment(); } );
cloudF.add( skyQuality, 'value', [ 'low', 'medium', 'high' ] ).name( 'sky quality' ).onFinishChange( () => { applySkyQuality(); void refreshEnvironment(); } );
const weatherF = gui.addFolder( 'Weather' );
const weatherView = { preset: weather.target, seconds: 20 };
weatherF.add( weatherView, 'preset', Object.keys( WEATHER_PRESETS ) ).name( 'weather' ).onChange( ( name: WeatherName ) => { void setWeather( name, weatherView.seconds ); } );
weatherF.add( weatherView, 'seconds', 0, 120, 1 ).name( 'transition seconds' );
weatherF.add( weatherEffects, 'rain' ).name( 'rain & ripples' );
weatherF.add( weatherEffects, 'wetness' ).name( 'wet surfaces' );
const timeF = gui.addFolder( 'Time & moon' );
const timeView = { preset: requestedPreset ?? 'golden-hour' };
timeF.add( dayCycle, 'hour', 0, 24, 0.01 ).name( 'hour' ).listen().onFinishChange( refreshEnvironment );
timeF.add( dayCycle, 'dayLength', 30, 3600, 1 ).name( 'seconds per day' );
timeF.add( dayCycle, 'paused' ).name( 'pause clock' );
timeF.add( timeView, 'preset', Object.keys( DAY_PRESETS ) ).name( 'time preset' ).onChange( ( preset: DayPreset ) => { void setPreset( preset ); } );
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
waveF.add( fft.params, 'windSpeed', 1, 14, 0.1 ).onFinishChange( () => { W.wind.value = fft.params.windSpeed; rebuild(); } );
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
postF.add( S, 'exposure', 0.1, 5, 0.01 );
postF.add( S, 'saturation', 0, 2, 0.01 );
postF.add( S, 'vibrance', 0, 1, 0.01 );
postF.add( S, 'contrast', - 0.5, 1, 0.01 );
postF.add( S, 'split', 0, 1, 0.01 ).name( 'split tone' );
postF.addColor( S, 'lift' );
postF.add( S, 'bloomStrength', 0, 1.5, 0.01 );
postF.add( S, 'bloomThreshold', 0, 5, 0.01 );
postF.add( S, 'bloomMaxLum', 0.5, 50, 0.1 ).name( 'bloom clamp' );
postF.add( S, 'glowStrength', 0, 1, 0.01 ).name( 'glow' );
postF.add( S, 'glowThreshold', 0, 3, 0.01 ).name( 'glow threshold' );
postF.add( S, 'dof', 0, 1, 0.01 ).name( 'tilt-shift' );
postF.add( S, 'dofRange', 0, 20, 0.1 );
postF.add( S, 'dofMaxRadius', 0, 20, 0.1 );
postF.add( S, 'vignette', 0, 1, 0.01 );
postF.add( S, 'grain', 0, 0.05, 0.001 );

// ------------------------------------------------------------------ loop

function resize(): void {

	const w = innerWidth, h = innerHeight;
	renderer.setPixelRatio( renderPixelRatio( w, h ) );
	renderer.setSize( w, h );
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	const pr = renderer.getPixelRatio();
	pipeline.setSize( Math.floor( w * pr ), Math.floor( h * pr ) );

}

addEventListener( 'resize', resize );
resize();

const clock = new THREE.Timer();
clock.connect( document );
let frame = 0;
addEventListener( 'keydown', ( e ) => {

	if ( e.code === 'Space' ) { paused = ! paused; dayCycle.paused = paused; }
	if ( e.code === 'KeyH' ) gui.show( gui._hidden );

} );

const frameTimes: number[] = [];
let shadowElapsed = 0;
const shadowDirection = new THREE.Vector3();
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
	controls.update();

	renderer.info.reset();
	sky.advance( environmentDt );
	publishLighting();
	pipeline.air.haze.value = sky.weather.haze;
	wind.update( paused ? 0 : dt, sky.weather.windSpeed, sky.weather.windDirection );
	shared.rain.value = weatherEffects.rain ? sky.weather.rain : 0;
	shared.wetness.value = weatherEffects.wetness ? weather.state.wetness : 0;
	fft.weatherGain.value.copy( shared.wind.oceanGain.value );
	rain!.uniforms.rain.value = shared.rain.value;
	rain!.uniforms.wind.value.copy( shared.wind.velocity.value );
	rain!.uniforms.waterLevel.value = shared.waterLevel.value;
	rain!.update( camera, simTime );
	if ( ! manualSun && environmentLook.exposure ) {

		const state = sky.grade;
		S.exposure = state.exposure;
		S.lift.setRGB( state.blackLift, state.blackLift, state.blackLift * 0.97 );
		S.split = 0.16 + state.daylight * 0.29;

	}
	skyElapsed += environmentDt;
	const skyInterval = WEATHER_QUALITY[ skyQuality.value ].skyUpdateInterval;
	const ws = weather.state;
	const weatherSignature = `${ cloudOverride ?? ws.coverage },${ ws.density },${ ws.directVisibility },${ ws.ambientGain },${ ws.haze }`;
	if ( ! sky.busy && ! sky.transitioning && skyElapsed >= skyInterval &&
		( simTime !== lastSkyTime || weatherSignature !== lastWeatherSignature || ( ! manualSun && dayCycle.hour !== lastSkyHour ) ) ) {

		skyElapsed = 0;
		lastSkyTime = simTime;
		lastSkyHour = dayCycle.hour;
		prepareSkyState();
		void sky.update( skyInterval * 0.8 ).catch( ( error: unknown ) => console.error( error ) );

	}
	shadowElapsed += environmentDt;
	const shadowInterval = WEATHER_QUALITY[ skyQuality.value ].shadowUpdateInterval;
	if ( shadowElapsed >= shadowInterval && shadowDirection.distanceToSquared( sky.keyDir ) > 1e-10 ) {

		shadowElapsed = 0;
		shadowDirection.copy( sky.keyDir );
		invalidateSunShadow();

	}
	shared.time.value = simTime;
	fft.update( paused ? 0 : dt, simTime );
	shoreWaves.update( fft, simTime );
	// Whitewater is disabled in this scene; leave its history idle.
	caustics.update( sky.keyDir );
	if ( sun.shadow.needsUpdate ) refractedSun.update();
	characters.update( renderer, scene, sun, simTime, paused ? 0 : dt );
	S.focusDistance = camera.position.distanceTo( controls.target );

	pipeline.render( { scene, waterScene, rainScene: rain!.mesh.visible ? rainScene : undefined, camera, water: water!, sun, time: simTime } );
	frame ++;
	diagnostics();

}

function diagnostics(): void {

	if ( ! DEBUG || frame % 30 !== 1 ) return;
	const info = renderer.info;
	( window as unknown as Record<string, unknown> ).__THREE_GAME_DIAGNOSTICS__ = {
		frame,
		frameMs: + ( frameTimes.reduce( ( a, b ) => a + b, 0 ) / frameTimes.length ).toFixed( 2 ),
		frameMsP95: + [ ...frameTimes ].sort( ( a, b ) => a - b )[ Math.floor( frameTimes.length * 0.95 ) ].toFixed( 2 ),
		canvas: [ renderer.domElement.width, renderer.domElement.height ],
		calls: info.render.drawCalls,
		triangles: info.render.triangles,
		computeCalls: info.compute.frameCalls,
		geometries: info.memory.geometries,
		textures: info.memory.textures,
		dpr: renderer.getPixelRatio(),
		worldTriangles: world.triangles,
		rimStrands: data.rimStrands.length,
		timings: data.timings,
		backend: 'webgpu',
		hour: + dayCycle.hour.toFixed( 4 ),
		clockPaused: dayCycle.paused,
		skyBakeMs: + sky.lastBakeMs.toFixed( 2 ),
		skyBusy: sky.busy,
		skyTransitioning: sky.transitioning,
		quality: skyQuality.value,
		weather: weather.target,
		weatherProgress: + weather.progress.toFixed( 3 ),
		rain: + sky.weather.rain.toFixed( 3 ),
		wetness: + shared.wetness.value.toFixed( 3 ),
		windSpeed: + wind.speed.toFixed( 3 ),
	};

}

renderer.setAnimationLoop( tick );
loading?.classList.add( 'done' );
// setTime moves the (paused) clock, so captures can step through an animation in one page load
const setTime = ( t: number ) => {

	if ( ! Number.isFinite( t ) || t < 0 ) throw new RangeError( 'Scene time must be finite and non-negative' );
	simTime = t;
	wind.reset( { speed: sky.weather.windSpeed, heading: sky.weather.windDirection, time: t } );
	return refreshEnvironment();

};
if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__SOOMI__ = { renderer, scene, camera, controls, sky, sun, fft, shoreWaves, caustics, water, pipeline, shared, refractedSun, grass, foliage, flowers, rimFoliage, characters, soilUniforms, dayCycle, weather, weatherEffects, wind, rain, setWeather, applySun, refreshEnvironment, setHour, setPreset, invalidateSunShadow, setTime };
