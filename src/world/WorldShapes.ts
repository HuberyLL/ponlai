// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block, the submerged
// rocks and the land's distance (the sea floor is Bathymetry.ts). The island's shape is the grown
// land (IslandGrowth.ts).

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, hash3i, mulberry32, smoothstep, type Rng } from './noise.ts';
import { CliffWall } from './Cliff.ts';
import { GROWTH, type LandLattice } from './IslandGrowth.ts';
import type { SDF, Rock } from './types.ts';

// A box on the ground (m).
export interface Bounds { x0: number; z0: number; x1: number; z1: number }

const grow = ( b: Bounds, m: number ): Bounds => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

export interface Footprint {
	// the footprint's corners rounded, at 0.08 m over its window
	fine: Field2D;
	// the land lattice's own signed distance (0.25 m), over the whole lattice
	coarse: Field2D;
	// the land's box
	bounds: Bounds;
	dist( x: number, z: number ): number;
}

export type HeightFn = ( x: number, z: number ) => number;

export const ISLAND_TOP = 3.1;
export const ISLAND_BOTTOM = - 5.6;

// The farthest the generator reads the land (m): the footprint's distance is clamped to +-this, so
// whatever is made at a point depends only on the land within about this distance of it, and the
// sea floor has given way to the open sea by then (Bathymetry.ts).
export const LAND_REACH = 24;

// ------------------------------------------------------------------ the land

const LAND_CELLS = Math.round( 2 * GROWTH.half / GROWTH.cell );
const landX = ( i: number ) => - GROWTH.half + ( i + 0.5 ) * GROWTH.cell;

/** The land's box (m): the extent of its lattice cells. */
export function landBounds( land: LandLattice ): Bounds {

	const b = land.bounds();
	return { x0: b.xMin, z0: b.zMin, x1: b.xMax, z1: b.zMax };

}

/** The centre of the land's area (m). */
export function landCentroid( land: LandLattice ): { x: number; z: number } {

	const w = land.cells();
	let n = 0, sx = 0, sz = 0;
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) if ( land.has( i, j ) ) {

		n ++; sx += landX( i ); sz += landX( j );

	}
	return { x: sx / n, z: sz / n };

}

/** The land's area (m^2). */
export function landArea( land: LandLattice ): number {

	const w = land.cells();
	let n = 0;
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) if ( land.has( i, j ) ) n ++;
	return n * GROWTH.cell * GROWTH.cell;

}

// ------------------------------------------------------------------ footprint

// The signed distance to the land's edge, its corners rounded and clamped to +-LAND_REACH: fine
// (0.08 m) over a window, by default the land's box and LAND_REACH + 4 m round it, and the
// lattice's own distance beyond. The default window holds every point nearer the land than
// LAND_REACH clear of the fine field's 3 m blend toward the lattice (with a metre for the lattice's
// own error), so the distance there is the fine field's alone, as a chunk's window over its own
// part of the world sees it: both build the same floor. The fine field's mask is the lattice's distance, interpolated, below zero; its
// window snaps out to a 2 m grid, so its cells lie on a lattice anchored to the world, whatever the
// window.
export function buildFootprint( land: LandLattice, window?: Bounds ): Footprint {

	const bounds = landBounds( land );
	const coarse = land.signedDistance( { i0: 0, j0: 0, i1: LAND_CELLS, j1: LAND_CELLS } );
	// past the lattice's edge the distance keeps growing with the distance from that edge
	const H = GROWTH.half;
	const lattice = ( x: number, z: number ) => coarse.sample( x, z )
		+ Math.hypot( Math.max( - H - x, 0, x - H ), Math.max( - H - z, 0, z - H ) );

	const pad = LAND_REACH + 4, w = window ?? { x0: bounds.x0 - pad, z0: bounds.z0 - pad, x1: bounds.x1 + pad, z1: bounds.z1 + pad };
	const snap = ( v: number, round: ( v: number ) => number ) => round( v / 2 ) * 2;
	const fine = Field2D.covering( snap( w.x0, Math.floor ), snap( w.x1, Math.ceil ), snap( w.z0, Math.floor ), snap( w.z1, Math.ceil ), 0.08 )
		.fill( ( x: number, z: number ) => lattice( x, z ) < 0 ? - 1 : 1 )
		.signedDistance();
	const rounded = roundCorners( fine, 0.9, 1.4 );

	return {
		fine: rounded,
		coarse,
		bounds,
		// signed horizontal distance to the island's edge (m), clamped to +-LAND_REACH
		dist( x: number, z: number ) {

			const d = rounded.contains( x, z ) ? sampleFineOrCoarse( rounded, lattice, x, z ) : lattice( x, z );
			return Math.max( - LAND_REACH, Math.min( LAND_REACH, d ) );

		},
	};

}

function sampleFineOrCoarse( fine: Field2D, coarse: HeightFn, x: number, z: number ): number {

	// blend toward the coarse field in the outer pad so the two never seam
	const ex = Math.min( x - fine.x0, fine.x0 + fine.nx * fine.cell - x );
	const ez = Math.min( z - fine.z0, fine.z0 + fine.nz * fine.cell - z );
	const w = smoothstep( 0.5, 3.0, Math.min( ex, ez ) );
	const f = fine.sample( x, z );
	return w >= 1 ? f : f * w + coarse( x, z ) * ( 1 - w );

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

// The macro coast: a slow wobble of the wall around the footprint (m, + outward).
export function coastWobble( x: number, z: number ): number {

	const broad = noise3( x * 0.105 + 8.7, 4.2, z * 0.105 - 3.1 );
	const shoulder = noise3( x * 0.22 - z * 0.07 - 4.6, 7.9, z * 0.21 + x * 0.04 );
	return Math.tanh( broad * 2.25 + shoulder * 0.32 ) * 0.52;

}

// Soil support and the rim root bed follow the same undisturbed surface as the mesh.
// Fallen columns and chips remain geometry-owned, so exposed stone can interrupt the turf.
export function islandSurfaceHeight( x: number, z: number ): number {

	return ISLAND_TOP + noise3( x * 0.18, 4.1, z * 0.18 ) * 0.12 + noise3( x * 0.7, 1.3, z * 0.7 ) * 0.04;

}

// The island block: the flat meadow plateau inside a weathered sea cliff (Cliff.ts). Everything
// derives from the footprint, so a grown island gets the same kind of coast. `area` is the box the
// SDF is evaluated in, grown by 25 m (by default the whole land's).
export function makeIslandSDF( fp: Footprint, area: Bounds = grow( fp.bounds, 25 ) ): SDF {

	const top = islandSurfaceHeight;
	const wall = new CliffWall( ( x, z ) => fp.dist( x, z ), coastWobble, top, area );

	const islandSDF: SDF = ( x, y, z ) => Math.max( wall.at( x, y, z ), ISLAND_BOTTOM - y );

	islandSDF.tint = ( x, y, z ) => 0.5 + noise3( x * 0.2 + 9.3, y * 0.16, z * 0.2 ) * 0.3;
	islandSDF.shed = ( x, z ) => wall.shed( x, z );
	// Per vertex for the cliff material: the facet's identity (which scar's face it lies on), how
	// recently that scar fell, the bed coordinate (strata) and the depth below the column's own
	// top (the meadow, or a ledge cut into the lip; 0 on a scar's floor).
	islandSDF.detail = ( x, y, z, out, o ) => {

		wall.at( x, y, z, true );
		const s = wall.owner >= 0 ? wall.scars[ wall.owner ] : null;
		out[ o ] = s ? s.id : 0.5;
		out[ o + 1 ] = s ? s.fresh : 0;
		out[ o + 2 ] = wall.beta;
		out[ o + 3 ] = wall.onFloor ? 0 : Math.max( 0, wall.ownTop - y );

	};
	// How much rock overhangs the point (0 open sky .. 1 under a roof: dry, unstreaked stone), the
	// coast's exposure to the waves (the spray zone climbs higher where it is exposed) and whether
	// it lies in a pocket (whose occlusion the material lifts, so it does not read as a hole).
	islandSDF.detail2 = ( x, y, z, out, o ) => {

		const e = 0.02;
		let gx = islandSDF( x + e, y, z ) - islandSDF( x - e, y, z );
		let gy = islandSDF( x, y + e, z ) - islandSDF( x, y - e, z );
		let gz = islandSDF( x, y, z + e ) - islandSDF( x, y, z - e );
		const l = Math.hypot( gx, gy, gz ) || 1;
		gx /= l; gy /= l; gz /= l;
		let shelter = 0;
		if ( gy < 0.7 ) for ( const [ h, w ] of [ [ 0.25, 0.45 ], [ 0.6, 0.35 ], [ 1.3, 0.2 ] ] ) {

			if ( islandSDF( x + gx * 0.1, y + gy * 0.1 + h, z + gz * 0.1 ) < 0 ) shelter += w;

		}
		wall.at( x, y, z, true );
		out[ o ] = shelter;
		out[ o + 1 ] = wall.exposure;
		out[ o + 2 ] = wall.owner >= 0 && wall.scars[ wall.owner ].kind === 'pocket' ? 1 : 0;

	};
	return islandSDF;

}

// The mesh cells that should keep the cliff's edges sharp (dual contouring): the wall and its
// lip down to below the reach of clear water; the flat meadow and the deep toe keep the plain
// surface-nets vertex, which needs no extra field samples.
export function cliffSharpCells( fp: Footprint ): ( x: number, y: number, z: number ) => boolean {

	return ( x, y, z ) => {

		if ( y < - 1.8 ) return false;
		const d = fp.dist( x, z );
		return d > - 3.4 && d < 3.2 && ( d > - 1.4 || y < islandSurfaceHeight( x, z ) - 0.08 );

	};

}

// ------------------------------------------------------------------ submerged rocks

interface DebrisPatch {
	x: number; z: number; major: number; minor: number; rot: number; count: number; outer: boolean;
}

// Patchy hard bottom beside sandy sediment is inspired by USGS coastal seafloor observations:
// https://pubs.usgs.gov/sir/2019/5073/ . This is an art-directed distribution, not sediment physics.
// One patch per 8.3 m of coast, the last three elevenths of them farther out.
function debrisPatches( fp: Footprint, rng: Rng, coast: number ): DebrisPatch[] {

	const patches: DebrisPatch[] = [];
	const b = fp.bounds, count = Math.round( coast / 8.3 ), inner = Math.round( count * 8 / 11 );
	let tries = 0;
	while ( patches.length < count && tries ++ < count * 900 ) {

		const outer = patches.length >= inner;
		const pad = outer ? LAND_REACH : 10;
		const x = b.x0 - pad + rng() * ( b.x1 - b.x0 + pad * 2 );
		const z = b.z0 - pad + rng() * ( b.z1 - b.z0 + pad * 2 );
		const d = fp.dist( x, z );
		if ( d < ( outer ? 9 : 1.6 ) || d >= ( outer ? LAND_REACH : 6.5 ) ) continue;
		if ( patches.some( ( p ) => Math.hypot( p.x - x, p.z - z ) < ( outer ? 8 : 5.2 ) ) ) continue;
		const e = 0.2;
		const nx = fp.dist( x + e, z ) - fp.dist( x - e, z );
		const nz = fp.dist( x, z + e ) - fp.dist( x, z - e );
		const rot = Math.atan2( - nx, nz ) + ( rng() - 0.5 ) * 0.9;
		patches.push( {
			x, z, rot, outer,
			major: ( outer ? 3.0 : 2.5 ) + rng() * 2.8,
			minor: ( outer ? 1.4 : 1.1 ) + rng() * 1.7,
			count: outer ? 9 + Math.floor( rng() * 4 ) : 14 + Math.floor( rng() * 6 ),
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

// A safety cap per metre of coast; each pass sets its own count.
const ROCKS_PER_COAST = 3.5;

// Eight horizontal directions for footprint and clearance probes around a stone.
const RING = Array.from( { length: 8 }, ( _, i ) => [ Math.cos( i * Math.PI / 4 ), Math.sin( i * Math.PI / 4 ) ] );

// Points on a stone's surface, relative to its centre, as ( dx, height / sy, dz ): rays at most
// 0.25 m apart round its widest outline at seven heights, each found by bisection along a
// horizontal ray of its own SDF. The stone's SDF is scaled to its height, so the points depend
// only on its seed, size, orientation and slab or block proportions, not on where it lies.
function rockOutline( r: Rock ): number[] {

	const sdf = makeRockSDF( r );
	const points: number[] = [];
	const n = Math.max( 16, Math.ceil( Math.PI * 2 * r.s * 1.3 / 0.25 / 4 ) * 4 );
	for ( const qy of [ - 0.71, - 0.6, - 0.35, - 0.05, 0.3, 0.6, 0.85 ] ) {

		const y = r.y + qy * r.sy;
		if ( sdf( r.x, y, r.z ) >= 0 ) continue;
		for ( let k = 0; k < n; k ++ ) {

			const ux = Math.cos( k * Math.PI * 2 / n ), uz = Math.sin( k * Math.PI * 2 / n );
			let lo = 0, hi = r.s * 1.45;
			for ( let i = 0; i < 7; i ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( sdf( r.x + ux * mid, y, r.z + uz * mid ) < 0 ) lo = mid; else hi = mid;

			}
			points.push( ux * hi, qy, uz * hi );

		}

	}
	return points;

}

// `island` is the island's solid. Stones keep clear of it by their own extent, wherever the cliff
// and its battered underwater toe happen to run, so a changed or grown coast moves them with it.
export function makeRocks( fp: Footprint, seabedHeight: HeightFn, island?: SDF ): Rock[] {

	// the coast's length, from the band of footprint cells just outside the edge: the counts
	// follow it
	const b = fp.bounds;
	let coast = 0;
	for ( let z = b.z0 - 2; z < b.z1 + 2; z += 0.25 ) for ( let x = b.x0 - 2; x < b.x1 + 2; x += 0.25 ) {

		const d = fp.dist( x, z );
		if ( d >= 0 && d < 1 ) coast += 0.0625;

	}
	const rockLimit = Math.round( coast * ROCKS_PER_COAST );
	const rng = mulberry32( 9177 );
	const patches = debrisPatches( fp, rng, coast );
	const rocks: Rock[] = [];
	// Builds a stone seated on the floor, or null where the water above it is too shallow.
	const build = ( x: number, z: number, size: number, thickness: number, rot: number, variation: number ): Rock | null => {

		const seed = rocks.length + 1;
		const cr = Math.cos( rot ), sr = Math.sin( rot );
		// Seat the stone on the lowest floor under its body. On the cliff-foot talus the centre
		// alone left the downhill edge hanging above the slope; the uphill side is buried instead,
		// as a fallen block settles into scree.
		const lowest = ( ratio: number ) => {

			const [ ax, az ] = rockAxes( seed, ratio );
			let floor = seabedHeight( x, z );
			for ( const reach of [ 0.45, 0.75 ] ) for ( const [ ux, uz ] of RING ) {

				const lx = ux * size * ax * reach, lz = uz * size * az * reach;
				floor = Math.min( floor, seabedHeight( x + cr * lx - sr * lz, z + sr * lx + cr * lz ) );

			}
			return floor;

		};
		const slab = thickness < 0.40;
		const burial = slab ? 0.08 + variation * 0.28 : 0.12 + variation * 0.28;
		// Larger fragments show most of their natural mass above the sediment; gravel remains
		// partly blanketed. Their buried lower faces still give each body a real floor contact.
		const lift = size > 0.9 ? 0.18 + variation * 0.14
			: size > 0.5 && hash3i( seed, 71, 19 ) < 0.65 ? 0.12 + variation * 0.14 : - burial;
		// Budget the whole crown below the wave trough, leaving every sloping face intact.
		// Neither emergence prevention nor sediment burial adds a horizontal clipping plane.
		const height = ( floor: number ) => Math.min( size * thickness, ( - 1.30 - floor ) / ( 1.6 + lift ) );
		let floor = lowest( thickness );
		let sy = height( floor );
		// A shallow floor can flatten a block into a slab, which has other proportions: seat it
		// again with the axes the stone will really have.
		if ( ( sy / size < 0.40 ) !== slab ) {

			floor = Math.min( floor, lowest( sy / size ) );
			sy = height( floor );

		}
		if ( sy < 0.055 ) return null;
		return { x, z, s: size, sy, y: floor + sy * lift, floor, rot, seed };

	};
	// Most stones keep clear of the island through a ring of probes just beyond their bounding
	// ellipse at base, middle and crown: cheap, and generous enough for any stone.
	const wideOfIsland = ( r: Rock ): boolean => {

		if ( ! island ) return true;
		for ( const [ ux, uz ] of RING ) {

			const reach = rockExtent( r, ux, uz ) * 1.15 + 0.1;
			for ( const y of [ r.floor, r.y, r.y + r.sy * 0.9 ] )
				if ( island( r.x + ux * reach, y, r.z + uz * reach ) < 0.06 ) return false;

		}
		return true;

	};
	// Stones walked to the cliff's underwater toe come closer: a few centimetres between the
	// stone's real outline (not its bounding ellipse, which held blocks a body's width off the
	// wall) and the island's solid, so they rest right against the toe wherever it runs.
	let outlineKey = '', outline: number[] = [];
	const touchesIsland = ( r: Rock ): boolean => {

		if ( ! island ) return false;
		// The island's field is no true distance where the cliff relief is displaced (locally up
		// to about 3.3 times as steep), so the quick test for a stone well clear of it allows
		// for that; anything nearer is traced.
		const bound = ( r.s * 1.45 + 0.05 ) * 3.5;
		if ( island( r.x, r.floor, r.z ) > bound && island( r.x, r.y, r.z ) > bound
			&& island( r.x, r.y + r.sy, r.z ) > bound ) return false;
		// The walk tries one stone at many spots; its outline is traced once and kept.
		const key = `${r.seed} ${r.s} ${r.rot} ${r.sy / r.s < 0.40}`;
		if ( key !== outlineKey ) {

			outlineKey = key;
			outline = rockOutline( r );

		}
		for ( let i = 0; i < outline.length; i += 3 )
			if ( island( r.x + outline[ i ], r.y + outline[ i + 1 ] * r.sy, r.z + outline[ i + 2 ] ) < 0.05 ) return true;
		return false;

	};
	const clearOfRocks = ( r: Rock ): boolean => {

		for ( const other of rocks ) {

			const dx = other.x - r.x, dz = other.z - r.z, distance = Math.hypot( dx, dz );
			if ( distance === 0 ) return false;
			if ( distance > ( other.s + r.s ) * 2 ) continue;
			const ux = dx / distance, uz = dz / distance;
			if ( distance < ( rockExtent( r, ux, uz ) + rockExtent( other, ux, uz ) ) * 0.98 ) return false;

		}
		return true;

	};
	const place = ( x: number, z: number, size: number, thickness: number, rot: number ): boolean => {

		if ( rocks.length >= rockLimit ) return false;
		// (an outer patch's stones lie within its ellipse, a few metres past the patch's centre)
		const d = fp.dist( x, z );
		if ( d < Math.max( 0.36, size * 0.32 ) ) return false;
		const r = build( x, z, size, thickness, rot, rng() );
		if ( ! r || ! clearOfRocks( r ) || ( d < 6 && ! wideOfIsland( r ) ) ) return false;
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
		while ( placed < patch.count && rocks.length < rockLimit && tries ++ < patch.count * 90 ) {

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

	// Rockfall at the cliff foot: blocks broken off the wall lie on its talus in uneven runs,
	// dense below some stretches and absent below others, with cobbles spalled around them.
	// Candidates come from the footprint distance alone (any coast, any size); a world-space
	// field decides where the wall has shed, and the blocks thin out away from the foot.
	{

		const pad = 6;
		// The blocks lie under the cliff's recent scars, where it has just shed them, and in runs
		// where a world-space field says the wall sheds more.
		const shed = ( x: number, z: number ) => Math.max( island?.shed?.( x, z ) ?? 0,
			smoothstep( - 0.2, 0.15, noise3( x * 0.085 + 4.9, 12.7, z * 0.085 - 2.3 ) ) * 0.7 );
		// the seaward normal of the footprint's distance field
		const normal = ( x: number, z: number ): [ number, number ] => {

			const e = 0.2;
			const nx = fp.dist( x + e, z ) - fp.dist( x - e, z ), nz = fp.dist( x, z + e ) - fp.dist( x, z - e );
			const l = Math.hypot( nx, nz );
			return l < 1e-6 ? [ 0, 0 ] : [ nx / l, nz / l ];

		};
		// Walks out from a coast point to the first spot where the stone clears the island's
		// solid: the foot of the wall's underwater toe, wherever the cliff and its batter run.
		const atToe = ( cx: number, cz: number, nx: number, nz: number, size: number, thickness: number, rot: number, variation: number ): Rock | null => {

			const at = ( t: number ) => {

				const r = build( cx + nx * t, cz + nz * t, size, thickness, rot, variation );
				return r && ! touchesIsland( r ) ? r : null;

			};
			// coarse steps out, then halve the last one back towards the wall
			const start = Math.max( 0.36, size * 0.32 );
			let hi = start, rock = at( hi );
			while ( ! rock && hi < 5.75 ) rock = at( hi += 0.25 );
			if ( ! rock ) return null;
			let lo = Math.max( start, hi - 0.25 );
			for ( let i = 0; i < 3 && hi > lo; i ++ ) {

				const mid = ( lo + hi ) * 0.5, r = at( mid );
				if ( r ) {

					hi = mid;
					rock = r;

				} else lo = mid;

			}
			return rock;

		};
		const blocks: [ number, number ][] = [];
		// About one fallen block per 3.5 m of coast, gathered where the wall sheds.
		const blockTarget = Math.round( coast / 3.5 );
		let tries = 0;
		while ( blocks.length < blockTarget && rocks.length < rockLimit && tries ++ < blockTarget * 200 ) {

			const x = b.x0 - pad + rng() * ( b.x1 - b.x0 + pad * 2 );
			const z = b.z0 - pad + rng() * ( b.z1 - b.z0 + pad * 2 );
			const d = fp.dist( x, z );
			if ( d < 0 || d > 3.0 || rng() > shed( x, z ) ) continue;
			const [ nx, nz ] = normal( x, z );
			if ( nx === 0 && nz === 0 ) continue;
			const size = 0.6 + Math.pow( rng(), 1.3 ) * 1.1;
			const thickness = rng() < 0.2 ? 0.30 + rng() * 0.09 : 0.58 + rng() * 0.30;
			// long axes lie roughly along the wall they fell from, with some tumbled
			const rot = rng() < 0.7 ? Math.atan2( - nx, nz ) + ( rng() - 0.5 ) * 1.0 : rng() * Math.PI;
			// Most blocks come to rest against the toe; a few roll on down the talus.
			const roll = Math.pow( rng(), 2.5 ) * 2.5, variation = rng();
			let rock = atToe( x - nx * d, z - nz * d, nx, nz, size, thickness, rot, variation );
			if ( rock && roll > 0.05 ) rock = build( rock.x + nx * roll, rock.z + nz * roll, size, thickness, rot, variation );
			if ( ! rock || fp.dist( rock.x, rock.z ) > 6 || ! clearOfRocks( rock ) || touchesIsland( rock ) ) continue;
			rocks.push( rock );
			blocks.push( [ rock.x, rock.z ] );

		}
		// Cobbles spalled from the blocks: half lodged against the toe beside them, the rest
		// scattered mostly on their seaward side.
		let cobbles = 0;
		tries = 0;
		while ( cobbles < blocks.length * 1.5 && rocks.length < rockLimit && tries ++ < blocks.length * 160 ) {

			const [ bx, bz ] = blocks[ Math.floor( rng() * blocks.length ) ];
			const size = 0.16 + Math.pow( rng(), 1.5 ) * 0.38, thickness = 0.38 + rng() * 0.40, rot = rng() * Math.PI;
			if ( rng() < 0.5 ) {

				const [ nx, nz ] = normal( bx, bz );
				const d = fp.dist( bx, bz ), along = ( rng() - 0.5 ) * 5;
				const rock = atToe( bx - nx * d - nz * along, bz - nz * d + nx * along, nx, nz, size, thickness, rot, rng() );
				if ( rock && clearOfRocks( rock ) ) {

					rocks.push( rock );
					cobbles ++;

				}
				continue;

			}
			const a = rng() * Math.PI * 2, rr = 0.8 + rng() * 2.2;
			const x = bx + Math.cos( a ) * rr, z = bz + Math.sin( a ) * rr;
			if ( fp.dist( x, z ) < fp.dist( bx, bz ) - 0.4 ) continue;
			if ( place( x, z, size, thickness, rot ) ) cobbles ++;

		}

	}

	// Isolated fragments are sparse on the outer shelf, leaving broad sand corridors between
	// the denser cliff debris and the few offshore patches: one per 9 m of coast.
	let isolated = 0, tries = 0;
	const pad = LAND_REACH, isolatedCount = Math.round( coast / 9.1 );
	while ( isolated < isolatedCount && rocks.length < rockLimit && tries ++ < 300 * isolatedCount ) {

		const x = b.x0 - pad + rng() * ( b.x1 - b.x0 + pad * 2 );
		const z = b.z0 - pad + rng() * ( b.z1 - b.z0 + pad * 2 );
		const d = fp.dist( x, z );
		if ( d < 9 || d >= LAND_REACH ) continue;
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
