import i18next from 'i18next';
import en from './en.json';
import zh from './zh-CN.json';

// The interface's languages, on i18next (https://www.i18next.com). Every word the player reads is a
// key of a catalogue here, one JSON file per language: zh-CN.json is the source, written with the
// game and complete, and the language shown by default; en.json is a snapshot of it, kept but not
// maintained while the game is in development, so a key it lacks shows the Chinese (i18next's
// fallback, key by key). An English version made for release fills it (docs/explanation/ui.md: never mixed).
//
// The language is a load knob, read once from `?lang=` (zh-CN or en; none or another: zh-CN): the
// data tables resolve their rows' words when they load (data/*.ts) and the parts build their fixed
// labels once, so a change of language reloads the page (the debug panel's Interface folder does).
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
// Rules: no player-facing string is written in code outside these files (tools/verify-i18n.mjs
// fails on a Chinese literal elsewhere and reports where en.json has drifted from zh-CN.json). A
// call costs a few microseconds, so per-frame code calls `t` only when what it says changed, and
// fixed words are taken once.

export type Locale = 'zh-CN' | 'en';
/** the language the game is written in, shown by default and filling any gap of another */
export const SOURCE_LOCALE: Locale = 'zh-CN';
/** the languages there are catalogues for */
export const LOCALES: readonly Locale[] = [ 'zh-CN', 'en' ];

/** The language of this page: `?lang=`, else the source. */
export const locale: Locale = ( () => {

	const asked = typeof location === 'undefined' ? null : new URLSearchParams( location.search ).get( 'lang' );
	if ( asked === null ) return SOURCE_LOCALE;
	const found = LOCALES.find( ( l ) => l.toLowerCase() === asked.toLowerCase() || l.split( '-' )[ 0 ] === asked.toLowerCase() );
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
