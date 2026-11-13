import type { WeatherName } from '../../../render/index.ts';
import type { RecordEntry } from '../../Chronicle.ts';
import { lookup, t } from '../i18n/i18n.ts';
import { needLook } from './needs.ts';
import { itemName } from './words.ts';

// The kinds of entry the record (沧海录) shows (docs/explanation/ui.md, 沧海录): how each reads as a row of the
// day's log, and the mark it puts over its day on the river. The game keeps the entries
// (packages/game/Chronicle.ts); a new kind of entry is a row here, and the record's components never
// change for it; a kind without a row reads as the default one (`recordKind`: who, and what), and
// logs. `rank` orders the marks: over a day the most notable stands, with how many more (+N); a
// kind without a mark only logs. What an entry names reads by its own words where the catalogue
// has them, else the default: a need by `record.need`, else 告急, its mark by its look
// (data/needs.ts); an item by its name (`item`), else its id.
//
// Words are the player's (精白) or an islander's (缟) and read as a speaker and their line; every
// other entry is a deed, one line. `deed` writes it from the entry, the namer of islanders and
// buildings, and whether the page is one islander's (their own name then goes unsaid: the
// catalogue's `_own` form). The words are the catalogue's (i18n/zh-CN.json `record.deed`).

export interface RecordNames {
	/** an islander's name by id */
	person( id: string ): string;
	/** a building's name by the simulation's kind */
	building( kind: string ): string;
}

export interface RecordKind {
	id: string;
	/** the river's mark: its icon (null: the 未绘 glyph, Icons.ts), and 朱 for an alarm */
	mark?: { icon: ( e: RecordEntry ) => string | null; alarm?: boolean };
	rank: number;
	/** words: shown as a speaker and a line, not a deed */
	words?: true;
	/** the deed's line */
	deed( e: RecordEntry, names: RecordNames, own: boolean ): string;
}

const needWords = ( need: string ) => lookup( `record.need.${ need }`, t( 'record.need.other' ) );
const own = ( yes: boolean ) => ( yes ? { context: 'own' } : {} );

export const RECORD_KINDS: Readonly<Record<string, RecordKind>> = {
	landed: { id: 'landed', rank: 0, mark: { icon: () => 'boat' }, deed: ( e, n, mine ) => t( 'record.deed.landed', { who: n.person( e.who ), ...own( mine ) } ) },
	// (no mark of its own yet: it logs)
	died: { id: 'died', rank: 9, deed: ( e, n, mine ) => t( 'record.deed.died', { who: n.person( e.who ), age: e.text ?? '', ...own( mine ) } ) },
	built: { id: 'built', rank: 1, mark: { icon: () => 'build' }, deed: ( e, n ) => t( 'record.deed.built', { building: n.building( e.text ?? '' ) } ) },
	need: { id: 'need', rank: 2, mark: { icon: ( e ) => needLook( e.text ?? '' ).icon, alarm: true },
		deed: ( e, n, mine ) => t( 'record.deed.need', { who: n.person( e.who ), need: needWords( e.text ?? '' ), ...own( mine ) } ) },
	placed: { id: 'placed', rank: 9, deed: ( e, n ) => t( 'record.deed.placed', { building: n.building( e.text ?? '' ) } ) },
	said: { id: 'said', rank: 9, words: true, deed: ( e ) => e.text ?? '' },
	// one islander handing another something (no mark: it logs)
	gave: { id: 'gave', rank: 9, deed: ( e, n, mine ) => t( 'record.deed.gave', {
		who: n.person( e.who ), to: n.person( Array.isArray( e.to ) ? e.to[ 0 ] : '' ), count: e.count ?? 1,
		unit: lookup( `unit.${ e.text ?? '' }`, '' ), item: itemName( e.text ?? '' ), ...own( mine ),
	} ) },
};

// an entry of a kind without a row: who, and what it names (or its kind)
const OTHER: RecordKind = { id: 'other', rank: 9, deed: ( e, n, mine ) => t( 'record.deed.other', { who: n.person( e.who ), what: e.text ?? e.kind, ...own( mine ) } ) };

/** How an entry of a kind reads: its kind's row, or the default. */
export const recordKind = ( kind: string ): RecordKind => ( Object.hasOwn( RECORD_KINDS, kind ) ? RECORD_KINDS[ kind ] : OTHER );

/** Several landings on one day read as one mark over it on the island's page: N人登岛. */
export const LANDINGS = ( n: number ) => t( 'record.landings', { count: n } );

/** A day's name: 第一日. */
export const dayName = ( day: number ) => t( 'time.day', { day } );

/**
 * Placeholder days for the debug panel (Interface, "placeholder days"): nine days of landings,
 * words, buildings and alarms, so the river scrolls, the list of islanders runs past seven names and
 * every mark shows. Islanders are given by their place in the roll (0 the first: the game's own
 * islanders where it has them, else PLACEHOLDER_NAMES), the player as 'player'; each day's weather
 * is PLACEHOLDER_SKIES'. The names and lines are content (what people are called and say, as the
 * game's own are: sim/Sim.ts), not the interface's words, so they are not in the catalogue.
 */
export const PLACEHOLDER_NAMES = [ '阿凯', '阿木', '小禾', '阿青', '石头', '阿月', '阿海', '小满', '阿岚', '竹生' ];
export const PLACEHOLDER_SKIES: readonly WeatherName[] = [ 'fair', 'clear', 'fair', 'fair', 'clear', 'fair', 'clear', 'clear', 'fair' ];
export const PLACEHOLDER_DAYS: readonly ( { day: number; minute: number; kind: string; who: number | 'player' | 'island'; to?: number[] | 'all'; text?: string } )[] = [
	{ day: 1, minute: 390, kind: 'landed', who: 0 },
	{ day: 1, minute: 392, kind: 'landed', who: 1 },
	{ day: 1, minute: 395, kind: 'landed', who: 2 },
	{ day: 1, minute: 430, kind: 'said', who: 'player', to: 'all', text: '今天先把箱子建起来。' },
	{ day: 1, minute: 431, kind: 'said', who: 0, text: '明白，我这就去。' },
	{ day: 1, minute: 478, kind: 'built', who: 'island', text: 'chest' },
	{ day: 2, minute: 480, kind: 'said', who: 'player', to: [ 0 ], text: '先去喝点水，然后把箱子装满鱼。' },
	{ day: 2, minute: 481, kind: 'said', who: 0, text: '好，我先去海边。' },
	{ day: 2, minute: 900, kind: 'need', who: 1, text: 'hydration' },
	{ day: 3, minute: 600, kind: 'placed', who: 'player', text: 'chest' },
	{ day: 4, minute: 700, kind: 'landed', who: 3 },
	{ day: 5, minute: 820, kind: 'said', who: 3, text: '箱子放哪儿？' },
	{ day: 6, minute: 300, kind: 'need', who: 2, text: 'satiety' },
	{ day: 7, minute: 610, kind: 'built', who: 'island', text: 'chest' },
	{ day: 8, minute: 540, kind: 'landed', who: 4 },
	{ day: 8, minute: 545, kind: 'landed', who: 5 },
	{ day: 9, minute: 420, kind: 'said', who: 'player', to: 'all', text: '风要来了，把东西收进箱子。' },
	{ day: 9, minute: 600, kind: 'landed', who: 6 },
	{ day: 9, minute: 601, kind: 'landed', who: 7 },
	{ day: 9, minute: 602, kind: 'landed', who: 8 },
	{ day: 9, minute: 640, kind: 'said', who: 6, text: '这岛比我想的还小。' },
];
