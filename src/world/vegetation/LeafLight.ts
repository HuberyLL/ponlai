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
// `back`: what a leaf sends on toward the viewer of the key on its far face, by that face's cosine
// (world/VegetationLighting.ts): a crown seen against the sun glows rather than turning black. One
// share at every height of the sun, and 0 under a closed sky and by night for the same reason as
// `through`, and so a clump's light by night stays on its near face.
//
// Read once a frame into uniforms (main.ts), so it is a function of the clock and the weather alone
// and a paused frame repeats. Tunable on debug pages (debug/Tune.ts):
// `lighting.vegetation.leaf.through@golden`, `@low`, `@high`, `@cloudy`, `@night`, and `back` alike.
export const LEAF_LIGHT: DayKeys<{ through: number; back: number }> = tuneKeys( 'lighting.vegetation.leaf', {
	day: [
		{ at: 3, name: 'golden', values: { through: 0, back: 0.8 } },
		{ at: 12, name: 'low', values: { through: 0.18, back: 0.8 } },
		{ at: 40, name: 'high', values: { through: 0.18, back: 0.8 } },
	],
	cloudy: { through: 0, back: 0 },
	night: { through: 0, back: 0 },
}, { through: { min: 0, max: 0.5 }, back: { min: 0, max: 1.5 } } );

/** The share of the key a shaded leaf takes through the leaves over it (`LEAF_LIGHT`). */
export const leafThrough = uniform( 0 );
/** The share of the key on a leaf's far face that comes through it (`LEAF_LIGHT`). */
export const leafBack = uniform( 0 );

const keys = { through: 0, back: 0 };

/** The leaves' light at the sun's `elevation` (degrees), the night's weight `night` and the
 * weather's cloud `clouded`. */
export function updateLeafLight( elevation: number, night: number, clouded: number ): void {

	keyed( LEAF_LIGHT, elevation, night, keys, clouded );
	leafThrough.value = keys.through;
	leafBack.value = keys.back;

}
