import * as THREE from 'three/webgpu';
import {
	attribute, uniform, positionLocal, normalViewGeometry, vec3, float, mix, dot, sin, pow, clamp, normalize,
	smoothstep as smoothstepN,
} from 'three/tsl';
import { mulberry32, smoothstep } from './noise.ts';
import { sampleMeadow, meadowColor } from '../materials/Meadow.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import type { Shared } from '../shared.ts';

// Stylised meadow on the island top and the stack tops: instanced tufts, each a fan of tapered,
// bending blades. Most blades make a low, continuous bed; taller shoots grow in loose patches.
// Soft upward normals join the blades to that bed rather than lighting every tuft as a cushion.
// A gentle wind sways the tips. Anchors come from the world worker (x, y, z, normal, rim distance,
// kind).

const STRIDE = 8;

function tuftGeometry( seed = 3, blades = 8, segs = 3 ) {

	const rng = mulberry32( seed );
	const P: number[] = [], N: number[] = [], T: number[] = [], I: number[] = [];
	for ( let b = 0; b < blades; b ++ ) {

		const a = rng() * Math.PI * 2;
		const r0 = 0.03 + rng() * 0.1; // base offset from the tuft's axis
		const ox = Math.cos( a ) * r0, oz = Math.sin( a ) * r0;
		const h = 0.45 + rng() * 0.55; // varied blades keep the meadow from reading as a brush carpet
		const lean = 0.22 + rng() * 0.65;
		const w = 0.085 + rng() * 0.055;
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
				const nx = px * 2.2, nz = pz * 2.2, l = Math.hypot( nx, 0.9, nz );
				N.push( nx / l, 0.9 / l, nz / l );
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

	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.86, metalness: 0, side: THREE.DoubleSide } );
	const wind = uniform( new THREE.Vector2( 0.8, - 0.6 ) );
	const t = attribute<'float'>( 'bladeT', 'float' );
	const t2 = t.mul( t );
	// sway: gusts travel across the meadow, the tips move most (positionLocal is already placed
	// by the instance here, i.e. in world space)
	const p = positionLocal;
	const ph = dot( p.xz, wind ).mul( 0.45 ).sub( shared.time.mul( 1.6 ) );
	const gust = sin( ph ).mul( 0.45 ).add( 0.55 ).add( sin( ph.mul( 2.7 ).add( p.x.mul( 0.9 ) ) ).mul( 0.2 ) );
	// Short growth needs a smaller world-space sway to keep its tips above the soil.
	mat.positionNode = p.add( vec3( normalize( wind ).x, 0, normalize( wind ).y ).mul( gust.mul( 0.023 ).mul( t2 ) ) ).sub( vec3( 0, gust.mul( 0.007 ).mul( t2 ), 0 ) );
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	mat.colorNode = mix( vec3( 0.35, 0.43, 0.29 ), vec3( 1.04, 1, 0.86 ), smoothstepN( 0.02, 0.9, t ) );
	// the tuft's envelope, the same from both sides
	mat.normalNode = normalViewGeometry;
	mat.aoNode = mix( float( 0.55 ), float( 1 ), smoothstepN( 0.08, 0.85, t ) );
	// light through the blades: strongest when the grass stands against the sun
	useLighting( mat, () => new VegetationLighting( mix( float( 0.72 ), float( 1 ), t ), ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 ).mul( 0.42 ).add( 0.04 ).mul( t2 ) ) );
	mat.userData.wind = wind;
	return mat;

}

export function buildGrass( veg: Float32Array, shared: Shared ): THREE.InstancedMesh {

	const n = veg.length / STRIDE;
	const mesh = new THREE.InstancedMesh( tuftGeometry(), grassMaterial( shared ), n );
	const rng = mulberry32( 99 );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color();

	for ( let i = 0; i < n; i ++ ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		const rim = veg[ k + 6 ];
		// stand with the ground, leaning out a little more over the rim
		dir.set( veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ).lerp( up, 0.3 ).normalize();
		q.setFromUnitVectors( up, dir );
		qy.setFromAxisAngle( up, rng() * Math.PI * 2 );
		q.multiply( qy );

		// Keep the shared anchors: bushes and flowers use them too. Height, not a denser grid,
		// gives the meadow a close-cropped bed with irregular islands of longer growth.
		const { growth, variation } = sampleMeadow( x, z );
		const onStack = veg[ k + 7 ] > 0;
		const edge = smoothstep( - 1.1, - 0.05, rim );
		const tall = rng() < smoothstep( 0.38, 0.74, growth ) * 0.46;
		const h = ( 0.17 + 0.14 * growth + edge * growth * 0.07 + ( tall ? 0.16 + 0.1 * variation : 0 ) )
			* ( 0.78 + rng() * 0.44 ) * ( 1 + edge * ( variation - 0.5 ) * 0.35 ) * ( onStack ? 0.55 : 1 );
		pos.set( x, y - 0.018, z );
		const spread = ( tall ? 0.34 : 0.44 ) + growth * 0.08;
		scl.set( spread * ( 0.85 + rng() * 0.3 ), h, spread * ( 0.85 + rng() * 0.3 ) );
		m.compose( pos, q, scl );
		mesh.setMatrixAt( i, m );

		// The terrain samples the same colour field, so gaps read as short turf between shoots.
		meadowColor( x, z, col ).multiplyScalar( 0.93 + rng() * 0.14 );
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
