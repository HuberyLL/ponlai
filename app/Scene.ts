// The island page's part of the scene jump: its scene options, its camera and its histories.
//
// The island page's part of the scene jump (render/index.ts `startScene`'s jump, whose contract is
// in packages/render/assemble/SceneJump.ts): SCENE_OPTIONS names the query options that make a
// scene on this page, the render pipeline's and the island's (the tools read the list from this
// file: tools/kit/parity/adhoc.mjs).
// - The camera: the orbit's island view at the query's dist / polar / az (`placeOrbit`, as the load
//   places it) and the controls' limits restored, in the query's camera mode.
// - The shoal at the query's `approach` (0 without one), put on it at once.
// - What the island's scenes before left behind is cleared (`registerIslandHistories`: the
//   islander's clips among them), between the render pipeline's histories and its light's.
// - `grow` must equal the land step shown (the URL's, or a later one after Grow: a page grown in
//   place draws what a fresh load of that step draws); the land's `seed`, generated once, must
//   equal the page's.
// - The GUI's time preset follows the query's.
// (The art-review page only: under ?game the game owns the clock.)
import type { RenderParts, SceneJumpContent } from '../packages/render/index.ts';
import { registerIslandHistories, type IslandParts } from '../packages/island/index.ts';
import type { PageParts } from './Page.ts';
import { cameraMode } from './CameraViews.ts';

export const SCENE_OPTIONS = [ 'weather', 'wind', 'windDir', 'preset', 'hour', 'moon', 't', 'dist', 'polar', 'az', 'camera', 'clouds', 'dayLength', 'paused', 'clock', 'approach' ];

/** The island page's part of the scene jump. */
export function islandJump( render: RenderParts, island: IslandParts, page: PageParts ): SceneJumpContent {

	const { controls, growth } = island;
	return {
		sceneOptions: SCENE_OPTIONS,
		// (the land's `grow` against the step shown: a page grown in place draws a fresh load of that step)
		pageValue: ( key ) => key === 'grow' ? [ String( growth.state.step ) ] : null,
		histories: () => registerIslandHistories( render, island ),
		async jump( query ) {

			page.timeView.preset = query.get( 'preset' ) ?? 'golden-hour';
			// the island view's pose, placed as the load places it, on a camera and controls of its own
			page.framing.poseIslandView( query );
			controls.clearInput();
			page.setCameraMode( 'orbit' );
			page.setCameraView( 'island' );
			if ( cameraMode( query ) === 'free' ) page.setCameraMode( 'free' );
			// the shoal at the query's approach (0 without one), put on it at once
			await growth.approachNow( Number( query.get( 'approach' ) ?? 0 ) );

		},
	};

}
