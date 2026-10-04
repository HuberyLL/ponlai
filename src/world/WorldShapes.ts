// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block, the submerged
// rocks, the seabed height and the shoreline distance at sea level.

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, fbm2, hash3i, mulberry32, smoothstep, smax, type Rng } from './noise.ts';
import type { SDF, Rock } from './types.ts';

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

// ------------------------------------------------------------------ submerged rocks

interface DebrisPatch {
	x: number; z: number; major: number; minor: number; rot: number; count: number; outer: boolean;
}

// Patchy hard bottom beside sandy sediment is inspired by USGS coastal seafloor observations:
// https://pubs.usgs.gov/sir/2019/5073/ . This is an art-directed distribution, not sediment physics.
function debrisPatches( fp: Footprint, rng: Rng ): DebrisPatch[] {

	const patches: DebrisPatch[] = [];
	const b = layoutBounds();
	let tries = 0;
	while ( patches.length < 11 && tries ++ < 10000 ) {

		const outer = patches.length >= 8;
		const pad = outer ? 25 : 10;
		const x = b.x0 - pad + rng() * ( b.x1 - b.x0 + pad * 2 );
		const z = b.z0 - pad + rng() * ( b.z1 - b.z0 + pad * 2 );
		const d = fp.dist( x, z );
		if ( d < ( outer ? 9 : 1.6 ) || d > ( outer ? 24 : 6.5 ) ) continue;
		if ( patches.some( ( p ) => Math.hypot( p.x - x, p.z - z ) < ( outer ? 8 : 5.2 ) ) ) continue;
		const e = 0.2;
		const nx = fp.dist( x + e, z ) - fp.dist( x - e, z );
		const nz = fp.dist( x, z + e ) - fp.dist( x, z - e );
		const rot = Math.atan2( - nx, nz ) + ( rng() - 0.5 ) * 0.9;
		patches.push( {
			x, z, rot, outer,
			major: ( outer ? 3.0 : 2.5 ) + rng() * 2.8,
			minor: ( outer ? 1.4 : 1.1 ) + rng() * 1.7,
			count: outer ? 9 + Math.floor( rng() * 4 ) : 17 + Math.floor( rng() * 6 ),
		} );

	}
	return patches;

}

function rockAxes( seed: number, thickness: number ): [ number, number ] {

	const slab = thickness < 0.40;
	return [ 1.03 + hash3i( seed, 13, 41 ) * 0.27,
		( slab ? 0.46 : 0.66 ) + hash3i( seed, 29, 83 ) * ( slab ? 0.29 : 0.32 ) ];

}

// Directional extent admits small companions along an elongated slab's narrow side. A single
// large exclusion circle around every stone would sterilise the interiors of the debris patches.
function rockExtent( r: Rock, ux: number, uz: number ): number {

	const [ ax, az ] = rockAxes( r.seed, r.sy / r.s );
	const c = Math.cos( r.rot ), s = Math.sin( r.rot );
	const dx = ( c * ux + s * uz ) / ( r.s * ax ), dz = ( - s * ux + c * uz ) / ( r.s * az );
	return 0.94 / Math.hypot( dx, dz );

}

const ROCK_LIMIT = 193;

export function makeRocks( fp: Footprint, seabedHeight: HeightFn ): Rock[] {

	const rng = mulberry32( 9177 );
	const patches = debrisPatches( fp, rng );
	const rocks: Rock[] = [];
	const place = ( x: number, z: number, size: number, thickness: number, rot: number ): boolean => {

		if ( rocks.length >= ROCK_LIMIT ) return false;
		const d = fp.dist( x, z );
		if ( d < Math.max( 0.36, size * 0.32 ) || d > 29 ) return false;
		const floor = seabedHeight( x, z );
		const slab = thickness < 0.40;
		const variation = rng();
		const burial = slab ? 0.08 + variation * 0.28 : 0.12 + variation * 0.28;
		// Larger fragments show most of their natural mass above the sediment; gravel remains
		// partly blanketed. Their buried lower faces still give each body a real floor contact.
		const lift = size > 0.9 ? 0.18 + variation * 0.14
			: size > 0.5 && hash3i( rocks.length + 1, 71, 19 ) < 0.65 ? 0.12 + variation * 0.14 : - burial;
		// Budget the whole crown below the wave trough, leaving every sloping face intact.
		// Neither emergence prevention nor sediment burial adds a horizontal clipping plane.
		const sy = Math.min( size * thickness, ( - 1.30 - floor ) / ( 1.6 + lift ) );
		if ( sy < 0.055 ) return false;
		const r: Rock = { x, z, s: size, sy, y: floor + sy * lift, floor, rot, seed: rocks.length + 1 };
		for ( const other of rocks ) {

			const dx = other.x - x, dz = other.z - z, distance = Math.hypot( dx, dz );
			if ( distance === 0 ) return false;
			if ( distance > ( other.s + size ) * 2 ) continue;
			const ux = dx / distance, uz = dz / distance;
			if ( distance < ( rockExtent( r, ux, uz ) + rockExtent( other, ux, uz ) ) * 0.98 ) return false;

		}
		rocks.push( r );
		return true;

	};

	for ( const [ patchIndex, patch ] of patches.entries() ) {

		const c = Math.cos( patch.rot ), s = Math.sin( patch.rot );
		const side = hash3i( patchIndex, 331, 7 ) < 0.5 ? - 1 : 1;
		const child = [
			[ side * patch.major * 0.68, patch.minor * ( hash3i( patchIndex, 11, 83 ) - 0.5 ) * 0.60 ],
			[ side * patch.major * 0.42, patch.minor * ( hash3i( patchIndex, 59, 113 ) < 0.5 ? - 0.58 : 0.58 ) ],
		];
		let placed = 0, tries = 0;
		while ( placed < patch.count && rocks.length < ROCK_LIMIT && tries ++ < patch.count * 90 ) {

			const angle = rng() * Math.PI * 2;
			// Square-root radius fills each patch's interior instead of tracing another ring.
			const radius = Math.sqrt( rng() ) * ( placed === 0 ? 0.28 : 1 );
			let u = Math.cos( angle ) * radius * patch.major, v = Math.sin( angle ) * radius * patch.minor;
			if ( placed >= ( patch.outer ? 3 : 5 ) && hash3i( patchIndex, tries, 173 ) < 0.93 ) {

				// One-sided child patches leave an exposed main face instead of arranging gravel
				// into a decorative halo around the main fragment's non-overlap boundary.
				const branch = hash3i( patchIndex, tries, 239 ) < 0.68 ? 0 : 1;
				u = child[ branch ][ 0 ] + Math.cos( angle ) * radius * patch.major * ( branch === 0 ? 0.34 : 0.28 );
				v = child[ branch ][ 1 ] + Math.sin( angle ) * radius * patch.minor * ( branch === 0 ? 0.36 : 0.30 );
				if ( u * u / ( patch.major * patch.major ) + v * v / ( patch.minor * patch.minor ) > 1.05 ) continue;

			}
			const x = patch.x + c * u - s * v, z = patch.z + s * u + c * v;
			let size: number, thickness: number;
			if ( placed === 0 ) {

				size = ( patch.outer ? 1.10 : 1.35 ) + rng() * 1.0;
				const mix = rng(), variation = rng();
				const block = patch.outer ? mix >= 0.56 : patchIndex % 2 === 0;
				thickness = block ? 0.65 + variation * 0.20 : 0.23 + variation * 0.15;

			} else if ( placed < ( patch.outer ? 3 : 5 ) ) {

				size = 0.44 + rng() * 0.74;
				thickness = 0.36 + rng() * 0.41;

			} else {

				size = 0.13 + Math.pow( rng(), 1.3 ) * 0.32;
				thickness = 0.34 + rng() * 0.38;

			}
			const rot = rng() < 0.65 ? patch.rot + ( rng() - 0.5 ) * 1.6 : rng() * Math.PI;
			if ( place( x, z, size, thickness, rot ) ) placed ++;

		}

	}

	// Isolated fragments are sparse on the outer shelf, leaving broad sand corridors between
	// the denser cliff debris and the few offshore patches.
	let isolated = 0, tries = 0;
	const b = layoutBounds(), pad = 25;
	while ( isolated < 10 && rocks.length < ROCK_LIMIT && tries ++ < 3000 ) {

		const x = b.x0 - pad + rng() * ( b.x1 - b.x0 + pad * 2 );
		const z = b.z0 - pad + rng() * ( b.z1 - b.z0 + pad * 2 );
		const d = fp.dist( x, z );
		if ( d < 9 || d > 26 ) continue;
		if ( patches.some( ( p ) => Math.hypot( p.x - x, p.z - z ) < p.major * 1.4 ) ) continue;
		if ( place( x, z, 0.19 + rng() * 0.50, 0.30 + rng() * 0.45, rng() * Math.PI ) ) isolated ++;

	}

	return rocks;

}

// A broad, uneven crown and unequal side planes describe the same intact fragment. Varying
// the proportions and rounding mixes long slabs, angular blocks and smaller weathered cobbles.
function polyhedron( rng: Rng, slab: boolean ): number[] {

	const planes: number[] = [];
	const spin = rng() * Math.PI * 2;
	const N = 6 + Math.floor( rng() * ( slab ? 2 : 4 ) );
	for ( let i = 0; i < N; i ++ ) {

		const a = spin + ( i + ( rng() - 0.5 ) * 0.30 ) * Math.PI * 2 / N;
		const ny = ( rng() - 0.5 ) * 0.13, nr = Math.sqrt( 1 - ny * ny );
		planes.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.73 + rng() * 0.28 );

	}
	const shoulders = slab ? 3 : 4;
	for ( let i = 0; i < shoulders; i ++ ) {

		const a = spin + ( i + 0.36 + ( rng() - 0.5 ) * 0.40 ) * Math.PI * 2 / shoulders;
		const ny = 0.42 + rng() * 0.38, nr = Math.sqrt( 1 - ny * ny );
		planes.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.70 + rng() * 0.24 );
		const by = - 0.58 - rng() * 0.20, br = Math.sqrt( 1 - by * by );
		planes.push( Math.cos( a + 0.4 ) * br, by, Math.sin( a + 0.4 ) * br, 0.67 + rng() * 0.23 );

	}
	const a = rng() * Math.PI * 2, nr = 0.10 + rng() * 0.17;
	planes.push( Math.cos( a ) * nr, Math.sqrt( 1 - nr * nr ), Math.sin( a ) * nr, 0.70 + rng() * 0.19 );
	// One offset sheared corner keeps a slab asymmetric while retaining a large top face.
	if ( slab || rng() < 0.55 ) {

		const a = spin + rng() * 2.5, ny = 0.16 + rng() * 0.36, nr = Math.sqrt( 1 - ny * ny );
		planes.push( Math.cos( a ) * nr, ny, Math.sin( a ) * nr, 0.57 + rng() * 0.21 );

	}
	planes.push( 0, - 1, 0, 0.72 );
	return planes;

}

export function makeRockSDF( r: Rock ): SDF {

	const rng = mulberry32( r.seed * 7919 + 13 );
	const c = Math.cos( r.rot ), s = Math.sin( r.rot );
	const [ ax, az ] = rockAxes( r.seed, r.sy / r.s );
	const slab = r.sy / r.s < 0.40;
	const planes = polyhedron( rng, slab );
	const vals = new Float64Array( planes.length / 4 );
	const k = Math.min( r.s, r.sy );
	const bevel = slab || r.s > 0.9 ? 0.016 + rng() * 0.019 : 0.032 + rng() * 0.037;
	const rockSDF: SDF = ( x, y, z ) => {

		const lx = x - r.x, lz = z - r.z, ly = y - r.y;
		const qx = ( c * lx + s * lz ) / ( r.s * ax ), qz = ( - s * lx + c * lz ) / ( r.s * az );
		const qy = ly / r.sy;
		const rad = Math.sqrt( qx * qx + qy * qy + qz * qz );
		if ( rad > 2.2 ) return ( rad - 1.9 ) * k;
		for ( let i = 0; i < vals.length; i ++ ) {

			const p = i * 4;
			vals[ i ] = qx * planes[ p ] + qy * planes[ p + 1 ] + qz * planes[ p + 2 ] - planes[ p + 3 ];

		}
		const d = softMax( vals, vals.length, bevel )
			+ noise3( qx * 1.8 + r.seed * 1.37, qy * 1.6, qz * 1.8 ) * 0.012;
		return d * k;

	};

	rockSDF.tint = ( x, y, z ) => Math.min( 1, Math.max( 0, ( r.seed * 0.618034 ) % 1 + noise3( x * 0.5, y * 0.4, z * 0.5 ) * 0.06 ) );
	return rockSDF;

}

// ------------------------------------------------------------------ seabed

// height of the sea floor (m, negative): a shallow lagoon around the island whose floor shows
// through the water, dropping off within ~20 m into deep, even-coloured water; gentle sand waves
export function makeSeabed( fp: Footprint ): HeightFn {

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

		return h;

	};

}
