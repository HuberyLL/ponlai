// Checks that no source file grows past LIMIT lines. CPU only, no GPU, well under a second.
//   node tools/verify-file-size.mjs
//
// A file past the limit holds several things that change for different reasons, and no reader,
// human or model, can hold one whole. A file that passes it is split by what its parts are (a
// table of the look, the kernels of one effect, the passes of one stage), never by halving. Lines
// are counted over the whole file, its header comment included.
//
// Guarantees, each a failure (exit 1) when broken:
// - No code file under src/ (.ts, .mts, .js, .mjs) has more than LIMIT lines, except those in
//   KNOWN, the files over it when the check was written.
// - KNOWN only shrinks: a listed file may not grow past the count recorded for it (a change that
//   shortens one lowers its count with it), and one that is back within the limit, or gone, fails
//   until its entry is removed.
//
// Output: a summary on stdout, the listed files with their counts and the failures. It takes no
// options. Exit 0 when everything passes, 1 with the failures listed.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const SRC = path.join( ROOT, 'src' );
const LIMIT = 1500;
const CODE = /\.(ts|mts|js|mjs)$/;

// The files over LIMIT (paths under src/) and the most lines each may have. Lower a count, or
// remove the entry, with the change that shortens the file; never raise one or add an entry.
const KNOWN = {
	'sky/Clouds.ts': 3105,
	'sky/Sky.ts': 3031,
	'main.ts': 2691,
	'post/Pipeline.ts': 2515,
	'weather/VolumetricHaze.ts': 1809,
	'world/Grass.ts': 1746,
	'ocean/Water.ts': 1645,
	'post/graph/FrameGraph.ts': 1525,
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
const files = walk( SRC ).sort();
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

console.log( `verify-file-size: ${ files.length } files under src/, limit ${ LIMIT } lines, ${ Object.keys( KNOWN ).length } listed over it` );
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
