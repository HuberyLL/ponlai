/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater): its
 * volumetric clouds (`Clouds.js`, the view reconstruction) and its port of the Three.js Sky Pro
 * clouds (`SkyProClouds.js`, the density, lighting and march).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 *
 * The in-cloud lightning term (flashLight), the rain curtains and the rainbow drawn in them are
 * adapted from VolumetricCloudsCS1 by Anthony Ibrahim
 * (https://github.com/anthonytoumaibrahim/VolumetricCloudsCS1): `CloudRaymarch.shader`
 * (the point lights, MarchRain, BowColour) and `CloudMedia.cginc` / `CloudCommon.cginc`
 * (RainSigma, SampleRain).
 * Copyright (c) 2026 Anthony Ibrahim
 * Licensed under the MIT License; see ./VolumetricCloudsCS1.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, Continue, uniform, uv, texture, texture3D, storageTexture, textureStore, textureLoad, instanceIndex, uint, int, float,
	vec2, vec3, vec4, ivec2, uvec3, fract, dot, mix, smoothstep, clamp, max, min, exp, log2, sqrt, select,
	asin, acos, atan, cos, sin, normalize, floor, abs, length, not,
} from 'three/tsl';
import { bakeSynoptic, loadCloudShape } from '../materials/CloudNoise.ts';
import { bakeCirrusFibres, sampleCirrusFibres } from './Cirrus.ts';
import { RAINBOW_MAX_ANGLE, RAINBOW_SIZE, RAINBOW_TABLE } from './RainbowTable.data.ts';
import { skyRayleighPhase, type Atmosphere } from './Atmosphere.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { tune, tuneUniform } from '../debug/Tune.ts';
import { markSkyRetune } from './SkyRetune.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// Volumetric cumulus after tidewater's port of the Three.js Sky Pro clouds ("Partly cloudy"):
//   - density: a cloud shell kilometres thick; a procedural weather map sets where cloud may
//     stand, and a 64^3 Perlin-Worley shape noise dilates its tops into heaps and erodes their
//     margins, more strongly higher up. Edges stay soft; bases rest on the richer weather.
//   - lighting: a light march toward the key light in segments that grow geometrically and span
//     the shell's depth, with a tail on to its top (off for now), run however faint the light, since
//     its depth shades the sky light too, and moving without a jump for the same reason (Sky.ts
//     trackClouds); the light's optical depth scaled
//     by each step's own transmittance, taken over the finest step's length whatever the march's
//     cone (so the view and the coarser panorama light a cloud alike); two Henyey-Greenstein lobes
//     (forward 0.8, back -0.2), tidewater's droplet phase's first order, 80 / 20 where the light gets
//     through and all back lobe deep inside, mixed by the light's transmittance through the step (the
//     blend after Patry, "Real-Time Samurai Cinema", SIGGRAPH 2021, p. 97), the sun's and the
//     moon's mixed by their light at the shell's height (the atmosphere's in-scatter table there,
//     the moon's under its gains: Atmosphere.ts `moonRayleigh`, `moonMie`),
//     in place of multiple-scattering octaves, a powder term and a base shadow; sky light full
//     where the light's path is clear and falling toward a ramp up the shell where it is shadowed
//     (dark bases, bright tops). The march sums these as two factors, direct and ambient, which
//     take their colours once it ends, from the atmosphere's in-scatter table at the shell's mean
//     height toward the ray: the lit side the Mie share's colour times each body's light gain
//     (Sky.ts trackClouds), the shaded side the Rayleigh share under its phase (no polariser),
//     desaturated, times the earth's shadow there and each body's illuminance, its factor tinted
//     toward the opacity and toned on its log luminance (both neutral until fitted). The march adds
//     no air of its own, nor does the cirrus: the dome lays the haze over both at the clouds'
//     distance. Rain, cirrus and the view's clamp share the targets as colours, so the factors are
//     coloured in the march, not where they are shown.
//   - the cirrus (highAt): single scattering of the key light under an ice phase, plus the sky's
//     light from the zenith and the night ambient (`nightAmbient`, Sky.ts trackClouds). That
//     ambient is a fixed light of its own, which neither the sky's night gain nor the moon's
//     gains reach, and on a clear night it sets nearly all of the cirrus' brightness; the cirrus'
//     share of it takes a gain (`cirrusNightAmbient`: `sky.night.cirrusAmbient`, 0 to 2, 1 as
//     before). The cumulus' march takes the ambient ungained.
//   - march: coarse steps until cloud is found, then fine ones; whole cells of the weather map
//     that cannot reach the ray's height are skipped.
// The view is ray marched in screen space, one pixel of every 4 x 4 block per frame, accumulated
// with reprojection (camera motion and wind drift), clamped to this frame's neighbourhood and
// upsampled bicubically; a panorama of the upper sky serves reflections, the environment and the
// sun's visibility; a shadow map holds the layer's transmittance along the key light, at the
// weather's share of the layer's optical depth (`shadowDensity`, Weather.ts), read with a
// cubic B-spline built from four bilinear taps (`shadow`), with fades toward lit by the distance
// from the island's centre and by the view's angle from a chosen direction (inert until fitted);
// a light on the horizon casts none, the map fading to lit as the light sets (`shadowShare`);
// the haze reads it at each point's ground point along the same flat beam, with its B-spline blur
// for sharpening (`shadowAlongBeam`).
// This project keeps its own weather on top: coverage and density sweep in as a front from
// upwind, rain hangs in curtains under raining cloud, and high cirrus (Cirrus.ts) lies above.
// Both layers drift downwind with the wind aloft, a multiple of the weather's surface wind veered
// to its right (setDrift), while the cumulus' structure rises through them in place (`evolve`).
// Everything returns vec4( in-scattered radiance, transmittance ).
//
// Rules: the view accumulates over frames, and a scene at rest (paused clock, still camera)
// settles its clouds once and keeps them, so a paused frame is exactly repeatable. The march
// assumes a camera below the cloud base. On high the view's resolution is a share of the display
// (0.45 of its ratio up to 1.5: 1152x648 at 2K output, under half the render's linear size there,
// and 1296x729 at 4K output), not of the render, so the
// dynamic render scale does not soften the clouds again. 0.45 is the knee of a sweep against
// 0.58: it differed from it no more than a finer view did, and 0.40 stepped up; the view's
// march costs little where the island camera looks, much where the sky fills the frame. A new view size (a resized window; on the tiers below high,
// whose view follows the render, a new render scale) swaps the view's textures under the same
// kernels, which index by uniforms: a kernel built per size built its pipelines mid-play.
// Lightning's light inside the
// cloud stays out of the view's accumulated history, the bake and the panorama. The panorama and
// the shadow map refresh in part each frame and whole on a jump and when a paused scene settles.
// A scene jump (main.ts `establishScene`, through Sky.reset) restarts the clouds as they stand
// before a page's first frame (`restart`), for the bake that follows it.

export const EARTH_RADIUS = 6_360_000;
export const SHELL_BOTTOM = 4000, SHELL_THICKNESS = 5200;
// The preset's scales, rounded so they nest: the wrapped wind offset (TILE) holds a whole
// number of periods of the weather map, the shape noise and the erosion noise.
const WEATHER_SCALE = 28672, BASE_SCALE = 7168, EROSION_SCALE = BASE_SCALE / 8;
const TILE = WEATHER_SCALE;
// The shape noise rises through the cloud layer (its evolution in place, `evolve`: metres) and wraps
// on its vertical period. It drifts with the weather map: shifted horizontally it slid through the
// weather on its own and, faster than the drift, carried the visible heaps upwind.
export const EVOLVE_PERIOD = BASE_SCALE;
const WEATHER_RES = 1024, BOUNDS_RES = 64;
const DENSITY = 0.019 / 0.9; // extinction (1/m) at a density of one; fair weather's 0.9 is the preset
const BASE_STRENGTH = 0.69; // dilation of the tops by the shape noise
const EDGE = 0.095; // soft margin, as a fraction of the shell
const EROSION_BASE = 0.24, EROSION_PEAK = 2.15;
const BASE_WEATHER = 0.54, BASE_WEATHER_END = 0.13; // bases need richer weather
const SKEW = 1750; // metres the tops lean downwind
const HORIZON_START = 20000, HORIZON_RAMP = 45000, HORIZON_AMOUNT = 0.12; // more cloud far out
const AMBIENT = 0.7 * ( 1 + 0.99 );
const HORIZON_RING = 16; // azimuths in the half ring of horizon sky a cloud's base sees (see horizonRing)
const STEP = 25; // metres: the finest step and the first light segment
// The cloud's two phase lobes (see makeMarch): tidewater's droplet phase's first order, two
// Henyey-Greenstein lobes, `forward` and `back` asymmetries, the back one's share `backShare` of the
// light where it still gets through; deep in the cloud the back lobe alone (the blend after Patry 2021,
// p. 97). Tunable at load (`sky.clouds.lobeForward`,
// `lobeBack`, `lobeBackShare`).
const LOBE = {
	forward: tune( 'sky.clouds.lobeForward', 0.8, { min: 0.3, max: 0.95, load: true } )(),
	back: tune( 'sky.clouds.lobeBack', - 0.2, { min: - 0.6, max: 0.2, load: true } )(),
	backShare: tune( 'sky.clouds.lobeBackShare', 0.2, { min: 0, max: 0.6, load: true } )(),
};
// The light march's segments grow by this factor, the first sized so that they span the shell's
// depth together (updateLightTaps).
const LIGHT_GROWTH = 2.25;
// The shell's mean height (km), where the clouds read the atmosphere's in-scatter table.
const CLOUD_HEIGHT_KM = ( SHELL_BOTTOM + SHELL_THICKNESS / 2 ) / 1000;
// The most light march taps a tier may ask for (see setMarch); the uniforms hold this many.
const MAX_LIGHT_TAPS = 6, FULL_LIGHTING_ALPHA = 0.5, LIGHT_REUSE_STEPS = 3;
const AP_DIST = 30000; // aerial perspective scale toward the horizon
const FAR = 250000;
// A weather change sweeps across this many metres of sky, arriving from upwind.
const FRONT_SPAN = 25000;
const CIRRUS_ALTITUDE = 10000;
const UPPER_VEER = 0.6; // radians the upper wind turns from the surface wind
// The clouds drift with the wind aloft, derived from the surface wind's integrated displacement
// (setDrift), so they follow the weather's wind: the cumulus at LOW_DRIFT times the surface wind,
// turned LOW_VEER to its right (veering with height, as the wind aloft does north of the equator),
// the cirrus at HIGH_DRIFT times it along their fibres (UPPER_VEER). Steering winds at 4 to 9 km
// run two to three times the 10 m wind; at 0.21 times it the cumulus all but stood still.
const LOW_DRIFT = 2.25, LOW_VEER = 12 * Math.PI / 180, HIGH_DRIFT = 3;
// The cirrus' two fibre scales (metres per tile, turn in radians: sampleCirrusFibres).
const FIBRE_FINE = { tile: 40000, turn: 0 }, FIBRE_BROAD = { tile: 92000, turn: 0.5 };
const SYNOPTIC_SIZE = 409600;
// The panorama (see setDome): its size and refresh pattern, one texel of every strideX x strideY
// per frame. Its main consumer, the bake's 512 x 128 cloud layer, averages four taps of it, and
// the light shafts and the sky outside the view read it directly; a full refresh every 32 frames
// is far quicker than the clouds drift.
export const DOME_DEFAULTS = { width: 1024, height: 256, strideX: 4, strideY: 8 } as const;
const SHADOW_SIZE = 256, SHADOW_SPAN = 12000;
// The cloud shadow map refreshes one of every SHADOW_PHASES rows per pass (see setShadowRefresh);
// cloud shadows drift across its 47 m texels far slower than a full refresh.
const SHADOW_PHASES = 8;
const SHADOW_ORDER = [ 0, 4, 2, 6, 1, 5, 3, 7 ];
// Lightning inside the cloud: point sources lighting the march.
export const FLASH_SOURCES = 4;
// Rain curtains: marched from RAIN_START (nearer rain is the streaks of weather/Rain.ts) to the
// cloud base or RAIN_FAR, in segments that lengthen with distance (CloudMarch.rainSteps).
const RAIN_START = 700, RAIN_FAR = 42000;
const RAIN_SIGMA = 0.0004; // extinction (1/m) of a full shower: about ten kilometres of visibility
// The curtains' pattern: lumps RAIN_LUMPS metres across and streaks RAIN_STREAK metres across
// (both dividing TILE, so the wrapped wind offset shows no seam),
// stretched along the fall (vertical period RAIN_PERIOD) and sliding down RAIN_FALL metres per unit
// of `evolve` (2.5 per second: about 8 m/s). The fall over one evolve period is a whole number of
// vertical periods, so the wrap of `evolve` never shows.
const RAIN_STREAK = 512, RAIN_LUMPS = 2048, RAIN_FALL = 3.2;
const RAIN_PERIOD = EVOLVE_PERIOD * RAIN_FALL / 6;
// Share of the rain's extinction the bows scatter: the table is per geometric cross-section,
// and large drops extinguish twice that (the other half is diffracted straight ahead). Doubled
// for the art: the stylised curtains are thinner than real rain, and a bow should still read.
const BOW_SHARE = 0.5 * 2;
// The secondary bow is lifted further (to about a quarter of the primary instead of a seventh):
// in curtains this thin it would otherwise not read at all.
const SECONDARY_BOW_GAIN = 1.8;
// Share of a strike's light the rain returns, against the cloud's: drops scatter less of it back.
const RAIN_FLASH = 0.5;
// 4 x 4 ordered dither: one pixel of every block per frame.
const ORDER = [ 0, 10, 2, 8, 5, 15, 7, 13, 1, 11, 3, 9, 4, 14, 6, 12 ];
const REBUILD_SLOTS = 4; // slots traced per frame right after a camera cut
const SETTLE_CYCLES = 12; // samples per pixel a scene at rest averages before its view is kept

// The march's step caps and taps per tier (setMarch): today's high values by default. Each is a
// compile-time constant of the kernels, so a change rebuilds them once.
export interface CloudMarch {
	viewSteps: number; // the view's march
	panoramaSteps: number; // the panorama's march
	lightTaps: number; // taps of the light march toward the key light (1 to MAX_LIGHT_TAPS)
	rainSteps: number; // segments of the rain curtains' march
}
const MARCH_DEFAULTS: CloudMarch = { viewSteps: 256, panoramaSteps: 128, lightTaps: 6, rainSteps: 16 };

// How the view's resolution is set: a fraction of the render, or of the display (the render high
// draws at its nominal ratio: the display's, up to 1.5), so a lower render scale does not soften
// the clouds a second time.
export type CloudViewScale = { render: number } | { display: number };

// The sampling offset of a layer drifting `rate` times the surface wind's displacement `d`, turned
// `veer` radians to its right (toward +z from +x): the clouds move by minus the offset.
function driftOffset( d: THREE.Vector2, rate: number, veer: number ): THREE.Vector2 {

	return d.clone().rotateAround( new THREE.Vector2(), veer ).multiplyScalar( - rate );

}

// The panorama's refresh order over its sx x sy pattern (powers of two): consecutive frames land
// far apart, as an ordered dither does, so a partly refreshed map shows no sweep. A larger axis
// first alternates its coarsest offset alone; then 2 x 2 Bayer steps, coarse to fine. For 4 x 4
// this is the view's ORDER.
function ditherOrder( sx: number, sy: number ): [ number, number ][] {

	const ax = Math.log2( sx ), ay = Math.log2( sy ), pairs = Math.min( ax, ay );
	const order: [ number, number ][] = [];
	for ( let n = 0; n < sx * sy; n ++ ) {

		let r = n, x = 0, y = 0;
		for ( let level = Math.max( ax, ay ) - 1; level >= pairs; level -- ) {

			if ( r & 1 ) {

				if ( ax > ay ) x += 1 << level;
				else y += 1 << level;

			}
			r >>= 1;

		}
		for ( let level = pairs - 1; level >= 0; level -- ) {

			const v = r & 3;
			r >>= 2;
			x += [ 0, 1, 1, 0 ][ v ] << level;
			y += [ 0, 1, 0, 1 ][ v ] << level;

		}
		order.push( [ x, y ] );

	}
	return order;

}

// The Sky Pro coverage for this project's weather coverage: fair weather (0.32) is the preset's
// partly cloudy sky (0.49), a cloudy sky (0.67) stays broken into big heaps, and overcast and
// rain (0.94 - 1) close the shell.
const shellCoverage = ( c: F ) => select( c.lessThan( 0.32 ), c.mul( 0.49 / 0.32 ),
	select( c.lessThan( 0.8 ), c.sub( 0.32 ).mul( 0.17 / 0.48 ).add( 0.49 ), c.sub( 0.8 ).mul( 0.34 / 0.2 ).add( 0.66 ) ) );

// Upper-hemisphere map: longitude across, sqrt(latitude) up, denser near the horizon.
export const directionToDome = Fn( ( [ d ]: [ V3 ] ) => {

	const lat = asin( clamp( d.y, 0, 1 ) ).mul( 2 / Math.PI );
	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), sqrt( max( lat, 0 ) ) );

} ).setLayout( { name: 'cloudDirectionToDome', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const domeToDirection = Fn( ( [ q ]: [ V2 ] ) => {

	const lat = q.y.mul( q.y ).mul( Math.PI / 2 ).toVar(), phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar();
	return vec3( cos( lat ).mul( cos( phi ) ), sin( lat ), cos( lat ).mul( sin( phi ) ) );

} ).setLayout( { name: 'cloudDomeToDirection', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

// Distance along a ray from height h (metres) with vertical cosine mu to the sphere `a` metres
// above sea level, for a viewer below it. Written without R^2 terms to keep float precision.
const layerDistance = Fn( ( [ h, mu, a ]: [ F, F, F ] ) => {

	const rho = h.add( EARTH_RADIUS ).toVar();
	const b = rho.mul( mu ).toVar();
	const inside = a.sub( h ).mul( h.add( a ).add( 2 * EARTH_RADIUS ) ).toVar(); // r^2 - rho^2 > 0
	const root = sqrt( max( b.mul( b ).add( inside ), 0 ) ).toVar();
	return select( b.greaterThan( 0 ), inside.div( root.add( b ) ), root.sub( b ) );

} ).setLayout( { name: 'cloudLayerDistance', type: 'float', inputs: [
	{ name: 'h', type: 'float' }, { name: 'mu', type: 'float' }, { name: 'a', type: 'float' },
] } );

// Normalised Henyey-Greenstein phase.
const henyeyGreenstein = ( cosTheta: F, g: number ) =>
	float( 1 - g * g ).div( max( float( 1 + g * g ).sub( cosTheta.mul( 2 * g ) ), 1e-3 ).pow( 1.5 ).mul( 4 * Math.PI ) );
const sat = ( x: F ) => clamp( x, 0, 1 );
const luminance = ( c: V3 ) => dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );
const desaturate = ( c: V3, k: F ) => mix( c, vec3( luminance( c ) ), k );
const over = ( a: V4, b: V4 ) => vec4( a.rgb.add( b.rgb.mul( a.a ) ), a.a.mul( b.a ) );
// Height in the shell (0 at the base, 1 at the top) of a camera-relative point; the parabolic
// curvature term avoids subtracting two planet radii in float.
const shellHeight = ( p: V3 ) => p.y.add( dot( p.xz, p.xz ).div( 2 * EARTH_RADIUS ) ).sub( SHELL_BOTTOM ).div( SHELL_THICKNESS );
// Mip level of a noise of period `scale` for a footprint (m).
const coneLod = ( footprint: F, scale: number ) => max( log2( max( footprint.mul( 64 / scale ), 1 ) ), 0 );

// The weather map: Sky Pro's fBm of hashed gradient noise, tileable.
const WEATHER_MASS = [ 4, 5, 0, 1.32 ], WEATHER_DETAIL = [ 6, 6, 1, 0.13 ], WEATHER_COVERAGE = 0.26;
const weatherGradient = ( cell: THREE.Node<'uvec3'>, offset: V3 ) => {

	const seed = ( v: THREE.Node<'uint'> ) => v.mul( uint( 1664525 ) ).add( uint( 1013904223 ) ).toVar();
	const x = seed( cell.x ), y = seed( cell.y ), z = seed( cell.z );
	const mixUp = () => {

		x.addAssign( y.mul( z ) ); y.addAssign( z.mul( x ) ); z.addAssign( x.mul( y ) );

	};
	mixUp();
	x.assign( x.bitXor( x.shiftRight( uint( 16 ) ) ) ); y.assign( y.bitXor( y.shiftRight( uint( 16 ) ) ) ); z.assign( z.bitXor( z.shiftRight( uint( 16 ) ) ) );
	mixUp();
	const h = x.shiftRight( uint( 24 ) ).bitAnd( uint( 15 ) ).toVar();
	const u = select( h.lessThan( uint( 8 ) ), offset.x, offset.y );
	const v = select( h.lessThan( uint( 4 ) ), offset.y, select( h.equal( uint( 12 ) ).or( h.equal( uint( 14 ) ) ), offset.x, offset.z ) );
	return select( h.bitAnd( uint( 1 ) ).equal( uint( 0 ) ), u, u.negate() ).add( select( h.bitAnd( uint( 2 ) ).equal( uint( 0 ) ), v, v.negate() ) );

};
const weatherPerlin = ( p: V3, period: number ) => {

	const cell = floor( p ).toVar(), f = fract( p ).toVar();
	const w = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6 ).sub( 15 ) ).add( 10 ) ).toVar();
	const g = ( x: number, y: number, z: number ) => weatherGradient( uvec3( cell.add( vec3( x, y, z ) ).mod( period ) ), f.sub( vec3( x, y, z ) ) );
	return mix( mix( mix( g( 0, 0, 0 ), g( 1, 0, 0 ), w.x ), mix( g( 0, 1, 0 ), g( 1, 1, 0 ), w.x ), w.y ),
		mix( mix( g( 0, 0, 1 ), g( 1, 0, 1 ), w.x ), mix( g( 0, 1, 1 ), g( 1, 1, 1 ), w.x ), w.y ), w.z );

};
const weatherFbm = ( q: V2, profile: number[] ) => {

	let frequency = Math.max( 1, Math.round( profile[ 0 ] ) ), weight = 0.5, weights = 0;
	let sum: F = float( 0 );
	for ( let i = 0; i < profile[ 1 ]; i ++ ) {

		sum = sum.add( weatherPerlin( vec3( q, profile[ 2 ] * 13.37 + 0.5 ).mul( frequency ), frequency ).mul( weight ) );
		weights += weight; weight *= 0.5; frequency *= 2;

	}
	return sum.div( weights ).mul( 0.5 ).add( 0.5 );

};

interface ViewTextures {
	trace: THREE.StorageTexture; depth: THREE.StorageTexture; high: THREE.StorageTexture; motion: THREE.StorageTexture; flash: THREE.StorageTexture;
	boxMin: THREE.StorageTexture; boxMax: THREE.StorageTexture; history: THREE.StorageTexture[];
}
// a texture node of the view's kernels, and which of the view's textures it holds
type ViewSlot = [ { value: THREE.Texture }, ( t: ViewTextures ) => THREE.StorageTexture ];
interface View extends ViewTextures {
	width: number; height: number;
	kernels: { trace: THREE.ComputeNode; high: THREE.ComputeNode; box: THREE.ComputeNode; resolve: THREE.ComputeNode[] };
	slots: ViewSlot[];
}

export class Clouds {

	// Coverage and density over the island; they drive the lighting decisions for the deck.
	readonly coverage = uniform( 0.28 );
	readonly density = uniform( 1 );
	// the share of the layer's optical depth its shadow map is cast with (the weather's)
	readonly shadowDensity = uniform( 1 );
	// The weather front: values before and after, the linear progress over the island and the
	// unit horizontal direction the weather comes from.
	readonly coverageFrom = uniform( 0.28 );
	readonly coverageTo = uniform( 0.28 );
	readonly densityFrom = uniform( 1 );
	readonly densityTo = uniform( 1 );
	readonly frontProgress = uniform( 1 );
	readonly rainFrom = uniform( 0 );
	readonly rainTo = uniform( 0 );
	// Rain that fell recently (WeatherState.showers): it lingers in showers under the thicker cells.
	readonly showers = uniform( 0 );
	// Horizontal metres a drop drifts downwind per metre it falls.
	readonly rainSlant = uniform( 0.4 );
	// Strength of the rainbows in sunlit rain (0 to 1), set by the sky's rules for when they show.
	readonly rainbow = uniform( 0 );
	// How far the heaps of a broken sky may shower (0 to 1): none in fog, whose cover is a layer of
	// mist and stratus rather than rain cells.
	readonly heapShowers = uniform( 1 );
	readonly frontAxis = uniform( new THREE.Vector2( 1, 0 ) );
	// High cirrus: amount and the unit direction its fibres are combed along (the wind).
	readonly cirrus = uniform( 0 );
	// The gain on the sunlight the cirrus scatters (Sky.ts SKY_LIGHT times CIRRUS_SHARE, beside the
	// atmosphere's own): its forward peak round the sun is part of the sky's light against the sun's.
	readonly cirrusSunGain = uniform( 1 );
	readonly cirrusAxis = uniform( new THREE.Vector2( 1, 0 ) );
	// The cumulus' drift: the field is sampled at p + windOffset. Set through setDrift, which keeps
	// it within one noise period.
	readonly windOffset = uniform( new THREE.Vector2() );
	// The cirrus' drift in its fibres' frame (toWind), wrapped on the period of each texture it
	// samples: the synoptic cover's, the fine fibres' and the broad fibres' (setDrift).
	readonly cirrusShift = { synoptic: uniform( new THREE.Vector2() ), fine: uniform( new THREE.Vector2() ), broad: uniform( new THREE.Vector2() ) };
	readonly lightDir = uniform( new THREE.Vector3( 0.75, 0.53, - 0.12 ).normalize() );
	// The share of the clouds' shadow the map holds, none with the light on the horizon: Sky.ts
	// fades it, since a step there showed on the meter through the haze's light even with no direct
	// light on the island.
	readonly shadowShare = uniform( 1 );
	// Irradiance arriving at the cloud layer from the key light (scene units).
	readonly lightColor = uniform( new THREE.Color( 0.5, 0.45, 0.38 ) );
	// Night sky glow and moonlit fill, added to the atmosphere's own sky light.
	readonly nightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	// The gain on the night ambient the cirrus takes (its sky light at night comes almost all from
	// it, and no other night tunable reaches it); a change rebakes the panorama and the environment.
	readonly cirrusNightAmbient = tuneUniform( 'sky.night.cirrusAmbient', 0.0472, { min: 0, max: 2, onChange: markSkyRetune } );
	// Art balance of beam to sky light inside the clouds. A low sun's beam is already reddened
	// by the atmosphere; favouring it keeps sunset clouds glowing instead of muddy.
	readonly directGain = uniform( 1 );
	readonly ambientGain = uniform( 1 );
	// The light march's tail density (relative to a density of one) and the floor of the step
	// transmittance that scales the light's optical depth (makeMarch): both mechanisms in place, both
	// off.
	readonly lightTail = uniform( 0 );
	readonly lightFloor = uniform( 0 );
	// How far the in-scatter that weighs the sun's lobes against the moon's is desaturated toward
	// its luminance: the haze's clear-day value when it was set (weather/HazeKeys.ts), not linked to
	// it; the haze's has since been fitted higher, and the clouds' keeps its own until they are
	// fitted.
	readonly lightDesaturation = uniform( 0.26 );
	// The clouds' colours (makeMarch): each body's direct light gain (Sky.ts trackClouds), the
	// shaded side's desaturation, its per-channel tint toward the opacity and its tone (pivot in
	// log2 luminance, slope, lift: neutral).
	readonly sunLight = uniform( 1 );
	readonly moonLight = uniform( 0 );
	readonly ambientDesaturation = uniform( 0.26 );
	readonly ambientTint = uniform( new THREE.Vector3( 0, 0, 0 ) );
	readonly ambientTone = uniform( new THREE.Vector3( 0, 1, 0 ) );
	// The cloud shadow's fades toward lit (shadow): clamp( a_d r^2 + b_d ), r the horizontal distance
	// (m) from shadowCentre, and clamp( a_a |d - d0|^2 + b_a ), d the direction from the camera to the
	// point and d0 shadowFadeDirection, as ( a_d, b_d, a_a, b_a ). They start inert: the distance's
	// reaches 1 only past the map's half span (6 km), where the map's own edge fade has already
	// lifted the shadow, and the angle's is 0.
	readonly shadowFade = uniform( new THREE.Vector4( 10 / ( SHADOW_SPAN / 2 ) ** 2, - 10, 0, 0 ) );
	readonly shadowCentre = uniform( new THREE.Vector2( 0, 0 ) );
	readonly shadowFadeDirection = uniform( new THREE.Vector3( 0, - 1, 0 ) );
	readonly evolve = uniform( 0 );
	readonly origin = uniform( new THREE.Vector3( 0, 15, 0 ) );
	// The panorama; replaced when its size changes (setDome), so readers go through domeNode.
	dome: THREE.StorageTexture;
	readonly shadowMap: THREE.StorageTexture;
	// Lightning (weather/Lightning.ts): each source's world position (m) and reach (m) in xyzw,
	// and its radiance this frame; `flashOn` is 1 while any of them is lit.
	readonly flash = Array.from( { length: FLASH_SOURCES }, () => ( { source: uniform( new THREE.Vector4( 0, - 1e6, 0, 1 ) ), color: uniform( new THREE.Color( 0, 0, 0 ) ) } ) );
	readonly flashOn = uniform( 0 );

	// Camera-relative frame: the camera sits on the planet axis at `camY` (below the base).
	private readonly camY = uniform( 15 );
	private readonly camXZ = uniform( new THREE.Vector2() );
	private readonly windN = uniform( new THREE.Vector2( 1, 0 ) );
	private readonly phase = uniform( new THREE.Vector2() );
	private readonly shadowRow = uniform( 0 ); // which of every SHADOW_PHASES shadow rows to refresh
	// Light march taps (offset, segment length) and their mip levels (shape, erosion).
	private readonly lightTaps = Array.from( { length: MAX_LIGHT_TAPS }, () => uniform( new THREE.Vector4() ) );
	private readonly lightLods = Array.from( { length: MAX_LIGHT_TAPS }, () => uniform( new THREE.Vector2() ) );
	// Tier knobs (setDome, setMarch, setShadowRefresh, setViewScale).
	private domeSize: { width: number; height: number; strideX: number; strideY: number } = { ...DOME_DEFAULTS };
	private domeOrder = ditherOrder( DOME_DEFAULTS.strideX, DOME_DEFAULTS.strideY );
	private readonly domeNode: THREE.TextureNode;
	// Half a panorama texel in uv: the tent filter's tap offsets.
	private readonly domeTexel = uniform( new THREE.Vector2( 0.5 / DOME_DEFAULTS.width, 0.5 / DOME_DEFAULTS.height ) );
	private march: CloudMarch = { ...MARCH_DEFAULTS };
	private shadowRowsPerFrame = 1 / SHADOW_PHASES;
	private viewScale: CloudViewScale = { render: 0.5 };
	// The display the view's budget refers to: CSS pixels and the canvas's pixel ratio.
	private readonly display = { width: 1, height: 1, ratio: 1 };
	// The view: camera basis and frustum tangents now, at the previous trace, and as last traced.
	private readonly cam = { right: uniform( new THREE.Vector3( 1, 0, 0 ) ), up: uniform( new THREE.Vector3( 0, 1, 0 ) ), fwd: uniform( new THREE.Vector3( 0, 0, - 1 ) ), tan: uniform( new THREE.Vector2( 1, 1 ) ) };
	private readonly prev = { right: uniform( new THREE.Vector3( 1, 0, 0 ) ), up: uniform( new THREE.Vector3( 0, 1, 0 ) ), fwd: uniform( new THREE.Vector3( 0, 0, - 1 ) ), tan: uniform( new THREE.Vector2( 1, 1 ) ) };
	private readonly viewCam = { right: uniform( new THREE.Vector3( 1, 0, 0 ) ), up: uniform( new THREE.Vector3( 0, 1, 0 ) ), fwd: uniform( new THREE.Vector3( 0, 0, - 1 ) ), tan: uniform( new THREE.Vector2( 1, 1 ) ) };
	private readonly viewSize = uniform( new THREE.Vector2( 4, 4 ) );
	private readonly traceSize = uniform( new THREE.Vector2( 1, 1 ) );
	// the trace's and the view's widths, which the kernels index by (uniforms: see buildView)
	private readonly traceWidth = uniform( 1, 'uint' );
	private readonly viewWidth = uniform( 1, 'uint' );
	private readonly displayHeight = uniform( 4 );
	private readonly viewValid = uniform( 0 );
	private readonly slot = uniform( new THREE.Vector2() );
	private readonly subPixel = uniform( new THREE.Vector2() );
	private readonly frameNoise = uniform( 0 );
	private readonly rebuildK = uniform( - 1 );
	private readonly minAlpha = uniform( 0.12 );
	private readonly historyValid = uniform( 0 );
	// 0 while a scene at rest settles: nothing moves, so the history needs no clamp to stay clean.
	private readonly clampHistory = uniform( 1 );
	private readonly camDelta = uniform( new THREE.Vector3() );
	private readonly camDeltaHi = uniform( new THREE.Vector3() );

	private shape: THREE.Data3DTexture | null = null;
	private synoptic: THREE.StorageTexture | null = null;
	private weather: THREE.StorageTexture | null = null;
	private bounds: THREE.StorageTexture | null = null;
	private cirrusFibres: THREE.RenderTarget | null = null;
	private loading: Promise<void> | null = null;
	private partialKernel: THREE.ComputeNode | null = null;
	private shadowKernel: THREE.ComputeNode | null = null;
	private previousFlash = '';
	private view: View | null = null;
	private readonly viewNode = texture( new THREE.Texture() );
	private marchView: ( ( rd: V3, jitter: F ) => { L: V3; F: V3; T: F; depth: F } ) | null = null;
	// This frame's lightning in the view, traced at a quarter of its resolution.
	private readonly flashNode = texture( new THREE.Texture() );
	private highAt: ( ( rd: V3, pxAngle: F ) => V4 ) | null = null;
	private rainAt: ( ( rd: V3, pxAngle: F, jitter: F, withFlash?: boolean ) => { color: V4; flash: V3 } ) | null = null;
	private rainbowTable: THREE.DataTexture | null = null;
	private skyAt: ( ( rd: V3 ) => V3 ) | null = null;
	private frame = 0;
	private needsFull = true;
	// View accumulation state.
	private pingPong = 0;
	private traces = 0;
	private rebuild = 0;
	private since = 0;
	private hasPrevious = false;
	private readonly previousCamera = new THREE.Vector3();
	private readonly previousKey = new THREE.Vector3();
	// The surface wind's displacement the drift was last set from, and the one the previous frame's
	// view saw (the reprojection's drift is their difference, unwrapped).
	private readonly displacement = new THREE.Vector2();
	private readonly previousDisplacement = new THREE.Vector2();
	private previousTime = 0;
	private settled = false;
	private turned = 0;

	constructor( private readonly atmosphere: Atmosphere ) {

		this.dome = makeDome( DOME_DEFAULTS.width, DOME_DEFAULTS.height );
		this.domeNode = texture( this.dome );
		this.shadowMap = new THREE.StorageTexture( SHADOW_SIZE, SHADOW_SIZE );
		this.shadowMap.type = THREE.UnsignedByteType;
		this.shadowMap.minFilter = this.shadowMap.magFilter = THREE.LinearFilter;
		this.shadowMap.generateMipmaps = false;
		this.shadowMap.name = 'cloudShadow';

	}

	get ready(): boolean { return this.partialKernel !== null; }

	/** Loads the shape noise, bakes the weather and cirrus, and builds the panorama and shadow
	 * kernels. */
	init( renderer: THREE.WebGPURenderer ): Promise<void> {

		this.loading ??= loadCloudShape( renderer ).then( ( shape ) => this.build( renderer, shape ) );
		return this.loading;

	}

	private build( renderer: THREE.WebGPURenderer, shape: THREE.Data3DTexture ): void {

		this.shape = shape;
		this.synoptic = bakeSynoptic( renderer );
		this.cirrusFibres = bakeCirrusFibres( renderer );
		const storage = ( size: number, filter: THREE.MagnificationTextureFilter ) => {

			const t = new THREE.StorageTexture( size, size );
			t.type = THREE.UnsignedByteType;
			t.wrapS = t.wrapT = THREE.RepeatWrapping;
			t.minFilter = t.magFilter = filter;
			t.generateMipmaps = false;
			return t;

		};
		const weather = this.weather = storage( WEATHER_RES, THREE.LinearFilter );
		const bounds = this.bounds = storage( BOUNDS_RES, THREE.NearestFilter );
		const weatherKernel = Fn( () => {

			const n = uint( WEATHER_RES );
			const c = ivec2( int( instanceIndex.mod( n ) ), int( instanceIndex.div( n ) ) );
			const q = vec2( c ).div( WEATHER_RES ).toVar();
			const mass = sat( weatherFbm( q, WEATHER_MASS ).sub( 0.5 ).mul( WEATHER_MASS[ 3 ] ).add( 0.5 ) );
			const detail = weatherFbm( q, WEATHER_DETAIL ).mul( 2 ).sub( 1 ).mul( WEATHER_DETAIL[ 3 ] );
			textureStore( weather, c, vec4( sat( mass.add( detail ).add( WEATHER_COVERAGE - 0.5 ) ), 0, 0, 1 ) );

		} )().compute( WEATHER_RES * WEATHER_RES, [ 64 ] ).setName( 'Clouds.Weather' );
		// The most cloud-capable weather in each cell of a coarse grid, including the texels its
		// bilinear lookups reach across the cell's edges (and the wrap).
		const weatherLoad = texture( weather );
		const boundsKernel = Fn( () => {

			const n = uint( BOUNDS_RES );
			const c = ivec2( int( instanceIndex.mod( n ) ), int( instanceIndex.div( n ) ) );
			const k = WEATHER_RES / BOUNDS_RES;
			const lo = ivec2( vec2( c ).mul( k ).sub( 1 ) );
			const highest = float( 0 ).toVar();
			Loop( { start: 0, end: k + 2, type: 'int' }, { start: 0, end: k + 2, type: 'int' }, ( { i, j } ) => {

				const p = lo.add( ivec2( int( i ), int( j ) ) ).add( WEATHER_RES ).mod( WEATHER_RES );
				highest.assign( max( highest, textureLoad( weatherLoad, p ).r ) );

			} );
			textureStore( bounds, c, vec4( min( highest.add( 1 / 255 ), 1 ), 0, 0, 1 ) );

		} )().compute( BOUNDS_RES * BOUNDS_RES, [ 64 ] ).setName( 'Clouds.WeatherBounds' );
		renderer.compute( weatherKernel );
		renderer.compute( boundsKernel );
		this.rainbowTable = makeRainbowTexture();
		this.buildKernels();

	}

	/** Build the march and the panorama and shadow kernels for the current tier knobs; the view's
	 * kernels follow on its next update. */
	private buildKernels(): void {

		const shape = this.shape!, weather = this.weather!, bounds = this.bounds!, synoptic = this.synoptic!;
		const fibres = this.cirrusFibres!.texture;
		const { viewSteps, panoramaSteps, lightTaps, rainSteps } = this.march;
		const { width: domeWidth, height: domeHeight, strideX, strideY } = this.domeSize;
		const domeTexelAngle = 2 * Math.PI / domeWidth;
		this.partialKernel?.dispose();
		this.shadowKernel?.dispose();
		const shapeNode = texture3D( shape ), weatherNode = texture( weather ), boundsNode = texture( bounds ), synopticNode = texture( synoptic );

		// The weather front at a camera-relative position: (coverage of the shell, density scale).
		const frontAt = ( pxz: V2 ) => {

			const reached = clamp( this.frontProgress.add( dot( pxz.add( this.camXZ ), this.frontAxis ).div( FRONT_SPAN ) ), 0, 1 ).toVar();
			const sweep = reached.mul( reached ).mul( float( 3 ).sub( reached.mul( 2 ) ) );
			return vec2( shellCoverage( clamp( mix( this.coverageFrom, this.coverageTo, sweep ), 0, 1 ) ), mix( this.densityFrom, this.densityTo, sweep ) );

		};
		// More cloud toward the horizon, by distance along the ray.
		const horizonCoverage = ( t: F ) => smoothstep( HORIZON_START, HORIZON_START + HORIZON_RAMP, t ).mul( HORIZON_AMOUNT );
		const weatherUV = ( pxz: V2 ) => pxz.add( this.camXZ ).add( this.windOffset ).div( WEATHER_SCALE );

		// Cloud presence at p without the erosion: a smooth bound of the cloud and what the eroded
		// density needs. The tops: the weather plus the coverage, dilated by the shape noise.
		const candidate = ( p: V3, coverage: F, lod: F ) => {

			const h = shellHeight( p ).toVar();
			const c = { conservative: float( 0 ).toVar(), top: float( 0 ).toVar(), floorMask: float( 0 ).toVar(), h, coverage, position: vec3( 0 ).toVar() };
			If( h.greaterThan( - 0.1 ).and( h.lessThan( 1.3 ) ).and( coverage.greaterThan( 0 ) ), () => {

				const w = weatherNode.sample( weatherUV( p.xz ) ).level( float( 0 ) ).r.toVar();
				// An all-one noise sample bounds the dilation: a failed bound saves the volume fetch.
				const maximumTop = w.add( coverage ).sub( 1 ).add( coverage.mul( 1.34 * BASE_STRENGTH ) );
				const required = float( 1 ).sub( smoothstep( 0, BASE_WEATHER_END, h ) ).mul( BASE_WEATHER ).toVar();
				c.floorMask.assign( smoothstep( required.sub( 0.1 ), required, w ) );
				If( maximumTop.greaterThanEqual( h.sub( EDGE ) ).and( c.floorMask.greaterThan( 0 ) ), () => {

					const world = p.xz.add( this.camXZ ).add( this.windOffset );
					const lean = this.windN.mul( max( h, 0 ).mul( SKEW ) );
					c.position.assign( vec3( world.x.sub( lean.x ), p.y.sub( this.evolve ), world.y.sub( lean.y ) ) );
					const base = shapeNode.sample( c.position.div( BASE_SCALE ) ).level( lod ).rgb;
					const dilation = dot( base, vec3( 0.7, 0.41, 0.23 ) ).mul( BASE_STRENGTH );
					c.top.assign( w.add( coverage ).sub( 1 ).add( dilation.mul( coverage ) ) );
					c.conservative.assign( smoothstep( - EDGE, EDGE, c.top.sub( h ) ).mul( smoothstep( - EDGE, EDGE, h ) ).mul( c.floorMask ) );

				} );

			} );
			return c;

		};
		type Candidate = ReturnType<typeof candidate>;
		// The cloud: its margins eroded by the shape noise at a finer scale, the more so higher up.
		const erodedDensity = ( c: Candidate, lod: F ) => {

			const density = float( 0 ).toVar();
			If( c.conservative.greaterThan( 0 ), () => {

				const strength = mix( float( EROSION_BASE ), float( EROSION_PEAK ), sat( c.h.div( max( c.top, 0.001 ) ) ) ).toVar();
				const maximumErosion = strength.mul( c.coverage ).mul( 0.173 );
				density.assign( c.floorMask );
				If( min( c.top.sub( c.h ), c.h ).lessThan( maximumErosion.add( EDGE ) ), () => {

					const s = shapeNode.sample( c.position.div( EROSION_SCALE ) ).level( lod ).rgb;
					const erosion = dot( s, vec3( 0.113, 0.04, 0.02 ) ).mul( strength ).mul( c.coverage ).toVar();
					density.assign( smoothstep( - EDGE, EDGE, c.top.sub( erosion ).sub( c.h ) ).mul( smoothstep( - EDGE, EDGE, c.h.sub( erosion ) ) ).mul( c.floorMask ) );

				} );

			} );
			return density;

		};
		const lightDensity = ( p: V3, coverage: F, lods: V2, cheap: THREE.Node<'bool'> | boolean ) => {

			const c = candidate( p, coverage, lods.x );
			if ( cheap === true ) return c.conservative;
			if ( cheap === false ) return erodedDensity( c, lods.y );
			const density = c.conservative.toVar();
			If( not( cheap ), () => {

				density.assign( erodedDensity( c, lods.y ) );

			} );
			return density;

		};

		const skyAt = ( rd: V3 ) => this.atmosphere.skyRadiance( rd, false ).add( this.nightAmbient.rgb );
		// The horizon sky a cloud's base sees is the whole ring round it, not the side toward the
		// sun: a low sun's orange glow fills a short arc of that ring, so the ring's average is far
		// paler, and the sun's own colour reaches the clouds through their direct light. The
		// sky's radiance is symmetric about the sun's azimuth, so a half ring from the sun round to
		// its opposite side holds the whole ring's average; its azimuths are relative to the sun,
		// so the average moves smoothly with it.
		const horizonRing = () => {

			const s = this.atmosphere.sunDir;
			const toward = normalize( vec2( s.x.add( 1e-5 ), s.z ) ).toVar();
			const sum = vec3( 0 ).toVar();
			Loop( HORIZON_RING, ( { i } ) => {

				const a = float( i ).add( 0.5 ).mul( Math.PI / HORIZON_RING ).toVar();
				const c = cos( a ), n = sin( a );
				sum.addAssign( skyAt( normalize( vec3( toward.x.mul( c ).sub( toward.y.mul( n ) ), 0.03, toward.x.mul( n ).add( toward.y.mul( c ) ) ) ) ) );

			} );
			return sum.mul( 1 / HORIZON_RING );

		};
		const heightAlongRay = ( t: F, rd: V3 ) => this.camY.add( rd.y.mul( t ) ).add( dot( rd.xz, rd.xz ).mul( t ).mul( t ).div( 2 * EARTH_RADIUS ) ).sub( SHELL_BOTTOM ).div( SHELL_THICKNESS );

		// Ray march the shell along rd (camera relative); `flash`
		// adds the lightning inside the cloud.
		const makeMarch = ( maxSteps: number, pixelCone: F, stepCone: F, flash = false ) => ( rd: V3, jitter: F ) => {

			const start = layerDistance( this.camY, rd.y, float( SHELL_BOTTOM ) ).toVar();
			const end = min( layerDistance( this.camY, rd.y, float( SHELL_BOTTOM + SHELL_THICKNESS ) ), FAR ).toVar();
			const color = vec3( 0 ).toVar(), flashColor = vec3( 0 ).toVar();
			// the march's light factors: direct (phase included) and ambient, each per unit of its colour
			const directLight = float( 0 ).toVar(), ambientLight = float( 0 ).toVar();
			// The atmosphere's in-scatter at the shell's mean height toward rd, per unit of the sun's
			// and of the moon's illuminance: it weighs their lobes and colours the factors.
			const a = this.atmosphere;
			const sunRows = a.cloudRows( rd.y, CLOUD_HEIGHT_KM, 0 ), moonRows = a.cloudRows( rd.y, CLOUD_HEIGHT_KM, 1 );
			const sunMie = desaturate( sunRows.mie, this.lightDesaturation ).toVar(), moonMie = desaturate( moonRows.mie, this.lightDesaturation ).toVar();
			const transmission = float( 1 ).toVar(), weightedDepth = float( 0 ).toVar();
			// The shell's coverage at its fullest here: the bound for skipping empty cells.
			const coverageBound = shellCoverage( max( this.coverageFrom, this.coverageTo ) ).toVar();
			If( rd.y.greaterThan( - 0.001 ).and( end.greaterThan( start ) ).and( coverageBound.greaterThan( 0 ) ), () => {

				const L = this.lightDir;
				// The sun's and the moon's lobes, mixed by their light at the shell's height: each
				// one's aerosol in-scatter there (the atmosphere's table, desaturated as the haze's
				// light is) times its illuminance, so the switch at dusk follows the light.
				const sunY = luminance( sunMie ).mul( luminance( a.sunIlluminance.rgb ) );
				const moonY = luminance( moonMie ).mul( luminance( a.moonIlluminance.rgb ) );
				const sunShare = smoothstep( 0, 1, sunY.div( max( sunY.add( moonY ), 1e-20 ) ) ).toVar();
				const sunNu = dot( rd, a.sunDir ).toVar(), moonNu = dot( rd, a.moonDir ).toVar();
				const forwardLobe = mix( henyeyGreenstein( moonNu, LOBE.forward ), henyeyGreenstein( sunNu, LOBE.forward ), sunShare ).toVar();
				const backLobe = mix( henyeyGreenstein( moonNu, LOBE.back ), henyeyGreenstein( sunNu, LOBE.back ), sunShare ).toVar();
				const t = start.add( jitter.mul( STEP ) ).toVar();
				const coarse = int( 1 ).toVar(), emptyRun = int( 0 ).toVar();
				const accumulatedDepth = float( 0 ).toVar(), refineEnd = float( - 1 ).toVar();
				const cellStart = float( - 1 ).toVar(), cellEnd = float( - 1 ).toVar(), maximumWeather = float( 1 ).toVar();
				const shadowAt = float( - FAR ).toVar(), shadowDensity = float( - 1 ).toVar(), shadowCheap = int( - 1 ).toVar();
				const shadowTau = float( 0 ).toVar();
				Loop( maxSteps, () => {

					If( t.greaterThanEqual( end ).or( transmission.lessThan( 0.003 ) ), () => {

						Break();

					} );
					If( coarse.equal( 1 ), () => {

						// Skip whole cells of the weather grid that cannot hold cloud at the ray's height.
						If( t.greaterThanEqual( cellEnd ).or( t.lessThan( cellStart ) ), () => {

							const grid = weatherUV( rd.xz.mul( t ) ).mul( BOUNDS_RES ).toVar();
							maximumWeather.assign( textureLoad( boundsNode, ivec2( floor( grid ) ).mod( BOUNDS_RES ).add( BOUNDS_RES ).mod( BOUNDS_RES ) ).r );
							const f = fract( grid ).toVar();
							const ahead = vec2( select( rd.x.greaterThanEqual( 0 ), float( 1 ).sub( f.x ), f.x ), select( rd.z.greaterThanEqual( 0 ), float( 1 ).sub( f.y ), f.y ) )
								.div( max( abs( rd.xz ).mul( BOUNDS_RES / WEATHER_SCALE ), vec2( 1e-7 ) ) );
							cellStart.assign( t );
							cellEnd.assign( min( end, t.add( max( min( ahead.x, ahead.y ), 0.05 ) ) ) );

						} );
						const turning = rd.y.negate().mul( EARTH_RADIUS ).div( max( dot( rd.xz, rd.xz ), 1e-6 ) );
						const lowest = heightAlongRay( clamp( turning, t, cellEnd ), rd );
						const highest = max( heightAlongRay( t, rd ), heightAlongRay( cellEnd, rd ) );
						const coverage = coverageBound.add( horizonCoverage( cellEnd ) );
						const maximumTop = maximumWeather.add( coverage ).sub( 1 ).add( coverage.mul( 1.34 * BASE_STRENGTH ) );
						const required = float( 1 ).sub( smoothstep( 0, BASE_WEATHER_END, highest ) ).mul( BASE_WEATHER );
						If( maximumTop.lessThan( lowest.sub( EDGE ) ).or( maximumWeather.lessThanEqual( required.sub( 0.1 ) ) ), () => {

							t.assign( cellEnd.add( 0.05 ) );
							Continue();

						} );

					} );
					const footprint = t.mul( pixelCone );
					const fineStep = max( float( STEP ), t.mul( stepCone ).mul( 1.5 ) ).toVar();
					const p = vec3( rd.x.mul( t ), this.camY.add( rd.y.mul( t ) ), rd.z.mul( t ) ).toVar();
					const front = frontAt( p.xz ).toVar();
					const coverage = front.x.add( horizonCoverage( t ) ).toVar();
					const baseLod = coneLod( footprint, BASE_SCALE ).toVar(), erosionLod = coneLod( footprint, EROSION_SCALE ).toVar();
					const c = candidate( p, coverage, baseLod );
					const density = erodedDensity( c, erosionLod ).toVar();
					If( coarse.equal( 1 ), () => {

						// Coarse steps until cloud is found, then back up and refine.
						If( density.greaterThan( 0 ), () => {

							refineEnd.assign( t );
							t.assign( min( max( start, t.sub( fineStep.mul( 4 ) ) ).add( fineStep ), refineEnd ) );
							coarse.assign( 0 );
							emptyRun.assign( 0 );

						} ).Else( () => {

							t.addAssign( fineStep.mul( 4 ) );

						} );
						Continue();

					} );
					If( density.lessThanEqual( 0 ), () => {

						shadowAt.assign( - FAR );
						emptyRun.addAssign( 1 );
						If( t.lessThan( refineEnd ), () => {

							t.assign( min( t.add( fineStep ), refineEnd ) );

						} ).Else( () => {

							If( emptyRun.greaterThanEqual( 4 ), () => {

								coarse.assign( 1 );

							} );
							t.addAssign( select( coarse.equal( 1 ), fineStep.mul( 4 ), fineStep ) );

						} );
						Continue();

					} );
					emptyRun.assign( 0 );
					refineEnd.assign( - 1 );
					const sigmaT = density.mul( front.y ).mul( DENSITY ).toVar();
					const surfaceStep = clamp( float( 0.5 ).div( max( sigmaT, 1e-6 ) ), fineStep.mul( 0.15 ), fineStep );
					const stepLength = min( mix( surfaceStep, fineStep.mul( 3 ), smoothstep( 1, 3, accumulatedDepth ) ), end.sub( t ) ).toVar();
					const height = sat( c.h ).toVar();
					const stepT = exp( sigmaT.mul( stepLength ).negate() ).toVar();
					// The step's transmittance the light reads (below) over a step of the finest
					// length, whatever this march's cone: the scaling and the lobes' mix stand for
					// scattering inside a step, so a longer step lit the same cloud brighter, and the
					// panorama's coarser march (the environment, reflections) lit an overcast deck
					// several times brighter than the view does.
					const lightStepT = exp( sigmaT.mul( min( mix( clamp( float( 0.5 ).div( max( sigmaT, 1e-6 ) ), STEP * 0.15, STEP ), STEP * 3, smoothstep( 1, 3, accumulatedDepth ) ), end.sub( t ) ) ).negate() ).toVar();
					const cheap = float( 1 ).sub( transmission ).greaterThanEqual( FULL_LIGHTING_ALPHA ).toVar();
					const reuse = min( fineStep.mul( LIGHT_REUSE_STEPS ), Math.max( 20, EROSION_SCALE * 0.03 ) );
					If( abs( t.sub( shadowAt ) ).greaterThanEqual( reuse ).or( abs( density.sub( shadowDensity ) ).greaterThan( 0.08 ) ).or( select( cheap, int( 1 ), int( 0 ) ).notEqual( shadowCheap ) ), () => {

						const lods = vec2( baseLod, erosionLod ).toVar();
						const scale = front.y.mul( DENSITY );
						// The light march: segments growing along a narrow cone toward the key light,
						// spanning the shell's depth; past them a tail runs on to the shell's top at a
						// constant density. It runs however faint the light: its depth also shades the
						// sky light below, so a deck skipping it in the twilight, between the moon's
						// light fading out and the sun's reaching it, came out eight times brighter.
						const toTop = float( 1 ).sub( c.h ).mul( SHELL_THICKNESS ).div( max( L.y, 0.05 ) );
						const tau = max( toTop.sub( SHELL_THICKNESS ), 0 ).mul( this.lightTail ).mul( scale ).toVar();
						for ( let i = 0; i < lightTaps; i ++ ) {

							If( tau.lessThan( 32 ), () => {

								const tap = this.lightTaps[ i ];
								tau.addAssign( lightDensity( p.add( tap.xyz ), coverage, max( lods, this.lightLods[ i ] ), cheap ).mul( tap.w ).mul( scale ) );

							} );

						}
						shadowTau.assign( tau );
						shadowAt.assign( t );
						shadowDensity.assign( density );
						shadowCheap.assign( select( cheap, int( 1 ), int( 0 ) ) );

					} );
					// The light's optical depth is scaled by the step's own transmittance (over the
					// finest step's length, held at lightFloor or above): a dense step's light comes mostly from scattering inside it,
					// not down the whole sun path. That and the two lobes stand in for multiple
					// scattering: the forward lobe rules where sunlight still gets through (the
					// margins, the silver lining), the back lobe alone deep in the cloud.
					const lightT = exp( shadowTau.negate() );
					const scaledT = exp( shadowTau.mul( max( this.lightFloor, lightStepT ) ).negate() ).toVar();
					const backShare = mix( float( 1 ), float( LOBE.backShare ), smoothstep( 0, 1, lightT.mul( lightStepT ) ) );
					const phase = mix( forwardLobe, backLobe, backShare );
					const alpha = transmission.mul( float( 1 ).sub( stepT ) ).toVar();
					directLight.addAssign( alpha.mul( scaledT ).mul( phase ) );
					// Sky light: full where the light's path is clear; where it is shadowed, falling to a
					// ramp up the shell (dark bases, bright tops: full at the top).
					ambientLight.addAssign( alpha.mul( height.mul( float( 1 ).sub( scaledT ) ).add( scaledT ) ) );
					if ( flash ) {

						If( this.flashOn.greaterThan( 0.5 ), () => {

							flashColor.addAssign( this.flashLight( p ).mul( alpha ) );

						} );

					}
					weightedDepth.addAssign( alpha.mul( t ) );
					transmission.mulAssign( stepT );
					accumulatedDepth.addAssign( sigmaT.mul( stepLength ) );
					t.addAssign( stepLength );

				} );

			} );
			const alpha = float( 1 ).sub( transmission ).toVar();
			// The factors' colours, from the atmosphere at the shell's height, so the lit sides follow
			// the sun's colour there at any hour and the shaded sides take the sky's colour and depth.
			// Lit: direct x the Mie in-scatter's colour (its chromaticity, desaturated) x each body's
			// light gain. Shaded: the ambient factor, tinted per channel toward the opacity and toned
			// on its log luminance, x the Rayleigh in-scatter under its phase (desaturated) x the
			// earth's shadow there x each body's illuminance x the ambient gain; plus the night's own
			// glow. Both factors are sums over the march, already premultiplied by the opacity.
			If( directLight.add( ambientLight ).greaterThan( 0 ), () => {

				const chroma = ( c: V3 ) => c.div( max( luminance( c ), 1e-20 ) );
				const lit = chroma( sunMie ).mul( this.sunLight ).add( chroma( moonMie ).mul( this.moonLight ) ).mul( directLight );
				const skyOf = ( rows: { rayleigh: V3 }, body: 0 | 1, light: V3, illuminance: V3 ) => desaturate(
					rows.rayleigh.mul( skyRayleighPhase( dot( rd, light ), a.rayleighForward ) ), this.ambientDesaturation )
					.mul( a.earthShadowAt( float( CLOUD_HEIGHT_KM ), rd, body ) ).mul( illuminance );
				const skyLight = skyOf( sunRows, 0, a.sunDir, a.sunIlluminance.rgb ).add( skyOf( moonRows, 1, a.moonDir, a.moonIlluminance.rgb ) )
					.mul( this.ambientGain.mul( AMBIENT ) ).add( this.nightAmbient.rgb.mul( this.ambientGain.mul( AMBIENT ) ) );
				const tinted = mix( vec3( ambientLight ), vec3( alpha ), this.ambientTint ).toVar();
				// tone: log2 luminance moved about a pivot by a slope and a lift, applied as a scale
				const y = log2( max( luminance( tinted ), 1e-12 ) );
				const tone = this.ambientTone;
				const shade = tinted.mul( y.sub( tone.x ).mul( tone.y.sub( 1 ) ).add( tone.z ).exp2() );
				color.assign( lit.add( shade.mul( skyLight ) ) );

			} );
			const depth = select( alpha.greaterThan( 1e-4 ), weightedDepth.div( max( alpha, 1e-4 ) ), start.add( 4000 ) ).toVar();
			// No air of its own: the dome fogs the clouds at their distance (Sky.ts fogDome).
			const L = color;
			// The lightning inside the cloud, kept apart (see buildView).
			const F = flashColor;
			// The march stops once 0.3 % of the light gets through: the rest counts as opaque.
			return { L, F, T: sat( transmission.sub( 0.003 ).div( 0.997 ) ), depth };

		};

		// Distant rain below the cloud base, after VolumetricCloudsCS1's rain march: grey curtains
		// marched along the view ray under the cloud that is raining. A drop at some height left
		// the base upwind of where it is now, so the cloud above is read where the drop came from
		// and the curtains lean with the wind; their streaky texture is the shape noise stretched
		// along the fall and sliding down with it. A raining deck rains everywhere, harder under
		// its richest cells; the tall heaps of a broken sky shower; and after the rain has passed
		// showers linger under the thicker cells. The curtains are lit by the light under the
		// cloud (dark under a thick deck) and by the sun where it reaches them under the clouds,
		// bright from the side; in sunlight opposite the sun they carry the rainbows. They fade
		// into the haze with distance as the clouds do.
		const rainbowNode = texture( this.rainbowTable! );
		// Cloud standing at the shell height h above a camera-relative point, from the weather map
		// and the front alone (the shape noise at its mean): enough to say whether the sun gets
		// through to the rain, or how thick the cloud a drop fell from is.
		const cloudAbove = ( pxz: V2, h: number ) => {

			const w = weatherNode.sample( weatherUV( pxz ) ).level( float( 0 ) ).r;
			const coverage = frontAt( pxz ).x;
			const top = w.add( coverage ).sub( 1 ).add( coverage.mul( 0.45 ) );
			const required = ( 1 - Math.min( h / BASE_WEATHER_END, 1 ) ** 2 * ( 3 - 2 * Math.min( h / BASE_WEATHER_END, 1 ) ) ) * BASE_WEATHER;
			return { w, top, coverage, presence: smoothstep( - EDGE, EDGE, top.sub( h ) ).mul( smoothstep( required - 0.1, required, w ) ) };

		};
		const rainAt = ( rd: V3, pxAngle: F, jitter: F, withFlash = false ) => {

			const radiance = vec3( 0 ).toVar(), flash = vec3( 0 ).toVar();
			const through = float( 1 ).toVar();
			const end = min( layerDistance( this.camY, rd.y, float( SHELL_BOTTOM ) ), RAIN_FAR ).toVar();
			// Nothing to march without rain, lingering showers or a sky broken into heaps.
			const raining = max( max( this.rainFrom, this.rainTo ), max( this.showers, max( this.coverageFrom, this.coverageTo ).sub( 0.5 ).mul( this.heapShowers ) ) );
			If( end.greaterThan( RAIN_START * 2 ).and( rd.y.greaterThan( 0 ) ).and( raining.greaterThan( 0 ) ), () => {

				const L = this.lightDir;
				const cosine = dot( rd, L ).toVar();
				const sun = this.lightColor.rgb.mul( this.directGain ).toVar();
				const hasSun = L.y.greaterThan( 0.01 ).and( max( sun.x, max( sun.y, sun.z ) ).greaterThan( 1e-5 ) ).toVar();
				// Drops scatter forward far more than cloud does, and a little back by their outer
				// reflection; opposite the sun the bows add the colours of the table (relative to
				// isotropic, so the phase is that over 4 pi).
				const bowAt = acos( clamp( cosine.negate(), - 1, 1 ) ).mul( 180 / Math.PI / RAINBOW_MAX_ANGLE ).toVar();
				const secondary = smoothstep( 46 / RAINBOW_MAX_ANGLE, 48 / RAINBOW_MAX_ANGLE, bowAt ).mul( SECONDARY_BOW_GAIN - 1 ).add( 1 );
				const bow = rainbowNode.sample( vec2( min( bowAt, 1 ), 0.5 ) ).level( float( 0 ) ).rgb.mul( secondary ).mul( select( bowAt.lessThan( 1 ), this.rainbow, float( 0 ) ) );
				const grey = min( henyeyGreenstein( cosine, 0.75 ).mul( 4 * Math.PI ), 8 ).mul( 0.85 ).add( 0.15 );
				const phase = bow.mul( BOW_SHARE ).add( grey ).mul( 1 / ( 4 * Math.PI ) ).toVar();
				// The rain has no colour of its own: it takes the light where it falls. From above, the
				// base of the cloud it falls from, lit as the clouds light their own bases (dimmer still
				// under a closed deck); from the sides, the sky toward the horizon in the view
				// direction; from below the dark sea gives back almost nothing. Where the sun reaches
				// the drops they add its light, brightest looking toward it.
				const zenith = skyAt( vec3( 0, 1, 0 ) ).toVar();
				const horizon = horizonRing();
				const closed = smoothstep( 0.7, 0.95, shellCoverage( this.coverage ) ).toVar();
				const deckLight = mix( float( 1 ), float( 0.3 ), closed ).toVar();
				const cloudBase = mix( zenith, horizon, 0.55 ).mul( AMBIENT * 0.25 ).mul( deckLight ).toVar();
				const sideLight = skyAt( normalize( vec3( rd.x.add( 1e-5 ), 0.03, rd.z ) ) ).mul( deckLight ).toVar();
				// Distant curtains fade into the air ahead: toward the sky behind them where it is
				// open, toward the deck's base where a closed deck hides it; under a deck the haze is
				// thinner too (as for the clouds themselves).
				const sky = mix( skyAt( rd ), cloudBase, closed ).toVar();
				const airScale = float( - 1 / AP_DIST ).div( closed.mul( 5 ).add( 1 ) ).toVar();
				const span = end.sub( RAIN_START ).toVar();
				const lean = this.windN.mul( this.rainSlant ).toVar();
				const fall = this.evolve.mul( RAIN_FALL ).toVar();
				const ly = max( L.y, 0.03 ).toVar();
				Loop( rainSteps, ( { i } ) => {

					If( through.lessThan( 0.01 ), () => {

						Break();

					} );
					// Segments lengthen with distance: a shower's edge a kilometre off needs precision,
					// the far end of a 40 km ray does not.
					const t0 = float( i ).div( rainSteps ).pow( 1.8 ).mul( span ).add( RAIN_START ).toVar();
					const dt = float( i ).add( 1 ).div( rainSteps ).pow( 1.8 ).mul( span ).add( RAIN_START ).sub( t0 ).toVar();
					const t = t0.add( dt.mul( jitter ) ).toVar();
					const altitude = this.camY.add( rd.y.mul( t ) ).add( dot( rd.xz, rd.xz ).mul( t ).mul( t ).div( 2 * EARTH_RADIUS ) ).toVar();
					const below = max( float( SHELL_BOTTOM ).sub( altitude ), 0 ).toVar();
					const pxz = rd.xz.mul( t ).toVar();
					// Where the drop left the cloud base, and how much it rains there.
					const source = pxz.sub( lean.mul( below ) ).toVar();
					// The base sits anywhere in the lowest part of the shell, lower under richer weather.
					const above = cloudAbove( source, BASE_WEATHER_END );
					const reached = clamp( this.frontProgress.add( dot( source.add( this.camXZ ), this.frontAxis ).div( FRONT_SPAN ) ), 0, 1 );
					const rain = mix( this.rainFrom, this.rainTo, reached.mul( reached ).mul( float( 3 ).sub( reached.mul( 2 ) ) ) ).toVar();
					// A raining deck rains everywhere, hardest under the richest weather of its cells.
					const core = smoothstep( 0.25, 0.45, above.w );
					const deck = rain.mul( core.mul( core ).mul( 0.75 ).add( 0.25 ) ).mul( above.presence );
					const broken = smoothstep( 0.55, 0.62, above.coverage ).mul( float( 1 ).sub( smoothstep( 0.7, 0.85, above.coverage ) ) );
					const heaps = smoothstep( 0.2, 0.35, above.top ).mul( above.presence ).mul( broken ).mul( this.heapShowers ).mul( 0.4 );
					const linger = max( this.showers.sub( rain ), 0 ).mul( smoothstep( 0.12, 0.3, above.top ) ).mul( above.presence ).mul( 0.5 );
					const amount = max( deck, max( heaps, linger ) ).toVar();
					If( amount.greaterThan( 0.003 ), () => {

						// Uneven curtains: broad lumps, and streaks stretched along the fall, both
						// following the drops' slanted paths and sliding down as they fall.
						const world = source.add( this.camXZ ).add( this.windOffset ).toVar();
						const v = altitude.add( fall ).div( RAIN_PERIOD ).toVar();
						const footprint = t.mul( pxAngle );
						const lumps = shapeNode.sample( vec3( world.x.div( RAIN_LUMPS ), v.div( 6 ), world.y.div( RAIN_LUMPS ) ) ).level( coneLod( footprint, RAIN_LUMPS ) ).r;
						const streaks = shapeNode.sample( vec3( world.x.div( RAIN_STREAK ), v, world.y.div( RAIN_STREAK ) ) ).level( coneLod( footprint, RAIN_STREAK ) ).g;
						const pattern = sat( lumps.mul( 3 ).sub( 1.2 ) ).mul( streaks.mul( streaks ).mul( 2.6 ).add( 0.15 ) );
						// Light showers evaporate on the way down; rain starts at the base, and the
						// nearest is left to the streaks around the camera.
						const reach = float( 1 ).sub( sat( amount.mul( 2.5 ) ) ).mul( 2600 ).sub( 1500 );
						const shape = smoothstep( reach, reach.add( 1500 ), altitude ).mul( smoothstep( 0, 300, below ) ).mul( smoothstep( RAIN_START, RAIN_START * 2.5, t ) );
						const sigma = amount.mul( pattern ).mul( shape ).mul( RAIN_SIGMA ).toVar();
						// The sun reaches the drops where no cloud stands on its way: the base and
						// two heights in the shell, where the beam from this point crosses them.
						const lit = float( 0 ).toVar();
						If( hasSun, () => {

							const reachShell = ( h: number ) => pxz.add( L.xz.mul( below.add( h * SHELL_THICKNESS ).div( ly ) ) );
							const tau = cloudAbove( reachShell( 0.02 ), 0.02 ).presence.add( cloudAbove( reachShell( 0.18 ), 0.18 ).presence )
								.add( cloudAbove( reachShell( 0.4 ), 0.4 ).presence ).mul( 3 );
							lit.assign( exp( tau.negate() ) );

						} );
						// Under the cloud it falls from the rain sees the dark base above (about as bright
						// as the clouds' own base light) and the darker sea below; only a broken sky lets
						// the sky's own light in from the sides.
						// Rain always falls from a cloud: overhead it sees that cloud's base.
						const ambient = cloudBase.mul( 0.4 ).add( sideLight.mul( 0.2 ) ).mul( this.ambientGain ).add( this.nightAmbient.rgb.mul( 0.3 ) );
						const light = sun.mul( phase ).mul( lit ).add( ambient );
						const air = exp( t.mul( airScale ) );
						const alpha = float( 1 ).sub( exp( sigma.mul( dt ).negate() ) ).toVar();
						radiance.addAssign( mix( sky, light, air ).mul( through ).mul( alpha ) );
						// A strike lights the rain around it: added apart from the rest, like the clouds' own
						// flash, so it stays out of the accumulated view.
						if ( withFlash ) If( this.flashOn.greaterThan( 0.5 ), () => {

							const p = vec3( pxz.x, altitude, pxz.y );
							flash.addAssign( this.flashLight( p ).mul( RAIN_FLASH ).mul( air ).mul( through ).mul( alpha ) );

						} );
						through.mulAssign( float( 1 ).sub( alpha ) );

					} );

				} );

			} );
			return { color: vec4( radiance, through ), flash };

		};

		// High cirrus: a thin sheet of ice on the curved Earth, so its fibres converge toward the
		// horizon in true perspective. Coverage varies over tens to hundreds of kilometres with no
		// outlines; baked fibres (Cirrus.ts) follow the upper wind, filtered by the footprint.
		const highAt = ( rd: V3, pxAngle: F ) => {

			const result = vec4( 0, 0, 0, 1 ).toVar();
			If( this.cirrus.greaterThan( 0.01 ).and( rd.y.greaterThan( 0 ) ), () => {

				const t = layerDistance( this.camY, rd.y, float( CIRRUS_ALTITUDE ) ).toVar();
				const sheet = rd.xz.mul( t ).toVar();
				const mu = max( rd.y.add( dot( rd.xz, sheet ).div( EARTH_RADIUS ) ), 0.02 ).toVar();
				// The footprint on the sheet: across the view, and along it stretched by 1 / mu.
				const radial = normalize( rd.xz.add( vec2( 1e-6, 0 ) ) ).toVar();
				const fa = vec2( radial.y.negate(), radial.x ).mul( t.mul( pxAngle ) );
				const fb = radial.mul( t.mul( pxAngle ).div( mu ) );
				// The upper wind veers from the surface wind (about 35 degrees here): the fibres are
				// combed along it.
				const a = this.cirrusAxis, c = Math.cos( UPPER_VEER ), sn = Math.sin( UPPER_VEER );
				const w = vec2( a.x.mul( c ).sub( a.y.mul( sn ) ), a.y.mul( c ).add( a.x.mul( sn ) ) ).toVar();
				const toWind = ( v: V2 ) => vec2( dot( v, w ), dot( v, vec2( w.y.negate(), w.x ) ) );
				const q = toWind( sheet.add( this.camXZ ) ).toVar();
				const syn = synopticNode.sample( q.add( this.cirrusShift.synoptic ).div( SYNOPTIC_SIZE ) ).level( float( 0 ) );
				const cover = smoothstep( 0.15, 0.85, syn.x ).mul( smoothstep( 0.4, 0.72, syn.z ) ).mul( syn.y.mul( 0.4 ).add( 0.6 ) );
				// Fibres at two scales hide the texture's tiling.
				const f1 = sampleCirrusFibres( fibres, q.add( this.cirrusShift.fine ), toWind( fa ), toWind( fb ), FIBRE_FINE.tile, FIBRE_FINE.turn );
				const f2 = sampleCirrusFibres( fibres, q.add( this.cirrusShift.broad ), toWind( fa ), toWind( fb ), FIBRE_BROAD.tile, FIBRE_BROAD.turn );
				const fibre = f1.x.mul( 0.6 ).add( f2.x.mul( 0.4 ) );
				const veil = f1.y.mul( 0.5 ).add( f2.y.mul( 0.5 ) );
				// Faint wisps over a thinner veil; the slant path is bounded so the sheet does not turn
				// into a white band at the horizon.
				const tau = this.cirrus.mul( 1.2 ).mul( cover ).mul( fibre.mul( 0.75 ).add( 0.25 ) ).mul( veil.mul( 0.4 ).add( 0.8 ) ).toVar();
				const alpha = float( 1 ).sub( exp( tau.negate().div( max( mu, 0.25 ) ) ) ).toVar();
				// Ice: a strong forward peak, a faint 22 degree halo, some backscatter; thin cloud is
				// mostly singly scattered.
				const cosine = dot( rd, this.lightDir ).toVar();
				const halfAngle = acos( clamp( cosine, - 1, 1 ) ).sub( 22 * Math.PI / 180 ).div( 0.02 );
				const halo = exp( halfAngle.mul( halfAngle ).negate() ).mul( 0.04 );
				const phase = henyeyGreenstein( cosine, 0.85 ).mul( 0.4 ).add( henyeyGreenstein( cosine, 0.3 ).mul( 0.35 ) )
					.add( henyeyGreenstein( cosine, - 0.15 ).mul( 0.25 ) ).add( halo );
				const through = exp( tau.mul( - 0.5 ).div( max( this.lightDir.y, 0.1 ) ) );
				const sun = this.lightColor.rgb.mul( this.directGain ).mul( this.cirrusSunGain );
				const lit = sun.mul( phase.mul( through ).add( float( 1 ).sub( through ).mul( 0.06 ) ) )
					.add( this.atmosphere.skyRadiance( vec3( 0, 1, 0 ), false ).add( this.nightAmbient.rgb.mul( this.cirrusNightAmbient ) ).mul( 0.9 ) ).mul( alpha );
				// No air of its own: the dome fogs it with the clouds (Sky.ts fogDome).
				result.assign( vec4( lit, float( 1 ).sub( alpha ) ) );

			} );
			return result;

		};

		const domeCone = float( domeTexelAngle );
		const marchPano = makeMarch( panoramaSteps, domeCone, domeCone );
		const pixelCone = this.cam.tan.y.mul( 2 ).div( this.displayHeight );
		// The panorama refreshes a fraction of its texels per frame and feeds bakes that cross-fade
		// over seconds, too slow for a flash: only the view carries the lightning in its march;
		// reflections take it from `flashAt`.
		this.marchView = makeMarch( viewSteps, pixelCone, this.cam.tan.y.mul( 2 ).div( this.viewSize.y ), true );
		this.highAt = highAt;
		this.rainAt = rainAt;
		this.skyAt = skyAt;

		// ---- panorama: a fixed per-texel offset breaks step banding; the tent filter averages it.
		const columns = domeWidth / strideX;
		const dome = this.dome;
		this.partialKernel = Fn( () => {

			const x = instanceIndex.mod( uint( columns ) ).mul( uint( strideX ) ).add( uint( this.phase.x ) );
			const y = instanceIndex.div( uint( columns ) ).mul( uint( strideY ) ).add( uint( this.phase.y ) );
			const q = vec2( float( x ).add( 0.5 ).div( domeWidth ), float( y ).add( 0.5 ).div( domeHeight ) );
			const jitter = fract( sin( dot( vec2( float( x ), float( y ) ), vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			const rd = domeToDirection( q ).toVar();
			const m = marchPano( rd, jitter );
			const result = over( rainAt( rd, float( domeTexelAngle ), jitter ).color, over( vec4( m.L, m.T ), highAt( rd, float( domeTexelAngle ) ) ) );
			textureStore( dome, ivec2( int( x ), int( y ) ), result );

		} )().compute( domeWidth * domeHeight / ( strideX * strideY ), [ 64 ] ).setName( 'Clouds.Panorama' );

		// ---- cloud shadow: transmittance of the shell along the key light around the island, one
		// of every SHADOW_PHASES rows per pass.
		this.shadowKernel = Fn( () => {

			const n = uint( SHADOW_SIZE );
			const x = instanceIndex.mod( n ), y = instanceIndex.div( n ).mul( uint( SHADOW_PHASES ) ).add( uint( this.shadowRow ) );
			const ground = vec2( float( x ), float( y ) ).add( 0.5 ).div( SHADOW_SIZE ).sub( 0.5 ).mul( SHADOW_SPAN ).sub( this.camXZ ).toVar();
			const L = this.lightDir;
			const visibility = float( 1 ).toVar();
			If( this.shadowShare.greaterThan( 0 ), () => {

				const ly = max( L.y, 0.08 );
				const ray = vec3( L.x, ly, L.z ).toVar();
				const t0 = float( SHELL_BOTTOM ).div( ly ), dt = float( SHELL_THICKNESS / 16 ).div( ly ).toVar();
				// (the optical depth at the weather's share of the deck's: `shadowDensity`)
				const tau = float( 0 ).toVar();
				Loop( 16, ( { i } ) => {

					const p = vec3( ground.x, 0, ground.y ).add( ray.mul( t0.add( float( i ).add( 0.5 ).mul( dt ) ) ) ).toVar();
					const front = frontAt( p.xz ).toVar();
					tau.addAssign( lightDensity( p, front.x, vec2( 2 ), false ).mul( front.y ).mul( DENSITY ).mul( this.shadowDensity ).mul( dt ) );
					If( tau.greaterThan( 12 ), () => {

						Break();

					} );

				} );
				// Multiple scattering lets a little light through even thick cloud.
				const cast = exp( tau.negate() ).mul( 0.8 ).add( exp( tau.mul( - 0.25 ) ).mul( 0.2 ) );
				visibility.assign( mix( float( 1 ), cast, this.shadowShare ) );

			} );
			textureStore( this.shadowMap, ivec2( int( x ), int( y ) ), vec4( visibility ) );

		} )().compute( SHADOW_SIZE * SHADOW_SIZE / SHADOW_PHASES, [ 64 ] ).setName( 'Clouds.Shadow' );
		// The view's kernels close over the march: rebuild them on the next update.
		this.disposeView();
		this.needsFull = true;

	}


	/** Build the view buffers for a view size, and the kernels for the first one. Later sizes keep
	 * the kernels and their pipelines: their textures are swapped under them and the sizes they
	 * index by are uniforms, so a resized window (and, on the tiers whose view follows the render
	 * scale, a new scale) builds no compute pipeline mid-play (a kernel rebuilt per size built five). */
	private buildView( width: number, height: number ): void {

		const make = ( w: number, h: number, name: string ) => {

			const t = new THREE.StorageTexture( w, h );
			t.type = THREE.HalfFloatType;
			t.minFilter = t.magFilter = THREE.LinearFilter;
			t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
			t.generateMipmaps = false;
			t.name = name;
			return t;

		};
		const kept = this.view;
		if ( kept ) this.disposeViewTextures( kept );
		const tw = Math.ceil( width / 4 ), th = Math.ceil( height / 4 );
		const trace = make( tw, th, 'cloudTrace' ), depth = make( tw, th, 'cloudTraceDepth' ), high = make( tw, th, 'cloudHighTrace' );
		// A flash lasts a fraction of a second, a pixel's history seconds: averaged in, a flash
		// would be printed in a 4 x 4 pattern and linger as a ghost (the history's clamp cannot
		// catch it in a dark sky). The lightning is kept out of the history and shown from each
		// frame's own trace instead, upsampled; its glow is soft.
		const flashTrace = make( tw, th, 'cloudFlashTrace' );
		const motion = make( tw, th, 'cloudMotion' ), boxMin = make( tw, th, 'cloudBoxMin' ), boxMax = make( tw, th, 'cloudBoxMax' );
		const history = [ make( width, height, 'cloudViewA' ), make( width, height, 'cloudViewB' ) ];
		this.viewSize.value.set( width, height );
		this.traceSize.value.set( tw, th );
		this.traceWidth.value = tw;
		this.viewWidth.value = width;
		const textures: ViewTextures = { trace, depth, high, motion, flash: flashTrace, boxMin, boxMax, history };
		if ( kept ) {

			for ( const [ node, pick ] of kept.slots ) node.value = pick( textures );
			for ( const kernel of [ kept.kernels.trace, kept.kernels.high, kept.kernels.box ] ) kernel.count = tw * th;
			for ( const kernel of kept.kernels.resolve ) kernel.count = width * height;
			this.showView( { width, height, ...textures, kernels: kept.kernels, slots: kept.slots } );
			return;

		}
		// the kernels' texture nodes, kept to swap their textures at the next size
		const slots: ViewSlot[] = [];
		const stored = ( pick: ViewSlot[ 1 ] ) => {

			const node = storageTexture( pick( textures ) );
			slots.push( [ node, pick ] );
			return node;

		};
		const read = ( pick: ViewSlot[ 1 ] ) => {

			const node = texture( pick( textures ) );
			slots.push( [ node, pick ] );
			return node;

		};
		const marchView = this.marchView!, highAt = this.highAt!, rainAt = this.rainAt!, skyAt = this.skyAt!;
		const C = this.cam, P = this.prev;

		const viewDir = ( uv: V2 ) => {

			const ndc = vec2( uv.x.mul( 2 ).sub( 1 ), float( 1 ).sub( uv.y.mul( 2 ) ) ).mul( C.tan );
			return normalize( C.fwd.add( C.right.mul( ndc.x ) ).add( C.up.mul( ndc.y ) ) );

		};
		const tracePixel = () => ivec2( int( instanceIndex.mod( this.traceWidth ) ), int( instanceIndex.div( this.traceWidth ) ) );
		const tracedAt = ( tp: THREE.Node<'ivec2'> ) => vec2( tp ).mul( 4 ).add( this.slot ).add( 0.5 ).add( this.subPixel );
		const hash = ( px: V2 ) => fract( sin( dot( px, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
		const project = ( d: V3, right: V3, upv: V3, fwd: V3, tanv: V2 ) => {

			const z = max( dot( d, fwd ), 1e-4 );
			const ndc = vec2( dot( d, right ), dot( d, upv ) ).div( tanv.mul( z ) );
			return vec2( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ) );

		};

		const traceOut = stored( ( t ) => t.trace ), flashOut = stored( ( t ) => t.flash ), depthOut = stored( ( t ) => t.depth );
		const traceKernel = Fn( () => {

			const tp = tracePixel().toVar();
			const rd = viewDir( tracedAt( tp ).div( this.viewSize ) ).toVar();
			// A random offset per pixel, stepped by the golden ratio over its traces: shared by a block,
			// the pixels' errors would correlate and leave the blocks visible once averaged, and a
			// structured pattern (interleaved gradient noise) leaves diagonal hatching.
			const jitter = fract( hash( vec2( tp ).mul( 4 ).add( this.slot ) ).add( this.frameNoise ) );
			const m = marchView( rd, jitter );
			const rainSample = rainAt( rd, C.tan.y.mul( 2 ).div( this.displayHeight ), jitter, true );
			const rain = rainSample.color.toVar();
			textureStore( traceOut, tp, over( rain, vec4( m.L, m.T ) ) );
			textureStore( flashOut, tp, vec4( m.F.mul( rain.a ).add( rainSample.flash ), 1 ) );
			textureStore( depthOut, tp, vec4( m.depth, float( 1 ).sub( m.T ), 0, 1 ) );

		} )().compute( tw * th, [ 64 ] ).setName( 'Clouds.ViewTrace' );

		const depthNode = read( ( t ) => t.depth );
		const highOut = stored( ( t ) => t.high ), motionOut = stored( ( t ) => t.motion );
		const highKernel = Fn( () => {

			const tp = tracePixel().toVar();
			const rd = viewDir( tracedAt( tp ).div( this.viewSize ) ).toVar();
			const hi = vec4( 0, 0, 0, 1 ).toVar();
			If( rd.y.greaterThan( - 0.01 ), () => {

				hi.assign( highAt( rd, C.tan.y.mul( 2 ).div( this.viewSize.y ) ) );

			} );
			textureStore( highOut, tp, hi );
			// Motion for the resolve: the closest cumulus sample around this block (like the closest
			// depth dilation of TAA), so a cloud's edges move with it and the foreground wins.
			const best = vec3( 1e9, 0, 0 ).toVar();
			const tmax = this.traceSize.sub( 1 );
			for ( let y = - 1; y <= 1; y ++ ) for ( let x = - 1; x <= 1; x ++ ) {

				const dz = textureLoad( depthNode, ivec2( clamp( vec2( tp ).add( vec2( x, y ) ), vec2( 0 ), tmax ) ) ).toVar();
				const key = select( dz.y.greaterThan( 0.15 ), dz.x, float( 1e9 ) );
				If( key.lessThan( best.x ), () => {

					best.assign( vec3( key, dz.x, dz.y ) );

				} );

			}
			If( best.x.greaterThan( 1e8 ), () => {

				const own = textureLoad( depthNode, tp );
				best.assign( vec3( 0, own.x, own.y ) );

			} );
			textureStore( motionOut, tp, vec4( best.y, best.z, 0, 1 ) );

		} )().compute( tw * th, [ 64 ] ).setName( 'Clouds.ViewHigh' );

		const traceNode = read( ( t ) => t.trace ), highNode = read( ( t ) => t.high );
		const boxMinOut = stored( ( t ) => t.boxMin ), boxMaxOut = stored( ( t ) => t.boxMax );
		// The range of this frame's samples is taken over the clouds composited onto the sky: a
		// per-channel range of radiance and transmittance would pair the dark radiance of clear
		// samples with the low transmittance of cloudy ones, an opaque black cloud.
		const boxKernel = Fn( () => {

			const tp = tracePixel().toVar();
			const sky = skyAt( viewDir( tracedAt( tp ).div( this.viewSize ) ) ).toVar();
			const tmax = this.traceSize.sub( 1 );
			const lo = vec4( 1e4 ).toVar(), hi = vec4( - 1e4 ).toVar();
			for ( let y = - 1; y <= 1; y ++ ) for ( let x = - 1; x <= 1; x ++ ) {

				const q = ivec2( clamp( vec2( tp ).add( vec2( x, y ) ), vec2( 0 ), tmax ) );
				const c = over( textureLoad( traceNode, q ), textureLoad( highNode, q ) ).toVar();
				const composite = vec4( c.rgb.add( sky.mul( c.a ) ), c.a );
				lo.assign( min( lo, composite ) );
				hi.assign( max( hi, composite ) );

			}
			textureStore( boxMinOut, tp, lo );
			textureStore( boxMaxOut, tp, hi );

		} )().compute( tw * th, [ 64 ] ).setName( 'Clouds.ViewBox' );

		const motionNode = read( ( t ) => t.motion ), boxMinNode = read( ( t ) => t.boxMin ), boxMaxNode = read( ( t ) => t.boxMax );
		// from history[ src ] into history[ dst ]
		const resolve = ( src: number, dst: number ) => {

			const srcNode = read( ( t ) => t.history[ src ] ), dstOut = stored( ( t ) => t.history[ dst ] );
			return Fn( () => {

				const p = ivec2( int( instanceIndex.mod( this.viewWidth ) ), int( instanceIndex.div( this.viewWidth ) ) ).toVar();
				const uv = vec2( p ).add( 0.5 ).div( this.viewSize ).toVar();
				const rd = viewDir( uv ).toVar();
				const out = vec4( 0, 0, 0, 1 ).toVar();
				If( rd.y.greaterThan( - 0.035 ), () => {

					const tp = p.div( 4 ).toVar();
					const fresh = p.x.mod( 4 ).equal( int( this.slot.x ) ).and( p.y.mod( 4 ).equal( int( this.slot.y ) ) );
					const dz = textureLoad( motionNode, tp ).toVar();
					// Where this cloud point was last frame (camera motion and wind drift): the cumulus,
					// or the high layers where no cumulus is in front.
					const pdC = normalize( rd.mul( dz.x ).add( this.camDelta ) );
					const pdH = normalize( rd.mul( layerDistance( this.camY, rd.y, float( CIRRUS_ALTITUDE ) ) ).add( this.camDeltaHi ) ).toVar();
					const pd = select( dz.y.greaterThan( 0.3 ), pdC, pdH );
					const puv = mix( project( pdH, P.right, P.up, P.fwd, P.tan ), project( pdC, P.right, P.up, P.fwd, P.tan ), smoothstep( 0.1, 0.5, dz.y ) ).toVar();
					const valid = this.historyValid.greaterThan( 0.5 ).and( dot( pd, P.fwd ).greaterThan( 0.01 ) ).and( puv.x.greaterThan( 0 ) ).and( puv.x.lessThan( 1 ) )
						.and( puv.y.greaterThan( 0 ) ).and( puv.y.lessThan( 1 ) ).and( pd.y.greaterThan( - 0.05 ) ).toVar();
					// This frame's samples upsampled (they sit at the slot of each block).
					const suv = vec2( p ).sub( this.slot ).div( 4 ).add( 0.5 ).div( this.traceSize ).toVar();
					const upsampled = over( traceNode.sample( suv ).level( float( 0 ) ), highNode.sample( suv ).level( float( 0 ) ) ).toVar();
					If( valid, () => {

						// Reprojected history clamped to the range of this frame's samples around it (with
						// a margin): real changes cannot leave ghosts, so samples average over many frames.
						const h = max( catmullRom( srcNode, puv, this.viewSize ), vec4( 0 ) ).toVar();
						const lo = textureLoad( boxMinNode, tp ), hi = textureLoad( boxMaxNode, tp );
						const pad = hi.sub( lo ).mul( 0.25 ).add( 0.01 );
						const sky = skyAt( rd ).toVar();
						const clamped = clamp( vec4( h.rgb.add( sky.mul( h.a ) ), h.a ), lo.sub( pad ), hi.add( pad ) ).toVar();
						const kept = vec4( max( clamped.rgb.sub( sky.mul( clamped.a ) ), vec3( 0 ) ), clamped.a );
						out.assign( select( this.rebuildK.lessThan( 0 ).and( this.clampHistory.greaterThan( 0.5 ) ), kept, h ) );

					} ).Else( () => {

						out.assign( upsampled );

					} );
					If( fresh, () => {

						const cur = over( textureLoad( traceNode, tp ), textureLoad( highNode, tp ) );
						// Average the jittered samples over time; a little shorter where clouds move fast on
						// screen. Rebuilding after a cut, each pixel takes its own first sample as is.
						const motionPx = length( puv.sub( uv ).mul( this.viewSize ) );
						const a = clamp( motionPx.mul( 0.1 ).add( this.minAlpha ), this.minAlpha, 0.35 );
						out.assign( select( valid.and( this.rebuildK.lessThan( 0 ) ), mix( out, cur, a ), cur ) );

					} ).ElseIf( this.rebuildK.greaterThanEqual( 0 ).and( valid ), () => {

						// Pixels without their own sample since the cut average the upsampled samples of
						// every slot traced so far (their refresh rank is the 4 x 4 Bayer index).
						const x = float( p.x.mod( 4 ) ), y = float( p.y.mod( 4 ) );
						const b2 = ( a: F, b: F ) => abs( a.sub( b ) ).mul( 2 ).add( b );
						const rank = b2( x.mod( 2 ), y.mod( 2 ) ).mul( 4 ).add( b2( floor( x.div( 2 ) ), floor( y.div( 2 ) ) ) );
						If( rank.greaterThan( this.rebuildK ), () => {

							out.assign( mix( out, upsampled, float( 1 ).div( this.rebuildK.add( 1 ) ) ) );

						} );

					} );

				} );
				textureStore( dstOut, p, vec4( out.rgb, clamp( out.a, 0, 1 ) ) );

			} )().compute( width * height, [ 64 ] ).setName( 'Clouds.ViewResolve' );

		};
		this.showView( {
			width, height, ...textures, slots,
			kernels: { trace: traceKernel, high: highKernel, box: boxKernel, resolve: [ resolve( 1, 0 ), resolve( 0, 1 ) ] },
		} );

	}

	// the view's new buffers in use, its history started over
	private showView( view: View ): void {

		this.view = view;
		this.viewNode.value = view.history[ 0 ];
		this.flashNode.value = view.flash;
		this.viewValid.value = 0;
		this.resetHistory();

	}

	/** Advance the clouds for a frame: the panorama, the shadow map, the distance field after a
	 * coverage change, and the view as seen by `camera` (its drawing buffer `width` by `height`).
	 * `time` is the scene clock: a still camera over a paused clock stops tracing once the view
	 * has converged, so a paused frame is exactly repeatable. */
	update( renderer: THREE.WebGPURenderer, camera: THREE.PerspectiveCamera | null, width: number, height: number, time: number ): void {

		if ( ! this.partialKernel || ! this.shadowKernel ) return;
		// debugFlags.cloudShadowRows = 4 restores the old rate (a quarter of the rows per frame).
		const rowsFlag = debugFlags.cloudShadowRows;
		const shadowRows = typeof rowsFlag === 'number' && Number.isFinite( rowsFlag ) && rowsFlag > 0 ? 1 / rowsFlag : this.shadowRowsPerFrame;
		// Before the first frame there is no view yet, only the panorama for the first bake.
		const position = camera ? camera.position : this.origin.value;
		this.origin.value.copy( position );
		// The march assumes a camera below the cloud base.
		this.camY.value = THREE.MathUtils.clamp( position.y, 1, SHELL_BOTTOM - 50 );
		this.camXZ.value.set( position.x, position.z );
		this.windN.value.copy( this.cirrusAxis.value );
		this.updateLightTaps();
		// Panorama: an ordered pattern spreads each frame's texels over the map. A full refresh runs
		// every phase through the same kernel, so a refreshed map matches a progressive one.
		const full = this.needsFull;
		this.needsFull = false;
		this.refreshMaps( renderer, full, shadowRows );

		if ( ! camera ) return;
		// ---- view
		const [ w, h ] = this.viewDimensions( width, height );
		if ( ! this.view || this.view.width !== w || this.view.height !== h ) this.buildView( w, h );
		this.displayHeight.value = Math.max( 4, height );
		const e = camera.matrixWorld.elements;
		const tanY = Math.tan( THREE.MathUtils.degToRad( camera.fov * 0.5 ) ) / ( camera.zoom || 1 );
		const C = this.cam, P = this.prev;
		P.right.value.copy( C.right.value ); P.up.value.copy( C.up.value ); P.fwd.value.copy( C.fwd.value ); P.tan.value.copy( C.tan.value );
		C.right.value.set( e[ 0 ], e[ 1 ], e[ 2 ] ).normalize();
		C.up.value.set( e[ 4 ], e[ 5 ], e[ 6 ] ).normalize();
		C.fwd.value.set( - e[ 8 ], - e[ 9 ], - e[ 10 ] ).normalize();
		C.tan.value.set( tanY * camera.aspect, tanY );
		// Camera cuts (teleports, big turns, jumps of the key light, zoom) restart the history.
		const moved = this.hasPrevious ? position.distanceTo( this.previousCamera ) : Infinity;
		this.turned = C.fwd.value.angleTo( P.fwd.value );
		const key = this.lightDir.value;
		if ( full || moved > 8 || this.turned > 0.5 || key.angleTo( this.previousKey ) > 0.05 || Math.abs( C.tan.value.y - P.tan.value.y ) > 1e-3 * C.tan.value.y ) this.resetHistory();
		this.previousKey.copy( key );
		// Camera motion since the last frame minus the clouds' drift. The field is sampled at
		// position + offset, so the clouds move by minus the offset's change.
		const step = this.hasPrevious ? this.displacement.clone().sub( this.previousDisplacement ) : new THREE.Vector2();
		const low = driftOffset( step, LOW_DRIFT, LOW_VEER ), high = driftOffset( step, HIGH_DRIFT, UPPER_VEER );
		const dx = this.hasPrevious ? position.x - this.previousCamera.x : 0, dy = this.hasPrevious ? position.y - this.previousCamera.y : 0;
		const dz = this.hasPrevious ? position.z - this.previousCamera.z : 0;
		this.camDelta.value.set( dx + low.x, dy, dz + low.y );
		this.camDeltaHi.value.set( dx + high.x, dy, dz + high.y );
		// At rest: a paused clock and a still camera (a jump in weather or time while paused still
		// counts, and settles at once).
		// A change of lightning while paused (a review strike) retraces the view, so its flash is current.
		const flash = this.flash.map( ( { source, color } ) => `${ source.value.toArray() },${ color.value.toArray() }` ).join( ';' );
		const resting = this.hasPrevious && moved <= 1e-4 && this.turned <= 1e-6 && time === this.previousTime && flash === this.previousFlash;
		this.previousFlash = flash;
		this.previousCamera.copy( position );
		this.previousDisplacement.copy( this.displacement );
		this.previousTime = time;
		this.hasPrevious = true;

		if ( resting && ( ! this.settled || full ) ) {

			// The scene has come to rest: settle the view once, from scratch, then keep it. Depending
			// only on the scene, a paused frame is exactly repeatable. The panorama and the shadow map
			// (camera-relative, refreshed a share per frame) are brought up to date with it, so a
			// paused frame does not wait out their refresh cycles after a camera move.
			if ( ! full ) this.refreshMaps( renderer, true, 1 );
			this.settle( renderer );

		} else if ( this.rebuild < 16 ) {

			// After a cut: several slots per frame, until every pixel has a sample of its own.
			for ( let k = 0; k < REBUILD_SLOTS && this.rebuild < 16; k ++ ) {

				if ( k > 0 ) this.holdCamera();
				this.rebuildK.value = this.rebuild;
				this.trace( renderer, ORDER[ this.rebuild ++ ] );

			}

		} else if ( ! resting ) {

			this.settled = false;
			const slots = this.turned > 0.003 ? 2 : 1;
			this.rebuildK.value = - 1;
			// A running average while a pixel has few samples, then an exponential one; the count
			// advances once per frame, however many slots the frame traces.
			const n = 1 + Math.floor( this.since ++ / 16 );
			this.minAlpha.value = Math.max( 0.12, 1 / ( n + 1 ) );
			for ( let k = 0; k < slots; k ++ ) {

				if ( k > 0 ) this.holdCamera();
				// A turning camera traces a second slot per frame, so the reprojected history stays sharp.
				this.trace( renderer, ORDER[ ( this.frame + k * 8 ) % 16 ] );

			}

		}
		this.frame ++;

	}

	// Refresh the panorama and the cloud shadow map: whole, or this frame's share (one phase of the
	// panorama's pattern, `shadowRows` of the shadow map's rows).
	private refreshMaps( renderer: THREE.WebGPURenderer, full: boolean, shadowRows: number ): void {

		const order = this.domeOrder;
		for ( const [ x, y ] of full ? order : [ order[ this.frame % order.length ] ] ) {

			this.phase.value.set( x, y );
			renderer.compute( this.partialKernel! );

		}
		const passes = full ? SHADOW_PHASES : Math.min( SHADOW_PHASES, Math.max( 1, Math.round( shadowRows * SHADOW_PHASES ) ) );
		const first = full ? 0 : ( this.frame * passes ) % SHADOW_PHASES;
		for ( let k = 0; k < passes; k ++ ) {

			this.shadowRow.value = SHADOW_ORDER[ ( first + k ) % SHADOW_PHASES ];
			renderer.compute( this.shadowKernel! );

		}

	}

	// Trace one slot of every 4 x 4 block and resolve it into the history.
	private trace( renderer: THREE.WebGPURenderer, order: number ): void {

		const view = this.view!;
		this.slot.value.set( order % 4, Math.floor( order / 4 ) );
		// R2 sequence over the traces (one offset per 16-frame cycle, so each pixel sees them all),
		// and a golden-ratio march offset per cycle: every trace of a pixel gets a new offset.
		const n = Math.floor( this.traces / 16 ) + 1;
		this.subPixel.value.set( ( ( 0.5 + n * 0.7548776662 ) % 1 ) - 0.5, ( ( 0.5 + n * 0.5698402910 ) % 1 ) - 0.5 ).multiplyScalar( 0.25 );
		this.frameNoise.value = ( n * 0.6180339887 ) % 1;
		this.traces ++;
		renderer.compute( view.kernels.trace );
		renderer.compute( view.kernels.high );
		renderer.compute( view.kernels.box );
		renderer.compute( view.kernels.resolve[ this.pingPong ] );
		this.viewNode.value = view.history[ this.pingPong ];
		this.pingPong = 1 - this.pingPong;
		this.historyValid.value = 1;
		const C = this.cam, V = this.viewCam;
		V.right.value.copy( C.right.value ); V.up.value.copy( C.up.value ); V.fwd.value.copy( C.fwd.value ); V.tan.value.copy( C.tan.value );
		this.viewValid.value = 1;

	}

	// Rebuild the view and average SETTLE_CYCLES samples per pixel in one go, with the trace
	// sequence restarted, so the result depends only on the scene.
	private settle( renderer: THREE.WebGPURenderer ): void {

		this.resetHistory();
		this.traces = 0;
		this.holdCamera();
		this.clampHistory.value = 0;
		for ( let k = 0; k < 16; k ++ ) {

			this.rebuildK.value = k;
			this.trace( renderer, ORDER[ k ] );

		}
		this.rebuildK.value = - 1;
		for ( let k = 16; k < 16 * SETTLE_CYCLES; k ++ ) {

			this.minAlpha.value = 1 / ( Math.floor( k / 16 ) + 1 );
			this.trace( renderer, ORDER[ k % 16 ] );

		}
		this.clampHistory.value = 1;
		this.rebuild = 16;
		this.settled = true;

	}

	// No camera motion between the traces of one frame.
	private holdCamera(): void {

		const C = this.cam, P = this.prev;
		P.right.value.copy( C.right.value ); P.up.value.copy( C.up.value ); P.fwd.value.copy( C.fwd.value ); P.tan.value.copy( C.tan.value );
		this.camDelta.value.set( 0, 0, 0 );
		this.camDeltaHi.value.set( 0, 0, 0 );

	}

	// The light march toward the key light: segments growing by LIGHT_GROWTH, the first sized so
	// that together they span the shell's depth, spread over a narrow cone (golden-angle spiral) and
	// read at mip levels matching their spacing.
	private updateLightTaps(): void {

		const L = this.lightDir.value;
		const tangent = Math.abs( L.y ) > 0.99 ? new THREE.Vector3( 0, - L.z, L.y ) : new THREE.Vector3( L.z, 0, - L.x );
		tangent.normalize();
		const bitangent = new THREE.Vector3().crossVectors( L, tangent );
		const taps = this.march.lightTaps;
		const first = SHELL_THICKNESS * ( LIGHT_GROWTH - 1 ) / ( LIGHT_GROWTH ** taps - 1 );
		for ( let k = 0; k < taps; k ++ ) {

			const length = first * LIGHT_GROWTH ** k, mid = first * ( LIGHT_GROWTH ** k - 1 ) / ( LIGHT_GROWTH - 1 ) + length * 0.5;
			const angle = ( k + 1 ) * 2.399963, radius = Math.sqrt( ( k + 1.5 ) / ( taps + 1 ) ) * 0.05 * mid;
			const u = Math.cos( angle ) * radius, v = Math.sin( angle ) * radius;
			this.lightTaps[ k ].value.set(
				L.x * mid + tangent.x * u + bitangent.x * v, L.y * mid + tangent.y * u + bitangent.y * v,
				L.z * mid + tangent.z * u + bitangent.z * v, length );
			const footprint = mid * 0.1;
			this.lightLods[ k ].value.set( Math.max( 0, Math.log2( footprint * 64 / BASE_SCALE ) ), Math.max( 0, Math.log2( footprint * 64 / EROSION_SCALE ) ) );

		}

	}

	/** Restart the view accumulation, rebuilding it at full rate over the next frames. */
	resetHistory(): void {

		this.rebuild = 0;
		this.since = 0;
		this.settled = false;
		this.historyValid.value = 0;

	}

	/** The next update recomputes the whole panorama and restarts the view, e.g. after a jump in
	 * time or weather. */
	invalidate(): void {

		this.needsFull = true;
		this.resetHistory();

	}

	/** Back to the state before the page's first frame (a scene jump, through Sky.reset): the wind's
	 * offset, the evolution, the front's and cirrus' axes and the viewer as constructed, no view
	 * history, the frame count at zero and a whole refresh due. The first bake of a page computes the
	 * panorama in that state, and the bake products keep it while the clock is paused. */
	restart(): void {

		this.evolve.value = 0;
		this.setDrift( new THREE.Vector2() );
		this.frontAxis.value.set( 1, 0 );
		this.cirrusAxis.value.set( 1, 0 );
		this.origin.value.set( 0, 15, 0 );
		for ( const { source, color } of this.flash ) {

			source.value.set( 0, - 1e6, 0, 1 );
			color.value.setRGB( 0, 0, 0 );

		}
		this.flashOn.value = 0;
		this.frame = 0;
		this.pingPong = 0;
		this.traces = 0;
		this.turned = 0;
		this.hasPrevious = false;
		this.previousCamera.set( 0, 0, 0 );
		this.previousKey.set( 0, 0, 0 );
		this.previousDisplacement.set( 0, 0 );
		this.previousTime = 0;
		this.previousFlash = '';
		if ( this.view ) this.viewNode.value = this.view.history[ 0 ];
		this.viewValid.value = 0;
		this.invalidate();

	}

	/** In-scattered radiance (rgb) and transmittance (a) of the clouds in a direction, from the
	 * panorama: reflections, the environment and the sun's visibility. A small tent filter over
	 * four bilinear taps hides the per-texel march offsets. */
	sample( direction: V3 ): V4 {

		const q = directionToDome( direction ).toVar();
		const texel = this.domeTexel;
		const tap = ( x: number, y: number ) => this.domeNode.sample( q.add( texel.mul( vec2( x, y ) ) ) ).level( float( 0 ) );
		const s = tap( - 1, - 1 ).add( tap( 1, - 1 ) ).add( tap( - 1, 1 ) ).add( tap( 1, 1 ) ).mul( 0.25 ).toVar();
		// The map holds the upper sky only: below the horizon the clouds fade out instead of
		// repeating the horizon's row.
		const below = smoothstep( - 0.04, 0, direction.y );
		return vec4( s.rgb.mul( below ), mix( float( 1 ), s.a, below ) );

	}

	// Light from the lightning sources at a camera-relative point: an inverse-square core,
	// softened so a source never blows out, times an exponential reach standing in for the cloud
	// the light crosses (VolumetricCloudsCS1's Lightning()). There is no march toward the source:
	// added inside the front-to-back march, the cloud between the glow and the viewer dims it, so
	// a flash reads as coming from within the cloud.
	private flashLight( p: V3 ): V3 {

		const world = vec3( p.x.add( this.camXZ.x ), p.y, p.z.add( this.camXZ.y ) ).toVar();
		let sum: V3 = vec3( 0 );
		for ( const { source, color } of this.flash ) {

			const r = length( world.sub( source.xyz ) );
			const core = source.w.mul( 0.2 );
			sum = sum.add( color.mul( exp( r.div( source.w ).negate() ).div( r.mul( r ).div( core.mul( core ) ).add( 1 ) ) ) );

		}
		return sum;

	}

	/** Light of the lightning inside the clouds in a direction, for reflections and directions
	 * outside the view: the march's light where the ray enters the cloud deck, times the cloud's
	 * `opacity` there (the dome fogs it with the clouds). Without texture lookups it costs the
	 * water shader no sampler. */
	flashAt( direction: V3, opacity: F ): V3 {

		const result = vec3( 0 ).toVar();
		If( this.flashOn.greaterThan( 0.5 ).and( direction.y.greaterThan( 0 ) ), () => {

			// A little above the base, where the march gathers most of a thick deck's light.
			const t = layerDistance( this.camY, direction.y, float( SHELL_BOTTOM + 150 ) ).toVar();
			const p = vec3( direction.x.mul( t ), this.camY.add( direction.y.mul( t ) ), direction.z.mul( t ) );
			result.assign( this.flashLight( p ).mul( opacity ).mul( smoothstep( 0, 0.04, direction.y ) ) );

		} );
		return result;

	}

	/** The clouds as seen directly: the view, upsampled bicubically and looked up with the camera
	 * it was traced with; directions outside it, or a view without data yet, take the panorama. */
	sampleView( direction: V3 ): V4 {

		const V = this.viewCam;
		const result = vec4( 0 ).toVar();
		const z = dot( direction, V.fwd ).toVar();
		const ndc = vec2( dot( direction, V.right ), dot( direction, V.up ) ).div( V.tan.mul( max( z, 1e-4 ) ) );
		const uv = vec2( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ) ).toVar();
		If( this.viewValid.greaterThan( 0.5 ).and( z.greaterThan( 0.01 ) ).and( uv.x.greaterThanEqual( 0 ) ).and( uv.x.lessThanEqual( 1 ) )
			.and( uv.y.greaterThanEqual( 0 ) ).and( uv.y.lessThanEqual( 1 ) ), () => {

			const v = max( catmullRom( this.viewNode, uv, this.viewSize ), vec4( 0 ) );
			// The last trace's samples sit at its slot and sub-pixel offset in each 4 x 4 block.
			const fuv = uv.mul( this.viewSize ).sub( this.slot ).sub( this.subPixel ).sub( 0.5 ).div( 4 ).add( 0.5 ).div( this.traceSize );
			const flash = this.flashNode.sample( fuv ).level( float( 0 ) ).rgb.mul( this.flashOn );
			const above = smoothstep( - 0.05, - 0.03, direction.y );
			result.assign( vec4( v.rgb.add( flash ).mul( above ), mix( float( 1 ), min( v.a, 1 ), above ) ) );

		} ).Else( () => {

			// Only outside the view (or before it has data) does the panorama show, so only there
			// are its taps and the lightning's light evaluated.
			const panorama = this.sample( direction ).toVar();
			result.assign( vec4( panorama.rgb.add( this.flashAt( direction, float( 1 ).sub( panorama.a ) ) ), panorama.a ) );

		} );
		return result;

	}

	/** Review aid: the cosine-weighted fraction of the upper sky behind cloud (transmittance
	 * under one half) in the panorama. */
	async skyCoverage( renderer: THREE.WebGPURenderer ): Promise<number> {

		const width = 256, height = 64;
		const target = new THREE.RenderTarget( width, height, { type: THREE.FloatType, depthBuffer: false } );
		const material = new THREE.NodeMaterial();
		material.depthTest = material.depthWrite = false;
		material.toneMapped = false;
		material.fragmentNode = vec4( this.domeNode.sample( uv() ).level( float( 0 ) ).a );
		const quad = new THREE.QuadMesh( material );
		const previous = renderer.getRenderTarget();
		renderer.setRenderTarget( target );
		quad.render( renderer );
		renderer.setRenderTarget( previous );
		const pixels = await renderer.readRenderTargetPixelsAsync( target, 0, 0, width, height ) as Float32Array;
		let covered = 0, total = 0;
		for ( let y = 0; y < height; y ++ ) {

			// Rows may come back flipped; the weight is symmetric in neither, so use the row's own uv.
			const v = ( y + 0.5 ) / height, lat = v * v * Math.PI / 2;
			const weight = Math.cos( lat ) * Math.sin( lat ) * v;
			for ( let x = 0; x < width; x ++ ) {

				total += weight;
				if ( pixels[ ( y * width + x ) * 4 ] < 0.5 ) covered += weight;

			}

		}
		target.dispose();
		material.dispose();
		return covered / total;

	}

	/** Direct-light visibility under the clouds at a world position. */
	shadow( worldPosition: V3 ): F {

		const q = worldPosition.xz.div( SHADOW_SPAN ).add( 0.5 ).toVar();
		// a cubic B-spline over the map's 47 m texels, from four bilinear taps (Sigg and Hadwiger,
		// "Fast Third-Order Texture Filtering", GPU Gems 2, ch. 20): the shadow's edges stay round
		// where a bilinear lookup draws straight segments and diamonds tens of metres long
		const c = q.mul( SHADOW_SIZE ).sub( 0.5 ).toVar();
		const i = floor( c ).toVar(), f = c.sub( i ).toVar();
		const f2 = f.mul( f ).toVar(), f3 = f2.mul( f ).toVar();
		const w0 = f.oneMinus().mul( f.oneMinus() ).mul( f.oneMinus() ).div( 6 );
		const w1 = f3.mul( 3 ).sub( f2.mul( 6 ) ).add( 4 ).div( 6 ).toVar();
		const w2 = f.mul( 3 ).add( f2.mul( 3 ) ).sub( f3.mul( 3 ) ).add( 1 ).div( 6 );
		const w3 = f3.div( 6 ).toVar();
		const g0 = w0.add( w1 ).toVar(), g1 = w2.add( w3 ).toVar();
		// the taps' texel centres, i + 0.5 moved by h0 = w1 / g0 - 1 and h1 = w3 / g1 + 1
		const p0 = i.add( 0.5 ).add( w1.div( g0 ).sub( 1 ) ).div( SHADOW_SIZE ).toVar();
		const p1 = i.add( 0.5 ).add( w3.div( max( g1, 1e-6 ) ).add( 1 ) ).div( SHADOW_SIZE ).toVar();
		const tap = ( x: F, y: F ): F => texture( this.shadowMap, vec2( x, y ) ).level( float( 0 ) ).r;
		const s = mix(
			mix( tap( p0.x, p0.y ), tap( p1.x, p0.y ), g1.x ),
			mix( tap( p0.x, p1.y ), tap( p1.x, p1.y ), g1.x ),
			g1.y,
		);
		// The direct beam takes the full transmittance: the sky light already fills a cloud's shadow,
		// and even a sixth of the sun left on the water glitters through a closed deck. The map holds
		// no data beyond its edge, so the shadow fades out toward it (shadowFadeAt).
		return mix( s, float( 1 ), this.shadowFadeAt( q, worldPosition ) );

	}

	/** The shadow map read for the point `p` of the air (the haze's shafts, VolumetricHaze.ts): the
	 * map holds each ground point's flat beam toward `lightDir`, its slope clamped at 0.08, so p is
	 * taken down that same beam to its ground point, p.xz - L.xz p.y / max( L.y, 0.08 ). Returns
	 * ( the map's bilinear sample, its bicubic B-spline blur ), both faded toward lit as `shadow()`
	 * fades them for p (the edge of the map, the distance and direction fades). The blur takes four
	 * bilinear taps (Sigg and Hadwiger, "Fast Third-Order Texture Filtering", GPU Gems 2, 2005); the
	 * B-spline smooths rather than interpolates (it does not pass through the texels' values), as a
	 * blur for the unsharp mask should. */
	shadowAlongBeam( p: V3 ): V2 {

		const L = this.lightDir, shadowed = p;
		const ground = p.xz.sub( L.xz.mul( p.y.div( max( L.y, 0.08 ) ) ) );
		const q = ground.div( SHADOW_SPAN ).add( 0.5 ).toVar();
		const map = this.shadowMap;
		const point = texture( map, q ).level( float( 0 ) ).r;
		const coord = q.mul( SHADOW_SIZE ).sub( 0.5 ).toVar();
		const index = floor( coord ).toVar();
		const f = coord.sub( index ).toVar();
		const f2 = f.mul( f ), f3 = f2.mul( f );
		const w0 = f3.negate().add( f2.mul( 3 ) ).sub( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w1 = f3.mul( 3 ).sub( f2.mul( 6 ) ).add( 4 ).div( 6 );
		const w2 = f3.mul( - 3 ).add( f2.mul( 3 ) ).add( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w3 = f3.div( 6 );
		const g0 = w0.add( w1 ).toVar(), g1 = w2.add( w3 );
		const h0 = index.sub( 0.5 ).add( w1.div( g0 ) ).div( SHADOW_SIZE ).toVar();
		const h1 = index.add( 1.5 ).add( w3.div( g1 ) ).div( SHADOW_SIZE ).toVar();
		const tap = ( a: V2, b: V2 ) => texture( map, vec2( a.x, b.y ) ).level( float( 0 ) ).r;
		const blur = mix( mix( tap( h1, h1 ), tap( h0, h1 ), g0.x ), mix( tap( h1, h0 ), tap( h0, h0 ), g0.x ), g0.y );
		const lit = this.shadowFadeAt( q, shadowed );
		return mix( vec2( point, blur ), vec2( 1 ), lit );

	}

	// How far a shadow read at map coordinate q for the point `shadowed` fades toward lit: toward
	// the map's edge, where it holds no data, and by the distance and direction fades (shadowFade).
	private shadowFadeAt( q: V2, shadowed: V3 ): F {

		const edge = abs( q.sub( 0.5 ) );
		const outside = smoothstep( 0.42, 0.5, max( edge.x, edge.y ) );
		// Far and grazing shadows fade toward lit, so they do not dim the island wrongly: by the
		// squared horizontal distance from the island's centre, and by the squared distance of the
		// direction to the point (from the camera) from a chosen one (shadowFade, shadowFadeDirection).
		const f = this.shadowFade;
		const r = shadowed.xz.sub( this.shadowCentre );
		const toPoint = shadowed.sub( this.origin ).toVar();
		const d = toPoint.div( max( length( toPoint ), 1e-6 ) ).sub( this.shadowFadeDirection );
		const fade = max( sat( dot( r, r ).mul( f.x ).add( f.y ) ), sat( dot( d, d ).mul( f.z ).add( f.w ) ) );
		return max( outside, fade );

	}

	/** The weather's cloud coverage over a world position (x, z), as the front has swept it in
	 * (the CPU twin of the march's front, without the weather map). */
	coverageAt( x: number, z: number ): number {

		const axis = this.frontAxis.value;
		const reached = THREE.MathUtils.clamp( this.frontProgress.value + ( x * axis.x + z * axis.y ) / FRONT_SPAN, 0, 1 );
		const sweep = reached * reached * ( 3 - 2 * reached );
		return THREE.MathUtils.lerp( this.coverageFrom.value, this.coverageTo.value, sweep );

	}

	/** Drift the clouds by the surface wind's integrated displacement (metres downwind; Wind.ts
	 * `displacement`): a function of the wind's state alone, so a paused frame and a seek draw the
	 * same sky. Set `cirrusAxis` first: the cirrus' shift is kept in its fibres' frame. */
	/** Each layer's sampling offset before wrapping, from the displacement setDrift was last given:
	 * the layer moves by minus its change (the wind probe's W5 reads the drifts off these). */
	layerOffsets(): { cumulus: THREE.Vector2; cirrus: THREE.Vector2 } {

		return { cumulus: driftOffset( this.displacement, LOW_DRIFT, LOW_VEER ), cirrus: driftOffset( this.displacement, HIGH_DRIFT, UPPER_VEER ) };

	}

	setDrift( displacement: THREE.Vector2 ): void {

		this.displacement.copy( displacement );
		const wrap = ( v: number, period: number ) => v - period * Math.round( v / period );
		const low = driftOffset( displacement, LOW_DRIFT, LOW_VEER );
		this.windOffset.value.set( wrap( low.x, TILE ), wrap( low.y, TILE ) );
		// The cirrus in the frame its shader samples in (toWind), wrapped per texture: the scales
		// do not nest, and an offset wrapped on one period would jump the others.
		const high = driftOffset( displacement, HIGH_DRIFT, UPPER_VEER );
		const w = this.cirrusAxis.value.clone().normalize().rotateAround( new THREE.Vector2(), UPPER_VEER );
		const qx = high.x * w.x + high.y * w.y, qy = high.y * w.x - high.x * w.y;
		const { synoptic, fine, broad } = this.cirrusShift;
		synoptic.value.set( wrap( qx, SYNOPTIC_SIZE ), wrap( qy, SYNOPTIC_SIZE ) );
		const fibres = ( shift: THREE.Vector2, { tile, turn }: { tile: number; turn: number } ) => {

			// wrapped on the tile's lattice, which sampleCirrusFibres turns by `turn`
			const c = Math.cos( turn ), s = Math.sin( turn );
			const u = wrap( qx * c + qy * s, tile ), v = wrap( qy * c - qx * s, tile );
			shift.set( u * c - v * s, u * s + v * c );

		};
		fibres( fine.value, FIBRE_FINE );
		fibres( broad.value, FIBRE_BROAD );

	}

	dispose(): void {

		this.dome.dispose();
		this.shadowMap.dispose();
		for ( const t of [ this.shape, this.synoptic, this.weather, this.bounds, this.rainbowTable ] ) t?.dispose();
		this.cirrusFibres?.dispose();
		this.partialKernel?.dispose();
		this.shadowKernel?.dispose();
		this.disposeView();

	}

	private disposeView(): void {

		const view = this.view;
		if ( ! view ) return;
		this.disposeViewTextures( view );
		for ( const kernel of [ view.kernels.trace, view.kernels.high, view.kernels.box, ...view.kernels.resolve ] ) kernel.dispose();
		this.view = null;
		this.viewValid.value = 0;

	}

	private disposeViewTextures( view: ViewTextures ): void {

		for ( const t of [ view.trace, view.depth, view.high, view.motion, view.flash, view.boxMin, view.boxMax, ...view.history ] ) t.dispose();

	}

	// The view's size for a render of width x height pixels (see CloudViewScale).
	private viewDimensions( width: number, height: number ): [ number, number ] {

		const override = debugFlags.cloudViewScale;
		const scale = typeof override === 'number' ? { render: override } : this.viewScale;
		let w: number, h: number;
		if ( 'render' in scale ) {

			w = width * scale.render;
			h = height * scale.render;

		} else {

			// A share (at most 1) of the render high draws at its nominal ratio. The size follows the
			// display alone, not the render: high's dynamic resolution moves the render's scale, and a
			// view that followed it would be rebuilt, with its kernels, at every step.
			const nominal = Math.min( this.display.ratio, 1.5 ) * scale.display;
			w = this.display.width * nominal;
			h = this.display.height * nominal;

		}
		return [ Math.max( 8, Math.round( w ) ), Math.max( 8, Math.round( h ) ) ];

	}

	/** The display the view's budget refers to (CSS pixels and the canvas's pixel ratio). */
	setDisplay( width: number, height: number, ratio: number ): void {

		this.display.width = width;
		this.display.height = height;
		this.display.ratio = ratio;

	}

	/** The view's resolution, as a fraction of the render or of the display (CloudViewScale). A
	 * new size rebuilds the view on the next update. */
	setViewScale( scale: CloudViewScale ): void {

		const value = 'render' in scale ? scale.render : scale.display;
		if ( ! ( value > 0 && value <= 1 ) ) throw new RangeError( 'The cloud view scale must lie in (0, 1]' );
		this.viewScale = { ...scale };

	}

	/** The panorama's size and refresh pattern: one texel of every strideX x strideY (powers of
	 * two dividing the size) per frame. A change rebuilds the panorama and refreshes it fully. */
	setDome( width: number, height: number, strideX: number, strideY: number ): void {

		const power = ( n: number ) => Number.isInteger( n ) && n > 0 && ( n & ( n - 1 ) ) === 0;
		if ( ! power( strideX ) || ! power( strideY ) || width % strideX !== 0 || height % strideY !== 0 ) throw new RangeError( 'Panorama strides must be powers of two dividing its size' );
		const d = this.domeSize;
		if ( d.width === width && d.height === height && d.strideX === strideX && d.strideY === strideY ) return;
		this.domeSize = { width, height, strideX, strideY };
		this.domeOrder = ditherOrder( strideX, strideY );
		if ( d.width !== width || d.height !== height ) {

			const previous = this.dome;
			this.dome = makeDome( width, height );
			this.domeNode.value = this.dome;
			this.domeTexel.value.set( 0.5 / width, 0.5 / height );
			previous.dispose();

		}
		if ( this.partialKernel ) this.buildKernels();
		this.invalidate();

	}

	/** The march's step caps and taps (CloudMarch); a change rebuilds the kernels once. */
	setMarch( march: Partial<CloudMarch> ): void {

		const next = { ...this.march, ...march };
		if ( ! ( next.lightTaps >= 1 && next.lightTaps <= MAX_LIGHT_TAPS ) ) throw new RangeError( `Light taps must lie in 1 .. ${ MAX_LIGHT_TAPS }` );
		for ( const key of [ 'viewSteps', 'panoramaSteps', 'rainSteps' ] as const ) if ( ! ( Number.isInteger( next[ key ] ) && next[ key ] > 0 ) ) throw new RangeError( `${ key } must be a positive integer` );
		if ( ( Object.keys( next ) as ( keyof CloudMarch )[] ).every( ( key ) => next[ key ] === this.march[ key ] ) ) return;
		this.march = next;
		if ( this.partialKernel ) this.buildKernels();
		this.invalidate();

	}

	/** The share of the cloud shadow map's rows refreshed per frame: 1/8 (the default), 1/4,
	 * 1/2 or 1. A jump still refreshes all of it at once. */
	setShadowRefresh( rowsPerFrame: number ): void {

		const passes = rowsPerFrame * SHADOW_PHASES;
		if ( ! ( Number.isInteger( passes ) && passes >= 1 && passes <= SHADOW_PHASES ) ) throw new RangeError( `Shadow rows per frame must be a multiple of 1/${ SHADOW_PHASES }` );
		this.shadowRowsPerFrame = rowsPerFrame;

	}

	/** Compile the panorama, shadow and (once sized) view kernels ahead of their first use. */
	async warm( renderer: THREE.WebGPURenderer ): Promise<void> {

		await this.init( renderer );
		const view = this.view;
		const kernels = [ this.partialKernel!, this.shadowKernel! ];
		if ( view ) kernels.push( view.kernels.trace, view.kernels.high, view.kernels.box, ...view.kernels.resolve );
		await renderer.compileComputeAsync( kernels );

	}

}

function makeDome( width: number, height: number ): THREE.StorageTexture {

	const dome = new THREE.StorageTexture( width, height );
	dome.type = THREE.HalfFloatType;
	dome.wrapS = THREE.RepeatWrapping;
	dome.wrapT = THREE.ClampToEdgeWrapping;
	dome.minFilter = dome.magFilter = THREE.LinearFilter;
	dome.generateMipmaps = false;
	dome.name = 'cloudDome';
	return dome;

}

// The rainbow's colours by angle from the antisolar point (RainbowTable.data.ts), as a half-float
// strip, linearly filtered between its 0.125 degree entries.
function makeRainbowTexture(): THREE.DataTexture {

	const data = new Uint16Array( RAINBOW_SIZE * 4 );
	for ( let i = 0; i < RAINBOW_SIZE; i ++ ) {

		for ( let c = 0; c < 3; c ++ ) data[ i * 4 + c ] = THREE.DataUtils.toHalfFloat( RAINBOW_TABLE[ i * 3 + c ] );
		data[ i * 4 + 3 ] = THREE.DataUtils.toHalfFloat( 1 );

	}
	const table = new THREE.DataTexture( data, RAINBOW_SIZE, 1, THREE.RGBAFormat, THREE.HalfFloatType );
	table.minFilter = table.magFilter = THREE.LinearFilter;
	table.wrapS = table.wrapT = THREE.ClampToEdgeWrapping;
	table.generateMipmaps = false;
	table.name = 'rainbowTable';
	table.needsUpdate = true;
	return table;

}

// Bicubic Catmull-Rom in five bilinear taps (corners dropped).
function catmullRom( node: THREE.TextureNode, uv: V2, size: V2 ): V4 {

	const sp = uv.mul( size );
	const tp1 = floor( sp.sub( 0.5 ) ).add( 0.5 ).toVar();
	const f = sp.sub( tp1 ).toVar();
	const w0 = f.mul( f.mul( f.mul( - 0.5 ).add( 1 ) ).sub( 0.5 ) );
	const w1 = f.mul( f ).mul( f.mul( 1.5 ).sub( 2.5 ) ).add( 1 );
	const w2 = f.mul( f.mul( f.mul( - 1.5 ).add( 2 ) ).add( 0.5 ) ).toVar();
	const w3 = f.mul( f ).mul( f.mul( 0.5 ).sub( 0.5 ) );
	const w12 = w1.add( w2 ).toVar();
	const tc0 = tp1.sub( 1 ).div( size ), tc3 = tp1.add( 2 ).div( size ), tc12 = tp1.add( w2.div( w12 ) ).div( size ).toVar();
	const a = w12.x.mul( w0.y ), b = w0.x.mul( w12.y ), cc = w12.x.mul( w12.y ), d = w3.x.mul( w12.y ), e = w12.x.mul( w3.y );
	const s = ( u: V2 ) => node.sample( u ).level( float( 0 ) );
	return s( vec2( tc12.x, tc0.y ) ).mul( a ).add( s( vec2( tc0.x, tc12.y ) ).mul( b ) ).add( s( tc12 ).mul( cc ) )
		.add( s( vec2( tc3.x, tc12.y ) ).mul( d ) ).add( s( vec2( tc12.x, tc3.y ) ).mul( e ) ).div( a.add( b ).add( cc ).add( d ).add( e ) );

}
