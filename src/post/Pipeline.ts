import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, texture, textureLoad, uniform, uv, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, dot, length, abs, sqrt, cos, sin, log2, exp2, floor, luminance, neutralToneMapping, agxToneMapping,
	sRGBTransferOETF, fract, select, exp, nodeObject, atan, mod, pow, mrt, outputStruct, mat4,
} from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';
import { AerialPerspective, DEFAULT_AIR_OPTIONS, type AirOptions } from '../weather/AerialPerspective.ts';
import { LightShafts } from './LightShafts.ts';
import { FSR } from './FSR.ts';
import { BloomChains, type BloomChain } from './BloomChains.ts';
import { AA_MODE, AFTER_RESOLVE, RESOLVE, SCENE_SAMPLES, TEMPORAL } from './Antialiasing.ts';
import { beginMotionFrame, onTaaCut, overlayMRT, sceneMRT } from './Motion.ts';
import { RAIN_OVERLAY, afterFocus, afterMRT } from './AfterResolve.ts';
import { jitter } from './Jitter.ts';
import { TemporalAA, type TemporalFrame, type TemporalMode } from './TemporalAA.ts';
import { Settled, type SettleFrame } from './Settled.ts';
import { QUALITY, type TemporalSettings } from '../Quality.ts';
import { FrameGraph, type ResourceHandle, type SizeClass } from './graph/FrameGraph.ts';
import { DAY_BLACK_LIFT } from '../sky/DayCycle.ts';
import type { Sky } from '../sky/Sky.ts';
import type { Rain } from '../weather/Rain.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA, SCENE_SAMPLES, half float, multisampled depth)
//   depth resolve ── depthRT (view-space z of the opaque pass: sample 0, and the farthest sample)
//   opaque copy ── opaqueRT (the resolved opaque colour: what the water refracts and reflects)
//   water ── back into sceneRT, depth-tested per sample against the opaque samples
//   surface resolve ── surfaceRT (view-space z of the nearest surface, the sea's included) and
//     viewDistance (its distance, for the depth of field and the grade's sky test)
//   rain ── into sceneRT (its multisampled colour and depth are then discarded: nothing reads them;
//     without rain the water discards the colour and the surface resolve's read keeps the depth)
//   sea fog (in fog: the bank noise baked into a map, the march at half resolution)
//   light shafts: the open sky near the sun, the rays marched toward it (half resolution, while the
//   sun faces the view)
//   constants: what the composite takes that is the same for every pixel (the horizon's average,
//   the sun disk's visibility), evaluated once into a texel
//   composite (air, fog, rain veil, shafts) ── hdr, once (the veil after the resolve under taa, taau)
//   bloom (tight) and glow (wide) from hdr, both through a clamped soft-knee prefilter
//   sharp (hdr + the blooms) ── tilt-shift blur (half-res gather, with the depth of field on) ── the
//   look's diffusion glow
//   display: the depth of field's mix, the diffusion glow, exposure, tone curve (PBR Neutral with
//   hue-kept highlights by default), split-tone grade, vibrance, the night's cooler meadow, the
//   art-directed look
//   (hue-selective colour, warm / cool split, coloured shadow lift), lifted blacks, vignette,
//   S-curve, sRGB, grain ── displayRT
//   ── copied to the screen
// Under the temporal modes (Antialiasing.ts: aa=taa|taau) the scene half is single-sampled and
// jittered, and writes the motion vectors beside the colour:
//   opaque scene ── sceneColor and velocity (an MRT: Motion.ts's sceneMRT), sceneDepth
//   depth resolve ── depthRT (sample 0 twice: one sample)
//   opaque copy ── opaqueRT, a copy of the texture (copyTextureToTexture)
//   water ── sceneColor and velocity (sceneMRT), depth-tested against the opaque depth
//   surface resolve ── surfaceRT, copied at the frame's end into surfaceDepthPrev (the next
//     frame's history of the nearest surface)
//   overlay (the ground truth: taa and taau draw these after the resolve) ── the rain and the
//     storm's spray (moved from the water's scene) over the scene, with Motion.ts's overlayMRT: the
//     velocity under them kept
// and the post passes follow as above, but for the vignette and the grain, which the display pass
// leaves to the canvas pass, and (accumulating in linear light, Quality.ts `taa.linear`) for the
// S-curve and the sRGB transfer: displayRT holds the graded colour in linear light (half float),
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
// them all from `setSize`'s render and canvas sizes (the look glow's bloom chain, three's, which
// keeps targets of its own, through a resize hook). The passes read their sizes from the graph's extent uniforms.
// The graph runs the whole frame as passes that declare what they read and write: the scene half
// (opaque, the depth and copy resolves, water, the surface resolve, rain), the sea fog (its bank
// map, nearest depth and march), the light shafts' two passes, the composite's constants, the
// composite, the blooms (BloomChains.ts: the tight bloom and the wide glow drawn together, a pass
// for the high pass and each blur, one composite per chain), the sharp image, the depth of field's
// blur, the look's glow (three's bloom chain, its result imported into the graph), the display
// pass, and the canvas pass, or EASU and the sharpening canvas pass while upscaling. Every pass
// but the scene passes, the look's glow and the canvas passes is a full-screen quad of its own, and no pass renders
// another inside it (but three's FSR1Node, `post=three-fsr`, in its canvas pass). Each pass
// that runs only now and then (rain, fog, the light shafts, the depth of field's blur, the look's
// glow, either output) says when by a predicate the graph evaluates at the frame's start. A pass
// whose output weighs nothing in what reads it (the shafts without the sun toward the view, the
// blur without the depth of field) is skipped rather than drawn and multiplied by 0; its reader
// reads it optionally and gets what it last held, finite, times 0. The `post=` legacy switches
// are variants of the graph, chosen as it is built.
// At startup the graph's warm-up (`graph.warm`, from main.ts) compiles every pass and the bloom
// chains' own passes, so one that first runs later (fog, the upscale, the look's glow) builds
// nothing then.

//
// Rules (the look itself is in docs/art-direction.md):
// - Sizes are owned by the graph (graph/FrameGraph.ts): it sizes every target by its size class
//   from `setSize` (the render; a share of it: the sea fog's reduced targets, the blur's and the
//   shafts' halves; the canvas: FSR's EASU target; fixed: the fog's bank map), and every pass reads
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
//   and the farthest sample for what lies behind the sea at an edge pixel). Post passes read
//   `surfaceRT`, the nearest surface's depth with the sea's included. Multisampled depth is read
//   with `textureLoad`, one sample at a time (the sample index in its level argument);
//   single-sampled, that argument is a mip level, so load sample 0 only. View z below -9e4 is sky.
// - In a full-screen pass the camera nodes are the pass's own camera: the scene camera's matrices
//   come in as uniforms.
// - The tone curve and its grade come first; each curve carries its own grade. The night keeps
//   PBR Neutral's look with its grade whichever curve is chosen, crossfading as the sun sets (from
//   the horizon to about -3 degrees, so twilight is no darker than under PBR Neutral: `nightCurve`).
//   In the navy night the grade turns the meadow's greens toward blue-green (`nightGreenTurn`, by
//   the sun's elevation: `nightGreen`), a grade of its own, before the look; by day it is skipped
//   and the frame is unchanged.
// - The look is a layer after the curve and grade, never baked into the lighting or the curve;
//   every parameter is in the GUI. The night has a look of its own (`lookNight`: a cool, wider
//   soft glow from a lower threshold, cool highlights, a smaller lift), and the day's crossfades
//   into it (`nightLook`), so the moonlit island and the clouds round the moon glow softly instead
//   of the look fading out. Its glow, golden (by night cool) highlights and lift follow the
//   weather's direct light, and only part of its colour holds under a closed sky, so bad weather
//   stays dimmer and greyer than a clear day.
// - The two bloom chains (the tight bloom and the wide glow) take the night's own strengths,
//   thresholds and clamp (`settings.night`), crossfaded by the same weight as the look. Their
//   thresholds are in scene radiance, so a dim moonlit frame never reached the day's; scaling
//   them by the exposure instead would also move the day's bloom between noon and a low sun (the
//   low-sun adaptation raises the exposure by up to 60 %), where the chosen day keeps its values,
//   and the chosen night also takes stronger chains and a higher clamp, which a threshold alone
//   does not give.
// - The tilt-shift blur belongs to the island's surroundings and eases off kilometres out: a
//   blurred sky reads as a low backdrop and turns stars into bokeh discs. Rain drops follow its
//   focus (Rain.ts).

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
// The rain layer's grade table (`gradeTable`): colours per channel, and the range they span (stops of
// the scene colour times the exposure, display white at 0).
const GRADE_TABLE = { size: 64, low: - 14, high: 7 };
const RENDER: SizeClass = { of: 'render' };
// half the render, at least a texel (the depth of field's blur)
const HALF: SizeClass = { of: 'render', scale: 0.5, min: 1 };
const CANVAS: SizeClass = { of: 'canvas' };
// what the water pass draws in a frame without water: nothing
const NO_WATER = new THREE.Scene();

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
	// the composite evaluated once into a texture both blooms read (else each re-evaluates it)
	compositeOnce: boolean;
	// the depth of field's gather taps. 16 on high, the knee of a sweep from 12 to 48 against 36 in
	// the island camera's views of strongest blur (the gather is arithmetic-bound, so its cost
	// follows the taps); the error rose smoothly below it
	dofTaps: number;
	// the depth of field reads the view distance from a target written once per pixel (else each
	// tap derives it from the depth)
	dofDistance: boolean;
	// two bloom chains (tight and wide), or one with the wide glow's radius and the two strengths
	bloomChains: 1 | 2;
	// FSR 1 from FSR.ts (EASU pass, sharpening folded into the canvas pass), or three's FSR1Node
	fsrPort: boolean;
	// the legacy attachment ops (`fgOps=legacy`) discard the scene target's samples in the rain;
	// false (`post=store-scene`) keeps them (the derived ops follow `fgOps` alone, see
	// AttachmentOps.ts: `post=store-scene` maps to its `store` mode)
	discardScene: boolean;
}

export const DEFAULT_POST_OPTIONS: Readonly<PostOptions> = {
	...DEFAULT_AIR_OPTIONS, compositeOnce: true, dofTaps: 16, dofDistance: true, bloomChains: 2, fsrPort: true, discardScene: true,
};

const LEGACY_SWITCHES: Record<string, Partial<PostOptions>> = {
	'inline-composite': { compositeOnce: false },
	'full-fog': { fogScale: 1 },
	'no-bank': { bankSize: 0 },
	'inline-coc': { dofDistance: false },
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
// what a pass's setup declares its reads and writes on
type PassBuilder = Parameters<Parameters<FrameGraph<PipelineFrame>[ 'addPass' ]>[ 2 ]>[ 0 ];

// BloomNode sizes its chain to the canvas every frame; this one follows the scene's render
// instead, so the glow keeps its size and cost when the frame is upscaled.
class RenderBloomNode extends BloomNode {

	renderWidth = 1;
	renderHeight = 1;

	override setSize(): void {

		super.setSize( this.renderWidth, this.renderHeight );

	}

	// A chain that renders as a pass of the frame graph's own (its updateBefore), not from inside a
	// material that holds the node, is set up by no node build: its materials are made here, once,
	// with an empty shared context (inside the display chain they took the render pipeline's, whose
	// fields none of their nodes reads).
	setUpAlone(): this {

		( this as unknown as { setup( builder: { getSharedContext(): object } ): unknown } ).setup( { getSharedContext: () => ( {} ) } );
		return this;

	}

	/** The chain's result (its composite's target, which the graph imports). */
	get output(): THREE.RenderTarget {

		return ( this as unknown as { _renderTargetsHorizontal: THREE.RenderTarget[] } )._renderTargetsHorizontal[ 0 ];

	}

}

// The tone curves. 'neutral-hue', the default, is Khronos' PBR Neutral through its toe and
// midtones, where the scene's exposures, water and terrain were tuned, with highlights that keep
// their hue: PBR Neutral's own desaturation toward white turned a low sun's sky and sea into one
// flat cream band. AgX kept those highlights' colour too, but its toe lifts and greys the deep
// water and its long shoulder compresses the bright shallows, so the sea lost its depth and the
// seabed its contrast; PBR Neutral's linear midtones keep both.
// AgX (after Troy Sobotka, in three's approximation) has a long shoulder, about
// four stops above display white, that keeps gradation in a low sun's sky and glare, where PBR
// Neutral flattened everything above white into one cream band. Plain AgX also greys those
// highlights: each channel runs through the curve on its own, so a bright warm sky drifts toward
// white long before it clips, and a pale blue sky turns beige under the grade's golden highlights.
// 'agx-hue' runs AgX's curve on each colour's brightest channel only and keeps the colour's ratios
// (plain AgX only in the deep shadows): a low sun's sky stays golden and a noon sky blue, with
// AgX's gradation. 'neutral' is plain PBR Neutral. The AgX curves and 'neutral' stay selectable
// for comparison.
// The night keeps PBR Neutral's look whichever curve is chosen (see `nightCurve`): its toe, which
// subtracts the darkest channel, holds the night's dark colours saturated where AgX's toe greys
// and lifts them, and its short shoulder lets the brightest few stars reach near white.
export const TONE_CURVES = [ 'neutral-hue', 'agx-hue', 'agx', 'neutral' ] as const;
export type ToneCurve = typeof TONE_CURVES[ number ];

// Each curve's own grade: a gain on the clock's exposure (the clock's exposures were tuned under
// PBR Neutral), its saturation, vibrance and display contrast, gains on the clock's split tone
// and black lift, the weight and start of a soft knee that keeps the brightest channel below
// white, extra saturation for bright colours only, and how far both give way to white for the
// brightest highlights (`burn`).
export interface ToneLook { exposure: number; saturation: number; vibrance: number; contrast: number; split: number; lift: number; clipGuard: number; knee: number; highlightSat: number; burn: number }

// The look: an art-directed layer over the physically based image, after the tone curve and its
// grade, so the curve can be revised underneath it. 'realistic' leaves the frame exactly as the
// curve and grade make it; the fantasy looks push it toward a painted game's colour: a soft glow
// round the highlights, greens and turquoise water a little richer, golden highlights over cool
// teal shadows, and airy shadows lifted toward teal rather than grey.
export const LOOKS = [ 'realistic', 'soft-fantasy', 'rich-fantasy' ] as const;
export type LookName = typeof LOOKS[ number ];
// The gentle look by default: it holds across the day and the weather (a backlit low sun stays
// clear), while the rich one leans further toward a painted scene and is a step away in the GUI.
export const DEFAULT_LOOK: LookName = 'soft-fantasy';

export interface LookSettings {
	// Orton-style diffusion: a wide blur of what lies above `glowThreshold` (in display values,
	// before the curve, so it follows the exposure) added back over the image, warmed by `glowWarmth`
	glow: number; glowThreshold: number; glowRadius: number; glowWarmth: number;
	// the share of the glow that spreads over the dark parts of the frame (1: as over the light ones)
	glowHalo: number;
	// hue-selective colour: saturation and brightness gains on greens and on teal-cyan, and a hue
	// turn in radians (greens' toward pure green, the water's toward blue), weighted by chroma so
	// grey stone and pale skin stay as they are
	greenSaturation: number; greenBrightness: number; greenHue: number;
	tealSaturation: number; tealBrightness: number; tealHue: number;
	// split tone by luminance: shadows toward `shadowTint`, highlights toward `highlightTint`,
	// crossing at `pivot` (each tint keeps the colour's luminance)
	shadowTint: THREE.Color; shadowTone: number; highlightTint: THREE.Color; highlightTone: number; pivot: number;
	// a coloured lift of the darkest tones toward `shadowTint` (airy shadows) and a luminance
	// contrast around mid grey (depth in the meadow)
	shadowLift: number; contrast: number;
	vignette: number;
	// the share of the glow and the golden highlights the sky takes (the look is for the island)
	sky: number;
	// how much of the colour layers holds without sunlight (the glow, golden highlights and lift
	// follow the sun alone), so a rain or a storm stays dimmer and greyer than a clear day
	overcast: number;
}

export function cloneLook( look: LookSettings ): LookSettings {

	return { ...look, shadowTint: look.shadowTint.clone(), highlightTint: look.highlightTint.clone() };

}

// `out` = the looks `a` and `b` crossfaded by `t` (every number and both tints), returned.
function mixLook( out: LookSettings, a: LookSettings, b: LookSettings, t: number ): LookSettings {

	for ( const key of Object.keys( a ) as ( keyof LookSettings )[] ) {

		const x = a[ key ], y = b[ key ];
		if ( typeof x === 'number' ) ( out[ key ] as number ) = x + ( ( y as number ) - x ) * t;

	}
	out.shadowTint.lerpColors( a.shadowTint, b.shadowTint, t );
	out.highlightTint.lerpColors( a.highlightTint, b.highlightTint, t );
	return out;

}

export interface PipelineSettings {
	toneMapping: ToneCurve;
	look: LookName;
	// sunlight reaching the island through the weather (0 under a storm's deck, 1 clear)
	lookSunlight: number;
	// 0 by day, 1 at night (from the clock): how far the curve and its grade return to PBR
	// Neutral's
	nightCurve: number;
	// 0 by day, 1 at night (from the clock): how far the look and the bloom chains have crossfaded
	// into the night's (`Pipeline.lookNight`, `night`)
	nightLook: number;
	// 0 by day, 1 in the navy night (from the sun's elevation): how far the meadow's greens turn
	// toward blue-green (`nightGreenTurn`)
	nightGreen: number;
	exposure: number; saturation: number; vibrance: number; contrast: number; split: number;
	lift: THREE.Color; vignette: number; grain: number;
	bloomStrength: number; bloomRadius: number; bloomThreshold: number; bloomMaxLum: number; bloomSurfaceMaxLum: number;
	glowStrength: number; glowRadius: number; glowThreshold: number; glowMaxLum: number;
	// the bloom chains' values the night crossfades to (`nightLook`)
	night: NightBloom;
	dof: number; dofRange: number; dofMaxRadius: number; focusDistance: number;
}

export interface NightBloom { bloomStrength: number; bloomThreshold: number; glowStrength: number; glowThreshold: number; glowMaxLum: number }

// The night's own grade: the meadow's greens turned toward the night's blue-green, by `turn`
// radians at the centre of the green band (105 degrees, as the look's: it shades off over 55
// degrees either side), weighted by saturation so grey stone and the navy sea and sky keep their
// colour. Moonlight and the night ambient are blue, but the meadow's yellow-green albedo kept it a
// dark olive under them (about 107 degrees, blue a third of green); a light blue enough to turn it
// would turn the stone, sand and the islanders' skin blue too. A rotation in the opponent plane
// keeps the mean of the channels, so the meadow keeps its brightness. The turn takes the meadow to
// about 143 degrees, a cool green toward blue-green: a larger one (0.65, 155 degrees) read as teal.
const NIGHT_GREEN_TURN = 0.4;
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

export class Pipeline {

	renderer: THREE.WebGPURenderer;
	width = 1;
	height = 1;
	// AgX lifts the shadows and compresses the upper midtones that PBR Neutral left linear; a
	// lower exposure and a firmer display S-curve bring the island, meadow and sea back to about
	// their earlier brightness, and saturation and vibrance their colour (plain AgX needs more:
	// it greys every channel's midtones). 'agx-hue' keeps its highlights' colour up to white, where
	// that boost and the split tone's golden highlights would push the brightest channel past
	// white and clip it into a flat band of another hue, so it rolls them off below white.
	// 'neutral-hue' keeps PBR Neutral's grade with two thirds of the split tone, no vibrance and
	// no extra saturation, plus that knee, a little brighter (8 %) and a little softer (display
	// contrast below zero) than PBR Neutral, for a high-key, airy day. By day the clock's exposure
	// takes the 8 % back (DayCycle `DAY_EXPOSURE`), which leaves the night's exposure untouched. Its shoulder packs everything bright into the last few
	// percent below white, where the split tone's golden highlights pushed red alone against white
	// across a sunset sky; the knee starts lower than AgX's to leave red room for gradation. The
	// daytime horizon is pale and low in chroma: vibrance and a saturation boost for bright colours
	// lifted it into a saturated band, which the golden highlights turned cyan, where a hazy sea
	// sky is milky; a sunset sky, already saturated, kept its colour without them. The knee is
	// released (`burn`) for scene colours from eight to 32 times white, above the brightest sky:
	// alone it held every channel below about 0.95, and the curve's shoulder packs everything above white into its last few
	// percent, so the sun's glints on the sea read as one flat peach. Released, their whitened
	// cores clip to white, where a single pinned channel no longer shows as a band.
	readonly looks: Record<ToneCurve, ToneLook> = {
		'agx-hue': { exposure: 0.78, saturation: 1.2, vibrance: 0.3, contrast: 0.38, split: 1, lift: 1, clipGuard: 1, knee: 0.9, highlightSat: 0, burn: 0 },
		agx: { exposure: 0.8, saturation: 1.3, vibrance: 0.4, contrast: 0.35, split: 1, lift: 1, clipGuard: 0, knee: 0.9, highlightSat: 0, burn: 0 },
		neutral: { exposure: 1, saturation: 0.97, vibrance: 0.15, contrast: 0.04, split: 1, lift: 1, clipGuard: 0, knee: 0.9, highlightSat: 0, burn: 0 },
		'neutral-hue': { exposure: 1.08, saturation: 0.97, vibrance: 0, contrast: - 0.03, split: 0.67, lift: 1, clipGuard: 1, knee: 0.8, highlightSat: 0, burn: 1 },
	};
	// The fantasy presets are tuned on 'neutral-hue'. Its linear midtones pass the glow (added
	// before the curve) through almost as it is, and its shoulder keeps the glow's warm hue where
	// AgX's compressed and whitened it, so the glow is weaker, narrower and less warm than it was on
	// AgX; and its darker, more saturated toe made the coloured shadow lift read as haze on the deep
	// water, so the lift and the cool shadow tone are smaller too. 'soft-fantasy' turns the
	// greens about 11 degrees toward pure green and takes a tenth off their brightness, so the
	// sunlit meadow reads fresh and cool rather than straw-yellow and does not outshine the sky,
	// and takes a little luminance contrast away: the day stays soft and high-key (its depth comes
	// from the light). Its glow is wide and starts at about 0.7 of display white, so the horizon,
	// the glints and the brightest sunlit grass tips spread a soft light into what is round them,
	// and the airy shadow lift is twice the earlier one. From 0.45 at 0.3 the glow spread over the
	// whole sunlit meadow and washed a low sun's frame out toward white (about 9 to 12 levels of
	// its mean luma).
	readonly lookPresets: Record<LookName, LookSettings> = {
		realistic: {
			glow: 0, glowThreshold: 0.6, glowRadius: 0.8, glowWarmth: 0, glowHalo: 1,
			greenSaturation: 0, greenBrightness: 0, greenHue: 0, tealSaturation: 0, tealBrightness: 0, tealHue: 0,
			shadowTint: new THREE.Color( 1, 1, 1 ), shadowTone: 0, highlightTint: new THREE.Color( 1, 1, 1 ), highlightTone: 0, pivot: 0.3,
			shadowLift: 0, contrast: 0, vignette: 0, sky: 1, overcast: 0,
		},
		'soft-fantasy': {
			glow: 0.18, glowThreshold: 0.7, glowRadius: 0.85, glowWarmth: 0.25, glowHalo: 0.2,
			greenSaturation: 0.25, greenBrightness: - 0.1, greenHue: 0.2, tealSaturation: 0.12, tealBrightness: 0.02, tealHue: 0.04,
			shadowTint: new THREE.Color( 0.55, 0.85, 1.0 ), shadowTone: 0.18, highlightTint: new THREE.Color( 1.0, 0.86, 0.6 ), highlightTone: 0.25, pivot: 0.18,
			shadowLift: 0.02, contrast: - 0.05, vignette: 0.06, sky: 0.3, overcast: 0.5,
		},
		'rich-fantasy': {
			glow: 0.2, glowThreshold: 0.9, glowRadius: 0.75, glowWarmth: 0.4, glowHalo: 0.15,
			greenSaturation: 0.45, greenBrightness: 0.03, greenHue: 0.1, tealSaturation: 0.25, tealBrightness: 0.03, tealHue: 0.08,
			shadowTint: new THREE.Color( 0.45, 0.8, 1.0 ), shadowTone: 0.3, highlightTint: new THREE.Color( 1.0, 0.8, 0.5 ), highlightTone: 0.4, pivot: 0.18,
			shadowLift: 0.018, contrast: 0.15, vignette: 0.12, sky: 0.3, overcast: 0.5,
		},
	};
	// the live look, loaded from a preset by setLook() and tuned from there in the GUI
	look: LookSettings = cloneLook( this.lookPresets.realistic );
	// The night's look, for either fantasy look ('realistic' bypasses the layer by night too): the
	// soft glow cool, wider and from a lower threshold, so the moonlit meadow, the sea's sheen and
	// the clouds round the moon spread a cool soft light; cool highlights in place of golden ones,
	// the sky taking more of the glow (the moon and its clouds are the night's light), a small lift
	// that keeps the shade from sinking to black, and the greens a little richer but not turned
	// (the night's grade turns them, `nightGreenTurn`: the day's turn on top took the moonlit
	// meadow past 150 degrees, toward teal). Its strengths
	// (glow, the colour layers' amounts, lift, vignette) are seven tenths of the values it was
	// chosen by, which ran under seven tenths of the day's weight. Its threshold is about half the
	// first one's (0.12 from 0.25), so seen from the game's overview the moon path on the sea and the
	// moonlit meadow glow too, not only the moon and its clouds.
	readonly lookNightPreset: LookSettings = {
		glow: 0.35, glowThreshold: 0.12, glowRadius: 0.85, glowWarmth: - 0.8, glowHalo: 0.15,
		greenSaturation: 0.07, greenBrightness: - 0.07, greenHue: 0, tealSaturation: 0.084, tealBrightness: 0.014, tealHue: 0.028,
		shadowTint: new THREE.Color( 0.55, 0.85, 1.0 ), shadowTone: 0.126, highlightTint: new THREE.Color( 0.8, 0.9, 1.0 ), highlightTone: 0.175, pivot: 0.18,
		shadowLift: 0.0028, contrast: 0, vignette: 0.042, sky: 0.6, overcast: 0.5,
	};
	// the live night look (the GUI tunes it from there)
	lookNight: LookSettings = cloneLook( this.lookNightPreset );
	// the day's and the night's looks crossfaded, each frame
	private lookMixed: LookSettings = cloneLook( this.lookNightPreset );

	settings: PipelineSettings = {
		toneMapping: 'neutral-hue', look: 'realistic', lookSunlight: 1, nightCurve: 0, nightLook: 0, nightGreen: 0,
		// The look's bright midtones and soft shadows are a display grade; keep the
		// calibrated sunlight and water transport intact, with a nearly neutral black lift.
		exposure: 2.35, saturation: 0.97, vibrance: 0, contrast: - 0.03, split: 0.45,
		lift: new THREE.Color( DAY_BLACK_LIFT, DAY_BLACK_LIFT, DAY_BLACK_LIFT * 0.97 ),
		vignette: 0.06, grain: 0.004,
		bloomStrength: 0.22, bloomRadius: 0.3, bloomThreshold: 1.4, bloomMaxLum: 4.0, bloomSurfaceMaxLum: 2.0,
		glowStrength: 0.1, glowRadius: 1.0, glowThreshold: 0.8, glowMaxLum: 1.0,
		// the moonlit night's: both chains stronger and from lower thresholds in scene radiance (the
		// bloom's under half the day's), the glow's clamp doubled, so the moon, the clouds round it
		// and the moonlit sea's sheen bloom. The wide glow starts at 0.02, near the night look's
		// threshold (0.12 of display white over the night's exposure): from 0.35 only the moon and
		// its clouds reached it, and the moon path seen from the overview stayed hard. Lower still
		// (0.013) spread a haze round the moon in a view toward it a third brighter than before.
		night: { bloomStrength: 0.3, bloomThreshold: 0.6, glowStrength: 0.3, glowThreshold: 0.02, glowMaxLum: 2.0 },
		dof: 0.65, dofRange: 8.0, dofMaxRadius: 6.0, focusDistance: 0,
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
	 * and linear depth (the water, the spray, the rain) and the nearest surface's depth. */
	readonly textures: { readonly opaqueColor: THREE.Texture; readonly linearDepth: THREE.Texture; readonly surfaceDepth: THREE.Texture };
	private readonly resources: {
		sceneColor: ResourceHandle; sceneDepth: ResourceHandle; linearDepth: ResourceHandle; opaqueColor: ResourceHandle;
		surfaceDepth: ResourceHandle; velocity: ResourceHandle | null; surfaceDepthPrev: ResourceHandle | null; veilReactive: ResourceHandle | null;
		rainAir: ResourceHandle | null; rainOverlay: ResourceHandle | null; rainLayer: ResourceHandle | null; rainInput: ResourceHandle | null; rainBehind: ResourceHandle | null; rainGrade: ResourceHandle | null;
		hdr: ResourceHandle | null; sharp: ResourceHandle; blur: ResourceHandle; display: ResourceHandle;
		viewDistance: ResourceHandle | null;
		easu: ResourceHandle | null; canvas: ResourceHandle;
	};
	readonly air: AerialPerspective;
	readonly shafts = new LightShafts();
	readonly options: Readonly<PostOptions>;
	/** The temporal modes' resolve (null under msaa and off, and with `taaResolve=off`). */
	readonly temporal: TemporalAA | null = null;
	/** Whether the paused page will draw the same frame from now on (Settled.ts). */
	readonly settled = new Settled();

	private depthQuad: THREE.QuadMesh;
	// (msaa and off: under the temporal modes the opaque copy is a texture copy)
	private copyQuad: THREE.QuadMesh | null = null;
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
	// the composite and the blooms (the sharp image), its depth of field's half-resolution blur
	private sharpQuad: THREE.QuadMesh;
	private blurQuad: THREE.QuadMesh;
	// the graded image at the render's size, before the copy or upscale to the canvas
	private displayQuad: THREE.QuadMesh;
	// the bloom chains (the tight bloom, and the wide glow when there are two), drawn together
	// (BloomChains.ts), and each chain's clamps
	private bloom!: BloomChains;
	private blooms: { chain: BloomChain; maxLum: THREE.UniformNode<'float', number>; surfaceMaxLum: THREE.UniformNode<'float', number> }[] = [];
	private u = {
		// (exposure: the clock's, for PBR Neutral and the depth of field; curveExposure: with the
		// chosen curve's gain; day: 1 - the night's return to PBR Neutral)
		curve: uniform( 0 ), day: uniform( 1 ), nightGreen: uniform( 0 ), exposure: uniform( 1 ), curveExposure: uniform( 1 ), saturation: uniform( 1 ), vibrance: uniform( 0 ), contrast: uniform( 0 ), split: uniform( 1 ), clipGuard: uniform( 0 ), knee: uniform( 0.9 ), highlightSat: uniform( 0 ), burn: uniform( 0 ),
		lift: uniform( new THREE.Color() ), vignette: uniform( 0.3 ), grain: uniform( 0.01 ), time: uniform( 0 ),
		dof: uniform( 1 ), focus: uniform( 50 ), range: uniform( 3 ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ),
		maxRadius: uniform( 6 ), grainOn: uniform( 1 ),
		// 1 while the after pass draws (AfterResolve.ts): else its overlay holds an earlier frame's;
		// and while the rain's layer pass runs
		afterOn: uniform( 0 ), layerOn: uniform( 0 ),
		// the look (lookOn 0 skips it, so 'realistic' is exactly the curve's grade; lookColour and
		// lookSun are its weights with and without sunlight, both 0 at night)
		lookOn: uniform( 0 ), glowOn: uniform( 0 ), lookColour: uniform( 0 ), lookSun: uniform( 0 ), glowTint: uniform( new THREE.Color( 1, 1, 1 ) ),
		greenSat: uniform( 0 ), greenBright: uniform( 0 ), greenHue: uniform( 0 ), tealSat: uniform( 0 ), tealBright: uniform( 0 ), tealHue: uniform( 0 ),
		shadowTint: uniform( new THREE.Color( 1, 1, 1 ) ), shadowTone: uniform( 0 ), highlightTint: uniform( new THREE.Color( 1, 1, 1 ) ), highlightTone: uniform( 0 ),
		pivot: uniform( 0.3 ), shadowLift: uniform( 0 ), lookContrast: uniform( 0 ), lookSky: uniform( 1 ), glowHalo: uniform( 1 ),
	};
	// the look's diffusion glow: a bloom chain over the sharp image (its graph pass runs only while
	// the glow shows: `enabled`)
	private diffusion!: { node: RenderBloomNode; threshold: THREE.UniformNode<'float', number>; output: ResourceHandle; enabled: boolean };

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
		// The temporal modes' motion vectors (rg: the NDC motion since the previous frame, b: the
		// surface's class, a: its reactive weight; Motion.ts), and the nearest surface's depth of the
		// frame before, for the resolve's disocclusion test (a copy at the frame's end).
		// (in the scene's target: its sample count, one under the temporal modes)
		const velocity = TEMPORAL ? g.color( 'velocity', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType, samples: 'scene' } ) : null;
		const surfaceDepthPrev = TEMPORAL ? g.color( 'surfaceDepthPrev', { size: RENDER, format: THREE.RedFormat, type: THREE.FloatType }, true ) : null;
		// the rain veil's reactive weight per pixel, for the resolve, written by the composite
		// (persistent: zero until it is written, so the resolve's binding never changes)
		const veilReactive = RESOLVE && ! AFTER_RESOLVE ? g.color( 'veilReactive', { size: RENDER, format: THREE.RedFormat, type: THREE.HalfFloatType }, true ) : null;
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
		const rainGrade = AFTER_RESOLVE ? g.color( 'rainGrade', { size: { of: 'fixed', width: GRADE_TABLE.size ** 2, height: 2 * GRADE_TABLE.size }, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		// the composite, the sharp image and the depth of field's blur (half float, as three's rtt()
		// made them)
		const hdr = O.compositeOnce ? g.color( 'hdr', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		const sharp = g.color( 'sharp', { size: RENDER, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		const blur = g.color( 'blur', { size: HALF, format: THREE.RGBAFormat, type: THREE.HalfFloatType } );
		// (linear light under the temporal resolve: no per-tap decode in the resolve, half the bytes)
		const LINEAR_DISPLAY = RESOLVE && ( temporal ?? QUALITY.high.taa ).linear;
		const display = g.color( 'display', { size: RENDER, format: THREE.RGBAFormat, type: LINEAR_DISPLAY ? THREE.HalfFloatType : THREE.FloatType } );
		const viewDistance = O.dofDistance ? g.color( 'viewDistance', { size: RENDER, format: THREE.RedFormat, type: THREE.FloatType } ) : null;
		// the upscale's EASU image (the canvas's size) and the canvas (the resolve has its own)
		const easu = O.fsrPort && ! RESOLVE ? g.color( 'FSR.easu', { size: { of: 'canvas' }, format: THREE.RGBAFormat, type: THREE.HalfFloatType } ) : null;
		const canvas = g.import( 'canvas', null, { of: 'canvas' } );
		this.resources = { sceneColor, sceneDepth, linearDepth, opaqueColor, surfaceDepth, velocity, surfaceDepthPrev, veilReactive, rainAir, rainOverlay, rainLayer, rainInput, rainBehind, rainGrade, hdr, sharp, blur, display, viewDistance, easu, canvas };
		// the targets the frame draws into, made now (the probes, the warm-ups and the water's
		// textures need them before the first frame)
		g.renderTarget( velocity ? [ sceneColor, velocity ] : [ sceneColor ], sceneDepth );
		for ( const h of [ linearDepth, opaqueColor, display ] ) g.renderTarget( [ h ] );
		// (the view distance beside the nearest surface: the surface resolve writes both)
		g.renderTarget( viewDistance ? [ surfaceDepth, viewDistance ] : [ surfaceDepth ] );
		this.textures = { opaqueColor: g.texture( opaqueColor ), linearDepth: g.texture( linearDepth ), surfaceDepth: g.texture( surfaceDepth ) };
		// the sizes the passes read, the graph's shared extent uniforms (set with the targets' own
		// sizes): the render's, its texel, the half-resolution blur's and the canvas's
		const renderSize = g.extent( RENDER ), renderTexel = g.texel( RENDER ), halfSize = g.extent( HALF ), canvasSize = g.extent( CANVAS );

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
		// The distance to the nearest surface, the water's included (view-space z: closer is larger),
		// 1e5 for the sky. A surface's is held below 9e4, so the distance alone tells the sky (the
		// grade's `onSurface`): only the far plane's corners under a field of view above about 66
		// degrees reach past it, where the depth of field's coc has long been constant (from 15 km
		// on) and the gather's depth order between two such taps picks between equal cocs.
		const distanceAt = ( q: V2, z: F ) => {

			const ndc = vec2( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ) ).toVar();
			const dist = float( 1e5 ).toVar();
			If( z.greaterThan( - 9e4 ), () => {

				const v = u.projInv.mul( vec4( ndc, 1, 1 ) ).toVar();
				const dir = v.xyz.div( v.w ).toVar();
				dist.assign( min( length( dir.mul( z.div( dir.z ) ) ), 9e4 ) );

			} );
			return dist;

		};
		const msDepth = texture( g.texture( sceneDepth ) );
		const depthSample = ( coord: V2, i: number ) => textureLoad( msDepth, ivec2( coord ), int( i ) ) as unknown as F;
		// Sample 0 for what reads the depth at a point (the water's traces, rain, spray, the haze and
		// the blur), and the farthest of the samples for the water's view of what lies behind it.
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
		// The nearest surface's view z, and beside it (the dofDistance option) the view distance per
		// pixel for the depth of field, in full float: the gather's taps read it instead of each
		// deriving it from the depth (half float tied distances, and the depth order flipped). Written
		// in this pass rather than one of its own, which read the depth back.
		// (one body for both attachments: an output struct is the material's own node, so the two are
		// a matrix's columns)
		const surfaceMat = new THREE.NodeMaterial();
		if ( viewDistance ) {

			const resolved = Fn( () => {

				const z = viewZ( screenCoordinate.xy, depthSample( screenCoordinate.xy, 0 ) ).toVar();
				return mat4( vec4( z ), vec4( distanceAt( uv(), z ), 0, 0, 1 ), vec4( 0 ), vec4( 0 ) );

			} )() as unknown as { element( i: number ): THREE.Node<'vec4'> };
			surfaceMat.fragmentNode = outputStruct( resolved.element( 0 ), resolved.element( 1 ) );

		} else surfaceMat.fragmentNode = Fn( () => vec4( viewZ( screenCoordinate.xy, depthSample( screenCoordinate.xy, 0 ) ) ) )();
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
			tHdr = texture( g.texture( hdr ), uv() );

		}
		const hdrColor: V3 = tHdr ? tHdr.rgb : composited;
		const bloomInput = tHdr ?? nodeObject( vec4( hdrColor, 1 ) );

		// ---- blooms (BloomChains.ts: both chains drawn together, each as three's BloomNode drew it):
		// glints clamped first so a few firefly pixels cannot flood the frame, then a
		// soft knee instead of a hard threshold. On surfaces (anything in front of the sky) the
		// tight bloom's clamp sits just above its threshold (bloomSurfaceMaxLum 2 against 1.4):
		// every pixel of the sun's glitter path reaches the clamp, so a higher one let the path's
		// bloom pile up into a bright column over the island. The sky keeps the higher clamp, so
		// the sun's disc and a lightning channel (drawn without depth) keep their glow.
		const tBloomD = texture( tSurfaceDepth );
		// (one chain: the wide glow's radius and both strengths, see render())
		const names = O.bloomChains === 2 ? [ 'bloom', 'glow' ] : [ 'bloom' ];
		this.blooms = names.map( () => ( { chain: null!, maxLum: uniform( 5 ), surfaceMaxLum: uniform( 5 ) } ) );
		const bloom = this.bloom = new BloomChains( g, names, bloomInput, ( input, chain, i ) => {

			const { maxLum, surfaceMaxLum } = this.blooms[ i ];
			const threshold = chain.threshold;
			const px = ivec2( clamp( uv().mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
			const surface = ( textureLoad( tBloomD, px ) as unknown as F ).greaterThan( - 9e4 );
			const clampLum = select( surface, surfaceMaxLum, maxLum );
			const c = input.rgb;
			const v0 = luminance( c );
			const c1 = c.mul( min( float( 1 ), clampLum.div( max( v0, 1e-4 ) ) ) );
			const v = min( v0, clampLum );
			const knee = threshold.mul( 0.5 );
			const soft0 = clamp( v.sub( threshold ).add( knee ), 0, knee.mul( 2 ) );
			const soft = soft0.mul( soft0 ).div( knee.mul( 4 ).add( 1e-4 ) );
			return vec4( c1.mul( max( soft, v.sub( threshold ) ) ).div( max( v, 1e-4 ) ), 1 );

		} );
		bloom.chains.forEach( ( chain, i ) => { this.blooms[ i ].chain = chain; } );
		// (the sharp image reads each chain's result without the uv transform texture() gives a node
		// made without a uv, as three's bloom output node did)
		const bloomResult = ( i: number ) => {

			const result = texture( bloom.output( i ) );
			result.updateMatrix = false;
			return result.rgb;

		};
		const withBloom = names.reduce( ( sum: V3, _, i ) => sum.add( bloomResult( i ) ), hdrColor );

		// ---- the sharp image: the composite and the blooms (the composite evaluated here, inline,
		// without the composite pass)
		const sharpMat = new THREE.NodeMaterial();
		sharpMat.name = 'Post.Sharp';
		sharpMat.fragmentNode = vec4( withBloom, 1 );
		this.sharpQuad = new THREE.QuadMesh( sharpMat );
		this.sharpQuad.name = 'Post.Sharp';
		// (the sharp image and the blur as their rtt() nodes were: with their uv, no uv transform)
		const tSharp = texture( g.texture( sharp ), uv() );

		// ---- tilt-shift depth of field: a half-res gather over a golden-angle disc whose radius grows
		// with the circle of confusion; a sample only counts where its blur reaches this pixel, then
		// the blur is mixed over the sharp image by the full-resolution coc
		const tD = texture( tSurfaceDepth );
		// (the view distance per pixel, written by the surface resolve: the dofDistance option)
		const tDistance = viewDistance ? texture( g.texture( viewDistance ) ) : null;
		// The circle of confusion (0..1 of the widest blur) and the distance. One function per pass:
		// a layout function shared by two shaders keeps the first one's uniform bindings.
		const makeCocAt = () => Fn( ( [ q ]: [ V2 ] ) => {

			const px = ivec2( clamp( q.mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
			const dist = tDistance ? ( textureLoad( tDistance, px ) as unknown as F ).toVar()
				: distanceAt( q, ( textureLoad( tD, px ) as unknown as F ).toVar() );
			// The miniature blur is for the island's surroundings. Kilometres out it eases off, so the
			// sky and the horizon keep their scale: blurred, clouds read as a backdrop close behind
			// the island and every star spreads into a bokeh disc.
			const far = mix( float( 1 ), float( 0.15 ), smoothstep( 1500, 15000, dist ) );
			return vec2( clamp( abs( dist.sub( u.focus ) ).sub( u.range ).div( u.focus.mul( 0.55 ) ), 0, 1 ).mul( far ), dist );

		} ).setLayout( { name: 'cocAt', type: 'vec2', inputs: [ { name: 'q', type: 'vec2' } ] } );
		const cocAt = makeCocAt();
		// The blur's radius, in units of the widest one. It grows faster than the coc, so the
		// transition out of focus stays gentle (as the earlier gather's weights made it).
		const spread = ( c: F ) => c.mul( min( c.add( 0.15 ), 1 ) );
		const TAPS = O.dofTaps, GA = 2.39996323;
		// The gather averages colours compressed by their displayed luminance (c / (1 + L), after
		// Karis) and expands the mean again. A plain mean of HDR samples let a single sun glint,
		// tens of times white, clip every pixel of its circle of confusion: each out-of-focus glint
		// on the sea became a flat white disc. Compressed, a lone glint only brightens its blur a
		// little, while a dense glitter path stays bright.
		const compress = Fn( ( [ c ]: [ THREE.Node<'vec3'> ] ) => c.div( luminance( c ).mul( u.exposure ).add( 1 ) ) )
			.setLayout( { name: 'dofCompress', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' } ] } );
		const gather = Fn( () => {

			const q = uv();
			const centre = cocAt( q ).toVar();
			const c0 = centre.x, s0 = spread( c0 ).toVar();
			const acc = compress( texture( tSharp, q ).level( float( 0 ) ).rgb ).toVar(), wsum = float( 1 ).toVar();
			Loop( TAPS, ( { i } ) => {

				const fi = float( i );
				const r = sqrt( fi.add( 0.5 ).div( TAPS ) ).toVar();
				const a = fi.mul( GA );
				const o = vec2( cos( a ), sin( a ) ).mul( r ).mul( u.maxRadius ).mul( renderTexel );
				const p = q.add( o.mul( s0 ) ).toVar();
				const tap = cocAt( p ).toVar();
				// Depth order (after Jimenez's scatter-as-gather): a tap in front of this pixel reaches
				// as far as its own blur, a tap behind no further than this pixel's. A sharp figure in
				// front of the blurred sea then keeps to its silhouette instead of spreading a halo
				// over the sea, while a blurred foreground still spills over what lies behind it.
				const reach = spread( select( tap.y.lessThan( centre.y ), tap.x, min( tap.x, c0 ) ) );
				// it counts where that reach covers its distance here, with a pixel-wide edge, under a
				// kernel falling to a third at the rim, so what remains of a highlight's disc has a
				// soft edge rather than a cut-out one
				const w = clamp( reach.sub( r.mul( s0 ) ).mul( u.maxRadius ).add( 1 ), 0, 1 ).mul( r.mul( r ).mul( - 0.7 ).add( 1 ) ).toVar();
				acc.addAssign( compress( texture( tSharp, p ).level( float( 0 ) ).rgb ).mul( w ) );
				wsum.addAssign( w );

			} );
			const mean = acc.div( max( wsum, 1e-4 ) ).toVar();
			// the inverse of compress(): the mean's compressed luminance stays below one (the floor
			// caps an expanded mean near a thousand times display white, far past what the grade shows)
			return vec4( mean.div( max( float( 1 ).sub( luminance( mean ).mul( u.exposure ) ), 1e-3 ) ), c0 );

		} )();
		const blurMat = new THREE.NodeMaterial();
		blurMat.name = 'Post.Blur';
		blurMat.fragmentNode = gather;
		this.blurQuad = new THREE.QuadMesh( blurMat );
		this.blurQuad.name = 'Post.Blur';
		const tBlur = texture( g.texture( blur ), uv() );
		// Upsample the half-res blur by its four nearest texels, each weighted by how much it would
		// itself show as blur: plain bilinear filtering pulled a sharp figure's colour (a texel whose
		// coc is near zero) a pixel or two out over the blurred sea beside it. Texels that are
		// blurred themselves keep their bilinear weight, so a soft bush in front of a softer sea
		// stays soft at its edge instead of snapping to the half-res grid. The mix factor comes from
		// the full-resolution coc for the same reason.
		// (at the pixel drawn, or at render uv `q`: the rain's layer, AfterResolve.ts)
		const dofMixAt = ( q?: V2 ) => Fn( () => {

			const c = makeCocAt()( q ?? uv() ).x.toVar();
			const hp = ( q ?? uv() ).mul( halfSize ).sub( 0.5 ).toVar();
			const base = hp.floor().toVar();
			const f = hp.sub( base ).toVar();
			const acc = vec3( 0 ).toVar(), wsum = float( 0 ).toVar();
			for ( const [ ox, oy ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

				const t = tBlur.sample( clamp( base.add( vec2( ox, oy ) ), vec2( 0 ), halfSize.sub( 1 ) ).add( 0.5 ).div( halfSize ) ).level( float( 0 ) ).toVar();
				const bl = ( ox ? f.x : float( 1 ).sub( f.x ) ).mul( oy ? f.y : float( 1 ).sub( f.y ) );
				const w = bl.mul( smoothstep( 0, 0.35, t.a ).add( 1e-3 ) );
				acc.addAssign( t.rgb.mul( w ) );
				wsum.addAssign( w );

			}
			// (the plain bilinear blur keeps the half-res pass in the graph; it only shows where
			// every weight vanished, which they cannot. The select compiles to a per-pixel branch, where
			// an implicit-lod sample is undefined: level 0, the blur target's only level, is the same.)
			const blurred = select( wsum.greaterThan( 0 ), acc.div( max( wsum, 1e-6 ) ), ( q ? tBlur.sample( q ) : tBlur ).level( float( 0 ) ).rgb );
			return mix( ( q ? tSharp.sample( q ) : tSharp ).rgb, blurred, smoothstep( 0, 0.35, c ).mul( u.dof ) );

		} )();

		// ---- the look's diffusion glow, after Michael Orton's slide sandwiches (a sharp exposure
		// over an overexposed, defocused copy of the same view): the light parts of the image
		// spread a soft halo into their surroundings, so sunlit grass, glints and a bright sky glow
		// as in a painted scene. Only what lies above a threshold set in display values (it follows
		// the exposure) is blurred, with a wide soft knee, and glints are clamped first; the dark
		// parts add nothing, so it brightens round the highlights instead of laying a veil over the
		// frame. Like the tilt-shift it belongs to the island's surroundings: the sky and what lies
		// beyond a few hundred metres glow only by `lookSky` of it (a low sun's whole sky and the
		// sheen of the sea against it lie above the threshold, and their glow spread over the
		// island as a pale veil). The source is a little more saturated than the image, so the glow
		// reads as coloured light rather than milk. It reads the sharp image (one more
		// half-resolution bloom chain, no second evaluation of the haze), and is added before the
		// curve, whose shoulder keeps it soft.
		const diffusionThreshold = uniform( 1 );
		const tGlowD = texture( tSurfaceDepth );
		const diffusionNode = new RenderBloomNode( tSharp, 0, 0.8, 1 );
		diffusionNode.setResolutionScale( 0.5 );
		( diffusionNode as unknown as { highPassFn: unknown } ).highPassFn = Fn( ( { input }: { input: THREE.Node<'vec4'> } ) => {

			const px = ivec2( clamp( uv().mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
			// (view-space z: the sky's -1e5 lies far beyond the fade)
			const surface = mix( float( 1 ), u.lookSky, smoothstep( 150, 700, ( textureLoad( tGlowD, px ) as unknown as F ).negate() ) );
			const c = input.rgb;
			const v0 = luminance( c );
			const clampLum = diffusionThreshold.mul( 3 );
			const c1 = c.mul( min( float( 1 ), clampLum.div( max( v0, 1e-6 ) ) ) );
			const v = min( v0, clampLum );
			const coloured = max( mix( vec3( v ), c1, 1.25 ), vec3( 0 ) );
			return vec4( coloured.mul( smoothstep( diffusionThreshold.mul( 0.7 ), diffusionThreshold.mul( 2 ), v ).mul( surface ) ), 1 );

		} );
		// (its graph pass renders it, as the blooms')
		const diffusion = g.import( 'diffusion', diffusionNode.setUpAlone().output, HALF );
		this.diffusion = { node: diffusionNode, threshold: diffusionThreshold, output: diffusion, enabled: false };
		const tDiffusion = texture( g.texture( diffusion ) );
		tDiffusion.updateMatrix = false;
		// Over the dark parts of the frame the glow is held to `glowHalo` of itself: Orton's
		// sandwich multiplies, so the defocused copy brightens the light parts and leaves the shade
		// deep. Added in full, a backlit sea's glow lay over the shaded cliff in front of it as a
		// pale veil. It also lands only where the frame is about as bright as the light it spreads
		// from: against a low sun the glint and the sky behind the island are many times brighter
		// than the backlit meadow and trees in front of them, and their glow laid a warm haze over
		// the foliage. (The light it spreads from is the glow
		// over its strength and the chain's five mip weights, which sum to 3 at any radius.)
		// (glowOn is 0 while the chain is skipped: its texture holds the last glow.)
		// (the grade's input: at the pixel drawn, or at render uv `q`)
		const diffused = ( q?: V2 ) => {

			const c = dofMixAt( q ).toVar();
			const glow = ( q ? tDiffusion.sample( q ) : tDiffusion ).rgb.toVar();
			const l = luminance( c );
			const lit = smoothstep( 0.03, 0.4, l.mul( u.curveExposure ) );
			const source = luminance( glow ).div( max( diffusionNode.strength.mul( 3 ), 1e-6 ) );
			const near = smoothstep( 0.3, 1.5, l.div( max( source, 1e-6 ) ) );
			return c.add( glow.mul( u.glowTint ).mul( mix( u.glowHalo, float( 1 ), lit ).mul( near ) ).mul( u.glowOn ) );

		};

		// ---- grade, to display values (sRGB, 0..1)
		// AgX with hue-kept highlights ('agx-hue'). The colour is scaled by what AgX's curve makes of
		// its brightest channel (AgX maps a grey to a grey, to within its matrices' rounding), so its
		// ratios, hue and saturation, hold; scaling by the brightest channel, as PBR Neutral does,
		// never lets another channel pass white. Only from two stops above white does it fade toward
		// white, fully six stops up, so the sun's disc and its glints still burn out. In the deep
		// shadows it is plain AgX; the two cross over between an eighth of display white and white.
		// AgX's per-channel toe greys dark colours against PBR Neutral's toe, which is why the
		// night returns to PBR Neutral (see `nightCurve`).
		const hueToneMapping = Fn( ( [ color, exposure ]: [ V3, F ] ) => {

			const c = max( color.mul( exposure ), vec3( 0 ) ).toVar();
			const peak = max( max( c.r, max( c.g, c.b ) ), 1e-6 ).toVar();
			const stops = log2( peak ).toVar();
			const mapped = ( agxToneMapping( vec3( peak ), float( 1 ) ) as V3 ).g.toVar();
			const kept = mix( c.mul( mapped.div( peak ) ), vec3( mapped ), smoothstep( 1, 6, stops ) );
			return mix( agxToneMapping( c, float( 1 ) ) as V3, kept, smoothstep( - 3, 0, stops ) );

		} ).setLayout( { name: 'agxHueToneMapping', type: 'vec3', inputs: [ { name: 'color', type: 'vec3' }, { name: 'exposure', type: 'float' } ] } );
		// PBR Neutral with hue-kept highlights ('neutral-hue'). Khronos' PBR Neutral up to the start
		// of its shoulder, unchanged: its toe (the darkest channel's offset) and linear midtones
		// keep the water's depth and the seabed's contrast, which AgX's toe and long shoulder
		// flattened. Its shoulder already scales the colour by its brightest channel, so the
		// ratios hold; only its desaturation toward white is left out, which turned a low sun's
		// sky and sea into one cream band. As in 'agx-hue', bright colours fade to white only above
		// display white (from twice white, fully at 64 times), so the sun's disc and its glints
		// whiten toward their cores while a low sun's sky, at two to eight times white, keeps its hue.
		const neutralHueToneMapping = Fn( ( [ color, exposure ]: [ V3, F ] ) => {

			const c = color.mul( exposure ).toVar();
			const x = min( c.r, min( c.g, c.b ) );
			c.subAssign( select( x.lessThan( 0.08 ), x.sub( x.mul( x ).mul( 6.25 ) ), float( 0.04 ) ) );
			const peak = max( c.r, max( c.g, c.b ) ).toVar();
			const start = float( 0.76 ), d = float( 0.24 );
			const top = max( peak, start );
			const mapped = float( 1 ).sub( d.mul( d ).div( top.add( d ).sub( start ) ) ).toVar();
			const kept = mix( c.mul( mapped.div( top ) ), vec3( mapped ), smoothstep( 1, 6, log2( top ) ) );
			return select( peak.lessThan( start ), c, kept );

		} ).setLayout( { name: 'neutralHueToneMapping', type: 'vec3', inputs: [ { name: 'color', type: 'vec3' }, { name: 'exposure', type: 'float' } ] } );
		// The look's colour, on the curve's display-linear output. Hue-selective colour (a secondary
		// correction, as in a colourist's HSL keys): the hue is the angle in an opponent plane
		// (red 0, yellow 60, green 120, cyan 180 degrees, as HSV's), each band a smooth bump on it,
		// weighted by saturation so grey stone, pale skin and white foam stay as they are. Then a
		// luminance contrast round mid grey, the warm / cool split by luminance (log-spaced, crossing
		// at `pivot`; each tint normalised to keep luminance) and a coloured lift of the darkest tones.
		const SQRT3_2 = Math.sqrt( 3 ) / 2, INV_SQRT3 = 1 / Math.sqrt( 3 );
		// (edges in ascending order: SPIR-V and Metal leave smoothstep undefined when they are not)
		const band = ( hue: F, centre: number, width: number ) =>
			float( 1 ).sub( smoothstep( 0, width, abs( mod( hue.sub( centre ).add( Math.PI ), 2 * Math.PI ).sub( Math.PI ) ) ) );
		// (saturation as HSV's: the spread of the channels over the brightest)
		const chroma = ( c: V3 ) => max( c.r, max( c.g, c.b ) ).sub( min( c.r, min( c.g, c.b ) ) ).div( max( max( c.r, max( c.g, c.b ) ), 1e-6 ) );
		// (one per pass: a layout function reading uniforms keeps the first shader's uniform names)
		const makeLookColour = () => Fn( ( [ c0, onSurface ]: [ V3, F ] ) => {

			const c = c0.toVar();
			const ca = c.r.sub( c.g.add( c.b ).mul( 0.5 ) ).toVar();
			const cb = c.g.sub( c.b ).mul( SQRT3_2 ).toVar();
			// (atan2 ( 0, 0 ) is undefined on some backends; a grey's hue is keyed out below anyway)
			const hue = atan( cb, select( abs( ca ).add( abs( cb ) ).greaterThan( 1e-7 ), ca, float( 1 ) ) ).toVar();
			const peak = max( c.r, max( c.g, c.b ) );
			const sat = peak.sub( min( c.r, min( c.g, c.b ) ) ).div( max( peak, 1e-5 ) );
			const keyed = smoothstep( 0.04, 0.3, sat ).mul( u.lookColour ).toVar();
			// greens about 105 degrees (the meadow's sunlit yellow-green at 75 still half in), teal-cyan
			// about 185 (the shallow water); yellow flowers, skin and the warm sky fall outside both
			const wG = band( hue, 105 * Math.PI / 180, 55 * Math.PI / 180 ).mul( keyed ).toVar();
			const wT = band( hue, 185 * Math.PI / 180, 35 * Math.PI / 180 ).mul( keyed ).toVar();
			// turn the hue in the opponent plane, keeping the mean of the channels
			const turn = wG.mul( u.greenHue ).add( wT.mul( u.tealHue ) ).toVar();
			const ra = ca.mul( cos( turn ) ).sub( cb.mul( sin( turn ) ) ).toVar();
			const rb = ca.mul( sin( turn ) ).add( cb.mul( cos( turn ) ) ).toVar();
			const m = c.r.add( c.g ).add( c.b ).div( 3 ).toVar();
			c.assign( max( vec3( m.add( ra.mul( 2 / 3 ) ), m.sub( ra.div( 3 ) ).add( rb.mul( INV_SQRT3 ) ), m.sub( ra.div( 3 ) ).sub( rb.mul( INV_SQRT3 ) ) ), vec3( 0 ) ) );
			const l0 = luminance( c ).toVar();
			c.assign( max( mix( vec3( l0 ), c, wG.mul( u.greenSat ).add( wT.mul( u.tealSat ) ).add( 1 ) ), vec3( 0 ) ) );
			c.mulAssign( wG.mul( u.greenBright ).add( wT.mul( u.tealBright ) ).add( 1 ) );
			// contrast round the pivot: deeper shade in the meadow, brighter sunlit tops
			const l1 = max( luminance( c ), 1e-5 ).toVar();
			c.mulAssign( pow( l1.div( u.pivot ), u.lookContrast.mul( u.lookColour ) ) );
			// warm / cool split
			const l2 = max( luminance( c ), 1e-5 ).toVar();
			// (the shadows from a stop above the pivot down, the highlights from the pivot up: the
			// midtones keep their own colour, so a half-lit meadow does not turn blue-grey)
			const stops = log2( l2.div( u.pivot ) ).toVar();
			const lo = float( 1 ).sub( smoothstep( - 3, 0.5, stops ) ).toVar();
			const hi = smoothstep( 0, 2.5, stops );
			const shadowTint = u.shadowTint.div( max( luminance( u.shadowTint ), 1e-3 ) );
			const highlightTint = u.highlightTint.div( max( luminance( u.highlightTint ), 1e-3 ) );
			const s0 = chroma( c ).toVar();
			c.mulAssign( mix( vec3( 1 ), shadowTint, lo.mul( u.shadowTone ).mul( u.lookColour ) ) );
			// airy shadows: the darkest tones lifted toward the shadow tint, not toward grey
			c.addAssign( vec3( 1 ).sub( c ).mul( u.shadowTint ).mul( u.shadowLift.mul( u.lookSun ).mul( lo.mul( lo ) ) ) );
			// The cool tint and the lift turn a shadow's hue toward teal but keep its saturation: on
			// a warm colour they add the colour's weakest channel, so a dawn meadow, dark and lit
			// orange, went olive-grey. A colour they greyed gets its saturation back round its
			// luminance (a grey shadow, which they colour, keeps its teal).
			const l3 = luminance( c );
			c.assign( max( mix( vec3( l3 ), c, clamp( s0.div( max( chroma( c ), 1e-6 ) ), 1, 2 ) ), vec3( 0 ) ) );
			// (the sky takes `lookSky` of the golden highlights: on a pale blue sky they turn green)
			c.mulAssign( mix( vec3( 1 ), highlightTint, hi.mul( u.highlightTone ).mul( u.lookSun ).mul( mix( u.lookSky, float( 1 ), onSurface ) ) ) );
			return c;

		} ).setLayout( { name: 'lookColour', type: 'vec3', inputs: [ { name: 'c', type: 'vec3' }, { name: 'onSurface', type: 'float' } ] } );
		const lookColour = makeLookColour();
		// the vignette's factor at the pixel being drawn into an image of `size` (the grade's; under the
		// temporal resolve the canvas pass's, after the accumulation)
		const vignetteAt = ( size: THREE.UniformNode<'vec2', THREE.Vector2> ) => {

			const q = uv().sub( 0.5 ).mul( vec2( size.x.div( size.y ), 1 ) );
			return mix( float( 1 ), smoothstep( 1.15, 0.3, length( q ) ), u.vignette );

		};
		// (`encode` false: the graded colour in linear light, before the sRGB transfer and the S-curve)
		// (`surface`: whether a surface lies at the pixel, 1 or 0, in place of the nearest surface's depth
		// there: the rain's grade table, AfterResolve.ts)
		const grade = ( lin: V3, vignette: boolean, encode: boolean, look = lookColour, surface?: F ): V3 => {

			// (a uniform branch: the GUI switches the curve without rebuilding the pass. PBR Neutral
			// is evaluated outside it, every frame: called inside the branch it rendered black, and
			// the night mixes it in anyway.)
			const night = ( neutralToneMapping( lin, u.exposure ) as V3 ).toVar();
			// how far the scene colour lies above white (from 8 to 32 times), for 'neutral-hue's
			// burning highlights (see `looks`)
			const hdr = lin.mul( u.curveExposure );
			const hot = smoothstep( 3, 5, log2( max( max( hdr.r, max( hdr.g, hdr.b ) ), 1e-6 ) ) ).mul( u.burn ).toVar();
			const c = night.toVar();
			If( u.curve.equal( TONE_CURVES.indexOf( 'agx-hue' ) ), () => {

				c.assign( hueToneMapping( lin, u.curveExposure ) );

			} ).ElseIf( u.curve.equal( TONE_CURVES.indexOf( 'agx' ) ), () => {

				c.assign( agxToneMapping( lin, u.curveExposure ) as V3 );

			} ).ElseIf( u.curve.equal( TONE_CURVES.indexOf( 'neutral-hue' ) ), () => {

				c.assign( neutralHueToneMapping( lin, u.curveExposure ) );

			} );
			c.assign( mix( night, c, u.day ) );
			// teal-blue shadows, golden highlights
			const l = luminance( c );
			const tint = mix( vec3( 0.96, 1.0, 1.04 ), vec3( 1.1, 1.0, 0.82 ), smoothstep( 0.02, 0.45, l ) );
			c.mulAssign( mix( vec3( 1 ), tint, u.split ) );
			// saturation with vibrance: muted colours gain more than already saturated ones (and,
			// for 'neutral-hue', bright colours a little more: see `looks`)
			const l2 = luminance( c );
			const chroma = max( c.r, max( c.g, c.b ) ).sub( min( c.r, min( c.g, c.b ) ) );
			const satAmt = u.saturation.add( u.vibrance.mul( float( 1 ).sub( smoothstep( 0, 0.35, chroma.div( max( l2, 1e-3 ) ).mul( 0.5 ) ) ) ) ).add( u.highlightSat.mul( smoothstep( 0.6, 0.9, l2 ) ).mul( float( 1 ).sub( hot ) ) );
			c.assign( max( mix( vec3( l2 ), c, satAmt ), vec3( 0 ) ) );
			// the night's cooler meadow (see nightGreenTurn; a uniform branch, so the day's frame is
			// exactly the grade above)
			If( u.nightGreen.greaterThan( 0 ), () => {

				c.assign( nightGreenTurn( c, u.nightGreen ) );

			} );
			// The look (a uniform branch: 'realistic' skips it and keeps the grade above exactly).
			// (from the view distance where it is kept: a surface's lies below 9e4, the sky's is 1e5)
			const px = ivec2( clamp( uv().mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
			const onSurface = surface ?? select( tDistance ? ( textureLoad( tDistance, px ) as unknown as F ).lessThan( 1e5 ) : ( textureLoad( tD, px ) as unknown as F ).greaterThan( - 9e4 ), float( 1 ), float( 0 ) ).toVar();
			If( u.lookOn.greaterThan( 0.5 ), () => {

				c.assign( look( c, onSurface ) );

			} );
			// A soft knee on the brightest channel (from the curve's `knee`), scaling the whole colour
			// so its hue holds: the golden split tone and the saturation push a bright warm sky's red
			// past white, where it clipped alone into a flat band while green and blue still rose.
			const peak = max( c.r, max( c.g, c.b ) );
			const knee = u.knee;
			const soft = knee.add( float( 1 ).sub( knee ).mul( float( 1 ).sub( exp( peak.sub( knee ).div( float( 1 ).sub( knee ) ).negate() ) ) ) );
			c.mulAssign( mix( float( 1 ), select( peak.greaterThan( knee ), soft.div( peak ), float( 1 ) ), u.clipGuard.mul( float( 1 ).sub( hot ) ) ) );
			// A display black lift softens dark colours without adding atmospheric scattering.
			c.assign( c.add( vec3( 1 ).sub( c ).mul( u.lift ) ) );
			// vignette (the resolve leaves it to the canvas pass, after the accumulation)
			if ( vignette ) c.mulAssign( vignetteAt( renderSize ) );
			if ( ! encode ) return clamp( c, 0, 1 );
			const s = ( sRGBTransferOETF( clamp( c, 0, 1 ) ) as THREE.Node<'vec3'> ).toVar();
			// gentle S-curve in display space
			s.assign( mix( s, s.mul( s ).mul( float( 3 ).sub( s.mul( 2 ) ) ), u.contrast ) );
			return s;

		};
		// grain + dither, per pixel of the canvas (`on` 0 leaves them out)
		const finish = ( s: V3, size: THREE.UniformNode<'vec2', THREE.Vector2>, on: F ) => {

			const hash = ( p: THREE.Node<'vec2'> ) => fract( sin( dot( p, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );
			const px = uv().mul( size );
			const g = hash( px.add( fract( u.time.mul( 13 ) ).mul( 100 ) ) ).sub( 0.5 );
			If( on.greaterThan( 0.5 ), () => {

				s.addAssign( g.mul( u.grain ).add( hash( px.mul( 1.37 ) ).sub( 0.5 ).div( 255 ) ) );

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
		displayMat.fragmentNode = Fn( () => finish( grade( diffused(), ! RESOLVE, ! LINEAR_DISPLAY ), renderSize, RESOLVE ? float( 0 ) : u.grainOn ) )();
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

		} else if ( ! RESOLVE ) {

			const upscaled = fsr1( texture( tDisplay ), this.sharpness );
			this.upscaledOutputThree = new THREE.RenderPipeline( renderer, Fn( () => finish( upscaled.rgb.toVar(), canvasSize, float( 1 ) ) )() );
			this.upscaledOutputThree.outputColorTransform = false;

		}
		// The bloom chains (three's, with targets of their own) follow the render's size, not the
		// canvas, which is larger while the frame is upscaled; sized at once, as the graph sizes its
		// own targets (its dev check compares a pass's target with its size class before it runs).
		g.onResize( RENDER, ( w, h ) => {

			const node = this.diffusion.node;
			node.renderWidth = w; node.renderHeight = h; node.setSize();

		} );
		// What the rain's layer pass draws at the canvas's size, for the canvas pass to add to the
		// resolved image after the resolve (AfterResolve.ts): the change the rain makes to the graded
		// colour at the pixel (without the vignette, the canvas pass's; in linear light under
		// `linear`), and in alpha 1 where it makes one. The rain is laid over the grade's input at the
		// render texel nearest the point the pixel shows (the display pass's own: the sharp image, its
		// depth of field and the look's glow, evaluated again there), in scene radiance as it was
		// before the grade, and that is graded: the change is the difference from what the display
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
			const before = diffused( vec2( texel ).add( 0.5 ).div( renderSize ) ).toVar();
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
		// white), for a surface and for the sky, baked by a pass of its own while the layer runs
		// (`rainGrade`) and read trilinearly (two bilinear taps). The change is the difference of two
		// readings (with the rain and without), so the table's error cancels to first order; graded in
		// full at every canvas pixel, the grade took a third of the layer's time. The frame that
		// completes the rest grades in full (its layer stands for every paused frame).
		const T = GRADE_TABLE;
		const gradeTableNode = rainGrade ? Fn( () => {

			const p = floor( screenCoordinate.xy ).toVar();
			const b = floor( p.x.div( T.size ) ), surface = floor( p.y.div( T.size ) );
			const index = vec3( p.x.sub( b.mul( T.size ) ), p.y.sub( surface.mul( T.size ) ), b );
			const lin = exp2( index.div( T.size - 1 ).mul( T.high - T.low ).add( T.low ) ).div( u.exposure );
			return vec4( grade( lin, false, ! LINEAR_DISPLAY, makeLookColour(), surface ), 1 );

		} )() as unknown as THREE.Node<'vec4'> : null;
		if ( gradeTableNode ) {

			const gradeMat = new THREE.NodeMaterial();
			gradeMat.name = 'Post.RainGrade';
			gradeMat.fragmentNode = gradeTableNode;
			this.rainGradeQuad = new THREE.QuadMesh( gradeMat );
			this.rainGradeQuad.name = 'Post.RainGrade';

		}
		const gradeTable = ( lin: V3, surface: F ): V3 => {

			const table = g.texture( rainGrade! );
			const c = clamp( log2( max( lin.mul( u.exposure ), vec3( 2 ** T.low ) ) ).sub( T.low ).div( T.high - T.low ), 0, 1 ).mul( T.size - 1 ).toVar();
			const b0 = floor( c.z ).toVar();
			const v = c.y.add( 0.5 ).add( surface.mul( T.size ) ).div( 2 * T.size ).toVar();
			const slice = ( b: F ) => ( texture( table, vec2( c.x.add( 0.5 ).add( b.mul( T.size ) ).div( T.size * T.size ), v ) ).level( float( 0 ) ) as unknown as THREE.Node<'vec4'> ).rgb;
			return mix( slice( b0 ), slice( min( b0.add( 1 ), T.size - 1 ) ), c.z.sub( b0 ) );

		};
		// (a fresh node per shader: the look's layout function keeps one shader's uniform names; `table`:
		// graded by the table)
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
				if ( table ) {

					// (the surfaces the full grade sees: the display pass's at the texel, the pixel's own)
					const surfaceAt = ( px: THREE.Node<'ivec2'> ) => select( ( textureLoad( tAfterDepth, px ) as unknown as F ).greaterThan( - 9e4 ), float( 1 ), float( 0 ) );
					const pixel = ivec2( clamp( uv().mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
					out.assign( vec4( gradeTable( full, surfaceAt( pixel ) ).sub( gradeTable( before, surfaceAt( texel ) ) ).mul( AFTER_COVERAGE ), 1 ) );

				} else {

					const look = makeLookColour();
					const graded = LINEAR_DISPLAY ? ( textureLoad( tAfterDisplay, texel ) as unknown as THREE.Node<'vec4'> ).rgb : grade( before, false, ! LINEAR_DISPLAY, look );
					out.assign( vec4( grade( full, false, ! LINEAR_DISPLAY, look ).sub( graded ).mul( AFTER_COVERAGE ), 1 ) );

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
			contrast: u.contrast, vignette: vignetteAt, finish,
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
			// the display pass's blur weight, inline (cocAt's layout function, called from the resolve's
			// shaders, came out with another shader's uniform names)
			dofBlur: () => ( q: V2 ) => {

				const px = ivec2( clamp( q.mul( renderSize ), vec2( 0 ), renderSize.sub( 1 ) ) );
				const dist = tDistance ? ( textureLoad( tDistance, px ) as unknown as F ).toVar() : distanceAt( q, ( textureLoad( tD, px ) as unknown as F ).toVar() );
				const far = mix( float( 1 ), float( 0.15 ), smoothstep( 1500, 15000, dist ) );
				const coc = clamp( abs( dist.sub( u.focus ) ).sub( u.range ).div( u.focus.mul( 0.55 ) ), 0, 1 ).mul( far );
				return smoothstep( 0, 0.35, coc ).mul( u.dof );

			},
		} );
		this.declarePasses();
		if ( TEMPORAL ) {

			// The jitter shifts the camera's projection through the scene half (the graph's jittered
			// span) and is undone after it; the post passes reconstruct positions with the inverse
			// the frame was drawn with, set once the jitter is on (Jitter.ts): the composite's own, the
			// air's rays (its fog march and composite) and the shafts' (only the sun's position on
			// screen stays unjittered, from `update`).
			jitter.mode = AA_MODE === 'taau' ? 'taau' : 'taa';
			g.hooks.jitterBegin = ( f ) => {

				jitter.begin( f.camera );
				const inverse = f.camera.projectionMatrixInverse;
				this.u.projInv.value.copy( inverse );
				this.air.setProjectionInverse( inverse );
				this.shafts.setProjectionInverse( inverse );

			};
			g.hooks.jitterEnd = ( f ) => jitter.end( f.camera );
			// across a cut the nearest surface's history is no longer the frame before
			const surfaceDepthPrev = this.resources.surfaceDepthPrev!;
			onTaaCut( () => g.resetHistory( surfaceDepthPrev ) );

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
		this.setToneMapping( this.settings.toneMapping );

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
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, surfaceDepth, velocity, viewDistance } = this.resources;
		if ( TEMPORAL ) [ sceneColor, surfaceDepth, velocity, viewDistance ] = this.declareTemporalScene();
		else {

			g.addPass( 'opaque', 'scene', ( b ) => {

				sceneColor = b.write( sceneColor, { clear: true } );
				sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
				return { label: 'opaque scene', scene: ( f ) => f.scene, camera: ( f ) => f.camera };

			} );
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
				sceneColor = b.write( sceneColor );
				sceneDepth = b.depth( sceneDepth, { write: true } );
				return {
					label: 'water', before: ( f ) => f.water?.prepare( f.sun ),
					scene: ( f ) => f.water ? f.waterScene : NO_WATER, camera: ( f ) => f.camera,
				};

			} );
			// (and the depth of field's view distance beside it: the attachments in the struct's order,
			// the MRT only declares them)
			g.addPass( 'surfaceResolve', 'quad', ( b ) => {

				b.read( sceneDepth, 'samples' );
				surfaceDepth = b.write( surfaceDepth );
				if ( viewDistance ) viewDistance = b.write( viewDistance );
				return { label: 'depth & copy resolves', quad: this.surfaceQuad, mrt: viewDistance ? mrt( {} ) : null };

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
		let { hdr, sharp, blur, display, easu, canvas, veilReactive, rainAir } = this.resources;
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
		// the blooms (BloomChains.ts: both chains drawn together, twelve passes): from hdr, or the
		// composite inline; their high pass keeps the surfaces' glints below the sky's
		const blooms = this.bloom.passes( g, this.blooms.length === 2 ? 'bloom & wide glow' : 'bloom', ( b ) => {

			// (inline, the composite's reads include the surface depth)
			if ( hdr ) {

				b.read( hdr );
				b.read( surfaceDepth );

			} else compositeReads( b );

		} );
		// the sharp image: the composite (inline, without the composite pass: the profiler's
		// composite then) and the blooms
		const sharpQuad = this.sharpQuad;
		g.addPass( 'sharp', 'quad', ( b ) => {

			if ( hdr ) b.read( hdr );
			else compositeReads( b );
			for ( const h of blooms ) b.read( h );
			sharp = b.write( sharp );
			return { label: hdr ? 'sharp (composite + blooms)' : 'composite (air, fog, veil)', quad: sharpQuad };

		} );
		// the depth of field's half-resolution gather: its circle of confusion from the view distance
		// (or the surface depth, inline-coc); only with the depth of field (without it the display
		// mixes the blur in at weight 0, so what it last held never shows)
		const blurQuad = this.blurQuad;
		g.addPass( 'blur', 'quad', ( b ) => {

			b.read( sharp );
			b.read( viewDistance ?? surfaceDepth );
			blur = b.write( blur );
			return { label: 'tilt-shift blur', when: () => this.settings.dof > 0, whenLabel: 'dof > 0', quad: blurQuad };

		} );
		// the look's diffusion glow, a bloom chain over the sharp image, while it shows
		const diffusion = this.diffusion;
		let glow = diffusion.output;
		g.addPass( 'diffusion', 'chain', ( b ) => {

			b.read( sharp );
			b.read( surfaceDepth );
			glow = b.write( glow );
			return { label: 'look glow', when: () => diffusion.enabled, whenLabel: 'look glow', nodes: [ diffusion.node ] };

		} );
		// the depth of field's mix, the look's glow, grade and look
		const displayQuad = this.displayQuad;
		g.addPass( 'display', 'quad', ( b ) => {

			b.read( sharp );
			b.readOptional( blur );
			b.readOptional( glow );
			// (the sky test from the view distance where it is kept)
			b.read( viewDistance ?? surfaceDepth );
			display = b.write( display );
			return { label: 'grade & look', quad: displayQuad };

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

					// (the grade's input: the sharp image, the depth of field's blur and distances, the
					// look's glow)
					b.read( sharp );
					b.readOptional( blur );
					b.read( surfaceDepth );
					if ( viewDistance ) b.read( viewDistance );
					b.readOptional( glow );
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
			this.temporal.declare( { display, velocity: velocity!, surfaceDepth, surfaceDepthPrev: surfaceDepthPrev!, veilReactive, viewDistance, canvas, after } );
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
	// (Motion.ts). Returns the scene colour's, the nearest surface's, the velocity's and the view
	// distance's last versions.
	private declareTemporalScene(): [ ResourceHandle, ResourceHandle, ResourceHandle, ResourceHandle | null ] {

		const g = this.graph;
		let { sceneColor, sceneDepth, linearDepth, opaqueColor, surfaceDepth, viewDistance } = this.resources;
		let velocity = this.resources.velocity!;
		g.addPass( 'opaque', 'scene', ( b ) => {

			sceneColor = b.write( sceneColor, { clear: true } );
			velocity = b.write( velocity, { clear: true } );
			sceneDepth = b.depth( sceneDepth, { write: true, clear: true } );
			return { label: 'opaque scene', mrt: sceneMRT, jittered: true, scene: ( f ) => f.scene, camera: ( f ) => f.camera };

		} );
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
			if ( viewDistance ) viewDistance = b.write( viewDistance );
			return { label: 'depth & copy resolves', jittered: true, quad: this.surfaceQuad, mrt: viewDistance ? mrt( {} ) : null };

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
		// the nearest surface's depth, kept for the next frame
		g.copyToPersistent( surfaceDepth, this.resources.surfaceDepthPrev! );
		return [ sceneColor, surfaceDepth, velocity, viewDistance ];

	}

	// Switches the curve and loads its saturation, vibrance and contrast into the settings (the
	// GUI may tune them from there); its exposure, split and lift gains apply every frame.
	setToneMapping( curve: ToneCurve ): void {

		const S = this.settings, look = this.looks[ curve ];
		S.toneMapping = curve;
		S.saturation = look.saturation; S.vibrance = look.vibrance; S.contrast = look.contrast;

	}

	// Loads a look preset into the live look (the GUI may tune it from there).
	setLook( name: LookName ): void {

		if ( ! LOOKS.includes( name ) ) return;
		this.settings.look = name;
		const preset = this.lookPresets[ name ], look = this.look;
		Object.assign( look, cloneLook( preset ), { shadowTint: look.shadowTint.copy( preset.shadowTint ), highlightTint: look.highlightTint.copy( preset.highlightTint ) } );

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

	/** The resolved opaque colour (what the water refracts and reflects). */
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

	/** Whether the frame is rendered below the canvas's resolution and upscaled. */
	get upscaling(): boolean {

		return this.outputWidth !== this.width || this.outputHeight !== this.height;

	}

	/** Renders the frame: its uniforms from the camera and the settings, then the frame graph's
	 * passes (`graph.execute`). */
	render( frame: PipelineFrame ): void {

		const camera = frame.camera;
		const u = this.u;
		camera.updateMatrixWorld();
		u.projInv.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		if ( TEMPORAL ) {

			// this frame's rest (which picks the rest's jitter), jitter and motion, from the camera as
			// it is (unjittered)
			this.temporal?.beginFrame( camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.temporal );
			jitter.prepare( camera, this.width, this.height, this.outputWidth / this.width );
			beginMotionFrame( camera );
			if ( this.temporal ) {

				// (after a cut or a resize the previous frame's nearest surface is gone)
				this.temporal.setPreviousDepthValid( this.graph.historyValid( this.resources.surfaceDepthPrev! ) );
				this.temporal.upscaling = this.upscaling;

			}

		}
		if ( frame.settle ) this.settled.observe( camera, this.width, this.height, this.outputWidth, this.outputHeight, frame.time, frame.settle, this.temporal?.rest ?? null );
		this.air.update( camera );
		this.shafts.update( camera as THREE.PerspectiveCamera, this.air.haze.value, this.air.fogTransmittance( camera.position.y, this.shafts.sunDirection ),
			TEMPORAL ? jitter.uniforms.unjitteredProjection.value : camera.projectionMatrix );
		this.updateDisplay( frame );
		this.u.afterOn.value = frame.afterScene !== undefined ? 1 : 0;
		this.u.layerOn.value = this.layerRuns( frame ) ? 1 : 0;
		this.graph.execute( frame );

	}

	// The display chain's and the canvas pass's uniforms from the settings (the grade, the look,
	// the blooms, the depth of field, the grain).
	private updateDisplay( { camera, time }: PipelineFrame ): void {

		const S = this.settings;
		const u = this.u;
		const [ b, g ] = this.blooms;
		const lerp = THREE.MathUtils.lerp;
		// the bloom chains' and the look's night (see the header: a crossfade, not a threshold scaled
		// by the exposure)
		const nl = THREE.MathUtils.clamp( S.nightLook, 0, 1 ), N = S.night;
		const bloomStrength = lerp( S.bloomStrength, N.bloomStrength, nl ), bloomThreshold = lerp( S.bloomThreshold, N.bloomThreshold, nl );
		const glowStrength = lerp( S.glowStrength, N.glowStrength, nl ), glowThreshold = lerp( S.glowThreshold, N.glowThreshold, nl );
		const glowMaxLum = lerp( S.glowMaxLum, N.glowMaxLum, nl );
		if ( g ) {

			b.chain.strength.value = bloomStrength; b.chain.radius.value = S.bloomRadius; b.chain.threshold.value = bloomThreshold * SCENE_RADIANCE_SCALE; b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE; b.surfaceMaxLum.value = S.bloomSurfaceMaxLum * SCENE_RADIANCE_SCALE;
			g.chain.strength.value = glowStrength; g.chain.radius.value = S.glowRadius; g.chain.threshold.value = glowThreshold * SCENE_RADIANCE_SCALE; g.maxLum.value = glowMaxLum * SCENE_RADIANCE_SCALE; g.surfaceMaxLum.value = glowMaxLum * SCENE_RADIANCE_SCALE;

		} else {

			// One chain for both: the wide glow's radius and threshold, the tight bloom's clamps, and
			// the two strengths together (an approximation for the low tier).
			b.chain.strength.value = bloomStrength + glowStrength; b.chain.radius.value = S.glowRadius; b.chain.threshold.value = glowThreshold * SCENE_RADIANCE_SCALE;
			b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE; b.surfaceMaxLum.value = S.bloomSurfaceMaxLum * SCENE_RADIANCE_SCALE;

		}
		// The night crossfades the curve and its grade to PBR Neutral's (the grade's own night values,
		// not the GUI's, which tune the chosen curve by day).
		const look = this.looks[ S.toneMapping ], night = this.looks.neutral;
		const day = S.toneMapping === 'neutral' ? 1 : 1 - THREE.MathUtils.clamp( S.nightCurve, 0, 1 );
		u.curve.value = TONE_CURVES.indexOf( S.toneMapping ); u.day.value = day;
		u.nightGreen.value = NIGHT_GREEN_TURN * THREE.MathUtils.clamp( S.nightGreen, 0, 1 );
		u.exposure.value = S.exposure / SCENE_RADIANCE_SCALE; u.curveExposure.value = u.exposure.value * look.exposure;
		u.saturation.value = lerp( night.saturation, S.saturation, day ); u.vibrance.value = lerp( night.vibrance, S.vibrance, day ); u.contrast.value = lerp( night.contrast, S.contrast, day );
		u.clipGuard.value = look.clipGuard * day; u.highlightSat.value = look.highlightSat * day; u.knee.value = look.knee; u.burn.value = look.burn * day;
		u.split.value = S.split * lerp( night.split, look.split, day ); u.lift.value.copy( S.lift ).multiplyScalar( lerp( night.lift, look.lift, day ) );
		// The look crossfades into the night's (every parameter, the tints too), and its sunlit parts
		// (glow, highlights, lift) follow the weather's direct light; the rest holds a share of itself
		// under a closed sky, so bad weather stays dimmer and greyer than a clear day.
		// ('realistic' bypasses the layer whatever the live parameters hold, so it stays exact)
		const L = mixLook( this.lookMixed, this.look, this.lookNight, nl ), on = S.look !== 'realistic';
		const sunlit = THREE.MathUtils.smoothstep( S.lookSunlight, 0.1, 0.9 );
		u.lookOn.value = on ? 1 : 0;
		u.lookColour.value = lerp( L.overcast, 1, sunlit ); u.lookSun.value = sunlit;
		u.greenSat.value = L.greenSaturation; u.greenBright.value = L.greenBrightness; u.greenHue.value = L.greenHue;
		u.tealSat.value = L.tealSaturation; u.tealBright.value = L.tealBrightness; u.tealHue.value = L.tealHue;
		u.shadowTint.value.copy( L.shadowTint ); u.shadowTone.value = L.shadowTone;
		u.highlightTint.value.copy( L.highlightTint ); u.highlightTone.value = L.highlightTone;
		u.pivot.value = L.pivot; u.shadowLift.value = L.shadowLift; u.lookContrast.value = L.contrast; u.lookSky.value = L.sky; u.glowHalo.value = L.glowHalo;
		const d = this.diffusion.node, glow = on ? L.glow * u.lookSun.value : 0;
		this.diffusion.enabled = glow > 0; u.glowOn.value = this.diffusion.enabled ? 1 : 0;
		d.strength.value = glow; d.radius.value = L.glowRadius;
		// the threshold in the sharp image's units: display values before the curve, over its exposure
		this.diffusion.threshold.value = L.glowThreshold / Math.max( u.curveExposure.value, 1e-9 );
		// (a negative warmth cools the glow: the night's)
		u.glowTint.value.setRGB( 1 + 0.2 * L.glowWarmth, 1, 1 - 0.35 * L.glowWarmth );
		u.vignette.value = S.vignette + ( on ? L.vignette : 0 ); u.grain.value = S.grain; u.time.value = time;
		u.dof.value = S.dof; u.range.value = S.dofRange;
		u.maxRadius.value = S.dofMaxRadius * this.height / 900; // blur scales with the image, not the pixel count
		u.focus.value = S.focusDistance > 0 ? S.focusDistance : camera.position.length();
		// (what draws after the resolve fades by the same depth of field: AfterResolve.ts)
		afterFocus.focus.value = u.focus.value; afterFocus.range.value = u.range.value; afterFocus.dof.value = u.dof.value; afterFocus.radius.value = u.maxRadius.value;
		u.grainOn.value = this.upscaling ? 0 : 1;

	}

}
