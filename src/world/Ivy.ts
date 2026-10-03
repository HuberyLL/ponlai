import * as THREE from 'three/webgpu';
import { positionGeometry, positionLocal, normalViewGeometry, vec3, float, dot, sin, cos, pow, clamp } from 'three/tsl';
import { mulberry32 } from './noise.ts';
import { leafTexture } from './Foliage.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import type { Shared } from '../shared.ts';

// Ivy hanging from the island's rim: leaf cards strung down the strands the world worker traced
// over the rock faces (x, y, z, outward x, outward z, t along the strand). The cards face out from
// the rock, tipped down the way hanging leaves hang; they shade with the strand's outward normal
// (soft, no per-card facets), glow when backlit, and stir a little in the wind.

const STRIDE = 6;

function ivyMaterial( shared: Shared, map: THREE.Texture ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { map, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, roughness: 0.7 } );
	mat.alphaMap = map;
	const g = positionGeometry, p = positionLocal;
	const ph = p.x.mul( 1.7 ).add( p.y.mul( 2.3 ) ).sub( shared.time.mul( 1.4 ) );
	mat.positionNode = p.add( vec3( sin( ph ), 0, cos( ph.mul( 1.3 ) ) ).mul( g.y.add( 0.5 ).mul( 0.025 ) ) );
	mat.normalNode = normalViewGeometry;
	useLighting( mat, () => new VegetationLighting( float( 1 ), ( L, V, N ) => {

		const back = pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 );
		const wrap = clamp( dot( N, L ).mul( 0.5 ).add( 0.5 ), 0, 1 );
		return wrap.mul( wrap ).mul( 0.2 ).add( back.mul( 0.5 ) );

	} ) );
	return mat;

}

export function buildIvy( pts: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const rng = mulberry32( 57 );
	const n = pts.length / STRIDE;
	const cards: number[] = [];
	for ( let i = 0; i < n; i ++ ) cards.push( i, 2 + ( rng() < 0.4 ? 1 : 0 ) );
	let total = 0;
	for ( let i = 0; i < cards.length; i += 2 ) total += cards[ i + 1 ];

	const geo = new THREE.PlaneGeometry( 1, 1 );
	const mesh = new THREE.InstancedMesh( geo, ivyMaterial( shared, leafTexture() ), total );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qz = new THREE.Quaternion();
	const pos = new THREE.Vector3(), scl = new THREE.Vector3(), out = new THREE.Vector3();
	const zAxis = new THREE.Vector3( 0, 0, 1 ), col = new THREE.Color();
	const dark = new THREE.Color( 0.06, 0.12, 0.03 ), mid = new THREE.Color( 0.13, 0.2, 0.035 ), lit = new THREE.Color( 0.25, 0.27, 0.06 );
	let j = 0;
	for ( let c = 0; c < cards.length; c += 2 ) {

		const k = cards[ c ] * STRIDE;
		const ox = pts[ k + 3 ], oz = pts[ k + 4 ], t = pts[ k + 5 ];
		for ( let r = 0; r < cards[ c + 1 ]; r ++ ) {

			// face out from the rock, tipped down, turned at random in its own plane
			out.set( ox, - 0.35 - rng() * 0.3, oz ).normalize();
			q.setFromUnitVectors( zAxis, out );
			qz.setFromAxisAngle( zAxis, rng() * Math.PI * 2 );
			q.multiply( qz );
			const tx = - oz, tz = ox, jit = ( rng() - 0.5 ) * 0.3, off = 0.06 + rng() * 0.1;
			pos.set( pts[ k ] + tx * jit + ox * off, pts[ k + 1 ] + ( rng() - 0.5 ) * 0.12, pts[ k + 2 ] + tz * jit + oz * off );
			const s = ( 0.34 + rng() * 0.16 ) * ( 1 - 0.3 * t );
			scl.set( s, s, s );
			m.compose( pos, q, scl );
			mesh.setMatrixAt( j, m );
			col.copy( mid ).lerp( rng() < 0.5 ? dark : lit, rng() * 0.8 ).multiplyScalar( 1 - 0.2 * t );
			mesh.setColorAt( j, col );
			j ++;

		}

	}

	mesh.instanceMatrix.needsUpdate = true;
	if ( mesh.instanceColor ) mesh.instanceColor.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.name = 'ivy';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
