import * as THREE from 'three/webgpu';
import { tuneObject, type TuneOptions } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';
import { DUSK_DEPTH, duskForce, duskForced, duskIn, moonKeyShare } from '../sky/DayCycle.ts';
import { KEPT_SKIES, WEATHER_PRESETS, cloudedShare, deckLight, overcastDeckLight } from '../sky/Weather.ts';
import { cloudBase } from '../sky/Sky.ts';
import { FOG_NOISE } from './FogNoise.ts';

// The haze's keys: what the air does by the hour and the weather, set as a few quantities one sees
// (how far the light carries, the colour it loses, how bright and how coloured the air shows) at
// a few heights of the sun, the morning's and the evening's apart, and eased between them. A key
// is a function of the sun's elevation, whether it is rising, the weather's blend of the kept skies
// (Weather.ts `skyMix`), its wind and its rain, never of the path to them: a paused frame and a
// scene jump hold one value, and a change of hour or weather writes the haze's uniforms only.
//
// Each key holds:
//   - amount: the weather's haze over its preset's: 0.66 by day and 0.61 at the golden hour,
//     0.6 before dawn and as the sun rises, a surface layer whose green optical depth reaches 1
//     within about 1.6 km at the sea (where the air aloft is clean, Atmosphere.ts `aerosol`, the
//     dawn's density lies in it), near 1 in the morning, 0.45 after sunset, a thin air that leaves
//     the glow over the horizon no dark band, and by night the day's (see the night's Rayleigh).
//     How far the light carries at a height follows from it and the medium's shape below.
//   - the medium's shape (VolumetricHaze's header): `top`, the ground layer's top over the sea (m),
//     `width`, the width of its step (m), `aerosolShare`, the deep aerosol layer's density at sea
//     level over the ground layer's, and `aerosolHeight`, its scale height (m). Every key's top is
//     14 m, a thin layer on the sea: the day's width 9.4 m, the golden hour's 11.2 m and the
//     night's 10.2 m, each keeping its key's ratio of width to top, so the density at the sea
//     does not depend on the top's height; the day's aerosol 0.06 and 0.76 km, the
//     golden hour's 0.13 and 1.0 km (more aerosol over a low sun's air), and the sunrise's are the
//     golden hour's: thin enough to leave no dark band over the horizon. These shapes are the
//     haze's without the fog layer (below), which takes the ground layer's place by day under a
//     clear or fair sky and keeps them under cloud and by night. Without it, on a clear day green's
//     extinction is about 1e-3 /m at the sea (Koschmieder's visibility 4 km), half that at the top,
//     a tenth of it at 30 m and under 4e-5 /m from 68 m, the game camera's height, up: about eleven
//     times a clean maritime air at the sea (OPAC's maritime clean at 80 % relative humidity, 0.090
//     /km at 550 nm) and thinner than it above the layer, so the island seen from above stays
//     clear and the far sea and the horizon, whose rays run long through the layer, are hazed. The
//     day's, the golden hour's, the sunrise's and the night's are tunable, and the other hours take
//     the day's.
//     `skyDepth` is a thin haze that fills the air's whole height, uniform in height, which only
//     the sky dome takes (VolumetricHaze `skyHaze`): green's optical depth per kilometre of a sky
//     ray's length, 0 in every key until tuned (the keys with a shape of their own are tunable; the
//     other hours keep 0). Over the island's distances, a few kilometres at most, its
//     share is negligible, while the sky's rays (about 100 km straight up, 280 km at 20 degrees,
//     480 km at 10) are long enough for it to close the dome: the moon's disc fades behind it and
//     the low sky turns to the haze's own light, a fog night's look; the clear night keeps 0, its
//     low sky lit by the haze layer itself. The weather's scales leave it as it is.
//   - sigma: the medium's spectral extinction, each band's weight on the density (VolumetricHaze's
//     header), the weather's `haze` the blue's. The day's and the golden hour's were set with
//     the sky's light (Sky.ts SKY_LIGHT): by day red : green : blue = 0.36 : 0.53 : 1.02, at the
//     golden hour 0.41 : 0.53 : 0.83, the air losing its blue first, and by night 0.46 : 0.53 : 0.69.
//     The hours between take these by the sun's elevation (`twilight`): the mist at sunrise the
//     golden hour's (it stands within a degree of the golden key's elevations), the morning the
//     day's (from where the day key starts on the evening side), and the twilight before dawn and
//     after sunset the night's and the golden hour's blended linearly in elevation, at -3.5 degrees
//     before dawn (the middle of its key's rows) and at -2.5 after sunset.
//     The overcast's are still to be set toward grey.
//   - desaturate: how far each of the haze's two shares of light (VolumetricHaze's header) turns
//     toward its luminance: all of it by day (the day's air shows its sky's colour through
//     the haze's sigma, not its own), half in the morning and by night, 0.75 just after sunset and
//     none in the deep twilight, 0.64 as the sun rises, and a third at the golden hour, whose air
//     takes most of the sun's orange. After sunset it sets the colour of the glow over the horizon
//     toward the sun, whose chroma (Oklab) at -3.4 and -5.3 degrees rises about 0.0025 for each
//     tenth less: one value over the whole afterglow (0.4) gave 0.128 at -3.4 and 0.105 at -5.3, the
//     deeper glow the greyer, and the key's other knobs moved both the same
//     way. So it falls with the sun, from 0.75 at -1 degrees to none at -7 (the deep twilight's key,
//     `AFTER_SUNSET_DEEP`, the afterglow's air with the glow's colour kept, where the night's key
//     comes in), which
//     gives 0.125 at -3.4 and 0.112 at -5.3, the deeper glow keeping more of its colour (from 0.75
//     to 0.85 at -1 degrees the two read the same). Under
//     the sunrise's cold light it decides where the air's own warmth shows: the haze's own rows
//     are red toward a low sun, so what it leaves of them lands in the band over the horizon, the
//     high air staying blue; a fast swing, the band from blue to orange within a tenth or two of it.
//     At 0.64 the air's warmth it leaves offsets the blue of the sky light's cool dawn key (Sky.ts
//     SKY_LIGHT `dawn`) in the band, which stays a pale blue grey; 0.72 left the band too blue.
//   - mist: a morning mist in the sea fog's units (VolumetricHaze `fogExtinction`), which thickens
//     the haze's ground layer, soft and low over the whole island, not a sheet on the sea. The
//     clear morning has none: 0 in every key (`haze.key.mist@mist` brings one back), so the sea
//     stays blue out to the horizon. It needs calm air and no rain.
//   - the fog layer (VolumetricHaze's header, The fog layer): by day under a clear or fair sky the
//     ground layer is a fog layer over the whole island, the clear day's density the same at every
//     hour of it. `fogLayer` its share (1 in the day's, the golden hour's and the mist's keys, the
//     morning taking the mist's; 0 by night and in the twilights), `fogTop` its top over the sea
//     (12 m, 12 - 40: below the bamboo's crowns, the island view well above it), `fogWidth` the
//     width of its edge (2 m, 2 - 15), `visibility` the Koschmieder visibility it gives at the
//     sea (km: 0.22 by day and in the morning, 0.2 - 1.5 and 0.2 - 2; 0.29 at the golden hour,
//     about a fifth thinner by the sea's mean opacity, 0.3 - 2.5), `neutral` how far its extinction turns grey (1)
//     and `scatter` its droplets' multiple scattering, Wrenninge's a (0.3 by day, 0.2 at the golden
//     hour and in the morning; 0 - 0.4), which brings the sunlit fog's level up against its shade.
//     The island view at noon sees the sea through about a quarter of the fog's opacity (mean
//     0.26) and the crowns through 0.02; a top above the crowns, or a wider edge, fogs the crowns
//     too, the camera then near or inside the layer. An edge of 2 m shows as a hard line where the
//     layer meets the sky at the horizon; one of 5 m or more does not. The clouded share turns it
//     back into the key's own thin haze (`clouded` below), its droplets' share of the ground
//     layer's light (`droplet`) with it: cloudy keeps its shape, and the air under a deck scatters
//     as the air does, not as fog (the droplets' share left at the key's under cloud lifted the
//     low air over overcast's horizon, away from the sun, about a stop and a third over the air's
//     own, measured with the sun's Rayleigh beam already gone). The parked rain and storm count as
//     clouded and lose their droplets with it; the parked fog weather counts as clouded too but
//     keeps its droplets by its share (`hazeKeyAt`'s `fogWeather`: exact at rest and on a front
//     between the fog and the cloudy or overcast sky). Tunable as
//     `haze.fog.<top|width|visibility|neutral|scatter>@<day|golden|mist>`. The layer is a switch
//     (`hazeKeyAt`'s `dayFog`: main.ts `?dayFog`, the GUI's `day fog`), off by default: off, every
//     key holds no fog (NO_FOG), so a clear or fair day keeps the thin haze alone.
//     A deep sea fog (SEA_FOG) is a switch beside the weather (main.ts `?seaFog`, the GUI's
//     `sea fog`), by its share at every hour and under any sky: its top 35 m over the sea and its edge 25 m
//     wide, so its density falls off through the island view's height rather than ending at a
//     line; 0.5 km at the sea, grey (`neutral` 1), with a = 0.5; and its banks break up higher
//     than the day layer's (`coverHigh` 1.2, the threshold at its top: FogNoise.ts). The distance
//     it fades over is what layers the frame: the island view looks down through its upper part
//     and sees the land below it through about 0.4 of optical depth (0.7 at its far side), while
//     the sea a few hundred metres out is gone (3 at 400 m along the water); by the boat, 25 m
//     stays clear (0.2) and 200 m is a silhouette (1.5). The banks' drift (VolumetricHaze.ts,
//     FogNoise.ts) moves through it. Its fields blend with the open sky's layer by the two
//     shares. Tunable as `haze.fog.<field>@sea`.
//   - sunRayleigh: the sun's share in the haze's Rayleigh light, beside the open sky's: 0 by day
//     under a clear or fair sky, where the air's blue is sky light only and the sun reaches the
//     haze through its aerosol share; 1 at a low sun, by night and under a cloudy sky's broken
//     deck. Under overcast's closed deck no beam reaches the air, which takes only the light the
//     deck lets down: the key's value, the hour's and the sky's together, goes by overcast's share
//     of the deck (`overcastDeck` below), so at every hour of the day, morning and a low sun
//     included, and fully once the deck is whole (with the beam the low air 0.5 - 4 degrees up
//     away from the sun stood about 1.03 times the background sky, without it about 0.8). The
//     deck's shading of the Rayleigh share follows the split after Patry, "Real-Time Samurai
//     Cinema" (SIGGRAPH 2021 Advances in Real-Time Rendering, p. 83): the Rayleigh in-scattering
//     takes the sky's occlusion, the Mie the sun's shadow; the Mie share keeps its light and
//     weight here. The parked rain and storm count as overcast and follow it; the parked fog,
//     which counts as overcast too, is left out by its share (`hazeKeyAt`'s `fogWeather`: exact at
//     rest and on a front between the fog and the overcast sky; not on one between the fog and a
//     clear, fair or cloudy sky) and keeps the beam. The moon's share takes the same value, so it
//     goes under the deck as well (from a sun 6 degrees under the horizon, where `overcastDeck` is
//     0, the night keeps it whole).
//   - rayleighWeight, mieWeight: the two shares' weights (VolumetricHaze's header), tuned by
//     least squares on the clear views. From a sun of 12 degrees up they set the haze's level
//     over the sky it covers: the hazed low sky (1 - 4 degrees up) on the sun's half at about
//     0.75 of the bare one, the haze darker than the sky behind it there: by day 0.575 and 0.79
//     (noon and an evening sun of 12), in the morning 0.33 and 0.83 (with the sky just over the
//     horizon against the sky above it at sun 12). Under 12 degrees they set what the haze shows
//     on screen, free of the exposure's level: the lowest band over the horizon level with the
//     sky 10 degrees up or a little over it, the bands' ratio and the low sky over the high air,
//     tuned together with the seen sky's rows by azimuth (Atmosphere.ts, its phases and the
//     aerosol aloft), which the low keys move as well. As the sun rises (sun 2 and 3) 0.72 and
//     0.83; before dawn two keys, the band taking more haze toward the sunrise than in the deep
//     twilight: 1.9 and 4.1 at -1 degrees (to sun 0, where it meets the sunrise's half and half;
//     the band about 0.02 - 0.04 L over the sky 10 degrees up at -2), and the Rayleigh 0.965 at -6
//     degrees (the band at -6.5 0.02 - 0.05 L over that sky; the Mie, 4.1, does not show there, the
//     sun being under the horizon). The dawn's weights are set by least squares, with the dawn key's
//     colour (Sky.ts), against the rows of the dawn's horizon views from -8 to 3 degrees (the band, the
//     sky, the sea, the shade on the land) once the multiple scattering was whole (Atmosphere.ts),
//     which lowered the aerosol's share of the bare sky over the band (0.15 to 0.12 at 3 degrees up,
//     sun 2.4) and with it the band's forward peak (20 against 40 degrees from the sun, 1.98 to
//     1.84 times): the sunrise's were 0.5 and 0.41 and the deep twilight's Rayleigh 1.4 before it,
//     and the tuning left 1.9 and 4.1 where they were. The golden hour's 0.58 and 3.8 (its far sea
//     over the sky held). The keys with a low sun take the sun's
//     Rayleigh light beside the open sky's (`sunRayleigh`). The afterglow's Rayleigh, 0.32, is
//     set by least squares with the dusk key's colour (Sky.ts) against the twilight's sky rows toward the
//     glow at -3.3 and -5.3 degrees. It was 0.13 before the multiple scattering was whole, which left
//     the haze about a quarter of the sky 4 degrees up toward the glow (0.23 - 0.26 at sun -3.3, its
//     share the sky's with the haze less the sky without it, over the sky with it), the glow's
//     orange showing through a thin air: 4.7 laid 0.9 of it, a pale veil over the glow. Its rows
//     hold it from -1 down to -7 degrees and give way to the night's from -7 to -11, the window in
//     which the sky's night comes in, and as it does, by stops (DayCycle.ts `skyNight`, `duskIn`:
//     from DUSK_DEPTH.haze, 6.75 stops under the night's key at -7, where the light it adds to the
//     sky is 1.8 stops over the twilight's; evenly, it raised the meter's sky a seventh of a stop in
//     the first half degree, a share of the step the night's layers made there): the night's key,
//     taken from -4 to -12 before, already had a few percent of the night's Rayleigh (8) at -5.3,
//     which kept the veil at two thirds, and taken from -11 to -14 it came in after the sky's night:
//     the land in the island view swelled from L 0.243 at -10 to 0.266 at -11 and fell back to
//     0.236 by -14, the frame's exposure reaching the night's only at -14, and the upper sky in the
//     horizon view passed its lowest at -11.5 to climb half a stop by -14. In the sky's window the
//     land holds 0.230 - 0.236 from -10 down, the exposure is the night's from -11, and the upper
//     sky falls into the night without a turn. Under cloud there is no glow to show through, and at 0.13
//     the low air over a clouded evening's horizon went dark under the deck (overcast, sun -3: the
//     sky in the horizon view L 0.28, a deep blue, against 0.38 and a lilac grey at 4.7), so a
//     clouded sky takes rows of its own (`SETTING_CLOUDED`, from -1 to -4 degrees, giving way to the
//     night's by -12) by its clouded share. Their Rayleigh is the golden hour's, which the night's
//     equals within a hundredth, so it holds from the golden hour into the night: a Rayleigh of 4.7
//     there, eight times the golden hour's, lifted the air's Rayleigh light under cloud from -1 to
//     -4 degrees and let it fall again toward the night's, a rise as the sun went down. Its Mie, 4.7, does not show
//     with the sun under the horizon, and the night's Mie (2.0) is the gain and weight it was set
//     with folded into one weight, not yet tuned. The night's amount and Rayleigh are the day's
//     (0.66 and 0.575, the weather's own amount on top as by day): the night's air is the day's
//     medium, lit by the moon above the air as the day's is by the sun (VolumetricHaze's moon
//     beam), with no brightness of its own. A night key of its own (two and a half times the haze,
//     a Rayleigh of 8, a visible layer) gave the haze about three quarters of a clear night's sky
//     light: the land's ambient over the moon's key rose to about three and a half times the day's
//     over the sun's, the grass in the moon a stop and four fifths under the day's against the sky
//     band and the rock's shade two stops over its own against the lit rock.
// The weather adds its own: under the cloudy and the overcast sky the air keeps about half the
// clear day's colour (0.53 times) and shows twice as bright (the key's `gain`, which the keys
// themselves leave at 1).
// The overcast's is taken as the cloudy's, without a direct check. Each kept sky scales the hour's
// sigma per band, the aerosol layer's share and its scale height, and the ground layer's top and
// width (1 under the clear and the fair sky; the cloudy's and the overcast's are
// tunable: `sky.weather.<sigmaRed|sigmaBlue|aerosolScale|aerosolHeight|topScale|widthScale>@<cloudy|
// overcast>`): under cloud the air turns redder in its extinction (red 1.42, blue 0.56 times).
// Under a deck the air is dense near the sea and clear aloft, and its aerosol ends at the deck's
// base (`aerosolTop`, Sky.ts `cloudBase`, blended by the clouded skies' shares as its inverse; clear
// and fair have none): the air between the eye and the base is what veils the deck's structure, and
// the aerosol that went on over the base laid a second veil over the deck's gaps. Each clouded sky
// keeps an air of its own, read as the visibility under such a deck (green, 3.912 over the
// extinction) and the slant transmittance from 100 m up to the base: overcast sees about 1.25 km
// at the surface, 2 km at the layer's top and 38 km at 100 m, 0.79 / 0.89 / 0.92 to the base at
// 10 / 20 / 30 degrees (its ground layer two thirds of the day's height, 9.2 m, and 1.2 times its
// width, its aerosol 0.82 of the day's share); cloudy is lighter, about 5 km at the surface and
// 40 km at 100 m (its ground layer 0.8 of the day's height and 0.6 of its
// width, a fifth of overcast's haze, its aerosol 4.6 of the day's share). Both keep the aerosol's
// scale height (3.1 times the day's), which under a top of 600 to 1500 m matters little. The
// weather's amount is its own field (Weather.ts `haze`), the cloudy's and the overcast's tunable
// here (`sky.weather.haze@<cloudy|overcast>`): the key's amount takes the tuned value over the
// preset's, blended by the sky's shares, so a value set shows on the next frame (the weather's
// state copies its preset only as it is established).
// Under a clouded sky the key also carries the deck's share (`deck`, Weather.ts `deckLight`: a
// cloudy deck's from a sun of 3 degrees, whole by 6, overcast's at every sun until the twilight),
// under which the air is lit level by the deck, and overcast's part of it (`overcastDeck`, Weather.ts
// `overcastDeckLight`), whose sky is darker away from the sun (VolumetricHaze's header) and whose
// closed deck takes the sun's beam out of the air's Rayleigh light (`sunRayleigh` above; the
// parked fog's share excepted, the parked rain and storm following). By night,
// once the moon's key has come in (DayCycle.ts `moonKeyShare`), the share is the whole clouded
// one: the deck's column then passes the island's moonlight down to its base (Clouds.ts
// `columnKey`), as by day the sun's, so the air under it takes the deck's light by night as by day,
// not the open moonlit sky's.

export interface HazeKey {

	// the deck's share (Weather.ts `deckLight` by day, the clouded share by night: the header):
	// under it the air is lit level, not as a clear sky's (VolumetricHaze.ts)
	deck: number;
	// overcast's share of that deck (a parked sky counting as overcast): its sky darker away from the
	// sun and toward the horizon (VolumetricHaze.ts)
	overcastDeck: number;
	amount: number;
	sigmaRed: number;
	sigmaGreen: number;
	sigmaBlue: number;
	desaturate: number;
	// the weather's gain over both shares of the light (1 in every key: see the header)
	gain: number;
	mist: number;
	sunRayleigh: number;
	rayleighWeight: number;
	mieWeight: number;
	top: number;
	width: number;
	aerosolShare: number;
	aerosolHeight: number;
	// the aerosol layer's top (m; Infinity for none): a low deck's base (see the header)
	aerosolTop: number;
	skyDepth: number;
	// the fog layer (see the header), optional so a key written elsewhere without them holds none:
	// the share of the ground layer that is the fog layer (its density from `visibility`, its top
	// `fogTop` and the width of its edge `fogWidth`), the share of the ground layer's light that is the droplets' (VolumetricHaze.ts), how
	// far the extinction turns neutral, the droplets' multiple scattering (Wrenninge's a), the
	// visibility at the sea (km) and the banks' threshold at the layer's top (FogNoise.ts `high`)
	fogLayer?: number;
	droplet?: number;
	neutral?: number;
	scatter?: number;
	fogTop?: number;
	fogWidth?: number;
	visibility?: number;
	fogCoverHigh?: number;

}

type Sigma = readonly [ number, number, number ];
type FullKey = Required<HazeKey>;
const key = ( amount: number, [ sigmaRed, sigmaGreen, sigmaBlue ]: Sigma, desaturate: number, mist: number, sunRayleigh: number ): FullKey =>
	( { deck: 0, overcastDeck: 0, amount, sigmaRed, sigmaGreen, sigmaBlue, desaturate, gain: 1, mist, sunRayleigh, rayleighWeight: 1, mieWeight: 1, ...SHAPE, ...NO_FOG, droplet: 0, fogCoverHigh: 0 } );

// the medium's shape every key starts from
const SHAPE = { top: 10, width: 50, aerosolShare: 0.035, aerosolHeight: 1400, aerosolTop: Infinity, skyDepth: 0 };
// the fog layer's fields (see the header), none by default: the hours without a fog of their own
// (the night and the twilights) hold this
const NO_FOG = { fogLayer: 0, neutral: 0, scatter: 0, fogTop: 12, fogWidth: 2, visibility: 2 };
// the three keys' spectral extinction, and the hours between's from them by the sun's elevation
// (see the header): the night's at -12 degrees, the golden hour's at 2
const NIGHT_SIGMA: Sigma = [ 0.463, 0.53, 0.694 ];
const GOLDEN_SIGMA: Sigma = [ 0.412, 0.53, 0.826 ];
const DAY_SIGMA: Sigma = [ 0.361, 0.53, 1.02 ];
const twilight = ( elevation: number ): Sigma => {

	const t = ( elevation + 12 ) / 14;
	const at = ( i: number ) => NIGHT_SIGMA[ i ] + ( GOLDEN_SIGMA[ i ] - NIGHT_SIGMA[ i ] ) * t;
	return [ at( 0 ), at( 1 ), at( 2 ) ] as const;

};
const BEFORE_DAWN = { ...key( 0.6, twilight( - 3.5 ), 0.33, 0, 1 ), rayleighWeight: 1.9, mieWeight: 4.1 };
// the deep twilight before dawn: the same air with less of the haze's light (see the header)
const EARLY_DAWN = { ...BEFORE_DAWN, rayleighWeight: 0.965, mieWeight: 4.1 };
const MIST = { ...key( 0.6, GOLDEN_SIGMA, 0.64, 0, 1 ), rayleighWeight: 0.72, mieWeight: 0.83, top: 14, width: 11.242, aerosolShare: 0.127, aerosolHeight: 1010,
	fogLayer: 1, neutral: 1, scatter: 0.2, fogTop: 12, fogWidth: 2, visibility: 0.22 };
const MORNING = { ...key( 0.96, DAY_SIGMA, 0.5, 0, 1 ), rayleighWeight: 0.33, mieWeight: 0.83 };
const DAY = { ...key( 0.659, DAY_SIGMA, 1, 0, 0 ), rayleighWeight: 0.575, mieWeight: 0.79, top: 14, width: 9.431, aerosolShare: 0.06, aerosolHeight: 761,
	fogLayer: 1, neutral: 1, scatter: 0.3, fogTop: 12, fogWidth: 2, visibility: 0.22 };
const NIGHT = { ...key( DAY.amount, NIGHT_SIGMA, 0.55, 0, 1 ), rayleighWeight: DAY.rayleighWeight, mieWeight: 2, top: 14, width: 10.162, aerosolShare: 0.003, skyDepth: 0 };
const GOLDEN = { ...key( 0.606, GOLDEN_SIGMA, 0.331, 0, 1 ), rayleighWeight: 0.58, mieWeight: 3.8, top: 14, width: 11.242, aerosolShare: 0.127, aerosolHeight: 1010,
	fogLayer: 1, neutral: 1, scatter: 0.2, fogTop: 12, fogWidth: 2, visibility: 0.29 };
const AFTER_SUNSET = { ...key( 0.45, twilight( - 2.5 ), 0.75, 0, 1 ), rayleighWeight: 0.32, mieWeight: 4.7 };
// the deep twilight after sunset: the afterglow's air, its light keeping the glow's colour (see the header)
const AFTER_SUNSET_DEEP = { ...AFTER_SUNSET, desaturate: 0 };
// the afterglow's air under cloud (see the header), its light as the clear afterglow's was set
const AFTER_SUNSET_CLOUDED = { ...AFTER_SUNSET, desaturate: 0.4, rayleighWeight: GOLDEN.rayleighWeight };
// the keys with a shape are tunable on debug pages (debug/Tune.ts):
// `haze.key.<amount|sigmaRed|sigmaBlue|desaturate|rayleighWeight|mieWeight|top|width|
// aerosolShare|aerosolHeight|skyDepth>@<day|golden|night|mist>` (green is sigma's unit), the
// morning's, the twilight's before dawn (deep and late) and after sunset (the afterglow and the
// deep twilight) their six up to `mieWeight` (`@morning`, `@earlyDawn`, `@beforeDawn`,
// `@afterSunset`, `@afterSunsetDeep`, under cloud `@afterSunsetClouded`)
const TUNED = [ 'amount', 'sigmaRed', 'sigmaBlue', 'desaturate', 'rayleighWeight', 'mieWeight', 'top', 'width', 'aerosolShare', 'aerosolHeight', 'skyDepth' ] as const;
const TUNE_RANGE: Record<typeof TUNED[ number ], TuneOptions> = {
	amount: { min: 0.1, max: 10, scale: 'log', onChange: markSkyRetune }, sigmaRed: { min: 0.05, max: 1.5, scale: 'log', onChange: markSkyRetune },
	sigmaBlue: { min: 0.3, max: 3, scale: 'log', onChange: markSkyRetune }, desaturate: { min: 0, max: 1, onChange: markSkyRetune },
	rayleighWeight: { min: 0.05, max: 40, scale: 'log', onChange: markSkyRetune }, mieWeight: { min: 0.05, max: 50, scale: 'log', onChange: markSkyRetune },
	top: { min: 0, max: 60, onChange: markSkyRetune }, width: { min: 5, max: 300, scale: 'log', onChange: markSkyRetune },
	aerosolShare: { min: 0.003, max: 3, scale: 'log', onChange: markSkyRetune }, aerosolHeight: { min: 300, max: 8000, scale: 'log', onChange: markSkyRetune },
	skyDepth: { min: 0, max: 0.5, onChange: markSkyRetune },
};
for ( const [ k, name, fields ] of [ [ DAY, 'day', TUNED ], [ GOLDEN, 'golden', TUNED ], [ NIGHT, 'night', TUNED ], [ MIST, 'mist', TUNED ], [ MORNING, 'morning', TUNED.slice( 0, 6 ) ], [ EARLY_DAWN, 'earlyDawn', TUNED.slice( 0, 6 ) ], [ BEFORE_DAWN, 'beforeDawn', TUNED.slice( 0, 6 ) ], [ AFTER_SUNSET, 'afterSunset', TUNED.slice( 0, 6 ) ], [ AFTER_SUNSET_DEEP, 'afterSunsetDeep', TUNED.slice( 0, 6 ) ], [ AFTER_SUNSET_CLOUDED, 'afterSunsetClouded', TUNED.slice( 0, 6 ) ] ] as const ) {

	tuneObject( k, Object.fromEntries( fields.map( ( f ) => [ f, `haze.key.${ f }@${ name }` ] ) ), TUNE_RANGE );

}
tuneObject( MIST, { mist: 'haze.key.mist@mist' }, { mist: { min: 0, max: 2, onChange: markSkyRetune } } );
// the fog layer's knobs on the keys that hold one:
// `haze.fog.<top|width|visibility|neutral|scatter>@<day|golden|mist>`, the visibility's range the key's
for ( const [ k, name, low, high ] of [ [ DAY, 'day', 0.2, 1.5 ], [ GOLDEN, 'golden', 0.3, 2.5 ], [ MIST, 'mist', 0.2, 2 ] ] as const ) {

	const range: Record<'fogTop' | 'fogWidth' | 'visibility' | 'neutral' | 'scatter', TuneOptions> = {
		fogTop: { min: 12, max: 40, onChange: markSkyRetune }, fogWidth: { min: 2, max: 15, onChange: markSkyRetune },
		visibility: { min: low, max: high, scale: 'log', onChange: markSkyRetune },
		neutral: { min: 0, max: 1, onChange: markSkyRetune }, scatter: { min: 0, max: 0.4, onChange: markSkyRetune },
	};
	tuneObject( k, { fogTop: `haze.fog.top@${ name }`, fogWidth: `haze.fog.width@${ name }`, visibility: `haze.fog.visibility@${ name }`,
		neutral: `haze.fog.neutral@${ name }`, scatter: `haze.fog.scatter@${ name }` }, range );

}

// rows by the sun's elevation (degrees, ascending), eased between neighbours, the end rows held
const RISING: ReadonlyArray<readonly [ number, FullKey ]> = [
	[ - 12, NIGHT ], [ - 6, EARLY_DAWN ], [ - 1, BEFORE_DAWN ], [ 1, MIST ], [ 3, MIST ], [ 7, MORNING ], [ 14, MORNING ], [ 22, DAY ],
];
const SETTING: ReadonlyArray<readonly [ number, FullKey ]> = [
	[ - 11, NIGHT ], [ - 7, AFTER_SUNSET_DEEP ], [ - 1, AFTER_SUNSET ], [ 2, GOLDEN ], [ 4, GOLDEN ], [ 8, DAY ],
];
// the setting sun's under cloud, which a clouded share draws the key to (see the header)
const SETTING_CLOUDED: ReadonlyArray<readonly [ number, FullKey ]> = [
	[ - 12, NIGHT ], [ - 4, AFTER_SUNSET_CLOUDED ], [ - 1, AFTER_SUNSET_CLOUDED ], [ 2, GOLDEN ], [ 4, GOLDEN ], [ 8, DAY ],
];

// the keys with a shape of their own; the others take the day's
const SHAPED: ReadonlySet<FullKey> = new Set( [ DAY, GOLDEN, NIGHT, MIST ] );
// the keys with a fog layer of their own; the morning takes the mist's, the others (the night and
// the twilights) none
const FOGGED: ReadonlySet<FullKey> = new Set( [ DAY, GOLDEN, MIST ] );
const fogOf = ( k: FullKey ): FullKey => FOGGED.has( k ) ? k : k === MORNING ? MIST : NIGHT;
// the sea fog (see the header): a deep layer with a soft top, held at every hour while its switch
// is on; tunable as `haze.fog.<field>@sea`
const SEA_FOG = { neutral: 1, scatter: 0.5, fogTop: 35, fogWidth: 25, visibility: 0.5, coverHigh: 1.2 };
tuneObject( SEA_FOG, { fogTop: 'haze.fog.top@sea', fogWidth: 'haze.fog.width@sea', visibility: 'haze.fog.visibility@sea',
	neutral: 'haze.fog.neutral@sea', scatter: 'haze.fog.scatter@sea', coverHigh: 'haze.fog.coverHigh@sea' }, {
	fogTop: { min: 0, max: 150, onChange: markSkyRetune }, fogWidth: { min: 2, max: 100, onChange: markSkyRetune },
	coverHigh: { min: - 1, max: 2.5, onChange: markSkyRetune },
	visibility: { min: 0.08, max: 2, scale: 'log', onChange: markSkyRetune },
	neutral: { min: 0, max: 1, onChange: markSkyRetune }, scatter: { min: 0, max: 0.6, onChange: markSkyRetune },
} );

// per kept sky (Weather.ts KEPT_SKIES: clear, fair, cloudy, overcast): the share of the light's
// colour kept over a clear day's and the gain over a clear day's
const KEEP = [ 1, 1, 0.53, 0.53 ];
const GAIN = [ 1, 1, 2, 2 ];
// per kept sky, the scale of each band's sigma, of the aerosol layer's share and of its scale
// height, of the ground layer's top and width, and the weather's haze (its preset's until tuned)
const CLOUD_SIGMA = { sigmaRed: 1.42, sigmaGreen: 1, sigmaBlue: 0.555 };
const CLEAR_SCALE = { sigmaRed: 1, sigmaGreen: 1, sigmaBlue: 1, aerosolScale: 1, aerosolHeight: 1, topScale: 1, widthScale: 1 };
const SCALES = [ CLEAR_SCALE, CLEAR_SCALE,
	{ ...CLOUD_SIGMA, aerosolScale: 4.6, aerosolHeight: 3.09, topScale: 0.79, widthScale: 0.62 },
	{ ...CLOUD_SIGMA, aerosolScale: 0.82, aerosolHeight: 3.09, topScale: 0.66, widthScale: 1.21 } ];
// per kept sky, whether a deck ends the aerosol layer at its base (Sky.ts `cloudBase`)
const DECKED = [ false, false, true, true ];
const SKY_SCALE = KEPT_SKIES.map( ( name, s ) => {

	const { haze } = WEATHER_PRESETS[ name ];
	return { ...SCALES[ s ], haze };

} );
for ( const [ s, name ] of [ [ 2, 'cloudy' ], [ 3, 'overcast' ] ] as const ) {

	tuneObject( SKY_SCALE[ s ], { haze: `sky.weather.haze@${ name }` }, { haze: { min: 2e-4, max: 0.02, scale: 'log', onChange: markSkyRetune } } );
	tuneObject( SKY_SCALE[ s ], { sigmaRed: `sky.weather.sigmaRed@${ name }`, sigmaBlue: `sky.weather.sigmaBlue@${ name }`, aerosolScale: `sky.weather.aerosolScale@${ name }`, aerosolHeight: `sky.weather.aerosolHeight@${ name }` },
		{ sigmaRed: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune }, sigmaBlue: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune },
			aerosolScale: { min: 0.1, max: 30, scale: 'log', onChange: markSkyRetune }, aerosolHeight: { min: 0.2, max: 10, scale: 'log', onChange: markSkyRetune } } );
	tuneObject( SKY_SCALE[ s ], { topScale: `sky.weather.topScale@${ name }`, widthScale: `sky.weather.widthScale@${ name }` },
		{ topScale: { min: 0.1, max: 5, scale: 'log', onChange: markSkyRetune }, widthScale: { min: 0.2, max: 5, scale: 'log', onChange: markSkyRetune } } );

}
// per kept sky, the sun's share in the haze's Rayleigh light: off under a clear or fair sky, on
// under cloud
const SUN_RAYLEIGH = [ 0, 0, 1, 1 ];

// (`skyDepth` is eased from each key's own value: the keys without a shape of their own keep
// SHAPE's 0 rather than taking the day's)
const FIELDS = [ 'amount', 'sigmaRed', 'sigmaGreen', 'sigmaBlue', 'desaturate', 'mist', 'sunRayleigh', 'rayleighWeight', 'mieWeight', 'skyDepth' ] as const;
const SHAPE_FIELDS = [ 'top', 'width', 'aerosolShare', 'aerosolHeight' ] as const;
const FOG_FIELDS = [ 'fogLayer', 'neutral', 'scatter', 'fogTop', 'fogWidth', 'visibility' ] as const;

// the key of `rows` at `elevation`, its fields, its shape and its fog layer, into `out`
function keyAlong( rows: ReadonlyArray<readonly [ number, FullKey ]>, elevation: number, out: FullKey ): void {

	let i = 0;
	while ( i < rows.length - 2 && elevation > rows[ i + 1 ][ 0 ] ) i ++;
	const [ e0, a ] = rows[ i ], [ e1, b ] = rows[ i + 1 ];
	// (a clear evening's night key comes in by stops, as the night's light does: DayCycle.ts
	// DUSK_DEPTH)
	// (a debug page may force the night key's weight, DayCycle.ts `duskForce`: its segment's ease,
	// and above it a blend toward it)
	const night = duskForced( 'hazeNight' );
	const t = night !== null && a === NIGHT ? 1 - night : rows === SETTING && a === NIGHT ? 1 - duskIn( elevation, [ e0, e1 ], DUSK_DEPTH.haze ) : THREE.MathUtils.smoothstep( elevation, e0, e1 );
	for ( const f of FIELDS ) out[ f ] = a[ f ] + ( b[ f ] - a[ f ] ) * t;
	const sa = SHAPED.has( a ) ? a : DAY, sb = SHAPED.has( b ) ? b : DAY;
	for ( const f of SHAPE_FIELDS ) out[ f ] = sa[ f ] + ( sb[ f ] - sa[ f ] ) * t;
	const fa = fogOf( a ), fb = fogOf( b );
	for ( const f of FOG_FIELDS ) out[ f ] = fa[ f ] + ( fb[ f ] - fa[ f ] ) * t;
	if ( night === null || a === NIGHT ) return;
	for ( const f of FIELDS ) out[ f ] += ( NIGHT[ f ] - out[ f ] ) * night;
	for ( const f of SHAPE_FIELDS ) out[ f ] += ( NIGHT[ f ] - out[ f ] ) * night;
	for ( const f of FOG_FIELDS ) out[ f ] += ( NIGHT[ f ] - out[ f ] ) * night;

}
const _cloudedKey = key( 0, DAY_SIGMA, 0, 0, 0 );
const _key = key( 0, DAY_SIGMA, 0, 0, 0 );

/** The haze's key at the sun's `elevation` (degrees), `rising` or setting, under the weather's
 * blend of the kept skies, its wind (m/s), its rain (0 - 1), the sea fog's share (0 - 1,
 * its switch) and the parked fog weather's share of the sky (0 - 1: Weather.ts `origin` and
 * `target` by the front's progress). The fog weather counts as overcast in `skyMix`, but its air
 * keeps the sun's Rayleigh light the closed deck takes from overcast's and the fog layer's droplets
 * the clouded share takes back (see the header): the fog is parked and stays as it stands. The
 * share is taken out by a product. For the droplets, which go by the cloudy and overcast columns
 * together, it is exact at rest and on a front between the fog and the cloudy or overcast sky,
 * not on one between the fog and a clear or fair sky. For the sun's Rayleigh beam, which goes by
 * overcast's column alone, it is exact at rest and on a front between the fog and the overcast
 * sky, not on one between the fog and a clear, fair or cloudy sky.
 * Writes into `out`. */
export function hazeKeyAt( elevation: number, rising: boolean, skyMix: readonly number[], wind: number, rain: number, dayFog: number, seaFog: number, fogWeather: number, target: HazeKey ): HazeKey {

	const out = _key;
	keyAlong( rising ? RISING : SETTING, elevation, out );
	// a clouded evening's afterglow (see the header)
	const clouded = cloudedShare( skyMix );
	if ( ! rising && clouded > 0 ) {

		keyAlong( SETTING_CLOUDED, elevation, _cloudedKey );
		for ( const f of FIELDS ) out[ f ] += ( _cloudedKey[ f ] - out[ f ] ) * clouded;
		for ( const f of SHAPE_FIELDS ) out[ f ] += ( _cloudedKey[ f ] - out[ f ] ) * clouded;
		for ( const f of FOG_FIELDS ) out[ f ] += ( _cloudedKey[ f ] - out[ f ] ) * clouded;

	}
	// the day's fog layer by its switch: off, every key holds no fog (see the header)
	if ( dayFog < 1 ) for ( const f of FOG_FIELDS ) out[ f ] += ( NO_FOG[ f ] - out[ f ] ) * ( 1 - dayFog );
	let keep = 0, gain = 0, red = 0, green = 0, blue = 0, aerosol = 0, height = 0, top = 0, width = 0, haze = 0, sunRayleigh = 0, inverseTop = 0;
	for ( let s = 0; s < KEEP.length; s ++ ) {

		const w = skyMix[ s ] ?? 0;
		keep += w * KEEP[ s ];
		gain += w * GAIN[ s ];
		red += w * SKY_SCALE[ s ].sigmaRed;
		green += w * SKY_SCALE[ s ].sigmaGreen;
		blue += w * SKY_SCALE[ s ].sigmaBlue;
		aerosol += w * SKY_SCALE[ s ].aerosolScale;
		height += w * SKY_SCALE[ s ].aerosolHeight;
		top += w * SKY_SCALE[ s ].topScale;
		width += w * SKY_SCALE[ s ].widthScale;
		haze += w * SKY_SCALE[ s ].haze / WEATHER_PRESETS[ KEPT_SKIES[ s ] ].haze;
		sunRayleigh += w * SUN_RAYLEIGH[ s ];
		if ( DECKED[ s ] ) inverseTop += w / cloudBase( s );

	}
	out.desaturate = 1 - ( 1 - out.desaturate ) * keep;
	out.gain = gain;
	out.sigmaRed *= red;
	out.sigmaGreen *= green;
	out.sigmaBlue *= blue;
	out.aerosolShare *= aerosol;
	out.aerosolHeight *= height;
	// the fog layer under a clear or a fair sky, by its share, and the sea fog by its switch at
	// every hour, which takes the open sky's layer's place: the ground layer takes its top and its
	// edge's width; without it cloudy and overcast keep their own air (see the header)
	const sea = seaFog, open = out.fogLayer * ( 1 - clouded ) * ( 1 - sea );
	const fog = open + sea;
	out.neutral *= 1 - clouded;
	out.fogCoverHigh = FOG_NOISE.high();
	if ( sea > 0 ) {

		for ( const f of [ 'neutral', 'scatter', 'fogTop', 'fogWidth', 'visibility' ] as const ) out[ f ] = ( out[ f ] * open + SEA_FOG[ f ] * sea ) / fog;
		out.fogCoverHigh = ( out.fogCoverHigh * open + SEA_FOG.coverHigh * sea ) / fog;

	}
	// the droplets' share of the ground layer's light follows the fog layer's own share, the
	// clouded share taking it back with the layer (the sea fog's kept); the parked fog weather, which
	// counts as clouded, keeps the key's whole (exact at rest and on a front between the fog and the
	// cloudy or overcast sky: see the header). (Written so that with no cloud, or under the fog
	// weather alone, the key's share passes through unchanged to the bit.)
	const dropletLayer = out.fogLayer * ( 1 - clouded * ( 1 - fogWeather ) );
	out.droplet = dropletLayer + ( 1 - dropletLayer ) * sea;
	out.fogLayer = fog;
	out.top = out.top * top * ( 1 - fog ) + out.fogTop * fog;
	out.width = out.width * width * ( 1 - fog ) + out.fogWidth * fog;
	out.aerosolTop = inverseTop > 0 ? 1 / inverseTop : Infinity;
	out.amount *= haze;
	out.sunRayleigh = 1 - ( 1 - out.sunRayleigh ) * ( 1 - sunRayleigh );
	out.mist *= ( 1 - THREE.MathUtils.smoothstep( wind, 3.5, 5 ) ) * ( 1 - rain );
	// (by night the whole clouded share, once the moon's key has come in: see the header)
	out.deck = duskForce( 'deck', Math.max( deckLight( elevation, clouded, skyMix[ 3 ] ?? 0 ), clouded * moonKeyShare( elevation ) ) );
	out.overcastDeck = ( skyMix[ 3 ] ?? 0 ) * overcastDeckLight( elevation );
	// no beam under overcast's closed deck: its share of the sun's Rayleigh light goes, the parked
	// fog's kept (exact at rest and on a front between the fog and the overcast sky: see the header)
	out.sunRayleigh *= 1 - out.overcastDeck * ( 1 - fogWeather );
	return Object.assign( target, out );

}
