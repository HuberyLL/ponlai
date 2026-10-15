/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, storage, instanceIndex, float, vec2, vec4, uint, sqrt, tanh, min, cos, sin, length, select,
	screenCoordinate, ivec2, workgroupArray, workgroupBarrier, workgroupId, localId,
} from 'three/tsl';
import { mulberry32 } from '../world/noise.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { createWaveSpectrum, type SwellParams } from './OceanSpectrum.ts';

// Multi-cascade FFT ocean (Tessendorf) on WebGPU compute, after tidewater's OceanFFT: a JONSWAP
// local wind-sea and swell spectra are summed once per cascade in JS; every frame one kernel evolves
// all cascades in time, then a Stockham radix-2 inverse FFT runs as one row and one column dispatch
// over all cascades at once, and a small fragment pass per cascade writes the mipmapped textures the
// water samples.
//
// Each FFT dispatch runs one workgroup per row (or column) through its 8 stages in workgroup
// memory, with the index maths, twiddles and butterfly order of one dispatch per stage, so the
// fields are bit for bit the same; only the trips through global memory between the stages go.
// debugFlags.fftShared = false runs the earlier 16 per-stage dispatches into the same buffers, to
// A/B the two in one page. Unlike most debug flags, an unset fftShared reads as the new path: this
// optimisation ships on, and only an explicit false selects the old kernels.
//
// Packed complex fields (two real fields per complex IFFT, as in tidewater):
//   c0 = Dx + i Dz          c1 = Dy + i dDx/dz
//   c2 = dDy/dx + i dDy/dz  c3 = dDx/dx + i dDz/dz
//   c4 = Ux + i Uz          c5 = Vy + i 0
//
// Per cascade outputs (half float, repeat; velocity needs no mip chain):
//   displacement  (Dx, Dy, Dz, jacobian)       derivatives  (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
//   slope moments (dDy/dx squared, dDy/dz squared, their product, signed dDx/dz)
//   orbital velocity (Ux, Uz, Vy, unused), without artistic choppiness
// The displacement's rate of change is that velocity with its horizontal part scaled by `chop`
// (Vy is dDy/dt exactly; horizontally the orbital speed is 1 / tanh( k depth ) times the
// displacement's rate, which differs only for waves far longer than those that carry the sea's
// energy): the temporal modes' motion vectors move the water's vertices back along it (Water.ts).
// Derivatives and slope moments use the same filtering kernel; their mip chains retain
// unresolved slope variance.
// Sample a cascade at its undisplaced world xz / size.
//
// The spectrum's wind (`windSpeed`, `windDirection`) is the weather's, as weather/Wind.ts derives it
// (`spectrumWind`: the heading and the reference speed). Weather only scales the cascades'
// amplitude (`weatherGain`, Wind.ts `oceanGain`); it never rebuilds the wave spectrum.
// A kernel that uses `workgroupBarrier()` is dispatched by size (`computeKernel( [ n ] )` with
// `dispatchSize` set), not by a thread count, which makes three insert an early-return bounds
// check ahead of the barriers. A multiple-render-target pass writing the four fields measured
// slower than four single-target passes (sky-bake frames blocked in JS), so they stay separate.

const FFT_N = 256;
const LOG2N = 8;
const G = 9.81;

// tile sizes (m). The caustics need cascade 2 to tile inside cascade 1 (16 = 4 x 4).
const CASCADE_SIZES = [ 71.3, 16.0, 4.0 ];

export interface OceanParams {
	windSpeed: number; // m/s
	windDirection: number; // Fourier heading in degrees; the positive IFFT travels oppositely
	fetch: number; // m
	amplitude: number;
	choppiness: number;
	depth: number;
	spread: number;
	seed: number;
}


export class OceanFFT {

	renderer: THREE.WebGPURenderer;
	sizes: number[];
	params: OceanParams;
	readonly swell: SwellParams;
	spectrumRevision = 0;
	displacementTextures: THREE.Texture[];
	derivativeTextures: THREE.Texture[];
	slopeMomentTextures: THREE.Texture[];
	velocityTextures: THREE.Texture[];
	// A slow weather envelope changes the existing wave field without regenerating its
	// random phases or directional spectrum. Each cascade keeps one coherent amplitude.
	readonly weatherGain = uniform( new THREE.Vector3( 1, 1, 1 ) );

	private time = uniform( 0 );
	/** The horizontal displacement's scale (artistic choppiness), which the velocity leaves out. */
	readonly chop = uniform( 0.85 );
	private depthU = uniform( 8 );
	private h0Attr: THREE.StorageBufferAttribute;
	private kernels: THREE.ComputeNode[] = [];
	private sharedKernels: THREE.ComputeNode[] = [];
	private outputs: { rt: THREE.RenderTarget; quad: THREE.QuadMesh }[] = [];

	constructor( renderer: THREE.WebGPURenderer, {
		sizes = CASCADE_SIZES,
		windSpeed,
		windDirection,
		fetch = 4000,
		amplitude = 1.0,
		choppiness = 0.85,
		depth = 8,
		spread = 0.82,
		seed = 1234,
		swell = {},
		anisotropy = 4,
	}: Pick<OceanParams, 'windSpeed' | 'windDirection'> & Partial<OceanParams> & { sizes?: number[]; swell?: Partial<SwellParams>; anisotropy?: number } ) {

		this.renderer = renderer;
		this.sizes = sizes;
		this.params = { windSpeed, windDirection, fetch, amplitude, choppiness, depth, spread, seed };
		this.swell = { height: 0.16, period: 3.4, directionOffset: 20, spread: 0.85, peakEnhancement: 1.8, ...swell };

		const N = FFT_N, NN = N * N, C = sizes.length, count = NN * C;
		this.h0Attr = new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
		const h0 = storage( this.h0Attr, 'vec4', count ).toReadOnly();
		// ping-pong: A holds ( c0, c1 ), B holds ( c2, c3 ), C holds ( c4, c5 )
		const buf = [ 0, 1 ].map( () => ( {
			attrA: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
			attrB: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
			attrC: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
		} ) );
		const rw = ( i: number ) => ( { A: storage( buf[ i ].attrA, 'vec4', count ), B: storage( buf[ i ].attrB, 'vec4', count ), C: storage( buf[ i ].attrC, 'vec4', count ) } );
		const sizeAt = ( c: THREE.Node<'uint'> ) => select( c.equal( uint( 0 ) ), float( sizes[ 0 ] ), select( c.equal( uint( 1 ) ), float( sizes[ 1 ] ?? 1 ), float( sizes[ 2 ] ?? 1 ) ) );
		const cmul = ( a: THREE.Node<'vec2'>, b: THREE.Node<'vec2'> ) => vec2( a.x.mul( b.x ).sub( a.y.mul( b.y ) ), a.x.mul( b.y ).add( a.y.mul( b.x ) ) );
		const ci = ( a: THREE.Node<'vec2'> ) => vec2( a.y.negate(), a.x ); // i * a

		// 1. h( k, t ) and its displacement, derivative and velocity fields, packed into 6 complex numbers
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
				const forward = cmul( h0v.xy, vec2( cs, sn ) ).toVar();
				const backward = cmul( h0v.zw, vec2( cs, sn.negate() ) ).toVar();
				const h = forward.add( backward ).toVar();
				const difference = forward.sub( backward ).toVar();
				const klSafe = kl.max( 1e-6 );
				const kn = k.div( klSafe );
				// With the positive IFFT, +i k/|k| compresses crests, not troughs.
				const dx = ci( h ).mul( kn.x ).mul( this.chop );
				const dz = ci( h ).mul( kn.y ).mul( this.chop );
				const dydx = ci( h ).mul( k.x );
				const dydz = ci( h ).mul( k.y );
				const dxdx = h.mul( k.x.mul( k.x ).div( klSafe ).negate() ).mul( this.chop );
				const dzdz = h.mul( k.y.mul( k.y ).div( klSafe ).negate() ).mul( this.chop );
				const dxdz = h.mul( k.x.mul( k.y ).div( klSafe ).negate() ).mul( this.chop );
				// With a positive IFFT, exp(+i omega t) travels against k. Airy horizontal
				// velocity therefore has the opposite sign to this component's height.
				// Velocity is physical surface orbital motion, independent of the shape dial.
				const orbital = difference.mul( w.negate().div( tanh( min( kl.mul( this.depthU ), 20 ) ).max( 1e-5 ) ) );
				const ux = orbital.mul( kn.x ), uz = orbital.mul( kn.y ), vy = ci( difference ).mul( w );
				const zero = kl.lessThan( 1e-6 );
				out.A.element( idx ).assign( select( zero, vec4( 0 ), vec4( dx.add( ci( dz ) ), h.add( ci( dxdz ) ) ) ) );
				out.B.element( idx ).assign( select( zero, vec4( 0 ), vec4( dydx.add( ci( dydz ) ), dxdx.add( ci( dzdz ) ) ) ) );
				out.C.element( idx ).assign( select( zero, vec4( 0 ), vec4( ux.add( ci( uz ) ), vy ) ) );

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
					const eA = from.A.element( pe ), eB = from.B.element( pe ), eC = from.C.element( pe );
					const dA = from.A.element( po ), dB = from.B.element( po ), dC = from.C.element( po );
					to.A.element( idx ).assign( eA.add( vec4( cmul( dA.xy, tw ), cmul( dA.zw, tw ) ) ) );
					to.B.element( idx ).assign( eB.add( vec4( cmul( dB.xy, tw ), cmul( dB.zw, tw ) ) ) );
					to.C.element( idx ).assign( eC.add( vec4( cmul( dC.xy, tw ), cmul( dC.zw, tw ) ) ) );

				} )().compute( count, [ 64 ] ) );
				src = 1 - src;

			}

		}

		// 2b. The same stages in two dispatches. A workgroup holds one line ( a row, then a column )
		// of every packed field in workgroup memory: 3 x 256 vec4, 12 KB of the 16 KB WebGPU
		// guarantees. Its 256 threads each own one output element per stage and run the stages
		// above with the same even / odd indices and twiddle constants; a barrier separates every
		// stage's reads from its writes. The fields go from buffer 0 to 1 ( rows ) and back to 0
		// ( columns ), where the 16 dispatches above leave them. ( Evolving the spectrum inside the
		// row pass as well would save its dispatch but changes the rounding of a few hundred
		// texels by one half-float step, so it stays a kernel of its own and the fields stay
		// bit-identical. )
		{

			const line = ( horiz: boolean, from: ReturnType<typeof rw>, to: ReturnType<typeof rw> ) => Fn( () => {

				// ( three's typings lack the workgroup array's element accessor )
				const lane = [ 0, 1, 2 ].map( () => workgroupArray( 'vec4', N ) as unknown as { element: ( i: THREE.Node<'uint'> ) => THREE.Node<'vec4'> } );
				const g = workgroupId.x, i = localId.x;
				const c = g.div( N ), other = g.mod( N );
				const at = horiz ? c.mul( NN ).add( other.mul( N ) ).add( i ) : c.mul( NN ).add( i.mul( N ) ).add( other );
				const input = [ from.A, from.B, from.C ], out = [ to.A, to.B, to.C ];
				for ( let k = 0; k < 3; k ++ ) lane[ k ].element( i ).assign( input[ k ].element( at ) );
				for ( let s = 1; s <= LOG2N; s ++ ) {

					const sub = 1 << s, half = sub >> 1;
					const even = i.div( sub ).mul( half ).add( i.mod( half ) );
					const odd = even.add( N / 2 );
					const a = float( i ).mul( 2 * Math.PI / sub );
					const tw = vec2( cos( a ), sin( a ) );
					workgroupBarrier();
					const result = lane.map( ( l ) => {

						const e = l.element( even ).toVar(), d = l.element( odd ).toVar();
						return e.add( vec4( cmul( d.xy, tw ), cmul( d.zw, tw ) ) ).toVar();

					} );
					if ( s < LOG2N ) {

						workgroupBarrier();
						for ( let k = 0; k < 3; k ++ ) lane[ k ].element( i ).assign( result[ k ] );

					} else {

						for ( let k = 0; k < 3; k ++ ) out[ k ].element( at ).assign( result[ k ] );

					}

				}

			} )().computeKernel( [ N ] );
			// One workgroup per line of every cascade. A dispatch size rather than a thread count:
			// a count adds a bounds check that returns early, which the barriers must not follow.
			const passes = [ line( true, rw( 0 ), rw( 1 ) ), line( false, rw( 1 ), rw( 0 ) ) ];
			for ( const pass of passes ) pass.dispatchSize = [ C * N, 1, 1 ];
			this.sharedKernels.push( this.kernels[ 0 ], ...passes );

		}

		// 3. Observe the final IFFT and write all four per-cascade fields.
		const fin = { A: storage( buf[ src ].attrA, 'vec4', count ).toReadOnly(), B: storage( buf[ src ].attrB, 'vec4', count ).toReadOnly(), C: storage( buf[ src ].attrC, 'vec4', count ).toReadOnly() };
		this.displacementTextures = [];
		this.derivativeTextures = [];
		this.slopeMomentTextures = [];
		this.velocityTextures = [];
		for ( let c = 0; c < C; c ++ ) {

			for ( const which of [ 0, 1, 2, 3 ] ) {

				const rt = new THREE.RenderTarget( N, N, {
					type: THREE.HalfFloatType, generateMipmaps: which !== 3,
					minFilter: which === 3 ? THREE.LinearFilter : THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
					wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, anisotropy,
				} );
				rt.texture.name = [ 'oceanDisp', 'oceanDeriv', 'oceanSlopeMoments', 'oceanVelocity' ][ which ] + c;
				const mat = new THREE.NodeMaterial();
				const px = ivec2( screenCoordinate.xy );
				const idx = uint( px.y.mul( N ).add( px.x ).add( c * NN ) );
				const gain = c === 0 ? this.weatherGain.x : c === 1 ? this.weatherGain.y : this.weatherGain.z;
				const a = fin.A.element( idx ).mul( gain ), b = fin.B.element( idx ).mul( gain ); // ( Dx, Dz, Dy, dDx/dz ), ( dDy/dx, dDy/dz, dDx/dx, dDz/dz )
				const J = float( 1 ).add( b.z ).mul( float( 1 ).add( b.w ) ).sub( a.w.mul( a.w ) );
				const velocity = fin.C.element( idx ).mul( gain );
				// LEAN filtering (Olano and Baker, 2010): squared slopes retain unresolved
				// variance in the mip chain. The existing derivatives store their means.
				// Observe the same weather-scaled slopes as displacement and caustics. Squared
				// moments gain amplitude squared; the signed cross derivative stays linear.
				mat.fragmentNode = which === 0 ? vec4( a.x, a.z, a.y, J ) : which === 1 ? b : which === 2 ?
					vec4( b.x.mul( b.x ), b.y.mul( b.y ), b.x.mul( b.y ), a.w ) : vec4( velocity.xyz, 0 );
				this.outputs.push( { rt, quad: new THREE.QuadMesh( mat ) } );
				[ this.displacementTextures, this.derivativeTextures, this.slopeMomentTextures, this.velocityTextures ][ which ].push( rt.texture );

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
		const depth = this.params.depth;
		const local = createWaveSpectrum( { windSpeed: U, windDirection, fetch: F, spread,
			swell: 0.05, peakEnhancement: 3.3, shortWavesFade: 0.04 }, depth );
		const swellOmega = 2 * Math.PI / this.swell.period;
		// The swell is a second directional frequency spectrum, not an additional regular
		// wave train. Derive its fetch from the authored period, then normalise its energy.
		const swellFetch = G * G / Math.max( U, 0.1 ) * ( 22 / swellOmega ) ** 3;
		const swell = createWaveSpectrum( { windSpeed: U, windDirection: windDirection + this.swell.directionOffset,
			fetch: swellFetch, spread: this.swell.spread, swell: 0.9, peakEnhancement: this.swell.peakEnhancement,
			shortWavesFade: 0.1, peakPeriod: this.swell.period }, depth );
		const localEnergy = new Float64Array( NN * this.sizes.length ), swellEnergy = new Float64Array( localEnergy.length );
		let swellVariance = 0;
		for ( let c = 0; c < this.sizes.length; c ++ ) {

			const dk = 2 * Math.PI / this.sizes[ c ], [ lo, hi ] = this.cuts( c );
			for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

				if ( i === N / 2 || j === N / 2 ) continue;
				const kx = ( i < N / 2 ? i : i - N ) * dk, kz = ( j < N / 2 ? j : j - N ) * dk;
				const k = Math.hypot( kx, kz );
				if ( k < lo || k >= hi ) continue;
				const at = c * NN + j * N + i;
				localEnergy[ at ] = local( kx, kz ) * dk * dk;
				swellEnergy[ at ] = swell( kx, kz ) * dk * dk;
				swellVariance += swellEnergy[ at ];

			}

		}
		// Hs = 4 sigma for the Gaussian sea. Normalise over the modes we actually render,
		// so tile sizes and finite-depth filtering do not silently change the height dial.
		const swellScale = swellVariance > 0 ? ( Math.max( 0, this.swell.height ) / 4 ) ** 2 / swellVariance : 0;
		const rng = mulberry32( seed );
		const gauss = () => {

			const u = Math.max( rng(), 1e-9 ), v = rng();
			return Math.sqrt( - 2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

		};

		const data = this.h0Attr.array as Float32Array;
		const re = new Float32Array( NN ), im = new Float32Array( NN );
		for ( let ci = 0; ci < this.sizes.length; ci ++ ) {

			for ( let j = 0; j < N; j ++ ) for ( let i = 0; i < N; i ++ ) {

				const a = gauss(), b = gauss(), at = ci * NN + j * N + i;
				const energy = localEnergy[ at ] + swellEnergy[ at ] * swellScale;
				const amp = Math.sqrt( energy / 2 ) * amplitude;
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

		// A shared clock makes frozen captures and resume agree with the vegetation.
		this.time.value = time ?? this.time.value + dt;
		const r = this.renderer;
		r.compute( debugFlags.fftShared === false ? this.kernels : this.sharedKernels );
		const prev = r.getRenderTarget();
		for ( const o of this.outputs ) {

			r.setRenderTarget( o.rt );
			o.quad.render( r );

		}

		r.setRenderTarget( prev );

	}

	// Moments and velocity targets have the same lifetime as the existing FFT outputs.
	dispose(): void {

		for ( const output of this.outputs ) {

			output.rt.dispose();
			( output.quad.material as THREE.NodeMaterial ).dispose();

		}
		for ( const kernel of new Set( [ ...this.kernels, ...this.sharedKernels ] ) ) kernel.dispose();
		// QuadMesh geometry is shared by other renderer passes.

	}

}
