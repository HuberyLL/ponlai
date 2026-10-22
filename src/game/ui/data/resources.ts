import { count } from '../../sim/items.ts';
import type { Items } from '../../sim/types.ts';

// The island's resources as the top row shows them (docs/ui.md, Resources): one row per kind, in
// groups (materials, food, water), each with its icon and its count. A kind the simulation has as an
// item (sim/items.ts) counts what the island's stores hold of it (sim/stock.ts); a kind it does not
// have yet shows its placeholder count, so the row and the build bar's costs can be seen at work
// before the materials exist (docs/game-design.md: no materials yet). The rows are placeholders
// too: the game's resources are not settled, and a new kind is a new row here.
//
// With more than ROW_MAX kinds the row keeps the common ones in view and merges the rest of each
// group into one mark that opens on hover (ResourceRow.ts); MORE_RESOURCES are placeholder kinds
// the debug panel adds to see it.

export type ResourceGroup = 'material' | 'food' | 'water';

export interface ResourceRow {
	/** the key costs name it by (data/buildings.ts) */
	id: string;
	/** its name (for screen readers and the record) */
	name: string;
	group: ResourceGroup;
	/** its icon (Icons.ts); null: not drawn yet */
	icon: string | null;
	/** the simulation's item kind it counts in the stores; none: the placeholder count shows */
	item?: string;
	/** the count shown while the simulation has no such item */
	placeholder: number;
	/** kept in view when the row holds more than ROW_MAX kinds */
	common: boolean;
}

export const RESOURCE_GROUPS: readonly { id: ResourceGroup; name: string }[] = [
	{ id: 'material', name: '材料' },
	{ id: 'food', name: '食物' },
	{ id: 'water', name: '淡水' },
];

export const RESOURCES: readonly ResourceRow[] = [
	{ id: 'wood', name: '木', group: 'material', icon: 'wood', placeholder: 9, common: true },
	{ id: 'bamboo', name: '竹', group: 'material', icon: 'bamboo', placeholder: 4, common: true },
	{ id: 'stone', name: '石', group: 'material', icon: 'stone', placeholder: 6, common: true },
	{ id: 'leaf', name: '叶', group: 'material', icon: 'leaf', placeholder: 12, common: true },
	{ id: 'fish', name: '鱼', group: 'food', icon: 'fish', item: 'fish', placeholder: 0, common: true },
	{ id: 'water', name: '水', group: 'water', icon: 'drop', placeholder: 8, common: true },
];

/** placeholder kinds beyond the eight the row shows whole (the debug panel's "many" rows) */
export const MORE_RESOURCES: readonly ResourceRow[] = [
	{ id: 'rope', name: '绳', group: 'material', icon: null, placeholder: 3, common: false },
	{ id: 'clay', name: '陶土', group: 'material', icon: null, placeholder: 7, common: false },
	{ id: 'shell', name: '贝', group: 'material', icon: null, placeholder: 15, common: false },
	{ id: 'fruit', name: '果', group: 'food', icon: null, placeholder: 5, common: false },
	{ id: 'salt', name: '盐', group: 'food', icon: null, placeholder: 2, common: false },
];

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
