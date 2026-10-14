/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 *
 * hash22 is "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW).
 * Copyright (c) 2014 David Hoskins
 * Licensed under the MIT License; see ../materials/hoskins-hash.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, texture, textureLoad, textureSize, uniform, varying, positionGeometry, positionWorld, positionPrevious,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix, screenUV,
	float, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, pow, sqrt, exp, log2,
	sin, abs, floor, fract, fwidth, reflect, select, dFdx, dFdy,
} from 'three/tsl';
import { airToWaterDirectionNode, radianceAcrossInterfaceNode } from '../lighting/OpticalInterface.ts';
import type { Sky } from '../sky/Sky.ts';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { StormSea } from './StormSea.ts';
import type { Shared } from '../shared.ts';
import { volumeShadowRayMayIntersect } from '../lighting/SolarShadow.ts';
import {
	waveSlopeCovariance, waveLodCovariance, waveParameterGradient, waveSurfaceNormal, waveCovarianceToTangent,
	waveLocalDirection, waveBeckmannD, waveSmithVisibility, waveSolarSlopeCovariance, waveReflectionAngularVariance, waveAirFacing,
} from './WaveOptics.ts';
import { RefractedSun, refractedSunDirectionNode, refractedSunBeamScaleNode } from '../lighting/RefractedSun.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import { waterIncidentSun, waterColumnRadiance, waterShadowedColumnRadiance } from './WaterTransport.ts';
import { rainRippleGradient } from '../weather/Rain.ts';
import { ISLAND_TOP, type Bounds } from '../world/WorldShapes.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { OPEN_SEAGRASS_MEAN } from '../world/Bathymetry.ts';
import { seabedAlbedo } from '../materials/SeabedLook.ts';
import { motionNode, motionState, motionUniforms, outputStruct, reactiveUniforms } from '../post/Motion.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';

// The sea surface: an FFT-displaced grid with custom shading after tidewater's WaterMaterial
// (above-water branch):
//   - exact dielectric Fresnel, anisotropic Beckmann sun glint shadowed by the island,
//     measured FFT slope covariance that this pixel cannot resolve
//   - refraction: the refracted view ray is traced to the floor through the opaque pass's linear
//     depth (bounded steps and bisection), the scene behind is sampled where it lands
//   - water volume: Beer-Lambert absorption along the refracted path plus analytic single
//     scattering of the sun (Henyey-Greenstein) and the sky, multiple-scatter backscatter boost
//   - reflection: calibrated baked sky + screen-space reflection of cliffs and stacks
//   - sun glint: simulated slope moments, with optional additional artistic lobes
// Drawn after the opaque pass into the same multisampled target, depth-tested per sample against
// the opaque surfaces, reading a copy of that pass's resolved colour and its linear depth.
//
// The shading is adapted from tidewater's physically based model and art-directed toward the
// look in docs/art-direction.md: keep new water work stylised rather than strictly realistic.
// The sea continues to the horizon (a skirt around the wave grid, SKIRT_RADIUS); the camera's far
// plane and the sky-depth thresholds (-9e4; the resolved sky is -1e5) stay beyond it.
//
// Limits to keep in mind:
// - The fragment stage already binds 16 sampled textures, the most WebGPU guarantees: a new texture
//   fails pipeline creation unless another one goes (the sun's two shadow steps share one array
//   texture for this reason, and the storm foam is a storage buffer). Data that changes over metres
//   can be read in the vertex stage and passed on as a varying (the estimated sea floor's beds and
//   sand), but the water uses 14 of the 16 inter-stage variables WebGPU guarantees, 15 under the
//   temporal modes (Motion.ts's previous clip position). The sea's own motion must reach that
//   varying through the water's previous position, not add another.
// - The reflection only finds what lies inside `reflectionBounds` (see below): anything opaque
//   placed off the island or above 3 m (REFLECTOR_HEIGHT; a palm, a boat, a hut, a mast) must grow
//   that box, or the sea will not reflect it.
//
// Motion vectors (the temporal modes, Motion.ts): the sea writes its velocity with its colour (class
// water). Each vertex is moved back to where it was a step of the scene clock ago (`step`: the
// clock's advance since the rendered frame before, 0 across a cut, a seek or a pause): its cascades'
// displacement less their rate of change times the step (OceanFFT's orbital velocity, horizontally
// scaled by the choppiness), weighted by the fine cascade's fade and the skirt's flattening as seen
// from the previous camera, plus the rocky shore's reflected wave from its previous bake
// (ShoreWaves). The skirt beyond 1500 m carries no waves: camera motion only there. That previous
// position reaches the fragment through Motion.ts's one varying; the reads are vertex-stage only.
// The storm's foam rides the water's undisplaced grid (StormSea), so it moves as the surface does:
// `flags.mv.sea = false` leaves out the waves' motion, the foam's with it (the sea has no foam
// geometry of its own for `flags.mv.foam`). The reactive weight marks the sun's glints: the glint's
// luminance against a white diffuse surface under the same light, smoothstep( 2, 8, ratio ) by
// default (the resolve's settings, Motion.ts reactiveUniforms), so that a sparkle is not smeared
// into the history.
//
// Screen conventions (WebGPU): uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
// Texture samples that need screen-space derivatives are taken first, while control flow is still
// uniform; inside branches and loops the shading samples explicit levels or loads texels.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
type M4 = THREE.Node<'mat4'>;

const PI = Math.PI;
const IOR = 1.333;
const sat = ( x: F ) => clamp( x, 0, 1 );
const lum = ( c: V3 ) => dot( c, vec3( 0.2126, 0.7152, 0.0722 ) );

// exact unpolarised dielectric Fresnel, eta = n2 / n1
const fresnelDielectric = Fn( ( [ cosI, eta ]: [ F, F ] ) => {

	const c = clamp( cosI, 0, 1 ).toVar();
	const g2 = eta.mul( eta ).sub( 1 ).add( c.mul( c ) ).toVar();
	const res = float( 1 ).toVar();
	If( g2.greaterThanEqual( 0 ), () => {

		const g = sqrt( g2 ).toVar();
		const a = g.sub( c ).div( g.add( c ) );
		const b = c.mul( g.add( c ) ).sub( 1 ).div( c.mul( g.sub( c ) ).add( 1 ) );
		res.assign( a.mul( a ).mul( b.mul( b ).add( 1 ) ).mul( 0.5 ) );

	} );
	return res;

} ).setLayout( { name: 'fresnelDielectric', type: 'float', inputs: [ { name: 'cosI', type: 'float' }, { name: 'eta', type: 'float' } ] } );

const phaseHG = Fn( ( [ cosT, g ]: [ F, F ] ) => {

	const g2 = g.mul( g );
	return float( 1 ).sub( g2 ).div( 4 * PI ).div( pow( max( g2.add( 1 ).sub( g.mul( cosT ).mul( 2 ) ), 1e-4 ), 1.5 ) );

} ).setLayout( { name: 'phaseHG', type: 'float', inputs: [ { name: 'cosT', type: 'float' }, { name: 'g', type: 'float' } ] } );

const D_GGX = Fn( ( [ NdH, a2 ]: [ F, F ] ) => {

	const d = NdH.mul( NdH ).mul( a2.sub( 1 ) ).add( 1 );
	return a2.div( d.mul( d ).mul( PI ) );

} ).setLayout( { name: 'D_GGX', type: 'float', inputs: [ { name: 'NdH', type: 'float' }, { name: 'a2', type: 'float' } ] } );

const hash22 = Fn( ( [ p ]: [ V2 ] ) => {

	const a = fract( vec3( p.x, p.y, p.x ).mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	a.addAssign( dot( a, a.yzx.add( 33.33 ) ) );
	return fract( a.xx.add( a.yz ).mul( a.zy ) );

} ).setLayout( { name: 'waterHash22', type: 'vec2', inputs: [ { name: 'p', type: 'vec2' } ] } );

// smooth value noise in [0, 1] over unit cells
const valueNoise = Fn( ( [ p ]: [ V2 ] ) => {

	const cell = floor( p ).toVar();
	const f = fract( p ).toVar();
	const w = f.mul( f ).mul( f.mul( - 2 ).add( 3 ) );
	const corner = ( x: number, y: number ) => hash22( cell.add( vec2( x, y ) ) ).x;
	return mix( mix( corner( 0, 0 ), corner( 1, 0 ), w.x ), mix( corner( 0, 1 ), corner( 1, 1 ), w.x ), w.y );

} ).setLayout( { name: 'waterValueNoise', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

// glitter: one tiny facet per cell, flashing briefly as the swell tips it toward the eye
const sparkles = Fn( ( [ p, t ]: [ V2, F ] ) => {

	const h = hash22( floor( p ) ).toVar();
	const d = length( fract( p ).sub( h.mul( 0.6 ).add( 0.2 ) ) );
	const flash = pow( max( sin( t.mul( h.x.mul( 2.2 ).add( 1.3 ) ).add( h.y.mul( 40 ) ) ), 0 ), 10 );
	return flash.mul( float( 1 ).sub( smoothstep( 0.06, 0.2, d ) ) );

} ).setLayout( { name: 'sparkles', type: 'float', inputs: [ { name: 'p', type: 'vec2' }, { name: 't', type: 'float' } ] } );

// The sea continues to this distance (metres), well past the horizon for any review camera.
const SKIRT_RADIUS = 40000;

// The longest step of the scene clock between two rendered frames that is still motion; a longer
// one (or a step back) is a seek, which has none (as StormSea's live step).
const MAX_MOTION_STEP = 0.25;

// Metres per repeat of the glitter lobe's patches.
const GLITTER_TILE = 8.8;

// Refraction hits within this share of the screen's edges fade to the fallback.
const EDGE_FADE = 0.06;

// view-space direction through a screen point (on the far plane; scaled by the caller)
const viewRay = Fn( ( [ q, projInv ]: [ V2, M4 ] ) => {

	const v = projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 ) ).toVar();
	return v.xyz.div( v.w );

} ).setLayout( { name: 'viewRay', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' }, { name: 'projInv', type: 'mat4' } ] } );

const projectView = Fn( ( [ p, proj ]: [ V3, M4 ] ) => {

	const c = proj.mul( vec4( p, 1 ) ).toVar();
	const s = c.xy.div( c.w ).mul( 0.5 ).add( 0.5 );
	return vec2( s.x, float( 1 ).sub( s.y ) );

} ).setLayout( { name: 'projectView', type: 'vec2', inputs: [ { name: 'p', type: 'vec3' }, { name: 'proj', type: 'mat4' } ] } );

// The synthetic floor takes the floor's own albedo (seabedAlbedo): with every ray lost, the shelf
// seen from above came out within a few per cent of the traced floor's brightness, so it needs no
// gain. The cliff's submerged face keeps an albedo of its own, under its algae.
const FACE_ALBEDO = vec3( 0.14, 0.15, 0.14 );
// The terrain's tiled detail heights (r rock, g moss cushions, b sand ripples), which the estimate
// stands in for with noise: their means and the spread of the noise about them.
const DETAIL_MEAN = new THREE.Vector3( 0.52, 0.35, 0.45 );
const DETAIL_SPREAD = new THREE.Vector3( 0.16, 0.4, 0.4 );
// The submerged face's share of the sky's light, against the floor's: matched to the traced face,
// whose shaded stone the terrain lights by the whole sky's irradiance for its normal (bright
// toward the horizon) and whose jointed blocks catch it on their ledges.
const FACE_SKY = 2;

// The cliff's submerged face stands nearly plumb below its waterline (its jointed columns step
// out a few centimetres per metre of depth, the wave-cut notch aside).
const WALL_LEAN = 0.04;

// Drops below the surface (m) at which the shoreline distance and the floor's height are sampled
// down each vertex's refracted ray: dense near the surface, where the shelf by the cliffs lies,
// sparse in the basin.
const SHORE_DROPS = [ 0, 0.75, 1.5, 2.5, 3.75, 5.5, 8, 12 ];

// Where a refracted ray from a surface point meets the seabed or the island's submerged face, in
// world space. The shoreline distance and the floor's height are known at fixed drops down the
// ray (`near`, `far`, `floorNear`, `floorFar`: four each, see SHORE_DROPS) and vary linearly
// between them; `skew` adds what each gains per metre of drop on this ray over the ray the
// samples were taken along. The ray is open water while it is above the floor and outside the
// face, which stands WALL_LEAN * depth outside the shoreline. Returns the drop at which it stops
// being open, the shoreline distance there, and the share of the face rather than the floor,
// which turns over the last half metre (along the ray) before the face cuts the ray off, so that
// the face's foot is a soft line on the water rather than a pixel step.
const seabedLanding = Fn( ( [ originY, level, near, far, floorNear, floorFar, skew, down ]: [ F, F, V4, V4, V4, V4, V2, F ] ) => {

	const samples = [ near.x, near.y, near.z, near.w, far.x, far.y, far.z, far.w ];
	const heights = [ floorNear.x, floorNear.y, floorNear.z, floorNear.w, floorFar.x, floorFar.y, floorFar.z, floorFar.w ];
	const shore = SHORE_DROPS.map( ( drop, k ) => samples[ k ].add( skew.x.mul( drop ) ).toVar() );
	const floor = SHORE_DROPS.map( ( drop, k ) => originY.sub( drop ).sub( heights[ k ].add( skew.y.mul( drop ) ) ).toVar() );
	const face = SHORE_DROPS.map( ( drop, k ) => shore[ k ].sub( max( level.sub( originY ).add( drop ), 0 ).mul( WALL_LEAN ) ).toVar() );
	const last = SHORE_DROPS.length - 1;
	// Below the last sample the floor stays at the last sample's height.
	const result = vec3( max( floor[ last ].add( SHORE_DROPS[ last ] ), SHORE_DROPS[ last ] ), shore[ last ], 0 ).toVar();
	const found = float( 0 ).toVar();
	If( floor[ 0 ].lessThanEqual( 0 ).or( face[ 0 ].lessThanEqual( 0 ) ), () => {

		result.assign( vec3( 0, shore[ 0 ], select( face[ 0 ].lessThanEqual( 0 ), float( 1 ), float( 0 ) ) ) );
		found.assign( 1 );

	} );
	for ( let k = 1; k <= last; k ++ ) {

		If( found.lessThan( 0.5 ).and( floor[ k ].lessThanEqual( 0 ).or( face[ k ].lessThanEqual( 0 ) ) ), () => {

			// The share of this step at which each boundary is crossed (linearly; past the step's
			// end, or never, if the ray does not close on it here).
			const toFloor = select( floor[ k ].lessThan( floor[ k - 1 ] ), floor[ k - 1 ].div( floor[ k - 1 ].sub( floor[ k ] ) ), float( 1e3 ) );
			const toFace = select( face[ k ].lessThan( face[ k - 1 ] ), face[ k - 1 ].div( face[ k - 1 ].sub( face[ k ] ) ), float( 1e3 ) );
			const t = clamp( min( toFloor, toFace ), 0, 1 );
			const step = SHORE_DROPS[ k ] - SHORE_DROPS[ k - 1 ];
			const wall = smoothstep( - 0.25, 0.25, min( toFloor.sub( toFace ), 10 ).mul( step ).div( down ) );
			result.assign( vec3( mix( float( SHORE_DROPS[ k - 1 ] ), float( SHORE_DROPS[ k ] ), t ), mix( shore[ k - 1 ], shore[ k ], t ), wall ) );
			found.assign( 1 );

		} );

	}
	return result;

} ).setLayout( {
	name: 'seabedLanding', type: 'vec3',
	inputs: [
		{ name: 'originY', type: 'float' }, { name: 'level', type: 'float' }, { name: 'near', type: 'vec4' },
		{ name: 'far', type: 'vec4' }, { name: 'floorNear', type: 'vec4' }, { name: 'floorFar', type: 'vec4' },
		{ name: 'skew', type: 'vec2' }, { name: 'down', type: 'float' },
	],
} );

export interface WaterInputs {
	fft: OceanFFT;
	sky: Sky;
	shared: Shared;
	shore: THREE.Texture | THREE.TextureNode;
	seabedHeight: THREE.Texture | THREE.TextureNode; // the rendered floor's height over the shoreline field's bounds
	// The floor's look: its beds over the shoreline field's bounds (seabedBedTextureFrom), and the
	// terrain's normalsB detail texture, whose alpha is the sand's broad variation.
	seabedLook: { beds: THREE.Texture | THREE.TextureNode; variation: THREE.Texture };
	land: Bounds; // the land's box (WorldShapes.landBounds), for reflectionBounds
	shoreWaves: ShoreWaves;
	refractedSun: RefractedSun;
	sunShadow: SunShadow;
	storm: StormSea;
	sceneColor: THREE.Texture; // the opaque pass's resolved colour
	linearDepth: THREE.Texture; // its view-space z: sample 0 (x) and the farthest sample (y)
	size?: number;
	res?: number;
	quality?: Partial<WaterQuality>; // compile-time: read once, a change needs a new Water (a reload)
}

// The water's quality knobs. They are compiled into the shader (a uniform-gated branch keeps its
// registers), so they are fixed for the material's life. High is today's image; the lower tiers
// trade a little of it for time:
//   ssrRays: rays per pixel for the screen-space reflection, either side of the centre (2) or
//     through it (1, a little stair-stepping on the reflected island's edge);
//   ssrSteps, ssrGrowth: its geometric steps, each this much longer than the last. The march
//     reaches 0.15 + 0.25 (growth^steps - 1) / (growth - 1) metres: 158 m on high, 100 m for
//     14 steps at x1.45 (14 at about x1.51 would keep the 158 m);
//   refractionSteps, refractionRefine: the refraction's linear steps and bisection steps;
//   columnSamples: samples of the water column's shadow march (both cross-faded sun maps at each);
//   stormFoam: 'merged' reads the storm foam's mat and lace from one pattern fetch instead of
//     three: the mat keeps only its first layer, and the lace takes the mat's coordinates, so it
//     is no longer drawn out along the wind. The streaks keep their own fetch (they need
//     coordinates stretched along the wind), so 'merged' saves two of the five fetches.
export interface WaterQuality {
	ssrRays: 1 | 2;
	ssrSteps: number;
	ssrGrowth: number;
	refractionSteps: number;
	refractionRefine: number;
	columnSamples: number;
	stormFoam: 'full' | 'merged';
}

// High's values, today's image; the tiers' values are in Quality.ts.
export const DEFAULT_WATER_QUALITY: Readonly<WaterQuality> = { ssrRays: 2, ssrSteps: 20, ssrGrowth: 1.3, refractionSteps: 8, refractionRefine: 5, columnSamples: 8, stormFoam: 'full' };

// The screen-space reflection can only find what the opaque pass drew above the sea: the island,
// its plants and its people. A box around them, from the land's box (so it grows with the island):
// out past the land's edge by the rim's overhang (the turf skirt, the leaf mounds and trails over
// the lip, a bush near the rim) plus a metre's margin, and up past the meadow by the islanders'
// 2 m plus a metre.
// Hits below REFLECTION_FLOOR under the sea level already weigh nothing (see traceSSR), so the box
// ends there. A placed object off the island or above 3 m (a palm, a hut, a mast) or a wider rim
// overhang must grow these, or its reflection is lost (debug builds warn, see checkReflectionBounds).
const REFLECTOR_REACH = 1.5 + 1;
const REFLECTOR_HEIGHT = 3;
const REFLECTION_FLOOR = 0.35;

// How the reflection's march uses that box. cull: a ray that never meets it within the march's
// reach keeps the sky without marching (most of the sea away from the island). clip: a ray stops
// at its first step past the box, where nothing is left to reflect. The steps before the box still
// read the depth buffer: the march accepts a hit up to 1.4 steps behind it, so one of them can end
// a ray on a far false hit (or on a hit that weighs nothing) where a ray started at the box would
// march on and find another, and the image would change.
interface SSRVariant { cull: boolean; clip: boolean }
const SSR_BOXED: SSRVariant = { cull: true, clip: true };
const variantKey = ( v: SSRVariant ) => ( v.cull ? 1 : 0 ) + ( v.clip ? 2 : 0 );

// The distances along a ray (origin, unit direction) at which it enters and leaves a box (slab
// method); enter > leave when it misses.
const rayBoxSpan = Fn( ( [ origin, direction, lo, hi ]: [ V3, V3, V3, V3 ] ) => {

	const safe = ( c: F ) => select( abs( c ).lessThan( 1e-6 ), select( c.lessThan( 0 ), float( - 1e-6 ), float( 1e-6 ) ), c );
	const inv = vec3( float( 1 ).div( safe( direction.x ) ), float( 1 ).div( safe( direction.y ) ), float( 1 ).div( safe( direction.z ) ) ).toVar();
	const a = lo.sub( origin ).mul( inv ).toVar(), b = hi.sub( origin ).mul( inv ).toVar();
	const enter = max( max( min( a.x, b.x ), min( a.y, b.y ) ), min( a.z, b.z ) );
	const leave = min( min( max( a.x, b.x ), max( a.y, b.y ) ), max( a.z, b.z ) );
	return vec2( enter, leave );

} ).setLayout( {
	name: 'rayBoxSpan', type: 'vec2',
	inputs: [ { name: 'origin', type: 'vec3' }, { name: 'direction', type: 'vec3' }, { name: 'lo', type: 'vec3' }, { name: 'hi', type: 'vec3' } ],
} );

const DEBUG = import.meta.env.DEV || new URLSearchParams( globalThis.location?.search ?? '' ).has( 'debug' );

export class Water {

	mesh: THREE.Mesh;
	material: THREE.NodeMaterial;
	readonly quality: WaterQuality;
	// Everything opaque above the sea that the reflection can show (see REFLECTOR_REACH). Anything
	// built off the island later (a boat, a hut on stilts) must lie inside it: grow it with
	// expandByObject or union, and the water picks it up on the next frame.
	readonly reflectionBounds: THREE.Box3;
	uniforms = {
		backscatter: uniform( 0.038 ),
		roughness: uniform( 0.058 ), // Beckmann alpha: per-axis base slope variance = alpha squared / 2
		ssr: uniform( 1 ),
		reflection: uniform( 1 ),
		glitter: uniform( 0 ),
		skyCap: uniform( 0 ),
		sheen: uniform( 0 ),
		shadowMatrix: uniform( new THREE.Matrix4() ),
		shadowOn: uniform( 0 ),
	};

	private shadowBias = uniform( 0 );
	private shadowNormalBias = uniform( 0 );
	private shadowIntensity = uniform( 1 );
	private reflectorMin = uniform( new THREE.Vector3() );
	private reflectorMax = uniform( new THREE.Vector3() );
	private inputs: WaterInputs;
	private materials = new Map<number, THREE.NodeMaterial>();
	// The temporal modes' motion: the scene clock's step since the rendered frame before (s), 0
	// across a cut or a seek; and 0 to leave the waves' own motion out (flags.mv.sea = false).
	private step = uniform( 0 );
	private ownMotion = uniform( 1 );
	private shoreHistory = uniform( 0 ); // 1 while the shore's previous bake is a step ago
	private clock = { frame: - 1, time: 0 };
	private boundsChecked = false;

	constructor( inputs: WaterInputs ) {

		const { size = 700, res = 320, quality } = inputs;

		// grid in world xz, warped dense under the island and sparse toward the horizon
		const n = res;
		const pos = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 );
		const warp = ( u: number ) => Math.sign( u ) * Math.pow( Math.abs( u ), 2.1 );
		for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

			const k = ( j * ( n + 1 ) + i ) * 3;
			pos[ k ] = warp( i / n * 2 - 1 ) * size / 2;
			pos[ k + 2 ] = warp( j / n * 2 - 1 ) * size / 2;

		}

		const idx: number[] = [];
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const a = j * ( n + 1 ) + i;
			idx.push( a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2 );

		}

		// A skirt continues the grid's outer edge to the horizon in widening rows. Without it the
		// sea stopped a couple of degrees below the horizon and a band of the sky's lower panorama
		// showed between them. Its inner row is the grid's boundary, so the seam is exact.
		const ring: number[] = [];
		for ( let i = 0; i < n; i ++ ) ring.push( i ); // z = -size / 2
		for ( let j = 0; j < n; j ++ ) ring.push( j * ( n + 1 ) + n ); // x = +size / 2
		for ( let i = n; i > 0; i -- ) ring.push( n * ( n + 1 ) + i ); // z = +size / 2
		for ( let j = n; j > 0; j -- ) ring.push( j * ( n + 1 ) ); // x = -size / 2
		const rows = 28, reach = SKIRT_RADIUS / ( size / 2 );
		const grid = pos.length / 3, skirt: number[] = [];
		for ( let r = 1; r <= rows; r ++ ) {

			const scale = Math.pow( reach, r / rows );
			for ( const v of ring ) skirt.push( pos[ v * 3 ] * scale, 0, pos[ v * 3 + 2 ] * scale );

		}
		const vertex = ( r: number, k: number ) => r === 0 ? ring[ k % ring.length ] : grid + ( r - 1 ) * ring.length + k % ring.length;
		const all = new Float32Array( pos.length + skirt.length );
		all.set( pos );
		all.set( skirt, pos.length );
		for ( let r = 0; r < rows; r ++ ) for ( let k = 0; k < ring.length; k ++ ) {

			const a = vertex( r, k ), b = vertex( r, k + 1 ), c = vertex( r + 1, k ), d = vertex( r + 1, k + 1 );
			for ( const [ p, q, w ] of [ [ a, c, b ], [ b, c, d ] ] ) {

				// Keep every triangle facing up, whichever way the boundary loop runs.
				const ux = all[ q * 3 ] - all[ p * 3 ], uz = all[ q * 3 + 2 ] - all[ p * 3 + 2 ];
				const vx = all[ w * 3 ] - all[ p * 3 ], vz = all[ w * 3 + 2 ] - all[ p * 3 + 2 ];
				if ( uz * vx - ux * vz > 0 ) idx.push( p, q, w ); else idx.push( p, w, q );

			}

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( all, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( new Uint32Array( idx ), 1 ) );
		geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), SKIRT_RADIUS * Math.SQRT2 );

		this.inputs = inputs;
		this.quality = { ...DEFAULT_WATER_QUALITY, ...quality };
		this.reflectionBounds = new THREE.Box3();
		this.setLand( inputs.land );
		this.material = this.buildMaterial( SSR_BOXED );
		this.materials.set( variantKey( SSR_BOXED ), this.material );
		this.mesh = new THREE.Mesh( geo, this.material );
		this.mesh.frustumCulled = false;
		this.mesh.name = 'water';

	}

	// The sea's shading for one way of marching the screen-space reflection (see SSRVariant).
	private buildMaterial( variant: SSRVariant ): THREE.NodeMaterial {

		const { fft, sky, shared, shore, seabedHeight, seabedLook, shoreWaves, refractedSun, sunShadow, storm, sceneColor, linearDepth } = this.inputs;
		const quality = this.quality;
		const u = this.uniforms;
		const sizes = uniform( new THREE.Vector3( ...fft.sizes ) );
		const disp = fft.displacementTextures, der = fft.derivativeTextures, moments = fft.slopeMomentTextures;

		// ---- vertex: displace the grid by the three cascades (the finest fades out far away). The
		// undisplaced grid point comes from the geometry: once positionNode is set, positionLocal
		// reads the displaced position.
		const xz = positionGeometry.xz;
		const sd = texture( shore, xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ).r;
		// Shelter changes the physical wave amplitude; the finest wind detail stays alive.
		const shelter = shoreWaves.shelter.sample( xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) );
		const coastDamp = mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) );
		const windDamp = mix( float( 0.12 ), float( 1 ), shelter.r );
		const mediumDamp = mix( float( 0.8 ), float( 1 ), shelter.r );
		const far = length( xz.sub( cameraPosition.xz ) );
		const fineWeight = float( 1 ).sub( smoothstep( 60, 140, far ) );
		const weights = vec3( windDamp, mediumDamp, fineWeight ).mul( coastDamp );
		const largeDisp = texture( disp[ 0 ], xz.div( sizes.x ) ).level( float( 0 ) ).xyz;
		const mediumDisp = texture( disp[ 1 ], xz.div( sizes.y ) ).level( float( 0 ) ).xyz;
		const fineDisp = texture( disp[ 2 ], xz.div( sizes.z ) ).level( float( 0 ) ).xyz;
		// The skirt's sparse rows cannot carry waves; there the shading's slopes alone describe them.
		const geometric = float( 1 ).sub( smoothstep( 600, 1500, far ) );
		const d = largeDisp.mul( weights.x ).add( mediumDisp.mul( weights.y ) ).add( fineDisp.mul( weights.z ) ).mul( geometric );
		const material = new THREE.NodeMaterial();
		const displaced = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y )
			.add( shoreWaves.surfaceAt( xz.add( d.xz ), shared.time ).x ), xz.y.add( d.z ) ).toVar();
		material.positionNode = displaced;
		if ( TEMPORAL ) {

			// (motion vectors: the note at the top) the vertex a step of the clock ago, seen from the
			// previous camera's level of detail
			const previousFar = length( xz.sub( motionUniforms.previousCameraPosition.xz ) );
			const previousWeights = vec3( windDamp, mediumDamp, float( 1 ).sub( smoothstep( 60, 140, previousFar ) ) ).mul( coastDamp );
			const previousGeometric = float( 1 ).sub( smoothstep( 600, 1500, previousFar ) );
			const back = ( c: number, now: V3 ) => {

				const v = texture( fft.velocityTextures[ c ], xz.div( c === 0 ? sizes.x : c === 1 ? sizes.y : sizes.z ) ).level( float( 0 ) ).xyz; // Ux, Uz, Vy
				return now.sub( vec3( v.x.mul( fft.chop ), v.z, v.y.mul( fft.chop ) ).mul( this.step ) );

			};
			const dp = back( 0, largeDisp ).mul( previousWeights.x ).add( back( 1, mediumDisp ).mul( previousWeights.y ) )
				.add( back( 2, fineDisp ).mul( previousWeights.z ) ).mul( previousGeometric ).toVar();
			const shoreAt = xz.add( dp.xz );
			// (paused or across a cut the field baked before is not the previous frame's)
			const shorePrevious = mix( shoreWaves.surfaceAt( shoreAt, shared.time ).x, shoreWaves.previousSurfaceAt( shoreAt ).x, this.shoreHistory );
			const previous = vec3( xz.x.add( dp.x ), shared.waterLevel.add( dp.y ).add( shorePrevious ), xz.y.add( dp.z ) );
			// Weights of exactly 0 or 1, not select(): TSL turns a select of large operands into
			// branches, and `displaced`, first built inside one, was then declared in it only.
			material.positionNode = Fn( () => {

				positionPrevious.assign( mix( displaced, previous, this.ownMotion ) );
				return displaced;

			} )();
			material.userData.previousPosition = true;

		}
		const vLag = varying( xz ), vDamp = varying( coastDamp ), vFineWeight = varying( fineWeight );
		// The shoreline distance and the floor's height for the refraction's world-space estimate of
		// the floor, sampled down this vertex's refracted ray as a level sea bends it, at fixed drops
		// below the surface. Interpolated across the triangles, the distances stay continuous where
		// the field's gradient is not (around the cliffs' corners, between facing cliffs), so that the
		// fragment follows its own ray past a corner or into a cove. The floor's height is the floor
		// the world generator built (its shelf, benches and talus vary along the coast), read from a
		// field over the same bounds. The gradients are taken where that ray lands: they face the
		// floor's slope and the cliff's face the ray meets, not the nearest shore of the surface
		// point. Past the field's edge the distance keeps growing with the distance from that edge,
		// and the floor keeps the edge's height.
		const fieldEnd = shared.shoreXform.xy.add( vec2( 1 ).div( shared.shoreXform.zw ) );
		const fieldUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
		const shoreDistance = ( p: V2 ) => texture( shore, fieldUV( p ) ).level( float( 0 ) ).r
			.add( length( p.sub( clamp( p, shared.shoreXform.xy, fieldEnd ) ) ) );
		const floorHeight = ( p: V2 ) => texture( seabedHeight, fieldUV( p ) ).level( float( 0 ) ).r;
		const surfaceXZ = displaced.xz;
		const levelRay = airToWaterDirectionNode( normalize( cameraPosition.sub( displaced ) ), vec3( 0, 1, 0 ), float( IOR ) ).toVar();
		const across = levelRay.xz.div( max( levelRay.y.negate(), 1e-3 ) ).toVar(); // horizontal metres per metre of drop
		const along = SHORE_DROPS.map( ( drop ) => surfaceXZ.add( across.mul( drop ) ).toVar() );
		const ray = along.map( shoreDistance );
		const heights = along.map( floorHeight );
		const shoreNear = vec4( ray[ 0 ], ray[ 1 ], ray[ 2 ], ray[ 3 ] ), shoreFar = vec4( ray[ 4 ], ray[ 5 ], ray[ 6 ], ray[ 7 ] );
		const floorNear = vec4( heights[ 0 ], heights[ 1 ], heights[ 2 ], heights[ 3 ] ), floorFar = vec4( heights[ 4 ], heights[ 5 ], heights[ 6 ], heights[ 7 ] );
		const vShoreNear = varying( shoreNear ), vShoreFar = varying( shoreFar );
		const vFloorNear = varying( floorNear ), vFloorFar = varying( floorFar );
		const levelLanding = seabedLanding( displaced.y, shared.waterLevel, shoreNear, shoreFar, floorNear, floorFar,
			vec2( 0 ), max( levelRay.y.negate(), 1e-3 ) );
		const landedXZ = surfaceXZ.add( across.mul( levelLanding.x ) ).toVar();
		const gradientOf = ( field: ( p: V2 ) => F ) => vec2(
			field( landedXZ.add( vec2( 0.5, 0 ) ) ).sub( field( landedXZ.sub( vec2( 0.5, 0 ) ) ) ),
			field( landedXZ.add( vec2( 0, 0.5 ) ) ).sub( field( landedXZ.sub( vec2( 0, 0.5 ) ) ) ) );
		const vLandingGradients = varying( vec4( gradientOf( shoreDistance ), gradientOf( floorHeight ) ) ); // shore, floor
		// The floor's look where the ray lands, for its colour (seabedAlbedo): the beds, read from
		// their field over the shoreline field's bounds, and the sand's broad variation. Both change
		// over metres, so the vertices carry them. Past the field's edge the beds fade over 8 m to the
		// open sea's mean (no pale sand), so its edge texels never streak across the deep floor.
		const beyond = smoothstep( 0, 8, length( landedXZ.sub( clamp( landedXZ, shared.shoreXform.xy, fieldEnd ) ) ) );
		const beds = mix( texture( seabedLook.beds, fieldUV( landedXZ ) ).level( float( 0 ) ).rg, vec2( OPEN_SEAGRASS_MEAN, 0 ), beyond );
		const vLandingLook = varying( vec3( beds,
			texture( seabedLook.variation, landedXZ.mul( 0.013 ).add( 0.2 ) ).level( float( 3 ) ).a ) ); // grass, pale, broad
		const vWeights = varying( weights );
		const vLargeDisp = varying( largeDisp ), vMediumDisp = varying( mediumDisp ), vFineDisp = varying( fineDisp );

		// ---- fragment
		const tDepth = texture( linearDepth );
		const depthSize = vec2( textureSize( tDepth ) as unknown as THREE.Node<'ivec2'> );
		const pixel = ( q: V2 ) => ivec2( clamp( q.mul( depthSize ), vec2( 0 ), depthSize.sub( 1 ) ) );
		const sceneViewZ = Fn( ( [ q ]: [ V2 ] ) => textureLoad( tDepth, pixel( q ) ).x )
			.setLayout( { name: 'sceneViewZ', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );
		// What lies behind the water at its own pixel: the farthest of the opaque samples. The sea is
		// drawn only into the samples it is in front of, so where a cliff or a figure covers part of
		// the pixel, the sea's samples hold what is behind them, not the figure of sample 0.
		const behindViewZ = textureLoad( tDepth, pixel( screenUV ) ).y;
		const sceneAt = ( q: V2 ) => texture( sceneColor, q ).level( float( 0 ) ).rgb;

		// screen-space reflection of the opaque scene (cliffs, stacks): geometric steps, then bisection
		// The distance the march reaches: its last step.
		const ssrReach = 0.15 + 0.25 * ( Math.pow( quality.ssrGrowth, quality.ssrSteps ) - 1 ) / ( quality.ssrGrowth - 1 );
		const traceSSR = Fn( ( [ posV, Rv ]: [ V3, V3 ] ) => {

			const res = vec4( 0 ).toVar();
			// A zero grazing weight cannot contribute a reflection. Reuse the exact fade
			// below rather than marching those rays through the depth buffer.
			const directionWeight = smoothstep( 0.5, 0.1, Rv.z ).toVar();
			let marches = Rv.z.lessThanEqual( 0.6 ).and( directionWeight.greaterThan( 0 ) );
			// Where the ray is inside the box of what it can reflect (in world space: the view is rigid,
			// so distances along the ray are the same).
			const span = variant.cull || variant.clip ? rayBoxSpan( cameraWorldMatrix.mul( vec4( posV, 1 ) ).xyz,
				cameraWorldMatrix.mul( vec4( Rv, 0 ) ).xyz, this.reflectorMin, this.reflectorMax ).toVar() : vec2( 0, 1e9 );
			if ( variant.cull ) marches = marches.and( span.y.greaterThanEqual( max( span.x, 0 ) ) ).and( span.x.lessThanEqual( ssrReach ) );
			If( marches, () => {

				const t = float( 0.15 ).toVar(), dt = float( 0.25 ).toVar(), prevT = float( 0 ).toVar();
				const hit = float( 0 ).toVar();
				const step = () => {

					const p = posV.add( Rv.mul( t ) ).toVar();
					const q = projectView( p, cameraProjectionMatrix ).toVar();
					If( q.x.lessThan( 0 ).or( q.x.greaterThan( 1 ) ).or( q.y.lessThan( 0 ) ).or( q.y.greaterThan( 1 ) ).or( p.z.greaterThan( - 0.1 ) ), () => {

						Break();

					} );
					const sz = sceneViewZ( q ).toVar();
					If( p.z.lessThan( sz ).and( sz.sub( p.z ).lessThan( max( dt.mul( 1.4 ), 0.35 ) ) ), () => {

						hit.assign( 1 );
						Break();

					} );

				};
				Loop( quality.ssrSteps, () => {

					prevT.assign( t );
					t.addAssign( dt );
					dt.mulAssign( quality.ssrGrowth );
					step();
					if ( variant.clip ) If( t.greaterThan( span.y ), () => {

						Break();

					} );

				} );
				If( hit.greaterThan( 0.5 ), () => {

					const a = prevT.toVar(), b = t.toVar();
					Loop( 5, () => {

						const m = a.add( b ).mul( 0.5 ).toVar();
						const p = posV.add( Rv.mul( m ) ).toVar();
						If( p.z.lessThan( sceneViewZ( projectView( p, cameraProjectionMatrix ) ) ), () => {

							b.assign( m );

						} ).Else( () => {

							a.assign( m );

						} );

					} );
					const hv = posV.add( Rv.mul( b ) ).toVar();
					const q = projectView( hv, cameraProjectionMatrix ).toVar();
					const touch = float( 1 ).sub( smoothstep( 0.15, 0.6, abs( sceneViewZ( q ).sub( hv.z ) ) ) );
					const hw = cameraWorldMatrix.mul( vec4( hv, 1 ) ).xyz.toVar();
					const edge = smoothstep( 0, 0.06, q.x ).mul( smoothstep( 1, 0.94, q.x ) ).mul( smoothstep( 0, 0.06, q.y ) ).mul( smoothstep( 1, 0.94, q.y ) );
					res.assign( vec4( sceneAt( q ), edge.mul( touch ).mul( directionWeight ) ) );
					// Where the ray meets the cliff below the sea's reach, it could only have got there
					// through the water it meets first. Falling back to the sky there (tidewater fades
					// the lowest 0.4 m, sized for cliffs ten times taller) drew a bright band along every
					// cliff foot. The sea at this island's cliffs is a near mirror in everyday weather,
					// so the reflected rock continues down to the waterline, and rock just below it shows
					// the rock where it leaves the water: the hit lifted to the waterline, if the depth
					// buffer confirms rock there (a cliff face, not open seabed). A gale's swell heaves
					// the surface at the rock by tens of centimetres; the reach grows with it and the
					// lifted rock gives way to the sky, as before, so a rough sea keeps its sky-lit facets.
					const gale = sat( shared.wind.oceanGain.x.sub( 1.15 ).div( 1.2 ) ).toVar();
					const waterline = shared.waterLevel.add( mix( float( 0.03 ), float( 0.3 ), gale ) ).toVar();
					const above = smoothstep( shared.waterLevel.sub( gale.mul( 0.1 ) ), waterline, hw.y ).toVar();
					If( above.lessThan( 1 ), () => {

						const lifted = cameraViewMatrix.mul( vec4( hw.x, waterline, hw.z, 1 ) ).xyz.toVar();
						const ql = projectView( lifted, cameraProjectionMatrix ).toVar();
						const liftedTouch = float( 1 ).sub( smoothstep( 0.15, 0.6, abs( sceneViewZ( ql ).sub( lifted.z ) ) ) );
						// Deep hits (the seabed, rock seen past a downward-tilted facet) keep the sky.
						const shallow = smoothstep( shared.waterLevel.sub( 0.35 ), shared.waterLevel.sub( 0.15 ), hw.y ).mul( float( 1 ).sub( gale ) );
						// Weighted, so that a gale's sea (no lifted rock) blends exactly as before.
						const direct = res.a.mul( above ).toVar();
						const rock = res.a.mul( liftedTouch ).mul( shallow ).mul( float( 1 ).sub( above ) ).toVar();
						const weight = direct.add( rock ).toVar();
						res.assign( vec4( sceneAt( ql ).mul( rock ).add( res.rgb.mul( direct ) ).div( max( weight, 1e-4 ) ), weight ) );

					} );

				} );

			} );
			return res;

		} ).setLayout( { name: 'traceSSR', type: 'vec4', inputs: [ { name: 'posV', type: 'vec3' }, { name: 'Rv', type: 'vec3' } ] } );

		// The distance along a ray at which it crosses the depth buffer, between a sample in front of
		// it (a) and one behind it (b): bisection.
		const refineCrossing = Fn( ( [ posV, directionV, a0, b0 ]: [ V3, V3, F, F ] ) => {

			const a = a0.toVar(), b = b0.toVar();
			Loop( quality.refractionRefine, () => {

				const distance = a.add( b ).mul( 0.5 ).toVar();
				const point = posV.add( directionV.mul( distance ) ).toVar();
				If( point.z.lessThanEqual( sceneViewZ( projectView( point, cameraProjectionMatrix ) ) ), () => {

					b.assign( distance );

				} ).Else( () => {

					a.assign( distance );

				} );

			} );
			return b;

		} ).setLayout( {
			name: 'refineCrossing', type: 'float',
			inputs: [ { name: 'posV', type: 'vec3' }, { name: 'directionV', type: 'vec3' }, { name: 'a0', type: 'float' }, { name: 'b0', type: 'float' } ],
		} );

		// Trace the first visible underwater surface, rather than iterating its height. A
		// height-only solve can jump between shallow rocks and a deeper basin indefinitely.
		// Where the ray passes behind the depth buffer, the crossing is an intersection only if the
		// scene there meets the ray under the water. Otherwise it is an occluder that hides the ray's
		// continuation on the screen (a stone the ray passes behind, the cliff above the sea, which
		// an underwater ray cannot meet at all), and the march goes on behind it, so the ray may find
		// the floor where it comes out. (Ending there, the ray fell back to the floor straight behind
		// its pixel, and the water changed colour along every silhouette the rays passed behind.)
		// A ray that finds nothing (off the screen, hidden to the end, out of range) returns no trust;
		// the shading then takes the floor from the world-space estimate (see the lost rays below).
		const traceRefraction = Fn( ( [ posV, directionV, range, surfaceY, footprint ]: [ V3, V3, F, F, F ] ) => {

			const step = range.div( quality.refractionSteps ).toVar();
			// the world's up axis in view space: a view-space point's height is dot( up, p ) plus the camera's
			const up = cameraViewMatrix.mul( vec4( 0, 1, 0, 0 ) ).xyz.toVar();
			const height = ( p: V3 ) => dot( up, p ).add( cameraPosition.y );
			const near = float( 0 ).toVar(), open = float( 1 ).toVar();
			const result = vec4( 0 ).toVar();
			Loop( quality.refractionSteps, ( { i } ) => {

				const distance = float( i ).add( 1 ).mul( step ).toVar();
				const point = posV.add( directionV.mul( distance ) ).toVar();
				const q = projectView( point, cameraProjectionMatrix ).toVar();
				If( q.x.lessThan( 0.001 ).or( q.x.greaterThan( 0.999 ) ).or( q.y.lessThan( 0.001 ) ).or( q.y.greaterThan( 0.999 ) ).or( point.z.greaterThan( - 0.1 ) ), () => {

					Break();

				} );
				const depth = sceneViewZ( q ).toVar();
				// (view z is negative: nearer is larger)
				If( point.z.greaterThan( depth ), () => {

					near.assign( distance );
					open.assign( 1 );

				} ).ElseIf( open.greaterThan( 0.5 ), () => {

					open.assign( 0 );
					const crossing = refineCrossing( posV, directionV, near, distance ).toVar();
					const hit = posV.add( directionV.mul( crossing ) ).toVar();
					const qh = projectView( hit, cameraProjectionMatrix ).toVar();
					const visible = hit.mul( sceneViewZ( qh ).div( hit.z ) ).toVar();
					// A crossing at a depth discontinuity brackets an occluder instead of an intersection
					// (the scene seen there lies well in front of the ray); never an above-water surface.
					const miss = length( visible.sub( hit ) );
					const trust = float( 1 ).sub( smoothstep( footprint.mul( 1.5 ).add( 0.08 ), footprint.mul( 3 ).add( 0.35 ), miss ) ).toVar();
					If( trust.greaterThan( 0 ).and( height( visible ).lessThanEqual( surfaceY.add( 0.05 ) ) ), () => {

						// Hits near the screen's edges fade to the fallback over a band wide enough that the
						// change from traced to lost rays, where the refracted rays leave the screen, is a
						// gradual one rather than a line across the water.
						const edge = smoothstep( 0.001, EDGE_FADE, qh.x ).mul( smoothstep( 0.999, 1 - EDGE_FADE, qh.x ) )
							.mul( smoothstep( 0.001, EDGE_FADE, qh.y ) ).mul( smoothstep( 0.999, 1 - EDGE_FADE, qh.y ) );
						result.assign( vec4( qh, max( dot( visible.sub( posV ), directionV ), 0 ), trust.mul( edge ) ) );
						Break();

					} );

				} );

			} );
			return result;

		} ).setLayout( {
			name: 'traceRefraction', type: 'vec4',
			inputs: [
				{ name: 'posV', type: 'vec3' }, { name: 'directionV', type: 'vec3' },
				{ name: 'range', type: 'float' }, { name: 'surfaceY', type: 'float' }, { name: 'footprint', type: 'float' },
			],
		} );

		material.fragmentNode = Fn( () => {

			const time = shared.time;
			const wp = positionWorld;

			// ---- everything that needs screen-space derivatives, while control flow is still uniform
			// Mean slopes and second moments must use the same texture filtering kernel.
			const d0 = texture( der[ 0 ], vLag.div( sizes.x ) ).toVar();
			const d1 = texture( der[ 1 ], vLag.div( sizes.y ) ).toVar();
			const d2 = texture( der[ 2 ], vLag.div( sizes.z ) ).toVar();
			const m0 = texture( moments[ 0 ], vLag.div( sizes.x ) ).toVar();
			const m1 = texture( moments[ 1 ], vLag.div( sizes.y ) ).toVar();
			const m2 = texture( moments[ 2 ], vLag.div( sizes.z ) ).toVar();
			const lagDx = dFdx( vLag ).toVar(), lagDy = dFdy( vLag ).toVar();
			// Product gradients affect both height and the full horizontal Jacobian.
			const weight0Gradient = waveParameterGradient( lagDx, lagDy, dFdx( vWeights.x ), dFdy( vWeights.x ) ).toVar();
			const weight1Gradient = waveParameterGradient( lagDx, lagDy, dFdx( vWeights.y ), dFdy( vWeights.y ) ).toVar();
			const weight2Gradient = waveParameterGradient( lagDx, lagDy, dFdx( vWeights.z ), dFdy( vWeights.z ) ).toVar();
			const shoreWave = shoreWaves.surfaceAt( wp.xz, time ).toVar();
			const footprint = max( length( fwidth( vLag ) ), 1e-4 ).toVar();
			// The foam's texture level: the pixel's area, not its longest side. At grazing angles the
			// longest side is many times the width and would blur the mat into a flat grey film.
			const foamFootprint = max( abs( lagDx.x.mul( lagDy.y ).sub( lagDx.y.mul( lagDy.x ) ) ).sqrt(), 1e-4 ).toVar();

			// ---- surface normal from the cascades' slopes (sampled at the undisplaced position)
			const dd = d0.mul( vWeights.x ).add( d1.mul( vWeights.y ) ).add( d2.mul( vWeights.z ) ).toVar();
			const horizontalCross = m0.w.mul( vWeights.x ).add( m1.w.mul( vWeights.y ) ).add( m2.w.mul( vWeights.z ) );
			const heightGradient = dd.xy.add( weight0Gradient.mul( vLargeDisp.y ) )
				.add( weight1Gradient.mul( vMediumDisp.y ) ).add( weight2Gradient.mul( vFineDisp.y ) ).toVar();
			const xWeight = weight0Gradient.mul( vLargeDisp.x ).add( weight1Gradient.mul( vMediumDisp.x ) )
				.add( weight2Gradient.mul( vFineDisp.x ) ).toVar();
			const zWeight = weight0Gradient.mul( vLargeDisp.z ).add( weight1Gradient.mul( vMediumDisp.z ) )
				.add( weight2Gradient.mul( vFineDisp.z ) ).toVar();
			const horizontal = vec4( dd.z.add( 1 ).add( xWeight.x ), horizontalCross.add( xWeight.y ),
				horizontalCross.add( zWeight.x ), dd.w.add( 1 ).add( zWeight.y ) ).toVar();
			// Rock reflection is sampled in displaced world coordinates: transform its slope
			// by J transpose before combining it with the parameter-space FFT height gradient.
			heightGradient.addAssign( vec2( shoreWave.y.mul( horizontal.x ).add( shoreWave.z.mul( horizontal.z ) ),
				shoreWave.y.mul( horizontal.y ).add( shoreWave.z.mul( horizontal.w ) ) ) );
			// Rain rings live in world XZ, so use the same chain rule as the shore waves.
			// One resolved normal then drives reflection, refraction and the slope frame.
			const rainGradient = rainRippleGradient( wp.xz, time, shared.rain, footprint ).toVar();
			heightGradient.addAssign( vec2( rainGradient.x.mul( horizontal.x ).add( rainGradient.y.mul( horizontal.z ) ),
				rainGradient.x.mul( horizontal.y ).add( rainGradient.y.mul( horizontal.w ) ) ) );
			const N = waveSurfaceNormal( heightGradient, horizontal ).toVar();
			// The shading normal of a steep storm crest can face away from a viewer who still sees
			// the displaced surface; bend it back to just past grazing instead of shading it black.
			const toEye = normalize( cameraPosition.sub( positionWorld ) );
			const facing = dot( N, toEye );
			N.assign( normalize( N.add( toEye.mul( max( float( 0.02 ).sub( facing ), 0 ) ) ) ) );
			// Energy shelter scales variance by amplitude squared. Fine LOD only attenuates
			// the resolved mean; its missing variance remains in the physical glint distribution.
			const rawCovariance = waveSlopeCovariance( d0.xy, m0.xyz ).mul( vWeights.x.mul( vWeights.x ) )
				.add( waveSlopeCovariance( d1.xy, m1.xyz ).mul( vWeights.y.mul( vWeights.y ) ) )
				.add( waveLodCovariance( d2.xy, m2.xyz, vFineWeight ).mul( vDamp.mul( vDamp ) ) ).toVar();
			const unresolvedCovariance = waveCovarianceToTangent( rawCovariance, heightGradient, horizontal ).toVar();

			const toCam = cameraPosition.sub( wp ).toVar();
			const V = toCam.div( length( toCam ) ).toVar();
			const L = shared.sunDir;
			const posV = cameraViewMatrix.mul( vec4( wp, 1 ) ).xyz.toVar();

			// The water uses the same solar angular size, receiver-plane correction and bias as
			// standard materials, and the same fade from the previous map (see SunShadow). Keep
			// comparison sampling outside pixel-dependent branches.
			const sc = u.shadowMatrix.mul( vec4( wp.add( N.mul( this.shadowNormalBias ) ), 1 ) ).toVar();
			const s3 = sc.xyz.div( max( sc.w, 1e-6 ) ).toVar();
			const shadowCoord = vec3( s3.x, float( 1 ).sub( s3.y ), s3.z.add( this.shadowBias ) ).toVar();
			const visibility = sunShadow.surfaceVisibility( shadowCoord );
			const shadow = mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) ).toVar();
			const cloudTransmission = sky.cloudVisibility( wp ).toVar();
			const sunLight = shared.sunColor.mul( shadow ).mul( cloudTransmission ).toVar();

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -9e4 = sky)
			const z0 = behindViewZ.toVar();
			const skyBehind = z0.lessThan( - 9e4 );
			const ray0 = viewRay( screenUV, cameraProjectionMatrixInverse ).toVar();
			const sv0 = ray0.mul( z0.div( ray0.z ) ).toVar();
			const sw0 = cameraWorldMatrix.mul( vec4( sv0, 1 ) ).xyz.toVar();
			const thick = select( skyBehind, float( 1e4 ), posV.z.sub( sv0.z ) ).toVar(); // view distance from the surface to whatever is behind it

			// ---- roughness: measured unresolved spectrum plus a constant microscopic slope width
			// Beckmann alpha squared is twice each Gaussian slope variance; no GGX moment mapping.
			const baseVariance = u.roughness.mul( u.roughness ).mul( 0.5 );
			const seaCovariance = unresolvedCovariance.add( vec3( baseVariance, baseVariance, 0 ) ).toVar();
			const localL = waveLocalDirection( L, N ).toVar(), localV = waveLocalDirection( V, N ).toVar();

			const airFacing = waveAirFacing( N, V ).toVar();
			const NdV = max( dot( N, V ), 1e-4 ).toVar();
			const Fr = fresnelDielectric( NdV, float( IOR ) ).mul( airFacing ).toVar();

			// ---- reflection
			const Rr = reflect( V.negate(), N ).toVar();
			// How the reflected direction turns across a quarter of the pixel, diagonally (taken here,
			// while control flow is uniform): the screen-space reflection traces a ray on either side.
			const reflectionJitter = dFdx( Rr ).add( dFdy( Rr ) ).mul( 0.25 ).toVar();
			// An isotropic mip is an approximation to the anisotropic reflected Gaussian.
			// Match its angular variance to a box mip kernel, keeping the reflection direction intact.
			const reflectionSigma = sqrt( waveReflectionAngularVariance( localV, seaCovariance ) );
			const skyMip = clamp( log2( max( reflectionSigma.mul( Math.sqrt( 12 ) * sky.equirect.height / PI ), 1 ) ),
				0, Math.log2( sky.equirect.height ) );
			const refl = sky.sample( Rr, skyMip ).toVar();
			refl.mulAssign( u.reflection );
			// Optional art control. Zero preserves the calibrated incident sky radiance.
			const lr = lum( refl ).toVar();
			const cap = lum( shared.skyIrradianceSource ).mul( u.skyCap ).toVar();
			If( u.skyCap.greaterThan( 0 ).and( lr.greaterThan( cap ) ), () => {

				refl.mulAssign( cap.add( lr.sub( cap ).mul( 0.12 ) ).div( lr ) );

			} );
			If( u.ssr.greaterThan( 0.5 ).and( Fr.greaterThan( 0.01 ) ), () => {

				// Two rays a quarter pixel either side of the pixel's centre, averaged: a ray either hits
				// the island or shows the sky, so with one ray per pixel the reflected island's edge and
				// the sky seen through it between the waves were pixel stair-steps and single bright
				// specks (that the depth of field then spread into discs). Two rays give the edges a
				// half step and halve a lone speck. The offsets are fixed, so a paused frame repeats.
				// The lower tiers take the one ray through the centre.
				if ( quality.ssrRays === 1 ) {

					const rc = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rr, 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, rc.rgb, rc.a ) );

				} else {

					const ra = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rr.sub( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					const rb = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rr.add( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, ra.rgb, ra.a ).add( mix( refl, rb.rgb, rb.a ) ).mul( 0.5 ) );

				}

			} );

			// ---- sun glint
			const H = normalize( L.add( V ) );
			const NdL = max( dot( N, L ), 0 ).toVar();
			const VdH = max( dot( V, H ), 0 );
			const localH = waveLocalDirection( H, N ).toVar();
			const sunCovariance = seaCovariance.add( waveSolarSlopeCovariance( localL, localV ) );
			const spec = waveBeckmannD( localH, sunCovariance ).mul( waveSmithVisibility( localL, localV, seaCovariance ) )
				.mul( fresnelDielectric( VdH, float( IOR ) ) ).mul( NdL );
			const sunSpec = sunLight.mul( spec ).mul( shared.glintScale ).toVar();
			// Optional artistic lobes add energy beyond the physical microfacet reflection.
			// Both default to zero; the simulated slopes already generate the sun glitter.
			// Uniform branches avoid hashing and extra lobes when their art controls are off.
			// The glitter's patches are the soft mottling of the storm's foam pattern (one binding
			// serves both: this fragment stage already binds WebGPU's guaranteed 16 sampled textures),
			// read at a level from the footprint so that it costs nothing while the lobe is off.
			If( u.sheen.greaterThan( 0 ).or( u.glitter.greaterThan( 0 ) ), () => {

				const reflectionBudget = fresnelDielectric( VdH, float( IOR ) ).mul( NdL ).toVar();
				const Hf = normalize( L.add( V ) ).toVar(); // half vector of a flat sea
				If( u.sheen.greaterThan( 0 ), () => {

					const sheen = D_GGX( Hf.y, float( 0.06 ) ).mul( 0.06 * PI );
					sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( sheen ).mul( u.sheen ) );

				} );
				If( u.glitter.greaterThan( 0 ), () => {

					const wide = D_GGX( Hf.y, float( 0.12 ) ).mul( 0.12 * PI );
					const NdH = max( dot( N, H ), 0 );
					const facet = D_GGX( NdH, float( 0.012 ) ).mul( 0.012 * PI );
					const glitterLevel = log2( max( footprint.div( GLITTER_TILE ).mul( storm.patternSize ), 1e-4 ) );
					const fLow = texture( storm.pattern, wp.xz.div( GLITTER_TILE ).add( vec2( 0.17, 0.39 ) ) ).level( glitterLevel ).z;
					const glintPath = smoothstep( 0.13, 0.8, wide ).mul( smoothstep( 0.42, 0.63, fLow ) );
					sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( glintPath ).mul( facet ).mul( sparkles( wp.xz.mul( 2.1 ).add( N.xz.mul( 2.5 ) ), time ) ).mul( u.glitter ) );

				} );

			} );

			// ---- refraction: trace the refracted ray to the floor through the depth
			// The same resolved wave normal governs reflection and the Snell interface.
			// Air-to-water rays have no total internal reflection; never blend away their bend.
			const opticalNormal = N;
			const Tr = airToWaterDirectionNode( V, opticalNormal, float( IOR ) );
			const Tv = normalize( Tr ).toVar();
			// The screen-space floor tracer only represents a front-facing, downward water leg.
			// Unsupported rays retain its ordinary fallback instead of forcing a new direction.
			const validRefraction = dot( opticalNormal, V ).greaterThan( 1e-5 ).and( Tv.y.lessThan( - 1e-5 ) );
			const tDown = max( Tv.y.negate(), 1e-5 ).toVar();
			const fallbackLength = select( skyBehind, float( 200 ), clamp( max( wp.y.sub( sw0.y ), 0 ).div( tDown ), 0, 200 ) );
			const hit = vec4( screenUV, fallbackLength, 0 ).toVar();
			const traced = skyBehind.not().and( thick.greaterThan( 0.02 ) ).and( validRefraction ).toVar();
			// Where the refracted ray meets the seabed or the island's submerged face, estimated in world
			// space from the shoreline and floor fields (drop below the surface, shoreline distance there,
			// share of the face), and the distance to it along the ray.
			const landing = vec3( 0 ).toVar(), landingDistance = float( 0 ).toVar();
			If( traced, () => {

				// This ray's horizontal course per metre of drop departs from the level sea's, along
				// which the distances were sampled, with the waves' tilt of the surface.
				const level = normalize( airToWaterDirectionNode( V, vec3( 0, 1, 0 ), float( IOR ) ) );
				const bend = Tv.xz.div( tDown ).sub( level.xz.div( max( level.y.negate(), 1e-3 ) ) ).toVar();
				const skew = vec2( dot( vLandingGradients.xy, bend ), dot( vLandingGradients.zw, bend ) );
				landing.assign( seabedLanding( wp.y, shared.waterLevel, vShoreNear, vShoreFar, vFloorNear, vFloorFar, skew, max( tDown, 1e-3 ) ) );
				landingDistance.assign( landing.x.div( max( tDown, 1e-3 ) ) );
				// The trace runs a little past the estimate (its linear steps between the samples and the
				// stones on the floor depart from what the trace meets). Sized from what lies straight
				// behind the pixel, it ran far past the floor where that was the basin seen at a glancing
				// angle, and its coarse steps then bracketed the island's silhouette instead of the floor
				// in front of it.
				const directionV = normalize( cameraViewMatrix.mul( vec4( Tv, 0 ) ).xyz );
				const range = min( landingDistance.mul( 1.25 ).add( 2 ), 40 );
				hit.assign( traceRefraction( posV, directionV, range, wp.y, footprint ) );

			} );
			const refractionTrust = hit.w;

			// ---- the water body: absorption along the path + single scattering of sun and sky
			const sigA = shared.sigA, sigS = shared.sigS;
			const sigT = sigA.add( sigS ).toVar();
			const Ls = refractedSunDirectionNode( L ).toVar();
			const muS = Ls.y;
			const muV = max( Tv.y.negate(), 1e-5 );
			// Match the terrain's refracted beam: transmission retains horizontal power,
			// while beam-normal irradiance changes with the Snell area projection.
			// Surface glint retains its own shadow. A scattering point deeper along
			// the view ray can enter or leave the island's shadow independently of that surface.
			const sunIn = waterIncidentSun( shared.sunColor, cloudTransmission, shared.sunIntoWater, refractedSunBeamScaleNode( L ) ).toVar();
			// Both solar cameras are orthographic. Project the ray once, not at every depth.
			// The air entry has a kink only where a raised wave crosses the mean interface.
			const airBase = u.shadowMatrix.mul( vec4( wp, 1 ) ).xyz.toVar();
			const airStep = u.shadowMatrix.mul( vec4( Tv, 0 ) ).xyz.toVar();
			const airBend = u.shadowMatrix.mul( vec4( Ls.div( muS ), 0 ) ).xyz.toVar();
			const columnDepth = ( distance: F ) => max( shared.waterLevel.sub( wp.y ).sub( Tv.y.mul( distance ) ), 0 );
			const airCoordinate = ( distance: F ) => {

				const p = airBase.add( airStep.mul( distance ) ).add( airBend.mul( columnDepth( distance ) ) );
				return vec3( p.x, float( 1 ).sub( p.y ), p.z.add( this.shadowBias ) );

			};

			// Each source retains its own optical depth while confidence blends the hits.
			// One mixed path would tint a bright shallow source as if it belonged to the basin.
			const opaqueCol = sceneAt( screenUV ).toVar();
			// A ray the trace lost (off the screen, or hidden behind what the screen shows) meets the
			// floor somewhere the screen may not show at all: below a low camera the floor in front of
			// a cliff lies below the frame, and what lies straight behind the pixel is the cliff's
			// submerged face on one side of its silhouette and the floor far beyond on the other.
			// Taking the colour and the depth from there drew a seam down the water below every cliff
			// edge. The floor the ray meets is the world-space estimate instead, lit as the terrain
			// lights it under water, so that lost rays continue each other and their traced neighbours.
			const lostPath = fallbackLength.toVar();
			const lostBottom = opaqueCol.mul( exp( sigT.negate().mul( fallbackLength ) ) ).toVar();
			If( traced.and( refractionTrust.lessThan( 1 ) ), () => {

				const gradient = vLandingGradients.toVar();
				const at = wp.add( Tv.mul( landingDistance ) ).toVar();
				const depthAt = max( shared.waterLevel.sub( at.y ), 0 ).toVar();
				const shoreAt = landing.y.toVar();
				const wall = landing.z;
				const normal = normalize( mix( vec3( gradient.z.negate(), 1, gradient.w.negate() ),
					vec3( gradient.x, WALL_LEAN, gradient.y ), wall ) ).toVar();
				// The key light: the island's shadow where the refracted beam enters the sea, and the
				// submerged map halfway up the beam, where the cliff's foot and the walls of a cove shade
				// it while the stones on the floor, which the estimate cannot place, stay below.
				const visibility = sunShadow.volumeVisibility( airCoordinate( landingDistance ) ).toVar();
				If( visibility.greaterThan( 0 ), () => {

					const midway = at.add( Ls.mul( depthAt.mul( 0.5 ).div( muS ) ) );
					visibility.mulAssign( refractedSun.submergedVolumeVisibilityAtCoordinateNode( refractedSun.submergedVolumeCoordinateNode( midway ) ) );

				} );
				const lit = mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) );
				const direct = sunIn.mul( exp( sigT.negate().mul( depthAt ).div( muS ) ) ).mul( max( dot( normal, Ls ), 0 ) ).mul( lit );
				const ambient = shared.skyIrradianceSource.mul( exp( sigT.negate().mul( depthAt ).mul( 1.25 ) ) ).mul( mix( float( 1 ), float( FACE_SKY ), wall ) );
				// The floor as its material paints it, which no screen shows here: its seagrass beds, pale
				// sand and rubble (seabedAlbedo) from where the vertices' rays land, and in place of its
				// tiled detail heights, which this stage has no texture slot for, world-space noise about
				// their means, so that the detail stays put under the waves and runs on across lost rays.
				const detail = vec3(
					valueNoise( at.xz.div( 1.1 ).add( 17.3 ) ).sub( 0.5 ).mul( DETAIL_SPREAD.x ).add( DETAIL_MEAN.x ),
					valueNoise( at.xz.div( 1.6 ).add( 41.7 ) ).sub( 0.5 ).mul( DETAIL_SPREAD.y ).add( DETAIL_MEAN.y ),
					valueNoise( at.xz.div( 0.9 ).add( 5.3 ) ).sub( 0.5 ).mul( DETAIL_SPREAD.z ).add( DETAIL_MEAN.z ) );
				const floorLook = seabedAlbedo( vLandingLook.xy, vLandingLook.z, detail, shoreAt );
				const albedo = mix( floorLook.albedo, FACE_ALBEDO, wall );
				lostBottom.assign( albedo.div( PI ).mul( direct.add( ambient ) ).mul( exp( sigT.negate().mul( landingDistance ) ) ) );
				lostPath.assign( landingDistance );
				// Where what lies straight behind the pixel is the place the ray meets (the floor below a
				// high camera, a stone on it, the same cliff face a little higher), the screen shows it:
				// its own colour and depth take over, as they did before the estimate.
				If( skyBehind.not().and( sw0.y.lessThan( shared.waterLevel ) ), () => {

					// Its kind from its normal (from the neighbouring depth texels: the nearer of each pair
					// of one-sided differences, so that a silhouette does not tilt it): the floor behind a
					// ray that meets the cliff, or the face behind a ray that meets the floor, never stands in.
					const behindAt = ( dx: number, dy: number ) => {

						const q = screenUV.add( vec2( dx, dy ).div( depthSize ) );
						const ray = viewRay( q, cameraProjectionMatrixInverse );
						return ray.mul( textureLoad( tDepth, pixel( q ) ).y.div( ray.z ) ).toVar();

					};
					const right = behindAt( 1, 0 ), left = behindAt( - 1, 0 ), below = behindAt( 0, 1 ), above = behindAt( 0, - 1 );
					const across = select( abs( right.z.sub( sv0.z ) ).lessThan( abs( left.z.sub( sv0.z ) ) ), right.sub( sv0 ), sv0.sub( left ) );
					const along = select( abs( below.z.sub( sv0.z ) ).lessThan( abs( above.z.sub( sv0.z ) ) ), below.sub( sv0 ), sv0.sub( above ) );
					const facing = normalize( cameraWorldMatrix.mul( vec4( across.cross( along ), 0 ) ).xyz );
					// The talus at the cliff's foot slopes toward the face's normal, so the kinds are told
					// apart by how far each looks up as well.
					const upward = smoothstep( 0.35, 0.75, abs( facing.y ) );
					const stand = smoothstep( 0.2, 0.6, abs( dot( facing, normal ) ) ).mul( mix( upward, float( 1 ).sub( upward ), wall ) )
						.mul( float( 1 ).sub( smoothstep( 0.5, 2.5, length( sw0.sub( at ) ) ) ) ).toVar();
					If( stand.greaterThan( 0 ), () => {

						// Moved with the waves' share of the refraction (the bend of this facet beyond a level
						// sea's), so that it wobbles as the traced floor does; shifted onto what stands above
						// the sea, it keeps the floor straight behind.
						const behindCol = opaqueCol.toVar();
						const level = airToWaterDirectionNode( V, vec3( 0, 1, 0 ), float( IOR ) );
						const shifted = sv0.add( cameraViewMatrix.mul( vec4( Tv.sub( normalize( level ) ), 0 ) ).xyz.mul( fallbackLength ) ).toVar();
						const qs = projectView( shifted, cameraProjectionMatrix ).toVar();
						const zs = sceneViewZ( qs ).toVar();
						const seen = cameraWorldMatrix.mul( vec4( shifted.mul( zs.div( shifted.z ) ), 1 ) ).y;
						If( seen.lessThanEqual( wp.y.add( 0.05 ) ).and( zs.greaterThan( - 9e4 ) ), () => {

							behindCol.assign( sceneAt( clamp( qs, vec2( 0.001 ), vec2( 0.999 ) ) ) );

						} );
						lostBottom.assign( mix( lostBottom, behindCol.mul( exp( sigT.negate().mul( fallbackLength ) ) ), stand ) );
						lostPath.assign( mix( landingDistance, fallbackLength, stand ) );

					} );

				} );

			} );
			const pathLen = mix( lostPath, hit.z, refractionTrust ).toVar();
			const bottom = lostBottom.toVar();
			// Lost rays use only the fallback floor. Their zero confidence makes the three blurred
			// colour samples and refracted attenuation redundant.
			If( refractionTrust.greaterThan( 0 ), () => {

				const uvR = hit.xy;
				// Unresolved slopes soften deeper refraction while near-surface rocks stay legible.
				const refractBlur = min( pathLen.mul( 0.28 ), 1.8 ).div( depthSize );
				const refractedCol = sceneAt( uvR ).mul( 0.5 )
					.add( sceneAt( clamp( uvR.add( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) )
					.add( sceneAt( clamp( uvR.sub( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) );
				bottom.assign( mix( bottom, refractedCol.mul( exp( sigT.negate().mul( hit.z ) ) ), refractionTrust ) );

			} );
			const kSun = sigT.mul( muV.div( muS ).add( 1 ) ).toVar();
			const kAmb = sigT.mul( muV.div( 0.75 ).add( 1 ) ).toVar();
			const ph = phaseHG( dot( Tv, Ls ), float( 0.86 ) ).mul( 0.7 ).add( 0.3 / ( 4 * PI ) );
			const bb = sigS.mul( u.backscatter );
			const albedoMS = bb.mul( 0.33 * 4 ).div( sigA.add( bb ) ).toVar();
			// The MS source remains an empirical backscatter boost, not a conserved GI model.
			const solarSource = sunIn.mul( sigS.mul( ph ).add( albedoMS.mul( sigT ).div( PI ) ) );
			const wetStart = refractedSun.submergedVolumeCoordinateNode( wp ).toVar();
			const wetEnd = refractedSun.submergedVolumeCoordinateNode( wp.add( Tv.mul( pathLen ) ) ).toVar();
			const interfaceDistance = clamp( shared.waterLevel.sub( wp.y ).div( min( Tv.y, - 1e-5 ) ), 0, pathLen );
			const airStart = airCoordinate( float( 0 ) ).toVar();
			const airTurn = airCoordinate( interfaceDistance ).toVar();
			const airEnd = airCoordinate( pathLen ).toVar();
			const mayBeShadowed = volumeShadowRayMayIntersect( airStart, airTurn )
				.or( volumeShadowRayMayIntersect( airTurn, airEnd ) ).or( volumeShadowRayMayIntersect( wetStart, wetEnd ) );
			const inSun = waterColumnRadiance( solarSource, kSun, pathLen ).toVar();
			// Open-sea rays outside both maps keep the exact analytic solution without marching.
			If( u.shadowOn.greaterThan( 0 ).and( this.shadowIntensity.greaterThan( 0 ) ).and( mayBeShadowed ), () => {

				inSun.assign( waterShadowedColumnRadiance( solarSource, kSun, pathLen, ( distance ) => {

					const visibility = sunShadow.volumeVisibility( airCoordinate( distance ) ).toVar();
					If( visibility.greaterThan( 0 ).and( columnDepth( distance ).greaterThan( 0 ) ), () => {

						const coordinate = mix( wetStart, wetEnd, distance.div( max( pathLen, 1e-5 ) ) );
						visibility.mulAssign( refractedSun.submergedVolumeVisibilityAtCoordinateNode( coordinate ) );

					} );
					return mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) );

				}, quality.columnSamples ) );

			} );
			const inAmb = waterColumnRadiance( shared.skyIrradianceSource.mul( sigS.mul( 0.25 ).add( albedoMS.mul( sigT ) ) ), kAmb, pathLen );
			// sun shining through the thin crests of the waves
			const vH = normalize( V.xz.add( 1e-5 ) ), lH = normalize( L.xz.add( 1e-5 ) );
			const back = pow( sat( dot( vH, lH.negate() ).mul( 0.6 ).add( 0.4 ) ), 2.5 );
			const crest = sat( wp.y.sub( shared.waterLevel ).mul( 4 ).add( 0.2 ) ).mul( sat( float( 1 ).sub( N.y ).mul( 6 ) ).add( 0.2 ) );
			const sss = sunLight.mul( vec3( 0.12, 0.55, 0.45 ) ).mul( back.mul( crest ).mul( 0.035 ) );
			const transmitted = bottom.add( inSun ).add( inAmb ).add( sss );

			// The opaque underwater pass and column terms are radiance inside water. Convert
			// that radiance once at the exit interface; mix already supplies Fresnel 1 - Fr.
			const exiting = radianceAcrossInterfaceNode( transmitted, float( IOR ), float( 1 ) );
			const water = mix( exiting, refl, Fr ).add( sunSpec );
			// Backfacing facets are self-occluded: neither the air reflection nor underwater
			// transmission emerges through their back side. Neighbor-wave transport is unresolved.
			const col = water.mul( airFacing ).toVar();
			// (temporal modes) the glints' reactive weight: their luminance against a white diffuse
			// surface under the same sun and sky (the note at the top)
			const reactive = TEMPORAL ? smoothstep( reactiveUniforms.glintFrom, reactiveUniforms.glintTo, lum( sunSpec ).mul( airFacing )
				.div( max( lum( shared.skyIrradianceSource.add( sunLight.mul( max( L.y, 0 ) ).div( PI ) ) ), 1e-6 ) ) ).mul( reactiveUniforms.glintMax ) : null;
			// Whitecaps in a storm (Tessendorf's choppy-wave criterion: the horizontal Jacobian of the
			// summed cascades nears a fold). StormSea integrates where the steepest crests break and
			// the foam that trails behind a breaker and fades over seconds; this pixel's own fold
			// sharpens the crest inside the breaking cells it reports. Two looks, as on a real sea:
			// at the crest a dense bubbly mat (tidewater's WaterSurface thresholds it by the fresh
			// breaking, so it grows and tears with ragged, soft edges), behind it a marbled lace of
			// veins around dark open cells, drawn out along the wind, whose veins thin as the foam
			// decays. Old foam never closes back into a mat, so between the crests the sea stays dark.
			If( shared.storm.greaterThan( 0.001 ), () => {

				const fold = horizontal.x.mul( horizontal.w ).sub( horizontal.y.mul( horizontal.z ) ).toVar();
				const wind = shared.wind.direction;
				const along = dot( vLag, wind ).toVar(), across = dot( vLag, vec2( wind.y.negate(), wind.x ) ).toVar();
				const field = storm.foamAt( vLag, foamFootprint ).toVar(); // persistent, breaking, weight
				const scale = storm.patternScale;
				const patternLevel = log2( max( foamFootprint.mul( scale ).mul( storm.patternSize ), 1e-4 ) ).toVar();
				const streakLevel = log2( max( foamFootprint.mul( 0.11 ).mul( storm.patternSize ), 1e-4 ) ).toVar();
				// Large soft patches (the pattern's mottling, some 250 m across) stand in for the
				// field's wave groups beyond its window, where only this pixel's fold can find a crest.
				const patches = texture( storm.pattern, vLag.mul( 0.004 ).add( 0.37 ) ).level( streakLevel.sub( 4.8 ).max( 0 ) ).z.toVar();
				const farCrest = clamp( float( 0.88 ).sub( fold ).mul( 6 ), 0, 1 ).mul( smoothstep( 0.5, 0.62, patches ) )
					.mul( float( 1 ).sub( field.z ) ).mul( 0.75 );
				const sharpen = smoothstep( 1.0, 0.78, fold );
				const aged = clamp( field.x.mul( field.z ).mul( storm.coverage ), 0, 1 ).toVar();
				// The mat covers the breaking crest and, for a second or so after it has passed, the
				// thick foam it left (the field's foam stays near 1 there) before that tears into lace.
				const crest = clamp( max( max( field.y.mul( field.z ).mul( sharpen.mul( 0.8 ).add( 0.6 ) ), smoothstep( 0.55, 1, aged ).mul( 0.8 ) ),
					farCrest ).mul( storm.coverage ), 0, 1 ).toVar();
				const soft = foamFootprint.mul( 0.1 ).add( 0.07 ).toVar();
				// The mat: two layers of the pattern at different scales and angles (explicit levels
				// from the footprint, since this is a branch). Thin at its torn edges, dense inside.
				const fuv = vLag.mul( scale ).toVar();
				const p1 = texture( storm.pattern, fuv ).level( patternLevel ).toVar();
				const merged = quality.stormFoam === 'merged';
				let matPattern: F = p1.x;
				if ( ! merged ) {

					const r2 = vec2( fuv.x.mul( 0.8 ).sub( fuv.y.mul( 0.6 ) ), fuv.x.mul( 0.6 ).add( fuv.y.mul( 0.8 ) ) );
					const p2 = texture( storm.pattern, r2.mul( 2.37 ).add( vec2( 0.31, 0.77 ) ) ).level( patternLevel.add( Math.log2( 2.37 ) ) ).toVar();
					matPattern = p1.x.mul( 0.62 ).add( p2.x.mul( 0.38 ) );

				}
				const threshold = float( 1.02 ).sub( crest.mul( 0.78 ) );
				const mat = smoothstep( threshold.sub( soft ), threshold.add( soft ), matPattern )
					.mul( smoothstep( threshold, threshold.add( 0.25 ), matPattern ).mul( 0.35 ).add( 0.65 ) ).mul( 0.95 );
				// The lace, stretched 2.4 times along the wind. A vein's width follows the foam left;
				// a thin film of bubbles lets the water show through, so lace is never fully opaque.
				// (Merged, the mat's own fetch carries the lace, unstretched.)
				const lscale = scale * 1.1;
				const lace = merged ? p1.y : texture( storm.pattern, vec2( along.mul( lscale / 2.4 ), across.mul( lscale ) ).add( vec2( 0.13, 0.58 ) ) )
					.level( patternLevel.add( Math.log2( 1.1 ) ) ).y;
				const veinWidth = aged.mul( 0.5 ).toVar();
				const veinOpacity = aged.mul( 0.45 ).add( 0.4 ).mul( smoothstep( 0.02, 0.12, aged ) ).toVar();
				const veins = smoothstep( float( 1 ).sub( veinWidth ).sub( soft ), float( 1 ).sub( veinWidth ).add( soft ), lace ).mul( veinOpacity );
				// At a distance the pattern averages out: the veins become their mean coverage, and the
				// mat the crest itself, sharpened so that a distant whitecap stays a small white fleck
				// on its crest rather than a grey film.
				const laceMean = veinWidth.mul( veinOpacity ).mul( 0.5 );
				const far = smoothstep( 0.15, 1.2, foamFootprint ).toVar();
				const near = max( mix( mat, smoothstep( 0.08, 0.6, crest ).mul( 0.85 ), far ), mix( veins, laceMean, far ) );
				// Fine streaks a few tens of metres long where foam has been, and far out in the rough
				// patches between, where they are what is left of the whitecaps.
				const streak = texture( storm.pattern, vec2( along.mul( 0.012 ), across.mul( 0.11 ) ) ).level( streakLevel ).w;
				const rough = float( 1 ).sub( smoothstep( 0.8, 1.02, fold ) );
				const streaks = smoothstep( 0.6, 0.78, streak )
					.mul( clamp( aged.mul( 1.2 ).add( rough.mul( smoothstep( 0.5, 0.62, patches ) ).mul( 0.3 ) ), 0, 1 ) ).mul( 0.25 );
				const foam = clamp( max( near, streaks ).mul( smoothstep( 0, 0.6, shared.storm ) ), 0, 0.95 );
				// A diffuse off-white lit by the scene's key light (shadowed by the island and the clouds)
				// and by the sky, like the island's surfaces: dark under a storm sky and at night. A
				// lightning flash multiplies the sky fill several times over; on foam alone that turns the
				// sea into white confetti, so the foam follows the flash only by its square root.
				const fill = max( shared.skyFill, 1 );
				const wrap = max( dot( N, L ), 0 ).mul( 0.75 ).add( 0.25 );
				const lit = shared.skyIrradianceSource.div( fill.sqrt() ).add( sunLight.mul( wrap ).div( PI ) ).mul( storm.albedo );
				col.assign( mix( col, lit, foam.mul( airFacing ) ) );

			} );

			// soften the line where the surface cuts the rock (no hard seam); behind rock: the rock
			const edge = select( skyBehind, float( 1 ), smoothstep( 0, 0.06, thick ) );
			col.assign( mix( opaqueCol, col, edge ) );
			return vec4( min( col, vec3( 30000 ) ), reactive ?? 1 );

		} )();
		// the temporal modes' second output, the velocity (Motion.ts): the camera's motion and the
		// waves' (their previous position, above), and the glints' reactive weight (the shading's
		// alpha under the temporal modes)
		if ( TEMPORAL ) {

			const shade = material.fragmentNode as V4;
			material.fragmentNode = outputStruct( vec4( shade.xyz, 1 ), motionNode( 'water', shade.w ) );

		}
		material.userData.motion = 'animated';
		material.side = THREE.DoubleSide;
		return material;

	}

	// per frame, before the water draw
	prepare( sun: THREE.DirectionalLight ): void {

		const u = this.uniforms;
		// the temporal modes' step of the clock, once per rendered frame (after Motion.ts began it)
		if ( TEMPORAL && this.clock.frame !== motionState.frame ) {

			const time = this.inputs.shared.time.value, step = time - this.clock.time;
			const continuous = this.clock.frame === motionState.frame - 1 && ! motionState.cut && step >= 0 && step <= MAX_MOTION_STEP;
			this.step.value = continuous ? step : 0;
			this.shoreHistory.value = this.step.value > 0 ? 1 : 0;
			this.ownMotion.value = debugFlags.mv.sea === false ? 0 : 1;
			this.clock.frame = motionState.frame;
			this.clock.time = time;

		}
		this.reflectorMin.value.copy( this.reflectionBounds.min );
		this.reflectorMax.value.copy( this.reflectionBounds.max );
		// debugFlags.ssrCull / ssrClip = false bring back the march without the box, for A/B timing
		// in one page (each variant is its own material and pipeline, built on first use).
		const variant = { cull: debugFlags.ssrCull !== false, clip: debugFlags.ssrClip !== false };
		const key = variantKey( variant );
		let material = this.materials.get( key );
		if ( ! material ) this.materials.set( key, material = this.buildMaterial( variant ) );
		if ( this.mesh.material !== material ) this.mesh.material = this.material = material;
		// Debug builds check once that the box holds what the scene lit by the key light draws
		// above the sea (the islanders walk, so their measure is only the first frame's).
		if ( DEBUG && ! this.boundsChecked && sun.parent ) {

			this.boundsChecked = true;
			this.checkReflectionBounds( sun.parent );

		}
		const map = sun.shadow.map as ( THREE.RenderTarget | null );
		if ( sun.castShadow && map && map.depthTexture ) {

			// the maps themselves are read through SunShadow
			this.shadowBias.value = sun.shadow.bias;
			this.shadowNormalBias.value = sun.shadow.normalBias;
			this.shadowIntensity.value = sun.shadow.intensity;
			u.shadowMatrix.value.copy( sun.shadow.matrix );
			u.shadowOn.value = 1;

		} else u.shadowOn.value = 0;

	}

	/** The reflection's box for the land's box `b` (WorldShapes.landBounds): again when the land
	 * grows (Growth.ts), which grows it; whatever was held beyond it (a placed prop: the caller
	 * unions it in again) is dropped. Debug builds measure the scene against it once, at the load:
	 * not after a growth step, whose frame it would take tens of milliseconds (it reads every
	 * vertex); a page loaded on the grown land measures that land. */
	setLand( b: Bounds ): void {

		this.reflectionBounds.set(
			new THREE.Vector3( b.x0 - REFLECTOR_REACH, this.inputs.shared.waterLevel.value - REFLECTION_FLOOR, b.z0 - REFLECTOR_REACH ),
			new THREE.Vector3( b.x1 + REFLECTOR_REACH, ISLAND_TOP + REFLECTOR_HEIGHT, b.z1 + REFLECTOR_REACH ) );

	}

	// The measured box of every opaque surface under root above the reflection's floor, against
	// reflectionBounds; warns about any that pokes out (its reflection would be lost). Debug only:
	// it reads every vertex once.
	checkReflectionBounds( root: THREE.Object3D ): THREE.Box3 {

		const floor = this.reflectionBounds.min.y;
		const measured = new THREE.Box3(), part = new THREE.Box3(), v = new THREE.Vector3();
		const outside: string[] = [];
		const skip = new Set<THREE.Object3D>();
		this.inputs.sky.dome.traverse( ( o ) => skip.add( o ) );
		this.inputs.sky.lightning.group.traverse( ( o ) => skip.add( o ) );
		root.updateWorldMatrix( true, true );
		// Only what is drawn: a hidden group's children are skipped with it.
		root.traverseVisible( ( object ) => {

			const mesh = object as THREE.Mesh;
			if ( ! mesh.isMesh || skip.has( mesh ) ) return;
			const materials = Array.isArray( mesh.material ) ? mesh.material : [ mesh.material ];
			if ( materials.every( ( m ) => m.transparent || ! m.depthWrite ) ) return;
			part.makeEmpty();
			if ( ( mesh as THREE.InstancedMesh ).isInstancedMesh || ( mesh as THREE.SkinnedMesh ).isSkinnedMesh ) {

				const posed = mesh as THREE.InstancedMesh | THREE.SkinnedMesh;
				posed.computeBoundingBox();
				part.copy( posed.boundingBox! ).applyMatrix4( mesh.matrixWorld );
				if ( part.max.y <= floor ) return;
				part.min.y = Math.max( part.min.y, floor );

			} else {

				const position = mesh.geometry.getAttribute( 'position' );
				if ( ! position ) return;
				for ( let i = 0; i < position.count; i ++ ) {

					v.fromBufferAttribute( position, i ).applyMatrix4( mesh.matrixWorld );
					if ( v.y > floor ) part.expandByPoint( v );

				}

			}
			if ( part.isEmpty() ) return;
			measured.union( part );
			if ( ! this.reflectionBounds.containsBox( part ) ) outside.push( mesh.name || mesh.type );

		} );
		if ( outside.length ) console.warn( 'Water: opaque surfaces above the sea lie outside reflectionBounds, so the sea will not reflect all of them:', outside, measured, this.reflectionBounds );
		return measured;

	}

}
