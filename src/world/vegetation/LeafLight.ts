import { uniform } from 'three/tsl';
import { tuneKeys } from '../../debug/Tune.ts';
import { keyed, type DayKeys } from '../../post/DayKeys.ts';

// What a tree's leaves pass on of the key, as a look keyed by the sun and the weather (post/DayKeys.ts).
//
// `through`: the share of the key a leaf in a crown's shade still takes, the light of the leaves
// over it (lighting/SunShadow.ts, a receiver marked `userData.keyThrough`): the sun's map takes every
// leaf as black, and a crown whose shaded leaves took only the ambient read dark and as blue as the
// sky. It stands at its share from 12 degrees up. It is 0 at a sun of 3 degrees, where a crown's
// shaded side stands dark against the low light, and under a closed sky and by night, whose light
// comes from all round and has no beam for a leaf to pass on.
//
// Read once a frame into uniforms (main.ts), so it is a function of the clock and the weather alone
// and a paused frame repeats. Tunable on debug pages (debug/Tune.ts):
// `lighting.vegetation.leaf.through@golden`, `@low`, `@high`, `@cloudy`, `@night`.
export const LEAF_LIGHT: DayKeys<{ through: number }> = tuneKeys( 'lighting.vegetation.leaf', {
	day: [
		{ at: 3, name: 'golden', values: { through: 0 } },
		{ at: 12, name: 'low', values: { through: 0.18 } },
		{ at: 40, name: 'high', values: { through: 0.18 } },
	],
	cloudy: { through: 0 },
	night: { through: 0 },
}, { through: { min: 0, max: 0.5 } } );

/** The share of the key a shaded leaf takes through the leaves over it (`LEAF_LIGHT`). */
export const leafThrough = uniform( 0 );

const keys = { through: 0 };

/** The leaves' light at the sun's `elevation` (degrees), the night's weight `night` and the
 * weather's cloud `clouded`. */
export function updateLeafLight( elevation: number, night: number, clouded: number ): void {

	keyed( LEAF_LIGHT, elevation, night, keys, clouded );
	leafThrough.value = keys.through;

}
