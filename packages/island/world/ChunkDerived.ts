// What the page derives from a chunk's meshes, made in the chunk's job (Chunks.ts `buildChunk`) so
// the main thread never walks their vertices: the sun's caster
// columns (SunShadow.ts), the triangles the refracted sun's map draws (RefractedSun.ts) and the
// camera's ground grid (IslandGround.ts). Plain functions of the positions, without three, for the
// workers and node.
//
// - Every grid lies on the world's lattice ( cell ( i, j ) is [ i c, i c + c ) x [ j c, j c + c ) ),
//   over the cells the points fall in, so two chunks fill the cells on their border alike and the
//   page merges them by min and max, in any order, without knowing who owns a cell. A cell is a
//   power of two, so a point's cell ( floor( x / c ) ) is exact.
// - The products are in world space: they hold for a mesh drawn with an identity world matrix (the
//   chunks' meshes, placed in world coordinates).
// - The island's caster columns and ground grid are taken from its mesh before it is simplified
//   (Chunks.ts, IslandSimplify.ts): the simplified plateau's triangles reach a few metres, so its
//   vertices left about a quarter of the ground's cells and two thirds of the columns' empty at
//   growth step 12, where the camera would have grabbed the sea through the meadow. The meshed
//   surface lies within the simplifier's error of the drawn one. The subsets index the drawn mesh.
// - SunShadow's column grid follows its casters' box (64 cells along the longer side), which a
//   chunk does not know: a chunk keeps its raw columns (the lowest and highest point in each cell,
//   unpadded) on a finer fixed lattice, and SunShadow folds each into every one of its cells the
//   column's cell meets. That holds everything its own walk would bin, and a point at most one
//   COLUMN_CELL past a cell's edge more: within one of its cells (tools/verify-chunk-derived.mjs).
// - The refracted map's subsets are cut at SEA_LEVEL, the only level the sea takes today; at another
//   level RefractedSun cuts its own, as it does for meshes without them.
// - The caster columns' and the subsets' format is the renderer's (lighting/CasterFormat.ts).

import { LEVEL_MARGIN, type CasterColumns } from '../../render/data.ts';

/** The chunks' caster column cell (m), their CasterColumns' `cell`: finer than SunShadow's (a 16 m
 * box's longer side over 64). */
export const COLUMN_CELL = 0.25;
/** The camera's ground cell (m): IslandGround's grid. */
export const GROUND_CELL = 0.5;
/** The level the chunks cut the refracted map's subsets at: the sea's mean surface (shared.waterLevel). */
export const SEA_LEVEL = 0;
/** The highest point in each cell of the world's GROUND_CELL lattice (-Infinity where none falls),
 * laid out as CasterColumns, and the points' box: x0, y0, z0, x1, y1, z1 (empty: +-Infinity). */
export interface GroundGrid { x0: number; z0: number; cell: number; nx: number; nz: number; heights: Float32Array; bounds: [ number, number, number, number, number, number ] }

// The cells of the world's `cell` lattice the points fall in: [ i0, i0 + nx ) x [ j0, j0 + nz ).
function cellsOf( positions: Float32Array, cell: number ) {

	let x0 = Infinity, z0 = Infinity, x1 = - Infinity, z1 = - Infinity;
	for ( let v = 0; v < positions.length; v += 3 ) {

		const x = positions[ v ], z = positions[ v + 2 ];
		if ( x < x0 ) x0 = x;
		if ( x > x1 ) x1 = x;
		if ( z < z0 ) z0 = z;
		if ( z > z1 ) z1 = z;

	}
	if ( ! ( x1 >= x0 ) ) return { i0: 0, j0: 0, nx: 0, nz: 0 };
	const i0 = Math.floor( x0 / cell ), j0 = Math.floor( z0 / cell );
	return { i0, j0, nx: Math.floor( x1 / cell ) - i0 + 1, nz: Math.floor( z1 / cell ) - j0 + 1 };

}

/** The caster columns of a mesh's points (x, y, z each). */
export function casterColumns( positions: Float32Array ): CasterColumns {

	const cell = COLUMN_CELL, { i0, j0, nx, nz } = cellsOf( positions, cell );
	const low = new Float32Array( nx * nz ).fill( Infinity ), high = new Float32Array( nx * nz ).fill( - Infinity );
	for ( let v = 0; v < positions.length; v += 3 ) {

		const y = positions[ v + 1 ];
		const k = ( Math.floor( positions[ v + 2 ] / cell ) - j0 ) * nx + Math.floor( positions[ v ] / cell ) - i0;
		if ( y < low[ k ] ) low[ k ] = y;
		if ( y > high[ k ] ) high[ k ] = y;

	}
	return { x0: i0 * cell, z0: j0 * cell, cell, nx, nz, low, high };

}

/** The ground grid of a mesh's points (x, y, z each). */
export function groundGrid( positions: Float32Array ): GroundGrid {

	const cell = GROUND_CELL, { i0, j0, nx, nz } = cellsOf( positions, cell );
	const heights = new Float32Array( nx * nz ).fill( - Infinity );
	const bounds: GroundGrid[ 'bounds' ] = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];
	for ( let v = 0; v < positions.length; v += 3 ) {

		const x = positions[ v ], y = positions[ v + 1 ], z = positions[ v + 2 ];
		const k = ( Math.floor( z / cell ) - j0 ) * nx + Math.floor( x / cell ) - i0;
		if ( y > heights[ k ] ) heights[ k ] = y;
		for ( let a = 0; a < 3; a ++ ) {

			const p = positions[ v + a ];
			if ( p < bounds[ a ] ) bounds[ a ] = p;
			if ( p > bounds[ a + 3 ] ) bounds[ a + 3 ] = p;

		}

	}
	return { x0: i0 * cell, z0: j0 * cell, cell, nx, nz, heights, bounds };

}

/** The index of the triangles of ( positions, indices ) with a corner below `level` + LEVEL_MARGIN
 * (RefractedSun's rule), or null when every triangle has one. */
export function submergedIndex( positions: Float32Array, indices: Uint32Array, level = SEA_LEVEL ): Uint32Array | null {

	const cut = level + LEVEL_MARGIN, n = positions.length / 3;
	const below = new Uint8Array( n );
	for ( let v = 0; v < n; v ++ ) below[ v ] = positions[ v * 3 + 1 ] < cut ? 1 : 0;
	let kept = 0;
	for ( let t = 0; t + 2 < indices.length; t += 3 ) if ( below[ indices[ t ] ] || below[ indices[ t + 1 ] ] || below[ indices[ t + 2 ] ] ) kept += 3;
	if ( kept === indices.length ) return null;
	const index = new Uint32Array( kept );
	for ( let t = 0, k = 0; t + 2 < indices.length; t += 3 ) {

		const a = indices[ t ], b = indices[ t + 1 ], c = indices[ t + 2 ];
		if ( below[ a ] || below[ b ] || below[ c ] ) { index[ k ++ ] = a; index[ k ++ ] = b; index[ k ++ ] = c; }

	}
	return index;

}
