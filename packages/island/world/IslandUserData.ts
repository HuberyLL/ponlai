import type { UserDataKey, UserDataName } from '../../render/index.ts';

// The `userData` keys the island keeps to itself: set and read above the renderer, which never
// names them. A file of the island names a key of the renderer's list (packages/render/UserData.ts, whose
// types the renderer's exit offers) or of this one, and nothing else (tools/repo/verify-layers.mjs, its
// userData check, which also fails on a key here that no file of the island names). A key the
// renderer reads belongs on its list, not here; one spelt as a key of the renderer's does not
// compile.
//
// This module is data only and imports types alone, so the CPU-only tools load it under plain node.

export const ISLAND_USER_DATA = {
	part: {
		on: 'object', sets: 'world/World.ts', reads: 'world/World.ts, world/Growth.ts',
		means: 'the land chunk a world mesh draws, with what its job derived from it',
	},
	topY: {
		on: 'material', sets: 'materials/TerrainMaterial.ts', reads: 'world/IslandClasses.ts',
		means: 'the terrain\'s material: the plateau top\'s height uniform, which marks it as the ground',
	},
	terrainVariant: {
		on: 'material', sets: 'materials/TerrainMaterial.ts', reads: 'world/IslandClasses.ts, the console (TerrainMaterial.ts)',
		means: 'builds the terrain\'s other tiling variant, so a running page can swap them; marks a terrain material',
	},
	culms: {
		on: 'object', sets: 'world/Bamboo.ts', reads: 'world/IslandClasses.ts',
		means: 'a mesh of the bamboo\'s culms, wood in the radiance grid\'s kinds',
	},
	blades: {
		on: 'object', sets: 'world/Grass.ts', reads: 'world/Grass.ts',
		means: 'the meadow group\'s blades, whose buffers a growth swaps',
	},
	plan: {
		on: 'object', sets: 'world/Grass.ts', reads: 'world/Grass.ts edgeRoots',
		means: 'the meadow group\'s current plan of roots',
	},
	edgeRoots: {
		on: 'object', sets: 'world/Grass.ts', reads: 'tools/island/parity/views.mjs',
		means: 'the meadow\'s roots at its edges, for the views that look at them',
	},
	flowerHeads: {
		on: 'object', sets: 'world/Grass.ts', reads: 'tools/island/parity/views.mjs',
		means: 'the meadow\'s flower heads (none), for the views that look for them',
	},
	update: {
		on: 'object', sets: 'world/Grass.ts', reads: 'nothing now',
		means: 'the meadow group\'s work ahead of a frame (none: the blades are generated as they draw)',
	},
	wind: {
		on: 'material', sets: 'world/Grass.ts', reads: 'nothing now',
		means: 'the blades\' material: the wind\'s direction uniform',
	},
	casterOfCharacterShadow: {
		on: 'material', sets: 'characters/CharacterMaterial.ts', reads: 'characters/CharacterShadow.ts',
		means: 'an islander\'s material, which casts into the figures\' own shadow map',
	},
} as const satisfies Record<string, UserDataKey> & { [ K in UserDataName ]?: never };
