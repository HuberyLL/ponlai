// The entry's first step: starts the world's generation as the app's modules load.
//
// The entry's first step: starts the world's generation as the app's modules load (the island's
// world/WorldStart.ts `startWorld`), on the land a resumed game's save grew. main.ts imports this
// module before the app's own (app/), so the world's workers run while the app sets up the
// renderer; the island's start knows no save, so the entry reads it here.
//
// Debug pages (main.ts's DEBUG: the dev server, ?debug, ?profile) say when the world is in, as
// `window.__PONLAI_WORLD__` (`ready`, and `ms`, the page's clock then), set as the world starts: the
// capture tool loads a page with its GPU use held back and without a GPU slot, and takes the slot
// only once the world is generated (tools/kit/capture.mjs, "The slot after the world").
import { startWorld } from '../packages/island/index.ts';
import { readSlot, resumesSave, savedPieces } from '../packages/game/sim/index.ts';
import { settings } from './AppSettings.ts';

const params = settings;

// A resumed game (game/save.ts `resumesSave`: the app keeps the save, or `load`) stands on the
// island its save grew: its piece count is the land's step, unless the `grow` option is given.
const pieces = params.has( 'game' ) && ! params.has( 'grow' ) && resumesSave( params ) ? savedPieces( readSlot() ) ?? 0 : 0;

/** The land's options (the world's seed and its step) and the world's job, which main.ts awaits. */
export const { landOptions, worldJob } = startWorld( { pieces, webgpu: 'gpu' in navigator } );
if ( import.meta.env.DEV || params.has( 'debug' ) || params.has( 'profile' ) ) {

	const state: { ready: boolean; ms?: number } = { ready: false };
	( window as unknown as { __PONLAI_WORLD__: typeof state } ).__PONLAI_WORLD__ = state;
	// (a failed world is in too: the app goes on and reports it)
	// eslint-disable-next-line ponlai/scene-clock -- when the world was ready, a readout for the tools
	const done = () => { state.ready = true; state.ms = performance.now(); };
	worldJob.then( done, done );

}
