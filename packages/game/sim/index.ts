// The game's headless entry point: what the app takes from the game before the game itself loads.
//
// The game's headless entry point: what the app takes from the game before the game itself loads
// (its URL options, ../GameSettings.ts; the land a resumed save grew, ../save.ts; the island's
// walkable top from the world's tiles, grid.ts; the interface's languages, which the app matches
// the browser's against before the settings are installed, ../ui/i18n/locales.ts).
// Every file it loads imports relative paths only (tools/repo/verify-layers.mjs), and it loads in plain
// node (tools/repo/verify-entry-points.mjs).
export { GAME_SETTINGS } from '../GameSettings.ts';
export { readSlot, resumesSave, savedPieces } from '../save.ts';
export { topFromTiles } from './grid.ts';
export { LOCALES, detectLocale, type Locale } from '../ui/i18n/locales.ts';
