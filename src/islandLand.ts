// The island's headless exit: the land's shapes and growth, the islanders' ages and the island's
// numbers for the renderer's look (islandLook/), which load without three.js: the headless game
// plays on them in node, and the page's settings (PageSettings.ts) install the look from here
// before any of the renderer loads. Every file it loads imports relative paths only
// (tools/verify-layers.mjs), and it loads in plain node (tools/verify-exits.mjs). A name is in one
// exit only: these are not in island.ts.
export { paceAt, parseBodies } from './characters/Ages.ts';
export type { Body, Sex } from './characters/Ages.ts';
export { ISLAND_LOOK } from './islandLook/IslandLook.ts';
export { GROWTH } from './world/IslandGrowth.ts';
export type { LandLattice } from './world/IslandGrowth.ts';
export { ISLAND_PEAK, ISLAND_TOP, SWELL, buildFootprint, islandSurfaceHeight } from './world/WorldShapes.ts';
