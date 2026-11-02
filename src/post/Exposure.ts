import * as THREE from 'three/webgpu';
import { Fn, If, abs, clamp, exp, exp2, float, log2, max, min, mix, select, vec3, vec4 } from 'three/tsl';
import { keyed, type DayKey, type DayKeys } from './DayKeys.ts';
import { tune, tuneKeys } from '../debug/Tune.ts';
import { cloudedShare, overcastDeckLight } from '../sky/Weather.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The frame's exposure target, in stops (EV = log2 of the factor that scales scene radiance into
// the exposed image), from the metering histograms (Metering.ts) and the sky. The meter reads the
// light falling on the scene, not the light leaving it, so the albedo stays out of it: a dark
// meadow stays dark against a pale beach (after Patry, "Real-Time Samurai Cinema", SIGGRAPH 2021:
// a primarily illuminance-based exposure).
// - m_M: the mean of log2 M (the metering illuminance) over its histogram between the 10th and the
//   90th percentile of the total weight, bins at their centres, a bin that straddles a percentile
//   counted in part: a trimmed mean that ignores crevices and glints.
// - m_H: the mean of log2 Y (hdr's luminance) between its 90th and 97th percentile: the
//   brightness of the frame's brightest few percent.
// - m_S: log2 of the sky's geometric-mean luminance exp( mean ln Y ) over the upper hemisphere
//   (shared.ts `skyMeterLog2`: Sky.ts reduces it from each environment bake, and the dome writes
//   the same luminance as its metering illuminance), so a sky-filled view is metered by the sky's
//   overall brightness, not by the bright sky about the sun.
// - The keys (EXPOSURE_KEYS, DayKeys.ts): the key κ (a white diffuser under the frame's typical
//   light lands at 2^κ), the highlight key κ_H (the bright band lands at 2^κ_H at most) and the
//   sky's share β.
// - The target, in three steps:
//   - The meter: e_S = κ - m_S, the sky's own exposure, and e_M = κ - m_M, the scene's. The
//     frame's metered exposure blends them in stops by the sky's share,
//     e_m = ( 1 - β ) e_M + β e_S: a weighted metering pattern, the sky weighing into the meter as
//     a region of the frame does in a camera's weighted metering.
//   - The highlight guard: e_H = κ_H - m_H, and e is the soft minimum of e_m and e_H,
//     e = -k log2( 2^( -e_m / k ) + 2^( -e_H / k ) ) with k = SOFT_MIN (a quarter of a stop): the
//     lower of the two where they lie apart, eased where they meet, so the exposure does not turn
//     a corner as a view's highlight guard takes over from its meter (at most k under the lower,
//     where they are equal; under a tenth of a stop once they lie half a stop apart). The guard
//     holds down the whole metered exposure, the sky's share included.
//   - The bound: EV_t = clamp( e, e_m - R, e_m + R ) plus the GUI's offset (stops), both bounds
//     offset too, R = EXPOSURE_RANGE (5 stops): the guard may pull the exposure at most R stops
//     under the meter, however bright the frame's brightest few percent. e never lies over e_m (a
//     soft minimum lies under both its terms), so the upper bound only closes the range the
//     adaptation holds EV in (`exposureAdapt`).
// - No reading: where M's histogram holds less than a sample's weight (no metered material in
//   view, or no material writing M at all), e_M is the sky's exposure e_S, so the meter is the
//   sky's alone whatever β, and the frame is exposed by the sky and held down by the highlight
//   guard; where Y's holds none, the guard drops out and e is e_m alone.
// - The night's darkness is the night key's job: the meter reads night light as it reads the day's.
// - Adaptation (`exposureAdapt`): the exposure EV follows its target EV_t as a critically damped
//   second-order filter on EV, EV'' = -2 ω EV' - ω^2 ( EV - EV_t ), ω = 1 / τ (Lowe, "Critically
//   Damped Ease-In/Ease-Out Smoothing", Game Programming Gems 4, 2004): it starts with no kink;
//   from rest a held target is reached without overshoot; a target that moves while the EV is
//   moving can be passed by a little. A target that turns back mid-way bends the motion rather
//   than restarting it. Each frame takes the filter's exact step over the scene clock's step dt
//   for the target held over it, with y = EV - EV_t and v = EV':
//   y' = ( y + ( v + ω y ) dt ) e^( -ω dt ), v' = ( v - ω ( v + ω y ) dt ) e^( -ω dt ), stable at
//   any dt and the same curve at any frame rate. τ is keyed by the way the exposure moves:
//   `adaptUp` while it rises (the view grew darker), `adaptDown` while it falls (the view grew
//   brighter). Both are 0.05 s in every key, the eye's light adaptation: Durand and Dorsey model
//   the cones' recovery of sensitivity after a rise or a small fall of the light as a first-order
//   filter of time constant 0.1 s ("Interactive Tone Mapping", Eurographics Workshop on
//   Rendering, 2000), and the scene's changes of light by day (a pan from the sea to the land, a
//   cloud's shadow) are of that kind, not the minutes of dark adaptation after a large fall. Two
//   such filters in a row, as this one is, lag an input that moves at a steady rate (a pan) by
//   2 τ, a first-order filter by its own time constant, so τ = 0.05 s lags a pan by the eye's
//   0.1 s. From rest the share of a held step still to go is y( t ) / y( 0 ) = ( 1 + ω t )
//   e^( -ω t ), so half the step is covered in about 0.084 s and 90 % of it in about 0.19 s.
//   Held at a bound of the target's range, EV stops there and its
//   velocity is cleared, so it leaves the bound from rest.
//   The state, one RGBA32F texel: ( EV, v, EV_t, moved ), stops, stops per second, stops, and 1
//   where this frame's EV differs from the previous frame's (as floats, exactly), else 0. A reset
//   (the page's first frame, a scene event that cuts), a paused clock (dt 0) and so the test mode,
//   a paused page, put EV = EV_t and v = 0: a paused frame equals a fresh load's. `moved` is a
//   diagnostic (the page's exposure readout): after a snap it is 1 for one frame, until EV stands
//   still. Nothing in the frame reads the previous frame's exposure before the meter.
// - A stepped clip (capture-clip.mjs, `window.__PONLAI_CLIP__` set) snaps the same way on every
//   frame: a temporal rest converged on a stopped clock jumps to its target while running frames
//   still lag behind theirs, so a clip compared with its rest or with MSAA would differ by the lag
//   alone. Freezing the adaptation on every side compares the images, not the adaptation.
// - EV stays absolute (scene units to the exposed image). `hdr` is stored pre-exposed by 2^P
//   (PreExposure.ts), so the display chain reads the exposure as 2^( EV - P ) (Pipeline.ts
//   `exposureRead`), and P follows this EV read back a frame or two late.

export interface ExposureKey extends Record<string, number> {
	// κ, stops: where a white diffuser under the frame's typical light lands in the exposed image
	key: number;
	// κ_H, stops: the highest the frame's bright band (Y's 90th to 97th percentile) lands
	highlight: number;
	// β: the sky's share of the meter (its own exposure's, against the scene's)
	sky: number;
	// τ, seconds: the adaptation's time constant while the exposure rises (the view grew darker)
	adaptUp: number;
	// τ, seconds: the adaptation's time constant while the exposure falls (the view grew brighter)
	adaptDown: number;
}

/** The exposure's keys (DayKeys.ts): the golden hour (a sun at 3 degrees), a low sun (12), a high
 * one (40), a clouded day's, held above 6 degrees, and the night. They are set against the exposed
 * white of a diffuser under the sun's direct light alone (by night the shaded one), seen toward
 * and away from the sun, with the sky's light as Sky.ts SKY_LIGHT sets it, together with the sky's
 * light, the haze and the grading. The highlight key is what darkens a view toward a low sun
 * against one away from it, the bright band about the sun capping the exposure. The golden key
 * sits under the low one, about half a stop under the meter and the highlights' guard close over
 * it, so a sun at 3 degrees leaves a sunlit cliff orange and its shade deep. The high key's β runs
 * to about 0.9, where the sky nearly alone sets the exposure. Under a clouded day's deck the sky
 * alone sets it, β 1 from 6 degrees up (cloudyLow, cloudy): the land under a deck is lit by that
 * deck, so exposing by the sky keeps the sky over the meadow by the same stops at every height,
 * and the land follows the sky's own fall into the evening with no step where the meter's reading
 * would jump (a gap, a sun that drops through a cloud's edge). κ -0.5 at 6 degrees and -0.6 from
 * 12 set the deck's sky at about L 0.7 - 0.76; overcast's darker deck takes OVERCAST_KEY on top,
 * by its share, once. Under a cloudy sky's deck below 3 degrees the deck's light hands over to the
 * evening's: β 0, the meter alone, κ 0.1 at 3 and -0.12 at sunset. Overcast's closed deck keeps 6
 * degrees' keys at every lower sun until the night's come in (`exposureKeys`). The clouded keys'
 * κ_H lie well over their κ, so the guard holds a clouded view down only where its brightest few
 * percent lie far over its metered light (under a sky with no sun, rarely). The night has one
 * white: β 0 (the meter alone), κ and κ_H a quarter of a stop apart and moved together, so the
 * guard does not take back what the key gives: the moonlit land's shade stands a step over the
 * curve's black, with the moon's path and the sky rising alongside it. The adaptation's time
 * constants are the same in every key (the header, Adaptation). A clear morning's day exposure
 * comes in long before the sun (DayCycle.ts `displayNight`), and under the golden key's β 0.05 the
 * meter held the land at its own level whatever the light it took, so the land read as bright as
 * the sky lit it cyan, and the sea took the change. Metered by the sky alone, the exposure fell as
 * the sky brightened toward the sun faster than the land's light (the probes' night key leaves it
 * from -13 to -3 degrees: DayCycle.ts `skyNight`), and the whole frame, land and sea, sank by about
 * three quarters of a stop from -7 to -3.5. The rising sun's `dawn` key, held from -2 degrees down,
 * meters by both: β 0.6, κ -1.06, κ_H the golden key's own (shared, so tuning `@golden` moves both).
 * On the island view the land's median lightness then stays within about 9 % of its peak from -10
 * degrees to the sun's rise (Oklab L 0.166 to 0.182; metered by the sky alone, 0.150 to 0.210),
 * and its brightness is still its light against the sky's (Sky.ts ISLAND_SKY_RISING); from -2 to 3 it passes
 * into the golden key. Under cloud the clouded keys take over from it by the cloud's share, as
 * from the day's.
 * Tunable on debug pages (debug/Tune.ts): `post.exposure.<value>@<key>`. */
const EXPOSURE_DAY: readonly DayKey<ExposureKey>[] = [
	{ at: 3, name: 'golden', values: { key: - 0.38, highlight: 0.27, sky: 0.05, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 12, name: 'low', values: { key: 0.332, highlight: 0.52, sky: 0.441, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 40, name: 'high', values: { key: - 1.05, highlight: 1.44, sky: 0.92, adaptUp: 0.05, adaptDown: 0.05 } },
];
export const EXPOSURE_KEYS: DayKeys<ExposureKey> = tuneKeys( 'post.exposure', {
	day: EXPOSURE_DAY,
	rising: [ { at: - 2, name: 'dawn', values: { key: - 1.06, get highlight() { return EXPOSURE_KEYS.day[ 0 ].values.highlight; }, sky: 0.6, adaptUp: 0.05, adaptDown: 0.05 } }, ...EXPOSURE_DAY ],
	cloudy: [
		{ at: 0, name: 'cloudySunset', values: { key: - 0.12, highlight: 3.05, sky: 0, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 3, name: 'cloudyGolden', values: { key: 0.1, highlight: 3.05, sky: 0, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 6, name: 'cloudyLow', values: { key: - 0.5, highlight: 3.05, sky: 1, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 12, name: 'cloudy', values: { key: - 0.6, highlight: 3.05, sky: 1, adaptUp: 0.05, adaptDown: 0.05 } },
	],
	night: { key: - 1.9, highlight: - 1.67, sky: 0, adaptUp: 0.05, adaptDown: 0.05 },
}, { key: { min: - 6, max: 3 }, highlight: { min: - 3, max: 4 }, sky: { min: 0, max: 1 }, adaptUp: { min: 0.02, max: 4, scale: 'log' }, adaptDown: { min: 0.02, max: 4, scale: 'log' } } );

/** Overcast's key on top of the clouded one, stops, by overcast's share of the sky (Weather.ts
 * `skyMix`, a parked sky counting as overcast), whole by day and fading with the deck's light over
 * the civil twilight (sky/Weather.ts `overcastDeckLight`, whole at the horizon, gone by -6): its deck
 * is darker than a cloudy one's, brightest about the sun's place
 * (weather/VolumetricHaze.ts, overcast's deck), and the sky sets the exposure, so its sky stands near L 0.75 within 30 degrees of the sun and 0.3 looking
 * away from it. It enters here alone, never in the keys' own blend. Tunable:
 * `post.exposure.overcastKey`. */
const OVERCAST_KEY = tune( 'post.exposure.overcastKey', - 2.4, { min: - 4, max: 1 } );
/** Where overcast holds the clouded keys from, degrees (`cloudyLow`): its closed deck does not
 * break up at a low sun (sky/Weather.ts `overcastDeckLight`), so below it overcast keeps metering by
 * the sky with that key, handing over only to the night's, while a cloudy sky's keys go on to the
 * evening's meter under 6 degrees. */
const OVERCAST_HELD = 6;
const _held = { key: 0, highlight: 0, sky: 0, adaptUp: 0, adaptDown: 0 };

/** The exposure's keys at the sun's `elevation` (degrees), the night's weight `night` and the
 * weather's blend of the kept skies `skyMix`, into `out`, the morning's where the sun is `rising`:
 * the day's (or the rising sun's) and the clouded keys (DayKeys.ts `keyed`), overcast's share holding the clouded keys at OVERCAST_HELD below it, and OVERCAST_KEY
 * by overcast's share and the deck's light. */
export function exposureKeys( elevation: number, night: number, skyMix: readonly number[], out: ExposureKey, rising = false ): ExposureKey {

	const clouded = cloudedShare( skyMix ), overcast = skyMix[ 3 ] ?? 0;
	keyed( EXPOSURE_KEYS, elevation, night, out, overcast < 1 ? ( clouded - overcast ) / ( 1 - overcast ) : 0, rising );
	if ( overcast > 0 ) {

		keyed( EXPOSURE_KEYS, Math.max( elevation, OVERCAST_HELD ), night, _held, 1 );
		for ( const k in out ) out[ k ] += ( _held[ k as keyof typeof _held ] - out[ k ] ) * overcast;
		out.key += OVERCAST_KEY() * overcast * overcastDeckLight( elevation );

	}
	return out;

}

/** How far under the meter's exposure e_m the highlight guard may pull the target, in stops (the
 * bound's half width about e_m: see the header). */
export const EXPOSURE_RANGE = 5;
/** The soft minimum's width k, in stops (see the header). */
export const SOFT_MIN = 0.25;

/** The target: ( EV_t, its lower bound, its upper bound ), stops, from the trimmed means `meter`
 * ( m_M ) and `high` ( m_H ), whether each histogram had a reading (`hasMeter`, `hasHigh`: 0 or
 * 1), the sky's log2 luminance `sky` ( m_S ), the keys and the GUI's `offset` (stops). */
export const exposureTarget = Fn( ( [ meter, hasMeter, high, hasHigh, sky, key, highlight, skyShare, offset ]: F[] ) => {

	// the meter: the scene's exposure and the sky's blended in stops by the sky's share (the sky's
	// alone where the scene has no reading)
	const eS = key.sub( sky ).toVar();
	const eM = select( hasMeter.greaterThan( 0.5 ), key.sub( meter ), eS ).toVar();
	const metered = mix( eM, eS, skyShare ).toVar();
	// the highlight guard over the whole of it: the soft minimum, as the lower one less its easing
	// (no power of a large value to overflow)
	const eH = highlight.sub( high ).toVar();
	const soft = min( metered, eH ).sub( log2( exp2( abs( metered.sub( eH ) ).div( - SOFT_MIN ) ).add( 1 ) ).mul( SOFT_MIN ) ).toVar();
	const e = select( hasHigh.greaterThan( 0.5 ), soft, metered );
	// the bound about the meter: how far the guard may pull it down
	const lo = metered.sub( EXPOSURE_RANGE ).add( offset ), hi = metered.add( EXPOSURE_RANGE ).add( offset );
	return vec3( clamp( e.add( offset ), lo, hi ), lo, hi );

} ).setLayout( { name: 'exposureTarget', type: 'vec3', inputs: [
	{ name: 'meter', type: 'float' }, { name: 'hasMeter', type: 'float' }, { name: 'high', type: 'float' }, { name: 'hasHigh', type: 'float' },
	{ name: 'sky', type: 'float' }, { name: 'key', type: 'float' }, { name: 'highlight', type: 'float' }, { name: 'skyShare', type: 'float' }, { name: 'offset', type: 'float' },
] } );

/** The exposure state's step: from the target `aim` ( EV_t, its bounds: `exposureTarget` ), the
 * previous state ( EV, v, EV_t, moved ), the scene clock's step `dt` (seconds), the time
 * constants `up` and `down` (seconds) and `snap` (1: reset to the target), the new state. */
export const exposureAdapt = Fn( ( [ aim, previous, dt, up, down, snap ]: [ V3, V4, F, F, F, F ] ) => {

	const t = aim.x.toVar(), lo = aim.y.toVar(), hi = aim.z.toVar();
	const y0 = previous.x.sub( t ).toVar(), v0 = previous.y.toVar();
	// (rising while the target lies over the exposure)
	const tau = select( y0.lessThan( 0 ), up, down ).toVar();
	const w = float( 1 ).div( max( tau, 1e-4 ) ).toVar();
	const decay = exp( w.mul( dt ).negate() ).toVar();
	const c = v0.add( w.mul( y0 ) ).mul( dt ).toVar();
	const ev = t.add( y0.add( c ).mul( decay ) ).toVar();
	const v = v0.sub( w.mul( c ) ).mul( decay ).toVar();
	If( ev.lessThan( lo ).or( ev.greaterThan( hi ) ), () => {

		ev.assign( clamp( ev, lo, hi ) );
		v.assign( 0 );

	} );
	If( snap.greaterThan( 0.5 ), () => {

		ev.assign( t );
		v.assign( 0 );

	} );
	return vec4( ev, v, t, select( ev.notEqual( previous.x ), float( 1 ), float( 0 ) ) );

} ).setLayout( { name: 'exposureAdapt', type: 'vec4', inputs: [
	{ name: 'aim', type: 'vec3' }, { name: 'previous', type: 'vec4' }, { name: 'dt', type: 'float' },
	{ name: 'up', type: 'float' }, { name: 'down', type: 'float' }, { name: 'snap', type: 'float' },
] } );
