import { GROVES, culmAt, groveAt, litterAt } from './BambooGroves.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { hash3i, mulberry32, type Rng, type Bounds, type ShoreField } from '../renderData.ts';
import { RIM_REACH, sampleRimGround } from './RimGround.ts';
import { shoreDistance } from './ShoreSample.ts';
import type { RimGroundField } from './types.ts';

// Where the yunpeng stands (Yunpeng.ts builds its clumps): single clumps in the meadow, sparse, an
// accent and never a stand (tall and glowing, a drift of them would hide the islanders by night).
//
// - A world lattice of `cell` m draws at most one candidate per cell, from the cell's own stream
//   (`candidateAt`): where in the cell, whether one is there at all (`chance`), and its clump's
//   size and every stalk's draw; its priority is a hash of its own.
// - The ground (`grounded`), each a function of the point: on the island's top, `inset` in from the
//   coast (the shore field's distance: the rim ground's is clamped to RIM_REACH) and at least
//   `rim` in from the cliff's top edge (the rim ground's), so never on the lip or the face; where
//   the meadow grows (`supportsMeadow`, on the
//   top's slope), out of the bamboo's groves (`groveAt` below `grove`) and their litter
//   (`litterAt`), and with no culm's foot within `clear` (BambooGroves.ts `culmAt`, the culms as
//   their planting stands them).
// - The spacing: a grounded candidate gives way to any other grounded one within `apart` of it of
//   a higher priority (equal ones by the lattice's row order), whether or not that one stays
//   itself, so the clumps are at least `apart` apart, decided in one pass, in any order, from the
//   cells round a clump alone.
// So the count follows the open meadow's area: about ten on a grown island, the clumps at least
// about 13 m apart, and on the starting island, whose meadow is small, maybe none. A clump belongs
// to the box its centre lies in (half-open, as the chunks tile the plane: `plantClumps`), and every
// cell draws the same wherever a box starts, so the chunks' clumps together are the whole land's.
// Plain numbers and no three.js, so node can plant it.

export const MEADOW_CLUMPS = {
	cell: 13, // the lattice a clump may stand in (m): one candidate per cell
	chance: 1, // a cell's chance of a candidate
	apart: 13, // the least distance between two clumps (m)
	inset: 2, // a clump's least distance in from the coast (m, the shore field's)
	rim: 1, // and from the cliff's top edge (m, the rim ground's, within its reach)
	grove: 0.1, // the groves' density at or above which no clump stands (BambooGroves.ts groveAt): out past a grove's edge
	clear: 1.2, // the least distance from a clump's middle to a culm's foot (m): its stalks keep clear of the culms
	tall: 1 / 3, // the share of tall clumps (Yunpeng.ts YUNPENG.stalks and height: their first sizes)
};

/** A clump of yunpeng: its middle, its size (0 tall, 1 lower: YUNPENG's) and its stalks' seed. */
export interface ClumpSite { x: number; z: number; size: 0 | 1; seed: number }

/** A cell's candidate: its place, its priority and its clump's draws. */
interface Candidate { i: number; j: number; x: number; z: number; priority: number; size: 0 | 1; seed: number }

/** The candidate the lattice's cell ( i, j ) draws, or null. */
function candidateAt( i: number, j: number ): Candidate | null {

	const P = MEADOW_CLUMPS;
	const rng: Rng = mulberry32( ( hash3i( i, j, 7331 ) * 4294967296 ) >>> 0 );
	const x = ( i + rng() ) * P.cell, z = ( j + rng() ) * P.cell;
	if ( rng() >= P.chance ) return null;
	const size = rng() < P.tall ? 0 : 1;
	return { i, j, x, z, priority: hash3i( i, j, 7349 ), size, seed: ( rng() * 4294967296 ) >>> 0 };

}

/** The fields of the land a clump's ground reads: the rim ground (RimGround.ts) and the shore's
 * distance (WorldData `rimGround`, `shore`). */
export interface ClumpLand { rim: RimGroundField; shore: ShoreField }

/** Whether a clump may stand at ( x, z ) on `land`, the top's ground `groundAt` (see the header). */
export function grounded( land: ClumpLand, groundAt: ( x: number, z: number ) => number, x: number, z: number ): boolean {

	const P = MEADOW_CLUMPS, rim = land.rim;
	if ( shoreDistance( land.shore, x, z ) > - P.inset || sampleRimGround( rim, x, z ).distance > - Math.min( P.rim, RIM_REACH ) ) return false;
	if ( ! supportsMeadow( x, groundAt( x, z ), z, upAt( groundAt, x, z ) ) ) return false;
	if ( groveAt( x, z ) >= P.grove || litterAt( x, z ) > 0 ) return false;
	// the culms as plantCulms stands them (on the top, in from the cliff's edge)
	const stands = ( cx: number, cz: number ) => ! ( sampleRimGround( rim, cx, cz ).distance > - GROVES.inset );
	const c = GROVES.cell;
	for ( let j = Math.floor( ( z - P.clear ) / c ); j <= Math.floor( ( z + P.clear ) / c ); j ++ ) {

		for ( let i = Math.floor( ( x - P.clear ) / c ); i <= Math.floor( ( x + P.clear ) / c ); i ++ ) {

			const culm = culmAt( i, j, stands, groundAt );
			if ( culm !== null && Math.hypot( culm.x - x, culm.z - z ) < P.clear ) return false;

		}

	}
	return true;

}

/** The up component of the top's normal at ( x, z ), by finite differences of `groundAt`. */
function upAt( groundAt: ( x: number, z: number ) => number, x: number, z: number ): number {

	const e = 0.25;
	const gx = ( groundAt( x + e, z ) - groundAt( x - e, z ) ) / ( 2 * e ), gz = ( groundAt( x, z + e ) - groundAt( x, z - e ) ) / ( 2 * e );
	return 1 / Math.sqrt( 1 + gx * gx + gz * gz );

}

/** The clumps over `land` whose middles lie in `box` (half-open), on the ground `groundAt` gives,
 * in the lattice's row order: a row of cells a step. */
export function* plantClumps( land: ClumpLand, groundAt: ( x: number, z: number ) => number, box: Bounds ): Generator<void, ClumpSite[]> {

	const P = MEADOW_CLUMPS, cell = P.cell, reach = Math.ceil( P.apart / cell );
	// (each cell's grounded candidate, kept: its neighbours ask for it again)
	const seen = new Map<string, Candidate | null>();
	const at = ( i: number, j: number ) => {

		const key = `${ i },${ j }`;
		let c = seen.get( key );
		if ( c === undefined ) {

			c = candidateAt( i, j );
			if ( c !== null && ! grounded( land, groundAt, c.x, c.z ) ) c = null;
			seen.set( key, c );

		}
		return c;

	};
	const sites: ClumpSite[] = [];
	for ( let j = Math.floor( box.z0 / cell ); j * cell < box.z1; j ++ ) {

		for ( let i = Math.floor( box.x0 / cell ); i * cell < box.x1; i ++ ) {

			const c = candidateAt( i, j );
			if ( c === null || ! ( c.x >= box.x0 && c.x < box.x1 && c.z >= box.z0 && c.z < box.z1 ) ) continue;
			const own = at( i, j );
			if ( own === null ) continue;
			let stays = true;
			for ( let dj = - reach; dj <= reach && stays; dj ++ ) for ( let di = - reach; di <= reach && stays; di ++ ) {

				if ( di === 0 && dj === 0 ) continue;
				const o = at( i + di, j + dj );
				if ( o === null || Math.hypot( o.x - own.x, o.z - own.z ) >= P.apart ) continue;
				// a higher priority, or an equal one earlier in the rows
				if ( o.priority > own.priority || ( o.priority === own.priority && ( o.j < own.j || ( o.j === own.j && o.i < own.i ) ) ) ) stays = false;

			}
			if ( stays ) sites.push( { x: own.x, z: own.z, size: own.size, seed: own.seed } );

		}
		yield;

	}
	return sites;

}
