// Starts this checkout's dev or preview server on a free port, through job.mjs.
// Agents used to pick a port by hand, look it up with lsof and start vite themselves; in T37 a
// worktree's server failed on a port another worktree's server already held. This picks a free
// port (or names who holds the one asked for), starts vite detached with its log under
// artifacts/jobs/, waits until it answers and prints the URL and how to stop it.
//
//   node tools/serve.mjs dev|preview [--port N] [--no-build]
//
// Ports: 6400-6499 by default, the first free one. `--port N` uses N or fails naming the process
// that listens on it (pid, cwd). `preview` runs `npm run build` first unless given `--no-build`.
// Prints `<url>  log <path>  (stop: node tools/job.mjs stop <path>)`.
// Exit codes: 0 serving; 1 bad usage, port taken, no free port or the server did not answer within
// 60 s (the log's tail is printed); a failed build exits with the build's code.

import './qos.mjs';
import net from 'node:net';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join( dirname( fileURLToPath( import.meta.url ) ), '..' );
const usage = 'usage: node tools/serve.mjs dev|preview [--port N] [--no-build]';

function fail( msg ) {

	console.error( msg );
	process.exit( 1 );

}

const args = process.argv.slice( 2 );
let mode = null, port = null, build = true;
for ( let i = 0; i < args.length; i ++ ) {

	const a = args[ i ];
	if ( a === 'dev' || a === 'preview' ) {

		if ( mode ) fail( usage );
		mode = a;

	} else if ( a === '--port' ) {

		port = Number( args[ ++ i ] );
		if ( ! Number.isInteger( port ) || port < 1 || port > 65535 ) fail( `bad --port\n${ usage }` );

	} else if ( a === '--no-build' ) build = false;
	else fail( `unknown option ${ a }\n${ usage }` );

}

if ( ! mode ) fail( usage );

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

}

const log = join( repo, 'artifacts', 'jobs', `serve-${ mode }-${ port }.log` );
mkdirSync( dirname( log ), { recursive: true } );
const vite = `npx vite ${ mode === 'preview' ? 'preview ' : '' }--host 127.0.0.1 --port ${ port } --strictPort`;
const started = spawnSync( 'node', [ join( repo, 'tools', 'job.mjs' ), 'start', '--log', log, '--', vite ], { cwd: repo, stdio: [ 'ignore', 'ignore', 'inherit' ] } );
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
