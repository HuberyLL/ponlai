// Checks of the interface's words (packages/game/ui/i18n/, its header has the rules): that no Chinese
// is written in the code outside the catalogues, so every word the player reads goes through one,
// and how far each other language's catalogue has drifted from the source, zh-CN.json: the keys it
// lacks (the page shows the Chinese for them), the keys the source no longer has, and the values
// that name other values ({{place}}) than the source's. A key's plural forms (_one, _other) count
// as the key.
//
// Fails (exit 1) on a Chinese literal in the code outside ALLOWED, and on a source value that is
// not a non-empty string. The drift of another language is reported, not failed: English is a
// snapshot not maintained while the game is in development (`--strict` fails on it too, for when
// a language is). `--list` prints every drifted key.
// Pure CPU; reads the sources with TypeScript's parser.
// Run: node tools/game/verify-i18n.mjs [--strict] [--list]
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { ROOT } from '../kit/root.mjs';

const CATALOGUES = join( ROOT, 'packages/game/ui/i18n' );
const SOURCE = 'zh-CN';
const strict = process.argv.includes( '--strict' ), list = process.argv.includes( '--list' );

// Chinese characters, CJK punctuation and full-width forms
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
// the literals that are content, not the interface's words: the islanders' names (they are the
// save's), the stand-in brain's lines, and the debug panel's placeholder lines and days (what
// people say, as a brain's lines will be); by file and the variable they are declared in
const ALLOWED = {
	'packages/game/sim/Sim.ts': [ 'NAMES' ],
	'packages/game/sim/standin.ts': [ 'HUNGRY_WORDS', 'THANKS_WORDS' ],
	'packages/game/GameDebug.ts': [ 'REPLIES' ],
	'packages/game/ui/data/record.ts': [ 'PLACEHOLDER_NAMES', 'PLACEHOLDER_DAYS' ],
};
const PLURAL = /_(zero|one|two|few|many|other)$/;

let failed = false;
const fail = ( line ) => {

	failed = true;
	console.log( `FAIL ${ line }` );

};

// 1. Chinese literals in the code (the catalogues' folder aside: its formatter writes numerals)
function walk( dir, out ) {

	for ( const name of readdirSync( dir ) ) {

		const path = join( dir, name );
		if ( statSync( path ).isDirectory() ) {

			if ( path !== CATALOGUES ) walk( path, out );

		} else if ( /\.tsx?$/.test( name ) && ! name.endsWith( '.d.ts' ) ) out.push( path );

	}
	return out;

}

function declaredIn( node ) {

	for ( let n = node.parent; n; n = n.parent ) if ( ts.isVariableDeclaration( n ) && ts.isIdentifier( n.name ) ) return n.name.text;
	return null;

}

let files = 0, literals = 0;
for ( const path of [ 'packages', 'app' ].flatMap( ( root ) => walk( join( ROOT, root ), [] ) ) ) {

	const file = relative( ROOT, path ), allowed = ALLOWED[ file ] ?? [];
	const source = ts.createSourceFile( path, readFileSync( path, 'utf8' ), ts.ScriptTarget.Latest, true );
	files ++;
	const visit = ( node ) => {

		if ( ( ts.isStringLiteral( node ) || ts.isNoSubstitutionTemplateLiteral( node ) || ts.isTemplateHead( node ) || ts.isTemplateMiddle( node ) || ts.isTemplateTail( node ) ) && CJK.test( node.text ) ) {

			if ( ! allowed.includes( declaredIn( node ) ) ) {

				literals ++;
				const { line } = source.getLineAndCharacterOfPosition( node.getStart() );
				fail( `${ file }:${ line + 1 } Chinese in code: ${ JSON.stringify( node.text ) } (a key of the catalogue: packages/game/ui/i18n/i18n.ts)` );

			}

		}
		ts.forEachChild( node, visit );

	};
	visit( source );

}
console.log( `code: ${ files } files, ${ literals } Chinese literal(s) outside the catalogues` );

// 2. the catalogues: every leaf a string, keyed by its dotted path
function flatten( object, prefix = '', out = new Map() ) {

	for ( const [ key, value ] of Object.entries( object ) ) {

		const path = prefix ? `${ prefix }.${ key }` : key;
		if ( value !== null && typeof value === 'object' && ! Array.isArray( value ) ) flatten( value, path, out );
		else out.set( path, value );

	}
	return out;

}

const names = ( value ) => new Set( [ ...String( value ).matchAll( /\{\{\s*([\w.]+)\s*(?:,[^}]*)?\}\}/g ) ].map( ( m ) => m[ 1 ] ) );
const read = ( locale ) => flatten( JSON.parse( readFileSync( join( CATALOGUES, `${ locale }.json` ), 'utf8' ) ) );

const source = read( SOURCE );
for ( const [ key, value ] of source ) if ( typeof value !== 'string' || value === '' ) fail( `${ SOURCE }.json ${ key }: not a non-empty string` );
// the source's keys without their plural forms, each with the values it names
const base = new Map();
for ( const [ key, value ] of source ) {

	const k = key.replace( PLURAL, '' );
	base.set( k, new Set( [ ...( base.get( k ) ?? [] ), ...names( value ) ] ) );

}
console.log( `${ SOURCE }: ${ source.size } strings (the source)` );

for ( const name of readdirSync( CATALOGUES ) ) {

	const locale = name.replace( /\.json$/, '' );
	if ( ! name.endsWith( '.json' ) || locale === SOURCE ) continue;
	const other = read( locale );
	const keys = new Set( [ ...other.keys() ].map( ( k ) => k.replace( PLURAL, '' ) ) );
	const missing = [ ...base.keys() ].filter( ( k ) => ! keys.has( k ) );
	const stale = [ ...keys ].filter( ( k ) => ! base.has( k ) );
	// a value naming one the source does not give shows its {{name}} raw; one dropping a value may be the language's way
	const unknown = [], dropped = [];
	for ( const [ key, value ] of other ) {

		const k = key.replace( PLURAL, '' ), given = base.get( k );
		if ( ! given ) continue;
		if ( typeof value !== 'string' ) unknown.push( `${ key } (not a string)` );
		else if ( [ ...names( value ) ].some( ( n ) => ! given.has( n ) ) ) unknown.push( key );
		else if ( [ ...given ].some( ( n ) => ! names( value ).has( n ) && ! ( n === 'count' && PLURAL.test( key ) ) ) ) dropped.push( key );

	}
	const drift = missing.length + stale.length + unknown.length;
	const say = strict && drift > 0 ? fail : ( line ) => console.log( line );
	say( `${ locale }: ${ other.size } strings; ${ missing.length } missing (shown in ${ SOURCE }), ${ stale.length } no longer in the source, ${ unknown.length } naming values the source does not give, ${ dropped.length } leaving a value unsaid` );
	if ( list ) {

		for ( const k of missing ) console.log( `  missing  ${ k }` );
		for ( const k of stale ) console.log( `  stale    ${ k }` );
		for ( const k of unknown ) console.log( `  unknown  ${ k }` );
		for ( const k of dropped ) console.log( `  unsaid   ${ k }` );

	}

}

console.log( failed ? 'verify-i18n: FAILED' : 'verify-i18n: ok' );
process.exit( failed ? 1 : 0 );
