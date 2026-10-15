/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, ivec2, float, sqrt, max, atan, asin, acos, clamp, cos, sin, mix, abs, select,
	pmremTexture, textureLoad, Loop, exp2, positionView,
} from 'three/tsl';
import { Atmosphere, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_DISPLAY_RADIUS, SUN_DISPLAY_SOLID_ANGLE } from '../lighting/Radiometry.ts';
import { Clouds, EVOLVE_PERIOD, type CloudViewScale } from './Clouds.ts';
import { NightSky } from './NightSky.ts';
import { Lightning } from '../weather/Lightning.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { shared } from '../shared.ts';
import { compileInto } from '../post/graph/Compile.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';
import { MOTION_CLASS, velocityOutput } from '../post/Motion.ts';
import { DAY_BLACK_LIFT, type DayCycleSnapshot } from './DayCycle.ts';
import type { WeatherFront, WeatherState } from './Weather.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type DisplayedWeather = Pick<WeatherState, 'haze' | 'rain' | 'fog' | 'windSpeed' | 'windDirection'>;

// The sky: atmosphere, clouds, night sky and the baked environment. One cloud field feeds the
// visible sky, water reflections, environment lighting and cloud shadows. After sunset the light
// the sky lends the island takes a gain of its own (ISLAND_SKY), which the sky the eye sees, the
// sea's reflection of it and the sea's own body never take.
//
// Only the reflection panorama, environment and irradiance cross-fade between bakes. A periodic
// bake on a running clock spreads over frames: its panoramas and irradiance in the frame that asks
// for it, then the environment's PMREM conversion and GGX filters at most four render passes a
// frame, published (with the same products as a whole bake) a few frames later. Explicit bakes
// (presets, seeks, weather jumps, the first bake) and any bake while the scene clock is paused run
// whole, so paused frames stay exact. A paused page keeps its first bake's products, which a
// first bake makes from the clouds as they stand before the first frame; a scene jump (`reset`)
// returns the sky to that state, so its bake makes the same ones. The spread drives three's
// `PMREMGenerator` private steps
// (`_setSizeFromTexture`, `_init`, `_textureToCubeUV`, `_applyGGXFilter`, `_setViewport`): re-check
// them on a three upgrade; without them it falls back to `fromEquirectangular`.

// Baked products. Directions, colours, the grade and the clouds themselves are evaluated every
// frame; only these slower reflection, environment and irradiance products cross-fade. The
// environment's two atlases are kept apart (Sky.environments), so a tier may refresh it on only
// every few bakes.
interface SkyEndpoint {
	equirect: THREE.RenderTarget;
	clouds: THREE.RenderTarget;
	irradianceMap: THREE.RenderTarget;
	version: number;
	irradiance: THREE.Color;
}

// One bake: its endpoint, whether it is explicit (reads its irradiance back and shows at once),
// and the environment atlas it refreshes (null: it keeps the one shown).
interface Bake {
	version: number;
	readback: boolean;
	transitionSeconds: number;
	next: number;
	state: SkyEndpoint;
	environment: number | null;
}

// A step of a periodic bake spread over frames; `cost` counts its render passes.
interface Slice {
	cost: number;
	run: () => void;
}

// PMREMGenerator's own steps (three r186), driven one at a time so a periodic bake's GGX filter
// chain spreads over frames. Their order and arguments are those of its _fromTexture, so the
// atlas comes out the same; Sky.environmentSlices falls back to the whole call without them.
interface PMREMSteps {
	_lodMeshes: unknown[] | undefined;
	_setSizeFromTexture( texture: THREE.Texture ): void;
	_init( target: THREE.RenderTarget ): void;
	_textureToCubeUV( texture: THREE.Texture, target: THREE.RenderTarget ): void;
	_applyGGXFilter( target: THREE.RenderTarget, lodIn: number, lodOut: number ): void;
	_setViewport( target: THREE.RenderTarget, x: number, y: number, width: number, height: number ): void;
}

// Render passes of a periodic bake per frame after its first (the panoramas): the conversion to
// the cube atlas and its GGX filters (two passes each), a fraction of a millisecond each at high.
// A frame takes whole steps up to this many passes: the conversion and one filter, then two
// filters a frame.
const SLICE_PASSES = 4;
// A periodic bake whose frames stop coming (a stopped loop, a hidden page) completes after this
// long, so it never holds the sky busy.
const SLICE_TIMEOUT_MS = 250;

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
// for the stars without darkening the island's own fill. The characters, water and air take
// all of it; the environment that lights the terrain and plants takes this share.
const NIGHT_SKY = 0.55;

// Art direction: the island stays readable after sunset. Through the minutes after it the sun's
// skylight has faded while the moon's key and the night ambient are not yet in, which left the
// meadow at about half its night brightness. The light the sky lends the island takes a gain and
// a warm cast per sun elevation, ISLAND_SKY: the environment's source panorama, which lights the
// terrain and plants, in its bake, and the islanders' sky fill (`islandIrradianceNode`, the
// irradiance probe graded the same way). The seen sky, the panorama the sea reflects and the
// irradiance probe itself, which lights the sea's body, keep the atmosphere's own, so the evening's
// sky and sea look as they did. Each row is an elevation (degrees, descending): the colour the
// light is drawn toward (linear, at the light's own luminance), how far, and the gain; rows
// interpolate linearly and the end rows hold beyond them. From 2 degrees up and from -13.2 down the
// light is the atmosphere's alone. The gain peaks a little after the handoff (-2.6 degrees), where
// the sun's skylight is gone and the moon's key (DayCycle MOON_KEY_TOP) is only starting.
interface IslandRow { at: number; tint?: readonly [ number, number, number ]; amount?: number; gain?: number }
const ISLAND_SKY: readonly IslandRow[] = [
	{ at: 2 },
	{ at: - 1.3, tint: [ 1, 0.75, 0.45 ], amount: 0.5, gain: 3.2 },
	{ at: - 2.6, tint: [ 0.95, 0.8, 0.58 ], amount: 0.5, gain: 5 },
	{ at: - 4, tint: [ 0.9, 0.85, 0.7 ], amount: 0.5, gain: 2.8 },
	{ at: - 8.6, gain: 1.2 },
	{ at: - 13.2 },
];

// ISLAND_SKY at `elevation`: the tint (normalised to unit luminance) and its amount into `tint`;
// returns the gain.
function islandSky( elevation: number, tint: THREE.Vector4 ): number {

	const at = ( row: IslandRow ) => {

		const [ r, g, b ] = row.tint ?? [ 1, 1, 1 ], l = r * 0.2126 + g * 0.7152 + b * 0.0722;
		return [ r / l, g / l, b / l, row.amount ?? 0, row.gain ?? 1 ];

	};
	const rows = ISLAND_SKY;
	let v = at( rows[ rows.length - 1 ] );
	if ( elevation >= rows[ 0 ].at ) v = at( rows[ 0 ] );
	else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
		const a = at( rows[ i ] ), b = at( rows[ i - 1 ] );
		v = a.map( ( x, c ) => x + ( b[ c ] - x ) * t );
		break;

	}
	tint.set( v[ 0 ], v[ 1 ], v[ 2 ], v[ 3 ] );
	return v[ 4 ];

}

// A sky radiance or irradiance as lent to the island (ISLAND_SKY): drawn toward `tint.rgb` at its
// own luminance by `tint.w`, times `gain`. Linear in the light, so the graded probe's integral is
// the integral of the graded panorama.
const lendIsland = Fn( ( [ light, tint, gain ]: [ V3, V4, F ] ) => {

	return mix( light, tint.rgb.mul( dot( light, vec3( 0.2126, 0.7152, 0.0722 ) ) ), tint.w ).mul( gain );

} ).setLayout( { name: 'lendIsland', type: 'vec3', inputs: [ { name: 'light', type: 'vec3' }, { name: 'tint', type: 'vec4' }, { name: 'gain', type: 'float' } ] } );

// Art direction: within a few degrees of the horizon the sun shines through twenty to forty air
// masses and its light turns an almost pure red (red/blue above 100 at one degree), which paints
// the island like lava. The optical depth that sets the key's hue is capped softly a little past
// that at six degrees, while its luminance keeps the full extinction: a low sun stays golden
// orange (red/green about 2, red/blue at most about 10) and still dims as it sets. The sky and
// clouds keep their own colours.
// By day the key is whiter than the air it crosses: the hue takes SUN_HUE_CLARITY of the optical
// depth before the cap, so a morning or afternoon sun lights the meadow green and the stone
// neutral rather than straw-yellow. Within a few degrees of the horizon the cap still rules, so a
// setting sun's gold is unchanged.
const SUN_HUE_DEPTH = 1.35;
const SUN_HUE_CLARITY = 0.6;
function capSunHue( transmittance: THREE.Color ): THREE.Color {

	const { r, g, b } = transmittance;
	if ( g <= 0 ) return transmittance;
	const depth = - Math.log( g );
	const scale = SUN_HUE_CLARITY / Math.pow( 1 + Math.pow( SUN_HUE_CLARITY * depth / SUN_HUE_DEPTH, 6 ), 1 / 6 );
	const luma = ( c: THREE.Color ) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;
	const before = luma( transmittance );
	transmittance.setRGB( Math.pow( r, scale ), Math.pow( g, scale ), Math.pow( b, scale ) );
	return transmittance.multiplyScalar( before / luma( transmittance ) );

}

const NEUTRAL_TINT = new THREE.Vector4( 1, 1, 1, 0 );
// The sun's elevations (degrees) over which the moon comes into the clouds' light, in full below the
// first: the night sky's ramp, later than the moon's key (DayCycle MOON_KEY_TOP).
const CLOUD_MOON = [ - 7, - 3 ] as const;

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
	readonly grade = { exposure: 2.35, blackLift: DAY_BLACK_LIFT, daylight: 1 };
	readonly weather: DisplayedWeather = { haze: 0, rain: 0, fog: 0, windSpeed: 3.8, windDirection: 40 };
	skyIrradiance = new THREE.Color(); // E / PI over the upper hemisphere
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	readonly irradianceNode: V3;
	// The irradiance probe as lent to the island after sunset (ISLAND_SKY): the islanders' sky fill.
	readonly islandIrradianceNode: V3;
	busy = false;

	private endpoints = [ makeEndpoint(), makeEndpoint() ];
	// The environment's PMREM atlases: the one shown (environmentFront) and the next one.
	private environments: [ THREE.RenderTarget | null, THREE.RenderTarget | null ] = [ null, null ];
	private environmentFront = 0;
	// The environment refreshes on every environmentEvery-th periodic bake (setEnvironmentCadence).
	private environmentEvery = 1;
	private bakesSinceEnvironment = 0;
	// A periodic bake spread over frames: its remaining steps, and the promise to settle.
	private slices: Slice[] = [];
	private sliceDone: { resolve: () => void; reject: ( error: unknown ) => void } | null = null;
	private sliceTimer: ReturnType<typeof setTimeout> | null = null;
	private sliceMs = 0;
	// The scene clock did not advance over the last cloud update: a paused scene does its bakes whole.
	private clockStill = false;
	private readonly displaySize = new THREE.Vector2();
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
	// Share of the night ambient a panorama carries (see NIGHT_SKY and bake()).
	private nightShare = uniform( NIGHT_SKY );
	// The night sky's own light at this frame's exposure (DayCycleSnapshot.nightSkyLevel).
	private nightSkyLevel = 1;
	private displayNightSky = uniform( NIGHT_SKY );
	private bakeStarVisibility = uniform( 0 );
	// The light the sky lends the island for this frame's sun (ISLAND_SKY: the tint and its amount,
	// the gain), and the bake's copies: the island's for the environment's source, neutral for the
	// other panoramas.
	private islandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private islandGain = uniform( 1 );
	private bakeIslandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private bakeIslandGain = uniform( 1 );
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
		this.islandIrradianceNode = lendIsland( this.irradianceNode, this.islandTint, this.islandGain );
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
			const night = this.nightAmbient.rgb.mul( this.nightShare );
			// (the environment's source takes the light lent to the island: ISLAND_SKY)
			const sky = lendIsland( this.clearSky( up, night, this.overcast ).mul( cloud.a ).add( cloud.rgb ).mul( this.ambientGain ), this.bakeIslandTint, this.bakeIslandGain )
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
			const limb = sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ).mul( 0.6 ).add( 0.4 );
			// The integral of the visible disk is the key light's irradiance. A shared scene unit
			// scale keeps the normalised disk finite in fp16 without dimming it independently.
			const disk = this.atmosphere.transmittanceToSpace( d ).mul( this.displaySolarIlluminance )
				.mul( mask ).mul( limb ).div( SUN_DISPLAY_SOLID_ANGLE ).mul( smoothstep( 0, 0.001, d.y ) );
			// Above the horizon the clear sky and the clouds are both live. Below, the baked distant-sea reflection continues the waves.
			const lower = this.samplePanorama( d, float( 0 ) ).toVar();
			const cloud = this.clouds.sampleView( d ).toVar();
			const upper = this.clearSky( vec3( d.x, max( d.y, 0 ), d.z ), this.displayNightAmbient.rgb.mul( this.displayNightSky ), this.displayOvercast )
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
		if ( TEMPORAL ) {

			// Under the temporal modes the scene half renders jittered (Jitter.ts), but the dome does
			// not: each pixel keeps the direction it shows without the jitter, so a pure-sky pixel is
			// what an unjittered frame shows, and the clouds, which accumulate in their own history
			// (Clouds' view), are not accumulated a second time by the resolve. The projection is
			// three's own clip position (`cameraProjectionMatrix` times `positionView`) with the
			// unjittered matrix. Its velocity is written explicitly, no motion and class sky: the
			// resolve derives the sky's motion from the view's rotation, and the scene MRT would
			// otherwise overwrite the cleared value with an opaque surface's.
			domeMat.vertexNode = jitter.uniforms.unjitteredProjection.mul( positionView );
			domeMat.mrtNode = velocityOutput( vec4( 0, 0, MOTION_CLASS.sky, 0 ) );

		}
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

	/** The cloud view's resolution, a share of the render or of the display (`CloudViewScale`; the
	 * quality tier's `cloudView`). High's share of the display keeps the view's size, and so its
	 * kernels, while the render's scale moves, and does not soften the clouds a second time. */
	setCloudView( scale: CloudViewScale ): void {

		// Fixed targets keep sampler dimensions and both PMREM endpoints compatible while
		// quality changes. Cloud march steps and the caller's bake cadence set the GPU budget.
		this.clouds.setViewScale( scale );
		this.clouds.invalidate();

	}

	/** The environment's PMREM source: an equirect `width` x `width / 2` (512 today; 256 gives
	 * an atlas a quarter the size). It fixes the atlases' size, so it is set before the first bake. */
	setEnvironmentSource( width: number ): void {

		if ( this.initialized ) throw new Error( 'The environment source is fixed by the first bake' );
		if ( ! ( Number.isInteger( Math.log2( width ) ) && width >= 64 ) ) throw new RangeError( 'The environment source width must be a power of two of at least 64' );
		this.reflectionSource.setSize( width, width / 2 );

	}

	/** Refresh the environment (PMREM) on every `every`-th periodic bake only; the panoramas and
	 * irradiance keep their cadence, and explicit bakes always refresh it. */
	setEnvironmentCadence( every: number ): void {

		if ( ! ( Number.isInteger( every ) && every >= 1 ) ) throw new RangeError( 'The environment cadence must be a positive integer' );
		this.environmentEvery = every;

	}

	/** Compile the bake's and the clouds' pipelines ahead of their first use (startup calls this
	 * while the world generates). */
	async warm( r: THREE.WebGPURenderer = this.renderer ): Promise<void> {

		await r.init();
		await this.clouds.warm( r );
		// A pipeline depends on the target it draws into: compile each quad for its own.
		const e = this.endpoints[ 0 ];
		const pairs: [ THREE.QuadMesh, THREE.RenderTarget ][] = [
			[ this.upperQuad, e.clouds ], [ this.quad, e.equirect ], [ this.quad, this.small ],
			[ this.irradianceQuad, e.irradianceMap ], [ this.irradianceBlendQuad, this.irradianceDisplay ],
		];
		if ( this.environmentBlendQuad && this.envMap ) pairs.push( [ this.environmentBlendQuad, this.envMap ] );
		const compiling = pairs.map( ( [ quad, target ] ) => compileInto( r, quad, quad.camera, target ) );
		compiling.push( this.pmrem.compileEquirectangularShader() );
		await Promise.all( compiling );

	}

	/** Back to the state before the first bake, so the next `update` bakes as a page's first does: both
	 * endpoints and both environment atlases from one bake, shown without a blend (no trace of the
	 * bakes before), and the clouds as they stand before the first frame (no view yet, the wind's
	 * offset and the evolution at zero, the viewer at its start: Clouds.restart). For a scene jump
	 * (main.ts `establishScene`): a paused page keeps its first bake's products, so a jump must make
	 * the same ones. Call it with no bake in flight. */
	reset(): void {

		if ( this.busy ) throw new Error( 'Sky.reset: a bake is in flight' );
		this.initialized = false;
		this.front = 0;
		this.destination = 0;
		this.environmentFront = 0;
		this.bakesSinceEnvironment = 0;
		this.transitionDuration = 0;
		this.transitionElapsed = 0;
		this.blend.value = 0;
		this.liveDiagnostics = false;
		this.viewCamera = null;
		this.viewWidth = 1;
		this.viewHeight = 1;
		this.cloudTime = 0;
		this.clockStill = false;
		this.viewer.set( 0, 15, 0 );
		this.night.time.value = 0;
		this.clouds.restart();

	}

	update( transitionSeconds = 0 ): Promise<void> {

		if ( ! Number.isFinite( transitionSeconds ) || transitionSeconds < 0 ) return Promise.reject( new RangeError( 'Sky transition duration must be finite and nonnegative' ) );
		if ( this.slices.length > 0 ) {

			// A periodic bake is under way over frames. Another periodic request joins it; anyone
			// else (an explicit bake waiting for it) has it completed now, as a whole bake would be.
			const pending = this.pendingUpdate!;
			if ( transitionSeconds > 0 ) return pending;
			this.finishSlices();
			return pending;

		}
		if ( this.pendingUpdate ) return this.pendingUpdate;
		if ( this.transitioning ) {

			if ( transitionSeconds > 0 ) return Promise.resolve();
			this.advance( this.transitionDuration );

		}
		this.busy = true;
		// A periodic bake on a running clock spreads over frames: its panoramas now, inside this
		// frame, then the environment's filter chain a few passes a frame (see advance()). Its
		// products are those of a whole bake; they arrive a few frames later.
		if ( transitionSeconds > 0 && this.initialized && this.clouds.ready && this.night.ready && debugFlags.skyWholeBake !== true ) {

			const pending = new Promise<void>( ( resolve, reject ) => { this.sliceDone = { resolve, reject }; } );
			this.pendingUpdate = pending;
			try {

				this.startSlices( transitionSeconds );

			} catch ( error ) {

				this.abortSlices( error );

			}
			return pending;

		}
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
		// Cap the hue of the air's extinction first, then fade by the disk's visible share, so the
		// setting disk only dims the key and does not bleach it.
		const sunVisible = this.atmosphere.sunVisibleShareToSun();
		if ( sunVisible > 0 ) this.sunColor.copy( capSunHue( this.atmosphere.transmittanceToSun() ) ).multiplyScalar( sunVisible ).multiply( this.solarIlluminance );
		else this.sunColor.setRGB( 0, 0, 0 );
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
			this.displayNightAmbient.value.setRGB( 0.001, 0.001625, 0.003125 ).multiplyScalar( illuminance * celestial.nightAmbient );
			this.grade.exposure = celestial.exposure;
			this.grade.blackLift = celestial.blackLift;
			this.grade.daylight = celestial.daylight;
			this.islandGain.value = islandSky( celestial.elevation, this.islandTint.value );

		} else {

			this.night.moonDir.value.copy( this.sunDir ).negate();
			moonColor.setRGB( 0, 0, 0 );
			this.night.starVisibility.value = 0;
			this.displayNightAmbient.value.setRGB( 0, 0, 0 );
			this.grade.exposure = 2.35;
			this.grade.blackLift = DAY_BLACK_LIFT;
			this.grade.daylight = 1;
			this.islandTint.value.set( 1, 1, 1, 0 );
			this.islandGain.value = 1;

		}
		this.keyColorAboveClouds.copy( this.keyColor );
		const sunLuma = this.sunColor.r * 0.2126 + this.sunColor.g * 0.7152 + this.sunColor.b * 0.0722;
		const keyLuma = this.keyColor.r * 0.2126 + this.keyColor.g * 0.7152 + this.keyColor.b * 0.0722;
		this.glintScale = keyLuma > 0 ? ( sunLuma + ( keyLuma - sunLuma ) * 0.06 ) / keyLuma : 1;
		const coverage = coverageOverride ?? weather?.coverage ?? 0;
		const overcast = weather ? THREE.MathUtils.smoothstep( coverage, 0.65, 0.98 ) : 0;
		const ambientGain = weather?.ambientGain ?? 1;
		const directVisibility = weather?.directVisibility ?? 1;
		// The day's black lift is low enough to keep contrast under a closed deck's flat light, so
		// overcast and rain share it rather than lowering it further.
		// Like a camera, adapt a little to the dimmer diffuse daylight under a closed deck, less
		// so in rain, which should read as heavy.
		this.grade.exposure *= 1 + 0.5 * overcast * this.grade.daylight * ( 1 - 0.7 * ( weather?.rain ?? 0 ) );
		// After dark a closed deck hides the moon and stars; the eye adapts further so a rainy
		// dusk or night stays readable, still darker than a clear moonlit night.
		this.grade.exposure *= 1 + overcast * ( celestial?.overcastAdaptation ?? 0 );
		// The night sky's own light keeps the brightness it was tuned at, under the exposure the
		// night had then (with a closed deck's adaptation fivefold), but for the night's own gain
		// (DayCycle NIGHT_EXPOSURE_GAIN), which brightens it with the island.
		this.nightSkyLevel = celestial ? Math.min( 1, celestial.nightSkyLevel
			* ( 1 + 5 * overcast * ( 1 - celestial.daylight ) ) / ( 1 + overcast * celestial.overcastAdaptation ) ) : 1;
		this.displayNightSky.value = NIGHT_SKY * this.nightSkyLevel;
		this.night.starVisibility.value *= this.nightSkyLevel;
		moonColor.multiplyScalar( this.nightSkyLevel );
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
		const sunAbove = this.atmosphere.sunlightAt( this.sunDir, 2 ).multiply( this.sunTint ).multiplyScalar( illuminance );
		// The clouds belong to the seen sky: their moonlight keeps the night sky's own ramp
		// (CLOUD_MOON), not the key's earlier one that keeps the island lit after sunset.
		const moonGain = celestial ? ( 1 - THREE.MathUtils.smoothstep( celestial.elevation, CLOUD_MOON[ 0 ], CLOUD_MOON[ 1 ] ) ) * celestial.moonVisibility * celestial.moonIllumination : 0;
		const sunUp = ! celestial || celestial.elevation > - 2.5;
		clouds.lightDir.value.copy( sunUp ? this.sunDir : this.keyDir );
		clouds.lightColor.value.copy( sunUp ? sunAbove : new THREE.Color( 0, 0, 0 ) );
		// The clouds belong to the night sky: their moonlight and night ambient keep its level.
		const moonLight = illuminance * 0.04 * moonGain * this.nightSkyLevel;
		clouds.lightColor.value.r += 0.65 * moonLight;
		clouds.lightColor.value.g += 0.76 * moonLight;
		clouds.lightColor.value.b += moonLight;
		clouds.nightAmbient.value.copy( this.displayNightAmbient.value ).multiplyScalar( this.nightSkyLevel );
		// Low sun: lift the reddened beam, and the cool violet fill on the shaded sides with it.
		const lowSun = THREE.MathUtils.smoothstep( this.elevation, - 4, 1 ) * ( 1 - THREE.MathUtils.smoothstep( this.elevation, 6, 20 ) );
		clouds.directGain.value = 1 + 0.7 * lowSun;
		clouds.ambientGain.value = 1 + 0.35 * lowSun;
		// The sea's albedo returns a little sun and sky light to the cloud bases.
		const L = clouds.lightDir.value;
		clouds.seaBounce.value.copy( clouds.lightColor.value ).multiplyScalar( Math.max( L.y, 0 ) * 0.06 / Math.PI );

	}

	/** Advance the cloud field for this frame: wind, slow evolution and the view from `camera`,
	 * whose drawing buffer is `width` by `height` pixels. The clouds drift by the surface wind's
	 * integrated displacement (`shared.wind.displacement`, Clouds.setDrift), at their own rates
	 * aloft. */
	updateClouds( camera: THREE.PerspectiveCamera, width: number, height: number, windDirection: THREE.Vector2, time: number ): void {

		if ( ! this.clouds.ready ) return;
		this.viewCamera = camera;
		this.viewWidth = width;
		this.viewHeight = height;
		this.clockStill = time === this.cloudTime;
		this.cloudTime = time;
		const display = this.renderer.getSize( this.displaySize );
		this.clouds.setDisplay( display.x, display.y, this.renderer.getPixelRatio() );
		// Weather arrives from upwind.
		this.clouds.frontAxis.value.copy( windDirection ).negate().normalize();
		this.clouds.cirrusAxis.value.copy( windDirection ).normalize();
		this.clouds.setDrift( shared.wind.displacement.value );
		// The clouds' inner structure rises through them at 2.5 m/s, as a cumulus' turrets do
		// (the rain curtains fall by the same clock).
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
		await this.renderer.init();
		if ( ! this.clouds.ready ) await this.clouds.init( this.renderer );
		await this.night.load();
		if ( ! this.night.ready ) await this.night.init();
		// An explicit jump (preset, seek, weather change) refreshes the whole cloud map now.
		if ( readback ) {

			this.clouds.invalidate();
			this.clouds.update( this.renderer, this.viewCamera, this.viewWidth, this.viewHeight, this.cloudTime );

		}
		const bake = this.beginBake( version, readback, transitionSeconds, celestial, weather );
		this.renderPanoramas( bake );
		const r = this.renderer;
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
			bake.state.irradiance.setRGB( E[ 0 ] / Math.PI, E[ 1 ] / Math.PI, E[ 2 ] / Math.PI );

		}
		if ( bake.environment !== null ) this.filterEnvironment( bake.environment );
		if ( ! this.initialized ) {

			// The first bake fills both atlases from the same source.
			this.front = bake.next;
			this.filterEnvironment( 1 );

		}
		this.publishBake( bake );
		this.lastBakeMs = performance.now() - started;

	}

	// Pick the endpoint a bake writes and capture the state it bakes: the live state from
	// track() (the atmosphere LUT, key light, clouds and stars already describe this frame's sun
	// and moon) and the weather and day it was requested with.
	private beginBake( version: number, readback: boolean, transitionSeconds: number, celestial: DayCycleSnapshot | null, weather: WeatherState | null ): Bake {

		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		const next = this.initialized ? 1 - this.front : 0;
		const state = this.endpoints[ next ];
		state.version = version;
		const ambientGain = weather?.ambientGain ?? 1;
		const overcast = weather ? THREE.MathUtils.smoothstep( weather.coverage, 0.65, 0.98 ) : 0;
		this.ambientGain.value = ambientGain;
		this.overcast.value = overcast;
		this.nightAmbient.value.copy( this.displayNightAmbient.value );
		const daylight = celestial ? celestial.daylight : 1;
		this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance * daylight )
			.add( this.nightAmbient.value.clone().multiplyScalar( 0.22 ) ).multiplyScalar( ambientGain );
		this.bakeStarVisibility.value = this.night.starVisibility.value;
		// The environment refreshes on explicit bakes and on every environmentEvery-th periodic one,
		// into the atlas not shown.
		let environment: number | null = 0;
		if ( this.initialized ) {

			const refresh = readback || ++ this.bakesSinceEnvironment >= this.environmentEvery;
			environment = refresh ? 1 - this.environmentFront : null;

		}
		if ( environment !== null ) this.bakesSinceEnvironment = 0;
		return { version, readback, transitionSeconds, next, state, environment };

	}

	// The cloud layer, the panoramas (seen, starlit environment source, irradiance probe) and the
	// irradiance integral.
	private renderPanoramas( bake: Bake ): void {

		const { state } = bake;
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
				// The seen sky and its reflections show the night sky's level; the environment that
				// lights the terrain and plants keeps its full share, as the island's light does.
				this.nightShare.value = rt === this.small ? 1 : rt === this.reflectionSource ? NIGHT_SKY : this.displayNightSky.value;
				// Only the environment's source takes the island's light after sunset (ISLAND_SKY).
				const lends = rt === this.reflectionSource;
				this.bakeIslandTint.value.copy( lends ? this.islandTint.value : NEUTRAL_TINT );
				this.bakeIslandGain.value = lends ? this.islandGain.value : 1;
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

	}

	// The environment of the starlit source in atlas `index`, whole.
	private filterEnvironment( index: number ): void {

		this.environments[ index ] = this.pmrem.fromEquirectangular( this.reflectionSource.texture, this.environments[ index ] );

	}

	// The same as filterEnvironment, as steps of one or two render passes: the conversion to the
	// cube atlas, then each level's GGX filter from the one above. Each step restores what
	// PMREMGenerator restores after a whole conversion.
	private environmentSlices( index: number ): Slice[] {

		const pmrem = this.pmrem as unknown as PMREMSteps;
		const target = this.environments[ index ];
		const stepwise = target && pmrem._lodMeshes && [ pmrem._setSizeFromTexture, pmrem._init, pmrem._textureToCubeUV, pmrem._applyGGXFilter, pmrem._setViewport ]
			.every( ( f ) => typeof f === 'function' );
		if ( ! stepwise || ! target ) return [ { cost: 20, run: () => this.filterEnvironment( index ) } ];
		const r = this.renderer, source = this.reflectionSource.texture;
		const step = ( work: () => void ) => () => {

			const previous = r.getRenderTarget(), face = r.getActiveCubeFace(), level = r.getActiveMipmapLevel(), autoClear = r.autoClear;
			try {

				work();

			} finally {

				r.autoClear = autoClear;
				r.setRenderTarget( previous, face, level );
				target.scissorTest = false;
				pmrem._setViewport( target, 0, 0, target.width, target.height );

			}

		};
		const slices: Slice[] = [ { cost: 1, run: step( () => {

			pmrem._setSizeFromTexture( source );
			pmrem._init( target );
			pmrem._textureToCubeUV( source, target );

		} ) } ];
		// _init keeps the levels of the source size the first bake set up, so their count is known.
		const levels = pmrem._lodMeshes!.length;
		for ( let i = 1; i < levels; i ++ ) slices.push( { cost: 2, run: step( () => {

			r.autoClear = false;
			pmrem._applyGGXFilter( target, i - 1, i );

		} ) } );
		return slices;

	}

	// Start a periodic bake over frames: the panoramas now, the rest from advance().
	private startSlices( transitionSeconds: number ): void {

		const started = performance.now();
		const weather = this.weatherState ? { ...this.weatherState } : null;
		const bake = this.beginBake( ++ this.bakeVersion, false, transitionSeconds, this.celestial, weather );
		this.renderPanoramas( bake );
		this.slices = bake.environment === null ? [] : this.environmentSlices( bake.environment );
		this.slices.push( { cost: 0, run: () => this.publishBake( bake ) } );
		this.sliceMs = performance.now() - started;
		// A paused scene does it whole, so a paused frame never depends on how many frames ran.
		if ( this.clockStill ) this.finishSlices();
		else this.armSliceTimer();

	}

	// Run whole steps of the bake under way, up to `passes` render passes (at least one step); its
	// publication ends it. An error ends the bake and rejects its promise, as a whole bake's would,
	// so the sky is free for the next one.
	private runSlices( passes: number ): void {

		const started = performance.now();
		let spent = 0;
		try {

			while ( this.slices.length > 0 && ( spent === 0 || spent + this.slices[ 0 ].cost <= passes ) ) {

				const slice = this.slices.shift()!;
				spent += slice.cost;
				slice.run();

			}

		} catch ( error ) {

			this.abortSlices( error );
			return;

		}
		this.sliceMs += performance.now() - started;
		if ( this.slices.length > 0 ) {

			this.armSliceTimer();
			return;

		}
		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = null;
		this.lastBakeMs = this.sliceMs;
		this.busy = false;
		this.pendingUpdate = null;
		const done = this.sliceDone;
		this.sliceDone = null;
		done?.resolve();

	}

	// End the bake under way unfinished: `error` rejects its promise, none resolves it (dispose).
	private abortSlices( error?: unknown ): void {

		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = null;
		this.slices = [];
		this.busy = false;
		this.pendingUpdate = null;
		const done = this.sliceDone;
		this.sliceDone = null;
		if ( error === undefined ) done?.resolve();
		else done?.reject( error );

	}

	private finishSlices(): void {

		this.runSlices( Infinity );

	}

	private armSliceTimer(): void {

		if ( this.sliceTimer !== null ) clearTimeout( this.sliceTimer );
		this.sliceTimer = setTimeout( () => {

			this.sliceTimer = null;
			if ( this.slices.length > 0 ) this.finishSlices();

		}, SLICE_TIMEOUT_MS );

	}

	// Show a finished bake: an explicit one at once, a periodic one by cross-fading to it.
	private publishBake( bake: Bake ): void {

		const { state, readback, version, transitionSeconds } = bake;
		const r = this.renderer;
		const previous = this.endpoints[ this.front ];
		const displayedNext = this.initialized ? state : this.endpoints[ 1 ];
		if ( ! this.initialized ) {

			// Both endpoints start from this bake's cloud layer.
			const prev = r.getRenderTarget();
			r.setRenderTarget( this.endpoints[ 1 ].clouds );
			this.upperQuad.render( r );
			r.setRenderTarget( prev );

		}
		this.panoramaA.value = previous.equirect.texture;
		this.panoramaB.value = displayedNext.equirect.texture;
		this.irradianceA.value = previous.irradianceMap.texture;
		this.irradianceB.value = displayedNext.irradianceMap.texture;
		// The environment cross-fades from the atlas shown to the one this bake filtered (the
		// first bake filled both); a bake that kept it fades it to itself.
		const shown = this.environments[ this.environmentFront ]!;
		const nextEnvironment = ! this.initialized ? this.environments[ 1 ]! : bake.environment !== null ? this.environments[ bake.environment ]! : shown;
		if ( this.initialized && bake.environment !== null ) this.environmentFront = bake.environment;
		if ( ! this.environmentA || ! this.environmentB ) {

			this.environmentA = texture( shown.texture );
			this.environmentB = texture( nextEnvironment.texture );
			this.envMap = shown.clone();
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

			this.environmentA.value = shown.texture;
			this.environmentB.value = nextEnvironment.texture;

		}
		this.destination = bake.next;
		this.transitionElapsed = 0;
		this.transitionDuration = this.initialized ? transitionSeconds : 0;
		this.blend.value = ! this.initialized || this.transitionDuration > 0 ? 0 : 1;
		this.equirect = state.equirect;
		this.initialized = true;
		this.liveDiagnostics = ! readback;
		this.publish( this.blend.value );
		if ( this.transitionDuration === 0 ) this.front = this.destination;
		if ( ! readback ) this.refreshDiagnosticIrradiance( state, version );

	}

	advance( dt: number ): void {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'Sky dt must be finite and nonnegative' );
		if ( this.slices.length > 0 ) {

			// A periodic bake under way takes this frame's share; once published, its cross-fade
			// starts on the next frame. A paused scene completes it at once.
			if ( this.clockStill ) this.finishSlices();
			else this.runSlices( SLICE_PASSES );
			return;

		}
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

		}
		for ( const environment of this.environments ) environment?.dispose();
		this.abortSlices();
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
