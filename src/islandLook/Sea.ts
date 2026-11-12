import type { SeaLook } from '../render.ts';

// The island's sea look (src/islandLook/: the island's numbers for the renderer's look tables,
// look/Look.ts; look/SeaLook.ts reads these): the strengths of the sea's large-scale detail and
// the distant swell. The sea's optical properties are physical quantities, not look, and stay in
// ocean/SeaOptics.ts.

export const SEA: SeaLook = {
	// the gusts' contrast about their mean, the slicks' and the windrows' (ocean/SeaDetail.ts)
	detail: { gust: 1, slick: 1, streak: 0.3 },
	// the distant swell under the weather's own (ocean/OceanFFT.ts): its scale under the sea
	// state's, its wind and fetch, its heading against the local sea's, its spread and its
	// spectrum's shape
	swell: { scale: 0.48, windSpeed: 6, fetch: 1200e3, directionOffset: - 20, spread: 1, swell: 0.9, peakEnhancement: 3.3, shortWavesFade: 0.1 },
};
