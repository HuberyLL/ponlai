import { anchorCell, anchorStream } from './Anchors.ts';
import { BUSH_GREENS, BUSH_STRIDE } from './FoliageSites.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { mulberry32, noise3, smoothstep, type Rng } from './noise.ts';
import { topAt, type CoastChain } from './RimGround.ts';
import type { Bounds, Footprint } from './WorldShapes.ts';
import { VEGETATION_STRIDE } from './types.ts';
import type { RimStrand, SDF } from './types.ts';

// The branches hanging over the upper rim (drawn by RimFoliage.ts). Rules: every strand is rooted
// in the meadow at the rim, never on the cliff face. They grow in clumped patches of one to nine
// strands with runs of bare stone between of 0.4-4 m, measured along the winding coast (a sparse
// patch breaks any longer run; only a notch whose walls hold no lip runs longer, and is measured by
// its mouth: a run bulging into the land, never a headland's, which bulges out to sea and holds
// lips), with a long tail of strands that wander and fork down to 1.5-2.6 m, leaves shrinking
// toward the tips, and a mounded leaf clump over each patch's lip. The lowest quarter of the cliff
// above the sea stays bare.
//
// The trails are a box's own (a chunk's): patches root at rim anchors chosen by their own hash,
// never by a running stream or the bushes' draws, and the three passes (vigorous patches, thin
// sides, bare runs) read candidates within 3 m along the coast traced inside the box's window, so
// a box grows the same trails whatever else is built and in whatever order. A strand's leaves take
// the colour of the nearest rim bush within 3 m, from the bushes the worker placed.

type Point = [ number, number, number ];

function normalAt( sdf: SDF, x: number, y: number, z: number ): Point {

	const e = 0.025;
	const nx = sdf( x + e, y, z ) - sdf( x - e, y, z );
	const ny = sdf( x, y + e, z ) - sdf( x, y - e, z );
	const nz = sdf( x, y, z + e ) - sdf( x, y, z - e );
	const l = Math.hypot( nx, ny, nz ) || 1;
	return [ nx / l, ny / l, nz / l ];

}

// Find the first visible edge along an outward ray, not a second tile across a concave bay.
function edgeAt( sdf: SDF, x: number, y: number, z: number, nx: number, nz: number ): number | undefined {

	let lo = - 0.6;
	const d = sdf( x + nx * lo, y, z + nz * lo );
	if ( d > 0 ) return;
	for ( let hi = lo + 0.08; hi <= 2.52; hi += 0.08 ) {

		const next = sdf( x + nx * hi, y, z + nz * hi );
		if ( next >= 0 ) {

			for ( let j = 0; j < 18; j ++ ) {

				const mid = ( lo + hi ) * 0.5;
				if ( sdf( x + nx * mid, y, z + nz * mid ) < 0 ) lo = mid;
				else hi = mid;

			}
			return ( lo + hi ) * 0.5;

		}
		lo = hi;

	}

}

// The worker's sea level (the shore field is cut at y = 0, as shared.waterLevel): the cliff's
// foot, from which the bare lowest quarter is measured.
const SEA_LEVEL = 0;

// No stretch of coast stays bare for much longer than twice this: a third pass admits a small
// patch wherever a lip lies this far from every patch along the coast, so the bare runs keep to
// 0.4-4 m on any coast (at 1.9 a run between two patches' outer strands still reached 4 m). Only a
// notch (a gully, the scar of a fallen column) runs longer: a lip looks out along the footprint's
// outward direction, so its walls hold none, and the bare stone seen from the sea is its mouth.
const FILL_DISTANCE = 1.55;

// On a short coast the growth field's clumps can fall unevenly: one side had a third of another's
// hanging growth. Strands hanging more than a quarter metre below the lip, summed within
// BALANCE_REACH (m) either way along the coast, are held near HANG_DENSITY m per metre of coast:
// a vigorous patch is skipped where they already exceed BALANCE_HIGH of it, and a full patch
// roots at a lip at least BALANCE_GAP from the others where they fall below BALANCE_LOW of it.
// Clumps and the bare stone between them stay; only whole sides are evened out.
const BALANCE_REACH = 3;
const HANG_DENSITY = 1.35;
const BALANCE_LOW = 0.9;
const BALANCE_HIGH = 1.2;
const BALANCE_GAP = 0.8;
// The thin sides' first round thins its candidates by rank within this (m), farther than
// BALANCE_GAP, so a run of free lips is not left bare by a chain of lips each giving way to the
// next (see the second pass).
const FIRST_ROUND_GAP = 1.6;
// The largest spacing a vigorous patch keeps from a higher-ranked one (its draw at 1, deep in a
// clump's fringe: see `spacing` in makeRimTrails), and the farthest a lip's edge lies from its
// site (`lipOf`).
const MAX_SPACING = ( 0.40 + 1.1 ) * ( 1 + 1.6 );
const MAX_EDGE = 1.12;

// Every draw a lip makes comes from its anchor cell's stream (salt LIP_SALT), in a fixed layout:
// HEAD draws (rank, reach, the vigorous patch's spacing, the three passes' strand counts, the leaf
// mound's seed), then STRAND draws for each of up to nine strands. So a patch's plan, and the
// hanging length it will have, are known before anything is grown.
const LIP_SALT = 8143;
const HEAD = 7, STRAND = 7, MAX_STRANDS = 9;

// The site a lip roots at: a turf anchor near the rim and how far behind its edge a strand may root.
interface Site { x: number; y: number; z: number; r: number; rim: number; nx: number; ny: number; nz: number }

interface Lip {
	site: Site; i: number; j: number;
	// the edge in front of the site, the coast's outward direction there and its coast vertex
	x: number; z: number; nx: number; nz: number; at: number;
	rank: number; draws: Float64Array;
	growth: number; spacing: number; count: number;
}

// whether a outranks b (ties, which 32-bit draws make rare, by anchor cell)
const outranks = ( a: Lip, b: Lip ) => a.rank > b.rank || a.rank === b.rank && ( a.j < b.j || a.j === b.j && a.i < b.i );

// Distances measured along the traced coast. Across a gully or the scar of a fallen column two
// lips can stand a metre apart while the coast between them winds for several, all of it bare.
// Every rule asks for separations up to BALANCE_REACH, so a walk along the coast's vertices from
// one lip finds the other or gives up: two lips the coast joins only beyond that (or not at all
// in the traced window) are farther apart than any rule asks. The walk passes the same vertices
// in any window that holds them, so it measures alike in every box.
class CoastRuler {

	private readonly x: number[] = [];
	private readonly z: number[] = [];
	private readonly next: number[] = [];
	private readonly prev: number[] = [];
	private readonly cells = new Map<number, number[]>();

	constructor( chains: CoastChain[] ) {

		for ( const chain of chains ) {

			const first = this.x.length, n = chain.x.length;
			for ( let k = 0; k < n; k ++ ) {

				const v = this.x.length, x = chain.x[ k ], z = chain.z[ k ];
				this.x.push( x ); this.z.push( z );
				this.next.push( k + 1 < n ? v + 1 : chain.closed ? first : - 1 );
				this.prev.push( k > 0 ? v - 1 : chain.closed ? first + n - 1 : - 1 );
				const key = this.key( Math.floor( x ), Math.floor( z ) );
				let cell = this.cells.get( key );
				if ( ! cell ) this.cells.set( key, cell = [] );
				cell.push( v );

			}

		}

	}

	private key( i: number, j: number ): number { return ( i + 2048 ) * 4096 + j + 2048; }

	/** The nearest coast vertex within a metre of ( x, z ), or -1 (ties by position). */
	locate( x: number, z: number ): number {

		let best = - 1, bestD = 1;
		for ( let j = Math.floor( z ) - 1; j <= Math.floor( z ) + 1; j ++ ) for ( let i = Math.floor( x ) - 1; i <= Math.floor( x ) + 1; i ++ ) {

			for ( const k of this.cells.get( this.key( i, j ) ) ?? [] ) {

				const d = Math.hypot( this.x[ k ] - x, this.z[ k ] - z );
				if ( d < bestD || d === bestD && best >= 0 && ( this.x[ k ] < this.x[ best ] || this.x[ k ] === this.x[ best ] && this.z[ k ] < this.z[ best ] ) ) { bestD = d; best = k; }

			}

		}
		return best;

	}

	/** Separation of two points that lie at the located coast vertices: along the coast (never
	 * less than the straight line) when it joins them within BALANCE_REACH, else Infinity; the
	 * straight line when either is not on the coast. */
	separation( ax: number, az: number, a: number, bx: number, bz: number, b: number ): number {

		const straight = Math.hypot( ax - bx, az - bz );
		if ( a < 0 || b < 0 ) return straight;
		const walk = ( step: number[] ) => {

			let s = 0;
			for ( let v = a; s <= BALANCE_REACH; ) {

				if ( v === b ) return s;
				const w = step[ v ];
				if ( w < 0 || w === a ) break;
				s += Math.hypot( this.x[ w ] - this.x[ v ], this.z[ w ] - this.z[ v ] );
				v = w;

			}
			return Infinity;

		};
		return Math.max( straight, Math.min( walk( this.next ), walk( this.prev ) ) );

	}

}

// Lips by position, for the neighbours within a distance.
class LipGrid {

	private readonly cells = new Map<number, Lip[]>();

	constructor( lips: Lip[] ) {

		for ( const lip of lips ) {

			const key = this.key( Math.floor( lip.x ), Math.floor( lip.z ) );
			let cell = this.cells.get( key );
			if ( ! cell ) this.cells.set( key, cell = [] );
			cell.push( lip );

		}

	}

	private key( i: number, j: number ): number { return ( i + 2048 ) * 4096 + j + 2048; }

	/** Whether any lip within `r` (straight) of `lip` passes `test`. */
	some( lip: Lip, r: number, test: ( other: Lip ) => boolean ): boolean {

		const i0 = Math.floor( lip.x - r ), i1 = Math.floor( lip.x + r ), j0 = Math.floor( lip.z - r ), j1 = Math.floor( lip.z + r );
		for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

			for ( const other of this.cells.get( this.key( i, j ) ) ?? [] ) if ( other !== lip && test( other ) ) return true;

		}
		return false;

	}

	/** The sum of `value` over the lips within `r` (straight) of `lip`, added in the order of their
	 * anchor cells, so it rounds alike whatever order the anchors came in. */
	sum( lip: Lip, r: number, value: ( other: Lip ) => number ): number {

		const terms: [ Lip, number ][] = [];
		this.some( lip, r, ( other ) => {

			const v = value( other );
			if ( v !== 0 ) terms.push( [ other, v ] );
			return false;

		} );
		terms.sort( ( [ a ], [ b ] ) => a.j - b.j || a.i - b.i );
		return terms.reduce( ( total, [ , v ] ) => total + v, 0 );

	}

}

// One strand's drop below its root, before the cliff caps it (m).
function dropOf( tier: number, u: number ): number {

	return tier < 0.34 ? 0.20 + u * 0.25 : tier < 0.85 ? 0.45 + Math.pow( u, 1.3 ) * 0.75 : 1.5 + u * 1.1;

}

// The hanging section's node count for a drop (see `trace`).
const hangNodes = ( drop: number ) => Math.max( 10, Math.min( 34, Math.round( drop / 0.075 ) ) );

// A strand's plan: its draws, and the forks' from their own stream.
interface StrandPlan { offset: number; inset: number; tier: number; drop: number; palette: number; seed: number; forkSeed: number }

function strandPlan( lip: Lip, b: number, sparse: boolean ): StrandPlan {

	const d = lip.draws, o = HEAD + b * STRAND;
	const tier = sparse ? 0.25 + d[ o + 2 ] * 0.6 : d[ o + 2 ];
	return {
		offset: d[ o ], inset: d[ o + 1 ], tier, drop: dropOf( tier, d[ o + 3 ] ), palette: d[ o + 4 ],
		seed: Math.floor( d[ o + 5 ] * 0x7fffffff ), forkSeed: Math.floor( d[ o + 6 ] * 0x7fffffff ),
	};

}

// The forks a strand of `drop` will try: where along its hanging nodes they leave and how far
// they fall, and their own seeds.
function forkPlan( forkSeed: number, drop: number ): { from: number; drop: number; seed: number }[] {

	const rng = mulberry32( forkSeed );
	const a = rng(), b = rng();
	const count = drop > 0.7 ? ( a < 0.6 ? 1 : 0 ) + ( drop > 1.4 && b < 0.45 ? 1 : 0 ) : 0;
	const nodes = hangNodes( drop ), forks = [];
	for ( let f = 0; f < 2; f ++ ) {

		const from = 16 + Math.max( 2, Math.floor( nodes * ( 0.2 + rng() * 0.4 ) ) );
		const length = drop * ( 1 - ( from - 16 ) / nodes ) * ( 0.35 + rng() * 0.45 );
		const seed = Math.floor( rng() * 0x7fffffff );
		if ( f < count ) forks.push( { from, drop: length, seed } );

	}
	return forks;

}

// The length a vigorous patch of the lip's planned strands will hang more than a quarter metre
// below the turf, from the plan alone (as `hanging` measures a grown one); strands the cliff
// turns away count too.
function plannedHang( lip: Lip ): number {

	let length = 0;
	for ( let b = 0; b < lip.count; b ++ ) {

		const plan = strandPlan( lip, b, false );
		const drop = Math.min( plan.drop, ( lip.site.y - SEA_LEVEL ) * 0.75 - 0.03 );
		length += Math.max( 0, drop - 0.27 );
		for ( const fork of forkPlan( plan.forkSeed, drop ) ) if ( fork.drop >= 0.18 ) length += fork.drop;

	}
	return length;

}

/** How far round a box the anchors and the traced coast that decide its trails reach (m), and the
 * bushes that colour them. The longest chain of rules a patch's choice reads, lip edge to lip edge
 * in straight distance: the third pass (FILL_DISTANCE) over the bare lips (FILL_DISTANCE) over the
 * second round (BALANCE_GAP), whose thin side sums the first round's hang (BALANCE_REACH), which
 * thins by rank (FIRST_ROUND_GAP) among lips whose side sums the vigorous patches' hang
 * (BALANCE_REACH), each chosen against the plans within BALANCE_REACH of lips spaced by up to
 * MAX_SPACING: 18.4 m, and an anchor's site lies up to MAX_EDGE from its edge at either end. */
export const TRAIL_REACH = Math.ceil( 2 * FILL_DISTANCE + BALANCE_GAP + FIRST_ROUND_GAP + 3 * BALANCE_REACH + MAX_SPACING + 2 * MAX_EDGE );
export const TRAIL_BUSH_REACH = 5;

/** The rim's hanging trails rooted at the lips whose anchors lie in each of `boxes` (half-open),
 * each box's strands in its own list (a fork's `parent` indexes that list). Clumped patches of
 * top-rooted trails cross the lip before bending down: bare stretches of stone between patches of
 * one to nine strands, mostly short with a long tail of strands that wander, fork and reach far
 * down the cliff, and a mounded clump of leaves over each patch's lip.
 *
 * The lips are the turf anchors along the rim, each with a rank and a plan drawn from its own
 * cell's stream; three passes choose the patches by local rules on those candidates, measured
 * along the coast traced in the window (`coast`, the rim's traced chains):
 *   1. vigorous patches where the coast's growth field is high, a lip giving way to a higher-ranked
 *      one within either's spacing, or where the higher-ranked ones within BALANCE_REACH that
 *      survive that already hang more than BALANCE_HIGH of the coast's share (by their plans);
 *   2. full patches at lips farther than BALANCE_GAP from the vigorous patches where those hang
 *      less than BALANCE_LOW of it, among themselves by rank within BALANCE_GAP, in two rounds;
 *   3. sparse patches at lips farther than FILL_DISTANCE from both where one grows, among
 *      themselves by rank within FILL_DISTANCE.
 * The later passes fill round the patches that grew. A patch's choice reads lips up to 18.4 m away
 * in straight distance, so `anchors` and `coast` must cover the boxes and TRAIL_REACH round them,
 * and `bushes` (BUSH_STRIDE each: a trail takes the leaves of the nearest bush within 3 m)
 * TRAIL_BUSH_REACH. Everything derives from the anchors, the footprint and noise fields with fixed
 * seeds, so the coast is covered the same way whatever shape the island grows to, and a box grows
 * the same patches whatever else is built. */
export function makeRimTrails( sdf: SDF, fp: Footprint, anchors: Float32Array, coast: CoastChain[], bushes: Float32Array, boxes: Bounds[] ): RimStrand[][] {

	const ruler = new CoastRuler( coast );
	const lips: Lip[] = [];
	for ( let k = 0; k < anchors.length; k += VEGETATION_STRIDE ) {

		const y = anchors[ k + 1 ], ny = anchors[ k + 4 ], rim = anchors[ k + 6 ];
		if ( ! supportsMeadow( y, ny ) || rim < - 1.45 || rim > 0.45 ) continue;
		const x = anchors[ k ], z = anchors[ k + 2 ];
		const rng = anchorStream( x, z, LIP_SALT );
		const draws = new Float64Array( HEAD + STRAND * MAX_STRANDS );
		for ( let d = 0; d < draws.length; d ++ ) draws[ d ] = rng();
		const site: Site = { x, y, z, r: 0.65 + draws[ 1 ] * 0.25, rim, nx: anchors[ k + 3 ], ny, nz: anchors[ k + 5 ] };
		const edge = lipOf( sdf, fp, site );
		if ( ! edge ) continue;
		// Where the coast's growth field is low the stone stays bare for metres; inside a clump
		// patches sit 0.4-1.5 m apart, thinning toward its fringes.
		const growth = noise3( edge.x * 0.31 + 4.1, 1.7, edge.z * 0.31 - 2.6 ) * 0.5 + 0.5;
		const fringe = 1 - smoothstep( 0.40, 0.68, growth );
		const spacing = ( 0.40 + Math.pow( draws[ 2 ], 1.6 ) * 1.1 ) * ( 1 + fringe * 1.6 );
		// One to nine strands, few in most patches and many in the vigorous ones.
		const vigour = smoothstep( 0.40, 0.85, growth );
		const count = 1 + Math.floor( Math.pow( draws[ 3 ], 1.5 - vigour * 0.7 ) * 8.99 );
		const [ i, j ] = anchorCell( x, z );
		lips.push( { site, i, j, ...edge, at: ruler.locate( edge.x, edge.z ), rank: draws[ 0 ], draws, growth, spacing, count } );

	}
	const grid = new LipGrid( lips );
	const apart = ( a: Lip, b: Lip ) => ruler.separation( a.x, a.z, a.at, b.x, b.z, b.at );
	const memo = <T>( f: ( lip: Lip ) => T ) => {

		const known = new Map<Lip, T>();
		return ( lip: Lip ) => {

			let v = known.get( lip );
			if ( v === undefined ) known.set( lip, v = f( lip ) );
			return v;

		};

	};

	// 1. vigorous patches
	const vigorous = ( lip: Lip ) => lip.growth >= 0.40;
	const spaced = memo( ( lip ) => vigorous( lip ) && ! grid.some( lip, MAX_SPACING, ( o ) => vigorous( o ) && outranks( o, lip ) && Math.hypot( o.x - lip.x, o.z - lip.z ) < Math.max( lip.spacing, o.spacing ) ) );
	const planned = memo( plannedHang );
	const first = memo( ( lip ) => {

		if ( ! spaced( lip ) ) return false;
		const above = grid.sum( lip, BALANCE_REACH, ( o ) => spaced( o ) && outranks( o, lip ) && apart( o, lip ) < BALANCE_REACH ? planned( o ) : 0 );
		return above <= BALANCE_HIGH * HANG_DENSITY * 2 * BALANCE_REACH;

	} );
	// the patches grown at the lips the passes chose (each its own strand list), or null where the
	// cliff turned every strand away: each later pass fills round what grew
	const grow = ( lip: Lip, count: number, sparse: boolean ) => {

		const strands: RimStrand[] = [];
		growPatch( sdf, lip, count, sparse, bushes, strands );
		return strands.length ? strands : null;

	};
	const firstPatch = memo( ( lip ) => first( lip ) ? grow( lip, lip.count, false ) : null );
	// 2. where a side came out thin, full patches of two to seven strands at the free lips
	const hangAround = ( lip: Lip, patchAt: ( o: Lip ) => RimStrand[] | null ) =>
		grid.sum( lip, BALANCE_REACH, ( o ) => apart( o, lip ) < BALANCE_REACH ? hanging( patchAt( o ) ?? [], 0 ) : 0 );
	// whether a lip is free (no patch of `patchAt` within BALANCE_GAP) on a side that hangs less
	// than BALANCE_LOW of the coast's share with them
	const freeOnThinSide = ( lip: Lip, patchAt: ( o: Lip ) => RimStrand[] | null ) =>
		! grid.some( lip, BALANCE_GAP, ( o ) => apart( o, lip ) < BALANCE_GAP && patchAt( o ) !== null )
		&& hangAround( lip, patchAt ) < BALANCE_LOW * HANG_DENSITY * 2 * BALANCE_REACH;
	const thin = memo( ( lip ) => ! first( lip ) && freeOnThinSide( lip, firstPatch ) );
	// Thinning by rank leaves a run of lips bare where each gives way to a higher-ranked neighbour
	// that gives way in turn, so the free lips left more than BALANCE_GAP from the patches that grew
	// thin again among themselves, once, where the side is still thin with the first round's.
	const full = ( lip: Lip ) => grow( lip, 2 + Math.floor( lip.draws[ 4 ] * 5.99 ), false );
	const firstRound = memo( ( lip ) => thin( lip ) && ! grid.some( lip, FIRST_ROUND_GAP, ( o ) => outranks( o, lip ) && apart( o, lip ) < FIRST_ROUND_GAP && thin( o ) ) );
	const firstRoundPatch = memo( ( lip ) => firstRound( lip ) ? full( lip ) : null );
	const left = memo( ( lip ) => thin( lip ) && ! firstRound( lip ) && freeOnThinSide( lip, ( o ) => firstPatch( o ) ?? firstRoundPatch( o ) ) );
	const secondRound = memo( ( lip ) => left( lip ) && ! grid.some( lip, BALANCE_GAP, ( o ) => outranks( o, lip ) && apart( o, lip ) < BALANCE_GAP && left( o ) ) );
	const secondPatch = memo( ( lip ) => firstRoundPatch( lip ) ?? ( secondRound( lip ) ? full( lip ) : null ) );
	// 3. the growth field's low stretches can run for many metres on a long coast, and the cliff
	// can turn a chosen patch away: a sparse patch of one to three strands breaks any longer bare
	// run, among the lips where one grows
	const bare = memo( ( lip ) => firstPatch( lip ) === null && secondPatch( lip ) === null
		&& ! grid.some( lip, FILL_DISTANCE, ( o ) => apart( o, lip ) < FILL_DISTANCE && ( firstPatch( o ) ?? secondPatch( o ) ) !== null ) );
	const sparsePatch = memo( ( lip ) => bare( lip ) ? grow( lip, 1 + Math.floor( lip.draws[ 5 ] * 2.99 ), true ) : null );
	const third = memo( ( lip ) => sparsePatch( lip ) !== null && ! grid.some( lip, FILL_DISTANCE, ( o ) => outranks( o, lip ) && apart( o, lip ) < FILL_DISTANCE && sparsePatch( o ) !== null ) );
	const patch = ( lip: Lip ) => firstPatch( lip ) ?? secondPatch( lip ) ?? ( third( lip ) ? sparsePatch( lip ) : null );

	return boxes.map( ( box ) => {

		const strands: RimStrand[] = [];
		const owned = lips.filter( ( lip ) => lip.site.x >= box.x0 && lip.site.x < box.x1 && lip.site.z >= box.z0 && lip.site.z < box.z1 )
			.sort( ( a, b ) => a.j - b.j || a.i - b.i );
		for ( const lip of owned ) {

			const grownHere = patch( lip );
			if ( ! grownHere ) continue;
			const offset = strands.length;
			for ( const strand of grownHere ) strands.push( strand.parent === undefined ? strand : { ...strand, parent: strand.parent + offset } );

		}
		return strands;

	} );

}

/** Length (m) of the strands from index `first` on that hangs more than a quarter metre below
 * the turf they root in (a fork measures from its parent's root). */
export function hanging( strands: RimStrand[], first: number, end = strands.length ): number {

	let length = 0;
	for ( let i = first; i < end; i ++ ) {

		const p = strands[ i ].points, parent = strands[ i ].parent;
		const top = ( parent === undefined ? p : strands[ parent ].points )[ 1 ] - 0.25;
		for ( let k = 6; k < p.length; k += 6 ) {

			if ( p[ k + 1 ] < top ) length += Math.hypot( p[ k ] - p[ k - 6 ], p[ k + 1 ] - p[ k - 5 ], p[ k + 2 ] - p[ k - 4 ] );

		}

	}
	return length;

}

// The lip in front of a meadow site: the coast's outward direction from the footprint and the
// first edge along it, or undefined where the site is too far from the edge to send a trail over.
function lipOf( sdf: SDF, fp: Footprint, site: Site ): { x: number; z: number; nx: number; nz: number } | undefined {

	if ( ! supportsMeadow( site.y, site.ny ) || site.rim < - 1.8 ) return;
	const e = 0.16;
	const gx = fp.dist( site.x + e, site.z ) - fp.dist( site.x - e, site.z );
	const gz = fp.dist( site.x, site.z + e ) - fp.dist( site.x, site.z - e );
	const g = Math.hypot( gx, gz );
	if ( g < 0.02 ) return;
	const nx = gx / g, nz = gz / g;
	const edge = edgeAt( sdf, site.x, site.y - 0.18, site.z, nx, nz );
	if ( edge === undefined || edge < 0.08 || edge > Math.min( MAX_EDGE, site.r + 0.30 ) ) return;
	return { x: site.x + nx * edge, z: site.z + nz * edge, nx, nz };

}

// The leaves of the nearest bush within 3 m of a strand's root (its colour, its leaves' scale and
// how far it stands), else a green of the strand's own and the bushes' mean leaf.
function leafOf( bushes: Float32Array, x: number, y: number, z: number, palette: number ): RimStrand[ 'leaf' ] {

	let best = - 1, bestD = 3;
	for ( let k = 0; k < bushes.length; k += BUSH_STRIDE ) {

		const d = Math.hypot( bushes[ k ] - x, bushes[ k + 1 ] - 0.08 * bushes[ k + 3 ] - y, bushes[ k + 2 ] - z );
		if ( d < bestD || d === bestD && best >= 0 && ( bushes[ k ] < bushes[ best ] || bushes[ k ] === bushes[ best ] && bushes[ k + 2 ] < bushes[ best + 2 ] ) ) { bestD = d; best = k; }

	}
	if ( best < 0 ) return [ ...BUSH_GREENS[ Math.floor( palette * BUSH_GREENS.length ) ], 0.75, Infinity ];
	return [ bushes[ best + 11 ], bushes[ best + 12 ], bushes[ best + 13 ], Math.sqrt( bushes[ best + 8 ] * bushes[ best + 10 ] ), bestD ];

}

// Root `count` strands behind one lip as its plan lays them out and crown them with a leaf mound;
// a sparse patch keeps its strands in the upper metre, most long enough to show below the turf
// skirt. Adds nothing when no strand could be kept clear of the stone.
function growPatch( sdf: SDF, lip: Lip, count: number, sparse: boolean, bushes: Float32Array, strands: RimStrand[] ): void {

	const { site, nx, nz } = lip;
	const patchStart = strands.length;
	const spread = Math.min( 0.55, 0.06 + Math.sqrt( count ) * 0.12 );
	for ( let branch = 0; branch < count; branch ++ ) {

		const plan = strandPlan( lip, branch, sparse );
		const offset = ( plan.offset * 2 - 1 ) * spread;
		const inset = 0.05 + plan.inset * 0.12;
		const x = site.x - nz * offset + nx * inset, z = site.z + nx * offset + nz * inset;
		const y = topAt( sdf, x, z );
		if ( y === undefined ) continue;
		const rootNormal = normalAt( sdf, x, y, z );
		if ( ! supportsMeadow( y, rootNormal[ 1 ] ) ) continue;
		const topEdge = edgeAt( sdf, x, y - 0.18, z, nx, nz );
		if ( topEdge === undefined || topEdge > 1.25 || topEdge < 0.02 ) continue;
		// Long-tailed drops: about 15 % reach 1.5-2.6 m, the rest stay in the upper metre, and
		// the lowest quarter of the cliff (above the sea at its foot) always stays bare stone.
		const drop = Math.min( plan.drop, ( y - SEA_LEVEL ) * 0.75 - 0.03 );
		// pushed clear of the stone, a node may not sink into that quarter either
		const floor = SEA_LEVEL + ( y - SEA_LEVEL ) * 0.25;
		const points = trace( sdf, x, y, z, nx, nz, topEdge, rootNormal, drop, floor, mulberry32( plan.seed ) );
		if ( ! points ) continue;
		const index = strands.length;
		strands.push( { points, seed: plan.seed, lip: 16, leaf: leafOf( bushes, x, y, z, plan.palette ), anchor: [ lip.i, lip.j ] } );
		// Longer strands fork once or twice partway down and spread apart.
		for ( const fork of forkPlan( plan.forkSeed, drop ) ) {

			const branched = branchFrom( sdf, points, fork.from, nx, nz, fork.drop, floor, mulberry32( fork.seed ) );
			if ( branched ) strands.push( { points: branched, seed: fork.seed, lip: 0, parent: index, from: fork.from } );

		}

	}
	if ( strands.length === patchStart ) return;
	strands[ patchStart ].clump = lipClump( sdf, lip.x, lip.z, nx, nz, spread, count, mulberry32( Math.floor( lip.draws[ 6 ] * 0x7fffffff ) ) );

}

// A root arc from the turf over the lip, then a hanging section that keeps clear of the wall,
// drifts sideways and wanders more the longer it hangs. Returns x, y, z and the normal per node.
function trace( sdf: SDF, x: number, y: number, z: number, nx: number, nz: number, topEdge: number, rootNormal: Point, drop: number, floor: number, rng: Rng ): Float32Array | undefined {

	const drift = ( rng() - 0.5 ) * ( 0.30 + drop * 0.18 );
	const wander = 0.02 + drop * 0.05, waves = 1 + drop * 1.6, wavePhase = rng() * Math.PI * 2;
	const air = 0.13 + rng() * 0.04;
	const points: number[] = [];
	if ( ! appendClear( sdf, points, x, y - 0.02, z, floor, rootNormal ) ) return;
	// The short arch hides in the crown before its outside section turns down.
	for ( let j = 1; j <= 16; j ++ ) {

		const u = j / 16;
		const out = ( topEdge + air ) * u;
		const side = Math.sin( u * Math.PI ) * drift * 0.35;
		if ( ! appendClear( sdf, points, x + nx * out - nz * side, y + 0.20 * Math.sin( u * Math.PI * 0.90 ) - 0.04 * u, z + nz * out + nx * side, floor ) ) return;

	}
	const nodes = hangNodes( drop );
	for ( let j = 1; j <= nodes; j ++ ) {

		const u = j / nodes, py = y + 0.022 - drop * u;
		const side = drift * u + Math.sin( u * Math.PI * waves + wavePhase ) * wander * u;
		const baseX = x - nz * side, baseZ = z + nx * side;
		const wall = edgeAt( sdf, baseX, py, baseZ, nx, nz );
		if ( wall === undefined ) return;
		// A ray near the roof can hit a shallow top dip before the outside wall.
		// Once the branch crosses the lip, it cannot turn back into that dip.
		const out = Math.max( topEdge, wall ) + air + Math.sin( u * Math.PI ) * 0.06;
		if ( ! appendClear( sdf, points, baseX + nx * out, py, baseZ + nz * out, floor ) ) return;

	}
	return new Float32Array( points );

}

// A side branch from node `from` of a hanging strand, leaning away sideways as it falls.
function branchFrom( sdf: SDF, parent: Float32Array, from: number, nx: number, nz: number, drop: number, floor: number, rng: Rng ): Float32Array | undefined {

	if ( drop < 0.18 ) return;
	const k = from * 6;
	const x = parent[ k ], y = parent[ k + 1 ], z = parent[ k + 2 ];
	const lean = ( rng() < 0.5 ? - 1 : 1 ) * ( 0.10 + rng() * 0.12 + drop * 0.12 );
	const points: number[] = [];
	if ( ! appendClear( sdf, points, x, y, z, floor ) ) return;
	const nodes = Math.max( 5, Math.min( 24, Math.round( drop / 0.075 ) ) );
	for ( let j = 1; j <= nodes; j ++ ) {

		// It parts from the parent sideways first, then hangs.
		const u = j / nodes, side = lean * Math.sqrt( u );
		if ( ! appendClear( sdf, points, x - nz * side + nx * 0.03 * Math.sin( u * Math.PI ), y - drop * u, z + nx * side + nz * 0.03 * Math.sin( u * Math.PI ), floor ) ) return;

	}
	return new Float32Array( points );

}

// Push a node out to 0.112 m from the stone (the leaves' wall clearance) and append it with its
// outward normal; false when it cannot be kept clear or would sink below `floor`, into the
// cliff's lowest quarter.
function appendClear( sdf: SDF, points: number[], px: number, py: number, pz: number, floor: number, rootNormal?: Point ): boolean {

	if ( ! rootNormal ) {

		for ( let i = 0; i < 6; i ++ ) {

			const d = sdf( px, py, pz );
			if ( d >= 0.105 ) break;
			const n = normalAt( sdf, px, py, pz );
			px += n[ 0 ] * ( 0.112 - d ); py += n[ 1 ] * ( 0.112 - d ); pz += n[ 2 ] * ( 0.112 - d );

		}
		if ( sdf( px, py, pz ) < 0.09 || py < SEA_LEVEL + 0.5 || py < floor ) return false;

	}
	const n = rootNormal ?? normalAt( sdf, px, py, pz );
	points.push( px, py, pz, n[ 0 ], n[ 1 ], n[ 2 ] );
	return true;

}

// A low, mounded clump of leaves sitting on the turf over a patch's lip, curling a little over the
// edge: 0.3-0.6 m across, stretched along the coast. x, y, z and the mound's normal per anchor.
function lipClump( sdf: SDF, lipX: number, lipZ: number, nx: number, nz: number, spread: number, count: number, rng: Rng ): Float32Array | undefined {

	const cx = lipX - nx * 0.10, cz = lipZ - nz * 0.10;
	const ground = topAt( sdf, cx, cz );
	if ( ground === undefined ) return;
	const radius = Math.min( 0.32, 0.15 + rng() * 0.08 + spread * 0.18 + count * 0.008 );
	const height = radius * ( 0.55 + rng() * 0.2 ), stretch = 1.2 + rng() * 0.3;
	const anchors: number[] = [];
	const leaves = Math.round( 14 + radius * radius * 380 );
	for ( let i = 0; i < leaves; i ++ ) {

		// Points on a half-ellipsoid, denser toward its crown.
		const a = rng() * Math.PI * 2, c = Math.pow( rng(), 0.7 );
		const s = Math.sqrt( 1 - c * c ) * ( 0.75 + rng() * 0.25 );
		const along = Math.cos( a ) * s * stretch, across = Math.sin( a ) * s;
		let px = cx - nz * along * radius + nx * across * radius, pz = cz + nx * along * radius + nz * across * radius;
		let py = ground + c * height;
		// Outside the edge the mound curls down over the lip.
		const outside = ( px - lipX ) * nx + ( pz - lipZ ) * nz;
		if ( outside > 0 ) py -= outside * 0.9;
		let gx = - nz * along + nx * across, gz = nx * along + nz * across, gy = c * radius / height;
		const l = Math.hypot( gx, gy, gz ) || 1;
		gx /= l; gy /= l; gz /= l;
		// Keep the leaves on top of the turf and clear of the stone.
		for ( let k = 0; k < 6 && sdf( px, py, pz ) < 0.03; k ++ ) {

			py += 0.02; px += nx * 0.01; pz += nz * 0.01;

		}
		anchors.push( px, py, pz, gx, gy, gz );

	}
	return new Float32Array( anchors );

}
