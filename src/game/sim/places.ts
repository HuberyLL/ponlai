import { buildingById, buildings, obstructBuildings } from './buildings.ts';
import { shoreMask } from './ground.ts';
import { BAG_CAPACITY, intoBag, total } from './items.ts';
import { people, personById } from './people.ts';
import type { Sim } from './Sim.ts';
import { planar } from './maths.ts';
import type { ActionResult, Vec2, Villager } from './types.ts';

// The places an islander can go to and act at. Places are content: each kind below builds its
// places from the simulation's state and registers its own options, which `do( action )`
// (actions.ts) runs at a place the islander stands at; the simulation holds no branch per place.
// A new kind of place is one more entry in PLACE_KINDS: its places, and the one with an id.
//
// - shore: the island's edge band of walkable ground (ground.ts SHORE_BAND), one place all round.
//   `fish` takes FISH_SECONDS and brings a fish by chance (the seeded generator, at its end).
// - buildings: what the player places (buildings.ts: chests), each a place by its id (chest1).
// - people: every living islander, a place that moves (people.ts: give, follow), by its id (v2).
//
// Every place has an id, which the brain names it by, and a kind (shore, chest, person), which
// perception shows beside the id so that several of a kind read as such.
//
// Standing at a place means standing on one of its cells (`reaches`): walking to it (`go`) ends on
// the nearest such cell. A timed option goes on only while its condition holds (`holds`: by default
// while the body stands at the place), checked every tick before its `during` (actions.ts); the
// option's own rules need not check it again. Items move between bags in an option's `start` (an
// instant option) or `finish`, never in its `during`, so an outcome can say what moved. Reaches may overlap; a body then stands at both places, and `do` runs the
// option of the place it names, else of the first that offers it, in PLACE_KINDS' order. A body is
// never a place to itself: it neither stands at nor sees its own person (`placesFor`).
//
// Rates: a fish for about an hour of fishing (half the tries of 20 minutes catch) against the two
// an islander eats a day (needs.ts), so the shore keeps one islander and leaves a little to store.
// Nothing gives water yet: thirst is off until the island has a water source of its own (needs.ts).

export const FISH_SECONDS = 20 * 60;
export const FISH_CHANCE = 0.5;

/** A `do` option's arguments, checked at the entrance (put, take and give name an item and a
 * count), with the place it runs at. */
export interface DoArgs { action: string; place: string; item?: string; count?: number }

/** How an option begins: refused, done at once, or running for a while and then `finish`
 * (seconds null: until a new action replaces it, or its `during` ends it: `follow`). */
export type Start = ActionResult | { ok: true; seconds: number | null };

export interface PlaceOption {
	/** whether the place offers it now, from the place's own state (listed at hand) */
	open( sim: Sim ): boolean;
	start( sim: Sim, body: Villager, args: DoArgs ): Start;
	/** whether a timed option can go on, each tick before its `during`: null, or why not (it then
	 * ends interrupted). Without it, while the body stands at the place. */
	holds?( sim: Sim, body: Villager, args: DoArgs ): string | null;
	/** each tick a timed option runs (its first one after it began), once its condition held: a
	 * result ends it there, early */
	during?( sim: Sim, body: Villager, args: DoArgs ): ActionResult | null;
	/** when a timed option's seconds are up */
	finish?( sim: Sim, body: Villager, args: DoArgs ): ActionResult;
}

export interface Place {
	id: string;
	/** what kind of place it is: 'shore', a building's kind or 'person' */
	kind: string;
	/** whether standing on cell k is standing at the place */
	reaches( k: number ): boolean;
	/** the cells near it to test with `reaches` (all of them for the shore) */
	near(): number[];
	/** metres from a point to the place, for sight */
	distance( p: Vec2 ): number;
	/** what shows on it to someone who sees it, and to someone standing at it */
	shows( at: boolean ): Record<string, unknown> | null;
	options: Record<string, PlaceOption>;
}

interface PlaceKind {
	/** every place of the kind */
	all( sim: Sim ): Place[];
	/** the place of the kind with an id, or null: builds only that one */
	byId( sim: Sim, id: string ): Place | null;
}

// ------------------------------------------------------------------ shore

// per shore mask (ground.ts shoreMask: one per island top, so a grown island has its own): the
// shore's cells (the places are built anew each time they are looked up, every tick of a `go` or a
// timed `do`)
const shoreCells = new WeakMap<Uint8Array, number[]>();

function shore( sim: Sim ): Place {

	const grid = sim.grid, mask = shoreMask( grid );
	let cells = shoreCells.get( mask );
	if ( ! cells ) {

		cells = [];
		for ( let k = 0; k < mask.length; k ++ ) if ( mask[ k ] ) cells.push( k );
		shoreCells.set( mask, cells );

	}
	return {
		id: 'shore',
		kind: 'shore',
		reaches: ( k ) => k >= 0 && mask[ k ] === 1,
		near: () => cells,
		distance: ( p ) => {

			let d = Infinity;
			for ( const k of cells ) if ( grid.open[ k ] ) d = Math.min( d, planar( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) );
			return d;

		},
		shows: () => null,
		options: {
			fish: {
				open: () => true,
				start: ( _sim, body ) => total( body.bag ) >= BAG_CAPACITY ? { ok: false, reason: 'the bag is full' } : { ok: true, seconds: FISH_SECONDS },
				finish: ( s, body ) => {

					if ( s.random() >= FISH_CHANCE ) return { ok: true, value: 'caught nothing' };
					const full = intoBag( body, 'fish' );
					return full ? { ok: false, reason: full } : { ok: true, value: 'caught a fish' };

				},
			},
		},
	};

}

// ------------------------------------------------------------------ the registry

/** every kind of place; the order is the order of preference when places stood at offer the same option */
const PLACE_KINDS: readonly PlaceKind[] = [
	{ all: buildings, byId: buildingById },
	{ all: people, byId: personById },
	{ all: ( sim ) => [ shore( sim ) ], byId: ( sim, id ) => id === 'shore' ? shore( sim ) : null },
];

/** The places on the island now, every islander's person among them. */
export function placesOf( sim: Sim ): Place[] {

	return PLACE_KINDS.flatMap( ( kind ) => kind.all( sim ) );

}

/** The places there are for a body: all but its own person. */
export function placesFor( sim: Sim, body: Villager ): Place[] {

	return placesOf( sim ).filter( ( p ) => p.id !== body.id );

}

/** The place with an id there is for a body (never its own person), or null; builds only that one,
 * for what looks a place up every tick (a `go`, a timed `do`). */
export function placeById( sim: Sim, body: Villager, id: unknown ): Place | null {

	if ( typeof id !== 'string' || id === body.id ) return null;
	for ( const kind of PLACE_KINDS ) {

		const place = kind.byId( sim, id );
		if ( place ) return place;

	}
	return null;

}

/** The places a body stands at (several where their reaches overlap: a chest by the shore, someone
 * beside it), never its own person. */
export function placesAt( sim: Sim, body: Villager, places = placesFor( sim, body ) ): Place[] {

	const k = sim.grid.indexAt( body.pos.x, body.pos.z );
	return places.filter( ( p ) => p.id !== body.id && p.reaches( k ) );

}

/** Block the ground the game's own things stand on (a loaded game's, or a new one's). */
export function obstructPlaces( sim: Sim ): void {

	obstructBuildings( sim );

}
