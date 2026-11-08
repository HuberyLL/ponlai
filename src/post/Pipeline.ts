/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, texture, textureLoad, uniform, uv, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, length, sin, log2, exp2, floor, luminance,
	sRGBTransferEOTF, sqrt, pow, mrt, outputStruct, mat4, output, atan, cos, abs, select, mod, step, Discard,
	Loop, normalize, refract,
} from 'three/tsl';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { VolumetricHaze, DEFAULT_HAZE_GRID, type HazeFrame, type HazeGrid } from '../weather/VolumetricHaze.ts';
import { LightShafts } from './LightShafts.ts';
import { FSR } from './FSR.ts';
import { PhysicalBloom } from './PhysicalBloom.ts';
import { Metering } from './Metering.ts';
import { PURKINJE, purkinjeScale, purkinjeShift } from './Purkinje.ts';
import { cloudedShare } from '../sky/Weather.ts';
import { AA_MODE, AFTER_RESOLVE, FSR3, RESOLVE, SCENE_SAMPLES, TEMPORAL } from './Antialiasing.ts';
import { beginMotionFrame, METER_LIGHT, onTaaCut, overlayMRT, sceneMRT } from './Motion.ts';
import { preExposed, preExposedRGBA, preExposure, sceneUnits } from './PreExposure.ts';
import { onSceneCut } from './SceneEvents.ts';
import { RAIN_OVERLAY, afterMRT } from './AfterResolve.ts';
import { jitter } from './Jitter.ts';
import { MEADOW_SHADE, SS_SHADOW, meadowDepthMap, meadowDepthMaterial, meadowGroundView, meadowShade, meadowShadeMaterial, screenShadowView } from './MeadowShade.ts';
import { GTAO, gtaoBlurMaterial, gtaoDepthMaterial, gtaoMap, gtaoMaterial, gtaoProjection, gtaoView } from './GTAO.ts';
import { TemporalAA, type TemporalFrame, type TemporalMode } from './TemporalAA.ts';
import { Settled, type SettleFrame } from './Settled.ts';
import { Fsr3Upscaler } from './fsr3/Fsr3Upscaler.ts';
import { QUALITY, type TemporalSettings } from '../Quality.ts';
import { FrameGraph, type ResourceHandle, type SizeClass } from './graph/FrameGraph.ts';
import type { Sky } from '../sky/Sky.ts';
import type { SunShadow } from '../lighting/SunShadow.ts';
import { ambientSkyVisibility } from '../lighting/AmbientSample.ts';
import { liftedKeyHeight } from '../lighting/KeyLift.ts';
import { shared } from '../shared.ts';
import { DAY_EXPOSURE, duskForce } from '../sky/DayCycle.ts';
import type { Rain } from '../weather/Rain.ts';
import { CLIP_MARGIN, RefractionView, REFRACTION_GUARD, REFRACTION_SIZE } from '../ocean/Refraction.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { toneMatrices, whiteBalance } from './ToneSpace.ts';
import { BLUE_NOISE, blueNoiseTexture } from './BlueNoise.ts';
import { TONE_CURVE, checkToneCurve, solveToneCurve, type ToneCurve } from './ToneCurve.ts';
import { BASE_GRADE, fillGradeLut, gradeOf, lutNodes, mergeGrade, sampleLut, type GradeChanges, type GradeParams } from './GradeLut.ts';
import { LocalTone } from './LocalTone.ts';
import { keyed, type DayKey, type DayKeys } from './DayKeys.ts';
import { exposureKeys, type ExposureKey } from './Exposure.ts';
import { restEpoch, restKey } from './TemporalRest.ts';
import { tuneCheck, tuneKeys, tuneObject, tuneUniform } from '../debug/Tune.ts';
import { displacementField } from '../world/vegetation/Displacement.ts';
import { leavesPass, type FallingLeaves } from '../weather/FallingLeaves.ts';
import { localLightsPass } from '../lighting/LocalLights.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA, SCENE_SAMPLES, half float, multisampled depth): the colour and
//     the metering illuminance (meterLight, an MRT: Motion.ts's sceneMRT)
//   underwater pyramid ── underwater (the opaque colour of what lies under the sea, premultiplied by
//     that weight, and its mip chain: what the water refracts at each pixel's footprint)
//   refraction reach ── refractionReach (64 texels: how far past each edge of the screen the
//     water's refracted lookups reach in this view)
//   refraction mask ── refractionDepth at the nearest depth wherever the opaque image already holds
//     what lies under the sea, and in the guard band beyond that reach, so the refraction pass
//     shades only what it alone can show
//   depth resolve ── depthRT (view-space z of the opaque pass: sample 0, and the farthest sample)
//   opaque copy ── opaqueRT (the resolved opaque colour: what the water refracts where the
//     refraction image holds nothing, and reflects)
//   refraction ── refraction and refractionDepth: the world under the sea through a wider view, at
//     half the render's pixel density (ocean/Refraction.ts; the water's refraction source where the
//     opaque image does not hold the floor: behind what stands above the water, and off the screen)
//   water ── back into sceneRT, depth-tested per sample against the opaque samples
//   surface resolve ── surfaceRT (view-space z of the nearest surface, the sea's included: sample
//     0's, or the nearest sample's where sample 0 sees the sky, so a pixel is sky only where all its
//     samples are)
//   rain ── into sceneRT (its multisampled colour and depth are then discarded: nothing reads them;
//     without rain the water discards the colour and the surface resolve's read keeps the depth)
//   haze (weather/VolumetricHaze.ts): its froxel grid's shadow kernel (skipped while a rest holds it)
//   and its light kernel, which integrates each column into the light volume
//   sky constants: the clouds' mean transmittance over the sun's and the moon's discs, which the
//   flare's visibility reads (Sky.ts discCloudTransmittance, LightShafts.ts `occlusion`), evaluated
//   once into a texel ahead of the scene
//   falling leaves: the leaves' births and fixed steps (weather/FallingLeaves.ts: one compute pass
//   over its fixed ring, its own buffers only; a reset's frame prewarms it instead), ahead of the
//   opaque scene, which draws them; absent in the test mode
//   light shafts: the open sky near the sun, the rays marched toward it (half resolution, while the
//   sun faces the view): the crepuscular rays through the clouds' gaps until the haze reaches them
//   constants: what the post passes take that is the same for every pixel (the flare's visibility,
//   the sun's or the moon's while it is the key: depth taps over its disk times the sky constants'
//   cloud transmittance over it; the rods' colour's retinal scale, Purkinje.ts `purkinjeScale`),
//   evaluated once into a texel
//   composite (haze, rain veil, shafts, the rods' colour by night: Purkinje.ts)
//   ── hdr, once (the veil after the resolve under taa, taau)
//   metering: the histograms of hdr's luminance and of meterLight (Metering.ts: one compute pass at
//   a fixed 32 x 16 tiles, its buffer cleared by a small pass before the composite), before the
//   bloom, which reads this frame's exposure
//   meter: the exposure state from the histograms and the sky (Metering.ts, Exposure.ts), one texel,
//   adapted from the previous frame's over the scene clock's step (reset by every cut, in every
//   mode: SceneEvents.ts `onSceneCut`; taken at once on a paused clock), copied at the frame's end
//   for the next frame's meter, and read back (one reading in flight) for the next
//   pre-exposure (PreExposure.ts); while it has not reached its target (debug builds) the page is
//   not settled (`exposurePending`)
//   bloom: the bloom from hdr over its threshold (PhysicalBloom.ts: eight 13-tap downsamples from
//   half the render to 1/256 of it, the first through the threshold, then seven tent upsamples
//   adding each level back at its weight), the flare (the sun's, or the moon's while it is the
//   key) joining its first level (LightShafts.ts flare)
//   sharp (hdr + the bloom at its strength)
//   local tone: the sharp image's log luminance (localTone.luma), its bilateral grid and the grid
//   blurred across (localTone.grid, gridX, gridXY: LocalTone.ts), at fixed sizes
//   display: the exposure, the local tone mapping, tidewater's grade (the night's grade, the
//   tone, the vignette), the white balance and the tone curve in their
//   curve space (ToneSpace.ts), the grade's two tables (GradeLut.ts, indexed by the square root of linear light),
//   overcast's highlights toward grey (HIGHLIGHT_GREY), the BT.709 OETF, dither ── displayRT
//   ── copied to the screen
// Under the temporal modes (Antialiasing.ts: aa=taa|taau) the scene half is single-sampled and
// jittered, and writes the motion vectors beside the colour:
//   opaque scene ── sceneColor, velocity and meterLight (an MRT: Motion.ts's sceneMRT), sceneDepth
//   depth resolve ── depthRT (sample 0 twice: one sample)
//   underwater pyramid, refraction reach and mask ── as above, jittered with the scene
//   refraction ── as above, jittered with the scene
//   water ── sceneColor and velocity (sceneMRT), depth-tested against the opaque depth
//   surface resolve ── surfaceRT, copied at the frame's end into surfaceDepthPrev (the next
//     frame's history of the nearest surface)
//   overlay (the ground truth: taa and taau draw these after the resolve) ── the rain and the
//     storm's spray (moved from the water's scene) over the scene, with Motion.ts's overlayMRT: the
//     velocity under them kept
// and the post passes follow as above, but for the vignette and the dither, which the display pass
// leaves to the canvas pass, and (accumulating in linear light, Quality.ts `taa.linear`) for the
// output transfer: displayRT holds the BT.709 code's sRGB decode (half float),
// which the resolve averages as it is and encodes once for its canvas pass; then (TemporalAA.ts):
//   TAA neighbourhood (TAAU) ── taaStats, taaClip, taaNearest: each input pixel's 3x3 clip box,
//     history weight and nearest motion and depth, at the render's size
//   TAA resolve ── taaHistory (ping-pong: the frames accumulated, at the canvas's size for TAAU)
//     and taaEncoded (the same image encoded with the vignette, under `taa.linear`; not for aa=gt)
//   TAA rest ── taaRest (ping-pong), while a resting scene runs its jitter sequence, then copied
//     into taaRestShown once complete (TemporalRest.ts)
//   rain after resolve (taa, taau: AfterResolve.ts) ── rainOverlay: the rain's streaks and splashes
//     and the storm's spray, unjittered, at the canvas's size (premultiplied radiance, coverage), while
//     either shows
//   rain input ── rainInput, rainBehind: the grade's input at each render texel and the air there
//     (its transmittance, and the light it adds), at the render's size, while it rains
//   rain grade ── rainGrade: the grade as a table, for the canvas pass of a running frame, while it
//     rains
//   rain layer ── rainLayer: the change the rain veil and the overlay make to the graded image, at
//     the canvas's size (the overlay through the composite at the pixel), drawn here only by the
//     frame that completes the rest and for TAA's upscaled canvas pass; a running frame's canvas
//     pass draws it itself (neither rain pass runs while the rest holds its image: the frame that
//     completed it drew them, `afterHeld`)
//   canvas pass: taaEncoded (or the history or the rest's image, encoded there with the vignette),
//     RCAS, the rain layer added, dither; TAA below the canvas encodes it at the render's
//     size (taaDisplay), EASU, then RCAS, the rain layer and the dither
// (`taaResolve=off`, debug builds: the jittered frame shown as it is, through the output passes
// above, with the grade's vignette and dither, as before the resolve landed).
// Under fsr3 (Antialiasing.ts) the scene half is the temporal modes' (the sky dome jittered too,
// with its motion: Sky.ts), the composite writes veilReactive beside hdr, and FSR 3 resolves the
// frame where AMD places it (fsr3/Fsr3Upscaler.ts), after the composite and before the rest of the
// post chain:
//   FSR 3 ── its compute passes (the clears, prepare inputs, the luma and shading-change pyramids,
//     shading change, prepare reactivity, luma instability, accumulate, RCAS) on hdr, the nearest
//     surface's depth, the velocity and veilReactive, into its output: scene radiance at the
//     canvas's size (an import written through storage); the rest's held copy of the last running
//     output (fsr3Held) is read instead while the rest's sequence runs
//   bloom ── from FSR's output, its levels at their render-relative sizes
//   sharp (FSR's output + the bloom) ── at the canvas's size
//   display ── at the canvas's size, the full grade with vignette, tone curve, BT.709 OETF and dither
//     (half float), copied to the canvas by the output pass
// The rain veil's per-pixel reactive weight (veilReactive, R16F at the render's size) is a resource
// of its own the resolve reads: under the resolve the composite pass writes it as a second target
// beside hdr, the veil's opacity at the pixel (Rain.veil) x 1.5, at most 0.6, so the resolve trusts
// its history less only where the veil is dense, and the meadow beside it keeps its history. (The
// legacy inline composite, `post=` without compositeOnce, leaves it at zero.) Under taa and taau the
// veil is drawn after the resolve instead (AfterResolve.ts) and the composite writes, in place of
// veilReactive, the air's transmittance (rainAir, R16F at the render's size), which it hands over:
// the composite is affine in the scene colour at a pixel, hdr = A scene + B, so the streaks drawn
// after the resolve take the haze and the shafts of what lies behind them as they did drawn before
// the composite.
// Every pass runs at the scene's render size or a share of it. When the canvas is larger (a quality
// preset below the display's resolution), displayRT goes through FSR 1 (edge-adaptive upsampling,
// then contrast-adaptive sharpening) to the screen instead, and the dither is added there, at
// display pixels.
// The targets are the frame graph's (graph/FrameGraph.ts): each is declared with its format,
// sample count and size class (the render, a share of it, the canvas or fixed), and the graph sizes
// them all from `setSize`'s render and canvas sizes. The passes read their sizes from the graph's
// extent uniforms.
// The graph runs the whole frame as passes that declare what they read and write: the scene half
// (at 4x outside the temporal modes first the vegetation's depth, its resolve and the meadow's
// shade, MeadowShade.ts; then opaque over that depth, the depth and copy resolves, water, the
// surface resolve, rain), the haze's two kernels, the light shafts' two passes, the composite's
// constants, the
// composite, the metering histograms (and their clear before the composite), the meter, the bloom (PhysicalBloom.ts: a pass per level), the sharp image, the display pass,
// and the canvas pass, or EASU and the sharpening canvas pass while upscaling. Every pass but the
// scene passes and the canvas passes is a full-screen quad of its own, and no pass renders another
// inside it (but three's FSR1Node, `post=three-fsr`, in its canvas pass). Each pass that runs only
// now and then (rain, the haze's shadow, the light shafts, either output) says when by a predicate
// the graph evaluates at the frame's start. A pass whose output weighs nothing in what reads it (the
// shafts without the sun toward the view) is skipped rather than drawn and multiplied by 0; its
// reader reads it optionally and gets what it last held, finite, times 0. The
// `post=` legacy switches are variants of the graph, chosen as it is built.
// At startup the graph's warm-up (`graph.warm`, from main.ts) compiles every pass, so one that
// first runs later (the rain, the upscale) builds nothing then.

//
// Rules (the look itself is in docs/art-direction.md):
// - Sizes are owned by the graph (graph/FrameGraph.ts): it sizes every target by its size class
//   from `setSize` (the render; a share of it: the shafts' halves, the bloom's levels; the canvas: FSR's EASU target; fixed: the haze's volumes), and every pass reads
//   its sizes from the graph's shared extent uniforms (`graph.extent( cls )`, `graph.texel( cls )`
//   for one over it), never from a copy of its own. Declare a new target on the graph with its
//   class, and new post work as a pass of its own drawing into it, not as an rtt() inside another
//   pass's material (three sizes an rtt() to the canvas, not the render, and runs it out of the
//   graph's sight). A target three makes itself (a bloom chain's) is imported into the graph and
//   follows the render through `graph.onResize`.
// - The graph's attachment ops are derived each frame from the passes that run and the reads they
//   declare (graph/AttachmentOps.ts): with rain the water stores `sceneRT`'s samples and leaves the
//   resolve to the rain, which then discards colour and depth; without it the water discards the
//   multisampled colour and keeps the depth the surface resolve reads. So every texture a pass
//   binds from the scene target (colour, multisampled depth) must be declared (`read`,
//   `readOptional`): an undeclared read of a discarded attachment shows garbage, and one between
//   the water and the rain sees the scene without the sea.
// - `render` is `graph.execute`: the haze's kernels and the
//   output and FSR passes are graph passes too (the `post=` switches choose which are declared at
//   load), so new frame work goes in as a pass, not as a call around the graph. A pass that
//   declares no depth clears whatever depth its target holds outside the graph (the canvas's, and
//   the targets three's nodes draw into inside a pass), as three's defaults do; declare the depth
//   to keep it.
// - The water cannot sample the target it draws into: it reads `opaqueRT` and `depthRT` (sample 0,
//   and the farthest sample for what lies behind the sea at an edge pixel), and the underwater
//   pyramid (`textures.underwater`). Post passes read
//   `surfaceRT`, the nearest surface's depth with the sea's included (sky only where every sample
//   of the pixel is: the surface resolve). Multisampled depth is read
//   with `textureLoad`, one sample at a time (the sample index in its level argument);
//   single-sampled, that argument is a mip level, so load sample 0 only. View z below -9e4 is sky.
// - In a full-screen pass the camera nodes are the pass's own camera: the scene camera's matrices
//   come in as uniforms.
// - The metering illuminance (`meterLight`, METER_LIGHT: R16F at the render's size, the scene
//   target's attachment after the colour and, under the temporal modes, the velocity) holds per
//   pixel M = Y( E ) / pi in scene units of luminance, unexposed: the luminance a white Lambertian
//   surface would show there under the pixel's incident light E (the key with its shadow and
//   cosine, the sky's and the ambient volume's diffuse light with its occlusion, the ground bounce;
//   no albedo, specular, emission or air in front). Who writes it: every lit material its own M,
//   gathered from its lighting model's terms (lighting/MeterLight.ts, marked by `writeMeter`, its
//   MRT node merged through Motion.ts `meterOutput`), and the water the M of its surface (its
//   `outputStruct`'s meter: the sky's upper hemisphere and the sun on it), and the sky dome one
//   value on all its pixels, the sky's geometric-mean luminance times METER_SKY (Sky.ts, the same
//   log the exposure's sky term reads: shared.ts `skyMeterLog2`); every pixel nothing draws keeps
//   the clear value 0. Only an exact 0 is no reading, which the readers skip. The rain and the overlay pass leave it as it
//   is; a transparent draw in the opaque or the water pass (the lightning's bolt, the spray in
//   msaa's water pass) writes 0 there, accepted: a one-channel attachment cannot blend (Motion.ts),
//   and those few pixels drop out of the meter. Its reader is the metering histograms
//   (Metering.ts), whose read keeps the resolve. At 4x the target's multisample resolve averages
//   the samples into the texture the readers sample, with the coverage alpha to coverage gave the
//   colour. Like the colour it is stored pre-exposed (PreExposure.ts: every writer multiplies by
//   2^P, one uniform per frame, P a whole number of stops from the last exposure read back), and
//   the meter divides 2^P back out, so it works in absolute log2 of these units. Half float is
//   normal from 2^-14 and at most 65504 (`__PONLAI__.radiance` with `range`, debug/Radiance.ts,
//   reads the share outside over the non-sky pixels). Unscaled, on a clear night 62 % of `hdr`'s
//   non-sky pixels fell below 2^-14 in the island view and 45 % in the horizon view, and 2.3 % and
//   0.6 % of meterLight's (the night's M runs about 2^-16 to 2^-7), and they were stored a little
//   dark: the night's and the dusk's images came out up to about 0.8 of an 8-bit level brighter
//   once pre-exposed. With pre-exposure none of either falls below 2^-14 there (the night's
//   smallest stored values sit about 3.5 stops above it in hdr, 7 in meterLight), and at noon the
//   largest non-sky hdr value is stored about 2.5 stops below the top; the sun's disc is held at
//   65504.
// - The display chain is tidewater's with our tone curve (ToneCurve.ts) and, over it, the local
//   tone mapping, curve space and white balance after Patry, "Real-Time Samurai Cinema" (SIGGRAPH
//   2021), in this order: the desaturation (DESATURATION) and the local tone mapping first
//   (LocalTone.ts: a function of the frame, nothing kept between frames), one
//   curve and grade (the shade's contrast, SHADE_CONTRAST; the tone, TONE, and the night's grade, NIGHT, over it are off by default), then
//   the grade's tables (GradeLut.ts, indexed by the square root of the curve's linear output: the first generated from the grade's parameters, `grade` and
//   `setGrade`, the second the identity), then overcast's highlights toward grey (HIGHLIGHT_GREY).
//   The curve maps each channel in the
//   space of ToneSpace.ts, AP1 with its red primary moved out, and the white balance is folded
//   into its input matrix (WHITE_BALANCE, keyed by the sun and the weather; rebuilt only when it changes). The exposure is metered
//   from the frame by the meter pass (Metering.ts, Exposure.ts: the metering illuminance's and the
//   luminance's histograms and the sky's mean luminance, against keyed targets) into the exposure
//   state's texel, which every pass after it loads (`exposure`, 2^( EV - P ) for the pre-exposed
//   hdr; each declares the state as a read), so they all read the same value in the same frame (the composite, before the meter, reads none:
//   the rods' colour takes its retinal scale from the night's light, Purkinje.ts); the clock's and the weather's
//   exposure (`settings.exposure`, DayCycle and Sky) no longer sets the frame's: it stays the
//   level the night sky's own light is tuned against.

// The graph's dev checks (every target at its class's size, the attachment ops that reached
// WebGPU): on the dev server and with `?debug`.
const DEV = import.meta.env.DEV || new URLSearchParams( globalThis.location?.search ?? '' ).has( 'debug' );
// The graph's warm-up renders the passes it cannot compile once at startup (`fgPrime=0`: not, for
// the check that priming changes no frame).
const PRIME = new URLSearchParams( globalThis.location?.search ?? '' ).get( 'fgPrime' ) !== '0';
// The rain veil's reactive weight: its opacity at the pixel times `gain`, at most `max` (a dense veil
// lowers the history's weight there to 40 % of its frames; a single faint streak barely moves it).
const VEIL_REACTIVE = { gain: 1.5, max: 0.6 };
// After the resolve (AfterResolve.ts), the share of a pixel the rain covers in one sample, where its
// change to the graded colour is taken before it is spread over the pixel: a supersampled image
// grades each sample, which a streak covers fully or not at all, and averages the graded samples,
// so over the dark meadow and sea, in the curve's toe, its thin rain shows brighter than the same
// coverage spread before the grade. Thin streaks drawn at their least width cover about two thirds
// of the pixels their prefiltered quads touch (RainDrops.ts).
const AFTER_COVERAGE = 0.65;
// The refraction's reach past the screen's edges (refractionReach): texels per edge, the pixels each
// follows toward it, and the margin the mask grows it by (screen uv: the reach times scale, plus add)
// for the floor's slopes, which the floor seen straight behind leaves out, and the waves' beyond.
const REACH = 64, REACH_SAMPLES = 16;
// the surface's tilt the reach follows besides the flat sea (a slope), about twice the slopes'
// spread across one axis in a strong wind
const REACH_SLOPE = 0.3;
const REACH_MARGIN = { scale: 1.3, add: 0.02 };
// The rain layer's grade table (`gradeTable`): colours per channel, and the range they span (stops of
// the scene colour times the exposure, display white at 0).
const GRADE_TABLE = { size: 64, low: - 14, high: 7 };
const RENDER: SizeClass = { of: 'render' };
// the exposure state's one texel (Metering.ts)
const EXPOSURE_TEXEL: SizeClass = { of: 'fixed', width: 1, height: 1 };
const CANVAS: SizeClass = { of: 'canvas' };
// what the water pass draws in a frame without water: nothing
const NO_WATER = new THREE.Scene();

// The refraction pass's only attachment, cleared to zero coverage (alpha 0: nothing drawn there),
// its colour pre-exposed as the scene target's (PreExposure.ts).
const REFRACTION_MRT: THREE.MRTNode = mrt( { refraction: preExposedRGBA( output ) } ).setClearColor( 'refraction', new THREE.Color( 0, 0, 0 ), 0 );

/** What a frame draws (`Pipeline.render`'s argument). `rainScene`: the rain, while it shows (under the
 * temporal modes with the storm's spray in it, but for what draws after the resolve: see `overlay`).
 * `overlay`: whether the temporal modes' overlay pass draws `rainScene` this frame (rain or spray
 * showing; not under taa and taau). `afterScene`: under taa and taau, the rain (streaks, splashes,
 * rings) and the storm's spray, drawn after the resolve (AfterResolve.ts), while either shows. */
export interface PipelineFrame {
	scene: THREE.Scene; waterScene: THREE.Scene; rainScene?: THREE.Scene; overlay?: boolean; afterScene?: THREE.Scene; camera: THREE.Camera;
	// the vegetation's depth copies with the meadow's shade (VegetationPrepass.ts `prepassScene`)
	prepassScene?: THREE.Scene;
	// the opaque scene's depth copies with the ambient occlusion or the screen-space shade over the
	// whole scene (world/OpaquePrepass.ts)
	opaquePrepassScene?: THREE.Scene;
	water: { prepare( sun: THREE.DirectionalLight ): void } | null; sun: THREE.DirectionalLight; time: number;
	// the key's shading direction (world, toward the light: lighting/KeyLift.ts), which the
	// meadow's shade marches along; left out, the light's own
	keyDirection?: THREE.Vector3;
	// the temporal resolve's per-frame inputs from the page (the rest's signature and stability, the
	// frame's delta)
	temporal?: TemporalFrame;
	// the settled signal's per-frame inputs (Settled.ts; debug builds): left out, it is not observed
	settle?: SettleFrame;
	// the haze's rest inputs (VolumetricHaze.ts: the page's signature and stability); left out, the
	// haze never rests
	haze?: HazeFrame;
}

/** The frame graph's structural choices, fixed when the page loads (the quality tier sets them;
 * the defaults are today's high). `?post=legacy` restores the graph before they were introduced,
 * for A/B timing; `?post=` also takes a comma list of single switches (see `postOptionsFromURL`). */
export interface PostOptions {
	// the haze's froxel grid (VolumetricHaze.ts)
	hazeGrid: HazeGrid;
	// the composite evaluated once into a texture the bloom and the sharp image read (else each
	// re-evaluates it)
	compositeOnce: boolean;
	// FSR 1 from FSR.ts (EASU pass, sharpening folded into the canvas pass), or three's FSR1Node
	fsrPort: boolean;
	// the legacy attachment ops (`fgOps=legacy`) discard the scene target's samples in the rain;
	// false (`post=store-scene`) keeps them (the derived ops follow `fgOps` alone, see
	// AttachmentOps.ts: `post=store-scene` maps to its `store` mode)
	discardScene: boolean;
}

export const DEFAULT_POST_OPTIONS: Readonly<PostOptions> = {
	hazeGrid: DEFAULT_HAZE_GRID, compositeOnce: true, fsrPort: true, discardScene: true,
};

const LEGACY_SWITCHES: Record<string, Partial<PostOptions>> = {
	'inline-composite': { compositeOnce: false },
	'three-fsr': { fsrPort: false },
	'store-scene': { discardScene: false },
};

/** The defaults (with a tier's options over them), with `?post=legacy` (every switch below) or
 * `?post=a,b` applied. */
export function postOptionsFromURL( search = location.search, base: Partial<PostOptions> = {} ): PostOptions {

	const options = { ...DEFAULT_POST_OPTIONS, ...base };
	for ( const name of ( new URLSearchParams( search ).get( 'post' ) ?? '' ).split( ',' ) ) {

		if ( name === 'legacy' ) for ( const change of Object.values( LEGACY_SWITCHES ) ) Object.assign( options, change );
		else if ( LEGACY_SWITCHES[ name ] ) Object.assign( options, LEGACY_SWITCHES[ name ] );

	}
	return options;

}

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;
// what a pass's setup declares its reads and writes on
type PassBuilder = Parameters<Parameters<FrameGraph<PipelineFrame>[ 'addPass' ]>[ 2 ]>[ 0 ];

// tidewater's display chain (PostFX.js, 4811ba4), as it has become: its physical bloom
// (PhysicalBloom.ts) added to the image; its grade in linear light (the vignette; its saturation
// and contrast left for the grade table's hue bands, GradeLut.ts BASE_GRADE, and the shade's
// contrast, SHADE_CONTRAST); our tone curve (ToneCurve.ts) on the exposed colour, in the curve
// space of ToneSpace.ts with the white balance folded into its input matrix; the grade's tables;
// overcast's highlights toward grey (HIGHLIGHT_GREY); the BT.709 OETF shown as sRGB, and a blue-noise dither (BlueNoise.ts; its luminance-weighted grain is gone).
// tidewater meters its frame's luminance and scales it by an auto exposure before the grade; here
// the meter reads the light on the scene (Metering.ts, Exposure.ts).

// The tone curve, each channel through one curve in the curve's space: `input` takes the exposed
// linear Rec.709 there (with the white balance), `output` brings it back (ToneSpace.ts
// toneMatrices, without saturation of their own). The curve is a rational function of the third
// degree over the third (ToneCurve.ts), its coefficients solved on the CPU from the slope at black,
// what the exposed mid grey shows and the input that shows white (`settings.curve`).
const TONE_SPACE = toneMatrices();
const toneCurve = Fn( ( [ c, input, output, num, den ]: [ V3, THREE.Node<'mat3'>, THREE.Node<'mat3'>, V3, V3 ] ) => {

	const x = max( input.mul( c ) as unknown as V3, vec3( 0 ) ).toVar();
	// ( a x^3 + b x^2 + c x ) / ( d x^3 + e x^2 + f x + 1 ), by Horner
	const n = x.mul( num.x ).add( num.y ).mul( x ).add( num.z ).mul( x );
	const d = x.mul( den.x ).add( den.y ).mul( x ).add( den.z ).mul( x ).add( 1 );
	return clamp( output.mul( clamp( n.div( d ), 0, 1 ) ) as unknown as V3, 0, 1 );

} ).setLayout( { name: 'toneCurve', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' }, { name: 'input', type: 'mat3' }, { name: 'output', type: 'mat3' }, { name: 'num', type: 'vec3' }, { name: 'den', type: 'vec3' } ] } );
// The exposed mid grey as the default curve shows it, in linear display values: the grade's
// contrast pivots there (GradeLut.ts).
const SHOWN_GREY = TONE_CURVE.mid;
// The BT.709 OETF (ITU-R BT.709): 4.5 l under 0.018, 1.099 l^0.45 - 0.099 over it. Its code shown
// as sRGB is darker in the shade than the linear value it encodes: the output's contrast.
const bt709 = Fn( ( [ l ]: [ V3 ] ) => {

	// (per channel: a 0/1 weight rather than a select of vectors)
	return mix( l.mul( 4.5 ), pow( max( l, vec3( 0.018 ) ), vec3( 0.45 ) ).mul( 1.099 ).sub( 0.099 ), step( vec3( 0.018 ), l ) );

} ).setLayout( { name: 'bt709', type: 'vec3', inputs: [ { name: 'l', type: 'vec3' } ] } );

export interface PipelineSettings {
	// the clock's and the weather's exposure (DayCycle, Sky): the level the night sky's own light
	// is tuned against, no longer the frame's (Exposure.ts meters that)
	exposure: number;
	// stops over the exposure's target (the GUI's)
	exposureOffset: number;
	// the tone curve's slope at black, the mid grey it shows and the input that shows white
	// (ToneCurve.ts TONE_CURVE)
	curve: ToneCurve;
	// the grade's two tables (GradeLut.ts, `Pipeline.luts`): 0 the first, 1 the second
	lut: number;
	// tidewater's grade: the bloom's strength and the vignette's
	bloom: number; vignette: number;
	// the light's tone over tidewater's grade (0 none, 1 full): lights a touch golden, the shade a
	// touch teal, the contrast round mid grey softer and the bloom a little stronger
	tone: number;
	// 0 by day, 1 at night (from the clock, main.ts): how far the night's grade has come in (NIGHT)
	night: number;
	// 0 by day, 1 at night: how far the exposure's night key has come in (sky/DayCycle.ts
	// `exposureNight`, apart from the display's)
	exposureNight: number;
	// the kept skies' shares in the sky as it stands (Weather.ts `skyMix`, main.ts): the clouded
	// day's keys (DayKeys.ts `cloudy`, the cloudy and overcast skies' share)
	skyMix: number[];
}

// The light's tone over tidewater's grade (docs/art-direction.md, Light): a photographic image
// pushed a little toward a painted one. Lights turn a touch golden and the shade a touch teal (by
// the exposed luminance, so the night takes it as the day), the contrast round mid grey softens by
// a tenth and the bloom strengthens by a quarter. It lifts no black: a constant fill in the grade
// greyed everything below mid grey alike and veiled the frame; the shade's openness comes from the
// sky light the island takes instead (Sky.ts CLEAR_SHADE). 0.5 of the full step was chosen over 0
// and 1 by eye. Off by default since (docs/art-direction.md, The look: the light keeps the sun's
// and the sky's own balance): with the clear shade it took the light's direction out of the
// meadow. `flags=tone:<t>` sets it at load for A/Bs.
const TONE = Number( debugFlags.tone ?? 0 );
// The local tone mapping (LocalTone.ts), on unless `flags=localTone:false` at load.
const LOCAL_TONE_ON = debugFlags.localTone !== false;

// The shade's contrast: under a pivot each stop of the exposed luminance (the local tone's gain in
// it) darkens by `slope` of a stop more, over it nothing changes; after the local tone, before the
// tone curve. The earlier, softer curve lifted the shade with everything else, and on our frames
// the shade lost its weight; this gives it back without touching the lit ground and the sky. The
// pivot (stops over mid grey) and slope are set per key (keyed by the sun's elevation,
// DayKeys.ts). By day the pivot sits over the lit ground, so the whole shade deepens, from noon down
// to a sun at 9 degrees; the golden hour keeps most of the slope with its pivot nearly a stop under
// mid grey, so only what lies in the long shadows drops, and the sunlit cliff stays as it is. The
// clouded sky deepens
// its darks too, from about 0.9 of a stop over mid grey; the night's slope runs to 0 as well, its
// darks set by the local tone alone (its pivot acts only while the night fades in under a clouded
// sky, beside the cloudy key's: DayKeys.ts `keyed` blends the cloud in first).
// Tunable on debug pages (debug/Tune.ts): `post.shade.<value>@golden`, `@day`, `@cloudy`, `@night`.
export const SHADE_CONTRAST: DayKeys<{ pivot: number; slope: number }> = tuneKeys( 'post.shade', {
	day: [ { at: 4, name: 'golden', values: { pivot: - 0.86, slope: 0.37 } }, { at: 9, name: 'day', values: { pivot: 1.58, slope: 0.449 } } ],
	cloudy: { pivot: 0.902, slope: 0.18 },
	night: { pivot: 0.516, slope: 0 },
}, { pivot: { min: - 3, max: 4 }, slope: { min: 0, max: 0.5 } } );

// The desaturation before the local tone's gain: each colour drawn toward its own luminance by
// `amount` (0 keeps it, 1 grey), c + ( Y( c ) - c ) amount, keyed by the sun and the weather
// (DayKeys.ts); below 0 it saturates. Keyed as the white balance is, so each key sets its own: the
// golden hour saturates by a sixth, the day keeps its colours, the clouded sky fades them by a
// twelfth, the night by about a half. The rising sun's `dawn` key, held from -1 degree down,
// fades the cool colours by 0.6 and passes into the golden key's by 1.5 (the golden key's own
// values, shared): before the sun the clear morning's land, sea and sky took the dawn's white
// (`dawn`, WHITE_BALANCE) on top of their own blue, and the upper sky and the far sea turned violet
// (h 271 to 278 from -4 to 0 degrees). A fade of every colour brought them back to h 250 to 262,
// but it took the warm colours with them: the rose band over the horizon (h 327 to 353, C 0.03 to
// 0.05 from -8 to -1 degrees) went to a grey-blue band (h 263, the white's cast), and the meadow's
// green, under it, to h 231 to 241. So the key's `cool` share of 1 fades only the colours that lie
// toward blue once the white is applied (`coolShare`: blue over red as a share of the colour's
// spread, 0 none to 0.6 all), and the warm band and the meadow keep their own colour under the same
// white: the sky's top stays at h 248 to 257, the band at h 327 to 353, the meadow at h 214 to 226
// from -7 to -4.5 degrees.
// Tunable on debug pages (debug/Tune.ts): `post.desaturate.<amount|cool>@golden`, `@dawn`, `@day`,
// `@cloudy`, `@night`; the cool share's edges `post.desaturate.coolFrom`, `post.desaturate.coolTo`.
// amount: the fade (0 keeps the colour, 1 grey, below 0 saturates); cool: the share of the fade
// that only cool colours take (`coolShare`)
type DesaturationKey = { amount: number; cool: number };
const DESATURATION_DAY: DayKey<DesaturationKey>[] = [ { at: 4, name: 'golden', values: { amount: - 0.163, cool: 0 } }, { at: 9, name: 'day', values: { amount: 0.0122, cool: 0 } } ];
export const DESATURATION: DayKeys<DesaturationKey> = tuneKeys( 'post.desaturate', {
	day: DESATURATION_DAY,
	rising: [ { at: - 1, name: 'dawn', values: { amount: 0.6, cool: 1 } }, { at: 1.5, values: DESATURATION_DAY[ 0 ].values }, ...DESATURATION_DAY ],
	cloudy: { amount: 0.08, cool: 0 },
	night: { amount: 0.481, cool: 0 },
}, { amount: { min: - 0.5, max: 1 }, cool: { min: 0, max: 1 } } );
/** Where a colour counts as cool for the desaturation's `cool` share (DESATURATION): its blue less
 * its red, as a share of its spread (max less min), from `COOL_FROM` (none of it cool) to `COOL_TO`
 * (all of it), read through the white balance (`balance`). */
const COOL_FROM = tuneUniform( 'post.desaturate.coolFrom', 0, { min: - 1, max: 1 } );
const COOL_TO = tuneUniform( 'post.desaturate.coolTo', 0.6, { min: - 1, max: 1 } );
// Overcast's highlights toward grey: the grade's tables' linear output c becomes
// c + ( Y( c ) - c ) amount smoothstep( from, to, Y( c ) ) share, `share` overcast's share in the sky
// times one less the night's weight (as its white, WHITE_OVERCAST: none at night, and nothing at all
// where the sky holds no overcast). Overcast's white, which turns the deck away from the sun
// blue-green grey and the meadow green, turned the bright sky about the sun cyan too (OKLab a -0.033
// at a lightness of 0.74, 10 to 30 degrees from it), and a warmer white turns the deck and the
// meadow back. The deck lies under `from` (a display lightness of about 0.35, the deck about 0.32)
// and keeps its colour; the meadow straddles it: its hue stays, its median chroma falls by about a
// fifth (0.083 to 0.065), and the lit grass above a lightness of 0.55 keeps under half its chroma.
// `from` and `to` are linear luminances of the tables' output (display lightness about 0.35 and
// 0.70); amount 0.58 brings the sky 10 to 30 degrees from the sun to a -0.014 and 30 to 60 degrees
// to about a -0.024 (-0.024 at a sun of 22 degrees, -0.025 at 15), and the glow within 10 degrees
// of it to a chroma under 0.01.
// Tunable on debug pages (debug/Tune.ts): `post.highlight.amount`, `from`, `to`.
const HIGHLIGHT_GREY = {
	amount: tuneUniform( 'post.highlight.amount', 0.58, { min: 0, max: 1 } ),
	from: tuneUniform( 'post.highlight.from', 0.067, { min: 0, max: 1 } ),
	to: tuneUniform( 'post.highlight.to', 0.4, { min: 0, max: 1 } ),
};
/** How cool the colour `c` (white balanced) is, 0 to 1 (`coolFrom`, `coolTo`: COOL_FROM, COOL_TO). The
 * edges come in as inputs: a laid-out helper that reads uniforms in its body can be emitted with
 * another material's uniform names (r186), which broke the rain's materials under taa. */
const coolShare = Fn( ( [ c, coolFrom, coolTo ]: [ V3, F, F ] ) => {

	const spread = max( max( c.r, c.g ), c.b ).sub( min( min( c.r, c.g ), c.b ) );
	return smoothstep( coolFrom, coolTo, c.b.sub( c.r ).div( max( spread, 1e-6 ) ) );

} ).setLayout( { name: 'coolShare', type: 'float', inputs: [ { name: 'c', type: 'vec3' }, { name: 'coolFrom', type: 'float' }, { name: 'coolTo', type: 'float' } ] } );

// The night's grade (art direction: a film's night, day for night): the meadow's greens turned
// toward blue-green, the frame a touch silver-blue, the bloom stronger so the moon, its clouds and
// its path on the sea carry a small cool halo. The turn is a rotation in the opponent plane at the
// centre of the green band (105 degrees, shading off over 55 degrees either side), weighted by
// saturation, so grey stone, sand, skin and the navy sea and sky keep their colours; it keeps the
// channels' mean, so the meadow keeps its brightness. Moonlight and the night sky are blue, but the
// meadow's yellow-green albedo kept it a dark olive under them, and a light blue enough to turn it
// turned the stone, sand and skin blue too. 0.4 radians takes the meadow to about 143 degrees, a
// cool green toward blue-green (0.65 read as teal). The tint is drawn toward at `tint` and keeps
// the luminance. The shade's readability is the sky light's (Sky.ts CLEAR_SHADE), not a lift.
// Off by default with the clear shade, as the night keeps the moon's own light (`flags=filmNight:true`
// at load for A/Bs).
const NIGHT = debugFlags.filmNight === true ? { greenTurn: 0.4, tint: [ 0.84, 0.96, 1.16 ] as const, amount: 0.3, bloom: 1.5 } : { greenTurn: 0, tint: [ 0.84, 0.96, 1.16 ] as const, amount: 0, bloom: 0 };
const nightGreenTurn = Fn( ( [ c0, turn ]: [ V3, F ] ) => {

	const c = c0.toVar();
	const ca = c.r.sub( c.g.add( c.b ).mul( 0.5 ) ).toVar();
	const cb = c.g.sub( c.b ).mul( Math.sqrt( 3 ) / 2 ).toVar();
	// (atan2 ( 0, 0 ) is undefined on some backends; a grey's hue is keyed out below anyway)
	const hue = atan( cb, select( abs( ca ).add( abs( cb ) ).greaterThan( 1e-7 ), ca, float( 1 ) ) );
	const peak = max( c.r, max( c.g, c.b ) );
	const sat = peak.sub( min( c.r, min( c.g, c.b ) ) ).div( max( peak, 1e-5 ) );
	const band = float( 1 ).sub( smoothstep( 0, 55 * Math.PI / 180, abs( mod( hue.sub( 105 * Math.PI / 180 ).add( Math.PI ), 2 * Math.PI ).sub( Math.PI ) ) ) );
	const t = band.mul( smoothstep( 0.04, 0.3, sat ) ).mul( turn ).toVar();
	const ra = ca.mul( cos( t ) ).sub( cb.mul( sin( t ) ) ).toVar();
	const rb = ca.mul( sin( t ) ).add( cb.mul( cos( t ) ) ).toVar();
	const m = c.r.add( c.g ).add( c.b ).div( 3 ).toVar();
	const k = 1 / Math.sqrt( 3 );
	return max( vec3( m.add( ra.mul( 2 / 3 ) ), m.sub( ra.div( 3 ) ).add( rb.mul( k ) ), m.sub( ra.div( 3 ) ).sub( rb.mul( k ) ) ), vec3( 0 ) );

} ).setLayout( { name: 'nightGreenTurn', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' }, { name: 'turn', type: 'float' } ] } );
const NIGHT_TINT = ( () => {

	const [ r, g, b ] = NIGHT.tint, l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return new THREE.Vector3( r / l, g / l, b / l );

} )();

/** The bloom's strength (times the time's and the weather's, and its share is the threshold's:
 * PhysicalBloom.ts BLOOM) and the vignette's strength (VIGNETTE). No grain: a dither of half a
 * code value is all the noise the frame takes. */
export const TIDEWATER_GRADE: Readonly<Pick<PipelineSettings, 'bloom' | 'vignette'>> = {
	bloom: 1.36, vignette: 1,
};
// The vignette's shape: with r the distance from the frame's centre in its own uv (round in uv,
// not in pixels), the factor mix( 1, 1 - depth smoothstep( inner, outer, r ), strength ), a radial
// smoothstep. Nothing changes out to the middle of each edge (r = 0.5); the smoothstep leaves 1
// with no slope there, so the darkening starts with no visible edge, and at strength 1 the corners
// (r = 0.71) end at about 0.73, about 0.45 stops (the falloff spans to r = 1, past the corners, so
// they sit on its steepening first half: 0.98 at r = 0.55, 0.92 at 0.6, 0.84 at 0.65).
const VIGNETTE = { inner: 0.5, outer: 1, depth: 0.73 };
/** The vignette's factor at screen uv `at` for its `strength` (VIGNETTE). */
export function vignetteFactor( at: V2, strength: F ): F {

	const fall = smoothstep( VIGNETTE.inner, VIGNETTE.outer, length( at.sub( 0.5 ) ) ).mul( VIGNETTE.depth );
	return mix( float( 1 ), fall.oneMinus(), strength );

}
// The white balance, as the colour white becomes (linear Rec.709), by the sun's elevation, under a
// clouded sky and at night (DayKeys.ts), set with the light. A clear day pushes the display past
// neutral toward cool, the sun's warmth on the lit ground held back: furthest at a sun of 9 degrees
// (red half of green, blue 1.36), which keeps the low sun's rock and meadow, and less by 40 degrees
// (red 0.59, blue 1.25, the `high` key), where the stronger cast would turn sunlit rock blue. The
// high key moves with the sky's (Sky.ts SKY_LIGHT), which takes the inverse, so the sky holds its
// colour. The golden hour warms a little further (red 1.05, blue 0.9); the clouded skies take a cool
// white too (red 0.78, blue 1.16), their grey light kept from reading warm. Overcast takes a cooler
// white of its own (red 0.49, blue 1.14, WHITE_OVERCAST): under the clouded key its slightly warm
// grey deck read as a neutral grey and the meadow under it as yellow-green (hue 120); its own key
// brings the deck to a blue-green grey (OKLab a -0.022, b -0.008) and the meadow to green (hue
// 132), the lightness all but unchanged. It comes in over the clouded day's white by overcast's share in
// the sky, before the night's, so an overcast night takes the night's white as any other.
// The night takes a cool white too (red 0.53, blue 1.2), on top of the moon's light and the rods'
// (Purkinje.ts).
// The rising sun takes a cold white where the setting sun takes the warm one (`dawn`, in place of
// the golden key while the sun climbs: DayKeys.ts `rising`; red 0.4, blue 2, a fit on our own
// views): all that the sun does not reach at dawn is blue, sky, water and rock alike, and a face turned
// to the sun takes a pale warm colour, far less orange than the same face at the same height in
// the evening. It is what moves the rose band over the horizon, which the sky's own light
// (Sky.ts SKY_LIGHT, its `dawn` key) cannot reach. The sides are one from the `day` key up.
// Tunable on debug pages (debug/Tune.ts): `post.white.<r|g|b>@golden`, `@dawn`, `@day`, `@high`,
// `@cloudy`, `@overcast`, `@night`.
const WHITE_RANGE = { r: { min: 0.2, max: 1.5 }, g: { min: 0.5, max: 1.5 }, b: { min: 0.5, max: 3 } };
const WHITE_FROM_DAY: DayKey<{ r: number; g: number; b: number }>[] = [ { at: 9, name: 'day', values: { r: 0.5, g: 1, b: 1.36 } }, { at: 40, name: 'high', values: { r: 0.593, g: 1, b: 1.248 } } ];
export const WHITE_BALANCE: DayKeys<{ r: number; g: number; b: number }> = tuneKeys( 'post.white', {
	day: [ { at: 4, name: 'golden', values: { r: 1.05, g: 1, b: 0.9 } }, ...WHITE_FROM_DAY ],
	rising: [ { at: 4, name: 'dawn', values: { r: 0.4, g: 1, b: 2.0 } }, ...WHITE_FROM_DAY ],
	cloudy: { r: 0.775, g: 1, b: 1.16 },
	night: { r: 0.527, g: 1, b: 1.2 },
}, WHITE_RANGE );
// overcast's own white (WHITE_BALANCE's header), over the clouded day's by overcast's share
const WHITE_OVERCAST = tuneObject( { r: 0.49, g: 1, b: 1.14 },
	{ r: 'post.white.r@overcast', g: 'post.white.g@overcast', b: 'post.white.b@overcast' }, WHITE_RANGE );


export class Pipeline {

	renderer: THREE.WebGPURenderer;
	width = 1;
	height = 1;
	// (the bloom's and the vignette's strengths tunable on debug pages, debug/Tune.ts:
	// `post.bloom.strength`, `post.vignette.strength`)
	settings: PipelineSettings = tuneObject( {
		exposure: DAY_EXPOSURE, exposureOffset: 0,
		// (tunable on debug pages, debug/Tune.ts: `post.tone.blackSlope`, `midGrey`, `white`)
		curve: tuneObject( { ...TONE_CURVE }, { toe: 'post.tone.blackSlope', mid: 'post.tone.midGrey', white: 'post.tone.white' },
			{ toe: { min: 1.5, max: 3 }, mid: { min: 0.12, max: 0.22 }, white: { min: 8, max: 32, scale: 'log' } } ),
		lut: 0, ...TIDEWATER_GRADE, tone: TONE, night: 0, exposureNight: 0, skyMix: [ 0, 1, 0, 0 ],
	} as PipelineSettings, { bloom: 'post.bloom.strength', vignette: 'post.vignette.strength' },
	{ bloom: { min: 0, max: 2 }, vignette: { min: 0, max: 1.5 } } );

	// The canvas's size; larger than width x height while the frame is upscaled.
	outputWidth = 1;
	outputHeight = 1;
	// RCAS sharpening after the upscale, in stops (0 the strongest, 2 none). AMD's default 0.2
	// sharpened the meadow past the native render's detail; at 0.6 the upscaled cliff matches
	// native and the meadow keeps most of it, without ringing.
	readonly sharpness = uniform( 0.6 );

	/** The frame graph: it owns the targets below and sizes them. */
	readonly graph: FrameGraph<PipelineFrame>;
	/** The graph's textures that materials outside the pipeline read: the resolved opaque colour
	 * and linear depth (the water, the spray, the rain), the nearest surface's depth, the
	 * underwater pyramid and the refraction pass's colour and depth (the water). */
	readonly textures: {
		readonly opaqueColor: THREE.Texture; readonly linearDepth: THREE.Texture; readonly surfaceDepth: THREE.Texture;
		readonly underwater: THREE.Texture; readonly refraction: THREE.Texture; readonly refractionDepth: THREE.Texture;
	};
	/** The sea's mean level (m), which the underwater pyramid keeps what lies under (main.ts sets it
	 * from the shared uniforms'). */
	readonly seaLevel = uniform( 0 );
	/** The refraction pass's camera (ocean/Refraction.ts). */
	readonly refraction = new RefractionView();
	private readonly resources: {
		sceneColor: ResourceHandle; sceneDepth: ResourceHandle; linearDepth: ResourceHandle; opaqueColor: ResourceHandle;
		meadowCoverage: ResourceHandle | null; meadowDepth: ResourceHandle | null; meadowShade: ResourceHandle | null;
		gtaoOpaque: ResourceHandle | null; gtaoOpaqueDepth: ResourceHandle | null; gtaoDepth: ResourceHandle | null; gtaoRaw: ResourceHandle | null; gtaoBlur: ResourceHandle | null; gtao: ResourceHandle | null;
		underwater: ResourceHandle; refractionReach: ResourceHandle; refraction: ResourceHandle; refractionDepth: ResourceHandle;
		surfaceDepth: ResourceHandle; velocity: ResourceHandle | null; meterLight: ResourceHandle; exposureState: ResourceHandle; exposureStatePrev: ResourceHandle; surfaceDepthPrev: ResourceHandle | null; veilReactive: ResourceHandle | null;
		rainAir: ResourceHandle | null; rainOverlay: ResourceHandle | null; rainLayer: ResourceHandle | null; rainInput: ResourceHandle | null; rainBehind: ResourceHandle | null; rainGrade: ResourceHandle | null;
		hdr: ResourceHandle | null; sharp: ResourceHandle; display: ResourceHandle;
		easu: ResourceHandle | null; canvas: ResourceHandle;
	};
	readonly air: VolumetricHaze;
	readonly shafts = new LightShafts();
	readonly options: Readonly<PostOptions>;
	/** The temporal modes' resolve (null under msaa and off, and with `taaResolve=off`). */
	readonly temporal: TemporalAA | null = null;
	/** FSR 3 under fsr3 (Fsr3Upscaler.ts), else null. */
	readonly fsr3: Fsr3Upscaler | null = null;
	/** Whether the paused page will draw the same frame from now on (Settled.ts). */
	readonly settled = new Settled();

	private depthQuad: THREE.QuadMesh;
	// (msaa and off: under the temporal modes the opaque copy is a texture copy)
	private copyQuad: THREE.QuadMesh | null = null;
	private underwaterQuad: THREE.QuadMesh;
	private refractionReachQuad: THREE.QuadMesh;
	private refractionMaskQuad: THREE.QuadMesh;
	private surfaceQuad: THREE.QuadMesh;
	// the meadow's shade: the depth's nearest view z and the march (MeadowShade.ts)
	private meadowDepthQuad: THREE.QuadMesh | null = null;
	private meadowShadeQuad: THREE.QuadMesh | null = null;
	// the ambient occlusion: the half-resolution view z, the slices and the blur (GTAO.ts)
	private gtaoQuads: { depth: THREE.QuadMesh; slices: THREE.QuadMesh; blurX: THREE.QuadMesh; blurY: THREE.QuadMesh } | null = null;
	// (msaa, off and the temporal modes with `taaResolve=off`: the resolve has a canvas pass of its own)
	private output: THREE.RenderPipeline | null = null;
	// FSR.ts's sharpening canvas pass after EASU (the fsrPort option), or three's FSR1Node (post=three-fsr)
	private upscaledOutput: THREE.RenderPipeline | null = null;
	private upscaledOutputThree: THREE.RenderPipeline | null = null;
	private fsr: FSR | null = null;
	// the composite of the haze, the rain veil and the shafts over the scene, into hdr (the
	// compositeOnce option)
	private compositeQuad: THREE.QuadMesh | null = null;
	// the post passes' per-frame constants, into a texel (`postConstants`)
	private constants = {} as { quad: THREE.QuadMesh; output: ResourceHandle };
	// the sky's per-frame constants (the discs' cloud transmittance), into a texel before the scene
	// (`skyConstants`)
	private skyConstants = {} as { quad: THREE.QuadMesh; output: ResourceHandle };
	// after the resolve, the rain's layer over the graded image (AfterResolve.ts), and the rain
	private layerQuad: THREE.QuadMesh | null = null;
	private rainInputQuad: THREE.QuadMesh | null = null;
	private rainGradeQuad: THREE.QuadMesh | null = null;
	private readonly rain: Rain | undefined;
	// the composite and the bloom (the sharp image)
	private sharpQuad: THREE.QuadMesh;
	// the graded image at the render's size, before the copy or upscale to the canvas
	private displayQuad: THREE.QuadMesh;
	// tidewater's physical bloom (PhysicalBloom.ts)
	private bloom!: PhysicalBloom;
	private readonly exposureKeys: ExposureKey = { key: 0, highlight: 0, sky: 0, adaptUp: 0.05, adaptDown: 0.05 };
	// the adaptation: reset at the next frame (a cut), the scene clock at the last frame
	private exposureReset = true;
	private exposureTime: number | null = null;
	/** Debug builds: the exposure has not yet reached its target (more than 0.01 stop off, as last
	 * read back), which keeps the page's settled signal false (main.ts `pending`). */
	exposurePending = false;
	// a readback of the exposure state is in flight (one at a time)
	private exposureReading = false;
	// what the frame draws from, for the pre-exposure's readings (PreExposure.ts `viewFrame`)
	private readonly viewKey: number[] = [];
	/** The metering histograms and the meter (Metering.ts); without the composite pass
	 * (`post=inline-composite`) no histogram is taken and the meter reads none. */
	metering!: Metering;
	// the local tone mapping (LocalTone.ts; null with `flags=localTone:false`)
	readonly localTone: LocalTone | null = null;
	/** The grade's two tables' base nodes (GradeLut.ts): a table of LUT_SIZE^3 set as a node's
	 * `value` replaces it; `settings.lut` blends from the first to the second. */
	readonly luts = lutNodes();
	/** The first table's grade (GradeLut.ts): `setGrade` changes it and fills the table anew. */
	readonly grade: GradeParams = gradeOf( {}, BASE_GRADE );
	// the shade's contrast this frame (SHADE_CONTRAST)
	private readonly shade = { pivot: 0, slope: 0 };
	private readonly desaturation = { amount: 0, cool: 0 };
	private readonly white = { r: 1, g: 1, b: 1 };
	// the white the tone curve's input matrix was last built for
	private toneWhite = [ NaN, NaN, NaN ];
	// the tone curve whose coefficients were last solved (ToneCurve.ts)
	private toneCurveKey = '';
	private u = {
		// tidewater's grade
		bloom: uniform( TIDEWATER_GRADE.bloom ), tone: uniform( 0 ), night: uniform( 0 ),
		vignette: uniform( 1 ),
		// the shade's contrast (SHADE_CONTRAST): its pivot as an exposed luminance, and its slope
		shadePivot: uniform( 0.8 ), shadeSlope: uniform( 0 ),
		// the desaturation before the local gain (DESATURATION)
		desaturate: uniform( 0 ), desaturateCool: uniform( 0 ),
		// overcast's highlights toward grey (HIGHLIGHT_GREY): overcast's share by day
		highlightShare: uniform( 0 ),
		// the white balance alone (WHITE_BALANCE), through which the desaturation's cool share reads
		// its colours
		balance: uniform( new THREE.Matrix3() ),
		// the Purkinje shift's weight: the night's times its strength, and the key's share of the
		// light its retinal scale is taken from (Purkinje.ts `purkinjeScale`)
		purkinje: uniform( 0 ), purkinjeKey: uniform( 0 ),
		// the tone curve's input matrix (the white balance in it) and output matrix
		toneIn: uniform( new THREE.Matrix3() ), toneOut: uniform( TONE_SPACE.output ),
		// the tone curve's numerator's a, b, c and its denominator's d, e, f (ToneCurve.ts)
		toneNum: uniform( new THREE.Vector3() ), toneDen: uniform( new THREE.Vector3() ),
		// the blend toward the grade's second table
		lut: uniform( 0 ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ), cameraWorld: uniform( new THREE.Matrix4() ),
		proj: uniform( new THREE.Matrix4() ), view: uniform( new THREE.Matrix4() ),
		// the key light's direction in the scene camera's view space (the meadow's shade)
		keyView: uniform( new THREE.Vector3( 0, 1, 0 ) ),
		// 1 where the display pass adds the dither (drawn at the canvas's size, not upscaled after)
		ditherOn: uniform( 1 ),
		// 1 while the after pass draws (AfterResolve.ts): else its overlay holds an earlier frame's;
		// and while the rain's layer pass runs
		afterOn: uniform( 0 ), layerOn: uniform( 0 ),
	};


	/** `temporal`: the tier's resolve settings (Quality.ts `taa`), for the temporal modes. */
	constructor( renderer: THREE.WebGPURenderer, private readonly sky: Sky, sunShadow: SunShadow, rain?: Rain, options: Partial<PostOptions> = postOptionsFromURL(), temporal?: TemporalSettings ) {

		this.renderer = renderer;
		this.rain = rain;
		// (a tone curve the solve cannot meet keeps the last good one and reports it, debug/Tune.ts)
		const curve = this.settings.curve;
		tuneCheck( [ 'post.tone.blackSlope', 'post.tone.midGrey', 'post.tone.white' ], () => checkToneCurve( solveToneCurve( curve ), curve.white ) );
		fillGradeLut( this.grade, SHOWN_GREY, this.luts[ 0 ].value as THREE.Data3DTexture );
		this.options = { ...DEFAULT_POST_OPTIONS, ...options };
		this.settled.settle = ( temporal ?? QUALITY.high.taa ).restSettle;
		const O = this.options;
		this.air = new VolumetricHaze( sunShadow, sky.atmosphere, O.hazeGrid, sky.sunBeamIlluminance, sky.moonBeamIlluminance );
		// the clouds' march ends where this haze closes (Clouds.ts `makeMarch`): it reads the medium
		// from uniforms of its own, built before the haze, which the haze writes with its own
		this.air.cloudMedium = sky.clouds.haze;
		// the island's cover hides the haze from the open sky: the rain's collision map (its top,
		// drawn at load and on every Grow, in every weather), times the ambient probes' sky
		// visibility, which exists only once main.ts installs the volume with the world, so the
		// shadow kernels that read it compile then (`compileHazeShadow`), not in the warm-up
		if ( rain ) {

			const collision = rain.collision;
			this.air.setCover( { topAt: collision.topAt, seaLevel: collision.waterLevel, get version() { return collision.version; }, skyVisibility: ambientSkyVisibility, late: true } );

		}
		// the sky fogs itself (the composite leaves its pixels), its own ray with the dome's thin haze,
		sky.fogDome( ( d, distance ) => this.air.skyHaze( d, distance, undefined, true ) );
		// and its panoramas from the sea's level: the seen one and the probe's as the dome takes the
		// haze, the land's light without the fog layer (Sky.ts `fogEnvironment`)
		sky.fogEnvironment( ( d, distance ) => this.air.openSky( d, 0, sky, distance ), ( d, distance ) => this.air.openSky( d, 0, sky, distance, false ) );
		// The scene's target: half-float colour and float depth at the scene's sample count, then
		// the resolves the water and the post passes read (single-sampled).
		const g = this.graph = new FrameGraph<PipelineFrame>( renderer, { sceneSamples: SCENE_SAMPLES, legacyDiscard: O.discardScene ? [ 'rain' ] : [], dev: DEV, prime: PRIME } );
		const sceneColor = g.color( 'sceneColor', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, samples: 'scene' } );
		const sceneDepth = g.depth( 'sceneDepth', { size: RENDER, samples: 'scene', type: THREE.FloatType } );
		const linearDepth = g.color( 'linearDepth', { size: RENDER, format: THREE.RGFormat, type: THREE.FloatType } );
		const opaqueColor = g.color( 'opaqueColor', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		const surfaceDepth = g.color( 'surfaceDepth', { size: RENDER, format: THREE.RedFormat, type: THREE.FloatType } );
		// what the water refracts at its footprint: the opaque colour under the sea and its mips
		const underwater = g.color( 'underwater', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, mips: true } );
		// (read along the footprint's long axis: a surface seen at a slant stretches it)
		g.texture( underwater ).anisotropy = 8;
		// how far past each edge of the screen the water's refracted lookups reach (Pipeline's
		// refraction mask): r below the screen per column, g left and b right of it per row
		const refractionReach = g.color( 'refractionReach', { size: { of: 'fixed', width: REACH, height: 1 }, format: THREE.RGBAFormat, type: THREE.HalfFloatType, filter: 'nearest' } );
		// the water's refraction source: the world under the sea, lit, and its depth (single-sampled)
		const refraction = g.color( 'refraction', { size: REFRACTION_SIZE, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		const refractionDepth = g.depth( 'refractionDepth', { size: REFRACTION_SIZE, type: THREE.FloatType } );
		// The temporal modes' motion vectors (rg: the NDC motion since the previous frame, b: the
		// surface's class, a: its reactive weight; Motion.ts), and the nearest surface's depth of the
		// frame before, for the resolve's disocclusion test (a copy at the frame's end).
		// (in the scene's target: its sample count, one under the temporal modes)
		const velocity = TEMPORAL ? g.color( 'velocity', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, samples: 'scene' } ) : null;
		// The metering illuminance M (the header's rules), the scene target's last attachment; at 4x
		// its texture is the target's multisample resolve, the average of the samples.
		const meterLight = g.color( METER_LIGHT, { size: RENDER, format: THREE.RedFormat, type: THREE.HalfFloatType, samples: 'scene' } );
		// The exposure state ( EV, its velocity, EV_t, moved: Exposure.ts ), one texel the meter writes,
		// and the previous frame's, copied at the frame's end
		const exposureState = g.color( 'exposureState', { size: EXPOSURE_TEXEL, format: THREE.RGBAFormat, type: THREE.FloatType } );
		const exposureStatePrev = g.color( 'exposureStatePrev', { size: EXPOSURE_TEXEL, format: THREE.RGBAFormat, type: THREE.FloatType }, true );
		const surfaceDepthPrev = TEMPORAL && ! FSR3 ? g.color( 'surfaceDepthPrev', { size: RENDER, format: THREE.RedFormat, type: THREE.FloatType }, true ) : null;
		// the rain veil's reactive weight per pixel, for the resolve, written by the composite
		// (persistent: zero until it is written, so the resolve's binding never changes)
		const veilReactive = ( RESOLVE || FSR3 ) && ! AFTER_RESOLVE ? g.color( 'veilReactive', { size: RENDER, format: THREE.RedFormat, type: THREE.HalfFloatType }, true ) : null;
		// After the resolve (AfterResolve.ts): the air's transmittance at each pixel, which the
		// composite writes in place of veilReactive (the same cost: rainy or fair, nothing more), for the
		// streaks drawn later; and the streaks and spray themselves, drawn at the canvas's size
		// (premultiplied scene radiance, coverage).
		const rainAir = AFTER_RESOLVE && O.compositeOnce ? g.color( 'rainAir', { size: RENDER, format: THREE.RedFormat, type: THREE.HalfFloatType } ) : null;
		const rainOverlay = AFTER_RESOLVE ? g.color( RAIN_OVERLAY, { size: CANVAS, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		// (and the change all the rain makes to the graded image, which the canvas pass adds, and what
		// it reads at a render texel: the grade's input and the air's transmittance, and the light the
		// air adds)
		const rainLayer = AFTER_RESOLVE ? g.color( 'rainLayer', { size: CANVAS, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		const rainInput = AFTER_RESOLVE ? g.color( 'rainInput', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		const rainBehind = rainInput && rainAir ? g.color( 'rainBehind', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		// (the grade as a table, for the canvas pass that draws the layer)
		const rainGrade = AFTER_RESOLVE ? g.color( 'rainGrade', { size: { of: 'fixed', width: GRADE_TABLE.size ** 2, height: GRADE_TABLE.size }, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		// the composite and the sharp image (half float, as three's rtt() made them)
		const hdr = O.compositeOnce ? g.color( 'hdr', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		// (under fsr3 the sharp image and the display pass run on FSR's output, at the canvas's size)
		const sharp = g.color( 'sharp', { size: FSR3 ? CANVAS : RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		// (linear light under the temporal resolve: no per-tap decode in the resolve, half the bytes)
		const LINEAR_DISPLAY = RESOLVE && ( temporal ?? QUALITY.high.taa ).linear;
		// (under fsr3 at the canvas's size in half float: display values, which the copy to the canvas
		// rounds to 8 bits; a float target there would take twice the memory)
		const display = g.color( 'display', { size: FSR3 ? CANVAS : RENDER, format: THREE.RGBAFormat, type: LINEAR_DISPLAY || FSR3 ? THREE.HalfFloatType : THREE.FloatType } );
		// the upscale's EASU image (the canvas's size) and the canvas (the resolve has its own)
		const easu = O.fsrPort && ! RESOLVE && ! FSR3 ? g.color( 'FSR.easu', { size: { of: 'canvas' }, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		const canvas = g.import( 'canvas', null, { of: 'canvas' } );
		// The meadow's shade (MeadowShade.ts): the colour the vegetation's depth pass draws beside the
		// scene's depth (three's targets carry one; never read: with an alpha channel, which alpha to
		// coverage needs), the depth's nearest view z and the shade.
		const meadowCoverage = MEADOW_SHADE ? g.color( 'meadowCoverage', { size: RENDER, format: THREE.RGBAFormat, type: THREE.UnsignedByteType, samples: 'scene' } ) : null;
		const meadowDepth = MEADOW_SHADE ? g.color( 'meadowDepth', { size: RENDER, format: SS_SHADOW ? THREE.RGFormat : THREE.RedFormat, type: THREE.FloatType } ) : null;
		// (over the whole scene the depth's nearest view z and its surface's thickness, and the shade
		// with both beside it, which the ground marches over: MeadowShade.ts)
		const meadowShadeMap = MEADOW_SHADE ? g.color( 'meadowShade', SS_SHADOW ? { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, filter: 'nearest' } : { size: RENDER, format: THREE.RedFormat, type: THREE.UnsignedByteType, filter: 'nearest' } ) : null;
		// The ambient occlusion (GTAO.ts): at half the render's size, the opaque copies' distance (and
		// over the whole scene their surfaces' thickness, world/OpaquePrepass.ts) and
		// their depth (world/OpaquePrepass.ts; the meadow's shade reads them too over the whole scene,
		// MeadowShade.ts `SS_SHADOW`), the view z, the slices' and the blur's ( occlusion, view z )
		const half: SizeClass = { of: 'render', divisor: 2 };
		const OPAQUE_PREPASS = GTAO || SS_SHADOW;
		const gtaoOpaque = OPAQUE_PREPASS ? g.color( 'gtaoOpaque', { size: half, format: SS_SHADOW ? THREE.RGFormat : THREE.RedFormat, type: THREE.FloatType, filter: 'nearest' } ) : null;
		const gtaoOpaqueDepth = OPAQUE_PREPASS ? g.depth( 'gtaoOpaqueDepth', { size: half, type: THREE.FloatType } ) : null;
		const gtaoDepth = GTAO ? g.color( 'gtaoDepth', { size: half, format: THREE.RedFormat, type: THREE.FloatType, filter: 'nearest' } ) : null;
		const gtaoRaw = GTAO ? g.color( 'gtaoRaw', { size: half, format: THREE.RGFormat, type: THREE.HalfFloatType, filter: 'nearest' } ) : null;
		const gtaoBlur = GTAO ? g.color( 'gtaoBlur', { size: half, format: THREE.RGFormat, type: THREE.HalfFloatType, filter: 'nearest' } ) : null;
		const gtao = GTAO ? g.color( 'gtao', { size: half, format: THREE.RGFormat, type: THREE.HalfFloatType, filter: 'nearest' } ) : null;
		this.resources = { meadowCoverage, meadowDepth, meadowShade: meadowShadeMap, gtaoOpaque, gtaoOpaqueDepth, gtaoDepth, gtaoRaw, gtaoBlur, gtao, sceneColor, sceneDepth, linearDepth, opaqueColor, underwater, refractionReach, refraction, refractionDepth, surfaceDepth, velocity, meterLight, exposureState, exposureStatePrev, surfaceDepthPrev, veilReactive, rainAir, rainOverlay, rainLayer, rainInput, rainBehind, rainGrade, hdr, sharp, display, easu, canvas };
		// the targets the frame draws into, made now (the probes, the warm-ups and the water's
		// textures need them before the first frame)
		g.renderTarget( velocity ? [ sceneColor, velocity, meterLight ] : [ sceneColor, meterLight ], sceneDepth );
		for ( const h of [ linearDepth, opaqueColor, underwater, refractionReach, display ] ) g.renderTarget( [ h ] );
		g.renderTarget( [ refraction ], refractionDepth );
		g.renderTarget( [ surfaceDepth ] );
		if ( meadowCoverage && meadowDepth && meadowShadeMap ) {

			g.renderTarget( [ meadowCoverage ], sceneDepth );
			g.renderTarget( [ meadowDepth ] );
			g.renderTarget( [ meadowShadeMap ] );
			meadowShade.value = g.texture( meadowShadeMap );
			meadowDepthMap.value = g.texture( meadowDepth );

		}
		if ( gtaoOpaque && gtaoOpaqueDepth ) g.renderTarget( [ gtaoOpaque ], gtaoOpaqueDepth );
		if ( gtaoDepth && gtaoRaw && gtaoBlur && gtao ) {

			for ( const h of [ gtaoDepth, gtaoRaw, gtaoBlur, gtao ] ) g.renderTarget( [ h ] );
			gtaoMap.value = g.texture( gtao );

		}
		this.textures = {
			opaqueColor: g.texture( opaqueColor ), linearDepth: g.texture( linearDepth ), surfaceDepth: g.texture( surfaceDepth ),
			underwater: g.texture( underwater ), refraction: g.texture( refraction ), refractionDepth: g.texture( refractionDepth ),
		};
		// the sizes the passes read, the graph's shared extent uniforms (set with the targets' own
		// sizes): the render's and the canvas's
		const renderSize = g.extent( RENDER ), canvasSize = g.extent( CANVAS );
		const u = this.u;
		// the frame's exposure of what hdr holds: 2^EV from the exposure state the meter writes
		// (Metering.ts) over the pre-exposure 2^P hdr already carries (PreExposure.ts), read by every
		// pass after the meter (a new read at each call: FSR 3's accessors take it so, Bindings.ts)
		// (the state's x: its EV, Exposure.ts)
		const exposureRead = () => exp2( ( textureLoad( texture( g.texture( exposureState ) ), ivec2( 0 ) ) as unknown as V4 ).x ).mul( preExposure.inverse );
		const exposure = exposureRead();
		// Multisampled depth can only be loaded, a sample at a time. The sky stays far away (-1e5).
		const viewZ = ( coord: V2, d: F ) => {

			const z = float( - 1e5 ).toVar();
			If( d.lessThan( 0.999999 ), () => {

				const q = coord.div( renderSize );
				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
				z.assign( v.z.div( v.w ) );

			} );
			return z;

		};
		const msDepth = texture( g.texture( sceneDepth ) );
		const depthSample = ( coord: V2, i: number ) => textureLoad( msDepth, ivec2( coord ), int( i ) ) as unknown as F;
		// Sample 0 for what reads the depth at a point (the water's traces, rain, spray and the haze),
		// and the farthest of the samples for the water's view of what lies behind it.
		// The water is shaded once per pixel, but drawn only into the samples it is in front of: at an
		// edge pixel where a cliff, a figure or a leaf covers sample 0, the samples the water does
		// cover hold what is behind it, the farthest one.
		const resolveMat = new THREE.NodeMaterial();
		resolveMat.fragmentNode = Fn( () => {

			const coord = screenCoordinate.xy;
			const d0 = depthSample( coord, 0 ).toVar();
			// Single-sampled, the depth texture has no samples to load past 0 (the third argument
			// would read a mip level instead).
			const far = SCENE_SAMPLES === 4 ? max( max( d0, depthSample( coord, 1 ) ), max( depthSample( coord, 2 ), depthSample( coord, 3 ) ) ) : d0;
			return vec4( viewZ( coord, d0 ), viewZ( coord, far ), 0, 0 );

		} )();
		this.depthQuad = new THREE.QuadMesh( resolveMat );
		if ( meadowDepth ) {

			// (over the whole scene with the opaque copies' distance, MeadowShade.ts `SS_SHADOW`)
			const opaque = SS_SHADOW && gtaoOpaque ? { map: g.texture( gtaoOpaque ), halfSize: g.extent( half ) } : undefined;
			this.meadowDepthQuad = new THREE.QuadMesh( meadowDepthMaterial( g.texture( sceneDepth ), renderSize, u.projInv, opaque ) );
			this.meadowShadeQuad = new THREE.QuadMesh( meadowShadeMaterial( g.texture( meadowDepth ), renderSize, u.proj, u.projInv, u.keyView ) );
			// the ground's march (TerrainMaterial.ts) reads the same values
			meadowGroundView.size.value = renderSize.value;
			meadowGroundView.proj.value = u.proj.value;
			meadowGroundView.key.value = u.keyView.value;

		}
		if ( gtaoOpaque && gtaoDepth && gtaoRaw && gtaoBlur ) {

			// (the passes and the receivers read the graph's own extents)
			gtaoView.size.value = g.extent( half ).value;
			gtaoView.render.value = renderSize.value;
			this.gtaoQuads = {
				depth: new THREE.QuadMesh( gtaoDepthMaterial( g.texture( sceneDepth ), g.texture( gtaoOpaque ), u.projInv ) ),
				slices: new THREE.QuadMesh( gtaoMaterial( g.texture( gtaoDepth ) ) ),
				blurX: new THREE.QuadMesh( gtaoBlurMaterial( g.texture( gtaoRaw ), g.texture( gtaoDepth ), 1, 0 ) ),
				blurY: new THREE.QuadMesh( gtaoBlurMaterial( g.texture( gtaoBlur ), g.texture( gtaoDepth ), 0, 1 ) ),
			};

		}
		if ( ! TEMPORAL ) {

			const copyMat = new THREE.NodeMaterial();
			copyMat.fragmentNode = textureLoad( texture( g.texture( sceneColor ) ), ivec2( screenCoordinate.xy ) );
			this.copyQuad = new THREE.QuadMesh( copyMat );

		}
		// The underwater pyramid's top level: the opaque colour where every sample of the pixel lies
		// below the refraction's clip height (the floor, the stones, the cliffs' feet: what a ray
		// through the sea can reach, as the refraction image holds it), premultiplied by that weight
		// (alpha), and nothing where one lies above it (a cliff, the rim's grass, a figure) or is
		// sky. Its mips, each a box filter of the level above, are then the average colour of what
		// lies under the sea over any footprint, the surfaces above it left out: the water divides
		// by the alpha. What swims in the water (marked by Refraction.ts `markSwimmer`: an alpha of 0)
		// is left out too, as are the pixels it shares: the water finds it along its refracted ray
		// in the opaque image (Water.ts), and the floor behind it comes from the refraction image,
		// which never draws it.
		const underwaterMat = new THREE.NodeMaterial();
		underwaterMat.fragmentNode = Fn( () => {

			const coord = screenCoordinate.xy;
			const q = coord.div( renderSize );
			const clip = this.seaLevel.add( CLIP_MARGIN );
			const below = ( d: F ) => {

				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
				const y = u.cameraWorld.mul( vec4( v.xyz.div( v.w ), 1 ) ).y;
				return step( y, clip ).mul( step( d, 0.999999 ) );

			};
			let w = below( depthSample( coord, 0 ) );
			for ( let i = 1; i < SCENE_SAMPLES; i ++ ) w = w.mul( below( depthSample( coord, i ) ) );
			const color = ( textureLoad( texture( g.texture( sceneColor ) ), ivec2( coord ) ) as unknown as V4 ).toVar();
			const weight = w.mul( step( 0.999, color.a ) ).toVar();
			return vec4( color.rgb.mul( weight ), weight );

		} )();
		this.underwaterQuad = new THREE.QuadMesh( underwaterMat );
		// How far past each edge of the screen the water's refracted lookups reach. Light bends down
		// into the water, so a refracted ray lands on floor lower on the screen than the pixel it is
		// seen through: from the island camera's height about a fiftieth of the sea's pixels look
		// past the screen's edge, a few per cent of its height at most, but seen low over the sea a
		// quarter to half of them land under the near water, below the edge, as far as the guard
		// band reaches and beyond. Each texel follows REACH_SAMPLES pixels toward one edge (denser
		// near it) along its column (below) or row (left, right): the camera's ray to the sea,
		// refracted, down to the floor the opaque pixel shows straight behind (where that pixel drew
		// what lies under the sea), its end projected; the farthest past the edge. The flat sea and
		// its ends below the screen alone missed a few in a thousand of the lookups past the edge
		// low over a strong wind's sea; with the tilts none in ten thousand.
		const tUnderwater = texture( g.texture( underwater ) );
		const reachMat = new THREE.NodeMaterial();
		reachMat.name = 'refractionReach';
		reachMat.fragmentNode = Fn( () => {

			const eye = u.cameraWorld.mul( vec4( 0, 0, 0, 1 ) ).xyz.toVar();
			const sea = this.seaLevel;
			// How far past the edges the refracted rays seen through screen uv q end: ( below, left,
			// right, the sideways spill of an end below ), or 0 where q shows no floor under the sea.
			// The sea's slopes tilt the rays, sideways most of all, which the flat sea leaves out
			// (low over a gale's sea a tenth of the screen and more): the surface tilted by
			// REACH_SLOPE across the view and along it as well.
			const reachAt = ( q: V2 ) => {

				const texel = ivec2( clamp( q.mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
				const d = depthSample( vec2( texel ), 0 );
				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y.mul( 2 ) ), d, 1 ) ).toVar();
				const floor = u.cameraWorld.mul( vec4( v.xyz.div( v.w ), 1 ) ).xyz.toVar();
				const dir = normalize( floor.sub( eye ) ).toVar();
				const out = vec4( 0 ).toVar();
				If( textureLoad( tUnderwater, texel, int( 0 ) ).a.greaterThan( 0.999 ).and( floor.y.lessThan( sea ) ).and( dir.y.lessThan( - 1e-3 ) ).and( eye.y.greaterThan( sea ) ), () => {

					const surface = eye.add( dir.mul( eye.y.sub( sea ).div( dir.y.negate() ) ) ).toVar();
					const along = normalize( vec3( dir.x, 0, dir.z ).add( vec3( 1e-5, 0, 0 ) ) ).toVar();
					const across = vec3( along.z.negate(), 0, along.x ).toVar();
					for ( const tilt of [ [ 0, 0 ], [ 1, 0 ], [ - 1, 0 ], [ 0, 1 ], [ 0, - 1 ] ] ) {

						const n = normalize( vec3( 0, 1, 0 ).add( across.mul( tilt[ 0 ] * REACH_SLOPE ) ).add( along.mul( tilt[ 1 ] * REACH_SLOPE ) ) );
						const t = refract( dir, n, 1 / 1.333 );
						// (as the water keeps a ray heading down and bounds its path: Water.ts)
						const down = normalize( vec3( t.x, min( t.y, - 0.08 ), t.z ) ).toVar();
						const end = surface.add( down.mul( min( sea.sub( floor.y ).div( max( down.y.negate(), 0.04 ) ), 80 ) ) );
						const c = u.proj.mul( u.view.mul( vec4( end, 1 ) ) ).toVar();
						const e = vec2( c.x.div( c.w ).mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( c.y.div( c.w ).mul( 0.5 ) ) ).toVar();
						const sideways = max( e.x.negate(), e.x.sub( 1 ) );
						out.assign( max( out, vec4( e.y.sub( 1 ), e.x.negate(), e.x.sub( 1 ), select( e.y.greaterThan( 1 ), sideways, float( 0 ) ) ) ) );

					}

				} );
				return out;

			};
			const at = screenCoordinate.x.div( REACH );
			// (a: how far the ends below the screen spill past its sides, for the corners)
			const below = float( 0 ).toVar(), left = float( 0 ).toVar(), right = float( 0 ).toVar(), spill = float( 0 ).toVar();
			Loop( REACH_SAMPLES, ( { i } ) => {

				// from the middle of the screen to its edge, the steps shrinking toward the edge
				const f = float( 1 ).sub( float( i ).add( 0.5 ).div( REACH_SAMPLES ) );
				const inset = f.mul( f ).mul( 0.5 );
				const b = reachAt( vec2( at, float( 1 ).sub( inset ) ) ).toVar();
				below.assign( max( below, b.x ) );
				spill.assign( max( spill, b.w ) );
				left.assign( max( left, reachAt( vec2( inset, at ) ).y ) );
				right.assign( max( right, reachAt( vec2( float( 1 ).sub( inset ), at ) ).z ) );

			} );
			return vec4( below, left, right, spill );

		} )();
		this.refractionReachQuad = new THREE.QuadMesh( reachMat );
		// The refraction mask: the full-screen triangle lies at the nearest depth, so where it is drawn
		// the refraction pass's fragments fail the depth test before they are shaded. On the screen
		// it is drawn where the opaque image already holds what lies under the sea, from which the
		// water then reads (Water.ts): every opaque pixel within some eight of the refraction texel's
		// place on the screen under the sea (the pyramid's weight of 1 at level 3, read bilinearly: a
		// block of about 16 pixels), so the refraction image is kept for the water's filtered reads
		// beside what stands above the water, and behind it (the four texels a bilinear read there
		// takes: a lone pixel above the water at a small weight let a lookup meet a masked texel). In
		// the guard band off the screen it is drawn beyond the lookups' reach past that edge
		// (refractionReach, the largest of the columns or rows around; below a corner, the sideways
		// spill of the ends below the screen as well), grown by REACH_MARGIN for the floor's slopes
		// and the waves' beyond the reach's tilt.
		const G = REFRACTION_GUARD;
		const refractionSize = g.extent( REFRACTION_SIZE );
		const tReach = texture( g.texture( refractionReach ) );
		const maskMat = new THREE.NodeMaterial();
		maskMat.name = 'refractionMask';
		maskMat.colorWrite = false;
		maskMat.fragmentNode = Fn( () => {

			const r = screenCoordinate.xy.div( refractionSize );
			const sx = r.x.mul( 2 ).sub( 1 ).mul( G.sx ).add( G.cx ), sy = float( 1 ).sub( r.y.mul( 2 ) ).mul( G.sy ).add( G.cy );
			const q = vec2( sx.mul( 0.5 ).add( 0.5 ), float( 0.5 ).sub( sy.mul( 0.5 ) ) ).toVar();
			const inside = q.x.greaterThan( 0 ).and( q.x.lessThan( 1 ) ).and( q.y.greaterThan( 0 ) ).and( q.y.lessThan( 1 ) );
			// the reach past an edge around texel index k (a column for below, a row for the sides)
			const reach = ( k: F ) => {

				let m: V4 = vec4( 0 );
				for ( let o = - 2; o <= 2; o ++ ) m = max( m, textureLoad( tReach, ivec2( int( clamp( k.add( o ), 0, REACH - 1 ) ), int( 0 ) ), int( 0 ) ) as unknown as V4 );
				return m.mul( REACH_MARGIN.scale ).add( REACH_MARGIN.add );

			};
			const column = reach( floor( clamp( q.x, 0, 0.9999 ).mul( REACH ) ) ), row = reach( floor( clamp( q.y, 0, 0.9999 ).mul( REACH ) ) );
			// (below a corner, the ends that left the screen through its bottom edge spill sideways)
			const side = select( q.y.greaterThan( 1 ), column.w, float( 0 ) );
			const within = q.y.sub( 1 ).lessThanEqual( column.x ).and( q.x.negate().lessThanEqual( max( row.y, side ) ) ).and( q.x.sub( 1 ).lessThanEqual( max( row.z, side ) ) );
			// (the four level-3 texels around q, each 8 pixels square, all under the sea)
			const level3 = renderSize.div( 8 ).floor().max( 1 );
			const corner = ivec2( q.mul( level3 ).sub( 0.5 ).floor() );
			let all: F = float( 1 );
			for ( const [ dx, dy ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

				const texel = ivec2( clamp( vec2( corner ).add( vec2( dx, dy ) ), vec2( 0 ), level3.sub( 1 ) ) );
				all = min( all, ( textureLoad( tUnderwater, texel, int( 3 ) ) as unknown as V4 ).a );

			}
			Discard( select( inside, all.lessThan( 0.999 ), within ) );
			return vec4( 0 );

		} )();
		this.refractionMaskQuad = new THREE.QuadMesh( maskMat );
		// The nearest surface's view z: sample 0's, but the nearest sample's where sample 0 sees the sky
		// and another sample a surface, so a pixel is sky only where all its samples are. Such an edge
		// pixel's colour holds the surface's samples unhazed (the haze composite fogs everything but
		// the sky, which fogs itself): the composite fogs it at the surface's distance, and the sky's
		// share then takes the air it already has once more, which leaves the hazy sky at the horizon
		// nearly as it was. Read by sample 0 alone, the sea's far edge (MSAA's sample 0 lies near the
		// pixel's top, in the sky) stayed unhazed along the horizon's row, a dark line.
		const surfaceMat = new THREE.NodeMaterial();
		surfaceMat.fragmentNode = Fn( () => {

			const coord = screenCoordinate.xy;
			const d0 = depthSample( coord, 0 ).toVar();
			if ( SCENE_SAMPLES !== 4 ) return vec4( viewZ( coord, d0 ) );
			const near = min( min( d0, depthSample( coord, 1 ) ), min( depthSample( coord, 2 ), depthSample( coord, 3 ) ) ).toVar();
			return vec4( viewZ( coord, select( d0.lessThan( 0.999999 ), d0, near ) ) );

		} )();
		this.surfaceQuad = new THREE.QuadMesh( surfaceMat );

		// ---- composite: the scene target holds the opaque image with the sea and the rain drawn over it
		const sceneTex = texture( g.texture( sceneColor ) );
		const tSurfaceDepth = this.textures.surfaceDepth;
		// (the air's alpha: the rain veil's opacity, for the resolve's veilReactive; after the resolve,
		// where the veil is drawn, the air's transmittance)
		const veil = rain && ! AFTER_RESOLVE ? ( d: V3, distance: F, background: V3 ) => rain.veil( d, distance, background ) : undefined;
		// What the post passes take that is the same for every pixel of a frame, evaluated once into
		// a texel by a pass of its own and loaded there: the flare's visibility (a: LightShafts.ts
		// `occlusion`, the depth taps over its body's disk times the sky constants' cloud
		// transmittance over it, the sun's disk's or the moon's) and the rods' colour's retinal scale
		// (r: Purkinje.ts `purkinjeScale`). In full float, so the readers get exactly the value it computed itself.
		const constants = this.constants.output = g.color( 'postConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: THREE.RGBAFormat, type: THREE.FloatType } );
		const constant = textureLoad( texture( g.texture( constants ) ), ivec2( 0 ) ) as unknown as THREE.Node<'vec4'>;
		// (in scene units: the haze, the shafts and the rods' colour are; hdr is pre-exposed again)
		const aired = this.air.apply( sceneUnits( sceneTex.rgb ), tSurfaceDepth, sky, g, rainAir ? ( _d, _distance, background, transmittance ) => vec4( background, transmittance ) : veil );
		const shafts = this.shafts.build( tSurfaceDepth, sky, g );
		// The sky's own per-frame constants, which the flare's visibility reads (the post constants
		// below): the mean cloud transmittance over the sun's disc and over the moon's (Sky.ts
		// `discCloudTransmittance`). The dome's discs take the clouds' transmittance per pixel instead.
		this.skyConstants.output = g.color( 'skyConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: THREE.RGBAFormat, type: THREE.FloatType } );
		const skyConstantsMat = new THREE.NodeMaterial();
		skyConstantsMat.name = 'Sky.Constants';
		skyConstantsMat.fragmentNode = sky.discCloudTransmittance();
		this.skyConstants.quad = new THREE.QuadMesh( skyConstantsMat );
		this.skyConstants.quad.name = 'Sky.Constants';
		const constantsMat = new THREE.NodeMaterial();
		constantsMat.name = 'Post.Constants';
		const discCloud = textureLoad( texture( g.texture( this.skyConstants.output ) ), ivec2( 0 ) ) as unknown as THREE.Node<'vec4'>;
		// (r: the rods' colour's retinal scale, from the light that falls on open level ground: the
		// key's share at its lifted cosine and the sky's irradiance lent to the island, at its fill;
		// Purkinje.ts `purkinjeScale`)
		const openLight = u.purkinjeKey.add( luminance( sky.islandIrradianceNode ).mul( shared.skyFill ) );
		constantsMat.fragmentNode = vec4( purkinjeScale( openLight ), 0, 0, this.shafts.occlusion( tSurfaceDepth, g.extent( { of: 'render' } ), discCloud.r, discCloud.g ) );
		this.constants.quad = new THREE.QuadMesh( constantsMat );
		this.constants.quad.name = 'Post.Constants';
		// with the rods' colour by night (Purkinje.ts, off: its strength 0; its retinal scale the
		// constants' r), so the bloom, the local tone's grid and the grade all read it
		const composited = preExposed( purkinjeShift( aired.rgb.add( shafts ), constant.r, u.purkinje ) );
		// Rendered once (the composite pass, into hdr), the composite feeds the sharp image and both
		// blooms' high passes; as an expression each of them evaluated it again, the haze's
		// tricubic lookups included. The high passes run at half resolution and sample it bilinearly, as they sampled
		// the scene colour before.
		let tHdr: THREE.TextureNode | null = null;
		if ( hdr ) {

			const compositeMat = new THREE.NodeMaterial();
			compositeMat.name = 'Post.Composite';
			// (under the resolve also the veil's reactive weight, the second target: VEIL_REACTIVE)
			compositeMat.fragmentNode = veilReactive
				? outputStruct( vec4( composited, 1 ), vec4( min( aired.a.mul( VEIL_REACTIVE.gain ), VEIL_REACTIVE.max ) ) )
				: vec4( composited, 1 );
			// After the resolve the air's transmittance instead, the second target: the composite is
			// affine in the scene colour at a pixel, hdr = A scene + B (A the transmittance, B the light
			// the haze and the shafts add), so a streak drawn after the resolve takes the air of what
			// lies behind it as it would have here (AfterResolve.ts).
			if ( rainAir ) compositeMat.fragmentNode = outputStruct( vec4( composited, 1 ), vec4( aired.a ) );
			this.compositeQuad = new THREE.QuadMesh( compositeMat );
			this.compositeQuad.name = 'Post.Composite';
			// (with the uv rtt() gave its texture: a texture() without one transforms it)
			// Under fsr3 what follows the composite reads FSR's output instead (Fsr3Upscaler.ts: its
			// passes take hdr, declared after the composite pass).
			if ( FSR3 ) ( this as { fsr3: Fsr3Upscaler | null } ).fsr3 = new Fsr3Upscaler( renderer, g as unknown as FrameGraph<unknown>, {
				hdr, surfaceDepth, velocity: velocity!, veilReactive, sceneColor, opaqueColor,
			}, { settings: temporal ?? QUALITY.high.taa, exposure: exposureRead, debugView: DEV && new URLSearchParams( globalThis.location?.search ?? '' ).has( 'fsrDebug' ) } );
			tHdr = this.fsr3 ? this.fsr3.source( uv() ) : texture( g.texture( hdr ), uv() );

		}
		const hdrColor: V3 = tHdr ? tHdr.rgb : composited;
		// the metering histograms of hdr (without the composite pass they are never taken, and the
		// meter reads none) and the meter, from the sky's geometric-mean luminance (Exposure.ts; the
		// log the dome's metering illuminance is made of, set by main.ts before the pipeline)
		const metering = this.metering = new Metering( g.texture( hdr ?? sceneColor ), g.texture( meterLight ), renderSize );
		metering.buildMeter( shared.skyMeterLog2, g.texture( exposureStatePrev ) );
		// the adaptation starts over at every cut, in every mode (SceneEvents.ts; the temporal modes'
		// camera jumps that no event covers through Motion.ts)
		onSceneCut( ( reason ) => {

			this.exposureReset = true;
			// a scene jump takes a fresh load's pre-exposure; a loop restart or the page shown again
			// keep the scene (SceneEvents.ts `SAME_SCENE`)
			if ( reason !== 'loop start' && reason !== 'visible' ) preExposure.reset();

		} );
		if ( TEMPORAL ) onTaaCut( () => { this.exposureReset = true; } );

		// ---- tidewater's physical bloom (PhysicalBloom.ts): from hdr (under fsr3 FSR's output), or the
		// scene's colour where the composite is evaluated inline (`post=inline-composite`), added to
		// the image at its strength
		// (the sky: its surface past the far plane, view z below -9e4, at the render texel)
		const isSky = ( at: V2 ): F => select( ( textureLoad( tSurfaceDepth, ivec2( clamp( at.mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) ) ) as unknown as F ).lessThan( - 9e4 ), float( 1 ), float( 0 ) );
		// The flare (the sun's, or the moon's while it is the key) joins the first level
		// (LightShafts.ts `flare`), divided by the strength the result comes out with (the levels'
		// weights' sum, times the factor it is added with), so it shows only through the bloom.
		const frame = g.extent( { of: 'render' } );
		// (in hdr's units: pre-exposed)
		const flare = ( q: V2, strength: F ) => this.shafts.flare( q, frame.x.div( frame.y ), constant.a, strength.mul( u.bloom ) ).mul( preExposure.scale );
		const bloom = this.bloom = new PhysicalBloom( g, tHdr ?? sceneTex, exposure, isSky, flare );
		const withBloom = hdrColor.add( bloom.read( uv() ).mul( u.bloom ) );

		// ---- the sharp image: the composite and the blooms (the composite evaluated here, inline,
		// without the composite pass)
		const sharpMat = new THREE.NodeMaterial();
		sharpMat.name = 'Post.Sharp';
		sharpMat.fragmentNode = vec4( withBloom, 1 );
		this.sharpQuad = new THREE.QuadMesh( sharpMat );
		this.sharpQuad.name = 'Post.Sharp';
		// (the sharp image as its rtt() node was: with its uv, no uv transform)
		const tSharp = texture( g.texture( sharp ), uv() );

		// (at the pixel drawn, or at render uv `q`: the rain's layer, AfterResolve.ts)
		const sharpAt = ( q?: V2 ): V3 => ( q ? tSharp.sample( q ) : tSharp ).rgb;
		// the local tone mapping's grid of the sharp image (LocalTone.ts)
		const localTone = this.localTone = LOCAL_TONE_ON ? new LocalTone( g, tSharp, exposure, renderSize ) : null;
		// scene radiance at screen uv `q` with the local tone mapping's change there (for the grade's
		// table, which holds the rest of the grade)
		const localAt = ( lin: V3, q: V2 ): V3 => localTone ? localTone.apply( lin.mul( exposure ), q ).div( exposure ) : lin;

		// ---- tidewater's grade, to display values: the scene at the exposure, the vignette (the
		// resolve leaves it to the canvas pass, after the accumulation), the tone curve with the
		// white balance, the grade's tables, overcast's highlights toward grey (HIGHLIGHT_GREY) and the
		// BT.709 OETF (its saturation and contrast are the
		// table's, GradeLut.ts) (`encode` false: the output code's sRGB decode). `at`: the
		// screen uv whose local tone mapping it takes (none for the grade's table).
		// the vignette's factor at the pixel being drawn (VIGNETTE): round in the frame's own uv, the
		// same into an image of any size
		const vignetteAt = ( _size: THREE.UniformNode<'vec2', THREE.Vector2> ) => {

			return vignetteFactor( uv(), u.vignette );

		};
		const grade = ( lin: V3, vignette: boolean, encode: boolean, at?: V2 ): V3 => {

			const c = lin.mul( exposure ).toVar();
			// the desaturation (DESATURATION), before the local gain
			c.addAssign( vec3( luminance( c ) ).sub( c ).mul( u.desaturate.mul( mix( float( 1 ), coolShare( u.balance.mul( c ), COOL_FROM, COOL_TO ), u.desaturateCool ) ) ) );
			if ( localTone && at ) c.assign( localTone.apply( c, at ) );
			// the shade's contrast (SHADE_CONTRAST)
			c.mulAssign( exp2( min( log2( max( luminance( c ), 1e-6 ) ).sub( log2( u.shadePivot ) ), 0 ).mul( u.shadeSlope ) ) );
			// the night's grade (NIGHT): the greens turned toward blue-green, a silver-blue tint
			If( u.night.greaterThan( 0.001 ), () => {

				c.assign( nightGreenTurn( c, u.night.mul( NIGHT.greenTurn ) ) );
				c.mulAssign( mix( vec3( 1 ), vec3( NIGHT_TINT ), u.night.mul( NIGHT.amount ) ) );

			} );
			// the tone (TONE): lights a touch golden and the shade a touch teal, the contrast round mid
			// grey softer
			const lights = smoothstep( 0.04, 0.9, luminance( c ) );
			c.mulAssign( mix( vec3( 0.95, 1.0, 1.04 ), vec3( 1.06, 1.0, 0.9 ), lights ).sub( 1 ).mul( u.tone ).add( 1 ) );
			c.assign( pow( max( c, vec3( 0 ) ).div( 0.18 ), vec3( float( 1 ).sub( u.tone.mul( 0.2 ) ) ) ).mul( 0.18 ) );
			if ( vignette ) c.mulAssign( vignetteAt( FSR3 ? canvasSize : renderSize ) );
			const t = ( toneCurve( c, u.toneIn, u.toneOut, u.toneNum, u.toneDen ) as V3 ).toVar();
			// the grade's tables, indexed by the square root of the curve's linear output (GradeLut.ts)
			const q = sqrt( max( t, vec3( 0 ) ) ).toVar();
			const looked = mix( sampleLut( this.luts[ 0 ], q ), sampleLut( this.luts[ 1 ], q ), u.lut ).toVar();
			// the output transfer: the tables' linear output (the square of what they hold) encoded by
			// the BT.709 OETF, a code the canvas shows as sRGB (`encode` false: that code's sRGB decode,
			// so the temporal canvas pass's sRGB encode gives the code back)
			const graded = looked.mul( looked ).toVar();
			// overcast's highlights toward grey (HIGHLIGHT_GREY): a weight of 0 adds nothing
			const y = luminance( graded );
			graded.addAssign( vec3( y ).sub( graded ).mul( HIGHLIGHT_GREY.amount.mul( smoothstep( HIGHLIGHT_GREY.from, HIGHLIGHT_GREY.to, y ) ).mul( u.highlightShare ) ) );
			const v = ( bt709( clamp( graded, 0, 1 ) as V3 ) as V3 ).toVar();
			return encode ? v : sRGBTransferEOTF( v ) as V3;

		};
		// the blue-noise dither (BlueNoise.ts), after the output transfer: ( n - 0.5 ) / 255 on each
		// channel, n the tile's threshold at the pixel drawn (modulo its size), static; once per
		// canvas pixel, in whichever pass draws the canvas (`on` 0 leaves it out: a display pass
		// whose image is upscaled after)
		const noise = blueNoiseTexture();
		const finish = ( s: V3, _size: THREE.UniformNode<'vec2', THREE.Vector2>, on: F ) => {

			If( on.greaterThan( 0.5 ), () => {

				const p = ivec2( floor( screenCoordinate.xy ) ).toVar();
				const n = ( textureLoad( noise, ivec2( p.x.bitAnd( BLUE_NOISE - 1 ), p.y.bitAnd( BLUE_NOISE - 1 ) ) ) as unknown as V4 ).r;
				s.addAssign( n.sub( 0.5 ).div( 255 ) );

			} );
			return vec4( s, 1 );

		};

		// The graded image, at the render's size, always into one float target (the display pass),
		// which the canvas pass copies or upscales: one build of the grade, whatever the output.
		// Float, so the copy below hands the canvas exactly the values a direct draw would. The
		// temporal resolve accumulates it before the vignette and dither, which its canvas
		// pass adds.
		const displayMat = new THREE.NodeMaterial();
		displayMat.name = 'Post.Display';
		displayMat.fragmentNode = Fn( () => finish( grade( sharpAt(), ! RESOLVE, ! LINEAR_DISPLAY, uv() ), FSR3 ? canvasSize : renderSize, RESOLVE ? float( 0 ) : u.ditherOn ) )();
		this.displayQuad = new THREE.QuadMesh( displayMat );
		this.displayQuad.name = 'Post.Display';

		// At the display's resolution it is copied to the canvas, dither and all.
		const tDisplay = g.texture( display );
		if ( ! RESOLVE ) {

			this.output = new THREE.RenderPipeline( renderer, textureLoad( tDisplay, ivec2( screenCoordinate.xy ) ) );
			this.output.outputColorTransform = false;

		}

		// Below it, FSR 1 (AMD FidelityFX Super Resolution 1, FSR.ts) upscales the image (it expects
		// display values) before the dither, so the dither stays one display pixel fine and is not
		// sharpened. The browser's stretch of a small canvas was a plain bilinear filter. The canvas
		// pass sharpens EASU's result itself; three's FSR1Node, kept for A/B (post=three-fsr), took
		// a canvas-sized pass and target more.
		if ( easu ) {

			const backend = renderer.backend as unknown as { hasFeature?( name: string ): boolean };
			const fsr = this.fsr = new FSR( tDisplay, g.texture( easu ), backend.hasFeature?.( 'float32-filterable' ) === true, g );
			this.upscaledOutput = new THREE.RenderPipeline( renderer, Fn( () => finish( fsr.rcas( this.sharpness ).toVar(), canvasSize, float( 1 ) ) )() );
			this.upscaledOutput.outputColorTransform = false;

		} else if ( ! RESOLVE && ! FSR3 ) {

			const upscaled = fsr1( texture( tDisplay ), this.sharpness );
			this.upscaledOutputThree = new THREE.RenderPipeline( renderer, Fn( () => finish( upscaled.rgb.toVar(), canvasSize, float( 1 ) ) )() );
			this.upscaledOutputThree.outputColorTransform = false;

		}
		// What the rain's layer pass draws at the canvas's size, for the canvas pass to add to the
		// resolved image after the resolve (AfterResolve.ts): the change the rain makes to the graded
		// colour at the pixel (without the vignette, the canvas pass's; in linear light under
		// `linear`), and in alpha 1 where it makes one. The rain is laid over the grade's input at the
		// render texel nearest the point the pixel shows (the display pass's own: the sharp image), in
		// scene radiance as it was before the grade, and that is graded: the change is the difference from what the display
		// pass graded at the texel. (Without `linear` the display holds encoded values: both are
		// graded here.) Blended after the grade instead, faint rain over the dark sea and meadow, in
		// the curve's toe, came out brighter than over the same pixels before it.
		// - The veil at the canvas pixel's unjittered ray, in front of what lies at that texel, as the
		//   composite laid it over the air (Rain.veil; the shafts the composite added over it now lie
		//   under it).
		// - Then the overlay of streaks, splashes and spray through the composite at that texel, which
		//   is A scene + B: A the air's transmittance (rainAir), B the grade's input less A scene.
		// Nothing while it is dry and the after pass did not draw (the overlay then holds an earlier
		// frame's: `afterOn`).
		const tAfterDepth = texture( tSurfaceDepth );
		const tAfterDisplay = texture( tDisplay );
		// What the layer reads at a render texel, drawn by a pass of its own at the render's size while
		// it runs (`rainInput`): the grade's input there (as the display pass has it: `diffused`) and
		// the air's transmittance (A), in `rainInput`; and the light the haze and the shafts add (B,
		// the grade's input less A times the scene), in `rainBehind`. Evaluated per canvas pixel instead
		// (six or more of them read each texel), they took a fifth of the layer's time.
		const tRainInput = rainInput ? texture( g.texture( rainInput ) ) : null;
		const tRainBehind = rainBehind ? texture( g.texture( rainBehind ) ) : null;
		// (one body for both attachments: an output struct is the material's own node, so the two are
		// a matrix's columns)
		const inputs = rainInput ? Fn( () => {

			const texel = ivec2( screenCoordinate.xy ).toVar();
			const before = sharpAt( vec2( texel ).add( 0.5 ).div( renderSize ) ).toVar();
			if ( ! rainAir ) return mat4( vec4( before, 1 ), vec4( 0 ), vec4( 0 ), vec4( 0 ) );
			const keep = ( textureLoad( texture( g.texture( rainAir ) ), texel ) as unknown as F ).toVar();
			const scene = ( textureLoad( sceneTex, texel ) as unknown as THREE.Node<'vec4'> ).rgb;
			return mat4( vec4( before, keep ), vec4( before.sub( scene.mul( keep ) ), 1 ), vec4( 0 ), vec4( 0 ) );

		} )() as unknown as { element( i: number ): THREE.Node<'vec4'> } : null;
		const inputNode = inputs ? ( rainAir ? outputStruct( inputs.element( 0 ), inputs.element( 1 ) ) : inputs.element( 0 ) ) as unknown as THREE.Node<'vec4'> : null;
		if ( inputNode ) {

			const inputMat = new THREE.NodeMaterial();
			inputMat.name = 'Post.RainInput';
			inputMat.fragmentNode = inputNode;
			this.rainInputQuad = new THREE.QuadMesh( inputMat );
			this.rainInputQuad.name = 'Post.RainInput';

		}
		// The grade as a table, for the canvas pass of a running frame (`layerAt( true )`): the grade of
		// GRADE_TABLE.size^3 colours, logarithmically spaced per channel (the scene colour times the
		// exposure from 2^low to 2^high: below, within two levels of black in the curve's toe; above,
		// burnt to white), baked by a pass of its own while the layer runs (`rainGrade`) and read trilinearly
		// (two bilinear taps). The change is the difference of two
		// readings (with the rain and without), so the table's error cancels to first order; graded in
		// full at every canvas pixel, the grade took a third of the layer's time. The frame that
		// completes the rest grades in full (its layer stands for every paused frame).
		const T = GRADE_TABLE;
		const gradeTableNode = rainGrade ? Fn( () => {

			const p = floor( screenCoordinate.xy ).toVar();
			const b = floor( p.x.div( T.size ) );
			const index = vec3( p.x.sub( b.mul( T.size ) ), p.y, b );
			const lin = exp2( index.div( T.size - 1 ).mul( T.high - T.low ).add( T.low ) ).div( exposure );
			return vec4( grade( lin, false, ! LINEAR_DISPLAY ), 1 );

		} )() as unknown as THREE.Node<'vec4'> : null;
		if ( gradeTableNode ) {

			const gradeMat = new THREE.NodeMaterial();
			gradeMat.name = 'Post.RainGrade';
			gradeMat.fragmentNode = gradeTableNode;
			this.rainGradeQuad = new THREE.QuadMesh( gradeMat );
			this.rainGradeQuad.name = 'Post.RainGrade';

		}
		const gradeTable = ( lin: V3 ): V3 => {

			const table = g.texture( rainGrade! );
			const c = clamp( log2( max( lin.mul( exposure ), vec3( 2 ** T.low ) ) ).sub( T.low ).div( T.high - T.low ), 0, 1 ).mul( T.size - 1 ).toVar();
			const b0 = floor( c.z ).toVar();
			const v = c.y.add( 0.5 ).div( T.size ).toVar();
			const slice = ( b: F ) => ( texture( table, vec2( c.x.add( 0.5 ).add( b.mul( T.size ) ).div( T.size * T.size ), v ) ).level( float( 0 ) ) as unknown as THREE.Node<'vec4'> ).rgb;
			return mix( slice( b0 ), slice( min( b0.add( 1 ), T.size - 1 ) ), c.z.sub( b0 ) );

		};
		// (`table`: graded by the table)
		const layerAt = ( table = false ) => Fn( () => {

			const out = vec4( 0 ).toVar();
			// the render texel nearest the point the pixel shows (its centre scaled to the render, less
			// this frame's jitter)
			const texel = ivec2( clamp( screenCoordinate.xy.mul( renderSize.div( canvasSize ) ).sub( jitter.uniforms.px ).sub( 0.5 ).round(), vec2( 0 ), renderSize.sub( 1 ) ) ).toVar();
			// what covers the pixel: the veil (at the pixel's unjittered ray, in front of what lies at the
			// texel) and the overlay, while either shows
			const veil = vec4( 0 ).toVar();
			if ( rain ) If( rain.uniforms.rain.greaterThan( 0.001 ), () => {

				// (the sky's -1e5 and anything past the farthest shell alike: they all lie beyond it)
				const { ray, direction } = this.air.viewRay( uv(), jitter.uniforms.unjitteredProjectionInverse );
				const distance = min( ( textureLoad( tAfterDepth, texel ) as unknown as F ).negate().mul( length( ray ) ), 1000 );
				veil.a.assign( rain.veilCoverage( direction, distance ) );

			} );
			const o = vec4( 0 ).toVar();
			If( u.afterOn.greaterThan( 0 ), () => {

				o.assign( textureLoad( texture( g.texture( rainOverlay! ) ), ivec2( screenCoordinate.xy ) ) );

			} );
			// (below a 256th the change shows in no level)
			If( max( veil.a, o.a ).greaterThan( 1 / 256 ), () => {

				if ( rain ) veil.rgb.assign( rain.veilLight( this.air.viewRay( uv(), jitter.uniforms.unjitteredProjectionInverse ).direction ).mul( veil.a ).mul( preExposure.scale ) );
				const input = ( textureLoad( tRainInput!, texel ) as unknown as THREE.Node<'vec4'> ).toVar();
				const before = input.rgb;
				// the veil over the grade's input
				const after = before.mul( float( 1 ).sub( veil.a ) ).add( veil.rgb ).toVar();
				If( o.a.greaterThan( 1 / 1024 ), () => {

					// then the overlay's radiance (premultiplied) through the composite, A scene + B (the
					// legacy inline composite writes no transmittance: the streaks then take no air)
					const a = min( o.a, 1 ).toVar();
					if ( tRainBehind ) after.assign( after.mul( float( 1 ).sub( a ) ).add( o.rgb.mul( input.a ) ).add( ( textureLoad( tRainBehind, texel ) as unknown as THREE.Node<'vec4'> ).rgb.mul( a ) ) );
					else after.assign( after.mul( float( 1 ).sub( a ) ).add( o.rgb ) );

				} );
				// (the change at the rain's own coverage of a sample, AFTER_COVERAGE, spread over the pixel)
				const full = max( before.add( after.sub( before ).div( AFTER_COVERAGE ) ), vec3( 0 ) );
				const at = vec2( texel ).add( 0.5 ).div( renderSize ).toVar();
				if ( table ) out.assign( vec4( gradeTable( localAt( full, at ) ).sub( gradeTable( localAt( before, at ) ) ).mul( AFTER_COVERAGE ), 1 ) );
				else {

					const graded = LINEAR_DISPLAY ? ( textureLoad( tAfterDisplay, texel ) as unknown as THREE.Node<'vec4'> ).rgb : grade( before, false, ! LINEAR_DISPLAY, at );
					out.assign( vec4( grade( full, false, ! LINEAR_DISPLAY, at ).sub( graded ).mul( AFTER_COVERAGE ), 1 ) );

				}

			} );
			return out;

		} )() as unknown as THREE.Node<'vec4'>;
		if ( rainOverlay ) {

			const layerMat = new THREE.NodeMaterial();
			layerMat.name = 'Post.RainLayer';
			layerMat.fragmentNode = layerAt();
			this.layerQuad = new THREE.QuadMesh( layerMat );
			this.layerQuad.name = 'Post.RainLayer';

		}
		// the temporal resolve, its passes declared after the display pass
		if ( RESOLVE ) ( this as { temporal: TemporalAA | null } ).temporal = new TemporalAA( g as unknown as FrameGraph<unknown>, renderer, {
			mode: AA_MODE as TemporalMode, settings: temporal ?? QUALITY.high.taa,
			vignette: vignetteAt, finish,
			// (the rain's layer, drawn by a pass of its own: in the canvas pass it held too many registers)
			// (read only while the pass runs: in fair weather the canvas pass reads nothing more)
			layer: rainLayer ? () => Fn( () => {

				const l = vec4( 0 ).toVar();
				If( u.layerOn.greaterThan( 0 ), () => {

					l.assign( textureLoad( texture( g.texture( rainLayer ) ), ivec2( screenCoordinate.xy ) ) );

				} );
				return l;

			} )() as unknown as THREE.Node<'vec4'> : undefined,
			// (and the layer itself, for the canvas pass of a running frame while it shows)
			layerInline: rainLayer ? { node: () => layerAt( true ), on: () => this.u.layerOn.value > 0 } : undefined,
		} );
		this.declarePasses();
		if ( TEMPORAL ) {

			// The jitter shifts the camera's projection through the scene half (the graph's jittered
			// span) and is undone after it; the post passes reconstruct positions with the inverse
			// the frame was drawn with, set once the jitter is on (Jitter.ts): the composite's own, the
			// haze's rays (its composite: the froxel grid itself stays unjittered) and the shafts' (only
			// the sun's position on screen stays unjittered, from `update`).
			jitter.mode = AA_MODE === 'taau' ? 'taau' : FSR3 ? 'fsr3' : 'taa';
			g.hooks.jitterBegin = ( f ) => {

				jitter.begin( f.camera );
				const inverse = f.camera.projectionMatrixInverse;
				this.u.projInv.value.copy( inverse );
				this.u.proj.value.copy( f.camera.projectionMatrix );
				this.air.setProjectionInverse( inverse );
				this.shafts.setProjectionInverse( inverse );

			};
			g.hooks.jitterEnd = ( f ) => jitter.end( f.camera );
			// across a cut the nearest surface's history is no longer the frame before
			const surfaceDepthPrev = this.resources.surfaceDepthPrev;
			if ( surfaceDepthPrev ) onTaaCut( () => g.resetHistory( surfaceDepthPrev ) );

		}
		g.compile();
		// The scene target's multisampled colour and depth are resolved, then never read: the
		// graph's attachment ops discard them in the last pass that draws into them and drop a
		// resolve nothing samples before the next draw, derived per frame from the passes that run
		// (the legacy table, `fgOps=legacy`, discards in the rain only: the discardScene option,
		// `legacyDiscard` above). WebGPU lets a pass load its attachments and still discard them
		// once resolved, which three r186 offers only together with a clear, so AttachmentOps
		// rewrites the stores as three hands each pass's descriptor to WebGPU.
		g.attachmentOps.install();

	}

	/** The falling leaves, once the world exists (main.ts): their pass runs while they are set. */
	fallingLeaves: FallingLeaves | null = null;

	// the displacement field as its pass leaves it, and the frame before's (null without one)
	private displacement: { field: ResourceHandle; previous: ResourceHandle | null } | null = null;

	// The blades read the displacement field in every pass that draws the meadow, and the frame
	// before's for their previous position under the temporal modes.
	private readDisplacement( b: PassBuilder ): void {

		if ( ! this.displacement ) return;
		b.read( this.displacement.field );
		if ( this.displacement.previous ) b.read( this.displacement.previous );

	}

	// The frame's passes, in order. The scene half draws into the scene's multisampled target and
	// resolves what the water, the rain and the post passes read. Each sample keeps the opaque
	// surface or the sea, whichever is nearer, so silhouettes against the sea are antialiased like
	// the rest of the image. (Drawn into a target of their own, single-sampled, the water had to
	// decide per pixel between the sea and the opaque colour: edges stepped, and the opaque colour
	// at an edge pixel held the sky the sea was not there to cover, a pale outline round everything
	// over the sea.) Rain does not write depth, so surface focus and overlapping translucent streaks
	// are preserved; its splashes compare the resolved depths themselves. The post passes follow,
	// each into a target of the graph's or the canvas. Ahead of the scene, after the haze and the
	// sky's constants, the displacement field (world/vegetation/Displacement.ts): its sprites at a
	// fixed size, read by the meadow's passes; then the falling leaves' step
	// (weather/FallingLeaves.ts), once main.ts has made them, and the local lights' clusters
	// (lighting/LocalLights.ts), by night.
	private declarePasses(): void {

		const g = this.graph;
		// the haze first, ahead of the scene, whose sky dome reads its light volume (Sky.ts
		// `fogDome`): its shadow (skipped while a rest holds it) and its light volume; they read the
		// sun's maps, the clouds' shadow and the camera, never the scene's depth
		const hazeReads = this.air.passes( g );
		// then the sky's constants, which the flare's visibility reads (Sky.ts `discCloudTransmittance`)
		let skyConstants = this.skyConstants.output;
		const skyConstantsQuad = this.skyConstants.quad;
		g.addPass( 'skyConstants', 'quad', ( b ) => {

			skyConstants = b.write( skyConstants );
			return { label: 'sky constants', quad: skyConstantsQuad };

		} );
		// the displacement field, which the passes that draw the meadow read
		// (world/vegetation/Displacement.ts)
		this.displacement = displacementField ? displacementField.declare( g ) : null;
		// the falling leaves' step, whose buffers the opaque scene draws
		leavesPass( g, () => this.fallingLeaves );
		// the local lights' clusters, which every lit material of the scene passes reads
		// (lighting/LocalLights.ts)
		localLightsPass( g );
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, underwater, surfaceDepth, velocity, meterLight } = this.resources;
		if ( TEMPORAL ) [ sceneColor, surfaceDepth, velocity, opaqueColor, meterLight ] = this.declareTemporalScene( hazeReads );
		else {

			// the vegetation's depth first, the opaque scene's copies (world/OpaquePrepass.ts), the
			// shade over both (MeadowShade.ts), then the opaque scene over the vegetation's depth
			let { meadowCoverage, meadowDepth, meadowShade: shade } = this.resources;
			let { gtaoOpaque, gtaoOpaqueDepth, gtaoDepth, gtaoRaw, gtaoBlur, gtao } = this.resources;
			const depthQuad = this.meadowDepthQuad, shadeQuad = this.meadowShadeQuad;
			const gtaoOn = () => GTAO && debugFlags.gtao !== false;
			const ssOn = () => SS_SHADOW && debugFlags.ssShadow !== false;
			if ( meadowCoverage && meadowDepth && shade && depthQuad && shadeQuad ) {

				g.addPass( 'meadowDepth', 'scene', ( b ) => {

					this.readDisplacement( b );
					meadowCoverage = b.write( meadowCoverage!, { clear: true } );
					sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
					return { label: 'vegetation depth', scene: ( f ) => f.prepassScene!, camera: ( f ) => f.camera };

				} );
				// the opaque scene's distance at half resolution, for the ambient occlusion and the
				// shade over the whole scene
				if ( gtaoOpaque && gtaoOpaqueDepth ) g.addPass( 'opaqueDepth', 'scene', ( b ) => {

					gtaoOpaque = b.write( gtaoOpaque!, { clear: true } );
					gtaoOpaqueDepth = b.depth( gtaoOpaqueDepth!, { write: true, clear: true } );
					return { label: 'opaque depth', when: () => gtaoOn() || ssOn(), whenLabel: 'gtao|ssShadow', scene: ( f ) => f.opaquePrepassScene!, camera: ( f ) => f.camera };

				} );
				g.addPass( 'meadowDepthResolve', 'quad', ( b ) => {

					b.read( sceneDepth, 'samples' );
					if ( SS_SHADOW && gtaoOpaque ) b.readOptional( gtaoOpaque );
					meadowDepth = b.write( meadowDepth! );
					return { label: 'meadow shade', quad: depthQuad };

				} );
				g.addPass( 'meadowShade', 'quad', ( b ) => {

					b.read( meadowDepth! );
					shade = b.write( shade! );
					return { label: 'meadow shade', quad: shadeQuad };

				} );

			}
			// the ambient occlusion (GTAO.ts): the nearer of the opaque scene's distance and the
			// vegetation's depth as view z, the slices and their blur, which the opaque scene's
			// receivers load
			const quads = this.gtaoQuads;
			if ( meadowCoverage && gtaoOpaque && gtaoDepth && gtaoRaw && gtaoBlur && gtao && quads ) {

				g.addPass( 'gtaoDepth', 'quad', ( b ) => {

					b.readOptional( sceneDepth, 'samples' );
					b.readOptional( gtaoOpaque! );
					gtaoDepth = b.write( gtaoDepth! );
					return { label: 'gtao', when: gtaoOn, whenLabel: 'gtao', quad: quads.depth };

				} );
				g.addPass( 'gtao', 'quad', ( b ) => {

					b.readOptional( gtaoDepth! );
					gtaoRaw = b.write( gtaoRaw! );
					return { label: 'gtao', when: gtaoOn, whenLabel: 'gtao', quad: quads.slices };

				} );
				// the blur, separable: along x, then along y (the view z for its edges' planes)
				g.addPass( 'gtaoBlurX', 'quad', ( b ) => {

					b.readOptional( gtaoRaw! );
					b.readOptional( gtaoDepth! );
					gtaoBlur = b.write( gtaoBlur! );
					return { label: 'gtao', when: gtaoOn, whenLabel: 'gtao', quad: quads.blurX };

				} );
				g.addPass( 'gtaoBlurY', 'quad', ( b ) => {

					b.readOptional( gtaoBlur! );
					b.readOptional( gtaoDepth! );
					gtao = b.write( gtao! );
					return { label: 'gtao', when: gtaoOn, whenLabel: 'gtao', quad: quads.blurY };

				} );
			}
			// the receivers read the occlusion and the whole scene's shade in the opaque pass alone
			// (the refraction's draws of the same materials read 1)
			if ( gtao || SS_SHADOW ) {

				const end = g.hooks.onPassEnd;
				g.hooks.onPassEnd = ( pass, f ) => {

					if ( pass.name === 'opaque' ) gtaoView.on.value = screenShadowView.on.value = 0;
					end?.( pass, f );

				};

			}
			const occlusion = gtao;
			g.addPass( 'opaque', 'scene', ( b ) => {

				// the blades read their shade, the ground marches over the resolved depth, the
				// receivers load the ambient occlusion and the whole scene's shade
				if ( shade ) b.read( shade );
				if ( meadowDepth && ! SS_SHADOW ) b.read( meadowDepth );
				if ( occlusion ) b.readOptional( occlusion );
				for ( const h of hazeReads ) b.read( h );
				this.readDisplacement( b );
				sceneColor = b.write( sceneColor, { clear: true } );
				meterLight = b.write( meterLight, { clear: true } );
				sceneDepth = b.depth( sceneDepth, { write: true, clear: ! shade } );
				return {
					label: 'opaque scene', mrt: sceneMRT, scene: ( f ) => f.scene, camera: ( f ) => f.camera,
					before: occlusion || SS_SHADOW ? () => {

						gtaoView.on.value = gtaoOn() ? 1 : 0;
						screenShadowView.on.value = ssOn() ? 1 : 0;

					} : undefined,
				};

			} );
			let refraction: ResourceHandle, refractionDepth: ResourceHandle;
			[ underwater, refraction, refractionDepth ] = this.declareRefraction( sceneColor, sceneDepth );
			// linear depth, and a copy of the opaque colour for the water to refract and reflect (a pass
			// cannot sample the target it draws into)
			g.addPass( 'depthResolve', 'quad', ( b ) => {

				b.read( sceneDepth, 'samples' );
				linearDepth = b.write( linearDepth );
				return { label: 'depth & copy resolves', quad: this.depthQuad };

			} );
			const copyQuad = this.copyQuad!;
			g.addPass( 'opaqueCopy', 'quad', ( b ) => {

				b.read( sceneColor );
				opaqueColor = b.write( opaqueColor );
				return { label: 'depth & copy resolves', quad: copyQuad };

			} );
			g.addPass( 'water', 'scene', ( b ) => {

				b.read( opaqueColor );
				b.read( linearDepth );
				b.read( underwater );
				b.readOptional( refraction );
				b.readOptional( refractionDepth );
				sceneColor = b.write( sceneColor );
				meterLight = b.write( meterLight );
				sceneDepth = b.depth( sceneDepth, { write: true } );
				return {
					label: 'water', mrt: sceneMRT, before: ( f ) => f.water?.prepare( f.sun ),
					scene: ( f ) => f.water ? f.waterScene : NO_WATER, camera: ( f ) => f.camera,
				};

			} );
			g.addPass( 'surfaceResolve', 'quad', ( b ) => {

				b.read( sceneDepth, 'samples' );
				surfaceDepth = b.write( surfaceDepth );
				return { label: 'depth & copy resolves', quad: this.surfaceQuad };

			} );
			// (the last pass into the scene target: its samples are resolved, then never read)
			g.addPass( 'rain', 'scene', ( b ) => {

				b.read( linearDepth );
				b.read( surfaceDepth );
				sceneColor = b.write( sceneColor );
				meterLight = b.write( meterLight, { blend: 'keep' } );
				b.depth( sceneDepth, { write: false } );
				return {
					label: 'rain draw', mrt: overlayMRT, when: ( f ) => f.rainScene !== undefined, whenLabel: 'rainVisible',
					scene: ( f ) => f.rainScene!, camera: ( f ) => f.camera,
				};

			} );

		}
		let { hdr, sharp, display, easu, canvas, veilReactive, rainAir } = this.resources;
		// the light shafts: the open sky near the sun, and the rays marched over it (while the sun is
		// toward the view: the composite weighs them by `facing`, 0 otherwise)
		const shaftReads = this.shafts.passes( g, surfaceDepth );
		// the post passes' per-frame constants, into a texel: the flare's visibility (the
		// nearest surface's depth over the disk, the sky constants' cloud transmittance over it)
		// and the rods' colour's retinal scale
		let constants = this.constants.output;
		const constantsQuad = this.constants.quad;
		g.addPass( 'postConstants', 'quad', ( b ) => {

			b.read( surfaceDepth );
			b.read( skyConstants );
			constants = b.write( constants );
			return { label: 'post constants (flare visibility, rods\' scale)', quad: constantsQuad };

		} );
		// what the composite reads: the scene (after the rain, which may be skipped), the nearest
		// surface's depth, the haze's light, the light shafts and the constants (the flare's
		// visibility, the rods' colour's scale)
		const compositeReads = ( b: PassBuilder ) => {

			b.readOptional( sceneColor );
			b.read( surfaceDepth );
			for ( const h of hazeReads ) b.read( h );
			for ( const h of shaftReads ) b.readOptional( h );
			b.read( constants );

		};
		// the metering histograms' clear, before the composite (Metering.ts)
		const metering = this.metering;
		const { exposureStatePrev } = this.resources;
		if ( hdr ) metering.clearPass( g );
		// the composite of the haze, the veil and the shafts, rendered once
		const compositeQuad = this.compositeQuad;
		if ( hdr && compositeQuad ) g.addPass( 'composite', 'quad', ( b ) => {

			compositeReads( b );
			hdr = b.write( hdr! );
			// (the attachments in this order: the struct's; the MRT only declares both to the graph,
			// unblended, as the resolve's does)
			if ( veilReactive ) veilReactive = b.write( veilReactive );
			if ( rainAir ) rainAir = b.write( rainAir );
			return { label: 'composite (air, fog, veil)', quad: compositeQuad, mrt: veilReactive || rainAir ? mrt( {} ) : null };

		} );
		// the metering histograms of hdr and meterLight, after the composite and before the bloom,
		// which reads this frame's exposure (Metering.ts)
		if ( hdr ) metering.histogramPass( g, hdr, meterLight );
		// the meter: the exposure state from the histograms, which every pass after it reads (and the
		// next frame, from its copy)
		const exposureState = metering.meterPass( g, this.resources.exposureState, exposureStatePrev );
		g.copyToPersistent( exposureState, exposureStatePrev );
		const readExposure = ( b: PassBuilder ) => b.read( exposureState );
		// FSR 3 on hdr (Fsr3Upscaler.ts), whose output (or, while the rest's sequence runs, the held copy
		// of the last running frame's) the passes below read in place of hdr
		const fsr3 = this.fsr3 ? this.fsr3.declare( g as unknown as FrameGraph<unknown>, { hdr: hdr!, surfaceDepth, velocity: velocity!, veilReactive, sceneColor, opaqueColor, exposure: exposureState } ) : null;
		const readHdr = ( b: PassBuilder ) => {

			if ( fsr3 ) {

				b.readOptional( fsr3.output );
				b.readOptional( fsr3.held );

			} else b.read( hdr! );

		};
		// the bloom (PhysicalBloom.ts, sixteen passes): the sky's mask from the surface's depth, then
		// the pyramid from hdr, or the scene's colour without the composite
		const bloomResult = this.bloom.passes( g, 'bloom', ( b ) => {

			if ( hdr ) readHdr( b );
			else b.readOptional( sceneColor );
			readExposure( b );

		}, ( b ) => b.read( surfaceDepth ), ( b ) => b.read( constants ) );
		// the sharp image: the composite (inline, without the composite pass: the profiler's
		// composite then) and the blooms
		const sharpQuad = this.sharpQuad;
		g.addPass( 'sharp', 'quad', ( b ) => {

			if ( hdr ) readHdr( b );
			else compositeReads( b );
			b.read( bloomResult );
			sharp = b.write( sharp );
			return { label: hdr ? 'sharp (composite + blooms)' : 'composite (air, fog, veil)', quad: sharpQuad };

		} );
		// the local tone mapping's grid (LocalTone.ts), then the grade
		const toneGrid = this.localTone ? this.localTone.passes( g, ( b ) => {

			b.read( sharp );
			readExposure( b );

		} ) : null;
		const displayQuad = this.displayQuad;
		g.addPass( 'display', 'quad', ( b ) => {

			b.read( sharp );
			if ( toneGrid ) b.read( toneGrid );
			readExposure( b );
			display = b.write( display );
			return { label: 'grade', quad: displayQuad };

		} );
		// the temporal resolve and its canvas pass (TemporalAA.ts)
		if ( this.temporal ) {

			const { surfaceDepthPrev } = this.resources;
			let rainOverlay = this.resources.rainOverlay;
			// After the resolve (AfterResolve.ts): the rain's streaks and the storm's spray, unjittered,
			// into the overlay at the canvas's size, which the canvas pass lays over the resolved image
			// (with the composite at the pixel, and the nearest surface for the grade's sky test).
			const after = rainOverlay ? () => {

				g.addPass( 'rainAfter', 'scene', ( b ) => {

					b.read( surfaceDepth );
					rainOverlay = b.write( rainOverlay!, { clear: true } );
					return {
						label: 'rain after resolve', mrt: afterMRT, when: ( f ) => f.afterScene !== undefined && ! this.afterHeld(), whenLabel: 'streaks || spray, not held',
						scene: ( f ) => f.afterScene!, camera: ( f ) => f.camera,
					};

				} );
				// what the layer reads at a render texel (`rainInput`, `rainBehind`), while it runs
				let rainInput = this.resources.rainInput!, rainBehind = this.resources.rainBehind;
				const inputQuad = this.rainInputQuad!;
				g.addPass( 'rainInput', 'quad', ( b ) => {

					// (the grade's input: the sharp image)
					b.read( sharp );
					b.read( surfaceDepth );
					if ( rainAir ) {

						b.read( rainAir );
						// (after the overlay pass, which does not run after the resolve)
						b.readOptional( sceneColor );

					}
					// (the attachments in the struct's order; the MRT only declares them)
					rainInput = b.write( rainInput );
					if ( rainBehind ) rainBehind = b.write( rainBehind );
					return { label: 'rain layer', when: ( f ) => this.layerRuns( f ) && ! this.afterHeld(), whenLabel: 'rain || spray, not held', quad: inputQuad, mrt: rainBehind ? mrt( {} ) : null };

				} );
				// the grade's table, for the canvas pass that draws the layer
				let rainGrade = this.resources.rainGrade!;
				const gradeQuad = this.rainGradeQuad!;
				const temporal = this.temporal!;
				g.addPass( 'rainGrade', 'quad', ( b ) => {

					readExposure( b );
					rainGrade = b.write( rainGrade );
					return { label: 'rain layer', when: () => temporal.drawsLayer, whenLabel: 'layer in the canvas pass', quad: gradeQuad };

				} );
				// The change the rain makes to the graded image (`layerAt`), while it rains or the
				// overlay holds something: drawn here into `rainLayer` for the frame that completes the
				// rest (held after it) and for TAA's upscaled canvas pass, and by the canvas pass itself
				// in every other frame (TemporalAA.ts `layerInline`; one canvas-size target less to
				// write and read).
				let rainLayer = this.resources.rainLayer!;
				const layerQuad = this.layerQuad!;
				g.addPass( 'rainLayer', 'quad', ( b ) => {

					b.read( surfaceDepth );
					b.read( display );
					if ( toneGrid ) b.read( toneGrid );
					readExposure( b );
					b.readOptional( rainInput );
					if ( rainBehind ) b.readOptional( rainBehind );
					b.readOptional( rainOverlay! );
					rainLayer = b.write( rainLayer );
					return { label: 'rain layer', when: ( f ) => this.layerRuns( f ) && ! this.afterHeld() && ! temporal.drawsLayer, whenLabel: 'rain || spray, not held, not inline', quad: layerQuad };

				} );
				return { optional: [ rainLayer, rainOverlay!, rainInput, ...( rainBehind ? [ rainBehind ] : [] ), rainGrade ], required: [ surfaceDepth, display, exposureState, ...( toneGrid ? [ toneGrid ] : [] ) ] };

			} : undefined;
			this.temporal.declare( { display, velocity: velocity!, surfaceDepth, surfaceDepthPrev: surfaceDepthPrev!, veilReactive, canvas, after } );
			return;

		}
		// to the canvas: copied at the display's resolution, upscaled below it
		g.addPass( 'output', 'chain', ( b ) => {

			b.read( display );
			canvas = b.write( canvas );
			return { label: 'output', when: () => ! this.upscaling, whenLabel: '!upscaling', pipeline: this.output! };

		} );
		const fsr = this.fsr, upscaledOutput = this.upscaledOutput, upscaledOutputThree = this.upscaledOutputThree;
		if ( easu && fsr && upscaledOutput ) {

			g.addPass( 'easu', 'quad', ( b ) => {

				b.read( display );
				easu = b.write( easu! );
				return { label: 'output & FSR', when: () => this.upscaling, whenLabel: 'upscaling', quad: fsr.quad };

			} );
			g.addPass( 'upscaledOutput', 'chain', ( b ) => {

				b.readOptional( easu! );
				canvas = b.write( canvas );
				return { label: 'output & FSR', when: () => this.upscaling, whenLabel: 'upscaling', pipeline: upscaledOutput };

			} );

		} else if ( upscaledOutputThree ) {

			// three's FSR1Node: its passes run inside the chain, at the canvas's size
			g.addPass( 'upscaledOutputThree', 'chain', ( b ) => {

				b.read( display );
				canvas = b.write( canvas );
				return { label: 'output & FSR', when: () => this.upscaling, whenLabel: 'upscaling', pipeline: upscaledOutputThree };

			} );

		}

	}

	// The scene half under the temporal modes: one sample, jittered (the passes from the opaque scene
	// to the overlay are the graph's jittered span), the motion vectors written beside the colour.
	// The opaque and water passes draw with the scene MRT (sceneMRT), the rain and the storm's spray
	// in the overlay pass with the overlay MRT, which keeps the motion of the surfaces under them
	// (Motion.ts). Returns the scene colour's, the nearest surface's, the velocity's, the opaque
	// copy's and the metering illuminance's last versions.
	private declareTemporalScene( hazeReads: ResourceHandle[] ): [ ResourceHandle, ResourceHandle, ResourceHandle, ResourceHandle, ResourceHandle ] {

		const g = this.graph;
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, surfaceDepth, meterLight } = this.resources;
		let velocity = this.resources.velocity!;
		g.addPass( 'opaque', 'scene', ( b ) => {

			// (the sky dome reads the haze's light volume)
			for ( const h of hazeReads ) b.read( h );
			this.readDisplacement( b );
			sceneColor = b.write( sceneColor, { clear: true } );
			velocity = b.write( velocity, { clear: true } );
			meterLight = b.write( meterLight, { clear: true } );
			sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
			return { label: 'opaque scene', mrt: sceneMRT, jittered: true, scene: ( f ) => f.scene, camera: ( f ) => f.camera };

		} );
		const [ underwater, refraction, refractionDepth ] = this.declareRefraction( sceneColor, sceneDepth );
		// (one sample: the farthest of the samples is sample 0)
		g.addPass( 'depthResolve', 'quad', ( b ) => {

			b.read( sceneDepth, 'samples' );
			linearDepth = b.write( linearDepth );
			return { label: 'depth & copy resolves', jittered: true, quad: this.depthQuad };

		} );
		// single-sampled, the opaque colour is copied as a texture (no draw: it replaces every texel)
		const from = g.texture( sceneColor ), to = g.texture( opaqueColor );
		g.addPass( 'opaqueCopy', 'callback', ( b ) => {

			b.read( sceneColor );
			opaqueColor = b.write( opaqueColor, { clear: true } );
			return { label: 'depth & copy resolves', jittered: true, copy: true, run: () => this.renderer.copyTextureToTexture( from, to ) };

		} );
		g.addPass( 'water', 'scene', ( b ) => {

			b.read( opaqueColor );
			b.read( linearDepth );
			b.read( underwater );
			b.readOptional( refraction );
			b.readOptional( refractionDepth );
			sceneColor = b.write( sceneColor );
			velocity = b.write( velocity );
			meterLight = b.write( meterLight );
			sceneDepth = b.depth( sceneDepth, { write: true } );
			return {
				label: 'water', mrt: sceneMRT, jittered: true, before: ( f ) => f.water?.prepare( f.sun ),
				scene: ( f ) => f.water ? f.waterScene : NO_WATER, camera: ( f ) => f.camera,
			};

		} );
		g.addPass( 'surfaceResolve', 'quad', ( b ) => {

			b.read( sceneDepth, 'samples' );
			surfaceDepth = b.write( surfaceDepth );
			return { label: 'depth & copy resolves', jittered: true, quad: this.surfaceQuad };

		} );
		// The rain and the spray over the finished scene: their colour blends as each material says,
		// the velocity under them is kept and its reactive weight takes the larger value. One scene
		// draws both, sorted by renderOrder: the spray (20) over the rain, where msaa draws the spray
		// in the water's pass and the rain over it, so where both show the image differs a little.
		g.addPass( 'overlay', 'scene', ( b ) => {

			b.read( linearDepth );
			b.read( surfaceDepth );
			sceneColor = b.write( sceneColor, { blend: 'material' } );
			velocity = b.write( velocity, { blend: 'keep-max' } );
			meterLight = b.write( meterLight, { blend: 'keep' } );
			b.depth( sceneDepth, { write: false } );
			return {
				label: 'overlay', mrt: overlayMRT, jittered: true, when: ( f ) => f.overlay === true && f.rainScene !== undefined, whenLabel: 'rain || spray',
				scene: ( f ) => f.rainScene!, camera: ( f ) => f.camera,
			};

		} );
		// the nearest surface's depth, kept for the next frame (the resolve's; FSR keeps its own)
		if ( this.resources.surfaceDepthPrev ) g.copyToPersistent( surfaceDepth, this.resources.surfaceDepthPrev );
		return [ sceneColor, surfaceDepth, velocity, opaqueColor, meterLight ];

	}

	// What the water refracts, right after the opaque pass, with the scene's jitter under the temporal
	// modes: the underwater pyramid from the opaque pass's colour and samples, then the refraction
	// source (ocean/Refraction.ts), the world under the sea through the wider view, shaded only
	// outside the mask drawn first into its depth (see refractionMaskQuad). The refraction and its
	// mask are off with `flags.refraction = false` (the water then refracts the opaque image alone:
	// Water.ts). Returns the pyramid's, the refraction colour's and its depth's versions.
	private declareRefraction( sceneColor: ResourceHandle, sceneDepth: ResourceHandle ): [ ResourceHandle, ResourceHandle, ResourceHandle ] {

		const g = this.graph;
		let { underwater, refractionReach, refraction, refractionDepth } = this.resources;
		g.addPass( 'underwaterPyramid', 'quad', ( b ) => {

			b.read( sceneColor );
			b.read( sceneDepth, 'samples' );
			underwater = b.write( underwater );
			return { label: 'underwater pyramid', jittered: TEMPORAL, quad: this.underwaterQuad };

		} );
		const on = () => debugFlags.refraction !== false;
		g.addPass( 'refractionReach', 'quad', ( b ) => {

			b.read( sceneDepth, 'samples' );
			b.read( underwater );
			refractionReach = b.write( refractionReach );
			return { label: 'refraction', jittered: TEMPORAL, when: on, whenLabel: 'refraction', quad: this.refractionReachQuad };

		} );
		g.addPass( 'refractionMask', 'quad', ( b ) => {

			b.read( underwater );
			// (the reach runs whenever the mask does)
			b.readOptional( refractionReach );
			refraction = b.write( refraction, { clear: true } );
			refractionDepth = b.depth( refractionDepth, { write: true, clear: true } );
			return { label: 'refraction', mrt: REFRACTION_MRT, jittered: TEMPORAL, when: on, whenLabel: 'refraction', quad: this.refractionMaskQuad };

		} );
		g.addPass( 'refraction', 'scene', ( b ) => {

			refraction = b.write( refraction );
			refractionDepth = b.depth( refractionDepth, { write: true } );
			return {
				label: 'refraction', mrt: REFRACTION_MRT, jittered: TEMPORAL, when: on, whenLabel: 'refraction',
				before: ( f ) => this.refraction.update( f.camera ), scene: ( f ) => f.scene, camera: () => this.refraction.camera,
			};

		} );
		return [ underwater, refraction, refractionDepth ];

	}


	/** The scene's render size, and the canvas's when it is larger (the frame is then upscaled). */
	setSize( w: number, h: number, outputWidth = w, outputHeight = h ): void {

		// (a history whose size changes is carried over to the next resolve, before the graph resizes it)
		this.temporal?.beforeResize( { render: { width: w, height: h }, canvas: { width: outputWidth, height: outputHeight } } );
		this.width = w; this.height = h;
		this.outputWidth = Math.max( outputWidth, w ); this.outputHeight = Math.max( outputHeight, h );
		// every target by its size class (the bloom's levels, the fixed constants', the upscale's at
		// the canvas), the extent uniforms the passes read their sizes from, and the chain's own
		// passes through their resize hook
		this.graph.setExtents( { render: { width: w, height: h }, canvas: { width: outputWidth, height: outputHeight } } );

	}

	/** The scene's multisampled colour and depth (the opaque scene, the water and the rain draw
	 * into it). */
	get sceneRT(): THREE.RenderTarget {

		return this.graph.target( this.resources.sceneColor );

	}

	/** The opaque pass's linear view z: sample 0 (r) and the farthest sample (g). */
	get depthRT(): THREE.RenderTarget {

		return this.graph.target( this.resources.linearDepth );

	}

	/** The resolved opaque colour (what the water reflects, and refracts where the refraction image
	 * holds nothing). */
	get opaqueRT(): THREE.RenderTarget {

		return this.graph.target( this.resources.opaqueColor );

	}

	/** The nearest surface's linear view z, the sea's included. */
	get surfaceRT(): THREE.RenderTarget {

		return this.graph.target( this.resources.surfaceDepth );

	}

	/** The graded image at the render's size (the profiler labels its pass by it). */
	get displayRT(): THREE.RenderTarget {

		return this.graph.target( this.resources.display );

	}

	// whether the rain's layer shows this frame (AfterResolve.ts): while it rains (the veil) or the
	// after pass draws (its pass then runs, unless the rest holds it)
	private layerRuns( f: PipelineFrame ): boolean {

		return f.afterScene !== undefined || ( this.rain?.uniforms.rain.value ?? 0 ) > 0.001;

	}

	// Whether the rain's after pass and layer pass keep what the frame that completed the rest drew
	// (TemporalAA.ts `holding`): both draw over this frame's jittered surface depth and grade input,
	// at its jitter, and once the rest has converged the jitter runs on through the running sequence
	// (Jitter.ts), whose place depends on the frames rendered since the page loaded. Drawn again,
	// a paused frame's rain then depended on how it was reached (and only the rain did: the resolved
	// image is the rest's). The frame that completes the rest draws at the rest sequence's last
	// jitter, and nothing it draws from changes while the rest holds (the rest's key), so its
	// overlay and layer stand for every frame after it; the canvas pass reads them as they are.
	private afterHeld(): boolean {

		return this.temporal?.holding === true;

	}

	/** What resolves the frame against its history and owns its rest: the temporal resolve, or FSR 3
	 * (null under msaa, off, and `taaResolve=off`). */
	get resolver(): TemporalAA | Fsr3Upscaler | null {

		return this.temporal ?? this.fsr3;

	}

	/** Whether the frame is rendered below the canvas's resolution and upscaled by the output passes
	 * (never under fsr3, whose output already has the canvas's size). */
	get upscaling(): boolean {

		return ! FSR3 && ( this.outputWidth !== this.width || this.outputHeight !== this.height );

	}

	/** Renders the frame: its uniforms from the camera and the settings, then the frame graph's
	 * passes (`graph.execute`). */
	render( frame: PipelineFrame ): void {

		const camera = frame.camera;
		const u = this.u;
		// the P the last reading asks for, before the rests read the epoch it may bump
		preExposure.beginFrame();
		camera.updateMatrixWorld();
		u.projInv.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		u.cameraWorld.value.copy( camera.matrixWorld );
		u.proj.value.copy( camera.projectionMatrix );
		u.view.value.copy( camera.matrixWorldInverse );
		// the resolve takes the opaque scene's depth while the shade over the whole scene is on
		// (MeadowShade.ts `SS_SHADOW`, `flags.ssShadow`)
		screenShadowView.opaque.value = SS_SHADOW && debugFlags.ssShadow !== false ? 1 : 0;
		if ( frame.keyDirection ) u.keyView.value.copy( frame.keyDirection );
		else u.keyView.value.copy( frame.sun.position ).sub( frame.sun.target.position );
		u.keyView.value.transformDirection( camera.matrixWorldInverse );
		if ( GTAO ) gtaoProjection( camera, gtaoView.proj.value );
		if ( TEMPORAL ) {

			// this frame's rest (which picks the rest's jitter), jitter and motion, from the camera as
			// it is (unjittered)
			this.temporal?.beginFrame( camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.temporal );
			this.fsr3?.beginFrame( camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.temporal );
			jitter.prepare( camera, this.width, this.height, this.outputWidth / this.width, this.outputWidth );
			beginMotionFrame( camera );
			// (FSR's plan after the cuts, from this frame's jitter)
			this.fsr3?.prepareFrame( camera as THREE.PerspectiveCamera, this.width, this.height, this.outputWidth, this.outputHeight );
			if ( this.temporal ) {

				// (after a cut or a resize the previous frame's nearest surface is gone)
				this.temporal.setPreviousDepthValid( this.graph.historyValid( this.resources.surfaceDepthPrev! ) );
				this.temporal.upscaling = this.upscaling;

			}

		}
		if ( frame.settle ) this.settled.observe( camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.settle, this.resolver?.rest ?? null );
		// (what the frame draws from, its epoch without the pre-exposure's own bumps, and whether the
		// page waits for nothing but the pre-exposure: its readings end `pending` only from a frame of
		// the settled view, PreExposure.ts)
		preExposure.viewFrame( restKey( this.viewKey, camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.settle?.signature ?? [], restEpoch.value - preExposure.changes ),
			frame.settle !== undefined && this.settled.sceneQuiet, this.settled.settle );
		const projection = TEMPORAL ? jitter.uniforms.unjitteredProjection.value : camera.projectionMatrix;
		this.air.update( camera, projection, this.width, this.height, this.outputWidth, this.outputHeight, frame.haze ?? { time: frame.time, signature: [], stable: false } );
		this.shafts.update( camera as THREE.PerspectiveCamera, this.air.seaLevelExtinction, this.air.transmittance( camera.position.y, this.shafts.flareDirection ), projection );
		this.updateDisplay( frame );
		this.u.afterOn.value = frame.afterScene !== undefined ? 1 : 0;
		this.u.layerOn.value = this.layerRuns( frame ) ? 1 : 0;
		this.graph.execute( frame );
		// The exposure this frame ended with, read back for the next pre-exposure (PreExposure.ts),
		// and in debug builds whether it has reached its target, for the settled signal. (The copy is
		// queued after this frame's passes, so the reading is this frame's, made at its P.)
		if ( ! this.exposureReading ) {

			this.exposureReading = true;
			const ticket = preExposure.ticket(), settle = frame.settle !== undefined;
			this.readExposure().then( ( e ) => {

				preExposure.observe( ticket, e.ev );
				if ( settle ) this.exposurePending = Math.abs( e.ev - e.target ) > 0.01;

			}, () => {} ).finally( () => { this.exposureReading = false; } );

		}

	}

	/** Sets `changes` over the first table's grade and fills the table anew (GradeLut.ts); the
	 * caller raises the scene event (main.ts `setGrade`, the GUI's). */
	setGrade( changes: GradeChanges = {} ): void {

		mergeGrade( this.grade, changes );
		fillGradeLut( this.grade, SHOWN_GREY, this.luts[ 0 ].value as THREE.Data3DTexture );

	}

	/** Compiles the haze's shadow kernels, which read the ambient probes' sky visibility: main.ts
	 * calls it once it has installed the ambient volume (lighting/AmbientSample.ts), and the loop
	 * waits for it with the warm-up. Registered as kernels of the opaque pass, they compile at once
	 * (the warm-up has started by then). */
	compileHazeShadow(): Promise<void> {

		return this.graph.latent( 'opaque', [], this.air.shadowKernels );

	}

	/** Where the frame's linear scene radiance lies, for its readout (debug/Radiance.ts): `opaque`,
	 * the resolved opaque colour (the lit surfaces and the sky before the sea, the haze and the post
	 * chain; at 4x the samples' box resolve), or `hdr`, the composite's output (the sea and the air
	 * over them, before the bloom and the display chain; null where the composite does not run once,
	 * `post=legacy`). Both are stored to the frame's end, which their later readers need. Also
	 * `meterLight`, the metering illuminance (at 4x resolved and stored while a pass reads it:
	 * the metering histograms, or the debug view, `fgview=meterLight`), and `surfaceDepth`, the nearest surface's view z
	 * (below -9e4: sky), which tells the sky's pixels apart, and `sharp`, the composite with the
	 * bloom added (before the local tone, the tone curve and the grade). */
	radianceSource( source: 'opaque' | 'hdr' | 'sharp' | 'meterLight' | 'surfaceDepth' ): { target: THREE.RenderTarget; index: number } | null {

		const r = this.resources;
		const h = source === 'opaque' ? r.opaqueColor : source === 'hdr' ? r.hdr : source === 'sharp' ? r.sharp : source === 'meterLight' ? r.meterLight : r.surfaceDepth;
		if ( ! h ) return null;
		const target = this.graph.target( h );
		return { target, index: target.textures.indexOf( this.graph.texture( h ) ) };

	}

	/** The exposure state as the last frame left it (Metering.ts, Exposure.ts), read back: the
	 * exposure EV and the target EV_t (stops), EV's velocity (stops per second), `moved` (1 where
	 * that frame's EV differed from the frame's before), and the factor 2^EV that brings scene
	 * radiance to the exposed image (hdr, pre-exposed, takes 2^( EV - P ): PreExposure.ts). */
	async readExposure(): Promise<{ ev: number; velocity: number; target: number; moved: number; exposure: number }> {

		const target = this.graph.target( this.resources.exposureState );
		const index = target.textures.indexOf( this.graph.texture( this.resources.exposureState ) );
		const px = await this.renderer.readRenderTargetPixelsAsync( target, 0, 0, 1, 1, index ) as Float32Array;
		return { ev: px[ 0 ], velocity: px[ 1 ], target: px[ 2 ], moved: px[ 3 ], exposure: 2 ** px[ 0 ] };

	}

	// The display chain's and the canvas pass's uniforms from the settings (the exposure's keys and
	// offset, the grade, the dither).
	private updateDisplay( { time }: PipelineFrame ): void {

		const S = this.settings;
		const u = this.u;
		// the night's weight for the display (the tone, the grade, the bloom) and the exposure's own
		// for its keys (sky/DayCycle.ts `displayNight`, `exposureNight`), each of which a debug page
		// may force (`duskForce`)
		const night = duskForce( 'displayNight', S.night ), exposureNight = duskForce( 'exposureNight', S.exposureNight );
		u.tone.value = S.tone; u.night.value = night; u.lut.value = S.lut;
		u.vignette.value = S.vignette;
		u.ditherOn.value = this.upscaling ? 0 : 1;
		// the clouded day's share: the cloudy and overcast skies' (DayKeys.ts `cloudy`)
		const cloud = cloudedShare( S.skyMix );
		this.localTone?.update( this.sky.elevation, night, cloud );
		this.bloom.update( this.sky.elevation, night, cloud );
		const ex = exposureKeys( this.sky.elevation, exposureNight, S.skyMix, this.exposureKeys, this.sky.rising ), mu = this.metering.uniforms;
		mu.key.value = ex.key; mu.highlight.value = ex.highlight; mu.skyShare.value = ex.sky; mu.offset.value = S.exposureOffset;
		// the adaptation's step: the scene clock's, once per rendered frame; a paused clock (and the
		// test mode, a paused page), a reset or a lost history take the target at once
		const dt = this.exposureTime === null ? 0 : time - this.exposureTime;
		this.exposureTime = time;
		// (a stepped clip snaps every frame: Exposure.ts, capture-clip.mjs)
		const clip = ( globalThis as { __PONLAI_CLIP__?: unknown } ).__PONLAI_CLIP__ != null;
		const reset = this.exposureReset || clip || dt <= 0 || ! this.graph.historyValid( this.resources.exposureStatePrev );
		this.exposureReset = false;
		mu.snap.value = reset ? 1 : 0;
		mu.dt.value = reset ? 0 : dt;
		mu.up.value = ex.adaptUp; mu.down.value = ex.adaptDown;
		u.bloom.value = S.bloom * ( 1 + S.tone * 0.5 ) * ( 1 + night * NIGHT.bloom );
		const shade = keyed( SHADE_CONTRAST, this.sky.elevation, night, this.shade, cloud );
		u.shadePivot.value = 0.18 * 2 ** shade.pivot; u.shadeSlope.value = shade.slope;
		const desaturation = keyed( DESATURATION, this.sky.elevation, night, this.desaturation, cloud, this.sky.rising );
		u.desaturate.value = desaturation.amount; u.desaturateCool.value = desaturation.cool;
		u.purkinje.value = night * PURKINJE.strength;
		const keyColor = this.sky.keyColor;
		u.purkinjeKey.value = ( 0.2126 * keyColor.r + 0.7152 * keyColor.g + 0.0722 * keyColor.b ) * liftedKeyHeight( this.sky.keyDir, this.sky.keyIsMoon ) / Math.PI;
		// the day's and the clouded white (DayKeys.ts `keyed`, without the night), overcast's
		// (WHITE_OVERCAST) over them by overcast's share, then the night's over all by the night's
		// weight, as `keyed` blends it: under no overcast the white is `keyed`'s to the bit
		const white = keyed( WHITE_BALANCE, this.sky.elevation, 0, this.white, cloud, this.sky.rising );
		const overcast = S.skyMix[ 3 ] ?? 0, atNight = WHITE_BALANCE.night!;
		for ( const k of [ 'r', 'g', 'b' ] as const ) {

			const v = white[ k ] + ( WHITE_OVERCAST[ k ] - white[ k ] ) * overcast;
			white[ k ] = v + ( atNight[ k ] - v ) * night;

		}
		u.highlightShare.value = overcast * ( 1 - night );
		const { r, g, b } = white;
		if ( r !== this.toneWhite[ 0 ] || g !== this.toneWhite[ 1 ] || b !== this.toneWhite[ 2 ] ) {

			this.toneWhite = [ r, g, b ];
			u.balance.value.copy( whiteBalance( [ r, g, b ] ) );
			u.toneIn.value.copy( TONE_SPACE.input ).multiply( u.balance.value );

		}
		const C = S.curve;
		const key = `${ C.toe } ${ C.mid } ${ C.white }`;
		if ( key !== this.toneCurveKey ) {

			this.toneCurveKey = key;
			const k = solveToneCurve( C );
			// a set the solve cannot meet (a pole or a fold in range: settings far from the
			// default, as the GUI can reach) keeps the last good curve; the default must pass
			const failed = checkToneCurve( k, C.white );
			if ( failed && DEV && key === `${ TONE_CURVE.toe } ${ TONE_CURVE.mid } ${ TONE_CURVE.white }` ) throw new Error( `tone curve ${ key }: ${ failed }` );
			if ( failed ) console.warn( `tone curve ${ key }: ${ failed }; the last good curve stays` );
			else {

				u.toneNum.value.set( k[ 0 ], k[ 1 ], k[ 2 ] );
				u.toneDen.value.set( k[ 3 ], k[ 4 ], k[ 5 ] );

			}

		}

	}

}
