import { buildingById, buildings, obstructBuildings } from './buildings.ts';
import { people, personById } from './people.ts';
import { placeKinds } from './registry.ts';
import type { PlaceKindDef } from './registry.ts';
import type { Sim } from './Sim.ts';
import type { ActionResult, Vec2, Villager } from './types.ts';

// The places an islander can go to and act at, of a few kinds: the buildings (buildings.ts, each a
// place by its id: chest1), the people (people.ts: every living islander, a place that moves, by
// its id: v2), then the kinds content registers (registry.ts PlaceKindDef: the shore, content/).
// What a place offers is its options (registry.ts OptionDef, registered at its kind), which
// `do( action )` (actions.ts) runs at a place the islander stands at; the simulation holds no
// branch per place or option, so a new kind of place, or a new option at one, is a definition.
//
// Every place has an id, which the brain names it by, and a kind (shore, chest, person), which
// perception shows beside the id so that several of a kind read as such.
//
// Standing at a place means standing on one of its cells (`reaches`): walking to it (`go`) ends on
// the nearest such cell, and for a place that moves (`moves`) finds its way again whenever the way
// no longer ends at it. A timed option goes on only while its condition holds (`holds`: by default
// while the body stands at the place), checked every tick before its `during` (actions.ts); the
// option's own rules need not check it again. Items move between holders in an option's `start`
// (an instant option) or `finish`, never in its `during`, so an outcome can say what moved
// (items.ts). Reaches may overlap; a body then stands at both places, and `do` runs the option of
// the place it names, else of the first that offers it, in the kinds' order here. A body is never
// a place to itself: it neither stands at nor sees its own person (`placesFor`).

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
	/** what kind of place it is: a building's kind, 'person' or a registered kind's id */
	kind: string;
	/** a place that moves (a person): walking to it finds its way again whenever the way's end is
	 * farther from it than this (m) */
	moves?: number;
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

// the core's kinds, first in the order of preference: the buildings, then the people
const CORE_KINDS: readonly Pick<PlaceKindDef, 'all' | 'byId'>[] = [
	{ all: buildings, byId: buildingById },
	{ all: people, byId: personById },
];

/** Every kind of place: the core's, then the registered ones in their order. */
function kinds(): readonly Pick<PlaceKindDef, 'all' | 'byId'>[] {

	return [ ...CORE_KINDS, ...placeKinds() ];

}

/** The places on the island now, every islander's person among them. */
export function placesOf( sim: Sim ): Place[] {

	return kinds().flatMap( ( kind ) => kind.all( sim ) );

}

/** The places there are for a body: all but its own person. */
export function placesFor( sim: Sim, body: Villager ): Place[] {

	return placesOf( sim ).filter( ( p ) => p.id !== body.id );

}

/** The place with an id there is for a body (never its own person), or null; builds only that one,
 * for what looks a place up every tick (a `go`, a timed `do`). */
export function placeById( sim: Sim, body: Villager, id: unknown ): Place | null {

	if ( typeof id !== 'string' || id === body.id ) return null;
	// (no list made: a `go` or a timed `do` looks its place up every tick)
	for ( const kind of CORE_KINDS ) {

		const place = kind.byId( sim, id );
		if ( place ) return place;

	}
	for ( const kind of placeKinds() ) {

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
