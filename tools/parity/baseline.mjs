// The MSAA baseline of a merge-base (plan section 3.3): the rest images and stepped clips that the
// anti-aliasing gates read, captured from a preview of that commit, with the interim ground truth
// and the metrics of MSAA against it. Every gate in thresholds.json is a ratio or a band times
// this baseline, measured at the same merge-base in the same session, never an absolute number, so
// each later task on that sha reuses `<root>/<sha>/baseline/metrics.json` and measures only its own
// mode.
//
//   node tools/parity/baseline.mjs --url U --sha SHA [--root DIR] [--label baseline] [--aa msaa]
//       [--tiers high,medium,low] [--only rest|clips] [--views a,b] [--clips a,b] [--gt | --no-gt] [--gt-aa gt|gt-hi]
//       [--jobs 2] [--capture-only | --metrics-only] [--thresholds thresholds.json] [--runs runs.csv] [--task name]
//       [--ref-url R] [--recapture-reference] [--skip-existing] [--size 1728x1117@2] [--q "extra&query"] [--verbose]
//
// The plan (PLAN below): on high the 24 parity and TAA views at rest (the 17 parity views also as
// whole frames, for the overall fidelity gate) and the gates' clips; on medium and low six views at
// rest. Rest images go through tools/capture-clip.mjs as the one-frame clip `rest`, so their crops
// are cut exactly as a clip's are.
//
// Layout under <root>/<sha>/:
//   <label>/<tier>/rest/<view>/           a capture-clip folder (crops, clip.json, metrics/)
//   <label>/<tier>/clip/<clip>[@<view>]/  the same for a clip (on another view than its own: @view)
//   gt/<tier>/...                         the ground truth (`--aa gt`: 64 jittered renders at rest, 32
//                                         per clip frame), shared by every label; clips of more than 60
//                                         frames every 4th frame plus their dense runs (clips.mjs
//                                         gtSampling)
//   gt-hi/high/...                        the interim ground truth (`--gt-aa gt-hi`, high only): kept
//                                         for cross-checks against aa=gt
//   <label>/metrics.json                  every entry's metrics; for the label `baseline` (MSAA) this
//                                         is the baseline the gates multiply
//
// The baseline's and the ground truth's entries are references of the merge-base, kept by the
// reference store (reference.mjs, layout in tools/parity/README.md): each entry has its own
// manifest (`complete.json`: the clip tools' version, the browser build, tier, aa, size, extra
// query, clip, view, frame sampling and the anchors it took), so an entry is reused when it
// matches, waited for when another live process is capturing it, and otherwise captured (saying
// why: missing, the tools or the browser changed, a capture that did not finish). They are
// captured from the reference's own preview only: `--url` for the baseline's run, `--ref-url` for
// another label's (a test build's run), whose missing references are otherwise reported and their
// entries skipped. With --ref-url another label's run also captures the ground truth (as --gt).
// --skip-existing accepts an entry without a manifest or of another key as it is (references
// captured before the store) and skips the side under test where its clip.json exists;
// --recapture-reference captures the reference entries afresh. --clips may also name a clip that
// is not a gate's (`--clips drs-steps`): its baseline and ground truth are kept the same way.
//
// `--label x --aa taau` captures the same entries for another mode and measures them against the
// baseline's MSAA captures and the shared ground truth (with --thresholds: gate verdicts). The
// ground truth and other labels take the baseline's anchors (`--anchors-from`), so every side
// frames the same subjects. aa=gt renders every tier (at the canvas's resolution, the tier's own
// content), so each tier is measured against its own ground truth. Where a tier has none (gt-hi
// exists for high only) its metrics take high's ground truth of the same view, which cancels in
// every ratio to MSAA; their GT-relative values mean nothing and no gate reads them.
//
// Clips and rest frames are deterministic (the page's stepper), so captures take the GPU lock shared
// (capture-clip.mjs takes it). Wall times go to --runs (or PARITY_RUNS) and into metrics.json.
// Python metrics run through `uv run --with numpy --with pillow --with scipy --with flip-evaluator`.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { VIEWS, viewNames } from './views.mjs';
import { CLIPS, gtSampling } from './clips.mjs';
import { sampleGpuUtilisation } from '../gpu-lock.mjs';
import { ensureReference, clipKey, anchorsHash, checkServed } from './reference.mjs';

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

const FLAGS = new Set( [ 'gt', 'no-gt', 'metrics-only', 'capture-only', 'skip-existing', 'recapture-reference', 'verbose' ] );
const KNOWN = [ 'url', 'ref-url', 'sha', 'root', 'label', 'aa', 'tiers', 'only', 'views', 'clips', 'jobs', 'thresholds', 'runs', 'task', 'size', 'q', 'gt-aa', ...FLAGS ];

// the ground truth's folder under <root>/<sha>/ for each GT mode
const GT_LABEL = { gt: 'gt', 'gt-hi': 'gt-hi' };

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
		// clips named with --clips beyond the gates' (a task's own clip, such as drs-steps): its
		// baseline and ground truth are references of the merge-base like the gates'
		if ( o.only !== 'rest' && clips ) for ( const name of clips ) {

			if ( out.some( ( e ) => e.tier === tier && e.kind === 'clip' && ( e.name === name || e.clip === name ) ) ) continue;
			const [ clip, view ] = name.split( '@' );
			if ( ! CLIPS[ clip ] ) throw new Error( `unknown clip ${ clip }` );
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

// reference entries the run could not use (stale, missing, failed): metrics skip them
const unusable = new Map();

async function capture( o, list, root ) {

	const label = o.label, aa = o.aa;
	const size = o.size ?? '1728x1117@2';
	const common = [ ...( o.size ? [ '--size', o.size ] : [] ), ...( o.q ? [ '--q', o.q ] : [] ),
		...( o.runs ? [ '--runs', o.runs ] : [] ), ...( o.task ? [ '--task', o.task ] : [] ) ];
	// where the reference sides (the MSAA baseline, the ground truth) are captured from: they are
	// the merge-base's, so the baseline's own run's URL or --ref-url, never a test build's
	const refUrl = o[ 'ref-url' ] ?? ( label === 'baseline' ? o.url : null );
	let served = null;
	const checkRefServed = () => { served ??= checkServed( refUrl, o.sha ); };
	const clipArgs = ( url, side, e, mode, dir, extra ) => [ path.join( TOOLS, 'capture-clip.mjs' ), `${ side }-${ e.tier }-${ e.name }`, '--url', url, ...common,
		'--clip', e.clip, '--view', e.view, '--quality', e.tier, '--aa', mode, '--out', dir, ...( e.full ? [ '--full', '0' ] : [] ), ...extra ];
	// every entry's baseline (the side itself for the baseline's run, else the anchors and the
	// metrics' MSAA), the side under test for other labels, and (with --gt) the ground truth with
	// the baseline's anchors
	const jobs = [], gtJobs = [];
	for ( const e of list ) {

		// anchors: the baseline's high entry, except for the baseline's own high entry
		const highAnchors = path.join( entryDir( root, 'baseline', e.tier === 'high' ? e : { ...e, tier: 'high' } ), 'clip.json' );
		const ownAnchors = e.tier === 'high';
		jobs.push( { e, side: 'baseline', store: true, mode: 'msaa', dir: entryDir( root, 'baseline', e ), needs: ownAnchors ? null : highAnchors, sampling: { every: 1, dense: [] } } );
		if ( label !== 'baseline' ) jobs.push( { e, side: label, mode: aa, dir: entryDir( root, label, e ), needs: highAnchors } );

	}
	// the ground truth: captured with --gt (from the reference's URL); else only waited for or reused
	// when the metrics will read it
	if ( o.gt || ( ! o[ 'no-gt' ] && ! o[ 'capture-only' ] ) ) for ( const e of list ) {

		// gt-hi exists for high only; aa=gt renders every tier
		if ( o[ 'gt-aa' ] === 'gt-hi' && e.tier !== 'high' ) continue;
		const side = GT_LABEL[ o[ 'gt-aa' ] ];
		gtJobs.push( { e, side, store: true, capture: !! o.gt, mode: o[ 'gt-aa' ], dir: entryDir( root, side, e ), needs: path.join( entryDir( root, 'baseline', e ), 'clip.json' ),
			sampling: gtSampling( CLIPS[ e.clip ] ) } );

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
	const report = ( j, code, t0, out, extra = '' ) => {

		// on a failure the first line naming an error (the last line is often only node's version,
		// and a thrown error's dump ends in `name: 'Error'`), else the first line
		const lines = ( out ?? '' ).trim().split( '\n' ).filter( ( l ) => l.trim() );
		const line = code ? ( lines.find( ( l ) => /Error:|ERR_|error:|failed/i.test( l ) ) ?? lines[ 0 ] ?? '' ) : '';
		console.log( `${ code ? 'FAIL' : 'ok  ' } ${ j.side } ${ j.e.key } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 0 ) } s${ extra }${ code ? ': ' + line + ' (' + path.join( j.dir, 'capture.log' ) + ')' : '' }` );

	};
	const one = async ( j ) => {

		const finish = ( r ) => { done.push( r ); writers.get( path.join( j.dir, 'clip.json' ) ).resolve(); };
		if ( j.needs && writers.has( j.needs ) ) await writers.get( j.needs ).promise;
		if ( j.needs && ( ! existsSync( j.needs ) || unusable.has( path.dirname( j.needs ) ) ) ) {

			console.log( `skip ${ j.side } ${ j.e.key }: no baseline anchors (${ j.needs }${ unusable.has( path.dirname( j.needs ) ) ? ': ' + unusable.get( path.dirname( j.needs ) ) : '' })` );
			if ( j.store ) unusable.set( j.dir, 'no baseline anchors' );
			finish( { ...j, code: 2 } );
			return;

		}
		const t0 = Date.now();
		if ( j.store ) {

			// a reference entry (reference.mjs): reused, waited for, or captured from the reference's URL
			const extra = [ ...( j.sampling.every > 1 ? [ '--every', String( j.sampling.every ) ] : [] ),
				...( j.sampling.dense.length ? [ '--dense', j.sampling.dense.map( ( r ) => r.join( '-' ) ).join( ',' ) ] : [] ),
				...( j.needs ? [ '--anchors-from', j.needs ] : [] ) ];
			const { key, files } = await clipKey( { tier: j.e.tier, aa: j.mode, size, q: o.q ?? null, clip: j.e.clip, view: j.e.view, full: j.e.full,
				every: j.sampling.every, dense: j.sampling.dense, anchors: j.needs ? anchorsHash( j.needs ) : null } );
			let out = '';
			const r = await ensureReference( {
				dir: j.dir, kind: 'clip', key, files, url: j.capture === false ? null : refUrl, acceptStale: o[ 'skip-existing' ], force: o[ 'recapture-reference' ],
				label: `baseline ${ o.task ?? '' } ${ j.side } ${ j.e.key }`,
				capture: async ( todo, dir ) => {

					checkRefServed();
					const c = await run( process.execPath, clipArgs( refUrl, j.side, j.e, j.mode, dir, extra ), { log: path.join( dir, 'capture.log' ), verbose: o.verbose } );
					out = c.out;
					return { coverage: c.code === 0 && existsSync( path.join( dir, 'clip.json' ) ) ? { captured: true } : null, failed: c.code ? 1 : 0 };

				},
			} );
			const ok = [ 'reused', 'waited', 'captured' ].includes( r.status );
			if ( ! ok ) unusable.set( j.dir, r.reason ?? r.status );
			if ( r.status === 'unavailable' ) console.log( `skip ${ j.side } ${ j.e.key }: the reference must be captured (${ r.reason })${ refUrl ? '' : `: pass --ref-url <a preview of ${ o.sha.slice( 0, 12 ) }>${ j.capture === false ? ' and --gt' : '' }` }` );
			else report( j, ok ? 0 : 1, t0, out || r.error, ` (reference ${ r.status }${ r.stale ? ', stale: ' + r.stale : '' })` );
			finish( { ...j, code: ok ? 0 : r.status === 'unavailable' ? 2 : 1, reference: r.status } );
			return;

		}
		if ( o[ 'skip-existing' ] && existsSync( path.join( j.dir, 'clip.json' ) ) ) { finish( { ...j, code: 0, skipped: true } ); return; }
		await rm( j.dir, { recursive: true, force: true } );
		await mkdir( j.dir, { recursive: true } );
		const r = await run( process.execPath, clipArgs( o.url, j.side, j.e, j.mode, j.dir, [ '--anchors-from', j.needs ] ), { log: path.join( j.dir, 'capture.log' ), verbose: o.verbose } );
		report( j, r.code, t0, r.out );
		finish( { ...j, code: r.code } );

	};
	// the baseline and the side's own captures first (the GT needs the baseline's anchors), high
	// before the lower tiers
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
		// the tier's own ground truth, else high's (which then cancels in every ratio to MSAA)
		const ownGt = existsSync( path.join( entryDir( root, GT_LABEL[ o[ 'gt-aa' ] ], e ), 'clip.json' ) );
		const gt = entryDir( root, GT_LABEL[ o[ 'gt-aa' ] ], ownGt ? e : { ...e, tier: 'high' } );
		const bad = [ msaa, gt ].find( ( d ) => unusable.has( d ) );
		if ( bad ) { out.failures.push( `${ e.key }: reference ${ path.relative( root, bad ) } unusable (${ unusable.get( bad ) })` ); return; }
		if ( ! existsSync( path.join( test, 'clip.json' ) ) || ! existsSync( path.join( msaa, 'clip.json' ) ) || ! existsSync( path.join( gt, 'clip.json' ) ) ) {

			out.failures.push( `${ e.key }: missing captures` );
			return;

		}
		const args = [ ...python, '--test', test, '--msaa', msaa, '--gt', gt, '--out', path.join( test, 'metrics' ), '--key', e.key,
			...( e.full ? [ '--crops', [ ...cropNames( gt ), 'full' ].join( ',' ) ] : [] ),
			...( label !== 'baseline' && existsSync( baselineFile ) ? [ '--baseline', baselineFile ] : [] ),
			...( o.thresholds ? [ '--thresholds', o.thresholds ] : [] ),
			// high's GT standing in for a lower tier's cancels in every ratio to MSAA, so no GT gate reads it
			...( ownGt ? [] : [ '--no-gt-gates' ] ) ];
		const t0 = Date.now();
		const r = await run( 'uv', args, { log: path.join( test, 'metrics.log' ) } );
		const file = path.join( test, 'metrics', 'metrics.json' );
		if ( ! existsSync( file ) ) { out.failures.push( `${ e.key }: clip-metrics failed (${ r.out.trim().split( '\n' ).pop() })` ); return; }
		const m = JSON.parse( await readFile( file, 'utf8' ) );
		// the console gate (IQ-console): errors, page errors and WebGPU validation messages in the capture
		const testClip = JSON.parse( await readFile( path.join( test, 'clip.json' ), 'utf8' ) );
		const logged = testClip.errors ?? [];
		const consoleErrors = logged.filter( ( l ) => /^(error|pageerror):/.test( l ) || /validation|GPUValidationError/i.test( l ) );
		// upscaled: the render is smaller than the canvas (FSR 1, EASU or TAAU bring it up), which
		// sets the alignment bound (aggregates)
		const vp = testClip.viewport, render = testClip.boxes?.[ 0 ]?.render;
		const upscaled = vp && render ? render[ 0 ] < Math.round( vp.width * vp.deviceScaleFactor ) : null;
		out.entries[ e.key ] = { tier: e.tier, kind: e.kind, clip: e.clip, view: e.view, metric: m.metric, gates: m.gates ?? null, console: consoleErrors, upscaled,
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


/** Aggregate gates over entries (thresholds.json `aggregates`): a share of views passing a ratio,
 * or (`medianVector`) the length of the median signed shift (per component) over every named crop
 * of the entries against a bound, `maxNative` when no entry is upscaled, else `max`: a jitter or
 * reprojection bias moves every crop the same way, while an upscaler's content-dependent offsets
 * (up to half a pixel on single crops of the lower tiers) do not move the median. */
function aggregates( thresholds, result ) {

	const out = [];
	for ( const g of thresholds?.aggregates ?? [] ) {

		if ( g.type === 'medianVector' ) {

			const xs = [], ys = [];
			let upscaled = false;
			for ( const [ key, e ] of Object.entries( result.entries ) ) {

				if ( ! key.startsWith( g.prefix ) ) continue;
				if ( e.upscaled !== false ) upscaled = true;
				for ( const [ crop, c ] of Object.entries( e.crops ) ) {

					if ( crop === 'full' || c.missing ) continue;
					const x = c.test?.[ g.metric + 'X' ], y = c.test?.[ g.metric + 'Y' ];
					if ( typeof x === 'number' && typeof y === 'number' ) { xs.push( x ); ys.push( y ); }

				}

			}
			const median = ( a ) => { const b = a.slice().sort( ( p, q ) => p - q ), h = b.length >> 1; return b.length % 2 ? b[ h ] : ( b[ h - 1 ] + b[ h ] ) / 2; };
			const worst = xs.length ? Math.hypot( median( xs ), median( ys ) ) : 0;
			if ( ! xs.length ) continue;
			const bound = upscaled ? g.max : g.maxNative;
			out.push( { gate: g.gate, prefix: g.prefix, views: xs.length, passing: null, worst, bound, upscaled, verdict: worst <= bound + 1e-12 ? 'PASS' : 'FAIL' } );
			continue;

		}

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
	const line = [ new Date( started ).toISOString(), o.task ?? '', `baseline ${ what } ${ o.label } ${ o.aa }${ o.gt && what !== 'metrics' ? ' +' + o[ 'gt-aa' ] : '' } ${ ( o.tiers ?? 'high,medium,low' ).replace( /,/g, '+' ) }${ o.only ? ' ' + o.only : '' }${ o.views ? ' views=' + o.views.replace( /,/g, ' ' ) : '' }${ o.clips ? ' clips=' + o.clips.replace( /,/g, ' ' ) : '' }`, o.sha,
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
	o[ 'gt-aa' ] ??= 'gt';
	if ( ! GT_LABEL[ o[ 'gt-aa' ] ] ) throw new Error( `--gt-aa is gt or gt-hi, not ${ o[ 'gt-aa' ] }` );
	if ( o[ 'no-gt' ] ) o.gt = false;
	else if ( o.gt === undefined ) o.gt = o.label === 'baseline' || !! o[ 'ref-url' ];
	// the full sha, so every task meets in one directory whichever form it was given
	try { o.sha = execFileSync( 'git', [ 'rev-parse', '--verify', '--quiet', `${ o.sha }^{commit}` ], { cwd: TOOLS, encoding: 'utf8' } ).trim() || o.sha; } catch { /* not a commit here: kept as given */ }
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
	for ( const a of result.aggregates ) console.log( a.bound === undefined ? `  aggregate ${ a.gate }: ${ a.verdict } (${ a.passing }/${ a.views }, worst ${ a.worst.toFixed( 3 ) })`
		: `  aggregate ${ a.gate } ${ a.prefix }: ${ a.verdict } (median offset ${ a.worst.toFixed( 4 ) } px over ${ a.views } crops, bound ${ a.bound }${ a.upscaled ? ', upscaled' : ', native' })` );
	await logRun( o, started, captured.length, result.wall.failedCaptures.length + result.failures.length, path.join( root, o.label ), o[ 'metrics-only' ] ? 'metrics' : 'capture+metrics', contended );
	if ( result.wall.failedCaptures.length || result.failures.length ) process.exitCode = 1;

}

if ( process.argv[ 1 ] && path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url ) ) main().catch( ( e ) => { console.error( e.message ?? e ); process.exit( 2 ); } );
