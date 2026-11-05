// Game time: one tick is one game second, counted from the hour the game began at. The day and the
// minute of the day are counted in whole seconds (the start hour to the second), never from the
// hour's fraction: ( 8 + 60 / 3600 ) * 60 is 480.99999999999994, so a third of the minutes' first
// seconds read as the minute before.

export interface ClockState { tick: number; startHour: number }

/** hour of day, 0..24 */
export function hourOf( s: ClockState ): number {

	return ( ( ( s.startHour + s.tick / 3600 ) % 24 ) + 24 ) % 24;

}

// game seconds since the midnight before the game began
function secondsOf( s: ClockState ): number {

	return Math.round( s.startHour * 3600 ) + s.tick;

}

/** whole days since the game began (day 0 is the first) */
export function dayOf( s: ClockState ): number {

	return Math.floor( secondsOf( s ) / 86400 );

}

/** the minute of the day, 0..1439 */
export function minuteOf( s: ClockState ): number {

	return ( ( Math.floor( secondsOf( s ) / 60 ) % 1440 ) + 1440 ) % 1440;

}
