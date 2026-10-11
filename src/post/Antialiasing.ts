// The scene's anti-aliasing, chosen once at load like a game's AA setting: what the frame graph,
// the vegetation and the post chain are built for. The choice is compiled into materials (alpha to
// coverage or a dither / alpha test) and into the frame graph (the scene's sample count, its
// passes), so it changes only with a reload (the GUI's control reloads with `aa=`).
//
// Modes:
// - `msaa`: the scene multisampled 4x, the vegetation's cut-outs and thin blades by alpha to
//   coverage, a render below the canvas upscaled by FSR 1 (today's image);
// - `off`: one sample, leaves alpha-tested and grass blades dithered (`msaa=1` before);
// - `taa`, `taau`: temporal anti-aliasing at the render's size, and temporal upsampling to the
//   canvas: one sample, jittered, with motion vectors (Jitter.ts, Motion.ts), resolved against a
//   history (TemporalAA.ts). Chosen by the URL only (the tiers' knob and the GUI keep to msaa and
//   off until the tiers adopt them), and refused, with a warning, where three's cache keys cannot
//   be patched (graph/ThreePatches.ts: three r186 only), since their scene materials build one
//   shader per MRT (if the patches still fail to install, main.ts stops the page).
//
// WebGPU multisamples with 1 or 4 samples only (three turns any other count into 1), so there is
// no 2x: `msaa=1` and `msaa=2` are read as `off`, `msaa=4` as `msaa`.
//
// The mode comes from the URL's `aa`, else its `msaa` alias, else the quality tier's `aa` knob
// (`QualityProfile.aa`, with `tier.aa=` over it), else `msaa`. The tier is chosen here, once, for
// the whole page (main.ts reads `QUALITY_CHOICE`): modules that read the mode when they load
// (Foliage.ts, Grass.ts) are evaluated before the page's own code runs.
import { REVISION } from 'three/webgpu';
import { qualityProfile, type QualityProfile, type TemporalSettings } from '../Quality.ts';
import { chooseQuality, type QualityChoice } from '../QualityDetect.ts';

export const AA_MODES = [ 'msaa', 'taa', 'taau', 'off' ] as const;
export type AAMode = typeof AA_MODES[ number ];
// the modes the GUI offers; the temporal ones stay URL-only until they are tuned
export const AA_GUI_MODES: readonly AAMode[] = [ 'msaa', 'off' ];
export type SceneSampleCount = 1 | 4;

export interface AAPlan {
	mode: AAMode;
	// the opaque scene's (and the water's and rain's) sample count
	sceneSamples: SceneSampleCount;
	// whether the frame is resolved against a history (jitter, motion vectors, the resolve)
	temporal: boolean;
	// how a render below the canvas reaches it
	upscale: 'fsr1' | 'taau' | 'none';
}

export function isAAMode( value: unknown ): value is AAMode {

	return typeof value === 'string' && ( AA_MODES as readonly string[] ).includes( value );

}

/** The mode requested by a page's options: `aa`, else the `msaa` alias, else the tier's `aa`
 * knob, else `msaa`. An unknown value warns and falls through to the next source. */
export function requestedAAMode( params: URLSearchParams, profile: Pick<QualityProfile, 'aa'> | null ): AAMode {

	const aa = params.get( 'aa' );
	if ( aa !== null ) {

		if ( isAAMode( aa ) ) return aa;
		console.warn( `Unknown aa=${ aa }: expected one of ${ AA_MODES.join( ', ' ) }` );

	}
	const msaa = params.get( 'msaa' );
	if ( msaa !== null ) {

		if ( msaa === '1' || msaa === '2' ) return 'off';
		if ( msaa === '4' ) return 'msaa';
		console.warn( `Unknown msaa=${ msaa }: expected 1 or 4` );

	}
	const tier = profile?.aa;
	if ( tier !== undefined ) {

		if ( tier === 'taa' || tier === 'taau' ) console.warn( `The quality tier's aa knob asks for ${ tier }: the temporal modes are chosen by the URL only (aa=${ tier }); running msaa` );
		else if ( isAAMode( tier ) ) return tier;
		else console.warn( `Unknown quality aa knob ${ String( tier ) }: expected one of ${ AA_MODES.join( ', ' ) }` );

	}
	return 'msaa';

}

/** Whether three's cache keys can be patched for MRTs (installCacheKeyPatches, which main.ts installs,
 * is written for r186 and refuses another revision): the temporal modes need it. */
export function temporalSupported( revision: string = REVISION ): boolean {

	return /^186(\.|$)/.test( revision );

}

/** What a mode builds. A temporal mode where three's cache keys cannot be patched runs as `msaa`. */
export function aaPlan( requested: AAMode, revision: string = REVISION ): AAPlan {

	let mode: AAMode = requested;
	if ( ( mode === 'taa' || mode === 'taau' ) && ! temporalSupported( revision ) ) {

		console.warn( `aa=${ mode } needs three's cache keys patched for its MRTs (graph/ThreePatches.ts, r186), not r${ revision }: running msaa` );
		mode = 'msaa';

	}
	const temporal = mode === 'taa' || mode === 'taau';
	return {
		mode,
		sceneSamples: mode === 'msaa' ? 4 : 1,
		temporal,
		upscale: mode === 'taau' ? 'taau' : 'fsr1',
	};

}

// The page's tier, chosen once (QualityDetect.ts: `?quality`, a remembered measurement, or a
// measurement on this load), and the mode it asks for.
const params = new URLSearchParams( location.search );
export const QUALITY_CHOICE: QualityChoice = await chooseQuality( params );
/** The mode the page asked for (before a refused one falls back). */
export const AA_REQUESTED: AAMode = requestedAAMode( params, qualityProfile( QUALITY_CHOICE.tier ) );
export const AA_PLAN: Readonly<AAPlan> = Object.freeze( aaPlan( AA_REQUESTED ) );
/** The mode the page runs. */
export const AA_MODE: AAMode = AA_PLAN.mode;
export const TEMPORAL: boolean = AA_PLAN.temporal;
export const SCENE_SAMPLES: SceneSampleCount = AA_PLAN.sceneSamples;
// Whether the vegetation's cut-outs and thin blades use alpha to coverage: with 4 samples only
// (one sample has no coverage to give, so the pipeline would ignore alpha and draw them solid).
export const ALPHA_TO_COVERAGE: boolean = SCENE_SAMPLES === 4;

/** The temporal resolve's sharpening for a mode: TAA's own, TAAU's eased from its 1:1 value to
 * its 2:1 value as the upscale `ratio` (canvas over render, per axis) goes from 1 to 2. */
export function temporalSharpness( settings: TemporalSettings, mode: AAMode, ratio: number ): number {

	const s = settings.sharpness;
	if ( mode !== 'taau' ) return s.taa;
	const t = Math.min( Math.max( ratio - 1, 0 ), 1 );
	return s.taau[ 0 ] + ( s.taau[ 1 ] - s.taau[ 0 ] ) * t;

}
