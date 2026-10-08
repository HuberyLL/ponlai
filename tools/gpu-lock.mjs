// A machine-wide lock for everything that renders the scene in a browser (captures, profiles,
// GPU probes). Frame times are only meaningful one browser at a time: two pages sharing the GPU
// each measure the other's work, and parallel sessions or agents cannot see each other's browsers.
// Pixels are not: a paused capture or a probe renders the same image however busy the GPU is.
// So the lock has two modes:
//   - exclusive (the default, every timing run): one holder, nothing else rendering;
//   - shared (deterministic captures and probes): any number of holders together, none while an
//     exclusive holder runs. An exclusive waiter blocks new shared holders and waits for the
//     current ones to drain, so a stream of probes cannot starve a profile.
//
// The lock is a directory (mkdir is atomic) under the user's temporary folder holding owner.json
// (pid, label, start time, mode); a lock whose process is gone is stale and taken over. Shared
// holders list themselves in its `shared/` folder and owner.json names one of them, handed on to
// another when it leaves, so a tool that knows only the exclusive protocol (an older copy of this
// file) still sees one live owner and waits. Exclusive waiters announce themselves in
// `soomi-gpu.lock.waiting/`; joining and leaving the shared lock is serialised by the
// `soomi-gpu.lock.mutex` directory.
//
//   import { withGpuLock, acquireGpuLock } from './gpu-lock.mjs';
//   await withGpuLock( 'profile island', async () => { ... } );           // held while fn runs
//   await acquireGpuLock( 'capture overview' );                           // held until this process exits
//   await acquireGpuLock( 'verify-sky', { shared: true } );               // shared with other probes
//
//   node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout seconds] -- <command ...>
//   node tools/gpu-lock.mjs status
//   node tools/gpu-lock.mjs gpu [--seconds 3]      (the GPU's utilisation and its busiest processes, macOS)
//
// A command started through `run` inherits the lock (SOOMI_GPU_LOCK_HELD, SOOMI_GPU_LOCK_MODE), so
// a wrapped tool that takes the lock itself does not wait for its own parent (a timing tool under a
// shared parent says so: its numbers may share the GPU). SOOMI_GPU_LOCK_DIR moves the lock.
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, statSync } from 'node:fs';
import { execFile, execFileSync, spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The user's temporary folder. On macOS it is asked of the system rather than read from TMPDIR,
// which a sandboxed session may point elsewhere, and its runs would then not see each other's lock.
function tempRoot() {

	if ( process.platform === 'darwin' ) {

		try {

			const dir = execFileSync( 'getconf', [ 'DARWIN_USER_TEMP_DIR' ], { encoding: 'utf8', timeout: 2000 } ).trim();
			if ( dir ) return dir;

		} catch { /* fall back */ }

	}
	return os.tmpdir();

}

export const LOCK_DIR = path.join( process.env.SOOMI_GPU_LOCK_DIR || tempRoot(), 'soomi-gpu.lock' );
const OWNER = path.join( LOCK_DIR, 'owner.json' );
const MEMBERS = path.join( LOCK_DIR, 'shared' );
const WAITING = `${ LOCK_DIR }.waiting`;
const MUTEX = `${ LOCK_DIR }.mutex`;
const POLL_MS = 500;

let depth = 0; // re-entrant within this process
let heldMode = null; // 'exclusive' | 'shared' while this process holds the lock itself
let installed = false;

function alive( pid ) {

	if ( ! ( pid > 0 ) ) return false;
	try {

		process.kill( pid, 0 );
		return true;

	} catch ( error ) {

		// EPERM: the process exists but belongs to someone else
		return error.code === 'EPERM';

	}

}

const readJson = ( file ) => {

	try { return JSON.parse( readFileSync( file, 'utf8' ) ); } catch { return null; }

};
// written whole or not at all, so a reader never sees half a file
function writeJson( file, value ) {

	const tmp = `${ file }.${ process.pid }.tmp`;
	writeFileSync( tmp, JSON.stringify( value ) );
	renameSync( tmp, file );

}

/** The lock's current owner, or null when it is free. A shared lock's owner carries
 * `mode: 'shared'` and `members` (every shared holder). */
export function lockOwner() {

	const owner = readJson( OWNER );
	if ( owner ) {

		if ( owner.mode === 'shared' ) owner.members = sharedMembers();
		return owner;

	}
	try {

		// the directory exists but owner.json is not written yet (or was lost)
		const stat = statSync( LOCK_DIR );
		return { pid: 0, label: '(unknown)', start: stat.mtime.toISOString(), unknown: true, ageMs: Date.now() - stat.mtimeMs };

	} catch {

		return null;

	}

}

function listJson( dir ) {

	try {

		return readdirSync( dir ).filter( ( f ) => f.endsWith( '.json' ) ).map( ( f ) => ( { file: path.join( dir, f ), ...readJson( path.join( dir, f ) ) } ) );

	} catch {

		return [];

	}

}

/** The shared holders that are still running (files of dead ones are removed). */
function sharedMembers() {

	return listJson( MEMBERS ).filter( ( m ) => {

		if ( alive( m.pid ) ) return true;
		rmSync( m.file, { force: true } );
		return false;

	} ).map( ( { file, ...m } ) => m );

}

/** Exclusive holders-to-be waiting for the shared holders to drain. */
function exclusiveWaiters() {

	return listJson( WAITING ).filter( ( w ) => {

		if ( w.pid !== process.pid && alive( w.pid ) ) return true;
		if ( w.pid !== process.pid ) rmSync( w.file, { force: true } );
		return false;

	} );

}

function inherited() {

	const held = Number( process.env.SOOMI_GPU_LOCK_HELD );
	if ( ! ( held > 0 ) || ! alive( held ) ) return false;
	const owner = lockOwner();
	return Boolean( owner && ( owner.pid === held || owner.members?.some( ( m ) => m.pid === held ) ) );

}

// The mutex serialises joining and leaving the shared lock (and repairing it). Held for a few
// file operations only; one whose holder is gone, or older than 10 s, is broken.
async function withMutex( fn ) {

	for ( ;; ) {

		try {

			mkdirSync( MUTEX );
			break;

		} catch ( error ) {

			if ( error.code !== 'EEXIST' ) throw error;
			const holder = readJson( path.join( MUTEX, 'owner.json' ) );
			let age = 0;
			try { age = Date.now() - statSync( MUTEX ).mtimeMs; } catch { continue; }
			if ( ( holder && ! alive( holder.pid ) ) || age > 10000 ) rmSync( MUTEX, { recursive: true, force: true } );
			else await new Promise( ( resolve ) => setTimeout( resolve, 20 ) );

		}

	}
	try {

		writeFileSync( path.join( MUTEX, 'owner.json' ), JSON.stringify( { pid: process.pid } ) );
		return fn();

	} finally {

		rmSync( MUTEX, { recursive: true, force: true } );

	}

}
// the synchronous variant, for the exit handler (which cannot wait); it breaks a busy mutex after 2 s
function withMutexSync( fn ) {

	const until = Date.now() + 2000;
	while ( Date.now() < until ) {

		try { mkdirSync( MUTEX ); break; } catch ( error ) { if ( error.code !== 'EEXIST' ) throw error; }

	}
	try { return fn(); } finally { rmSync( MUTEX, { recursive: true, force: true } ); }

}

function removeStale( owner ) {

	// Move the stale lock aside first, then check it is still the one we judged stale: two
	// waiters may both find it stale, and the slower one must not delete the faster one's lock.
	const aside = `${ LOCK_DIR }.stale-${ process.pid }-${ Date.now() }`;
	try {

		renameSync( LOCK_DIR, aside );

	} catch {

		return;

	}
	const moved = readJson( path.join( aside, 'owner.json' ) );
	if ( moved && owner && moved.pid !== owner.pid && alive( moved.pid ) ) {

		// we moved a fresh lock: put it back if nobody took the place meanwhile
		try { renameSync( aside, LOCK_DIR ); return; } catch { /* taken: its owner keeps running unlocked */ }

	}
	rmSync( aside, { recursive: true, force: true } );

}

// A shared lock whose named owner is gone but whose other members still run: name one of them.
// (A tool knowing only the exclusive protocol would take such a lock for stale, so the owner is
// handed on whenever a member leaves.) Call inside the mutex.
function repairShared() {

	const owner = readJson( OWNER );
	if ( ! owner || owner.mode !== 'shared' ) return;
	const members = sharedMembers();
	if ( members.length === 0 ) {

		rmSync( LOCK_DIR, { recursive: true, force: true } );
		return;

	}
	if ( ! members.some( ( m ) => m.pid === owner.pid ) ) writeJson( OWNER, { ...owner, pid: members[ 0 ].pid, label: `shared: ${ members[ 0 ].label }` } );

}

function tryAcquireExclusive( label ) {

	try {

		mkdirSync( LOCK_DIR );

	} catch ( error ) {

		if ( error.code !== 'EEXIST' ) throw error;
		const owner = lockOwner();
		if ( ! owner ) return false;
		if ( owner.mode === 'shared' ) return 'shared';
		const stale = owner.unknown ? owner.ageMs > 10000 : ! alive( owner.pid );
		if ( stale ) removeStale( owner.unknown ? null : owner );
		return false;

	}
	writeFileSync( OWNER, JSON.stringify( { pid: process.pid, label, start: new Date().toISOString(), mode: 'exclusive' } ) );
	return true;

}

function joinShared( label ) {

	// a waiting exclusive holder goes first
	if ( exclusiveWaiters().length ) return false;
	const me = { pid: process.pid, label, start: new Date().toISOString() };
	try {

		mkdirSync( LOCK_DIR );

	} catch ( error ) {

		if ( error.code !== 'EEXIST' ) throw error;
		const owner = readJson( OWNER );
		if ( ! owner ) {

			// being written, or lost
			const info = lockOwner();
			if ( info?.unknown && info.ageMs > 10000 ) removeStale( null );
			return false;

		}
		if ( owner.mode !== 'shared' ) {

			if ( ! alive( owner.pid ) ) removeStale( owner );
			return false;

		}
		repairShared();
		if ( ! readJson( OWNER ) ) return false; // it emptied: try again
		mkdirSync( MEMBERS, { recursive: true } );
		writeJson( path.join( MEMBERS, `${ process.pid }.json` ), me );
		return true;

	}
	mkdirSync( MEMBERS, { recursive: true } );
	writeJson( path.join( MEMBERS, `${ process.pid }.json` ), me );
	writeJson( OWNER, { ...me, label: `shared: ${ label }`, mode: 'shared' } );
	return true;

}

function leaveShared() {

	withMutexSync( () => {

		rmSync( path.join( MEMBERS, `${ process.pid }.json` ), { force: true } );
		repairShared();

	} );

}

/** Releases the lock if this process holds it. */
export function releaseGpuLock() {

	depth = 0;
	rmSync( path.join( WAITING, `${ process.pid }.json` ), { force: true } );
	if ( heldMode === 'shared' ) {

		heldMode = null;
		leaveShared();
		return;

	}
	heldMode = null;
	const owner = readJson( OWNER );
	if ( owner && owner.pid === process.pid && owner.mode !== 'shared' ) rmSync( LOCK_DIR, { recursive: true, force: true } );

}

function installRelease() {

	if ( installed ) return;
	installed = true;
	process.on( 'exit', releaseGpuLock );
	for ( const [ signal, code ] of [ [ 'SIGINT', 130 ], [ 'SIGTERM', 143 ], [ 'SIGHUP', 129 ] ] ) {

		process.on( signal, () => {

			releaseGpuLock();
			process.exit( code );

		} );

	}

}

/** Waits for the lock and takes it. It is held until releaseGpuLock() or this process exits.
 * `timeout` in seconds (0: wait for ever); `shared: true` for work whose result does not depend
 * on what else runs on the GPU (paused captures, pixel probes). Returns the wait in milliseconds. */
export async function acquireGpuLock( label = path.basename( process.argv[ 1 ] ?? 'node' ), { timeout = 0, quiet = false, shared = false } = {} ) {

	if ( depth > 0 || inherited() ) {

		const parentMode = depth > 0 ? heldMode : process.env.SOOMI_GPU_LOCK_MODE;
		if ( ! shared && parentMode === 'shared' && ! quiet ) console.error( `[gpu-lock] "${ label }" wants the GPU to itself but runs under a shared lock: other probes may render meanwhile` );
		depth ++;
		return 0;

	}
	installRelease();
	const started = Date.now();
	let told = 0;
	const waitFile = path.join( WAITING, `${ process.pid }.json` );
	if ( ! shared ) {

		mkdirSync( WAITING, { recursive: true } );
		writeJson( waitFile, { pid: process.pid, label, start: new Date().toISOString() } );

	}
	try {

		for ( ;; ) {

			const got = shared ? await withMutex( () => joinShared( label ) ) : tryAcquireExclusive( label );
			if ( got === true ) break;
			// a shared lock whose named owner died while others hold it: hand it on
			if ( got === 'shared' ) await withMutex( repairShared );
			const waited = Date.now() - started;
			if ( timeout > 0 && waited > timeout * 1000 ) {

				const owner = lockOwner();
				throw new Error( `GPU lock: still held by ${ owner?.label } (pid ${ owner?.pid }) after ${ timeout } s` );

			}
			if ( ! quiet && waited - told >= ( told === 0 ? 0 : 30000 ) ) {

				const owner = lockOwner();
				const waiters = shared ? exclusiveWaiters() : [];
				if ( owner ) console.error( `[gpu-lock] waiting for "${ owner.label }" (pid ${ owner.pid }, since ${ owner.start }${ owner.members?.length > 1 ? `, ${ owner.members.length } shared holders` : '' })` );
				else if ( waiters.length ) console.error( `[gpu-lock] waiting: "${ waiters[ 0 ].label }" (pid ${ waiters[ 0 ].pid }) wants the GPU to itself first` );
				told = waited || 1;

			}
			await new Promise( ( resolve ) => setTimeout( resolve, POLL_MS ) );

		}

	} finally {

		rmSync( waitFile, { force: true } );

	}
	depth = 1;
	heldMode = shared ? 'shared' : 'exclusive';
	return Date.now() - started;

}

/** Runs `fn` while holding the lock (`options` as for acquireGpuLock). */
export async function withGpuLock( label, fn, options = {} ) {

	const reentrant = depth > 0 || inherited();
	await acquireGpuLock( label, options );
	try {

		return await fn();

	} finally {

		if ( reentrant ) depth = Math.max( depth - 1, 0 );
		else releaseGpuLock();

	}

}

// ------------------------------------------------------------------ GPU utilisation (macOS)

/** The GPU's "Device Utilization %" from the IOAccelerator's statistics, or null where unknown. */
export function gpuUtilisation() {

	if ( process.platform !== 'darwin' ) return Promise.resolve( null );
	return new Promise( ( resolve ) => {

		execFile( 'ioreg', [ '-r', '-d', '1', '-w', '0', '-c', 'IOAccelerator' ], { timeout: 5000 }, ( error, stdout ) => {

			const values = [ ...( stdout ?? '' ).matchAll( /"Device Utilization %"=(\d+)/g ) ].map( ( m ) => Number( m[ 1 ] ) );
			resolve( error || values.length === 0 ? null : Math.max( ...values ) );

		} );

	} );

}

// GPU time per process: the Apple GPU driver keeps each client's accumulated GPU time (ns) in the
// I/O registry, so two snapshots name whatever else is rendering.
function gpuTimes() {

	return new Promise( ( resolve ) => {

		execFile( 'ioreg', [ '-r', '-c', 'AGXDeviceUserClient', '-l', '-w', '0' ], { timeout: 5000, maxBuffer: 1 << 26 }, ( error, stdout ) => {

			if ( error ) return resolve( null );
			const times = new Map();
			let creator = null;
			for ( const line of stdout.split( '\n' ) ) {

				const c = line.match( /"IOUserClientCreator" = "pid (\d+), ([^"]*)"/ );
				if ( c ) { creator = `${ c[ 2 ] } (pid ${ c[ 1 ] })`; continue; }
				if ( creator && line.includes( '"AppUsage"' ) ) {

					const ns = [ ...line.matchAll( /"accumulatedGPUTime"=(\d+)/g ) ].reduce( ( a, m ) => a + Number( m[ 1 ] ), 0 );
					times.set( creator, ( times.get( creator ) ?? 0 ) + ns );

				}

			}
			resolve( times );

		} );

	} );

}

/** The processes that used the GPU over `seconds`, busiest first: [ { name, percent } ] (macOS
 * with an Apple GPU; null elsewhere). */
export async function gpuClients( seconds = 2 ) {

	if ( process.platform !== 'darwin' ) return null;
	const a = await gpuTimes();
	const t0 = process.hrtime.bigint();
	await new Promise( ( resolve ) => setTimeout( resolve, seconds * 1000 ) );
	const b = await gpuTimes();
	const elapsed = Number( process.hrtime.bigint() - t0 );
	if ( ! a || ! b ) return null;
	return [ ...b ].map( ( [ name, ns ] ) => ( { name, percent: + ( ( ns - ( a.get( name ) ?? 0 ) ) / elapsed * 100 ).toFixed( 1 ) } ) )
		.filter( ( c ) => c.percent >= 0.5 ).sort( ( x, y ) => y.percent - x.percent ).slice( 0, 6 );

}

/** Samples the utilisation for `seconds` (every 0.25 s): { mean, max, samples }. */
export async function sampleGpuUtilisation( seconds = 3 ) {

	const samples = [];
	const end = Date.now() + seconds * 1000;
	while ( Date.now() < end ) {

		const value = await gpuUtilisation();
		if ( value === null ) return null;
		samples.push( value );
		await new Promise( ( resolve ) => setTimeout( resolve, 250 ) );

	}
	const mean = samples.reduce( ( a, b ) => a + b, 0 ) / samples.length;
	return { mean: + mean.toFixed( 1 ), max: Math.max( ...samples ), samples: samples.length };

}

/** Checks that nothing else is rendering before a measurement (call it while holding the lock,
 * so none of our own runs are). Above `threshold` % it warns and waits up to `wait` seconds for
 * the GPU to settle. Returns { idle, contended, waitedMs, samples: [...] }. */
export async function waitForIdleGpu( { threshold = 15, seconds = 3, wait = 60, log = console.error } = {} ) {

	const started = Date.now();
	const history = [];
	for ( ;; ) {

		const sample = await sampleGpuUtilisation( seconds );
		if ( sample === null ) return { idle: null, contended: false, waitedMs: 0, samples: history, note: 'utilisation unavailable' };
		history.push( sample );
		if ( sample.mean <= threshold ) return { idle: sample, contended: false, waitedMs: Date.now() - started, samples: history };
		const waited = Date.now() - started;
		const clients = await gpuClients( 1 );
		const who = clients?.length ? `: ${ clients.map( ( c ) => `${ c.name } ${ c.percent } %` ).join( ', ' ) }` : '';
		if ( waited > wait * 1000 ) {

			log( `[gpu-lock] the GPU is still ${ sample.mean } % busy after ${ Math.round( waited / 1000 ) } s${ who }; results are marked contended` );
			return { idle: sample, contended: true, waitedMs: waited, samples: history, clients };

		}
		if ( history.length === 1 ) log( `[gpu-lock] the GPU is ${ sample.mean } % busy (max ${ sample.max } %) with no locked run${ who }; waiting up to ${ wait } s` );

	}

}

// ------------------------------------------------------------------ CLI

async function main( argv ) {

	const [ command, ...rest ] = argv;
	const opt = ( name, fallback ) => {

		const i = rest.indexOf( '--' + name );
		const end = rest.indexOf( '--' );
		return i >= 0 && ( end < 0 || i < end ) ? rest[ i + 1 ] : fallback;

	};
	if ( command === 'status' ) {

		const owner = lockOwner();
		const waiting = exclusiveWaiters().map( ( { file, ...w } ) => w );
		console.log( owner ? JSON.stringify( { ...owner, alive: owner.pid ? alive( owner.pid ) : null, dir: LOCK_DIR, ...( waiting.length ? { waiting } : {} ) } ) : `free (${ LOCK_DIR })${ waiting.length ? ` ${ JSON.stringify( { waiting } ) }` : '' }` );
		return 0;

	}
	if ( command === 'gpu' ) {

		const seconds = Number( opt( 'seconds', 3 ) );
		const [ utilisation, clients ] = await Promise.all( [ sampleGpuUtilisation( seconds ), gpuClients( seconds ) ] );
		console.log( JSON.stringify( { utilisation, clients } ) );
		return 0;

	}
	if ( command === 'run' ) {

		const split = rest.indexOf( '--' );
		const cmd = split >= 0 ? rest.slice( split + 1 ) : [];
		if ( cmd.length === 0 ) throw new Error( 'usage: node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout s] -- <command ...>' );
		const label = opt( 'label', cmd.join( ' ' ).slice( 0, 80 ) );
		const shared = ( split >= 0 ? rest.slice( 0, split ) : rest ).includes( '--shared' );
		const waited = await acquireGpuLock( label, { timeout: Number( opt( 'timeout', 0 ) ), shared } );
		if ( waited > 1000 ) console.error( `[gpu-lock] acquired${ shared ? ' (shared)' : '' } after ${ ( waited / 1000 ).toFixed( 1 ) } s` );
		const child = spawn( cmd[ 0 ], cmd.slice( 1 ), { stdio: 'inherit', env: { ...process.env, SOOMI_GPU_LOCK_HELD: String( process.pid ), SOOMI_GPU_LOCK_MODE: shared ? 'shared' : 'exclusive' } } );
		for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {

			process.removeAllListeners( signal );
			process.on( signal, () => child.kill( signal ) );

		}
		return await new Promise( ( resolve ) => {

			child.on( 'error', ( error ) => { console.error( error.message ); resolve( 127 ); } );
			child.on( 'exit', ( code, signal ) => resolve( code ?? ( signal ? 128 + ( os.constants.signals[ signal ] ?? 0 ) : 1 ) ) );

		} );

	}
	console.error( 'usage: node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout s] -- <command ...> | status | gpu [--seconds n]' );
	return 2;

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	main( process.argv.slice( 2 ) ).then( ( code ) => {

		releaseGpuLock();
		process.exit( code );

	}, ( error ) => {

		console.error( error.message );
		releaseGpuLock();
		process.exit( 1 );

	} );

}
