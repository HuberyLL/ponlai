// A running count of the render and compute pipelines the renderer has created (debug builds only;
// `diagnostics.pipelines`). three's WebGPU backend creates every pipeline through
// `backend.createRenderPipeline` and `backend.createComputePipeline`, whether the device call
// beneath is synchronous or `create*PipelineAsync` (a `compileAsync` or warm-up), so wrapping those
// two counts each pipeline once, at the moment three asks for it.
//
// The frame profiler (FrameProfiler.ts) wraps the same two methods on the same backend instance to
// count pipelines per frame. Each wrapper calls through to whatever the method was when it was
// installed, so the two stack in either order and both see every creation: summed over the frames
// it records, the profiler's count matches this one's growth over the same frames.

type Backend = Record<'createRenderPipeline' | 'createComputePipeline', ( ...args: unknown[] ) => unknown>;

export interface PipelineCount {
	/** Render and compute pipelines created since the counter was installed. */
	readonly total: number;
	readonly render: number;
	readonly compute: number;
}

const INSTALLED = Symbol( 'pipelineCounter' );

/** Wraps the backend's pipeline creation once and returns the live counts. */
export function installPipelineCounter( renderer: { backend: unknown } ): PipelineCount {

	const backend = renderer.backend as Backend & { [ INSTALLED ]?: PipelineCount };
	const existing = backend[ INSTALLED ];
	if ( existing ) return existing;
	const count = { render: 0, compute: 0, get total() { return this.render + this.compute; } };
	const wrap = ( method: keyof Backend, key: 'render' | 'compute' ) => {

		const original = backend[ method ];
		backend[ method ] = function ( this: unknown, ...args: unknown[] ) {

			// counted even when three's call throws, as the profiler counts it
			count[ key ] ++;
			return original.apply( this, args );

		};

	};
	wrap( 'createRenderPipeline', 'render' );
	wrap( 'createComputePipeline', 'compute' );
	backend[ INSTALLED ] = count;
	return count;

}
