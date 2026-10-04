/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, texture, textureLoad, textureSize, uniform, varying, positionGeometry, positionWorld,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix, screenUV,
	float, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, pow, sqrt, exp, log2,
	sin, abs, floor, fract, fwidth, reflect, select, dFdx, dFdy,
} from 'three/tsl';
import { dirToEquirect } from '../sky/Sky.ts';
import { airToWaterDirectionNode, radianceAcrossInterfaceNode } from '../lighting/OpticalInterface.ts';
import type { Sky } from '../sky/Sky.ts';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import { createFoamTexture, FOAM_TILE } from './FoamTexture.ts';
import type { Shared } from '../shared.ts';
import { solarShadowVisibility, solarVolumeVisibility, volumeShadowRayMayIntersect } from '../lighting/SolarShadow.ts';
import {
	waveSlopeCovariance, waveLodCovariance, waveParameterGradient, waveSurfaceNormal, waveCovarianceToTangent,
	waveLocalDirection, waveBeckmannD, waveSmithVisibility, waveSolarSlopeCovariance, waveReflectionAngularVariance, waveAirFacing,
} from './WaveOptics.ts';
import { RefractedSun, refractedSunDirectionNode, refractedSunBeamScaleNode } from '../lighting/RefractedSun.ts';
import { waterIncidentSun, waterColumnRadiance, waterShadowedColumnRadiance, foamLambertRadiance } from './WaterTransport.ts';

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
//   - foam: FFT-triggered rock contact, transported whitewater thinning into lace,
//     persistent whitecaps from the horizontal displacement Jacobian
// Drawn in a pass of its own after the opaque pass, reading that pass's resolved colour and its
// linear depth; the frame composites it over the opaque image.
//
// Screen conventions (WebGPU): uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
// Texture samples that need screen-space derivatives are taken first, while control flow is still
// uniform; inside branches and loops the shading samples explicit levels or loads texels.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
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

// glitter: one tiny facet per cell, flashing briefly as the swell tips it toward the eye
const sparkles = Fn( ( [ p, t ]: [ V2, F ] ) => {

	const h = hash22( floor( p ) ).toVar();
	const d = length( fract( p ).sub( h.mul( 0.6 ).add( 0.2 ) ) );
	const flash = pow( max( sin( t.mul( h.x.mul( 2.2 ).add( 1.3 ) ).add( h.y.mul( 40 ) ) ), 0 ), 10 );
	return flash.mul( float( 1 ).sub( smoothstep( 0.06, 0.2, d ) ) );

} ).setLayout( { name: 'sparkles', type: 'float', inputs: [ { name: 'p', type: 'vec2' }, { name: 't', type: 'float' } ] } );

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
	shore: THREE.Texture;
	// Transported coverage, material-coordinate offset and fresh rock-contact whitewater.
	foamState: THREE.TextureNode;
	shoreWaves: ShoreWaves;
	refractedSun: RefractedSun;
	sceneColor: THREE.Texture;
	linearDepth: THREE.Texture;
	size?: number;
	res?: number;
}

export class Water {

	mesh: THREE.Mesh;
	material: THREE.NodeMaterial;
	uniforms = {
		backscatter: uniform( 0.038 ),
		roughness: uniform( 0.058 ), // Beckmann alpha: per-axis base slope variance = alpha squared / 2
		wind: uniform( 3.4 ),
		foamAmount: uniform( 1.0 ),
		ssr: uniform( 1 ),
		reflection: uniform( 1 ),
		glitter: uniform( 0 ),
		skyCap: uniform( 0 ),
		sheen: uniform( 0 ),
		shadowMatrix: uniform( new THREE.Matrix4() ),
		shadowOn: uniform( 0 ),
	};

	private shadowTex: THREE.TextureNode;
	private shadowSize = uniform( new THREE.Vector2( 1, 1 ) );
	private shadowSpan = uniform( new THREE.Vector2( 72, 72 ) );
	private shadowDepthRange = uniform( 219 );
	private shadowBias = uniform( 0 );
	private shadowNormalBias = uniform( 0 );
	private shadowIntensity = uniform( 1 );

	constructor( { fft, sky, shared, shore, foamState, shoreWaves, refractedSun, sceneColor, linearDepth, size = 700, res = 320 }: WaterInputs ) {

		// grid in world xz, warped dense under the island and sparse toward the horizon
		const n = res;
		const pos = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 );
		const warp = ( u: number ) => Math.sign( u ) * Math.pow( Math.abs( u ), 2.1 );
		for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

			const k = ( j * ( n + 1 ) + i ) * 3;
			pos[ k ] = warp( i / n * 2 - 1 ) * size / 2;
			pos[ k + 2 ] = warp( j / n * 2 - 1 ) * size / 2;

		}

		const idx = new Uint32Array( n * n * 6 );
		for ( let j = 0, m = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const a = j * ( n + 1 ) + i;
			idx[ m ++ ] = a; idx[ m ++ ] = a + n + 1; idx[ m ++ ] = a + 1;
			idx[ m ++ ] = a + 1; idx[ m ++ ] = a + n + 1; idx[ m ++ ] = a + n + 2;

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( pos, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
		geo.boundingSphere = new THREE.Sphere( new THREE.Vector3(), size );

		const u = this.uniforms;
		const sizes = uniform( new THREE.Vector3( ...fft.sizes ) );
		const disp = fft.displacementTextures, der = fft.derivativeTextures, moments = fft.slopeMomentTextures;
		const whitecapTexture = fft.whitecapTexture;
		const laceTexture = createFoamTexture();

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
		const d = largeDisp.mul( weights.x ).add( mediumDisp.mul( weights.y ) ).add( fineDisp.mul( weights.z ) );
		const material = new THREE.NodeMaterial();
		material.positionNode = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y )
			.add( shoreWaves.surfaceAt( xz.add( d.xz ), shared.time ).x ), xz.y.add( d.z ) );
		const vLag = varying( xz ), vDamp = varying( coastDamp ), vFineWeight = varying( fineWeight );
		const vWeights = varying( weights ), vShelter = varying( windDamp );
		const vLargeDisp = varying( largeDisp ), vMediumDisp = varying( mediumDisp ), vFineDisp = varying( fineDisp );

		// ---- fragment
		const tDepth = texture( linearDepth );
		const depthSize = vec2( textureSize( tDepth ) as unknown as THREE.Node<'ivec2'> );
		const pixel = ( q: V2 ) => ivec2( clamp( q.mul( depthSize ), vec2( 0 ), depthSize.sub( 1 ) ) );
		const sceneViewZ = Fn( ( [ q ]: [ V2 ] ) => textureLoad( tDepth, pixel( q ) ).x )
			.setLayout( { name: 'sceneViewZ', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );
		const sceneAt = ( q: V2 ) => texture( sceneColor, q ).level( float( 0 ) ).rgb;
		const shadowPlaceholder = new THREE.DepthTexture( 1, 1 );
		shadowPlaceholder.compareFunction = THREE.LessEqualCompare;
		this.shadowTex = texture( shadowPlaceholder );
		const shadowSize = this.shadowSize;

		// screen-space reflection of the opaque scene (cliffs, stacks): geometric steps, then bisection
		const traceSSR = Fn( ( [ posV, Rv ]: [ V3, V3 ] ) => {

			const res = vec4( 0 ).toVar();
			// A zero grazing weight cannot contribute a reflection. Reuse the exact fade
			// below rather than marching those rays through the depth buffer.
			const directionWeight = smoothstep( 0.5, 0.1, Rv.z ).toVar();
			If( Rv.z.lessThanEqual( 0.6 ).and( directionWeight.greaterThan( 0 ) ), () => {

				const t = float( 0.15 ).toVar(), dt = float( 0.25 ).toVar(), prevT = float( 0 ).toVar();
				const hit = float( 0 ).toVar();
				Loop( 20, () => {

					prevT.assign( t );
					t.addAssign( dt );
					dt.mulAssign( 1.3 );
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
					const hw = cameraWorldMatrix.mul( vec4( hv, 1 ) ).xyz;
					const edge = smoothstep( 0, 0.06, q.x ).mul( smoothstep( 1, 0.94, q.x ) ).mul( smoothstep( 0, 0.06, q.y ) ).mul( smoothstep( 1, 0.94, q.y ) );
					const w = edge.mul( touch ).mul( directionWeight ).mul( smoothstep( shared.waterLevel.sub( 0.1 ), shared.waterLevel.add( 0.3 ), hw.y ) );
					res.assign( vec4( sceneAt( q ), w ) );

				} );

			} );
			return res;

		} ).setLayout( { name: 'traceSSR', type: 'vec4', inputs: [ { name: 'posV', type: 'vec3' }, { name: 'Rv', type: 'vec3' } ] } );

		// Trace the first visible underwater surface, rather than iterating its height. A
		// height-only solve can jump between shallow rocks and a deeper basin indefinitely.
		const traceRefraction = Fn( ( [ posV, directionV, range, surfaceY, footprint ]: [ V3, V3, F, F, F ] ) => {

			const result = vec4( 0 ).toVar();
			const step = range.div( 8 );
			const near = float( 0 ).toVar(), far = float( 0 ).toVar();
			const found = float( 0 ).toVar();
			Loop( 8, ( { i } ) => {

				const distance = float( i ).add( 1 ).mul( step ).toVar();
				const point = posV.add( directionV.mul( distance ) ).toVar();
				const q = projectView( point, cameraProjectionMatrix ).toVar();
				If( q.x.lessThan( 0.001 ).or( q.x.greaterThan( 0.999 ) ).or( q.y.lessThan( 0.001 ) ).or( q.y.greaterThan( 0.999 ) ).or( point.z.greaterThan( - 0.1 ) ), () => {

					Break();

				} );
				const depth = sceneViewZ( q ).toVar();
				If( point.z.lessThanEqual( depth ), () => {

					far.assign( distance );
					found.assign( 1 );
					Break();

				} );
				near.assign( distance );

			} );
			If( found.greaterThan( 0.5 ), () => {

				Loop( 5, () => {

					const distance = near.add( far ).mul( 0.5 ).toVar();
					const point = posV.add( directionV.mul( distance ) ).toVar();
					If( point.z.lessThanEqual( sceneViewZ( projectView( point, cameraProjectionMatrix ) ) ), () => {

						far.assign( distance );

					} ).Else( () => {

						near.assign( distance );

					} );

				} );
				const point = posV.add( directionV.mul( far ) ).toVar();
				const q = projectView( point, cameraProjectionMatrix ).toVar();
				const ray = viewRay( q, cameraProjectionMatrixInverse ).toVar();
				const visible = ray.mul( sceneViewZ( q ).div( ray.z ) ).toVar();
				const worldHit = cameraWorldMatrix.mul( vec4( visible, 1 ) ).xyz;
				// A depth discontinuity may bracket an occluder instead of an intersection.
				// Such a hit fades to the visible floor, never to an above-water cliff colour.
				const miss = length( visible.sub( point ) );
				const trust = float( 1 ).sub( smoothstep( footprint.mul( 1.5 ).add( 0.08 ), footprint.mul( 3 ).add( 0.35 ), miss ) );
				If( worldHit.y.lessThanEqual( surfaceY.add( 0.05 ) ), () => {

					const edge = smoothstep( 0.001, 0.025, q.x ).mul( smoothstep( 0.999, 0.975, q.x ) )
						.mul( smoothstep( 0.001, 0.025, q.y ) ).mul( smoothstep( 0.999, 0.975, q.y ) );
					result.assign( vec4( q, max( dot( visible.sub( posV ), directionV ), 0 ), trust.mul( edge ) ) );

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
			const foamUV = wp.xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
			const shoreWave = shoreWaves.surfaceAt( wp.xz, time ).toVar();
			const event = foamState.sample( foamUV ).toVar();
			// Fine strands are material detail; the advancing wave decides where they become white.
			const foamP = wp.xz.add( event.gb );
			// Packed cascades retain their original UVs and filtering, leaving texture bindings
			// for both air and submerged shadows within WebGPU's baseline limit.
			const whitecaps = texture( whitecapTexture, vLag.div( sizes.x ) ).r
				.add( texture( whitecapTexture, vLag.div( sizes.y ) ).g )
				.add( texture( whitecapTexture, vLag.div( sizes.z ) ).b.mul( 0.56 ) ).mul( vShelter ).toVar();
			// A dedicated distance-to-strand texture lets coverage change the shape: dense
			// churn opens into perforated mats, lace and separate bubbles, not fading moss noise.
			const laceSample = texture( laceTexture, foamP.mul( 1.5 / FOAM_TILE ) ).toVar();
			const lumps = texture( laceTexture, foamP.div( FOAM_TILE * 2.2 ).add( vec2( 0.17, 0.39 ) ) ).toVar();
			const foamRelief = float( 1 ).sub( lumps.r ).mul( 0.65 ).add( float( 1 ).sub( laceSample.r ).mul( 0.35 ) ).toVar();
			const reliefSlope = vec2(
				texture( laceTexture, foamP.add( vec2( 0.04, 0 ) ).div( FOAM_TILE * 2.2 ).add( vec2( 0.17, 0.39 ) ) ).r.sub( lumps.r ).div( 0.04 ),
				texture( laceTexture, foamP.add( vec2( 0, 0.04 ) ).div( FOAM_TILE * 2.2 ).add( vec2( 0.17, 0.39 ) ) ).r.sub( lumps.r ).div( 0.04 ),
			).toVar();
			// Share lace density with the optional glitter control to stay within WebGPU's
			// baseline 16 sampled textures, including slope moments and the packed whitecaps.
			const fLow = lumps.b;
			const footprint = max( length( fwidth( vLag ) ), 1e-4 ).toVar();

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
			const N = waveSurfaceNormal( heightGradient, horizontal ).toVar();
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
			// standard materials. Keep comparison sampling outside pixel-dependent branches.
			const sc = u.shadowMatrix.mul( vec4( wp.add( N.mul( this.shadowNormalBias ) ), 1 ) ).toVar();
			const s3 = sc.xyz.div( max( sc.w, 1e-6 ) ).toVar();
			const shadowCoord = vec3( s3.x, float( 1 ).sub( s3.y ), s3.z.add( this.shadowBias ) );
			const visibility = solarShadowVisibility( this.shadowTex, shadowCoord, {
				mapSize: shadowSize, worldSpan: this.shadowSpan, depthRange: this.shadowDepthRange,
			} );
			const shadow = mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) ).toVar();
			const sunLight = shared.sunColor.mul( shadow ).toVar();

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -1e4 = sky)
			const z0 = sceneViewZ( screenUV ).toVar();
			const skyBehind = z0.lessThan( - 1e4 );
			const ray0 = viewRay( screenUV, cameraProjectionMatrixInverse ).toVar();
			const sv0 = ray0.mul( z0.div( ray0.z ) ).toVar();
			const sw0 = cameraWorldMatrix.mul( vec4( sv0, 1 ) ).xyz.toVar();
			const thick = select( skyBehind, float( 1e4 ), posV.z.sub( sv0.z ) ).toVar(); // view distance from the surface to whatever is behind it

			// ---- shoreline and foam
			// Tidewater's SurfFoam density mapping: a fresh bubbly core, then wider holes,
			// finally translucent strands. The irregular edge belongs to the moving mass.
			const coverage = sat( event.r );
			const fresh = sat( event.a.mul( 1.35 ) );
			const width = pow( coverage, 1.3 ).mul( 0.9 ).mul( laceSample.b.mul( 0.5 ).add( 0.75 ) );
			const soft = footprint.mul( 2 ).add( 0.035 );
			const mat = float( 1 ).sub( smoothstep( width.sub( soft ), width.add( soft ), laceSample.r ) )
				.mul( smoothstep( 0.005, 0.06, coverage ) );
			const inner = sat( width.sub( laceSample.r ).div( 0.25 ) );
			const strandOpacity = inner.mul( 0.35 ).add( laceSample.b.mul( 0.3 ) ).add( 0.4 );
			const bubbles = laceSample.g.mul( smoothstep( width.add( 0.25 ), width, laceSample.r ) ).mul( smoothstep( 0.03, 0.2, coverage ) ).mul( 0.4 );
			const pop = smoothstep( 0.015, 0.11, coverage.sub( laceSample.a.mul( 0.17 ) ) );
			const foamLace = max( mat.mul( strandOpacity ), bubbles ).mul( pop );
			const raggedCore = smoothstep( 0.16, 0.68, fresh.sub( laceSample.r.mul( 0.32 ) ).sub( lumps.r.mul( 0.42 ) ) );
			const churn = raggedCore.mul( 0.84 ).add( fresh.mul( 0.16 ) ).mul( laceSample.b.mul( 0.12 ).add( 0.88 ) );
			const nearFoam = max( foamLace, churn );
			const farFoam = max( pow( width, 1.45 ).mul( 1.8 ).min( 1 ).mul( 0.75 ).mul( pop ), fresh.mul( 0.82 ) );
			const foamAmt = mix( nearFoam, farFoam, smoothstep( 0.07, 0.2, footprint ) ).mul( smoothstep( 0.02, 0.12, thick ) ).toVar();
			const foamBounds = smoothstep( 0, 0.015, foamUV.x ).mul( smoothstep( 1, 0.985, foamUV.x ) )
				.mul( smoothstep( 0, 0.015, foamUV.y ) ).mul( smoothstep( 1, 0.985, foamUV.y ) );
			foamAmt.mulAssign( foamBounds );
			foamAmt.assign( max( foamAmt, whitecaps.mul( float( 1 ).sub( laceSample.r ) ).mul( 0.65 ) ) );
			foamAmt.assign( sat( foamAmt.mul( u.foamAmount ) ) );

			// ---- roughness: measured unresolved spectrum plus a constant microscopic slope width
			// Beckmann alpha squared is twice each Gaussian slope variance; no GGX moment mapping.
			const baseVariance = u.roughness.mul( u.roughness ).mul( 0.5 ).add( foamAmt.mul( 0.1 ) );
			const seaCovariance = unresolvedCovariance.add( vec3( baseVariance, baseVariance, 0 ) ).toVar();
			const localL = waveLocalDirection( L, N ).toVar(), localV = waveLocalDirection( V, N ).toVar();

			const airFacing = waveAirFacing( N, V ).toVar();
			const NdV = max( dot( N, V ), 1e-4 ).toVar();
			const Fr = fresnelDielectric( NdV, float( IOR ) ).mul( airFacing ).toVar();

			// ---- reflection
			const Rr = reflect( V.negate(), N ).toVar();
			// An isotropic mip is an approximation to the anisotropic reflected Gaussian.
			// Match its angular variance to a box mip kernel, keeping the reflection direction intact.
			const reflectionSigma = sqrt( waveReflectionAngularVariance( localV, seaCovariance ) );
			const skyMip = clamp( log2( max( reflectionSigma.mul( Math.sqrt( 12 ) * sky.equirect.height / PI ), 1 ) ),
				0, Math.log2( sky.equirect.height ) );
			const refl = texture( sky.equirect.texture, dirToEquirect( Rr ) ).level( skyMip ).rgb.toVar();
			refl.mulAssign( u.reflection );
			// Optional art control. Zero preserves the calibrated incident sky radiance.
			const lr = lum( refl ).toVar();
			const cap = lum( shared.skyIrradiance ).mul( u.skyCap ).toVar();
			If( u.skyCap.greaterThan( 0 ).and( lr.greaterThan( cap ) ), () => {

				refl.mulAssign( cap.add( lr.sub( cap ).mul( 0.12 ) ).div( lr ) );

			} );
			If( u.ssr.greaterThan( 0.5 ).and( Fr.greaterThan( 0.01 ) ), () => {

				const Rv = normalize( cameraViewMatrix.mul( vec4( Rr, 0 ) ).xyz );
				const r = traceSSR( posV, Rv ).toVar();
				refl.assign( mix( refl, r.rgb, r.a ) );

			} );

			// ---- sun glint
			const H = normalize( L.add( V ) );
			const NdL = max( dot( N, L ), 0 ).toVar();
			const VdH = max( dot( V, H ), 0 );
			const localH = waveLocalDirection( H, N ).toVar();
			const sunCovariance = seaCovariance.add( waveSolarSlopeCovariance( localL, localV ) );
			const spec = waveBeckmannD( localH, sunCovariance ).mul( waveSmithVisibility( localL, localV, seaCovariance ) )
				.mul( fresnelDielectric( VdH, float( IOR ) ) ).mul( NdL );
			const sunSpec = sunLight.mul( spec ).toVar();
			// Optional artistic lobes add energy beyond the physical microfacet reflection.
			// Both default to zero; the simulated slopes already generate the sun glitter.
			// Uniform branches avoid hashing and extra lobes when their art controls are off.
			// Derivative-dependent foam samples above remain outside all branches.
			If( u.sheen.greaterThan( 0 ).or( u.glitter.greaterThan( 0 ) ), () => {

				const reflectionBudget = fresnelDielectric( VdH, float( IOR ) ).mul( NdL ).toVar();
				const Hf = normalize( L.add( V ) ).toVar(); // half vector of a flat sea
				If( u.sheen.greaterThan( 0 ), () => {

					const sheen = D_GGX( Hf.y, float( 0.06 ) ).mul( 0.06 * PI );
					sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( sheen ).mul( u.sheen ).mul( float( 1 ).sub( foamAmt ) ) );

				} );
				If( u.glitter.greaterThan( 0 ), () => {

					const wide = D_GGX( Hf.y, float( 0.12 ) ).mul( 0.12 * PI );
					const NdH = max( dot( N, H ), 0 );
					const facet = D_GGX( NdH, float( 0.012 ) ).mul( 0.012 * PI );
					const glintPath = smoothstep( 0.13, 0.8, wide ).mul( smoothstep( 0.42, 0.63, fLow ) );
					sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( glintPath ).mul( facet ).mul( sparkles( wp.xz.mul( 2.1 ).add( N.xz.mul( 2.5 ) ), time ) ).mul( u.glitter ).mul( float( 1 ).sub( foamAmt ) ) );

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
			If( skyBehind.not().and( thick.greaterThan( 0.02 ) ).and( validRefraction ), () => {

				const directionV = normalize( cameraViewMatrix.mul( vec4( Tv, 0 ) ).xyz );
				const range = min( max( fallbackLength.mul( 1.5 ), fallbackLength.add( 4 ) ), 40 );
				hit.assign( traceRefraction( posV, directionV, range, wp.y, footprint ) );

			} );
			const refractionTrust = hit.w;
			const pathLen = mix( fallbackLength, hit.z, refractionTrust ).toVar();

			// ---- the water body: absorption along the path + single scattering of sun and sky
			const sigA = shared.sigA, sigS = shared.sigS;
			const sigT = sigA.add( sigS ).toVar();
			const Ls = refractedSunDirectionNode( L ).toVar();
			const muS = Ls.y;
			const muV = max( Tv.y.negate(), 1e-5 );
			// Each source retains its own optical depth while confidence blends the hits.
			// One mixed path would tint a bright shallow source as if it belonged to the basin.
			const opaqueCol = sceneAt( screenUV ).toVar();
			const bottom = opaqueCol.mul( exp( sigT.negate().mul( fallbackLength ) ) ).toVar();
			// Failed/off-screen rays use only the original floor. Their zero confidence makes
			// the three blurred colour samples and refracted attenuation redundant.
			If( refractionTrust.greaterThan( 0 ), () => {

				const uvR = hit.xy;
				// Unresolved slopes soften deeper refraction while near-surface rocks stay legible.
				const refractBlur = min( pathLen.mul( 0.28 ), 1.8 ).div( depthSize );
				const refractedCol = sceneAt( uvR ).mul( 0.5 )
					.add( sceneAt( clamp( uvR.add( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) )
					.add( sceneAt( clamp( uvR.sub( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) );
				bottom.assign( mix( bottom, refractedCol.mul( exp( sigT.negate().mul( hit.z ) ) ), refractionTrust ) );

			} );
			// Match the terrain's refracted beam: transmission retains horizontal power,
			// while beam-normal irradiance changes with the Snell area projection.
			// Surface glint and foam retain their own shadow. A scattering point deeper along
			// the view ray can enter or leave the island's shadow independently of that surface.
			const sunIn = waterIncidentSun( shared.sunColor, float( 1 ), shared.sunIntoWater, refractedSunBeamScaleNode( L ) );
			const kSun = sigT.mul( muV.div( muS ).add( 1 ) ).toVar();
			const kAmb = sigT.mul( muV.div( 0.75 ).add( 1 ) ).toVar();
			const ph = phaseHG( dot( Tv, Ls ), float( 0.86 ) ).mul( 0.7 ).add( 0.3 / ( 4 * PI ) );
			const bb = sigS.mul( u.backscatter );
			const albedoMS = bb.mul( 0.33 * 4 ).div( sigA.add( bb ) ).toVar();
			// The MS source remains an empirical backscatter boost, not a conserved GI model.
			const solarSource = sunIn.mul( sigS.mul( ph ).add( albedoMS.mul( sigT ).div( PI ) ) );
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

					const visibility = solarVolumeVisibility( this.shadowTex, airCoordinate( distance ), shadowSize ).toVar();
					If( visibility.greaterThan( 0 ).and( columnDepth( distance ).greaterThan( 0 ) ), () => {

						const coordinate = mix( wetStart, wetEnd, distance.div( max( pathLen, 1e-5 ) ) );
						visibility.mulAssign( refractedSun.submergedVolumeVisibilityAtCoordinateNode( coordinate ) );

					} );
					return mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) );

				} ) );

			} );
			const inAmb = waterColumnRadiance( shared.skyIrradiance.mul( sigS.mul( 0.25 ).add( albedoMS.mul( sigT ) ) ), kAmb, pathLen );
			// sun shining through the thin crests of the waves
			const vH = normalize( V.xz.add( 1e-5 ) ), lH = normalize( L.xz.add( 1e-5 ) );
			const back = pow( sat( dot( vH, lH.negate() ).mul( 0.6 ).add( 0.4 ) ), 2.5 );
			const crest = sat( wp.y.sub( shared.waterLevel ).mul( 4 ).add( 0.2 ) ).mul( sat( float( 1 ).sub( N.y ).mul( 6 ) ).add( 0.2 ) );
			const sss = sunLight.mul( vec3( 0.12, 0.55, 0.45 ) ).mul( back.mul( crest ).mul( 0.035 ) );
			const transmitted = bottom.add( inSun ).add( inAmb ).add( sss );

			// ---- foam: Lambert diffuse scatterer with a 95% hemispheric reflectance
			// The shared sky value stores E_sky / PI; convert explicitly to irradiance.
			const skyE = shared.skyIrradiance.mul( PI );
			// Bubble relief and cavities shape the existing bounded diffuse response.
			const foamNormal = normalize( N.add( vec3( reliefSlope.x, 0, reliefSlope.y ).mul( fresh ).mul( 0.035 ) ) );
			const foamNdL = max( dot( foamNormal, L ), 0 );
			const cavity = mix( float( 1 ), pow( foamRelief, 1.6 ).mul( 0.65 ).add( 0.35 ), fresh );
			const foamCol = foamLambertRadiance( sunLight, skyE, foamNdL, float( 0.95 ) ).mul( cavity );

			// The opaque underwater pass and column terms are radiance inside water. Convert
			// that radiance once at the exit interface; mix already supplies Fresnel 1 - Fr.
			const exiting = radianceAcrossInterfaceNode( transmitted, float( IOR ), float( 1 ) );
			const water = mix( exiting, refl, Fr ).add( sunSpec );
			// Backfacing facets are self-occluded: neither the air reflection nor underwater
			// transmission emerges through their back side. Neighbor-wave transport is unresolved.
			const col = mix( water, foamCol, foamAmt ).mul( airFacing ).toVar();

			// soften the line where the surface cuts the rock (no hard seam); behind rock: the rock
			const edge = select( skyBehind, float( 1 ), smoothstep( 0, 0.06, thick ) );
			col.assign( mix( opaqueCol, col, edge ) );
			return vec4( min( col, vec3( 30000 ) ), 1 );

		} )();
		material.side = THREE.DoubleSide;
		this.material = material;
		this.mesh = new THREE.Mesh( geo, material );
		this.mesh.frustumCulled = false;
		this.mesh.name = 'water';

	}

	// per frame, before the water draw
	prepare( sun: THREE.DirectionalLight ): void {

		const u = this.uniforms;
		const map = sun.shadow.map as ( THREE.RenderTarget | null );
		if ( sun.castShadow && map && map.depthTexture ) {

			this.shadowTex.value = map.depthTexture;
			this.shadowSize.value.set( map.width, map.height );
			const camera = sun.shadow.camera;
			this.shadowSpan.value.set( camera.right - camera.left, camera.top - camera.bottom );
			this.shadowDepthRange.value = camera.far - camera.near;
			this.shadowBias.value = sun.shadow.bias;
			this.shadowNormalBias.value = sun.shadow.normalBias;
			this.shadowIntensity.value = sun.shadow.intensity;
			u.shadowMatrix.value.copy( sun.shadow.matrix );
			u.shadowOn.value = 1;

		} else u.shadowOn.value = 0;

	}

}
