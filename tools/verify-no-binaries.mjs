// Checks that git holds no asset and no binary file.
//
// Assets (textures, models, fonts, audio, baked data) live in the git-ignored public/ and ship as
// GitHub releases (tools/repo/assets.mjs): a repository that kept every version of every binary
// would only grow, and cutting it back means rewriting its history. .gitignore already refuses the
// asset types to `git add`; this check also catches a forced add, a type the list lacks and a large
// file of any kind. It is part of `npm run check` (every file in the index), and the pre-commit
// hook runs it with `--staged`.
//
// Usage:
//   node tools/verify-no-binaries.mjs [--staged | --history]
//
// Options:
//   (none)      every file in the index
//   --staged    the files a commit would add or change
//   --history   every path in every commit of every ref, by its extension and git's binary flag,
//               and every blob over MAX_BYTES (to check a rewritten history)
//
// A file fails when its extension is an asset type (ASSET, the same list as .gitignore's), when git
// reads it as binary (a NUL byte in its first 8000 bytes), or when it is larger than MAX_BYTES
// (1 MiB). A submodule is not a file and is skipped; a symbolic link holds a path, not the bytes of
// the file it names, so its extension does not count (the blank project's public/,
// templates/blank/public/, links to files of the git-ignored public/).
//
// Output: on success one line on stdout with the count of files (or, with --history, objects)
// checked; on failure the list on stderr, each path with why it fails.
//
// GPU lock and browser: neither; it runs git only.
//
// Cost: under a second for the index; --history reads every object and takes longer.
//
// Exit codes: 0 nothing fails; 1 a file fails (listed) or a bad argument.
import './kit/help.mjs';
import { execFileSync } from 'node:child_process';

const ASSET = /\.(png|jpe?g|webp|avif|gif|ktx2|basis|dds|exr|hdr|tga|psd|kra|gltf|glb|fbx|obj|blend1?|bin|woff2?|ttf|otf|mp3|ogg|wav|flac|m4a|mp4|webm|zip|gz|7z)$/i;
// above the largest source file with room to spare: a file this large is data, not code
const MAX_BYTES = 1 << 20;

const git = ( args, input ) => execFileSync( 'git', args, { encoding: 'utf8', maxBuffer: 1 << 30, input } );
const lines = ( text ) => text.split( '\n' ).filter( Boolean );
// how many files (index entries, or paths over history) were looked at, for the summary
let checked = 0;

/** Index entries (all, or only `paths`): why each one fails, if it does. */
function checkIndex( paths ) {

	const entries = new Map();
	for ( const record of git( [ 'ls-files', '-s', '-z', ...( paths ? [ '--', ...paths ] : [] ) ] ).split( '\0' ).filter( Boolean ) ) {

		const [ meta, path ] = record.split( '\t' );
		const [ mode, sha ] = meta.split( ' ' );
		if ( mode !== '160000' ) entries.set( path, { sha, link: mode === '120000', why: [] } ); // a submodule is no file

	}

	checked = entries.size;
	if ( entries.size === 0 ) return [];
	const list = [ ...entries.keys() ];
	for ( const record of git( [ 'ls-files', '--eol', '-z', '--', ...list ] ).split( '\0' ).filter( Boolean ) ) {

		const [ meta, path ] = record.split( '\t' );
		if ( meta.startsWith( 'i/-text' ) && entries.has( path ) ) entries.get( path ).why.push( 'binary' );

	}

	const sizes = lines( git( [ 'cat-file', '--batch-check=%(objectsize)' ], list.map( ( p ) => entries.get( p ).sha ).join( '\n' ) + '\n' ) );
	list.forEach( ( path, i ) => {

		const entry = entries.get( path );
		if ( ASSET.test( path ) && ! entry.link ) entry.why.unshift( 'asset type' );
		if ( Number( sizes[ i ] ) > MAX_BYTES ) entry.why.push( `${ ( Number( sizes[ i ] ) / 1048576 ).toFixed( 1 ) } MiB` );

	} );
	return list.filter( ( p ) => entries.get( p ).why.length > 0 ).map( ( p ) => `${ p }  (${ entries.get( p ).why.join( ', ' ) })` );

}

function checkHistory() {

	const found = new Map();
	const add = ( path, why ) => {

		if ( ! found.has( path ) ) found.set( path, new Set() );
		found.get( path ).add( why );

	};
	// --raw gives each change's new mode (`:<old> <new> ...`), --numstat whether git read it as binary
	const links = new Set();
	const changes = lines( git( [ 'log', '--all', '--no-renames', '--raw', '--numstat', '--format=' ] ) );
	for ( const line of changes ) {

		const [ meta, path ] = line.split( '\t' );
		if ( meta.startsWith( ':' ) && meta.split( ' ' )[ 1 ] === '120000' ) links.add( path );

	}

	for ( const line of changes ) {

		if ( line.startsWith( ':' ) ) continue;
		const [ added, , path ] = line.split( '\t' );
		if ( added === '-' ) add( path, 'binary' );
		if ( ASSET.test( path ) && ! links.has( path ) ) add( path, 'asset type' );

	}

	const objects = lines( git( [ 'rev-list', '--objects', '--all' ] ) ).join( '\n' ) + '\n';
	checked = objects.split( '\n' ).length - 1;
	for ( const line of lines( git( [ 'cat-file', '--batch-check=%(objecttype) %(objectsize) %(rest)' ], objects ) ) ) {

		const [ type, size, ...rest ] = line.split( ' ' );
		if ( type === 'blob' && Number( size ) > MAX_BYTES ) add( rest.join( ' ' ), `${ ( Number( size ) / 1048576 ).toFixed( 1 ) } MiB` );

	}

	return [ ...found ].sort( ( a, b ) => a[ 0 ].localeCompare( b[ 0 ] ) ).map( ( [ path, why ] ) => `${ path }  (${ [ ...why ].join( ', ' ) })` );

}

const args = process.argv.slice( 2 );
const mode = args[ 0 ] ?? '';
if ( args.length > 1 || ! [ '', '--staged', '--history' ].includes( mode ) ) {

	console.error( 'usage: node tools/verify-no-binaries.mjs [--staged | --history]' );
	process.exit( 1 );

}

let failed;
if ( mode === '--history' ) failed = checkHistory();
else if ( mode === '--staged' ) {

	const staged = git( [ 'diff', '--cached', '--name-only', '--no-renames', '--diff-filter=AM', '-z' ] ).split( '\0' ).filter( Boolean );
	failed = staged.length > 0 ? checkIndex( staged ) : [];

} else failed = checkIndex( null );

if ( failed.length > 0 ) {

	console.error( `${ mode === '--history' ? 'history holds' : 'git holds' } ${ failed.length } asset or binary file(s); assets go in public/ and ship as a release (tools/repo/assets.mjs, its header):` );
	for ( const line of failed ) console.error( `  ${ line }` );
	process.exit( 1 );

}

console.log( `${ mode === '--history' ? 'history holds no asset or binary file' : 'no asset or binary file in git' } (${ checked } ${ mode === '--history' ? 'objects' : 'files' } checked)` );
