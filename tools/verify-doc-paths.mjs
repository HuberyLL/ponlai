// Checks that every path to one of our docs written in a tracked file names a file that exists.
// lychee checks the links of the Markdown files; this covers what it cannot see, the paths written
// in code comments and in prose (`docs/reference/tools.md`, Assets), so a doc that moves takes every
// mention with it.
//
// A path counts when it starts with `docs/` and ends in `.md`. CREDITS.md and the licence files
// name docs of other projects (an SDK's licence page) and are skipped.
//
// Two more checks keep the index and the map honest:
// - In AGENTS.md and docs/reference/code-map.md, every file named in backticks (a name ending in a
//   code or data extension, written whole or as the end of its path, as the map writes a file under
//   its section's folder) names a tracked file, so a file that moves or goes takes its line along.
// - AGENTS.md stays within AGENTS_LIMIT characters: it is the index every change reads, and
//   detail belongs where it is owned (AGENTS.md says where).
//   node tools/verify-doc-paths.mjs     exit 0 when every path exists and AGENTS.md fits, 1 with the list
// Runs as part of `npm run lint:docs`. Pure git, no GPU.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

const AGENTS_LIMIT = 20000;
const NAMED = [ 'AGENTS.md', 'docs/reference/code-map.md' ];
const FILE = /`([\w./-]+\.(?:ts|mjs|js|json|html|py|css|txt))`/g;

const SKIP = /(^CREDITS\.md$|LICENSE|LICENCE|package-lock\.json$)/;
const PATH = /\bdocs\/[\w./-]+?\.md\b/g;

const top = execFileSync( 'git', [ 'rev-parse', '--show-toplevel' ], { encoding: 'utf8' } ).trim();
const out = execFileSync( 'git', [ 'grep', '-n', '-I', '-E', 'docs/[A-Za-z0-9_./-]+\\.md' ], { cwd: top, encoding: 'utf8', maxBuffer: 1 << 28 } );

const missing = [];
for ( const line of out.split( '\n' ).filter( Boolean ) ) {

	const [ file, number, ...rest ] = line.split( ':' );
	if ( SKIP.test( file ) ) continue;
	for ( const path of rest.join( ':' ).match( PATH ) ?? [] ) {

		if ( ! existsSync( `${ top }/${ path }` ) ) missing.push( `${ file }:${ number }: ${ path }` );

	}

}

const tracked = execFileSync( 'git', [ 'ls-files' ], { cwd: top, encoding: 'utf8', maxBuffer: 1 << 28 } ).split( '\n' ).filter( Boolean );
for ( const doc of NAMED ) {

	const lines = readFileSync( `${ top }/${ doc }`, 'utf8' ).split( '\n' );
	lines.forEach( ( text, i ) => {

		for ( const [ , name ] of text.matchAll( FILE ) ) {

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

	console.log( `${ missing.length } path(s) to a missing doc or file:\n${ missing.join( '\n' ) }` );
	process.exit( 1 );

}

if ( ! process.exitCode ) console.log( `every docs/ path and every file in the map names a file; AGENTS.md has ${ agentsLength } characters` );
