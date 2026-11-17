import type { RecordSave } from './Chronicle.ts';
import { SAVE_VERSION, type SimState } from './sim/types.ts';
import type { GameSettingsQuery } from './GameSettings.ts';

// The game's save: one slot in localStorage holding the simulation's state and the record.
//
// The game's save: one slot in this browser's storage (localStorage) holding the game as JSON with
// a version number: the simulation's state (sim/Sim.ts, where every change of the world is kept)
// and the record (沧海录, Chronicle.ts: its entries, each at its tick, and the skies of each day). Kept apart from Game.ts so the app's entry (WorldBoot.ts) can read the
// saved piece count as the app loads, before the world is asked for, without the game's code; and
// plain TypeScript, so node's checks read saves (tools/game/verify-game.mjs).
//
// What is not saved: what the app holds rather than the game (the weather, the camera, which page
// of the record is open), an agent's thought in flight (the islander is asked again once it has
// nothing under way, and still holds what it noticed, which only an answer acted on takes) and the
// player's words no thought has taken yet. Events (sim/events.ts) are not saved: the session hands
// them on before it saves.
//
// The app keeps the slot itself (`keepsSave`): it resumes the saved game as it loads, and saves it
// every minute while it runs and when the page is hidden or left (Game.ts). It does not in an
// automated browser, so a capture or a check neither resumes a game left in its profile nor leaves
// one there; the `autosave` URL option (on, off) decides anywhere. `load` resumes the save whatever
// that says, and `new` starts a new game, which replaces the save at its first save.
//
// Rules: a change to what is saved bumps SAVE_VERSION (sim/types.ts). While the game is in development a save of
// another version is not carried over: the app starts a new game, and copies the old save to
// UNREAD_KEY before it saves over the slot, so it is never lost unseen.

/** the one save slot (localStorage) */
export const SAVE_KEY = 'ponlai.game';
/** where a save this build cannot read is kept when the app saves over the slot */
export const UNREAD_KEY = 'ponlai.game.unread';

/** the save's shape this build writes (kept with the simulation, sim/types.ts) */
export { SAVE_VERSION };

export interface SaveFile {
	version: number;
	/** when it was written (ms since the epoch) */
	savedAt: number;
	sim: SimState;
	record: RecordSave;
}

const isObject = ( value: unknown ): value is Record<string, unknown> => value !== null && typeof value === 'object' && ! Array.isArray( value );

/** The save in `json`; null when there is none, it is not a save, or it is of another version. */
export function readSave( json: string | null ): SaveFile | null {

	if ( json === null ) return null;
	let save: unknown;
	try {

		save = JSON.parse( json );

	} catch {

		return null;

	}
	if ( ! isObject( save ) || save.version !== SAVE_VERSION || ! isObject( save.sim ) || ! isObject( save.record ) ) return null;
	const { sim, record } = save;
	return sim.version === SAVE_VERSION && Number.isInteger( sim.pieces ) && Array.isArray( record.entries ) ? save as unknown as SaveFile : null;

}

/** A game as a save's JSON, written now. */
export function writeSave( sim: SimState, record: RecordSave ): string {

	// eslint-disable-next-line ponlai/scene-clock -- the save's time stamp, shown to the player; play does not read it
	const save: SaveFile = { version: SAVE_VERSION, savedAt: Date.now(), sim, record };
	return JSON.stringify( save );

}

/** The island's pieces a save stands on (SimState.pieces), or null when there is no save this
 * build can read. */
export function savedPieces( json: string | null ): number | null {

	return readSave( json )?.sim.pieces ?? null;

}

/** The slot's JSON; null when it is empty or storage is off (a private window, blocked site data). */
export function readSlot(): string | null {

	try {

		return localStorage.getItem( SAVE_KEY );

	} catch {

		return null;

	}

}

/** Whether the app keeps the slot itself: resumes it at load, and saves as the game runs. */
export function keepsSave( params: GameSettingsQuery ): boolean {

	const asked = params.get( 'autosave' );
	if ( asked === 'on' || asked === 'off' ) return asked === 'on';
	return ! ( typeof navigator !== 'undefined' && navigator.webdriver );

}

/** Whether a page with these URL options resumes the saved game (when there is one it can read). */
export function resumesSave( params: GameSettingsQuery ): boolean {

	return ! params.has( 'new' ) && ( params.has( 'load' ) || keepsSave( params ) );

}
