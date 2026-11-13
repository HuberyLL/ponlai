// Checks that the generic tools in tools/kit/ stay apart from the project: they import nothing from
// packages/, app/ or the other groups of tools (render, island, game, repo), only each other and the
// project's configuration (tools/project.mjs), and no page global is named in their code. The page's
// globals are the configuration's to name (its `page`), so a kit tool reads them from there.
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
//   take that form, the configuration's `page` lists them) appears in the code.
//   node tools/repo/verify-kit.mjs     exit 0 when the kit stands apart, 1 with the list
// Runs as part of `npm run check`. Pure node, no GPU.
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

console.log( `verify-kit: ${ files.length } files under tools/kit/, ${ imports } imports, ${ PAGE_GLOBALS.length } page globals in the configuration` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
