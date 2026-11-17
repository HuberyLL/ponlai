# Binding: fitting a look to reference images

This page holds this project's facts for the skill
[`fitting-a-look-to-reference-images`](../../skills/fitting-a-look-to-reference-images/SKILL.md).
Each section is named after the step of the skill that reads it. For a project of your own, copy the
section names and fill in your own facts.

Every command that renders in a browser runs under the GPU lock, and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`). Reference images stay out of the repository (`AGENTS.md`, Rules
for every change): keep them and the run's notes in the task's artifacts folder.

## Views

- A reproducible frame comes from the test mode: a paused page under MSAA, captured once `settled`
  holds (`docs/reference/test-mode.md`). `t=<hour>` and `weather=<name>` set the sun and the sky.
  The sun's elevation at each hour is given by `packages/render/sky/DayCycle.ts`.
- The island's views are in `tools/island/parity/views.mjs` (names, queries, and the scripts that
  place the camera). `tools/kit/parity/capture-set.mjs` captures them together on one warm page
  (their headers). Put a view of your own in a views file of the same form.
- To keep the sun at a fixed position relative to the camera, so that elevations compare like for
  like, use `tools/island/meadow-light.mjs` `--elev` and `--azimuth` (its header).
- The kept weathers are clear and fair. Fit the clear day first.

## Measure

- To measure regions on your frames in Oklab, by kind of surface and kind of light (sunlit rock,
  shaded grass, the sky, the darkest land), use `tools/island/region-colours.mjs` (its header). It
  reads the same cells before and after a change.
- To measure boxes on a reference image or a capture, use `uv run tools/kit/img.py stats` with
  `--oklab`, `--split` or `--linear`. On the test scenes, each capture's readings (`readings.json`
  of `tools/render/scenes.mjs`) hold the box of every region the scene names (cards, lit and shaded
  ground, balls, plant patches): use the same boxes on a reference image of the same view.
- To read the lighting apart from the albedos and the display chain, use `flags=lightOnly` and
  `__PONLAI__.radiance` (`docs/reference/url-options.md`, The lighting layer and Radiance). From a
  probe, use `tools/kit/probe.mjs` with `P.radiance( ... )`.
- To see how a quantity varies with the sun's elevation (for the form check), use
  `tools/island/dusk-grid.mjs` through dusk and dawn, and `tools/island/day-sweep.mjs` over the
  day.

## Parameters

- The parameters, what each does on screen and where it is read: the skill
  `building-cinematic-stylised-realism`, its `look-parameters.md`.
- The island's values are in `packages/island/look/`; write fitted values there.
- To try values without a rebuild, use the tunable parameters (`docs/reference/url-options.md`,
  Tunable parameters). At run time, call `__PONLAI__.tune.set( { name: value } )` (`P.tune` in a
  probe or in a capture's `--eval`). Before load, pass `tune=<base64 JSON>`, which
  `tune.query( values )` writes. A load-time tunable parameter needs a reload; `tune.list()` says
  which ones do. The parameter reference above lists the names without a running page. In the
  neutral look, the parameters that vary by time of day have one daytime keyframe, `@day`, and
  `@night`.
- For a short run on the render pipeline alone, use the test scenes (`tools/render/scenes.mjs`,
  `--q` for the tunable parameters, `--look ponlai` for the island's values). They load in seconds.

## Judge

- This project has no single written acceptance threshold. Unless the task sets one, use the day
  sweep's thresholds, which are about the smallest differences a viewer sees in a whole frame: a
  third of a stop in luminance, and 0.03 in the Oklab (a, b) plane for colour, lightness aside
  (`tools/island/day-sweep.mjs`, `--thr-stops`, `--thr-de`).
- Measured ranges that the look already holds are in `docs/reference/look-values.md`. To check the
  clear day's ratio of key light to ambient light on the meadow, run
  `tools/island/meadow-light.mjs --expect`.
- To compare side by side, use `uv run tools/kit/img.py sheet` with the reference and the capture
  as columns.

## Record

- Write fitted values in `packages/island/look/`, with the reason in the module's header comment,
  in the project's own terms. Write a measured value worth keeping in
  `docs/reference/look-values.md`.
- Never write in the repository which images a value was fitted to.
