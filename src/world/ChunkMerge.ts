// One land version's chunks (Chunks.ts `ChunkData`) merged into the WorldData the page draws: the
// page's pool (WorldChunks.ts) and the node tools' serial path (tools/world-node.mjs) both end
// here, so they draw and check the same world. Pure (no three, no DOM). A grown island's version
// is merged in steps (`mergeSteps`, in idle time: Growth.ts), to the same result.
//
// - Everything is concatenated in rows of chunks ( cj, then ci ), each chunk's owned items in its
//   own order (Chunks.ts), so the merged arrays, the meadow's pools and a paused frame are the
//   same whatever order the workers finished in.
// - The island stays a part per land chunk, with what its job derived from it (ChunkDerived.ts),
//   for the page to draw a mesh per chunk (World.ts). The stones are one mesh, the chunks' meshes
//   concatenated, and the sea floor one mesh of the chunks' near tiles in that order, then the far
//   floor. The refracted sun's triangle subsets of those two are the chunks' subsets joined in the
//   same order (the far floor cut here, by the same rule), so the page cuts none of the world's
//   meshes itself.
// - The world fields cover the land's box and 32 m round it, out to the world's 32 m grid
//   (`fieldBounds`), which holds every chunk; each chunk's texels are copied into its square:
//   the shore's distance (0.125 m; +LAND_REACH where no chunk is, as the chunks clamp it), the
//   floor's height (0.25 m) and its beds (0.5 m).
// - The rim ground (0.1 m) is read only on the land and its cliff (the meadow's tufts, the cliff
//   material), so it keeps its own, smaller bounds: the RIM_BOX boxes that meet the land's box and
//   RIM_PAD (`rimBounds`, the extent RimGround's assembly covered before chunks), copied from the
//   chunks inside them that have island; elsewhere (no chunk, or a chunk without island, which
//   carries no tile: Chunks.ts) it holds the open sea's constant ( RIM_REACH, ISLAND_TOP, 0, 0 ).
//   Those squares lie more than 2 m from any island surface and meadow anchor, and the texture is
//   filtered linearly without mips, so nothing reads them. Over the fields' bounds it held 3-8x
//   the texels. Its CPU field stays Float32 although the texture is half float (World.ts):
//   the tufts read it on the CPU, and packing it would move their placement by ~1e-3 m; the
//   texture halves only the GPU's copy. The last two are interpolated from the chunk's
//   floor tile at the texels' centres on the meshes' diagonal, as Bathymetry's `floorAt` reads
//   the rendered floor; elsewhere they are what the land job put there (chunkWorker.ts
//   `buildLand`: the open sea's, or the shelf's ceiling under the land).
// - The ambient light's probes are one lattice over the box of the chunks that baked them, each
//   chunk's copied into its square and the open sea's in the gaps, the invalid ones then filled from
//   their neighbours (AmbientProbes.ts `mergeProbes`).

import type { ChunkData } from './Chunks.ts';
import { LandLattice } from './IslandGrowth.ts';
import { tileIndices, SEABED_TILE, TILE_SIDE, type FarFloor } from './SeabedTile.ts';
import { gridBoxes, mergeRimLips, RIM_BOX, RIM_CELL, RIM_PAD, RIM_REACH } from './RimGround.ts';
import { landBounds, ISLAND_TOP, LAND_REACH } from './WorldShapes.ts';
import type { Bounds } from '../renderData.ts';
import { submergedIndex, SEA_LEVEL } from './ChunkDerived.ts';
import { mergeProbes } from './AmbientProbes.ts';
import type { IslandChunk, MeshData, Rock, WorldData } from './types.ts';

// The world fields' cells (m): the shore's distance, the floor's height and the floor's beds.
export const SHORE_CELL = 0.125, FLOOR_CELL = 0.25, BED_CELL = 0.5;
// the floor tile's lattice step (m): SEABED_TILE over its TILE_SIDE - 1 cells
const STEP = SEABED_TILE / ( TILE_SIDE - 1 );
// the shore field's texels filled a step (in steps)
const FILL = 1 << 15;

/** A land version and what the page needs of it before its chunks (chunkWorker.ts `buildLand`). */
export interface LandData {
	seed: number; step: number;
	// LandLattice.toBytes
	land: Uint8Array;
	// ci, cj per chunk, in rows ( cj, then ci ) (Chunks.ts chunkKeys)
	chunks: Int32Array;
	// per chunk, the growth steps whose pieces may lie in its window (its cache key names them)
	steps: number[][];
	// the open sea's floor round the chunks (SeabedTile.ts)
	far: FarFloor;
	// the world fields' bounds (`fieldBounds`), and the floor's height (FLOOR_CELL) and beds
	// (BED_CELL, RG) over them before any chunk's are copied in
	bounds: Bounds;
	floor: Float32Array;
	beds: Float32Array;
	// the islander's walking loop on this land (WalkLoop.ts): x, z per waypoint, as computed (doubles)
	walk: Float64Array;
}

/** The world fields' bounds: the land's box and 32 m round it, out to the world's 32 m grid. A
 * chunk lies within 26 m of the land and starts on the 16 m grid, so every chunk lies inside. */
export function fieldBounds( land: LandLattice ): Bounds {

	const b = landBounds( land );
	const out = ( v: number, round: ( v: number ) => number, by: number ) => round( ( v + by ) / 32 ) * 32;
	return { x0: out( b.x0, Math.floor, - 32 ), z0: out( b.z0, Math.floor, - 32 ), x1: out( b.x1, Math.ceil, 32 ), z1: out( b.z1, Math.ceil, 32 ) };

}

/** The rim ground's bounds: the extent of the RIM_BOX boxes that meet the land's box grown by
 * RIM_PAD. RIM_BOX is the chunks' side, so a chunk lies either inside or outside. */
export function rimBounds( land: LandLattice ): Bounds {

	const b = landBounds( land ), boxes = gridBoxes( { x0: b.x0 - RIM_PAD, z0: b.z0 - RIM_PAD, x1: b.x1 + RIM_PAD, z1: b.z1 + RIM_PAD }, RIM_BOX );
	return {
		x0: Math.min( ...boxes.map( ( r ) => r.x0 ) ), z0: Math.min( ...boxes.map( ( r ) => r.z0 ) ),
		x1: Math.max( ...boxes.map( ( r ) => r.x1 ) ), z1: Math.max( ...boxes.map( ( r ) => r.z1 ) ),
	};

}

/** The WorldData of a land version from all its chunks (in any order). */
export function mergeChunks( land: LandData, unordered: readonly ChunkData[] ): WorldData {

	const steps = mergeSteps( land, unordered );
	for ( ;; ) {

		const next = steps.next();
		if ( next.done ) return next.value;

	}

}

/** `mergeChunks` in steps (a generator): it yields after each chunk's share of the meshes and the
 * fields and between slices of the larger fills, so the growth (Growth.ts) can merge a pending
 * version in idle time, a few tenths of a millisecond a step. The result is the same however it is
 * stepped. */
export function* mergeSteps( land: LandData, unordered: readonly ChunkData[] ): Generator<void, WorldData> {

	const t0 = performance.now();
	let busy = 0, mark = t0;
	const pause = function* () {

		busy += performance.now() - mark;
		yield;
		mark = performance.now();

	};
	// a helper's steps, each a pause
	const pausing = function* <T>( steps: Generator<void, T> ): Generator<void, T> {

		for ( ;; ) {

			const next = steps.next();
			if ( next.done ) return next.value;
			yield* pause();

		}

	};
	const chunks = [ ...unordered ].sort( ( a, b ) => a.cj - b.cj || a.ci - b.ci );
	const { bounds } = land;
	const width = bounds.x1 - bounds.x0, depth = bounds.z1 - bounds.z0;

	// --- meshes
	const islands: IslandChunk[] = chunks.flatMap( ( c ) => c.island && c.island.indices.length > 0 ? [ {
		ci: c.ci, cj: c.cj, mesh: c.island, columns: c.casterColumns, ground: c.ground,
		refracted: { level: c.refracted.level, index: c.refracted.island },
	} ] : [] );
	const rocks: Rock[] = chunks.flatMap( ( c ) => c.stones.rocks );
	const stones: MeshData = yield* pausing( mergeMeshes( chunks.map( ( c ) => c.stones.mesh ) ) );
	yield* pause();
	const seabed: WorldData[ 'seabed' ] = yield* pausing( mergeFloor( chunks, land.far ) );
	yield* pause();
	const tiles = chunks.filter( ( c ) => c.floor ), tileIndex = tileIndices();
	const stoneSubset: Uint32Array | null = yield* pausing( joinSubsets( chunks.map( ( c ): Subset => [ c.refracted.stones, c.stones.mesh.indices, c.stones.mesh.positions.length / 3 ] ) ) );
	const far = submergedIndex( land.far.positions, land.far.indices );
	yield* pause();
	const seabedSubset: Uint32Array | null = yield* pausing( joinSubsets( [
		...tiles.map( ( c ): Subset => [ c.refracted.floor, tileIndex, TILE_SIDE * TILE_SIDE ] ),
		[ far, land.far.indices, land.far.positions.length / 3 ],
	] ) );
	const refracted = { level: chunks[ 0 ]?.refracted.level ?? SEA_LEVEL, stones: stoneSubset, seabed: seabedSubset };
	yield* pause();

	// --- owned items
	const concat = ( parts: Float32Array[] ) => {

		const out = new Float32Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
		parts.reduce( ( offset, p ) => { out.set( p, offset ); return offset + p.length; }, 0 );
		return out;

	};

	// --- the world fields
	const shore = { data: new Float32Array( width / SHORE_CELL * depth / SHORE_CELL ), nx: width / SHORE_CELL, nz: depth / SHORE_CELL, x0: bounds.x0, z0: bounds.z0, cell: SHORE_CELL };
	for ( let k = 0; k < shore.data.length; k += FILL ) {

		shore.data.fill( LAND_REACH, k, k + FILL );
		yield* pause();

	}
	const rim = rimBounds( LandLattice.fromBytes( land.land ) );
	const rx = Math.round( ( rim.x1 - rim.x0 ) / RIM_CELL ), rz = Math.round( ( rim.z1 - rim.z0 ) / RIM_CELL ), ri0 = Math.round( rim.x0 / RIM_CELL ), rj0 = Math.round( rim.z0 / RIM_CELL );
	const rimGround = { data: new Float32Array( rx * rz * 4 ), nx: rx, nz: rz, x0: ri0 * RIM_CELL, z0: rj0 * RIM_CELL, cell: RIM_CELL };
	yield* pause();
	for ( let j = 0; j < rz; j ++ ) {

		for ( let k = j * rx; k < ( j + 1 ) * rx; k ++ ) { rimGround.data[ k * 4 ] = RIM_REACH; rimGround.data[ k * 4 + 1 ] = ISLAND_TOP; }
		if ( j % 8 === 7 ) yield* pause();

	}
	const seabedField = { data: land.floor.slice(), nx: width / FLOOR_CELL, nz: depth / FLOOR_CELL, x0: bounds.x0, z0: bounds.z0, cell: FLOOR_CELL };
	yield* pause();
	const seabedBeds = { data: land.beds.slice(), nx: width / BED_CELL, nz: depth / BED_CELL, x0: bounds.x0, z0: bounds.z0, cell: BED_CELL };
	yield* pause();
	for ( const c of chunks ) {

		const x0 = c.ci * SEABED_TILE, z0 = c.cj * SEABED_TILE;
		copyTile( shore.data, shore.nx, c.shore, SEABED_TILE / SHORE_CELL, ( x0 - bounds.x0 ) / SHORE_CELL, ( z0 - bounds.z0 ) / SHORE_CELL, 1 );
		if ( c.rimGround.length > 0 && x0 >= rim.x0 && x0 < rim.x1 && z0 >= rim.z0 && z0 < rim.z1 ) copyTile( rimGround.data, rx, c.rimGround, Math.round( SEABED_TILE / RIM_CELL ), Math.round( x0 / RIM_CELL ) - ri0, Math.round( z0 / RIM_CELL ) - rj0, 4 );
		if ( c.floor ) {

			fromTile( seabedField.data, seabedField.nx, c.floor.height, 1, FLOOR_CELL, ( x0 - bounds.x0 ) / FLOOR_CELL, ( z0 - bounds.z0 ) / FLOOR_CELL );
			fromTile( seabedBeds.data, seabedBeds.nx, c.floor.bed, 2, BED_CELL, ( x0 - bounds.x0 ) / BED_CELL, ( z0 - bounds.z0 ) / BED_CELL );

		}
		yield* pause();

	}

	const chunkList = new Int32Array( chunks.length * 2 );
	chunks.forEach( ( c, k ) => { chunkList[ k * 2 ] = c.ci; chunkList[ k * 2 + 1 ] = c.cj; } );
	const vegetation = concat( chunks.map( ( c ) => c.anchors ) );
	yield* pause();
	const rimLip = mergeRimLips( chunks.map( ( c ) => c.lip ) );
	yield* pause();
	const ambient = yield* pausing( mergeProbes( chunks ) );
	const data: WorldData = {
		land: land.land, chunks: chunkList,
		islands, stones, rocks, seabed, refracted,
		vegetation,
		rimGround,
		rimLip,
		shore, seabedField, seabedBeds,
		walk: land.walk,
		ambient,
		timings: {},
	};
	busy += performance.now() - mark;
	// (the time spent merging, not the time the steps were spread over)
	data.timings = { merge: Math.round( busy ) };
	return data;

}

// A square tile of n x n texels ( `channels` floats each) into a field nx wide at texel ( i0, j0 ).
function copyTile( out: Float32Array, nx: number, tile: Float32Array, n: number, i0: number, j0: number, channels: number ): void {

	for ( let j = 0; j < n; j ++ ) out.set( tile.subarray( j * n * channels, ( j + 1 ) * n * channels ), ( ( j0 + j ) * nx + i0 ) * channels );

}

// The floor tile's lattice values ( `channels` per point) at the centres of a field's cells of
// `cell` m over the tile's square, interpolated on the triangles the floor's meshes draw (split by
// the diagonal from ( i + 1, j ) to ( i, j + 1 ), as Bathymetry's `floorAt`), into a field nx
// wide at cell ( i0, j0 ). (SeabedRise.ts fills the shoal's squares with it.)
export function fromTile( out: Float32Array, nx: number, tile: Float32Array, channels: number, cell: number, i0: number, j0: number ): void {

	const n = SEABED_TILE / cell, side = TILE_SIDE;
	for ( let q = 0; q < n; q ++ ) for ( let p = 0; p < n; p ++ ) {

		const fx = ( p + 0.5 ) * cell / STEP, fz = ( q + 0.5 ) * cell / STEP;
		const i = Math.floor( fx ), j = Math.floor( fz ), u = fx - i, v = fz - j;
		const o = ( ( j0 + q ) * nx + i0 + p ) * channels;
		for ( let ch = 0; ch < channels; ch ++ ) {

			const at = ( a: number, b: number ) => tile[ ( b * side + a ) * channels + ch ];
			if ( u + v <= 1 ) {

				const a = at( i, j );
				out[ o + ch ] = a + ( at( i + 1, j ) - a ) * u + ( at( i, j + 1 ) - a ) * v;

			} else {

				const d = at( i + 1, j + 1 );
				out[ o + ch ] = d + ( at( i, j + 1 ) - d ) * ( 1 - u ) + ( at( i + 1, j ) - d ) * ( 1 - v );

			}

		}

	}

}

// A part's refracted subset (null: every triangle), its whole index and its vertex count.
type Subset = [ Uint32Array | null, Uint32Array, number ];

// The subsets of meshes concatenated in order (as `mergeMeshes`, `mergeFloor`), in their one index
// space: the triangles a cut of the whole would keep, in its order; null when that is every one.
// A step a part.
function* joinSubsets( parts: Subset[] ): Generator<void, Uint32Array | null> {

	let total = 0, kept = 0;
	for ( const [ subset, index ] of parts ) { total += index.length; kept += ( subset ?? index ).length; }
	if ( kept === total ) return null;
	const out = new Uint32Array( kept );
	let offset = 0, k = 0;
	for ( const [ subset, index, vertices ] of parts ) {

		for ( const v of subset ?? index ) out[ k ++ ] = v + offset;
		offset += vertices;
		yield;

	}
	return out;

}

// Meshes concatenated in order, one index space (the stones: they carry no cliff detail). A step a part.
function* mergeMeshes( parts: MeshData[] ): Generator<void, MeshData> {

	let nv = 0, ni = 0;
	for ( const p of parts ) { nv += p.positions.length / 3; ni += p.indices.length; }
	const out: MeshData = {
		positions: new Float32Array( nv * 3 ), normals: new Float32Array( nv * 3 ), ao: new Float32Array( nv ),
		tint: new Float32Array( nv ), curv: new Float32Array( nv ), indices: new Uint32Array( ni ),
	};
	let ov = 0, oi = 0;
	for ( const p of parts ) {

		out.positions.set( p.positions, ov * 3 );
		out.normals.set( p.normals, ov * 3 );
		out.ao.set( p.ao, ov );
		out.tint.set( p.tint, ov );
		out.curv.set( p.curv, ov );
		for ( let k = 0; k < p.indices.length; k ++ ) out.indices[ oi + k ] = p.indices[ k ] + ov;
		ov += p.positions.length / 3;
		oi += p.indices.length;
		yield;

	}
	return out;

}

// The sea floor as one mesh: the chunks' near tiles in order (their lattice points placed as
// SeabedTile's `buildFloorTile` places them), then the far floor (its contact shade 1). A step a tile.
function* mergeFloor( chunks: readonly ChunkData[], far: FarFloor ): Generator<void, WorldData[ 'seabed' ]> {

	const tiles = chunks.filter( ( c ) => c.floor );
	const n = TILE_SIDE, tileVertices = n * n, nt = tiles.length * tileVertices, nv = nt + far.positions.length / 3;
	const positions = new Float32Array( nv * 3 ), normals = new Float32Array( nv * 3 );
	const ao = new Float32Array( nv ).fill( 1 ), bed = new Float32Array( nv * 2 );
	const cell = tileIndices();
	const indices = new Uint32Array( tiles.length * cell.length + far.indices.length );
	for ( let t = 0; t < tiles.length; t ++ ) {

		const c = tiles[ t ], floor = c.floor!, x0 = c.ci * SEABED_TILE, z0 = c.cj * SEABED_TILE, v0 = t * tileVertices;
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const v = v0 + j * n + i;
			positions[ v * 3 ] = x0 + i * STEP; positions[ v * 3 + 1 ] = floor.height[ j * n + i ]; positions[ v * 3 + 2 ] = z0 + j * STEP;

		}
		normals.set( floor.normal, v0 * 3 );
		ao.set( floor.ao, v0 );
		bed.set( floor.bed, v0 * 2 );
		for ( let k = 0; k < cell.length; k ++ ) indices[ t * cell.length + k ] = cell[ k ] + v0;
		yield;

	}
	positions.set( far.positions, nt * 3 );
	normals.set( far.normals, nt * 3 );
	bed.set( far.bed, nt * 2 );
	for ( let k = 0; k < far.indices.length; k ++ ) indices[ tiles.length * cell.length + k ] = far.indices[ k ] + nt;
	return { positions, normals, ao, bed, indices };

}
