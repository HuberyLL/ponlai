import { cellsWithin, clearAround, palmSite, shoreMask } from './ground.ts';
import { BAG_CAPACITY, addItems, count, intoBag, isItem, removeItems, total } from './items.ts';
import type { Sim } from './Sim.ts';
import type { ActionResult, PalmState, SimState, Vec2, Villager } from './types.ts';

// The places an islander can go to and act at. Places are content: each kind below builds its
// places from the simulation's state and registers its own options, which `do( action )`
// (actions.ts) runs at a place the islander stands at; the simulation holds no branch per place.
// A new kind of place is one more entry in PLACE_KINDS.
//
// - shore: the island's edge band of walkable ground (ground.ts SHORE_BAND), one place all round.
//   `fish` takes FISH_SECONDS and brings a fish by chance (the seeded generator, at its end).
// - palm: a coconut palm, placed by palmSite (the ground and a fixed-seed hash; one for now). It
//   blocks its ground like a plant, holds up to PALM_COCONUTS and grows one back every
//   PALM_REGROW_SECONDS while it has fewer. `pick` takes PICK_SECONDS and brings one coconut.
// - chest: a wooden chest placed once by the player (Sim.placeChest) on open main ground with a
//   clear ring round it (CLEAR_RING, as the palm's, so it can never cut the main ground in two);
//   it blocks its footprint (CHEST_RADIUS, the model's half diagonal) and holds CHEST_CAPACITY
//   items. `put` and `take` ( { item, count } ) are instant.
//
// Standing at a place means standing on one of its cells (`reaches`): walking to it (`go`) ends on
// the nearest such cell. Reaches may overlap; a body then stands at both places, and `do` runs the
// option of the first that offers it, in PLACE_KINDS' order.
//
// Rates: a fish for about an hour of fishing (half the tries of 20 minutes catch) against the two
// an islander eats a day, and a palm's four coconuts a day against the three it drinks (needs.ts),
// so one palm and the shore keep one islander and leave a little to store.

export const FISH_SECONDS = 20 * 60;
export const FISH_CHANCE = 0.5;
export const PICK_SECONDS = 2 * 60;
export const PALM_COCONUTS = 6;
export const PALM_REGROW_SECONDS = 6 * 3600;
/** a palm's trunk blocks the ground within this radius (m) */
export const PALM_GROUND = 0.4;
/** standing within this distance (m) of the trunk is standing at the palm */
const PALM_REACH = 1.25;
/** the chest blocks a disc this wide (m, radius): its 0.9 x 0.55 m lid's half diagonal */
export const CHEST_RADIUS = 0.55;
/** standing within this distance (m) of its middle is standing at it */
const CHEST_REACH = CHEST_RADIUS + 0.9;
/** A chest holds five bags' worth: about four days of one islander's food and water (three
 * coconuts and two fish a day, needs.ts), a store against a poor day's fishing, not a granary. */
export const CHEST_CAPACITY = 20;
/** open ground the palm and the chest need round their own (m) */
const CLEAR_RING = 1.0;

/** A `do` option's arguments (put and take name an item and a count). */
export interface DoArgs { action: string; place: string; item?: unknown; count?: unknown }

/** How an option begins: refused, done at once, or running for a while and then `finish`. */
export type Start = ActionResult | { ok: true; seconds: number };

export interface PlaceOption {
	/** whether the place offers it now, from the place's own state (listed at hand) */
	open( sim: Sim ): boolean;
	start( sim: Sim, body: Villager, args: DoArgs ): Start;
	finish?( sim: Sim, body: Villager, args: DoArgs ): ActionResult;
}

export interface Place {
	id: string;
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

function shore( sim: Sim ): Place[] {

	const grid = sim.grid, mask = shoreMask( grid );
	const cells: number[] = [];
	for ( let k = 0; k < mask.length; k ++ ) if ( mask[ k ] ) cells.push( k );
	return [ {
		id: 'shore',
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

// ------------------------------------------------------------------ palms

function palmPlace( sim: Sim, palm: PalmState ): Place {

	const grid = sim.grid, p = { x: palm.x, z: palm.z };
	const reaches = ( k: number ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= PALM_REACH;
	return {
		id: palm.id,
		reaches,
		near: () => cellsWithin( grid, p, PALM_REACH ),
		distance: ( q ) => Math.hypot( q.x - p.x, q.z - p.z ),
		shows: () => ( { coconuts: palm.coconuts } ),
		options: {
			pick: {
				open: () => palm.coconuts > 0,
				start: ( _sim, body ) => {

					if ( palm.coconuts === 0 ) return { ok: false, reason: 'no coconuts on the palm' };
					if ( total( body.bag ) >= BAG_CAPACITY ) return { ok: false, reason: 'the bag is full' };
					return { ok: true, seconds: PICK_SECONDS };

				},
				finish: ( _sim, body ) => {

					if ( palm.coconuts === 0 ) return { ok: false, reason: 'no coconuts on the palm' };
					const full = intoBag( body, 'coconut' );
					if ( full ) return { ok: false, reason: full };
					palm.coconuts --;
					return { ok: true, value: 'picked a coconut' };

				},
			},
		},
	};

}

function palms( sim: Sim ): Place[] {

	return sim.state.palms.map( ( palm ) => palmPlace( sim, palm ) );

}

/** A new game's palms: one, where palmSite puts it, full of coconuts. */
export function newPalms( sim: Sim ): PalmState[] {

	const site = palmSite( sim.grid, PALM_GROUND + CLEAR_RING );
	if ( ! site ) throw new Error( 'No ground for a palm' );
	return [ { id: 'palm', x: site.x, z: site.z, coconuts: PALM_COCONUTS, growth: 0 } ];

}

/** One game second of the palms growing coconuts back. */
export function growPalms( state: SimState ): void {

	for ( const palm of state.palms ) {

		if ( palm.coconuts >= PALM_COCONUTS ) {

			palm.growth = 0;
			continue;

		}
		if ( ++ palm.growth < PALM_REGROW_SECONDS ) continue;
		palm.coconuts ++;
		palm.growth = 0;

	}

}

// ------------------------------------------------------------------ chest

/** The item and count a put or take names, or why they are not one. */
function itemCount( args: DoArgs ): { item: string; n: number } | string {

	if ( ! isItem( args.item ) ) return `there is no item called ${ String( args.item ) }`;
	const n = args.count ?? 1;
	if ( typeof n !== 'number' || ! Number.isInteger( n ) || n < 1 ) return 'the count must be a whole number from 1';
	return { item: args.item, n };

}

function chest( sim: Sim ): Place[] {

	const box = sim.state.chest;
	if ( ! box ) return [];
	const grid = sim.grid, p = { x: box.x, z: box.z };
	return [ {
		id: 'chest',
		reaches: ( k ) => k >= 0 && Math.hypot( grid.centreX( k ) - p.x, grid.centreZ( k ) - p.z ) <= CHEST_REACH,
		near: () => cellsWithin( grid, p, CHEST_REACH ),
		distance: ( q ) => Math.hypot( q.x - p.x, q.z - p.z ),
		// what is inside shows only to someone standing at it
		shows: ( at ) => at ? { items: { ...box.items } } : null,
		options: {
			put: {
				open: () => true,
				start: ( _sim, body, args ) => {

					const what = itemCount( args );
					if ( typeof what === 'string' ) return { ok: false, reason: what };
					const carried = count( body.bag, what.item );
					if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
					if ( total( box.items ) + what.n > CHEST_CAPACITY ) return { ok: false, reason: 'the chest is full' };
					removeItems( body.bag, what.item, what.n );
					addItems( box.items, what.item, what.n );
					return { ok: true, value: `put ${ what.n } ${ what.item } in the chest` };

				},
			},
			take: {
				open: () => total( box.items ) > 0,
				start: ( _sim, body, args ) => {

					const what = itemCount( args );
					if ( typeof what === 'string' ) return { ok: false, reason: what };
					const stored = count( box.items, what.item );
					if ( stored < what.n ) return { ok: false, reason: `the chest holds ${ stored } ${ what.item }` };
					if ( total( body.bag ) + what.n > BAG_CAPACITY ) return { ok: false, reason: 'the bag has no room for that' };
					removeItems( box.items, what.item, what.n );
					addItems( body.bag, what.item, what.n );
					return { ok: true, value: `took ${ what.n } ${ what.item } from the chest` };

				},
			},
		},
	} ];

}

/** Why a chest cannot go at a point, or null when it can. */
export function chestRefusal( sim: Sim, p: Vec2 ): string | null {

	if ( sim.state.chest ) return 'The chest is already placed';
	if ( ! clearAround( sim.grid, p, CHEST_RADIUS + CLEAR_RING ) ) return 'Not enough open ground there';
	const covered = cellsWithin( sim.grid, p, CHEST_RADIUS );
	if ( sim.state.villagers.some( ( v ) => covered.includes( sim.grid.indexAt( v.pos.x, v.pos.z ) ) ) ) return 'Someone stands there';
	return null;

}

// ------------------------------------------------------------------ the registry

/** every kind of place; the order is the order of preference when places stood at offer the same option */
const PLACE_KINDS: readonly PlaceKind[] = [ chest, palms, shore ];

/** The places on the island now. */
export function placesOf( sim: Sim ): Place[] {

	return PLACE_KINDS.flatMap( ( kind ) => kind( sim ) );

}

/** The places a body stands at (several where their reaches overlap: by the palm and the chest). */
export function placesAt( sim: Sim, body: Villager, places = placesOf( sim ) ): Place[] {

	const k = sim.grid.indexAt( body.pos.x, body.pos.z );
	return places.filter( ( p ) => p.reaches( k ) );

}

/** Block the ground the game's own things stand on (a loaded game's, or a new one's). */
export function obstructPlaces( sim: Sim ): void {

	for ( const palm of sim.state.palms ) sim.grid.obstruct( palm.x, palm.z, PALM_GROUND );
	const box = sim.state.chest;
	if ( box ) sim.grid.obstruct( box.x, box.z, CHEST_RADIUS );

}
