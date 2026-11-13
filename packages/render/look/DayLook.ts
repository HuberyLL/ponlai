import { tuneObject } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';
import { readLook, type Span } from './Look.ts';

// The day's look tables, as the renderer reads them (look/Look.ts: the numbers are the installed
// look's, the neutral set's where none is): where the key turns from the sun to the moon, the
// dusk's windows, how deep under all of it each night layer comes in and the ease at the window's
// night end. sky/DayCycle.ts reads them for the night's shares; its header says how the day runs.
// The day's table also holds the exposure by the sun's elevation with the night sky's own
// exposure: those the exposure takes where it is created (look/ExposureLook.ts), not this module.

export type { Span };

const LOOK = readLook( 'day', 'look/DayLook.ts' );

// Highest elevation (degrees) at which the key may turn from the sun toward the moon.
export const HANDOFF_TOP = LOOK.handoffTop;
// Elevation (degrees) at which the moon's key starts to rise, in full two degrees lower: the
// handoff has just turned the key to the moon, so it turns through zero light (HANDOFF_TOP to here).
export const MOON_KEY_TOP = LOOK.moonKeyTop;
/** Where each of the dusk's shares comes in, the sun's elevation (degrees): [ whole, none ], all of
 * the share at or under the first, none at or over the second (`rampIn`, or `duskIn` by stops for
 * a clear evening's), the clear evening's and morning's and the clouded sky's apart. A clouded
 * sky's share is the clear one's moved toward the clouded one by the clouded share (Weather.ts
 * `cloudedShare`). `display` is the display's night (tone, grade, bloom), `exposure` the exposure's
 * own night weight, `stars` the drawn stars' clear evening (their morning and a clouded sky's are
 * the display's, `starNight`), `sky` the sky's night key, `ambient` the night's
 * ambient (and the leaves' night key and the sward's), `yunpeng` the yunpeng's glow and the local
 * lights, `cloudMoon` the clouds' own moonlight, `moonKey` the moon's key and its sky, `handoff`
 * the key's turn from the sun to the moon. A clouded sky's display and stars follow the daylight
 * instead (`fromDaylight`); its exposure takes its own window by elevation (`exposure.clouded`). */
export const DUSK_WINDOWS = {
	...LOOK.duskWindows,
	moonKey: [ MOON_KEY_TOP - 2, MOON_KEY_TOP ] as Span,
	handoff: [ MOON_KEY_TOP, HANDOFF_TOP ] as Span,
};
// the daylight's window in which a clouded sky's display and stars take the night (the
// snapshot's `daylight`): all of it under the first, none over the second
export const CLOUDED_DAYLIGHT: Span = LOOK.cloudedDaylight;
/** How deep under all of it (stops) each night layer comes in at the evening's window's day end,
 * rising by even stops a degree toward all of it at the window's night end (`duskIn`, which eases
 * the last DUSK_EASE degrees): the night key in the sky's light (`sky`), the night ambient and the
 * yunpeng's glow and light (`ambient`), the stars, the haze's night key and the clouds' own
 * moonlight. Tunable on debug pages (debug/Tune.ts): `sky.twilight.depth.<layer>`. */
export const DUSK_DEPTH = tuneObject( { ...LOOK.duskDepth }, {
	sky: 'sky.twilight.depth.sky', ambient: 'sky.twilight.depth.ambient',
	stars: 'sky.twilight.depth.stars', haze: 'sky.twilight.depth.haze', cloudMoon: 'sky.twilight.depth.cloudMoon',
}, ( () => {

	const options = { min: 1, max: 24, onChange: markSkyRetune };
	return { sky: options, ambient: options, stars: options, haze: options, cloudMoon: options };

} )() );
/** Over how many degrees at the night's end of the evening's window (DUSK_WINDOWS' evening windows)
 * its night layers ease into all of their light (`duskIn`). Tunable: `sky.twilight.ease`. */
export const DUSK_EASE = tuneObject( { degrees: LOOK.duskEase }, { degrees: 'sky.twilight.ease' }, { degrees: { min: 0, max: 4, onChange: markSkyRetune } } );
