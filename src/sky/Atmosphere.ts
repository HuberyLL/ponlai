/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uv, uniform, texture, vec2, vec3, vec4, float, int,
	sqrt, max, pow, exp, length, abs, acos, clamp, cos, sin, dot, normalize, mix, select,
} from 'three/tsl';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';

// Hillaire 2020, "A Scalable and Production Ready Sky and Atmosphere Rendering Technique".
// Tidewater's transmittance, multiple-scattering and sky-view LUTs are ported to TSL fragment
// passes. Distances are kilometres. This module contains clear-sky scattering only; the visible
// sun, environment lighting and scene lights are composed by Sky from the same atmosphere.
const RG = 6360, RT = 6460;
const T_W = 256, T_H = 64, MS_RES = 32, SV_W = 192, SV_H = 108;
const H = Math.sqrt( RT * RT - RG * RG );
const RAYLEIGH = [ 5.802e-3, 13.558e-3, 33.1e-3 ] as const;
const OZONE = [ 0.650e-3, 1.881e-3, 0.085e-3 ] as const;

export const SUN_ILLUMINANCE = 11;
export { SUN_ANGULAR_RADIUS } from '../lighting/Radiometry.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// -1 means no positive intersection. The same helper also detects planet occlusion of sunlight.
const raySphereNearest = Fn( ( [ ro, rd, radius ]: [ V3, V3, F ] ) => {

	const b = dot( ro, rd ).toVar();
	const c = dot( ro, ro ).sub( radius.mul( radius ) ).toVar();
	const disc = b.mul( b ).sub( c ).toVar();
	const sq = sqrt( max( disc, 0 ) );
	const t0 = b.negate().sub( sq ).toVar(), t1 = b.negate().add( sq ).toVar();
	return select( disc.lessThan( 0 ), - 1,
		select( t0.greaterThan( 0 ), t0, select( t1.greaterThan( 0 ), t1, - 1 ) ) );

} ).setLayout( { name: 'atmoRaySphereNearest', type: 'float', inputs: [
	{ name: 'ro', type: 'vec3' }, { name: 'rd', type: 'vec3' }, { name: 'radius', type: 'float' },
] } );

// Only pure parameters enter a shared layout function. A closed-over UniformNode or TextureNode
// would retain the first material's generated binding names when Three reuses the function.
const skyUV = Fn( ( [ dir, sunDir, viewH ]: [ V3, V3, F ] ) => {

	const beta = acos( sqrt( max( viewH.mul( viewH ).sub( RG * RG ), 0 ) ).div( viewH ) ).toVar();
	const horizonAngle = float( Math.PI ).sub( beta ).toVar();
	const angle = acos( clamp( dir.y, - 1, 1 ) ).toVar();
	const a = float( 1 ).sub( sqrt( max( float( 1 ).sub( angle.div( horizonAngle ) ), 0 ) ) ).mul( 0.5 );
	const b = sqrt( max( angle.sub( horizonAngle ).div( beta ), 0 ) ).mul( 0.5 ).add( 0.5 );
	const v = select( angle.lessThan( horizonAngle ), a, b );
	const sunH = normalize( sunDir.xz.add( vec2( 1e-5, 0 ) ) );
	const dirH = normalize( dir.xz.add( vec2( 1e-5, 0 ) ) );
	const u = sqrt( clamp( dot( sunH, dirH ).mul( - 0.5 ).add( 0.5 ), 0, 1 ) );
	return vec2( u.mul( ( SV_W - 1 ) / SV_W ).add( 0.5 / SV_W ),
		v.mul( ( SV_H - 1 ) / SV_H ).add( 0.5 / SV_H ) );

} ).setLayout( { name: 'atmoSkyUV', type: 'vec2', inputs: [
	{ name: 'dir', type: 'vec3' }, { name: 'sunDir', type: 'vec3' }, { name: 'viewH', type: 'float' },
] } );

const transmittanceUV = Fn( ( [ r, mu ]: [ F, F ] ) => {

	const rho = sqrt( max( r.mul( r ).sub( RG * RG ), 0 ) ).toVar();
	const disc = r.mul( r ).mul( mu.mul( mu ).sub( 1 ) ).add( RT * RT );
	const d = max( r.mul( mu ).negate().add( sqrt( max( disc, 0 ) ) ), 0 );
	const dMin = float( RT ).sub( r ), dMax = rho.add( H );
	const xMu = d.sub( dMin ).div( max( dMax.sub( dMin ), 1e-6 ) );
	// Match the texel-centre parameterization used to construct the LUT.
	return vec2( xMu.mul( ( T_W - 1 ) / T_W ).add( 0.5 / T_W ),
		rho.div( H ).mul( ( T_H - 1 ) / T_H ).add( 0.5 / T_H ) );

} ).setLayout( { name: 'atmoTransmittanceUV', type: 'vec2', inputs: [
	{ name: 'r', type: 'float' }, { name: 'mu', type: 'float' },
] } );

function makeLUT( width: number, height: number, name: string ): THREE.RenderTarget {

	const target = new THREE.RenderTarget( width, height, {
		type: THREE.HalfFloatType, depthBuffer: false, generateMipmaps: false,
		minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter,
		wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping,
	} );
	target.texture.name = name;
	return target;

}

function makeQuad( fragmentNode: THREE.Node ): THREE.QuadMesh {

	const material = new THREE.NodeMaterial();
	material.fragmentNode = fragmentNode;
	material.depthTest = false;
	material.depthWrite = false;
	material.toneMapped = false;
	return new THREE.QuadMesh( material );

}

export class Atmosphere {

	readonly sunDir = uniform( new THREE.Vector3( 0.3, 0.6, - 0.7 ).normalize() );
	readonly sunIlluminance = uniform( new THREE.Color().setScalar( SUN_ILLUMINANCE * SCENE_RADIANCE_SCALE ) );
	readonly rayleighScale = uniform( 1 );
	readonly mieScale = uniform( 1 );
	readonly mieG = uniform( 0.8 );
	readonly ozoneScale = uniform( 1 );
	readonly groundAlbedo = uniform( new THREE.Color( 0.06, 0.08, 0.1 ) );
	readonly viewHeight = uniform( RG + 0.002 );
	readonly transmittanceLUT = makeLUT( T_W, T_H, 'atmoTransmittance' );
	readonly multiScatLUT = makeLUT( MS_RES, MS_RES, 'atmoMultiScat' );
	readonly skyViewLUT = makeLUT( SV_W, SV_H, 'atmoSkyView' );

	private readonly quads: THREE.QuadMesh[];
	private staticKey = '';
	private skyKey = '';

	constructor( readonly renderer: THREE.WebGPURenderer ) {

		// RGB is molecular scattering, A is aerosol scattering. Packing allows one function call
		// per march sample without a custom shader struct or shader-language source strings.
		const mediumScattering = Fn( ( [ h, rayleighScale, mieScale ]: [ F, F, F ] ) => {

			const ray = vec3( ...RAYLEIGH ).mul( exp( h.negate().div( 8 ) ) ).mul( rayleighScale );
			const mie = exp( h.negate().div( 1.2 ) ).mul( 3.996e-3 ).mul( mieScale );
			return vec4( ray, mie );

		} ).setLayout( { name: 'atmoMediumScattering', type: 'vec4', inputs: [
			{ name: 'h', type: 'float' }, { name: 'rayleighScale', type: 'float' }, { name: 'mieScale', type: 'float' },
		] } );

		const extinction = Fn( ( [ h, ray, mie, ozoneScale ]: [ F, V3, F, F ] ) => {

			const ozone = max( float( 1 ).sub( abs( h.sub( 25 ) ).div( 15 ) ), 0 );
			return ray.add( mie.mul( 4.440 / 3.996 ) ).add( vec3( ...OZONE ).mul( ozone ).mul( ozoneScale ) );

		} ).setLayout( { name: 'atmoExtinction', type: 'vec3', inputs: [
			{ name: 'h', type: 'float' }, { name: 'ray', type: 'vec3' }, { name: 'mie', type: 'float' },
			{ name: 'ozoneScale', type: 'float' },
		] } );

		// These JavaScript node factories inline texture accesses in the current material. The
		// parameterization itself remains a shared, pure shader function with an explicit layout.
		const sampleTransmittance = ( r: F, mu: F ): V3 => {

			return texture( this.transmittanceLUT.texture, transmittanceUV( r, mu ) ).level( float( 0 ) ).rgb;

		};

		const sampleMultiScat = ( r: F, cosSun: F ): V3 => {

			const q = vec2( cosSun.mul( 0.5 ).add( 0.5 ), r.sub( RG ).div( RT - RG ) );
			return texture( this.multiScatLUT.texture, q.mul( ( MS_RES - 1 ) / MS_RES ).add( 0.5 / MS_RES ) ).level( float( 0 ) ).rgb;

		};

		const transmittanceBake = Fn( () => {

			const q = uv().toVar();
			const xMu = q.x.sub( 0.5 / T_W ).mul( T_W / ( T_W - 1 ) );
			const xR = q.y.sub( 0.5 / T_H ).mul( T_H / ( T_H - 1 ) );
			const rho = xR.mul( H ).toVar();
			const r = sqrt( rho.mul( rho ).add( RG * RG ) ).toVar();
			const dMin = float( RT ).sub( r ), dMax = rho.add( H );
			const d = mix( dMin, dMax, xMu ).toVar();
			const mu = clamp( select( d.equal( 0 ), 1,
				float( H * H ).sub( rho.mul( rho ) ).sub( d.mul( d ) ).div( r.mul( d ).mul( 2 ).max( 1e-6 ) ) ), - 1, 1 ).toVar();
			const ro = vec3( 0, r, 0 ).toVar();
			const rd = vec3( sqrt( max( float( 1 ).sub( mu.mul( mu ) ), 0 ) ), mu, 0 ).toVar();
			// The outermost outward texel is already in space: its optical depth is zero.
			const dt = max( raySphereNearest( ro, rd, float( RT ) ), 0 ).div( 40 ).toVar();
			const od = vec3( 0 ).toVar();
			Loop( 40, ( { i } ) => {

				const p = ro.add( rd.mul( float( i ).add( 0.5 ).mul( dt ) ) );
				const h = length( p ).sub( RG ).toVar();
				const m = mediumScattering( h, this.rayleighScale, this.mieScale ).toVar();
				od.addAssign( extinction( h, m.rgb, m.a, this.ozoneScale ).mul( dt ) );

			} );
			return vec4( exp( od.negate() ), 1 );

		} )();

		const multiScatBake = Fn( () => {

			const q = uv().sub( 0.5 / MS_RES ).mul( MS_RES / ( MS_RES - 1 ) ).toVar();
			const cosSun = q.x.mul( 2 ).sub( 1 ).toVar();
			const r = clamp( q.y, 0.001, 0.999 ).mul( RT - RG ).add( RG );
			const sun = vec3( 0, cosSun, sqrt( max( float( 1 ).sub( cosSun.mul( cosSun ) ), 0 ) ).negate() ).toVar();
			const ro = vec3( 0, r, 0 ).toVar(), Lsum = vec3( 0 ).toVar(), fmsSum = vec3( 0 ).toVar();
			const throughput = vec3( 1 ).toVar(), L = vec3( 0 ).toVar(), fms = vec3( 0 ).toVar();
			// One Loop with both ranges gives the direction and distance counters distinct names.
			// The integrator stays in this one material, where its uniforms and texture bindings belong.
			Loop( { start: int( 0 ), end: int( 64 ), type: 'int' }, { start: int( 0 ), end: int( 20 ), type: 'int' }, ( { i, j } ) => {

				const a = float( i.mod( int( 8 ) ) ).add( 0.5 ).div( 8 );
				const b = float( i.div( int( 8 ) ) ).add( 0.5 ).div( 8 );
				const theta = a.mul( 2 * Math.PI ).toVar(), phi = acos( float( 1 ).sub( b.mul( 2 ) ) ).toVar();
				const rd = vec3( cos( theta ).mul( sin( phi ) ), cos( phi ), sin( theta ).mul( sin( phi ) ) ).toVar();
				const bottom = raySphereNearest( ro, rd, float( RG ) ).toVar();
				const top = raySphereNearest( ro, rd, float( RT ) );
				const tMax = select( bottom.greaterThan( 0 ), bottom, top ).toVar();
				const dt = tMax.div( 20 ).toVar();
				If( j.equal( 0 ), () => {

					throughput.assign( vec3( 1 ) );
					L.assign( vec3( 0 ) );
					fms.assign( vec3( 0 ) );

				} );
				const p = ro.add( rd.mul( float( j ).add( 0.3 ).mul( dt ) ) ).toVar();
				const pr = length( p ).toVar(), h = pr.sub( RG ).toVar();
				const m = mediumScattering( h, this.rayleighScale, this.mieScale ).toVar();
				const ext = extinction( h, m.rgb, m.a, this.ozoneScale ).toVar();
				const scattering = m.rgb.add( m.a ).toVar();
				const cosSunP = dot( p.div( pr ), sun ).toVar();
				const TSun = sampleTransmittance( pr, cosSunP ).toVar();
				const shadow = select( raySphereNearest( p, sun, float( RG ) ).greaterThan( 0 ), 0, 1 );
				const S = TSun.mul( shadow ).mul( scattering ).mul( 1 / ( 4 * Math.PI ) ).toVar();
				const TStep = exp( ext.mul( dt ).negate() ).toVar();
				const integral = throughput.mul( vec3( 1 ).sub( TStep ) ).div( max( ext, vec3( 1e-6 ) ) ).toVar();
				L.addAssign( S.mul( integral ) );
				fms.addAssign( scattering.mul( integral ) );
				throughput.mulAssign( TStep );
				If( j.equal( 19 ), () => {

					If( bottom.greaterThan( 0 ), () => {

						const up = normalize( ro.add( rd.mul( tMax ) ) );
						const cosSunGround = dot( up, sun ).toVar();
						const TGround = sampleTransmittance( float( RG ), cosSunGround );
						L.addAssign( TGround.mul( throughput ).mul( max( cosSunGround, 0 ) ).mul( this.groundAlbedo ).div( Math.PI ) );

					} );
					Lsum.addAssign( L );
					fmsSum.addAssign( fms );

				} );

			} );
			const Lin = Lsum.div( 64 ), fmsAvg = fmsSum.div( 64 );
			return vec4( Lin.div( max( vec3( 1 ).sub( fmsAvg ), vec3( 1e-4 ) ) ), 1 );

		} )();

		const skyViewBake = Fn( () => {

			const q = uv().toVar();
			const u = q.x.sub( 0.5 / SV_W ).mul( SV_W / ( SV_W - 1 ) );
			const v = q.y.sub( 0.5 / SV_H ).mul( SV_H / ( SV_H - 1 ) ).toVar();
			const viewH = this.viewHeight;
			const beta = acos( sqrt( max( viewH.mul( viewH ).sub( RG * RG ), 0 ) ).div( viewH ) ).toVar();
			const horizonAngle = float( Math.PI ).sub( beta ).toVar();
			const angle = float( 0 ).toVar();
			If( v.lessThan( 0.5 ), () => {

				const c = float( 1 ).sub( v.mul( 2 ) );
				angle.assign( horizonAngle.mul( float( 1 ).sub( c.mul( c ) ) ) );

			} ).Else( () => {

				const c = v.mul( 2 ).sub( 1 );
				angle.assign( horizonAngle.add( beta.mul( c.mul( c ) ) ) );

			} );
			const lightCos = float( 1 ).sub( u.mul( u ).mul( 2 ) ).toVar();
			const lightSin = sqrt( max( float( 1 ).sub( lightCos.mul( lightCos ) ), 0 ) );
			const sunCos = this.sunDir.y;
			const sun = vec3( sqrt( max( float( 1 ).sub( sunCos.mul( sunCos ) ), 0 ) ), sunCos, 0 ).toVar();
			const rd = vec3( sin( angle ).mul( lightCos ), cos( angle ), sin( angle ).mul( lightSin ) ).toVar();
			const ro = vec3( 0, viewH, 0 ).toVar();
			const bottom = raySphereNearest( ro, rd, float( RG ) ).toVar();
			const tMax = select( bottom.greaterThan( 0 ), bottom, raySphereNearest( ro, rd, float( RT ) ) ).toVar();
			const mu = dot( rd, sun ).toVar(), mu2 = mu.mul( mu ).toVar();
			const rayPhase = mu2.add( 1 ).mul( 3 / ( 16 * Math.PI ) ).toVar();
			const g = this.mieG, g2 = g.mul( g );
			const miePhase = float( 1 ).sub( g2 ).mul( mu2.add( 1 ) ).mul( 3 / ( 8 * Math.PI ) )
				.div( g2.add( 2 ).mul( pow( max( g2.add( 1 ).sub( g.mul( mu ).mul( 2 ) ), 1e-4 ), 1.5 ) ) ).toVar();
			const throughput = vec3( 1 ).toVar(), L = vec3( 0 ).toVar();
			Loop( 32, ( { i } ) => {

				const t0 = float( i ).div( 32 ), t1 = float( i ).add( 1 ).div( 32 );
				const ta = t0.mul( t0 ).mul( tMax ), tb = t1.mul( t1 ).mul( tMax );
				const dt = tb.sub( ta ).toVar();
				const p = ro.add( rd.mul( mix( ta, tb, 0.3 ) ) ).toVar();
				const pr = length( p ).toVar(), h = pr.sub( RG ).toVar();
				const m = mediumScattering( h, this.rayleighScale, this.mieScale ).toVar();
				const ext = extinction( h, m.rgb, m.a, this.ozoneScale ).toVar();
				const cosSun = dot( p.div( pr ), sun ).toVar();
				const TSun = sampleTransmittance( pr, cosSun ).toVar();
				const shadow = select( raySphereNearest( p, sun, float( RG ) ).greaterThan( 0 ), 0, 1 );
				const ms = sampleMultiScat( pr, cosSun ).toVar();
				const phaseScat = m.rgb.mul( rayPhase ).add( m.a.mul( miePhase ) );
				const S = TSun.mul( shadow ).mul( phaseScat ).add( ms.mul( m.rgb.add( m.a ) ) ).toVar();
				const TStep = exp( ext.mul( dt ).negate() ).toVar();
				L.addAssign( throughput.mul( S ).mul( vec3( 1 ).sub( TStep ) ).div( max( ext, vec3( 1e-6 ) ) ) );
				throughput.mulAssign( TStep );

			} );
			return vec4( L.mul( this.sunIlluminance ), 1 );

		} )();

		this.quads = [ makeQuad( transmittanceBake ), makeQuad( multiScatBake ), makeQuad( skyViewBake ) ];

	}

	skyRadiance( dir: V3 ): V3 {

		const q = skyUV( dir, this.sunDir, this.viewHeight );
		return texture( this.skyViewLUT.texture, q ).level( float( 0 ) ).rgb;

	}

	transmittanceToSpace( dir: V3 ): V3 {

		const q = transmittanceUV( this.viewHeight, dir.y );
		return texture( this.transmittanceLUT.texture, q ).level( float( 0 ) ).rgb;

	}

	// CPU twin of the extinction march, used for the DirectionalLight's irradiance. More samples
	// than the LUT bake stabilize the very low sun without a GPU readback or a separate light model.
	transmittanceToSun(): THREE.Color {

		const dir = this.sunDir.value, r = this.viewHeight.value;
		const b = r * dir.y, groundDisc = b * b - ( r * r - RG * RG );
		if ( groundDisc >= 0 && - b - Math.sqrt( groundDisc ) > 0 ) return new THREE.Color( 0, 0, 0 );
		const distance = - b + Math.sqrt( b * b - ( r * r - RT * RT ) );
		const dt = distance / 256, opticalDepth = [ 0, 0, 0 ];
		for ( let i = 0; i < 256; i ++ ) {

			const t = ( i + 0.5 ) * dt;
			const h = Math.sqrt( t * t + 2 * r * dir.y * t + r * r ) - RG;
			const ray = Math.exp( - h / 8 ) * this.rayleighScale.value;
			const mie = Math.exp( - h / 1.2 ) * this.mieScale.value * 4.440e-3;
			const ozone = Math.max( 0, 1 - Math.abs( h - 25 ) / 15 ) * this.ozoneScale.value;
			for ( let c = 0; c < 3; c ++ ) opticalDepth[ c ] += ( RAYLEIGH[ c ] * ray + mie + OZONE[ c ] * ozone ) * dt;

		}
		return new THREE.Color( Math.exp( - opticalDepth[ 0 ] ), Math.exp( - opticalDepth[ 1 ] ), Math.exp( - opticalDepth[ 2 ] ) );

	}

	async update(): Promise<void> {

		const albedo = this.groundAlbedo.value;
		const staticKey = [ this.rayleighScale.value, this.mieScale.value, this.ozoneScale.value,
			albedo.r, albedo.g, albedo.b ].join( ',' );
		const sun = this.sunDir.value, illuminance = this.sunIlluminance.value;
		const skyKey = [ staticKey, sun.x, sun.y, sun.z, this.mieG.value, this.viewHeight.value,
			illuminance.r, illuminance.g, illuminance.b ].join( ',' );
		if ( skyKey === this.skyKey ) return;

		await this.renderer.init();
		const previous = this.renderer.getRenderTarget();
		try {

			if ( staticKey !== this.staticKey ) {

				this.renderer.setRenderTarget( this.transmittanceLUT );
				this.quads[ 0 ].render( this.renderer );
				this.renderer.setRenderTarget( this.multiScatLUT );
				this.quads[ 1 ].render( this.renderer );
				this.staticKey = staticKey;

			}
			this.renderer.setRenderTarget( this.skyViewLUT );
			this.quads[ 2 ].render( this.renderer );
			this.skyKey = skyKey;

		} finally {

			this.renderer.setRenderTarget( previous );

		}

	}

	dispose(): void {

		for ( const quad of this.quads ) ( quad.material as THREE.NodeMaterial ).dispose();
		this.transmittanceLUT.dispose();
		this.multiScatLUT.dispose();
		this.skyViewLUT.dispose();

	}

}
