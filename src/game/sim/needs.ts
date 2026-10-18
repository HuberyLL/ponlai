import { SECONDS_PER_GAME_DAY } from './types.ts';
import type { Needs } from './types.ts';

// An islander's needs: satiety and hydration, 0..100, falling every tick and raised by eating and
// drinking (items.ts). They clamp at 0 with no consequence yet (docs/game-design.md, "Next").
//
// Thirst is off until the island has a water source of its own: hydration holds where it starts
// (HYDRATION_PER_DAY is 0) and nothing raises it. The HUD still shows it.
//
// The rates come from the game's day, so a day of play has a person's rhythm: someone eats about
// every 12 hours. Satiety falls 72 a day (3 an hour) and a fish gives 36: one every 12 game hours,
// two a day. It runs from full to empty in a day and a third, so a missed meal shows in the numbers
// within hours but nothing is lost to one mistake. With thirst on, hydration fell 96 a day (4 an
// hour, a drink of 32 every 8 game hours), faster than hunger, as for a person.

export const NEED_MAX = 100;
/** 0: thirst is off (see the header); 96 with a water source */
export const HYDRATION_PER_DAY = 0;
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
