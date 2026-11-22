// The player's graphics options: a settings menu's choices, each mapped onto the quality table.
//
// The options a game's graphics menu offers (the presets are the quality tiers, Quality.ts): each
// option has a few choices, and each choice sets fields of the tier's profile (`QualityProfile`) by
// their paths, the same paths `?tier.<path>` overrides. A choice of a levelled option (`levels`:
// high, medium, low) takes its fields from that tier's row, so a preset is always one choice of
// every option and the values have one home, the table in Quality.ts. A setting whose saving at the
// high tier's 4K output is under 0.3 ms in every measured view (about 2 % of the frame, twice the
// A/A noise of a profile-frame compare) stays per tier only, out of the menu: the screen-space
// reflection's step count (`water.ssrIterations`) the haze's grid (`post.hazeGrid`), the sky's cadence and the refracted sun's among them. A page option (`page`) sets
// nothing in the profile: the app applies it itself (the frame-rate readout).
//
// `resolveGraphics` turns a stored choice into the tier to build and the `tier.*` overrides that
// carry the player's own choices (a custom preset's options that differ from its base tier); the
// app installs them with the URL's settings (app/GraphicsSettings.ts), so every module reads them
// through `qualityProfile` as it reads an A/B override, and an override in the URL, given after
// them, wins. A stored record that is not exactly of this version's shape (another version, an
// unknown option or choice, a missing one) resolves to nothing: the app drops it.
//
// - `applies`: `live` options change on a running page through the render pipeline's setters (the
//   resolution, the pacer, the sky's runtime quality: `RenderStages.ts` `applySkyQuality`);
//   `reload` ones are compiled into materials or the frame graph and change with a reload.
// - No option changes the weather, the clock or the lighting state (Quality.ts): a choice changes
//   the cost, never the mood.
// - tools/render/verify-graphics-options.mjs checks the table: every path exists in the profile,
//   every tier row is one choice of every option, every live option's fields have a runtime setter.
//
// This module imports types and the table only, so the CPU-only tools read it under plain node.
import { QUALITY, QUALITY_TIERS, isQualityTier, type QualityProfile, type QualityTier } from './Quality.ts';

export type GraphicsGroup = 'display' | 'quality';

/** The resolution option's heights in device pixels (720p to 4K); a height at or above the display's
 * own renders natively, so the menu offers only those below it besides native. */
export const RESOLUTION_ROWS: readonly number[] = [ 720, 900, 1080, 1440, 1800, 2160 ];

export interface GraphicsChoice {
	readonly id: string;
	/** the profile's fields this choice sets, by path (a levelled option's come from its tier's row) */
	readonly values: Readonly<Record<string, unknown>>;
}

export interface GraphicsOption {
	readonly id: string;
	readonly group: GraphicsGroup;
	readonly applies: 'live' | 'reload';
	/** the profile's fields the option sets, by path (none for a page option) */
	readonly fields: readonly string[];
	readonly choices: readonly GraphicsChoice[];
	/** set by the app, not the profile (its choice is stored; the tiers do not differ in it) */
	readonly page?: { readonly default: string };
}

/** The profile's value at a path (`water.ssrIterations`), or undefined where the path names none. */
export function profileAt( profile: Readonly<QualityProfile>, path: string ): unknown {

	let node: unknown = profile;
	for ( const name of path.split( '.' ) ) {

		if ( node === null || typeof node !== 'object' || ! ( name in node ) ) return undefined;
		node = ( node as Record<string, unknown> )[ name ];

	}
	return node;

}

const TIERS_DOWN: readonly QualityTier[] = [ 'high', 'medium', 'low' ];

// a levelled option's choices: high, medium and low, each its tier's row at the fields
function levels( fields: readonly string[] ): GraphicsChoice[] {

	return TIERS_DOWN.map( ( tier ) => ( { id: tier, values: Object.fromEntries( fields.map( ( f ) => [ f, profileAt( QUALITY[ tier ], f ) ] ) ) } ) );

}

function choices( field: string, list: ReadonlyArray<readonly [ string, unknown ]> ): GraphicsChoice[] {

	return list.map( ( [ id, value ] ) => ( { id, values: { [ field ]: value } } ) );

}

function option( id: string, group: GraphicsGroup, applies: 'live' | 'reload', fields: readonly string[], list: GraphicsChoice[] ): GraphicsOption {

	return { id, group, applies, fields, choices: list };

}

/** The menu's options, in its order. */
export const GRAPHICS_OPTIONS: readonly GraphicsOption[] = [
	// the render's height in device pixels, its width the view's aspect (a PC game's list of
	// resolutions; the menu offers those below the display's own, RESOLUTION_ROWS); auto: the tier's
	// own pixel count (1440p's at 4K output); native: the display's own
	option( 'resolution', 'display', 'live', [ 'render.dynamic.rows' ], choices( 'render.dynamic.rows', [ [ 'auto', 0 ], ...RESOLUTION_ROWS.map( ( r ) => [ String( r ), r ] as const ), [ 'native', - 1 ] ] ) ),
	option( 'dynamic', 'display', 'live', [ 'render.dynamic.pinned' ], choices( 'render.dynamic.pinned', [ [ 'on', false ], [ 'off', true ] ] ) ),
	// MSAA 4x (upscaled by FSR 1), or a temporal resolve; the meadow needs one of them (no `off`)
	option( 'aa', 'display', 'reload', [ 'aa' ], choices( 'aa', [ [ 'msaa', 'msaa' ], [ 'taa', 'taa' ], [ 'taau', 'taau' ], [ 'fsr3', 'fsr3' ] ] ) ),
	// the pacer's rate: 0 renders on every refresh
	option( 'frameRate', 'display', 'live', [ 'frameRate' ], choices( 'frameRate', [ [ '30', 30 ], [ '60', 60 ], [ 'max', 0 ] ] ) ),
	{ id: 'fps', group: 'display', applies: 'live', fields: [], choices: [ { id: 'off', values: {} }, { id: 'on', values: {} } ], page: { default: 'off' } },
	// the meadow's screen-space shadows; without them the ambient occlusion is off too (it reads their prepass)
	option( 'meadowShadows', 'quality', 'reload', [ 'meadowShadows' ], choices( 'meadowShadows', [ [ 'on', true ], [ 'off', false ] ] ) ),
	option( 'ao', 'quality', 'reload', [ 'ao' ], choices( 'ao', [ [ 'on', true ], [ 'off', false ] ] ) ),
	option( 'clouds', 'quality', 'live', [ 'cloudView', 'cloudDome', 'cloudMarch' ], levels( [ 'cloudView', 'cloudDome', 'cloudMarch' ] ) ),
];

export type GraphicsPreset = QualityTier | 'custom';

/** What the app stores for the player (one key, app/GraphicsSettings.ts). */
export interface GraphicsRecord {
	v: number;
	preset: GraphicsPreset;
	/** the tier a custom preset starts from and builds (a named preset's own tier) */
	base: QualityTier;
	/** every option's choice */
	options: Record<string, string>;
}

/** bumped when the options or their choices change, so a stored record of another shape is dropped */
export const GRAPHICS_VERSION = 2;

const same = ( a: unknown, b: unknown ): boolean => JSON.stringify( a ) === JSON.stringify( b );

export function findOption( id: string ): GraphicsOption | undefined {

	return GRAPHICS_OPTIONS.find( ( o ) => o.id === id );

}

/** The choice of `option` a tier's row holds (its own level first), or the page option's default. */
export function tierChoice( option: GraphicsOption, tier: QualityTier ): string {

	if ( option.page ) return option.page.default;
	const row = QUALITY[ tier ];
	const matches = option.choices.filter( ( c ) => option.fields.every( ( f ) => same( c.values[ f ], profileAt( row, f ) ) ) );
	return ( matches.find( ( c ) => c.id === tier ) ?? matches[ 0 ] )?.id ?? option.choices[ 0 ].id;

}

/** Every option's choice under a tier. */
export function presetChoices( tier: QualityTier ): Record<string, string> {

	return Object.fromEntries( GRAPHICS_OPTIONS.map( ( o ) => [ o.id, tierChoice( o, tier ) ] ) );

}

/** A record for a named preset (its tier's choices). */
export function presetRecord( tier: QualityTier ): GraphicsRecord {

	return { v: GRAPHICS_VERSION, preset: tier, base: tier, options: presetChoices( tier ) };

}

/** The record with one option changed: it becomes custom unless every choice is again its base's
 * (or another tier's, which it then names). */
export function withChoice( record: GraphicsRecord, id: string, choice: string ): GraphicsRecord {

	const options = { ...record.options, [ id ]: choice };
	const profiled = ( o: GraphicsOption ) => ! o.page;
	const named = [ record.base, ...QUALITY_TIERS ].find( ( tier ) => GRAPHICS_OPTIONS.filter( profiled ).every( ( o ) => options[ o.id ] === tierChoice( o, tier ) ) );
	return named ? { v: GRAPHICS_VERSION, preset: named, base: named, options } : { v: GRAPHICS_VERSION, preset: 'custom', base: record.base, options };

}

/** A stored value as a record of this version, or null when it is not exactly one. */
export function readGraphicsRecord( value: unknown ): GraphicsRecord | null {

	if ( value === null || typeof value !== 'object' ) return null;
	const r = value as Partial<GraphicsRecord>;
	if ( r.v !== GRAPHICS_VERSION || ! isQualityTier( r.base ) || ! ( r.preset === 'custom' || isQualityTier( r.preset ) ) ) return null;
	if ( r.preset !== 'custom' && r.preset !== r.base ) return null;
	const options = r.options;
	if ( ! options || typeof options !== 'object' ) return null;
	const ids = Object.keys( options );
	if ( ids.length !== GRAPHICS_OPTIONS.length ) return null;
	for ( const o of GRAPHICS_OPTIONS ) if ( ! o.choices.some( ( c ) => c.id === ( options as Record<string, unknown> )[ o.id ] ) ) return null;
	return { v: r.v, preset: r.preset, base: r.base, options: { ...options } };

}

/** A setting's value as a `tier.<path>` override takes it (Quality.ts `qualityProfile`). */
export function overrideValue( value: unknown ): string {

	return value !== null && typeof value === 'object' ? JSON.stringify( value ) : String( value );

}

/** What a record builds: its tier and the overrides of its custom choices (`tier.<path>`, value). */
export function resolveGraphics( record: GraphicsRecord ): { tier: QualityTier; overrides: Array<[ string, string ]> } {

	const row = QUALITY[ record.base ];
	const overrides: Array<[ string, string ]> = [];
	if ( record.preset === 'custom' ) for ( const o of GRAPHICS_OPTIONS ) {

		const choice = o.choices.find( ( c ) => c.id === record.options[ o.id ] )!;
		for ( const f of o.fields ) if ( ! same( choice.values[ f ], profileAt( row, f ) ) ) overrides.push( [ `tier.${ f }`, overrideValue( choice.values[ f ] ) ] );

	}
	return { tier: record.base, overrides };

}

/** The profile's fields a choice sets (empty for a page option). */
export function choiceValues( id: string, choice: string ): Readonly<Record<string, unknown>> {

	return findOption( id )?.choices.find( ( c ) => c.id === choice )?.values ?? {};

}
