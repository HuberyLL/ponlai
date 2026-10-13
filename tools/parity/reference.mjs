// The reference store: capture sets and clip entries of a commit, kept under `<root>/<sha>/...`
// and shared by every task and process that checks against that commit, so a reference is
// captured once per sha, tool version and browser build, never once per task.
//
// A reference directory is complete for what its manifest, `complete.json`, lists: it is written
// last (whole, by a rename), after the captures it lists, so a half-written set is never read as
// complete. Its key says what the captures depend on:
//   - `tool`: a hash of the capture tools' sources (TOOL_FILES; `toolFiles` keeps each file's own
//     hash, so a forced recapture names the files that changed);
//   - `browser`: the browser build (Playwright's Chromium or CHROME_PATH, and its version): frames
//     never match across builds;
//   - the options that change pixels (tier, aa, size and device pixel ratio, extra query, the
//     capture tool's own options; for a clip entry its clip, view, frame sampling and anchors).
// What it covers (`coverage`) is recorded apart from the key: a set's views, each with or without
// its repeat capture. A request whose key matches but which needs more (another view, a repeat)
// extends the set in place; anything that needs a different key is captured afresh, and the old
// directory is moved aside to `<root>/<sha>/.replaced/` (safe to delete).
//
// Who captures: a process that finds nothing usable takes the claim, `<dir>/.capturing/owner.json`
// (pid, host, start, key, what it will cover), under a short mutex (`.<name>.mutex` beside the
// directory); a process that finds a live claim waits (polling every 5 s, a line a minute) and then
// uses the result, first freeing the GPU slot a `gpu-lock.mjs run --shared` wrapper above it holds
// (yieldAncestorSlot: an idle wait must not keep one of the 3 slots); a claim whose process is
// gone is stale and taken over (the partial captures are discarded, or kept when a manifest already
// vouches for them and the claim only extended it).
// So two tasks that need the same reference at once capture it once.
//
//   import { ensureReference, setKey, clipKey } from './reference.mjs';
//   node tools/parity/reference.mjs status <dir>     (every manifest and claim under a directory)
//
// capture-set.mjs (`--reference`, `--check`) and baseline.mjs (the `baseline` and ground-truth
// entries) use it; the layout and the manifest are documented in tools/parity/README.md.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yieldAncestorSlot } from '../gpu-lock.mjs';

const TOOLS = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const REPO = path.resolve( TOOLS, '..' );

// the sources whose change can change a reference's pixels, per kind of reference: every file of
// the capture's own code path (capture-browser.mjs holds the launch, the profile slots, the
// readiness and the grab for both). A set never runs the clip tools nor a clip the set tools, so
// a change to one kind's files leaves the other kind's references valid. Add a file here when a
// capture starts reading it; the lock (gpu-lock.mjs) and this store decide no pixels.
export const TOOL_FILES = {
	set: [ 'capture.mjs', 'capture-browser.mjs', 'parity/capture-set.mjs', 'parity/views.mjs' ],
	clip: [ 'capture-clip.mjs', 'capture-browser.mjs', 'parity/views.mjs', 'parity/clips.mjs' ],
};

// what a build reads: a server whose worktree differs from the reference's commit only elsewhere
// serves the reference's build
const BUILD_INPUTS = [ 'src', 'index.html', 'public', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json' ];
const POLL_MS = 5000, ANNOUNCE_MS = 60000, MUTEX_STALE_MS = 30000;
const FORMAT = 1;

// ------------------------------------------------------------------ small helpers

const hash = ( text, n = 16 ) => createHash( 'sha256' ).update( text ).digest( 'hex' ).slice( 0, n );

/** JSON with sorted keys, so two equal objects compare equal as text. */
export function stable( value ) {

	if ( Array.isArray( value ) ) return `[${ value.map( stable ).join( ',' ) }]`;
	if ( value && typeof value === 'object' ) return `{${ Object.keys( value ).sort().filter( ( k ) => value[ k ] !== undefined ).map( ( k ) => `${ JSON.stringify( k ) }:${ stable( value[ k ] ) }` ).join( ',' ) }}`;
	return JSON.stringify( value ?? null );

}

const readJson = ( file ) => {

	try { return JSON.parse( readFileSync( file, 'utf8' ) ); } catch { return null; }

};

// written whole or not at all
function writeJson( file, value ) {

	const tmp = `${ file }.${ process.pid }.tmp`;
	writeFileSync( tmp, JSON.stringify( value, null, 1 ) );
	renameSync( tmp, file );

}

const sleep = ( ms ) => new Promise( ( r ) => setTimeout( r, ms ) );
const sleepSync = ( ms ) => Atomics.wait( new Int32Array( new SharedArrayBuffer( 4 ) ), 0, 0, ms );

/** A process that still runs (a zombie waiting for its parent to reap it does not). When in doubt
 * (ps too slow on a loaded machine) it counts as running: taking over a live capture would put two
 * writers in one directory, while waiting a little longer costs nothing. */
export function alive( pid ) {

	if ( ! ( pid > 0 ) ) return false;
	try { process.kill( pid, 0 ); } catch ( error ) { if ( error.code !== 'EPERM' ) return false; }
	try {

		const stat = execFileSync( 'ps', [ '-o', 'stat=', '-p', String( pid ) ], { encoding: 'utf8', timeout: 20000, stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();
		return stat !== '' && ! stat.startsWith( 'Z' );

	} catch ( error ) {

		// ps exits 1 with no output when the process is gone; anything else (a timeout) is doubt
		return ! ( error.status === 1 && ! error.signal && ! String( error.stdout ?? '' ).trim() );

	}

}

const git = ( args, cwd = REPO ) => execFileSync( 'git', args, { cwd, encoding: 'utf8', timeout: 30000, stdio: [ 'ignore', 'pipe', 'ignore' ] } ).trim();

// ------------------------------------------------------------------ key parts

/** Each tool file's hash for a kind of reference, and their combined hash (the tool version). */
export function toolVersion( kind ) {

	const files = Object.fromEntries( TOOL_FILES[ kind ].map( ( f ) => [ f, hash( readFileSync( path.join( TOOLS, f ) ), 12 ) ] ) );
	return { tool: hash( stable( files ) ), files };

}

let browserCache = null;
/** The browser build the capture tools launch: CHROME_PATH's or Playwright's Chromium, and its
 * version (a launch without a page: nothing renders). */
export async function browserBuild() {

	if ( browserCache ) return browserCache;
	const { chromium } = await import( 'playwright' );
	const executable = process.env.CHROME_PATH || null;
	const browser = await chromium.launch( { headless: true, ...( executable ? { executablePath: executable } : { channel: 'chromium' } ) } );
	browserCache = { executable: executable ?? 'playwright chromium', version: browser.version() };
	await browser.close();
	return browserCache;

}

/** The key of a capture set (capture-set.mjs): what its pixels depend on besides the views. */
export async function setKey( { quality, aa, q, size, capture } ) {

	const { tool, files } = toolVersion( 'set' );
	return { key: { kind: 'set', tool, browser: await browserBuild(), quality, aa: aa ?? null, q: q ?? null, size, capture: capture ?? [] }, files };

}

/** The key of one clip entry (capture-clip.mjs through baseline.mjs). `anchors`: the hash of the
 * anchors it takes from another entry (anchorsHash), or null for its own. */
export async function clipKey( options ) {

	const { tool, files } = toolVersion( 'clip' );
	return { key: { kind: 'clip', tool, browser: await browserBuild(), ...options }, files };

}

/** The hash of the anchors in a clip.json (what `--anchors-from` reads), or null. */
export function anchorsHash( file ) {

	const clip = readJson( file );
	return clip?.anchors ? hash( stable( clip.anchors ) ) : null;

}

// ------------------------------------------------------------------ where a reference lives

/** A reference directory's commit: the path segment that names it (a full or short sha, which is
 * rewritten to the full one so every task meets in one directory). */
export function resolveRefDir( dir ) {

	const parts = path.resolve( dir ).split( path.sep );
	for ( let i = parts.length - 2; i > 0; i -- ) {

		if ( ! /^[0-9a-f]{7,40}$/.test( parts[ i ] ) ) continue;
		let sha = null;
		try { sha = git( [ 'rev-parse', '--verify', '--quiet', `${ parts[ i ] }^{commit}` ] ); } catch { /* not a commit */ }
		if ( ! sha ) continue;
		parts[ i ] = sha;
		const shaDir = parts.slice( 0, i + 1 ).join( path.sep );
		const resolved = parts.join( path.sep );
		return { dir: resolved, sha, shaDir, rel: path.relative( shaDir, resolved ) };

	}
	throw new Error( `${ dir }: a reference lives under the commit it was captured from, <root>/<sha>/<set> (no segment of the path is a commit of this repository)` );

}

/** Which worktree serves a preview URL on this machine (the process listening on its port), and
 * whether that worktree is at `sha` with no change to what the build reads. */
export function servedBy( url, sha ) {

	let port;
	try { const u = new URL( url ); port = u.port || ( u.protocol === 'https:' ? '443' : '80' ); } catch { return { known: false, why: `not a URL: ${ url }` }; }
	try {

		const pid = execFileSync( 'lsof', [ '-nP', `-iTCP:${ port }`, '-sTCP:LISTEN', '-t' ], { encoding: 'utf8', timeout: 30000 } ).trim().split( '\n' )[ 0 ];
		const cwd = execFileSync( 'lsof', [ '-a', '-p', pid, '-d', 'cwd', '-Fn' ], { encoding: 'utf8', timeout: 30000 } ).split( '\n' ).find( ( l ) => l.startsWith( 'n' ) )?.slice( 1 );
		if ( ! cwd ) return { known: false, why: `no working directory for the server on port ${ port }` };
		const head = git( [ 'rev-parse', 'HEAD' ], cwd );
		const top = git( [ 'rev-parse', '--show-toplevel' ], cwd );
		const dirty = git( [ 'status', '--porcelain', '--untracked-files=no', '--', ...BUILD_INPUTS ], top );
		// another commit with the same build inputs (a branch that changed only tools or docs)
		// serves the same build
		const same = ! sha || head === sha || git( [ 'diff', '--name-only', sha, head, '--', ...BUILD_INPUTS ], top ) === '';
		// a build older than the last commit of its inputs may come from another commit
		const dist = path.join( top, 'dist', 'index.html' );
		const committed = Number( git( [ 'log', '-1', '--format=%ct', 'HEAD', '--', ...BUILD_INPUTS ], top ) ) * 1000;
		const stale = existsSync( dist ) && statSync( dist ).mtimeMs < committed;
		return { known: true, worktree: top, head, dirty: dirty !== '', staleBuild: stale, matches: same };

	} catch ( error ) {

		return { known: false, why: `could not tell which worktree serves port ${ port } (${ error.message.split( '\n' )[ 0 ] })` };

	}

}

/** Refuses a URL that serves another commit than the reference's (or uncommitted changes): a
 * wrong reference would be reused by every later task. Unknown servers pass with a warning. */
export function checkServed( url, sha, log = console.log ) {

	const s = servedBy( url, sha );
	if ( ! s.known ) { log( `reference: ${ s.why }; trusting that ${ url } serves ${ sha.slice( 0, 12 ) }` ); return s; }
	if ( ! s.matches ) throw new Error( `${ url } is served from ${ s.worktree } at ${ s.head.slice( 0, 12 ) }, whose build inputs differ from the reference's commit ${ sha.slice( 0, 12 ) }` );
	if ( s.dirty ) throw new Error( `${ url } is served from ${ s.worktree }, which has uncommitted changes to what the build reads: not a reference of ${ sha.slice( 0, 12 ) }` );
	if ( s.staleBuild ) log( `reference: ${ s.worktree }'s dist/ is older than the last commit of what the build reads; rebuild it if it was built before the checkout` );
	return s;

}

// ------------------------------------------------------------------ claims

const claimDir = ( dir ) => path.join( dir, '.capturing' );
const manifestFile = ( dir ) => path.join( dir, 'complete.json' );

function readClaim( dir ) {

	const owner = readJson( path.join( claimDir( dir ), 'owner.json' ) );
	if ( ! owner ) return existsSync( claimDir( dir ) ) ? { pid: 0, live: false } : null;
	return { ...owner, live: owner.host === os.hostname() ? owner.pid !== process.pid && alive( owner.pid ) : true };

}

// a short critical section: inspecting a directory and taking its claim
function withMutex( dir, fn ) {

	const mutex = path.join( path.dirname( dir ), `.${ path.basename( dir ) }.mutex` );
	mkdirSync( path.dirname( dir ), { recursive: true } );
	for ( ;; ) {

		try { mkdirSync( mutex ); break; } catch ( error ) {

			if ( error.code !== 'EEXIST' ) throw error;
			// its holder died inside the section (it holds it for milliseconds)
			try { if ( Date.now() - statSync( mutex ).mtimeMs > MUTEX_STALE_MS ) rmSync( mutex, { recursive: true, force: true } ); } catch { /* gone already */ }
			sleepSync( 50 );

		}

	}
	try { return fn(); } finally { rmSync( mutex, { recursive: true, force: true } ); }

}

const held = new Set();
let exitHook = false;
const ownClaim = ( dir ) => readJson( path.join( claimDir( dir ), 'owner.json' ) )?.pid === process.pid;
function releaseClaim( dir ) {

	if ( ! held.delete( dir ) ) return;
	// (only our own: a claim another process took over is theirs)
	if ( ownClaim( dir ) ) rmSync( claimDir( dir ), { recursive: true, force: true } );

}
function hookExit() {

	if ( exitHook ) return;
	exitHook = true;
	process.on( 'exit', () => { for ( const dir of [ ...held ] ) releaseClaim( dir ); } );
	for ( const signal of [ 'SIGINT', 'SIGTERM', 'SIGHUP' ] ) process.on( signal, () => process.exit( 128 + os.constants.signals[ signal ] ) );

}

// ------------------------------------------------------------------ reasons

function describeKeyChange( stored, storedFiles, key, files ) {

	const reasons = [];
	if ( stored.tool !== key.tool ) {

		const changed = Object.keys( files ).filter( ( f ) => storedFiles?.[ f ] !== files[ f ] );
		reasons.push( `the capture tools changed (${ changed.length ? changed.join( ', ' ) : 'tool version ' + stored.tool + ' -> ' + key.tool })` );

	}
	if ( stable( stored.browser ) !== stable( key.browser ) ) reasons.push( `the browser build changed (${ stored.browser?.executable } ${ stored.browser?.version } -> ${ key.browser.executable } ${ key.browser.version })` );
	for ( const k of new Set( [ ...Object.keys( stored ), ...Object.keys( key ) ] ) ) {

		if ( k === 'tool' || k === 'browser' ) continue;
		if ( stable( stored[ k ] ) !== stable( key[ k ] ) ) reasons.push( `${ k } ${ JSON.stringify( stored[ k ] ?? null ) } -> ${ JSON.stringify( key[ k ] ?? null ) }` );

	}
	return reasons.join( '; ' );

}

// ------------------------------------------------------------------ coverage per kind

/** A set's coverage: { views: { <view>: { repeat, identical } } }; what a request wants:
 * { views: [...], repeat }. */
export const SET = {

	missing( coverage, want ) {

		const todo = [];
		for ( const v of want.views ) {

			const c = coverage?.views?.[ v ];
			if ( ! c?.captured ) todo.push( [ v, '' ] );
			if ( want.repeat && ! c?.repeat ) todo.push( [ v, '.repeat' ] );

		}
		return todo;

	},
	merge( coverage, add ) {

		const views = { ...( coverage?.views ?? {} ) };
		for ( const [ v, c ] of Object.entries( add.views ) ) views[ v ] = { ...views[ v ], ...c };
		return { views };

	},
	planned( coverage, todo ) {

		const add = { views: {} };
		for ( const [ v, s ] of todo ) add.views[ v ] = { ...add.views[ v ], ...( s ? { repeat: true } : { captured: true } ) };
		return SET.merge( coverage, add );

	},
	// what a directory written before the store holds (accepted only when asked to)
	infer( dir ) {

		const views = {};
		for ( const f of existsSync( dir ) ? readdirSync( dir ) : [] ) {

			const m = f.match( /^(.+?)(\.repeat)?\.png$/ );
			if ( ! m || m[ 1 ].includes( '.' ) ) continue;
			views[ m[ 1 ] ] = { ...views[ m[ 1 ] ], ...( m[ 2 ] ? { repeat: true } : { captured: true } ) };

		}
		for ( const v of Object.keys( views ) ) if ( ! views[ v ].captured ) delete views[ v ];
		return { views };

	},
	describe( todo ) {

		const firsts = todo.filter( ( [ , s ] ) => ! s ).map( ( [ v ] ) => v ), repeats = todo.filter( ( [ , s ] ) => s ).map( ( [ v ] ) => v );
		return [ firsts.length ? `${ firsts.length } views` : '', repeats.length ? `${ repeats.length } repeats` : '' ].filter( Boolean ).join( ' + ' );

	},

};

/** A clip entry is one capture: complete or not. */
export const CLIP = {

	missing: ( coverage ) => coverage?.captured ? [] : [ 'clip' ],
	merge: ( coverage, add ) => ( { ...coverage, ...add } ),
	planned: () => ( { captured: true } ),
	infer: ( dir ) => existsSync( path.join( dir, 'clip.json' ) ) ? { captured: true } : {},
	describe: () => 'the clip',

};

// ------------------------------------------------------------------ the store

function inspect( dir ) {

	return { manifest: readJson( manifestFile( dir ) ), claim: readClaim( dir ), exists: existsSync( dir ), incomplete: existsSync( path.join( dir, 'incomplete.json' ) ) };

}

const hasContent = ( dir ) => existsSync( dir ) && readdirSync( dir ).some( ( f ) => f !== '.capturing' );

// complete sets of the same key elsewhere under the commit that cover the request (S1 covers FAST3)
function siblingSets( shaDir, self ) {

	const out = [];
	const walk = ( dir, depth ) => {

		let names;
		try { names = readdirSync( dir, { withFileTypes: true } ); } catch { return; }
		for ( const d of names ) {

			if ( ! d.isDirectory() || d.name.startsWith( '.' ) ) continue;
			const sub = path.join( dir, d.name );
			if ( sub !== self && ( existsSync( manifestFile( sub ) ) || existsSync( claimDir( sub ) ) ) ) out.push( sub );
			if ( depth < 3 ) walk( sub, depth + 1 );

		}

	};
	walk( shaDir, 1 );
	return out;

}

/**
 * Makes a reference usable, capturing it only when no process has or is making it.
 *
 * spec: {
 *   dir,                 the reference's directory (under <root>/<sha>/; resolveRefDir)
 *   kind: 'set'|'clip',  SET or CLIP coverage
 *   key, files,          setKey() / clipKey()
 *   want,                for a set { views, repeat }
 *   url,                 where to capture it from, or null: reuse or wait only
 *   capture( todo, dir ) the capture itself: resolves to { coverage, failed } (coverage: what it
 *                        captured, in the kind's shape)
 *   acceptStale,         take a directory without a manifest, or of another key, as it is
 *   force,               capture afresh whatever is stored (a reference suspected bad)
 *   siblings,            a set may be served by another set of the commit that covers it
 *   dryRun,              only say what would happen
 *   yieldGpu,            false keeps a wrapper's GPU slot while waiting (other work of this
 *                        process, a check's test side, takes it over), default true
 *   label, log
 * }
 * Resolves to { status: 'reused'|'waited'|'captured'|'extended'|'unavailable'|'failed', dir,
 * manifest, reason, waitedMinutes, stale }.
 */
export async function ensureReference( spec ) {

	const kind = spec.kind === 'set' ? SET : CLIP;
	const log = spec.log ?? console.log;
	const { dir, sha, shaDir, rel } = resolveRefDir( spec.dir );
	const key = spec.key, keyText = stable( key );
	const name = path.relative( path.dirname( shaDir ), dir );
	const started = Date.now();
	let waitedSince = 0, announced = 0;
	const result = ( status, extra ) => ( { status, dir, sha, rel, waitedMinutes: waitedSince ? ( Date.now() - waitedSince ) / 60000 : 0, ...extra } );

	// a usable stored reference: this directory's, else (a set) a sibling's of the same key
	const usable = ( state ) => {

		if ( spec.force ) return null;
		const m = state.manifest;
		if ( m && stable( m.key ) === keyText && ! kind.missing( m.coverage, spec.want ).length ) return { dir, manifest: m };
		if ( spec.siblings ) for ( const sub of siblingSets( shaDir, dir ) ) {

			const sm = readJson( manifestFile( sub ) );
			if ( sm && stable( sm.key ) === keyText && ! kind.missing( sm.coverage, spec.want ).length ) return { dir: sub, manifest: sm };

		}
		return null;

	};
	// a live process that is capturing what we need
	const liveCapture = ( state ) => {

		// (this directory's claim whatever its key: two processes never write one directory)
		if ( state.claim?.live ) return { dir, claim: state.claim };
		if ( spec.siblings && ! spec.force ) for ( const sub of siblingSets( shaDir, dir ) ) {

			const c = readClaim( sub );
			if ( c?.live && c.key && stable( c.key ) === keyText && ! kind.missing( c.will, spec.want ).length ) return { dir: sub, claim: c };

		}
		return null;

	};

	for ( ;; ) {

		const state = inspect( dir );
		const found = usable( state );
		if ( found ) {

			const via = found.dir === dir ? '' : ` (covered by ${ path.relative( shaDir, found.dir ) })`;
			if ( ! spec.dryRun ) log( `reference ${ name }: ${ waitedSince ? 'reused after waiting' : 'reused' }${ via }` );
			return result( waitedSince ? 'waited' : 'reused', { dir: found.dir, manifest: found.manifest } );

		}
		const busy = liveCapture( state );
		if ( busy ) {

			if ( spec.dryRun ) return result( 'wait', { claim: busy.claim } );
			if ( ! waitedSince ) {

				waitedSince = Date.now();
				// a `run --shared` around this process would hold a GPU slot idle for the whole wait
				if ( spec.yieldGpu !== false && await yieldAncestorSlot( spec.label ) ) log( `reference ${ name }: freed the GPU slot of the wrapper above while waiting` );

			}
			if ( Date.now() - announced >= ANNOUNCE_MS ) {

				announced = Date.now();
				const c = busy.claim;
				const done = existsSync( busy.dir ) ? readdirSync( busy.dir ).filter( ( f ) => f.endsWith( '.png' ) || f === 'clip.json' ).length : 0;
				log( `reference ${ name }: waiting for pid ${ c.pid } (${ c.label ?? '?' }, since ${ c.started ?? '?' }) capturing ${ path.relative( path.dirname( shaDir ), busy.dir ) }; ${ done } files so far, ${ ( ( Date.now() - waitedSince ) / 60000 ).toFixed( 1 ) } min waited` );

			}
			await sleep( POLL_MS );
			continue;

		}

		// nothing usable and nobody making it: why, and what to do with what is there
		const m = state.manifest;
		let action, reason;
		if ( spec.force ) { action = 'replace'; reason = 'forced (--recapture-reference)'; }
		else if ( m && stable( m.key ) !== keyText ) { action = 'replace'; reason = describeKeyChange( m.key, m.toolFiles, key, spec.files ); }
		else if ( m ) { action = 'extend'; reason = `not captured yet: ${ kind.describe( kind.missing( m.coverage, spec.want ) ) }`; }
		else if ( state.claim && ! state.claim.live ) { action = 'wipe'; reason = `the capture by pid ${ state.claim.pid } did not finish (its process is gone)`; }
		else if ( state.incomplete ) { action = 'wipe'; reason = 'the last capture failed'; }
		else if ( hasContent( dir ) ) { action = 'replace'; reason = 'no manifest (captured before the reference store, or by hand)'; }
		else { action = 'fresh'; reason = 'no reference yet'; }

		if ( spec.acceptStale && action === 'replace' && ! spec.force ) {

			const coverage = m ? m.coverage : kind.infer( dir );
			if ( ! kind.missing( coverage, spec.want ).length ) {

				if ( ! spec.dryRun ) log( `reference ${ name }: used as it is although ${ reason } (accepting stale references)` );
				return result( 'reused', { manifest: m, stale: reason } );

			}

		}
		if ( ! spec.url ) return result( 'unavailable', { reason } );
		if ( spec.dryRun ) return result( 'capture', { reason, action } );

		// take the claim, unless another process took it (or finished) meanwhile
		const coverageBefore = action === 'extend' ? m.coverage : {};
		let todo = action === 'extend' ? kind.missing( m.coverage, spec.want ) : kind.missing( {}, spec.want );
		const claimed = withMutex( dir, () => {

			const now = inspect( dir );
			if ( now.claim?.live ) return false;
			if ( stable( now.manifest ) !== stable( m ) ) return false;
			if ( now.claim ) rmSync( claimDir( dir ), { recursive: true, force: true } );
			if ( action === 'replace' && existsSync( dir ) ) {

				const aside = path.join( shaDir, '.replaced', `${ rel.split( path.sep ).join( '~' ) }@${ new Date().toISOString().replace( /[:.]/g, '-' ) }` );
				mkdirSync( path.dirname( aside ), { recursive: true } );
				renameSync( dir, aside );
				log( `reference ${ name }: the old one moved to ${ path.relative( shaDir, aside ) }` );

			}
			if ( action === 'wipe' ) rmSync( dir, { recursive: true, force: true } );
			mkdirSync( claimDir( dir ), { recursive: true } );
			writeJson( path.join( claimDir( dir ), 'owner.json' ), {
				pid: process.pid, host: os.hostname(), started: new Date().toISOString(), label: spec.label ?? path.basename( process.argv[ 1 ] ?? 'node' ),
				key, will: kind.planned( coverageBefore, todo ),
			} );
			held.add( dir );
			hookExit();
			return true;

		} );
		if ( ! claimed ) continue;

		log( `reference ${ name }: capturing ${ kind.describe( todo ) } from ${ spec.url } (${ reason })` );
		const t0 = Date.now();
		let captured;
		try {

			captured = await spec.capture( todo, dir );

		} catch ( error ) {

			captured = { coverage: null, failed: 1, error };

		}
		// a claim taken over meanwhile (it should not happen: a live claim is never taken over) makes
		// this capture worthless: the other process owns the directory now
		if ( ! ownClaim( dir ) ) {

			held.delete( dir );
			log( `reference ${ name }: lost the claim on ${ rel } while capturing; nothing recorded` );
			return result( 'failed', { reason: 'lost the claim', missing: todo } );

		}
		const add = captured.coverage;
		const got = add && ( spec.kind === 'set' ? Object.keys( add.views ?? {} ).length : add.captured );
		if ( got ) {

			const coverage = kind.merge( coverageBefore, add );
			writeJson( manifestFile( dir ), {
				format: FORMAT, kind: spec.kind, sha, path: rel, key, toolFiles: spec.files, coverage, url: spec.url,
				rounds: [ ...( action === 'extend' ? m.rounds ?? [] : [] ), {
					pid: process.pid, label: spec.label ?? null, started: new Date( t0 ).toISOString(), finished: new Date().toISOString(),
					minutes: Number( ( ( Date.now() - t0 ) / 60000 ).toFixed( 2 ) ), captured: kind.describe( todo ), reason, failed: captured.failed ?? 0,
				} ],
			} );
			rmSync( path.join( dir, 'incomplete.json' ), { force: true } );

		} else writeJson( path.join( dir, 'incomplete.json' ), { pid: process.pid, finished: new Date().toISOString(), error: String( captured.error?.message ?? captured.error ?? 'no capture succeeded' ) } );
		releaseClaim( dir );
		const manifest = readJson( manifestFile( dir ) );
		const status = ! got ? 'failed' : action === 'extend' ? 'extended' : 'captured';
		const still = got ? kind.missing( manifest.coverage, spec.want ) : todo;
		log( `reference ${ name }: ${ status } in ${ ( ( Date.now() - t0 ) / 60000 ).toFixed( 1 ) } min${ still.length ? `; still missing ${ kind.describe( still ) }` : '' }` );
		todo = still;
		return result( still.length ? 'failed' : status, { manifest, reason, missing: still, minutes: ( Date.now() - started ) / 60000, ...( captured.error ? { error: String( captured.error.message ?? captured.error ) } : {} ) } );

	}

}

// ------------------------------------------------------------------ status

function status( dir ) {

	// (a short sha in the path names the full one's directory)
	try { dir = resolveRefDir( path.join( dir, 'x' ) ).dir.slice( 0, - 2 ); } catch { dir = path.resolve( dir ); }
	const rows = [];
	const walk = ( d, depth ) => {

		const m = readJson( manifestFile( d ) ), c = readClaim( d );
		if ( m || c ) rows.push( { d, m, c } );
		if ( depth > 4 ) return;
		let names = [];
		try { names = readdirSync( d, { withFileTypes: true } ); } catch { return; }
		for ( const n of names ) if ( n.isDirectory() && ! n.name.startsWith( '.' ) ) walk( path.join( d, n.name ), depth + 1 );

	};
	walk( dir, 0 );
	const current = { set: toolVersion( 'set' ).tool, clip: toolVersion( 'clip' ).tool };
	for ( const { d, m, c } of rows ) {

		const parts = [ path.relative( dir, d ) || '.' ];
		if ( m ) {

			parts.push( m.kind, m.key.tool === current[ m.kind ] ? 'tools current' : 'tools CHANGED', `${ m.key.browser?.executable } ${ m.key.browser?.version }` );
			if ( m.kind === 'set' ) {

				const views = Object.entries( m.coverage.views );
				parts.push( `${ views.length } views, ${ views.filter( ( [ , v ] ) => v.repeat ).length } repeated, ${ views.filter( ( [ , v ] ) => v.identical === false ).length } not repeatable`,
					`${ m.key.quality }${ m.key.aa ? ' aa=' + m.key.aa : '' }${ m.key.q ? ' ' + m.key.q : '' }` );

			} else parts.push( `${ m.key.aa } ${ m.key.tier } ${ m.key.clip }@${ m.key.view }` );

		}
		if ( c ) parts.push( c.live ? `being captured by pid ${ c.pid } since ${ c.started }` : `stale claim of pid ${ c.pid }` );
		console.log( parts.join( ' | ' ) );

	}
	if ( ! rows.length ) console.log( `no reference under ${ dir }` );

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) {

	const [ cmd, dir ] = process.argv.slice( 2 );
	if ( cmd === 'status' && dir ) status( dir );
	else { console.error( 'usage: reference.mjs status <dir>' ); process.exit( 2 ); }

}
