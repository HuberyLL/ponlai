// The game's headless exit: what the page takes from the game before the game itself loads (the
// land a resumed save grew, ../save.ts; the island's walkable top from the world's tiles, grid.ts).
// Every file it loads imports relative paths only (tools/verify-layers.mjs), and it loads in plain
// node (tools/verify-exits.mjs).
export { readSlot, resumesSave, savedPieces } from '../save.ts';
export { topFromTiles } from './grid.ts';
