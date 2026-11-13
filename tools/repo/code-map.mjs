// Prints the code map: each source file with the first line of its header comment.
// CPU only, no GPU, well under a second. Pure git and file reads.
//   node tools/repo/code-map.mjs                       every file of the three folders
//   node tools/repo/code-map.mjs packages/render/post  only the files under the folders or paths named
//   node tools/repo/code-map.mjs --help                this text
//
// The map answers "which file does this?" one level below ARCHITECTURE.md's map of the folders. It
// is printed from the files rather than kept as a page, so it cannot fall behind the code: each
// file's header comment states its purpose in its first line, a sentence of its own
// (tools/repo/verify-headers.mjs checks that line for every file under packages/ and app/).
//
// A file is a tracked file with a code extension (CODE): TypeScript and JavaScript, Python, CSS.
// Its header is the first comment that is not a licence notice (`/*! ... */`), a directive
// (`// eslint-...`, `// @ts-...`, `/// <reference ...>`) or a script's metadata (`# /// script`).
// In TypeScript and JavaScript the header may follow the imports, the re-exports and the type
// aliases, which three.js's style puts first; any other statement ends the search, so a comment
// inside the code is never taken for a header. In Python it is the module's docstring or the first
// run of `#` comments; in CSS the first block comment.
//
// Output: a line per file, grouped under its folder, `  <name>  <first line>`, and `(no header)`
// where none was found. Exit 0, or 1 on an unknown option or a path that names no file.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { ROOT } from '../kit/root.mjs';

/** The folders the map covers, from the repository's root. */
export const MAP_ROOTS = [ 'packages', 'app', 'tools' ];
/** The extensions of the files that carry a header. */
export const CODE = /\.(ts|mts|js|mjs|py|css)$/;

// comments that are not the header: a licence notice, a directive for a tool
const NOT_HEADER = /^(\/\*!|\/\/\s*eslint-|\/\*\s*eslint-|\/\/\s*@ts-|\/\/\/\s*<reference)/;

/** The tracked files under the given folders (paths from the repository's root), sorted. */
export function sourceFiles( roots = MAP_ROOTS ) {

	const out = execFileSync( 'git', [ 'ls-files', '--', ...roots ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 } );
	return out.split( '\n' ).filter( ( f ) => CODE.test( f ) ).sort();

}

/** A comment's lines with their markers stripped (`//`, `/*`, ` * `, `*\/`, `#`). */
function commentLines( text ) {

	if ( text.startsWith( '/*' ) ) {

		return text.replace( /^\/\*+/, '' ).replace( /\*+\/$/, '' ).split( '\n' ).map( ( l ) => l.replace( /^\s*\*?\s?/, '' ).trimEnd() );

	}
	return text.split( '\n' ).map( ( l ) => l.replace( /^\s*(\/\/+|#+)\s?/, '' ).trimEnd() );

}

/** The header of a TypeScript or JavaScript file, as its lines, or null. */
function scriptHeader( text, file ) {

	const source = ts.createSourceFile( file, text, ts.ScriptTarget.Latest, false );
	const free = ( s ) => ts.isImportDeclaration( s ) || ts.isImportEqualsDeclaration( s ) || ts.isTypeAliasDeclaration( s ) || ( ts.isExportDeclaration( s ) && s.moduleSpecifier );
	for ( const node of [ ...source.statements, source.endOfFileToken ] ) {

		const ranges = ts.getLeadingCommentRanges( text, node.pos ) ?? [];
		for ( let i = 0; i < ranges.length; i ++ ) {

			const first = text.slice( ranges[ i ].pos, ranges[ i ].end );
			if ( NOT_HEADER.test( first ) ) continue;
			// a block comment, or a run of `//` lines with nothing but a line break between them
			let end = i;
			if ( ranges[ i ].kind === ts.SyntaxKind.SingleLineCommentTrivia ) {

				while ( end + 1 < ranges.length && ranges[ end + 1 ].kind === ts.SyntaxKind.SingleLineCommentTrivia && /^\r?\n[ \t]*$/.test( text.slice( ranges[ end ].end, ranges[ end + 1 ].pos ) ) ) end ++;

			}
			// below the file's first statement, a comment written on an import, a re-export or a
			// type alias (no blank line between them) is that statement's, not the file's
			const after = end + 1 < ranges.length ? ranges[ end + 1 ].pos : node.kind === ts.SyntaxKind.EndOfFileToken ? text.length : node.getStart( source );
			const attached = ! /\n[ \t]*\r?\n/.test( text.slice( ranges[ end ].end, after ) );
			if ( attached && node !== source.statements[ 0 ] && end + 1 >= ranges.length && node.kind !== ts.SyntaxKind.EndOfFileToken && free( node ) ) { i = end; continue; }
			return commentLines( text.slice( ranges[ i ].pos, ranges[ end ].end ) );

		}
		if ( node.kind !== ts.SyntaxKind.EndOfFileToken && ! free( node ) ) return null;

	}
	return null;

}

/** The header of a Python file (its docstring or first run of `#` comments), as its lines, or null. */
function pythonHeader( text ) {

	const lines = text.split( '\n' );
	let i = 0;
	const skip = () => {

		while ( i < lines.length ) {

			const l = lines[ i ].trim();
			if ( l === '' || l.startsWith( '#!' ) || /^#.*coding[:=]/.test( l ) ) i ++;
			else if ( l === '# /// script' ) { while ( i < lines.length && lines[ i ].trim() !== '# ///' ) i ++; i ++; }
			else return;

		}

	};
	skip();
	const line = lines[ i ]?.trim() ?? '';
	const quote = line.match( /^[rRuU]?("""|''')/ );
	if ( quote ) {

		const body = [];
		let rest = line.slice( quote[ 0 ].length );
		for ( ;; ) {

			const close = rest.indexOf( quote[ 1 ] );
			if ( close >= 0 ) { body.push( rest.slice( 0, close ) ); break; }
			body.push( rest );
			if ( ++ i >= lines.length ) break;
			rest = lines[ i ];

		}
		return body.map( ( l ) => l.trimEnd() );

	}
	if ( line.startsWith( '#' ) ) {

		const run = [];
		while ( i < lines.length && lines[ i ].trim().startsWith( '#' ) ) run.push( lines[ i ++ ] );
		return commentLines( run.join( '\n' ) );

	}
	return null;

}

/** The header of a CSS file (its first block comment), as its lines, or null. */
function cssHeader( text ) {

	const m = text.match( /^\s*(\/\*[\s\S]*?\*\/)/ );
	return m ? commentLines( m[ 1 ] ) : null;

}

/**
 * A file's header comment as its lines, the markers stripped and the blank lines that open it
 * dropped, or null when it has none.
 * @param {string} file a path from the repository's root
 */
export function header( file ) {

	const text = readFileSync( path.join( ROOT, file ), 'utf8' );
	const lines = file.endsWith( '.py' ) ? pythonHeader( text ) : file.endsWith( '.css' ) ? cssHeader( text ) : scriptHeader( text, file );
	if ( ! lines ) return null;
	const start = lines.findIndex( ( l ) => l.trim() !== '' );
	return start < 0 ? null : lines.slice( start );

}

function help() {

	const own = readFileSync( fileURLToPath( import.meta.url ), 'utf8' ).split( '\n' );
	console.log( own.slice( 0, own.findIndex( ( l ) => ! l.startsWith( '//' ) ) ).map( ( l ) => l.replace( /^\/\/ ?/, '' ) ).join( '\n' ) );

}

function main( args ) {

	const roots = [];
	for ( const a of args ) {

		if ( a === '--help' || a === '-h' ) { help(); return 0; }
		if ( a.startsWith( '-' ) ) { console.error( `code-map: unknown option '${ a }' (only --help and folders)` ); return 1; }
		roots.push( a.replace( /\/+$/, '' ) );

	}
	const files = sourceFiles( roots.length ? roots : MAP_ROOTS );
	if ( roots.length && files.length === 0 ) { console.error( `code-map: no source file under ${ roots.join( ', ' ) }` ); return 1; }
	// each folder's files together, before its subfolders', so a folder is printed once
	const byFolder = ( a, b ) => path.posix.dirname( a ).localeCompare( path.posix.dirname( b ), 'en' ) || a.localeCompare( b, 'en' );
	let folder = null;
	for ( const file of files.sort( byFolder ) ) {

		const dir = path.posix.dirname( file );
		if ( dir !== folder ) { console.log( `${ folder === null ? '' : '\n' }${ dir }/` ); folder = dir; }
		const lines = header( file );
		console.log( `  ${ path.posix.basename( file ) }  ${ lines ? lines[ 0 ].trim() : '(no header)' }` );

	}
	return 0;

}

if ( process.argv[ 1 ] && import.meta.url === pathToFileURL( process.argv[ 1 ] ).href ) process.exitCode = main( process.argv.slice( 2 ) );
