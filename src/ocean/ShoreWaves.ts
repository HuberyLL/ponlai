/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec4, dot, length, max, abs, sin, cos, floor, pow, mix, smoothstep } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';
import type { WorldData } from '../world/types.ts';
import { createShoreWaveField } from './ShoreWaveField.ts';

// Tidewater's travel-time phase and shoaling profile, scaled for a quiet cliff island.
// Geometry, normals and whitewater read the same advancing crest; noise only tears its lace.
export class ShoreWaves {

	readonly period = uniform( 3.8 );
	readonly amplitude = uniform( 0.16 );
	readonly direction = uniform( new THREE.Vector2() );
	readonly field: THREE.TextureNode;
	readonly texture: THREE.TextureNode;
	fieldRevision = 0;
	readonly sample: ( p: THREE.Node<'vec2'>, time: THREE.Node<'float'> ) => THREE.Node<'vec4'>;
	readonly profile: ( p: THREE.Node<'vec2'>, time: THREE.Node<'float'> ) => THREE.Node<'vec2'>;
	private data: WorldData;
	private revision = - 1;
	private fieldPeriod = 0;
	private renderer: THREE.WebGPURenderer;
	private target: THREE.RenderTarget;
	private quad: THREE.QuadMesh;
	private surfaceTime = uniform( 0 );
	private lastTime: number | undefined;
	private drawnAmplitude = - 1;

	constructor( renderer: THREE.WebGPURenderer, data: WorldData, shared: Shared, shore: THREE.Texture, fft: OceanFFT ) {

		this.renderer = renderer;
		this.data = data;
		this.setDirection( fft );
		this.field = texture( createShoreWaveField( data, this.direction.value, this.period.value ) );
		this.revision = fft.spectrumRevision;
		this.fieldPeriod = this.period.value;
		const evaluate = Fn( ( [ p, time, field, sd, period, amplitude, incoming ]: [ THREE.Node<'vec2'>, THREE.Node<'float'>, THREE.Node<'vec4'>, THREE.Node<'float'>, THREE.Node<'float'>, THREE.Node<'float'>, THREE.Node<'vec2'> ] ) => {
			const grad = field.gb;
			const dir = grad.div( max( length( grad ), 1e-5 ) );
			const exposure = mix( float( 0.35 ), float( 1 ), smoothstep( - 0.2, 0.7, dot( dir, incoming ) ) );
			const envelope = float( 1 ).sub( smoothstep( 12, 28, sd ) );
			const s = time.sub( field.r ).div( period );
			const m = floor( s.add( 0.5 ) ), u = s.sub( m );
			// A group of seven swells has quieter shoulders; adjacent heights meet at the trough.
			const along = dot( p, vec2( incoming.y.negate(), incoming.x ) );
			const ampAt = Fn( ( [ wave, along, amplitude ]: [ THREE.Node<'float'>, THREE.Node<'float'>, THREE.Node<'float'> ] ) => {

				const set = abs( sin( wave.mul( Math.PI / 7 ) ) ).mul( 0.28 ).add( 0.72 );
				const variation = sin( along.mul( 0.18 ).add( wave.mul( 1.7 ) ) ).mul( 0.13 ).add( 0.87 );
				return amplitude.mul( set ).mul( variation );

			} ).setLayout( { name: 'shoreSwellAmplitude', type: 'float', inputs: [ { name: 'wave', type: 'float' }, { name: 'along', type: 'float' }, { name: 'amplitude', type: 'float' } ] } );
			const neighbour = m.add( u.sign() );
			const A = mix( ampAt( m, along, amplitude ), ampAt( neighbour, along, amplitude ), smoothstep( 0.32, 0.5, abs( u ) ).mul( 0.5 ) )
				.mul( pow( float( 6 ).div( max( field.a, 0.7 ) ), 0.25 ).min( 1.65 ) ).mul( envelope ).mul( exposure );
			// Green's law raises a swell over the shelf; the peaked profile flattens its trough.
			// A steep cliff has no beach run-up or plunging sheet, so its crest stays modest.
			const shoal = smoothstep( 9, 1.5, field.a );
			const power = mix( float( 1 ), float( 2 ), shoal );
			const skew = shoal.mul( 0.35 );
			const phase = u.sub( skew.mul( float( 1 ).sub( cos( u.mul( 2 * Math.PI ) ) ) ).div( 2 * Math.PI ) );
			const theta = phase.mul( 2 * Math.PI );
			const c = max( cos( theta ).add( 1 ).mul( 0.5 ), 0 );
			const mean = float( 1 ).div( power.add( 0.25 ).mul( Math.PI ).sqrt() );
			const height = pow( c, power ).sub( mean ).mul( A ).mul( 2 );
			const crest = smoothstep( 0.975, 0.9995, c ).mul( exposure ).mul( envelope ).mul( amplitude.div( 0.06 ).clamp( 0, 1 ) );
			return vec2( height, crest );

		} ).setLayout( {
			name: 'shoreSwellProfile', type: 'vec2',
			inputs: [ { name: 'p', type: 'vec2' }, { name: 'time', type: 'float' }, { name: 'field', type: 'vec4' },
				{ name: 'sd', type: 'float' }, { name: 'period', type: 'float' }, { name: 'amplitude', type: 'float' }, { name: 'incoming', type: 'vec2' } ],
		} );
		const profileAt = ( p: THREE.Node<'vec2'>, time: THREE.Node<'float'> ) => {

			const q = p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
			// Explicit dependencies keep this pure function safe across different materials.
			return evaluate( p, time, this.field.sample( q ).level( float( 0 ) ),
				texture( shore, q ).level( float( 0 ) ).r, this.period, this.amplitude, this.direction );

		};
		this.profile = profileAt;
		this.sample = ( p, time ) => {

			const centre = profileAt( p, time ).toVar();
			// Include changing depth, exposure, envelope and wave heights in the actual normal.
			// Differentiating phase alone misses the curved shoulders around an island.
			const e = 0.15;
			const dx = profileAt( p.add( vec2( e, 0 ) ), time ).x.sub( centre.x ).div( e );
			const dz = profileAt( p.add( vec2( 0, e ) ), time ).x.sub( centre.x ).div( e );
			return vec4( centre.x, dx, dz, centre.y );

		};
		// Evaluate the shared phase/normal once over the island instead of repeating three
		// profile evaluations at every display pixel. 0.1875 m texels keep the crest lace fine.
		this.target = new THREE.RenderTarget( 512, 512, {
			type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
			depthBuffer: false, generateMipmaps: false,
		} );
		this.target.texture.name = 'shoreWaveSurface';
		this.texture = texture( this.target.texture );
		const material = new THREE.NodeMaterial();
		material.fragmentNode = Fn( () => this.sample( uv().div( shared.shoreXform.zw ).add( shared.shoreXform.xy ), this.surfaceTime ) )();
		this.quad = new THREE.QuadMesh( material );

	}

	update( fft: OceanFFT, time?: number ): void {

		if ( this.revision !== fft.spectrumRevision || this.fieldPeriod !== this.period.value ) {

			this.setDirection( fft );
			const previous = this.field.value;
			this.field.value = createShoreWaveField( this.data, this.direction.value, this.period.value );
			previous.dispose();
			this.revision = fft.spectrumRevision;
			this.fieldPeriod = this.period.value;
			this.fieldRevision ++;
			this.lastTime = undefined;

		}
		if ( time === undefined || ( time === this.lastTime && this.amplitude.value === this.drawnAmplitude ) ) return;
		this.surfaceTime.value = time;
		const previousTarget = this.renderer.getRenderTarget();
		this.renderer.setRenderTarget( this.target );
		this.quad.render( this.renderer );
		this.renderer.setRenderTarget( previousTarget );
		this.lastTime = time;
		this.drawnAmplitude = this.amplitude.value;

	}

	private setDirection( fft: OceanFFT ): void {

		// The existing positive-IFFT/+omega convention carries its wind sea toward -wind.
		const angle = fft.params.windDirection * Math.PI / 180;
		this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );

	}

}
