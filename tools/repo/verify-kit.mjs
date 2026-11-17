// Checks that the generic tools in tools/kit/ stay apart from the project.
//
// The kit's tools import nothing from packages/, app/ or the other groups of tools (render, island,
// game, repo), only each other and the project's configuration (tools/project.mjs), and no page
// global, output folder or name of the project's own is written in their code. The configuration
// holds what a kit tool needs to know of this project: the page's globals and loading screen, the
// project's name, the output folders and the names shared on the machine (the GPU lock, the jobs'
// registry, the temp folders' prefix), the dev server's address and the default query, what a stored
// reference depends on, where the views' and clips' tables are, and the module that adds the
// pipeline tracer to an eval. Run it after changing a kit tool; it is part of
// `npm run check`.
//
// Usage:
//   node tools/repo/verify-kit.mjs
//
// Options: none.
//
// What counts, per file under tools/kit/ (the folder as it is on disk, so a new file is checked
// before it is staged):
// - JavaScript: every module specifier (static and dynamic imports with a literal, and
//   `new URL( '...', import.meta.url )`) that is a relative path must resolve inside tools/kit/ or to
//   tools/project.mjs; a bare one (node:, a package) is free. A path built at run time from the
//   configuration is how a kit tool reaches a project module, and is not an import of one here.
// - Python: an import of a module beside it only (no `sys.path` entry other than its own folder).
// - Both: no string in the code (comments and docstrings left out) names `packages/`, `app/` or
//   `tools/<another group>/`, and no name of the form `__NAME__` in capitals (the page's globals
//   take that form, the configuration's `page` lists them) appears in the code; no string names the
//   output folder (`artifacts/`, or `'artifacts'` alone: the configuration's `output`), and the
//   project's name (`ponlai`, in any case) appears nowhere in the code, environment variables'
//   names included (they are built from the configuration's `machine.envPrefix`).
//
// - The example's configuration (examples/rock/tools/project.mjs) sets the fields this one sets, no
//   more and no fewer; a field it sets to null stands for that field's whole object.
//
// Output: a summary on stdout (the files, imports and page globals checked), then PASS or FAIL with
// the failures.
//
// GPU lock and browser: neither. Cost: about a second, CPU only.
//
// Exit codes: 0 the kit stands apart; 1 a failure (listed). Arguments are ignored.
import '../kit/help.mjs';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import PROJECT from '../project.mjs';
import { ROOT } from '../kit/root.mjs';

const KIT = path.join( ROOT, 'tools', 'kit' );
const CONFIG = path.join( ROOT, 'tools', 'project.mjs' );
const GROUPS = [ 'render', 'island', 'game', 'repo' ];
const PROJECT_PATH = new RegExp( `(?<![\\w./-])(?:packages|app|tools/(?:${ GROUPS.join( '|' ) }))/` );
const GLOBAL = /\b__[A-Z][A-Z0-9_]*__\b/g;
// the output folder written as a path, or as a string of its own
const OUTPUT = /\bartifacts\/|(['"`])artifacts\1/;
// the project's name
const NAME = /ponlai/i;
const PAGE_GLOBALS = Object.values( PROJECT.page ).filter( ( v ) => GLOBAL.test( v ) && ( GLOBAL.lastIndex = 0, true ) );

const files = [];
const walk = ( dir ) => {

	for ( const e of readdirSync( dir, { withFileTypes: true } ) ) {

		if ( e.name === '__pycache__' || e.name.startsWith( '.' ) ) continue;
		const f = path.join( dir, e.name );
		if ( e.isDirectory() ) walk( f );
		else if ( /\.(mjs|js|py)$/.test( e.name ) ) files.push( f );

	}

};
try {

	walk( KIT );

} catch ( error ) {

	if ( error.code !== 'ENOENT' ) throw error;

}

const failures = [];
let imports = 0;
const rel = ( f ) => path.relative( ROOT, f );

// a JavaScript file's code without its comments (strings and templates kept)
const jsCode = ( text, file ) => ts.transpileModule( text, { fileName: file, compilerOptions: { removeComments: true, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } } ).outputText;

// a Python file's code without its comments and docstrings (a string standing alone as a statement)
const pyCode = ( text ) => text
	.replace( /^(\s*)[rRbBuU]?("""|''')[\s\S]*?\2/gm, '$1' )
	.split( '\n' ).map( ( line ) => line.replace( /(^|\s)#.*$/, '$1' ) ).join( '\n' );

function names( file, code ) {

	for ( const m of new Set( code.match( GLOBAL ) ) ) failures.push( `${ rel( file ) }: names the page global ${ m } (the configuration's page names it)` );
	const line = code.split( '\n' ).find( ( l ) => PROJECT_PATH.test( l ) );
	if ( line ) failures.push( `${ rel( file ) }: names a project path in its code: ${ line.trim().slice( 0, 160 ) }` );
	const output = code.split( '\n' ).find( ( l ) => OUTPUT.test( l ) );
	if ( output ) failures.push( `${ rel( file ) }: names the output folder in its code (read it from the configuration's output): ${ output.trim().slice( 0, 160 ) }` );
	const name = code.split( '\n' ).find( ( l ) => NAME.test( l ) );
	if ( name ) failures.push( `${ rel( file ) }: names the project in its code (read it from the configuration: name, machine, machine.envPrefix): ${ name.trim().slice( 0, 160 ) }` );

}

for ( const file of files ) {

	const text = readFileSync( file, 'utf8' );
	if ( file.endsWith( '.py' ) ) {

		const code = pyCode( text );
		for ( const m of code.matchAll( /sys\.path\.(?:insert|append)\(([^\n]*)\)/g ) ) {

			imports ++;
			if ( ! /Path\(\s*__file__\s*\)\.resolve\(\)\.parent\s*\)?\s*\)?$/.test( m[ 1 ].trim().replace( /\s+/g, ' ' ) ) && ! /dirname\(\s*os\.path\.abspath\(\s*__file__\s*\)\s*\)/.test( m[ 1 ] ) ) failures.push( `${ rel( file ) }: puts another folder on sys.path: ${ m[ 0 ] }` );

		}
		names( file, code );
		continue;

	}
	const specs = ts.preProcessFile( text, true, true ).importedFiles.map( ( f ) => f.fileName );
	const code = jsCode( text, file );
	for ( const m of code.matchAll( /new URL\(\s*(['"`])([^'"`]+)\1\s*,\s*import\.meta\.url/g ) ) specs.push( m[ 2 ] );
	for ( const spec of specs ) {

		imports ++;
		if ( ! spec.startsWith( '.' ) ) continue;
		const target = path.resolve( path.dirname( file ), spec );
		if ( target !== CONFIG && ! ( target + path.sep ).startsWith( KIT + path.sep ) ) failures.push( `${ rel( file ) }: imports ${ spec } (${ rel( target ) }), outside the kit` );

	}
	names( file, code );

}

// The example (examples/rock/) carries a configuration of its own beside its link to the kit, so it
// must name the fields this one names: a field a kit tool starts reading is added to both. A field
// set to null there (a table, the scene options, the tracer) stands for its whole object.
const EXAMPLE = path.join( ROOT, 'examples/rock/tools/project.mjs' );
const { default: example } = await import( EXAMPLE );
const sameFields = ( ours, theirs, at ) => {

	for ( const key of Object.keys( ours ) ) {

		if ( ! ( key in theirs ) ) failures.push( `${ rel( EXAMPLE ) }: lacks ${ at }${ key }, which tools/project.mjs sets` );
		else if ( ours[ key ] && typeof ours[ key ] === 'object' && ! Array.isArray( ours[ key ] ) && theirs[ key ] !== null ) sameFields( ours[ key ], theirs[ key ] ?? {}, `${ at }${ key }.` );

	}
	for ( const key of Object.keys( theirs ) ) if ( ! ( key in ours ) ) failures.push( `${ rel( EXAMPLE ) }: sets ${ at }${ key }, which tools/project.mjs does not` );

};
sameFields( PROJECT, example, '' );

console.log( `verify-kit: ${ files.length } files under tools/kit/, ${ imports } imports, ${ PAGE_GLOBALS.length } page globals in the configuration, and the example's configuration` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
