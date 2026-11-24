import { count } from '../../sim/items.ts';
import { itemKinds } from '../../sim/registry.ts';
import type { Items } from '../../sim/types.ts';
import { t } from '../i18n/i18n.ts';
import type { Catalogue } from '../i18n/i18n.ts';
import { itemName } from './words.ts';

// The island's resources as the top row shows them: one row per kind, with icon and count.
//
// The island's resources as the top row shows them (docs/design/ui.md, Resources): one row per kind, in
// groups (materials, food, water), each with its icon and its count. A kind the simulation has as an
// item (sim/items.ts) counts what the island's stores hold of it (sim/stock.ts); a kind it does not
// have yet shows its placeholder count, so the row and the build bar's costs can be seen at work
// before the materials exist (docs/design/game-design.md: no materials yet). The rows are placeholders
// too: the game's resources are not settled, and a new kind is a new row here with its name in the
// catalogue (i18n/zh-CN.json `resource`, by id), resolved when the table loads. An item the
// simulation has (sim/registry.ts) that no row counts shows all the same, with the default row
// (`withItems`): its item's name, the 未绘 glyph, among the materials, out of view when the row is
// full, until it is given a row of its own.
//
// With more than ROW_MAX kinds the row keeps the common ones in view and merges the rest of each
// group into one mark that opens on hover (ResourceRow.ts); MORE_RESOURCES are placeholder kinds
// the debug panel adds to see it.

export type ResourceGroup = 'material' | 'food' | 'water';
type ResourceId = keyof Catalogue[ 'resource' ];

export interface ResourceRow {
	/** the key costs name it by (data/buildings.ts) */
	id: string;
	/** its name (for screen readers and the record) */
	name: string;
	group: ResourceGroup;
	/** its icon (IconArt.ts); null: not drawn yet */
	icon: string | null;
	/** the simulation's item kind it counts in the stores; none: the placeholder count shows */
	item?: string;
	/** the count shown while the simulation has no such item */
	placeholder: number;
	/** kept in view when the row holds more than ROW_MAX kinds */
	common: boolean;
}

/** the groups, in the row's order */
export const RESOURCE_GROUPS: readonly ResourceGroup[] = [ 'material', 'food', 'water' ];

const row = ( id: ResourceId, group: ResourceGroup, icon: string | null, placeholder: number, common: boolean, item?: string ): ResourceRow =>
	( { id, name: t( `resource.${ id }` ), group, icon, placeholder, common, ...( item !== undefined ? { item } : {} ) } );

export const RESOURCES: readonly ResourceRow[] = [
	row( 'wood', 'material', 'wood', 9, true ),
	row( 'bamboo', 'material', 'bamboo', 4, true ),
	row( 'stone', 'material', 'stone', 6, true ),
	row( 'leaf', 'material', 'leaf', 12, true ),
	row( 'fish', 'food', 'fish', 0, true, 'fish' ),
	row( 'water', 'water', 'drop', 8, true ),
];

/** placeholder kinds beyond the eight the row shows whole (the debug panel's "many" rows) */
export const MORE_RESOURCES: readonly ResourceRow[] = [
	row( 'rope', 'material', null, 3, false ),
	row( 'clay', 'material', null, 7, false ),
	row( 'shell', 'material', null, 15, false ),
	row( 'fruit', 'food', null, 5, false ),
	row( 'salt', 'food', null, 2, false ),
];

/** The rows with a default one after them for each item the simulation has that none counts. */
export function withItems( rows: readonly ResourceRow[] ): ResourceRow[] {

	const counted = new Set( rows.map( ( r ) => r.item ) );
	const extra = itemKinds().filter( ( k ) => ! counted.has( k.id ) )
		.map( ( k ): ResourceRow => ( { id: k.id, name: itemName( k.id ), group: 'material', icon: null, item: k.id, placeholder: 0, common: false } ) );
	return [ ...rows, ...extra ];

}

/** the most kinds the row shows whole */
export const ROW_MAX = 8;

/** A resource's count: what the stores hold of its item, or its placeholder. */
export function resourceCount( row: ResourceRow, stock: Items ): number {

	return row.item !== undefined ? count( stock, row.item ) : row.placeholder;

}

/** Every resource's count, by id: the stock the build bar's costs are read against. */
export function resourceStock( rows: readonly ResourceRow[], stock: Items ): Items {

	const out: Items = {};
	for ( const row of rows ) out[ row.id ] = resourceCount( row, stock );
	return out;

}
