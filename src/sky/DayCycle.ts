import { MathUtils, Matrix3, Quaternion, Vector3 } from 'three/webgpu';
import { tune, tuneObject } from '../debug/Tune.ts';
import { markSkyRetune } from './SkyRetune.ts';

// The day cycle: an equinox day at a fixed latitude, its stars a fixed real sky; the moon is
// placed, not orbited. One dominant key light (the sun by day, the moon by
// night) drives terrain, characters, water and every shadow map; a sun/moon handoff
// passes through zero direct light: the sun's key fades as its drawn disk sinks below the horizon,
// and only then turns toward the moon (HANDOFF_TOP; `keyDir` turns along the great circle from the
// sun to the moon). The sun is drawn at twice its true
// size and the moon larger (NightSky.ts `MOON_ANGULAR_RADIUS`); shadows and glints use the true sun. A low sun's key stays
// orange red: the optical depth that sets its hue is capped (and a high sun's key is a warm white
// of its own, taking the air's reddening only as the sun sinks), while its brightness still follows
// the full extinction (Sky.ts `keyHue`). The sky, sun, moon, stars, key light and grade follow
// the clock every frame. `reset` sets the clock as the constructor does (a scene jump).
//
// The reference exposure follows the sun's elevation (EXPOSURE_KEYS), set once under an
// earlier display chain: it only rises from afternoon into night. It does not set the frame's
// exposure, which the display chain meters from the light (post/Exposure.ts): it is the reference
// the night sky's own lights, the stars and the moon's disk, are tuned against (`nightSkyLevel`),
// and nothing they light reads it. So it follows the metered exposure: under the twilight it holds
// from -6 to -7 degrees, and below it climbs with the meter as the night falls to the moon's light,
// NIGHT_METER_LIFT stops by about -12 degrees, so the stars and the disk keep their display.
// The night ambient rises as the sun's skylight fades after sunset, and the moon's key comes in
// once the handoff has turned it (MOON_KEY_TOP), so twilight is never darker than the
// night; the night sky's own light (stars, the moon's disk and its in-scatter in the
// sky, clouds) scales back to keep its tuned look in deep night (Sky.track). The night is
// art-directed, not a simulation of the eye's night vision (docs/art-direction.md).
// A clear twilight is not yet the night, on either side of it. After a clear sunset the glow
// holds low in the west under a blue sky for a long while, falling slowly to about -9 degrees,
// and long before a clear sunrise the air is blue and the sea a clear blue under it, lit by the
// sun's own light on the high air. So under a clear or fair sky the display's night weight
// (`displayNight`), the sky's and the probes' night key (`skyNight`), the night's ambient and the
// yunpeng's light (`nightAmbientShare`, which would glow at their brightest under a day's
// exposure) and the moon's key
// (`twilightMoon`, which would lay a blue floor over the sea under a day's exposure) come in only
// from -7 to -11 degrees after sunset, and the rising sun takes them away early, from about -12
// degrees. The evening's window ends where the atmosphere's own twilight does: the sun's light on
// the high air above about 10 degrees falls by three orders of magnitude from -7 to -9 (its table
// lights the multiple scattering only where the sun reaches), and a night that came in only from
// -11 to -14 left the upper sky black at -9 to -11 under a day's exposure. The night's layers
// light the scene far brighter than the twilight they follow (art-directed: the moon's key alone
// is 9.2 stops over the land's own light at -7), so through the evening's window each layer of
// light comes in by stops (`duskIn`: the stars, the moonlit sky and the haze's and the clouds' own
// moonlight too), from some stops under the twilight's own light it adds to (DUSK_DEPTH) to all of
// it at -11, easing into it over the last three degrees (DUSK_EASE); the display's night weight,
// which keys the exposure to that light, keeps an even fade. Faded evenly in light from -7, the
// night's layers raised the land's light 2.5 stops in the first half degree: the land rose by 0.05
// in Oklab L and the exposure fell 2.2 stops from -7 to -7.5 degrees, where the steps before it rose
// 0.9. By stops, the clear evening's exposure turns at -7.5, falls 1.6 to 2.1 stops each half degree
// from -8 to -10 and lands at -11 by 1.4 and 0.5, no step on the land rises by more than 0.01 in L,
// and the sky's falls to the night's without turning. The clouded share keeps
// the daylight's timing (the display's night whole by about -2.5 degrees, the sky's by -6), and a
// side's flip at noon or midnight moves nothing: every weight here is 0 by day and 1 by night on
// both sides.
//
// The moon is fixed in the sky (MOON, `moonDirection`): 20 degrees up on the noon meridian unless
// set, where it stands all night, every night. The default island view's sea carries its path, and
// its light comes in at a slant, so slopes have a lit and a shaded side and the moon's shadows run
// long; it neither rises nor sets, so the night's composition holds while the game is played. It is the
// night's one cool key: lighting/KeyLift.ts shades from its direction for as long as it is the
// key, so the night keeps one shading and one level; the moon is drawn there, the sky's and the
// haze's moonlight come from there, and the key's direction turns there over the handoff, along
// the great circle from the sun, and holds there all night. It shows as the sun's light leaves:
// its visibility (and so the key's moonlight) rises over the sun's first five degrees under the
// horizon.
// The phase (a full moon unless set) shapes only the drawn moon: its disk is lit from the phase's
// angle round from the moon's own direction toward the west (`moonSunDir`: from behind it at a new
// moon, from the west at the first quarter, from the front at the full), and nothing else follows
// it (the key, the night sky's moonlit wash, the clouds' moonlight), so advancing it never darkens a
// night.

export type DayPreset = keyof typeof DAY_PRESETS;

export interface DayCycleOptions {
	hour?: number;
	dayLength?: number;
	paused?: boolean;
	moonPhase?: number;
	advanceMoonPhase?: boolean;
	lunarPeriodDays?: number;
}

export interface DayCycleSnapshot {
	hour: number;
	day: number;
	sunDir: Vector3;
	moonDir: Vector3;
	// the direction the drawn disk is lit from at the phase
	moonSunDir: Vector3;
	// the key's direction: the sun's, turned toward the moon's along the great circle between them
	// over the handoff
	keyDir: Vector3;
	// how far the key has turned from the sun toward the moon, 0 to 1
	handoff: number;
	elevation: number;
	azimuth: number;
	moonElevation: number;
	moonAzimuth: number;
	moonPhase: number;
	moonIllumination: number;
	moonVisibility: number;
	moonKeyGain: number;
	// World to equatorial (J2000) frame: x toward right ascension 0h, z toward the north
	// celestial pole. The same at every hour and day (STARS).
	starFrame: Matrix3;
	daylight: number;
	// The stars and the Milky Way: they come out late, as the sky darkens.
	nightVisibility: number;
	exposure: number;
	// Further exposure, as a fraction, under a fully closed deck after dark (see Sky.track).
	overcastAdaptation: number;
	// Scale on the night sky's own light (stars, the moon's disk and its in-scatter in the sky,
	// clouds): it was tuned at a night exposure of NIGHT_SKY_EXPOSURE and keeps that look, brighter
	// by NIGHT_EXPOSURE_GAIN, whatever the frame's exposure.
	nightSkyLevel: number;
}

const TAU = 2 * Math.PI;
const DEG = 180 / Math.PI;
/** The sun's elevation at noon (degrees): its path is tilted this far from the horizon. */
export const NOON_ELEVATION = 52;
const INCLINATION = NOON_ELEVATION / DEG;
const SIN_INCLINATION = Math.sin( INCLINATION );
const COS_INCLINATION = Math.cos( INCLINATION );
// The noon meridian's azimuth in the world (radians, about 66.8 degrees), fixed whatever the
// path's tilt: the default island view looks 23 degrees east of it.
const NOON_AZIMUTH = 1.166480189932717;
const SIN_NOON_AZIMUTH = Math.sin( NOON_AZIMUTH );
const COS_NOON_AZIMUTH = Math.cos( NOON_AZIMUTH );
// direction(a) = cos(a) N + sin(a) WEST, N the noon sun ( COS_INCLINATION COS_NOON_AZIMUTH,
// SIN_INCLINATION, COS_INCLINATION SIN_NOON_AZIMUTH ): a rotation by a about N x WEST.
// The sun stands at the celestial equator (an equinox, every day): at noon it marks where the
// equator crosses the meridian and at 18:00 the west point. Its path is tilted NOON_ELEVATION
// degrees from the horizon, so its elevated pole stands 90 - NOON_ELEVATION degrees up; seen from
// above, the sun turns anticlockwise, so that pole is the south celestial pole. A 52 degree noon is
// a mid-latitude equinox's daylight: high enough to read as a bright day, low enough that slopes
// keep a lit and a shaded side from the island view, which looks 50 degrees down. Near the horizon
// the sun climbs or sinks 11.8 degrees an hour, so the low sun lingers: 3.4 hours a day under 20
// degrees and 1.7 under 10, about a tenth longer than under a 62 degree noon. A noon that high is a
// subtropical light, at odds with the island's temperate bamboo and meadow.
const WEST = new Vector3( SIN_NOON_AZIMUTH, 0, - COS_NOON_AZIMUTH );
/** The sun's elevation (degrees) at `hour` on its path. */
export function sunElevationAt( hour: number ): number {

	return Math.asin( SIN_INCLINATION * Math.cos( ( hour - 12 ) / 24 * TAU ) ) * DEG;

}
// the hour angle (hours from noon, 0 to 12) at which the sun stands at `elevation` (degrees)
function hoursFromNoon( elevation: number ): number {

	finite( elevation, 'elevation' );
	if ( Math.abs( elevation ) > NOON_ELEVATION ) throw new RangeError( `elevation must lie within ${ NOON_ELEVATION } degrees of the horizon` );
	const c = Math.max( - 1, Math.min( 1, Math.sin( elevation / DEG ) / SIN_INCLINATION ) );
	return Math.acos( c ) / TAU * 24;

}
/** The hour (0 to 12) at which the morning sun stands at `elevation` (degrees): the inverse of
 * `sunElevationAt` before noon. */
export function morningHour( elevation: number ): number {

	return 12 - hoursFromNoon( elevation );

}
/** The hour (12 to 24) at which the evening sun stands at `elevation` (degrees): the inverse of
 * `sunElevationAt` after noon. */
export function eveningHour( elevation: number ): number {

	return 12 + hoursFromNoon( elevation );

}
/** The day's presets (hours): each the hour its sun stands at its elevation, the morning's or the
 * evening's, so a preset keeps its light whatever the path's tilt (dawn and dusk 8.6 degrees under
 * the horizon, sunrise and sunset 2 up, the golden hour 26.2 up in the afternoon); noon and
 * midnight are 12 and 0. The clock starts at the golden hour. */
export const DAY_PRESETS = {
	'dawn': morningHour( - 8.6 ),
	'sunrise': morningHour( 2 ),
	'noon': 12,
	'golden-hour': eveningHour( 26.2 ),
	'sunset': eveningHour( 2 ),
	'dusk': eveningHour( - 8.6 ),
	'midnight': 0,
} as const;
/** Whether the sun at `dir` (unit, on its path) is rising: east of the meridian, before noon (the
 * haze's keys tell the morning from the evening by it: weather/HazeKeys.ts). */
export const sunRising = ( dir: Readonly<Vector3> ): boolean => dir.dot( WEST ) < 0;
// where a clear twilight's display holds the night, its sky's and its probes' light the night key,
// and its moon's key, the sun's elevation (degrees), the morning's and the evening's: all of the
// night under the first of each pair, none over the second (the header)
const DAWN_NIGHT = [ - 12, - 7 ] as const;
const DAWN_SKY = [ - 13, - 3 ] as const;
const DAWN_MOON = [ - 13, - 7 ] as const;
const DUSK_NIGHT = [ - 11, - 7 ] as const;
const DUSK_SKY = [ - 11, - 7 ] as const;
const DUSK_MOON = [ - 11, - 7 ] as const;
// what is left of the moon's key at the day's end of the morning's window
const MOON_LEFT = 1 / 128;
/** How deep under all of it (stops) each night layer comes in at the evening's window's day end
 * (-7 degrees), rising by even stops a degree toward all of it at -11 (`duskIn`, which eases the
 * last DUSK_EASE degrees; the header). Each starts under the twilight's own light it adds to: the
 * depth is that layer's full light over the twilight's at -7 (measured, in the comments) and about
 * five stops more. The moon's two were set on the clear evening's sweep (every half degree, island
 * and horizon views) by even stops all the way to -11, where each layer came in fastest, an eighth
 * of its depth each half degree: the key from 14.2 raised the land's L 0.010 from -10.5 to -11,
 * from 13.5 0.008 there and 0.004 where it comes in (-7.5); the moonlit sky from deeper than 8.25
 * came in late enough to brighten the sky toward -11 (0.015 in L from the key's depth), and from
 * 6.75 it took the meter up early and the land rose 0.012 at -11. */
export const DUSK_DEPTH = tuneObject( {
	// the moon's key on the land: all of it is 9.2 stops over the land's own light at -7
	moon: 13.75,
	// the moon's light in the sky (the moonlit atmosphere, which the haze and the clouds take as
	// their sky light: Sky.ts): 1.75 stops over the sky's light at -7
	moonSky: 8.25,
	// the night key in the sky's and the probes' light (`skyNight`): 1.35 over the land's
	sky: 6.25,
	// the night ambient and the yunpeng's glow and light (`nightAmbientShare`): 3.1 over the land's
	ambient: 8,
	// the stars (`starNight`): 2.3 over the sky's
	stars: 7.25,
	// the haze's night key (weather/HazeKeys.ts): 1.8 over the sky's
	haze: 6.75,
	// the clouds' own moonlight (Sky.ts CLOUD_MOON_DUSK): 3.9 over the sky's
	cloudMoon: 9,
}, {
	moon: 'sky.twilight.depth.moon', moonSky: 'sky.twilight.depth.moonSky', sky: 'sky.twilight.depth.sky', ambient: 'sky.twilight.depth.ambient',
	stars: 'sky.twilight.depth.stars', haze: 'sky.twilight.depth.haze', cloudMoon: 'sky.twilight.depth.cloudMoon',
}, ( () => {

	const options = { min: 1, max: 24, onChange: markSkyRetune };
	return { moon: options, moonSky: options, sky: options, ambient: options, stars: options, haze: options, cloudMoon: options };

} )() );
/** Over how many degrees at the night's end of the evening's window (DUSK_NIGHT, DUSK_SKY,
 * DUSK_MOON) its night layers ease into all of their light (`duskIn`). By even stops to the end,
 * each came in fastest at -11 degrees, an eighth of its depth in the last half degree, and stopped
 * there: the clear evening's exposure over the horizon fell 1.5 stops a half degree into -11 and
 * not at all after it, and in that last step the sky over the horizon turned up by 0.005 to 0.007
 * in Oklab L and the sea under it by 0.016. Eased over three degrees the exposure's last steps
 * there are 1.8, 1.3 and 0.5 stops (the ones before them steeper, 2.1 at most), the sky turns by
 * about 0.001, the sea's rise to the night's level is spread over three steps (0.008 at most), and
 * the window's day end, where the depths are set, is as it was (every frame above -8 degrees
 * unchanged); over two the last step was still 0.7 stops and the sea rose 0.0125 in one, over four
 * the day end moved. */
export const DUSK_EASE = tuneObject( { degrees: 3 }, { degrees: 'sky.twilight.ease' }, { degrees: { min: 0, max: 4, onChange: markSkyRetune } } );
// how far the sun has come through a twilight's window (degrees: 0 at `from`, 1 at `to`)
function across( elevation: number, [ from, to ]: readonly [ number, number ] ): number {

	return MathUtils.clamp( ( elevation - from ) / ( to - from ), 0, 1 );

}
// a night layer's share at `t` through its twilight's window (`across`: all of it at 0, none at 1),
// a clear sky's rising by even stops from `least` of all of it at 1, under a clouded share `cloud`
// all of it
function inStops( t: number, least: number, cloud = 0 ): number {

	const left = least ** t;
	return cloud + ( 1 - cloud ) * ( left - least ) / ( 1 - least );

}
/** A night layer's share through the evening's `window` (degrees: all of it under the first, none
 * over the second), coming in from `depth` stops under all of it (DUSK_DEPTH), under a clouded
 * share `cloud` all of it: exactly none and all at the window's ends, as the smoothstep it
 * replaced, and over the night end's DUSK_EASE degrees its rate falls to none (a cubic in the
 * window's place there, whose slope is the even stops' where it starts). */
export function duskIn( elevation: number, window: readonly [ number, number ], depth: number, cloud = 0 ): number {

	const t = across( elevation, window );
	const ease = Math.min( DUSK_EASE.degrees / ( window[ 1 ] - window[ 0 ] ), 1 );
	const x = t < ease ? t / ease : 1;
	return inStops( t < ease ? ease * x * x * ( 2 - x ) : t, 2 ** - depth, cloud );

}
/** The display's night weight (the exposure's keys, Pipeline NIGHT, the flying fish), at
 * `daylight` (the snapshot's) and the sun's `elevation` (degrees), `rising` or setting, under a
 * clouded share `cloud` (Weather.ts `cloudedShare`). Under cloud none through the afterglow, all of
 * it once the daylight has gone; a clear sky's comes in from -7 to -11 degrees after sunset and
 * leaves from -12 to -7 before sunrise (the header), evenly (a smoothstep) on both sides: it keys
 * the exposure to the light, and by stops it lagged the night's light through the evening's
 * window, the land rising by 0.06 in Oklab L. */
export function displayNight( daylight: number, elevation: number, rising: boolean, cloud: number ): number {

	const night = 1 - smoothstep( 0.2, 0.45, daylight );
	const [ from, to ] = rising ? DAWN_NIGHT : DUSK_NIGHT;
	const dawn = 1 - smoothstep( from, to, elevation );
	return dawn + ( night - dawn ) * cloud;

}
/** The stars' share (Sky.ts `starVisibility`): the display's night (`displayNight`), but the
 * evening's clear share by stops (DUSK_DEPTH.stars), as the stars are light the meter reads. */
export function starNight( daylight: number, elevation: number, rising: boolean, cloud: number ): number {

	if ( rising ) return displayNight( daylight, elevation, rising, cloud );
	const night = 1 - smoothstep( 0.2, 0.45, daylight );
	const dusk = duskIn( elevation, DUSK_NIGHT, DUSK_DEPTH.stars );
	return dusk + ( night - dusk ) * cloud;

}
/** The night key's share in the sky's light and the probes' (Sky.ts SKY_LIGHT, AmbientRelight.ts
 * PROBE_SKY), at the sun's `elevation` (degrees), `rising` or setting, under a clouded share
 * `cloud`: under cloud none from 2 degrees up, all of it by -6; a clear sky's comes in from -7 to
 * -11 degrees after sunset by stops (DUSK_DEPTH.sky) and leaves from -13 to -3 before sunrise (the
 * header). A debug page can force it (`duskForce`). */
export function skyNight( elevation: number, rising: boolean, cloud: number ): number {

	const night = 1 - smoothstep( - 6, 2, elevation );
	const dawn = rising ? 1 - smoothstep( DAWN_SKY[ 0 ], DAWN_SKY[ 1 ], elevation ) : duskIn( elevation, DUSK_SKY, DUSK_DEPTH.sky );
	return duskForce( 'skyNight', dawn + ( night - dawn ) * cloud );

}
/** The share of the moon's key (the snapshot's `moonKeyGain`) through a clear twilight (the
 * header): none until the sun is at -7 degrees after sunset, all of it by -11; all of it until -13
 * before sunrise, none by -7; all of it under cloud. It moves by even stops a degree, because the
 * meter reads it in stops (a fade even in light keeps most of its stops for its last moments, and
 * the picture's exposure leapt there, in seconds of a real dawn), and it starts under the land's
 * own light: in the morning from MOON_LEFT, seven stops down, in the evening from DUSK_DEPTH.moon,
 * 13.75, all of it being 9.2 stops over the land's light at -7. From seven stops down the evening's
 * key put about four times the land's light on it in the first half degree, two thirds of a step
 * that raised the land by 0.05 in Oklab L and took the exposure 2.2 stops down. */
export function twilightMoon( elevation: number, rising: boolean, cloud: number ): number {

	return rising ? inStops( across( elevation, DAWN_MOON ), MOON_LEFT, cloud ) : duskIn( elevation, DUSK_MOON, DUSK_DEPTH.moon, cloud );

}
/** The share of the moon's light in the sky (Sky.ts: the moonlit atmosphere, which the haze and the
 * clouds take as their sky light): `twilightMoon`'s, but the evening's from DUSK_DEPTH.moonSky, all
 * of it being only 1.75 stops over the sky's own light at -7. From the key's depth the moonlit sky
 * came in so late that the low sky brightened toward -11, by 0.015 in L. */
export function twilightMoonSky( elevation: number, rising: boolean, cloud: number ): number {

	return rising ? twilightMoon( elevation, rising, cloud ) : duskIn( elevation, DUSK_MOON, DUSK_DEPTH.moonSky, cloud );

}
/** The stars' sky: a real sky, the one seen from `latitude` degrees south at the local sidereal
 * time `sidereal` (hours), fixed. It neither turns through the night nor drifts over the year, so
 * the night's composition holds while the game is played, and its constellations stand upright as
 * seen from that latitude. 38 degrees south at 14h raises the Milky Way out of the sea in the
 * horizon view, split by the Great Rift, up to its core 43 degrees high in the east below Scorpius,
 * with Crux and Alpha Centauri high in the south, and sets the moon (MOON) on a dark part of the
 * sky, 81 degrees from the core, with no star brighter than the second magnitude within 8 degrees
 * of it. 38 degrees south is the latitude we set the island at: the stars' sky and the sun's path
 * (NOON_ELEVATION, 90 less it) share one pole, 38 degrees up on the side away from noon. Tunable on
 * debug pages (debug/Tune.ts): `sky.stars.latitude`, `sky.stars.sidereal`. */
export const STARS = tuneObject( { latitude: 38, sidereal: 14 }, { latitude: 'sky.stars.latitude', sidereal: 'sky.stars.sidereal' }, {
	latitude: { min: 0, max: 90, onChange: placeStars },
	sidereal: { min: 0, max: 24, onChange: placeStars },
} );
/** Where the moon stands (the header): `elevation` degrees up, at the noon meridian's azimuth
 * turned `turn` degrees (0 the noon side, 180 the pole's side, positive toward the west). At least
 * 15 degrees up: from there down the low key's floor (lighting/KeyLift.ts) would hold the shading
 * up to the end of the handoff, a small turn at no light. Tunable on debug pages (debug/Tune.ts):
 * `sky.moon.elevation`, `sky.moon.turn`. */
export const MOON = tuneObject( { elevation: 20, turn: 0 }, { elevation: 'sky.moon.elevation', turn: 'sky.moon.turn' }, {
	elevation: { min: 15, max: 40, onChange: markSkyRetune },
	turn: { min: - 180, max: 180, onChange: markSkyRetune },
} );
// The exposure by the sun's elevation (degrees): [ elevation, exposure ], interpolated in log
// exposure and held beyond the ends. With the sun up, tidewater's auto exposure brings its frames to
// one metered level (its meter's centre-weighted log average: about 0.15 of its curve's input by day,
// falling through the low sun to about 0.03 at the horizon), and these bring the island views
// (toward and away from the sun, clear weather, the log mean of the two) to the same level at the
// same sun heights. After sunset tidewater's frame falls to near black, lit by its village; the
// twilight here keeps the brightness the island showed under the earlier grade (25 from -6 to -7
// degrees). Below -7 degrees the keys follow the metered exposure down to the night: each is 25
// times 2 to the stops the clear evening's island view meters at that height above its meter under
// the night these keys were first set for (log interpolated between them: within about half a stop of the
// metered curve), the full NIGHT_METER_LIFT by -12 degrees (NIGHT_EXPOSURE).
const TWILIGHT_EXPOSURE = 25;
const nightKey = ( elevation: number, stops: number ) => [ elevation, TWILIGHT_EXPOSURE * 2 ** stops ] as const;
/** The stops a clear night's metered exposure lies above the twilight's reference (25): the
 * moon's light at its magnitude against the sun's. The yunpeng's glow and every local light are
 * scaled by 2 to minus this, so a lamp keeps its display at night whatever the hour. */
export const NIGHT_METER_LIFT = 10.7;
const EXPOSURE_KEYS: readonly ( readonly [ number, number ] )[] = [
	nightKey( - 12, NIGHT_METER_LIFT ), nightKey( - 11, 10.6 ), nightKey( - 10, 10 ), nightKey( - 9, 6.8 ), nightKey( - 8, 2.1 ),
	[ - 7, TWILIGHT_EXPOSURE ], [ - 6, TWILIGHT_EXPOSURE ], [ - 2.65, 19 ], [ 0, 11 ], [ 2, 10 ], [ 6.6, 5.5 ], [ 13.2, 3.4 ], [ 16.5, 2.85 ],
	[ 19.75, 2.4 ], [ 26.2, 1.82 ], [ 32.5, 1.48 ], [ 50, 1.19 ],
];
export const NIGHT_EXPOSURE = EXPOSURE_KEYS[ 0 ][ 1 ];
export const DAY_EXPOSURE = EXPOSURE_KEYS[ EXPOSURE_KEYS.length - 1 ][ 1 ];
export function exposureAt( elevation: number ): number {

	const keys = EXPOSURE_KEYS;
	if ( elevation <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ];
	for ( let i = 1; i < keys.length; i ++ ) {

		const [ e1, x1 ] = keys[ i ];
		if ( elevation > e1 ) continue;
		const [ e0, x0 ] = keys[ i - 1 ];
		return x0 * Math.pow( x1 / x0, ( elevation - e0 ) / ( e1 - e0 ) );

	}
	return DAY_EXPOSURE;

}
// The night sky's own light (stars, the moon and its in-scatter, clouds) was tuned at NIGHT_SKY_EXPOSURE, with the
// night's own gain over it (NIGHT_EXPOSURE_GAIN) and the blue hour's adaptation, and keeps that
// displayed brightness whatever the frame's exposure (see Sky.track).
export const NIGHT_EXPOSURE_GAIN = 1.25;
export const NIGHT_SKY_EXPOSURE = 4.4;
// A closed deck after dark: the eye adapts further so a rainy dusk or night stays readable, still
// darker than a clear moonlit night: three times the clear night's exposure, as it was tuned.
const DECK_NIGHT_GAIN = 3;
// Highest elevation (degrees) at which the key may turn from the sun toward the moon: below the
// end of the sun's fade as its disk sinks into the sea (Radiometry.ts SUN_SETTING_RADIUS,
// Atmosphere.sunlightAt).
const HANDOFF_TOP = - 0.7;
// Elevation (degrees) at which the moon's key starts to rise, in full two degrees lower: the
// handoff has just turned the key to the moon, so it turns through zero light (HANDOFF_TOP to here).
const MOON_KEY_TOP = - 2.5;

/** The moon's share of the key at a sun elevation (degrees), before its visibility (the snapshot's
 * `moonKeyGain`): none above MOON_KEY_TOP, whole two degrees lower. */
export function moonKeyShare( elevation: number ): number {

	return 1 - smoothstep( MOON_KEY_TOP - 2, MOON_KEY_TOP, elevation );

}

/** The night's ambient share at a sun elevation (degrees): the sun's scattered skylight falls about
 * tenfold between the horizon and -4 degrees, and the night's ambient rises across the same band so
 * the two together never dip. The yunpeng's glow and light follow it too (world/Yunpeng.ts). */
export function nightAmbientAt( elevation: number ): number {

	return 1 - smoothstep( - 5, 1, elevation );

}
/** The night ambient's share under a clouded share `cloud` (the night sky's ambient in the
 * clouds and the sea, the yunpeng's glow and light, the leaves' night key, and the night that
 * takes the sward's tint under cloud away, materials/SwardTint.ts): under cloud
 * `nightAmbientAt`'s, a clear sky's in from -7 to -11 degrees after sunset by stops
 * (DUSK_DEPTH.ambient) and out from -12 to -7 before sunrise with the display's night
 * (`displayNight`). Through a clear twilight the frame
 * keeps a day's exposure, five stops over the night's at -7 degrees: the clumps lit by -5 then
 * glowed brightest in the twilight and dimmed as the night came in. */
export function nightAmbientShare( elevation: number, rising: boolean, cloud: number ): number {

	const clear = rising ? 1 - smoothstep( DAWN_NIGHT[ 0 ], DAWN_NIGHT[ 1 ], elevation ) : duskIn( elevation, DUSK_NIGHT, DUSK_DEPTH.ambient );
	return clear + ( nightAmbientAt( elevation ) - clear ) * cloud;

}

/** The dusk's shares a script can force on a debug page, to take the light of the twilight and of
 * the night apart (tools/dusk-grid.mjs `--split`, `--night-split`), in the order that tool puts them
 * back one at a time. The night's: `moonKey`, the moon's share of the key (Sky.ts `moonGain`);
 * `moonSky`, of the moonlit sky (Sky.ts `moonSkyShare`, which the probes' sky gain mixes its moon's
 * part by: lighting/AmbientRelight.ts); `skyNight`, the sky's twilight night key and the sea's
 * bounce's (`skyNight`); `nightAmbient`, the night's ambient in the sky, the clouds and the sea, the leaves'
 * night key and the sward's (`nightAmbientShare`); `landNight`, the moon's share of the land's gain
 * under overcast's deck (lighting/AmbientRelight.ts `underDeck`); `hazeNight`, the night key's
 * weight in the haze's (weather/HazeKeys.ts `keyAlong`); `cloudMoon`, the clouds' moonlight (Sky.ts
 * `moonShare`); `deck`, the deck's light in the haze (HazeKeys.ts `deck`); `exposureNight`, the
 * night weight the exposure's keys take, and `displayNight`, the one the tone, the grade and the
 * bloom take (post/Pipeline.ts `updateDisplay`); `yunpeng`, the yunpeng's glow and its lights'
 * share, and `localLights`, the local lights' strength (main.ts); `stars`, the stars' share in the
 * drawn sky (Sky.ts `starVisibility`: `nightVisibility` times `starNight`; no bake holds them, so
 * the land takes none of their light). The twilight's, each a weight on
 * the sun's light (1 when not forced): `sun`, the sun's part of the key (Sky.ts `keyColor`);
 * `hazeSun`, the haze's sunlight; `hazeSky`, the haze's skylight from the sun's sky
 * (weather/VolumetricHaze.ts). */
export const DUSK_FORCES = [ 'moonKey', 'moonSky', 'skyNight', 'nightAmbient', 'landNight', 'hazeNight', 'cloudMoon', 'deck', 'exposureNight', 'displayNight', 'yunpeng', 'localLights', 'stars', 'sun', 'hazeSun', 'hazeSky' ] as const;
export type DuskForce = typeof DUSK_FORCES[ number ];
// `sky.dusk.force.<name>` (debug/Tune.ts): -1, the default, leaves the share as the code makes it,
// 0 to 1 forces it to that value; the sky is baked again on a change
const duskForces = Object.fromEntries( DUSK_FORCES.map( ( name ) => [ name, tune( `sky.dusk.force.${ name }`, - 1, { min: - 1, max: 1, onChange: markSkyRetune } ) ] ) ) as Record<DuskForce, () => number>;

/** The value the share `name` is forced to on a debug page (DUSK_FORCES), or null when it is not. */
export function duskForced( name: DuskForce ): number | null {

	const value = duskForces[ name ]();
	return value < 0 ? null : value;

}

/** The values each share took as the code made it, forced or not, since a script last cleared the
 * map: [ least, greatest ] over every call (a share some frames or readers take at other values
 * shows the range). tools/dusk-grid.mjs reads it to report the shares and to skip forcing a share
 * to the value it already has. `hazeNight` has no value of its own here (`duskForced`). */
export const duskShares = new Map<DuskForce, [ number, number ]>();

/** The share `name` (DUSK_FORCES): `value` itself unless it is forced. */
export function duskForce( name: DuskForce, value: number ): number {

	const range = duskShares.get( name );
	if ( range === undefined ) duskShares.set( name, [ value, value ] );
	else {

		range[ 0 ] = Math.min( range[ 0 ], value );
		range[ 1 ] = Math.max( range[ 1 ], value );

	}
	return duskForced( name ) ?? value;

}

function finite( value: number, name: string ): number {

	if ( ! Number.isFinite( value ) ) throw new RangeError( `${ name } must be finite` );
	return value;

}

function positive( value: number, name: string ): number {

	finite( value, name );
	if ( value <= 0 ) throw new RangeError( `${ name } must be greater than zero` );
	return value;

}

function wrap( value: number, period: number ): number {

	return ( value % period + period ) % period;

}

function smoothstep( low: number, high: number, value: number ): number {

	const t = Math.max( 0, Math.min( 1, ( value - low ) / ( high - low ) ) );
	return t * t * ( 3 - 2 * t );

}

// World to equatorial frame of STARS' sky: a star at right ascension a and declination d lies at
// hour angle H = (sidereal - a), cos(H) meridian + sin(H) WEST, raised by d toward the north pole;
// the meridian point is where the equator crosses the noon meridian, 90 - latitude degrees up.
function equatorialFrame(): Matrix3 {

	const elevation = ( 90 - STARS.latitude ) / DEG;
	const meridian = new Vector3( Math.cos( elevation ) * COS_NOON_AZIMUTH, Math.sin( elevation ), Math.cos( elevation ) * SIN_NOON_AZIMUTH );
	const pole = WEST.clone().cross( meridian ).normalize();
	const sidereal = STARS.sidereal / 24 * TAU;
	const c = Math.cos( sidereal ), s = Math.sin( sidereal );
	const x = meridian.clone().multiplyScalar( c ).addScaledVector( WEST, s );
	const y = meridian.clone().multiplyScalar( s ).addScaledVector( WEST, - c );
	return new Matrix3().set( x.x, x.y, x.z, y.x, y.y, y.z, pole.x, pole.y, pole.z );

}

// the stars' frame, worked out at load and again when STARS changes
let starFrame = equatorialFrame();
function placeStars(): void {

	starFrame = equatorialFrame();
	markSkyRetune();

}

function direction( angle: number ): Vector3 {

	const c = Math.cos( angle ), s = Math.sin( angle );
	return new Vector3(
		COS_INCLINATION * c * COS_NOON_AZIMUTH + s * SIN_NOON_AZIMUTH,
		SIN_INCLINATION * c,
		COS_INCLINATION * c * SIN_NOON_AZIMUTH - s * COS_NOON_AZIMUTH,
	).normalize();

}

/** The moon's fixed direction (unit, world: MOON's elevation and azimuth), into `target`. The low
 * key's lift (lighting/KeyLift.ts) reads it at every publish of the lighting. */
export function moonDirection( target: Vector3 ): Vector3 {

	const azimuth = NOON_AZIMUTH - MOON.turn / DEG, e = MathUtils.degToRad( MOON.elevation );
	return target.set( Math.cos( e ) * Math.cos( azimuth ), Math.sin( e ), Math.cos( e ) * Math.sin( azimuth ) );

}
const _noTurn = new Quaternion(), _turn = new Quaternion(), _keyTurn = new Quaternion();

/** A deterministic art-directed celestial clock. Hours and moon phase are independent of the
 * wave/vegetation animation clock, so lighting presets do not jump existing scene animation. */
export class DayCycle {

	paused: boolean;
	advanceMoonPhase: boolean;
	private currentHour: number = DAY_PRESETS[ 'golden-hour' ];
	private secondsPerDay = 2880;
	private phase = 0.5;
	private lunarDays = 29.53;
	private completedDays = 0;

	constructor( options: DayCycleOptions = {} ) {

		this.paused = false;
		this.advanceMoonPhase = false;
		this.reset( options );

	}

	/** The clock as the constructor sets it from `options` (a scene jump: no days completed). */
	reset( options: DayCycleOptions = {} ): void {

		this.hour = options.hour ?? DAY_PRESETS[ 'golden-hour' ];
		this.dayLength = options.dayLength ?? 2880;
		this.moonPhase = options.moonPhase ?? 0.5;
		this.lunarPeriodDays = options.lunarPeriodDays ?? 29.53;
		this.paused = options.paused ?? false;
		this.advanceMoonPhase = options.advanceMoonPhase ?? false;
		this.completedDays = 0;

	}

	get hour(): number { return this.currentHour; }
	set hour( value: number ) { this.currentHour = wrap( finite( value, 'hour' ), 24 ); }
	get dayLength(): number { return this.secondsPerDay; }
	set dayLength( value: number ) { this.secondsPerDay = positive( value, 'dayLength' ); }
	get moonPhase(): number { return this.phase; }
	set moonPhase( value: number ) { this.phase = wrap( finite( value, 'moonPhase' ), 1 ); }
	get lunarPeriodDays(): number { return this.lunarDays; }
	set lunarPeriodDays( value: number ) { this.lunarDays = positive( value, 'lunarPeriodDays' ); }
	get day(): number { return this.completedDays; }

	setHour( hour: number ): void { this.hour = hour; }

	setPreset( preset: DayPreset ): void {

		if ( ! Object.hasOwn( DAY_PRESETS, preset ) ) throw new RangeError( `Unknown day preset: ${ preset }` );
		this.hour = DAY_PRESETS[ preset ];

	}

	advance( dt: number ): void {

		finite( dt, 'dt' );
		if ( dt < 0 ) throw new RangeError( 'dt must not be negative' );
		if ( this.paused || dt === 0 ) return;
		const days = dt / this.secondsPerDay;
		const hours = finite( this.currentHour + days * 24, 'advanced hour' );
		const phaseStep = this.advanceMoonPhase ? finite( days / this.lunarDays, 'advanced moon phase' ) : 0;
		this.completedDays += Math.floor( hours / 24 );
		this.currentHour = wrap( hours, 24 );
		this.phase = wrap( this.phase + phaseStep, 1 );

	}

	snapshot(): DayCycleSnapshot {

		const hourAngle = ( this.currentHour - 12 ) / 24 * TAU;
		const sunDir = direction( hourAngle );
		// The moon stands where MOON puts it at every hour and phase (the header). Its disk is lit
		// from the phase's angle round from its own direction toward the west: WEST made square to
		// the moon's direction.
		const moonDir = moonDirection( new Vector3() );
		const moonWest = WEST.clone().addScaledVector( moonDir, - WEST.dot( moonDir ) ).normalize();
		const moonSunDir = moonDir.clone().multiplyScalar( Math.cos( TAU * this.phase ) ).addScaledVector( moonWest, Math.sin( TAU * this.phase ) );
		const elevation = Math.asin( Math.max( - 1, Math.min( 1, sunDir.y ) ) ) * DEG;
		const daylight = smoothstep( - 7, 8, elevation );
		// The night sky was tuned under a low-sun adaptation that faded out over -5 to -14 degrees.
		const skyAdaptation = 1 + 0.6 * smoothstep( - 14, - 5, elevation ) * ( 1 - smoothstep( 4, 18, elevation ) );
		const exposure = exposureAt( elevation );
		// A closed deck hides the moon and stars (see DECK_NIGHT_GAIN); from the end of the blue
		// hour up its adaptation rises to five.
		const deck = DECK_NIGHT_GAIN - 1;
		const dusk = smoothstep( - 6, - 1, elevation );
		const moonIllumination = ( 1 - Math.cos( TAU * this.phase ) ) * 0.5;
		// over the sun's first five degrees under the horizon (the header)
		const moonVisibility = smoothstep( 0, 5, - elevation );
		// Turn along the great circle from the sun to the moon only after the sun is blocked and
		// before the moon's key light fades in. Through the handoff the sun stands near the east or
		// west point; at the default turn the moon stands on the meridian, about a right angle away,
		// and at no turn opposed (the moon stands above the horizon).
		const handoff = 1 - smoothstep( - 2.5, HANDOFF_TOP, elevation );
		const keyDir = handoff === 0 ? sunDir.clone() : handoff === 1 ? moonDir.clone() :
			sunDir.clone().applyQuaternion( _keyTurn.slerpQuaternions( _noTurn, _turn.setFromUnitVectors( sunDir, moonDir ), handoff ) );
		return {
			hour: this.currentHour,
			day: this.completedDays,
			sunDir,
			moonDir,
			moonSunDir,
			keyDir,
			handoff,
			elevation,
			azimuth: Math.atan2( sunDir.z, sunDir.x ) * DEG,
			moonElevation: MOON.elevation,
			moonAzimuth: Math.atan2( moonDir.z, moonDir.x ) * DEG,
			moonPhase: this.phase,
			moonIllumination,
			moonVisibility,
			// The moon's key comes in as soon as the handoff has turned it (from MOON_KEY_TOP), not
			// four degrees later: between the sun's last light and the night's ambient the meadow
			// fell to about half its night brightness. It does not follow the phase.
			moonKeyGain: moonKeyShare( elevation ) * moonVisibility,
			starFrame: starFrame.clone(),
			daylight,
			nightVisibility: 1 - smoothstep( - 15, - 3, elevation ),
			// (the night sky stays dark through its own scaled light: see NIGHT_SKY_EXPOSURE)
			exposure,
			overcastAdaptation: ( deck + ( 5 - deck ) * dusk ) * ( 1 - daylight ),
			nightSkyLevel: Math.min( 1, NIGHT_SKY_EXPOSURE * NIGHT_EXPOSURE_GAIN * skyAdaptation / exposure ),
		};

	}

}
