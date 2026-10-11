import { raiseNeed } from './needs.ts';
import type { ActionResult, Items, Villager } from './types.ts';

// The items an islander carries and what using one does. Items are content: each kind registers
// its uses here, and `use( item )` (actions.ts) runs one, so a new item adds an entry, never a new
// action. Using is instant and spends the item.
//
// Rules: a bag holds a few items in all (BAG_CAPACITY), items of a kind stack, and a full bag
// refuses more with a reason. A collection (a bag, the storehouse) is an item-to-count record that
// holds a kind only while its count is above zero, so its JSON says exactly what is there.

/** items a bag holds in all */
export const BAG_CAPACITY = 4;
/** hydration a coconut's water gives (needs.ts: about one every 8 game hours) */
export const COCONUT_HYDRATION = 32;
/** satiety a fish gives (needs.ts: about one every 12 game hours) */
export const FISH_SATIETY = 36;

/** A use of an item: acts on the body using it; the item is spent when it succeeds. */
export type ItemUse = ( body: Villager ) => ActionResult;

export interface ItemKind {
	/** use name to what it does; `use( item )` runs the first unless one is named */
	uses: Record<string, ItemUse>;
}

export const ITEMS: Readonly<Record<string, ItemKind>> = {
	coconut: { uses: { drink: ( body ) => {

		raiseNeed( body.needs, 'hydration', COCONUT_HYDRATION );
		return { ok: true, value: 'drank a coconut' };

	} } },
	fish: { uses: { eat: ( body ) => {

		raiseNeed( body.needs, 'satiety', FISH_SATIETY );
		return { ok: true, value: 'ate a fish' };

	} } },
};

export function isItem( kind: unknown ): kind is string {

	return typeof kind === 'string' && Object.hasOwn( ITEMS, kind );

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

export function addItems( items: Items, kind: string, n: number ): void {

	items[ kind ] = count( items, kind ) + n;

}

/** Remove n of a kind (the caller checked there are as many). */
export function removeItems( items: Items, kind: string, n: number ): void {

	const left = count( items, kind ) - n;
	if ( left > 0 ) items[ kind ] = left;
	else delete items[ kind ];

}

/** One item into a bag, or why not. */
export function intoBag( body: Villager, kind: string ): string | null {

	if ( total( body.bag ) >= BAG_CAPACITY ) return 'the bag is full';
	addItems( body.bag, kind, 1 );
	return null;

}
