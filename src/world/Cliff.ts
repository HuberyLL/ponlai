// The island's sea cliff, derived from the footprint alone, so the land gets the same kind of coast
// whatever shape it grows to, with no hand-placed features.
//
// A natural cliff face is not a stack of blocks: it is what is left after the rock mass has shed
// pieces of every size along its discontinuities. In bedded sedimentary rock these are a few sets
// of steep joints, each with its own regional strike, and gently dipping bedding partings. The sea
// and the weather loosen blocks bounded by those planes and the face retreats scar by scar:
// rockfall scars follow a power law of size (a few large, many small, the small ones nested in the
// large), their floors and roofs often lie on a bed parting (the depth of a fall is a multiple of
// bed thickness) and their sides on a cross joint. Where the coast runs oblique to the joints the
// face breaks into long faces and short returns. The sea undercuts the foot in a notch that is
// deepest where the coast is most exposed and gives way to a rounded ramp where it is sheltered,
// and rounds every edge in the wave zone; above it the weather opens the softer beds into
// recesses that pinch out within a few metres, and the edges stay as sharp as they broke. At the
// top, soil creep and the weather wear the crest back into a convex shoulder that rolls the free
// face over into the plateau and blunts every break through it (the convexity of a creeping crest
// after Gilbert, *The convexity of hilltops*, Journal of Geology 17, 1909).
// (Scar inventory and the geometry of fracture-bounded blocks after Prémaillon et al., *Conceptual
// model of fracture-limited sea cliff erosion*, Earth Surface Processes and Landforms 46, 2021;
// tidal notches after Antonioli et al., *Tidal notches in Mediterranean Sea*, Quaternary Science
// Reviews 119, 2015. No erosion is simulated: the forms are art-directed from those descriptions.)
//
// So the wall is a slightly battered face around the footprint from which convex blocks, each
// bounded by those planes, are subtracted in three generations of size: the remaining surface is
// the envelope of their inner faces, multi-facet scars meeting at sharp salient and re-entrant
// edges at every angle the joint sets allow. The small breaks are flakes, a flat facet ending in
// a step, rather than small pockets: those, and pairs of pockets side by side, read as dark holes
// (eyes) in the shade, and many small rounded ones as the lumps of dissolved limestone. The field stays a true distance inside each block
// (gradient 1), so the dual-contouring surface nets keep facets flat and their edges crisp (all but
// the shoulder's, meshed by plain surface nets: WorldShapes.ts `cliffSharpCells`).
// `cliffEvents` is the coast's field of large falls (discs hashed per world cell, more of them on
// active stretches of a fixed-seed noise): the stretches that shed blocks, where the sea's blocks
// heap (Stones.ts) and whatever else must agree on them reads it. The wall's own scars do not read
// it: the face keeps one density of scars everywhere.
// Every scar is seeded from a coast point hashed from its position in a world-anchored cell, and
// placed in two tiers: the joint faces and gullies on the plain face, the smaller generations on
// the face with those cut out. Each scar reaches a bounded distance from its anchor and they are
// cut in a canonical order, so what the wall is at a point depends only on the coast within about
// 25 m of it: given the same land distance there, an unchanged stretch of coast keeps its scars,
// to the bit, when the land grows elsewhere, and a part of the coast can be built from its own
// surroundings alone.
//
// Rules (the look is in docs/art-direction.md):
// - Every property of a scar (rockfall scars, joint faces, pockets, steps in the lip, gullies, the
//   notch) comes from its own position hash, never from a running count.
// - Every choice reads only seeds near it (a gully at the seed that ranks first within 3.7 m, a
//   pocket giving way to a higher-ranked pocket proposal crowding it); a scar ends within 4.5 m
//   (first tier) or 3 m (second tier) of its anchor, breaking off along vertical planes in its own
//   frame where it would reach further; the scars are cut in order of level and seed key. So the
//   wall at a point depends only on the land's distance field within 25 m of it, bit for bit
//   (`CliffWall`'s `area` is the box it is evaluated in, grown by 25 m), which the chunk checks
//   rely on (tools/verify-world-chunks.mjs: S2's block, D1, D4); tools/verify-world-stats.mjs
//   checks that the reach clamp trims nothing and what the octagon breaks off.
// - Natural rock, never masonry: the two joint sets run oblique to the world's axes, no level
//   courses or evenly spaced joints. Scar floors and roofs lie on a parting only some of the time;
//   partings and soft beds open over a few metres and pinch out; under the meadow the wall weathers
//   back to an upper slope rather than jutting as a slab, and its lip rolls over into the meadow in
//   a convex shoulder (a quarter ellipse about 0.6 - 1.9 m in from the face and 0.3 - 0.9 m down,
//   broad on some stretches and tighter on others), never a sharp corner.
// - Pockets are much shallower than they are wide and tall, their roofs open outward, two never
//   crowd each other at one height, and their occlusion is lifted a little, so none reads as a
//   black hole or a pair of eyes in the shade.
// - Above the waves breaks stay sharp (rims rounded by a few centimetres at most); only the wave
//   zone and the crest round them (the crest by up to 0.6 m, a fresh break less), so no crisp
//   notch cuts the shoulder. The notch comes and goes with the coast's exposure and its roof stays
//   above the calm sea's crests; joint faces run on below the sea, so no ledge follows the
//   waterline.
// - The weathering relief fades out at the meadow, whose height stays `islandSurfaceHeight` from
//   about 1.75 m inland of the coast (nearer, the shoulder and the crest's rounding of breaks lower
//   it). Steps where a block fell from the lip stop below the meadow's planting height (0.3 m under
//   its own top) and carry no turf (TerrainMaterial keeps it off them). No waterfalls; moss and
//   greenery on the wall stay in its upper 1.2 m (TerrainMaterial).

import { hash3i, noise3, smax, smoothstep } from './noise.ts';

type Field = ( x: number, z: number ) => number;

// ------------------------------------------------------------------ structure

// The two joint sets' normals (azimuth, rad, from +x toward +z), 85 degrees apart. Both run
// oblique to the world's axes, so no straight run of coast along an axis lies along a set.
const SET_A = 0.47, SET_B = SET_A + 1.48;

// Bedding partings at irregular heights: thicknesses 0.18 - 1.6 m, mostly thin, drawn once
// (beds are regional), well below and above any wall.
const BED_Y0 = - 12, BED_N = 64;
const PARTING = new Float64Array( BED_N + 1 );
{

	let y = BED_Y0;
	for ( let k = 0; k <= BED_N; k ++ ) {

		PARTING[ k ] = y;
		const r = hash3i( k, 31, 977 );
		y += 0.18 + r * r * 1.45;

	}

}

// Bed coordinate of a height (with bedShift already added): whole numbers at the partings.
export function bedCoordinate( y: number ): number {

	if ( y <= PARTING[ 0 ] ) return ( y - PARTING[ 0 ] ) / 0.66;
	if ( y >= PARTING[ BED_N ] ) return BED_N + ( y - PARTING[ BED_N ] ) / 0.66;
	let lo = 0, hi = BED_N;
	while ( hi - lo > 1 ) {

		const m = ( lo + hi ) >> 1;
		if ( PARTING[ m ] <= y ) lo = m; else hi = m;

	}
	return lo + ( y - PARTING[ lo ] ) / ( PARTING[ lo + 1 ] - PARTING[ lo ] );

}

function partingHeight( k: number ): number {

	return PARTING[ Math.max( 0, Math.min( BED_N, k ) ) ];

}

// The bedding dips about 3 degrees and undulates over tens of metres, so a parting crosses the
// coast at different heights and never rules a level line.
export function bedShift( x: number, z: number ): number {

	return x * 0.042 - z * 0.028 + noise3( x * 0.085 + 4.4, 6.1, z * 0.085 - 2.7 ) * 0.32
		+ noise3( x * 0.29 - 1.1, 2.9, z * 0.29 + 5.5 ) * 0.07;

}

// How far a parting is opened by the weather here (0 .. 1): each over stretches of a few metres
// and pinching out between them, so no seam runs along the whole coast.
function partingOpen( k: number, x: number, z: number ): number {

	return smoothstep( 0.08, 0.42, noise3( x * 0.16 + k * 3.71, k * 0.73 + 0.31, z * 0.16 - k * 1.93 ) );

}

// A third of the beds are softer and weather back where their partings open.
function softBed( k: number ): number {

	const r = hash3i( k, 17, 4409 );
	return r < 0.33 ? 0.5 + r / 0.33 * 0.5 : 0;

}

// Exposure of the coast to the waves (0 sheltered .. 1 exposed): headlands and convex corners
// take the swell, bays and re-entrant corners are spared. The mean signed distance round a ring
// is positive where most of it lies offshore.
// (The ring's distances are clamped to 3 m, so the exposure reads only the coast near the ring.)
function exposureAt( dist: Field, x: number, z: number ): number {

	let s = 0;
	for ( let i = 0; i < 10; i ++ ) {

		const a = i * Math.PI * 0.2;
		s += Math.max( - 3, Math.min( 3, dist( x + Math.cos( a ) * 2.6, z + Math.sin( a ) * 2.6 ) ) );

	}
	const convex = s / 10 - dist( x, z );
	return Math.min( 1, Math.max( 0, 0.5 + convex * 0.45 + noise3( x * 0.11 - 3.3, 8.2, z * 0.11 + 1.6 ) * 0.4 ) );

}

// How active the coast is here (0 a quiet stretch .. 1 an active one), for cliffEvents only: a
// world-anchored noise of fixed seeds, so a stretch keeps its character as the land grows; about
// half the coast is quiet, a quarter ordinary and a quarter active.
function activity( x: number, z: number ): number {

	return smoothstep( - 0.05, 0.38, noise3( x * 0.04 + 3.3, 7.7, z * 0.04 - 1.9 ) * 0.8 + noise3( x * 0.11 - 5.2, 3.1, z * 0.11 + 2.4 ) * 0.35 );

}

/**
 * The coast's large falls (0 none .. 1 inside one): now and then, more often on an active stretch,
 * one fall a few metres wide, their sizes a long tail. Each world-anchored FALL_CELL cell may hold
 * one fall, a disc round a point hashed in the cell, its radius 1.8 - 3.4 m (most near the small
 * end). The fallen blocks gather below it (Stones.ts), and whatever else must agree on where the
 * coast sheds blocks reads it too; the wall's scars do not. A function of the point alone, of
 * fixed seeds.
 */
export function cliffEvents( x: number, z: number ): number {

	const ci = Math.floor( x / FALL_CELL ), cj = Math.floor( z / FALL_CELL );
	let e = 0;
	for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

		const px = ( i + 0.15 + hash3i( i, j, 5113 ) * 0.7 ) * FALL_CELL, pz = ( j + 0.15 + hash3i( i, j, 5119 ) * 0.7 ) * FALL_CELL;
		const rr = hash3i( i, j, 5123 ), R = 1.8 + 1.6 * rr * rr;
		const d = Math.hypot( x - px, z - pz );
		if ( d >= R ) continue;
		// (a fall in every cell where the coast is active, in a fifth where it is quiet)
		if ( hash3i( i, j, 5101 ) >= Math.min( 1, 0.2 + 2 * activity( px, pz ) ) ) continue;
		e = Math.max( e, 1 - smoothstep( 0.7, 1, d / R ) );

	}
	return e;

}
// the side of the cells that hold at most one fall each (m)
const FALL_CELL = 7;

// ------------------------------------------------------------------ scars

// A block the cliff has shed: the convex intersection of half-spaces n . p <= c. Its inner faces
// are the scar left in the wall.
export interface Scar {
	planes: Float64Array; // nx, ny, nz, c per plane
	n: number;
	floor: number; // index of the plane the block rested on (the scar's floor), -1: none
	lip: boolean; // reaches above the meadow: the floor is the new top where it cut in
	id: number; // hash for the material's per-facet shade
	fresh: number; // 0 old and weathered .. 1 recently fallen: paler, unlichened stone
	round: number; // rounding of the scar's rim (m)
	level: number;
	kind: ScarKind;
	key: number; // its coast seed's key: with the level, the order the scars are cut in
	cx: number; cy: number; cz: number; size: number; // its anchor on the surface (a pocket's centre) and half width
	x0: number; x1: number; z0: number; z1: number; y0: number; y1: number; // bounds
	// the plan bounds without the crest's rounding: how far the scar itself reaches (shed)
	near: { x0: number; x1: number; z0: number; z1: number };
}

// a joint face, a step fallen from the lip, a pocket (a block fallen out of the face), a flake
// (a slab spalled off along one fracture) or a gully
type ScarKind = 'face' | 'lip' | 'pocket' | 'flake' | 'gully';

interface Level {
	cell: number; off: number; per: number; keep: number;
	width: [ number, number ]; // half widths along the coast
	depth: [ number, number ]; // behind the surface it is cut into
	height: [ number, number ]; // of a pocket: floor to roof at the seed
	floor: [ number, number ]; // height of its floor at the seed
	face: number; // share that open the full height from below the sea (a joint face)
	lip: number; // share that reach above the meadow
	fresh: number;
	round: [ number, number ]; // weathered rim rounding
	irregular: number; // share broken along fractures of no set
	flake: number; // share of the rest that spall off as flakes rather than fall out as pockets
}

// Three generations: joint faces that set the plan of a stretch of coast, pockets where blocks
// fell out of them and flakes spalled off them, and smaller flakes on them. Above the
// waves the rims stay sharp, a few centimetres at most: fractured rock breaks crisply, and only
// the sea and the weathered crest round its edges (see rimRound).
const LEVELS: Level[] = [
	{ cell: 3.6, off: 1.3, per: 1, keep: 0.95, width: [ 1.1, 2.5 ], depth: [ 0.3, 0.85 ], height: [ 1.3, 2.6 ], floor: [ - 1.6, - 0.3 ], face: 1, lip: 0.5, fresh: 0.25, round: [ 0.012, 0.035 ], irregular: 0.2, flake: 0 },
	{ cell: 2.0, off: 0.6, per: 3, keep: 0.65, width: [ 0.35, 1.0 ], depth: [ 0.14, 0.4 ], height: [ 0.5, 1.6 ], floor: [ 0.35, 2.3 ], face: 0.35, lip: 0.12, fresh: 0.3, round: [ 0.01, 0.03 ], irregular: 0.3, flake: 0.5 },
	{ cell: 1.1, off: 0.25, per: 2, keep: 0.45, width: [ 0.22, 0.55 ], depth: [ 0.05, 0.13 ], height: [ 0.3, 0.9 ], floor: [ 0.3, 2.5 ], face: 0, lip: 0, fresh: 0.25, round: [ 0.006, 0.014 ], irregular: 0.5, flake: 1 },
];
// Two pockets nearer than this (m, between their rims) at much the same height read as a pair
// of eyes in the shade: only the higher-ranked one falls.
const POCKET_GAP = 1.0, POCKET_RISE = 0.6;
// Gullies: narrow slots opened along a joint from the sea to the lip, at the seeds that rank first
// among the seeds within `spacing` of them: one candidate per 2 x 3.7 m of coast, about as many as
// the 9 m cells a coast crosses (one every 7 m or so) gave before, so one gully per 13 m or so.
const GULLY = { spacing: 3.7, keep: 0.55, level: LEVELS.length };
// How far a scar reaches from its anchor (m, either way in x and z): the joint faces and gullies,
// and the smaller generations. A bounded reach is what makes the wall at a point depend only on
// the coast near it. Most scars lie well inside it; the few that would cut rock beyond it (a wide
// joint face whose leaning sides splay out at the toe, or that runs straight on across a bay) end
// there in vertical breaks across the scar, in its own frame, rather than in a cut along the
// world's axes.
export const REACH_A = 4.5, REACH_B = 3.0;
// No scar reaches further behind the face than this (m), so the meadow keeps its plateau.
const MAX_REACH = 1.3;
// The meadow's planting height: a floor cut into the lip stays clear below it.
const BARE_STEP = 2.55;
// How much the crest rounds the rims of the scars cut through its shoulder (m, the smooth maximum's
// width; a fresh scar's a little less): a crisp notch in the rolled-over lip would bring back the
// sharp corner the shoulder rounds off.
const CREST_ROUND = 0.6;

const wrap = ( a: number ) => Math.atan2( Math.sin( a ), Math.cos( a ) );
const lerp = ( a: number, b: number, t: number ) => a + ( b - a ) * t;

// The solid behind a face ( a <= 0, a the distance out from it ) and under a top ( b <= 0, the
// height above it ), their corner rolled over by a quarter ellipse reaching rh in from the face
// and rv down from the top: the face and the top stay exact, and the field is continuous where
// the arc meets them. (The rounded intersection of hg_sdf's fOpIntersectionRound, Mercury, with
// Inigo Quilez's approximate ellipse distance for the arc.)
function shoulder( a: number, b: number, rh: number, rv: number ): number {

	const d = Math.max( a, b );
	const qx = a + rh, qy = b + rv;
	if ( qx <= 0 || qy <= 0 ) return d;
	const ux = qx / rh, uy = qy / rv;
	const k0 = Math.hypot( ux, uy ), k1 = Math.hypot( ux / rh, uy / rv );
	return Math.max( d, k0 * ( k0 - 1 ) / k1 );

}

// The polytope's vertices: all triple intersections inside every plane (x, y, z each).
function vertices( p: Float64Array, n: number ): number[] {

	const v: number[] = [];
	for ( let a = 0; a < n; a ++ ) for ( let b = a + 1; b < n; b ++ ) for ( let c = b + 1; c < n; c ++ ) {

		const ax = p[ a * 4 ], ay = p[ a * 4 + 1 ], az = p[ a * 4 + 2 ], ac = p[ a * 4 + 3 ];
		const bx = p[ b * 4 ], by = p[ b * 4 + 1 ], bz = p[ b * 4 + 2 ], bc = p[ b * 4 + 3 ];
		const cx = p[ c * 4 ], cy = p[ c * 4 + 1 ], cz = p[ c * 4 + 2 ], cc = p[ c * 4 + 3 ];
		// Cramer's rule
		const det = ax * ( by * cz - bz * cy ) - ay * ( bx * cz - bz * cx ) + az * ( bx * cy - by * cx );
		if ( Math.abs( det ) < 1e-6 ) continue;
		const x = ( ac * ( by * cz - bz * cy ) - ay * ( bc * cz - bz * cc ) + az * ( bc * cy - by * cc ) ) / det;
		const y = ( ax * ( bc * cz - bz * cc ) - ac * ( bx * cz - bz * cx ) + az * ( bx * cc - bc * cx ) ) / det;
		const z = ( ax * ( by * cc - bc * cy ) - ay * ( bx * cc - bc * cx ) + ac * ( bx * cy - by * cx ) ) / det;
		let inside = true;
		for ( let k = 0; k < n && inside; k ++ ) if ( p[ k * 4 ] * x + p[ k * 4 + 1 ] * y + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ] > 1e-6 ) inside = false;
		if ( inside ) v.push( x, y, z );

	}
	return v;

}

// Keeps the scar within its reach of its anchor and sets its bounds. Where the block would pass
// an octagon round the anchor (in the frame of `angle`, the coast's outward normal there; its
// corners inside the reach less the rims' rounding), it breaks off along vertical planes of that
// octagon; the bounds are then clamped to the reach as well, which makes the reach a guarantee
// without cutting anything.
function bounds( s: Scar, angle: number ): boolean {

	const reach = s.level === 0 || s.kind === 'gully' ? REACH_A : REACH_B;
	const apothem = ( reach - 0.15 ) * Math.cos( Math.PI / 8 );
	let v = vertices( s.planes, s.n );
	const ends: number[] = [];
	for ( let k = 0; k < 8; k ++ ) {

		const dx = Math.cos( angle + k * Math.PI / 4 ), dz = Math.sin( angle + k * Math.PI / 4 );
		const c = dx * s.cx + dz * s.cz + apothem;
		for ( let i = 0; i < v.length; i += 3 ) if ( dx * v[ i ] + dz * v[ i + 2 ] > c ) {

			ends.push( dx, 0, dz, c );
			break;

		}

	}
	if ( ends.length > 0 ) {

		const planes = new Float64Array( s.planes.length + ends.length );
		planes.set( s.planes );
		planes.set( ends, s.planes.length );
		s.planes = planes; s.n = planes.length / 4;
		v = vertices( s.planes, s.n );

	}
	let x0 = Infinity, x1 = - Infinity, y0 = Infinity, y1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( let i = 0; i < v.length; i += 3 ) {

		x0 = Math.min( x0, v[ i ] ); x1 = Math.max( x1, v[ i ] ); y0 = Math.min( y0, v[ i + 1 ] );
		y1 = Math.max( y1, v[ i + 1 ] ); z0 = Math.min( z0, v[ i + 2 ] ); z1 = Math.max( z1, v[ i + 2 ] );

	}
	if ( ! ( x1 > x0 ) || ! ( y1 > y0 ) || ! ( z1 > z0 ) ) return false;
	// rounding reaches a little beyond the faces, and the crest's further
	const m = s.round + 0.05, c = m + CREST_ROUND;
	s.near = {
		x0: Math.max( x0 - m, s.cx - reach ), x1: Math.min( x1 + m, s.cx + reach ),
		z0: Math.max( z0 - m, s.cz - reach ), z1: Math.min( z1 + m, s.cz + reach ),
	};
	s.x0 = Math.max( x0 - c, s.cx - reach ); s.x1 = Math.min( x1 + c, s.cx + reach );
	s.z0 = Math.max( z0 - c, s.cz - reach ); s.z1 = Math.min( z1 + c, s.cz + reach );
	s.y0 = y0 - m; s.y1 = y1 + c;
	return true;

}

// a candidate seed where the footprint's edge crosses a world-anchored grid
interface Seed { x: number; z: number; key: number }

// Coast points where the footprint edge crosses a fine grid anchored to the world, not to the
// land's bounds, so the same stretch of coast yields the same points when the island grows.
function coastSeeds( dist: Field, area: { x0: number; z0: number; x1: number; z1: number } ): Seed[] {

	const step = 0.2, seeds: Seed[] = [];
	const i0 = Math.floor( ( area.x0 - 1 ) / step ), i1 = Math.ceil( ( area.x1 + 1 ) / step );
	const j0 = Math.floor( ( area.z0 - 1 ) / step ), j1 = Math.ceil( ( area.z1 + 1 ) / step );
	for ( let j = j0; j < j1; j ++ ) for ( let i = i0; i < i1; i ++ ) {

		const x = ( i + 0.5 ) * step, z = ( j + 0.5 ) * step;
		const d = dist( x, z );
		if ( Math.abs( d ) > step * 1.5 ) continue;
		for ( let axis = 0; axis < 2; axis ++ ) {

			const d1 = dist( x + ( axis === 0 ? step : 0 ), z + ( axis === 1 ? step : 0 ) );
			if ( d * d1 >= 0 ) continue;
			const t = d / ( d - d1 );
			const px = x + ( axis === 0 ? step * t : 0 ), pz = z + ( axis === 1 ? step * t : 0 );
			seeds.push( { x: px, z: pz, key: hash3i( Math.round( px * 10 ), Math.round( pz * 10 ), 911 ) * 0x7fffffff | 0 } );

		}

	}
	// Crossings a few centimetres apart share a key, and so would cut the same scar twice: keep
	// one of each, the same one whatever order they were found in. (By the rounded position the
	// key is hashed from, so two distant seeds whose keys collide both stay.)
	const byPoint = new Map<number, Seed>();
	for ( const s of seeds ) {

		const k = ( Math.round( s.x * 10 ) + 32768 ) * 65536 + Math.round( s.z * 10 ) + 32768;
		const o = byPoint.get( k );
		if ( ! o || s.x < o.x || ( s.x === o.x && s.z < o.z ) ) byPoint.set( k, s );

	}
	return [ ...byPoint.values() ];

}

function gradient( f: Field, x: number, z: number, e: number ): [ number, number ] {

	const gx = f( x + e, z ) - f( x - e, z ), gz = f( x, z + e ) - f( x, z - e );
	const l = Math.hypot( gx, gz ) || 1;
	return [ gx / l, gz / l ];

}

// ------------------------------------------------------------------ the wall

const COLUMN_CELL = 1;

// The cliff wall: a signed distance near the coast that includes the meadow's top. `dist` is the
// footprint's signed distance, `coast` the macro wobble the wall adds to it (the wall's top edge
// sits at dist = coast) and `top` the meadow's height. Per-(x, z) work is cached across the
// vertical sample column the mesher runs through (y is innermost there).
export class CliffWall {

	scars: Scar[] = [];
	// after each `at` with tracking: the scar whose face the point lies on (-1: the weathered
	// face no scar reached), whether that face is the scar's floor, the bed coordinate and the
	// height of the column's own top (the meadow, or a ledge cut into the lip)
	owner = - 1; onFloor = false; beta = 0; ownTop = 0;

	private dist: Field; private coast: Field; private top: Field;
	private grid = new Map<number, number[]>();
	// column cache
	private cx = NaN; private cz = NaN;
	private s = 0; private topY = 0; private batter = 0; private shoulderH = 0; private shoulderV = 0; private shift = 0;
	private notch = 0; private notchY = 0; private ramp = 0; private expo = 0;
	private list: number[] = []; // scar indices whose plan bounds hold the column
	private coef: number[] = []; // per listed scar and plane: n.x * x + n.z * z - c, n.y
	private colTop = 0;

	// `area` is the box the caller evaluates the wall in, grown by 25 m: the scars that shape the
	// wall there are seeded within it, and so is all that placed and chose them.
	constructor( dist: Field, coast: Field, top: Field, area: { x0: number; z0: number; x1: number; z1: number } ) {

		this.dist = dist; this.coast = coast; this.top = top;
		const wall = ( x: number, z: number ) => dist( x, z ) - coast( x, z );
		const seeds = coastSeeds( dist, area );
		// Tier A, the joint faces that set the plan of the coast and the gullies, is placed on the
		// plain face; tier B, the pockets and flakes, on the face with tier A cut out. (A chain of
		// two placements rather than one per generation keeps the wall's reach short.)
		this.place( [ ...this.generation( 0, seeds, wall ), ...this.gullies( seeds, wall ) ] );
		this.place( [ ...this.generation( 1, seeds, wall ), ...this.generation( 2, seeds, wall ) ] );

	}

	// Adds a tier's scars in a canonical order, by level and seed key, whatever order they were
	// found in: the smooth maximum that cuts them is order-dependent in its last bits, and every
	// box that builds the wall must cut a point's scars in the same order.
	private place( made: Scar[] ): void {

		made.sort( ( a, b ) => a.level - b.level || a.key - b.key || a.cx - b.cx || a.cz - b.cz );
		for ( const s of made ) this.add( s );

	}

	// One generation's scars: at the seeds with the lowest priority in each world-anchored cell, so
	// a cell's choice depends on its own stretch of coast alone.
	private generation( level: number, seeds: Seed[], wall: Field ): Scar[] {

		const L = LEVELS[ level ], salt = 6007 + level * 131;
		const cells = new Map<number, Seed[]>();
		for ( const s of seeds ) {

			const k = ( Math.floor( ( s.x + L.off ) / L.cell ) + 512 ) * 1024 + Math.floor( ( s.z + L.off * 0.7 ) / L.cell ) + 512;
			const list = cells.get( k );
			if ( list ) list.push( s ); else cells.set( k, [ s ] );

		}
		const rank = ( s: Seed ) => hash3i( s.key, salt, 3 );
		const proposals: {
			seed: Seed; prio: number; r: ( k: number ) => number; n: [ number, number ]; x: number; z: number;
			flake: boolean; pocket: { cy: number; size: number } | null;
		}[] = [];
		for ( const list of cells.values() ) {

			list.sort( ( a, b ) => rank( a ) - rank( b ) || a.key - b.key );
			for ( let j = 0; j < Math.min( L.per, list.length ); j ++ ) {

				const seed = list[ j ];
				const r = ( k: number ) => hash3i( seed.key, salt + k * 37, 7741 );
				if ( r( 0 ) > L.keep ) continue;
				const n = gradient( wall, seed.x, seed.z, 0.12 );
				// the seed moved onto the wall's top edge
				const w = this.coast( seed.x, seed.z );
				const x = seed.x + n[ 0 ] * w, z = seed.z + n[ 1 ] * w;
				const flake = r( 38 ) >= L.face && r( 39 ) < L.flake;
				proposals.push( { seed, prio: rank( seed ), r, n, x, z, flake, pocket: flake ? null : this.pocketProposal( x, z, r, L ) } );

			}

		}
		const made: Scar[] = [];
		for ( const p of proposals ) {

			// A pocket gives way to any higher-ranked one crowding it, whether or not that one gives
			// way in turn, judged on what they would be (seed, hashed heights and widths) rather than
			// on where they were placed, so the choice reads only the coast within a few metres.
			const s = p.pocket;
			if ( s && proposals.some( ( o ) => o !== p && o.pocket && o.prio < p.prio
				&& Math.abs( o.pocket.cy - s.cy ) < POCKET_RISE
				&& Math.hypot( o.x - p.x, o.z - p.z ) < o.pocket.size + s.size + POCKET_GAP ) ) continue;
			const scar = p.flake ? this.makeFlake( p.x, p.z, p.n, p.r, L, level ) : this.makeScar( p.x, p.z, p.n, p.r, L, level );
			if ( scar ) {

				scar.key = p.seed.key;
				made.push( scar );

			}

		}
		return made;

	}

	// The gullies: at the seeds that rank first among the seeds within GULLY.spacing of them, a
	// choice that reads only the coast near each seed.
	private gullies( seeds: Seed[], wall: Field ): Scar[] {

		const salt = 6007 + GULLY.level * 131, R = GULLY.spacing;
		const rank = ( s: Seed ) => hash3i( s.key, salt, 3 );
		const grid = new Map<number, Seed[]>();
		const cell = ( x: number ) => Math.floor( x / R ) + 4096;
		for ( const s of seeds ) {

			const k = cell( s.x ) * 8192 + cell( s.z );
			const list = grid.get( k );
			if ( list ) list.push( s ); else grid.set( k, [ s ] );

		}
		const made: Scar[] = [];
		for ( const seed of seeds ) {

			const h = rank( seed );
			let first = true;
			for ( let gz = cell( seed.z ) - 1; gz <= cell( seed.z ) + 1 && first; gz ++ ) for ( let gx = cell( seed.x ) - 1; gx <= cell( seed.x ) + 1 && first; gx ++ ) {

				for ( const o of grid.get( gx * 8192 + gz ) ?? [] ) {

					if ( o === seed || Math.hypot( o.x - seed.x, o.z - seed.z ) > R ) continue;
					const ho = rank( o );
					if ( ho < h || ( ho === h && o.key < seed.key ) ) { first = false; break; }

				}

			}
			if ( ! first ) continue;
			const r = ( k: number ) => hash3i( seed.key, salt + k * 37, 7741 );
			if ( r( 0 ) > GULLY.keep ) continue;
			const n = gradient( wall, seed.x, seed.z, 0.12 );
			const w = this.coast( seed.x, seed.z );
			const scar = this.makeGully( seed.x + n[ 0 ] * w, seed.z + n[ 1 ] * w, n, r, wall );
			if ( scar ) {

				scar.key = seed.key;
				made.push( scar );

			}

		}
		return made;

	}

	private add( s: Scar ): void {

		const i = this.scars.length;
		this.scars.push( s );
		for ( let gz = Math.floor( s.z0 / COLUMN_CELL ); gz <= Math.floor( s.z1 / COLUMN_CELL ); gz ++ ) {

			for ( let gx = Math.floor( s.x0 / COLUMN_CELL ); gx <= Math.floor( s.x1 / COLUMN_CELL ); gx ++ ) {

				const k = ( gx + 512 ) * 1024 + gz + 512;
				const list = this.grid.get( k );
				if ( list ) list.push( i ); else this.grid.set( k, [ i ] );

			}

		}
		this.cx = NaN;

	}

	// The surface along a horizontal line inward from a point offshore (m along -n from it), or
	// NaN where the line finds no rock within reach.
	private surfaceAlong( x: number, y: number, z: number, nx: number, nz: number ): number {

		let t = - 1.6;
		if ( this.solid( x - nx * t, y, z - nz * t ) < 0 ) return NaN;
		for ( ; t < 2.4; t += 0.08 ) {

			if ( this.solid( x - nx * ( t + 0.08 ), y, z - nz * ( t + 0.08 ) ) < 0 ) {

				let lo = t, hi = t + 0.08;
				for ( let i = 0; i < 8; i ++ ) {

					const m = ( lo + hi ) * 0.5;
					if ( this.solid( x - nx * m, y, z - nz * m ) < 0 ) hi = m; else lo = m;

				}
				return ( lo + hi ) * 0.5;

			}

		}
		return NaN;

	}

	// A scar's heights at its seed, from its hashes alone: its floor and roof (or the meadow), what
	// it is (a joint face, a step fallen from the lip or a pocket) and what bounds it above and
	// below; null where too little height is left for it.
	private heights( x: number, z: number, r: ( k: number ) => number, L: Level ) {

		const top = this.top( x, z );
		const shift = bedShift( x, z );
		const partingAt = ( y: number, up: boolean ) => {

			const k = up ? Math.ceil( bedCoordinate( y + shift ) ) : Math.floor( bedCoordinate( y + shift ) );
			return partingHeight( k ) - shift;

		};

		// heights at the seed: the floor, and the roof (or the meadow)
		const face = r( 38 ) < L.face, lip = ! face && r( 5 ) < L.lip;
		let yF: number, yR: number;
		if ( face ) {

			yF = lerp( - 2.4, - 1.3, r( 6 ) );
			// a cap of the toughest beds overhangs the face here and there, its height uneven
			yR = lip ? top + 1 : top - 0.35 - r( 7 ) * 0.9;

		} else if ( lip ) {

			// a block fell from the lip, leaving a bare step below the meadow's planting height
			yF = BARE_STEP - r( 6 ) * 0.9;
			yR = top + 1;

		} else {

			yF = lerp( L.floor[ 0 ], L.floor[ 1 ], r( 6 ) );
			yR = Math.min( yF + lerp( L.height[ 0 ], L.height[ 1 ], r( 7 ) ), top - 0.25 - r( 8 ) * 0.6 );

		}
		// Floors and roofs on a bed parting a third of the time: a fall's depth is often a multiple of
		// bed thickness.
		const floorKind = face ? 3 : r( 9 ) < 0.35 ? 0 : r( 9 ) < 0.65 ? 1 : 2; // bed, inclined across, seaward, below the sea
		// (a joint face under a cap: the weathered upper slope over the steep wall the sea keeps
		// cut, as on most cliffs, rather than a slab of cap rock jutting over the face)
		// (A pocket's roof opens outward, so its back sees some sky: under a level roof it was a
		// dark slot. Arches only crown the wider ones.)
		const roofKind = lip ? 3 : face ? 4 : r( 10 ) < 0.3 ? 0 : r( 10 ) < 0.7 || L.width[ 1 ] < 0.8 ? 1 : 2; // bed, inclined, arch, above the meadow, upper slope
		if ( floorKind === 0 ) {

			const y = partingAt( yF, false );
			if ( ! lip || y < BARE_STEP ) yF = y;

		}
		if ( roofKind === 0 ) yR = Math.min( partingAt( yR, true ), top - 0.25 );
		if ( ! lip && yR - yF < L.height[ 0 ] * 0.7 ) return null;
		return { yF, yR, face, lip, floorKind, roofKind };

	}

	// A pocket as proposed at its seed (its middle height and half width), or null for a joint
	// face, a step or a scar too low to fall: what the crowding rule judges.
	private pocketProposal( x: number, z: number, r: ( k: number ) => number, L: Level ): { cy: number; size: number } | null {

		const h = this.heights( x, z, r, L );
		if ( ! h || h.face || h.lip ) return null;
		const size = ( lerp( L.width[ 0 ], L.width[ 1 ], r( 12 ) ) + lerp( L.width[ 0 ], L.width[ 1 ], r( 13 ) ) ) * 0.5;
		return { cy: ( h.yF + Math.min( h.yR, this.top( x, z ) ) ) * 0.5, size };

	}

	// A scar: a block whose back is a joint of the set facing the sea most squarely (some along an
	// irregular fracture instead) and whose sides are joints of the other set. A joint face opens
	// the wall from below the sea to its cap or through the meadow; a pocket rested on a bed
	// parting or on a fracture inclined across the face, and broke away under a parting, an
	// inclined fracture or two fractures meeting in an arch (the semi-elliptic scars of a cliff).
	// A corner or two broke off along further fractures.
	private makeScar( x: number, z: number, n: [ number, number ], r: ( k: number ) => number, L: Level, level: number ): Scar | null {

		const top = this.top( x, z );
		const hts = this.heights( x, z, r, L );
		if ( ! hts ) return null;
		const { face, lip, floorKind, roofKind } = hts;
		let { yF, yR } = hts;
		const angN = Math.atan2( n[ 1 ], n[ 0 ] );
		const facing = ( a: number ) => Math.abs( wrap( a - angN ) ) > Math.PI / 2 ? a + Math.PI : a;
		const a = facing( SET_A ), b = facing( SET_B );
		const useA = Math.abs( wrap( a - angN ) ) < Math.abs( wrap( b - angN ) );
		let back = useA ? a : b;
		let side = useA ? SET_B : SET_A;
		if ( r( 1 ) < L.irregular ) {

			back = angN + ( r( 2 ) - 0.5 ) * 0.9;
			side = back + Math.PI / 2 + ( r( 3 ) - 0.5 ) * 0.9;

		} else back += ( r( 2 ) - 0.5 ) * 0.28;
		// never so oblique that the scar runs along the wall
		const alpha = Math.max( - 0.75, Math.min( 0.75, wrap( back - angN ) ) );
		back = angN + alpha;
		const fx = Math.cos( back ), fz = Math.sin( back );
		const tx = - n[ 1 ], tz = n[ 0 ];
		// the block's anchor: on the surface the larger scars left, halfway up its exposed height
		const yA = Math.max( - 0.8, Math.min( ( Math.max( yF, - 0.5 ) + Math.min( yR, top ) ) * 0.5, top - 0.3 ) );
		const t = this.surfaceAlong( x, yA, z, n[ 0 ], n[ 1 ] );
		if ( Number.isNaN( t ) ) return null;
		const px = x - n[ 0 ] * t, pz = z - n[ 1 ] * t;

		const planes: number[] = [];
		const plane = ( nx: number, ny: number, nz: number, qx: number, qy: number, qz: number ) => {

			const l = Math.hypot( nx, ny, nz );
			nx /= l; ny /= l; nz /= l;
			planes.push( nx, ny, nz, nx * qx + ny * qy + nz * qz );

		};
		// The back: a joint face leaning back (or overhanging a little). Along an oblique joint the
		// scar deepens to one side, so that side is kept short of the plateau.
		let D = lerp( L.depth[ 0 ], L.depth[ 1 ], r( 11 ) );
		const sinA = Math.sin( alpha ), cosA = Math.cos( alpha );
		let wDeep = lerp( L.width[ 0 ], L.width[ 1 ], r( 12 ) ), wShallow = lerp( L.width[ 0 ], L.width[ 1 ], r( 13 ) );
		if ( Math.abs( sinA ) > 0.05 ) wDeep = Math.min( wDeep, Math.max( 0.1, ( MAX_REACH * cosA - D ) / Math.abs( sinA ) ) );
		D = Math.min( D, MAX_REACH * cosA - wDeep * Math.abs( sinA ) );
		// A pocket is much shallower than it is wide and tall: a deep, narrow cavity reads as a
		// black hole in the shade.
		const pocket = ! face && ! lip;
		if ( pocket ) D = Math.min( D, 0.22 * Math.min( wDeep + wShallow, Math.min( yR, top ) - yF ) );
		if ( D < 0.04 || wDeep < 0.1 ) return null;
		const lean = ( r( 14 ) - 0.25 ) * 0.3;
		plane( - fx * Math.cos( lean ), - Math.sin( lean ), - fz * Math.cos( lean ), px - fx * D, yA, pz - fz * D );
		const wPlus = sinA > 0 ? wDeep : wShallow, wMinus = sinA > 0 ? wShallow : wDeep;
		// The sides: joints of the other set, each scattered and leaning on its own, so the scar
		// narrows or widens into the rock.
		for ( const sgn of [ 1, - 1 ] ) {

			let az = side + ( r( sgn > 0 ? 15 : 16 ) - 0.5 ) * 0.45;
			if ( Math.cos( az ) * tx * sgn + Math.sin( az ) * tz * sgn < 0 ) az += Math.PI;
			let gx = Math.cos( az ), gz = Math.sin( az );
			// a side nearly along the coast would leave the block open: keep it across the wall
			if ( ( gx * tx + gz * tz ) * sgn < 0.4 ) { gx = tx * sgn; gz = tz * sgn; }
			const dip = ( r( sgn > 0 ? 17 : 18 ) - 0.5 ) * ( face ? 0.9 : 0.5 );
			const w = sgn > 0 ? wPlus : wMinus;
			plane( gx * Math.cos( dip ), Math.sin( dip ), gz * Math.cos( dip ), px + tx * w * sgn, yA, pz + tz * w * sgn );

		}
		const bedNormal = ( sgn: number ) => {

			const e = 0.3;
			const sx = ( bedShift( px + e, pz ) - bedShift( px - e, pz ) ) / ( 2 * e ), sz = ( bedShift( px, pz + e ) - bedShift( px, pz - e ) ) / ( 2 * e );
			return [ sx * sgn, sgn, sz * sgn ];

		};
		// the floor
		const floor = planes.length / 4;
		const along = ( r( 19 ) < 0.5 ? - 1 : 1 ) * ( 0.15 + r( 20 ) * 0.55 ); // inclination across the face
		if ( floorKind === 0 ) {

			const [ bx, by, bz ] = bedNormal( - 1 );
			plane( bx, by, bz, px, yF, pz );

		} else if ( floorKind === 1 ) {

			const s = 0.15 + r( 21 ) * 0.35;
			plane( - fx * s - tx * along, - 1, - fz * s - tz * along, px, yF, pz );

		} else if ( floorKind === 2 ) {

			const s = 0.25 + r( 21 ) * 0.75;
			plane( - fx * s, - 1, - fz * s, px, yF, pz );

		} else {

			// (under a joint face the floor stays below the sea even where it meets the back)
			const s = 0.05 + r( 21 ) * 0.35;
			plane( - fx * s, - 1, - fz * s, px, yF, pz );

		}
		// the roof
		if ( roofKind === 3 ) plane( 0, 1, 0, px, top + 1.2, pz );
		else if ( roofKind === 4 ) {

			const g = 0.8 + r( 22 ) * 1.7, s = ( r( 23 ) - 0.5 ) * 0.8;
			plane( - fx * g + tx * s, 1, - fz * g + tz * s, px, yR, pz );

		} else if ( roofKind === 0 ) {

			const [ bx, by, bz ] = bedNormal( 1 );
			plane( bx, by, bz, px, yR, pz );

		} else if ( roofKind === 1 ) {

			const g = 0.35 + r( 22 ) * 0.9, s = ( r( 23 ) < 0.5 ? - 1 : 1 ) * ( 0.2 + r( 24 ) * 0.7 );
			plane( - fx * g + tx * s, 1, - fz * g + tz * s, px, yR, pz );

		} else {

			// an arch: two fractures meeting above the scar, its crown off to one side
			const crown = ( r( 22 ) - 0.5 ) * ( wPlus + wMinus ) * 0.5, g = 0.3 + r( 23 ) * 0.5;
			for ( const sgn of [ 1, - 1 ] ) {

				const s = 0.45 + r( sgn > 0 ? 24 : 25 ) * 1.1;
				plane( - fx * g + tx * s * sgn, 1, - fz * g + tz * s * sgn, px + tx * crown, yR, pz + tz * crown );

			}

		}
		// the front, far offshore
		plane( n[ 0 ], 0, n[ 1 ], px + n[ 0 ] * 1.7, yA, pz + n[ 1 ] * 1.7 );
		// Corners broken off along further fractures: a facet between the back and a side, the
		// floor or the roof (the block's edge there, cut back by a share of the block's size).
		const chamfers = r( 26 ) < 0.65 ? ( r( 27 ) < 0.45 ? 2 : 1 ) : 0;
		for ( let c = 0; c < chamfers; c ++ ) {

			const which = 1 + Math.floor( r( 28 + c ) * 4 ); // side +, side -, floor, roof
			const o = which * 4, wgt = 0.5 + r( 30 + c ) * 1.5;
			const nx = planes[ 0 ] + planes[ o ] * wgt, ny = planes[ 1 ] + planes[ o + 1 ] * wgt, nz = planes[ 2 ] + planes[ o + 2 ] * wgt;
			const l = Math.hypot( nx, ny, nz );
			// the edge between the back and that plane, near the seed
			const ex = px - fx * D + ( which === 1 ? tx * wPlus : which === 2 ? - tx * wMinus : 0 );
			const ez = pz - fz * D + ( which === 1 ? tz * wPlus : which === 2 ? - tz * wMinus : 0 );
			const ey = which === 3 ? Math.max( yF, - 1 ) : which === 4 ? Math.min( yR, top ) : yA;
			const size = Math.min( D, which <= 2 ? Math.min( wPlus, wMinus ) : ( Math.min( yR, top ) - Math.max( yF, - 1 ) ) * 0.4 );
			planes.push( nx / l, ny / l, nz / l, ( nx * ex + ny * ey + nz * ez ) / l - size * ( 0.25 + r( 32 + c ) * 0.45 ) );

		}

		const fresh = r( 34 ) < L.fresh ? 0.6 + r( 35 ) * 0.4 : 0;
		const scar: Scar = {
			planes: new Float64Array( planes ), n: planes.length / 4, floor, lip,
			id: r( 36 ), fresh, level, kind: face ? 'face' : lip ? 'lip' : 'pocket', key: 0,
			cx: px, cy: ( yF + Math.min( yR, top ) ) * 0.5, cz: pz, size: ( wPlus + wMinus ) * 0.5,
			round: fresh > 0 ? 0.006 + r( 37 ) * 0.01 : lerp( L.round[ 0 ], L.round[ 1 ], r( 37 ) ),
			x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0, near: { x0: 0, x1: 0, z0: 0, z1: 0 },
		};
		return bounds( scar, angN ) ? scar : null;

	}

	// A flake: a slab spalled off the face along one fracture inclined to it. It leaves a flat
	// facet that runs out to nothing at one end and ends at the other in a sharp step where the
	// slab broke across, its sides two further fractures that converge or splay, so it reads as
	// broken rock (a chip with a riser) rather than a hollow. The facet is laid on the local face
	// the larger scars left, whatever way that face looks.
	private makeFlake( x: number, z: number, n: [ number, number ], r: ( k: number ) => number, L: Level, level: number ): Scar | null {

		const top = this.top( x, z );
		const yA = lerp( L.floor[ 0 ], L.floor[ 1 ], r( 6 ) );
		if ( yA > top - 0.35 ) return null;
		const t = this.surfaceAlong( x, yA, z, n[ 0 ], n[ 1 ] );
		if ( Number.isNaN( t ) ) return null;
		const px = x - n[ 0 ] * t, pz = z - n[ 1 ] * t;
		// the local face's outward normal
		const e = 0.03;
		let mx = this.solid( px + e, yA, pz ) - this.solid( px - e, yA, pz );
		let my = this.solid( px, yA + e, pz ) - this.solid( px, yA - e, pz );
		let mz = this.solid( px, yA, pz + e ) - this.solid( px, yA, pz - e );
		const ml = Math.hypot( mx, my, mz );
		if ( ml < 1e-6 ) return null;
		mx /= ml; my /= ml; mz /= ml;
		// on a ledge or under a roof it would read as a pit
		if ( Math.abs( my ) > 0.55 || mx * n[ 0 ] + mz * n[ 1 ] < 0.2 ) return null;
		// a frame in the face: u along it, v up it
		let ux = - mz, uz = mx;
		const ul = Math.hypot( ux, uz ) || 1;
		ux /= ul; uz /= ul;
		const vx = my * uz, vy = mz * ux - mx * uz, vz = - my * ux;
		// The facet's run: toward its shallow end. The deep end, with the step, lies mostly low
		// or to one side, where the step catches light; rarely high, where it would hang over.
		let psi = r( 7 ) * Math.PI * 2;
		if ( Math.sin( psi ) < - 0.4 ) psi = Math.PI - psi;
		const ex = ux * Math.cos( psi ) + vx * Math.sin( psi ), ey = vy * Math.sin( psi ), ez = uz * Math.cos( psi ) + vz * Math.sin( psi );
		// the across direction
		const qx = my * ez - mz * ey, qy = mz * ex - mx * ez, qz = mx * ey - my * ex;
		const D = lerp( L.depth[ 0 ], L.depth[ 1 ], r( 11 ) ); // depth at the step
		const Lr = lerp( L.width[ 0 ], L.width[ 1 ], r( 12 ) ) * ( 1.2 + r( 13 ) * 0.8 ); // the run to the shallow end
		const W = lerp( L.width[ 0 ], L.width[ 1 ], r( 14 ) ); // half width across
		const k = D / Lr; // the facet's slope against the face
		const planes: number[] = [];
		const plane = ( nx: number, ny: number, nz: number, c: number ) => {

			const l = Math.hypot( nx, ny, nz );
			planes.push( nx / l, ny / l, nz / l, c / l );

		};
		const dot = ( ax: number, ay: number, az: number ) => ax * px + ay * yA + az * pz;
		// the facet: depth D at the step (s = 0 along e), nothing at s = Lr
		{

			const nx = - ( mx + k * ex ), ny = - ( my + k * ey ), nz = - ( mz + k * ez );
			plane( nx, ny, nz, dot( nx, ny, nz ) + D );

		}
		// the step, leaning a little either way
		const lean = ( r( 15 ) - 0.5 ) * 0.6;
		{

			const nx = - ex + mx * lean, ny = - ey + my * lean, nz = - ez + mz * lean;
			plane( nx, ny, nz, dot( nx, ny, nz ) );

		}
		// the sides, converging toward the shallow end or splaying from it
		for ( const sgn of [ 1, - 1 ] ) {

			const splay = ( r( sgn > 0 ? 16 : 17 ) - 0.4 ) * 0.9;
			const nx = qx * sgn + ex * splay, ny = qy * sgn + ey * splay, nz = qz * sgn + ez * splay;
			plane( nx, ny, nz, dot( nx, ny, nz ) + W * Math.hypot( nx, ny, nz ) );

		}
		// the far bounds: beyond the shallow end and off the face
		plane( ex, ey, ez, dot( ex, ey, ez ) + Lr + 0.3 );
		plane( mx, my, mz, dot( mx, my, mz ) + 0.6 );
		const fresh = r( 34 ) < L.fresh ? 0.6 + r( 35 ) * 0.4 : 0;
		const scar: Scar = {
			planes: new Float64Array( planes ), n: planes.length / 4, floor: - 1, lip: false,
			id: r( 36 ), fresh, level, kind: 'flake', key: 0,
			cx: px, cy: yA, cz: pz, size: W,
			round: fresh > 0 ? 0.005 : lerp( L.round[ 0 ], L.round[ 1 ], r( 37 ) ),
			x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0, near: { x0: 0, x1: 0, z0: 0, z1: 0 },
		};
		return bounds( scar, Math.atan2( n[ 1 ], n[ 0 ] ) ) ? scar : null;

	}

	// A gully: a slot opened along a joint of the set crossing the coast, from below the sea to
	// the meadow, its back a V where two fractures meet. Only on straight coast: at a corner it
	// would read as a cut through the plan.
	private makeGully( x: number, z: number, n: [ number, number ], r: ( k: number ) => number, wall: Field ): Scar | null {

		for ( const side of [ - 1, 1 ] ) {

			const q = gradient( wall, x - n[ 1 ] * side * 1.4, z + n[ 0 ] * side * 1.4, 0.12 );
			if ( Math.acos( Math.max( - 1, Math.min( 1, q[ 0 ] * n[ 0 ] + q[ 1 ] * n[ 1 ] ) ) ) > 0.35 ) return null;

		}
		const top = this.top( x, z );
		const t = this.surfaceAlong( x, 1.2, z, n[ 0 ], n[ 1 ] );
		if ( Number.isNaN( t ) ) return null;
		const px = x - n[ 0 ] * t, pz = z - n[ 1 ] * t;
		const angN = Math.atan2( n[ 1 ], n[ 0 ] );
		const tx = - n[ 1 ], tz = n[ 0 ];
		const planes: number[] = [];
		const plane = ( nx: number, ny: number, nz: number, qx: number, qy: number, qz: number ) => {

			const l = Math.hypot( nx, ny, nz );
			nx /= l; ny /= l; nz /= l;
			planes.push( nx, ny, nz, nx * qx + ny * qy + nz * qz );

		};
		const D = 0.65 + r( 10 ) * 0.55, half = 0.2 + r( 12 ) * 0.22;
		// the V back: two fractures meeting D behind the face
		const open = 0.55 + r( 11 ) * 0.4;
		for ( const sgn of [ 1, - 1 ] ) {

			const a = angN + Math.PI + sgn * open + ( r( 13 ) - 0.5 ) * 0.2;
			plane( Math.cos( a ), ( r( 14 ) - 0.3 ) * 0.25, Math.sin( a ), px - n[ 0 ] * D, 1.2, pz - n[ 1 ] * D );

		}
		// the walls: near-parallel joints of the set crossing the coast
		const cross = Math.abs( wrap( SET_A - ( angN + Math.PI / 2 ) ) ) < Math.abs( wrap( SET_B - ( angN + Math.PI / 2 ) ) ) ? SET_A : SET_B;
		for ( const sgn of [ 1, - 1 ] ) {

			let az = cross + ( r( sgn > 0 ? 15 : 16 ) - 0.5 ) * 0.2;
			if ( Math.cos( az ) * tx * sgn + Math.sin( az ) * tz * sgn < 0 ) az += Math.PI;
			let gx = Math.cos( az ), gz = Math.sin( az );
			if ( ( gx * tx + gz * tz ) * sgn < 0.6 ) { gx = tx * sgn; gz = tz * sgn; }
			plane( gx, ( r( sgn > 0 ? 17 : 18 ) - 0.5 ) * 0.2, gz, px + tx * half * sgn, 1.2, pz + tz * half * sgn );

		}
		const floor = planes.length / 4;
		plane( 0, - 1, 0, px, - 1.6, pz );
		plane( 0, 1, 0, px, top + 1.2, pz );
		plane( n[ 0 ], 0, n[ 1 ], px + n[ 0 ] * 1.7, 1.2, pz + n[ 1 ] * 1.7 );
		const scar: Scar = {
			planes: new Float64Array( planes ), n: planes.length / 4, floor, lip: true,
			id: r( 29 ), fresh: 0, level: GULLY.level, kind: 'gully', key: 0,
			cx: px, cy: 1.2, cz: pz, size: half, round: 0.025 + r( 30 ) * 0.025,
			x0: 0, x1: 0, y0: 0, y1: 0, z0: 0, z1: 0, near: { x0: 0, x1: 0, z0: 0, z1: 0 },
		};
		return bounds( scar, angN ) ? scar : null;

	}

	private column( x: number, z: number ): void {

		if ( x === this.cx && z === this.cz ) return;
		this.cx = x; this.cz = z;
		const d2 = this.dist( x, z );
		this.s = d2 - this.coast( x, z );
		this.topY = this.top( x, z );
		this.shift = bedShift( x, z );
		this.list.length = 0;
		this.coef.length = 0;
		this.colTop = this.topY;
		if ( this.s < - 3 || this.s > 3 ) return;
		// The wall leans back a little, by a slowly varying batter.
		this.batter = 0.03 + 0.11 * smoothstep( - 0.5, 0.6, noise3( x * 0.13 + 2.2, 5.5, z * 0.13 - 1.4 ) );
		// The lip rolls over in a convex shoulder, as a weathered crest does over the free face below
		// it: broad on some stretches, tighter on others, and uneven within a metre or so.
		const broad = smoothstep( - 0.45, 0.55, noise3( x * 0.15 - 4.1, 2.6, z * 0.15 + 3.3 ) );
		this.shoulderH = 0.75 + 0.95 * broad + 0.2 * noise3( x * 0.95 + 1.7, 8.3, z * 0.95 - 2.9 );
		this.shoulderV = 0.42 + 0.4 * broad + 0.1 * noise3( x * 1.1 - 6.2, 3.9, z * 1.1 + 0.4 );
		this.expo = exposureAt( this.dist, x, z );
		// The notch is cut deepest where the waves strike hardest; where it is shallow, a rounded
		// ramp of rock stands at the foot instead.
		// (it comes and goes over a few metres, as the rock's hardness and the swell's reach vary)
		this.notch = 0.5 * smoothstep( 0.15, 0.6, this.expo * 0.5 + noise3( x * 0.21 + 1.1, 1.7, z * 0.21 - 0.6 ) * 0.8 );
		this.notchY = 0.32 + noise3( x * 0.31 - 2.4, 0.6, z * 0.31 + 0.8 ) * 0.16;
		this.ramp = ( 1 - this.notch / 0.5 ) * 0.18;
		const list = this.grid.get( ( Math.floor( x / COLUMN_CELL ) + 512 ) * 1024 + Math.floor( z / COLUMN_CELL ) + 512 );
		if ( ! list ) return;
		for ( const i of list ) {

			const s = this.scars[ i ];
			if ( x < s.x0 || x > s.x1 || z < s.z0 || z > s.z1 ) continue;
			this.list.push( i );
			const p = s.planes;
			for ( let k = 0; k < s.n; k ++ ) this.coef.push( p[ k * 4 ] * x + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ], p[ k * 4 + 1 ] );
			// where a scar cut into the lip, its floor is the column's top
			if ( s.lip && s.floor >= 0 ) {

				const f = s.floor * 4, base = this.coef.length - s.n * 2;
				const yF = - this.coef[ base + s.floor * 2 ] / p[ f + 1 ];
				let inside = yF < this.topY;
				for ( let k = 0; k < s.n && inside; k ++ ) if ( k !== s.floor && this.coef[ base + k * 2 ] + this.coef[ base + k * 2 + 1 ] * yF > 0 ) inside = false;
				if ( inside ) this.colTop = Math.min( this.colTop, yF );

			}

		}

	}

	// The plain base face: battered, notched at the sea, its lip rolled over in the shoulder.
	private base( y: number ): number {

		const drop = this.topY - y;
		// (the lean eases off below the water, where it would carry the toe far out)
		const h = drop <= 2.8 ? drop : 2.8 + ( 1 - Math.exp( - ( drop - 2.8 ) / 1.2 ) ) * 1.2;
		let d = this.s - this.batter * h;
		// the ramp at the foot of sheltered stretches
		d -= this.ramp * smoothstep( 0.25, - 0.7, y );
		return shoulder( d, y - this.topY, this.shoulderH, this.shoulderV );

	}

	// Rounding of a scar's rim: the waves round every edge in their reach, and the crest every edge
	// in its shoulder.
	private rimRound( s: Scar, y: number ): number {

		const waves = 0.09 * smoothstep( - 1.1, - 0.3, y ) * ( 1 - smoothstep( 0.45, 1.1, y ) );
		const crest = CREST_ROUND * ( 1 - 0.6 * s.fresh ) * smoothstep( this.topY - this.shoulderV - 0.6, this.topY - 0.1, y );
		return s.round + waves + crest;

	}

	// The solid without the weathering relief: the base face with the scars cut out.
	solid( x: number, y: number, z: number, track = false ): number {

		this.column( x, z );
		const band = this.s > - 3 && this.s < 3;
		let d = band ? this.base( y ) : Math.max( this.s, y - this.topY );
		let owner = - 1, ownPlane = - 1;
		let o = 0;
		for ( let li = 0; li < this.list.length; li ++ ) {

			const s = this.scars[ this.list[ li ] ];
			const n = s.n;
			if ( y < s.y0 || y > s.y1 ) { o += n * 2; continue; }
			let db = - Infinity, arg = 0;
			for ( let k = 0; k < n; k ++ ) {

				const v = this.coef[ o + k * 2 ] + this.coef[ o + k * 2 + 1 ] * y;
				if ( v > db ) { db = v; arg = k; }

			}
			o += n * 2;
			// (the rims rounded by the polynomial smooth maximum, after Inigo Quilez's smooth minimum)
			const cut = - db, k = this.rimRound( s, y );
			if ( cut > d - k ) {

				if ( cut > d ) { owner = this.list[ li ]; ownPlane = arg; }
				d = smax( d, cut, k );

			}

		}
		if ( track ) {

			this.owner = owner;
			this.onFloor = owner >= 0 && ownPlane === this.scars[ owner ].floor;
			this.ownTop = this.colTop;

		}
		return d;

	}

	// The finished wall: the solid with the weathering relief on every face.
	at( x: number, y: number, z: number, track = false ): number {

		let d = this.solid( x, y, z, track );
		const shift = this.shift;
		const beta = bedCoordinate( y + shift );
		if ( track ) this.beta = beta;
		if ( this.s < - 3 || this.s > 3 ) return d;
		// The wave-cut notch: a sharp roof above the calm sea's crests (a roof grazing the surface
		// leaves a bright seam along the waterline), a back rounded by the swash and a sloping
		// floor the water meets. It follows every face the sea reaches, scars included.
		if ( this.notch > 0.01 ) {

			const u = ( y - this.notchY ) / ( y > this.notchY ? 0.24 : 0.55 );
			d += this.notch * Math.exp( - u * u );

		}
		const near = 1 - smoothstep( 0.15, 0.4, Math.abs( d ) );
		if ( near <= 0 ) return d;
		// (the rest fades out at the meadow, whose height must stay islandSurfaceHeight for the
		// villagers, the root soil and the rim ground that read it)
		const below = smoothstep( 0.04, 0.5, this.topY - y );
		if ( below <= 0 ) return d;
		let relief = 0;
		// Weathered partings and soft beds: a groove where a parting has opened, and the softer
		// beds set back between them, each over a few metres before it pinches out.
		if ( y > - 0.6 ) {

			const k = Math.round( beta );
			const yk = partingHeight( k ) - shift;
			const open = partingOpen( k, x, z );
			if ( open > 0 ) {

				// a V-shaped slit with sharp lips, not a rounded groove
				relief += open * 0.075 * Math.max( 0, 1 - Math.abs( y - yk ) / 0.085 );

			}
			const kb = Math.floor( beta ), soft = softBed( kb );
			if ( soft > 0 ) {

				const lo = partingHeight( kb ) - shift, hi = partingHeight( kb + 1 ) - shift;
				const inBed = smoothstep( lo - 0.01, lo + 0.04, y ) * ( 1 - smoothstep( hi - 0.04, hi + 0.01, y ) );
				relief += soft * 0.1 * inBed * partingOpen( kb + 31, x, z );

			}

		}
		// Low relief on every face, ridged, so faces break into shallow facets meeting at crests as
		// fractured stone does. It stays small: broad swells of it melted the facets into the
		// rounded lumps of dissolved limestone.
		relief += ( Math.abs( noise3( x * 0.9 + 3.8, y * 1.1, z * 0.9 ) ) - 0.22 ) * 0.022
			+ noise3( x * 2.1 - 2.3, y * 1.7 + 4.7, z * 2.1 + 6.1 ) * 0.008;
		d += relief * near * below;
		return d;

	}

	// How much rock the wall has recently shed above a point at its foot (0 .. 1): the recent
	// joint faces (tier A, so it reads only the coast near the point), each over its own width and
	// a little beyond.
	shed( x: number, z: number ): number {

		let w = 0;
		for ( const s of this.scars ) {

			if ( s.fresh <= 0 || s.level > 0 ) continue;
			const b = s.near, cx = ( b.x0 + b.x1 ) * 0.5, cz = ( b.z0 + b.z1 ) * 0.5;
			const r = Math.max( b.x1 - b.x0, b.z1 - b.z0 ) * 0.5 + 0.8;
			const d2 = ( ( x - cx ) ** 2 + ( z - cz ) ** 2 ) / ( r * r );
			if ( d2 < 1 ) w = Math.max( w, 1 - d2 );

		}
		return w;

	}

	// The wave exposure of the column last evaluated (0 .. 1): the column's own wherever it lies, so
	// a function of the point alone, as chunks need (their neighbours evaluate the same points in
	// another order). Within 3 m of the coast `column` already holds it.
	get exposure(): number {

		return this.s < - 3 || this.s > 3 ? exposureAt( this.dist, this.cx, this.cz ) : this.expo;

	}

}
