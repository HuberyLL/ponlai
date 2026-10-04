/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, If, texture, uniform, uv, float, vec2, vec4, dot, length, max, min, mix, smoothstep, exp, select } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';
import type { WorldData } from '../world/types.ts';
import { createShoreBoundaryField, createShoreShelterField } from './ShoreWaveField.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

// Tidewater's FFT supplies every incident wave. This rocky boundary is a Soomi extension:
// a weak mirrored response and whitewater use that wave's height and orbital velocity,
// without adding the independent, single-period beach wave over the open sea.
export class ShoreWaves {

	readonly direction = uniform( new THREE.Vector2() );
	readonly reflection = uniform( 0.14 );
	readonly boundary: THREE.TextureNode;
	readonly shelter: THREE.TextureNode;
	// RGBA: local reflected height, its x/z slopes, incident rock-contact energy.
	readonly texture: THREE.TextureNode;
	// RGBA: horizontal particle velocity, contact energy, filtered incident height.
	readonly motion: THREE.TextureNode;
	readonly surfaceAt: ( p: V2, time: F ) => THREE.Node<'vec4'>;
	readonly sample: ( p: V2, time: F ) => THREE.Node<'vec4'>;
	readonly incidentAt: ( p: V2 ) => THREE.Node<'vec4'>;
	fieldRevision = 0;
	private data: WorldData;
	private revision = - 1;
	private renderer: THREE.WebGPURenderer;
	private targets: THREE.RenderTarget[];
	private quads: THREE.QuadMesh[];
	private lastTime: number | undefined;
	private lastReflection = - 1;

	constructor( renderer: THREE.WebGPURenderer, data: WorldData, shared: Shared, shore: THREE.Texture, fft: OceanFFT ) {

		this.renderer = renderer;
		this.data = data;
		this.setDirection( fft );
		this.boundary = texture( createShoreBoundaryField( data ) );
		this.shelter = texture( createShoreShelterField( data, this.direction.value ) );
		this.revision = fft.spectrumRevision;
		const toUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
		const coastDamp = Fn( ( [ sd ]: [ F ] ) => mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) ) )
			.setLayout( { name: 'rockCoastDamping', type: 'float', inputs: [ { name: 'sd', type: 'float' } ] } );
		const contactEnergy = Fn( ( [ height, velocity, normal, sd, confidence, exposure ]: [ F, V2, V2, F, F, F ] ) => {

			const approaching = max( dot( velocity, normal ).negate(), 0 );
			return smoothstep( 0.008, 0.040, height ).mul( smoothstep( 0.025, 0.16, approaching ) )
				.mul( confidence ).mul( exposure.mul( exposure ) ).mul( exp( sd.div( 0.42 ).pow( 2 ).negate() ) )
				.mul( smoothstep( 0, 0.12, sd ) );

		} ).setLayout( { name: 'rockContactEnergy', type: 'float', inputs: [ { name: 'height', type: 'float' }, { name: 'velocity', type: 'vec2' },
			{ name: 'normal', type: 'vec2' }, { name: 'sd', type: 'float' }, { name: 'confidence', type: 'float' }, { name: 'exposure', type: 'float' } ] } );
		// Sampling stays in each material graph; reusable layout functions take explicit values,
		// so their uniforms/samplers cannot be cached from a different render pass.
		const incidence = ( p: V2 ) => Fn( () => {

			const q = toUV( p );
			const sd = texture( shore, q ).level( float( 0 ) ).r;
			const exposure = this.shelter.sample( q ).level( float( 0 ) ).r;
			const large = mix( float( 0.12 ), float( 1 ), exposure );
			const medium = mix( float( 0.8 ), float( 1 ), exposure );
			const surface = vec4( 0 ).toVar();
			// Low-pass contact energy: small capillary detail must not spawn separate white dots.
			for ( let i = 0; i < 3; i ++ ) {

				const at = p.div( fft.sizes[ i ] );
				const damping = ( i === 0 ? large : i === 1 ? medium.mul( 0.7 ) : float( 0.12 ) ).mul( coastDamp( sd ) );
				const height = texture( fft.displacementTextures[ i ], at ).level( float( 0 ) ).y;
				const velocity = texture( fft.velocityTextures[ i ], at ).level( float( 0 ) ).xyz;
				surface.addAssign( vec4( height, velocity ).mul( damping ) );

			}
			return surface;

		} )();
		this.incidentAt = p => incidence( p );
		const reflectionHeight = ( p: V2 ) => Fn( () => {

			const q = toUV( p );
			const sd = texture( shore, q ).level( float( 0 ) ).r;
			const height = float( 0 ).toVar();
			If( sd.greaterThan( - 0.8 ).and( sd.lessThan( 3.5 ) ), () => {

				const boundary = this.boundary.sample( q ).level( float( 0 ) );
				const normal = boundary.ba.div( max( length( boundary.ba ), 1e-5 ) );
				const waterP = p.add( normal.mul( max( sd.negate(), 0 ) ) );
				const waterSD = max( sd, 0 );
				const mirror = waterP.sub( normal.mul( waterSD.mul( 2 ) ) ), mq = toUV( mirror );
				const exposure = this.shelter.sample( mq ).level( float( 0 ) ).r;
				const reflected = texture( fft.displacementTextures[ 0 ], mirror.div( fft.sizes[ 0 ] ) ).level( float( 0 ) ).y
					.mul( mix( float( 0.12 ), float( 1 ), exposure ) )
					.add( texture( fft.displacementTextures[ 1 ], mirror.div( fft.sizes[ 1 ] ) ).level( float( 0 ) ).y
						.mul( mix( float( 0.8 ), float( 1 ), exposure ) ).mul( 0.7 ) );
				// Extend height into solid rock for filtering/derivatives only, with no land flow or foam.
				// A ghost sample mirrored across a locally planar wall shares the incoming phase.
				// It is a weak boundary approximation, not a reflection/diffraction fluid solver.
				height.assign( reflected.mul( coastDamp( texture( shore, mq ).level( float( 0 ) ).r ) )
					.mul( boundary.g ).mul( this.reflection ).mul( exp( sd.mul( - 0.8 ) ) )
					.mul( float( 1 ).sub( smoothstep( 2, 3.5, sd ) ) ) );

			} );
			return height;

		} )();
		const evaluate = ( p: V2 ) => Fn( () => {

			const q = toUV( p ), edge = min( q.div( shared.shoreXform.zw ), vec2( 1 ).sub( q ).div( shared.shoreXform.zw ) );
			const boundary = this.boundary.sample( q ).level( float( 0 ) );
			const sd = texture( shore, q ).level( float( 0 ) ).r;
			const normal = boundary.ba.div( max( length( boundary.ba ), 1e-5 ) );
			const incident = incidence( p ).toVar();
			const flow = incident.yz.toVar(), impact = float( 0 ).toVar();
			If( sd.greaterThan( 0 ).and( sd.lessThan( 3.5 ) ), () => {

				const reflected = incidence( p.sub( normal.mul( sd.mul( 2 ) ) ) ).toVar();
				const response = boundary.g.mul( this.reflection ).mul( exp( sd.mul( - 0.8 ) ) )
					.mul( float( 1 ).sub( smoothstep( 2, 3.5, sd ) ) );
				const reflectedVelocity = reflected.yz.sub( normal.mul( dot( reflected.yz, normal ).mul( 2 ) ) );
				flow.addAssign( reflectedVelocity.mul( response ) );
				If( sd.lessThan( 1.4 ), () => {

					const contactP = p.sub( normal.mul( sd ) ).add( normal.mul( 0.32 ) );
					const contact = incidence( contactP ).toVar();
					// Compute contact before enforcing no flow into rock; projecting first erases impact.
					const contactExposure = this.shelter.sample( toUV( contactP ) ).level( float( 0 ) ).r;
					impact.assign( contactEnergy( contact.x, contact.yz, normal, sd, boundary.g, contactExposure ) );

				} );

			} );
			const coast = float( 1 ).sub( smoothstep( 0.12, 0.7, sd ) );
			flow.subAssign( normal.mul( dot( flow, normal ).min( 0 ) ).mul( coast ) );
			const inWater = sd.greaterThan( 0 ).and( min( edge.x, edge.y ).greaterThan( 1 ) );
			return vec4( reflectionHeight( p ), select( inWater, flow, vec2( 0 ) ), select( inWater, impact, float( 0 ) ) );

		} )();
		const e = 0.12;
		this.sample = ( p, _time ) => {

			const centre = evaluate( p ).toVar();
			const dx = reflectionHeight( p.add( vec2( e, 0 ) ) ).sub( reflectionHeight( p.sub( vec2( e, 0 ) ) ) ).div( 2 * e );
			const dz = reflectionHeight( p.add( vec2( 0, e ) ) ).sub( reflectionHeight( p.sub( vec2( 0, e ) ) ) ).div( 2 * e );
			return vec4( centre.x, dx, dz, centre.w );

		};
		this.targets = [ 'rockWaveSurface', 'rockWaveMotion' ].map( name => {

			const target = new THREE.RenderTarget( 512, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false } );
			target.texture.name = name;
			return target;

		} );
		this.texture = texture( this.targets[ 0 ].texture );
		this.motion = texture( this.targets[ 1 ].texture );
		this.quads = this.targets.map( ( _, i ) => {

			const material = new THREE.NodeMaterial();
			material.fragmentNode = Fn( () => {

				const p = uv().div( shared.shoreXform.zw ).add( shared.shoreXform.xy );
				if ( i === 0 ) return this.sample( p, float( 0 ) );
				const response = evaluate( p ).toVar();
				return vec4( response.yz, response.w, incidence( p ).x );

			} )();
			return new THREE.QuadMesh( material );

		} );
		this.surfaceAt = ( p, _time ) => this.texture.sample( toUV( p ) ).level( float( 0 ) );

	}

	update( fft: OceanFFT, time?: number ): void {

		if ( this.revision !== fft.spectrumRevision ) {

			const previous = this.direction.value.clone();
			this.setDirection( fft );
			if ( ! previous.equals( this.direction.value ) ) {

				const old = this.shelter.value;
				this.shelter.value = createShoreShelterField( this.data, this.direction.value );
				old.dispose();

			}
			this.revision = fft.spectrumRevision;
			this.fieldRevision ++;
			this.lastTime = undefined;

		}
		if ( time === undefined || ( time === this.lastTime && this.lastReflection === this.reflection.value ) ) return;
		const previousTarget = this.renderer.getRenderTarget();
		for ( let i = 0; i < this.targets.length; i ++ ) {

			this.renderer.setRenderTarget( this.targets[ i ] );
			this.quads[ i ].render( this.renderer );

		}
		this.renderer.setRenderTarget( previousTarget );
		this.lastTime = time;
		this.lastReflection = this.reflection.value;

	}

	private setDirection( fft: OceanFFT ): void {

		const angle = ( fft.params.windDirection + fft.swell.directionOffset ) * Math.PI / 180;
		this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );

	}

}
