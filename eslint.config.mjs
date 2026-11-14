// The code lint (`npm run lint`): the project's mechanical rules as ESLint checks, each scoped to
// the folders it concerns. Only the TypeScript parser and the project's own rules
// (tools/repo/lint/plugin.mjs, each with a message that says what to write instead); no recommended
// sets and no style or formatting rules: the code style is three.js's and is not linted.
//
// - The parser reads the code with type information (`projectService`, over tsconfig.json), which
//   `ponlai/tsl-method-order` needs to tell a TSL node from a number or a class of ours.
// - An exception is a line of its own above the line it excepts, naming the rule and a reason a
//   reader can check: `// eslint-disable-next-line ponlai/<rule> -- <reason>`. A disable comment
//   that no longer suppresses anything is an error, so the exceptions stay true.
// - A new rule goes in the plugin, gets its block here and a fixture in tools/repo/lint/fixtures/
//   (`node tools/repo/verify-lint.mjs` fails unless each fixture reports its rule):
//   tools/repo/lint/plugin.mjs's header.
import tseslint from 'typescript-eslint';
import ponlai from './tools/repo/lint/plugin.mjs';

const CODE = [ 'packages/**/*.ts', 'app/**/*.ts' ];

export default [
	{ ignores: [ 'dist/**', 'public/**', 'node_modules/**', 'artifacts/**', '.claude/**', 'tools/repo/lint/fixtures/**' ] },
	{
		files: CODE,
		languageOptions: {
			parser: tseslint.parser,
			parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
		},
		linterOptions: { reportUnusedDisableDirectives: 'error' },
		plugins: { ponlai },
	},
	// every shader, wherever it is built
	{
		files: CODE,
		rules: {
			'ponlai/tsl-method-order': 'error',
			'ponlai/tsl-only': 'error',
			'ponlai/pass-on-graph': 'error',
			'ponlai/no-dynamic-draw': 'error',
			'ponlai/vegetation-tag': 'error',
		},
	},
	// the frame graph and three's wrappers are where a texture copy is declared or made
	{
		files: CODE,
		ignores: [ 'packages/render/post/graph/**', 'packages/render/three/**' ],
		rules: { 'ponlai/history-on-graph': 'error' },
	},
	// a chunk's content is built here
	{
		files: [ 'packages/island/world/**/*.ts' ],
		rules: { 'ponlai/chunk-normals': 'error' },
	},
	// the timestamps' owner, the profiler that takes them over while it times passes, and three's
	// wrappers
	{
		files: CODE,
		ignores: [ 'packages/render/post/DynamicResolution.ts', 'packages/render/debug/FrameProfiler.ts', 'packages/render/three/**' ],
		rules: { 'ponlai/timestamp-owner': 'error' },
	},
	// everything but the diagnostics and the profiling, which measure the wall clock on purpose:
	// the debug folders, the page's diagnostics, the game's debug folder and the GPU timing that
	// picks the quality tier
	{
		files: CODE,
		ignores: [ 'packages/render/debug/**', 'packages/island/debug/**', 'packages/game/GameDebug.ts', 'app/QualityDetect.ts' ],
		rules: { 'ponlai/scene-clock': 'error' },
	},
];
