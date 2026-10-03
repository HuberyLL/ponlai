import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uv, uniform, texture, positionLocal, normalize, smoothstep, dot, step, vec2, vec3, vec4, float, int,
	sqrt, min, max, pow, exp, length, atan, asin, clamp, cos, sin, mix,
} from 'three/tsl';

// Single-scattering atmosphere (Rayleigh + Mie, Nishita-style ray march, after wwwtyro's
// glsl-atmosphere) baked into an equirectangular HDR texture whenever the sun moves. The same
// bake feeds the sky dome, the water's reflections (mipmapped for rough reflections), the PMREM
// environment for the PBR materials, and a small read-back that gives the sky irradiance for
// ambient terms.
//
// Units: the sun's irradiance at the top of the atmosphere is `sunIlluminance`; sky radiance and
// the ground-level sun colour are in the same units.

const R_PLANET = 6371e3, R_ATMOS = 6471e3;
const K_RAY = [ 5.5e-6, 13.0e-6, 22.4e-6 ];
const K_MIE = 32e-6;
const H_RAY = 8e3, H_MIE = 1.4e3;
const MIE_G = 0.76;

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// ray / sphere (centred on the origin) intersection distances; ( 1e5, -1e5 ) when missed
const atmRsi = Fn( ( [ r0, rd, sr ]: [ V3, V3, F ] ) => {

	const a = dot( rd, rd ), b = dot( rd, r0 ).mul( 2 ), c = dot( r0, r0 ).sub( sr.mul( sr ) );
	const d = b.mul( b ).sub( a.mul( c ).mul( 4 ) ).toVar();
	const res = vec2( 1e5, - 1e5 ).toVar();
	If( d.greaterThanEqual( 0 ), () => {

		const sq = sqrt( d );
		res.assign( vec2( b.negate().sub( sq ).div( a.mul( 2 ) ), b.negate().add( sq ).div( a.mul( 2 ) ) ) );

	} );
	return res;

} ).setLayout( { name: 'atmRsi', type: 'vec2', inputs: [ { name: 'r0', type: 'vec3' }, { name: 'rd', type: 'vec3' }, { name: 'sr', type: 'float' } ] } );

// radiance scattered toward -r (r = view direction) for a sun of unit irradiance
const atmosphere = Fn( ( [ r, pSun ]: [ V3, V3 ] ) => {

	const kRlh = vec3( ...K_RAY ), kMie = float( K_MIE ), g = MIE_G;
	const r0 = vec3( 0, R_PLANET + 2, 0 );
	const result = vec3( 0 ).toVar();
	const p = atmRsi( r0, r, float( R_ATMOS ) ).toVar();
	If( p.x.lessThanEqual( p.y ), () => {

		const hit = atmRsi( r0, r, float( R_PLANET ) ).x.toVar();
		If( hit.greaterThan( 0 ), () => {

			p.assign( vec2( p.x, min( p.y, hit ) ) );

		} );
		const I_STEPS = 24, J_STEPS = 8;
		const iStepSize = p.y.sub( max( p.x, 0 ) ).div( I_STEPS ).toVar();
		const iTime = max( p.x, 0 ).toVar();
		const totalRlh = vec3( 0 ).toVar(), totalMie = vec3( 0 ).toVar();
		const iOdRlh = float( 0 ).toVar(), iOdMie = float( 0 ).toVar();
		const mu = dot( r, pSun ).toVar();
		const mumu = mu.mul( mu );
		const pRlh = mumu.add( 1 ).mul( 3 / ( 16 * Math.PI ) );
		const pMie = mumu.add( 1 ).mul( ( 3 / ( 8 * Math.PI ) ) * ( 1 - g * g ) ).div( pow( mu.mul( - 2 * g ).add( 1 + g * g ), 1.5 ).mul( 2 + g * g ) );
		Loop( { start: int( 0 ), end: int( I_STEPS ) }, () => {

			const iPos = r0.add( r.mul( iTime.add( iStepSize.mul( 0.5 ) ) ) ).toVar();
			const iHeight = length( iPos ).sub( R_PLANET );
			const odStepRlh = exp( iHeight.negate().div( H_RAY ) ).mul( iStepSize ).toVar();
			const odStepMie = exp( iHeight.negate().div( H_MIE ) ).mul( iStepSize ).toVar();
			iOdRlh.addAssign( odStepRlh );
			iOdMie.addAssign( odStepMie );
			const jStepSize = atmRsi( iPos, pSun, float( R_ATMOS ) ).y.div( J_STEPS ).toVar();
			const jTime = float( 0 ).toVar(), jOdRlh = float( 0 ).toVar(), jOdMie = float( 0 ).toVar();
			Loop( { start: int( 0 ), end: int( J_STEPS ) }, () => {

				const jHeight = length( iPos.add( pSun.mul( jTime.add( jStepSize.mul( 0.5 ) ) ) ) ).sub( R_PLANET ).toVar();
				jOdRlh.addAssign( exp( jHeight.negate().div( H_RAY ) ).mul( jStepSize ) );
				jOdMie.addAssign( exp( jHeight.negate().div( H_MIE ) ).mul( jStepSize ) );
				jTime.addAssign( jStepSize );

			} );
			const attn = exp( kMie.mul( 1.1 ).mul( iOdMie.add( jOdMie ) ).add( kRlh.mul( iOdRlh.add( jOdRlh ) ) ).negate() );
			totalRlh.addAssign( attn.mul( odStepRlh ) );
			totalMie.addAssign( attn.mul( odStepMie ) );
			iTime.addAssign( iStepSize );

		} );
		result.assign( kRlh.mul( totalRlh ).mul( pRlh ).add( totalMie.mul( kMie ).mul( pMie ) ) );

	} );
	return result;

} ).setLayout( { name: 'atmosphere', type: 'vec3', inputs: [ { name: 'r', type: 'vec3' }, { name: 'pSun', type: 'vec3' } ] } );

// direction <-> equirectangular uv
export const dirToEquirect = Fn( ( [ d ]: [ V3 ] ) => {

	return vec2( atan( d.z, d.x ).mul( 0.5 / Math.PI ).add( 0.5 ), asin( clamp( d.y, - 1, 1 ) ).div( Math.PI ).add( 0.5 ) );

} ).setLayout( { name: 'dirToEquirect', type: 'vec2', inputs: [ { name: 'd', type: 'vec3' } ] } );

const equirectToDir = Fn( ( [ q ]: [ V2 ] ) => {

	const phi = q.x.sub( 0.5 ).mul( 2 * Math.PI ).toVar(), th = q.y.sub( 0.5 ).mul( Math.PI ).toVar();
	return vec3( cos( th ).mul( cos( phi ) ), sin( th ), cos( th ).mul( sin( phi ) ) );

} ).setLayout( { name: 'equirectToDir', type: 'vec3', inputs: [ { name: 'q', type: 'vec2' } ] } );

// the bake: rgb radiance, a = the direction's elevation sine (lets the read-back integrate the
// upper hemisphere whatever the texture's row order)
const skyBake = ( q: V2, sunDir: V3, illum: F, sea: V3, haze: F, hazeTint: V3 ) => Fn( () => {

	const d = equirectToDir( q ).toVar();
	// a bright, slightly warm haze over the clear-sky radiance, strongest at the horizon and toward
	// the sun: it pales the sky the water reflects (a warm, humid evening)
	const hz = atmosphere( normalize( vec3( d.x, 0.02, d.z ) ), sunDir ).mul( illum );
	const lum = dot( hz, vec3( 0.2126, 0.7152, 0.0722 ) );
	const toSun = pow( max( dot( normalize( d.xz.add( 1e-5 ) ), normalize( sunDir.xz.add( 1e-5 ) ) ), 0 ), 3 );
	const hazeCol = hazeTint.mul( lum ).mul( toSun.mul( 0.25 ).add( 1.1 ) ).toVar();
	const col = vec3( 0 ).toVar();
	If( d.y.greaterThanEqual( 0 ), () => {

		const sky = atmosphere( normalize( vec3( d.x, max( d.y, 0.0015 ), d.z ) ), sunDir ).mul( illum );
		col.assign( mix( sky, hazeCol, haze.mul( exp( d.y.mul( - 2.2 ) ) ) ) );

	} ).Else( () => {

		// below the horizon: the open sea seen from far away, darkening downward
		const h0 = atmosphere( normalize( vec3( d.x, 0.0015, d.z ) ), sunDir ).mul( illum );
		col.assign( mix( mix( h0, hazeCol, haze ).mul( 0.45 ), sea.mul( illum ), smoothstep( 0, 0.25, d.y.negate() ) ) );

	} );
	return vec4( col, d.y );

} )();

export class Sky {

	renderer: THREE.WebGPURenderer;
	sunIlluminance: number;
	elevation: number;
	azimuth: number;
	haze: number;
	hazeTint = new THREE.Color( 1.0, 0.93, 0.80 );
	// artistic warmth on top of the atmosphere's own reddening of the sun
	sunTint = new THREE.Color( 1.0, 0.87, 0.68 );
	sunDir = new THREE.Vector3();
	sunColor = new THREE.Color(); // irradiance at sea level
	skyIrradiance = new THREE.Color(); // E / PI over the upper hemisphere
	// radiance of the sea seen from the shore, per unit sun illuminance (the bounce light the
	// cliffs get from below)
	seaColor = new THREE.Color( 0.0045, 0.0125, 0.0140 );
	equirect: THREE.RenderTarget;
	small: THREE.RenderTarget;
	envMap: THREE.RenderTarget | null = null;
	dome: THREE.Mesh;

	private pmrem: THREE.PMREMGenerator;
	private quad: THREE.QuadMesh;
	private u = {
		sunDir: uniform( new THREE.Vector3() ),
		illum: uniform( 9 ),
		sea: uniform( new THREE.Vector3() ),
		haze: uniform( 0.5 ),
		hazeTint: uniform( new THREE.Vector3() ),
		sunColor: uniform( new THREE.Color() ),
	};

	constructor( renderer: THREE.WebGPURenderer, { sunIlluminance = 9.0, elevation = 14, azimuth = 52, haze = 0.5 } = {} ) {

		this.renderer = renderer;
		this.sunIlluminance = sunIlluminance;
		this.elevation = elevation;
		this.azimuth = azimuth;
		this.haze = haze;

		this.equirect = new THREE.RenderTarget( 1024, 512, {
			type: THREE.HalfFloatType, generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false,
		} );
		this.equirect.texture.mapping = THREE.EquirectangularReflectionMapping;
		this.equirect.texture.name = 'skyEquirect';
		this.small = new THREE.RenderTarget( 64, 32, { type: THREE.FloatType, depthBuffer: false } );

		const u = this.u;
		const bake = new THREE.NodeMaterial();
		bake.fragmentNode = skyBake( uv(), u.sunDir, u.illum, u.sea, u.haze, u.hazeTint );
		this.quad = new THREE.QuadMesh( bake );
		this.pmrem = new THREE.PMREMGenerator( renderer );

		// the visible dome: the baked radiance plus the sun's disc
		const domeMat = new THREE.MeshBasicNodeMaterial( { side: THREE.BackSide, depthWrite: false } );
		const d = normalize( positionLocal );
		const disc = smoothstep( 0.99996, 0.99999, dot( d, u.sunDir ) ).mul( step( 0, d.y ) );
		domeMat.colorNode = vec4( texture( this.equirect.texture, dirToEquirect( d ) ).level( float( 0 ) ).rgb.add( u.sunColor.mul( disc ).mul( 900 ) ), 1 );
		this.dome = new THREE.Mesh( new THREE.SphereGeometry( 1000, 64, 32 ), domeMat );
		this.dome.frustumCulled = false;
		this.dome.renderOrder = - 1000;

	}

	async update(): Promise<void> {

		const el = THREE.MathUtils.degToRad( this.elevation ), az = THREE.MathUtils.degToRad( this.azimuth );
		this.sunDir.set( Math.cos( el ) * Math.cos( az ), Math.sin( el ), Math.cos( el ) * Math.sin( az ) ).normalize();

		// sun colour at sea level: optical depth through the same atmosphere
		const T = transmittance( this.sunDir );
		this.sunColor.setRGB( T[ 0 ], T[ 1 ], T[ 2 ] ).multiply( this.sunTint ).multiplyScalar( this.sunIlluminance );

		const u = this.u;
		u.sunDir.value.copy( this.sunDir );
		u.illum.value = this.sunIlluminance;
		u.sea.value.set( this.seaColor.r, this.seaColor.g, this.seaColor.b );
		u.haze.value = this.haze;
		u.hazeTint.value.set( this.hazeTint.r, this.hazeTint.g, this.hazeTint.b );
		u.sunColor.value.copy( this.sunColor );

		const r = this.renderer;
		const prev = r.getRenderTarget();
		for ( const rt of [ this.equirect, this.small ] ) {

			r.setRenderTarget( rt );
			this.quad.render( r );

		}

		r.setRenderTarget( prev );

		// cosine-weighted hemisphere integral of the small bake -> irradiance / PI; each texel
		// carries its own elevation sine in alpha
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

		if ( this.envMap ) this.envMap.dispose();
		this.envMap = this.pmrem.fromEquirectangular( this.equirect.texture );

	}

}

// sun transmittance from sea level along `dir` (JS twin of the shader's light march)
function transmittance( dir: THREE.Vector3 ): number[] {

	const r0 = [ 0, R_PLANET + 2, 0 ];
	// distance to the top of the atmosphere
	const b = 2 * ( r0[ 1 ] * dir.y ), c = r0[ 1 ] * r0[ 1 ] - R_ATMOS * R_ATMOS;
	const tMax = ( - b + Math.sqrt( b * b - 4 * c ) ) / 2;
	const n = 256, ds = tMax / n;
	let odR = 0, odM = 0;
	for ( let i = 0; i < n; i ++ ) {

		const t = ( i + 0.5 ) * ds;
		const x = dir.x * t, y = r0[ 1 ] + dir.y * t, z = dir.z * t;
		const h = Math.sqrt( x * x + y * y + z * z ) - R_PLANET;
		odR += Math.exp( - h / H_RAY ) * ds;
		odM += Math.exp( - h / H_MIE ) * ds;

	}

	return K_RAY.map( ( k ) => Math.exp( - ( k * odR + K_MIE * 1.1 * odM ) ) );

}
