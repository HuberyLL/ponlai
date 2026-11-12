// Checks that every path to one of our docs written in a tracked file names a file that exists.
// lychee checks the links of the Markdown files; this covers what it cannot see, the paths written
// in code comments and in prose (`docs/reference/tools.md`, Assets), so a doc that moves takes every
// mention with it.
//
// A path counts when it starts with `docs/` and ends in `.md`. CREDITS.md and the licence files
// name docs of other projects (an SDK's `docs/license.md`) and are skipped.
//   node tools/verify-doc-paths.mjs     exit 0 when every path exists, 1 with the list
// Runs as part of `npm run lint:docs`. Pure git, no GPU.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

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

if ( missing.length ) {

	console.log( `${ missing.length } path(s) to a missing doc:\n${ missing.join( '\n' ) }` );
	process.exit( 1 );

}

console.log( 'every docs/ path names a file' );
