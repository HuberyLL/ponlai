# Check a change

This guide gives the steps for checking a change before it is committed: the checks every commit
passes, a change to the renderer on its small scenes, a visual change, a performance change, a new
history-dependent effect and a change that depends on the land's shape. The tools named here are
described in `docs/reference/tools.md`; the rules they check are in `AGENTS.md`, Rules for every
change.

## Run the checks every commit passes

1. Run `npm run check` before every commit. It runs the type check, the code lint
   (`npm run lint`: the project's mechanical rules as ESLint rules, `docs/reference/tools.md`, Code
   lint) and the checks that need no GPU (the layers' imports and the packages' exits, the
   settings against their docs, the files' size, the three.js internals, no binary in git, the CPU
   regression tools with the renderer's extension points and the lint's own fixtures, and the
   docs' lint when a Markdown file is staged), in about a quarter of a minute, and ends with a
   list of what passed and failed and how long each took. It checks the files in the working
   tree, not what is staged: a change left unstaged is checked too.
2. Fix every check it lists as failed, then run it again. A check that fails on a list of known
   cases (the layers' upward imports, the files over the size limit, the code that reaches into
   three's internals) is fixed in the code, never by adding to its list.
3. Before a merge, and after a change to the world's generator, run `npm run check -- --full`. It
   adds the production build and the world's chunk checks (`tools/island/verify-world-chunks.mjs`,
   `tools/island/verify-chunk-derived.mjs`) and takes minutes.

`npm run check` renders nothing, so it runs while another session holds the GPU lock. The checks
that render (captures, parity, the GPU verify tools) are run by hand, as the sections below say.

## Run the small scenes first

The renderer's test scenes (`scenes.html`) hold a few objects on level ground under the sky, a
patch of plants of the default kind, or two balls in the open sea. They load in seconds, so they
answer first whether a change to the renderer moved anything, before the island's captures, which
take minutes.

1. Run them first after a change to the renderer's own code: the light, the sky, the day cycle,
   the exposure and the display chain, the frame's passes, the shadows, the ambient light and the
   vegetation's registry, material and shadows. Skip them for a change to the island's generator,
   materials or plant kinds, or the game, which they do not show. The open sea's scene gives
   readings, not a check to the pixel: for a change to the sea's water and waves, run
   `node tools/render/scenes.mjs <baseUrl> <outDir> --scenes sea` before and after it and read the two
   `readings.tsv` side by side.
2. Before the change, write the references on a server of the commit the change starts from:
   `node tools/render/scenes.mjs <baseUrl> <outDir> --verify --write-ref`. Without `--scenes` it takes
   the scenes whose shots repeat to the pixel, so not the sea's.
3. After the change, run `node tools/render/scenes.mjs <baseUrl> <outDir> --verify --check`. A refactor
   passes with every shot equal to its reference. A change that is meant to move the picture
   fails the check: read `readings.tsv` of the two runs side by side, look at the shots that
   differ, and write the references again once the differences are the intended ones.
4. Go on to the island's checks below whatever the scenes say: they show no shore, terrain,
   island plants or game, and the island's look is not the one they are shot with.

The tool and its options: `docs/reference/tools.md`, Test scenes.

## Check a visual change

1. Capture the views the change touches before and after it (`tools/kit/capture.mjs` for one view,
   `tools/island/parity/capture-set.mjs` for a list of views on one warm page;
   `docs/reference/tools.md`, Captures).
2. Compare each capture against the previous one, and compare crops, not only the whole frame
   (`uv run tools/kit/img.py diff|crop|sheet|stats`).
3. Report the measured differences.

Where shapes differ (growth steps, seeds, a regenerated island), judge the look by eye and region
statistics (`tools/island/capture-growth.mjs`), not by pixel difference.

## Measure a performance change

Use `tools/profile-frame.mjs`; what its readings mean is in `docs/reference/tools.md`, Frame
profiler. A change is judged at high's standard (`AGENTS.md`, Rules for every change).

1. Measure on a production build, under the GPU lock: the scene matrix at the default generic
   display, before and after the change (`--compare` for an A/B, or `--toggle` on a debug flag
   while the change is in development).
2. Judge the A/B by its GPU time per pass (timestamps on), and take frame rates from a run without
   GPU timestamps (`--timestamps off` or `both`).
3. Judge whether high holds 60 fps with `--accept` (under vsync), not from uncapped intervals, at
   the tier's own settings (its dynamic scale measured at its settle point with
   `--scale-settle 5`), and check how the change plays on a fast display with `--display`.
4. Check `node tools/kit/gpu-lock.mjs gpu` before each run (and during it when other windows stay on
   screen), report contended runs as such, and check the change in a normal window too, not only
   `--kiosk`.

## Add a history-dependent effect

A history-dependent effect (a temporal resolve, exposure adaptation, lighting or fog accumulated
over frames, vegetation that responds to what passes through it, a per-frame physics simulation)
keeps the test mode's byte comparisons valid this way (`docs/reference/tools.md`, Test mode):

1. Register how to clear its history with the renderer's table
   (`packages/render/post/SceneHistory.ts`: `onJump` for a scene jump, `onCut` for a cut of the
   temporal modes' history), beside its creation; `establishScene` (`app/Scene.ts`) walks the table,
   and `tools/island/verify-scene-jump.mjs` checks it.
2. Report it to `settled` (`packages/render/RenderStages.ts` `settleFrame`'s `pending`, the page's
   own through `FrameHost.pending`, or the rest's signature) until it has converged
   on a still scene, or freeze it or turn it off in the test mode.
3. Freeze it or turn it off under the test mode's one switch (`packages/render/debug/TestMode.ts`;
   `docs/reference/tools.md`, Test mode).
4. A Grow does not clear rendering history (`tools/island/verify-growth-swap.mjs` shoots its first view
   without a jump), so the effect is frozen or off under the switch there, or the swap resets it.
5. Add its module to `WATCH.motion` in `tools/island/parity/carry.mjs` when its paths are not already
   there: with it frozen or off, the paused set no longer shows it, only the clips do.
6. Compare its frames outside the test mode (live, clips) within a tolerance, as the temporal
   modes' are (`tools/kit/tolerance.py`), unless they repeat pixel for pixel.

## Add something that depends on the land's shape

The island grows in place (`packages/island/world/Growth.ts`, its header): a Grow swaps in only the
changed chunks in one frame, and every dependent of the land's shape follows it.

1. Join the swap: `GrowthPage`, a vegetation kind's `growth` in `vegetation/Registry.ts`, and
   IslandStages.ts's `onSwap`.
2. Put the work it needs on the main thread into the preparation's idle-time steps, never into the
   swap's frame. A step takes a few tenths of a millisecond (a generator yielding inside its loops:
   `Steps.ts`, uploads through `Upload.ts`), so the growth's share of any frame stays under 2 ms
   (`growth.work`).
3. Check that a grown page draws a page loaded on that land bit for bit in the test mode:
   `node tools/island/verify-growth-swap.mjs`.
