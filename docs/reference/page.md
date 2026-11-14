# The page's handles and keys

What the running page offers a tool or a person at the keyboard: the debug handles that the
capture, probe and verify tools drive, the keys, the island camera's controls and the GUI's
performance readout. The page's URL options are in [URL options](url-options.md). The commands that
serve the page are `npm run dev` (port 5190), `npm run preview` (port 5191, the production build)
and `tools/kit/serve.mjs` (a worktree's server on a free port).

## Debug handles

`window.__PONLAI__` (the scene's handles) and `window.__THREE_GAME_DIAGNOSTICS__` (the
diagnostics) exist only on the dev server, or with `?debug` in the query (or `?profile`, which also
loads the frame profiler). A production preview needs `debug` for the tools to reach them.

- `__PONLAI__.loop.step( { frames, dt, scale, camera, onFrame, clock, converge } )` stops the live
  loop and steps the tick itself with fixed timestamps. The frame pacer and the dynamic scale are
  bypassed, and nothing is taken from the wall clock. `__PONLAI__.loop.start()` resumes the live
  loop.
- `__PONLAI__.establishScene( query )` jumps to a whole scene in place, as a fresh load of
  `?<query>` would draw it: weather, day clock, moon, scene clock and camera, with the leftovers of
  the scenes before cleared. Load-time options must match the page's. One page can so capture a
  whole set. The contract is in `packages/render/assemble/SceneJump.ts`, and
  `tools/island/verify-scene-jump.mjs` checks it. `__PONLAI__.sceneJump` is 1 when the page has the
  exact jump, which the capture tools use.
- The diagnostics add the scene's anti-aliasing (`aa`, and `aaSource`: `url` or `tier`, where it
  came from), the pipelines created so far (`pipelines`, counted by
  `packages/render/debug/PipelineCounter.ts`) and `graph`, the frame graph's dev counters (the
  attachment operations it rewrote and expected in the last frame, the frames they differed, and
  targets found at a size other than their class's).
- `__THREE_GAME_DIAGNOSTICS__.settled` is true once the paused page will draw the same frame from
  now on, and `settle` says why not yet: [Test mode](test-mode.md), Settled.

Most counters in the diagnostics are rebuilt every 30 frames; live counters such as
`__PONLAI__.pipelines.total` are read from `__PONLAI__`.

## Keys

- H toggles the GUI.
- Space pauses.
- R, or 1, 2 and 3, jump to the island, horizon and sky views.
- F toggles a corner readout of the frame cadence.

## The island camera

The island camera starts at the island view's pose: the land's centre in the middle of the frame,
as far out as frames the land alone from that heading with a margin of sea (about 96 m on the
starting island), looking 50 degrees down (`polar` 40) from the `az` heading. A land framed nearer
with its ring of shallows keeps that framing (`packages/island/camera/IslandFraming.ts`). While the
camera still holds that pose, it follows it when the window's shape changes, and glides to it
(about 1.6 s, on the scene clock) when the land grows; a paused page takes it at once.

The hand moves it (`packages/island/camera/IslandCameraControls.ts`):

- A left drag grabs the ground. A right or middle drag, or Option or Ctrl with the left, turns and
  tilts.
- The wheel zooms toward the pointer, from the island view's own distance in to 70 m (or that
  distance, if farther), never in past it (`islandNearest` in `IslandStages.ts`; the review views
  keep 22 m).
- On a trackpad, a two-finger swipe pans, a pinch zooms and Option with a swipe turns and tilts.
- W, A, S, D or the arrows pan, Q and E turn, T and G tilt (from straight down to 8 degrees over
  the horizon), + and - zoom, and Shift speeds them up.
- R returns to the island view's pose.

The pivot stays over the land and its ring of shallows (its convex hull grown by 14 m). Pulled past
that, it goes on against a growing resistance (at most 10 m farther) and springs back once let go.
`cameraInput=off`, or the GUI's Camera › move by hand, holds the view at its pose: Q and E or a right
or middle drag then turn it about the land's centre, and the wheel does not zoom.

## Performance readout

The GUI's Performance folder (`packages/render/debug/FrameStats.ts`, from the rendered frames'
`requestAnimationFrame` timestamps) shows:

- the frame rate over the last second;
- the interval's p95 and maximum over the last 5 s;
- the frames late by a refresh against the paced interval, and the intervals over 25 ms, since the
  scene showed (or since the reset button);
- the render scale and the GPU's median frame time (high only);
- how the quality tier was chosen.
