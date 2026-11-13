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
//     may differ across builds, so a set stored under another build is verified before reuse (below);
//   - the options that change pixels (tier, aa, size and device pixel ratio, extra query, the
//     capture tool's own options; for a clip entry its clip, view, frame sampling and anchors);
//   - for a set, `pages`: how its views were reached, 'jump' or 'view' (setKey).
// What it covers (`coverage`) is recorded apart from the key: a set's views, each with or without
// its repeat capture. A request whose key matches but which needs more (another view, a repeat)
// extends the set in place; anything that needs a different key is captured afresh, and the old
// directory is moved aside to `<root>/<sha>/.replaced/` (safe to delete).
//
// Who captures: a process that finds nothing usable takes the claim, `<dir>/.capturing/owner.json`
// (pid, host, start, key, what it will cover), under a short mutex (`.<name>.mutex` beside the
// directory); a process that finds a live claim waits (polling every 5 s, a line a minute) and then
// uses the result, first freeing the GPU slot a `gpu-lock.mjs run --shared` wrapper above it holds
// (yieldAncestorSlot: an idle wait must not keep one of the slots); a claim whose process is
// gone is stale and taken over (the partial captures are discarded, or kept when a manifest already
// vouches for them and the claim only extended it).
// So two tasks that need the same reference at once capture it once.
//
// A new browser build (a Chrome auto-update) leaves most frames unchanged, and recapturing every set
// for it cost close to an hour. So a set whose stored key differs from the request's only by the
// browser build is verified instead (under the claim, the stored set untouched meanwhile): up to
// three of its stored views (sampleViews: the island by day, vegetation, water, preferring views the
// request needs) are captured with the new build into `<root>/<sha>/.verify/` and compared with
// the stored frames, an MSAA (or aa=off) view by decoded pixels, a temporal one (aa=taa|taau|fsr3|gt)
// with diff-set.py --temporal. If they match, the manifest records the build in `verifiedBrowsers`
// and the set is reused (keyMatches accepts a key that differs only by a verified build); if not,
// the set is captured afresh as for any other key change, starting from the samples. Clip entries
// (baseline.mjs) are not verified: an entry is one capture, so checking it costs as much as
// capturing it; a new build recaptures them.
//
//   import { ensureReference, setKey, clipKey } from './reference.mjs';
//   node tools/kit/reference.mjs status <dir>     (every manifest and claim under a directory)
//
// capture-set.mjs (`--reference`, `--check`) and baseline.mjs (the `baseline` and ground-truth
// entries) use it; the layout and the manifest are documented in tools/parity/README.md.
// baseline.mjs's carry-over (carry.mjs) fills an entry through the same claim: its `capture` clones
// an earlier commit's entry and adds `carriedFrom` to the manifest (status `carried`).
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { yieldAncestorSlot } from './gpu-lock.mjs';
import { ROOT as REPO } from './root.mjs';
import PROJECT from '../project.mjs';

const HERE = path.dirname( fileURLToPath( import.meta.url ) );

// the sources whose change can change a reference's pixels, per kind of reference, from the
// repository's root: every file of the capture's own code path (capture-browser.mjs holds the
// launch, the profile slots, the readiness and the grab for both). A set never runs the clip tools
// nor a clip the set tools, so a change to one kind's files leaves the other kind's references
// valid. The project's configuration lists them (`reference.toolFiles`): add a file there when a
// capture starts reading it; the lock (gpu-lock.mjs) and this store decide no pixels.
export const TOOL_FILES = PROJECT.reference.toolFiles;

// what a build reads: a server whose worktree differs from the reference's commit only elsewhere
// serves the reference's build (the configuration's `reference.buildInputs`)
export const BUILD_INPUTS = PROJECT.reference.buildInputs;
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

	const files = Object.fromEntries( TOOL_FILES[ kind ].map( ( f ) => [ f, hash( readFileSync( path.join( REPO, f ) ), 12 ) ] ) );
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

/** The key of a capture set (capture-set.mjs): what its pixels depend on besides the views, and how
 * its views were reached (`pages`: 'jump', one page per worker reaching most views by the scene
 * jump; 'view', a fresh page per view). A check of the jump (verify-scene-jump.mjs) must compare
 * against fresh loads, so the two never stand in for each other. */
export async function setKey( { quality, aa, q, size, capture, pages = 'jump' } ) {

	const { tool, files } = toolVersion( 'set' );
	return { key: { kind: 'set', tool, browser: await browserBuild(), quality, aa: aa ?? null, q: q ?? null, size, capture: capture ?? [], pages }, files };

}

/** A key as it compares: a set stored before `pages` was recorded was reached by jumps. */
const keyOf = ( key ) => key?.kind === 'set' && key.pages === undefined ? { ...key, pages: 'jump' } : key;

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

// The temporal modes, whose paused frames repeat only within a tolerance (diff-set.py --temporal).
const TEMPORAL = [ 'taa', 'taau', 'fsr3', 'gt' ];

/** Two keys that differ at most by the browser build. */
export const sameButBrowser = ( a, b ) => stable( { ...keyOf( a ), browser: null } ) === stable( { ...keyOf( b ), browser: null } );

/** Whether a stored manifest serves a key: the same key, or one that differs only by a browser build
 * the manifest records as verified (`verifiedBrowsers`: sample views captured with that build
 * matched the stored frames). */
export function keyMatches( manifest, key ) {

	if ( ! manifest?.key ) return false;
	// a build without the exact jump (`jumpless`: capture-set gave it a page per view) serves either
	// way of reaching the views: a request for jumps on it is captured a page per view too
	const pages = ( k ) => manifest.jumpless ? { ...keyOf( k ), pages: 'view' } : keyOf( k );
	const stored = pages( manifest.key ), asked = pages( key );
	if ( stable( stored ) === stable( asked ) ) return true;
	return sameButBrowser( stored, asked ) && ( manifest.verifiedBrowsers ?? [] ).some( ( v ) => stable( v.browser ) === stable( key.browser ) );

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

/** Why a stored key is not the key asked for, in words (each tool file that changed by name). */
export function describeKeyChange( stored, storedFiles, key, files ) {

	stored = keyOf( stored );
	key = keyOf( key );
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

/** A set's coverage: { views: { <view>: { repeat, identical, def } } }; what a request wants:
 * { views: [...], repeat, defs: { <view>: def } }. `def` is an ad-hoc view's definition hash
 * (adhoc.mjs; views.mjs's views have none, their definitions are in the tool hash): the store keys
 * views by name, so a stored view whose def differs from the request's is not covered, and its
 * recapture replaces the entry rather than merging into it. */
const sameDef = ( a, b ) => ( a ?? null ) === ( b ?? null );
export const SET = {

	missing( coverage, want ) {

		const todo = [];
		for ( const v of want.views ) {

			let c = coverage?.views?.[ v ];
			if ( c && ! sameDef( c.def, want.defs?.[ v ] ) ) c = null;
			if ( ! c?.captured ) todo.push( [ v, '' ] );
			if ( want.repeat && ! c?.repeat ) todo.push( [ v, '.repeat' ] );

		}
		return todo;

	},
	merge( coverage, add ) {

		const views = { ...( coverage?.views ?? {} ) };
		for ( const [ v, c ] of Object.entries( add.views ) ) views[ v ] = views[ v ] && sameDef( views[ v ].def, c.def ) ? { ...views[ v ], ...c } : { ...c };
		return { views };

	},
	planned( coverage, todo, want ) {

		const add = { views: {} };
		for ( const [ v, s ] of todo ) add.views[ v ] = { ...add.views[ v ], ...( s ? { repeat: true } : { captured: true } ), ...( want?.defs?.[ v ] ? { def: want.defs[ v ] } : {} ) };
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

// ------------------------------------------------------------------ a new browser build

// The sample views that vouch for a set under a new browser build, one per kind of content a
// browser update could render differently: the island by day, vegetation (alpha-to-coverage,
// derivatives), water (the ocean's compute and refraction). Each list in order of preference.
const SAMPLES = [
	[ 'island-fair-noon', 'horizon-fair-noon', 'low-36', 'island-clear-golden' ],
	[ 'meadow-close', 'flowers-close', 'meadow-24' ],
	[ 'water-skim-cliffs', 'rim-sea', 'island-from-sea', 'cliff-sea-golden' ],
];
const SAMPLE_COUNT = 3;

/** Up to three stored views of a set to capture again with a new build: a view of each SAMPLES
 * list, the views the request needs first (on a mismatch they become the new set's first
 * captures), then any stored view. An MSAA view whose stored A/A differed is left out: it is
 * compared by identity. */
export function sampleViews( coverage, want, temporal ) {

	const all = Object.entries( coverage?.views ?? {} ).filter( ( [ , c ] ) => c.captured );
	const steady = all.filter( ( [ , c ] ) => temporal || c.identical !== false ).map( ( [ v ] ) => v );
	const stored = steady.length ? steady : all.map( ( [ v ] ) => v );
	const wanted = new Set( want?.views ?? [] );
	const picks = [];
	for ( const list of SAMPLES ) {

		const v = list.find( ( x ) => wanted.has( x ) && stored.includes( x ) ) ?? list.find( ( x ) => stored.includes( x ) );
		if ( v && ! picks.includes( v ) ) picks.push( v );

	}
	for ( const v of [ ...stored.filter( ( x ) => wanted.has( x ) ), ...stored ] ) if ( picks.length < SAMPLE_COUNT && ! picks.includes( v ) ) picks.push( v );
	return picks;

}

function runDiff( args, out ) {

	return new Promise( ( resolve ) => {

		// (not `python -I`: diff-set.py imports tolerance.py from its own directory)
		const child = spawn( 'uv', [ 'run', '--with', 'numpy', '--with', 'pillow', 'python', path.join( HERE, 'diff-set.py' ), ...args ], { cwd: REPO, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		const chunks = [];
		child.stdout.on( 'data', ( d ) => chunks.push( d ) );
		child.stderr.on( 'data', ( d ) => chunks.push( d ) );
		child.on( 'error', ( error ) => chunks.push( Buffer.from( `uv: ${ error.message }\n` ) ) );
		child.on( 'close', ( code ) => { writeFileSync( out, Buffer.concat( chunks ) ); resolve( code ?? 1 ); } );

	} );

}

/**
 * Captures a set's sample views with the browser build of `key` into `scratch` (through the
 * request's own capture, so with the set's options) and compares them with the stored frames: an
 * MSAA (or aa=off) view by decoded pixels, a temporal one with diff-set.py --temporal (against the
 * stored capture and its repeat, when stored). Resolves to { ok, views, captured, rule, why }.
 */
async function verifySamples( spec, m, dir, scratch ) {

	const temporal = TEMPORAL.includes( m.key.aa );
	const views = sampleViews( m.coverage, spec.want, temporal );
	const rule = temporal ? 'diff-set --temporal' : 'decoded pixels';
	if ( ! views.length ) return { ok: false, views, captured: [], rule, why: 'the stored set lists no view to compare' };
	let captured;
	try { captured = await spec.capture( views.map( ( v ) => [ v, '' ] ), scratch ); } catch ( error ) { captured = { coverage: null, error }; }
	const got = views.filter( ( v ) => captured?.coverage?.views?.[ v ]?.captured );
	if ( got.length < views.length ) return { ok: false, views, captured: got, rule, why: `${ views.length - got.length } of the ${ views.length } sample views failed to capture` };
	const differ = [];
	if ( temporal ) {

		const code = await runDiff( [ dir, scratch, '--views', views.join( ',' ), '--out', path.join( scratch, 'diff' ), '--temporal' ], path.join( scratch, 'diff.txt' ) );
		// (the scratch directory goes once the samples decide: the reasons are kept in the log line)
		const report = readJson( path.join( scratch, 'diff', 'report.json' ) );
		for ( const v of views ) {

			const t = report?.[ v ]?.temporal;
			if ( t && ! t.pass ) differ.push( `${ v } (use ${ t.use }: ${ t.why?.[ 0 ] ?? '?' })` );

		}
		if ( code !== 0 && ! differ.length ) differ.push( `diff-set --temporal exit ${ code }: ${ readFileSync( path.join( scratch, 'diff.txt' ), 'utf8' ).trim().split( '\n' ).pop() }` );

	} else {

		const { decodePng, compareFrames } = await import( './capture-browser.mjs' );
		for ( const v of views ) {

			const a = readFileSync( path.join( dir, `${ v }.png` ) ), b = readFileSync( path.join( scratch, `${ v }.png` ) );
			if ( a.equals( b ) ) continue;
			const c = compareFrames( decodePng( a ), decodePng( b ) );
			if ( c.over[ 0 ] ) differ.push( `${ v } (${ c.over[ 0 ] } px differ, max ${ c.max } levels)` );

		}

	}
	return { ok: ! differ.length, views, captured: got, rule, why: differ.length ? `the sample views differ: ${ differ.join( ', ' ) }` : `${ views.length } sample views match (${ rule })`,
		short: differ.length ? `${ differ.length } of ${ views.length } sample views differ` : '' };

}

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
 *   want,                for a set { views, repeat, defs }
 *   url,                 where to capture it from, or null: reuse or wait only
 *   capture( todo, dir ) the capture itself: resolves to { coverage, failed, manifest } (coverage:
 *                        what it captured, in the kind's shape; manifest: fields added to the
 *                        manifest, such as a carried entry's `url` and `carriedFrom`)
 *   via,                 how it captures, for the log line (default `from <url>`)
 *   acceptStale,         take a directory without a manifest, or of another key, as it is
 *   force,               capture afresh whatever is stored (a reference suspected bad)
 *   siblings,            a set may be served by another set of the commit that covers it
 *   dryRun,              only say what would happen
 *   yieldGpu,            false keeps a wrapper's GPU slot while waiting (other work of this
 *                        process, a check's test side, takes it over), default true
 *   label, log
 * }
 * Resolves to { status: 'reused'|'waited'|'captured'|'carried'|'extended'|'unavailable'|'failed', dir,
 * manifest, reason, waitedMinutes, stale }.
 */
export async function ensureReference( spec ) {

	const kind = spec.kind === 'set' ? SET : CLIP;
	const log = spec.log ?? console.log;
	const { dir, sha, shaDir, rel } = resolveRefDir( spec.dir );
	const key = spec.key, keyText = stable( keyOf( key ) );
	const name = path.relative( path.dirname( shaDir ), dir );
	const started = Date.now();
	let waitedSince = 0, announced = 0, verified = null;
	const result = ( status, extra ) => ( { status, dir, sha, rel, waitedMinutes: waitedSince ? ( Date.now() - waitedSince ) / 60000 : 0, ...( verified ? { browserVerified: verified } : {} ), ...extra } );
	const stamp = () => new Date().toISOString().replace( /[:.]/g, '-' );
	const flat = rel.split( path.sep ).join( '~' );
	// (under the mutex, and only by the claim's holder or a process about to take it)
	const moveAside = () => {

		const aside = path.join( shaDir, '.replaced', `${ flat }@${ stamp() }` );
		mkdirSync( path.dirname( aside ), { recursive: true } );
		renameSync( dir, aside );
		rmSync( claimDir( aside ), { recursive: true, force: true } );
		log( `reference ${ name }: the old one moved to ${ path.relative( shaDir, aside ) }` );

	};
	const writeClaim = ( will ) => {

		mkdirSync( claimDir( dir ), { recursive: true } );
		writeJson( path.join( claimDir( dir ), 'owner.json' ), {
			pid: process.pid, host: os.hostname(), started: new Date().toISOString(), label: spec.label ?? path.basename( process.argv[ 1 ] ?? 'node' ), key, will,
		} );

	};

	// a usable stored reference: this directory's, else (a set) a sibling's of the same key
	const usable = ( state ) => {

		if ( spec.force ) return null;
		const m = state.manifest;
		if ( keyMatches( m, key ) && ! kind.missing( m.coverage, spec.want ).length ) return { dir, manifest: m };
		if ( spec.siblings ) for ( const sub of siblingSets( shaDir, dir ) ) {

			const sm = readJson( manifestFile( sub ) );
			if ( keyMatches( sm, key ) && ! kind.missing( sm.coverage, spec.want ).length ) return { dir: sub, manifest: sm };

		}
		return null;

	};
	// a live process that is capturing what we need
	const liveCapture = ( state ) => {

		// (this directory's claim whatever its key: two processes never write one directory)
		if ( state.claim?.live ) return { dir, claim: state.claim };
		if ( spec.siblings && ! spec.force ) for ( const sub of siblingSets( shaDir, dir ) ) {

			const c = readClaim( sub );
			if ( c?.live && c.key && stable( keyOf( c.key ) ) === keyText && ! kind.missing( c.will, spec.want ).length ) return { dir: sub, claim: c };

		}
		return null;

	};

	for ( ;; ) {

		const state = inspect( dir );
		const found = usable( state );
		if ( found ) {

			const via = found.dir === dir ? '' : ` (covered by ${ path.relative( shaDir, found.dir ) })`;
			if ( ! spec.dryRun ) log( `reference ${ name }: ${ waitedSince ? 'reused after waiting' : 'reused' }${ via }${ verified ? ` (verified for ${ key.browser.version })` : '' }` );
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
		// a set whose key differs only by the browser build: a few of its views captured with this
		// build decide whether it still holds (a browser update rarely changes the frames)
		else if ( m && ! keyMatches( m, key ) && spec.kind === 'set' && sameButBrowser( m.key, key ) ) { action = 'verify'; reason = describeKeyChange( m.key, m.toolFiles, key, spec.files ); }
		else if ( m && ! keyMatches( m, key ) ) { action = 'replace'; reason = describeKeyChange( m.key, m.toolFiles, key, spec.files ); }
		else if ( m ) { action = 'extend'; reason = `not captured yet: ${ kind.describe( kind.missing( m.coverage, spec.want ) ) }`; }
		else if ( state.claim && ! state.claim.live ) { action = 'wipe'; reason = `the capture by pid ${ state.claim.pid } did not finish (its process is gone)`; }
		else if ( state.incomplete ) { action = 'wipe'; reason = 'the last capture failed'; }
		else if ( hasContent( dir ) ) { action = 'replace'; reason = 'no manifest (captured before the reference store, or by hand)'; }
		else { action = 'fresh'; reason = 'no reference yet'; }

		if ( spec.acceptStale && ( action === 'replace' || action === 'verify' ) && ! spec.force ) {

			const coverage = m ? m.coverage : kind.infer( dir );
			if ( ! kind.missing( coverage, spec.want ).length ) {

				if ( ! spec.dryRun ) log( `reference ${ name }: used as it is although ${ reason } (accepting stale references)` );
				return result( 'reused', { manifest: m, stale: reason } );

			}

		}
		if ( ! spec.url ) return result( 'unavailable', { reason } );
		if ( spec.dryRun ) return result( 'capture', { reason, action } );

		// take the claim, unless another process took it (or finished) meanwhile
		let coverageBefore = action === 'extend' ? m.coverage : {};
		let todo = action === 'extend' ? kind.missing( m.coverage, spec.want ) : kind.missing( {}, spec.want );
		const claimed = withMutex( dir, () => {

			const now = inspect( dir );
			if ( now.claim?.live ) return false;
			if ( stable( now.manifest ) !== stable( m ) ) return false;
			if ( now.claim ) rmSync( claimDir( dir ), { recursive: true, force: true } );
			if ( action === 'replace' && existsSync( dir ) ) moveAside();
			if ( action === 'wipe' ) rmSync( dir, { recursive: true, force: true } );
			// (a set being verified will cover what it covers now)
			writeClaim( action === 'verify' ? m.coverage : kind.planned( coverageBefore, todo, spec.want ) );
			held.add( dir );
			hookExit();
			return true;

		} );
		if ( ! claimed ) continue;

		let samples = null;
		if ( action === 'verify' ) {

			// the samples go to a scratch directory under the commit: the stored set stays untouched
			// until they decide
			const t0 = Date.now(), scratch = path.join( shaDir, '.verify', `${ flat }@${ stamp() }` );
			const dropScratch = () => {

				rmSync( scratch, { recursive: true, force: true } );
				try { rmdirSync( path.dirname( scratch ) ); } catch { /* another verification is under way */ }

			};
			log( `reference ${ name }: ${ reason }: capturing sample views ${ spec.via ?? `from ${ spec.url }` } to compare with the stored frames` );
			const v = await verifySamples( spec, m, dir, scratch );
			const minutes = Number( ( ( Date.now() - t0 ) / 60000 ).toFixed( 2 ) );
			if ( ! ownClaim( dir ) ) {

				held.delete( dir );
				log( `reference ${ name }: lost the claim on ${ rel } while verifying; nothing recorded` );
				return result( 'failed', { reason: 'lost the claim' } );

			}
			const round = { pid: process.pid, label: spec.label ?? null, started: new Date( t0 ).toISOString(), finished: new Date().toISOString(), minutes,
				verify: { browser: key.browser, views: v.views, rule: v.rule, ok: v.ok, why: v.why } };
			if ( v.ok ) {

				writeJson( manifestFile( dir ), { ...m, verifiedBrowsers: [ ...( m.verifiedBrowsers ?? [] ), { browser: key.browser, at: round.finished, views: v.views, rule: v.rule } ],
					rounds: [ ...( m.rounds ?? [] ), round ] } );
				releaseClaim( dir );
				dropScratch();
				verified = { from: m.key.browser, views: v.views, rule: v.rule, minutes };
				log( `reference ${ name }: the stored set holds for ${ key.browser.version }: ${ v.why }, in ${ minutes.toFixed( 1 ) } min` );
				continue;

			}
			// a mismatch: captured afresh as before, starting from the samples (this build's frames)
			log( `reference ${ name }: ${ v.why }: capturing it afresh` );
			withMutex( dir, () => {

				moveAside();
				samples = { views: {} };
				for ( const view of v.captured ) samples.views[ view ] = { captured: true, ...( spec.want?.defs?.[ view ] ? { def: spec.want.defs[ view ] } : {} ) };
				coverageBefore = samples;
				todo = kind.missing( coverageBefore, spec.want );
				writeClaim( kind.planned( coverageBefore, todo, spec.want ) );

			} );
			for ( const f of existsSync( scratch ) ? readdirSync( scratch ) : [] ) {

				const view = f.match( /^(.+?)\.(png|json|log)$/ )?.[ 1 ];
				if ( samples.views[ view ] ) renameSync( path.join( scratch, f ), path.join( dir, f ) );

			}
			dropScratch();
			reason = `${ reason }; ${ v.short || v.why }`;
			action = 'replace';
			samples.round = round;

		}

		log( todo.length ? `reference ${ name }: capturing ${ kind.describe( todo ) } ${ spec.via ?? `from ${ spec.url }` } (${ reason })` : `reference ${ name }: the sample views cover the request` );
		const t0 = Date.now();
		let captured;
		try {

			// (nothing left when the samples were all the request wanted)
			captured = todo.length ? await spec.capture( todo, dir ) : { coverage: coverageBefore, failed: 0 };

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
		// (the samples of a failed verification count even when the rest failed to capture)
		const got = ( add && ( spec.kind === 'set' ? Object.keys( add.views ?? {} ).length : add.captured ) ) || ( samples && Object.keys( samples.views ).length );
		if ( got ) {

			const coverage = kind.merge( coverageBefore, add ?? { views: {} } );
			writeJson( manifestFile( dir ), {
				format: FORMAT, kind: spec.kind, sha, path: rel, key, toolFiles: spec.files, coverage, url: spec.url, ...captured.manifest,
				rounds: [ ...( action === 'extend' ? m.rounds ?? [] : [] ), ...( samples ? [ samples.round ] : [] ), {
					pid: process.pid, label: spec.label ?? null, started: new Date( t0 ).toISOString(), finished: new Date().toISOString(),
					minutes: Number( ( ( Date.now() - t0 ) / 60000 ).toFixed( 2 ) ), captured: todo.length ? kind.describe( todo ) : 'nothing more (the samples cover it)', reason, failed: captured.failed ?? 0,
					...( captured.manifest?.carriedFrom ? { carriedFrom: captured.manifest.carriedFrom.sha } : {} ),
				} ],
			} );
			rmSync( path.join( dir, 'incomplete.json' ), { force: true } );

		} else writeJson( path.join( dir, 'incomplete.json' ), { pid: process.pid, finished: new Date().toISOString(), error: String( captured.error?.message ?? captured.error ?? 'no capture succeeded' ) } );
		releaseClaim( dir );
		const manifest = readJson( manifestFile( dir ) );
		const status = ! got ? 'failed' : captured.manifest?.carriedFrom ? 'carried' : action === 'extend' ? 'extended' : 'captured';
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
	const current = Object.fromEntries( Object.keys( TOOL_FILES ).map( ( k ) => [ k, toolVersion( k ).tool ] ) );
	for ( const { d, m, c } of rows ) {

		const parts = [ path.relative( dir, d ) || '.' ];
		if ( m ) {

			parts.push( m.kind, ! ( m.kind in current ) ? 'tools ?' : m.key.tool === current[ m.kind ] ? 'tools current' : 'tools CHANGED', `${ [ m.key.browser?.executable, m.key.browser?.version ].filter( Boolean ).join( ' ' ) }${ m.verifiedBrowsers?.length ? ` (verified for ${ m.verifiedBrowsers.map( ( v ) => v.browser.version ).join( ', ' ) })` : '' }` );
			if ( m.kind === 'set' ) {

				const views = Object.entries( m.coverage.views );
				parts.push( `${ views.length } views, ${ views.filter( ( [ , v ] ) => v.repeat ).length } repeated, ${ views.filter( ( [ , v ] ) => v.identical === false ).length } not repeatable`,
					`${ m.key.quality }${ m.key.aa ? ' aa=' + m.key.aa : '' }${ m.key.q ? ' ' + m.key.q : '' }` );

			} else parts.push( `${ m.key.aa } ${ m.key.tier } ${ m.key.clip }@${ m.key.view }` );
			if ( m.carriedFrom ) parts.push( `carried from ${ m.carriedFrom.sha.slice( 0, 12 ) }${ m.carriedFrom.origin !== m.carriedFrom.sha ? ` (captured at ${ m.carriedFrom.origin.slice( 0, 12 ) })` : '' }` );

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
