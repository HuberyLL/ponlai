/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec3, vec4, dot, length, max, abs, sin, cos, floor, fract, pow, mix, smoothstep, exp, tanh } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';
import type { WorldData } from '../world/types.ts';
import { createShoreWaveField, createShoreContactField, createShoreShelterField } from './ShoreWaveField.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
const TAU = Math.PI * 2;

// Tidewater's grouped, asymmetric shoaling cross-section, with a rocky boundary condition.
// A clear swell reaches the cliff first. Only its contact makes whitewater; the offshore
// crest stays transparent. The reflected wave and returning parcels share that contact clock.
export class ShoreWaves {

	readonly period = uniform( 2.8 );
	readonly amplitude = uniform( 0.20 );
	readonly direction = uniform( new THREE.Vector2() );
	readonly field: THREE.TextureNode;
	readonly contact: THREE.TextureNode;
	readonly shelter: THREE.TextureNode;
	readonly texture: THREE.TextureNode;
	// RG: surface-particle velocity (m/s), B: contact whitewater, A: surface height.
	readonly motion: THREE.TextureNode;
	fieldRevision = 0;
	readonly sample: ( p: V2, time: F ) => THREE.Node<'vec4'>;
	readonly profile: ( p: V2, time: F ) => THREE.Node<'vec2'>;
	private data: WorldData;
	private revision = - 1;
	private fieldPeriod = 0;
	private renderer: THREE.WebGPURenderer;
	private targets: THREE.RenderTarget[];
	private quads: THREE.QuadMesh[];
	private surfaceTime = uniform( 0 );
	private lastTime: number | undefined;
	private drawnAmplitude = - 1;

	constructor( renderer: THREE.WebGPURenderer, data: WorldData, shared: Shared, shore: THREE.Texture, fft: OceanFFT ) {

		this.renderer = renderer;
		this.data = data;
		this.setDirection( fft );
		const field = createShoreWaveField( data, this.direction.value, this.period.value );
		this.field = texture( field );
		const shelter = createShoreShelterField( data, field );
		this.shelter = texture( shelter );
		this.contact = texture( createShoreContactField( data, field, shelter ) );
		this.revision = fft.spectrumRevision;
		this.fieldPeriod = this.period.value;

		const ampAt = Fn( ( [ wave, along, amplitude ]: [ F, F, F ] ) => {

			// Tidewater's seven-wave sets and uneven shoulders, shortened to this island's scale.
			const set = abs( sin( wave.mul( Math.PI / 7 ) ) ).mul( 0.36 ).add( 0.64 );
			const random = fract( sin( wave.mul( 127.1 ).add( 31.7 ) ).mul( 43758.5453 ) );
			const warp = sin( along.mul( 0.11 ).add( wave.mul( 0.9 ) ) ).mul( 1.2 );
			const broad = sin( along.mul( 0.32 ).add( wave.mul( 1.7 ) ).add( warp ) );
			const shoulder = sin( along.mul( 0.71 ).add( wave.mul( 4.1 ) ).sub( warp.mul( 0.7 ) ) );
			return amplitude.mul( set ).mul( random.mul( 0.18 ).add( 0.82 ) )
				.mul( broad.mul( 0.12 ).add( shoulder.mul( 0.06 ) ).add( 0.88 ) );

		} ).setLayout( { name: 'shoreSwellAmplitude', type: 'float', inputs: [ { name: 'wave', type: 'float' }, { name: 'along', type: 'float' }, { name: 'amplitude', type: 'float' } ] } );

		// Pure functions with explicit dependencies are safe when reused by several materials.
		const crossSection = Fn( ( [ s, along, depth, invSpeed, period, amplitude ]: [ F, F, F, F, F, F ] ) => {

			const m = floor( s.add( 0.5 ) ), u = s.sub( m );
			const A = mix( ampAt( m, along, amplitude ), ampAt( m.add( u.sign() ), along, amplitude ), smoothstep( 0.32, 0.5, abs( u ) ).mul( 0.5 ) )
				.mul( pow( float( 6 ).div( max( depth, 0.7 ) ), 0.25 ).min( 1.65 ) );
			const wavelength = period.div( invSpeed );
			// The H/d ratio controls extra sharpening. A gentle shape floor keeps the stylised
			// clear shoulder readable; distance to land must not invent a beach breaker.
			const nonlinear = smoothstep( 0.08, 0.42, A.mul( 2 ).div( max( depth, 0.7 ) ) );
			const power = nonlinear.mul( 0.9 ).add( 1.35 );
			const skew = nonlinear.mul( 0.24 ).add( 0.16 );
			const Q = nonlinear.mul( 0.25 ).add( 0.45 );
			// Invert Tidewater's horizontal xPre before evaluating in world space. This compresses
			// the crest and yields the same surface for geometry, normals and foam deposition.
			const uLag = u.add( sin( u.mul( TAU ) ).mul( A ).mul( Q ).div( wavelength ) ).toVar();
			uLag.assign( u.add( sin( uLag.mul( TAU ) ).mul( A ).mul( Q ).div( wavelength ) ) );
			const phi = uLag.sub( skew.mul( float( 1 ).sub( cos( uLag.mul( TAU ) ) ) ).div( TAU ) );
			const c = max( cos( phi.mul( TAU ) ).add( 1 ).mul( 0.5 ), 0 );
			const mean = float( 1 ).div( power.add( 0.25 ).mul( Math.PI ).sqrt() );
			const height = pow( c, power ).sub( mean ).mul( A ).mul( 2 );
			// Finite-depth orbital motion, not the wave's phase speed: foam floats with parcels.
			const omega = float( TAU ).div( period );
			const kDeep = omega.mul( omega ).div( 9.81 );
			const k0 = kDeep.div( max( tanh( omega.mul( depth.div( 9.81 ).sqrt() ) ), 0.05 ) ).toVar();
			const kd0 = k0.mul( depth ), th0 = tanh( kd0 );
			// The travel-time gradient can cancel where refracted fronts meet. Solve the
			// dispersion relation from actual depth instead of creating a spurious fast current.
			const kOrbital = k0.sub( k0.mul( th0 ).sub( kDeep ).div( th0.add( kd0.mul( float( 1 ).sub( th0.mul( th0 ) ) ) ) ) );
			const velocity = height.mul( omega ).div( max( tanh( kOrbital.mul( depth ) ), 0.15 ) );
			return vec3( height, velocity, A );

		} ).setLayout( { name: 'shoreSwellSection', type: 'vec3', inputs: [ { name: 's', type: 'float' }, { name: 'along', type: 'float' }, { name: 'depth', type: 'float' }, { name: 'invSpeed', type: 'float' }, { name: 'period', type: 'float' }, { name: 'amplitude', type: 'float' } ] } );

		const evaluate = Fn( ( [ p, time, field, boundary, transmission, sd, period, amplitude, incoming ]: [ V2, F, THREE.Node<'vec4'>, THREE.Node<'vec4'>, F, F, F, F, V2 ] ) => {

			const invSpeed = max( length( field.gb ), 0.08 );
			const dir = field.gb.div( invSpeed );
			// Travel-time gradients describe phase, not energy. Reduce the input amplitude
			// before shaping the wave, so sheltered crests also lose their sharp shoulders.
			const exposure = transmission.mul( mix( float( 0.18 ), float( 1 ), smoothstep( - 0.2, 0.7, dot( dir, incoming ) ) ) );
			const localAmplitude = amplitude.mul( exposure );
			const envelope = float( 1 ).sub( smoothstep( 18, 32, sd ) );
			const tangent = vec2( incoming.y.negate(), incoming.x );
			const normal = boundary.ba.div( max( length( boundary.ba ), 1e-5 ) );
			const along = dot( p, tangent );
			const contactAlong = dot( p.sub( normal.mul( max( sd, 0 ) ) ), tangent );
			const wobble = sin( along.mul( 0.29 ) ).mul( 0.015 ).add( sin( along.mul( 0.67 ).add( 2.6 ) ).mul( 0.006 ) );
			const contactWobble = sin( contactAlong.mul( 0.29 ) ).mul( 0.015 ).add( sin( contactAlong.mul( 0.67 ).add( 2.6 ) ).mul( 0.006 ) );
			const incident = crossSection( time.sub( field.r ).div( period ).add( wobble ), along, field.a, invSpeed, period, localAmplitude );
			// Reflection shares the incident phase at contact. It loses energy over rough rock;
			// its low amplitude avoids fixed standing-wave scallops around the whole island.
			const reflectedTime = boundary.r.mul( 2 ).sub( field.r );
			const reflected = crossSection( time.sub( reflectedTime ).div( period ).add( contactWobble ), contactAlong, field.a, invSpeed, period, localAmplitude );
			const reflection = boundary.g.mul( boundary.g ).mul( exp( max( sd, 0 ).mul( - 0.4 ) ) ).mul( 0.20 );
			const reflectedDir = dir.sub( normal.mul( dot( dir, normal ).mul( 2 ) ) );
			const contactPhase = time.sub( boundary.r ).div( period ).add( contactWobble );
			const contactU = contactPhase.sub( floor( contactPhase.add( 0.5 ) ) );
			// Whitewater starts at rock contact, spreads briefly outward, then leaves the clear
			// next wave alone. This is a small cliff surge, not Tidewater's sand-beach barrel.
			const impactWindow = smoothstep( - 0.035, 0.025, contactU ).mul( float( 1 ).sub( smoothstep( 0.14, 0.24, contactU ) ) );
			const impactWidth = smoothstep( 0, 0.2, contactU ).mul( 0.48 ).add( 0.22 );
			const contactA = ampAt( floor( contactPhase.add( 0.5 ) ), contactAlong, localAmplitude );
			const waveId = floor( contactPhase.add( 0.5 ) );
			const contactPatch = sin( contactAlong.mul( 2.1 ).add( waveId.mul( 2.3 ) ) )
				.add( sin( contactAlong.mul( 3.8 ).sub( waveId.mul( 1.7 ) ) ).mul( 0.45 ) );
			const energy = smoothstep( 0.065, 0.25, contactA.mul( pow( float( 6 ).div( max( field.a, 0.7 ) ), 0.25 ) ) ).mul( smoothstep( 0.2, 0.85, boundary.g ) )
				.mul( mix( float( 0.12 ), float( 1 ), smoothstep( - 0.55, 0.7, contactPatch ) ) );
			const impact = impactWindow.mul( exp( max( sd, 0 ).div( impactWidth ).pow( 2 ).negate() ) ).mul( energy )
				.mul( smoothstep( 0, 0.15, sd ) );
			const height = incident.x.add( reflected.x.mul( reflection ) ).mul( envelope );
			const flow = dir.mul( incident.y ).add( reflectedDir.mul( reflected.y ).mul( reflection ) ).mul( envelope ).toVar();
			const coast = float( 1 ).sub( smoothstep( 0.05, 0.65, sd ) );
			flow.subAssign( normal.mul( dot( flow, normal ).min( 0 ) ).mul( coast ) );
			flow.addAssign( normal.mul( impact ).mul( 0.38 ) );
			return vec4( height, flow.x, flow.y, impact );

		} ).setLayout( { name: 'shoreSwellDynamics', type: 'vec4', inputs: [ { name: 'p', type: 'vec2' }, { name: 'time', type: 'float' }, { name: 'field', type: 'vec4' }, { name: 'boundary', type: 'vec4' }, { name: 'transmission', type: 'float' }, { name: 'sd', type: 'float' }, { name: 'period', type: 'float' }, { name: 'amplitude', type: 'float' }, { name: 'incoming', type: 'vec2' } ] } );

		const dynamicsAt = ( p: V2, time: F ) => {

			const q = p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
			return evaluate( p, time, this.field.sample( q ).level( float( 0 ) ), this.contact.sample( q ).level( float( 0 ) ), this.shelter.sample( q ).level( float( 0 ) ).r,
				texture( shore, q ).level( float( 0 ) ).r, this.period, this.amplitude, this.direction );

		};
		this.profile = ( p, time ) => dynamicsAt( p, time ).xw;
		this.sample = ( p, time ) => {

			const centre = dynamicsAt( p, time ).toVar();
			const e = 0.12;
			const dx = dynamicsAt( p.add( vec2( e, 0 ) ), time ).x.sub( dynamicsAt( p.sub( vec2( e, 0 ) ), time ).x ).div( 2 * e );
			const dz = dynamicsAt( p.add( vec2( 0, e ) ), time ).x.sub( dynamicsAt( p.sub( vec2( 0, e ) ), time ).x ).div( 2 * e );
			return vec4( centre.x, dx, dz, centre.w );

		};
		this.targets = [ 'shoreWaveSurface', 'shoreWaveMotion' ].map( ( name ) => {

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
				return i === 0 ? this.sample( p, this.surfaceTime ) : dynamicsAt( p, this.surfaceTime ).yzwx;

			} )();
			return new THREE.QuadMesh( material );

		} );

	}

	update( fft: OceanFFT, time?: number ): void {

		if ( this.revision !== fft.spectrumRevision || this.fieldPeriod !== this.period.value ) {

			this.setDirection( fft );
			const oldField = this.field.value, oldContact = this.contact.value, oldShelter = this.shelter.value;
			const field = createShoreWaveField( this.data, this.direction.value, this.period.value );
			this.field.value = field;
			const shelter = createShoreShelterField( this.data, field );
			this.shelter.value = shelter;
			this.contact.value = createShoreContactField( this.data, field, shelter );
			oldField.dispose(); oldContact.dispose(); oldShelter.dispose();
			this.revision = fft.spectrumRevision;
			this.fieldPeriod = this.period.value;
			this.fieldRevision ++;
			this.lastTime = undefined;

		}
		if ( time === undefined || ( time === this.lastTime && this.amplitude.value === this.drawnAmplitude ) ) return;
		this.surfaceTime.value = time;
		const previousTarget = this.renderer.getRenderTarget();
		for ( let i = 0; i < this.targets.length; i ++ ) {

			this.renderer.setRenderTarget( this.targets[ i ] );
			this.quads[ i ].render( this.renderer );

		}
		this.renderer.setRenderTarget( previousTarget );
		this.lastTime = time;
		this.drawnAmplitude = this.amplitude.value;

	}

	private setDirection( fft: OceanFFT ): void {

		const angle = fft.params.windDirection * Math.PI / 180;
		this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );

	}

}
