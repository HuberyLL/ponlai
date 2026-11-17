# Binding: diagnosing visual defects

This project's facts for the skill
[`diagnosing-visual-defects`](../../skills/diagnosing-visual-defects/SKILL.md). Each section is
named after the step of the skill that reads it. A project of your own copies the section names
and fills in its own facts.

Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`). A page script used once stays in the task's artifacts folder.

## Reproduce

- The still view is the test mode: a paused page under MSAA (`debug&paused&t=12&quality=high`),
  final once `settled` holds (`docs/reference/test-mode.md`).
- Serve the checkout with `node tools/kit/serve.mjs dev`; `--sha <rev>` serves another commit, for
  a before-and-after or a bisection.
- The cheapest views are the render pipeline's test scenes (`scenes.html`: `ball`, `empty`,
  `plants`, `sea`), shot with `tools/render/scenes.mjs` (its header). The island: one view with
  `tools/kit/capture.mjs`, a list of views on one warm page with `tools/kit/parity/capture-set.mjs`.

  ```sh
  node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
    node tools/render/scenes.mjs <url> <out>/before --scenes ball --times clear-noon
  ```

- Whether two fresh loads agree: `scenes.mjs --verify`, or `capture-set.mjs --repeat`.

## Earlier defects

Check a fingerprint against these first (the commits give the measurements):

- A band low over the sky toward a set sun: the haze counted the earth's shadow twice
  (`packages/render/weather/VolumetricHaze.ts`, commit `391d754b`).
- Crumbs in the floor seen through shallow water: the sea's finest wave band too steep for its
  wind (`packages/render/ocean/OceanSpectrum.ts`, `591914dd`); specks left by reading the floor at
  one point per pixel (`packages/render/ocean/Water.ts`, `1d004020`).
- Waterline pixels that change with unrelated edits: shadow filters' derivatives in a branch
  (`packages/render/lighting/SolarShadow.ts`, `337fe7d2`).
- The vegetation gone for one frame after a render-scale step: depth cleared before the pass that
  loads it (the frame graph, `a693f742`).
- A NaN bounding box from zero matrices in the meadow pool's padding (`96facdae`).
- Pixels that differ between fresh loads over the water (the caustics): not this skill's; see the
  binding of `diagnosing-nondeterministic-frames`.
- three.js and WebGPU behaviours that show as defects: `docs/reference/three-behaviour.md` (Split
  draws, Build order, Uniform control flow, Draws skipped while compiling).

## Switches

- Load-time switches: `flags=<name>:<value>,...` in the query (`docs/reference/url-options.md`,
  Debug flags); the names are in `packages/render/debug/DebugFlags.ts`.
- The light apart from the albedo: `flags=lightOnly`, `ambientOnly`, `albedoOnly`,
  `occlusionOnly`, `opaqueVegetation`, `bareGround`, `classes` (`docs/reference/url-options.md`,
  The lighting layer); other views of the ambient light and occlusion in the section after it.
- At run time, on the page's handle `__PONLAI__` (`P` in a probe): hide a part
  (`P.water.mesh.visible = false`), set a flag (`P.flags.<name> = false`), move a tunable for a
  sweep (`P.tune.set( { name: value } )`, `docs/reference/url-options.md`, Tunable parameters).
- A sweep or an ablation as a set of shots: `tools/kit/parity/capture-set.mjs` with
  `--view "name:query[::js]"` per switched part, or `--sweep "key=a,b,c"` over a query option
  (its header).
- Read a value or the scene's linear radiance over a box without a screenshot:
  `tools/kit/probe.mjs` (`--eval`, `--until "D.settled"`), `P.radiance`
  (`docs/reference/url-options.md`, Radiance); the test scenes' readings in `readings.tsv`.
- The test scenes' readings are taken over each view's own boxes; a defect elsewhere (an edge, a
  rim) is read on the shot with `uv run tools/kit/img.py stats --box x,y,w,h` in image pixels.
- The exposure is metered automatically, so `lightOnly`, `grey:` and switched lights move it:
  compare the readings' linear radiance, not the shots' codes.

## Compare

- Stills: `uv run tools/kit/img.py diff|crop|sheet|stats` (diff with counts over thresholds and a
  heat map; region statistics with `--box`).
- Clips for temporal defects: `tools/kit/parity/capture-clip.mjs` (a stepped clip; `--aa gt` for
  the many-sample ground truth) and `uv run tools/kit/clip-metrics.py` (flicker, temporal
  instability, sharpness and ghosting against the ground truth); a clip's flicker map with
  `uv run tools/kit/img.py flicker`. Tolerances for temporal comparisons: `tools/kit/tolerance.py`.
- Then the checks of [verifying-rendering-changes](verifying-rendering-changes.md), Kinds. New
  stored references need the project owner's word (`tools/kit/parity/README.md`).

## Record

- A behaviour of three or WebGPU: `docs/reference/three-behaviour.md`, with its check.
- A module's rule and its reason: its header comment. The measurements before and after: the
  commit body, in relative terms.
