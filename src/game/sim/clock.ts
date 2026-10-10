// Game time: one tick is one game second, counted from the hour the game began at.

export interface ClockState { tick: number; startHour: number }

/** hour of day, 0..24 */
export function hourOf( s: ClockState ): number {

	return ( ( ( s.startHour + s.tick / 3600 ) % 24 ) + 24 ) % 24;

}

/** whole days since the game began (day 0 is the first) */
export function dayOf( s: ClockState ): number {

	return Math.floor( ( s.startHour + s.tick / 3600 ) / 24 );

}
