/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater):
 * the two-layer height haze of `AirHaze.js` (analytic optical depth, horizon-coloured in-scatter,
 * the sun's phase-weighted share near the camera).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, uv, ivec2, vec2, vec3, vec4, float, max, min, clamp, length,
	normalize, exp, pow, mix, dot, abs, select, smoothstep, luminance, mx_noise_float, screenCoordinate,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import { debugFlags } from '../debug/DebugFlags.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// Distant air: two exponential height layers, a thin marine layer over the sea and a deeper aerosol
// layer, in tidewater's proportions. The weather's haze is their combined extinction at sea level
// (1/m), so the marine layer carries most of it close to the water and the aerosol the rest aloft.
const MARINE = { share: 1.5e-4 / 1.82e-4, height: 110 };
const AEROSOL = { share: 3.2e-5 / 1.82e-4, height: 1400 };
// Within this distance the haze is lit by the key light through its phase function; beyond it, the
// haze takes the horizon sky's colour, which already holds the in-scatter of the whole path.
const NEAR = 900;
// The protected foreground: the air fades in between these distances from the camera (metres), so
// the island keeps its contrast up close and gains its veil gradually as the view pulls back,
// rather than all at once past a fixed edge. Thick air (rain, storm) closes in sooner: its ramp
// ends nearer, so a rainy island at a distance keeps its grey veil.
const CLEAR = { start: 40, end: 200, thickEnd: 120, thin: 5e-4, thick: 2e-3 };

// Sea fog: a third, low layer of the marine air whose density drifts in banks. Extinction at sea
// level per unit of fog. A bank is denser and stands taller than the thin air between banks, so
// seen from above the fog lies on the sea in patches and from sea level it has rolling tops,
// rather than one even sheet (scale heights in metres; the mean is for the far, unresolved layer).
const FOG_EXTINCTION = 0.0085;
const FOG_GAP_HEIGHT = 6;
const FOG_BANK_HEIGHT = 28;
const FOG_MEAN = { density: 0.9, height: 17 };
const FOG_REACH = 4000; // metres marched through drifting banks; beyond, the mean layer
// The banks' noise is baked into a map of BANK_SPAN metres around the camera (in the drifting
// frame), wide enough for the march's reach plus the distance the camera may move before the map
// is recentred.
const BANK_SPAN = 8192;
const BANK_RECENTRE = 48;
// While the clock runs, the map is re-baked once the banks have evolved this long (seconds of
// fog time): their slowest change, 0.015 noise units a second, moves a bank's density by about
// a hundredth in that time, below what shows between two frames.
const BANK_REBAKE = 0.2;
// A frame step of the fog's clock longer than this (seconds) is taken for a seek.
const FRAME_STEP_MAX = 0.1;
// The reduced fog's upsample: a texel's weight falls to half where its depth differs from the
// pixel's by this fraction of the pixel's distance (a Gaussian: a sixteenth at twice the
// tolerance, nothing past four times, so a surface behind cannot outweigh the pixel's own however
// small its bilinear share). Where none of the four texels lies within it
// (sky or sea seen between leaves, a thin figure the reduced march missed), the pixel marches the
// fog itself instead.
const FOG_DEPTH_TOLERANCE = 0.05;
// The island's warm rock thins the fog over it and in its lee: radii (metres) of the clearing.
const CLEARING = { inner: 20, outer: 100, floor: 0.45 };
// Fog droplets scatter the beam on through the bank: its forward glow is a softer, wider lobe than
// single scattering gives, so it is scaled down toward the sun (see `phase`).
const FOG_SUN = 0.45;
// The fog's diffuse reflectance seen from above (a thin layer: less than a cloud deck's).
const FOG_ALBEDO = 0.45;

// A view ray and the light the air scatters along it (see `AerialPerspective.ray`).
interface AirRay {
	direction: V3; origin: V3; distance: F; down: F; around: V3; shade: F;
	lit: ( sky: V3, near: F ) => V3;
	hazeDepth: F; hazeLight: V3 | null;
}

/** The frame graph's structural choices for the air, fixed when the page loads (the quality tier
 * sets them). Today's high: 12 steps, the bank noise baked into a 2048^2 map, and the fog marched
 * at half the render's resolution. */
export interface AirOptions {
	// steps of the fog march through the banks
	fogSteps: number;
	// texels per side of the baked bank noise; 0 evaluates the noise at every step instead
	bankSize: number;
	// the fog march's resolution relative to the render (1, 1/2 or 1/4); below 1 it runs in a pass
	// of its own and the composite upsamples it by depth
	fogScale: number;
}

export const DEFAULT_AIR_OPTIONS: Readonly<AirOptions> = { fogSteps: 12, bankSize: 2048, fogScale: 0.5 };

// Optical depth of one exponential layer (extinction `sigma` at sea level, scale height `height`)
// from height `hc` along a ray whose direction has the vertical component `vy`, over `d` metres.
const layerDepth = Fn( ( [ sigma, height, hc, vy, d ]: [ F, F, F, F, F ] ) => {

	const k = vy.mul( d ).div( height ).toVar();
	const along = select( abs( k ).lessThan( 1e-3 ), d, height.mul( float( 1 ).sub( exp( k.negate() ) ) ).div( vy ) );
	return exp( max( hc, 0 ).div( height ).negate() ).mul( sigma ).mul( along );

} ).setLayout( { name: 'airLayerDepth', type: 'float', inputs: [
	{ name: 'sigma', type: 'float' }, { name: 'height', type: 'float' }, { name: 'hc', type: 'float' },
	{ name: 'vy', type: 'float' }, { name: 'd', type: 'float' },
] } );

// Cornette-Shanks (a strong forward lobe) with a little isotropic scattering: softer than coastal
// aerosol's g ~0.76, so a low sun warms the haze toward it without glaring over everything in front.
const phase = Fn( ( [ cosine ]: [ F ] ) => {

	const g = 0.62, g2 = g * g;
	const cs = float( 3 * ( 1 - g2 ) / ( 8 * Math.PI * ( 2 + g2 ) ) ).mul( cosine.mul( cosine ).add( 1 ) )
		.div( pow( max( float( 1 + g2 ).sub( cosine.mul( 2 * g ) ), 1e-4 ), 1.5 ) );
	return cs.mul( 0.7 ).add( 0.3 / ( 4 * Math.PI ) );

} ).setLayout( { name: 'airPhase', type: 'float', inputs: [ { name: 'cosine', type: 'float' } ] } );

/** Distant air and sea fog over the completed opaque/water image.
 *
 * The haze is two exponential height layers with their optical depth integrated analytically
 * along the view ray, and fades in across a protected foreground. Its light is the sky just above
 * the horizon in the view direction, so the far sea fades into the horizon itself; near the camera
 * the key light's share of it is scattered through a phase function instead, warm and bright toward
 * a low sun and dimmer away from it (after tidewater's `AirHaze`), and dark in the clouds' shadow.
 * Sky pixels get no haze: the sky already holds its own.
 *
 * The sea fog raises the marine air's density in a low layer that falls with height and drifts in
 * banks with the wind, so it can surround the island and still leave the sky clear above. It is lit
 * the same way, by its own mean scattering distance. This pass never changes the refraction source. */
export class AerialPerspective {

	readonly haze = uniform( 0 );
	// Where the air reaches its full density (metres from the camera), set from the haze each frame.
	readonly clearEnd = uniform( CLEAR.end );
	readonly fog = uniform( 0 );
	// Wind travel (metres) and slow change of the banks.
	readonly fogOffset = uniform( new THREE.Vector2() );
	readonly fogTime = uniform( 0 );
	// The key light the air scatters: its direction and its irradiance below the clouds (a closed
	// deck leaves no beam to scatter).
	readonly keyDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	readonly keyColor = uniform( new THREE.Color( 0, 0, 0 ) );
	// The beam's transmittance down through the fog layer to the banks around the island.
	private fogSun = uniform( 1 );
	private projectionInverse = uniform( new THREE.Matrix4() );
	private cameraWorld = uniform( new THREE.Matrix4() );
	private resolution = uniform( new THREE.Vector2( 1, 1 ) );
	readonly options: Readonly<AirOptions>;

	// The banks' two noise octaves, baked around the camera in the drifting frame (fogOffset
	// added), so the wind only shifts where the march reads the map. Texel centres lie on a
	// lattice fixed in that frame (the centre snaps to whole texels and each texel's position comes
	// from its exact pixel coordinate), so where the map is centred never changes a value. The map
	// is a pure function of the time it was baked at: re-baked while the clock runs once the banks
	// have evolved BANK_REBAKE seconds, and at rest (a paused clock, a seek) whenever that time or
	// the centre differs at all, so a paused frame does not depend on the frames before it.
	private bankRT: THREE.RenderTarget | null = null;
	private bankQuad: THREE.QuadMesh | null = null;
	private readonly bankCentre = uniform( new THREE.Vector2() );
	private readonly bankTime = uniform( 0 );
	private bank = { valid: false, time: 0, x: 0, z: 0 };
	private bankDue = false;
	private lastFogTime = NaN;
	private lastStep = NaN;

	// The fog march at a reduced resolution: the nearest of the surface depths it covers, and the
	// fog's light (rgb) and optical depth (a) at that depth.
	private fogZRT: THREE.RenderTarget | null = null;
	private fogRT: THREE.RenderTarget | null = null;
	private fogZQuad: THREE.QuadMesh | null = null;
	private fogQuad: THREE.QuadMesh | null = null;
	private readonly fogRes = uniform( new THREE.Vector2( 1, 1 ) );
	// below this depth similarity a pixel marches its own fog (0 turns the fallback off, for A/B:
	// debugFlags.fogFallback = false)
	private readonly fallbackBelow = uniform( 0.5 );

	constructor( options: Partial<AirOptions> = {} ) {

		this.options = { ...DEFAULT_AIR_OPTIONS, ...options };

	}

	// The view ray through screen position `q` (uv) to a surface at view z `z`, and the light the
	// air scatters along it: shared by the full-resolution composite and the reduced fog march.
	private ray( q: V2, z: F, sky: Sky, haze: boolean ): AirRay {

		const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 ).toVar();
		const viewFar = this.projectionInverse.mul( vec4( ndc, 1 ) ).toVar();
		const ray = viewFar.xyz.div( viewFar.w ).toVar();
		const direction = normalize( this.cameraWorld.mul( vec4( normalize( ray ), 0 ) ).xyz ).toVar();
		const origin = this.cameraWorld.mul( vec4( 0, 0, 0, 1 ) ).xyz.toVar();
		// The air takes the sky's colour just above the horizon, so the far sea fades into the
		// horizon itself rather than stopping short of it in a darker band. Looking down, the air
		// is lit by the whole sky; a sharp horizon sample there would spread the horizon's clouds
		// and the sun's glow into rays converging below the camera, so it turns to the horizon's
		// average.
		const down = smoothstep( 0.02, 0.35, direction.y.negate() ).toVar();
		const around = sky.sampleBackground( vec3( 1, 0.06, 0 ), float( 6 ) ).add( sky.sampleBackground( vec3( - 1, 0.06, 0 ), float( 6 ) ) )
			.add( sky.sampleBackground( vec3( 0, 0.06, 1 ), float( 6 ) ) ).add( sky.sampleBackground( vec3( 0, 0.06, - 1 ), float( 6 ) ) ).mul( 0.25 ).toVar();
		const air = haze ? mix( sky.sampleBackground( normalize( vec3( direction.x, 0.008, direction.z ) ), float( 2 ) ), around, down ).toVar() : null;
		// The key light scattered toward the eye, and its share of the air's light: the rest is
		// the sky's (E / pi, comparable with a radiance).
		const scattered = this.keyColor.rgb.mul( phase( dot( direction, this.keyDir ) ) ).toVar();
		const sunLuma = luminance( scattered );
		const sunShare = sunLuma.div( sunLuma.add( luminance( sky.irradianceNode ) ).add( 1e-5 ) ).toVar();
		const distance = float( 1e5 ).toVar();
		const hazeDepth = float( 0 ).toVar();
		// The resolved sky sits at -1e5; the sea's skirt reaches tens of kilometres.
		If( z.greaterThan( - 9e4 ), () => {

			distance.assign( length( ray.mul( z.div( ray.z ) ) ) );
			if ( ! haze ) return;
			// The air's density along the ray is weighted by smoothstep( start, end ) of the distance.
			// Integrated, the weight holds back `held` metres of air; the rest is integrated from
			// there to the content (the held air is the near part, the remaining depth the far).
			const ramp = this.clearEnd.sub( CLEAR.start ).toVar();
			const u = clamp( distance.sub( CLEAR.start ).div( ramp ), 0, 1 ).toVar();
			const u3 = u.mul( u ).mul( u ).toVar();
			const held = min( distance, CLEAR.start ).add( u.sub( u3 ).add( u3.mul( u ).mul( 0.5 ) ).mul( ramp ) ).toVar();
			const start = origin.y.add( direction.y.mul( held ) );
			const d = max( distance.sub( held ), 0 );
			hazeDepth.assign( layerDepth( this.haze.mul( MARINE.share ), float( MARINE.height ), start, direction.y, d )
				.add( layerDepth( this.haze.mul( AEROSOL.share ), float( AEROSOL.height ), start, direction.y, d ) ) );

		} );
		// The near air lies in the clouds' shadow wherever the ground does: the beam it scatters is
		// the one the cloud shadow map lets through, sampled along the near stretch of the ray
		// where the air shows (from the foreground's edge on). The sky's share keeps its
		// light, so a shadowed haze toward a low sun is lit by the sky alone, not by its aureole.
		const reachNear = min( distance, NEAR ).toVar();
		const from = min( float( CLEAR.start ), reachNear ).toVar();
		const shade = sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 1 / 6 ) ) ) )
			.add( sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 0.5 ) ) ) ) )
			.add( sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 5 / 6 ) ) ) ) ).div( 3 ).toVar();
		const beam = scattered.mul( shade ).toVar();
		// Near the camera the sun's share of the light is its explicit, phase-weighted scattering;
		// far away the horizon's colour (whose sun glow already holds it).
		const lit = ( sky: V3, near: F ) => sky.mul( float( 1 ).sub( sunShare.mul( near ) ) ).add( beam.mul( near ) );
		const hazeLight = air ? lit( air, float( 1 ).sub( smoothstep( 0, NEAR, distance ) ) ).toVar() : null;
		return { direction, origin, distance, down, around, shade, lit, hazeDepth, hazeLight };

	}

	// The sea fog's optical depth and light along a ray (zero without fog).
	private march( r: AirRay, sky: Sky ): { fogDepth: F; fogLight: V3 } {

		const { direction, origin, distance, down, around, shade, lit } = r;
		const steps = this.options.fogSteps;
		const bank = this.bankRT ? texture( this.bankRT.texture ) : null;
		const fogDepth = float( 0 ).toVar();
		const fogLight = vec3( 0 ).toVar();
		If( this.fog.greaterThan( 0.001 ), () => {

			const sigma = this.fog.mul( FOG_EXTINCTION ).toVar();
			// Quadratic steps along level rays: dense near the camera where banks are resolved, sparse
			// beyond. A ray looking down crosses the layer only near its end, so it steps evenly.
			const reach = min( distance, FOG_REACH ).toVar();
			const even = smoothstep( 0.1, 0.5, direction.y.negate() ).toVar();
			const previous = float( 0 ).toVar();
			// The fog's scattering weighted by what reaches the eye, and its mean distance.
			const weight = float( 0 ).toVar(), weighted = float( 0 ).toVar();
			Loop( steps, ( { i } ) => {

				const u = float( i ).add( 1 ).div( steps );
				const t = reach.mul( mix( u.mul( u ), u, even ) ).toVar();
				const mid = t.add( previous ).mul( 0.5 ).toVar();
				const p = origin.add( direction.mul( mid ) ).toVar();
				// Banks: drifting patches a hundred metres or so across with wisps at their edges,
				// thinner gaps between them; they evolve slowly as they drift.
				const drift = p.xz.add( this.fogOffset ).toVar();
				const noise = bank ? bank.sample( drift.sub( this.bankCentre ).div( BANK_SPAN ).add( 0.5 ) ).level( float( 0 ) ).r
					: mx_noise_float( vec3( drift.div( 140 ), this.fogTime.mul( 0.006 ) ) ).mul( 0.65 )
						.add( mx_noise_float( vec3( drift.div( 45 ), this.fogTime.mul( 0.015 ).add( 3.7 ) ) ).mul( 0.35 ) );
				const bank_ = smoothstep( 0.2, 0.75, noise.mul( 0.5 ).add( 0.5 ) ).toVar();
				const clearing = mix( float( CLEARING.floor ), float( 1 ), smoothstep( CLEARING.inner, CLEARING.outer, length( p.xz ) ) );
				const local = exp( max( p.y, 0 ).div( mix( float( FOG_GAP_HEIGHT ), float( FOG_BANK_HEIGHT ), bank_ ) ).negate() )
					.mul( bank_.mul( 1.6 ).add( 0.12 ) ).mul( clearing );
				const step = local.mul( t.sub( previous ) ).toVar();
				const w = step.mul( exp( fogDepth.add( step.mul( 0.5 ) ).mul( sigma ).negate() ) );
				weight.addAssign( w );
				weighted.addAssign( w.mul( mid ) );
				fogDepth.addAssign( step );
				previous.assign( t );

			} );
			// Beyond the marched reach, the mean layer integrated analytically along the ray.
			const start = origin.add( direction.mul( reach ) ).toVar();
			const rest = max( distance.sub( reach ), 0 ).toVar();
			const tail = layerDepth( float( FOG_MEAN.density ), float( FOG_MEAN.height ), start.y, direction.y, rest ).toVar();
			const w = tail.mul( exp( fogDepth.mul( sigma ).negate() ) );
			weight.addAssign( w );
			weighted.addAssign( w.mul( reach.add( min( rest, FOG_REACH ).mul( 0.5 ) ) ) );
			fogDepth.assign( fogDepth.add( tail ).mul( sigma ) );
			// Seen edge-on, fog takes the low sky's light, as the horizon it hides would, so it merges
			// with the sky rather than banding against it; the sample is blurred so the horizon's
			// clouds do not print into the fog, and high enough that the blur stays clear of the sea.
			// Seen from above, the bank's top is a thick, white scattering layer lit like a cloud by
			// the key light and the sky (multiple scattering, which the phase term alone misses).
			const low = mix( sky.sampleBackground( normalize( vec3( direction.x, 0.06, direction.z ) ), float( 4 ) ), around, down ).mul( 0.9 );
			// Many scattering events also wash out the low sun's colour toward white. The cloud shadow
			// reuses the near air's samples (within the ray's first 900 m) rather than the spot where
			// the ray meets the bank's top: close enough for banks seen from the island's height, but
			// a top far below a high camera may take a neighbouring patch's shadow.
			const lambert = this.keyColor.rgb.mul( max( this.keyDir.y, 0 ).mul( this.fogSun ).mul( shade ).div( Math.PI ) ).add( sky.irradianceNode ).mul( FOG_ALBEDO ).toVar();
			const top = mix( vec3( luminance( lambert ) ), lambert, 0.25 );
			const near = float( 1 ).sub( smoothstep( 0, NEAR, weighted.div( max( weight, 1e-6 ) ) ) ).mul( this.fogSun );
			fogLight.assign( lit( mix( low, top, smoothstep( 0.15, 0.6, direction.y.negate() ) ), near.mul( FOG_SUN ) ) );

		} );
		return { fogDepth, fogLight };

	}

	/** `depth` is the linear view z of the nearest surface, the sea's included. `veil` returns the
	 * colour `background` seen through the rain along a view direction, in front of content at a
	 * given distance. Called once, by the frame graph. */
	apply( color: V3, depth: THREE.Texture, sky: Sky, veil?: ( direction: V3, distance: F, background: V3 ) => V3 ): V3 {

		const { bankSize, fogScale } = this.options;
		if ( bankSize > 0 ) this.buildBank( bankSize );
		const reduced = fogScale < 1 ? this.buildFogPasses( depth, sky, Math.round( 1 / fogScale ) ) : null;
		const sceneDepth = texture( depth );
		return Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( this.resolution ), 0, this.resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const r = this.ray( q, z, sky, true );
			const { fogDepth, fogLight } = reduced ? reduced( q, z, () => this.march( r, sky ) ) : this.march( r, sky );
			// One medium: the layers' light mixed by their share of the optical depth.
			const hazeDepth = r.hazeDepth, hazeLight = r.hazeLight!;
			const total = hazeDepth.add( fogDepth ).toVar();
			const transmittance = exp( total.negate() );
			const light = hazeLight.mul( hazeDepth ).add( fogLight.mul( fogDepth ) ).div( max( total, 1e-6 ) );
			const result = mix( light, color, transmittance );
			return veil ? veil( r.direction, r.distance, result ) : result;

		} )();

	}

	private buildBank( size: number ): void {

		this.bankRT = new THREE.RenderTarget( size, size, { type: THREE.HalfFloatType, format: THREE.RedFormat, depthBuffer: false } );
		this.bankRT.texture.name = 'fogBanks';
		const material = new THREE.NodeMaterial();
		material.name = 'Fog.Banks';
		material.fragmentNode = Fn( () => {

			// (the texel's exact position in the drifting frame, from its pixel coordinate)
			const drift = this.bankCentre.add( screenCoordinate.xy.sub( size / 2 ).mul( BANK_SPAN / size ) ).toVar();
			const n = mx_noise_float( vec3( drift.div( 140 ), this.bankTime.mul( 0.006 ) ) ).mul( 0.65 )
				.add( mx_noise_float( vec3( drift.div( 45 ), this.bankTime.mul( 0.015 ).add( 3.7 ) ) ).mul( 0.35 ) );
			return vec4( n, 0, 0, 1 );

		} )();
		this.bankQuad = new THREE.QuadMesh( material );
		this.bankQuad.name = 'Fog.Banks';

	}

	// The fog march at 1 / `k` of the render's resolution, and the composite's depth-aware
	// upsample of it. The march takes the nearest surface of the pixels it covers, so a thin
	// figure or leaf in front of the fog keeps its own value; the upsample then weights the four
	// texels round a pixel by how near their depth lies to the pixel's own, so the fog of the sea
	// behind a cliff does not bleed onto the cliff's edge, nor the cliff's onto the sea. A pixel
	// none of whose texels lies near its depth (the sky between leaves, whose texels all took a
	// leaf's depth) marches at full resolution (`full`): normalised, the weights would hand it the
	// leaves' fog, and the foliage would speckle against the fog banks.
	private buildFogPasses( depth: THREE.Texture, sky: Sky, k: number ): ( q: V2, z: F, full: () => { fogDepth: F; fogLight: V3 } ) => { fogDepth: F; fogLight: V3 } {

		const sceneDepth = texture( depth );
		this.fogZRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } );
		this.fogZRT.texture.name = 'fogNearestDepth';
		this.fogRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false } );
		this.fogRT.texture.name = 'fogMarch';
		const a = Math.floor( k / 4 ), b = Math.floor( 3 * k / 4 );
		const zMaterial = new THREE.NodeMaterial();
		zMaterial.name = 'Fog.NearestDepth';
		zMaterial.fragmentNode = Fn( () => {

			const base = screenCoordinate.xy.floor().mul( k ).toVar();
			const last = this.resolution.sub( 1 );
			const load = ( x: number, y: number ) => textureLoad( sceneDepth, ivec2( min( base.add( vec2( x, y ) ), last ) ) ) as unknown as F;
			// view z: the nearest surface is the largest (the sky's -1e5 the smallest)
			return vec4( max( max( load( a, a ), load( b, a ) ), max( load( a, b ), load( b, b ) ) ), 0, 0, 1 );

		} )();
		this.fogZQuad = new THREE.QuadMesh( zMaterial );
		this.fogZQuad.name = 'Fog.NearestDepth';
		const tFogZ = texture( this.fogZRT.texture );
		const marchMaterial = new THREE.NodeMaterial();
		marchMaterial.name = 'Fog.March';
		marchMaterial.fragmentNode = Fn( () => {

			const coord = ivec2( screenCoordinate.xy ).toVar();
			const z = ( textureLoad( tFogZ, coord ) as unknown as F ).toVar();
			// the centre of the pixels this texel covers
			const q = vec2( coord ).mul( k ).add( k / 2 ).div( this.resolution ).toVar();
			const { fogDepth, fogLight } = this.march( this.ray( q, z, sky, false ), sky );
			return vec4( fogLight, fogDepth );

		} )();
		this.fogQuad = new THREE.QuadMesh( marchMaterial );
		this.fogQuad.name = 'Fog.March';

		const tFog = texture( this.fogRT.texture ), tZ = texture( this.fogZRT.texture );
		return ( q: V2, z: F, full: () => { fogDepth: F; fogLight: V3 } ) => {

			const fogDepth = float( 0 ).toVar();
			const fogLight = vec3( 0 ).toVar();
			If( this.fog.greaterThan( 0.001 ), () => {

				const hp = q.mul( this.resolution ).div( k ).sub( 0.5 ).toVar();
				const base = hp.floor().toVar();
				const f = hp.sub( base ).toVar();
				const acc = vec4( 0 ).toVar(), wsum = float( 0 ).toVar(), best = float( 0 ).toVar();
				const scale = max( abs( z ), 1 ).mul( FOG_DEPTH_TOLERANCE ).toVar();
				for ( const [ ox, oy ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

					const texel = ivec2( clamp( base.add( vec2( ox, oy ) ), vec2( 0 ), this.fogRes.sub( 1 ) ) ).toVar();
					const bl = ( ox ? f.x : float( 1 ).sub( f.x ) ).mul( oy ? f.y : float( 1 ).sub( f.y ) );
					const dz = abs( ( textureLoad( tZ, texel ) as unknown as F ).sub( z ) ).div( scale );
					const near = exp( dz.mul( dz ).mul( - Math.LN2 ) ).toVar();
					const w = bl.mul( near.add( 1e-4 ) );
					acc.addAssign( ( textureLoad( tFog, texel ) as unknown as THREE.Node<'vec4'> ).mul( w ) );
					wsum.addAssign( w );
					best.assign( max( best, near ) );

				}
				// (the march samples its maps at explicit levels, so it may run in this branch)
				If( best.lessThan( this.fallbackBelow ), () => {

					const own = full();
					fogLight.assign( own.fogLight );
					fogDepth.assign( own.fogDepth );

				} ).Else( () => {

					const mean = acc.div( max( wsum, 1e-8 ) ).toVar();
					fogLight.assign( mean.rgb );
					fogDepth.assign( mean.a );

				} );

			} );
			return { fogDepth, fogLight };

		};

	}

	/** Sizes the reduced fog march to the scene's render. */
	setSize( width: number, height: number ): void {

		if ( ! this.fogRT ) return;
		const k = Math.round( 1 / this.options.fogScale );
		const w = Math.max( Math.floor( width / k ), 1 ), h = Math.max( Math.floor( height / k ), 1 );
		this.fogRT.setSize( w, h );
		this.fogZRT!.setSize( w, h );
		this.fogRes.value.set( w, h );

	}

	/** Bakes the bank map when it is due and marches the fog at its reduced resolution, before
	 * the composite reads them (after `update`, the surface depth resolved). */
	render( renderer: THREE.WebGPURenderer ): void {

		if ( this.fog.value <= 0.001 ) return;
		const target = renderer.getRenderTarget();
		if ( this.bankQuad && this.bankDue ) {

			renderer.setRenderTarget( this.bankRT );
			this.bankQuad.render( renderer );
			this.bankDue = false;

		}
		if ( this.fogQuad ) {

			renderer.setRenderTarget( this.fogZRT );
			this.fogZQuad!.render( renderer );
			renderer.setRenderTarget( this.fogRT );
			this.fogQuad.render( renderer );

		}
		renderer.setRenderTarget( target );

	}

	/** Compiles the passes that first run when fog sets in, so the first foggy frame does not
	 * stall on them. (compileAsync takes the render target when it is called, so the renderer's
	 * own is restored before the compiles finish, never across frames rendered meanwhile.) */
	async warm( renderer: THREE.WebGPURenderer ): Promise<void> {

		const target = renderer.getRenderTarget();
		const compiles: Promise<void>[] = [];
		for ( const [ quad, rt ] of [ [ this.bankQuad, this.bankRT ], [ this.fogZQuad, this.fogZRT ], [ this.fogQuad, this.fogRT ] ] as const ) {

			if ( ! quad || ! rt ) continue;
			renderer.setRenderTarget( rt );
			compiles.push( renderer.compileAsync( quad, ( quad as unknown as { camera: THREE.Camera } ).camera ) );

		}
		renderer.setRenderTarget( target );
		await Promise.all( compiles );

	}

	update( camera: THREE.Camera, width: number, height: number ): void {

		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.resolution.value.set( width, height );
		this.clearEnd.value = THREE.MathUtils.lerp( CLEAR.end, CLEAR.thickEnd, THREE.MathUtils.smoothstep( this.haze.value, CLEAR.thin, CLEAR.thick ) );
		// The beam reaching the banks low over the sea.
		this.fogSun.value = this.fogTransmittance( 8, this.keyDir.value );
		if ( this.bankRT ) this.scheduleBank( camera );
		this.fallbackBelow.value = debugFlags.fogFallback === false ? 0 : 0.5;

	}

	// Decides whether the bank map is re-baked this frame (see `bankRT`).
	private scheduleBank( camera: THREE.Camera ): void {

		// Running: this frame and the one before each stepped the fog's clock forward by an ordinary
		// frame's time. Anything else (a paused clock, a seek, the first frame after either) takes
		// the map at its exact time, so a frame rendered at rest never depends on the ones before.
		const time = this.fogTime.value;
		const step = time - this.lastFogTime;
		const running = step > 0 && step <= FRAME_STEP_MAX && this.lastStep > 0 && this.lastStep <= FRAME_STEP_MAX;
		this.lastFogTime = time;
		this.lastStep = step;
		if ( this.fog.value <= 0.001 ) return;
		const texel = BANK_SPAN / this.options.bankSize;
		const e = camera.matrixWorld.elements, offset = this.fogOffset.value;
		const x = e[ 12 ] + offset.x, z = e[ 14 ] + offset.y;
		const sx = Math.round( x / texel ) * texel, sz = Math.round( z / texel ) * texel;
		const b = this.bank;
		const recentre = ! b.valid || Math.max( Math.abs( x - b.x ), Math.abs( z - b.z ) ) > BANK_RECENTRE;
		const differs = time !== b.time || sx !== b.x || sz !== b.z;
		const due = recentre || ( differs && ( ! running || Math.abs( time - b.time ) >= BANK_REBAKE || debugFlags.fogBankLazy === false ) );
		if ( ! due ) return;
		b.valid = true; b.time = time; b.x = sx; b.z = sz;
		this.bankCentre.value.set( sx, sz );
		this.bankTime.value = time;
		this.bankDue = true;

	}

	/** Re-bakes the bank map on the next frame (after a seek or a jump of the camera). */
	invalidate(): void {

		this.bank.valid = false;

	}

	/** Transmittance of the fog layer from `height` toward a direction, for the sun's disk. */
	fogTransmittance( height: number, direction: THREE.Vector3 ): number {

		const dy = Math.max( direction.y, 0.02 );
		const { density, height: scale } = FOG_MEAN;
		return Math.exp( - this.fog.value * FOG_EXTINCTION * density * scale * Math.exp( - Math.max( height, 0 ) / scale ) / dy );

	}

}
