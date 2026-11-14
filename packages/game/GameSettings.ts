import { settingsFor, type SettingName, type SettingsQuery, type SettingsTable } from '../render/setup.ts';

// The game's options of the page's address, and the reader the game's modules take them by.
//
// The game's own options (a new or resumed game, its save, its islanders, its language), declared
// as the render pipeline declares its own (render/Settings.ts, which holds the rules of every
// table): the page merges the layers' tables (app/AppSettings.ts) and installs the address before
// anything reads it. `settings` here is the page's one installed reader, typed for the render
// pipeline's names and the game's; docs/reference/url-options.md explains each option
// (tools/repo/verify-settings.mjs).

/** The game's options. */
export const GAME_SETTINGS = {
	// islanders
	bodies: { type: 'list', default: 'the simulation\'s three', about: 'a new game\'s islanders\' sexes and ages' },
	// game
	load: { type: 'switch', default: 'off', about: 'resumes the saved game' },
	new: { type: 'switch', default: 'off', about: 'starts a new game' },
	autosave: { type: 'choice', default: 'on, off in an automated browser', values: [ 'on', 'off' ], about: 'whether the page keeps the save itself' },
	lang: { type: 'text', default: 'zh-CN', about: 'the interface\'s language (`zh-CN`, `en`)' },
} as const satisfies SettingsTable;

/** The game's option names, beside the render pipeline's. */
export type GameSettingName = keyof typeof GAME_SETTINGS;

/** The installed settings, read by the render pipeline's names and the game's. */
export const settings = settingsFor( GAME_SETTINGS );

/** A query read by the render pipeline's names and the game's. */
export type GameSettingsQuery = SettingsQuery<SettingName | GameSettingName>;
