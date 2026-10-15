// The island for the CPU-only game checks (verify-game.mjs): the page's default land (seed 1, the
// starting island), and the land IslandGrowth grows from it by a number of pieces (`inputAt`).
import { growLand } from '../src/world/IslandGrowth.ts';

/** The island grown by `step` pieces after the starting island (seed 1). */
export function inputAt( step ) {

	const { land } = growLand( 1, step );
	return { land };

}

export const input = inputAt( 0 );
