import { mergeSettings, RENDER_SETTINGS, settingsFor, type SettingsQuery, type SettingsTable } from '../packages/render/setup.ts';
import { ISLAND_SETTINGS } from '../packages/island/land.ts';
import { GAME_SETTINGS } from '../packages/game/sim/index.ts';

// The app's own URL options, every layer's options merged, and the app's reader.
//
// The app's own URL options (the island's view, the GUI, the tier's detection, the test scene, the
// review page and the game's opening), declared as the render pipeline declares its own (render/Settings.ts, which holds
// the rules of every table). `PAGE_SETTINGS` merges the four layers' tables: the entries (Boot.ts
// through PageSettings.ts, ScenesBoot.ts) report the address's problems against it, and `settings`
// here reads every layer's names. docs/reference/url-options.md explains each option
// (tools/repo/verify-settings.mjs).

/** The app's own URL options. */
export const APP_SETTINGS = {
	// view and capture
	polar: { type: 'number', default: '40', about: 'the island view\'s tilt (degrees)' },
	az: { type: 'number', default: '180', about: 'the island view\'s heading (degrees)' },
	dist: { type: 'number', default: 'frames the land', range: [ 0, Infinity ], about: 'the island view\'s distance from the default pivot (m)' },
	gui: { type: 'switch', default: 'hidden', about: 'shows the GUI' },
	camera: { type: 'choice', default: 'orbit', values: [ 'orbit', 'free' ], about: 'the island camera or the free flight' },
	nearFov: { type: 'number', default: '42', range: [ 1, 179 ], words: [ 'off' ], about: 'the island view\'s fov at its closest zoom (degrees; `off`: 27 at every distance)' },
	nearFovFrom: { type: 'number', default: '50', range: [ 0, Infinity ], about: 'the distance the fov widens from (m)' },
	// the island
	soil: { type: 'choice', default: 'on', values: [ '0', '1' ], about: '`0`: the ground without its soil layer' },
	// quality, anti-aliasing and the frame
	autoQuality: { type: 'choice', default: 'a first visit times the GPU', values: [ 'detect', 'off' ], about: '`detect` times the GPU again to choose the tier, `off` keeps high' },
	graphicsStore: { type: 'choice', default: 'on (off in an automated browser)', values: [ 'on', 'off' ], about: 'whether the page reads and writes the player\'s graphics settings' },
	autoQualitySlow: { type: 'number', default: '1', range: [ 0.01, Infinity ], about: 'scales the GPU timing\'s measured time' },
	// debug
	renderLook: { type: 'choice', default: 'the app\'s own', values: [ 'neutral', 'ponlai' ], debug: true, about: 'the look the render pipeline draws with, over the app\'s own: `neutral` (the render pipeline\'s) on the island\'s page, `ponlai` (the island\'s) on the test scenes\'' },
	scene: { type: 'choice', default: 'none', values: [ 'ball', 'empty', 'sea', 'plants' ], about: 'the test scene `scenes.html` shows' },
	// the page: the game, or the art-review scene
	review: { type: 'switch', default: 'off (the game)', about: 'the art-review scene (one islander walking a loop, the GUI) instead of the game' },
	opening: { type: 'choice', default: 'title', values: [ 'title', 'play' ], about: 'where the game opens: the title screen, or straight into play' },
} as const satisfies SettingsTable;

/** Every URL option of the page: the render pipeline's, the island's, the game's and the app's own. */
export const PAGE_SETTINGS = mergeSettings( RENDER_SETTINGS, ISLAND_SETTINGS, GAME_SETTINGS, APP_SETTINGS );

/** Every option name of the page. */
export type PageSettingName = Extract<keyof typeof PAGE_SETTINGS, string>;

/** The installed settings, read by every layer's names. */
export const settings = settingsFor( PAGE_SETTINGS );

/** A query read by every layer's names (the address, a scene jump's). */
export type PageSettingsQuery = SettingsQuery<PageSettingName>;
