// Checks the rules files' budget and imports and that each long docs page opens with its contents.
//
// The root AGENTS.md is loaded on every turn, so it has a budget in lines and characters; a line
// that would take it over moves a line out first (the writing-docs-and-skills skill, step 4). A
// folder's own AGENTS.md is read by Claude Code only through a CLAUDE.md beside it that imports it.
// A long page opens with its contents, so a reader can take one section. It runs as part of
// `npm run lint:docs`.
//
// Usage:
//   node tools/repo/verify-doc-shape.mjs
//
// Options: none.
//
// What it checks:
// - The root AGENTS.md: at most ROOT_LINES lines and ROOT_CHARS characters (counted as `wc -lm`
//   counts them).
// - Every other tracked AGENTS.md: a tracked CLAUDE.md beside it whose whole content is the line
//   `@AGENTS.md`.
// - Every tracked page under docs/ of more than LONG_PAGE lines that has `##` headings: before its
//   first `##` heading, a link `(#slug)` to each `##` heading, the slug as GitHub makes it (lower
//   case, punctuation dropped, spaces to hyphens). lychee checks that each anchor resolves.
//
// Output: on success one line on stdout with the root's size and the counts; on failure a line per
// fault, on stdout.
//
// GPU lock and browser: neither; it runs git and reads files. Cost: under a second.
//
// Exit codes: 0 every check holds; 1 a check fails (listed). Arguments are ignored.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ROOT } from '../kit/root.mjs';

// The root's budget: a little above its size when the layers' rules files were split out of it.
const ROOT_LINES = 215;
const ROOT_CHARS = 15000;
// A page longer than this opens with its contents.
const LONG_PAGE = 100;

const read = ( path ) => readFileSync( `${ ROOT }/${ path }`, 'utf8' );
const tracked = execFileSync( 'git', [ 'ls-files', '-z' ], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 28 } ).split( '\0' ).filter( Boolean );
const faults = [];

const root = read( 'AGENTS.md' );
const lines = root.split( '\n' ).length - ( root.endsWith( '\n' ) ? 1 : 0 );
const chars = [ ...root ].length;
if ( lines > ROOT_LINES ) faults.push( `AGENTS.md: ${ lines } lines, over the budget of ${ ROOT_LINES }` );
if ( chars > ROOT_CHARS ) faults.push( `AGENTS.md: ${ chars } characters, over the budget of ${ ROOT_CHARS }` );

const nested = tracked.filter( ( f ) => f.endsWith( '/AGENTS.md' ) );
for ( const file of nested ) {

	const claude = file.replace( /AGENTS\.md$/, 'CLAUDE.md' );
	if ( ! tracked.includes( claude ) ) faults.push( `${ file }: no tracked ${ claude } beside it` );
	else if ( read( claude ).trim() !== '@AGENTS.md' ) faults.push( `${ claude }: its whole content must be the line @AGENTS.md` );

}

const slug = ( heading ) => heading.trim().toLowerCase().replace( /[^\p{L}\p{N}_\- ]/gu, '' ).replace( / /g, '-' );
const pages = tracked.filter( ( f ) => f.startsWith( 'docs/' ) && f.endsWith( '.md' ) );
let long = 0;
for ( const page of pages ) {

	const text = read( page ).split( '\n' );
	if ( text.length - 1 <= LONG_PAGE ) continue;
	const headings = text.filter( ( l ) => l.startsWith( '## ' ) ).map( ( l ) => l.slice( 3 ) );
	if ( ! headings.length ) continue;
	long ++;
	const head = text.slice( 0, text.findIndex( ( l ) => l.startsWith( '## ' ) ) ).join( '\n' );
	const absent = headings.filter( ( h ) => ! head.includes( `(#${ slug( h ) })` ) );
	if ( absent.length ) faults.push( `${ page }: ${ text.length - 1 } lines; its contents before the first section lack ${ absent.map( ( h ) => `'${ h }'` ).join( ', ' ) }` );

}

if ( faults.length ) {

	console.log( `verify-doc-shape: ${ faults.length } fault(s):\n${ faults.map( ( f ) => `  ${ f }` ).join( '\n' ) }` );
	process.exit( 1 );

}

console.log( `verify-doc-shape: the root AGENTS.md is ${ lines } lines and ${ chars } characters (budget ${ ROOT_LINES }, ${ ROOT_CHARS }); ${ nested.length } folder rules files imported; ${ long } long pages with their contents` );
