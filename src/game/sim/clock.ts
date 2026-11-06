// Game time: one tick is one game second, counted from the hour the game began at. The day and the
// minute of the day are counted in whole seconds (the start hour to the second), never from the
// hour's fraction: ( 8 + 60 / 3600 ) * 60 is 480.99999999999994, so a third of the minutes' first
// seconds read as the minute before.
//
// A time of day is derived from a tick here and nowhere else: what happened keeps its tick (the
// events, sim/events.ts; the record's entries), and the perception, the record's page and the play
// tool tell it as a day and a time with `timeOf` (and read one back with `tickAt`).

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

/** A tick told as the game tells it: the day counted from 1, and the time of day to the minute. */
export interface GameTime { day: number; hour: number; minute: number }

/** The game's time of a tick, for a game begun at `startHour`. */
export function timeOf( tick: number, startHour: number ): GameTime {

	const s = { tick, startHour }, minutes = minuteOf( s );
	return { day: dayOf( s ) + 1, hour: Math.floor( minutes / 60 ), minute: minutes % 60 };

}

/** The tick a day (counted from 1) and a minute of that day fall on, for a game begun at
 * `startHour`: `timeOf`'s inverse to the minute. */
export function tickAt( day: number, minuteOfDay: number, startHour: number ): number {

	return ( day - 1 ) * 86400 + minuteOfDay * 60 - Math.round( startHour * 3600 );

}

/** "HH:MM", a time of day as the record and the play tool write it. */
export function clockText( t: GameTime ): string {

	return `${ String( t.hour ).padStart( 2, '0' ) }:${ String( t.minute ).padStart( 2, '0' ) }`;

}
