# Binding: measuring performance changes

This project's facts for the skill
[`measuring-performance-changes`](../../skills/measuring-performance-changes/SKILL.md). Each
section is named after the step of the skill that reads it. A project of your own copies the
section names and fills in its own facts.

The profiler is `tools/render/profile-frame.mjs`; its header is its manual (usage, options,
output, exit codes; `node tools/render/profile-frame.mjs --help --full` prints it without
rendering), and `docs/reference/profile-frame.md` holds its scenes, its modes and what each
reading means. Read them there, never by starting the tool to see. Every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`).

## Standard

- High at 4K output is the standard every change is judged at: its numbers and budget are in
  `packages/render/Quality.ts`'s header and `AGENTS.md`, Rules for every change. The kept weathers
  are clear and fair; the parked weathers' scenes run only when named.
- The profiler's scene matrix: `node tools/render/profile-frame.mjs --list` (prints, renders
  nothing). The default matrix is the standard set; `--scenes` names others.
- 60 fps held is judged with `--accept` (under vsync), never from uncapped intervals, at the tier's
  own settings: its dynamic scale measured where it settles (`--scale-settle 5`).

## Build and lock

- Serve production builds: `node tools/kit/serve.mjs preview` for the change and
  `node tools/kit/serve.mjs preview --sha <rev>` for the commit it starts from (each builds first
  and prints its URL; stop each with `job.mjs stop <log>`).
- The profiler takes the GPU lock exclusively for what it measures and checks first that nothing
  else keeps the GPU busy; when something does it measures nothing and exits 3. `--contended`
  measures anyway and marks the results; `<out>/load.jsonl` and the summary mark contended slices.
  Check `node tools/kit/gpu-lock.mjs gpu` yourself before a run.
- It pins high's render scale at the dynamic rule's baseline for the viewport by default;
  `--unpinned`, `--accept`, `--display` and `--scales` do not pin.
- Headless by default. `--display` (a real, headed window) only for pacing on a real display, and
  only while `node tools/kit/display-gate.mjs status` allows it. A change measured on the display
  is checked in a normal window too (`--window WxH`), not only full screen (`--kiosk`).
- Timestamps: `--timestamps on` (the split by pass), `off` (frame rates), `both`.

## Profiler

- A/A and A/B of two builds: `--compare <urlA> <urlB>` (two pages of one browser, alternating
  slices, each in front while it runs; deltas with a 95 % interval). An A/A passes the same URL
  twice.
- A/B inside one page: keep both paths behind a flag of `packages/render/debug/DebugFlags.ts` and
  run `--toggle "s.flags.<name> = on"` (alternating blocks after both are warmed). Its header
  explains the flag's naming once the change ships.
- A/B of a quality knob inside one build: the load-time override `tier.<knob>=<value>`
  (`docs/reference/url-options.md`), so the two sides are two URLs of one production build, for
  example `--compare "<url>?tier.water.ssrSteps=20" "<url>?tier.water.ssrSteps=16"`; an A/A
  passes the default value on both sides.
- Switching a part off for its cost (step 4) or an upper bound (step 5): `--toggle` with an
  expression on the page's handle, for example `--toggle "s.water.mesh.visible = !on"`, or
  `--eval` for a whole profile run.
- Fixed and per-pixel cost: `--scales 1,0.75` (one run per render scale).
- Each run writes `<out>/summary.md` and `profile.json` (default `artifacts/perf/<label>/`), with
  per-pass GPU times (`--detail` for each pass's own time).

```sh
node tools/kit/job.mjs start --wait -- \
  node tools/render/profile-frame.mjs --compare <urlA> <urlB> --scenes <id> --label <name>
```

## Image

- The image stays the same: the island's still frames with `tools/kit/parity/capture-set.mjs`
  (`--check` against the starting commit's references) and, for the render pipeline's own passes,
  the test scenes with `tools/render/scenes.mjs --verify --check`
  ([verifying-rendering-changes](verifying-rendering-changes.md), Compare).
- The test scenes are small: the `sea` scene's reflectors stand within a few tens of metres, so a
  change to the water's reflection range shows only in the island's views over the sea
  (`tools/island/parity/views.mjs` names them). The same knob's override (`--q "tier.<knob>=..."`
  for `scenes.mjs`, `--sweep` for `capture-set.mjs`) gives the shots of each value.
- A knob sweep scored by a perceptual metric: clips of each value with
  `tools/kit/parity/capture-clip.mjs`, scored with `uv run --with flip-evaluator
  tools/kit/clip-metrics.py` against the default; one still pair with `uv run tools/kit/img.py diff`.

## Record

- Results go in the commit body as relative numbers (`AGENTS.md`, Rules for every change: a
  performance change is measured before and after, contended runs reported as such).
- A new cost knob is a field of the quality table (`packages/render/Quality.ts`), its value and the
  sweep that chose it in its comment.
