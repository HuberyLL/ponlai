// The game's headless exit: what the page takes from the game before the game itself loads.
//
// The game's headless exit: what the page takes from the game before the game itself loads (its
// options of the address, ../GameSettings.ts; the land a resumed save grew, ../save.ts; the
// island's walkable top from the world's tiles, grid.ts).
// Every file it loads imports relative paths only (tools/repo/verify-layers.mjs), and it loads in plain
// node (tools/repo/verify-entry-points.mjs).
export { GAME_SETTINGS } from '../GameSettings.ts';
export { readSlot, resumesSave, savedPieces } from '../save.ts';
export { topFromTiles } from './grid.ts';
