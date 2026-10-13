// A machine-wide lock for everything that renders the scene in a browser (captures, profiles,
// GPU probes). Frame times are only meaningful one browser at a time: two pages sharing the GPU
// each measure the other's work, and parallel sessions or agents cannot see each other's browsers.
// Pixels are not: a paused capture or a probe renders the same image however busy the GPU is.
// So the lock has two modes:
//   - exclusive (the default, every timing run): one holder, nothing else rendering;
//   - shared (deterministic captures and probes): up to PONLAI_GPU_SLOTS holders together (default
//     3), none while an exclusive holder runs. Captures are GPU-bound: past 2-3 pages at once the
//     throughput stays flat and only each page's latency grows (and its loads time out), so the
//     rest queue first in, first out. A slot is held per capture (capture-clip.mjs around its clip),
//     not per set or page, so a long set and a one-view probe interleave; capture.mjs's worker leases
//     its slot over the views of a set (leaseGpuLock): it keeps it from view to view and gives it up
//     for a waiter once it has held it for its lease (20 s), so a waiter's extra delay is bounded by
//     the lease (and the view in flight), not by the set.
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
//   await leaseGpuLock( 'capture v', { shared: true, budget: 20000 } );   // kept from the last piece of work, or yielded to a waiter
//   lockState();                                                          // holders and queue in turn (job.mjs)
//
//   node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout seconds] -- <command ...>
//   node tools/gpu-lock.mjs status                 (the owner, the holders, the queue in turn with each request's eta, the exclusive requests)
//   node tools/gpu-lock.mjs eta [--shared|--exclusive] [--class low|normal] [--pid p] [--json]   (estimated start of a request made now, or of a ticket)
//   node tools/gpu-lock.mjs gpu [--seconds 3]      (the GPU's utilisation and its busiest processes, macOS)
//   node tools/gpu-lock.mjs log [--since 2h] [--by class|label] [--top 5] [--json]   (waits and holds, from the log)
//
// The lock keeps a history, so how long anyone waited is measured rather than guessed: every request,
// grant, release, timeout and abandoned request is one JSON line appended to `ponlai-gpu.lock.log.jsonl`
// next to the lock (t, ev, pid, label, mode, class, ticket, waitMs / holdMs, reason). A line is
// written whole by one append (O_APPEND), so concurrent writers never interleave, and logging never
// fails a run. Past LOG_CAP the file is renamed to `.log.1.jsonl` (one older file is kept; two writers
// rotating at the same instant may drop that older file, which only shortens the history). A release
// says why a hold ended when its holder did not end it itself: `handed` (a child took the slot over:
// the child's grant carries `from`), `yielded` (yieldAncestorSlot) or `stale` (the holder was killed
// and whoever looked next reclaimed the slot; the log line is written by the one whose unlink
// succeeded, so it is written once); `lease` marks a leased hold given up for a waiter, and a leased
// hold's release counts the pieces of work it served (`uses`). A grant of a low request past its
// bound carries `promoted`.
// Inherited holds (re-entry, a child under an exclusive holder) take nothing and log nothing.
// A waiting request prints a timestamped line every 30 s: its place in the queue, the next in
// turn, who holds the GPU and why it waits, and its estimated start when it first waits and whenever
// the estimate moves by more than a minute or a quarter.
//
// The estimated start (estimateWaits; `status` gives every queued request an `eta`, `eta` one made
// now or an existing ticket's) lets a waiting agent choose between waiting and handing its work back.
// It is an estimate, a range rather than a time. It runs the queue forward under the grant rules
// above (slots in queueOrder, exclusive tickets draining the slots, low tickets yielding until their
// promoteAt, leased holders giving up past their budget), 200 times, each hold lasting a duration
// drawn from what holds of its kind took: the label's kind (labelKind: `capture`, `capture-clip`,
// `profile-frame compare`, ...) and mode, from the log's recent releases, or from a built-in table
// (FALLBACK, p25 / median / p90 per kind) while the log has few of a kind. A current holder runs on
// for a draw longer than it has run; one older than anything drawn, for a share of its age. The
// median start over the runs is the estimate, the 10th and 90th percentiles the range. Drawn rather
// than a run with medians and one with p90s: hold times are skewed, so a queue of medians ends
// early (a sum of many holds tends to their mean, not their median) and a queue of p90s far too
// late (every hold long at once), and both errors grow with the queue. Requests made later are
// not foreseen: a normal request that asks after a low one still goes first, so a low request
// can start after its range.
//
//   import { withGpuLock, acquireGpuLock } from './gpu-lock.mjs';
//   await withGpuLock( 'profile island', async () => { ... } );           // held while fn runs
//   await acquireGpuLock( 'capture overview' );                           // held until this process exits
//   await acquireGpuLock( 'verify-sky', { shared: true } );               // shared with other probes
//   await leaseGpuLock( 'capture v', { shared: true, budget: 20000 } );   // kept from the last piece of work, or yielded to a waiter
//
//   node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout seconds] -- <command ...>
//   node tools/gpu-lock.mjs status                 (the owner, the holders, the queue in turn with each request's eta, the exclusive requests)
//   node tools/gpu-lock.mjs eta [--shared|--exclusive] [--class low|normal] [--pid p] [--json]   (estimated start of a request made now, or of a ticket)
//   node tools/gpu-lock.mjs gpu [--seconds 3]      (the GPU's utilisation and its busiest processes, macOS)
//   node tools/gpu-lock.mjs log [--since 2h] [--by class|label] [--top 5] [--json]   (waits and holds, from the log)
//
// The lock keeps a history, so how long anyone waited is measured rather than guessed: every request,
// grant, release, timeout and abandoned request is one JSON line appended to `ponlai-gpu.lock.log.jsonl`
// next to the lock (t, ev, pid, label, mode, class, ticket, waitMs / holdMs, reason). A line is
// written whole by one append (O_APPEND), so concurrent writers never interleave, and logging never
// fails a run. Past LOG_CAP the file is renamed to `.log.1.jsonl` (one older file is kept; two writers
// rotating at the same instant may drop that older file, which only shortens the history). A release
// says why a hold ended when its holder did not end it itself: `handed` (a child took the slot over:
// the child's grant carries `from`), `yielded` (yieldAncestorSlot) or `stale` (the holder was killed
// and whoever looked next reclaimed the slot; the log line is written by the one whose unlink
// succeeded, so it is written once); `lease` marks a leased hold given up for a waiter, and a leased
// hold's release counts the pieces of work it served (`uses`). A grant of a low request past its
// bound carries `promoted`.
// Inherited holds (re-entry, a child under an exclusive holder) take nothing and log nothing.
// A waiting request prints a timestamped line every 30 s: its place in the queue, the next in
// turn, who holds the GPU and why it waits, and its estimated start when it first waits and whenever
// the estimate moves by more than a minute or a quarter.
//
// The estimated start (estimateWaits; `status` gives every queued request an `eta`, `eta` one made
// now or an existing ticket's) lets a waiting agent choose between waiting and handing its work back.
// It is an estimate, a range rather than a time. It runs the queue forward under the grant rules
// above (slots in queueOrder, exclusive tickets draining the slots, low tickets yielding until their
// promoteAt, leased holders giving up within their budget), each hold lasting what holds of its kind
// took: the label's kind (labelKind: `capture`, `capture-clip`, `profile-frame compare`, ...) and mode,
// p25 / median / p90 over the log's recent releases, or a built-in table (FALLBACK) for kinds the log
// has few of. A current holder runs to its next quantile past its elapsed time, and one older than
// p90 on in proportion to its age. Three runs, with the p25, median and p90 durations, give the range
// and the median start. Requests made later are not foreseen: a normal request that asks after a low
// one still goes first, so a low request's estimate is the earliest it could start.
// `log` summarises the window: waits (grants that queued, not take-overs) and holds per class or
// label, median, p95 and total, and the longest waits with who held the GPU meanwhile.
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
//
// Importing this module raises the process to the application scheduling policy on macOS
// (tools/qos.mjs: agent-started processes otherwise starve on a busy machine), so every tool that
// takes the lock does; `run` starts its command with that policy too.
import { appPolicy } from './qos.mjs'; // first: every tool that takes the lock runs with the application policy
import { appendFileSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync, statSync } from 'node:fs';
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
const LOG = `${ LOCK_DIR }.log.jsonl`;
const LOG_OLD = `${ LOCK_DIR }.log.1.jsonl`;
const LOG_CAP = 4 << 20; // ~20k events, days of busy use
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
let pending = null; // this process's request while it waits: { label, mode, ticket, at }
let holding = null; // this process's own hold while it lasts: { label, mode, ticket, at }
let leasing = 0; // the budget (ms) of the leaseGpuLock request under way, recorded on its hold for the estimate

// One event on the log (see the header). Never throws.
function logEvent( event ) {

	try {

		let size = 0;
		try { size = statSync( LOG ).size; } catch { /* the first event */ }
		if ( size > LOG_CAP ) {

			const aside = `${ LOG }.${ process.pid }.rot`;
			try { renameSync( LOG, aside ); renameSync( aside, LOG_OLD ); } catch { /* another writer rotated it */ }

		}
		appendFileSync( LOG, JSON.stringify( { t: new Date().toISOString(), ...event } ) + '\n' );

	} catch { /* the log is a record, never a reason to fail a run */ }

}
const since = ( iso ) => Math.max( 0, Date.now() - Date.parse( iso ) ) || 0;
// true for the one caller whose unlink removed the file (so a reclaim is logged once)
function unlinkOnce( file ) {

	try { unlinkSync( file ); return true; } catch { return false; }

}
const clock = ( date = new Date() ) => date.toTimeString().slice( 0, 8 );

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
		if ( unlinkOnce( m.file ) ) logEvent( { ev: 'release', reason: 'stale', pid: m.pid, label: m.label, mode: 'shared', class: m.priority, ticket: m.seq, holdMs: since( m.start ) } );
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
		if ( unlinkOnce( t.file ) ) logEvent( { ev: 'abandon', reason: 'stale', pid: t.pid, label: t.label, mode: t.mode ?? 'shared', class: t.priority, ticket: t.seq, waitMs: since( t.start ) } );
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
function takeOverSlot( ancestor, label, reason = 'handed' ) {

	const file = path.join( MEMBERS, `${ ancestor.pid }.json` );
	const held = readJson( file );
	if ( ! held || ! alive( ancestor.pid ) || readJson( OWNER )?.mode !== 'shared' ) return false;
	writeJson( path.join( MEMBERS, `${ process.pid }.json` ), { pid: process.pid, label, start: new Date().toISOString(), slot: held.slot, priority: PRIORITY, from: ancestor.pid } );
	rmSync( file, { force: true } );
	logEvent( { ev: 'release', reason, pid: ancestor.pid, label: held.label, mode: 'shared', class: held.priority, ticket: held.seq, holdMs: since( held.start ), to: process.pid } );
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
	if ( moved ) logEvent( { ev: 'release', reason: 'stale', pid: moved.pid, label: moved.label, mode: moved.mode ?? 'exclusive', class: moved.priority, ticket: moved.seq, holdMs: since( moved.start ) } );
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

function tryAcquireExclusive( label, seq ) {

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
	writeFileSync( OWNER, JSON.stringify( { pid: process.pid, label, start: new Date().toISOString(), mode: 'exclusive', seq, priority: PRIORITY, ...( leasing ? { lease: leasing / 1000 } : {} ) } ) );
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
	let got = untrackedWaiters().some( ( w ) => Date.parse( w.start ) < mine ) ? false : tryAcquireExclusive( label, ticket.seq );
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
	const me = { pid: process.pid, label, start: new Date().toISOString(), slot, priority: PRIORITY, seq: ticket.seq, ...( leasing ? { lease: leasing / 1000 } : {} ) };
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

// false when this process held no slot any more (a child took it over)
function leaveShared() {

	return withMutexSync( () => {

		const left = unlinkOnce( path.join( MEMBERS, `${ process.pid }.json` ) );
		repairShared();
		return left;

	} );

}
const logRelease = ( hold, reason ) => logEvent( { ev: 'release', ...( reason ? { reason } : {} ), pid: process.pid, label: hold.label, mode: hold.mode, class: PRIORITY, ticket: hold.ticket, holdMs: Date.now() - hold.at,
	...( hold.uses > 1 ? { uses: hold.uses } : {} ) } );

/** Releases the lock if this process holds it. */
export function releaseGpuLock() {

	release();

}

// (`reason` only for the log: 'lease' when leaseGpuLock gives the hold up for a waiter)
function release( reason ) {

	depth = 0;
	rmSync( path.join( WAITING, `${ process.pid }.json` ), { force: true } );
	rmSync( path.join( QUEUE, `${ process.pid }.json` ), { force: true } );
	if ( pending ) {

		logEvent( { ev: 'abandon', reason: 'exit', pid: process.pid, label: pending.label, mode: pending.mode, class: PRIORITY, ticket: pending.ticket, waitMs: Date.now() - pending.at } );
		pending = null;

	}
	const hold = holding;
	holding = null;
	if ( heldMode === 'shared' ) {

		heldMode = null;
		if ( leaveShared() && hold ) logRelease( hold, reason );
		return;

	}
	heldMode = null;
	const owner = readJson( OWNER );
	if ( owner && owner.pid === process.pid && owner.mode !== 'shared' ) {

		rmSync( LOCK_DIR, { recursive: true, force: true } );
		if ( hold ) logRelease( hold, reason );

	}

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
		holding = { label, mode: 'shared', at: Date.now() };
		logEvent( { ev: 'grant', pid: process.pid, label, mode: 'shared', class: PRIORITY, waitMs: 0, from: ancestor.pid } );
		return 0;

	}
	let told = 0;
	let toldEta = null; // the estimate last printed, and the wait when it was
	const waitFile = path.join( WAITING, `${ process.pid }.json` );
	const ticket = path.join( QUEUE, `${ process.pid }.json` );
	const mine = await withMutex( () => enqueue( label, ! shared ) );
	const mode = shared ? 'shared' : 'exclusive';
	pending = { label, mode, ticket: mine.seq, at: started };
	logEvent( { ev: 'request', pid: process.pid, label, mode, class: PRIORITY, ticket: mine.seq } );
	try {

		for ( ;; ) {

			if ( await withMutex( () => shared ? joinShared( label, mine ) : takeExclusive( label, mine ) ) ) break;
			const waited = Date.now() - started;
			if ( timeout > 0 && waited > timeout * 1000 ) {

				const owner = lockOwner();
				pending = null;
				logEvent( { ev: 'timeout', pid: process.pid, label, mode, class: PRIORITY, ticket: mine.seq, waitMs: waited } );
				throw new Error( `GPU lock: still held by ${ owner?.label } (pid ${ owner?.pid }) after ${ timeout } s` );

			}
			if ( ! quiet && waited - told >= ( told === 0 ? 0 : 30000 ) ) {

				// one line: the time, the place in the queue, who holds the GPU and why this waits
				const owner = lockOwner();
				const before = ticketsBefore( mine );
				const total = queued().length;
				const first = untrackedWaiters()[ 0 ] ?? ( shared ? before.find( ( t ) => t.mode === 'exclusive' ) : null );
				const next = before.length ? `, next "${ before[ 0 ].label }"${ before[ 0 ].mode === 'exclusive' ? ' (exclusive)' : '' }` : '';
				let held = 'nobody (taking it)';
				if ( owner?.mode === 'shared' ) {

					const slotted = owner.members.filter( ( m ) => m.slot !== undefined );
					held = `${ slotted.length } of ${ SLOTS } shared slots (${ slotted.map( ( m ) => `"${ m.label }"` ).join( ', ' ) })`;

				} else if ( owner ) held = `"${ owner.label }" (pid ${ owner.pid }, exclusive since ${ clock( new Date( owner.start ) ) })`;
				const why = first ? `; "${ first.label }" (pid ${ first.pid }) wants the GPU to itself first`
					: mine.priority === 'low' && Date.now() < Date.parse( mine.promoteAt ) ? `; low priority: normal requests first until ${ clock( new Date( mine.promoteAt ) ) }` : '';
				// the estimated start, when it is new or has moved by more than a minute or a quarter
				const eta = estimateWaits( { logged: recentDurations() } ).queue.find( ( t ) => t.pid === process.pid )?.eta;
				const moved = eta && eta.startIn !== null && ( toldEta === null || Math.abs( eta.startIn - ( toldEta.startIn - ( waited - toldEta.at ) / 1000 ) ) > Math.max( 60, 0.25 * toldEta.startIn ) );
				if ( moved ) toldEta = { ...eta, at: waited };
				const estimate = moved ? `; estimated start in ${ etaText( eta ) }` : '';
				console.error( `[gpu-lock ${ clock() }] waiting (${ mode }${ PRIORITY === 'low' ? ', low' : '' }) ${ Math.round( waited / 1000 ) } s: ${ before.length + 1 } of ${ Math.max( total, before.length + 1 ) } in the queue${ next }; held by ${ held }${ why }${ estimate }` );
				told = waited || 1;

			}
			await new Promise( ( resolve ) => setTimeout( resolve, POLL_MS ) );

		}

	} finally {

		rmSync( ticket, { force: true } );
		rmSync( waitFile, { force: true } );

	}
	depth = 1;
	heldMode = mode;
	pending = null;
	holding = { label, mode, ticket: mine.seq, at: Date.now() };
	logEvent( { ev: 'grant', pid: process.pid, label, mode, class: PRIORITY, ticket: mine.seq, waitMs: Date.now() - started,
		...( mine.priority === 'low' && Date.now() >= Date.parse( mine.promoteAt ) ? { promoted: true } : {} ) } );
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

/** The waiting request that this process's own hold keeps waiting, the first in turn, or null: one
 * that would be served before this process if it gave the hold up now and asked again at once. That
 * is an exclusive request (it waits for every shared slot to drain, and ranks before any new
 * request), an older copy's exclusive request, or, when every shared slot is taken, a shared request
 * that ranks before a new one of this process (a normal request ahead of a low holder, any request
 * ahead of a normal one; a low request ranks after a normal holder's new request until its bound).
 * Null while this process holds nothing itself (an inherited hold included). */
function gpuLockWaiter() {

	if ( ! holding ) return null;
	const untracked = untrackedWaiters()[ 0 ];
	if ( untracked ) return { ...untracked, mode: 'exclusive' };
	const now = Date.now();
	const priority = holding.mode === 'exclusive' ? 'normal' : PRIORITY;
	const again = { pid: process.pid, seq: Infinity, priority, ...( priority === 'low' ? { promoteAt: new Date( now + LOW_MAX_WAIT * 1000 ).toISOString() } : {} ) };
	const order = queueOrder( [ ...queued().filter( ( t ) => t.pid !== process.pid ), again ], now );
	const before = order.slice( 0, order.indexOf( again ) );
	const exclusive = before.find( ( t ) => t.mode === 'exclusive' );
	if ( exclusive || before.length === 0 || holding.mode === 'exclusive' ) return exclusive ?? before[ 0 ] ?? null;
	const slotted = readJson( OWNER )?.mode === 'shared' ? sharedMembers().filter( ( m ) => m.slot !== undefined ).length : 0;
	return slotted >= SLOTS ? before[ 0 ] : null;

}

/** A hold kept from one piece of work to the next (capture.mjs's views): call it before each piece
 * instead of acquireGpuLock, and releaseGpuLock() after the last. This process keeps the hold it
 * already has (same mode) while nobody waits for it (gpuLockWaiter), or while it has held it for less
 * than `budget` ms; otherwise it gives the hold up (logged as `reason: 'lease'`) and queues again
 * like any request. A waiter's extra delay is therefore at most the budget plus the piece in flight
 * when it runs out, however long the series of pieces. A low holder gives its slot up for a normal
 * shared request at once, budget or not, as it would between per-piece holds: low work never keeps
 * a session's interactive captures and probes waiting longer than before (exclusive requests ignore
 * the class, so they get the budget). Without a hold of its own (or in another mode) it simply
 * acquires. The release that ends a hold logs how many pieces it served (`uses`).
 * Returns { waitMs, kept }: the wait for the lock, and whether the hold was kept. */
export async function leaseGpuLock( label, { shared = false, budget = 0, ...options } = {} ) {

	if ( holding && heldMode === ( shared ? 'shared' : 'exclusive' ) ) {

		const waiter = gpuLockWaiter();
		const yieldNow = waiter && ( Date.now() - holding.at >= budget ||
			( heldMode === 'shared' && PRIORITY === 'low' && waiter.mode !== 'exclusive' && waiter.priority === 'normal' ) );
		if ( ! yieldNow ) {

			holding.uses = ( holding.uses ?? 1 ) + 1;
			return { waitMs: 0, kept: true };

		}
		release( 'lease' );

	} else if ( holding ) release();
	leasing = budget;
	try {

		return { waitMs: await acquireGpuLock( label, { shared, ...options } ), kept: false };

	} finally {

		leasing = 0;

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
	if ( ! await withMutex( () => takeOverSlot( ancestor, label, 'yielded' ) ) ) return false;
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

			log( `[gpu-lock] the GPU is still ${ sample.mean } % busy after ${ Math.round( waited / 1000 ) } s${ who }: contended` );
			return { idle: sample, contended: true, waitedMs: waited, samples: history, clients };

		}
		if ( history.length === 1 ) log( `[gpu-lock] the GPU is ${ sample.mean } % busy (max ${ sample.max } %) with no locked run${ who }; waiting up to ${ wait } s` );

	}

}

// ------------------------------------------------------------------ estimated wait

// How long holds of a kind of work take, in ms (p25, median, p90), for kinds the log has too few of
// (fewer than MIN_LOGGED releases). From 2026-10-11..13, before the log existed: the grant times and
// the next sightings of holders in the `gpu-lock status` outputs that sessions printed, and the run
// reports of the aa and island sessions (a view 5-7 s alone, 20 s leases, clips about a minute, a
// profile with --accept 7-8 min, a compare 11-17 min). A capture hold is one view, or several under
// capture.mjs's lease (its 20 s budget plus the view in flight); a capture-clip is one clip;
// profile-frame's exclusive holds are whole runs (--accept is labelled `profile` too and sits at its
// long end), its shared holds the preload before them; `node` is a script under `run`.
const FALLBACK = {
	'capture shared': [ 6e3, 12e3, 45e3 ],
	'capture exclusive': [ 10e3, 20e3, 60e3 ],
	'capture-clip shared': [ 15e3, 30e3, 120e3 ],
	'probe shared': [ 15e3, 45e3, 120e3 ],
	'verify shared': [ 60e3, 180e3, 450e3 ],
	'node shared': [ 30e3, 120e3, 420e3 ],
	'node exclusive': [ 120e3, 300e3, 900e3 ],
	'profile-frame shared': [ 10e3, 20e3, 60e3 ],
	'profile-frame profile exclusive': [ 180e3, 320e3, 600e3 ],
	'profile-frame compare exclusive': [ 180e3, 450e3, 950e3 ],
	'profile-frame toggle exclusive': [ 300e3, 500e3, 900e3 ],
	'profile-frame exclusive': [ 60e3, 200e3, 700e3 ],
	'shared': [ 10e3, 30e3, 150e3 ],
	'exclusive': [ 120e3, 300e3, 900e3 ],
};
const MIN_LOGGED = 5; // releases of a kind before the log's own holds replace the table
const LOG_RECENT = 100; // the most recent releases per kind that count
const PIECE = [ 3e3, 6e3, 20e3 ]; // one piece of leased work (a capture view), until the log has leased holds of the kind

/** A label's kind: the label without its run-specific tail, so that holds of the same work group
 * together. The first word names the tool (`capture island-fair-noon` -> `capture`, `capture-clip
 * baseline-...` -> `capture-clip`, `verify-scene-jump fresh` -> `verify-scene-jump`); a script run
 * through node or a shell is named by its file (`node tools/parity/capture-set.mjs ...` -> `node
 * capture-set`); profile-frame keeps its mode (`profile-frame compare-2026-...` -> `profile-frame
 * compare`, a custom --label -> `profile-frame`). Timestamps, hashes and numbers are dropped. */
export function labelKind( label = '' ) {

	const clean = String( label ).replace( /^shared: /, '' ).replace( /\d{4}-\d\d-\d\dT[\d:.-]+Z?/g, '' ).trim();
	const [ first = '', ...rest ] = clean.split( /\s+/ );
	if ( /^(node|bash|sh|zsh)$/.test( first ) ) {

		const script = rest.find( ( w ) => ! w.startsWith( '-' ) );
		return script ? `node ${ path.basename( script ).replace( /\.(m?js|sh)$/, '' ) }` : first;

	}
	if ( first === 'profile-frame' ) {

		const mode = /^(profile|compare|toggle)-?$/.exec( rest[ 0 ] ?? '' );
		return mode ? `profile-frame ${ mode[ 1 ] }` : 'profile-frame';

	}
	return first.replace( /\b[0-9a-f]{7,40}\b/g, '' ).replace( /[-_.]*\d+$/, '' ) || '?';

}

/** Hold durations per kind and mode from the log's releases: Map( 'kind mode' -> { n, holds, pieces? } ),
 * the LOG_RECENT most recent holds of each (ms); `pieces` the pieces of leased work (holdMs / uses
 * over leased holds that served several), when there are enough. Holds a child took over or that
 * were yielded (an orchestrator's share before it handed on) say nothing about the work and are left
 * out. */
export function lockDurations( events = readLockLog() ) {

	const groups = new Map();
	for ( const e of events ) {

		if ( e.ev !== 'release' || ! Number.isFinite( e.holdMs ) || e.reason === 'handed' || e.reason === 'yielded' ) continue;
		const key = `${ labelKind( e.label ) } ${ e.mode === 'exclusive' ? 'exclusive' : 'shared' }`;
		if ( ! groups.has( key ) ) groups.set( key, { holds: [], pieces: [] } );
		groups.get( key ).holds.push( e.holdMs );
		if ( e.uses > 1 ) groups.get( key ).pieces.push( e.holdMs / e.uses );

	}
	const table = new Map();
	for ( const [ key, g ] of groups ) {

		const holds = g.holds.slice( - LOG_RECENT ), pieces = g.pieces.slice( - LOG_RECENT );
		table.set( key, { n: holds.length, holds, ...( pieces.length >= MIN_LOGGED ? { pieces } : {} ) } );

	}
	return table;

}

// A duration drawn from p25 / median / p90: a log-normal through the median, its spread below the
// median from p25 and above it from p90 (hold times are skewed: most short, a few long).
function drawQuantiles( [ p25, p50, p90 ], rand ) {

	const u = Math.min( Math.max( rand(), 1e-6 ), 1 - 1e-6 );
	// the standard normal quantile of u, near enough (the logistic distribution scaled to match it)
	const z = Math.log( u / ( 1 - u ) ) / 1.702;
	return p50 * Math.exp( z * ( z < 0 ? Math.log( p50 / p25 ) / 0.6745 : Math.log( p90 / p50 ) / 1.2816 ) );

}

// How long a hold of `label` in `mode` lasts, as something to draw from: the log's recent holds of
// the kind when it has MIN_LOGGED of them (drawn as they came), else the table's quantiles (the
// kind's, its tool's, or its mode's). { basis: 'log' | 'table' | 'default', hold( rand ), piece( rand ) }.
function durationOf( label, mode, logged ) {

	const kind = labelKind( label );
	const m = mode === 'exclusive' ? 'exclusive' : 'shared';
	const own = logged.get( `${ kind } ${ m }` );
	const piece = own?.pieces ? ( rand ) => own.pieces[ Math.floor( rand() * own.pieces.length ) ] : ( rand ) => drawQuantiles( PIECE, rand );
	if ( own && own.n >= MIN_LOGGED ) return { basis: 'log', hold: ( rand ) => own.holds[ Math.floor( rand() * own.holds.length ) ], piece };
	const tool = kind.split( ' ' )[ 0 ].replace( /^verify-.*/, 'verify' );
	const row = FALLBACK[ `${ kind } ${ m }` ] ?? FALLBACK[ `${ tool } ${ m }` ] ?? FALLBACK[ m ];
	return { basis: FALLBACK[ `${ kind } ${ m }` ] || FALLBACK[ `${ tool } ${ m }` ] ? 'table' : 'default', hold: ( rand ) => drawQuantiles( row, rand ), piece };

}

/** The lock's state as the estimate needs it: { holders: [ { pid, label, mode, start, lease? } ],
 * queue: [ tickets ], untracked: [ older copies' exclusive waiters ] }. */
export function lockState() {

	const owner = lockOwner();
	let holders = [];
	if ( owner?.mode === 'shared' ) holders = owner.members.filter( ( m ) => m.slot !== undefined ).map( ( m ) => ( { ...m, mode: 'shared' } ) );
	else if ( owner && ! owner.unknown ) holders = [ { ...owner, mode: 'exclusive' } ];
	return { holders, queue: queued(), untracked: untrackedWaiters().map( ( { file, ...w } ) => w ) };

}

// One run of the queue forward in time under the lock's grant rules, every hold lasting a duration
// drawn for it (durationOf): Map( pid -> start time ). A current holder runs on for a duration drawn
// longer than it has already run; one older than anything drawn (work the table does not know, an
// own script, a hung page) is expected to run on for a share of its age, so a hold of a quarter of an
// hour is not taken to end within seconds at every look. Free slots go to the tickets in queueOrder at
// each moment (low tickets rank as normal ones from their promoteAt on), an exclusive ticket first in
// turn waits for every holder to leave and blocks the tickets after it, a shared one joins while
// slots are free; a leased holder gives its hold up at the first piece boundary past its budget once a
// waiter would be served before it (gpuLockWaiter's rule). Nothing that asks later is foreseen.
function simulateQueue( state, logged, rand, now, slots ) {

	const holders = state.holders.map( ( h ) => {

		const d = durationOf( h.label, h.mode, logged );
		const start = Date.parse( h.start ) || now;
		const elapsed = now - start;
		let left = 0;
		for ( let i = 0; i < 30 && left <= 0; i ++ ) left = d.hold( rand ) - elapsed;
		if ( left <= 0 ) left = Math.max( 5000, ( 0.05 + 0.45 * rand() ) * elapsed );
		return { pid: h.pid, mode: h.mode, priority: h.priority ?? 'normal', start, lease: h.lease, piece: d.piece, end: now + left };

	} );
	// an older copy's exclusive request goes before every ticket (it blocks every shared join)
	const waiting = [ ...state.untracked.map( ( w, i ) => ( { ...w, mode: 'exclusive', priority: 'normal', seq: - 1 - i } ) ), ...state.queue ];
	const starts = new Map();
	const grant = ( ticket, mode, t ) => {

		holders.push( { pid: ticket.pid, mode, priority: ticket.priority ?? 'normal', start: t, end: t + durationOf( ticket.label, mode, logged ).hold( rand ) } );
		starts.set( ticket.pid, t );
		waiting.splice( waiting.indexOf( ticket ), 1 );

	};
	let t = now;
	for ( let step = 0; waiting.length && step < 100000; step ++ ) {

		for ( let i = holders.length - 1; i >= 0; i -- ) if ( holders[ i ].end <= t ) holders.splice( i, 1 );
		const order = queueOrder( waiting, t );
		const exclusiveHeld = holders.some( ( h ) => h.mode === 'exclusive' );
		let free = exclusiveHeld ? 0 : slots - holders.length;
		for ( const ticket of order ) {

			if ( ticket.mode === 'exclusive' ) {

				if ( holders.length === 0 ) grant( ticket, 'exclusive', t );
				break;

			}
			if ( free <= 0 ) break;
			grant( ticket, 'shared', t );
			free --;

		}
		if ( ! waiting.length ) break;
		// leased holders yield to a waiter served before their next request
		const next = queueOrder( waiting, t );
		const full = ! exclusiveHeld && holders.length >= slots;
		for ( const h of holders ) {

			if ( ! h.lease || h.yields ) continue;
			const again = { pid: h.pid, seq: Infinity, priority: h.mode === 'exclusive' ? 'normal' : h.priority, promoteAt: new Date( t + LOW_MAX_WAIT * 1000 ).toISOString() };
			const order = queueOrder( [ ...next, again ], t );
			const before = order.slice( 0, order.indexOf( again ) );
			const waiter = before.some( ( w ) => w.mode === 'exclusive' ) || ( h.mode === 'exclusive' ? before.length > 0 : full && before.length > 0 );
			if ( ! waiter ) continue;
			const lowYield = h.mode === 'shared' && h.priority === 'low' && before[ 0 ]?.mode !== 'exclusive' && before[ 0 ]?.priority === 'normal';
			h.end = Math.min( h.end, ( lowYield ? t : Math.max( t, h.start + h.lease * 1000 ) ) + rand() * h.piece( rand ) );
			h.yields = true;

		}
		// the next moment anything changes: a hold ends or a low ticket stops yielding
		let at = Math.min( ...holders.map( ( h ) => h.end ) );
		for ( const w of waiting ) {

			const promote = w.priority === 'low' ? Date.parse( w.promoteAt ) : NaN;
			if ( promote > t && promote < at ) at = promote;

		}
		if ( ! Number.isFinite( at ) ) break; // nothing held and nothing granted: an older copy's own rules decide
		t = Math.max( at, t + 1 );

	}
	return starts;

}

const RUNS = 200; // simulated futures per estimate
// a small seeded generator (mulberry32), so the same queue gives the same estimate at every look
function seeded( seed ) {

	return () => {

		seed = ( seed + 0x6d2b79f5 ) | 0;
		let x = Math.imul( seed ^ ( seed >>> 15 ), 1 | seed );
		x = ( x + Math.imul( x ^ ( x >>> 7 ), 61 | x ) ) ^ x;
		return ( ( x ^ ( x >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

/** Estimated waits, in seconds from now, for every queued request (and, given `request` { mode:
 * 'shared' | 'exclusive', priority: 'low' | 'normal', label }, for one made now): the queue simulated
 * RUNS times, each hold's duration drawn anew (simulateQueue). Returns { now, queue: [ { pid, seq,
 * label, mode, priority, eta } ], request?: eta }, eta = { startIn, range: [ lo, hi ], basis }: the
 * median start over the runs, the 10th and 90th percentiles, and where the durations of the holds
 * ahead came from (the log, the built-in table, a default per mode). Every number is an estimate:
 * holds vary, and requests made later (a normal one ahead of a low one) are not foreseen.
 * `state`, `logged` and `now` may be given (replays, tests); they default to the lock's own. */
export function estimateWaits( { state = lockState(), logged = lockDurations(), now = Date.now(), slots = SLOTS, request = null } = {} ) {

	const queue = state.queue.map( ( t ) => ( { ...t } ) );
	let mine = null;
	if ( request ) {

		const exclusive = request.mode === 'exclusive';
		const priority = exclusive ? 'normal' : request.priority ?? PRIORITY;
		mine = { pid: - 1, label: request.label ?? '(this request)', seq: Math.max( 0, ...queue.map( ( t ) => t.seq ) ) + 1, start: new Date( now ).toISOString(), priority,
			...( exclusive ? { mode: 'exclusive' } : {} ), ...( priority === 'low' ? { promoteAt: new Date( now + LOW_MAX_WAIT * 1000 ).toISOString() } : {} ) };
		queue.push( mine );

	}
	const full = { ...state, queue };
	const rand = seeded( 0x9e3779b9 );
	const starts = new Map( queue.map( ( t ) => [ t.pid, [] ] ) );
	for ( let run = 0; run < RUNS; run ++ ) for ( const [ pid, at ] of simulateQueue( full, logged, rand, now, slots ) ) starts.get( pid ).push( at );
	// where the durations came from: the holders' and every ticket's ahead
	const sources = state.holders.map( ( h ) => durationOf( h.label, h.mode, logged ).basis );
	const ahead = queueOrder( queue, now );
	const eta = ( ticket, index ) => {

		const basis = {};
		for ( const b of [ ...sources, ...ahead.slice( 0, index ).map( ( t ) => durationOf( t.label, t.mode, logged ).basis ) ] ) basis[ b ] = ( basis[ b ] ?? 0 ) + 1;
		const all = starts.get( ticket.pid ).sort( ( a, b ) => a - b );
		if ( ! all.length ) return { startIn: null, range: [ null, null ], basis };
		const s = ( q ) => Math.round( ( quantile( all, q ) - now ) / 1000 );
		return { startIn: s( 0.5 ), range: [ s( 0.1 ), s( 0.9 ) ], basis };

	};
	const out = ahead.map( ( t, i ) => ( { pid: t.pid, seq: t.seq, label: t.label, mode: t.mode ?? 'shared', priority: t.priority, eta: eta( t, i ) } ) );
	const result = { now: new Date( now ).toISOString(), queue: out.filter( ( t ) => t.pid !== - 1 ) };
	if ( mine ) result.request = out.find( ( t ) => t.pid === - 1 ).eta;
	return result;

}

// the log's durations, read again every few minutes by a waiting process (the log may hold 20k events)
let durationsCache = null;
function recentDurations() {

	if ( ! durationsCache || Date.now() - durationsCache.at > 300000 ) durationsCache = { at: Date.now(), logged: lockDurations() };
	return durationsCache.logged;

}

// "~12 min (range 8-20 min, estimate)"
function etaText( eta ) {

	if ( ! eta || eta.startIn === null ) return 'unknown (estimate)';
	const m = ( s ) => s < 90 ? `${ Math.max( 0, s ) } s` : `${ Math.round( s / 60 ) } min`;
	const [ lo, hi ] = eta.range;
	return `~${ m( eta.startIn ) } (range ${ m( lo ) }-${ hi === null ? '?' : m( hi ) }, estimate)`;

}

// ------------------------------------------------------------------ CLI

/** The log's events, oldest first (the rotated file, then the current one). */
export function readLockLog() {

	const events = [];
	for ( const file of [ LOG_OLD, LOG ] ) {

		let text = '';
		try { text = readFileSync( file, 'utf8' ); } catch { continue; }
		for ( const line of text.split( '\n' ) ) {

			if ( ! line ) continue;
			try { events.push( JSON.parse( line ) ); } catch { /* a line cut short by a full disk */ }

		}

	}
	return events;

}

const quantile = ( sorted, q ) => sorted.length ? sorted[ Math.min( sorted.length - 1, Math.ceil( q * sorted.length ) - 1 ) ] : null;
const stats = ( values ) => {

	const sorted = values.filter( Number.isFinite ).sort( ( a, b ) => a - b );
	return { n: sorted.length, median: quantile( sorted, 0.5 ), p95: quantile( sorted, 0.95 ), total: sorted.reduce( ( a, b ) => a + b, 0 ) };

};

/** Waits and holds per group ('class': mode and class, or 'label') and the `top` longest waits,
 * each with the holds that overlapped it (who held the GPU meanwhile, longest overlap first). */
export function summariseLockLog( events, { by = 'class', top = 5, now = Date.now() } = {} ) {

	const key = ( e ) => by === 'label' ? e.label ?? '?' : `${ e.mode ?? '?' } ${ e.class ?? '?' }`;
	const groups = new Map();
	const holds = []; // { pid, label, mode, start, end, open }
	const open = new Map(); // pid -> its grant without a release yet
	for ( const e of events ) {

		const k = key( e );
		if ( ! groups.has( k ) ) groups.set( k, { requests: 0, waits: [], holds: [], takeovers: 0, timeouts: 0, abandoned: 0, stale: 0, leases: 0, uses: 0 } );
		const g = groups.get( k );
		const t = Date.parse( e.t );
		if ( e.ev === 'request' ) g.requests ++;
		else if ( e.ev === 'grant' ) {

			if ( e.from ) g.takeovers ++;
			else g.waits.push( e.waitMs );
			open.set( e.pid, e );

		} else if ( e.ev === 'release' ) {

			g.holds.push( e.holdMs );
			if ( e.reason === 'stale' ) g.stale ++;
			if ( e.reason === 'lease' ) g.leases ++;
			g.uses += e.uses ?? 1;
			holds.push( { pid: e.pid, label: e.label, mode: e.mode, start: t - e.holdMs, end: t } );
			open.delete( e.pid );

		} else if ( e.ev === 'timeout' ) g.timeouts ++;
		else if ( e.ev === 'abandon' ) g.abandoned ++;

	}
	for ( const e of open.values() ) holds.push( { pid: e.pid, label: e.label, mode: e.mode, start: Date.parse( e.t ), end: now, open: true } );
	const longest = events.filter( ( e ) => e.ev === 'grant' && ! e.from && e.waitMs > 0 )
		.sort( ( a, b ) => b.waitMs - a.waitMs ).slice( 0, top ).map( ( e ) => {

			const end = Date.parse( e.t ), start = end - e.waitMs;
			const holders = holds.filter( ( h ) => h.pid !== e.pid && h.start < end && h.end > start )
				.map( ( h ) => ( { label: h.label, mode: h.mode, pid: h.pid, overlapMs: Math.min( end, h.end ) - Math.max( start, h.start ), ...( h.open ? { open: true } : {} ) } ) )
				.sort( ( a, b ) => b.overlapMs - a.overlapMs );
			return { t: e.t, label: e.label, mode: e.mode, class: e.class, waitMs: e.waitMs, holders };

		} );
	const rows = [ ...groups ].map( ( [ group, g ] ) => ( { group, requests: g.requests, wait: stats( g.waits ), hold: stats( g.holds ), takeovers: g.takeovers, timeouts: g.timeouts, abandoned: g.abandoned, stale: g.stale, leases: g.leases, uses: g.uses } ) )
		.sort( ( a, b ) => b.wait.total - a.wait.total || b.hold.total - a.hold.total );
	return { events: events.length, from: events[ 0 ]?.t ?? null, to: events.at( -1 )?.t ?? null, groups: rows, longest };

}

function printLockLog( summary, { by, sinceText } ) {

	const d = ( ms ) => ms === null ? '-' : ms < 1000 ? `${ Math.round( ms ) } ms` : ms < 120000 ? `${ ( ms / 1000 ).toFixed( 1 ) } s` : ms < 7200000 ? `${ ( ms / 60000 ).toFixed( 1 ) } min` : `${ ( ms / 3600000 ).toFixed( 1 ) } h`;
	const at = ( iso ) => new Date( iso ).toLocaleString( 'sv' ).slice( 5, 19 );
	console.log( `gpu-lock log${ sinceText ? ` (last ${ sinceText })` : '' }: ${ summary.events } events${ summary.from ? `, ${ at( summary.from ) } .. ${ at( summary.to ) }` : '' } (${ LOG })` );
	if ( ! summary.events ) return;
	const cut = ( text, n ) => text.length > n ? text.slice( 0, n - 1 ) + '~' : text;
	const width = Math.min( 40, Math.max( 5, ...summary.groups.map( ( r ) => r.group.length ) ) );
	const head = [ by === 'label' ? 'label' : 'class', 'req', 'waits', 'median', 'p95', 'total', 'holds', 'median', 'p95', 'total', 'other' ];
	const table = summary.groups.map( ( r ) => [ cut( r.group, width ), r.requests, r.wait.n, d( r.wait.median ), d( r.wait.p95 ), d( r.wait.total ), r.hold.n, d( r.hold.median ), d( r.hold.p95 ), d( r.hold.total ),
		[ r.uses > r.hold.n && `${ r.uses } uses`, r.leases && `${ r.leases } lease yields`, r.takeovers && `${ r.takeovers } taken over`, r.timeouts && `${ r.timeouts } timed out`, r.abandoned && `${ r.abandoned } abandoned`, r.stale && `${ r.stale } stale` ].filter( Boolean ).join( ', ' ) ].map( String ) );
	const widths = head.map( ( h, i ) => Math.max( h.length, ...table.map( ( row ) => row[ i ].length ) ) );
	for ( const row of [ head, ...table ] ) console.log( row.map( ( c, i ) => i === 0 || i === row.length - 1 ? c.padEnd( widths[ i ] ) : c.padStart( widths[ i ] ) ).join( '  ' ).trimEnd() );
	if ( summary.longest.length ) {

		console.log( '\nlongest waits (who held the GPU meanwhile, overlap):' );
		for ( const w of summary.longest ) {

			const who = w.holders.slice( 0, 3 ).map( ( h ) => `"${ cut( h.label ?? '?', 40 ) }" ${ h.mode === 'exclusive' ? 'excl ' : '' }${ d( h.overlapMs ) }${ h.open ? ' (no release logged)' : '' }` ).join( ', ' );
			console.log( `  ${ at( w.t ) }  ${ d( w.waitMs ).padStart( 8 ) }  ${ w.mode } ${ w.class }  "${ cut( w.label ?? '?', 40 ) }"  <- ${ who || 'nobody logged' }${ w.holders.length > 3 ? `, +${ w.holders.length - 3 } more` : '' }` );

		}

	}

}

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
		// and each with its estimated start (estimateWaits)
		const etas = new Map( estimateWaits( { now } ).queue.map( ( t ) => [ t.pid, t.eta ] ) );
		const queue = queueOrder( queued(), now )
			.map( ( t ) => t.priority === 'low' && now >= Date.parse( t.promoteAt ) ? { ...t, promoted: true } : t )
			.map( ( t ) => etas.has( t.pid ) ? { ...t, eta: etas.get( t.pid ) } : t );
		// the exclusive requests in turn: the queue's, with an older copy's (no ticket) placed before
		// the first of them that asked later (those yield to it; earlier ones race it for the lock)
		const waiting = queue.filter( ( t ) => t.mode === 'exclusive' ).map( ( { eta, ...t } ) => t );
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
	if ( command === 'eta' ) {

		// a request made now (--shared / --exclusive, --class), or an existing ticket (--pid)
		const pid = Number( opt( 'pid', 0 ) );
		const flags = new Set( rest );
		const request = pid ? null : { mode: flags.has( '--exclusive' ) || ! flags.has( '--shared' ) ? 'exclusive' : 'shared', priority: opt( 'class', PRIORITY ), label: opt( 'label', undefined ) };
		if ( request && ! [ 'low', 'normal' ].includes( request.priority ) ) throw new Error( '--class takes low or normal' );
		const result = estimateWaits( { request } );
		const eta = pid ? result.queue.find( ( t ) => t.pid === pid )?.eta : result.request;
		if ( pid && ! eta ) throw new Error( `pid ${ pid } has no ticket in the queue (it holds the GPU, has not asked, or has gone)` );
		if ( flags.has( '--json' ) ) console.log( JSON.stringify( { now: result.now, ...( pid ? { pid } : { request } ), eta } ) );
		else {

			const basis = Object.entries( eta.basis ).map( ( [ k, n ] ) => `${ n } from the ${ k === 'log' ? 'log' : k === 'table' ? 'built-in table' : 'default per mode' }` ).join( ', ' );
			console.log( `${ pid ? `pid ${ pid }` : `${ request.mode === 'exclusive' ? 'an' : 'a' } ${ request.mode }${ request.mode === 'shared' ? ` ${ request.priority }` : '' } request now` }: estimated start in ${ etaText( eta ) }; ${ result.queue.length } queued, durations ${ basis || 'none needed' }` );

		}
		return 0;

	}
	if ( command === 'log' ) {

		const sinceText = opt( 'since', null );
		const by = opt( 'by', 'class' );
		if ( ! [ 'class', 'label' ].includes( by ) ) throw new Error( '--by takes class or label' );
		let events = readLockLog();
		if ( sinceText ) {

			const m = /^(\d+(?:\.\d+)?)(s|m|min|h|d)$/.exec( sinceText );
			if ( ! m ) throw new Error( '--since takes a duration such as 90s, 30m, 2h or 1d' );
			const from = Date.now() - Number( m[ 1 ] ) * { s: 1e3, m: 6e4, min: 6e4, h: 36e5, d: 864e5 }[ m[ 2 ] ];
			events = events.filter( ( e ) => Date.parse( e.t ) >= from );

		}
		const summary = summariseLockLog( events, { by, top: Number( opt( 'top', 5 ) ) } );
		if ( rest.includes( '--json' ) ) console.log( JSON.stringify( summary ) );
		else printLockLog( summary, { by, sinceText } );
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
		if ( waited > 1000 ) console.error( `[gpu-lock ${ clock() }] acquired${ shared ? ' (shared)' : '' } after ${ ( waited / 1000 ).toFixed( 1 ) } s` );
		const child = spawn( ...appPolicy( cmd[ 0 ], cmd.slice( 1 ) ), { stdio: 'inherit', env: { ...process.env, PONLAI_GPU_LOCK_HELD: String( process.pid ), PONLAI_GPU_LOCK_MODE: shared ? 'shared' : 'exclusive' } } );
		for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) {

			process.removeAllListeners( signal );
			process.on( signal, () => child.kill( signal ) );

		}
		return await new Promise( ( resolve ) => {

			child.on( 'error', ( error ) => { console.error( error.message ); resolve( 127 ); } );
			child.on( 'exit', ( code, signal ) => resolve( code ?? ( signal ? 128 + ( os.constants.signals[ signal ] ?? 0 ) : 1 ) ) );

		} );

	}
	console.error( 'usage: node tools/gpu-lock.mjs run [--shared] [--label name] [--timeout s] -- <command ...> | status | eta [--shared|--exclusive] [--class low|normal] [--pid p] [--json] | gpu [--seconds n] | log [--since 2h] [--by class|label] [--top n] [--json]' );
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
