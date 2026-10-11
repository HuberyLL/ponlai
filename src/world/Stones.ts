// The submerged stones round the island: where they lie (placeStones) and their shapes
// (makeRockSDF). Runs in the mesh worker.
//
// Stones come in groups, each grown from one cell of a world-anchored grid, by class:
//   A  fallen blocks (6 m cells over the coast): blocks broken off the wall, gathered below its
//      recent scars and where it sheds more, each walked out from a coast point until its traced
//      outline clears the island's solid, so it rests against the cliff's underwater toe wherever
//      it runs (a few roll on down the talus), with up to three cobbles spalled from it;
//   B  near patches (7 m cells, 1.6 - 6.5 m out, none within 5.2 m of a higher-priority one):
//      debris patches on the shelf, a large main fragment, a few medium ones and gravel;
//   C  outer patches (20 m cells, 9 - 24 m out): fewer, smaller patches;
//   D  isolated stones (9 m cells, 9 - 24 m out, none within 1.4 major axes of an outer patch):
//      single fragments, leaving broad sand corridors on the outer shelf.
// Other stones keep a wider berth of the island than the fallen blocks, and every crown stays
// below -1.30 m, so nothing breaks the surface.
//
// A cell holds at most one group. Its candidate point, its acceptance and every stone it makes draw
// from the cell's own random stream (`mulberry32( hash3i( class, ci, cj ) )`, mixed), and a stone's
// seed (its shape and tint) is a hash of its group and its index there, so nothing depends on a
// running count, a cap or what was placed elsewhere. Each group builds its own list against the
// land, the floor and the island alone, in sequence, each stone tested against the stones before it
// (a fallen-block cell tries points all over it, as the running stream packed blocks along the toe).
// Between groups a stone yields only to a larger one it overlaps (of two the same size, the one of
// an earlier class, then of a higher group hash), judged against the other groups' own lists. Own
// lists never read other groups, so a drop cannot cascade, and the stones in a box depend only on
// the land, floor and island within STONES_READ of it: a chunk builds its own stones alone.
//
// This replaced 2 m fallen-block cells of one block each and priority by class: neighbouring blocks
// then dropped each other as a thinning does, packing about two thirds as densely as the running
// stream, and the patches' main fragments fell under the blocks with no retry, so the large stones
// were lost. Dropped stones are still never retried, so the shares below are set to keep each
// class's stones per metre of coast, and the large stones near the coast, within a fifth of the
// running stream's (tools/verify-world-stats.mjs checks both).

import { noise3, hash3i, mulberry32, smoothstep, type Rng } from './noise.ts';
import { LAND_REACH, type Bounds, type Footprint, type HeightFn } from './WorldShapes.ts';
import type { SDF, Rock } from './types.ts';

// ------------------------------------------------------------------ classes

const A = 0, B = 1, C = 2, D = 3;

// A patch's major half axis (m) from a uniform draw u: near patches 2.5 - 5.3, outer 3.0 - 5.8.
const majorAxis = ( outer: boolean, u: number ) => ( outer ? 3.0 : 2.5 ) + u * 2.8;

interface StoneClass {
	// the cell's side (m) and the share of it the candidate point may take, about its centre
	cell: number; jitter: number;
	// the farthest a group's stone lies from its cell (m), enforced as the group builds
	reach: number;
	// the farthest apart two stones of one group lie (m)
	extent: number;
}

// Fallen blocks are tried all over their cell and walked out from it, so their stones span the cell
// and twice the reach (the largest gap measured on seeds 1 - 6 up to step 36 was 5.0 m). A patch's
// stones lie within its ellipse, at most 1.025 times its major half axis from its point, which a
// near patch keeps 1.05 m inside its cell.
const CLASSES: StoneClass[] = [
	{ cell: 6, jitter: 1, reach: 6, extent: 2 * 6 + 6 * Math.SQRT2 },
	{ cell: 7, jitter: 0.7, reach: 4.5, extent: 2 * 1.025 * majorAxis( false, 1 ) },
	{ cell: 20, jitter: 1, reach: 6, extent: 2 * 1.025 * majorAxis( true, 1 ) },
	{ cell: 9, jitter: 1, reach: 0, extent: 0 },
];

/** Each class's cell side and reach (m), fallen blocks to isolated stones, for the checks. */
export const CELL = CLASSES.map( ( c ) => c.cell ), REACH = CLASSES.map( ( c ) => c.reach );

// Two stones farther apart than this never overlap: a stone's extent is at most 1.22 times its
// size, and the largest are 2.35 m.
const OVERLAP = 6;

// How far round its centre a stone's own tests read the floor and the island (m): its widest
// clearance ring is 1.15 times its extent plus 0.1, 3.4 m for the largest.
const PROBE = 4;

/**
 * How far beyond a box the stones placed in it read the land, the floor and the island (m): a group
 * that may outrank a stone in the box has a stone within OVERLAP of it, and its whole own list is
 * built, each stone probing up to PROBE round it. A chunk's footprint, whose distance field blends
 * over 3 m, needs its fine window 3.5 m wider still (`buildFootprint( land, grow( box,
 * STONES_READ + 3.5 ) )` builds a box's stones exactly as the whole land does).
 */
export const STONES_READ = OVERLAP + Math.max( ...CLASSES.map( ( c ) => c.extent ) ) + PROBE;

// Fallen blocks: a 6 m cell near the coast tries BLOCK_TRIES points in it, each taking a block
// where its draw falls below the wall's shed there times K_A and the block clears the group's own
// list; the tries saturate the list where the wall sheds, the shed still gathering more blocks
// under the scars. The other classes: the share of cells that take a group, which with the
// exclusions above gives the running stream's patches and isolated stones per metre of coast (near
// patches 8.4 per 100 m against its 8.8, isolated stones 10.5 against 11). A near patch draws 19 - 24
// stones, the running stream's 14 - 19 and what the blocks overlapping it drop: patches beside the
// toe keep about half, those farther out nearly all.
const BLOCK_TRIES = 24, K_A = 3, P_NEAR = 0.95, P_OUTER = 0.42, P_ISOLATED = 0.45;

// ------------------------------------------------------------------ stone shapes

// soft maximum of a set of plane distances (log-sum-exp): flat faces, edges rounded by ~k
function softMax( vals: Float64Array, n: number, k: number ): number {

	let m = - 1e9;
	for ( let i = 0; i < n; i ++ ) if ( vals[ i ] > m ) m = vals[ i ];
	let s = 0;
	for ( let i = 0; i < n; i ++ ) s += Math.exp( ( vals[ i ] - m ) / k );
	return m + k * Math.log( s );

}

function rockAxes( seed: number, thickness: number ): [ number, number ] {

	const slab = thickness < 0.40;
	return [ 1.03 + hash3i( seed, 13, 41 ) * 0.27,
		( slab ? 0.46 : 0.66 ) + hash3i( seed, 29, 83 ) * ( slab ? 0.29 : 0.32 ) ];

}

// Directional extent admits small companions along an elongated slab's narrow side. A single
// large exclusion circle around every stone would sterilise the interiors of the debris patches.
export function rockExtent( r: Rock, ux: number, uz: number ): number {

	const [ ax, az ] = rockAxes( r.seed, r.sy / r.s );
	const c = Math.cos( r.rot ), s = Math.sin( r.rot );
	const dx = ( c * ux + s * uz ) / ( r.s * ax ), dz = ( - s * ux + c * uz ) / ( r.s * az );
	return 0.94 / Math.hypot( dx, dz );

}

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

// ------------------------------------------------------------------ groups

// One cell's group: its candidate point and, for patches, the patch's form.
interface Group {
	cls: number; ci: number; cj: number;
	// the group's hash: its priority within the class, and (as an integer) its identity
	priority: number; key: number;
	rng: Rng;
	// its candidate point (a fallen-block cell's centre)
	x: number; z: number;
	// a patch's orientation, half axes (m) and stone count
	rot: number; major: number; minor: number; count: number;
	// the stones it would place on its own, built on first use
	stones?: Rock[];
}

// MurmurHash3's finaliser: a cell's hash is mixed again before it seeds a stream, as the meadow's
// anchor streams are (Anchors.ts), so a rare gate drawn from it keeps its expected rate.
function mix32( h: number ): number {

	h = Math.imul( h ^ h >>> 16, 0x85ebca6b );
	h = Math.imul( h ^ h >>> 13, 0xc2b2ae35 );
	return ( h ^ h >>> 16 ) >>> 0;

}

// A stone's seed from its group and its index in the group's own list: positive, below 2^30.
const stoneSeed = ( g: Group, k: number ) => 1 + Math.floor( hash3i( g.key, k, 6007 ) * 0x3ffffffe );

const grow = ( b: Bounds, m: number ): Bounds => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

/**
 * The stones whose centre lies in the half-open box `own` (by default every stone of the land),
 * seated on the rendered floor `floor` (Bathymetry's `floorAt`) clear of the island's solid. The
 * result depends on the land, floor and island within STONES_READ of the box alone; stones come in
 * class order, then their cells' ( j, i ) order, then their order in their group. `cells`, if
 * given, receives each stone's class (0 fallen block .. 3 isolated stone) and its group's cell
 * ( ci, cj ), for the checks.
 */
export function placeStones( fp: Footprint, floor: HeightFn, island: SDF, own: Bounds = grow( fp.bounds, LAND_REACH + 8 ), cells?: number[] ): Rock[] {

	const dist = ( x: number, z: number ) => fp.dist( x, z );
	// the seaward normal of the footprint's distance field
	const normal = ( x: number, z: number ): [ number, number ] => {

		const e = 0.2;
		const nx = dist( x + e, z ) - dist( x - e, z ), nz = dist( x, z + e ) - dist( x, z - e );
		const l = Math.hypot( nx, nz );
		return l < 1e-6 ? [ 0, 0 ] : [ nx / l, nz / l ];

	};
	// How much the wall sheds above a point at its foot: under its recent scars, and in runs where
	// a world-space field says it sheds more.
	const shed = ( x: number, z: number ) => Math.max( island.shed?.( x, z ) ?? 0,
		smoothstep( - 0.2, 0.15, noise3( x * 0.085 + 4.9, 12.7, z * 0.085 - 2.3 ) ) * 0.7 );
	// Whether a point lies within its group's reach of the group's cell. Every stone a group tries,
	// kept or not, is tested first, so a group reads nothing beyond its reach and its probes.
	const within = ( g: Group, x: number, z: number ): boolean => {

		const { cell, reach } = CLASSES[ g.cls ];
		const ox = Math.max( g.ci * cell - x, 0, x - g.ci * cell - cell ), oz = Math.max( g.cj * cell - z, 0, z - g.cj * cell - cell );
		return ox * ox + oz * oz <= reach * reach;

	};

	// ---- stones, as today's placement builds and tests them

	// Builds a stone seated on the floor, or null where the water above it is too shallow.
	const build = ( seed: number, x: number, z: number, size: number, thickness: number, rot: number, variation: number ): Rock | null => {

		const cr = Math.cos( rot ), sr = Math.sin( rot );
		// Seat the stone on the lowest floor under its body. On the cliff-foot talus the centre
		// alone left the downhill edge hanging above the slope; the uphill side is buried instead,
		// as a fallen block settles into scree.
		const lowest = ( ratio: number ) => {

			const [ ax, az ] = rockAxes( seed, ratio );
			let h = floor( x, z );
			for ( const reach of [ 0.45, 0.75 ] ) for ( const [ ux, uz ] of RING ) {

				const lx = ux * size * ax * reach, lz = uz * size * az * reach;
				h = Math.min( h, floor( x + cr * lx - sr * lz, z + sr * lx + cr * lz ) );

			}
			return h;

		};
		const slab = thickness < 0.40;
		const burial = slab ? 0.08 + variation * 0.28 : 0.12 + variation * 0.28;
		// Larger fragments show most of their natural mass above the sediment; gravel remains
		// partly blanketed. Their buried lower faces still give each body a real floor contact.
		const lift = size > 0.9 ? 0.18 + variation * 0.14
			: size > 0.5 && hash3i( seed, 71, 19 ) < 0.65 ? 0.12 + variation * 0.14 : - burial;
		// Budget the whole crown below the wave trough (-1.30 m), leaving every sloping face
		// intact. Neither emergence prevention nor sediment burial adds a horizontal clipping plane.
		const height = ( h: number ) => Math.min( size * thickness, ( - 1.30 - h ) / ( 1.6 + lift ) );
		let h = lowest( thickness );
		let sy = height( h );
		// A shallow floor can flatten a block into a slab, which has other proportions: seat it
		// again with the axes the stone will really have.
		if ( ( sy / size < 0.40 ) !== slab ) {

			h = Math.min( h, lowest( sy / size ) );
			sy = height( h );

		}
		if ( sy < 0.055 ) return null;
		return { x, z, s: size, sy, y: h + sy * lift, floor: h, rot, seed };

	};
	// Most stones keep clear of the island through a ring of probes just beyond their bounding
	// ellipse at base, middle and crown: cheap, and generous enough for any stone.
	const wideOfIsland = ( r: Rock ): boolean => {

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
	const overlaps = ( r: Rock, other: Rock ): boolean => {

		const dx = other.x - r.x, dz = other.z - r.z, distance = Math.hypot( dx, dz );
		if ( distance === 0 ) return true;
		if ( distance > ( other.s + r.s ) * 2 ) return false;
		const ux = dx / distance, uz = dz / distance;
		return distance < ( rockExtent( r, ux, uz ) + rockExtent( other, ux, uz ) ) * 0.98;

	};
	const clearOf = ( list: Rock[], r: Rock ) => ! list.some( ( other ) => overlaps( r, other ) );
	// Adds a stone to a group's list where the floor, the island and the list leave it room.
	const place = ( g: Group, list: Rock[], x: number, z: number, size: number, thickness: number, rot: number ): boolean => {

		if ( ! within( g, x, z ) ) return false;
		// (an outer patch's stones lie within its ellipse, a few metres past the patch's centre)
		const d = dist( x, z );
		if ( d < Math.max( 0.36, size * 0.32 ) ) return false;
		const r = build( stoneSeed( g, list.length ), x, z, size, thickness, rot, g.rng() );
		if ( ! r || ! clearOf( list, r ) || ( d < 6 && ! wideOfIsland( r ) ) ) return false;
		list.push( r );
		return true;

	};
	// Walks out from a coast point to the first spot where the stone clears the island's solid:
	// the foot of the wall's underwater toe, wherever the cliff and its batter run. Spots beyond the
	// group's reach count as blocked, unread.
	const atToe = ( g: Group, seed: number, cx: number, cz: number, nx: number, nz: number, size: number, thickness: number, rot: number, variation: number ): Rock | null => {

		const at = ( t: number ) => {

			const x = cx + nx * t, z = cz + nz * t;
			if ( ! within( g, x, z ) ) return null;
			const r = build( seed, x, z, size, thickness, rot, variation );
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

	// ---- each class's own list

	// Rockfall at the cliff foot: a block broken off the wall at a coast point ( x, z ) d metres
	// out, resting against the toe or rolled on down the talus, and cobbles spalled from it, half
	// lodged against the toe beside it, the rest scattered mostly on its seaward side.
	const fallenBlock = ( g: Group, list: Rock[], x: number, z: number, d: number, nx: number, nz: number ) => {

		const { rng } = g;
		const size = 0.6 + Math.pow( rng(), 1.3 ) * 1.1;
		const thickness = rng() < 0.2 ? 0.30 + rng() * 0.09 : 0.58 + rng() * 0.30;
		// long axes lie roughly along the wall they fell from, with some tumbled
		const rot = rng() < 0.7 ? Math.atan2( - nx, nz ) + ( rng() - 0.5 ) * 1.0 : rng() * Math.PI;
		// Most blocks come to rest against the toe; a few roll on down the talus.
		let roll = Math.pow( rng(), 2.5 ) * 2.5;
		const variation = rng(), seed = stoneSeed( g, list.length );
		let block = atToe( g, seed, x - nx * d, z - nz * d, nx, nz, size, thickness, rot, variation );
		if ( ! block ) return;
		if ( roll > 0.05 ) {

			// The roll stops at the group's reach: the reach is convex, so the block leaves it once.
			if ( ! within( g, block.x + nx * roll, block.z + nz * roll ) ) {

				let lo = 0, hi = roll;
				for ( let i = 0; i < 8; i ++ ) {

					const mid = ( lo + hi ) * 0.5;
					if ( within( g, block.x + nx * mid, block.z + nz * mid ) ) lo = mid; else hi = mid;

				}
				roll = lo;

			}
			if ( roll > 0.05 ) block = build( seed, block.x + nx * roll, block.z + nz * roll, size, thickness, rot, variation );

		}
		if ( ! block || dist( block.x, block.z ) > 6 || touchesIsland( block ) || ! clearOf( list, block ) ) return;
		list.push( block );
		const { x: bx, z: bz } = block, [ bnx, bnz ] = normal( bx, bz ), bd = dist( bx, bz );
		for ( let k = 0; k < 3; k ++ ) {

			const size = 0.16 + Math.pow( rng(), 1.5 ) * 0.38, thickness = 0.38 + rng() * 0.40, rot = rng() * Math.PI;
			if ( rng() < 0.5 ) {

				const along = ( rng() - 0.5 ) * 5;
				const rock = atToe( g, stoneSeed( g, list.length ), bx - bnx * bd - bnz * along, bz - bnz * bd + bnx * along, bnx, bnz, size, thickness, rot, rng() );
				if ( rock && clearOf( list, rock ) ) list.push( rock );
				continue;

			}
			const a = rng() * Math.PI * 2, rr = 0.8 + rng() * 2.2;
			const x = bx + Math.cos( a ) * rr, z = bz + Math.sin( a ) * rr;
			if ( ! within( g, x, z ) || dist( x, z ) < bd - 0.4 ) continue;
			place( g, list, x, z, size, thickness, rot );

		}

	};
	// A cell's fallen blocks, tried in sequence at points all over it: each lands where the wall
	// sheds and clears the blocks and cobbles before it, as a running stream packs them.
	const fallenBlocks = ( g: Group, list: Rock[] ) => {

		const { rng } = g, { cell } = CLASSES[ A ];
		for ( let t = 0; t < BLOCK_TRIES; t ++ ) {

			const x = ( g.ci + rng() ) * cell, z = ( g.cj + rng() ) * cell, u = rng(), d = dist( x, z );
			if ( d < 0 || d > 3 || u >= shed( x, z ) * K_A ) continue;
			const [ nx, nz ] = normal( x, z );
			if ( nx !== 0 || nz !== 0 ) fallenBlock( g, list, x, z, d, nx, nz );

		}

	};

	// Patchy hard bottom beside sandy sediment is inspired by USGS coastal seafloor observations:
	// https://pubs.usgs.gov/sir/2019/5073/ . This is an art-directed distribution, not sediment
	// physics. A patch is a large main fragment, a few medium ones and gravel, the gravel mostly in
	// one-sided child patches.
	const patch = ( g: Group, list: Rock[] ) => {

		const { rng } = g, outer = g.cls === C;
		const c = Math.cos( g.rot ), s = Math.sin( g.rot );
		const side = hash3i( g.key, 331, 7 ) < 0.5 ? - 1 : 1;
		const child = [
			[ side * g.major * 0.68, g.minor * ( hash3i( g.key, 11, 83 ) - 0.5 ) * 0.60 ],
			[ side * g.major * 0.42, g.minor * ( hash3i( g.key, 59, 113 ) < 0.5 ? - 0.58 : 0.58 ) ],
		];
		let placed = 0, tries = 0;
		while ( placed < g.count && tries ++ < g.count * 90 ) {

			const angle = rng() * Math.PI * 2;
			// Square-root radius fills each patch's interior instead of tracing another ring.
			const radius = Math.sqrt( rng() ) * ( placed === 0 ? 0.28 : 1 );
			let u = Math.cos( angle ) * radius * g.major, v = Math.sin( angle ) * radius * g.minor;
			if ( placed >= ( outer ? 3 : 5 ) && hash3i( g.key, tries, 173 ) < 0.93 ) {

				// One-sided child patches leave an exposed main face instead of arranging gravel
				// into a decorative halo around the main fragment's non-overlap boundary.
				const branch = hash3i( g.key, tries, 239 ) < 0.68 ? 0 : 1;
				u = child[ branch ][ 0 ] + Math.cos( angle ) * radius * g.major * ( branch === 0 ? 0.34 : 0.28 );
				v = child[ branch ][ 1 ] + Math.sin( angle ) * radius * g.minor * ( branch === 0 ? 0.36 : 0.30 );
				if ( u * u / ( g.major * g.major ) + v * v / ( g.minor * g.minor ) > 1.05 ) continue;

			}
			const x = g.x + c * u - s * v, z = g.z + s * u + c * v;
			let size: number, thickness: number;
			if ( placed === 0 ) {

				size = ( outer ? 1.10 : 1.35 ) + rng() * 1.0;
				const mix = rng(), variation = rng();
				// near patches are blocks or slabs in equal shares, outer ones mostly slabs
				const block = outer ? mix >= 0.56 : mix < 0.5;
				thickness = block ? 0.65 + variation * 0.20 : 0.23 + variation * 0.15;

			} else if ( placed < ( outer ? 3 : 5 ) ) {

				size = 0.44 + rng() * 0.74;
				thickness = 0.36 + rng() * 0.41;

			} else {

				size = 0.13 + Math.pow( rng(), 1.3 ) * 0.32;
				thickness = 0.34 + rng() * 0.38;

			}
			const rot = rng() < 0.65 ? g.rot + ( rng() - 0.5 ) * 1.6 : rng() * Math.PI;
			if ( place( g, list, x, z, size, thickness, rot ) ) placed ++;

		}

	};

	// Isolated fragments are sparse on the outer shelf, leaving broad sand corridors between the
	// denser cliff debris and the few offshore patches.
	const isolated = ( g: Group, list: Rock[] ) => {

		const { rng } = g;
		place( g, list, g.x, g.z, 0.19 + rng() * 0.50, 0.30 + rng() * 0.45, rng() * Math.PI );

	};

	const fill = [ fallenBlocks, patch, patch, isolated ];
	const ownList = ( g: Group ): Rock[] => {

		if ( ! g.stones ) {

			g.stones = [];
			fill[ g.cls ]( g, g.stones );

		}
		return g.stones;

	};

	// ---- candidates

	// A cell's candidate: its point and whether its own draws and the land there accept it, before
	// any test against other candidates. Patches draw their form at once (the isolated stones read
	// the outer patches' axes). A fallen-block cell is tried all over, so it takes a group wherever
	// any of it may lie within 3 m of the coast (the land's distance changes by at most a metre a
	// metre).
	const candidates = new Map<string, Group | null>();
	const candidate = ( cls: number, ci: number, cj: number ): Group | null => {

		const id = `${ cls } ${ ci } ${ cj }`;
		let g = candidates.get( id );
		if ( g !== undefined ) return g;
		const { cell, jitter } = CLASSES[ cls ];
		const priority = hash3i( cls, ci, cj ), key = priority * 4294967296 | 0;
		const rng = mulberry32( mix32( key ) );
		let x: number, z: number, ok: boolean;
		if ( cls === A ) {

			x = ( ci + 0.5 ) * cell;
			z = ( cj + 0.5 ) * cell;
			ok = Math.abs( dist( x, z ) - 1.5 ) <= 1.5 + cell * Math.SQRT1_2;

		} else {

			x = ( ci + 0.5 + ( rng() - 0.5 ) * jitter ) * cell;
			z = ( cj + 0.5 + ( rng() - 0.5 ) * jitter ) * cell;
			const u = rng(), d = dist( x, z );
			if ( cls === B ) ok = d >= 1.6 && d < 6.5 && u < P_NEAR;
			else ok = d >= 9 && d < LAND_REACH && u < ( cls === C ? P_OUTER : P_ISOLATED );

		}
		g = null;
		if ( ok ) {

			g = { cls, ci, cj, priority, key, rng, x, z, rot: 0, major: 0, minor: 0, count: 0 };
			if ( cls === B || cls === C ) {

				const outer = cls === C;
				const [ nx, nz ] = normal( x, z );
				g.rot = Math.atan2( - nx, nz ) + ( rng() - 0.5 ) * 0.9;
				g.major = majorAxis( outer, rng() );
				g.minor = ( outer ? 1.4 : 1.1 ) + rng() * 1.7;
				// (a near patch keeps about today's 14 - 19 once its outranked stones drop)
				g.count = outer ? 9 + Math.floor( rng() * 4 ) : 19 + Math.floor( rng() * 6 );

			}

		}
		candidates.set( id, g );
		return g;

	};
	// Calls `visit` with the candidates of a class whose cells meet the box, in ( j, i ) order.
	const each = ( cls: number, box: Bounds, visit: ( g: Group ) => boolean | void ): boolean => {

		const { cell } = CLASSES[ cls ];
		for ( let cj = Math.floor( box.z0 / cell ); cj <= Math.floor( box.z1 / cell ); cj ++ ) {

			for ( let ci = Math.floor( box.x0 / cell ); ci <= Math.floor( box.x1 / cell ); ci ++ ) {

				const g = candidate( cls, ci, cj );
				if ( g && visit( g ) === true ) return true;

			}

		}
		return false;

	};
	const around = ( x: number, z: number, r: number ): Bounds => ( { x0: x - r, z0: z - r, x1: x + r, z1: z + r } );
	// A candidate makes a group unless a near patch has a higher-priority one within 5.2 m, or an
	// isolated stone lies within 1.4 times the major axis of an outer patch's.
	const groups = new Map<Group, boolean>();
	const isGroup = ( g: Group ): boolean => {

		let ok = groups.get( g );
		if ( ok !== undefined ) return ok;
		if ( g.cls === B ) ok = ! each( B, around( g.x, g.z, 5.2 ), ( o ) => o !== g && o.priority > g.priority && Math.hypot( o.x - g.x, o.z - g.z ) < 5.2 );
		else if ( g.cls === D ) ok = ! each( C, around( g.x, g.z, majorAxis( true, 1 ) * 1.4 ), ( o ) => Math.hypot( o.x - g.x, o.z - g.z ) < o.major * 1.4 );
		else ok = true;
		groups.set( g, ok );
		return ok;

	};
	// Whether a stone of group g overlaps a larger stone in another group's own list (of two stones
	// the same size, the one of an earlier class, then of a higher group hash).
	const outranked = ( g: Group, r: Rock ): boolean => {

		for ( let cls = A; cls <= D; cls ++ ) {

			const hit = each( cls, around( r.x, r.z, CLASSES[ cls ].reach + OVERLAP ), ( h ) => {

				if ( h === g || ! isGroup( h ) ) return false;
				const first = cls < g.cls || ( cls === g.cls && h.priority > g.priority );
				return ownList( h ).some( ( o ) => ( o.s > r.s || ( o.s === r.s && first ) ) && overlaps( r, o ) );

			} );
			if ( hit ) return true;

		}
		return false;

	};

	const stones: Rock[] = [];
	for ( let cls = A; cls <= D; cls ++ ) each( cls, grow( own, CLASSES[ cls ].reach ), ( g ) => {

		if ( ! isGroup( g ) ) return;
		for ( const r of ownList( g ) ) {

			if ( r.x >= own.x0 && r.x < own.x1 && r.z >= own.z0 && r.z < own.z1 && ! outranked( g, r ) ) {

				stones.push( r );
				cells?.push( cls, g.ci, g.cj );

			}

		}

	} );
	return stones;

}
