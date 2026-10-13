// Runs a long command with its output in a log file, and waits on such jobs for a bounded time.
// Agents used to poll long runs with until/sleep loops of their own: thousands of waits and
// status calls, and some conditions never came true (one waited a day for an `^exit` line that
// its log never got). Every job started here writes the same start and end lines, and `wait`
// knows when a job has ended even if it was killed before it could say so.
//
//   node tools/job.mjs run --log <file> -- <command ...>     runs it in the foreground
//   node tools/job.mjs start --log <file> -- <command ...>   runs it detached and returns at once
//   node tools/job.mjs wait <file>... [--max 240] [--lines 5]
//   node tools/job.mjs status <file>... [--lines 5]           (wait --max 0)
//
// A single argument after `--` runs through `sh -c` (pipes, redirections, `&&`); several are run
// as they are. The log starts with `[job] start <time> pid <runner pid>: <command>`, then holds
// the command's stdout and stderr, and ends with `[done] exit <code> at <time> after <duration>`
// (a command killed by a signal exits 128 + its number, one that cannot start 127). The runner
// forwards SIGINT, SIGTERM and SIGHUP to the command and still writes the end line. `start`
// detaches the runner from the calling shell (it survives the shell's exit) and returns once the
// start line is written, so a `wait` right after it finds the job.
//
// `wait` returns as soon as every job has ended, or after `--max` seconds (default 240, also the
// ceiling: an agent's prompt cache lasts five minutes, so no wait may be longer; call it again
// until the jobs end). A job has ended when its log's last line is the end line, or when its runner
// is gone without one (killed: reported as lost, exit 1). A file without a start line is not a
// job and fails at once rather than being waited on. It prints one screen: per job its state and
// elapsed time, where it stands in the GPU lock (holding a slot or the lock alone, or queued: at
// which place, behind whom; found through the job's process tree, so a capture several wrappers
// down counts) and its log's last lines (the text after a line's last carriage return, so progress
// bars show their latest state), then one line for the lock as a whole. It exits with the first
// failing job's code (0 when all succeeded) once every job has ended, and with 124 while any job
// is still running.
import { closeSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lockState } from './gpu-lock.mjs';

const MAX_WAIT = 240;
const STILL_RUNNING = 124;
const POLL_MS = 1000;

const duration = ( ms ) => {

	const s = Math.round( ms / 1000 );
	if ( s < 60 ) return `${ s } s`;
	if ( s < 3600 ) return `${ Math.floor( s / 60 ) }m ${ String( s % 60 ).padStart( 2, '0' ) }s`;
	return `${ Math.floor( s / 3600 ) }h ${ String( Math.floor( s / 60 ) % 60 ).padStart( 2, '0' ) }m`;

};

function alive( pid ) {

	try {

		process.kill( pid, 0 );
		return true;

	} catch ( error ) {

		return error.code === 'EPERM';

	}

}

// --- run -------------------------------------------------------------------------------------

async function run( log, cmd ) {

	mkdirSync( path.dirname( path.resolve( log ) ), { recursive: true } );
	const start = Date.now();
	writeFileSync( log, `[job] start ${ new Date( start ).toISOString() } pid ${ process.pid }: ${ cmd.join( ' ' ) }\n` );
	const fd = openSync( log, 'a' );
	const shell = cmd.length === 1;
	const child = spawn( shell ? '/bin/sh' : cmd[ 0 ], shell ? [ '-c', cmd[ 0 ] ] : cmd.slice( 1 ), { stdio: [ 'ignore', fd, fd ] } );
	for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) process.on( signal, () => child.kill( signal ) );
	const code = await new Promise( ( resolve ) => {

		child.on( 'error', ( error ) => {

			writeSync( fd, `${ error.message }\n` );
			resolve( 127 );

		} );
		child.on( 'exit', ( exitCode, signal ) => resolve( exitCode ?? 128 + ( os.constants.signals[ signal ] ?? 0 ) ) );

	} );
	const end = Date.now();
	writeSync( fd, `[done] exit ${ code } at ${ new Date( end ).toISOString() } after ${ duration( end - start ) }\n` );
	closeSync( fd );
	return code;

}

async function startDetached( log, cmd ) {

	const runner = spawn( process.execPath, [ fileURLToPath( import.meta.url ), 'run', '--log', log, '--', ...cmd ], { detached: true, stdio: 'ignore' } );
	runner.unref();
	for ( let i = 0; i < 100 && readJob( log )?.pid !== runner.pid; i ++ ) await new Promise( ( r ) => setTimeout( r, 50 ) );
	console.log( `[job] started ${ log } (runner pid ${ runner.pid }); wait with: node tools/job.mjs wait ${ log }` );
	return 0;

}

// --- reading a job ---------------------------------------------------------------------------

function readRange( file, from, length ) {

	const fd = openSync( file, 'r' );
	try {

		const buffer = Buffer.alloc( length );
		return buffer.subarray( 0, readSync( fd, buffer, 0, length, from ) ).toString( 'utf8' );

	} finally {

		closeSync( fd );

	}

}

// The job a log describes: { pid, start, command, ended, code, lost, endText }, or null when the
// file is missing or does not start with a start line.
function readJob( log ) {

	let size;
	try {

		size = statSync( log ).size;

	} catch {

		return null;

	}
	const head = readRange( log, 0, Math.min( size, 4096 ) ).split( '\n' )[ 0 ];
	const m = /^\[job\] start (\S+) pid (\d+): (.*)$/.exec( head );
	if ( ! m ) return null;
	const job = { pid: Number( m[ 2 ] ), start: Date.parse( m[ 1 ] ), command: m[ 3 ], size };
	const tail = readRange( log, Math.max( 0, size - 65536 ), Math.min( size, 65536 ) ).split( '\n' );
	if ( tail.at( - 1 ) === '' ) tail.pop();
	job.tail = tail;
	const end = /^\[done\] exit (\d+) at (\S+) after (.*)$/.exec( tail.at( - 1 ) ?? '' );
	if ( end ) Object.assign( job, { ended: true, code: Number( end[ 1 ] ), endText: `exit ${ end[ 1 ] } after ${ end[ 3 ] }` } );
	else if ( ! alive( job.pid ) ) Object.assign( job, { ended: true, lost: true, code: 1, endText: 'lost: its runner is gone without an end line (killed)' } );
	return job;

}

// --- status ----------------------------------------------------------------------------------

// pid -> parent pid for every process, read once per status
function processTree() {

	const parent = new Map();
	for ( const line of execFileSync( 'ps', [ '-A', '-o', 'pid=,ppid=' ], { encoding: 'utf8' } ).split( '\n' ) ) {

		const [ pid, ppid ] = line.trim().split( /\s+/ ).map( Number );
		if ( pid ) parent.set( pid, ppid );

	}
	return ( pid, root ) => {

		for ( let p = pid, hops = 0; p > 1 && hops < 64; p = parent.get( p ), hops ++ ) if ( p === root ) return true;
		return false;

	};

}

const names = ( list, max = 3 ) => list.slice( 0, max ).map( ( e ) => e.label ).join( ', ' ) + ( list.length > max ? `, +${ list.length - max } more` : '' );

function lockLine( job, lock, below ) {

	const held = lock.holders.filter( ( h ) => below( h.pid, job.pid ) );
	const waiting = lock.queue.map( ( t, i ) => ( { t, i } ) ).filter( ( { t } ) => below( t.pid, job.pid ) );
	const parts = held.map( ( h ) => h.mode === 'exclusive' ? `holding the lock alone (${ h.label })` : `holding shared slot ${ h.slot ?? '?' } (${ h.label })` );
	for ( const { t, i } of waiting ) {

		const ahead = lock.queue.slice( 0, i );
		const others = lock.holders.filter( ( h ) => ! below( h.pid, job.pid ) );
		parts.push( `queued #${ i + 1 } of ${ lock.queue.length } (${ t.mode === 'exclusive' ? 'exclusive' : `shared, ${ t.priority ?? 'normal' }` }, ${ duration( Date.now() - Date.parse( t.start ) ) })` +
			( ahead.length ? `, behind ${ names( ahead ) }` : '' ) + ( others.length ? `; held by ${ names( others ) }` : '' ) );

	}
	return parts.length ? parts.join( '; ' ) : 'not in it';

}

function lockSummary( lock ) {

	const exclusive = lock.holders.find( ( h ) => h.mode === 'exclusive' );
	const held = exclusive ? `held alone by ${ exclusive.label } for ${ duration( Date.now() - Date.parse( exclusive.start ) ) }`
		: lock.holders.length ? `${ lock.holders.length }/${ lock.slots } shared slots held (${ names( lock.holders ) })` : 'free';
	return `gpu lock: ${ held }${ lock.queue.length ? `, ${ lock.queue.length } queued` : '' }`;

}

// the command's last lines: without the start line (in the tail when the log is short) and the end line
function lastLines( job, n ) {

	const body = job.tail.filter( ( line, i ) => ! ( i === 0 && job.size <= 65536 ) && ! ( i === job.tail.length - 1 && job.ended && ! job.lost ) );
	return body.map( ( line ) => line.replace( /\r+$/, '' ) ).map( ( line ) => line.slice( line.lastIndexOf( '\r' ) + 1 ) ).filter( ( line ) => line.trim() ).slice( - n )
		.map( ( line ) => line.length > 200 ? line.slice( 0, 199 ) + '…' : line );

}

function report( logs, jobs, lines ) {

	const lock = lockState();
	const below = processTree();
	for ( const [ i, log ] of logs.entries() ) {

		const job = jobs[ i ];
		const state = job.ended ? job.endText : `running ${ duration( Date.now() - job.start ) } (runner pid ${ job.pid })`;
		console.log( `${ log }: ${ state }` );
		if ( ! job.ended ) console.log( `  gpu lock: ${ lockLine( job, lock, below ) }` );
		for ( const line of lastLines( job, lines ) ) console.log( `  | ${ line }` );

	}
	console.log( lockSummary( lock ) );

}

// --- wait ------------------------------------------------------------------------------------

async function wait( logs, max, lines ) {

	const begin = Date.now();
	let jobs;
	for ( ;; ) {

		jobs = logs.map( readJob );
		const missing = logs.filter( ( log, i ) => ! jobs[ i ] );
		if ( missing.length ) {

			console.error( `not a job log (no start line): ${ missing.join( ', ' ) }; start jobs with node tools/job.mjs run|start --log <file> -- <command>` );
			return 2;

		}
		if ( jobs.every( ( job ) => job.ended ) || Date.now() - begin >= max * 1000 ) break;
		await new Promise( ( r ) => setTimeout( r, Math.min( POLL_MS, Math.max( 0, max * 1000 - ( Date.now() - begin ) ) ) ) );

	}
	const waited = duration( Date.now() - begin );
	report( logs, jobs, lines );
	const running = jobs.filter( ( job ) => ! job.ended ).length;
	if ( running ) {

		console.log( `[wait] ${ running } of ${ jobs.length } still running after ${ waited }: wait again` );
		return STILL_RUNNING;

	}
	const failed = jobs.find( ( job ) => job.code !== 0 );
	console.log( `[wait] ${ jobs.length > 1 ? `all ${ jobs.length } jobs` : 'the job' } ended (waited ${ waited })${ failed ? `; failed: exit ${ failed.code }` : '' }` );
	return failed ? failed.code : 0;

}

// --- command line ----------------------------------------------------------------------------

const USAGE = 'usage: node tools/job.mjs run|start --log <file> -- <command ...> | wait <file>... [--max s] [--lines n] | status <file>... [--lines n]';

async function main( argv ) {

	const [ command, ...rest ] = argv;
	const split = rest.indexOf( '--' );
	const args = split >= 0 ? rest.slice( 0, split ) : rest;
	const cmd = split >= 0 ? rest.slice( split + 1 ) : [];
	const options = {}, files = [];
	for ( let i = 0; i < args.length; i ++ ) {

		if ( args[ i ].startsWith( '--' ) ) options[ args[ i ].slice( 2 ) ] = args[ ++ i ];
		else files.push( args[ i ] );

	}
	if ( ( command === 'run' || command === 'start' ) && options.log && cmd.length ) return command === 'run' ? run( options.log, cmd ) : startDetached( options.log, cmd );
	if ( ( command === 'wait' || command === 'status' ) && files.length ) {

		const max = command === 'status' ? 0 : Math.min( MAX_WAIT, Math.max( 0, Number( options.max ?? MAX_WAIT ) || 0 ) );
		return wait( files, max, Math.max( 0, Number( options.lines ?? 5 ) || 0 ) );

	}
	console.error( USAGE );
	return 2;

}

main( process.argv.slice( 2 ) ).then( ( code ) => process.exit( code ), ( error ) => {

	console.error( error.message );
	process.exit( 1 );

} );
