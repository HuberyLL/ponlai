// The colours of the sea floor's fixed life.
//
// The sea floor's fixed life: each kind's colours (sRGB hex albedo) and roughness, as it looks
// under clear water in daylight close up, before the water's own absorption (the light under the
// water takes that: Underwater.ts), so a red sea fan reads dark at depth as a real one does.
//
// The values: eelgrass leaves are a bright to olive green, the old ones brown at their tips where
// epiphytes settle; Ecklonia is an olive brown kelp; the Acropora tables and bushes and the Porites
// domes of a warm-temperate coast's reefs are the tan and olive browns of their zooxanthellae, the
// growing rims and tips paler, and dark beside the sand: a brown coral reflects about a tenth of
// the light at its green-yellow peak and less in the blue, a third of what the sand does (Hochberg,
// Atkinson and Andréfouët 2003, "Spectral reflectance of coral reef bottom-types worldwide");
// Dendronephthya's polyps are pink, red, orange or purple on a pale translucent stalk; the gorgonian
// fans red, orange or yellow; Diadema black, with an orange ring round its anus. Each kind has a
// few morphs, one picked per individual.

export interface FloorPalette {
	// the morphs' main colours, and their tips', rims' or polyps' (the same index)
	main: readonly number[];
	tip: readonly number[];
	rough: number;
}

export const EELGRASS: FloorPalette = { main: [ 0x4f6a33, 0x5b6c35, 0x657038 ], tip: [ 0x6c6240, 0x71663f, 0x6a5f3d ], rough: 0.55 };
export const KELP: FloorPalette = { main: [ 0x5a4823, 0x625024, 0x55461f ], tip: [ 0x6e5a2b, 0x76602c, 0x6a5626 ], rough: 0.5 };
export const TABLE_CORAL: FloorPalette = { main: [ 0x5a5038, 0x51533a, 0x5a4a3e ], tip: [ 0x9a9480, 0x8a9490, 0x9c9088 ], rough: 0.82 };
export const BRANCHING_CORAL: FloorPalette = { main: [ 0x5c4c36, 0x544834, 0x62523e ], tip: [ 0x9a8e88, 0x7a8a98, 0xa49e8a ], rough: 0.8 };
export const MASSIVE_CORAL: FloorPalette = { main: [ 0x6a5c3e, 0x5c5e3c, 0x665248 ], tip: [ 0x80744f, 0x72744e, 0x7c685c ], rough: 0.86 };
export const SOFT_CORAL: FloorPalette = { main: [ 0xe1d3cc, 0xe3d6c8, 0xdcd0d4 ], tip: [ 0xd8486e, 0xe0783a, 0xa84c9c, 0xc8344c ], rough: 0.6 };
export const SEA_FAN: FloorPalette = { main: [ 0xa8282c, 0xc6642e, 0xd2ac40 ], tip: [ 0xb83a36, 0xd27a3c, 0xdcbc58 ], rough: 0.72 };
export const URCHIN: FloorPalette = { main: [ 0x17151a ], tip: [ 0xd0602a ], rough: 0.38 };
