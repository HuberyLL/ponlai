# Binding: diagnosing nondeterministic frames

This page holds this project's facts for the skill
[`diagnosing-nondeterministic-frames`](../../skills/diagnosing-nondeterministic-frames/SKILL.md).
Each section is named after the step of the skill that reads it. For a project of your own, copy the
section names and fill in your own facts.

Every command that renders in a browser runs under the GPU lock, and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`). A page script used once stays in the task's artifacts folder.

## Earlier causes

Check a fingerprint against these first.

- The caustics layer (`packages/render/ocean/WaveMaps.ts`) is drawn once, on the first lit frame,
  and kept. Its area ratio came from screen-space derivatives, whose last bits varied between runs
  on a busy GPU, and at the folds the ratio turned them into visible changes. Fingerprint: scattered
  pixels one level apart over the water, small clusters in shallow water, and the pre-exposure's EV
  different in its last bits. In the hashes, only layer 2 of the wave maps' target differs. It was
  fixed by computing the ratio per triangle in the vertex stage.
- Under the temporal modes, a held result whose rest is not aligned with the temporal rest. The sea
  reflection's rest (`packages/render/ocean/SeaReflection.ts`) is traced under the frame's jitter.
  It once started a frame before the temporal rest, so its first frame took the running
  sequence's jitter, whose place depends on how many frames the page had drawn. Fingerprint: a scene
  jump under `aa=taa` differs from fresh loads, which agree with each other, in low-frequency blotches
  over the near water (about 10 % of the pixels, window bias near 0.3 to 0.5). `diff-set.py`'s best
  pairing can hide it when one side of a pair is a load rather than a jump. To check it, record each
  frame's rest index beside the jitter's `k` (`P.jitter`) on both paths.
- Draws split differently, the order in which materials are first built, and draws skipped while
  their pipeline compiles: see Split draws, Build order and Draws skipped while compiling in
  `docs/reference/three-behaviour.md`.

## Reproduce

- The still frame is the test mode: a paused page under MSAA, final once `settled` holds
  (`docs/reference/test-mode.md`).
- Serve the checkout with `node tools/kit/serve.mjs dev`. `--sha <rev>` serves another commit for a
  before-and-after comparison.
- The cheapest reproduction is a test scene of the render pipeline (`tools/render/scenes.mjs`, its
  header). Each run loads its pages fresh, so a loop counts k of n. Take the first run as the
  reference for the others:

  ```sh
  node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
    node tools/render/scenes.mjs <url> <out>/1 --scenes sea --times clear-noon
  node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
    node tools/render/scenes.mjs <url> <out>/<i> --scenes sea --times clear-noon --check --ref <out>/1/neutral
  ```

- `--verify` tells a page that is not reproducible by itself apart from fresh loads that differ. It
  captures each view on one page, on a second page in reverse order, and on a fresh page.
- The island page: `tools/kit/parity/capture-set.mjs` with `--repeat` (two pages, an A/A pair) or
  with `--check` against a stored reference (its header).
- The readings beside each capture: the scenes' `readings.tsv` and each capture's `.json` file
  (the exposure, the lighting). A capture set's `.json` file holds `preExposure.ev`.

## Hash

Run the skill's page script through `tools/kit/probe.mjs`, with a fresh load per probe. The page's
debug global (`P` in a probe) reaches the render pipeline's parts: pass it whole as the root.

```sh
node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
  node tools/kit/probe.mjs <url>scenes.html \
  --q "scene=sea&debug&paused&t=12&quality=high&weather=clear&preset=noon" \
  --w 1920 --h 1080 --scale 2 --timeout 120000 \
  --until "D.settled" --eval "P.scenePage.setView('high')" --frames 4 --until "D.settled" \
  --eval "globalThis.HASH_TARGETS = { roots: P, renderer: P.renderer }; await P.loop.stop(); return 1" \
  --eval @skills/diagnosing-nondeterministic-frames/scripts/hash-targets.js > <out>/run-<i>.json
```

- On the island page, take the same steps on `<url>` with the view's query in `--q`, without
  `setView`.
- Values that differ by nature: the frame pacer (`pacer.*`), timings (`*.ms`, `lastBakeMs`,
  `warmStats`), and the frame numbers that the settled signal keeps (`settled.frame`, `since`,
  `quietStart`).
- To hash an input at the moment of its draw, or to redraw a result on its own, write a probe
  `--eval` of your own that reaches the module through `P` (the wave maps: `P.pipeline.waveMaps`).
  `--init` wraps a function before the page's scripts run (`tools/kit/probe.mjs`, its header).

## Fix

- A kept result that waits for its inputs holds the page's ready signal through `settled`'s
  `pending` list (`packages/render/post/Settled.ts`;
  [verifying-rendering-changes](verifying-rendering-changes.md), History).
- A new fact about three.js or WebGPU goes into `docs/reference/three-behaviour.md`, and the
  module's rule goes into the module's header.
- A fix that changes the converged image needs new stored references (`tools/kit/parity/README.md`).
  The project owner decides before they are written.

## Prove

- Run the loop of Reproduce, with N chosen as the skill says.
- Then run the checks that the change touches
  ([verifying-rendering-changes](verifying-rendering-changes.md), Kinds): the test scenes with
  `--verify --check`, the parity set with `--check`, `tools/island/verify-scene-jump.mjs`,
  `tools/island/verify-growth-swap.mjs`, and `npm run check`.
