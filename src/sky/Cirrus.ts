/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, Loop, instanceIndex, textureStore, texture, uv, int, uint, float, vec2, vec3, vec4, ivec2,
	floor, fract, dot, mod, exp, max, min, sin, cos, atan, normalize, clamp, length, log2,
} from 'three/tsl';
import { hash33, perlin3 } from '../materials/CloudNoise.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V4 = THREE.Node<'vec4'>;

// High cirrus fibres, after tidewater's cirrus veil (its `Clouds.js`). Sparse seeds are drawn
// out along a smooth, gently meandering flow by line integral convolution: long filaments of
// varied width, brightness and length, and hooked tails sagging sideways downwind of tufts.
// Baked once into a mipmapped, tileable texture; the sky samples it anisotropically with each
// pixel's footprint on the sheet, so distant fibres merge into a smooth veil rather than shimmer.
// The flow runs along +x; callers rotate the sheet into the upper wind.

export const FIBRE_RES = 1024;
const LIC_STEPS = 44;

// Tileable gradient noise in [-1, 1] on the unit square, `period` cells across.
const noise2 = ( p: V2, period: number, seed: number ) => perlin3( vec3( p.mul( period ), seed ), float( period ) );
// Fractal noise about [0, 1], with the contrast the clustering and breakup thresholds expect.
const fbm2 = ( p: V2, period: number, seed: number ) => noise2( p, period, seed ).mul( 0.55 )
	.add( noise2( p, period * 2, seed + 1.7 ).mul( 0.3 ) ).add( noise2( p, period * 4, seed + 3.1 ).mul( 0.15 ) )
	.mul( 1.6 ).add( 0.5 );
const sat = ( x: F ) => clamp( x, 0, 1 );

// Sparse jittered points, `n` cells across the texture: each cell holds one with probability
// `cluster * prob`, a Gaussian of `sigma` cells.
const points = ( p: V2, cluster: F, n: number, prob: number, sigma: number, seed: number ) => {

	const q = p.mul( n );
	const ip = floor( q ).toVar(), fp = fract( q ).toVar();
	const v = float( 0 ).toVar();
	for ( let y = - 1; y <= 1; y ++ ) for ( let x = - 1; x <= 1; x ++ ) {

		const o = vec2( x, y );
		const h = hash33( vec3( mod( ip.add( o ), float( n ) ), seed ) );
		const on = h.z.lessThan( cluster.mul( prob ) ).select( float( 1 ), float( 0 ) );
		const d = o.add( h.xy.mul( 0.8 ).add( 0.1 ) ).sub( fp );
		const strength = hash33( vec3( mod( ip.add( o ), float( n ) ), seed + 7.1 ) ).x.mul( 0.7 ).add( 0.3 );
		v.assign( max( v, exp( dot( d, d ).mul( - 0.5 / ( sigma * sigma ) ) ).mul( on ).mul( strength ) ) );

	}
	return v;

};

/** Bake the fibres: r = filaments, g = a soft veil noise. Needs an initialised renderer. */
export function bakeCirrusFibres( renderer: THREE.WebGPURenderer ): THREE.RenderTarget {

	// The flow: r = seeds, g = flow angle, b = tufts, a = the sideways sag just downwind of them.
	const flow = new THREE.StorageTexture( FIBRE_RES, FIBRE_RES );
	flow.type = THREE.HalfFloatType;
	flow.wrapS = flow.wrapT = THREE.RepeatWrapping;
	flow.minFilter = flow.magFilter = THREE.LinearFilter;
	flow.generateMipmaps = false;
	const flowKernel = Fn( () => {

		const n = uint( FIBRE_RES );
		const c = ivec2( int( instanceIndex.mod( n ) ), int( instanceIndex.div( n ) ) );
		const p = vec2( c ).add( 0.5 ).div( FIBRE_RES ).toVar();
		const psi = ( q: V2 ) => noise2( q, 3, 0.1 ).mul( 0.5 ).add( noise2( q.add( 0.37 ), 7, 0.2 ).mul( 0.25 ) ).add( noise2( q.add( 0.71 ), 15, 0.3 ).mul( 0.1 ) );
		const e = 1 / FIBRE_RES;
		const curl = vec2( psi( p.add( vec2( 0, e ) ) ).sub( psi( p.sub( vec2( 0, e ) ) ) ), psi( p.sub( vec2( e, 0 ) ) ).sub( psi( p.add( vec2( e, 0 ) ) ) ) ).div( 2 * e );
		const dir = normalize( vec2( 1, 0 ).add( vec2( 0, noise2( p.add( 0.13 ), 3, 0.4 ).mul( 0.5 ) ) ).add( curl.mul( 0.05 ) ) );
		const cluster = sat( fbm2( p, 5, 0.9 ).mul( 1.6 ).sub( 0.3 ) ).toVar();
		const seeds = max( points( p, cluster, 110, 0.3, 0.18, 0 ), points( p, cluster, 44, 0.3, 0.18, 3.3 ).mul( 0.8 ) );
		const tuft = points( p, cluster, 40, 0.4, 0.1, 6.1 );
		const droop = points( p, cluster, 40, 0.4, 0.3, 6.1 );
		textureStore( flow, c, vec4( seeds, atan( dir.y, dir.x ), tuft, droop ) );

	} )().compute( FIBRE_RES * FIBRE_RES, [ 64 ] ).setName( 'Clouds.CirrusFlow' );
	renderer.compute( flowKernel );

	const fibres = new THREE.RenderTarget( FIBRE_RES, FIBRE_RES, { depthBuffer: false, generateMipmaps: true } );
	fibres.texture.wrapS = fibres.texture.wrapT = THREE.RepeatWrapping;
	fibres.texture.minFilter = THREE.LinearMipmapLinearFilter;
	fibres.texture.magFilter = THREE.LinearFilter;
	fibres.texture.name = 'cirrusFibres';
	const flowNode = texture( flow );
	const material = new THREE.NodeMaterial();
	material.depthTest = material.depthWrite = false;
	material.toneMapped = false;
	material.fragmentNode = Fn( () => {

		const p = uv().toVar();
		const x1 = p.toVar(), x2 = p.toVar();
		const fib = float( 0 ).toVar(), head = float( 0 ).toVar();
		Loop( LIC_STEPS, ( { i } ) => {

			const k = float( i );
			// Short strands: each wisp fades in and out along its length.
			const a = flowNode.sample( x1 ).level( float( 0 ) );
			fib.addAssign( a.x.mul( sin( k.add( 0.5 ).mul( Math.PI / LIC_STEPS ) ) ) );
			x1.subAssign( vec2( cos( a.y ), sin( a.y ) ).div( FIBRE_RES ) );
			// Hooked tails: from a tuft downwind, sagging sideways.
			const b = flowNode.sample( x2 ).level( float( 0 ) );
			head.addAssign( b.z.mul( exp( k.mul( - 1 / 12 ) ) ) );
			x2.subAssign( normalize( vec2( cos( b.y ), sin( b.y ).add( b.w.mul( 1.2 ) ) ) ).div( FIBRE_RES ) );

		} );
		const breakup = sat( fbm2( p, 24, 0.71 ).mul( 1.6 ).sub( 0.25 ) );
		const wisps = float( 1 ).sub( exp( fib.mul( - 0.8 ) ) ).mul( breakup );
		const hooks = float( 1 ).sub( exp( head.mul( - 0.5 ) ) );
		return vec4( sat( max( wisps, hooks ) ), sat( fbm2( p, 4, 0.33 ) ), 0, 1 );

	} )();
	const quad = new THREE.QuadMesh( material );
	const previous = renderer.getRenderTarget();
	renderer.setRenderTarget( fibres );
	quad.render( renderer );
	renderer.setRenderTarget( previous );
	material.dispose();
	flow.dispose();
	return fibres;

}

/** Filtered fibres at sheet position `q` (metres, flow along +x), for a pixel whose footprint on
 * the sheet spans the vectors `fa` and `fb`: a few taps along the long axis of the footprint at
 * the mip level of its short axis. `tile` is the texture's period in metres; `turn` rotates it. */
export function sampleCirrusFibres( fibres: THREE.Texture, q: V2, fa: V2, fb: V2, tile: number, turn: number ): V4 {

	const c = Math.cos( turn ), s = Math.sin( turn );
	const rotate = ( v: V2 ) => vec2( v.x.mul( c ).add( v.y.mul( s ) ), v.y.mul( c ).sub( v.x.mul( s ) ) ).div( tile );
	const at = rotate( q ).toVar(), a = rotate( fa ).toVar(), b = rotate( fb ).toVar();
	const la = length( a ).mul( FIBRE_RES ), lb = length( b ).mul( FIBRE_RES );
	const major = la.greaterThan( lb ).select( a, b ).toVar();
	const TAPS = 3;
	const lod = max( log2( max( min( la, lb ), max( la, lb ).div( TAPS ) ) ), 0 ).toVar();
	const node = texture( fibres );
	const sum = vec4( 0 ).toVar();
	for ( let i = 0; i < TAPS; i ++ ) sum.addAssign( node.sample( at.add( major.mul( ( i + 0.5 ) / TAPS - 0.5 ) ) ).level( lod ) );
	return sum.div( TAPS );

}
