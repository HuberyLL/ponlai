// The game's front-end entry point: the loading screen, which the app shows before the game loads.
//
// The game's front-end entry point: what the app's entry (app/Boot.ts) shows before anything else
// loads, the loading screen (front/Loading.ts) with the fonts and the interface's styles. It stays
// small: the game itself (game/index.ts) loads behind it. The title screen and the menus over the
// running game are the game's main entry point's (front/Front.ts).
export { showLoading } from './front/Loading.ts';
export type { LoadingScreen } from './front/Loading.ts';
