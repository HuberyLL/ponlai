// Checks that git tracks nothing under .claude/ but the public skills' links.
//
// The skills live in skills/<name>/; Claude Code loads a project's skills from .claude/skills/, so
// each public skill is a tracked symbolic link there, `.claude/skills/<name>` ->
// `../../skills/<name>`, and .gitignore lets through only the links it names (everything else under
// .claude/ is local and private). It is part of `npm run check`.
//
// Usage:
//   node tools/repo/verify-skill-links.mjs
//
// Options: none.
//
// Every path `git ls-files .claude` prints must be such a link: mode 120000 in the index, at
// `.claude/skills/<name>`, its target exactly `../../skills/<name>`, and `skills/<name>/SKILL.md`
// tracked. A file, a link elsewhere or a link to another name fails.
//
// Output: on success one line on stdout with the count of entries; on failure the entries that
// fail, on stderr.
//
// GPU lock and browser: neither; it runs git only. Cost: under a second.
//
// Exit codes: 0 every entry is such a link; 1 an entry fails (listed). Arguments are ignored.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';

const git = ( args ) => execFileSync( 'git', args, { encoding: 'utf8', maxBuffer: 1 << 26 } );
const LINK = /^\.claude\/skills\/([a-z0-9-]+)$/;

const entries = git( [ 'ls-files', '-s', '-z', '--', '.claude' ] ).split( '\0' ).filter( Boolean );
const skills = new Set( git( [ 'ls-files', '-z', '--', 'skills' ] ).split( '\0' ).filter( Boolean ) );
const failures = [];
for ( const record of entries ) {

	const [ meta, path ] = record.split( '\t' );
	const [ mode, sha ] = meta.split( ' ' );
	const name = path.match( LINK )?.[ 1 ];
	if ( ! name ) { failures.push( `${ path }: only .claude/skills/<name> links are tracked under .claude/` ); continue; }
	if ( mode !== '120000' ) { failures.push( `${ path }: not a symbolic link (mode ${ mode })` ); continue; }
	const target = git( [ 'cat-file', 'blob', sha ] );
	if ( target !== `../../skills/${ name }` ) failures.push( `${ path }: points to '${ target }', not '../../skills/${ name }'` );
	else if ( ! skills.has( `skills/${ name }/SKILL.md` ) ) failures.push( `${ path }: skills/${ name }/SKILL.md is not tracked` );

}

if ( failures.length ) {

	console.error( `verify-skill-links: ${ failures.length } of ${ entries.length } entries under .claude/ fail:` );
	for ( const f of failures ) console.error( `  ${ f }` );
	process.exit( 1 );

}

console.log( `verify-skill-links: ${ entries.length } entries under .claude/, each a link to its skill in skills/` );
