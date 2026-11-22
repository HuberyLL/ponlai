// The player's language: kept in the browser's storage, or the browser's own, filled into `lang` at load.
//
// The player's choice on the settings menu's 语言 page is one value under STORAGE_KEY in the page's
// storage (PageSettings.ts `pageStore`): `auto` (also what no stored value means) or a language
// there is a catalogue for (game/ui/i18n/locales.ts). At the entry (PageSettings.ts) it is read
// once, before the settings are installed, and when the address names no `lang` it becomes this
// load's `lang`: the language chosen, or under auto the first of the browser's languages
// (`navigator.languages`, which follow the system's unless the player set the browser's own) that
// has a catalogue, else English. A stored value this build cannot read is removed and counts as auto.
//
// It is read on the pages that read the player's graphics settings (GraphicsSettings.ts
// `readsGraphicsStore`): an automated browser, the art-review page and `graphicsStore=off` show the
// address's `lang`, else the source language, Chinese (game/ui/i18n/i18n.ts), whatever the
// browser's language, so captures and checks see the same page on every machine.
import { LOCALES, detectLocale, type Locale } from '../packages/game/sim/index.ts';

export const STORAGE_KEY = 'ponlai.lang';

/** The menu's choices: auto, then the languages. */
export type LanguageChoice = 'auto' | Locale;
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [ 'auto', ...LOCALES ];

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** The stored choice; auto where none is stored, it is unreadable or storage is refused. */
export function loadLanguage( store: Store ): LanguageChoice {

	if ( ! store ) return 'auto';
	try {

		const raw = store.getItem( STORAGE_KEY );
		if ( raw === null || raw === 'auto' ) return 'auto';
		const found = LOCALES.find( ( l ) => l === raw );
		if ( found ) return found;
		store.removeItem( STORAGE_KEY );
		console.warn( `[language] the stored language ${ raw } has no catalogue: dropped` );
		return 'auto';

	} catch {

		return 'auto';

	}

}

/** Stores the choice; false where the browser keeps nothing. */
export function saveLanguage( store: Store, choice: LanguageChoice ): boolean {

	if ( ! store ) return false;
	try {

		store.setItem( STORAGE_KEY, choice );
		return true;

	} catch {

		return false;

	}

}

/** The language a choice shows with the browser's languages `tags` (most preferred first). */
export function resolveLanguage( choice: LanguageChoice, tags: readonly string[] ): Locale {

	return choice === 'auto' ? detectLocale( tags ) : choice;

}

/** The browser's languages, most preferred first (none where it gives none). */
export function browserLanguages(): readonly string[] {

	return navigator.languages?.length ? navigator.languages : navigator.language ? [ navigator.language ] : [];

}

/** The search string with `lang` filled in from the choice when the address names none. */
export function withLanguage( search: string, choice: LanguageChoice, tags: readonly string[] ): string {

	const params = new URLSearchParams( search );
	if ( params.has( 'lang' ) ) return search;
	params.set( 'lang', resolveLanguage( choice, tags ) );
	return params.toString();

}
