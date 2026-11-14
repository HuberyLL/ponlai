import { itemKind } from './registry.ts';
import type { Sim } from './Sim.ts';
import type { EntityId, Items, Villager } from './types.ts';

// The items system: what holds items (bags, stores) and every change to what they hold.
//
// The items system: what holds items (an islander's bag, a building's store) and every change to
// what they hold. The kinds of item and their uses are content (registry.ts ItemDef; today's in
// content/), which `use( item )` (actions.ts) runs, so a new item is a definition, never a new
// action. Using is instant and spends the item.
//
// Rules: a bag holds a few items in all (BAG_CAPACITY), a store what its kind says
// (buildings.ts `storeOf`); items of a kind stack. A collection is an item-to-count record that
// holds a kind only while its count is above zero, so its JSON says exactly what is there. What a
// holder holds changes only here, by `transfer`, `bring` and `spend`, whose callers check first
// that the items are there and that there is room, and say why not in their own words. So this
// system can tell what moved between bags: while a step is watched (`watchMoves`, an instant
// action or a timed one's finish: actions.ts) each change to a bag is kept, and `takeMoves` hands
// the step's outcome what moved, by islander in the roll's order, never by comparing the bags.
// Watched steps never nest: a rule acts only for the islander whose step it is, never through
// another's action (a nested watch would start the ledger afresh).

/** items a bag holds in all */
export const BAG_CAPACITY = 4;

/** What holds items: a bag (whose it is: `owner`) or a building's store, with the room it has in
 * all. */
export interface Holder {
	readonly items: Items;
	readonly capacity: number;
	readonly owner?: EntityId;
}

/** An islander's bag as a holder. */
export function bagOf( v: Villager ): Holder {

	return { items: v.bag, capacity: BAG_CAPACITY, owner: v.id };

}

export function isItem( kind: unknown ): kind is string {

	return itemKind( kind ) !== undefined;

}

/** items in a collection, all kinds together */
export function total( items: Items ): number {

	let n = 0;
	for ( const kind in items ) n += items[ kind ];
	return n;

}

export function count( items: Items, kind: string ): number {

	return items[ kind ] ?? 0;

}

/** The places a holder has left. */
export function room( h: Holder ): number {

	return h.capacity - total( h.items );

}

/** The item and count an option names (put, take, give: `{ item, count = 1 }`, the count checked
 * at the entrance: schema.ts), or why they are not one. */
export function itemCount( args: { item?: string; count?: number } ): { item: string; n: number } | string {

	if ( args.item === undefined ) return 'no item named';
	if ( ! isItem( args.item ) ) return `there is no item called ${ args.item }`;
	return { item: args.item, n: args.count ?? 1 };

}

/** n of a kind from one holder to another (the caller checked the one holds them, the other has
 * room). */
export function transfer( sim: Sim, from: Holder, to: Holder, kind: string, n: number ): void {

	change( sim, from, kind, - n );
	change( sim, to, kind, n );

}

/** n of a kind into a holder from the world (a catch; the caller checked there is room). */
export function bring( sim: Sim, to: Holder, kind: string, n = 1 ): void {

	change( sim, to, kind, n );

}

/** n of a kind out of a holder, gone (an item used; the caller checked it holds them). */
export function spend( sim: Sim, from: Holder, kind: string, n = 1 ): void {

	change( sim, from, kind, - n );

}

// ------------------------------------------------------------------ what moved

// per simulation, while a step is watched: each islander's changes, by item (signed counts)
const ledgers = new WeakMap<Sim, Map<EntityId, Items>>();

/** Keep what moves between bags from now until `takeMoves`. */
export function watchMoves( sim: Sim ): void {

	ledgers.set( sim, new Map() );

}

/** What moved between bags since `watchMoves`, by islander in the roll's order (signed counts, a
 * kind whose changes cancel out left out); undefined when nothing moved. The watch ends. */
export function takeMoves( sim: Sim ): Record<EntityId, Items> | undefined {

	const ledger = ledgers.get( sim );
	ledgers.delete( sim );
	if ( ! ledger || ledger.size === 0 ) return undefined;
	let moved: Record<EntityId, Items> | undefined;
	for ( const v of sim.state.villagers ) {

		const changes = ledger.get( v.id );
		if ( changes ) for ( const kind in changes ) if ( changes[ kind ] !== 0 ) ( ( moved ??= {} )[ v.id ] ??= {} )[ kind ] = changes[ kind ];

	}
	return moved;

}

function change( sim: Sim, h: Holder, kind: string, n: number ): void {

	const left = count( h.items, kind ) + n;
	if ( left > 0 ) h.items[ kind ] = left;
	else delete h.items[ kind ];
	const ledger = h.owner === undefined ? undefined : ledgers.get( sim );
	if ( ! ledger ) return;
	let changes = ledger.get( h.owner as EntityId );
	if ( ! changes ) ledger.set( h.owner as EntityId, changes = {} );
	changes[ kind ] = count( changes, kind ) + n;

}
