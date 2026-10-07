/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater):
 * the two-layer height haze of `AirHaze.js` (analytic optical depth, horizon-coloured in-scatter,
 * the sun's phase-weighted share near the camera).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, uv, ivec2, vec3, vec4, float, max, min, clamp, length,
	normalize, exp, pow, mix, dot, abs, select, smoothstep, luminance, mx_noise_float,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Distant air: two exponential height layers, a thin marine layer over the sea and a deeper aerosol
// layer, in tidewater's proportions. The weather's haze is their combined extinction at sea level
// (1/m), so the marine layer carries most of it close to the water and the aerosol the rest aloft.
const MARINE = { share: 1.5e-4 / 1.82e-4, height: 110 };
const AEROSOL = { share: 3.2e-5 / 1.82e-4, height: 1400 };
// Within this distance the haze is lit by the key light through its phase function; beyond it, the
// haze takes the horizon sky's colour, which already holds the in-scatter of the whole path.
const NEAR = 900;

// Sea fog: a third, low layer of the marine air whose density drifts in banks. Extinction at sea
// level per unit of fog. A bank is denser and stands taller than the thin air between banks, so
// seen from above the fog lies on the sea in patches and from sea level it has rolling tops,
// rather than one even sheet (scale heights in metres; the mean is for the far, unresolved layer).
const FOG_EXTINCTION = 0.0085;
const FOG_GAP_HEIGHT = 6;
const FOG_BANK_HEIGHT = 28;
const FOG_MEAN = { density: 0.9, height: 17 };
const FOG_STEPS = 12;
const FOG_REACH = 4000; // metres marched through drifting banks; beyond, the mean layer
// The island's warm rock thins the fog over it and in its lee: radii (metres) of the clearing.
const CLEARING = { inner: 20, outer: 100, floor: 0.45 };
// Fog droplets scatter the beam on through the bank: its forward glow is a softer, wider lobe than
// single scattering gives, so it is scaled down toward the sun (see `phase`).
const FOG_SUN = 0.45;
// The fog's diffuse reflectance seen from above (a thin layer: less than a cloud deck's).
const FOG_ALBEDO = 0.45;

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
 * along the view ray, and acts only beyond a protected foreground. Its light is the sky just above
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
	readonly clearDistance = uniform( 85 );
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

	/** `veil` returns the colour `background` seen through the rain along a view direction, in front
	 * of content at a given distance. */
	apply( color: V3, depth: THREE.Texture, waterDepth: THREE.Texture, sky: Sky, veil?: ( direction: V3, distance: F, background: V3 ) => V3 ): V3 {

		const sceneDepth = texture( depth ), surfaceDepth = texture( waterDepth );
		return Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( this.resolution ), 0, this.resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const dw = ( textureLoad( surfaceDepth, px ) as unknown as F ).toVar();
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
			const air = mix( sky.sampleBackground( normalize( vec3( direction.x, 0.008, direction.z ) ), float( 2 ) ), around, down ).toVar();
			// The key light scattered toward the eye, and its share of the air's light: the rest is
			// the sky's (E / pi, comparable with a radiance).
			const scattered = this.keyColor.rgb.mul( phase( dot( direction, this.keyDir ) ) ).toVar();
			const sunLuma = luminance( scattered );
			const sunShare = sunLuma.div( sunLuma.add( luminance( sky.irradianceNode ) ).add( 1e-5 ) ).toVar();
			If( dw.lessThan( 1 ), () => {

				const water = this.projectionInverse.mul( vec4( ndc.xy, dw, 1 ) ).toVar();
				z.assign( max( z, water.z.div( water.w ) ) );

			} );
			const distance = float( 1e5 ).toVar();
			const hazeDepth = float( 0 ).toVar();
			// The resolved sky sits at -1e5; the sea's skirt reaches tens of kilometres.
			If( z.greaterThan( - 9e4 ), () => {

				distance.assign( length( ray.mul( z.div( ray.z ) ) ) );
				// Integrated from the edge of the protected foreground.
				const start = origin.y.add( direction.y.mul( this.clearDistance ) );
				const d = max( distance.sub( this.clearDistance ), 0 );
				hazeDepth.assign( layerDepth( this.haze.mul( MARINE.share ), float( MARINE.height ), start, direction.y, d )
					.add( layerDepth( this.haze.mul( AEROSOL.share ), float( AEROSOL.height ), start, direction.y, d ) ) );

			} );
			// The near air lies in the clouds' shadow wherever the ground does: the beam it scatters is
			// the one the cloud shadow map lets through, sampled along the near stretch of the ray
			// where the air shows (beyond the protected foreground). The sky's share keeps its
			// light, so a shadowed haze toward a low sun is lit by the sky alone, not by its aureole.
			const reachNear = min( distance, NEAR ).toVar();
			const from = min( this.clearDistance, reachNear ).toVar();
			const shade = sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 1 / 6 ) ) ) )
				.add( sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 0.5 ) ) ) ) )
				.add( sky.cloudVisibility( origin.add( direction.mul( mix( from, reachNear, 5 / 6 ) ) ) ) ).div( 3 ).toVar();
			const beam = scattered.mul( shade ).toVar();
			// Near the camera the sun's share of the light is its explicit, phase-weighted scattering;
			// far away the horizon's colour (whose sun glow already holds it).
			const lit = ( sky: V3, near: F ) => sky.mul( float( 1 ).sub( sunShare.mul( near ) ) ).add( beam.mul( near ) );
			const hazeLight = lit( air, float( 1 ).sub( smoothstep( 0, NEAR, distance ) ) ).toVar();

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
				Loop( FOG_STEPS, ( { i } ) => {

					const u = float( i ).add( 1 ).div( FOG_STEPS );
					const t = reach.mul( mix( u.mul( u ), u, even ) ).toVar();
					const mid = t.add( previous ).mul( 0.5 ).toVar();
					const p = origin.add( direction.mul( mid ) ).toVar();
					// Banks: drifting patches a hundred metres or so across with wisps at their edges,
					// thinner gaps between them; they evolve slowly as they drift.
					const drift = p.xz.add( this.fogOffset ).toVar();
					const bank = smoothstep( 0.2, 0.75, mx_noise_float( vec3( drift.div( 140 ), this.fogTime.mul( 0.006 ) ) ).mul( 0.65 )
						.add( mx_noise_float( vec3( drift.div( 45 ), this.fogTime.mul( 0.015 ).add( 3.7 ) ) ).mul( 0.35 ) ).mul( 0.5 ).add( 0.5 ) ).toVar();
					const clearing = mix( float( CLEARING.floor ), float( 1 ), smoothstep( CLEARING.inner, CLEARING.outer, length( p.xz ) ) );
					const local = exp( max( p.y, 0 ).div( mix( float( FOG_GAP_HEIGHT ), float( FOG_BANK_HEIGHT ), bank ) ).negate() )
						.mul( bank.mul( 1.6 ).add( 0.12 ) ).mul( clearing );
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
			// One medium: the layers' light mixed by their share of the optical depth.
			const total = hazeDepth.add( fogDepth ).toVar();
			const transmittance = exp( total.negate() );
			const light = hazeLight.mul( hazeDepth ).add( fogLight.mul( fogDepth ) ).div( max( total, 1e-6 ) );
			const result = mix( light, color, transmittance );
			return veil ? veil( direction, distance, result ) : result;

		} )();

	}

	update( camera: THREE.Camera, width: number, height: number ): void {

		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.resolution.value.set( width, height );
		// The beam reaching the banks low over the sea.
		this.fogSun.value = this.fogTransmittance( 8, this.keyDir.value );

	}

	/** Transmittance of the fog layer from `height` toward a direction, for the sun's disk. */
	fogTransmittance( height: number, direction: THREE.Vector3 ): number {

		const dy = Math.max( direction.y, 0.02 );
		const { density, height: scale } = FOG_MEAN;
		return Math.exp( - this.fog.value * FOG_EXTINCTION * density * scale * Math.exp( - Math.max( height, 0 ) / scale ) / dy );

	}

}
