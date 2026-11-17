# Binding: measuring performance changes

This project's facts for the skill
[`measuring-performance-changes`](../../skills/measuring-performance-changes/SKILL.md). Each
section is named after the step of the skill that reads it. For a project of your own, copy the
section names and fill in your own facts.

The profiler is `tools/render/profile-frame.mjs`. Its header is its manual: usage, options, output
and exit codes. `node tools/render/profile-frame.mjs --help --full` prints the manual without
rendering. `docs/reference/profile-frame.md` describes its scenes and modes and what each result
means. Read them there; never start the tool to see its options. Every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`).

## Performance target

- Every change is judged at the high quality tier at 4K output. The numbers and the budget are in
  `packages/render/Quality.ts`'s header and in `AGENTS.md`, Rules for every change. The kept
  weathers are clear and fair; the scenes of the parked weathers run only when you name them.
- To see the profiler's scenes, run `node tools/render/profile-frame.mjs --list`. It prints them and
  renders nothing. The default set of scenes is the standard set; `--scenes` names others.
- Judge whether 60 fps holds with `--accept` (under vsync), never from uncapped frame intervals.
  Judge it at the tier's own settings, with its dynamic render scale measured where it settles
  (`--scale-settle 5`).

## Build and lock

- Serve production builds: `node tools/kit/serve.mjs preview` for the change, and
  `node tools/kit/serve.mjs preview --sha <rev>` for the commit it starts from. Each command builds
  first and prints its URL. Stop each with `job.mjs stop <log>`.
- The profiler takes the GPU lock exclusively for what it measures. It first checks that nothing
  else keeps the GPU busy. If something does, it measures nothing and exits with code 3.
  `--contended` measures anyway and marks the results as contended; `<out>/load.jsonl` and the
  summary mark the contended slices. Before a run, check `node tools/kit/gpu-lock.mjs gpu`
  yourself.
- By default, the profiler pins the high tier's render scale at the dynamic-resolution rule's
  baseline for the viewport. `--unpinned`, `--accept`, `--display` and `--scales` do not pin it.
- The profiler runs headless by default. Use `--display` (a real, headed window) only to measure
  frame pacing on a real display, and only while `node tools/kit/display-gate.mjs status` allows
  it. If you measure a change on the display, check it in a normal window too (`--window WxH`),
  not only full screen (`--kiosk`).
- Timestamps: `--timestamps on` for the split by pass, `off` for frame rates, `both` for both.

## Profiler

- A/A and A/B of two builds: `--compare <urlA> <urlB>`. It runs two pages of one browser in
  alternating slices, with each page in front while it runs, and reports deltas with a 95 %
  confidence interval. For an A/A, pass the same URL twice.
- A/B inside one page: keep both code paths behind a flag of `packages/render/debug/DebugFlags.ts`
  and run `--toggle "s.flags.<name> = on"`. It alternates blocks of frames after both states are
  warmed up. The header of `DebugFlags.ts` explains how to name the flag once the change ships.
- A/B of a quality setting inside one build: use the load-time override `tier.<setting>=<value>`
  (`docs/reference/url-options.md`). The two sides are then two URLs of one production build, for
  example `--compare "<url>?tier.water.ssrIterations=48" "<url>?tier.water.ssrIterations=32"`. For
  an A/A, pass the default value on both sides.
- To switch a part off to measure its cost (step 4) or an upper bound (step 5), use `--toggle`
  with an expression on the page's debug handle, for example
  `--toggle "s.water.mesh.visible = !on"`. Use `--eval` to apply it to a whole profile run.
- Fixed and per-pixel cost: `--scales 1,0.75` runs once per render scale.
- Each run writes `<out>/summary.md` and `profile.json` (by default in `artifacts/perf/<label>/`),
  with GPU times per pass. `--detail` adds each pass's own time.

```sh
node tools/kit/job.mjs start --wait -- \
  node tools/render/profile-frame.mjs --compare <urlA> <urlB> --scenes <id> --label <name>
```

## Rendered output

- Check that the rendered output is unchanged. For the island's still frames, use
  `tools/kit/parity/capture-set.mjs` (`--check` against the starting commit's references). For the
  render pipeline's own passes, use the test scenes with `tools/render/scenes.mjs --verify --check`
  ([verifying-rendering-changes](verifying-rendering-changes.md), Compare).
- The test scenes are small. The `sea` scene's reflected objects stand within a few tens of
  metres, so a change to the water's reflection range shows only in the island's views over the
  sea (`tools/island/parity/views.mjs` names them). To capture each value of a setting, pass the
  same override: `--q "tier.<setting>=..."` for `scenes.mjs`, or `--sweep` for `capture-set.mjs`.
- To score a sweep of a setting with a perceptual metric, capture clips of each value with
  `tools/kit/parity/capture-clip.mjs`, and score them against the default with
  `uv run --with flip-evaluator tools/kit/clip-metrics.py`. For one pair of still images, use
  `uv run tools/kit/img.py diff`.

## Record

- Results go in the commit body as relative numbers (`AGENTS.md`, Rules for every change: a
  performance change is measured before and after, and contended runs are reported as such).
- A new quality setting that governs a cost is a field of the quality table
  (`packages/render/Quality.ts`). Its comment gives its value and the sweep that chose it.
