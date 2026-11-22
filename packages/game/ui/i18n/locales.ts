// The interface's languages and the match of a browser's language tag to one of them.
//
// The languages there are catalogues for (i18n.ts) and how a language tag (`?lang=`, the player's
// stored choice, the browser's `navigator.languages`) names one: the whole tag first (`zh-CN`), then
// its primary language (`zh-TW`, `zh` and `zh-Hans` name Chinese; `en-GB` names English). It
// imports nothing, so the app reads it before the settings are installed (app/LanguageSettings.ts).

export type Locale = 'zh-CN' | 'en';
/** the language the game is written in, filling any gap of another */
export const SOURCE_LOCALE: Locale = 'zh-CN';
/** the language a player's page shows when none of the browser's languages has a catalogue */
export const FALLBACK_LOCALE: Locale = 'en';
/** the languages there are catalogues for */
export const LOCALES: readonly Locale[] = [ 'zh-CN', 'en' ];

/** The language a tag names, or null when there is no catalogue for it. */
export function matchLocale( tag: string ): Locale | null {

	const asked = tag.trim().toLowerCase();
	if ( ! asked ) return null;
	return LOCALES.find( ( l ) => l.toLowerCase() === asked ) ?? LOCALES.find( ( l ) => l.split( '-' )[ 0 ] === asked.split( '-' )[ 0 ] ) ?? null;

}

/** The first of a browser's languages, in its order of preference, that has a catalogue; else English. */
export function detectLocale( tags: readonly string[] ): Locale {

	for ( const tag of tags ) {

		const found = matchLocale( tag );
		if ( found ) return found;

	}
	return FALLBACK_LOCALE;

}
