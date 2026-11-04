// Regression probe for the exact scene jump (src/main.ts `establishScene`): a parity view reached by
// a jump within one page must be the frame a fresh load of its query draws. It captures the views
// both ways, in the layout of tools/parity/capture-set.mjs, so tools/parity/diff-set.py judges them:
//
//   node tools/verify-scene-jump.mjs <baseUrl> <outDir> [--fresh | --legacy] [--retune] [--views parity|taa|all|normal|special|a,b,c]
//       [--view "name:query[::js]"]...
//       [--order list|reverse] [--from <view or query>]... [--between <view or query>]...
//       [--suffix .repeat] [--quality high]
//       [--aa mode] [--q "extra&query"] [--size 1728x1117@2] [--frames n] [--stable-* (as capture.mjs)]
//       [--profile dir] [--timeout 240000]
//   node tools/verify-scene-jump.mjs <baseUrl> <outDir> --check <root>/<sha>/<set> [same options]
//
// --view adds an ad-hoc view (repeatable), with capture-set.mjs's syntax and parser
// (tools/parity/adhoc.mjs, whose header has the rules: `like=<view>` starts from a views.mjs view, the
// view's own options win over the set's). The ad-hoc views follow --views's in the run's list; with
// --view and no --views the list is just the ad-hoc views (no --views and no --view: all). So a new
// scene option is checked as `--views island-fair-noon --view approach-half:approach=0.5` rather than
// pieced together from --q and --from. One page reaches every view, so the views must share their
// load-time options (adhoc.mjs loadSignature; establishScene refuses the others). Under --check the
// fresh side's set stores each ad-hoc view with its definition's hash, as capture-set's: a stored
// fresh load of the same name and definition is reused, a changed query or eval captures it again.
//
// --check runs the whole check in one command: the fresh side, the jump side in both orders into
// <outDir>, then diff-set.py (`--aa-floor`, `--temporal` for aa=taa|taau|fsr3|gt; its table also in
// <outDir>/diff.txt; its exit code is the check's). The fresh side is the reference store's set of
// the commit (tools/parity/reference.mjs, through capture-set.mjs `--reference --repeat
// --page-per-view` with the same views and options, so it is keyed like every capture-set set): a
// fresh page per view, so the jump is compared with fresh loads, never with itself (the key's
// `pages: 'view'`; a set reached by jumps is refused). A stored set of the commit is reused, else
// capture-set captures it, still parallel (default --jobs). The URL must serve that commit
// (capture-set checks it). The two jump orders (the list, and the reverse with
// `--suffix .repeat`) are independent pages, so they run at once, as two child processes of this
// tool, each with its own browser profile (`<profile>` and `<profile>-reverse`) and its own leased
// slot. A full 24-view check used to run as four commands through one page at a time, the fresh
// loads alone two thirds of it; `--fresh` still captures fresh loads into <outDir> by hand.
// --fresh: one fresh page load per view (a new page in the same browser), as capture-set loads it.
// Otherwise one page for the whole list: it loads the first scene (the first `--from`, else the
// first view), then visits each `--from` scene in turn without capturing it (a view's name, or a
// query of its own such as "weather=storm&preset=noon&t=5"), then each view in `--order`, each one
// after the `--between` scenes if any (so every view is reached from them): the jump
// `await __PONLAI__.establishScene( query )` (the view's full query: the common part and its own),
// a frame rendered at the jump's camera, the view's eval, readiness, the shot.
// --legacy jumps the way builds before the exact jump could: establishScene's options (weather,
// preset or hour, time) and the camera reset to the island view (capture-tooling plan 3.2).
// --retune rebakes the sky on every scene visited, after the view's eval, through each path a
// retune takes, before readiness: `refreshEnvironment()` (a new hour's or a seek's bake), a tunable
// the bake reads set and set back through `tune.set` (`sky.atmosphere.mieG`, the aerosol lobe the
// sky and the haze share), and the haze over the sky switched off and on as the GUI switches it (a
// plain write of `pipeline.air.settings.sky`, which the frame loop finds: main.ts `retuneSky`), each
// bake awaited. The page must still draw the fresh
// load's frame: every explicit bake starts from the state before a page's first (Sky.ts `reset`).
// After each round trip the sky's irradiance must be the page's own bit for bit, and the switch must
// change it (else the run fails, the readings in the shot's JSON as `ready.retune`).
// Readiness is capture.mjs's by default (tools/capture-browser.mjs, "Readiness by stability"):
// after the evals the floor's frames and the loading screen gone (waitForScene), a temporal page's
// rest restarted and converged, then the image grabbed with the loop stopped until two grabs agree
// (waitForStable, the `--stable-*` options as capture.mjs's; a temporal page is shot on its held
// rest). A page still changing at the cap is shot anyway and printed as unstable. The loop stays
// stopped for the screenshot (its last frame on the canvas); the next jump starts it again. A fixed
// wait settled pages off their settled image under GPU load, so the views wandered between loads.
// `--frames n` keeps the old fixed rule: n rendered frames after the evals, then the rest and the
// stop. A persistent browser profile (`--profile`, one browser at a time) keeps the world cache and
// the shader cache across runs.
// Writes `<outDir>/<view><suffix>.png` and `.json` (the page's diagnostics, the crop anchors, the
// scene it was reached from, `ready`: the readiness record, as capture.mjs's). Compare two sets
// with diff-set.py: the fresh set taken twice (`--suffix .repeat`) as the reference, and a jump set in two orders (list, then reverse with
// `--suffix .repeat`) as the test, `--aa-floor` for MSAA, `--temporal` for taa, taau and fsr3.
// The page renders paused, so the GPU lock is taken shared, and leased per view as capture.mjs's
// worker leases it (gpu-lock.mjs `leaseGpuLock`, 20 s): kept from one view to the next while nobody
// waits, given up at a view boundary for a waiter ranked before it after 20 s of holding. The page
// stays open across a yield with its loop stopped (every view ends with the shot's stopped loop),
// and the next jump starts it again under the slot. It used to hold one slot for the whole run.
// The closing line gives the run's time and how much of it went to waiting for the lock.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { leaseGpuLock, releaseGpuLock } from './gpu-lock.mjs';
import { waitForScene, waitForSettled, waitForStable, stableOptions, stopLoop } from './capture-browser.mjs';
import { VIEWS, viewEval } from './parity/views.mjs';
import { selectViews, viewQuery } from './parity/adhoc.mjs';

const argv = process.argv.slice( 2 );
const flags = new Set( [ 'fresh', 'legacy', 'retune' ] );
const options = {}, positional = [], from = [], between = [], adhoc = [];
for ( let i = 0; i < argv.length; i ++ ) {

	if ( ! argv[ i ].startsWith( '--' ) ) { positional.push( argv[ i ] ); continue; }
	const k = argv[ i ].slice( 2 );
	if ( flags.has( k ) ) options[ k ] = true;
	else if ( k === 'from' ) from.push( argv[ ++ i ] );
	else if ( k === 'between' ) between.push( argv[ ++ i ] );
	else if ( k === 'view' ) adhoc.push( argv[ ++ i ] );
	else options[ k ] = argv[ ++ i ];

}
const known = [ 'fresh', 'legacy', 'retune', 'check', 'views', 'order', 'suffix', 'quality', 'aa', 'q', 'size', 'frames', 'profile', 'timeout',
	'stable-min', 'stable-every', 'stable-repeats', 'stable-tolerance', 'stable-patience', 'stable-cap' ];
const unknown = Object.keys( options ).filter( ( k ) => ! known.includes( k ) );
if ( positional.length !== 2 || unknown.length ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : 'usage: verify-scene-jump.mjs <baseUrl> <outDir> [options] (see the file header)' );
	process.exit( 2 );

}
let [ base, outDir ] = positional;
if ( ! base.endsWith( '/' ) && ! base.includes( '?' ) ) base += '/';
outDir = path.resolve( outDir );
// capture-set's selection (adhoc.mjs), ad-hoc views registered into VIEWS; this tool's default
// stays every view when neither --views nor --view is given
let views;
try { views = selectViews( { views: options.views ?? ( adhoc.length ? undefined : 'all' ), view: adhoc } ); } catch ( error ) { console.error( error.message ); process.exit( 2 ); }
const listed = [ ...views ];
if ( options.order === 'reverse' ) views.reverse();
const size = ( options.size ?? '1728x1117@2' ).match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
if ( ! size ) { console.error( `bad --size ${ options.size }` ); process.exit( 2 ); }
const [ , W, H, scale = '1' ] = size.map( ( s, i ) => i ? Number( s ) : s );
let common = `debug&paused&t=12&quality=${ options.quality ?? 'high' }`;
if ( options.aa ) common += `&aa=${ options.aa }`;
if ( options.q ) common += `&${ options.q }`;
const suffix = options.suffix ?? '';
const frames = options.frames === undefined ? null : Number( options.frames );
const stable = stableOptions( ( k ) => options[ k ] );
const timeout = Number( options.timeout ?? 240000 );
const profile = path.resolve( options.profile ?? 'artifacts/.capture-profiles/scene-jump' );
// a view's scene: its full query and eval; a raw query (a `--from` scene) has no eval
// (whose options replace the common ones: the page reads the first of a repeated option)
const merged = ( q ) => { const p = new URLSearchParams( common ); for ( const [ k, value ] of new URLSearchParams( q ) ) p.set( k, value ); return p.toString(); };
const scene = ( v ) => VIEWS[ v ] ? { name: v, q: viewQuery( v, common ), eval: viewEval( v ) } : { name: v, q: merged( v ), eval: null };

// the slot lease from view to view, in ms (capture.mjs's --lease: see the header)
const LEASE = 20000;

if ( options.check ) process.exit( await check() );

await mkdir( outDir, { recursive: true } );
await mkdir( profile, { recursive: true } );
const context = await chromium.launchPersistentContext( profile, {
	headless: true,
	...( process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chromium' } ),
	args: [ '--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu', '--disable-gpu-vsync', '--disable-frame-rate-limit' ],
	viewport: { width: W, height: H }, deviceScaleFactor: scale,
} );
const browser = context.browser()?.version() ?? null;
let failed = 0, lockWaited = 0;
const started = Date.now();

// the GPU slot before a view's work: kept from the view before while the lease allows, else
// queued for (the loop is stopped meanwhile: every view ends with its shot's stopped loop)
async function slot( v ) {

	const { waitMs } = await leaseGpuLock( `verify-scene-jump ${ v }${ suffix }`, { shared: true, budget: LEASE } );
	lockWaited += waitMs;
	return waitMs;

}

async function open( q ) {

	const page = await context.newPage();
	const errors = [];
	page.on( 'console', ( m ) => { if ( m.type() === 'error' ) errors.push( 'error: ' + m.text() ); } );
	page.on( 'pageerror', ( e ) => errors.push( 'pageerror: ' + e.message ) );
	await page.goto( `${ base }?${ q }` );
	await page.waitForFunction( () => window.__PONLAI__ && window.__THREE_GAME_DIAGNOSTICS__, null, { timeout } );
	return { page, errors };

}

// the view's evals run, then readiness as capture.mjs's by default (tools/capture-browser.mjs): the
// floor's frames and the loading screen gone, a temporal page's rest restarted and converged, the
// page's settled signal (the fresh side's capture.mjs waits for it too: stability alone can shoot a
// jump before the page's last change, such as a pre-exposure read back late), then the image stable
// (or the rest held) with the loop stopped; `--frames n` waits that fixed count instead. Returns the
// record the shot's JSON keeps as `ready`.
async function settle( page, js ) {

	if ( js ) await page.evaluate( js );
	const retuned = options.retune ? await retune( page ) : null;
	await waitForScene( page, { frames: frames ?? stable.min, timeout } );
	await page.evaluate( () => window.__PONLAI__.taa?.epoch.bump( 'capture' ) );
	await page.waitForFunction( () => {

		const t = window.__THREE_GAME_DIAGNOSTICS__?.taa;
		return ! t || t.restTarget === 0 || ( t.converged && t.restEpoch === window.__PONLAI__.taa.epoch.value );

	}, null, { timeout, polling: 100 } );
	if ( frames !== null ) {

		await stopLoop( page );
		return { rule: 'frames', frames, ...( retuned ? { retune: retuned } : {} ) };

	}
	const settled = await waitForSettled( page, { timeout } );
	const ready = await waitForStable( page, { ...stable, timeout } );
	ready.settled = settled;
	if ( retuned ) ready.retune = retuned;
	return ready;

}

// --retune (see the header): every path that rebakes the sky, the last one through the frame loop.
// The sky's irradiance (read back by every explicit bake) must come back to the page's own after each
// round trip, bit for bit, and the switch of the haze over the sky must change it (a bake ran);
// returns the readings and the failures, which fail the run.
async function retune( page ) {

	const record = await page.evaluate( async () => {

		const p = window.__PONLAI__, H = p.pipeline.air.settings;
		const frame = () => new Promise( ( resolve ) => requestAnimationFrame( () => resolve() ) );
		// the frame loop starts the bake (`retuneSky`) and holds while it runs
		const baked = async () => {

			for ( let i = 0; i < 2; i ++ ) await frame();
			while ( p.sky.busy ) await frame();
			for ( let i = 0; i < 2; i ++ ) await frame();

		};
		const irradiance = () => { const c = p.sky.skyIrradiance; return [ c.r, c.g, c.b ]; };
		const readings = { page: irradiance() }, failures = [];
		const same = ( a, b ) => a.every( ( v, i ) => v === b[ i ] );
		const back = ( name ) => { readings[ name ] = irradiance(); if ( ! same( readings[ name ], readings.page ) ) failures.push( `${ name }: the sky's irradiance ${ readings[ name ].join( ',' ) }, the page's ${ readings.page.join( ',' ) }` ); };
		await p.refreshEnvironment();
		back( 'refreshEnvironment' );
		const lobe = p.tune.get( 'sky.atmosphere.mieG' );
		p.tune.set( { 'sky.atmosphere.mieG': lobe + 0.02 } );
		await baked();
		p.tune.set( { 'sky.atmosphere.mieG': lobe } );
		await baked();
		back( 'tune.set' );
		H.sky = ! H.sky;
		await baked();
		readings.switched = irradiance();
		if ( same( readings.switched, readings.page ) ) failures.push( 'switching the haze over the sky left the sky\'s bake as it was' );
		H.sky = ! H.sky;
		await baked();
		back( 'switched back' );
		return { readings, failures };

	} );
	for ( const f of record.failures ) console.log( `retune: ${ f }` );
	if ( record.failures.length ) failed ++;
	return record;

}

async function shoot( page, view, ready, extra ) {

	if ( ready.status === 'capped' ) console.log( `${ view }${ suffix } unstable: still changing after ${ ready.framesWaited } frames (max ${ ready.maxSeen } levels), captured at the cap` );
	const file = path.join( outDir, `${ view }${ suffix }.png` );
	await page.screenshot( { path: file, timeout } );
	const diag = await page.evaluate( () => ( { ...window.__THREE_GAME_DIAGNOSTICS__ } ) );
	const crops = await page.evaluate( () => window.__PONLAI_CROPS__ ?? null );
	await writeFile( path.join( outDir, `${ view }${ suffix }.json` ), JSON.stringify( { browser, viewport: { width: W, height: H }, ...extra, ready, diag, ...( crops ? { crops } : {} ) }, null, 1 ) );

}

try {

	if ( options.fresh ) {

		for ( const v of views ) {

			const s = scene( v );
			await slot( v );
			const t0 = Date.now();
			const { page, errors } = await open( s.q );
			try {

				const ready = await settle( page, s.eval );
				await shoot( page, v, ready, { mode: 'fresh', query: s.q, errors } );
				console.log( `${ v }${ suffix } fresh ${ ready.status ?? ready.rule } ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s${ errors.length ? ' ERRORS ' + errors.slice( 0, 3 ).join( ' | ' ) : '' }` );
				if ( errors.length ) failed ++;

			} finally {

				await page.close();

			}

		}

	} else {

		const visits = [ ...from.map( ( v ) => ( { v, capture: false } ) ),
			...views.flatMap( ( v ) => [ ...between.map( ( b ) => ( { v: b, capture: false } ) ), { v, capture: true } ] ) ];
		await slot( visits[ 0 ].v );
		const t0 = Date.now();
		const { page, errors } = await open( scene( visits[ 0 ].v ).q );
		console.log( `loaded ${ visits[ 0 ].v } in ${ ( ( Date.now() - t0 ) / 1000 ).toFixed( 1 ) } s` );
		let previous = null;
		for ( let i = 0; i < visits.length; i ++ ) {

			const { v, capture } = visits[ i ];
			const s = scene( v );
			if ( i > 0 ) await slot( v );
			const t1 = Date.now();
			if ( i > 0 ) {

				const jumped = await page.evaluate( async ( { q, legacy } ) => {

					const p = window.__PONLAI__;
					if ( legacy ) {

						const o = new URLSearchParams( q );
						await p.establishScene( { weather: o.get( 'weather' ) ?? undefined, preset: o.get( 'preset' ) ?? undefined,
							hour: o.has( 'hour' ) ? Number( o.get( 'hour' ) ) : undefined, time: Number( o.get( 't' ) ?? 0 ) } );
						p.setCameraMode( 'orbit' );
						p.setCameraView( 'island' );

					} else await p.establishScene( q );
					p.loop.start();
					return p.renderer.info.frame;

				}, { q: s.q, legacy: options.legacy === true } );
				// a frame at the jump's camera before the eval moves it, as a fresh load renders its
				// first frames before a capture's eval runs (main.ts `establishScene`)
				await page.waitForFunction( ( f ) => window.__PONLAI__.renderer.info.frame > f, jumped, { timeout, polling: 'raf' } );

			}
			const ready = await settle( page, s.eval );
			if ( capture ) await shoot( page, v, ready, { mode: i > 0 ? 'jump' : 'load', query: s.q, from: previous, errors: errors.splice( 0 ) } );
			console.log( `${ v }${ capture ? suffix : ' (not captured)' } ${ ready.status ?? ready.rule } ${ i > 0 ? `jump from ${ previous }` : 'load' } ${ ( ( Date.now() - t1 ) / 1000 ).toFixed( 1 ) } s` );
			previous = v;

		}
		if ( errors.length ) { console.log( 'page errors: ' + errors.slice( 0, 6 ).join( ' | ' ) ); failed ++; }
		await page.close();

	}

} finally {

	await context.close();
	releaseGpuLock();

}
console.log( `${ views.length } views in ${ ( ( Date.now() - started ) / 1000 ).toFixed( 1 ) } s (${ ( lockWaited / 1000 ).toFixed( 1 ) } s of it waiting for the GPU lock)${ failed ? `, ${ failed } with page errors${ options.retune ? ' or a failed retune' : '' }` : '' }` );
if ( failed ) process.exitCode = 1;

// --check: the whole check in one command (see the header). The fresh side is the commit's stored
// set (capture-set.mjs --reference --repeat --page-per-view: reused, or captured in parallel), the two
// jump orders run at once as two child processes of this tool (one page and one leased slot each,
// their own browser profiles), then diff-set.py. Resolves to the exit code.
async function check() {

	const here = fileURLToPath( import.meta.url );
	const repo = path.resolve( path.dirname( here ), '..' );
	const t0 = Date.now();
	const minutes = () => ( ( Date.now() - t0 ) / 60000 ).toFixed( 1 );
	const stableArgs = Object.keys( options ).filter( ( k ) => k.startsWith( 'stable-' ) ).flatMap( ( k ) => [ `--${ k }`, options[ k ] ] );
	// views.mjs's views by name, the ad-hoc ones as given (capture-set and the children register them
	// again; the fresh side's store keys them by their definitions' hashes)
	const named = listed.filter( ( v ) => ! VIEWS[ v ].adhoc );
	const common = [ ...( named.length ? [ '--views', named.join( ',' ) ] : [] ), ...adhoc.flatMap( ( v ) => [ '--view', v ] ), ...[ 'quality', 'aa', 'q', 'size', 'timeout' ].flatMap( ( k ) => options[ k ] === undefined ? [] : [ `--${ k }`, options[ k ] ] ) ];
	const run = ( label, argList, log ) => new Promise( ( resolve ) => {

		const child = spawn( process.execPath, argList, { cwd: repo, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		const chunks = [];
		let rest = '';
		const line = ( d ) => {

			chunks.push( d );
			const text = rest + d.toString();
			const lines = text.split( '\n' );
			rest = lines.pop();
			for ( const l of lines ) console.log( `[${ label }] ${ l }` );

		};
		child.stdout.on( 'data', line );
		child.stderr.on( 'data', line );
		child.on( 'close', async ( code ) => {

			if ( rest ) console.log( `[${ label }] ${ rest }` );
			if ( log ) await writeFile( log, Buffer.concat( chunks ) );
			resolve( { code: code ?? 1, out: Buffer.concat( chunks ).toString() } );

		} );

	} );

	// the fresh side: the stored set of this commit, a fresh page per view, captured when there is none
	const ref = await run( 'ref', [ path.join( repo, 'tools/parity/capture-set.mjs' ), base, '--reference', path.resolve( options.check ), '--repeat',
		'--page-per-view', '--procedure', 'verify-scene-jump ref', ...common, ...( stableArgs.length ? [ '--', ...stableArgs ] : [] ) ] );
	if ( ref.code !== 0 ) { console.error( `reference ${ options.check } failed (exit ${ ref.code })` ); return 2; }
	// the set that served it (another set of the commit with the same key may): capture-set's last
	// `reference <sha>/<set>: <status>` line, relative to the store's root
	const served = [ ...ref.out.matchAll( /^reference (\S+): (?:reused|waited|captured|extended)/gm ) ].pop()?.[ 1 ];
	const refDir = served ? path.join( path.dirname( path.dirname( path.resolve( options.check ) ) ), served ) : path.resolve( options.check );
	// a set reached by jumps would compare the jump with itself
	let manifest = null;
	try { manifest = JSON.parse( await readFile( path.join( refDir, 'complete.json' ), 'utf8' ) ); } catch { /* reported below */ }
	if ( manifest?.key?.pages !== 'view' ) {

		console.error( `reference ${ refDir }: its views were not each reached by a fresh load (key pages ${ JSON.stringify( manifest?.key?.pages ?? null ) }): not a fresh side` );
		return 2;

	}
	console.log( `fresh side: ${ refDir } (${ minutes() } min)` );

	// the jump side: both orders at once
	await mkdir( outDir, { recursive: true } );
	const own = [ ...[ 'legacy', 'retune' ].filter( ( k ) => options[ k ] ).map( ( k ) => `--${ k }` ), ...from.flatMap( ( v ) => [ '--from', v ] ),
		...between.flatMap( ( v ) => [ '--between', v ] ), ...( frames !== null ? [ '--frames', String( frames ) ] : [] ), ...stableArgs ];
	const jumps = await Promise.all( [
		run( 'list', [ here, base, outDir, ...common, ...own, '--profile', profile ] ),
		run( 'reverse', [ here, base, outDir, ...common, ...own, '--order', 'reverse', '--suffix', '.repeat', '--profile', `${ profile }-reverse` ] ),
	] );
	console.log( `jump side: ${ outDir } (${ minutes() } min)` );

	// diff-set.py, its table also in <outDir>/diff.txt (not `python -I`: it imports tolerance.py beside it)
	const temporal = [ 'taa', 'taau', 'fsr3', 'gt' ].includes( options.aa );
	const diffArgs = temporal ? [ '--temporal' ] : [ '--aa-floor' ];
	const diff = await new Promise( ( resolve ) => {

		const child = spawn( 'uv', [ 'run', '--with', 'numpy', '--with', 'pillow', 'python', path.join( repo, 'tools/parity/diff-set.py' ),
			refDir, outDir, '--views', listed.join( ',' ), '--out', path.join( outDir, 'diff' ), ...diffArgs ], { cwd: repo, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		const chunks = [];
		child.stdout.on( 'data', ( d ) => chunks.push( d ) );
		child.stderr.on( 'data', ( d ) => chunks.push( d ) );
		child.on( 'close', async ( code ) => { await writeFile( path.join( outDir, 'diff.txt' ), Buffer.concat( chunks ) ); resolve( { code: code ?? 1, out: Buffer.concat( chunks ).toString() } ); } );

	} );
	process.stdout.write( diff.out );
	const jumpFailed = jumps.filter( ( j ) => j.code !== 0 ).length;
	console.log( `check ${ diff.code === 0 && ! jumpFailed ? 'PASS' : 'FAIL' } against ${ refDir } (diff-set ${ diffArgs.join( ' ' ) }), ${ minutes() } min${ jumpFailed ? `; ${ jumpFailed } jump pages failed` : '' }` );
	return jumpFailed ? 1 : diff.code;

}
