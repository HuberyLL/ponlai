// Checks the direction of the imports between the code's layers, and that the world's chunk
// worker imports only plain code. CPU only, no GPU, a second or two.
//   node tools/verify-layers.mjs
//
// The layers, lowest first: render (light, sky, weather, sea, the frame's passes, the generic
// materials and vegetation machinery, the quality tiers), island (this island's generation and
// growth, its materials, plants, camera, characters, creatures), game (everything behind `?game`)
// and app (the page's entry, which assembles the others). A file may import its own layer and the
// layers below it, never one above: a lower layer defines an interface and the higher one fills
// it. Which layer a file belongs to is not its folder's name: some files sit in another layer's
// folder until the files move, so `tools/layers.json` maps every file under `src/` to its layer.
//
// Guarantees, each a failure (exit 1) when broken:
// - Every code file under `src/` (.ts, .mts, .js, .mjs) has a layer in `tools/layers.json`, and
//   every file named there exists: a new file is placed in a layer when it is added.
// - No import goes up a layer, except the pairs of files in KNOWN, which are printed but pass.
//   KNOWN only shrinks: a pair in it that no longer imports upward fails, so the entry is removed
//   with the change that removes the import. Imports are read with TypeScript's own pre-processor
//   (static imports, `import type`, re-exports, side-effect and dynamic imports) plus workers'
//   `new URL( '<path>', import.meta.url )`. Package imports are not layered; imports of data files
//   (JSON, CSS) are not checked.
// - The chunk worker (src/world/chunkWorker.ts) and everything it imports, followed through
//   relative imports, imports no package except the files tools/vite-world-generator.mjs hashes:
//   the same walk and the same exceptions as the build's world generator plugin, run here so the
//   check fails before a build does. (Its files are hashed into the world's cache key, and a
//   package such as three.js would not run in the worker's plain code.)
//
// Output: a summary on stdout, every upward import found (known or not) and the failures. It takes
// no options. Exit 0 when everything passes, 1 with the failures listed.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { worldGeneratorSources } from './vite-world-generator.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const SRC = path.join( ROOT, 'src' );
const TABLE = path.join( ROOT, 'tools', 'layers.json' );
const RANK = { render: 0, island: 1, game: 2, app: 3 };
const CODE = /\.(ts|mts|js|mjs)$/;

// Upward imports not yet turned round, as 'from -> to' (paths under src/). Remove an entry with
// the change that removes its import; never add one.
const KNOWN = [
	// the anti-aliasing mode reads the quality tier the page's entry chose from the URL
	'post/Antialiasing.ts -> QualityDetect.ts',
];

for ( const a of process.argv.slice( 2 ) ) {

	console.error( `verify-layers: unknown option '${ a }'` );
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

/** The file a relative specifier names (under src/, with '/'), or null for a package. */
function resolve( from, spec ) {

	if ( ! spec.startsWith( '.' ) ) return null;
	const base = path.resolve( path.dirname( path.join( SRC, from ) ), spec.replace( /\?.*$/, '' ) );
	const file = [ base, base + '.ts', path.join( base, 'index.ts' ) ].find( ( c ) => existsSync( c ) && statSync( c ).isFile() ) ?? base;
	return path.relative( SRC, file ).split( path.sep ).join( '/' );

}

/** Each relative import of a file: its target (under src/) and its specifier, as written. */
function imports( file ) {

	const text = readFileSync( path.join( SRC, file ), 'utf8' );
	const specs = ts.preProcessFile( text, true, true ).importedFiles.map( ( f ) => f.fileName );
	for ( const m of text.matchAll( /new\s+URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g ) ) specs.push( m[ 1 ] );
	const out = [];
	for ( const spec of new Set( specs ) ) {

		const to = resolve( file, spec );
		if ( to ) out.push( { to, spec } );

	}
	return out;

}

const failures = [];
const table = JSON.parse( readFileSync( TABLE, 'utf8' ) );
const files = walk( SRC ).sort();

// the table against the files
for ( const f of files ) if ( ! ( f in table ) ) failures.push( `${ f }: no layer in tools/layers.json` );
for ( const [ f, layer ] of Object.entries( table ) ) {

	if ( ! files.includes( f ) ) failures.push( `tools/layers.json names ${ f }, which does not exist` );
	if ( ! ( layer in RANK ) ) failures.push( `tools/layers.json: ${ f } has an unknown layer '${ layer }'` );

}

// the imports' direction
const upward = new Map();
let edges = 0;
for ( const from of files ) {

	for ( const { to, spec } of imports( from ) ) {

		edges ++;
		if ( ! CODE.test( to ) ) continue;
		if ( ! ( to in table ) ) {

			if ( ! files.includes( to ) ) failures.push( `${ from }: imports '${ spec }', which does not exist` );
			continue;

		}
		if ( RANK[ table[ from ] ] < RANK[ table[ to ] ] ) {

			const key = `${ from } -> ${ to }`;
			upward.set( key, `${ table[ from ] } -> ${ table[ to ] }` );

		}

	}

}
const known = new Set( KNOWN );
for ( const [ key, layers ] of upward ) if ( ! known.has( key ) ) failures.push( `upward import (${ layers }): ${ key }` );
for ( const key of KNOWN ) if ( ! upward.has( key ) ) failures.push( `KNOWN lists ${ key }, which no longer imports upward: remove the entry` );

// the chunk worker's imports
let workerFiles = 0;
try {

	workerFiles = worldGeneratorSources( ROOT ).length;

} catch ( e ) {

	failures.push( `chunk worker: ${ e.message }` );

}

console.log( `verify-layers: ${ files.length } files, ${ edges } imports, ${ upward.size } upward (${ KNOWN.length } known), chunk worker ${ workerFiles } files` );
for ( const [ key, layers ] of [ ...upward ].sort() ) console.log( `  ${ known.has( key ) ? 'known' : 'NEW  ' } ${ layers }: ${ key }` );
if ( failures.length ) {

	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
