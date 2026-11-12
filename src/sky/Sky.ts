/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, ivec2, float, sqrt, max, min, atan, asin, acos, clamp, cos, sin, mix, abs, select,
	pmremTexture, textureLoad, Loop, cross, exp2, log2, positionView, fwidth, length, step,
} from 'three/tsl';
import { Atmosphere, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_ANGULAR_RADIUS, SUN_LIMB_U1, SUN_LIMB_U2 } from '../lighting/Radiometry.ts';
import { SUN_DISC_RADIUS, SUN_DISC_SOLID_ANGLE, SUN_DISC_RADIANCE } from '../lighting/SunDisc.ts';
import { Clouds, EARTH_RADIUS, MOON_DECK_GLOW, SHADOW_SLOPE_FLOOR, forwardLevel, type CloudViewScale } from './Clouds.ts';
import { MOON_ANGULAR_RADIUS, NightSky } from './NightSky.ts';
import { Lightning } from '../weather/Lightning.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { shared } from '../shared.ts';
import { compileInto } from '../post/graph/Compile.ts';
import { STORE_CEILING, storePress, storeStops } from '../post/PreExposure.ts';
import { FSR3, TEMPORAL } from '../post/Antialiasing.ts';
import { jitter } from '../post/Jitter.ts';
import { MOTION_CLASS, meterOutput, motionNode } from '../post/Motion.ts';
import { DAY_EXPOSURE, MOON, cloudMoonShare, displayNight, duskForce, exposureNight, nightAmbientShare, skyNight, starNight, sunRising, type DayCycleSnapshot } from './DayCycle.ts';
import { cloudedHighSun, cloudedShare, overcastDeckLight, overcastFloorSun, daySkyAt, type WeatherState } from './Weather.ts';
import { keyed } from '../post/DayKeys.ts';
import { tune } from '../debug/Tune.ts';
import { setKeyCloud } from '../lighting/KeyCloud.ts';
import { environmentSteps } from '../three/Environment.ts';
import { CLEAR_SHADE, CLEAR_SHADE_TINT, CLEAR_SKY, CLOUD_LIGHT_TINT, CLOUD_SKIES, type CloudSky, KEY_DECK_WHITE, KEY_THROUGH_CLOUD, LOW_KEY, LOW_SUN, LOW_SUN_TINT, MOON_KEY, MOON_KEY_LUMINANCE, MOON_SKY_HUE, NIGHT_AMBIENT_HUE, NIGHT_AMBIENT_SHARE, SHADOW_DENSITY, SKY_LIGHT, STREAK_AMBIENT, STREAK_DIRECT, byElevation, islandSky, keyHue, luma, luminance709, moonHue, seaKnee, storeNight } from '../look/SkyLook.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
// The haze toward a view direction, out to a distance (the sky's own by default): the light it adds
// and its transmittance (VolumetricHaze.ts `skyHaze`).
export type SkyHaze = ( d: V3, distance?: THREE.Node<'float'> ) => { light: V3; transmittance: V3 };
// Directions the discs' cloud transmittance averages over each disc (discCloudTransmittance): the
// disc is about a degree wide, and 32 dim it without visible steps.
const DISC_SAMPLES = 32;
// The sky's metering illuminance against its geometric-mean luminance (k_m), and the floor of the
// luminance whose log the mean takes (scene units: far below a moonless night's sky).
const METER_SKY = 1;
const METER_FLOOR = 2 ** - 40;
// What the bakes store, the cloud layer (`upperMat`, read by `layerAt`), the seen panoramas and the
// environment's source (and so the environment's PMREM atlases, filtered from it): the radiance
// times a power of two that each bake takes from the light on the clouds and the weather's skies at
// its moment, worked out as the cloud dome's is (Clouds.ts `storeLight`, PreExposure.ts
// `storeStops`, STORE_RANGE: the layer's `layerStops`, the panoramas' `panoramaStops`). Unscaled,
// a clear midnight's sky lay near 2^-18 (its first percentile) and its layer near 2^-21, under
// half float's 2^-14, where the steps are coarse, and one fixed power of two that lifts them and
// keeps a day's brightest under STORE_CEILING leaves too little room for a night pressed darker
// (the debug press, PreExposure.ts `storePress`). A power of two, so what lay in range keeps its
// bits, and every reader multiplies by its inverse, set with the store
// (`layerRead`, the panoramas' two sides in `samplePanorama`, the displayed environment's blend and
// `environmentRead`, the source's for AmbientRelight.ts: `onEnvironmentSource`). It is worked out
// from the scene's state, never read back and never from the frame's pre-exposure
// (PreExposure.ts), which would ask for a rebake at every change of the exposure; a scene's bake
// takes the same power whatever came before it. The irradiance probe's panorama (`small`, single
// float) stores the radiance as it is.

type DisplayedWeather = Pick<WeatherState, 'haze' | 'rain' | 'fog' | 'windSpeed' | 'windDirection'>;

// The sky: atmosphere, clouds, night sky and the baked environment (the look's tables it reads,
// the names in capitals below and `islandSky`, `keyHue`, `moonHue`, are look/SkyLook.ts's). One cloud field feeds the
// visible sky, water reflections, environment lighting and cloud shadows; on the island's direct
// light the shadows keep a floor (`keyDirectVisibility`: a share of what the cloud layer passes
// down, KEY_THROUGH_CLOUD, which the sea and the air keep too: `seaKeyVisibility`, `deckKeyFloor`), and under a
// closed deck the key and the clouds' sunlight lose their colour, not their luminance (Weather.ts), as from a cloudy sky on
// the sunlight the clouds scatter many times does (trackClouds). By day the sky's light, the
// sun's in-scattered light, takes one gain
// against the sun's own (SKY_LIGHT, an illuminance colour), which everything that reads the sky
// takes, and under a clear or fair day's sun another that holds it against the key (CLEAR_SKY);
// a cloud deck does not mute the clear sky's colour behind it. At night the clear sky is the
// moon's in-scatter, lit as the sun lights it (the moon's light above the air under the sun's sky
// gain at the moon's height, `track`), and the stars: no airglow and no night floor of its own (the
// clouds and the distant sea take a faint one, `displayNightAmbient`). The stars are drawn where
// the eye sees the sky and never baked into the light the sky lends: starlight is a few hundredths
// of the moonlit sky's light on level ground. The night sky the dome draws stands below the light
// it sheds (Weather.ts `seenNight`, by the display's night weight: `track`, `domeGapGain`;
// shared.ts `seenNight`): the moon's sky behind the clouds and the clouds as drawn, never the bakes, the
// stars, the moon's disc or the haze laid over them, so the land and the sea keep the light it
// gives and only the sky over them darkens; the far sea's reflection meets it (ocean/Water.ts
// SEEN_SKY), the far air's in-scattered moon's sky and deck light take it (weather/VolumetricHaze.ts
// SEEN_AIR), and the exposure's meter reads the sky's pixels at the light the sky sheds
// (post/Metering.ts). The moon stands fixed in the sky (DayCycle.ts MOON): it is drawn and
// lights the sky (and through the atmosphere's `moonDir` the clouds and the haze) from there, the
// island takes its light from there (lighting/KeyLift.ts), and the key's direction (`keyDir`)
// turns there over the handoff and holds there all night, so the water's glint and the clouds'
// light see the moon where it is drawn. The clouds take their own path between the two in the
// twilight, while no light reaches them (CLOUD_TURN). After sunset the light the sky lends the island takes a gain
// of its own (ISLAND_SKY), and under a clouded high sun a tint of its own (CLOUD_LIGHT_TINT), which
// the sky the eye sees, the sea's reflection of it and the sea's own body never take. The dome lays the air's haze over
// itself (`fogDome`, VolumetricHaze.ts `skyHaze`): the clouds at the distance to their shell's middle
// height (the weather's shell: CLOUD_SKIES, low under cloudy and overcast skies), under the low
// deck's share at the march's own opacity-weighted depth, and under the thin layer's share of their
// opacity at its own height (Clouds `sampleViewFog`), the sky behind them along the whole way; so the haze's composite leaves the sky's pixels. Measured on the horizon
// views (paused, fresh loads): overcast's sky box spread .067 to .059, its gradient p99 .019 to .043
// and its scale std under 3 degrees .0017 to .0030, the deck's rolls showing from about 8 degrees
// up; cloudy's gradient p99 .042 to .071 and mass x 3.6 to 3.5 degrees.
// The environment's bake lays the dome's haze over the seen panorama and the probe's (`fogEnvironment`,
// VolumetricHaze.ts `openSky`, toward every direction from the sea's level, unshadowed), so the sea
// reflects the light the haze scatters (the seen panorama, above the horizon) and the sky's meter
// takes it. The land's source takes the same haze without the fog layer: the land's key loses
// nothing to the fog layer, so its sky light takes none of the droplets' light either (the dome and
// the land's sky are one sky wherever there is no fog layer: under cloud, and once the sun is a
// degree below the horizon, without the deep sea fog). The deep sea fog (`?seaFog`) and the parked
// fog weather's droplets are left out of the land's light too. Under
// overcast the two part in three ways. The closed deck's glow (`deckGlow`: a narrow peak about the
// key light and a broad tail) is drawn whole by the dome and the seen panorama; the lighting's
// sources take the glow about the sun alone, as one smooth lobe of their own (`glowToward`, Clouds
// `bakeGlowLobe`, `bakeGlowGain`), so the land is lit from the sun's side of the deck as the deck
// is seen brighter there, and the moon's glow lights nothing. The deck itself is drawn as it
// lights: the dome and the lighting's sources take one radiance from the march. The day's
// level, gradation and glow form give way to the night's over the civil twilight (`deckDay`). And
// the air's floor of the key under the deck (VolumetricHaze.ts `keyFloor`) is drawn but lights
// nothing (`bakeKeyFloor`: it makes a few percent of the sky toward the sun and well under one
// percent away from it). So the drawn sky stands above the sky the land's harmonics give toward the
// sun at mid elevations, and under it at the horizon and away from the sun. Under the horizon the
// environment is the distant sea, its reflection of the sky over its body, which the light that
// reaches the sea lights, the sky's and the sun's (SEA_KNEE).
// The sun's disc and the moon's take the clouds' transmittance once, per pixel, in the composite
// (`domeColour`); the march stores none once less than 0.003 gets through (Clouds.ts `makeMarch`),
// so a deck some 6 deep along the view hides the disc whole. The mean over each disc, read from the
// panorama into a texel ahead of the scene (`discCloudTransmittance`), is left only for the light
// shafts (post/LightShafts.ts) and the sun's flare. The key light's colour does not take that mean
// either: the lit surfaces already read the clouds' shadow map along the same ray.
// Under a low key that map's rays spread over the key's disc (SHADOW_DISC): whatever lights the
// ground and feeds the meter from it reads the whole disc, the air's shafts its centre from about
// 5 degrees up (SHADOW_AIR_NARROW).
// The dome writes the exposure's metering illuminance (Motion.ts `meterOutput`): one value for all
// its pixels, the sky's geometric-mean luminance exp( mean ln Y ) over the upper hemisphere by solid
// angle, times METER_SKY. The irradiance probe's pass reduces it from the same panorama once per
// bake, as log2 in its alpha, so the cross-fade between bakes blends it geometrically; the exposure
// reads that log directly (`meterLog2Node`, shared.ts `skyMeterLog2`).
//
// Only the reflection panorama, environment and irradiance cross-fade between bakes. A periodic
// bake on a running clock spreads over frames: its panoramas and irradiance in the frame that asks
// for it, then the environment's PMREM conversion and GGX filters at most four render passes a
// frame, published (with the same products as a whole bake) a few frames later. Explicit bakes
// (presets, seeks, weather jumps, the first bake) and any bake while the scene clock is paused run
// whole, so paused frames stay exact. A paused page keeps its last explicit bake's products, and
// every explicit bake (the load's, a scene jump's, a seek's, a retune's) starts from the state
// before a page's first bake, the clouds set to the scene clock (`reset`), so each makes the ones
// a fresh load of its scene makes. A bake waits for the warm-up's
// pipelines (`warm`) before it draws: three r186 skips a draw whose pipeline an asynchronous
// compile is still creating, so a bake drawn meanwhile left its products empty (the irradiance
// probe at 0: no sky light, and the exposure about five stops off at noon), and a paused page,
// which bakes no more, kept them. The spread drives three's `PMREMGenerator` private steps
// (three/Environment.ts, which throws on a three without them).

// Baked products. Directions, colours, the grade and the clouds themselves are evaluated every
// frame; only these slower reflection, environment and irradiance products cross-fade. The
// environment's two atlases are kept apart (Sky.environments), so a tier may refresh it on only
// every few bakes.
interface SkyEndpoint {
	equirect: THREE.RenderTarget;
	clouds: THREE.RenderTarget;
	irradianceMap: THREE.RenderTarget;
	// the cloudless sky's (Sky.clearIrradianceNode)
	clearIrradianceMap: THREE.RenderTarget;
	// the sky's without the haze over it, its clouds included (Sky.deckIrradianceNode)
	deckIrradianceMap: THREE.RenderTarget;
	version: number;
	irradiance: THREE.Color;
	// the distant sea's body as its bake lit it (SEA_KNEE): what the bake took and, read back with its
	// deck irradiance, the radiance (`landSea`)
	sea: { body: THREE.Color; night: THREE.Color; sun: number; knee: number; radiance: THREE.Color };
	// the power of two its panorama is stored at (the bake's `panoramaStops`)
	stops: number;
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
		clearIrradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		deckIrradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		version: 0,
		irradiance: new THREE.Color( 0, 0, 0 ),
		sea: { body: new THREE.Color(), night: new THREE.Color(), sun: 0, knee: 1, radiance: new THREE.Color() },
		stops: 0,
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

/** How far the low sun's look has come in at `elevation` (degrees) under a sky of direct
 * visibility `direct`: 0 above LOW_SUN.top and below the horizon, 1 from LOW_SUN.full down to
 * 3 degrees (the island's blue-violet shade). */
export function lowSun( elevation: number, direct: number ): number {

	// (off unless a number is set, with the clear shade)
	const scale = typeof debugFlags.lowSun === 'number' ? debugFlags.lowSun : debugFlags.lowSun === true ? 1 : 0;
	return THREE.MathUtils.smoothstep( elevation, 0, 3 ) * ( 1 - THREE.MathUtils.smoothstep( elevation, LOW_SUN.full, LOW_SUN.top ) )
		* THREE.MathUtils.smoothstep( direct, 0.3, 0.95 ) * scale;

}

// CLEAR_SHADE's share at `elevation` under a sky of direct visibility `direct`.
function clearShade( elevation: number, direct: number ): number {

	const rows = CLEAR_SHADE;
	let share = rows[ rows.length - 1 ].share;
	if ( elevation >= rows[ 0 ].at ) share = rows[ 0 ].share;
	else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
		share = rows[ i ].share + ( rows[ i - 1 ].share - rows[ i ].share ) * t;
		break;

	}
	// (off unless a number is set: the lifted shade took the light's direction out of the meadow)
	const scale = typeof debugFlags.clearShade === 'number' ? debugFlags.clearShade : debugFlags.clearShade === true ? 1 : 0;
	return share * THREE.MathUtils.smoothstep( direct, 0.3, 0.95 ) * scale;

}

const _skyLight = { r: 0, g: 0, b: 0 };
const _clearSky = { gain: 1 };
// CLEAR_SKY's gain at `elevation` under a sky of clouded share `cloud`: exactly 1 with the sun at or
// under the horizon and under a cloudy or overcast sky (`flags=clearSky:false` leaves it 1, for A/Bs)
function clearSky( elevation: number, rising: boolean, cloud: number ): number {

	if ( debugFlags.clearSky === false ) return 1;
	const day = keyed( CLEAR_SKY, elevation, 0, _clearSky, 0, rising ).gain;
	return 1 + ( day - 1 ) * ( 1 - cloud );

}
// The sky's gain on the sun's light it lends: SKY_LIGHT's keys, the weather's day sky `daySky`
// (Weather.ts `daySkyAt`) on the day keys' share alone, so it is exactly the keys' own light where
// the night key has the sky (DayCycle.ts `skyNight` at 1) or the day sky is 1 (every weather but
// overcast), and CLEAR_SKY's over both. (`flags=skyGain:false` leaves the sky as the atmosphere
// gives it, but for the day sky, `lowKey:false` the key as its transmittance gives it, for A/Bs)
const skyGain = ( elevation: number, rising: boolean, cloud: number, daySky: number, target: THREE.Color ) => {

	const night = skyNight( elevation, rising, cloud ), off = debugFlags.skyGain === false;
	if ( off ) target.setScalar( 1 );
	else {

		const { r, g, b } = keyed( SKY_LIGHT, elevation, night, _skyLight, cloud, rising );
		target.setRGB( r, g, b );

	}
	if ( daySky !== 1 && night < 1 ) {

		const share = ( daySky - 1 ) * ( 1 - night );
		if ( off ) target.addScalar( share );
		else {

			const { r, g, b } = keyed( SKY_LIGHT, elevation, 0, _skyDay, cloud, rising );
			target.r += r * share;
			target.g += g * share;
			target.b += b * share;

		}

	}
	return off ? target : target.multiplyScalar( clearSky( elevation, rising, cloud ) );

};
const _skyGain = new THREE.Color(), _skyBeam = new THREE.Color(), _skyMoon = new THREE.Color(), _skyDay = { r: 0, g: 0, b: 0 };
const lowKey = ( elevation: number ) => debugFlags.lowKey === false ? 1 : byElevation( LOW_KEY, elevation, 'gain' );

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

// A sky radiance or irradiance as lent to the island (ISLAND_SKY): drawn toward `tint.rgb` at its
// own luminance by `tint.w`, times `gain`. Linear in the light, so the graded probe's integral is
// the integral of the graded panorama.
const lendIsland = Fn( ( [ light, tint, gain ]: [ V3, V4, F ] ) => {

	return mix( light, tint.rgb.mul( dot( light, vec3( 0.2126, 0.7152, 0.0722 ) ) ), tint.w ).mul( gain );

} ).setLayout( { name: 'lendIsland', type: 'vec3', inputs: [ { name: 'light', type: 'vec3' }, { name: 'tint', type: 'vec4' }, { name: 'gain', type: 'float' } ] } );

// The closed deck's glow about the key light toward `d` (Clouds.ts DECK_GLOW), drawn where the sky is
// composed, not marched: smooth and round whatever the deck's depth and its rolls. The drawn deck
// takes it with both lobes; the lighting's sources (the bakes) take one smooth lobe of their own
// about the sun (Clouds `bakeGlowLobe`, `bakeGlowGain`) by the day's weight (`deckDay`,
// `glowToward`). The deck's mean radiance `deck` times the key's
// share of the light on its tops, two forward lobes toward the sun and the same two toward the moon
// mixed by the sun's share (each a Henyey-Greenstein lobe of mean 1 over the sphere, a narrow one
// for the peak and a broad one for the tail; the sun's tinted as the deck's tops take its light),
// the clouds' opacity toward `d`, the deck's share of the sky, and `pattern` to the power k: the
// base's local radiance over the deck's mean as its diffuse law gives it there (`deckPattern`), so
// the glow follows the base's own pattern, brightening its thin parts and leaving its dark masses
// dark (at k = 0 a smooth glow). `shares` = ( the key's share, the sun's share, the deck's share,
// k ), `form` = ( the narrow lobe's mean cosine, its weight, the broad lobe's mean cosine, its
// weight ).
const deckGlow = Fn( ( [ d, deck, opacity, sunDir, moonDir, tint, shares, form, pattern ]: [ V3, V3, F, V3, V3, V3, V4, V4, F ] ) => {

	const hg = ( g: F, nu: F ) => float( 1 ).sub( g.mul( g ) ).div( max( float( 1 ).add( g.mul( g ) ).sub( nu.mul( g ).mul( 2 ) ), 1e-4 ).pow( 1.5 ) );
	const lobes = ( nu: F ) => hg( form.x, nu ).mul( form.y ).add( hg( form.z, nu ).mul( form.w ) );
	const forward = mix( vec3( lobes( dot( d, moonDir ) ) ), tint.mul( lobes( dot( d, sunDir ) ) ), shares.y );
	return deck.mul( forward ).mul( shares.x.mul( shares.z ).mul( opacity ).mul( pattern.pow( shares.w ) ) );

} ).setLayout( { name: 'deckGlow', type: 'vec3', inputs: [
	{ name: 'd', type: 'vec3' }, { name: 'deck', type: 'vec3' }, { name: 'opacity', type: 'float' }, { name: 'sunDir', type: 'vec3' },
	{ name: 'moonDir', type: 'vec3' }, { name: 'tint', type: 'vec3' }, { name: 'shares', type: 'vec4' }, { name: 'form', type: 'vec4' },
	{ name: 'pattern', type: 'float' },
] } );

// The base's local radiance toward `d` over the deck's mean as the column's diffuse law gives it
// there, ( 3 / 7 )( 1 + 2 mu ) times the deck's mean radiance (Clouds.ts makeMarch: its mean over
// level ground is the deck's), moved toward a uniform deck by `flat` as the march moves it (Clouds
// `deckFlat`), so it has no trend with elevation and averages about 1 over the deck: what the glow
// follows (`deckGlow`). Held in [ 1e-6, 4 ], so its power is finite at any k
// and a lone bright seam cannot flare.
const deckPattern = Fn( ( [ d, local, deck, flat ]: [ V3, V3, V3, F ] ) => {

	const law = max( d.y, 0 ).mul( 6 / 7 ).add( 3 / 7 ).toVar();
	const mean = dot( deck, vec3( 0.2126, 0.7152, 0.0722 ) ).mul( law.add( float( 1 ).sub( law ).mul( flat ) ) );
	return clamp( dot( local, vec3( 0.2126, 0.7152, 0.0722 ) ).div( max( mean, 1e-20 ) ), 1e-6, 4 );

} ).setLayout( { name: 'deckPattern', type: 'float', inputs: [ { name: 'd', type: 'vec3' }, { name: 'local', type: 'vec3' }, { name: 'deck', type: 'vec3' }, { name: 'flat', type: 'float' } ] } );

// The low sun's lift of the clouds' beam and fill (trackClouds), fading as the sky closes.
const lowSunOf = ( elevation: number, coverage: number ) => THREE.MathUtils.smoothstep( elevation, - 4, 1 )
	* ( 1 - THREE.MathUtils.smoothstep( elevation, 6, 20 ) ) * ( 1 - THREE.MathUtils.smoothstep( coverage, 0.35, 0.65 ) );

const NEUTRAL_TINT = new THREE.Vector4( 1, 1, 1, 0 );
const _white = new THREE.Color();
const _zenith = new THREE.Vector3( 0, 1, 0 );
// The clouds' own moonlight (DayCycle.ts `cloudMoonShare`, its windows DUSK_WINDOWS.cloudMoon) comes
// in after sunset and leaves before sunrise: in the evening over the window of the night sky's
// light (DUSK_WINDOWS.sky), by stops as they come in (DUSK_DEPTH
// cloudMoon: faded evenly, the clouds' moonlight was the largest share of the step the sky's meter
// made from -7 to -7.5, 0.7 of 1.6 stops). From -7 to -3 the moonlit clouds came in
// while the sky behind them was still the sun's afterglow: at -5.3 degrees they gave about half the light
// of the sky 8 degrees up, which greyed the glow and the far sea under it. The morning keeps -7 to
// -3, inside its night sky's window (-13 to -3): there the moonlit clouds are part of the
// sky the dawn's exposure meters (on a clear morning the thin layer's most), and without it the land
// and the low band over the horizon at -6.5 degrees read lighter. Under cloud the evening keeps -7
// to -3 too, as every night layer keeps the daylight's timing there (DayCycle.ts: the
// clouded sky's night is whole by -6): no afterglow lights the sky behind the deck, and taken in
// from -11 by stops, an overcast deck's moonlight was under a hundredth of this at -8 degrees.
const _streakKey = { r: 0, g: 0, b: 0 };
// The sun's elevations (degrees) over which the light the clouds march toward sets from the moon's
// key to the sun's height, then comes round to the sun's azimuth: where no moonlight reaches them
// (DayCycle.ts DUSK_WINDOWS.cloudMoon) and before the sun's does (`sunlightAt` at 2 km, above about -2).
const CLOUD_TURN = [ - 3, - 2.5, - 2 ] as const;
// The sine of the sun's elevation over which the clouds' shadow comes in as it rises.
const CLOUD_SHADOW_SET = [ - 0.02, 0.02 ] as const;
// The height over a low deck's base (metres) the bake fogs its clouds out to, where a closed deck's
// march gathers most of its light (the dome reads the march's own depth: `domeColour`).
const DECK_LIGHT_HEIGHT = 150;
// The sine of the key's elevation over which the rays of the clouds' shadow gather from the height
// of its disc to its centre as it climbs, from 8 to 11 degrees: from there up a cloud's own edge
// takes longer to pass than the disc does (near 0.8 degree at 10 degrees, 0.15 at 4.7). The rays
// are as many as keep the disc from stepping: four, 0.135 degree apart, stepped the light by a
// quarter of the sun; these are 0.045 degree apart.
// Twelve cost about one percent of the frame's GPU time at their dearest, an overcast sky near
// 11 degrees, and only from about 4.3 to 11 degrees: under that the rays are one ray.
const SHADOW_DISC = [ 0.139, 0.191 ] as const;
const SHADOW_DISC_RAYS = 12;
// The key's elevations (degrees) over which the channel of the clouds' shadow the air reads narrows
// from the whole disc to its two centre rays, a function of the elevation alone. At 6 degrees the
// whole disc leaves the haze no shaft. Under the fade's foot the channel must be the whole disc:
// the sky's dome meters the air's light, and as a gap in the deck left the sun near 4.7 degrees the
// two rays stepped the exposure toward the sun by half a stop per 0.02 degree, the whole disc by a
// seventh of one. Over the fade the band of haze steps less than one ray's does; in a front at 8 degrees
// the air steps up to a third more than under the whole disc, under half a level in 255.
const SHADOW_AIR_NARROW = [ 4.9, 5.6 ] as const;

// The moon's light above the air, a share of the sun's illuminance (luminance): the full moon's over
// the sun's by the two bodies' apparent magnitudes at their mean distances (the full moon's -12.7,
// the sun's -26.7), 10^( -0.4 ( m_moon - m_sun ) ), about 2.5e-6 or 18.6 stops under the sun, times
// the debug gain (`moonKeyGain`, 1). The sky, the haze and the clouds take it and lose it along their
// own paths through the air, as they do the sun's; the key takes it through the air toward the moon
// (Atmosphere `transmittanceToMoon`), as the sun's key does the sun's.
const MOON_MAGNITUDE = - 12.7, SUN_MAGNITUDE = - 26.7;
const MOON_OVER_SUN = Math.pow( 10, - 0.4 * ( MOON_MAGNITUDE - SUN_MAGNITUDE ) );
const moonAboveAir = () => MOON_OVER_SUN * moonKeyGain();
// a gain on the moon's light above the air (`moonAboveAir`), so on both of its paths: the key
// (keyColor: the land, the sea's glitter, the haze's scatter of the key) and the sky, the clouds
// and the haze. A debug knob, not the look's: 1 is the physical full moon, and so it stays.
const moonKeyGain = tune( 'lighting.moon.gain', 1, { min: 0.05, max: 4, scale: 'log' } );
const _moonKey = new THREE.Color();
const _moonHue = new THREE.Color();
const _cloudMoon = new THREE.Color();

export class Sky {

	renderer: THREE.WebGPURenderer;
	atmosphere: Atmosphere;
	clouds: Clouds;
	night = new NightSky();
	lightning = new Lightning();
	sunIlluminance: number;
	// the moon's key light (MOON_KEY) at its share
	private readonly moonKeyColor = new THREE.Color();
	elevation: number;
	azimuth: number;
	// whether the sun climbs, from where `sunDir` stands on its path (DayCycle.ts `sunRising`): what
	// tells the morning's keys from the evening's at one height
	rising = false;
	// the weather's day sky as `track` last took it (Weather.ts `daySkyAt`), for the bake's sea
	private daySky = 1;
	// the sun's light the sky lends without the weather's day sky (`skyGain` at a day sky of 1): the
	// beam the air under the sky scatters (weather/VolumetricHaze.ts `mieColour`), which the day sky
	// leaves as it leaves the land's key, since it lowers the sky's own light the sun gives, not the
	// sun's light through the air below it; `atmosphere.sunIlluminance` where the day sky is 1. Under
	// overcast's closed deck, on its share, the beam fades as the land's key does, by the setting
	// disk's visible share (Atmosphere `sunVisibleShareToSun`), and is gone with it a degree under the
	// horizon: the air under the deck and the land take the same sunlight through it. The sky's own
	// twilight beam outlasted the key there, and the air under the deck's floor (`deckKeyFloor`) went
	// on scattering it after the land's key had set: at -1 degree a pink veil over the whole island,
	// the display 3.4 stops brighter. The other skies keep the twilight's beam (their air is lit
	// from above the clouds' gaps, which the earth's shadow in the haze's rows already holds).
	readonly sunBeamIlluminance = new THREE.Color();
	// the moon's beam the air scatters (weather/VolumetricHaze.ts `mieColour`), the sun's form
	// (`sunBeamIlluminance`) on the moon's light: the sky's gain at the moon's height with a day sky
	// of 1, at the moonlit sky's hue
	readonly moonBeamIlluminance = new THREE.Color();
	// the moon's height (degrees, the snapshot's `moonElevation`), its share of the key (`moonGain`)
	// and of the moonlit sky (`moonSkyShare`), its light above the air (scene units, `moonAboveAir`)
	// and the weather's day sky at its height, as `track` last took them: what takes the moon's light
	// as it takes the sun's reads them (lighting/AmbientRelight.ts, AmbientGrade.ts, `trackClouds`)
	moonElevation = 20;
	moonKeyShare = 0;
	moonSkyShare = 0;
	moonAbove = 0;
	// the moon's key's luminance at normal incidence before its share: `moonAbove` through the air
	// toward the moon
	private moonKeyLevel = 0;
	private daySkyMoon = 1;
	// A shared artistic solar tint affects both scattering and direct light.
	sunTint = new THREE.Color( 1.0, 0.97, 0.9 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	// the key's direction: the sun's by day, by night the moon's where it is drawn, turning between
	// them over the handoff (`track`)
	keyDir = new THREE.Vector3();
	keyColor = new THREE.Color();
	// Whether the key is the moon (its light has come in: DayCycle `moonKeyGain`), which the
	// surfaces take from one fixed direction all night (lighting/KeyLift.ts).
	keyIsMoon = false;
	// The key light's colour before cloud and weather attenuation: what lights the cloud tops.
	keyColorAboveClouds = new THREE.Color();
	// The moon's share of the key before cloud and weather attenuation (the island's moonlight, at
	// its level and hue), which a low deck's column passes down to its base (trackClouds).
	private readonly moonKeyAbove = new THREE.Color();
	// The viewer the cloud map is computed for; clouds are far, so only small moves matter.
	viewer = new THREE.Vector3( 0, 15, 0 );
	private viewCamera: THREE.PerspectiveCamera | null = null;
	private viewWidth = 1;
	private viewHeight = 1;
	private cloudTime = 0;
	solarIlluminance = new THREE.Color();
	readonly grade = { exposure: DAY_EXPOSURE, daylight: 1, night: 0, exposureNight: 0 };
	readonly weather: DisplayedWeather = { haze: 0, rain: 0, fog: 0, windSpeed: 3.8, windDirection: 40 };
	// E / PI over the upper hemisphere, cross-faded between the bakes as the irradiance probe is:
	// each bake's own, read back (an explicit bake's before it shows, a periodic one's a frame or
	// two after its panoramas, while its environment is still being filtered: `readIrradiance`).
	skyIrradiance = new THREE.Color();
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	readonly irradianceNode: V3;
	// log2 of the sky's geometric-mean luminance L_geo (scene units): exp( mean ln Y ) over the upper
	// hemisphere of the probe's panorama by solid angle, reduced with the irradiance once per bake and
	// cross-faded with it. The dome's metering illuminance and the exposure's sky term (shared.ts
	// `skyMeterLog2`).
	readonly meterLog2Node: THREE.Node<'float'>;
	// The irradiance probe as lent to the island after sunset (ISLAND_SKY): the islanders' sky fill.
	readonly islandIrradianceNode: V3;
	// The cloudless sky's irradiance over pi (the clear sky the atmosphere gives, with the night's
	// moonlit sky, under no clouds and none of the weather's dimming), baked and cross-faded with
	// irradianceNode: the haze's sky light, which the weather scales instead (weather/HazeKeys.ts).
	readonly clearIrradianceNode: V3;
	// The sky's irradiance over pi with its clouds but without the haze over it (the clear sky in the
	// gaps times their transmittance, plus the clouds' own light, at the weather's ambient gain),
	// baked and cross-faded with irradianceNode: under a deck, the deck's mean base radiance, which
	// lights the air under it (VolumetricHaze.ts `scatterToward`). `bakeDeckIrradianceNode` is the
	// bake's own, for the haze the bake lays over its panoramas (VolumetricHaze.ts `openSky`).
	readonly deckIrradianceNode: V3;
	readonly bakeDeckIrradianceNode: V3;
	busy = false;
	/** Called after each bake renders the environment's source panorama (the island-lit
	 * radiance without the sun's disk), with the atlases it will be filtered into: both on a first
	 * bake, the one not shown on a bake that refreshes the environment, none otherwise. An atlas
	 * written is at weight 0 in the cross-fade until the bake publishes. For the ambient light's
	 * relight (lighting/AmbientRelight.ts), which keeps its own copy of each atlas's sky. `read`
	 * takes the source's texels to scene units (its store's power of two and the debug press
	 * divided out). */
	onEnvironmentSource: ( ( source: THREE.Texture, atlases: readonly number[], read: number ) => void ) | null = null;
	/** Called when a bake publishes, when `environmentRead` may have changed: the environment's
	 * intensity takes it in the same frame as the displayed environment it reads. */
	onEnvironmentStore: ( () => void ) | null = null;
	/** The power of two the environment's source is stored at, as its latest bake wrote it (for the
	 * tools that read the source's texels). */
	sourceStops = 0;
	/** The powers of two the bakes' cloud layer and the panoramas (with the environment's source)
	 * are stored at, set with the dome's by the clouds' light and the weather's skies
	 * (trackClouds). */
	layerStops = 18;
	panoramaStops = 18;

	private endpoints = [ makeEndpoint(), makeEndpoint() ];
	// The environment's PMREM atlases: the one shown (environmentFront) and the next one.
	private environments: [ THREE.RenderTarget | null, THREE.RenderTarget | null ] = [ null, null ];
	private environmentFront = 0;
	// The atlases the displayed environment cross-fades from and to (by `blend`), as published.
	private environmentPair: [ number, number ] = [ 0, 0 ];
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
	private weatherState: WeatherState | null = null;
	private pendingUpdate: Promise<void> | null = null;
	// The warm-up's compiles (`warm`), which every bake waits for; a failed warm-up resolves here
	// too (its caller reports it), so bakes still run.
	private warmed: Promise<void> = Promise.resolve();
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
	private clearIrradianceQuad: THREE.QuadMesh;
	private clearIrradianceBlendQuad: THREE.QuadMesh;
	private clearIrradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private clearIrradianceA: THREE.TextureNode;
	private clearIrradianceB: THREE.TextureNode;
	private deckIrradianceQuad: THREE.QuadMesh;
	private deckIrradianceBlendQuad: THREE.QuadMesh;
	private deckIrradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private deckIrradianceA: THREE.TextureNode;
	private deckIrradianceB: THREE.TextureNode;
	private bakeDeckIrradiance: THREE.TextureNode;
	private bakeVersion = 0;
	// periodic bakes whose irradiance readback is still in flight (`readIrradiance`; `readbacks`)
	private irradiancePending = 0;
	private displaySunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	private displaySolarIlluminance = uniform( new THREE.Color( 0, 0, 0 ) );
	// Live clear-sky terms for the dome; the bake keeps its own copies below.
	private displayNightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	private displayAmbientGain = uniform( 1 );
	// the clear day's sky gain over the clouded sky's, which the open sky behind the clouds takes
	// (CLEAR_SKY, `gapSky`), on the sun's share of the sky at the sun's height and on the moon's at the
	// moon's; live, as the atmosphere's own uniforms are, and read by the bakes and the exposure's
	// meter (post/Metering.ts) too
	readonly gapGain = { sun: uniform( 1 ), moon: uniform( 1 ) };
	// The night sky as the dome draws it (Weather.ts `seenNight`): 2^-( the weather's stops times
	// the display's night weight ), on the moon's sky behind the clouds (`domeGapGain.moon`) and on
	// the clouds as the dome draws them (`seenDeck`), never on the bakes. Values
	// of uniforms only, 1 by day, so the day's shaders and bytes are unchanged (a multiply in the
	// shader, even by 1, moved day pixels by a level through fused multiply-adds). The far sea
	// takes it as it meets the sky (shared.ts `seenNight`, Water.ts `SEEN_SKY`), the far air on
	// the moon's sky and deck light it scatters (VolumetricHaze.ts `SEEN_AIR`), and the exposure's
	// meter divides it out of the sky's pixels (post/Metering.ts).
	private domeGapGain = { sun: this.gapGain.sun, moon: uniform( 1 ) };
	// the key's floor under cloud and the weather's cast shadow on the island (KEY_THROUGH_CLOUD,
	// Weather.ts `castShadow`)
	// (the sea's floor too: `seaKeyFloor`)
	private keyCloudFloor = uniform( 0 );
	readonly castShadow = uniform( 1 );
	private cloudLayer: THREE.TextureNode;
	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	// the bake of the environment's source, which lights the land: its haze without the fog layer
	// (`fogEnvironment`)
	private landQuad: THREE.QuadMesh;
	private reflectionSource: THREE.RenderTarget;
	private upperQuad: THREE.QuadMesh;
	// the distant sea's body as the bake takes it (SEA_KNEE, `seaNode`): the colour times the sun's
	// illuminance, the night's share, the sun's direct light on the level water (E / pi, luminance) and
	// the knee; and the latest bake's radiance, read back (`seaRadiance`), with that bake's version
	private seaBody = uniform( new THREE.Color() );
	private seaNight = uniform( new THREE.Color() );
	private seaSun = uniform( 0 );
	private seaKnee = uniform( 1 );
	private seaLight = new THREE.Color();
	private seaVersion = 0;
	private ambientGain = uniform( 1 );
	private irradiancePass = uniform( 0 );
	// the bake's store toward its target (its power of two, under the debug press PreExposure.ts
	// `storePress`; 1 for the irradiance probe's panorama)
	private bakeStore = uniform( 1 );
	// the bake's cloud layer's store and its inverse, set together for the bake that writes and
	// reads it (see the stores above)
	private layerStore = uniform( 1 );
	private layerRead = uniform( 1 );
	// the inverse stores of the seen panoramas' two sides (`samplePanorama`), set with their
	// textures (publishBake)
	private panoramaReadA = uniform( 1 );
	private panoramaReadB = uniform( 1 );
	// The powers of two of the environment's two atlases, as filtered from the source, and the
	// displayed environment's gain on its first atlas, which takes it to the second's store
	// (publishBake: the displayed environment is stored at the second's power, `environmentRead`).
	private environmentStops: [ number, number ] = [ 0, 0 ];
	private environmentGainA = uniform( 1 );
	private environmentReadValue = 1;
	// The light the sky lends the island for this frame's sun (ISLAND_SKY: the tint and its amount,
	// the gain), and the bake's copies: the island's for the environment's source, neutral for the
	// other panoramas.
	private islandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private islandGain = uniform( 1 );
	private bakeIslandTint = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	private bakeIslandGain = uniform( 1 );
	// 1 while the bake draws the environment's source or the probe's panorama, which take the haze
	// all round (`fogEnvironment`; the source without the fog layer); the seen panorama takes it
	// above the horizon only, as the dome fogs what it shows of it under the horizon itself
	private bakeHaze = uniform( 0 );
	// 1 while the bake draws the seen panorama, which draws the closed deck's glow whole as the dome
	// does (`deckGlow`, about the sun and about the moon), so the sea reflects it; 0 while it draws
	// the environment's source and the probe's panorama, which take the glow about the sun alone
	// (`glowToward`), so the land is lit from the sun's side of the deck as the deck is seen brighter
	// there, and the moon's glow lights nothing
	readonly bakeGlow = uniform( 0 );
	// 1 while the bake draws the seen panorama, which takes the air's floor of the key under the
	// deck (VolumetricHaze.ts `keyFloor`) as the dome's air does, so the sea reflects it; the
	// lighting's sources do not
	readonly bakeKeyFloor = uniform( 0 );
	// how far the deck takes its day's form (Weather.ts `overcastDeckLight` at the sun's height:
	// exactly 1 from the horizon up, exactly 0 from -6 degrees down, smooth between), so the drawn
	// deck's level, its gradation and its glow's form, and the glow the lighting's sources take
	// (`glowToward`), turn into the night's over the civil twilight rather than in the frame the
	// disk's light leaves
	private deckDay = uniform( 0 );
	// the night's gain on the clouds as the dome draws them (Weather.ts `seenNight`), 1 by day
	private seenDeck = uniform( 1 );
	private keyFloorUnderDeck = 0;

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = SUN_ILLUMINANCE, elevation = 32, azimuth = - 8 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.atmosphere = new Atmosphere( renderer );
		this.equirect = this.endpoints[ 0 ].equirect;
		this.clouds = new Clouds( this.atmosphere );
		setKeyCloud( ( position ) => this.clouds.shadow( position ), this.keyCloudFloor );
		this.cloudLayer = texture( this.endpoints[ 0 ].clouds.texture );
		// No panorama holds the stars: the dome and the water draw them themselves, and the light the
		// sky lends takes none.
		this.reflectionSource = this.equirect.clone();
		this.reflectionSource.texture.name = 'skyLitEnvironment';
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
		const irradiance = textureLoad( texture( this.irradianceDisplay.texture ), ivec2( 0 ) );
		this.irradianceNode = irradiance.rgb;
		this.meterLog2Node = irradiance.a;
		this.islandIrradianceNode = lendIsland( this.irradianceNode, this.islandTint, this.islandGain );
		this.clearIrradianceA = texture( this.endpoints[ 0 ].clearIrradianceMap.texture );
		this.clearIrradianceB = texture( this.endpoints[ 1 ].clearIrradianceMap.texture );
		const clearBlendMat = new THREE.NodeMaterial();
		clearBlendMat.depthTest = false;
		clearBlendMat.depthWrite = false;
		clearBlendMat.toneMapped = false;
		clearBlendMat.fragmentNode = mix( textureLoad( this.clearIrradianceA, ivec2( 0 ) ),
			textureLoad( this.clearIrradianceB, ivec2( 0 ) ), this.blend );
		this.clearIrradianceBlendQuad = new THREE.QuadMesh( clearBlendMat );
		this.clearIrradianceNode = textureLoad( texture( this.clearIrradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		this.deckIrradianceA = texture( this.endpoints[ 0 ].deckIrradianceMap.texture );
		this.deckIrradianceB = texture( this.endpoints[ 1 ].deckIrradianceMap.texture );
		const deckBlendMat = new THREE.NodeMaterial();
		deckBlendMat.depthTest = false;
		deckBlendMat.depthWrite = false;
		deckBlendMat.toneMapped = false;
		deckBlendMat.fragmentNode = mix( textureLoad( this.deckIrradianceA, ivec2( 0 ) ),
			textureLoad( this.deckIrradianceB, ivec2( 0 ) ), this.blend );
		this.deckIrradianceBlendQuad = new THREE.QuadMesh( deckBlendMat );
		this.deckIrradianceNode = textureLoad( texture( this.deckIrradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		this.bakeDeckIrradiance = texture( this.endpoints[ 0 ].deckIrradianceMap.texture );
		this.bakeDeckIrradianceNode = textureLoad( this.bakeDeckIrradiance, ivec2( 0 ) ).rgb;
		const irradianceMat = new THREE.NodeMaterial();
		irradianceMat.depthTest = false;
		irradianceMat.depthWrite = false;
		irradianceMat.toneMapped = false;
		const smallTexture = texture( this.small.texture );
		irradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			const logSum = float( 0 ).toVar(), area = float( 0 ).toVar();
			// The panorama stores sin(latitude) in alpha. Integrate the same cosine-weighted
			// upper hemisphere as the CPU probe, without an orientation-dependent row shortcut.
			Loop( this.small.width * this.small.height, ( { i } ) => {

				const pixel = textureLoad( smallTexture, ivec2( i.mod( this.small.width ), i.div( this.small.width ) ) ).toVar();
				const mu = max( pixel.a, 0 ).toVar();
				const cell = sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) ).toVar();
				const weight = mu.mul( cell ).mul( 2 * Math.PI / ( this.small.width * this.small.height ) );
				sum.addAssign( pixel.rgb.mul( weight ) );
				// the geometric mean's log luminance, by solid angle (a texel's is cos(latitude)),
				// over the upper hemisphere only
				const open = select( pixel.a.greaterThan( 0 ), cell, float( 0 ) );
				logSum.addAssign( log2( max( dot( pixel.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ), METER_FLOOR ) ).mul( open ) );
				area.addAssign( open );

			} );
			// (alpha: log2 of the sky's geometric-mean luminance, so the endpoints' cross-fade blends
			// it geometrically: `meterLog2Node`)
			return vec4( sum, logSum.div( max( area, 1e-6 ) ) );

		} )();
		this.irradianceQuad = new THREE.QuadMesh( irradianceMat );
		// The cloudless sky's irradiance: the clear sky integrated over the upper hemisphere directly
		// (32 x 16 directions, cosine-weighted, the same E / pi as the probe's), once per bake.
		const clearIrradianceMat = new THREE.NodeMaterial();
		clearIrradianceMat.depthTest = false;
		clearIrradianceMat.depthWrite = false;
		clearIrradianceMat.toneMapped = false;
		clearIrradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			Loop( 32 * 16, ( { i } ) => {

				const lon = float( i.mod( 32 ) ).add( 0.5 ).mul( 2 * Math.PI / 32 ).toVar();
				const lat = float( i.div( 32 ) ).add( 0.5 ).mul( 0.5 * Math.PI / 16 ).toVar();
				const d = vec3( cos( lat ).mul( cos( lon ) ), sin( lat ), cos( lat ).mul( sin( lon ) ) ).toVar();
				const radiance = this.clearSky( d );
				// L cos(theta) d(omega) / pi, d(omega) = cos(lat) d(lat) d(lon)
				sum.addAssign( radiance.mul( sin( lat ).mul( cos( lat ) ) ).mul( ( 0.5 * Math.PI / 16 ) * ( 2 * Math.PI / 32 ) / Math.PI ) );

			} );
			return vec4( sum, 1 );

		} )();
		this.clearIrradianceQuad = new THREE.QuadMesh( clearIrradianceMat );
		// The sky's irradiance with its clouds and without the haze over it, over the same directions:
		// the cloud layer composed over the clear sky as the bake composes it (`bakeColour`), at the
		// weather's ambient gain, once per bake, before the panoramas (whose haze reads it).
		const deckIrradianceMat = new THREE.NodeMaterial();
		deckIrradianceMat.depthTest = false;
		deckIrradianceMat.depthWrite = false;
		deckIrradianceMat.toneMapped = false;
		deckIrradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			Loop( 32 * 16, ( { i } ) => {

				const lon = float( i.mod( 32 ) ).add( 0.5 ).mul( 2 * Math.PI / 32 ).toVar();
				const lat = float( i.div( 32 ) ).add( 0.5 ).mul( 0.5 * Math.PI / 16 ).toVar();
				const d = vec3( cos( lat ).mul( cos( lon ) ), sin( lat ), cos( lat ).mul( sin( lon ) ) ).toVar();
				const q = dirToEquirect( d ).toVar();
				const cloud = this.layerAt( vec2( q.x, q.y.sub( 0.5 ).mul( 2 ) ) ).toVar();
				const radiance = this.gapSky( d ).mul( cloud.a ).add( cloud.rgb );
				sum.addAssign( radiance.mul( sin( lat ).mul( cos( lat ) ) ).mul( ( 0.5 * Math.PI / 16 ) * ( 2 * Math.PI / 32 ) / Math.PI ) );

			} );
			return vec4( sum.mul( this.ambientGain ), 1 );

		} )();
		this.deckIrradianceQuad = new THREE.QuadMesh( deckIrradianceMat );
		this.pmrem = new THREE.PMREMGenerator( renderer );

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
			// (stored at the bake's power of two, held at STORE_CEILING)
			return vec4( min( sum.rgb.mul( 0.25 ).mul( this.layerStore ), vec3( STORE_CEILING ) ), sum.a.mul( 0.25 ) );

		} )();
		this.upperQuad = new THREE.QuadMesh( upperMat );

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = this.bakeColour();
		this.quad = new THREE.QuadMesh( bake );
		const landBake = new THREE.NodeMaterial();
		landBake.fragmentNode = this.bakeColour();
		this.landQuad = new THREE.QuadMesh( landBake );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = this.domeColour();
		// The exposure's metering illuminance on the sky's pixels (Motion.ts `meterOutput`): the sky's
		// geometric-mean luminance times METER_SKY, one value for the whole dome, so the meter reads a
		// sky-filled view by the sky's overall brightness and not by the sun's surroundings.
		const meter = exp2( this.meterLog2Node ).mul( METER_SKY );
		domeMat.mrtNode = meterOutput( meter );
		if ( FSR3 ) {

			// Under fsr3 the dome draws jittered like the rest of the scene, with its motion: FSR takes
			// every input pixel as a sample at its jittered position and reads the sky's motion from the
			// velocity alone. The dome follows the camera's position (onBeforeRender), so its previous
			// world matrix cancels the camera's translation and the motion is the view's rotation, the
			// sky's own.
			domeMat.mrtNode = meterOutput( meter, motionNode( 'sky' ) );

		} else if ( TEMPORAL ) {

			// Under the temporal modes the scene half renders jittered (Jitter.ts), but the dome does
			// not: each pixel keeps the direction it shows without the jitter, so a pure-sky pixel is
			// what an unjittered frame shows, and the clouds, which accumulate in their own history
			// (Clouds' view), are not accumulated a second time by the resolve. The projection is
			// three's own clip position (`cameraProjectionMatrix` times `positionView`) with the
			// unjittered matrix. Its velocity is written explicitly, no motion and class sky: the
			// resolve derives the sky's motion from the view's rotation, and the scene MRT would
			// otherwise overwrite the cleared value with an opaque surface's.
			domeMat.vertexNode = jitter.uniforms.unjitteredProjection.mul( positionView );
			domeMat.mrtNode = meterOutput( meter, vec4( 0, 0, MOTION_CLASS.sky, 0 ) );

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

	/** The distant sea's body as the bake lights it (SEA_KNEE): the light that reaches the sea, the
	 * deck irradiance of this bake (drawn before its panoramas) and the sun's on the level water, over
	 * the knee and at most 1, times the colour; `landSea` is its CPU twin. At the knee and above it is
	 * `seaBody` itself, bit for bit. */
	private seaNode(): V3 {

		const light = dot( this.bakeDeckIrradianceNode, vec3( 0.2126, 0.7152, 0.0722 ) ).add( this.seaSun );
		return this.seaBody.mul( min( light.div( this.seaKnee ), 1 ) ).add( this.seaNight );

	}

	/** The environment's source toward each texel of the panorama: the sky over the island, its
	 * clouds and their reflection in the distant sea, seen through `haze` when given (see
	 * `fogEnvironment`). */
	private bakeColour( haze?: SkyHaze ): V4 {

		return Fn( () => {

			const q = uv();
			const d = equirectToDir( q ).toVar();
			const cloud = this.layerAt( vec2( q.x, abs( q.y.sub( 0.5 ) ).mul( 2 ) ) ).toVar();
			const up = vec3( d.x, abs( d.y ), d.z );
			// (the environment's source takes the light lent to the island: ISLAND_SKY; the haze as the
			// dome lays it, from the sea's level: see `fogEnvironment`)
			const clear = this.gapSky( up ).toVar();
			// the closed deck's glow over the clouds, whole in the seen panorama, about the sun alone in
			// the lighting's sources (`bakeGlow`); its deck level without the weather's gain, which the
			// source takes below.
			const bakeDeck = this.bakeDeckIrradianceNode.div( max( this.ambientGain, 1e-6 ) ).toVar();
			const pattern = deckPattern( up, cloud.rgb, bakeDeck, this.clouds.deckFlat ).toVar();
			const glow = this.glowToward( up, bakeDeck, cloud.a, pattern ).mul( this.bakeGlow );
			const sunGlow = this.glowToward( up, bakeDeck, cloud.a, pattern, true ).mul( float( 1 ).sub( this.bakeGlow ) );
			const lit = cloud.rgb.add( sunGlow.add( glow ) ).toVar();
			const air = clear.mul( cloud.a ).add( lit ).toVar();
			let fogged: V3 = air;
			if ( haze ) {

				// the clear sky through the haze along the whole way, the clouds through it out to the
				// shell's middle height (from the sea: the distance to that sphere, as the dome takes it),
				// under the low deck's share to a little above its base instead, where a deck's light comes
				// from (the dome takes the march's own depth there, which the panorama does not keep)
				const sky = haze( up );
				const middle = mix( this.clouds.shellBottom.add( this.clouds.shellThickness.mul( 0.5 ) ), this.clouds.shellBottom.add( DECK_LIGHT_HEIGHT ), this.clouds.lowShare ).toVar();
				const inside = middle.mul( middle.add( EARTH_RADIUS * 2 ) ), b = up.y.mul( EARTH_RADIUS );
				const cloudHaze = haze( up, inside.div( sqrt( b.mul( b ).add( inside ) ).add( b ) ) );
				const seen = sky.light.add( sky.transmittance.mul( clear ) ).mul( cloud.a )
					.add( cloudHaze.light.mul( float( 1 ).sub( cloud.a ) ) ).add( cloudHaze.transmittance.mul( lit ) );
				// (the seen panorama only above the horizon, where the water reads it: what the sea
				// reflects is the sky the dome draws, and under cloud the haze's light is nearly all of
				// that; below the horizon the dome fogs it itself)
				fogged = mix( air, seen, max( this.bakeHaze, step( 0, d.y ) ) );

			}
			const sky = lendIsland( fogged.mul( this.ambientGain ), this.bakeIslandTint, this.bakeIslandGain );
			// (no stars: starlight is a few hundredths of the moonlit sky's light on level ground, and the
			// sky the eye sees draws them itself)
			const radiance = seaPanorama( d, sky, this.seaNode() );
			return vec4( min( radiance.mul( this.bakeStore ), vec3( STORE_CEILING ) ), mix( cloud.a, d.y, this.irradiancePass ) );

		} )();

	}

	/** Lays the haze over the panoramas toward every direction from one height (VolumetricHaze.ts
	 * `openSky`): `haze` over the irradiance probe's panorama and the seen panorama above the
	 * horizon, as the dome lays it on itself (`fogDome`), so the sky's metering, the water's sky
	 * light and the sea's reflection take the light the haze scatters, its fog layer's droplets
	 * included, as the sky the eye sees does; `landHaze` over the environment's source, which lights
	 * the land (the relit ambient's harmonics, the specular atlas): the same haze without the fog
	 * layer, the ground layer at the air's density alone and no droplets' light. The land's key
	 * takes the atmosphere's transmittance and no loss through the fog layer, so a sky light that
	 * took the light the droplets scatter in would add it without the direct light they take out
	 * (by day under a clear sky they lifted the sky's irradiance on level ground about 2.7 times,
	 * the ambient on lit open ground about 2.3 times). The ground layer's aerosols the land still
	 * takes, and its key does not lose to them either: kept so, as the land's sky gain is set on
	 * it (AmbientRelight.ts PROBE_SKY). The land's specular so reflects a horizon without the fog
	 * layer, the sea one with it. With no fog layer (cloudy and overcast, and once the sun is a
	 * degree below the horizon, without the deep sea fog) the two are the same light; the deep sea
	 * fog (`?seaFog`) and the parked fog weather's droplets are left out of the land's light too.
	 * Called once, with `fogDome`. */
	fogEnvironment( haze: SkyHaze, landHaze: SkyHaze ): void {

		for ( const [ quad, h ] of [ [ this.quad, haze ], [ this.landQuad, landHaze ] ] as const ) {

			const material = quad.material as THREE.NodeMaterial;
			material.fragmentNode = this.bakeColour( h );
			material.needsUpdate = true;

		}

	}

	/** The dome's colour toward each pixel, seen through `haze` when given: a function of a view
	 * direction and a distance along it (the sky's own by default) that returns the light the haze
	 * adds and its transmittance (VolumetricHaze.ts `skyHaze`). The clouds are fogged at the
	 * distance to the shell's middle height, under the low deck's share at the march's depth, and
	 * under the thin layer's share of their opacity at the distance to the layer, the sky behind
	 * them along the whole way. */
	private domeColour( haze?: SkyHaze ): V4 {

		return Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			// The disc: cut where the cosine to the sun crosses the radius's, over one pixel's change
			// of that cosine (a clean edge at any size), darkened toward the limb by the quadratic law
			// (Radiometry.ts); the angle from the chord, which keeps its precision near the centre.
			const nu = dot( d, this.displaySunDir ).toVar();
			const mask = clamp( nu.sub( Math.cos( SUN_DISC_RADIUS ) ).div( max( fwidth( nu ), 1e-7 ) ), 0, 1 );
			const r = asin( clamp( length( d.sub( this.displaySunDir ) ).mul( 0.5 ), 0, 1 ) ).mul( 2 / SUN_DISC_RADIUS ).toVar();
			const m = float( 1 ).sub( sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ) ).toVar();
			const limb = float( 1 ).sub( m.mul( SUN_LIMB_U1 ) ).sub( m.mul( m ).mul( SUN_LIMB_U2 ) );
			// The integral of the visible disk is the key light's irradiance, times the displayed share
			// (lighting/SunDisc.ts SUN_DISC_RADIANCE). A shared scene unit
			// scale keeps the normalised disk finite in fp16 without dimming it independently. Its
			// colour is the air's analytic transmittance toward it (Atmosphere.ts discTransmittance).
			// The clouds hide it by their transmittance once, per pixel, in the composite below: an
			// edge crossing the disc dims it as smoothly as the march's opacity changes.
			const disk = this.atmosphere.discTransmittance( d ).mul( this.displaySolarIlluminance )
				.mul( mask ).mul( limb ).div( SUN_DISC_SOLID_ANGLE / SUN_DISC_RADIANCE ).mul( smoothstep( 0, 0.001, d.y ) );
			// Above the horizon the clear sky and the clouds are both live. Below, the baked distant-sea reflection continues the waves.
			const lower = this.samplePanorama( d, float( 0 ) ).toVar();
			const cloud = this.clouds.sampleView( d ).toVar();
			const above = d.y.greaterThanEqual( 0 ).toVar();
			const stars = this.night.stars( d ).mul( this.night.moonOcclusion( d ) );
			// What the clouds hide: the clear sky, the discs and the stars (below the horizon, the
			// reflection with its own clouds), seen through the haze along the whole way; the discs
			// take the clouds' transmittance once, here, and nowhere else.
			const behind = select( above, this.gapSky( vec3( d.x, max( d.y, 0 ), d.z ), this.domeGapGain ).mul( this.displayAmbientGain ), lower.rgb )
				.add( disk.add( this.night.moon( d ) ).add( stars ).mul( select( above, float( 1 ), lower.a ) ) );
			const through = select( above, cloud.a, float( 1 ) ).toVar();
			// the closed deck's glow over the clouds above the horizon (`deckGlow`), before the haze,
			// which hides it with the clouds by their distance
			// (the deck under the night's seen gain, `seenDeck`, after the glow's pattern)
			const pattern = deckPattern( d, cloud.rgb.mul( this.displayAmbientGain ), this.deckIrradianceNode, this.clouds.deckFlat ).toVar();
			const glow = this.glowToward( d, this.deckIrradianceNode, cloud.a, pattern ).toVar();
			const clouds = select( above, cloud.rgb.mul( this.seenDeck ).mul( this.displayAmbientGain ), vec3( 0 ) ).add( glow.mul( step( 0, d.y ) ) ).toVar();
			if ( ! haze ) return vec4( behind.mul( through ).add( clouds ), 1 );
			const sky = haze( d );
			// The clouds through the haze out to the shell's middle height: its light over their
			// opacity, their own (premultiplied) through its transmittance.
			// (from the march's own camera height, held under the base (Clouds `camY`): the depths
			// `sampleViewFog` returns are measured from there, and above the middle the root's
			// argument would turn negative)
			const middle = this.clouds.shellBottom.add( this.clouds.shellThickness.mul( 0.5 ) ).toVar();
			const camY = this.clouds.camY;
			const r0 = camY.add( EARTH_RADIUS ).toVar(), b = r0.mul( max( d.y, 0 ) ).toVar();
			// (the distance to that sphere, written without a difference of near-equal terms)
			const inside = middle.sub( camY ).mul( r0.add( middle.add( EARTH_RADIUS ) ) ).toVar();
			const mid = inside.div( sqrt( b.mul( b ).add( inside ) ).add( b ) ).toVar();
			// Under the low deck's share, out to the march's own opacity-weighted depth instead
			// (Clouds `sampleViewFog`, its `depth`): a closed deck's light comes from its lowest
			// hundred metres, and at a low deck the middle lies some 2.5 times farther, which fogged
			// the deck at 5 - 12 degrees about twice as densely as its distance does.
			const fog = this.clouds.sampleViewFog( d, mid );
			const reach = mix( mid, fog.depth, this.clouds.lowShare ).toVar();
			// The thin layer lies above the cumulus' middle (the clear and fair skies' 6.6 km
			// against its 8.5), so farther along a ray: where its fibres make the opacity, out to
			// the layer instead, so the haze between fades them toward the horizon by their own
			// distance. One distance per pixel, mixed by the layer's share of the opacity there:
			// exact where no cumulus stands in front, and where one does it hides the layer. With
			// no layer (cloudy and overcast skies) the share is none and the reach the cumulus'
			// alone.
			const thinShare = clamp( fog.thin.div( max( float( 1 ).sub( through ), 1e-4 ) ), 0, 1 );
			const streakHeight = this.clouds.streakHeight;
			const thinInside = max( streakHeight.sub( camY ).mul( r0.add( streakHeight.add( EARTH_RADIUS ) ) ), 0 ).toVar();
			const thin = thinInside.div( sqrt( b.mul( b ).add( thinInside ) ).add( b ) );
			const cloudHaze = haze( d, mix( reach, thin, thinShare ) );
			const fogged = cloudHaze.light.mul( float( 1 ).sub( through ) ).add( cloudHaze.transmittance.mul( clouds ) );
			const result = sky.light.add( sky.transmittance.mul( behind ) ).mul( through ).add( fogged ).toVar();
			if ( debugFlags.streakMask !== true ) return vec4( result, 1 );
			// (`flags=streakMask`: the thin layer's pixels where its opacity as seen passes 0.1 in a
			// red of the same luminance, those where it lies between 0.02 and 0.1 in such a green,
			// for `img.py stats --mask`)
			const luminance = dot( result, vec3( 0.2126, 0.7152, 0.0722 ) ).toVar();
			const edge = select( fog.thin.greaterThan( 0.02 ).and( above ), vec3( 0, luminance.div( 0.7152 ), 0 ), result );
			return vec4( select( fog.thin.greaterThan( 0.1 ).and( above ), vec3( luminance.div( 0.2126 ), 0, 0 ), edge ), 1 );

		} )();

	}

	/** The closed deck's glow toward `d` (`deckGlow`) over a deck of mean radiance `deck`, through
	 * clouds of transmittance `transmittance` there, following the base's local radiance over its
	 * mean `pattern` (`deckPattern`), with this frame's shares (Clouds `columnTop`); with `sunOnly`
	 * the lighting's sources' glow: about the sun alone, one smooth lobe of its own (Clouds
	 * `bakeGlowLobe`, `bakeGlowGain`), by the day's weight (`deckDay`, so exactly none by night). */
	private glowToward( d: V3, deck: V3, transmittance: F, pattern: F, sunOnly = false ): V3 {

		const top = this.clouds.columnTop();
		const c = this.clouds;
		if ( sunOnly ) {

			// the lighting's sources: one lobe of their own (`bakeGlowLobe`, `bakeGlowGain`), smooth
			// (the pattern's power 0)
			return deckGlow( d, deck, float( 1 ).sub( transmittance ), this.atmosphere.sunDir, this.atmosphere.moonDir, c.lobeTint.rgb,
				vec4( top.keyShare, 1, c.broadShare, 0 ), vec4( c.bakeGlowLobe, c.bakeGlowGain, 0, 0 ), pattern ).mul( this.deckDay );

		}

		// the day's form by `deckDay`, the moon's own by night (each exact at a weight of 1 or 0)
		const night = vec4( ...MOON_DECK_GLOW );
		const day = vec4( c.deckGlowLobe, c.deckGlow, c.deckGlowBroadLobe, c.deckGlowBroad );
		const form = night.mul( float( 1 ).sub( this.deckDay ) ).add( day.mul( this.deckDay ) );
		// the pattern's power: away from the sun the closed deck's by day (`deckGlowFar`, from
		// `deckGlowFrom` to `deckGlowTo` degrees), by overcast's share and the day's weight; the
		// moon's and the broken skies' DECK_GLOW_TEXTURE (exact at a weight of 0)
		const away = smoothstep( c.deckGlowFrom, c.deckGlowTo, acos( clamp( dot( d, this.atmosphere.sunDir ), - 1, 1 ) ).mul( 180 / Math.PI ) );
		const k = mix( c.deckGlowTexture, mix( c.deckGlowTexture, c.deckGlowFar, away ), c.overcastShare.mul( this.deckDay ) );
		return deckGlow( d, deck, float( 1 ).sub( transmittance ), this.atmosphere.sunDir, this.atmosphere.moonDir, c.lobeTint.rgb,
			vec4( top.keyShare, top.sunShare, c.broadShare, k ), form, pattern );

	}

	/** The mean cloud transmittance over the sun's disc (r) and over the moon's (g): DISC_SAMPLES
	 * directions spread over each disc (a Vogel spiral, uniform by area) read from the clouds'
	 * panorama, for the sky's constants texel (Pipeline.ts `skyConstants`), which the sun's flare and
	 * the light shafts read; the dome's discs do not. One ray would switch the flare on and off as a
	 * cloud's edge crosses the disc. */
	discCloudTransmittance(): V4 {

		const mean = ( centre: V3, radius: number ) => {

			const tangent = normalize( select( abs( centre.y ).greaterThan( 0.99 ), vec3( 1, 0, 0 ), vec3( centre.z, 0, centre.x.negate() ) ) ).toVar();
			const bitangent = cross( centre, tangent ).toVar();
			const sum = float( 0 ).toVar();
			Loop( DISC_SAMPLES, ( { i } ) => {

				const r = sqrt( float( i ).add( 0.5 ).div( DISC_SAMPLES ) ).mul( radius );
				const a = float( i ).mul( 2.399963 );
				sum.addAssign( this.clouds.sample( normalize( centre.add( tangent.mul( cos( a ).mul( r ) ) ).add( bitangent.mul( sin( a ).mul( r ) ) ) ) ).a );

			} );
			return sum.div( DISC_SAMPLES );

		};
		return Fn( () => vec4( mean( this.displaySunDir, SUN_DISC_RADIUS ), mean( this.night.moonDir, MOON_ANGULAR_RADIUS ), 0, 1 ) )();

	}

	/** Lays the haze over the dome (VolumetricHaze.ts `skyHaze`: see `domeColour`). The sky fogs
	 * itself, so the haze's composite leaves the sky's pixels as they are. Called once, before the
	 * dome first draws. */
	fogDome( haze: SkyHaze ): void {

		const material = this.dome.material as THREE.MeshBasicNodeMaterial;
		material.colorNode = this.domeColour( haze );
		material.needsUpdate = true;

	}

	/** Periodic bakes whose irradiance is still being read back: a paused page that starts one draws
	 * frames while it is in flight, so the settled signal waits for it, and a stepped clip waits until
	 * none is (app/Frame.ts `settleFrame`, `loop.step`). */
	get readbacks(): number { return this.irradiancePending; }

	get transitioning(): boolean { return this.transitionDuration > 0 && this.transitionElapsed < this.transitionDuration; }
	get moonDir(): THREE.Vector3 { return this.night.moonDir.value; }
	/** The floor of the key's visibility the air under a closed deck keeps (VolumetricHaze.ts
	 * `keyFloor`), this frame's: the land's floor (KEY_THROUGH_CLOUD) by overcast's share. It follows
	 * the key by day, at dusk and by night, so the air toward the sun or the moon keeps the light
	 * the deck passes down in place of the key it hides; 0 under clear, fair and cloudy skies, whose
	 * air takes the clouds' own shadow. */
	get deckKeyFloor(): number { return this.keyFloorUnderDeck; }
	/** The sea's floor of the key's visibility (`seaKeyVisibility`), a node: the land's
	 * (`keyCloudFloor`), the cumulus' floor and the deck's, so the sea takes the land's key. */
	get seaKeyFloor(): F { return this.keyCloudFloor; }
	/** The distant sea's body radiance, the environment's lower half, as the latest bake lit it (read
	 * back with its deck irradiance: `landSea`). */
	get seaRadiance(): THREE.Color { return this.seaLight; }

	/** What the displayed environment's texels take to scene units, for the environment's
	 * intensity (its store's power of two and the debug press divided out; `onEnvironmentStore`). */
	get environmentRead(): number { return this.environmentReadValue; }

	get environmentNode(): V3 {

		if ( ! this.environment ) throw new Error( 'The sky environment is available after the initial update' );
		return this.environment;

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
	 * while the world generates). Bakes wait for it: a draw whose pipeline it is still creating would
	 * be skipped (see the header). The returned promise rejects if a compile fails, for the caller
	 * to report (main.ts awaits it before the loop); the bakes waiting on it go ahead. */
	warm( r: THREE.WebGPURenderer = this.renderer ): Promise<void> {

		const compiled = this.compileAhead( r );
		this.warmed = compiled.catch( () => undefined );
		return compiled;

	}

	private async compileAhead( r: THREE.WebGPURenderer ): Promise<void> {

		await r.init();
		await this.clouds.warm( r );
		// A pipeline depends on the target it draws into: compile each quad for its own.
		const e = this.endpoints[ 0 ];
		const pairs: [ THREE.QuadMesh, THREE.RenderTarget ][] = [
			[ this.upperQuad, e.clouds ], [ this.quad, e.equirect ], [ this.quad, this.small ],
			[ this.irradianceQuad, e.irradianceMap ], [ this.irradianceBlendQuad, this.irradianceDisplay ],
			[ this.clearIrradianceQuad, e.clearIrradianceMap ], [ this.clearIrradianceBlendQuad, this.clearIrradianceDisplay ],
			[ this.deckIrradianceQuad, e.deckIrradianceMap ], [ this.deckIrradianceBlendQuad, this.deckIrradianceDisplay ],
			[ this.landQuad, this.reflectionSource ],
		];
		if ( this.environmentBlendQuad && this.envMap ) pairs.push( [ this.environmentBlendQuad, this.envMap ] );
		const compiling = pairs.map( ( [ quad, target ] ) => compileInto( r, quad, quad.camera, target ) );
		compiling.push( this.pmrem.compileEquirectangularShader() );
		await Promise.all( compiling );

	}

	/** Back to the state before the first bake, so the next `update` bakes as a page's first does: both
	 * endpoints and both environment atlases from one bake, shown without a blend (no trace of the
	 * bakes before), and the clouds with no view yet and the viewer at its start (Clouds.restart),
	 * set to the scene clock `time` and the wind's heading `windDirection` as the frames set them
	 * (`followClock`). Every explicit bake starts from it (RenderStages.ts `bakeEnvironment`): a paused page
	 * keeps its last explicit bake's products, so the load, a scene jump, a seek and a retune must
	 * make the same ones from the same state, whatever the frames or the bakes before left behind;
	 * the clouds' drift, evolution and axes are the clock's, so the bake sees the clouds the frame
	 * shows (taken at their constructed state instead, the load's bake of an afternoon's deck read
	 * its sky light about half a stop above a bake of the same scene after a frame). Call it with no
	 * bake in flight. */
	reset( windDirection: THREE.Vector2, time: number ): void {

		if ( this.busy ) throw new Error( 'Sky.reset: a bake is in flight' );
		// a periodic readback still in flight from before the jump lands nowhere (`readIrradiance`)
		for ( const state of this.endpoints ) state.version = ++ this.bakeVersion;
		this.initialized = false;
		this.front = 0;
		this.destination = 0;
		this.environmentFront = 0;
		this.environmentPair = [ 0, 0 ];
		this.bakesSinceEnvironment = 0;
		this.transitionDuration = 0;
		this.transitionElapsed = 0;
		this.blend.value = 0;
		this.viewCamera = null;
		this.viewWidth = 1;
		this.viewHeight = 1;
		this.cloudTime = 0;
		this.clockStill = false;
		this.viewer.set( 0, 15, 0 );
		this.clouds.restart();
		this.followClock( windDirection, time );

	}

	// The clouds' and the night sky's state at the scene clock `time`, the wind from `windDirection`:
	// a function of the clock, set by every frame (`updateClouds`) and by `reset` for a bake.
	private followClock( windDirection: THREE.Vector2, time: number ): void {

		this.clouds.windAxis.value.copy( windDirection ).normalize();
		this.clouds.setDrift( shared.wind.displacement.value );
		// The clouds' inner structure rises through them at 2.5 m/s, as a cumulus' turrets do
		// (the rain curtains fall by the same clock).
		this.clouds.setEvolution( time );
		this.night.time.value = time;

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

	/** The sky's irradiance over pi as lent to the island (`islandIrradianceNode`) on the CPU, from
	 * `skyIrradiance`. */
	islandSkyIrradiance( target = new THREE.Color() ): THREE.Color {

		const light = this.skyIrradiance, tint = this.islandTint.value, gain = this.islandGain.value;
		const l = 0.2126 * light.r + 0.7152 * light.g + 0.0722 * light.b;
		return target.setRGB(
			( light.r + ( tint.x * l - light.r ) * tint.w ) * gain,
			( light.g + ( tint.y * l - light.g ) * tint.w ) * gain,
			( light.b + ( tint.z * l - light.b ) * tint.w ) * gain,
		);

	}

	/** Evaluate the sun, moon, key light, stars, grade and displayed weather for this frame.
	 * Everything that moves with the clock is continuous here; bakes only capture this state. */
	track( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverageOverride: number | null = null, skyMix: readonly number[] | null = null ): void {

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
		// The atmosphere's slices are cut again only when the sun or the moon has moved.
		this.atmosphere.sunDir.value.copy( this.sunDir );
		// The moon stands where the clock puts it (DayCycle.ts MOON): drawn there, lighting the sky
		// and the haze from there, as it shades the island.
		if ( celestial ) this.atmosphere.moonDir.value.copy( celestial.moonDir );
		else this.atmosphere.moonDir.value.copy( this.sunDir ).negate();
		// The moon lights the sky as the sun does: its light above the air (`moonAboveAir`) times the
		// sky's gain the sun's light takes at the moon's height (`skyGain` on the evening's keys, with
		// the weather's day sky there), at the moonlit sky's own hue (MOON_SKY_HUE) and the moonlit
		// sky's share (the snapshot's `moonKeyGain`, as the key's: at its magnitude the moon's light
		// lies under the twilight's, so it takes no window of its own, DayCycle.ts). The key takes the
		// moon's share of the key and its own gain (`moonKeyGain`).
		const cloud = skyMix ? cloudedShare( skyMix ) : 0;
		this.rising = sunRising( this.sunDir );
		const moonGain = celestial ? duskForce( 'moonKey', celestial.moonKeyGain ) : 0;
		const moonSkyShare = celestial ? duskForce( 'moonSky', celestial.moonKeyGain ) : 0;
		this.moonElevation = celestial ? celestial.moonElevation : MOON.elevation;
		this.moonKeyShare = moonGain;
		this.moonSkyShare = moonSkyShare;
		this.moonAbove = celestial ? illuminance * moonAboveAir() : 0;
		// the key: the light above the air through the air toward the moon (its luminance), at the
		// key's hue (MOON_KEY at unit luminance)
		const toMoon = this.atmosphere.transmittanceToMoon();
		this.moonKeyLevel = this.moonAbove * luminance709( toMoon.r, toMoon.g, toMoon.b );
		const moonKey = this.moonKeyLevel * moonGain / MOON_KEY_LUMINANCE;
		this.moonKeyColor.setRGB( MOON_KEY[ 0 ] * moonKey, MOON_KEY[ 1 ] * moonKey, MOON_KEY[ 2 ] * moonKey );
		// the weather's moonlit sky at the moon's height, on its own level (Weather.ts `moonSky`)
		this.daySkyMoon = weather ? daySkyAt( weather.moonSky, weather.moonSkyExponent, this.moonElevation ) : 1;
		const moonSky = moonSkyShare * this.moonAbove * luma( skyGain( this.moonElevation, false, cloud, this.daySkyMoon, _skyMoon ) );
		this.atmosphere.moonIlluminance.value.setRGB( MOON_SKY_HUE[ 0 ] * moonSky, MOON_SKY_HUE[ 1 ] * moonSky, MOON_SKY_HUE[ 2 ] * moonSky );
		// the moon's beam the air scatters, as the sun's (`sunBeamIlluminance`): the sky's gain at a
		// day sky of 1; the moon's visible share is in its sky's share already
		const moonBeam = moonSkyShare * this.moonAbove * luma( skyGain( this.moonElevation, false, cloud, 1, _skyMoon ) );
		this.moonBeamIlluminance.setRGB( MOON_SKY_HUE[ 0 ] * moonBeam, MOON_SKY_HUE[ 1 ] * moonBeam, MOON_SKY_HUE[ 2 ] * moonBeam );
		// the weather's day sky at this sun (Weather.ts `daySkyAt`), on the sun's light the sky takes
		// (`skyGain`), the clouds' sunlight (`trackClouds`) and the distant sea's (`beginBake`)
		this.daySky = weather ? daySkyAt( weather.daySky, weather.daySkyExponent, this.elevation ) : 1;
		this.atmosphere.sunIlluminance.value.copy( this.solarIlluminance ).multiply( skyGain( this.elevation, this.rising, cloud, this.daySky, _skyGain ) );
		// (on overcast's share it fades with the setting disk's visible share, as the land's key does:
		// see `sunBeamIlluminance`)
		const beamFade = 1 + ( this.atmosphere.sunVisibleShareToSun() - 1 ) * ( skyMix ? skyMix[ 3 ] ?? 0 : 0 );
		this.sunBeamIlluminance.copy( this.solarIlluminance ).multiply( skyGain( this.elevation, this.rising, cloud, 1, _skyBeam ) ).multiplyScalar( beamFade );
		// the open sky's gain behind the clouds, on each body's share of the sky: the sun's at the
		// sun's height, the moon's at the moon's, as each body's sky light takes its gain (`skyGain`)
		const off = debugFlags.skyGain === false;
		this.gapGain.sun.value = off ? 1 : clearSky( this.elevation, this.rising, 0 ) / clearSky( this.elevation, this.rising, cloud );
		this.gapGain.moon.value = off ? 1 : clearSky( this.moonElevation, false, 0 ) / clearSky( this.moonElevation, false, cloud );
		this.atmosphere.updateSync();
		// Cap the hue of the air's extinction first, then fade by the disk's visible share, so the
		// setting disk only dims the key and does not bleach it.
		const sunVisible = this.atmosphere.sunVisibleShareToSun();
		if ( sunVisible > 0 ) this.sunColor.copy( keyHue( this.atmosphere.transmittanceToSun(), this.sunTint, this.rising ) ).multiplyScalar( sunVisible * illuminance );
		else this.sunColor.setRGB( 0, 0, 0 );
		// The key turns from the sun to the moon over the handoff (DayCycle `keyDir`) and holds there
		// all night: everything that reads the key's direction (the water's glint, the refracted
		// light under the water, the clouds, the haze) then sees the moon where it is drawn. By day
		// (no handoff) the key is the sun's direction itself.
		this.keyDir.copy( celestial?.keyDir ?? this.sunDir );
		this.keyIsMoon = moonGain > 0;
		this.keyColor.copy( this.sunColor ).multiplyScalar( lowKey( this.elevation ) * duskForce( 'sun', 1 ) );
		const moonColor = this.night.moonColor.value;
		if ( celestial ) {

			// The full moon's key, some 19 stops under a high sun's, in the island's own hue: only the
			// moon's share of the key takes it, so over the handoff
			// it grows with that share, and by day (no moon) the sun's key is untouched.
			this.moonKeyAbove.copy( this.moonKeyColor ).multiply( moonHue( _moonHue ) );
			this.keyColor.add( this.moonKeyAbove );
			this.night.moonDir.value.copy( celestial.moonDir );
			this.night.frame.value.copy( celestial.starFrame );
			// (the moon's light does not follow its phase: DayCycle's header)
			this.night.moonWash.value = celestial.moonVisibility;
			// The disk sits in the upper tones at night exposure so its maria stay visible, as to the
			// eye; the moonlight on the island is the key light above, not this disk.
			moonColor.setRGB( 0.04, 0.041, 0.043 ).multiplyScalar( 0.32 * celestial.moonVisibility * this.sunIlluminance / SUN_ILLUMINANCE );
			this.grade.night = displayNight( celestial.daylight, celestial.elevation, this.rising, cloud );
			this.grade.exposureNight = exposureNight( celestial.elevation, this.rising, cloud );
			const stars = starNight( celestial.daylight, celestial.elevation, this.rising, cloud );
			this.night.starVisibility.value = duskForce( 'stars', celestial.nightVisibility * stars ) * ( 1 - 0.22 * celestial.moonVisibility );
			// the night's ambient in the clouds and the distant sea: a uniform sky's radiance that gives
			// level ground NIGHT_AMBIENT_SHARE of the moon's key on it (the key's light at normal
			// incidence, the moon's sine), by its share (DayCycle.ts `nightAmbientShare`)
			const floor = this.moonKeyLevel * Math.sin( THREE.MathUtils.degToRad( this.moonElevation ) ) * NIGHT_AMBIENT_SHARE / Math.PI
				* duskForce( 'nightAmbient', nightAmbientShare( celestial.elevation, this.rising, cloud ) );
			this.displayNightAmbient.value.setRGB( NIGHT_AMBIENT_HUE[ 0 ] * floor, NIGHT_AMBIENT_HUE[ 1 ] * floor, NIGHT_AMBIENT_HUE[ 2 ] * floor );
			this.grade.exposure = celestial.exposure;
			this.grade.daylight = celestial.daylight;
			this.islandGain.value = islandSky( celestial.elevation, this.rising, this.islandTint.value, cloud );
			const direct = weather?.directVisibility ?? 1;
			const shade = clearShade( celestial.elevation, direct ), low = lowSun( celestial.elevation, direct );
			const tint = this.islandTint.value;
			if ( shade > 0 ) {

				this.islandGain.value *= 1 + shade;
				tint.set( CLEAR_SHADE_TINT[ 0 ], CLEAR_SHADE_TINT[ 1 ], CLEAR_SHADE_TINT[ 2 ], CLEAR_SHADE_TINT[ 3 ] * shade );

			}
			if ( low > 0 ) tint.set( tint.x + ( LOW_SUN_TINT[ 0 ] - tint.x ) * low, tint.y + ( LOW_SUN_TINT[ 1 ] - tint.y ) * low,
				tint.z + ( LOW_SUN_TINT[ 2 ] - tint.z ) * low, Math.max( tint.w, LOW_SUN.amount * low ) );
			const clouded = skyMix ? cloudedHighSun( celestial.elevation, skyMix, 12 ) : 0;
			if ( clouded > 0 ) tint.set( CLOUD_LIGHT_TINT[ 0 ], CLOUD_LIGHT_TINT[ 1 ], CLOUD_LIGHT_TINT[ 2 ], CLOUD_LIGHT_TINT[ 3 ] * clouded );

		} else {

			this.night.moonDir.value.copy( this.sunDir ).negate();
			this.moonKeyAbove.setRGB( 0, 0, 0 );
			moonColor.setRGB( 0, 0, 0 );
			this.night.starVisibility.value = 0;
			this.displayNightAmbient.value.setRGB( 0, 0, 0 );
			this.grade.exposure = DAY_EXPOSURE;
			this.grade.daylight = 1;
			this.grade.night = 0;
			this.grade.exposureNight = 0;
			this.islandTint.value.set( 1, 1, 1, 0 );
			this.islandGain.value = 1;

		}
		this.keyColorAboveClouds.copy( this.keyColor );
		const coverage = coverageOverride ?? weather?.coverage ?? 0;
		const overcast = weather ? THREE.MathUtils.smoothstep( coverage, 0.65, 0.98 ) : 0;
		// the weather's sky light (its day sky is on the sun's light alone: `skyGain`, `trackClouds`)
		const ambientGain = weather?.ambientGain ?? 1;
		const directVisibility = weather?.directVisibility ?? 1;
		// The base exposure (the frame's is metered from the light: post/Exposure.ts; this one is
		// what the night sky's own light is tuned against) adapts to the dimmer diffuse daylight
		// under a closed deck, as tidewater's auto exposure would: it lifts a frame darker than its
		// metered level only partly (by the ratio's 0.8th power), 4.7 times under a closed deck; less so in
		// rain.
		this.grade.exposure *= 1 + 3.7 * overcast * this.grade.daylight * ( 1 - 0.7 * ( weather?.rain ?? 0 ) );
		// Through the blue hour a closed deck's adaptation goes on rising as the light goes (DayCycle
		// `overcastAdaptation`, none from -6 degrees down): the night under the deck takes no gain of
		// its own, being lit by the moon through the deck as the day is by the sun.
		this.grade.exposure *= 1 + overcast * ( celestial?.overcastAdaptation ?? 0 );
		// The night sky's own lights, the stars and the moon's disk (nothing they light), keep the
		// brightness they were tuned at, under the exposure the night had then, but for the night's
		// own gain (DayCycle NIGHT_EXPOSURE_GAIN), which brightens them with the island; under a deck
		// the clouds drawn over them hide them.
		const nightSkyLevel = celestial ? Math.min( 1, celestial.nightSkyLevel ) : 1;
		this.night.starVisibility.value *= nightSkyLevel;
		moonColor.multiplyScalar( nightSkyLevel );
		this.sunColor.multiplyScalar( directVisibility );
		this.keyColor.multiplyScalar( directVisibility );
		// Under a deck the sun's light is whiter than a clear day's at the same height, part of it
		// scattered in the cloud: the key keeps its luminance and moves KEY_DECK_WHITE of the way to
		// white under overcast, where the sun still shines through, and all the way under rain's
		// closed deck (a rainy evening's light is not a sunset's).
		const keyLuminance = this.keyColor.r * 0.2126 + this.keyColor.g * 0.7152 + this.keyColor.b * 0.0722;
		const rain = weather?.rain ?? 0;
		this.keyColor.lerp( _white.setScalar( keyLuminance ), overcast * ( KEY_DECK_WHITE + ( 1 - KEY_DECK_WHITE ) * rain ) );
		this.solarIlluminance.multiplyScalar( directVisibility );
		moonColor.multiplyScalar( directVisibility );
		this.night.starVisibility.value *= ambientGain;
		// the drawn moon's disk takes its phase's light (DayCycle `moonSunDir`)
		this.night.sunDir.value.copy( celestial ? celestial.moonSunDir : this.sunDir );
		this.displaySunDir.value.copy( this.sunDir );
		this.displaySolarIlluminance.value.copy( this.solarIlluminance );
		this.displayAmbientGain.value = ambientGain;
		// the key's floor under cloud (KEY_THROUGH_CLOUD), after the clouds' shell and density are set
		const overcastShare = skyMix ? skyMix[ 3 ] ?? 0 : 0;
		const keyLight = this.keyColorAboveClouds.r * 0.2126 + this.keyColorAboveClouds.g * 0.7152 + this.keyColorAboveClouds.b * 0.0722;
		const moonLight = this.moonKeyAbove.r * 0.2126 + this.moonKeyAbove.g * 0.7152 + this.moonKeyAbove.b * 0.0722;
		const sunShare = keyLight > 0 ? Math.max( keyLight - moonLight, 0 ) / keyLight : 0;
		this.deckDay.value = overcastDeckLight( this.elevation );
		const seenNight = 2 ** ( - ( weather?.seenNight ?? 0 ) * this.grade.night );
		shared.seenNight.value = seenNight;
		this.seenDeck.value = seenNight;
		this.domeGapGain.moon.value = this.gapGain.moon.value * seenNight;
		const floorSun = 1 - overcastShare * sunShare * ( 1 - overcastFloorSun( this.elevation ) );
		this.castShadow.value = weather?.castShadow ?? 1;
		this.trackClouds( celestial, weather, coverage, overcast, illuminance, skyMix );
		const keyFloor = Math.min( KEY_THROUGH_CLOUD() * this.clouds.layerTransmission(), 1 ) * floorSun;
		this.keyCloudFloor.value = keyFloor;
		this.keyFloorUnderDeck = keyFloor * overcastShare;
		// (`flags=streaks:<n>` scales the thin layer's amount, 0 turns it off)
		this.clouds.streaks.value = ( weather?.streaks ?? 0 ) * ( typeof debugFlags.streaks === 'number' ? debugFlags.streaks : 1 );
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
		// (the morning mist is the haze's: weather/HazeKeys.ts)
		this.weather.fog = weather?.fog ?? 0;
		this.weather.windSpeed = weather?.windSpeed ?? 3.8;
		this.weather.windDirection = weather?.windDirection ?? 40;

	}

	private trackClouds( celestial: DayCycleSnapshot | null, weather: Readonly<WeatherState> | null, coverage: number, overcast: number, illuminance: number, skyMix: readonly number[] | null ): void {

		const clouds = this.clouds;
		clouds.coverage.value = coverage;
		clouds.density.value = weather?.density ?? 1;
		// The shadow's share of the deck by the weather's shares of the four skies, or the weather's
		// own without them: a weather change or a retune rebakes the whole map (`bake`), a front
		// under way refreshes it row by row.
		clouds.shadowDensity.value = skyMix ? SHADOW_DENSITY.reduce( ( sum, k, s ) => sum + ( skyMix[ s ] ?? 0 ) * k.shadowDensity, 0 ) : weather?.shadowDensity ?? 1;
		// The shell by the same shares (the high one's without them): every reader follows its
		// uniforms, the march, the shadow, the rain, the haze's shafts and the lightning.
		const row = ( key: keyof CloudSky ) => skyMix ? CLOUD_SKIES.reduce( ( sum, k, s ) => sum + ( skyMix[ s ] ?? 0 ) * k[ key ], 0 ) : CLOUD_SKIES[ 0 ][ key ];
		const base = row( 'base' );
		clouds.setShell( base, row( 'top' ) - base, skyMix ? cloudedShare( skyMix ) : 0 );
		clouds.cloudType.value = row( 'type' );
		clouds.typeSpread.value = row( 'spread' );
		clouds.farFade.value = row( 'farFade' );
		clouds.rain.value = weather?.rain ?? 0;
		// Cloud tops a couple of kilometres up keep the sun a little after it has set below. The
		// rising sun's reaches the shell where it stands (its middle, 6.6 km under the clear and
		// fair skies' cumulus), so the clouds take the dawn's light from about -2.6 degrees, as the
		// Earth's shadow sinks below them; the
		// height goes back to the evening's from the sun's rise to 3 degrees, so the morning's
		// higher sun lights them as the afternoon's does, and with a clouded share (Weather.ts
		// `cloudedShare`).
		const cloud = skyMix ? cloudedShare( skyMix ) : 0;
		const rising = this.rising && cloud < 1;
		const toEvening = Math.max( cloud, THREE.MathUtils.smoothstep( celestial?.elevation ?? 90, 0, 3 ) );
		const middle = ( clouds.shellBottom.value + clouds.shellThickness.value / 2 ) / 1000;
		const sunHeight = rising ? 2 + ( middle - 2 ) * ( 1 - toEvening ) : 2;
		const sunAbove = this.atmosphere.sunlightAt( this.sunDir, sunHeight ).multiply( this.sunTint ).multiplyScalar( illuminance );
		// Under a closed deck the sun reaches the deck as it reaches the island, scattered through
		// the cloud: it keeps its luminance and loses its colour as the key does (track), so an
		// overcast evening's deck is not a sunset's, but for the glow about the sun's place:
		// overcast's deck's forward lobe keeps the colour of the sun above the tops (Clouds.ts
		// `lobeTint`): per channel the colour over the grey's, c / ( c + ( 1 - c ) overcast ), by
		// overcast's share of the sky (1 under the other skies, and without the sun: below). Its
		// colour is the sun's from overhead, not along the sun's own path: taken along it, a low
		// sun's reddening would come back whole and the glow about a low sun read orange, a sunset's
		// under the deck.
		const overcastShare = skyMix ? skyMix[ 3 ] ?? 0 : 0;
		// the closed layer's share (Clouds.ts `overcastShare`)
		clouds.overcastShare.value = overcastShare;
		// the closed layer passes the weather's day sky whole: its own mean transmission is divided
		// out, so `daySky` alone sets the light under it (Clouds.ts `columnLevel`, `layerTransmission`)
		clouds.columnLevel.value = THREE.MathUtils.lerp( 1, 1 / clouds.layerTransmission(), overcastShare );
		const sunY = luma( sunAbove );
		const tint = clouds.lobeTint.value.setRGB( 1, 1, 1 );
		const above = overcastShare > 0 ? this.atmosphere.transmittanceAt( _zenith, sunHeight ).multiply( this.sunTint ) : null;
		const aboveY = above ? luma( above ) : 0;
		if ( above && sunY > 0 && aboveY > 0 ) for ( const c of [ 'r', 'g', 'b' ] as const ) {

			const chroma = above[ c ] / aboveY;
			tint[ c ] = THREE.MathUtils.lerp( 1, chroma / ( chroma + ( 1 - chroma ) * overcast ), overcastShare );

		}
		sunAbove.lerp( _white.setScalar( sunY ), overcast );
		// the weather's day sky (Weather.ts `daySkyAt`): the sun's light the clouds take, which lights
		// a deck's base and the land's sky under it, is the sky's light from the sun (`skyGain`)
		sunAbove.multiplyScalar( this.daySky );
		// The clouds belong to the seen sky: their moonlight comes in with the night sky's own light
		// (DayCycle.ts `cloudMoonShare`), not before it while the afterglow still lights the sky behind
		// them; under cloud with the clouded night's, by the clouded share.
		const moonShare = ! celestial ? 0 : duskForce( 'cloudMoon', cloudMoonShare( celestial.elevation, this.rising, cloud ) );
		const moonGain = celestial ? moonShare * celestial.moonVisibility : 0;
		const sunUp = ! celestial || celestial.elevation > - 2.5 || rising;
		// The march's depth shades the clouds' sky light as well as their direct light, and the same
		// direction casts their shadow, so it moves without a jump even while no direct light reaches
		// them: a jump there stepped the deck's brightness, half a stop on the meter under overcast.
		// It sets first, its shadow fading out on the way down, so its turn round to the sun, under
		// the horizon, sweeps no shadow across the island. Under a closed deck, on overcast's share,
		// it fades to the deck's mean transmittance instead (Clouds.ts `deckShadowShare`): faded to
		// lit, the haze under the deck took the sun the deck still hid, and the sky's light rose by
		// up to two thirds as the sun set.
		const elevation = celestial?.elevation ?? 90;
		const setting = THREE.MathUtils.smoothstep( elevation, CLOUD_TURN[ 0 ], CLOUD_TURN[ 1 ] ), round = THREE.MathUtils.smoothstep( elevation, CLOUD_TURN[ 1 ], CLOUD_TURN[ 2 ] );
		clouds.shadowShare.value = elevation < CLOUD_TURN[ 1 ] ? 1 - setting : THREE.MathUtils.smoothstep( this.sunDir.y, CLOUD_SHADOW_SET[ 0 ], CLOUD_SHADOW_SET[ 1 ] );
		clouds.deckShadowShare.value = overcastShare;
		clouds.lightDir.value.copy( setting === 0 ? this.keyDir : this.sunDir );
		if ( celestial && setting > 0 && round < 1 ) {

			const from = celestial.moonDir;
			const y = THREE.MathUtils.lerp( from.y, this.sunDir.y, setting ), start = Math.atan2( from.z, from.x );
			const turn = Math.atan2( this.sunDir.z, this.sunDir.x ) - start;
			const azimuth = start + Math.atan2( Math.sin( turn ), Math.cos( turn ) ) * round, across = Math.sqrt( 1 - y * y );
			clouds.lightDir.value.set( across * Math.cos( azimuth ), y, across * Math.sin( azimuth ) );

		}
		// the low deck's forward light on level ground at the key's height (Clouds.ts forwardLevel): the
		// narrow lobe's, the light overcast's share spreads by the diffusion law (a lobe of mean cosine
		// `overcastBroad`'s), and the two by that share, the deck's level
		clouds.lobe.value = clouds.forwardLobe.value;
		clouds.broadShare.value = overcastShare;
		// (by day: `deckDay`)
		clouds.deckFlat.value = ( 1 - clouds.deckGradation.value ) * overcastShare * this.deckDay.value;
		clouds.weight.value = THREE.MathUtils.lerp( clouds.forwardWeight.value, clouds.overcastWeight.value, overcastShare );
		const keyY = clouds.lightDir.value.y;
		clouds.narrowLevel.value = forwardLevel( keyY, clouds.lobe.value );
		clouds.forwardLevel.value = overcastShare > 0
			? THREE.MathUtils.lerp( clouds.narrowLevel.value, forwardLevel( keyY, clouds.overcastBroad.value ), overcastShare )
			: clouds.narrowLevel.value;
		const disc = 1 - THREE.MathUtils.smoothstep( clouds.lightDir.value.y, SHADOW_DISC[ 0 ], SHADOW_DISC[ 1 ] );
		clouds.shadowDisc.value = disc * SUN_ANGULAR_RADIUS;
		// With the whole disc under the floor the rays are one ray.
		clouds.shadowRays.value = disc > 0 && clouds.lightDir.value.y + clouds.shadowDisc.value > SHADOW_SLOPE_FLOOR ? SHADOW_DISC_RAYS : 1;
		const keyElevation = THREE.MathUtils.radToDeg( Math.asin( clouds.lightDir.value.y ) );
		clouds.shadowAirNarrow.value = THREE.MathUtils.smoothstep( keyElevation, SHADOW_AIR_NARROW[ 0 ], SHADOW_AIR_NARROW[ 1 ] );
		clouds.lightColor.value.copy( sunUp ? sunAbove : new THREE.Color( 0, 0, 0 ) );
		// The moon lights the clouds as the sun does: its light above the air through the air down to
		// the same height (`sunlightAt` toward the moon, in its colour), the weather's day sky at the
		// moon's height and the moon's share of the clouds' light, at the island's moonlight's hue
		// (MOON_KEY times `moonHue`, at unit luminance) and no other.
		const moonCloud = _cloudMoon.setRGB( 0, 0, 0 );
		if ( celestial ) moonCloud.setRGB( MOON_KEY[ 0 ], MOON_KEY[ 1 ], MOON_KEY[ 2 ] ).multiply( moonHue( _moonHue ) )
			.multiplyScalar( this.moonAbove * moonGain * this.daySkyMoon / MOON_KEY_LUMINANCE ).multiply( this.atmosphere.sunlightAt( celestial.moonDir, sunHeight ) );
		const moonY = luma( moonCloud );
		// The luminance of that light, for the stores' powers of two (PreExposure.ts `storeStops`),
		// the sun's before the day sky's gain: under a closed deck what a bake holds brightest is the
		// deck's base, which takes the sun through the cloud, not the day sky's share of it. Under
		// the moon each store's range follows the weather's clouds (`storeNight`).
		clouds.storeLight = ( sunUp ? sunY : 0 ) + moonY;
		const moonPart = clouds.storeLight > 0 ? moonY / clouds.storeLight : 0;
		clouds.storeStops = storeStops( clouds.storeLight, moonPart, storeNight( 'dome', skyMix ) );
		this.layerStops = storeStops( clouds.storeLight, moonPart, storeNight( 'layer', skyMix ) );
		this.panoramaStops = storeStops( clouds.storeLight, moonPart, storeNight( 'panorama', skyMix ) );
		const light = clouds.lightColor.value;
		light.add( moonCloud );
		// (the low sun's lift of the beam, as `directGain`'s)
		const beam = 1 + 0.7 * lowSunOf( this.elevation, coverage );
		// The thin layer's before the air, lifted alike: each of its points takes it through the air
		// toward the sun at the sun's elevation there, and loses it as the disc sinks under the
		// layer's own horizon there (Clouds.ts `streaksAt`), so no one moment ends the whole layer's.
		clouds.streakSunColour.value.copy( this.sunTint ).multiplyScalar( illuminance * beam * this.daySky );
		const { r: dr, g: dg, b: db } = keyed( STREAK_DIRECT, elevation, moonShare, _streakKey, cloud, rising );
		clouds.keyDirect.value.setRGB( dr, dg, db );
		const { r: ar, g: ag, b: ab } = keyed( STREAK_AMBIENT, elevation, moonShare, _streakKey, cloud, rising );
		clouds.keyAmbient.value.setRGB( ar, ag, ab );
		// (the moon's beam lifted as the sun's is, at the moon's height)
		clouds.moonLight.value = moonY * ( 1 + 0.7 * lowSunOf( this.moonElevation, coverage ) );
		// The night ambient is the clouds' own (the clear sky draws none), taken as their sky light.
		clouds.nightAmbient.value.copy( this.displayNightAmbient.value );
		// A low deck's column passes down the key's light above its tops: by day the sun's above the
		// cloud, by night the island's moonlight (`moonKeyAbove`), which keeps the island's level and
		// hue, not the clouds' (their moonlight belongs to the seen sky), and loses its colour under a
		// closed deck as the sun's does (above), and takes the weather's day sky at the moon's height
		// as the sun's takes it at the sun's (`daySkyMoon`; 1 but under overcast). The deck's base and
		// the land under it then take one moon, as by day they take one sun.
		const moonAbove = _moonKey.copy( this.moonKeyAbove );
		const column = clouds.columnKey.value.copy( moonAbove.lerp( _white.setScalar( luma( moonAbove ) ), overcast ).multiplyScalar( this.daySkyMoon ) );
		// A heap's part of the column's light is the sun's alone (Clouds.ts `columnSunShare`): it
		// goes by the sun's share of this key itself, so that part is the sun's addend and leaves
		// with it, whenever the moon's comes in. Lit by the moon too, the fair clouds read brighter
		// in late twilight than the night's level was set with, and the meter took the scene down
		// by a third of a stop at -11 to -12 degrees.
		const moonColumn = luma( column ), sunColumn = sunUp ? luma( sunAbove ) : 0;
		clouds.columnSunShare.value = sunColumn + moonColumn > 0 ? sunColumn / ( sunColumn + moonColumn ) : 1;
		if ( sunUp ) column.add( sunAbove );
		else tint.setRGB( 1, 1, 1 );
		// Low sun: lift the reddened beam, and the cool violet fill on the shaded sides with it. The
		// lift fades as the sky closes: a fair sky's scattered cumulus keep their golden light, a
		// cloudy sky's cover shows near neutral, and a closed deck, whose sunlight has lost its
		// colour, takes none.
		const lowSun = lowSunOf( this.elevation, coverage );
		clouds.directGain.value = 1 + 0.7 * lowSun;
		clouds.ambientGain.value = 1 + 0.35 * lowSun;
		clouds.openSkyGain.sun.value = this.gapGain.sun.value;
		clouds.openSkyGain.moon.value = this.gapGain.moon.value;

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
		this.followClock( windDirection, time );
		this.viewer.copy( camera.position );
		this.clouds.update( this.renderer, camera, width, height, time );

	}

	private async bake( transitionSeconds: number ): Promise<void> {

		const started = performance.now();
		const version = ++ this.bakeVersion;
		const readback = transitionSeconds === 0 || ! this.initialized;
		const weather = this.weatherState ? { ...this.weatherState } : null;
		await this.renderer.init();
		// the warm-up's pipelines first: r186 skips a draw whose pipeline is still being created
		// (see the header)
		await this.warmed;
		if ( ! this.clouds.ready ) await this.clouds.init( this.renderer );
		await this.night.load();
		if ( ! this.night.ready ) await this.night.init();
		// An explicit jump (preset, seek, weather change) refreshes the whole cloud map now.
		if ( readback ) {

			this.clouds.invalidate();
			this.clouds.update( this.renderer, this.viewCamera, this.viewWidth, this.viewHeight, this.cloudTime );

		}
		const bake = this.beginBake( version, readback, transitionSeconds, weather );
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
			this.landSea( bake.state, version, await r.readRenderTargetPixelsAsync( bake.state.deckIrradianceMap, 0, 0, 1, 1 ) as Float32Array );

		} else this.readIrradiance( bake.state, version );
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
	// and moon) and the weather it was requested with.
	private beginBake( version: number, readback: boolean, transitionSeconds: number, weather: WeatherState | null ): Bake {

		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		const next = this.initialized ? 1 - this.front : 0;
		const state = this.endpoints[ next ];
		state.version = version;
		// the weather's sky light; its day sky (`daySky`, from track) is on the sun's light alone: the
		// deck's irradiance takes it through the sky and the clouds, the sun's direct light on the
		// level water here (`sea.sun`), while the body's colour, its knee and the night's share keep
		// the weather's gain alone, so below the knee the body follows the day sky and at night it is
		// as it was
		const ambientGain = weather?.ambientGain ?? 1;
		this.ambientGain.value = ambientGain;
		// the distant sea's body (SEA_KNEE): the body is written as it stood before it followed the
		// light, the colour times the illuminance times the gain, so a body at the knee is that value
		const sea = state.sea;
		sea.body.copy( this.seaColor ).multiplyScalar( illuminance ).multiplyScalar( ambientGain );
		sea.night.copy( this.displayNightAmbient.value ).multiplyScalar( ambientGain );
		sea.sun = luma( this.sunColor ) * Math.max( this.sunDir.y, 0 ) / Math.PI * ambientGain * this.daySky;
		sea.knee = seaKnee() * illuminance * ambientGain;
		this.seaBody.value.copy( sea.body );
		this.seaNight.value.copy( sea.night );
		this.seaSun.value = sea.sun;
		this.seaKnee.value = sea.knee;
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

	// The cloud layer, the panoramas (seen, the environment's source, irradiance probe) and the
	// irradiance integral.
	private renderPanoramas( bake: Bake ): void {

		const { state } = bake;
		// The bake's powers of two, the layer's and the panoramas' at this moment (trackClouds, see
		// the stores above): the layer is written and read within the bake, the panoramas keep
		// theirs with them.
		const layer = this.layerStops, stops = this.panoramaStops;
		this.layerStore.value = 2 ** layer * storePress.store.value;
		this.layerRead.value = 2 ** - layer * storePress.read.value;
		state.stops = stops;
		if ( ! this.initialized ) this.endpoints[ 1 ].stops = stops;
		this.sourceStops = stops;
		for ( const atlas of this.initialized ? bake.environment !== null ? [ bake.environment ] : [] : [ 0, 1 ] ) this.environmentStops[ atlas ] = stops;
		const r = this.renderer, prev = r.getRenderTarget();
		try {

			r.setRenderTarget( state.clouds );
			this.upperQuad.render( r );
			this.cloudLayer.value = state.clouds.texture;
			// the sky's light without its haze, which the panoramas' haze takes under a deck
			// (VolumetricHaze.ts `openSky`)
			for ( const deck of this.initialized ? [ state.deckIrradianceMap ] : [ state.deckIrradianceMap, this.endpoints[ 1 ].deckIrradianceMap ] ) {

				r.setRenderTarget( deck );
				this.deckIrradianceQuad.render( r );

			}
			this.bakeDeckIrradiance.value = state.deckIrradianceMap.texture;
			// Both samplers must have distinct textures at the first material compilation:
			// Three deduplicates texture uniforms by UUID, even for separate TextureNodes.
			const panoramas = this.initialized ? [ state.equirect, this.reflectionSource, this.small ] :
				[ state.equirect, this.endpoints[ 1 ].equirect, this.reflectionSource, this.small ];
			for ( const rt of panoramas ) {

				this.irradiancePass.value = rt === this.small ? 1 : 0;
				this.bakeStore.value = rt === this.small ? 1 : 2 ** stops * storePress.store.value;
				// Only the environment's source takes the island's light after sunset (ISLAND_SKY).
				const lends = rt === this.reflectionSource;
				this.bakeIslandTint.value.copy( lends ? this.islandTint.value : NEUTRAL_TINT );
				this.bakeIslandGain.value = lends ? this.islandGain.value : 1;
				this.bakeHaze.value = lends || rt === this.small ? 1 : 0;
				this.bakeGlow.value = lends || rt === this.small ? 0 : 1;
				this.bakeKeyFloor.value = lends || rt === this.small ? 0 : 1;
				r.setRenderTarget( rt );
				( lends ? this.landQuad : this.quad ).render( r );

			}
			for ( const irradiance of this.initialized ? [ state.irradianceMap ] : [ state.irradianceMap, this.endpoints[ 1 ].irradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.irradianceQuad.render( r );

			}
			// (after the probe's panorama, so the bake's uniforms are the probe's)
			for ( const irradiance of this.initialized ? [ state.clearIrradianceMap ] : [ state.clearIrradianceMap, this.endpoints[ 1 ].clearIrradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.clearIrradianceQuad.render( r );

			}

		} finally {

			r.setRenderTarget( prev );

		}
		this.onEnvironmentSource?.( this.reflectionSource.texture, this.initialized ? bake.environment !== null ? [ bake.environment ] : [] : [ 0, 1 ], 2 ** - stops * storePress.read.value );

	}

	// The environment of the source in atlas `index`, whole.
	private filterEnvironment( index: number ): void {

		this.environments[ index ] = this.pmrem.fromEquirectangular( this.reflectionSource.texture, this.environments[ index ] );

	}

	// The same as filterEnvironment, as steps of one or two render passes: the conversion to the
	// cube atlas, then each level's GGX filter from the one above (PMREMGenerator's own steps:
	// three/Environment.ts). Each step restores what PMREMGenerator restores after a whole conversion.
	private environmentSlices( index: number ): Slice[] {

		const target = this.environments[ index ];
		if ( ! target ) return [ { cost: 20, run: () => this.filterEnvironment( index ) } ];
		const pmrem = environmentSteps( this.pmrem );
		const r = this.renderer, source = this.reflectionSource.texture;
		const step = ( work: () => void ) => () => {

			const previous = r.getRenderTarget(), face = r.getActiveCubeFace(), level = r.getActiveMipmapLevel(), autoClear = r.autoClear;
			try {

				work();

			} finally {

				r.autoClear = autoClear;
				r.setRenderTarget( previous, face, level );
				target.scissorTest = false;
				pmrem.resetViewport( target );

			}

		};
		const slices: Slice[] = [ { cost: 1, run: step( () => {

			pmrem.convert( source, target );

		} ) } ];
		// the generator keeps the levels of the source size the first bake set up, so their count is known
		const levels = pmrem.levels();
		for ( let i = 1; i < levels; i ++ ) slices.push( { cost: 2, run: step( () => {

			r.autoClear = false;
			pmrem.filter( target, i - 1, i );

		} ) } );
		return slices;

	}

	// Start a periodic bake over frames: the panoramas now, the rest from advance().
	private startSlices( transitionSeconds: number ): void {

		const started = performance.now();
		const weather = this.weatherState ? { ...this.weatherState } : null;
		const bake = this.beginBake( ++ this.bakeVersion, false, transitionSeconds, weather );
		this.renderPanoramas( bake );
		this.readIrradiance( bake.state, bake.version );
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

		const { state, transitionSeconds } = bake;
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
		this.panoramaReadA.value = 2 ** - previous.stops * storePress.read.value;
		this.panoramaReadB.value = 2 ** - displayedNext.stops * storePress.read.value;
		this.irradianceA.value = previous.irradianceMap.texture;
		this.irradianceB.value = displayedNext.irradianceMap.texture;
		this.clearIrradianceA.value = previous.clearIrradianceMap.texture;
		this.clearIrradianceB.value = displayedNext.clearIrradianceMap.texture;
		this.deckIrradianceA.value = previous.deckIrradianceMap.texture;
		this.deckIrradianceB.value = displayedNext.deckIrradianceMap.texture;
		// The environment cross-fades from the atlas shown to the one this bake filtered (the
		// first bake filled both); a bake that kept it fades it to itself.
		const shown = this.environments[ this.environmentFront ]!;
		const nextEnvironment = ! this.initialized ? this.environments[ 1 ]! : bake.environment !== null ? this.environments[ bake.environment ]! : shown;
		this.environmentPair = [ this.environmentFront, ! this.initialized ? 1 : bake.environment ?? this.environmentFront ];
		// the displayed environment at the second atlas's power of two (measured at most two stops
		// over the first, in a front between the kept skies through the twilight, and never apart
		// over a jump of the clock from noon to midnight: so a store's brightest, under 2^13, stays
		// in half float through the fade)
		const [ stopsA, stopsB ] = this.environmentPair.map( ( atlas ) => this.environmentStops[ atlas ] );
		this.environmentGainA.value = 2 ** ( stopsB - stopsA );
		this.environmentReadValue = 2 ** - stopsB * storePress.read.value;
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
			// within WebGPU's portable 16-texture limit instead of doubling every IBL sample. (The
			// first atlas taken to the second's power of two first: both stored as powers of two,
			// the gain loses no bits.)
			const a = this.environmentA.sample( uv() ).level( float( 0 ) ), b = this.environmentB.sample( uv() ).level( float( 0 ) );
			blendMat.fragmentNode = vec4( mix( a.rgb.mul( this.environmentGainA ), b.rgb, this.blend ), mix( a.a, b.a, this.blend ) );
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
		this.publish( this.blend.value );
		if ( this.transitionDuration === 0 ) this.front = this.destination;
		this.onEnvironmentStore?.();

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
		this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, amount );
		this.renderDisplayMaps();

	}

	private clearSky( direction: V3 ): V3 {

		// The sun's and the moon's in-scatter (Atmosphere.ts); the night's sky is the moon's, with no
		// floor of its own. Clouds do not mute the clear sky's colour: where they cover it, their own
		// light does.
		return this.atmosphere.skyRadiance( direction );

	}

	// The open sky behind the clouds, where it shows through them (CLEAR_SKY): the clear day's.
	private gapSky( direction: V3, gains = this.gapGain ): V3 {

		return this.atmosphere.skyRadiance( direction, true, gains );

	}

	private renderDisplayMaps(): void {

		if ( ! this.environmentBlendQuad || ! this.envMap ) return;
		const r = this.renderer, previous = r.getRenderTarget();
		try {

			r.setRenderTarget( this.envMap );
			this.environmentBlendQuad.render( r );
			r.setRenderTarget( this.irradianceDisplay );
			this.irradianceBlendQuad.render( r );
			r.setRenderTarget( this.clearIrradianceDisplay );
			this.clearIrradianceBlendQuad.render( r );
			r.setRenderTarget( this.deckIrradianceDisplay );
			this.deckIrradianceBlendQuad.render( r );

		} finally {

			r.setRenderTarget( previous );

		}

	}

	// A periodic bake's irradiance, read back from its probe (one texel) into its endpoint as soon as
	// the GPU answers, without waiting: it is asked for with the bake's panoramas and lands while the
	// environment's filter steps still run, so normally before the bake shows; one that lands later
	// changes the cross-fade only by the little it has run. A late answer never overwrites an
	// endpoint a newer bake has taken.
	private readIrradiance( state: SkyEndpoint, version: number ): void {

		this.irradiancePending ++;
		void this.renderer.readRenderTargetPixelsAsync( state.irradianceMap, 0, 0, 1, 1 ).then( ( pixels ) => {

			const p = pixels as Float32Array;
			if ( state.version !== version ) return;
			state.irradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
			const a = this.endpoints[ this.front ], b = this.endpoints[ this.destination ];
			if ( state === a || state === b ) this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, this.blend.value );

		} ).catch( ( error: unknown ) => console.error( error ) ).finally( () => { this.irradiancePending --; } );
		// and its distant sea's body, from its deck irradiance (`landSea`)
		this.irradiancePending ++;
		void this.renderer.readRenderTargetPixelsAsync( state.deckIrradianceMap, 0, 0, 1, 1 )
			.then( ( pixels ) => this.landSea( state, version, pixels as Float32Array ) )
			.catch( ( error: unknown ) => console.error( error ) ).finally( () => { this.irradiancePending --; } );

	}

	// A bake's distant sea on the CPU (`seaNode`'s twin, SEA_KNEE), from its deck irradiance read back:
	// the ground bounce takes it as the environment's lower half (`seaRadiance`). Only a newer bake's
	// overwrites it, and an answer for an endpoint a newer bake has taken lands nowhere. At the knee and
	// above it is the body the bake took, bit for bit.
	private landSea( state: SkyEndpoint, version: number, deck: Float32Array ): void {

		if ( state.version !== version ) return;
		const { body, night, sun, knee, radiance } = state.sea;
		const share = Math.min( ( 0.2126 * deck[ 0 ] + 0.7152 * deck[ 1 ] + 0.0722 * deck[ 2 ] + sun ) / knee, 1 );
		radiance.copy( body ).multiplyScalar( share ).add( night );
		if ( version < this.seaVersion ) return;
		this.seaVersion = version;
		this.seaLight.copy( radiance );

	}

	// The bake's cloud layer at `q` (the upper hemisphere's equirect), its radiance in scene units
	// (the bake's power of two and the debug press divided out).
	private layerAt( q: V2 ): V4 {

		const stored = this.cloudLayer.sample( q ).level( float( 0 ) ).toVar();
		return vec4( stored.rgb.mul( this.layerRead ), stored.a );

	}

	// The seen panorama toward `direction`, its radiance in scene units (each side's power of two and
	// the debug press divided out before the cross-fade: two bakes may store at two powers).
	private samplePanorama( direction: V3, mip: F ): V4 {

		const q = dirToEquirect( direction );
		const a = this.panoramaA.sample( q ).level( mip ).toVar(), b = this.panoramaB.sample( q ).level( mip ).toVar();
		return vec4( mix( a.rgb.mul( this.panoramaReadA ), b.rgb.mul( this.panoramaReadB ), this.blend ), mix( a.a, b.a, this.blend ) );

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

	/** The displayed environment's cross-fade: from atlas `a` to atlas `b` by `blend`. */
	environmentWeights(): { a: number; b: number; blend: number } {

		return { a: this.environmentPair[ 0 ], b: this.environmentPair[ 1 ], blend: this.blend.value };

	}

	/** The clouds' own transmittance of the key at a world position (Clouds.ts `shadow`): what the
	 * deck's gaps let through (the sky's light through them, the water's and the probes' gap share),
	 * and the key's visibility in the air where no deck has taken over, and on the sea where the
	 * land's floor is 0. */
	cloudVisibility( worldPosition: V3 ): F {

		return this.clouds.shadow( worldPosition );

	}

	/** The key's visibility on the sea at a world position: the land's (`keyDirectVisibility`), the
	 * clouds' own over the land's floor (`seaKeyFloor`). The sunlight a closed deck passes down and
	 * what a cumulus' shadow keeps of the key reach the sea's surface as they reach the land. The
	 * storm sea calls it; the water body and its foam build the same value from `seaKeyFloor` and
	 * keep `cloudVisibility` for their metering illuminance (ocean/Water.ts); the light under the
	 * water and the sea the ground's bounce and the probes see take the land's own, which it is.
	 * Where the land has no floor (a clear or a fair sky, a cloudy one by day) it is
	 * `cloudVisibility`. */
	seaKeyVisibility( worldPosition: V3 ): F {

		return this.keyDirectVisibility( worldPosition );

	}

	/** The key's direct beam through the clouds at a world position, without the light the cloud
	 * scatters on through (Clouds.ts `directShadow`): the sea's glint, a mirror image of the key,
	 * takes only this (the deck's forward light about the key is drawn in the sky the sea reflects,
	 * so a glint of it would count it twice); the water's other key light takes `seaKeyVisibility`. */
	cloudDirectVisibility( worldPosition: V3 ): F {

		return this.clouds.directShadow( worldPosition );

	}

	/** The clouds' shadow on the island's key, three's sun and the light the land bounces of it (the
	 * ground's bounce, the ambient light's bounce lobe): the clouds' own over the land's floor
	 * (KEY_THROUGH_CLOUD: a share of what the cloud layer passes down, on whichever light keys the
	 * scene, the moon's by night: `track`), so the land keeps a
	 * directional light through the sun's map under the thickest deck, and in a gap, where the
	 * clouds' own is 1, the sky's own key. The sea takes it too (`seaKeyVisibility`), the air the
	 * deck's floor alone (`deckKeyFloor`); the lit code without a sky reads both through
	 * lighting/KeyCloud.ts. */
	keyDirectVisibility( worldPosition: V3 ): F {

		return mix( this.keyCloudFloor, float( 1 ), this.clouds.shadow( worldPosition ) );

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		( this.landQuad.material as THREE.Material ).dispose();
		( this.upperQuad.material as THREE.Material ).dispose();
		this.reflectionSource.dispose();
		this.small.dispose();
		this.clouds.dispose();
		this.envMap?.dispose();
		this.irradianceDisplay.dispose();
		this.clearIrradianceDisplay.dispose();
		this.deckIrradianceDisplay.dispose();
		( this.environmentBlendQuad?.material as THREE.Material | undefined )?.dispose();
		( this.irradianceQuad.material as THREE.Material ).dispose();
		( this.irradianceBlendQuad.material as THREE.Material ).dispose();
		( this.clearIrradianceQuad.material as THREE.Material ).dispose();
		( this.clearIrradianceBlendQuad.material as THREE.Material ).dispose();
		( this.deckIrradianceQuad.material as THREE.Material ).dispose();
		( this.deckIrradianceBlendQuad.material as THREE.Material ).dispose();
		for ( const endpoint of this.endpoints ) {

			endpoint.equirect.dispose();
			endpoint.clouds.dispose();
			endpoint.irradianceMap.dispose();
			endpoint.clearIrradianceMap.dispose();
			endpoint.deckIrradianceMap.dispose();

		}
		for ( const environment of this.environments ) environment?.dispose();
		this.abortSlices();
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
