import type { OcclusionLook } from '../../render/setup.ts';

// The island's ambient occlusion look (packages/island/look/: the island's numbers for the renderer's
// look tables, look/Look.ts; look/OcclusionLook.ts reads this).

export const OCCLUSION: OcclusionLook = {
	// the deepest crevice or contact keeps a quarter of the ambient light and never turns black
	floor: 0.25,
};
