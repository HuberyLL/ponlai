import * as THREE from 'three/webgpu';
import { attribute, positionLocal, float, vec3 } from 'three/tsl';
import { meadowColor } from '../materials/Meadow.ts';
import { LIP_INFO, LIP_POINTS, LIP_STEP, LIP_WALL } from './RimGround.ts';
import { cellStream } from './Anchors.ts';
import { backlight, vegetationMaterial } from './vegetation/Material.ts';
import { RIM_GRASS_WIND, hangingSway } from './vegetation/Deform.ts';
import { GRASS_BLADE, gravityNumber, strandShape } from './vegetation/Physics.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import { geometrySteps } from './Upload.ts';
import { boundsSteps, float32Steps, indexSteps, runSteps, Growing } from './Steps.ts';
import { noise3, smoothstep } from './noise.ts';
import type { Shared } from '../shared.ts';
import type { RimLipData } from './types.ts';

// The rim's hanging grass: grass growing from the lip, where the meadow meets the stone, and
// hanging over it as one fringe, so the meadow passes into the cliff as a sea cliff's top does.
// The blades grow in dense bundles along the lip, rooted on the meadow's ground across it (the
// worker's root span: RimGround.ts LIP_POINTS), mostly 0.15 - 0.5 m long (one bundle in twelve
// 0.55 - 0.8 m), a bundle's blades nearly parallel (one heading, root angle and stiffness, each
// blade a few degrees and a few per cent off them), and bend and hang under their own weight: each
// is an elastic strip clamped at its root, stiff at the root and soft at the tip, in the shape its
// weight bends it to (vegetation/Physics.ts), so a long one arcs out and hangs and a short one only
// bends, one smooth curve of 6, 8 or 10 segments by its length (HANG_SEGMENTS: a short blade bends
// little, so 6 show no corner close up). A blade lies on the wall below the lip (which the worker
// measures every 10 cm down under each sample: RimGround.ts LIP_WALL), along a smooth arc rather
// than through it. They are combed to one side by the prevailing wind, in stretches with clumps
// and thin places, drier and yellower than the meadow, and fewer where the turf thins at the rim
// (the lip's presence), as roots need soil. The blades are the meadow's (Grass.ts): sword-shaped, about as wide, and
// coloured from a deeper root to a lighter tip over the lawn's colour.
// The lip is traced along the coast inside each box (a chunk's) from the rim field
// (RimGround.buildRimLip), resampled between the points where the coast crosses the box's border,
// so the grass follows any shape the rim takes and meets itself across boxes. Each sample's blades
// draw from streams of its own place, so a piece builds alike whichever box traced it. One mesh, a
// draw, its material from the vegetation's factory (vegetation/Material.ts, family 'sod'); the
// blades swing as hanging strands (`hangingSway`, RIM_GRASS_WIND) and, a few millimetres wide, far
// under a shadow texel, cast nothing. A blade's shape is solved as the page builds the grass (a
// free blade read from Physics.ts's family of curves, one that meets the stone solved against it),
// in the growth's idle-time steps when the island grows.

// The meadow's blade colour from root to tip over the lawn's (Grass.ts ROOT and TIP: a deeper,
// cooler green at the root, a lighter, yellower one at the tip), so the rim's blades read as the
// same grass.
const ROOT = new THREE.Color( 0.42, 0.7, 0.56 ), TIP = new THREE.Color( 1.2, 1.17, 0.88 );
const gradient = ( color: THREE.Color, t: number, target: THREE.Color ) => target.copy( ROOT ).lerp( TIP, smoothstep( 0.12, 1, t ) ).multiply( color );
// The rim's grass is drier and yellower than the meadow's (thin soil, the sea wind): the hanging
// blades' tint over the lawn's colour, a yellow green for some, and straw (linear RGB).
const RIM_TINT = new THREE.Color( 1.06, 1.02, 0.84 ), DRY = new THREE.Color( 1.3, 1.1, 0.6 ), DEEP = new THREE.Color( 0.7, 0.86, 0.8 );
const STRAW: [ number, number, number ] = [ 0.105, 0.085, 0.034 ];
// The hanging grass: bundles per metre of coast where its density is full (up to two a sample,
// about 160 blades a metre), and a blade's segments, enough that its arc reads smooth close up:
// 6 under SHORT[ 0 ] (m), 8 under SHORT[ 1 ], 10 for a longer one.
const HANG_RATE = 24, HANG_SEGMENTS = [ 6, 8, 10 ], SHORT = [ 0.3, 0.6 ];
// How far a blade lying on the stone keeps off it (m), beyond the wall's own margin.
const LIE = 0.012;
// How far a hanging blade's halves turn their normals toward their edges (the meadow's fold).
const FOLD = 0.6;
// The wind's travel at rest (Wind.ts createWindUniforms: 40 degrees), which combs the rim's grass.
const PREVAILING = [ - Math.cos( 40 * Math.PI / 180 ), - Math.sin( 40 * Math.PI / 180 ) ];

/** The rim's hanging grass (the mesh, 'rimGrass'). */
export function buildRimGrass( lip: RimLipData, shared: Shared ): THREE.Mesh {

	const built = runSteps( rimGrassSteps( lip ) );
	const mesh = new THREE.Mesh( built.geometry, rimGrassMaterial( shared ) );
	mesh.name = 'rimGrass';
	mesh.receiveShadow = true;
	// Like the other vegetation: drawn before the terrain.
	mesh.renderOrder = - 1;
	mesh.userData = built.counts;
	return mesh;

}

/** The hanging grass's geometry and its counts (blades, triangles). */
export interface RimGrassBuilt { geometry: THREE.BufferGeometry; counts: { blades: number; triangles: number } }

/** The hanging grass as a vegetation kind (vegetation/Registry.ts): a grown island's is built in
 * steps, uploaded ahead, and swapped into the mesh. */
export function rimGrassKind( mesh: THREE.Mesh ): VegetationKind<RimGrassBuilt> {

	return {
		name: 'rimGrass', root: mesh, prepass: false, shadowFilter: 'ordinary', sunCaster: false, rainBake: true,
		growth: {
			*prepare( input ) {

				const grass = yield* rimGrassSteps( input.data.rimLip, 8 );
				yield* geometrySteps( input.renderer, grass.geometry );
				return grass;

			},
			swap( prepared ) {

				const old = mesh.geometry;
				mesh.geometry = prepared.geometry;
				mesh.userData = prepared.counts;
				return () => old.dispose();

			},
		},
	};

}

/** The hanging grass's geometry in steps (a generator, `per` samples a step), so the growth
 * (Growth.ts) builds a grown island's in idle time; `buildRimGrass` runs it to the end. The result
 * is the same however it is stepped. */
export function* rimGrassSteps( lip: RimLipData, per = Infinity ): Generator<void, RimGrassBuilt> {

	const GP = new Growing(), GC = new Growing(), GN = new Growing(), GH = new Growing(), GI = new Growing();
	const { points, info, pieces } = lip;
	const col = new THREE.Color(), shade = new THREE.Color();
	const base = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	const normal = new THREE.Vector3();
	const root = ( s: number, k: number, target: THREE.Vector3 ) => target.fromArray( points, ( s * LIP_POINTS + k ) * 3 );
	let blades = 0, done = 0;

	// A long blade growing out over the lip: it leaves its root at `angle` (rad above the
	// horizontal) along `plane` (horizontal) and takes the shape its weight bends it to
	// (Physics.ts `strandShape`; `stiffness` scales its rigidity), lying on `wall` where it meets
	// it: the least offset out of the coast (m, along `out`) at a depth under the roof, which a
	// blade rooted `rootOut` out and `rootDepth` down reads in its own plane. It is sword-shaped
	// like the meadow's (wide to two thirds of the way, then to a point; `width` is its whole width
	// at the root), its normal turning with its arc, and swings as a hanging strand
	// (`hangingSway`), by its length times the square of the way along it.
	const shapes = new Map<number, { phi: Float64Array; nodes: Float64Array }>();
	for ( const n of HANG_SEGMENTS ) shapes.set( n, { phi: new Float64Array( n ), nodes: new Float64Array( 2 * n + 2 ) } );
	const fold = new THREE.Vector3(), plane = new THREE.Vector3(), v = new THREE.Vector3();
	const hangBlade = ( at: THREE.Vector3, angle: number, length: number, stiffness: number, width: number, color: THREE.Color, phase: number,
		wall: ( depth: number ) => number, rootOut: number, rootDepth: number ) => {

		const across = plane.x * out.x + plane.z * out.z;
		const segments = length < SHORT[ 0 ] ? HANG_SEGMENTS[ 0 ] : length < SHORT[ 1 ] ? HANG_SEGMENTS[ 1 ] : HANG_SEGMENTS[ 2 ], { phi, nodes } = shapes.get( segments )!;
		strandShape( gravityNumber( GRASS_BLADE, length, stiffness ), angle, GRASS_BLADE.taper, phi, nodes,
			( y ) => ( wall( rootDepth - y * length ) - rootOut ) / across / length );
		// across the blade, along the coast as the triangles wind (the face the camera sees from the sea is the front)
		side.crossVectors( plane, up ).normalize();
		const first = GP.length / 3;
		for ( let i = 0; i <= segments; i ++ ) {

			const t = i / segments;
			v.copy( at ).addScaledVector( plane, nodes[ i * 2 ] * length ).addScaledVector( up, nodes[ i * 2 + 1 ] * length );
			// the face turns with the arc: up where the blade runs out, out where it hangs
			const a = i === 0 ? phi[ 0 ] : i === segments ? phi[ i - 1 ] : ( phi[ i - 1 ] + phi[ i ] ) * 0.5;
			dir.copy( plane ).multiplyScalar( Math.cos( a ) ).addScaledVector( up, Math.sin( a ) );
			normal.crossVectors( side, dir );
			// the root in the meadow's shade
			gradient( color, t, shade ).multiplyScalar( 0.84 + 0.16 * smoothstep( 0, 0.35, t ) );
			const half = width * 0.5 * Math.sqrt( Math.max( 1 - t * t, 0 ) );
			for ( const sg of i < segments ? [ - 1, 1 ] : [ 0 ] ) {

				GP.push( v.x + side.x * half * sg, v.y + side.y * half * sg, v.z + side.z * half * sg );
				GC.push( shade.r, shade.g, shade.b );
				// folded along its midrib like the meadow's, one half turned to each side
				fold.copy( normal ).addScaledVector( side, FOLD * sg ).normalize();
				GN.push( fold.x, fold.y, fold.z ); GH.push( out.x, out.z, phase, length * t * t );

			}

		}
		for ( let i = 0; i < segments - 1; i ++ ) {

			const k = first + i * 2;
			GI.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}
		const k = first + ( segments - 1 ) * 2;
		GI.push( k, k + 1, k + 2 );
		blades ++;

	};
	const inner = new THREE.Vector3(), outer = new THREE.Vector3(), out = new THREE.Vector3();
	const along = new THREE.Vector3(), bundle = new THREE.Vector3();
	// What the blades lie on: the wall's offsets at LIP_WALL's depths, linear between them and held
	// beyond them.
	let stoneAt = 0;
	const lieOn = ( depth: number ) => {

		if ( depth < 0 ) return - Infinity;
		const d = Math.min( Math.max( depth / LIP_WALL[ 0 ] - 1, 0 ), LIP_WALL.length - 1 );
		const k = Math.min( Math.floor( d ), LIP_WALL.length - 2 );
		return info[ stoneAt + k ] + ( info[ stoneAt + k + 1 ] - info[ stoneAt + k ] ) * ( d - k ) + LIE;

	};
	for ( let l = 0; l < pieces.length; l += 2 ) {

		// the blades of the samples that start a segment: a piece's last sample starts the next piece
		const first = pieces[ l ], count = pieces[ l + 1 ];
		for ( let s = first; s + 1 < first + count; s ++ ) {

			if ( ++ done % per === 0 ) yield;
			const [ x, z, nx, nz, presence, roof ] = info.subarray( s * LIP_INFO, s * LIP_INFO + 6 );
			along.set( - nz, 0, nx );
			out.set( nx, 0, nz );
			// Bundles of blades of mixed lengths, combed to one side, in stretches a few metres long
			// with clumps and thin places along them, fewer where the turf thins at the rim.
			const fringe = smoothstep( 0.3, 0.56, noise3( x * 0.83 + 4.1, 2.7, z * 0.83 - 0.6 ) * 0.5 + 0.5 );
			const clump = smoothstep( 0.3, 0.72, noise3( x * 3.3 - 1.7, 8.4, z * 3.3 + 2.9 ) * 0.5 + 0.5 );
			const density = ( 0.5 + 0.5 * fringe ) * ( 0.4 + 0.6 * presence ) * ( 0.4 + 0.6 * clump );
			const hang = cellStream( Math.round( x * 1000 ), Math.round( z * 1000 ), 5502 );
			const bundles = Math.floor( density * HANG_RATE * LIP_STEP + hang() );
			if ( bundles === 0 ) continue;
			stoneAt = s * LIP_INFO + 6;
			root( s, 0, inner ); root( s, 1, outer );
			// the ground's slope across the lip, which the blades leave a little below
			const slope = Math.atan2( outer.y - inner.y, ( outer.x - inner.x ) * nx + ( outer.z - inner.z ) * nz );
			// Their length: a field along the coast, each bundle its own share of it; mostly
			// 0.15 - 0.5 m, one bundle in twelve 0.55 - 0.8 m.
			const reach = noise3( x * 1.3 + 7.7, 1.9, z * 1.3 - 3.1 ) * 0.5 + 0.5;
			// combed along the coast by the prevailing wind
			const comb = Math.max( - 0.8, Math.min( 0.8, ( along.x * PREVAILING[ 0 ] + along.z * PREVAILING[ 1 ] ) * 0.7 + ( noise3( x * 0.6 - 2.2, 4.4, z * 0.6 + 5.3 ) ) * 0.5 ) );
			for ( let j = 0; j < bundles; j ++ ) {

				const length = hang() < 0.08 ? 0.55 + 0.25 * hang()
					: 0.15 + 0.35 * Math.min( 1, Math.max( 0, reach * 1.2 + hang() * 0.6 - 0.55 ) );
				// rooted just inside the lip, among the meadow's own tufts
				bundle.lerpVectors( inner, outer, hang() );
				const phase = hang() * Math.PI * 2;
				// A bundle's blades leave it close together and nearly parallel: one direction and
				// root angle (from a little above the ground's slope where they root, as the meadow's
				// blades rise, to 70 degrees below level where the ground falls away), each blade a
				// few degrees off it; their own weight bends them down over the edge.
				const heading = comb * 0.7 + ( hang() - 0.5 ) * 0.4, tilt = Math.max( - 1.2, Math.min( 0.25, slope + 0.1 ) ) + ( hang() - 0.5 ) * 0.3, stiff = Math.exp( ( hang() - 0.5 ) * 0.6 );
				const strands = 3 + Math.floor( hang() * 3 ) + Math.round( length * 3 );
				for ( let i = 0; i < strands; i ++ ) {

					base.copy( bundle ).addScaledVector( along, ( hang() - 0.5 ) * 0.14 ).addScaledVector( out, ( hang() - 0.5 ) * 0.03 );
					// each blade in its own vertical plane; its stiffness its own (0.64 - 1.57 of the material's)
					plane.copy( out ).addScaledVector( along, heading + ( hang() - 0.5 ) * 0.22 ).normalize();
					const angle = tilt + ( hang() - 0.5 ) * 0.14, stiffness = stiff * Math.exp( ( hang() - 0.5 ) * 0.3 );
					// The rim's grass is drier than the meadow's: about a fifth of the blades a yellow
					// green, a tenth straw, a fifth a deep green, the rest the lawn's green a little yellowed.
					const tint = hang();
					if ( tint < 0.1 ) col.setRGB( ...STRAW ).multiplyScalar( 0.75 + hang() * 0.25 );
					else meadowColor( base.x, base.z, col ).multiply( tint < 0.3 ? DRY : tint < 0.5 ? DEEP : RIM_TINT ).multiplyScalar( 0.74 + hang() * 0.22 );
					hangBlade( base, angle, length * ( 0.85 + 0.15 * Math.sqrt( hang() ) ), stiffness, 0.024 + hang() * 0.012, col, phase + i * 0.4,
						lieOn, ( base.x - x ) * nx + ( base.z - z ) * nz, roof - base.y );

				}

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( yield* float32Steps( GP ), 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( yield* float32Steps( GN ), 3 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( yield* float32Steps( GC ), 3 ) );
	geometry.setAttribute( 'rimHang', new THREE.BufferAttribute( yield* float32Steps( GH ), 4 ) );
	geometry.setIndex( yield* indexSteps( GI ) );
	yield* boundsSteps( geometry );
	geometry.boundingSphere!.radius += 0.12; // the sway in a gale
	return { geometry, counts: { blades, triangles: GI.length / 3 } };

}

function rimGrassMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const hang = attribute<'vec4'>( 'rimHang', 'vec4' );
	// The blades swing as hanging strands (`hangingSway`, RIM_GRASS_WIND), by their weight.
	let grassSway: THREE.Node<'vec2'> | undefined;
	return vegetationMaterial( shared, {
		family: 'sod', name: 'rimGrass', roughness: 0.93, vertexColors: true,
		wet: { tint: 0.9, roughness: 0.74 },
		rest: positionLocal,
		displacement: ( wind ) => {

			const hung = hangingSway( wind, { position: positionLocal, weight: hang.w, phase: hang.z, out: vec3( hang.x, 0, hang.y ), normal: vec3( 0, 1, 0 ), leafEdge: float( 0 ), leafPhase: float( 0 ) }, RIM_GRASS_WIND );
			if ( wind === shared.wind ) grassSway = hung.sway;
			return hung.position;

		},
		sway: () => grassSway,
		light: { scale: () => float( 1 ), extra: ( L, V ) => backlight( L, V, 4 ).mul( 0.4 ).add( 0.03 ) },
	} );

}
