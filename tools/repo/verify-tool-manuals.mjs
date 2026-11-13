// Checks that every entry tool carries its manual in its header and answers `--help` from it at once.
//
// A tool's manual is its header, so an agent or a new contributor learns the tool from the tool in
// one cheap call (docs/how-to/write-a-tool.md gives the header's form). Run it after adding or
// changing a tool; it is part of `npm run check` (tools/check.mjs).
//
// Usage:
//   node tools/repo/verify-tool-manuals.mjs [file...]
//
// Options:
//   file...   check only these tools (paths from the repository's root); the default is every one
//
// Which files are entry tools, decided from the files under tools/ as they are on disk (the code
// lint's fixtures and type declarations left out):
// - A JavaScript file is an entry when its header has a Usage section, it exports nothing (a file
//   that exports nothing is only ever run) or it tests whether it is the script being run
//   (`path.resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url )`). Any other is a module.
// - A Python file is an entry when its docstring has a Usage section or no other Python tool
//   imports it. One that another imports and that has no Usage section is a module.
// So a new tool that nothing imports is checked even before its header is written.
//
// What each entry tool must do (tools/kit/help.mjs and tools/kit/help.py give the header's rules):
// - `--help` exits 0 and prints a Usage section that names the tool by its path from the root;
// - `--help` reaches no lock, browser, server or other process: it runs under
//   tools/repo/verify-tool-manuals-trap.mjs, which makes the GPU lock's, the QoS policy's, the
//   capture browser's, Playwright's and Vite's modules throw as they start and makes starting a
//   process, a connection or a worker throw, so a tool that does anything before it answers fails.
//   A Python tool runs in `python3 -I -S` (no site packages, so a third-party import fails) with
//   os.exec*, os.system and subprocess made to throw;
// - the header's first line, `--help --full`'s first line, is one sentence;
// - the header is at most MAX_LINES lines (a longer manual keeps its long part in a reference page
//   under docs/ and links it);
// - docs/reference/tools.md, the tools' index, names the tool by its path.
//
// Output: a summary line with the count of entry tools and modules checked, then PASS or FAIL with
// each failure. Cost: a few seconds, CPU only (the runs go in parallel; each loads the tool's
// imports without running them). No GPU, no browser.
//
// Exit codes: 0 every entry tool passes, 1 a failure, 2 a file argument that is not a tool.
import '../kit/help.mjs';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { headerOf, sectionOf } from '../kit/help.mjs';
import { ROOT } from '../kit/root.mjs';

const MAX_LINES = 120;
const TIMEOUT = 20000;
const INDEX = 'docs/reference/tools.md';
const TRAP = path.join( ROOT, 'tools', 'repo', 'verify-tool-manuals-trap.mjs' );
// a module's test of whether it is the script being run, which makes it an entry too
const RUN_GUARD = /(?:path\.)?resolve\( process\.argv\[ 1 \] \) === fileURLToPath\( import\.meta\.url \)/;
const SKIP = [ 'tools/repo/lint/fixtures/' ];
// the Python run: the exec and process calls refused, then the tool run as its own main module
const PY_TRAP = [
	'import os, sys, runpy, subprocess',
	'def refuse(what):',
	'    def f(*a, **k): raise RuntimeError("--help reached " + what)',
	'    return f',
	'for n in ("execv", "execve", "execvp", "execvpe", "execl", "execle", "execlp", "execlpe", "system", "spawnv", "spawnve", "posix_spawn", "posix_spawnp", "fork"):',
	'    if hasattr(os, n): setattr(os, n, refuse("os." + n))',
	'subprocess.Popen = refuse("subprocess")',
	'sys.argv = sys.argv[1:]',
	'runpy.run_path(sys.argv[0], run_name="__main__")',
].join( '\n' );

const rel = ( f ) => path.relative( ROOT, f ).split( path.sep ).join( '/' );

const files = [];
( function walk( dir ) {

	for ( const e of readdirSync( dir, { withFileTypes: true } ) ) {

		if ( e.name === '__pycache__' || e.name === 'node_modules' || e.name.startsWith( '.' ) ) continue;
		const f = path.join( dir, e.name );
		if ( e.isDirectory() ) walk( f );
		else if ( /\.(mjs|py)$/.test( e.name ) && ! e.name.endsWith( '.d.mts' ) && ! SKIP.some( ( s ) => rel( f ).startsWith( s ) ) ) files.push( f );

	}

} )( path.join( ROOT, 'tools' ) );
files.sort();

// a Python file's docstring as lines (the leading comments and blank lines before it skipped)
function docstringOf( text ) {

	const m = text.match( /^(?:[ \t]*(?:#[^\n]*)?\n)*[ \t]*[rRuU]?("""|''')([\s\S]*?)\1/ );
	if ( ! m ) return [];
	const lines = m[ 2 ].replace( /\\\n/g, '' ).split( '\n' ).map( ( l ) => l.replace( /\s+$/, '' ) );
	lines[ 0 ] = lines[ 0 ].trim();
	while ( lines.length && lines[ lines.length - 1 ] === '' ) lines.pop();
	return lines;

}

const texts = new Map( files.map( ( f ) => [ f, readFileSync( f, 'utf8' ) ] ) );
const pyImported = new Set();
for ( const [ f, text ] of texts ) {

	if ( ! f.endsWith( '.py' ) ) continue;
	for ( const m of text.matchAll( /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm ) ) pyImported.add( m[ 1 ] ?? m[ 2 ] );

}

const entries = [];
const failures = [];
let modules = 0;
for ( const [ f, text ] of texts ) {

	const python = f.endsWith( '.py' );
	const header = python ? docstringOf( text ) : headerOf( text );
	const usage = sectionOf( header, 'Usage' ).length > 0;
	const entry = usage || ( python ? ! pyImported.has( path.basename( f, '.py' ) )
		: ! /^export\s/m.test( text ) || RUN_GUARD.test( text ) );
	if ( entry ) entries.push( { file: f, python } );
	else modules ++;

}

const only = process.argv.slice( 2 );
for ( const f of only ) {

	if ( ! entries.some( ( e ) => rel( e.file ) === f ) ) {

		console.error( `verify-tool-manuals: ${ f } is not an entry tool under tools/ (${ existsSync( path.join( ROOT, f ) ) ? 'a module' : 'no such file' })` );
		process.exit( 2 );

	}

}
const checked = only.length ? entries.filter( ( e ) => only.includes( rel( e.file ) ) ) : entries;

function run( { file, python }, args ) {

	const [ cmd, argv ] = python ? [ 'python3', [ '-I', '-S', '-c', PY_TRAP, file, ...args ] ] : [ process.execPath, [ '--import', TRAP, file, ...args ] ];
	return new Promise( ( resolve ) => {

		const child = spawn( cmd, argv, { cwd: ROOT, env: { ...process.env, PONLAI_QOS: 'off' }, stdio: [ 'ignore', 'pipe', 'pipe' ] } );
		let out = '', err = '';
		// an answer is a file read: a run still going after TIMEOUT has gone on into the tool
		const timer = setTimeout( () => {

			err = `no answer in ${ TIMEOUT / 1000 } s`;
			child.kill( 'SIGKILL' );

		}, TIMEOUT );
		child.stdout.on( 'data', ( d ) => out += d );
		child.stderr.on( 'data', ( d ) => err += d );
		child.on( 'error', ( error ) => resolve( { code: null, out, err: error.message } ) );
		child.on( 'close', ( code ) => {

			clearTimeout( timer );
			resolve( { code, out, err } );

		} );

	} );

}

const index = existsSync( path.join( ROOT, INDEX ) ) ? readFileSync( path.join( ROOT, INDEX ), 'utf8' ) : '';
// the run's error: the thrown error's line when there is one, else the last line it printed
function why( r ) {

	if ( r.code === null ) return r.err;
	const lines = r.err.trim().split( '\n' );
	const line = lines.find( ( l ) => /^\w*Error\b|^no answer in/.test( l ) ) ?? lines[ lines.length - 1 ];
	return `exit ${ r.code }${ line ? `: ${ line.trim().slice( 0, 200 ) }` : '' }`;

}

async function check( tool ) {

	const name = rel( tool.file );
	const fail = ( what ) => failures.push( `${ name }: ${ what }` );
	const [ short, full ] = await Promise.all( [ run( tool, [ '--help' ] ), run( tool, [ '--help', '--full' ] ) ] );
	if ( short.code !== 0 ) fail( `--help does not answer before the tool runs (${ why( short ) })` );
	else {

		const usage = sectionOf( short.out.split( '\n' ), 'Usage' );
		if ( usage.join( '\n' ).replace( /^Usage:/, '' ).trim() === '' ) fail( '--help prints no Usage section' );
		else if ( ! usage.some( ( l ) => l.includes( name ) ) ) fail( `the Usage section does not name the tool as ${ name }` );

	}
	if ( full.code !== 0 ) fail( `--help --full does not answer before the tool runs (${ why( full ) })` );
	else {

		const lines = full.out.replace( /\n+$/, '' ).split( '\n' );
		const first = lines[ 0 ] ?? '';
		if ( ! /^[A-Z].*\.$/.test( first ) || /[.!?]\s+[A-Z]/.test( first ) ) fail( `the header's first line is not one sentence: "${ first }"` );
		if ( lines.length > MAX_LINES ) fail( `the header has ${ lines.length } lines, more than ${ MAX_LINES } (keep the long part in a reference page)` );

	}
	if ( ! index.includes( `\`${ name }\`` ) ) fail( `${ INDEX } does not name it` );

}

const queue = [ ...checked ];
const workers = Array.from( { length: Math.min( 8, Math.max( 2, availableParallelism() >> 1 ) ) }, async () => {

	while ( queue.length ) await check( queue.shift() );

} );
await Promise.all( workers );

const python = checked.filter( ( e ) => e.python ).length;
console.log( `verify-tool-manuals: ${ checked.length } entry tools checked (${ checked.length - python } JavaScript, ${ python } Python)${ only.length ? '' : `, ${ modules } modules` }` );
if ( failures.length ) {

	failures.sort();
	console.log( `FAIL (${ failures.length })` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( 'PASS' );
