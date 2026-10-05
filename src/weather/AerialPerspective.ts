import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, textureLoad, uv, ivec2, vec3, vec4, float, max, min, clamp, length,
	normalize, exp, mix, dot, abs, select, smoothstep, mx_noise_float,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// Sea fog: extinction at sea level per unit of fog, and the layer's scale height (metres).
const FOG_EXTINCTION = 0.0055;
const FOG_HEIGHT = 45;
const FOG_STEPS = 10;
const FOG_REACH = 4000; // metres marched through drifting banks; beyond, the mean layer

/** Distant air and sea fog over the completed opaque/water image. The haze only acts beyond a
 * protected foreground; the fog is a low layer whose density falls with height and drifts in
 * banks with the wind, so it can surround the island and still leave the sky clear above.
 * This pass never changes the refraction source. */
export class AerialPerspective {

	readonly haze = uniform( 0 );
	readonly clearDistance = uniform( 85 );
	readonly fog = uniform( 0 );
	// Wind travel (metres) and slow change of the banks.
	readonly fogOffset = uniform( new THREE.Vector2() );
	readonly fogTime = uniform( 0 );
	// The key light the fog scatters forward: its direction and its irradiance below the clouds
	// (a closed deck leaves no beam to scatter).
	readonly keyDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	readonly keyColor = uniform( new THREE.Color( 0, 0, 0 ) );
	private projectionInverse = uniform( new THREE.Matrix4() );
	private cameraWorld = uniform( new THREE.Matrix4() );
	private resolution = uniform( new THREE.Vector2( 1, 1 ) );

	/** `veil` adds radiance along a view direction in front of content at a given distance. */
	apply( color: V3, depth: THREE.Texture, waterDepth: THREE.Texture, sky: Sky, veil?: ( direction: V3, distance: F ) => V3 ): V3 {

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
			// Distant air takes the sky's colour just above the horizon, so the far sea fades into
			// the horizon itself rather than stopping short of it in a darker band. Looking down, the
			// air is lit by the whole sky; a sharp horizon sample there would spread the horizon's
			// clouds and the sun's glow into rays converging below the camera, so it turns to the
			// horizon's average.
			const down = smoothstep( 0.02, 0.35, direction.y.negate() ).toVar();
			const around = sky.sampleBackground( vec3( 1, 0.06, 0 ), float( 6 ) ).add( sky.sampleBackground( vec3( - 1, 0.06, 0 ), float( 6 ) ) )
				.add( sky.sampleBackground( vec3( 0, 0.06, 1 ), float( 6 ) ) ).add( sky.sampleBackground( vec3( 0, 0.06, - 1 ), float( 6 ) ) ).mul( 0.25 ).toVar();
			const air = mix( sky.sampleBackground( normalize( vec3( direction.x, 0.008, direction.z ) ), float( 2 ) ), around, down ).toVar();
			If( dw.lessThan( 1 ), () => {

				const water = this.projectionInverse.mul( vec4( ndc.xy, dw, 1 ) ).toVar();
				z.assign( max( z, water.z.div( water.w ) ) );

			} );
			const amount = float( 0 ).toVar();
			const distance = float( 1e5 ).toVar();
			// The resolved sky sits at -1e5; the sea's skirt reaches tens of kilometres.
			If( z.greaterThan( - 9e4 ), () => {

				distance.assign( length( ray.mul( z.div( ray.z ) ) ) );
				amount.assign( float( 1 ).sub( exp( max( distance.sub( this.clearDistance ), 0 ).mul( this.haze ).negate() ) ) );

			} );
			const result = mix( color, air, amount ).toVar();

			If( this.fog.greaterThan( 0.001 ), () => {

				const origin = this.cameraWorld.mul( vec4( 0, 0, 0, 1 ) ).xyz.toVar();
				const sigma = this.fog.mul( FOG_EXTINCTION ).toVar();
				// Exponential steps: dense near the camera where banks are resolved, sparse beyond.
				const reach = min( distance, FOG_REACH ).toVar();
				const depth = float( 0 ).toVar();
				const previous = float( 0 ).toVar();
				Loop( FOG_STEPS, ( { i } ) => {

					const u = float( i ).add( 1 ).div( FOG_STEPS );
					const t = reach.mul( u.mul( u ) ).toVar();
					const p = origin.add( direction.mul( t.add( previous ).mul( 0.5 ) ) ).toVar();
					// Banks: drifting patches a couple of hundred metres across with wisps at their edges,
					// thinner gaps between them; they evolve slowly as they drift.
					const drift = p.xz.add( this.fogOffset ).toVar();
					const bank = mx_noise_float( vec3( drift.div( 220 ), this.fogTime.mul( 0.006 ) ) ).mul( 0.7 )
						.add( mx_noise_float( vec3( drift.div( 70 ), this.fogTime.mul( 0.015 ).add( 3.7 ) ) ).mul( 0.3 ) ).mul( 0.5 ).add( 0.5 );
					const local = exp( max( p.y, 0 ).div( - FOG_HEIGHT ) ).mul( smoothstep( 0.2, 0.75, bank ).mul( 1.6 ).add( 0.15 ) );
					depth.addAssign( local.mul( t.sub( previous ) ) );
					previous.assign( t );

				} );
				// Beyond the marched reach, the mean layer integrated analytically along the ray.
				const start = origin.add( direction.mul( reach ) ).toVar();
				const rest = max( distance.sub( reach ), 0 ).toVar();
				const dy = select( abs( direction.y ).lessThan( 1e-4 ), float( 1e-4 ), direction.y );
				const tail = exp( max( start.y, 0 ).div( - FOG_HEIGHT ) ).mul(
					float( 1 ).sub( exp( rest.mul( dy ).div( - FOG_HEIGHT ) ) ) ).mul( FOG_HEIGHT ).div( dy );
				const tailLevel = select( dy.lessThan( 0.002 ).and( dy.greaterThan( - 0.002 ) ), exp( max( start.y, 0 ).div( - FOG_HEIGHT ) ).mul( rest ), tail );
				depth.addAssign( max( tailLevel, 0 ).mul( 0.9 ) );
				const transmittance = exp( depth.mul( sigma ).negate() ).toVar();
				// Fog takes the low sky's light, as the horizon it hides would, so it merges with the sky
				// rather than banding against it; the sample is blurred so the horizon's clouds do not
				// print into the fog, and high enough that the blur stays clear of the sea. It also
				// glows toward the sun (Henyey-Greenstein forward scattering, g = 0.6).
				const low = mix( sky.sampleBackground( normalize( vec3( direction.x, 0.06, direction.z ) ), float( 4 ) ), around, down );
				const cosine = dot( direction, this.keyDir );
				const forward = float( 0.64 ).div( float( 1.36 ).sub( cosine.mul( 1.2 ) ).pow( 1.5 ).mul( 4 * Math.PI ) );
				const light = low.mul( 0.88 ).add( this.keyColor.rgb.mul( forward.mul( 0.22 ).add( 0.008 ) ) );
				result.assign( mix( light, result, transmittance ) );

			} );
			return veil ? result.add( veil( direction, distance ) ) : result;

		} )();

	}

	update( camera: THREE.Camera, width: number, height: number ): void {

		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.resolution.value.set( width, height );

	}

	/** Transmittance of the fog layer from `height` toward a direction, for the sun's disk. */
	fogTransmittance( height: number, direction: THREE.Vector3 ): number {

		const dy = Math.max( direction.y, 0.02 );
		return Math.exp( - this.fog.value * FOG_EXTINCTION * FOG_HEIGHT * Math.exp( - Math.max( height, 0 ) / FOG_HEIGHT ) / dy );

	}

}
