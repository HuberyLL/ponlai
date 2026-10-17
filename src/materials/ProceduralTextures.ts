/*!
 * hash22 is "Hash without Sine" by David Hoskins (https://www.shadertoy.com/view/4djSRW).
 * Copyright (c) 2014 David Hoskins
 * Licensed under the MIT License; see ./hoskins-hash.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import { createSoilTexture } from './Soil.ts';
import {
	Fn, If, Loop, uv, texture, uniform, float, int, vec2, vec3, vec4, normalize, fract, floor, dot, mod, mix,
	length, smoothstep, sin, cos, abs, pow, max, clamp, step,
} from 'three/tsl';

// Tileable detail textures baked on the GPU once at startup (no image files):
//   heights   R rock (beds, fractures)   G moss cushions   B sand ripples   A lichen spots
//   normalsA  RG rock normal             BA moss normal
//   normalsB  RG sand normal             B crack mask      A low-frequency variation
//   gravel    R cover of the first stones   G cover of the next stones   B the stones' height
//             A low-frequency variation (normalsB's A, again: the cliff reads it here, which keeps
//             its fragment stage within WebGPU's 16 sampled textures)
// All periodic over [0, 1), mipmapped, anisotropic.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type I = THREE.Node<'int'>;

export const hash22 = Fn( ( [ p ]: [ V2 ] ) => {

	const a = fract( vec3( p.x, p.y, p.x ).mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	a.addAssign( dot( a, a.yzx.add( 33.33 ) ) );
	return fract( a.xx.add( a.yz ).mul( a.zy ) ).mul( 2 ).sub( 1 );

} ).setLayout( { name: 'hash22', type: 'vec2', inputs: [ { name: 'p', type: 'vec2' } ] } );

// gradient noise with an integer period
export const pnoise = Fn( ( [ p, per ]: [ V2, V2 ] ) => {

	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const u = f.mul( f ).mul( f ).mul( f.mul( f.mul( 6 ).sub( 15 ) ).add( 10 ) );
	const ga = dot( hash22( mod( i, per ) ), f );
	const gb = dot( hash22( mod( i.add( vec2( 1, 0 ) ), per ) ), f.sub( vec2( 1, 0 ) ) );
	const gc = dot( hash22( mod( i.add( vec2( 0, 1 ) ), per ) ), f.sub( vec2( 0, 1 ) ) );
	const gd = dot( hash22( mod( i.add( vec2( 1, 1 ) ), per ) ), f.sub( vec2( 1, 1 ) ) );
	return mix( mix( ga, gb, u.x ), mix( gc, gd, u.x ), u.y ).mul( 1.4 );

} ).setLayout( { name: 'pnoise', type: 'float', inputs: [ { name: 'p', type: 'vec2' }, { name: 'per', type: 'vec2' } ] } );

const pfbm = Fn( ( [ q, per0, oct ]: [ V2, F, I ] ) => {

	const s = float( 0 ).toVar(), a = float( 0.5 ).toVar(), n = float( 0 ).toVar(), per = float( per0 ).toVar();
	Loop( { start: int( 0 ), end: oct, type: 'int', condition: '<' }, () => {

		s.addAssign( a.mul( pnoise( q.mul( per ), vec2( per ) ) ) );
		n.addAssign( a );
		a.mulAssign( 0.5 );
		per.mulAssign( 2 );

	} );
	return s.div( n );

} ).setLayout( { name: 'pfbm', type: 'float', inputs: [ { name: 'q', type: 'vec2' }, { name: 'per0', type: 'float' }, { name: 'oct', type: 'int' } ] } );

const fbm = ( q: V2, per: number, oct: number ) => pfbm( q, float( per ), int( oct ) );

// periodic cellular noise: F1, F2
const pcell = Fn( ( [ q, per ]: [ V2, F ] ) => {

	const p = q.mul( per );
	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const f1 = float( 9 ).toVar(), f2 = float( 9 ).toVar();
	Loop( { start: int( - 1 ), end: int( 1 ), condition: '<=' }, { start: int( - 1 ), end: int( 1 ), condition: '<=' }, ( { i: y, j: x } ) => {

		const o = vec2( float( x ), float( y ) );
		const d = length( o.add( 0.5 ).add( hash22( mod( i.add( o ), vec2( per ) ) ).mul( 0.42 ) ).sub( f ) ).toVar();
		If( d.lessThan( f1 ), () => {

			f2.assign( f1 );
			f1.assign( d );

		} ).ElseIf( d.lessThan( f2 ), () => {

			f2.assign( d );

		} );

	} );
	return vec2( f1, f2 );

} ).setLayout( { name: 'pcell', type: 'vec2', inputs: [ { name: 'q', type: 'vec2' }, { name: 'per', type: 'float' } ] } );

const heightBake = ( q: V2 ) => Fn( () => {

	// rock: weathered, bedded, with two joint sets (one near-vertical) and solution pits
	const warp = fbm( q.add( 0.31 ), 3, 3 ).toVar();
	const beds = smoothstep( 0.1, 0.9, sin( q.y.mul( 6 ).add( warp.mul( 0.8 ) ).mul( 6.2831853 ) ).mul( 0.5 ).add( 0.5 ) );
	const fr = float( 1 ).sub( abs( pnoise( q.mul( 4 ).add( vec2( warp.mul( 0.7 ) ) ), vec2( 4 ) ) ) );
	const fr2 = float( 1 ).sub( abs( pnoise( vec2( q.x.mul( 9 ), q.y.mul( 2 ) ).add( vec2( warp.mul( 1.3 ), 0 ) ), vec2( 9, 2 ) ) ) );
	const fractures = max( pow( fr, 40 ), pow( fr2, 50 ).mul( 0.8 ) );
	const pits = float( 1 ).sub( smoothstep( 0, 0.35, pcell( q, float( 26 ) ).x ) );
	const rock = fbm( q, 4, 7 ).mul( 0.24 ).add( 0.52 ).add( beds.mul( 0.06 ) ).sub( fractures.mul( 0.14 ) ).sub( pits.mul( 0.04 ) ).add( fbm( q, 48, 3 ).mul( 0.025 ) );
	// moss cushions: overlapping rounded lumps with fine fibres
	const m1 = pcell( q, float( 22 ) ), m2 = pcell( q.add( 0.37 ), float( 41 ) );
	const moss = float( 1 ).sub( smoothstep( 0, 0.85, m1.x ) ).mul( 0.4 )
		.add( float( 1 ).sub( smoothstep( 0, 0.7, m2.x ) ).mul( 0.25 ) )
		.add( fbm( q, 96, 3 ).mul( 0.2 ) )
		.add( fbm( q, 8, 4 ).mul( 0.5 ).add( 0.5 ).mul( 0.25 ) );
	// sand ripples: asymmetric crests, warped, with bifurcations
	const rw = fbm( q.add( 0.71 ), 2, 4 ).mul( 1.6 ).add( fbm( q, 8, 2 ).mul( 0.25 ) );
	const ph = fract( q.x.mul( 11 ).add( q.y.mul( 3 ) ).add( rw ) ).toVar();
	const ripple = smoothstep( 0, 0.72, ph ).mul( float( 1 ).sub( smoothstep( 0.72, 1, ph ) ) );
	const sand = ripple.mul( 0.75 ).add( fbm( q, 128, 2 ).mul( 0.5 ).add( 0.5 ).mul( 0.25 ) );
	// lichen and pale crust spots
	const lich = smoothstep( 0.2, 0.55, fbm( q.add( 0.13 ), 14, 4 ) ).mul( smoothstep( - 0.1, 0.4, fbm( q, 4, 2 ) ) );
	return vec4( clamp( rock, 0, 1 ), clamp( moss, 0, 1 ), clamp( sand, 0, 1 ), lich );

} )();

// crack mask and low-frequency variation for normalsB
const crackBake = ( q: V2 ) => Fn( () => {

	const warp = fbm( q.add( 0.31 ), 3, 3 ).toVar();
	const fr = float( 1 ).sub( abs( pnoise( q.mul( 4 ).add( vec2( warp.mul( 0.7 ) ) ), vec2( 4 ) ) ) );
	const fr2 = float( 1 ).sub( abs( pnoise( vec2( q.x.mul( 9 ), q.y.mul( 2 ) ).add( vec2( warp.mul( 1.3 ), 0 ) ), vec2( 9, 2 ) ) ) );
	return vec2( max( pow( fr, 40 ), pow( fr2, 50 ).mul( 0.8 ) ), fbm( q.add( 0.5 ), 2, 4 ).mul( 0.5 ).add( 0.5 ) );

} )();

// Gravel: small stones in a periodic Worley lattice (GRAVEL_CELLS cells across the tile), a share
// of the cells holding one (after the small stones of tidewater's detail map, its G channel,
// Daniel Greenheck, MIT; the technique only). Each is an ellipse turned by its cell's hash, of radius
// GRAVEL_RADIUS cells and up to GRAVEL_ASPECT times as long as wide, domed (its slope from the
// dome, GRAVEL_FLAT times a hemisphere's height). Its cell's rank sorts it into the first stones
// (rank under GRAVEL_FIRST: R) or the next ones (under GRAVEL_NEXT: G), so the ground turns its
// stones on in two steps as the soil thins (TerrainMaterial.ts); B holds the height of whichever
// stone covers the texel, in GRAVEL_HEIGHT cells (the ground takes its slope by differences).
// Covers and heights are averages, so the mips keep the stones' mean cover at a distance.
export const GRAVEL_CELLS = 48, GRAVEL_HEIGHT = 0.3;
const GRAVEL_RADIUS = [ 0.28, 0.48 ], GRAVEL_ASPECT = 0.6, GRAVEL_FLAT = 0.6, GRAVEL_FIRST = 0.22, GRAVEL_NEXT = 0.55;

const gravelBake = ( q: V2 ) => Fn( () => {

	const p = q.mul( GRAVEL_CELLS );
	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const first = float( 0 ).toVar(), next = float( 0 ).toVar(), height = float( 0 ).toVar(), best = float( 0 ).toVar();
	Loop( { start: int( - 1 ), end: int( 1 ), condition: '<=' }, { start: int( - 1 ), end: int( 1 ), condition: '<=' }, ( { i: y, j: x } ) => {

		const o = vec2( float( x ), float( y ) );
		const id = mod( i.add( o ), vec2( GRAVEL_CELLS ) );
		const h1 = hash22( id ).mul( 0.5 ).add( 0.5 ), h2 = hash22( id.add( 17.31 ) ), h3 = hash22( id.add( 41.73 ) ).mul( 0.5 ).add( 0.5 );
		const rank = h1.x;
		const radius = h1.y.mul( GRAVEL_RADIUS[ 1 ] - GRAVEL_RADIUS[ 0 ] ).add( GRAVEL_RADIUS[ 0 ] );
		const aspect = h3.y.mul( GRAVEL_ASPECT ).add( 1 );
		const angle = h3.x.mul( Math.PI );
		const c = cos( angle ), sn = sin( angle );
		const d = f.sub( o.add( 0.5 ).add( h2.mul( 0.25 ) ) );
		// the texel in the stone's own frame, its ellipse the unit circle
		const lx = d.x.mul( c ).add( d.y.mul( sn ) ).div( radius ), ly = d.y.mul( c ).sub( d.x.mul( sn ) ).mul( aspect ).div( radius );
		const rho = length( vec2( lx, ly ) );
		const cover = float( 1 ).sub( smoothstep( 0.82, 1, rho ) ).mul( step( rank, GRAVEL_NEXT ) );
		If( cover.greaterThan( best ), () => {

			best.assign( cover );
			height.assign( max( float( 1 ).sub( rho.mul( rho ) ), 0 ).sqrt().mul( radius ).mul( GRAVEL_FLAT ) );
			first.assign( cover.mul( step( rank, GRAVEL_FIRST ) ) );
			next.assign( cover.mul( float( 1 ).sub( step( rank, GRAVEL_FIRST ) ) ) );

		} );

	} );
	return vec4( first, next, clamp( height.div( GRAVEL_HEIGHT ), 0, 1 ), fbm( q.add( 0.5 ), 2, 4 ).mul( 0.5 ).add( 0.5 ) );

} )();

export interface DetailTextures {
	soil: THREE.Texture;
	heights: THREE.Texture;
	gravel: THREE.Texture;
	normalsA: THREE.Texture;
	normalsB: THREE.Texture;
	rockAlbedo: THREE.Texture;
	rockDetail: THREE.Texture;
}

export async function bakeProceduralTextures( renderer: THREE.WebGPURenderer, size = 1024 ): Promise<DetailTextures> {

	const make = ( name: string ) => {

		const rt = new THREE.RenderTarget( size, size, {
			type: THREE.UnsignedByteType, generateMipmaps: true,
			minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter,
			wrapS: THREE.RepeatWrapping, wrapT: THREE.RepeatWrapping, depthBuffer: false,
			anisotropy: 8,
		} );
		rt.texture.name = name;
		return rt;

	};

	const heights = make( 'heights' ), normalsA = make( 'normalsA' ), normalsB = make( 'normalsB' ), gravel = make( 'gravel' );
	const quad = new THREE.QuadMesh( new THREE.NodeMaterial() );
	const render = ( rt: THREE.RenderTarget, node: THREE.Node ) => {

		const mat = new THREE.NodeMaterial();
		mat.fragmentNode = node;
		quad.material = mat;
		renderer.setRenderTarget( rt );
		quad.render( renderer );
		mat.dispose();

	};

	const prev = renderer.getRenderTarget();
	render( heights, heightBake( uv() ) );

	// normals from the height channels: relief (m) / texel size (m) per channel
	const strength = uniform( new THREE.Vector3( 18.0, 8.0, 9.0 ) );
	const tH = heights.texture;
	const e = 1 / size;
	const l = texture( tH, uv().sub( vec2( e, 0 ) ) ), r = texture( tH, uv().add( vec2( e, 0 ) ) );
	const d = texture( tH, uv().sub( vec2( 0, e ) ) ), u = texture( tH, uv().add( vec2( 0, e ) ) );
	const dx = r.sub( l ).mul( 0.5 * size / 1024 ), dy = u.sub( d ).mul( 0.5 * size / 1024 );
	const nr = normalize( vec3( dx.r.mul( strength.x ).negate(), dy.r.mul( strength.x ).negate(), 1 ) );
	const nm = normalize( vec3( dx.g.mul( strength.y ).negate(), dy.g.mul( strength.y ).negate(), 1 ) );
	const ns = normalize( vec3( dx.b.mul( strength.z ).negate(), dy.b.mul( strength.z ).negate(), 1 ) );
	render( normalsA, vec4( nr.xy.mul( 0.5 ).add( 0.5 ), nm.xy.mul( 0.5 ).add( 0.5 ) ) );
	const cl = crackBake( uv() );
	render( normalsB, vec4( ns.xy.mul( 0.5 ).add( 0.5 ), cl.x, cl.y ) );
	render( gravel, gravelBake( uv() ) );

	renderer.setRenderTarget( prev );

	// CC0 scan supplies irregular mineral relief; generated textures still serve moss and sand.
	// Keep the detail map linear: its RGB is OpenGL normals and alpha is roughness.
	const loader = new THREE.TextureLoader();
	const [ rockAlbedo, rockDetail ] = await Promise.all( [
		loader.loadAsync( `${ import.meta.env.BASE_URL }textures/rock/rock_albedo.jpg` ),
		loader.loadAsync( `${ import.meta.env.BASE_URL }textures/rock/rock_detail.png` ),
	] );
	rockAlbedo.colorSpace = THREE.SRGBColorSpace;
	for ( const map of [ rockAlbedo, rockDetail ] ) {

		map.wrapS = map.wrapT = THREE.RepeatWrapping;
		map.anisotropy = 8;
		map.needsUpdate = true;

	}
	return { soil: createSoilTexture(), heights: heights.texture, gravel: gravel.texture, normalsA: normalsA.texture, normalsB: normalsB.texture, rockAlbedo, rockDetail };

}
