/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uv, vec2, vec4, luminance, max } from 'three/tsl';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from './graph/FrameGraph.ts';
import type { PassBuilder } from './graph/GraphCompiler.ts';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The physically motivated bloom of tidewater's PostFX (4811ba4, after Jimenez, "Next Generation
// Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014): no threshold, the whole HDR
// image spreads a little. Five 13-tap downsamples from the render to 1/2 ... 1/32 of it (the first
// with the Karis average over its groups of four, so a single bright glint cannot flicker), then
// four 3x3 tent upsamples, each adding the level above it, back to 1/2. The reader adds the result
// times the strength (tidewater's 0.05) to the image. Every target is the frame graph's, half
// float, at its render-relative size class.

const LEVELS = 5;
const levelSize = ( i: number ): SizeClass => ( { of: 'render', scale: 0.5 / 2 ** i, min: 1 } );

export class PhysicalBloom {

	private readonly down: ResourceHandle[];
	private readonly up: ResourceHandle[];
	private readonly downQuads: THREE.QuadMesh[] = [];
	private readonly upQuads: THREE.QuadMesh[] = [];

	/** `input`: the image to bloom, at the size class `inputSize`; the targets are declared on
	 * `graph`. */
	constructor( private readonly graph: GraphResources, input: THREE.TextureNode, inputSize: SizeClass ) {

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

				// weighted groups of four, each through the Karis average, which suppresses fireflies,
				// undone on the sum
				const karis = ( s: V3 ) => s.div( luminance( s ).add( 1 ) );
				const g0 = karis( j.add( k ).add( l ).add( m ).mul( 0.25 ) ).mul( 0.5 );
				const g1 = karis( a.add( b ).add( d ).add( e ).mul( 0.25 ) ).mul( 0.125 );
				const g2 = karis( b.add( c ).add( e ).add( f ).mul( 0.25 ) ).mul( 0.125 );
				const g3 = karis( d.add( e ).add( g ).add( h ).mul( 0.25 ) ).mul( 0.125 );
				const g4 = karis( e.add( f ).add( h ).add( i ).mul( 0.25 ) ).mul( 0.125 );
				const s = g0.add( g1 ).add( g2 ).add( g3 ).add( g4 ).toVar();
				return vec4( s.div( max( luminance( s ).oneMinus(), 0.02 ) ), 1 );

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
