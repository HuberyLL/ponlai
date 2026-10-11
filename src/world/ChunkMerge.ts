// One land version's chunks (Chunks.ts `ChunkData`) merged into the WorldData the page draws: the
// page's pool (WorldChunks.ts) and the node tools' serial path (tools/world-node.mjs) both end
// here, so they draw and check the same world. Pure (no three, no DOM).
//
// - Everything is concatenated in rows of chunks ( cj, then ci ), each chunk's owned items in its
//   own order (Chunks.ts), so the merged arrays, the meadow's pools and a paused frame are the
//   same whatever order the workers finished in.
// - The island and the stones are one mesh each, as before chunks: the chunks' owned quads
//   concatenated (a vertex on a border appears once per chunk that uses it, bit-identical, so the
//   seams shade alike). The sea floor is the chunks' near tiles in that order, then the far floor.
// - The world fields cover the land's box and 32 m round it, out to the world's 32 m grid
//   (`fieldBounds`), which holds every chunk; each chunk's texels are copied into its square:
//   the shore's distance (0.125 m; +LAND_REACH where no chunk is, as the chunks clamp it), the
//   rim ground (0.1 m; the open sea's values where no chunk is, as RimGround's assembly), the
//   floor's height (0.25 m) and its beds (0.5 m). The last two are interpolated from the chunk's
//   floor tile at the texels' centres on the meshes' diagonal, as Bathymetry's `floorAt` reads
//   the rendered floor; elsewhere they are what the land job put there (chunkWorker.ts
//   `buildLand`: the open sea's, or the shelf's ceiling under the land).

import type { ChunkData } from './Chunks.ts';
import type { LandLattice } from './IslandGrowth.ts';
import { tileIndices, SEABED_TILE, TILE_SIDE, type FarFloor } from './SeabedTile.ts';
import { mergeRimSkirts, RIM_CELL, RIM_REACH } from './RimGround.ts';
import { landBounds, ISLAND_TOP, LAND_REACH, type Bounds } from './WorldShapes.ts';
import type { MeshData, RimStrand, Rock, WorldData } from './types.ts';

// The world fields' cells (m): the shore's distance, the floor's height and the floor's beds.
export const SHORE_CELL = 0.125, FLOOR_CELL = 0.25, BED_CELL = 0.5;
// the floor tile's lattice step (m): SEABED_TILE over its TILE_SIDE - 1 cells
const STEP = SEABED_TILE / ( TILE_SIDE - 1 );

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
}

/** The world fields' bounds: the land's box and 32 m round it, out to the world's 32 m grid. A
 * chunk lies within 26 m of the land and starts on the 16 m grid, so every chunk lies inside. */
export function fieldBounds( land: LandLattice ): Bounds {

	const b = landBounds( land );
	const out = ( v: number, round: ( v: number ) => number, by: number ) => round( ( v + by ) / 32 ) * 32;
	return { x0: out( b.x0, Math.floor, - 32 ), z0: out( b.z0, Math.floor, - 32 ), x1: out( b.x1, Math.ceil, 32 ), z1: out( b.z1, Math.ceil, 32 ) };

}

/** The WorldData of a land version from all its chunks (in any order). */
export function mergeChunks( land: LandData, unordered: readonly ChunkData[] ): WorldData {

	const t0 = performance.now();
	const chunks = [ ...unordered ].sort( ( a, b ) => a.cj - b.cj || a.ci - b.ci );
	const { bounds } = land;
	const width = bounds.x1 - bounds.x0, depth = bounds.z1 - bounds.z0;

	// --- meshes
	const island = mergeMeshes( chunks.flatMap( ( c ) => c.island ? [ c.island ] : [] ) );
	const rocks: Rock[] = chunks.flatMap( ( c ) => c.stones.rocks );
	const stones = mergeMeshes( chunks.map( ( c ) => c.stones.mesh ) );
	const seabed = mergeFloor( chunks, land.far );

	// --- owned items
	const concat = ( parts: Float32Array[] ) => {

		const out = new Float32Array( parts.reduce( ( n, p ) => n + p.length, 0 ) );
		parts.reduce( ( offset, p ) => { out.set( p, offset ); return offset + p.length; }, 0 );
		return out;

	};
	const rimStrands: RimStrand[] = [];
	for ( const c of chunks ) {

		const offset = rimStrands.length;
		for ( const strand of c.strands ) rimStrands.push( strand.parent === undefined ? strand : { ...strand, parent: strand.parent + offset } );

	}

	// --- the world fields
	const shore = { data: new Float32Array( width / SHORE_CELL * depth / SHORE_CELL ).fill( LAND_REACH ), nx: width / SHORE_CELL, nz: depth / SHORE_CELL, x0: bounds.x0, z0: bounds.z0, cell: SHORE_CELL };
	const rx = Math.round( width / RIM_CELL ), rz = Math.round( depth / RIM_CELL ), ri0 = Math.round( bounds.x0 / RIM_CELL ), rj0 = Math.round( bounds.z0 / RIM_CELL );
	const rimGround = { data: new Float32Array( rx * rz * 4 ), nx: rx, nz: rz, x0: ri0 * RIM_CELL, z0: rj0 * RIM_CELL, cell: RIM_CELL };
	for ( let k = 0; k < rx * rz; k ++ ) { rimGround.data[ k * 4 ] = RIM_REACH; rimGround.data[ k * 4 + 1 ] = ISLAND_TOP; }
	const seabedField = { data: land.floor.slice(), nx: width / FLOOR_CELL, nz: depth / FLOOR_CELL, x0: bounds.x0, z0: bounds.z0, cell: FLOOR_CELL };
	const seabedBeds = { data: land.beds.slice(), nx: width / BED_CELL, nz: depth / BED_CELL, x0: bounds.x0, z0: bounds.z0, cell: BED_CELL };
	for ( const c of chunks ) {

		const x0 = c.ci * SEABED_TILE, z0 = c.cj * SEABED_TILE;
		copyTile( shore.data, shore.nx, c.shore, SEABED_TILE / SHORE_CELL, ( x0 - bounds.x0 ) / SHORE_CELL, ( z0 - bounds.z0 ) / SHORE_CELL, 1 );
		copyTile( rimGround.data, rx, c.rimGround, Math.round( SEABED_TILE / RIM_CELL ), Math.round( x0 / RIM_CELL ) - ri0, Math.round( z0 / RIM_CELL ) - rj0, 4 );
		if ( c.floor ) {

			fromTile( seabedField.data, seabedField.nx, c.floor.height, 1, FLOOR_CELL, ( x0 - bounds.x0 ) / FLOOR_CELL, ( z0 - bounds.z0 ) / FLOOR_CELL );
			fromTile( seabedBeds.data, seabedBeds.nx, c.floor.bed, 2, BED_CELL, ( x0 - bounds.x0 ) / BED_CELL, ( z0 - bounds.z0 ) / BED_CELL );

		}

	}

	const chunkList = new Int32Array( chunks.length * 2 );
	chunks.forEach( ( c, k ) => { chunkList[ k * 2 ] = c.ci; chunkList[ k * 2 + 1 ] = c.cj; } );
	return {
		land: land.land, chunks: chunkList,
		meshes: [ { name: 'island', kind: 'cliff', ...island }, { name: 'rocks', kind: 'rock', ...stones } ],
		rocks, seabed,
		vegetation: concat( chunks.map( ( c ) => c.anchors ) ),
		bushes: concat( chunks.map( ( c ) => c.bushes ) ),
		rimStrands, rimGround,
		rimSkirt: mergeRimSkirts( chunks.map( ( c ) => c.skirt ) ),
		shore, seabedField, seabedBeds,
		timings: { merge: Math.round( performance.now() - t0 ) },
	};

}

// A square tile of n x n texels ( `channels` floats each) into a field nx wide at texel ( i0, j0 ).
function copyTile( out: Float32Array, nx: number, tile: Float32Array, n: number, i0: number, j0: number, channels: number ): void {

	for ( let j = 0; j < n; j ++ ) out.set( tile.subarray( j * n * channels, ( j + 1 ) * n * channels ), ( ( j0 + j ) * nx + i0 ) * channels );

}

// The floor tile's lattice values ( `channels` per point) at the centres of a field's cells of
// `cell` m over the tile's square, interpolated on the triangles the floor's meshes draw (split by
// the diagonal from ( i + 1, j ) to ( i, j + 1 ), as Bathymetry's `floorAt`), into a field nx
// wide at cell ( i0, j0 ).
function fromTile( out: Float32Array, nx: number, tile: Float32Array, channels: number, cell: number, i0: number, j0: number ): void {

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

// Meshes concatenated in order, one index space; `detail` and `detail2` when the first has them
// (every island chunk carries both, Chunks.ts).
function mergeMeshes( parts: MeshData[] ): MeshData {

	let nv = 0, ni = 0;
	for ( const p of parts ) { nv += p.positions.length / 3; ni += p.indices.length; }
	const detail = parts[ 0 ]?.detail !== undefined;
	const out: MeshData = {
		positions: new Float32Array( nv * 3 ), normals: new Float32Array( nv * 3 ), ao: new Float32Array( nv ),
		tint: new Float32Array( nv ), curv: new Float32Array( nv ), indices: new Uint32Array( ni ),
		...( detail ? { detail: new Float32Array( nv * 4 ), detail2: new Float32Array( nv * 3 ) } : {} ),
	};
	let ov = 0, oi = 0;
	for ( const p of parts ) {

		out.positions.set( p.positions, ov * 3 );
		out.normals.set( p.normals, ov * 3 );
		out.ao.set( p.ao, ov );
		out.tint.set( p.tint, ov );
		out.curv.set( p.curv, ov );
		if ( detail ) { out.detail!.set( p.detail!, ov * 4 ); out.detail2!.set( p.detail2!, ov * 3 ); }
		for ( let k = 0; k < p.indices.length; k ++ ) out.indices[ oi + k ] = p.indices[ k ] + ov;
		ov += p.positions.length / 3;
		oi += p.indices.length;

	}
	return out;

}

// The sea floor as one mesh: the chunks' near tiles in order (their lattice points placed as
// SeabedTile's `buildFloorTile` places them), then the far floor (its contact shade 1).
function mergeFloor( chunks: readonly ChunkData[], far: FarFloor ): WorldData[ 'seabed' ] {

	const tiles = chunks.filter( ( c ) => c.floor );
	const n = TILE_SIDE, tileVertices = n * n, nt = tiles.length * tileVertices, nv = nt + far.positions.length / 3;
	const positions = new Float32Array( nv * 3 ), normals = new Float32Array( nv * 3 );
	const ao = new Float32Array( nv ).fill( 1 ), bed = new Float32Array( nv * 2 );
	const cell = tileIndices();
	const indices = new Uint32Array( tiles.length * cell.length + far.indices.length );
	tiles.forEach( ( c, t ) => {

		const floor = c.floor!, x0 = c.ci * SEABED_TILE, z0 = c.cj * SEABED_TILE, v0 = t * tileVertices;
		for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const v = v0 + j * n + i;
			positions[ v * 3 ] = x0 + i * STEP; positions[ v * 3 + 1 ] = floor.height[ j * n + i ]; positions[ v * 3 + 2 ] = z0 + j * STEP;

		}
		normals.set( floor.normal, v0 * 3 );
		ao.set( floor.ao, v0 );
		bed.set( floor.bed, v0 * 2 );
		for ( let k = 0; k < cell.length; k ++ ) indices[ t * cell.length + k ] = cell[ k ] + v0;

	} );
	positions.set( far.positions, nt * 3 );
	normals.set( far.normals, nt * 3 );
	bed.set( far.bed, nt * 2 );
	for ( let k = 0; k < far.indices.length; k ++ ) indices[ tiles.length * cell.length + k ] = far.indices[ k ] + nt;
	return { positions, normals, ao, bed, indices };

}
