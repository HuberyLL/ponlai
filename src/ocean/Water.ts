/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, Break, texture, textureLoad, textureSize, uniform, varying, positionGeometry, positionWorld,
	cameraPosition, cameraViewMatrix, cameraProjectionMatrix, cameraProjectionMatrixInverse, cameraWorldMatrix, screenUV,
	float, int, ivec2, vec2, vec3, vec4, mix, smoothstep, clamp, length, normalize, dot, max, min, pow, sqrt, exp, log2,
	sin, abs, floor, fract, fwidth, reflect, refract, select,
} from 'three/tsl';
import { dirToEquirect } from '../sky/Sky.ts';
import type { Sky } from '../sky/Sky.ts';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';

// The sea surface: an FFT-displaced grid with custom shading after tidewater's WaterMaterial
// (above-water branch):
//   - exact dielectric Fresnel, GGX sun glint shadowed by the island, roughness from the slope
//     variance the mesh can't resolve at this pixel's footprint (Cox-Munk)
//   - refraction: the refracted view ray is traced to the floor through the opaque pass's linear
//     depth (bounded steps and bisection), the scene behind is sampled where it lands
//   - water volume: Beer-Lambert absorption along the refracted path plus analytic single
//     scattering of the sun (Henyey-Greenstein) and the sky, multiple-scatter backscatter boost
//   - reflection: baked sky (glare softly capped) + screen-space reflection of cliffs and stacks
//   - stylised sun: a broad sheen toward the sun, glints riding the wave facets
//   - foam: a broken surf line at the rock, lace, whitecaps from the Jacobian
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

const V_SmithGGX = Fn( ( [ NdL, NdV, a2 ]: [ F, F, F ] ) => {

	const gv = NdL.mul( sqrt( NdV.mul( NdV ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	const gl = NdV.mul( sqrt( NdL.mul( NdL ).mul( float( 1 ).sub( a2 ) ).add( a2 ) ) );
	return float( 0.5 ).div( max( gv.add( gl ), 1e-5 ) );

} ).setLayout( { name: 'V_SmithGGX', type: 'float', inputs: [ { name: 'NdL', type: 'float' }, { name: 'NdV', type: 'float' }, { name: 'a2', type: 'float' } ] } );

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
	// Main island only, signed metres at sea level; shares shore's world bounds/xform.
	islandShore?: THREE.Texture;
	foam: THREE.Texture;
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
		roughness: uniform( 0.058 ),
		wind: uniform( 3.4 ),
		foamAmount: uniform( 1.0 ),
		ssr: uniform( 1 ),
		reflection: uniform( 1 ),
		glitter: uniform( 3.1 ),
		skyCap: uniform( 2.2 ),
		detail: uniform( 0.8 ), // the small cascades' share of the shading normal (glassier < 1)
		sheen: uniform( 0.025 ),
		shadowMatrix: uniform( new THREE.Matrix4() ),
		shadowOn: uniform( 0 ),
	};

	private shadowTex: THREE.TextureNode;
	private shadowSize = uniform( new THREE.Vector2( 1, 1 ) );

	constructor( { fft, sky, shared, shore, islandShore, foam, sceneColor, linearDepth, size = 700, res = 320 }: WaterInputs ) {

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
		const disp = fft.displacementTextures, der = fft.derivativeTextures;

		// ---- vertex: displace the grid by the three cascades (the finest fades out far away). The
		// undisplaced grid point comes from the geometry: once positionNode is set, positionLocal
		// reads the displaced position.
		const xz = positionGeometry.xz;
		const sd = texture( shore, xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ).r;
		// sheltered water right against the rock is calmer
		const damp = mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) );
		const far = length( xz.sub( cameraPosition.xz ) );
		const d = texture( disp[ 0 ], xz.div( sizes.x ) ).level( float( 0 ) ).xyz
			.add( texture( disp[ 1 ], xz.div( sizes.y ) ).level( float( 0 ) ).xyz )
			.add( texture( disp[ 2 ], xz.div( sizes.z ) ).level( float( 0 ) ).xyz.mul( float( 1 ).sub( smoothstep( 60, 140, far ) ) ) )
			.mul( damp );
		const material = new THREE.NodeMaterial();
		material.positionNode = vec3( xz.x.add( d.x ), shared.waterLevel.add( d.y ), xz.y.add( d.z ) );
		const vLag = varying( xz ), vDamp = varying( damp );

		// ---- fragment
		const tDepth = texture( linearDepth );
		const depthSize = vec2( textureSize( tDepth ) as unknown as THREE.Node<'ivec2'> );
		const pixel = ( q: V2 ) => ivec2( clamp( q.mul( depthSize ), vec2( 0 ), depthSize.sub( 1 ) ) );
		const sceneViewZ = Fn( ( [ q ]: [ V2 ] ) => textureLoad( tDepth, pixel( q ) ).x )
			.setLayout( { name: 'sceneViewZ', type: 'float', inputs: [ { name: 'q', type: 'vec2' } ] } );
		const sceneAt = ( q: V2 ) => texture( sceneColor, q ).level( float( 0 ) ).rgb;
		this.shadowTex = texture( new THREE.DepthTexture( 1, 1 ) );
		const shadowSize = this.shadowSize;

		// screen-space reflection of the opaque scene (cliffs, stacks): geometric steps, then bisection
		const traceSSR = Fn( ( [ posV, Rv ]: [ V3, V3 ] ) => {

			const res = vec4( 0 ).toVar();
			If( Rv.z.lessThanEqual( 0.6 ), () => {

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
					const w = edge.mul( touch ).mul( smoothstep( 0.5, 0.1, Rv.z ) ).mul( smoothstep( shared.waterLevel.sub( 0.1 ), shared.waterLevel.add( 0.3 ), hw.y ) );
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
			// Preserve the broad swell, but let the finest capillary ripples act as polish rather
			// than a uniform etched pattern over the entire sea.
			const dd0 = texture( der[ 0 ], vLag.div( sizes.x ) )
				.add( texture( der[ 1 ], vLag.div( sizes.y ) ).add( texture( der[ 2 ], vLag.div( sizes.z ) ).mul( 0.56 ) ).mul( u.detail ) ).toVar();
			const fuv = wp.xz.mul( 0.14 );
			const fA = texture( foam, fuv.add( vec2( time.mul( 0.013 ), time.mul( 0.008 ) ) ) ).g.toVar();
			const fB = texture( foam, fuv.mul( 1.9 ).sub( vec2( time.mul( 0.017 ), time.mul( - 0.011 ) ) ) ).g.toVar();
			// Alpha stores sparse lichen spots, not a continuous noise field. Using the height
			// channel here gives the wash a proper low-frequency envelope and quiet intervals.
			const fLow = texture( foam, wp.xz.mul( 0.045 ).add( time.mul( 0.002 ) ) ).r.toVar();
			const fLow2 = texture( foam, wp.zx.mul( 0.11 ).sub( time.mul( 0.006 ) ) ).g.toVar();
			const fChurn = texture( foam, wp.xz.mul( 0.018 ).add( vec2( time.mul( 0.004 ), 0 ) ) ).r.toVar();
			const footprint = max( length( fwidth( vLag ) ), 1e-4 ).toVar();

			// ---- surface normal from the cascades' slopes (sampled at the undisplaced position)
			const dd = dd0.mul( vDamp ).toVar();
			const slope = vec2( dd.x.div( max( dd.z.add( 1 ), 0.2 ) ), dd.y.div( max( dd.w.add( 1 ), 0.2 ) ) );
			const N = normalize( vec3( slope.x.negate(), 1, slope.y.negate() ) ).toVar();
			const jac = dd.z.add( 1 ).mul( dd.w.add( 1 ) ).toVar();

			const toCam = cameraPosition.sub( wp ).toVar();
			const V = toCam.div( length( toCam ) ).toVar();
			const L = shared.sunDir;
			const posV = cameraViewMatrix.mul( vec4( wp, 1 ) ).xyz.toVar();

			// keep facets that face away from the viewer at grazing instead of flipping them
			N.assign( normalize( N.add( V.mul( max( dot( N, V ).negate().add( 0.03 ), 0 ) ) ) ) );

			// ---- the sun's shadow on the water (3x3 taps)
			const shadow = float( 1 ).toVar();
			If( u.shadowOn.greaterThan( 0.5 ), () => {

				const sc = u.shadowMatrix.mul( vec4( wp, 1 ) ).toVar();
				const s3 = sc.xyz.div( sc.w ).toVar();
				const suvS = vec2( s3.x, float( 1 ).sub( s3.y ) ).toVar();
				If( suvS.x.greaterThan( 0 ).and( suvS.y.greaterThan( 0 ) ).and( suvS.x.lessThan( 1 ) ).and( suvS.y.lessThan( 1 ) ).and( s3.z.lessThan( 1 ) ), () => {

					const s = float( 0 ).toVar();
					Loop( { start: int( - 1 ), end: int( 1 ), condition: '<=' }, { start: int( - 1 ), end: int( 1 ), condition: '<=' }, ( { i: y, j: x } ) => {

						const c = ivec2( clamp( suvS.mul( shadowSize ).add( vec2( float( x ), float( y ) ).mul( 2.5 ) ), vec2( 0 ), shadowSize.sub( 1 ) ) );
						const stored = textureLoad( this.shadowTex, c ) as unknown as F; // a depth texture: one channel
						s.addAssign( select( s3.z.sub( 0.0008 ).lessThanEqual( stored ), float( 1 ), float( 0 ) ) );

					} );
					shadow.assign( s.div( 9 ) );

				} );

			} );
			const sunLight = shared.sunColor.mul( shadow ).toVar();

			// ---- what lies straight behind this pixel (linear depth: view-space z, < -1e4 = sky)
			const z0 = sceneViewZ( screenUV ).toVar();
			const skyBehind = z0.lessThan( - 1e4 );
			const ray0 = viewRay( screenUV, cameraProjectionMatrixInverse ).toVar();
			const sv0 = ray0.mul( z0.div( ray0.z ) ).toVar();
			const sw0 = cameraWorldMatrix.mul( vec4( sv0, 1 ) ).xyz.toVar();
			const thick = select( skyBehind, float( 1e4 ), posV.z.sub( sv0.z ) ).toVar(); // view distance from the surface to whatever is behind it

			// ---- shoreline and foam
			const sd = texture( shore, wp.xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ).r.toVar();
			const bubbles = fA.mul( 0.6 ).add( fB.mul( 0.4 ) ).toVar();
			// Wash moves away from the wall in narrow filaments. Filling a depth-intersection
			// band paints an unbroken luminous collar around every rock, so the actual contact
			// stays transparent and the outgoing traces fade before a new surge begins.
			const wash = fract( time.mul( 0.16 ).add( fLow.mul( 2.5 ) ).add( wp.x.mul( 0.025 ) ).sub( wp.z.mul( 0.018 ) ) ).toVar();
			const surge = sin( wash.mul( PI ) ).toVar();
			const sdJ = sd.add( fLow2.sub( 0.4 ).mul( 0.42 ) ).add( bubbles.sub( 0.4 ).mul( 0.18 ) );
			const lead = wash.mul( 1.25 ).add( 0.2 );
			const width = footprint.mul( 0.32 ).add( 0.025 );
			const front = float( 1 ).sub( smoothstep( width, width.add( 0.065 ), abs( sdJ.sub( lead ) ) ) );
			const tail = float( 1 ).sub( smoothstep( width.mul( 0.7 ), width.add( 0.045 ), abs( sdJ.sub( lead.mul( 0.53 ).add( 0.16 ) ) ) ) );
			const arcs = smoothstep( 0.22, 0.67, sin( wp.x.mul( 0.8 ).add( wp.z.mul( 0.56 ) ).add( fChurn.mul( 15 ) ).add( time.mul( 0.23 ) ) ) );
			const threads = float( 1 ).sub( smoothstep( 0.035, 0.095, abs( bubbles.sub( 0.43 ) ) ) );
			const detached = smoothstep( 0.08, 0.22, sd ).mul( smoothstep( 0.03, 0.18, thick ) );
			// No constant coverage underneath the lace: gaps must reach clear water, otherwise
			// even a faint remainder reads as a drawn arc around a small rock.
			const fragments = threads.mul( smoothstep( 0.3, 0.5, fA ) );
			const lace = max( front.mul( fragments ).mul( 0.44 ), tail.mul( fragments ).mul( 0.23 ) );
			const foamAmt = lace.mul( surge ).mul( arcs ).mul( detached ).mul( 0.6 ).toVar();
			// The inhabited reef carries the wash; isolated sea stacks stay clear of collars.
			// Its own coarse distance field lets us add broken foam at the main cliff foot
			// without catching nearby stacks or imposing a rectangular island approximation.
			const islandSD = islandShore ? texture( islandShore, wp.xz.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ).r : float( 1e4 );
			const reefDistance = islandSD.add( fLow2.sub( 0.4 ).mul( 0.35 ) ).sub( surge.mul( 0.12 ) );
			const reefBand = float( 1 ).sub( smoothstep( 0.04, surge.mul( 0.28 ).add( 0.4 ), abs( reefDistance ) ) );
			const reefPatch = smoothstep( 0.24, 0.62, sin( wp.x.mul( 1.2 ).sub( wp.z.mul( 0.9 ) ).add( fLow.mul( 19 ) ).add( time.mul( 0.37 ) ) ) );
			const reefWash = reefBand.mul( reefPatch ).mul( fragments )
				.mul( surge.mul( 0.45 ).add( 0.55 ) ).mul( smoothstep( 0.02, 0.12, thick ) ).mul( 0.62 ).toVar();
			foamAmt.assign( max( foamAmt, reefWash ) );
			// whitecaps where the cascades compress the surface
			foamAmt.assign( max( foamAmt, smoothstep( 0.69, 0.44, jac ).mul( smoothstep( 0.43, 0.65, bubbles ) ).mul( 0.58 ) ) );
			foamAmt.assign( sat( foamAmt.mul( u.foamAmount ) ) );

			// ---- roughness: base + the slope variance below this pixel's footprint
			const mss = u.wind.mul( 0.00512 ).add( 0.003 ).toVar();
			const unresolved = sat( log2( footprint.mul( 110 / PI ) ).div( 9 ) ).toVar();
			const localRoughness = u.roughness.mul( fLow2.mul( 0.85 ).add( 0.68 ) );
			const alpha2 = localRoughness.mul( localRoughness ).add( mss.mul( 0.8 ).mul( unresolved ) ).add( foamAmt.mul( 0.2 ) ).toVar();
			const sigmaUnres = sqrt( mss.mul( unresolved ) );

			const NdV = max( dot( N, V ), 1e-4 ).toVar();
			const Fr = fresnelDielectric( NdV, float( IOR ) ).toVar();

			// ---- reflection
			const Rr = reflect( V.negate(), N ).toVar();
			const R = normalize( vec3( Rr.x, max( Rr.y, 0.004 ).add( sigmaUnres.mul( 1.3 ).mul( float( 1 ).sub( max( Rr.y, 0 ) ) ) ), Rr.z ) );
			const refl = texture( sky.equirect.texture, dirToEquirect( R ) ).level( clamp( log2( alpha2.mul( 400 ).add( 1 ) ).add( 1 ), 0, 6 ) ).rgb.toVar();
			refl.mulAssign( u.reflection );
			// soft knee on the reflected sky: the haze glare around the sun would wash the water out
			const lr = lum( refl ).toVar();
			const cap = lum( shared.skyIrradiance ).mul( u.skyCap ).toVar();
			If( lr.greaterThan( cap ), () => {

				refl.mulAssign( cap.add( lr.sub( cap ).mul( 0.12 ) ).div( lr ) );

			} );
			refl.assign( mix( shared.skyIrradiance.mul( 0.25 ), refl, smoothstep( - 0.12, 0.08, Rr.y ) ) );
			If( u.ssr.greaterThan( 0.5 ).and( Fr.greaterThan( 0.01 ) ), () => {

				const Rv = normalize( cameraViewMatrix.mul( vec4( Rr, 0 ) ).xyz );
				const r = traceSSR( posV, Rv ).toVar();
				refl.assign( mix( refl, r.rgb, r.a ) );

			} );

			// ---- sun glint
			const H = normalize( L.add( V ) );
			const NdL = max( dot( N, L ), 0 ).toVar();
			const NdH = max( dot( N, H ), 0 ).toVar();
			const VdH = max( dot( V, H ), 0 );
			const spec = D_GGX( NdH, alpha2 ).mul( V_SmithGGX( NdL, NdV, alpha2 ) ).mul( fresnelDielectric( VdH, float( IOR ) ) ).mul( NdL );
			const sunSpec = sunLight.mul( min( spec, 300 ) ).toVar();
			// stylised glare toward the sun: a broad, soft sheen over the water, and inside it glints on
			// the wave facets that tip toward the sun, thinning out away from the sun's reflection
			// The artistic accents share the dielectric reflection budget with the physical highlight.
			const reflectionBudget = fresnelDielectric( VdH, float( IOR ) ).mul( NdL ).toVar();
			const Hf = normalize( L.add( V ) ).toVar(); // half vector of a flat sea
			const sheen = D_GGX( Hf.y, float( 0.06 ) ).mul( 0.06 * PI );
			const wide = D_GGX( Hf.y, float( 0.12 ) ).mul( 0.12 * PI );
			sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( sheen ).mul( u.sheen ).mul( float( 1 ).sub( foamAmt ) ) );
			const facet = D_GGX( NdH, float( 0.012 ) ).mul( 0.012 * PI );
			const glintPath = smoothstep( 0.13, 0.8, wide ).mul( smoothstep( 0.42, 0.63, fLow ) );
			sunSpec.addAssign( sunLight.mul( reflectionBudget ).mul( glintPath ).mul( facet ).mul( sparkles( wp.xz.mul( 2.1 ).add( N.xz.mul( 2.5 ) ), time ) ).mul( u.glitter ).mul( float( 1 ).sub( foamAmt ) ) );

			// ---- refraction: trace the refracted ray to the floor through the depth
			// Fine facets can sparkle on the surface without stretching the deeper floor.
			// A calmer optical normal keeps submerged silhouettes legible through the column.
			const opticalNormal = normalize( mix( vec3( 0, 1, 0 ), N, 0.4 ) );
			// Art-direct the bend as well as the fine distortion: the deeper shelf should
			// retain its form rather than read as a strongly magnifying glass plate.
			const Tr = normalize( mix( V.negate(), refract( V.negate(), opticalNormal, 1 / IOR ), 0.35 ) );
			const Tv = normalize( vec3( Tr.x, min( Tr.y, - 0.08 ), Tr.z ) ).toVar();
			const tDown = max( Tv.y.negate(), 0.04 ).toVar();
			const fallbackLength = select( skyBehind, float( 200 ), clamp( max( wp.y.sub( sw0.y ), 0 ).div( tDown ), 0, 200 ) );
			const hit = vec4( screenUV, fallbackLength, 0 ).toVar();
			If( skyBehind.not().and( thick.greaterThan( 0.02 ) ), () => {

				const directionV = normalize( cameraViewMatrix.mul( vec4( Tv, 0 ) ).xyz );
				const range = min( max( fallbackLength.mul( 1.5 ), fallbackLength.add( 4 ) ), 40 );
				hit.assign( traceRefraction( posV, directionV, range, wp.y, footprint ) );

			} );
			const refractionTrust = hit.w;
			const uvR = mix( screenUV, hit.xy, select( refractionTrust.greaterThan( 0 ), float( 1 ), float( 0 ) ) );
			const pathLen = mix( fallbackLength, hit.z, refractionTrust ).toVar();

			// Unresolved surface slopes soften deeper refraction slightly; near-surface rocks
			// remain legible, while the far seabed no longer looks like an etched glass plate.
			const refractBlur = min( pathLen.mul( 0.28 ), 1.8 ).div( depthSize );
			const refractedCol = sceneAt( uvR ).mul( 0.5 )
				.add( sceneAt( clamp( uvR.add( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) )
				.add( sceneAt( clamp( uvR.sub( refractBlur.mul( vec2( 0.83, 0.56 ) ) ), vec2( 0.001 ), vec2( 0.999 ) ) ).mul( 0.25 ) );

			// ---- the water body: absorption along the path + single scattering of sun and sky
			const sigA = shared.sigA, sigS = shared.sigS;
			const sigT = sigA.add( sigS ).toVar();
			const Ls = refract( L.negate(), vec3( 0, 1, 0 ), 1 / IOR ).negate().toVar();
			const muS = max( Ls.y, 0.1 );
			const muV = max( Tv.y.negate(), 0.15 );
			// Each source retains its own optical depth while confidence blends the hits.
			// One mixed path would tint a bright shallow source as if it belonged to the basin.
			const bottom = mix(
				sceneAt( screenUV ).mul( exp( sigT.negate().mul( fallbackLength ) ) ),
				refractedCol.mul( exp( sigT.negate().mul( hit.z ) ) ), refractionTrust
			);
			// (in a shadow the volume still glows: light scattered in sideways from the sunlit water)
			const sunIn = shared.sunColor.mul( mix( float( 0.45 ), float( 1 ), shadow ) ).mul( shared.sunIntoWater );
			const kSun = sigT.mul( muV.div( muS ).add( 1 ) ).toVar();
			const kAmb = sigT.mul( muV.div( 0.75 ).add( 1 ) ).toVar();
			const ph = phaseHG( dot( Tv, Ls ), float( 0.86 ) ).mul( 0.7 ).add( 0.3 / ( 4 * PI ) );
			const bb = sigS.mul( u.backscatter );
			const albedoMS = bb.mul( 0.33 * 4 ).div( sigA.add( bb ) ).toVar();
			const inSun = sunIn.mul( sigS.mul( ph ).add( albedoMS.mul( sigT ).div( PI ) ) ).mul( float( 1 ).sub( exp( kSun.negate().mul( pathLen ) ) ) ).div( kSun );
			const inAmb = shared.skyIrradiance.mul( sigS.mul( 0.25 ).add( albedoMS.mul( sigT ) ) ).mul( float( 1 ).sub( exp( kAmb.negate().mul( pathLen ) ) ) ).div( kAmb );
			// sun shining through the thin crests of the waves
			const vH = normalize( V.xz.add( 1e-5 ) ), lH = normalize( L.xz.add( 1e-5 ) );
			const back = pow( sat( dot( vH, lH.negate() ).mul( 0.6 ).add( 0.4 ) ), 2.5 );
			const crest = sat( wp.y.sub( shared.waterLevel ).mul( 4 ).add( 0.2 ) ).mul( sat( float( 1 ).sub( N.y ).mul( 6 ) ).add( 0.2 ) );
			const sss = sunLight.mul( vec3( 0.12, 0.55, 0.45 ) ).mul( back.mul( crest ).mul( 0.035 ) );
			const transmitted = bottom.add( inSun ).add( inAmb ).add( sss );

			// ---- foam: bright diffuse scatterer
			const coolWash = smoothstep( 0.015, 0.25, reefWash );
			const foamCol = sunLight.mul( NdL.mul( 0.57 ).add( 0.2 ) ).div( PI ).mul( mix( float( 1 ), float( 0.65 ), coolWash ) )
				.add( shared.skyIrradiance.mul( mix( float( 1.5 ), float( 1.9 ), coolWash ) ) ).mul( 0.95 );

			const water = mix( transmitted, refl, Fr ).add( sunSpec );
			const col = mix( water, foamCol.add( sunSpec.mul( 0.05 ) ), foamAmt ).toVar();

			// soften the line where the surface cuts the rock (no hard seam); behind rock: the rock
			const edge = select( skyBehind, float( 1 ), smoothstep( 0, 0.06, thick ) );
			col.assign( mix( sceneAt( screenUV ), col, edge ) );
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
			u.shadowMatrix.value.copy( sun.shadow.matrix );
			u.shadowOn.value = 1;

		} else u.shadowOn.value = 0;

	}

}
