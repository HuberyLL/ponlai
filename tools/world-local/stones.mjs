// The submerged stones (src/world/Stones.ts), a case of tools/verify-world-local.mjs.
//
// The sub-box case: the stones whose centre lies in a box (centre, size, height, seat, rotation,
// seed and class), each box placed from an island solid built over that box and STONES_READ round
// it (and the cliff's own 25 m beyond), so a stone that read anything farther would differ between
// the whole box and its sub-boxes. `setup` also asserts, per seed and step, on the land's stones:
//   - no two stones overlap (their directional extents, x 0.98, as the placement tests them);
//   - every crown's budget lies at or below -1.30 m (the seat plus 1.6 times the height, which
//     holds the whole stone);
//   - every stone lies within its class's reach of its group's cell (the placement tests the reach
//     before it reads the land, and its window relies on it);
//   - built as a chunk would, each 16 m tile from a footprint whose fine window is the tile and
//     STONES_READ round it plus 3.5 m (`buildFootprint( land, window )`, whose distance field
//     blends over 3 m) and an island solid over that window, the tiles give every stone of the
//     whole land once, matched by seed, of the same class and within 1e-9 m (the windowed field
//     matches the whole one but for its last bits);
// and once per run, over seeds 1 - 6 at steps 0, 8 and 16, against today's placement (one running
// stream, with counts set by the coast's length, main's 235 stones per 90.9 m of coast on the tile
// island) measured on the same islands, per metre of coast:
//   - each class's stones lie within 20 % of today's;
//   - so do the large stones: fallen blocks of 0.6 m or more, stones of 0.6 m or more within 2.5 m
//     and within 8 m of the coast, and stones over 1.7 m within 8 m (the stones a thinning of
//     small cells lost);
//   - stones of 0.6 m or more within 2.5 m of the coast lie denser below the wall's scars than
//     elsewhere (today 1.4 times).
// Single islands scatter more (a few outer patches each), and the outer bands run short of coast on
// large, indented islands, so the density checks take them together.
import assert from 'node:assert/strict';
import { growLand } from '../../src/world/IslandGrowth.ts';
import { buildFootprint, makeIslandSDF, LAND_REACH } from '../../src/world/WorldShapes.ts';
import { floorAt } from '../../src/world/Bathymetry.ts';
import { placeStones, rockExtent, STONES_READ, CELL, REACH } from '../../src/world/Stones.ts';

export const name = 'stones';

const grow = ( b, m ) => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

const CLASS = [ 'fallen blocks', 'near patches', 'outer patches', 'isolated' ];

// Today's stones per 100 m of coast by class (the cobbles with their blocks), from the running
// stream's placement on seeds 1 - 6 at steps 0, 8 and 16 (3603 m of coast): 255 in all, as main's
// 258 on the tile island.
const TODAY = [ 71.6, 136.9, 35.9, 11.0 ];

// Today's large stones per 100 m of coast on the same islands: fallen blocks of size 0.6 m or more
// (the size the cobbles stay below), stones of 0.6 m or more within 2.5 m and within 8 m of the
// coast, and stones over 1.7 m within 8 m (the largest blocks and the patches' main fragments).
const SIZES = [
	{ label: 'fallen blocks', today: 28.6, test: ( r, c ) => c === 0 && r.s >= 0.6 },
	{ label: 'stones of 0.6 m or more within 2.5 m', today: 26.4, test: ( r, c, d ) => r.s >= 0.6 && d < 2.5 },
	{ label: 'stones of 0.6 m or more within 8 m', today: 58.0, test: ( r, c, d ) => r.s >= 0.6 && d < 8 },
	{ label: 'stones over 1.7 m within 8 m', today: 4.8, test: ( r, c, d ) => r.s > 1.7 && d < 8 },
];

// Where the wall above a coast point counts as scarred (the island's shed), for the blocks gathered
// below its scars.
const SCAR = 0.4;

// The seaward normal of the footprint's distance field.
function normal( fp, x, z ) {

	const e = 0.2, nx = fp.dist( x + e, z ) - fp.dist( x - e, z ), nz = fp.dist( x, z + e ) - fp.dist( x, z - e );
	const l = Math.hypot( nx, nz ) || 1;
	return [ nx / l, nz / l ];

}

// The coast's length (m), from the band of footprint cells just outside the edge, as the running
// stream measured it, and the part of it below the wall's scars (with an island solid).
function coastLength( fp, island ) {

	const b = fp.bounds;
	let coast = 0, scarred = 0;
	for ( let z = b.z0 - 2; z < b.z1 + 2; z += 0.25 ) for ( let x = b.x0 - 2; x < b.x1 + 2; x += 0.25 ) {

		const d = fp.dist( x, z );
		if ( d < 0 || d >= 1 ) continue;
		coast += 0.0625;
		if ( island && island.shed( x, z ) > SCAR ) scarred += 0.0625;

	}
	return island ? { coast, scarred } : coast;

}

function checkStones( stones, cells, label ) {

	let pairs = 0;
	for ( let i = 0; i < stones.length; i ++ ) {

		const r = stones[ i ];
		assert.ok( r.y + 1.6 * r.sy <= - 1.30 + 1e-9, `${ label }: a stone's crown at ( ${ r.x.toFixed( 2 ) }, ${ r.z.toFixed( 2 ) } ) reaches ${ ( r.y + 1.6 * r.sy ).toFixed( 3 ) } m` );
		const [ cls, ci, cj ] = cells.slice( i * 3, i * 3 + 3 ), c = CELL[ cls ];
		const out = Math.hypot( Math.max( ci * c - r.x, 0, r.x - ci * c - c ), Math.max( cj * c - r.z, 0, r.z - cj * c - c ) );
		assert.ok( out <= REACH[ cls ], `${ label }: a stone of the ${ CLASS[ cls ] } lies ${ out.toFixed( 2 ) } m from its cell ( ${ ci }, ${ cj } ), beyond its ${ REACH[ cls ] } m reach` );
		for ( let j = i + 1; j < stones.length; j ++ ) {

			const o = stones[ j ], dx = o.x - r.x, dz = o.z - r.z, distance = Math.hypot( dx, dz );
			if ( distance > ( o.s + r.s ) * 2 ) continue;
			pairs ++;
			const ux = dx / distance, uz = dz / distance;
			assert.ok( distance > 0 && distance >= ( rockExtent( r, ux, uz ) + rockExtent( o, ux, uz ) ) * 0.98,
				`${ label }: stones at ( ${ r.x.toFixed( 2 ) }, ${ r.z.toFixed( 2 ) } ) and ( ${ o.x.toFixed( 2 ) }, ${ o.z.toFixed( 2 ) } ) overlap` );

		}

	}
	return pairs;

}

const counts = ( cells ) => {

	const n = [ 0, 0, 0, 0 ];
	for ( let i = 0; i < cells.length; i += 3 ) n[ cells[ i ] ] ++;
	return n;

};

let densityChecked = false;
function checkDensity() {

	const total = [ 0, 0, 0, 0 ], sizes = SIZES.map( () => 0 );
	let coast = 0, scarred = 0, nearScar = 0, nearOther = 0;
	for ( const seed of [ 1, 2, 3, 4, 5, 6 ] ) for ( const step of [ 0, 8, 16 ] ) {

		const fp = buildFootprint( growLand( seed, step ).land ), island = makeIslandSDF( fp ), cells = [];
		const stones = placeStones( fp, floorAt( fp ), island, undefined, cells );
		counts( cells ).forEach( ( n, c ) => total[ c ] += n );
		stones.forEach( ( r, i ) => {

			const c = cells[ i * 3 ], d = fp.dist( r.x, r.z );
			SIZES.forEach( ( k, n ) => sizes[ n ] += k.test( r, c, d ) ? 1 : 0 );
			if ( r.s < 0.6 || d >= 2.5 ) return;
			// the wall above the stone: its coast point, half a metre in
			const [ nx, nz ] = normal( fp, r.x, r.z );
			if ( island.shed( r.x - nx * ( d - 0.5 ), r.z - nz * ( d - 0.5 ) ) > SCAR ) nearScar ++; else nearOther ++;

		} );
		const length = coastLength( fp, island );
		coast += length.coast;
		scarred += length.scarred;

	}
	const per = total.map( ( n ) => n / coast * 100 );
	const report = per.map( ( p, c ) => `${ CLASS[ c ] } ${ p.toFixed( 1 ) } (today ${ TODAY[ c ] })` ).join( ', ' );
	console.log( `     stones per 100 m of coast over seeds 1 - 6 at steps 0, 8, 16 (${ coast.toFixed( 0 ) } m): ${ report }; ` +
		`${ ( per.reduce( ( a, b ) => a + b ) ).toFixed( 1 ) } in all (main 258.5)` );
	per.forEach( ( p, c ) => assert.ok( Math.abs( p / TODAY[ c ] - 1 ) <= 0.2, `the ${ CLASS[ c ] } come to ${ p.toFixed( 1 ) } per 100 m of coast, more than 20 % off today's ${ TODAY[ c ] }` ) );

	const large = sizes.map( ( n ) => n / coast * 100 );
	console.log( `     large stones per 100 m of coast: ${ large.map( ( p, n ) => `${ SIZES[ n ].label } ${ p.toFixed( 1 ) } (today ${ SIZES[ n ].today })` ).join( ', ' ) }` );
	large.forEach( ( p, n ) => assert.ok( Math.abs( p / SIZES[ n ].today - 1 ) <= 0.2, `the ${ SIZES[ n ].label } come to ${ p.toFixed( 1 ) } per 100 m of coast, more than 20 % off today's ${ SIZES[ n ].today }` ) );

	// stones of 0.6 m or more within 2.5 m, per metre of coast below the scars and elsewhere
	const ratio = ( nearScar / scarred ) / ( nearOther / ( coast - scarred ) );
	console.log( `     stones of 0.6 m or more within 2.5 m: ${ ratio.toFixed( 2 ) } times as dense below the scars (${ scarred.toFixed( 0 ) } m) as elsewhere (today 1.40)` );
	assert.ok( ratio > 1, `the large stones near the coast are no denser below the scars (${ ratio.toFixed( 2 ) } times)` );

}

// Each 16 m tile of the land's stones placed from a footprint whose fine window is the tile and
// STONES_READ round it, plus the distance field's 3.5 m blend, and an island solid over that
// window (and the cliff's 25 m beyond), as a chunk builds it: the tiles together must give the
// whole land's stones, each matched by its seed.
function checkWindowed( land, fp, stones, cells, label ) {

	const T = 16, b = grow( fp.bounds, LAND_REACH + 8 );
	const bySeed = new Map( stones.map( ( r, i ) => [ r.seed, i ] ) );
	assert.equal( bySeed.size, stones.length, `${ label }: two stones share a seed` );
	const found = new Set();
	let tiles = 0, largest = 0;
	for ( let z = Math.floor( b.z0 / T ) * T; z < b.z1; z += T ) for ( let x = Math.floor( b.x0 / T ) * T; x < b.x1; x += T ) {

		const tile = { x0: x, z0: z, x1: x + T, z1: z + T }, near = grow( tile, STONES_READ );
		// tiles with no stone within the stones' read of them, far out at sea or inland, are skipped
		if ( ! stones.some( ( r ) => r.x >= near.x0 && r.x < near.x1 && r.z >= near.z0 && r.z < near.z1 ) ) continue;
		tiles ++;
		const window = buildFootprint( land, grow( tile, STONES_READ + 3.5 ) ), own = [];
		const placed = placeStones( window, floorAt( window ), makeIslandSDF( window, grow( near, 25 ) ), tile, own );
		placed.forEach( ( r, k ) => {

			const i = bySeed.get( r.seed );
			assert.ok( i !== undefined, `${ label }: tile [${ x }, ${ z }] places a stone at ( ${ r.x.toFixed( 2 ) }, ${ r.z.toFixed( 2 ) } ) the whole land does not` );
			assert.ok( ! found.has( i ), `${ label }: two tiles place the stone at ( ${ r.x.toFixed( 2 ) }, ${ r.z.toFixed( 2 ) } )` );
			found.add( i );
			const o = stones[ i ];
			assert.equal( own[ k * 3 ], cells[ i * 3 ], `${ label }: the stone at ( ${ r.x.toFixed( 2 ) }, ${ r.z.toFixed( 2 ) } ) changes class in tile [${ x }, ${ z }]` );
			const d = Math.max( ...[ 'x', 'z', 's', 'sy', 'y', 'floor', 'rot' ].map( ( f ) => Math.abs( r[ f ] - o[ f ] ) ) );
			assert.ok( d < 1e-9, `${ label }: the stone at ( ${ o.x.toFixed( 2 ) }, ${ o.z.toFixed( 2 ) } ) differs by ${ d.toExponential( 2 ) } in tile [${ x }, ${ z }]` );
			largest = Math.max( largest, d );

		} );

	}
	const missing = stones.find( ( _, i ) => ! found.has( i ) );
	assert.ok( missing === undefined, `${ label }: no tile places the stone at ( ${ missing?.x.toFixed( 2 ) }, ${ missing?.z.toFixed( 2 ) } )` );
	console.log( `     ${ label }: ${ tiles } tiles of ${ T } m on windowed footprints give all ${ stones.length } stones, within ${ largest.toExponential( 1 ) }` );

}

export function setup( { seed, grow: steps } ) {

	const { land } = growLand( seed, steps );
	const fp = buildFootprint( land );
	const label = `${ name } seed ${ seed } grow ${ steps }`;
	const cells = [], stones = placeStones( fp, floorAt( fp ), makeIslandSDF( fp ), undefined, cells );
	const pairs = checkStones( stones, cells, label );
	const n = counts( cells );
	console.log( `     ${ label }: ${ stones.length } stones (${ n.map( ( k, c ) => `${ k } ${ CLASS[ c ] }` ).join( ', ' ) }) on ${ coastLength( fp ).toFixed( 1 ) } m of coast, ` +
		`${ pairs } near pairs clear of each other, crowns at most ${ Math.max( ...stones.map( ( r ) => r.y + 1.6 * r.sy ) ).toFixed( 3 ) } m` );
	checkWindowed( land, fp, stones, cells, label );
	if ( ! densityChecked ) {

		densityChecked = true;
		checkDensity();

	}

	// two 32 m boxes off the cells' grids: over the coast nearest the land's middle on its north side
	// (blocks, near patches), and over its outer shelf to the east (outer patches, isolated stones)
	const b = fp.bounds, cx = Math.round( ( b.x0 + b.x1 ) / 2 ) + 0.3, cz = Math.round( ( b.z0 + b.z1 ) / 2 ) + 0.7;
	return { fp, floor: floorAt( fp ), boxes: [
		{ x0: cx - 16, z0: Math.round( b.z0 ) - 14.3, x1: cx + 16, z1: Math.round( b.z0 ) + 17.7 },
		{ x0: Math.round( b.x1 ) + 3.1, z0: cz - 16, x1: Math.round( b.x1 ) + 35.1, z1: cz + 16 },
	] };

}

export function build( ctx, box ) {

	const area = grow( box, STONES_READ );
	const cells = [], stones = placeStones( ctx.fp, ctx.floor, makeIslandSDF( ctx.fp, grow( area, 25 ) ), box, cells );
	const field = ( f, stride = 1 ) => ( { records: new Float64Array( stones.flatMap( f ) ), stride } );
	return {
		pos: field( ( r ) => [ r.x, r.z ], 2 ),
		size: field( ( r ) => [ r.s, r.sy ], 2 ),
		seat: field( ( r ) => [ r.y, r.floor ], 2 ),
		rot: field( ( r ) => [ r.rot ] ),
		seed: field( ( r ) => [ r.seed ] ),
		cls: { records: new Float64Array( cells.filter( ( _, i ) => i % 3 === 0 ) ), stride: 1 },
	};

}
