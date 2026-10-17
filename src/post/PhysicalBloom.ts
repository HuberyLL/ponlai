/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uv, vec2, vec3, vec4, float, luminance } from 'three/tsl';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from './graph/FrameGraph.ts';
import type { PassBuilder } from './graph/GraphCompiler.ts';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The physically motivated bloom of tidewater's PostFX (4811ba4, after Jimenez, "Next Generation
// Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014): no threshold, the whole HDR
// image spreads a little. Five 13-tap downsamples from the render to 1/2 ... 1/32 of it, then four
// 3x3 tent upsamples, each adding the level above it, back to 1/2. The reader adds the result times
// the strength (tidewater's 0.05) to the image. Every target is the frame graph's, half float, at
// its render-relative size class.
// The first downsample weighs each of its thirteen taps by its share times 1 / ( 1 + its luminance )
// on the exposed image (the scale tidewater's auto exposure leaves its HDR image at; ours is the
// scene radiance, `exposure` times darker) and normalises the weights, a Karis average per tap, so
// a lone hot pixel, which only the five taps round the texel's centre reach, is outweighed by the
// eight beyond it. tidewater weighs its groups of four instead, compresses each by that factor
// and expands their sum again (c / ( 1 - L ), at least 0.02): a hot pixel at a texel's centre
// lies in every group, and a few grass blades' shading singularities (thousands of times the sky)
// were multiplied up to fifty times and spread into glowing discs; weighed per group and
// normalised, they came back whole.

const LEVELS = 5;
const levelSize = ( i: number ): SizeClass => ( { of: 'render', scale: 0.5 / 2 ** i, min: 1 } );

export class PhysicalBloom {

	private readonly down: ResourceHandle[];
	private readonly up: ResourceHandle[];
	private readonly downQuads: THREE.QuadMesh[] = [];
	private readonly upQuads: THREE.QuadMesh[] = [];

	/** `input`: the image to bloom (scene radiance), at the size class `inputSize`; `exposure` scales
	 * it to the exposed image; the targets are declared on `graph`. */
	constructor( private readonly graph: GraphResources, input: THREE.TextureNode, inputSize: SizeClass, private readonly exposure: THREE.Node<'float'> ) {

		const color = ( name: string, size: SizeClass ) => graph.color( name, { size, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		this.down = Array.from( { length: LEVELS }, ( _, i ) => color( `bloom.down${ i }`, levelSize( i ) ) );
		this.up = Array.from( { length: LEVELS - 1 }, ( _, i ) => color( `bloom.up${ i }`, levelSize( i ) ) );
		for ( let i = 0; i < LEVELS; i ++ ) {

			// (the first reads the input at its own resolution)
			const source = i === 0 ? input : texture( graph.texture( this.down[ i - 1 ] ) );
			const texel = graph.texel( i === 0 ? inputSize : levelSize( i - 1 ) );
			this.downQuads.push( this.quad( `Bloom.Down${ i }`, this.downsample( source, texel, i === 0 ) ) );

		}
		for ( let i = LEVELS - 2; i >= 0; i -- ) {

			const small = texture( graph.texture( i === LEVELS - 2 ? this.down[ LEVELS - 1 ] : this.up[ i + 1 ] ) );
			const base = texture( graph.texture( this.down[ i ] ) );
			const texel = graph.texel( levelSize( i + 1 ) );
			this.upQuads[ i ] = this.quad( `Bloom.Up${ i }`, this.upsample( small, base, texel ) );

		}

	}

	private downsample( source: THREE.TextureNode, texel: V2, first: boolean ): V4 {

		return Fn( () => {

			const at = uv();
			const tap = ( x: number, y: number ): V3 => source.sample( at.add( texel.mul( vec2( x, y ) ) ) ).rgb;
			const a = tap( - 2, - 2 ), b = tap( 0, - 2 ), c = tap( 2, - 2 );
			const d = tap( - 2, 0 ), e = tap( 0, 0 ), f = tap( 2, 0 );
			const g = tap( - 2, 2 ), h = tap( 0, 2 ), i = tap( 2, 2 );
			const j = tap( - 1, - 1 ), k = tap( 1, - 1 ), l = tap( - 1, 1 ), m = tap( 1, 1 );
			if ( first ) {

				// the taps and their shares in the 13-tap filter, each weighted by the Karis factor (see
				// the header)
				const taps: [ V3, number ][] = [
					[ e, 0.125 ], [ j, 0.125 ], [ k, 0.125 ], [ l, 0.125 ], [ m, 0.125 ],
					[ b, 0.0625 ], [ d, 0.0625 ], [ f, 0.0625 ], [ h, 0.0625 ],
					[ a, 0.03125 ], [ c, 0.03125 ], [ g, 0.03125 ], [ i, 0.03125 ],
				];
				let sum: V3 = vec3( 0 ), weights: THREE.Node<'float'> = float( 0 );
				for ( const [ tap, share ] of taps ) {

					const w = float( share ).div( luminance( tap ).mul( this.exposure ).add( 1 ) ).toVar();
					sum = sum.add( tap.mul( w ) );
					weights = weights.add( w );

				}
				return vec4( sum.div( weights ), 1 );

			}
			const s = e.mul( 0.125 ).add( a.add( c ).add( g ).add( i ).mul( 0.03125 ) ).add( b.add( d ).add( f ).add( h ).mul( 0.0625 ) ).add( j.add( k ).add( l ).add( m ).mul( 0.125 ) );
			return vec4( s, 1 );

		} )() as unknown as V4;

	}

	private upsample( small: THREE.TextureNode, base: THREE.TextureNode, texel: V2 ): V4 {

		return Fn( () => {

			const at = uv();
			const tap = ( x: number, y: number ): V3 => small.sample( at.add( texel.mul( vec2( x, y ) ) ) ).rgb;
			const s = tap( 0, 0 ).mul( 4 )
				.add( tap( - 1, 0 ).add( tap( 1, 0 ) ).add( tap( 0, - 1 ) ).add( tap( 0, 1 ) ).mul( 2 ) )
				.add( tap( - 1, - 1 ).add( tap( 1, - 1 ) ).add( tap( - 1, 1 ) ).add( tap( 1, 1 ) ) ).div( 16 );
			return vec4( base.sample( at ).rgb.add( s ), 1 );

		} )() as unknown as V4;

	}

	private quad( name: string, fragment: V4 ): THREE.QuadMesh {

		const material = new THREE.NodeMaterial();
		material.name = name;
		material.fragmentNode = fragment;
		const quad = new THREE.QuadMesh( material );
		quad.name = name;
		return quad;

	}

	/** Adds the passes to `graph`: the downsamples (the first one's reads of the input declared by
	 * `reads`), then the upsamples. Returns the result's version (the last upsample's), for the
	 * reader to declare. */
	passes<Frame>( graph: FrameGraph<Frame>, label: string, reads: ( b: PassBuilder ) => void ): ResourceHandle {

		const down = [ ...this.down ], up = [ ...this.up ];
		for ( let i = 0; i < LEVELS; i ++ ) {

			const quad = this.downQuads[ i ];
			graph.addPass( `bloomDown${ i }`, 'quad', ( b ) => {

				if ( i === 0 ) reads( b );
				else b.read( down[ i - 1 ] );
				down[ i ] = b.write( down[ i ] );
				return { label, quad };

			} );

		}
		for ( let i = LEVELS - 2; i >= 0; i -- ) {

			const quad = this.upQuads[ i ];
			graph.addPass( `bloomUp${ i }`, 'quad', ( b ) => {

				b.read( i === LEVELS - 2 ? down[ LEVELS - 1 ] : up[ i + 1 ] );
				b.read( down[ i ] );
				up[ i ] = b.write( up[ i ] );
				return { label, quad };

			} );

		}
		return up[ 0 ];

	}

	/** The result: the last upsample's texture, at half the render. */
	output(): THREE.Texture {

		return this.graph.texture( this.up[ 0 ] );

	}

}
