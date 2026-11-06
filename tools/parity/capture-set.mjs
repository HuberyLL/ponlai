// Paused parity captures of a fixed set of views (views.mjs), through tools/capture.mjs's worker:
// one page per set (one per worker with --jobs), the views reached in place by the exact scene jump.
//
//   node tools/parity/capture-set.mjs <baseUrl> <outDir> [--views parity|taa|all|normal|special|a,b,c] [--view "name:query[::js]"]...
//       [--views-file f.json] [--sweep "key=a,b,c"]... [--repeat]
//       [--quality high] [--aa mode] [--q "extra&query"] [--jobs n] [--retries 1] [--size 1728x1117@2]
//       [--page-per-view] [--runs file.csv] [--task name] [--procedure name] [--sha sha] [-- capture.mjs options]
//   node tools/parity/capture-set.mjs <refUrl> --reference <root>/<sha>/<set> [same options]
//   node tools/parity/capture-set.mjs <testUrl> <testDir> --check <root>/<sha>/<set> [--ref-url U]
//       [--diff "diff-set.py options"] [--recapture-reference] [same options]
//   node tools/parity/capture-set.mjs <url> <outDir> --quick --views a,b|--view ...|--sweep ... [--crops x,y] [--full]
//       [--variant "[label::]js"]... [--store <root>/<sha>] [--ref-url R] [--quality, --aa, --q, --size]
//
// Every view is the frame of `<baseUrl>?debug&paused&t=12&quality=<q>[&aa=<mode>][&<extra>]&<view's
// query>` (the order matters: the page reads the first of a repeated option) at the given CSS size and
// device pixel ratio (1728x1117 at 2 by default: high renders 2K's pixel count, 2388x1543, and
// FSR 1 brings it to 3456x2234), after the view's eval; it is written as `<outDir>/<view>.png`, its diagnostics and crop
// anchors `<view>.json` and capture.mjs's output `<view>.log`.
// Ad-hoc views (adhoc.mjs, whose header has the rules) instead of or beside views.mjs's, through the
//   same path (pages, jump, readiness, --jobs, --repeat, --reference, --check, --quick):
//   --view "name:query[::js]" (repeatable; `like=<view>` in the query starts from a views.mjs view),
//   --views-file f.json, --sweep "key=a,b,c" (repeatable: every selected view per value, every
//   combination of several). An ad-hoc view's own options win over the set's (t, tier, aa, --q);
//   views whose load-time options differ get their own pages, group after group. Their definitions
//   go to `<outDir>/views.json`; in the reference store each carries its hash, so two ad-hoc views
//   of one name never share a capture.
// One page per set (plan item #9): only load-time options (quality, aa, size and dpr, the debug
//   switches in --q) need a new page, and every view of a set shares them, so each worker opens one
//   page (capture.mjs --worker), loads the first view it is given and reaches each later one by
//   `__PONLAI__.establishScene( <the view's query> )` (src/main.ts: the frame then equals a fresh
//   load's, byte for byte wherever the fresh load repeats), then the view's eval and the usual
//   readiness and shot. A view's JSON says how it was reached (`page`: visit, load or jump, the view
//   before, the page's memory). The views are handed out one at a time from one queue, so --jobs
//   balances itself. Builds whose page does not mark the exact jump (`__PONLAI__.sceneJump`; older
//   commits) get a page per view, as before, said once; --page-per-view forces that. A stored
//   reference records which (reference.mjs, `pages`: 'jump' or 'view'), so a set reached by jumps
//   never stands in for one of fresh loads, nor the other way round.
// --repeat captures each view twice (`<view>.png`, `<view>.repeat.png`) and reports whether the two
//   hold identical pixels (decoded: the PNG bytes depend on the encoder; exit 1 if any differ). The
//   repeats run after all the first captures, on other pages (a page serves first captures or
//   repeats, never both) and in reverse order, so a view's repeat is reached from another scene than
//   its first capture (the view loaded fresh in one pass is jumped to in the other): an A/A that also
//   shows anything a jump left behind. The frames do not depend on the job count (24 views at
//   --jobs 1 and 4 decoded to the same pixels); a view that differs only by sparse single-frame
//   speckle on the vegetation while other browsers render is GPU noise: shoot it again.
// --reference makes the set a stored reference of a commit (reference.mjs; layout and manifest in
//   tools/parity/README.md): if the directory's `complete.json` matches (tool version, browser
//   build, tier, aa, size, extra query, capture.mjs options) and covers the views (and repeats) the
//   set is reused; if another live process is capturing it this one waits and reuses it (freeing
//   the GPU slot of a `gpu-lock.mjs run --shared` wrapper meanwhile); else it
//   captures what is missing (extending a set of the same key, or afresh, saying why) and writes
//   the manifest last. The URL must serve that commit: the tool checks which worktree serves the
//   port and refuses another commit or uncommitted changes. Repeats that differ are recorded in
//   the manifest, not an error. Another set of the commit with the same key that covers the
//   request serves it too (S1 serves FAST3's three views).
// --check is a check against the stored reference of the base commit: the reference as with
//   --reference (captured from --ref-url only when it is missing or stale; without --ref-url the
//   tool says why it would need one and stops), the test side captured into <testDir> with the
//   same options, then `diff-set.py <ref> <testDir> --views <the views>` with --diff's options
//   (default `--temporal` for aa=taa|taau|fsr3|gt, `--aa-floor` with --repeat, else `--max-px1 0`);
//   its table goes to stdout and <testDir>/diff.txt, its exit code is the check's.
//   --recapture-reference captures the reference afresh (one suspected bad), the old one moved aside.
// --aa adds `aa=<mode>` only when given, so a build without the option loads unchanged. A temporal
//   mode's view (aa=taa|taau|fsr3, and the ground truth aa=gt: 64 jitters at the canvas's resolution) is
//   captured once its paused rest has converged (capture.mjs waits for `diag.taa.converged`). Keep a
//   ground-truth set per merge-base, shared by every task on it: `<parity root>/<sha>/gt/`.
// --jobs runs that many pages at once, each in its own profile slot (tools/capture-browser.mjs).
//   Captures are GPU-bound: 2 at once is the most throughput (about 1.6 times one page's), 3 no
//   more with each view taking twice as long, more less; and every extra page costs a load (5-8 s,
//   a jump 2-4 s), which a small set does not earn back. So the default is one page per 5
//   captures, at most 2 (repeats counted: 6 views or more take 2, up to 5 one). Each page leases a GPU lock slot (capture.mjs): it keeps it from view to view and
//   gives it up between views for a waiter after 20 s of holding (capture.mjs --lease, after `--`).
//   --retries (default 1) captures a failed view again on a fresh page (a load that timed out while
//   other pages kept the GPU busy, a page error, a crash): a failure ends its page, and the views
//   still to come go on in a fresh one, so a crash or a stuck page (no answer within three times
//   --timeout plus two minutes once the view holds its GPU slot: killed) does not lose the set; the view's log keeps the last
//   attempt. --timeout (ms, default 240000) bounds capture.mjs's waits for the page.
// --runs appends a line to a CSV log of verification runs (date, task, procedure, sha, wall time in
//   minutes, whether the GPU was busy before the run, the captures and failures, the set); the
//   default is the PARITY_RUNS environment variable. Without either nothing is logged, so a
//   procedure that keeps a run log must pass one of them. A reference gets its own line
//   (`<procedure> ref reused|waited|captured|extended`, its sha, the captures this run made).
// --quick is the tuning mode, not a gate (quick.mjs, whose header has the rest): one page per view,
//   the base and then each --variant's js on that page, each shot once ready (crops through the
//   screenshot's clip), measured against the store's MSAA and ground-truth rest entries of the
//   commit (--store) on those crops; a short table per variant.
// Options after `--` pass through to capture.mjs (e.g. `-- --wait-for "expr" --frames 4 --every 5`;
// an `--eval` there runs after the view's own, before readiness, and an `--eval-ready` once the
// view is ready, on the frame shot: a reading of the frame belongs there).
// Production builds need `?debug` (added here) and the islanders' assets linked into the build's
// output; see tools/parity/README.md.
// The set and its capture.mjs workers run with the application scheduling policy on macOS
// (tools/qos.mjs); a worker is started with it, since re-executing would close its IPC channel.
import { appPolicy } from '../qos.mjs'; // first: the set and its workers run with the application policy
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { viewEval } from './views.mjs';
import { selectViews, viewQuery, loadSignature, viewDefs, describeViews } from './adhoc.mjs';
import { gpuUtilisation } from '../gpu-lock.mjs';
import { samePixels } from '../capture-browser.mjs';
import { ensureReference, setKey, resolveRefDir, checkServed } from './reference.mjs';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../..' );
// --quick: knob variants on a few views, against the stored references (quick.mjs)
if ( process.argv.includes( '--quick' ) ) {

	const { main } = await import( './quick.mjs' );
	process.exit( await main( process.argv.slice( 2 ) ).catch( ( error ) => { console.error( error.message ?? error ); return 2; } ) );

}
const argv = process.argv.slice( 2 );
const dash = argv.indexOf( '--' );
const passThrough = dash >= 0 ? argv.slice( dash + 1 ) : [];
const args = dash >= 0 ? argv.slice( 0, dash ) : argv;
const flags = new Set( [ 'repeat', 'recapture-reference', 'page-per-view' ] );
const lists = new Set( [ 'view', 'sweep' ] );
const options = { view: [], sweep: [] }, positional = [];
for ( let i = 0; i < args.length; i ++ ) {

	if ( args[ i ].startsWith( '--' ) ) {

		const k = args[ i ].slice( 2 );
		if ( flags.has( k ) ) options[ k ] = true;
		else if ( lists.has( k ) ) options[ k ].push( args[ ++ i ] );
		else options[ k ] = args[ ++ i ];

	} else positional.push( args[ i ] );

}
const known = [ 'repeat', 'quality', 'aa', 'q', 'views', 'view', 'views-file', 'sweep', 'jobs', 'retries', 'timeout', 'size', 'runs', 'task', 'procedure', 'sha',
	'reference', 'check', 'ref-url', 'diff', 'recapture-reference', 'page-per-view' ];
const unknown = Object.keys( options ).filter( ( k ) => ! known.includes( k ) );
const mode = options.reference ? 'reference' : options.check ? 'check' : 'plain';
const positionals = mode === 'reference' ? 1 : 2;
if ( positional.length !== positionals || unknown.length || ( options.reference && options.check ) ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : 'usage: capture-set.mjs <baseUrl> <outDir> | <refUrl> --reference <dir> | <testUrl> <testDir> --check <dir> [options] (see the file header)' );
	process.exit( 2 );

}
const slash = ( u ) => ! u.endsWith( '/' ) && ! u.includes( '?' ) ? u + '/' : u;
const base = slash( positional[ 0 ] );
const outDir = mode === 'reference' ? null : path.resolve( positional[ 1 ] );
const sizeText = options.size ?? '1728x1117@2';
const size = sizeText.match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
if ( ! size ) { console.error( `bad --size ${ options.size }` ); process.exit( 2 ); }
const [ , W, H, scale = '1' ] = size;
// views.mjs's views and ad-hoc ones (adhoc.mjs)
let views;
try { views = selectViews( options ); } catch ( error ) { console.error( error.message ); process.exit( 2 ); }
const quality = options.quality ?? 'high';
let common = `debug&paused&t=12&quality=${ quality }`;
if ( options.aa ) common += `&aa=${ options.aa }`;
if ( options.q ) common += `&${ options.q }`;
const captures = views.length * ( options.repeat ? 2 : 1 );
const jobs = Math.max( 1, Number( options.jobs ?? Math.min( 2, Math.ceil( captures / 5 ) ) ) );
const retries = Math.max( 0, Number( options.retries ?? 1 ) );
// capture.mjs's waits for the page: generous, since other agents' pages may share the GPU
const timeout = Number( options.timeout ?? 240000 );
const procedure = options.procedure ?? `capture-set${ options.repeat ? ' --repeat' : '' }`;

function run( cmd, argList, log ) {

	return new Promise( ( resolve ) => {

		const child = spawn( cmd, argList, { cwd: REPO, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		const chunks = [];
		child.stdout.on( 'data', ( d ) => chunks.push( d ) );
		child.stderr.on( 'data', ( d ) => chunks.push( d ) );
		child.on( 'close', async ( code ) => { if ( log ) await writeFile( log, Buffer.concat( chunks ) ); resolve( { code: code ?? 1, out: Buffer.concat( chunks ).toString() } ); } );

	} );

}

let jumpless = false;
/** Captures [ view, suffix ] pairs from `url` into `dir`; resolves to the pairs that succeeded.
 * One page per worker (capture.mjs --worker, see the header): a page serves first captures or
 * repeats, never both, so a view's repeat comes from another page load than its first capture. */
async function captureList( url, dir, list ) {

	await mkdir( dir, { recursive: true } );
	// views whose load-time options differ cannot share a page: a group of pages per set of them, in
	// the order given (views.mjs's views all share the set's, so they make one group; adhoc.mjs)
	const groups = new Map();
	for ( const pair of list ) {

		const sig = loadSignature( viewQuery( pair[ 0 ], common ) );
		if ( ! groups.has( sig ) ) groups.set( sig, [] );
		groups.get( sig ).push( pair );

	}
	if ( groups.size > 1 ) console.log( `${ groups.size } groups of views by load-time options: ${ [ ...groups.keys() ].join( ' | ' ) }` );
	const done = [];
	for ( const group of groups.values() ) done.push( ...await captureGroup( url, dir, group ) );
	return done;

}

/** captureList's views of one set of load-time options. */
async function captureGroup( url, dir, list ) {

	// every first capture before every repeat, the repeats in reverse order (see the header)
	const queue = [ ...list.filter( ( [ , s ] ) => ! s ), ...list.filter( ( [ , s ] ) => s ).reverse() ]
		.map( ( [ view, suffix ] ) => ( { view, suffix, key: `${ view }${ suffix }`, attempts: 0 } ) );
	const done = [];
	const fail = ( item, why ) => {

		item.attempts ++;
		if ( item.attempts <= retries ) {

			// first in line, so a fresh page loads it
			queue.unshift( item );
			console.log( `${ item.key } ${ why }: retrying on a fresh page` );

		} else console.log( `${ item.key } rc=1 FAILED (${ why })` );

	};
	// a page: one capture.mjs worker, serving items of one kind (first or repeat) until none is left
	const runPage = ( repeat ) => new Promise( ( resolve ) => {

		// started with the application policy: an exec would close its IPC channel (tools/qos.mjs)
		const child = spawn( ...appPolicy( process.execPath, [ 'tools/capture.mjs', '--worker', '--url', url, '--w', W, '--h', H, '--scale', scale,
			'--timeout', String( timeout ), ...( options[ 'page-per-view' ] ? [ '--page-per-view' ] : [] ), ...passThrough ] ),
		{ cwd: REPO, stdio: [ 'ignore', 'pipe', 'pipe', 'ipc' ] } );
		let output = [], current = null, timer = null, killer = null, writing = Promise.resolve();
		child.stdout.on( 'data', ( d ) => output.push( d ) );
		child.stderr.on( 'data', ( d ) => output.push( d ) );
		child.on( 'error', ( error ) => output.push( Buffer.from( `capture.mjs: ${ error.message }\n` ) ) );
		// (the page's close waits for the logs: the set's results are read once every page is done)
		const flushLog = ( item, text ) => {

			const log = Buffer.concat( [ ...output, Buffer.from( text + '\n' ) ] );
			output = [];
			writing = writing.then( () => writeFile( path.join( dir, `${ item.key }.log` ), log ) );

		};
		child.on( 'message', ( m ) => {

			if ( m.type === 'next' ) {

				const i = queue.findIndex( ( item ) => !! item.suffix === repeat );
				current = i >= 0 ? queue.splice( i, 1 )[ 0 ] : null;
				if ( ! current ) { child.send( { type: 'done' }, () => {} ); return; }
				const item = current;
				// (a page that died meanwhile never got it: back in line, no attempt counted)
				child.send( { type: 'view', view: { key: item.key, query: viewQuery( item.view, common ), evals: [ viewEval( item.view ) ], out: path.join( dir, item.key ) } },
					( error ) => { if ( error && current === item ) { current = null; queue.unshift( item ); } } );

			} else if ( m.type === 'locked' ) {

				// a page that stopped answering (capture.mjs gives up on a view after 3 x timeout + 1 min),
				// counted from the view's GPU slot: the wait for the lock is not silence (exclusive timing
				// runs and normal-priority work may hold it far longer than any timeout)
				timer = setTimeout( () => {

					console.log( `${ current?.key } no answer from its page: killing it` );
					child.kill( 'SIGTERM' );
					killer = setTimeout( () => child.kill( 'SIGKILL' ), 15000 );

				}, timeout * 3 + 120000 );

			} else if ( m.type === 'page' ) {

				if ( ! m.jump && ! jumpless ) {

					jumpless = true;
					console.log( `this build has no exact scene jump (__PONLAI__.sceneJump ${ m.marker ?? 'missing' }): a page per view` );

				}

			} else if ( m.type === 'shot' ) {

				clearTimeout( timer );
				const item = current;
				current = null;
				flushLog( item, m.log );
				if ( m.ok ) {

					done.push( [ item.view, item.suffix ] );
					console.log( `${ item.key } rc=0 ${ m.mode }${ m.from ? ` from ${ m.from }` : '' } ${ m.seconds.toFixed( 1 ) } s${ m.worldSeconds >= 0.5 ? ` (+${ m.worldSeconds.toFixed( 1 ) } s loading its world)` : '' }${ m.lockSeconds >= 0.5 ? ` (+${ m.lockSeconds.toFixed( 1 ) } s waiting for the GPU lock)` : '' }` );

				} else fail( item, 'failed' );

			}

		} );
		child.on( 'close', async ( code, signal ) => {

			clearTimeout( timer );
			clearTimeout( killer );
			if ( current ) {

				// the page died with a view in hand: that view's attempt failed, the rest go on elsewhere
				const item = current;
				current = null;
				flushLog( item, `the page was lost (exit ${ code ?? signal })` );
				fail( item, `page lost (exit ${ code ?? signal })` );

			}
			await writing;
			resolve();

		} );

	} );
	// (never more workers than views, so a view's repeat cannot start beside its first capture)
	const distinct = new Set( list.map( ( [ v ] ) => v ) ).size;
	await Promise.all( Array.from( { length: Math.min( jobs, distinct ) }, async () => {

		while ( queue.length ) await runPage( !! queue[ 0 ].suffix );

	} ) );
	return done;

}

/** Pixel comparison of each view's two captures (decoded PNGs): { view: true | false | null (no pair) }. */
async function repeatability( dir, list, quiet ) {

	const out = {};
	if ( ! quiet ) console.log( '-- repeatability' );
	for ( const v of list ) {

		const a = path.join( dir, `${ v }.png` ), b = path.join( dir, `${ v }.repeat.png` );
		out[ v ] = existsSync( a ) && existsSync( b ) ? samePixels( await readFile( a ), await readFile( b ) ) : null;
		if ( ! quiet ) console.log( `${ v } ${ out[ v ] ? 'identical' : 'DIFFERS' }` );

	}
	return out;

}

async function logRun( started, busy, proc, sha, captured, failed, out ) {

	const runs = options.runs ?? process.env.PARITY_RUNS;
	if ( ! runs ) return;
	const minutes = ( Date.now() - started ) / 60000;
	const header = 'date,task,procedure,sha,wall_min,contended,captures,failed,out\n';
	const field = ( s ) => /[",\n]/.test( s ) ? `"${ s.replace( /"/g, '""' ) }"` : s;
	const line = [ new Date( started ).toISOString(), options.task ?? '', proc, sha ?? '', minutes.toFixed( 2 ), busy === null ? '?' : busy > 15 ? 'y' : 'n',
		String( captured ), String( failed ), out ].map( field ).join( ',' ) + '\n';
	await mkdir( path.dirname( path.resolve( runs ) ), { recursive: true } );
	await appendFile( runs, existsSync( runs ) ? line : header + line );

}

// ------------------------------------------------------------------ the reference (--reference, --check)

let refCaptured = 0, served = null;
const defs = viewDefs( views );
async function reference( url, { dryRun = false } = {} ) {

	const { dir } = resolveRefDir( options.reference ?? options.check );
	// (how the views are reached is part of the key: a check of the jump needs fresh loads)
	const { key, files } = await setKey( { quality, aa: options.aa, q: options.q, size: sizeText, capture: passThrough, pages: options[ 'page-per-view' ] ? 'view' : 'jump' } );
	return ensureReference( {
		dir, kind: 'set', key, files, want: { views, repeat: !! options.repeat, defs }, url, siblings: true, dryRun,
		// (a check's test side, captured meanwhile, takes the wrapper's slot over itself)
		yieldGpu: mode === 'reference',
		force: options[ 'recapture-reference' ], label: `capture-set ${ options.task ?? '' } ${ procedure }`.trim(),
		capture: async ( todo, into ) => {

			// (also when this process takes over a capture that another one left unfinished)
			served ??= checkServed( url, resolveRefDir( into ).sha );
			const done = await captureList( url, into, todo );
			refCaptured += todo.length;
			const firsts = new Set( done.filter( ( [ , s ] ) => ! s ).map( ( [ v ] ) => v ) );
			const repeats = new Set( done.filter( ( [ , s ] ) => s ).map( ( [ v ] ) => v ) );
			const same = await repeatability( into, [ ...repeats ], true );
			const coverage = { views: {} };
			// (an ad-hoc view's definition goes with it: reference.mjs SET)
			const def = ( v ) => defs[ v ] ? { def: defs[ v ] } : {};
			for ( const v of firsts ) coverage.views[ v ] = { captured: true, ...def( v ) };
			for ( const v of repeats ) if ( firsts.has( v ) || existsSync( path.join( into, `${ v }.png` ) ) ) coverage.views[ v ] = { ...coverage.views[ v ], captured: true, repeat: true, identical: same[ v ], ...def( v ) };
			// a build without the exact jump got a page per view whatever was asked: stored as such
			return { coverage, failed: todo.length - done.length, captured: done.length, ...( jumpless ? { manifest: { key: { ...key, pages: 'view' }, jumpless: true } } : {} ) };

		},
	} );

}

/** The ad-hoc views' definitions beside their captures (`views.json`), when there are any. */
async function writeViews( dir ) {

	const adhoc = describeViews( views, common );
	if ( ! Object.keys( adhoc ).length ) return;
	await mkdir( dir, { recursive: true } );
	await writeFile( path.join( dir, 'views.json' ), JSON.stringify( adhoc, null, '\t' ) + '\n' );

}

const busy = await gpuUtilisation();
const started = Date.now();

if ( mode === 'plain' ) {

	const list = [ ...views.map( ( v ) => [ v, '' ] ), ...( options.repeat ? views.map( ( v ) => [ v, '.repeat' ] ) : [] ) ];
	await writeViews( outDir );
	const done = await captureList( base, outDir, list );
	const failed = list.length - done.length;
	const same = options.repeat ? await repeatability( outDir, views ) : {};
	const differ = Object.values( same ).filter( ( s ) => ! s ).length;
	const minutes = ( Date.now() - started ) / 60000;
	console.log( `${ views.length } views${ options.repeat ? ' x2' : '' } in ${ minutes.toFixed( 1 ) } min${ failed ? `, ${ failed } failed` : '' }` );
	await logRun( started, busy, procedure, options.sha, list.length, failed, outDir );
	process.exitCode = failed || differ ? 1 : 0;

} else {

	// the URL to capture the reference from: the positional one for --reference, --ref-url for --check
	const refUrl = mode === 'reference' ? base : options[ 'ref-url' ] ? slash( options[ 'ref-url' ] ) : null;
	const { sha } = resolveRefDir( options.reference ?? options.check );
	const probe = await reference( refUrl, { dryRun: true } );
	if ( probe.status === 'unavailable' ) {

		console.error( `reference ${ probe.rel } of ${ sha.slice( 0, 12 ) } must be captured (${ probe.reason }): pass --ref-url <a preview of ${ sha.slice( 0, 12 ) }>` );
		process.exit( 2 );

	}
	if ( probe.status === 'capture' ) {

		try { served = checkServed( refUrl, sha ); } catch ( error ) { console.error( `reference: ${ error.message }` ); process.exit( 2 ); }

	}
	const refStarted = Date.now();
	const refRun = async () => {

		const r = await reference( refUrl );
		await logRun( refStarted, busy, `${ procedure } ref ${ r.status }`, sha.slice( 0, 7 ), refCaptured, r.missing?.length ?? 0, r.dir );
		return r;

	};
	const testRun = async () => {

		if ( mode !== 'check' ) return null;
		const list = [ ...views.map( ( v ) => [ v, '' ] ), ...( options.repeat ? views.map( ( v ) => [ v, '.repeat' ] ) : [] ) ];
		const t0 = Date.now();
		await writeViews( outDir );
		const done = await captureList( base, outDir, list );
		if ( options.repeat ) await repeatability( outDir, views );
		await logRun( t0, busy, procedure, options.sha, list.length, list.length - done.length, outDir );
		return { failed: list.length - done.length };

	};
	// a reference to capture first (the GPU does one set at a time better); one stored or being
	// captured elsewhere beside the test side
	let ref, test;
	if ( probe.status === 'capture' ) { ref = await refRun(); test = await testRun(); } else [ ref, test ] = await Promise.all( [ refRun(), testRun() ] );
	if ( ! [ 'reused', 'waited', 'captured', 'extended' ].includes( ref.status ) ) {

		console.error( `reference ${ ref.rel }: ${ ref.status }${ ref.reason ? ` (${ ref.reason })` : '' }${ ref.error ? `: ${ ref.error }` : '' }${ ref.missing?.length ? `; missing ${ ref.missing.map( ( p ) => p.join( '' ) ).join( ', ' ) }` : '' }` );
		process.exit( mode === 'check' ? 2 : 1 );

	}
	console.log( `reference ${ path.relative( path.dirname( resolveRefDir( ref.dir ).shaDir ), ref.dir ) }: ${ ref.status }${ ref.waitedMinutes ? ` after ${ ref.waitedMinutes.toFixed( 1 ) } min of waiting` : '' }` );
	if ( mode === 'reference' ) {

		console.log( `${ ( ( Date.now() - started ) / 60000 ).toFixed( 1 ) } min` );
		process.exitCode = 0;

	} else {

		const temporal = [ 'taa', 'taau', 'fsr3', 'gt' ].includes( options.aa );
		const diffArgs = options.diff ? options.diff.split( /\s+/ ).filter( Boolean ) : temporal ? [ '--temporal' ] : options.repeat ? [ '--aa-floor' ] : [ '--max-px1', '0' ];
		// (not `python -I`: diff-set.py imports tolerance.py from its own directory)
		const { code, out } = await run( 'uv', [ 'run', '--with', 'numpy', '--with', 'pillow', 'python', path.join( REPO, 'tools/parity/diff-set.py' ),
			ref.dir, outDir, '--views', views.join( ',' ), '--out', path.join( outDir, 'diff' ), ...diffArgs ], path.join( outDir, 'diff.txt' ) );
		process.stdout.write( out );
		console.log( `check ${ code === 0 ? 'PASS' : 'FAIL' } against ${ ref.dir } (diff-set ${ diffArgs.join( ' ' ) }), ${ ( ( Date.now() - started ) / 60000 ).toFixed( 1 ) } min${ test.failed ? `; ${ test.failed } test captures failed` : '' }` );
		process.exitCode = test.failed ? 1 : code;

	}

}
