import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import GUI from 'lil-gui';
import { Sky } from './sky/Sky.ts';
import { OceanFFT } from './ocean/OceanFFT.ts';
import { ShoreWaves } from './ocean/ShoreWaves.ts';
import { OceanFoam } from './ocean/OceanFoam.ts';
import { Caustics } from './ocean/Caustics.ts';
import { Water } from './ocean/Water.ts';
import { bakeProceduralTextures } from './materials/ProceduralTextures.ts';
import { generateWorld, buildWorldMeshes, shoreTextureFrom } from './world/World.ts';
import { buildGrass } from './world/Grass.ts';
import { buildFoliage } from './world/Foliage.ts';
import { buildFlowers } from './world/Flowers.ts';
import { buildIvy } from './world/Ivy.ts';
import { Pipeline } from './post/Pipeline.ts';
import { shared } from './shared.ts';

const params = new URLSearchParams( location.search );
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
renderer.setPixelRatio( Math.min( devicePixelRatio, DPR_CAP ) );
renderer.setSize( innerWidth, innerHeight );
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFShadowMap;
renderer.info.autoReset = false;
document.getElementById( 'app' )!.appendChild( renderer.domElement );

const scene = new THREE.Scene();
const waterScene = new THREE.Scene();

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
scene.add( sky.dome );
scene.environmentIntensity = 1;
const lighting = { skyFill: 1.5 };

const sun = new THREE.DirectionalLight( 0xffffff, 1 );
sun.castShadow = true;
sun.shadow.mapSize.set( 2048, 2048 );
const sc = sun.shadow.camera;
sc.left = - 36; sc.right = 36; sc.top = 36; sc.bottom = - 36; sc.near = 1; sc.far = 220;
sun.shadow.bias = - 0.0005;
sun.shadow.normalBias = 0.06;
sun.shadow.radius = 4;
scene.add( sun, sun.target );

function fresnel( cosI: number, eta: number ): number {

	const g = Math.sqrt( eta * eta - 1 + cosI * cosI );
	const a = ( g - cosI ) / ( g + cosI ), b = ( cosI * ( g + cosI ) - 1 ) / ( cosI * ( g - cosI ) + 1 );
	return 0.5 * a * a * ( b * b + 1 );

}

let sunUpdates = Promise.resolve();
let skyUpdating = false;
function applySun(): Promise<void> {

	// GUI changes can arrive during GPU readback. Serialise the entire bake and publication so
	// the key light, water uniforms and environment always belong to the same completed sky.
	// Recover the queue after reporting a failed update, allowing the next adjustment to retry.
	sunUpdates = sunUpdates.catch( ( error: unknown ) => console.error( error ) ).then( async () => {

		skyUpdating = true;
		try {

			await sky.update();
			sun.color.copy( sky.sunColor );
			sun.intensity = 1;
			sun.position.copy( sky.sunDir ).multiplyScalar( 120 ).add( sun.target.position );
			scene.environment = sky.envMap!.texture;
			shared.sunDir.value.copy( sky.sunDir );
			shared.sunColor.value.set( sky.sunColor.r, sky.sunColor.g, sky.sunColor.b );
			// sunlight entering the water: Fresnel transmission and the refracted elevation
			const cosI = Math.max( sky.sunDir.y, 0 );
			shared.sunIntoWater.value = sky.sunDir.y > 0 ? 1 - fresnel( cosI, 1.333 ) : 0;
			const eta = 1 / 1.333;
			shared.muSun.value = Math.sqrt( 1 - eta * eta * ( 1 - cosI * cosI ) );
			applySkyFill();

		} finally {

			skyUpdating = false;

		}

	} );
	return sunUpdates;

}

function applySkyFill(): void {

	// One artistic fill gain drives PBR ambient, water scattering and sky reflections alike.
	scene.environmentIntensity = lighting.skyFill;
	shared.skyIrradiance.value.set( sky.skyIrradiance.r, sky.skyIrradiance.g, sky.skyIrradiance.b ).multiplyScalar( lighting.skyFill );
	if ( water ) water.uniforms.reflection.value = lighting.skyFill;

}

let water: Water | undefined;

setStatus( 'Lighting the sky…' );
await applySun();

const textures = await bakeProceduralTextures( renderer );
const fft = new OceanFFT( renderer, { windSpeed: 4.4, windDirection: 40, fetch: 5000, amplitude: 0.68, choppiness: 0.5, spread: 0.52 } );
const caustics = new Caustics( renderer, fft );
const pipeline = new Pipeline( renderer );

// ------------------------------------------------------------------ world

setStatus( 'Generating the island…' );
const t0 = performance.now();
const data = await generateWorld();
const shore = shoreTextureFrom( data.shore );
shared.shoreXform.value.copy( shore.xform );
const shoreWaves = new ShoreWaves( renderer, data, shared, shore.tex, fft );
const foam = new OceanFoam( renderer, fft, shared, shore.tex, shoreWaves );
const world = buildWorldMeshes( data, textures, shared, caustics, shore.tex );
scene.add( world.group );
const grass = buildGrass( data.vegetation, shared );
const foliage = buildFoliage( data.vegetation, shared );
const flowers = buildFlowers( data.vegetation, shared );
const ivy = buildIvy( data.ivy, shared );
scene.add( grass, foliage, flowers, ivy );

water = new Water( {
	fft, sky, shared, shore: shore.tex, foam: textures.heights, foamState: foam.texture, shoreWaves,
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
const W = water.uniforms;
const sunF = gui.addFolder( 'Sun' );
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
waterF.add( W.foamAmount, 'value', 0, 2, 0.01 ).name( 'foam' );
waterF.add( W.glitter, 'value', 0, 20, 0.1 ).name( 'glitter' );
waterF.add( W.skyCap, 'value', 0.5, 10, 0.1 ).name( 'sky glare cap' );
waterF.add( W.detail, 'value', 0, 1.5, 0.01 ).name( 'ripple detail' );
waterF.add( W.sheen, 'value', 0, 1, 0.005 ).name( 'sun sheen' );
waterF.add( W.ssr, 'value', 0, 1, 1 ).name( 'SSR' );
const waveF = gui.addFolder( 'Waves' );
const rebuild = () => fft.rebuildSpectrum();
waveF.add( fft.params, 'windSpeed', 1, 14, 0.1 ).onFinishChange( () => { W.wind.value = fft.params.windSpeed; rebuild(); } );
waveF.add( fft.params, 'windDirection', - 180, 180, 1 ).onFinishChange( rebuild );
waveF.add( fft.params, 'amplitude', 0, 3, 0.01 ).onFinishChange( rebuild );
waveF.add( fft.params, 'choppiness', 0, 1.5, 0.01 ).onFinishChange( rebuild );
const postF = gui.addFolder( 'Post' );
postF.add( S, 'exposure', 0.1, 3, 0.01 );
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
let paused = params.has( 'paused' );
let simTime = Number( params.get( 't' ) ?? 0 );
addEventListener( 'keydown', ( e ) => {

	if ( e.code === 'Space' ) paused = ! paused;
	if ( e.code === 'KeyH' ) gui.show( gui._hidden );

} );

const frameTimes: number[] = [];
function tick(): void {

	clock.update();
	// Present the previous complete lighting state until the sky readback and IBL are ready.
	if ( skyUpdating ) return;
	const rawDt = clock.getDelta();
	frameTimes.push( rawDt * 1000 );
	if ( frameTimes.length > 120 ) frameTimes.shift();
	const dt = Math.min( rawDt, 1 / 20 );
	if ( ! paused ) simTime += dt;
	controls.update();

	renderer.info.reset();
	shared.time.value = simTime;
	fft.update( paused ? 0 : dt, simTime );
	shoreWaves.update( fft, simTime );
	foam.update( simTime );
	caustics.update( sky.sunDir );
	S.focusDistance = camera.position.distanceTo( controls.target );

	pipeline.render( { scene, waterScene, camera, water: water!, sun, time: simTime } );
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
		timings: data.timings,
		backend: 'webgpu',
	};

}

renderer.setAnimationLoop( tick );
loading?.classList.add( 'done' );
if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__SOOMI__ = { renderer, scene, camera, controls, sky, sun, fft, foam, shoreWaves, caustics, water, pipeline, shared, grass, foliage, flowers, ivy, applySun };
