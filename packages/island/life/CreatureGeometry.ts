/*!
 * Adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater), src/world/fish/CreatureGeometry.js.
 * SPDX-FileCopyrightText: Copyright (c) 2026 DRG Software Solutions LLC
 * SPDX-License-Identifier: MIT
 */

import * as THREE from 'three/webgpu';
import { MeshData, PART } from './FishGeometry.ts';

// The rays and the green turtle, in the fish's frame, so one material poses and paints them.
//
// Tidewater's CreatureGeometry (4811ba4), in the fish's frame (the snout at z = +0.5, the back at
// +y, the total length 1), so they share the swimmers' material and its data:
//  - a ray: a flat disc (PART.DISC) whose margins undulate (a stingray) or flap (an eagle ray) in
//    the vertex stage, eyes on top (PART.EYE), a whip tail (PART.WHIP). aData: x the position along
//    the body, z the distance from the midline (0 .. 1 at the wing's tip), w 1 on the back, -1 on
//    the belly.
//  - the turtle: a domed carapace (PART.CARAPACE, its pattern's coordinates in z and w), the
//    plastron (PART.SKIN, w 2), the head and neck (PART.SKIN, w 1), the flippers (PART.FLIPPER: z
//    the distance from the shoulder, w the flipper, 0 and 1 the front left and right, 2 and 3 the
//    hind) that stroke about their shoulders.
// Each comes at two levels (`detail` 0 near, 1 far: fewer rings, no eyes).

const TAU = Math.PI * 2;

type Pt = [ number, number, number, number, number? ];

// a tapered tube along points ( x, y, z, radius, the vertical squash ); aData's z and w per point
// from `data`
function tube( M: MeshData, pts: readonly Pt[], sides: number, part: number, data: ( i: number, t: number ) => [ number, number ], caps = true ): void {

	const rows: number[][] = [];
	const d = new THREE.Vector3(), s1 = new THREE.Vector3(), s2 = new THREE.Vector3(), up = new THREE.Vector3( 0, 1, 0 );
	for ( let i = 0; i < pts.length; i ++ ) {

		const p = pts[ i ], q = pts[ Math.min( i + 1, pts.length - 1 ) ], o = pts[ Math.max( i - 1, 0 ) ];
		d.set( q[ 0 ] - o[ 0 ], q[ 1 ] - o[ 1 ], q[ 2 ] - o[ 2 ] ).normalize();
		s1.crossVectors( up, d );
		if ( s1.lengthSq() < 1e-6 ) s1.set( 1, 0, 0 );
		s1.normalize();
		s2.crossVectors( d, s1 );
		const [ dz, dw ] = data( i, i / ( pts.length - 1 ) );
		const row: number[] = [];
		for ( let j = 0; j < sides; j ++ ) {

			const a = j / sides * TAU, r = p[ 3 ], sq = p[ 4 ] ?? 1;
			row.push( M.v(
				p[ 0 ] + ( s1.x * Math.cos( a ) + s2.x * Math.sin( a ) ) * r,
				p[ 1 ] + ( s1.y * Math.cos( a ) + s2.y * Math.sin( a ) ) * r * sq,
				p[ 2 ] + ( s1.z * Math.cos( a ) + s2.z * Math.sin( a ) ) * r,
				0.5 - p[ 2 ], part, dz, dw,
			) );

		}
		rows.push( row );

	}
	for ( let i = 0; i < rows.length - 1; i ++ ) for ( let j = 0; j < sides; j ++ ) {

		const j1 = ( j + 1 ) % sides;
		M.tri( rows[ i ][ j ], rows[ i + 1 ][ j ], rows[ i ][ j1 ] );
		M.tri( rows[ i ][ j1 ], rows[ i + 1 ][ j ], rows[ i + 1 ][ j1 ] );

	}
	if ( caps ) {

		const last = rows[ rows.length - 1 ], p = pts[ pts.length - 1 ];
		const c = M.v( p[ 0 ], p[ 1 ], p[ 2 ], 0.5 - p[ 2 ], part, ...data( pts.length - 1, 1 ) );
		for ( let j = 0; j < sides; j ++ ) M.tri( last[ j ], c, last[ ( j + 1 ) % sides ] );

	}

}

/** A ray: a stingray's rhombic disc that undulates, or an eagle ray's (`eagle`) pointed, swept
 * wings that flap, its head standing out and its tail some three times its disc. */
export function rayGeometry( eagle: boolean, detail: 0 | 1 = 0 ): THREE.BufferGeometry {

	const M = new MeshData();
	const nA = detail ? 20 : 44, nR = detail ? 4 : 9;
	// the disc's outline (the right half, from the snout round to the tail); its radius at an angle
	// (0 ahead, PI / 2 the right wing's tip) is where the ray from the centre leaves the polygon
	const half = eagle ?
		[ [ 0, 0.27 ], [ 0.05, 0.25 ], [ 0.07, 0.19 ], [ 0.2, 0.12 ], [ 0.36, 0.04 ], [ 0.5, - 0.07 ], [ 0.42, - 0.09 ], [ 0.26, - 0.11 ], [ 0.13, - 0.17 ], [ 0.04, - 0.2 ], [ 0, - 0.2 ] ] :
		[ [ 0, 0.43 ], [ 0.08, 0.37 ], [ 0.3, 0.17 ], [ 0.47, 0.02 ], [ 0.5, - 0.03 ], [ 0.44, - 0.12 ], [ 0.26, - 0.3 ], [ 0.12, - 0.4 ], [ 0, - 0.42 ] ];
	const poly = [ ...half, ...half.slice( 1, - 1 ).reverse().map( ( p ) => [ - p[ 0 ], p[ 1 ] ] ) ];
	const outline = ( a: number ) => {

		const dx = Math.sin( a ), dz = Math.cos( a );
		let best = 0;
		for ( let i = 0; i < poly.length; i ++ ) {

			const p = poly[ i ], q = poly[ ( i + 1 ) % poly.length ];
			const ex = q[ 0 ] - p[ 0 ], ez = q[ 1 ] - p[ 1 ];
			const den = dx * ez - dz * ex;
			if ( Math.abs( den ) < 1e-9 ) continue;
			const t = ( p[ 0 ] * ez - p[ 1 ] * ex ) / den, u = ( p[ 0 ] * dz - p[ 1 ] * dx ) / den;
			if ( t > 0 && u >= 0 && u <= 1 ) best = Math.max( best, t );

		}
		return best;

	};
	// the disc's centre (the disc sits at the front of the total length) and its thickness
	const cz = eagle ? 0.23 : 0.07, thick = eagle ? 0.07 : 0.06;
	for ( const side of [ 1, - 1 ] ) {

		const rows: number[][] = [];
		const centre = M.v( 0, side * thick * ( side > 0 ? 1 : 0.4 ), cz, 0.5 - cz, PART.DISC, 0, side );
		for ( let k = 1; k <= nR; k ++ ) {

			const s = k / nR, row: number[] = [];
			for ( let j = 0; j < nA; j ++ ) {

				const a = j / nA * TAU, r = outline( a ) * s;
				const x = Math.sin( a ) * r, z = cz + Math.cos( a ) * r;
				// the body's dome over the middle, thin margins
				const body = Math.exp( - ( x * x ) / ( eagle ? 0.012 : 0.02 ) - Math.pow( ( z - cz ) / 0.28, 2 ) );
				const y = side * ( thick * body * ( side > 0 ? 1 : 0.45 ) + 0.004 * ( 1 - s ) );
				row.push( M.v( x, y, z, 0.5 - z, PART.DISC, Math.abs( x ) / 0.5, side ) );

			}
			rows.push( row );

		}
		for ( let j = 0; j < nA; j ++ ) {

			const j1 = ( j + 1 ) % nA;
			if ( side > 0 ) M.tri( centre, rows[ 0 ][ j ], rows[ 0 ][ j1 ] );
			else M.tri( centre, rows[ 0 ][ j1 ], rows[ 0 ][ j ] );
			for ( let k = 0; k < nR - 1; k ++ ) {

				const a = rows[ k ][ j ], b = rows[ k ][ j1 ], c = rows[ k + 1 ][ j1 ], d = rows[ k + 1 ][ j ];
				if ( side > 0 ) { M.tri( a, d, b ); M.tri( b, d, c ); } else { M.tri( a, b, d ); M.tri( b, c, d ); }

			}

		}

	}
	if ( detail === 0 ) for ( const s of [ 1, - 1 ] ) {

		const ex = s * ( eagle ? 0.09 : 0.06 ), ez = cz + ( eagle ? 0.13 : 0.16 );
		tube( M, [ [ ex, thick * 0.7, ez + 0.012, 0.004 ], [ ex, thick * 0.85, ez, 0.013 ], [ ex, thick * 0.9, ez - 0.012, 0.004 ] ], 6, PART.EYE, () => [ 0, 0 ] );

	}
	// the whip tail
	const tl = eagle ? 1.0 : 0.62, tz0 = cz - ( eagle ? 0.19 : 0.4 ), nT = detail ? 4 : 10;
	const tp: Pt[] = [];
	for ( let i = 0; i <= nT; i ++ ) {

		const t = i / nT;
		tp.push( [ 0, 0.01 - t * 0.01, tz0 - t * tl, ( eagle ? 0.014 : 0.026 ) * ( 1 - t ) + 0.002, 0.8 ] );

	}
	tube( M, tp, detail ? 3 : 5, PART.WHIP, () => [ 0, 1 ] );
	return M.build();

}

/** The green turtle: its carapace some 0.72 of the total length 1, the head forward. */
export function turtleGeometry( detail: 0 | 1 = 0 ): THREE.BufferGeometry {

	const M = new MeshData();
	const L = 0.72, W = 0.56, Hc = 0.2, zc = - 0.02;
	const nA = detail ? 14 : 30, nR = detail ? 3 : 7;
	// the carapace's heart-shaped dome above, the plastron flat below
	const rim = ( a: number ) => {

		const s = Math.sin( a ), c = Math.cos( a );
		const r = 1 / Math.sqrt( ( s * s ) / ( W * W / 4 ) + ( c * c ) / ( L * L / 4 ) );
		return r * ( 1 - 0.12 * Math.pow( Math.max( 0, - c ), 3 ) ) * ( 1 + 0.04 * Math.max( 0, c ) );

	};
	for ( const top of [ true, false ] ) {

		const rows: number[][] = [];
		const centre = M.v( 0, top ? Hc : - 0.07, zc, 0.5 - zc, top ? PART.CARAPACE : PART.SKIN, 0, top ? 0 : 2 );
		for ( let k = 1; k <= nR; k ++ ) {

			const s = k / nR, row: number[] = [];
			for ( let j = 0; j < nA; j ++ ) {

				const a = j / nA * TAU, r = rim( a ) * s;
				const x = Math.sin( a ) * r, z = zc + Math.cos( a ) * r;
				const y = top ? Hc * Math.pow( 1 - s * s, 0.6 ) * ( 1 - 0.1 * Math.cos( a ) ) - 0.02 * s * s : - 0.07 * ( 1 - s * s * s ) - 0.015;
				row.push( M.v( x, y, z, 0.5 - z, top ? PART.CARAPACE : PART.SKIN, top ? x / ( W / 2 ) : 0, top ? ( z - zc ) / ( L / 2 ) : 2 ) );

			}
			rows.push( row );

		}
		for ( let j = 0; j < nA; j ++ ) {

			const j1 = ( j + 1 ) % nA;
			if ( top ) M.tri( centre, rows[ 0 ][ j ], rows[ 0 ][ j1 ] );
			else M.tri( centre, rows[ 0 ][ j1 ], rows[ 0 ][ j ] );
			for ( let k = 0; k < nR - 1; k ++ ) {

				const a = rows[ k ][ j ], b = rows[ k ][ j1 ], c = rows[ k + 1 ][ j1 ], d = rows[ k + 1 ][ j ];
				if ( top ) { M.tri( a, d, b ); M.tri( b, d, c ); } else { M.tri( a, b, d ); M.tri( b, c, d ); }

			}

		}

	}
	// the head and neck
	const sides = detail ? 5 : 9;
	tube( M, [
		[ 0, 0.0, zc + L / 2 - 0.08, 0.075, 0.75 ], [ 0, 0.01, zc + L / 2 + 0.02, 0.065, 0.8 ], [ 0, 0.02, zc + L / 2 + 0.1, 0.07, 0.85 ],
		[ 0, 0.02, zc + L / 2 + 0.16, 0.06, 0.8 ], [ 0, 0.0, zc + L / 2 + 0.2, 0.03, 0.7 ],
	], sides, PART.SKIN, () => [ 0, 1 ] );
	if ( detail === 0 ) for ( const s of [ 1, - 1 ] ) {

		const ex = s * 0.052, ez = zc + L / 2 + 0.13;
		tube( M, [ [ ex, 0.035, ez + 0.012, 0.004 ], [ ex * 1.08, 0.037, ez, 0.013 ], [ ex, 0.035, ez - 0.012, 0.004 ] ], 6, PART.EYE, () => [ 0, 0 ] );

	}
	// the flippers: flattened, tapered tubes from the shoulders, widest a third of the way out and
	// curving back toward the tip
	const flipper = ( id: number, x0: number, z0: number, dir: [ number, number ], len: number, width: number ) => {

		const pts: Pt[] = [], n = detail ? 4 : 8;
		for ( let i = 0; i <= n; i ++ ) {

			const t = i / n;
			const w = width * ( 0.55 + 0.9 * Math.sin( Math.PI * Math.min( 1, 0.15 + t * 0.95 ) ) ) * ( 1 - 0.7 * t * t );
			pts.push( [ x0 + dir[ 0 ] * len * t, - 0.03 - t * 0.02, z0 + dir[ 1 ] * len * t - len * 0.25 * t * t, w, 0.22 ] );

		}
		tube( M, pts, detail ? 4 : 7, PART.FLIPPER, ( _i, t ) => [ t, id ] );

	};
	const s2 = Math.SQRT1_2;
	flipper( 0, 0.2, zc + 0.2, [ s2 * 1.2, s2 * 0.2 ], 0.48, 0.07 );
	flipper( 1, - 0.2, zc + 0.2, [ - s2 * 1.2, s2 * 0.2 ], 0.48, 0.07 );
	flipper( 2, 0.16, zc - 0.28, [ 0.8, - 0.6 ], 0.2, 0.06 );
	flipper( 3, - 0.16, zc - 0.28, [ - 0.8, - 0.6 ], 0.2, 0.06 );
	// the short tail
	tube( M, [ [ 0, - 0.02, zc - L / 2 + 0.02, 0.035, 0.6 ], [ 0, - 0.03, zc - L / 2 - 0.08, 0.004, 0.6 ] ], detail ? 3 : 5, PART.SKIN, () => [ 0, 1 ] );
	return M.build();

}
