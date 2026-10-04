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

	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private sea = uniform( new THREE.Color() );

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
		const panorama = ( d: V3 ) => seaPanorama( d,
			this.atmosphere.skyRadiance( vec3( d.x, abs( d.y ), d.z ) ), this.sea.rgb );

		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = Fn( () => {

			const d = equirectToDir( uv() ).toVar();
			return vec4( panorama( d ), d.y );

		} )();
		this.quad = new THREE.QuadMesh( bake );

		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		domeMat.colorNode = Fn( () => {

			const d = normalize( positionWorld.sub( cameraPosition ) ).toVar();
			const r = acos( clamp( dot( d, this.atmosphere.sunDir ), - 1, 1 ) ).div( SUN_ANGULAR_RADIUS ).toVar();
			const mask = float( 1 ).sub( smoothstep( 0.9, 1.0, r ) );
			const limb = sqrt( max( float( 1 ).sub( r.mul( r ) ), 0 ) ).mul( 0.6 ).add( 0.4 );
			// Keep the fp16 disk finite and scale it with the same irradiance as the key light.
			const disk = this.atmosphere.transmittanceToSpace( d ).mul( this.atmosphere.sunIlluminance )
				.mul( mask ).mul( limb ).mul( 2500 / SUN_ILLUMINANCE ).mul( smoothstep( 0, 0.001, d.y ) );
			const background = texture( this.equirect.texture, dirToEquirect( d ) ).level( float( 0 ) ).rgb;
			return vec4( background.add( disk ), 1 );

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
		this.atmosphere.sunIlluminance.value.copy( this.sunTint ).multiplyScalar( this.sunIlluminance );
		this.sea.value.copy( this.seaColor ).multiplyScalar( this.sunIlluminance );
		await this.atmosphere.update();
		this.sunColor.copy( this.atmosphere.transmittanceToSun() ).multiply( this.sunTint ).multiplyScalar( this.sunIlluminance );

		const r = this.renderer, prev = r.getRenderTarget();
		try {

			for ( const rt of [ this.equirect, this.small ] ) {

				r.setRenderTarget( rt );
				this.quad.render( r );

			}

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
		const oldEnv = this.envMap;
		this.envMap = this.pmrem.fromEquirectangular( this.equirect.texture );
		oldEnv?.dispose();
		this.lastBakeMs = performance.now() - started;

	}

	dispose(): void {

		this.dome.geometry.dispose();
		( this.dome.material as THREE.Material ).dispose();
		( this.quad.material as THREE.Material ).dispose();
		this.equirect.dispose();
		this.small.dispose();
		this.envMap?.dispose();
		this.pmrem.dispose();
		this.atmosphere.dispose();

	}

}
