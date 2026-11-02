// Weather presets, their blending and the auto-weather chain. Bad weather dims and desaturates the
// existing light; it never adds a grey screen veil (docs/art-direction.md). A weather change sweeps
// the sky as a front from upwind, and the island's lighting follows the front's progress over the
// island. No tier or knob alters the weather state (Quality.ts).
//
// The wind is a dimension of its own beside the sky (`WIND_LEVELS`, a heading): any kept sky goes
// with any level, as a day's wind follows the pressure pattern rather than the cloud. A real day's
// wind comes from any side with the weather, and swings right round as a front passes; the
// landscape remembers only the prevailing wind (PREVAILING_HEADING: the meadow's exposure, the rim
// grass's combing, and at sea the swell), so those stay on it while the weather's wind and the wind
// sea turn. Over most coasts the wind
// is force 2 - 4 most of the time, force 5 at times and force 6 or more rarely; a cold front
// often leaves a clear, windy day behind it.
// - Levels (U10, the mean wind 10 m up): light 1.5 m/s, gentle 3.8 (fair's wind, at which the
//   plants and the sea were tuned), fresh 7 and strong 11. The gust factor falls a little as the
//   wind rises (light airs are fitful; a strong wind blows steadily hard): 1.5, 1.4, 1.35, 1.3.
// - A kept sky loads with the gentle wind from the prevailing heading; a parked one with its own
//   (`PRESET_WIND`: rain fresh, a storm's squall strong, fog light). `setWeather` keeps the wind's
//   target unless the parked sky named brings its own; `setWind` changes the wind alone.
// - Auto weather: each change of sky also moves the wind one level at most (`NEXT_WIND`, its
//   stronger levels' weights scaled by the coming sky's `WINDIER`: overcast and cloudy raise the
//   wind more often, fair less, a clear sky as often as the base chain, a cold surge's clear day)
//   and turns it to a new heading: the prevailing 40 degrees plus an offset, nine times in ten a
//   triangular one within +-40 degrees (most often near 0), one time in ten from the opposite
//   quadrant (180 +- 45). Over hundreds of hours the wind is gentle 67 % of the time, fresh 16 %,
//   light 13 % and strong 5 % (strong 6 % under overcast, 4 % under fair;
//   tools/verify-weather-state.mjs measures it). The wind's draws take a random stream of their
//   own, so the sky's sequence is the one it was before the wind had levels.
//
// The auto chain's sky takes its draws from one seeded stream (dwell, pick, the front's length, in
// that order each turn), so its future is known: `forecast` reads it ahead without moving it (the
// game's forecast, src/game/ui/Forecast.ts). The chain counts its dwell down by the frames' steps
// from the frame after a front ends, so a turn comes up to a step either side of the time read
// ahead (tools/verify-weather-state.mjs); the forecast is read again as the weather moves on.
//
// Parked weathers (`PARKED_WEATHER`: rain, storm, fog) slowed every line of work down, so until the
// game needs them as pressure (docs/game-design.md) they are out of the rotation: the auto chain
// never reaches them, the production page refuses them (main.ts falls back to fair) and the default
// checks skip them. Their code stays and keeps compiling; debug builds (the dev server, `?debug`)
// still reach every preset, so captures, probes and a later revival can use them. Under their deck
// they take what overcast's share takes, counting as overcast in `skyMix`: the level air and the sky
// gain (DECK_SKY_GAIN), the land's own sky gain under overcast (lighting/AmbientRelight.ts
// OVERCAST_LAND), overcast's sky shape (weather/VolumetricHaze.ts) and the exposure by the sky with
// overcast's key (post/Exposure.ts), but they keep the key whole (`deckKey` 1).
//
// Beside its fields the weather keeps the kept skies' shares in the sky as it stands (`skyMix`,
// a parked sky counting as overcast), blended by a front as the fields are, for the lighting's
// per-weather knobs (lighting/AmbientGrade.ts).

export type WeatherName = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog';

export const PARKED_WEATHER: ReadonlyArray<WeatherName> = [ 'rain', 'storm', 'fog' ];
export const isParkedWeather = ( name: string ): boolean => ( PARKED_WEATHER as readonly string[] ).includes( name );
/** The kept skies, in the order of `Weather.skyMix`. */
export const KEPT_SKIES: ReadonlyArray<WeatherName> = [ 'clear', 'fair', 'cloudy', 'overcast' ];

/** The cloud in the weather's blend of the kept skies (`skyMix`): the cloudy sky's share and the
 * overcast sky's, none under a clear or a fair sky. */
export function cloudedShare( skyMix: readonly number[] ): number {

	return ( skyMix[ 2 ] ?? 0 ) + ( skyMix[ 3 ] ?? 0 );

}

const smooth01 = ( t: number ) => {

	const s = Math.min( Math.max( t, 0 ), 1 );
	return s * s * ( 3 - 2 * s );

};

/** How far a cloudy sky's deck has taken over its own light at the sun's `elevation` (degrees): 0
 * up to 3 degrees, 1 from 6, smooth between. Below it a low sun shines under the broken deck and the
 * evening's light takes over (post/Exposure.ts, the clouded keys under 6 degrees). */
export function deckRamp( elevation: number ): number {

	return smooth01( ( elevation - 3 ) / 3 );

}

/** How far overcast's closed deck holds its own light at the sun's `elevation` (degrees): whole at
 * every height by day, since a closed deck does not break up at a low sun, and fading only with the
 * sun's own light over the civil twilight, 0 to -6 degrees (the sky's light, Sky.ts
 * `TWILIGHT_END`), into the night. */
export function overcastDeckLight( elevation: number ): number {

	return smooth01( ( elevation + 6 ) / 6 );

}

/** The deck's light at the sun's `elevation` (degrees) under the weather's cloud `clouded`
 * (`cloudedShare`), of which overcast's share is `overcast`: each clouded sky's share times how far
 * its own deck holds (`deckRamp`, `overcastDeckLight`). 0 under a clear or a fair sky. */
export function deckLight( elevation: number, clouded: number, overcast: number ): number {

	return ( clouded - overcast ) * deckRamp( elevation ) + overcast * overcastDeckLight( elevation );

}

/** How far the deck has taken over the weather's own fields at the sun's `elevation`: `deckLight`
 * over the clouded share. Under it the land keeps the weather's `deckKey` of the key and the
 * clouds' shadow its `deckFloor` (main.ts `publishLighting`, Sky.ts `keyCloudFloor`); a clear or a
 * fair sky has no deck fields of its own (`deckKey` 1, `deckFloor` its `cloudFloor`). */
export function deckTakeover( elevation: number, clouded: number, overcast: number ): number {

	return clouded > 0 ? deckLight( elevation, clouded, overcast ) / clouded : 0;

}

/** Overcast's soft key on the land (the light its closed deck lets through from about the sun's
 * place), over the deck's sky irradiance over pi (Sky.ts `skyIrradiance`, times the sky's fill), by
 * luminance and on level ground (the key's luminance times its lifted height, KeyLift.ts): under the
 * closed deck the land's key is this times the sky's light at every sun height from
 * OVERCAST_SOFT_FADE degrees up (in place of the
 * weather's `deckKey` of the sun's), so it is a fixed part of the land's sky light, tied to the
 * deck's light rather than a dimmed sun. The land under the deck is lit well over the deck's own
 * light by its gain, so the sun's strength above the clouds bounds nothing there. With the land's own
 * sky gain (lighting/AmbientRelight.ts OVERCAST_LAND) it sets the share of the land's light the key
 * carries: the key's direct irradiance on open level ground over that plus the land's ambient
 * irradiance there, about 0.43 to 0.46 from 6 to 30 degrees, morning and evening alike. It lives
 * where the sun's own key does: it fades into the weather's share of the sun's key over the last
 * OVERCAST_SOFT_FADE degrees above the horizon, so the land's light stays continuous as the sun's
 * centre sets (where the sun's key ends) and through the moon's handoff, and a moon's key takes
 * none. The sky's light it reads is the last bake's: on a day much faster than the
 * default (`dayLength`) it lags the sun by a bake or two. Tunable: `lighting.overcastSoftKey`
 * (main.ts). */
export const OVERCAST_SOFT_KEY = 15;
/** The sun's heights (degrees) over which overcast's soft key fades out toward the horizon
 * (`overcastSoftKeyIn`): from 5 down to 0, below the 6 degrees from which its share holds. Over it
 * and through the twilight the island view's meadow and rock under the deck move by at most about
 * 0.006 in Oklab L per tenth of a degree. */
export const OVERCAST_SOFT_FADE = 5;

/** How far overcast's soft key holds at the sun's `elevation` (degrees): whole from
 * OVERCAST_SOFT_FADE up, none from the horizon down, smooth between. */
export function overcastSoftKeyIn( elevation: number ): number {

	return smooth01( elevation / OVERCAST_SOFT_FADE );

}

/** The share of the key `key` (its luminance) the land keeps at the sun's `elevation` under the
 * weather's cloud `clouded` (`cloudedShare`), of which overcast's share is `overcast`, with the
 * weather's `deckKey`: `deckKey` as the deck takes over (`deckTakeover`), and under overcast's deck,
 * while the sun's key holds it (`overcastSoftKeyIn`; none for a moon's key, `moon`), its soft key,
 * `cap` (OVERCAST_SOFT_KEY) times the deck's sky irradiance over pi `sky` (its luminance) on level
 * ground (the key's lifted height `height`). 1 under a clear or a fair sky. */
export function landKeyShare( elevation: number, clouded: number, overcast: number, deckKey: number, key: number, sky: number, height: number, moon: boolean, cap = OVERCAST_SOFT_KEY ): number {

	const share = 1 + ( deckKey - 1 ) * deckTakeover( elevation, clouded, overcast );
	const held = moon ? 0 : overcast * overcastSoftKeyIn( elevation );
	const soft = held > 0 && key > 0 && height > 0 ? cap * sky / ( key * height ) : share;
	return share + ( soft - share ) * held;

}

/** The sky's light on the land and in the water under a closed deck, over the sky's irradiance bake
 * (lighting/AmbientRelight.ts, the probes' sky; ocean/Water.ts, the body's in-scatter): one gain
 * for both. It stands in for the soft key the land keeps under cloud: the light that comes
 * through a deck from about the sun's place, broader than the sun's own key, which the bake's one
 * panorama does not carry onto the land and the water body, so without it the land stood near four
 * stops under the deck and the sea dark under it. 3 sets the sky about three stops over the meadow
 * under a cloudy deck. It comes in with the deck's light (`deckLight`). Under overcast the land's
 * sky light takes a gain of its own over it (lighting/AmbientRelight.ts OVERCAST_LAND); the water
 * keeps this, whichever reads it (the water drawn, the sea's bounce onto the land). */
export const DECK_SKY_GAIN = 3;

/** The sky gain at the sun's `elevation` (degrees) under the weather's cloud `clouded`
 * (`cloudedShare`), of which overcast's share is `overcast`: 1 without a deck, DECK_SKY_GAIN under a
 * closed one by day. */
export function deckSkyGain( elevation: number, clouded: number, overcast: number ): number {

	return 1 + ( DECK_SKY_GAIN - 1 ) * deckLight( elevation, clouded, overcast );

}

/** The part of `deckSkyGain` a cloudy deck's gaps take back, times the clouds' visibility where
 * the water takes it (ocean/Water.ts): the deck's gain stands for the soft key through a closed
 * deck, and in a gap the water takes the key itself, so a gap's sea stands under the land the sun
 * lights there. Overcast's closed deck has no gaps (its clouds' shadow is cast thin,
 * `shadowDensity`), so its gain stays whole. */
export function deckSkyGap( elevation: number, clouded: number, overcast: number ): number {

	return ( DECK_SKY_GAIN - 1 ) * ( clouded - overcast ) * deckRamp( elevation );

}

/** How far a clouded day's high sun has come in at the sun's `elevation` (degrees) under the
 * weather's blend of the kept skies (`skyMix`): none under a clear or a fair sky, nor up to `low`
 * degrees, the sky's clouded share from 40 up, where the sky's light (Sky.ts SKY_LIGHT) has reached
 * its high key. The near air (HazeKeys.ts) follows it from 30, the light lent to the island (Sky.ts
 * CLOUD_LIGHT_TINT) from 12, with the sky's light's own climb, so a clouded noon's land stays as
 * dark and green as its afternoon's. */
export function cloudedHighSun( elevation: number, skyMix: readonly number[], low = 30 ): number {

	const t = Math.min( Math.max( ( elevation - low ) / ( 40 - low ), 0 ), 1 );
	return cloudedShare( skyMix ) * t * t * ( 3 - 2 * t );

}
// a sky's share of each kept sky: its own, or overcast's for a parked one
const skyShares = ( name: WeatherName ): number[] => {

	const at = KEPT_SKIES.indexOf( name );
	return KEPT_SKIES.map( ( _, i ) => i === ( at < 0 ? KEPT_SKIES.indexOf( 'overcast' ) : at ) ? 1 : 0 );

};

export interface WeatherState {

	coverage: number;
	density: number;
	directVisibility: number;
	// The share of the key's direct light the land keeps under the thickest cloud: the floor of the
	// clouds' shadow on the island (Sky.ts `keyCloudVisibility`). 1 takes the deck's shadow away,
	// leaving `directVisibility` alone to set the land's direct light.
	cloudFloor: number;
	// Under a deck (`deckTakeover`): the share of the key the land keeps (the sun's light on the
	// land, its bounce and the air's sunlit haze, not the sea's), and the clouds' shadow floor that
	// takes over from `cloudFloor`. A cloudy sky keeps its key whole and lifts its floor to 0.36, so
	// its gaps still read and its shade stays soft; overcast keeps 0.7 of the key where its deck
	// takes over, and once it has, a soft light along the sun tied to the deck's light
	// (`landKeyShare`), with no clouds' shadow (floor 1): the light a closed deck lets through from
	// about the sun's place, whose cosine still shows on the slopes. It keeps the cast shadows of
	// everything taller than the sward: with the key a little under half the land's light, a full
	// shadow leaves the ground about 0.85 of the lit in lightness, nearly nothing looking away from
	// the sun and long soft shadows toward it.
	// The parked skies keep the key whole (1, floor 0): they have no cut of their own.
	deckKey: number;
	deckFloor: number;
	// How much of the key's cast shadow (the sun's map: groves, cliffs, culms) the land shows, 1 all
	// of it (lighting/SolarShadow.ts `installOpenShadow`).
	castShadow: number;
	// The share of the deck's optical depth its shadow is cast with (sky/Clouds.ts `shadowDensity`):
	// 1 casts the deck's own, less lets more of the sun through the same clouds.
	shadowDensity: number;
	// How far the key's glint widens toward a rough lobe (lighting/SurfaceBRDF.ts `keyGlint`): 0
	// keeps the disk's representative point as it is, in every weather so far; a knob for wet ones.
	glintSpread: number;
	ambientGain: number;
	// The air's haze, per metre: the extinction, in the band whose spectral weight is 1 (blue on a
	// clear day: the hour's key gives the bands' weights, weather/HazeKeys.ts), of the ground layer's
	// deep part, under its soft top (the hour's key's shape: weather/HazeKeys.ts,
	// weather/VolumetricHaze.ts). A clear or fair day's is 2e-3; under a deck the air is dense near
	// the sea and clear aloft (its shape per sky: weather/HazeKeys.ts), a cloudy sky's about the
	// clear day's, an overcast sky's about five times it; rain and fog thicken it. The hour's key
	// scales it.
	haze: number;
	// The haze near the camera: the optical depth from the camera out to a distance is `nearDensity`
	// times the far medium's up to `nearStart` metres, eased back to 1 by `nearEnd` and 1 beyond
	// (weather/VolumetricHaze.ts). Under the kept skies the island's views read through a thin near
	// air while every ray past `nearEnd`, the horizon's and the sky's, keeps its depth (tunable,
	// weather/HazeKeys.ts). A parked sky's `skyMix` is overcast's, so it takes overcast's values: the
	// haze reads these three from the kept skies' presets only, and a parked preset holds them for
	// the state's fields (`fields` below). A clear or fair sky's air is
	// a fifth as dense as an overcast one's, so it gives its depth back over a short shell that the
	// far sea starts in. A clouded sky's shell ends between: shorter (380 m under the cloudy sky) it
	// stands as a pale wall over the fully grown island's far half, longer the far sea falls dark
	// under the sky's low band. The cloudy sky's shell spans 100 to 700 m: from a horizon view (the
	// eye about 12 m up), in an air five times its present density, the far sea's first 5 degrees
	// under the horizon fell about 0.05 L a degree through the air given back (0.056 from 250 to
	// 430 m, with a step of 0.13 L within a degree, 0.07 to 0.085 from 100 to 700: a smoothstep in
	// distance still gathers its catch-up a little, a shorter ramp steps more and a longer one moves
	// the fall to the horizon's line). In the present air (weather/HazeKeys.ts) the fall is about
	// 0.025 - 0.03 L a degree, with steps of 0.08 - 0.09 within a degree.
	nearDensity: number;
	nearStart: number;
	nearEnd: number;
	// The weather's one wind, which every part of the scene takes from weather/Wind.ts. The mean
	// wind 10 m up (U10), m/s: its level's (`WIND_LEVELS`).
	windSpeed: number;
	// Degrees, in the ocean spectrum's heading convention: the wind comes from the heading and
	// travels toward the heading plus 180 degrees (40, the prevailing wind: toward 220 degrees,
	// atan2( z, x ) in the world's x-z plane). The sea's spectrum stays on the prevailing heading
	// (Wind.ts `spectrumWind`).
	windDirection: number;
	// The gust factor, a 3 s gust over the mean wind (about 1.2 - 1.3 over open sea, 1.4 - 1.5
	// over land), its level's; the plants' gusts lean them by its excess pressure (Wind.ts).
	gustiness: number;
	rain: number;
	// Sea fog: 0 none, 1 a ground layer whose deep part sees 1 km in green, the threshold of fog
	// (below it mist). It thickens the haze's ground layer (VolumetricHaze.ts `fogExtinction`).
	fog: number;
	// Thunderstorm: lightning, storm seas and whitecaps (0 none, 1 a full storm).
	storm: number;
	// Thin, high cirrus veils above the cumulus layer.
	cirrus: number;
	wetness: number;
	// Rain that fell recently: showers linger in the air nearby for a few minutes after the
	// rain overhead stops, long enough for a rainbow (0 to 1).
	showers: number;

}

/** A transition's endpoint: a sky and a wind. */
type Preset = Omit<WeatherState, 'wetness' | 'showers'>;
type WindFields = 'windSpeed' | 'windDirection' | 'gustiness';
/** A sky preset: everything but the wind. */
type SkyPreset = Omit<Preset, WindFields>;

export type WindLevel = 'light' | 'gentle' | 'fresh' | 'strong';
export const WIND_LEVELS: Readonly<Record<WindLevel, Readonly<Pick<WeatherState, 'windSpeed' | 'gustiness'>>>> = {
	light: { windSpeed: 1.5, gustiness: 1.5 },
	gentle: { windSpeed: 3.8, gustiness: 1.4 },
	fresh: { windSpeed: 7, gustiness: 1.35 },
	strong: { windSpeed: 11, gustiness: 1.3 },
};
/** The prevailing wind's heading (degrees, WeatherState `windDirection`'s convention): the
 * weather's wind turns about it, the landscape and the sea's swell keep it. */
export const PREVAILING_HEADING = 40;
/** A wind to set: its level, its heading, or both (what is left out stays). */
export interface WindChoice { level?: WindLevel; heading?: number }
// The parked skies' own winds; a kept sky has none and takes the wind it is given.
const PRESET_WIND: Partial<Record<WeatherName, WindLevel>> = { rain: 'fresh', storm: 'strong', fog: 'light' };

// The atmosphere retains its colour. Cloud extinction, diffuse fill and distant air change
// together; none of these presets adds a grey screen veil. Fog is a low layer over the sea that
// the camera looks through, not a tint over the frame.
// The island's direct light under cloud: a cloudy sky's cumulus pass the full sun through their
// gaps; at a low sun their shadow keeps about 8 % of it (`cloudFloor`), and once their deck has
// taken over (from 6 degrees, `deckRamp`) 36 % (`deckFloor`), so the gaps still read and the shade
// under the deck stays soft, its sky light lifted by the deck (DECK_SKY_GAIN). Overcast is a closed
// dark deck at every sun height (`overcastDeckLight`): the key comes through at `directVisibility`
// 0.7 (the sea takes that key whole), and the land takes it as a soft light along the sun tied to
// the deck's own light down to the last few degrees above the horizon (`landKeyShare`,
// OVERCAST_SOFT_KEY, OVERCAST_SOFT_FADE; its `deckKey` 0.7 counts only at the lowest sun and through
// the twilight, and through a change of weather), with no clouds' shadow
// (`deckFloor` 1) and the island's own cast shadows (`castShadow` 1) save the sward's on itself,
// whose shade in that key is its canopy's (post/MeadowShade.ts `swardShadeRelease`), lit soft beneath the deck
// by its sky light (DECK_SKY_GAIN, and the land's own gain, lighting/AmbientRelight.ts
// OVERCAST_LAND) and exposed by the sky (post/Exposure.ts). Its
// clouds' shadow is cast at a share of the deck's optical depth (`shadowDensity`), which the sea's
// key and the moon's take; the land takes it only by night, when the deck's own light has left.
export const WEATHER_PRESETS: Readonly<Record<WeatherName, Readonly<SkyPreset>>> = {
	clear: { coverage: 0, density: 0.8, directVisibility: 1, cloudFloor: 0, deckKey: 1, deckFloor: 0, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 1, haze: 0.002, nearDensity: 0.2, nearStart: 200, nearEnd: 350, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	fair: { coverage: 0.32, density: 0.9, directVisibility: 0.97, cloudFloor: 0, deckKey: 1, deckFloor: 0, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 0.99, haze: 0.002, nearDensity: 0.2, nearStart: 200, nearEnd: 350, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	cloudy: { coverage: 0.67, density: 1.05, directVisibility: 1, cloudFloor: 0.08, deckKey: 1, deckFloor: 0.36, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 0.91, haze: 0.0021, nearDensity: 0.13, nearStart: 100, nearEnd: 700, rain: 0, fog: 0, storm: 0, cirrus: 0.15 },
	overcast: { coverage: 0.94, density: 1.6, directVisibility: 0.7, cloudFloor: 0, deckKey: 0.7, deckFloor: 1, castShadow: 1, shadowDensity: 0.03, glintSpread: 0, ambientGain: 0.76, haze: 0.00974, nearDensity: 0.08, nearStart: 250, nearEnd: 500, rain: 0, fog: 0.08, storm: 0, cirrus: 0 },
	rain: { coverage: 1, density: 2.6, directVisibility: 0.14, cloudFloor: 0, deckKey: 1, deckFloor: 0, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 0.62, haze: 0.0095, nearDensity: 1, nearStart: 250, nearEnd: 600, rain: 0.75, fog: 0.22, storm: 0, cirrus: 0 },
	// A squall: the darkest deck, heavy rain, a strong wind (PRESET_WIND) and a rough, white-capped sea.
	storm: { coverage: 1, density: 3.4, directVisibility: 0.06, cloudFloor: 0, deckKey: 1, deckFloor: 0, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 0.45, haze: 0.0135, nearDensity: 1, nearStart: 250, nearEnd: 600, rain: 1, fog: 0.3, storm: 1, cirrus: 0 },
	// Sea fog forms in calm, moist air under thin high cloud; the sun shows as a pale disk.
	fog: { coverage: 0.75, density: 0.85, directVisibility: 0.6, cloudFloor: 0, deckKey: 1, deckFloor: 0, castShadow: 1, shadowDensity: 1, glintSpread: 0, ambientGain: 0.92, haze: 0.0046, nearDensity: 1, nearStart: 250, nearEnd: 600, rain: 0, fog: 1, storm: 0, cirrus: 0.4 },
};

// Auto weather: from each state, the next one and its weight. The chain moves among the kept
// presets only (PARKED_WEATHER never appears): cloud thickens through cloudy to overcast and clears
// back the same way; fair weather is the most common resting state. The parked states keep a way
// back, for a page that loaded one in a debug build.
const NEXT: Readonly<Record<WeatherName, ReadonlyArray<readonly [ WeatherName, number ]>>> = {
	clear: [ [ 'fair', 0.75 ], [ 'cloudy', 0.25 ] ],
	fair: [ [ 'clear', 0.35 ], [ 'cloudy', 0.5 ], [ 'overcast', 0.15 ] ],
	cloudy: [ [ 'fair', 0.6 ], [ 'overcast', 0.4 ] ],
	overcast: [ [ 'cloudy', 0.7 ], [ 'fair', 0.3 ] ],
	rain: [ [ 'overcast', 0.6 ], [ 'cloudy', 0.4 ] ],
	storm: [ [ 'overcast', 1 ] ],
	fog: [ [ 'clear', 0.4 ], [ 'fair', 0.6 ] ],
};

// Auto weather's wind: from each level, the next one and its weight, before the coming sky's bias
// (`WINDIER` scales the weights of the levels above the current one). The wind moves one level at
// most per change of sky.
const NEXT_WIND: Readonly<Record<WindLevel, ReadonlyArray<readonly [ WindLevel, number ]>>> = {
	light: [ [ 'light', 0.2 ], [ 'gentle', 0.8 ] ],
	gentle: [ [ 'light', 0.15 ], [ 'gentle', 0.71 ], [ 'fresh', 0.14 ] ],
	fresh: [ [ 'gentle', 0.6 ], [ 'fresh', 0.2 ], [ 'strong', 0.2 ] ],
	strong: [ [ 'fresh', 0.7 ], [ 'strong', 0.3 ] ],
};
const WIND_ORDER: ReadonlyArray<WindLevel> = [ 'light', 'gentle', 'fresh', 'strong' ];
const WINDIER: Readonly<Record<WeatherName, number>> = { clear: 1, fair: 0.7, cloudy: 1.3, overcast: 1.6, rain: 1.6, storm: 2, fog: 0.3 };

/** A weather change as it sweeps the sky: values at the start and end, and the linear
 * progress reached at the island. Places upwind are further along, places downwind behind, by a
 * lead that grows from nothing as the front sets out and closes as it ends (Sky.ts `frontLead`). */
export interface WeatherFront {
	from: Readonly<Preset>;
	to: Readonly<Preset>;
	progress: number;
}

/** A change of sky in the forecast: when its front starts (seconds of the weather's clock from
 * now; negative for the front under way), how long it takes, and the skies it moves between. */
export interface WeatherTurn {
	at: number;
	duration: number;
	from: WeatherName;
	to: WeatherName;
}

// mulberry32: one draw from a seed, and the seed after it
function mulberry32( seed: number ): { seed: number; value: number } {

	const s = ( seed + 0x6D2B79F5 ) | 0;
	let t = Math.imul( s ^ ( s >>> 15 ), s | 1 );
	t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
	return { seed: s, value: ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296 };

}

// The auto chain's next sky from the current one, for a draw in [ 0, 1 ).
function nextSky( name: WeatherName, pick: number ): WeatherName {

	const options = NEXT[ name ];
	for ( const [ next, weight ] of options ) {

		if ( pick < weight ) return next;
		pick -= weight;

	}
	return options[ options.length - 1 ][ 0 ];

}

const fields = [ ...Object.keys( WEATHER_PRESETS.clear ), 'windSpeed', 'windDirection', 'gustiness' ] as ( keyof Preset )[];
// The auto-weather chain's seeds (mulberry32), at construction and at `establish`: the sky's, and
// the wind's own stream.
const SEED = 0x5eed;
const WIND_SEED = 0x3b1d;
const smooth = ( t: number ) => t * t * ( 3 - 2 * t );
const smoothIntegral = ( t: number ) => t * t * t * ( 1 - 0.5 * t );
// Signed change of heading along the shorter arc, so 350° to 10° turns 20°, not 340°.
const headingDelta = ( from: number, to: number ) => ( ( ( to - from ) % 360 ) + 540 ) % 360 - 180;
const wrapHeading = ( heading: number ) => ( ( heading % 360 ) + 360 ) % 360;

function presetFor( name: WeatherName ): Readonly<SkyPreset> {

	if ( ! Object.hasOwn( WEATHER_PRESETS, name ) ) throw new RangeError( `Unknown weather preset: ${ String( name ) }` );
	return WEATHER_PRESETS[ name ];

}

export const isWindLevel = ( name: unknown ): name is WindLevel => typeof name === 'string' && Object.hasOwn( WIND_LEVELS, name );

function requireWind( { level, heading }: WindChoice ): void {

	if ( level !== undefined && ! isWindLevel( level ) ) throw new RangeError( `Unknown wind level: ${ String( level ) }` );
	if ( heading !== undefined && ( typeof heading !== 'number' || ! Number.isFinite( heading ) ) ) throw new RangeError( 'Wind heading must be a finite number' );

}

// A sky with a wind: the endpoint of a transition.
const endpoint = ( name: WeatherName, level: WindLevel, heading: number ): Preset =>
	( { ...presetFor( name ), ...WIND_LEVELS[ level ], windDirection: heading } );

function requireDuration( value: number, label: string ): void {

	if ( ! Number.isFinite( value ) || value < 0 ) throw new RangeError( `${ label } must be a finite, non-negative number` );

}

export class Weather {

	private current: WeatherState;
	private from: Preset;
	private destination: Readonly<Preset>;
	private targetName: WeatherName;
	// the sky the front under way left (the target itself once it has arrived)
	private originName: WeatherName;
	private windLevel: WindLevel;
	private windHeading: number;
	// the kept skies' shares in the sky as it stands (`skyMix`), blended as the state's fields are
	private mix: number[];
	private mixFrom: number[];
	private mixTo: number[];
	private elapsed = 0;
	private duration = 0;
	// Auto weather: a seeded chain, so a given start and time always give the same sky and wind.
	auto = false;
	private dwell = 0;
	private seed = SEED;
	private windSeed = WIND_SEED;

	/** `wind` overrides the wind the sky loads with (the gentle wind from the prevailing heading,
	 * or a parked sky's own). */
	constructor( name: WeatherName = 'fair', wind: WindChoice = {} ) {

		presetFor( name );
		requireWind( wind );
		this.windLevel = wind.level ?? PRESET_WIND[ name ] ?? 'gentle';
		this.windHeading = wrapHeading( wind.heading ?? PREVAILING_HEADING );
		const preset = endpoint( name, this.windLevel, this.windHeading );
		// Loading a rainy preset represents established weather for repeatable review captures.
		// Subsequent weather changes preserve moisture and let the independent drying model run.
		this.current = { ...preset, wetness: preset.rain * 0.8, showers: preset.rain };
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;
		this.originName = name;
		this.mixTo = skyShares( name );
		this.mixFrom = [ ...this.mixTo ];
		this.mix = [ ...this.mixTo ];

	}

	/** Jumps to `name` (and `wind`, as the constructor takes it) as established weather, the way
	 * loading it does: no transition, a sky without a front, the ground as wet as the constructor
	 * leaves it, and the auto-weather chain from its seeds. */
	establish( name: WeatherName, wind: WindChoice = {} ): void {

		presetFor( name );
		requireWind( wind );
		this.windLevel = wind.level ?? PRESET_WIND[ name ] ?? 'gentle';
		this.windHeading = wrapHeading( wind.heading ?? PREVAILING_HEADING );
		const preset = endpoint( name, this.windLevel, this.windHeading );
		Object.assign( this.current, preset, { wetness: preset.rain * 0.8, showers: preset.rain } );
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;
		this.originName = name;
		this.mixTo = skyShares( name );
		this.mixFrom = [ ...this.mixTo ];
		this.mix = [ ...this.mixTo ];
		this.elapsed = 0;
		this.duration = 0;
		this.dwell = 0;
		this.seed = SEED;
		this.windSeed = WIND_SEED;

	}

	get state(): Readonly<WeatherState> { return this.current; }
	get target(): WeatherName { return this.targetName; }
	/** The sky the front under way set out from (the target once it has arrived). */
	get origin(): WeatherName { return this.duration > this.elapsed ? this.originName : this.targetName; }
	/** The wind the weather is at or moving to: its level and heading (0 - 360 degrees). */
	get windTarget(): { level: WindLevel; heading: number } { return { level: this.windLevel, heading: this.windHeading }; }
	get progress(): number { return this.duration > 0 ? this.elapsed / this.duration : 1; }
	get front(): WeatherFront { return { from: this.from, to: this.destination, progress: this.progress }; }

	snapshot(): WeatherState { return { ...this.current }; }
	/** The kept skies' shares in the sky as it stands (KEPT_SKIES' order, summing to 1): a front
	 * moves them from where they stood to its target's as it moves the state's fields; a parked sky
	 * counts as overcast. The lighting's per-weather knobs weight their columns by it
	 * (lighting/AmbientGrade.ts). */
	get skyMix(): readonly number[] { return this.mix; }

	/** Moves to the sky `name` over `duration` seconds. The wind keeps its target unless `wind`
	 * names one, or the sky is a parked one with a wind of its own. */
	setWeather( name: WeatherName, duration = 20, wind: WindChoice = {} ): void {

		presetFor( name );
		requireDuration( duration, 'Weather transition duration' );
		requireWind( wind );
		this.moveTo( name, wind.level ?? PRESET_WIND[ name ] ?? this.windLevel, wind.heading ?? this.windHeading, duration );

	}

	/** Moves the wind alone to `wind` (its level, its heading or both) over `duration` seconds,
	 * the sky keeping its target. */
	setWind( wind: WindChoice, duration = 20 ): void {

		requireWind( wind );
		requireDuration( duration, 'Weather transition duration' );
		this.moveTo( this.targetName, wind.level ?? this.windLevel, wind.heading ?? this.windHeading, duration );

	}

	private moveTo( name: WeatherName, level: WindLevel, heading: number, duration: number ): void {

		const preset = endpoint( name, level, wrapHeading( heading ) );
		// Start from the displayed state, including mid-transition values. Reversals never jump
		// back to the previous named preset, and every new transition eases out of its snapshot.
		this.from = { ...this.current };
		this.destination = preset;
		this.originName = this.targetName;
		this.targetName = name;
		this.mixFrom = [ ...this.mix ];
		this.mixTo = skyShares( name );
		this.windLevel = level;
		this.windHeading = preset.windDirection;
		this.elapsed = 0;
		this.duration = duration;
		this.dwell = 0;
		if ( duration === 0 ) {

			for ( const key of fields ) this.current[ key ] = preset[ key ];
			this.mix = [ ...this.mixTo ];

		}

	}

	private random(): number {

		const draw = mulberry32( this.seed );
		this.seed = draw.seed;
		return draw.value;

	}

	// The wind's own stream (mulberry32), so its draws leave the sky's sequence as it was.
	private windRandom(): number {

		const draw = mulberry32( this.windSeed );
		this.windSeed = draw.seed;
		return draw.value;

	}

	/**
	 * The skies the weather moves through over the next `seconds` of its clock (the seconds `update`
	 * is given): the front under way first (its `at` negative), then each turn the auto chain will
	 * take, read ahead from its seeds without moving it (see the header). Without auto weather the
	 * sky holds after the front under way.
	 */
	forecast( seconds: number ): WeatherTurn[] {

		const turns: WeatherTurn[] = [];
		let t = 0;
		if ( this.duration > this.elapsed ) {

			turns.push( { at: - this.elapsed, duration: this.duration, from: this.originName, to: this.targetName } );
			t = this.duration - this.elapsed;

		}
		if ( ! this.auto ) return turns;
		let seed = this.seed, dwell = this.dwell, name = this.targetName;
		while ( t < seconds ) {

			let draw;
			if ( dwell <= 0 ) {

				draw = mulberry32( seed );
				seed = draw.seed;
				dwell = 90 + draw.value * 150;

			}
			t += dwell;
			if ( t >= seconds ) break;
			draw = mulberry32( seed );
			seed = draw.seed;
			const next = nextSky( name, draw.value );
			draw = mulberry32( seed );
			seed = draw.seed;
			const duration = 30 + draw.value * 30;
			turns.push( { at: t, duration, from: name, to: next } );
			name = next;
			t += duration;
			dwell = 0;

		}
		return turns;

	}

	// The wind's next level, one step at most, its stronger options weighted by the coming sky.
	private nextWindLevel( sky: WeatherName ): WindLevel {

		const rank = WIND_ORDER.indexOf( this.windLevel );
		const options = NEXT_WIND[ this.windLevel ].map( ( [ level, weight ] ) =>
			[ level, WIND_ORDER.indexOf( level ) > rank ? weight * WINDIER[ sky ] : weight ] as const );
		let pick = this.windRandom() * options.reduce( ( sum, [ , weight ] ) => sum + weight, 0 );
		for ( const [ level, weight ] of options ) {

			if ( pick < weight ) return level;
			pick -= weight;

		}
		return options[ options.length - 1 ][ 0 ];

	}

	// The wind's next heading: the prevailing one plus an offset, nine times in ten triangular
	// within +-40 degrees, one in ten from the opposite quadrant (180 +- 45).
	private nextWindHeading(): number {

		const offset = this.windRandom() < 0.1 ? 180 + ( this.windRandom() * 2 - 1 ) * 45 : ( this.windRandom() + this.windRandom() - 1 ) * 40;
		return wrapHeading( PREVAILING_HEADING + offset );

	}

	// Rest for 90 to 240 seconds, then move to a neighbouring sky and a new wind over 30 to 60 seconds.
	private advanceAuto( dt: number ): void {

		if ( this.duration > this.elapsed ) return;
		if ( this.dwell <= 0 ) this.dwell = 90 + this.random() * 150;
		this.dwell -= dt;
		if ( this.dwell > 0 ) return;
		const next = nextSky( this.targetName, this.random() );
		const duration = 30 + this.random() * 30;
		this.moveTo( next, this.nextWindLevel( next ), this.nextWindHeading(), duration );

	}

	update( dt: number ): void {

		requireDuration( dt, 'Weather delta time' );
		if ( dt === 0 ) return;
		if ( this.auto ) this.advanceAuto( dt );
		const previous = this.elapsed;
		const transitioning = this.duration > previous;
		let rainIntegral = this.current.rain * dt;
		if ( transitioning ) {

			this.elapsed = Math.min( previous + dt, this.duration );
			const a = previous / this.duration, b = this.elapsed / this.duration;
			const movingTime = this.elapsed - previous;
			// Integrate rainfall across smoothstep, including any time beyond the endpoint. This
			// keeps wetness stable with a large manual time step and with interrupted transitions.
			rainIntegral = this.from.rain * movingTime + ( this.destination.rain - this.from.rain ) * this.duration *
				( smoothIntegral( b ) - smoothIntegral( a ) ) + this.destination.rain * ( dt - movingTime );
			const blend = smooth( b );
			for ( const key of fields ) {

				const delta = key === 'windDirection' ? headingDelta( this.from[ key ], this.destination[ key ] ) : this.destination[ key ] - this.from[ key ];
				this.current[ key ] = b === 1 ? this.destination[ key ] : this.from[ key ] + delta * blend;

			}
			for ( let i = 0; i < this.mix.length; i ++ ) this.mix[ i ] = b === 1 ? this.mixTo[ i ] : this.mixFrom[ i ] + ( this.mixTo[ i ] - this.mixFrom[ i ] ) * blend;

		}

		const rain = Math.min( 1, Math.max( 0, rainIntegral / dt ) );
		const soak = rain / 25, dry = ( 1 - rain ) / 240;
		const rate = soak + dry;
		const equilibrium = soak / rate;
		// Stable bounded moisture: rain darkens exposed material over tens of seconds, whereas
		// drying takes minutes. A zero-time update leaves both transition and wetness untouched.
		this.current.wetness = Math.min( 1, Math.max( 0,
			equilibrium + ( this.current.wetness - equilibrium ) * Math.exp( - rate * dt ) ) );
		this.current.showers = Math.max( this.current.rain, this.current.showers * Math.exp( - dt / 90 ) );

	}

}
