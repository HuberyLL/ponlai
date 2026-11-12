# Check a change

This guide gives the steps for checking a change before it is committed: a visual change, a
performance change, a new history-dependent effect and a change that depends on the land's shape.
The tools named here are described in `docs/reference/tools.md`; the rules they check are in
`AGENTS.md`, Rules for every change.

## Check a visual change

1. Capture the views the change touches before and after it (`tools/capture.mjs` for one view,
   `tools/parity/capture-set.mjs` for a list of views on one warm page;
   `docs/reference/tools.md`, Captures).
2. Compare each capture against the previous one, and compare crops, not only the whole frame
   (`uv run tools/img.py diff|crop|sheet|stats`).
3. Report the measured differences.

Where shapes differ (growth steps, seeds, a regenerated island), judge the look by eye and region
statistics (`tools/capture-growth.mjs`), not by pixel difference.

## Measure a performance change

Use `tools/profile-frame.mjs` (`docs/reference/tools.md`, Frame profiler).

- Measure on a production build, under the GPU lock: the scene matrix at the default generic
  display (1920x1080 CSS at DPR 2, quality high), before and after a change (`--compare` for an
  A/B, or `--toggle` on a debug flag while the change is in development).
- Judge an A/B by its GPU time per pass (timestamps on); take frame rates from a run without GPU
  timestamps (`--timestamps off` or `both`): Chrome ran frames up to a quarter faster with them
  on, so their per-pass split shows where the time goes, not the frame rate a player sees. (A tier
  with a dynamic resolution keeps its own timestamp queries in every run, as a player's page does;
  `--q gpuTimer=off` leaves them out.) Uncapped, the page runs about 120 frames ahead of the GPU,
  so a frame's timestamps come back seconds later (a scene's `profiler.readbackMs`: 2.5-6.5 s on
  `island-fair-noon` and `meadow-close`); the profiler waits for each frame's own read-back, with
  no time limit, and `missingPasses` counts only passes whose query was never written or whose
  read-back failed. A run with `timedFrames` 0 is a bug, not a busy GPU.
- High is timed at its standard by default: 4K output (1920x1080 CSS at DPR 2) at 1440p's pixel
  count, upscaled by FSR 1, with MSAA 4x, the level every trade-off is judged at, with about 14 ms
  of GPU time a frame in the normal scenes (island views, `meadow-close`) as the budget. A profile,
  `--compare` or `--toggle` of high pins the baseline of its dynamic rule for the viewport
  (`dpr=1.3333333333333333` at the default; `dpr=1` at `--w 2560 --h 1440 --scale 1`, a 2K display:
  `src/post/RenderScale.ts` `dynamicRange`); `--unpinned` leaves the
  tier's own rule (a dynamic one steering, with `--scale-settle 5 --scale-log` to see where it
  settles). `--accept`, `--display`, `--scales` and a `dpr` of the url's or `--q`'s own are never
  pinned.
- Judge whether a tier holds 60 fps with `--accept` (under vsync), not from uncapped intervals, at
  the tier's own settings (high with its dynamic scale, measured at its settle point with
  `--scale-settle 5`; the report gives each scene's scale), and check how a change plays on a fast
  display with `--display` (pacing, cadence, the scale's changes under drags).
- Report contended runs as such: check `node tools/gpu-lock.mjs gpu` before each run (and during
  it when other windows stay on screen). A player's window is not full screen: other apps stay
  visible and may keep drawing (a Ponlai page in an app's hidden browser pane took half the GPU and
  held the player's scale at its floor), so check a change in a normal window too, not only
  `--kiosk`. Headless at 60 Hz matched the display's GPU times within about 5 %.

## Add a history-dependent effect

A history-dependent effect (a temporal resolve, exposure adaptation, lighting or fog accumulated
over frames, vegetation that responds to what passes through it, a per-frame physics simulation)
keeps the test mode's byte comparisons valid this way (`docs/reference/tools.md`, Test mode):

1. Clear its history in `establishScene` (`src/main.ts`); `tools/verify-scene-jump.mjs` checks it.
2. Report it to `settled` (main.ts `pending`, or the rest's signature) until it has converged on a
   still scene, or freeze it or turn it off in the test mode.
3. Freeze it or turn it off under the test mode's one switch (`src/debug/TestMode.ts`;
   `docs/reference/tools.md`, Test mode).
4. A Grow does not clear rendering history (`tools/verify-growth-swap.mjs` shoots its first view
   without a jump), so the effect is frozen or off under the switch there, or the swap resets it.
5. Add its module to `WATCH.motion` in `tools/parity/carry.mjs` when its paths are not already
   there: with it frozen or off, the paused set no longer shows it, only the clips do.
6. Compare its frames outside the test mode (live, clips) within a tolerance, as the temporal
   modes' are (`tools/parity/tolerance.py`), unless they repeat pixel for pixel.

## Add something that depends on the land's shape

The island grows in place (`AGENTS.md`, Rules for every change): a Grow swaps in only the changed
chunks in one frame, and every dependent of the land's shape follows it.

1. Join the swap: `GrowthPage`, a vegetation kind's `growth` in `vegetation/Registry.ts`, and
   main.ts's `onSwap`.
2. Put the work it needs on the main thread into the preparation's idle-time steps, never into the
   swap's frame. A step takes a few tenths of a millisecond (a generator yielding inside its loops:
   `Steps.ts`, uploads through `Upload.ts`), so the growth's share of any frame stays under 2 ms
   (`growth.work`).
3. Check that a grown page draws a page loaded on that land bit for bit in the test mode:
   `node tools/verify-growth-swap.mjs`.
