// The machine-wide GPU lock's entry: every tool imports this file (and `node tools/gpu-lock.mjs
// <command>` runs it), and it loads the lock itself from tools/gpu-lock-impl.mjs (the rules, the
// files and the CLI are described there). Every worktree carries its own copy of the lock, and
// copies that disagree on the rules share one lock: a rule a newer copy adds (shared first, the
// levels) does not hold while sessions run older copies. So this entry loads whichever
// implementation declares the higher LOCK_VERSION, this worktree's or the main checkout's (found
// through `git rev-parse --git-common-dir`), and the main checkout's on a tie: a branch with this
// entry runs every later lock upgrade once main has it, without merging main.
// - The version is read from the file's text (`export const LOCK_VERSION = n;`), so the copy not
//   chosen is never loaded. A main checkout without gpu-lock-impl.mjs (its lock from before this
//   entry, one file without a version) counts as version 0.
// - If the main checkout's implementation does not load (a conflict mid-merge, a syntax error, no
//   readable version), this worktree's runs instead, said once on stderr.
// - PONLAI_GPU_LOCK_IMPL=local forces this worktree's copy (to test a change to the lock);
//   PONLAI_GPU_LOCK_MAIN=<dir> stands in for the main checkout's root (for the entry's own tests).
// - `status` prints which file runs and why (IMPL, also exported).
// The exports below are the implementation's; a newer implementation only adds to them (its
// header), so whatever this entry loads provides every name it re-exports.
import './qos.mjs'; // first, as the implementation does: it re-executes the process before the choice below
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const NAME = 'gpu-lock-impl.mjs';
const here = path.dirname( fileURLToPath( import.meta.url ) );
const local = path.join( here, NAME );

// the main checkout's root: the directory holding the repository's common .git
function mainRoot() {

	if ( process.env.PONLAI_GPU_LOCK_MAIN ) return path.resolve( process.env.PONLAI_GPU_LOCK_MAIN );
	try {

		const common = execFileSync( 'git', [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], { cwd: here, encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'ignore' ], timeout: 5000 } ).trim();
		return common ? path.dirname( common ) : null;

	} catch {

		return null;

	}

}

// a file's LOCK_VERSION: 0 when the file is absent (a lock from before the entry), null when it is
// there without a readable version
function versionOf( file ) {

	let text;
	try {

		text = readFileSync( file, 'utf8' );

	} catch {

		return 0;

	}
	const m = /^export const LOCK_VERSION = (\d+);/m.exec( text );
	return m ? Number( m[ 1 ] ) : null;

}

const same = ( a, b ) => {

	try {

		return realpathSync( a ) === realpathSync( b );

	} catch {

		return false;

	}

};

const localVersion = versionOf( local );
let file = local, why;
const root = process.env.PONLAI_GPU_LOCK_IMPL === 'local' ? null : mainRoot();
const remote = root && path.join( root, 'tools', NAME );
if ( process.env.PONLAI_GPU_LOCK_IMPL === 'local' ) why = 'PONLAI_GPU_LOCK_IMPL=local';
else if ( ! remote ) why = 'no main checkout found';
else if ( same( remote, local ) ) why = 'this is the main checkout';
else {

	const mainVersion = versionOf( remote );
	if ( mainVersion === null ) {

		why = `the main checkout's ${ remote } has no readable LOCK_VERSION`;
		console.error( `[gpu-lock] ${ why }: running this worktree's lock` );

	} else if ( mainVersion >= localVersion ) {

		file = remote;
		why = `main checkout's v${ mainVersion } ${ mainVersion === localVersion ? '=' : '>' } this worktree's v${ localVersion }`;

	} else why = `this worktree's v${ localVersion } > the main checkout's v${ mainVersion }`;

}

let impl;
try {

	impl = await import( pathToFileURL( file ).href );

} catch ( error ) {

	if ( file === local ) throw error;
	why = `the main checkout's ${ file } failed to load (${ error.message.split( '\n' )[ 0 ] })`;
	console.error( `[gpu-lock] ${ why }: running this worktree's lock` );
	file = local;
	impl = await import( pathToFileURL( local ).href );

}

/** The implementation that runs: its file, its version and why it was chosen. */
export const IMPL = { file, version: impl.LOCK_VERSION ?? 0, why };

export const {
	LOCK_VERSION, LOCK_DIR, TABLE, SLOTS, LEVELS, parseLevel, defaultLevel, readTable, levelOf, levelRank,
	lockOwner, queueOrder, startableShared, lockState, releaseGpuLock, acquireGpuLock, withGpuLock,
	leaseGpuLock, yieldAncestorSlot, gpuUtilisation, gpuClients, sampleGpuUtilisation, waitForIdleGpu,
	labelKind, lockDurations, estimateWaits, etaText, readLockLog, summariseLockLog,
} = impl;

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	impl.main( process.argv.slice( 2 ), { impl: `${ file } v${ IMPL.version } (${ why })` } ).then( ( code ) => {

		impl.releaseGpuLock();
		process.exit( code );

	}, ( error ) => {

		console.error( error.message );
		impl.releaseGpuLock();
		process.exit( 1 );

	} );

}
