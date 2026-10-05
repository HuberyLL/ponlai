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
	Fn, If, Loop, Break, texture, textureLoad, textureSize, uniform, varying, positionGeometry, positionWorld,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix, screenUV,
	float, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, pow, sqrt, exp, log2,
	sin, abs, floor, fract, fwidth, reflect, select, dFdx, dFdy,
	mx_noise_float,
} from 'three/tsl';
import { airToWaterDirectionNode, radianceAcrossInterfaceNode } from '../lighting/OpticalInterface.ts';
import type { Sky } from '../sky/Sky.ts';
import type { OceanFFT } from './OceanFFT.ts';
import type { ShoreWaves } from './ShoreWaves.ts';
import { createGlitterMask, GLITTER_TILE } from './GlitterMask.ts';
import type { Shared } from '../shared.ts';
import { solarShadowVisibility, solarVolumeVisibility, volumeShadowRayMayIntersect } from '../lighting/SolarShadow.ts';
import {
	waveSlopeCovariance, waveLodCovariance, waveParameterGradient, waveSurfaceNormal, waveCovarianceToTangent,
	waveLocalDirection, waveBeckmannD, waveSmithVisibility, waveSolarSlopeCovariance, waveReflectionAngularVariance, waveAirFacing,
} from './WaveOptics.ts';
import { RefractedSun, refractedSunDirectionNode, refractedSunBeamScaleNode } from '../lighting/RefractedSun.ts';
import { waterIncidentSun, waterColumnRadiance, waterShadowedColumnRadiance } from './WaterTransport.ts';
import { rainRippleGradient } from '../weather/Rain.ts';

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

// The sea continues to this distance (metres), well past the horizon for any review camera.
const SKIRT_RADIUS = 40000;

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

	constructor( { fft, sky, shared, shore, shoreWaves, refractedSun, sceneColor, linearDepth, size = 700, res = 320 }: WaterInputs ) {

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

		const u = this.uniforms;
		const sizes = uniform( new THREE.Vector3( ...fft.sizes ) );
		const disp = fft.displacementTextures, der = fft.derivativeTextures, moments = fft.slopeMomentTextures;
		const glitterMask = createGlitterMask();

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
		material.positionNode = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y )
			.add( shoreWaves.surfaceAt( xz.add( d.xz ), shared.time ).x ), xz.y.add( d.z ) );
		const vLag = varying( xz ), vDamp = varying( coastDamp ), vFineWeight = varying( fineWeight );
		const vWeights = varying( weights );
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
			const shoreWave = shoreWaves.surfaceAt( wp.xz, time ).toVar();
			// Patches for the optional glitter lobe, sampled here while control flow is uniform.
			const fLow = texture( glitterMask, wp.xz.div( GLITTER_TILE ).add( vec2( 0.17, 0.39 ) ) ).r.toVar();
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
			// standard materials. Keep comparison sampling outside pixel-dependent branches.
			const sc = u.shadowMatrix.mul( vec4( wp.add( N.mul( this.shadowNormalBias ) ), 1 ) ).toVar();
			const s3 = sc.xyz.div( max( sc.w, 1e-6 ) ).toVar();
			const shadowCoord = vec3( s3.x, float( 1 ).sub( s3.y ), s3.z.add( this.shadowBias ) );
			const visibility = solarShadowVisibility( this.shadowTex, shadowCoord, {
				mapSize: shadowSize, worldSpan: this.shadowSpan, depthRange: this.shadowDepthRange,
			} );
			const shadow = mix( float( 1 ), visibility, this.shadowIntensity.mul( u.shadowOn ) ).toVar();
			const cloudTransmission = sky.cloudVisibility( wp ).toVar();
			const sunLight = shared.sunColor.mul( shadow ).mul( cloudTransmission ).toVar();

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -9e4 = sky)
			const z0 = sceneViewZ( screenUV ).toVar();
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
			const sunSpec = sunLight.mul( spec ).mul( shared.glintScale ).toVar();
			// Optional artistic lobes add energy beyond the physical microfacet reflection.
			// Both default to zero; the simulated slopes already generate the sun glitter.
			// Uniform branches avoid hashing and extra lobes when their art controls are off.
			// The derivative-dependent glitter mask above stays outside all branches.
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
			// Surface glint retains its own shadow. A scattering point deeper along
			// the view ray can enter or leave the island's shadow independently of that surface.
			const sunIn = waterIncidentSun( shared.sunColor, cloudTransmission, shared.sunIntoWater, refractedSunBeamScaleNode( L ) );
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
			// Whitecaps in a storm: crests whose horizontal Jacobian folds below a threshold are
			// breaking (Tessendorf's choppy-wave criterion), streaked by the wind and broken up.
			If( shared.storm.greaterThan( 0.001 ), () => {

				const fold = horizontal.x.mul( horizontal.w ).sub( horizontal.y.mul( horizontal.z ) );
				// This calm, gently choppy sea rarely folds far: compress the threshold toward 1.
				const crest = mix( float( 0.78 ), float( 0.88 ), shared.storm );
				const breaking = float( 1 ).sub( smoothstep( crest.sub( 0.06 ), crest, fold ) );
				const streak = mx_noise_float( vec3( wp.xz.mul( vec2( 0.9, 0.35 ) ), time.mul( 0.3 ) ) ).mul( 0.5 ).add( 0.5 );
				const foam = clamp( breaking.mul( smoothstep( 0.25, 0.65, streak ).mul( 0.8 ).add( 0.2 ) ).mul( shared.storm ), 0, 0.95 );
				// Diffuse white lit by the sky and the sun, like the island's surfaces; aerated water
				// scatters strongly, so it reads brighter than the sky's mean radiance.
				const lit = shared.skyIrradianceSource.mul( 3 / PI ).add( sunLight.mul( max( N.y, 0 ) ).mul( 0.85 / PI ) );
				col.assign( mix( col, lit, foam.mul( airFacing ) ) );

			} );

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
