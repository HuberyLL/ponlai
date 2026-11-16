import { settingsFor, type SettingName, type SettingsQuery, type SettingsTable } from '../render/setup.ts';

// The island's options of the page's address, and the reader the island's modules take them by.
//
// The island's own options (the world, its growth, the islanders), declared as the render pipeline
// declares its own (render/Settings.ts, which holds the rules of every table): the page merges the
// layers' tables (app/AppSettings.ts) and installs the address before anything reads it.
// `settings` here is the page's one installed reader, typed for the render pipeline's names and the
// island's; docs/reference/url-options.md explains each option (tools/repo/verify-settings.mjs).

/** The island's options. */
export const ISLAND_SETTINGS = {
	// view and capture
	cameraInput: { type: 'choice', default: 'on', values: [ 'on', 'off', '' ], about: '`off`: the hand does not move the island camera; named bare, as `on`' },
	// the island
	seed: { type: 'integer', default: '1', about: 'the world\'s seed' },
	grow: { type: 'integer', default: 'the save\'s pieces under `game`, else 0', range: [ 0, Infinity ], about: 'growth steps after the starting island (up to `GROWTH.maxSteps`)' },
	worldCache: { type: 'choice', default: 'on', values: [ 'on', 'off', '0', '' ], about: '`off` or `0`: generates every chunk instead of reading the browser\'s cache' },
	bamboo: { type: 'list', default: 'the default groves', about: 'another look of the bamboo: `cover,height`' },
	wenyao: { type: 'switch', default: 'off', about: 'shows the wenyao, the schools of flying fish off the island (parked)' },
	approach: { type: 'number', default: '0', range: [ 0, 1 ], about: 'the progress toward the next piece, its shoal put on at once' },
	// quality, anti-aliasing and the frame
	terrainHex: { type: 'choice', default: 'on', values: [ '0' ], about: '`0`: the cliff\'s plain triplanar tiling' },
	// debug
	chunkBorders: { type: 'switch', default: 'off', about: 'shows the world\'s chunks as lines' },
	// islanders
	islander: { type: 'choice', default: 'the look\'s own', values: [ 'stock', 'subtle', 'medium', 'strong', 'real' ], about: 'the islanders\' proportions' },
	body: { type: 'text', default: 'M30', about: 'the scene\'s walker\'s sex and age' },
} as const satisfies SettingsTable;

/** The island's option names, beside the render pipeline's. */
export type IslandSettingName = keyof typeof ISLAND_SETTINGS;

/** The installed settings, read by the render pipeline's names and the island's. */
export const settings = settingsFor( ISLAND_SETTINGS );

/** A query read by the render pipeline's names and the island's. */
export type IslandSettingsQuery = SettingsQuery<SettingName | IslandSettingName>;
