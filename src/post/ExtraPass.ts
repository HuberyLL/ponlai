import type { FrameGraph } from './graph/FrameGraph.ts';

/** A pass of the scene's own that the pipeline declares without knowing it (Pipeline.ts, the
 * constructor's `extraPasses`): called once as the graph is declared, it adds its pass or passes to
 * `graph` (`addPass`), with what they read and write declared as any pass's. The pipeline declares
 * its list in order at one place, after the displacement field's pass and before the wave maps',
 * ahead of the scene passes; what a pass needs that exists only later (the world) it takes through
 * a getter of its own and stays idle until then (the pass's `when`). */
export type ExtraPass = <Frame>( graph: FrameGraph<Frame> ) => void;
