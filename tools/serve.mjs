// Starts the dev or preview server of the checkout the cwd is in, on a free port, through job.mjs.
// Agents used to pick a port by hand, look it up with lsof and start vite themselves; in T37 a
// worktree's server failed on a port another worktree's server already held. This picks a free
// port (or names who holds the one asked for), starts vite detached with its log under
// artifacts/jobs/, waits until it answers and prints the URL and how to stop it.
//
//   node tools/serve.mjs dev|preview [--port N] [--no-build] [--sha <rev>]
//   node tools/serve.mjs clean
//
// Ports: 6400-6499 by default, the first free one. `--port N` uses N or fails naming the process
// that listens on it (pid, cwd). `preview` runs `npm run build` first unless given `--no-build`.
// Prints `<url>  log <path>  (stop: node tools/job.mjs stop <path>)`.
// The served checkout is the one containing the cwd, not the one holding this file: agents call
// the tool by the main checkout's absolute path from their worktrees, and it used to serve (and
// rebuild) main's dist silently. A cwd outside this repository exits 1. The first line printed
// names the served checkout: its path, HEAD (short sha) and branch.
// Exit codes: 0 serving; 1 bad usage, a cwd outside the repository, port taken, no free port or the server did not answer within
// 60 s (the log's tail is printed); a failed build or npm ci exits with its code.
//
// `--sha <rev>` serves another commit instead of this checkout. Agents comparing against an older
// build used to make a worktree and link node_modules by hand for each run. The commit gets a
// detached worktree at the main checkout's .claude/worktrees/sha-<12 hex> (never a branch, so
// nothing is left to delete), reused by every later call for the same commit. When the commit's
// package-lock.json equals the main checkout's, its node_modules is a real folder holding a link to
// each of the main checkout's entries except vite's caches (.vite, .vite-temp, .cache): a link to
// the whole folder would put the worktree's prebundled dependencies into the main checkout's
// cache, which its own dev server uses. With another lockfile it runs `npm ci` there instead. The
// islanders' assets link themselves (tools/vite-assets.mjs, in commits that have it). `preview`
// builds once per worktree: a successful build writes the sha into dist/.serve-sha, and a call that
// finds it skips the build. The vite job runs in the worktree, with its log in the calling checkout's
// artifacts/jobs/ (serve-<mode>-sha-<12 hex>-<port>.log), so `clean` cannot delete it.
// `clean` stops the jobs running in each sha-* worktree (job.mjs stop --cwd), removes the
// worktrees (git worktree remove --force: node_modules and dist are untracked; the links are
// removed, not followed) and runs git worktree prune.

import './qos.mjs';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The tool's own files (job.mjs); the checkout it serves is `caller`, below.
const here = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const jobTool = join( here, 'tools', 'job.mjs' );
const usage = 'usage: node tools/serve.mjs dev|preview [--port N] [--no-build] [--sha <rev>] | clean';

function fail( msg ) {

	console.error( msg );
	process.exit( 1 );

}

const args = process.argv.slice( 2 );
let mode = null, port = null, build = true, rev = null;
for ( let i = 0; i < args.length; i ++ ) {

	const a = args[ i ];
	if ( a === 'dev' || a === 'preview' || a === 'clean' ) {

		if ( mode ) fail( usage );
		mode = a;

	} else if ( a === '--port' ) {

		port = Number( args[ ++ i ] );
		if ( ! Number.isInteger( port ) || port < 1 || port > 65535 ) fail( `bad --port\n${ usage }` );

	} else if ( a === '--sha' ) {

		rev = args[ ++ i ];
		if ( ! rev ) fail( `--sha needs a revision\n${ usage }` );

	} else if ( a === '--no-build' ) build = false;
	else fail( `unknown option ${ a }\n${ usage }` );

}

if ( ! mode ) fail( usage );
if ( mode === 'clean' && ( args.length > 1 ) ) fail( `clean takes no options\n${ usage }` );

function git( a, cwd ) {

	return execFileSync( 'git', a, { cwd, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] } ).trim();

}

const commonDir = ( cwd ) => git( [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], cwd );

// The checkout the cwd is in: it is served, built and logged into. It must be a checkout of this
// repository (the same common git directory as the tool's own), or the tool would serve a stranger.
let caller;
try {

	caller = git( [ 'rev-parse', '--show-toplevel' ], process.cwd() );
	if ( commonDir( caller ) !== commonDir( here ) ) caller = null;

} catch {

	caller = null;

}

if ( ! caller ) fail( `${ process.cwd() } is not in a checkout of ${ dirname( commonDir( here ) ) }; run serve.mjs from one` );

// The main checkout: sha-* worktrees live there whichever worktree this script runs from.
const mainCheckout = dirname( commonDir( caller ) );
const shaRoot = join( mainCheckout, '.claude', 'worktrees' );

if ( mode === 'clean' ) {

	const trees = git( [ 'worktree', 'list', '--porcelain' ], caller ).split( '\n' )
		.filter( ( l ) => l.startsWith( 'worktree ' ) ).map( ( l ) => l.slice( 9 ) )
		.filter( ( p ) => dirname( p ) === shaRoot && /^sha-[0-9a-f]+$/.test( p.slice( shaRoot.length + 1 ) ) );
	for ( const t of trees ) {

		spawnSync( 'node', [ jobTool, 'stop', '--cwd', t ], { stdio: 'inherit' } );
		git( [ 'worktree', 'remove', '--force', t ], caller );
		console.log( `removed ${ t }` );

	}

	git( [ 'worktree', 'prune' ], caller );
	if ( trees.length === 0 ) console.log( 'no sha-* worktrees' );
	process.exit( 0 );

}

let repo = caller, tag = '';
if ( rev !== null ) {

	let sha;
	try {

		sha = git( [ 'rev-parse', '--verify', '--quiet', `${ rev }^{commit}` ], caller );

	} catch {

		fail( `--sha ${ rev }: not a commit` );

	}

	tag = sha.slice( 0, 12 );
	repo = join( shaRoot, `sha-${ tag }` );
	console.log( `serving ${ repo }  HEAD ${ sha.slice( 0, 7 ) }  (detached)` );
	if ( existsSync( repo ) ) {

		const head = git( [ 'rev-parse', 'HEAD' ], repo );
		if ( head !== sha ) fail( `${ repo } is at ${ head }, not ${ sha }; run node tools/serve.mjs clean` );
		console.log( `reusing ${ repo }` );

	} else {

		git( [ 'worktree', 'add', '--detach', repo, sha ] );
		console.log( `created ${ repo }` );

	}

	const modules = join( repo, 'node_modules' );
	if ( ! existsSync( modules ) ) {

		let lock = null;
		try {

			lock = git( [ 'show', `${ sha }:package-lock.json` ], caller );

		} catch {}
		const mainLock = join( mainCheckout, 'package-lock.json' );
		const same = lock !== null && existsSync( mainLock ) && existsSync( join( mainCheckout, 'node_modules' ) ) &&
			readFileSync( mainLock, 'utf8' ).trim() === lock;
		if ( same ) {

			mkdirSync( modules );
			const caches = new Set( [ '.vite', '.vite-temp', '.cache' ] );
			for ( const e of readdirSync( join( mainCheckout, 'node_modules' ) ) ) {

				if ( ! caches.has( e ) ) symlinkSync( join( mainCheckout, 'node_modules', e ), join( modules, e ) );

			}

			console.log( 'node_modules: linked from the main checkout (same package-lock.json)' );

		} else {

			console.log( 'node_modules: package-lock.json differs from the main checkout\'s, running npm ci' );
			const r = spawnSync( 'npm', [ 'ci' ], { cwd: repo, stdio: 'inherit' } );
			if ( r.status !== 0 ) process.exit( r.status ?? 1 );

		}

	}

} else {

	const head = git( [ 'rev-parse', '--short=7', 'HEAD' ], repo );
	const branch = git( [ 'branch', '--show-current' ], repo ) || 'detached';
	console.log( `serving ${ repo }  HEAD ${ head }  (${ branch })` );

}

const stamp = join( repo, 'dist', '.serve-sha' );
if ( mode === 'preview' && build && rev !== null && existsSync( stamp ) && readFileSync( stamp, 'utf8' ).trim() === git( [ 'rev-parse', 'HEAD' ], repo ) ) {

	console.log( `dist/ already built for ${ tag }, skipping the build` );
	build = false;

}

function isFree( p ) {

	return new Promise( ( resolve ) => {

		const s = net.createServer();
		s.once( 'error', () => resolve( false ) );
		s.listen( p, '127.0.0.1', () => s.close( () => resolve( true ) ) );

	} );

}

function holder( p ) {

	const lsof = ( a ) => {

		try {

			return execFileSync( 'lsof', a, { encoding: 'utf8' } );

		} catch ( e ) {

			return e.stdout || '';

		}

	};
	const pid = ( lsof( [ '-nP', `-iTCP:${ p }`, '-sTCP:LISTEN', '-Fpn' ] ).match( /^p(\d+)/m ) || [] )[ 1 ];
	if ( ! pid ) return 'an unknown process';
	const cwd = ( lsof( [ '-a', '-p', pid, '-d', 'cwd', '-Fn' ] ).match( /^n(.*)$/m ) || [] )[ 1 ];
	return `pid ${ pid } (cwd ${ cwd || 'unknown' })`;

}

if ( port !== null ) {

	if ( ! await isFree( port ) ) fail( `port ${ port } is taken by ${ holder( port ) }` );

} else {

	for ( let p = 6400; p <= 6499 && port === null; p ++ ) if ( await isFree( p ) ) port = p;
	if ( port === null ) fail( 'no free port in 6400-6499' );

}

if ( mode === 'preview' && build ) {

	const r = spawnSync( 'npm', [ 'run', 'build' ], { cwd: repo, stdio: 'inherit' } );
	if ( r.status !== 0 ) process.exit( r.status ?? 1 );
	if ( rev !== null ) writeFileSync( stamp, `${ git( [ 'rev-parse', 'HEAD' ], repo ) }\n` );

}

const log = join( caller, 'artifacts', 'jobs', `serve-${ mode }${ tag ? `-sha-${ tag }` : '' }-${ port }.log` );
mkdirSync( dirname( log ), { recursive: true } );
const vite = `npx vite ${ mode === 'preview' ? 'preview ' : '' }--host 127.0.0.1 --port ${ port } --strictPort`;
const started = spawnSync( 'node', [ jobTool, 'start', '--log', log, '--', vite ], { cwd: repo, stdio: [ 'ignore', 'ignore', 'inherit' ] } );
if ( started.status !== 0 ) fail( `job.mjs start failed (exit ${ started.status })` );

const url = `http://127.0.0.1:${ port }/`;
const deadline = Date.now() + 60000;
let up = false;
while ( ! up && Date.now() < deadline ) {

	try {

		await fetch( url, { signal: AbortSignal.timeout( 5000 ) } );
		up = true;

	} catch {

		await new Promise( ( r ) => setTimeout( r, 500 ) );

	}

}

if ( ! up ) {

	let tail = '';
	try {

		tail = readFileSync( log, 'utf8' ).split( '\n' ).slice( - 20 ).join( '\n' );

	} catch {}
	fail( `${ url } did not answer within 60 s; log ${ log }:\n${ tail }` );

}

console.log( `${ url }  log ${ log }  (stop: node tools/job.mjs stop ${ log })` );
