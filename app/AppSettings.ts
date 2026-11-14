import { mergeSettings, RENDER_SETTINGS, settingsFor, type SettingsQuery, type SettingsTable } from '../packages/render/setup.ts';
import { ISLAND_SETTINGS } from '../packages/island/land.ts';
import { GAME_SETTINGS } from '../packages/game/sim/index.ts';

// The page's own options, the page's options merged from every layer, and the page's reader.
//
// The page's own options (the island's view, the GUI, the tier's detection, the test scene, the
// game switch), declared as the renderer declares its own (render/Settings.ts, which holds the
// rules of every table). `PAGE_SETTINGS` merges the four layers' tables: the entries (Boot.ts
// through PageSettings.ts, ScenesBoot.ts) report the address's problems against it, and `settings`
// here reads every layer's names. docs/reference/url-options.md explains each option
// (tools/repo/verify-settings.mjs).

/** The page's own options. */
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
	autoQuality: { type: 'choice', default: 'parked', values: [ 'detect', 'off' ], about: 'the GPU timing that chose the tier (parked: read by the tier\'s reload only)' },
	autoQualitySlow: { type: 'number', default: '1', range: [ 0.01, Infinity ], about: 'scales the GPU timing\'s measured time (parked)' },
	// debug
	renderLook: { type: 'choice', default: 'the page\'s own', values: [ 'neutral', 'ponlai' ], debug: true, about: 'the look the renderer draws with, over the page\'s own: `neutral` (the renderer\'s) on the island\'s page, `ponlai` (the island\'s) on the test scenes\'' },
	scene: { type: 'choice', default: 'none', values: [ 'ball', 'empty', 'sea', 'plants' ], about: 'the test scene `scenes.html` shows' },
	// game
	game: { type: 'switch', default: 'off', about: 'the island as a game' },
} as const satisfies SettingsTable;

/** Every option of the page's address: the renderer's, the island's, the game's and the page's own. */
export const PAGE_SETTINGS = mergeSettings( RENDER_SETTINGS, ISLAND_SETTINGS, GAME_SETTINGS, APP_SETTINGS );

/** Every option name of the page. */
export type PageSettingName = Extract<keyof typeof PAGE_SETTINGS, string>;

/** The installed settings, read by every layer's names. */
export const settings = settingsFor( PAGE_SETTINGS );

/** A query read by every layer's names (the address, a scene jump's). */
export type PageSettingsQuery = SettingsQuery<PageSettingName>;
