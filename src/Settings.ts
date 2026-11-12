import type { AAMode } from './post/Antialiasing.ts';
import type { QualityTier } from './Quality.ts';
import type { DayPreset } from './sky/DayCycle.ts';
import type { WeatherName, WindLevel } from './sky/Weather.ts';

// The page's settings: every option of its address declared once, here, with its type, its range,
// its default and the layer that owns it, and the one reader every module takes them from.
//
//   import { settings } from './Settings.ts';
//   const option = settings.get( 'windView' );          // the value as written, or null
//   if ( settings.has( 'paused' ) ) ...                  // named at all (a bare `?paused` too)
//
// - The entry (Boot.ts, through PageSettings.ts, before it loads the page) parses the address once
//   (`parseSettings`), reports in one form each name nobody declared and each value outside its
//   range (`settingProblems`: a console warning `?name=value: why`, the option keeping whatever
//   its reader makes of it), chooses the quality tier and installs both (`installSettings`) before
//   any other module loads, so a module that reads a setting as it loads takes the value it always
//   did. No other module parses the address.
// - Where nobody installed them (node under the tools, Vite's server-side loads, a worker), every
//   option reads as absent: each reader takes its own default, as on a page without the option, and
//   nothing throws. A tool that builds what a page with options builds installs them first
//   (`installSettings( parseSettings( query ) )`: tools/wgsl-build.mjs `--q`).
// - The reader keeps the address's own values (the first of a name for `get`, all for `getAll`):
//   each module still reads its options as it did, so the values, the defaults the modules apply
//   and their console warnings are unchanged. `get` takes only a declared name, so a misspelt read
//   fails the type check; `prefixed` reads the declared prefixes (`tier.<knob>`, Quality.ts).
// - SETTINGS lists the options in the order of docs/reference/url-options.md's table, which
//   tools/verify-settings.mjs writes from it and checks against it: a new option is declared here,
//   documented there in its group, and the table rewritten (`node tools/verify-settings.mjs --write`).
//   `default` is the reader's default as words for that table, never read by the code; a `choice`
//   lists the values its reader tells apart (others are reported), a `number` its range and any
//   words it takes besides numbers (`words`). `debug` options are read on debug pages only (the
//   dev server, `?debug`, `?profile`).
// - The installed settings never change on a page. A setting read when materials and the frame
//   graph are built is a load setting: a new value reloads the page (PageSettings.ts `reloadWith`).
//   What may change on a running page is a named number of the tune table (debug/Tune.ts) or a
//   handle on `window.__PONLAI__`.

/** The layers of the code (tools/layers.json), lowest first: which one owns an option. */
export type SettingLayer = 'render' | 'island' | 'game' | 'app';

export interface SettingSpec {
	/** `switch`: named or not, its value unread; `choice`: one of `values`; `number`, `integer`: a
	 * number in `range` (or one of `words`); `list`: a comma list; `text`: any text. */
	readonly type: 'switch' | 'choice' | 'number' | 'integer' | 'list' | 'text';
	readonly layer: SettingLayer;
	/** What the page does without it, as words for the docs' table. */
	readonly default: string;
	readonly values?: readonly string[];
	readonly range?: readonly [ number, number ];
	readonly words?: readonly string[];
	readonly debug?: boolean;
	/** One line for the docs' table: what it sets. */
	readonly about: string;
}

const WEATHERS = [ 'clear', 'fair', 'cloudy', 'overcast', 'rain', 'storm', 'fog' ] as const satisfies readonly WeatherName[];
const WIND_LEVELS = [ 'light', 'gentle', 'fresh', 'strong' ] as const satisfies readonly WindLevel[];
const PRESETS = [ 'dawn', 'sunrise', 'noon', 'golden-hour', 'sunset', 'dusk', 'midnight' ] as const satisfies readonly DayPreset[];
const TIERS = [ 'low', 'medium', 'high' ] as const satisfies readonly QualityTier[];
const AA = [ 'msaa', 'taa', 'taau', 'fsr3', 'off', 'gt' ] as const satisfies readonly AAMode[];

export const SETTINGS = {
	// view and capture
	paused: { type: 'switch', layer: 'render', default: 'running', about: 'pauses the scene and both clocks; with it the page is in the test mode' },
	t: { type: 'number', layer: 'app', default: '0', range: [ 0, Infinity ], about: 'the scene time (s)' },
	dpr: { type: 'number', layer: 'app', default: 'the display\'s ratio, capped', range: [ 0, Infinity ], about: 'pins the canvas\'s pixel ratio' },
	polar: { type: 'number', layer: 'app', default: '40', about: 'the island view\'s tilt (degrees)' },
	az: { type: 'number', layer: 'app', default: '180', about: 'the island view\'s heading (degrees)' },
	dist: { type: 'number', layer: 'app', default: 'frames the land', range: [ 0, Infinity ], about: 'the island view\'s distance from the default pivot (m)' },
	cameraInput: { type: 'choice', layer: 'app', default: 'on', values: [ 'on', 'off', '' ], about: '`off`: the hand does not move the island camera' },
	gui: { type: 'switch', layer: 'app', default: 'hidden', about: 'shows the GUI' },
	camera: { type: 'choice', layer: 'app', default: 'orbit', values: [ 'orbit', 'free' ], about: 'the island camera or the free flight' },
	nearFov: { type: 'number', layer: 'app', default: '42', range: [ 1, 179 ], words: [ 'off' ], about: 'the island view\'s fov at its closest zoom (degrees; `off`: 27 at every distance)' },
	nearFovFrom: { type: 'number', layer: 'app', default: '50', range: [ 0, Infinity ], about: 'the distance the fov widens from (m)' },
	// the island
	seed: { type: 'integer', layer: 'island', default: '1', about: 'the world\'s seed' },
	grow: { type: 'integer', layer: 'island', default: 'the save\'s pieces under `game`, else 0', range: [ 0, Infinity ], about: 'growth steps after the starting island (up to `GROWTH.maxSteps`)' },
	worldCache: { type: 'choice', layer: 'island', default: 'on', values: [ 'on', 'off', '0', '' ], about: '`off` or `0`: generates every chunk instead of reading the browser\'s cache' },
	bamboo: { type: 'list', layer: 'app', default: 'the default groves', about: 'another look of the bamboo: `cover,height`' },
	approach: { type: 'number', layer: 'app', default: '0', range: [ 0, 1 ], about: 'the progress toward the next piece, its shoal put on at once' },
	soil: { type: 'choice', layer: 'app', default: 'on', values: [ '0', '1' ], about: '`0`: the ground without its soil map' },
	// sky and weather
	hour: { type: 'number', layer: 'app', default: 'golden-hour (8 under `game`)', about: 'the hour of the day' },
	preset: { type: 'choice', layer: 'app', default: 'golden-hour', values: PRESETS, about: 'the hour by its sun' },
	dayLength: { type: 'number', layer: 'app', default: '2880 (1440 under `game`)', range: [ 30, Infinity ], about: 'seconds per day' },
	moon: { type: 'number', layer: 'app', default: '0.5', about: 'the moon\'s phase (0.5 full)' },
	clock: { type: 'choice', layer: 'app', default: 'running', values: [ 'paused' ], about: '`paused`: freezes the day clock only' },
	weather: { type: 'choice', layer: 'app', default: 'auto, from fair', values: WEATHERS, about: 'holds this weather (the parked ones on debug pages only)' },
	wind: { type: 'choice', layer: 'app', default: 'the sky\'s', values: WIND_LEVELS, about: 'the wind\'s level; holds the weather' },
	windDir: { type: 'number', layer: 'app', default: 'the sky\'s (40)', about: 'the wind\'s heading (degrees); holds the weather' },
	clouds: { type: 'number', layer: 'app', default: 'the weather\'s', range: [ 0, 1 ], about: 'overrides the cloud coverage' },
	dayFog: { type: 'switch', layer: 'app', default: 'off', about: 'the day\'s fog layer under a clear or fair sky' },
	seaFog: { type: 'switch', layer: 'app', default: 'off', about: 'the deep sea fog' },
	// quality, anti-aliasing and the frame
	quality: { type: 'choice', layer: 'app', default: 'high', values: TIERS, about: 'the quality tier (medium and low parked)' },
	autoQuality: { type: 'choice', layer: 'app', default: 'parked', values: [ 'detect', 'off' ], about: 'the GPU timing that chose the tier (parked: read by the tier\'s reload only)' },
	autoQualitySlow: { type: 'number', layer: 'app', default: '1', range: [ 0.01, Infinity ], about: 'scales the GPU timing\'s measured time (parked)' },
	aa: { type: 'choice', layer: 'render', default: 'the tier\'s (high: msaa)', values: AA, about: 'the anti-aliasing mode (`gt` on debug pages only)' },
	msaa: { type: 'choice', layer: 'render', default: 'none', values: [ '1', '2', '4' ], about: 'the older alias of `aa`: `4` msaa, `1` and `2` off' },
	fsrDebug: { type: 'switch', layer: 'render', default: 'off', debug: true, about: 'FSR 3\'s debug view over its output (under `aa=fsr3`)' },
	taaResolve: { type: 'choice', layer: 'render', default: 'on', values: [ 'off' ], debug: true, about: '`off`: the temporal modes without their resolve' },
	terrainHex: { type: 'choice', layer: 'island', default: 'on', values: [ '0' ], about: '`0`: the cliff\'s plain triplanar tiling' },
	post: { type: 'list', layer: 'render', default: 'none', values: [ 'legacy', 'inline-composite', 'three-fsr', 'store-scene' ], about: 'the frame graph without the first performance round\'s changes' },
	gpuTimer: { type: 'choice', layer: 'app', default: 'on', values: [ 'off' ], about: '`off`: the dynamic resolution without its timestamp queries' },
	drsStore: { type: 'choice', layer: 'app', default: 'on, off in an automated browser', values: [ 'on', 'off' ], about: 'whether the dynamic resolution starts from the scale it last held' },
	frameRate: { type: 'number', layer: 'app', default: 'auto', range: [ 0, Infinity ], words: [ 'auto' ], about: 'the frame rate the loop holds (0: every refresh)' },
	frameFallback: { type: 'choice', layer: 'app', default: 'on', values: [ '0' ], about: '`0`: `auto` keeps the tier\'s rate' },
	submits: { type: 'choice', layer: 'render', default: 'batched', values: [ 'each' ], about: '`each`: three\'s own submit per pass' },
	submitBatch: { type: 'list', layer: 'render', default: 'SubmitBatch.ts\'s', about: 'the submit batching\'s policy: `hold,wait,idle`' },
	fgOps: { type: 'choice', layer: 'render', default: 'derived', values: [ 'derived', 'legacy', 'store', 'off' ], about: 'the frame graph\'s attachment ops' },
	fgPrime: { type: 'choice', layer: 'render', default: 'on', values: [ '0' ], about: '`0`: the warm-up renders nothing ahead' },
	fgview: { type: 'text', layer: 'render', default: 'off', debug: true, about: 'the frame graph\'s debug view of one resource' },
	// debug
	debug: { type: 'switch', layer: 'render', default: 'off', about: 'a debug page: the handles on `window`, the debug options' },
	flags: { type: 'list', layer: 'render', default: 'none', debug: true, about: 'sets debug flags as the page loads (`name:value,...`)' },
	tune: { type: 'text', layer: 'render', default: 'none', debug: true, about: 'tunable parameters\' values before anything builds (base64 JSON)' },
	testMode: { type: 'choice', layer: 'render', default: 'on with `paused`', values: [ '0' ], about: '`0`: a paused page outside the test mode' },
	profile: { type: 'choice', layer: 'app', default: 'off', values: [ '', 'frames' ], about: 'loads the frame profiler (`frames`: without GPU timestamps)' },
	vegPrepass: { type: 'choice', layer: 'render', default: 'on', values: [ '0', 'coverage' ], about: 'the vegetation\'s depth prepass: off, or with coverage kept' },
	chunkBorders: { type: 'switch', layer: 'app', default: 'off', about: 'shows the world\'s chunks as lines' },
	ambientProbes: { type: 'choice', layer: 'app', default: 'off', values: [ 'off', 'sky', 'bounce', 'irradiance' ], debug: true, about: 'shows the ambient light\'s probes' },
	windView: { type: 'choice', layer: 'render', default: 'off', values: [ '', 'arrows', 'plants' ], debug: true, about: 'makes the vegetation\'s wind visible' },
	// islanders
	look: { type: 'choice', layer: 'app', default: 'Hanming', values: [ 'kit' ], about: '`kit`: the islanders\' earlier kit look' },
	islander: { type: 'choice', layer: 'app', default: 'the look\'s own', values: [ 'stock', 'subtle', 'medium', 'strong', 'real' ], about: 'the islanders\' proportions' },
	body: { type: 'text', layer: 'app', default: 'M30', about: 'the scene\'s walker\'s sex and age' },
	bodies: { type: 'list', layer: 'game', default: 'the simulation\'s three', about: 'a new game\'s islanders\' sexes and ages' },
	// game
	game: { type: 'switch', layer: 'app', default: 'off', about: 'the island as a game' },
	load: { type: 'switch', layer: 'game', default: 'off', about: 'resumes the saved game' },
	new: { type: 'switch', layer: 'game', default: 'off', about: 'starts a new game' },
	autosave: { type: 'choice', layer: 'game', default: 'on, off in an automated browser', values: [ 'on', 'off' ], about: 'whether the page keeps the save itself' },
	lang: { type: 'text', layer: 'game', default: 'zh-CN', about: 'the interface\'s language (`zh-CN`, `en`)' },
} as const satisfies Record<string, SettingSpec>;

/** Options read by a prefix: `tier.<knob path>=<value>` (Quality.ts `qualityProfile`). */
export const SETTING_PREFIXES = {
	'tier.': { type: 'text', layer: 'render', default: 'the tier\'s', about: 'overrides one knob of the tier (`tier.post.hazeGrid.width=128`)' },
} as const satisfies Record<string, SettingSpec>;

export type SettingName = keyof typeof SETTINGS;
export type SettingPrefix = keyof typeof SETTING_PREFIXES;

/** What a module reads its options through: the page's installed settings (`settings`), or a query
 * of its own (`parseSettings`, a scene jump's). URLSearchParams has the same shape. */
export interface SettingsQuery {
	get( name: SettingName ): string | null;
	has( name: SettingName ): boolean;
	getAll( name: SettingName ): string[];
}

/** A parsed query: its options as the address gives them, in order. */
export interface ParsedSettings extends SettingsQuery {
	readonly entries: ReadonlyArray<readonly [ string, string ]>;
	prefixed( prefix: SettingPrefix ): Array<[ string, string ]>;
}

/** Parses a query (`?a=1&b`, the leading `?` optional) as the address's options. */
export function parseSettings( search: string ): ParsedSettings {

	const entries = Object.freeze( [ ...new URLSearchParams( search ) ].map( ( e ) => Object.freeze( e ) ) );
	const values = new Map<string, string[]>();
	for ( const [ name, value ] of entries ) {

		const list = values.get( name );
		if ( list ) list.push( value );
		else values.set( name, [ value ] );

	}
	return Object.freeze( {
		entries,
		get: ( name: SettingName ) => values.get( name )?.[ 0 ] ?? null,
		has: ( name: SettingName ) => values.has( name ),
		getAll: ( name: SettingName ) => [ ...( values.get( name ) ?? [] ) ],
		prefixed: ( prefix: SettingPrefix ) => entries.filter( ( [ name ] ) => name.startsWith( prefix ) ).map( ( [ name, value ] ): [ string, string ] => [ name, value ] ),
	} );

}

const isDeclared = ( name: string ): name is SettingName => Object.hasOwn( SETTINGS, name );

/** Each name nobody declared and each value outside its declared range, as `?name=value: why`. */
export function settingProblems( query: ParsedSettings ): string[] {

	const out: string[] = [];
	for ( const [ name, value ] of query.entries ) {

		const at = `?${ value === '' ? name : `${ name }=${ value }` }`;
		if ( ! isDeclared( name ) ) {

			if ( ! Object.keys( SETTING_PREFIXES ).some( ( prefix ) => name.startsWith( prefix ) ) ) out.push( `${ at }: no such option` );
			continue;

		}
		const spec: SettingSpec = SETTINGS[ name ];
		const values = spec.values ?? [];
		if ( spec.type === 'choice' && ! values.includes( value ) ) out.push( `${ at }: expected ${ values.map( ( v ) => v === '' ? 'nothing' : v ).join( ', ' ) }` );
		else if ( spec.type === 'list' && spec.values && value !== '' ) {

			const unknown = value.split( ',' ).filter( ( item ) => ! values.includes( item ) );
			if ( unknown.length ) out.push( `${ at }: ${ unknown.join( ', ' ) } not among ${ values.join( ', ' ) }` );

		} else if ( ( spec.type === 'number' || spec.type === 'integer' ) && ! spec.words?.includes( value ) ) {

			const n = value.trim() === '' ? NaN : Number( value );
			const [ lo, hi ] = spec.range ?? [ - Infinity, Infinity ];
			if ( ! Number.isFinite( n ) ) out.push( `${ at }: not a number${ spec.words ? ` or ${ spec.words.join( ', ' ) }` : '' }` );
			else if ( spec.type === 'integer' && ! Number.isInteger( n ) ) out.push( `${ at }: not a whole number` );
			else if ( n < lo || n > hi ) out.push( `${ at }: outside ${ lo } to ${ hi }` );

		}

	}
	return out;

}

const NONE = parseSettings( '' );
let installed: { query: ParsedSettings; tier: string | null } | null = null;
// the first option read before the install (a module that loaded before the entry installed them)
let readEarly: string | null = null;
const current = ( name: string ) => {

	if ( ! installed ) readEarly ??= name;
	return installed?.query ?? NONE;

};

/** Installs the page's settings and the quality tier its entry chose (null: the `quality` option's,
 * else the default: Quality.ts `loadTier`), before the modules that read them load. Once only; it
 * warns when a module read an option before (it took the default, whatever the address says). */
export function installSettings( query: ParsedSettings, tier: string | null = null ): void {

	if ( installed ) throw new Error( 'installSettings: the settings are installed once, before the modules that read them' );
	if ( readEarly !== null ) console.warn( `[settings] ?${ readEarly } was read before the settings were installed` );
	installed = { query, tier };

}

/** The installed settings (every option absent where none are installed). */
export const settings: ParsedSettings & { readonly installed: boolean; readonly tier: string | null } = Object.freeze( {
	get entries() { return current( 'entries' ).entries; },
	get installed() { return installed !== null; },
	get tier() { current( 'quality' ); return installed?.tier ?? null; },
	get: ( name: SettingName ) => current( name ).get( name ),
	has: ( name: SettingName ) => current( name ).has( name ),
	getAll: ( name: SettingName ) => current( name ).getAll( name ),
	prefixed: ( prefix: SettingPrefix ) => current( prefix ).prefixed( prefix ),
} );
