# Parity captures

Paused captures of a fixed set of views, and a per-view diff against a reference set: the check
that a refactor leaves the image as it was (byte for byte, or within the reference's own
repeatability), and 1:1 crops of named subjects for judging a change that is meant to show.

- `views.mjs`: the views (camera, weather, time) and their crop anchors.
- `capture-set.mjs`: captures a set through `tools/capture.mjs`.
- `diff-set.py`: compares two sets.
- `clips.mjs`, `../capture-clip.mjs`, `../clip-metrics.py`: stepped clips (a view set in motion),
  their capture and their metrics against MSAA and a ground truth (see Clips below).

## Serving a build for captures

Capture a production build (`npm run build`, then `npx vite preview --host 127.0.0.1 --port <port>
--strictPort`), each branch from its own worktree on its own port. Two things the captures need:

1. `?debug` in the URL (capture-set.mjs adds it): `window.__PONLAI__` and the diagnostics exist only
   on the dev server or with it.
2. The islanders load from `/artifacts/assets/...`, which only the dev server serves. In a preview
   build the page waits at "Waking the villagers..." and the capture times out. Link the assets into
   the build output after every build (`vite build` empties `dist/`):

   ```sh
   mkdir -p dist/artifacts && ln -s <main checkout>/artifacts/assets dist/artifacts/assets
   ```

Paused captures take the GPU lock shared (`tools/gpu-lock.mjs`): their pixels do not depend on what
else renders, so they run beside other paused captures and probes, and wait for timing runs.

## Views (views.mjs)

All paused at `t=12`, at the tier's own pixel ratio (no `dpr`): on high, 1728x1117 CSS at DPR 2
renders 2592x1675 and FSR 1 brings it to 3456x2234. Placements derive from the island mesh's
bounds, the plant sites, the flower instances, the rim trails, the islander and the sun and moon,
so they follow any tile layout.

`parity` (the default group, 17 views): the profiler's 12 scenes (`tools/profile-frame.mjs`),
frozen, plus 5 more.

| view | query | camera |
|---|---|---|
| island-fair-noon | weather=fair&preset=noon | island orbit view (default) |
| island-clear-golden | weather=clear&preset=golden-hour | island orbit turned to face the sun |
| horizon-fair-noon | weather=fair&preset=noon | horizon view |
| sky-cloudy | weather=cloudy&preset=noon | sky view |
| island-overcast | weather=overcast&preset=noon | island |
| island-rain | weather=rain&preset=noon | island |
| island-storm | weather=storm&preset=noon | island |
| horizon-storm | weather=storm&preset=noon | horizon |
| island-fog-dawn | weather=fog&preset=dawn | island |
| island-night-clear | weather=clear&preset=midnight | island |
| meadow-close | weather=fair&preset=noon | free camera 1.6 m up inside the rim, looking out over the lip |
| weather-change | weather=fair&preset=noon | island; a front to rain frozen half way, environment re-baked |
| water-skim-cliffs | weather=fair&preset=noon | free camera 1.4 m over the sea off the cliffs, along the coast |
| island-from-sea | weather=fair&preset=noon | free camera 150 m out, 14 m up, looking back |
| meadow-shade | weather=fair&hour=15 | beside the first small tree: shrubs and trees in shade |
| sunrise-long-shadows | weather=clear&preset=sunrise | orbit across the sun, long shadows over the meadow |
| night-moon | weather=clear&hour=19.2&moon=0.5 | horizon view facing a full moon about 14 degrees up |

`taa` (7 views): close, thin and moving detail for temporal anti-aliasing.

| view | query | camera |
|---|---|---|
| meadow-24 | weather=fair&preset=noon&dist=24&polar=60&az=300 | orbit at 24 m |
| low-36 | weather=fair&preset=noon&dist=36&polar=80&az=330 | orbit low over the sea at 36 m |
| islander-close | weather=fair&preset=noon | orbit about the islander, 3.2 / 2.4 / 3.6 m off its centre |
| flowers-close | weather=fair&preset=noon | free camera 1.2 m over the densest flower drift, 35 degrees down |
| twigs-sky | weather=fair&preset=noon | beside the first tree's trunk, looking up through its crown |
| rim-sea | weather=fair&preset=noon | 25 m out, 4 m up, facing the densest stretch of rim trails |
| cliff-sea-golden | weather=clear&preset=golden-hour | from the sea, 3 m up, the island against the low sun |

`node tools/parity/views.mjs list [parity|taa|all]`, `query <view>`, `eval <view>`, `crops <view>`.

### Crop anchors

Each view names the subjects worth a 1:1 look. When the page reads `window.__PONLAI_CROPS__` (a
getter the view's eval installs; it changes nothing in the scene) each anchor's world point is
projected into a 384 px box of the captured image, in device pixels, and capture.mjs stores the
result in the capture's JSON as `crops`: `{ name: { x, y, w, h, anchor, world, distance } }`, or
`{ name: { missing } }` when the subject is off screen or hidden behind the island. Visibility is
judged against a height grid of the island mesh; anchors with a choice of points (the meadow, the
lip, the coast, flowers) take the nearest visible one whose box fits the frame and keeps clear of
the boxes placed before it.

| anchor | point |
|---|---|
| meadow-near, meadow-band-40m, meadow-band-70m | meadow ground about 5, 40 and 70 m from the camera (the lawn's blade bands) |
| flowers | the nearest flower bed (2 m cells of the flower instances) |
| rim-lip | the nearest stretch of the lip facing the camera |
| cliff-edge-sea | the cliff's foot at the waterline, facing the camera |
| cliff-edge-sky | the lip seen from below against the sky (from a camera near the top's height, the island's silhouette above the sea horizon) |
| islander-head, islander-hands | the islander's head and wrist bones |
| twigs, tree-crown | the nearest tree's crown edge and centre |
| sea-glints | the sea where it mirrors the sun (the moon at night) toward the camera, or where that glitter path enters the frame |
| horizon-line | the horizon ahead, turned aside until the island does not hide it |
| stars | open night sky in the upper part of the frame |
| stars-horizon | open sky just above the sea horizon, beside the heading and clear of the moon, where the stars scintillate (the night-still clip's crop) |
| moon-limb | the moon's upper limb |
| rain-streaks | the rain a few metres ahead, upper left |
| fog-cliff | the cliff face half way up, nearest the camera |

## capture-set.mjs

```sh
node tools/parity/capture-set.mjs <baseUrl> <outDir> [--views parity|taa|all|a,b,c] [--repeat]
    [--quality high] [--aa mode] [--q "extra&query"] [--jobs 1] [--retries 1] [--size 1728x1117@2]
    [--runs runs.csv] [--task name] [--procedure name] [--sha sha] [-- capture.mjs options]
```

- Each view loads `?debug&paused&t=12&quality=<tier>[&aa=<mode>][&<extra>]&<view query>` and is
  written as `<view>.png`, `<view>.json` (diagnostics, crop anchors) and `<view>.log`.
- `--repeat`: each view twice from fresh page loads (`<view>.repeat.png`), then a byte comparison
  per view; exit 1 if any differ (or any capture failed). The repeats run after all the first
  captures, so a view's two loads never run side by side. Take an A/A floor with `--jobs 1`:
  concurrent pages may change which views repeat.
- `--aa` adds `aa=<mode>` only when given. `--q` adds options to every view (e.g. `msaa=1`).
- `--jobs n` runs n captures at once (2 is fine; each takes about 20-30 s).
- `--runs` (or `PARITY_RUNS`) appends a line per run to a CSV: date, task, procedure, sha, wall
  minutes, whether the GPU was busy before the run, captures, failures and the set. Without either
  nothing is logged: a procedure that keeps a run log passes one of them on every run.
- After `--`, options for capture.mjs: `--wait-for "expr"` (polled up to 60 s after the settling
  wait), `--frames n --every k` (n captures k rendered frames apart: `<view>.png`,
  `<view>.f1.png` ...).

## diff-set.py

```sh
uv run --with numpy --with pillow tools/parity/diff-set.py <refDir> <testDir> [--views a,b]
    [--max-px1 200] [--crops 3] [--crop 256] [--out dir] [--aa-floor | --temporal [--flip]]
    [--md table.md] [--crops-from ref|test|<dir>|<file.json>]
```

- Per view: byte-identical or not, max and mean absolute difference, pixels over 1, 2, 8 and 32
  levels. Pass: fewer than `--max-px1` pixels over 1 level and none over 2 (`--max-px1 0` demands
  byte identity). Exit 1 on any failure or missing view.
- Differing views get `<out>/<view>.diff.png` (difference x8) and the worst windows as
  `ref | test | diff x8` sheets; `<out>/report.json` holds everything (default `<testDir>/diff`).
- `--aa-floor`: both sets captured with `--repeat`. A view passes when it is byte-identical across
  the sets, or when the reference does not repeat and the cross difference stays within the larger
  of the two sides' A/A differences. The test side need not be non-repeatable too: a stable test
  frame inside the reference's spread passes (the note says so). A view that repeats on the
  reference must repeat on the test side and match it byte for byte. Diffing a set against itself
  lists its A/A floor; `--md` writes the table.
- `--temporal`: the rule for temporal AA captures (`aa=taa|taau`), whose paused frames are not
  byte-repeatable (see Temporal tolerance below). MSAA sets keep the byte rules above.
- Each capture's JSON records the browser build (`browser`); diff-set warns when the two sets come
  from different builds, since their frames never match byte for byte. Compare only sets captured
  with the same browser (Playwright's Chromium, or one `CHROME_PATH`).
- `--crops-from`: per anchor, the difference counts and a `ref | test | diff x8` sheet
  (`<out>/<view>.<anchor>.png`), and per view `<view>.anchors.png`, the test frame at a quarter size
  with its anchor boxes.

## Temporal tolerance (diff-set.py --temporal, tolerance.py)

MSAA paused frames repeat byte for byte (or within their small A/A floor); temporal ones do not, and
we chose not to make them: the GPU ends a render pass on its own (tile overflow, preemption) at
points that vary from draw to draw, a split pass shades a few samples differently (mostly through
fragment derivatives), and the temporal rest averages 40 such frames and freezes what they held.
Under a busy GPU that reaches a few hundredths of a percent of the pixels, a few levels each (up to
20 on dense vegetation). So temporal sets are compared the way engine screenshot tests compare
frames (Unity's Graphics Test Framework, Unreal's screenshot tolerances):

- a pixel is off when its largest channel difference exceeds a level; the share of off pixels is
  bounded on the frame, in every 32 px window (stride 16: any square of 48 px lies whole in one)
  and on every named crop, and the frame's mean difference is bounded (global and local error);
- in every window, few pixels may differ by a lot (a missing or recoloured small object);
- the mean signed difference of each channel is bounded in every window and crop, so a coherent
  shift that stays under the level everywhere (a 1-level change over a region) still fails;
- one recapture before a failure counts: a view passes when any pairing of the two sides'
  captures (`<view>.png`, `<view>.repeat.png`) passes, and a failing view whose test side has no
  recapture is marked unconfirmed. Capture temporal sets with `--repeat`.

`use` in the table is the largest measurement / threshold ratio (pass: at most 1). The thresholds
sit in one table, `TEMPORAL` in `tolerance.py`, with their calibration: they pass every A/A pair
of the M7 build's taa, taau and msaa captures, quiet and with the GPU shared (the worst used under
half the tolerance), and fail every synthetic regression cut into those frames (a 1-level change
over a 48 px square, a recoloured flower patch, a quarter-pixel shift of a crop, a missing 6 px
flower or the islander's head), each by 3.9 times the tolerance or more. `--flip` adds the mean
NVIDIA FLIP of each frame (`--with flip-evaluator`), reported only: a frame's mean hides a missing
flower entirely. Crops come from `--crops-from`, else from the test side's JSON.

## Reference sets

Keep references per merge-base, captured from a detached worktree of that commit:
`<root>/<sha>/S1` (the 17 views with `--repeat`), `S2` (`--quality medium|low` on six views),
`S3` (single-sampled, `dpr=1`, the vegetation prepass off and the `post=` switches), with
`aa-floor.md` listing each view's repeatability. A few views do not repeat byte for byte between
two page loads (1-3 levels on a few pixels of vegetation, rarely more), and which views they are
changes from run to run: compare with `--aa-floor` on sets captured with `--repeat`, and treat a
byte-identical result on a view as luck, not a property of the view, unless it holds across runs.

## Clips (clips.mjs, capture-clip.mjs, clip-metrics.py)

A clip is a view set in motion: its base view, a paused or running scene clock, a frame count, a
camera path that is a function of the frame index applied to the view's own pose (a pan, a flick, a
dolly, an orbit about the islander), and where needed a render scale schedule (`drs-steps`, in
shares of the tier's nominal ratio: 0.8, 0.6, 0.8, which is 1.2, 0.9, 1.2 on high at 2x), extra
URL options (`sun-shadow`: `dayLength=600`) or a per-frame hook (`lightning`: a strike forced at
frame 30). `node tools/parity/clips.mjs list | show <clip>`.

```sh
node tools/capture-clip.mjs <name> --url <preview> --clip <clip> [--aa msaa|off|taa|taau|gt|gt-hi]
    [--view v] [--frames n] [--every k] [--crops a,b] [--full 0,30] [--q "extra"] [--gt-jitters n]
    [--anchors-from clip.json] [--out dir] [--runs runs.csv]
uv run --with numpy --with pillow [--with flip-evaluator] tools/clip-metrics.py \
    --test DIR --msaa DIR --gt DIR [--thresholds t.json] [--baseline metrics.json]
```

- The page is stepped by `__PONLAI__.loop.step` (src/main.ts, debug builds only): the live loop
  stops and the tick runs `frames` times with a fixed dt, nothing from the wall clock, the frame
  pacer and the dynamic scale bypassed and the render scale given per frame. The clouds' trace phase
  and the sky's and refracted sun's wall-clock cadences restart with each call, so a clip does not
  depend on how long the page ran before it; every periodic sky bake reads its irradiance back (it
  sets a lightning strike's fill) and the next frame waits for it, so a clip does not depend on how
  long its frames took either. Clips take the GPU lock shared.
- Film grain is set to 0 on every side (it is re-seeded each frame and would add noise to the
  temporal metrics); `clip.json` records it.
- Crops: the view's anchors, or the clip's own (`night-still`: the horizon's stars, no crop of the
  view's rest image), or `--crops`, are read once at the base pose, and each frame projects
  their world points into a 192 CSS px box (384 device px at 2x). `--full` frames are captured whole.
  Output: `<crop>/<i>.png`, `full/<i>.png`, `clip.json` (boxes, the camera and render size per frame,
  diagnostics, pipelines created while stepping).
- `--aa gt`: the temporal modes' ground truth (`aa=gt`, debug builds): the temporal graph at the
  canvas's resolution, each captured frame held still after its tick (`loop.step`'s `converge`)
  until the temporal rest has averaged `--gt-jitters` jittered renders of it with a box filter
  (32 by default, 64 for a one-frame clip such as `rest`), unsharpened and without grain, cropped
  at the test's own size. The scale schedule is ignored. Keep its sets per merge-base under
  `<parity root>/<sha>/gt/`. Paused temporal captures (capture.mjs, capture-set.mjs) wait for the
  rest to converge (`diag.taa.converged`).
- `--aa gt-hi`: the interim ground truth, MSAA on high at twice high's nominal ratio for the size
  (3x at the default @2, where the nominal is 1.5) in a canvas that holds it, box-downsampled 2x2
  (288 px crops at the default size). It renders every frame at that ratio: a clip's scale schedule
  applies to the test and MSAA sides only. Its pixel-width vegetation rules are in render pixels,
  so its meadow is finer than any real render: judge vegetation look against MSAA.
- `clip-metrics.py`: per crop, the test's and MSAA's metrics against the GT (definitions in its
  docstring), their ratio, and PASS / FAIL against a thresholds file of gates on a baseline (MSAA
  measured here, or an earlier metrics.json): ratios with an absolute floor for magnitudes (a
  paused clip's MSAA flicker is exactly 0), differences for the signed fringe and the lag. Whole
  frames (`full/`) are measured only when `--crops` names them.
- Repeatability: pan-slow on meadow-close repeats byte for byte between fresh loads. Vegetation
  crops elsewhere can differ in single frames: with the vegetation depth prepass on, a few samples
  pass its equal depth test differently from frame to frame (blobs of a few to 150 px on leaves
  and blades; none with `vegPrepass=0`).

