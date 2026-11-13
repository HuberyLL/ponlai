// The island's exit for the page: the names the game and the page take from the island, and no
// others. Another package imports the island through this file (or through island/land.ts, for the
// land and the look's numbers), never one of its modules by its path (tools/verify-layers.mjs). It
// holds re-exports only; no module it loads awaits or reads a page global at load
// (tools/verify-exits.mjs). The wind probe (debug/WindProbe.ts), which the page loads on demand,
// is a lazy exit (tools/layers.json).
export { awaitWorld, bakeIslandGround, createCharacterShadow, createGrowth, createIslandCamera, createIslandFrame, createLand, createTrample, createVegetation, createWorld, createWorldViews, holdOpaque, registerIslandHistories } from './IslandStages.ts';
export type { IslandFraming, IslandParts } from './IslandStages.ts';
export { isCameraInputTarget } from './camera/FreeCameraControls.ts';
export { CLICK_SLOP, IslandCameraControls } from './camera/IslandCameraControls.ts';
export { frameIsland, landFitDistance } from './camera/IslandFraming.ts';
export { characterLook } from './characters/CharacterMaterial.ts';
export { CharacterShadow } from './characters/CharacterShadow.ts';
export { PROPORTIONS, PROPORTION_NAMES } from './characters/Proportions.ts';
export type { ProportionName } from './characters/Proportions.ts';
export { FIGURE_HEIGHT, Villagers, animate, loadVillager } from './characters/Villagers.ts';
export type { Villager } from './characters/Villagers.ts';
export type { LookColours } from './characters/looks.ts';
export { islandBounceGround } from './materials/BounceGround.ts';
export { MEADOW_EXTENT, groundGains, setGroundGain } from './materials/Meadow.ts';
export { setSoilStrength, soilUniforms } from './materials/Soil.ts';
export { FallingLeaves, leavesPass } from './world/FallingLeaves.ts';
export { swardField } from './world/SwardField.ts';
export { ISLAND_SEA } from './world/World.ts';
export { startWorld } from './world/WorldStart.ts';
export { TRAMPLE } from './world/Trample.ts';
export type { TrampleWalker } from './world/Trample.ts';
