/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, storage, instanceIndex, float, vec2, vec4, uint, sqrt, tanh, min, cos, sin, length, select,
	screenCoordinate, ivec2,
} from 'three/tsl';
import { mulberry32 } from '../world/noise.ts';

// Multi-cascade FFT ocean (Tessendorf) on WebGPU compute, after tidewater's OceanFFT: a JONSWAP
// spectrum is sampled once per cascade in JS; every frame one kernel evolves all cascades in time,
// then a Stockham radix-2 inverse FFT runs as 8 row + 8 column dispatches over all cascades at
// once, and a small fragment pass per cascade writes the mipmapped textures the water samples.
//
// Packed complex fields (two real fields per complex IFFT, as in tidewater):
//   c0 = Dx + i Dz          c1 = Dy + i dDx/dz
//   c2 = dDy/dx + i dDy/dz  c3 = dDx/dx + i dDz/dz
//
// Per cascade outputs (half float, mipmapped, repeat):
//   displacement  (Dx, Dy, Dz, jacobian)       derivatives  (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
// Sample a cascade at world xz / size.

const FFT_N = 256;
const LOG2N = 8;
const G = 9.81;

// tile sizes (m). The caustics need cascade 2 to tile inside cascade 1 (16 = 4 x 4).
const CASCADE_SIZES = [ 71.3, 16.0, 4.0 ];

export interface OceanParams {
	windSpeed: number; // m/s
	windDirection: number; // degrees, toward which the wind blows
	fetch: number; // m
	amplitude: number;
	choppiness: number;
	depth: number;
	spread: number;
	seed: number;
}

type StorageNode = ReturnType<typeof storage>;

export class OceanFFT {

	renderer: THREE.WebGPURenderer;
	sizes: number[];
	params: OceanParams;
	spectrumRevision = 0;
	displacementTextures: THREE.Texture[];
	derivativeTextures: THREE.Texture[];

	private time = uniform( 0 );
	private chop = uniform( 0.85 );
	private depthU = uniform( 8 );
	private h0Attr: THREE.StorageBufferAttribute;
	private kernels: THREE.ComputeNode[] = [];
	private outputs: { rt: THREE.RenderTarget; quad: THREE.QuadMesh }[] = [];

	constructor( renderer: THREE.WebGPURenderer, {
		sizes = CASCADE_SIZES,
		windSpeed = 5.0,
		windDirection = 35,
		fetch = 4000,
		amplitude = 1.0,
		choppiness = 0.85,
		depth = 8,
		spread = 0.82,
		seed = 1234,
	}: Partial<OceanParams> & { sizes?: number[] } = {} ) {

		this.renderer = renderer;
		this.sizes = sizes;
		this.params = { windSpeed, windDirection, fetch, amplitude, choppiness, depth, spread, seed };

		const N = FFT_N, NN = N * N, C = sizes.length, count = NN * C;
		this.h0Attr = new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
		const h0 = storage( this.h0Attr, 'vec4', count ).toReadOnly();
		// ping-pong: A holds ( c0, c1 ), B holds ( c2, c3 )
		const buf = [ 0, 1 ].map( () => ( {
			attrA: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
			attrB: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
		} ) );
		const rw = ( i: number ) => ( { A: storage( buf[ i ].attrA, 'vec4', count ), B: storage( buf[ i ].attrB, 'vec4', count ) } );
		const sizeAt = ( c: THREE.Node<'uint'> ) => select( c.equal( uint( 0 ) ), float( sizes[ 0 ] ), select( c.equal( uint( 1 ) ), float( sizes[ 1 ] ?? 1 ), float( sizes[ 2 ] ?? 1 ) ) );
		const cmul = ( a: THREE.Node<'vec2'>, b: THREE.Node<'vec2'> ) => vec2( a.x.mul( b.x ).sub( a.y.mul( b.y ) ), a.x.mul( b.y ).add( a.y.mul( b.x ) ) );
		const ci = ( a: THREE.Node<'vec2'> ) => vec2( a.y.negate(), a.x ); // i * a

		// 1. h( k, t ) and the 8 derived fields, packed into 4 complex numbers
		{

			const out = rw( 0 );
			this.kernels.push( Fn( () => {

				const idx = instanceIndex;
				const c = idx.div( NN );
				const p = idx.mod( NN );
				const mx = float( p.mod( N ) ).toVar(), my = float( p.div( N ) ).toVar();
				mx.assign( select( mx.greaterThanEqual( N / 2 ), mx.sub( N ), mx ) );
				my.assign( select( my.greaterThanEqual( N / 2 ), my.sub( N ), my ) );
				const k = vec2( mx, my ).mul( float( 2 * Math.PI ).div( sizeAt( c ) ) ).toVar();
				const kl = length( k ).toVar();
				const h0v = h0.element( idx );
				const w = sqrt( float( G ).mul( kl ).mul( tanh( min( kl.mul( this.depthU ), 20 ) ) ) );
				const cs = cos( w.mul( this.time ) ), sn = sin( w.mul( this.time ) );
				const h = cmul( h0v.xy, vec2( cs, sn ) ).add( cmul( h0v.zw, vec2( cs, sn.negate() ) ) ).toVar();
				const klSafe = kl.max( 1e-6 );
				const kn = k.div( klSafe );
				const dx = ci( h ).mul( kn.x.negate() ).mul( this.chop );
				const dz = ci( h ).mul( kn.y.negate() ).mul( this.chop );
				const dydx = ci( h ).mul( k.x );
				const dydz = ci( h ).mul( k.y );
				const dxdx = h.mul( k.x.mul( k.x ).div( klSafe ) ).mul( this.chop );
				const dzdz = h.mul( k.y.mul( k.y ).div( klSafe ) ).mul( this.chop );
				const dxdz = h.mul( k.x.mul( k.y ).div( klSafe ) ).mul( this.chop );
				const zero = kl.lessThan( 1e-6 );
				out.A.element( idx ).assign( select( zero, vec4( 0 ), vec4( dx.add( ci( dz ) ), h.add( ci( dxdz ) ) ) ) );
				out.B.element( idx ).assign( select( zero, vec4( 0 ), vec4( dydx.add( ci( dydz ) ), dxdx.add( ci( dzdz ) ) ) ) );

			} )().compute( count, [ 64 ] ) );

		}

		// 2. Stockham radix-2 stages of the inverse transform, rows then columns
		let src = 0;
		for ( let horiz = 1; horiz >= 0; horiz -- ) {

			for ( let s = 1; s <= LOG2N; s ++ ) {

				const sub = 1 << s, half = sub >> 1;
				const from = rw( src ), to = rw( 1 - src );
				this.kernels.push( Fn( () => {

					const idx = instanceIndex;
					const c = idx.div( NN );
					const p = idx.mod( NN );
					const x = p.mod( N ), y = p.div( N );
					const i = horiz ? x : y;
					const even = i.div( sub ).mul( half ).add( i.mod( half ) );
					const base = c.mul( NN );
					const pe = horiz ? base.add( y.mul( N ) ).add( even ) : base.add( even.mul( N ) ).add( x );
					const po = pe.add( horiz ? N / 2 : NN / 2 );
					const a = float( i ).mul( 2 * Math.PI / sub );
					const tw = vec2( cos( a ), sin( a ) );
					const eA = from.A.element( pe ), eB = from.B.element( pe );
					const dA = from.A.element( po ), dB = from.B.element( po );
					to.A.element( idx ).assign( eA.add( vec4( cmul( dA.xy, tw ), cmul( dA.zw, tw ) ) ) );
					to.B.element( idx ).assign( eB.add( vec4( cmul( dB.xy, tw ), cmul( dB.zw, tw ) ) ) );

				} )().compute( count, [ 64 ] ) );
				src = 1 - src;

			}

		}

		// 3. per cascade: displacement + Jacobian, and the derivatives, into mipmapped textures
		const fin = { A: storage( buf[ src ].attrA, 'vec4', count ).toReadOnly(), B: storage( buf[ src ].attrB, 'vec4', count ).toReadOnly() };
		this.displacementTextures = [];
		this.derivativeTextures = [];
		for ( let c = 0; c < C; c ++ ) {

			for ( const which of [ 0, 1 ] ) {

				const rt = new THREE.RenderTarget( N, N, {
					type: THREE.HalfFloatType, generateMipmaps: true,
					minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
					wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, anisotropy: 8,
				} );
				rt.texture.name = ( which ? 'oceanDeriv' : 'oceanDisp' ) + c;
				const mat = new THREE.NodeMaterial();
				const px = ivec2( screenCoordinate.xy );
				const idx = uint( px.y.mul( N ).add( px.x ).add( c * NN ) );
				const a = fin.A.element( idx ), b = fin.B.element( idx ); // ( Dx, Dz, Dy, dDx/dz ), ( dDy/dx, dDy/dz, dDx/dx, dDz/dz )
				const J = float( 1 ).add( b.z ).mul( float( 1 ).add( b.w ) ).sub( a.w.mul( a.w ) );
				mat.fragmentNode = which ? b : vec4( a.x, a.z, a.y, J );
				this.outputs.push( { rt, quad: new THREE.QuadMesh( mat ) } );
				( which ? this.derivativeTextures : this.displacementTextures ).push( rt.texture );

			}

		}

		this.rebuildSpectrum();

	}

	// k-band of each cascade: from 4 fundamentals of the next-larger tile up to 4 of its own next
	private cuts( i: number ): [ number, number ] {

		const s = this.sizes;
		const lo = i === 0 ? 0 : 2 * Math.PI / s[ i ] * 4;
		const hi = i === s.length - 1 ? Infinity : 2 * Math.PI / s[ i + 1 ] * 4;
		return [ lo, hi ];

	}

	rebuildSpectrum(): void {

		const { windSpeed: U, windDirection, fetch: F, amplitude, spread, seed } = this.params;
		const N = FFT_N, NN = N * N;
		// JONSWAP (Hasselmann et al.)
		const alpha = 0.076 * Math.pow( U * U / ( F * G ), 0.22 );
		const wp = 22 * Math.pow( G * G / ( U * F ), 1 / 3 );
		const gamma = 3.3;
		const theta0 = windDirection * Math.PI / 180;
		const rng = mulberry32( seed );
		const gauss = () => {

			const u = Math.max( rng(), 1e-9 ), v = rng();
			return Math.sqrt( - 2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

		};

		const spectrum = ( kx: number, kz: number ) => {

			const k = Math.hypot( kx, kz );
			if ( k < 1e-6 ) return 0;
			const w = Math.sqrt( G * k );
			const sigma = w <= wp ? 0.07 : 0.09;
			const r = Math.exp( - ( ( w - wp ) ** 2 ) / ( 2 * sigma * sigma * wp * wp ) );
			const Sw = alpha * G * G / Math.pow( w, 5 ) * Math.exp( - 1.25 * Math.pow( wp / w, 4 ) ) * Math.pow( gamma, r );
			const dwdk = G / ( 2 * w );
			let th = Math.atan2( kz, kx ) - theta0;
			th = Math.atan2( Math.sin( th ), Math.cos( th ) );
			const c = Math.cos( th );
			const dirTight = Math.abs( th ) < Math.PI / 2 ? ( 2 / Math.PI ) * c * c : 0;
			const D = spread * dirTight + ( 1 - spread ) / ( 2 * Math.PI );
			// short capillary-ish ripples die off smoothly (avoids aliasing sparkle)
			const fade = Math.exp( - k * k * 0.0004 );
			return Sw * dwdk / k * D * fade;

		};

		const data = this.h0Attr.array as Float32Array;
		const re = new Float32Array( NN ), im = new Float32Array( NN );
		for ( let ci = 0; ci < this.sizes.length; ci ++ ) {

			const L = this.sizes[ ci ];
			const dk = 2 * Math.PI / L;
			const [ lo, hi ] = this.cuts( ci );
			for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

				const mx = i < N / 2 ? i : i - N, mz = j < N / 2 ? j : j - N;
				const kx = mx * dk, kz = mz * dk;
				const k = Math.hypot( kx, kz );
				const a = gauss(), b = gauss();
				let S = ( k >= lo && k < hi ) ? spectrum( kx, kz ) : 0;
				if ( i === N / 2 || j === N / 2 ) S = 0; // Nyquist: no consistent conjugate
				const amp = Math.sqrt( S * dk * dk / 2 ) * amplitude;
				re[ j * N + i ] = a * amp / Math.SQRT2;
				im[ j * N + i ] = b * amp / Math.SQRT2;

			}

			for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

				const k = j * N + i;
				const kn = ( ( N - j ) % N ) * N + ( N - i ) % N;
				const o = ( ci * NN + k ) * 4;
				data[ o ] = re[ k ];
				data[ o + 1 ] = im[ k ];
				data[ o + 2 ] = re[ kn ]; // conj( h0( -k ) )
				data[ o + 3 ] = - im[ kn ];

			}

		}

		this.h0Attr.needsUpdate = true;
		this.chop.value = this.params.choppiness;
		this.depthU.value = this.params.depth;
		this.spectrumRevision ++;

	}

	update( dt: number, time?: number ): void {

		// A shared clock makes frozen captures and resume agree with the foam and vegetation.
		this.time.value = time ?? this.time.value + dt;
		const r = this.renderer;
		r.compute( this.kernels );
		const prev = r.getRenderTarget();
		for ( const o of this.outputs ) {

			r.setRenderTarget( o.rt );
			o.quad.render( r );

		}

		r.setRenderTarget( prev );

	}

}

export type { StorageNode };
