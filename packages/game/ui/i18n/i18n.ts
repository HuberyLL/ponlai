import i18next from 'i18next';
import en from './en.json';
import zh from './zh-CN.json';
import { settings } from '../../GameSettings.ts';
import { LOCALES, SOURCE_LOCALE, matchLocale, type Locale } from './locales.ts';

// The interface's languages, on i18next: every word the player reads is a catalogue's key.
//
// The interface's languages, on i18next (https://www.i18next.com). Every word the player reads is a
// key of a catalogue here, one JSON file per language: zh-CN.json is the source, written with the
// game; en.json is its translation, kept complete with it (tools/game/verify-i18n.mjs fails on a
// key it lacks). A key a catalogue still lacked would show the Chinese (i18next's fallback, key by
// key). The languages and how a tag names one are in locales.ts. The catalogues are the game's
// creative content and carry its licence, not the code's (REUSE.toml), so the words stay in them,
// never in code.
//
// The language is a load-time setting, read once from `?lang=` (zh-CN or en; none or another:
// zh-CN). On a player's page the app fills it in when the address names none: the language chosen
// in the settings menu, or with 自动 (the default) the browser's own (app/LanguageSettings.ts). The
// data tables resolve their rows' words when they load (data/*.ts) and the parts build their fixed
// labels once, so a change of language reloads the page (the settings menu's 语言 page and the debug
// panel's Interface folder do). The English page is laid out with the Chinese page's measures and
// letter spacing, untuned.
//
// What is content rather than the interface's words stays out of the catalogues: the islanders'
// names (sim/Sim.ts) and what people say (the player's lines, the islanders' answers, the debug
// panel's placeholder days and hearing agent).
//
// Writing text:
// - A new string is a key in zh-CN.json, read through `t( 'part.key' )`; the keys are typed from
//   zh-CN.json (i18next.d.ts), so a key that is not there fails the type check. A list's row names
//   its words by its id (`building.hut.name`), so a new row is a row in data/ and its words here.
// - Values go in by name (`{{place}}`); the order and the words around them are the language's.
//   `{{n, chinese}}` writes a whole number in Chinese numerals (第十二日), and a count by which a
//   language's words change goes in as `count`, its forms as i18next's plural keys (`_one`, `_other`;
//   Chinese has one form, so its key has no suffix). A variant by context is `_own` and the like.
// - Lists are joined by `list.and` (、) and clauses by `list.then` (，), never by a character in code.
// - Words for the simulation's own ids (an item's kind, a place, an action, a refusal) are looked up
//   with `lookup`, which falls back to the id where the catalogue has no row.
// - Interpolation is not HTML-escaped: the interface sets text, never markup.
//
// Rules: no player-facing string is written in code outside these files (tools/game/verify-i18n.mjs
// fails on a Chinese literal elsewhere and on a key en.json lacks or no longer needs). A
// call costs a few microseconds, so per-frame code calls `t` only when what it says changed, and
// fixed words are taken once.

export { LOCALES, SOURCE_LOCALE, type Locale } from './locales.ts';

/** The language of this page: `?lang=`, else the source. */
export const locale: Locale = ( () => {

	const asked = settings.get( 'lang' );
	if ( asked === null ) return SOURCE_LOCALE;
	const found = matchLocale( asked );
	if ( ! found ) console.warn( `?lang=${ asked }: no such language (${ LOCALES.join( ', ' ) }); showing ${ SOURCE_LOCALE }` );
	return found ?? SOURCE_LOCALE;

} )();

/** The catalogue's shape (the source's), for typed ids of a list's rows. */
export type Catalogue = typeof zh;

const i18n = i18next.createInstance();
i18n.init( {
	lng: locale,
	fallbackLng: SOURCE_LOCALE,
	supportedLngs: LOCALES,
	load: 'currentOnly',
	// the catalogues are bundled: ready before the first word is asked for
	initAsync: false,
	resources: { 'zh-CN': { translation: zh }, en: { translation: en } },
	interpolation: { escapeValue: false },
} );
i18n.services.formatter?.add( 'chinese', ( value ) => chineseNumber( Number( value ) ) );

/** A word of the catalogue in this page's language. */
export const t = i18n.getFixedT( locale );

/** Words for one of the simulation's ids: the catalogue's `key`, or `fallback` where it has none. */
export function lookup( key: string, fallback: string, values?: Record<string, unknown> ): string {

	// (a key built from a simulation's id is not one the type check can know)
	return i18n.exists( key ) ? ( t as unknown as ( key: string, values?: Record<string, unknown> ) => string )( key, values ) : fallback;

}

const DIGITS = '〇一二三四五六七八九';

/** A whole number in Chinese numerals, as days are named (第十二日); from 100 on, in digits. */
function chineseNumber( v: number ): string {

	if ( ! Number.isInteger( v ) || v < 0 || v >= 100 ) return String( v );
	if ( v < 10 ) return DIGITS[ v ];
	const tens = Math.floor( v / 10 ), ones = v % 10;
	return ( tens > 1 ? DIGITS[ tens ] : '' ) + '十' + ( ones ? DIGITS[ ones ] : '' );

}
