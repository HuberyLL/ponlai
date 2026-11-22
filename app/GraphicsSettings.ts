// The player's graphics settings: kept in the browser's storage, resolved into the tier and its overrides.
//
// The player's choice in the graphics menu (packages/render/GraphicsOptions.ts: a preset, or a custom
// set of options over a base tier) is one record under STORAGE_KEY in the page's storage
// (PageSettings.ts `pageStore`). At the entry (PageSettings.ts) it is read once, before the
// settings are installed: its tier becomes the load's tier unless the URL names one (`?quality`),
// and its custom choices become `tier.<path>` overrides installed before the URL's own options, so
// an override in the URL (`?tier.<path>`, `?aa`) still wins setting by setting. A record this build
// cannot read whole is removed and the page loads as if none was stored.
//
// The stored record is not read in an automated browser (captures, profiles and checks load what
// their address names, as the game's save is not resumed there: game/save.ts), on the art-review
// page (`?review`), nor under `?quality`; `graphicsStore=on` reads it anywhere (the menu's own checks), `off` never.
import { GRAPHICS_VERSION, presetRecord, readGraphicsRecord, resolveGraphics, type GraphicsRecord } from '../packages/render/setup.ts';
import type { QualityTier } from '../packages/render/setup.ts';
import type { PageSettingsQuery } from './AppSettings.ts';

export const STORAGE_KEY = 'ponlai.graphics';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null;

/** Whether this load reads and writes the player's stored record. */
export function readsGraphicsStore( query: PageSettingsQuery, automated: boolean ): boolean {

	const asked = query.get( 'graphicsStore' );
	if ( asked === 'on' ) return true;
	if ( asked === 'off' ) return false;
	// (the art-review page shows what its address names, as the tools see it)
	return ! automated && ! query.has( 'review' );

}

/** The stored record, or null (none, unreadable, or storage refused); an unreadable one is removed. */
export function loadGraphics( store: Store ): GraphicsRecord | null {

	if ( ! store ) return null;
	try {

		const raw = store.getItem( STORAGE_KEY );
		if ( raw === null ) return null;
		let parsed: unknown = null;
		try { parsed = JSON.parse( raw ); } catch { /* not JSON: dropped below */ }
		const record = readGraphicsRecord( parsed );
		if ( ! record ) {

			store.removeItem( STORAGE_KEY );
			console.warn( `[graphics] the stored settings are not of version ${ GRAPHICS_VERSION }: dropped` );

		}
		return record;

	} catch {

		return null;

	}

}

/** Stores the record; false where the browser keeps nothing. */
export function saveGraphics( store: Store, record: GraphicsRecord ): boolean {

	if ( ! store ) return false;
	try {

		store.setItem( STORAGE_KEY, JSON.stringify( record ) );
		return true;

	} catch {

		return false;

	}

}

/** The search string the settings are installed from: the stored overrides first, then the URL's own. */
export function withStoredOverrides( search: string, record: GraphicsRecord | null ): string {

	if ( ! record ) return search;
	const overrides = new URLSearchParams( resolveGraphics( record ).overrides );
	const own = search.replace( /^\?/, '' );
	return [ overrides.toString(), own ].filter( Boolean ).join( '&' );

}

/** The record the menu starts from: the stored one, else the loaded tier's preset. */
export function currentGraphics( stored: GraphicsRecord | null, tier: QualityTier ): GraphicsRecord {

	return stored ?? presetRecord( tier );

}
