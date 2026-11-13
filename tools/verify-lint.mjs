// Checks that each of the code lint's own rules (tools/lint/plugin.mjs, scoped in eslint.config.mjs)
// reports what it is written for and nothing else, so a selector that silently matches nothing,
// or a scope that leaves its folder out, fails here rather than letting the error through. CPU
// only, no GPU, a few seconds.
//   node tools/verify-lint.mjs
//
// Guarantees, each a failure (exit 1) when broken:
// - Every rule of the plugin has a fixture, tools/lint/fixtures/<rule>.ts, and every fixture names
//   a rule of the plugin.
// - A fixture is linted as if it were a file at its rule's place in the code (FIXTURE_PATHS: a
//   path inside the rule's `files`), with the repository's config, type information included.
//   Every line it marks with the comment `// reported` is reported by its rule, and nothing else
//   is reported: no line it leaves unmarked (the correct forms beside the wrong ones, such as
//   three's `MathUtils.smoothstep` and a class's own `step` for `tsl-method-order`), no other rule
//   and no parse error.
//
// What it does not check: the rules' messages, and the scope's exclusions (a folder a rule leaves
// out is listed in eslint.config.mjs with its reason).
//
// Output: a line per rule, then the failures. It takes no options. Exit 0 when every fixture
// passes, 1 otherwise.
import './qos.mjs';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import plugin from './lint/plugin.mjs';

const ROOT = path.resolve( path.dirname( fileURLToPath( import.meta.url ) ), '..' );
const FIXTURES = path.join( ROOT, 'tools/lint/fixtures' );

if ( process.argv.length > 2 ) {

	console.error( `verify-lint: unknown option '${ process.argv[ 2 ] }' (it takes none)` );
	process.exit( 1 );

}

// where each rule's fixture is linted from (the file need not exist): a place inside its scope
const FIXTURE_PATHS = {
	'chunk-normals': 'packages/island/world/lint-fixture.ts',
};
const DEFAULT_PATH = 'packages/render/post/lint-fixture.ts';

const rules = Object.keys( plugin.rules );
const fixtures = readdirSync( FIXTURES ).filter( ( f ) => f.endsWith( '.ts' ) ).map( ( f ) => f.slice( 0, - 3 ) );
const failures = [];
for ( const f of fixtures ) if ( ! rules.includes( f ) ) failures.push( `fixture ${ f }.ts names no rule of tools/lint/plugin.mjs` );

// The fixtures' paths are not on disk, so tsconfig.json's project does not hold them: the project
// service hosts them in its default project, built from tsconfig.json's options.
const virtual = [ ...new Set( [ DEFAULT_PATH, ...Object.values( FIXTURE_PATHS ) ] ) ];
const eslint = new ESLint( {
	cwd: ROOT,
	overrideConfig: { languageOptions: { parserOptions: { projectService: { allowDefaultProject: virtual, defaultProject: 'tsconfig.json' } } } },
} );
for ( const rule of rules ) {

	if ( ! fixtures.includes( rule ) ) {

		failures.push( `ponlai/${ rule }: no fixture tools/lint/fixtures/${ rule }.ts` );
		continue;

	}
	const text = readFileSync( path.join( FIXTURES, `${ rule }.ts` ), 'utf8' );
	const expected = new Set();
	text.split( '\n' ).forEach( ( line, i ) => {

		if ( /\/\/ reported\s*$/.test( line ) ) expected.add( i + 1 );

	} );
	const [ result ] = await eslint.lintText( text, { filePath: path.join( ROOT, FIXTURE_PATHS[ rule ] ?? DEFAULT_PATH ) } );
	const problems = [];
	const seen = new Set();
	for ( const m of result.messages ) {

		if ( m.ruleId !== `ponlai/${ rule }` ) problems.push( `line ${ m.line }: ${ m.ruleId ?? 'parse error' }: ${ m.message.split( '\n' )[ 0 ] }` );
		else if ( ! expected.has( m.line ) ) problems.push( `line ${ m.line }: reported, but not marked \`// reported\`` );
		else seen.add( m.line );

	}
	for ( const line of expected ) if ( ! seen.has( line ) ) problems.push( `line ${ line }: marked \`// reported\`, but not reported` );
	console.log( `${ problems.length ? 'FAIL' : 'pass' }  ponlai/${ rule }: ${ seen.size } of ${ expected.size } marked lines reported` );
	for ( const p of problems ) failures.push( `ponlai/${ rule }, ${ rule }.ts ${ p }` );

}

if ( failures.length ) {

	console.log( `\n${ failures.length } failure(s):` );
	for ( const f of failures ) console.log( `  ${ f }` );
	process.exit( 1 );

}
console.log( `\nverify-lint: ${ rules.length } rules, each reports its fixture's marked lines and nothing else` );
