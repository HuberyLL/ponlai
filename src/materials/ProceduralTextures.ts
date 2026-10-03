import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, struct, uv, texture, uniform, float, int, vec2, vec3, vec4, normalize, fract, floor, dot, mod, mix,
	length, smoothstep, sin, abs, pow, max, clamp,
} from 'three/tsl';

// Tileable detail textures baked on the GPU once at startup (no image files):
//   heights   R rock (beds, fractures)   G moss cushions   B sand ripples   A lichen spots
//   normalsA  RG rock normal             BA moss normal
//   normalsB  RG sand normal             B crack mask      A low-frequency variation
//   facets    RG chiselled-stone normal  B crack / cavity  A per-chip shade
// All periodic over [0, 1), mipmapped, anisotropic.

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type I = THREE.Node<'int'>;

const hash22 = Fn( ( [ p ]: [ V2 ] ) => {

	const a = fract( vec3( p.x, p.y, p.x ).mul( vec3( 0.1031, 0.1030, 0.0973 ) ) ).toVar();
	a.addAssign( dot( a, a.yzx.add( 33.33 ) ) );
	return fract( a.xx.add( a.yz ).mul( a.zy ) ).mul( 2 ).sub( 1 );

} ).setLayout( { name: 'hash22', type: 'vec2', inputs: [ { name: 'p', type: 'vec2' } ] } );

const hash12 = Fn( ( [ p ]: [ V2 ] ) => {

	const a = fract( vec3( p.x, p.y, p.x ).mul( 0.1031 ) ).toVar();
	a.addAssign( dot( a, a.yzx.add( 33.33 ) ) );
	return fract( a.x.add( a.y ).mul( a.z ) );

} ).setLayout( { name: 'hash12', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

// gradient noise with an integer period
const pnoise = Fn( ( [ p, per ]: [ V2, V2 ] ) => {

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

// chips: e.x border distance, e.yz unit normal of the nearest border (into this cell), e.w random
// per cell; g the chip's slope
const Facet = struct( { e: 'vec4', g: 'vec2' } );
const facets = ( q: V2, per: number, seed: number ) => Fn( () => {

	const p = q.mul( per );
	const i = floor( p ).toVar();
	const f = fract( p ).toVar();
	const md = float( 9 ).toVar();
	const mc = vec2( 0 ).toVar(), mo = vec2( 0 ).toVar();
	Loop( { start: int( - 1 ), end: int( 1 ), condition: '<=' }, { start: int( - 1 ), end: int( 1 ), condition: '<=' }, ( { i: y, j: x } ) => {

		const o = vec2( float( x ), float( y ) );
		const c = mod( i.add( o ), vec2( per ) ).toVar();
		const pt = o.add( 0.5 ).add( hash22( c.add( seed ) ).mul( 0.4 ) ).sub( f ).toVar();
		const d = dot( pt, pt ).toVar();
		If( d.lessThan( md ), () => {

			md.assign( d );
			mc.assign( c );
			mo.assign( pt );

		} );

	} );
	const me = float( 9 ).toVar();
	const en = vec2( 0, 1 ).toVar();
	Loop( { start: int( - 2 ), end: int( 2 ), condition: '<=' }, { start: int( - 2 ), end: int( 2 ), condition: '<=' }, ( { i: y, j: x } ) => {

		const o = vec2( float( x ), float( y ) );
		const pt = o.add( 0.5 ).add( hash22( mod( i.add( o ), vec2( per ) ).add( seed ) ).mul( 0.4 ) ).sub( f ).toVar();
		const e = pt.sub( mo ).toVar();
		const l = length( e ).toVar();
		If( l.greaterThanEqual( 1e-4 ), () => {

			const b = dot( mo.add( pt ).mul( 0.5 ), e.div( l ) ).toVar();
			If( b.lessThan( me ), () => {

				me.assign( b );
				en.assign( e.div( l ).negate() );

			} );

		} );

	} );
	return Facet( vec4( me.div( per ), en, hash12( mc.mul( 2.3 ).add( seed ) ) ), hash22( mc.mul( 1.37 ).add( seed + 3.1 ) ) );

} )() as unknown as { get( name: 'e' ): THREE.Node<'vec4'>; get( name: 'g' ): V2 };

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

// Rock detail between the large mesh facets and the fine grain: elongated 20-45 cm mineral
// plates with 15 cm chips at the material scale. Most contrast comes from surface orientation;
// mineral colour stays close to the parent stone and only some borders form a crevice.
const facetBake = ( q: V2 ) => Fn( () => {

	const L = facets( q.mul( vec2( 2, 1 ) ), 8, 0 );
	const Sm = facets( q.add( 0.37 ), 24, 17 );
	const Le = L.get( 'e' ).toVar();
	const slope = L.get( 'g' ).mul( 0.30 ).add( Sm.get( 'g' ).mul( 0.16 ) ).toVar();
	const showL = smoothstep( 0.05, 0.4, pnoise( q.mul( 6 ).add( 0.7 ), vec2( 6 ) ) );
	const vL = float( 1 ).sub( smoothstep( 0, 0.009, Le.x ) ).mul( showL ).toVar();
	slope.addAssign( Le.yz.mul( vL ).mul( 0.65 ) );
	slope.assign( clamp( slope, vec2( - 0.62 ), vec2( 0.62 ) ) );
	const wp = q.add( vec2( fbm( q.add( 0.2 ), 4, 3 ), fbm( q.add( 0.9 ), 4, 3 ) ).mul( 0.06 ) ).toVar();
	const c1 = float( 1 ).sub( abs( pnoise( wp.mul( 3 ), vec2( 3 ) ) ) );
	const c2 = float( 1 ).sub( abs( pnoise( vec2( wp.x.mul( 7 ), wp.y.mul( 2 ) ).add( 0.5 ), vec2( 7, 2 ) ) ) );
	const crack = max( pow( c1, 80 ), pow( c2, 90 ).mul( 0.7 ) ).mul( smoothstep( 0, 0.4, pnoise( q.mul( 5 ).add( 3.1 ), vec2( 5 ) ) ) ).mul( 0.4 );
	const pc = pcell( q.add( 0.11 ), float( 34 ) );
	const pit = float( 1 ).sub( smoothstep( 0.05, 0.3, pc.x ) ).mul( smoothstep( 0, 0.5, pnoise( q.mul( 7 ).add( 1.3 ), vec2( 7 ) ).add( 0.2 ) ) );
	const n = normalize( vec3( slope.negate(), 1 ) );
	const cavity = clamp( max( max( crack, vL.mul( 0.36 ) ), pit.mul( 0.25 ) ), 0, 1 );
	const shade = Le.w.sub( 0.5 ).mul( 0.09 ).add( 0.5 ).add( Sm.get( 'e' ).w.sub( 0.5 ).mul( 0.035 ) ).add( fbm( q, 6, 5 ).mul( 0.1 ) ).add( fbm( q, 96, 2 ).mul( 0.035 ) );
	return vec4( n.xy.mul( 0.5 ).add( 0.5 ), cavity, clamp( shade, 0, 1 ) );

} )();

export interface DetailTextures {
	heights: THREE.Texture;
	normalsA: THREE.Texture;
	normalsB: THREE.Texture;
	facets: THREE.Texture;
}

export function bakeProceduralTextures( renderer: THREE.WebGPURenderer, size = 1024 ): DetailTextures {

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

	const heights = make( 'heights' ), normalsA = make( 'normalsA' ), normalsB = make( 'normalsB' ), facets = make( 'facets' );
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
	render( facets, facetBake( uv() ) );

	renderer.setRenderTarget( prev );

	return { heights: heights.texture, normalsA: normalsA.texture, normalsB: normalsB.texture, facets: facets.texture };

}
