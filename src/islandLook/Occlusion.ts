import type { OcclusionLook } from '../renderSetup.ts';

// The island's ambient occlusion look (src/islandLook/: the island's numbers for the renderer's
// look tables, look/Look.ts; look/OcclusionLook.ts reads this).

export const OCCLUSION: OcclusionLook = {
	// the deepest crevice or contact keeps a quarter of the ambient light and never turns black
	floor: 0.25,
};
