import { tuneObject, type TuneOptions } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';
import { MIX_SKIES, WEATHER_PRESETS } from '../sky/Weather.ts';
import { HAZE_KEY_NAMES, readLook, type FullKey, type HazeKey, type HazeKeyName, type HazeRows } from './Look.ts';

// The haze's look keys, as the renderer reads them (look/Look.ts: the numbers are the installed
// look's, the neutral set's where none is). weather/HazeKeys.ts `hazeKeyAt` eases them by the hour
// and the weather; the haze (weather/VolumetricHaze.ts) takes the result.
//
// The haze's keys: what the air does by the hour and the weather, set as a few quantities one sees
// (how far the light carries, the colour it loses, how bright and how coloured the air shows) at
// a few heights of the sun, the morning's and the evening's apart, and eased between them. A key
// is a function of the sun's elevation, whether it is rising, the weather's blend of the four skies
// (Weather.ts `skyMix`), its wind and its rain, never of the path to them: a paused frame and a
// scene jump hold one value, and a change of hour or weather writes the haze's uniforms only.
//
// Each key holds (look/Look.ts `HazeKey`):
//   - amount: the weather's haze over its preset's;
//   - the medium's shape (VolumetricHaze's header): `top`, the ground layer's top over the sea (m),
//     `width`, the width of its step (m), `aerosolShare`, the deep aerosol layer's density at sea
//     level over the ground layer's, and `aerosolHeight`, its scale height (m); `skyDepth`, a thin
//     haze that fills the air's whole height, which only the sky dome takes (green's optical depth
//     per kilometre of a sky ray's length);
//   - sigma: the medium's spectral extinction, each band's weight on the density;
//   - desaturate: how far each of the haze's two shares of light turns toward its luminance;
//   - mist: a morning mist in the sea fog's units, which thickens the haze's ground layer;
//   - the fog layer (VolumetricHaze's header, The fog layer): `fogLayer` its share, `fogTop` its
//     top over the sea, `fogWidth` the width of its edge, `visibility` the Koschmieder visibility
//     it gives at the sea (km), `neutral` how far its extinction turns grey and `scatter` its
//     droplets' multiple scattering (Wrenninge's a);
//   - sunRayleigh: the sun's share in the haze's Rayleigh light, beside the open sky's;
//   - rayleighWeight, mieWeight: the two shares' weights.
// A look gives a key for each of ten hours (look/Look.ts HAZE_KEY_NAMES) and rows of them by the
// sun's elevation. Four keys hold a medium's shape of their own (the day's, the golden hour's, the
// night's and the mist's: SHAPED); the others take the day's. Three hold a fog layer of their own
// (the day's, the golden hour's and the mist's: FOGGED); the morning takes the mist's, the others
// none (`fogOf`). The weather adds its own per sky of its blend (KEEP, GAIN, SKY_SCALE, DECKED,
// SUN_RAYLEIGH).

export type { FullKey, HazeKey };

const LOOK = readLook( 'haze', 'look/HazeLook.ts' );

/** A key with every field 0, for a reader that fills all of them (weather/HazeKeys.ts). */
export const blankKey = (): FullKey => ( {
	deck: 0, overcastDeck: 0, amount: 0, sigmaRed: 0, sigmaGreen: 0, sigmaBlue: 0, desaturate: 0, gain: 0, mist: 0, sunRayleigh: 0, rayleighWeight: 0, mieWeight: 0,
	top: 0, width: 0, aerosolShare: 0, aerosolHeight: 0, aerosolTop: 0, skyDepth: 0,
	fogLayer: 0, neutral: 0, scatter: 0, fogTop: 0, fogWidth: 0, visibility: 0, droplet: 0, fogCoverHigh: 0,
} );

// the fog layer's fields where a key holds none: the hours without a fog of their own (the night
// and the twilights) hold this
export const NO_FOG = LOOK.noFog;

// The look's keys, each a copy this module owns (its tunables are registered on it).
const KEYS = Object.fromEntries( HAZE_KEY_NAMES.map( ( name ) => [ name, { ...LOOK.keys[ name ] } ] ) ) as Record<HazeKeyName, FullKey>;
export const DAY = KEYS.day, NIGHT = KEYS.night, MIST = KEYS.mist, MORNING = KEYS.morning;
// the keys with a shape are tunable on debug pages (debug/Tune.ts):
// `haze.key.<amount|sigmaRed|sigmaBlue|desaturate|rayleighWeight|mieWeight|top|width|
// aerosolShare|aerosolHeight|skyDepth>@<day|golden|night|mist>` (green is sigma's unit), the
// morning's, the twilight's before dawn (deep and late) and after sunset (the afterglow and the
// deep twilight) their six up to `mieWeight` (`@morning`, `@earlyDawn`, `@beforeDawn`,
// `@afterSunset`, `@afterSunsetDeep`, under cloud `@afterSunsetClouded`)
const SHAPED_NAMES: readonly HazeKeyName[] = [ 'day', 'golden', 'night', 'mist' ];
const TUNED = [ 'amount', 'sigmaRed', 'sigmaBlue', 'desaturate', 'rayleighWeight', 'mieWeight', 'top', 'width', 'aerosolShare', 'aerosolHeight', 'skyDepth' ] as const;
const TUNE_RANGE: Record<typeof TUNED[ number ], TuneOptions> = {
	amount: { min: 0.1, max: 10, scale: 'log', onChange: markSkyRetune }, sigmaRed: { min: 0.05, max: 1.5, scale: 'log', onChange: markSkyRetune },
	sigmaBlue: { min: 0.3, max: 3, scale: 'log', onChange: markSkyRetune }, desaturate: { min: 0, max: 1, onChange: markSkyRetune },
	rayleighWeight: { min: 0.05, max: 40, scale: 'log', onChange: markSkyRetune }, mieWeight: { min: 0.05, max: 50, scale: 'log', onChange: markSkyRetune },
	top: { min: 0, max: 60, onChange: markSkyRetune }, width: { min: 5, max: 300, scale: 'log', onChange: markSkyRetune },
	aerosolShare: { min: 0.003, max: 3, scale: 'log', onChange: markSkyRetune }, aerosolHeight: { min: 300, max: 8000, scale: 'log', onChange: markSkyRetune },
	skyDepth: { min: 0, max: 0.5, onChange: markSkyRetune },
};
for ( const name of HAZE_KEY_NAMES ) {

	const fields = SHAPED_NAMES.includes( name ) ? TUNED : TUNED.slice( 0, 6 );
	tuneObject( KEYS[ name ], Object.fromEntries( fields.map( ( f ) => [ f, `haze.key.${ f }@${ name }` ] ) ), TUNE_RANGE );

}
tuneObject( MIST, { mist: 'haze.key.mist@mist' }, { mist: { min: 0, max: 2, onChange: markSkyRetune } } );
// the fog layer's knobs on the keys that hold one:
// `haze.fog.<top|width|visibility|neutral|scatter>@<day|golden|mist>`, the visibility's range the key's
for ( const [ name, low, high ] of [ [ 'day', 0.2, 1.5 ], [ 'golden', 0.3, 2.5 ], [ 'mist', 0.2, 2 ] ] as const ) {

	const range: Record<'fogTop' | 'fogWidth' | 'visibility' | 'neutral' | 'scatter', TuneOptions> = {
		fogTop: { min: 12, max: 40, onChange: markSkyRetune }, fogWidth: { min: 2, max: 15, onChange: markSkyRetune },
		visibility: { min: low, max: high, scale: 'log', onChange: markSkyRetune },
		neutral: { min: 0, max: 1, onChange: markSkyRetune }, scatter: { min: 0, max: 0.4, onChange: markSkyRetune },
	};
	tuneObject( KEYS[ name ], { fogTop: `haze.fog.top@${ name }`, fogWidth: `haze.fog.width@${ name }`, visibility: `haze.fog.visibility@${ name }`,
		neutral: `haze.fog.neutral@${ name }`, scatter: `haze.fog.scatter@${ name }` }, range );

}

// rows by the sun's elevation (degrees, ascending), eased between neighbours, the end rows held
const rows = ( look: HazeRows ): ReadonlyArray<readonly [ number, FullKey ]> => look.map( ( [ at, name ] ) => [ at, KEYS[ name ] ] as const );
export const RISING = rows( LOOK.rising );
export const SETTING = rows( LOOK.setting );
// the setting sun's under cloud, which a clouded share draws the key to
export const SETTING_CLOUDED = rows( LOOK.settingClouded );

// the keys with a shape of their own; the others take the day's
export const SHAPED: ReadonlySet<FullKey> = new Set( SHAPED_NAMES.map( ( name ) => KEYS[ name ] ) );
// the keys with a fog layer of their own; the morning takes the mist's, the others (the night and
// the twilights) none
export const FOGGED: ReadonlySet<FullKey> = new Set( [ DAY, KEYS.golden, MIST ] );
export const fogOf = ( k: FullKey ): FullKey => FOGGED.has( k ) ? k : k === MORNING ? MIST : NIGHT;
// the sea fog: a deep layer with a soft top, held at every hour while its switch is on; tunable as
// `haze.fog.<field>@sea`
export const SEA_FOG = { ...LOOK.seaFog };
tuneObject( SEA_FOG, { fogTop: 'haze.fog.top@sea', fogWidth: 'haze.fog.width@sea', visibility: 'haze.fog.visibility@sea',
	neutral: 'haze.fog.neutral@sea', scatter: 'haze.fog.scatter@sea', coverHigh: 'haze.fog.coverHigh@sea' }, {
	fogTop: { min: 0, max: 150, onChange: markSkyRetune }, fogWidth: { min: 2, max: 100, onChange: markSkyRetune },
	coverHigh: { min: - 1, max: 2.5, onChange: markSkyRetune },
	visibility: { min: 0.08, max: 2, scale: 'log', onChange: markSkyRetune },
	neutral: { min: 0, max: 1, onChange: markSkyRetune }, scatter: { min: 0, max: 0.6, onChange: markSkyRetune },
} );

// per sky of the blend (Weather.ts MIX_SKIES: clear, fair, cloudy, overcast): the share of the light's
// colour kept over a clear day's and the gain over a clear day's
export const KEEP = LOOK.keep;
export const GAIN = LOOK.gain;
// per sky of the blend, whether a deck ends the aerosol layer at its base (look/SkyLook.ts `cloudBase`)
export const DECKED = LOOK.decked;
// per sky of the blend, the scale of each band's sigma, of the aerosol layer's share and of its scale
// height, of the ground layer's top and width, and the weather's haze (its preset's until tuned)
export const SKY_SCALE = MIX_SKIES.map( ( name, s ) => {

	const { haze } = WEATHER_PRESETS[ name ];
	return { ...LOOK.scales[ s ], haze };

} );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( SKY_SCALE[ s ], { haze: `sky.weather.haze@${ name }` }, { haze: { min: 2e-4, max: 0.02, scale: 'log', onChange: markSkyRetune } } );
	tuneObject( SKY_SCALE[ s ], { sigmaRed: `sky.weather.sigmaRed@${ name }`, sigmaBlue: `sky.weather.sigmaBlue@${ name }`, aerosolScale: `sky.weather.aerosolScale@${ name }`, aerosolHeight: `sky.weather.aerosolHeight@${ name }` },
		{ sigmaRed: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune }, sigmaBlue: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune },
			aerosolScale: { min: 0.1, max: 30, scale: 'log', onChange: markSkyRetune }, aerosolHeight: { min: 0.2, max: 10, scale: 'log', onChange: markSkyRetune } } );
	tuneObject( SKY_SCALE[ s ], { topScale: `sky.weather.topScale@${ name }`, widthScale: `sky.weather.widthScale@${ name }` },
		{ topScale: { min: 0.1, max: 5, scale: 'log', onChange: markSkyRetune }, widthScale: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune } } );

}
// per sky of the blend, the sun's share in the haze's Rayleigh light
export const SUN_RAYLEIGH = LOOK.sunRayleigh;
