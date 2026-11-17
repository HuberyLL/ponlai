# Binding: fitting a look to reference images

This project's facts for the skill
[`fitting-a-look-to-reference-images`](../../skills/fitting-a-look-to-reference-images/SKILL.md).
Each section is named after the step of the skill that reads it. A project of your own copies the
section names and fills in its own facts.

Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`). Reference images stay out of the repository (`AGENTS.md`,
Rules for every change); keep them and the run's notes in the task's artifacts folder.

## Views

- A repeatable frame is the test mode: a paused page under MSAA, shot once `settled` holds
  (`docs/reference/test-mode.md`). `t=<hour>` and `weather=<name>` reach a sun and a sky;
  the sun's elevation by hour is `packages/render/sky/DayCycle.ts`'s.
- The island's views: `tools/island/parity/views.mjs` (names, queries, the evals that place the
  camera), shot together on one warm page by `tools/kit/parity/capture-set.mjs`
  (their headers). A view of your own goes in a views
  file of the same form.
- A view that keeps the sun where it stands against the camera, so elevations compare like for
  like: `tools/island/meadow-light.mjs` `--elev` and `--azimuth` (its header).
- Kept weathers: clear and fair. Fit the clear day first.

## Measure

- Region rows on your frames, by kind of surface and kind of light (sunlit rock, shaded grass, the
  sky, the darkest land) in Oklab: `tools/island/region-colours.mjs` (its
  header). It reads the same cells before and after a change.
- Boxes on a reference image or a capture: `uv run tools/kit/img.py stats` with `--oklab`,
  `--split` or `--linear`. On the test scenes, each shot's readings (`readings.json` of
  `tools/render/scenes.mjs`) hold the box of every region the scene names (cards, lit and shaded
  ground, balls, plant patches): use the same boxes on a reference of the same view.
- The light apart from the albedos and the display chain: `flags=lightOnly` and
  `__PONLAI__.radiance` (`docs/reference/url-options.md`, The lighting layer and Radiance); from a
  probe, `tools/kit/probe.mjs` with `P.radiance( ... )`.
- How a quantity runs over the sun's elevation (for the form check): `tools/island/dusk-grid.mjs`
  through the dusk and dawn, `tools/island/day-sweep.mjs` over the day.

## Knobs

- The knobs, what each does on screen and where it is read: the skill
  `building-cinematic-stylised-realism`, its `look-parameters.md`.
- The island's values are in `packages/island/look/`; fitted values are written there.
- Trying values without a rebuild: the tunables (`docs/reference/url-options.md`, Tunable
  parameters). At run time `__PONLAI__.tune.set( { name: value } )` (`P.tune` in a probe or a
  capture's `--eval`); before load `tune=<base64 JSON>`, which `tune.query( values )` writes. A
  load-time tunable needs a reload; `tune.list()` says which. The knob reference above lists the
  names with no page running; the neutral look's keyed knobs have one day key, `@day`, and `@night`.
- A short run on the render pipeline alone: the test scenes (`tools/render/scenes.mjs`, `--q` for
  the tunables, `--look ponlai` for the island's set) load in seconds.

## Judge

- No single acceptance threshold is written for this project. Unless the task sets one, take the
  day sweep's, about the least differences one sees in a whole frame: a third of a stop in
  luminance, and 0.03 in the Oklab (a, b) plane for colour, lightness aside
  (`tools/island/day-sweep.mjs`, `--thr-stops`, `--thr-de`).
- Measured windows that already hold: `docs/reference/look-values.md`; the clear day's meadow key
  against its ambient light: `tools/island/meadow-light.mjs --expect`.
- Side by side: `uv run tools/kit/img.py sheet` with the reference and the capture as columns.

## Record

- Fitted values: `packages/island/look/`, with the reason in the module's header comment in the
  project's own terms. A measured value worth keeping: `docs/reference/look-values.md`.
- Never write in the repository which images a value was fitted to.
