// Checks the page's settings (src/Settings.ts) against their documentation and the entry that
// installs them, and the addresses the tools build against them. CPU only (plain `node`, which
// strips the module's types), well under a second.
//   node tools/verify-settings.mjs            check
//   node tools/verify-settings.mjs --write    rewrite the docs' table of every option, then check
//
// Guarantees, each a failure (exit 1) when broken:
// - docs/reference/url-options.md ends with a table of every declared option and prefix (between
//   the markers TABLE_START and TABLE_END), and the table is the one this tool writes from
//   SETTINGS and SETTING_PREFIXES: a new or changed option rewrites it (`--write`), so the table
//   never drifts from the code.
// - Every declared option and prefix is also named in the page's prose (a backticked `name`,
//   `name=...` or `?name...` outside the table and the code blocks), in the group its reader
//   belongs to: the table lists, the prose explains.
// - Every option the prose writes with a value (a backticked `name=...` or `?name`) is declared, or
//   starts with a declared prefix: the prose names no option the page does not read.
// - The page installs the settings before any module that reads them loads: index.html loads
//   /src/Boot.ts, and Boot.ts imports PageSettings.ts (which installs them) before it imports
//   main.ts dynamically. (A static import of main.ts there, or the install moved into main.ts,
//   would let a bundle evaluate the shared chunks main.ts imports first, and every module in them
//   that reads a setting as it loads would take the default.)
// - No address the tools put on a page draws a `[settings]` warning (settingProblems): the query of
//   every view in tools/parity/views.mjs, and every query written as a literal in tools/**/*.mjs (a
//   string with `&`, `=` or a leading `?` whose parts are all `name` or `name=value` and one of
//   them a declared option; a part built from `${ ... }` is left out, a literal with a placeholder
//   (`<` or `|`) is usage text, a lone `name=` is a prefix to match, and a literal passed to
//   parseSettings tests the parser). A usage a tool needs is declared, not changed in the tool.
//   Queries assembled from separate pieces (profile-frame.mjs's list) are outside this scan.
//
// Output: a summary line, then the failures. Exit 0 when everything passes, 1 otherwise or on an
// unknown option.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const DOC = path.join( ROOT, 'docs', 'reference', 'url-options.md' );
const TABLE_START = '<!-- every-option:start (written by tools/verify-settings.mjs --write) -->';
const TABLE_END = '<!-- every-option:end -->';

let write = false;
for ( const a of process.argv.slice( 2 ) ) {

	if ( a === '--write' ) write = true;
	else {

		console.error( `verify-settings: unknown option '${ a }' (only --write)` );
		process.exit( 1 );

	}

}

const { SETTINGS, SETTING_PREFIXES, parseSettings, settingProblems } = await import( path.join( ROOT, 'src', 'Settings.ts' ) );

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
	for ( const [ prefix, spec ] of Object.entries( SETTING_PREFIXES ) ) row( `${ prefix }<knob>`, spec );
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

		} else failures.push( `${ path.relative( ROOT, DOC ) }: the table of every option differs from src/Settings.ts: run node tools/verify-settings.mjs --write` );

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
for ( const name of Object.keys( SETTINGS ) ) if ( ! named.has( name ) ) failures.push( `option ${ name }: declared in src/Settings.ts, but the prose of url-options.md never names it` );
for ( const prefix of prefixes ) if ( ! [ ...named ].some( ( n ) => n.startsWith( prefix ) ) ) failures.push( `prefix ${ prefix }: declared in src/Settings.ts, but the prose of url-options.md never uses it` );
for ( const [ name, token ] of valued ) if ( ! declared( name ) ) failures.push( `url-options.md writes \`${ token }\`, but no option ${ name } is declared in src/Settings.ts` );

// the entry's order
const html = readFileSync( path.join( ROOT, 'index.html' ), 'utf8' );
if ( ! /<script[^>]*\bsrc="\/src\/Boot\.ts"/.test( html ) ) failures.push( 'index.html: does not load /src/Boot.ts as its script' );
const boot = readFileSync( path.join( ROOT, 'src', 'Boot.ts' ), 'utf8' ).replace( /^\s*\/\/.*$/gm, '' );
const install = boot.search( /^import '\.\/PageSettings\.ts';$/m ), page = boot.search( /^await import\( '\.\/main\.ts' \);$/m );
if ( install < 0 || page < 0 || install > page ) failures.push( 'src/Boot.ts: must import \'./PageSettings.ts\' first, then `await import( \'./main.ts\' )`' );
if ( /^import[^;]*'\.\/main\.ts'/m.test( boot ) ) failures.push( 'src/Boot.ts: imports main.ts statically (its shared chunks would load before the settings are installed)' );

// the tools' addresses
let queries = 0;
const { VIEWS } = await import( path.join( ROOT, 'tools', 'parity', 'views.mjs' ) );
for ( const [ name, view ] of Object.entries( VIEWS ) ) {

	queries ++;
	for ( const p of settingProblems( parseSettings( view.q ?? '' ) ) ) failures.push( `tools/parity/views.mjs ${ name }: ${ p }` );

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
		for ( const p of settingProblems( parseSettings( fixed.join( '&' ) ) ) ) failures.push( `tools/${ file }: '${ shown }' draws the warning ${ p }` );

	}

}

console.log( `verify-settings: ${ Object.keys( SETTINGS ).length } options and ${ prefixes.length } prefix declared, ${ named.size } names in the docs' prose, ${ valued.size } written with a value, ${ queries } tool queries checked` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
