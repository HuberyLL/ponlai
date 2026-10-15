import * as THREE from 'three/webgpu';
import { attribute, positionLocal, float, vec3, mix, step } from 'three/tsl';
import { meadowColor } from '../materials/Meadow.ts';
import { SOIL_PALETTE } from '../materials/Soil.ts';
import { SKIRT_INFO, SKIRT_RING, SKIRT_STEP, SKIRT_WALL } from './RimGround.ts';
import { cellStream } from './Anchors.ts';
import { backlight, vegetationMaterial } from './vegetation/Material.ts';
import { SKIRT_WIND, hangingSway, skirtLean } from './vegetation/Deform.ts';
import type { VegetationKind } from './vegetation/Registry.ts';
import { geometrySteps } from './Upload.ts';
import { boundsSteps, float32Steps, indexSteps, runSteps, Growing } from './Steps.ts';
import { noise3, smoothstep } from './noise.ts';
import type { Shared } from '../shared.ts';
import type { RimSkirtData } from './types.ts';

// The turf skirt: the meadow's sod curling a little over the rim, with a thatch of short blades
// gathered in tufts on its shoulder and face, a few root hairs along its ragged lower edge, and
// grass hanging from the lip, so the meadow passes into the cliff as a sea cliff's top does: the
// turf overhangs, and bundles of blades of mixed lengths (0.2 - 1 m) hang from it, combed to one
// side by the prevailing wind, in stretches with clumps and thin places, drier and yellower than
// the meadow, and fewer from the bare rim where no sod curls over. The blades are the meadow's
// (Grass.ts): sword-shaped, about as wide, and coloured from a deeper root to a lighter tip over
// the lawn's colour. A hanging blade keeps outside the wall below the lip, which the worker
// measures under each sample (RimGround.ts SKIRT_WALL), so it lies on a battered wall's stone.
// It is swept along the coast traced inside each box (a chunk's) from the
// rim field (RimGround.buildRimSkirt), resampled between the points where the coast crosses the
// box's border, so it follows any shape the rim takes and meets itself across boxes. Each
// sample's blades draw from streams of its own place, and the body's normals come with the rings,
// so a piece builds alike whichever box traced it and neighbouring pieces meet without a seam. One
// mesh, one draw; it bends with the plants' wind field (Wind.ts): the thatch leans (`skirtLean`),
// the hanging grass swings (`hangingSway`), their numbers SKIRT_WIND. Its material comes from the
// vegetation's factory (vegetation/Material.ts, family 'sod'). Only the sod casts into the sun's map.

const SHADE = [ 0.86, 0.94, 1, 0.9, 0.7, 0.52, 0.4 ];
// The meadow's blade colour from root to tip over the lawn's (Grass.ts ROOT and TIP: a deeper,
// cooler green at the root, a lighter, yellower one at the tip), so the skirt's blades read as the
// same grass.
const ROOT = new THREE.Color( 0.42, 0.7, 0.56 ), TIP = new THREE.Color( 1.2, 1.17, 0.88 );
const gradient = ( color: THREE.Color, t: number, target: THREE.Color ) => target.copy( ROOT ).lerp( TIP, smoothstep( 0.12, 1, t ) ).multiply( color );
// The rim's grass is drier and yellower than the meadow's (thin soil, the sea wind): the hanging
// blades' tint over the lawn's colour, a yellow green for some, and straw (linear RGB).
const RIM_TINT = new THREE.Color( 1.06, 1.02, 0.84 ), DRY = new THREE.Color( 1.3, 1.1, 0.6 ), DEEP = new THREE.Color( 0.7, 0.86, 0.8 );
const STRAW: [ number, number, number ] = [ 0.105, 0.085, 0.034 ];
// The hanging grass: bundles per metre of coast where its density is full (about 40 blades a
// metre), and a blade's levels (its arc).
const HANG_RATE = 18, HANG_LEVELS = 4;
// How far a hanging blade's halves turn their normals toward their edges (the meadow's fold).
const FOLD = 0.6;
// The wind's travel at rest (Wind.ts createWindUniforms: 40 degrees), which combs the rim's grass.
const PREVAILING = [ - Math.cos( 40 * Math.PI / 180 ), - Math.sin( 40 * Math.PI / 180 ) ];

// How far out of the coast a hanging blade keeps at `depth` under the roof: the wall's offsets
// at SKIRT_WALL's depths (RimGround.ts), linear between them and held beyond them.
function wallAt( wall: ArrayLike<number>, depth: number ): number {

	if ( depth <= SKIRT_WALL[ 0 ] ) return wall[ 0 ];
	for ( let k = 1; k < SKIRT_WALL.length; k ++ ) if ( depth <= SKIRT_WALL[ k ] ) {

		const f = ( depth - SKIRT_WALL[ k - 1 ] ) / ( SKIRT_WALL[ k ] - SKIRT_WALL[ k - 1 ] );
		return wall[ k - 1 ] + ( wall[ k ] - wall[ k - 1 ] ) * f;

	}
	return wall[ SKIRT_WALL.length - 1 ];

}

export function buildTurfSkirt( skirt: RimSkirtData, shared: Shared ): THREE.Mesh {

	const built = runSteps( turfSkirtSteps( skirt ) );
	const mesh = new THREE.Mesh( built.geometry, skirtMaterial( shared ) );
	mesh.name = 'turfSkirt';
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	// Like the other vegetation: drawn before the terrain, so the rim's turf under it fails the depth test.
	mesh.renderOrder = - 1;
	mesh.userData = built.counts;
	return mesh;

}

/** The skirt's geometry and its counts (blades, the hanging ones among them, triangles). */
export interface TurfSkirtBuilt { geometry: THREE.BufferGeometry; counts: { blades: number; hanging: number; triangles: number } }

/** Swaps the skirt `mesh` (buildTurfSkirt) to `built` in place. Returns the geometry replaced, to
 * dispose of once nothing draws it. */
function setTurfSkirt( mesh: THREE.Mesh, built: TurfSkirtBuilt ): THREE.BufferGeometry {

	const old = mesh.geometry;
	mesh.geometry = built.geometry;
	mesh.userData = built.counts;
	return old;

}

/** The turf skirt as a vegetation kind (vegetation/Registry.ts): a grown island's skirt is built in
 * steps, uploaded ahead, and swapped into the mesh. */
export function turfSkirtKind( mesh: THREE.Mesh ): VegetationKind<TurfSkirtBuilt> {

	return {
		name: 'skirt', root: mesh, prepass: false, shadowFilter: 'ordinary', sunCaster: true, rainBake: true,
		growth: {
			*prepare( input ) {

				const skirt = yield* turfSkirtSteps( input.data.rimSkirt, 8 );
				yield* geometrySteps( input.renderer, skirt.geometry );
				return skirt;

			},
			swap( prepared ) {

				const old = setTurfSkirt( mesh, prepared );
				return () => old.dispose();

			},
		},
	};

}

/** The skirt's geometry in steps (a generator, `per` samples a step in each pass), so the growth
 * (Growth.ts) builds a grown island's in idle time; `buildTurfSkirt` runs it to the end. The result
 * is the same however it is stepped. */
export function* turfSkirtSteps( skirt: RimSkirtData, per = Infinity ): Generator<void, TurfSkirtBuilt> {

	const P = new Growing(), C = new Growing(), N = new Growing(), B = new Growing(), W = new Growing(), H = new Growing(), I = new Growing();
	const { points, normals, info, pieces } = skirt;
	const col = new THREE.Color(), shade = new THREE.Color(), earth = new THREE.Color( ...SOIL_PALETTE.root );
	const base = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	const normal = new THREE.Vector3(), v = new THREE.Vector3();
	const ring = ( s: number, k: number, target = v ) => target.fromArray( points, ( s * SKIRT_RING + k ) * 3 );
	let blades = 0, hanging = 0, done = 0;

	// Torn gaps: short stretches where the curl has broken off below the shoulder, so the sod's
	// face reads as separate lobes and tufts rather than one smooth mat. Sample s is in a gap.
	const torn = ( s: number ) => {

		ring( s, 3, base );
		return noise3( base.x * 4.7 + 3.9, 7.1, base.z * 4.7 - 2.6 ) * 0.5 + 0.5 > 0.6;

	};
	// Body: the sod sheet, smooth-shaded by the normals the worker found from its rings.
	for ( let l = 0; l < pieces.length; l += 2 ) {

		const first = pieces[ l ], count = pieces[ l + 1 ];
		for ( let s = first; s < first + count; s ++ ) for ( let k = 0; k < SKIRT_RING; k ++ ) {

			if ( k === 0 && ++ done % per === 0 ) yield;
			ring( s, k );
			P.push( v.x, v.y, v.z );
			// Shaded turf under the thatch, mottled with moss and bare earth: as dark as the meadow's
			// turf under its blades, so the mat reads as shade between blades, not a pale slab.
			const mottle = noise3( v.x * 3.1 + 2.2, v.y * 3.1, v.z * 3.1 - 1.4 ) * 0.5 + 0.5;
			meadowColor( v.x, v.z, col ).multiplyScalar( 0.42 + mottle * 0.24 );
			// The underside of the curl shows the dark root mat, not lit grass.
			const roots = Math.max( 0, ( k - 3 ) / 3 ) * ( 0.45 + 0.25 * noise3( v.x * 2.3, v.y * 2.3, v.z * 2.3 ) );
			col.lerp( earth, roots ).multiplyScalar( SHADE[ k ] );
			C.push( col.r, col.g, col.b );
			N.push( normals[ ( s * SKIRT_RING + k ) * 3 ], normals[ ( s * SKIRT_RING + k ) * 3 + 1 ], normals[ ( s * SKIRT_RING + k ) * 3 + 2 ] );
			B.push( 0 ); W.push( 0 ); H.push( 0, 0, 0, 0 );

		}
		// a piece's last sample ends its last segment (a loop's is its first again)
		for ( let s = 0; s + 1 < count; s ++ ) {

			const a = first + s, b = a + 1;
			if ( Math.max( info[ a * SKIRT_INFO + 4 ], info[ b * SKIRT_INFO + 4 ] ) < 0.03 ) continue;
			const gap = torn( a ) || torn( b );
			for ( let k = 0; k + 1 < SKIRT_RING; k ++ ) {

				if ( gap && k >= 3 ) break;
				const a0 = a * SKIRT_RING + k, a1 = a0 + 1, b0 = b * SKIRT_RING + k, b1 = b0 + 1;
				I.push( a0, b0, a1, a1, b0, b1 );

			}

		}

	}

	// A tapered, slightly bent blade of the thatch: two quads and a tip, 5 vertices, coloured as the
	// meadow's blades are, from root to tip (`gradient`).
	const blade = ( root: THREE.Vector3, direction: THREE.Vector3, length: number, width: number, bend: number, color: THREE.Color, n: THREE.Vector3 ) => {

		side.crossVectors( direction, n ).normalize();
		if ( side.lengthSq() < 0.5 ) side.set( 1, 0, 0 );
		const start = P.length / 3;
		const put = ( t: number, w: number ) => {

			v.copy( root ).addScaledVector( direction, length * t ).addScaledVector( up, - bend * length * t * t ).addScaledVector( side, w );
			P.push( v.x, v.y, v.z );
			gradient( color, t, shade );
			C.push( shade.r, shade.g, shade.b );
			N.push( n.x, n.y, n.z ); B.push( 1 ); W.push( t * t ); H.push( 0, 0, 0, 0 );

		};
		put( 0, - width ); put( 0, width );
		put( 0.5, - width * 0.62 ); put( 0.5, width * 0.62 );
		put( 1, 0 );
		I.push( start, start + 1, start + 2, start + 1, start + 3, start + 2, start + 2, start + 3, start + 4 );
		blades ++;

	};
	// A blade hanging from the lip: it leaves its root along `start` and falls along `fall`, a
	// quadratic arc of HANG_LEVELS levels, sword-shaped like the meadow's (wide to two thirds of the
	// way, then to a point; `width` is its whole width at the root). Every level is kept outside
	// the wall below the lip (the sample's SKIRT_WALL offsets, from its coast point `coast` along
	// `out`), so a blade over a battered wall lies on the stone. It swings as a hanging strand
	// (`hangingSway`), by its length times the square of the way down.
	const c1 = new THREE.Vector3(), c2 = new THREE.Vector3(), fold = new THREE.Vector3();
	const hangBlade = ( root: THREE.Vector3, start: THREE.Vector3, fall: THREE.Vector3, length: number, width: number, color: THREE.Color, n: THREE.Vector3,
		phase: number, wall: Float32Array, roof: number ) => {

		c1.copy( root ).addScaledVector( start, length * 0.32 );
		c2.copy( c1 ).addScaledVector( fall, length * 0.72 );
		const first = P.length / 3;
		for ( let i = 0; i <= HANG_LEVELS; i ++ ) {

			const t = i / HANG_LEVELS, u = 1 - t;
			v.copy( root ).multiplyScalar( u * u ).addScaledVector( c1, 2 * u * t ).addScaledVector( c2, t * t );
			const outside = ( v.x - coast.x ) * out.x + ( v.z - coast.z ) * out.z, clear = wallAt( wall, roof - v.y );
			if ( outside < clear ) v.addScaledVector( out, clear - outside );
			// the root in the lip's shade
			gradient( color, t, shade ).multiplyScalar( 0.5 + 0.5 * smoothstep( 0, 0.55, t ) );
			const half = width * 0.5 * Math.sqrt( Math.max( 1 - t * t, 0 ) );
			for ( const sg of i < HANG_LEVELS ? [ - 1, 1 ] : [ 0 ] ) {

				P.push( v.x + side.x * half * sg, v.y + side.y * half * sg, v.z + side.z * half * sg );
				C.push( shade.r, shade.g, shade.b );
				// folded along its midrib like the meadow's, one half turned to each side
				fold.copy( n ).addScaledVector( side, FOLD * sg ).normalize();
				N.push( fold.x, fold.y, fold.z ); B.push( 1 ); W.push( 0 ); H.push( out.x, out.z, phase, length * t * t );

			}

		}
		for ( let i = 0; i < HANG_LEVELS - 1; i ++ ) {

			const k = first + i * 2;
			I.push( k, k + 1, k + 2, k + 1, k + 3, k + 2 );

		}
		const k = first + ( HANG_LEVELS - 1 ) * 2;
		I.push( k, k + 1, k + 2 );
		blades ++; hanging ++;

	};
	const a = new THREE.Vector3(), b = new THREE.Vector3(), tangent = new THREE.Vector3(), out = new THREE.Vector3(), coast = new THREE.Vector3();
	const along = new THREE.Vector3(), start = new THREE.Vector3(), fall = new THREE.Vector3(), bundle = new THREE.Vector3();
	for ( let l = 0; l < pieces.length; l += 2 ) {

		// the blades of the samples that start a segment: a piece's last sample starts the next piece
		const first = pieces[ l ], count = pieces[ l + 1 ];
		for ( let s = first; s + 1 < first + count; s ++ ) {

			if ( ++ done % per === 0 ) yield;
			const [ x, z, nx, nz, presence, droop, roof ] = info.subarray( s * SKIRT_INFO, ( s + 1 ) * SKIRT_INFO );
			const wall = info.subarray( s * SKIRT_INFO + 7, ( s + 1 ) * SKIRT_INFO );
			along.set( - nz, 0, nx );
			out.set( nx, 0, nz );
			coast.set( x, roof, z );
			const gap = torn( s );
			if ( presence >= 0.12 ) {

				// The sod's outer face is a thatch of short blades over the dark root mat, as the meadow
				// is blades over turf: it reads as grass spilling over, not as a smooth green sheet. The
				// blades gather in tufts a few decimetres apart, thinning between them to show the mat.
				const rng = cellStream( Math.round( x * 1000 ), Math.round( z * 1000 ), 5501 );
				ring( s, 3, base );
				const tuft = smoothstep( 0.36, 0.7, noise3( base.x * 3.7 - 2.1, 5.5, base.z * 3.7 + 1.2 ) * 0.5 + 0.5 );
				const n = Math.round( presence * ( 16 + rng() * 8 ) * ( 0.5 + 0.8 * tuft ) );
				for ( let i = 0; i < n; i ++ ) {

					// Where on the cross-section: shoulder to lower edge. Over the top of the curl they
					// stand up out of the sod, so its crest reads as tufts rather than a smooth sheet.
					const r = 1.3 + Math.pow( rng(), 1.3 ) * ( gap ? 1.7 : 4.6 ), k = Math.min( SKIRT_RING - 2, Math.floor( r ) ), f = r - k;
					ring( s, k, a ); ring( s, k + 1, b );
					base.lerpVectors( a, b, f ).addScaledVector( along, ( rng() - 0.5 ) * 0.05 );
					tangent.subVectors( b, a ).normalize();
					const low = Math.min( 1, Math.max( 0, ( r - 2.5 ) / 3 ) );
					dir.copy( tangent ).multiplyScalar( 0.55 ).addScaledVector( out, 0.55 - low * 0.25 )
						.addScaledVector( up, 0.8 - low * 1.25 ).addScaledVector( along, ( rng() - 0.5 ) * 0.8 ).normalize();
					meadowColor( base.x, base.z, col ).multiplyScalar( ( 0.9 + rng() * 0.3 ) * ( 1 - low * 0.25 ) );
					if ( rng() < 0.1 ) col.setRGB( ...STRAW );
					normal.copy( out ).multiplyScalar( 0.5 ).addScaledVector( up, 1 - low * 0.6 ).normalize();
					blade( base, dir, ( 0.08 + rng() * 0.14 ) * ( 1 - low * 0.4 ) * ( 0.7 + presence * 0.4 ) * ( 0.75 + 0.55 * tuft ), ( 0.014 + rng() * 0.012 ) * ( 0.8 + 0.4 * tuft ), 0.3, col, normal );

				}
				// a few root hairs from the sod's lower edge, so the mat ends in a broken fringe
				if ( droop >= 0.04 && rng() < 0.25 + presence * 0.2 ) {

					( gap ? ring( s, 3, base ) : ring( s, 6, base ).lerp( ring( s, 5 ), rng() * 0.5 ) ).addScaledVector( along, ( rng() - 0.5 ) * 0.06 );
					dir.copy( out ).multiplyScalar( 0.15 + rng() * 0.3 ).addScaledVector( up, - 1 ).addScaledVector( along, ( rng() - 0.5 ) * 0.7 ).normalize();
					col.setRGB( 0.13, 0.095, 0.05 ).multiplyScalar( 0.8 + rng() * 0.4 );
					normal.set( nx, 0.3, nz ).normalize();
					blade( base, dir, ( 0.05 + rng() * 0.12 ) * ( 0.7 + droop ), 0.004, - 0.1, col, normal );

				}

			}
			// Grass hanging from the lip: bundles of blades of mixed lengths, combed to one side, in
			// stretches a few metres long with clumps and thin places along them. Where the sod curls
			// over they hang from its lower edge (in a torn gap from its shoulder); along bare stone
			// from the rim itself, fewer, where the meadow's tufts lean over the edge (Grass.ts).
			const fringe = smoothstep( 0.3, 0.56, noise3( x * 0.83 + 4.1, 2.7, z * 0.83 - 0.6 ) * 0.5 + 0.5 );
			const clump = smoothstep( 0.3, 0.72, noise3( x * 3.3 - 1.7, 8.4, z * 3.3 + 2.9 ) * 0.5 + 0.5 );
			const density = ( 0.35 + 0.65 * fringe ) * ( 0.4 + 0.6 * presence ) * ( 0.25 + 0.75 * clump );
			const hang = cellStream( Math.round( x * 1000 ), Math.round( z * 1000 ), 5502 );
			if ( hang() >= density * HANG_RATE * SKIRT_STEP ) continue;
			// Its length: a field along the coast, each bundle its own share of it; longer where the
			// sod is thick.
			const reach = noise3( x * 1.3 + 7.7, 1.9, z * 1.3 - 3.1 ) * 0.5 + 0.5;
			const length = 0.2 + 0.8 * Math.min( 1, Math.max( 0, reach * 0.8 + hang() * 0.4 + presence * 0.2 - 0.12 ) );
			// combed along the coast by the prevailing wind, and off the stone where it blows outward
			const comb = Math.max( - 0.8, Math.min( 0.8, ( along.x * PREVAILING[ 0 ] + along.z * PREVAILING[ 1 ] ) * 0.7 + ( noise3( x * 0.6 - 2.2, 4.4, z * 0.6 + 5.3 ) ) * 0.5 ) );
			const lift = 0.08 + 0.2 * Math.max( 0, nx * PREVAILING[ 0 ] + nz * PREVAILING[ 1 ] );
			( gap ? ring( s, 3, bundle ) : ring( s, 4, bundle ).lerp( ring( s, 6, a ), 0.4 + hang() * 0.6 ) );
			const phase = hang() * Math.PI * 2;
			const strands = 4 + Math.floor( hang() * 4 ) + Math.round( length * 5 );
			for ( let i = 0; i < strands; i ++ ) {

				base.copy( bundle ).addScaledVector( along, ( hang() - 0.5 ) * 0.16 ).addScaledVector( out, ( hang() - 0.5 ) * 0.03 );
				const r = hang();
				start.copy( out ).multiplyScalar( 0.55 + 0.4 * r ).addScaledVector( up, 0.3 - 0.4 * hang() ).addScaledVector( along, comb * 0.6 + ( hang() - 0.5 ) * 0.9 ).normalize();
				fall.set( 0, - 1, 0 ).addScaledVector( out, lift + 0.1 * r ).addScaledVector( along, comb * 0.45 + ( hang() - 0.5 ) * 0.5 ).normalize();
				// The rim's grass is drier than the meadow's: about a fifth of the blades a yellow
				// green, a tenth straw, a fifth a deep green, the rest the lawn's green a little yellowed.
				const tint = hang();
				if ( tint < 0.1 ) col.setRGB( ...STRAW ).multiplyScalar( 0.7 + hang() * 0.25 );
				else meadowColor( base.x, base.z, col ).multiply( tint < 0.3 ? DRY : tint < 0.5 ? DEEP : RIM_TINT ).multiplyScalar( 0.66 + hang() * 0.24 );
				side.copy( along ).addScaledVector( out, ( hang() - 0.5 ) * 0.6 ).normalize();
				normal.copy( out ).multiplyScalar( 0.75 ).addScaledVector( up, 0.5 ).addScaledVector( along, ( hang() - 0.5 ) * 0.4 ).normalize();
				hangBlade( base, start, fall, length * ( 0.5 + 0.5 * Math.sqrt( hang() ) ), 0.026 + hang() * 0.014, col, normal, phase + i * 0.4, wall, roof );

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( yield* float32Steps( P ), 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( yield* float32Steps( N ), 3 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( yield* float32Steps( C ), 3 ) );
	geometry.setAttribute( 'skirtBlade', new THREE.BufferAttribute( yield* float32Steps( B ), 1 ) );
	geometry.setAttribute( 'skirtSway', new THREE.BufferAttribute( yield* float32Steps( W ), 1 ) );
	geometry.setAttribute( 'skirtHang', new THREE.BufferAttribute( yield* float32Steps( H ), 4 ) );
	geometry.setIndex( yield* indexSteps( I ) );
	yield* boundsSteps( geometry );
	geometry.boundingSphere!.radius += 0.12; // the thatch's lean in a gale
	return { geometry, counts: { blades, hanging, triangles: I.length / 3 } };

}

function skirtMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const blade = attribute<'float'>( 'skirtBlade', 'float' ), sway = attribute<'float'>( 'skirtSway', 'float' );
	const hang = attribute<'vec4'>( 'skirtHang', 'vec4' );
	// The thatch leans with the meadow's gust field and sways with it (vegetation/Deform.ts
	// `skirtLean`, SKIRT_WIND); the hanging grass swings as a hanging strand (`hangingSway`,
	// SKIRT_WIND.hang). Each takes its own weight, 0 on the other's vertices and on the sod, where
	// its offset is 0.
	let skirtSway: THREE.Node<'vec2'> | undefined;
	return vegetationMaterial( shared, {
		family: 'sod', name: 'turfSkirt', roughness: 0.93, vertexColors: true,
		wet: { tint: 0.9, roughness: 0.74 },
		rest: positionLocal,
		displacement: ( wind ) => {

			const lean = skirtLean( wind, positionLocal, sway );
			const hung = hangingSway( wind, { position: positionLocal, weight: hang.w, phase: hang.z, out: vec3( hang.x, 0, hang.y ), normal: vec3( 0, 1, 0 ), leafEdge: float( 0 ), leafPhase: float( 0 ) }, SKIRT_WIND.hang );
			if ( wind === shared.wind ) skirtSway = mix( lean.sway, hung.sway, step( 1e-6, hang.w ) );
			return lean.position.add( hung.position.sub( positionLocal ) );

		},
		// Blades are a few millimetres wide, far under a shadow texel: only the sod casts.
		castMask: float( 1 ).sub( blade ),
		sway: () => skirtSway,
		light: { scale: () => float( 1 ), extra: ( L, V ) => backlight( L, V, 4 ).mul( 0.4 ).add( 0.03 ).mul( blade ) },
	} );

}
