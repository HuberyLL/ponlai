/*!
 * Adapted from three.js's BloomNode (examples/jsm/tsl/display/BloomNode.js, r186), after
 * UnrealBloomPass: the high pass, the five mips' separable Gaussian blurs and the composite.
 * Copyright © 2010-2026 three.js authors
 * Licensed under the MIT License; see ./three-bloom.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, Loop, add, array, float, int, mat4, mix, mrt, outputStruct, texture, uniform, uniformArray, uv, vec4 } from 'three/tsl';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from './graph/FrameGraph.ts';
import type { PassBuilder } from './graph/GraphCompiler.ts';

type F = THREE.Node<'float'>;
type V4 = THREE.Node<'vec4'>;
type Columns = { element( i: number ): V4 };
// (three's `array()` takes plain numbers, which its typings do not list)
type Elements<T> = { element( i: number | THREE.Node<'int'> ): T };
const constants = ( values: number[] ) => array( values as unknown as THREE.Node[] ) as unknown as Elements<F>;

// Bloom chains over one input, drawn together: the tight bloom and the wide glow (Pipeline.ts).
// Each chain is three's BloomNode, pass for pass and expression for expression: a high pass into a
// target at half the render, five mips of a separable Gaussian blur (horizontal, then vertical,
// each mip half the one before, its kernel wider), and a composite of the five mips into the first
// mip's horizontal target, weighted by the radius and scaled by the strength. Drawn as two
// BloomNodes, the chains took 24 small passes and read the input twice in their high passes; here
// the high pass and each blur draw all the chains at once into an MRT (one read of the input, ten
// blur passes instead of twenty), and the composites stay a pass per chain: 13 passes. The targets
// are the frame graph's, each mip at its own size class (three's `floor( floor( w / 2 ) / 2 ... )`
// is `floor( w * 2^-( mip + 1 ) )`), half float as three's.
// Rules:
// - The image does not change: each chain's attachments hold, bit for bit, what a BloomNode of its
//   own drew (MSAA captures byte-identical). A chain's attachment is a function of its own uniforms
//   and textures only; the chains share the input's sample and the blur's taps (the same offsets,
//   weights and directions), which the shader computes once with the same values.
// - The composites are not merged: drawn into one MRT pass, the two chains' sums came out a level
//   apart on a few pixels in four of six views (the shader compiler contracts a larger body
//   differently), where the high pass and the blurs merged stay exact.
// - Each MRT pass's attachments come from one `Fn` returned as a matrix's columns and handed to
//   `outputStruct` (AGENTS.md: an output struct returned from inside an `Fn` gets one output).

const MIPS = 5;
// the kernel radius of each mip's blur (three's, after mrdoob/three.js#31528)
const KERNEL = [ 6, 10, 14, 18, 22 ];
// how much each mip weighs before the radius mirrors it (three's)
const FACTORS = [ 1.0, 0.8, 0.6, 0.4, 0.2 ];
// mip i: floor( w * 2^-( i + 1 ) ), at least a texel
const mipSize = ( i: number ): SizeClass => ( { of: 'render', scale: 0.5 / 2 ** i, min: 1 } );

const lerpBloomFactor = Fn( ( [ factor, radius ]: [ F, F ] ) => {

	const mirrorFactor = float( 1.2 ).sub( factor );
	return mix( factor, mirrorFactor, radius );

} ).setLayout( { name: 'lerpBloomFactor', type: 'float', inputs: [ { name: 'factor', type: 'float' }, { name: 'radius', type: 'float' } ] } );

/** One chain's settings (three's BloomNode's), set every frame by its owner. */
export interface BloomChain {
	readonly name: string;
	readonly strength: THREE.UniformNode<'float', number>;
	readonly radius: THREE.UniformNode<'float', number>;
	readonly threshold: THREE.UniformNode<'float', number>;
}

// (up to four chains: a matrix's columns carry the attachments)
const columns = ( list: V4[] ) => mat4( list[ 0 ], list[ 1 ] ?? vec4( 0 ), list[ 2 ] ?? vec4( 0 ), list[ 3 ] ?? vec4( 0 ) );
// (the attachments `body` builds, as a material's fragment node: their struct, or the one)
const attachments = ( n: number, body: () => V4[] ) => {

	const m = Fn( () => columns( body() ) )() as unknown as Columns;
	return n === 1 ? m.element( 0 ) : outputStruct( ...Array.from( { length: n }, ( _, i ) => m.element( i ) ) ) as unknown as V4;

};

export class BloomChains {

	readonly chains: BloomChain[];
	// per chain: the high pass's target, and each mip's horizontal and vertical targets
	private readonly bright: ResourceHandle[];
	private readonly horizontal: ResourceHandle[][];
	private readonly vertical: ResourceHandle[][];
	private readonly highQuad: THREE.QuadMesh;
	private readonly blurQuads: { h: THREE.QuadMesh; v: THREE.QuadMesh }[] = [];
	private readonly compositeQuads: THREE.QuadMesh[];

	/** `names`: the chains (one to four); `highPass( input, chain, index )`: a chain's high pass of
	 * the input (three's `highPassFn`, with the chain's threshold). The targets are declared on
	 * `graph`, which owns and sizes them; `passes` adds the passes that draw them. */
	constructor( private readonly graph: GraphResources, names: string[], input: V4, highPass: ( input: V4, chain: BloomChain, index: number ) => V4 ) {

		if ( names.length < 1 || names.length > 4 ) throw new Error( `BloomChains: 1 to 4 chains, not ${ names.length }` );
		this.chains = names.map( ( name ) => ( { name, strength: uniform( 1 ), radius: uniform( 0 ), threshold: uniform( 0 ) } ) );
		const color = ( name: string, size: SizeClass ) => graph.color( name, { size, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		this.bright = names.map( ( name ) => color( `${ name }.bright`, mipSize( 0 ) ) );
		this.horizontal = names.map( ( name ) => Array.from( { length: MIPS }, ( _, i ) => color( `${ name }.h${ i }`, mipSize( i ) ) ) );
		this.vertical = names.map( ( name ) => Array.from( { length: MIPS }, ( _, i ) => color( `${ name }.v${ i }`, mipSize( i ) ) ) );

		// 1. the bright areas, every chain's from one sample of the input
		this.highQuad = this.quad( 'Bloom.HighPass', attachments( names.length, () => this.chains.map( ( chain, c ) => highPass( input, chain, c ) ) ) );

		// 2. each mip blurred, horizontally then vertically, from the mip before (the bright areas for
		// the first)
		for ( let i = 0; i < MIPS; i ++ ) {

			const from = this.chains.map( ( _, c ) => i === 0 ? this.bright[ c ] : this.vertical[ c ][ i - 1 ] );
			const h = this.blur( KERNEL[ i ], mipSize( i ), from, new THREE.Vector2( 1, 0 ) );
			const v = this.blur( KERNEL[ i ], mipSize( i ), this.horizontal.map( ( mips ) => mips[ i ] ), new THREE.Vector2( 0, 1 ) );
			this.blurQuads.push( { h: this.quad( `Bloom.Blur.H${ i }`, h ), v: this.quad( `Bloom.Blur.V${ i }`, v ) } );

		}

		// 3. each chain's mips composited by its radius and strength, a pass per chain (see the rules)
		const factors = constants( FACTORS );
		const tints = uniformArray( Array.from( { length: MIPS }, () => new THREE.Vector3( 1, 1, 1 ) ) ) as unknown as Elements<THREE.Node<'vec3'>>;
		this.compositeQuads = this.chains.map( ( chain, c ) => this.quad( `Bloom.Composite.${ chain.name }`, Fn( () => {

			const mip = ( k: number ) => lerpBloomFactor( factors.element( k ), chain.radius ).mul( vec4( tints.element( k ), 1.0 ) ).mul( texture( graph.texture( this.vertical[ c ][ k ] ) ) );
			const sum = mip( 0 ).add( mip( 1 ) ).add( mip( 2 ) ).add( mip( 3 ) ).add( mip( 4 ) );
			return sum.mul( chain.strength );

		} )() as unknown as V4 ) );

	}

	// three's separable blur of one mip, for every chain at once: the same taps (adjacent Gaussian
	// weights merged into bilinear fetches) over each chain's source
	private blur( kernelRadius: number, size: SizeClass, sources: ResourceHandle[], dir: THREE.Vector2 ): V4 {

		const coefficients: number[] = [];
		const sigma = kernelRadius / 3;
		for ( let i = 0; i < kernelRadius; i ++ ) coefficients.push( 0.39894 * Math.exp( - 0.5 * i * i / ( sigma * sigma ) ) / sigma );
		const centerWeight = coefficients[ 0 ];
		const offsets: number[] = [], weights: number[] = [];
		for ( let i = 1; i < kernelRadius; i += 2 ) {

			const wa = coefficients[ i ];
			const wb = ( i + 1 ) < kernelRadius ? coefficients[ i + 1 ] : 0;
			const w = wa + wb;
			offsets.push( ( i * wa + ( i + 1 ) * wb ) / w );
			weights.push( w );

		}
		const colorTextures = sources.map( ( h ) => texture( this.graph.texture( h ) ) );
		const gaussianOffsets = constants( offsets );
		const gaussianWeights = constants( weights );
		// (three sets it to one over the mip's size: the graph's texel uniform of its class)
		const invSize = this.graph.texel( size );
		const direction = uniform( dir );
		const uvNode = uv();
		return attachments( sources.length, () => {

			const sums = colorTextures.map( ( t ) => t.sample( uvNode ).rgb.mul( centerWeight ).toVar() );
			Loop( { start: int( 0 ), end: int( offsets.length ), type: 'int', condition: '<' }, ( { i } ) => {

				const w = gaussianWeights.element( i );
				const uvOffset = direction.mul( invSize ).mul( gaussianOffsets.element( i ) );
				colorTextures.forEach( ( t, c ) => {

					const sample1 = t.sample( uvNode.add( uvOffset ) ).rgb;
					const sample2 = t.sample( uvNode.sub( uvOffset ) ).rgb;
					sums[ c ].addAssign( add( sample1, sample2 ).mul( w ) );

				} );

			} );
			return sums.map( ( s ) => vec4( s, 1.0 ) );

		} );

	}

	private quad( name: string, fragment: V4 ): THREE.QuadMesh {

		const material = new THREE.NodeMaterial();
		material.name = name;
		material.fragmentNode = fragment;
		const quad = new THREE.QuadMesh( material );
		quad.name = name;
		return quad;

	}

	/** Adds the chains' passes to `graph`, in three's order: the high pass (whose input's reads
	 * `reads` declares), each mip's two blurs, the composites. Returns each chain's result (its
	 * composite's version of its first horizontal target), for the reader to declare. */
	passes<Frame>( graph: FrameGraph<Frame>, label: string, reads: ( b: PassBuilder ) => void ): ResourceHandle[] {

		const n = this.chains.length;
		const bright = [ ...this.bright ];
		const horizontal = this.horizontal.map( ( mips ) => [ ...mips ] );
		const vertical = this.vertical.map( ( mips ) => [ ...mips ] );
		// (with several chains, an MRT: it declares the attachments to the graph only, unblended)
		const multiple = n > 1 ? mrt( {} ) : null;
		const highQuad = this.highQuad;
		graph.addPass( 'bloomHigh', 'quad', ( b ) => {

			reads( b );
			for ( let c = 0; c < n; c ++ ) bright[ c ] = b.write( bright[ c ] );
			return { label, quad: highQuad, mrt: multiple };

		} );
		for ( let i = 0; i < MIPS; i ++ ) {

			const { h, v } = this.blurQuads[ i ];
			graph.addPass( `bloomBlurH${ i }`, 'quad', ( b ) => {

				for ( let c = 0; c < n; c ++ ) b.read( i === 0 ? bright[ c ] : vertical[ c ][ i - 1 ] );
				for ( let c = 0; c < n; c ++ ) horizontal[ c ][ i ] = b.write( horizontal[ c ][ i ] );
				return { label, quad: h, mrt: multiple };

			} );
			graph.addPass( `bloomBlurV${ i }`, 'quad', ( b ) => {

				for ( let c = 0; c < n; c ++ ) b.read( horizontal[ c ][ i ] );
				for ( let c = 0; c < n; c ++ ) vertical[ c ][ i ] = b.write( vertical[ c ][ i ] );
				return { label, quad: v, mrt: multiple };

			} );

		}
		this.chains.forEach( ( chain, c ) => {

			const quad = this.compositeQuads[ c ];
			graph.addPass( `bloomComposite.${ chain.name }`, 'quad', ( b ) => {

				for ( let k = 0; k < MIPS; k ++ ) b.read( vertical[ c ][ k ] );
				horizontal[ c ][ 0 ] = b.write( horizontal[ c ][ 0 ] );
				return { label, quad };

			} );

		} );
		return horizontal.map( ( mips ) => mips[ 0 ] );

	}

	/** Chain `c`'s result: the texture of its first mip's horizontal target, which its composite
	 * writes last (as three's). */
	output( c: number ): THREE.Texture {

		return this.graph.texture( this.horizontal[ c ][ 0 ] );

	}

}
