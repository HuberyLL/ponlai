// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block, the sea stacks, the scattered
// rocks, the seabed height and the shoreline distance at sea level.

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, fbm2, hash3i, mulberry32, smoothstep, smax, smin, type Rng } from './noise.ts';
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

// A broken flake has an inclined floor and unequal, clipped shoulders. Keeping a broad
// interior plane avoids the repeated pyramidal dents that make a cliff look kneaded.
function spallDepth( u: number, v: number, cuts: number[], i: number ): number {

	const du = u - cuts[ i ];
	const dv = v - cuts[ i + 1 ] + du * cuts[ i + 7 ];
	const left = cuts[ i + 2 ], right = cuts[ i + 3 ];
	const lower = cuts[ i + 4 ], upper = cuts[ i + 5 ], depth = cuts[ i + 6 ];
	return Math.max( 0, Math.min(
		depth * ( 0.82 + du / ( left + right ) * cuts[ i + 8 ] + dv / ( lower + upper ) * 0.22 ),
		( du + left ) * 0.72, ( right - du ) * 1.1,
		( dv + lower ) * 0.85, ( upper - dv ) * 0.58,
		( upper * 0.92 - dv - du * 0.38 ) * 0.9,
	) );

}


// Linear interpolation over the six tetrahedra of each lattice cell produces continuous
// angular relief. Separate orientations at each scale avoid a visible grid of repeated faces.
function stoneRelief( x: number, y: number, z: number ): number {

	const ix = Math.floor( x ), iy = Math.floor( y ), iz = Math.floor( z );
	const fx = x - ix, fy = y - iy, fz = z - iz;
	const hi = fx >= fy ? ( fx >= fz ? 0 : 2 ) : ( fy >= fz ? 1 : 2 );
	const lo = fx <= fy ? ( fx <= fz ? 0 : 2 ) : ( fy <= fz ? 1 : 2 );
	const u = Math.max( fx, fy, fz ), w = Math.min( fx, fy, fz ), v = fx + fy + fz - u - w;
	const a = hash3i( ix, iy, iz );
	const b = hash3i( ix + ( hi === 0 ? 1 : 0 ), iy + ( hi === 1 ? 1 : 0 ), iz + ( hi === 2 ? 1 : 0 ) );
	const c = hash3i( ix + ( lo === 0 ? 0 : 1 ), iy + ( lo === 1 ? 0 : 1 ), iz + ( lo === 2 ? 0 : 1 ) );
	const d = hash3i( ix + 1, iy + 1, iz + 1 );
	return ( a * ( 1 - u ) + b * ( u - v ) + c * ( v - w ) + d * w ) * 2 - 1;

}

export function makeIslandSDF( fp: Footprint ): SDF {

	const top = ( x: number, z: number ) => ISLAND_TOP + noise3( x * 0.18, 4.1, z * 0.18 ) * 0.12 + noise3( x * 0.7, 1.3, z * 0.7 ) * 0.04;
	// Cache the footprint because the worker samples the entire height at each (x, z).
	let cx = NaN, cz = NaN, cD2 = 0, cTop = 0;
	function column( x: number, z: number ): void {

		if ( x === cx && z === cz ) return;
		cx = x; cz = z;
		cD2 = fp.dist( x, z );
		cTop = top( x, z );

	}

	const islandSDF: SDF = ( x, y, z ) => {

		column( x, z );
		const dBot = ISLAND_BOTTOM - y;
		if ( Math.abs( cD2 ) > 1 ) return Math.max( cD2, y - cTop, dBot );

		// One continuous rock skin follows the whole perimeter, without column joints or beds.
		// Broad cuts carry the form; weaker, differently oriented flakes break up their edges.
		const broad = stoneRelief( x * 0.34 + z * 0.24 + 8.3, y * 0.68 + x * 0.07 - z * 0.05 + 3.1,
			z * 0.36 - x * 0.23 + y * 0.04 - 6.8 );
		const flakes = stoneRelief( x * 0.41 - z * 0.92 + y * 0.13 - 3.7, y * 0.86 + x * 0.18 + z * 0.12 + 9.4,
			x * 0.91 + z * 0.38 - y * 0.17 + 2.6 );
		const detail = noise3( x * 2.1 + 3.8, y * 1.7, z * 2.1 ) * 0.012;
		// Only the higher flake peaks cut into the face, leaving broad shoulders between spalls.
		const spall = Math.max( 0, flakes - 0.12 ) * 0.24;
		let d = cD2 + broad * 0.34 + flakes * 0.10 + spall + detail;
		const edge = smoothstep( - 0.5, 0.1, cD2 );
		const chip = Math.max( 0, stoneRelief( x * 1.3 + 7.1, 4.3, z * 1.3 - 2.7 ) - 0.15 ) * 0.10;
		const rim = cTop - chip * edge;
		d = smax( d, y - rim, 0.09 );
		return Math.max( d, dBot );

	};

	// Slow continuous tint variation cannot reintroduce boundaries between generated pieces.
	islandSDF.tint = ( x, y, z ) => 0.5 + noise3( x * 0.2 + 9.3, y * 0.16, z * 0.2 ) * 0.3;
	return islandSDF;

}

// ------------------------------------------------------------------ sea stacks

export function makeStacks(): Stack[] {

	return [
		{ x: - 21.5, z: - 9.5, r: 1.35, h: 5.9 },
		{ x: - 18.5, z: 11.5, r: 1.5, h: 4.4 },
		{ x: 19.5, z: - 13.5, r: 1.2, h: 6.6 },
		{ x: 23.0, z: 3.5, r: 1.35, h: 5.0 },
		{ x: 7.5, z: 17.0, r: 1.05, h: 3.4 },
		{ x: - 5.5, z: - 17.5, r: 1.15, h: 4.6 },
		{ x: 12.5, z: - 18.0, r: 0.8, h: 2.6 },
	];

}

const STACK_FOOT = - 6.8;

// Hewn monoliths retain the same cleavage directions. Each face folds and sheds chips at
// independently staggered heights; no complete horizontal ring divides a pillar into drums.
export function makeStackSDF( s: Stack, seed: number ): SDF {

	const rng = mulberry32( 1000 + seed * 77 );
	const N = 7 + Math.floor( rng() * 2 );
	const rot = rng() * Math.PI * 2;
	const planes: number[] = [];
	const spalls: number[][] = [];
	for ( let i = 0; i < N; i ++ ) {

		const a = rot + ( i + ( rng() - 0.5 ) * 0.3 ) * Math.PI * 2 / N;
		planes.push( Math.cos( a ), Math.sin( a ), s.r * ( 0.87 + rng() * 0.19 ), ( rng() - 0.5 ) * 0.065,
			1.1 + rng() * 1.3, rng() * 3 );
		const faceChips: number[] = [];
		for ( let j = 0; j < 3; j ++ ) {

			// Consume the original six values so changing a flake cannot reshuffle the pillar.
			const u = rng(), height = rng(), width = rng(), length = rng(), depth = rng(), skew = rng();
			// The upper flake crosses the cap, so the silhouette carries the break as well.
			const v = j === 2 ? s.h - 0.05 + height * 0.18 : ( j + height ) / 2.6 * s.h;
			faceChips.push( ( u - 0.5 ) * s.r * 1.45, v,
				0.26 + width * 0.5, 0.22 + hash3i( seed, i, j + 101 ) * 0.45,
				0.35 + length * 0.65, 0.22 + hash3i( seed, i, j + 201 ) * 0.4,
				0.18 + depth * 0.2, ( skew - 0.5 ) * 0.85, ( hash3i( seed, i, j + 301 ) - 0.5 ) * 0.8 );

		}
		spalls.push( faceChips );

	}

	const cracks: number[] = [];
	for ( let i = 0; i < 2; i ++ ) {

		const a = rot + ( 0.2 + i * 0.65 ) * Math.PI;
		cracks.push( Math.cos( a ), Math.sin( a ), ( rng() - 0.5 ) * s.r * 0.8, ( rng() - 0.5 ) * 0.045 );

	}

	const beds: number[] = [];
	let yBed = - 0.6 + rng() * 0.5;
	while ( yBed < s.h - 0.45 ) {

		beds.push( yBed, ( rng() - 0.5 ) * 0.2, ( rng() - 0.5 ) * 0.2, rng() * Math.PI * 2 );
		yBed += 1.3 + rng() * 1.4;

	}

	const tilt = [ ( rng() - 0.5 ) * 0.18, ( rng() - 0.5 ) * 0.18 ];
	const tint = rng();
	const vals = new Float64Array( N );
	const stackSDF: SDF = ( x, y, z ) => {

		const lx = x - s.x, lz = z - s.z;
		const rr = Math.hypot( lx, lz );
		if ( rr > s.r * 1.5 + 0.8 ) return rr - s.r * 1.45;

		const t = Math.max( 0, Math.min( 1, y / s.h ) );
		const foot = smoothstep( - 0.3, - 3.2, y ) * s.r * 0.14;
		for ( let i = 0; i < N; i ++ ) {

			const k = i * 6;
			// Linear segments make broad tilted faces. Independent breaks on neighbouring
			// planes create irregular corners rather than a single extruded polygon.
			const by = y / planes[ k + 4 ] + planes[ k + 5 ], bi = Math.floor( by ), bf = by - bi;
			const ra = hash3i( seed, i + 71, bi ), rb = hash3i( seed, i + 71, bi + 1 );
			const relief = ( ra + ( rb - ra ) * bf - 0.5 ) * s.r * 0.39;
			const u = - lx * planes[ k + 1 ] + lz * planes[ k ];
			let cut = 0;
			const chips = spalls[ i ];
			for ( let j = 0; j < chips.length; j += 9 ) {

				cut += spallDepth( u, y, chips, j );

			}
			vals[ i ] = lx * planes[ k ] + lz * planes[ k + 1 ] + y * planes[ k + 3 ]
				- planes[ k + 2 ] * ( 1 - t * 0.09 ) - foot + relief + cut;

		}

		let d = softMax( vals, N, 0.018 );
		d += noise3( lx * 1.6 + seed, y * 0.75, lz * 1.6 ) * 0.028;
		for ( let i = 0; i < cracks.length; i += 4 ) {

			const u = Math.abs( lx * cracks[ i ] + lz * cracks[ i + 1 ] - cracks[ i + 2 ] + y * cracks[ i + 3 ]
				+ noise3( lx * 1.8, y * 0.65 + seed, lz * 1.8 ) * 0.035 );
			d += 0.135 * ( 1 - smoothstep( 0.02, 0.13, u ) );

		}

		for ( let i = 0; i < beds.length; i += 4 ) {

			const e = Math.abs( y - beds[ i ] - lx * beds[ i + 1 ] - lz * beds[ i + 2 ] );
			// A bed erodes from one exposed side, never into a dark ring around the pillar.
			const side = smoothstep( - 0.1, 0.65, ( lx * Math.cos( beds[ i + 3 ] ) + lz * Math.sin( beds[ i + 3 ] ) ) / s.r );
			d += ( 1 - smoothstep( 0.015, 0.14, e ) ) * side * 0.15;

		}

		const topY = s.h + lx * tilt[ 0 ] + lz * tilt[ 1 ] + noise3( lx * 1.4 + seed, 3.3, lz * 1.4 ) * 0.12;
		d = smax( d, y - topY, 0.08 );
		return Math.max( d, STACK_FOOT - y );

	};

	stackSDF.tint = ( x, y, z ) => Math.min( 1, Math.max( 0, tint + noise3( x * 0.7, y * 0.12, z * 0.7 ) * 0.12 ) );
	return stackSDF;

}

// ------------------------------------------------------------------ scattered rocks

export function makeRocks( fp: Footprint, stacks: Stack[], seabedHeight: HeightFn ): Rock[] {

	const rng = mulberry32( 77 );
	const rocks: Rock[] = [];
	let tries = 0;
	while ( rocks.length < 46 && tries ++ < 4000 ) {

		const a = rng() * Math.PI * 2;
		const R = 15 + Math.pow( rng(), 1.4 ) * 26;
		const x = Math.cos( a ) * R * 1.15, z = Math.sin( a ) * R;
		const d = fp.dist( x, z );
		if ( d < 0.4 || d > 22 ) continue;
		// mostly near the cliffs and around the stacks
		const nearStack = stacks.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < 5 );
		if ( d > 7 && ! nearStack && rng() < 0.6 ) continue;
		const size = 0.35 + Math.pow( rng(), 2.2 ) * 1.6 + ( d < 2.5 ? 0.4 : 0 );
		if ( rocks.some( ( r ) => Math.hypot( r.x - x, r.z - z ) < ( r.s + size ) * 0.9 ) ) continue;
		if ( stacks.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < s.r + size + 0.2 ) ) continue;
		// most sit on the seabed below the surface; a few big ones break it
		const emerge = size > 0.9 && rng() < 0.45;
		const sz = emerge ? size * 1.35 : size;
		const sy = sz * ( emerge ? 0.6 + rng() * 0.45 : 0.45 + rng() * 0.35 );
		const floor = seabedHeight( x, z );
		rocks.push( {
			x, z, s: sz, sy,
			y: emerge ? - sz * 0.1 : floor + sy * ( 0.25 + rng() * 0.3 ),
			floor,
			rot: rng() * Math.PI,
			seed: rocks.length + 1,
		} );

	}

	return rocks;

}

// a faceted boulder: a convex polyhedron (planes from a jittered Fibonacci sphere, a flat bed
// underneath) with softly rounded arrises; some get a second, smaller chunk fused to one side
function polyhedron( rng: Rng, K: number ): number[] {

	const planes: number[] = [];
	const spin = rng() * Math.PI * 2;
	// the whole set tipped over a random horizontal axis, so no facet lies flat on top
	const ta = rng() * Math.PI * 2, tilt = 0.25 + rng() * 0.4;
	const kx = Math.cos( ta ), kz = Math.sin( ta ), ct = Math.cos( tilt ), st = Math.sin( tilt );
	for ( let i = 0; i < K; i ++ ) {

		const yy = 1 - ( i + 0.5 ) / K * 2;
		const rad = Math.sqrt( 1 - yy * yy );
		const phi = spin + i * 2.39996 + ( rng() - 0.5 ) * 0.8;
		let nx = Math.cos( phi ) * rad + ( rng() - 0.5 ) * 0.5;
		let ny = yy * 1.1 + ( rng() - 0.5 ) * 0.5;
		let nz = Math.sin( phi ) * rad + ( rng() - 0.5 ) * 0.5;
		const l = Math.hypot( nx, ny, nz );
		nx /= l; ny /= l; nz /= l;
		// Rodrigues: rotate n about k = ( kx, 0, kz ) by tilt
		const kd = kx * nx + kz * nz;
		const cx = - kz * ny, cy = kz * nx - kx * nz, cz = kx * ny; // k x n
		const rx = nx * ct + cx * st + kx * kd * ( 1 - ct );
		const ry = ny * ct + cy * st;
		const rz = nz * ct + cz * st + kz * kd * ( 1 - ct );
		planes.push( rx, ry, rz, 0.68 + rng() * 0.45 );

	}

	planes.push( 0, - 1, 0, 0.72 );
	return planes;

}

export function makeRockSDF( r: Rock ): SDF {

	const rng = mulberry32( r.seed * 7919 + 13 );
	const c = Math.cos( r.rot ), s = Math.sin( r.rot );
	const A = polyhedron( rng, 8 + Math.floor( rng() * 4 ) );
	const twin = rng() < 0.4;
	const B = twin ? polyhedron( rng, 7 + Math.floor( rng() * 3 ) ) : null;
	const ba = rng() * Math.PI * 2;
	const bo = [ Math.cos( ba ) * 0.75, - 0.15, Math.sin( ba ) * 0.75 ];
	const vals = new Float64Array( 16 );
	const k = Math.min( r.s, r.sy );
	// Oblique breaks clip two shoulders instead of rounding every corner equally.
	for ( let i = 0; i < 2; i ++ ) {

		const a = ba + i * 2.1 + rng() * 0.7;
		const ny = 0.4 + rng() * 0.36, nr = Math.sqrt( 1 - ny * ny );
		A.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.73 + rng() * 0.16 );

	}
	const exposed: number[] = [];
	for ( let i = 0; i < A.length / 4; i ++ ) if ( A[ i * 4 + 1 ] > - 0.25 ) exposed.push( i );
	const scars: { face: number; tangent: number[]; bitangent: number[]; cut: number[] }[] = [];
	for ( let i = 0; i < 3; i ++ ) {

		const face = exposed[ Math.floor( rng() * exposed.length ) ];
		const nx = A[ face * 4 ], ny = A[ face * 4 + 1 ], nz = A[ face * 4 + 2 ];
		const tl = Math.hypot( nx, nz );
		const tx = tl > 0.001 ? - nz / tl : 1, tz = tl > 0.001 ? nx / tl : 0;
		const bx = ny * tz, by = nz * tx - nx * tz, bz = - ny * tx;
		scars.push( {
			face, tangent: [ tx, 0, tz ], bitangent: [ bx, by, bz ],
			// Off-centre cuts often reach an outer edge, creating a chipped silhouette.
			cut: [ ( rng() < 0.5 ? - 1 : 1 ) * ( 0.28 + rng() * 0.34 ), ( rng() - 0.5 ) * 0.9,
				0.25 + rng() * 0.28, 0.18 + rng() * 0.32, 0.2 + rng() * 0.35, 0.2 + rng() * 0.3,
				0.16 + rng() * 0.17, ( rng() - 0.5 ) * 0.75, ( rng() - 0.5 ) * 0.7 ],
		} );

	}
	// Cleavage terraces divide a large boulder into a few substantial planes. Unlike noise
	// or isolated dents, each shoulder crosses the surface and reads at the scene camera.
	const terraces: number[] = [];
	for ( let i = 0; i < 2; i ++ ) {

		const angle = ba + i * 1.35 + ( rng() - 0.5 ) * 0.55;
		terraces.push( Math.cos( angle ), Math.sin( angle ), ( rng() - 0.5 ) * 0.65,
			( rng() - 0.5 ) * 0.75, 0.1 + rng() * 0.12, ( 0.13 + rng() * 0.1 ) * ( i === 0 ? 1 : 0.65 ) );

	}

	const poly = ( P: number[], qx: number, qy: number, qz: number ) => {

		const n = P.length / 4;
		for ( let i = 0; i < n; i ++ ) vals[ i ] = qx * P[ i * 4 ] + qy * P[ i * 4 + 1 ] + qz * P[ i * 4 + 2 ] - P[ i * 4 + 3 ];
		if ( P === A ) for ( const scar of scars ) {

			const t = scar.tangent, b = scar.bitangent;
			vals[ scar.face ] += spallDepth( qx * t[ 0 ] + qz * t[ 2 ], qx * b[ 0 ] + qy * b[ 1 ] + qz * b[ 2 ], scar.cut, 0 );

		}
		return softMax( vals, n, 0.018 );

	};

	// below its middle the rock stretches down to the sea floor (no boulder floats)
	const syLow = Math.max( r.sy, ( r.y - r.floor + 0.3 ) / 0.72 );
	const rockSDF: SDF = ( x, y, z ) => {

		const lx = x - r.x, lz = z - r.z, ly = y - r.y;
		const qx = ( c * lx + s * lz ) / ( r.s * 1.25 ), qz = ( - s * lx + c * lz ) / r.s, qy = ly / ( ly < 0 ? syLow : r.sy );
		const rad = Math.sqrt( qx * qx + qy * qy + qz * qz );
		if ( rad > 2.2 ) return ( rad - 1.9 ) * k;
		let d = poly( A, qx, qy, qz );
		if ( B ) d = smin( d, poly( B, ( qx - bo[ 0 ] ) / 0.62, ( qy - bo[ 1 ] ) / 0.62, ( qz - bo[ 2 ] ) / 0.62 ) * 0.62, 0.08 );
		for ( let i = 0; i < terraces.length; i += 6 ) {

			const across = qx * terraces[ i ] + qz * terraces[ i + 1 ] + qy * terraces[ i + 2 ] - terraces[ i + 3 ];
			d += ( Math.max( 0, Math.min( 1, across / terraces[ i + 4 ] + 0.5 ) ) - 0.35 ) * terraces[ i + 5 ];

		}
		// sediment-buried bottom
		return Math.max( d * k, r.floor - 0.4 - y );

	};

	rockSDF.tint = () => ( r.seed * 0.618034 ) % 1;
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
