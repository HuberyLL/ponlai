/*!
 * Portions adapted from tidewater by Daniel Greenheck (https://github.com/dgreenheck/tidewater).
 * Copyright (c) 2026 DRG Software Solutions LLC
 * Licensed under the MIT License; see ./tidewater.LICENSE.txt.
 */

import * as THREE from 'three/webgpu';
import {
	Fn, If, texture, textureLoad, uniform, uv, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, dot, length, sin, log2, exp2, floor, luminance,
	sRGBTransferOETF, fract, pow, mrt, outputStruct, mat4, output, acesFilmicToneMapping, atan, cos, abs, select, mod, step, Discard,
	Loop, normalize, refract,
} from 'three/tsl';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';
import { AerialPerspective, DEFAULT_AIR_OPTIONS, type AirOptions } from '../weather/AerialPerspective.ts';
import { LightShafts } from './LightShafts.ts';
import { FSR } from './FSR.ts';
import { PhysicalBloom } from './PhysicalBloom.ts';
import { AA_MODE, AFTER_RESOLVE, FSR3, RESOLVE, SCENE_SAMPLES, TEMPORAL } from './Antialiasing.ts';
import { beginMotionFrame, onTaaCut, overlayMRT, sceneMRT } from './Motion.ts';
import { RAIN_OVERLAY, afterMRT } from './AfterResolve.ts';
import { jitter } from './Jitter.ts';
import { TemporalAA, type TemporalFrame, type TemporalMode } from './TemporalAA.ts';
import { Settled, type SettleFrame } from './Settled.ts';
import { Fsr3Upscaler } from './fsr3/Fsr3Upscaler.ts';
import { QUALITY, type TemporalSettings } from '../Quality.ts';
import { FrameGraph, type ResourceHandle, type SizeClass } from './graph/FrameGraph.ts';
import type { Sky } from '../sky/Sky.ts';
import { DAY_EXPOSURE } from '../sky/DayCycle.ts';
import type { Rain } from '../weather/Rain.ts';
import { CLIP_MARGIN, RefractionView, REFRACTION_GUARD, REFRACTION_SIZE } from '../ocean/Refraction.ts';
import { debugFlags } from '../debug/DebugFlags.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA, SCENE_SAMPLES, half float, multisampled depth)
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
//   surface resolve ── surfaceRT (view-space z of the nearest surface, the sea's included)
//   rain ── into sceneRT (its multisampled colour and depth are then discarded: nothing reads them;
//     without rain the water discards the colour and the surface resolve's read keeps the depth)
//   sea fog (in fog: the bank noise baked into a map, the march at half resolution)
//   light shafts: the open sky near the sun, the rays marched toward it (half resolution, while the
//   sun faces the view)
//   constants: what the composite takes that is the same for every pixel (the horizon's average,
//   the sun disk's visibility), evaluated once into a texel
//   composite (air, fog, rain veil, shafts) ── hdr, once (the veil after the resolve under taa, taau)
//   bloom: tidewater's physical bloom from hdr (PhysicalBloom.ts: five 13-tap downsamples, four tent
//   upsamples)
//   sharp (hdr + the bloom at its strength)
//   display: the exposure, tidewater's grade (a white balance nudge,
//   saturation, the night's grade, the tone, contrast round mid grey, the vignette), ACES, sRGB,
//   grain ── displayRT
//   ── copied to the screen
// Under the temporal modes (Antialiasing.ts: aa=taa|taau) the scene half is single-sampled and
// jittered, and writes the motion vectors beside the colour:
//   opaque scene ── sceneColor and velocity (an MRT: Motion.ts's sceneMRT), sceneDepth
//   depth resolve ── depthRT (sample 0 twice: one sample)
//   underwater pyramid, refraction reach and mask ── as above, jittered with the scene
//   refraction ── as above, jittered with the scene
//   water ── sceneColor and velocity (sceneMRT), depth-tested against the opaque depth
//   surface resolve ── surfaceRT, copied at the frame's end into surfaceDepthPrev (the next
//     frame's history of the nearest surface)
//   overlay (the ground truth: taa and taau draw these after the resolve) ── the rain and the
//     storm's spray (moved from the water's scene) over the scene, with Motion.ts's overlayMRT: the
//     velocity under them kept
// and the post passes follow as above, but for the vignette and the grain, which the display pass
// leaves to the canvas pass, and (accumulating in linear light, Quality.ts `taa.linear`) for the
// sRGB transfer: displayRT holds the graded colour in linear light (half float),
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
//     RCAS, the rain layer added, grain and dither; TAA below the canvas encodes it at the render's
//     size (taaDisplay), EASU, then RCAS, the rain layer and the grain
// (`taaResolve=off`, debug builds: the jittered frame shown as it is, through the output passes
// above, with the grade's vignette and grain, as before the resolve landed).
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
//   display ── at the canvas's size, the full grade with vignette, ACES, sRGB, grain and dither
//     (half float), copied to the canvas by the output pass
// The rain veil's per-pixel reactive weight (veilReactive, R16F at the render's size) is a resource
// of its own the resolve reads: under the resolve the composite pass writes it as a second target
// beside hdr, the veil's opacity at the pixel (Rain.veil) x 1.5, at most 0.6, so the resolve trusts
// its history less only where the veil is dense, and the meadow beside it keeps its history. (The
// legacy inline composite, `post=` without compositeOnce, leaves it at zero.) Under taa and taau the
// veil is drawn after the resolve instead (AfterResolve.ts) and the composite writes, in place of
// veilReactive, the air's transmittance (rainAir, R16F at the render's size), which it hands over:
// the composite is affine in the scene colour at a pixel, hdr = A scene + B, so the streaks drawn
// after the resolve take the air, fog and shafts of what lies behind them as they did drawn before
// the composite.
// Every pass runs at the scene's render size or a share of it. When the canvas is larger (a quality
// preset below the display's resolution), displayRT goes through FSR 1 (edge-adaptive upsampling,
// then contrast-adaptive sharpening) to the screen instead, and the grain is added there, at
// display pixels.
// The targets are the frame graph's (graph/FrameGraph.ts): each is declared with its format,
// sample count and size class (the render, a share of it, the canvas or fixed), and the graph sizes
// them all from `setSize`'s render and canvas sizes. The passes read their sizes from the graph's
// extent uniforms.
// The graph runs the whole frame as passes that declare what they read and write: the scene half
// (opaque, the depth and copy resolves, water, the surface resolve, rain), the sea fog (its bank
// map, nearest depth and march), the light shafts' two passes, the composite's constants, the
// composite, the bloom (PhysicalBloom.ts: a pass per level), the sharp image, the display pass,
// and the canvas pass, or EASU and the sharpening canvas pass while upscaling. Every pass but the
// scene passes and the canvas passes is a full-screen quad of its own, and no pass renders another
// inside it (but three's FSR1Node, `post=three-fsr`, in its canvas pass). Each pass that runs only
// now and then (rain, fog, the light shafts, either output) says when by a predicate the graph
// evaluates at the frame's start. A pass whose output weighs nothing in what reads it (the shafts
// without the sun toward the view) is skipped rather than drawn and multiplied by 0; its reader
// reads it optionally and gets what it last held, finite, times 0. The `post=` legacy switches
// are variants of the graph, chosen as it is built.
// At startup the graph's warm-up (`graph.warm`, from main.ts) compiles every pass, so one that
// first runs later (fog, the upscale) builds nothing then.

//
// Rules (the look itself is in docs/art-direction.md):
// - Sizes are owned by the graph (graph/FrameGraph.ts): it sizes every target by its size class
//   from `setSize` (the render; a share of it: the sea fog's reduced targets, the shafts' halves; the canvas: FSR's EASU target; fixed: the fog's bank map), and every pass reads
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
// - `render` is `graph.execute`: the sea fog's bank, depth and march and the
//   output and FSR passes are graph passes too (the `post=` switches choose which are declared at
//   load), so new frame work goes in as a pass, not as a call around the graph. A pass that
//   declares no depth clears whatever depth its target holds outside the graph (the canvas's, and
//   the targets three's nodes draw into inside a pass), as three's defaults do; declare the depth
//   to keep it.
// - The water cannot sample the target it draws into: it reads `opaqueRT` and `depthRT` (sample 0,
//   and the farthest sample for what lies behind the sea at an edge pixel), and the underwater
//   pyramid (`textures.underwater`). Post passes read
//   `surfaceRT`, the nearest surface's depth with the sea's included. Multisampled depth is read
//   with `textureLoad`, one sample at a time (the sample index in its level argument);
//   single-sampled, that argument is a mip level, so load sample 0 only. View z below -9e4 is sky.
// - In a full-screen pass the camera nodes are the pass's own camera: the scene camera's matrices
//   come in as uniforms.
// - The display chain is tidewater's (ACES_EXPOSURE): one curve and grade, with a light tone
//   (TONE) and the night's grade (NIGHT) over it. The day and the night differ by the exposure,
//   from the clock and the weather (DayCycle, Sky), calibrated against tidewater's metered frames,
//   and by that night grade.

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
const CANVAS: SizeClass = { of: 'canvas' };
// what the water pass draws in a frame without water: nothing
const NO_WATER = new THREE.Scene();

// The refraction pass's only attachment, cleared to zero coverage (alpha 0: nothing drawn there).
const REFRACTION_MRT: THREE.MRTNode = mrt( { refraction: output } ).setClearColor( 'refraction', new THREE.Color( 0, 0, 0 ), 0 );

/** What a frame draws (`Pipeline.render`'s argument). `rainScene`: the rain, while it shows (under the
 * temporal modes with the storm's spray in it, but for what draws after the resolve: see `overlay`).
 * `overlay`: whether the temporal modes' overlay pass draws `rainScene` this frame (rain or spray
 * showing; not under taa and taau). `afterScene`: under taa and taau, the rain (streaks, splashes,
 * rings) and the storm's spray, drawn after the resolve (AfterResolve.ts), while either shows. */
export interface PipelineFrame {
	scene: THREE.Scene; waterScene: THREE.Scene; rainScene?: THREE.Scene; overlay?: boolean; afterScene?: THREE.Scene; camera: THREE.Camera;
	water: { prepare( sun: THREE.DirectionalLight ): void } | null; sun: THREE.DirectionalLight; time: number;
	// the temporal resolve's per-frame inputs from the page (the rest's signature and stability, the
	// frame's delta)
	temporal?: TemporalFrame;
	// the settled signal's per-frame inputs (Settled.ts; debug builds): left out, it is not observed
	settle?: SettleFrame;
}

/** The frame graph's structural choices, fixed when the page loads (the quality tier sets them;
 * the defaults are today's high). `?post=legacy` restores the graph before they were introduced,
 * for A/B timing; `?post=` also takes a comma list of single switches (see `postOptionsFromURL`). */
export interface PostOptions extends AirOptions {
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
	...DEFAULT_AIR_OPTIONS, compositeOnce: true, fsrPort: true, discardScene: true,
};

const LEGACY_SWITCHES: Record<string, Partial<PostOptions>> = {
	'inline-composite': { compositeOnce: false },
	'full-fog': { fogScale: 1 },
	'no-bank': { bankSize: 0 },
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

// tidewater's display chain (PostFX.js, 4811ba4): its physical bloom (PhysicalBloom.ts) added to
// the image; its grade in linear light (a white balance nudge, saturation, contrast round mid grey,
// the vignette); ACES at its exposure setting (ACES_EXPOSURE: three's fitted curve, as tidewater's
// renderOutput) and the sRGB transfer; its luminance-weighted grain, and a dither. tidewater meters
// its frame and scales it by an auto exposure before the grade; here the scene is scaled by the
// clock's and the weather's exposure (`settings.exposure`: DayCycle and Sky, so a paused frame
// repeats), calibrated against tidewater's metered frames at the same sun heights (DayCycle.ts).
const ACES_EXPOSURE = 0.55;

export interface PipelineSettings {
	// the scene's exposure: scene radiance (over SCENE_RADIANCE_SCALE) into the frame the grade takes
	exposure: number;
	// tidewater's grade: the bloom's strength, the white balance nudge (red up and blue down by it),
	// the saturation and the contrast round mid grey, the vignette and the grain
	bloom: number; warmth: number; saturation: number; contrast: number; vignette: number; grain: number;
	// the light's tone over tidewater's grade (0 none, 1 full): lights a touch golden, the shade a
	// touch teal, the contrast round mid grey softer and the bloom a little stronger
	tone: number;
	// 0 by day, 1 at night (from the clock, main.ts): how far the night's grade has come in (NIGHT)
	night: number;
	// 0 with a high sun, 1 with a low one (Sky.ts lowSun, main.ts): how warm the tone's lights turn
	// (LOW_SUN)
	low: number;
}

// The light's tone over tidewater's grade (docs/art-direction.md, Light): a photographic image
// pushed a little toward a painted one. Lights turn a touch golden and the shade a touch teal (by
// the exposed luminance, so the night takes it as the day), the contrast round mid grey softens by
// a tenth and the bloom strengthens by a quarter. It lifts no black: a constant fill in the grade
// greyed everything below mid grey alike and veiled the frame; the shade's openness comes from the
// sky light the island takes instead (Sky.ts DAY_SHADE). 0.5 of the full step was chosen over 0
// and 1 by eye.
const TONE = 0.5;

// The low sun's light (art direction: a low sun's light golden, its shade blue-violet): as the sun
// sinks below 12 degrees (Sky.ts lowSun) what it lights turns a deeper gold toward orange, from the
// midtones up (`from`..`to` of the exposed luminance: the tone's own split, from 0.04 to 0.9, left
// the sunlit meadow, a midtone, nearly untouched), keeping the luminance. The shade's blue-violet
// is the sky light the island takes (Sky.ts LOW_SUN), so the sea and the sky keep their own.
const LOW_SUN = { warm: [ 1.2, 1.0, 0.72 ] as const, from: 0.015, to: 0.2 };
const LOW_SUN_WARM = ( () => {

	const [ r, g, b ] = LOW_SUN.warm, l = r * 0.2126 + g * 0.7152 + b * 0.0722;
	return new THREE.Vector3( r / l, g / l, b / l );

} )();

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
const NIGHT = { greenTurn: 0.4, tint: [ 0.84, 0.96, 1.16 ] as const, amount: 0.3, bloom: 1.5 };
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

/** tidewater's grade (PostFX.js `PostParams`). */
export const TIDEWATER_GRADE: Readonly<Pick<PipelineSettings, 'bloom' | 'warmth' | 'saturation' | 'contrast' | 'vignette' | 'grain'>> = {
	bloom: 0.05, warmth: 0.02, saturation: 1.06, contrast: 1.04, vignette: 0.28, grain: 0.012,
};

export class Pipeline {

	renderer: THREE.WebGPURenderer;
	width = 1;
	height = 1;
	settings: PipelineSettings = {
		exposure: DAY_EXPOSURE, ...TIDEWATER_GRADE, tone: TONE, night: 0, low: 0,
	};

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
		underwater: ResourceHandle; refractionReach: ResourceHandle; refraction: ResourceHandle; refractionDepth: ResourceHandle;
		surfaceDepth: ResourceHandle; velocity: ResourceHandle | null; surfaceDepthPrev: ResourceHandle | null; veilReactive: ResourceHandle | null;
		rainAir: ResourceHandle | null; rainOverlay: ResourceHandle | null; rainLayer: ResourceHandle | null; rainInput: ResourceHandle | null; rainBehind: ResourceHandle | null; rainGrade: ResourceHandle | null;
		hdr: ResourceHandle | null; sharp: ResourceHandle; display: ResourceHandle;
		easu: ResourceHandle | null; canvas: ResourceHandle;
	};
	readonly air: AerialPerspective;
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
	// (msaa, off and the temporal modes with `taaResolve=off`: the resolve has a canvas pass of its own)
	private output: THREE.RenderPipeline | null = null;
	// FSR.ts's sharpening canvas pass after EASU (the fsrPort option), or three's FSR1Node (post=three-fsr)
	private upscaledOutput: THREE.RenderPipeline | null = null;
	private upscaledOutputThree: THREE.RenderPipeline | null = null;
	private fsr: FSR | null = null;
	// the composite of the air, fog, rain veil and shafts over the scene, into hdr (the
	// compositeOnce option)
	private compositeQuad: THREE.QuadMesh | null = null;
	// the composite's per-frame constants, into a texel (`postConstants`)
	private constants = {} as { quad: THREE.QuadMesh; output: ResourceHandle };
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
	private u = {
		// the scene's exposure (scene radiance into the frame the grade takes) and tidewater's grade
		exposure: uniform( 1 ), bloom: uniform( TIDEWATER_GRADE.bloom ), warmth: uniform( 0 ), saturation: uniform( 1 ), contrast: uniform( 1 ), tone: uniform( 0 ), night: uniform( 0 ), low: uniform( 0 ),
		vignette: uniform( 0.3 ), grain: uniform( 0.01 ), time: uniform( 0 ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ), cameraWorld: uniform( new THREE.Matrix4() ),
		proj: uniform( new THREE.Matrix4() ), view: uniform( new THREE.Matrix4() ),
		grainOn: uniform( 1 ),
		// 1 while the after pass draws (AfterResolve.ts): else its overlay holds an earlier frame's;
		// and while the rain's layer pass runs
		afterOn: uniform( 0 ), layerOn: uniform( 0 ),
	};


	/** `temporal`: the tier's resolve settings (Quality.ts `taa`), for the temporal modes. */
	constructor( renderer: THREE.WebGPURenderer, sky: Sky, rain?: Rain, options: Partial<PostOptions> = postOptionsFromURL(), temporal?: TemporalSettings ) {

		this.renderer = renderer;
		this.rain = rain;
		this.options = { ...DEFAULT_POST_OPTIONS, ...options };
		this.settled.settle = ( temporal ?? QUALITY.high.taa ).restSettle;
		const O = this.options;
		this.air = new AerialPerspective( O );
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
		this.resources = { sceneColor, sceneDepth, linearDepth, opaqueColor, underwater, refractionReach, refraction, refractionDepth, surfaceDepth, velocity, surfaceDepthPrev, veilReactive, rainAir, rainOverlay, rainLayer, rainInput, rainBehind, rainGrade, hdr, sharp, display, easu, canvas };
		// the targets the frame draws into, made now (the probes, the warm-ups and the water's
		// textures need them before the first frame)
		g.renderTarget( velocity ? [ sceneColor, velocity ] : [ sceneColor ], sceneDepth );
		for ( const h of [ linearDepth, opaqueColor, underwater, refractionReach, display ] ) g.renderTarget( [ h ] );
		g.renderTarget( [ refraction ], refractionDepth );
		g.renderTarget( [ surfaceDepth ] );
		this.textures = {
			opaqueColor: g.texture( opaqueColor ), linearDepth: g.texture( linearDepth ), surfaceDepth: g.texture( surfaceDepth ),
			underwater: g.texture( underwater ), refraction: g.texture( refraction ), refractionDepth: g.texture( refractionDepth ),
		};
		// the sizes the passes read, the graph's shared extent uniforms (set with the targets' own
		// sizes): the render's and the canvas's
		const renderSize = g.extent( RENDER ), canvasSize = g.extent( CANVAS );
		const u = this.u;
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
		// the nearest surface's view z
		const surfaceMat = new THREE.NodeMaterial();
		surfaceMat.fragmentNode = Fn( () => vec4( viewZ( screenCoordinate.xy, depthSample( screenCoordinate.xy, 0 ) ) ) )();
		this.surfaceQuad = new THREE.QuadMesh( surfaceMat );

		// ---- composite: the scene target holds the opaque image with the sea and the rain drawn over it
		const sceneTex = texture( g.texture( sceneColor ) );
		const tSurfaceDepth = this.textures.surfaceDepth;
		// (the air's alpha: the rain veil's opacity, for the resolve's veilReactive; after the resolve,
		// where the veil is drawn, the air's transmittance)
		const veil = rain && ! AFTER_RESOLVE ? ( d: V3, distance: F, background: V3 ) => rain.veil( d, distance, background ) : undefined;
		// What the composite takes that is the same for every pixel of a frame, evaluated once into
		// a texel by a pass of its own and loaded there: the horizon's average colour the air takes
		// looking down (rgb: four panorama samples) and the sun disk's unobstructed fraction for the
		// glare (a: five samples of the shafts' source). In full float, so the composite gets exactly
		// the values it computed itself.
		const constants = this.constants.output = g.color( 'postConstants', { size: { of: 'fixed', width: 1, height: 1 }, format: THREE.RGBAFormat, type: THREE.FloatType } );
		const constant = textureLoad( texture( g.texture( constants ) ), ivec2( 0 ) ) as unknown as THREE.Node<'vec4'>;
		const aired = this.air.apply( sceneTex.rgb, tSurfaceDepth, sky, g, rainAir ? ( _d, _distance, background, transmittance ) => vec4( background, transmittance ) : veil, constant.rgb );
		const shafts = this.shafts.build( tSurfaceDepth, sky, g, constant.a );
		const constantsMat = new THREE.NodeMaterial();
		constantsMat.name = 'Post.Constants';
		constantsMat.fragmentNode = vec4( this.air.around( sky ), this.shafts.visibility() );
		this.constants.quad = new THREE.QuadMesh( constantsMat );
		this.constants.quad.name = 'Post.Constants';
		const composited = aired.rgb.add( shafts );
		// Rendered once (the composite pass, into hdr), the composite feeds the sharp image and both
		// blooms' high passes; as an expression each of them evaluated it again, the sea fog's march
		// included. The high passes run at half resolution and sample it bilinearly, as they sampled
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
			// the air, fog and shafts add), so a streak drawn after the resolve takes the air of what
			// lies behind it as it would have here (AfterResolve.ts).
			if ( rainAir ) compositeMat.fragmentNode = outputStruct( vec4( composited, 1 ), vec4( aired.a ) );
			this.compositeQuad = new THREE.QuadMesh( compositeMat );
			this.compositeQuad.name = 'Post.Composite';
			// (with the uv rtt() gave its texture: a texture() without one transforms it)
			// Under fsr3 what follows the composite reads FSR's output instead (Fsr3Upscaler.ts: its
			// passes take hdr, declared after the composite pass).
			if ( FSR3 ) ( this as { fsr3: Fsr3Upscaler | null } ).fsr3 = new Fsr3Upscaler( renderer, g as unknown as FrameGraph<unknown>, {
				hdr, surfaceDepth, velocity: velocity!, veilReactive, sceneColor, opaqueColor,
			}, { settings: temporal ?? QUALITY.high.taa, exposure: u.exposure.mul( ACES_EXPOSURE / 0.6 ), debugView: DEV && new URLSearchParams( globalThis.location?.search ?? '' ).has( 'fsrDebug' ) } );
			tHdr = this.fsr3 ? this.fsr3.source( uv() ) : texture( g.texture( hdr ), uv() );

		}
		const hdrColor: V3 = tHdr ? tHdr.rgb : composited;

		// ---- tidewater's physical bloom (PhysicalBloom.ts): from hdr (under fsr3 FSR's output), or the
		// scene's colour where the composite is evaluated inline (`post=inline-composite`), added to
		// the image at its strength
		const bloom = this.bloom = new PhysicalBloom( g, tHdr ?? sceneTex, tHdr && FSR3 ? CANVAS : RENDER, u.exposure );
		const withBloom = hdrColor.add( texture( bloom.output(), uv() ).rgb.mul( u.bloom ) );

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

		// ---- tidewater's grade, to display values (see ACES_EXPOSURE): the scene at the exposure, the
		// white balance nudge, saturation and contrast round mid grey in linear light, the vignette
		// (the resolve leaves it to the canvas pass, after the accumulation), ACES and the sRGB
		// transfer (`encode` false: the graded colour in linear light, before the transfer).
		// the vignette's factor at the pixel being drawn (tidewater's: elliptical in the frame's own
		// uv, soft; the same into an image of any size)
		const vignetteAt = ( _size: THREE.UniformNode<'vec2', THREE.Vector2> ) => float( 1 ).sub( smoothstep( 0.25, 0.75, length( uv().sub( 0.5 ).mul( vec2( 1, 0.8 ) ) ) ).mul( u.vignette ) );
		const grade = ( lin: V3, vignette: boolean, encode: boolean ): V3 => {

			const c = lin.mul( u.exposure ).mul( vec3( u.warmth.add( 1 ), 1, float( 1 ).sub( u.warmth ) ) ).toVar();
			c.assign( mix( vec3( luminance( c ) ), c, u.saturation ) );
			// the night's grade (NIGHT): the greens turned toward blue-green, a silver-blue tint
			If( u.night.greaterThan( 0.001 ), () => {

				c.assign( nightGreenTurn( c, u.night.mul( NIGHT.greenTurn ) ) );
				c.mulAssign( mix( vec3( 1 ), vec3( NIGHT_TINT ), u.night.mul( NIGHT.amount ) ) );

			} );
			// the tone (TONE): lights a touch golden and the shade a touch teal, the contrast round mid
			// grey softer
			const lights = smoothstep( 0.04, 0.9, luminance( c ) );
			c.mulAssign( mix( vec3( 0.95, 1.0, 1.04 ), vec3( 1.06, 1.0, 0.9 ), lights ).sub( 1 ).mul( u.tone ).add( 1 ) );
			// the low sun's warmer light (LOW_SUN)
			c.mulAssign( mix( vec3( 1 ), vec3( LOW_SUN_WARM ), u.low.mul( smoothstep( LOW_SUN.from, LOW_SUN.to, luminance( c ) ) ) ) );
			c.assign( pow( max( c, vec3( 0 ) ).div( 0.18 ), vec3( u.contrast.mul( float( 1 ).sub( u.tone.mul( 0.2 ) ) ) ) ).mul( 0.18 ) );
			if ( vignette ) c.mulAssign( vignetteAt( FSR3 ? canvasSize : renderSize ) );
			const t = ( acesFilmicToneMapping( c, float( ACES_EXPOSURE ) ) as V3 ).toVar();
			return encode ? sRGBTransferOETF( t ) as V3 : t;

		};
		// tidewater's grain (luminance weighted, triangular, new with every step of the scene clock)
		// and a dither, per pixel of the canvas (`on` 0 leaves them out)
		const finish = ( s: V3, size: THREE.UniformNode<'vec2', THREE.Vector2>, on: F ) => {

			const hash = ( p: THREE.Node<'vec2'> ) => fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			const px = uv().mul( size ).toVar();
			const seed = px.add( fract( u.time.mul( 13 ) ).mul( 100 ) ).toVar();
			const n = hash( seed ).add( hash( seed.add( vec2( 79.19, 104.729 ) ) ) ).sub( 1 ).mul( 0.5 );
			If( on.greaterThan( 0.5 ), () => {

				s.addAssign( s.mul( n.mul( u.grain ) ).add( hash( px.mul( 1.37 ) ).sub( 0.5 ).div( 255 ) ) );

			} );
			return vec4( s, 1 );

		};

		// The graded image, at the render's size, always into one float target (the display pass),
		// which the canvas pass copies or upscales: one build of the grade, whatever the output.
		// Float, so the copy below hands the canvas exactly the values a direct draw would. The
		// temporal resolve accumulates it before the vignette, grain and dither, which its canvas
		// pass adds.
		const displayMat = new THREE.NodeMaterial();
		displayMat.name = 'Post.Display';
		displayMat.fragmentNode = Fn( () => finish( grade( sharpAt(), ! RESOLVE, ! LINEAR_DISPLAY ), FSR3 ? canvasSize : renderSize, RESOLVE ? float( 0 ) : u.grainOn ) )();
		this.displayQuad = new THREE.QuadMesh( displayMat );
		this.displayQuad.name = 'Post.Display';

		// At the display's resolution it is copied to the canvas, grain and all.
		const tDisplay = g.texture( display );
		if ( ! RESOLVE ) {

			this.output = new THREE.RenderPipeline( renderer, textureLoad( tDisplay, ivec2( screenCoordinate.xy ) ) );
			this.output.outputColorTransform = false;

		}

		// Below it, FSR 1 (AMD FidelityFX Super Resolution 1, FSR.ts) upscales the image (it expects
		// display values) before the grain, so the grain stays one display pixel fine and is not
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
		// the air's transmittance (A), in `rainInput`; and the light the air, fog and shafts add (B,
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
		// exposure from 2^low to 2^high: below, within a fifth of a level of black; above, burnt to
		// white), baked by a pass of its own while the layer runs (`rainGrade`) and read trilinearly
		// (two bilinear taps). The change is the difference of two
		// readings (with the rain and without), so the table's error cancels to first order; graded in
		// full at every canvas pixel, the grade took a third of the layer's time. The frame that
		// completes the rest grades in full (its layer stands for every paused frame).
		const T = GRADE_TABLE;
		const gradeTableNode = rainGrade ? Fn( () => {

			const p = floor( screenCoordinate.xy ).toVar();
			const b = floor( p.x.div( T.size ) );
			const index = vec3( p.x.sub( b.mul( T.size ) ), p.y, b );
			const lin = exp2( index.div( T.size - 1 ).mul( T.high - T.low ).add( T.low ) ).div( u.exposure );
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
			const c = clamp( log2( max( lin.mul( u.exposure ), vec3( 2 ** T.low ) ) ).sub( T.low ).div( T.high - T.low ), 0, 1 ).mul( T.size - 1 ).toVar();
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

				if ( rain ) veil.rgb.assign( rain.veilLight( this.air.viewRay( uv(), jitter.uniforms.unjitteredProjectionInverse ).direction ).mul( veil.a ) );
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
				if ( table ) out.assign( vec4( gradeTable( full ).sub( gradeTable( before ) ).mul( AFTER_COVERAGE ), 1 ) );
				else {

					const graded = LINEAR_DISPLAY ? ( textureLoad( tAfterDisplay, texel ) as unknown as THREE.Node<'vec4'> ).rgb : grade( before, false, ! LINEAR_DISPLAY );
					out.assign( vec4( grade( full, false, ! LINEAR_DISPLAY ).sub( graded ).mul( AFTER_COVERAGE ), 1 ) );

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
			// air's rays (its fog march and composite) and the shafts' (only the sun's position on
			// screen stays unjittered, from `update`).
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

	// The frame's passes, in order. The scene half draws into the scene's multisampled target and
	// resolves what the water, the rain and the post passes read. Each sample keeps the opaque
	// surface or the sea, whichever is nearer, so silhouettes against the sea are antialiased like
	// the rest of the image. (Drawn into a target of their own, single-sampled, the water had to
	// decide per pixel between the sea and the opaque colour: edges stepped, and the opaque colour
	// at an edge pixel held the sky the sea was not there to cover, a pale outline round everything
	// over the sea.) Rain does not write depth, so surface focus and overlapping translucent streaks
	// are preserved; its splashes compare the resolved depths themselves. The post passes follow,
	// each into a target of the graph's or the canvas.
	private declarePasses(): void {

		const g = this.graph;
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, underwater, surfaceDepth, velocity } = this.resources;
		if ( TEMPORAL ) [ sceneColor, surfaceDepth, velocity, opaqueColor ] = this.declareTemporalScene();
		else {

			g.addPass( 'opaque', 'scene', ( b ) => {

				sceneColor = b.write( sceneColor, { clear: true } );
				sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
				return { label: 'opaque scene', scene: ( f ) => f.scene, camera: ( f ) => f.camera };

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
				sceneDepth = b.depth( sceneDepth, { write: true } );
				return {
					label: 'water', before: ( f ) => f.water?.prepare( f.sun ),
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
				b.depth( sceneDepth, { write: false } );
				return {
					label: 'rain draw', when: ( f ) => f.rainScene !== undefined, whenLabel: 'rainVisible',
					scene: ( f ) => f.rainScene!, camera: ( f ) => f.camera,
				};

			} );

		}
		// the sea fog: its bank map when due, the nearest depth and the reduced march (only while
		// there is fog; the composite reads what they last drew)
		const fogReads = this.air.passes( g, surfaceDepth );
		let { hdr, sharp, display, easu, canvas, veilReactive, rainAir } = this.resources;
		// the light shafts: the open sky near the sun, and the rays marched over it (while the sun is
		// toward the view: the composite weighs them by `facing`, 0 otherwise)
		const shaftReads = this.shafts.passes( g, surfaceDepth );
		// the composite's per-frame constants, into a texel: the horizon's average and the sun disk's
		// visibility (from the shafts' source, skipped with the shafts, when the composite weighs
		// the glare by 0)
		let constants = this.constants.output;
		const constantsQuad = this.constants.quad;
		g.addPass( 'postConstants', 'quad', ( b ) => {

			b.readOptional( shaftReads[ 0 ] );
			constants = b.write( constants );
			return { label: 'composite (air, fog, veil)', quad: constantsQuad };

		} );
		// what the composite reads: the scene (after the rain, which may be skipped), the nearest
		// surface's depth, the sea fog (its passes run only in fog), the light shafts and the
		// constants
		const compositeReads = ( b: PassBuilder ) => {

			b.readOptional( sceneColor );
			b.read( surfaceDepth );
			for ( const h of fogReads ) b.readOptional( h );
			for ( const h of shaftReads ) b.readOptional( h );
			b.read( constants );

		};
		// the composite of the air, fog, veil and shafts, rendered once
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
		// FSR 3 on hdr (Fsr3Upscaler.ts), whose output (or, while the rest's sequence runs, the held copy
		// of the last running frame's) the passes below read in place of hdr
		const fsr3 = this.fsr3 ? this.fsr3.declare( g as unknown as FrameGraph<unknown>, { hdr: hdr!, surfaceDepth, velocity: velocity!, veilReactive, sceneColor, opaqueColor } ) : null;
		const readHdr = ( b: PassBuilder ) => {

			if ( fsr3 ) {

				b.readOptional( fsr3.output );
				b.readOptional( fsr3.held );

			} else b.read( hdr! );

		};
		// tidewater's physical bloom (PhysicalBloom.ts, nine passes): from hdr, or the scene's colour
		// without the composite
		const bloomResult = this.bloom.passes( g, 'bloom', ( b ) => {

			if ( hdr ) readHdr( b );
			else b.readOptional( sceneColor );

		} );
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
		// the grade
		const displayQuad = this.displayQuad;
		g.addPass( 'display', 'quad', ( b ) => {

			b.read( sharp );
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
					b.readOptional( rainInput );
					if ( rainBehind ) b.readOptional( rainBehind );
					b.readOptional( rainOverlay! );
					rainLayer = b.write( rainLayer );
					return { label: 'rain layer', when: ( f ) => this.layerRuns( f ) && ! this.afterHeld() && ! temporal.drawsLayer, whenLabel: 'rain || spray, not held, not inline', quad: layerQuad };

				} );
				return { optional: [ rainLayer, rainOverlay!, rainInput, ...( rainBehind ? [ rainBehind ] : [] ), rainGrade ], required: [ surfaceDepth, display ] };

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
	// (Motion.ts). Returns the scene colour's, the nearest surface's, the velocity's, the view
	// distance's and the opaque copy's last versions.
	private declareTemporalScene(): [ ResourceHandle, ResourceHandle, ResourceHandle, ResourceHandle ] {

		const g = this.graph;
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, surfaceDepth } = this.resources;
		let velocity = this.resources.velocity!;
		g.addPass( 'opaque', 'scene', ( b ) => {

			sceneColor = b.write( sceneColor, { clear: true } );
			velocity = b.write( velocity, { clear: true } );
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
			b.depth( sceneDepth, { write: false } );
			return {
				label: 'overlay', mrt: overlayMRT, jittered: true, when: ( f ) => f.overlay === true && f.rainScene !== undefined, whenLabel: 'rain || spray',
				scene: ( f ) => f.rainScene!, camera: ( f ) => f.camera,
			};

		} );
		// the nearest surface's depth, kept for the next frame (the resolve's; FSR keeps its own)
		if ( this.resources.surfaceDepthPrev ) g.copyToPersistent( surfaceDepth, this.resources.surfaceDepthPrev );
		return [ sceneColor, surfaceDepth, velocity, opaqueColor ];

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
		// every target by its size class (the reduced fog's, the fixed bank map's, the upscale's at
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
		camera.updateMatrixWorld();
		u.projInv.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		u.cameraWorld.value.copy( camera.matrixWorld );
		u.proj.value.copy( camera.projectionMatrix );
		u.view.value.copy( camera.matrixWorldInverse );
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
		this.air.update( camera );
		this.shafts.update( camera as THREE.PerspectiveCamera, this.air.haze.value, this.air.fogTransmittance( camera.position.y, this.shafts.sunDirection ),
			TEMPORAL ? jitter.uniforms.unjitteredProjection.value : camera.projectionMatrix );
		this.updateDisplay( frame );
		this.u.afterOn.value = frame.afterScene !== undefined ? 1 : 0;
		this.u.layerOn.value = this.layerRuns( frame ) ? 1 : 0;
		this.graph.execute( frame );

	}

	// The display chain's and the canvas pass's uniforms from the settings (the exposure, the grade,
	// the grain).
	private updateDisplay( { time }: PipelineFrame ): void {

		const S = this.settings;
		const u = this.u;
		u.exposure.value = S.exposure / SCENE_RADIANCE_SCALE;
		u.bloom.value = S.bloom * ( 1 + S.tone * 0.5 ) * ( 1 + S.night * NIGHT.bloom ); u.tone.value = S.tone; u.night.value = S.night; u.low.value = S.low; u.warmth.value = S.warmth; u.saturation.value = S.saturation; u.contrast.value = S.contrast;
		u.vignette.value = S.vignette; u.grain.value = S.grain; u.time.value = time;
		u.grainOn.value = this.upscaling ? 0 : 1;

	}

}
