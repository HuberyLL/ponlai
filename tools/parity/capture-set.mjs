// Paused parity captures of a fixed set of views (views.mjs), each through tools/capture.mjs (and
// its shared GPU lock: a paused frame's pixels do not depend on what else renders).
//
//   node tools/parity/capture-set.mjs <baseUrl> <outDir> [--views parity|taa|all|a,b,c] [--repeat]
//       [--quality high] [--aa mode] [--q "extra&query"] [--jobs 1] [--retries 1] [--size 1728x1117@2]
//       [--runs file.csv] [--task name] [--procedure name] [--sha sha] [-- capture.mjs options]
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
// --aa adds `aa=<mode>` only when given, so a build without the option loads unchanged.
// --jobs runs that many captures at once (default 1; 2 is fine; keep it modest). --retries (default
//   1) captures a view again from a fresh page when capture.mjs fails (a load that timed out while
//   other pages kept the GPU busy); the log keeps the last attempt. --timeout (ms, default 240000)
//   bounds capture.mjs's waits for the page.
// --runs appends a line to a CSV log of verification runs (date, task, procedure, sha, wall time in
//   minutes, whether the GPU was busy before the run, the captures and failures, the set); the
//   default is the PARITY_RUNS environment variable. Without either nothing is logged, so a
//   procedure that keeps a run log must pass one of them.
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

const REPO = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '../..' );
const argv = process.argv.slice( 2 );
const dash = argv.indexOf( '--' );
const passThrough = dash >= 0 ? argv.slice( dash + 1 ) : [];
const args = dash >= 0 ? argv.slice( 0, dash ) : argv;
const flags = new Set( [ 'repeat' ] );
const options = {}, positional = [];
for ( let i = 0; i < args.length; i ++ ) {

	if ( args[ i ].startsWith( '--' ) ) {

		const k = args[ i ].slice( 2 );
		if ( flags.has( k ) ) options[ k ] = true;
		else options[ k ] = args[ ++ i ];

	} else positional.push( args[ i ] );

}
const known = [ 'repeat', 'quality', 'aa', 'q', 'views', 'jobs', 'retries', 'timeout', 'size', 'runs', 'task', 'procedure', 'sha' ];
const unknown = Object.keys( options ).filter( ( k ) => ! known.includes( k ) );
if ( positional.length !== 2 || unknown.length ) {

	console.error( unknown.length ? `unknown option --${ unknown[ 0 ] }` : 'usage: capture-set.mjs <baseUrl> <outDir> [options] (see the file header)' );
	process.exit( 2 );

}
let [ base, outDir ] = positional;
if ( ! base.endsWith( '/' ) && ! base.includes( '?' ) ) base += '/';
outDir = path.resolve( outDir );
const size = ( options.size ?? '1728x1117@2' ).match( /^(\d+)x(\d+)(?:@([\d.]+))?$/ );
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
let common = `debug&paused&t=12&quality=${ options.quality ?? 'high' }`;
if ( options.aa ) common += `&aa=${ options.aa }`;
if ( options.q ) common += `&${ options.q }`;
const jobs = Math.max( 1, Number( options.jobs ?? 1 ) );
const retries = Math.max( 0, Number( options.retries ?? 1 ) );
// capture.mjs's waits for the page: generous, since other agents' pages may share the GPU
const timeout = Number( options.timeout ?? 240000 );
const tag = `parity-${ process.pid }`;
const captures = path.join( REPO, 'artifacts/captures' );

await mkdir( outDir, { recursive: true } );
const busy = await gpuUtilisation();
const started = Date.now();

function run( cmd, argList, log ) {

	return new Promise( ( resolve ) => {

		const child = spawn( cmd, argList, { cwd: REPO, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		const chunks = [];
		child.stdout.on( 'data', ( d ) => chunks.push( d ) );
		child.stderr.on( 'data', ( d ) => chunks.push( d ) );
		child.on( 'close', async ( code ) => { await writeFile( log, Buffer.concat( chunks ) ); resolve( code ?? 1 ); } );

	} );

}

async function shoot( view, suffix ) {

	// a load can time out while other pages keep the GPU busy: try again with a fresh page
	for ( let attempt = 0; ; attempt ++ ) {

		const ok = await shootOnce( view, suffix );
		if ( ok || attempt >= retries ) return ok;
		console.log( `${ view }${ suffix } retrying` );

	}

}

async function shootOnce( view, suffix ) {

	const name = `${ tag }-${ view }${ suffix }`;
	const q = `${ common }&${ VIEWS[ view ].q }`;
	const code = await run( process.execPath, [ 'tools/capture.mjs', name, '--url', base, '--q', q, '--w', W, '--h', H, '--scale', scale,
		'--eval', viewEval( view ), '--timeout', String( timeout ), ...passThrough ], path.join( outDir, `${ view }${ suffix }.log` ) );
	// <name>.png, <name>.json and any further frames (<name>.f<i>.png)
	for ( const file of await readdir( captures ) ) {

		if ( file === `${ name }.png` || file === `${ name }.json` || ( file.startsWith( `${ name }.f` ) && file.endsWith( '.png' ) ) ) {

			await rename( path.join( captures, file ), path.join( outDir, `${ view }${ suffix }${ file.slice( name.length ) }` ) );

		}

	}
	const ok = code === 0 && existsSync( path.join( outDir, `${ view }${ suffix }.png` ) );
	console.log( `${ view }${ suffix } rc=${ code }${ ok ? '' : ' FAILED' }` );
	return ok;

}

// every plain capture first, then every repeat: with --jobs above 1 a view's two loads then never
// run side by side, so its A/A pair is taken under the same kind of load as a test run's capture
const queue = [ ...views.map( ( v ) => [ v, '' ] ), ...( options.repeat ? views.map( ( v ) => [ v, '.repeat' ] ) : [] ) ];
let failed = 0;
// (never more workers than views, so a view's repeat cannot start beside its first capture)
await Promise.all( Array.from( { length: Math.min( jobs, views.length ) }, async () => {

	while ( queue.length ) {

		const [ v, s ] = queue.shift();
		if ( ! await shoot( v, s ) ) failed ++;

	}

} ) );

let differ = 0;
if ( options.repeat ) {

	console.log( '-- repeatability' );
	for ( const v of views ) {

		const a = path.join( outDir, `${ v }.png` ), b = path.join( outDir, `${ v }.repeat.png` );
		const same = existsSync( a ) && existsSync( b ) && ( await readFile( a ) ).equals( await readFile( b ) );
		if ( ! same ) differ ++;
		console.log( `${ v } ${ same ? 'identical' : 'DIFFERS' }` );

	}

}

const minutes = ( Date.now() - started ) / 60000;
console.log( `${ views.length } views${ options.repeat ? ' x2' : '' } in ${ minutes.toFixed( 1 ) } min${ failed ? `, ${ failed } failed` : '' }` );
const runs = options.runs ?? process.env.PARITY_RUNS;
if ( runs ) {

	const header = 'date,task,procedure,sha,wall_min,contended,captures,failed,out\n';
	const field = ( s ) => /[",\n]/.test( s ) ? `"${ s.replace( /"/g, '""' ) }"` : s;
	const line = [ new Date( started ).toISOString(), options.task ?? '', options.procedure ?? `capture-set${ options.repeat ? ' --repeat' : '' }`,
		options.sha ?? '', minutes.toFixed( 2 ), busy === null ? '?' : busy > 15 ? 'y' : 'n',
		String( views.length * ( options.repeat ? 2 : 1 ) ), String( failed ), outDir ].map( field ).join( ',' ) + '\n';
	await mkdir( path.dirname( path.resolve( runs ) ), { recursive: true } );
	await appendFile( runs, existsSync( runs ) ? line : header + line );

}
process.exitCode = failed || differ ? 1 : 0;
