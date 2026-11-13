// The project's values that the generic tools in tools/kit/ read, so that a kit tool names no part
// of this project: the globals the page mounts and its loading screen (`docs/how-to/write-a-tool.md`
// gives the page's agreements), the dev server's address and the capture's default query, what a
// stored reference depends on, where the views' and clips' tables are, and the module that adds the
// pipeline tracer to a page's eval. A kit tool imports this file and nothing else outside
// tools/kit/ (tools/repo/verify-kit.mjs checks that, and that no page global is named in the kit).
// Paths are written from the repository's root.
export default Object.freeze( {

	page: Object.freeze( {
		// the page's parts and controls, mounted on debug pages
		handle: '__PONLAI__',
		// the page's diagnostics (`settled`, `frame`, `taa`)
		diagnostics: '__THREE_GAME_DIAGNOSTICS__',
		// the element of the loading screen: the scene is shown once it is gone or faded out
		loading: 'loading',
		// the world's start (`ready`, `ms`), app/WorldBoot.ts
		world: '__PONLAI_WORLD__',
		// the named crop anchors a view's eval defines (tools/parity/views.mjs)
		crops: '__PONLAI_CROPS__',
		// the capture's hold on the page's GPU device until the world is generated (tools/capture.mjs)
		gpuGate: '__PONLAI_GPU_GATE__',
	} ),

	// the dev server a page tool opens without a URL, and the query of a capture or probe without one
	url: 'http://127.0.0.1:5190/',
	query: 'paused&t=12&dpr=1',

	reference: Object.freeze( {
		// the sources whose change can change a stored reference's pixels, per kind of reference
		// (tools/parity/reference.mjs, TOOL_FILES)
		toolFiles: Object.freeze( {
			set: Object.freeze( [ 'tools/capture.mjs', 'tools/capture-browser.mjs', 'tools/parity/capture-set.mjs', 'tools/parity/views.mjs', 'tools/parity/adhoc.mjs' ] ),
			clip: Object.freeze( [ 'tools/capture-clip.mjs', 'tools/capture-browser.mjs', 'tools/parity/views.mjs', 'tools/parity/clips.mjs' ] ),
		} ),
		// what a production build reads (tools/parity/reference.mjs, BUILD_INPUTS)
		buildInputs: Object.freeze( [ 'packages', 'app', 'index.html', 'assets.lock.json', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json' ] ),
	} ),

	// the views' and clips' tables, which `node <table> list <group>` lists
	tables: Object.freeze( { views: 'tools/parity/views.mjs', clips: 'tools/parity/clips.mjs' } ),

	// the module whose installScript() gives an eval's `pipelines` (tools/page-eval.mjs)
	pipelines: 'tools/pipeline-trace.mjs',

} );
