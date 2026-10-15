# Parity captures

Paused captures of a fixed set of views, and a per-view diff against a reference set: the check
that a refactor leaves the image as it was (pixel for pixel, or within the reference's own
repeatability), and 1:1 crops of named subjects for judging a change that is meant to show.

- `views.mjs`: the views (camera, weather, time) and their crop anchors.
- `capture-set.mjs`: captures a set through `tools/capture.mjs`.
- `adhoc.mjs`: ad-hoc views for capture-set (command line, JSON file, sweeps).
- `diff-set.py`: compares two sets; its pixel helpers (`pixels.py`) are shared with
  `../img.py` (ad-hoc diffs, crops, sheets and statistics of any captures).
- `../verify-scene-jump.mjs`: the views reached by scene jumps in one page, against fresh loads
  (see One page, many views below).
- `clips.mjs`, `../capture-clip.mjs`, `../clip-metrics.py`: stepped clips (a view set in motion),
  their capture and their metrics against MSAA and a ground truth (see Clips below).
- `gates.py`: a baseline.mjs label's gate verdicts per gate id, a task's decisions applied from a
  policy file (its header has the format; `docs/tools.md`, Captures).
- `table.py`: several labels' metrics.json (baseline.mjs or clip-metrics) side by side, crop x
  metric, with each column's ratio to a base column (MSAA by default).

## Serving a build for captures

Capture a production build (`npm run build`, then `npx vite preview --host 127.0.0.1 --port <port>
--strictPort`), each branch from its own worktree on its own port. The URL needs `?debug`
(capture-set.mjs adds it): `window.__PONLAI__` and the diagnostics exist only on the dev server or
with it. The islanders' models (`/artifacts/assets/...`, git-ignored) need no setup: the build
links them into `dist/`, from the main checkout in a worktree (`tools/vite-assets.mjs`).

Paused captures take the GPU lock shared (`tools/gpu-lock.mjs`): their pixels do not depend on what
else renders, so they run beside other paused captures and probes, and wait for timing runs. Each
page holds one of the lock's shared slots (default 3, queued first in, first out) while it
captures, so `--jobs` above the free slots only queues.

## Fast mode (tools/capture-browser.mjs)

capture.mjs and capture-clip.mjs share the browser and the wait before the shot:

- Profile slots: each capture runs in a persistent profile, `artifacts/.capture-profiles/<browser
  build>/<n>` of the main checkout, taking the lowest free slot (a `<n>.lock` directory naming its
  pid; stale once that process is gone), so `--jobs 4` uses slots 0-3. A capture that names its
  page takes the slots that page (its origin and build) ran in last first, from `affinity.json`
  beside the slots, so another job holding a warm slot no longer moves it to a cold one for good
  (`tools/capture-browser.mjs`). The world cache
  (IndexedDB, keyed on the generator's sources and the browser; one entry per preview port) and
  the GPU shader cache then hit from the second load: the island is not generated again (3 s
  alone, about a minute under a busy CPU). A hit is byte-identical to a miss. localStorage and
  sessionStorage are cleared before every page. The browser build is in the path (Playwright's
  `chromium-<revision>`, or a `CHROME_PATH` browser's `--version`); `PONLAI_CAPTURE_PROFILES`
  moves the root. The slots are independent of the GPU lock.
- Readiness by stability (MSAA and off): after the view's eval and the loading screen gone (its
  computed opacity 0, the fade-out finished, not only its `done` class; plus
  `--stable-min` rendered frames, 1 by default), the image is grabbed every 2 frames
  (`--stable-every`; the loop stopped and the GPU queue drained for each grab) and the view is shot
  once 1 comparison (`--stable-repeats`) found no pixel changed. A paused page still flickers
  on some views (single frames that leave the settled image and come back to it); since that noise
  never repeats, two equal grabs are the settled image. After 40 frames (`--stable-patience`) a comparison with at most
  5000 pixels changed (`--stable-tolerance 0:5000`, `<level>:<pixels>`: pixels differing by more
  than level; `exact` turns it off) counts too; after 120 frames (`--stable-cap`) the view is shot
  anyway and marked `capped`. Each capture's JSON records it as `ready` (status `exact`,
  `tolerance` or `capped`, frames waited, comparisons, the largest difference seen, per comparison
  its pixel counts; `--stable-trace` adds each grab's hash). On the 24 views (two sets with
  `--repeat`, `--jobs 2`) every load was shot exact, 4-32 frames after the floor (median 4), on the
  frame most loads of the earlier tools agreed on: no A/A difference, where their fixed waits left
  15-17 % of loads off that frame (those runs used a floor of 10 and 2 comparisons; replayed over
  per-frame traces of the 24 views, a floor of 1 frame and 1 comparison shot no load early and all 48 on
  the settled frame, at fewer frames). The grab is a CDP screenshot (PNG optimised for speed) at
  the page's ratio, about 0.27 s at 3456x2234, its pixels those of the shot.
  `--ready-frames n` brings the fixed count back (a running capture uses 60); `--wait ms` and
  `--settle ms` add fixed delays before and after the floor.
- Temporal pages (taa, taau, gt) are not compared: the rest is restarted after the eval, the tool
  waits for `diag.taa.converged` (8 settle frames and the 32-jitter sequence, about 40 frames; no
  rest while a bake or transition runs), stops the loop on the held rest and shoots it
  (`ready.status` `converged`, `ready.framesWaited`); the `--stable-*` options do not apply.
  Comparing grabs restarted the rest at each loop start and only sampled the frame noise again.
  The rest is restarted only once the loading screen's fade has finished: a rest converged during
  the fade was shot with up to 2 % of the screen blended over the frame (0.3-1.9 levels darker
  over millions of pixels, A/A up to 268 under taa).
  Rests do not repeat pixel for pixel: temporal sets are judged with `diff-set.py --temporal`.
- The loop stops before the shot (`__PONLAI__.loop.stop()`: no new frames, the GPU queue drained):
  a headless page queues seconds of frames ahead of the GPU, and a running page's screenshot
  waits for them. The frame shot is the same; the shot takes about 1 s instead of 4-11 s.
- The shot (capture.mjs's frames, capture-clip's crops and full frames) is taken like the grab:
  the compositor's image through CDP at the page's ratio, PNG optimised for speed, instead of
  Playwright's `page.screenshot`. Same pixels, other bytes (Chrome's fast encoder; the files are
  8-57 % larger, median 28 %), and about 1 s less per capture at 3456x2234 (the shot 0.26 s
  instead of 1.3 s, plus 35 ms to give the page its device metrics back). So **every comparison
  decodes**: a capture's bytes depend on the encoder, its pixels do not (capture-set's `--repeat`,
  diff-set.py, `samePixels` in capture-browser.mjs; equal bytes still short-cut to equal).
  References written by the earlier encoder stay comparable.

## Views (views.mjs)

All paused at `t=12`, at the tier's own pixel ratio (no `dpr`): on high, 1728x1117 CSS at DPR 2
renders 2592x1675 and FSR 1 brings it to 3456x2234. Placements derive from the island mesh's
bounds, the meadow's flower heads, the turf skirt, the islander and the sun and moon,
so they follow any tile layout.

`parity` (the default group, 12 views): the profiler's scenes (`tools/profile-frame.mjs`),
frozen, plus 5 more. The parked weathers' 5 views (marked *parked* below) are in the table but in
no group but `special` (see below).

| view | query | camera |
|---|---|---|
| island-fair-noon | weather=fair&preset=noon | island orbit view (default) |
| island-clear-golden | weather=clear&preset=golden-hour | island orbit turned to face the sun |
| horizon-fair-noon | weather=fair&preset=noon | horizon view |
| sky-cloudy | weather=cloudy&preset=noon | sky view |
| island-overcast | weather=overcast&preset=noon | island |
| island-rain (*parked*) | weather=rain&preset=noon | island |
| island-storm (*parked*) | weather=storm&preset=noon | island |
| horizon-storm (*parked*) | weather=storm&preset=noon | horizon |
| island-fog-dawn (*parked*) | weather=fog&preset=dawn | island |
| island-night-clear | weather=clear&preset=midnight | island |
| meadow-close | weather=fair&preset=noon | free camera 1.6 m up inside the rim, looking out over the lip |
| weather-change (*parked*) | weather=fair&preset=noon | island; a front to rain frozen half way, environment re-baked |
| water-skim-cliffs | weather=fair&preset=noon | free camera 1.4 m over the sea off the cliffs, along the coast |
| island-from-sea | weather=fair&preset=noon | free camera 150 m out, 14 m up, looking back |
| sunrise-long-shadows | weather=clear&preset=sunrise | orbit across the sun, long shadows over the meadow |
| night-moon | weather=clear&hour=19.2&moon=0.5 | horizon view facing a full moon about 14 degrees up |

`taa` (6 views): close, thin and moving detail for temporal anti-aliasing.

| view | query | camera |
|---|---|---|
| meadow-24 | weather=fair&preset=noon&dist=24&polar=60&az=300 | orbit at 24 m |
| low-36 | weather=fair&preset=noon&dist=36&polar=80&az=330 | orbit low over the sea at 36 m |
| islander-close | weather=fair&preset=noon | orbit about the islander, 3.2 / 2.4 / 3.6 m off its centre |
| flowers-close | weather=fair&preset=noon | free camera 1.2 m over the densest flowers, 35 degrees down |
| rim-sea | weather=fair&preset=noon | 25 m out, 4 m up, facing the densest stretch of the turf skirt |
| cliff-sea-golden | weather=clear&preset=golden-hour | from the sea, 3 m up, the island against the low sun |

`special` (island-rain, island-storm, horizon-storm, island-fog-dawn, weather-change: the views
marked `special: true`) holds the parked weathers (`src/sky/Weather.ts` `PARKED_WEATHER`: rain,
storm, fog). No other group lists them, so every default set (`parity`, `all`, verify-scene-jump's,
baseline.mjs's plan without `--views` / `--clips`) is the normal weathers' alone; `normal` is `all`
(19 views), kept as a name. A parked view is reached by name or by `special` (`all,special` is
every view), and so is a clip (clips.mjs: a clip is in its view's group; the parked ones are
storm, rain, lightning, fog). Every tool that takes `--views` takes names and groups mixed
(`normal,flowers-close`).

`node tools/parity/views.mjs list [parity|taa|all|normal|special]`, `query <view>`, `eval <view>`, `crops <view>`.

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
| flowers | the nearest 2 m cell of the meadow with a few flower heads (the flowering tufts' anchors) |
| rim-lip | the nearest stretch of the lip facing the camera |
| cliff-edge-sea | the cliff's foot at the waterline, facing the camera |
| cliff-edge-sky | the lip seen from below against the sky (from a camera near the top's height, the island's silhouette above the sea horizon) |
| islander-head, islander-hands | the islander's head and wrist bones |
| sea-glints | the sea where it mirrors the sun (the moon at night) toward the camera, or where that glitter path enters the frame |
| horizon-line | the horizon ahead, turned aside until the island does not hide it |
| stars | open night sky in the upper part of the frame |
| stars-horizon | open sky just above the sea horizon, beside the heading and clear of the moon, where the stars scintillate (the night-still clip's crop) |
| moon-limb | the moon's upper limb |
| rain-streaks | the rain a few metres ahead, upper left |
| fog-cliff | the cliff face half way up, nearest the camera |

## capture-set.mjs

```sh
node tools/parity/capture-set.mjs <baseUrl> <outDir> [--views parity|taa|all|normal|special|a,b,c] [--repeat]
    [--view "name:query[::js]"]... [--views-file f.json] [--sweep "key=a,b,c"]...
    [--quality high] [--aa mode] [--q "extra&query"] [--jobs n] [--retries 1] [--size 1728x1117@2]
    [--runs runs.csv] [--task name] [--procedure name] [--sha sha] [-- capture.mjs options]
node tools/parity/capture-set.mjs <refUrl> --reference <root>/<sha>/<set> [same options]
node tools/parity/capture-set.mjs <testUrl> <testDir> --check <root>/<sha>/<set> [--ref-url <refUrl>]
    [--diff "diff-set.py options"] [--recapture-reference] [same options]
```

- `--reference` and `--check` use the reference store (Reference store below): a check captures
  the test side only and diffs it against the stored reference of the base commit, which it
  reuses, waits for, or (with `--ref-url`) captures.

- Each view is the frame of `?debug&paused&t=12&quality=<tier>[&aa=<mode>][&<extra>]&<view query>`
  and is written as `<view>.png`, `<view>.json` (diagnostics, crop anchors) and `<view>.log`.
- One page per set: each worker (`capture.mjs --worker`) loads the first view it is given and
  reaches every later one in place by the exact scene jump, `__PONLAI__.establishScene( <the view's
  full query> )`, a frame at the jump's camera, then the view's eval, readiness and shot as after a
  load. Its contract (`src/main.ts`): the frame equals a fresh load's, byte for byte wherever the
  fresh load repeats. Only load-time options (quality, aa, size and dpr, the debug switches) need a
  new page, and a set shares them. Each view's JSON has `page`: its visit on the page, `load` or
  `jump`, the view before, the GPU lock wait and the capture's own time (ms), the page's memory then
  (JS heap, DOM nodes, listeners, renderer.info's geometries and textures).
- Capability: a page marks the jump with `__PONLAI__.sceneJump` (the contract's version, 1).
  Builds without it (older commits, whose `establishScene` takes only an options form) get a page
  per view, as before; the set says so once. `--page-per-view` forces that on any build.
- A failed view (a timeout, a page or console error, a crash) ends its page; it is retried
  (`--retries`, default 1) and the views still to come go on in a fresh page, whose first view is a
  fresh load. A page silent for three times `--timeout` plus two minutes, counted from the moment
  its view holds the GPU slot (the wait for the lock is not silence), is killed and treated the
  same way. So one crash or a stuck page does not lose the set.
- `--repeat`: each view twice (`<view>.repeat.png`), then a pixel comparison per view (decoded);
  exit 1 if any differ (or any capture failed). The repeats run after all the first captures, on
  other pages than the first captures and in reverse order: a view's repeat is reached from another
  scene than its first capture, and the view one pass loaded fresh is jumped to in the other, so
  the A/A also shows anything a jump leaves behind. The frames do not depend on the job count (24
  views at `--jobs 1` and `4` decoded to the same pixels); a view that differs only by sparse
  single-frame speckle on the vegetation while other browsers render is GPU noise: shoot it again.
- `--aa` adds `aa=<mode>` only when given. `--q` adds options to every view (e.g. `msaa=1`).
- Ad-hoc views (`adhoc.mjs`) go through the same path, instead of a script looping capture.mjs:
  - `--view "name:query[::js]"` (repeatable): the view's query and optional eval (`s` is
    `window.__PONLAI__`; views.mjs's helpers `isl()`, `free()`, `orbitAround()` exist).
    `like=<view>` in the query starts from a views.mjs view: its query, eval and crops, the
    ad-hoc options winning.
  - `--views-file f.json`: `[ { "name", "q", "eval"?, "crops"?, "like"? } ]` or `{ "<name>": { ... } }`.
  - `--sweep "key=a,b,c"` (repeatable): each selected view once per value, every combination of
    several sweeps, named `<view>--<key>-<value>` (`<key>-<value>` with no views given).
    `--views island-fair-noon,meadow-close --sweep weather=fair,rain --sweep hour=7,12,17` makes 12.
  - With `--views` too, both sets; with only ad-hoc views or sweeps, not the parity group.
  - An ad-hoc view's own options win over the set's (`t=12`, the tier, aa, `--q`); views.mjs views
    keep the set's first, unchanged. Views whose load-time options differ (anything outside
    `SCENE_OPTIONS` in `src/main.ts`: tier, aa, `game`, `seed`, debug switches) cannot share a page:
    they are captured in groups, a group's pages after the last group's.
  - Names: letters, digits, `-`, `_`, none of views.mjs's. `<outDir>/views.json` records the ad-hoc
    views (their query, eval, crops and full query). In the reference store each ad-hoc view's
    coverage holds its definition's hash (`def`): a stored view of that name with another
    definition is captured again and replaces the entry, never served for it.
- `--jobs n` runs n pages at once, each in its own profile slot, the views handed out one at a time
  from one queue (captures are GPU-bound: 3 at once gives the most captures per minute, more only
  adds latency, and each extra page costs a load that a small set does not earn back). Default: one
  page per 5 captures, at most 3, repeats counted (24 views take 3, 7 views 2, up to 5 one). Each
  page leases a GPU lock slot: it keeps it from view to view and gives it up between views when
  someone waits for it and it has held it for 20 s (capture.mjs `--lease` after `--`; 0 frees it
  after every view), so a set behind a series of timing runs advances several views per run, and a
  timing run waits at most about the lease (and the view in flight) for it.
- `--runs` (or `PARITY_RUNS`) appends a line per run to a CSV: date, task, procedure, sha, wall
  minutes, whether the GPU was busy before the run, captures, failures and the set. Without either
  nothing is logged: a procedure that keeps a run log passes one of them on every run.
- After `--`, options for capture.mjs: `--wait-for "expr"` (polled up to 60 s once the page is
  ready), `--frames n --every k` (n captures k rendered frames apart: `<view>.png`,
  `<view>.f1.png` ...; the loop runs between them and stops for each shot), the `--stable-*`
  options, `--ready-frames n`, `--wait ms`, `--settle ms` (fast mode above), `--lease s` (the GPU
  slot's lease, above; it changes no pixel, but like every option after `--` it is part of a stored
  reference's key).

### Quick mode (--quick, quick.mjs)

For tuning, not a gate (the gates still run full sets): knob variants on a few views and crops,
each measured against the stored references of a commit.

```sh
node tools/parity/capture-set.mjs <url> <outDir> --quick --views a,b [--crops x,y] [--full]
    [--view "name:query[::js]"]... [--views-file f.json] [--sweep "key=a,b,c"]...
    [--variant "[label::]js"]... [--quality high] [--aa mode] [--q "extra"] [--size 1728x1117@2]
    [--store <root>/<sha>] [--ref-url <refUrl>] [--runs runs.csv] [--task name]
```

- One page per view (loaded as capture-set loads it, film grain 0 as in capture-clip). The base is
  shot once ready, then each `--variant` in order on the same page: its js runs (`s` is
  `window.__PONLAI__`), the loop starts again, the temporal rest restarts (an epoch bump), the
  page is ready again as capture.mjs makes it (stability for MSAA, the converged rest for taa,
  taau and gt), shot. No repeat.
- Ad-hoc views (`--view`, `--views-file`, `--sweep`, as in capture-set) load with the query
  capture-set gives them; the store keeps rest entries of views.mjs's views only, so they are shot
  without metrics.
- Variants accumulate on the one page: each sets every knob it tunes to an absolute value
  (`sigma04::s.taa.settings.sigmaRest = 0.4`, then `sharp::s.taa.settings.sigmaRest = 0.3; ...`).
  Only runtime knobs work (`s.taa.settings.*`, uniforms, `s.applyQuality( { ... } )`); load-time
  ones (tier, aa, size, the S3 switches) need another run with `--q`.
- Crops are shot through the screenshot's clip (only their pixels are encoded), 192 CSS px about
  the anchor as capture-clip cuts them, from the anchors of the store's MSAA rest entry, so they
  match the references' boxes. `--full` adds the whole frame as a set's `<view>.png`.
- `--store <root>/<sha>`: the MSAA rest entries (`baseline/<tier>/rest/<view>`) and the ground
  truth's (`gt/<tier>/rest/<view>`) through baseline.mjs `--capture-only --only rest --gt`: reused,
  waited for, captured from `--ref-url` when missing, or reported (that view is shot without
  metrics). Each variant's view folder is a capture-clip folder of the clip `rest`, measured by
  clip-metrics.py against them.
- Output: `<outDir>/<variant>/<view>/<crop>/0.png` and `clip.json`, `metrics/`; with `--full`
  `<outDir>/<variant>/<view>.png`; `quick.md` (per variant and crop: FLIP against the GT, its change
  from the base, MSAA's FLIP, S, B, dMSAA) and `quick.json` (readiness, timings, metrics).
- Proof: variants live in one page equal fresh loads
  with the knob in the URL: MSAA byte-identical (`diff-set --aa-floor`), taau within `--temporal`
  (at most 3 levels on a few pixels, as its own A/A). A variant costs its readiness and its crops,
  about 1-3 s, against about 12 s for a fresh load (3 views, base and 2 variants: 43 s against
  108 s under MSAA, 68 s against 114 s under taau, references reused and metrics included).

## diff-set.py

```sh
uv run --with numpy --with pillow tools/parity/diff-set.py <refDir> <testDir> [--views a,b]
    [--max-px1 200] [--crops 3] [--crop 256] [--out dir] [--aa-floor | --temporal [--flip]]
    [--md table.md] [--crops-from ref|test|<dir>|<file.json>] [--jobs 4]
```

- Per view: identical or not (decoded pixels, not file bytes), max and mean absolute difference,
  pixels over 1, 2, 8 and 32 levels. Pass: fewer than `--max-px1` pixels over 1 level and none
  over 2 (`--max-px1 0` demands identity). Exit 1 on any failure or missing view.
- Differing views get `<out>/<view>.diff.png` (difference x8) and the worst windows as
  `ref | test | diff x8` sheets; `<out>/report.json` holds everything (default `<testDir>/diff`).
- `--aa-floor`: both sets captured with `--repeat`. A view passes when it is pixel-identical across
  the sets, or when the reference does not repeat and the cross difference stays within the larger
  of the two sides' A/A differences. The test side need not be non-repeatable too: a stable test
  frame inside the reference's spread passes (the note says so). A view that repeats on the
  reference must repeat on the test side and match it pixel for pixel. Diffing a set against itself
  lists its A/A floor; `--md` writes the table.
- `--temporal`: the rule for temporal AA captures (`aa=taa|taau`), whose paused frames do not
  repeat pixel for pixel (see Temporal tolerance below). MSAA sets keep the exact rules above.
- Each capture's JSON records the browser build (`browser`); diff-set warns when the two sets come
  from different builds, since their frames may differ. Compare sets captured with the same
  browser (Playwright's Chromium, or one `CHROME_PATH`), or a stored set verified for the other
  build (Reference store, Browser updates).
- `--crops-from`: per anchor, the difference counts and a `ref | test | diff x8` sheet
  (`<out>/<view>.<anchor>.png`), and per view `<view>.anchors.png`, the test frame at a quarter size
  with its anchor boxes.
- `--jobs n`: views compared at once, in threads (default 4, or half the cores on a CPU with fewer
  than 8, since captures share the CPU; `--jobs 1` for one at a time). The output does not depend on
  it: the table prints in view order and every number is an exact integer sum divided once.

## Temporal tolerance (diff-set.py --temporal, tolerance.py)

MSAA paused frames repeat pixel for pixel (or within their small A/A floor); temporal ones do not,
and we chose not to make them: the GPU ends a render pass on its own (tile overflow, preemption) at
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

## Reference store (reference.mjs)

References are kept per commit and shared by every task and process that checks against it, so a
reference is captured once per commit and capture-tool version (a capture set survives a browser
update once a few of its views match under the new build: Browser updates below). `capture-set.mjs
--reference` / `--check` keep capture sets there, `baseline.mjs` its `baseline` and ground-truth
entries. A task that runs the usual command gets reuse and waiting by itself.

### Layout

```
<root>/<sha>/                      the full sha (a short one in a path is rewritten to it)
  S1/                              a capture set: <view>.png, <view>.repeat.png, .json, .log
    complete.json                  its manifest, written last
    .capturing/owner.json          while a process captures or extends it
  S2/medium/, S2/low/, S3/msaa1/   further sets, each with its own manifest (S2: the parked tiers)
  FAST3/                           created only when no other set of the commit covers it
  baseline/<tier>/rest/<view>/     baseline.mjs entries (capture-clip folders), each with its own
  baseline/<tier>/clip/<clip>[@<view>]/   complete.json (and .capturing/ while being captured)
  gt/<tier>/..., gt-hi/high/...    the ground truth's entries, the same way
  <label>/...                      a test side's entries (baseline.mjs --label): not references
  carry/<A>/                       the carry-over checks from commit A: verdict.json, the paused
                                   set's diff, the spot checks' captures (Carry-over below)
  .replaced/<path with ~>@<time>/  a reference replaced by a fresh capture (safe to delete)
  .verify/<path with ~>@<time>/    a set's sample views while they are checked against a new
                                   browser build (removed afterwards)
  .<name>.mutex                    beside a reference for a few milliseconds while a process
                                   inspects it and takes its claim
```

### The manifest (`complete.json`)

```json
{
  "format": 1, "kind": "set" | "clip", "sha": "<40 hex>", "path": "S1",
  "key": { "kind": "set", "tool": "<16 hex>", "browser": { "executable": "playwright chromium", "version": "153.0.8010.12" },
           "quality": "high", "aa": null, "q": null, "size": "1728x1117@2", "capture": [], "pages": "jump" },
  "toolFiles": { "capture.mjs": "<12 hex>", "capture-browser.mjs": "...", "parity/capture-set.mjs": "...", "parity/views.mjs": "...", "parity/adhoc.mjs": "..." },
  "coverage": { "views": { "meadow-close": { "captured": true, "repeat": true, "identical": true },
                           "my-adhoc": { "captured": true, "def": "<16 hex>" } } },
  "url": "<the preview it was captured from>",
  "rounds": [ { "pid": 0, "label": "...", "started": "...", "finished": "...", "minutes": 2.1,
                "captured": "3 views + 3 repeats", "reason": "no reference yet", "failed": 0 } ],
  "verifiedBrowsers": [ { "browser": { "executable": "...", "version": "153.0.8010.13" }, "at": "...",
                          "views": [ "island-fair-noon", "meadow-close", "water-skim-cliffs" ], "rule": "decoded pixels" } ]
}
```

- `key`: what the pixels depend on. `tool` hashes the capture tools' sources: for sets
  `capture.mjs`, `capture-browser.mjs`, `parity/capture-set.mjs`, `parity/views.mjs`,
  `parity/adhoc.mjs`; for clip
  entries `capture-clip.mjs`, `capture-browser.mjs`, `parity/views.mjs`, `parity/clips.mjs`
  (`TOOL_FILES` in reference.mjs: every file of that kind's capture path, the shared browser,
  readiness and grab included; a change to the clip tools leaves sets valid and the other way
  round); `toolFiles` keeps each
  file's hash so a forced recapture names the files that changed. `browser`: CHROME_PATH or
  Playwright's Chromium, and its version. Then the options: a set's tier, aa, size, extra query
  and capture.mjs options, and `pages`, how its views were reached: `"jump"` (a page per worker,
  most views by the scene jump; a manifest without it counts as this) or `"view"` (a fresh page
  per view, `--page-per-view`), so neither stands in for the other. A build without the exact jump
  gets a page per view whatever was asked: its set is stored as `"view"` with `"jumpless": true`,
  and serves both. A clip entry's key holds its `tier`, `aa`, `size`, `q`, `clip`, `view`, `full`,
  `every`, `dense` and `anchors` (the hash of the anchors it took with `--anchors-from`, null for
  its own), so a ground truth follows a recaptured baseline.
- `coverage`: what the directory holds, apart from the key. A set lists its views, each with
  `repeat` (the second fresh-load capture exists) and `identical` (the two hold identical pixels:
  the view's A/A this time), and an ad-hoc view `def`, its definition's hash; a clip entry is
  `{ "captured": true }`. The manifest vouches only for what
  it lists: a set whose views partly failed lists the others, and the next request captures the
  rest.
- `rounds`: each capture or extension, with its reason; a verification against a new browser
  build is a round with `verify` (the build, the sample views, the rule, whether they matched).
- `verifiedBrowsers` (sets only): other browser builds whose captures of the sample views matched
  the stored frames; a request under one of them reuses the set as if the key were its own. The
  key keeps the build that captured the set, so two builds in use at once never flip it.

### What a request does

1. The directory's manifest has the same key and covers the request: reused. For a set, another
   set of the same commit with the same key that covers it serves too (S1 serves FAST3).
2. A live process holds the claim (`.capturing/owner.json`: pid, host, start, key and what it will
   cover), on this directory or on a set that will cover the request: wait (poll every 5 s, a
   line a minute), then reuse. A `--reference` or baseline run under `gpu-lock.mjs run --shared`
   first frees the slot its wrapper still holds (the wait needs no GPU; a `--check` keeps it for
   its test side, captured meanwhile).
3. Otherwise capture (only with a URL of the commit: `--reference`'s own, `--check`'s `--ref-url`,
   the baseline run's `--url` or another label's `--ref-url`), saying why:
   - same key, less coverage (a view, a repeat): `not captured yet: ...`, the set is extended in
     place and the manifest rewritten with the union;
   - another key: the capture tools changed (and which files), the browser build changed, or an
     option differs; the old directory moves to `.replaced/`. A set whose key differs only by the
     browser build is verified first (Browser updates below) and captured afresh only when that
     fails;
   - a claim whose process is gone (killed, crashed): `the capture by pid N did not finish`, the
     partial captures are discarded (kept when a manifest already vouched for them and the claim
     only extended it);
   - no manifest at all (captured before the store, or by hand): moved to `.replaced/`;
   - `--recapture-reference` (a reference suspected bad): forced.
   Without a URL the tool stops and says what it would need (`--skip-existing` in baseline.mjs takes
   a reference without a manifest, or of another key, as it is).

The claim is taken under a short mutex, so of several processes that find the same reference
missing exactly one captures it. A claim names a pid on this host: a process that is gone (or a
zombie) leaves a stale claim, which the next request takes over; when `ps` cannot answer in time
(a loaded machine) the process counts as alive, since taking over a live capture would put two
writers in one directory. A process releases and records only a claim that is still its own. Before capturing, the tool checks
which worktree serves the reference URL's port (`lsof`): it refuses a server whose commit differs
from the reference's in what the build reads (`src/`, `index.html`, `public/`, `vite.config.ts`,
`package.json`, `package-lock.json`, `tsconfig.json`; a branch that changed only tools or docs
serves the same build) or that has uncommitted changes there, and warns when `dist/` is older than
the last commit of those inputs. `node
tools/parity/reference.mjs status <root>/<sha>` lists every manifest and claim under a commit,
and whether its tool hash is current.

A recapture of a reference is forced when the capture tools change (one reference round after a
tool change lands), when the browser build changes and the set's samples no longer match (and for
every clip entry), when a check needs repeats or views the stored set lacks (only those are
captured), and on request. Repeatability: with readiness by stability (Fast
mode above) MSAA views repeat pixel for pixel between page loads (24 of 24 in the base references),
where the fixed waits left a few views 1-3 levels apart on a few pixels of vegetation; temporal
sets never do. Still compare with `--aa-floor` (or `--temporal`) on sets captured with `--repeat`:
a view that differs once is judged against its own A/A. `coverage.views.<view>.identical` records
each stored A/A.

### Browser updates

A Chrome auto-update (a minor build, .39 -> .40) changed the browser in every key and cost a full
reference round (one S1 alone took 57 minutes), although frames rarely change between such builds.
So a capture set whose stored key differs from the request's only by `browser` is verified rather
than replaced, under the claim (waiters wait as for a capture; the stored set is untouched until
the samples decide):

1. Up to three stored views are captured with the new build into `<root>/<sha>/.verify/`, one of
   each kind a browser change could render differently: the island by day (`island-fair-noon`,
   `horizon-fair-noon`, `low-36`, `island-clear-golden`), vegetation (`meadow-close`,
   `flowers-close`, `meadow-24`) and water (`water-skim-cliffs`,
   `rim-sea`, `island-from-sea`, `cliff-sea-golden`), each the first stored one, preferring views
   the request needs; a set with none of a kind fills up with other stored views. MSAA views whose
   stored A/A differed (`identical: false`) are not picked when others are stored.
2. They are compared with the stored frames: MSAA and `aa=off` by decoded pixels (every pixel
   equal), the temporal modes (`aa=taa|taau|gt`) with `diff-set.py --temporal` (against the stored
   capture and its repeat when stored).
3. All match: the build is appended to the manifest's `verifiedBrowsers` and the set is reused
   (`reference S1: the stored set holds for <version>: 3 sample views match ...`, then `reused
   (verified for <version>)`); later requests under that build reuse it straight away, and a request
   that needs more views extends it with the new build.
4. Any differ (or fails to capture): the set is captured afresh as for any other key change (the
   old one moved to `.replaced/`), the samples kept as the new set's first captures of their
   views (`... the sample views differ: meadow-close (14806 px differ, max 9 levels), ...: capturing it
   afresh`).

`--recapture-reference` skips the verification. Not covered: a sibling set (S1 serving FAST3) is
not verified on another set's request (FAST3 is captured), and clip entries (baseline.mjs's
`baseline` and ground-truth entries) are recaptured under a new build, since an entry is a single
capture and checking it costs as much as capturing it. carry.mjs accepts a verified build where
it compares paused sets' keys.

### Carry-over (carry.mjs)

A new merge-base B whose diff from an earlier commit A cannot have changed A's baseline and ground
truth takes them over instead of capturing them again (most of a reference round: the gates' clips
and 64 jittered renders per rest view):

```sh
node tools/parity/baseline.mjs --url <preview of B> --sha B ... --carry-from A [--carry-url <preview of A>] [--carry-recheck]
node tools/parity/carry.mjs check --from A --to B [--url <preview of B>] [--carry-url U] [--root DIR]
    [--tiers high] [--views a,b] [--clips a,b] [--only rest|clips] [--all] [--recheck]
```

The conditions, cheapest first (a baseline run stops at the first that fails; `check --all`
evaluates every one and carries nothing):

| condition | how it is ruled out | gates |
|---|---|---|
| `sameBuild` | `git diff A B` touches nothing the build reads (`BUILD_INPUTS`): the same build, so everything carries with no further check | all |
| key | A's entry manifest has exactly the key B asks for: tool hash, browser build, tier, aa, size, query, clip, view, sampling, anchors | each entry |
| `motionWatch` | the diff touches none of `src/main.ts`, `src/weather/`, `src/characters/`, `src/ocean/`, `src/game/view/`, `package.json`, `package-lock.json` (motion a paused frame cannot show; the stepper) | all |
| `paused-<tier>` | B's paused set matches A's: `S1` on high (the 12 parity views plus every view an entry is on), `S2/<tier>` below (those views); diff-set `--aa-floor` where both hold repeats, else pixel identity. Captured or extended through the store; A's from `--carry-url` when its store lacks it | all |
| `stored` | A's rest baseline entry's whole frame matches A's own paused-set frame of that view within 2 levels (files only): the paused check vouches for A's set, not its entries, and a capture that went wrong at A would otherwise carry on. Entries without a whole frame (the TAA rest views, the lower tiers) are not checked | rest entries with a whole frame |
| `spot` | the first 16 frames of `pan-slow` and `islander-walk` under MSAA captured on B with A's anchors, pixel-equal to A's stored baseline entries (a differing clip is captured once more: a whole-frame outlier under a shared GPU does not repeat) | clips |
| `gtWatch` | the diff touches none of `src/post/` `TemporalAA`, `TemporalRest`, `Jitter`, `Antialiasing`, `Motion`, `Pipeline`, `AfterResolve`, `SceneEvents` (`.ts`), nor the dependencies | aa=gt |
| `gtSpot` | one rest ground truth (the first of island-fair-noon, meadow-close, meadow-24, flowers-close, rim-sea that A holds) captured on B within the ground truth's noise of A's: per image max 8 levels and at most 0.05 % of pixels over 2 | aa=gt |

GT-HI, the lower tiers' clips and the test labels never carry. The metrics are recomputed by every
baseline run, so a change to `clip-metrics.py` or the thresholds invalidates no capture.

A carried entry is a real directory at B's path holding clones of A's files (copy-on-write on APFS,
a plain copy elsewhere; never hard links: a later write would change both) with its own manifest:
A's key, so later requests on B reuse it, and

```json
"carriedFrom": { "sha": "<A>", "path": "baseline/high/rest/meadow-close", "origin": "<the commit that captured it>",
                 "at": "...", "verdict": "<B>/carry/<A>/verdict.json" }
```

(its round also names `carriedFrom`; `reference.mjs status` shows `carried from`). The checks'
captures, diffs and the verdict stay under `<root>/<B>/carry/<A>/`; the spot checks' results are
reused by later runs with the same inputs (the clip tools, the browser, A's entries' last capture).
An entry that may not carry is captured as without the option, and the log names the condition
that failed (`baseline high/clip/pan-slow: not carried (spot: ...)`).

What the rule cannot see: a change that alters motion only, outside the watch list, in a view or
clip the spot check does not cover; a temporal-only change visible in the ground truth of views
other than the one spot-checked; the lower tiers' ground truth (checked on high only); and a rest baseline entry without a whole frame
that was captured wrong at A (only whole frames are checked against A's paused set).

## One page, many views: the scene jump (verify-scene-jump.mjs)

Only the load-time options need a new page (quality, aa, size and dpr, the S3 switches): the views'
weather, time, moon and camera are runtime state, and `__PONLAI__.establishScene( query )` jumps to
them in place (`src/main.ts`, where its contract is written): after the jump, one rendered frame at
the jump's camera and the view's eval, the paused frame is the one a fresh load of the view's query
draws, byte for byte wherever the fresh load repeats. A tool that captures a set in one page calls it
with the view's full query (the common part and the view's own), waits for a frame, runs the eval,
then its readiness and the shot.

`tools/verify-scene-jump.mjs` is that check, and the regression probe for anything that adds state a
jump must clear (AGENTS.md: paused frames):

```sh
node tools/verify-scene-jump.mjs <baseUrl> <ref> --fresh                     # fresh loads
node tools/verify-scene-jump.mjs <baseUrl> <ref> --fresh --suffix .repeat    # their A/A
node tools/verify-scene-jump.mjs <baseUrl> <test>                            # one page, list order
node tools/verify-scene-jump.mjs <baseUrl> <test> --order reverse --suffix .repeat
uv run --with numpy --with pillow tools/parity/diff-set.py <ref> <test> --aa-floor
```

or, in one command, against the reference store:

```sh
node tools/verify-scene-jump.mjs <baseUrl> <test> --check <root>/<sha>/<set>
```

`--check` takes the fresh side from the store (capture-set `--reference --repeat --page-per-view`
of the same views and options: a fresh page per view, reused for the commit, else captured in
parallel), runs the two jump orders at once (two pages, one leased GPU slot each) and then
`diff-set.py` (`--aa-floor`, or `--temporal` for the temporal modes; the table also in
`<test>/diff.txt`). It refuses a stored set whose key is not `pages: "view"`: a set reached by jumps
would compare the jump with itself. Every run leases its slot per
view (as capture.mjs's worker), so a waiter gets in at the next view boundary.

Both sides use capture.mjs's readiness (a persistent profile; after the evals the image grabbed
with the loop stopped until two grabs agree, a temporal page's converged rest; the loop stopped for
the shot; `--frames n` for the old fixed count), so they differ only in how the scene was reached.
Each shot's JSON records `ready`; a shot still changing at the cap is printed as unstable. `--from <view or query>`
visits scenes first without capturing them (a storm, a night, fog, another clock: `--from
"weather=storm&preset=noon&t=5"`); `--aa taau` with `diff-set.py --temporal` checks the temporal
modes. All 24 views take about 2-3 s each in one page, against 6-7 s per fresh load (unshared GPU).

## Clips (clips.mjs, capture-clip.mjs, clip-metrics.py)

A clip is a view set in motion: its base view, a paused or running scene clock, a frame count, a
camera path that is a function of the frame index applied to the view's own pose (a pan, a flick, a
dolly, an orbit about the islander), and where needed a render scale schedule (`drs-steps`, in
shares of the tier's nominal ratio: 0.8, 0.6, 0.8, which is 1.2, 0.9, 1.2 on high at 2x), extra
URL options (`sun-shadow`: `dayLength=600`) or a per-frame hook (`lightning`: a strike forced at
frame 30), and lead frames stepped before frame 0 and not captured (`drs-steps`: 32 at its first
scale, so a temporal mode's history, cut when the stepper starts, has converged before the scale
steps it measures). `node tools/parity/clips.mjs list [all|normal|special] | show <clip>`.

```sh
node tools/capture-clip.mjs <name> --url <preview> --clip <clip> [--aa msaa|off|taa|taau|gt|gt-hi]
    [--view v] [--frames n] [--every k] [--crops a,b] [--full 0,30] [--q "extra"] [--gt-jitters n]
    [--anchors-from clip.json] [--out dir] [--runs runs.csv]
uv run --with numpy --with pillow --with scipy [--with flip-evaluator] tools/clip-metrics.py \
    --test DIR --msaa DIR [--gt DIR] [--crops a,b | boxes.json] [--split-redraws] [--thresholds t.json]
    [--baseline metrics.json] [--workers N]
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
- A paused one-frame clip without a temporal rest (`rest` under msaa, off, gt-hi) is stepped again
  and shot whole until two shots agree within the readiness tolerance (at most 6 shots, else the
  clip fails and writes nothing): a single stepped frame can be the GPU's alternative image (task O;
  most often while other browsers render), which the readiness check before it cannot see. `clip.json` records the
  shots (`recheck`); `--test-fault` draws the first one with film grain to test it. Header of
  `capture-clip.mjs`.
- Crops: the view's anchors, or the clip's own (`night-still`: the horizon's stars, no crop of the
  view's rest image), or `--crops`, are read once at the base pose, and each frame projects
  their world points into a 192 CSS px box (384 device px at 2x). `--full` frames are captured whole.
  Output: `<crop>/<i>.png`, `full/<i>.png`, `clip.json` (boxes, the camera and render size per frame,
  diagnostics, pipelines created while stepping).
- `--aa gt`: the temporal modes' ground truth (`aa=gt`, debug builds): the temporal graph at the
  canvas's resolution, each captured frame held still after its tick (`loop.step`'s `converge`)
  until the temporal rest has averaged `--gt-jitters` jittered renders of it with a box filter
  (32 by default, 64 for a one-frame clip such as `rest`), unsharpened and without grain, cropped
  at the test's own size. The scale schedule is ignored. It renders every tier (the tier's own
  content at the canvas's resolution), so each tier has its own ground truth. Keep its sets per
  merge-base under `<parity root>/<sha>/gt/<tier>/`. Paused temporal captures (capture.mjs, capture-set.mjs) wait for the
  rest to converge (`diag.taa.converged`).
- `--aa gt-hi`: the interim ground truth, MSAA on high at twice the former nominal ratio (1.5) for the size
  (3x at the default @2, where the nominal is 1.5) in a canvas that holds it, box-downsampled 2x2
  (288 px crops at the default size). It renders every frame at that ratio: a clip's scale schedule
  applies to the test and MSAA sides only. Its pixel-width vegetation rules are in render pixels,
  so its meadow is finer than any real render: judge vegetation look against MSAA. Kept for
  cross-checks against aa=gt (`<sha>/gt-hi/high/`); the gates read aa=gt. aa=gt's blades are
  finer than MSAA's too (one sample: at least 1 canvas px, MSAA's 2 render px), so vegetation
  look is judged against MSAA there as well.
- `parity/baseline.mjs`: the MSAA baseline of a merge-base and its ground truth (the plan in its
  header): `--gt` captures the ground truth with the baseline's anchors, `--gt-aa gt` (default,
  every tier) or `gt-hi` (high only); metrics read the entry's own tier's GT, else high's with the
  GT gates off. `--thresholds` adds the gate verdicts and the aggregates (the overall fidelity's
  share of views; the alignment's median signed offset per tier). The `baseline` and ground-truth
  entries are references in the store (Reference store above), captured only from the commit's
  own preview: the baseline run's `--url`, or `--ref-url` in another label's run (which then also
  captures the ground truth); without it a missing or stale reference is reported and its entries
  skipped. `--clips` may name a clip that is not a gate's (a task's own, such as `drs-steps`), whose
  baseline and ground truth are then kept the same way.
- `clip-metrics.py`: per crop, the test's and MSAA's metrics against the GT (definitions in its
  docstring), their ratio, and PASS / FAIL against a thresholds file of gates on a baseline (MSAA
  measured here, or an earlier metrics.json): ratios with an absolute floor for magnitudes (a
  paused clip's MSAA flicker is exactly 0), differences for the signed fringe, the lag and the
  edge width (`edgeWgt`, against the wider of MSAA's and the GT's edge). Whole frames (`full/`)
  are measured only when `--crops` names them, or cut into boxes by `--crops boxes.json`. Without
  `--gt` only the sides' own metrics; `--split-redraws` splits Fhp near and between the shadow map
  redraws that the clip's notes mark. The frames are measured in worker processes
  (`--workers N`, `CLIP_METRICS_WORKERS`, by default a quarter of the CPUs within 1 to 4; results
  identical whatever the count): baseline.mjs runs several metric runs at once on top of that.
- Repeatability: pan-slow on meadow-close repeats pixel for pixel between fresh loads. Vegetation
  crops elsewhere can differ in single frames: with the vegetation depth prepass on, a few samples
  pass its equal depth test differently from frame to frame (blobs of a few to 150 px on leaves
  and blades; none with `vegPrepass=0`).

