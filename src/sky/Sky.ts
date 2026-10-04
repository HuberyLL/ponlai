/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, uv, uniform, texture, positionWorld, cameraPosition, normalize, smoothstep, dot,
	vec2, vec3, vec4, float, sqrt, max, atan, asin, acos, clamp, cos, sin, mix, abs, select,
} from 'three/tsl';
import { Atmosphere, SUN_ANGULAR_RADIUS, SUN_ILLUMINANCE } from './Atmosphere.ts';
import { SCENE_RADIANCE_SCALE, SUN_PROJECTED_SOLID_ANGLE } from '../lighting/Radiometry.ts';
import { Clouds } from './Clouds.ts';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

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
	sunIlluminance: number;
	elevation: number;
	azimuth: number;
	// A shared artistic solar tint affects both scattering and direct light.
	sunTint = new THREE.Color( 1.0, 0.97, 0.9 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	skyIrradiance = new THREE.Color(); // E / PI over the upper hemisphere
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;
	lastBakeMs = 0;
	cloudShadow = new THREE.RenderTarget( 128, 128, { type: THREE.HalfFloatType, depthBuffer: false } );

	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private sea = uniform( new THREE.Color() );
	private irradiancePass = uniform( 0 );
	private shadowQuad: THREE.QuadMesh;

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = SUN_ILLUMINANCE, elevation = 32, azimuth = - 8 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.atmosphere = new Atmosphere( renderer );
		this.equirect = new THREE.RenderTarget( 1024, 512, {
			type: THREE.HalfFloatType, generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
		} );
		this.equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
		this.equirect.texture.name = 'skyEquirect';
		this.small = new THREE.RenderTarget( 64, 32, { type: THREE.FloatType, depthBuffer: false } );
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
		const panorama = ( d: V3 ) => {

			const up = vec3( d.x, abs( d.y ), d.z );
			const cloud = this.clouds.radiance( up, this.atmosphere.skyRadiance( up ) ).toVar();
			return vec4( seaPanorama( d, cloud.rgb, this.sea.rgb ), cloud.a );

		};

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = Fn( () => {

			const d = equirectToDir( uv() ).toVar();
			const radiance = panorama( d ).toVar();
			return vec4( radiance.rgb, mix( radiance.a, d.y, this.irradiancePass ) );

		} )();
		this.quad = new THREE.QuadMesh( bake );
		const shadowMat = new THREE.NodeMaterial();
		shadowMat.fragmentNode = vec4( this.clouds.transmittance(
			vec3( uv().x.sub( 0.5 ).mul( 512 ), 0, uv().y.sub( 0.5 ).mul( 512 ) ), this.clouds.lightDir ) );
		this.shadowQuad = new THREE.QuadMesh( shadowMat );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const r = acos( clamp( dot( d, this.atmosphere.sunDir ), - 1, 1 ) ).div( SUN_ANGULAR_RADIUS ).toVar();
			const mask = float( 1 ).sub( smoothstep( 0.9, 1.0, r ) );
			const limb = sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ).mul( 0.6 ).add( 0.4 );
			// The integral of the visible disk is the key light's irradiance. A shared scene unit
			// scale keeps the normalised disk finite in fp16 without dimming it independently.
			const disk = this.atmosphere.transmittanceToSpace( d ).mul( this.atmosphere.sunIlluminance )
				.mul( mask ).mul( limb ).div( SUN_PROJECTED_SOLID_ANGLE ).mul( smoothstep( 0, 0.001, d.y ) );
			const background = texture( this.equirect.texture, dirToEquirect( d ) ).level( float( 0 ) );
			return vec4( background.rgb.add( disk.mul( background.a ) ), 1 );

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

	async update(): Promise<void> {

		const started = performance.now();
		const el = THREE.MathUtils.degToRad( this.elevation ), az = THREE.MathUtils.degToRad( this.azimuth );
		this.sunDir.set( Math.cos( el ) * Math.cos( az ), Math.sin( el ), Math.cos( el ) * Math.sin( az ) ).normalize();
		this.atmosphere.sunDir.value.copy( this.sunDir );
		const illuminance = this.sunIlluminance * SCENE_RADIANCE_SCALE;
		this.atmosphere.sunIlluminance.value.copy( this.sunTint ).multiplyScalar( illuminance );
		this.sea.value.copy( this.seaColor ).multiplyScalar( illuminance );
		await this.atmosphere.update();
		this.sunColor.copy( this.atmosphere.transmittanceToSun() ).multiply( this.sunTint ).multiplyScalar( illuminance );
		this.clouds.lightDir.value.copy( this.sunDir );
		this.clouds.lightColor.value.copy( this.sunColor );
		// Cloud skylight follows the same scene radiance units as the atmosphere.
		this.clouds.ambientColor.value.setRGB( 0.04, 0.055, 0.08 ).multiplyScalar( illuminance );

		const r = this.renderer, prev = r.getRenderTarget();
		try {

			for ( const rt of [ this.equirect, this.small ] ) {

				this.irradiancePass.value = rt === this.small ? 1 : 0;
				r.setRenderTarget( rt );
				this.quad.render( r );

			}
			r.setRenderTarget( this.cloudShadow );
			this.shadowQuad.render( r );

		} finally {

			r.setRenderTarget( prev );

		}

		const W = this.small.width, H = this.small.height;
		const px = await r.readRenderTargetPixelsAsync( this.small, 0, 0, W, H ) as Float32Array;
		const E = [ 0, 0, 0 ];
		const dOmegaLon = 2 * Math.PI / W, dTh = Math.PI / H;
		for ( let k = 0; k < W * H; k ++ ) {

			const sinTh = px[ k * 4 + 3 ];
			if ( sinTh <= 0 ) continue;
			const dOmega = dOmegaLon * dTh * Math.sqrt( 1 - sinTh * sinTh );
			for ( let c = 0; c < 3; c ++ ) E[ c ] += px[ k * 4 + c ] * sinTh * dOmega;

		}
		this.skyIrradiance.setRGB( E[ 0 ] / Math.PI, E[ 1 ] / Math.PI, E[ 2 ] / Math.PI );
		this.envMap = this.pmrem.fromEquirectangular( this.equirect.texture, this.envMap ?? undefined );
		this.lastBakeMs = performance.now() - started;

	}

	cloudVisibility( worldPosition: V3 ): THREE.Node<'float'> {

		return texture( this.cloudShadow.texture, worldPosition.xz.div( 512 ).add( 0.5 ) ).level( float( 0 ) ).r;

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		this.equirect.dispose();
		this.small.dispose();
		this.cloudShadow.dispose();
		( this.shadowQuad.material as THREE.Material ).dispose();
		this.envMap?.dispose();
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
