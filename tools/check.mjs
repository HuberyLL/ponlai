// Runs the checks a commit must pass, one after another, and says which passed, which failed and
// how long each took. CPU only: nothing here opens a browser, renders or takes the GPU lock, so it
// runs while another session holds the GPU.
//   npm run check                 the commit-time checks, about a quarter of a minute
//   npm run check -- --full       also the production build and the world's chunk checks (minutes)
//
// The commit-time list, in order (cheap and wide first, so a broken type fails before the rest):
// the type check, the code lint (`npm run lint`: the project's rules as ESLint rules,
// eslint.config.mjs), the direction of imports between the layers, the packages' exits and the page
// check (verify-layers), the exits' loading (verify-exits),
// the page's settings against their docs (verify-settings), the files' size (verify-file-size), the three.js internals the code reaches into (verify-three-internals), no
// binary in git (verify-no-binaries, every file in the index), nothing tracked under .claude/ but the
// public skills' links (verify-skill-links), then the CPU regression tools (the
// game's simulation, its words, the ink, the frame graph's compiler, the day cycle, the weather's
// state, the wind, the local lights, the renderer's extension points, the look tables passed at creation, the
// code lint's own rules against their fixtures), and the docs' lint (`npm run lint:docs`) when a Markdown file
// is staged. `--full` adds `npm run build` and `tools/verify-world-chunks.mjs`, which take minutes,
// and `tools/verify-chunk-derived.mjs` (the chunks' derived products, about a quarter of a minute on
// many threads), and runs the docs' lint whatever is staged. Each check runs to its end even after
// another failed, so one run lists every failure; its output goes to the terminal as it comes.
//
// A check belongs in the commit-time list when it needs no GPU and the whole list stays near a
// minute; a slower one goes under `--full`. The checks that render (captures, parity, the GPU
// verify tools) are run by hand (docs/how-to/check-a-change.md).
//
// Each check starts with the application scheduling policy (tools/qos.mjs `appPolicy`).
// Exit 0 when every check passed, 1 when one failed or an option is unknown.
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPolicy } from './qos.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );

let full = false;
for ( const a of process.argv.slice( 2 ) ) {

	if ( a === '--full' ) full = true;
	else {

		console.error( `check: unknown option '${ a }' (only --full)` );
		process.exit( 1 );

	}

}

const node = ( tool, ...args ) => [ process.execPath, [ `tools/${ tool }`, ...args ] ];
const npm = ( script ) => [ 'npm', [ 'run', '--silent', script ] ];

function markdownStaged() {

	const out = execFileSync( 'git', [ 'diff', '--cached', '--name-only', '--diff-filter=ACMR' ], { cwd: ROOT, encoding: 'utf8' } );
	return out.split( '\n' ).some( ( f ) => f.endsWith( '.md' ) );

}

const checks = [
	[ 'typecheck', npm( 'typecheck' ) ],
	[ 'lint', npm( 'lint' ) ],
	[ 'verify-layers', node( 'verify-layers.mjs' ) ],
	[ 'verify-exits', node( 'verify-exits.mjs' ) ],
	[ 'verify-settings', node( 'verify-settings.mjs' ) ],
	[ 'verify-file-size', node( 'verify-file-size.mjs' ) ],
	[ 'verify-three-internals', node( 'verify-three-internals.mjs' ) ],
	[ 'verify-no-binaries', node( 'verify-no-binaries.mjs' ) ],
	[ 'verify-skill-links', node( 'verify-skill-links.mjs' ) ],
	[ 'verify-game', node( 'verify-game.mjs' ) ],
	[ 'verify-i18n', node( 'verify-i18n.mjs' ) ],
	[ 'verify-ink', node( 'verify-ink.mjs' ) ],
	[ 'verify-framegraph', node( 'verify-framegraph.mjs' ) ],
	[ 'verify-day-cycle', node( 'verify-day-cycle.mjs' ) ],
	[ 'verify-weather-state', node( 'verify-weather-state.mjs' ) ],
	[ 'verify-wind', node( 'verify-wind.mjs' ) ],
	[ 'verify-local-lights', node( 'verify-local-lights.mjs' ) ],
	[ 'verify-extensions', node( 'verify-extensions.mjs' ) ],
	[ 'verify-look-params', node( 'verify-look-params.mjs' ) ],
	[ 'verify-lint', node( 'verify-lint.mjs' ) ],
];
if ( full || markdownStaged() ) checks.push( [ 'lint:docs', npm( 'lint:docs' ) ] );
if ( full ) checks.push( [ 'build', npm( 'build' ) ], [ 'verify-world-chunks', node( 'verify-world-chunks.mjs' ) ], [ 'verify-chunk-derived', node( 'verify-chunk-derived.mjs' ) ] );

const results = [];
const start = performance.now();
for ( const [ name, [ cmd, args ] ] of checks ) {

	console.log( `\n[check] ${ name }` );
	const t = performance.now();
	const [ file, argv ] = appPolicy( cmd, args );
	const run = spawnSync( file, argv, { cwd: ROOT, stdio: 'inherit' } );
	const seconds = ( performance.now() - t ) / 1000;
	const ok = run.status === 0;
	results.push( { name, ok, seconds, why: ok ? '' : run.error ? run.error.message : run.signal ? `signal ${ run.signal }` : `exit ${ run.status }` } );

}

const failed = results.filter( ( r ) => ! r.ok );
console.log( `\n[check] ${ full ? 'full' : 'commit-time' } checks: ${ results.length - failed.length } passed, ${ failed.length } failed, ${ ( ( performance.now() - start ) / 1000 ).toFixed( 1 ) } s` );
for ( const r of results ) console.log( `  ${ r.ok ? 'pass' : 'FAIL' }  ${ r.name.padEnd( 24 ) } ${ r.seconds.toFixed( 1 ).padStart( 6 ) } s${ r.why ? `  (${ r.why })` : '' }` );
process.exit( failed.length ? 1 : 0 );
