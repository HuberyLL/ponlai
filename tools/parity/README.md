# Parity captures

Paused captures of a fixed set of views, and a per-view diff against a reference set: the check
that a refactor leaves the image as it was (byte for byte, or within the reference's own
repeatability), and 1:1 crops of named subjects for judging a change that is meant to show.

- `views.mjs`: the views (camera, weather, time) and their crop anchors.
- `capture-set.mjs`: captures a set through `tools/capture.mjs`.
- `diff-set.py`: compares two sets.

## Serving a build for captures

Capture a production build (`npm run build`, then `npx vite preview --host 127.0.0.1 --port <port>
--strictPort`), each branch from its own worktree on its own port. Two things the captures need:

1. `?debug` in the URL (capture-set.mjs adds it): `window.__SOOMI__` and the diagnostics exist only
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

Each view names the subjects worth a 1:1 look. When the page reads `window.__SOOMI_CROPS__` (a
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
    [--max-px1 200] [--crops 3] [--crop 256] [--out dir] [--aa-floor] [--md table.md]
    [--crops-from ref|test|<dir>|<file.json>]
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
- `--crops-from`: per anchor, the difference counts and a `ref | test | diff x8` sheet
  (`<out>/<view>.<anchor>.png`), and per view `<view>.anchors.png`, the test frame at a quarter size
  with its anchor boxes.

## Reference sets

Keep references per merge-base, captured from a detached worktree of that commit:
`<root>/<sha>/S1` (the 17 views with `--repeat`), `S2` (`--quality medium|low` on six views),
`S3` (single-sampled, `dpr=1`, the vegetation prepass off and the `post=` switches), with
`aa-floor.md` listing each view's repeatability. A few views do not repeat byte for byte between
two page loads (1-3 levels on a few pixels of vegetation, rarely more), and which views they are
changes from run to run: compare with `--aa-floor` on sets captured with `--repeat`, and treat a
byte-identical result on a view as luck, not a property of the view, unless it holds across runs.
