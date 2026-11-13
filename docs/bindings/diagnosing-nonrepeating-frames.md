# Binding: diagnosing non-repeating frames

This project's facts for the skill
[`diagnosing-nonrepeating-frames`](../../skills/diagnosing-nonrepeating-frames/SKILL.md). Each
section is named after the step of the skill that reads it. A project of your own copies the
section names and fills in its own facts.

Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/job.mjs` (`AGENTS.md`). A page script used once stays in the task's artifacts folder.

## Earlier causes

Check a fingerprint against these first.

- The caustics' layer (`packages/render/ocean/WaveMaps.ts`), drawn once on the first lit frame and
  kept. Its area ratio came from screen derivatives, whose last bits varied between runs on a busy
  GPU; at the folds the ratio turned them into visible changes. Fingerprint: scattered pixels a
  level apart over the water, small clusters in shallow water, the pre-exposure's EV apart in its
  last bits; in the hashes, only layer 2 of the wave maps' target differs. Fixed by computing the
  ratio per triangle in the vertex stage.
- Split draws, build order and draws skipped while compiling:
  `docs/reference/three-behaviour.md`, the sections of those names.

## Reproduce

- The still frame is the test mode: a paused page under MSAA, final once `settled` holds
  (`docs/reference/tools.md`, Test mode).
- Serve the checkout with `node tools/serve.mjs dev`; `--sha <rev>` serves another commit for a
  before-and-after.
- The cheapest reproduction is a test scene of the renderer (`tools/scenes.mjs`, its header). Each
  run loads its pages fresh, so a loop counts k of n. Take the first run as the reference of the
  others:

  ```sh
  node tools/job.mjs start --wait -- node tools/gpu-lock.mjs run --shared -- \
    node tools/scenes.mjs <url> <out>/1 --scenes sea --times clear-noon
  node tools/job.mjs start --wait -- node tools/gpu-lock.mjs run --shared -- \
    node tools/scenes.mjs <url> <out>/<i> --scenes sea --times clear-noon --check --ref <out>/1/neutral
  ```

- `--verify` tells a page that does not repeat itself from fresh loads that differ: it shoots each
  view on one page, on a second page in reverse order and on a fresh page.
- The island page: `tools/parity/capture-set.mjs` with `--repeat` (two pages, A/A) or `--check`
  against a stored reference (its header).
- Readings beside each shot: the scenes' `readings.tsv` and each shot's `.json` (exposure, light);
  a capture set's `.json` holds `preExposure.ev`.

## Hash

Run the skill's page script through `tools/probe.mjs`, a fresh load per probe. The page's debug
global (`P` in a probe) reaches the renderer's parts: pass it whole as the root.

```sh
node tools/job.mjs start --wait -- node tools/gpu-lock.mjs run --shared -- \
  node tools/probe.mjs <url>scenes.html \
  --q "scene=sea&debug&paused&t=12&quality=high&weather=clear&preset=noon" \
  --w 1920 --h 1080 --scale 2 --timeout 120000 \
  --until "D.settled" --eval "P.scenePage.setView('high')" --frames 4 --until "D.settled" \
  --eval "globalThis.HASH_TARGETS = { roots: P, renderer: P.renderer }; await P.loop.stop(); return 1" \
  --eval @skills/diagnosing-nonrepeating-frames/scripts/hash-targets.js > <out>/run-<i>.json
```

- The island page takes the same steps on `<url>` with the view's query in `--q`, without
  `setView`.
- Values that differ by nature: the frame pacer (`pacer.*`), timings (`*.ms`, `lastBakeMs`,
  `warmStats`) and the frame numbers the settled signal keeps (`settled.frame`, `since`,
  `quietStart`).
- An input hashed at the moment of its draw, or a redraw on its own: a probe `--eval` of your own
  reaches the module through `P` (the wave maps: `P.pipeline.waveMaps`); `--init` wraps a function
  before the page's scripts run (`tools/probe.mjs`, its header).

## Fix

- A kept result that waits for its inputs holds the page's ready signal through `settled`'s
  `pending` list (`packages/render/post/Settled.ts`; `docs/how-to/check-a-change.md`, Add a
  history-dependent effect).
- A new fact about three.js or WebGPU goes into `docs/reference/three-behaviour.md`, and the
  module's rule into its header.
- A fix that changes the converged image needs new stored references (`tools/parity/README.md`):
  the project owner decides before they are written.

## Prove

- The loop of Reproduce, with N chosen as the skill says.
- Then the checks the change touches (`docs/how-to/check-a-change.md`): the test scenes with
  `--verify --check`, the parity set with `--check`, `tools/verify-scene-jump.mjs`,
  `tools/verify-growth-swap.mjs`, and `npm run check`.
