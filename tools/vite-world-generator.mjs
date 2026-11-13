// Vite plugin: `virtual:world-generator` exports WORLD_GENERATOR_HASH, a hash of every source file
// the chunk worker imports (packages/island/world/chunkWorker.ts: the chunks, the land and what the merge
// shares with them), so a cached chunk (packages/island/world/WorldCache.ts) is used only while the generator
// would build the same one. The files are found by following the worker's relative
// imports. A package file the generator imports is hashed by its contents when it is listed in
// PACKAGE_FILES (a single file of its own, importing nothing: three's copy of meshoptimizer's
// simplifier, IslandSimplify.ts); any other bare import fails the build (hash that package's
// version too), so a new dependency cannot slip past the hash.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const WORKER = 'packages/island/world/chunkWorker.ts';
const MODULE = 'virtual:world-generator';
const RESOLVED = '\0' + MODULE;
// package files hashed by their contents, under node_modules/
const PACKAGE_FILES = new Set( [ 'three/examples/jsm/libs/meshopt_simplifier.module.js' ] );

/** The worker's source files, absolute and sorted. */
export function worldGeneratorSources( root ) {

	const seen = new Set();
	const visit = ( file ) => {

		if ( seen.has( file ) ) return;
		seen.add( file );
		const text = readFileSync( file, 'utf8' );
		for ( const m of text.matchAll( /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*\(?\s*['"]([^'"]+)['"]/g ) ) {

			const spec = m[ 1 ] ?? m[ 2 ];
			if ( PACKAGE_FILES.has( spec ) ) { seen.add( path.resolve( root, 'node_modules', spec ) ); continue; }
			if ( ! spec.startsWith( '.' ) ) throw new Error( `${ MODULE }: ${ path.relative( root, file ) } imports '${ spec }'; hash that package's version too` );
			visit( path.resolve( path.dirname( file ), spec ) );

		}

	};
	visit( path.resolve( root, WORKER ) );
	return [ ...seen ].sort();

}

export function worldGeneratorHash() {

	let root = process.cwd();
	return {
		name: 'ponlai-world-generator-hash',
		configResolved( config ) { root = config.root; },
		resolveId( id ) { return id === MODULE ? RESOLVED : null; },
		load( id ) {

			if ( id !== RESOLVED ) return null;
			const hash = createHash( 'sha256' );
			for ( const file of worldGeneratorSources( root ) ) {

				// the dev server reloads this module when any of them changes
				this.addWatchFile( file );
				hash.update( path.relative( root, file ) ).update( '\0' ).update( readFileSync( file ) ).update( '\0' );

			}
			return `export const WORLD_GENERATOR_HASH = ${ JSON.stringify( hash.digest( 'hex' ).slice( 0, 32 ) ) };\n`;

		},
	};

}
