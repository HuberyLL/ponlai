// Checks the skills: their links under .claude/, their shape and the root AGENTS.md's index of them.
//
// The skills live in skills/<name>/; Claude Code loads a project's skills from .claude/skills/, so
// each public skill is a tracked symbolic link there, `.claude/skills/<name>` ->
// `../../skills/<name>`, and .gitignore lets through only the links it names (everything else under
// .claude/ is local and private). A skill is loaded by its frontmatter and read from the top, so its
// shape is checked too, with the limits of the writing-docs-and-skills skill (Writing a skill). It is
// part of `npm run check`.
//
// Usage:
//   node tools/repo/verify-skill-links.mjs
//
// Options: none.
//
// What it checks:
// - Links: every path `git ls-files .claude` prints is such a link (mode 120000 in the index, at
//   `.claude/skills/<name>`, its target exactly `../../skills/<name>`, `skills/<name>/SKILL.md`
//   tracked), and every tracked skill has its link.
// - Frontmatter: SKILL.md opens with `---` lines holding `name`, equal to the folder's name (lower
//   case, digits and hyphens, at most 64 characters), and a `description` that is not empty.
// - Body: at most 500 lines after the frontmatter.
// - Reference files: every other file of the skill is at most one folder below SKILL.md and named
//   in SKILL.md (its path from the skill's folder), and a Markdown reference file links to no other
//   reference file of the skill, so each is one step from SKILL.md.
// - Bindings: a path `docs/bindings/<x>.md` in SKILL.md names the skill's own binding and a tracked
//   file, and every tracked binding belongs to a skill.
// - Index: the `## Skills` section of the root AGENTS.md lists every tracked skill once, each line
//   `- <name>: \`skills/<name>/SKILL.md\``, and names no skill that does not exist.
//
// Output: on success one line on stdout with the counts; on failure the faults, on stderr.
//
// GPU lock and browser: neither; it runs git and reads files. Cost: under a second.
//
// Exit codes: 0 every check holds; 1 a check fails (listed). Arguments are ignored.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ROOT } from '../kit/root.mjs';

const git = ( args ) => execFileSync( 'git', args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 } );
const read = ( path ) => readFileSync( `${ ROOT }/${ path }`, 'utf8' );
const LINK = /^\.claude\/skills\/([a-z0-9-]+)$/;
const NAME = /^[a-z0-9-]{1,64}$/;
const BODY_LINES = 500;

const entries = git( [ 'ls-files', '-s', '-z', '--', '.claude' ] ).split( '\0' ).filter( Boolean );
const files = git( [ 'ls-files', '-z', '--', 'skills', 'docs/bindings' ] ).split( '\0' ).filter( Boolean );
const tracked = new Set( files );
const skills = files.filter( ( f ) => /^skills\/[^/]+\/SKILL\.md$/.test( f ) ).map( ( f ) => f.split( '/' )[ 1 ] );
const failures = [];

// links under .claude/
const linked = new Set();
for ( const record of entries ) {

	const [ meta, path ] = record.split( '\t' );
	const [ mode, sha ] = meta.split( ' ' );
	const name = path.match( LINK )?.[ 1 ];
	if ( ! name ) { failures.push( `${ path }: only .claude/skills/<name> links are tracked under .claude/` ); continue; }
	if ( mode !== '120000' ) { failures.push( `${ path }: not a symbolic link (mode ${ mode })` ); continue; }
	const target = git( [ 'cat-file', 'blob', sha ] );
	if ( target !== `../../skills/${ name }` ) failures.push( `${ path }: points to '${ target }', not '../../skills/${ name }'` );
	else if ( ! tracked.has( `skills/${ name }/SKILL.md` ) ) failures.push( `${ path }: skills/${ name }/SKILL.md is not tracked` );
	else linked.add( name );

}

// each skill's shape
const bindingsNamed = new Set();
for ( const name of skills ) {

	const file = `skills/${ name }/SKILL.md`;
	if ( ! linked.has( name ) ) failures.push( `${ file }: no link .claude/skills/${ name } -> ../../skills/${ name }` );
	const text = read( file );
	const front = text.match( /^---\n([\s\S]*?)\n---\n/ );
	if ( ! front ) { failures.push( `${ file }: no frontmatter between --- lines at the top` ); continue; }
	const field = ( key ) => front[ 1 ].match( new RegExp( `^${ key }:[ \\t]*(.*)$`, 'm' ) )?.[ 1 ].trim() ?? '';
	const own = field( 'name' );
	if ( own !== name ) failures.push( `${ file }: name '${ own }' is not the folder's name '${ name }'` );
	if ( ! NAME.test( name ) ) failures.push( `${ file }: the name is not lower case, digits and hyphens of at most 64 characters` );
	const description = field( 'description' );
	if ( ! description ) failures.push( `${ file }: no description` );
	const body = text.slice( front[ 0 ].length ).replace( /\n$/, '' ).split( '\n' ).length;
	if ( body > BODY_LINES ) failures.push( `${ file }: body of ${ body } lines (at most ${ BODY_LINES })` );

	for ( const other of files.filter( ( f ) => f.startsWith( `skills/${ name }/` ) && f !== file ) ) {

		const rel = other.slice( `skills/${ name }/`.length );
		if ( rel.split( '/' ).length > 2 ) failures.push( `${ other }: more than one folder below SKILL.md` );
		if ( ! text.includes( rel ) ) failures.push( `${ other }: not named in SKILL.md (as '${ rel }')` );
		if ( rel.endsWith( '.md' ) ) {

			for ( const [ , target ] of read( other ).matchAll( /\]\(([^)#\s]+\.md)(?:#[^)]*)?\)/g ) ) {

				if ( ! /^[a-z]+:/.test( target ) && target !== 'SKILL.md' && ! target.includes( '../' ) ) failures.push( `${ other }: links to the reference file '${ target }'; reference files link only to SKILL.md` );

			}

		}

	}

	for ( const [ binding ] of text.matchAll( /docs\/bindings\/[\w-]+\.md/g ) ) {

		bindingsNamed.add( binding );
		if ( binding !== `docs/bindings/${ name }.md` ) failures.push( `${ file }: names ${ binding }, not its own binding docs/bindings/${ name }.md` );
		else if ( ! tracked.has( binding ) ) failures.push( `${ file }: its binding ${ binding } is not tracked` );

	}

}

for ( const binding of files.filter( ( f ) => /^docs\/bindings\/[^/]+\.md$/.test( f ) ) ) {

	if ( ! bindingsNamed.has( binding ) ) failures.push( `${ binding }: no skill names this binding` );

}

// the root's index
const index = read( 'AGENTS.md' ).match( /^## Skills\n([\s\S]*?)(?=^## |(?![\s\S]))/m );
if ( ! index ) failures.push( 'AGENTS.md: no "## Skills" section' );
else {

	const listed = new Map();
	for ( const line of index[ 1 ].split( '\n' ).filter( ( l ) => l.startsWith( '- ' ) ) ) {

		const m = line.match( /^- ([a-z0-9-]+): `skills\/([a-z0-9-]+)\/SKILL\.md`$/ );
		if ( ! m || m[ 1 ] !== m[ 2 ] ) { failures.push( `AGENTS.md, Skills: '${ line }' is not "- <name>: \`skills/<name>/SKILL.md\`"` ); continue; }
		listed.set( m[ 1 ], ( listed.get( m[ 1 ] ) ?? 0 ) + 1 );
		if ( ! skills.includes( m[ 1 ] ) ) failures.push( `AGENTS.md, Skills: ${ m[ 1 ] } is not a tracked skill` );

	}

	for ( const name of skills ) {

		const n = listed.get( name ) ?? 0;
		if ( n !== 1 ) failures.push( `AGENTS.md, Skills: ${ name } is listed ${ n } times, not once` );

	}

}

if ( failures.length ) {

	console.error( `verify-skill-links: ${ failures.length } fault(s):` );
	for ( const f of failures ) console.error( `  ${ f }` );
	process.exit( 1 );

}

console.log( `verify-skill-links: ${ skills.length } skills, each linked under .claude/, in shape and in the root's index; ${ entries.length } entries under .claude/` );
