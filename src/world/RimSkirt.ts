import * as THREE from 'three/webgpu';
import { attribute, positionLocal, float } from 'three/tsl';
import { meadowColor } from '../materials/Meadow.ts';
import { SOIL_PALETTE } from '../materials/Soil.ts';
import { SKIRT_INFO, SKIRT_RING } from './RimGround.ts';
import { cellStream } from './Anchors.ts';
import { backlight, vegetationMaterial } from './vegetation/Material.ts';
import { skirtLean } from './vegetation/Deform.ts';
import { boundsSteps, float32Steps, indexSteps, runSteps, Growing } from './Steps.ts';
import { noise3, smoothstep } from './noise.ts';
import type { Shared } from '../shared.ts';
import type { RimSkirtData } from './types.ts';

// The turf skirt: the meadow's sod curling a little over the rim, with a thatch of short blades
// gathered in tufts on its shoulder and face, and bundles of hanging grass and root hairs along
// its ragged lower edge. It is swept along the coast traced inside each box (a chunk's) from the
// rim field (RimGround.buildRimSkirt), resampled between the points where the coast crosses the
// box's border, so it follows any shape the rim takes and meets itself across boxes. Each
// sample's blades draw from a stream of its own place, and the body's normals come with the rings,
// so a piece builds alike whichever box traced it and neighbouring pieces meet without a seam. One
// mesh, one draw; it bends with the plants' wind field (Wind.ts). Its material comes from the
// vegetation's factory (vegetation/Material.ts, family 'sod').

const SHADE = [ 0.86, 0.94, 1, 0.9, 0.7, 0.52, 0.4 ];

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

/** The skirt's geometry and its counts (blades, triangles). */
export interface TurfSkirtBuilt { geometry: THREE.BufferGeometry; counts: { blades: number; triangles: number } }

/** Swaps the skirt `mesh` (buildTurfSkirt) to `built` in place. Returns the geometry replaced, to
 * dispose of once nothing draws it. */
export function setTurfSkirt( mesh: THREE.Mesh, built: TurfSkirtBuilt ): THREE.BufferGeometry {

	const old = mesh.geometry;
	mesh.geometry = built.geometry;
	mesh.userData = built.counts;
	return old;

}

/** The skirt's geometry in steps (a generator, `per` samples a step in each pass), so the growth
 * (Growth.ts) builds a grown island's in idle time; `buildTurfSkirt` runs it to the end. The result
 * is the same however it is stepped. */
export function* turfSkirtSteps( skirt: RimSkirtData, per = Infinity ): Generator<void, TurfSkirtBuilt> {

	const P = new Growing(), C = new Growing(), N = new Growing(), B = new Growing(), W = new Growing(), I = new Growing();
	const { points, normals, info, pieces } = skirt;
	const col = new THREE.Color(), earth = new THREE.Color( ...SOIL_PALETTE.root );
	const base = new THREE.Vector3(), dir = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	const normal = new THREE.Vector3(), v = new THREE.Vector3();
	const ring = ( s: number, k: number, target = v ) => target.fromArray( points, ( s * SKIRT_RING + k ) * 3 );
	let blades = 0, done = 0;

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
			// Shaded turf under the thatch, mottled with moss and bare earth.
			const mottle = noise3( v.x * 3.1 + 2.2, v.y * 3.1, v.z * 3.1 - 1.4 ) * 0.5 + 0.5;
			meadowColor( v.x, v.z, col ).multiplyScalar( 0.55 + mottle * 0.3 );
			// The underside of the curl shows the dark root mat, not lit grass.
			const roots = Math.max( 0, ( k - 3 ) / 3 ) * ( 0.45 + 0.25 * noise3( v.x * 2.3, v.y * 2.3, v.z * 2.3 ) );
			col.lerp( earth, roots ).multiplyScalar( SHADE[ k ] );
			C.push( col.r, col.g, col.b );
			N.push( normals[ ( s * SKIRT_RING + k ) * 3 ], normals[ ( s * SKIRT_RING + k ) * 3 + 1 ], normals[ ( s * SKIRT_RING + k ) * 3 + 2 ] );
			B.push( 0 ); W.push( 0 );

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

	// A tapered, slightly bent blade: two quads and a tip, 5 vertices.
	const blade = ( root: THREE.Vector3, direction: THREE.Vector3, length: number, width: number, bend: number, color: THREE.Color, n: THREE.Vector3 ) => {

		side.crossVectors( direction, n ).normalize();
		if ( side.lengthSq() < 0.5 ) side.set( 1, 0, 0 );
		const start = P.length / 3;
		const put = ( t: number, w: number, shade: number ) => {

			v.copy( root ).addScaledVector( direction, length * t ).addScaledVector( up, - bend * length * t * t ).addScaledVector( side, w );
			P.push( v.x, v.y, v.z );
			C.push( color.r * shade, color.g * shade, color.b * shade );
			N.push( n.x, n.y, n.z ); B.push( 1 ); W.push( t * t );

		};
		put( 0, - width, 0.62 ); put( 0, width, 0.62 );
		put( 0.5, - width * 0.62, 0.92 ); put( 0.5, width * 0.62, 0.92 );
		put( 1, 0, 1.12 );
		I.push( start, start + 1, start + 2, start + 1, start + 3, start + 2, start + 2, start + 3, start + 4 );
		blades ++;

	};
	const a = new THREE.Vector3(), b = new THREE.Vector3(), tangent = new THREE.Vector3(), out = new THREE.Vector3();
	for ( let l = 0; l < pieces.length; l += 2 ) {

		// the blades of the samples that start a segment: a piece's last sample starts the next piece
		const first = pieces[ l ], count = pieces[ l + 1 ];
		for ( let s = first; s + 1 < first + count; s ++ ) {

			if ( ++ done % per === 0 ) yield;
			const [ x, z, nx, nz, presence, droop ] = info.subarray( s * SKIRT_INFO, ( s + 1 ) * SKIRT_INFO );
			if ( presence < 0.12 ) continue;
			const rng = cellStream( Math.round( x * 1000 ), Math.round( z * 1000 ), 5501 );
			const along = new THREE.Vector3( - nz, 0, nx );
			out.set( nx, 0, nz );
			// The sod's outer face is a thatch of short blades over the dark root mat, as the meadow
			// is blades over turf: it reads as grass spilling over, not as a smooth green sheet. The
			// blades gather in tufts a few decimetres apart, thinning between them to show the mat.
			const gap = torn( s );
			ring( s, 3, base );
			const tuft = smoothstep( 0.36, 0.7, noise3( base.x * 3.7 - 2.1, 5.5, base.z * 3.7 + 1.2 ) * 0.5 + 0.5 );
			const n = Math.round( presence * ( 12 + rng() * 6 ) * ( 0.4 + 0.9 * tuft ) );
			for ( let i = 0; i < n; i ++ ) {

				// Where on the cross-section: shoulder to lower edge. Over the top of the curl they
				// stand up out of the sod, so its crest reads as tufts rather than a smooth sheet.
				const r = 1.6 + Math.pow( rng(), 0.8 ) * ( gap ? 1.4 : 4.3 ), k = Math.min( SKIRT_RING - 2, Math.floor( r ) ), f = r - k;
				ring( s, k, a ); ring( s, k + 1, b );
				base.lerpVectors( a, b, f ).addScaledVector( along, ( rng() - 0.5 ) * 0.05 );
				tangent.subVectors( b, a ).normalize();
				const low = Math.min( 1, Math.max( 0, ( r - 2.5 ) / 3 ) );
				dir.copy( tangent ).multiplyScalar( 0.55 ).addScaledVector( out, 0.55 - low * 0.25 )
					.addScaledVector( up, 0.8 - low * 1.25 ).addScaledVector( along, ( rng() - 0.5 ) * 0.8 ).normalize();
				meadowColor( base.x, base.z, col ).multiplyScalar( ( 0.8 + rng() * 0.35 ) * ( 1 - low * 0.3 ) );
				if ( rng() < 0.1 ) col.setRGB( 0.34, 0.29, 0.13 );
				normal.copy( out ).multiplyScalar( 0.5 ).addScaledVector( up, 1 - low * 0.6 ).normalize();
				blade( base, dir, ( 0.06 + rng() * 0.11 ) * ( 0.7 + presence * 0.4 ) * ( 0.75 + 0.55 * tuft ), ( 0.014 + rng() * 0.012 ) * ( 0.8 + 0.4 * tuft ), 0.3, col, normal );

			}
			// Lower edge: a bundle of hanging grass under each tuft, a stray root hair between, so
			// the sod ends in a broken fringe rather than an even comb.
			if ( droop < 0.04 ) continue;
			const hanging = tuft > 0.45 ? 1 + Math.floor( rng() * ( 1 + 4 * tuft * presence ) ) : rng() < 0.3 + presence * 0.5 ? 1 : 0;
			for ( let h = 0; h < hanging; h ++ ) {

				// in a torn gap they hang from the broken shoulder
				( gap ? ring( s, 3, base ) : ring( s, 6, base ).lerp( ring( s, 5 ), rng() * 0.5 ) ).addScaledVector( along, ( rng() - 0.5 ) * 0.06 );
				const hair = rng() < ( tuft > 0.45 ? 0.2 : 0.6 );
				dir.copy( out ).multiplyScalar( 0.15 + rng() * 0.3 ).addScaledVector( up, - 1 ).addScaledVector( along, ( rng() - 0.5 ) * 0.7 ).normalize();
				if ( hair ) col.setRGB( 0.13, 0.095, 0.05 ).multiplyScalar( 0.8 + rng() * 0.4 );
				else meadowColor( base.x, base.z, col ).multiplyScalar( 0.6 + rng() * 0.3 );
				normal.set( nx, 0.3, nz ).normalize();
				const length = hair ? 0.05 + rng() * 0.12 : ( 0.06 + rng() * 0.14 ) * ( 1 + 1.1 * tuft );
				blade( base, dir, length * ( 0.7 + droop ), hair ? 0.004 : 0.01 + 0.01 * tuft, - 0.1, col, normal );

			}

		}

	}

	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.BufferAttribute( yield* float32Steps( P ), 3 ) );
	geometry.setAttribute( 'normal', new THREE.BufferAttribute( yield* float32Steps( N ), 3 ) );
	geometry.setAttribute( 'color', new THREE.BufferAttribute( yield* float32Steps( C ), 3 ) );
	geometry.setAttribute( 'skirtBlade', new THREE.BufferAttribute( yield* float32Steps( B ), 1 ) );
	geometry.setAttribute( 'skirtSway', new THREE.BufferAttribute( yield* float32Steps( W ), 1 ) );
	geometry.setIndex( yield* indexSteps( I ) );
	yield* boundsSteps( geometry );
	geometry.boundingSphere!.radius += 0.12; // the thatch's lean in a gale
	return { geometry, counts: { blades, triangles: I.length / 3 } };

}

function skirtMaterial( shared: Shared ): THREE.MeshStandardNodeMaterial {

	const blade = attribute<'float'>( 'skirtBlade', 'float' ), sway = attribute<'float'>( 'skirtSway', 'float' );
	// The thatch leans with the meadow's gust field and sways with it (vegetation/Deform.ts
	// `skirtLean`, SKIRT_WIND).
	let skirtSway: THREE.Node<'vec2'> | undefined;
	return vegetationMaterial( shared, {
		family: 'sod', name: 'turfSkirt', roughness: 0.93, vertexColors: true,
		wet: { tint: 0.9, roughness: 0.74 },
		rest: positionLocal,
		displacement: ( wind ) => {

			const lean = skirtLean( wind, positionLocal, sway );
			if ( wind === shared.wind ) skirtSway = lean.sway;
			return lean.position;

		},
		// Blades are a few millimetres wide, far under a shadow texel: only the sod casts.
		castMask: float( 1 ).sub( blade ),
		sway: () => skirtSway,
		light: { scale: () => float( 1 ), extra: ( L, V ) => backlight( L, V, 4 ).mul( 0.4 ).add( 0.03 ).mul( blade ) },
	} );

}
