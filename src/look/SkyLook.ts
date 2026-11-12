import * as THREE from 'three/webgpu';
import { SHELL_BOTTOM, SHELL_THICKNESS } from '../sky/CloudModel.ts';
import { MIX_SKIES, WEATHER_PRESETS } from '../sky/Weather.ts';
import type { DayKey, DayKeys } from '../post/DayKeys.ts';
import { tune, tuneKeys, tuneObject } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';
import { readLook, type IslandSkyRow, type Rgb, type StreakKeys } from './Look.ts';

// The sky's look, as the renderer reads it (look/Look.ts: the numbers are the installed look's,
// the neutral set's where none is; this module holds their tunables and the CPU code that reads
// only them): the light the sky lends the island after sunset and under cloud (`islandSky`,
// CLOUD_LIGHT_TINT), the sky's gains on the sun's light (SKY_LIGHT, CLEAR_SKY), the clouds' rows
// per sky of the blend (CLOUD_SKIES, SHADOW_DENSITY), the stores' night ranges (`storeNight`), the
// low key (LOW_KEY), the distant sea's knee (`seaKnee`), the key's hue (`keyHue`), the thin layer's
// colours (STREAK_DIRECT, STREAK_AMBIENT), the moon's key (MOON_KEY, `moonHue`) and the key under
// cloud (KEY_THROUGH_CLOUD). sky/Sky.ts reads them each frame; a name in backticks with no file is
// Sky.ts's. The A/B switches that turn a table off (`flags=clearShade`, `lowSun`, `clearSky`,
// `skyGain`, `lowKey`) stay with their readers in Sky.ts.

const LOOK = readLook( 'sky', 'look/SkyLook.ts' );

// a colour at unit luminance (Rec. 709)
const unit = ( r: number, g: number, b: number ) => {

	const l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return [ r / l, g / l, b / l ] as const;

};

// By day a clouded sky lends the island its own light: from 12 to 40 degrees, as the sky's high
// key climbs, the light lent to the island is drawn toward this tint (unit luminance) by its
// amount (Weather.ts `cloudedHighSun`). The meter's level is the same, the tint keeping the
// luminance.
export const CLOUD_LIGHT_TINT = ( ( [ r, g, b, amount ] ) => [ ...unit( r, g, b ), amount ] as const )( LOOK.cloudLightTint );

// The light the sky lends the island takes a gain per sun elevation and a cast: the environment's
// source panorama, which lights the terrain and plants, in its bake (its haze without the fog
// layer: `fogEnvironment`), and the islanders' sky fill (`islandIrradianceNode`, the irradiance
// probe graded the same way). The seen sky, the panorama the sea reflects and the irradiance probe
// itself, which lights the sea's body, keep the atmosphere's own. Each row is an elevation
// (degrees, descending): the colour the light is drawn toward (linear, at the light's own
// luminance), how far, and the gain; rows interpolate linearly and the end rows hold beyond them.
// The setting sun's rows, the setting sun's under cloud and the rising sun's.
const ISLAND_SKY = LOOK.islandSky.setting, ISLAND_SKY_CLOUDED = LOOK.islandSky.clouded, ISLAND_SKY_RISING = LOOK.islandSky.rising;

// ISLAND_SKY at `elevation`, on the rising or the setting sun's side: the tint (normalised to unit
// luminance) and its amount into `tint`; returns the gain. A clouded share `cloud` (Weather.ts
// `cloudedShare`) draws the setting rows to the clouded evening's (ISLAND_SKY_CLOUDED). The rising
// rows' tints hold under any sky, but their gains were set on a clear morning's exposure
// (look/ExposureLook.ts, `dawn`), so the clouded share takes the clouded evening's gain back, as
// the display's night weight does (DayCycle.ts `displayNight`).
export function islandSky( elevation: number, rising: boolean, tint: THREE.Vector4, cloud: number ): number {

	const at = ( row: IslandSkyRow ) => {

		const [ r, g, b ] = row.tint ?? [ 1, 1, 1 ], l = r * 0.2126 + g * 0.7152 + b * 0.0722;
		return [ r / l, g / l, b / l, row.amount ?? 0, row.gain ?? 1 ];

	};
	const along = ( rows: readonly IslandSkyRow[] ) => {

		let v = at( rows[ rows.length - 1 ] );
		if ( elevation >= rows[ 0 ].at ) v = at( rows[ 0 ] );
		else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

			const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
			const a = at( rows[ i ] ), b = at( rows[ i - 1 ] );
			v = a.map( ( x, c ) => x + ( b[ c ] - x ) * t );
			break;

		}
		return v;

	};
	let v = along( ISLAND_SKY );
	if ( cloud > 0 ) {

		const c = along( ISLAND_SKY_CLOUDED );
		v = v.map( ( x, i ) => x + ( c[ i ] - x ) * cloud );

	}
	if ( rising ) {

		const r = along( ISLAND_SKY_RISING );
		if ( cloud > 0 ) r[ 4 ] += ( v[ 4 ] - r[ 4 ] ) * cloud;
		v = r;

	}
	tint.set( v[ 0 ], v[ 1 ], v[ 2 ], v[ 3 ] );
	return v[ 4 ];

}

// The clear shade, off by default (`flags=clearShade:<k>` or `true` brings it back for A/Bs): the
// sky light lent to the island (as `islandSky`'s) takes a gain and a tint. The gain's extra share
// per sun elevation (degrees, descending; linear between rows, the end rows held beyond).
export const CLEAR_SHADE: readonly { at: number; share: number }[] = LOOK.clearShade;
// the sky light's tint (unit luminance) and how far it is drawn toward it at a share of 1
export const CLEAR_SHADE_TINT = ( ( [ r, g, b, amount ] ) => [ ...unit( r, g, b ), amount ] as const )( LOOK.clearShadeTint );

// The low sun's shade, off by default with the clear shade (`flags=lowSun:<k>` or `true` for
// A/Bs): from `full` degrees down to the horizon the sky light lent to the island is drawn toward
// LOW_SUN_TINT by up to `amount`, fading out above `top`.
export const LOW_SUN = LOOK.lowSun;
/** How far a deck draws the key toward white at the same luminance (`update`). */
export const KEY_DECK_WHITE = LOOK.keyDeckWhite;
export const LOW_SUN_TINT = unit( ...LOOK.lowSunTint );

// The sky's light against the sun's: one gain (an illuminance colour per channel, keyed by the
// sun's elevation: DayKeys.ts) on the light the sun lends the sky, the atmosphere's in-scattered
// light (Atmosphere.ts `skyRadiance`). Everything that reads the sky takes it: the seen sky, the
// environment's bakes and the irradiance probe that light the island, the sea's reflection and the
// clouds' and the haze's sky light, so the sky the eye sees stays the sky that lights. The clouds'
// sunlight takes none. Under cloud the gain moves to the night key from 2 degrees to -6 under the
// horizon; a clear sky's holds the day's keys through the twilight (DayCycle.ts `skyNight`). The
// rising sun reads the `rising` keys, a clouded sky the `cloudy` ones by its clouded share
// (Weather.ts `cloudedShare`).
// Tunable on debug pages (debug/Tune.ts): `sky.light.<r|g|b>@<key name>`.
export const SKY_LIGHT: DayKeys<Rgb> = tuneKeys( 'sky.light', LOOK.skyLight,
	{ r: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune }, g: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune }, b: { min: 0.001, max: 2, scale: 'log', onChange: markSkyRetune } } );

// The clear day's sky against the key: under a clear or fair day's sun the sky's light takes a
// gain of its own over SKY_LIGHT, keyed by the sun's elevation, on every path SKY_LIGHT reaches
// (`skyGain`): the sky the eye sees, the sea's reflection and its body, the clouds' and the haze's
// sky light, the land's and the exposure's sky meter. The gain leaves by the weather's clouded
// share (Weather.ts `cloudedShare`); the open sky seen through a deck's gaps takes it back
// (`gapSky`).
// Tunable on debug pages: `sky.clear.gain@<key name>`.
export const CLEAR_SKY: DayKeys<{ gain: number }> = tuneKeys( 'sky.clear', LOOK.clearSky, { gain: { min: 0.25, max: 8, scale: 'log', onChange: markSkyRetune } } );

// per sky of the blend, the share of the deck's optical depth its shadow is cast with (Weather.ts
// `shadowDensity`, its preset's until tuned), blended by the weather's shares of the four skies;
// tunable on debug pages: `sky.weather.shadowDensity@<cloudy|overcast>`
export const SHADOW_DENSITY = MIX_SKIES.map( ( name ) => ( { shadowDensity: WEATHER_PRESETS[ name ].shadowDensity } ) );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( SHADOW_DENSITY[ s ], { shadowDensity: `sky.weather.shadowDensity@${ name }` }, { shadowDensity: { min: 0.02, max: 1, scale: 'log', onChange: markSkyRetune } } );

}

// The clouds are one model, and a kind of sky is a row of its parameters: one row per sky of the blend
// (CLOUD_SKIES, in MIX_SKIES' order), blended each frame by the weather's shares of the four skies
// (`trackClouds`), so a change of weather crosses them by those shares. The parked weathers count
// as overcast in those shares (Weather.ts), so they take overcast's row. The coverage and the
// density are the weather state's (Weather.ts WEATHER_PRESETS), interpolated with it.
//
// `base`, `top` (m): the shell the clouds stand in (Clouds.ts `setShell`); a look's row without
// them stands in the cloud model's own shell (sky/CloudModel.ts).
// `type`, `spread`: the cloud type (0 a stratus, 1 a cumulus: sky/CloudModel.ts STRATUS, CUMULUS) and how
// far it varies from place to place, either way.
// `farFade`: how far the clouds thin with distance (Clouds.ts `farFade`).
// Tunable on debug pages: `sky.clouds.base|top|type|spread|farFade@<clear|fair|cloudy|overcast>`.
export type CloudSky = { base: number; top: number; type: number; spread: number; farFade: number };
export const CLOUD_SKIES: CloudSky[] = LOOK.cloudSkies.map( ( row ) => (
	{ base: row.base ?? SHELL_BOTTOM, top: row.top ?? SHELL_BOTTOM + SHELL_THICKNESS, type: row.type, spread: row.spread, farFade: row.farFade } ) );
for ( const [ s, name ] of MIX_SKIES.entries() ) {

	tuneObject( CLOUD_SKIES[ s ], { base: `sky.clouds.base@${ name }`, top: `sky.clouds.top@${ name }`, type: `sky.clouds.type@${ name }`, spread: `sky.clouds.spread@${ name }`, farFade: `sky.clouds.farFade@${ name }` },
		{ base: { min: 300, max: 6000, onChange: markSkyRetune }, top: { min: 1500, max: 10000, onChange: markSkyRetune }, type: { min: 0, max: 1, onChange: markSkyRetune },
			spread: { min: 0, max: 1, onChange: markSkyRetune }, farFade: { min: 0, max: 1, onChange: markSkyRetune } } );

}
/** The cloud shell's base (m) under the sky `s` (Weather.ts MIX_SKIES), as tuned: the haze's
 * aerosol ends at a layer's base (weather/HazeKeys.ts `aerosolTop`). */
export const cloudBase = ( s: number ): number => CLOUD_SKIES[ s ].base;

// The range each store holds under the moon, per sky of the blend (MIX_SKIES' order), in stops over the
// luminance of the moonlight on the clouds (`storeLight`): the brightest value and the first
// percentile (the cloud dome's and the layer's over the texels at least a tenth covered). The rows
// are estimates that centre the range, with several stops to spare on either side (NIGHT_TOP,
// NIGHT_FLOOR). A weather between skies takes the rows by its shares of them, as its shell and
// form do (CLOUD_SKIES).
const STORE_RANGE = LOOK.storeRange;
// What a night's store must keep, stored (stops): its brightest under 2^13 (two stops under
// STORE_CEILING), and its first percentile, were the night pressed 12 stops darker (the debug
// press, PreExposure.ts `storePress`), over 2^-13, a stop over half float's 2^-14.
const NIGHT_TOP = 13, NIGHT_FLOOR = - 13 + 12;

/** Where the store `group`'s range sits best under the moon (stops over the light, PreExposure.ts
 * `storeStops`): its estimated brightest and first percentile (STORE_RANGE, by the weather's
 * shares of the four skies) centred between NIGHT_FLOOR and NIGHT_TOP, so both keep the same
 * margin. */
export function storeNight( group: keyof typeof STORE_RANGE, skyMix: readonly number[] | null ): number {

	const rows = STORE_RANGE[ group ];
	let top = 0, floor = 0;
	for ( let s = 0; s < rows.length; s ++ ) {

		const share = skyMix ? skyMix[ s ] ?? 0 : s === 0 ? 1 : 0;
		top += share * rows[ s ][ 0 ];
		floor += share * rows[ s ][ 1 ];

	}
	return ( NIGHT_TOP + NIGHT_FLOOR - top - floor ) / 2;

}

// The low sun's key: the key (the island's and the sea's sunlight) takes a gain by the sun's
// elevation (degrees, descending; linear between rows, the last row held down to the horizon). The
// shade, lit by the sky, does not move; the disk and the sky's own sun are untouched.
export const LOW_KEY: readonly { at: number; gain: number }[] = LOOK.lowKey;

// a gain by the sun's elevation from rows of descending elevation: linear between rows, the end
// rows held beyond
export function byElevation<K extends string>( rows: readonly ( { at: number } & Record<K, number> )[], elevation: number, key: K ): number {

	if ( elevation >= rows[ 0 ].at ) return rows[ 0 ][ key ];
	for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		const t = ( elevation - rows[ i ].at ) / ( rows[ i - 1 ].at - rows[ i ].at );
		return rows[ i ][ key ] + ( rows[ i - 1 ][ key ] - rows[ i ][ key ] ) * t;

	}
	return rows[ rows.length - 1 ][ key ];

}

// The distant sea's body (the environment's lower half under its reflection, `seaPanorama`): its
// colour's share of the light that reaches the sea, the sky's irradiance with its clouds (the bake's
// deck irradiance) and the sun's direct light on the level water, in luminance, up to a knee at
// this share of the sun's illuminance (scene units, both at the weather's ambient gain), where it
// is the colour times that illuminance. Tunable: `sky.sea.knee`.
export const seaKnee = tune( 'sky.sea.knee', LOOK.seaKnee, { min: 0.05, max: 1, onChange: markSkyRetune } );

// The key's hue. The optical depth that sets it is capped softly (`sky.key.hueDepth`, the rising
// sun's `sky.key.dawnHueDepth`), while its luminance keeps the full extinction, so a low sun still
// dims as it sets. Above the cap the hue is chosen rather than the air's own course: a white
// while the sun is high (KEY_WHITE: red/green, blue/green), each of the two ratios taking the
// air's change of it in part, by the air's depth in green (`sky.key.reddens` for red/green,
// `.yellows` for blue/green: about none far under the onset, two thirds at it, all of it past twice
// it). The sky and clouds keep their own colours, and the key's luminance is the sun tint's.
const sunHueDepth = tune( 'sky.key.hueDepth', LOOK.keyHue.depth, { min: 1, max: 4, onChange: markSkyRetune } );
const dawnHueDepth = tune( 'sky.key.dawnHueDepth', LOOK.keyHue.dawnDepth, { min: 0.3, max: 4, onChange: markSkyRetune } );
// the key's white: linear red/green and blue/green while the sun is high
const KEY_WHITE = LOOK.keyHue.white;
const keyReddens = tune( 'sky.key.reddens', LOOK.keyHue.reddens, { min: 0.3, max: 1.5, onChange: markSkyRetune } );
const keyYellows = tune( 'sky.key.yellows', LOOK.keyHue.yellows, { min: 0.2, max: 1.2, onChange: markSkyRetune } );

export const luma = ( c: THREE.Color ) => c.r * 0.2126 + c.g * 0.7152 + c.b * 0.0722;

// The key's colour per unit of the sun's illuminance, into `transmittance`: its hue KEY_WHITE
// with the share of the air's change in each ratio its depth gives (the depth capped), its
// luminance the air's full extinction of `tint`.
export function keyHue( transmittance: THREE.Color, tint: THREE.Color, rising: boolean ): THREE.Color {

	const { r, g, b } = transmittance;
	if ( g <= 0 ) return transmittance.setRGB( 0, 0, 0 );
	const depth = - Math.log( g );
	const scale = 1 / Math.pow( 1 + Math.pow( depth / ( rising ? dawnHueDepth() : sunHueDepth() ), 6 ), 1 / 6 );
	const share = ( onset: number ) => scale * ( 1 - Math.exp( - Math.pow( depth / onset, 2.5 ) ) );
	const before = luma( transmittance.clone().multiply( tint ) );
	transmittance.setRGB( KEY_WHITE[ 0 ] * Math.pow( r / g, share( keyReddens() ) ), 1, KEY_WHITE[ 1 ] * Math.pow( b / g, share( keyYellows() ) ) );
	return transmittance.multiplyScalar( before / luma( transmittance ) );

}

// The overall colour on each of the thin layer's two shares (Clouds.ts `keyDirect`, `keyAmbient`),
// by the sun's elevation, the morning's apart (DayKeys.ts `rising`), the night's coming in with
// the clouds' moonlight (`moonShare`). Tunable on debug pages (debug/Tune.ts):
// `sky.streaks.<keyDirect|keyAmbient>.<r|g|b>@<afterglow|golden|low|predawn|sunrise|morning|high|night>`.
const streakKeys = ( prefix: string, keys: StreakKeys ): DayKeys<Rgb> => {

	const range = { min: 0.01, max: 4, scale: 'log' as const, onChange: markSkyRetune };
	const high: DayKey<Rgb> = { at: 30, name: 'high', values: keys.high };
	return tuneKeys( prefix, {
		day: [ { at: - 3, name: 'afterglow', values: keys.afterglow }, { at: 2, name: 'golden', values: keys.golden }, { at: 8, name: 'low', values: keys.low }, high ],
		rising: [ { at: - 3, name: 'predawn', values: keys.predawn }, { at: 2, name: 'sunrise', values: keys.sunrise }, { at: 8, name: 'morning', values: keys.morning }, high ],
		night: keys.night,
	}, { r: range, g: range, b: range } );

};
export const STREAK_DIRECT = streakKeys( 'sky.streaks.keyDirect', LOOK.streakDirect );
export const STREAK_AMBIENT = streakKeys( 'sky.streaks.keyAmbient', LOOK.streakAmbient );

// The moon's key's colour as the look writes it (the island's moonlight takes the tuned hue over
// it, `moonHue`), its level the moon's light above the air through the air toward the moon
// (`moonAboveAir`), as the sun's key is the sun's through the air toward the sun; how bright the
// night shows is the exposure's (post/Exposure.ts). The island's moonlight takes a hue of its own
// (`moonHue`), and the clouds' direct moonlight the same; the moonlit sky, the clouds' sky light
// and the haze take the moon's light above the air at their own hue (MOON_SKY_HUE).
export const MOON_KEY = LOOK.moonKey.colour;
// MOON_KEY's red and blue over green, as the look writes them (the quotients of its channels may
// differ by an ulp), so a hue equal to them is exactly one, and its Rec. 709 luminance, the level
// the hue keeps
const MOON_KEY_RED = LOOK.moonKey.red, MOON_KEY_BLUE = LOOK.moonKey.blue;
export const luminance709 = ( r: number, g: number, b: number ) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
export const MOON_KEY_LUMINANCE = luminance709( MOON_KEY[ 0 ], MOON_KEY[ 1 ], MOON_KEY[ 2 ] );
// The moonlit sky's colour at unit luminance. The moonlit sky, the haze's moonlight and the
// clouds' sky light keep it; their level is the sun's sky at the moon's height (`track`). The
// sky's night key itself stays the sun's deep twilight key.
export const MOON_SKY_HUE = LOOK.moonSkyHue;

// The night's ambient's colour at unit luminance (`displayNightAmbient`).
export const NIGHT_AMBIENT_HUE = LOOK.nightAmbientHue;
// The night's ambient in the clouds and the distant sea (`displayNightAmbient`), a radiance: a
// uniform sky giving level ground this share of the moon's key on it (its light through the air at
// normal incidence).
export const NIGHT_AMBIENT_SHARE = LOOK.nightAmbientShare;

// The island's moonlight's red and blue over green. They move the moonlit ground's colour without
// its level (the hue keeps MOON_KEY's luminance) and without the moonlit sky's, clouds' and haze's,
// which keep theirs. At MOON_KEY's own (MOON_KEY_RED, MOON_KEY_BLUE) the hue is exactly white.
// The clouds take the same moonlight (`trackClouds`).
const moonKeyRed = tune( 'lighting.moon.red', LOOK.moonHue.red, { min: 0.3, max: 1.2 } );
const moonKeyBlue = tune( 'lighting.moon.blue', LOOK.moonHue.blue, { min: 0.8, max: 4 } );

// The key under cloud, one rule for every sky. Where cloud stands along the key the land does not
// lose the key whole: the land's key keeps mix( floor, 1, T ), T the clouds' transmittance along
// the key (`keyDirectVisibility`), and the floor is the diffuse transmission of a layer of the
// sky's shell and density (Clouds.ts `layerTransmission`) times this share, at most 1: how much of
// what the layer passes down the land keeps as a light along the key, the one knob for how deep
// the clouds shade the land. The sea keeps the same floor (`seaKeyVisibility`; its glint only the
// direct beam, `cloudDirectVisibility`), and under a closed sky the air does (`deckKeyFloor`, by
// overcast's share; lighting/KeyCloud.ts). The floor rides on whichever light keys the scene, the
// moon's by night as the sun's by day; under a closed sky the sun's part of it leaves over the
// last 2.5 degrees before the horizon (Weather.ts `overcastFloorSun`).
// Tunable: `lighting.keyThroughCloud`.
export const KEY_THROUGH_CLOUD = tune( 'lighting.keyThroughCloud', LOOK.keyThroughCloud, { min: 0, max: 4, onChange: markSkyRetune } );

/** The factor per channel that turns MOON_KEY into the tuned hue at MOON_KEY's luminance. */
export function moonHue( target: THREE.Color ): THREE.Color {

	const r = moonKeyRed() / MOON_KEY_RED, b = moonKeyBlue() / MOON_KEY_BLUE;
	const level = MOON_KEY_LUMINANCE / luminance709( MOON_KEY[ 0 ] * r, MOON_KEY[ 1 ], MOON_KEY[ 2 ] * b );
	return target.setRGB( r * level, level, b * level );

}