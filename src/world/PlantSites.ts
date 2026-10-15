import { anchorCell, anchorStream } from './Anchors.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { BUSH_STRIDE } from './FoliageSites.ts';
import { noise3, smoothstep } from './noise.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';

// Where the island top's shrubs and small trees grow (Plants.ts grows them). Every rule reads the
// turf anchors and fields (rim distance, noise, the walking loop kept clear), never coordinates,
// so a larger island plants itself the same way: trees stand where a broad grove field rises,
// shrubs gather in loose groups wherever a clump field rises, and both counts follow the meadow's
// area through the spacing they keep.
//
// The island grows a piece at a time (docs/game-design.md), so nothing here is decided in some
// running order over the whole island. Every draw comes from the stream of an anchor's own cell
// (Anchors.ts `anchorStream`): a tree or a group is proposed by its anchor and kept unless a
// higher-ranked proposal lies within its spacing (Matérn's second thinning on hashed priorities,
// as the rim bushes are thinned: FoliageSites.ts), so a new piece changes the plants near it and
// near where it moves the walking loop, not the whole island.
// A group's members draw from its centre's stream; groups are filled in rank order (the trees'
// own groups first), each member kept clear of the stems placed before it.
//
// Unlike the rim bushes this runs on the page, over the merged anchors of the whole land (main.ts at
// load, Growth.ts in steps for a grown island): the plants keep off the islander's walking loop
// (WalkPath.ts), which is a function of the whole land, so a chunk's worker cannot read it. The
// result is a function of the version's anchors, bushes and loop, so a grown page plants what a
// fresh load of that land plants.
//
// - Trees (2.5 - 3.5 m) stand well inside the rim (crowns overhang the cliff by no more than a
//   branch) and keep their crowns TREE_SIGHT clear of the loop, so the walker passes in the open;
//   a metre farther from the loop counts TREE_REMOTE in a tree's rank. Trees keep TREE_SPACING
//   apart. A group of smaller plants rings each trunk.
// - Shrub groups (round shrubs up to about head height, broad-leaved clumps, ferns) need the
//   clump field up and room for their lead shrub; they crowd into thickets where the field is high
//   (GROUP_SPACING shrinks) and spread out where it is low. A slow field picks each group's main
//   kind, so neighbouring groups tend to match. A shrub taller than SHRUB_SIGHT_HEIGHT stands back
//   from the loop by twice its extra height, so the walker's chest stays in view over it.
// - Shrubs stand back from the edge by their own radius (the rim bushes own the lip), clear of the
//   rim bushes and of each other's stems (crowns may overlap a little, as in a thicket).
// The puddle hollows the plants once kept out of went with the parked rain (src/sky/Weather.ts
// PARKED_WEATHER): when it returns, its hollows must give way to the plants or the plants to them.
//
// The plants, as `pickPlantSites` returns them: per plant its kind (PLANT_*), its foot on the turf
// ( x, y, z ), the ground's normal ( x, y, z ), height and radius (m: the ground it covers), its
// seed and the anchor's sky visibility before any plant shades it.
export const PLANT_STRIDE = 11;
export const PLANT_ROUND = 0, PLANT_BROADLEAF = 1, PLANT_FERN = 2, PLANT_TREE = 3;

// Trees grow 2.5 - 3.5 m tall, their leaf clusters reaching about half that from the trunk. (The
// water's reflection box, Water.ts, and the sun's caster box grow to the drawn plants' box.)
export const TREE_HEIGHT = [ 2.5, 3.5 ] as const;
const TREE_CROWN = 0.5;
// Open meadow (m) between a crown's reach and the walking loop. The loop runs about 5 m in from
// the coast (WalkPath.ts), so on the starting island little ground lies far from it: the 3.25 m
// the plants kept from the old hand-placed loop left room for one tree at most, where three stood.
// Clear of the walker's shoulders, the crowns still hide the walker from some low views: those
// views move round the island.
const TREE_SIGHT = 0.9;
// A tree's rank: the grove field, a draw of its own as large (Matérn's thinning of a smooth field
// alone keeps only its crests, a third of the trees the meadow's area asks for on a grown island)
// and TREE_REMOTE per metre from the walk.
const TREE_REMOTE = 0.1;
// Trees keep this far apart (m). With the walking loop's band left open, this gives the starting
// island (about 390 m^2 of meadow) four trees where the old island had three, and grown islands one
// per 160 - 180 m^2: as near the one per 120 m^2 the old island was planted with as the open ground
// allows without crowding the starting island.
const TREE_SPACING = 6;
// the share of anchors that propose a tree: enough that the thinning, not chance, sets the count
const TREE_PROPOSAL = 0.05;
const SHRUB_SIGHT_HEIGHT = 1;
// Shrub groups: their centres at least GROUP_SPACING (scaled by the clump field: 0.7 - 1.5 times)
// apart. The old placement accepted groups one after another at 2.8 m, which packs about twice as
// densely as thinning by rank at the same spacing (FoliageSites.ts); at 2.4 m with this share of
// proposals the starting island grows 48 shrubs (the old island, about as large, 58) and grown
// islands (seed 1, steps 6 and 12) 57 - 64 per 360 m^2 of meadow.
const GROUP_SPACING = 2.4;
// the share of anchors that propose a group where the clump field is full
const GROUP_PROPOSAL = 0.1;
const SALT_TREE = 1109, SALT_GROUP = 1117;

interface Anchor { k: number; x: number; z: number; rim: number }
interface Candidate { k: number; x: number; z: number; rank: number; i: number; j: number; spacing: number; clump: number }
interface Group { x: number; z: number; k: number; r: number; size: number; members: number; lead: boolean; rng: () => number }

const key = ( gi: number, gj: number ) => ( gi + 32768 ) * 65536 + gj + 32768;

// Items by square cell of `size` m, for neighbour queries.
class Grid<T extends { x: number; z: number }> {

	readonly cells = new Map<number, T[]>();
	constructor( readonly size: number ) {}
	add( item: T ): void {

		const k = key( Math.floor( item.x / this.size ), Math.floor( item.z / this.size ) );
		let cell = this.cells.get( k );
		if ( ! cell ) this.cells.set( k, cell = [] );
		cell.push( item );

	}
	/** whether any item within `r` (at most `size`) of ( x, z ) passes `test` */
	some( x: number, z: number, test: ( item: T ) => boolean ): boolean {

		const gi = Math.floor( x / this.size ), gj = Math.floor( z / this.size );
		for ( let dj = - 1; dj <= 1; dj ++ ) for ( let di = - 1; di <= 1; di ++ ) {

			for ( const item of this.cells.get( key( gi + di, gj + dj ) ) ?? [] ) if ( test( item ) ) return true;

		}
		return false;

	}

}

// whether a outranks b (ties, which a 32-bit draw makes rare, by anchor cell)
const outranks = ( a: Candidate, b: Candidate ) => a.rank > b.rank || a.rank === b.rank && ( a.j < b.j || a.j === b.j && a.i < b.i );

// Keeps the candidates no higher-ranked one lies within its own spacing of, in rank order.
function* thin( candidates: Candidate[], reach: number ): Generator<void, Candidate[]> {

	const grid = new Grid<Candidate>( reach );
	for ( const c of candidates ) grid.add( c );
	const kept: Candidate[] = [];
	for ( let n = 0; n < candidates.length; n ++ ) {

		if ( n % 64 === 63 ) yield;
		const c = candidates[ n ];
		if ( ! grid.some( c.x, c.z, ( o ) => o !== c && outranks( o, c ) && Math.hypot( o.x - c.x, o.z - c.z ) < c.spacing ) ) kept.push( c );

	}
	return kept.sort( ( a, b ) => outranks( a, b ) ? - 1 : outranks( b, a ) ? 1 : 0 );

}

/** The shrubs and small trees on the island top, in steps (a generator, so the growth plants a
 * grown island in idle time: Growth.ts): PLANT_STRIDE floats per plant. `anchors` are the merged
 * turf anchors (WorldData.vegetation), `bushes` the rim bushes (WorldData.bushes), `clearance` the
 * distance to ground that must stay open (the islander's walk, WalkPath.ts walkLoopDistance). The
 * result is the same however it is stepped. */
export function* plantSiteSteps( anchors: Float32Array, bushes: Float32Array, clearance: ( x: number, z: number ) => number ): Generator<void, Float32Array> {

	// the meadow's anchors, by 1 m cell, for the members' nearest anchor
	const meadow = new Grid<Anchor>( 1 );
	const trees: Candidate[] = [], groups: Candidate[] = [];
	const clump = ( x: number, z: number ) => noise3( x * 0.19 + 5.3, 1.7, z * 0.19 ) * 0.5 + 0.5;
	const grove = ( x: number, z: number ) => noise3( x * 0.085 + 31.7, 2.9, z * 0.085 );
	const rimBushes = new Grid<{ x: number; z: number; r: number }>( 2.5 );
	for ( let k = 0; k < bushes.length; k += BUSH_STRIDE ) rimBushes.add( { x: bushes[ k ], z: bushes[ k + 2 ], r: bushes[ k + 3 ] } );
	// clear of the rim bushes (a footprint of radius r at x, z)
	const offBushes = ( x: number, z: number, r: number ) => ! rimBushes.some( x, z, ( b ) => Math.hypot( b.x - x, b.z - z ) < ( b.r + r ) * 0.65 );
	let count = 0;
	for ( let k = 0; k < anchors.length; k += STRIDE ) {

		if ( ++ count % 128 === 0 ) yield;
		const x = anchors[ k ], z = anchors[ k + 2 ], rim = anchors[ k + 6 ];
		if ( anchors[ k + 7 ] > 0 || ! supportsMeadow( anchors[ k + 1 ], anchors[ k + 4 ] ) ) continue;
		meadow.add( { k, x, z, rim } );
		const [ i, j ] = anchorCell( x, z );
		// a tree, well inside the rim, its crown clear of the walk
		const t = anchorStream( x, z, SALT_TREE );
		if ( rim < - 1.8 && t() < TREE_PROPOSAL ) {

			const open = clearance( x, z );
			if ( open >= TREE_HEIGHT[ 1 ] * TREE_CROWN + TREE_SIGHT && offBushes( x, z, 0.5 ) ) {

				trees.push( { k, x, z, i, j, spacing: TREE_SPACING, clump: 0, rank: grove( x, z ) * 0.5 + t() + TREE_REMOTE * open } );

			}

		}
		// a group's heart, where the clump field rises
		const c = clump( x, z );
		const g = anchorStream( x, z, SALT_GROUP );
		if ( rim < - 0.8 && g() < GROUP_PROPOSAL * smoothstep( 0.4, 0.68, c ) ) {

			// groups crowd into thickets where the field is high and spread out where it is low
			groups.push( { k, x, z, i, j, spacing: GROUP_SPACING * ( 1.5 - 0.8 * smoothstep( 0.45, 0.75, c ) ), clump: c, rank: g() } );

		}

	}
	yield;
	const keptTrees = yield* thin( trees, TREE_SPACING );
	yield;
	// a group's heart stays a spacing from any tree's (a tree has its own group) and has room for
	// its lead shrub: off the path, clear of the rim bushes and the trunks
	const treeGrid = new Grid<Candidate>( GROUP_SPACING * 1.5 );
	for ( const t of keptTrees ) treeGrid.add( t );
	const hearts: Candidate[] = [];
	for ( let n = 0; n < groups.length; n ++ ) {

		if ( n % 16 === 15 ) yield;
		const g = groups[ n ];
		if ( treeGrid.some( g.x, g.z, ( t ) => Math.hypot( t.x - g.x, t.z - g.z ) < Math.max( g.spacing, 0.45 + 0.6 * 0.6 ) ) ) continue;
		if ( clearance( g.x, g.z ) <= 1.2 || ! offBushes( g.x, g.z, 0.6 ) ) continue;
		hearts.push( g );

	}
	yield;
	const keptGroups = yield* thin( hearts, GROUP_SPACING * 1.5 );
	yield;

	const out: number[] = [];
	// the stems planted so far (x, z, radius, tree)
	const stems = new Grid<{ x: number; z: number; r: number; tree: boolean }>( 2.5 );
	const site = ( kind: number, k: number, height: number, radius: number, seed: number ) => {

		out.push( kind, anchors[ k ], anchors[ k + 1 ], anchors[ k + 2 ], anchors[ k + 3 ], anchors[ k + 4 ], anchors[ k + 5 ], height, radius, seed, anchors[ k + 8 ] );
		stems.add( { x: anchors[ k ], z: anchors[ k + 2 ], r: radius, tree: kind === PLANT_TREE } );

	};
	// Room for a plant of this footprint: off the path, clear of the rim bushes and of the stems
	// already planted.
	const free = ( x: number, z: number, r: number, path: number ) => clearance( x, z ) > r + path && offBushes( x, z, r )
		&& ! stems.some( x, z, ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.tree ? 0.45 + r * 0.6 : ( s.r + r ) * 0.62 ) );

	// the trees, in rank order, each with its group of smaller plants ringing the trunk (no lead)
	const all: Group[] = [];
	for ( const t of keptTrees ) {

		const rng = anchorStream( t.x, t.z, SALT_TREE + 1 );
		const height = TREE_HEIGHT[ 0 ] + rng() * ( TREE_HEIGHT[ 1 ] - TREE_HEIGHT[ 0 ] );
		site( PLANT_TREE, t.k, height, 1.2, Math.floor( rng() * 0x1000000 ) );
		all.push( { x: t.x, z: t.z, k: t.k, r: 1.7, size: 0.75, members: 3 + Math.floor( rng() * 3 ), lead: false, rng } );

	}
	for ( const g of keptGroups ) {

		const rng = anchorStream( g.x, g.z, SALT_GROUP + 1 );
		all.push( { x: g.x, z: g.z, k: g.k, r: 1 + rng(), size: 0.8 + 0.4 * g.clump, members: 4 + Math.floor( rng() * 5 ), lead: true, rng } );

	}
	// a slow field picks each group's main kind, so neighbouring groups tend to match
	const kindField = ( x: number, z: number ) => noise3( x * 0.07 + 13.1, 6.2, z * 0.07 ) * 0.5 + 0.5;
	const kinds = [ PLANT_ROUND, PLANT_BROADLEAF, PLANT_FERN ];
	for ( const g of all ) {

		yield;
		const rng = g.rng;
		const f = kindField( g.x, g.z );
		const main = f < 0.53 ? PLANT_ROUND : f < 0.62 ? PLANT_BROADLEAF : PLANT_FERN;
		for ( let m = 0, tries = 0; m < g.members && tries < g.members * 8; tries ++ ) {

			if ( tries % 8 === 7 ) yield;
			// the lead plant stands at the group's heart, the rest scatter around it
			const lead = g.lead && m === 0;
			const d = lead ? rng() * 0.25 : g.r * Math.sqrt( 0.15 + 0.85 * rng() );
			const angle = rng() * Math.PI * 2;
			const px = g.x + Math.cos( angle ) * d, pz = g.z + Math.sin( angle ) * d;
			// the nearest meadow anchor
			let a: Anchor | null = null, best = 0.235 * 1.5;
			meadow.some( px, pz, ( q ) => {

				const dq = Math.hypot( q.x - px, q.z - pz );
				if ( dq <= best ) { best = dq; a = q; }
				return false;

			} );
			const kind = lead ? PLANT_ROUND : rng() < 0.6 ? main : kinds[ Math.floor( rng() * 3 ) ];
			// the largest plants of a group near its middle, the lead shrub up to head height
			const centre = 1 - 0.3 * Math.min( 1, d / g.r );
			const v = rng();
			const height = ( kind === PLANT_ROUND ? ( lead ? 1.15 + v * 0.65 : 0.55 + Math.pow( v, 1.4 ) * 0.9 )
				: kind === PLANT_BROADLEAF ? 0.42 + v * 0.48 : 0.5 + v * 0.5 ) * g.size * centre;
			const radius = kind === PLANT_ROUND ? 0.28 + height * 0.4 : kind === PLANT_BROADLEAF ? 0.25 + height * 0.7 : 0.2 + height * 0.6;
			const seed = Math.floor( rng() * 0x1000000 );
			if ( ! a ) continue;
			const at = a as Anchor;
			if ( at.rim > - 0.35 - radius * 0.6 ) continue;
			if ( ! free( at.x, at.z, radius, 0.45 + 2 * Math.max( 0, height - SHRUB_SIGHT_HEIGHT ) ) ) continue;
			site( kind, at.k, Math.max( 0.35, height ), radius, seed );
			m ++;

		}

	}
	return new Float32Array( out );

}

/** `plantSiteSteps` run to the end. */
export function pickPlantSites( anchors: Float32Array, bushes: Float32Array, clearance: ( x: number, z: number ) => number ): Float32Array {

	const steps = plantSiteSteps( anchors, bushes, clearance );
	let next = steps.next();
	while ( ! next.done ) next = steps.next();
	return next.value;

}

/** Contact shade round the plants on the turf anchors' sky visibility (offset 8), which the grass
 * reads as it is planted: 1 in the open, darker toward a stem. Indirect light
 * only; the plants' own sun shadows cover the direct. Under a shrub little sky gets through, a
 * tree's lifted crown leaves more of it. Call it after the plants are sited (they keep their
 * anchor's open-sky value) and before the meadow is planted; in steps, as `plantSiteSteps`.
 * The turf under the plants keeps its own occlusion (the old planting baked this shade into the
 * island mesh too): the island's meshes are the chunk workers' output, cached and swapped per
 * chunk where the land changed, and a bake on the page would tie an unchanged chunk's mesh to the
 * plants, and through them to the walking loop, so a grow would re-upload chunks it did not
 * change. The grass that covers most of that turf carries the shade. */
export function* anchorContactSteps( anchors: Float32Array, sites: Float32Array ): Generator<void, void> {

	const reach = ( k: number ) => sites[ k ] === PLANT_TREE ? 1.6 : sites[ k + 8 ] * 1.25 + 0.15;
	const grid = new Map<number, number[]>();
	const CELL = 2;
	for ( let k = 0; k < sites.length; k += PLANT_STRIDE ) {

		const x = sites[ k + 1 ], z = sites[ k + 3 ], r = reach( k );
		for ( let gj = Math.floor( ( z - r ) / CELL ); gj <= Math.floor( ( z + r ) / CELL ); gj ++ ) for ( let gi = Math.floor( ( x - r ) / CELL ); gi <= Math.floor( ( x + r ) / CELL ); gi ++ ) {

			const g = key( gi, gj );
			let list = grid.get( g );
			if ( ! list ) grid.set( g, list = [] );
			list.push( k );

		}

	}
	let count = 0;
	for ( let a = 0; a < anchors.length; a += STRIDE ) {

		if ( ++ count % 512 === 0 ) yield;
		const x = anchors[ a ], z = anchors[ a + 2 ];
		const list = grid.get( key( Math.floor( x / CELL ), Math.floor( z / CELL ) ) );
		if ( ! list ) continue;
		let v = 1;
		for ( const k of list ) {

			const r = reach( k ), d = Math.hypot( x - sites[ k + 1 ], z - sites[ k + 3 ] );
			if ( d >= r ) continue;
			const depth = sites[ k ] === PLANT_TREE ? 0.4 : 0.62 * Math.min( 1, 0.55 + sites[ k + 7 ] * 0.4 );
			v *= 1 - depth * ( 1 - smoothstep( 0.2, 1, d / r ) );

		}
		anchors[ a + 8 ] *= v;

	}

}

/** `anchorContactSteps` run to the end. */
export function bakeAnchorContact( anchors: Float32Array, sites: Float32Array ): void {

	const steps = anchorContactSteps( anchors, sites );
	while ( ! steps.next().done );

}
