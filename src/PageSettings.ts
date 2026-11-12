// The page's settings at its entry: the entry (Boot.ts) loads this module before the page (main.ts),
// so it runs before any module that reads a setting as it loads. It parses the address once,
// reports in one form each option nobody declared and each value outside its declared range (a
// console warning per option; the option keeps whatever its reader makes of it, as before),
// chooses the quality tier (QualityDetect.ts) and installs both for every module (Settings.ts).
// The rest of the page's own state outside the scene lives here too: the reload with changed
// options (a load setting's new value) and the browser's storage for what a page remembers between
// visits (the dynamic resolution's scale).
import { installSettings, parseSettings, settingProblems, type SettingName } from './Settings.ts';
import { chooseQuality, type QualityChoice } from './QualityDetect.ts';

const query = parseSettings( location.search );
for ( const problem of settingProblems( query ) ) console.warn( `[settings] ${ problem }` );
/** The tier this load builds and how it was chosen (QualityDetect.ts). */
export const QUALITY_CHOICE: QualityChoice = chooseQuality( query );
installSettings( query, QUALITY_CHOICE.tier );

/** Reloads the page with options set (a string; '' names one bare) or removed (null), in order. */
export function reloadWith( changes: Partial<Record<SettingName, string | null>> ): void {

	const url = new URL( location.href );
	for ( const [ name, value ] of Object.entries( changes ) ) {

		if ( value === null || value === undefined ) url.searchParams.delete( name );
		else url.searchParams.set( name, value );

	}
	location.assign( url );

}

/** The browser's storage for what the page remembers between visits, or null where it has none
 * (reading it throws where site data is blocked). Its own calls may still throw: callers catch. */
export const pageStore: Pick<Storage, 'getItem' | 'setItem'> | null = ( () => {

	try {

		return globalThis.localStorage ?? null;

	} catch {

		return null;

	}

} )();
