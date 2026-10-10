// The sea floor's near tiles (src/world/SeabedTile.ts), for tools/verify-world-local.mjs.
//
// The sub-box case: the floor's lattice vertices (position, normal, contact shade, beds) inside a
// box, each taken from the tile that owns it, against the same box built as 2 x 2 sub-boxes.
// `setup` also asserts, per seed and step:
//   - the vertices two neighbouring tiles share are identical in every attribute, bit for bit;
//   - on the tiles' outer border (next to a cell the far floor draws) the floor is the open sea's
//     lattice: the far floor's own vertices, normals and beds at its nodes, bit for bit;
//   - every tile the page builds (from the footprint over the whole land) has the floor, normals
//     and beds of the same tile built as a chunk would build it (below), bit for bit, so a chunk
//     rebuilt alone meets the tiles round it without a crack;
//   - the floor stays at or below -1.6 m off the land;
//   - a tile is byte-identical when only land more than 32 m from it changes (the next growth
//     step's piece), built as a chunk would build it: from a footprint over the tile and 32 m round
//     it, and the island's solid over the tile and 26 m round it.
// The contact shade here comes from the island alone: the stones become local in their own task.
import assert from 'node:assert/strict';
import { growLand, GROWTH } from '../../src/world/IslandGrowth.ts';
import { buildFootprint, makeIslandSDF, ISLAND_BOTTOM, ISLAND_TOP } from '../../src/world/WorldShapes.ts';
import { openSeaHeight, SHELF_CEILING } from '../../src/world/Bathymetry.ts';
import { buildFarFloor, buildFloorTile, floorTileCells, nearLandCells, FAR_HALF, SEABED_TILE, TILE_SIDE } from '../../src/world/SeabedTile.ts';

export const name = 'seabed';

const S = SEABED_TILE, N = TILE_SIDE;
const key = ( ci, cj ) => `${ ci },${ cj }`;

// the island's solid `field` as it shades the floor within `box`
function islandSolid( field, box ) {

	return { field, min: [ box.x0, ISLAND_BOTTOM - 0.3, box.z0 ], max: [ box.x1, ISLAND_TOP + 0.6, box.z1 ] };

}

const grownBox = ( b, by ) => ( { x0: b.x0 - by, z0: b.z0 - by, x1: b.x1 + by, z1: b.z1 + by } );
const tileBox = ( ci, cj ) => ( { x0: ci * S, z0: cj * S, x1: ci * S + S, z1: cj * S + S } );

// Every attribute of vertex v of a tile, as raw float32 bits.
function vertexBits( tile, v ) {

	const f = new Float32Array( [ ...tile.positions.subarray( v * 3, v * 3 + 3 ), ...tile.normals.subarray( v * 3, v * 3 + 3 ), tile.ao[ v ], ...tile.bed.subarray( v * 2, v * 2 + 2 ) ] );
	return Array.from( new Uint32Array( f.buffer ) ).join( ' ' );

}

function checkBorders( tiles ) {

	let shared = 0;
	for ( const tile of tiles.values() ) for ( const [ di, dj ] of [ [ 1, 0 ], [ 0, 1 ] ] ) {

		const next = tiles.get( key( tile.ci + di, tile.cj + dj ) );
		if ( ! next ) continue;
		for ( let k = 0; k < N; k ++ ) {

			// this tile's last column (row) against the next one's first
			const a = di ? k * N + N - 1 : ( N - 1 ) * N + k, b = di ? k * N : k;
			assert.equal( vertexBits( tile, a ), vertexBits( next, b ), `tiles ${ key( tile.ci, tile.cj ) } and ${ key( next.ci, next.cj ) } differ at their border vertex ${ k }` );
			shared ++;

		}

	}
	return shared;

}

function checkFarBorder( tiles, near, far ) {

	const L = 4, n = 2 * FAR_HALF / L, node = ( x, z ) => ( ( z + FAR_HALF ) / L ) * ( n + 1 ) + ( x + FAR_HALF ) / L;
	let checked = 0, nodes = 0;
	for ( const tile of tiles.values() ) for ( const [ di, dj ] of [ [ - 1, 0 ], [ 1, 0 ], [ 0, - 1 ], [ 0, 1 ] ] ) {

		// a neighbour with a tile, or under the land, is no border with the far floor
		if ( near.has( key( tile.ci + di, tile.cj + dj ) ) ) continue;
		for ( let k = 0; k < N; k ++ ) {

			const i = di === - 1 ? 0 : di === 1 ? N - 1 : k, j = dj === - 1 ? 0 : dj === 1 ? N - 1 : k, v = j * N + i;
			const x = tile.positions[ v * 3 ], y = tile.positions[ v * 3 + 1 ], z = tile.positions[ v * 3 + 2 ];
			assert.equal( y, Math.fround( openSeaHeight( x, z ) ), `tile ${ key( tile.ci, tile.cj ) } leaves the open sea at its outer border ( ${ x }, ${ z } )` );
			assert.equal( tile.ao[ v ], 1, `tile ${ key( tile.ci, tile.cj ) } is shaded at its outer border ( ${ x }, ${ z } )` );
			checked ++;
			if ( x % L !== 0 || z % L !== 0 ) continue;
			const f = node( x, z );
			for ( let c = 0; c < 3; c ++ ) {

				assert.equal( tile.positions[ v * 3 + c ], far.positions[ f * 3 + c ], `the far floor's node ( ${ x }, ${ z } ) is not the tile's vertex` );
				assert.equal( tile.normals[ v * 3 + c ], far.normals[ f * 3 + c ], `the far floor's normal at ( ${ x }, ${ z } ) is not the tile's` );

			}
			for ( let c = 0; c < 2; c ++ ) assert.equal( tile.bed[ v * 2 + c ], far.bed[ f * 2 + c ], `the far floor's beds at ( ${ x }, ${ z } ) are not the tile's` );
			nodes ++;

		}

	}
	return { checked, nodes };

}

// The tile ( ci, cj ) as a chunk would build it from `land`, which it sees only through a window;
// shaded by the island unless `shaded` is false.
function windowTile( land, ci, cj, shaded = true ) {

	const t = tileBox( ci, cj );
	const fp = buildFootprint( land, grownBox( t, 32 ) );
	const area = grownBox( t, 26 );
	// (the cliff evaluated in a box reads the land within 25 m of it: makeIslandSDF's area)
	return buildFloorTile( ci, cj, fp, shaded ? [ islandSolid( makeIslandSDF( fp, grownBox( area, 25 ) ), area ) ] : [] );

}

// The page's tiles against the chunk's, unshaded. The cliff is local given the same land distance,
// but a chunk's footprint reads that distance with other last bits than the page's (the fine
// field's origin follows its window): the floor's float32 vertices round that away, the cliff's
// scar choices may not (seed 2 grow 8 shades one vertex 0.625 on the page and 0.75 in a chunk).
function checkChunkBuild( land, fp, cells ) {

	for ( const [ ci, cj ] of cells ) {

		const page = buildFloorTile( ci, cj, fp, [] ), chunk = windowTile( land, ci, cj, false );
		for ( const k of [ 'positions', 'normals', 'bed' ] ) {

			assert.ok( Buffer.from( page[ k ].buffer ).equals( Buffer.from( chunk[ k ].buffer ) ), `tile ${ key( ci, cj ) }'s ${ k } differ between the page's build and a chunk's` );

		}

	}
	return cells.length;

}

const sameTile = ( a, b ) => [ 'positions', 'normals', 'ao', 'bed' ].every( ( k ) =>
	Buffer.from( a[ k ].buffer ).equals( Buffer.from( b[ k ].buffer ) ) );

function checkLocality( seed, grow ) {

	const before = growLand( seed, grow ).land, after = growLand( seed, grow + 1 ).land;
	// the cells the next step adds (fillets and filled lakes included)
	const added = [];
	const w = after.cells();
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) {

		if ( after.has( i, j ) && ! before.has( i, j ) ) added.push( [ - GROWTH.half + ( i + 0.5 ) * GROWTH.cell, - GROWTH.half + ( j + 0.5 ) * GROWTH.cell ] );

	}
	const distance = ( [ ci, cj ] ) => {

		let m = Infinity;
		for ( const [ x, z ] of added ) m = Math.min( m, Math.hypot( Math.max( ci * S - x, 0, x - ci * S - S ), Math.max( cj * S - z, 0, z - cj * S - S ) ) );
		return m - GROWTH.cell;

	};
	const cells = [ ...new Map( [ ...floorTileCells( before ), ...floorTileCells( after ) ].map( ( c ) => [ key( ...c ), c ] ) ).values() ]
		.map( ( c ) => [ c, distance( c ) ] );
	// the tiles just beyond 32 m of the new piece must not change; one next to it, for contrast, does
	const far = cells.filter( ( [ , d ] ) => d > 32 ).sort( ( a, b ) => a[ 1 ] - b[ 1 ] ).slice( 0, 3 );
	for ( const [ [ ci, cj ], d ] of far ) {

		assert.ok( sameTile( windowTile( before, ci, cj ), windowTile( after, ci, cj ) ), `tile ${ key( ci, cj ) }, ${ d.toFixed( 1 ) } m from the new piece, changed with it` );

	}
	const [ [ [ ni, nj ] ] ] = cells.sort( ( a, b ) => a[ 1 ] - b[ 1 ] );
	assert.ok( ! sameTile( windowTile( before, ni, nj ), windowTile( after, ni, nj ) ), `tile ${ key( ni, nj ) } under the new piece did not change` );
	return { added: added.length, unchanged: far.map( ( [ c, d ] ) => `${ key( ...c ) } (${ d.toFixed( 1 ) } m)` ), near: key( ni, nj ) };

}

export async function setup( { seed, grow } ) {

	const { land } = growLand( seed, grow );
	const fp = buildFootprint( land );
	const solids = [ islandSolid( makeIslandSDF( fp ), grownBox( fp.bounds, 2.6 ) ) ];
	const cells = floorTileCells( land );
	const tiles = new Map( cells.map( ( [ ci, cj ] ) => [ key( ci, cj ), buildFloorTile( ci, cj, fp, solids ) ] ) );

	const shared = checkBorders( tiles );
	const near = nearLandCells( land );
	const { checked, nodes } = checkFarBorder( tiles, new Set( near.map( ( c ) => key( ...c ) ) ), buildFarFloor( near ) );
	const chunks = checkChunkBuild( land, fp, cells );
	let highest = - Infinity;
	for ( const tile of tiles.values() ) for ( let v = 0; v < N * N; v ++ ) {

		if ( fp.dist( tile.positions[ v * 3 ], tile.positions[ v * 3 + 2 ] ) > 0 ) highest = Math.max( highest, tile.positions[ v * 3 + 1 ] );

	}
	assert.ok( highest <= SHELF_CEILING, `the floor rises to ${ highest } m off the land` );
	const local = checkLocality( seed, grow );
	console.log( `     seabed seed ${ seed } grow ${ grow }: ${ tiles.size } tiles (${ near.length - tiles.size } cells under the land), ` +
		`${ chunks } equal to a chunk's build, ${ shared } shared border vertices equal, ` +
		`${ checked } outer border vertices on the open sea (${ nodes } far nodes equal), highest floor off the land ${ highest.toFixed( 3 ) } m; ` +
		`next piece (${ local.added } cells): tiles ${ local.unchanged.join( ', ' ) } unchanged, tile ${ local.near } under it changed` );

	// a box of 2 x 2 tiles over the coast nearest the land's middle, off the tile grid
	const b = fp.bounds, cx = Math.round( ( b.x0 + b.x1 ) / 2 ), z = Math.round( b.z0 ) - 2;
	return { fp, solids, cells: new Set( cells.map( ( c ) => key( ...c ) ) ), boxes: [ { x0: cx - 10, z0: z - 15, x1: cx + 22, z1: z + 17 } ] };

}

export function build( ctx, box ) {

	const out = { positions: [], normals: [], ao: [], bed: [] };
	for ( let cj = Math.floor( box.z0 / S ); cj <= Math.floor( box.z1 / S ); cj ++ ) for ( let ci = Math.floor( box.x0 / S ); ci <= Math.floor( box.x1 / S ); ci ++ ) {

		if ( ! ctx.cells.has( key( ci, cj ) ) ) continue;
		const tile = buildFloorTile( ci, cj, ctx.fp, ctx.solids );
		// the tile's own vertices (its last row and column are its neighbours') inside the box
		for ( let j = 0; j < N - 1; j ++ ) for ( let i = 0; i < N - 1; i ++ ) {

			const v = j * N + i, x = tile.positions[ v * 3 ], z = tile.positions[ v * 3 + 2 ];
			if ( x < box.x0 || x >= box.x1 || z < box.z0 || z >= box.z1 ) continue;
			out.positions.push( ...tile.positions.subarray( v * 3, v * 3 + 3 ) );
			out.normals.push( ...tile.normals.subarray( v * 3, v * 3 + 3 ) );
			out.ao.push( tile.ao[ v ] );
			out.bed.push( ...tile.bed.subarray( v * 2, v * 2 + 2 ) );

		}

	}
	return {
		positions: { records: new Float32Array( out.positions ), stride: 3 },
		normals: { records: new Float32Array( out.normals ), stride: 3 },
		ao: new Float32Array( out.ao ),
		bed: { records: new Float32Array( out.bed ), stride: 2 },
	};

}
