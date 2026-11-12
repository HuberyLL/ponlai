import * as THREE from 'three/webgpu';
import { keyed, type DayKey, type DayKeys } from '../post/DayKeys.ts';
import { tune, tuneKeys } from '../debug/Tune.ts';
import { cloudedShare } from '../sky/Weather.ts';
import { readLook, type ExposureKey, type SharingKey } from './Look.ts';

// The exposure's look tables, as the renderer reads them (look/Look.ts: the numbers are the
// installed look's, the neutral set's where none is): the exposure's keys by the sun's elevation,
// the rising sun, the clouded day and the night, overcast's keys on top of them, and
// `exposureKeys`, which reads them for a frame. post/Exposure.ts turns the keys into the target
// and the adaptation (its header says what each key does); post/Pipeline.ts `updateDisplay` reads
// the keys once a frame.

export type { ExposureKey };

const LOOK = readLook( 'exposure', 'look/ExposureLook.ts' );

// A look's key may share a value with another key (look/Look.ts `SharingKey`): that value becomes
// a getter of the named key's in the table below, so the two hold one number and one tunable
// (debug/Tune.ts `tuneKeys` leaves a getter as it is). A key no value of which is shared passes
// through as the look gave it, so keys the table's sides share stay one object.
const named = ( name: string ): DayKey<ExposureKey> => {

	const lists = [ EXPOSURE_KEYS.day, EXPOSURE_KEYS.rising ?? [], Array.isArray( EXPOSURE_KEYS.cloudy ) ? EXPOSURE_KEYS.cloudy as readonly DayKey<ExposureKey>[] : [] ];
	for ( const list of lists ) for ( const key of list ) if ( key.name === name ) return key;
	throw new Error( `look/ExposureLook.ts: a key shares a value of '${ name }', which no key is named` );

};
const sharing = new Map<SharingKey<ExposureKey>, DayKey<ExposureKey>>();
const shared = ( list: readonly SharingKey<ExposureKey>[] ): DayKey<ExposureKey>[] => list.map( ( key ) => {

	const { shares } = key;
	if ( ! shares ) return key;
	let out = sharing.get( key );
	if ( ! out ) {

		const values = {} as ExposureKey;
		for ( const k of Object.keys( key.values ) ) {

			const from = shares[ k ];
			if ( from === undefined ) values[ k ] = key.values[ k ];
			else Object.defineProperty( values, k, { enumerable: true, get: () => named( from ).values[ k ] } );

		}
		out = { at: key.at, name: key.name, values };
		sharing.set( key, out );

	}
	return out;

} );

/** The exposure's keys (DayKeys.ts): by the sun's elevation, the rising sun's, a clouded day's and
 * the night's. Tunable on debug pages (debug/Tune.ts): `post.exposure.<value>@<key>`. */
export const EXPOSURE_KEYS: DayKeys<ExposureKey> = tuneKeys( 'post.exposure', {
	day: shared( LOOK.keys.day ),
	rising: shared( LOOK.keys.rising ),
	cloudy: shared( LOOK.keys.cloudy ),
	night: LOOK.keys.night,
}, { key: { min: - 6, max: 3 }, highlight: { min: - 3, max: 4 }, sky: { min: 0, max: 1 }, adaptUp: { min: 0.02, max: 4, scale: 'log' }, adaptDown: { min: 0.02, max: 4, scale: 'log' } } );

/** Overcast's key on top of the clouded one toward a high sun, stops, by overcast's share of the
 * sky (Weather.ts `skyMix`, a parked sky counting as overcast), whole by day and handing over to the
 * night by the exposure's own night weight, as the keys do. It enters here alone, never in the
 * keys' own blend. Toward a low sun it passes to OVERCAST_KEY_LOW (OVERCAST_KEY_SPAN). Tunable:
 * `post.exposure.overcastKey`. */
const OVERCAST_KEY = tune( 'post.exposure.overcastKey', LOOK.overcastKey, { min: - 4, max: 1 } );
/** Overcast's key toward a low sun, stops, in place of OVERCAST_KEY. Tunable:
 * `post.exposure.overcastKeyLow`. */
const OVERCAST_KEY_LOW = tune( 'post.exposure.overcastKeyLow', LOOK.overcastKeyLow, { min: - 4, max: 1 } );
/** Where overcast's key passes from its low sun's value (OVERCAST_KEY_LOW, at and under the first)
 * to its high sun's (OVERCAST_KEY, at and over the second), degrees: a smoothstep. */
const OVERCAST_KEY_SPAN = LOOK.overcastKeySpan;
/** The share of a clear sky's light the overcast deck lets through onto the land by night: in
 * scene units an overcast night lies log2( 1 / share ) stops under a clear one. */
const DECK_LAND_THROUGH = LOOK.deckLandThrough;
/** Overcast night's share f of that darkness the display keeps: the night key goes down by f times
 * it, so the meter takes back only 1 - f of it and an overcast night reads darker than a clear one
 * on screen, not only in scene units (0: the meter takes it all back, 1: none). It comes in by
 * overcast's share and the exposure's night weight, a function of the clock and the weather alone.
 * Tunable: `post.exposure.overcastNight`. */
const OVERCAST_NIGHT = tune( 'post.exposure.overcastNight', LOOK.overcastNight, { min: 0, max: 1 } );
/** Where overcast holds the clouded keys from, degrees: below it overcast keeps that key, its own
 * key toward a low sun (OVERCAST_KEY_LOW) taking the low sun's light, and hands over only to the
 * night's. */
const OVERCAST_HELD = LOOK.overcastHeld;
const _held = { key: 0, highlight: 0, sky: 0, adaptUp: 0, adaptDown: 0 };

/** The exposure's keys at the sun's `elevation` (degrees), the exposure's own night weight `night`
 * (sky/DayCycle.ts `exposureNight`, set apart from the display's so the meter's handover to the
 * night key can follow the light while the tone, the grade and the bloom keep theirs) and the
 * weather's blend of the four skies `skyMix`, into `out`, the morning's where the sun is `rising`:
 * the day's (or the rising sun's) and the clouded keys (DayKeys.ts `keyed`), overcast's share
 * holding the clouded keys at OVERCAST_HELD below it, overcast's key (OVERCAST_KEY_LOW to
 * OVERCAST_KEY over OVERCAST_KEY_SPAN) by overcast's share and the day's weight, and overcast's
 * night (OVERCAST_NIGHT) by overcast's share and the night weight. */
export function exposureKeys( elevation: number, night: number, skyMix: readonly number[], out: ExposureKey, rising = false ): ExposureKey {

	const clouded = cloudedShare( skyMix ), overcast = skyMix[ 3 ] ?? 0;
	keyed( EXPOSURE_KEYS, elevation, night, out, overcast < 1 ? ( clouded - overcast ) / ( 1 - overcast ) : 0, rising );
	if ( overcast > 0 ) {

		keyed( EXPOSURE_KEYS, Math.max( elevation, OVERCAST_HELD ), night, _held, 1 );
		for ( const k in out ) out[ k ] += ( _held[ k as keyof typeof _held ] - out[ k ] ) * overcast;
		const high = THREE.MathUtils.smoothstep( elevation, OVERCAST_KEY_SPAN[ 0 ], OVERCAST_KEY_SPAN[ 1 ] );
		out.key += ( OVERCAST_KEY_LOW() + ( OVERCAST_KEY() - OVERCAST_KEY_LOW() ) * high ) * overcast * ( 1 - night );
		out.key -= OVERCAST_NIGHT() * Math.log2( 1 / DECK_LAND_THROUGH ) * overcast * night;

	}
	return out;

}
