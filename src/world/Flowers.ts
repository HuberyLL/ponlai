import * as THREE from 'three/webgpu';
import { attribute, texture, uv, select, positionGeometry, positionLocal, normalViewGeometry, vec2, vec3, dot, sin } from 'three/tsl';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import type { Shared } from '../shared.ts';

// Wildflowers in the meadow: small instanced blossoms (a cross of two petal cards on a short
// stem) in drifts of one colour each, white, butter yellow, pink and lilac: colour accents in the
// meadow. They sway with the grass.

const STRIDE = 8;

function petalTexture( size = 64 ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' )!;
	g.clearRect( 0, 0, size, size );
	const n = 5, R = size * 0.46;
	g.fillStyle = '#fff';
	for ( let i = 0; i < n; i ++ ) {

		const a = i / n * Math.PI * 2;
		g.save();
		g.translate( size / 2, size / 2 );
		g.rotate( a );
		g.beginPath();
		g.ellipse( R * 0.5, 0, R * 0.5, R * 0.26, 0, 0, Math.PI * 2 );
		g.fill();
		g.restore();

	}

	// a darker eye: alpha stays, the colour channel carries the shading
	g.fillStyle = '#b08a2a';
	g.beginPath();
	g.arc( size / 2, size / 2, R * 0.22, 0, Math.PI * 2 );
	g.fill();
	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	return tex;

}

// a blossom: two crossed petal cards tipped toward the sky, on a thin stem; 1 = its height
function blossomGeometry() {

	const P: number[] = [], N: number[] = [], U: number[] = [], T: number[] = [], I: number[] = [];
	const quad = ( a: number[], b: number[], c: number[], d: number[], n: number[], t: number ) => {

		const base = P.length / 3;
		P.push( ...a, ...b, ...c, ...d );
		for ( let i = 0; i < 4; i ++ ) { N.push( ...n ); T.push( t ); }
		U.push( 0, 0, 1, 0, 1, 1, 0, 1 );
		I.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	};

	// head: two cards, nearly horizontal, crossed
	const h = 1, s = 0.42;
	quad( [ - s, h - 0.05, - s ], [ s, h + 0.05, - s ], [ s, h + 0.05, s ], [ - s, h - 0.05, s ], [ 0, 1, 0 ], 1 );
	quad( [ - s * 0.6, h + 0.04, - s ], [ s * 0.6, h - 0.04, - s ], [ s * 0.6, h - 0.04, s ], [ - s * 0.6, h + 0.04, s ], [ 0, 1, 0 ], 1 );
	// stem: a thin vertical card (no petal texture: uv in the eye)
	const w = 0.025;
	quad( [ - w, 0, 0 ], [ w, 0, 0 ], [ w, h, 0 ], [ - w, h, 0 ], [ 0, 0.6, 0.8 ], 0 );
	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( U, 2 ) );
	g.setAttribute( 'head', new THREE.Float32BufferAttribute( T, 1 ) );
	g.setIndex( I );
	return g;

}

function flowerMaterial( shared: Shared, map: THREE.Texture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.6 } );
	const head = attribute<'float'>( 'head', 'float' );
	const isStem = head.lessThan( 0.5 );
	// the stem samples the flower's eye (opaque) and is coloured green
	const tex = texture( map, select( isStem, vec2( 0.5 ), uv() ) );
	const petal = attribute<'vec3'>( 'flowerColor', 'vec3' );
	mat.colorNode = select( isStem, vec3( 0.05, 0.1, 0.02 ), tex.rgb.mul( petal ) );
	mat.opacityNode = tex.a;
	mat.alphaMap = map;
	const g = positionGeometry, p = positionLocal;
	const ph = dot( p.xz, vec2( 0.8, - 0.6 ) ).mul( 0.45 ).sub( shared.time.mul( 1.6 ) );
	const gust = sin( ph ).mul( 0.45 ).add( 0.55 );
	mat.positionNode = p.add( vec3( 0.8, 0, - 0.6 ).mul( gust.mul( 0.035 ).mul( g.y.mul( g.y ) ) ) );
	mat.normalNode = normalViewGeometry;
	return mat;

}

export function buildFlowers( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 31 );
	const palette = [
		[ 0.9, 0.88, 0.8 ], // white
		[ 0.92, 0.66, 0.12 ], // butter yellow
		[ 0.82, 0.38, 0.45 ], // pink
		[ 0.5, 0.38, 0.85 ], // lilac
	].map( ( [ r, g, b ] ) => new THREE.Color( r, g, b ) );

	const n = veg.length / STRIDE;
	const picks: number[] = [];
	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		if ( veg[ k + 7 ] > 0 ) continue; // not on the stacks
		const x = veg[ k ], z = veg[ k + 2 ];
		// drifts: dense where the drift noise peaks, a few strays elsewhere
		const drift = noise3( x * 0.28 + 11.0, 4.4, z * 0.28 ) * 0.5 + 0.5;
		const p = smoothstep( 0.6, 0.8, drift ) * 0.9 + 0.025;
		const count = rng() < p ? 1 + Math.floor( rng() * 3 ) : 0;
		for ( let c = 0; c < count; c ++ ) picks.push( k, rng() );

	}

	const count = picks.length / 2;
	const geo = blossomGeometry();
	const colors = new Float32Array( count * 3 );
	geo.setAttribute( 'flowerColor', new THREE.InstancedBufferAttribute( colors, 3 ) );
	const mesh = new THREE.InstancedMesh( geo, flowerMaterial( shared, petalTexture() ), count );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const up = new THREE.Vector3( 0, 1, 0 ), col = new THREE.Color();
	for ( let i = 0; i < picks.length / 2; i ++ ) {

		const k = picks[ i * 2 ];
		const x = veg[ k ] + ( rng() - 0.5 ) * 0.22, z = veg[ k + 2 ] + ( rng() - 0.5 ) * 0.22;
		// one colour per drift
		const hue = noise3( x * 0.11 + 2.0, 8.8, z * 0.11 ) * 0.5 + 0.5;
		const ci = Math.floor( ( ( hue * 3.7 ) % 1 ) * 4 );
		q.setFromAxisAngle( up, rng() * Math.PI * 2 );
		const h = 0.42 + rng() * 0.22, w = 0.3 + rng() * 0.12;
		pos.set( x, veg[ k + 1 ] - 0.02, z );
		scl.set( w, h, w );
		m.compose( pos, q, scl );
		mesh.setMatrixAt( i, m );
		col.copy( palette[ ci ] ).multiplyScalar( 0.85 + rng() * 0.3 );
		col.toArray( colors, i * 3 );

	}

	mesh.instanceMatrix.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.receiveShadow = true;
	mesh.name = 'flowers';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
