// Paused parity captures of a fixed set of views (views.mjs), each through tools/capture.mjs (and
// its shared GPU lock: a paused frame's pixels do not depend on what else renders).
//
//   node tools/parity/capture-set.mjs <baseUrl> <outDir> [--views parity|taa|all|a,b,c] [--repeat]
//       [--quality high] [--aa mode] [--q "extra&query"] [--jobs 1] [--retries 1] [--size 1728x1117@2]
//       [--runs file.csv] [--task name] [--procedure name] [--sha sha] [-- capture.mjs options]
//   node tools/parity/capture-set.mjs <refUrl> --reference <root>/<sha>/<set> [same options]
//   node tools/parity/capture-set.mjs <testUrl> <testDir> --check <root>/<sha>/<set> [--ref-url U]
//       [--diff "diff-set.py options"] [--recapture-reference] [same options]
//
// Every view loads `<baseUrl>?debug&paused&t=12&quality=<q>[&aa=<mode>][&<extra>]&<view's query>`
// (the order matters: the page reads the first of a repeated option) at the given CSS size and
// device pixel ratio (1728x1117 at 2 by default: high renders 2592x1675 and FSR 1 brings it to
// 3456x2234), runs the view's eval and writes `<outDir>/<view>.png`, its diagnostics and crop
// anchors `<view>.json` and capture.mjs's output `<view>.log`.
// --repeat captures each view twice, from fresh page loads (`<view>.png`, `<view>.repeat.png`), and
//   reports whether the two are byte-identical (exit 1 if any differ). The repeats run after all
//   the first captures. Measure an A/A floor with --jobs 1: concurrent pages may change which views
//   repeat.
// --reference makes the set a stored reference of a commit (reference.mjs; layout and manifest in
//   tools/parity/README.md): if the directory's `complete.json` matches (tool version, browser
//   build, tier, aa, size, extra query, capture.mjs options) and covers the views (and repeats) the
//   set is reused; if another live process is capturing it this one waits and reuses it; else it
//   captures what is missing (extending a set of the same key, or afresh, saying why) and writes
//   the manifest last. The URL must serve that commit: the tool checks which worktree serves the
//   port and refuses another commit or uncommitted changes. Repeats that differ are recorded in
//   the manifest, not an error. Another set of the commit with the same key that covers the
//   request serves it too (S1 serves FAST3's three views).
// --check is a check against the stored reference of the base commit: the reference as with
//   --reference (captured from --ref-url only when it is missing or stale; without --ref-url the
//   tool says why it would need one and stops), the test side captured into <testDir> with the
//   same options, then `diff-set.py <ref> <testDir> --views <the views>` with --diff's options
//   (default `--temporal` for aa=taa|taau|gt, `--aa-floor` with --repeat, else `--max-px1 0`);
//   its table goes to stdout and <testDir>/diff.txt, its exit code is the check's.
//   --recapture-reference captures the reference afresh (one suspected bad), the old one moved aside.
// --aa adds `aa=<mode>` only when given, so a build without the option loads unchanged. A temporal
//   mode's view (aa=taa|taau, and the ground truth aa=gt: 64 jitters at the canvas's resolution) is
//   captured once its paused rest has converged (capture.mjs waits for `diag.taa.converged`). Keep a
//   ground-truth set per merge-base, shared by every task on it: `<parity root>/<sha>/gt/`.
// --jobs runs that many captures at once (default 1), each in its own profile slot
//   (tools/capture-browser.mjs); captures are GPU-bound: 3 at once is the most
//   throughput, more only adds latency. --retries (default
//   1) captures a view again from a fresh page when capture.mjs fails (a load that timed out while
//   other pages kept the GPU busy); the log keeps the last attempt. --timeout (ms, default 240000)
//   bounds capture.mjs's waits for the page.
// --runs appends a line to a CSV log of verification runs (date, task, procedure, sha, wall time in
//   minutes, whether the GPU was busy before the run, the captures and failures, the set); the
//   default is the PARITY_RUNS environment variable. Without either nothing is logged, so a
//   procedure that keeps a run log must pass one of them. A reference gets its own line
//   (`<procedure> ref reused|waited|captured|extended`, its sha, the captures this run made).
// Options after `--` pass through to capture.mjs (e.g. `-- --wait-for "expr" --frames 4 --every 5`;
// an `--eval` there runs after the view's own).
// Production builds need `?debug` (added here) and the islanders' assets linked into the build's
// output; see tools/parity/README.md.
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readdir, rename, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIEWS, viewNames, viewEval } from './views.mjs';
import { gpuUtilisation } from '../gpu-lock.mjs';
import { ensureReference, setKey, resolveRefDir, checkServed } from './reference.mjs';

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../..' );
const argv = process.argv.slice( 2 );
const dash = argv.indexOf( '--' );
const passThrough = dash >= 0 ? argv.slice( dash + 1 ) : [];
const args = dash >= 0 ? argv.slice( 0, dash ) : argv;
const flags = new Set( [ 'repeat', 'recapture-reference' ] );
const options = {}, positional = [];
for ( let i = 0; i < args.length; i ++ ) {

	if ( args[ i ].startsWith( '--' ) ) {

		const k = args[ i ].slice( 2 );
		if ( flags.has( k ) ) options[ k ] = true;
		else options[ k ] = args[ ++ i ];

	} else positional.push( args[ i ] );

}
const known = [ 'repeat', 'quality', 'aa', 'q', 'views', 'jobs', 'retries', 'timeout', 'size', 'runs', 'task', 'procedure', 'sha',
	'reference', 'check', 'ref-url', 'diff', 'recapture-reference' ];
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
const views = ( () => {

	const v = options.views ?? 'parity';
	if ( [ 'parity', 'taa', 'all' ].includes( v ) ) return viewNames( v );
	const list = v.split( ',' ).filter( Boolean );
	const bad = list.filter( ( name ) => ! VIEWS[ name ] );
	if ( bad.length ) { console.error( `unknown view ${ bad.join( ', ' ) }` ); process.exit( 2 ); }
	return list;

} )();
const quality = options.quality ?? 'high';
let common = `debug&paused&t=12&quality=${ quality }`;
if ( options.aa ) common += `&aa=${ options.aa }`;
if ( options.q ) common += `&${ options.q }`;
const jobs = Math.max( 1, Number( options.jobs ?? 1 ) );
const retries = Math.max( 0, Number( options.retries ?? 1 ) );
// capture.mjs's waits for the page: generous, since other agents' pages may share the GPU
const timeout = Number( options.timeout ?? 240000 );
const captures = path.join( REPO, 'artifacts/captures' );
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

let sets = 0;
/** Captures [ view, suffix ] pairs from `url` into `dir`; resolves to the pairs that succeeded. */
async function captureList( url, dir, list ) {

	await mkdir( dir, { recursive: true } );
	const tag = `parity-${ process.pid }-${ ++ sets }`;
	const shootOnce = async ( view, suffix ) => {

		const name = `${ tag }-${ view }${ suffix }`;
		const q = `${ common }&${ VIEWS[ view ].q }`;
		const { code } = await run( process.execPath, [ 'tools/capture.mjs', name, '--url', url, '--q', q, '--w', W, '--h', H, '--scale', scale,
			'--eval', viewEval( view ), '--timeout', String( timeout ), ...passThrough ], path.join( dir, `${ view }${ suffix }.log` ) );
		// <name>.png, <name>.json and any further frames (<name>.f<i>.png)
		for ( const file of await readdir( captures ) ) {

			if ( file === `${ name }.png` || file === `${ name }.json` || ( file.startsWith( `${ name }.f` ) && file.endsWith( '.png' ) ) ) {

				await rename( path.join( captures, file ), path.join( dir, `${ view }${ suffix }${ file.slice( name.length ) }` ) );

			}

		}
		const ok = code === 0 && existsSync( path.join( dir, `${ view }${ suffix }.png` ) );
		console.log( `${ view }${ suffix } rc=${ code }${ ok ? '' : ' FAILED' }` );
		return ok;

	};
	// a load can time out while other pages keep the GPU busy: try again with a fresh page
	const shoot = async ( view, suffix ) => {

		for ( let attempt = 0; ; attempt ++ ) {

			const ok = await shootOnce( view, suffix );
			if ( ok || attempt >= retries ) return ok;
			console.log( `${ view }${ suffix } retrying` );

		}

	};
	// every plain capture first, then every repeat: with --jobs above 1 a view's two loads then never
	// run side by side, so its A/A pair is taken under the same kind of load as a test run's capture
	const queue = [ ...list.filter( ( [ , s ] ) => ! s ), ...list.filter( ( [ , s ] ) => s ) ];
	const done = [];
	// (never more workers than views, so a view's repeat cannot start beside its first capture)
	const distinct = new Set( list.map( ( [ v ] ) => v ) ).size;
	await Promise.all( Array.from( { length: Math.min( jobs, distinct ) }, async () => {

		while ( queue.length ) {

			const [ v, s ] = queue.shift();
			if ( await shoot( v, s ) ) done.push( [ v, s ] );

		}

	} ) );
	return done;

}

/** Byte comparison of each view's two captures: { view: true | false | null (no pair) }. */
async function repeatability( dir, list, quiet ) {

	const out = {};
	if ( ! quiet ) console.log( '-- repeatability' );
	for ( const v of list ) {

		const a = path.join( dir, `${ v }.png` ), b = path.join( dir, `${ v }.repeat.png` );
		out[ v ] = existsSync( a ) && existsSync( b ) ? ( await readFile( a ) ).equals( await readFile( b ) ) : null;
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
async function reference( url, { dryRun = false } = {} ) {

	const { dir } = resolveRefDir( options.reference ?? options.check );
	const { key, files } = await setKey( { quality, aa: options.aa, q: options.q, size: sizeText, capture: passThrough } );
	return ensureReference( {
		dir, kind: 'set', key, files, want: { views, repeat: !! options.repeat }, url, siblings: true, dryRun,
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
			for ( const v of firsts ) coverage.views[ v ] = { captured: true };
			for ( const v of repeats ) if ( firsts.has( v ) || existsSync( path.join( into, `${ v }.png` ) ) ) coverage.views[ v ] = { ...coverage.views[ v ], captured: true, repeat: true, identical: same[ v ] };
			return { coverage, failed: todo.length - done.length, captured: done.length };

		},
	} );

}

const busy = await gpuUtilisation();
const started = Date.now();

if ( mode === 'plain' ) {

	const list = [ ...views.map( ( v ) => [ v, '' ] ), ...( options.repeat ? views.map( ( v ) => [ v, '.repeat' ] ) : [] ) ];
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

		const temporal = [ 'taa', 'taau', 'gt' ].includes( options.aa );
		const diffArgs = options.diff ? options.diff.split( /\s+/ ).filter( Boolean ) : temporal ? [ '--temporal' ] : options.repeat ? [ '--aa-floor' ] : [ '--max-px1', '0' ];
		// (not `python -I`: diff-set.py imports tolerance.py from its own directory)
		const { code, out } = await run( 'uv', [ 'run', '--with', 'numpy', '--with', 'pillow', 'python', path.join( REPO, 'tools/parity/diff-set.py' ),
			ref.dir, outDir, '--views', views.join( ',' ), '--out', path.join( outDir, 'diff' ), ...diffArgs ], path.join( outDir, 'diff.txt' ) );
		process.stdout.write( out );
		console.log( `check ${ code === 0 ? 'PASS' : 'FAIL' } against ${ ref.dir } (diff-set ${ diffArgs.join( ' ' ) }), ${ ( ( Date.now() - started ) / 60000 ).toFixed( 1 ) } min${ test.failed ? `; ${ test.failed } test captures failed` : '' }` );
		process.exitCode = test.failed ? 1 : code;

	}

}
