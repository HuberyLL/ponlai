# Debug handles and keys

This page lists what the running app offers to a tool or to a person at the keyboard: the debug
handles that the capture, probe and verify tools drive, the keyboard shortcuts, the island camera's
controls and the GUI's performance readout. The app's URL options are in
[URL options](url-options.md). These commands serve the app: `npm run dev` (port 5190),
`npm run preview` (port 5191, the production build) and `tools/kit/serve.mjs` (a worktree's server
on a free port).

## Debug handles

`window.__PONLAI__` (the scene's handles) and `window.__THREE_GAME_DIAGNOSTICS__` (the diagnostics)
exist only on the dev server, or with `?debug` in the query (or `?profile`, which also loads the
frame profiler). A production preview needs `debug` for the tools to access them.

- `__PONLAI__.loop.step( { frames, dt, scale, camera, onFrame, clock, converge } )` stops the live
  frame loop and advances its tick itself, with fixed timestamps. It bypasses the frame pacer and
  the dynamic resolution, and it takes nothing from the wall clock. `__PONLAI__.loop.start()`
  resumes the live loop.
- `__PONLAI__.establishScene( query )` jumps to a whole scene in place, as a fresh load of
  `?<query>` would draw it: weather, time of day, moon, scene clock and camera. It clears what is
  left over from the earlier scenes. Load-time options must match those of the loaded page. This
  lets one page capture a whole set of views. The contract is in
  `packages/render/assemble/SceneJump.ts`, and `tools/island/verify-scene-jump.mjs` checks it.
  `__PONLAI__.sceneJump` is 1 when the page supports the exact scene jump; the capture tools use
  this.
- The diagnostics also report the scene's anti-aliasing mode (`aa`, and `aaSource`: `url` or
  `tier`, which says where it came from), the number of pipelines created so far (`pipelines`,
  counted by `packages/render/debug/PipelineCounter.ts`) and `graph`, the frame graph's dev
  counters. These counters are the attachment load and store operations that the graph rewrote
  and expected in the last frame, the frames in which they differed, and the render targets found
  at a size other than their size class's.
- `__THREE_GAME_DIAGNOSTICS__.settled` is true once the paused page will draw the same frame from
  then on, and `settle` says why it is not true yet: [Test mode](test-mode.md), Settled.

Most counters in the diagnostics are rebuilt every 30 frames. Read live counters, such as
`__PONLAI__.pipelines.total`, from `__PONLAI__`.

## Keys

- H toggles the GUI.
- Space pauses.
- R, or 1, 2 and 3, jump to the island, horizon and sky views.
- F toggles a corner readout of the frame cadence.

## The island camera

The island camera starts at the island view's pose. The land's centre is in the middle of the
frame, and the camera is as far out as it needs to be to frame the land alone, from that heading,
with a margin of sea (about 96 m on the starting island). It looks 50 degrees down (`polar` 40)
from the `az` heading. When the land is framed nearer with its ring of shallows, that framing is
kept (`packages/island/camera/IslandFraming.ts`). While the camera still holds that pose, it
follows the pose when the window's shape changes, and it glides to the new pose when the land grows
(about 1.6 s, on the scene clock); on a paused page it moves there at once.

The manual controls move it (`packages/island/camera/IslandCameraControls.ts`):

- A left drag grabs the ground. A right or middle drag, or a left drag with Option or Ctrl held,
  turns and tilts.
- The wheel zooms toward the pointer. It zooms in from the island view's own distance to 70 m (or
  to the island view's distance, if that is farther), and never past it (`islandNearest` in
  `IslandStages.ts`; the review views keep 22 m).
- On a trackpad, a two-finger swipe pans, a pinch zooms, and a swipe with Option held turns and
  tilts.
- W, A, S, D or the arrow keys pan, Q and E turn, T and G tilt (from straight down to 8 degrees
  above the horizon), + and - zoom, and Shift makes all of them faster.
- R returns to the island view's pose.

The pivot stays over the land and its ring of shallows (their convex hull grown by 14 m). If you
pull it past that area, it moves on against a growing resistance (at most 10 m farther) and springs
back once you let go. `cameraInput=off`, or the GUI's Camera › move by hand, holds the view at its
pose. Q and E, or a right or middle drag, then turn it about the land's centre, and the wheel does
not zoom.

## Performance readout

The GUI's Performance folder (`packages/render/debug/FrameStats.ts`, which reads the rendered
frames' `requestAnimationFrame` timestamps) shows:

- the frame rate over the last second;
- the 95th percentile and the maximum of the frame interval over the last 5 s;
- the frames that are late by a refresh against the paced interval, and the intervals
  over 25 ms, since the scene appeared (or since the reset button was pressed);
- the render scale and the GPU's median frame time (high tier only);
- how the quality tier was chosen.
