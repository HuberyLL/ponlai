// The quality tiers: every knob the frame's cost depends on, per tier, in one table. `?quality`
// picks the tier at load (medium by default); the GUI's quality control reloads the page with it.
//
// High is the reference image; medium and low render at fixed budgets that leave room on the
// target display, for slower GPUs. All three multisample the scene with 4
// samples (WebGPU has 1 or 4, no 2): without it the meadow's alpha to coverage turns into a dither
// and geometric edges alias, so the lower tiers save through their render scale and the knobs
// below instead. No knob alters the weather, clock or lighting state: a tier changes the cost,
// never the mood.
//
// Two kinds of knob:
// - load: compiled into materials or the frame graph (shader loops, pass structure, map sizes), read
//   once while they are built, so they change only with a reload;
// - runtime: setters the page applies through `applySkyQuality` (main.ts) at load; a debug page can
//   override them there (`s.applyQuality( { ... } )`) to time one at a time.
//
// This module imports types only, so the CPU-only tools can read the table under plain node.
import type { WaterQuality } from './ocean/Water.ts';
import type { GrassQuality } from './world/Grass.ts';
import type { SolarShadowTaps } from './lighting/SolarShadow.ts';
import type { CloudMarch, CloudViewScale } from './sky/Clouds.ts';
import type { PostOptions } from './post/Pipeline.ts';

export const QUALITY_TIERS = [ 'low', 'medium', 'high' ] as const;
export type QualityTier = typeof QUALITY_TIERS[ number ];
export const DEFAULT_QUALITY: QualityTier = 'medium';

/** How the scene's render scale (its pixel ratio relative to CSS pixels) is chosen: a budget of
 * rendered pixels (the scale follows the window's size; Infinity renders at the display's ratio). */
export type RenderScaleRule = { budget: number };

export interface QualityProfile {

	// ---- load
	render: RenderScaleRule;
	water: WaterQuality;
	// the frame graph's structural options (sea fog, depth of field, bloom); the rest keep their
	// defaults
	post: Pick<PostOptions, 'fogScale' | 'fogSteps' | 'bankSize' | 'dofTaps' | 'bloomChains'>;
	// the sun shadow's filter, for most receivers and for vegetation (both stepped maps alike)
	shadow: { surface: SolarShadowTaps; vegetation: SolarShadowTaps };
	grass: GrassQuality;
	// the rain veil's shells and the sea's ripple layers
	rainShading: { veilShells: number; rippleLayers: number };
	// the environment's PMREM source width (fixes the atlases' size before the first bake)
	environmentSource: number;

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
const BILINEAR: SolarShadowTaps = { soft: false, blockerSamples: 0, filterSamples: 0 };

export const QUALITY: Readonly<Record<QualityTier, Readonly<QualityProfile>>> = {
	high: {
		render: { budget: Infinity },
		water: { ssrRays: 2, ssrSteps: 20, ssrGrowth: 1.3, refractionSteps: 8, refractionRefine: 5, columnSamples: 8, stormFoam: 'full' },
		post: { fogScale: 0.5, fogSteps: 12, bankSize: 2048, dofTaps: 36, bloomChains: 2 },
		shadow: { surface: PCSS_HIGH, vegetation: PCSS_HIGH },
		grass: { lawnBlades: [ 16, 12, 8 ], bladeBands: [ 40, 70 ], tussockSegments: 4, thinTufts: true, canopyPerVertex: false },
		rainShading: { veilShells: 3, rippleLayers: 2 },
		environmentSource: 512,
		cloudView: { display: 0.58 },
		cloudDome: { width: 1024, height: 256, strideX: 4, strideY: 8 },
		cloudMarch: { viewSteps: 256, panoramaSteps: 128, lightTaps: 5, rainSteps: 16 },
		cloudShadowRows: 1 / 8,
		skyUpdateInterval: 0.5,
		environmentEvery: 1,
		refractedSun: { interval: 0.08, angleGate: 0.03 },
		rainDrops: 49152,
	},
	medium: {
		render: { budget: 1600 * 900 },
		water: { ssrRays: 1, ssrSteps: 14, ssrGrowth: 1.51, refractionSteps: 6, refractionRefine: 4, columnSamples: 6, stormFoam: 'full' },
		post: { fogScale: 0.5, fogSteps: 8, bankSize: 2048, dofTaps: 24, bloomChains: 2 },
		shadow: { surface: { soft: true, blockerSamples: 4, filterSamples: 5 }, vegetation: BILINEAR },
		grass: { lawnBlades: [ 12, 8, 8 ], bladeBands: [ 40, 70 ], tussockSegments: 3, thinTufts: false, canopyPerVertex: true },
		rainShading: { veilShells: 3, rippleLayers: 2 },
		environmentSource: 256,
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
		render: { budget: 1280 * 720 },
		// (one bloom chain veiled a golden-hour island in glow, and the merged storm foam turned
		// the crests' streaks into scattered lace: both kept as on high)
		water: { ssrRays: 1, ssrSteps: 14, ssrGrowth: 1.51, refractionSteps: 6, refractionRefine: 4, columnSamples: 4, stormFoam: 'full' },
		post: { fogScale: 0.25, fogSteps: 8, bankSize: 1024, dofTaps: 16, bloomChains: 2 },
		shadow: { surface: BILINEAR, vegetation: BILINEAR },
		grass: { lawnBlades: [ 8, 8, 8 ], bladeBands: [ 40, 70 ], tussockSegments: 3, thinTufts: false, canopyPerVertex: true },
		rainShading: { veilShells: 2, rippleLayers: 1 },
		environmentSource: 256,
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

/** The tier `?quality` asks for, else the default. */
export function qualityFromURL( search = location.search ): QualityTier {

	const requested = new URLSearchParams( search ).get( 'quality' );
	return isQualityTier( requested ) ? requested : DEFAULT_QUALITY;

}

/** The tier's profile with `?tier.<knob path>=<value>` options over it, for A/B captures of one
 * knob (`tier.post.fogScale=0.5`, `tier.water.ssrRays=2`, `tier.grass.lawnBlades=16,12,8`). A path
 * must name an existing knob; numbers, booleans and comma lists are parsed. */
export function qualityProfile( tier: QualityTier, search = location.search ): QualityProfile {

	const profile = structuredClone( QUALITY[ tier ] ) as QualityProfile;
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
