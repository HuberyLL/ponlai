import { buildings, obstructBuildings } from './buildings.ts';
import { shoreMask } from './ground.ts';
import { BAG_CAPACITY, intoBag, total } from './items.ts';
import type { Grid } from './grid.ts';
import type { Sim } from './Sim.ts';
import type { ActionResult, Vec2, Villager } from './types.ts';

// The places an islander can go to and act at. Places are content: each kind below builds its
// places from the simulation's state and registers its own options, which `do( action )`
// (actions.ts) runs at a place the islander stands at; the simulation holds no branch per place.
// A new kind of place is one more entry in PLACE_KINDS.
//
// - shore: the island's edge band of walkable ground (ground.ts SHORE_BAND), one place all round.
//   `fish` takes FISH_SECONDS and brings a fish by chance (the seeded generator, at its end).
// - buildings: what the player places (buildings.ts: chests), each a place by its id (chest1).
//
// Every place has an id, which the brain names it by, and a kind (shore, chest), which
// perception shows beside the id so that several of a kind read as such.
//
// Standing at a place means standing on one of its cells (`reaches`): walking to it (`go`) ends on
// the nearest such cell. Reaches may overlap; a body then stands at both places, and `do` runs the
// option of the first that offers it, in PLACE_KINDS' order.
//
// Rates: a fish for about an hour of fishing (half the tries of 20 minutes catch) against the two
// an islander eats a day (needs.ts), so the shore keeps one islander and leaves a little to store.
// Nothing gives water yet: thirst is off until the island has a water source of its own (needs.ts).

export const FISH_SECONDS = 20 * 60;
export const FISH_CHANCE = 0.5;

/** A `do` option's arguments (put and take name an item and a count). */
export interface DoArgs { action: string; place: string; item?: unknown; count?: unknown }

/** How an option begins: refused, done at once, or running for a while and then `finish`. */
export type Start = ActionResult | { ok: true; seconds: number };

export interface PlaceOption {
	/** whether the place offers it now, from the place's own state (listed at hand) */
	open( sim: Sim ): boolean;
	start( sim: Sim, body: Villager, args: DoArgs ): Start;
	/** each tick a timed option runs (its first one after it began): a result ends it there, early */
	during?( sim: Sim, body: Villager, args: DoArgs ): ActionResult | null;
	/** when a timed option's seconds are up */
	finish?( sim: Sim, body: Villager, args: DoArgs ): ActionResult;
}

export interface Place {
	id: string;
	/** what kind of place it is: 'shore' or a building's kind */
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

type PlaceKind = ( sim: Sim ) => Place[];

// ------------------------------------------------------------------ shore

// per grid: the shore's cells (the places are built anew each time they are looked up, every tick
// of a timed `do`)
const shoreCells = new WeakMap<Grid, number[]>();

function shore( sim: Sim ): Place[] {

	const grid = sim.grid, mask = shoreMask( grid );
	let cells = shoreCells.get( grid );
	if ( ! cells ) {

		cells = [];
		for ( let k = 0; k < mask.length; k ++ ) if ( mask[ k ] ) cells.push( k );
		shoreCells.set( grid, cells );

	}
	return [ {
		id: 'shore',
		kind: 'shore',
		reaches: ( k ) => k >= 0 && mask[ k ] === 1,
		near: () => cells,
		distance: ( p ) => {

			let d = Infinity;
			for ( const k of cells ) if ( grid.open[ k ] ) d = Math.min( d, Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) );
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
	} ];

}

// ------------------------------------------------------------------ the registry

/** every kind of place; the order is the order of preference when places stood at offer the same option */
const PLACE_KINDS: readonly PlaceKind[] = [ buildings, shore ];

/** The places on the island now. */
export function placesOf( sim: Sim ): Place[] {

	return PLACE_KINDS.flatMap( ( kind ) => kind( sim ) );

}

/** The places a body stands at (several where their reaches overlap: a chest by the shore). */
export function placesAt( sim: Sim, body: Villager, places = placesOf( sim ) ): Place[] {

	const k = sim.grid.indexAt( body.pos.x, body.pos.z );
	return places.filter( ( p ) => p.reaches( k ) );

}

/** Block the ground the game's own things stand on (a loaded game's, or a new one's). */
export function obstructPlaces( sim: Sim ): void {

	obstructBuildings( sim );

}
