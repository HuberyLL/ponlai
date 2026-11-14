// Runs the checks every commit passes, one after another, and says which passed and how long each took.
//
// It is the one command to run before a commit: the type check, the code lint and every check
// that needs no GPU, in about a quarter of a minute. It checks the files in the working tree, not
// what is staged, so a change left unstaged is checked too. The other checks of a change, by its
// kind: docs/bindings/verifying-rendering-changes.md, Kinds.
//
// Usage:
//   node tools/check.mjs [--full]
//   npm run check                 the commit-time checks
//   npm run check -- --full       also the production build and the world's chunk checks
//
// Options:
//   --full    adds `npm run build`, tools/island/verify-world-chunks.mjs and
//             tools/island/verify-chunk-derived.mjs, and runs the docs' lint whatever is staged
//
// The commit-time list, in order (cheap and wide first, so a broken type fails before the rest):
// the type check (`npm run typecheck`), the code lint (`npm run lint`, tools/repo/lint/plugin.mjs),
// verify-layers, verify-exits, verify-settings, verify-file-size, verify-headers (the modules'
// header first lines), verify-tool-manuals (the tools' manuals and `--help`),
// verify-three-internals and verify-kit (tools/repo/), tools/verify-no-binaries.mjs (every file in
// the index), verify-licences (REUSE and the notices' SPDX tags; it needs uv) and
// verify-skill-links (tools/repo/), the game's verify-game, verify-i18n and verify-ink
// (tools/game/), the render pipeline's verify-framegraph, verify-day-cycle, verify-weather-state,
// verify-wind, verify-local-lights, verify-extensions and verify-look-params (tools/render/), then
// tools/repo/verify-lint.mjs, and the docs' lint (`npm run lint:docs`) when a Markdown file is
// staged. Each check runs to its end even after another failed, so one run lists every failure.
//
// Output: each check's own output on the terminal as it comes, under a `[check] <name>` line;
// then a summary line (passed, failed, total seconds) and a line per check with pass or FAIL, its
// time and why it failed (its exit code or signal). It writes no file.
//
// GPU lock and browser: neither. Nothing here renders, so it runs while another session holds the
// GPU. Each check starts under the application scheduling policy (tools/kit/qos.mjs `appPolicy`).
//
// Cost: about a quarter of a minute; `--full` takes minutes (the build and the world's chunks).
//
// Exit codes: 0 every check passed; 1 a check failed or an unknown option.
//
// A check belongs in the commit-time list when it needs no GPU and the whole list stays near a
// minute; a slower one goes under `--full`. The checks that render (captures, parity, the GPU
// verify tools) are run by hand (docs/bindings/verifying-rendering-changes.md, Kinds).
import './kit/help.mjs';
import { spawnSync, execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appPolicy } from './kit/qos.mjs';

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
	[ 'verify-layers', node( 'repo/verify-layers.mjs' ) ],
	[ 'verify-exits', node( 'repo/verify-exits.mjs' ) ],
	[ 'verify-settings', node( 'repo/verify-settings.mjs' ) ],
	[ 'verify-file-size', node( 'repo/verify-file-size.mjs' ) ],
	[ 'verify-headers', node( 'repo/verify-headers.mjs' ) ],
	[ 'verify-tool-manuals', node( 'repo/verify-tool-manuals.mjs' ) ],
	[ 'verify-three-internals', node( 'repo/verify-three-internals.mjs' ) ],
	[ 'verify-kit', node( 'repo/verify-kit.mjs' ) ],
	[ 'verify-no-binaries', node( 'verify-no-binaries.mjs' ) ],
	[ 'verify-licences', node( 'repo/verify-licences.mjs' ) ],
	[ 'verify-skill-links', node( 'repo/verify-skill-links.mjs' ) ],
	[ 'verify-game', node( 'game/verify-game.mjs' ) ],
	[ 'verify-i18n', node( 'game/verify-i18n.mjs' ) ],
	[ 'verify-ink', node( 'game/verify-ink.mjs' ) ],
	[ 'verify-framegraph', node( 'render/verify-framegraph.mjs' ) ],
	[ 'verify-day-cycle', node( 'render/verify-day-cycle.mjs' ) ],
	[ 'verify-weather-state', node( 'render/verify-weather-state.mjs' ) ],
	[ 'verify-wind', node( 'render/verify-wind.mjs' ) ],
	[ 'verify-local-lights', node( 'render/verify-local-lights.mjs' ) ],
	[ 'verify-extensions', node( 'render/verify-extensions.mjs' ) ],
	[ 'verify-look-params', node( 'render/verify-look-params.mjs' ) ],
	[ 'verify-lint', node( 'repo/verify-lint.mjs' ) ],
];
if ( full || markdownStaged() ) checks.push( [ 'lint:docs', npm( 'lint:docs' ) ] );
if ( full ) checks.push( [ 'build', npm( 'build' ) ], [ 'verify-world-chunks', node( 'island/verify-world-chunks.mjs' ) ], [ 'verify-chunk-derived', node( 'island/verify-chunk-derived.mjs' ) ] );

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
