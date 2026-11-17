// The island's headless entry point: the land, its growth, islanders' ages and the look's numbers.
//
// The island's headless entry point: the land's shapes and growth, the islanders' ages, the
// island's numbers for the render pipeline's look (island/look/) and its URL options
// (IslandSettings.ts). All of these load without three.js: the headless game plays on them in node,
// and the app's settings (PageSettings.ts, AppSettings.ts) take the look and the options from here
// before any of the render pipeline loads. Every file it loads imports relative paths only
// (tools/repo/verify-layers.mjs), and it loads in plain node (tools/repo/verify-entry-points.mjs).
// Each name is exported from one entry point only: these are not in island/index.ts.
export { paceAt, parseBodies } from './characters/Ages.ts';
export type { Body, Sex } from './characters/Ages.ts';
export { ISLAND_LOOK } from './look/IslandLook.ts';
export { ISLAND_SETTINGS } from './IslandSettings.ts';
export { GROWTH } from './world/IslandGrowth.ts';
export type { LandLattice } from './world/IslandGrowth.ts';
export { ISLAND_PEAK, ISLAND_TOP, SWELL, buildFootprint, islandSurfaceHeight } from './world/WorldShapes.ts';
