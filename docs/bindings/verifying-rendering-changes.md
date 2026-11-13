# Binding: verifying rendering changes

This project's facts for the skill
[`verifying-rendering-changes`](../../skills/verifying-rendering-changes/SKILL.md). Each section is
named after the step of the skill that reads it. A project of your own copies the section names and
fills in its own facts.

Each tool's manual is its header (`node <tool> --help`; the index: `docs/reference/tools.md`).
Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`; `docs/reference/gpu-lock.md`). The capture, probe and verify
tools lease a shared slot themselves (their headers say so); a command of one's own runs under
`node tools/kit/gpu-lock.mjs run --shared -- <command>`, and wrapping a tool so does no harm (its
captures take the wrapper's slot over). Changes hold in the
kept weathers (clear, fair) and on high at 4K output; the parked ones are out of every default set
(`docs/reference/tools.md`, Parked weathers and quality tiers).

Contents:

- [Kinds](#kinds)
- [Views](#views)
- [Capture](#capture)
- [Compare](#compare)
- [References](#references)
- [History](#history)
- [Checks](#checks)

## Kinds

What to run after which change, beyond the skill's comparison:

| Change | Run |
| --- | --- |
| Every commit | `npm run check`: types, code lint and every check that needs no GPU (the list: `tools/check.mjs`'s header). It renders nothing, so it runs while another session holds the GPU. |
| Before a merge, or after a change to the world's generator | `npm run check -- --full`: adds the production build, `tools/island/verify-world-chunks.mjs` and `tools/island/verify-chunk-derived.mjs` (minutes). After a generator change, the world checks come before any capture. |
| The renderer's own code: the light, the sky, the day cycle, the exposure and display chain, the frame's passes, the shadows, the ambient light, the vegetation's registry, material and shadows | The test scenes first (Views), then the island's views. Not for the island's generator, materials or plant kinds, or the game, which the test scenes do not show. |
| A shader, a pass or a material's node graph | `node tools/render/wgsl-build.mjs <entry> --out <dir>` in each side's checkout and a diff of the two folders: no GPU (its header lists the entries). The writing rules: `writing-tsl-and-passes` and its binding. |
| Something that depends on the land's shape | `tools/island/verify-growth-swap.mjs` (a grown page against a fresh load of its land); how it joins the growth: `packages/island/world/Growth.ts`'s header. |
| A new scene state, a scene event, a history | `tools/island/verify-scene-jump.mjs` (History). |
| Anything that may build a pipeline after load (a swap, a first draw) | `tools/render/verify-first-use.mjs`. |
| Which objects a pass or system takes (a selection, a filter, a registry) | Before the captures, read the pass's own counts and the objects it took on both builds with `tools/kit/probe.mjs` (for the vegetation prepass, `scene.userData.vegetationPrepass`); `verify-growth-swap` when the selection also runs on what a Grow adds. |
| A change for speed | `measuring-performance-changes` and its binding; the image check is this skill's. |

Cases that move pixels while correct: splitting or merging draws (`docs/reference/three-behaviour.md`,
Split draws) and the order materials first build in (Build order).

## Views

- The island's views: `node tools/island/parity/views.mjs list [group]`. `parity` (the default, 10
  views) and `taa` (6 close views of thin and moving detail); `all` is both. Each view names its
  crop anchors (`views.mjs crops <view>`): 1:1 boxes on its subjects, cut by `diff-set.py
  --crops-from`. Views of one's own: `--view "name:query[::js]"`; a knob's values: `--sweep`
  (`tools/kit/parity/capture-set.mjs`'s header).
- A view that can see the change: switch the part off or coarsen it with its URL option
  (`docs/reference/url-options.md`, Every option; for example `vegPrepass=0`) and check the view
  moves.
- The test scenes (`scenes.html`): `ball` (an 18 % grey card, albedo and roughness rows), `empty`
  (level ground under the sky), `plants` (a patch of the default plant kind), `sea` (two balls in
  the open sea). They load in seconds and draw with the renderer's neutral look, and show no
  shore, terrain, island plants or game: go on to the island's views whatever they say.
- The sea scene's reflectors stand within a few tens of metres; a change to the water's reflection
  range shows only in the island's views over the sea.

## Capture

- The test mode (`docs/reference/test-mode.md`): `paused` in the query loads MSAA, and a shot waits
  for `__THREE_GAME_DIAGNOSTICS__.settled`. Every capture, parity and verify tool loads so.
- Serve the start commit's production build from its own worktree:
  `node tools/kit/serve.mjs preview --sha <rev>`; the change: `node tools/kit/serve.mjs preview`.
- The island's views: `node tools/kit/parity/capture-set.mjs <url> <out> --reference <root>/<sha>/<set>`
  stores a commit's set, and `--check <root>/<sha>/<set> --ref-url <start commit's url>` captures
  the change and compares it, making the reference first when it is missing. `--repeat` shoots each
  view twice for its A/A. One view: `tools/kit/capture.mjs`.
- The store's root is `artifacts/parity` (git-ignored; the default of `carry.mjs` and
  `baseline.mjs`), so a set lives at `artifacts/parity/<sha>/<set>`. Both sides use the same
  `--size`; capture-set's default is `1728x1117@2`, and `--size 1920x1080@2` gives the 4K output the
  rules judge at.
- The store and its key: `tools/kit/reference.mjs`'s header (the capture tools' sources listed in
  `tools/project.mjs` `reference.toolFiles`, the browser build, the options; a server whose build
  inputs differ is refused). When to recapture, a new browser build and taking over an earlier
  commit's baseline (`tools/kit/parity/carry.mjs`): `tools/kit/parity/README.md`.
- The test scenes: on the start commit's server, `node tools/render/scenes.mjs <url> <out> --verify
  --write-ref` (without `--scenes` it takes the scenes whose shots repeat to the pixel, not `sea`);
  the references go to `artifacts/scenes/reference/<look>/` (git-ignored), or to `--ref <dir>`,
  which keeps one comparison's references apart from that default folder.

## Compare

- The island's views: `capture-set.mjs --check` runs `uv run tools/kit/diff-set.py` with
  `--max-px1 0` under MSAA, `--aa-floor` on sets shot with `--repeat` (each view against its own
  A/A) and `--temporal` for `taa`, `taau`, `fsr3` and `gt`. Its table, crops and PASS or FAIL land
  in the test folder.
- The temporal tolerance, its thresholds and its calibration: `tools/kit/tolerance.py`. What
  repeats and what does not in this renderer: `tools/kit/parity/README.md`.
- The test scenes: `scenes.mjs <url> <out> --verify --check`. The `sea` scene gives readings, not a
  pixel check: run `--scenes sea` before and after and read the two `readings.tsv` side by side.
- Stills of one's own: `uv run tools/kit/img.py diff|crop|sheet|stats` (counts over thresholds, a
  heat map, region statistics with `--box`).
- Different content (growth steps, seeds, a regenerated island): `tools/island/capture-growth.mjs`
  and region statistics, judged by eye.
- A same-build disagreement: `diagnosing-nonrepeating-frames` and its binding.

## References

- The test scenes: after a change meant to move them, read the two runs' `readings.tsv`, look at
  the shots that differ, and `--write-ref` again once the differences are the intended ones.
- The island's references are kept per commit, so the change's commit gets its own; what is
  reported is its measured difference from the start commit's, for the owner to accept.
- Motion: `tools/kit/parity/capture-clip.mjs` (stepped clips; `--aa gt` for the many-sample ground
  truth) and `uv run tools/kit/clip-metrics.py`; the anti-aliasing gates' baseline and verdicts:
  `tools/kit/parity/baseline.mjs`, `tools/kit/gates.py`, `tools/kit/table.py`.

## History

A history-dependent effect (a temporal resolve, exposure adaptation, lighting or fog accumulated
over frames, vegetation that responds to what passes through it, a physics simulation stepped per
frame) keeps the test mode's byte comparisons valid this way:

1. Register how to clear its history with `packages/render/post/SceneHistory.ts` (`onJump` for a
   scene jump, `onCut` for a cut of the temporal modes' history), beside its creation;
   `establishScene` (`app/Scene.ts`) walks the table, and `tools/island/verify-scene-jump.mjs`
   checks it.
2. Report it to `settled` until it has converged on a still scene (`packages/render/RenderStages.ts`
   `settleFrame`'s `pending`, the page's own through `FrameHost.pending`, or the rest's signature),
   or freeze it or turn it off in the test mode.
3. Freeze it or turn it off under the test mode's one switch, `packages/render/debug/TestMode.ts`.
   The effects so handled: `docs/reference/test-mode.md`.
4. A Grow does not clear rendering history (`tools/island/verify-growth-swap.mjs` shoots its first
   view without a jump), so the effect is frozen or off under the switch there, or the swap resets
   it.
5. Add its module to `reference.watch.motion` in `tools/project.mjs` when its paths are not already
   there: frozen or off, it no longer shows in the paused set, only in the clips.
6. Compare its frames outside the test mode (live, clips) within the temporal tolerance
   (`tools/kit/tolerance.py`), unless they repeat pixel for pixel.

Its declaration on the renderer's registry (`testMode` in `packages/render/Extensions.ts`) is
checked by `tools/render/verify-extensions.mjs`.

## Checks

- `npm run check` before every commit; `npm run lint:docs` when Markdown changed.
- The rule for every visual change (`AGENTS.md`, Rules for every change): compared against captures
  from before it, crops included, the measured differences reported, in the commit body, as
  relative numbers.
