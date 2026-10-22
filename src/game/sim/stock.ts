import { count } from './items.ts';
import type { Items, SimState } from './types.ts';

// What the island holds: the items in its buildings' stores (a chest's contents), counted by kind.
// What an islander carries is their own, not the island's (docs/ui.md, Resources: the top row counts
// the chests and stores, not the bags). A cost is met when the stock holds every kind it names.

/** The island's stock: every building's store, summed by item kind. */
export function stockOf( state: SimState ): Items {

	const stock: Items = {};
	for ( const b of state.buildings ) for ( const kind in b.items ) stock[ kind ] = count( stock, kind ) + b.items[ kind ];
	return stock;

}

/** What a cost lacks against a stock: each kind it needs more of, and how many more; empty when met. */
export function shortfall( cost: Items, stock: Items ): Items {

	const short: Items = {};
	for ( const kind in cost ) {

		const lack = cost[ kind ] - count( stock, kind );
		if ( lack > 0 ) short[ kind ] = lack;

	}
	return short;

}
