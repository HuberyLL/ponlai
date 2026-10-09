import * as THREE from 'three/webgpu';
import {
	Fn, If, Loop, texture, textureLoad, rtt, uniform, uv, screenCoordinate, ivec2, int, vec2, vec3, vec4, float, mix,
	smoothstep, clamp, max, min, dot, length, abs, sqrt, cos, sin, log2, luminance, neutralToneMapping, agxToneMapping,
	sRGBTransferOETF, fract, convertToTexture, select, exp, nodeObject, atan, mod, pow,
} from 'three/tsl';
import BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { fsr1 } from 'three/addons/tsl/display/FSR1Node.js';
import { SCENE_RADIANCE_SCALE } from '../lighting/Radiometry.ts';
import { AerialPerspective, DEFAULT_AIR_OPTIONS, type AirOptions } from '../weather/AerialPerspective.ts';
import { LightShafts } from './LightShafts.ts';
import { FSR } from './FSR.ts';
import { sizeRtt } from './RenderScale.ts';
import { SCENE_SAMPLES } from './SceneSamples.ts';
import { debugFlags } from '../debug/DebugFlags.ts';
import { DAY_BLACK_LIFT } from '../sky/DayCycle.ts';
import type { Sky } from '../sky/Sky.ts';
import type { Rain } from '../weather/Rain.ts';

// Frame graph:
//   opaque scene ── sceneRT (MSAA, SCENE_SAMPLES, half float, multisampled depth)
//   depth resolve ── depthRT (view-space z of the opaque pass: sample 0, and the farthest sample)
//   opaque copy ── opaqueRT (the resolved opaque colour: what the water refracts and reflects)
//   water ── back into sceneRT, depth-tested per sample against the opaque samples
//   surface resolve ── surfaceRT (view-space z of the nearest surface, the sea's included)
//   rain ── into sceneRT (its multisampled colour and depth are then discarded: nothing reads them;
//   without rain the water's multisampled colour is discarded instead)
//   sea fog (in fog: the bank noise baked into a map, the march at half resolution), the view
//   distance for the depth of field
//   composite (air, fog, rain veil, shafts) ── hdr, once
//   bloom (tight) + glow (wide) from hdr, both through a clamped soft-knee prefilter ── sharp
//   ── tilt-shift depth of field (half-res gather) ── exposure, tone curve (PBR Neutral with
//   hue-kept highlights by default), split-tone grade, vibrance, the art-directed look (diffusion
//   glow, hue-selective colour, warm / cool split, coloured shadow lift), lifted blacks, vignette,
//   S-curve, sRGB, grain ── displayRT
//   ── copied to the screen
// Every pass runs at the scene's render size. When the canvas is larger (a quality preset below
// the display's resolution), displayRT goes through FSR 1 (edge-adaptive upsampling, then
// contrast-adaptive sharpening) to the screen instead, and the grain is added there, at display
// pixels.

/** The frame graph's structural choices, fixed when the page loads (the quality tier sets them;
 * the defaults are today's high). `?post=legacy` restores the graph before they were introduced,
 * for A/B timing; `?post=` also takes a comma list of single switches (see `postOptionsFromURL`). */
export interface PostOptions extends AirOptions {
	// the composite evaluated once into a texture both blooms read (else each re-evaluates it)
	compositeOnce: boolean;
	// the depth of field's gather taps
	dofTaps: number;
	// the depth of field reads the view distance from a target written once per pixel (else each
	// tap derives it from the depth)
	dofDistance: boolean;
	// two bloom chains (tight and wide), or one with the wide glow's radius and the two strengths
	bloomChains: 1 | 2;
	// FSR 1 from FSR.ts (EASU pass, sharpening folded into the canvas pass), or three's FSR1Node
	fsrPort: boolean;
	// the last pass into the multisampled scene target discards its samples
	discardScene: boolean;
}

export const DEFAULT_POST_OPTIONS: Readonly<PostOptions> = {
	...DEFAULT_AIR_OPTIONS, compositeOnce: true, dofTaps: 36, dofDistance: true, bloomChains: 2, fsrPort: true, discardScene: true,
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

// BloomNode sizes its chain to the canvas every frame; this one follows the scene's render
// instead, so the glow keeps its size and cost when the frame is upscaled.
class RenderBloomNode extends BloomNode {

	renderWidth = 1;
	renderHeight = 1;
	// false skips the chain (the look's diffusion, under the realistic look)
	enabled = true;

	override setSize(): void {

		super.setSize( this.renderWidth, this.renderHeight );

	}

	override updateBefore( frame: Parameters<BloomNode[ 'updateBefore' ]>[ 0 ] ): boolean | undefined {

		return this.enabled ? super.updateBefore( frame ) : undefined;

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
// The night keeps PBR Neutral's look whichever curve is chosen (see `nightLook`): its toe, which
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

export interface PipelineSettings {
	toneMapping: ToneCurve;
	look: LookName;
	// sunlight reaching the island through the weather (0 under a storm's deck, 1 clear)
	lookSunlight: number;
	// 0 by day, 1 at night (from the clock): how far the frame returns to PBR Neutral's look
	nightLook: number;
	exposure: number; saturation: number; vibrance: number; contrast: number; split: number;
	lift: THREE.Color; vignette: number; grain: number;
	bloomStrength: number; bloomRadius: number; bloomThreshold: number; bloomMaxLum: number; bloomSurfaceMaxLum: number;
	glowStrength: number; glowRadius: number; glowThreshold: number; glowMaxLum: number;
	dof: number; dofRange: number; dofMaxRadius: number; focusDistance: number;
}

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
	// 'neutral-hue' keeps PBR Neutral's grade, plus that knee and a little saturation for bright
	// colours only. Its shoulder packs everything bright into the last few percent below white,
	// where the split tone's golden highlights pushed red alone against white across a sunset sky;
	// the knee starts lower than AgX's to leave red room for gradation. The extra saturation gives
	// a low sun's sky and sea the colour they have under 'agx-hue' without regrading the sea and
	// land, which stay darker than its window. Both are released (`burn`) for scene colours from
	// eight to 32 times white, above the brightest sky: the knee alone held every channel below
	// about 0.95, and the curve's shoulder packs everything above white into its last few
	// percent, so the sun's glints on the sea read as one flat peach. Released, their whitened
	// cores clip to white, where a single pinned channel no longer shows as a band.
	readonly looks: Record<ToneCurve, ToneLook> = {
		'agx-hue': { exposure: 0.78, saturation: 1.2, vibrance: 0.3, contrast: 0.38, split: 1, lift: 1, clipGuard: 1, knee: 0.9, highlightSat: 0, burn: 0 },
		agx: { exposure: 0.8, saturation: 1.3, vibrance: 0.4, contrast: 0.35, split: 1, lift: 1, clipGuard: 0, knee: 0.9, highlightSat: 0, burn: 0 },
		neutral: { exposure: 1, saturation: 0.97, vibrance: 0.15, contrast: 0.04, split: 1, lift: 1, clipGuard: 0, knee: 0.9, highlightSat: 0, burn: 0 },
		'neutral-hue': { exposure: 1, saturation: 0.97, vibrance: 0.15, contrast: 0.04, split: 1, lift: 1, clipGuard: 1, knee: 0.8, highlightSat: 0.3, burn: 1 },
	};
	// The fantasy presets are tuned on 'neutral-hue'. Its linear midtones pass the glow (added
	// before the curve) through almost as it is, and its shoulder keeps the glow's warm hue where
	// AgX's compressed and whitened it, so the glow is weaker, narrower and less warm than it was on
	// AgX; and its darker, more saturated toe made the coloured shadow lift read as haze on the deep
	// water, so the lift and the cool shadow tone are smaller too.
	readonly lookPresets: Record<LookName, LookSettings> = {
		realistic: {
			glow: 0, glowThreshold: 0.6, glowRadius: 0.8, glowWarmth: 0, glowHalo: 1,
			greenSaturation: 0, greenBrightness: 0, greenHue: 0, tealSaturation: 0, tealBrightness: 0, tealHue: 0,
			shadowTint: new THREE.Color( 1, 1, 1 ), shadowTone: 0, highlightTint: new THREE.Color( 1, 1, 1 ), highlightTone: 0, pivot: 0.3,
			shadowLift: 0, contrast: 0, vignette: 0, sky: 1, overcast: 0,
		},
		'soft-fantasy': {
			glow: 0.12, glowThreshold: 1.0, glowRadius: 0.7, glowWarmth: 0.25, glowHalo: 0.15,
			greenSaturation: 0.25, greenBrightness: 0.02, greenHue: 0.06, tealSaturation: 0.12, tealBrightness: 0.02, tealHue: 0.04,
			shadowTint: new THREE.Color( 0.55, 0.85, 1.0 ), shadowTone: 0.18, highlightTint: new THREE.Color( 1.0, 0.86, 0.6 ), highlightTone: 0.25, pivot: 0.18,
			shadowLift: 0.01, contrast: 0.08, vignette: 0.06, sky: 0.25, overcast: 0.5,
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

	settings: PipelineSettings = {
		toneMapping: 'neutral-hue', look: 'realistic', lookSunlight: 1, nightLook: 0,
		// The look's bright midtones and soft shadows are a display grade; keep the
		// calibrated sunlight and water transport intact, with a nearly neutral black lift.
		exposure: 2.35, saturation: 0.97, vibrance: 0.15, contrast: 0.04, split: 0.45,
		lift: new THREE.Color( DAY_BLACK_LIFT, DAY_BLACK_LIFT, DAY_BLACK_LIFT * 0.97 ),
		vignette: 0.06, grain: 0.004,
		bloomStrength: 0.22, bloomRadius: 0.3, bloomThreshold: 1.4, bloomMaxLum: 4.0, bloomSurfaceMaxLum: 2.0,
		glowStrength: 0.1, glowRadius: 1.0, glowThreshold: 0.8, glowMaxLum: 1.0,
		dof: 0.65, dofRange: 8.0, dofMaxRadius: 6.0, focusDistance: 0,
	};

	// The canvas's size; larger than width x height while the frame is upscaled.
	outputWidth = 1;
	outputHeight = 1;
	// RCAS sharpening after the upscale, in stops (0 the strongest, 2 none). AMD's default 0.2
	// sharpened the meadow past the native render's detail; at 0.6 the upscaled cliff matches
	// native and the meadow keeps most of it, without ringing.
	readonly sharpness = uniform( 0.6 );

	sceneRT: THREE.RenderTarget;
	depthRT: THREE.RenderTarget;
	opaqueRT: THREE.RenderTarget;
	surfaceRT: THREE.RenderTarget;
	readonly air: AerialPerspective;
	readonly shafts = new LightShafts();
	readonly options: Readonly<PostOptions>;

	private depthQuad: THREE.QuadMesh;
	private copyQuad: THREE.QuadMesh;
	private surfaceQuad: THREE.QuadMesh;
	private output: THREE.RenderPipeline;
	private upscaledOutput: THREE.RenderPipeline;
	// three's FSR1Node, kept for A/B (debugFlags.fsrPort = false, or the fsrPort option off)
	private upscaledOutputThree: THREE.RenderPipeline;
	private fsr: FSR;
	// the view distance per pixel, for the depth of field (the dofDistance option)
	private distanceRT: THREE.RenderTarget | null = null;
	private distanceQuad: THREE.QuadMesh | null = null;
	// set while the last pass into sceneRT is recorded (the discardScene option): 'all' discards
	// its multisampled colour and depth, 'colour' only the colour (the surface resolve still reads
	// the depth)
	private discardSamples: 'none' | 'colour' | 'all' = 'none';
	private warming: Promise<void> | null = null;
	// the graded image at the render's size, before the copy or upscale to the canvas
	private display: THREE.RenderPipeline;
	private displayRT: THREE.RenderTarget;
	// passes sized with the scene's render, not the canvas
	private passes: THREE.RTTNode[] = [];
	private blooms: { node: RenderBloomNode; maxLum: THREE.UniformNode<'float', number>; surfaceMaxLum: THREE.UniformNode<'float', number> }[] = [];
	private u = {
		// (exposure: the clock's, for PBR Neutral and the depth of field; curveExposure: with the
		// chosen curve's gain; day: 1 - the night's return to PBR Neutral)
		curve: uniform( 0 ), day: uniform( 1 ), exposure: uniform( 1 ), curveExposure: uniform( 1 ), saturation: uniform( 1 ), vibrance: uniform( 0 ), contrast: uniform( 0 ), split: uniform( 1 ), clipGuard: uniform( 0 ), knee: uniform( 0.9 ), highlightSat: uniform( 0 ), burn: uniform( 0 ),
		lift: uniform( new THREE.Color() ), vignette: uniform( 0.3 ), grain: uniform( 0.01 ), time: uniform( 0 ),
		dof: uniform( 1 ), focus: uniform( 50 ), range: uniform( 3 ), resolution: uniform( new THREE.Vector2( 1, 1 ) ),
		// the scene camera's (inside a full-screen pass the camera nodes refer to the pass's own camera)
		projInv: uniform( new THREE.Matrix4() ),
		maxRadius: uniform( 6 ), texel: uniform( new THREE.Vector2( 1, 1 ) ), halfRes: uniform( new THREE.Vector2( 1, 1 ) ),
		output: uniform( new THREE.Vector2( 1, 1 ) ), grainOn: uniform( 1 ),
		// the look (lookOn 0 skips it, so 'realistic' is exactly the curve's grade; lookColour and
		// lookSun are its weights with and without sunlight, both 0 at night)
		lookOn: uniform( 0 ), glowOn: uniform( 0 ), lookColour: uniform( 0 ), lookSun: uniform( 0 ), glowTint: uniform( new THREE.Color( 1, 1, 1 ) ),
		greenSat: uniform( 0 ), greenBright: uniform( 0 ), greenHue: uniform( 0 ), tealSat: uniform( 0 ), tealBright: uniform( 0 ), tealHue: uniform( 0 ),
		shadowTint: uniform( new THREE.Color( 1, 1, 1 ) ), shadowTone: uniform( 0 ), highlightTint: uniform( new THREE.Color( 1, 1, 1 ) ), highlightTone: uniform( 0 ),
		pivot: uniform( 0.3 ), shadowLift: uniform( 0 ), lookContrast: uniform( 0 ), lookSky: uniform( 1 ), glowHalo: uniform( 1 ),
	};
	private diffusion!: { node: RenderBloomNode; threshold: THREE.UniformNode<'float', number> };

	constructor( renderer: THREE.WebGPURenderer, sky: Sky, rain?: Rain, options: Partial<PostOptions> = postOptionsFromURL() ) {

		this.renderer = renderer;
		this.options = { ...DEFAULT_POST_OPTIONS, ...options };
		const O = this.options;
		this.air = new AerialPerspective( O );
		const depthTexture = new THREE.DepthTexture( 1, 1 );
		depthTexture.type = THREE.FloatType;
		this.sceneRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, samples: SCENE_SAMPLES, depthTexture } );
		this.sceneRT.texture.name = 'sceneColor';
		this.depthRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RGFormat, depthBuffer: false } );
		this.depthRT.texture.name = 'linearDepth';
		this.opaqueRT = new THREE.RenderTarget( 1, 1, { type: THREE.HalfFloatType, depthBuffer: false } );
		this.opaqueRT.texture.name = 'opaqueColor';
		this.surfaceRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } );
		this.surfaceRT.texture.name = 'surfaceDepth';

		const u = this.u;
		// Multisampled depth can only be loaded, a sample at a time. The sky stays far away (-1e5).
		const viewZ = ( coord: V2, d: F ) => {

			const z = float( - 1e5 ).toVar();
			If( d.lessThan( 0.999999 ), () => {

				const q = coord.div( u.resolution );
				const v = u.projInv.mul( vec4( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ), d, 1 ) ).toVar();
				z.assign( v.z.div( v.w ) );

			} );
			return z;

		};
		const msDepth = texture( depthTexture );
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
		const copyMat = new THREE.NodeMaterial();
		copyMat.fragmentNode = textureLoad( texture( this.sceneRT.texture ), ivec2( screenCoordinate.xy ) );
		this.copyQuad = new THREE.QuadMesh( copyMat );
		const surfaceMat = new THREE.NodeMaterial();
		surfaceMat.fragmentNode = Fn( () => vec4( viewZ( screenCoordinate.xy, depthSample( screenCoordinate.xy, 0 ) ) ) )();
		this.surfaceQuad = new THREE.QuadMesh( surfaceMat );

		// ---- composite: the scene target holds the opaque image with the sea and the rain drawn over it
		const sceneTex = texture( this.sceneRT.texture );
		const surfaceDepth = this.surfaceRT.texture;
		const composited = this.air.apply( sceneTex.rgb, surfaceDepth, sky, rain ? ( d, distance, background ) => rain.veil( d, distance, background ) : undefined )
			.add( this.shafts.build( surfaceDepth, sky ) );
		// Rendered once, the composite feeds the sharp image and both blooms' high passes; as an
		// expression each of them evaluated it again, the sea fog's march included. The high passes
		// run at half resolution and sample it bilinearly, as they sampled the scene colour before.
		const hdrRT = O.compositeOnce ? convertToTexture( vec4( composited, 1 ) ) : null;
		if ( hdrRT ) this.passes.push( hdrRT );
		const hdr: V3 = hdrRT ? hdrRT.rgb : composited;
		const bloomInput = hdrRT ? nodeObject( hdrRT ) : nodeObject( vec4( hdr, 1 ) );

		// ---- blooms: glints clamped first so a few firefly pixels cannot flood the frame, then a
		// soft knee instead of a hard threshold. On surfaces (anything in front of the sky) the
		// tight bloom's clamp sits just above its threshold (bloomSurfaceMaxLum 2 against 1.4):
		// every pixel of the sun's glitter path reaches the clamp, so a higher one let the path's
		// bloom pile up into a bright column over the island. The sky keeps the higher clamp, so
		// the sun's disc and a lightning channel (drawn without depth) keep their glow.
		const tBloomD = texture( surfaceDepth );
		const makeBloom = () => {

			const maxLum = uniform( 5 ), surfaceMaxLum = uniform( 5 );
			const node = new RenderBloomNode( bloomInput, 0.3, 0.5, 1.5 );
			( node as unknown as { highPassFn: unknown } ).highPassFn = Fn( ( { input, threshold }: { input: THREE.Node<'vec4'>; threshold: THREE.Node<'float'> } ) => {

				const px = ivec2( clamp( uv().mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
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
			this.blooms.push( { node, maxLum, surfaceMaxLum } );
			return node;

		};

		// (one chain: the wide glow's radius and both strengths, see render())
		const withBloom = O.bloomChains === 2 ? hdr.add( makeBloom().rgb ).add( makeBloom().rgb ) : hdr.add( makeBloom().rgb );

		// ---- tilt-shift depth of field: a half-res gather over a golden-angle disc whose radius grows
		// with the circle of confusion; a sample only counts where its blur reaches this pixel, then
		// the blur is mixed over the sharp image by the full-resolution coc
		const sharp = convertToTexture( vec4( withBloom, 1 ) );
		if ( ! hdrRT ) this.passes.push( sharp );
		const tD = texture( surfaceDepth );
		// The distance to the nearest surface, the water's included (view-space z: closer is larger).
		const distanceAt = ( q: V2, z: F ) => {

			const ndc = vec2( q.x.mul( 2 ).sub( 1 ), float( 1 ).sub( q.y ).mul( 2 ).sub( 1 ) ).toVar();
			const dist = float( 1e5 ).toVar();
			If( z.greaterThan( - 9e4 ), () => {

				const v = u.projInv.mul( vec4( ndc, 1, 1 ) ).toVar();
				const dir = v.xyz.div( v.w ).toVar();
				dist.assign( length( dir.mul( z.div( dir.z ) ) ) );

			} );
			return dist;

		};
		// Written once per pixel, in full float: the gather's taps then read it instead of each
		// deriving it from the depth (half float tied distances, and the depth order below flipped).
		let tDistance: THREE.TextureNode | null = null;
		if ( O.dofDistance ) {

			this.distanceRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false } );
			this.distanceRT.texture.name = 'viewDistance';
			const distanceMat = new THREE.NodeMaterial();
			distanceMat.name = 'Post.ViewDistance';
			distanceMat.fragmentNode = Fn( () => {

				const px = ivec2( screenCoordinate.xy );
				return vec4( distanceAt( uv(), ( textureLoad( tD, px ) as unknown as F ).toVar() ), 0, 0, 1 );

			} )();
			this.distanceQuad = new THREE.QuadMesh( distanceMat );
			this.distanceQuad.name = 'Post.ViewDistance';
			tDistance = texture( this.distanceRT.texture );

		}
		// The circle of confusion (0..1 of the widest blur) and the distance. One function per pass:
		// a layout function shared by two shaders keeps the first one's uniform bindings.
		const makeCocAt = () => Fn( ( [ q ]: [ V2 ] ) => {

			const px = ivec2( clamp( q.mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
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
			const acc = compress( texture( sharp, q ).level( float( 0 ) ).rgb ).toVar(), wsum = float( 1 ).toVar();
			Loop( TAPS, ( { i } ) => {

				const fi = float( i );
				const r = sqrt( fi.add( 0.5 ).div( TAPS ) ).toVar();
				const a = fi.mul( GA );
				const o = vec2( cos( a ), sin( a ) ).mul( r ).mul( u.maxRadius ).mul( u.texel );
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
				acc.addAssign( compress( texture( sharp, p ).level( float( 0 ) ).rgb ).mul( w ) );
				wsum.addAssign( w );

			} );
			const mean = acc.div( max( wsum, 1e-4 ) ).toVar();
			// the inverse of compress(): the mean's compressed luminance stays below one (the floor
			// caps an expanded mean near a thousand times display white, far past what the grade shows)
			return vec4( mean.div( max( float( 1 ).sub( luminance( mean ).mul( u.exposure ) ), 1e-3 ) ), c0 );

		} )();
		const blur = rtt( gather, null, null, { type: THREE.HalfFloatType, resolutionScale: 0.5 } );
		this.passes.push( blur );
		// (after the composite and the blur, so the profiler's labels for passes[ 0 ] and [ 1 ] hold)
		if ( hdrRT ) this.passes.push( sharp );
		// Upsample the half-res blur by its four nearest texels, each weighted by how much it would
		// itself show as blur: plain bilinear filtering pulled a sharp figure's colour (a texel whose
		// coc is near zero) a pixel or two out over the blurred sea beside it. Texels that are
		// blurred themselves keep their bilinear weight, so a soft bush in front of a softer sea
		// stays soft at its edge instead of snapping to the half-res grid. The mix factor comes from
		// the full-resolution coc for the same reason.
		const composite = Fn( () => {

			const c = makeCocAt()( uv() ).x.toVar();
			const hp = uv().mul( u.halfRes ).sub( 0.5 ).toVar();
			const base = hp.floor().toVar();
			const f = hp.sub( base ).toVar();
			const acc = vec3( 0 ).toVar(), wsum = float( 0 ).toVar();
			for ( const [ ox, oy ] of [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ] ) {

				const t = blur.sample( clamp( base.add( vec2( ox, oy ) ), vec2( 0 ), u.halfRes.sub( 1 ) ).add( 0.5 ).div( u.halfRes ) ).level( float( 0 ) ).toVar();
				const bl = ( ox ? f.x : float( 1 ).sub( f.x ) ).mul( oy ? f.y : float( 1 ).sub( f.y ) );
				const w = bl.mul( smoothstep( 0, 0.35, t.a ).add( 1e-3 ) );
				acc.addAssign( t.rgb.mul( w ) );
				wsum.addAssign( w );

			}
			// (the plain bilinear blur keeps the half-res pass in the graph; it only shows where
			// every weight vanished, which they cannot)
			const blurred = select( wsum.greaterThan( 0 ), acc.div( max( wsum, 1e-6 ) ), blur.rgb );
			return mix( sharp.rgb, blurred, smoothstep( 0, 0.35, c ).mul( u.dof ) );

		} );

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
		const tGlowD = texture( surfaceDepth );
		const diffusionNode = new RenderBloomNode( nodeObject( sharp ), 0, 0.8, 1 );
		diffusionNode.setResolutionScale( 0.5 );
		( diffusionNode as unknown as { highPassFn: unknown } ).highPassFn = Fn( ( { input }: { input: THREE.Node<'vec4'> } ) => {

			const px = ivec2( clamp( uv().mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) );
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
		this.diffusion = { node: diffusionNode, threshold: diffusionThreshold };
		// Over the dark parts of the frame the glow is held to `glowHalo` of itself: Orton's
		// sandwich multiplies, so the defocused copy brightens the light parts and leaves the shade
		// deep. Added in full, a backlit sea's glow lay over the shaded cliff in front of it as a
		// pale veil. It also lands only where the frame is about as bright as the light it spreads
		// from: against a low sun the glint and the sky behind the island are many times brighter
		// than the backlit meadow and trees in front of them, and their glow laid a warm haze over
		// the foliage. (The light it spreads from is the glow
		// over its strength and the chain's five mip weights, which sum to 3 at any radius.)
		// (glowOn is 0 while the chain is skipped: its texture holds the last glow.)
		const diffused = () => {

			const c = composite().toVar();
			const glow = diffusionNode.rgb.toVar();
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
		// night returns to PBR Neutral (see `nightLook`).
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
		const lookColour = Fn( ( [ c0, onSurface ]: [ V3, F ] ) => {

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
		const grade = ( lin: V3 ): V3 => {

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
			// The look (a uniform branch: 'realistic' skips it and keeps the grade above exactly).
			const onSurface = select( ( textureLoad( tD, ivec2( clamp( uv().mul( u.resolution ), vec2( 0 ), u.resolution.sub( 1 ) ) ) ) as unknown as F ).greaterThan( - 9e4 ), float( 1 ), float( 0 ) ).toVar();
			If( u.lookOn.greaterThan( 0.5 ), () => {

				c.assign( lookColour( c, onSurface ) );

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
			// vignette
			const q = uv().sub( 0.5 ).mul( vec2( u.resolution.x.div( u.resolution.y ), 1 ) );
			c.mulAssign( mix( float( 1 ), smoothstep( 1.15, 0.3, length( q ) ), u.vignette ) );
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

		// The graded image, at the render's size, always into one float target: building the graph
		// above for a second output (another shader or target format) set its rtt() passes up again,
		// and their layout functions kept the first build's uniform bindings. Float, so the copy
		// below hands the canvas exactly the values a direct draw would.
		this.displayRT = new THREE.RenderTarget( 1, 1, { type: THREE.FloatType, depthBuffer: false } );
		this.displayRT.texture.name = 'display';
		this.display = new THREE.RenderPipeline( renderer, Fn( () => finish( grade( diffused() ), u.resolution, u.grainOn ) )() );
		this.display.outputColorTransform = false;

		// At the display's resolution it is copied to the canvas, grain and all.
		this.output = new THREE.RenderPipeline( renderer, textureLoad( this.displayRT.texture, ivec2( screenCoordinate.xy ) ) );
		this.output.outputColorTransform = false;

		// Below it, FSR 1 (AMD FidelityFX Super Resolution 1, FSR.ts) upscales the image (it expects
		// display values) before the grain, so the grain stays one display pixel fine and is not
		// sharpened. The browser's stretch of a small canvas was a plain bilinear filter. The canvas
		// pass sharpens EASU's result itself; three's FSR1Node, kept for A/B, took a canvas-sized
		// pass and target more.
		const backend = renderer.backend as unknown as { hasFeature?( name: string ): boolean };
		this.fsr = new FSR( this.displayRT.texture, backend.hasFeature?.( 'float32-filterable' ) === true );
		this.upscaledOutput = new THREE.RenderPipeline( renderer, Fn( () => finish( this.fsr.rcas( this.sharpness ).toVar(), u.output, float( 1 ) ) )() );
		this.upscaledOutput.outputColorTransform = false;
		const upscaled = fsr1( texture( this.displayRT.texture ), this.sharpness );
		this.upscaledOutputThree = new THREE.RenderPipeline( renderer, Fn( () => finish( upscaled.rgb.toVar(), u.output, float( 1 ) ) )() );
		this.upscaledOutputThree.outputColorTransform = false;
		if ( O.discardScene ) this.interceptSceneStore();
		this.setToneMapping( this.settings.toneMapping );
		// The sea fog's passes run only once fog sets in, perhaps minutes later (morning mist, the
		// weather turning): compiled now, in the background, the first foggy frame does not stall.
		this.warm().catch( ( error ) => console.warn( 'Pipeline.warm', error ) );

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

		this.width = w; this.height = h;
		this.outputWidth = Math.max( outputWidth, w ); this.outputHeight = Math.max( outputHeight, h );
		this.u.output.value.set( this.outputWidth, this.outputHeight );
		for ( const node of this.passes ) sizeRtt( node, w, h );
		for ( const { node } of [ ...this.blooms, this.diffusion ] ) { node.renderWidth = w; node.renderHeight = h; }
		this.shafts.setSize( w, h );
		this.sceneRT.setSize( w, h );
		this.depthRT.setSize( w, h );
		this.opaqueRT.setSize( w, h );
		this.surfaceRT.setSize( w, h );
		this.displayRT.setSize( w, h );
		this.distanceRT?.setSize( w, h );
		this.air.setSize( w, h );
		this.fsr.setSize( this.outputWidth, this.outputHeight, w, h );
		this.u.resolution.value.set( w, h );
		this.u.texel.value.set( 1 / w, 1 / h );
		// the size rtt() gives the half-res blur
		this.u.halfRes.value.set( Math.max( Math.floor( w * 0.5 ), 1 ), Math.max( Math.floor( h * 0.5 ), 1 ) );

	}

	/** Whether the frame is rendered below the canvas's resolution and upscaled. */
	get upscaling(): boolean {

		return this.outputWidth !== this.width || this.outputHeight !== this.height;

	}

	render( { scene, waterScene, rainScene, camera, water, sun, time }: { scene: THREE.Scene; waterScene: THREE.Scene; rainScene?: THREE.Scene; camera: THREE.Camera; water: { prepare( sun: THREE.DirectionalLight ): void } | null; sun: THREE.DirectionalLight; time: number } ): void {

		const r = this.renderer;
		const S = this.settings;
		const u = this.u;

		camera.updateMatrixWorld();
		u.projInv.value.copy( ( camera as THREE.PerspectiveCamera ).projectionMatrixInverse );
		this.air.update( camera, this.width, this.height );
		this.shafts.update( camera as THREE.PerspectiveCamera, this.width, this.height, this.air.haze.value,
			this.air.fogTransmittance( camera.position.y, this.shafts.sunDirection ) );

		// 1. opaque
		r.setRenderTarget( this.sceneRT );
		r.render( scene, camera );

		// 2. linear depth, and a copy of the opaque colour for the water to refract and reflect
		// (a pass cannot sample the target it draws into)
		r.setRenderTarget( this.depthRT );
		this.depthQuad.render( r );
		r.setRenderTarget( this.opaqueRT );
		this.copyQuad.render( r );

		// 3. The water, then the world-space rain, over the opaque image in the scene's multisampled
		// target. Each sample keeps the opaque surface or the sea, whichever is nearer, so
		// silhouettes against the sea are antialiased like the rest of the image. (Drawn into a
		// target of their own, single-sampled, the water had to decide per pixel between the sea
		// and the opaque colour: edges stepped, and the opaque colour at an edge pixel held the
		// sky the sea was not there to cover, a pale outline round everything over the sea.)
		// Rain does not write depth, so surface focus and overlapping translucent streaks are
		// preserved; its splashes compare the resolved depths themselves.
		const autoClear = r.autoClear;
		r.setRenderTarget( this.sceneRT );
		try {

			r.autoClear = false;
			if ( water ) {

				water.prepare( sun );
				// Without rain the water is the last pass into the scene target: only the resolved
				// colour is read after it, so its multisampled colour need not be stored (the surface
				// resolve below still loads its depth). debugFlags.waterColourStore = true stores it.
				if ( ! rainScene && debugFlags.waterColourStore !== true && this.options.discardScene ) this.discardSamples = 'colour';
				r.render( waterScene, camera );
				this.discardSamples = 'none';

			}
			r.setRenderTarget( this.surfaceRT );
			this.surfaceQuad.render( r );
			if ( rainScene ) {

				r.setRenderTarget( this.sceneRT );
				// the last pass into the scene target: its samples are resolved, then never read
				this.discardSamples = this.options.discardScene ? 'all' : 'none';
				r.render( rainScene, camera );

			}

		} finally {

			this.discardSamples = 'none';
			r.autoClear = autoClear;
			r.setRenderTarget( null );

		}

		// the reduced sea fog and its bank map, and the depth of field's distances
		this.air.render( r );
		// (without the depth of field its blur is mixed in at weight 0, so stale distances never show)
		if ( this.distanceQuad && S.dof > 0 ) {

			r.setRenderTarget( this.distanceRT );
			this.distanceQuad.render( r );
			r.setRenderTarget( null );

		}

		// 4. composite, bloom, depth of field, grade
		const [ b, g ] = this.blooms;
		if ( g ) {

			b.node.strength.value = S.bloomStrength; b.node.radius.value = S.bloomRadius; b.node.threshold.value = S.bloomThreshold * SCENE_RADIANCE_SCALE; b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE; b.surfaceMaxLum.value = S.bloomSurfaceMaxLum * SCENE_RADIANCE_SCALE;
			g.node.strength.value = S.glowStrength; g.node.radius.value = S.glowRadius; g.node.threshold.value = S.glowThreshold * SCENE_RADIANCE_SCALE; g.maxLum.value = S.glowMaxLum * SCENE_RADIANCE_SCALE; g.surfaceMaxLum.value = S.glowMaxLum * SCENE_RADIANCE_SCALE;

		} else {

			// One chain for both: the wide glow's radius and threshold, the tight bloom's clamps, and
			// the two strengths together (an approximation for the low tier).
			b.node.strength.value = S.bloomStrength + S.glowStrength; b.node.radius.value = S.glowRadius; b.node.threshold.value = S.glowThreshold * SCENE_RADIANCE_SCALE;
			b.maxLum.value = S.bloomMaxLum * SCENE_RADIANCE_SCALE; b.surfaceMaxLum.value = S.bloomSurfaceMaxLum * SCENE_RADIANCE_SCALE;

		}
		// The night crossfades the curve and its grade to PBR Neutral's (the grade's own night values,
		// not the GUI's, which tune the chosen curve by day).
		const look = this.looks[ S.toneMapping ], night = this.looks.neutral;
		const day = S.toneMapping === 'neutral' ? 1 : 1 - THREE.MathUtils.clamp( S.nightLook, 0, 1 );
		const lerp = THREE.MathUtils.lerp;
		u.curve.value = TONE_CURVES.indexOf( S.toneMapping ); u.day.value = day;
		u.exposure.value = S.exposure / SCENE_RADIANCE_SCALE; u.curveExposure.value = u.exposure.value * look.exposure;
		u.saturation.value = lerp( night.saturation, S.saturation, day ); u.vibrance.value = lerp( night.vibrance, S.vibrance, day ); u.contrast.value = lerp( night.contrast, S.contrast, day );
		u.clipGuard.value = look.clipGuard * day; u.highlightSat.value = look.highlightSat * day; u.knee.value = look.knee; u.burn.value = look.burn * day;
		u.split.value = S.split * lerp( night.split, look.split, day ); u.lift.value.copy( S.lift ).multiplyScalar( lerp( night.lift, look.lift, day ) );
		// The look fades out with the night (the night keeps its authored colours) and its sunlit
		// parts (glow, golden highlights, lift) with the weather's sunlight; the rest holds a share
		// of itself under a closed sky, so bad weather stays dimmer and greyer than a clear day.
		// ('realistic' bypasses the layer whatever the live parameters hold, so it stays exact)
		const L = this.look, on = S.look !== 'realistic';
		const lookDay = 1 - THREE.MathUtils.clamp( S.nightLook, 0, 1 );
		const sunlit = THREE.MathUtils.smoothstep( S.lookSunlight, 0.1, 0.9 );
		u.lookOn.value = on ? 1 : 0;
		u.lookColour.value = lookDay * lerp( L.overcast, 1, sunlit ); u.lookSun.value = lookDay * sunlit;
		u.greenSat.value = L.greenSaturation; u.greenBright.value = L.greenBrightness; u.greenHue.value = L.greenHue;
		u.tealSat.value = L.tealSaturation; u.tealBright.value = L.tealBrightness; u.tealHue.value = L.tealHue;
		u.shadowTint.value.copy( L.shadowTint ); u.shadowTone.value = L.shadowTone;
		u.highlightTint.value.copy( L.highlightTint ); u.highlightTone.value = L.highlightTone;
		u.pivot.value = L.pivot; u.shadowLift.value = L.shadowLift; u.lookContrast.value = L.contrast; u.lookSky.value = L.sky; u.glowHalo.value = L.glowHalo;
		const d = this.diffusion.node, glow = on ? L.glow * u.lookSun.value : 0;
		d.enabled = glow > 0; u.glowOn.value = d.enabled ? 1 : 0;
		d.strength.value = glow; d.radius.value = L.glowRadius;
		// the threshold in the sharp image's units: display values before the curve, over its exposure
		this.diffusion.threshold.value = L.glowThreshold / Math.max( u.curveExposure.value, 1e-9 );
		u.glowTint.value.setRGB( 1 + 0.2 * L.glowWarmth, 1, 1 - 0.35 * L.glowWarmth );
		// (the look's own vignette fades with the night too; the base vignette stays)
		u.vignette.value = S.vignette + ( on ? L.vignette * lookDay : 0 ); u.grain.value = S.grain; u.time.value = time;
		u.dof.value = S.dof; u.range.value = S.dofRange;
		u.maxRadius.value = S.dofMaxRadius * this.height / 900; // blur scales with the image, not the pixel count
		u.focus.value = S.focusDistance > 0 ? S.focusDistance : camera.position.length();
		u.grainOn.value = this.upscaling ? 0 : 1;
		r.setRenderTarget( this.displayRT );
		this.display.render();
		r.setRenderTarget( null );
		if ( ! this.upscaling ) this.output.render();
		else if ( ! this.options.fsrPort || debugFlags.fsrPort === false ) this.upscaledOutputThree.render();
		else {

			this.fsr.render( r );
			this.upscaledOutput.render();

		}

	}

	/** Compiles the passes that first run later than the first frame (fog setting in, the
	 * upscale), so they do not stall the frame that first needs them. It starts when the graph is
	 * built; later calls return the same promise. */
	warm(): Promise<void> {

		this.warming ??= ( async () => {

			await this.air.warm( this.renderer );
			await this.fsr.warm( this.renderer );

		} )();
		return this.warming;

	}

	// WebGPU lets a pass load its attachments and still discard them once resolved; three only
	// offers a discard together with a clear (storeMultisampled*Buffer = false), which would wipe
	// the opaque image the rain draws over. So while the last pass into sceneRT is recorded, its
	// descriptor's multisampled colour and depth stores become discards: the resolved colour and
	// surfaceRT are already written, and the next frame's opaque pass clears both. Without rain the
	// water is that pass, and only its colour is discarded, since the surface resolve still loads
	// the depth it leaves. (This relies
	// on three's WebGPUBackend beginning each pass on an encoder of its own.)
	private interceptSceneStore(): void {

		type Attachment = { resolveTarget?: unknown; storeOp?: string };
		type Descriptor = { colorAttachments: ( Attachment | null )[]; depthStencilAttachment?: { depthStoreOp?: string } };
		type Encoder = { beginRenderPass( descriptor: Descriptor ): unknown };
		const device = ( this.renderer.backend as unknown as { device: { createCommandEncoder( descriptor?: unknown ): Encoder } } ).device;
		const create = device.createCommandEncoder.bind( device );
		device.createCommandEncoder = ( descriptor?: unknown ) => {

			const encoder = create( descriptor );
			const mode = this.discardSamples;
			if ( mode === 'none' ) return encoder;
			const begin = encoder.beginRenderPass.bind( encoder );
			encoder.beginRenderPass = ( pass: Descriptor ) => {

				// only a multisampled pass resolving into its target: the scene's
				if ( ! pass.colorAttachments[ 0 ]?.resolveTarget ) return begin( pass );
				return begin( {
					...pass,
					colorAttachments: pass.colorAttachments.map( ( a ) => a && a.resolveTarget ? { ...a, storeOp: 'discard' } : a ),
					depthStencilAttachment: pass.depthStencilAttachment && ( mode === 'all' ? { ...pass.depthStencilAttachment, depthStoreOp: 'discard' } : pass.depthStencilAttachment ),
				} );

			};
			return encoder;

		};

	}

}
