import * as THREE from 'three/webgpu';
import {
	attribute, positionLocal, normalViewGeometry, vec3, float, mix, max, dot, pow, clamp,
	smoothstep as smoothstepN,
} from 'three/tsl';
import { sampleRimGround, rimGrassCover } from './RimGround.ts';
import type { RimGroundField } from './types.ts';
import { mulberry32, smoothstep } from './noise.ts';
import { sampleMeadow, meadowColor, supportsMeadow } from '../materials/Meadow.ts';
import { sampleMeadowSoil, soilUniforms } from '../materials/Soil.ts';
import { VegetationLighting, useLighting } from './VegetationLighting.ts';
import { useRestPoseShadows } from './VegetationShadow.ts';
import { windGust } from '../weather/Wind.ts';
import { CANOPY_TOP, meadowCanopyLight } from '../lighting/MeadowCanopy.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import type { Shared } from '../shared.ts';

// Stylised meadow on the island top: instanced tufts, each a fan of tapered,
// bending blades. Most blades make a low, continuous bed; taller shoots grow in loose patches.
// Soft upward normals join the blades to that bed rather than lighting every tuft as a cushion.
// A gentle wind sways the tips. Anchors come from the world worker (x, y, z, normal, rim distance,
// kind and local sky visibility).

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
	const wind = shared.wind.direction;
	const t = attribute<'float'>( 'bladeT', 'float' );
	const t2 = t.mul( t );
	// sway: gusts travel across the meadow, the tips move most (positionLocal is already placed
	// by the instance here, i.e. in world space)
	const p = positionLocal;
	const soil = attribute<'float'>( 'soilCover', 'float' ).mul( soilUniforms.blend ).mul( soilUniforms.strength );
	const tuft = attribute<'vec4'>( 'tuftOrigin', 'vec4' );
	const origin = tuft.xyz;
	// Keep every planting anchor. Narrower, slightly shorter shoots reveal the same soil
	// pockets as the ground material, and a zero blend restores their original footprint.
	const rooted = p.sub( p.sub( origin ).mul( vec3( 0.22, 0.06, 0.22 ) ).mul( soil ) );
	const gust = windGust( p.xz, wind, shared.wind.phase ).mul( shared.wind.strength );
	// Short growth needs a smaller world-space sway to keep its tips above the soil.
	const rest = useRestPoseShadows( mat, rooted, rooted.add( vec3( wind.x, 0, wind.y ).mul( gust.mul( 0.023 ).mul( t2 ) ) ).sub( vec3( 0, gust.mul( 0.007 ).mul( t2 ), 0 ) ) );
	// dark, shaded roots to the tuft's own colour at the tips (the instance colour multiplies in)
	const cover = attribute<'float'>( 'rimCover', 'float' );
	// Meadow gaps and the rim share one root tint instead of colouring the same blade twice.
	const rootSoil = max( soil.mul( 0.7 ), float( 1 ).sub( cover ).mul( 0.55 ).mul( soilUniforms.strength ) );
	const root = mix( vec3( 0.35, 0.43, 0.29 ), vec3( 0.55, 0.38, 0.23 ), rootSoil );
	const wetness = clamp( shared.wetness, 0, 1 );
	mat.colorNode = mix( root, vec3( 1.04, 1, 0.86 ), smoothstepN( 0.02, 0.9, t ) ).mul( mix( 1, 0.92, wetness ) );
	mat.roughnessNode = mix( 0.86, 0.76, wetness );
	// the tuft's envelope, the same from both sides
	mat.normalNode = normalViewGeometry;
	// The static visibility affects indirect illumination only; sunlight keeps its own shadows.
	mat.aoNode = mix( float( 0.55 ), float( 1 ), smoothstepN( 0.08, 0.85, t ) ).mul( attribute<'float'>( 'skyVisibility', 'float' ) );
	// light through the blades: strongest when the grass stands against the sun
	// Blades do not cast into the sun's shadow map; see MeadowCanopy.
	const canopy = meadowCanopyLight( rest.xz, tuft.w.sub( rest.y.sub( origin.y ) ), shared.sunDir );
	useLighting( mat, () => new VegetationLighting( mix( float( 0.72 ), float( 1 ), t ).mul( canopy ), ( L, V ) =>
		pow( clamp( dot( V.negate(), L ), 0, 1 ), 4 ).mul( 0.42 ).add( 0.04 ).mul( t2 ) ) );
	mat.userData.wind = wind;
	return mat;

}

export function buildGrass( veg: Float32Array, shared: Shared, rimGround?: RimGroundField ): THREE.InstancedMesh {

	const n = veg.length / STRIDE;
	const mesh = new THREE.InstancedMesh( tuftGeometry(), grassMaterial( shared ), n );
	// Share one input buffer for the three scalar fields. Separate buffers plus the existing
	// tuft inputs and instance transform would exceed WebGPU's default eight-buffer limit.
	const ground = new THREE.InstancedInterleavedBuffer( new Float32Array( n * 3 ), 3 );
	const visibility = new THREE.InterleavedBufferAttribute( ground, 1, 0 );
	const soilCover = new THREE.InterleavedBufferAttribute( ground, 1, 1 );
	const covers = new THREE.InterleavedBufferAttribute( ground, 1, 2 );
	mesh.geometry.setAttribute( 'skyVisibility', visibility );
	mesh.geometry.setAttribute( 'soilCover', soilCover );
	mesh.geometry.setAttribute( 'rimCover', covers );
	// xyz: planting anchor; w: local canopy top above it, for the light through the blades
	const tuftOrigin = new Float32Array( n * 4 );
	const rng = mulberry32( 99 );
	const m = new THREE.Matrix4(), q = new THREE.Quaternion(), qy = new THREE.Quaternion();
	const up = new THREE.Vector3( 0, 1, 0 ), dir = new THREE.Vector3(), pos = new THREE.Vector3(), scl = new THREE.Vector3();
	const col = new THREE.Color();

	let count = 0;
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

		// The terrain samples the same colour field, so gaps read as short turf between shoots.
		meadowColor( x, z, col ).multiplyScalar( 0.93 + rng() * 0.14 );
		// Consume the original random draws before filtering so inland tufts stay identical.
		if ( ! supportsMeadow( y, veg[ k + 4 ] ) ) continue;
		// All attributes follow the compacted instance order, including the original sky bake.
		visibility.setX( count, veg[ k + 8 ] );
		soilCover.setX( count, onStack ? 0 : sampleMeadowSoil( x, z ) );
		tuftOrigin[ count * 4 ] = pos.x;
		tuftOrigin[ count * 4 + 1 ] = pos.y;
		tuftOrigin[ count * 4 + 2 ] = pos.z;
		const cover = rimGround ? rimGrassCover( sampleRimGround( rimGround, x, z ) ) : 1;
		covers.setX( count, cover );
		if ( cover < 1 ) {

			// Keep the planted origins and all RNG draws. A thin edge tuft reveals the same
			// soil pocket as the ground without changing the inland meadow arrangement.
			scl.multiply( new THREE.Vector3( 0.35 + cover * 0.65, 0.45 + cover * 0.55, 0.35 + cover * 0.65 ) );
			m.compose( pos, q, scl );

		}
		tuftOrigin[ count * 4 + 3 ] = scl.y * CANOPY_TOP;
		mesh.setMatrixAt( count, m );
		mesh.setColorAt( count ++, col );

	}

	ground.needsUpdate = true;
	mesh.geometry.setAttribute( 'tuftOrigin', new THREE.InstancedBufferAttribute( tuftOrigin, 4 ) );
	mesh.count = count;
	mesh.instanceMatrix.needsUpdate = true;
	mesh.instanceColor!.needsUpdate = true;
	mesh.frustumCulled = false;
	mesh.castShadow = false; // see MeadowCanopy
	mesh.receiveShadow = true;
	mesh.name = 'grass';
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
