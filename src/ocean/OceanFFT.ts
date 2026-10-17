/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uniform, storage, instanceIndex, float, vec2, vec4, uint, sqrt, tanh, min, max, cos, sin, abs, exp, pow, atan, length, select, mix, smoothstep,
	screenCoordinate, ivec2, workgroupArray, workgroupBarrier, workgroupId, localId,
} from 'three/tsl';
import { mulberry32 } from '../world/noise.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { DEFAULT_SWELL, seaState, waveSystemTerms, type SwellParams } from './OceanSpectrum.ts';

// Multi-cascade FFT ocean (Tessendorf) on WebGPU compute, after tidewater's OceanFFT (4811ba4): four
// cascades of non-integer size ratios, so the sum never shows a repeat, each holding the waves of
// its own band of wavenumbers (from 6 fundamentals of the next larger tile to 6 of its own next). Two
// wave systems are summed into one spectrum, as tidewater's `local` and `swell`: the local wind sea
// (JONSWAP, the weather's wind and a sea state's fetch) and a distant swell of its own wind and
// fetch (OceanSpectrum.ts). A kernel sums the spectrum into each cascade's amplitudes whenever the sea
// state changes (tidewater's init kernel; the random phases are drawn once, in JS); every frame one
// kernel evolves all cascades in time, then a Stockham radix-2 inverse FFT runs as one row and one
// column dispatch over all cascades at once, and a small fragment pass per cascade and field writes
// its layer of the array textures the water samples (one texture per field, a layer per cascade:
// the water's fragment stage binds two textures for the FFT, not one per cascade and field).
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
// Outputs, one 2D array texture each, a layer per cascade (half float, repeat; velocity needs no
// mip chain):
//   displacement  (Dx, Dy, Dz, jacobian)       derivatives  (dDy/dx, dDy/dz, dDx/dx, dDz/dz)
//   orbital velocity (Ux, Uz, Vy, unused), without artistic choppiness
// The displacement's rate of change is that velocity with its horizontal part scaled by `chop`
// (Vy is dDy/dt exactly; horizontally the orbital speed is 1 / tanh( k depth ) times the
// displacement's rate, which differs only for waves far longer than those that carry the sea's
// energy): the temporal modes' motion vectors move the water's vertices back along it (Water.ts).
// The mip chain of a layer is made once its layer is written: three
// rebuilds every layer's chain at the end of each render into an array target, so only the last
// cascade's pass of a field asks for them.
// Sample a cascade at its undisplaced world xz / size, in its layer (`texture( t, uv ).depth( c )`).
//
// The spectrum follows the weather's wind as tidewater's sea states follow its wind (`setWind`: the
// fetch, choppiness and the swell's scale of OceanSpectrum.ts `seaState` at that speed, and its
// heading), rebuilt on the GPU in the frame the wind changes, so a stronger wind makes longer waves,
// not only taller ones; a function of the current wind alone, whatever the path to it. The wind sea
// (the first system) takes the weather's heading and turns with it, as a sea's young waves follow
// the day's wind; the swell, the memory of distant weather, keeps the prevailing heading
// (`swellHeading`, Wind.ts `spectrumWind`) plus its own offset, and so does the shore's shelter
// field (ShoreWaves `swellDirection`). A turn is uniform writes and the spectrum kernel's run, as a
// change of speed is: no pipeline. The random phases stay, so the waves of the new heading grow
// out of the same sea as the old ones fade.
// The spectrum's depth is tidewater's open ocean (500 m), not the shelf sea's: the island's shallows
// damp the waves in the water's vertex stage instead (Water.ts).
// A kernel that uses `workgroupBarrier()` is dispatched by size (`computeKernel( [ n ] )` with
// `dispatchSize` set), not by a thread count, which makes three insert an early-return bounds
// check ahead of the barriers. A multiple-render-target pass writing the four fields measured
// slower than four single-target passes (sky-bake frames blocked in JS), so they stay separate.

const FFT_N = 256;
export const FFT_SIZE = FFT_N;
const LOG2N = 8;
const G = 9.81;

// tile sizes (m): tidewater's, in non-integer ratios so that the cascades never line up
export const CASCADE_SIZES = [ 733, 157, 33.3, 7.1 ];
// a cascade's band starts this many fundamentals of its own tile above the next larger one's
const BAND_FUNDAMENTALS = 6;

// A wave system's energy at wavenumber k (OceanSpectrum.ts createWaveSpectrum on the GPU, as
// tidewater's init kernel): TMA-corrected JONSWAP times the directional spreading and the short
// waves' fade, with the omega-to-k Jacobian. a: ( alpha, peak omega, heading, spread ), b:
// ( concentration, gamma, squared fade, 0 ).
const waveEnergy = Fn( ( [ k, a, b, depth ]: [ THREE.Node<'vec2'>, THREE.Node<'vec4'>, THREE.Node<'vec4'>, THREE.Node<'float'> ] ) => {

	const kl = max( length( k ), 1e-6 ).toVar();
	const kd = min( kl.mul( depth ), 20 ).toVar();
	const th = tanh( kd ).toVar();
	const omega = sqrt( float( G ).mul( kl ).mul( th ) ).toVar();
	const peak = a.y;
	const sigma = select( omega.lessThanEqual( peak ), float( 0.07 ), float( 0.09 ) );
	const r = exp( omega.sub( peak ).pow( 2 ).negate().div( sigma.mul( sigma ).mul( peak.mul( peak ) ).mul( 2 ) ) );
	const omegaH = omega.mul( sqrt( depth.div( G ) ) ).toVar();
	const tma = select( omegaH.lessThanEqual( 1 ), omegaH.mul( omegaH ).mul( 0.5 ),
		select( omegaH.lessThan( 2 ), float( 1 ).sub( float( 2 ).sub( omegaH ).pow( 2 ).mul( 0.5 ) ), float( 1 ) ) );
	const jonswap = tma.mul( a.x ).mul( G * G ).div( omega.pow( 5 ) ).mul( exp( peak.div( omega ).pow( 4 ).mul( - 1.25 ) ) ).mul( pow( b.y, r ) );
	const ratio = omega.div( peak ).toVar();
	const spreadPower = select( omega.greaterThan( peak ), pow( ratio, - 2.5 ).mul( 9.77 ), pow( ratio, 5 ).mul( 6.97 ) )
		.add( tanh( min( ratio, 20 ) ).mul( 16 ).mul( b.x.mul( b.x ) ) ).toVar();
	const theta = atan( k.y, k.x ).sub( a.z ).toVar();
	const cosT = cos( theta ).toVar();
	const broad = select( cosT.greaterThan( 0 ), cosT.mul( cosT ).mul( 2 / Math.PI ), float( 0 ) );
	const s1 = spreadPower, s2 = s1.mul( s1 ), s3 = s2.mul( s1 ), s4 = s3.mul( s1 );
	const normalisation = select( s1.lessThan( 5 ),
		s4.mul( - 0.000564 ).add( s3.mul( 0.00776 ) ).sub( s2.mul( 0.044 ) ).add( s1.mul( 0.192 ) ).add( 0.163 ),
		s4.mul( - 4.80e-8 ).add( s3.mul( 1.07e-5 ) ).sub( s2.mul( 9.53e-4 ) ).add( s1.mul( 0.059 ) ).add( 0.393 ) );
	const narrow = normalisation.mul( pow( abs( cos( theta.mul( 0.5 ) ) ), spreadPower.mul( 2 ) ) );
	const direction = broad.add( narrow.sub( broad ).mul( a.w ) );
	const jacobian = float( G ).mul( th.add( kl.mul( depth ).mul( float( 1 ).sub( th.mul( th ) ) ) ) ).div( omega.mul( 2 ) );
	return jonswap.mul( direction ).mul( exp( b.z.mul( kl ).mul( kl ).negate() ) ).mul( jacobian ).div( kl );

} ).setLayout( { name: 'oceanWaveEnergy', type: 'float', inputs: [
	{ name: 'k', type: 'vec2' }, { name: 'a', type: 'vec4' }, { name: 'b', type: 'vec4' }, { name: 'depth', type: 'float' },
] } );

// A Gaussian pair per mode (Box-Muller on a seeded stream), in the order the modes are laid out.
function gaussianPairs( seed: number, count: number ): Float32Array {

	const rng = mulberry32( seed );
	const gauss = () => {

		const u = Math.max( rng(), 1e-9 ), v = rng();
		return Math.sqrt( - 2 * Math.log( u ) ) * Math.cos( 2 * Math.PI * v );

	};
	const pairs = new Float32Array( count * 2 );
	for ( let i = 0; i < pairs.length; i ++ ) pairs[ i ] = gauss();
	return pairs;

}

// The local wind sea's system and the shared settings (tidewater's `local` WaveSystem).
export interface OceanParams {
	windSpeed: number; // m/s
	windDirection: number; // Fourier heading in degrees; the positive IFFT travels oppositely
	fetch: number; // m
	amplitude: number;
	choppiness: number;
	depth: number;
	spread: number;
	swell: number; // the local sea's extra directional concentration
	peakEnhancement: number;
	shortWavesFade: number;
	seed: number;
}


export class OceanFFT {

	renderer: THREE.WebGPURenderer;
	sizes: number[];
	params: OceanParams;
	readonly swell: SwellParams;
	/** The heading the swell's offset turns from (the prevailing wind's), degrees. */
	readonly swellHeading: number;
	spectrumRevision = 0;
	readonly cascades: number;
	// the fields, one array texture each with a layer per cascade (see the note at the top)
	readonly displacement: THREE.Texture;
	readonly derivatives: THREE.Texture;
	readonly velocity: THREE.Texture;

	private time = uniform( 0 );
	/** The horizontal displacement's scale (artistic choppiness), which the velocity leaves out. */
	readonly chop = uniform( 0.85 );
	/** The whitecaps' threshold on the surface's compression (tidewater's foamBias), the sea state's. */
	readonly foamBias = uniform( 0.5 );
	private depthU = uniform( 8 );
	private amplitudeU = uniform( 1 );
	// the two wave systems' terms (OceanSpectrum.ts waveSystemTerms): ( alpha, peak omega, heading,
	// spread ) and ( concentration, gamma, squared fade, 0 )
	private systems = [ 0, 1 ].map( () => ( { a: uniform( new THREE.Vector4() ), b: uniform( new THREE.Vector4() ) } ) );
	private h0Attr: THREE.StorageBufferAttribute;
	private gaussAttr: THREE.StorageBufferAttribute;
	private spectrumKernel: THREE.ComputeNode;
	private spectrumDirty = true;
	private kernels: THREE.ComputeNode[] = [];
	private sharedKernels: THREE.ComputeNode[] = [];
	private outputs: { rt: THREE.RenderTarget; layer: number; mipmapped: boolean; quad: THREE.QuadMesh }[] = [];
	private allocated = false;

	// Defaults: tidewater's `local` and `swell` wave systems (its Breezy sea state; main.ts passes the
	// weather's wind and its sea state).
	constructor( renderer: THREE.WebGPURenderer, {
		sizes = CASCADE_SIZES,
		windSpeed,
		windDirection,
		swellHeading = windDirection,
		fetch = 120e3,
		amplitude = 1.0,
		choppiness = 0.9,
		depth = 500,
		spread = 0.85,
		swell = 0.05,
		peakEnhancement = 3.3,
		shortWavesFade = 0.01,
		seed = 1234,
		distantSwell = {},
		anisotropy = 4,
	}: Pick<OceanParams, 'windSpeed' | 'windDirection'> & Partial<OceanParams> & { swellHeading?: number; sizes?: number[]; distantSwell?: Partial<SwellParams>; anisotropy?: number } ) {

		this.renderer = renderer;
		this.sizes = sizes;
		this.cascades = sizes.length;
		this.params = { windSpeed, windDirection, fetch, amplitude, choppiness, depth, spread, swell, peakEnhancement, shortWavesFade, seed };
		this.swell = { ...DEFAULT_SWELL, ...distantSwell };
		this.swellHeading = swellHeading;

		const N = FFT_N, NN = N * N, C = sizes.length, count = NN * C;
		this.h0Attr = new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
		const h0 = storage( this.h0Attr, 'vec4', count ).toReadOnly();
		// the random phases: a Gaussian pair per mode, drawn once
		this.gaussAttr = new THREE.StorageBufferAttribute( gaussianPairs( seed, count ), 2 );
		// ping-pong: A holds ( c0, c1 ), B holds ( c2, c3 ), C holds ( c4, c5 )
		const buf = [ 0, 1 ].map( () => ( {
			attrA: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
			attrB: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
			attrC: new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 ),
		} ) );
		const rw = ( i: number ) => ( { A: storage( buf[ i ].attrA, 'vec4', count ), B: storage( buf[ i ].attrB, 'vec4', count ), C: storage( buf[ i ].attrC, 'vec4', count ) } );
		const sizeAt = ( c: THREE.Node<'uint'> ) => sizes.slice( 0, - 1 ).reduceRight<THREE.Node<'float'>>(
			( rest, size, i ) => select( c.equal( uint( i ) ), float( size ), rest ), float( sizes[ C - 1 ] ) );
		const cmul = ( a: THREE.Node<'vec2'>, b: THREE.Node<'vec2'> ) => vec2( a.x.mul( b.x ).sub( a.y.mul( b.y ) ), a.x.mul( b.y ).add( a.y.mul( b.x ) ) );
		const ci = ( a: THREE.Node<'vec2'> ) => vec2( a.y.negate(), a.x ); // i * a

		// 0. h0( k ) and conj( h0( -k ) ) from the two wave systems' energy at k and at -k: the variance
		// of the height is the sum of the modes' energy (E | h0 |^2 = energy / 2 for each of the pair)
		{

			const out = storage( this.h0Attr, 'vec4', count );
			const gauss = storage( this.gaussAttr, 'vec2', count ).toReadOnly();
			// The band in the cascade's own grid units, squared: whole numbers at its lower edge
			// (BAND_FUNDAMENTALS), so the modes that lie on it are in, exactly as the JS cut has them.
			const bands = sizes.map( ( size, n ) => [ n === 0 ? 0 : BAND_FUNDAMENTALS ** 2,
				n === C - 1 ? 1e30 : ( BAND_FUNDAMENTALS * size / sizes[ n + 1 ] ) ** 2 ] );
			this.spectrumKernel = Fn( () => {

				const idx = instanceIndex;
				const c = idx.div( NN );
				const p = idx.mod( NN );
				const i = p.mod( N ), j = p.div( N );
				const signed = ( n: THREE.Node<'uint'> ) => select( n.greaterThanEqual( N / 2 ), float( n ).sub( N ), float( n ) );
				const dk = float( 2 * Math.PI ).div( sizeAt( c ) ).toVar();
				const n = vec2( signed( i ), signed( j ) ).toVar();
				const k = n.mul( dk ).toVar();
				const n2 = n.x.mul( n.x ).add( n.y.mul( n.y ) );
				const band = ( which: 0 | 1 ) => bands.slice( 0, - 1 ).reduceRight<THREE.Node<'float'>>(
					( rest, b, m ) => select( c.equal( uint( m ) ), float( b[ which ] ), rest ), float( bands[ C - 1 ][ which ] ) );
				const inBand = n2.greaterThanEqual( band( 0 ) ).and( n2.lessThan( band( 1 ) ) )
					.and( i.notEqual( uint( N / 2 ) ) ).and( j.notEqual( uint( N / 2 ) ) );
				const S = this.systems;
				const energy = ( q: THREE.Node<'vec2'> ) => waveEnergy( q, S[ 0 ].a, S[ 0 ].b, this.depthU ).add( waveEnergy( q, S[ 1 ].a, S[ 1 ].b, this.depthU ) ).mul( dk.mul( dk ) );
				const scale = this.amplitudeU.div( Math.SQRT2 );
				const mirror = c.mul( NN ).add( uint( N ).sub( j ).mod( N ).mul( N ) ).add( uint( N ).sub( i ).mod( N ) );
				const h = gauss.element( idx ).mul( sqrt( energy( k ).div( 2 ) ) ).mul( scale );
				const hm = gauss.element( mirror ).mul( sqrt( energy( k.negate() ).div( 2 ) ) ).mul( scale );
				out.element( idx ).assign( select( inBand, vec4( h, hm.x, hm.y.negate() ), vec4( 0 ) ) );

			} )().compute( count, [ 64 ] );

		}

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

		// 3. Observe the final IFFT and write each cascade's layer of the three fields.
		const fin = { A: storage( buf[ src ].attrA, 'vec4', count ).toReadOnly(), B: storage( buf[ src ].attrB, 'vec4', count ).toReadOnly(), C: storage( buf[ src ].attrC, 'vec4', count ).toReadOnly() };
		const kinds = [ 'oceanDisplacement', 'oceanDerivatives', 'oceanVelocity' ];
		const fields = kinds.map( ( name, which ) => {

			const mipmapped = which < 2;
			const rt = new THREE.RenderTarget( N, N, {
				depth: C, type: THREE.HalfFloatType, generateMipmaps: mipmapped,
				minFilter: mipmapped ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter,
				wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false, anisotropy,
			} );
			rt.texture.name = name;
			return rt;

		} );
		for ( const which of [ 0, 1, 2 ] ) {

			for ( let c = 0; c < C; c ++ ) {

				const mat = new THREE.NodeMaterial();
				const px = ivec2( screenCoordinate.xy );
				const idx = uint( px.y.mul( N ).add( px.x ).add( c * NN ) );
				const a = fin.A.element( idx ), b = fin.B.element( idx ); // ( Dx, Dz, Dy, dDx/dz ), ( dDy/dx, dDy/dz, dDx/dx, dDz/dz )
				const J = float( 1 ).add( b.z ).mul( float( 1 ).add( b.w ) ).sub( a.w.mul( a.w ) );
				mat.fragmentNode = which === 0 ? vec4( a.x, a.z, a.y, J ) : which === 1 ? b : vec4( fin.C.element( idx ).xyz, 0 );
				this.outputs.push( { rt: fields[ which ], layer: c, mipmapped: which < 2, quad: new THREE.QuadMesh( mat ) } );

			}

		}
		[ this.displacement, this.derivatives, this.velocity ] = fields.map( ( rt ) => rt.texture );

		this.foamBias.value = seaState( windSpeed ).foamBias;
		this.rebuildSpectrum();

	}

	/** tidewater's shallow-water attenuation of cascade `c` (WaterSurface.js
	 * `waterSurfaceCascadeAttenuation`) at a floor `depth` (m): long waves feel the floor first and
	 * fade toward it over 8 % of their tile (at most 40 m of depth), while short ones keep a share
	 * until the last 0.6 m. */
	attenuation( c: number, depth: THREE.Node<'float'> ): THREE.Node<'float'> {

		const d0 = Math.min( 40, this.sizes[ c ] * 0.08 ), floor = [ 0, 0.05, 0.25, 0.5 ][ c ] ?? 0.5;
		return mix( smoothstep( 0, 0.6, depth ).mul( floor ), float( 1 ), smoothstep( 0, d0, depth ) );

	}

	/** Takes tidewater's sea state at a wind speed (m/s) and the wind sea's heading (degrees,
	 * wrapped to 0..360 so a heading is one value however it was reached), rebuilt in the next
	 * update when either changes. */
	setWind( windSpeed: number, heading = this.params.windDirection ): void {

		const windDirection = ( ( heading % 360 ) + 360 ) % 360;
		if ( windSpeed === this.params.windSpeed && windDirection === this.params.windDirection ) return;
		if ( windSpeed !== this.params.windSpeed ) {

			const sea = seaState( windSpeed );
			Object.assign( this.params, { windSpeed, fetch: sea.fetch, choppiness: sea.choppiness } );
			this.swell.scale = sea.swell;
			this.foamBias.value = sea.foamBias;

		}
		this.params.windDirection = windDirection;
		this.rebuildSpectrum();

	}

	/** The swell's heading (degrees, the spectrum's convention): the prevailing one plus its offset. */
	get swellDirection(): number {

		return this.swellHeading + this.swell.directionOffset;

	}

	/** Takes `params` and `swell` as they are now; the spectrum is rebuilt in the next update. */
	rebuildSpectrum(): void {

		const { windSpeed, windDirection, fetch, spread, swell, peakEnhancement, shortWavesFade } = this.params;
		const S = this.swell;
		const terms = [
			waveSystemTerms( { windSpeed, windDirection, fetch, spread, swell, peakEnhancement, shortWavesFade } ),
			waveSystemTerms( { scale: S.scale, windSpeed: S.windSpeed, windDirection: this.swellDirection,
				fetch: S.fetch, spread: S.spread, swell: S.swell, peakEnhancement: S.peakEnhancement, shortWavesFade: S.shortWavesFade } ),
		];
		terms.forEach( ( t, n ) => {

			this.systems[ n ].a.value.set( t.alpha, t.peakOmega, t.angle, t.spread );
			this.systems[ n ].b.value.set( t.concentration, t.gamma, t.fade2, 0 );

		} );
		this.amplitudeU.value = this.params.amplitude;
		this.chop.value = this.params.choppiness;
		this.depthU.value = this.params.depth;
		this.spectrumDirty = true;
		this.spectrumRevision ++;

	}

	update( dt: number, time?: number ): void {

		// A shared clock makes frozen captures and resume agree with the vegetation.
		this.time.value = time ?? this.time.value + dt;
		const r = this.renderer;
		if ( this.spectrumDirty ) {

			r.compute( this.spectrumKernel );
			this.spectrumDirty = false;

		}
		r.compute( debugFlags.fftShared === false ? this.kernels : this.sharedKernels );
		const prev = r.getRenderTarget();
		for ( const o of this.outputs ) {

			// One mip chain per field, after its last layer (see the note at the top). The first frame
			// asks at every layer: a target's texture takes its mip levels from the flag at its first
			// render.
			o.rt.texture.generateMipmaps = o.mipmapped && ( o.layer === this.cascades - 1 || ! this.allocated );
			r.setRenderTarget( o.rt, o.layer );
			o.quad.render( r );

		}
		this.allocated = true;

		r.setRenderTarget( prev );

	}

	dispose(): void {

		for ( const output of this.outputs ) {

			output.rt.dispose();
			( output.quad.material as THREE.NodeMaterial ).dispose();

		}
		for ( const kernel of new Set( [ this.spectrumKernel, ...this.kernels, ...this.sharedKernels ] ) ) kernel.dispose();
		// QuadMesh geometry is shared by other renderer passes.

	}

}
