// Checks the graphics menu's options against the quality table, with no browser and no GPU.
//
// It loads packages/render/GraphicsOptions.ts and Quality.ts and checks: every option's field is a
// setting of the profile (QualityProfile) and every choice sets exactly the option's fields; every
// tier's row is one choice of every option, so a preset reads as a set of choices; a live option
// sets only runtime settings (Quality.ts `RUNTIME_SETTINGS`), each named where it is applied; a
// named preset resolves to its tier with no overrides, and a custom one to overrides that, applied
// through `qualityProfile`, give the profile its choices name; a stored record of another version,
// with an unknown option or choice, or with an option missing, is refused whole; and a URL override
// given after the stored ones wins (app/GraphicsSettings.ts `withStoredOverrides`). Run it after a
// change to the options or the tiers' rows; it is part of `npm run check`.
//
// Usage:
//   node tools/render/verify-graphics-options.mjs
//
// Options: none.
//
// Output: one line on stdout naming what passed and the count of assertions made; a failed
// assertion's message and stack on stderr.
//
// GPU lock and browser: neither; node strips the imported TypeScript itself.
//
// Cost: under a second, CPU only.
//
// Exit codes: 0 every check passes; 1 a check failed (the assertion is thrown).
import '../kit/help.mjs';
import { readFileSync } from 'node:fs';
import { assert, assertions } from '../kit/assert-count.mjs';
import { GRAPHICS_OPTIONS, GRAPHICS_VERSION, profileAt, presetRecord, readGraphicsRecord, resolveGraphics, tierChoice, withChoice, choiceValues } from '../../packages/render/GraphicsOptions.ts';
import { QUALITY, QUALITY_TIERS, RUNTIME_SETTINGS, qualityProfile } from '../../packages/render/Quality.ts';
import { withStoredOverrides } from '../../app/GraphicsSettings.ts';

const same = ( a, b ) => JSON.stringify( a ) === JSON.stringify( b );
const ids = new Set();
for ( const o of GRAPHICS_OPTIONS ) {

	assert.ok( ! ids.has( o.id ), `option ${ o.id } declared twice` );
	ids.add( o.id );
	assert.ok( o.choices.length >= 2, `${ o.id }: fewer than two choices` );
	assert.ok( new Set( o.choices.map( ( c ) => c.id ) ).size === o.choices.length, `${ o.id }: a choice id twice` );
	if ( o.page ) {

		assert.equal( o.fields.length, 0, `${ o.id }: a page option sets no profile field` );
		assert.ok( o.choices.some( ( c ) => c.id === o.page.default ), `${ o.id }: its default is not a choice` );
		continue;

	}
	assert.ok( o.fields.length > 0, `${ o.id }: no fields` );
	for ( const f of o.fields ) for ( const tier of QUALITY_TIERS ) assert.notEqual( profileAt( QUALITY[ tier ], f ), undefined, `${ o.id }: ${ f } is not a setting of ${ tier }'s row` );
	for ( const c of o.choices ) assert.ok( same( Object.keys( c.values ).sort(), [ ...o.fields ].sort() ), `${ o.id }.${ c.id }: sets other fields than the option's` );
	// every tier's row is exactly one of the choices
	for ( const tier of QUALITY_TIERS ) {

		const id = tierChoice( o, tier );
		assert.ok( o.fields.every( ( f ) => same( choiceValues( o.id, id )[ f ], profileAt( QUALITY[ tier ], f ) ) ), `${ tier }'s row is no choice of ${ o.id }` );

	}
	if ( o.applies === 'live' ) for ( const f of o.fields ) assert.ok( RUNTIME_SETTINGS.some( ( r ) => f === r || f.startsWith( `${ r }.` ) ), `${ o.id } is live but ${ f } is a load setting (Quality.ts RUNTIME_SETTINGS)` );

}
// each runtime setting is applied where Quality.ts says
const stages = readFileSync( new URL( '../../packages/render/RenderStages.ts', import.meta.url ), 'utf8' );
const frame = readFileSync( new URL( '../../packages/render/assemble/SceneFrame.ts', import.meta.url ), 'utf8' );
for ( const r of RUNTIME_SETTINGS ) {

	const leaf = r.split( '.' ).pop();
	assert.ok( stages.includes( `q.${ r }` ) || stages.includes( `runtimeQuality.${ r }` ) || frame.includes( `dynamic.${ leaf }` ) || ( r === 'frameRate' && frame.includes( 'setRate' ) ), `runtime setting ${ r } is applied nowhere` );

}

// presets: their own tier, no overrides; a custom record's overrides give its choices
for ( const tier of QUALITY_TIERS ) {

	const r = presetRecord( tier );
	assert.ok( same( readGraphicsRecord( JSON.parse( JSON.stringify( r ) ) ), r ), `${ tier }'s record does not read back` );
	assert.ok( same( resolveGraphics( r ), { tier, overrides: [] } ), `${ tier } resolves with overrides` );
	for ( const o of GRAPHICS_OPTIONS ) for ( const c of o.choices ) {

		const changed = withChoice( r, o.id, c.id );
		const { tier: built, overrides } = resolveGraphics( changed );
		assert.equal( built, changed.base );
		const profile = qualityProfile( built, overrides );
		for ( const opt of GRAPHICS_OPTIONS ) for ( const f of opt.fields ) assert.ok( same( profileAt( profile, f ), choiceValues( opt.id, changed.options[ opt.id ] )[ f ] ), `${ tier } with ${ o.id }=${ c.id }: ${ f } is not the chosen value` );
		// back to the tier's own choice names the preset again
		if ( ! o.page ) assert.equal( withChoice( changed, o.id, tierChoice( o, tier ) ).preset, tier );

	}

}
// stored records that are not this version's shape are refused whole
const good = presetRecord( 'high' );
assert.ok( readGraphicsRecord( good ) );
assert.equal( readGraphicsRecord( { ...good, v: GRAPHICS_VERSION + 1 } ), null );
assert.equal( readGraphicsRecord( { ...good, preset: 'ultra' } ), null );
assert.equal( readGraphicsRecord( { ...good, preset: 'medium' } ), null, 'a named preset must be its base' );
assert.equal( readGraphicsRecord( { ...good, options: { ...good.options, shadows: 'on' } } ), null );
assert.equal( readGraphicsRecord( { ...good, options: { ...good.options, ao: 'maybe' } } ), null );
const missing = { ...good.options };
delete missing.ao;
assert.equal( readGraphicsRecord( { ...good, options: missing } ), null );
assert.equal( readGraphicsRecord( null ), null );
assert.equal( readGraphicsRecord( 'high' ), null );
// a URL override given after the stored ones wins
const custom = withChoice( good, 'ao', 'off' );
const search = withStoredOverrides( '?tier.ao=true&weather=fair', custom );
const entries = [ ...new URLSearchParams( search ) ].filter( ( [ k ] ) => k.startsWith( 'tier.' ) );
assert.equal( qualityProfile( 'high', entries ).ao, true );
assert.equal( qualityProfile( 'high', entries.slice( 0, 1 ) ).ao, false );
console.log( `verify-graphics-options: ${ GRAPHICS_OPTIONS.length } options over ${ QUALITY_TIERS.length } tiers, records and precedence ok (${ assertions() } assertions)` );
