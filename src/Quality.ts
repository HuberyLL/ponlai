// The quality tiers: every knob the frame's cost depends on, per tier, in one table. `?quality`
// picks the tier at load; without it the page loads high (QualityDetect.ts). The GUI's quality
// control reloads the page with it.
//
// High is the reference image and the only active tier: every trade-off of image against time is
// judged on it, at its standard: 4K output (3840x2160: 1920x1080 CSS pixels at a device pixel ratio
// of 2) rendered at 1440p (2560x1440, render scale 4/3, FSR 1's 1.5x upscale) with MSAA 4x (`aa`)
// at 60 fps, with a GPU budget of about 14 ms a frame in the normal scenes (island views, the
// meadow close up), leaving about 15 % of the 16.7 ms frame for pacing and the OS. 1440p is the
// guaranteed level: a load starts there and a paused page renders there; the dynamic render scale
// (`render`, post/DynamicResolution.ts) climbs to the display's own ratio (native 4K) with headroom
// and drops to half the output's linear resolution (1080p) when busy. The meadow is built for the island view's
// distance (main.ts starts it at 35 m): its blades stay a few pixels wide there (`grass`), so MSAA
// resolves their edges within a frame, with no history to ghost or soften. At native 4K, MSAA held
// the frame's flicker and sharpness within about 5 % of the many-sample reference from 40 to 55 m
// (one sample a pixel: a fifth to a third more flicker and grain), and 1440p with MSAA looked
// nearly the same at 1:1, a little softer, for about seven tenths of native 4K's GPU time; `taau`
// at 1440p softened the meadow to about four fifths of the reference's sharpness.
//
// Parked tiers (`PARKED_QUALITY`: medium, low) slowed every line of work down, so until they are
// revived as their own milestone they are out of the default choice (no GPU timing picks them), the
// GUI's list and the default checks (the tools' default sets name high only). Their rows stay in the
// table and keep compiling, and `?quality=medium|low` (or a tool's `--quality` / `--tiers`) still
// loads them; new work need not support them. Their last tuning: medium runs `taau` at a fixed
// budget (msaa missed 60 fps there where taau held it), its TAAU sharpening softer than high's; low runs `msaa` at a smaller budget. A revival measures them again against high.
//
// Each tier picks its anti-aliasing (the `aa` knob, post/Antialiasing.ts; `?aa` or the GUI choose
// any mode over it). Without multisampling or a temporal resolve geometric edges alias by a pixel's
// step and the meadow's widened blades are kept whole or dropped by their hash (Grass.ts), so no
// tier runs `off`. No knob alters the weather,
// clock or lighting state: a tier changes the cost, never the mood.
//
// Two kinds of knob:
// - load: compiled into materials or the frame graph (shader loops, pass structure, map sizes), read
//   once while they are built, so they change only with a reload;
// - runtime: setters the page applies through `applySkyQuality` (main.ts) at load; a debug page can
//   override them there (`s.applyQuality( { ... } )`) to time one at a time.
// Load knobs reach their modules as `water` (Water.ts; its `fftAnisotropy` goes to OceanFFT's
// output targets), `grass` (`setGrassQuality`), `shadow` (`SunShadow.setFilter`; its `water` to
// Water.ts's surface shadow), `rainShading` (`setRainShading`), `post` (`PostOptions` for
// `new Pipeline`), `environmentSource` (`Sky.setEnvironmentSource`, before the first bake),
// `frameRate` (FramePacer), `aa` (the anti-aliasing mode, post/Antialiasing.ts, which also chooses
// the tier, since the vegetation's modules read the mode as they load), `taa` (the temporal
// resolve's settings, TemporalAA.ts) and `render` (RenderScale.ts). Runtime ones: the cloud view
// (`Sky.setCloudView`), the clouds' `setDome`, `setMarch` and `setShadowRefresh`,
// `Sky.setEnvironmentCadence`, the sky bake interval, the refracted sun's interval and
// `angleGate`, and the rain's drop count. Every default in the modules themselves is high's.
// `?tier.<knob>=<value>` overrides one knob for an A/B.
//
// The parked medium and low traded a little of high's image for time, each knob judged in captures:
// one screen-space reflection ray (its 14 steps grow by 1.51, so it reaches as far as high's), a
// lighter sun-shadow filter (bilinear on vegetation, and on everything on low), fewer lawn blades
// with the canopy light per vertex, fewer sea-fog steps and depth-of-field taps, a cheaper cloud
// march and panorama refresh, slower sky bakes with the environment's PMREM on every second one
// from a 256-wide source, a coarser refracted-sun gate and fewer rain drops; low also marches the sea fog at a quarter resolution and draws fewer veil
// shells and ripple layers. Low keeps both bloom chains and the full storm foam: one merged chain
// veiled a golden-hour island in glow, and the merged foam turned the crests' streaks into
// scattered lace.
//
// This module imports types only, so the CPU-only tools can read the table under plain node.
import type { WaterQuality } from './ocean/Water.ts';
import type { GrassQuality } from './world/Grass.ts';
import type { SolarShadowTaps } from './lighting/SolarShadow.ts';
import type { CloudMarch, CloudViewScale } from './sky/Clouds.ts';
import type { PostOptions } from './post/Pipeline.ts';
import type { AAMode } from './post/Antialiasing.ts';

export const QUALITY_TIERS = [ 'low', 'medium', 'high' ] as const;
export type QualityTier = typeof QUALITY_TIERS[ number ];
export const DEFAULT_QUALITY: QualityTier = 'high';
/** Tiers out of the default choice, the GUI and the default checks; still loaded by name. */
export const PARKED_QUALITY: ReadonlyArray<QualityTier> = [ 'medium', 'low' ];
export const isParkedQuality = ( tier: string ): boolean => ( PARKED_QUALITY as readonly string[] ).includes( tier );
/** The active tiers (today high alone). */
export const ACTIVE_QUALITY: ReadonlyArray<QualityTier> = QUALITY_TIERS.filter( ( tier ) => ! isParkedQuality( tier ) );

/** How the scene's render scale (its pixel ratio relative to CSS pixels) is chosen. */
export type RenderScaleRule =
	// a fixed budget of rendered pixels (the scale follows the window's size)
	| { budget: number }
	// dynamic resolution: from `max` (capped by the display's own ratio) down to `floorShare` of the
	// canvas's pixel ratio (the output's linear resolution) in `step`s, steered by the GPU's frame
	// time (post/DynamicResolution.ts); a share keeps a 1x display's floor below its maximum. A load,
	// a paused page and a pinned one render at the baseline, `baselineShare` of the maximum.
	| { dynamic: { max: number; baselineShare: number; floorShare: number; step: number } };

/** The temporal resolve's settings (taa and taau; read once as the resolve is built). */
export interface TemporalSettings {
	// the history's effective frame count (its blend weight 1 / n) for a still pixel and for one
	// moving `speedFull` render pixels a frame or more (eased between). 24 still (12 before M14):
	// with the movers' motion cap (TemporalAA.ts) a moving pixel keeps at most 10 whatever this is,
	// so the longer still history no longer lengthens the islanders' trail (the islander walk's
	// ghosting at 24 with the movers no higher than at 12 without), and the second stage
	// (`taaSmooth`), which averages the history's image again over as many frames, needs the 24 to
	// take a still camera's sunlit meadow to within twice MSAA's high-pass flicker (2.4 times at
	// 12). The debug flags that turn the movers or the second stage off leave it at 24; lite (no
	// movers, no second stage) keeps 12.
	framesStill: number;
	// the sea's still frame count (its class share and `waterFar` apply to it as to `framesStill`):
	// held apart so a longer still history elsewhere does not lengthen it (a longer one, 24, raised the
	// ghosting and softened the horizon in sea pans)
	framesStillWater: number;
	framesMoving: number;
	speedFull: number;
	// the neighbourhood clip box's width in standard deviations (variance clipping after Salvi),
	// still and moving
	gammaStill: number;
	gammaMove: number;
	// per surface class (Motion.ts MOTION_CLASS: opaque, vegetation, water, character, sky): the share
	// of the history's frames it keeps, and what it adds to the clip box's width
	classFrames: number[];
	classGamma: number[];
	// the view distance (m) over which the sea's share of the history grows from its class's to a whole
	// one (its waves' phase motion, which the motion vectors leave out, shrinks under a pixel far off)
	waterFar: number[];
	// the sea's glints' reactive weight (Water.ts): from 0 at `from` to `max` at `to` times the
	// luminance of a white diffuse surface under the same light
	glintReactive: { from: number; to: number; max: number };
	// the reconstruction filter's Gaussian width (input pixels), running and while the scene rests
	sigma: number;
	sigmaRest: number;
	// the output's sharpening: taa's, and taau's at an upscale of 1 and of 2 per axis (eased between).
	// High's taau at its baseline's 1.5 sat 9 % sharper than the ground truth at rest (overshoot beyond
	// its range about 4x fsr3's) and flickered more in motion; swept on the Lanczos history fetch
	// (TemporalHistory.ts) from 0.75 to 2 stops at 1.5, 1.25 (1.5 / 1.0) was the softest that kept the
	// clips' ghosting (0.137 against 0.136): at rest FLIP against the ground truth 0.049 -> 0.045, the
	// sharpness 1.09 -> 1.03, the overshoot halved; in motion the shimmer (TI) and high-pass flicker
	// 3 % and 5 % lower, at fsr3's, FLIP unchanged, the sharpness 0.95 -> 0.90 of the ground truth's.
	// Softer still raised the pans' ghosting (0.088 -> 0.095 with none).
	sharpness: { taa: number; taau: [ number, number ] };
	// more sharpening where a surface moves on screen (the history's resampling softens moving detail):
	// RCAS stops taken off the sharpening at `speed` output pixels a frame and over, per surface class
	// (as classFrames; all 0: none, and the canvas pass reads no motion; read at load)
	sharpenMoving: { stops: number[]; speed: number };
	// the sky (far depth) resolved from the current frame without a history
	skyPassThrough: boolean;
	// accumulate in linear light (the display curve undone) rather than display values
	linear: boolean;
	// a resting scene (paused clock, still camera): frames rendered before the jitter sequence
	// starts, and the jitter sequence's length, after which the image holds (D10)
	restSettle: number;
	restSequence: number;
	// the cheaper resolve (fewer taps, no reactive mask) for the lowest tier
	lite: boolean;
	// the ground truth's jitter count (`aa=gt`, debug builds: the rest's sequence at the canvas's
	// resolution, box-filtered): 64 for a still image, 32 (`tier.taa.gtJitters=32`) per frame of a clip
	gtJitters: number;
	// FSR 3 (`aa=fsr3`, post/fsr3/Fsr3Upscaler.ts): its RCAS sharpness (0 the least, RCAS at two
	// stops of attenuation, 1 the most), the rest's jitter sequence (frames from FSR's reset at the rest's start,
	// repeating FSR's phase sequence), and whether the reactive-mask generator runs. The sequence is
	// the shortest multiple of the paused page's phase count (18: 4K output rendered at 1440p) after
	// which a rest of twice its length differs from it by more than one level in under 0.1 % of the
	// pixels on three close views: 126 (7 phases; 108 left 0.16 % on the meadow, 126 0.075 %).
	// FSR blends each frame into a running history rather than averaging the sequence, so its rest
	// needs far more frames than taa's 32 (measured at 4K output; a 1600x900 page has phase 18 too).
	// The sharpness is 0, not AMD's sample's 0.8: against the ground truth's rest on twelve crops of
	// three views (4K output), 0.8 sharpened past it (its mean gradient 1.11-1.29 times the ground
	// truth's on the meadow) and raised the error by 15 % (1 by 35 %); 0 lands within 5 % of the
	// ground truth's gradient and is as close as RCAS turned off, and it lowered the cliff edge's
	// flicker against the sky by about a fifth.
	fsr3: { sharpness: number; restSequence: number; autoReactive: boolean };
}

export interface QualityProfile {

	// ---- load
	// the scene's anti-aliasing (post/Antialiasing.ts; `?aa` overrides it) and the temporal modes'
	// resolve
	aa: AAMode;
	taa: TemporalSettings;
	render: RenderScaleRule;
	water: WaterQuality;
	// the frame graph's structural options (sea fog, depth of field, bloom); the rest keep their
	// defaults
	post: Pick<PostOptions, 'fogScale' | 'fogSteps' | 'bankSize' | 'dofTaps' | 'bloomChains'>;
	// the sun shadow's filter, for most receivers, for vegetation and for the sea's surface (both
	// stepped maps alike). On the sea it shades only the glints and the subsurface glow, so a lighter
	// filter there shows little at noon.
	shadow: { surface: SolarShadowTaps; vegetation: SolarShadowTaps; water: SolarShadowTaps };
	grass: GrassQuality;
	// the rain veil's shells and the sea's ripple layers
	rainShading: { veilShells: number; rippleLayers: number };
	// the environment's PMREM source width (fixes the atlases' size before the first bake)
	environmentSource: number;
	// the frame rate the loop holds on a display faster than that (post/FramePacer.ts: 60 renders on
	// every second refresh at 120 Hz), or 0 to render on every refresh
	frameRate: number;

	// ---- runtime
	cloudView: CloudViewScale;
	// the cloud panorama's size and its refresh pattern (one texel of every strideX x strideY per frame)
	cloudDome: { width: number; height: number; strideX: number; strideY: number };
	cloudMarch: CloudMarch;
	// the share of the cloud shadow map's rows refreshed per frame
	cloudShadowRows: number;
	// seconds of wall time between periodic sky bakes, and the environment's PMREM on every nth one
	skyUpdateInterval: number;
	environmentEvery: number;
	// the refracted sun's map: the least interval between redraws (s) and the key light's turn (deg)
	// that redraws it
	refractedSun: { interval: number; angleGate: number };
	rainDrops: number;

}

const PCSS_HIGH: SolarShadowTaps = { soft: true, blockerSamples: 6, filterSamples: 8 };
// high's sea surface: in a sweep against PCSS_HIGH the error stayed flat down to 4 / 5 (the
// change sits on the glints' edges, unseen side by side); 3 / 4 came out no faster
const PCSS_LIGHT: SolarShadowTaps = { soft: true, blockerSamples: 4, filterSamples: 5 };
const BILINEAR: SolarShadowTaps = { soft: false, blockerSamples: 0, filterSamples: 0 };
const TAA: TemporalSettings = {
	framesStill: 24, framesStillWater: 12, framesMoving: 5, speedFull: 16, gammaStill: 1.25, gammaMove: 0.75,
	classFrames: [ 1, 1, 0.4, 0.8, 0 ], classGamma: [ 0, 0.25, 0, - 0.25, 0 ], waterFar: [ 150, 600 ], glintReactive: { from: 2, to: 8, max: 1 },
	sigma: 0.42, sigmaRest: 0.30,
	sharpness: { taa: 1.0, taau: [ 1.5, 1.0 ] }, sharpenMoving: { stops: [ 0, 0, 1, 0, 0 ], speed: 4 }, skyPassThrough: true, linear: true, restSettle: 8, restSequence: 32, lite: false,
	gtJitters: 64,
	fsr3: { sharpness: 0, restSequence: 126, autoReactive: false },
};

export const QUALITY: Readonly<Record<QualityTier, Readonly<QualityProfile>>> = {
	high: {
		aa: 'msaa',
		taa: { ...TAA },
		render: { dynamic: { max: 2, baselineShare: 2 / 3, floorShare: 0.5, step: 0.05 } },
		water: { ssrRays: 2, ssrSteps: 20, ssrGrowth: 1.3, ssrMinFresnel: 0.05, ssrOneRayFresnel: 0.05, stormFoam: 'full', fftAnisotropy: 4 },
		post: { fogScale: 0.5, fogSteps: 12, bankSize: 2048, dofTaps: 16, bloomChains: 2 },
		shadow: { surface: PCSS_HIGH, vegetation: PCSS_HIGH, water: PCSS_LIGHT },
		// 16 of each tuft's 48 blades, the kept ones three times as wide (they widen to keep the
		// cover): from the island view's 30 - 40 m a blade stays a few pixels wide, so a frame
		// without anti-aliasing at the canvas's size comes close to the many-sample reference, where
		// 48 thin blades grain and flicker about twice as much
		grass: { lawnBlades: [ 16, 16, 16 ], bladeBands: [ 1000, 1001, 1002 ], thinTufts: true, canopyPerVertex: false, minWidth: 0 },
		rainShading: { veilShells: 3, rippleLayers: 2 },
		environmentSource: 512,
		frameRate: 60,
		cloudView: { display: 0.45 },
		cloudDome: { width: 1024, height: 256, strideX: 4, strideY: 8 },
		cloudMarch: { viewSteps: 256, panoramaSteps: 128, lightTaps: 5, rainSteps: 16 },
		cloudShadowRows: 1 / 8,
		skyUpdateInterval: 0.5,
		environmentEvery: 1,
		refractedSun: { interval: 0.08, angleGate: 0.03 },
		rainDrops: 49152,
	},
	medium: {
		aa: 'taau',
		// TAAU's sharpening softer than high's (higher is softer)
		taa: { ...TAA, sharpness: { taa: TAA.sharpness.taa, taau: [ 2.0, 1.5 ] } },
		render: { budget: 1600 * 900 },
		water: { ssrRays: 1, ssrSteps: 14, ssrGrowth: 1.51, ssrMinFresnel: 0.05, ssrOneRayFresnel: 0.05, stormFoam: 'full', fftAnisotropy: 4 },
		post: { fogScale: 0.5, fogSteps: 8, bankSize: 2048, dofTaps: 16, bloomChains: 2 },
		shadow: { surface: PCSS_LIGHT, vegetation: BILINEAR, water: PCSS_LIGHT },
		grass: { lawnBlades: [ 12, 8, 4 ], bladeBands: [ 25, 45, 70 ], thinTufts: false, canopyPerVertex: true, minWidth: 2 },
		rainShading: { veilShells: 3, rippleLayers: 2 },
		environmentSource: 256,
		frameRate: 60,
		cloudView: { render: 0.5 },
		cloudDome: { width: 1024, height: 256, strideX: 8, strideY: 8 },
		cloudMarch: { viewSteps: 192, panoramaSteps: 128, lightTaps: 5, rainSteps: 16 },
		cloudShadowRows: 1 / 8,
		skyUpdateInterval: 1.2,
		environmentEvery: 2,
		refractedSun: { interval: 0.12, angleGate: 0.05 },
		rainDrops: 32768,
	},
	low: {
		aa: 'msaa',
		taa: { ...TAA, lite: true, framesStill: 12 },
		render: { budget: 1280 * 720 },
		// (one bloom chain veiled a golden-hour island in glow, and the merged storm foam turned
		// the crests' streaks into scattered lace: both kept as on high)
		water: { ssrRays: 1, ssrSteps: 14, ssrGrowth: 1.51, ssrMinFresnel: 0.05, ssrOneRayFresnel: 0.05, stormFoam: 'full', fftAnisotropy: 4 },
		post: { fogScale: 0.25, fogSteps: 8, bankSize: 1024, dofTaps: 16, bloomChains: 2 },
		shadow: { surface: BILINEAR, vegetation: BILINEAR, water: BILINEAR },
		grass: { lawnBlades: [ 8, 8, 4 ], bladeBands: [ 25, 45, 70 ], thinTufts: false, canopyPerVertex: true, minWidth: 2 },
		rainShading: { veilShells: 2, rippleLayers: 1 },
		environmentSource: 256,
		// light enough to render on most refreshes of a fast display: held to 60 Hz there, its
		// frames finished right at the compositor's deadline and were shown one or three refreshes
		// apart in turn (a quarter of them), where unpaced they keep the refresh's own steps
		frameRate: 0,
		cloudView: { render: 0.4 },
		cloudDome: { width: 768, height: 192, strideX: 8, strideY: 8 },
		cloudMarch: { viewSteps: 128, panoramaSteps: 96, lightTaps: 3, rainSteps: 10 },
		cloudShadowRows: 1 / 8,
		skyUpdateInterval: 2,
		environmentEvery: 2,
		refractedSun: { interval: 0.2, angleGate: 0.1 },
		rainDrops: 16384,
	},
};

export function isQualityTier( value: unknown ): value is QualityTier {

	return typeof value === 'string' && ( QUALITY_TIERS as readonly string[] ).includes( value );

}

/** The tier's profile with `?tier.<knob path>=<value>` options over it, for A/B captures of one
 * knob (`tier.post.fogScale=0.5`, `tier.water.ssrRays=2`, `tier.grass.lawnBlades=16,8,4`,
 * `tier.shadow.water.soft=false`). A path
 * must name an existing knob; numbers, booleans and comma lists are parsed. */
export function qualityProfile( tier: QualityTier, search = location.search ): QualityProfile {

	// a JSON copy, not structuredClone: that keeps the table's shared objects shared (high's surface
	// and vegetation shadow filters are one PCSS_HIGH), so an override of one knob would change its
	// siblings too
	const profile = JSON.parse( JSON.stringify( QUALITY[ tier ] ) ) as QualityProfile;
	for ( const [ key, raw ] of new URLSearchParams( search ) ) {

		if ( ! key.startsWith( 'tier.' ) ) continue;
		const path = key.slice( 5 ).split( '.' );
		let node = profile as unknown as Record<string, unknown>;
		for ( const name of path.slice( 0, - 1 ) ) node = node?.[ name ] as Record<string, unknown>;
		const last = path[ path.length - 1 ];
		if ( ! node || typeof node !== 'object' || ! ( last in node ) ) throw new RangeError( `Unknown quality knob: ${ key }` );
		const parse = ( v: string ): unknown => v === 'true' ? true : v === 'false' ? false : v !== '' && Number.isFinite( Number( v ) ) ? Number( v ) : v;
		node[ last ] = Array.isArray( node[ last ] ) ? raw.split( ',' ).map( parse ) : parse( raw );

	}
	return profile;

}
