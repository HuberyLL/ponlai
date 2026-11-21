import type { WebGPURenderer } from 'three/webgpu';
import { missing } from './Internals.ts';

// The three.js animation loop and the bookkeeping around each frame, for frames stepped by hand.
//
// three r187's animation loop (`Renderer._animation`), which the app's frame pacer drives, and the
// bookkeeping it does around each frame, which a frame stepped by hand repeats
// (assemble/SceneFrame.ts `loop.step`): the inspector's frame closed and opened, the renderer's info reset, the
// node frame advanced (its id is three's `info.frame`).
//
// Since r187 every `render()` and `compute()` starts the loop when it is not running, and a start
// runs one frame's bookkeeping at once. A stopped loop must stay stopped while a frame is stepped by
// hand or a bake renders, so `stop` cancels the pending frame and marks the loop as running with no
// frame requested (`Animation._requestId`), which makes those starts do nothing; `start` clears the
// mark and starts it.

type Inspector = { isRunning?: boolean; begin(): void; finish(): void };
type Animation = { start(): void; stop(): void; setContext( context: unknown ): void; _requestId: unknown };
type Internals = {
	_animation: Animation;
	_nodes: { nodeFrame: { update(): void; frameId: number } };
	_inspector: Inspector;
};

// what `_requestId` holds while the loop is stopped: not null, so three's own starts do nothing
const HELD = -1;

/** three's animation loop: `setContext` gives it what it asks for animation frames, `start` and
 * `stop` run and halt it; a stopped loop stays stopped through renders and computes. */
export function threeAnimation( renderer: WebGPURenderer ): { start(): void; stop(): void; setContext( context: unknown ): void } {

	const animation = ( renderer as unknown as Internals )._animation;
	if ( ! ( '_requestId' in animation ) ) throw missing( 'Animation._requestId', 'threeAnimation (packages/render/three/FrameLoop.ts)' );
	return {
		start(): void {

			if ( animation._requestId === HELD ) animation._requestId = null;
			animation.start();

		},
		stop(): void {

			if ( animation._requestId !== HELD ) animation.stop();
			animation._requestId = HELD;

		},
		setContext: ( context ) => animation.setContext( context ),
	};

}

/** What three's animation loop does before and after each frame (Animation.start's update), for a
 * frame run outside it: `begin` before the frame's work, `end` after it. */
export function frameBookkeeping( renderer: WebGPURenderer ): { begin(): void; end(): void } {

	const r = renderer as unknown as Internals;
	const nodeFrame = r._nodes.nodeFrame, inspector = r._inspector;
	return {
		begin(): void {

			if ( inspector.isRunning ) inspector.finish();
			if ( renderer.info.autoReset ) renderer.info.reset();
			nodeFrame.update();
			( renderer.info as { frame: number } ).frame = nodeFrame.frameId;
			inspector.begin();

		},
		end(): void {

			inspector.finish();

		},
	};

}
