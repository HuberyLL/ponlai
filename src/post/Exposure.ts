import * as THREE from 'three/webgpu';
import { Fn, If, abs, clamp, exp, exp2, float, log2, max, min, mix, select, vec3, vec4 } from 'three/tsl';
import { keyed, type DayKey, type DayKeys } from './DayKeys.ts';
import { tune, tuneKeys } from '../debug/Tune.ts';
import { cloudedShare } from '../sky/Weather.ts';

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
//   counted in part: a trimmed mean that ignores crevices and glints. The histograms bin the values
//   as stored, pre-exposed, so their range follows the exposure; the meter takes P back out of both
//   means, which reach the target in scene units (Metering.ts, PreExposure.ts).
// - m_H: the mean of log2 Y (hdr's luminance) between its 90th and 97th percentile: the
//   brightness of the frame's brightest few percent. The sky's pixels enter it at the sky's own
//   light, before the night sky's seen gain darkens the drawn sky (Metering.ts, shared.ts
//   `seenNight`), so the exposure follows the light the scene takes, not how dark the night sky is
//   drawn over it.
// - m_S: log2 of the sky's geometric-mean luminance exp( mean ln Y ) over the upper hemisphere
//   (shared.ts `skyMeterLog2`: Sky.ts reduces it from each environment bake, and the dome writes
//   the same luminance as its metering illuminance), so a sky-filled view is metered by the sky's
//   overall brightness, not by the bright sky about the sun.
// - The keys (EXPOSURE_KEYS, DayKeys.ts): the key κ (a white diffuser under the frame's typical
//   light lands at 2^κ), the highlight key κ_H (the bright band lands at 2^κ_H at most) and the
//   sky's share β.
// - The target, in three steps:
//   - The scene's exposure: e_M = κ - m_M, held down by the highlight guard e_H = κ_H - m_H as
//     their soft minimum, e_G = -k log2( 2^( -e_M / k ) + 2^( -e_H / k ) ) with k = SOFT_MIN (a
//     quarter of a stop): the lower of the two where they lie apart, eased where they meet, so the
//     exposure does not turn a corner as a view's highlight guard takes over from its meter (at most
//     k under the lower, where they are equal; under a tenth of a stop once they lie half a stop
//     apart).
//   - The blend: the sky's own exposure e_S = κ - m_S and the scene's blend in stops by the sky's
//     share, e = ( 1 - β ) e_G + β e_S: a weighted metering pattern, the sky weighing into the meter
//     as a region of the frame does in a camera's weighted metering. The guard holds down the
//     scene's share alone, never the sky's: the bright band about a low sun (the glitter on the sea,
//     the glow) darkens what the land's light asks for, while the sky's part still follows the
//     sky's own light, so the sky weighs the same in every view under one sky.
//   - The bound: EV_t = clamp( e, e_S - 4, e_S + 5 ) plus the GUI's offset (stops), both bounds
//     offset too (EXPOSURE_UNDER, EXPOSURE_OVER): a window about the sky's exposure that the
//     adaptation holds EV in (`exposureAdapt`). Across the kept weathers' views e lies from about
//     2.6 stops under e_S to 1.6 over it (the land at the blue hour and before sunrise): the land's
//     illuminance, the sun's included, lies over the sky's own luminance by day and by night. The
//     lowest is a free camera low over the sea looking toward a low sun (guard-held: 2.6 stops
//     under at 12 degrees, 1.2 to 1.7 at 1 to 3 degrees). The window keeps a frame of glare or of
//     black from carrying the exposure past what the sky allows, and leaves every kept view free,
//     the nearest 1.4 stops inside it.
// - No reading: where M's histogram holds less than a sample's weight (no metered material in
//   view, or no material writing M at all), e_M is the sky's exposure e_S, so the scene's share is
//   the sky's too, still held down by the highlight guard; where Y's holds none, the guard drops
//   out and the scene's share is e_M alone.
// - The night's darkness is the night key's job: the meter reads night light as it reads the day's.
//   The night key comes in by the exposure's own night weight (sky/DayCycle.ts `exposureNight`),
//   not the display's: where the meter hands over to it is set by the light, apart from the grade.
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

/** The exposure's keys (DayKeys.ts): the evening's dusk (held from -0.4 degrees down) and sunset
 * (0.4), the golden hour (a sun at 3 degrees), a low sun (12), a high one (40), the rising sun's
 * dawn (held from -2 degrees down) and its golden hour (3), a clouded day's (-1, 0, 3, 6 and 12)
 * and the night. They are set against the exposed white of a diffuser under
 * the sun's direct light alone (by night the shaded one), seen toward and away from the sun, with
 * the sky's light as look/SkyLook.ts SKY_LIGHT and CLEAR_SKY set it, together with the haze and the grading.
 * The day's κ follow the sea's share of the meter (ocean/Water.ts): the sea is metered as a share
 * of what a white card laid level at its point would meter, so a frame's sea no longer moves its
 * meter up under a clear sky and down under a closed deck. Each key was lowered in steps on the
 * views of its state (the clear day's from 6 degrees up for the low and high keys, the golden
 * hour's, the rising sun's, the clouded day's), to the step at which those views' land, sky and sea
 * read as they did before the change, within a third of a stop in lightness: the high key went down
 * by 0.8 stops, the low by 0.9, the golden by 0.7, the rising sun's dawn by 0.8 and its golden hour
 * by 0.6, the clouded by 0.9. The sky's share β is 0.4 under a clear day's keys, the dawn's and the
 * night's, 0.2 under the golden hours' and the clouded ones: the land's light sets most of a view's
 * exposure, the sky's own enough that a view follows the sky's light through the day. The highlight
 * key holds a view toward a low sun (the sea's glitter toward a sun at 12 degrees, a view along the
 * horizon toward one at 3 degrees, one into the glow after sunset) under one away from it on the
 * scene's share; with the keys lower, such a view stands 0.14 to 0.36 stops darker than before, the
 * golden hour's the least. The rising sun's keys share it (shared, so tuning `@golden` moves them
 * all). The clouded keys' κ_H lie well over their κ, so the guard holds a clouded view down only
 * where its brightest few percent lie far over its metered light (under a sky with no sun, rarely).
 * A clouded day stands under the clear one by the light its clouds take, overcast's key
 * OVERCAST_KEY on top of it by its share. `cloudy` sets the cloudy sky toward a high sun, where the
 * land in the clouds' shade is lit about as the clear day's metered frame is and the key alone
 * holds the frame under it: at -0.6 the broken cloud over a meadow reads at a display lightness of
 * 0.63 and the sunlit rock at 0.55, and the meadow in the clouds' shade at 0.26 with the sun 15
 * degrees up and, on toward `cloudyLow`, at 0.19 with it 8 up. It sets the bright cloud's
 * lightness and share, its tint (Oklab b, which the tone curve moves) and the gaps between the
 * clouds. A lower key darkens the gaps faster than the bright cloud, and the clouds' own contrast
 * widens a little as the frame darkens, which no key mends; the land under the deck goes down with
 * the sky. The keys from the golden hour down were set again once the sea's metering and the
 * dusk's light had settled, on the island's default view through the evening's and the morning's
 * dusk, each to where that view's land reads as it did before the sea's metering, within a third of
 * a stop (the night's own change apart, which the night key carries; on screen the land moves about
 * one and a half times a key's change there, in the tone curve's toe). The clear evening's land
 * under the horizon read 0.6 stops over that, so the dusk key lies 0.35 stops under the golden
 * hour's, reached from `sunset` at 0.4 degrees, which shares the golden hour's. The clouded day's
 * land had lost the fall from 12 to 6 degrees its old meter made and read 1.6 stops over it from 7
 * degrees to the horizon, so `cloudyLow`, `cloudyGolden` and `cloudySunset` lie 1.05, 0.95 and 1.2
 * stops under the keys they had and `cloudyDusk` holds 1.6 under from -1 degree down, where the
 * clouded exposure's night weight takes over (DayCycle.ts `exposureNight`); the cloudy morning
 * shares them and reads within half a stop of that, its land brighter just under the horizon and
 * darker where gaps in the cloud let the low sun through. One night key serves every night's sky. It lies about 2.3
 * stops under the day's high key and 2.1 under its low: the moonlit open sky is the brightest large
 * thing in a night's frame, and the sea's smaller share in the meter raised the night's exposure
 * by about 0.8 stops at the key it had, so the key is raised to the lowest value that holds its gap
 * to the day's high key within a third of a stop of two stops. The meter would take back the
 * moonlight a deck takes, so overcast's night keeps a share of that darkness on screen
 * (OVERCAST_NIGHT). The rising sun's dawn key meters the morning's land before the
 * sun by both the sky and its own light, so the land keeps its level while the sky brightens toward
 * the sun (a morning's day exposure comes in long before the sun: DayCycle.ts `displayNight`), and
 * from -2 to 3 degrees it passes into the morning's golden key, about 0.4 stops under the
 * evening's: at 3 degrees the island view meters mostly the sea on either side of the day (about
 * seven tenths of its metered cells), but in the morning its land lies nearly all in shade (about a
 * tenth of it sunlit, against four tenths in the evening). Under cloud the clouded keys
 * take over from it by the cloud's share, as from the day's. The adaptation's time constants are
 * the same in every key (the header, Adaptation). Tunable on debug pages (debug/Tune.ts):
 * `post.exposure.<value>@<key>`. */
const EXPOSURE_DAY: readonly DayKey<ExposureKey>[] = [
	{ at: - 0.4, name: 'dusk', values: { key: - 1.65, get highlight() { return EXPOSURE_KEYS.day[ 2 ].values.highlight; }, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 0.4, name: 'sunset', values: { get key() { return EXPOSURE_KEYS.day[ 2 ].values.key; }, get highlight() { return EXPOSURE_KEYS.day[ 2 ].values.highlight; }, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 3, name: 'golden', values: { key: - 1.3, highlight: 0.45, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 12, name: 'low', values: { key: - 0.46, highlight: - 0.97, sky: 0.4, adaptUp: 0.05, adaptDown: 0.05 } },
	{ at: 40, name: 'high', values: { key: - 0.24, highlight: 0.11, sky: 0.4, adaptUp: 0.05, adaptDown: 0.05 } },
];
export const EXPOSURE_KEYS: DayKeys<ExposureKey> = tuneKeys( 'post.exposure', {
	day: EXPOSURE_DAY,
	rising: [
		{ at: - 2, name: 'dawn', values: { key: - 1.79, get highlight() { return EXPOSURE_KEYS.day[ 2 ].values.highlight; }, sky: 0.4, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 3, name: 'morningGolden', values: { key: - 1.71, get highlight() { return EXPOSURE_KEYS.day[ 2 ].values.highlight; }, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
		...EXPOSURE_DAY.slice( 3 ),
	],
	cloudy: [
		{ at: - 1, name: 'cloudyDusk', values: { key: - 2.9, highlight: 3.05, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 0, name: 'cloudySunset', values: { key: - 2.5, highlight: 3.05, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 3, name: 'cloudyGolden', values: { key: - 2.25, highlight: 3.05, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 6, name: 'cloudyLow', values: { key: - 2.04, highlight: 3.05, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
		{ at: 12, name: 'cloudy', values: { key: - 0.6, highlight: 3.05, sky: 0.2, adaptUp: 0.05, adaptDown: 0.05 } },
	],
	night: { key: - 2.57, highlight: - 1.32, sky: 0.4, adaptUp: 0.05, adaptDown: 0.05 },
}, { key: { min: - 6, max: 3 }, highlight: { min: - 3, max: 4 }, sky: { min: 0, max: 1 }, adaptUp: { min: 0.02, max: 4, scale: 'log' }, adaptDown: { min: 0.02, max: 4, scale: 'log' } } );

/** Overcast's key on top of the clouded one toward a high sun, stops, by overcast's share of the
 * sky (Weather.ts `skyMix`, a parked sky counting as overcast), whole by day and handing over to the
 * night by the exposure's own night weight, as the keys do. It enters here alone, never in the
 * keys' own blend. It stands with overcast's own day sky (sky/Weather.ts, overcast's `daySky`): the
 * sky dome meters at its bake's geometric-mean luminance, so a darker sky drags the meter and the
 * exposure brightens, the more sky a frame holds the more. At -0.5, with overcast's day sky at
 * 0.092 and the sun at 30 degrees, the meadow away from the sun reads at a display lightness of
 * 0.28 and the deck behind it at 0.33 to 0.34. The parked rain, storm and fog
 * count as overcast in the sky's blend and take this key but keep a day sky of 1, so they read
 * darker than overcast; they are parked and left so.
 * Toward a low sun it passes to OVERCAST_KEY_LOW (OVERCAST_KEY_SPAN). Tunable:
 * `post.exposure.overcastKey`. */
const OVERCAST_KEY = tune( 'post.exposure.overcastKey', - 0.5, { min: - 4, max: 1 } );
/** Overcast's key toward a low sun, stops, in place of OVERCAST_KEY. Once the sea was metered as a
 * share of the white card's light, the overcast evening's land read from 0.4 stops over what it
 * read before at 12 degrees to 1.0 to 1.3 over from 7 degrees to the horizon, where the clouded keys
 * it holds (OVERCAST_HELD) stay flat; this key takes that back, set on the island's default view
 * between the evening's land and the morning's, which reads up to half a stop brighter under a deck
 * whatever the key. Under the horizon the land no longer follows how it read before: that fell two
 * stops within a degree, the exposure falling with it, and the exposure may not fall as the light
 * does (its night weight comes in no faster than the meter's light goes). It stands 0.14 stops
 * under OVERCAST_KEY: each 3-degree step's fall of the key across OVERCAST_KEY_SPAN is at most
 * 0.34 of that gap, under 0.05 stops. Tunable: `post.exposure.overcastKeyLow`. */
const OVERCAST_KEY_LOW = tune( 'post.exposure.overcastKeyLow', - 0.64, { min: - 4, max: 1 } );
/** Where overcast's key passes from its low sun's value (OVERCAST_KEY_LOW, at and under the first)
 * to its high sun's (OVERCAST_KEY, at and over the second), degrees: a smoothstep. */
const OVERCAST_KEY_SPAN = [ 6, 18 ] as const;
/** The share of a clear sky's light the overcast deck lets through onto the land by night: the
 * open land's illuminance under overcast against a clear sky's with a key at the moon's height,
 * measured on our island with the deck in its night form (sky/CloudModel.ts MOON_DECK_GLOW, the whole
 * deck seen) and the moon's fixed land gain (lighting/AmbientGrade.ts OVERCAST_MOON_LAND), the
 * form the night draws. So in scene units an overcast night lies log2( 1 / 0.72 ), about 0.47
 * stops, under a clear one. The day's deck form reads about 0.79 by the same measure; the night
 * never takes it. */
const DECK_LAND_THROUGH = 0.72;
/** Overcast night's share f of that darkness the display keeps: the night key goes down by f times
 * it, so the meter takes back only 1 - f of it and an overcast night reads darker than a clear one
 * on screen, not only in scene units. f is a choice of the look (0: the meter takes it all back,
 * 1: none). It comes in by overcast's share and the exposure's night weight, a function of the
 * clock and the weather alone. Tunable: `post.exposure.overcastNight`. */
const OVERCAST_NIGHT = tune( 'post.exposure.overcastNight', 0.5, { min: 0, max: 1 } );
/** Where overcast holds the clouded keys from, degrees (`cloudy`): its closed deck does not break
 * up at a low sun (sky/Weather.ts `overcastDeckLight`), so below it overcast keeps that key, its own
 * key toward a low sun (OVERCAST_KEY_LOW) taking the low sun's light, and hands over only to the
 * night's, while a cloudy sky's keys go on to the low sun's and the evening's under 12 degrees. */
const OVERCAST_HELD = 12;
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

/** The window about the sky's exposure e_S the target is held in, stops under and over it (see the
 * header). */
export const EXPOSURE_UNDER = 4;
export const EXPOSURE_OVER = 5;
/** The soft minimum's width k, in stops (see the header). */
export const SOFT_MIN = 0.25;

/** The target: ( EV_t, its lower bound, its upper bound ), stops, from the trimmed means `meter`
 * ( m_M ) and `high` ( m_H ), whether each histogram had a reading (`hasMeter`, `hasHigh`: 0 or
 * 1), the sky's log2 luminance `sky` ( m_S ), the keys and the GUI's `offset` (stops). */
export const exposureTarget = Fn( ( [ meter, hasMeter, high, hasHigh, sky, key, highlight, skyShare, offset ]: F[] ) => {

	// the sky's exposure and the scene's (the sky's where the scene has no reading)
	const eS = key.sub( sky ).toVar();
	const eM = select( hasMeter.greaterThan( 0.5 ), key.sub( meter ), eS ).toVar();
	// the highlight guard on the scene's branch alone: the soft minimum, as the lower one less its
	// easing (no power of a large value to overflow)
	const eH = highlight.sub( high ).toVar();
	const guarded = min( eM, eH ).sub( log2( exp2( abs( eM.sub( eH ) ).div( - SOFT_MIN ) ).add( 1 ) ).mul( SOFT_MIN ) ).toVar();
	const scene = select( hasHigh.greaterThan( 0.5 ), guarded, eM );
	// the two blended in stops by the sky's share, held in the window about the sky's exposure
	const e = mix( scene, eS, skyShare );
	const lo = eS.sub( EXPOSURE_UNDER ).add( offset ), hi = eS.add( EXPOSURE_OVER ).add( offset );
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
