// Checks that each translated page keeps the shape of its English page, so a change to one reaches the other.
//
// A translation is a tracked `<name>.zh-CN.md` beside its English `<name>.md` (the root README and
// the blank project's README). The English page is the source: a change to it is made in the
// translation in the same commit. The prose differs by language, so the check compares what does
// not: the sections, the code, the links and the tables. It is part of `npm run check`.
//
// Usage:
//   node tools/repo/verify-translations.mjs
//
// Options: none.
//
// What it checks, for each pair:
// - The English page exists.
// - Sections: the same headings by level, in the same order (their words differ).
// - Code blocks: every fenced block equal, in order.
// - Per section, as unordered lists (a translation may reorder a sentence): the inline code spans,
//   the link and image targets, and the count of table rows. A target is compared without its
//   fragment (a heading's anchor is in its language), and a link to a page's translation counts as
//   one to the English page (`README.zh-CN.md` as `README.md`, the repository's `blob/main/README.md`
//   on GitHub as the repository's address).
//
// Output: on success one line on stdout with the pairs checked; on failure the faults, on stderr.
//
// GPU lock and browser: neither; it runs git and reads files. Cost: under a second.
//
// Exit codes: 0 every pair matches; 1 a pair differs (listed). Arguments are ignored.
import '../kit/help.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { ROOT } from '../kit/root.mjs';

const SUFFIX = '.zh-CN.md';
const REPO = 'https://github.com/HuberyLL/ponlai';

const git = ( args ) => execFileSync( 'git', args, { cwd: ROOT, encoding: 'utf8' } );
const translations = git( [ 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', `*${ SUFFIX }` ] ).split( '\0' ).filter( Boolean );
const failures = [];

function target( url ) {

	let t = url.split( '#' )[ 0 ].replace( /\.zh-CN\.md$/, '.md' );
	if ( t === `${ REPO }/blob/main/README.md` ) t = REPO;
	return t;

}

// a page as sections: the text before the first heading, then one per heading
function parse( text ) {

	const sections = [ { heading: '(top)', code: [], links: [], rows: 0 } ];
	const blocks = [];
	let fence = null;
	for ( const line of text.split( '\n' ) ) {

		const section = sections[ sections.length - 1 ];
		const open = line.match( /^\s*(```+|~~~+)/ );
		if ( fence ) {

			if ( open && open[ 1 ][ 0 ] === fence.mark[ 0 ] && open[ 1 ].length >= fence.mark.length ) {

				blocks.push( fence.lines.join( '\n' ) );
				fence = null;

			} else fence.lines.push( line );
			continue;

		}

		if ( open ) {

			fence = { mark: open[ 1 ], lines: [ line.trim() ] };
			continue;

		}

		const heading = line.match( /^(#{1,6})\s/ );
		if ( heading ) {

			sections.push( { heading: heading[ 1 ], code: [], links: [], rows: 0 } );
			continue;

		}

		if ( /^\s*\|/.test( line ) ) section.rows ++;
		for ( const m of line.matchAll( /`([^`]+)`/g ) ) section.code.push( m[ 1 ] );
		for ( const m of line.replace( /`[^`]+`/g, '' ).matchAll( /\]\(([^)\s]+)\)|<(https?:[^>\s]+)>/g ) ) section.links.push( target( m[ 1 ] ?? m[ 2 ] ) );

	}

	return { sections, blocks };

}

const sorted = ( list ) => JSON.stringify( [ ...list ].sort() );

for ( const zh of translations ) {

	const en = zh.slice( 0, - SUFFIX.length ) + '.md';
	if ( ! existsSync( `${ ROOT }/${ en }` ) ) {

		failures.push( `${ zh }: no English page ${ en }` );
		continue;

	}

	const a = parse( readFileSync( `${ ROOT }/${ en }`, 'utf8' ) );
	const b = parse( readFileSync( `${ ROOT }/${ zh }`, 'utf8' ) );
	const levels = ( p ) => p.sections.map( ( s ) => s.heading ).join( ' ' );
	if ( levels( a ) !== levels( b ) ) {

		failures.push( `${ zh }: its headings differ from ${ en }'s by level or count\n    ${ en }: ${ levels( a ) }\n    ${ zh }: ${ levels( b ) }` );
		continue;

	}

	const blocks = Math.max( a.blocks.length, b.blocks.length );
	for ( let i = 0; i < blocks; i ++ ) {

		if ( a.blocks[ i ] !== b.blocks[ i ] ) failures.push( `${ zh }: code block ${ i + 1 } differs from ${ en }'s\n${ a.blocks[ i ] ?? '(none)' }\n  ---\n${ b.blocks[ i ] ?? '(none)' }` );

	}

	a.sections.forEach( ( s, i ) => {

		const t = b.sections[ i ];
		const where = `${ zh }: section ${ i } (${ s.heading })`;
		if ( sorted( s.code ) !== sorted( t.code ) ) failures.push( `${ where }: inline code differs\n    ${ en }: ${ sorted( s.code ) }\n    ${ zh }: ${ sorted( t.code ) }` );
		if ( sorted( s.links ) !== sorted( t.links ) ) failures.push( `${ where }: link targets differ\n    ${ en }: ${ sorted( s.links ) }\n    ${ zh }: ${ sorted( t.links ) }` );
		if ( s.rows !== t.rows ) failures.push( `${ where }: ${ t.rows } table rows, ${ en } has ${ s.rows }` );

	} );

}

if ( failures.length ) {

	console.error( `verify-translations: ${ failures.length } fault(s)\n` + failures.map( ( f ) => `  ${ f }` ).join( '\n' ) );
	process.exit( 1 );

}

console.log( `verify-translations: ${ translations.length } translated page(s) match their English pages` );
