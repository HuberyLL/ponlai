// The project's values that the generic tools in tools/kit/ read, so that a kit tool names no part
// of this project: the globals the page mounts and its loading screen (`docs/how-to/write-a-tool.md`
// gives the page's agreements), the dev server's address and the capture's default query, what a
// stored reference depends on and what may carry it over, where the views' and clips' tables are,
// where the scene's options are listed, the module that adds the pipeline tracer to a page's eval,
// what the disk clean ages out and the servers serve.mjs starts. A kit tool imports this file and
// nothing else outside tools/kit/ (tools/repo/verify-kit.mjs checks that, and that no page global
// is named in the kit). Paths are written from the repository's root.
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
		// the named crop anchors a view's eval defines (tools/island/parity/views.mjs)
		crops: '__PONLAI_CROPS__',
		// the capture's hold on the page's GPU device until the world is generated (tools/kit/capture.mjs)
		gpuGate: '__PONLAI_GPU_GATE__',
		// the stepped clip a clips table's clipEval installs, and the notes it leaves (the page reads
		// the first too: packages/render/post/Pipeline.ts freezes the exposure while it is set)
		clip: '__PONLAI_CLIP__',
		clipNotes: '__PONLAI_CLIP_NOTES__',
	} ),

	// the dev server a page tool opens without a URL, and the query of a capture or probe without one
	url: 'http://127.0.0.1:5190/',
	query: 'paused&t=12&dpr=1',

	reference: Object.freeze( {
		// the sources whose change can change a stored reference's pixels, per kind of reference
		// (tools/kit/reference.mjs, TOOL_FILES)
		toolFiles: Object.freeze( {
			set: Object.freeze( [ 'tools/kit/capture.mjs', 'tools/kit/capture-browser.mjs', 'tools/kit/parity/capture-set.mjs', 'tools/island/parity/views.mjs', 'tools/kit/parity/adhoc.mjs' ] ),
			clip: Object.freeze( [ 'tools/kit/parity/capture-clip.mjs', 'tools/kit/capture-browser.mjs', 'tools/island/parity/views.mjs', 'tools/island/parity/clips.mjs' ] ),
		} ),
		// what a production build reads (tools/kit/reference.mjs, BUILD_INPUTS)
		buildInputs: Object.freeze( [ 'packages', 'app', 'index.html', 'assets.lock.json', 'vite.config.ts', 'package.json', 'package-lock.json', 'tsconfig.json' ] ),
		// the build inputs whose change can alter what a stored capture shows without touching a
		// paused frame (tools/kit/parity/carry.mjs; an entry ending in '/' is a folder)
		watch: Object.freeze( {
			// what moves: the frame loop, weather, the islanders, the sea, the creatures; the
			// dependencies because a three.js upgrade can change any shader, motion vectors included
			motion: Object.freeze( [ 'app/main.ts', 'packages/render/RenderStages.ts', 'packages/island/IslandStages.ts', 'app/', 'packages/render/weather/', 'packages/island/world/FallingLeaves.ts', 'packages/island/characters/', 'packages/render/ocean/', 'packages/game/view/', 'packages/island/life/', 'package.json', 'package-lock.json' ] ),
			// the temporal graph aa=gt renders through: the resolve, its rest and jitter, the mode
			// switch, motion vectors, the frame graph, what draws after the resolve and the events that
			// reset history
			gt: Object.freeze( [ 'packages/render/post/TemporalAA.ts', 'packages/render/post/TemporalRest.ts', 'packages/render/post/Jitter.ts', 'packages/render/post/Antialiasing.ts', 'packages/render/post/Motion.ts', 'packages/render/post/Pipeline.ts',
				'packages/render/post/PipelinePasses.ts', 'packages/render/post/PipelineDisplay.ts', 'packages/render/post/AfterResolve.ts', 'packages/render/post/SceneEvents.ts', 'package.json', 'package-lock.json' ] ),
		} ),
	} ),

	// the views' and clips' tables (what they export: tools/kit/parity/tables.mjs)
	tables: Object.freeze( { views: 'tools/island/parity/views.mjs', clips: 'tools/island/parity/clips.mjs' } ),

	// the module whose `SCENE_OPTIONS = [ ... ]` lists the query options a scene jump may change, read
	// as text (tools/kit/parity/adhoc.mjs: views whose other options differ cannot share a page)
	sceneOptions: 'app/Scene.ts',

	// the module whose installScript() gives an eval's `pipelines` (tools/kit/page-eval.mjs)
	pipelines: 'tools/render/pipeline-trace.mjs',

	// what the disk clean reads (tools/kit/storage.mjs)
	storage: Object.freeze( {
		// the folders under artifacts/ that hold the tasks' and the tools' output: their bulk files
		// and reference stores age out
		folders: Object.freeze( [ 'plans', 'archive', 'captures', 'perf', 'verification', 'crops', 'parity' ] ),
		// what the project's tools leave in the system's temp folder: run folders, by the prefix of
		// their names, removed a day after their last change, and browser profiles, kept but trimmed
		// as the capture profiles are (both profile-frame's)
		temp: Object.freeze( {
			runs: Object.freeze( [ 'ponlai-profile-frame-' ] ),
			profiles: Object.freeze( [ 'ponlai-profile-frame-chrome' ] ),
		} ),
	} ),

	// the servers tools/kit/serve.mjs starts
	serve: Object.freeze( {
		// the command that builds what a preview serves
		build: Object.freeze( [ 'npm', 'run', 'build' ] ),
		// vite's command per mode: serve.mjs adds the host, the port and --strictPort, and waits for
		// vite's `Local:` line
		vite: Object.freeze( { dev: 'npx vite', preview: 'npx vite preview' } ),
		// the ports a server takes, the first free one from the first to the last
		ports: Object.freeze( [ 6400, 6499 ] ),
		// where `--sha` puts a commit's detached worktree, in the main checkout
		worktrees: '.claude/worktrees',
		// the module whose prepareCheckout() fills a commit's worktree with what git does not hold,
		// once its dependencies are in
		prepare: 'tools/repo/serve-checkout.mjs',
	} ),

} );
