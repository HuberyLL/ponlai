import type { SwellParams } from '../ocean/OceanSpectrum.ts';

// The look's sea tables (src/look/: the numbers chosen for the look, their tunables and the CPU
// code that reads only them): the strengths of the sea's large-scale detail and the distant swell.
// The sea's optical properties are physical quantities, not look, and stay in ocean/SeaOptics.ts.

/** The strengths of the sea's large-scale detail (ocean/SeaDetail.ts, which takes them as its
 * uniforms' values): the gusts' contrast about their mean, the slicks' and the windrows'. */
export const SEA_DETAIL = { gust: 1, slick: 1, streak: 0.3 };

/** The distant swell (ocean/OceanSpectrum.ts `SwellParams`), which the FFT ocean takes under the
 * weather's own (ocean/OceanFFT.ts): its scale under the sea state's, its wind and fetch, its
 * heading against the local sea's, its spread and its spectrum's shape. */
export const DEFAULT_SWELL: Readonly<SwellParams> = {
	scale: 0.48, windSpeed: 6, fetch: 1200e3, directionOffset: - 20, spread: 1, swell: 0.9, peakEnhancement: 3.3, shortWavesFade: 0.1,
};
