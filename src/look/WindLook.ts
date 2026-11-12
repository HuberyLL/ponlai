import { tune } from '../debug/Tune.ts';
import { readLook } from './Look.ts';

// The wind's look tables, as the renderer reads them (look/Look.ts: the numbers are the installed
// look's, the neutral set's where none is): how much of the wind's strength on the plants its gusts
// carry, how far a blade's gust sample strays from its root, the plants' speed by the wind's, the
// speed at which a limb is fully loaded, and how far apart the plants' sway rates spread.
// weather/Wind.ts builds the wind field from them and says what each does there; the gust field's
// lengths, travel and evolution, the air's density, the roughness length and the log law are
// measured or derived, and stay in that file with the weather's levels (sky/Weather.ts).

const LOOK = readLook( 'wind', 'look/WindLook.ts' );

/** The gusts' share of the wind's strength (Wind.ts `windStrength`): w = S ( 1 + GUST_GAIN q ). */
export const GUST_GAIN = LOOK.gustGain;

/** The largest offset (m, each axis) a blade's gust sample takes from its root (Wind.ts
 * `gustJitter`), so neighbouring blades read slightly different gusts and a gust's edge is not cut
 * clean. */
export const GUST_JITTER = LOOK.gustJitter;

/** The limbs' reference speed (m/s of the plants' speed U_p, Wind.ts `plantLoad`), where a limb
 * (Deform.ts `branchBend`, `sprayBend`) takes a load of 1, linear in the wind's strength below it.
 * The plants' main bend does not read it (`plantWind`). Tunable at load (`wind.plants.speed`). */
export const PLANT_SPEED = tune( 'wind.plants.speed', LOOK.plantSpeed, { min: 10, max: 100, scale: 'log', load: true } )();

/** The plants' speed U_p (m/s) by U10 (m/s): a line through these points, and past the last one on
 * along its last piece's slope (`plantSpeedOf`). */
export const PLANT_WIND: readonly ( readonly [ number, number ] )[] = LOOK.plantWind;

/** The plants' speed U_p (m/s) for a mean wind 10 m up `u10` (m/s): PLANT_WIND. */
export function plantSpeedOf( u10: number ): number {

	const keys = PLANT_WIND;
	let i = 1;
	while ( i < keys.length - 1 && u10 > keys[ i ][ 0 ] ) i ++;
	const [ x0, y0 ] = keys[ i - 1 ], [ x1, y1 ] = keys[ i ];
	return Math.max( 0, y0 + ( y1 - y0 ) * ( u10 - x0 ) / ( x1 - x0 ) );

}

/** Each plant's sway rate is its kind's times 1 + up to this, in Wind.ts PLANT_RATE_BANDS even
 * steps from 0 (`plantWave`). */
export const PLANT_RATE_SPREAD = LOOK.plantRateSpread;
