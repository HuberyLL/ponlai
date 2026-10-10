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
//   canvas. Not built yet: they warn and run `msaa` until the temporal frame graph lands.
//
// WebGPU multisamples with 1 or 4 samples only (three turns any other count into 1), so there is
// no 2x: `msaa=1` and `msaa=2` are read as `off`, `msaa=4` as `msaa`.
//
// The mode comes from the URL's `aa`, else its `msaa` alias, else the quality tier's `aa` knob
// (`QualityProfile.aa`, with `tier.aa=` over it), else `msaa`. The tier is chosen here, once, for
// the whole page (main.ts reads `QUALITY_CHOICE`): modules that read the mode when they load
// (Foliage.ts, Grass.ts) are evaluated before the page's own code runs.
import { qualityProfile, type QualityProfile } from '../Quality.ts';
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

		if ( isAAMode( tier ) ) return tier;
		console.warn( `Unknown quality aa knob ${ String( tier ) }: expected one of ${ AA_MODES.join( ', ' ) }` );

	}
	return 'msaa';

}

// whether the temporal modes are built (the temporal frame graph lifts this)
const TEMPORAL_BUILT: boolean = false;

/** What a mode builds. Temporal modes are not built yet: they run as `msaa`. */
export function aaPlan( requested: AAMode ): AAPlan {

	let mode: AAMode = requested;
	if ( ( mode === 'taa' || mode === 'taau' ) && ! TEMPORAL_BUILT ) {

		console.warn( `aa=${ mode } is not built yet: running msaa` );
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
/** The mode the page asked for (before an unbuilt one falls back). */
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
export function temporalSharpness( settings: Pick<QualityProfile, 'taa'>[ 'taa' ], mode: AAMode, ratio: number ): number {

	const s = settings.sharpness;
	if ( mode !== 'taau' ) return s.taa;
	const t = Math.min( Math.max( ratio - 1, 0 ), 1 );
	return s.taau[ 0 ] + ( s.taau[ 1 ] - s.taau[ 0 ] ) * t;

}
