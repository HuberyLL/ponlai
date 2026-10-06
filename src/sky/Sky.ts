/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, ivec2, float, sqrt, max, atan, asin, acos, clamp, cos, sin, mix, abs, select,
	pmremTexture, textureLoad, Loop, exp2,
} from 'three/tsl';
import { Atmosphere, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_DISPLAY_RADIUS, SUN_DISPLAY_SOLID_ANGLE, SUN_LIMB_EXPONENT } from '../lighting/Radiometry.ts';
import { Clouds, EVOLVE_PERIOD } from './Clouds.ts';
import { NightSky } from './NightSky.ts';
import { Lightning } from '../weather/Lightning.ts';
import type { DayCycleSnapshot } from './DayCycle.ts';
import type { WeatherFront, WeatherState } from './Weather.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type DisplayedWeather = Pick<WeatherState, 'haze' | 'rain' | 'fog' | 'windSpeed' | 'windDirection'>;

// Baked products. Directions, colours, the grade and the clouds themselves are evaluated every
// frame; only these slower reflection, environment and irradiance products cross-fade.
interface SkyEndpoint {
	equirect: THREE.RenderTarget;
	clouds: THREE.RenderTarget;
	environment: THREE.RenderTarget | null;
	irradianceMap: THREE.RenderTarget;
	version: number;
	irradiance: THREE.Color;
}

function makeEndpoint(): SkyEndpoint {

	const equirect = new THREE.RenderTarget( 512, 256, {
		type: THREE.HalfFloatType, generateMipmaps: true,
		minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
	} );
	equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
	equirect.texture.name = 'skyEquirect';
	// Upper hemisphere only: in-scattered cloud radiance (rgb) and transmittance (a), composed
	// over the live clear sky when displayed.
	const clouds = new THREE.RenderTarget( 512, 128, {
		type: THREE.HalfFloatType, depthBuffer: false,
		minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
	} );
	clouds.texture.name = 'skyCloudLayer';
	return {
		equirect,
		clouds,
		environment: null,
		irradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		version: 0,
		irradiance: new THREE.Color( 0, 0, 0 ),
	};

}

// The atmosphere is the single source of sky radiance and solar extinction. The visible sky
// includes the sun disk; the water panorama and PMREM omit it because direct lighting already
// reflects the sun. This follows tidewater's separation of view and reflection radiance.
export const dirToEquirect = Fn( ( [ d ]: [ V3 ] ) => {

	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), asin( clamp( d.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 ) );

} ).setLayout( { name: 'dirToEquirect', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const equirectToDir = Fn( ( [ q ]: [ V2 ] ) => {

	const phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar(), th = q.y.sub( 0.5 ).mul( Math.PI ).toVar();
	return vec3( cos( th ).mul( cos( phi ) ), sin( th ), cos( th ).mul( sin( phi ) ) );

} ).setLayout( { name: 'equirectToDir', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

// The displayed night sky's share of the night ambient that lights the island: a deeper sky
// for the stars without darkening the island's own fill.
const NIGHT_SKY = 0.55;

export class Sky {

	renderer: THREE.WebGPURenderer;
	atmosphere: Atmosphere;
	clouds: Clouds;
	night = new NightSky();
	lightning = new Lightning();
	sunIlluminance: number;
	elevation: number;
	azimuth: number;
	// A shared artistic solar tint affects both scattering and direct light.
	sunTint = new THREE.Color( 1.0, 0.97, 0.9 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	keyDir = new THREE.Vector3();
	keyColor = new THREE.Color();
	// The key light's colour before cloud and weather attenuation: what lights the cloud tops.
	keyColorAboveClouds = new THREE.Color();
	// Fraction of the key light that mirror-like glints reflect (see Shared.glintScale).
	glintScale = 1;
	// The viewer the cloud map is computed for; clouds are far, so only small moves matter.
	viewer = new THREE.Vector3( 0, 15, 0 );
	private viewCamera: THREE.PerspectiveCamera | null = null;
	private viewWidth = 1;
	private viewHeight = 1;
	private cloudTime = 0;
	solarIlluminance = new THREE.Color();
	readonly grade = { exposure: 2.35, blackLift: 0.027, daylight: 1 };
	readonly weather: DisplayedWeather = { haze: 0, rain: 0, fog: 0, windSpeed: 3.8, windDirection: 40 };
	skyIrradiance = new THREE.Color(); // E / PI over the upper hemisphere
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	readonly irradianceNode: V3;
	busy = false;

	private endpoints = [ makeEndpoint(), makeEndpoint() ];
	private front = 0;
	private destination = 0;
	private initialized = false;
	private celestial: DayCycleSnapshot | null = null;
	private weatherState: WeatherState | null = null;
	private pendingUpdate: Promise<void> | null = null;
	private transitionDuration = 0;
	private transitionElapsed = 0;
	private blend = uniform( 0 );
	private panoramaA: THREE.TextureNode;
	private panoramaB: THREE.TextureNode;
	private environmentA: THREE.TextureNode | null = null;
	private environmentB: THREE.TextureNode | null = null;
	private environment: V3 | null = null;
	private environmentBlendQuad: THREE.QuadMesh | null = null;
	private irradianceQuad: THREE.QuadMesh;
	private irradianceBlendQuad: THREE.QuadMesh;
	private irradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private irradianceA: THREE.TextureNode;
	private irradianceB: THREE.TextureNode;
	private bakeVersion = 0;
	private explicitVersion = 0;
	private diagnosticVersion = 0;
	private diagnosticPending = false;
	private lastDiagnosticMs = - Infinity;
	private liveDiagnostics = false;
	private displaySunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	private displaySolarIlluminance = uniform( new THREE.Color( 0, 0, 0 ) );
	// Live clear-sky terms for the dome; the bake keeps its own copies below.
	private displayNightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	private displayOvercast = uniform( 0 );
	private displayAmbientGain = uniform( 1 );
	private cloudLayer: THREE.TextureNode;
	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private reflectionSource: THREE.RenderTarget;
	private upperQuad: THREE.QuadMesh;
	private sea = uniform( new THREE.Color() );
	private nightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	private ambientGain = uniform( 1 );
	private overcast = uniform( 0 );
	private irradiancePass = uniform( 0 );
	private includeStars = uniform( 0 );
	private bakeStarVisibility = uniform( 0 );
	private starFootprint = uniform( 1 );

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = SUN_ILLUMINANCE, elevation = 32, azimuth = - 8 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.atmosphere = new Atmosphere( renderer );
		this.equirect = this.endpoints[ 0 ].equirect;
		this.clouds = new Clouds( this.atmosphere );
		this.cloudLayer = texture( this.endpoints[ 0 ].clouds.texture );
		// Only the environment source contains filtered stars. The displayed panoramas stay
		// star-free so the dome and water can evaluate sharp/rough stars without double counting.
		this.reflectionSource = this.equirect.clone();
		this.reflectionSource.texture.name = 'skyStarlitEnvironment';
		this.panoramaA = texture( this.equirect.texture );
		this.panoramaB = texture( this.equirect.texture );
		this.small = new THREE.RenderTarget( 64, 32, { type: THREE.FloatType, depthBuffer: false } );
		this.irradianceA = texture( this.endpoints[ 0 ].irradianceMap.texture );
		this.irradianceB = texture( this.endpoints[ 1 ].irradianceMap.texture );
		const irradianceBlendMat = new THREE.NodeMaterial();
		irradianceBlendMat.depthTest = false;
		irradianceBlendMat.depthWrite = false;
		irradianceBlendMat.toneMapped = false;
		irradianceBlendMat.fragmentNode = mix( textureLoad( this.irradianceA, ivec2( 0 ) ),
			textureLoad( this.irradianceB, ivec2( 0 ) ), this.blend );
		this.irradianceBlendQuad = new THREE.QuadMesh( irradianceBlendMat );
		this.irradianceNode = textureLoad( texture( this.irradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		const irradianceMat = new THREE.NodeMaterial();
		irradianceMat.depthTest = false;
		irradianceMat.depthWrite = false;
		irradianceMat.toneMapped = false;
		const smallTexture = texture( this.small.texture );
		irradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			// The panorama stores sin(latitude) in alpha. Integrate the same cosine-weighted
			// upper hemisphere as the CPU probe, without an orientation-dependent row shortcut.
			Loop( this.small.width * this.small.height, ( { i } ) => {

				const pixel = textureLoad( smallTexture, ivec2( i.mod( this.small.width ), i.div( this.small.width ) ) ).toVar();
				const mu = max( pixel.a, 0 ).toVar();
				const weight = mu.mul( sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) ) ).mul( 2 * Math.PI / ( this.small.width * this.small.height ) );
				sum.addAssign( pixel.rgb.mul( weight ) );

			} );
			return vec4( sum, 1 );

		} )();
		this.irradianceQuad = new THREE.QuadMesh( irradianceMat );
		this.pmrem = new THREE.PMREMGenerator( renderer );

		// The finite wave grid ends before the geometric horizon. Continue it with the reflection
		// of a flat distant sea, approaching unit Fresnel at the horizon without a dark colour step.
		const seaPanorama = Fn( ( [ d, clearSky, sea ]: [ V3, V3, V3 ] ) => {

			const c = clamp( abs( d.y ), 0, 1 ).toVar();
			const g = sqrt( c.mul( c ).add( 1.333 * 1.333 - 1 ) ).toVar();
			const a = g.sub( c ).div( g.add( c ) );
			const b = c.mul( g.add( c ) ).sub( 1 ).div( c.mul( g.sub( c ) ).add( 1 ) );
			const fr = a.mul( a ).mul( b.mul( b ).add( 1 ) ).mul( 0.5 );
			return mix( sea, clearSky, select( d.y.greaterThanEqual( 0 ), 1, fr ) );

		} ).setLayout( { name: 'skySeaPanorama', type: 'vec3', inputs: [
			{ name: 'd', type: 'vec3' }, { name: 'clearSky', type: 'vec3' }, { name: 'sea', type: 'vec3' },
		] } );
		const upperMat = new THREE.NodeMaterial();
		// The reflection panorama's cloud layer: the live cloud map averaged over each of its
		// coarser texels. The lower panorama is the distant sea reflection, and the irradiance
		// probe reuses the same samples.
		upperMat.fragmentNode = Fn( () => {

			const texel = vec2( 1 / 512, 1 / 128 );
			const sum = vec4( 0 ).toVar();
			for ( const [ x, y ] of [ [ - 0.3, - 0.3 ], [ 0.3, - 0.3 ], [ - 0.3, 0.3 ], [ 0.3, 0.3 ] ] ) {

				const q = uv().add( texel.mul( vec2( x, y ) ) );
				sum.addAssign( this.clouds.sample( equirectToDir( vec2( q.x, clamp( q.y, 0, 1 ).mul( 0.5 ).add( 0.5 ) ) ) ) );

			}
			return sum.mul( 0.25 );

		} )();
		this.upperQuad = new THREE.QuadMesh( upperMat );

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = Fn( () => {

			const q = uv();
			const d = equirectToDir( q ).toVar();
			const cloud = this.cloudLayer.sample( vec2( q.x, abs( q.y.sub( 0.5 ) ).mul( 2 ) ) ).level( float( 0 ) ).toVar();
			const up = vec3( d.x, abs( d.y ), d.z );
			// The visible night sky is darker than the light it lends the island (see NIGHT_SKY).
			const night = this.nightAmbient.rgb.mul( mix( float( NIGHT_SKY ), float( 1 ), this.irradiancePass ) );
			const sky = this.clearSky( up, night, this.overcast ).mul( cloud.a ).add( cloud.rgb ).mul( this.ambientGain )
				.add( this.night.airglow( up, this.bakeStarVisibility ).mul( cloud.a ) );
			const stars = this.night.stars( up, this.starFootprint, this.bakeStarVisibility.mul( this.includeStars ) );
			const radiance = seaPanorama( d, sky.add( stars.mul( cloud.a ) ), this.sea.rgb );
			return vec4( radiance, mix( cloud.a, d.y, this.irradiancePass ) );

		} )();
		this.quad = new THREE.QuadMesh( bake );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const r = acos( clamp( dot( d, this.displaySunDir ), - 1, 1 ) ).div( SUN_DISPLAY_RADIUS ).toVar();
			const mask = float( 1 ).sub( smoothstep( 0.9, 1.0, r ) );
			// Limb darkening per channel (see SUN_LIMB_EXPONENT): a redder, darker rim.
			const mu = max( float( 1 ).sub( r.mul( r ) ), 1e-6 ).log2().mul( 0.5 ).toVar();
			const limb = vec3( mu.mul( SUN_LIMB_EXPONENT[ 0 ] ), mu.mul( SUN_LIMB_EXPONENT[ 1 ] ), mu.mul( SUN_LIMB_EXPONENT[ 2 ] ) ).exp2();
			// The integral of the visible disk is the key light's irradiance, channel by channel. A
			// shared scene unit scale keeps the normalised disk finite in fp16 without dimming it.
			const disk = this.atmosphere.transmittanceToSpace( d ).mul( this.displaySolarIlluminance )
				.mul( mask ).mul( limb ).div( vec3( ...SUN_DISPLAY_SOLID_ANGLE ) ).mul( smoothstep( 0, 0.001, d.y ) );
			// Above the horizon the clear sky and the clouds are both live. Below, the baked distant-sea reflection continues the waves.
			const lower = this.samplePanorama( d, float( 0 ) ).toVar();
			const cloud = this.clouds.sampleView( d ).toVar();
			const upper = this.clearSky( vec3( d.x, max( d.y, 0 ), d.z ), this.displayNightAmbient.rgb.mul( NIGHT_SKY ), this.displayOvercast )
				.mul( cloud.a ).add( cloud.rgb ).mul( this.displayAmbientGain );
			const above = d.y.greaterThanEqual( 0 );
			const background = select( above, upper, lower.rgb );
			const through = select( above, cloud.a, lower.a );
			// Thin cloud turns most of the direct beam into the glow around it; the bare disk fades
			// faster than its surroundings, and a thick deck hides it entirely instead of letting
			// its enormous radiance burn through a residual transmittance as a sharp point.
			const stars = this.night.stars( d ).mul( this.night.moonOcclusion( d ) );
			const airglow = this.night.airglow( d ).mul( select( above, float( 1 ), float( 0 ) ) );
			return vec4( background.add( disk.mul( through ).mul( smoothstep( 0.03, 0.35, through ) ).add( this.night.moon( d ) ).add( stars ).add( airglow ).mul( through ) ), 1 );

		} )();
		this.dome = new THREE.Mesh( new THREE.SphereGeometry( 1000, 32, 16 ), domeMat );
		this.dome.frustumCulled = false;
		// Render behind the completed opaque depth so covered pixels skip the sky shader.
		this.dome.renderOrder = 1000;
		this.dome.onBeforeRender = ( _renderer, _scene, camera ) => {

			// Translation must not change the angular position of the sun or the horizon.
			this.dome.position.copy( camera.position );
			this.dome.updateMatrixWorld();

		};

	}

	get transitioning(): boolean { return this.transitionDuration > 0 && this.transitionElapsed < this.transitionDuration; }
	get moonDir(): THREE.Vector3 { return this.night.moonDir.value; }

	get environmentNode(): V3 {

		if ( ! this.environment ) throw new Error( 'The sky environment is available after the initial update' );
		return this.environment;

	}

	setCelestial( snapshot: DayCycleSnapshot | null ): void {

		// The caller may keep advancing its clock while GPU readback is pending. Each bake
		// owns its requested directions and scalars, never a mutable controller snapshot.
		this.celestial = snapshot ? { ...snapshot, sunDir: snapshot.sunDir.clone(), moonDir: snapshot.moonDir.clone(), keyDir: snapshot.keyDir.clone() } : null;

	}

	setWeather( snapshot: WeatherState | null ): void {

		this.weatherState = snapshot ? { ...snapshot } : null;

	}

	setQuality( quality: 'low' | 'medium' | 'high' ): void {

		const samples = { low: 40, medium: 56, high: 72 }[ quality ];
		if ( samples === undefined ) throw new RangeError( `Unknown sky quality: ${ quality }` );
		// Fixed targets keep sampler dimensions and both PMREM endpoints compatible while
		// quality changes. Cloud march steps and the caller's bake cadence set the GPU budget.
		this.clouds.quality.value = samples;
		this.clouds.invalidate();

	}

	update( transitionSeconds = 0 ): Promise<void> {

		if ( ! Number.isFinite( transitionSeconds ) || transitionSeconds < 0 ) return Promise.reject( new RangeError( 'Sky transition duration must be finite and nonnegative' ) );
		if ( this.pendingUpdate ) return this.pendingUpdate;
		if ( this.transitioning ) {

			if ( transitionSeconds > 0 ) return Promise.resolve();
			this.advance( this.transitionDuration );

		}
		this.busy = true;
		this.pendingUpdate = this.bake( transitionSeconds ).finally( () => {

			this.busy = false;
			this.pendingUpdate = null;

		} );
		return this.pendingUpdate;

	}

	/** Evaluate the sun, moon, key light, stars, grade and displayed weather for this frame.
	 * Everything that moves with the clock is continuous here; bakes only capture this state. */
	track( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverageOverride: number | null = null, front: WeatherFront | null = null ): void {

		if ( celestial ) {

			this.sunDir.copy( celestial.sunDir );
			this.elevation = celestial.elevation;
			this.azimuth = celestial.azimuth;

		} else {

			const el = THREE.MathUtils.degToRad( this.elevation ), az = THREE.MathUtils.degToRad( this.azimuth );
			this.sunDir.set( Math.cos( el ) * Math.cos( az ), Math.sin( el ), Math.cos( el ) * Math.sin( az ) ).normalize();

		}
		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		this.solarIlluminance.copy( this.sunTint ).multiplyScalar( illuminance );
		// The sky-view LUT re-renders only when the sun has moved: a small 192 x 108 march.
		this.atmosphere.sunDir.value.copy( this.sunDir );
		this.atmosphere.sunIlluminance.value.copy( this.solarIlluminance );
		this.atmosphere.updateSync();
		this.sunColor.copy( this.atmosphere.transmittanceToSun() ).multiply( this.solarIlluminance );
		this.keyDir.copy( celestial?.keyDir ?? this.sunDir );
		this.keyColor.copy( this.sunColor );
		const moonColor = this.night.moonColor.value;
		if ( celestial ) {

			// A modest art-directed moon remains orders darker than daylight on the island.
			this.keyColor.r += 0.65 * illuminance * 0.04 * celestial.moonKeyGain;
			this.keyColor.g += 0.76 * illuminance * 0.04 * celestial.moonKeyGain;
			this.keyColor.b += illuminance * 0.04 * celestial.moonKeyGain;
			this.night.moonDir.value.copy( celestial.moonDir );
			this.night.frame.value.copy( celestial.starFrame );
			this.night.moonWash.value = celestial.moonVisibility * celestial.moonIllumination;
			// The disk sits in the upper tones at night exposure so its maria stay visible, as to the
			// eye; the moonlight on the island is the key light above, not this disk.
			moonColor.setRGB( 0.04, 0.041, 0.043 ).multiplyScalar( 0.32 * celestial.moonVisibility * this.sunIlluminance / SUN_ILLUMINANCE );
			this.night.starVisibility.value = celestial.nightVisibility * ( 1 - 0.22 * celestial.moonVisibility * celestial.moonIllumination );
			this.displayNightAmbient.value.setRGB( 0.001, 0.001625, 0.003125 ).multiplyScalar( illuminance * celestial.nightVisibility );
			this.grade.exposure = celestial.exposure;
			this.grade.blackLift = celestial.blackLift;
			this.grade.daylight = celestial.daylight;

		} else {

			this.night.moonDir.value.copy( this.sunDir ).negate();
			moonColor.setRGB( 0, 0, 0 );
			this.night.starVisibility.value = 0;
			this.displayNightAmbient.value.setRGB( 0, 0, 0 );
			this.grade.exposure = 2.35;
			this.grade.blackLift = 0.027;
			this.grade.daylight = 1;

		}
		this.keyColorAboveClouds.copy( this.keyColor );
		const sunLuma = this.sunColor.r * 0.2126 + this.sunColor.g * 0.7152 + this.sunColor.b * 0.0722;
		const keyLuma = this.keyColor.r * 0.2126 + this.keyColor.g * 0.7152 + this.keyColor.b * 0.0722;
		this.glintScale = keyLuma > 0 ? ( sunLuma + ( keyLuma - sunLuma ) * 0.06 ) / keyLuma : 1;
		const coverage = coverageOverride ?? weather?.coverage ?? 0;
		const overcast = weather ? THREE.MathUtils.smoothstep( coverage, 0.65, 0.98 ) : 0;
		const ambientGain = weather?.ambientGain ?? 1;
		const directVisibility = weather?.directVisibility ?? 1;
		// Preserve contrast under flat daytime light without lifting the night floor.
		this.grade.blackLift *= 1 - 0.48 * overcast * this.grade.daylight;
		// Like a camera, adapt a little to the dimmer diffuse daylight under a closed deck, less
		// so in rain, which should read as heavy.
		this.grade.exposure *= 1 + 0.5 * overcast * this.grade.daylight * ( 1 - 0.7 * ( weather?.rain ?? 0 ) );
		// After dark a closed deck hides the moon and stars; the eye adapts further so a rainy
		// dusk or night stays readable, still darker than a clear moonlit night.
		this.grade.exposure *= 1 + 5 * overcast * ( 1 - this.grade.daylight );
		this.sunColor.multiplyScalar( directVisibility );
		this.keyColor.multiplyScalar( directVisibility );
		this.solarIlluminance.multiplyScalar( directVisibility );
		moonColor.multiplyScalar( directVisibility );
		this.night.starVisibility.value *= ambientGain;
		this.night.sunDir.value.copy( this.sunDir );
		this.displaySunDir.value.copy( this.sunDir );
		this.displaySolarIlluminance.value.copy( this.solarIlluminance );
		this.displayOvercast.value = overcast;
		this.displayAmbientGain.value = ambientGain;
		this.trackClouds( celestial, weather, coverage, illuminance, coverageOverride === null ? front : null );
		this.clouds.cirrus.value = weather?.cirrus ?? 0;
		// A rainbow needs falling rain and direct sun at once, the sun lower than 42 degrees behind
		// the viewer: most often as a shower clears, while it is still raining a few kilometres off.
		// The clouds draw it in their sunlit rain curtains.
		const showers = weather?.showers ?? 0, sunlit = weather?.directVisibility ?? 1;
		this.clouds.showers.value = showers;
		// Drops fall at about 9 m/s and drift with the wind, slower near the sea than aloft; a gale
		// slants them steeply.
		this.clouds.rainSlant.value = Math.min( ( weather?.windSpeed ?? 3.8 ) / 11, 1 );
		// A fog's cover is mist and stratus, not rain cells: its broken sky does not shower.
		this.clouds.heapShowers.value = 1 - THREE.MathUtils.smoothstep( weather?.fog ?? 0, 0.3, 0.8 );
		this.clouds.rainbow.value = THREE.MathUtils.smoothstep( showers, 0.04, 0.3 ) * THREE.MathUtils.smoothstep( sunlit, 0.3, 0.7 )
			* THREE.MathUtils.smoothstep( this.sunDir.y, 0, 0.08 ) * ( 1 - THREE.MathUtils.smoothstep( this.sunDir.y, 0.6, 0.72 ) );
		this.weather.haze = weather?.haze ?? 0;
		this.weather.rain = weather?.rain ?? 0;
		// Morning mist: calm, dry air cools overnight; mist gathers before dawn and burns off
		// a few hours after sunrise. Weather fog adds to it.
		const hour = celestial?.hour ?? 12, wind = weather?.windSpeed ?? 3.8;
		const mist = THREE.MathUtils.smoothstep( hour, 3.5, 5.5 ) * ( 1 - THREE.MathUtils.smoothstep( hour, 7.5, 9.5 ) )
			* ( 1 - THREE.MathUtils.smoothstep( wind, 3.5, 5 ) ) * ( 1 - this.weather.rain ) * 0.3;
		this.weather.fog = Math.max( weather?.fog ?? 0, mist );
		this.weather.windSpeed = weather?.windSpeed ?? 3.8;
		this.weather.windDirection = weather?.windDirection ?? 40;

	}

	private trackClouds( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverage: number, illuminance: number, front: WeatherFront | null ): void {

		const clouds = this.clouds;
		clouds.coverage.value = coverage;
		clouds.density.value = weather?.density ?? 1;
		clouds.coverageFrom.value = front ? front.from.coverage : coverage;
		clouds.coverageTo.value = front ? front.to.coverage : coverage;
		clouds.densityFrom.value = front ? front.from.density : clouds.density.value;
		clouds.densityTo.value = front ? front.to.density : clouds.density.value;
		clouds.frontProgress.value = front ? front.progress : 1;
		clouds.rainFrom.value = front ? front.from.rain : weather?.rain ?? 0;
		clouds.rainTo.value = front ? front.to.rain : weather?.rain ?? 0;
		// Cloud tops a couple of kilometres up keep the sun a little after it has set below.
		const sunAbove = this.atmosphere.transmittanceAt( this.sunDir, 2 ).multiply( this.sunTint ).multiplyScalar( illuminance );
		const moonGain = celestial?.moonKeyGain ?? 0;
		const sunUp = ! celestial || celestial.elevation > - 2.5;
		clouds.lightDir.value.copy( sunUp ? this.sunDir : this.keyDir );
		clouds.lightColor.value.copy( sunUp ? sunAbove : new THREE.Color( 0, 0, 0 ) );
		clouds.lightColor.value.r += 0.65 * illuminance * 0.04 * moonGain;
		clouds.lightColor.value.g += 0.76 * illuminance * 0.04 * moonGain;
		clouds.lightColor.value.b += illuminance * 0.04 * moonGain;
		clouds.nightAmbient.value.copy( this.displayNightAmbient.value );
		// Low sun: lift the reddened beam, and the cool violet fill on the shaded sides with it.
		const lowSun = THREE.MathUtils.smoothstep( this.elevation, - 4, 1 ) * ( 1 - THREE.MathUtils.smoothstep( this.elevation, 6, 20 ) );
		clouds.directGain.value = 1 + 0.7 * lowSun;
		clouds.ambientGain.value = 1 + 0.35 * lowSun;
		// The sea's albedo returns a little sun and sky light to the cloud bases.
		const L = clouds.lightDir.value;
		clouds.seaBounce.value.copy( clouds.lightColor.value ).multiplyScalar( Math.max( L.y, 0 ) * 0.06 / Math.PI );

	}

	/** Advance the cloud field for this frame: wind, slow evolution and the view from `camera`,
	 * whose drawing buffer is `width` by `height` pixels. */
	updateClouds( camera: THREE.PerspectiveCamera, width: number, height: number, windOffset: THREE.Vector2, windDirection: THREE.Vector2, time: number ): void {

		if ( ! this.clouds.ready ) return;
		this.viewCamera = camera;
		this.viewWidth = width;
		this.viewHeight = height;
		this.cloudTime = time;
		this.clouds.setWindOffset( windOffset );
		// Weather arrives from upwind.
		this.clouds.frontAxis.value.copy( windDirection ).negate().normalize();
		this.clouds.cirrusAxis.value.copy( windDirection ).normalize();
		// The shape of the clouds evolves at about two thirds of the trade wind's drift.
		this.clouds.evolve.value = ( time * 2.5 ) % EVOLVE_PERIOD;
		this.night.time.value = time;
		this.viewer.copy( camera.position );
		this.clouds.update( this.renderer, camera, width, height, time );

	}

	private async bake( transitionSeconds: number ): Promise<void> {

		const started = performance.now();
		const version = ++ this.bakeVersion;
		const readback = transitionSeconds === 0 || ! this.initialized;
		if ( readback ) this.explicitVersion = version;
		const celestial = this.celestial;
		const weather = this.weatherState ? { ...this.weatherState } : null;
		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		await this.renderer.init();
		if ( ! this.clouds.ready ) await this.clouds.init( this.renderer );
		await this.night.load();
		if ( ! this.night.ready ) await this.night.init();
		// An explicit jump (preset, seek, weather change) refreshes the whole cloud map now.
		if ( readback ) {

			this.clouds.invalidate();
			this.clouds.update( this.renderer, this.viewCamera, this.viewWidth, this.viewHeight, this.cloudTime );

		}
		const next = this.initialized ? 1 - this.front : 0;
		const state = this.endpoints[ next ];
		state.version = version;
		const ambientGain = weather?.ambientGain ?? 1;
		const overcast = weather ? THREE.MathUtils.smoothstep( weather.coverage, 0.65, 0.98 ) : 0;
		this.ambientGain.value = ambientGain;
		this.overcast.value = overcast;
		// The bake captures the live state from track(): the atmosphere LUT, key light, clouds
		// and stars already describe this frame's sun and moon.
		this.nightAmbient.value.copy( this.displayNightAmbient.value );
		const daylight = celestial ? celestial.daylight : 1;
		this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance * daylight )
			.add( this.nightAmbient.value.clone().multiplyScalar( 0.22 ) ).multiplyScalar( ambientGain );
		this.bakeStarVisibility.value = this.night.starVisibility.value;
		const r = this.renderer, prev = r.getRenderTarget();
		try {

			r.setRenderTarget( state.clouds );
			this.upperQuad.render( r );
			this.cloudLayer.value = state.clouds.texture;
			// Both samplers must have distinct textures at the first material compilation:
			// Three deduplicates texture uniforms by UUID, even for separate TextureNodes.
			const panoramas = this.initialized ? [ state.equirect, this.reflectionSource, this.small ] :
				[ state.equirect, this.endpoints[ 1 ].equirect, this.reflectionSource, this.small ];
			for ( const rt of panoramas ) {

				this.irradiancePass.value = rt === this.small ? 1 : 0;
				this.includeStars.value = rt === this.small || rt === this.reflectionSource ? 1 : 0;
				this.starFootprint.value = Math.SQRT2 * Math.PI / rt.height;
				r.setRenderTarget( rt );
				this.quad.render( r );

			}
			for ( const irradiance of this.initialized ? [ state.irradianceMap ] : [ state.irradianceMap, this.endpoints[ 1 ].irradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.irradianceQuad.render( r );

			}

		} finally {

			r.setRenderTarget( prev );

		}

		if ( readback ) {

			const W = this.small.width, H = this.small.height;
			const px = await r.readRenderTargetPixelsAsync( this.small, 0, 0, W, H ) as Float32Array;
			const E = [ 0, 0, 0 ];
			const dOmegaLon = 2 * Math.PI / W, dTh = Math.PI / H;
			for ( let k = 0; k < W * H; k ++ ) {

				const sinTh = px[ k * 4 + 3 ];
				if ( sinTh <= 0 ) continue;
				const dOmega = dOmegaLon * dTh * Math.sqrt( Math.max( 0, 1 - sinTh * sinTh ) );
				for ( let c = 0; c < 3; c ++ ) E[ c ] += px[ k * 4 + c ] * sinTh * dOmega;

			}
			state.irradiance.setRGB( E[ 0 ] / Math.PI, E[ 1 ] / Math.PI, E[ 2 ] / Math.PI );

		}
		state.environment = this.pmrem.fromEquirectangular( this.reflectionSource.texture, state.environment ?? undefined );
		if ( ! this.initialized ) {

			this.front = next;
			const spare = this.endpoints[ 1 ];
			spare.environment = this.pmrem.fromEquirectangular( this.reflectionSource.texture );

		}
		const previous = this.endpoints[ this.front ];
		const displayedNext = this.initialized ? state : this.endpoints[ 1 ];
		if ( ! this.initialized ) {

			// Both endpoints start from this bake's cloud layer.
			r.setRenderTarget( this.endpoints[ 1 ].clouds );
			this.upperQuad.render( r );
			r.setRenderTarget( prev );

		}
		this.panoramaA.value = previous.equirect.texture;
		this.panoramaB.value = displayedNext.equirect.texture;
		this.irradianceA.value = previous.irradianceMap.texture;
		this.irradianceB.value = displayedNext.irradianceMap.texture;
		if ( ! this.environmentA || ! this.environmentB ) {

			this.environmentA = texture( previous.environment!.texture );
			this.environmentB = texture( displayedNext.environment!.texture );
			this.envMap = state.environment.clone();
			this.envMap.texture.mapping = THREE.CubeUVReflectionMapping;
			( this.envMap.texture as THREE.Texture & { isPMREMTexture: boolean } ).isPMREMTexture = true;
			this.envMap.texture.name = 'skyDisplayedPMREM';
			this.envMap.scissorTest = false;
			const blendMat = new THREE.NodeMaterial();
			blendMat.depthTest = false;
			blendMat.depthWrite = false;
			blendMat.toneMapped = false;
			// Convolution is linear. Blending the already filtered atlases once keeps terrain
			// within WebGPU's portable 16-texture limit instead of doubling every IBL sample.
			blendMat.fragmentNode = mix( this.environmentA.sample( uv() ).level( float( 0 ) ),
				this.environmentB.sample( uv() ).level( float( 0 ) ), this.blend );
			this.environmentBlendQuad = new THREE.QuadMesh( blendMat );
			this.environment = pmremTexture( this.envMap.texture );

		} else {

			this.environmentA.value = previous.environment!.texture;
			this.environmentB.value = state.environment.texture;

		}
		this.destination = next;
		this.transitionElapsed = 0;
		this.transitionDuration = this.initialized ? transitionSeconds : 0;
		this.blend.value = ! this.initialized || this.transitionDuration > 0 ? 0 : 1;
		this.equirect = state.equirect;
		this.initialized = true;
		this.liveDiagnostics = ! readback;
		this.publish( this.blend.value );
		if ( this.transitionDuration === 0 ) this.front = this.destination;
		this.lastBakeMs = performance.now() - started;
		if ( ! readback ) this.refreshDiagnosticIrradiance( state, version );

	}

	advance( dt: number ): void {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'Sky dt must be finite and nonnegative' );
		if ( ! this.transitioning ) return;
		this.transitionElapsed = Math.min( this.transitionElapsed + dt, this.transitionDuration );
		// Linear: back-to-back bakes then change at a constant rate, never easing to a halt.
		this.blend.value = this.transitionElapsed / this.transitionDuration;
		this.publish( this.blend.value );
		if ( ! this.transitioning ) this.front = this.destination;

	}

	private publish( amount: number ): void {

		const a = this.endpoints[ this.front ], b = this.endpoints[ this.destination ];
		// During a running cycle this CPU value is diagnostic only. Water and characters use
		// irradianceNode, which blends the exact GPU integrals on the same frame as the sky.
		if ( ! this.liveDiagnostics ) this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, amount );
		this.renderDisplayMaps();

	}

	private clearSky( direction: V3, nightAmbient: V3, overcast: F ): V3 {

		// Night air glows a little toward the horizon and deepens toward the zenith; the cosine-
		// weighted mean stays near one so the night's ambient light on the island is unchanged.
		const airglow = mix( float( 2.85 ), float( 0.5 ), sqrt( clamp( direction.y, 0, 1 ) ) );
		const clear = this.atmosphere.skyRadiance( direction ).add( nightAmbient.mul( airglow ) ).toVar();
		// Clouds mute the existing sky's colour; they never introduce a white/grey
		// radiance floor that would glow at night or bleach the transparent sea.
		return mix( clear, vec3( dot( clear, vec3( 0.2126, 0.7152, 0.0722 ) ) ), overcast.mul( 0.35 ) );

	}

	private renderDisplayMaps(): void {

		if ( ! this.environmentBlendQuad || ! this.envMap ) return;
		const r = this.renderer, previous = r.getRenderTarget();
		try {

			r.setRenderTarget( this.envMap );
			this.environmentBlendQuad.render( r );
			r.setRenderTarget( this.irradianceDisplay );
			this.irradianceBlendQuad.render( r );

		} finally {

			r.setRenderTarget( previous );

		}

	}

	private refreshDiagnosticIrradiance( state: SkyEndpoint, version: number ): void {

		const now = performance.now();
		if ( this.diagnosticPending || now - this.lastDiagnosticMs < 2000 ) return;
		this.diagnosticPending = true;
		this.lastDiagnosticMs = now;
		void this.renderer.readRenderTargetPixelsAsync( state.irradianceMap, 0, 0, 1, 1 ).then( ( pixels ) => {

			const p = pixels as Float32Array;
			// A late readback must not overwrite an explicit preset or a reused endpoint.
			if ( state.version === version ) state.irradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
			if ( this.liveDiagnostics && version >= this.explicitVersion && version > this.diagnosticVersion ) {

				this.skyIrradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
				this.diagnosticVersion = version;

			}

		} ).catch( ( error: unknown ) => console.error( error ) ).finally( () => { this.diagnosticPending = false; } );

	}

	private samplePanorama( direction: V3, mip: F ): V4 {

		const q = dirToEquirect( direction );
		return mix( this.panoramaA.sample( q ).level( mip ), this.panoramaB.sample( q ).level( mip ), this.blend );

	}

	sample( direction: V3, mip: F = float( 0 ) ): V3 {

		const background = this.samplePanorama( direction, mip ).toVar();
		// The ocean already converts its unresolved slope variance to this angular mip.
		// Apply that same footprint to celestial points, keeping their locations fixed while
		// spreading/dimming their finite energy rather than adding screen-space sparkles.
		const footprint = exp2( mip ).mul( Math.SQRT2 * Math.PI / this.equirect.height );
		// Lightning inside the clouds is live, never baked: a flash lasts a fraction of a second.
		return background.rgb.add( this.night.stars( direction, footprint ).mul( background.a ) ).add( this.clouds.flashAt( direction, float( 1 ).sub( background.a ) ) );

	}

	sampleBackground( direction: V3, mip: F = float( 0 ) ): V3 {

		return this.samplePanorama( direction, mip ).rgb;

	}

	cloudVisibility( worldPosition: V3 ): F {

		return this.clouds.shadow( worldPosition );

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		( this.upperQuad.material as THREE.Material ).dispose();
		this.reflectionSource.dispose();
		this.small.dispose();
		this.clouds.dispose();
		this.envMap?.dispose();
		this.irradianceDisplay.dispose();
		( this.environmentBlendQuad?.material as THREE.Material | undefined )?.dispose();
		( this.irradianceQuad.material as THREE.Material ).dispose();
		( this.irradianceBlendQuad.material as THREE.Material ).dispose();
		for ( const endpoint of this.endpoints ) {

			endpoint.equirect.dispose();
			endpoint.clouds.dispose();
			endpoint.irradianceMap.dispose();
			endpoint.environment?.dispose();

		}
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
