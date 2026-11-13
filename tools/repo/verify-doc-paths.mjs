// Checks that every path to one of our docs, skills or tools written in a tracked text file names a
// file or folder that exists. lychee checks the links of the Markdown files; this covers what it
// cannot see, the paths written in code comments and strings, configuration and prose
// (`docs/reference/tools.md`, Docs checks), so a doc or a tool that moves takes every mention with it.
//
// A path counts when it is written in full from the repository's root and starts with one of the
// folders docs, skills or tools and a slash, as a word of its own (not after a letter, a dot, a
// slash, `@` or `-`, so a URL, an absolute path or a folder under `~/.claude` is not one). It ends at the first character that no
// path holds; a trailing dot or colon is the sentence's, not the path's. A path that ends in `/`
// names a folder. A glob (`tools/**/*.md`) counts up to its first `*`, and a template
// (`tools/${ name }`, `tools/<name>`) up to its first `$` or `<`, which must exist as a folder. A
// path written relative to another file (`../docs/x.md`, `./probe.mjs`) is not checked here: imports
// fail on their own, and lychee checks the Markdown links. The licence files name docs of other
// projects and are skipped, as are the docs paths in CREDITS.md (an SDK's licence page); its
// tool paths are ours and are checked. ABSENT lists the paths written on purpose for a folder that
// has no file yet, each with its reason and the files allowed to name it.
//
// Two more checks keep the index and the map honest:
// - In AGENTS.md and docs/reference/code-map.md (each while it is tracked), every file named in
//   backticks (a name ending in a code or data extension, written whole or as the end of its path,
//   as the map writes a file under its section's folder) names a tracked file, so a file that moves
//   or goes takes its line along.
// - AGENTS.md stays within AGENTS_LIMIT characters: it is the index every change reads, and
//   detail belongs where it is owned (AGENTS.md says where).
//   node tools/repo/verify-doc-paths.mjs     exit 0 when every path exists and AGENTS.md fits, 1 with the list
// Runs as part of `npm run lint:docs`. Pure git, no GPU.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';

const AGENTS_LIMIT = 20000;
const NAMED = [ 'AGENTS.md', 'docs/reference/code-map.md' ];
const FILE = /`([\w./-]+\.(?:ts|mjs|js|json|html|py|css|txt))`/g;

const SKIP = /(LICENSE|LICENCE|package-lock\.json$)/;
const OTHERS = /^CREDITS\.md$/;
const ABSENT = new Map( [
	// Diátaxis's tutorials folder, named in AGENTS.md's list of the docs' kinds before its first page
	[ 'docs/tutorials/', [ 'AGENTS.md', 'tools/repo/verify-doc-paths.mjs' ] ],
] );
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

		if ( OTHERS.test( file ) && written.startsWith( 'docs/' ) ) continue;
		paths ++;
		files.add( file );
		if ( ABSENT.get( target( written ).path )?.includes( file ) ) continue;
		if ( ! exists( target( written ) ) ) missing.push( `${ file }:${ number }: ${ written }` );

	}

}

const tracked = execFileSync( 'git', [ 'ls-files' ], { cwd: top, encoding: 'utf8', maxBuffer: 1 << 28 } ).split( '\n' ).filter( Boolean );
let named = 0;
for ( const doc of NAMED.filter( ( d ) => tracked.includes( d ) ) ) {

	const lines = readFileSync( `${ top }/${ doc }`, 'utf8' ).split( '\n' );
	lines.forEach( ( text, i ) => {

		for ( const [ , name ] of text.matchAll( FILE ) ) {

			named ++;
			if ( ! tracked.some( ( f ) => f === name || f.endsWith( `/${ name }` ) ) ) missing.push( `${ doc }:${ i + 1 }: ${ name }` );

		}

	} );

}

// Characters, not bytes or UTF-16 units, as `wc -m` counts them.
const agentsLength = [ ...readFileSync( `${ top }/AGENTS.md`, 'utf8' ) ].length;
if ( agentsLength > AGENTS_LIMIT ) {

	console.log( `AGENTS.md has ${ agentsLength } characters, over its limit of ${ AGENTS_LIMIT }: move detail to where it is owned (AGENTS.md, Adding a rule)` );
	process.exitCode = 1;

}

if ( missing.length ) {

	console.log( `${ missing.length } path(s) to a missing doc, skill, tool or file:\n${ missing.join( '\n' ) }` );
	process.exit( 1 );

}

if ( ! process.exitCode ) console.log( `every path into docs, skills and tools (${ paths } in ${ files.size } files) and every file in the index and the map (${ named }) names a file; AGENTS.md has ${ agentsLength } characters` );
