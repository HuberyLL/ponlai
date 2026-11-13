// The world generated one chunk at a time (chunk design, sections 3, 5 and 7): pure functions of the
// land, callable from a worker or from plain node (no `self`, no three, no DOM).
//
// - The grid: chunk ( ci, cj ) is the square [ S ci, S ci + S ) x [ S cj, S cj + S ) on the world's
//   axes, S = 16 m (the sea floor's tile, SEABED_TILE). A chunk exists when land lies within
//   TILE_REACH (26 m, SeabedTile.ts) of it (`chunkKeys`): farther out the floor is the open sea's
//   and nothing else is there.
// - The land field (`landField`): the footprint's pipeline (the land lattice's signed distance
//   interpolated into a 0.08 m mask, its exact distance transform, corners rounded by a close and
//   an open, clamped to +-LAND_REACH), once per land version over the land's box and R + 2 m round
//   it. Its cells lie on a world lattice (cell ( i, j ) centred on ( ( i + 0.5 ) 0.08, ( j + 0.5 )
//   0.08 )) and every stage is exact (integer squared distances), so a cell's value depends only on
//   the land near it, never on the box: a land version that differs only elsewhere gives the same
//   bits there. Beyond the box the distance is +LAND_REACH, which is what it would be.
// - A chunk's job receives its window of the field (`landWindow`): the chunk and R = 32 m round it,
//   1000 x 1000 cells. Its footprint (`windowFootprint`) samples the window by world lattice index,
//   so two chunks reading the same point get the same bits whatever their windows' origins (a
//   Field2D lookup computes from its own origin and differs in the last bits). Beyond the window it
//   continues the window's edge: only the stones' search for the groups that might outrank a stone
//   reads that far, and nothing it finds there reaches a stone (rules below).
// - `buildChunk( window, land, ci, cj )` makes everything the chunk owns (section 3.3) from the
//   window alone: the island SDF over the window (`makeIslandSDF( ... )`, every
//   value a function of the point), its stones, the contact solids, and from those each kind of
//   content below. Ownership: island quads by their edge's base lattice column (SurfaceNets.ts),
//   stones by their centre, anchors by their jittered point, lip segments by their piece's start, texels (rim ground, shore, walk) by their centre;
//   the floor tile's lattice points are shared on the borders, computed alike by both tiles.
//   A chunk the land covers (SeabedTile.ts `underLand`) draws no tile, but carries the floor it
//   would have (`floorUnder`, without the contact shade): a tile of the version before rises to it
//   as the piece that covers it nears (SeabedRise.ts).
// - `dirtyChunks( before, after )`: the chunks whose window meets the land cells that changed,
//   grown by 2 m (the raster): `windowCells`, the one range of land cells a chunk reads, which the
//   cache key's growth steps test too (chunkWorker.ts), so a chunk whose key stays is a chunk this
//   rule keeps. The corner rounding (`roundCorners( 0.9, 1.4 )`) moves a field
//   value by up to 4.6 m, so a value reads the land within min( |d|, LAND_REACH ) + 4.6 m (and the
//   0.35 m lattice): more than those 2 m, covered by R's slack, since the kinds the chunks share
//   read their window no farther than about 31 m from the chunk. Every other chunk keeps its data,
//   bit for bit (tools/verify-world-chunks.mjs, D4 and D5): the content a chunk keeps reads the
//   land within its window, and its distances there change only where land near them changed.
//   The test is the changed cells, not the cells whose clamped distance differs: that would stack
//   LAND_REACH on the window.
// - Samplers that need only the island's side (the shore's sea-level section, the rim lattice)
//   take it from the footprint away from the coast (WorldShapes `solidSide`, exact there) and
//   sample the SDF only near it: the bits are the same, at a fraction of the cost.
// - A chunk without island (no land within ISLAND_NEAR) has no island, anchors or lip, and carries no rim ground tile (ChunkMerge.ts fills its square): three quarters of a
//   sea chunk's bytes went to a tile nothing reads.
// - Arrays are ordered by world position (lattice order, or the owned items' own order), so a
//   chunk's data and its hash repeat whatever order the chunks are built in.
// - The island's mesh is simplified per chunk, its border locked (IslandSimplify.ts): its vertices
//   keep their cell order and every bit, its triangles are the simplifier's (deterministic). The
//   curvature and every attribute come from the full mesh before; the border's vertices and edges
//   stay, so two chunks still meet bit for bit (S1, S2). A block meshed in one call (`chunkIsland`,
//   the checks) is split by chunk before it is simplified, so it still equals its chunks.
// - The page's derived products come with the chunk (ChunkDerived.ts): the island's caster columns
//   and ground grid on world lattices (a cell on a border is filled by both chunks, merged by min
//   and max), taken from the island's mesh before it is simplified, and the refracted map's
//   triangle subsets of the drawn island, the stones and the floor tile (owned with their
//   triangles). tools/verify-chunk-derived.mjs checks that they merge to
//   what SunShadow, RefractedSun and IslandGround build from the merged meshes.
// - For the checks (tools/verify-world-chunks.mjs): `chunkIsland` and `chunkBlock` make a block of
//   chunks in one pass from the block's own window, with the same stage functions as `buildChunk`,
//   and share it out by chunk (S2, S5); `contactStones` gives the stones a chunk places round itself
//   for the contact shade (S6). A new kind of content gets its stage function, used by both.
//   The ambient light's probes (AmbientProbes.ts) are the exception: their rays read the window
//   to 30 m from the chunk, where a block's larger window holds cliff scars a chunk's lacks, so a
//   block's probes would differ from the chunk's near its edge; D4 and D5 cover them by the hash.
//
// Rules for changing what a chunk builds:
// - Everything a chunk emits is a function of its window: read the land through the window's
//   footprint and the island through the window's SDF, never `layoutBounds()`, a global count or
//   the whole coast. A per-box function must not keep state across calls that changes its values
//   (CliffWall's exposure did, Cliff.ts).
// - Whatever reads far from the chunk must not reach anything the chunk keeps. Three kinds read
//   far in principle, beyond what the dirty rule's 34 m covers:
//   - the stones round the chunk (the chunk and CONTACT_STONES round it) are decided by the
//     window's footprint, floor and island within STONES_READ (19.5 m) of that box, by
//     construction (Stones.ts: every chain behind a stone is bounded), so within 31.5 m of the
//     chunk, inside the window and the dirty rule's 34 m. What those values read reaches farther:
//     the cliff at a point reads 25 m of the land field (its scars are seeded within the window, so
//     near the window's edge the island can lack one the whole land has; the stones' tests see only
//     its first tier, about 20 m of land) and the floor's distance up to 29 m of land, so a piece
//     more than 34 m away could still move a stone round the chunk;
//   - the contact stones (the chunk and CONTACT_STONES round it) shade the island and the floor
//     the chunk keeps with what those stones read;
//   - the shore takes its distance over a sea-level section SHORE_PAD (26 m) round the chunk, to
//     LAND_REACH (24 m) from its coast, and that coast is the wall's, which reads 25 m of land.
//   Such reads stay deterministic (the window's edge continued). D4 measures that no kept bit
//   changes outside the dirty set as the land grows (none in seeds 1 - 2 over 12 steps; the
//   farthest changed chunk lay 26 m from the changed land), and D5 places land just beyond the
//   bound on purpose (none changed). In the review's probes coastal land stopped mattering beyond
//   about 18 m.
// - ChunkData carries the same fields in every chunk (an empty mesh keeps all its attributes), and
//   `hash` covers every buffer, so an unchanged chunk is recognised by its hash.

import { Field2D, roundCorners } from './Field2D.ts';
import { GROWTH, type LandLattice, type Window } from './IslandGrowth.ts';
import {
	cliffSharpCells, islandColumnRange, islandSurfaceHeight, landBounds, makeIslandSDF, solidSide, ISLAND_BOTTOM, ISLAND_PEAK, LAND_REACH,
	type Footprint,
} from './WorldShapes.ts';
import type { Bounds, CasterColumns } from '../../render/data.ts';
import { surfaceNets } from './SurfaceNets.ts';
import { compactMesh, simplifyIslandMesh } from './IslandSimplify.ts';
import { makeRockSDF, placeStones } from './Stones.ts';
import { floorAt, SHELF_CEILING } from './Bathymetry.ts';
import { buildFloorTile, nearLandCells, tileIndices, underLand, FAR_HALF, SEABED_TILE, TILE_SIDE, type FloorShape } from './SeabedTile.ts';
import { casterColumns, groundGrid, submergedIndex, SEA_LEVEL, type GroundGrid } from './ChunkDerived.ts';
import { scatterTop } from './Anchors.ts';
import { groveSky } from './BambooGroves.ts';
import { buildRimLip, ownTexels, rimGroundTile, RimLattice, RIM_PAD } from './RimGround.ts';
import { boundedSceneField, contactVisibilitySampler, type SolidBounds } from './SkyOcclusion.ts';
import { bakeProbes, PROBE_NEAR } from './AmbientProbes.ts';
import { VEGETATION_STRIDE, type MeshData, type RimLipData, type Rock, type SDF } from './types.ts';

// ------------------------------------------------------------------ the grid

/** A chunk's side (m): the sea floor's tile, so a chunk holds one tile. */
export const S = SEABED_TILE;
/** How far round a chunk its job reads the land (m): its window is the chunk and R round it. */
export const R = 32;
/** The land field's cell (m), exact in binary multiples: S / LAND_CELL = 200 cells. */
export const LAND_CELL = 0.08;
// the island mesh's lattice (SurfaceNets.ts chunk mode): world-anchored, exact in binary
const VOXEL = 0.125, CELLS = S / VOXEL;
const Y0 = ISLAND_BOTTOM + 0.5, Y1 = ISLAND_PEAK + 0.6;
// A chunk with no land within this of it (m) has no island surface: the wall's wobble (0.52 m) and
// batter (1.2 m over its height) stay well inside, so its nets, anchors and rim are empty.
const ISLAND_NEAR = 4;
// the stones whose centres lie this far round the chunk shade what it owns: an own stone's bounds
// reach 4.8 m from its centre, the contact probes 1.8 m beyond, and another stone's bounds 4.8 m
const CONTACT_STONES = 12;
// the shore tile's cell (m) and the sea-level section round the chunk its distance is taken over
const SHORE_CELL = 0.125, SHORE_PAD = 26;
// the walk tile: 0.5 m cells on the island top clear of the rim (the game's grid, sim/grid.ts,
// keeps 0.9 m inside the edge too)
const WALK_CELL = 0.5, WALK_MARGIN = 0.9;

const grow = ( b: Bounds, m: number ): Bounds => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );
// the lip of a chunk without island, as buildRimLip returns it with no coast (new each time: a
// chunk's buffers are transferred)
const emptyLip = (): RimLipData => ( { points: new Float32Array( 0 ), info: new Float32Array( 0 ), pieces: new Int32Array( 0 ) } );

/** The key of chunk ( ci, cj ). */
export const chunkKey = ( ci: number, cj: number ): string => `${ ci },${ cj }`;

/** Chunk ( ci, cj ) of a key. */
export function parseChunkKey( key: string ): [ number, number ] {

	const [ ci, cj ] = key.split( ',' ).map( Number );
	return [ ci, cj ];

}

/** Chunk ( ci, cj )'s square (m). */
export const chunkBox = ( ci: number, cj: number ): Bounds => ( { x0: ci * S, z0: cj * S, x1: ci * S + S, z1: cj * S + S } );

/** The keys of the chunks with land within TILE_REACH (SeabedTile.ts), in rows ( cj, then ci ). */
export function chunkKeys( land: LandLattice ): string[] {

	return nearLandCells( land ).map( ( [ ci, cj ] ) => chunkKey( ci, cj ) );

}

/** The land lattice's cells (IslandGrowth.ts) whose square, grown by 2 m (the raster), meets
 * chunk ( ci, cj )'s window [ S c - R, S c + S + R ): what the chunk reads of the land. The dirty
 * rule and the cache key's growth steps (chunkWorker.ts) both test this one range. */
export function windowCells( ci: number, cj: number ): Window {

	// cell i's grown square [ X0 + i cell - 2, X0 + ( i + 1 ) cell + 2 ) meets the window when
	// q <= i < p (every term a multiple of the cell, so exact)
	const N = Math.round( 2 * GROWTH.half / GROWTH.cell ), X0 = - GROWTH.half, cell = GROWTH.cell, grown = 2;
	const q = ( c: number ) => Math.max( 0, ( c * S - R - grown - X0 ) / cell );
	const p = ( c: number ) => Math.min( N, ( c * S + S + R + grown - X0 ) / cell );
	return { i0: q( ci ), j0: q( cj ), i1: p( ci ), j1: p( cj ) };

}

/** Which cells of a bit set over a window of the land lattice are set (the bits row by row over the
 * window, as LandLattice's words over the whole lattice and a piece's over its own), counted by
 * window in O( 1 ): a summed-area table. */
export class CellCount {

	private readonly w: Window;
	private readonly nx: number;
	private readonly sum: Int32Array;

	constructor( w: Window, bits: Uint32Array ) {

		// (a piece that added no cell has an empty window)
		const nx = Math.max( 0, w.i1 - w.i0 ), nz = Math.max( 0, w.j1 - w.j0 ), sum = new Int32Array( ( nx + 1 ) * ( nz + 1 ) );
		this.w = w; this.nx = nx; this.sum = sum;
		for ( let j = 0; j < nz; j ++ ) {

			let row = 0;
			for ( let i = 0; i < nx; i ++ ) {

				const b = j * nx + i;
				row += ( bits[ b >>> 5 ] >>> ( b & 31 ) ) & 1;
				sum[ ( j + 1 ) * ( nx + 1 ) + i + 1 ] = sum[ j * ( nx + 1 ) + i + 1 ] + row;

			}

		}

	}

	/** Whether any cell of `q` is set. */
	any( q: Window ): boolean {

		const { w, nx } = this;
		const i0 = Math.max( q.i0, w.i0 ) - w.i0, i1 = Math.min( q.i1, w.i1 ) - w.i0;
		const j0 = Math.max( q.j0, w.j0 ) - w.j0, j1 = Math.min( q.j1, w.j1 ) - w.j0;
		if ( i0 >= i1 || j0 >= j1 ) return false;
		const at = ( i: number, j: number ) => this.sum[ j * ( nx + 1 ) + i ];
		return at( i1, j1 ) - at( i0, j1 ) - at( i1, j0 ) + at( i0, j0 ) > 0;

	}

}

/** The keys of the chunks that exist on `after` and whose window meets a land cell that differs
 * between the two lands, grown by 2 m (`windowCells`), in rows. */
export function dirtyChunks( before: LandLattice, after: LandLattice ): string[] {

	const N = Math.round( 2 * GROWTH.half / GROWTH.cell ), changed = new Uint32Array( after.words.length );
	for ( let w = 0; w < changed.length; w ++ ) changed[ w ] = after.words[ w ] ^ before.words[ w ];
	const cells = new CellCount( { i0: 0, j0: 0, i1: N, j1: N }, changed );
	return chunkKeys( after ).filter( ( key ) => cells.any( windowCells( ...parseChunkKey( key ) ) ) );

}

// ------------------------------------------------------------------ the land field

/** The land's signed distance (m, negative inside, clamped to +-LAND_REACH) on the world's 0.08 m
 * lattice: cells [ i0, i0 + nx ) x [ j0, j0 + nz ), row by row. */
export interface LandField { i0: number; j0: number; nx: number; nz: number; data: Float32Array }

/** The land field over `box` (by default the land's box and R + 2 m round it), once per land
 * version: the page's footprint pipeline (WorldShapes.buildFootprint) on the world lattice. */
export function landField( land: LandLattice, box: Bounds = grow( landBounds( land ), R + 2 ) ): LandField {

	const N = Math.round( 2 * GROWTH.half / GROWTH.cell ), H = GROWTH.half;
	const coarse = land.signedDistance( { i0: 0, j0: 0, i1: N, j1: N } );
	const i0 = Math.floor( box.x0 / LAND_CELL ), j0 = Math.floor( box.z0 / LAND_CELL );
	const nx = Math.ceil( box.x1 / LAND_CELL ) - i0, nz = Math.ceil( box.z1 / LAND_CELL ) - j0;
	// the mask: the lattice's distance, interpolated, below zero at the cell's centre (computed from
	// the cell's world index, so a cell is the same point in every box)
	const mask = new Field2D( i0 * LAND_CELL, j0 * LAND_CELL, nx, nz, LAND_CELL );
	for ( let j = 0; j < nz; j ++ ) {

		const z = ( j0 + j + 0.5 ) * LAND_CELL;
		for ( let i = 0; i < nx; i ++ ) {

			const x = ( i0 + i + 0.5 ) * LAND_CELL;
			const d = coarse.sample( x, z ) + Math.hypot( Math.max( - H - x, 0, x - H ), Math.max( - H - z, 0, z - H ) );
			mask.data[ j * nx + i ] = d < 0 ? - 1 : 1;

		}

	}
	const data = roundCorners( mask.signedDistance(), 0.9, 1.4 ).data;
	for ( let k = 0; k < data.length; k ++ ) data[ k ] = Math.max( - LAND_REACH, Math.min( LAND_REACH, data[ k ] ) );
	return { i0, j0, nx, nz, data };

}

/** Chunk ( ci, cj )'s window of a land field: the chunk and R round it (cells outside the field
 * hold +LAND_REACH); with `span`, the window of the span x span chunks from ( ci, cj ) (the checks'
 * block reference). */
export function landWindow( field: LandField, ci: number, cj: number, span = 1 ): LandField {

	const n = Math.round( ( span * S + 2 * R ) / LAND_CELL ), per = Math.round( S / LAND_CELL ), pad = Math.round( R / LAND_CELL );
	const i0 = ci * per - pad, j0 = cj * per - pad;
	const data = new Float32Array( n * n ).fill( LAND_REACH );
	for ( let j = 0; j < n; j ++ ) {

		const fj = j0 + j - field.j0;
		if ( fj < 0 || fj >= field.nz ) continue;
		const a = Math.max( 0, field.i0 - i0 ), b = Math.min( n, field.i0 + field.nx - i0 );
		if ( a < b ) data.set( field.data.subarray( fj * field.nx + i0 + a - field.i0, fj * field.nx + i0 + b - field.i0 ), j * n + a );

	}
	return { i0, j0, nx: n, nz: n, data };

}

/** A footprint over a land field (a chunk's window): bilinear by world lattice index, the edge
 * continued beyond the field, clamped to +-LAND_REACH. */
export function windowFootprint( field: LandField ): Footprint {

	const { i0, j0, nx, nz, data } = field;
	return {
		bounds: { x0: i0 * LAND_CELL, z0: j0 * LAND_CELL, x1: ( i0 + nx ) * LAND_CELL, z1: ( j0 + nz ) * LAND_CELL },
		dist( x: number, z: number ) {

			const fx = x / LAND_CELL - 0.5, fz = z / LAND_CELL - 0.5;
			let i = Math.floor( fx ), j = Math.floor( fz ), tx = fx - i, tz = fz - j;
			i -= i0; j -= j0;
			if ( i < 0 ) { i = 0; tx = 0; } else if ( i > nx - 2 ) { i = nx - 2; tx = 1; }
			if ( j < 0 ) { j = 0; tz = 0; } else if ( j > nz - 2 ) { j = nz - 2; tz = 1; }
			const k = j * nx + i;
			const a = data[ k ], b = data[ k + 1 ], c = data[ k + nx ], d = data[ k + nx + 1 ];
			const v = ( a + ( b - a ) * tx ) * ( 1 - tz ) + ( c + ( d - c ) * tx ) * tz;
			return Math.max( - LAND_REACH, Math.min( LAND_REACH, v ) );

		},
	};

}

// Whether any cell of the field within `box` lies inside the land.
function landIn( field: LandField, box: Bounds ): boolean {

	const a = Math.max( 0, Math.floor( box.x0 / LAND_CELL ) - field.i0 ), b = Math.min( field.nx, Math.ceil( box.x1 / LAND_CELL ) - field.i0 );
	const c = Math.max( 0, Math.floor( box.z0 / LAND_CELL ) - field.j0 ), d = Math.min( field.nz, Math.ceil( box.z1 / LAND_CELL ) - field.j0 );
	for ( let j = c; j < d; j ++ ) for ( let i = a; i < b; i ++ ) if ( field.data[ j * field.nx + i ] < 0 ) return true;
	return false;

}

// ------------------------------------------------------------------ the chunk

/** The sea floor's near tile: TILE_SIDE x TILE_SIDE points of the world's 0.5 m lattice, row by row. */
export interface ChunkFloor { height: Float32Array; normal: Float32Array; ao: Float32Array; bed: Float32Array }

export interface ChunkData {
	key: string; ci: number; cj: number;
	// the land version it was built for
	land: number;
	// the island's owned quads, every attribute (null: no land within ISLAND_NEAR)
	island: MeshData | null;
	// the stones whose centres lie in the chunk, and their meshes merged in that order
	stones: { rocks: Rock[]; mesh: MeshData };
	// the floor's near tile (null: the land covers the chunk and 2 m round it)
	floor: ChunkFloor | null;
	// where the land covers it (`floor` null), the floor that tile would have (no contact shade):
	// the shoal a tile of the version before rises to (SeabedRise.ts), never drawn
	floorUnder: FloorShape | null;
	// VEGETATION_STRIDE per owned turf anchor
	anchors: Float32Array;
	// the lip's owned pieces, each with its crossing samples (the meadow's edge records)
	lip: RimLipData;
	// the rim ground's owned texels: 160 x 160, RGBA (RimGround.ts); empty without island
	rimGround: Float32Array;
	// the sea-level section's signed distance (m, clamped to +-LAND_REACH): 128 x 128 texels of 0.125 m
	shore: Float32Array;
	// 32 x 32 cells of 0.5 m: 1 on the island top clear of the rim
	walk: Uint8Array;
	// the ambient light's probes the chunk owns (AmbientProbes.ts: 8 x 8 columns of LEVELS, rows
	// K, level, I, PROBE_STRIDE floats each); empty without land within PROBE_NEAR
	ambient: Float32Array;
	// the box round everything that casts a shadow: x0, y0, z0, x1, y1, z1 (empty: +-Infinity)
	casters: [ number, number, number, number, number, number ];
	// What the page derives from the meshes above, so it never walks their vertices (ChunkDerived.ts):
	// the island's caster columns for the sun's map, the triangles of the island, the stones and the floor tile
	// (tileIndices) the refracted sun's map draws at `level` (null: all, or no mesh), and the
	// island's ground grid for the camera. Empty grids where there is no island.
	casterColumns: CasterColumns;
	refracted: { level: number; island: Uint32Array | null; stones: Uint32Array | null; floor: Uint32Array | null };
	ground: GroundGrid;
	// of every buffer above, for the unchanged-chunk test
	hash: string;
	// ms per stage
	timings: Record<string, number>;
}

export interface ChunkOptions {
	// the land version stamped on the data
	version?: number;
	// the cross-object contact shade (island, stones, floor); off only for CPU comparisons
	contactOcclusion?: boolean;
	// the bamboo's canopy in the island's and the meadow's sky visibility (`underCanopy`, the
	// anchors' `groveSky`); off where the ambient volume carries it (lighting/AmbientSample.ts
	// CANOPY_SHADE), and off by default as the page builds it, so the node builds check that path
	canopyShade?: boolean;
}

// What every kind of content of the span x span chunks from ( ci, cj ) reads: the window's
// footprint and island SDF, the stones round the chunks and the solids that shade (the island over
// the window, those stones, the rendered floor).
function setup( window: LandField, ci: number, cj: number, span: number, contactOcclusion: boolean, canopyShade = false ) {

	const box = { x0: ci * S, z0: cj * S, x1: ( ci + span ) * S, z1: ( cj + span ) * S }, area = grow( box, R );
	const fp = windowFootprint( window );
	const sdf = makeIslandSDF( fp, area );
	const renderedFloor = floorAt( fp );
	const near = placeStones( fp, renderedFloor, sdf, grow( box, CONTACT_STONES ) );
	const nearSDFs = near.map( makeRockSDF );
	const rockBounds = near.map( ( r, i ): SolidBounds => {

		const Rx = r.s * 1.25 * 1.6 + 0.08, Ry = r.sy * 1.6 + 0.08;
		return { field: nearSDFs[ i ], min: [ r.x - Rx, Math.min( r.floor - 0.5, r.y - Ry ), r.z - Rx ], max: [ r.x + Rx, r.y + Ry, r.z + Rx ] };

	} );
	const islandSolid: SolidBounds = { field: sdf, min: [ area.x0, ISLAND_BOTTOM - 0.3, area.z0 ], max: [ area.x1, ISLAND_PEAK + 0.6, area.z1 ] };
	const seabedSDF: SDF = ( x, y, z ) => y - renderedFloor( x, z );
	const solids: SolidBounds[] = [ islandSolid, ...rockBounds, {
		field: seabedSDF, min: [ - FAR_HALF, - 32, - FAR_HALF ], max: [ FAR_HALF, SHELF_CEILING, FAR_HALF ],
	} ];
	const aoSdf = contactOcclusion ? boundedSceneField( solids ) : undefined;
	const contacts = ( receiver?: SDF ) => contactOcclusion ? contactVisibilitySampler( solids, receiver ) : undefined;
	return { box, fp, sdf, renderedFloor, near, nearSDFs, rockBounds, islandSolid, aoSdf, contacts, canopyShade };

}

type Setup = ReturnType<typeof setup>;

// The island's owned quads over the span x span chunks from ( ci, cj ) (SurfaceNets.ts chunk mode):
// `full` as meshed, `mesh` each chunk's part simplified on its own (IslandSimplify.ts) and joined
// in rows ( cj, then ci ). A block's call is split by chunk first, so each part is the chunk's own
// full mesh bit for bit and simplifies as it does.
function islandNets( ctx: Setup, ci: number, cj: number, span: number, columns = true, simplify = true ): { full: MeshData; mesh: MeshData } {

	const { fp, sdf, aoSdf, contacts } = ctx;
	const owners: number[] = [];
	const full = surfaceNets( sdf, {
		min: [ 0, Y0, 0 ], max: [ 0, Y1, 0 ], voxel: VOXEL,
		own: [ ci * CELLS, cj * CELLS, ( ci + span ) * CELLS, ( cj + span ) * CELLS ],
		// as the page's island mesh (chunkWorker.ts)
		normalStep: VOXEL * 0.15, sharpen: cliffSharpCells( fp ), columnRange: columns ? islandColumnRange( fp ) : undefined,
		aoSdf, contactVisibility: contacts( sdf ), owners: span > 1 ? owners : undefined,
	} );
	if ( ctx.canopyShade ) underCanopy( full );
	if ( ! simplify ) return { full, mesh: full };
	if ( span === 1 ) return { full, mesh: simplifyIslandMesh( full ) };
	const parts: MeshData[] = [];
	for ( let j = cj; j < cj + span; j ++ ) for ( let i = ci; i < ci + span; i ++ ) {

		const own: number[] = [];
		for ( let t = 0; t < full.indices.length / 3; t ++ ) {

			if ( Math.floor( owners[ 2 * t ] / CELLS ) !== i || Math.floor( owners[ 2 * t + 1 ] / CELLS ) !== j ) continue;
			own.push( full.indices[ 3 * t ], full.indices[ 3 * t + 1 ], full.indices[ 3 * t + 2 ] );

		}
		parts.push( simplifyIslandMesh( compactMesh( full, new Uint32Array( own ) ) ) );

	}
	return { full, mesh: joinIsland( parts ) };

}

// The bamboo's canopy over the island's top (BambooGroves.ts `groveSky`): its sky visibility (`ao`)
// times the share of the sky the groves leave the ground there, fading out down the cliff's top 2 m.
// A function of each vertex's point, so every chunk and block agrees on it. Not where the ambient
// volume lights the ground (`canopyShade` off): its probes see the groves, and the canopy would
// darken the floor twice.
function underCanopy( mesh: MeshData ): void {

	const { positions, ao } = mesh;
	for ( let v = 0; v < ao.length; v ++ ) {

		const x = positions[ 3 * v ], y = positions[ 3 * v + 1 ], z = positions[ 3 * v + 2 ];
		const top = Math.min( Math.max( ( y - ( islandSurfaceHeight( x, z ) - 2 ) ) / 1.7, 0 ), 1 );
		if ( top > 0 ) ao[ v ] *= 1 - top * ( 1 - groveSky( x, z ) );

	}

}

// Island meshes joined in order, one index space, every attribute.
function joinIsland( parts: MeshData[] ): MeshData {

	const joined = mergeMeshes( parts ), nv = joined.positions.length / 3;
	const detail = new Float32Array( nv * 4 ), detail2 = new Float32Array( nv * 3 );
	let ov = 0;
	for ( const p of parts ) {

		detail.set( p.detail!, ov * 4 );
		detail2.set( p.detail2!, ov * 3 );
		ov += p.positions.length / 3;

	}
	return { ...joined, detail, detail2 };

}

/** The island mesh of the span x span chunks from ( ci, cj ), meshed in one call from their window
 * (`landWindow( field, ci, cj, span )`), as each of them meshes its own: the checks compare it with
 * the chunks' meshes. `columns: false` samples whole columns (SurfaceNets.ts `columnRange`);
 * `simplify: false` returns the mesh before IslandSimplify.ts, which the chunk's derived products
 * are taken from. */
export function chunkIsland( window: LandField, ci: number, cj: number, span = 1, { contactOcclusion = true, columns = true, simplify = true } = {} ): MeshData {

	return islandNets( setup( window, ci, cj, span, contactOcclusion ), ci, cj, span, columns, simplify ).mesh;

}

/** The stones chunk ( ci, cj )'s job places round it for the contact shade (CONTACT_STONES), its
 * own among them: two chunks must place a stone they both see alike (the checks compare them). */
export function contactStones( window: LandField, ci: number, cj: number ): Rock[] {

	return setup( window, ci, cj, 1, false ).near;

}

/** What each chunk of the span x span block from ( ci, cj ) owns of the rim ground, the shore, the
 * walk tile and the anchors, made in one pass over the block's
 * window (`landWindow( field, ci, cj, span )`) and its texels and items shared out by chunk: the
 * checks compare it with the chunks' own (each chunk reads its own, smaller window). Members in
 * rows ( cj, then ci ). */
export function chunkBlock( window: LandField, ci: number, cj: number, span: number ) {

	const ctx = setup( window, ci, cj, span, true ), block = ctx.box;
	const members = [];
	for ( let j = cj; j < cj + span; j ++ ) for ( let i = ci; i < ci + span; i ++ ) members.push( { key: chunkKey( i, j ), box: chunkBox( i, j ), island: landIn( window, grow( chunkBox( i, j ), ISLAND_NEAR ) ) } );
	const anchors = members.some( ( m ) => m.island ) ? scatterAnchors( ctx, block ) : new Float32Array( 0 );
	const tile = rimGroundTile( new RimLattice( ctx.sdf, grow( block, RIM_PAD ), ctx.fp ), block );
	const shore = shoreTile( ctx.sdf, ctx.fp, block ), walk = walkTile( ctx.fp, block );
	// a member's square of a block raster of n texels per chunk
	const slice = <T extends Float32Array | Uint8Array>( raster: T, n: number, m: { box: Bounds } ): T => {

		const side = n * span, out = new ( raster.constructor as { new( n: number ): T } )( n * n );
		const oi = Math.round( ( m.box.x0 - block.x0 ) / S ) * n, oj = Math.round( ( m.box.z0 - block.z0 ) / S ) * n;
		for ( let j = 0; j < n; j ++ ) out.set( raster.subarray( ( oj + j ) * side + oi, ( oj + j ) * side + oi + n ), j * n );
		return out;

	};
	return members.map( ( m ) => ( {
		key: m.key,
		rimGround: m.island ? ownTexels( tile, m.box ).data : new Float32Array( 0 ),
		shore: slice( shore, Math.round( S / SHORE_CELL ), m ),
		walk: slice( walk, Math.round( S / WALK_CELL ), m ),
		anchors: m.island ? anchorsIn( anchors, m.box ) : new Float32Array( 0 ),
	} ) );

}

/** Everything chunk ( ci, cj ) owns, from its window of the land field (`landWindow`) and the land
 * (read only round the chunk, for the floor tile's cover test). */
export function buildChunk( window: LandField, land: LandLattice, ci: number, cj: number, options: ChunkOptions = {} ): ChunkData {

	const { version = 0, contactOcclusion = true, canopyShade = false } = options;
	const timings: Record<string, number> = {};
	const t0 = performance.now();
	let t = t0;
	const mark = ( k: string ) => { const now = performance.now(); timings[ k ] = Math.round( now - t ); t = now; };

	// the scars, the stones round the chunk and the contact solids
	const ctx = setup( window, ci, cj, 1, contactOcclusion, canopyShade );
	const { box, fp, sdf, near, nearSDFs, rockBounds, islandSolid, aoSdf, contacts } = ctx;
	const island = landIn( window, grow( box, ISLAND_NEAR ) );
	mark( 'setup' );

	// --- the island: owned surface-nets quads, simplified (IslandSimplify.ts)
	const full = island ? islandNets( ctx, ci, cj, 1, true, false ).full : null;
	mark( 'island' );
	const islandMesh = full && simplifyIslandMesh( full );
	mark( 'simplify' );

	// --- the owned stones, each meshed on its own (as chunkWorker.ts meshes them)
	const rocks: Rock[] = [], rockMeshes: MeshData[] = [];
	near.forEach( ( r, i ) => {

		if ( r.x < box.x0 || r.x >= box.x1 || r.z < box.z0 || r.z >= box.z1 ) return;
		rocks.push( r );
		rockMeshes.push( surfaceNets( nearSDFs[ i ], {
			min: [ ...rockBounds[ i ].min ], max: [ ...rockBounds[ i ].max ],
			voxel: Math.max( 0.045, Math.min( 0.15, r.s * 0.2 ) ),
			aoSdf, contactVisibility: contacts( nearSDFs[ i ] ),
		} ) );

	} );
	const stones = { rocks, mesh: mergeMeshes( rockMeshes ) };
	mark( 'rocks' );

	// --- the sea floor's near tile, shaded by the island and the stones
	let floor: ChunkFloor | null = null, floorUnder: FloorShape | null = null, floorPositions: Float32Array | null = null;
	// (a covered tile without the contact shade: only its shape and beds are kept)
	const covered = underLand( land, ci, cj );
	const tile = buildFloorTile( ci, cj, fp, contactOcclusion && ! covered ? [ islandSolid, ...rockBounds ] : [] );
	const height = new Float32Array( TILE_SIDE * TILE_SIDE );
	for ( let v = 0; v < height.length; v ++ ) height[ v ] = tile.positions[ v * 3 + 1 ];
	if ( covered ) floorUnder = { height, normal: tile.normals, bed: tile.bed };
	else {

		floor = { height, normal: tile.normals, ao: tile.ao, bed: tile.bed };
		floorPositions = tile.positions;

	}
	mark( 'floor' );

	// --- the chunk's turf anchors, with their sky visibility
	const anchors = island ? scatterAnchors( ctx, box ) : new Float32Array( 0 );
	mark( 'anchors' );

	// --- the rim: ground tile, lip. Without island the tile's lattice lies
	// wholly outside the solid (its texels reach RIM_PAD from the chunk, the land lies ISLAND_NEAR
	// away and the wall within 2 m of it), so the lip is empty and the tile is the open sea's
	// distance under noise only the cliff and the meadow read: the chunk carries no tile
	// (ChunkMerge.ts fills its square).
	let rimGround: Float32Array = new Float32Array( 0 ), lip = emptyLip();
	if ( island ) {

		const tile = rimGroundTile( new RimLattice( sdf, grow( box, RIM_PAD ), fp ), box );
		rimGround = ownTexels( tile, box ).data;
		lip = buildRimLip( sdf, tile, box );

	}
	mark( 'rim' );

	// --- the shore: the sea-level section's distance over the chunk, from the section round it
	const shore = shoreTile( sdf, fp, box );
	mark( 'shore' );

	// --- the walk tile
	const walk = walkTile( fp, box );
	mark( 'walk' );

	// --- the ambient light's probes, where land lies near
	const ambient = landIn( window, grow( box, PROBE_NEAR ) )
		? bakeProbes( { fp, sdf, floor: ctx.renderedFloor, stones: rockBounds }, box )
		: new Float32Array( 0 );
	mark( 'ambient' );

	// --- what the page derives from the meshes (ChunkDerived.ts): the caster columns and the ground
	// from the island as meshed, which the simplified one lies within ISLAND_SIMPLIFY_ERROR of (its
	// metre-wide plateau triangles leave cells without a vertex), the subsets from the drawn one
	const islandPositions = full?.positions ?? new Float32Array( 0 );
	const refracted = {
		level: SEA_LEVEL,
		island: islandMesh && submergedIndex( islandMesh.positions, islandMesh.indices ),
		stones: submergedIndex( stones.mesh.positions, stones.mesh.indices ),
		floor: floorPositions && submergedIndex( floorPositions, tileIndices() ),
	};

	const data: ChunkData = {
		key: chunkKey( ci, cj ), ci, cj, land: version,
		island: islandMesh, stones, floor, floorUnder, anchors, lip, rimGround, shore, walk, ambient,
		casters: casterBox( islandMesh, stones.mesh ),
		casterColumns: casterColumns( islandPositions ), refracted, ground: groundGrid( islandPositions ),
		hash: '', timings,
	};
	mark( 'derived' );
	data.hash = hashChunk( data );
	mark( 'hash' );
	timings.total = Math.round( performance.now() - t0 );
	return data;

}

// The turf anchors whose points lie in `area`, VEGETATION_STRIDE each, in the lattice's order, with
// their sky visibility.
function scatterAnchors( ctx: Setup, area: Bounds ): Float32Array {

	const raw: number[] = [];
	scatterTop( ctx.sdf, area, islandSurfaceHeight, ( x, z ) => ctx.fp.dist( x, z ), raw );
	const reach = new Float32Array( raw.length / 8 * VEGETATION_STRIDE );
	const visibility = ctx.contacts();
	for ( let a = 0; a < raw.length / 8; a ++ ) {

		const k = a * 8, dst = a * VEGETATION_STRIDE;
		for ( let j = 0; j < 8; j ++ ) reach[ dst + j ] = raw[ k + j ];
		const x = raw[ k ], z = raw[ k + 2 ];
		// (under the bamboo's canopy too, BambooGroves.ts `groveSky`, unless the ambient volume
		// carries it: `canopyShade`)
		reach[ dst + 8 ] = ( visibility?.( x, raw[ k + 1 ], z, raw[ k + 3 ], raw[ k + 4 ], raw[ k + 5 ] ) ?? 1 ) * ( ctx.canopyShade ? groveSky( x, z ) : 1 );

	}
	return reach;

}

const inBox = ( x: number, z: number, b: Bounds ) => x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1;

// The anchors of `reach` whose points lie in `box`, in order (a block's shared out by chunk).
function anchorsIn( reach: Float32Array, box: Bounds ): Float32Array {

	const own: number[] = [];
	for ( let k = 0; k < reach.length; k += VEGETATION_STRIDE ) if ( inBox( reach[ k ], reach[ k + 2 ], box ) ) own.push( k );
	const anchors = new Float32Array( own.length * VEGETATION_STRIDE );
	own.forEach( ( k, n ) => anchors.set( reach.subarray( k, k + VEGETATION_STRIDE ), n * VEGETATION_STRIDE ) );
	return anchors;

}

// The walk tile over a square box: WALK_CELL cells, 1 on the island top clear of the rim.
function walkTile( fp: Footprint, box: Bounds ): Uint8Array {

	const wn = Math.round( ( box.x1 - box.x0 ) / WALK_CELL ), walk = new Uint8Array( wn * wn );
	for ( let j = 0; j < wn; j ++ ) for ( let i = 0; i < wn; i ++ ) {

		walk[ j * wn + i ] = fp.dist( box.x0 + ( i + 0.5 ) * WALK_CELL, box.z0 + ( j + 0.5 ) * WALK_CELL ) < - WALK_MARGIN ? 1 : 0;

	}
	return walk;

}

// The sea-level section's signed distance over a square box's texels (SHORE_CELL), from the
// section over the box and SHORE_PAD round it, clamped to +-LAND_REACH. The transform reads only
// the section's sign, which the footprint gives away from the coast (`solidSide`): the island's
// SDF is sampled only in that band, about a tenth of the section.
function shoreTile( sdf: SDF, fp: Footprint, box: Bounds ): Float32Array {

	const n = Math.round( ( box.x1 - box.x0 ) / SHORE_CELL ), pad = Math.round( SHORE_PAD / SHORE_CELL ), m = n + 2 * pad;
	const i0 = Math.round( box.x0 / SHORE_CELL ) - pad, j0 = Math.round( box.z0 / SHORE_CELL ) - pad;
	const section = new Field2D( i0 * SHORE_CELL, j0 * SHORE_CELL, m, m, SHORE_CELL );
	for ( let j = 0; j < m; j ++ ) {

		const z = ( j0 + j + 0.5 ) * SHORE_CELL;
		for ( let i = 0; i < m; i ++ ) {

			const x = ( i0 + i + 0.5 ) * SHORE_CELL, side = solidSide( fp, x, z );
			section.data[ j * m + i ] = side !== 0 ? side : sdf( x, 0, z );

		}

	}
	const distance = section.signedDistance().data, out = new Float32Array( n * n );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		out[ j * n + i ] = Math.max( - LAND_REACH, Math.min( LAND_REACH, distance[ ( j + pad ) * m + i + pad ] ) );

	}
	return out;

}

// Meshes merged in order, one index space.
function mergeMeshes( parts: MeshData[] ): MeshData {

	let nv = 0, ni = 0;
	for ( const p of parts ) { nv += p.positions.length / 3; ni += p.indices.length; }
	const positions = new Float32Array( nv * 3 ), normals = new Float32Array( nv * 3 ), ao = new Float32Array( nv );
	const tint = new Float32Array( nv ), curv = new Float32Array( nv ), indices = new Uint32Array( ni );
	let ov = 0, oi = 0;
	for ( const p of parts ) {

		positions.set( p.positions, ov * 3 );
		normals.set( p.normals, ov * 3 );
		ao.set( p.ao, ov );
		tint.set( p.tint, ov );
		curv.set( p.curv, ov );
		for ( let k = 0; k < p.indices.length; k ++ ) indices[ oi + k ] = p.indices[ k ] + ov;
		ov += p.positions.length / 3;
		oi += p.indices.length;

	}
	return { positions, normals, ao, tint, curv, indices };

}

// The box round the island and the stones.
function casterBox( island: MeshData | null, stones: MeshData ): ChunkData[ 'casters' ] {

	const b: ChunkData[ 'casters' ] = [ Infinity, Infinity, Infinity, - Infinity, - Infinity, - Infinity ];
	const points = ( p: Float32Array, stride = 3 ) => {

		for ( let k = 0; k < p.length; k += stride ) for ( let a = 0; a < 3; a ++ ) {

			if ( p[ k + a ] < b[ a ] ) b[ a ] = p[ k + a ];
			if ( p[ k + a ] > b[ a + 3 ] ) b[ a + 3 ] = p[ k + a ];

		}

	};
	if ( island ) points( island.positions );
	points( stones.positions );
	return b;

}

// ------------------------------------------------------------------ the hash

// Two 32-bit MurmurHash3 lanes (seeds apart) over the data's words: 64 bits, so two chunks whose
// buffers differ anywhere hash alike with a chance of 2^-64.
class Hasher {

	private a = 0x9e3779b9 | 0;
	private b = 0x7f4a7c15 | 0;
	private readonly f64 = new Float64Array( 1 );
	private readonly u32 = new Uint32Array( this.f64.buffer );

	word( w: number ): void {

		let k = Math.imul( w, 0xcc9e2d51 );
		k = Math.imul( ( k << 15 ) | ( k >>> 17 ), 0x1b873593 );
		this.a ^= k;
		this.a = ( Math.imul( ( this.a << 13 ) | ( this.a >>> 19 ), 5 ) + 0xe6546b64 ) | 0;
		let q = Math.imul( w ^ 0x5bd1e995, 0x85ebca6b );
		q = Math.imul( ( q << 17 ) | ( q >>> 15 ), 0xc2b2ae35 );
		this.b ^= q;
		this.b = ( Math.imul( ( this.b << 11 ) | ( this.b >>> 21 ), 9 ) + 0x38495ab5 ) | 0;

	}

	number( v: number ): void {

		this.f64[ 0 ] = v;
		this.word( this.u32[ 0 ] );
		this.word( this.u32[ 1 ] );

	}

	text( s: string ): void {

		this.word( s.length );
		for ( let i = 0; i < s.length; i ++ ) this.word( s.charCodeAt( i ) );

	}

	array( v: ArrayBufferView & { length: number } ): void {

		this.text( v.constructor.name );
		this.word( v.length );
		const bytes = v.byteLength, words = bytes >>> 2;
		const u32 = v.byteOffset % 4 === 0 ? new Uint32Array( v.buffer, v.byteOffset, words ) : new Uint32Array( new Uint8Array( v.buffer, v.byteOffset, words * 4 ).slice().buffer );
		for ( let i = 0; i < words; i ++ ) this.word( u32[ i ] );
		const tail = new Uint8Array( v.buffer, v.byteOffset + words * 4, bytes - words * 4 );
		for ( let i = 0; i < tail.length; i ++ ) this.word( tail[ i ] );

	}

	value( v: unknown ): void {

		if ( v === undefined ) this.text( 'u' );
		else if ( v === null ) this.text( 'n' );
		else if ( typeof v === 'number' ) { this.text( '#' ); this.number( v ); }
		else if ( typeof v === 'string' ) { this.text( 's' ); this.text( v ); }
		else if ( ArrayBuffer.isView( v ) ) this.array( v as ArrayBufferView & { length: number } );
		else if ( Array.isArray( v ) ) { this.text( '[' ); this.word( v.length ); for ( const item of v ) this.value( item ); }
		else if ( typeof v === 'object' ) {

			this.text( '{' );
			for ( const key of Object.keys( v ).sort() ) { this.text( key ); this.value( ( v as Record<string, unknown> )[ key ] ); }

		} else throw new TypeError( `cannot hash a ${ typeof v }` );

	}

	digest(): string {

		const hex = ( h: number ) => ( h >>> 0 ).toString( 16 ).padStart( 8, '0' );
		return hex( this.a ) + hex( this.b );

	}

}

/** The hash of a chunk's content: every field but `key`, `land`, `hash` and `timings`, by value
 * (typed arrays by their bytes), keys in sorted order. */
export function hashChunk( data: ChunkData ): string {

	const h = new Hasher();
	const { key, land, hash, timings, ...content } = data;
	void key; void land; void hash; void timings;
	h.value( content );
	return h.digest();

}
