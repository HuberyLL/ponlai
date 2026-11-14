// Checks that every path to one of our docs, skills or tools written in a tracked text file exists.
//
// lychee checks the links of the Markdown files; this covers what it cannot see, the paths written
// in code comments and strings, configuration and prose, so a doc or a tool that moves takes every
// mention with it. Run it after moving or renaming a doc, a skill or a tool; it runs as part of
// `npm run lint:docs`.
//
// Usage:
//   node tools/repo/verify-doc-paths.mjs
//
// Options: none.
//
// A path counts when it is written in full from the repository's root and starts with one of the
// folders docs, skills or tools and a slash, as a word of its own (not after a letter, a dot, a
// slash, `@` or `-`, so a URL, an absolute path or a folder under `~/.claude` is not one). It ends
// at the first character that no path holds; a trailing dot or colon is the sentence's, not the
// path's. A path that ends in `/` names a folder. A glob (`tools/**/*.md`) counts up to its first
// `*`, and a template (`tools/${ name }`, `tools/<name>`) up to its first `$` or `<`, which must
// exist as a folder. A path written relative to another file (`../docs/x.md`, `./probe.mjs`) is not
// checked here: imports fail on their own, and lychee checks the Markdown links. The licence files
// name docs of other projects and are skipped. ABSENT lists the paths written on purpose
// for a folder that has no file yet, each with its reason and the files allowed to name it.
//
// One more check keeps the rules files and the architecture page honest: in every tracked
// AGENTS.md (the root's and each folder's) and in ARCHITECTURE.md, every file named in backticks (a
// name ending in a code or data extension, written whole or as the end of its path) names a tracked
// file, so a file that moves or goes takes its line along.
//
// The docs' commands (package.json):
// - `npm run lint:docs` checks the Markdown files' format with markdownlint-cli2 (a dev
//   dependency; its rules in .markdownlint-cli2.jsonc: prose wrapped at 100 columns, fenced code
//   with a language), then runs this tool and tools/repo/verify-doc-shape.mjs (the rules files'
//   budget and imports, the long pages' contents), then checks the links offline with lychee (local
//   files and `#anchors`; its config in lychee.toml). `npm run check` runs it when a Markdown file is
//   staged, and `npm run check -- --full` always.
// - `npm run lint:links` checks the web links too; sites that refuse automated clients (403, 405,
//   429) count as present.
// lychee is a separate binary: `brew install lychee`, or `cargo install lychee`.
//
// Output: on success one line with the counts of paths, files and named files checked; on failure
// the count, then a line per missing path (`file:line: path`). Both on stdout.
//
// GPU lock and browser: neither; it runs git and reads files.
//
// Cost: about a second.
//
// Exit codes: 0 every path exists; 1 a path is missing (listed). Arguments are ignored.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const FILE = /`([\w./-]+\.(?:ts|mjs|js|json|html|py|css|txt))`/g;

const SKIP = /(LICENSE|LICENCE|package-lock\.json$)/;
const ABSENT = new Map( [] );
const PATH = /(?<![\w./@-])(?:docs|skills|tools)\/[\w./*$<{-]*/g;

const top = execFileSync( 'git', [ 'rev-parse', '--show-toplevel' ], { encoding: 'utf8' } ).trim();
const out = execFileSync( 'git', [ 'grep', '-n', '-I', '-E', '(docs|skills|tools)/' ], { cwd: top, encoding: 'utf8', maxBuffer: 1 << 28 } );

// the part of a written path that must exist, and whether it must be a folder
function target( written ) {

	const cut = written.search( /[*$<{]/ );
	if ( cut >= 0 ) return { path: written.slice( 0, written.lastIndexOf( '/', cut ) + 1 ), folder: true };
	const path = written.replace( /[.:]+$/, '' );
	return { path, folder: path.endsWith( '/' ) };

}

const exists = ( { path, folder } ) => {

	if ( ! existsSync( `${ top }/${ path }` ) ) return false;
	return ! folder || statSync( `${ top }/${ path }` ).isDirectory();

};

const missing = [];
const files = new Set();
let paths = 0;
for ( const line of out.split( '\n' ).filter( Boolean ) ) {

	const [ file, number, ...rest ] = line.split( ':' );
	if ( SKIP.test( file ) ) continue;
	for ( const written of rest.join( ':' ).match( PATH ) ?? [] ) {

		paths ++;
		files.add( file );
		if ( ABSENT.get( target( written ).path )?.includes( file ) ) continue;
		if ( ! exists( target( written ) ) ) missing.push( `${ file }:${ number }: ${ written }` );

	}

}

const tracked = execFileSync( 'git', [ 'ls-files' ], { cwd: top, encoding: 'utf8', maxBuffer: 1 << 28 } ).split( '\n' ).filter( Boolean );
const NAMED = tracked.filter( ( f ) => f === 'ARCHITECTURE.md' || f === 'AGENTS.md' || f.endsWith( '/AGENTS.md' ) );
let named = 0;
for ( const doc of NAMED ) {

	const lines = readFileSync( `${ top }/${ doc }`, 'utf8' ).split( '\n' );
	lines.forEach( ( text, i ) => {

		for ( const [ , name ] of text.matchAll( FILE ) ) {

			named ++;
			if ( ! tracked.some( ( f ) => f === name || f.endsWith( `/${ name }` ) ) ) missing.push( `${ doc }:${ i + 1 }: ${ name }` );

		}

	} );

}

if ( missing.length ) {

	console.log( `${ missing.length } path(s) to a missing doc, skill, tool or file:\n${ missing.join( '\n' ) }` );
	process.exit( 1 );

}

console.log( `every path into docs, skills and tools (${ paths } in ${ files.size } files) and every file named in the rules files and ARCHITECTURE.md (${ named }) names a file` );
