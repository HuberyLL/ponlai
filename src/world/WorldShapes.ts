// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block, the sea stacks, the scattered
// rocks, the seabed height and the shoreline distance at sea level.

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, fbm2, voronoiEdge2, cellValue3, hash2i, hash3i, mulberry32, smoothstep, smax, smin, type Rng } from './noise.ts';
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


// Stylised cliffs: the wall is cut into columns (Voronoi cells over xz, ~2.2 m) and every column into
// blocks (beds ~3.6 m tall, staggered per column). Each block's face is two or three planes of its
// own (yawed, leaning, proud or set back) meeting in ridges, so the light breaks into big flat
// facets the way hand-sculpted rock does; every joint is a deep groove of varying width with a
// rounded arris either side. Under water the blocks step out into a ragged foot.

const COL = 2.2; // column spacing (m)
const BED = 3.6; // mean block height (m)
const BEVEL = 0.17; // mean width of the rounded arris either side of a joint (m)
const JOINT = 0.42; // mean depth of a joint behind the nominal wall (m)

interface Block { planes: number[]; np: number; yMid: number; tint: number }
interface Column {
	ci: number; cj: number; sx: number; sz: number; d2s: number; gx: number; gz: number;
	bedH: number; phase: number; drop: number; blocks: Map<number, Block>;
}

export function makeIslandSDF( fp: Footprint ): SDF {

	const top = ( x: number, z: number ) => ISLAND_TOP + noise3( x * 0.18, 4.1, z * 0.18 ) * 0.12 + noise3( x * 0.7, 1.3, z * 0.7 ) * 0.04;
	const cells = new Map<number, Column>();
	const ve = { ci: 0, cj: 0, sx: 0, sy: 0, edge: 0 };
	const vals = new Float64Array( 4 );

	function cellOf( ci: number, cj: number, sx: number, sz: number ): Column {

		const key = ( ci + 512 ) * 1024 + ( cj + 512 );
		let c = cells.get( key );
		if ( c ) return c;
		const e = 0.05;
		const gx = fp.dist( sx + e, sz ) - fp.dist( sx - e, sz ), gz = fp.dist( sx, sz + e ) - fp.dist( sx, sz - e );
		const gl = Math.hypot( gx, gz ) || 1;
		c = {
			ci, cj, sx, sz, d2s: fp.dist( sx, sz ), gx: gx / gl, gz: gz / gl,
			bedH: BED * ( 0.75 + 0.6 * hash2i( ci - 5, cj + 9 ) ),
			phase: hash2i( ci + 71, cj - 13 ),
			// the rim of some columns is broken lower than the turf
			drop: Math.max( 0, hash2i( ci * 3 + 1, cj * 5 - 2 ) - 0.5 ) * 0.5,
			blocks: new Map(),
		};
		cells.set( key, c );
		return c;

	}

	function blockOf( c: Column, k: number ): Block {

		let b = c.blocks.get( k );
		if ( b ) return b;
		const h = ( n: number ) => hash3i( c.ci, c.cj, k * 17 + n );
		const yMid = ISLAND_BOTTOM + ( k + 0.5 - c.phase ) * c.bedH;
		const yaw0 = ( h( 1 ) - 0.5 ) * 0.5, lean0 = ( h( 2 ) - 0.5 ) * 0.2;
		const off0 = ( h( 3 ) - 0.6 ) * 0.45 - smoothstep( - 0.6, - 3.2, yMid ) * 0.55;
		const np = h( 4 ) < 0.45 ? 3 : 2;
		const planes = [];
		for ( let i = 0; i < np; i ++ ) {

			const yaw = yaw0 + ( h( 5 + i * 3 ) - 0.5 ) * 1.0;
			const cs = Math.cos( yaw ), sn = Math.sin( yaw );
			planes.push(
				c.gx * cs - c.gz * sn, c.gx * sn + c.gz * cs,
				lean0 + ( h( 6 + i * 3 ) - 0.5 ) * 0.45,
				off0 - h( 7 + i * 3 ) * 0.16,
			);

		}

		b = { planes, np, yMid, tint: h( 16 ) };
		c.blocks.set( k, b );
		return b;

	}

	// per (x, z) work, cached: the field is filled column by column
	let cx = NaN, cz = NaN, cD2 = 0, cTop = 0, cEdge = 0;
	let cCell: Column | null = null;
	function column( x: number, z: number ): void {

		if ( x === cx && z === cz ) return;
		cx = x; cz = z;
		cD2 = fp.dist( x, z );
		cTop = top( x, z );
		if ( cD2 > 2.6 || cD2 < - 2.6 ) { cCell = null; return; }
		voronoiEdge2( x / COL, z / COL, ve );
		cCell = cellOf( ve.ci, ve.cj, ve.sx * COL, ve.sy * COL );
		cEdge = ve.edge * COL;

	}

	let eH = 0;
	function blockAt( y: number ): Block {

		const c = cCell!;
		const ly = ( y - ISLAND_BOTTOM ) / c.bedH + c.phase;
		const k = Math.floor( ly );
		const fr = ly - k;
		eH = Math.min( fr, 1 - fr ) * c.bedH;
		return blockOf( c, k );

	}

	const islandSDF: SDF = ( x, y, z ) => {

		column( x, z );
		const dBot = ISLAND_BOTTOM - y;
		if ( ! cCell ) return Math.max( cD2 > 0 ? cD2 - 2.1 : cD2 + 1.5, y - cTop, dBot );

		const c = cCell;
		const b = blockAt( y );
		const lx = x - c.sx, lz = z - c.sz, ly = y - b.yMid;
		for ( let i = 0; i < b.np; i ++ ) {

			const P = b.planes;
			vals[ i ] = lx * P[ i * 4 ] + lz * P[ i * 4 + 1 ] + ly * P[ i * 4 + 2 ] + P[ i * 4 + 3 ];

		}

		let face = c.d2s + softMax( vals, b.np, 0.04 ) + noise3( x * 0.55, y * 0.45, z * 0.55 ) * 0.07;
		// a facet may wander from the footprint, but never past the joints nor deep into the wall
		const jn = noise3( x * 1.1 + 7.0, y * 0.8, z * 1.1 );
		const joint = JOINT * ( 1 + 0.35 * jn );
		face = smax( smin( face, cD2 + joint - 0.12, 0.12 ), cD2 - 0.8, 0.12 );
		// arrises: the bevel's width jumps from chip to chip, so the edges look broken, not rounded
		const e = Math.min( cEdge, eH );
		let bw = BEVEL * ( 1 + 0.45 * jn );
		if ( e < bw * 2.2 ) bw *= 0.3 + 1.4 * cellValue3( x * 2.4, y * 2.4, z * 2.4 );
		bw = Math.max( bw, 0.15 ); // never a slot narrower than the mesher can resolve
		const g = smoothstep( 0, bw, e );
		let d = cD2 + joint + ( face - cD2 - joint ) * g;
		// the rim: rounded, broken lower on some columns
		const rim = cTop - c.drop * g * smoothstep( - 1.4, 0.2, cD2 );
		d = smax( d, y - rim, 0.2 );
		return Math.max( d, dBot );

	};

	islandSDF.tint = ( x, y, z ) => {

		column( x, z );
		return cCell ? blockAt( y ).tint : 0.5;

	};

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

// hewn, weathered pillars: drums of 6-8 sided prisms stacked on each other, each drum turned and
// shifted a little, tapering upward, split by the odd vertical crack, a flat tilted top
interface Drum {
	yMid: number; N: number; planes: number[]; cracks: number[];
	cx: number; cz: number; lx: number; lz: number; taper: number; inR: number; tint: number;
}

export function makeStackSDF( s: Stack, seed: number ): SDF {

	const rng = mulberry32( 1000 + seed * 77 );
	const joints: number[] = [], jtilt: number[] = [];
	let yj = - 0.9 - rng() * 0.9;
	for ( ;; ) {

		joints.push( yj );
		jtilt.push( ( rng() - 0.5 ) * 0.3, ( rng() - 0.5 ) * 0.3 );
		yj += 1.45 + rng() * 1.05;
		if ( yj > s.h - 1.0 ) break;

	}

	const blocks: Drum[] = [];
	for ( let k = 0; k <= joints.length; k ++ ) {

		const y0 = k === 0 ? STACK_FOOT : joints[ k - 1 ];
		const y1 = k === joints.length ? s.h : joints[ k ];
		const yMid = ( y0 + y1 ) / 2;
		const N = 5 + Math.floor( rng() * 3 );
		const rot = rng() * Math.PI * 2;
		const R = s.r * ( 1 - 0.1 * Math.max( yMid, 0 ) / s.h ) * ( 0.94 + rng() * 0.12 ) * ( k === 0 ? 1.12 : 1 );
		const planes: number[] = [];
		for ( let i = 0; i < N; i ++ ) {

			// faces of uneven width and depth, each leaning in or out a little
			const a = rot + ( i + ( rng() - 0.5 ) * 0.6 ) * Math.PI * 2 / N;
			const lean = ( rng() - 0.5 ) * 0.28;
			planes.push( Math.cos( a ), Math.sin( a ), R * ( 0.8 + rng() * 0.32 ), lean );

		}

		const cracks: number[] = [];
		const nc = rng() < 0.7 ? 1 + Math.floor( rng() * 2 ) : 0;
		for ( let i = 0; i < nc; i ++ ) {

			const a = rng() * Math.PI;
			cracks.push( Math.cos( a ), Math.sin( a ), ( rng() - 0.5 ) * R * 0.6 );

		}

		blocks.push( {
			yMid, N, planes, cracks,
			cx: ( rng() - 0.5 ) * 0.22 * s.r, cz: ( rng() - 0.5 ) * 0.22 * s.r,
			lx: ( rng() - 0.5 ) * 0.1, lz: ( rng() - 0.5 ) * 0.1,
			taper: 0.03 + rng() * 0.03,
			inR: Math.min( ...planes.filter( ( _, i ) => i % 4 === 2 ) ),
			tint: rng(),
		} );

	}

	// the recessed neck at each joint: inside both drums that meet there
	const necks = joints.map( ( _, k ) => {

		const a = blocks[ k ], b = blocks[ k + 1 ];
		return Math.min( a.inR - Math.hypot( a.cx, a.cz ), b.inR - Math.hypot( b.cx, b.cz ) ) * 0.96 - 0.1;

	} );
	const tilt = [ ( rng() - 0.5 ) * 0.22, ( rng() - 0.5 ) * 0.22 ];
	const vals = new Float64Array( 10 );
	const W = 0.1;

	// the joints are not level: each is a plane of its own
	const jointY = ( k: number, lx: number, lz: number ) => joints[ k ] + jtilt[ k * 2 ] * lx + jtilt[ k * 2 + 1 ] * lz;
	const blockIndex = ( y: number, lx: number, lz: number ) => {

		let k = 0;
		while ( k < joints.length && y > jointY( k, lx, lz ) ) k ++;
		return k;

	};

	const stackSDF: SDF = ( x, y, z ) => {

		const lx = x - s.x, lz = z - s.z;
		const rr = Math.hypot( lx, lz );
		if ( rr > s.r * 1.5 + 0.8 ) return rr - s.r * 1.45;

		const k = blockIndex( y, lx, lz );
		const b = blocks[ k ];
		const qx = lx - b.cx - b.lx * ( y - b.yMid ), qz = lz - b.cz - b.lz * ( y - b.yMid );
		const taper = 1 - b.taper * ( y - b.yMid );
		const P = b.planes, dy = y - b.yMid;
		for ( let i = 0; i < b.N; i ++ ) vals[ i ] = qx * P[ i * 4 ] + qz * P[ i * 4 + 1 ] + dy * P[ i * 4 + 3 ] - P[ i * 4 + 2 ] * taper;
		let d = softMax( vals, b.N, 0.035 );
		// chipped edges and a few deeper bites out of the faces
		const chip = cellValue3( x * 2.6 + seed, y * 2.6, z * 2.6 );
		d += Math.max( 0, chip - 0.72 ) * 0.35;
		for ( let i = 0; i < b.cracks.length; i += 3 ) {

			const u = Math.abs( qx * b.cracks[ i ] + qz * b.cracks[ i + 1 ] - b.cracks[ i + 2 ] );
			d += 0.09 * ( 1 - smoothstep( 0.0, 0.07, u ) );

		}

		// joints: both drums ease into the same recessed neck
		const below = k > 0 ? y - jointY( k - 1, lx, lz ) : 1e9, above = k < joints.length ? jointY( k, lx, lz ) - y : 1e9;
		if ( Math.min( below, above ) < W ) {

			const neck = below < above ? necks[ k - 1 ] : necks[ k ];
			d = rr - neck + ( d - rr + neck ) * smoothstep( 0, W, Math.min( below, above ) );

		}

		const topY = s.h + lx * tilt[ 0 ] + lz * tilt[ 1 ] + noise3( lx * 0.9 + seed, 3.3, lz * 0.9 ) * 0.06;
		d = smax( d, y - topY, 0.16 );
		return Math.max( d, STACK_FOOT - y );

	};

	stackSDF.tint = ( x: number, y: number, z: number ) => blocks[ blockIndex( y, x - s.x, z - s.z ) ].tint;
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

	const poly = ( P: number[], qx: number, qy: number, qz: number ) => {

		const n = P.length / 4;
		for ( let i = 0; i < n; i ++ ) vals[ i ] = qx * P[ i * 4 ] + qy * P[ i * 4 + 1 ] + qz * P[ i * 4 + 2 ] - P[ i * 4 + 3 ];
		return softMax( vals, n, 0.035 );

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
