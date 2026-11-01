/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, If, texture, uniform, vec2, vec4, float, int, smoothstep, screenCoordinate } from 'three/tsl';
import { FFT_SIZE } from './OceanFFT.ts';
import { waveDamping, type WaveDampingInputs } from './WaveDamping.ts';
import { shared } from '../shared.ts';

// The wave maps (tidewater's UnderwaterLighting bake, 4811ba4): what the light under the water needs
// at a point depends on its xz alone (the long waves' height and slope, the mean level), so it is
// baked once a frame into two maps centred on the camera (0.25 m texels over 128 m, 2 m over 1 km,
// snapped to their texels so they do not crawl) instead of every fragment that can be under the
// water reading the FFT and the shore waves. Beyond the far map: a level sea. The long waves are the
// three coarsest cascades' height and the two coarsest's slope, damped as the sea's surface is
// (WaveDamping.ts), and the rock's reflected wave; none over dry land. The mean level is the two
// longest cascades' height, read coarser.
// The maps share an array target with the ground bounce's map (its last layer:
// lighting/GroundBounce.ts), so the materials lit under the water take one texture for all three.
// They are read at level 0 within half a texel of their edges, so the repeat wrap never reaches
// them, and the target keeps no mips.
// The bake runs outside the frame graph, after the sea's cascades and before the frame's passes.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// the shared target's size
const RES = 512;

// the target's layers: a layer per wave map ( height - sea level, slope x, slope z, mean level - sea
// level ), then the ground bounce's map (drawn by GroundBounce)
const WAVE_EXTENTS = [ 128, 1024 ];
const BOUNCE_LAYER = WAVE_EXTENTS.length;
const LAYERS = BOUNCE_LAYER + 1;
// Above this height over the sea level no water reaches (m): the lookups return a level sea there.
const WAVE_REACH = 2.5;

/** What the wave maps' bake reads (WaveMaps.attachWaves). */
export type WaveMapInputs = WaveDampingInputs;

export class WaveMaps {

	renderer: THREE.WebGPURenderer;
	readonly target: THREE.RenderTarget;
	/** The target's layer that holds the ground bounce's map (lighting/GroundBounce.ts draws it). */
	readonly bounceLayer = BOUNCE_LAYER;

	// the wave maps: each one's world origin (its texel ( 0, 0 )'s corner) and its bake, once attached
	private readonly origins = WAVE_EXTENTS.map( () => uniform( new THREE.Vector2() ) );
	private readonly wavesReady = uniform( 0 );
	private bakes: { quad: THREE.QuadMesh; layer: number }[] = [];

	constructor( renderer: THREE.WebGPURenderer ) {

		this.renderer = renderer;
		this.target = new THREE.RenderTarget( RES, RES, {
			depth: LAYERS, type: THREE.HalfFloatType, generateMipmaps: false,
			minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false,
		} );
		this.target.texture.name = 'waveMaps';

	}

	/** Bakes the wave maps from now on (the world's fields and the shore waves exist): until then
	 * the lookups read a level sea. */
	attachWaves( inputs: WaveMapInputs ): void {

		const { fft } = inputs;
		WAVE_EXTENTS.forEach( ( extent, level ) => {

			const texel = extent / RES, origin = this.origins[ level ];
			// the world xz at this texel's centre (screen row 0 is texture row 0)
			const xz = screenCoordinate.xy.mul( texel ).add( origin ).toVar();
			const { weights, seaDepth } = waveDamping( inputs, xz );
			const w = [ weights.x, weights.y, weights.z ];
			const at = ( field: THREE.Texture, c: number, lvl: number ) => texture( field, xz.div( fft.sizes[ c ] ) ).depth( int( c ) ).level( float( lvl ) );
			// the cascades read no finer than the bake's texel (and at least two levels down)
			const lvl = ( c: number ) => Math.max( 2, Math.log2( texel * FFT_SIZE / fft.sizes[ c ] ) );
			const waves = new THREE.NodeMaterial();
			waves.fragmentNode = Fn( () => {

				let h: F = float( 0 ), mean: F = float( 0 ), slope: V2 = vec2( 0 );
				for ( let c = 0; c < Math.min( 3, fft.cascades ); c ++ ) {

					h = h.add( at( fft.displacement, c, lvl( c ) ).y.mul( w[ c ] ) );
					if ( c < 2 ) {

						slope = slope.add( at( fft.derivatives, c, lvl( c ) ).xy.mul( w[ c ] ) );
						mean = mean.add( at( fft.displacement, c, 3 ).y.mul( w[ c ] ) );

					}

				}
				const shore = inputs.shoreWaves.surfaceAt( xz, shared.time ).toVar();
				// waves only over water: none over dry land (a deep trough there, so nothing above it
				// counts as under the water)
				const height = h.add( shore.x ).mul( smoothstep( 0, 1, seaDepth ) ).sub( smoothstep( 0, - 0.4, seaDepth ).mul( 10 ) );
				return vec4( height, slope.add( shore.yz ), mean.mul( smoothstep( 0, 3, seaDepth ) ) );

			} )();
			this.bakes.push( { quad: new THREE.QuadMesh( waves ), layer: level } );

		} );

	}

	update( camera: THREE.Camera ): void {

		if ( this.bakes.length === 0 ) return;
		const r = this.renderer;
		const prev = r.getRenderTarget();
		// the maps' origins, snapped to whole texels so their texel centres stay put in the world
		WAVE_EXTENTS.forEach( ( extent, level ) => {

			const texel = extent / RES;
			this.origins[ level ].value.set( Math.floor( camera.position.x / texel ) * texel - extent / 2, Math.floor( camera.position.z / texel ) * texel - extent / 2 );

		} );
		for ( const { quad, layer } of this.bakes ) {

			r.setRenderTarget( this.target, layer );
			quad.render( r );

		}
		this.wavesReady.value = 1;
		r.setRenderTarget( prev );

	}

	/** The wave maps at a world point: ( height of the long waves' surface over the sea level, their
	 * slope x and z, mean level over the sea level ); a level sea above WAVE_REACH, beyond the far map
	 * and before the first bake. Explicit levels: any branch. */
	wavesAt( P: V3 ): THREE.Node<'vec4'> {

		return Fn( () => {

			const out = vec4( 0 ).toVar();
			const inside = ( st: V2 ) => st.x.greaterThan( 0.5 ).and( st.y.greaterThan( 0.5 ) ).and( st.x.lessThan( RES - 0.5 ) ).and( st.y.lessThan( RES - 0.5 ) );
			const st = WAVE_EXTENTS.map( ( extent, level ) => P.xz.sub( this.origins[ level ] ).div( extent / RES ).toVar() );
			const read = ( level: number ) => () => {

				out.assign( texture( this.target.texture, st[ level ].div( RES ) ).depth( int( level ) ).level( float( 0 ) ) );

			};
			If( this.wavesReady.greaterThan( 0.5 ).and( P.y.lessThan( shared.waterLevel.add( WAVE_REACH ) ) ), () => {

				If( inside( st[ 0 ] ), read( 0 ) ).ElseIf( inside( st[ 1 ] ), read( 1 ) );

			} );
			return out;

		} )();

	}

}
