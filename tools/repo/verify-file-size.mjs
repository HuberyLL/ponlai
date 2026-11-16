// Checks that no code file under packages/ or app/ grows past LIMIT lines (1500).
//
// A file past the limit holds several things that change for different reasons, and no reader,
// human or model, can hold one whole. A file that passes it is split by what its parts are (a
// table of the look, the kernels of one effect, the passes of one stage), never by halving. Lines
// are counted over the whole file, its header comment included. It is part of `npm run check`.
// A file at its limit that needs a lint exception writes it at the end of a line
// (tools/repo/lint/plugin.mjs).
//
// Usage:
//   node tools/repo/verify-file-size.mjs
//
// Options: none.
//
// What it checks, each a failure when broken:
// - No code file under packages/ or app/ (.ts, .mts, .js, .mjs) has more than LIMIT lines, except
//   those in KNOWN, the files over it when the check was written.
// - KNOWN only shrinks: a listed file may not grow past the count recorded for it (a change that
//   shortens one lowers its count with it), and one that is back within the limit, or gone, fails
//   until its entry is removed.
//
// Output: a summary on stdout, the listed files with their counts, then PASS or FAIL with the
// failures.
//
// GPU lock and browser: neither. Cost: well under a second, CPU only.
//
// Exit codes: 0 everything passes; 1 a failure (listed) or an unknown option.
import '../kit/help.mjs';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from '../kit/root.mjs';

const SRC = ROOT;
const LIMIT = 1500;
const CODE = /\.(ts|mts|js|mjs)$/;

// The files over LIMIT (paths from the repository's root) and the most lines each may have. Lower a count, or
// remove the entry, with the change that shortens the file; never raise one or add an entry.
const KNOWN = {
	'packages/render/weather/VolumetricHaze.ts': 1809,
	'packages/island/world/Grass.ts': 1605,
	'packages/render/post/graph/FrameGraph.ts': 1525,
};

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-file-size: unknown option '${ a }'` );
	process.exit( 1 );

}

function walk( dir, out = [] ) {

	for ( const name of readdirSync( dir ) ) {

		const p = path.join( dir, name );
		if ( statSync( p ).isDirectory() ) walk( p, out );
		else if ( CODE.test( name ) ) out.push( path.relative( SRC, p ).split( path.sep ).join( '/' ) );

	}
	return out;

}

// lines as an editor counts them (a final newline ends the last line, it does not start one)
function lines( file ) {

	const text = readFileSync( path.join( SRC, file ), 'utf8' );
	if ( text.length === 0 ) return 0;
	return text.split( '\n' ).length - ( text.endsWith( '\n' ) ? 1 : 0 );

}

const failures = [];
const files = [ 'packages', 'app' ].flatMap( ( root ) => walk( path.join( SRC, root ) ) ).sort();
const counts = new Map( files.map( ( f ) => [ f, lines( f ) ] ) );
for ( const [ file, count ] of counts ) {

	if ( count <= LIMIT ) continue;
	if ( ! ( file in KNOWN ) ) failures.push( `${ file }: ${ count } lines, over the limit of ${ LIMIT }: split it by what its parts are` );
	else if ( count > KNOWN[ file ] ) failures.push( `${ file }: ${ count } lines, grown past its listed ${ KNOWN[ file ] }: a listed file may only shrink` );

}
for ( const [ file, most ] of Object.entries( KNOWN ) ) {

	const count = counts.get( file );
	if ( count === undefined ) failures.push( `KNOWN lists ${ file }, which does not exist: remove the entry` );
	else if ( count <= LIMIT ) failures.push( `KNOWN lists ${ file } (${ most }), now ${ count } lines, within the limit: remove the entry` );

}

console.log( `verify-file-size: ${ files.length } files under packages/ and app/, limit ${ LIMIT } lines, ${ Object.keys( KNOWN ).length } listed over it` );
for ( const [ file, most ] of Object.entries( KNOWN ) ) {

	const count = counts.get( file );
	const note = count !== undefined && count < most && count > LIMIT ? ` (lower its count to ${ count })` : '';
	console.log( `  listed ${ file }: ${ count ?? 'missing' } of ${ most }${ note }` );

}
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
