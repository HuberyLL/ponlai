import { SECONDS_PER_GAME_DAY } from './types.ts';
import type { Needs } from './types.ts';

// An islander's needs: satiety and hydration, 0..100, falling every tick and raised by eating and
// drinking (items.ts). They clamp at 0 with no consequence yet (docs/game-design.md, "Next").
//
// The rates come from the game's day, so a day of play has a person's rhythm: someone drinks about
// every 8 hours and eats about every 12. Hydration falls 96 a day (4 an hour) and a coconut gives
// 32: one every 8 game hours holds it steady, three a day. Satiety falls 72 a day (3 an hour) and a
// fish gives 36: one every 12 game hours, two a day. Thirst comes faster than hunger, as for a
// person; either runs from full to empty in about a day and a day and a third, so a missed meal or
// drink shows in the numbers within hours but nothing is lost to one mistake.

export const NEED_MAX = 100;
export const HYDRATION_PER_DAY = 96;
export const SATIETY_PER_DAY = 72;
/** a new islander's needs: fed and watered, not full */
export const START_NEEDS: Readonly<Needs> = { satiety: 80, hydration: 80 };

const HYDRATION_PER_TICK = HYDRATION_PER_DAY / SECONDS_PER_GAME_DAY;
const SATIETY_PER_TICK = SATIETY_PER_DAY / SECONDS_PER_GAME_DAY;

/** One game second of the needs falling. */
export function fallNeeds( n: Needs ): void {

	n.hydration = Math.max( 0, n.hydration - HYDRATION_PER_TICK );
	n.satiety = Math.max( 0, n.satiety - SATIETY_PER_TICK );

}

/** Raise a need by an amount, up to the full 100. */
export function raiseNeed( n: Needs, need: keyof Needs, amount: number ): void {

	n[ need ] = Math.min( NEED_MAX, n[ need ] + amount );

}
