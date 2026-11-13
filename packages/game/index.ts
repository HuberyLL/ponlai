// The game's exit for the page, which the page loads when `?game` starts the game (main.ts, by a
// dynamic import): a lazy exit (tools/repo/layers.json), imported dynamically or for its types only, so
// the game's code stays in a chunk of its own and loads only with the game.
export { Game } from './Game.ts';
