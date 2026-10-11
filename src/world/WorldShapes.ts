// The island's solid geometry as signed distance functions (metres, y up, sea level at 0).
// Everything here runs in the mesh worker: the island block and the land's distance (the sea floor
// is Bathymetry.ts, the submerged stones Stones.ts). The island's shape is the grown
// land (IslandGrowth.ts).
//
// Everything here is generic, so any land builds itself the same way: the footprint and the
// cliffs derive from the land, the island's SDF and noise fields with fixed seeds (hashes of
// position in world-anchored cells), never from coordinates placed by hand. Keep the flat central
// plateau: natural contour, slope and weathering belong to the outer rim and the cliffs (Cliff.ts).

import { Field2D, roundCorners } from './Field2D.ts';
import { noise3, smoothstep } from './noise.ts';
import { CliffWall } from './Cliff.ts';
import { GROWTH, type LandLattice } from './IslandGrowth.ts';
import type { SDF } from './types.ts';

// A box on the ground (m).
export interface Bounds { x0: number; z0: number; x1: number; z1: number }

const grow = ( b: Bounds, m: number ): Bounds => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

export interface Footprint {
	// the footprint's corners rounded, at 0.08 m over its window (the page's footprint; a chunk's,
	// Chunks.ts, holds its window of the land field instead)
	fine?: Field2D;
	// the land lattice's own signed distance (0.25 m), over the whole lattice (likewise)
	coarse?: Field2D;
	// the land's box (a chunk's: its window)
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
// SDF is evaluated in, grown by 25 m (by default the whole land's). Every value is a function of
// the point alone, as chunk meshes need (their neighbours evaluate the same points in another
// order).
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

// The island mesh's column range (SurfaceNets.ts `columnRange`): a column more than 3.5 m inside
// the coast holds no wall (the cliff's scars and ledges stay within 3.4 m of it, cliffSharpCells),
// only the meadow's top, so the mesh samples it from 0.35 m below that top to 0.6 m above.
// tools/verify-world-chunks.mjs --long checks that every chunk comes out bit-identical with and
// without.
export function islandColumnRange( fp: Footprint ): ( x: number, z: number ) => readonly [ number, number ] | null {

	const range: [ number, number ] = [ 0, 0 ];
	return ( x, z ) => {

		if ( fp.dist( x, z ) >= - 3.5 ) return null;
		const top = islandSurfaceHeight( x, z );
		range[ 0 ] = top - 0.35; range[ 1 ] = top + 0.6;
		return range;

	};

}
