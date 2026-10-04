/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { Fn, texture, uniform, uv, float, vec2, vec3, vec4, dot, length, max, abs, sin, cos, floor, fract, pow, mix, smoothstep, exp, tanh, min, select } from 'three/tsl';
import type { OceanFFT } from './OceanFFT.ts';
import type { Shared } from '../shared.ts';
import type { WorldData } from '../world/types.ts';
import { createShoreWaveField, createShoreContactField, createShoreShelterField } from './ShoreWaveField.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
const TAU = Math.PI * 2;
const WAVE_COUNT = 14;
const ALONG_TILE = 128;

// Tidewater's grouped, asymmetric shoaling cross-section, with a rocky boundary condition.
// A clear swell reaches the cliff first. Only its contact makes whitewater; the offshore
// crest stays transparent. The reflected wave and returning parcels share that contact clock.
export class ShoreWaves {

	readonly period = uniform( 2.8 );
	readonly amplitude = uniform( 0.14 );
	readonly direction = uniform( new THREE.Vector2() );
	readonly field: THREE.TextureNode;
	readonly contact: THREE.TextureNode;
	readonly shelter: THREE.TextureNode;
	// RGBA: nearshore height/slope residual relative to the continuous offshore swell, impact.
	readonly texture: THREE.TextureNode;
	readonly globalSurface: THREE.TextureNode;
	readonly offshore = uniform( new THREE.Vector3() ); // reference speed, phase origin, depth
	readonly sampleGlobal: ( p: V2, time: F ) => THREE.Node<'vec4'>;
	readonly surfaceAt: ( p: V2, time: F ) => THREE.Node<'vec4'>;
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
	private globalTarget: THREE.RenderTarget;
	private globalQuad: THREE.QuadMesh;
	private globalDirty = true;

	constructor( renderer: THREE.WebGPURenderer, data: WorldData, shared: Shared, shore: THREE.Texture, fft: OceanFFT ) {

		this.renderer = renderer;
		this.data = data;
		this.setDirection( fft );
		const field = createShoreWaveField( data, this.direction.value, this.period.value );
		this.field = texture( field );
		const info = field.userData.shoreWaveField;
		this.offshore.value.set( info.referenceSpeed, info.timeOffset, info.referenceDepth ?? 10 );
		const shelter = createShoreShelterField( data, field );
		this.shelter = texture( shelter );
		this.contact = texture( createShoreContactField( data, field, shelter ) );
		this.revision = fft.spectrumRevision;
		this.fieldPeriod = this.period.value;

		const ampAt = Fn( ( [ wave, along, amplitude ]: [ F, F, F ] ) => {

			// A phase/along-coordinate tile continues over the whole sea. Integer harmonics and
			// wrapped wave ids join the tile smoothly, without a fixed world-space birth zone.
			wave = wave.sub( floor( wave.div( WAVE_COUNT ) ).mul( WAVE_COUNT ) );
			const set = abs( sin( wave.mul( Math.PI / 7 ) ) ).mul( 0.45 ).add( 0.55 );
			const random = fract( sin( wave.mul( 127.1 ).add( 31.7 ) ).mul( 43758.5453 ) );
			const warp = sin( along.mul( TAU * 2 / ALONG_TILE ).add( wave.mul( 0.9 ) ) ).mul( 1.2 );
			const broad = sin( along.mul( TAU * 7 / ALONG_TILE ).add( wave.mul( 1.7 ) ).add( warp ) );
			const shoulder = sin( along.mul( TAU * 14 / ALONG_TILE ).add( wave.mul( 4.1 ) ).sub( warp.mul( 0.7 ) ) );
			return amplitude.mul( set ).mul( random.mul( 0.18 ).add( 0.82 ) )
				.mul( broad.mul( 0.12 ).add( shoulder.mul( 0.06 ) ).add( 0.88 ) );

		} ).setLayout( { name: 'shoreSwellAmplitude', type: 'float', inputs: [ { name: 'wave', type: 'float' }, { name: 'along', type: 'float' }, { name: 'amplitude', type: 'float' } ] } );

		// Pure functions with explicit dependencies are safe when reused by several materials.
		const crossSection = Fn( ( [ s, along, depth, invSpeed, period, amplitude ]: [ F, F, F, F, F, F ] ) => {

			const m = floor( s.add( 0.5 ) ), u = s.sub( m );
			const A = mix( ampAt( m, along, amplitude ), ampAt( m.add( u.sign() ), along, amplitude ), smoothstep( 0.32, 0.5, abs( u ) ).mul( 0.5 ) )
				.mul( pow( float( 6 ).div( max( depth, 0.7 ) ), 0.25 ).min( 1.65 ) );
			const wavelength = period.div( invSpeed );
			// The H/d ratio controls sharpening. Calm offshore swells stay round instead of
			// inheriting a surf-like crest on every wave; depth must justify the steepening.
			const nonlinear = smoothstep( 0.08, 0.42, A.mul( 2 ).div( max( depth, 0.7 ) ) );
			const power = nonlinear.mul( 0.9 ).add( 1.0 );
			const skew = nonlinear.mul( 0.24 ).add( 0.035 );
			const Q = nonlinear.mul( 0.25 ).add( 0.15 );
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

		const wobbleAt = ( along: F ) => sin( along.mul( TAU * 6 / ALONG_TILE ) ).mul( 0.015 )
			.add( sin( along.mul( TAU * 14 / ALONG_TILE ).add( 2.6 ) ).mul( 0.006 ) );
		const globalHeight = Fn( ( [ phase, along, reference, period, amplitude ]: [ F, F, THREE.Node<'vec3'>, F, F ] ) =>
			crossSection( phase.add( wobbleAt( along ) ), along, reference.z, float( 1 ).div( reference.x ), period, amplitude ).x
		).setLayout( { name: 'offshoreSwellHeight', type: 'float', inputs: [ { name: 'phase', type: 'float' }, { name: 'along', type: 'float' }, { name: 'reference', type: 'vec3' }, { name: 'period', type: 'float' }, { name: 'amplitude', type: 'float' } ] } );
		const globalAt = ( p: V2, time: F ) => {

			const phase = time.sub( dot( p, this.direction ).div( this.offshore.x ).sub( this.offshore.y ) ).div( this.period );
			const along = dot( p, vec2( this.direction.y.negate(), this.direction.x ) );
			return globalHeight( phase, along, this.offshore, this.period, this.amplitude );

		};
		const e = 0.12;
		// Bake the wave's phase coordinates once per spectrum/amplitude change, not a finite
		// world patch each frame. Sampling coordinates move with time and can cover all sea.
		this.globalTarget = new THREE.RenderTarget( 1024, 512, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false } );
		this.globalTarget.texture.name = 'offshoreSwellProfile';
		this.globalTarget.texture.wrapS = this.globalTarget.texture.wrapT = THREE.RepeatWrapping;
		this.globalSurface = texture( this.globalTarget.texture );
		const globalMaterial = new THREE.NodeMaterial();
		globalMaterial.fragmentNode = Fn( () => {

			const phase = uv().x.mul( WAVE_COUNT ), along = uv().y.mul( ALONG_TILE );
			const tangent = vec2( this.direction.y.negate(), this.direction.x );
			const at = ( delta: V2 ) => globalHeight( phase.sub( dot( delta, this.direction ).div( this.offshore.x.mul( this.period ) ) ),
				along.add( dot( delta, tangent ) ), this.offshore, this.period, this.amplitude );
			return vec4( at( vec2( 0 ) ), at( vec2( e, 0 ) ).sub( at( vec2( - e, 0 ) ) ).div( 2 * e ),
				at( vec2( 0, e ) ).sub( at( vec2( 0, - e ) ) ).div( 2 * e ), float( 0 ) );

		} )();
		this.globalQuad = new THREE.QuadMesh( globalMaterial );
		this.sampleGlobal = ( p, time ) => {

			const phase = time.sub( dot( p, this.direction ).div( this.offshore.x ).sub( this.offshore.y ) ).div( this.period );
			const along = dot( p, vec2( this.direction.y.negate(), this.direction.x ) );
			return this.globalSurface.sample( vec2( phase.div( WAVE_COUNT ), along.div( ALONG_TILE ) ) ).level( float( 0 ) );

		};
		const correctionWeight = ( p: V2 ) => {

			const q = p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
			const lo = q.div( shared.shoreXform.zw ), hi = vec2( 1 ).sub( q ).div( shared.shoreXform.zw );
			return smoothstep( 1.5, 15.5, lo.x ).mul( smoothstep( 1.5, 15.5, lo.y ) )
				.mul( smoothstep( 1.5, 15.5, hi.x ) ).mul( smoothstep( 1.5, 15.5, hi.y ) );

		};
		const evaluate = Fn( ( [ p, time, field, boundary, transmission, correction, sd, period, amplitude, incoming ]: [ V2, F, THREE.Node<'vec4'>, THREE.Node<'vec4'>, F, F, F, F, F, V2 ] ) => {

			const invSpeed = max( length( field.gb ), 0.08 );
			const dir = field.gb.div( invSpeed );
			// Travel-time gradients describe phase, not energy. Reduce the input amplitude
			// before shaping the wave, so sheltered crests also lose their sharp shoulders.
			const exposure = transmission.mul( mix( float( 0.18 ), float( 1 ), smoothstep( - 0.2, 0.7, dot( dir, incoming ) ) ) );
			const localAmplitude = amplitude.mul( exposure );
			// The incident swell exists everywhere. Only contact/reflection are local.
			const tangent = vec2( incoming.y.negate(), incoming.x );
			const normal = boundary.ba.div( max( length( boundary.ba ), 1e-5 ) );
			const along = dot( p, tangent );
			const contactAlong = dot( p.sub( normal.mul( max( sd, 0 ) ) ), tangent );
			const wobble = wobbleAt( along );
			const contactWobble = wobbleAt( contactAlong );
			const incident = crossSection( time.sub( field.r ).div( period ).add( wobble ), along, field.a, invSpeed, period, localAmplitude );
			// Reflection shares the incident phase at contact. It loses energy over rough rock;
			// its low amplitude avoids fixed standing-wave scallops around the whole island.
			const reflectedTime = boundary.r.mul( 2 ).sub( field.r );
			const reflected = crossSection( time.sub( reflectedTime ).div( period ).add( contactWobble ), contactAlong, field.a, invSpeed, period, localAmplitude );
			const reflection = boundary.g.mul( boundary.g ).mul( exp( max( sd, 0 ).mul( - 0.4 ) ) ).mul( 0.20 ).mul( correction );
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
				.mul( smoothstep( 0, 0.15, sd ) ).mul( correction );
			const height = incident.x.add( reflected.x.mul( reflection ) );
			const flow = dir.mul( incident.y ).add( reflectedDir.mul( reflected.y ).mul( reflection ) ).toVar();
			const coast = float( 1 ).sub( smoothstep( 0.05, 0.65, sd ) );
			flow.subAssign( normal.mul( dot( flow, normal ).min( 0 ) ).mul( coast ) );
			flow.addAssign( normal.mul( impact ).mul( 0.38 ) );
			return vec4( height, flow.x, flow.y, impact );

		} ).setLayout( { name: 'shoreSwellDynamics', type: 'vec4', inputs: [ { name: 'p', type: 'vec2' }, { name: 'time', type: 'float' }, { name: 'field', type: 'vec4' }, { name: 'boundary', type: 'vec4' }, { name: 'transmission', type: 'float' }, { name: 'correction', type: 'float' }, { name: 'sd', type: 'float' }, { name: 'period', type: 'float' }, { name: 'amplitude', type: 'float' }, { name: 'incoming', type: 'vec2' } ] } );

		const dynamicsAt = ( p: V2, time: F ) => {

			const q = p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
			const phaseResidual = this.field.sample( q ).level( float( 0 ) );
			const planeTime = dot( p, this.direction ).div( this.offshore.x ).sub( this.offshore.y );
			const field = vec4( planeTime.add( phaseResidual.r ), this.direction.div( this.offshore.x ).add( phaseResidual.gb ), phaseResidual.a );
			const correction = correctionWeight( p );
			return evaluate( p, time, field, this.contact.sample( q ).level( float( 0 ) ), mix( float( 1 ), this.shelter.sample( q ).level( float( 0 ) ).r, correction ), correction,
				texture( shore, q ).level( float( 0 ) ).r, this.period, this.amplitude, this.direction );

		};
		this.profile = ( p, time ) => dynamicsAt( p, time ).xw;
		this.sample = ( p, time ) => {

			const centre = dynamicsAt( p, time ).toVar();
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
				if ( i === 1 ) return dynamicsAt( p, this.surfaceTime ).yzwx;
				const total = this.sample( p, this.surfaceTime );
				const gx = globalAt( p.add( vec2( e, 0 ) ), this.surfaceTime ).sub( globalAt( p.sub( vec2( e, 0 ) ), this.surfaceTime ) ).div( 2 * e );
				const gz = globalAt( p.add( vec2( 0, e ) ), this.surfaceTime ).sub( globalAt( p.sub( vec2( 0, e ) ), this.surfaceTime ) ).div( 2 * e );
				const residual = vec4( total.x.sub( globalAt( p, this.surfaceTime ) ), total.y.sub( gx ), total.z.sub( gz ), total.w );
				// An exact zero rim makes clamp-to-edge reads valid outside the local cache.
				const q = uv(), edge = min( q.div( shared.shoreXform.zw ), vec2( 1 ).sub( q ).div( shared.shoreXform.zw ) );
				return select( min( edge.x, edge.y ).greaterThan( 1 ), residual, vec4( 0 ) );

			} )();
			return new THREE.QuadMesh( material );

		} );

		this.surfaceAt = ( p, time ) => this.sampleGlobal( p, time ).add( this.texture.sample( p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw ) ).level( float( 0 ) ) );

	}

	update( fft: OceanFFT, time?: number ): void {

		if ( this.revision !== fft.spectrumRevision || this.fieldPeriod !== this.period.value ) {

			this.setDirection( fft );
			const oldField = this.field.value, oldContact = this.contact.value, oldShelter = this.shelter.value;
			const field = createShoreWaveField( this.data, this.direction.value, this.period.value );
			this.field.value = field;
			const info = field.userData.shoreWaveField;
			this.offshore.value.set( info.referenceSpeed, info.timeOffset, info.referenceDepth );
			this.globalDirty = true;
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
		if ( this.globalDirty || this.drawnAmplitude !== this.amplitude.value ) {

			this.renderer.setRenderTarget( this.globalTarget );
			this.globalQuad.render( this.renderer );
			this.globalDirty = false;

		}
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
