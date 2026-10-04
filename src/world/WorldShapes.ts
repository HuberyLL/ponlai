// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block, the sea stacks, the scattered
// rocks, the seabed height and the shoreline distance at sea level.

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, fbm2, mulberry32, smoothstep, smax, type Rng } from './noise.ts';
import type { SDF, Stack, Rock } from './types.ts';

export interface Footprint {
	fine: Field2D;
	coarse: Field2D;
	dist( x: number, z: number ): number;
}

export type HeightFn = ( x: number, z: number ) => number;

const TILE = 4;
export const ISLAND_TOP = 3.1;
export const ISLAND_BOTTOM = - 5.6;

// the footprint, one character per 4 m tile (rows run +z, columns +x)
const LAYOUT = [
	'...XXXX',
	'XXXXXXX',
	'XXXXXX.',
	'.XXXXX.',
	'..XX...',
];

export function layoutBounds() {

	const rows = LAYOUT.length, cols = LAYOUT[ 0 ].length;
	return { x0: - cols * TILE / 2, z0: - rows * TILE / 2, x1: cols * TILE / 2, z1: rows * TILE / 2 };

}

// ------------------------------------------------------------------ footprint

// signed distance to the tile union, corners rounded; fine near the island, coarse far out
export function buildFootprint(): Footprint {

	const b = layoutBounds();
	const tileInside = ( x: number, z: number ) => {

		const i = Math.floor( ( x - b.x0 ) / TILE ), j = Math.floor( ( z - b.z0 ) / TILE );
		return j >= 0 && j < LAYOUT.length && i >= 0 && i < LAYOUT[ 0 ].length && LAYOUT[ j ][ i ] === 'X';

	};

	const pad = 10;
	const fine = Field2D.covering( b.x0 - pad, b.x1 + pad, b.z0 - pad, b.z1 + pad, 0.08 )
		.fill( ( x: number, z: number ) => tileInside( x, z ) ? - 1 : 1 )
		.signedDistance();
	const rounded = roundCorners( fine, 0.9, 1.4 );

	const R = 160;
	const coarse = Field2D.covering( - R, R, - R, R, 0.5 )
		.fill( ( x: number, z: number ) => tileInside( x, z ) ? - 1 : 1 )
		.signedDistance();

	return {
		fine: rounded,
		coarse,
		// signed horizontal distance to the island's edge (m)
		dist( x: number, z: number ) {

			return rounded.contains( x, z ) ? sampleFineOrCoarse( rounded, coarse, x, z ) : coarse.sample( x, z );

		},
	};

}

function sampleFineOrCoarse( fine: Field2D, coarse: Field2D, x: number, z: number ): number {

	// blend toward the coarse field in the outer pad so the two never seam
	const ex = Math.min( x - fine.x0, fine.x0 + fine.nx * fine.cell - x );
	const ez = Math.min( z - fine.z0, fine.z0 + fine.nz * fine.cell - z );
	const w = smoothstep( 0.5, 3.0, Math.min( ex, ez ) );
	const f = fine.sample( x, z );
	return w >= 1 ? f : f * w + coarse.sample( x, z ) * ( 1 - w );

}

// ------------------------------------------------------------------ island block

// soft maximum of a set of plane distances (log-sum-exp): flat faces, edges rounded by ~k
function softMax( vals: Float64Array, n: number, k: number ): number {

	let m = - 1e9;
	for ( let i = 0; i < n; i ++ ) if ( vals[ i ] > m ) m = vals[ i ];
	let s = 0;
	for ( let i = 0; i < n; i ++ ) s += Math.exp( ( vals[ i ] - m ) / k );
	return m + k * Math.log( s );

}

interface CliffFace {
	x: number; z: number; nx: number; nz: number;
	left: number; right: number; bottom: number; upper: number; y: number;
	depth: number; leanU: number; leanY: number; chip: number;
}

// Sparse, broad planar losses follow the shore's local direction. Their unequal shoulders
// leave intact stone between cuts instead of deforming every point with a volume-noise lattice.
function makeCliffFaces( fp: Footprint ): CliffFace[] {

	const b = layoutBounds(), candidates: number[][] = [];
	const step = 0.45, e = 0.16;
	for ( let z = b.z0 - 1; z < b.z1 + 1; z += step ) for ( let x = b.x0 - 1; x < b.x1 + 1; x += step ) {

		const d = fp.dist( x, z );
		if ( Math.abs( d ) > step ) continue;
		for ( let axis = 0; axis < 2; axis ++ ) {

			const d1 = fp.dist( x + ( axis === 0 ? step : 0 ), z + ( axis === 1 ? step : 0 ) );
			if ( d * d1 >= 0 ) continue;
			const t = d / ( d - d1 );
			const px = x + ( axis === 0 ? step * t : 0 ), pz = z + ( axis === 1 ? step * t : 0 );
			const nx = fp.dist( px + e, pz ) - fp.dist( px - e, pz );
			const nz = fp.dist( px, pz + e ) - fp.dist( px, pz - e );
			const l = Math.hypot( nx, nz );
			if ( l > 0.01 ) candidates.push( [ px, pz, nx / l, nz / l ] );

		}

	}
	const rng = mulberry32( 1937 );
	for ( let i = candidates.length - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ candidates[ i ], candidates[ j ] ] = [ candidates[ j ], candidates[ i ] ];

	}
	const faces: CliffFace[] = [];
	for ( const p of candidates ) {

		if ( faces.some( ( f ) => Math.hypot( f.x - p[ 0 ], f.z - p[ 1 ] ) < 1.9 ) || rng() < 0.18 ) continue;
		faces.push( {
			x: p[ 0 ], z: p[ 1 ], nx: p[ 2 ], nz: p[ 3 ],
			left: 0.65 + rng() * 1.1, right: 0.55 + rng() * 1.25,
			bottom: 0.9 + rng() * 1.8, upper: 0.65 + rng() * 1.8, y: 0.2 + rng() * 2.3,
			depth: 0.08 + rng() * 0.18, leanU: ( rng() - 0.5 ) * 0.05, leanY: ( rng() - 0.5 ) * 0.055,
			chip: rng() < 0.3 ? 0.06 + rng() * 0.1 : 0,
		} );

	}
	return faces;

}

export function makeIslandSDF( fp: Footprint ): SDF {

	const top = ( x: number, z: number ) => ISLAND_TOP + noise3( x * 0.18, 4.1, z * 0.18 ) * 0.12 + noise3( x * 0.7, 1.3, z * 0.7 ) * 0.04;
	const faces = makeCliffFaces( fp );
	// Cache horizontal cut bounds because the worker samples the full height at each (x, z).
	let cx = NaN, cz = NaN, cD2 = 0, cTop = 0, cLean = 0, cChip = 0;
	const active: { face: CliffFace; u: number; shoulder: number; support: number }[] = [];
	function column( x: number, z: number ): void {

		if ( x === cx && z === cz ) return;
		cx = x; cz = z;
		cD2 = fp.dist( x, z );
		cTop = top( x, z );
		cLean = noise3( x * 0.16 + 6.1, 9.7, z * 0.16 ) * 0.035;
		cChip = 0;
		active.length = 0;
		if ( Math.abs( cD2 ) > 1 ) return;
		for ( const face of faces ) {

			const dx = x - face.x, dz = z - face.z;
			const across = Math.abs( dx * face.nx + dz * face.nz );
			if ( across >= 0.85 ) continue;
			const support = 1 - smoothstep( 0.5, 0.85, across );
			const u = - dx * face.nz + dz * face.nx;
			const shoulder = Math.min( ( u + face.left ) * 0.24, ( face.right - u ) * 0.3 );
			if ( shoulder <= 0 ) continue;
			active.push( { face, u, shoulder, support } );
			cChip = Math.max( cChip, Math.min( face.chip, shoulder * 0.8 ) * support );

		}

	}

	const islandSDF: SDF = ( x, y, z ) => {

		column( x, z );
		const dBot = ISLAND_BOTTOM - y;
		if ( Math.abs( cD2 ) > 1 ) return Math.max( cD2, y - cTop, dBot );
		let cut = 0;
		for ( const { face, u, shoulder, support } of active ) {

			const v = y - face.y;
			cut = Math.max( cut, Math.min( face.depth + u * face.leanU + v * face.leanY,
				shoulder, ( v + face.bottom ) * 0.13, ( face.upper - v ) * 0.18 ) * support );

		}
		// Shallow, smooth weathering stays subordinate to the broad rock planes.
		const wear = noise3( x * 0.55 + 3.8, y * 0.8, z * 0.55 ) * 0.025
			+ noise3( x * 2.1, y * 1.3 + 4.7, z * 2.1 ) * 0.008;
		const domain = 1 - smoothstep( 0.55, 0.95, Math.abs( cD2 ) );
		let d = cD2 + ( cLean * ( y - 1.3 ) + cut + wear ) * domain;
		const rim = cTop - cChip * domain * smoothstep( - 0.5, 0.1, cD2 );
		d = smax( d, y - rim, 0.065 );
		return Math.max( d, dBot );

	};

	islandSDF.tint = ( x, y, z ) => 0.5 + noise3( x * 0.2 + 9.3, y * 0.16, z * 0.2 ) * 0.3;
	return islandSDF;

}

// ------------------------------------------------------------------ sea stacks

export function makeStacks(): Stack[] {

	return [
		{ x: - 21.5, z: - 9.5, r: 1.22, h: 5.6 },
		{ x: - 18.5, z: 11.5, r: 1.38, h: 4.2 },
		{ x: 19.5, z: - 13.5, r: 1.10, h: 6.3 },
		{ x: 23.0, z: 3.5, r: 1.23, h: 4.7 },
		{ x: 7.5, z: 17.0, r: 0.96, h: 3.2 },
		{ x: - 5.5, z: - 17.5, r: 1.04, h: 4.4 },
		{ x: 12.5, z: - 18.0, r: 0.76, h: 2.5 },
	];

}

const STACK_FOOT = - 6.8;

// Long, unequal cleavage planes carry the monolith. Inclined losses span a whole shoulder,
// so the mass changes direction gradually instead of pinching into repeated narrow bands.
export function makeStackSDF( s: Stack, seed: number ): SDF {

	const rng = mulberry32( 1000 + seed * 77 );
	const N = 6 + Math.floor( rng() * 3 );
	const rot = rng() * Math.PI * 2;
	const planes: number[] = [];
	for ( let i = 0; i < N; i ++ ) {

		const a = rot + ( i + ( rng() - 0.5 ) * 0.36 ) * Math.PI * 2 / N;
		planes.push( Math.cos( a ), Math.sin( a ), s.r * ( 0.76 + rng() * 0.34 ),
			( rng() - 0.5 ) * 0.085 );

	}
	const losses: number[] = [];
	for ( let i = 0; i < 2; i ++ ) {

		const a = rot + i * 2.15 + rng() * 0.7;
		const ny = 0.075 + rng() * 0.11, nr = Math.sqrt( 1 - ny * ny );
		losses.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr,
			s.r * ( 0.84 + rng() * 0.22 ), s.h * ( 0.24 + rng() * 0.24 ) );

	}
	const upperCount = rng() < 0.5 ? 1 : 2;
	const shoulderA = rot + 0.35 + rng() * 0.9;
	for ( let i = 0; i < upperCount; i ++ ) {

		const a = shoulderA + i * ( 1.5 + rng() * 1.1 );
		const ny = 0.43 + rng() * 0.25, nr = Math.sqrt( 1 - ny * ny );
		// A deep loss enters one shoulder while the opposite side keeps its taller crown.
		const offset = i === 0 ? s.r * ( 0.30 + rng() * 0.18 ) : s.r * ( 0.65 + rng() * 0.22 );
		const height = i === 0 ? s.h - 0.20 - rng() * 0.25 : s.h + rng() * 0.20;
		losses.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, offset, height );

	}
	const leanX = ( rng() - 0.5 ) * 0.080, leanZ = ( rng() - 0.5 ) * 0.080;
	const topA = rng() * Math.PI * 2, topSlope = 0.28 + rng() * 0.20;
	const crown: number[] = [ Math.cos( topA ) * topSlope, Math.sin( topA ) * topSlope, s.h + 0.06 ];
	for ( let i = 0; i < 2; i ++ ) {

		const a = topA + 1.8 + i * 1.7 + rng() * 0.45, slope = 0.42 + rng() * 0.35;
		crown.push( Math.cos( a ) * slope, Math.sin( a ) * slope, s.h + 0.10 + rng() * 0.18 );

	}
	const tint = rng();
	const vals = new Float64Array( N );
	const stackSDF: SDF = ( x, y, z ) => {

		const lx = x - s.x - y * leanX, lz = z - s.z - y * leanZ;
		const rr = Math.hypot( lx, lz );
		if ( rr > s.r * 1.7 + 0.8 ) return rr - s.r * 1.5;
		const t = Math.max( 0, Math.min( 1, y / s.h ) );
		const foot = smoothstep( - 0.3, - 3.2, y ) * s.r * 0.11;
		for ( let i = 0; i < N; i ++ ) {

			const k = i * 4;
			vals[ i ] = lx * planes[ k ] + lz * planes[ k + 1 ] + y * planes[ k + 3 ]
				- planes[ k + 2 ] * ( 1 - t * 0.045 ) - foot;

		}
		let d = softMax( vals, N, 0.035 );
		// Subtle erosion softens the arrises; the larger shape still comes from oblique planes.
		d += noise3( lx * 0.65 + seed * 3.1, y * 0.45, lz * 0.65 ) * s.r * 0.055;
		for ( let i = 0; i < losses.length; i += 5 ) {

			const cut = lx * losses[ i ] + ( y - losses[ i + 4 ] ) * losses[ i + 1 ]
				+ lz * losses[ i + 2 ] - losses[ i + 3 ];
			d = smax( d, cut, 0.045 );

		}
		for ( let i = 0; i < crown.length; i += 3 ) {

			const cap = y - crown[ i + 2 ] - lx * crown[ i ] - lz * crown[ i + 1 ]
				+ noise3( lx * 1.1 + seed, 3.3, lz * 1.1 ) * 0.065;
			d = smax( d, cap, 0.04 );

		}
		return Math.max( d, STACK_FOOT - y );

	};

	stackSDF.tint = ( x, y, z ) => Math.min( 1, Math.max( 0, tint + noise3( x * 0.35, y * 0.24, z * 0.35 ) * 0.08 ) );
	return stackSDF;

}

// ------------------------------------------------------------------ scattered rocks

export function makeRocks( fp: Footprint, stacks: Stack[], seabedHeight: HeightFn ): Rock[] {

	const rng = mulberry32( 77 );
	const rocks: Rock[] = [];
	const place = ( x: number, z: number, size: number, sy: number, y?: number ): boolean => {

		const d = fp.dist( x, z );
		if ( d < 0.65 || d > 24 ) return false;
		if ( rocks.some( ( r ) => Math.hypot( r.x - x, r.z - z ) < ( r.s + size ) * 1.08 ) ) return false;
		if ( stacks.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < s.r + size * 1.35 + 0.55 ) ) return false;
		const floor = seabedHeight( x, z );
		rocks.push( {
			x, z, s: size, sy, y: y ?? floor + sy * ( 0.28 + rng() * 0.22 ), floor,
			rot: rng() * Math.PI, seed: rocks.length + 1,
		} );
		return true;

	};

	// A handful of distinct exposed masses leaves open water between groups. Different crown
	// heights mix low slabs with chunky blocks; their smaller companions stay under the waves.
	const groups = [
		{ x: - 21, z: 19, s: 1.65, sy: 1.05, y: - 0.12 },
		{ x: - 4, z: 25, s: 1.30, sy: 0.62, y: - 0.08 },
		{ x: 22, z: 12, s: 1.45, sy: 0.95, y: - 0.16 },
		{ x: - 23, z: - 2, s: 1.15, sy: 1.08, y: - 0.07 },
		{ x: 15, z: - 19, s: 1.00, sy: 0.77, y: - 0.10 },
	];
	for ( const r of groups ) place( r.x, r.z, r.s, r.sy, r.y );

	// These broad, shallow stones can be read through the water close to the island, rather
	// than all becoming another row of similar peaks above it.
	for ( const [ x, z, size, sy ] of [
		[ 16, 0, 1.05, 0.58 ], [ - 12, 13, 0.95, 0.62 ],
		[ - 6, - 13, 1.10, 0.65 ], [ 9, 13, 0.85, 0.50 ],
	] ) place( x, z, size, sy, - 0.65 );

	let tries = 0;
	while ( rocks.length < 38 && tries ++ < 4000 ) {

		let x: number, z: number;
		const a = rng() * Math.PI * 2;
		if ( rng() < 0.64 ) {

			const group = rng() < 0.58 ? groups[ Math.floor( rng() * groups.length ) ] : stacks[ Math.floor( rng() * stacks.length ) ];
			const R = 3.0 + rng() * 5.5;
			x = group.x + Math.cos( a ) * R; z = group.z + Math.sin( a ) * R;

		} else {

			const R = 14 + Math.pow( rng(), 1.3 ) * 22;
			x = Math.cos( a ) * R * 1.1; z = Math.sin( a ) * R;

		}
		const d = fp.dist( x, z );
		const nearStack = stacks.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < 6 );
		if ( d > 11 && ! nearStack && rng() < 0.65 ) continue;
		const size = 0.27 + Math.pow( rng(), 1.8 ) * 0.94 + ( d < 3 ? 0.12 : 0 );
		const sy = size * ( 0.40 + rng() * 0.54 );
		place( x, z, size, sy );

	}

	return rocks;

}

// Unequal side faces, clipped shoulders and one broad inclined crown keep a boulder chunky.
// Independently sampled plane offsets avoid the regular pointed cap of a sparse sphere mesh.
function polyhedron( rng: Rng ): number[] {

	const planes: number[] = [];
	const spin = rng() * Math.PI * 2;
	const N = 7 + Math.floor( rng() * 3 );
	for ( let i = 0; i < N; i ++ ) {

		const a = spin + ( i + ( rng() - 0.5 ) * 0.35 ) * Math.PI * 2 / N;
		const ny = ( rng() - 0.5 ) * 0.17, nr = Math.sqrt( 1 - ny * ny );
		planes.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.77 + rng() * 0.24 );

	}
	for ( let i = 0; i < 4; i ++ ) {

		const a = spin + ( i + 0.36 + ( rng() - 0.5 ) * 0.32 ) * Math.PI * 0.5;
		const ny = 0.48 + rng() * 0.30, nr = Math.sqrt( 1 - ny * ny );
		planes.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.75 + rng() * 0.18 );
		const by = - 0.56 - rng() * 0.24, br = Math.sqrt( 1 - by * by );
		planes.push( Math.cos( a + 0.4 ) * br, by, Math.sin( a + 0.4 ) * br, 0.75 + rng() * 0.16 );

	}
	const a = rng() * Math.PI * 2, nr = 0.09 + rng() * 0.18;
	planes.push( Math.cos( a ) * nr, Math.sqrt( 1 - nr * nr ), Math.sin( a ) * nr, 0.70 + rng() * 0.19 );
	planes.push( 0, - 1, 0, 0.72 );
	return planes;

}

export function makeRockSDF( r: Rock ): SDF {

	const rng = mulberry32( r.seed * 7919 + 13 );
	const c = Math.cos( r.rot ), s = Math.sin( r.rot );
	const planes = polyhedron( rng );
	// A few exposed masses have a broad sheared corner. Keeping this treatment sparse makes
	// low slabs and taller blocks distinct instead of giving every stone the same silhouette.
	if ( r.seed === 2 || r.seed === 3 ) {

		const wx = r.seed === 3 ? - 0.67 : 0.82, wz = r.seed === 3 ? 0.74 : 0.57;
		let nx = 1.25 * ( c * wx + s * wz ), nz = - s * wx + c * wz;
		const length = Math.hypot( nx, nz );
		nx /= length; nz /= length;
		const ny = r.seed === 3 ? 0.26 : - 0.08, nr = Math.sqrt( 1 - ny * ny );
		planes.push( nx * nr, ny, nz * nr, r.seed === 3 ? 0.60 : 0.65 );
		if ( r.seed === 3 ) planes.push( - nz * 0.64, 0.768, nx * 0.64, 0.73 );

	}
	const vals = new Float64Array( planes.length / 4 );
	const k = Math.min( r.s, r.sy );
	const bevel = r.seed === 2 || r.seed === 3 ? 0.016 : 0.035 + rng() * 0.018;
	// The buried half stretches to the seabed so a shallow exposed stone never floats.
	const syLow = Math.max( r.sy, ( r.y - r.floor + 0.3 ) / 0.72 );
	const rockSDF: SDF = ( x, y, z ) => {

		const lx = x - r.x, lz = z - r.z, ly = y - r.y;
		const qx = ( c * lx + s * lz ) / ( r.s * 1.25 ), qz = ( - s * lx + c * lz ) / r.s;
		const qy = ly / ( ly < 0 ? syLow : r.sy );
		const rad = Math.sqrt( qx * qx + qy * qy + qz * qz );
		if ( rad > 2.2 ) return ( rad - 1.9 ) * k;
		for ( let i = 0; i < vals.length; i ++ ) {

			const p = i * 4;
			vals[ i ] = qx * planes[ p ] + qy * planes[ p + 1 ] + qz * planes[ p + 2 ] - planes[ p + 3 ];

		}
		let d = softMax( vals, vals.length, bevel );
		d += noise3( qx * 1.7 + r.seed * 1.37, qy * 1.4, qz * 1.7 ) * 0.018;
		return Math.max( d * k, r.floor - 0.4 - y );

	};

	rockSDF.tint = ( x, y, z ) => Math.min( 1, Math.max( 0, ( r.seed * 0.618034 ) % 1 + noise3( x * 0.5, y * 0.4, z * 0.5 ) * 0.06 ) );
	return rockSDF;

}

// ------------------------------------------------------------------ seabed

// height of the sea floor (m, negative): a shallow lagoon around the island whose floor shows
// through the water, dropping off within ~20 m into deep, even-coloured water; gentle sand waves,
// mounds around the stacks
export function makeSeabed( fp: Footprint, stacks: Stack[] ): HeightFn {

	return function seabedHeight( x: number, z: number ) {

		const d = fp.dist( x, z );
		const dd = Math.max( d, 0 );
		// a shallow lagoon: sand visible everywhere near the island, the reef edge drops off far out
		let h = - 1.6
			- 1.2 * smoothstep( 0, 5, dd )
			- 3.6 * smoothstep( 6, 26, dd )
			- 6.0 * smoothstep( 40, 110, dd );
		// broad undulation and a sandbar or two
		h += fbm2( x * 0.035 + 3.0, z * 0.035, 4 ) * 1.2 * smoothstep( 2, 14, dd );
		h += Math.max( 0, noise3( x * 0.06, 9.1, z * 0.06 ) ) * 1.4 * smoothstep( 6, 18, dd ) * ( 1 - smoothstep( 30, 50, dd ) );
		// scour right at the foot of the cliffs
		h -= 0.6 * ( 1 - smoothstep( 0, 2.5, dd ) );
		for ( const s of stacks ) {

			const r = Math.hypot( x - s.x, z - s.z );
			h += 1.3 * Math.exp( - r * r / ( 2 * ( s.r * 2.5 ) ** 2 ) );

		}

		return h;

	};

}
