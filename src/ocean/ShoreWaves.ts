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
import { shoreBoundaryPixels, shoreShelterPixels, type FieldPixels } from './ShoreWaveField.ts';
import type { ShoreFieldJob, ShoreFieldReply } from './shoreFieldWorker.ts';
import { TEMPORAL } from '../post/Antialiasing.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;

// The reflected surface's texel (m): the first island's 96 m field over 512 texels,
// kept as the shore field grows with the land, so the contact strip along the rock stays as sharp.
const TEXEL = 96 / 512;

// A field's texels as a texture (filtered, no mips).
function fieldTexture( field: FieldPixels, name: string ): THREE.DataTexture {

	const texture = new THREE.DataTexture( field.pixels, field.nx, field.nz, THREE.RGBAFormat, THREE.FloatType );
	texture.name = name;
	texture.minFilter = texture.magFilter = THREE.LinearFilter;
	texture.generateMipmaps = false; texture.flipY = false; texture.needsUpdate = true;
	return texture;

}

function shelterTexture( field: FieldPixels & { info: Record<string, unknown> } ): THREE.DataTexture {

	const texture = fieldTexture( field, 'shoreWaveShelter' );
	texture.userData.shoreWaveShelter = field.info;
	return texture;

}

/** A grown island's wave fields (ShoreWaves.fieldsFor), for `setFields`. */
export interface ShoreFields { data: WorldData; boundary: THREE.DataTexture; shelter: THREE.DataTexture; direction: THREE.Vector2 }

// Tidewater's FFT supplies every incident wave. This rocky boundary is a Ponlai extension:
// a weak mirrored response and whitewater use that wave's height and orbital velocity,
// without adding the independent, single-period beach wave over the open sea.
//
// A grown island (Growth.ts) brings a new shore field: its wave fields are built in a worker
// (`fieldsFor`: shoreFieldWorker.ts, ShoreWaveField's plain-data functions, on a copy of the
// field the caller makes and hands over: the page keeps its own; their textures the caller
// uploads) and set in place
// (`setFields`: the base nodes' values, the surface targets resized to the field), so no material
// changes and no pipeline is built.
//
// The surface field is baked once per change of the scene clock. Under the temporal modes
// (Antialiasing.ts) it alternates between two targets, so the one baked before stays readable as
// the field a step of the clock ago (`previousSurfaceAt`): the water's motion vectors take its
// vertices' previous heights from it (Water.ts). `texture` and `previous` swap their targets at
// each bake; whoever samples them follows.
export class ShoreWaves {

	readonly direction = uniform( new THREE.Vector2() );
	readonly reflection = uniform( 0.14 );
	readonly boundary: THREE.TextureNode;
	readonly shelter: THREE.TextureNode;
	// RGBA: local reflected height, its x/z slopes, incident rock-contact energy.
	readonly texture: THREE.TextureNode;
	// The surface field as baked before the current one (temporal modes; otherwise the current one).
	readonly previous: THREE.TextureNode;
	readonly surfaceAt: ( p: V2, time: F ) => THREE.Node<'vec4'>;
	/** The surface field at the clock's previous bake (see the note above). */
	readonly previousSurfaceAt: ( p: V2 ) => THREE.Node<'vec4'>;
	fieldRevision = 0;
	private data: WorldData;
	private revision = - 1;
	private renderer: THREE.WebGPURenderer;
	// the surface field's targets: [ current, previous ] (one under MSAA)
	private surfaces: THREE.RenderTarget[];
	private quad: THREE.QuadMesh;
	private lastTime: number | undefined;
	private lastReflection = - 1;
	private readonly lastWeatherGain = new THREE.Vector3( - 1, - 1, - 1 );

	constructor( renderer: THREE.WebGPURenderer, data: WorldData, shared: Shared, shore: THREE.Texture | THREE.TextureNode, fft: OceanFFT ) {

		this.renderer = renderer;
		this.data = data;
		this.setDirection( fft );
		this.boundary = texture( fieldTexture( shoreBoundaryPixels( data.shore ), 'shoreWaveBoundary' ) );
		this.shelter = texture( shelterTexture( shoreShelterPixels( data.shore, this.direction.value ) ) );
		this.revision = fft.spectrumRevision;
		const toUV = ( p: V2 ) => p.sub( shared.shoreXform.xy ).mul( shared.shoreXform.zw );
		const coastDamp = Fn( ( [ sd ]: [ F ] ) => mix( float( 0.45 ), float( 1 ), smoothstep( 0, 7, sd ) ) )
			.setLayout( { name: 'rockCoastDamping', type: 'float', inputs: [ { name: 'sd', type: 'float' } ] } );
		const contactEnergy = Fn( ( [ height, velocity, normal, sd, confidence, exposure ]: [ F, V2, V2, F, F, F ] ) => {

			const approaching = max( dot( velocity, normal ).negate(), 0 );
			// Small waves aerate a thin strip touching the wall, not a separate offshore mat.
			// Keep the water-side ramp below one history texel to avoid an artificial dry gap.
			return smoothstep( 0.008, 0.040, height ).mul( smoothstep( 0.025, 0.16, approaching ) )
				.mul( confidence ).mul( exposure.mul( exposure ) ).mul( exp( sd.div( 0.24 ).pow( 2 ).negate() ) )
				.mul( smoothstep( 0, 0.02, sd ) );

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
		// `at` passes the shore distance and boundary already read at p's texel, so the centre
		// sample does not read them a second time.
		const reflectionHeight = ( p: V2, at?: { q: V2; sd: F; boundary: THREE.Node<'vec4'> } ) => Fn( () => {

			const q = at ? at.q : toUV( p );
			const sd = at ? at.sd : texture( shore, q ).level( float( 0 ) ).r;
			const height = float( 0 ).toVar();
			If( sd.greaterThan( - 0.8 ).and( sd.lessThan( 3.5 ) ), () => {

				const boundary = at ? at.boundary : this.boundary.sample( q ).level( float( 0 ) );
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
		// Every channel is zero away from the rock: the reflection fades out by 3.5 m from it (its
		// slopes read 0.12 m to either side) and the contact energy by 1.4 m. Only that strip
		// evaluates the waves, so the pass costs by the coast's length rather than the field's area,
		// which grows with the land.
		const e = 0.12;
		const surface = ( p: V2 ) => Fn( () => {

			const q = toUV( p ).toVar(), edge = min( q.div( shared.shoreXform.zw ), vec2( 1 ).sub( q ).div( shared.shoreXform.zw ) );
			const sd = texture( shore, q ).level( float( 0 ) ).r.toVar();
			const out = vec4( 0 ).toVar();
			If( sd.greaterThan( - 1 ).and( sd.lessThan( 3.75 ) ), () => {

				const boundary = this.boundary.sample( q ).level( float( 0 ) ).toVar();
				const normal = boundary.ba.div( max( length( boundary.ba ), 1e-5 ) );
				const impact = float( 0 ).toVar();
				If( sd.greaterThan( 0 ).and( sd.lessThan( 1.4 ) ), () => {

					const contactP = p.sub( normal.mul( sd ) ).add( normal.mul( 0.16 ) );
					const contact = incidence( contactP ).toVar();
					const contactExposure = this.shelter.sample( toUV( contactP ) ).level( float( 0 ) ).r;
					impact.assign( contactEnergy( contact.x, contact.yz, normal, sd, boundary.g, contactExposure ) );

				} );
				const inWater = sd.greaterThan( 0 ).and( min( edge.x, edge.y ).greaterThan( 1 ) );
				const dx = reflectionHeight( p.add( vec2( e, 0 ) ) ).sub( reflectionHeight( p.sub( vec2( e, 0 ) ) ) ).div( 2 * e );
				const dz = reflectionHeight( p.add( vec2( 0, e ) ) ).sub( reflectionHeight( p.sub( vec2( 0, e ) ) ) ).div( 2 * e );
				out.assign( vec4( reflectionHeight( p, { q, sd, boundary } ), dx, dz, select( inWater, impact, float( 0 ) ) ) );

			} );
			return out;

		} )();
		const [ width, height ] = surfaceSize( data );
		const field = ( name: string ) => {

			const target = new THREE.RenderTarget( width, height, { type: THREE.HalfFloatType, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, generateMipmaps: false } );
			target.texture.name = name;
			return target;

		};
		this.surfaces = TEMPORAL ? [ field( 'rockWaveSurface' ), field( 'rockWaveSurfacePrevious' ) ] : [ field( 'rockWaveSurface' ) ];
		this.texture = texture( this.surfaces[ 0 ].texture );
		this.previous = texture( this.surfaces[ this.surfaces.length - 1 ].texture );
		const material = new THREE.NodeMaterial();
		material.fragmentNode = Fn( () => surface( uv().div( shared.shoreXform.zw ).add( shared.shoreXform.xy ) ) )();
		this.quad = new THREE.QuadMesh( material );
		this.surfaceAt = ( p, _time ) => this.texture.sample( toUV( p ) ).level( float( 0 ) );
		this.previousSurfaceAt = ( p ) => this.previous.sample( toUV( p ) ).level( float( 0 ) );

	}

	update( fft: OceanFFT, time?: number ): void {

		if ( this.revision !== fft.spectrumRevision ) {

			const previous = this.direction.value.clone();
			this.setDirection( fft );
			if ( ! previous.equals( this.direction.value ) ) {

				const old = this.shelter.value;
				this.shelter.value = shelterTexture( shoreShelterPixels( this.data.shore, this.direction.value ) );
				old.dispose();

			}
			this.revision = fft.spectrumRevision;
			this.fieldRevision ++;
			this.lastTime = undefined;

		}
		// A paused preset can change the FFT's amplitude without changing its clock or base
		// spectrum. Refresh those reflected fields too, without rebuilding shoreline geometry.
		if ( time === undefined || ( time === this.lastTime && this.lastReflection === this.reflection.value &&
			this.lastWeatherGain.equals( fft.weatherGain.value ) ) ) return;
		const previousTarget = this.renderer.getRenderTarget();
		// (temporal modes: the surface is baked into the target that held the field before last)
		if ( this.surfaces.length > 1 ) {

			this.surfaces.reverse();
			this.texture.value = this.surfaces[ 0 ].texture;
			this.previous.value = this.surfaces[ 1 ].texture;

		}
		this.renderer.setRenderTarget( this.surfaces[ 0 ] );
		this.quad.render( this.renderer );
		this.renderer.setRenderTarget( previousTarget );
		this.lastTime = time;
		this.lastReflection = this.reflection.value;
		this.lastWeatherGain.copy( fft.weatherGain.value );

	}

	/** The wave fields of a grown island's shore field, built in a worker from `shore` (a copy of
	 * `data.shore.data`, transferred to it); their textures are not uploaded yet. */
	fieldsFor( data: WorldData, shore: Float32Array ): Promise<ShoreFields> {

		const worker = new Worker( new URL( './shoreFieldWorker.ts', import.meta.url ), { type: 'module' } );
		const direction = this.direction.value.clone();
		return new Promise<ShoreFields>( ( resolve, reject ) => {

			worker.onmessage = ( e: MessageEvent<ShoreFieldReply> ) => {

				worker.terminate();
				resolve( { data, boundary: fieldTexture( e.data.boundary, 'shoreWaveBoundary' ), shelter: shelterTexture( e.data.shelter ), direction } );

			};
			worker.onerror = ( e ) => { worker.terminate(); reject( e ); };
			worker.postMessage( { shore: { ...data.shore, data: shore }, direction: { x: direction.x, y: direction.y } } satisfies ShoreFieldJob, { transfer: [ shore.buffer ] } );

		} );

	}

	/** Takes a grown island's wave fields (`fieldsFor`): their textures on the nodes, the surface
	 * targets sized to its shore field, the surface baked again on the next update. Returns the
	 * textures replaced, to dispose of once no frame draws with them. (A swell that turned since
	 * `fieldsFor` has its shelter field made here, as a turn makes it on the main thread.) */
	setFields( fields: ShoreFields ): THREE.Texture[] {

		const old = [ this.boundary.value, this.shelter.value ];
		this.data = fields.data;
		this.boundary.value = fields.boundary;
		if ( fields.direction.equals( this.direction.value ) ) this.shelter.value = fields.shelter;
		else {

			fields.shelter.dispose();
			this.shelter.value = shelterTexture( shoreShelterPixels( fields.data.shore, this.direction.value ) );

		}
		const [ width, height ] = surfaceSize( fields.data );
		for ( const target of this.surfaces ) if ( target.width !== width || target.height !== height ) target.setSize( width, height );
		this.fieldRevision ++;
		this.lastTime = undefined;
		return old;

	}

	private setDirection( fft: OceanFFT ): void {

		const angle = ( fft.params.windDirection + fft.swell.directionOffset ) * Math.PI / 180;
		this.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );

	}

}

// The reflected surface's targets for a shore field: TEXEL over its extent.
function surfaceSize( data: WorldData ): [ number, number ] {

	return [ Math.ceil( data.shore.nx * data.shore.cell / TEXEL ), Math.ceil( data.shore.nz * data.shore.cell / TEXEL ) ];

}
