// Side-by-side look reviews of the growing island: captures a set of views of a base and a
// candidate page at given seeds and growth steps, and writes a page that sets them next to each
// other with region statistics and pixel differences per pair.
//
//   node tools/capture-growth.mjs --base url [--cand url] [--seeds 1] [--grow 0,12] [--views v1,v3]
//     [--label name] [--q "extra&query"] [--jobs 2] [--base-ref sha] [--recheck 1]
//     [--recheck-px 64] [--recheck-level 2] [--retries 1] [--timeout 240000] [--page-per-view]
//
// Views: v1 overview (at noon and in golden hour), v2 top-down (polar 8 degrees), v3 cliff close,
// v4 meadow close, v5 rim close, v6 sea floor; the close views at noon. Every shot is headless,
// paused, 1672 x 941, with `debug` added to the query (a production build exposes `__PONLAI__`
// only with it). A URL's own query parameters, and then `--q`, pass through to every shot of it
// and override the tool's own (debug, paused, t, dpr, preset, weather, seed, grow).
//
// Pages. Generating a grown world cold takes seconds to a minute, and a page per shot generated it
// for every shot (two thirds of a 42-shot run's wall time). So the shots are grouped by side and by
// what a page reads once at load (every query option outside the scene's own, SCENE_OPTIONS below
// as src/main.ts lists them: seed and grow choose the world; quality, aa, dpr, the debug switches),
// and each group is one `tools/capture.mjs --worker` page driven over its IPC channel, as
// tools/parity/capture-set.mjs drives it: the group's first view is a fresh load, every later one
// is reached by the exact scene jump (`__PONLAI__.establishScene`), so a group's world is built
// once. --jobs pages run at once (default 2), one group each. The worker takes the GPU lock itself,
// shared: a load only once its world is generated (capture.mjs, "The slot after the world"), then
// leased from view to view; the page's frame loop is stopped before each shot, so this tool holds
// no lock across the world's CPU work and no frame renders without one; between views a page
// stands stopped.
// - A view that fails, or a page that dies or goes silent (no answer within 3 x --timeout + 2 min
//   of the view taking its GPU slot: killed), is shot again once (--retries) on a fresh page, and
//   the group's remaining views go on that page. A view whose PNG was written but whose page
//   logged errors counts as shot (its messages listed, as before); its page ends all the same.
// - A build without the exact scene jump (`__PONLAI__.sceneJump`) gets a page per view, as does
//   --page-per-view.
// - A view must not depend on the view before it: placeCamera starts from the page's load state
//   (see there). The worker's JSON keeps how each view was reached (`page`: load or jump, from).
//
// The world cache (src/world/WorldCache.ts) lives in the browser profile and keeps the two most
// recently loaded land versions per origin, and capture.mjs takes the lowest free profile slot, so
// a group would land in whichever slot was free and evict another group's world there. Each group
// therefore runs in a profile root of its own (PONLAI_CAPTURE_PROFILES =
// `<main checkout>/artifacts/.capture-profiles/growth/<side>-s<seed>-g<grow>`, under the
// variable's own root when it is set): a repeat of a run finds every group's world in its cache.
// The first run in a new root also compiles the shaders cold.
//
// --base-ref <sha> keeps the base side's shots as references of that commit, one entry per shot
// under `<main checkout>/artifacts/captures/growth-ref/<sha>/<shot key>-<hash>/` (shot.png,
// shot.json; the store's manifest, tools/parity/reference.mjs, written last). The hash covers what
// changes the pixels: the size, the full query, placeCamera's code, the capture tools
// (capture.mjs, capture-browser.mjs) and the browser build. An entry already there is reused
// instead of captured; one that another live process is capturing is waited for. The base URL must
// serve that commit: the page does not tell its commit, so the tool asks which worktree serves the
// port (reference.mjs `checkServed`) and refuses another commit or uncommitted changes, and trusts
// the URL when it cannot tell.
//
// Writes artifacts/captures/growth/<label>/index.html (a label already used is refused; the default
// is the start time to the second and the pid) (and stats.json, the shots and each view's
// log). Each pair's crops (the whole frame, its centre and its upper and lower bands) are measured
// with compare-captures.py's `metrics` (`uv run --with pillow --with numpy`) plus the mean
// saturation; deltas beyond 10 % are flagged. Each pair also gets its pixel difference: the pixels
// that differ at all and the largest channel difference, on the decoded PNGs (their bytes depend on
// the encoder). A pair whose difference is tiny (at most --recheck-px pixels, at most
// --recheck-level levels; not zero) may be the page's own frame noise, so with --recheck 1 (the
// default; 0 turns it off) both sides are shot again on fresh pages (the group's rechecks in reverse
// order, so each is reached from another view) and the pair is reported with both measurements as
// identical (the second pair is the same pixels: the first difference was noise), repeatable (each
// side shot its first image again: a real difference) or not repeatable. Shapes differ between
// steps and builds, so judge the look by eye and the statistics; the pixel difference matters where
// the two sides should draw the same.
import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareFrames, decodePng } from './capture-browser.mjs';
import { browserBuild, checkServed, ensureReference, stable } from './parity/reference.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const args = process.argv.slice( 2 );
const opt = ( k, d ) => { const i = args.indexOf( '--' + k ); return i >= 0 ? args[ i + 1 ] : d; };
const list = ( k, d ) => opt( k, d ).split( ',' ).map( ( v ) => v.trim() ).filter( Boolean );

const base = opt( 'base', 'http://127.0.0.1:5190/' );
const cand = opt( 'cand', '' );
const seeds = list( 'seeds', '1' );
const grows = list( 'grow', '0,12' );
const views = list( 'views', 'v1,v2,v3,v4,v5,v6' );
// the default names each run by its second and pid: two runs in one minute once shared a folder,
// and the second overwrote the first's stats.json
const label = opt( 'label', `${ new Date().toISOString().slice( 0, 19 ).replace( /[:T]/g, '-' ) }-${ process.pid }` );
const extra = opt( 'q', '' );
const jobs = Math.max( 1, Number( opt( 'jobs', 2 ) ) );
const retries = Math.max( 0, Number( opt( 'retries', 1 ) ) );
// capture.mjs's waits for the page: generous, since other pages may share the GPU
const timeout = Number( opt( 'timeout', 240000 ) );
const baseRef = opt( 'base-ref', '' );
const recheck = Number( opt( 'recheck', 1 ) ) > 0;
const tiny = { pixels: Number( opt( 'recheck-px', 64 ) ), level: Number( opt( 'recheck-level', 2 ) ) };
const pagePerView = args.includes( '--page-per-view' );
const W = 1672, H = 941;
const FLAG = 0.1;

const VIEWS = {
	v1: { name: 'overview', presets: [ 'noon', 'golden-hour' ] },
	v2: { name: 'top-down', presets: [ 'noon' ] },
	v3: { name: 'cliff close', presets: [ 'noon' ] },
	v4: { name: 'meadow close', presets: [ 'noon' ] },
	v5: { name: 'rim close', presets: [ 'noon' ] },
	v6: { name: 'sea floor', presets: [ 'noon' ] },
};
for ( const v of views ) if ( ! VIEWS[ v ] ) throw new Error( `unknown view ${ v } (v1-v6)` );

// the query options a scene jump sets (src/main.ts SCENE_OPTIONS); every other one is read at load,
// so views that differ in one need pages of their own (a list out of date costs a failed jump and a
// retry on a fresh page, not a wrong image: establishScene refuses such a query)
const SCENE_OPTIONS = [ 'weather', 'preset', 'hour', 'moon', 't', 'dist', 'polar', 'az', 'camera', 'clouds', 'dayLength', 'paused', 'clock' ];

// the main checkout (git's common directory): the profiles and references every worktree shares
const MAIN = ( () => {

	try {

		const common = execFileSync( 'git', [ 'rev-parse', '--path-format=absolute', '--git-common-dir' ], { cwd: ROOT, encoding: 'utf8', timeout: 5000 } ).trim();
		if ( path.basename( common ) === '.git' ) return path.dirname( common );

	} catch { /* not a git checkout: this one */ }
	return ROOT;

} )();
const PROFILES = path.join( process.env.PONLAI_CAPTURE_PROFILES ? path.resolve( process.env.PONLAI_CAPTURE_PROFILES ) : path.join( MAIN, 'artifacts/.capture-profiles' ), 'growth' );
const REFS = path.join( MAIN, 'artifacts/captures/growth-ref' );
const hash = ( text, n = 12 ) => createHash( 'sha256' ).update( text ).digest( 'hex' ).slice( 0, n );

// Runs in the page (as `--eval`): places the camera for one view.
function placeCamera( s, view ) {

	const DEG = Math.PI / 180;
	// the page's own island view on this land: its pivot, and the ratio of the land's equivalent
	// radius to the first island's; without `land`, today's tile island framed about ( 1.5, 0.5, 1 )
	const land = s.land;
	const k = land ? land.scale : 1;
	const target = s.controls.target.clone().set( ...( land ? land.target : [ 1.5, 0.5, 1.0 ] ) );
	const c = land ? land.centroid : { x: 1.5, z: 1.0 };
	const camera = s.camera;
	// A page reached by the scene jump keeps what earlier views changed outside the scene: the
	// orbit's farthest zoom, which orbit() raises, bounds the ground's ray casts. Every view starts
	// from the page's load state (recorded by the page's first view, which is always a fresh load),
	// so its image does not depend on the view before it. The jump itself restores the camera mode,
	// the island view (its fov) and the pose.
	s.captureGrowth ??= { maxDistance: s.controls.maxDistance };
	s.controls.maxDistance = s.captureGrowth.maxDistance;

	const orbit = ( distance, polar, azimuth ) => {

		if ( s.cameraSettings.mode !== 'orbit' ) s.setCameraMode( 'orbit' );
		s.setCameraView( 'island' );
		s.controls.maxDistance = Math.max( s.controls.maxDistance, distance );
		s.controls.target.copy( target );
		camera.position.setFromSphericalCoords( distance, polar * DEG, azimuth * DEG ).add( target );
		camera.lookAt( target );
		s.controls.settle();

	};
	const look = ( eye, at, fov ) => {

		s.setCameraView( 'island' );
		s.setCameraMode( 'free' );
		camera.position.set( eye.x, eye.y, eye.z );
		camera.lookAt( at.x, at.y, at.z );
		camera.fov = fov;
		camera.updateProjectionMatrix();

	};

	// the azimuth these views were set up at (318 degrees, the island view's default until it
	// turned to face the meridian): the close views look at the coast it faces
	const az = 318;
	if ( view === 'v1' ) return orbit( 58 * k, 50, az );
	if ( view === 'v2' ) return orbit( 75 * k, 8, az );

	// walk out from the centroid on the island's heights: onto the meadow, then to its lip. The
	// heights are the camera's ground (IslandGround.heightAt: the highest point of the island's chunks
	// per 0.5 m cell of the world's lattice, the sea elsewhere), made in the workers from the chunks'
	// meshes: the page's meshes are not read, so a build that draws them simplified frames alike.
	const g = s.controls.ground, d = { x: Math.sin( az * DEG ), z: Math.cos( az * DEG ) };
	const at = ( r ) => ( { x: c.x + d.x * r, z: c.z + d.z * r } );
	const high = ( r ) => { const p = at( r ); return g.heightAt( p.x, p.z ) > 2; };
	let r = 0;
	while ( ! high( r ) && r < 150 ) r += 0.25;
	while ( high( r ) && r < 150 ) r += 0.25;
	const rim = at( r ), inland = at( r * 0.5 );
	const top = g.heightAt( inland.x, inland.z ); // the meadow's height
	const p = ( q, along, y ) => ( { x: q.x + d.x * along, y, z: q.z + d.z * along } );
	// across the coast, so the cliff is seen a little from the side
	const side = ( q, w ) => ( { x: q.x - d.z * w, y: q.y, z: q.z + d.x * w } );

	if ( view === 'v3' ) return look( side( p( rim, 14, 2.2 ), 4 ), p( rim, 0.5, 0.8 ), 45 );
	// from just inside the lip, back across the meadow
	if ( view === 'v4' ) return look( p( rim, - 2.5, top + 1.6 ), p( rim, - 12.5, top - 0.2 ), 55 );
	if ( view === 'v5' ) return look( side( p( rim, 6, top + 1.8 ), 1.5 ), p( rim, - 0.5, top - 1 ), 45 );
	// steeply down onto the shelf, short of the sun's glare
	if ( view === 'v6' ) return look( p( rim, 7, 6 ), p( rim, 10, - 3 ), 55 );

}

const evalFor = ( view ) => `(${ placeCamera.toString() })( window.__PONLAI__, ${ JSON.stringify( view ) } )`;
// what a reference's pixels depend on besides its query and size: the camera code, the capture
// tools' readiness and shot, the browser
const CAMERA = hash( evalFor( 'VIEW' ) );
const TOOL_FILES = Object.fromEntries( [ 'capture.mjs', 'capture-browser.mjs' ].map( ( f ) => [ f, hash( readFileSync( path.join( ROOT, 'tools', f ) ) ) ] ) );

// the page reads the first value of a key: the URL's query and `--q` replace the tool's
function queryFor( url, seed, grow, preset ) {

	const u = new URL( url );
	const query = new URLSearchParams( { debug: '', paused: '', t: 12, dpr: 1, preset, weather: 'clear', seed, grow } );
	for ( const given of [ u.searchParams, new URLSearchParams( extra ) ] ) for ( const key of new Set( given.keys() ) ) {

		query.delete( key );
		for ( const value of given.getAll( key ) ) query.append( key, value );

	}
	return query;

}

const shots = [];
const pages = cand ? [ [ 'base', base ], [ 'cand', cand ] ] : [ [ 'base', base ] ];
for ( const seed of seeds ) for ( const grow of grows ) for ( const view of views ) for ( const preset of VIEWS[ view ].presets ) {

	const key = `s${ seed }-g${ grow }-${ view }-${ preset }`;
	for ( const [ side, url ] of pages ) {

		const u = new URL( url ), query = queryFor( url, seed, grow, preset );
		const loadTime = [ ...query ].filter( ( [ k ] ) => ! SCENE_OPTIONS.includes( k ) );
		const world = `${ side }-s${ query.get( 'seed' ) }-g${ query.get( 'grow' ) }`.replace( /[^A-Za-z0-9.,_-]+/g, '_' );
		shots.push( { key, side, url, seed, grow, view, preset, file: `shots/${ side }-${ key }`,
			page: u.origin + u.pathname, query: query.toString().replace( /=(?=&|$)/g, '' ),
			group: `${ side } ${ u.origin + u.pathname } ${ new URLSearchParams( loadTime ).toString() }`, world } );

	}

}

const outDir = path.join( ROOT, 'artifacts/captures/growth', label );
if ( existsSync( path.join( outDir, 'stats.json' ) ) ) {

	console.error( `capture-growth: ${ outDir } holds another run's results: choose another --label` );
	process.exit( 1 );

}
await mkdir( path.join( outDir, 'shots' ), { recursive: true } );
await mkdir( path.join( outDir, 'logs' ), { recursive: true } );

// ------------------------------------------------------------------ pages

/** Captures items ({ shot, out, log, done( ok ) }) on capture.mjs worker pages, one group's
 * items on one page at a time (see the header); resolves once every item is done. */
async function captureItems( items, { reverse = false } = {} ) {

	const groups = new Map();
	for ( const item of items ) {

		if ( ! groups.has( item.shot.group ) ) groups.set( item.shot.group, [] );
		groups.get( item.shot.group ).push( item );

	}
	const order = [ ...groups.values() ].map( ( g ) => reverse ? g.reverse() : g );
	let next = 0;
	await Promise.all( Array.from( { length: Math.min( jobs, order.length ) }, async () => {

		while ( next < order.length ) {

			const queue = order[ next ++ ];
			while ( queue.length ) await runPage( queue );

		}

	} ) );

}

let jumpless = false;
// one capture.mjs worker serving the group's queue until it is empty or the page ends
function runPage( queue ) {

	const { page, world } = queue[ 0 ].shot;
	return new Promise( ( resolve ) => {

		const child = spawn( process.execPath, [ 'tools/capture.mjs', '--worker', '--url', page, '--w', String( W ), '--h', String( H ),
			'--timeout', String( timeout ), ...( pagePerView ? [ '--page-per-view' ] : [] ) ],
		{ cwd: ROOT, stdio: [ 'ignore', 'pipe', 'pipe', 'ipc' ], env: { ...process.env, PONLAI_CAPTURE_PROFILES: path.join( PROFILES, world ) } } );
		let output = [], current = null, served = 0, timer = null, killer = null, writing = Promise.resolve();
		child.stdout.on( 'data', ( d ) => output.push( d ) );
		child.stderr.on( 'data', ( d ) => output.push( d ) );
		child.on( 'error', ( error ) => output.push( Buffer.from( `capture.mjs: ${ error.message }\n` ) ) );
		const flushLog = ( item, text ) => {

			const log = Buffer.concat( [ ...output, Buffer.from( text + '\n' ) ] );
			output = [];
			writing = writing.then( () => writeFile( item.log, log ) );

		};
		const fail = ( item, why ) => {

			item.attempts ++;
			// written although the page logged errors: shot, with its messages (the page is gone)
			if ( existsSync( item.out + '.json' ) ) return item.done( true, why );
			if ( item.attempts <= retries ) {

				// first in line, so a fresh page loads it
				queue.unshift( item );
				console.log( `${ item.shot.side } ${ item.key } ${ why }: retrying on a fresh page` );

			} else item.done( false, why );

		};
		child.on( 'message', ( m ) => {

			if ( m.type === 'next' ) {

				current = queue.shift() ?? null;
				if ( ! current ) { child.send( { type: 'done' }, () => {} ); return; }
				const item = current;
				served ++;
				// (a file left by an earlier attempt must not pass for this one's)
				for ( const ext of [ '.png', '.json' ] ) rmSync( item.out + ext, { force: true } );
				child.send( { type: 'view', view: { key: item.key, query: item.shot.query, evals: [ evalFor( item.shot.view ) ], out: item.out } },
					( error ) => { if ( error && current === item ) { current = null; queue.unshift( item ); } } );

			} else if ( m.type === 'locked' ) {

				// a page that stopped answering, counted from the view's GPU slot (the wait for the lock is
				// not silence)
				timer = setTimeout( () => {

					console.log( `${ current?.shot.side } ${ current?.key } no answer from its page: killing it` );
					child.kill( 'SIGTERM' );
					killer = setTimeout( () => child.kill( 'SIGKILL' ), 15000 );

				}, timeout * 3 + 120000 );

			} else if ( m.type === 'page' ) {

				if ( ! m.jump && ! jumpless && ! pagePerView ) {

					jumpless = true;
					console.log( `this build has no exact scene jump (__PONLAI__.sceneJump ${ m.marker ?? 'missing' }): a page per view` );

				}

			} else if ( m.type === 'shot' ) {

				clearTimeout( timer );
				const item = current;
				current = null;
				flushLog( item, m.log );
				item.reached = { mode: m.mode, from: m.from, seconds: m.seconds, lockSeconds: m.lockSeconds, worldSeconds: m.worldSeconds ?? 0 };
				if ( m.ok ) item.done( true );
				else fail( item, 'failed' );

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

			} else if ( ! served && queue.length ) {

				// a page that never asked for a view (its browser did not start): the first view's attempt
				const item = queue.shift();
				flushLog( item, `the page ended before its first view (exit ${ code ?? signal })` );
				fail( item, `no page (exit ${ code ?? signal })` );

			}
			await writing;
			resolve();

		} );

	} );

}

// ------------------------------------------------------------------ the shots

const t0 = performance.now();
let finished = 0;
const total = shots.length;
// a shot's outcome: its messages from the JSON, or the log's error lines
async function settle( shot, ok, why, item ) {

	shot.ok = ok;
	if ( item?.reached ) shot.reached = item.reached;
	if ( ok ) {

		const info = JSON.parse( await readFile( path.join( outDir, shot.file + '.json' ), 'utf8' ) );
		shot.messages = [ ...info.errors, ...info.failures ];
		shot.worldCache = info.diag?.worldCache ?? null;
		shot.mode = info.page?.mode ?? shot.reached?.mode ?? null;

	} else {

		const log = item && existsSync( item.log ) ? await readFile( item.log, 'utf8' ) : '';
		shot.messages = [ log.split( '\n' ).filter( ( l ) => /error|exceeded|lost/i.test( l ) ).slice( 0, 3 ).join( '\n' ) || why || 'failed' ];

	}
	finished ++;
	const how = shot.ref ? `reference ${ shot.ref.status }` : shot.reached ? `${ shot.reached.mode }${ shot.reached.from ? ` from ${ shot.reached.from }` : '' } ${ shot.reached.seconds.toFixed( 1 ) } s${ shot.reached.worldSeconds ? `, world ${ shot.reached.worldSeconds.toFixed( 1 ) } s` : '' }${ shot.reached.lockSeconds >= 0.5 ? `, ${ shot.reached.lockSeconds.toFixed( 1 ) } s waiting for the GPU` : '' }` : '';
	console.log( `[${ finished }/${ total }] ${ shot.side } ${ shot.key } ${ ok ? 'ok' : 'FAILED' }${ how ? ` (${ how })` : '' }${ shot.messages.length ? ` (${ shot.messages.length } messages)` : '' }` );

}

// (an item's outcome is recorded asynchronously: awaited through `outcomes` before it is read)
const outcomes = [];
const item = ( shot, out, onDone, log = path.basename( shot.file ) ) => ( { shot, key: shot.key, out, log: path.join( outDir, 'logs', `${ log }.log` ), attempts: 0,
	done: ( ok, why ) => { outcomes.push( Promise.resolve( onDone( ok, why ) ) ); } } );

// the base side's stored references (--base-ref): each shot reused, waited for or captured here
const refJobs = [];
if ( baseRef ) {

	try {

		checkServed( base, execFileSync( 'git', [ 'rev-parse', '--verify', `${ baseRef }^{commit}` ], { cwd: ROOT, encoding: 'utf8' } ).trim() );

	} catch ( error ) {

		console.error( `--base-ref: ${ error.message.split( '\n' )[ 0 ] }` );
		process.exit( 2 );

	}
	const browser = await browserBuild();
	for ( const shot of shots.filter( ( s ) => s.side === 'base' ) ) {

		const key = { kind: 'growth', shot: shot.key, size: [ W, H ], query: shot.query, camera: CAMERA, tools: TOOL_FILES, browser };
		let asked;
		const capture = new Promise( ( resolve ) => asked = resolve );
		const result = ensureReference( {
			dir: path.join( REFS, baseRef, `${ shot.key }-${ hash( stable( key ) ) }` ), kind: 'shot', key, files: { ...TOOL_FILES, placeCamera: CAMERA },
			url: base, label: `capture-growth ${ label } ${ shot.key }`, yieldGpu: false,
			// (the store's per-entry lines would be one per shot: only waiting and replacing are said)
			log: ( line ) => { if ( / waiting | moved to /.test( line ) ) console.log( line ); },
			capture: ( todo, into ) => new Promise( ( resolve ) => asked( { into, resolve } ) ),
		} );
		refJobs.push( { shot, result, capture } );

	}

}
const refShots = new Set( refJobs.map( ( j ) => j.shot ) );
const direct = shots.filter( ( s ) => ! refShots.has( s ) ).map( ( s ) => item( s, path.join( outDir, s.file ), ( ok, why ) => settle( s, ok, why, items.get( s ) ) ) );
const items = new Map( direct.map( ( i ) => [ i.shot, i ] ) );
// a reference to capture joins its group's page; one reused, or captured by another process, is copied
const toCapture = [];
const copied = Promise.all( refJobs.map( async ( job ) => {

	const asked = await Promise.race( [ job.capture, job.result.then( () => null ) ] );
	if ( asked ) {

		const it = item( job.shot, path.join( asked.into, 'shot' ), async ( ok, why ) => {

			job.item = it;
			job.why = why;
			asked.resolve( ok ? { coverage: { captured: true }, failed: 0, manifest: { query: job.shot.query } } : { coverage: null, failed: 1 } );

		} );
		toCapture.push( it );

	}
	return job;

} ) );
const refsDone = Promise.all( refJobs.map( async ( job ) => {

	const r = await job.result;
	job.shot.ref = { status: r.status, dir: path.relative( MAIN, r.dir ) };
	const ok = [ 'reused', 'waited', 'captured', 'extended' ].includes( r.status );
	if ( ok ) for ( const ext of [ '.png', '.json' ] ) copyFileSync( path.join( r.dir, 'shot' + ext ), path.join( outDir, job.shot.file + ext ) );
	await settle( job.shot, ok, r.reason ?? r.status, job.item ?? null );

} ) );
await copied;
await captureItems( [ ...toCapture, ...direct ].sort( ( a, b ) => shots.indexOf( a.shot ) - shots.indexOf( b.shot ) ) );
await Promise.all( outcomes );
await refsDone;
const captureSeconds = ( performance.now() - t0 ) / 1000;

// ------------------------------------------------------------------ pixel differences and re-checks

const pixelsOf = ( file ) => decodePng( readFileSync( file ) );
function difference( a, b ) {

	const c = compareFrames( pixelsOf( a ), pixelsOf( b ) );
	return { pixels: c.over[ 0 ], max: c.max };

}
const pairs = [];
for ( const key of [ ...new Set( shots.map( ( s ) => s.key ) ) ] ) {

	const [ b, c ] = [ 'base', 'cand' ].map( ( side ) => shots.find( ( s ) => s.key === key && s.side === side ) );
	if ( ! b?.ok || ! c?.ok ) continue;
	const pixels = difference( path.join( outDir, b.file + '.png' ), path.join( outDir, c.file + '.png' ) );
	pairs.push( { key, b, c, pixels } );

}
const recheckPairs = recheck ? pairs.filter( ( p ) => p.pixels.pixels > 0 && p.pixels.pixels <= tiny.pixels && p.pixels.max <= tiny.level ) : [];
if ( recheckPairs.length ) {

	console.log( `re-checking ${ recheckPairs.length } pairs with a tiny difference on fresh pages` );
	await mkdir( path.join( outDir, 'shots/recheck' ), { recursive: true } );
	const again = new Map();
	const list = recheckPairs.flatMap( ( p ) => [ p.b, p.c ] ).map( ( s ) => item( s, path.join( outDir, 'shots/recheck', path.basename( s.file ) ), ( ok ) => { again.set( s, ok ); }, `recheck-${ path.basename( s.file ) }` ) );
	await captureItems( list, { reverse: true } );
	await Promise.all( outcomes );
	for ( const p of recheckPairs ) {

		const file = ( s ) => path.join( outDir, 'shots/recheck', path.basename( s.file ) + '.png' );
		if ( ! again.get( p.b ) || ! again.get( p.c ) ) { p.recheck = { verdict: 'failed' }; continue; }
		const second = difference( file( p.b ), file( p.c ) );
		const base = difference( path.join( outDir, p.b.file + '.png' ), file( p.b ) ), candidate = difference( path.join( outDir, p.c.file + '.png' ), file( p.c ) );
		const verdict = second.pixels === 0 ? 'identical' : base.pixels === 0 && candidate.pixels === 0 ? 'repeatable' : 'not repeatable';
		p.recheck = { verdict, second, base, candidate };
		console.log( `${ p.key }: ${ p.pixels.pixels } px (max ${ p.pixels.max }), again ${ second.pixels } px (max ${ second.max }): ${ verdict }` );

	}

}
const pixelsByKey = Object.fromEntries( pairs.map( ( p ) => [ p.key, { ...p.pixels, ...( p.recheck ? { recheck: p.recheck } : {} ) } ] ) );

// region statistics, by compare-captures.py's `metrics` (tools/parity/pixels.py, which it imports)
// plus the mean HSV saturation
const PY = `
import json, sys
job = json.load(sys.stdin)
sys.dont_write_bytecode = True
sys.path.insert(0, job["pixels"])
import numpy as np
from PIL import Image
from pixels import metrics
def stats(im):
    m = metrics(im)
    a = np.asarray(im, dtype=np.float64)
    hi, lo = a.max(axis=2), a.min(axis=2)
    sat = np.where(hi > 0, (hi - lo) / np.maximum(hi, 1e-9), 0)
    return {"luma": m["lumaMean"], "saturation": round(float(sat.mean()) * 100, 2), "edges": m["meanAdjacentLumaDifference"]}
out = {}
for path in job["images"]:
    try:
        im = Image.open(path).convert("RGB")
    except Exception:
        continue
    w, h = im.size
    out[path] = {name: stats(im.crop((round(x0 * w), round(y0 * h), round(x1 * w), round(y1 * h)))) for name, (x0, y0, x1, y1) in job["regions"].items()}
print(json.dumps(out))
`;
const REGIONS = { frame: [ 0, 0, 1, 1 ], centre: [ 0.25, 0.25, 0.75, 0.75 ], upper: [ 0, 0, 1, 0.4 ], lower: [ 0, 0.6, 1, 1 ] };
const images = shots.filter( ( s ) => s.ok ).map( ( s ) => path.join( outDir, s.file + '.png' ) );
const stats = await new Promise( ( resolve, reject ) => {

	const child = spawn( 'uv', [ 'run', '--quiet', '--with', 'pillow', '--with', 'numpy', 'python', '-I', '-c', PY ], { cwd: ROOT, stdio: [ 'pipe', 'pipe', 'inherit' ] } );
	let output = '';
	child.stdout.on( 'data', ( b ) => output += b );
	child.on( 'close', ( code ) => code === 0 ? resolve( JSON.parse( output ) ) : reject( new Error( `region statistics failed (${ code })` ) ) );
	child.stdin.end( JSON.stringify( { pixels: path.join( ROOT, 'tools/parity' ), images, regions: REGIONS } ) );

} );
for ( const s of shots ) s.stats = stats[ path.join( outDir, s.file + '.png' ) ] ?? null;

// pairs: the candidate's change against the base, per region and metric
const rows = [];
for ( const key of [ ...new Set( shots.map( ( s ) => s.key ) ) ] ) {

	const [ b, c ] = [ 'base', 'cand' ].map( ( side ) => shots.find( ( s ) => s.key === key && s.side === side ) );
	const deltas = {};
	if ( b?.stats && c?.stats ) for ( const region of Object.keys( REGIONS ) ) {

		deltas[ region ] = {};
		for ( const m of [ 'luma', 'saturation', 'edges' ] ) {

			const x = b.stats[ region ][ m ], y = c.stats[ region ][ m ];
			deltas[ region ][ m ] = Math.abs( x ) > 1e-6 ? ( y - x ) / Math.abs( x ) : ( y === x ? 0 : Infinity );

		}

	}
	rows.push( { key, base: b, cand: c, deltas, pixels: pixelsByKey[ key ] ?? null, flagged: Object.values( deltas ).some( ( r ) => Object.values( r ).some( ( v ) => Math.abs( v ) > FLAG ) ) } );

}

// the world each page loaded: from the cache or generated (the loads' `worldCache`, src/main.ts)
const loads = shots.filter( ( s ) => s.ok && s.mode === 'load' && ( ! s.ref || s.ref.status === 'captured' ) );
const cacheHits = loads.filter( ( s ) => s.worldCache?.cache === 'hit' ).length;
const refCounts = {};
for ( const s of shots ) if ( s.ref ) refCounts[ s.ref.status ] = ( refCounts[ s.ref.status ] ?? 0 ) + 1;
const seconds = ( performance.now() - t0 ) / 1000;
await writeFile( path.join( outDir, 'stats.json' ), JSON.stringify( { base, cand, seeds, grows, views, extra, baseRef: baseRef || null, regions: REGIONS,
	run: { seconds: Math.round( seconds ), captureSeconds: Math.round( captureSeconds ), loads: loads.length, cacheHits, references: refCounts, recheck: recheck ? tiny : null },
	shots, deltas: Object.fromEntries( rows.map( ( r ) => [ r.key, r.deltas ] ) ), pixels: pixelsByKey }, null, 2 ) );

const esc = ( s ) => String( s ).replace( /[&<>"]/g, ( ch ) => ( { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } )[ ch ] );
const pct = ( v ) => ( ! Number.isFinite( v ) ? '∞' : `${ v >= 0 ? '+' : '' }${ ( v * 100 ).toFixed( 1 ) } %` );
const cell = ( s ) => ! s ? '<div class="shot missing">not captured</div>' : `<figure class="shot">
	${ s.ok ? `<a href="${ s.file }.png"><img src="${ s.file }.png" loading="lazy" alt="${ s.side } ${ esc( s.key ) }"></a>` : '<div class="missing">capture failed</div>' }
	<figcaption>${ s.side === 'base' ? 'base' : 'candidate' }${ s.messages.length ? ` <span class="warn" title="${ esc( s.messages.join( '\n' ) ) }">${ s.messages.length } console messages</span>` : '' }</figcaption>
</figure>`;
const table = ( r ) => {

	const one = r.base?.stats ? [ r.base ] : [];
	if ( ! r.cand ) return one.length ? `<table><tr><th></th><th>luma</th><th>saturation %</th><th>edges</th></tr>${ Object.entries( r.base.stats ).map( ( [ region, m ] ) =>
		`<tr><th>${ region }</th><td>${ m.luma }</td><td>${ m.saturation }</td><td>${ m.edges }</td></tr>` ).join( '' ) }</table>` : '';
	if ( ! r.base?.stats || ! r.cand?.stats ) return '';
	return `<table><tr><th></th><th>luma</th><th>saturation</th><th>edges</th></tr>${ Object.keys( REGIONS ).map( ( region ) =>
		`<tr><th>${ region }</th>${ [ 'luma', 'saturation', 'edges' ].map( ( m ) => {

			const v = r.deltas[ region ][ m ];
			return `<td class="${ Math.abs( v ) > FLAG ? 'flag' : '' }" title="${ r.base.stats[ region ][ m ] } → ${ r.cand.stats[ region ][ m ] }">${ pct( v ) }</td>`;

		} ).join( '' ) }</tr>` ).join( '' ) }</table>`;

};
// the pair's pixel difference, and its re-check
const pixelLine = ( r ) => {

	if ( ! r.pixels ) return '';
	const d = r.pixels, again = d.recheck;
	const text = d.pixels === 0 ? 'identical pixels' : `${ d.pixels } px differ, largest difference ${ d.max }`;
	const check = ! again ? '' : again.verdict === 'failed' ? ' · re-check failed' : ` · again ${ again.second.pixels } px (max ${ again.second.max }), base ${ again.base.pixels } px and candidate ${ again.candidate.pixels } px from their first shots: <b>${ again.verdict }</b>`;
	return `<p class="pixels">${ text }${ check }</p>`;

};
const section = ( r ) => {

	const s = r.base ?? r.cand;
	return `<section${ r.flagged ? ' class="flagged"' : '' }>
<h2>${ esc( VIEWS[ s.view ].name ) } <small>seed ${ esc( s.seed ) } · grow ${ esc( s.grow ) } · ${ esc( s.preset ) }${ r.flagged ? ' · <b>beyond ±10 %</b>' : '' }</small></h2>
<div class="pair${ cand ? '' : ' single' }">${ cell( r.base ) }${ cand ? cell( r.cand ) : '' }</div>
${ pixelLine( r ) }${ table( r ) }
</section>`;

};

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Growth captures ${ esc( label ) }</title>
<style>
:root { --bg: #f6f5f1; --fg: #1d2326; --muted: #65706f; --line: #d9d7d0; --flag: #b4421f; --flag-bg: #f8e3da; }
@media (prefers-color-scheme: dark) { :root { --bg: #15191b; --fg: #e4e6e3; --muted: #94a09e; --line: #2c3437; --flag: #f08a63; --flag-bg: #3a2219; } }
body { margin: 0; padding: 16px; background: var(--bg); color: var(--fg); font: 14px/1.45 system-ui, sans-serif; }
header p { color: var(--muted); margin: 4px 0; word-break: break-all; }
section { border-top: 1px solid var(--line); padding: 12px 0 18px; }
h1 { font-size: 20px; margin: 0 0 6px; } h2 { font-size: 16px; margin: 0 0 8px; } h2 small { color: var(--muted); font-weight: normal; }
.flagged h2 b { color: var(--flag); }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; } .pair.single { grid-template-columns: 1fr; max-width: 900px; }
@media (max-width: 700px) { .pair { grid-template-columns: 1fr; } }
figure { margin: 0; } img { width: 100%; height: auto; display: block; border-radius: 3px; }
figcaption { color: var(--muted); font-size: 12px; margin-top: 3px; } .warn { color: var(--flag); cursor: help; }
.missing { padding: 40px; text-align: center; color: var(--flag); border: 1px dashed var(--line); }
table { border-collapse: collapse; margin-top: 8px; font-variant-numeric: tabular-nums; font-size: 13px; }
th, td { padding: 2px 10px; text-align: right; } th { color: var(--muted); font-weight: normal; }
td.flag { color: var(--flag); background: var(--flag-bg); font-weight: 600; }
.pixels { margin: 6px 0 0; color: var(--muted); font-size: 13px; } .pixels b { color: var(--fg); }
</style></head><body>
<header><h1>Growth captures · ${ esc( label ) }</h1>
<p>base: ${ esc( base ) }${ cand ? `<br>candidate: ${ esc( cand ) }` : '' }${ extra ? `<br>extra query: ${ esc( extra ) }` : '' }</p>
<p>${ shots.length } shots at ${ W } × ${ H }, paused at t = 12, weather clear. Deltas are the candidate's change against the base per crop (mean luma, mean saturation, edge density as the mean adjacent luma difference); beyond ±10 % is flagged. The pixel difference counts the pixels that differ at all and the largest channel difference${ recheck ? `; a pair within ${ tiny.pixels } px and ${ tiny.level } levels was shot again on both sides` : '' }. Shapes differ between steps and builds: judge by eye and these statistics; the pixel difference matters where both sides should draw the same.</p></header>
${ rows.map( section ).join( '\n' ) }
</body></html>
`;
await writeFile( path.join( outDir, 'index.html' ), html );
const flagged = rows.filter( ( r ) => r.flagged ).length;
console.log( `${ path.relative( ROOT, path.join( outDir, 'index.html' ) ) }: ${ rows.length } views, ${ flagged } flagged, ${ shots.filter( ( s ) => ! s.ok ).length } failed, ${ seconds.toFixed( 0 ) } s; worlds from the cache on ${ cacheHits } of ${ loads.length } page loads${ Object.keys( refCounts ).length ? `; base references ${ Object.entries( refCounts ).map( ( [ k, v ] ) => `${ v } ${ k }` ).join( ', ' ) }` : '' }${ recheckPairs.length ? `; ${ recheckPairs.length } pairs re-checked` : '' }` );
