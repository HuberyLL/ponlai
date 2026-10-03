import * as THREE from 'three/webgpu';
import {
	attribute, uniform, positionLocal, normalViewGeometry, vec3, float, mix, dot, sin, pow, clamp, normalize,
	smoothstep as smoothstepN,
} from 'three/tsl';
import { mulberry32, noise3, smoothstep } from './noise.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import type { Shared } from '../shared.ts';

// Stylised meadow on the island top and the stack tops: instanced tufts, each a fan of tapered,
// bending blades. The shading is soft and painterly rather than per blade: the normal is the
// tuft's rounded envelope (every tuft reads as a little lit cushion with a shadow side), dark at
// the roots, sunlit at the tips, and the sun glows through the blades where the grass is backlit.
// A gentle wind sways the tips. Anchors come from the world worker (x, y, z, normal, rim distance,
// kind).

const STRIDE = 8;

function tuftGeometry( seed = 3, blades = 9, segs = 3 ) {

	const rng = mulberry32( seed );
	const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
	for ( let b = 0; b < blades; b ++ ) {

		const a = ( b / blades ) * Math.PI * 2 + ( rng() - 0.5 ) * 0.9;
		const r0 = 0.03 + rng() * 0.1; // base offset from the tuft's axis
		const ox = Math.cos( a ) * r0, oz = Math.sin( a ) * r0;
		const h = 0.6 + rng() * 0.4; // tuft space: 1 = the tallest blade
		const lean = 0.25 + rng() * 0.55; // how far the tip reaches out, relative to the height
		const w = 0.15 + rng() * 0.07; // width at the root
		const dx = Math.cos( a ), dz = Math.sin( a );
		const tw = a + Math.PI / 2 + ( rng() - 0.5 ) * 1.0; // width axis, a little twisted
		const wx = Math.cos( tw ), wz = Math.sin( tw );
		const base = P.length / 3;
		for ( let i = 0; i <= segs; i ++ ) {

			const t = i / segs;
			const reach = lean * h * t * t;
			const cx = ox + dx * reach, cz = oz + dz * reach;
			const cy = h * t * ( 1.0 - 0.3 * lean * t );
			const hw = w * 0.5 * Math.pow( 1 - t, 0.85 ) + 0.004;
			for ( const sg of [ - 1, 1 ] ) {

				const px = cx + wx * hw * sg, pz = cz + wz * hw * sg;
				P.push( px, cy, pz );
				const nx = px * 1.8, nz = pz * 1.8, l = Math.hypot( nx, 1, nz );
				N.push( nx / l, 1 / l, nz / l );
				T.push( t );

			}

		}

		for ( let i = 0; i < segs; i ++ ) {

			const k = base + i * 2;
			I.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}

	}

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.Float32BufferAttribute( P, 3 ) );
	g.setAttribute( 'normal', new THREE.Float32BufferAttribute( N, 3 ) );
	g.setAttribute( 'bladeT', new THREE.Float32BufferAttribute( T, 1 ) );
	g.setIndex( I );
	return g;

}

function grassMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.78, metalness: 0, side: THREE.DoubleSide } );
	const wind = uniform( new THREE.Vector2( 0.8, - 0.6 ) );
	const t = attribute<'float'>( 'bladeT', 'float' );
	const t2 = t.mul( t );
	// sway: gusts travel across the meadow, the tips move most (positionLocal is already placed
	// by the instance here, i.e. in world space)
	const p = positionLocal;
	const ph = dot( p.xz, wind ).mul( 0.45 ).sub( shared.time.mul( 1.6 ) );
	const gust = sin( ph ).mul( 0.45 ).add( 0.55 ).add( sin( ph.mul( 2.7 ).add( p.x.mul( 0.9 ) ) ).mul( 0.2 ) );
	mat.positionNode = p.add( vec3( normalize( wind ).x, 0, normalize( wind ).y ).mul( gust.mul( 0.05 ).mul( t2 ) ) ).sub( vec3( 0, gust.mul( 0.016 ).mul( t2 ), 0 ) );
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	mat.colorNode = mix( vec3( 0.15 ), vec3( 1 ), smoothstepN( 0.05, 0.95, t ) );
	// the tuft's envelope, the same from both sides
	mat.normalNode = normalViewGeometry;
	mat.aoNode = mix( float( 0.25 ), float( 1 ), t2 );
	// light through the blades: strongest when the grass stands against the sun
	useLighting( mat, () => new VegetationLighting( mix( float( 0.55 ), float( 1 ), t ), ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 3 ).mul( 0.9 ).add( 0.08 ).mul( t2 ) ) );
	mat.userData.wind = wind;
	return mat;

}

export function buildGrass( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const n = veg.length / STRIDE;
	const mesh = new THREE.InstancedMesh( tuftGeometry(), grassMaterial( shared ), n );
	const rng = mulberry32( 99 );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color(), tmp = new THREE.Color();
	const deep = new THREE.Color( 0.03, 0.06, 0.015 ), mid = new THREE.Color( 0.08, 0.13, 0.025 );
	const sunny = new THREE.Color( 0.19, 0.21, 0.04 ), straw = new THREE.Color( 0.26, 0.21, 0.08 );

	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		const rim = veg[ k + 6 ];
		// stand with the ground, leaning out a little more over the rim
		dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );

		// drifts of tall lush grass and of short sunny grass, shaggier along the rim
		const lush = noise3( x * 0.21, 0.5, z * 0.21 ) * 0.5 + 0.5;
		const fine = noise3( x * 0.85, 2.5, z * 0.85 ) * 0.5 + 0.5;
		const onStack = veg[ k + 7 ] > 0;
		const edge = onStack ? 0 : smoothstep( - 1.4, - 0.1, rim );
		let h = ( 0.2 + 0.24 * lush + 0.12 * fine ) * ( 0.75 + rng() * 0.5 ) * ( 1 + 0.45 * edge ) * ( onStack ? 0.55 : 1 );
		pos.set( x, y - 0.03, z );
		scl.set( h * ( 0.9 + rng() * 0.3 ), h, h * ( 0.9 + rng() * 0.3 ) );
		m.compose( pos, q, scl );
		mesh.setMatrixAt( i, m );

		// colour: deep green where it is lush, sunny yellow-green where short, the odd straw tuft
		const patch = noise3( x * 0.5 + 3.3, 1.5, z * 0.5 ) * 0.5 + 0.5;
		col.copy( mid ).lerp( deep, smoothstep( 0.4, 0.8, lush ) * 0.9 );
		col.lerp( tmp.copy( sunny ), Math.max( 0, smoothstep( 0.5, 0.15, lush ) * 0.8 + smoothstep( 0.6, 0.85, patch ) * 0.5 + ( rng() - 0.5 ) * 0.3 ) );
		if ( rng() < 0.05 + 0.08 * smoothstep( 0.4, 0.1, lush ) ) col.lerp( straw, 0.6 );
		col.multiplyScalar( 0.7 + rng() * 0.4 );
		mesh.setColorAt( i, col );

	}

	mesh.instanceMatrix.needsUpdate = true;
	mesh.instanceColor!.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = false;
	mesh.receiveShadow = true;
	mesh.name = 'grass';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
