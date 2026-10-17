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
	float, int, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, pow, sqrt, exp, log2,
	abs, fwidth, reflect, refract, select, step, dFdx, dFdy, perspectiveDepthToViewZ, cameraNear, cameraFar,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import { FFT_SIZE, type OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import type { StormSea } from './StormSea.ts';
import type { SeaDetail } from './SeaDetail.ts';
import { REFRACTION_GUARD } from './Refraction.ts';
import { waveDamping } from './WaveDamping.ts';
import type { Shared } from '../shared.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import { rainRippleGradient } from '../weather/Rain.ts';
import { ISLAND_TOP, type Bounds } from '../world/WorldShapes.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { REFERENCE_SPEED } from '../weather/Wind.ts';
import { motionNode, motionState, motionUniforms, outputStruct, reactiveUniforms } from '../post/Motion.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';

// The sea surface: an FFT-displaced grid shaded as tidewater's WaterMaterial (4811ba4, its above-water
// branch; the camera never goes under the sea):
//   - the normal from the cascades' slopes over their horizontal stretch (WaterSurface), with
//     near-field capillary ripples, the rocky shore's reflected wave and the rain's rings
//   - the sea's large-scale detail in world space (SeaDetail): gusts roughen the short waves the
//     pixel cannot resolve and the near ripples, slicks smooth them, gusts and windrows add whitecaps;
//     around the island the gusts are the meadow's, read in the vertex stage
//   - the sun reaching the surface (`sunLight`): the key light through the sun shadow's maps (as
//     tidewater's water reads its own: three's five-tap PCF at the surface point, the normal bias
//     straight up) and the clouds; the glint, the water body and the foam all take this one light
//   - exact dielectric Fresnel; the sky reflected along a direction the unresolved slopes lift
//     toward the higher, darker sky, reflections below the horizon darkened toward the horizon's
//     colour; the screen-space reflection of the cliffs and the islanders behind tidewater's gate
//     (rays near the horizon, reflectance over 0.05)
//   - the sun's specular: GGX of the base roughness and the slopes the pixel cannot resolve (Cox-
//     Munk's mean square slope for the wind, the share finer than the pixel)
//   - refraction: the refracted view ray followed to the floor's height field, its end projected
//     into the refraction pass's image of the world under the sea (Refraction.ts, through its wider
//     view: the floor behind the cliffs above the waterline, and below the screen's bottom edge)
//     where it lies behind the surface, else straight behind in that image; where the image holds
//     nothing there (the shallows above its clip height, the sky), the opaque image, as before; a
//     thin sheet of water takes the opaque image of the rock under it
//   - the water body: Beer-Lambert absorption along that path, analytic single scattering of the sun
//     and the sky (Henyey-Greenstein) and a multiple-scattering backscatter boost; the sun through the
//     thin crests; whitecaps where the surface is compressed (tidewater's fresh foam, not its
//     persistent foam, which integrates in time), lit as a bright diffuse scatterer
// Drawn after the opaque pass into the same multisampled target, depth-tested per sample against
// the opaque surfaces, reading a copy of that pass's resolved colour and its linear depth, and the
// refraction pass's colour and depth.
//
// Kept of our own: the grid and its skirt, the waves' damping by the shore (the vertex stage), the
// rocky shore's reflected wave (ShoreWaves), the reflection march with its box and the cliff foot's
// lifted hit (traceSSR), the soft line where the surface cuts the rock, the motion vectors, the
// rain's ripples and the storm's foam (parked weathers).
// The sea continues to the horizon (a skirt around the wave grid, SKIRT_RADIUS); the camera's far
// plane and the sky-depth thresholds (-9e4; the resolved sky is -1e5) stay beyond it.
//
// Limits to keep in mind:
// - WebGPU guarantees 16 sampled textures per stage (a texture past them fails pipeline creation),
//   and the fragment stage samples 14: the FFT's fields are array textures, a layer per cascade,
//   the sun's two shadow steps share one array texture, and the storm foam is a storage buffer.
// - The reflection only finds what lies inside `reflectionBounds` (see below): anything opaque
//   placed off the island or above 3 m (REFLECTOR_HEIGHT; a palm, a boat, a hut, a mast) must grow
//   that box, or the sea will not reflect it (the game's props do: main.ts `holdOpaque`).
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

// the height-correlated Smith visibility for GGX, V = G / ( 4 NdL NdV )
const V_SmithGGX = Fn( ( [ NdL, NdV, a2 ]: [ F, F, F ] ) => {

	const gv = NdL.mul( sqrt( NdV.mul( NdV ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	const gl = NdV.mul( sqrt( NdL.mul( NdL ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	return float( 0.5 ).div( max( gv.add( gl ), 1e-5 ) );

} ).setLayout( { name: 'V_SmithGGX', type: 'float', inputs: [ { name: 'NdL', type: 'float' }, { name: 'NdV', type: 'float' }, { name: 'a2', type: 'float' } ] } );

// a 2D vector turned by an angle (radians)
const rotate = ( v: V2, angle: number ) => vec2( v.x.mul( Math.cos( angle ) ).sub( v.y.mul( Math.sin( angle ) ) ), v.x.mul( Math.sin( angle ) ).add( v.y.mul( Math.cos( angle ) ) ) );

// The sea continues to this distance (metres), well past the horizon for any review camera.
const SKIRT_RADIUS = 40000;

// The longest step of the scene clock between two rendered frames that is still motion; a longer
// one (or a step back) is a seek, which has none (as StormSea's live step).
const MAX_MOTION_STEP = 0.25;

// The whitecaps' foam pattern, repeats per metre (tidewater's foamScale).
const FOAM_SCALE = 0.09;

// The sky panorama's level the horizon's colour is read at (a band some 20 degrees high).
const HORIZON_MIP = 5;

// The reflection's march stops this far along the ray (m); its hits fade out from 120 m (tidewater's).
const SSR_FARTHEST = 260;

// A refracted sample serves when it lies this far behind the water's surface (view depth, m).
const WATER_BEHIND = 0.05;

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

export interface WaterInputs {
	fft: OceanFFT;
	sky: Sky;
	shared: Shared;
	shore: THREE.Texture | THREE.TextureNode;
	seabedHeight: THREE.Texture | THREE.TextureNode; // the rendered floor's height over the shoreline field's bounds
	land: Bounds; // the land's box (WorldShapes.landBounds), for reflectionBounds
	shoreWaves: ShoreWaves;
	sunShadow: SunShadow;
	storm: StormSea;
	detail: SeaDetail; // gusts, slicks and windrows
	sceneColor: THREE.Texture; // the opaque pass's resolved colour
	linearDepth: THREE.Texture; // its view-space z: sample 0 (x) and the farthest sample (y)
	refraction: { color: THREE.Texture; depth: THREE.Texture }; // the refraction pass's image (Refraction.ts)
	size?: number;
	res?: number;
	quality?: Partial<WaterQuality>; // compile-time: read once, a change needs a new Water (a reload)
}

// The water's quality knobs. They are compiled into the shader (a uniform-gated branch keeps its
// registers), so they are fixed for the material's life. High is the reference image; the lower
// tiers trade a little of it for time:
//   ssrRays: rays per pixel for the screen-space reflection, either side of the centre (2) or
//     through it (1, a little stair-stepping on the reflected island's edge);
//   ssrSteps, ssrGrowth: its geometric steps, each this much longer than the last. Within 60 m
//     of the camera the march reaches 0.15 + 0.25 (growth^steps - 1) / (growth - 1) metres: 158 m
//     on high, 100 m for 14 steps at x1.45 (14 at about x1.51 would keep the 158 m); farther away
//     every step grows with the distance, up to SSR_FARTHEST;
//   ssrMinFresnel: the reflectance under which a pixel marches no reflection and keeps the sky
//     (tidewater's gate). 0.05 on every tier: it skips most of the sea the island camera looks
//     down on, for about a seventh of the island views' water pass, and with it the faint (2-5 %
//     reflectance) image of the cliffs in the water at their feet (1-2 % of those views' pixels
//     moved more than 8 levels against 0.01); the low views over the sea, where the reflectance is
//     high, keep their reflection;
//   ssrOneRayFresnel: the reflectance under which a pixel takes one ray through its centre instead
//     of two (ssrRays 2 only). The second ray's stair-step and speck are scaled by the reflectance:
//     at 0.05 with the gate at 0.01 it took about a fourteenth of the island views' water pass
//     with under 0.1 % of their pixels moved more than 8 levels (at 0.1 short bright streaks showed
//     at the cliffs' foot). It acts only above ssrMinFresnel: at or under it no shader is built for
//     it, as on high, whose gate already skips those pixels;
//   stormFoam: 'merged' reads the storm foam's mat and lace from one pattern fetch instead of
//     three: the mat keeps only its first layer, and the lace takes the mat's coordinates, so it
//     is no longer drawn out along the wind. The streaks keep their own fetch (they need
//     coordinates stretched along the wind), so 'merged' saves two of the five fetches;
//   fftAnisotropy: the FFT output targets' anisotropic filtering (read by OceanFFT, not here; its
//     six fetches per pixel). It costs only at grazing angles: the island's views, which look
//     down, take no time for it. 4 on high: against 8 it changed under 2 % of the horizon view's
//     pixels, unseen side by side, for about a twelfth of that view's water pass; 2 dulled the
//     far glitter (a tenth of the pixels).
export interface WaterQuality {
	ssrRays: 1 | 2;
	ssrSteps: number;
	ssrGrowth: number;
	ssrMinFresnel: number;
	ssrOneRayFresnel: number;
	stormFoam: 'full' | 'merged';
	fftAnisotropy: number;
}

// High's values; the tiers' values are in Quality.ts.
export const DEFAULT_WATER_QUALITY: Readonly<WaterQuality> = { ssrRays: 2, ssrSteps: 20, ssrGrowth: 1.3, ssrMinFresnel: 0.05, ssrOneRayFresnel: 0.05, stormFoam: 'full', fftAnisotropy: 4 };

// The screen-space reflection can only find what the opaque pass drew above the sea: the island,
// its plants and its people. A box around them, from the land's box (so it grows with the island):
// out past the land's edge by the rim's overhang (the grass hanging from the lip, and room for
// more) plus a metre's margin, and up past the meadow by the islanders'
// 2 m plus a metre.
// Hits below REFLECTION_FLOOR under the sea level already weigh nothing (see traceSSR), so the box
// ends there. A placed object off the island or above 3 m (a palm, a hut, a mast) or a wider rim
// overhang must grow these, or its reflection is lost (debug builds warn, see checkReflectionBounds).
const REFLECTOR_REACH = 1.5 + 1;
const REFLECTOR_HEIGHT = 3;
const REFLECTION_FLOOR = 0.35;

// The ways of building the sea's shading, each its own material (a debug flag picks one, for A/B
// timing in one page). How the reflection's march uses that box: cull, a ray that never meets it
// within the march's reach keeps the sky without marching (most of the sea away from the island);
// clip, a ray stops at its first step past the box, where nothing is left to reflect. The steps
// before the box still read the depth buffer: the march accepts a hit up to 1.4 steps behind it,
// so one of them can end a ray on a far false hit (or on a hit that weighs nothing) where a ray
// started at the box would march on and find another, and the image would change. refraction: the
// refraction pass's image is the refraction source (else the opaque copy alone).
interface WaterVariant { cull: boolean; clip: boolean; refraction: boolean }
const SHIPPED: WaterVariant = { cull: true, clip: true, refraction: true };
const variantKey = ( v: WaterVariant ) => ( v.cull ? 1 : 0 ) + ( v.clip ? 2 : 0 ) + ( v.refraction ? 4 : 0 );

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
	// tidewater's water material's settings
	uniforms = {
		backscatter: uniform( 0.035 ),
		roughness: uniform( 0.035 ), // GGX alpha of the surface the slopes do not describe
		ssr: uniform( 1 ),
		reflection: uniform( 1 ),
		sss: uniform( 1 ), // the crests' translucency
		foamIntensity: uniform( 1 ),
		foamCoverage: uniform( 1 ),
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
		this.material = this.buildMaterial( SHIPPED );
		this.materials.set( variantKey( SHIPPED ), this.material );
		this.mesh = new THREE.Mesh( geo, this.material );
		this.mesh.frustumCulled = false;
		this.mesh.name = 'water';

	}

	// The sea's shading for one variant (see WaterVariant).
	private buildMaterial( variant: WaterVariant ): THREE.NodeMaterial {

		const { fft, sky, shared, shore, seabedHeight, shoreWaves, sunShadow, storm, detail, sceneColor, linearDepth, refraction } = this.inputs;
		const quality = this.quality;
		const u = this.uniforms;
		// A cascade's layer of an FFT field at an undisplaced xz.
		const cascade = ( field: THREE.Texture, c: number, at: V2 ) => texture( field, at.div( fft.sizes[ c ] ) ).depth( int( c ) );

		// ---- vertex: displace the grid by the four cascades (the finest fades out far away), each
		// damped by the floor's depth, the island's lee and the rock (WaveDamping.ts). The undisplaced
		// grid point comes from the geometry: once positionNode is set, positionLocal reads the
		// displaced position.
		const xz = positionGeometry.xz;
		const fieldUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
		// ( the fine cascade's level of detail apart, w: its physical damping alone )
		const weights = waveDamping( { fft, shared, shore, seabedHeight, shoreWaves }, xz ).weights.toVar();
		const far = length( xz.sub( cameraPosition.xz ) );
		const fineWeight = float( 1 ).sub( smoothstep( 60, 140, far ) );
		const disps = [ 0, 1, 2, 3 ].map( ( c ) => cascade( fft.displacement, c, xz ).level( float( 0 ) ).xyz );
		const weighted = ( parts: V3[], w: THREE.Node<'vec4'>, fine: F ) => parts[ 0 ].mul( w.x ).add( parts[ 1 ].mul( w.y ) )
			.add( parts[ 2 ].mul( w.z ) ).add( parts[ 3 ].mul( w.w.mul( fine ) ) );
		// The skirt's sparse rows cannot carry waves; there the shading's slopes alone describe them.
		const geometric = float( 1 ).sub( smoothstep( 600, 1500, far ) );
		const d = weighted( disps, weights, fineWeight ).mul( geometric );
		const material = new THREE.NodeMaterial();
		const displaced = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y )
			.add( shoreWaves.surfaceAt( xz.add( d.xz ), shared.time ).x ), xz.y.add( d.z ) ).toVar();
		material.positionNode = displaced;
		if ( TEMPORAL ) {

			// (motion vectors: the note at the top) the vertex a step of the clock ago, seen from the
			// previous camera's level of detail
			const previousFar = length( xz.sub( motionUniforms.previousCameraPosition.xz ) );
			const previousFine = float( 1 ).sub( smoothstep( 60, 140, previousFar ) );
			const previousGeometric = float( 1 ).sub( smoothstep( 600, 1500, previousFar ) );
			const back = disps.map( ( now, c ) => {

				const v = cascade( fft.velocity, c, xz ).level( float( 0 ) ).xyz; // Ux, Uz, Vy
				return now.sub( vec3( v.x.mul( fft.chop ), v.z, v.y.mul( fft.chop ) ).mul( this.step ) );

			} );
			const dp = weighted( back, weights, previousFine ).mul( previousGeometric ).toVar();
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
		const vLag = varying( xz ), vWeights = varying( weights );
		// the meadow's gust at the grid point (SeaDetail.ts: its map read here, in the vertex stage)
		const vIslandGust = varying( detail.islandGust( xz ) );
		// the surface's height over the mean sea (the waves and the rock's reflected wave): the crests
		const vWaveH = varying( displaced.y.sub( shared.waterLevel ) );
		const floorHeight = ( p: V2 ) => texture( seabedHeight, fieldUV( p ) ).level( float( 0 ) ).r;
		const windSpeed = shared.wind.breeze.mul( REFERENCE_SPEED );
		const FINE = fft.cascades - 1;
		const sum = <T extends F | V2 | V3 | V4>( terms: T[] ) => terms.reduce( ( a, b ) => ( a as V4 ).add( b ) as unknown as T );

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
		// The refraction pass's image at a screen uv, through its wider view (Refraction.ts): its
		// colour, filtered (premultiplied by its coverage, alpha), and the view z of its nearest texel.
		const G = REFRACTION_GUARD;
		const refractionColor = texture( refraction.color ), refractionDepth = texture( refraction.depth );
		const refractionSize = vec2( textureSize( refractionDepth ) as unknown as THREE.Node<'ivec2'> );
		const refractionUV = ( q: V2 ) => vec2( q.x.sub( 0.5 ).div( G.sx ).add( 0.5 - G.cx / ( 2 * G.sx ) ), q.y.sub( 0.5 ).div( G.sy ).add( 0.5 + G.cy / ( 2 * G.sy ) ) );
		const refractedAt = ( q: V2 ) => {

			const r = refractionUV( q ).toVar();
			const depth = textureLoad( refractionDepth, ivec2( clamp( r.mul( refractionSize ), vec2( 0 ), refractionSize.sub( 1 ) ) ), int( 0 ) ) as unknown as F;
			return { color: texture( refractionColor, r ).level( float( 0 ) ).toVar(), depth: depth.toVar() };

		};
		const viewZOf = ( depth: F ) => perspectiveDepthToViewZ( depth, cameraNear, cameraFar );

		// screen-space reflection of the opaque scene (cliffs, stacks): geometric steps, then bisection.
		// The steps grow with the distance (tidewater's stepScale: far away the first ones would all
		// land in the same pixel), and a ray stops at SSR_FARTHEST, where its hits weigh nothing.
		// The distance the march reaches near the camera: its last step.
		const ssrReach = 0.15 + 0.25 * ( Math.pow( quality.ssrGrowth, quality.ssrSteps ) - 1 ) / ( quality.ssrGrowth - 1 );
		const traceSSR = Fn( ( [ posV, Rv ]: [ V3, V3 ] ) => {

			const res = vec4( 0 ).toVar();
			// A zero grazing weight cannot contribute a reflection. Reuse the exact fade
			// below rather than marching those rays through the depth buffer.
			const directionWeight = smoothstep( 0.5, 0.1, Rv.z ).toVar();
			let marches = Rv.z.lessThanEqual( 0.6 ).and( directionWeight.greaterThan( 0 ) );
			const stepScale = max( posV.z.negate().div( 60 ), 1 ).toVar();
			// Where the ray is inside the box of what it can reflect (in world space: the view is rigid,
			// so distances along the ray are the same).
			const span = variant.cull || variant.clip ? rayBoxSpan( cameraWorldMatrix.mul( vec4( posV, 1 ) ).xyz,
				cameraWorldMatrix.mul( vec4( Rv, 0 ) ).xyz, this.reflectorMin, this.reflectorMax ).toVar() : vec2( 0, 1e9 );
			if ( variant.cull ) marches = marches.and( span.y.greaterThanEqual( max( span.x, 0 ) ) ).and( span.x.lessThanEqual( min( stepScale.mul( ssrReach ), SSR_FARTHEST ) ) );
			If( marches, () => {

				const t = stepScale.mul( 0.15 ).toVar(), dt = stepScale.mul( 0.25 ).toVar(), prevT = float( 0 ).toVar();
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
					If( prevT.greaterThanEqual( SSR_FARTHEST ), () => {

						Break();

					} );
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
					// the ray must really touch the surface there, within a gap that grows with the
					// distance as the steps do (tidewater's)
					const touch = smoothstep( max( b.mul( 0.04 ), 0.6 ), max( b.mul( 0.02 ), 0.15 ), abs( sceneViewZ( q ).sub( hv.z ) ) );
					const hw = cameraWorldMatrix.mul( vec4( hv, 1 ) ).xyz.toVar();
					const edge = smoothstep( 0, 0.06, q.x ).mul( smoothstep( 1, 0.94, q.x ) ).mul( smoothstep( 0, 0.06, q.y ) ).mul( smoothstep( 1, 0.94, q.y ) );
					const farFade = smoothstep( SSR_FARTHEST, 120, b );
					res.assign( vec4( sceneAt( q ), edge.mul( touch ).mul( directionWeight ).mul( farFade ) ) );
					// Where the ray meets the cliff below the sea's reach, it could only have got there
					// through the water it meets first. Falling back to the sky there (tidewater fades
					// the lowest 0.4 m, sized for cliffs ten times taller) drew a bright band along every
					// cliff foot. The sea at this island's cliffs is a near mirror in everyday weather,
					// so the reflected rock continues down to the waterline, and rock just below it shows
					// the rock where it leaves the water: the hit lifted to the waterline, if the depth
					// buffer confirms rock there (a cliff face, not open seabed). A gale's swell heaves
					// the surface at the rock by tens of centimetres; the reach grows with it and the
					// lifted rock gives way to the sky, as before, so a rough sea keeps its sky-lit facets.
					const gale = sat( shared.wind.gale ).toVar();
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

		material.fragmentNode = Fn( () => {

			const time = shared.time;
			const wp = positionWorld;

			// ---- everything that needs screen-space derivatives, while control flow is still uniform
			const footprint = max( length( fwidth( vLag ) ), 1e-4 ).toVar();
			const lagDx = dFdx( vLag ).toVar(), lagDy = dFdy( vLag ).toVar();
			// The storm foam's texture level: the pixel's area, not its longest side. At grazing angles
			// the longest side is many times the width and would blur the mat into a flat grey film.
			const foamFootprint = max( abs( lagDx.x.mul( lagDy.y ).sub( lagDx.y.mul( lagDy.x ) ) ).sqrt(), 1e-4 ).toVar();
			const shoreWave = shoreWaves.surfaceAt( wp.xz, time ).toVar();
			const rainGradient = rainRippleGradient( wp.xz, time, shared.rain, footprint ).toVar();
			// the cascades' slopes, each damped as its displacement is (the fine one by its physical
			// damping alone: its mips filter it with the distance)
			const ws = [ vWeights.x, vWeights.y, vWeights.z, vWeights.w ];
			const d = sum( [ 0, 1, 2, 3 ].map( ( c ) => cascade( fft.derivatives, c, vLag ).mul( ws[ c ] ) ) ).toVar();
			// the whitecaps' bubbly mat: two layers of the foam pattern at other scales and angles
			const fuv = vLag.mul( FOAM_SCALE ).toVar();
			const p1 = texture( storm.pattern, fuv ).toVar();
			const p2 = texture( storm.pattern, rotate( fuv, 0.6435 ).mul( 2.37 ).add( vec2( 0.31, 0.77 ) ) ).toVar();
			// the sea's large-scale detail: ( rough, gust, slick, streak )
			const sea = detail.sample( vLag, vIslandGust ).toVar();
			const rough = sea.x;

			// ---- the normal: the cascades' slopes over their horizontal stretch (tidewater's
			// WaterSurface), the rock's reflected wave and the rain's rings in world xz
			const slopes = vec2( d.x.div( max( d.z.add( 1 ), 0.2 ) ), d.y.div( max( d.w.add( 1 ), 0.2 ) ) ).add( shoreWave.yz ).add( rainGradient ).toVar();
			// Near-field capillary ripples: within a few metres a pixel covers less than the finest
			// cascade's texel (about 3 cm) and the surface looks glassy; the finest cascade read again
			// at about 1 and 2.3 m tiles, turned so that they never line up with it; damped in slicks
			// with the short waves.
			const near = smoothstep( 0.04, 0.01, footprint ).mul( rough ).toVar();
			If( near.greaterThan( 0.002 ), () => {

				const ripple = ( k: number, angle: number ) => {

					const texel = fft.sizes[ FINE ] / k / FFT_SIZE;
					return texture( fft.derivatives, rotate( vLag, angle ).mul( k / fft.sizes[ FINE ] ) ).depth( int( FINE ) )
						.level( max( log2( footprint.div( texel ) ), 0 ) ).xy;

				};
				slopes.addAssign( rotate( ripple( 7.3, 0.63 ), - 0.63 ).mul( 0.55 ).add( rotate( ripple( 3.1, 2.14 ), - 2.14 ).mul( 0.35 ) ).mul( near ) );

			} );
			const jac = d.z.add( 1 ).mul( d.w.add( 1 ) ).toVar();
			const toCam = cameraPosition.sub( wp ).toVar();
			const V = toCam.div( length( toCam ) ).toVar();
			// A facet turned away from the eye (a fold of the choppy surface) is bent to just past
			// grazing, not flipped: a flipped normal turns a fold into a white mirror of the sky.
			const N0 = normalize( vec3( slopes.x.negate(), 1, slopes.y.negate() ) );
			const N = normalize( N0.add( V.mul( max( dot( N0, V ).negate().add( 0.03 ), 0 ) ) ) ).toVar();
			const L = shared.sunDir;
			const posV = cameraViewMatrix.mul( vec4( wp, 1 ) ).xyz.toVar();

			// ---- the sun reaching the surface: the sun shadow's maps, read as tidewater's water reads
			// its own (sunShadowPCF: three's five-tap PCF, the surface taken as level for the normal
			// bias; the waves break up any penumbra detail a contact-hardening filter would add), with
			// the fade from the previous map (SunShadow), and the clouds
			const sc = u.shadowMatrix.mul( vec4( wp.add( vec3( 0, this.shadowNormalBias, 0 ) ), 1 ) ).toVar();
			const s3 = sc.xyz.div( max( sc.w, 1e-6 ) ).toVar();
			const shadowCoord = vec3( s3.x, float( 1 ).sub( s3.y ), s3.z.add( this.shadowBias ) ).toVar();
			const visibility = sunShadow.pcfVisibility( shadowCoord );
			const shadow = mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) ).toVar();
			const cloudTransmission = sky.cloudVisibility( wp ).toVar();
			const sunLight = shared.sunColor.mul( shadow ).mul( cloudTransmission ).toVar();

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -9e4 = sky)
			const z0 = behindViewZ.toVar();
			const skyBehind = z0.lessThan( - 9e4 );
			const ray0 = viewRay( screenUV, cameraProjectionMatrixInverse ).toVar();
			const sv0 = ray0.mul( z0.div( ray0.z ) ).toVar();
			const thick = select( skyBehind, float( 1e4 ), posV.z.sub( sv0.z ) ).toVar(); // view distance from the surface to whatever is behind it

			// ---- whitecaps: where the surface is compressed right now (tidewater's fresh foam), more
			// of them inside gusts, and the windrows' trace of foam; a threshold on the foam pattern so
			// that they grow and tear into lace; far away, the coverage itself
			const fresh = sat( fft.foamBias.sub( 0.15 ).sub( jac ).mul( 2 ) );
			const coverage = sat( fresh.mul( mix( float( 0.5 ), float( 1.5 ), sea.y ) ).add( sea.w.mul( 0.5 ) ).mul( u.foamCoverage ) );
			const threshold = float( 1.05 ).sub( coverage.mul( 1.1 ) );
			const soft = footprint.mul( 0.1 ).add( 0.06 );
			const mat = smoothstep( threshold.sub( soft ), threshold.add( soft ), p1.x.mul( 0.62 ).add( p2.x.mul( 0.38 ) ) ).mul( p1.y.mul( 0.25 ).add( 0.8 ) );
			const foam = mix( mat, coverage.mul( 0.85 ), smoothstep( 0.15, 1.2, footprint ) ).toVar();

			// ---- roughness: the slopes no pixel resolves at this distance (Cox-Munk's mean square
			// slope 0.003 + 0.00512 U, the share finer than the pixel's wavenumber, scaled by the
			// gusts and slicks) over the base
			const mss = windSpeed.mul( 0.00512 ).add( 0.003 );
			const unresolved = sat( log2( footprint.mul( 110 / PI ) ).div( 9 ) ).mul( rough.mul( rough ) ).toVar();
			const alpha2 = u.roughness.mul( u.roughness ).add( mss.mul( 2 ).mul( unresolved ) ).add( foam.mul( 0.2 ) ).toVar();
			const sigmaUnresolved = sqrt( mss.mul( unresolved ) ).toVar();

			const NdV = max( dot( N, V ), 1e-4 ).toVar();
			const Fr = fresnelDielectric( NdV, float( IOR ) ).toVar();

			// ---- reflection
			const Rraw = reflect( V.negate(), N ).toVar();
			// How the reflected direction turns across a quarter of the pixel, diagonally (taken here,
			// while control flow is uniform): the screen-space reflection traces a ray on either side.
			const reflectionJitter = dFdx( Rraw ).add( dFdy( Rraw ) ).mul( 0.25 ).toVar();
			// Unresolved facets tilt the mean reflection toward the higher, darker sky; reflections
			// below the horizon meet other waves and fade toward the darkened horizon (and a sheet of
			// water thinner than a quarter metre keeps the sky).
			const R = normalize( vec3( Rraw.x, max( Rraw.y, 0.004 ).add( sigmaUnresolved.mul( 1.3 ).mul( float( 1 ).sub( max( Rraw.y, 0 ) ) ) ), Rraw.z ) );
			const thickness = wp.y.sub( floorHeight( wp.xz ) ).toVar();
			const horizonOcc = max( smoothstep( - 0.12, 0.08, Rraw.y ), smoothstep( 0.25, 0.06, thickness ) ).toVar();
			const skyReflection = vec3( 0 ).toVar();
			If( horizonOcc.greaterThan( 0 ), () => {

				skyReflection.assign( sky.sample( R ) );

			} );
			const horizon = sky.sampleBackground( normalize( vec3( Rraw.x, 0, Rraw.z ).add( vec3( 1e-5, 0, 0 ) ) ), float( HORIZON_MIP ) );
			const refl = mix( horizon.mul( 0.35 ), skyReflection, horizonOcc ).toVar();
			// The cliffs and the islanders from the screen: only rays near the horizon can meet them,
			// and where the reflectance is small the reflection cannot be seen (tidewater's gate).
			If( u.ssr.greaterThan( 0.5 ).and( Rraw.y.lessThan( 0.45 ) ).and( Fr.greaterThan( quality.ssrMinFresnel ) ), () => {

				// Two rays a quarter pixel either side of the pixel's centre, averaged: a ray either hits
				// the island or shows the sky, so with one ray per pixel the reflected island's edge and
				// the sky seen through it between the waves were pixel stair-steps and single bright
				// specks. Two rays give the edges a half step and halve a lone speck. The offsets are
				// fixed, so a paused frame repeats. The lower tiers take the one ray through the centre,
				// and so does a pixel whose reflectance is under ssrOneRayFresnel. The first ray moves
				// to the centre when it is alone, so the march is built twice, not three times. Nothing
				// of it is built unless ssrOneRayFresnel is above ssrMinFresnel.
				if ( quality.ssrRays === 1 ) {

					const rc = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw, 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, rc.rgb, rc.a ) );

				} else if ( quality.ssrOneRayFresnel > quality.ssrMinFresnel ) {

					const both = step( quality.ssrOneRayFresnel, Fr ).toVar();
					const ra = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.sub( reflectionJitter.mul( both ) ), 0 ) ).xyz ) ).toVar();
					const first = mix( refl, ra.rgb, ra.a ).toVar();
					If( both.greaterThan( 0.5 ), () => {

						const rb = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.add( reflectionJitter ), 0 ) ).xyz ) ).toVar();
						refl.assign( first.add( mix( refl, rb.rgb, rb.a ) ).mul( 0.5 ) );

					} ).Else( () => {

						refl.assign( first );

					} );

				} else {

					const ra = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.sub( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					const rb = traceSSR( posV, normalize( cameraViewMatrix.mul( vec4( Rraw.add( reflectionJitter ), 0 ) ).xyz ) ).toVar();
					refl.assign( mix( refl, ra.rgb, ra.a ).add( mix( refl, rb.rgb, rb.a ) ).mul( 0.5 ) );

				}

			} );
			refl.mulAssign( u.reflection );

			// ---- the sun's specular (GGX), the shadowed sun light above
			const H = normalize( L.add( V ) );
			const NdL = max( dot( N, L ), 0 ).toVar();
			const spec = D_GGX( max( dot( N, H ), 0 ), alpha2 ).mul( V_SmithGGX( NdL, NdV, alpha2 ) )
				.mul( fresnelDielectric( max( dot( V, H ), 0 ), float( IOR ) ) ).mul( NdL );
			// (physically a glint is some 1e5 times the sky; held inside half float's range)
			const sunSpec = sunLight.mul( min( spec, 400 ) ).toVar();

			// ---- refraction: the refracted view ray (Snell; kept heading down where a coarse crest
			// would turn it up) followed to the floor, two refinements on the floor's height, its end
			// projected to the screen. The refraction image there serves where it lies behind the
			// surface (it holds nothing above the water to stand in front); where the end lies on
			// something in front of the surface (a stone nearer the eye), what lies straight behind
			// in that image; where the image holds nothing there (the shallows above its clip height,
			// the sky), the opaque image at the end where it lies behind the surface, else straight
			// behind.
			const Tr = refract( V.negate(), N, 1 / IOR );
			const Tv = normalize( vec3( Tr.x, min( Tr.y, - 0.08 ), Tr.z ) ).toVar();
			const tDown = max( Tv.y.negate(), 0.04 ).toVar();
			const L0 = max( thickness, 0 ).div( tDown ).toVar();
			const Lt = L0.toVar();
			If( L0.lessThan( 100 ), () => {

				const L1 = max( wp.y.sub( floorHeight( wp.xz.add( Tv.xz.mul( min( L0, 200 ) ) ) ) ), 0 ).div( tDown );
				Lt.assign( max( wp.y.sub( floorHeight( wp.xz.add( Tv.xz.mul( min( L1.mul( 0.5 ).add( L0.mul( 0.5 ) ), 200 ) ) ) ) ), 0 ).div( tDown ) );

			} );
			const Lter = clamp( Lt, 0, 400 ).toVar();
			const uvR = projectView( cameraViewMatrix.mul( vec4( wp.add( Tv.mul( min( Lter, 80 ) ) ), 1 ) ).xyz, cameraProjectionMatrix ).toVar();
			const onScreen = uvR.x.greaterThan( 0 ).and( uvR.x.lessThan( 1 ) ).and( uvR.y.greaterThan( 0 ) ).and( uvR.y.lessThan( 1 ) );
			const behind = ( z: F ) => z.lessThan( posV.z.sub( WATER_BEHIND ) );
			const sceneCol = vec3( 0 ).toVar();
			const uvF = vec2( screenUV ).toVar();
			const zF = z0.toVar();
			const found = float( 0 ).toVar();
			if ( variant.refraction ) {

				const end = refractedAt( uvR );
				const covered = end.color.a.greaterThan( 0.5 ).and( end.depth.lessThan( 1 ) ).toVar();
				const zEnd = viewZOf( end.depth ).toVar();
				If( covered.and( behind( zEnd ) ), () => {

					sceneCol.assign( end.color.rgb.div( end.color.a ) );
					uvF.assign( uvR );
					zF.assign( zEnd );
					found.assign( 1 );

				} ).ElseIf( covered, () => {

					const straight = refractedAt( screenUV );
					const zStraight = viewZOf( straight.depth ).toVar();
					If( straight.color.a.greaterThan( 0.5 ).and( straight.depth.lessThan( 1 ) ).and( behind( zStraight ) ), () => {

						sceneCol.assign( straight.color.rgb.div( straight.color.a ) );
						zF.assign( zStraight );
						found.assign( 1 );

					} );

				} );

			}
			If( found.lessThan( 0.5 ), () => {

				const zR = sceneViewZ( uvR ).toVar();
				const valid = onScreen.and( behind( zR ) ).toVar();
				uvF.assign( select( valid, uvR, screenUV ) );
				zF.assign( select( valid, zR, z0 ) );
				sceneCol.assign( sceneAt( uvF ) );

			} ).Else( () => {

				// A thin sheet of water over rock: the refraction offset is a few pixels at most and
				// nothing stands between the sheet and the rock, so the opaque pass's own image of
				// the rock serves (the refraction image leaves out everything above its clip height,
				// and switching between the two drew a line across the rock along that height).
				const film = float( 1 ).sub( smoothstep( 0.04, 0.3, thickness ) ).toVar();
				If( film.greaterThan( 0 ), () => {

					const uvO = select( onScreen.and( behind( sceneViewZ( uvR ) ) ), uvR, screenUV );
					sceneCol.assign( mix( sceneCol, sceneAt( uvO ), film ) );

				} );

			} );
			// what stands in front of the floor (stones, the cliff's foot) shortens the path
			const rayF = viewRay( uvF, cameraProjectionMatrixInverse ).toVar();
			const pathLen = clamp( min( Lter, length( rayF.mul( zF.div( rayF.z ) ).sub( posV ) ) ), 0, 400 ).toVar();

			// ---- the water body: Beer-Lambert absorption along the path, and the sun and the sky
			// scattered into it analytically (single scattering, Henyey-Greenstein, and a multiple
			// scattering backscatter boost after Gordon: R = 0.33 bb / ( a + bb ))
			const sigA = shared.sigA, sigS = shared.sigS;
			const sigT = sigA.add( sigS ).toVar();
			const Ls = refract( L.negate(), vec3( 0, 1, 0 ), 1 / IOR ).negate().toVar(); // toward the sun from under the water
			const muS = max( Ls.y, 0.1 ), muV = max( Tv.y.negate(), 0.15 );
			const sunIn = sunLight.mul( float( 1 ).sub( fresnelDielectric( max( L.y, 0.02 ), float( IOR ) ) ) );
			const kSun = sigT.mul( muV.div( muS ).add( 1 ) ).toVar();
			const kAmb = sigT.mul( muV.div( 0.75 ).add( 1 ) ).toVar();
			const ph = phaseHG( dot( Tv, Ls ), float( 0.86 ) ).mul( 0.7 ).add( 0.3 / ( 4 * PI ) );
			const bb = sigS.mul( u.backscatter );
			const albedoMS = bb.mul( 0.33 * 4 ).div( sigA.add( bb ) ).toVar();
			const inSun = sunIn.mul( sigS.mul( ph ).add( albedoMS.mul( sigT ).div( PI ) ) ).mul( float( 1 ).sub( exp( kSun.negate().mul( pathLen ) ) ) ).div( kSun );
			const inAmb = shared.skyIrradianceSource.mul( sigS.mul( 0.25 ).add( albedoMS.mul( sigT ) ) ).mul( float( 1 ).sub( exp( kAmb.negate().mul( pathLen ) ) ) ).div( kAmb );
			// the sun through the thin crests: light entering a crest's top and back scatters out of its
			// face over a broad lobe, so side-lit waves glow green too
			const vH = normalize( V.xz.add( 1e-5 ) ), lH = normalize( L.xz.add( 1e-5 ) );
			const back = pow( sat( dot( vH, lH.negate() ).mul( 0.6 ).add( 0.4 ) ), 2.5 );
			const crest = sat( vWaveH.mul( 0.9 ).add( 0.1 ) ).mul( sat( float( 1 ).sub( N.y ).mul( 4 ) ).add( 0.25 ) );
			const sss = sunLight.mul( vec3( 0.12 * 0.06, 0.55 * 0.06, 0.45 * 0.06 ) ).mul( back.mul( crest ).mul( u.sss ) ).mul( smoothstep( 0, 0.25, L.y ) );
			const transmitted = sceneCol.mul( exp( sigT.negate().mul( pathLen ) ) ).add( inSun ).add( inAmb ).add( sss );

			// ---- foam: a bright diffuse scatterer (albedo 0.85) under the wrapped sun and the sky
			const foamLit = sunLight.mul( max( dot( N, L ), 0 ).mul( 0.75 ).add( 0.25 ) ).div( PI ).add( shared.skyIrradianceSource.mul( 0.95 ) ).mul( 0.85 ).toVar();
			const water = mix( transmitted, refl, Fr ).add( sunSpec );
			const col = mix( water, foamLit.mul( u.foamIntensity ).add( sunSpec.mul( 0.05 ) ), sat( foam ) ).toVar();
			// (temporal modes) the glints' reactive weight: their luminance against a white diffuse
			// surface under the same sun and sky (the note at the top)
			const reactive = TEMPORAL ? smoothstep( reactiveUniforms.glintFrom, reactiveUniforms.glintTo, lum( sunSpec )
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

				const fold = jac;
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
				col.assign( mix( col, lit, foam ) );

			} );

			// soften the line where the surface cuts the rock (no hard seam); behind rock: the rock
			const edge = select( skyBehind, float( 1 ), smoothstep( 0, 0.06, thick ) ).toVar();
			If( edge.lessThan( 1 ), () => {

				col.assign( mix( sceneAt( screenUV ), col, edge ) );

			} );
			return vec4( min( col, vec3( 16000 ) ), reactive ?? 1 );

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
		// debugFlags.ssrCull / ssrClip = false bring back the march without the box, and refraction =
		// false the opaque copy as the only refraction source (with the refraction pass skipped:
		// Pipeline.ts), for A/B timing in one page (each variant is its own material and pipeline,
		// built on first use).
		const variant = { cull: debugFlags.ssrCull !== false, clip: debugFlags.ssrClip !== false, refraction: debugFlags.refraction !== false };
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

		this.inputs.detail.setLand( b );
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
