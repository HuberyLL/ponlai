import { SECONDS_PER_GAME_DAY } from './types.ts';
import type { Needs } from './types.ts';

// An islander's needs: satiety and hydration, 0..100, falling every tick and raised by eating and
// drinking (items.ts). They clamp at 0 with no consequence yet (docs/game-design.md, "Next").
// A need that falls to CRITICAL_NEED is an event (events.ts `need`), at the tick it crossed the
// line from above, which the record notes; it is noted again only once the need has risen above the
// line (eating raises it well past) and fallen back. The interface's alert is what is true now, a
// need at or below the line, and samples the numbers.
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
/** a need at or below this is critical: the interface raises its alert and the record notes it
 * (docs/ui.md, Islanders), and below LOW_NEED its bar turns toward the alert's colour */
export const CRITICAL_NEED = 20;
export const LOW_NEED = 50;
/** 0: thirst is off (see the header); 96 with a water source */
export const HYDRATION_PER_DAY = 0;
export const SATIETY_PER_DAY = 72;
/** a new islander's needs: fed and watered, not full */
export const START_NEEDS: Readonly<Needs> = { satiety: 80, hydration: 80 };

const HYDRATION_PER_TICK = HYDRATION_PER_DAY / SECONDS_PER_GAME_DAY;
const SATIETY_PER_TICK = SATIETY_PER_DAY / SECONDS_PER_GAME_DAY;

/** Whether a need went from above the critical line to on or below it. */
export function fellCritical( was: number, now: number ): boolean {

	return was > CRITICAL_NEED && now <= CRITICAL_NEED;

}

/** One game second of the needs falling; the needs that fell to the critical line, or null. */
export function fallNeeds( n: Needs ): ( keyof Needs )[] | null {

	const satiety = n.satiety, hydration = n.hydration;
	n.hydration = Math.max( 0, hydration - HYDRATION_PER_TICK );
	n.satiety = Math.max( 0, satiety - SATIETY_PER_TICK );
	let fell: ( keyof Needs )[] | null = null;
	if ( fellCritical( satiety, n.satiety ) ) ( fell ??= [] ).push( 'satiety' );
	if ( fellCritical( hydration, n.hydration ) ) ( fell ??= [] ).push( 'hydration' );
	return fell;

}

/** Raise a need by an amount, up to the full 100. */
export function raiseNeed( n: Needs, need: keyof Needs, amount: number ): void {

	n[ need ] = Math.min( NEED_MAX, n[ need ] + amount );

}
