import { anchorCell, anchorStream } from './Anchors.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { noise3, smoothstep } from './noise.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';
import type { Bounds } from './WorldShapes.ts';

// The rim bushes: crowded along the rim, scattered inland. They are a box's own (a chunk's): each
// turf anchor proposes a bush by its own cell's hash, and the anchors kept are those no
// higher-ranked proposal crowds (Matérn thinning on hashed priorities), never bushes accepted
// earlier in some order, so a box keeps the same bushes whatever else is built.
//
// The rim bushes, as the world generator returns them: per bush its anchor on the turf ( x, y, z ),
// radius, the ground's normal ( x, y, z ), yaw, scale ( x, y, z ), colour ( r, g, b ) and the
// anchor's sky visibility. buildFoliage draws exactly these, and the rim trails and the game's
// ground read them.
export const BUSH_STRIDE = 15;
// the offset of a bush's scale ( x, y, z ) in its floats
export const BUSH_SCALE = 8;

// The bushes' greens (linear RGB); a trail with no bush near takes one too.
export const BUSH_GREENS: readonly [ number, number, number ][] = [ [ 0.065, 0.16, 0.04 ], [ 0.095, 0.19, 0.048 ], [ 0.15, 0.205, 0.046 ], [ 0.04, 0.12, 0.043 ], [ 0.18, 0.22, 0.058 ] ];

// A candidate gives way to a higher-ranked one nearer than this share of their radii summed. The
// dart-throwing this replaced accepted each proposal in turn against the bushes accepted before at
// 0.75, which packs the rim's clumps about twice as densely as thinning by rank can at any rate of
// candidates (more candidates there only crowd each other out, and inland they add bushes): at
// 0.58 the rim keeps its count and the inland stays as sparse. The count is tuned on SALT, the salt
// in use: each grown island within 8 % of the dart-throwing's, their sum within 1 %. Averaged over
// salts (which new land follows) it runs 3 % lower on the grown islands, -10 % to +4 % per island;
// a crowding that matched that average (0.56) would put SALT's islands up to 13 % over.
const CROWDING = 0.58;
// The largest radius, so the farthest a candidate's neighbours can crowd it: ( r1 + r2 ) * CROWDING.
const MAX_RADIUS = ( 0.35 + 0.75 ) * 1.3;
/** How far from a box the anchors that decide its bushes lie (m). */
export const BUSH_REACH = 2 * MAX_RADIUS * CROWDING;
const SALT = 7;

interface Candidate { k: number; x: number; z: number; r: number; rank: number; i: number; j: number; draws: number[] }

// whether a outranks b (ties, which a 32-bit draw makes rare, by anchor cell)
const outranks = ( a: Candidate, b: Candidate ) => a.rank > b.rank || a.rank === b.rank && ( a.j < b.j || a.j === b.j && a.i < b.i );

/** The rim bushes rooted at the anchors in each of `boxes` (half-open), in the anchors' order:
 * crowded along the rim, scattered inland. Each anchor proposes a bush by the turf's rim and a
 * clump field, and every draw comes from its own cell's stream, so a candidate is the same in
 * every box; a candidate is a bush unless a higher-ranked candidate lies nearer than
 * ( r1 + r2 ) * CROWDING (Matérn's second thinning, which reads candidates, never bushes kept in
 * some order). `anchors` must hold every anchor within BUSH_REACH of the boxes. */
export function pickBushes( anchors: Float32Array, boxes: Bounds[] ): Float32Array[] {

	const candidates: Candidate[] = [];
	const grid = new Map<number, Candidate[]>();
	const key = ( gi: number, gj: number ) => ( gi + 32768 ) * 65536 + gj + 32768;
	for ( let k = 0; k < anchors.length; k += STRIDE ) {

		const x = anchors[ k ], y = anchors[ k + 1 ], z = anchors[ k + 2 ], rim = anchors[ k + 6 ];
		if ( ! supportsMeadow( y, anchors[ k + 4 ] ) ) continue;
		const nearRim = smoothstep( - 2.2, - 0.6, rim );
		const clump = noise3( x * 0.3, 7.7, z * 0.3 ) * 0.5 + 0.5;
		const p = nearRim * 0.3 * smoothstep( 0.3, 0.7, clump ) + 0.015 * smoothstep( 0.6, 0.85, clump );
		const rng = anchorStream( x, z, SALT );
		if ( rng() >= p ) continue;
		const rank = rng();
		const r = ( 0.35 + Math.pow( rng(), 1.5 ) * 0.75 ) * ( 0.8 + 0.5 * nearRim );
		const [ i, j ] = anchorCell( x, z );
		const c = { k, x, z, r, rank, i, j, draws: Array.from( { length: 6 }, rng ) };
		candidates.push( c );
		const g = key( Math.floor( x / BUSH_REACH ), Math.floor( z / BUSH_REACH ) );
		let cell = grid.get( g );
		if ( ! cell ) grid.set( g, cell = [] );
		cell.push( c );

	}
	const kept = ( c: Candidate ) => {

		const gi = Math.floor( c.x / BUSH_REACH ), gj = Math.floor( c.z / BUSH_REACH );
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

			for ( const o of grid.get( key( gi + di, gj + dj ) ) ?? [] ) {

				if ( outranks( o, c ) && Math.hypot( o.x - c.x, o.z - c.z ) < ( o.r + c.r ) * CROWDING ) return false;

			}

		}
		return true;

	};
	return boxes.map( ( box ) => {

		const out: number[] = [];
		for ( const c of candidates ) {

			if ( c.x < box.x0 || c.x >= box.x1 || c.z < box.z0 || c.z >= box.z1 || ! kept( c ) ) continue;
			const k = c.k, [ yaw, sx, sy, sz, hue, shade ] = c.draws;
			const green = BUSH_GREENS[ Math.floor( hue * BUSH_GREENS.length ) ], light = 0.85 + shade * 0.35;
			out.push( c.x, anchors[ k + 1 ], c.z, c.r, anchors[ k + 3 ], anchors[ k + 4 ], anchors[ k + 5 ], yaw * Math.PI * 2,
				c.r * ( 0.9 + sx * 0.25 ), c.r * ( 1.1 + sy * 0.4 ), c.r * ( 0.9 + sz * 0.25 ),
				green[ 0 ] * light, green[ 1 ] * light, green[ 2 ] * light, anchors[ k + 8 ] );

		}
		return new Float32Array( out );

	} );

}
