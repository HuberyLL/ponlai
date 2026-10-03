import * as THREE from 'three/webgpu';
import {
	positionGeometry, positionLocal, normalViewGeometry, vec3, float, mix, dot, sin, cos, pow, clamp,
	smoothstep as smoothstepN,
} from 'three/tsl';
import { mulberry32, noise3, smoothstep, type Rng } from './noise.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import type { Shared } from '../shared.ts';

interface Site { x: number; y: number; z: number; r: number; rim: number; nx: number; ny: number; nz: number }

// Leafy bushes on the turf: instanced clusters of alpha-tested leaf cards spread over a squashed
// ellipsoid. Every card takes the ellipsoid's normal rather than its own, so a bush shades as one
// soft, rounded mass (a lit side, a shadow side, a glowing rim against the sun) the way painted
// foliage does, while the leaf texture breaks its silhouette. Most bushes crowd the island's rim
// and spill over it; a few stand out on the grass and on the stack tops.

const STRIDE = 8;

export function leafTexture( size = 256 ): THREE.CanvasTexture {

	const c = document.createElement( 'canvas' );
	c.width = c.height = size;
	const g = c.getContext( '2d' )!;
	const rng = mulberry32( 11 );
	g.clearRect( 0, 0, size, size );
	for ( let i = 0; i < 30; i ++ ) {

		const a = rng() * Math.PI * 2;
		const r = Math.sqrt( rng() ) * size * 0.32;
		const x = size / 2 + Math.cos( a ) * r, y = size / 2 + Math.sin( a ) * r;
		const L = size * ( 0.13 + rng() * 0.1 ), W = L * ( 0.4 + rng() * 0.16 );
		g.save();
		g.translate( x, y );
		g.rotate( a + ( rng() - 0.5 ) * 1.6 );
		const shade = Math.floor( 190 + rng() * 65 );
		g.fillStyle = `rgb(${ shade },${ shade },${ shade })`;
		g.beginPath();
		g.moveTo( - L * 0.5, 0 );
		g.bezierCurveTo( - L * 0.2, - W, L * 0.25, - W * 0.9, L * 0.5, 0 );
		g.bezierCurveTo( L * 0.25, W * 0.9, - L * 0.2, W, - L * 0.5, 0 );
		g.fill();
		g.strokeStyle = `rgba(0,0,0,0.25)`;
		g.lineWidth = Math.max( 1, size / 160 );
		g.beginPath();
		g.moveTo( - L * 0.45, 0 );
		g.lineTo( L * 0.42, 0 );
		g.stroke();
		g.restore();

	}

	const tex = new THREE.CanvasTexture( c );
	tex.colorSpace = THREE.SRGBColorSpace;
	tex.generateMipmaps = true;
	tex.minFilter = THREE.LinearMipmapLinearFilter;
	tex.anisotropy = 4;
	return tex;

}

// unit bush: cards over an ellipsoid of radius 1 (0.72 tall), resting on y = 0
function bushGeometry( seed = 5, cards = 70 ) {

	const rng = mulberry32( seed );
	const P: number[] = [], N: number[] = [], U: number[] = [], I: number[] = [];
	const v = new THREE.Vector3(), t1 = new THREE.Vector3(), t2 = new THREE.Vector3(), n = new THREE.Vector3();
	const SY = 0.72;
	for ( let c = 0; c < cards; c ++ ) {

		// a point in the upper part of the ellipsoid, most near its surface
		const u = rng(), w = rng();
		const th = Math.acos( 1 - u * 1.65 ), ph = w * Math.PI * 2;
		const rr = 0.55 + 0.45 * Math.sqrt( rng() );
		v.set( Math.sin( th ) * Math.cos( ph ), Math.cos( th ), Math.sin( th ) * Math.sin( ph ) );
		n.set( v.x, v.y / SY, v.z ).normalize(); // envelope normal
		const cx = v.x * rr, cy = SY * ( 0.45 + v.y * rr * 0.75 ), cz = v.z * rr;
		// card plane: roughly facing out, tilted at random
		t1.set( rng() - 0.5, rng() - 0.5, rng() - 0.5 ).multiplyScalar( 1.1 ).add( v ).normalize();
		t2.set( 0, 1, 0 ).cross( t1 );
		if ( t2.lengthSq() < 1e-4 ) t2.set( 1, 0, 0 );
		t2.normalize();
		const t3 = new THREE.Vector3().crossVectors( t1, t2 ).normalize();
		const rot = rng() * Math.PI * 2, cs = Math.cos( rot ), sn = Math.sin( rot );
		const a = t2.clone().multiplyScalar( cs ).addScaledVector( t3, sn );
		const b = t2.clone().multiplyScalar( - sn ).addScaledVector( t3, cs );
		const s = 0.36 + rng() * 0.2;
		const base = P.length / 3;
		for ( const [ du, dv ] of [ [ - 1, - 1 ], [ 1, - 1 ], [ 1, 1 ], [ - 1, 1 ] ] ) {

			P.push( cx + ( a.x * du + b.x * dv ) * s, cy + ( a.y * du + b.y * dv ) * s, cz + ( a.z * du + b.z * dv ) * s );
			N.push( n.x, n.y, n.z );
			U.push( du * 0.5 + 0.5, dv * 0.5 + 0.5 );

		}

		I.push( base, base + 1, base + 2, base, base + 2, base + 3 );

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'uv', new THREE.Float32BufferAttribute( U, 2 ) );
	g.setIndex( I );
	return g;

}

function foliageMaterial( shared: Shared, map: THREE.Texture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( {
		map, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.7, metalness: 0,
	} );
	mat.alphaMap = map; // (the shadow pass keeps the alpha map, not the colour map: leaf-shaped shadows)
	const g = positionGeometry; // the unit bush, before the instance places it
	const vH = clamp( g.y.div( 0.72 ), 0, 1 );
	const p = positionLocal; // placed: world space
	const ph = p.x.mul( 0.4 ).add( p.z.mul( 0.3 ) ).sub( shared.time.mul( 1.3 ) );
	mat.positionNode = p.add( vec3( sin( ph.add( g.y.mul( 3 ) ) ), 0, cos( ph.mul( 1.3 ).add( g.x.mul( 3 ) ) ) ).mul( vH.mul( 0.02 ) ) );
	// one soft, rounded mass: every card shades with the bush's envelope normal
	mat.normalNode = normalViewGeometry;
	// deep inside and underneath a bush the light is gone
	mat.aoNode = mix( float( 0.45 ), float( 1 ), smoothstepN( 0, 0.8, vH ) );
	useLighting( mat, () => new VegetationLighting( mix( float( 0.7 ), float( 1 ), smoothstepN( 0, 0.6, vH ) ), ( L, V, N ) => {

		// wrapped light (leaves scatter light round to the shadow side) + glow against the sun
		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const rim = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.22 ).add( back.mul( rim.mul( rim ).mul( 1.4 ).add( 0.25 ) ) );

	} ) );
	return mat;

}

// pick bush sites among the turf anchors: crowded along the rim, scattered inland
function pickSites( veg: Float32Array, rng: Rng ): Site[] {

	const n = veg.length / STRIDE;
	const order = Array.from( { length: n }, ( _, i ) => i );
	for ( let i = n - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ order[ i ], order[ j ] ] = [ order[ j ], order[ i ] ];

	}

	const sites: Site[] = [];
	for ( const i of order ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ], rim = veg[ k + 6 ];
		const onStack = veg[ k + 7 ] > 0;
		const nearRim = smoothstep( - 2.2, - 0.6, rim );
		const clump = noise3( x * 0.3, 7.7, z * 0.3 ) * 0.5 + 0.5;
		const p = onStack ? 0.08 : nearRim * 0.3 * smoothstep( 0.3, 0.7, clump ) + 0.015 * smoothstep( 0.6, 0.85, clump );
		if ( rng() > p ) continue;
		const r = onStack ? 0.35 + rng() * 0.25 : ( 0.35 + Math.pow( rng(), 1.5 ) * 0.75 ) * ( 0.8 + 0.5 * nearRim );
		if ( sites.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.75 ) ) continue;
		sites.push( { x, y, z, r, rim, nx: veg[ k + 3 ], ny: veg[ k + 4 ], nz: veg[ k + 5 ] } );

	}

	return sites;

}

export function buildFoliage( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 7 );
	const sites = pickSites( veg, rng );
	const map = leafTexture();
	const geo = bushGeometry();
	const mat = foliageMaterial( shared, map );
	const mesh = new THREE.InstancedMesh( geo, mat, sites.length );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color();
	const greens = [ [ 0.07, 0.13, 0.025 ], [ 0.11, 0.17, 0.03 ], [ 0.17, 0.2, 0.04 ], [ 0.05, 0.11, 0.045 ], [ 0.21, 0.21, 0.05 ] ].map( ( [ r, gr, b ] ) => new THREE.Color( r, gr, b ) );

	sites.forEach( ( s, i ) => {

		// lean with the ground: bushes on the rim tip out over the edge
		dir.set( s.nx, s.ny, s.nz ).lerp( up, 0.4 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );
		pos.set( s.x, s.y - 0.08 * s.r, s.z );
		scl.set( s.r * ( 0.9 + rng() * 0.25 ), s.r * ( 0.8 + rng() * 0.45 ), s.r * ( 0.9 + rng() * 0.25 ) );
		m.compose( pos, q, scl );
		mesh.setMatrixAt( i, m );
		col.copy( greens[ Math.floor( rng() * greens.length ) ] ).multiplyScalar( 0.85 + rng() * 0.35 );
		mesh.setColorAt( i, col );

	} );

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'foliage';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
