import * as THREE from 'three/webgpu';
import { Fn, Loop, clamp, cos, exp2, float, instanceIndex, int, ivec2, ivec3, log2, luminance as luma, max, mix, round, select, sin, smoothstep, storage, texture, textureLoad, textureStore, uint, uniform, uvec3, vec3, vec4 } from 'three/tsl';
import { OVERCAST_LAND, ambient, overcastLandWeight } from './AmbientGrade.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { tune, tuneKeys, tuneUniform } from '../debug/Tune.ts';
import { keyed, type DayKey, type DayKeys } from '../post/DayKeys.ts';
import { skyNight } from '../sky/DayCycle.ts';
import { IRRADIANCE_SLABS, type AmbientVolume } from './AmbientVolume.ts';
import { COSINE_LOBE, bounceLobe, coefficients, linearMaximum, shBasisAt, shConvolve, shDeringWindow, shProduct, shTowardDelta, shWindow, toMat3, type M3 } from './Harmonics.ts';
import type { Shared } from '../shared.ts';
import { deckRamp, deckSkyGain, deckSkyGap } from '../sky/Weather.ts';
import { META_VEC4, PROBE_STRIDE, SCATTER_VEC4, SEA_VEC4, shBasis } from '../world/AmbientProbes.ts';

// The ambient light's relight: the probes' baked visibility (AmbientVolume.ts, world/AmbientProbes.ts)
// lit by the sky and the key as they stand, into the probes' irradiance, a 3D texture the island's
// materials read for their ambient diffuse light (AmbientSample.ts). The method is Jasmin Patry's ("Real-Time
// Samurai Cinema: Lighting, Atmosphere, and Tonemapping in Ghost of Tsushima", SIGGRAPH 2021
// Advances in Real-Time Rendering in Games); the harmonics' operations are in Harmonics.ts.
//
// - The sky's harmonics (`project`, run from Sky.ts `onEnvironmentSource`): each bake's
//   environment source (the starlit, island-lit sky, without the sun's disk: what the environment's
//   diffuse light is filtered from) above the horizon only, below it zero (the sea is a bounce
//   surface of its own, below), projected onto the nine RGB coefficients (p. 24), on the GPU in a
//   fixed order: a kernel per SEGMENT texels of a row (each texel weighted by its solid angle),
//   one per GROUP of those, one that sums the rest in order. That last one derings the sky (p. 46)
//   per channel, each channel's window leaving it nowhere below DERING_MARGIN.sky (0) of its
//   mean, so the horizon's step does not ring into negative light, and writes the slot of the environment atlas the source is filtered into.
//   The window takes part of the sky's light off a surface facing up, more under a sky bright at
//   the zenith (a larger linear band rings deeper under the horizon, so its window is narrower).
//   The land's gains under a deck (OVERCAST_LAND_UNIT) take that loss in with the rest.
//   The relight reads the two slots the displayed environment cross-fades between, by the
//   environment's own weight (Sky.ts `environmentWeights`), so the probes follow the sky's bakes
//   as the environment does. A slot is written while its atlas is at weight 0. The same kernels
//   take the sky's geometric mean luminance above the horizon, g = exp( mean( ln L ) ), weighted by
//   solid angle and kept in the slot as its log2: the output's storage scale (below).
// - The relight (`update`, every rendered frame: a fraction of the frame's budget, so it needs no
//   cadence of its own; a paused page computes the same output every frame, from no history), one
//   invocation per probe (and per level and row of the open sea's column), in radiance
//   coefficients until the convolution:
//     direct    the sky's coefficients times the probe's sky visibility, their product truncated to
//               degree 2 (p. 24), times the sky's scale (`skyScale`): the sky's fill (main.ts
//               `skyFill`, the environment's intensity) times the probes' own sky gain (PROBE_SKY,
//               keyed by the sun's own elevation, not the key's, so the moon's key at night does
//               not move it: golden, low and high, a clouded day's held value over them, the
//               night's as the sky's own, DayCycle.ts `skyNight`), which the seen sky never takes, so the ground's sky light can be set
//               against the sun's and the sky's at every hour and under cloud; the grade adds no
//               gain of its own here (AmbientGrade.ts);
//     bounced   the probe's bounced sky visibility (the world lit by a uniform white sky, one
//               bounce) times the sky's average radiance, its constant band Y0 c0 (p. 25), gain
//               1 (the sky's harmonics hold the upper half only, so this is half the upper half's
//               mean) times the scale and the grade's `skyBounce` (a style knob, 1); plus the sea's bounce: the probe's
//               sea visibility (world/AmbientProbes.ts) times the radiance of a level diffuse
//               surface at the sea's level, SEA_ALBEDO times the irradiance it takes over pi: the
//               sky's harmonics convolved and evaluated straight up (times the sea's scale,
//               `seaScale`: the direct term's with the water's deck gain in place of the land's
//               gains and a low sun's lift of the sky's light, which the water takes and the land
//               does not, `lowSunSkyLift` below, less what a cloudy deck's gaps take back under the
//               cloud shadow, `seaGapScale`), and the key's light on level ground (the same
//               fade and lifted height as its bounce below) under the clouds' own transmittance at
//               the probe (Sky.ts `cloudVisibility`, for the gaps' share too: without the land's
//               floor or a deck's gain, as the water drawn takes it, so the sea the probes see and
//               the sea drawn are lit by one key);
//               plus the sun's (or the moon's)
//               bounce (pp. 32-33): the key reflected off an imaginary ground below and an
//               imaginary wall facing it, the two directions its reflections come from
//               ( ( lx, -ly, lz ) and ( -lx, ly, -lz ), opposite each other on the key's axis) each
//               projected as a windowed delta (`bounceLobe`) and averaged, times the bounced sky
//               visibility less the groves' in-scatter the probe's shade takes out of it (their
//               product; the gate below). The pair is an even lobe: it has no linear band, so the
//               bounce pushes the light toward no side of its own and takes its direction from the
//               bounced visibility alone (which side holds the lit ground, a grove's wall), and its
//               quadratic band lies along the key's axis (level with a low sun). Its constant band
//               is a projected direction's, 1 / ( 4 pi ) of unit radiance over the sphere, times
//               BOUNCE_GAIN, our normalisation of the pair: on the island's most open level ground
//               (0.3 m over it, where the bake sees 0.7 to 0.85 of the sky), read at degree 2 as the
//               island's receivers read it (AmbientSample.ts), the key's bounce on a face turned up
//               is 0.79 % of level ground's direct light per unit of `sunBounce` at 62 degrees, 0.74 %
//               at 50, 0.67 % at 30, 0.63 % at 18 to 20, 0.60 to 0.61 % at 13 and 10 (the lift's
//               floor) and 0.57 % at 4. At the day's `sunBounce` of 1 it makes 14 % of the ground's
//               light in shade at 62 degrees, 12 % at 50, 8 % at 30, 5 % at 20, 3 % at 13 and 10 and
//               1.6 % at 4; with `sunBounce` at 4.5, by the lit meadow, 0.3 m over the ground, the
//               light from below was 2.5 to 3 times the light from above by a grove's edge at 50 to
//               62 degrees, 1.8 at 30, 1.35 at 20 and 1.1 at 13 and 10.
//   The groves' in-scatter (the light their leaves and culms scatter toward the probe, a part of
//   the bounced visibility the bake keeps apart: world/AmbientProbes.ts) is baked under the sky
//   over the crowns, which lights the shade a grove casts as it lights its sunward side; the key
//   lights only the second. So the key's bounce takes the in-scatter through a gate, by how much
//   of the sky toward the key the probe sees (`seen`: its sky visibility at the key's true
//   direction, over open level ground's there, 0.5 + 0.75 ly): all of it from SCATTER_GATE's upper
//   end up, none from its lower end down, a smoothstep between. The sky's bounce keeps all of it.
//   With `sunBounce` at 4.5 under the clear sky, without the gate the key's bounce made 22 to 33 %
//   of the light in a grove edge's shade at 50 degrees, more than its 19.5 % in the open meadow's
//   shade, and 11 to 18 % at 20 (10 % in the open); with it, 5 to 10 % at 50 (13.6 % in the open)
//   and 4 to 6 % at 20 (8 %), and that shade's colour lies 0.005 to 0.009 from the sky's light
//   alone (Oklab a b) at 50 degrees, 0.021 to 0.030 without it. A grove's floor 2 to 6 m in from
//   its edge takes 0.43 to 0.46 of the light in the shade outside that edge at 50 degrees (0.67 to
//   0.73 without the gate) and 0.40 to 0.44 at 20 (0.52 to 0.58).
//   The key's bounce fades out as it sets (GroundBounce.ts's fade) and takes the key's irradiance
//   on level ground, the key's light times the sine of the elevation level ground takes its diffuse
//   from (the lifted one: KeyLift.ts `liftedKeyHeight`), the cloud shadow at the probe (at the box's
//   centre for the open sea) and `sunBounce`, over pi (the reflected radiance of a unit albedo): it
//   is the light the ground round the probe takes, which falls with the sun, while the lobes keep
//   the key's true direction. The direct and the bounced parts are each boosted toward their own
//   linear band's maximum by `directionality` (p. 43). In that shade by the meadow the boost makes
//   part of the balance: with `sunBounce` at 4.5, without it the light from below is 2.3 to 3 times
//   the light from above by a grove's edge at 50 to 62 degrees and 1.3 at 20. At degree 2 the boost
//   moves the quadratic band toward the delta's as well, which lights a face turned toward the part's
//   maximum more and one turned across it less: with `sunBounce` at 4.5 under the clear sky the open
//   level ground in shade reads 1.8 to 2.1
//   times its degree 1 light at 50 to 62 degrees and 1.2 at 20, and a face turned level there 1.2
//   times one turned up at 50 to 62 degrees, 0.9 at 20. Their sum is convolved with the cosine lobe
//   (Ramamoorthi and Hanrahan 2001) and deringed (p. 46) by the window that leaves its luminance
//   nowhere below DERING_MARGIN.grid (0.006) of its mean, applied to the three channels. The bounced
//   visibility is baked under a uniform white sky, so the key's bounce does not know where the
//   sun's shadow falls round the probe (Patry's own limit, p. 60): the shade a grove casts on the
//   open meadow takes the bounce off the ground as the lit meadow beside it does. Only the groves'
//   in-scatter is weighed by the probe's view toward the key (the gate above).
// - The output (AmbientVolume `irradiance`): a 3D texture of ( nx + 1 ) x IRRADIANCE_SLABS ny x nz
//   half-float RGBA texels, filtered. The probe ( i, j, k ) is at the texel ( i, j + s ny, k ) of
//   each slab s; the column x = nx holds the open sea's probe of each level, the same for every k.
//   The coefficients are the irradiance's, already convolved: E( n ) = sum c_i Y_i( n ) (three.js's
//   basis and order, Harmonics.ts), the value three's lighting models take as `irradiance` (as
//   three's `shGetIrradianceAt` returns it from radiance coefficients), in the scene's units, with
//   the sky's fill and the grade's knobs applied (not its `aoStrength`), divided by the storage
//   scale g (`storageGain`), which every reader multiplies back: half floats keep their relative
//   precision only between about 6e-5 and 65504, and the night's light would sink below that range.
//   g is the sky's geometric mean rounded to a power of two, so the division and the readers'
//   multiplication are exact and the image does not change with it. By slab, degree 1 first:
//     s = 0, 1, 2   ( c0, c1, c2, c3 ) of r, g, b
//     s = 3, 4, 5   ( c4, c5, c6, c7 ) of r, g, b
//     s = 6         ( c8 of r, g, b, v_sky )
//   v_sky, the probe's sky view factor: the share of a level surface's irradiance under a uniform
//   sky that reaches it past the land, the visibility's harmonics convolved with the cosine lobe and
//   read straight up, ( pi Y00 c0 + 2 pi / 3 Y1( up ) c1 + pi / 4 ( Y6( up ) c6 + Y8( up ) c8 ) ) / pi
//   = 0.282095 c0 + 0.325735 c1 - 0.078848 c6 - 0.136569 c8 of the visibility's coefficients,
//   saturated (exactly 1 where the whole upper hemisphere is open), unscaled, for what needs only
//   how much sky a point sees: the volumetric haze's ambient light reads it
//   (weather/VolumetricHaze.ts) through AmbientSample.ts `ambientSkyVisibility`. A cover overhead
//   counts for more than one at the horizon, as it does for the light a surface takes.
//   A material that takes degree 1 only reads the first three slabs. It samples each slab at
//   u = ( x + 0.5 ) / ( nx + 1 ), v = ( y + 0.5 + s ny ) / ( IRRADIANCE_SLABS ny ),
//   w = ( z + 0.5 ) / nz, with ( x, y, z ) = ( P - origin ) / spacing (AmbientVolume's uniforms):
//   y clamped to [ 0, ny - 1 ] so the filter never reaches the next slab, z to [ 0, nz - 1 ]; inside
//   the box x clamped to [ 0, nx - 1 ], outside it x = nx (the open sea). It clamps the result at
//   zero (the deringing leaves at most a small fraction of the mean below it).
// - Known limits, for the material that reads it (AmbientSample.ts, which clamps and blends):
//   - the seam: the box's border probes and the open sea's column are not filtered between, so a
//     point just outside the box would take the open sea's light at once, not a blend toward it;
//   - the deringing is solved on the luminance only, so a single channel can still dip a little
//     below zero where the luminance does not (clamp each channel at zero);
//   - the boost moves a part's linear band toward a delta's, whose degree 1 irradiance is negative
//     on the side turned from it: where the bounced part comes nearly all from below (open level
//     ground by the lit meadow), a receiver reading degree 1 takes less with the bounces than
//     without them (with `sunBounce` at 4.5 under the clear sky they darken that shade by about 31 %
//     at 62 degrees, 26 % at 50, 10 % at 30, 5 % at 20, 3 % at 13 and 10 and 1 % at 4); at degree 2,
//     the island's receivers' read, the quadratic band gives it back (the shares in the bounce's
//     calibration above);
//   - the probes take the key's bounce from the grade's `sunBounce` beside GroundBounce.ts's own
//     bounce of it: where materials read the volume, the ground bounce keeps its sea alone
//     (GroundBounce.ts), or the key's bounce off the land would count twice.
// - No pipeline is built after the first frame: the kernels are built once (the projection's at the
//   first bake, for the environment source's size, fixed by then), a growth swaps the buffer and
//   the texture under their nodes (new bind groups) and sets the dispatch count, a uniform; the hour
//   and the weather change uniforms only.
// - The environment's own irradiance (`environmentSlabs`): the same two slots blended as the relight
//   blends them, with the open sea's bounce over the lower half (its radiance as the relight's,
//   without the cloud shadow), convolved and scaled as its direct term, read by the materials'
//   fragment stages (a read-only storage buffer, no texture binding) as the denominator of the specular's relight
//   (AmbientSample.ts): it is the harmonics of the very source the environment's reflections are
//   filtered from, so an open point's ratio stays near 1.
// - Debug: the volume's `irradiance` view, and `readback` / `hash` of the output (a copy kernel,
//   built on first use).

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** Texels per invocation of the projection's first kernel, and partials per one of its second. */
const SEGMENT = 64, GROUP = 16;
/** vec4 per slot of the sky: nine coefficients ( r, g, b, 0 ), then ( 0, 0, 0, the log2 of the
 * geometric mean luminance ). */
const SKY_VEC4S = 10;
const VEC4S = PROBE_STRIDE / 4;
const LUMINANCE = [ 0.2126, 0.7152, 0.0722 ];
/** The deringing's margins: the window leaves a function nowhere below this share of its mean
 * (Harmonics.ts `shDeringWindow`), the probes' by their luminance, the sky's per channel (see the
 * header).
 * The sky's is 0, the least that leaves it nowhere negative: the sky is zero below the horizon, and
 * its projection rings there to -0.4 to -1.3 times its mean in the kept weathers (clear, fair,
 * cloudy and overcast, from midnight through sunrise and noon to golden hour). The window meets the
 * margin to within 10^-5 of the mean in each, so 0 needs no allowance; a margin of 0.1 would only
 * light faces turned down 9 to 16 % more from below the horizon and up 1.6 to 3.9 % less, and move
 * the irradiance's colour by at most 0.004 in Oklab's a, b.
 * The probes' is the least, in steps of 0.001, that leaves at most one windowed irradiance in
 * twenty below zero (the minimum's search lands on zero or a little under: on 143 000
 * cosine-convolved sums of two to four deltas that ring negative, 98.7 % end below zero at 0 and
 * 4.8 % at 0.006, of which the 1 % that end more than 1.6 % of the mean below are misses of the
 * minimum a margin this small does not reach). It also stays under 0.0075, up to which no probe of
 * the kept skies is windowed (their luminance stays 3.6 % of its mean or more above zero); at 0.01
 * one under the clear noon sky was. */
// (the sky's margin and the sea's albedo are read as the kernels build: the sky's kernels run at
// each bake, and a uniform in place of the sea's constant would move the probes' rounding)
const DERING_MARGIN = {
	grid: tuneUniform( 'lighting.relight.deringGrid', 0.006, { min: 0, max: 0.1 } ),
	sky: tune( 'lighting.relight.deringSky', 0, { min: 0, max: 0.3, load: true } ),
};
/** The sky view factor's weights on the visibility's coefficients 0, 1, 6 and 8 (see the header):
 * Y00, 2/3 Y1( up ), 1/4 Y6( up ) and 1/4 Y8( up ), three.js's basis, y up. */
const SKY_VIEW = [ 0.282095, 2 / 3 * 0.488603, - 0.315392 / 4, - 0.546274 / 4 ];
/** The key's bounce lobe's gain over a projected direction's (see the header). */
const BOUNCE_GAIN = 9.4;
/** The probes' own gain on the sky's light, a luminance by the sun's elevation (keyed as Sky.ts
 * `skyGain`: golden, low and high, the rising sun's keys of its own, a held value under cloud, and
 * the night key, reached by -6 degrees under cloud; a clear sky's comes in from -7 to -11 degrees
 * after sunset, by stops, and leaves from -13 to -3 before sunrise: DayCycle.ts `skyNight`). The seen sky
 * keeps its gain; the ground's sky light takes this on top, so its ratio to the sun's light can be
 * set at every hour without changing the sky the eye sees. It sets the key's illuminance at normal
 * incidence against the ambient light's irradiance on open level ground (with the ground's bounce).
 * Set once the environment took the haze's light, which lights the shade too, with the key's bounce
 * at 1 by day (AmbientGrade.ts): 0.92 at the low key and at the high one, so the land's sky light
 * per unit of the probe's sky visibility is 0.90 of the seen sky's at 18 degrees, 0.86 at 26 and
 * 0.85 at 30 (the land takes no low sun's lift, `lowSunSkyLift`), the key stands about 23 times
 * that irradiance on open level ground from 18 to 30 degrees (21 at 50 to 62, 20 at 10), the key's
 * direct light makes about 0.82 of the lit ground's light on the island view at 18 degrees (the
 * meadow 0.83) and 0.89 at 30, and the lit ground reads about 2.5 stops over its shade at 18
 * degrees (the meadow 2.6) and 2.8 at 30 (3.2). At the golden hour (`golden`, 1) the
 * key stands about 6 times that irradiance at 3 degrees on either side of the day, with Sky.ts
 * CLEAR_SKY's gain over the sky's light (the land's shade a lit part of it against a low sun, not
 * nearly black), and about 9 times at 4.2 degrees in the evening, on the way to the day's. The
 * rising sun's sky takes less of CLEAR_SKY's gain at 3 degrees (2 against the evening's 2.7: a
 * brighter sky lifts the near sea in a view across the island toward the rising sun), so the land
 * takes the rest here (`dawn`, 1.58); from the sun's rise down (`sunrise`, 0 degrees) it keeps
 * 0.77, the land's level before the sun being Sky.ts ISLAND_SKY_RISING's. About 7.25 at night, one
 * value under every night's sky: the clear night's sky is mostly the haze's moonlit light over a
 * nearly dark dome, of which the environment takes only a part, and the moonlit ground keeps about
 * fifteen times the sky's light on open ground (Sky.ts `moonKeyGain`). 1 under cloud, one value
 * from -1 degrees up, with the deck's gains over it (`update`): the deck's own, which the water
 * takes too (sky/Weather.ts DECK_SKY_GAIN, by `deckLight`: a cloudy deck's from a sun of 3 degrees,
 * whole by 6, overcast's at every sun until the twilight), or under overcast the land's gain in its
 * place (OVERCAST_LAND_UNIT times AmbientGrade.ts OVERCAST_LAND). A clouded sky sets the exposure by
 * its own light (post/Exposure.ts), so these set the land against the sky, and the deck's gain the
 * water too. It returns to 3.5 by -2.7, where
 * the night's exposure has come in whole (the blue hour's light is the night's sky's, which the
 * day's keys do not touch). */
const PROBE_SKY_LOW: DayKey<{ skyGain: number }> = { at: 12, name: 'low', values: { skyGain: 0.92 } };
const PROBE_SKY_HIGH: DayKey<{ skyGain: number }> = { at: 40, name: 'high', values: { skyGain: 0.92 } };
const PROBE_SKY: DayKeys<{ skyGain: number }> = tuneKeys( 'lighting.relight', {
	day: [ { at: 3, name: 'golden', values: { skyGain: 1 } }, PROBE_SKY_LOW, PROBE_SKY_HIGH ],
	rising: [
		{ at: 0, name: 'sunrise', values: { skyGain: 0.774 } },
		{ at: 3, name: 'dawn', values: { skyGain: 1.58 } },
		PROBE_SKY_LOW,
		PROBE_SKY_HIGH,
	],
	cloudy: [
		{ at: - 2.7, name: 'cloudyBlue', values: { skyGain: 3.5 } },
		{ at: - 1, name: 'cloudy', values: { skyGain: 1 } },
	],
	night: { skyGain: 7.25 },
}, { skyGain: { min: 0.25, max: 8, scale: 'log' } } );
const _probeSky = { skyGain: 1 };
/** A low sun's lift of the sky's light on the water, main.ts writes it once a frame to shared.ts
 * `skyLift`. The sea's bounce in the probes (`seaScale`) takes it, as the water drawn does, so
 * does the sky's light on what reads it straight (shared.ts `skyIrradianceSource`: the water body,
 * its foam and its metering light; the rain's light, the storm's spray and its whitecaps read it
 * too, and take the lift only through a front from a clear or fair sky into rain or storm under a
 * low sun, as those skies count as overcast) and the sea's reflection of the sky (ocean/Water.ts, by
 * the view's elevation, so the far sea under the horizon keeps the band it mirrors and stays under
 * the sky over it). The land's own sky light (`skyScale`: the probes' gain, PROBE_SKY, sets it), the
 * sky drawn, the environment's specular and the exposure's sky meter do not.
 *
 * Why: under the clear evening sky, the key's illuminance at normal incidence over the sky's light
 * on level ground (the probes' gain in it, then 1.04 at 12 degrees and 1.18 from 40 up) is 28 at 62
 * degrees, 30 at 50, 32 at 31, 35 at 17 and 31 at 12: the sky falls faster than the key by about
 * 0.2 stop at 31, 0.3 at 17 and 0.13 at 12, against noon, and the ratio is under noon's again below
 * about 9 degrees. The excess is the sky
 * overhead: at 17 degrees the sky above 60 has fallen 1.4 to 2.6 stops more than the key since noon,
 * the sky from 30 to 60 about 0.3 to 0.7, while the low sky across and away from the sun keeps pace
 * within about 0.3, so the far sea mirroring it needs no lift. The lift takes the excess
 * back over 12 to 17 degrees and gives way above, to none by 35 (the noon-ward sky keeps its own).
 * The morning's darker sky (sky/Sky.ts SKY_LIGHT's rising keys) is its own and takes the same lift by
 * height. At the island view under a 12 degree sun the sky's light is about a quarter of the sea's
 * light, so a stop of lift gives it about a third of a stop before the meter (0.34 measured).
 *
 * The lift: `size` stops from `floorFull` up to `from` degrees, falling along a smoothstep to none at
 * `to` above and at `floor` below. It is 1 under cloud (by the clouded share, Weather.ts
 * `cloudedShare`), where the key no longer outruns the sky. A function of the sun's height and the
 * weather alone, so it is continuous along the day and a paused frame repeats; a uniform, so no
 * pipeline. Tunable: `lighting.relight.lowSun` (the size, stops), `lowSunFloor`, `lowSunFloorFull`,
 * `lowSunFrom`, `lowSunTo` (its heights). */
const LOW_SUN_SKY = { size: 0.3, floor: 8, floorFull: 17, from: 20, to: 35 };
const lowSunSize = tune( 'lighting.relight.lowSun', LOW_SUN_SKY.size, { min: 0, max: 3 } );
const lowSunFloor = tune( 'lighting.relight.lowSunFloor', LOW_SUN_SKY.floor, { min: - 3, max: 12 } );
const lowSunFloorFull = tune( 'lighting.relight.lowSunFloorFull', LOW_SUN_SKY.floorFull, { min: - 2, max: 20 } );
const lowSunFrom = tune( 'lighting.relight.lowSunFrom', LOW_SUN_SKY.from, { min: 0, max: 40 } );
const lowSunTo = tune( 'lighting.relight.lowSunTo', LOW_SUN_SKY.to, { min: 5, max: 60 } );
const smooth01 = ( t: number ): number => {

	const x = Math.min( Math.max( t, 0 ), 1 );
	return x * x * ( 3 - 2 * x );

};
/** The lift (a gain, 1 for none) at the sun's `elevation` (degrees) under the weather's clouded
 * share `clouded`. */
export function lowSunSkyLift( elevation: number, clouded: number ): number {

	const floor = lowSunFloor(), floorFull = Math.max( lowSunFloorFull(), floor + 1e-3 );
	const from = lowSunFrom(), to = Math.max( lowSunTo(), from + 1e-3 );
	const shape = smooth01( ( elevation - floor ) / ( floorFull - floor ) ) * ( 1 - smooth01( ( elevation - from ) / ( to - from ) ) );
	const stops = lowSunSize() * shape * ( 1 - clouded );
	return stops > 0 ? 2 ** stops : 1;

}
/** The land's sky gain under overcast's deck per unit of the weather's (AmbientGrade.ts
 * OVERCAST_LAND, its gain on all of the land's ambient light): what makes the land under the deck
 * take, per unit of the bake's sky light, what a clear day's land takes in the same place, the
 * structure of the two skies' light being otherwise unlike (the sky's harmonics' window, which
 * takes another share of a deck's light off level ground than of a clear sky's; the sky's
 * visibility from the ground). It is not a choice of the weather's and is not tuned. The land's sky
 * light under overcast takes it times the weather's gain on the sky's light (the bake: the probes'
 * sky) in place of the deck's (sky/Weather.ts DECK_SKY_GAIN), not over it, by overcast's share and
 * its deck's light (AmbientGrade.ts `overcastLandWeight`: at every sun by day, gone by -6
 * degrees). The land under the deck takes its light from the drawn sky's integral, the bake (its
 * glow about the sun's place included, the clouds' forward lobe: sky/Clouds.ts FORWARD_WEIGHT), as
 * the sky's soft fill from every side, times this; the key adds the weather's floor of it through
 * the sun's map (sky/Weather.ts `deckFloor`, Sky.ts `keyDirectVisibility`). The ground takes it
 * whether or not water lies over it: where a material reads the environment's light in the
 * volume's place (the sea floor, the walls under the water) the environment's diffuse takes the
 * same gain (AmbientGrade.ts `landSky`). The water keeps the deck's gain alone, whichever reads it:
 * the water drawn (ocean/Water.ts) and the sea's bounce onto the land (`seaScale`). A cloudy deck's
 * land takes its own (CLOUDY_LAND). Its value, 6.3 with the weather's gain at 1, is the whole gain
 * the land had under overcast while the two were one number, which set the meadow and the crowns
 * against the sky over them alike. */
const OVERCAST_LAND_UNIT = 6.3;
/** The land's sky gain under a cloudy deck, in place of the deck's (sky/Weather.ts DECK_SKY_GAIN,
 * which the water keeps), by cloudy's share and its deck's light (sky/Weather.ts `deckRamp`, whole
 * from 6 degrees): on the sky's light only, the sun's bounce under a cloudy deck taking no weather
 * gain, unlike overcast's (AmbientGrade.ts OVERCAST_LAND), as a cloudy deck's land takes its key
 * through the gaps. It sets the land's light against the sky's: a higher gain lifts the meadow and,
 * through the exposure that meters both, darkens the sky over it in the frame; and it sets a gap's
 * lit meadow against a clear day's under the same sun. It is set together with the cloudy deck's
 * key gain (sky/Sky.ts CLOUDY_KEY_GAIN) and the cloudy exposure key (post/Exposure.ts `cloudy`).
 * Tunable: `lighting.relight.cloudyLand`. */
const CLOUDY_LAND = tune( 'lighting.relight.cloudyLand', 1.45, { min: 1, max: 24 } );
/** The sea's diffuse albedo as a bounce surface: the order of water's volume-scattering albedo
 * (see the header). */
const SEA_ALBEDO = tune( 'lighting.relight.seaAlbedo', 0.05, { min: 0.01, max: 0.2, scale: 'log', load: true } );
/** The convolved basis straight up: a level surface's irradiance from radiance coefficients. */
const UP = ( () => {

	const y = new Float64Array( 9 );
	shBasis( 0, 1, 0, y, 0 );
	return Array.from( y, ( v, n ) => v * COSINE_LOBE[ n ] );

} )();
/** The radiance coefficients of the lower half of the sphere (y < 0) at unit radiance. */
const LOWER_HALF = [ 2 * Math.PI * 0.282095, - Math.PI * 0.488603, 0, 0, 0, 0, 0, 0, 0 ];
/** The probe's sky toward the key, over open level ground's, from which the groves' in-scatter
 * takes none of the key's bounce to where it takes all of it (a smoothstep; see the header). */
const SCATTER_GATE = [ 0.35, 0.75 ];

interface Copy {
	kernel: THREE.ComputeNode;
	node: THREE.StorageBufferNode<'vec4'>;
	attribute: THREE.StorageBufferAttribute;
}

interface Projection {
	rows: THREE.ComputeNode;
	groups: THREE.ComputeNode;
	finish: THREE.ComputeNode;
}

/** The sky's harmonics: the environment sources' projections, a slot per environment atlas (see
 * the header). Made before the page's first bake, which it projects. */
export class AmbientSky {

	/** per slot: nine coefficients ( r, g, b, 0 ), then ( 0, 0, 0, the log2 of the geometric mean
	 * luminance above the horizon ) */
	readonly slots = new THREE.StorageBufferAttribute( new Float32Array( 2 * SKY_VEC4S * 4 ), 4 );
	/** whether a source has been projected (the relight waits for it) */
	projected = false;
	private readonly renderer: THREE.WebGPURenderer;
	private readonly writeSlot = uniform( 0, 'uint' );
	private projection: Projection | null = null;

	constructor( renderer: THREE.WebGPURenderer ) {

		this.renderer = renderer;
		this.slots.name = 'ambientSky';

	}

	/** Projects an environment source onto the slots of `atlases` (Sky.ts `onEnvironmentSource`). */
	project( source: THREE.Texture, atlases: readonly number[] ): void {

		if ( atlases.length === 0 ) return;
		this.projection ??= this.build( source );
		const { rows, groups, finish } = this.projection;
		this.renderer.compute( [ rows, groups ] );
		for ( const atlas of atlases ) {

			this.writeSlot.value = atlas;
			this.renderer.compute( finish );

		}
		this.projected = true;

	}

	// The projection's kernels for a source of its size (see the header).
	private build( source: THREE.Texture ): Projection {

		const { width: W, height: H } = source.image as { width: number; height: number };
		if ( W % SEGMENT !== 0 || ( W / SEGMENT * H ) % GROUP !== 0 ) throw new Error( `AmbientRelight: an environment source of ${ W } x ${ H }` );
		const segments = W / SEGMENT, firsts = segments * H, seconds = firsts / GROUP;
		const first = storage( new THREE.StorageBufferAttribute( new Float32Array( firsts * SKY_VEC4S * 4 ), 4 ), 'vec4', firsts * SKY_VEC4S );
		const second = storage( new THREE.StorageBufferAttribute( new Float32Array( seconds * SKY_VEC4S * 4 ), 4 ), 'vec4', seconds * SKY_VEC4S );
		const slots = storage( this.slots, 'vec4', 2 * SKY_VEC4S );
		const map = texture( source );

		// a row's SEGMENT texels above the horizon: the radiance times the solid angle times the
		// basis, the log luminance times the solid angle, and the solid angle (the source's rows run
		// from straight down, as Sky.ts's equirect: the texel ( x, y ) looks along the azimuth
		// ( ( x + 0.5 ) / W - 0.5 ) 2 pi and the elevation ( ( y + 0.5 ) / H - 0.5 ) pi)
		const rows = Fn( () => {

			const y = instanceIndex.div( uint( segments ) ), x0 = instanceIndex.mod( uint( segments ) ).mul( uint( SEGMENT ) );
			const elevation = float( y ).add( 0.5 ).div( H ).sub( 0.5 ).mul( Math.PI ).toVar();
			const across = cos( elevation ).toVar(), up = sin( elevation ).toVar();
			// the sky above the horizon only: a row below it adds nothing (the header)
			const upper = select( elevation.greaterThan( 0 ), float( 1 ), float( 0 ) ).toVar();
			const solidAngle = across.mul( ( 2 * Math.PI / W ) * ( Math.PI / H ) ).mul( upper ).toVar();
			const sums = Array.from( { length: 9 }, () => vec3( 0 ).toVar() );
			const logs = float( 0 ).toVar();
			Loop( SEGMENT, ( { i } ) => {

				const x = x0.add( uint( i ) );
				const azimuth = float( x ).add( 0.5 ).div( W ).sub( 0.5 ).mul( 2 * Math.PI ).toVar();
				const d = vec3( across.mul( cos( azimuth ) ), up, across.mul( sin( azimuth ) ) ).toVar();
				const radiance = ( textureLoad( map, ivec2( int( x ), int( y ) ) ) as unknown as V4 ).rgb.toVar();
				const L = radiance.mul( solidAngle ).toVar();
				const Y = coefficients( shBasisAt( d ).toVar() as unknown as M3 );
				sums.forEach( ( sum, n ) => sum.addAssign( L.mul( Y[ n ] ) ) );
				logs.addAssign( log2( max( luma( radiance ), 1e-12 ) ).mul( solidAngle ) );

			} );
			const base = instanceIndex.mul( uint( SKY_VEC4S ) ).toVar();
			// (the log luminance times the solid angle in the constant band's w)
			sums.forEach( ( sum, n ) => first.element( base.add( uint( n ) ) ).assign( vec4( sum, n === 0 ? logs : 0 ) ) );
			first.element( base.add( uint( 9 ) ) ).assign( vec4( 0, 0, 0, solidAngle.mul( SEGMENT ) ) );

		} )().compute( firsts, [ 64 ] ).setName( 'AmbientSky.Rows' );

		// GROUP consecutive partials each, in order
		const groups = Fn( () => {

			const sums = Array.from( { length: SKY_VEC4S }, () => vec4( 0 ).toVar() );
			const start = instanceIndex.mul( uint( GROUP ) ).toVar();
			Loop( GROUP, ( { i } ) => {

				const base = start.add( uint( i ) ).mul( uint( SKY_VEC4S ) ).toVar();
				sums.forEach( ( sum, n ) => sum.addAssign( first.element( base.add( uint( n ) ) ) ) );

			} );
			const base = instanceIndex.mul( uint( SKY_VEC4S ) ).toVar();
			sums.forEach( ( sum, n ) => second.element( base.add( uint( n ) ) ).assign( sum ) );

		} )().compute( seconds, [ 64 ] ).setName( 'AmbientSky.Groups' );

		// the rest in order, deringed per channel, into the slot
		const finish = Fn( () => {

			const sums = Array.from( { length: SKY_VEC4S }, () => vec4( 0 ).toVar() );
			Loop( seconds, ( { i } ) => {

				const base = uint( i ).mul( uint( SKY_VEC4S ) ).toVar();
				sums.forEach( ( sum, n ) => sum.addAssign( second.element( base.add( uint( n ) ) ) ) );

			} );
			const channel = ( c: 'x' | 'y' | 'z' ) => toMat3( sums.slice( 0, 9 ).map( ( s ) => s[ c ] as F ) ).toVar() as unknown as M3;
			const r = channel( 'x' ), g = channel( 'y' ), b = channel( 'z' );
			// a window per channel, each to its own margin (see the header)
			const [ rw, gw, bw ] = [ r, g, b ].map( ( m ) => coefficients( shWindow( m, shDeringWindow( m, float( DERING_MARGIN.sky() ) ).toVar() ).toVar() as unknown as M3 ) );
			const base = this.writeSlot.mul( uint( SKY_VEC4S ) ).toVar();
			for ( let n = 0; n < 9; n ++ ) slots.element( base.add( uint( n ) ) ).assign( vec4( rw[ n ], gw[ n ], bw[ n ], 0 ) );
			const logMean = sums[ 0 ].w.div( max( sums[ 9 ].w, 1e-20 ) );
			slots.element( base.add( uint( 9 ) ) ).assign( vec4( 0, 0, 0, logMean ) );

		} )().compute( 1, [ 64 ] ).setName( 'AmbientSky.Finish' );

		return { rows, groups, finish };

	}

}

export interface AmbientRelightOptions {
	renderer: THREE.WebGPURenderer;
	volume: AmbientVolume;
	shared: Shared;
	sky: AmbientSky;
	/** the displayed environment's cross-fade (Sky.ts `environmentWeights`) */
	weights: () => { a: number; b: number; blend: number };
	/** the land's cloud shadow on the key at a world point, over the weather's floor (Sky.ts
	 * `keyDirectVisibility`), for the key's bounce off the land */
	cloud: ( position: V3 ) => F;
	/** the clouds' own transmittance of the key at a world point (Sky.ts `cloudVisibility`), for the
	 * sea's bounce, as the water drawn takes it */
	seaCloud: ( position: V3 ) => F;
	/** the sine of the elevation level ground takes the key's diffuse from (KeyLift.ts
	 * `liftedKeyHeight`) */
	keyHeight: () => number;
	/** the sun's own elevation, degrees (the key's direction is the moon's by night) */
	sunElevation: () => number;
	// whether the sun climbs (DayCycle.ts `sunRising`)
	rising: () => boolean;
	/** The weather's cloud, 0 under a clear or fair sky and 1 under a cloudy or overcast one
	 * (DayKeys.ts `keyed`), for the probes' sky gain. */
	clouded: () => number;
	/** Overcast's share of the sky (sky/Weather.ts `skyMix`, a parked sky counting as overcast), for
	 * the land's own sky gain under its deck (OVERCAST_LAND_UNIT, AmbientGrade.ts OVERCAST_LAND), in
	 * place of the deck's: the share AmbientGrade.ts `update` takes for the sun's bounce. */
	overcast: () => number;
}

export class AmbientRelight {

	private readonly renderer: THREE.WebGPURenderer;
	private readonly volume: AmbientVolume;
	private readonly shared: Shared;
	private readonly weights: () => { a: number; b: number; blend: number };
	private readonly keyHeight: () => number;
	private readonly sunElevation: () => number;
	private readonly rising: () => boolean;
	private readonly clouded: () => number;
	private readonly overcast: () => number;
	private readonly sky: AmbientSky;
	private readonly slotA = uniform( 0, 'uint' );
	private readonly slotB = uniform( 0, 'uint' );
	private readonly blend = uniform( 0 );
	// the key's bounce: its even lobe's nine coefficients
	private readonly lobe = [ uniform( new THREE.Vector4() ), uniform( new THREE.Vector4() ), uniform( new THREE.Vector4() ) ];
	private readonly lobeValues = new Float64Array( 9 );
	// the gate of the groves' in-scatter: the basis at the key over open level ground's sky there
	private readonly toward = [ uniform( new THREE.Vector4() ), uniform( new THREE.Vector4() ), uniform( new THREE.Vector4() ) ];
	private readonly towardValues = new Float64Array( 9 );
	// the key's irradiance on level ground per unit of its light (the sea's bounce)
	private readonly keyLevel = uniform( 0 );
	// the sky's fill times the probes' sky gain (PROBE_SKY): the relight's scale on the sky's light
	private readonly skyScale = uniform( 1 );
	// the sea's bounce's sky scale: `skyScale` with the water's own deck gain (Weather.ts DECK_SKY_GAIN)
	// and a low sun's lift (`lowSunSkyLift`), as the water drawn takes them
	private readonly seaScale = uniform( 1 );
	private readonly seaGapScale = uniform( 0 );
	// where the open sea's probes take the cloud shadow
	private readonly seaPoint = uniform( new THREE.Vector3() );
	private readonly kernel: THREE.ComputeNode;
	private copy: Copy | null = null;
	/** whether the output has been written: until the sky's first projection it holds zeros, and no
	 * shown or settled frame may light the island with it (main.ts's reveal and settled signal wait) */
	ready = false;

	constructor( { renderer, volume, shared, sky, weights, cloud, seaCloud, keyHeight, sunElevation, rising, clouded, overcast }: AmbientRelightOptions ) {

		this.renderer = renderer;
		this.volume = volume;
		this.shared = shared;
		this.sky = sky;
		this.weights = weights;
		this.keyHeight = keyHeight;
		this.sunElevation = sunElevation;
		this.rising = rising;
		this.clouded = clouded;
		this.overcast = overcast;
		this.kernel = this.buildRelight( cloud, seaCloud );
		volume.storageGain = () => this.storageGain();

	}

	/** The output's storage scale g at a material's fragment (or the relight's kernel): the sky's
	 * geometric mean luminance above the horizon (the two slots' log2 blended by the environment's
	 * weight), rounded to a power of two (see the header). The output holds the irradiance over g;
	 * its readers multiply by it. */
	storageGain( inverse = false ): F {

		const slots = storage( this.sky.slots, 'vec4', 2 * SKY_VEC4S ).toReadOnly();
		const a = this.slotA.mul( uint( SKY_VEC4S ) ).add( uint( 9 ) ), b = this.slotB.mul( uint( SKY_VEC4S ) ).add( uint( 9 ) );
		const exponent = round( mix( slots.element( a ).w, slots.element( b ).w, this.blend ) );
		return exp2( inverse ? exponent.negate() : exponent ).toVar();

	}

	/** Relights the probes into the volume's output (once a frame, before the frame's passes and
	 * after a growth's swap). */
	update(): void {

		if ( ! this.sky.projected ) return;
		// (`flags.ambientRelight = false` or 0 skips the kernel, for timing it: the output keeps the last
		// frame's; the first relight runs whatever the flag, so the output is never left unwritten)
		if ( this.ready && ( debugFlags.ambientRelight === false || debugFlags.ambientRelight === 0 ) ) return;
		const { a, b, blend } = this.weights();
		this.slotA.value = a;
		this.slotB.value = b;
		this.blend.value = blend;
		// the key's bounce (see the header): the mean of the lobes toward where its reflections off
		// the ground and off the wall come from, weighed by level ground's cosine of the key
		const l = this.shared.sunDir.value, out = this.lobeValues;
		const elevation = this.sunElevation();
		const clouded = this.clouded(), night = skyNight( elevation, this.rising(), clouded );
		const overcast = this.overcast(), deckSky = deckSkyGain( elevation, clouded, overcast );
		// (the land's own gain under overcast's deck in place of the deck's, by overcast's deck light:
		// the unit's times the weather's)
		const landSky = deckSky + ( OVERCAST_LAND_UNIT * OVERCAST_LAND() - deckSky ) * overcastLandWeight( elevation, overcast )
			+ ( CLOUDY_LAND() - deckSky ) * ( clouded - overcast ) * deckRamp( elevation );
		// the deck's gains lift the day's sky light, before the night's key comes in over it: they
		// stand for the light the deck takes from the sun, which leaves with it
		const day = keyed( PROBE_SKY, elevation, 0, _probeSky, clouded, this.rising() ).skyGain, toNight = PROBE_SKY.night.skyGain;
		const gained = ( gain: number ) => day * gain + ( toNight - day * gain ) * night;
		const probeSky = gained( 1 ), landGain = gained( landSky );
		// the land takes the sky's light as the sky gives it; a low sun's lift of it (`lowSunSkyLift`)
		// goes to the water alone, here to the sea's bounce, as the water drawn takes it
		const fill = this.shared.skyFill.value, seaFill = fill * this.shared.skyLift.value;
		this.skyScale.value = fill * landGain;
		// the sea's bounce takes the water's gain, the deck's alone, as the water drawn does, less what a
		// cloudy deck's gaps take back by the clouds' visibility (Weather.ts `deckSkyGap`)
		this.seaScale.value = seaFill * gained( deckSky );
		this.seaGapScale.value = seaFill * day * deckSkyGap( elevation, clouded, overcast ) * ( 1 - night );
		ambient.landSky.value = landGain / probeSky;
		out.fill( 0 );
		const level = THREE.MathUtils.smoothstep( l.y, - 0.02, 0.05 ) * this.keyHeight();
		this.keyLevel.value = level;
		const gain = BOUNCE_GAIN * level;
		if ( gain > 0 ) {

			bounceLobe( l.x, - l.y, l.z, gain / 2, out );
			bounceLobe( - l.x, l.y, - l.z, gain / 2, out );

		}
		this.lobe[ 0 ].value.set( out[ 0 ], out[ 1 ], out[ 2 ], out[ 3 ] );
		this.lobe[ 1 ].value.set( out[ 4 ], out[ 5 ], out[ 6 ], out[ 7 ] );
		this.lobe[ 2 ].value.set( out[ 8 ], 0, 0, 0 );
		// the in-scatter's gate: a probe's sky visibility at the key is its coefficients times the
		// basis there; open level ground's is the upper half's, 1 / 2 + 3 / 4 ly
		const toward = this.towardValues;
		shBasis( l.x, l.y, l.z, toward, 0 );
		const open = Math.max( 0.5 + 0.75 * l.y, 1e-3 );
		for ( let i = 0; i < 9; i ++ ) toward[ i ] /= open;
		this.toward[ 0 ].value.set( toward[ 0 ], toward[ 1 ], toward[ 2 ], toward[ 3 ] );
		this.toward[ 1 ].value.set( toward[ 4 ], toward[ 5 ], toward[ 6 ], toward[ 7 ] );
		this.toward[ 2 ].value.set( toward[ 8 ], 0, 0, 0 );
		const { x0, y0, z0, nx, ny, nz, spacing } = this.volume.lattice;
		this.seaPoint.value.set( x0 + ( nx - 1 ) * spacing / 2, y0, z0 + ( nz - 1 ) * spacing / 2 );
		this.kernel.count = nx * ny * nz + ny * Math.max( nz, 1 );
		this.renderer.compute( this.kernel );
		this.ready = true;

	}

	/** The displayed environment's own irradiance at a material's fragment: its two slots' radiance
	 * coefficients blended by the environment's weight, convolved with the cosine lobe, times the
	 * volume's direct term's scale (`skyScale`, the probes' sky gain included, so an open probe
	 * reads about as much and the specular's relight stays near 1 there whatever that gain), as the
	 * volume's seven slabs (the layout AmbientSample.ts evaluates). The specular's relight divides by
	 * it (AmbientSample.ts `ambientEnvironment`). */
	environmentSlabs(): V4[] {

		const slots = storage( this.sky.slots, 'vec4', 2 * SKY_VEC4S ).toReadOnly();
		const a = this.slotA.mul( uint( SKY_VEC4S ) ).toVar(), b = this.slotB.mul( uint( SKY_VEC4S ) ).toVar();
		const scale = this.skyScale.toVar();
		const sky = Array.from( { length: 9 }, ( _, n ) => mix( slots.element( a.add( uint( n ) ) ), slots.element( b.add( uint( n ) ) ), this.blend ).xyz.toVar() as unknown as V3 );
		// the open sea's bounce below the horizon (without the cloud shadow), as the volume's
		const sea = this.seaRadiance( sky, this.seaScale.sub( this.seaGapScale ).toVar(), float( 1 ) );
		const c = sky.map( ( s, n ) => s.mul( scale ).add( sea.mul( LOWER_HALF[ n ] ) ).mul( COSINE_LOBE[ n ] ).toVar() as unknown as V3 );
		const slab = ( first: number, ch: 'x' | 'y' | 'z' ) => vec4( c[ first ][ ch ], c[ first + 1 ][ ch ], c[ first + 2 ][ ch ], c[ first + 3 ][ ch ] );
		return [ slab( 0, 'x' ), slab( 0, 'y' ), slab( 0, 'z' ), slab( 4, 'x' ), slab( 4, 'y' ), slab( 4, 'z' ), vec4( c[ 8 ], 0 ) ];

	}

	/** The radiance of the sea as a level bounce surface (see the header): SEA_ALBEDO over pi times
	 * the sky's irradiance straight up (its radiance coefficients `sky` times `scale`) and the key's
	 * on level ground under the cloud visibility `shade`. */
	private seaRadiance( sky: V3[], scale: F, shade: F ): V3 {

		const down = sky.reduce( ( sum: V3, s, n ) => UP[ n ] === 0 ? sum : sum.add( s.mul( UP[ n ] ) ), vec3( 0 ) );
		const key = vec3( this.shared.sunColor ).mul( shade ).mul( this.keyLevel );
		return max( down, vec3( 0 ) ).mul( scale ).add( key ).mul( SEA_ALBEDO() / Math.PI ).toVar();

	}

	/** The output's texels (RGBA, x fastest, then y, then z), read back. */
	async readback(): Promise<{ width: number; height: number; depth: number; data: Float32Array }> {

		const { nx, ny, nz } = this.volume.lattice;
		const width = nx + 1, height = IRRADIANCE_SLABS * ny, depth = Math.max( nz, 1 ), count = width * height * depth;
		const copy = this.copy ??= this.buildCopy( count );
		if ( copy.attribute.count < count ) {

			copy.attribute = new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
			copy.node.value = copy.attribute;

		}
		copy.kernel.count = count;
		this.renderer.compute( copy.kernel );
		const buffer = await this.renderer.getArrayBufferAsync( copy.attribute );
		return { width, height, depth, data: new Float32Array( buffer, 0, count * 4 ) };

	}

	/** SHA-256 of the output (its size and every texel), for comparing a grown page with a fresh
	 * load and a frame with the next. */
	async hash(): Promise<string> {

		const { width, height, depth, data } = await this.readback();
		const head = new Float64Array( [ width, height, depth ] );
		const bytes = new Uint8Array( head.byteLength + data.byteLength );
		bytes.set( new Uint8Array( head.buffer ), 0 );
		bytes.set( new Uint8Array( data.buffer, data.byteOffset, data.byteLength ), head.byteLength );
		const digest = await crypto.subtle.digest( 'SHA-256', bytes );
		return Array.from( new Uint8Array( digest ), ( b ) => b.toString( 16 ).padStart( 2, '0' ) ).join( '' );

	}

	// the readback's copy of the output into a buffer of `count` texels
	private buildCopy( count: number ): Copy {

		const attribute = new THREE.StorageBufferAttribute( new Float32Array( count * 4 ), 4 );
		const node = storage( attribute, 'vec4', count );
		const v = this.volume;
		const kernel = Fn( () => {

			const w = uint( v.dims.x ).add( 1 ), h = uint( v.dims.y ).mul( IRRADIANCE_SLABS );
			const x = instanceIndex.mod( w ), y = instanceIndex.div( w ).mod( h ), z = instanceIndex.div( w.mul( h ) );
			node.element( instanceIndex ).assign( textureLoad( v.irradiance, ivec3( int( x ), int( y ), int( z ) ) ) );

		} )().compute( count, [ 64 ] ).setName( 'AmbientRelight.Readback' );
		return { kernel, node, attribute };

	}

	// The relight's kernel (see the header).
	private buildRelight( cloud: ( position: V3 ) => F, seaCloud: ( position: V3 ) => F ): THREE.ComputeNode {

		const v = this.volume, shared = this.shared;
		const slots = storage( this.sky.slots, 'vec4', 2 * SKY_VEC4S ).toReadOnly();
		return Fn( () => {

			const nx = uint( v.dims.x ), ny = uint( v.dims.y ), nz = uint( v.dims.z );
			const box = nx.mul( ny ).mul( nz ).toVar();
			const id = instanceIndex;
			const inBox = id.lessThan( box ).toVar();
			// the box's probe ( i, j, k ), or the open sea's at the level j for the row k of its column
			const sea = id.sub( box ).toVar();
			const bi = id.mod( nx ).toVar(), bj = id.div( nx ).mod( ny ).toVar(), bk = id.div( nx.mul( ny ) ).toVar();
			const sj = sea.mod( ny ).toVar(), sk = sea.div( ny ).toVar();
			const i = select( inBox, bi, nx ).toVar(), j = select( inBox, bj, sj ).toVar(), k = select( inBox, bk, sk ).toVar();
			const seaProbe = box.add( sj ).toVar();
			const probe = select( inBox, id, seaProbe ).toVar();
			const base = probe.mul( uint( VEC4S ) ).toVar();
			const P = Array.from( { length: VEC4S }, ( _, n ) => v.probes.element( base.add( uint( n ) ) ).toVar() as unknown as V4 );
			const coefficient = ( c: 'x' | 'y' | 'z' | 'w' ) => toMat3( P.slice( 0, 9 ).map( ( p ) => p[ c ] as F ) ).toVar() as unknown as M3;
			const visibility = coefficient( 'x' );
			const bounced = [ coefficient( 'y' ), coefficient( 'z' ), coefficient( 'w' ) ];
			// the groves' in-scatter among it: r g b per coefficient in turn from SCATTER_VEC4
			const packed = ( f: number ) => P[ SCATTER_VEC4 + Math.floor( f / 4 ) ][ ( [ 'x', 'y', 'z', 'w' ] as const )[ f % 4 ] ] as F;
			const scatter = [ 0, 1, 2 ].map( ( c ) => toMat3( Array.from( { length: 9 }, ( _, i ) => packed( i * 3 + c ) ) ).toVar() as unknown as M3 );
			// the sea's visibility
			const seaVisibility = toMat3( Array.from( { length: 9 }, ( _, i ) => P[ SEA_VEC4 + ( i >> 2 ) ][ ( [ 'x', 'y', 'z', 'w' ] as const )[ i & 3 ] ] as F ) ).toVar() as unknown as M3;
			// the cloud shadow where the probe was baked (the open sea's at the box's centre): the land's
			// for the key's bounce, the sea's own for the sea's
			const lattice = vec3( float( i ), float( j ), float( k ) ).mul( v.spacing ).add( v.origin ).add( P[ META_VEC4 ].xyz ).toVar();
			const centre = vec3( this.seaPoint ).toVar();
			const at = select( inBox, lattice, centre ).toVar();
			const shade = cloud( at ).toVar();
			const seaShade = seaCloud( at ).toVar();
			// the sky between the displayed environment's two slots
			const a = this.slotA.mul( uint( SKY_VEC4S ) ).toVar(), b = this.slotB.mul( uint( SKY_VEC4S ) ).toVar();
			const S = Array.from( { length: SKY_VEC4S }, ( _, n ) => mix( slots.element( a.add( uint( n ) ) ), slots.element( b.add( uint( n ) ) ), this.blend ).toVar() as unknown as V4 );
			const sky = ( [ 'x', 'y', 'z' ] as const ).map( ( c ) => toMat3( S.slice( 0, 9 ).map( ( s ) => s[ c ] as F ) ).toVar() as unknown as M3 );
			const average = S[ 0 ].xyz.mul( 0.282095 ).toVar();
			const lobe = toMat3( [ this.lobe[ 0 ].x, this.lobe[ 0 ].y, this.lobe[ 0 ].z, this.lobe[ 0 ].w, this.lobe[ 1 ].x, this.lobe[ 1 ].y, this.lobe[ 1 ].z, this.lobe[ 1 ].w, this.lobe[ 2 ].x ] ).toVar() as unknown as M3;
			const skyScale = this.skyScale.toVar();
			const bounceScale = average.mul( this.skyScale ).mul( ambient.skyBounce ).toVar();
			const sunScale = vec3( shared.landKey ).mul( shade ).mul( ambient.sunBounce ).div( Math.PI ).toVar();
			// the sea's radiance as a level bounce surface
			const seaLight = this.seaRadiance( Array.from( { length: 9 }, ( _, n ) => S[ n ].xyz as V3 ), this.seaScale.sub( this.seaGapScale.mul( seaShade ) ).toVar(), seaShade );
			// the share of its in-scatter the key's bounce keeps: the probe's sky toward the key, over open
			// level ground's, through SCATTER_GATE
			const seen = coefficients( visibility ).reduce( ( sum: F, c, n ) => sum.add( c.mul( this.toward[ n >> 2 ][ ( [ 'x', 'y', 'z', 'w' ] as const )[ n & 3 ] ] ) ), float( 0 ) );
			const gate = float( 1 ).sub( smoothstep( SCATTER_GATE[ 0 ], SCATTER_GATE[ 1 ], seen ) ).toVar();
			const direct: M3[] = [], indirect: M3[] = [];
			( [ 'x', 'y', 'z' ] as const ).forEach( ( c, n ) => {

				// what the key's bounce lights: the bounced sky visibility less the in-scatter it drops
				const keyLit = sub( bounced[ n ], mul( scatter[ n ], gate ) );
				direct.push( mul( shProduct( visibility, sky[ n ] ), skyScale ) );
				indirect.push( add( add( mul( bounced[ n ], bounceScale[ c ] as F ), mul( shProduct( lobe, keyLit ), sunScale[ c ] as F ) ), mul( seaVisibility, seaLight[ c ] as F ) ) );

			} );
			// the directionality boost, per part
			const boost = ( part: M3[] ) => {

				const { direction, has } = linearMaximum( part[ 0 ], part[ 1 ], part[ 2 ] );
				const towards = direction.toVar(), amount = ambient.directionality.mul( has ).toVar();
				return part.map( ( m ) => shTowardDelta( m, towards, amount ).toVar() as unknown as M3 );

			};
			const D = boost( direct ), I = boost( indirect );
			const E = [ 0, 1, 2 ].map( ( n ) => shConvolve( add( D[ n ], I[ n ] ) ).toVar() as unknown as M3 );
			const lambda = shDeringWindow( luminance( E[ 0 ], E[ 1 ], E[ 2 ] ), DERING_MARGIN.grid ).toVar();
			const [ r, g, bl ] = E.map( ( m ) => coefficients( shWindow( m, lambda ).toVar() as unknown as M3 ) );
			const texels = [
				vec4( r[ 0 ], r[ 1 ], r[ 2 ], r[ 3 ] ), vec4( g[ 0 ], g[ 1 ], g[ 2 ], g[ 3 ] ), vec4( bl[ 0 ], bl[ 1 ], bl[ 2 ], bl[ 3 ] ),
				vec4( r[ 4 ], r[ 5 ], r[ 6 ], r[ 7 ] ), vec4( g[ 4 ], g[ 5 ], g[ 6 ], g[ 7 ] ), vec4( bl[ 4 ], bl[ 5 ], bl[ 6 ], bl[ 7 ] ),
				vec4( r[ 8 ], g[ 8 ], bl[ 8 ], 0 ),
			];
			// stored over the storage scale (see the header), the last texel's w the sky view factor
			const inverse = this.storageGain( true );
			const open = clamp( P[ 0 ].x.mul( SKY_VIEW[ 0 ] ).add( P[ 1 ].x.mul( SKY_VIEW[ 1 ] ) ).add( P[ 6 ].x.mul( SKY_VIEW[ 2 ] ) ).add( P[ 8 ].x.mul( SKY_VIEW[ 3 ] ) ), 0, 1 );
			texels.forEach( ( texel, s ) => textureStore( v.irradianceStore, uvec3( i, j.add( ny.mul( uint( s ) ) ), k ), s === 6 ? vec4( texel.xyz.mul( inverse ), open ) : texel.mul( inverse ) ) );

		} )().compute( 1, [ 64 ] ).setName( 'AmbientRelight.Relight' );

	}

}

// mat3 arithmetic, coefficient by coefficient (a mat3 times a mat3 would be the matrix product)
function mul( m: M3, s: F ): M3 {

	return ( m as unknown as { mul( s: F ): M3 } ).mul( s );

}

function add( a: M3, b: M3 ): M3 {

	return ( a as unknown as { add( b: M3 ): M3 } ).add( b );

}

function sub( a: M3, b: M3 ): M3 {

	return ( a as unknown as { sub( b: M3 ): M3 } ).sub( b );

}

// the luminance's coefficients of three channels'
function luminance( r: M3, g: M3, b: M3 ): M3 {

	return add( add( mul( r, float( LUMINANCE[ 0 ] ) ), mul( g, float( LUMINANCE[ 1 ] ) ) ), mul( b, float( LUMINANCE[ 2 ] ) ) );

}
