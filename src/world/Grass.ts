import * as THREE from 'three/webgpu';
import {
	Fn, attribute, positionLocal, normalViewGeometry, vec2, vec3, vec4, float, mix, max, dot, pow, clamp, fract, sin, select,
	length, cameraPosition, cameraViewMatrix, cameraProjectionMatrix, screenSize, varyingProperty, uniform,
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
import { puddleCover } from '../weather/Puddles.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import type { Shared } from '../shared.ts';

// Stylised meadow on the island top: instanced tufts, each a fan of tapered,
// bending blades. Most blades make a low, continuous bed; taller shoots grow in loose patches.
// Soft upward normals join the blades to that bed rather than lighting every tuft as a cushion.
// A gentle wind sways the tips. Anchors come from the world worker (x, y, z, normal, rim distance,
// kind and local sky visibility).

function tuftGeometry( seed = 3, blades = 8, segs = 3 ) {

	const rng = mulberry32( seed );
	// T: blade parameter along its length, then the half-width offset from the centreline (x, z)
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
				T.push( t, wx * hw * sg, wz * hw * sg );

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
	g.setAttribute( 'blade', new THREE.Float32BufferAttribute( T, 3 ) );
	g.setIndex( I );
	return g;

}

// Thin blades alias. Their tips are a few millimetres wide, a fraction of a pixel from the
// overview, so 4x MSAA catches them on some frames and misses them on others and the meadow
// crawls as the camera moves. Each blade is kept at least `minWidth` pixels wide on screen,
// widened across the view, and its coverage is lowered by the same factor through alpha to
// coverage, so it hides as much of the ground as the thin blade did at every distance. This is
// the treatment of thin wires after Emil Persson ("Phone-wire AA", Humus, 2012). Two pixels
// brought a slow orbit's meadow flicker most of the way to a supersampled render's; narrower
// widths left more of it, wider ones soften the blades further for little gain.
const grassUniforms = {
	minWidth: uniform( 2 ), // render-target pixels
	rimMinWidth: uniform( 0.75 ), // on the outer rim, see `rimEdge` in buildGrass
};
// Beyond this the blade is seen nearly edge on; widening further would only smear it.
const MAX_WIDEN = 8;
const bladeCoverage = varyingProperty( 'float', 'vGrassBladeCoverage' );

type V3 = THREE.Node<'vec3'>;
type F = THREE.Node<'float'>;

// Returns the widened vertex and passes its coverage to the fragment stage. Positions are world
// positions: the meadow mesh stays at the origin, untransformed.
function pixelWideBlade( position: V3, halfWidth: V3, minWidth: F ): V3 {

	return Fn( () => {

		const p = position.toVar();
		const toCamera = cameraPosition.sub( p ).toVar();
		const view = toCamera.div( max( length( toCamera ), 1e-4 ) ).toVar();
		// The half width as the view sees it: the part along the line of sight does not show.
		const seen = halfWidth.sub( view.mul( dot( halfWidth, view ) ) ).toVar();
		// Metres per pixel at this depth; ( 1, 1 ) of the projection is 1 / tan( fov / 2 ).
		const depth = max( cameraViewMatrix.mul( vec4( p, 1 ) ).z.negate(), 1e-3 );
		const p11 = ( cameraProjectionMatrix as unknown as { element( i: number ): { element( i: number ): F } } ).element( 1 ).element( 1 );
		const pixel = depth.mul( 2 ).div( p11.mul( screenSize.y ) );
		const widen = clamp( minWidth.mul( 0.5 ).mul( pixel ).div( max( length( seen ), 1e-6 ) ), 1, MAX_WIDEN ).toVar();
		bladeCoverage.assign( widen.reciprocal() );
		return p.add( seen.mul( widen.sub( 1 ) ) );

	} )() as V3;

}

function grassMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	// Alpha to coverage carries the widened blades' coverage (see `pixelWideBlade`); a blade at
	// least `minWidth` wide keeps full coverage and renders as before.
	const mat = new THREE.MeshStandardNodeMaterial( { roughness: 0.86, metalness: 0, side: THREE.DoubleSide, alphaToCoverage: true } );
	mat.opacityNode = bladeCoverage;
	const wind = shared.wind.direction;
	const blade = attribute<'vec3'>( 'blade', 'vec3' );
	const t = blade.x;
	const t2 = t.mul( t );
	// sway: gusts travel across the meadow, the tips move most (positionLocal is already placed
	// by the instance here, i.e. in world space)
	const p = positionLocal;
	const soil = attribute<'float'>( 'soilCover', 'float' ).mul( soilUniforms.blend ).mul( soilUniforms.strength );
	const tuft = attribute<'vec4'>( 'tuftOrigin', 'vec4' );
	const origin = tuft.xyz;
	// Keep every planting anchor. Narrower, slightly shorter shoots reveal the same soil
	// pockets as the ground material, and a zero blend restores their original footprint.
	// Standing water drowns the blades: the tufts sink below the waterline (the ground, which
	// carries the water's surface, hides them). About a third keep a few centimetres of their
	// tips above it, so sparse drowned spikes stand in an open sheet of water rather than a
	// meadow that hides it. Which tufts and how much is a hash of the planting anchor, fixed.
	const pool = puddleCover( origin.xz, shared.wetness );
	const drowned = float( 1 ).sub( pool.mul( 0.15 ) );
	const pick = fract( sin( dot( origin.xz, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
	const tip = select( pick.greaterThan( 0.66 ), pick.sub( 0.66 ).mul( 0.25 ).add( 0.03 ), float( - 0.03 ) );
	// The tallest blade of a tuft reaches about 0.9 of its height ( tuft.w / CANOPY_TOP ).
	const sink = max( tuft.w.div( CANOPY_TOP ).mul( drowned ).mul( 0.9 ).sub( tip ), 0 );
	const rooted = p.sub( p.sub( origin ).mul( vec3( 0.22, 0.06, 0.22 ) ).mul( soil ) ).sub( origin ).mul( drowned ).add( origin )
		.sub( vec3( 0, pool.mul( sink ), 0 ) );
	const gust = windGust( p.xz, wind, shared.wind.phase ).mul( shared.wind.strength );
	// Short growth needs a smaller world-space sway to keep its tips above the soil.
	const swayed = rooted.add( vec3( wind.x, 0, wind.y ).mul( gust.mul( 0.023 ).mul( t2 ) ) ).sub( vec3( 0, gust.mul( 0.007 ).mul( t2 ), 0 ) );
	// The blade's half width at this vertex in world space: its local offset from the centreline
	// through the instance's own axes, then the same soil and drowning scale as `rooted` (an
	// affine map of the position, so it scales offsets alike; the gust barely varies across a blade).
	const across = attribute<'vec3'>( 'widthX', 'vec3' ).mul( blade.y ).add( attribute<'vec3'>( 'widthZ', 'vec3' ).mul( blade.z ) )
		.mul( vec3( float( 1 ).sub( soil.mul( 0.22 ) ), float( 1 ).sub( soil.mul( 0.06 ) ), float( 1 ).sub( soil.mul( 0.22 ) ) ) ).mul( drowned );
	const minWidth = mix( grassUniforms.minWidth, grassUniforms.rimMinWidth, attribute<'float'>( 'rimEdge', 'float' ) );
	const rest = useRestPoseShadows( mat, rooted, pixelWideBlade( swayed, across, minWidth ) );
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
	// Share one input buffer for the three scalar fields and the width axes. Separate buffers plus
	// the existing tuft inputs and instance transform would exceed WebGPU's default eight-buffer limit.
	const ground = new THREE.InstancedInterleavedBuffer( new Float32Array( n * 10 ), 10 );
	const visibility = new THREE.InterleavedBufferAttribute( ground, 1, 0 );
	const soilCover = new THREE.InterleavedBufferAttribute( ground, 1, 1 );
	const covers = new THREE.InterleavedBufferAttribute( ground, 1, 2 );
	mesh.geometry.setAttribute( 'skyVisibility', visibility );
	mesh.geometry.setAttribute( 'soilCover', soilCover );
	mesh.geometry.setAttribute( 'rimCover', covers );
	// The instance transform's local x and z axes: a blade's width lies in that plane, and the
	// vertex stage needs it in world space to keep thin blades a minimum width on screen (the
	// instance matrix itself is not exposed to the material).
	const widthX = new THREE.InterleavedBufferAttribute( ground, 3, 3 );
	const widthZ = new THREE.InterleavedBufferAttribute( ground, 3, 6 );
	mesh.geometry.setAttribute( 'widthX', widthX );
	mesh.geometry.setAttribute( 'widthZ', widthZ );
	// 1 on the plateau's outer rim, where blades stand against the sea. The opaque pass's MSAA
	// edge pixels there resolve against the sky-coloured clear behind the island (the sea is drawn
	// in a later, single-sampled pass), so every partly covered pixel a widened blade adds shows
	// as a pale fringe over the sea; the rim keeps blades narrower.
	const rimEdge = new THREE.InterleavedBufferAttribute( ground, 1, 9 );
	mesh.geometry.setAttribute( 'rimEdge', rimEdge );
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
		const e = m.elements;
		widthX.setXYZ( count, e[ 0 ], e[ 1 ], e[ 2 ] );
		widthZ.setXYZ( count, e[ 8 ], e[ 9 ], e[ 10 ] );
		rimEdge.setX( count, smoothstep( - 1.5, - 0.3, rim ) );
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
	// for probes and tuning from the console ( __SOOMI__.grass )
	mesh.userData.minWidth = grassUniforms.minWidth;
	mesh.userData.rimMinWidth = grassUniforms.rimMinWidth;
	mesh.renderOrder = - 1; // before the terrain: the turf it covers then fails the depth test
	return mesh;

}
