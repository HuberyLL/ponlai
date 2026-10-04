/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, ivec2, float, sqrt, max, atan, asin, acos, clamp, cos, sin, mix, abs, select,
	pmremTexture, textureLoad, Loop,
} from 'three/tsl';
import { Atmosphere, SUN_ANGULAR_RADIUS, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_PROJECTED_SOLID_ANGLE } from '../lighting/Radiometry.ts';
import { Clouds } from './Clouds.ts';
import { NightSky } from './NightSky.ts';
import type { DayCycleSnapshot } from './DayCycle.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

interface SkyEndpoint {
	equirect: THREE.RenderTarget;
	shadow: THREE.RenderTarget;
	environment: THREE.RenderTarget | null;
	irradianceMap: THREE.RenderTarget;
	version: number;
	sunDir: THREE.Vector3;
	sunColor: THREE.Color;
	solarIlluminance: THREE.Color;
	keyDir: THREE.Vector3;
	keyColor: THREE.Color;
	moonDir: THREE.Vector3;
	moonColor: THREE.Color;
	irradiance: THREE.Color;
}

function makeEndpoint(): SkyEndpoint {

	const equirect = new THREE.RenderTarget( 512, 256, {
		type: THREE.HalfFloatType, generateMipmaps: true,
		minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
	} );
	equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
	equirect.texture.name = 'skyEquirect';
	return {
		equirect,
		shadow: new THREE.RenderTarget( 128, 128, { type: THREE.HalfFloatType, depthBuffer: false } ),
		environment: null,
		irradianceMap: new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } ),
		version: 0,
		sunDir: new THREE.Vector3( 0, 1, 0 ), sunColor: new THREE.Color( 0, 0, 0 ),
		solarIlluminance: new THREE.Color( 0, 0, 0 ),
		keyDir: new THREE.Vector3( 0, 1, 0 ), keyColor: new THREE.Color( 0, 0, 0 ),
		moonDir: new THREE.Vector3( 0, - 1, 0 ), moonColor: new THREE.Color( 0, 0, 0 ),
		irradiance: new THREE.Color( 0, 0, 0 ),
	};

}

function blendDirection( target: THREE.Vector3, a: THREE.Vector3, b: THREE.Vector3, amount: number ): void {

	target.copy( a ).lerp( b, amount );
	// Runtime intervals are short. Explicit preset jumps bypass interpolation, but retain
	// a finite direction even if a caller requests an antipodal transition deliberately.
	if ( target.lengthSq() < 1e-8 ) target.copy( amount < 0.5 ? a : b );
	target.normalize();

}

// The atmosphere is the single source of sky radiance and solar extinction. The visible sky
// includes the sun disk; the water panorama and PMREM omit it because direct lighting already
// reflects the sun. This follows tidewater's separation of view and reflection radiance.
export const dirToEquirect = Fn( ( [ d ]: [ V3 ] ) => {

	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), asin( clamp( d.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 ) );

} ).setLayout( { name: 'dirToEquirect', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const equirectToDir = Fn( ( [ q ]: [ V2 ] ) => {

	const phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar(), th = q.y.sub( 0.5 ).mul( Math.PI ).toVar();
	return vec3( cos( th ).mul( cos( phi ) ), sin( th ), cos( th ).mul( sin( phi ) ) );

} ).setLayout( { name: 'equirectToDir', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

export class Sky {

	renderer: THREE.WebGPURenderer;
	atmosphere: Atmosphere;
	clouds = new Clouds();
	night = new NightSky();
	sunIlluminance: number;
	elevation: number;
	azimuth: number;
	// A shared artistic solar tint affects both scattering and direct light.
	sunTint = new THREE.Color( 1.0, 0.97, 0.9 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	keyDir = new THREE.Vector3();
	keyColor = new THREE.Color();
	skyIrradiance = new THREE.Color(); // E / PI over the upper hemisphere
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	cloudShadow: THREE.RenderTarget;
	readonly irradianceNode: V3;
	busy = false;

	private endpoints = [ makeEndpoint(), makeEndpoint() ];
	private front = 0;
	private destination = 0;
	private initialized = false;
	private celestial: DayCycleSnapshot | null = null;
	private pendingUpdate: Promise<void> | null = null;
	private transitionDuration = 0;
	private transitionElapsed = 0;
	private blend = uniform( 0 );
	private panoramaA: THREE.TextureNode;
	private panoramaB: THREE.TextureNode;
	private shadowA: THREE.TextureNode;
	private shadowB: THREE.TextureNode;
	private environmentA: THREE.TextureNode | null = null;
	private environmentB: THREE.TextureNode | null = null;
	private environment: V3 | null = null;
	private environmentBlendQuad: THREE.QuadMesh | null = null;
	private shadowBlendQuad: THREE.QuadMesh;
	private irradianceQuad: THREE.QuadMesh;
	private irradianceBlendQuad: THREE.QuadMesh;
	private irradianceDisplay = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter } );
	private irradianceA: THREE.TextureNode;
	private irradianceB: THREE.TextureNode;
	private bakeVersion = 0;
	private explicitVersion = 0;
	private diagnosticVersion = 0;
	private diagnosticPending = false;
	private lastDiagnosticMs = - Infinity;
	private liveDiagnostics = false;
	private displaySunDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	private displaySolarIlluminance = uniform( new THREE.Color( 0, 0, 0 ) );
	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private upperHemisphere: THREE.RenderTarget;
	private upperQuad: THREE.QuadMesh;
	private sea = uniform( new THREE.Color() );
	private nightAmbient = uniform( new THREE.Color( 0, 0, 0 ) );
	private irradiancePass = uniform( 0 );
	private shadowQuad: THREE.QuadMesh;

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = SUN_ILLUMINANCE, elevation = 32, azimuth = - 8 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.atmosphere = new Atmosphere( renderer );
		this.equirect = this.endpoints[ 0 ].equirect;
		this.upperHemisphere = new THREE.RenderTarget( this.equirect.width, this.equirect.height / 2, {
			type: THREE.HalfFloatType, depthBuffer: false,
			minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping,
		} );
		this.upperHemisphere.texture.name = 'skyUpperHemisphere';
		this.cloudShadow = new THREE.RenderTarget( 128, 128, { type: THREE.HalfFloatType, depthBuffer: false } );
		this.panoramaA = texture( this.equirect.texture );
		this.panoramaB = texture( this.equirect.texture );
		this.shadowA = texture( this.endpoints[ 0 ].shadow.texture );
		this.shadowB = texture( this.endpoints[ 1 ].shadow.texture );
		const shadowBlendMat = new THREE.NodeMaterial();
		shadowBlendMat.depthTest = false;
		shadowBlendMat.depthWrite = false;
		shadowBlendMat.toneMapped = false;
		shadowBlendMat.fragmentNode = mix( this.shadowA.sample( uv() ).level( float( 0 ) ),
			this.shadowB.sample( uv() ).level( float( 0 ) ), this.blend );
		this.shadowBlendQuad = new THREE.QuadMesh( shadowBlendMat );
		this.small = new THREE.RenderTarget( 64, 32, { type: THREE.FloatType, depthBuffer: false } );
		this.irradianceA = texture( this.endpoints[ 0 ].irradianceMap.texture );
		this.irradianceB = texture( this.endpoints[ 1 ].irradianceMap.texture );
		const irradianceBlendMat = new THREE.NodeMaterial();
		irradianceBlendMat.depthTest = false;
		irradianceBlendMat.depthWrite = false;
		irradianceBlendMat.toneMapped = false;
		irradianceBlendMat.fragmentNode = mix( textureLoad( this.irradianceA, ivec2( 0 ) ),
			textureLoad( this.irradianceB, ivec2( 0 ) ), this.blend );
		this.irradianceBlendQuad = new THREE.QuadMesh( irradianceBlendMat );
		this.irradianceNode = textureLoad( texture( this.irradianceDisplay.texture ), ivec2( 0 ) ).rgb;
		const irradianceMat = new THREE.NodeMaterial();
		irradianceMat.depthTest = false;
		irradianceMat.depthWrite = false;
		irradianceMat.toneMapped = false;
		const smallTexture = texture( this.small.texture );
		irradianceMat.fragmentNode = Fn( () => {

			const sum = vec3( 0 ).toVar();
			// The panorama stores sin(latitude) in alpha. Integrate the same cosine-weighted
			// upper hemisphere as the CPU probe, without an orientation-dependent row shortcut.
			Loop( this.small.width * this.small.height, ( { i } ) => {

				const pixel = textureLoad( smallTexture, ivec2( i.mod( this.small.width ), i.div( this.small.width ) ) ).toVar();
				const mu = max( pixel.a, 0 ).toVar();
				const weight = mu.mul( sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) ) ).mul( 2 * Math.PI / ( this.small.width * this.small.height ) );
				sum.addAssign( pixel.rgb.mul( weight ) );

			} );
			return vec4( sum, 1 );

		} )();
		this.irradianceQuad = new THREE.QuadMesh( irradianceMat );
		this.pmrem = new THREE.PMREMGenerator( renderer );

		// The finite wave grid ends before the geometric horizon. Continue it with the reflection
		// of a flat distant sea, approaching unit Fresnel at the horizon without a dark colour step.
		const seaPanorama = Fn( ( [ d, clearSky, sea ]: [ V3, V3, V3 ] ) => {

			const c = clamp( abs( d.y ), 0, 1 ).toVar();
			const g = sqrt( c.mul( c ).add( 1.333 * 1.333 - 1 ) ).toVar();
			const a = g.sub( c ).div( g.add( c ) );
			const b = c.mul( g.add( c ) ).sub( 1 ).div( c.mul( g.sub( c ) ).add( 1 ) );
			const fr = a.mul( a ).mul( b.mul( b ).add( 1 ) ).mul( 0.5 );
			return mix( sea, clearSky, select( d.y.greaterThanEqual( 0 ), 1, fr ) );

		} ).setLayout( { name: 'skySeaPanorama', type: 'vec3', inputs: [
			{ name: 'd', type: 'vec3' }, { name: 'clearSky', type: 'vec3' }, { name: 'sea', type: 'vec3' },
		] } );
		const upperMat = new THREE.NodeMaterial();
		upperMat.fragmentNode = Fn( () => {

			// March each upper-sky direction once. The lower panorama is its distant sea
			// reflection, and the irradiance probe can reuse these same radiance samples.
			const up = equirectToDir( vec2( uv().x, uv().y.mul( 0.5 ).add( 0.5 ) ) ).toVar();
			const clear = this.atmosphere.skyRadiance( up ).add( this.nightAmbient.rgb );
			return this.clouds.radiance( up, clear );

		} )();
		this.upperQuad = new THREE.QuadMesh( upperMat );
		const upperTexture = texture( this.upperHemisphere.texture );

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = Fn( () => {

			const q = uv();
			const d = equirectToDir( q ).toVar();
			const cloud = upperTexture.sample( vec2( q.x, abs( q.y.sub( 0.5 ) ).mul( 2 ) ) ).level( float( 0 ) ).toVar();
			const radiance = seaPanorama( d, cloud.rgb, this.sea.rgb );
			return vec4( radiance, mix( cloud.a, d.y, this.irradiancePass ) );

		} )();
		this.quad = new THREE.QuadMesh( bake );
		const shadowMat = new THREE.NodeMaterial();
		shadowMat.fragmentNode = vec4( this.clouds.transmittance(
			vec3( uv().x.sub( 0.5 ).mul( 512 ), 0, uv().y.sub( 0.5 ).mul( 512 ) ), this.clouds.lightDir ) );
		this.shadowQuad = new THREE.QuadMesh( shadowMat );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const r = acos( clamp( dot( d, this.displaySunDir ), - 1, 1 ) ).div( SUN_ANGULAR_RADIUS ).toVar();
			const mask = float( 1 ).sub( smoothstep( 0.9, 1.0, r ) );
			const limb = sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ).mul( 0.6 ).add( 0.4 );
			// The integral of the visible disk is the key light's irradiance. A shared scene unit
			// scale keeps the normalised disk finite in fp16 without dimming it independently.
			const disk = this.atmosphere.transmittanceToSpace( d ).mul( this.displaySolarIlluminance )
				.mul( mask ).mul( limb ).div( SUN_PROJECTED_SOLID_ANGLE ).mul( smoothstep( 0, 0.001, d.y ) );
			const background = this.samplePanorama( d, float( 0 ) );
			return vec4( background.rgb.add( disk.add( this.night.moon( d ) ).mul( background.a ) ), 1 );

		} )();
		this.dome = new THREE.Mesh( new THREE.SphereGeometry( 1000, 32, 16 ), domeMat );
		this.dome.frustumCulled = false;
		// Render behind the completed opaque depth so covered pixels skip the sky shader.
		this.dome.renderOrder = 1000;
		this.dome.onBeforeRender = ( _renderer, _scene, camera ) => {

			// Translation must not change the angular position of the sun or the horizon.
			this.dome.position.copy( camera.position );
			this.dome.updateMatrixWorld();

		};

	}

	get transitioning(): boolean { return this.transitionDuration > 0 && this.transitionElapsed < this.transitionDuration; }
	get moonDir(): THREE.Vector3 { return this.night.moonDir.value; }

	get environmentNode(): V3 {

		if ( ! this.environment ) throw new Error( 'The sky environment is available after the initial update' );
		return this.environment;

	}

	setCelestial( snapshot: DayCycleSnapshot | null ): void {

		// The caller may keep advancing its clock while GPU readback is pending. Each bake
		// owns its requested directions and scalars, never a mutable controller snapshot.
		this.celestial = snapshot ? { ...snapshot, sunDir: snapshot.sunDir.clone(), moonDir: snapshot.moonDir.clone(), keyDir: snapshot.keyDir.clone() } : null;

	}

	setQuality( quality: 'low' | 'medium' | 'high' ): void {

		const samples = { low: 6, medium: 10, high: 14 }[ quality ];
		if ( samples === undefined ) throw new RangeError( `Unknown sky quality: ${ quality }` );
		// Fixed targets keep sampler dimensions and both PMREM endpoints compatible while
		// quality changes. Sample count and the caller's bake cadence control the GPU budget.
		this.clouds.quality.value = samples;

	}

	update( transitionSeconds = 0 ): Promise<void> {

		if ( ! Number.isFinite( transitionSeconds ) || transitionSeconds < 0 ) return Promise.reject( new RangeError( 'Sky transition duration must be finite and nonnegative' ) );
		if ( this.pendingUpdate ) return this.pendingUpdate;
		if ( this.transitioning ) {

			if ( transitionSeconds > 0 ) return Promise.resolve();
			this.advance( this.transitionDuration );

		}
		this.busy = true;
		this.pendingUpdate = this.bake( transitionSeconds ).finally( () => {

			this.busy = false;
			this.pendingUpdate = null;

		} );
		return this.pendingUpdate;

	}

	private async bake( transitionSeconds: number ): Promise<void> {

		const started = performance.now();
		const version = ++ this.bakeVersion;
		const readback = transitionSeconds === 0 || ! this.initialized;
		if ( readback ) this.explicitVersion = version;
		const celestial = this.celestial;
		const elevation = celestial?.elevation ?? this.elevation;
		const azimuth = celestial?.azimuth ?? this.azimuth;
		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		const tint = this.sunTint.clone();
		await this.renderer.init();
		const next = this.initialized ? 1 - this.front : 0;
		const state = this.endpoints[ next ];
		state.version = version;
		const el = THREE.MathUtils.degToRad( elevation ), az = THREE.MathUtils.degToRad( azimuth );
		state.sunDir.set( Math.cos( el ) * Math.cos( az ), Math.sin( el ), Math.cos( el ) * Math.sin( az ) ).normalize();
		state.solarIlluminance.copy( tint ).multiplyScalar( illuminance );
		this.atmosphere.sunDir.value.copy( state.sunDir );
		this.atmosphere.sunIlluminance.value.copy( state.solarIlluminance );
		this.atmosphere.updateSync();
		state.sunColor.copy( this.atmosphere.transmittanceToSun() ).multiply( state.solarIlluminance );
		state.keyDir.copy( celestial?.keyDir ?? state.sunDir );
		state.keyColor.copy( state.sunColor );
		if ( celestial ) {

			// A modest art-directed moon remains orders darker than daylight on the island.
			state.keyColor.add( new THREE.Color( 0.65, 0.76, 1 ).multiplyScalar( illuminance * 0.04 * celestial.moonKeyGain ) );
			state.moonDir.copy( celestial.moonDir );
			state.moonColor.setRGB( 0.14, 0.16, 0.19 ).multiplyScalar( celestial.moonVisibility * this.sunIlluminance / SUN_ILLUMINANCE );
			this.nightAmbient.value.setRGB( 0.001, 0.001625, 0.003125 ).multiplyScalar( illuminance * celestial.nightVisibility );
			this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance * celestial.daylight )
				.add( this.nightAmbient.value.clone().multiplyScalar( 0.22 ) );

		} else {

			state.moonColor.setRGB( 0, 0, 0 );
			state.moonDir.copy( state.sunDir ).negate();
			this.nightAmbient.value.setRGB( 0, 0, 0 );
			this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance );

		}
		this.clouds.lightDir.value.copy( state.keyDir );
		this.clouds.lightColor.value.copy( state.keyColor );
		this.clouds.ambientColor.value.setRGB( 0.04, 0.055, 0.08 ).multiplyScalar( illuminance * ( celestial ? celestial.daylight + celestial.nightVisibility * 0.008 : 1 ) );
		const r = this.renderer, prev = r.getRenderTarget();
		try {

			r.setRenderTarget( this.upperHemisphere );
			this.upperQuad.render( r );
			// Both samplers must have distinct textures at the first material compilation:
			// Three deduplicates texture uniforms by UUID, even for separate TextureNodes.
			const panoramas = this.initialized ? [ state.equirect, this.small ] : [ state.equirect, this.endpoints[ 1 ].equirect, this.small ];
			for ( const rt of panoramas ) {

				this.irradiancePass.value = rt === this.small ? 1 : 0;
				r.setRenderTarget( rt );
				this.quad.render( r );

			}
			for ( const shadow of this.initialized ? [ state.shadow ] : [ state.shadow, this.endpoints[ 1 ].shadow ] ) {

				r.setRenderTarget( shadow );
				this.shadowQuad.render( r );

			}
			for ( const irradiance of this.initialized ? [ state.irradianceMap ] : [ state.irradianceMap, this.endpoints[ 1 ].irradianceMap ] ) {

				r.setRenderTarget( irradiance );
				this.irradianceQuad.render( r );

			}

		} finally {

			r.setRenderTarget( prev );

		}

		if ( readback ) {

			const W = this.small.width, H = this.small.height;
			const px = await r.readRenderTargetPixelsAsync( this.small, 0, 0, W, H ) as Float32Array;
			const E = [ 0, 0, 0 ];
			const dOmegaLon = 2 * Math.PI / W, dTh = Math.PI / H;
			for ( let k = 0; k < W * H; k ++ ) {

				const sinTh = px[ k * 4 + 3 ];
				if ( sinTh <= 0 ) continue;
				const dOmega = dOmegaLon * dTh * Math.sqrt( Math.max( 0, 1 - sinTh * sinTh ) );
				for ( let c = 0; c < 3; c ++ ) E[ c ] += px[ k * 4 + c ] * sinTh * dOmega;

			}
			state.irradiance.setRGB( E[ 0 ] / Math.PI, E[ 1 ] / Math.PI, E[ 2 ] / Math.PI );

		}
		state.environment = this.pmrem.fromEquirectangular( state.equirect.texture, state.environment ?? undefined );
		if ( ! this.initialized ) {

			this.front = next;
			const spare = this.endpoints[ 1 ];
			spare.environment = this.pmrem.fromEquirectangular( spare.equirect.texture );

		}
		const previous = this.endpoints[ this.front ];
		const displayedNext = this.initialized ? state : this.endpoints[ 1 ];
		this.panoramaA.value = previous.equirect.texture;
		this.panoramaB.value = displayedNext.equirect.texture;
		this.shadowA.value = previous.shadow.texture;
		this.shadowB.value = displayedNext.shadow.texture;
		this.irradianceA.value = previous.irradianceMap.texture;
		this.irradianceB.value = displayedNext.irradianceMap.texture;
		if ( ! this.environmentA || ! this.environmentB ) {

			this.environmentA = texture( previous.environment!.texture );
			this.environmentB = texture( displayedNext.environment!.texture );
			this.envMap = state.environment.clone();
			this.envMap.texture.mapping = THREE.CubeUVReflectionMapping;
			( this.envMap.texture as THREE.Texture & { isPMREMTexture: boolean } ).isPMREMTexture = true;
			this.envMap.texture.name = 'skyDisplayedPMREM';
			this.envMap.scissorTest = false;
			const blendMat = new THREE.NodeMaterial();
			blendMat.depthTest = false;
			blendMat.depthWrite = false;
			blendMat.toneMapped = false;
			// Convolution is linear. Blending the already filtered atlases once keeps terrain
			// within WebGPU's portable 16-texture limit instead of doubling every IBL sample.
			blendMat.fragmentNode = mix( this.environmentA.sample( uv() ).level( float( 0 ) ),
				this.environmentB.sample( uv() ).level( float( 0 ) ), this.blend );
			this.environmentBlendQuad = new THREE.QuadMesh( blendMat );
			this.environment = pmremTexture( this.envMap.texture );

		} else {

			this.environmentA.value = previous.environment!.texture;
			this.environmentB.value = state.environment.texture;

		}
		this.destination = next;
		this.transitionElapsed = 0;
		this.transitionDuration = this.initialized ? transitionSeconds : 0;
		this.blend.value = ! this.initialized || this.transitionDuration > 0 ? 0 : 1;
		this.equirect = state.equirect;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.initialized = true;
		this.liveDiagnostics = ! readback;
		this.publish( this.blend.value );
		if ( this.transitionDuration === 0 ) this.front = this.destination;
		this.lastBakeMs = performance.now() - started;
		if ( ! readback ) this.refreshDiagnosticIrradiance( state, version );

	}

	advance( dt: number ): void {

		if ( ! Number.isFinite( dt ) || dt < 0 ) throw new RangeError( 'Sky dt must be finite and nonnegative' );
		if ( ! this.transitioning ) return;
		this.transitionElapsed = Math.min( this.transitionElapsed + dt, this.transitionDuration );
		const fraction = this.transitionElapsed / this.transitionDuration;
		this.blend.value = fraction * fraction * ( 3 - 2 * fraction );
		this.publish( this.blend.value );
		if ( ! this.transitioning ) this.front = this.destination;

	}

	private publish( amount: number ): void {

		const a = this.endpoints[ this.front ], b = this.endpoints[ this.destination ];
		blendDirection( this.sunDir, a.sunDir, b.sunDir, amount );
		blendDirection( this.keyDir, a.keyDir, b.keyDir, amount );
		blendDirection( this.night.moonDir.value, a.moonDir, b.moonDir, amount );
		this.sunColor.copy( a.sunColor ).lerp( b.sunColor, amount );
		this.keyColor.copy( a.keyColor ).lerp( b.keyColor, amount );
		// During a running cycle this CPU value is diagnostic only. Water and characters use
		// irradianceNode, which blends the exact GPU integrals on the same frame as the sky.
		if ( ! this.liveDiagnostics ) this.skyIrradiance.copy( a.irradiance ).lerp( b.irradiance, amount );
		this.displaySunDir.value.copy( this.sunDir );
		this.displaySolarIlluminance.value.copy( a.solarIlluminance ).lerp( b.solarIlluminance, amount );
		this.night.sunDir.value.copy( this.sunDir );
		this.night.moonColor.value.copy( a.moonColor ).lerp( b.moonColor, amount );
		this.renderDisplayMaps();

	}

	private renderDisplayMaps(): void {

		if ( ! this.environmentBlendQuad || ! this.envMap ) return;
		const r = this.renderer, previous = r.getRenderTarget();
		try {

			r.setRenderTarget( this.envMap );
			this.environmentBlendQuad.render( r );
			r.setRenderTarget( this.cloudShadow );
			this.shadowBlendQuad.render( r );
			r.setRenderTarget( this.irradianceDisplay );
			this.irradianceBlendQuad.render( r );

		} finally {

			r.setRenderTarget( previous );

		}

	}

	private refreshDiagnosticIrradiance( state: SkyEndpoint, version: number ): void {

		const now = performance.now();
		if ( this.diagnosticPending || now - this.lastDiagnosticMs < 2000 ) return;
		this.diagnosticPending = true;
		this.lastDiagnosticMs = now;
		void this.renderer.readRenderTargetPixelsAsync( state.irradianceMap, 0, 0, 1, 1 ).then( ( pixels ) => {

			const p = pixels as Float32Array;
			// A late readback must not overwrite an explicit preset or a reused endpoint.
			if ( state.version === version ) state.irradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
			if ( this.liveDiagnostics && version >= this.explicitVersion && version > this.diagnosticVersion ) {

				this.skyIrradiance.setRGB( p[ 0 ], p[ 1 ], p[ 2 ] );
				this.diagnosticVersion = version;

			}

		} ).catch( ( error: unknown ) => console.error( error ) ).finally( () => { this.diagnosticPending = false; } );

	}

	private samplePanorama( direction: V3, mip: F ): V4 {

		const q = dirToEquirect( direction );
		return mix( this.panoramaA.sample( q ).level( mip ), this.panoramaB.sample( q ).level( mip ), this.blend );

	}

	sample( direction: V3, mip: F = float( 0 ) ): V3 { return this.samplePanorama( direction, mip ).rgb; }

	cloudVisibility( worldPosition: V3 ): F {

		const q = worldPosition.xz.div( 512 ).add( 0.5 );
		return texture( this.cloudShadow.texture, q ).level( float( 0 ) ).r;

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		( this.upperQuad.material as THREE.Material ).dispose();
		this.upperHemisphere.dispose();
		this.small.dispose();
		this.cloudShadow.dispose();
		this.envMap?.dispose();
		this.irradianceDisplay.dispose();
		( this.shadowQuad.material as THREE.Material ).dispose();
		( this.shadowBlendQuad.material as THREE.Material ).dispose();
		( this.environmentBlendQuad?.material as THREE.Material | undefined )?.dispose();
		( this.irradianceQuad.material as THREE.Material ).dispose();
		( this.irradianceBlendQuad.material as THREE.Material ).dispose();
		for ( const endpoint of this.endpoints ) {

			endpoint.equirect.dispose();
			endpoint.shadow.dispose();
			endpoint.irradianceMap.dispose();
			endpoint.environment?.dispose();

		}
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
