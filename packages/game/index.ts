// The game's lazy main entry point, loaded by a dynamic import as the game starts.
//
// The game's main entry point, which the app loads as the game starts (main.ts, by a
// dynamic import). It is a lazy entry point (tools/repo/layers.json): it is imported dynamically or
// for its types only, so the game's code stays in a chunk of its own and loads only with the game.
export { Game } from './Game.ts';
export { Front } from './front/Front.ts';
export type { GraphicsControl } from './front/Front.ts';
