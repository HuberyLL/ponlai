// The entry's first step: starts the world's generation as the page's modules load (the island's
// world/WorldStart.ts `startWorld`), on the land a resumed game's save grew. main.ts imports this
// module early (after the page's settings, PageSettings.ts), so the world's workers run while the
// rest of the page loads and sets up; the island's start knows no save, so the entry reads it here.
import { startWorld } from './world/WorldStart.ts';
import { readSlot, resumesSave, savedPieces } from './game/save.ts';
import { settings } from './Settings.ts';

const params = settings;

// A resumed game (game/save.ts `resumesSave`: the page keeps the save, or `load`) stands on the
// island its save grew: its piece count is the land's step, unless the `grow` option is given.
const pieces = params.has( 'game' ) && ! params.has( 'grow' ) && resumesSave( params ) ? savedPieces( readSlot() ) ?? 0 : 0;

export { worldProgress, landFraming, worldCacheOn } from './world/WorldStart.ts';
/** The land's options (the world's seed and its step) and the world's job, which main.ts awaits. */
export const { landOptions, worldJob } = startWorld( { pieces } );
