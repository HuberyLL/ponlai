// Checks that every source file under packages/ and app/ opens its header with one sentence of purpose.
//
// A module's header comment is the reference for that module: what it does, its rules and their
// reasons. Its first line is what the code map prints for the file (tools/repo/code-map.mjs), so a
// reader looking for the file that does something finds it there without opening each one. The
// header is found as the code map finds it (code-map.mjs `header`): the first comment that is not
// a licence notice or a directive, after the imports, re-exports and type aliases at most. Run it
// after adding or renaming a module; it is part of `npm run check`. The tools' own headers are
// checked by tools/repo/verify-tool-manuals.mjs.
//
// Usage:
//   node tools/repo/verify-headers.mjs
//
// Options: none.
//
// What it checks, each a failure when broken, for every tracked TypeScript, JavaScript and CSS file
// under packages/ and app/:
// - The file has a header.
// - The header's first line is one whole sentence: it does not start with a lower-case letter
//   (a sentence starts with a capital, a name in backticks or a word in another script), it ends
//   with a full stop, and no sentence ends inside it (a full stop, a question or an exclamation
//   mark followed by a space and a capital). Whether the sentence states the file's purpose is a
//   judgement; this check sees only its form.
//
// Output: a summary on stdout with the number of files checked, then PASS, or FAIL and a line per
// failure.
//
// GPU lock and browser: neither. Cost: well under a second, CPU only.
//
// Exit codes: 0 every file passes; 1 a failure (listed) or an unknown option.
import '../kit/help.mjs';
import { header, sourceFiles } from './code-map.mjs';

const ROOTS = [ 'packages', 'app' ];
const CHECKED = /\.(ts|mts|js|mjs|css)$/;

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-headers: unknown option '${ a }'` );
	process.exit( 1 );

}

/** Why a header's first line is not one whole sentence, or null when it is. */
function sentenceFault( line ) {

	if ( /^\p{Ll}/u.test( line ) ) return 'starts with a lower-case letter';
	if ( ! line.endsWith( '.' ) ) return 'does not end with a full stop (the first sentence runs on to the next line, or is not a sentence)';
	if ( /[.?!]\)?\s+\p{Lu}/u.test( line.slice( 0, - 1 ) ) ) return 'holds more than one sentence';
	return null;

}

const files = sourceFiles( ROOTS ).filter( ( f ) => CHECKED.test( f ) );
const failures = [];
for ( const file of files ) {

	const lines = header( file );
	if ( ! lines ) { failures.push( `${ file }: no header comment` ); continue; }
	const first = lines[ 0 ].trim();
	const fault = sentenceFault( first );
	if ( fault ) failures.push( `${ file }: the header's first line ${ fault }: "${ first }"` );

}

console.log( `verify-headers: ${ files.length } files under ${ ROOTS.join( '/ and ' ) }/ checked, ${ files.length - failures.length } open with one sentence` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
