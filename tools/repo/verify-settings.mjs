// Checks the page's settings against their docs, the entry that installs them and the tools' addresses.
//
// The settings (packages/render/Settings.ts) are the one entrance every URL option is read
// through; each layer declares its own options in a table (the renderer's RENDER_SETTINGS there,
// packages/island/IslandSettings.ts, packages/game/GameSettings.ts, app/AppSettings.ts), which the
// page merges (app/AppSettings.ts PAGE_SETTINGS); docs/reference/url-options.md documents them.
// Run it after adding or changing an option; it is part of `npm run check`. A usage a tool needs
// is declared in the table of the layer that reads it, not changed in the tool.
//
// Usage:
//   node tools/repo/verify-settings.mjs [--write]
//
// Options:
//   --write   rewrites the docs' table of every option first, then checks
//
// Guarantees, each a failure (exit 1) when broken:
// - docs/reference/url-options.md ends with a table of every declared option and prefix (between
//   the markers TABLE_START and TABLE_END), and the table is the one this tool writes from the
//   four layers' tables, in the layers' order, and SETTING_PREFIXES, its Owner column the layer of
//   each option's table: a new or changed option rewrites it (`--write`), so the table never drifts
//   from the code.
// - No option is declared by two layers (mergeSettings throws as the page merges them).
// - Every declared option and prefix is also named in the page's prose (a backticked `name`,
//   `name=...` or `?name...` outside the table and the code blocks), anywhere in it: the table
//   lists, the prose explains. Which of the prose's groups names an option is not checked.
// - Every option the prose writes with a value (a backticked `name=...` or `?name`) is declared, or
//   starts with a declared prefix: the prose names no option the page does not read.
// - The page installs the settings before any module that reads them loads: index.html loads
//   /app/Boot.ts, and Boot.ts imports PageSettings.ts (which installs them) before it imports
//   main.ts dynamically. (A static import of main.ts there, or the install moved into main.ts,
//   would let a bundle evaluate the shared chunks main.ts imports first, and every module in them
//   that reads a setting as it loads would take the default.)
// - No address the tools put on a page draws a `[settings]` warning (settingProblems): the query of
//   every view in the views' table (tools/project.mjs `tables.views`,
//   tools/island/parity/views.mjs), and every query written as a literal in tools/**/*.mjs (a
//   string with `&`, `=` or a leading `?` whose parts are all `name` or `name=value` and one of
//   them a declared option; a part built from `${ ... }` is left out, a literal with a placeholder
//   (`<` or `|`) is usage text, a lone `name=` is a prefix to match, and a literal passed to
//   parseSettings tests the parser). A usage a tool needs is declared, not changed in the tool.
//   Queries assembled from separate pieces (profile-frame.mjs's list) are outside this scan.
// - No option is declared in a layer above the lowest layer whose code reads it (the layers of
//   code's folders, render lowest, then island, game, app): the owner the table prints is a
//   layer that reads it. (A layer's reader takes only its own names and those below it, so a read
//   above the declaring layer cannot type-check: this check sees the other way round.) A read is a call `<any>.get( 'name' )`, `.has`, `.getAll` or `.prefixed`
//   (a prefix), or `numberSetting( 'name', ... )`, in a file under `packages/` or `app/`, comments left out; a
//   read through a helper of its own (WorldStart.ts `intParam`) is not seen.
//
// Output: a summary line on stdout (with --write, first a line saying the table was rewritten),
// then PASS or FAIL with the failures. --write rewrites docs/reference/url-options.md's table.
//
// GPU lock and browser: neither. Cost: well under a second, CPU only (plain node, which strips the
// module's types).
//
// Exit codes: 0 everything passes; 1 a failure (listed) or an unknown option.
import '../kit/help.mjs';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../kit/root.mjs';
import PROJECT from '../project.mjs';

const DOC = path.join( ROOT, 'docs', 'reference', 'url-options.md' );
const TABLE_START = '<!-- every-option:start (written by tools/repo/verify-settings.mjs --write) -->';
const TABLE_END = '<!-- every-option:end -->';

let write = false;
for ( const a of process.argv.slice( 2 ) ) {

	if ( a === '--write' ) write = true;
	else {

		console.error( `verify-settings: unknown option '${ a }' (only --write)` );
		process.exit( 1 );

	}

}

const { RENDER_SETTINGS, SETTING_PREFIXES, parseSettings, settingProblems } = await import( path.join( ROOT, 'packages', 'render', 'Settings.ts' ) );
const { ISLAND_SETTINGS } = await import( path.join( ROOT, 'packages', 'island', 'IslandSettings.ts' ) );
const { GAME_SETTINGS } = await import( path.join( ROOT, 'packages', 'game', 'GameSettings.ts' ) );
// the page's merge throws as it loads where two layers declare one name
const { APP_SETTINGS, PAGE_SETTINGS } = await import( path.join( ROOT, 'app', 'AppSettings.ts' ) );
// each layer's table and where it is declared, render lowest
const TABLES = [
	[ 'render', RENDER_SETTINGS, 'packages/render/Settings.ts' ],
	[ 'island', ISLAND_SETTINGS, 'packages/island/IslandSettings.ts' ],
	[ 'game', GAME_SETTINGS, 'packages/game/GameSettings.ts' ],
	[ 'app', APP_SETTINGS, 'app/AppSettings.ts' ],
];
// every option with its layer and its table's file, in the layers' order
const SETTINGS = {};
for ( const [ layer, options, file ] of TABLES ) for ( const [ name, spec ] of Object.entries( options ) ) SETTINGS[ name ] = { ...spec, layer, file };
const PREFIX_LAYER = 'render';

const code = ( v ) => `\`${ v }\``;
const number = ( n ) => n === Infinity ? 'any' : n === - Infinity ? 'any' : String( n );

/** The values column: what the option takes. */
function values( spec ) {

	switch ( spec.type ) {

		case 'switch': return 'named (its value unread)';
		case 'choice': return spec.values.map( ( v ) => v === '' ? 'named bare' : code( v ) ).join( ', ' );
		case 'list': return spec.values ? `a comma list of ${ spec.values.map( code ).join( ', ' ) }` : 'a comma list';
		case 'text': return 'text';
		default: {

			const [ lo, hi ] = spec.range ?? [ - Infinity, Infinity ];
			const kind = spec.type === 'integer' ? 'a whole number' : 'a number';
			const range = lo === - Infinity && hi === Infinity ? kind : hi === Infinity ? `${ kind } from ${ lo }` : `${ kind }, ${ number( lo ) } to ${ number( hi ) }`;
			return spec.words ? `${ range }, or ${ spec.words.map( code ).join( ', ' ) }` : range;

		}

	}

}

function table() {

	const rows = [
		'| Option | Takes | Without it | Owner | What it sets |',
		'| --- | --- | --- | --- | --- |',
	];
	const row = ( name, spec ) => rows.push( `| ${ code( name ) } | ${ values( spec ) } | ${ spec.default } | ${ spec.layer } | ${ spec.about }${ spec.debug ? ' (debug pages only)' : '' } |` );
	for ( const [ name, spec ] of Object.entries( SETTINGS ) ) row( name, spec );
	for ( const [ prefix, spec ] of Object.entries( SETTING_PREFIXES ) ) row( `${ prefix }<knob>`, { ...spec, layer: PREFIX_LAYER } );
	return rows.join( '\n' );

}

const failures = [];
let doc = readFileSync( DOC, 'utf8' );
const start = doc.indexOf( TABLE_START ), end = doc.indexOf( TABLE_END );
if ( start < 0 || end < start ) failures.push( `${ path.relative( ROOT, DOC ) }: no table between its markers (${ TABLE_START } ... ${ TABLE_END })` );
else {

	const written = `${ TABLE_START }\n\n${ table() }\n\n${ TABLE_END }`;
	if ( doc.slice( start, end + TABLE_END.length ) !== written ) {

		if ( write ) {

			doc = doc.slice( 0, start ) + written + doc.slice( end + TABLE_END.length );
			writeFileSync( DOC, doc );
			console.log( `verify-settings: rewrote the table in ${ path.relative( ROOT, DOC ) }` );

		} else failures.push( `${ path.relative( ROOT, DOC ) }: the table of every option differs from the layers' tables: run node tools/repo/verify-settings.mjs --write` );

	}

}

// the prose: the page without the table and the fenced code
const prose = ( start >= 0 && end > start ? doc.slice( 0, start ) + doc.slice( end ) : doc ).replace( /^```[^\n]*\n[\s\S]*?^```$/gm, '' );
const named = new Set(), valued = new Map();
for ( const [ , token ] of prose.matchAll( /`([^`\n]+)`/g ) ) {

	const m = /^\??([A-Za-z][\w.]*)(=|$|\s*\(|\|)/.exec( token );
	if ( ! m ) continue;
	named.add( m[ 1 ] );
	if ( token.startsWith( '?' ) || m[ 2 ] === '=' ) valued.set( m[ 1 ], token );

}
const prefixes = Object.keys( SETTING_PREFIXES );
const declared = ( name ) => Object.hasOwn( SETTINGS, name ) || prefixes.some( ( p ) => name.startsWith( p ) );
for ( const [ name, spec ] of Object.entries( SETTINGS ) ) if ( ! named.has( name ) ) failures.push( `option ${ name }: declared in ${ spec.file }, but the prose of url-options.md never names it` );
for ( const prefix of prefixes ) if ( ! [ ...named ].some( ( n ) => n.startsWith( prefix ) ) ) failures.push( `prefix ${ prefix }: declared in packages/render/Settings.ts, but the prose of url-options.md never uses it` );
for ( const [ name, token ] of valued ) if ( ! declared( name ) ) failures.push( `url-options.md writes \`${ token }\`, but no layer's table declares an option ${ name }` );

// each option's layer against its readers'
const RANK = { render: 0, island: 1, game: 2, app: 3 };
// each code file's layer, its folder: app/, or the package's folder under packages/
const LAYERS = {};
for ( const root of [ 'packages', 'app' ] ) for ( const f of readdirSync( path.join( ROOT, root ), { recursive: true } ) ) {

	const file = `${ root }/${ f.split( path.sep ).join( '/' ) }`;
	if ( /\.(ts|mts|js|mjs)$/.test( file ) ) LAYERS[ file ] = root === 'app' ? 'app' : file.split( '/' )[ 1 ];

}
const lowest = new Map();
for ( const [ file, layer ] of Object.entries( LAYERS ) ) {

	const text = readFileSync( path.join( ROOT, file ), 'utf8' ).replace( /^\s*\/\/.*$/gm, '' );
	for ( const m of text.matchAll( /\.(?:get|has|getAll|prefixed)\(\s*'([^']+)'|\bnumberSetting\(\s*'([^']+)'/g ) ) {

		const name = m[ 1 ] ?? m[ 2 ];
		if ( ! Object.hasOwn( SETTINGS, name ) && ! Object.hasOwn( SETTING_PREFIXES, name ) ) continue;
		const known = lowest.get( name );
		if ( ! known || RANK[ layer ] < RANK[ known.layer ] ) lowest.set( name, { layer, file } );

	}

}
for ( const [ name, spec ] of [ ...Object.entries( SETTINGS ), ...Object.entries( SETTING_PREFIXES ).map( ( [ p, v ] ) => [ p, { ...v, layer: PREFIX_LAYER, file: 'packages/render/Settings.ts' } ] ) ] ) {

	const low = lowest.get( name );
	if ( low && RANK[ spec.layer ] > RANK[ low.layer ] ) failures.push( `option ${ name }: declared in the ${ spec.layer } layer (${ spec.file }), but ${ low.file } in the ${ low.layer } layer reads it` );

}

// the entry's order
const html = readFileSync( path.join( ROOT, 'index.html' ), 'utf8' );
if ( ! /<script[^>]*\bsrc="\/app\/Boot\.ts"/.test( html ) ) failures.push( 'index.html: does not load /app/Boot.ts as its script' );
const boot = readFileSync( path.join( ROOT, 'app', 'Boot.ts' ), 'utf8' ).replace( /^\s*\/\/.*$/gm, '' );
const install = boot.search( /^import '\.\/PageSettings\.ts';$/m ), page = boot.search( /^await import\( '\.\/main\.ts' \);$/m );
if ( install < 0 || page < 0 || install > page ) failures.push( 'app/Boot.ts: must import \'./PageSettings.ts\' first, then `await import( \'./main.ts\' )`' );
if ( /^import[^;]*'\.\/main\.ts'/m.test( boot ) ) failures.push( 'app/Boot.ts: imports main.ts statically (its shared chunks would load before the settings are installed)' );

// the tools' addresses
let queries = 0;
const { VIEWS } = await import( path.join( ROOT, PROJECT.tables.views ) );
for ( const [ name, view ] of Object.entries( VIEWS ) ) {

	queries ++;
	for ( const p of settingProblems( parseSettings( view.q ?? '' ), PAGE_SETTINGS ) ) failures.push( `${ PROJECT.tables.views } ${ name }: ${ p }` );

}
const PART = /^([A-Za-z][\w.]*)(?:=([^&\s'"`]*))?$/;
const BUILT = '\u0001';
for ( const file of readdirSync( path.join( ROOT, 'tools' ), { recursive: true } ).filter( ( f ) => f.endsWith( '.mjs' ) ) ) {

	const text = readFileSync( path.join( ROOT, 'tools', file ), 'utf8' ).replace( /^\s*(\/\/|\*).*$/gm, '' );
	for ( const m of text.matchAll( /(parseSettings\(\s*)?(?:'([^'\n]*)'|"([^"\n]*)"|`([^`]*)`)/g ) ) {

		if ( m[ 1 ] ) continue;
		const literal = ( m[ 2 ] ?? m[ 3 ] ?? m[ 4 ] ).replace( /\$\{[^}]*\}/g, BUILT );
		const query = literal.replace( /^\?/, '' );
		if ( ! ( literal.startsWith( '?' ) || query.includes( '&' ) || query.includes( '=' ) ) ) continue;
		if ( /[<|]/.test( query ) || /^[\w.]+=$/.test( query ) ) continue;
		const parts = query.split( '&' ).filter( Boolean );
		const fixed = parts.filter( ( p ) => ! p.includes( BUILT ) );
		if ( ! parts.length || ! fixed.every( ( p ) => PART.test( p ) ) ) continue;
		if ( ! fixed.some( ( p ) => declared( PART.exec( p )[ 1 ] ) ) ) continue;
		queries ++;
		const shown = literal.replaceAll( BUILT, '${...}' );
		for ( const p of settingProblems( parseSettings( fixed.join( '&' ) ), PAGE_SETTINGS ) ) failures.push( `tools/${ file }: '${ shown }' draws the warning ${ p }` );

	}

}

console.log( `verify-settings: ${ Object.keys( SETTINGS ).length } options and ${ prefixes.length } prefix declared, ${ lowest.size } read in the code, ${ named.size } names in the docs' prose, ${ valued.size } written with a value, ${ queries } tool queries checked` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
