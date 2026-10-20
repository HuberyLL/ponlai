/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater):
 * the haze's two exponential height layers (their proportions and scale heights) and its phase
 * function, from `AirHaze.js`.
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, texture3D, textureLoad, textureStore, instanceIndex, uv, int, ivec2, ivec3,
	vec2, vec3, vec4, float, max, min, clamp, exp, exp2, log2, sqrt, mix, dot, normalize, select, fract, floor, varying,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import type { Atmosphere } from '../sky/Atmosphere.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from '../post/graph/FrameGraph.ts';
import { TemporalRest, restEpoch } from '../post/TemporalRest.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The air's haze and the sea's fog as one participating medium in a froxel volume, after Patry,
// "Real-Time Samurai Cinema", SIGGRAPH 2021 (its volumetric haze, built on Wronski, SIGGRAPH 2014,
// and Drobot, Digital Dragons 2017):
//   - the medium's density is analytic and integrable along any ray: two exponential height layers
//     (a thin marine layer over the sea and a deeper aerosol layer, whose sum at sea level is the
//     weather's haze) and the talk's sigmoidal layer (the sea fog, dense below its top and thin
//     above). The talk prints the sigmoid's weight as z^2 / (z^2 + k^2), which is even in z and no
//     step; this is the algebraic sigmoid it stands for, 1/2 + 1/2 x / sqrt( x^2 + k^2 ) with x the
//     height over the layer's top, whose mean over any span of heights has a closed form. Local
//     variation (banks, wisps, ground fog) belongs to particles, not to the density.
//   - a froxel grid over the view in slices each deeper than the one before by a fixed share (the
//     talk's PS4 grid is 128 x 64 x 64; high's 160 x 90 makes a froxel about 16 render pixels
//     across at 1440p). Its size is fixed, so no kernel follows the render's scale. The talk's slices
//     (10 cm to 100 km, each 20 % deeper) serve a camera a few metres from its subject; the island's
//     camera looks from 20 - 200 m, where they were 6 - 20 m deep and averaged the cliffs' and the
//     plants' shadows out of the air. From 10 m to 30 km, each 15 % deeper, 19 of the 64 slices lie
//     in that range instead of 12 (6.6 m deep at 50 m), at no cost; four times the froxels across
//     (the talk's PC density) sharpened the shadows less and cost about six times as much.
//   - the light is the atmosphere's (3b in the talk's terms): the key light as Sky gives it (the
//     sun, or the moon, through the atmosphere; nothing under a closed deck) scattered by the
//     haze's phase function and multiplied by its shadow, and the sky's irradiance, isotropic, with
//     the ground's bounce of both, multiplied by an ambient occlusion (1: the island is open and
//     there are no probes of the sky's visibility). Mie by the shadow, the rest by the occlusion.
//   - the shadow is the sun's stepped shadow maps (SunShadow.volumeVisibility) and the clouds'
//     shadow along the key light, sampled once per froxel at a jittered point and filtered over
//     frames: what any caster or cloud cuts out of the lit air shows as shafts, whether or not the
//     sun is in view. The filter keeps the shadow's share (and the occlusion's) only, never the
//     light, so a change of the light shows at once and leaves no trail.
//   - a second kernel integrates each column of froxels front to back, every slice's optical depth
//     exact, and stores the in-scattered light divided by its opacity (L / alpha): a smooth
//     function of depth, unlike either alone. The composite recomputes the opacity at each pixel,
//     exactly, from the density functions, and multiplies it back in: the thin layers over the
//     horizon and the sea do not band at the grid's depth steps (the talk's density
//     anti-aliasing). It samples the volume with a tricubic B-spline (eight trilinear taps; Sigg
//     and Hadwiger, "Fast Third-Order Texture Filtering", GPU Gems 2, 2005), which joins the shafts
//     to their openings.
//   - the sky is left as the atmosphere draws it (`sky` off): it already holds the atmosphere's own
//     aerosols (Atmosphere.ts `mieScale`: an extinction of about 1e-5 / m at sea level, 1.2 km
//     high) and their glow round the sun, and the haze's layers laid over it as well whitened the
//     sky toward a low sun and hid the clouds, while the far sea, hazed to its saturation, already
//     meets the horizon's colour. With `sky` on the sky is behind the haze too, at the grid's far
//     end (a ray below the horizon ends on the distant sea the sky draws), the deep layer adding
//     only its excess over the atmosphere's aerosols and the marine layer and the fog whole.
//
// Rules: the shadow's filter is a history-dependent effect (AGENTS.md). While the scene runs, each
// froxel blends its new sample into its history, reprojected through the previous frame's camera,
// and takes the new sample alone where the history falls outside the grid, after a cut (the key
// light turns more than CUT in a frame, the camera jumps) and after `invalidate`. A scene at rest
// (the key TemporalRest tests: the camera, the clock, the sizes, the epoch's scene count, which a
// restart of the frame loop leaves, the page's signature and the haze's own inputs) converges once, the way the temporal resolve's rest does: after its settle
// frames it averages a fixed sequence of jitters with exact weights, from nothing, then holds the
// result and skips the shadow kernel. A paused frame is then a function of the scene alone,
// however it was reached, and `pending` holds the page's settled signal until it has converged.
// The light kernel runs every frame. The rays through the clouds' gaps over the sky stay the
// screen-space shafts' (post/LightShafts.ts) while the haze leaves the sky. Local lights, when there
// are any, add to the light the integration takes per froxel; the talk filters theirs in a volume of
// their own.

// a key light that turns more than this in one frame is a cut: the shadow's history is dropped
const CUT = THREE.MathUtils.degToRad( 1 );
// a camera that moves more than this in one frame (metres, or radians of turn) is a cut
const JUMP = { distance: 8, angle: THREE.MathUtils.degToRad( 30 ) };
// below this the key light's elevation is held for the clouds' shadow (see the shadow kernel)
const LOW_KEY = 0.05;
// view z of the sky (the composite's depth holds -1e5 there)
const SKY_Z = - 9e4;

/** The froxel grid's size, fixed when the page loads (the quality tier's `post.hazeGrid`). */
export interface HazeGrid { width: number; height: number; depth: number }

export const DEFAULT_HAZE_GRID: Readonly<HazeGrid> = { width: 160, height: 90, depth: 64 };

/** The haze's knobs (the GUI's Haze folder, `__PONLAI__.pipeline.air.settings`). The shadow's
 * temporal filter and the composite's filters are the talk's, the slices fitted to the island's
 * camera (see the header); the haze's two layers and the phase are the earlier analytic haze's, and
 * the fog's layer is sized by its visibility, until they are tuned. */
export const HAZE_DEFAULTS = {
	// the slices: the grid's near and far view depth (metres) and each slice's depth over the last's
	near: 10, far: 30000, growth: 1.15,
	// the haze: the marine layer's share of the weather's extinction at sea level, its scale height,
	// and the aerosol layer's (the rest of it) (metres)
	marineShare: 1.5 / 1.82, marineHeight: 110, aerosolHeight: 1400,
	// the sea fog's sigmoidal layer: extinction below its top per unit of the weather's fog (1/m:
	// one unit sees 1 km, the threshold of fog, Koschmieder's 3.912 / 1000; the morning's 0.3 is a
	// mist that sees 3.3 km), the top's height and the width of the step (metres: a layer at the
	// cliff's foot), and the density above as a share of below (the talk's 0)
	fogExtinction: 3.912 / 1000, fogTop: 10, fogWidth: 4, fogAbove: 0,
	// the light: the medium's single-scattering albedo, its phase (a Cornette-Shanks lobe of this
	// anisotropy with this share of isotropic scattering), and scales of the key light's and the
	// ambient light's share
	albedo: 1, anisotropy: 0.62, isotropic: 0.3, sun: 1, ambient: 1,
	// the shadow's filter: a running frame's weight, and the frames a rest averages
	blend: 0.1, restFrames: 16,
	// A/B switches: the jittered shadow samples, the tricubic filter (else trilinear), the density
	// anti-aliasing (else the opacity the grid holds), the haze over the sky
	jitter: true, tricubic: true, densityAA: true, sky: false,
	// a debug view: 0 off, 1 the key light's visibility in the froxel at each pixel's depth
	debug: 0,
};

export type HazeSettings = typeof HAZE_DEFAULTS;

// (1 - e^-x) / x, the share of a slab of optical depth x that scatters, per unit of that depth, with
// its series near 0 (where the difference loses its digits)
const expShare = Fn( ( [ x ]: [ F ] ) => {

	const series = float( 1 ).sub( x.mul( 0.5 ) ).add( x.mul( x ).div( 6 ) );
	return select( x.lessThan( 1e-3 ), series, float( 1 ).sub( exp( x.negate() ) ).div( max( x, 1e-30 ) ) );

} ).setLayout( { name: 'hazeExpShare', type: 'float', inputs: [ { name: 'x', type: 'float' } ] } );

// The medium's mean extinction (1/m) over the heights between a and b (metres, either order; below
// the sea it holds its value at sea level, which only rays hidden under the water reach): two
// exponential layers (extinction at sea level, scale height) and the sigmoidal layer (below, above,
// top, width). An optical depth is a ray's length times the mean over the heights it spans.
const meanExtinction = Fn( ( [ a0, b0, layerA, layerB, fog ]: [ F, F, V2, V2, V4 ] ) => {

	const a = max( min( a0, b0 ), 0 ).toVar();
	const b = max( max( a0, b0 ), 0 ).toVar();
	const span = b.sub( a ).toVar();
	const exponential = ( l: V2 ) => l.x.mul( exp( a.div( l.y ).negate() ) ).mul( expShare( span.div( l.y ) ) );
	// the sigmoid's weight 1/2 + 1/2 x / r integrates to ( x + r ) / 2, r = sqrt( x^2 + k^2 ); its
	// mean, written so that no difference cancels: 1/2 + 1/2 ( xa + xb ) / ( ra + rb )
	const xa = a.sub( fog.z ).toVar(), xb = b.sub( fog.z ).toVar();
	const k2 = fog.w.mul( fog.w );
	const r = sqrt( xa.mul( xa ).add( k2 ) ).add( sqrt( xb.mul( xb ).add( k2 ) ) );
	const above = xa.add( xb ).div( max( r, 1e-6 ) ).mul( 0.5 ).add( 0.5 );
	return exponential( layerA ).add( exponential( layerB ) ).add( mix( fog.x, fog.y, above ) );

} ).setLayout( { name: 'hazeMeanExtinction', type: 'float', inputs: [
	{ name: 'a0', type: 'float' }, { name: 'b0', type: 'float' }, { name: 'layerA', type: 'vec2' },
	{ name: 'layerB', type: 'vec2' }, { name: 'fog', type: 'vec4' },
] } );

// Cornette-Shanks with a share of isotropic scattering (normalised over the sphere: 1/sr).
const hazePhase = Fn( ( [ cosine, g, isotropic ]: [ F, F, F ] ) => {

	const g2 = g.mul( g ).toVar();
	const cs = float( 3 / ( 8 * Math.PI ) ).mul( float( 1 ).sub( g2 ) ).div( g2.add( 2 ) ).mul( cosine.mul( cosine ).add( 1 ) )
		.div( max( g2.add( 1 ).sub( cosine.mul( g ).mul( 2 ) ), 1e-4 ).pow( 1.5 ) );
	return mix( cs, float( 1 / ( 4 * Math.PI ) ), isotropic );

} ).setLayout( { name: 'hazePhase', type: 'float', inputs: [
	{ name: 'cosine', type: 'float' }, { name: 'g', type: 'float' }, { name: 'isotropic', type: 'float' },
] } );

// Interleaved gradient noise (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
// Warfare", SIGGRAPH 2014): a fixed offset per froxel, so the frames' common jitter sequence lands
// on different points of neighbouring froxels.
const gradientNoise = Fn( ( [ p ]: [ V2 ] ) => fract( fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ).mul( 52.9829189 ) ) )
	.setLayout( { name: 'hazeGradientNoise', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

function halton( index: number, base: number ): number {

	let f = 1, r = 0;
	for ( let i = index; i > 0; i = Math.floor( i / base ) ) {

		f /= base;
		r += f * ( i % base );

	}
	return r;

}

/** What the page tells the haze each frame (main.ts): the rest's signature (what changes the
 * frame without changing the camera or the clock: a forced strike, the sun maps' redraws) and
 * whether the scene may rest (no sky bake in flight, no transition running). */
export interface HazeFrame { time: number; signature: readonly number[]; stable: boolean }

/** The air's haze and the sea's fog: a froxel volume lit by the atmosphere and shadowed by the sun's
 * maps and the clouds, composited over the scene and the sky (see the header). */
export class VolumetricHaze {

	// the weather's haze (its extinction at sea level, 1/m) and sea fog (0 none, 1 dense)
	readonly haze = uniform( 0 );
	readonly fog = uniform( 0 );
	// The key light the air scatters: its direction and its irradiance below the clouds (a closed
	// deck leaves no beam to scatter).
	readonly keyDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	readonly keyColor = uniform( new THREE.Color( 0, 0, 0 ) );
	readonly settings: HazeSettings = { ...HAZE_DEFAULTS };
	readonly grid: Readonly<HazeGrid>;
	/** The shadow's rest (see the header); `pending` while it has not converged. */
	readonly rest = new TemporalRest();

	private readonly sunShadow: SunShadow;
	// the medium: the exponential layers ( extinction at sea level, scale height ) and the sigmoid
	// ( below, above, top, width ), from the weather and the settings
	private readonly layerA = uniform( new THREE.Vector2( 0, 110 ) );
	private readonly layerB = uniform( new THREE.Vector2( 0, 1400 ) );
	// the deep layer over the sky: its excess over the atmosphere's own aerosols
	private readonly layerSky = uniform( new THREE.Vector2( 0, 1400 ) );
	private readonly fogLayer = uniform( new THREE.Vector4( 0, 0, 20, 8 ) );
	// the light's settings: albedo, anisotropy, isotropic share, key light's scale
	private readonly lightSettings = uniform( new THREE.Vector4( 1, 0.62, 0.3, 1 ) );
	private readonly ambientScale = uniform( 1 );
	private readonly atmosphere: Atmosphere;
	// the slices: near, the first slice's depth, the growth and its log2
	private readonly slices = uniform( new THREE.Vector4( 10, 0.6, 1.15, Math.log2( 1.15 ) ) );
	private readonly far = uniform( 100000 );
	// the grid's camera, unjittered (the volume does not shake with the temporal modes' jitter)
	private readonly gridInverse = uniform( new THREE.Matrix4() );
	private readonly cameraWorld = uniform( new THREE.Matrix4() );
	private readonly origin = uniform( new THREE.Vector3() );
	// the previous frame's view-projection (unjittered), for the history's reprojection
	private readonly previousViewProjection = uniform( new THREE.Matrix4() );
	// the composite's rays: the projection the depth it reads was drawn with (jittered under the
	// temporal modes: `setProjectionInverse`)
	private readonly projectionInverse = uniform( new THREE.Matrix4() );
	// the shadow kernel's frame: the jitter's offset, the rest's index (-1 while running), the
	// running blend (1: no history)
	private readonly sequence = uniform( new THREE.Vector3( 0.5, 0.5, 0.5 ) );
	private readonly restIndex = uniform( - 1 );
	private readonly blend = uniform( 1 );
	// the composite's switches: the haze over the sky, tricubic, density anti-aliasing, the debug view
	private readonly switches = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	// the render's size, the frame graph's (set in `apply`)
	private resolution!: THREE.UniformNode<'vec2', THREE.Vector2>;

	// The shadow's two volumes (r: the key light's visibility, g: the ambient occlusion), written in
	// turn: `written` holds the newest. The light's volume (rgb: L / alpha, a: alpha at each
	// slice's far boundary).
	private readonly visibility: [ THREE.Storage3DTexture, THREE.Storage3DTexture ];
	private readonly light: THREE.Storage3DTexture;
	private visibilityKernels: THREE.ComputeNode[] = [];
	private lightKernels: THREE.ComputeNode[] = [];
	private resources: { visibility: ResourceHandle; light: ResourceHandle } | null = null;
	private written = 0;
	private historyValid = false;
	private shadowDue = true;
	private frame = 0;
	private readonly key: number[] = [];
	private readonly last = { valid: false, keyDir: new THREE.Vector3(), position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), slices: new THREE.Vector4(), viewProjection: new THREE.Matrix4() };
	private readonly viewProjection = new THREE.Matrix4();
	private readonly position = new THREE.Vector3();
	private readonly quaternion = new THREE.Quaternion();
	private readonly scale = new THREE.Vector3();

	constructor( sunShadow: SunShadow, atmosphere: Atmosphere, grid: Partial<HazeGrid> = {} ) {

		this.sunShadow = sunShadow;
		this.atmosphere = atmosphere;
		this.grid = { ...DEFAULT_HAZE_GRID, ...grid };
		const { width, height, depth } = this.grid;
		const volume = ( name: string ) => {

			const t = new THREE.Storage3DTexture( width, height, depth );
			t.name = name;
			t.type = THREE.HalfFloatType;
			t.format = THREE.RGBAFormat;
			t.generateMipmaps = false;
			t.minFilter = t.magFilter = THREE.LinearFilter;
			t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
			return t;

		};
		this.visibility = [ volume( 'haze.visibility0' ), volume( 'haze.visibility1' ) ];
		this.light = volume( 'haze.light' );
		this.rest.settle = 8;

	}

	// the view depth (metres) at slice coordinate c (slice k spans [ k, k + 1 ])
	private sliceDepth( c: F ): F {

		const s = this.slices;
		return s.x.add( s.y.mul( exp2( c.mul( s.w ) ).sub( 1 ) ).div( s.z.sub( 1 ) ) );

	}

	// the slice coordinate of a view depth
	private sliceCoordinate( z: F ): F {

		const s = this.slices;
		return log2( max( z.sub( s.x ), 0 ).mul( s.z.sub( 1 ) ).div( s.y ).add( 1 ) ).div( s.w );

	}

	// the grid's view ray through screen uv q: its unit view-space direction and its world direction
	private gridRay( q: V2 ): { view: V3; direction: V3 } {

		const ndc = vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 );
		const far = this.gridInverse.mul( ndc );
		const view = normalize( far.xyz.div( far.w ) ).toVar();
		const direction = normalize( this.cameraWorld.mul( vec4( view, 0 ) ).xyz ).toVar();
		return { view, direction };

	}

	// the world position at screen uv q and view depth z, on the grid's camera
	private gridPoint( q: V2, z: F ): V3 {

		const { view, direction } = this.gridRay( q );
		return this.origin.add( direction.mul( z.div( view.z.negate() ) ) );

	}

	/** The view ray through screen uv `q` of the camera `update` last took, with the inverse
	 * projection `projectionInverse`: in view space (`ray`, its z -1 deep, for a distance from a
	 * view z) and its world direction. For the rain veil drawn after the temporal resolve
	 * (Pipeline.ts), at the canvas's pixels and unjittered, in a full-screen pass: both are linear
	 * across the screen before the direction is normalised, so they are interpolated from the
	 * vertices. */
	viewRay( q: V2, projectionInverse: THREE.Node<'mat4'> ): { ray: V3; direction: V3 } {

		const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 );
		const viewFar = projectionInverse.mul( vec4( ndc, 1 ) );
		const ray = viewFar.xyz.div( viewFar.z.negate() );
		const direction = normalize( varying( this.cameraWorld.mul( vec4( ray, 0 ) ).xyz ) ).toVar();
		return { ray: varying( ray ).toVar(), direction };

	}

	// The shadow kernel writing volume `w` (reading the other one's history): one thread per froxel.
	private buildVisibilityKernel( w: number, sky: Sky ): THREE.ComputeNode {

		const { width: W, height: H, depth: D } = this.grid;
		const target = this.visibility[ w ];
		const history = texture3D( this.visibility[ 1 - w ] );
		const before = texture3D( this.visibility[ 1 - w ] );
		const size = vec2( W, H );
		return Fn( () => {

			If( instanceIndex.lessThan( W * H * D ), () => {

				const x = int( instanceIndex.mod( W ) ).toVar(), y = int( instanceIndex.div( W ).mod( H ) ).toVar(), z = int( instanceIndex.div( W * H ) ).toVar();
				const cell = vec3( float( x ), float( y ), float( z ) ).toVar();
				// the jittered point inside the froxel: the frame's offset shifted by the froxel's own
				const n = vec3( gradientNoise( cell.xy.add( cell.z.mul( 5.588238 ) ) ), gradientNoise( cell.yx.add( cell.z.mul( 7.123 ) ).add( 17.3 ) ),
					gradientNoise( vec2( cell.z.mul( 3.17 ).add( cell.x ), cell.y.mul( 1.91 ).add( 41.7 ) ) ) );
				const o = fract( this.sequence.add( n ) ).toVar();
				const p = this.gridPoint( cell.xy.add( o.xy ).div( size ), this.sliceDepth( cell.z.add( o.z ) ) ).toVar();
				// the sun's maps (lit outside them and before the first is drawn). The maps' depth ends
				// below the casters (at the sea's troughs), but a low sun throws their shadow through the
				// air far beyond that: a point past the far end lies behind every caster of its texel, so
				// it is compared at the far end.
				const coordinate = this.sunShadow.coordinate.mul( vec4( p, 1 ) ).xyz.toVar();
				const sun = this.sunShadow.volumeVisibility( vec3( coordinate.xy, min( coordinate.z, 0.99999 ) ) ).toVar();
				// the clouds' shadow map holds the transmittance along the key light from the ground: a
				// point of the air takes the ground point its beam passes over
				const rise = max( p.y, 0 ).div( max( this.keyDir.y, LOW_KEY ) );
				const ground = p.xz.sub( this.keyDir.xz.mul( rise ) );
				const visible = sun.mul( sky.cloudVisibility( vec3( ground.x, 0, ground.y ) ) ).toVar();
				const out = visible.toVar();
				If( this.restIndex.greaterThanEqual( 0 ), () => {

					// at rest: the exact mean of the sequence so far (index 0 starts it over)
					const kept = before.load( ivec3( x, y, z ) ).r;
					out.assign( kept.mul( this.restIndex ).add( visible ).div( this.restIndex.add( 1 ) ) );

				} ).ElseIf( this.blend.lessThan( 1 ), () => {

					// running: the history at the froxel's centre as the previous frame saw it
					const centre = this.gridPoint( cell.xy.add( 0.5 ).div( size ), this.sliceDepth( cell.z.add( 0.5 ) ) );
					const clip = this.previousViewProjection.mul( vec4( centre, 1 ) ).toVar();
					const ndc = clip.xy.div( clip.w );
					const uvw = vec3( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ), this.sliceCoordinate( clip.w ).div( D ) ).toVar();
					const inside = clip.w.greaterThan( 0 ).and( uvw.x.greaterThanEqual( 0 ) ).and( uvw.x.lessThanEqual( 1 ) )
						.and( uvw.y.greaterThanEqual( 0 ) ).and( uvw.y.lessThanEqual( 1 ) ).and( uvw.z.lessThanEqual( 1 ) );
					If( inside, () => {

						out.assign( mix( history.sample( uvw ).level( float( 0 ) ).r, visible, this.blend ) );

					} );

				} );
				textureStore( target, ivec3( x, y, z ), vec4( out, 1, 0, 1 ) );

			} );

		} )().compute( W * H * D, [ 64 ] ).setName( `Haze.Shadow${ w }` );

	}

	// The light kernel reading shadow volume `r`: one thread per column, front to back.
	private buildLightKernel( r: number, sky: Sky ): THREE.ComputeNode {

		const { width: W, height: H, depth: D } = this.grid;
		const shade = texture3D( this.visibility[ r ] );
		const target = this.light;
		return Fn( () => {

			If( instanceIndex.lessThan( W * H ), () => {

				const x = int( instanceIndex.mod( W ) ).toVar(), y = int( instanceIndex.div( W ) ).toVar();
				const { view, direction } = this.gridRay( vec2( float( x ).add( 0.5 ), float( y ).add( 0.5 ) ).div( vec2( W, H ) ) );
				const forward = view.z.negate().toVar();
				const [ albedo, g, isotropic, sunScale ] = [ this.lightSettings.x, this.lightSettings.y, this.lightSettings.z, this.lightSettings.w ];
				// in-scattered radiance per unit of scattering: the key light through the phase, and the
				// sky's irradiance (E / pi) from above with the ground's bounce of both from below
				const key = this.keyColor.rgb.mul( hazePhase( dot( direction, this.keyDir ), g, isotropic ) ).mul( sunScale ).mul( albedo ).toVar();
				const skyLight = sky.irradianceNode;
				const bounce = this.keyColor.rgb.mul( max( this.keyDir.y, 0 ).div( Math.PI ) ).add( skyLight ).mul( this.atmosphere.groundAlbedo.rgb );
				const ambient = skyLight.add( bounce ).mul( 0.5 ).mul( this.ambientScale ).mul( albedo ).toVar();
				const sum = vec3( 0 ).toVar(), alpha = float( 0 ).toVar();
				const t0 = this.slices.x.div( forward ).toVar();
				const y0 = this.origin.y.add( direction.y.mul( t0 ) ).toVar();
				Loop( D, ( { i } ) => {

					const t1 = this.sliceDepth( float( i ).add( 1 ) ).div( forward ).toVar();
					const y1 = this.origin.y.add( direction.y.mul( t1 ) ).toVar();
					const tau = t1.sub( t0 ).mul( meanExtinction( y0, y1, this.layerA, this.layerB, this.fogLayer ) );
					// the slice's share of the light that reaches the eye: what it scatters times what
					// lies in front of it
					const w = float( 1 ).sub( alpha ).mul( tau.mul( expShare( tau ) ) ).toVar();
					const fraction = shade.load( ivec3( x, y, i ) );
					const scattered = key.mul( fraction.r ).add( ambient.mul( fraction.g ) ).toVar();
					sum.addAssign( scattered.mul( w ) );
					alpha.addAssign( w );
					// L / alpha: the mean light of the haze in front, its limit where there is none yet
					const mean = select( alpha.greaterThan( 1e-20 ), sum.div( max( alpha, 1e-20 ) ), scattered );
					// (the debug view: the visibility as a grey card in the key light, so the display's
					// exposure shows 1 as mid grey)
					const shown = select( this.switches.w.greaterThan( 0.5 ), vec3( fraction.r.mul( dot( this.keyColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ).mul( 0.18 / Math.PI ) ), mean );
					textureStore( target, ivec3( x, y, i ), vec4( shown, alpha ) );
					t0.assign( t1 );
					y0.assign( y1 );

				} );

			} );

		} )().compute( W * H, [ 64 ] ).setName( `Haze.Light${ r }` );

	}

	// The light volume at uvw, through a tricubic B-spline (eight trilinear taps) or trilinear.
	private sampleLight( uvw: V3 ): V4 {

		const { width: W, height: H, depth: D } = this.grid;
		const volume = texture3D( this.light );
		const size = vec3( W, H, D );
		const trilinear = volume.sample( uvw ).level( float( 0 ) );
		const coord = uvw.mul( size ).sub( 0.5 ).toVar();
		const index = floor( coord ).toVar();
		const f = coord.sub( index ).toVar();
		const f2 = f.mul( f ), f3 = f2.mul( f );
		const w0 = f3.negate().add( f2.mul( 3 ) ).sub( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w1 = f3.mul( 3 ).sub( f2.mul( 6 ) ).add( 4 ).div( 6 );
		const w2 = f3.mul( - 3 ).add( f2.mul( 3 ) ).add( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w3 = f3.div( 6 );
		const g0 = w0.add( w1 ).toVar(), g1 = w2.add( w3 ).toVar();
		const h0 = index.sub( 0.5 ).add( w1.div( g0 ) ).div( size ).toVar();
		const h1 = index.add( 1.5 ).add( w3.div( g1 ) ).div( size ).toVar();
		const tap = ( a: V3, b: V3, c: V3 ) => volume.sample( vec3( a.x, b.y, c.z ) ).level( float( 0 ) );
		const z0 = mix( mix( tap( h1, h1, h0 ), tap( h0, h1, h0 ), g0.x ), mix( tap( h1, h0, h0 ), tap( h0, h0, h0 ), g0.x ), g0.y );
		const z1 = mix( mix( tap( h1, h1, h1 ), tap( h0, h1, h1 ), g0.x ), mix( tap( h1, h0, h1 ), tap( h0, h0, h1 ), g0.x ), g0.y );
		const tricubic = mix( z1, z0, g0.z );
		return select( this.switches.y.greaterThan( 0.5 ), tricubic, trilinear );

	}

	/** `depth` is the linear view z of the nearest surface, the sea's included. `veil` returns the
	 * colour `background` seen through the rain along a view direction, in front of content at a
	 * given distance, and the veil's opacity there in its alpha, which the result keeps (0 without
	 * a veil); it is also given the haze's transmittance to that content (`background` is `color`
	 * times it plus the haze's light), and may return that in the alpha instead (the composite
	 * after the resolve, Pipeline.ts, where the veil is laid later along `viewRay`). The volumes are
	 * imported into `graph`; `passes` then adds the kernels' passes. Called once, as the frame graph
	 * is built. */
	apply( color: V3, depth: THREE.Texture, sky: Sky, graph: GraphResources, veil?: ( direction: V3, distance: F, background: V3, transmittance: F ) => V4 ): V4 {

		const { width: W, height: H, depth: D } = this.grid;
		this.resolution = graph.extent( { of: 'render' } );
		const fixed: SizeClass = { of: 'fixed', width: W, height: H };
		this.resources = {
			visibility: graph.import( 'haze.visibility', this.visibility[ 0 ], fixed ),
			light: graph.import( 'haze.light', this.light, fixed ),
		};
		this.visibilityKernels = [ this.buildVisibilityKernel( 0, sky ), this.buildVisibilityKernel( 1, sky ) ];
		this.lightKernels = [ this.buildLightKernel( 0, sky ), this.buildLightKernel( 1, sky ) ];
		const sceneDepth = texture( depth );
		return Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( this.resolution ), 0, this.resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 );
			const viewFar = this.projectionInverse.mul( vec4( ndc, 1 ) ).toVar();
			const ray = viewFar.xyz.div( viewFar.w ).toVar();
			const view = normalize( ray ).toVar();
			const direction = normalize( this.cameraWorld.mul( vec4( view, 0 ) ).xyz ).toVar();
			const forward = view.z.negate().toVar();
			const sky_ = z.lessThan( SKY_Z ).toVar();
			// (the veil's distance: the surface's, 1e5 for the sky)
			const distance = select( sky_, float( 1e5 ), z.div( view.z ) ).toVar();
			// The haze reaches the surface, or the grid's far end through the sky; a ray below the
			// horizon ends there on the distant sea the sky draws.
			const reach = select( sky_, this.far.div( forward ), distance ).toVar();
			If( sky_.and( direction.y.lessThan( 0 ) ), () => {

				reach.assign( min( reach, this.origin.y.div( direction.y.negate() ) ) );

			} );
			const tau = reach.mul( meanExtinction( this.origin.y, this.origin.y.add( direction.y.mul( reach ) ), this.layerA, select( sky_, this.layerSky, this.layerB ), this.fogLayer ) );
			const exact = tau.mul( expShare( tau ) );
			const uvw = vec3( q, this.sliceCoordinate( reach.mul( forward ) ).sub( 0.5 ).div( D ) );
			const light = this.sampleLight( uvw ).toVar();
			const opacity = select( this.switches.z.greaterThan( 0.5 ), exact, light.a )
				.mul( select( sky_.and( this.switches.x.lessThan( 0.5 ) ), float( 0 ), float( 1 ) ) ).toVar();
			const result = select( this.switches.w.greaterThan( 0.5 ), light.rgb, mix( color, light.rgb, opacity ) );
			const transmittance = float( 1 ).sub( opacity );
			return veil ? veil( direction, distance, result, transmittance ) : vec4( result, 0 );

		} )();

	}

	/** Adds the haze's two kernels to `graph`, before the composite: the shadow's (skipped while a
	 * converged rest holds it) and the light's. Returns the light volume, which the composite reads. */
	passes<Frame>( graph: FrameGraph<Frame> ): ResourceHandle[] {

		const LABEL = 'volumetric haze';
		let { visibility, light } = this.resources!;
		const { width, height } = this.grid;
		const size: SizeClass = { of: 'fixed', width, height };
		graph.addPass( 'hazeShadow', 'compute', ( b ) => {

			visibility = b.storage( visibility );
			return {
				label: LABEL, size, when: () => this.shadowDue && debugFlags.hazeKernels !== false, whenLabel: 'not held by a rest', compute: this.visibilityKernels,
				run: ( _f, g ) => {

					this.written = 1 - this.written;
					g.renderer.compute( this.visibilityKernels[ this.written ] );

				},
			};

		} );
		graph.addPass( 'hazeLight', 'compute', ( b ) => {

			b.readOptional( visibility );
			light = b.storage( light );
			return {
				label: LABEL, size, compute: this.lightKernels, run: ( _f, g ) => {

					// (`flags.hazeKernels = false` skips both kernels, for timing them: the composite
					// then reads the volumes as they last were)
					if ( debugFlags.hazeKernels !== false ) g.renderer.compute( this.lightKernels[ this.written ] );

				},
			};

		} );
		return [ light ];

	}

	/** Once per frame, before the graph runs: the camera (its view, and its projection without the
	 * temporal modes' jitter), the render's and the output's sizes, and the page's frame. Sets the
	 * medium and the light from the weather and the settings, and the shadow's filter for the
	 * frame: at rest, running, or held. */
	update( camera: THREE.Camera, projection: THREE.Matrix4, width: number, height: number, outputWidth: number, outputHeight: number, frame: HazeFrame ): void {

		const S = this.settings;
		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.gridInverse.value.copy( projection ).invert();
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.origin.value.setFromMatrixPosition( camera.matrixWorld );
		// the medium
		const haze = this.haze.value, fog = this.fog.value * S.fogExtinction;
		this.layerA.value.set( haze * S.marineShare, S.marineHeight );
		this.layerB.value.set( haze * ( 1 - S.marineShare ), S.aerosolHeight );
		this.layerSky.value.set( Math.max( haze * ( 1 - S.marineShare ) - this.skyAerosol(), 0 ), S.aerosolHeight );
		this.fogLayer.value.set( fog, fog * S.fogAbove, S.fogTop, S.fogWidth );
		this.lightSettings.value.set( S.albedo, S.anisotropy, S.isotropic, S.sun );
		this.ambientScale.value = S.ambient;
		this.switches.value.set( S.sky ? 1 : 0, S.tricubic ? 1 : 0, S.densityAA ? 1 : 0, S.debug );
		// the slices
		const { depth } = this.grid;
		const g = S.growth, first = ( S.far - S.near ) * ( g - 1 ) / ( Math.pow( g, depth ) - 1 );
		this.slices.value.set( S.near, first, g, Math.log2( g ) );
		this.far.value = S.far;

		// the shadow's filter
		this.viewProjection.multiplyMatrices( projection, camera.matrixWorldInverse );
		// (the temporal rest's key, restKey, with the epoch's scene count: see restEpoch)
		const key = this.key;
		key.length = 0;
		key.push( ...camera.matrixWorld.elements, ...projection.elements, frame.time, width, height, outputWidth, outputHeight, restEpoch.scene,
			...frame.signature, ...this.keyDir.value.toArray(), this.keyColor.value.r, this.keyColor.value.g, this.keyColor.value.b,
			S.near, S.far, S.growth, S.restFrames, S.jitter ? 1 : 0 );
		this.rest.sequence = S.restFrames;
		this.rest.observe( key, frame.stable );
		camera.matrixWorld.decompose( this.position, this.quaternion, this.scale );
		const last = this.last;
		const cut = ! last.valid || last.keyDir.angleTo( this.keyDir.value ) > CUT || ! last.slices.equals( this.slices.value )
			|| last.position.distanceTo( this.position ) > JUMP.distance || last.quaternion.angleTo( this.quaternion ) > JUMP.angle;
		if ( cut ) this.historyValid = false;
		const index = this.rest.index;
		this.shadowDue = ! this.rest.converged || index !== null;
		const jitter = ( i: number ) => S.jitter ? this.sequence.value.set( halton( i, 2 ), halton( i, 3 ), halton( i, 5 ) ) : this.sequence.value.setScalar( 0.5 );
		if ( index !== null ) {

			this.restIndex.value = index;
			jitter( index + 1 );

		} else {

			this.restIndex.value = - 1;
			this.frame = ( this.frame + 1 ) % Math.max( S.restFrames, 1 );
			jitter( this.frame + 1 );

		}
		this.blend.value = this.historyValid ? S.blend : 1;
		this.previousViewProjection.value.copy( last.viewProjection );
		// what the next frame reprojects through
		last.valid = true;
		last.keyDir.copy( this.keyDir.value );
		last.slices.copy( this.slices.value );
		last.position.copy( this.position );
		last.quaternion.copy( this.quaternion );
		last.viewProjection.copy( this.viewProjection );
		if ( this.shadowDue ) this.historyValid = true;

	}

	/** The inverse projection the composite's rays are reconstructed with (`update` takes the
	 * camera's): under the temporal modes the jittered one the depth they read was drawn with, set
	 * by Pipeline's jitter hook, so each pixel's ray meets its own depth sample. */
	setProjectionInverse( inverse: THREE.Matrix4 ): void {

		this.projectionInverse.value.copy( inverse );

	}

	/** The shadow's rest has not converged (main.ts holds the settled signal for it). */
	get pending(): boolean {

		return ! this.rest.converged;

	}

	/** Drops the shadow's history and its rest (a scene jump: `establishScene`). */
	invalidate(): void {

		this.historyValid = false;
		this.last.valid = false;
		this.rest.restart();

	}

	// the atmosphere's own aerosol extinction at sea level (1/m: Atmosphere.ts, 4.440e-3 / km per
	// unit of `mieScale`), which the sky already holds
	private skyAerosol(): number {

		return this.atmosphere.mieScale.value * 4.440e-6;

	}

	/** The medium's transmittance from a point at `height` toward `direction`, to the grid's far end
	 * (for the sun's glare, a sky pixel: 1 while the haze leaves the sky, else as the composite takes
	 * it over the sky, the deep layer's excess over the atmosphere's aerosols). */
	transmittance( height: number, direction: THREE.Vector3 ): number {

		const S = this.settings;
		if ( ! S.sky ) return 1;
		const dy = Math.max( direction.y, 1e-4 );
		const reach = S.far;
		const a = Math.max( height, 0 ), b = Math.max( height + dy * reach, 0 );
		const exponential = ( sigma: number, h: number ) => sigma * h * ( Math.exp( - a / h ) - Math.exp( - b / h ) ) / dy;
		const haze = this.haze.value, fog = this.fog.value * S.fogExtinction, k = S.fogWidth;
		// the sigmoid's integral over heights, ( x + r ) / 2 of its weight
		const integral = ( y: number ) => {

			const x = y - S.fogTop;
			return fog * y + fog * ( S.fogAbove - 1 ) * 0.5 * ( x + Math.sqrt( x * x + k * k ) );

		};
		const tau = exponential( haze * S.marineShare, S.marineHeight ) + exponential( Math.max( haze * ( 1 - S.marineShare ) - this.skyAerosol(), 0 ), S.aerosolHeight )
			+ ( integral( b ) - integral( a ) ) / dy;
		return Math.exp( - tau );

	}

}
