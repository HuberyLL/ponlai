// The sea floor's meshes: a near tile for every world-anchored 16 m cell of floor the land shapes
// (but those under the land), and one far mesh on the open sea's 4 m lattice round them. A tile is
// a function of its cell and the land within LAND_REACH (plus the contact shade's 1.5 m) of it
// alone: its lattice is anchored to the world, its normals are differences of the floor function
// rather than of its own triangles, so two tiles compute their shared border vertices alike, bit
// for bit, and a tile stays as it was wherever the land changes farther away.
// The shoal's pure part lives here too (`pendingFloors`, `riseTile`: SeabedRise.ts draws it, and
// tools/verify-world-chunks.mjs R1 checks it in node).

import { FLOOR_STEP, OPEN_LATTICE, openSeaBeds, openSeaHeight, seabedBeds, seabedFloor } from './Bathymetry.ts';
import { LAND_REACH, type Footprint } from './WorldShapes.ts';
import { GROWTH, type LandLattice } from './IslandGrowth.ts';
import { contactVisibilitySampler, type SolidBounds } from '../lighting/SkyOcclusion.ts';

export const SEABED_TILE = 16;
// The sea floor's albedo: the means of its pale sand and its rubble at gain 1, and the gain all that
// lies on the floor takes (SeabedLook.ts its sand, seagrass and rubble, TerrainMaterial.ts the silt on
// the submerged stones), so that its parts keep their order, the sand the lightest, and what the
// floor bounces up (GroundBounce.ts) and what the ambient probes see of it (AmbientProbes.ts) stay the
// floor the eye sees. It lives here because SeabedLook.ts imports three and the probes are built in
// the chunk workers.
export const FLOOR_ALBEDO = { sand: [ 0.46, 0.435, 0.365 ], rubble: [ 0.29, 0.285, 0.25 ], gain: 0.35 } as const;
// vertices along a tile's side
export const TILE_SIDE = SEABED_TILE / FLOOR_STEP + 1;
// A cell gets a tile (and a chunk exists, Chunks.ts) when land lies this close to it (m):
// LAND_REACH, and 2 m for the footprint's rounded corners and raster. Farther out the floor is the
// open sea's, which the far floor draws.
export const TILE_REACH = LAND_REACH + 2;
// The far floor covers the land lattice and 128 m round it: this far from the world's centre (m).
export const FAR_HALF = GROWTH.half + 128;

/** A floor tile's shape and beds, TILE_SIDE x TILE_SIDE points row by row: heights, normals (3 per
 * point) and beds (2 per point). */
export interface FloorShape { height: Float32Array; normal: Float32Array; bed: Float32Array }

export interface FloorTile {
	ci: number; cj: number;
	// TILE_SIDE x TILE_SIDE vertices, row by row (z, then x)
	positions: Float32Array;
	normals: Float32Array;
	// contact visibility of the island and stones
	ao: Float32Array;
	// seagrass cover and pale-sand share (seabedBeds)
	bed: Float32Array;
}

// The normal of a heightfield from its slopes, by central differences 2 * FLOOR_STEP wide.
function normalOf( out: Float32Array, o: number, west: number, east: number, south: number, north: number ): void {

	const nx = ( west - east ) / ( 2 * FLOOR_STEP ), nz = ( south - north ) / ( 2 * FLOOR_STEP );
	const l = Math.hypot( nx, 1, nz );
	out[ o ] = nx / l; out[ o + 1 ] = 1 / l; out[ o + 2 ] = nz / l;

}

/**
 * The near tile of cell ( ci, cj ): the floor over x in [ 16 ci, 16 ci + 16 ], z likewise, on the
 * world's 0.5 m lattice (shared with the neighbours on the borders), with its contact shade from
 * `solids` (those that shade the floor: the island and its stones).
 */
export function buildFloorTile( ci: number, cj: number, fp: Footprint, solids: readonly SolidBounds[] ): FloorTile {

	const n = TILE_SIDE, step = FLOOR_STEP;
	const x0 = ci * SEABED_TILE, z0 = cj * SEABED_TILE;
	// the floor's heights with one point of apron round the tile, for the border normals
	const floor = seabedFloor( fp ), beds = seabedBeds( fp );
	const m = n + 2, h = new Float64Array( m * m );
	for ( let j = 0; j < m; j ++ ) for ( let i = 0; i < m; i ++ ) h[ j * m + i ] = floor( x0 + ( i - 1 ) * step, z0 + ( j - 1 ) * step );

	const positions = new Float32Array( n * n * 3 ), normals = new Float32Array( n * n * 3 );
	const ao = new Float32Array( n * n ), bed = new Float32Array( n * n * 2 );
	// only the solids within the contact radius of the tile can shade it
	const radius = 1.5;
	const near = solids.filter( ( s ) => s.min[ 0 ] < x0 + SEABED_TILE + radius && s.max[ 0 ] > x0 - radius
		&& s.min[ 2 ] < z0 + SEABED_TILE + radius && s.max[ 2 ] > z0 - radius );
	const contact = contactVisibilitySampler( near, undefined, { radius } );
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const v = j * n + i, k = ( j + 1 ) * m + i + 1;
		const x = x0 + i * step, z = z0 + j * step;
		positions[ v * 3 ] = x; positions[ v * 3 + 1 ] = h[ k ]; positions[ v * 3 + 2 ] = z;
		normalOf( normals, v * 3, h[ k - 1 ], h[ k + 1 ], h[ k - m ], h[ k + m ] );
		ao[ v ] = near.length ? contact( x, positions[ v * 3 + 1 ], z, normals[ v * 3 ], normals[ v * 3 + 1 ], normals[ v * 3 + 2 ] ) : 1;
		const [ grass, pale ] = beds( x, z, h[ k ] );
		bed[ v * 2 ] = grass; bed[ v * 2 + 1 ] = pale;

	}
	return { ci, cj, positions, normals, ao, bed };

}

/**
 * The cells ( ci, cj ) the land shapes the floor in, in row order: every 16 m cell with land within
 * 26 m. The far floor leaves them out; all but those under the land get a near tile.
 */
export function nearLandCells( land: LandLattice ): [ number, number ][] {

	const w = land.cells(), cell = GROWTH.cell, X0 = - GROWTH.half;
	const S = SEABED_TILE, R = TILE_REACH;
	const near = new Set<number>();
	const key = ( ci: number, cj: number ) => ( ci + 1024 ) * 2048 + cj + 1024;
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) {

		if ( ! land.has( i, j ) ) continue;
		// the land cell's square, and the tiles whose square lies within the reach of it
		const x0 = X0 + i * cell, z0 = X0 + j * cell, x1 = x0 + cell, z1 = z0 + cell;
		for ( let cj = Math.floor( ( z0 - R ) / S ); cj <= Math.floor( ( z1 + R ) / S ); cj ++ ) {

			const dz = Math.max( cj * S - z1, 0, z0 - ( cj + 1 ) * S );
			for ( let ci = Math.floor( ( x0 - R ) / S ); ci <= Math.floor( ( x1 + R ) / S ); ci ++ ) {

				const dx = Math.max( ci * S - x1, 0, x0 - ( ci + 1 ) * S );
				if ( dx * dx + dz * dz <= R * R ) near.add( key( ci, cj ) );

			}

		}

	}
	return [ ...near ].sort( ( a, b ) => ( a % 2048 ) - ( b % 2048 ) || a - b ).map( ( k ) => [ Math.floor( k / 2048 ) - 1024, k % 2048 - 1024 ] );

}

/** Whether the land covers cell ( ci, cj ) and 2 m round it: its floor lies inside the island's
 * solid, never seen, and its neighbours' borders with it too. */
export function underLand( land: LandLattice, ci: number, cj: number ): boolean {

	const cell = GROWTH.cell, X0 = - GROWTH.half, S = SEABED_TILE, m = 2;
	const i0 = Math.floor( ( ci * S - m - X0 ) / cell ), i1 = Math.ceil( ( ci * S + S + m - X0 ) / cell );
	const j0 = Math.floor( ( cj * S - m - X0 ) / cell ), j1 = Math.ceil( ( cj * S + S + m - X0 ) / cell );
	for ( let j = j0; j < j1; j ++ ) for ( let i = i0; i < i1; i ++ ) {

		if ( ! land.inside( X0 + ( i + 0.5 ) * cell, X0 + ( j + 0.5 ) * cell ) ) return false;

	}
	return true;

}

/** The cells ( ci, cj ) that get a near tile, in row order: those of `nearLandCells` not under the land. */
export function floorTileCells( land: LandLattice ): [ number, number ][] {

	return nearLandCells( land ).filter( ( [ ci, cj ] ) => ! underLand( land, ci, cj ) );

}

export interface FarFloor {
	positions: Float32Array;
	normals: Float32Array;
	bed: Float32Array;
	// the lattice's cells but those under near tiles
	indices: Uint32Array;
}


/**
 * The far floor: the open sea's lattice over the land lattice and 128 m round it, its cells in
 * the 16 m cells `near` (`nearLandCells`) left out: the near tiles meet it there at the same
 * heights, and the cells without a tile lie under the land.
 */
export function buildFarFloor( near: readonly [ number, number ][] ): FarFloor {

	const L = OPEN_LATTICE, X0 = - FAR_HALF, n = 2 * FAR_HALF / L;
	const positions = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 ), normals = new Float32Array( positions.length );
	const bed = new Float32Array( ( n + 1 ) * ( n + 1 ) * 2 );
	for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const v = j * ( n + 1 ) + i, x = X0 + i * L, z = X0 + j * L;
		positions[ v * 3 ] = x; positions[ v * 3 + 1 ] = openSeaHeight( x, z ); positions[ v * 3 + 2 ] = z;
		// by the same differences as a tile's, so a tile and the far floor shade the nodes they
		// share alike
		const h = openSeaHeight;
		normalOf( normals, v * 3, h( x - FLOOR_STEP, z ), h( x + FLOOR_STEP, z ), h( x, z - FLOOR_STEP ), h( x, z + FLOOR_STEP ) );
		const [ grass, pale ] = openSeaBeds( x, z );
		bed[ v * 2 ] = grass; bed[ v * 2 + 1 ] = pale;

	}
	const covered = new Set( near.map( ( [ ci, cj ] ) => `${ ci },${ cj }` ) );
	const indices: number[] = [];
	for ( let j = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

		const ci = Math.floor( ( X0 + i * L ) / SEABED_TILE ), cj = Math.floor( ( X0 + j * L ) / SEABED_TILE );
		if ( covered.has( `${ ci },${ cj }` ) ) continue;
		const a = j * ( n + 1 ) + i;
		indices.push( a, a + n + 1, a + 1, a + 1, a + n + 1, a + n + 2 );

	}
	return { positions, normals, bed, indices: new Uint32Array( indices ) };

}

// Two triangles per lattice cell of a tile, split as the open sea's lattice is.
export function tileIndices(): Uint32Array {

	const n = TILE_SIDE, idx = new Uint32Array( ( n - 1 ) * ( n - 1 ) * 6 );
	for ( let j = 0, k = 0; j < n - 1; j ++ ) for ( let i = 0; i < n - 1; i ++ ) {

		const a = j * n + i;
		idx[ k ++ ] = a; idx[ k ++ ] = a + n; idx[ k ++ ] = a + 1;
		idx[ k ++ ] = a + 1; idx[ k ++ ] = a + n; idx[ k ++ ] = a + n + 1;

	}
	return idx;

}

// ------------------------------------------------------------------ the shoal

// A tile of the shown land rises toward the next version's tile as the next piece nears
// (SeabedRise.ts). A cell the next version gives a tile and the shown one draws as the far floor
// (a cell the new land brings within TILE_REACH: a "born" cell) rises with the far floor's own
// nodes, on its 4 m lattice, toward the next tile's values there (`BornNode`); along a side a
// pending tile shares with a born cell, the far floor's edge runs straight between those nodes, so
// the tile's points there rise toward the straight line between the next tile's values at the
// nodes instead of toward the next tile's own (`pendingFloors`), and the two never part. At the
// swap those points, and the born cells' floor between the nodes, take the next tile's detail.

/** What the shoal reads of a chunk (Chunks.ts ChunkData). */
export interface FloorChunk { key: string; ci: number; cj: number; floor: FloorShape | null; floorUnder: FloorShape | null }

/** A tile of the shown version that rises: its first point in the merged floor (`v0`: the shown
 * tiles' order), its shown shape and the shape it rises to (the next version's tile, its sides
 * along born cells straightened between the far floor's nodes), the lattice rows [ row0, row1 )
 * where anything moves, its largest change of height (m), and how many points were straightened. */
export interface PendingFloor { ci: number; cj: number; v0: number; from: FloorShape; to: FloorShape; row0: number; row1: number; rise: number; straightened: number }

/** A node of the far floor's lattice on a born cell: its position and the next tile's height,
 * normal and beds there. */
export interface BornNode { x: number; z: number; height: number; normal: [ number, number, number ]; bed: [ number, number ] }

// Whether two arrays hold the same bits.
function sameBits( a: Float32Array, b: Float32Array ): boolean {

	const x = new Uint32Array( a.buffer, a.byteOffset, a.length ), y = new Uint32Array( b.buffer, b.byteOffset, b.length );
	for ( let k = 0; k < x.length; k ++ ) if ( x[ k ] !== y[ k ] ) return false;
	return true;

}

// the tile's lattice points per open sea lattice cell
const PER_NODE = OPEN_LATTICE / FLOOR_STEP;

// `shape`'s points along side ( di, dj ) of the tile (one of the four), straightened between the
// open sea lattice's nodes: heights and beds linear, normals linear and normalised. Returns how many
// points changed.
function straighten( shape: FloorShape, di: number, dj: number ): number {

	const n = TILE_SIDE;
	let changed = 0;
	const at = ( k: number ) => {

		const i = di === - 1 ? 0 : di === 1 ? n - 1 : k, j = dj === - 1 ? 0 : dj === 1 ? n - 1 : k;
		return j * n + i;

	};
	for ( let k = 0; k < n; k ++ ) {

		const f = ( k % PER_NODE ) / PER_NODE;
		if ( f === 0 ) continue;
		const v = at( k ), a = at( k - k % PER_NODE ), b = at( k - k % PER_NODE + PER_NODE );
		const lerp = ( arr: Float32Array, c: number, o: number ) => ( 1 - f ) * arr[ a * c + o ] + f * arr[ b * c + o ];
		shape.height[ v ] = lerp( shape.height, 1, 0 );
		shape.bed[ v * 2 ] = lerp( shape.bed, 2, 0 );
		shape.bed[ v * 2 + 1 ] = lerp( shape.bed, 2, 1 );
		const nx = lerp( shape.normal, 3, 0 ), ny = lerp( shape.normal, 3, 1 ), nz = lerp( shape.normal, 3, 2 ), l = Math.hypot( nx, ny, nz );
		shape.normal[ v * 3 ] = nx / l; shape.normal[ v * 3 + 1 ] = ny / l; shape.normal[ v * 3 + 2 ] = nz / l;
		changed ++;

	}
	return changed;

}

/**
 * What a growth step moves of the shown floor, a tile a step: the tiles of `shown` (a version's
 * chunks in their order, the merged floor's) whose floor differs from the next version's chunk's
 * (its tile, or its `floorUnder` where the new land covers the cell), and the far floor's nodes on
 * the born cells (the chunks of `next` that `shown` lacks: chunks exist on the cells with land
 * within TILE_REACH, `nearLandCells`), each once.
 */
export function* pendingFloors( shown: readonly FloorChunk[], next: readonly FloorChunk[] ): Generator<void, { tiles: PendingFloor[]; nodes: BornNode[] }> {

	const key = ( ci: number, cj: number ) => `${ ci },${ cj }`;
	const before = new Set( shown.map( ( c ) => c.key ) );
	const born = new Map( next.filter( ( c ) => c.floor && ! before.has( c.key ) ).map( ( c ) => [ c.key, c.floor! ] ) );
	const after = new Map( next.map( ( c ) => [ c.key, c ] ) );
	const n = TILE_SIDE, tiles: PendingFloor[] = [];
	let slot = 0;
	for ( const c of shown ) {

		if ( ! c.floor ) continue;
		const v0 = slot ++ * n * n, other = after.get( c.key );
		const from = c.floor, next = other && other !== c ? other.floor ?? other.floorUnder : null;
		if ( ! next || ( sameBits( from.height, next.height ) && sameBits( from.normal, next.normal ) && sameBits( from.bed, next.bed ) ) ) continue;
		let to: FloorShape = { height: next.height, normal: next.normal, bed: next.bed }, straightened = 0;
		for ( const [ di, dj ] of [ [ - 1, 0 ], [ 1, 0 ], [ 0, - 1 ], [ 0, 1 ] ] ) {

			if ( ! born.has( key( c.ci + di, c.cj + dj ) ) ) continue;
			if ( to.height === next.height ) to = { height: next.height.slice(), normal: next.normal.slice(), bed: next.bed.slice() };
			straightened += straighten( to, di, dj );

		}
		let row0 = n, row1 = 0, rise = 0;
		for ( let v = 0; v < n * n; v ++ ) {

			const moves = from.height[ v ] !== to.height[ v ] || from.bed[ v * 2 ] !== to.bed[ v * 2 ] || from.bed[ v * 2 + 1 ] !== to.bed[ v * 2 + 1 ]
				|| from.normal[ v * 3 ] !== to.normal[ v * 3 ] || from.normal[ v * 3 + 1 ] !== to.normal[ v * 3 + 1 ] || from.normal[ v * 3 + 2 ] !== to.normal[ v * 3 + 2 ];
			if ( ! moves ) continue;
			const row = Math.floor( v / n );
			row0 = Math.min( row0, row ); row1 = Math.max( row1, row + 1 );
			rise = Math.max( rise, Math.abs( to.height[ v ] - from.height[ v ] ) );

		}
		if ( row1 > row0 ) tiles.push( { ci: c.ci, cj: c.cj, v0, from: { height: from.height, normal: from.normal, bed: from.bed }, to, row0, row1, rise, straightened } );
		yield;

	}
	const nodes = new Map<string, BornNode>();
	for ( const [ k, floor ] of born ) {

		const c = after.get( k )!;
		for ( let j = 0; j < n; j += PER_NODE ) for ( let i = 0; i < n; i += PER_NODE ) {

			const x = c.ci * SEABED_TILE + i * FLOOR_STEP, z = c.cj * SEABED_TILE + j * FLOOR_STEP, v = j * n + i;
			nodes.set( `${ x },${ z }`, { x, z, height: floor.height[ v ], normal: [ floor.normal[ v * 3 ], floor.normal[ v * 3 + 1 ], floor.normal[ v * 3 + 2 ] ], bed: [ floor.bed[ v * 2 ], floor.bed[ v * 2 + 1 ] ] } );

		}
		yield;

	}
	return { tiles, nodes: [ ...nodes.values() ] };

}

/** `a` and `b` mixed by weight w: `a` at 0 and `b` at 1, bit for bit. */
export function mix( a: number, b: number, w: number ): number {

	return w === 0 ? a : w === 1 ? b : ( 1 - w ) * a + w * b;

}

/**
 * Tile `from` risen toward `to` by `r` (0 .. 1): the heights and beds mixed, the normals mixed and
 * normalised. Writes the heights into `positions`' y, the normals and the beds from point `v0` on
 * (the merged floor's layout).
 */
export function riseTile( from: FloorShape, to: FloorShape, r: number, positions: Float32Array, normals: Float32Array, beds: Float32Array, v0: number ): void {

	const count = from.height.length;
	for ( let v = 0; v < count; v ++ ) {

		const o = ( v0 + v ) * 3;
		positions[ o + 1 ] = mix( from.height[ v ], to.height[ v ], r );
		beds[ ( v0 + v ) * 2 ] = mix( from.bed[ v * 2 ], to.bed[ v * 2 ], r );
		beds[ ( v0 + v ) * 2 + 1 ] = mix( from.bed[ v * 2 + 1 ], to.bed[ v * 2 + 1 ], r );
		if ( r === 0 || r === 1 ) {

			const n = r === 0 ? from.normal : to.normal;
			normals[ o ] = n[ v * 3 ]; normals[ o + 1 ] = n[ v * 3 + 1 ]; normals[ o + 2 ] = n[ v * 3 + 2 ];
			continue;

		}
		const nx = mix( from.normal[ v * 3 ], to.normal[ v * 3 ], r );
		const ny = mix( from.normal[ v * 3 + 1 ], to.normal[ v * 3 + 1 ], r );
		const nz = mix( from.normal[ v * 3 + 2 ], to.normal[ v * 3 + 2 ], r );
		const l = Math.hypot( nx, ny, nz );
		normals[ o ] = nx / l; normals[ o + 1 ] = ny / l; normals[ o + 2 ] = nz / l;

	}

}
