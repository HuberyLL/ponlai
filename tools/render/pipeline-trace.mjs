// Which pipelines an action built, and for what: the page-side tracer that tools/kit/page-eval.mjs puts
// in every probe's and capture's scope as `pipelines`, and that tools/render/verify-first-use.mjs counts
// with. The page itself only keeps the total (`P.pipelines.total`, packages/render/debug/PipelineCounter.ts);
// when it moves across an action, agents used to wrap the backend again in a script of their own to
// learn what was built. This is that wrapper, once, tool-side (the page's code stays as it is).
//
// Two layers, both calling through to what was there before, so they stack with PipelineCounter,
// the frame profiler and Settled's async watch in any order:
// - the device's create*Pipeline and create*PipelineAsync, where every pipeline is counted, with
//   the label three gives it (`renderPipeline_<material>_<id>`, `computePipeline_<stage>_<name>`).
//   Counting there also sees what three creates beneath the backend (its mipmap and flip passes),
//   so the counts are the device's, as verify-first-use's own counter was;
// - `P.renderer.backend.createRenderPipeline` and `createComputePipeline`, as PipelineCounter wraps
//   them: three calls the device synchronously inside them (an async creation too, before its
//   first await), so a device call made during one is described from the backend's arguments: the
//   render object's material and object (name and type), and its render context's target (the
//   target's texture names or `canvas`, the attachments, the depth texture and the sample count).
//   A device call outside them (the mipmap passes) has those fields null.
// Every entry: `{ kind, async, label, at, frame, material, object, target, stack }`, `frame` being
// `P.renderer.info.frame` (-1 before `__PONLAI__` exists) and `stack` the first 6 app frames
// (files under `packages/` and `app/`, not the debug folders' wrappers) below three's, as `function file:line`.
//
// Installs. In a probe or a capture the tracer installs on first use (`pipelines.mark()`): it wraps
// the device instance (not its prototype: Settled has already wrapped the instance, and a wrap of
// the prototype would miss its calls), and pipelines created before that are not listed. As an init
// script (`installScript( { early: true } )`, verify-first-use) it wraps `GPUDevice.prototype`
// before the page runs, so the load is counted from its first pipeline; the backend layer is added
// at the first device call after `__PONLAI__` exists, so pipelines before that carry the label only.
//
// Use: `const m = pipelines.mark(); ...action...; await frames( 30 ); return pipelines.since( m )`.

// Runs in the page (stringified): installs `window.__pipelineTrace` once and returns it.
function pipelineTrace( early ) {

	if ( window.__pipelineTrace ) return window.__pipelineTrace;
	const log = [];
	// the backend call in progress (its kind and arguments), read by the device calls made inside it
	let current = null;
	let backendWrapped = false;
	const name = ( x ) => x ? { name: x.name || '', type: x.type || x.constructor?.name || '' } : null;
	const target = ( context ) => {

		if ( ! context ) return null;
		const textures = context.textures ?? [];
		return {
			name: context.renderTarget ? textures.map( ( t ) => t.name || '?' ).join( '+' ) || '?' : 'canvas',
			attachments: textures.map( ( t ) => `${ t.name || '?' }:${ t.format ?? '' }` ),
			depth: context.depthTexture ? context.depthTexture.name || 'depth' : context.depth ? 'depth' : null,
			samples: context.sampleCount,
		};

	};
	const stack = () => {

		const limit = Error.stackTraceLimit;
		Error.stackTraceLimit = 60;
		const lines = new Error().stack.split( '\n' );
		Error.stackTraceLimit = limit;
		const app = [];
		for ( const line of lines ) {

			const m = /at (?:(.*?) \()?(\S+?):(\d+):\d+\)?$/.exec( line.trim() );
			// (the page's own wrappers of the backend, PipelineCounter and the frame profiler, are three's
			// layer for this purpose: the caller is below them)
			if ( ! m || ! /\/(packages|app)\//.test( m[ 2 ] ) || m[ 2 ].includes( '/node_modules/' ) || /\/packages\/\w+\/debug\//.test( m[ 2 ] ) ) continue;
			const file = m[ 2 ].replace( /^.*?\/((?:packages|app)\/)/, '$1' ).replace( /\?.*$/, '' );
			app.push( `${ m[ 1 ] ?? '<anonymous>' } ${ file }:${ m[ 3 ] }` );
			if ( app.length === 6 ) break;

		}
		return app;

	};
	const attachBackend = () => {

		const backend = window.__PONLAI__?.renderer?.backend;
		if ( backendWrapped || ! backend ) return;
		backendWrapped = true;
		for ( const [ method, kind ] of [ [ 'createRenderPipeline', 'render' ], [ 'createComputePipeline', 'compute' ] ] ) {

			const original = backend[ method ];
			backend[ method ] = function ( subject ) {

				const outer = current;
				current = { kind, subject };
				try {

					return original.apply( this, arguments );

				} finally {

					current = outer;

				}

			};

		}

	};
	const wrapDevice = ( device ) => {

		for ( const [ method, kind ] of [ [ 'createRenderPipeline', 'render' ], [ 'createRenderPipelineAsync', 'render' ], [ 'createComputePipeline', 'compute' ], [ 'createComputePipelineAsync', 'compute' ] ] ) {

			const original = device[ method ];
			if ( typeof original !== 'function' ) continue;
			device[ method ] = function ( descriptor ) {

				attachBackend();
				const entry = { kind, async: method.endsWith( 'Async' ), label: descriptor?.label ?? '', at: performance.now(), frame: window.__PONLAI__?.renderer?.info?.frame ?? - 1, material: null, object: null, target: null, stack: null };
				try {

					const subject = current?.kind === kind ? current.subject : null;
					if ( subject && kind === 'render' ) Object.assign( entry, { material: name( subject.material ), object: name( subject.object ), target: target( subject.context ) } );
					entry.stack = stack();

				} catch ( e ) {

					entry.error = String( e );

				}
				log.push( entry );
				return original.apply( this, arguments );

			};

		}

	};
	const device = window.__PONLAI__?.renderer?.backend?.device;
	if ( ! early && device ) {

		wrapDevice( device );
		attachBackend();

	} else if ( globalThis.GPUDevice ) wrapDevice( GPUDevice.prototype );
	window.__pipelineTrace = {
		log,
		/** A mark: the pipelines created after it are `since( mark )`. */
		mark: () => log.length,
		since: ( mark = 0 ) => log.slice( mark ),
	};
	return window.__pipelineTrace;

}

/** The tracer's page-side source: an expression that installs it (once) and returns it. `early`
 * wraps `GPUDevice.prototype`, for an init script that runs before the page. */
export const installScript = ( { early = false } = {} ) => `( ${ pipelineTrace.toString() } )( ${ early } )`;
