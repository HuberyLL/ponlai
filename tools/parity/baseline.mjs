// The MSAA baseline of a merge-base (plan section 3.3): the rest images and stepped clips that the
// anti-aliasing gates read, captured from a preview of that commit, with the interim ground truth
// and the metrics of MSAA against it. Every gate in thresholds.json is a ratio or a band times
// this baseline, measured at the same merge-base in the same session, never an absolute number, so
// each later task on that sha reuses `<root>/<sha>/baseline/metrics.json` and measures only its own
// mode.
//
//   node tools/parity/baseline.mjs --url U --sha SHA [--root DIR] [--label baseline] [--aa msaa]
//       [--tiers high,medium,low] [--only rest|clips] [--views a,b] [--clips a,b] [--gt | --no-gt]
//       [--jobs 2] [--capture-only | --metrics-only] [--thresholds thresholds.json] [--runs runs.csv] [--task name]
//       [--skip-existing] [--size 1728x1117@2] [--q "extra&query"] [--verbose]
//
// The plan (PLAN below): on high the 24 parity and TAA views at rest (the 17 parity views also as
// whole frames, for the overall fidelity gate) and the gates' clips; on medium and low six views at
// rest. Rest images go through tools/capture-clip.mjs as the one-frame clip `rest`, so their crops
// are cut exactly as a clip's are.
//
// Layout under <root>/<sha>/:
//   <label>/<tier>/rest/<view>/           a capture-clip folder (crops, clip.json, metrics/)
//   <label>/<tier>/clip/<clip>[@<view>]/  the same for a clip (on another view than its own: @view)
//   gt/high/...                           the ground truth (`--aa gt-hi`, high only), shared by every
//                                         label; clips of more than 60 frames every 4th frame plus
//                                         their dense runs (clips.mjs gtSampling)
//   <label>/metrics.json                  every entry's metrics; for the label `baseline` (MSAA) this
//                                         is the baseline the gates multiply
//
// `--label x --aa taau` captures the same entries for another mode and measures them against the
// baseline's MSAA captures and the shared ground truth (with --thresholds: gate verdicts). The
// ground truth and other labels take the baseline's anchors (`--anchors-from`), so every side
// frames the same subjects. Medium and low have no ground truth of their own until aa=gt (M8):
// their metrics take high's ground truth of the same view as the reference, which cancels in every
// ratio to MSAA; their GT-relative values mean nothing and no gate reads them.
//
// Clips and rest frames are deterministic (the page's stepper), so captures take the GPU lock shared
// (capture-clip.mjs takes it). Wall times go to --runs (or PARITY_RUNS) and into metrics.json.
// Python metrics run through `uv run --with numpy --with pillow --with scipy --with flip-evaluator`.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { VIEWS, viewNames } from './views.mjs';
import { CLIPS, gtSampling } from './clips.mjs';
import { sampleGpuUtilisation } from '../gpu-lock.mjs';

const HERE = path.dirname( fileURLToPath( import.meta.url ) );
const TOOLS = path.resolve( HERE, '..' );

// the views every lower tier keeps at rest: the meadow near and far, the flowers, the island, the
// sea's glints and horizon, the night sky
export const TIER_VIEWS = [ 'meadow-close', 'meadow-24', 'flowers-close', 'island-fair-noon', 'horizon-fair-noon', 'night-moon' ];

// the gates' clips (verification design 5.2): [ clip, view or null for the clip's own ]
export const GATE_CLIPS = [
	[ 'pan-slow', null ], [ 'pan-slow', 'island-fair-noon' ], [ 'pan-fast', null ], [ 'flick', null ], [ 'zoom', null ],
	[ 'islander-walk', null ], [ 'islander-orbit', null ], [ 'wind-still', null ], [ 'sea-still', null ], [ 'sea-pan', null ],
	// the still sea also facing a low sun: the glints' sparkle (the only view with a sea-glints crop by day)
	[ 'sea-still', 'cliff-sea-golden' ],
	// the night clip on the moon view: its stars, moon limb and moonlit glints under the pan
	[ 'storm', null ], [ 'rain', null ], [ 'lightning', null ], [ 'night', 'night-moon' ], [ 'fog', null ],
	// the low stars' scintillation under a still camera (the pan's twinkle is pixel phase)
	[ 'night-still', null ],
];

export const PLAN = {
	high: { rest: viewNames( 'all' ), full: viewNames( 'parity' ), clips: GATE_CLIPS },
	medium: { rest: TIER_VIEWS, full: [], clips: [] },
	low: { rest: TIER_VIEWS, full: [], clips: [] },
};

// ------------------------------------------------------------------ options

const FLAGS = new Set( [ 'gt', 'no-gt', 'metrics-only', 'capture-only', 'skip-existing', 'verbose' ] );
const KNOWN = [ 'url', 'sha', 'root', 'label', 'aa', 'tiers', 'only', 'views', 'clips', 'jobs', 'thresholds', 'runs', 'task', 'size', 'q', ...FLAGS ];

function parse( argv ) {

	const o = {};
	for ( let i = 0; i < argv.length; i ++ ) {

		const a = argv[ i ];
		if ( ! a.startsWith( '--' ) ) throw new Error( `unexpected argument ${ a }` );
		const k = a.slice( 2 );
		if ( ! KNOWN.includes( k ) ) throw new Error( `unknown option --${ k }` );
		o[ k ] = FLAGS.has( k ) ? true : argv[ ++ i ];

	}
	return o;

}

/** The entries of the plan for the options: { tier, kind, name, clip, view, key, dir }. */
export function entries( o ) {

	const tiers = ( o.tiers ?? 'high,medium,low' ).split( ',' );
	const views = o.views ? new Set( o.views.split( ',' ) ) : null, clips = o.clips ? new Set( o.clips.split( ',' ) ) : null;
	const out = [];
	for ( const tier of tiers ) {

		const plan = PLAN[ tier ];
		if ( ! plan ) throw new Error( `unknown tier ${ tier }` );
		if ( o.only !== 'clips' ) for ( const view of plan.rest ) {

			if ( views && ! views.has( view ) ) continue;
			out.push( { tier, kind: 'rest', name: view, clip: 'rest', view, full: plan.full.includes( view ), key: `${ tier }/rest/${ view }` } );

		}
		if ( o.only !== 'rest' ) for ( const [ clip, view ] of plan.clips ) {

			const name = view ? `${ clip }@${ view }` : clip;
			if ( clips && ! clips.has( name ) && ! clips.has( clip ) ) continue;
			out.push( { tier, kind: 'clip', name, clip, view: view ?? CLIPS[ clip ].view, full: false, key: `${ tier }/clip/${ name }` } );

		}

	}
	return out;

}

const entryDir = ( root, label, e ) => path.join( root, label, e.tier, e.kind, e.name );

// ------------------------------------------------------------------ processes

function run( cmd, args, { log, verbose } = {} ) {

	return new Promise( ( resolve ) => {

		const child = spawn( cmd, args, { stdio: [ 'ignore', 'pipe', 'pipe' ], env: process.env } );
		let out = '';
		child.stdout.on( 'data', ( d ) => { out += d; if ( verbose ) process.stdout.write( d ); } );
		child.stderr.on( 'data', ( d ) => { out += d; if ( verbose ) process.stderr.write( d ); } );
		child.on( 'close', async ( code ) => {

			if ( log ) await writeFile( log, out );
			resolve( { code, out } );

		} );

	} );

}

async function pool( jobs, n, fn ) {

	const queue = jobs.slice(), results = [];
	await Promise.all( Array.from( { length: Math.max( 1, n ) }, async () => {

		while ( queue.length ) { const j = queue.shift(); results.push( await fn( j ) ); }

	} ) );
	return results;

}

// ------------------------------------------------------------------ capture

async function capture( o, list, root ) {

	const label = o.label, aa = o.aa;
	const common = [ '--url', o.url, ...( o.size ? [ '--size', o.size ] : [] ), ...( o.q ? [ '--q', o.q ] : [] ),
		...( o.runs ? [ '--runs', o.runs ] : [] ), ...( o.task ? [ '--task', o.task ] : [] ) ];
	// the side under test, then (on high) the ground truth with the same anchors
	const jobs = [];
	for ( const e of list ) {

		const dir = entryDir( root, label, e );
		// anchors: the baseline's (high's for the lower tiers) unless this is the baseline's own high run
		const anchorTier = e.tier === 'high' ? e : { ...e, tier: 'high' };
		const anchors = path.join( entryDir( root, 'baseline', anchorTier ), 'clip.json' );
		const ownAnchors = label === 'baseline' && e.tier === 'high';
		jobs.push( { e, side: label, dir, args: [ path.join( TOOLS, 'capture-clip.mjs' ), `${ label }-${ e.tier }-${ e.name }`, ...common, '--clip', e.clip, '--view', e.view,
			'--quality', e.tier, '--aa', aa, '--out', dir, ...( e.full ? [ '--full', '0' ] : [] ),
			...( ownAnchors ? [] : [ '--anchors-from', anchors ] ) ], needs: ownAnchors ? null : anchors } );

	}
	const gtJobs = [];
	if ( o.gt ) for ( const e of list ) {

		if ( e.tier !== 'high' ) continue;
		const dir = entryDir( root, 'gt', e );
		const s = gtSampling( CLIPS[ e.clip ] );
		gtJobs.push( { e, side: 'gt', dir, args: [ path.join( TOOLS, 'capture-clip.mjs' ), `gt-${ e.name }`, ...common, '--clip', e.clip, '--view', e.view,
			'--quality', 'high', '--aa', 'gt-hi', '--out', dir, '--every', String( s.every ),
			...( s.dense.length ? [ '--dense', s.dense.map( ( r ) => r.join( '-' ) ).join( ',' ) ] : [] ),
			...( e.full ? [ '--full', '0' ] : [] ), '--anchors-from', path.join( entryDir( root, 'baseline', e ), 'clip.json' ) ],
		needs: path.join( entryDir( root, 'baseline', e ), 'clip.json' ) } );

	}
	const done = [];
	// a job whose anchors another job of this run writes (a lower tier's, high's of the same view)
	// waits for it; the queue puts high first, so the writer has started by then
	const writers = new Map();
	for ( const j of [ ...jobs, ...gtJobs ] ) {

		let resolve;
		const promise = new Promise( ( r ) => { resolve = r; } );
		writers.set( path.join( j.dir, 'clip.json' ), { promise, resolve } );

	}
	const one = async ( j ) => {

		const finish = ( r ) => { done.push( r ); writers.get( path.join( j.dir, 'clip.json' ) ).resolve(); };
		if ( o[ 'skip-existing' ] && existsSync( path.join( j.dir, 'clip.json' ) ) ) { finish( { ...j, code: 0, skipped: true } ); return; }
		if ( j.needs && writers.has( j.needs ) ) await writers.get( j.needs ).promise;
		if ( j.needs && ! existsSync( j.needs ) ) { console.log( `skip ${ j.side } ${ j.e.key }: no baseline anchors (${ j.needs })` ); finish( { ...j, code: 2 } ); return; }
		await rm( j.dir, { recursive: true, force: true } );
		await mkdir( j.dir, { recursive: true } );
		const t0 = Date.now();
		const r = await run( process.execPath, j.args, { log: path.join( j.dir, 'capture.log' ), verbose: o.verbose } );
		// on a failure the first line naming an error (the last line is often only node's version,
		// and a thrown error's dump ends in `name: 'Error'`), else the first line
		const lines = r.out.trim().split( '\n' ).filter( ( l ) => l.trim() );
		const line = r.code ? ( lines.find( ( l ) => /Error:|ERR_|error:|failed/i.test( l ) ) ?? lines[ 0 ] ?? '' ) : '';
		console.log( `${ r.code ? 'FAIL' : 'ok  ' } ${ j.side } ${ j.e.key } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) } s${ r.code ? ': ' + line + ' (' + path.join( j.dir, 'capture.log' ) + ')' : '' }` );
		finish( { ...j, code: r.code } );

	};
	// the side's own captures first (the GT needs the baseline's anchors), high before the lower tiers
	const order = ( a, b ) => ( a.e.tier === 'high' ? 0 : 1 ) - ( b.e.tier === 'high' ? 0 : 1 );
	await pool( jobs.sort( order ), Number( o.jobs ?? 2 ), one );
	await pool( gtJobs, Number( o.jobs ?? 2 ), one );
	return done;

}

// ------------------------------------------------------------------ metrics

async function metrics( o, list, root ) {

	const label = o.label, out = { sha: o.sha, label, aa: o.aa, created: new Date().toISOString(), entries: {}, failures: [] };
	const python = [ 'run', '--with', 'numpy', '--with', 'pillow', '--with', 'scipy', '--with', 'flip-evaluator', 'python', '-I', path.join( TOOLS, 'clip-metrics.py' ) ];
	const baselineFile = path.join( root, 'baseline', 'metrics.json' );
	await pool( list, Math.min( Number( o.jobs ?? 2 ) * 2, Math.max( 1, os.cpus().length >> 1 ) ), async ( e ) => {

		const test = entryDir( root, label, e ), msaa = entryDir( root, 'baseline', e );
		const gt = entryDir( root, 'gt', { ...e, tier: 'high' } );
		if ( ! existsSync( path.join( test, 'clip.json' ) ) || ! existsSync( path.join( msaa, 'clip.json' ) ) || ! existsSync( path.join( gt, 'clip.json' ) ) ) {

			out.failures.push( `${ e.key }: missing captures` );
			return;

		}
		const args = [ ...python, '--test', test, '--msaa', msaa, '--gt', gt, '--out', path.join( test, 'metrics' ), '--key', e.key,
			...( e.full ? [ '--crops', [ ...cropNames( gt ), 'full' ].join( ',' ) ] : [] ),
			...( label !== 'baseline' && existsSync( baselineFile ) ? [ '--baseline', baselineFile ] : [] ),
			...( o.thresholds ? [ '--thresholds', o.thresholds ] : [] ),
			// high's GT stands in for the lower tiers' (it cancels in every ratio to MSAA), so no GT gate reads it
			...( e.tier !== 'high' ? [ '--no-gt-gates' ] : [] ) ];
		const t0 = Date.now();
		const r = await run( 'uv', args, { log: path.join( test, 'metrics.log' ) } );
		const file = path.join( test, 'metrics', 'metrics.json' );
		if ( ! existsSync( file ) ) { out.failures.push( `${ e.key }: clip-metrics failed (${ r.out.trim().split( '\n' ).pop() })` ); return; }
		const m = JSON.parse( await readFile( file, 'utf8' ) );
		// the console gate (IQ-console): errors, page errors and WebGPU validation messages in the capture
		const logged = JSON.parse( await readFile( path.join( test, 'clip.json' ), 'utf8' ) ).errors ?? [];
		const consoleErrors = logged.filter( ( l ) => /^(error|pageerror):/.test( l ) || /validation|GPUValidationError/i.test( l ) );
		out.entries[ e.key ] = { tier: e.tier, kind: e.kind, clip: e.clip, view: e.view, metric: m.metric, gates: m.gates ?? null, console: consoleErrors,
			crops: Object.fromEntries( Object.entries( m.crops ).map( ( [ c, v ] ) => [ c, v.missing ? v : { frames: v.frames, gtFrames: v.gtFrames, size: v.size, test: v.test, msaa: v.msaa, verdict: v.verdict } ] ) ) };
		console.log( `metrics ${ e.key } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) } s${ m.gates ? ` (${ m.gates.failed } gates failed)` : '' }` );

	} );
	return out;

}

function cropNames( dir ) {

	try {

		const clip = JSON.parse( readFileSync( path.join( dir, 'clip.json' ), 'utf8' ) );
		return Object.entries( clip.anchors ).filter( ( [ , a ] ) => a.world ).map( ( [ n ] ) => n );

	} catch { return []; }

}


/** Aggregate gates over entries (thresholds.json `aggregates`): a share of views passing a ratio. */
function aggregates( thresholds, result ) {

	const out = [];
	for ( const g of thresholds?.aggregates ?? [] ) {

		const rows = [];
		for ( const [ key, e ] of Object.entries( result.entries ) ) {

			if ( ! key.startsWith( g.prefix ) ) continue;
			if ( g.views && ! g.views.includes( e.view ) ) continue;
			const c = e.crops[ g.crop ];
			if ( ! c || c.missing ) continue;
			const t = c.test?.[ g.metric ], m = c.msaa?.[ g.metric ];
			if ( typeof t !== 'number' || typeof m !== 'number' || m === 0 ) continue;
			rows.push( { key, ratio: t / m } );

		}
		const passing = rows.filter( ( r ) => r.ratio <= g.ratioMax + 1e-12 ).length;
		const worst = rows.reduce( ( a, r ) => Math.max( a, r.ratio ), 0 );
		const ok = rows.length > 0 && passing >= Math.ceil( g.minShare * rows.length ) && worst <= g.ratioCap + 1e-12;
		out.push( { gate: g.gate, views: rows.length, passing, worst, verdict: rows.length ? ( ok ? 'PASS' : 'FAIL' ) : null } );

	}
	return out;

}

// ------------------------------------------------------------------ main

async function logRun( o, started, captures, failed, out, what, contended ) {

	const runs = o.runs ?? process.env.PARITY_RUNS;
	if ( ! runs ) return;
	const header = 'date,task,procedure,sha,wall_min,contended,captures,failed,out\n';
	const line = [ new Date( started ).toISOString(), o.task ?? '', `baseline ${ what } ${ o.label } ${ o.aa } ${ ( o.tiers ?? 'high,medium,low' ).replace( /,/g, '+' ) }${ o.only ? ' ' + o.only : '' }${ o.views ? ' views=' + o.views.replace( /,/g, ' ' ) : '' }${ o.clips ? ' clips=' + o.clips.replace( /,/g, ' ' ) : '' }`, o.sha,
		( ( Date.now() - started ) / 60000 ).toFixed( 2 ), contended, String( captures ), String( failed ), out ].join( ',' ) + '\n';
	await mkdir( path.dirname( path.resolve( runs ) ), { recursive: true } );
	await appendFile( runs, existsSync( runs ) ? line : header + line );

}

async function main() {

	const o = parse( process.argv.slice( 2 ) );
	if ( ! o.sha || ( ! o.url && ! o[ 'metrics-only' ] ) ) {

		console.error( 'usage: baseline.mjs --url U --sha SHA [options] (see the file header)' );
		process.exit( 2 );

	}
	o.label ??= 'baseline';
	o.aa ??= 'msaa';
	if ( o.label === 'baseline' && o.aa !== 'msaa' ) throw new Error( 'the baseline is MSAA: give another --label for --aa ' + o.aa );
	if ( o[ 'no-gt' ] ) o.gt = false;
	else if ( o.gt === undefined ) o.gt = o.label === 'baseline';
	const root = path.resolve( o.root ?? path.join( TOOLS, '..', 'artifacts', 'parity' ), o.sha );
	const list = entries( o );
	if ( ! list.length ) throw new Error( 'nothing to do: no entry matches --tiers, --views, --clips and --only' );
	for ( const e of list ) if ( ! VIEWS[ e.view ] ) throw new Error( `unknown view ${ e.view }` );
	const started = Date.now();
	// contended: the GPU busy before the captures start (their own load would count later); a
	// metrics-only run uses no GPU
	let contended = 'n';
	if ( ! o[ 'metrics-only' ] ) {

		const busy = await sampleGpuUtilisation( 2 );
		contended = busy === null ? '?' : busy.mean > 15 ? 'y' : 'n';
		if ( contended === 'y' ) console.log( `the GPU is ${ busy.mean } % busy before the captures: the run is logged as contended` );

	}
	let captured = [];
	if ( ! o[ 'metrics-only' ] ) captured = await capture( o, list, root );
	const captureMinutes = ( Date.now() - started ) / 60000;
	if ( o[ 'capture-only' ] ) {

		const failed = captured.filter( ( c ) => c.code );
		console.log( `captured ${ captured.length - failed.length } of ${ captured.length } in ${ captureMinutes.toFixed( 1 ) } min${ failed.length ? '; failed: ' + failed.map( ( c ) => `${ c.side } ${ c.e.key }` ).join( ', ' ) : '' }` );
		await logRun( o, started, captured.length, failed.length, path.join( root, o.label ), 'capture', contended );
		if ( failed.length ) process.exitCode = 1;
		return;

	}
	const t1 = Date.now();
	const thresholds = o.thresholds ? JSON.parse( await readFile( o.thresholds, 'utf8' ) ) : null;
	const result = await metrics( o, list, root );
	result.wall = { captureMinutes, metricsMinutes: ( Date.now() - t1 ) / 60000, captures: captured.length, failedCaptures: captured.filter( ( c ) => c.code ).map( ( c ) => `${ c.side } ${ c.e.key }` ) };
	// a partial run (some views or clips) merges into the existing file: the entries and failures it
	// did not measure stay, those it measured are replaced
	const file = path.join( root, o.label, 'metrics.json' );
	if ( existsSync( file ) && ( o.views || o.clips || o.only || o.tiers ) ) {

		const old = JSON.parse( await readFile( file, 'utf8' ) );
		const measured = new Set( list.map( ( e ) => e.key ) );
		result.entries = { ...old.entries, ...result.entries };
		result.failures = [ ...( old.failures ?? [] ).filter( ( f ) => ! measured.has( f.split( ':' )[ 0 ] ) ), ...result.failures ];
		result.wall.previous = old.wall;

	}
	result.entries = Object.fromEntries( Object.entries( result.entries ).sort( ( [ a ], [ b ] ) => a < b ? - 1 : 1 ) );
	// the aggregates over every entry of the file, merged ones included
	result.aggregates = aggregates( thresholds, result );
	await mkdir( path.dirname( file ), { recursive: true } );
	await writeFile( file, JSON.stringify( result, null, 1 ) );
	const minutes = ( Date.now() - started ) / 60000;
	console.log( `${ file }: ${ Object.keys( result.entries ).length } entries, ${ result.failures.length } failures, ${ minutes.toFixed( 1 ) } min (capture ${ captureMinutes.toFixed( 1 ) })` );
	for ( const f of [ ...result.wall.failedCaptures.map( ( c ) => `capture failed: ${ c }` ), ...result.failures ] ) console.log( '  ' + f );
	const noisy = Object.entries( result.entries ).filter( ( [ , e ] ) => e.console?.length );
	if ( noisy.length ) console.log( `  console errors in ${ noisy.length } entries: ${ noisy.map( ( [ k, e ] ) => `${ k } (${ e.console.length })` ).join( ', ' ) }` );
	for ( const a of result.aggregates ) console.log( `  aggregate ${ a.gate }: ${ a.verdict } (${ a.passing }/${ a.views }, worst ${ a.worst.toFixed( 3 ) })` );
	await logRun( o, started, captured.length, result.wall.failedCaptures.length + result.failures.length, path.join( root, o.label ), o[ 'metrics-only' ] ? 'metrics' : 'capture+metrics', contended );
	if ( result.wall.failedCaptures.length || result.failures.length ) process.exitCode = 1;

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) main().catch( ( e ) => { console.error( e.message ?? e ); process.exit( 2 ); } );
