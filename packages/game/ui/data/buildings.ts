import { t } from '../i18n/i18n.ts';
import type { Catalogue } from '../i18n/i18n.ts';

// The build bar's roster: one placeholder row per building, in groups and small groups.
//
// The build bar's roster (docs/explanation/ui.md, Build bar: "The roster is data"): one row per building, in
// groups and small groups. Every row is a placeholder: the game's buildings are not settled, and
// the names, costs and hours are an example of scale. They cover every state the bar draws:
// buildable, not yet buildable (faint, unclickable), short of a material against the stock (朱),
// and without an icon (the 未绘 glyph). A row whose `kind` names one of the simulation's building kinds
// (sim/registry.ts BuildingDef; today the chest, sim/content/chest.ts) hands over to the placement
// in the scene when chosen; the others show what they would cost until the simulation knows them.
// A kind the player can place is a row here: where it stands in the bar and what it costs are the
// design's, so a kind without one has no default row.
//
// A new building is one more row here and its words in the catalogue (i18n/zh-CN.json `building`:
// name, use and search words, by the row's id; the type check fails on a row without them); a new
// group or small group is named by its rows (and a group here, for its icon and order), its name
// in the catalogue (`build.group`, `build.sub`). Costs name resources by id (data/resources.ts);
// hours are person-hours (one islander 3 h; two together about 1.5 h). The words are resolved when
// the table loads, in the page's language (i18n/i18n.ts).

type BuildingId = keyof Catalogue[ 'building' ];
type GroupId = keyof Catalogue[ 'build' ][ 'group' ];
type SubId = keyof Catalogue[ 'build' ][ 'sub' ];

export interface BuildGroup {
	id: GroupId;
	name: string;
	icon: string;
	/** the group of what was placed lately, nearest the mallet: its rows come from what the player placed */
	recent?: true;
}

export interface BuildingRow {
	id: string;
	name: string;
	/** its group's id (BUILD_GROUPS) */
	group: GroupId;
	/** its small group within the group ('' for none) and that small group's name */
	sub: SubId | '';
	subName: string;
	/** its icon (Icons.ts); null: not drawn yet */
	icon: string | null;
	/** resource id to count */
	cost: Readonly<Record<string, number>>;
	/** person-hours of work */
	hours: number;
	/** what it is for */
	use: string;
	/** more words a search finds it by */
	words: readonly string[];
	/** false: not yet buildable (shown faint, not chosen) */
	buildable: boolean;
	/** the simulation's building kind it places (sim/registry.ts), when there is one */
	kind?: string;
}

const group = ( id: GroupId, icon: string, recent?: true ): BuildGroup => ( { id, name: t( `build.group.${ id }` ), icon, ...( recent ? { recent } : {} ) } );

/** the groups, in order from the magnifier to the mallet: the recent group stands nearest the mallet */
export const BUILD_GROUPS: readonly BuildGroup[] = [
	group( 'live', 'b_hut' ),
	group( 'food', 'satiety' ),
	group( 'water', 'drop' ),
	group( 'store', 'b_chest' ),
	group( 'work', 'b_carpentry' ),
	group( 'guard', 'b_windbreak' ),
	group( 'recent', 'recent', true ),
];

const row = ( id: BuildingId, group: GroupId, sub: SubId | '', icon: string | null, cost: Record<string, number>, hours: number, extra: Partial<BuildingRow> = {} ): BuildingRow => ( {
	id, name: t( `building.${ id }.name` ), group, sub, subName: sub ? t( `build.sub.${ sub }` ) : '', icon, cost, hours,
	use: t( `building.${ id }.use` ), words: t( `building.${ id }.words` ).split( ' ' ).filter( Boolean ), buildable: true, ...extra,
} );

export const BUILDINGS: readonly BuildingRow[] = [
	row( 'hut', 'live', 'home', 'b_hut', { wood: 6, leaf: 8 }, 3 ),
	row( 'cabin', 'live', 'home', 'b_cabin', { wood: 14 }, 6 ),
	row( 'stonehouse', 'live', 'home', 'b_stonehouse', { stone: 10, wood: 4 }, 8 ),
	row( 'hearth', 'live', 'fire', 'b_hearth', { stone: 6 }, 1 ),
	row( 'rack', 'food', 'sea', 'b_rack', { wood: 5 }, 1 ),
	row( 'net', 'food', 'sea', 'b_net', { wood: 4, leaf: 6 }, 2 ),
	row( 'jetty', 'food', 'sea', 'b_jetty', { wood: 12 }, 4 ),
	row( 'perch', 'food', 'sea', 'b_perch', { stone: 3 }, 1 ),
	row( 'pond', 'food', 'sea', 'b_pond', { stone: 8 }, 5 ),
	row( 'garden', 'food', 'land', 'b_garden', { wood: 2 }, 2 ),
	row( 'orchard', 'food', 'land', 'b_orchard', { wood: 3 }, 4 ),
	row( 'stove', 'food', 'stove', 'b_stove', { stone: 4 }, 2 ),
	row( 'smoke', 'food', 'stove', 'b_smoke', { wood: 6, leaf: 4 }, 3 ),
	row( 'jar', 'water', '', 'b_jar', { stone: 4 }, 2 ),
	row( 'shed', 'water', '', 'b_shed', { wood: 6, leaf: 6 }, 3 ),
	row( 'well', 'water', '', 'b_well', { stone: 12 }, 10 ),
	row( 'chest', 'store', '', 'b_chest', { wood: 4 }, 1, { kind: 'chest' } ),
	row( 'granary', 'store', '', 'b_granary', { wood: 10, leaf: 6 }, 5 ),
	row( 'woodpile', 'store', '', 'b_woodpile', { wood: 1 }, 1 ),
	row( 'carpentry', 'work', '', 'b_carpentry', { wood: 8 }, 4 ),
	row( 'mason', 'work', '', 'b_mason', { stone: 6, wood: 2 }, 4 ),
	row( 'windbreak', 'guard', 'wind', 'b_windbreak', { wood: 8, stone: 4 }, 3 ),
	row( 'stonewall', 'guard', 'wind', 'b_stonewall', { stone: 14 }, 6 ),
	row( 'fence', 'guard', 'wind', null, { bamboo: 6 }, 2 ),
	row( 'tower', 'guard', 'watch', 'b_tower', { wood: 10 }, 6, { buildable: false } ),
	row( 'lighthouse', 'guard', 'watch', 'b_lighthouse', { stone: 16, wood: 6 }, 12, { buildable: false } ),
];

/** The roster with each row repeated `times` times in its small group (the debug panel's "many"
 * rows: the bar at a few times today's size), the copies numbered from 2 (`build.copy`). */
export function rosterTimes( times: number ): BuildingRow[] {

	if ( times <= 1 ) return [ ...BUILDINGS ];
	const out: BuildingRow[] = [];
	for ( const r of BUILDINGS ) for ( let k = 0; k < times; k ++ ) {

		// copies sit beside their row; only the original keeps the simulation's kind
		out.push( k === 0 ? r : { ...r, id: `${ r.id }_${ k }`, name: t( 'build.copy', { name: r.name, n: k + 1 } ), kind: undefined } );

	}
	return out;

}
