// The build bar's roster (docs/ui.md, Build bar: "The roster is data"): one row per building, in
// groups and small groups. Every row is a placeholder: the game's buildings are not settled, and
// the names, costs and hours follow the design canvas's example of scale, without the coconut
// grove (the coconut went with the palm). They cover every state the bar draws: buildable,
// not yet buildable (faint, unclickable), short of a material against the stock (朱), and without
// an icon (the 未绘 glyph). A row whose `kind` names one of the simulation's buildings
// (sim/buildings.ts BUILDING_KINDS: the chest) hands over to the placement in the scene when
// chosen; the others show what they would cost until the simulation knows them.
//
// A new building is one more row; a new group or small group is named by its rows (and a group
// here, for its icon and order). Costs name resources by id (data/resources.ts); hours are
// person-hours (one islander 3 h; two together about 1.5 h).

export interface BuildGroup {
	id: string;
	name: string;
	icon: string;
	/** the group of what was placed lately, nearest the mallet: its rows come from what the player placed */
	recent?: true;
}

export interface BuildingRow {
	id: string;
	name: string;
	/** its group's id (BUILD_GROUPS) */
	group: string;
	/** its small group within the group ('' for none) */
	sub: string;
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
	/** the simulation's building kind it places (sim/buildings.ts), when there is one */
	kind?: string;
}

/** the groups, in order from the magnifier to the mallet: the recent group stands nearest the mallet */
export const BUILD_GROUPS: readonly BuildGroup[] = [
	{ id: 'live', name: '居所', icon: 'b_hut' },
	{ id: 'food', name: '食物', icon: 'satiety' },
	{ id: 'water', name: '淡水', icon: 'drop' },
	{ id: 'store', name: '储藏', icon: 'b_chest' },
	{ id: 'work', name: '工坊', icon: 'b_carpentry' },
	{ id: 'guard', name: '防灾', icon: 'b_windbreak' },
	{ id: 'recent', name: '近用', icon: 'recent', recent: true },
];

const row = ( id: string, name: string, group: string, sub: string, icon: string | null, cost: Record<string, number>, hours: number, use: string, words: string, extra: Partial<BuildingRow> = {} ): BuildingRow =>
	( { id, name, group, sub, icon, cost, hours, use, words: words.split( ' ' ).filter( Boolean ), buildable: true, ...extra } );

export const BUILDINGS: readonly BuildingRow[] = [
	row( 'hut', '草棚', 'live', '住', 'b_hut', { wood: 6, leaf: 8 }, 3, '遮风挡雨，可睡 2 人', '屋 睡' ),
	row( 'cabin', '木屋', 'live', '住', 'b_cabin', { wood: 14 }, 6, '结实些，可睡 4 人', '屋 睡' ),
	row( 'stonehouse', '石屋', 'live', '住', 'b_stonehouse', { stone: 10, wood: 4 }, 8, '风暴也吹不倒，可睡 4 人', '屋 睡 风暴' ),
	row( 'hearth', '火塘', 'live', '火', 'b_hearth', { stone: 6 }, 1, '夜里取暖，烤干衣裳', '火 暖' ),
	row( 'rack', '晒鱼架', 'food', '海', 'b_rack', { wood: 5 }, 1, '晒干的鱼放得久', '鱼 晒' ),
	row( 'net', '渔网架', 'food', '海', 'b_net', { wood: 4, leaf: 6 }, 2, '补网、晾网，打鱼多些', '鱼 网' ),
	row( 'jetty', '栈桥', 'food', '海', 'b_jetty', { wood: 12 }, 4, '去深水处钓鱼', '鱼 钓 海' ),
	row( 'perch', '钓台', 'food', '海', 'b_perch', { stone: 3 }, 1, '礁石上钓鱼的地方', '鱼 钓' ),
	row( 'pond', '鱼塘', 'food', '海', 'b_pond', { stone: 8 }, 5, '养活鱼，随吃随取', '鱼 养' ),
	row( 'garden', '菜圃', 'food', '地', 'b_garden', { wood: 2 }, 2, '种些菜，要浇水', '种 菜' ),
	row( 'orchard', '果林', 'food', '地', 'b_orchard', { wood: 3 }, 4, '种果树，几日后结果', '果 种' ),
	row( 'stove', '灶台', 'food', '灶', 'b_stove', { stone: 4 }, 2, '煮鱼，熟食更顶饿', '煮 火' ),
	row( 'smoke', '熏房', 'food', '灶', 'b_smoke', { wood: 6, leaf: 4 }, 3, '熏鱼，放得更久', '鱼 熏' ),
	row( 'jar', '雨水缸', 'water', '', 'b_jar', { stone: 4 }, 2, '下雨时接水，可存 10 份', '水 雨' ),
	row( 'shed', '集水棚', 'water', '', 'b_shed', { wood: 6, leaf: 6 }, 3, '大片接雨，流进缸里', '水 雨' ),
	row( 'well', '井', 'water', '', 'b_well', { stone: 12 }, 10, '挖到淡水，不靠下雨', '水 挖' ),
	row( 'chest', '箱子', 'store', '', 'b_chest', { wood: 4 }, 1, '放东西，可存 20 件', '放 存', { kind: 'chest' } ),
	row( 'granary', '仓', 'store', '', 'b_granary', { wood: 10, leaf: 6 }, 5, '离地存粮，不怕潮', '粮 存' ),
	row( 'woodpile', '柴堆', 'store', '', 'b_woodpile', { wood: 1 }, 1, '堆木头，雨淋不湿', '木 存' ),
	row( 'carpentry', '木工坊', 'work', '', 'b_carpentry', { wood: 8 }, 4, '把木头做成板和梁', '木 做' ),
	row( 'mason', '石工坊', 'work', '', 'b_mason', { stone: 6, wood: 2 }, 4, '凿石块', '石 做' ),
	row( 'windbreak', '挡风墙', 'guard', '风', 'b_windbreak', { wood: 8, stone: 4 }, 3, '挡住风暴的风', '风 风暴' ),
	row( 'stonewall', '石墙', 'guard', '风', 'b_stonewall', { stone: 14 }, 6, '更结实的挡风墙', '风 风暴 石' ),
	row( 'fence', '竹篱', 'guard', '风', null, { bamboo: 6 }, 2, '竹子编的矮墙，挡风护菜', '竹 风 菜' ),
	row( 'tower', '望楼', 'guard', '望', 'b_tower', { wood: 10 }, 6, '早些看见风暴', '风暴 看', { buildable: false } ),
	row( 'lighthouse', '灯塔', 'guard', '望', 'b_lighthouse', { stone: 16, wood: 6 }, 12, '夜里给船指路', '船 夜', { buildable: false } ),
];

/** The roster with each row repeated `times` times in its small group (the debug panel's "many"
 * rows: the bar at a few times today's size), the copies named 二, 三. */
export function rosterTimes( times: number ): BuildingRow[] {

	if ( times <= 1 ) return [ ...BUILDINGS ];
	const out: BuildingRow[] = [];
	const numbers = '一二三四五六七八九';
	for ( const r of BUILDINGS ) for ( let k = 0; k < times; k ++ ) {

		// copies sit beside their row; only the original keeps the simulation's kind
		out.push( k === 0 ? r : { ...r, id: `${ r.id }_${ k }`, name: `${ r.name }·${ numbers[ k ] }`, kind: undefined } );

	}
	return out;

}
