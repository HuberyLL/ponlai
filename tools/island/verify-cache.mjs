// A record of passed runs for the CPU world verifiers (verify-world-chunks, verify-world-stats,
// verify-chunk-derived), so a merge that does not touch the world's generator does not spend a
// quarter of an hour proving it again.
//
// A run's key is a hash of everything its verdict depends on: the node version, the verifier's
// arguments (`--force` left out) and the contents of every source file it loads, found by walking
// its import graph from the script itself. The walk reads the specifiers in the source text (static
// and dynamic imports and re-exports, `new URL( '...', import.meta.url )` for workers, Vite's
// `ssrLoadModule( '/packages/...' )`), resolves the relative and root ones to files in the repository and
// follows them, so a comment changed anywhere in the generator invalidates the record. Packages
// (three, vite, typescript) are covered by package-lock.json, hashed whenever the graph imports one.
// The walk is textual on purpose: it needs no loader hooks, and it sees the modules a run loads on
// paths it did not take this time (a specifier it cannot resolve, as in a comment, is left out).
//
// `check()` prints one line and exits 0 when a pass with the same key is recorded; `record()` is
// called once the verifier has passed, so a failure, an exception or an interrupted run records
// nothing. Records live in the main checkout's artifacts/verify-cache/ (git-ignored), found through
// git's common directory, so every worktree of the repository shares them: the key holds the
// contents, never a branch or a path, and a pass proven on a branch counts on its merge.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT as TOP } from '../kit/root.mjs';

// the repository's root, with its trailing separator (a file under it starts with it)
const ROOT = TOP + sep;

const SPECIFIERS = [
	/\bfrom\s*['"]([^'"\n]+)['"]/g,
	/\bimport\s*['"]([^'"\n]+)['"]/g,
	/\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g,
	/\bnew\s+URL\s*\(\s*['"]([^'"\n]+)['"]\s*,\s*import\.meta\.url/g,
	/\bssrLoadModule\s*\(\s*['"]([^'"\n]+)['"]/g,
];
const EXTENSIONS = [ '', '.ts', '.mts', '.mjs', '.js', '/index.ts', '/index.js' ];

const sha256 = ( data ) => createHash( 'sha256' ).update( data ).digest( 'hex' );

function resolveFile( from, specifier ) {

	const base = specifier.startsWith( '/' ) ? join( ROOT, specifier ) : resolve( dirname( from ), specifier );
	for ( const extension of EXTENSIONS ) {

		const path = base + extension;
		if ( existsSync( path ) && statSync( path ).isFile() ) return path;

	}
	return null;

}

// Every repository file the script loads (itself included) and whether it imports a package.
export function sourceGraph( entry ) {

	const files = new Set(), queue = [ entry ];
	let packages = false;
	while ( queue.length > 0 ) {

		const file = queue.pop();
		if ( files.has( file ) ) continue;
		files.add( file );
		const text = readFileSync( file, 'utf8' );
		for ( const pattern of SPECIFIERS ) for ( const [ , specifier ] of text.matchAll( pattern ) ) {

			if ( specifier.startsWith( '.' ) || specifier.startsWith( '/' ) ) {

				const path = resolveFile( file, specifier );
				if ( path && path.startsWith( ROOT ) ) queue.push( path );

			} else if ( ! specifier.startsWith( 'node:' ) && ! specifier.startsWith( 'virtual:' ) ) packages = true;

		}

	}
	const list = [ ...files ].map( ( path ) => relative( ROOT, path ) ).sort();
	if ( packages ) list.push( 'package-lock.json' );
	return list;

}

function git( ...args ) {

	try {

		return execFileSync( 'git', args, { cwd: ROOT, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();

	} catch {

		return null;

	}

}

// The main checkout's artifacts/ when the repository is a worktree, so all worktrees share one store.
function storeDir() {

	const common = git( 'rev-parse', '--path-format=absolute', '--git-common-dir' );
	const top = common && common.endsWith( '/.git' ) ? dirname( common ) : ROOT;
	return join( top, 'artifacts', 'verify-cache' );

}

export function verifyCache( scriptUrl ) {

	const script = fileURLToPath( scriptUrl );
	const name = relative( ROOT, script );
	const args = process.argv.slice( 2 ).filter( ( a ) => a !== '--force' );
	const files = sourceGraph( script );
	const lines = [ `node ${ process.version }`, `script ${ name }`, `args ${ JSON.stringify( args ) }` ];
	for ( const file of files ) lines.push( `${ file } ${ sha256( readFileSync( join( ROOT, file ) ) ) }` );
	const key = sha256( lines.join( '\n' ) );
	const path = join( storeDir(), `${ key }.json` );

	return {

		key, files,

		// Exits 0 when this key passed before (unless --force); otherwise returns and the run goes on.
		check() {

			if ( process.argv.includes( '--force' ) || ! existsSync( path ) ) return;
			let pass;
			try {

				pass = JSON.parse( readFileSync( path, 'utf8' ) );

			} catch {

				return;

			}
			console.log( `${ name }: skipped, these inputs passed at ${ pass.commit } on ${ pass.time } (${ files.length } files hashed, key ${ key.slice( 0, 12 ) }); --force runs it` );
			process.exit( 0 );

		},

		// Called once the run has passed: written whole, then renamed, so a reader never sees half.
		record() {

			const head = git( 'rev-parse', '--short', 'HEAD' ) ?? 'unknown';
			const dirty = git( 'status', '--porcelain', '--untracked-files=no' );
			const pass = {
				script: name, args, node: process.version, time: new Date().toISOString().replace( /\.\d+Z$/, 'Z' ),
				commit: dirty ? `${ head } (uncommitted changes)` : head, files: lines.slice( 3 ),
			};
			mkdirSync( dirname( path ), { recursive: true } );
			writeFileSync( `${ path }.${ process.pid }.tmp`, JSON.stringify( pass, null, '\t' ) + '\n' );
			renameSync( `${ path }.${ process.pid }.tmp`, path );
			console.log( `     pass recorded (key ${ key.slice( 0, 12 ) })` );

		},

	};

}
