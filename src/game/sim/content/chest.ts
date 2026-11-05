import { storeOf } from '../buildings.ts';
import { bagOf, count, itemCount, room, total, transfer } from '../items.ts';
import { register } from '../registry.ts';
import type { BuildingState } from '../types.ts';

// The chest: a wooden chest the player places, that holds CHEST_CAPACITY items once built. `put`
// and `take` ( { item, count } ) are instant; what is inside shows only to someone standing at it
// (buildings.ts, a store's look).
//
// CHEST_WORK is about a game hour: a few planks and a lid knocked together by one person, which at
// the game's day (24 real minutes at 1x) is a minute to watch the site rise, and costs the islander
// about 3 of satiety (food.ts), so building it never crowds out eating. A chest holds five bags'
// worth: ten days of one islander's fish (two a day), a store against a poor day's fishing, not a
// granary.

/** the chest blocks a disc this wide (m, radius): its 0.9 x 0.55 m lid's half diagonal */
export const CHEST_RADIUS = 0.55;
export const CHEST_CAPACITY = 20;
/** the chest's work (game seconds): see the header */
export const CHEST_WORK = 3600;

register( {
	buildings: [ { id: 'chest', radius: CHEST_RADIUS, work: CHEST_WORK, capacity: CHEST_CAPACITY } ],
	options: [
		{ id: 'put', at: 'chest', make: ( box: BuildingState ) => ( {
			open: () => true,
			start: ( sim, body, args ) => {

				const what = itemCount( args );
				if ( typeof what === 'string' ) return { ok: false, reason: what };
				const bag = bagOf( body ), store = storeOf( box );
				const carried = count( bag.items, what.item );
				if ( carried < what.n ) return { ok: false, reason: `the bag holds ${ carried } ${ what.item }` };
				if ( room( store ) < what.n ) return { ok: false, reason: 'the chest is full' };
				transfer( sim, bag, store, what.item, what.n );
				return { ok: true, value: `put ${ what.n } ${ what.item } in the chest` };

			},
		} ) },
		{ id: 'take', at: 'chest', make: ( box: BuildingState ) => ( {
			open: () => total( box.items ) > 0,
			start: ( sim, body, args ) => {

				const what = itemCount( args );
				if ( typeof what === 'string' ) return { ok: false, reason: what };
				const bag = bagOf( body ), store = storeOf( box );
				const stored = count( store.items, what.item );
				if ( stored < what.n ) return { ok: false, reason: `the chest holds ${ stored } ${ what.item }` };
				if ( room( bag ) < what.n ) return { ok: false, reason: 'the bag has no room for that' };
				transfer( sim, store, bag, what.item, what.n );
				return { ok: true, value: `took ${ what.n } ${ what.item } from the chest` };

			},
		} ) },
	],
} );
