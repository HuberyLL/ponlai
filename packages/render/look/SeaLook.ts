import type { SwellParams } from '../ocean/OceanSpectrum.ts';
import { readLook } from './Look.ts';

// The sea's look tables, as the renderer reads them (look/Look.ts: the numbers are the installed
// look's, the neutral set's where none is): the strengths of the sea's large-scale detail and the
// distant swell. The sea's optical properties are physical quantities, not look, and stay in
// ocean/SeaOptics.ts.

const LOOK = readLook( 'sea', 'look/SeaLook.ts' );

/** The strengths of the sea's large-scale detail (ocean/SeaDetail.ts, which takes them as its
 * uniforms' values): the gusts' contrast about their mean, the slicks' and the windrows'. */
export const SEA_DETAIL = { ...LOOK.detail };

/** The distant swell (ocean/OceanSpectrum.ts `SwellParams`), which the FFT ocean takes under the
 * weather's own (ocean/OceanFFT.ts): its scale under the sea state's, its wind and fetch, its
 * heading against the local sea's, its spread and its spectrum's shape. */
export const DEFAULT_SWELL: Readonly<SwellParams> = LOOK.swell;
