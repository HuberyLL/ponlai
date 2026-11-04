/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater):
 * the haze's deep exponential height layer (its scale height) and its phase function,
 * from `AirHaze.js`.
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, uniform, texture, texture3D, textureLoad, textureStore, instanceIndex, instancedArray, uv, int, ivec2, ivec3,
	vec2, vec3, vec4, float, max, min, clamp, exp2, log2, sqrt, mix, dot, normalize, select, fract, floor, varying, asin, smoothstep, length,
} from 'three/tsl';
import type { Sky } from '../sky/Sky.ts';
import { EARTH_RADIUS, type Clouds } from '../sky/Clouds.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import { ATMOSPHERE_RADIUS, MIE_G, PLANET_RADIUS, cornetteShanks, skyRayleighPhase, type Atmosphere } from '../sky/Atmosphere.ts';
import { bandPush, bandToDisplay, bandToDisplayColor } from '../sky/BandMatrix.ts';
import { ISLAND_TOP } from '../world/WorldShapes.ts';
import type { HazeKey } from './HazeKeys.ts';
import { AEROSOL_OPEN, type HazeMedium, expShare, meanExtinction, nearFactor, nearLength } from './HazeDepth.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { tune, tuneObject, tuneUniform } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';
import type { FrameGraph, GraphResources, ResourceHandle, SizeClass } from '../post/graph/FrameGraph.ts';
import { TemporalRest, restEpoch } from '../post/TemporalRest.ts';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

// The sine of the elevation the sun's rows are read at under a deck (see the header)
const DECK_ROW = 0.5;
// The elevation (17 degrees) under which the haze reads the earth's shadow as at it (see the header)
const SHADOW_ELEVATION_SIN = Math.sin( THREE.MathUtils.degToRad( 17 ) ), SHADOW_ELEVATION_COS = Math.cos( THREE.MathUtils.degToRad( 17 ) );
// The sea's reflectance of a diffuse sky: Fresnel's for water (n 1.33) averaged over the
// hemisphere with the cosine, about 0.066.
const SEA_DIFFUSE = 0.066;
// Overcast's deck (see the header): the deck's diffuse law ( 3 / 7 )( 1 + 2 mu ) seen through the
// air's Cornette-Shanks phase, over an even deck's of the same irradiance, as a quartic in the
// view's sine of elevation whose coefficients are quadratics in the phase's anisotropy g (rows
// from mu^0 up, each from g^0 up): a least-squares fit to the quadrature over the anisotropy's
// tunable range, 0.5 to 0.9, within 0.004 at MIE_G and 0.037 at 0.9 (at MIE_G 0.71 looking
// level, 1.12 straight up). A single cubic fitted at MIE_G alone was 0.07 off at 0.76.
const DECK_DIFFUSE = [
	[ 0.8457, - 0.0508, - 0.2595 ],
	[ - 0.0331, 0.3896, - 0.2483 ],
	[ 0.3233, - 1.0249, 1.7246 ],
	[ 0.0476, - 0.2387, 0.327 ],
	[ - 0.3245, 1.3378, - 1.5456 ],
];

// The air's haze and the sea's fog as one participating medium in a froxel volume, after Patry,
// "Real-Time Samurai Cinema", SIGGRAPH 2021 (its volumetric haze, built on Wronski, SIGGRAPH 2014,
// and Drobot, Digital Dragons 2017):
//   - the medium's density is analytic and integrable along any ray: a ground layer, the talk's
//     sigmoidal layer, dense below a soft top and thinning above it, and a deep exponential aerosol
//     layer. Their shape is the hour's key's (HazeKeys.ts: the layer's top over the island and its
//     width, the aerosol's share and scale height), from 10 m, 50 m, 0.035 and 1.4 km. The width
//     grows with the camera's height over the sea by the key's `widthSlope` (by night the layer
//     thickens as the camera climbs, so the night's haze still shows from high up): set each frame
//     from the camera, one width for the volume, the sky and the CPU's readings, and a ray read from
//     another height (`skyHaze`'s `from`, the probe's rays, `transmittance`) takes its start's. The talk's slide prints the layer as
//     lerp( d0, d1, 1/2 z^2 / ( z^2 + k_s^2 ) + 1/2 ), whose weight is even in z and no step; this is
//     the algebraic sigmoid we take it to stand for, rho_f ( 1 - u / sqrt( w^2 + u^2 ) ) with u the
//     height over the layer's top, whose mean over any span of heights has a closed form. At the
//     starting shape its step is 50 m wide, so the camera, 30 - 60 m up, stands in its upper half
//     and the hills rise out of it, and it thins as the inverse square of the height far above, so
//     the distant haze thins less with height than an exponential layer would. The weather's haze sets rho_f (and the deep
//     layer's density, the key's share of it); its sea fog and the morning mist thicken it. Under a
//     low deck the aerosol layer ends at the deck's base (the key's `aerosolTop`: HazeKeys.ts), so
//     the air thins to nothing between the base and the eye's view of the deck's gaps; without a
//     deck it runs on over any height (HazeDepth.ts AEROSOL_OPEN) and every depth keeps its bits. An
//     optical depth is a ray's length times the mean density over the heights it spans: the closed
//     form along the ray, which holds its value on a level ray with no branch. Local variation
//     (banks, wisps, ground fog) belongs to particles, not to the density. The closed form lives in
//     HazeDepth.ts, which the clouds' march shares: `prepareMedium` writes the medium into the
//     clouds' copy too (`cloudMedium`), and the low deck's view march ends where it closes.
//   - the weather thins the haze near the camera (Weather.ts `nearDensity`, `nearStart`,
//     `nearEnd`, through the haze's key): along each ray the optical depth from the camera out to
//     t metres is f( t ) times the far medium's, f = k up to d0, a smoothstep back to 1 at d1, 1
//     beyond (`nearFactor`). Past d1 every ray keeps its optical depth exactly, however the medium
//     varies with height, so the far haze, the horizon and the sky (whose rays reach far past d1)
//     are unchanged; what the near air loses, the shell between d0 and d1 takes back (its density
//     f rho + tau f', never below 0), so the haze seems to begin there. A whole ray's depth (the
//     sky, the probe, the composite) is f of its length times the far depth; the light kernel
//     carries the far depth tau along each column and takes each slice's opacity from the change
//     of f tau over it, which also weighs what the slice scatters (the light per opacity is
//     unchanged), so the shadows and the grid stay as they were. Rays read from another height
//     (`skyHaze`'s `from`, the probe's) count the distance from their own start. The kept skies
//     thin it (k under 1, d0 200 m, d1 350 m under a clear or fair sky, 100 m and 700 m under the
//     cloudy one, 250 m and 500 m under the overcast: the game's camera reaches at most about 240 m
//     to the island's far side), so the island's views read through little air: the sky is many times
//     as bright as the land's shade, and a few per cent of it over the land turns the shade blue
//     and lifts the darks. A parked sky takes overcast's values (Weather.ts `skyMix`). The near
//     start is Unreal Engine's exponential height fog's Start Distance (its public documentation),
//     here eased and given back beyond it.
//     `nearHaze` off (the settings) takes the far density everywhere.
//   - the extinction is spectral: each band's is the density times the band's weight sigma, keyed
//     by the hour and the weather (HazeKeys.ts: by day red : green : blue = 0.38 : 0.53 : 0.655, at
//     the golden hour 0.45 : 0.53 : 1.19). The air loses its blue before its red (far land and sea
//     turn blue-grey and the low sun's light reddens), while cloud and fog droplets scatter grey
//     (the overcast's keys are still to be set toward it). The scattered light and the opacity are
//     integrated per channel, so the light volume holds three channels of L / alpha and green's
//     alpha, and the composite recomputes each channel's opacity. Every opacity the eye sees goes
//     through the band-to-display matrix (sky/BandMatrix.ts, the identity by default): the light
//     kernel's slice weights, the composite's opacity and the CPU `transmittance`.
//   - a froxel grid over the view in slices each deeper than the one before by a fixed share (the
//     talk's PS4 grid is 128 x 64 x 64; high's 160 x 90 makes a froxel about 16 render pixels
//     across at 1440p). Its size is fixed, so no kernel follows the render's scale. The talk's slices
//     (10 cm to 100 km, each 20 % deeper) serve a camera a few metres from its subject; the island's
//     camera looks from 20 - 200 m, where they were 6 - 20 m deep and averaged the cliffs' and the
//     plants' shadows out of the air. From 10 m to 30 km, each 15 % deeper, 19 of the 64 slices lie
//     in that range instead of 12 (6.6 m deep at 50 m), at no cost; four times the froxels across
//     (the talk's PC density) sharpened the shadows less and cost about six times as much.
//   - the light is the atmosphere's (3b in the talk's terms): each froxel takes the sky's in-scatter
//     along its own view direction at its own altitude (Atmosphere.ts's fog table, without the
//     phase; a direction under the froxel's horizon reads the horizon's sky side), so distant haze
//     is the horizon sky's colour, the same in-scatter seen through more medium, over the far sea
//     as over the sky, and haze and sky meet without a seam at every hour. It comes in two shares, each
//     turned toward its luminance by the key's `desaturate` after its phase:
//       - Rayleigh: the table's Rayleigh share through the sky's Rayleigh phase with its forward
//         lean (Atmosphere.ts `skyRayleighPhase`) and without the sky's polariser (the hazy air's
//         light is not polarised as the clear sky's is), lit by the open sky (its colour times the
//         ambient visibility) and by the sun (its colour times the sun's visibility), both under
//         the earth's shadow over the seen sky (Atmosphere.ts `skyShadow`). The shadow is read with
//         the column held 17 degrees or more over the horizon (SHADOW_ELEVATION): the air low over
//         the horizon away from a set sun lies in front of the sky's own shadowed band, and takes
//         the shadow only once its edge has risen past 17 degrees, so no dark belt lies round the
//         horizon. Measured on the clear views (sun 0, 2, 3, 12 and noon, 1 - 20 degrees up), the
//         haze's own light per unit of its opacity (its light over one minus its transmittance,
//         the transmittance read with `gain` 0) runs at 90 degrees from the sun about 0.76 - 0.88
//         of its value at 60 and at 170 about 0.93 - 1.1: the sky's lean alone, the side away
//         from the sun not lifted by a polariser of the haze's own. Over the bare sky behind it
//         that light stands at about 0.65 - 0.9 by day (sun 12 and noon, 60 - 90 degrees from the
//         sun), so the hazed low sky 1 - 4 degrees up keeps about 0.76 - 0.81 of the bare one on
//         the sun's half (HazeKeys.ts, the weights); at a low sun, the sky behind it darker, the
//         haze is the lighter (60 - 90 degrees from the sun about 1.2 - 1.4 at sun 2, 1.5 - 1.7 at
//         a setting sun of 3, 3.0 - 3.4 at the sunrise). This reaches everything the haze's sky
//         feeds, the sky's fog colour and the environment bakes, so the panorama, and the sky's
//         irradiance by about a percent at twilight. By day under a clear or fair sky the sun's colour here is
//         0: the air's blue is sky light, and sunlit blue haze would glow.
//       - aerosol: the table's Mie share through the Cornette-Shanks lobe, times the sun's colour
//         and visibility once the sun stands over the froxel's horizon (a smoothstep 3 degrees
//         either side of it, the horizon dipping by sqrt( 2 h / R ) at the froxel's height): the warm
//         glow toward the sun.
//     The colours are the sky's illuminance colour (Atmosphere `sunIlluminance`), the open sky's
//     times the weather's diffuse gain and the sun's times its direct share; the sun's Rayleigh
//     colour is the aerosol's times the key's `sunRayleigh`. Each share has one weight, keyed
//     (HazeKeys.ts), the weather's gain over both (2 under cloud) and `gain` (1, an A/B knob) over
//     the sum; the rows, the phases and the colours being the sky's own, a weight is about the
//     share's light per unit of opacity over the sky's (at noon and an evening sun of 12 the
//     Rayleigh share's, at a weight of 1, about 1.0 - 1.3 of the sky's 60 - 90 degrees from the
//     sun). A gain over the keys' gains and weights (1.87 times 1.73 times 2.03 by day) had
//     stacked to 6.6 on it. The moon lights the haze
//     the same way, its two shares added to the sun's:
//     the moon's fog table (its shares under the moon's gains, Atmosphere.ts `moonRayleigh`,
//     `moonMie`, as the sky's are), its direction (the night key's: Sky.ts `track`), phases and
//     earth shadow, and its colours the sun's scaled by the moon key (Atmosphere `moonIlluminance`,
//     the moon's sky), except for its aerosol share, whose light and lobe are its own
//     (MOON_AEROSOL): a pale blue-green of the same luminance as the moon's sky light, times a gain,
//     through a Cornette-Shanks lobe of its own anisotropy, so the glow of the air around the moon is
//     tuned apart from the sun's while the day keeps the sky's lobe. Both bodies take the key light's
//     visibility below, which follows the moon at night, when the sun's shares are dark under the
//     earth's shadow and the horizon. The moon's table is read along the moon's direction at the
//     froxel's altitude, the sun's along the view. A row along the view is the in-scatter over that
//     ray's whole path and grows toward the horizon, so read along the view the haze's moonlight was
//     the phase's angle from the moon times the view's elevation: on the moon's side the far sky
//     brightened low down from the table (the moon's aerosol share alone about two thirds of the
//     sky 5 - 15 degrees up and more than 25 degrees from the moon), and the glow round the moon
//     came out flat in angle, its outer rings taking in the bright low rows. A haze lit by the moon
//     scatters it once, its angular shape set by the phase alone (Wronski, "Volumetric Fog",
//     SIGGRAPH 2014; Hillaire, "Physically Based and Unified Volumetric Rendering in Frostbite",
//     SIGGRAPH 2015): read along the moon, the moonlight a unit of haze scatters depends on the view
//     only through the phases, the view's elevation enters only through the haze's density and depth
//     along it, and toward the moon, where the view's elevation is the moon's, the level is the
//     one the view's row gave. Measured on the composite's sky at a moonlit tune (the moon 24
//     degrees up, the view centred on it): within 2 degrees of the moon unchanged (under 0.5 %); the ratio of
//     the sky 2 degrees from the moon to 17 degrees from it from 3.0 to 3.8; more than 25 degrees
//     from the moon, the sky 0 - 5 degrees up about 0.39 of what it was, 5 - 15 degrees up 0.73,
//     15 - 30 degrees 0.98, and 30 - 60 degrees up 7 % brighter (the rows along the moon are longer
//     than the high views'); facing away from the moon 0.77, 0.86, 0.99 and 1.01. The far sea
//     still meets the horizon sky without a step (both are the haze's there). By day the moon's
//     light is 0: a clear noon's and a golden hour's paused frames are unchanged byte for byte. The
//     earth's shadow stays the view's (held at 17 degrees): with the moon 10 to 40 degrees up
//     (KeyLift.ts) it is about 1. The level follows the moon's elevation through its row's
//     length (a lower moon's row is longer, so its haze brighter, where a real haze would dim as the
//     moonlight crosses more air); the moon keeps one direction all night (KeyLift.ts), so the haze
//     keeps one level from dusk to dawn, and the elevation is a tuning the haze's gain answers.
//     Under a clouded day's deck (HazeKeys.ts `deck`) the sun's rows are read at one elevation,
//     30 degrees (DECK_ROW), instead of along the view, by the deck's share: the air under a deck
//     is lit by the deck over it alike in every direction, not by a clear sky, so it no longer
//     brightens toward the horizon as a clear sky's long low rows do. Under cloud the sky the dome
//     shows is nearly all this air laid over the clouds (Sky.ts `domeColour`: the clouds' own
//     undersides stand 4 - 8 stops under it), so along the view the deck's low band stood .7 - 1.6
//     stops over the sky's irradiance over pi, and read level .3 - .7. The bake, the reflection and
//     the froxels read the same rows, so the sky, its light on the land and the far haze move
//     together; with a level band and the irradiance about unchanged the deck shows half a stop
//     darker against the land.
//     Under the deck's share the open sky's light in the sun's rows, and in the moon's, gives way
//     to the deck's own (`scatterToward`): the air under a deck sees the deck over it and the sea
//     under it, nothing else of the sky. Its light is the sky's irradiance over pi without the haze over it (Sky.ts
//     `deckIrradianceNode`: the clear sky in the gaps times their transmittance plus the clouds'
//     own light, at the weather's ambient gain, baked and cross-faded with the sky), scattered
//     evenly by the air: half of it from the deck, half from the sea's reflection of it under
//     (SEA_DIFFUSE), times the albedo and the open sky's visibility, with no gain, no grey and no
//     row: the deck and the air are one scale by construction. The sun's own light (its rows
//     through the clouds' shadow) stays as it was; the deck's share is cloudy's from a sun of 3
//     degrees and overcast's until the twilight (Weather.ts `deckLight`), so a low sun's air and a
//     fair or clear sky keep the open sky's light, and by night, once the moon's key has come in,
//     the whole clouded share (HazeKeys.ts `deck`): the deck is then lit by the island's moonlight
//     through its column (Clouds.ts `columnKey`), and the air under it by the deck, as by day.
//     Measured on the overcast night's horizon view (paused): the sky .38 / .35 to .41 / .40
//     (the boxes' L), its low band .38 / .34 to .41 / .40, the meadow .18 / .19 to .19 / .20. Measured on the horizon views (paused, fresh
//     loads): overcast's sky about as bright as with the rows (box median L .30 to .32, its spread
//     .08 to .07), cloudy's unchanged (.75), its chroma .022 to .010: the deck's light is mostly the
//     clouds' own, a warm grey, the gaps' blue a small share of it.
//     Overcast's deck is thick (HazeKeys.ts `overcastDeck`, its share), and its light leaves the
//     base in the column's angular form (Clouds.ts, the column light): a diffuse part
//     ( 3 / 7 )( 1 + 2 mu ), the standard overcast sky's luminance law ( 1 + 2 sin h ) / 3 (the CIE
//     standard overcast sky of Moon and Spencer, 1942, as given in ISO 15469:2004 /
//     CIE S 011/E:2003), and over it, on the key's light alone, a forward Henyey-Greenstein lobe
//     about the key (Clouds.ts `forwardWeight`, `forwardLobe`), light added to the deck's. By
//     overcast's share the air takes it through its own phase: the diffuse part as the deck's law
//     weighted by the aerosol's phase over an even deck's of the same irradiance, a quartic in the
//     view's sine of elevation fitted in the anisotropy (DECK_DIFFUSE); the forward part as the
//     deck's own lobe about the key, on the key's share alone (the lobe's light over the deck's
//     level, `columnTop`'s key over its key and sky), the diffuse part taking the rest of the
//     deck's irradiance. The lobe is the deck's, not the narrower product of the deck's and the
//     air's anisotropies that one scattering of it would give: with that product (about 0.5) the
//     air 2 - 4 degrees up in the ring 12 - 20 degrees from a sun of 15 read half the sky 15 - 25
//     degrees up in that ring, with the deck's own 0.9 of it, and the air away from the sun a
//     sixth darker (the lobe's tail behind the key 0.06 against 0.23). The open sky's light in the
//     sun's rows takes the same by that share, the law by the view's elevation h,
//     ( 3 + 6 sin h ) / 7, plus the forward part, so the glow round the sun's place is one form in
//     the deck and in the air under it. The sea's half stays even: it reaches the air from below,
//     where neither the deck's law nor its lobe points, and is SEA_DIFFUSE of the deck's light.
//     Measured on overcast from 90 m: the rings about the key in Clouds.ts's header; the air's own
//     level (its light over its opacity, from the haze's albedo at 1 and at 0 and the haze off the
//     sky) is level in elevation away from the sun: under a sun of 22 degrees about 1.0 - 1.1 of
//     the bare deck 8 - 12 degrees up and 0.75 - 0.84 of it 28 - 32 up, under one of 15 about
//     1.1 - 1.3 and 0.84 - 0.99 (the bare deck, the haze off the sky, from 90 m about 0.75 as
//     bright at 10 degrees as at 30: its diffuse law). Of that level the deck's light alone is
//     0.73 - 0.86 of the bare deck 30 degrees up.
//   - the ambient visibility (the open sky's share that reaches a froxel) is the visibility volume's
//     second channel, sampled, filtered and held at rest with the key light's: 0 under the island's
//     cover and 1 above it, rising over 1.5 m either side of the cover's top (the rain's collision
//     map, RainCollision.ts: the highest surface seen from straight above, the bamboo's crowns, a
//     cliff's overhang; the sea off the island), times the ambient probes' sky visibility, never
//     below 0.024. Where the top is the sea's it is 1, under the surface and in the air just over
//     it alike: water hides nothing of the sky, and the slices under the surface show only through
//     the composite's tricubic filter, whose footprint reaches a slice or more past the sea's
//     depth, so their dark pulled the sea's pixels about 5 % under the air's own light. The
//     land's rise is unchanged (the slices inside the hills stay dark). That floor is fixed: the sky barely changes across its
//     range, so it waits for measures of the haze under cover. The probes' read is HazeCover `skyVisibility`,
//     which the pipeline fills with
//     lighting/AmbientSample.ts `ambientSkyVisibility` (1 on the open sea; the volume is installed
//     with the world, so the shadow kernels compile then, not in the warm-up: HazeCover `late`):
//     under the bamboo, the overhangs and in the island's hollows the haze darkens, the open haze
//     is unchanged. The cover's redraws (a Grow's) restart the rest.
//   - the shadow is the sun's stepped shadow maps (SunShadow.volumeVisibility) and the clouds'
//     shadow along the key light (`cloudShaft`: the clouds' map, its air's channel, read at the point's ground point
//     along the clouds' own light, the flat beam the map was built along, sharpened against its blur
//     so the gaps show as shafts, lifted above the shell's base and floored; the gain 10, no floor and no cut
//     toward the light until set), sampled at four points of each froxel whenever it is recomputed
//     (the frame's jittered point and three more the R3 sequence's steps from it, averaged, so the
//     history converges to the cell's mean) and filtered over frames, the history weighing 0.95
//     (the ambient visibility with it): what any caster or cloud cuts out of the lit air shows as shafts, whether or not the
//     sun is in view. The filter keeps the shadow's share (and the occlusion's) only, never the
//     light, so a change of the light shows at once and leaves no trail.
//   - a second kernel integrates each column of froxels front to back, every slice's optical depth
//     exact, and stores the in-scattered light divided by its opacity (L / alpha): a smooth
//     function of depth, unlike either alone. The composite recomputes the opacity at each pixel,
//     exactly, from the density functions, and multiplies it back in: the thin layers over the
//     horizon and the sea do not band at the grid's depth steps (the talk's density
//     anti-aliasing). It samples the volume with a tricubic B-spline (eight trilinear taps; Sigg
//     and Hadwiger, "Fast Third-Order Texture Filtering", GPU Gems 2, 2005), which joins the shafts
//     to their openings.
//   - the haze covers the sky (`sky`), and the sky lays it on itself: the dome (Sky.ts `fogDome`,
//     `skyHaze` here) takes the atmosphere's colour through the haze along the whole way to the
//     atmosphere's top (or to the sea for a ray below the horizon), its optical depth taken along a
//     straight ray whose height climbs with the direction alone, never lifted by the planet's curve,
//     so the haze closes over the sky near the horizon (two parts, the far one from the height the
//     curve lifts the ray to, took too little air at 1 degree), plus the haze's light read at
//     that distance or the grid's far end, whichever is nearer; the clouds in front of it take the
//     same out to their shell's middle height, over their opacity; the composite leaves the sky's
//     pixels. So the haze's kernels run ahead of the scene passes, which declare the light volume
//     as a read (Pipeline.ts); they read the sun's maps, the clouds' shadow and the camera, never
//     the scene's depth, and keep the unjittered projection under the temporal modes. Both layers are laid over the atmosphere whole: its own aerosols
//     (Atmosphere.ts `mieScale`) are not taken out of them, the sky's fog being the volume's on top
//     of the atmosphere. The ground layer closes over the horizon, so the far sea and the horizon's
//     sky end in the same haze. The light the sky lends (Sky.ts's bakes, the probes) is the
//     atmosphere's alone: the haze is laid over the image only.
//     The dome's own sky ray (the dome's call, `skyHaze`'s `dome`, with no distance) adds a thin
//     haze of its own to the medium's depth: uniform in height over the air's whole height, the
//     key's `skyDepth` (green's optical depth per kilometre of the ray; HazeKeys.ts). Over the
//     island's distances, a few kilometres, its share is negligible, while the sky's rays (about
//     100 km straight up, 280 km at 20 degrees, 480 km at 10) are long enough for it to close the
//     dome, so one depth separates the island's views from the sky by the length of their rays
//     alone. Its light is the volume's light per opacity times the whole opacity, as the medium's:
//     with a depth (a fog night's; every key keeps 0) the moon's disc fades behind it, the sky near
//     and below the moon turns to the haze's phase lobe over an even floor, and the stars and the
//     atmosphere show through only high up, where the rays are short. The clouds' haze, the probe's
//     sky rays, the CPU `transmittance` (the sun's glare, the flares' visibility) and `openSky`
//     (the light the sky lends) read the medium alone.
//
// Rules: the shadow's filter is a history-dependent effect (AGENTS.md). While the scene runs, each
// froxel blends its new sample into its history, reprojected through the previous frame's camera,
// and takes the new sample alone where the history falls outside the grid, after a cut (the key
// light turns more than CUT in a frame, the camera jumps) and after `invalidate`. A scene at rest
// (the key TemporalRest tests: the camera, the clock, the sizes, the epoch's scene count, which a
// restart of the frame loop leaves, the page's signature and the haze's own inputs, the medium's
// among them) converges once, the way the temporal resolve's rest does: after its settle
// frames it averages a fixed sequence of jitters with exact weights, from nothing, then holds the
// result and skips the shadow kernel. A paused frame is then a function of the scene alone,
// however it was reached, and `pending` holds the page's settled signal until it has converged.
// The light kernel runs every frame. Local lights, when there
// are any, add to the light the integration takes per froxel; the talk filters theirs in a volume of
// their own.

// the shadow's sub-samples per froxel and recompute
const SUB_SAMPLES = 4;
// a key light that turns more than this in one frame is a cut: the shadow's history is dropped
const CUT = THREE.MathUtils.degToRad( 1 );
// a camera that moves more than this in one frame (metres, or radians of turn) is a cut
const JUMP = { distance: 8, angle: THREE.MathUtils.degToRad( 30 ) };
// view z of the sky (the composite's depth holds -1e5 there)
const SKY_Z = - 9e4;
// the rays `probe` takes at once
const PROBE_RAYS = 64;
const _transmittance = new THREE.Color(), _reading = new THREE.Color();
// Rec. 709 luminance, toward which the light's colours turn (`desaturate`)
const LUMINANCE = vec3( 0.2126, 0.7152, 0.0722 );
const luminance = ( c: THREE.Color ): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

// The moon's aerosol light in the haze: its colour as red and blue over green, scaled to the
// Rec. 709 luminance of the moon's sky light there (Atmosphere `moonIlluminance` times the weather's
// direct share), so a new colour moves the hue and not the level, times a gain; and the anisotropy of
// its Cornette-Shanks lobe. A pale blue-green under a lobe a little tighter than the sky's: the air
// around the moon glows cool rather than in the moon key's own blue, over a few degrees.
// Tunable on debug pages (debug/Tune.ts `haze.moon.*`).
const MOON_AEROSOL = {
	red: tune( 'haze.moon.red', 0.333, { min: 0.2, max: 1, onChange: markSkyRetune } ),
	blue: tune( 'haze.moon.blue', 0.669, { min: 0.5, max: 1.2, onChange: markSkyRetune } ),
	gain: tune( 'haze.moon.gain', 0.279, { min: 0.25, max: 4, scale: 'log', onChange: markSkyRetune } ),
	anisotropy: 0.797,
};
// the planet's radius and the atmosphere's top (m from its centre)
const ATMOSPHERE_BOTTOM = PLANET_RADIUS * 1e3, ATMOSPHERE_TOP = ATMOSPHERE_RADIUS * 1e3;

/** The froxel grid's size, fixed when the page loads (the quality tier's `post.hazeGrid`). */
export interface HazeGrid { width: number; height: number; depth: number }

export const DEFAULT_HAZE_GRID: Readonly<HazeGrid> = { width: 160, height: 90, depth: 64 };

/** The haze's knobs (the GUI's Haze folder, `__PONLAI__.pipeline.air.settings`). The shadow's
 * temporal filter and the composite's filters are the talk's, the slices fitted to the island's
 * camera (see the header; the medium's shape is the hour's key's, HazeKeys.ts), the phases from how
 * the air brightens toward the sun, the shares' weight and the gain by eye on a few points of the sky
 * and the island. Those the environment's bake lays over its source (`openSky`: BAKE_SETTINGS)
 * rebake it when they change, however they are set (`bakeStale`, main.ts `retuneSky`). */
export const HAZE_DEFAULTS = {
	// the slices: the grid's near and far view depth (metres) and each slice's depth over the last's
	near: 10, far: 30000, growth: 1.15,
	// the sea fog and the morning mist: the ground layer's deep green extinction per unit of the
	// weather's fog (1/m: one unit sees 1 km, the threshold of fog, Koschmieder's 3.912 / 1000)
	fogExtinction: 3.912 / 1000,
	// the light: the medium's single-scattering albedo, the aerosol share's phase (a Cornette-Shanks
	// lobe of the sky's aerosol anisotropy, Atmosphere.ts MIE_G, half its peak about 12 degrees off
	// the sun and a 1/340 of it behind), a gain over both shares (1: the keys' weights carry the
	// level), and the half-width of the sun's rise over a froxel's horizon (degrees)
	albedo: 1, anisotropy: MIE_G, gain: 1, horizon: 3,
	// the ambient visibility: its floor under cover, and the half-width (metres) of its rise
	// through the cover's top
	ambientFloor: 0.024, ambientSoftness: 1.5,
	// the shadow's filter: a running frame's weight (1 - the history's, 0.95), and the frames a rest
	// averages
	blend: 0.05, restFrames: 16,
	// A/B switches: the jittered shadow samples, the tricubic filter (else trilinear), the density
	// anti-aliasing (else the opacity the grid holds), the haze over the sky, the weather's thinner
	// near haze (else the far density everywhere)
	jitter: true, tricubic: true, densityAA: true, sky: true, nearHaze: true,
	// a debug view: 0 off, 1 the key light's visibility in the froxel at each pixel's depth
	debug: 0,
};

export type HazeSettings = typeof HAZE_DEFAULTS;

// The settings `openSky` reads (the slices, the fog's extinction, the light, the switch over the sky,
// the near haze): the environment's bake holds them as they stood when it ran.
const BAKE_SETTINGS = [ 'near', 'far', 'growth', 'fogExtinction', 'albedo', 'anisotropy', 'gain', 'horizon', 'sky', 'nearHaze' ] as const;

// expShare on each band
const expShare3 = ( x: V3 ): V3 => vec3( expShare( x.x ), expShare( x.y ), expShare( x.z ) );

// The medium's closed form (`meanExtinction`, `nearFactor`, `nearLength`) is HazeDepth.ts's, which the
// clouds' march shares to end where the haze closes.

// Interleaved gradient noise (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced
// Warfare", SIGGRAPH 2014): a fixed offset per froxel, so the frames' common jitter sequence lands
// on different points of neighbouring froxels.
const gradientNoise = Fn( ( [ p ]: [ V2 ] ) => fract( fract( dot( p, vec2( 0.06711056, 0.00583715 ) ) ).mul( 52.9829189 ) ) )
	.setLayout( { name: 'hazeGradientNoise', type: 'float', inputs: [ { name: 'p', type: 'vec2' } ] } );

function halton( index: number, base: number ): number {

	let f = 1, r = 0;
	for ( let i = index; i > 0; i = Math.floor( i / base ) ) {

		f /= base;
		r += f * ( i % base );

	}
	return r;

}

/** What hides the haze from the open sky, for its ambient visibility (Pipeline.ts gives the rain's
 * collision map, RainCollision.ts, and the ambient probes' sky visibility): the island's highest surface seen from straight above, and
 * the ambient probes' sky visibility. */
export interface HazeCover {
	/** the height (m) of the highest surface under world ( x, z ), the sea's off the island; an
	 * inline node (no layout: the shadow kernel is not the only compute kernel that reads it) */
	topAt( xz: V2 ): F;
	/** the sea's height (m), the top off the island */
	readonly seaLevel: F;
	/** counts the top's redraws (a Grow's), so the shadow's rest starts over on each */
	readonly version: number;
	/** the probes' sky visibility at a world point, 1 off the island; left out, 1. Called when the
	 * shadow kernels build. */
	skyVisibility?: ( p: V3 ) => F;
	/** set when `skyVisibility` reads what exists only later (the ambient volume, installed with the
	 * world, after the graph's warm-up has started): the warm-up then leaves the shadow kernels,
	 * and the owner compiles them once it is ready (`shadowKernels`, Pipeline.ts
	 * `compileHazeShadow`), before the first frame */
	late?: boolean;
}

/** What the page tells the haze each frame (main.ts): the rest's signature (what changes the
 * frame without changing the camera or the clock: a forced strike, the sun maps' redraws) and
 * whether the scene may rest (no sky bake in flight, no transition running). */
export interface HazeFrame { time: number; signature: readonly number[]; stable: boolean }

/** The air's haze and the sea's fog: a froxel volume lit by the atmosphere and shadowed by the sun's
 * maps and the clouds, composited over the scene and the sky (see the header). */
export class VolumetricHaze {

	// the weather's haze (the ground layer's deep extinction in the band of sigma 1, 2 rho_f, 1/m:
	// Weather.ts `haze`) and its sea fog or mist (0 none, 1 sees 1 km)
	readonly haze = uniform( 0 );
	readonly fog = uniform( 0 );
	// the hour's and the weather's key (HazeKeys.ts, `setLook`): each band's sigma, the light's
	// desaturation, the weather's gain over `gain`, the sun's share in the Rayleigh light and the two shares'
	// weights, the medium's shape (the ground layer's top over the island's level and its width,
	// the aerosol layer's share, scale height and top, the dome's own depth per kilometre) and the
	// near haze (its density factor, start, end)
	readonly look = { sigma: new THREE.Vector3( 1, 1, 1 ), desaturate: 0.26, gain: 1, sunRayleigh: 0, rayleighWeight: 1, mieWeight: 1,
		top: 10, width: 50, widthSlope: 0, aerosolShare: 0.035, aerosolHeight: 1400, aerosolTop: Infinity, skyDepth: 0, nearDensity: 1, nearStart: 250, nearEnd: 600 };
	// the weather's share of the sun's direct light below the clouds and its diffuse gain
	// (Weather.ts `directVisibility`, `ambientGain`), which scale the light's colours
	readonly weatherLight = { direct: 1, ambient: 1 };
	// The key light the air scatters: its direction and its irradiance below the clouds (a closed
	// deck leaves no beam to scatter).
	readonly keyDir = uniform( new THREE.Vector3( 0, 1, 0 ) );
	readonly keyColor = uniform( new THREE.Color( 0, 0, 0 ) );
	// the moon's aerosol lobe (MOON_AEROSOL)
	private readonly moonAnisotropy = tuneUniform( 'haze.moon.mieG', MOON_AEROSOL.anisotropy, { min: 0.7, max: 0.82, onChange: markSkyRetune } );
	// the medium's and the light's tunable knobs (debug/Tune.ts; the sun's aerosol share takes
	// the sky's lobe, the moon's its own: `moonAnisotropy`, MOON_AEROSOL)
	readonly settings: HazeSettings = tuneObject( { ...HAZE_DEFAULTS },
		{ anisotropy: 'sky.atmosphere.mieG', horizon: 'haze.light.horizon', ambientFloor: 'haze.ambient.floor' },
		{ anisotropy: { min: 0.5, max: 0.9 }, horizon: { min: 0.5, max: 10 }, ambientFloor: { min: 0, max: 0.2 } } );
	readonly grid: Readonly<HazeGrid>;
	/** The shadow's rest (see the header); `pending` while it has not converged. */
	readonly rest = new TemporalRest();

	private readonly sunShadow: SunShadow;
	// the medium: the exponential layer ( density at sea level, scale height ) and the ground layer
	// ( rho_f, top, width ), from the weather and the settings, and each band's sigma
	private readonly layer = uniform( new THREE.Vector3( 0, 1400, AEROSOL_OPEN ) );
	private readonly ground = uniform( new THREE.Vector3( 0, 13, 50 ) );
	// the ground layer's width at the sea and its growth with the start's height ( m, m per m ), for
	// a ray from another height than the camera's (`groundFrom`)
	private readonly widthRule = uniform( new THREE.Vector2( 50, 0 ) );
	private readonly sigma = uniform( new THREE.Vector3( 1, 1, 1 ) );
	// the dome's own thin haze (the key's `skyDepth`), in the medium's depth per metre before each
	// band's sigma: green's optical depth per metre over green's sigma (`skyHaze` with `dome`)
	private readonly skyDepth = uniform( 0 );
	// the near haze: its density factor and where it eases back to 1 ( k, d0, d1 in m: `nearLength` )
	private readonly near = uniform( new THREE.Vector3( 1, 250, 600 ) );
	/** A copy of the medium a reader built before the haze holds (the clouds' `haze`, which ends
	 * the low deck's march where this medium closes: Clouds.ts `makeMarch`), written with it. */
	cloudMedium: HazeMedium | null = null;
	// the light's settings: albedo, anisotropy, the gain, the horizon's half-width (radians)
	private readonly lightSettings = uniform( new THREE.Vector4( 1, 0.76, 1, 0.05 ) );
	// the light's colours toward their luminance (0 as given, 1 grey)
	private readonly desaturate = uniform( 0.26 );
	// the deck's share (HazeKeys.ts `deck`): the sun's rows read level under it (see the header)
	private readonly deckShare = uniform( 0 );
	// overcast's share of the deck (HazeKeys.ts `overcastDeck`): its sky's shape (see the header)
	private readonly overcastShare = uniform( 0 );
	// the light's colours per body (the sun's, the moon's: each one's illuminance the sky is drawn
	// with, scaled): the Rayleigh share's lit by the open sky and by the body, the aerosol share's;
	// and the shares' weights
	private readonly ambientColour = [ uniform( new THREE.Color( 0, 0, 0 ) ), uniform( new THREE.Color( 0, 0, 0 ) ) ] as const;
	private readonly sunRayleighColour = [ uniform( new THREE.Color( 0, 0, 0 ) ), uniform( new THREE.Color( 0, 0, 0 ) ) ] as const;
	private readonly mieColour = [ uniform( new THREE.Color( 0, 0, 0 ) ), uniform( new THREE.Color( 0, 0, 0 ) ) ] as const;
	private readonly weights = uniform( new THREE.Vector2( 1, 1 ) );
	private readonly atmosphere: Atmosphere;
	// the slices: near, the first slice's depth, the growth and its log2
	private readonly slices = uniform( new THREE.Vector4( 10, 0.6, 1.15, Math.log2( 1.15 ) ) );
	private readonly far = uniform( 100000 );
	// the grid's camera, unjittered (the volume does not shake with the temporal modes' jitter)
	private readonly gridInverse = uniform( new THREE.Matrix4() );
	private readonly gridProjection = uniform( new THREE.Matrix4() );
	private readonly cameraWorld = uniform( new THREE.Matrix4() );
	private readonly cameraInverse = uniform( new THREE.Matrix4() );
	private readonly origin = uniform( new THREE.Vector3() );
	// the previous frame's view-projection (unjittered), for the history's reprojection
	private readonly previousViewProjection = uniform( new THREE.Matrix4() );
	// the composite's rays: the projection the depth it reads was drawn with (jittered under the
	// temporal modes: `setProjectionInverse`)
	private readonly projectionInverse = uniform( new THREE.Matrix4() );
	// the shadow kernel's frame: the jitter's offset, the rest's index (-1 while running), the
	// running blend (1: no history)
	private readonly sequence = uniform( new THREE.Vector3( 0.5, 0.5, 0.5 ) );
	private readonly restIndex = uniform( - 1 );
	private readonly blend = uniform( 1 );
	// the clouds' shafts (cloudShaft): the unsharp mask's gain, the floor, the lift's cut toward the
	// key light
	readonly cloudShafts = uniform( new THREE.Vector3( 10, 0, 0 ) );
	// the ambient visibility's floor and the half-width of its rise (m)
	private readonly ambientSettings = uniform( new THREE.Vector2() );
	// BAKE_SETTINGS as the environment's last bake read them (`noteBake`)
	private baked: HazeSettings | null = null;
	private cover: HazeCover | null = null;
	// the composite's switches: the haze over the sky, tricubic, density anti-aliasing, the debug view
	private readonly switches = uniform( new THREE.Vector4( 1, 1, 1, 0 ) );
	// `probe`'s kernel and its buffers, built on its first call
	private probeKernel: { input: THREE.StorageBufferNode<'vec4'>; heights: THREE.StorageBufferNode<'float'>; out: THREE.StorageBufferNode<'vec4'>; kernel: THREE.ComputeNode } | null = null;
	// the render's size, the frame graph's (set in `apply`)
	private resolution!: THREE.UniformNode<'vec2', THREE.Vector2>;

	// The shadow's two volumes (r: the key light's visibility, g: the ambient visibility), written in
	// turn: `written` holds the newest. The light's volume (rgb: L / alpha, a: alpha at each
	// slice's far boundary).
	private readonly visibility: [ THREE.Storage3DTexture, THREE.Storage3DTexture ];
	private readonly light: THREE.Storage3DTexture;
	private visibilityKernels: THREE.ComputeNode[] = [];
	/** The shadow's kernels (both ping-pong sides), for an owner whose cover is `late` to compile. */
	get shadowKernels(): readonly THREE.ComputeNode[] {

		return this.visibilityKernels;

	}
	private lightKernels: THREE.ComputeNode[] = [];
	private resources: { visibility: ResourceHandle; light: ResourceHandle } | null = null;
	private written = 0;
	private historyValid = false;
	private shadowDue = true;
	private frame = 0;
	private readonly key: number[] = [];
	private readonly last = { valid: false, keyDir: new THREE.Vector3(), position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), slices: new THREE.Vector4(), viewProjection: new THREE.Matrix4() };
	private readonly viewProjection = new THREE.Matrix4();
	private readonly position = new THREE.Vector3();
	private readonly quaternion = new THREE.Quaternion();
	private readonly scale = new THREE.Vector3();

	constructor( sunShadow: SunShadow, atmosphere: Atmosphere, grid: Partial<HazeGrid> = {} ) {

		this.sunShadow = sunShadow;
		this.atmosphere = atmosphere;
		this.grid = { ...DEFAULT_HAZE_GRID, ...grid };
		const { width, height, depth } = this.grid;
		const volume = ( name: string ) => {

			const t = new THREE.Storage3DTexture( width, height, depth );
			t.name = name;
			t.type = THREE.HalfFloatType;
			t.format = THREE.RGBAFormat;
			t.generateMipmaps = false;
			t.minFilter = t.magFilter = THREE.LinearFilter;
			t.wrapS = t.wrapT = t.wrapR = THREE.ClampToEdgeWrapping;
			return t;

		};
		this.visibility = [ volume( 'haze.visibility0' ), volume( 'haze.visibility1' ) ];
		this.light = volume( 'haze.light' );
		this.rest.settle = 8;

	}

	// the view depth (metres) at slice coordinate c (slice k spans [ k, k + 1 ])
	private sliceDepth( c: F ): F {

		const s = this.slices;
		return s.x.add( s.y.mul( exp2( c.mul( s.w ) ).sub( 1 ) ).div( s.z.sub( 1 ) ) );

	}

	// the slice coordinate of a view depth
	private sliceCoordinate( z: F ): F {

		const s = this.slices;
		return log2( max( z.sub( s.x ), 0 ).mul( s.z.sub( 1 ) ).div( s.y ).add( 1 ) ).div( s.w );

	}

	// the grid's view ray through screen uv q: its unit view-space direction and its world direction
	private gridRay( q: V2 ): { view: V3; direction: V3 } {

		const ndc = vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1, 1 );
		const far = this.gridInverse.mul( ndc );
		const view = normalize( far.xyz.div( far.w ) ).toVar();
		const direction = normalize( this.cameraWorld.mul( vec4( view, 0 ) ).xyz ).toVar();
		return { view, direction };

	}

	// the world position at screen uv q and view depth z, on the grid's camera
	private gridPoint( q: V2, z: F ): V3 {

		const { view, direction } = this.gridRay( q );
		return this.origin.add( direction.mul( z.div( view.z.negate() ) ) );

	}

	/** The view ray through screen uv `q` of the camera `update` last took, with the inverse
	 * projection `projectionInverse`: in view space (`ray`, its z -1 deep, for a distance from a
	 * view z) and its world direction. For the rain veil drawn after the temporal resolve
	 * (Pipeline.ts), at the canvas's pixels and unjittered, in a full-screen pass: both are linear
	 * across the screen before the direction is normalised, so they are interpolated from the
	 * vertices. */
	viewRay( q: V2, projectionInverse: THREE.Node<'mat4'> ): { ray: V3; direction: V3 } {

		const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 );
		const viewFar = projectionInverse.mul( vec4( ndc, 1 ) );
		const ray = viewFar.xyz.div( viewFar.z.negate() );
		const direction = normalize( varying( this.cameraWorld.mul( vec4( ray, 0 ) ).xyz ) ).toVar();
		return { ray: varying( ray ).toVar(), direction };

	}

	// The key light's and the open sky's visibility at the point q (0 .. 1 on each axis) of the
	// froxel at `cell`.
	private visibilityAt( cell: V3, q: V3, size: V2, sky: Sky ): V2 {

		const p = this.gridPoint( cell.xy.add( q.xy ).div( size ), this.sliceDepth( cell.z.add( q.z ) ) ).toVar();
		// the sun's maps (lit outside them and before the first is drawn). The maps' depth ends
		// below the casters (at the sea's troughs), but a low sun throws their shadow through the
		// air far beyond that: a point past the far end lies behind every caster of its texel, so
		// it is compared at the far end.
		const coordinate = this.sunShadow.coordinate.mul( vec4( p, 1 ) ).xyz.toVar();
		const sun = this.sunShadow.volumeVisibility( vec3( coordinate.xy, min( coordinate.z, 0.99999 ) ) ).toVar();
		const key = sun.mul( this.cloudShaft( p, normalize( p.sub( this.origin ) ), sky ) );
		// the open sky's: dark under the cover's top, lit above it, rising over ± the softness, open
		// wherever the top is the sea's, times the probes' sky visibility, never below the floor
		const cover = this.cover, A = this.ambientSettings;
		const top = cover ? cover.topAt( p.xz ).toVar() : float( 0 );
		const open = cover ? select( top.lessThan( cover.seaLevel.add( 0.02 ) ), float( 1 ), smoothstep( A.y.negate(), A.y, p.y.sub( top ) ) ) : float( 1 );
		const ambient = max( A.x, open.mul( cover?.skyVisibility ? cover.skyVisibility( p ) : float( 1 ) ) );
		return vec2( key, ambient );

	}

	// The clouds' visibility along the key light from the point p of the air. The clouds' shadow map
	// holds, for each ground point, the transmittance along a flat beam toward the clouds' light
	// (Clouds.ts `shadowAlongBeam`, the channel the air reads, narrower than the ground's from about
	// 5 degrees up), so the point is taken to its ground point along that same flat
	// beam and that light: a beam followed over the planet's curve instead, or along the haze's key
	// direction, meets the map a kilometre off at a low sun and leaves it below a sun of 0.08, where
	// the map clamps its own slope. The read is sharpened by an unsharp mask against its B-spline
	// blur, since the map is coarse and the shafts would blur into a general dimming without it;
	// lifted toward lit for a point above the shell's base (its height over the planet's curve,
	// a point d metres from the island's centre d^2 / 2R lower), less so the nearer `direction` (the
	// ray's that reaches p) lies to the key light (contrasty shafts against the sun), and floored.
	private cloudShaft( p: V3, direction: V3, sky: Sky ): F {

		const clouds = sky.clouds, s = this.keyDir, C = this.cloudShafts;
		const read = clouds.shadowAlongBeam( p ).toVar();
		const sharp = clamp( read.x.add( C.x.mul( read.x.sub( read.y ) ) ), 0, 1 );
		// the height above the sphere, from the shell's base (0) to its top (1)
		const r = p.xz.sub( clouds.shadowCentre );
		const height = p.y.add( dot( r, r ).div( 2 * EARTH_RADIUS ) );
		const lift = clamp( height.sub( clouds.shellBottom ).div( clouds.shellThickness ), 0, 1 ).mul( float( 1 ).sub( sharp ) );
		const toward = clamp( dot( direction, s ), 0, 1 );
		return max( C.y, sharp.add( lift ).sub( lift.mul( C.z ).mul( toward ) ) );

	}

	// The shadow kernel writing volume `w` (reading the other one's history): one thread per froxel.
	private buildVisibilityKernel( w: number, sky: Sky ): THREE.ComputeNode {

		const { width: W, height: H, depth: D } = this.grid;
		const target = this.visibility[ w ];
		const history = texture3D( this.visibility[ 1 - w ] );
		const before = texture3D( this.visibility[ 1 - w ] );
		const size = vec2( W, H );
		return Fn( () => {

			If( instanceIndex.lessThan( W * H * D ), () => {

				const x = int( instanceIndex.mod( W ) ).toVar(), y = int( instanceIndex.div( W ).mod( H ) ).toVar(), z = int( instanceIndex.div( W * H ) ).toVar();
				const cell = vec3( float( x ), float( y ), float( z ) ).toVar();
				// the jittered point inside the froxel: the frame's offset shifted by the froxel's own
				const n = vec3( gradientNoise( cell.xy.add( cell.z.mul( 5.588238 ) ) ), gradientNoise( cell.yx.add( cell.z.mul( 7.123 ) ).add( 17.3 ) ),
					gradientNoise( vec2( cell.z.mul( 3.17 ).add( cell.x ), cell.y.mul( 1.91 ).add( 41.7 ) ) ) );
				const o = fract( this.sequence.add( n ) ).toVar();
				// N sub-samples about it, the R3 sequence's steps apart (Roberts, "The Unreasonable
				// Effectiveness of Quasirandom Sequences", 2018), averaged: a recomputed froxel takes its
				// cell's mean, so its history converges to that rather than to whichever point it took
				const visible = vec2( 0 ).toVar();
				Loop( SUB_SAMPLES, ( { i } ) => {

					const q = fract( o.add( vec3( 0.8191725, 0.6710436, 0.5497005 ).mul( float( i ) ) ) );
					visible.addAssign( this.visibilityAt( cell, q, size, sky ) );

				} );
				visible.divAssign( SUB_SAMPLES );
				const out = visible.toVar();
				If( this.restIndex.greaterThanEqual( 0 ), () => {

					// at rest: the exact mean of the sequence so far (index 0 starts it over)
					const kept = before.load( ivec3( x, y, z ) ).xy;
					out.assign( kept.mul( this.restIndex ).add( visible ).div( this.restIndex.add( 1 ) ) );

				} ).ElseIf( this.blend.lessThan( 1 ), () => {

					// running: the history at the froxel's centre as the previous frame saw it
					const centre = this.gridPoint( cell.xy.add( 0.5 ).div( size ), this.sliceDepth( cell.z.add( 0.5 ) ) );
					const clip = this.previousViewProjection.mul( vec4( centre, 1 ) ).toVar();
					const ndc = clip.xy.div( clip.w );
					const uvw = vec3( ndc.x.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( ndc.y.mul( 0.5 ) ), this.sliceCoordinate( clip.w ).div( D ) ).toVar();
					const inside = clip.w.greaterThan( 0 ).and( uvw.x.greaterThanEqual( 0 ) ).and( uvw.x.lessThanEqual( 1 ) )
						.and( uvw.y.greaterThanEqual( 0 ) ).and( uvw.y.lessThanEqual( 1 ) ).and( uvw.z.lessThanEqual( 1 ) );
					If( inside, () => {

						out.assign( mix( history.sample( uvw ).level( float( 0 ) ).xy, visible, this.blend ) );

					} );

				} );
				textureStore( target, ivec3( x, y, z ), vec4( out, 0, 1 ) );

			} );

		} )().compute( W * H * D, [ 64 ] ).setName( `Haze.Shadow${ w }` );

	}

	// The light kernel reading shadow volume `r`: one thread per column, front to back, each channel
	// through its own optical depth.
	// The light the air scatters toward the eye along `direction` (the light kernel's, per slice:
	// see the header): a function of a point's height (metres) and of the sun's and the open sky's
	// visibility there, its terms per body built once for the direction.
	// `deck` is the sky's irradiance over pi without its haze (Sky.ts `deckIrradianceNode`), which
	// lights the air under a deck.
	private scatterToward( direction: V3, deck: V3, clouds: Clouds ): ( y: F, sun: F, ambient: F ) => V3 {

		const [ albedo, g, gain, horizon ] = [ this.lightSettings.x, this.lightSettings.y, this.lightSettings.z, this.lightSettings.w ];
		// (overcast's deck: its light's form through the air's phase, see the header) the forward
		// part, the deck's own Henyey-Greenstein lobe about the key over its mean over the sphere;
		// the diffuse part, DECK_DIFFUSE at the air's anisotropy. Their shares follow the deck's top
		// (Clouds.ts `columnTop`, worked out once a frame there): the lobe's light over an even
		// deck's of the deck's irradiance and the diffuse part's share of that irradiance, so the
		// lobe is the key's alone and leaves with it as the key sets.
		const k = clouds.forwardLobe;
		const forward = float( 1 ).sub( k.mul( k ) ).div( max( float( 1 ).add( k.mul( k ) ).sub( dot( direction, clouds.lightDir ).mul( k ).mul( 2 ) ), 1e-4 ).pow( 1.5 ) );
		const mu = clamp( direction.y, - 1, 1 );
		const inG = ( row: number[] ) => g.mul( row[ 2 ] ).add( row[ 1 ] ).mul( g ).add( row[ 0 ] );
		let diffuse = inG( DECK_DIFFUSE[ 4 ] );
		for ( let i = 3; i >= 0; i -- ) diffuse = diffuse.mul( mu ).add( inG( DECK_DIFFUSE[ i ] ) );
		const top = clouds.columnTop();
		const lobeShare = top.lobeShare.toVar(), diffuseShare = top.diffuseShare.toVar();
		const formOf = ( law: F ) => mix( float( 1 ), law.mul( diffuseShare ).add( forward.mul( lobeShare ) ), this.overcastShare );
		const deckForm = formOf( diffuse ).toVar();
		// the sky's in-scatter along the column's direction at each froxel's altitude (the fog
		// table), through the phases at use: the Rayleigh share through the sky's phase without
		// its polariser, lit by the open sky and by the sun under the earth's shadow, the aerosol
		// share by the sun once it stands over the froxel's horizon; each share's colour turned
		// toward its luminance first
		const atmosphere = this.atmosphere;
		const grey = ( colour: V3 ): V3 => mix( colour, vec3( dot( colour, LUMINANCE ) ), this.desaturate );
		// per body (0 the sun, 1 the moon), what the column shares: its direction, the phases and
		// its elevation
		const bodies = ( [ 0, 1 ] as const ).map( ( b ) => {

			const light = b === 0 ? atmosphere.sunDir : atmosphere.moonDir;
			const nu = dot( direction, light ).toVar();
			// (the earth's shadow over the seen sky, read with the column held SHADOW_ELEVATION or
			// more over the horizon: see the header)
			const level = vec2( direction.x, direction.z ).toVar();
			const across = level.div( max( length( level ), 1e-6 ) ).mul( SHADOW_ELEVATION_COS ).toVar();
			const held = vec3( across.x, SHADOW_ELEVATION_SIN, across.y ).toVar();
			const raised = select( direction.y.lessThan( SHADOW_ELEVATION_SIN ), held, direction );
			const shadow = atmosphere.skyShadowOf( raised, light ).toVar();
			// (overcast's open sky: by the view's elevation and its angle to the key, see the header)
			const overcast = b === 0 ? formOf( max( direction.y, 0 ).mul( 6 ).add( 3 ).div( 7 ) ).toVar() : float( 1 );
			// (under a deck each body's open sky gives way to the deck's light, by its share)
			const open = float( 1 ).sub( this.deckShare ).toVar();
			return {
				b, light, overcast, open, miePhase: cornetteShanks( nu, b === 0 ? g : this.moonAnisotropy ).toVar(),
				rayleighPhase: skyRayleighPhase( nu, atmosphere.rayleighForward ).toVar(), shadow,
				direct: this.sunRayleighColour[ b ], elevation: asin( clamp( light.y, - 1, 1 ) ).toVar(),
			};

		} );
		// the deck's light on the air under it: the deck over it and the sea's reflection of the deck
		// under it, scattered evenly (half the sphere each), overcast's deck in its form through the
		// air's phase (see the header), the sea's even (it reaches the air from below, where neither
		// the deck's law nor its lobe points)
		const deckLight = deck.mul( deckForm.add( SEA_DIFFUSE ).mul( 0.5 ) ).mul( this.deckShare ).toVar();
		return ( y, sun, ambient ) => {

			// (the froxel's altitude, km; its geometric horizon dips by sqrt( 2 h / R ))
			const height = max( y, 0 ).div( 1000 ).toVar();
			const dip = sqrt( height.mul( 2 / 6360 ) ).toVar();
			const scattered = vec3( 0 ).toVar();
			for ( const body of bodies ) {

				// (the sun's rows along the view, level under a deck, the moon's along the moon: see the header)
				const rows = atmosphere.fogRows( body.b === 0 ? mix( direction.y, float( DECK_ROW ), this.deckShare ) : body.light.y, height, body.b );
				const above = smoothstep( horizon.negate(), horizon, body.elevation.add( dip ) );
				const rayleigh = grey( rows.rayleigh.mul( body.rayleighPhase ) )
					.mul( this.ambientColour[ body.b ].mul( ambient ).mul( body.overcast ).mul( body.open ).add( body.direct.mul( sun ) ) ).mul( body.shadow );
				const mie = grey( rows.mie.mul( body.miePhase ) ).mul( this.mieColour[ body.b ] ).mul( above.mul( sun ) );
				scattered.addAssign( rayleigh.mul( this.weights.x ).add( mie.mul( this.weights.y ) ) );

			}
			return scattered.mul( gain.mul( albedo ) ).add( deckLight.mul( ambient ).mul( albedo ) );

		};

	}

	private buildLightKernel( r: number, deck: V3, clouds: Clouds ): THREE.ComputeNode {

		const { width: W, height: H, depth: D } = this.grid;
		const shade = texture3D( this.visibility[ r ] );
		const target = this.light;
		return Fn( () => {

			If( instanceIndex.lessThan( W * H ), () => {

				const x = int( instanceIndex.mod( W ) ).toVar(), y = int( instanceIndex.div( W ) ).toVar();
				const { view, direction } = this.gridRay( vec2( float( x ).add( 0.5 ), float( y ).add( 0.5 ) ).div( vec2( W, H ) ) );
				const forward = view.z.negate().toVar();
				const scatter = this.scatterToward( direction, deck, clouds );
				// (alpha: the band opacity in front; shown: the display opacity, through the band-to-display
				// matrix, which keeps 1 and so acts on an opacity as on a transmittance)
				const sum = vec3( 0 ).toVar(), alpha = vec3( 0 ).toVar(), shown = vec3( 0 ).toVar();
				const t0 = this.slices.x.div( forward ).toVar();
				const y0 = this.origin.y.add( direction.y.mul( t0 ) ).toVar();
				// the near haze: the far optical depth from the camera (`far`) and its factor at t0; a
				// slice's is f1 tau1 - f0 tau0, written as f1 dtau + tau0 ( f1 - f0 ) so that f = 1
				// leaves dtau exactly
				const far = this.sigma.mul( t0.mul( meanExtinction( this.origin.y, y0, this.layer, this.ground ) ) ).toVar();
				const f0 = nearFactor( t0, this.near ).toVar();
				Loop( D, ( { i } ) => {

					const t1 = this.sliceDepth( float( i ).add( 1 ) ).div( forward ).toVar();
					const y1 = this.origin.y.add( direction.y.mul( t1 ) ).toVar();
					const step = this.sigma.mul( t1.sub( t0 ).mul( meanExtinction( y0, y1, this.layer, this.ground ) ) ).toVar();
					const f1 = nearFactor( t1, this.near ).toVar();
					const tau = step.mul( f1 ).add( far.mul( f1.sub( f0 ) ) ).toVar();
					far.addAssign( step );
					f0.assign( f1 );
					// the slice's share of the light that reaches the eye, per channel: what it scatters
					// times what lies in front of it
					const w = vec3( 1 ).sub( alpha ).mul( tau.mul( expShare3( tau ) ) ).toVar();
					const fraction = shade.load( ivec3( x, y, i ) );
					const scattered = scatter( y0.add( y1 ).mul( 0.5 ), fraction.r, fraction.g ).toVar();
					alpha.addAssign( w );
					const next = bandToDisplay( alpha, bandPush ).toVar();
					sum.addAssign( scattered.mul( next.sub( shown ) ) );
					shown.assign( next );
					// L / alpha: the mean light of the haze in front, its limit where there is none yet
					const mean = select( shown.y.greaterThan( 1e-20 ), sum.div( max( shown, vec3( 1e-20 ) ) ), scattered );
					// (the debug view: the visibility as a grey card in the key light, so the display's
					// exposure shows 1 as mid grey)
					const out = select( this.switches.w.greaterThan( 0.5 ), vec3( fraction.r.mul( dot( this.keyColor.rgb, vec3( 0.2126, 0.7152, 0.0722 ) ) ).mul( 0.18 / Math.PI ) ), mean );
					textureStore( target, ivec3( x, y, i ), vec4( out, alpha.y ) );
					t0.assign( t1 );
					y0.assign( y1 );

				} );

			} );

		} )().compute( W * H, [ 64 ] ).setName( `Haze.Light${ r }` );

	}

	// The light volume at uvw, through a tricubic B-spline (eight trilinear taps) or trilinear.
	private sampleLight( uvw: V3 ): V4 {

		const { width: W, height: H, depth: D } = this.grid;
		const volume = texture3D( this.light );
		const size = vec3( W, H, D );
		const trilinear = volume.sample( uvw ).level( float( 0 ) );
		const coord = uvw.mul( size ).sub( 0.5 ).toVar();
		const index = floor( coord ).toVar();
		const f = coord.sub( index ).toVar();
		const f2 = f.mul( f ), f3 = f2.mul( f );
		const w0 = f3.negate().add( f2.mul( 3 ) ).sub( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w1 = f3.mul( 3 ).sub( f2.mul( 6 ) ).add( 4 ).div( 6 );
		const w2 = f3.mul( - 3 ).add( f2.mul( 3 ) ).add( f.mul( 3 ) ).add( 1 ).div( 6 );
		const w3 = f3.div( 6 );
		const g0 = w0.add( w1 ).toVar(), g1 = w2.add( w3 ).toVar();
		const h0 = index.sub( 0.5 ).add( w1.div( g0 ) ).div( size ).toVar();
		const h1 = index.add( 1.5 ).add( w3.div( g1 ) ).div( size ).toVar();
		const tap = ( a: V3, b: V3, c: V3 ) => volume.sample( vec3( a.x, b.y, c.z ) ).level( float( 0 ) );
		const z0 = mix( mix( tap( h1, h1, h0 ), tap( h0, h1, h0 ), g0.x ), mix( tap( h1, h0, h0 ), tap( h0, h0, h0 ), g0.x ), g0.y );
		const z1 = mix( mix( tap( h1, h1, h1 ), tap( h0, h1, h1 ), g0.x ), mix( tap( h1, h0, h1 ), tap( h0, h0, h1 ), g0.x ), g0.y );
		const tricubic = mix( z1, z0, g0.z );
		return select( this.switches.y.greaterThan( 0.5 ), tricubic, trilinear );

	}

	// `colour` seen through the haze over `reach` metres along the grid's ray through screen uv q,
	// `forward` its view depth per metre: the light volume sampled at reach (at most the grid's far
	// end), the opacity exact from the medium's optical depth `depth` (before each band's sigma; or
	// the grid's own with the density anti-aliasing off), each channel through its sigma and the
	// band-to-display matrix.
	private fogOver( colour: V3, q: V2, forward: F, reach: F, depth: F ): { result: V3; opacity: V3 } {

		const { depth: D } = this.grid;
		const tau = this.sigma.mul( depth ).toVar();
		const exact = bandToDisplay( tau.mul( expShare3( tau ) ), bandPush ).toVar();
		const at = min( reach.mul( forward ), this.far );
		const uvw = vec3( q, this.sliceCoordinate( at ).sub( 0.5 ).div( D ) );
		const light = this.sampleLight( uvw ).toVar();
		// (the grid holds green's band opacity: each channel's transmittance is green's to the power
		// of its sigma over green's, then through the band-to-display matrix)
		const held = bandToDisplay( vec3( 1 ).sub( exp2( this.sigma.div( this.sigma.y ).mul( log2( max( float( 1 ).sub( light.a ), 1e-30 ) ) ) ) ), bandPush ).toVar();
		const opacity = select( this.switches.z.greaterThan( 0.5 ), exact, held ).toVar();
		const result = select( this.switches.w.greaterThan( 0.5 ), light.rgb, mix( colour, light.rgb, opacity ) );
		return { result, opacity };

	}

	/** The haze toward the world direction `d`, for the sky dome (Sky.ts `fogDome`), out to
	 * `distance` (a cloud's) or by default the sky's own (to the atmosphere's top, or to the sea for a
	 * ray below the horizon): the light it adds (the light volume sampled there or at the grid's far
	 * end, whichever is nearer, times the opacity) and its transmittance, the opacity taken along the
	 * whole distance; none with `sky` off. The ray's screen position is the grid's own (unjittered)
	 * projection of `d`, so the dome reads the volume where the grid holds it whether or not it draws
	 * jittered. `from` stands the ray's start at another height (metres; the camera's by default),
	 * which changes the opacity only: the light is the volume's, read on the camera's grid. `dome`
	 * (the dome's own call, Pipeline.ts) adds, on the sky's own ray only (no `distance`, no `from`),
	 * the dome's thin haze (the key's `skyDepth`, see the header) to the medium's depth; every other
	 * caller (the clouds' haze, `probe`) reads the medium alone. */
	skyHaze( d: V3, distance?: F, from?: F, dome = false ): { light: V3; transmittance: V3 } {

		const view = this.cameraInverse.mul( vec4( d, 0 ) ).xyz.toVar();
		const clip = this.gridProjection.mul( vec4( view, 1 ) ).toVar();
		const q = vec2( clip.x.div( clip.w ).mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( clip.y.div( clip.w ).mul( 0.5 ) ) );
		const forward = max( view.z.negate(), 1e-4 ).toVar();
		// the distance to the atmosphere's top on the sphere (a difference of squares, which keeps
		// its digits at the planet's radius), or to the sea, flat, as the haze's surfaces take it
		const y = () => from ?? this.origin.y;
		const r = y().add( ATMOSPHERE_BOTTOM ).toVar();
		const top = r.mul( d.y ).negate().add( sqrt( r.mul( r ).mul( d.y.mul( d.y ) ).add( float( ATMOSPHERE_TOP ).sub( r ).mul( r.add( ATMOSPHERE_TOP ) ) ) ) );
		const down = d.y.lessThan( 0 ).toVar();
		const whole = select( down, y().div( max( d.y.negate(), 1e-6 ) ), top ).toVar();
		const length = ( distance ? min( distance, whole ) : whole ).toVar();
		// the optical depth along a straight ray, as the haze's surfaces take it: the length times the
		// medium's mean density over the heights it spans (`meanExtinction`), the height climbing with
		// d.y alone, not lifted by the planet's curve. So the haze closes over the sky near the horizon:
		// at 1 degree the ray holds the ground layer and the aerosols' lower air for tens of kilometres.
		// (Two parts, the far one from the height the curve lifts the ray to, took about half a degree's
		// worth of air too little there: 1 - T in green 0.873 against 0.913 straight, a bent ray
		// integrated in steps 0.889, in the same medium; above 3 degrees the three differ by 0.02 or less.)
		const medium = nearLength( length, this.near ).mul( meanExtinction( y(), y().add( d.y.mul( length ) ), this.layer, from ? this.groundFrom( from ) : this.ground ) );
		// the dome's own thin haze, uniform in height over its whole length (below the horizon too,
		// to the sea), in the medium's units: green's transmittance gains exp( - skyDepth L_km ), the
		// other bands follow through sigma (0 by default adds exactly nothing)
		const depth = dome && ! distance && ! from ? medium.add( length.mul( this.skyDepth ) ) : medium;
		const fog = this.fogOver( vec3( 0 ), q, forward, length, depth );
		const on = this.switches.x.greaterThan( 0.5 );
		return { light: select( on, fog.result, vec3( 0 ) ), transmittance: select( on, vec3( 1 ).sub( fog.opacity ), vec3( 1 ) ) };

	}

	/** The haze toward the world direction `d` from `height` metres over the sea, out to `distance`
	 * (a cloud's) or by default the sky's whole way (as `skyHaze` takes it), shadowed by the clouds alone: the light it adds and its
	 * transmittance, for the environment's bake (Sky.ts `fogEnvironment`), which takes every
	 * direction, so it marches the light kernel's slices along `d` itself instead of reading the
	 * camera's grid (the same light, the sun and the open sky seen whole at every slice). The light
	 * is the mean over the slices out to the sky's distance or the grid's far end, whichever is
	 * nearer, times the opacity taken along the whole distance; none with `sky` off. */
	openSky( d: V3, height: number, clouds: Sky, distance?: F ): { light: V3; transmittance: V3 } {

		const { depth: D } = this.grid;
		const y = float( height );
		const ground = this.groundFrom( y );
		const r = y.add( ATMOSPHERE_BOTTOM ).toVar();
		const top = r.mul( d.y ).negate().add( sqrt( r.mul( r ).mul( d.y.mul( d.y ) ).add( float( ATMOSPHERE_TOP ).sub( r ).mul( r.add( ATMOSPHERE_TOP ) ) ) ) );
		const sky = select( d.y.lessThan( 0 ), y.div( max( d.y.negate(), 1e-6 ) ), top );
		const whole = ( distance ? min( distance, sky ) : sky ).toVar();
		const reach = min( whole, this.far ).toVar();
		const scatter = this.scatterToward( d, clouds.bakeDeckIrradianceNode, clouds.clouds );
		// the light kernel's march along d (its view depth per metre 1), each slice cut at reach
		const sum = vec3( 0 ).toVar(), alpha = vec3( 0 ).toVar(), shown = vec3( 0 ).toVar();
		const t0 = min( this.slices.x, reach ).toVar();
		const y0 = y.add( d.y.mul( t0 ) ).toVar();
		const far = this.sigma.mul( t0.mul( meanExtinction( y, y0, this.layer, ground ) ) ).toVar();
		const f0 = nearFactor( t0, this.near ).toVar();
		// the sun's visibility at a point t metres along d: the clouds' shadow, as the shadow kernel
		// takes it (no caster of the island's: its maps reach no farther than the island)
		// (along d from its own start, never the camera's: the bake holds no camera)
		const shaft = ( t: F ): F => this.cloudShaft( vec3( 0, y, 0 ).add( d.mul( t ) ), d, clouds );
		const first = scatter( y.add( y0 ).mul( 0.5 ), shaft( t0.mul( 0.5 ) ), float( 1 ) ).toVar();
		Loop( D, ( { i } ) => {

			const t1 = min( this.sliceDepth( float( i ).add( 1 ) ), reach ).toVar();
			const y1 = y.add( d.y.mul( t1 ) ).toVar();
			const step = this.sigma.mul( t1.sub( t0 ).mul( meanExtinction( y0, y1, this.layer, ground ) ) ).toVar();
			const f1 = nearFactor( t1, this.near ).toVar();
			const tau = step.mul( f1 ).add( far.mul( f1.sub( f0 ) ) ).toVar();
			far.addAssign( step );
			f0.assign( f1 );
			const w = vec3( 1 ).sub( alpha ).mul( tau.mul( expShare3( tau ) ) ).toVar();
			alpha.addAssign( w );
			const next = bandToDisplay( alpha, bandPush ).toVar();
			sum.addAssign( scatter( y0.add( y1 ).mul( 0.5 ), shaft( t0.add( t1 ).mul( 0.5 ) ), float( 1 ) ).mul( next.sub( shown ) ) );
			shown.assign( next );
			t0.assign( t1 );
			y0.assign( y1 );

		} );
		const mean = select( shown.y.greaterThan( 1e-20 ), sum.div( max( shown, vec3( 1e-20 ) ) ), first );
		// the opacity along the whole distance, as `skyHaze` takes it
		const depth = nearLength( whole, this.near ).mul( meanExtinction( y, y.add( d.y.mul( whole ) ), this.layer, ground ) );
		const tau = this.sigma.mul( depth ).toVar();
		const opacity = bandToDisplay( tau.mul( expShare3( tau ) ), bandPush ).toVar();
		const on = this.switches.x.greaterThan( 0.5 );
		return { light: select( on, mean.mul( opacity ), vec3( 0 ) ), transmittance: select( on, vec3( 1 ).sub( opacity ), vec3( 1 ) ) };

	}

	/** The haze the frame lays over each of `rays` (world directions from the camera; at most
	 * PROBE_RAYS): over a surface at `distance` metres, as the composite fogs it, or with no
	 * distance over the sky, as the dome fogs itself (`skyHaze`, to the atmosphere's top). Each
	 * reading is the opacity 1 - T per display channel and the light it lays at full opacity (the
	 * haze's added colour over the opacity), evaluated on the GPU by the composite's own nodes
	 * (`fogOver`) on the last frame's camera, medium and light volume, in a kernel built on the
	 * first call (none exists on a page that never calls it). A ray's `height` (metres over the sea)
	 * starts it there instead of at the camera: the opacity is the medium's own along that ray, as
	 * a camera there would see it, while the light stays the camera's volume's. A sky ray reads the
	 * medium alone, without the dome's own thin haze (`skyHaze`'s `dome`, the key's `skyDepth`). For
	 * a script that reads cells. */
	async probe( renderer: THREE.WebGPURenderer, rays: readonly { direction: THREE.Vector3Like; distance?: number; height?: number }[] ): Promise<{ opacity: number[]; light: number[] }[]> {

		if ( rays.length > PROBE_RAYS ) throw new Error( `VolumetricHaze.probe: at most ${ PROBE_RAYS } rays` );
		if ( ! this.probeKernel ) {

			const input = instancedArray( PROBE_RAYS, 'vec4' ), heights = instancedArray( PROBE_RAYS, 'float' ), out = instancedArray( PROBE_RAYS * 2, 'vec4' );
			const kernel = Fn( () => {

				const ray = input.element( instanceIndex ).toVar();
				const d = normalize( ray.xyz ).toVar();
				const from = heights.element( instanceIndex ).toVar();
				// (the medium alone: not the dome's own haze, so the readings are the medium's opacity)
				const sky = this.skyHaze( d, undefined, from, false );
				// (a surface: the composite's ray, through the grid's own projection of d)
				const view = this.cameraInverse.mul( vec4( d, 0 ) ).xyz.toVar();
				const clip = this.gridProjection.mul( vec4( view, 1 ) ).toVar();
				const q = vec2( clip.x.div( clip.w ).mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( clip.y.div( clip.w ).mul( 0.5 ) ) );
				const distance = max( ray.w, 0 ).toVar();
				const surface = this.fogOver( vec3( 0 ), q, view.z.negate(), distance, nearLength( distance, this.near ).mul( meanExtinction( from, from.add( d.y.mul( distance ) ), this.layer, this.groundFrom( from ) ) ) );
				const onSky = ray.w.lessThan( 0 ).toVar();
				const opacity = select( onSky, vec3( 1 ).sub( sky.transmittance ), surface.opacity ).toVar();
				const added = select( onSky, sky.light, surface.result ).toVar();
				out.element( instanceIndex.mul( 2 ) ).assign( vec4( opacity, 0 ) );
				out.element( instanceIndex.mul( 2 ).add( 1 ) ).assign( vec4( added, 0 ) );

			} )().compute( PROBE_RAYS, [ 64 ] ).setName( 'Haze.Probe' );
			this.probeKernel = { input, heights, out, kernel };

		}
		const { input, heights, out, kernel } = this.probeKernel;
		const data = ( input.value as THREE.StorageBufferAttribute ).array as Float32Array;
		const from = ( heights.value as THREE.StorageBufferAttribute ).array as Float32Array;
		data.fill( 0 );
		rays.forEach( ( ray, i ) => {

			data.set( [ ray.direction.x, ray.direction.y, ray.direction.z, ray.distance ?? - 1 ], i * 4 );
			from[ i ] = ray.height ?? this.origin.value.y;

		} );
		( input.value as THREE.StorageBufferAttribute ).needsUpdate = true;
		( heights.value as THREE.StorageBufferAttribute ).needsUpdate = true;
		await renderer.computeAsync( kernel );
		const buffer = new Float32Array( await renderer.getArrayBufferAsync( out.value as THREE.StorageBufferAttribute ) );
		return rays.map( ( _r, i ) => {

			const opacity = Array.from( buffer.subarray( i * 8, i * 8 + 3 ) ), added = buffer.subarray( i * 8 + 4, i * 8 + 7 );
			return { opacity, light: opacity.map( ( o, c ) => o > 0 ? added[ c ] / o : 0 ) };

		} );

	}

	/** `depth` is the linear view z of the nearest surface, the sea's included. `veil` returns the
	 * colour `background` seen through the rain along a view direction, in front of content at a
	 * given distance, and the veil's opacity there in its alpha, which the result keeps (0 without
	 * a veil); it is also given the haze's transmittance to that content (`background` is `color`
	 * times it plus the haze's light), and may return that in the alpha instead (the composite
	 * after the resolve, Pipeline.ts, where the veil is laid later along `viewRay`). The volumes are
	 * imported into `graph`; `passes` then adds the kernels' passes. Called once, as the frame graph
	 * is built. */
	apply( color: V3, depth: THREE.Texture, sky: Sky, graph: GraphResources, veil?: ( direction: V3, distance: F, background: V3, transmittance: F ) => V4 ): V4 {

		const { width: W, height: H } = this.grid;
		this.resolution = graph.extent( { of: 'render' } );
		const fixed: SizeClass = { of: 'fixed', width: W, height: H };
		this.resources = {
			visibility: graph.import( 'haze.visibility', this.visibility[ 0 ], fixed ),
			light: graph.import( 'haze.light', this.light, fixed ),
		};
		this.visibilityKernels = [ this.buildVisibilityKernel( 0, sky ), this.buildVisibilityKernel( 1, sky ) ];
		this.lightKernels = [ this.buildLightKernel( 0, sky.deckIrradianceNode, sky.clouds ), this.buildLightKernel( 1, sky.deckIrradianceNode, sky.clouds ) ];
		const sceneDepth = texture( depth );
		return Fn( () => {

			const q = uv().toVar();
			const px = ivec2( clamp( q.mul( this.resolution ), 0, this.resolution.sub( 1 ) ) );
			const z = ( textureLoad( sceneDepth, px ) as unknown as F ).toVar();
			const ndc = vec3( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), 1 );
			const viewFar = this.projectionInverse.mul( vec4( ndc, 1 ) ).toVar();
			const ray = viewFar.xyz.div( viewFar.w ).toVar();
			const view = normalize( ray ).toVar();
			const direction = normalize( this.cameraWorld.mul( vec4( view, 0 ) ).xyz ).toVar();
			const forward = view.z.negate().toVar();
			// (the sky fogs itself, `skyHaze`: its pixels are left as they are)
			const sky_ = z.lessThan( SKY_Z ).toVar();
			// (the veil's distance: the surface's, 1e5 for the sky)
			const distance = select( sky_, float( 1e5 ), z.div( view.z ) ).toVar();
			const fogged = this.fogOver( color, q, forward, distance, nearLength( distance, this.near ).mul( meanExtinction( this.origin.y, this.origin.y.add( direction.y.mul( distance ) ), this.layer, this.ground ) ) );
			const result = select( sky_, color, fogged.result );
			// (the veil's: green's)
			const transmittance = float( 1 ).sub( select( sky_, float( 0 ), fogged.opacity.y ) );
			return veil ? veil( direction, distance, result, transmittance ) : vec4( result, 0 );

		} )();

	}

	/** Adds the haze's two kernels to `graph`, before the composite: the shadow's (skipped while a
	 * converged rest holds it) and the light's. Returns the light volume, which the composite reads. */
	passes<Frame>( graph: FrameGraph<Frame> ): ResourceHandle[] {

		const LABEL = 'volumetric haze';
		let { visibility, light } = this.resources!;
		const { width, height } = this.grid;
		const size: SizeClass = { of: 'fixed', width, height };
		graph.addPass( 'hazeShadow', 'compute', ( b ) => {

			visibility = b.storage( visibility );
			return {
				label: LABEL, size, when: () => this.shadowDue && debugFlags.hazeKernels !== false, whenLabel: 'not held by a rest', compute: this.cover?.late ? undefined : this.visibilityKernels,
				run: ( _f, g ) => {

					this.written = 1 - this.written;
					g.renderer.compute( this.visibilityKernels[ this.written ] );

				},
			};

		} );
		graph.addPass( 'hazeLight', 'compute', ( b ) => {

			b.readOptional( visibility );
			light = b.storage( light );
			return {
				label: LABEL, size, compute: this.lightKernels, run: ( _f, g ) => {

					// (`flags.hazeKernels = false` skips both kernels, for timing them: the composite
					// then reads the volumes as they last were)
					if ( debugFlags.hazeKernels !== false ) g.renderer.compute( this.lightKernels[ this.written ] );

				},
			};

		} );
		return [ light ];

	}

	/** Records the settings the environment's bake reads (BAKE_SETTINGS), as it bakes (main.ts
	 * `bakeEnvironment`). */
	noteBake(): void {

		const S = this.settings, baked = this.baked ??= { ...S };
		for ( const k of BAKE_SETTINGS ) ( baked as Record<string, number | boolean> )[ k ] = S[ k ];

	}

	/** Whether a setting the environment's bake reads has changed since it last baked (false before
	 * the first `noteBake`): main.ts `retuneSky` rebakes it then, as a fresh load with the settings
	 * would bake. */
	get bakeStale(): boolean {

		const S = this.settings, baked = this.baked;
		if ( ! baked ) return false;
		for ( const k of BAKE_SETTINGS ) if ( baked[ k ] !== S[ k ] ) return true;
		return false;

	}

	/** Sets the medium and its light from the look, the amounts and the weather's light (the
	 * camera's height only for the ground layer's width at the camera): what `openSky` reads, so
	 * the environment's bake calls it before it bakes (main.ts `prepareHaze`), and `update` every
	 * frame. */
	prepareMedium(): void {

		const S = this.settings;
		// the medium
		// (the haze is the deep part's extinction, 2 rho_f, in the band of sigma 1; the fog's unit is
		// the deep part's green extinction)
		const look = this.look;
		this.sigma.value.copy( look.sigma );
		const rho = this.haze.value / 2 + this.fog.value * S.fogExtinction / ( 2 * Math.max( look.sigma.y, 1e-6 ) );
		this.widthRule.value.set( look.width, look.widthSlope );
		this.ground.value.set( rho, ISLAND_TOP + look.top, this.widthAt( this.origin.value.y ) );
		this.layer.value.set( rho * look.aerosolShare, look.aerosolHeight, Math.min( look.aerosolTop, AEROSOL_OPEN ) );
		this.skyDepth.value = look.skyDepth / 1000 / Math.max( look.sigma.y, 1e-6 );
		this.near.value.set( S.nearHaze ? look.nearDensity : 1, look.nearStart, Math.max( look.nearEnd, look.nearStart ) );
		const copy = this.cloudMedium;
		if ( copy ) {

			copy.layer.value.copy( this.layer.value );
			copy.ground.value.copy( this.ground.value );
			copy.near.value.copy( this.near.value );
			// the band that closes last; none without the haze over the sky, which leaves the clouds
			// unfogged (nor with debugFlags.cloudHazeEnd = false, the whole march's A/B)
			const sigma = this.sigma.value;
			copy.sigma.value = S.sky && debugFlags.cloudHazeEnd !== false ? Math.min( sigma.x, sigma.y, sigma.z ) : 0;

		}
		this.desaturate.value = look.desaturate;
		this.lightSettings.value.set( S.albedo, S.anisotropy, S.gain * look.gain, THREE.MathUtils.degToRad( S.horizon ) );
		// the light's colours per body: its illuminance the sky is drawn with (Atmosphere
		// `sunIlluminance`, `moonIlluminance`: the moon key), the open sky's by the weather's diffuse
		// gain, the body's by its direct share, and its Rayleigh light the key's share of the aerosol's;
		// the moon's aerosol light then takes its own colour at the same luminance, times its gain
		const weather = this.weatherLight;
		[ this.atmosphere.sunIlluminance.value, this.atmosphere.moonIlluminance.value ].forEach( ( illuminance, b ) => {

			this.ambientColour[ b ].value.copy( illuminance ).multiplyScalar( weather.ambient );
			this.mieColour[ b ].value.copy( illuminance ).multiplyScalar( weather.direct );
			this.sunRayleighColour[ b ].value.copy( this.mieColour[ b ].value ).multiplyScalar( look.sunRayleigh );

		} );
		const moonMie = this.mieColour[ 1 ].value;
		const red = MOON_AEROSOL.red(), blue = MOON_AEROSOL.blue();
		const level = luminance( moonMie ) * MOON_AEROSOL.gain() / ( 0.2126 * red + 0.7152 + 0.0722 * blue );
		moonMie.setRGB( red * level, level, blue * level );
		this.weights.value.set( look.rayleighWeight, look.mieWeight );
		this.ambientSettings.value.set( S.ambientFloor, S.ambientSoftness );
		this.switches.value.set( S.sky ? 1 : 0, S.tricubic ? 1 : 0, S.densityAA ? 1 : 0, S.debug );
		// the slices
		const { depth } = this.grid;
		const g = S.growth, first = ( S.far - S.near ) * ( g - 1 ) / ( Math.pow( g, depth ) - 1 );
		this.slices.value.set( S.near, first, g, Math.log2( g ) );
		this.far.value = S.far;

	}

	/** Once per frame, before the graph runs: the camera (its view, and its projection without the
	 * temporal modes' jitter), the render's and the output's sizes, and the page's frame. Sets the
	 * medium and the light from the weather and the settings, and the shadow's filter for the
	 * frame: at rest, running, or held. */
	update( camera: THREE.Camera, projection: THREE.Matrix4, width: number, height: number, outputWidth: number, outputHeight: number, frame: HazeFrame ): void {

		const S = this.settings;
		this.projectionInverse.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.gridInverse.value.copy( projection ).invert();
		this.gridProjection.value.copy( projection );
		this.cameraInverse.value.copy( camera.matrixWorldInverse );
		this.cameraWorld.value.copy( camera.matrixWorld );
		this.origin.value.setFromMatrixPosition( camera.matrixWorld );
		this.prepareMedium();

		// the shadow's filter
		this.viewProjection.multiplyMatrices( projection, camera.matrixWorldInverse );
		// (the temporal rest's key, restKey, with the epoch's scene count: see restEpoch)
		const key = this.key;
		key.length = 0;
		key.push( ...camera.matrixWorld.elements, ...projection.elements, frame.time, width, height, outputWidth, outputHeight, restEpoch.scene,
			...frame.signature, ...this.keyDir.value.toArray(), this.keyColor.value.r, this.keyColor.value.g, this.keyColor.value.b,
			...this.ground.value.toArray(), ...this.layer.value.toArray(), ...this.sigma.value.toArray(), ...this.near.value.toArray(),
			S.ambientFloor, S.ambientSoftness, this.cover?.version ?? 0,
			S.near, S.far, S.growth, S.restFrames, S.jitter ? 1 : 0 );
		this.rest.sequence = S.restFrames;
		this.rest.observe( key, frame.stable );
		camera.matrixWorld.decompose( this.position, this.quaternion, this.scale );
		const last = this.last;
		const cut = ! last.valid || last.keyDir.angleTo( this.keyDir.value ) > CUT || ! last.slices.equals( this.slices.value )
			|| last.position.distanceTo( this.position ) > JUMP.distance || last.quaternion.angleTo( this.quaternion ) > JUMP.angle;
		if ( cut ) this.historyValid = false;
		const index = this.rest.index;
		this.shadowDue = ! this.rest.converged || index !== null;
		const jitter = ( i: number ) => S.jitter ? this.sequence.value.set( halton( i, 2 ), halton( i, 3 ), halton( i, 5 ) ) : this.sequence.value.setScalar( 0.5 );
		if ( index !== null ) {

			this.restIndex.value = index;
			jitter( index + 1 );

		} else {

			this.restIndex.value = - 1;
			this.frame = ( this.frame + 1 ) % Math.max( S.restFrames, 1 );
			jitter( this.frame + 1 );

		}
		this.blend.value = this.historyValid ? S.blend : 1;
		this.previousViewProjection.value.copy( last.viewProjection );
		// what the next frame reprojects through
		last.valid = true;
		last.keyDir.copy( this.keyDir.value );
		last.slices.copy( this.slices.value );
		last.position.copy( this.position );
		last.quaternion.copy( this.quaternion );
		last.viewProjection.copy( this.viewProjection );
		if ( this.shadowDue ) this.historyValid = true;

	}

	/** The inverse projection the composite's rays are reconstructed with (`update` takes the
	 * camera's): under the temporal modes the jittered one the depth they read was drawn with, set
	 * by Pipeline's jitter hook, so each pixel's ray meets its own depth sample. */
	setProjectionInverse( inverse: THREE.Matrix4 ): void {

		this.projectionInverse.value.copy( inverse );

	}

	/** The shadow's rest has not converged (main.ts holds the settled signal for it). */
	get pending(): boolean {

		return ! this.rest.converged;

	}

	/** Takes the hour's and the weather's key (HazeKeys.ts): each band's sigma, the desaturation, the
	 * gain, the sun's share in the Rayleigh light, the shares' weights and the medium's shape. The amounts themselves go
	 * in through `haze` and `fog`. */
	setLook( key: Readonly<HazeKey> ): void {

		const look = this.look;
		look.sigma.set( key.sigmaRed, key.sigmaGreen, key.sigmaBlue );
		this.deckShare.value = key.deck;
		this.overcastShare.value = key.overcastDeck;
		look.desaturate = key.desaturate;
		look.gain = key.gain;
		look.sunRayleigh = key.sunRayleigh;
		look.rayleighWeight = key.rayleighWeight;
		look.mieWeight = key.mieWeight;
		look.top = key.top;
		look.width = key.width;
		look.widthSlope = key.widthSlope;
		look.aerosolShare = key.aerosolShare;
		look.aerosolHeight = key.aerosolHeight;
		look.aerosolTop = key.aerosolTop;
		look.skyDepth = key.skyDepth;
		look.nearDensity = key.nearDensity;
		look.nearStart = key.nearStart;
		look.nearEnd = key.nearEnd;

	}

	/** Takes what hides the haze from the open sky (see HazeCover); before the frame graph is built
	 * (`apply`), whose shadow kernel reads it. Without one the ambient visibility is 1. */
	setCover( cover: HazeCover ): void {

		this.cover = cover;

	}

	/** Drops the shadow's history and its rest (a scene jump: `establishScene`). */
	invalidate(): void {

		this.historyValid = false;
		this.last.valid = false;
		this.rest.restart();

	}

	/** The medium's transmittance from a point at `height` toward `direction`, to the atmosphere's top
	 * (for the sun's glare, a sky pixel, as the dome takes it, `skyHaze`: 1 with `sky` off):
	 * each channel's through its sigma and the band-to-display matrix, in `rgb` if given, and their
	 * luminance returned (which the matrix keeps, short of its clamp). The medium's alone: the dome's
	 * own thin haze (`skyHaze`'s `dome`) is left out, so the glare and the flares it dims (the moon's
	 * among them) do not fade with the dome. */
	transmittance( height: number, direction: THREE.Vector3, rgb = _transmittance ): number {

		if ( ! this.settings.sky ) return 1;
		// (as `skyHaze` takes it: along the whole way to the atmosphere's top, on a straight ray)
		const dy = Math.max( direction.y, 1e-4 ), r = height + ATMOSPHERE_BOTTOM;
		const length = - r * dy + Math.sqrt( r * r * dy * dy + ( ATMOSPHERE_TOP - r ) * ( ATMOSPHERE_TOP + r ) );
		const tau = this.nearLengthAt( length ) * this.meanExtinctionAt( height, height + dy * length, this.widthAt( height ) );
		const sigma = this.sigma.value;
		bandToDisplayColor( rgb.setRGB( Math.exp( - tau * sigma.x ), Math.exp( - tau * sigma.y ), Math.exp( - tau * sigma.z ) ) );
		return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b;

	}

	/** Green's extinction at sea level (1/m), as the last `update` set it, within the near haze's
	 * reach (times its density factor): how hazy the air is, for the screen-space rays
	 * (LightShafts.ts), which stay near the camera. */
	get seaLevelExtinction(): number {

		return this.sigma.value.y * this.meanExtinctionAt( 0, 0 ) * this.near.value.x;

	}

	/** Readings of the medium as the last `update` set it, for the probes (tools/probe.mjs): green's
	 * extinction at `height` (1/m) and each band's sigma; a horizontal view's transmittance at that height
	 * over 1 km and 3 km (RGB) and the distance at which its luminance falls to half (m); and, given
	 * two points, the RGB and luminance transmittance between them (an eye and the island's centre).
	 * The extinction is the far medium's; the transmittances are a ray's from the eye, through the
	 * near haze. */
	readings( height: number, from?: THREE.Vector3Like, to?: THREE.Vector3Like ): {
		extinction: number; sigma: number[]; km1: number[]; km3: number[]; half: number; between?: { rgb: number[]; Y: number; distance: number };
	} {

		const sigma = this.sigma.value.toArray();
		const density = this.meanExtinctionAt( height, height );
		const display = ( c: number[] ) => bandToDisplayColor( _reading.fromArray( c ) ).toArray();
		const across = ( d: number ) => display( sigma.map( ( t ) => Math.exp( - t * density * this.nearLengthAt( d ) ) ) );
		const luminance = ( c: number[] ) => 0.2126 * c[ 0 ] + 0.7152 * c[ 1 ] + 0.0722 * c[ 2 ];
		// the luminance falls monotonically with distance: halve the bracket
		let lo = 0, hi = 1e6;
		for ( let i = 0; i < 60; i ++ ) {

			const mid = ( lo + hi ) / 2;
			if ( luminance( across( mid ) ) > 0.5 ) lo = mid; else hi = mid;

		}
		const round = ( x: number ) => Number( x.toPrecision( 4 ) );
		const out: ReturnType<VolumetricHaze[ 'readings' ]> = { extinction: round( density * sigma[ 1 ] ), sigma, km1: across( 1000 ).map( round ), km3: across( 3000 ).map( round ), half: round( lo ) };
		if ( from && to ) {

			const distance = Math.hypot( to.x - from.x, to.y - from.y, to.z - from.z );
			const tau = this.nearLengthAt( distance ) * this.meanExtinctionAt( from.y, to.y );
			const rgb = display( sigma.map( ( t ) => Math.exp( - t * tau ) ) );
			out.between = { rgb: rgb.map( round ), Y: round( luminance( rgb ) ), distance: round( distance ) };

		}
		return out;

	}

	// nearLength on the CPU, with the near haze `update` set
	private nearLengthAt( t: number ): number {

		const [ k, d0, d1 ] = this.near.value.toArray();
		const u = THREE.MathUtils.clamp( ( t - d0 ) / Math.max( d1 - d0, 1e-3 ), 0, 1 );
		return t * ( 1 - ( 1 - k ) * ( 1 - u * u * ( 3 - 2 * u ) ) );

	}

	// the ground layer's width for a start at `height` over the sea (m)
	private widthAt( height: number ): number {

		return this.look.width + this.look.widthSlope * Math.max( height, 0 );

	}

	// the ground layer for a ray that starts at `from` (m) instead of the camera's height
	private groundFrom( from: F ): V3 {

		return vec3( this.ground.x, this.ground.y, this.widthRule.x.add( this.widthRule.y.mul( max( from, 0 ) ) ) );

	}

	// meanExtinction on the CPU (the density, over heights a to b, the ground layer `width` wide),
	// from the layers `update` set
	private meanExtinctionAt( a0: number, b0: number, width = this.ground.value.z ): number {

		const a = Math.max( Math.min( a0, b0 ), 0 ), b = Math.max( a0, b0, 0 ), span = b - a;
		const share = ( x: number ) => x < 1e-3 ? 1 - x / 2 + x * x / 6 : ( 1 - Math.exp( - x ) ) / x;
		const layer = this.layer.value, ground = this.ground.value;
		const low = Math.min( a, layer.z ), under = Math.min( b, layer.z ) - low;
		const density = b > layer.z ? layer.x * under / Math.max( span, 1e-30 ) : layer.x;
		const ua = a - ground.y, ub = b - ground.y, w2 = width * width;
		const r = Math.sqrt( ua * ua + w2 ) + Math.sqrt( ub * ub + w2 );
		return density * Math.exp( - low / layer.y ) * share( under / layer.y ) + ground.x * ( 1 - ( ua + ub ) / Math.max( r, 1e-6 ) );

	}

}
