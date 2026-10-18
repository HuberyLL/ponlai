// The game's one save slot: its key, the state's version this build reads, and the piece count a
// save stands on. Kept apart from Sim.ts so the world's start (world/WorldStart.ts) can read the
// saved piece count as the page loads, before the world is asked for, without the game's code.

/** the one save slot (localStorage) */
export const SAVE_KEY = 'ponlai.game';

/** the state's shape this build reads; a save of another is refused */
export const SAVE_VERSION = 17;

/** The island's pieces a save stands on (SimState.pieces), or null when there is no save or it
 * cannot be read (another version, not JSON). */
export function savedPieces( json: string | null ): number | null {

	if ( json === null ) return null;
	try {

		const state = JSON.parse( json ) as { version?: number; pieces?: number };
		return state.version === SAVE_VERSION && Number.isInteger( state.pieces ) ? state.pieces! : null;

	} catch {

		return null;

	}

}
