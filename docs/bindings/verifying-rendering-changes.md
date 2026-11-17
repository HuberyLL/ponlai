# Binding: verifying rendering changes

This page holds this project's facts for the skill
[`verifying-rendering-changes`](../../skills/verifying-rendering-changes/SKILL.md). Each section is
named after the step of the skill that reads it. For a project of your own, copy the section names
and fill in your own facts.

Each tool's manual is its header (`node <tool> --help`; the index is `docs/reference/tools.md`).
Every command that renders in a browser runs under the GPU lock, and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`; `docs/reference/gpu-lock.md`). The capture, probe and verify
tools lease a shared slot of the lock themselves (their headers say so). Run a command of your own
under `node tools/kit/gpu-lock.mjs run --shared -- <command>`. Wrapping a tool this way does no
harm: its captures take over the wrapper's slot. Changes must hold in the kept weathers (clear,
fair) and on the high tier at 4K output; the parked weathers and tiers are left out of every default
set (`docs/reference/tools.md`, Parked weathers and quality tiers).

Contents:

- [Kinds](#kinds)
- [Views](#views)
- [Capture](#capture)
- [Compare](#compare)
- [References](#references)
- [History](#history)
- [Checks](#checks)

## Kinds

What to run after each kind of change, beyond the skill's comparison:

| Change | Run |
| --- | --- |
| Every commit | `npm run check`: types, the code lint and every check that needs no GPU (the list is in `tools/check.mjs`'s header). It renders nothing, so it can run while another session holds the GPU. |
| Before a merge, or after a change to the world's generator | `npm run check -- --full`: adds the production build, `tools/island/verify-world-chunks.mjs` and `tools/island/verify-chunk-derived.mjs` (minutes). After a generator change, run the world checks before any capture. |
| The render pipeline's own code: the lighting, the sky, the day cycle, the exposure and display chain, the frame's passes, the shadows, the ambient light, the vegetation's registry, material and shadows | The test scenes first (Views), then the island's views. This does not cover the island's generator, materials or plant kinds, or the game, which the test scenes do not show. |
| A shader, a pass or a material's node graph | `node tools/render/wgsl-build.mjs <entry> --out <dir>` in each side's checkout, and a diff of the two folders. It needs no GPU (its header lists the entries). The rules for writing them: `writing-tsl-and-passes` and its binding. |
| Something that depends on the land's shape | `tools/island/verify-growth-swap.mjs` (a grown page against a fresh load of its land). How such code joins the growth: `packages/island/world/Growth.ts`'s header. |
| A new scene state, a scene event, a history | `tools/island/verify-scene-jump.mjs` (History). |
| Anything that may build a pipeline after load (a swap, a first draw) | `tools/render/verify-first-use.mjs`. |
| Which objects a pass or system takes (a selection, a filter, a registry) | Before the captures, read the pass's own counts and the objects it took on both builds with `tools/kit/probe.mjs` (for the vegetation prepass, `scene.userData.vegetationPrepass`). Run `verify-growth-swap` as well when the selection also runs on what a growth adds. |
| A change for speed | `measuring-performance-changes` and its binding; the image check is this skill's. |

Some correct changes alter pixels: splitting or merging draws (`docs/reference/three-behaviour.md`,
Split draws) and changing the order in which materials are first built (Build order).

## Views

- The island's views: `node tools/island/parity/views.mjs list [group]`. The groups are `parity`
  (the default, 10 views) and `taa` (6 close views of thin and moving detail); `all` is both. Each
  view names its crop anchors (`views.mjs crops <view>`): 1:1 boxes on its subjects, cut by
  `diff-set.py --crops-from`. For views of your own, use `--view "name:query[::js]"`; for a range of
  values of one parameter, use `--sweep` (`tools/kit/parity/capture-set.mjs`'s header).
- To get a view that can see the change, switch the changed part off or coarsen it with its URL
  option (`docs/reference/url-options.md`, Every option; for example `vegPrepass=0`), and check that
  the view changes.
- The test scenes (`scenes.html`) are `ball` (an 18 % grey card, with rows of balls that vary albedo
  and roughness), `empty` (level ground under the sky), `plants` (a patch of the default plant kind)
  and `sea` (two balls in the open sea). They load in seconds and draw with the render pipeline's
  neutral look. They show no shore, terrain, island plants or game, so go on to the island's views
  whatever they show.
- The sea scene's reflected objects stand within a few tens of metres, so a change to the water's
  reflection range shows only in the island's views over the sea.

## Capture

- The test mode (`docs/reference/test-mode.md`): `paused` in the query loads MSAA, and a capture
  waits for `__THREE_GAME_DIAGNOSTICS__.settled`. Every capture, parity and verify tool loads the
  page this way.
- Serve the start commit's production build from its own worktree with
  `node tools/kit/serve.mjs preview --sha <rev>`. Serve the change with
  `node tools/kit/serve.mjs preview`.
- The island's views: `node tools/kit/parity/capture-set.mjs <url> <out> --reference
  <root>/<sha>/<set>` stores a commit's set. `--check <root>/<sha>/<set> --ref-url <start commit's
  url>` captures the change and compares it, and first makes the reference when it is missing.
  `--repeat` captures each view twice for its A/A pair. For one view, use `tools/kit/capture.mjs`.
- The store's root is `artifacts/parity` (git-ignored; the default of `carry.mjs` and
  `baseline.mjs`), so a set lives at `artifacts/parity/<sha>/<set>`. Both sides use the same
  `--size`. The default of `capture-set.mjs` is `1728x1117@2`; `--size 1920x1080@2` gives the 4K
  output that the rules judge at.
- The store and its key are described in `tools/kit/reference.mjs`'s header. The key holds the
  capture tools' sources (listed in `tools/project.mjs` `reference.toolFiles`), the browser build
  and the options, and a server whose build inputs differ is refused. When to recapture, how to
  handle a new browser build, and how to take over an earlier commit's baseline
  (`tools/kit/parity/carry.mjs`) are in `tools/kit/parity/README.md`.
- The test scenes: on the start commit's server, run
  `node tools/render/scenes.mjs <url> <out> --verify --write-ref`. Without `--scenes`, it takes
  the scenes whose captures are pixel-identical between runs, which excludes `sea`. The references
  go to `artifacts/scenes/reference/<look>/` (git-ignored), or to `--ref <dir>`, which keeps one
  comparison's references apart from that default folder.

## Compare

- The island's views: `capture-set.mjs --check` runs `uv run tools/kit/diff-set.py`. Under MSAA it
  passes `--max-px1 0`. On sets captured with `--repeat` it passes `--aa-floor` (each view against
  its own A/A pair), and for `taa`, `taau`, `fsr3` and `gt` it passes `--temporal`. Under MSAA it
  also passes `--held`, which compares the pixels that the sea's held reflection reaches within the
  held tolerance and the rest of the frame exactly. Its table, crops and PASS or FAIL land in the
  test folder.
- The temporal and held tolerances, their thresholds and their calibration are in
  `tools/kit/tolerance.py`. Which frames in this render pipeline are deterministic and which are
  not: `tools/kit/parity/README.md`.
- The test scenes: `scenes.mjs <url> <out> --verify --check`. The `sea` scene gives readings, not a
  pixel check: run `--scenes sea` before and after, and read the two `readings.tsv` files side by
  side.
- Stills of your own: `uv run tools/kit/img.py diff|crop|sheet|stats` (counts over thresholds, a
  heat map, region statistics with `--box`).
- Different content (growth steps, seeds, a regenerated island): `tools/island/capture-growth.mjs`
  and region statistics, judged by eye.
- A disagreement of one build with itself: `diagnosing-nondeterministic-frames` and its binding.

## References

- The test scenes: after a change meant to alter them, read the two runs' `readings.tsv` files,
  look at the captures that differ, and run `--write-ref` again once the differences are the
  intended ones.
- The island's references are kept per commit, so the change's commit gets its own. The report
  gives its measured difference from the start commit's references, for the owner to accept.
- Motion: `tools/kit/parity/capture-clip.mjs` captures stepped clips (`--aa gt` for the many-sample
  ground truth), and `uv run tools/kit/clip-metrics.py` measures them. The anti-aliasing checks'
  baseline and verdicts: `tools/kit/parity/baseline.mjs`, `tools/kit/gates.py`,
  `tools/kit/table.py`.

## History

A history-dependent effect is, for example, a temporal resolve, exposure adaptation, lighting or fog
accumulated over frames, vegetation that responds to what passes through it, or a physics
simulation stepped per frame. Such an effect keeps the test mode's byte comparisons valid this way:

1. Register how to clear its history with `packages/render/post/SceneHistory.ts`, next to the code
   that creates the effect: `onJump` for a scene jump, `onCut` for a cut of the temporal modes'
   history. `establishScene` (`packages/render/assemble/SceneJump.ts`) walks the table, and
   `tools/island/verify-scene-jump.mjs` checks it.
2. Report the effect to `settled` until it has converged on a still scene, or freeze it or turn it
   off in the test mode. It reports through `settleFrame`'s `pending` list in
   `packages/render/RenderStages.ts`, through `FrameHost.pending` for the app's own effects, or
   through the signature of the still-scene temporal accumulation.
3. Freeze it or turn it off under the test mode's one switch, `packages/render/debug/TestMode.ts`.
   The effects handled this way are listed in `docs/reference/test-mode.md`.
4. A growth does not clear rendering history (`tools/island/verify-growth-swap.mjs` captures its
   first view without a scene jump). There, the effect is frozen or off under the switch, or the
   growth swap resets it.
5. Add the effect's module to `reference.watch.motion` in `tools/project.mjs` when its paths are
   not already there. Once frozen or off, the effect no longer shows in the paused set, only in the
   clips.
6. Compare its frames outside the test mode (live, or in clips) within the temporal tolerance
   (`tools/kit/tolerance.py`), unless they are pixel-identical between runs.

`tools/render/verify-extensions.mjs` checks the effect's declaration on the render pipeline's
registry (`testMode` in `packages/render/Extensions.ts`).

## Checks

- Run `npm run check` before every commit, and `npm run lint:docs` when Markdown changed.
- The rule for every visual change is in `AGENTS.md`, Rules for every change: compare against
  captures from before the change, crops included, and report the measured differences in the
  commit body as relative numbers.
