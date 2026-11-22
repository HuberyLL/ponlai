// The page's loading screen, shown by the entry before the app loads.
//
// The page's loading screen (game/front.ts `showLoading`: the game's name and its real progress),
// made from index.html's `#loading` by the entry (Boot.ts) right after the settings are installed,
// so it shows while the app's own modules load. The app (main.ts) hands it to the render pipeline's
// host, which lifts it once the scene shows and tells it each load stage passed.
import { showLoading, type LoadingScreen } from '../packages/game/front.ts';

export const LOADING: LoadingScreen = showLoading( document.getElementById( 'loading' )! );
