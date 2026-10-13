// A machine-wide lock for everything that renders the scene in a browser (captures, profiles,
// GPU probes). Frame times are only meaningful one browser at a time: two pages sharing the GPU
// each measure the other's work, and parallel sessions or agents cannot see each other's browsers.
// Pixels are not: a paused capture or a probe renders the same image however busy the GPU is.
// So the lock has two modes:
//   - exclusive (the default, every timing run): one holder, nothing else rendering;
//   - shared (deterministic captures and probes): up to PONLAI_GPU_SLOTS holders together (default
//     3), none while an exclusive holder runs. Captures are GPU-bound: past 2-3 pages at once the
//     throughput stays flat and only each page's latency grows (and its loads time out), so the
//     rest queue first in, first out. A slot is held per capture (capture.mjs from a view's load or
//     scene jump to its shot, capture-clip.mjs around its clip), not per set or page, so a long set
//     and a one-view probe interleave.
// Both modes wait in one queue, served in arrival order: an exclusive request lets the requests
// queued before it go first, then blocks new shared holders, waits for the current ones to drain
// and holds the lock alone; everything queued after it, exclusive or shared, waits for it. So a
// stream of probes cannot starve a profile, and neither can another session's back-to-back timing
// runs: exclusive requests used to race for the lock (a mkdir every 500 ms), so a process that
// released and asked again at once, or a run started the moment the previous one ended, won it
// every time, and another session's exclusive request once waited 14 minutes behind such a series.
//
// The lock is a directory (mkdir is atomic) under the user's temporary folder holding owner.json
// (pid, label, start time, mode); a lock whose process is gone is stale and taken over. Shared
// holders list themselves in its `shared/` folder (one file per slot, with its index) and owner.json
// names one of them, handed on to another when it leaves, so a tool that knows only the exclusive
// protocol (an older copy of this file) still sees one live owner and waits. Requests wait in
// `ponlai-gpu.lock.queue/` (tickets numbered from `ponlai-gpu.lock.seq`; an exclusive one carries
// `mode: 'exclusive'`); the exclusive request first in turn also announces itself in
// `ponlai-gpu.lock.waiting/`, which holds back older copies' shared requests (they rank exclusive
// tickets as shared ones). Taking a ticket, joining, leaving and taking the lock alone are
// serialised by the `ponlai-gpu.lock.mutex` directory. A holder, ticket or waiter whose process is
// gone (killed) is dropped at the next look, so its slot frees itself and the queue moves on.
// Older copies of this file are treated conservatively, as they treat us: their exclusive requests
// take no ticket and are known only by a waiter file without a ticket number; such a request blocks
// every shared join while it waits (as it always did), and an exclusive request that asked after it
// lets it go first (one that asked before it races it for the lock, as before). An older copy that
// predates the slots joins without a ticket, a slot or the limit, and is not counted: its
// `run --shared` wrappers are members for a whole set, so counting them would starve the queue.
//
// Shared requests have a class: normal, or low with PONLAI_GPU_PRIORITY=low (inherited by every
// child through the environment, so `PONLAI_GPU_PRIORITY=low node tools/gpu-lock.mjs run --shared --
// <set>` makes all its captures low). Background work (tool proofs, reference rounds) runs low so
// that a session's interactive work does not queue behind it, without fixed shares: a free slot goes
// to the oldest normal request first and to a low one only when no normal request waits, so low work
// still fills every slot nobody else wants; low requests are first in, first out among themselves.
// A holder is never preempted, and exclusive requests ignore the class: their tickets rank as normal
// ones, since a timing run is work someone waits for and slots are what low work yields (an exclusive
// request of a low process still goes in arrival order). Nothing low waits for ever:
// PONLAI_GPU_LOW_MAX_WAIT seconds (default 600) after a low request queued, it ranks as a normal one
// from its original place (its ticket carries that time, so every requester agrees). The default
// comes from the aa session's run log over 2026-10-10..12: its bursts of back-to-back runs lasted
// 6 / 17 / 42 min (median / p75 / p90, old tools under contention, a few times slower than now) with
// median gaps of 5 min for analysis. Ten minutes lets a typical burst finish untouched, so low work
// runs in the gaps, and caps a low request's wait during the long calibration stretches (up to
// 2.5 h) at the cost to normal work of one capture per waiting low request per 10 min. An older copy
// of this file queues first in, first out and knows no class; its tickets split the ranking (see
// queueOrder) so that it and the two classes never wait for each other.
//
//   import { withGpuLock, acquireGpuLock } from './gpu-lock.mjs';
//   await withGpuLock( 'profile island', async () => { ... } );           // held while fn runs
//   await acquireGpuLock( 'capture overview' );                           // held until this process exits
//   await acquireGpuLock( 'verify-sky', { shared: true } );               // shared with other probes
//   lockState();                                                          // holders and queue in turn (job.mjs)
//
//   node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout seconds] -- <command ...>
//   node tools/gpu-lock.mjs status                 (the owner, the holders, the queue and the exclusive requests in turn)
//   node tools/gpu-lock.mjs gpu [--seconds 3]      (the GPU's utilisation and its busiest processes, macOS)
//
// A command started through `run` inherits the lock (PONLAI_GPU_LOCK_HELD, PONLAI_GPU_LOCK_MODE), and
// so does any process below a holder in the process tree, through any wrappers, so a wrapped tool
// that takes the lock itself does not wait for its own ancestor (a timing tool under a shared parent
// says so: its numbers may share the GPU). Below an exclusive holder everything is re-entrant. Below
// a shared holder, the first descendant that asks for a shared slot takes its ancestor's slot over:
// the ancestor (a `run --shared` around capture-set or baseline.mjs, an inner `run` per shot) is an
// orchestrator from then on and holds nothing, and its other children queue like anyone else. So
// an orchestrator never holds a slot its children wait for (with 3 slots, three wrapped sets would
// otherwise hold all three while their captures wait), and an exclusive waiter gets in between the
// captures of a set rather than after the whole set. A descendant about to wait for something else
// (yieldAncestorSlot: a reference another process is capturing) frees that slot the same way.
// PONLAI_GPU_LOCK_DIR moves the lock.
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

export const LOCK_DIR = path.join( process.env.PONLAI_GPU_LOCK_DIR || tempRoot(), 'ponlai-gpu.lock' );
const OWNER = path.join( LOCK_DIR, 'owner.json' );
const MEMBERS = path.join( LOCK_DIR, 'shared' );
const WAITING = `${ LOCK_DIR }.waiting`;
const QUEUE = `${ LOCK_DIR }.queue`;
const SEQ = `${ LOCK_DIR }.seq`;
const MUTEX = `${ LOCK_DIR }.mutex`;
const POLL_MS = 500;
/** How many shared holders may render at once (each requester reads its own environment). */
export const SLOTS = Math.max( 1, Math.floor( Number( process.env.PONLAI_GPU_SLOTS ) ) || 3 );
/** This process's class for shared requests: 'low' (PONLAI_GPU_PRIORITY=low) yields free slots to
 * normal requests; anything else is 'normal'. Children inherit it through the environment. */
export const PRIORITY = process.env.PONLAI_GPU_PRIORITY === 'low' ? 'low' : 'normal';
/** The longest a low request yields, in seconds (PONLAI_GPU_LOW_MAX_WAIT, default 600: see the
 * header); past it the request queues as a normal one from its original place. */
export const LOW_MAX_WAIT = ( ( v ) => Number.isFinite( v ) && v >= 0 ? v : 600 )( Number( process.env.PONLAI_GPU_LOW_MAX_WAIT ?? NaN ) );

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

/** Exclusive holders-to-be announcing that they wait for the shared holders to drain (files of
 * dead ones are removed). */
function exclusiveWaiters() {

	return listJson( WAITING ).filter( ( w ) => {

		if ( w.pid !== process.pid && alive( w.pid ) ) return true;
		if ( w.pid !== process.pid ) rmSync( w.file, { force: true } );
		return false;

	} );

}
// Exclusive requests of an older copy of this file: they take no ticket, so they are known only by
// their waiter file, which carries no `seq` (this copy's waiter files name their ticket).
const untrackedWaiters = () => exclusiveWaiters().filter( ( w ) => w.seq === undefined );

/** The waiting requests (tickets), first in first (tickets of dead processes are removed). */
function queued() {

	return listJson( QUEUE ).filter( ( t ) => {

		if ( alive( t.pid ) ) return true;
		rmSync( t.file, { force: true } );
		return false;

	} ).sort( ( a, b ) => a.seq - b.seq ).map( ( { file, ...t } ) => t );

}

// a place in the queue (the ticket); call inside the mutex. A low ticket carries the time it stops
// yielding, so every requester ranks it alike whatever its own environment says. An exclusive
// ticket is always normal (exclusive requests ignore the class: see the header).
function enqueue( label, exclusive = false ) {

	const seq = ( Number( readJson( SEQ ) ) || 0 ) + 1;
	writeJson( SEQ, seq );
	mkdirSync( QUEUE, { recursive: true } );
	const now = Date.now();
	const priority = exclusive ? 'normal' : PRIORITY;
	const ticket = { pid: process.pid, label, seq, start: new Date( now ).toISOString(), priority };
	if ( exclusive ) ticket.mode = 'exclusive';
	if ( priority === 'low' ) ticket.promoteAt = new Date( now + LOW_MAX_WAIT * 1000 ).toISOString();
	writeJson( path.join( QUEUE, `${ process.pid }.json` ), ticket );
	return ticket;

}

// The waiting tickets in the order they are served: normal tickets first in, first out, then
// low ones first in, first out; a low ticket past its promoteAt ranks as a normal one from its
// original place. A ticket from an older copy of this file (no priority) waits for every earlier
// ticket, low ones too, so it is a barrier: everything taken before it ranks before it, everything
// after it ranks after it, and the classes order each stretch between barriers. Ranking a later
// normal ticket before an earlier low one across a barrier would make the three wait for each other.
function queueOrder( tickets, now = Date.now() ) {

	const barriers = tickets.filter( ( t ) => t.priority === undefined ).map( ( t ) => t.seq );
	const key = ( t ) => [
		barriers.filter( ( seq ) => seq < t.seq ).length,
		t.priority === undefined ? 2 : t.priority === 'low' && now < Date.parse( t.promoteAt ) ? 1 : 0,
		t.seq
	];
	return tickets.map( ( t ) => ( { t, k: key( t ) } ) )
		.sort( ( a, b ) => a.k[ 0 ] - b.k[ 0 ] || a.k[ 1 ] - b.k[ 1 ] || a.k[ 2 ] - b.k[ 2 ] ).map( ( { t } ) => t );

}
// the waiting tickets served before this one, in turn
function ticketsBefore( ticket ) {

	const order = queueOrder( [ ...queued().filter( ( t ) => t.pid !== ticket.pid ), ticket ] );
	return order.slice( 0, order.indexOf( ticket ) );

}
const ticketsAhead = ( ticket ) => ticketsBefore( ticket ).length;

/** The lock as other tools see it (job.mjs reports where a job stands): the holders, each
 * { pid, label, start, mode, slot? }, and the waiting tickets in the order they are served. */
export function lockState() {

	const owner = lockOwner();
	const holders = ! owner ? [] : owner.mode === 'shared'
		? owner.members.map( ( m ) => ( { ...m, mode: 'shared' } ) )
		: [ { pid: owner.pid, label: owner.label, start: owner.start, mode: 'exclusive' } ];
	return { holders, queue: queueOrder( queued() ), slots: SLOTS };

}

// this process's parent's parent and so on (0 when it cannot be read)
function parentOf( pid ) {

	try {

		return Number( execFileSync( 'ps', [ '-o', 'ppid=', '-p', String( pid ) ], { encoding: 'utf8', timeout: 2000 } ).trim() ) || 0;

	} catch {

		return 0;

	}

}

// The holder above this process in the process tree, { pid, mode }, or null.
function holdingAncestor() {

	const owner = lockOwner();
	if ( ! owner ) return null;
	const mode = owner.mode === 'shared' ? 'shared' : 'exclusive';
	const holders = new Set( mode === 'shared' ? owner.members.map( ( m ) => m.pid ) : [ owner.pid ] );
	const held = Number( process.env.PONLAI_GPU_LOCK_HELD );
	if ( held > 0 && holders.has( held ) && alive( held ) ) return { pid: held, mode };
	// A holder further up the process tree. The environment names only the nearest `run`, and a
	// wrapper in between need not be a member: a tool that runs each shot through its own `run`
	// (capture-growth.mjs) under an outer `run` names that inner `run`. Its child would then wait
	// for a slot of its own, which an exclusive waiter blocks while the holder waits for the child:
	// a deadlock.
	for ( let pid = process.ppid, hops = 0; pid > 1 && hops < 32; pid = parentOf( pid ), hops ++ ) {

		if ( holders.has( pid ) ) return { pid, mode };

	}
	return null;

}

// Takes the slot of a shared holder above this process over (see the header); false when that
// holder has left or handed its slot on meanwhile. Call inside the mutex.
function takeOverSlot( ancestor, label ) {

	const file = path.join( MEMBERS, `${ ancestor.pid }.json` );
	const held = readJson( file );
	if ( ! held || ! alive( ancestor.pid ) || readJson( OWNER )?.mode !== 'shared' ) return false;
	writeJson( path.join( MEMBERS, `${ process.pid }.json` ), { pid: process.pid, label, start: new Date().toISOString(), slot: held.slot, priority: PRIORITY, from: ancestor.pid } );
	rmSync( file, { force: true } );
	repairShared();
	return true;

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
	if ( ! members.some( ( m ) => m.pid === owner.pid ) ) writeJson( OWNER, { pid: members[ 0 ].pid, label: `shared: ${ members[ 0 ].label }`, start: owner.start, mode: 'shared' } );

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

// Takes the lock alone when this ticket is first in turn (queueOrder) and no older copy's exclusive
// request that asked earlier waits; the shared holders drain first. While first, its waiter file
// (which names the ticket) holds back older copies' shared requests, which do not rank exclusive
// tickets; it is withdrawn while anything ranks before this ticket (a low ticket promoted meanwhile),
// or an older copy's request ranked before it would wait for it while it waits for that request.
// Call inside the mutex.
function takeExclusive( label, ticket ) {

	const waitFile = path.join( WAITING, `${ process.pid }.json` );
	if ( ticketsAhead( ticket ) > 0 ) {

		rmSync( waitFile, { force: true } );
		return false;

	}
	const mine = Date.parse( ticket.start );
	let got = untrackedWaiters().some( ( w ) => Date.parse( w.start ) < mine ) ? false : tryAcquireExclusive( label );
	if ( got === 'shared' ) {

		// a shared lock whose named owner died while others hold it: hand it on
		repairShared();
		got = false;

	}
	if ( got ) return true;
	if ( ! readJson( waitFile ) ) {

		mkdirSync( WAITING, { recursive: true } );
		writeJson( waitFile, { pid: process.pid, label, start: ticket.start, seq: ticket.seq, priority: PRIORITY } );

	}
	return false;

}

// Joins the shared lock when a slot is free, no exclusive ticket ranks before this one (queueOrder)
// and fewer tickets that do wait than there are free slots. Call inside the mutex (an older copy's
// exclusive request does not take it, so the lock may change under us: mkdir decides).
function joinShared( label, ticket ) {

	// an exclusive request through an older copy goes first (as it always did: it has no place)
	if ( untrackedWaiters().length ) return false;
	const before = ticketsBefore( ticket );
	if ( before.some( ( t ) => t.mode === 'exclusive' ) ) return false;
	const owner = readJson( OWNER );
	if ( owner ) {

		if ( owner.mode !== 'shared' ) {

			if ( ! alive( owner.pid ) ) removeStale( owner );
			return false;

		}
		repairShared(); // it may empty and go

	} else {

		// being written, or lost
		const info = lockOwner();
		if ( info ) {

			if ( info.unknown && info.ageMs > 10000 ) removeStale( null );
			return false;

		}

	}
	// holders that joined through an older copy of this file have no slot and are not counted
	const members = readJson( OWNER ) ? sharedMembers().filter( ( m ) => m.slot !== undefined ) : [];
	const free = SLOTS - members.length;
	if ( free <= 0 || before.length >= free ) return false;
	const taken = new Set( members.map( ( m ) => m.slot ) );
	let slot = 0;
	while ( taken.has( slot ) ) slot ++;
	const me = { pid: process.pid, label, start: new Date().toISOString(), slot, priority: PRIORITY };
	try {

		mkdirSync( LOCK_DIR );

	} catch ( error ) {

		if ( error.code !== 'EEXIST' ) throw error;
		// an exclusive holder came first (or is writing its owner.json)
		if ( readJson( OWNER )?.mode !== 'shared' ) return false;

	}
	mkdirSync( MEMBERS, { recursive: true } );
	writeJson( path.join( MEMBERS, `${ process.pid }.json` ), me );
	if ( ! readJson( OWNER ) ) writeJson( OWNER, { pid: me.pid, label: `shared: ${ label }`, start: me.start, mode: 'shared' } );
	rmSync( path.join( QUEUE, `${ process.pid }.json` ), { force: true } );
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
	rmSync( path.join( QUEUE, `${ process.pid }.json` ), { force: true } );
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

	const ancestor = depth > 0 ? null : holdingAncestor();
	if ( depth > 0 || ( ancestor && ! ( shared && ancestor.mode === 'shared' ) ) ) {

		const parentMode = depth > 0 ? heldMode : ancestor.mode;
		if ( ! shared && parentMode === 'shared' && ! quiet ) console.error( `[gpu-lock] "${ label }" wants the GPU to itself but runs under a shared lock: other probes may render meanwhile` );
		depth ++;
		return 0;

	}
	installRelease();
	const started = Date.now();
	// a shared request below a shared holder takes that holder's slot over (see the header)
	if ( ancestor && await withMutex( () => takeOverSlot( ancestor, label ) ) ) {

		depth = 1;
		heldMode = 'shared';
		return 0;

	}
	let told = 0;
	const waitFile = path.join( WAITING, `${ process.pid }.json` );
	const ticket = path.join( QUEUE, `${ process.pid }.json` );
	const mine = await withMutex( () => enqueue( label, ! shared ) );
	try {

		for ( ;; ) {

			if ( await withMutex( () => shared ? joinShared( label, mine ) : takeExclusive( label, mine ) ) ) break;
			const waited = Date.now() - started;
			if ( timeout > 0 && waited > timeout * 1000 ) {

				const owner = lockOwner();
				throw new Error( `GPU lock: still held by ${ owner?.label } (pid ${ owner?.pid }) after ${ timeout } s` );

			}
			if ( ! quiet && waited - told >= ( told === 0 ? 0 : 30000 ) ) {

				const owner = lockOwner();
				const before = ticketsBefore( mine );
				const first = untrackedWaiters()[ 0 ] ?? ( shared ? before.find( ( t ) => t.mode === 'exclusive' ) : null );
				const yielding = mine.priority === 'low' && Date.now() < Date.parse( mine.promoteAt ) ? ` (low priority: normal requests first until ${ mine.promoteAt })` : '';
				if ( first ) console.error( `[gpu-lock] waiting: "${ first.label }" (pid ${ first.pid }) wants the GPU to itself first${ before.length ? `, ${ before.length } ahead in the queue` : '' }` );
				else if ( before.length ) console.error( `[gpu-lock] waiting: ${ before.length } ahead in the queue (next "${ before[ 0 ].label }"${ before[ 0 ].mode === 'exclusive' ? ', exclusive' : '' })${ yielding }` );
				else if ( owner?.mode === 'shared' && shared ) {

					const slotted = owner.members.filter( ( m ) => m.slot !== undefined );
					console.error( `[gpu-lock] waiting for a GPU slot: ${ slotted.length } of ${ SLOTS } in use (${ slotted.map( ( m ) => `"${ m.label }"` ).join( ', ' ) })${ yielding }` );

				}
				else if ( owner ) console.error( `[gpu-lock] waiting for "${ owner.label }" (pid ${ owner.pid }, since ${ owner.start }${ owner.members?.length > 1 ? `, ${ owner.members.length } shared holders` : '' })` );
				told = waited || 1;

			}
			await new Promise( ( resolve ) => setTimeout( resolve, POLL_MS ) );

		}

	} finally {

		rmSync( ticket, { force: true } );
		rmSync( waitFile, { force: true } );

	}
	depth = 1;
	heldMode = shared ? 'shared' : 'exclusive';
	return Date.now() - started;

}

/** Runs `fn` while holding the lock (`options` as for acquireGpuLock). */
export async function withGpuLock( label, fn, options = {} ) {

	const outer = depth === 0;
	await acquireGpuLock( label, options );
	// held by this call itself, not inherited from this process or an ancestor
	const own = outer && heldMode !== null;
	try {

		return await fn();

	} finally {

		if ( own ) releaseGpuLock();
		else depth = Math.max( depth - 1, 0 );

	}

}

/** Frees the shared slot that a `run --shared` above this process still holds, when this process
 * is about to wait for something other than the GPU (a reference another process is capturing:
 * tools/parity/reference.mjs). The slot is taken over and left at once, so the orchestrators above
 * hold nothing; the captures this process starts later queue like anyone else's. Returns whether
 * a slot was freed (false: no shared holder above, or its slot already taken over). */
export async function yieldAncestorSlot( label = path.basename( process.argv[ 1 ] ?? 'node' ) ) {

	if ( depth > 0 ) return false;
	const ancestor = holdingAncestor();
	if ( ancestor?.mode !== 'shared' ) return false;
	if ( ! await withMutex( () => takeOverSlot( ancestor, label ) ) ) return false;
	heldMode = 'shared';
	depth = 1;
	releaseGpuLock();
	return true;

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
// I/O registry, so two snapshots name whatever else is rendering. ioreg lists a client's
// properties alphabetically, its "AppUsage" before its "IOUserClientCreator", so the time is
// attributed per client node (from one "+-o" line to the next): read line by line it went to the
// client listed before, and named the wrong process (another app's idle client) for a busy one.
function gpuTimes() {

	return new Promise( ( resolve ) => {

		execFile( 'ioreg', [ '-r', '-c', 'AGXDeviceUserClient', '-l', '-w', '0' ], { timeout: 5000, maxBuffer: 1 << 26 }, ( error, stdout ) => {

			if ( error ) return resolve( null );
			const times = new Map();
			let creator = null, ns = 0;
			const flush = () => {

				if ( creator ) times.set( creator, ( times.get( creator ) ?? 0 ) + ns );
				creator = null;
				ns = 0;

			};
			for ( const line of stdout.split( '\n' ) ) {

				if ( line.includes( '+-o ' ) ) { flush(); continue; }
				const c = line.match( /"IOUserClientCreator" = "pid (\d+), ([^"]*)"/ );
				if ( c ) { creator = `${ c[ 2 ] } (pid ${ c[ 1 ] })`; continue; }
				if ( line.includes( '"AppUsage"' ) ) ns += [ ...line.matchAll( /"accumulatedGPUTime"=(\d+)/g ) ].reduce( ( a, m ) => a + Number( m[ 1 ] ), 0 );

			}
			flush();
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
		// the queue in turn, low tickets past their bound marked promoted
		const now = Date.now();
		const queue = queueOrder( queued(), now )
			.map( ( t ) => t.priority === 'low' && now >= Date.parse( t.promoteAt ) ? { ...t, promoted: true } : t );
		// the exclusive requests in turn: the queue's, with an older copy's (no ticket) placed before
		// the first of them that asked later (those yield to it; earlier ones race it for the lock)
		const waiting = queue.filter( ( t ) => t.mode === 'exclusive' );
		for ( const { file, ...w } of untrackedWaiters().sort( ( a, b ) => Date.parse( a.start ) - Date.parse( b.start ) ) ) {

			const i = waiting.findIndex( ( t ) => ! t.olderCopy && Date.parse( t.start ) > Date.parse( w.start ) );
			waiting.splice( i < 0 ? waiting.length : i, 0, { ...w, olderCopy: true } );

		}
		const extra = { ...( waiting.length ? { waiting } : {} ), ...( queue.length ? { queue } : {} ) };
		if ( owner?.mode === 'shared' ) {

			const { members, ...rest } = owner;
			const holders = members.filter( ( m ) => m.slot !== undefined ), unslotted = members.filter( ( m ) => m.slot === undefined );
			console.log( JSON.stringify( { ...rest, alive: alive( owner.pid ), dir: LOCK_DIR, slots: { limit: SLOTS, used: holders.length, holders, ...( unslotted.length ? { unslotted } : {} ) }, ...extra } ) );

		} else console.log( owner ? JSON.stringify( { ...owner, alive: owner.pid ? alive( owner.pid ) : null, dir: LOCK_DIR, ...extra } ) : `free (${ LOCK_DIR }, ${ SLOTS } shared slots, this shell's class ${ PRIORITY })${ Object.keys( extra ).length ? ` ${ JSON.stringify( extra ) }` : '' }` );
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
		const child = spawn( cmd[ 0 ], cmd.slice( 1 ), { stdio: 'inherit', env: { ...process.env, PONLAI_GPU_LOCK_HELD: String( process.pid ), PONLAI_GPU_LOCK_MODE: shared ? 'shared' : 'exclusive' } } );
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
