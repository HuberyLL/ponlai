# Frame profiler

The frame profiler, `tools/render/profile-frame.mjs`, plays named scenes on a build of the page in
Chrome and reports the frame interval, the GPU time per pass, the tick's JavaScript time, hitches
with their cause and the startup. Its usage, options, output, lock and exit codes are in its header
(`node tools/render/profile-frame.mjs --help --full`). This page holds the rest: the scenes, the
modes, how the runs hold the GPU lock, and how to read the results. The steps for measuring a
change: the skill [measuring-performance-changes](../../skills/measuring-performance-changes/SKILL.md)
and its [binding](../bindings/measuring-performance-changes.md).

Contents:

- [Scenes](#scenes)
- [High's standard](#highs-standard)
- [Timestamps](#timestamps)
- [Modes](#modes)
- [A/B comparisons](#ab-comparisons)
- [Reading the results](#reading-the-results)
- [Display mode](#display-mode)
- [The GPU lock and the machine's load](#the-gpu-lock-and-the-machines-load)
- [Hangs, lost scenes and unfinished runs](#hangs-lost-scenes-and-unfinished-runs)
- [Browser and caches](#browser-and-caches)

## Scenes

Every scene runs its clock, with a fixed weather and the camera moving as in play: a slow orbit
about the target, or in place for the sky and meadow views. A paused, still scene settles its
clouds once and skips the march and the shadow steps, so it would under-measure. `--list` prints
the scenes with their queries and views.

| Scene | Weather and time | View | Runs |
| --- | --- | --- | --- |
| `island-fair-noon` | fair, noon | island | by default |
| `island-clear-golden` | clear, golden hour | island, facing the sun | by default |
| `horizon-fair-noon` | fair, noon | horizon | by default |
| `sky-fair` | fair, noon | sky | by default |
| `island-night-clear` | clear, midnight | island | by default |
| `meadow-close` | fair, noon | eye height over the meadow near the rim | by default |
| `horizon-clear-noon` | clear, noon | horizon without a cloud deck | by name |
| `sky-cloudy` | cloudy, noon | sky | by name (parked) |
| `island-overcast`, `island-cloudy` | overcast, cloudy, noon | island | by name (parked) |
| `horizon-cloudy`, `horizon-overcast` | cloudy, overcast, noon | horizon | by name (parked) |
| `island-rain`, `island-storm` | rain, storm, noon | island | by name (parked) |
| `horizon-storm` | storm, noon | horizon | by name (parked) |
| `island-fog-dawn` | fog, dawn | island | by name (parked) |
| `weather-change` | fair, noon, a front to rain over 6 s | island | by name (parked) |

The parked weathers' scenes (`packages/render/sky/Weather.ts` `PARKED_WEATHER`) are left out of
the default matrix and of `--accept`'s; `--scenes` reaches them, and `?profile` reaches them on a
production build. The clouded horizons are where the low deck's march costs, since the sky fills
half the frame there; `horizon-clear-noon` is the same view without a deck. `meadow-close` is
placed on the camera's ground (`controls.ground`). `weather-change` measures a front sweeping in,
with its pipeline compiles and bakes; scenes with a change run last.

## High's standard

The reference is a production build (`npm run build && npm run preview`, port 5191, the default
url); the dev server works for quick checks. The default viewport is a generic 4K display: 1920 by
1080 CSS pixels at a pixel ratio of 2.

High is timed at its standard (`packages/render/Quality.ts`): 4K output at 1440p's pixel count,
upscaled by FSR 1, with MSAA 4x. A profile, `--compare` or `--toggle` of high pins the render scale
at the baseline of its dynamic rule for the viewport, by adding a `dpr` to the query:
`dpr=1.3333333333333333` at the default viewport, `dpr=1` at `--w 2560 --h 1440 --scale 1`, a 2K
display (`packages/render/post/RenderScale.ts` `dynamicRange`). So profiles and A/Bs measure the
level every trade-off is judged at.

`--unpinned` leaves the tier's own rule, a dynamic scale steering; add `--scale-settle 5
--scale-log` to see where it settles. `--accept` (the frame rate a player sees), `--display`,
`--scales` and a `dpr` in the url or `--q` are never pinned.

## Timestamps

GPU timestamps give the time per pass. With timestamp queries on, Chrome ran the same frames up to
a quarter faster: light scenes most, a GPU-bound heavy scene hardly at all. So the per-pass split
shows where the time goes, not the frame rate a player sees, and frame rates for final numbers come
from a run without them. An A/B in one mode cancels the bias.

- `--timestamps on` (the default): frame intervals and the GPU time per pass.
- `--timestamps off`: frame intervals only. The default with `--display`, as a player's page runs.
- `--timestamps both`: every scene twice, its frame intervals from the run without timestamps and
  its passes from the run with them.
- `--timestamps auto` (with `--accept` only, its default): every scene without timestamps, then the
  scenes that did not pass again with them.

A tier with a dynamic resolution keeps its own timestamp queries in every run, as a player's page
does; `--q gpuTimer=off` leaves them out.

Uncapped, the page runs about 120 frames ahead of the GPU, so a frame's timestamps come back
seconds later (a scene's `profiler.readbackMs`). The profiler waits for each frame's own read-back,
with no time limit, and `missingPasses` counts only passes whose query was never written or whose
read-back failed. A run with `timedFrames` 0 is a bug, not a busy GPU.

## Modes

### Page mode

The default (`--mode page`) loads each variant once. Each scene is set up at runtime through
`window.__PONLAI__` as its URL options would load it: the weather established at once (wet in rain),
the time preset, the clock from 0, the camera view and its motion. The loop stands still meanwhile,
so no frame mixes two scenes. The scene then warms up for `--warmup` seconds (1.5) and until no
pipeline was created for a second: a new weather compiles its pipelines on first use, and that
compile is reported per scene, outside the measured window. Most of a page load is the island's
generation, so switching scenes is far cheaper than loading them.

### Reload mode

`--mode reload` loads a fresh page per group of scenes that share a query, or per scene with
`--fresh`. Its warm-up defaults to 3 s and its idle wait to 60 s. `--compare` then alternates
A B B A page loads.

### Compare

`--compare urlA urlB` measures two builds; the other build comes from `node tools/kit/serve.mjs
preview --sha`. See [A/B comparisons](#ab-comparisons).

### Toggle

`--toggle "js"` is an A/B inside one page, the fastest and most precise: no reload and no drain.
The expression runs with `s` = `window.__PONLAI__` and `on` (false for A, true for B), and is
applied every `--block` frames (60) in an A B B A B A A B pattern, for `--blocks` blocks (8), after
both states were warmed. For example `--toggle "s.water.mesh.visible = !on"`, or `--toggle
"s.flags.fastWater = on"` for an optimisation that reads a flag of
`packages/render/debug/DebugFlags.ts`. Each frame counts for the state its tick ran in. GPU figures
drop the first 2 frames after a change, frame intervals the first `--lag` (30): headless Chrome
queues about two dozen frames, so a change reaches the animation frame's interval that much later.

### Vsync

`--vsync` keeps Chrome's vsync and frame-rate limit (60 Hz headless), so the frame interval is what
a player sees: 16.7 ms while every frame makes its vblank, 33.3 when one misses. Uncapped, a
GPU-bound scene's p95 is mostly pacing noise: a sky that holds 60 Hz under vsync showed a p95 of
twice that uncapped. With vsync the queue stays shallow and the intervals fall on vblanks.

### Acceptance

`--accept` implies `--vsync` and judges the 60 fps criterion per scene. From the run without
timestamps, the median and the p95 must be within half a millisecond of `--target` (16.7), with no
frame over 25 ms in the measured window (7 s by default). The p99, the maximum and the GPU busy time
of a run with timestamps are reported beside the verdict.

Other work on the GPU costs frames. A scene measured while something else kept the GPU busy
(contended: with `--contended`, or found at a later page load) that fails is INCONCLUSIVE, unless
its own GPU busy median is over the target, which no idle GPU would make up; one that passes is
PASS (contended). Contended means the run without timestamps was, since its frames are the ones
judged. The exit code stays 0 unless `--strict` is given, which exits 1 on a FAIL.

The run with timestamps decides no verdict on an idle GPU and only turns a contended failure into a
FAIL, so `auto` runs it only for the scenes that did not pass, where the GPU busy time and the
passes explain the failure. A run where every scene passes has none, about half the exclusive hold
of `both`. A scene that passed then reports no GPU busy time, no passes and no GPU hitches (its
headroom under the frame): `--timestamps both` measures every scene twice for that, `off` never
with timestamps.

Headless at 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames:
see [Display mode](#display-mode).

### Scales

`--scales 1,0.9,0.75` repeats the run once per render scale (the page's `dpr` option) in one
invocation, with a table of every scene at every scale: the threshold where a scene holds 60 Hz,
and the settle points of a dynamic resolution. The url and `--q` must not set `dpr` themselves,
since the page reads the first of a repeated option. A scale above the display's pixel ratio is
capped by the page, and the run warns when the render's ratio differs from the scale. With
timestamps on, high's reports add `gpuPixel`: the part of the GPU time in passes that follow the
render's pixel count (the dynamic resolution's split), for fitting its cost model at fixed scales.

### Scale settle

A tier with a dynamic render scale (high) moves it by the GPU's frame time. `--scale-settle s`
waits after each scene's warm-up until the scale has held for s seconds (at most 60), so the scene
is measured at its settle point; in `--compare` each page settles after its own warm-up. Every
report gives the scale the measured frames were drawn at (its median, range and changes) beside the
frame times.

Without it, high's scale stepped down from its nominal inside the first slices of a run's first
scene, on both pages. So `--display --compare` settles for 2 s by default: in display A/As without
it, both pages stepped down inside their first slice at different times, which put a step into one
side's measured frames and not the other's; with 2 s, no scale change fell inside a measured slice.
It costs a few seconds per page per scene under the exclusive lock. `--scale-settle 0` turns it
off. Every other run defaults to 0: headless A/Bs are judged by the passes, which a scale step moves
on both sides alike.

`--scale-log` writes each page's dynamic-scale changes per scene (the time on the controller's
clock, from and to, the rule and, for the GPU's rules, the predicted and measured 90th percentile)
to the output and to each scene's `scaleLog` in profile.json. In `--compare` it also gives, per
slice, how long the page stood stopped, how far its controller's clock moved meanwhile and which of
its timers (holds, a failed step's bar, the contention hold) ran out.

### The remembered scale and the frame rate's fallback

High starts from the dynamic scale it last held (`drsStore`; off in an automated browser anyway).
`--compare` and `--accept` load their pages with `drsStore=off`, so neither side of an A/B (two AA
modes, two builds) starts from a scale the other or an earlier run settled at; `--drs-store` loads
them with `drsStore=on` instead, to measure a returning load.

On a faster display the frame pacer may step from the tier's rate to the next divisor (72 to 48 fps
on 144 Hz) when the dynamic scale's floor cannot hold it (`packages/render/post/FramePacer.ts`).
`--compare` and `--accept` load their pages with `frameFallback=0`, so both sides hold one rate and
stay comparable; `--frame-fallback` keeps the fallback on. The page reads it once at load, so it
holds on a page kept open from scene to scene. On the display each scene reports its effective rate
(rendered frames per second) and its share of frames at the fallback, and late frames are judged
against the pace each frame was rendered at.

## A/B comparisons

`--compare urlA urlB` loads A and B once each, in two pages of one browser, and measures them in
alternating slices under the same conditions: `--slices` (8) in the order B A A B A B B A, each
`--slice` seconds (1.5) after `--settle` seconds (1) at each switch. One page runs at a time. The
other is stopped: no animation frame and no GPU work, its queued frames and any sky bake drained
before the other starts, its camera and clock waiting, and its dynamic scale's clock with them
(the debug hook `dynamicClock`), so its holds and bars do not run out during the other page's
slices. Chrome let one page's frames starve the other's queue when both ran.

The page that runs is brought to the front first, headless too. The two pages are tabs of one
window, and a tab behind still runs its frames (Playwright keeps it visible to its page) but they
are not presented, so it paces otherwise. With the tab opened last (B) left in front, A/A runs on
one build gave B a median frame interval 7-17 % longer with GPU timestamps off, and longer with them
on, beyond the 95 % interval, its GPU busy time unchanged: an A/B read a build's gain as a loss.
With each page in front while it runs, the same A/As came out within their interval, on and off.
A/A runs (one build as both A and B) are the check for any change to how the compare runs.

Deltas are reported with their 95 % interval from the slices' spread and as a ratio B/A, beside
each page's render scale per scene: high's dynamic scale can settle higher on one side, which the
load-time render in the summary's header does not show, so read the deltas with that in mind.
Errors name their page (`pageerror (page B): ...`). `--eval-a` and `--eval-b` run an expression in
one page only.

Adaptive slices: `--slices` is the most a scene takes. From `--min-slices` on (4 with `--display`;
headless it defaults to `--slices`, which turns it off), at the end of each balanced block of four
slices (B A A B, then A B B A, so a drift over the run stays cancelled) a scene stops once its
leading delta's 95 % interval clears zero by `--stop-margin` or is no wider than ± `--stop-width`
(that one only with 4 slices a side: from 2 a side the interval can come out near zero by chance).
The leading delta is the one the summary leads with: the late frames on the display (a share,
defaults 0.1 and 0.02), else GPU busy with timestamps, else the median frame interval (ms, defaults
0.2 and 0.05). The display's defaults come from a replay of display compares, where stops saved
about a sixth of the slices and the late-frame verdicts held but for two borderline scenes.
Headless, an A/B is judged by the passes, whose deltas need every slice. The summary and each
scene's `stop` in profile.json give the slices taken and why. A stop answers the leading delta only:
the other deltas get fewer slices and wider intervals, so a run whose passes or secondary figures
matter sets `--min-slices` equal to `--slices`.

## Reading the results

A/B decisions rest on GPU time, per pass and in total: it is measured per frame on the GPU's
timeline and converges in far fewer frames than the frame interval. Frame rates for final numbers
come from `--timestamps off` or `both` (see [Timestamps](#timestamps)).

Each scene reports the frame interval's median, p95 and p99, the GPU time per pass, the tick's
JavaScript time, the hitches with their cause, the render scale the frames were drawn at, and the
startup. `--detail` adds each pass's own time and `--raw` every frame. `--shots` saves a JPEG of
each scene after its measurement (profile runs, not A/Bs). A scene measured while something else
kept the GPU busy is marked `(contended)` in summary.md's table, a compare's as a single profile's.

`--eval` runs in the page for every scene, after its camera is placed and before its warm-up, with
`s` = `window.__PONLAI__`: an ablation, for example `--eval "s.water.mesh.visible = false"` or
`--eval "s.pipeline.settings.bloom = 0"`. A url's own query options come first, so
`http://host/?profile=frames` runs that side without timestamps. `--hooks off` leaves out
`?profile` (frame intervals only, as for a build without the profiler). Older builds ignore what
they do not know, and the tool drives their handles directly where they lack its runtime hooks.

`--report <dir>/profile.json` renders summary.md again from a finished run, after a change to the
report.

## Display mode

Headless at 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames:
every scene once passed it while a 120 Hz display showed uneven cadence and a restless dynamic scale
under a player's drags. `--display` measures that on the real display, headed. It needs the display
gate (`tools/kit/display-gate.mjs`; [GPU lock](gpu-lock.md)). A run is headed only for what a
screen alone shows: pacing and cadence, late frames, the frame pacer's rate and the dynamic scale
under a player's drags; GPU cost and tuning run headless.

Chrome (the system's, without the switches the headless runs take) opens full screen (`--kiosk`)
at the display's own size, pixel ratio and refresh, so a 120 Hz display runs animation frames at
120 Hz. `--window WxH` opens a normal window of that outer size instead, as a player's, with its tab
strip and toolbar and the other windows on screen. The camera is dragged like a player's through
Chrome's input (`--motion user`, the default here, which loads the pages with `cameraInput`: drags
of 30 to 200 deg/s with pauses, a wheel zoom, a flick) for `--seconds` (20) per scene; `orbit` keeps
the slow orbit and `none` holds the camera still. A drag that loses its pointer to an event the run
did not send (the system cursor's, which reaches the headed page) is pressed again and logged.

Beside the usual figures each scene reports, by display refreshes, the intervals between the
frames the scene rendered and between the frames the compositor presented (from a trace of Chrome's
frame pipeline), the share of intervals that change cadence (judder at a steady pace), and how much
the camera's turning speed changes from frame to frame while it turns.

A window covers the screen while the run lasts: keep the runs short (at most 3 scenes) and other
pages and animated windows closed; the window server itself took 15-30 % of the GPU's time during
these runs. Full screen hides the other windows, and they stop drawing. In a window they stay on
screen, and a page drawing in one of them (an app's hidden browser pane rendering a second page)
shares the GPU and lowers high's scale: such a pane took a tenth of the GPU beside a window, a
hundredth behind full screen.

Bringing a page to the front gives Chrome the keyboard focus, so keys typed for another window
reach it. Every page of a `--display` run stops key events (keydown, keyup, keypress) on the window
in the capture phase, before the page's own listeners; the tool sends no keys. Pointer and wheel
stay open for the drags.

### Display compare

`--display --compare urlA urlB` interleaves A and B in the same slices as the headless compare, so
the drift between separate headed runs (a millisecond or two) cancels. The running page is brought
to the front, since a background tab gets no animation frames. The drags run in the measured slices
only, each page's on from where its last slice left them, so the k-th slices of A and B see the same
motion from the same view. The screen changes to the other page's view at every switch: expected.

A scene switch never shows the scene before: each page switches with its loop stopped, out of
sight, and starts before it comes to the front, so its first frame on screen is the new scene's.
Chrome still shows a page that comes to the front with the surface it kept when it last went to the
background, for about a frame. So a page leaves the front for the last time in a scene under a
cover (opaque, the loading screen's colour), shows that cover when it comes back with the next
scene, and drops it once it has drawn a few frames under it. The cover goes up and down outside the
measured windows; on screen it shows for a frame or two at each scene switch, and once inside a
scene other than the run's last, where the page that ends its slices first leaves the front.

The summary adds the share of late frames per slice (presented intervals longer than the pace each
frame was rendered at, the frame pacer's divisor then) as a delta with its interval, each page's
frames over 25 ms, its effective rate (rendered frames per second) and its share of frames at the
pacer's fallback rate. One trace spans a scene's slices of both pages, since Chrome traces one
session at a time, split by a performance mark per slice and ended early at each adaptive stop
check; a trace per slice nearly doubled the time a slice took beyond its settle and window. The run
log gives each scene's time over its settles and slices.

## The GPU lock and the machine's load

The run holds the [GPU lock](gpu-lock.md) exclusively only for what it measures,
and opens no browser while it queues: a headed window must not sit on the screen, or die, while
the request waits.

- Preload: a build this profile has not loaded yet (a new bundle, port or browser version) is first
  loaded once in a browser opened inside a shared slot and closed before the slot is released, so
  the loads under the exclusive lock find the world cache and the shader cache warm. It is skipped
  when no slot frees within `--preload-wait` seconds (60). A cache miss generates the island:
  seconds alone, a minute under a busy CPU.
- Under the exclusive lock: the idle check, then the browser's launch, each load, each scene's
  switch, warm-up, scale settle and measured window. The pages' loops stop before the lock is
  released; the GPU name, the files and the browser's close come after it.
- A run with several scenes holds the lock one scene at a time, in every mode: before a scene's
  warm-up it asks for the lock, after its last slice its pages stop and drain. The pages and the
  browser stay open, their loops stopped, so they draw nothing while the lock is away. The hold is a
  lease (`leaseGpuLock` with `keepPlace`): kept from scene to scene while no request ranked before
  the run's first one waits, otherwise given up and asked for again at once under that request's
  ticket number. So queued captures run between the scenes instead of after the whole run, and a
  timing run of the same level queued meanwhile still goes after it. The first scene's hold covers
  the page loads.
- profile.json's `wallSeconds` is the time under the exclusive lock, with `lockWaitSeconds`,
  `totalSeconds` and `preload` beside it; `meta.holds` lists each scene the lock came back for (its
  wait and the GPU's idle with this run's pages stopped), also under "Lock" in summary.md. The run's
  last lines give the time held and, apart, the time in all without the waits for the lock.

### Idle checks

Before it measures, the run checks that nothing else keeps the GPU busy: the GPU's utilisation
must fall below `--idle-threshold` (15 %). When another client still keeps it busy after
`--idle-wait` seconds (20; 60 in reload mode), the run names the client, measures nothing, releases
the lock and exits with 3: a contended run's frame rates and verdicts prove nothing. Stop the
client and run again, or pass `--contended` to measure anyway, with the results marked contended.
The opening check also stands for the first load's. A later page load that finds the GPU busy still
marks its results contended. A hold taken again between scenes checks the GPU too; still busy after
`--idle-wait`, the run stops with the finished scenes written and exits 3, unless `--contended`
(that scene marked contended).

In full-screen `--display` the checks run with the run's window up (the opening one on its blank
page) and sum the GPU time of the clients other than the run's Chrome and WindowServer: full screen
hides the other windows and they stop drawing, so the utilisation before the window opened counted
a load the run never meets. With `--window` the check stays the utilisation's, since the other
windows stay on screen and their load is real.

### Load timeline

The idle checks see a few seconds before a load or a scene; the load timeline sees the whole run
(macOS; `tools/kit/load-timeline.mjs`). From the exclusive lock's hold to the end of the run, one
streaming `top` and a loop of one-second GPU client samples write `<out>/load.jsonl`, a line a
second: `{ t, cpu, gpu }`, each by group (`run`: this run's Chrome and its descendants,
`windowServer`, `app`: the desktop app, `otherChrome`, `kernel`: CPU only, `rest`), with `t` in ms
since the epoch (a page's frame time plus its `performance.timeOrigin`).

Each measured slice (a compare's slice, a toggle's block, a profile scene's window) gets `load: {
cpu, gpu }`, the mean outside the run over its window: every group but `run` and `windowServer`,
which composites the screen for every run. A slice whose outside GPU mean exceeds
`--idle-threshold` is contended, and a scene with more than a quarter of its slices contended is
marked contended, with the verdict rules of [Acceptance](#acceptance). The summary's "Machine load
outside the run" gives each scene its contended slices and mean outside load. `--load-timeline off`
turns it off.

## Hangs, lost scenes and unfinished runs

A hang loses one scene, not the run. A scene that shows no progress for `--hang` seconds (180) is
recorded as hung (profile.json `meta.hung`, a section of summary.md), with the step it was at (a
compare's load, warm-up, slice, trace end or results; at a scene's start, the halt, the cover, the
lock's wait or its idle check) and what each page still did (answering, visible, its animation and
scene frames over a second). A scene whose browser or page closes or crashes under it (a headed
window closed, Chrome gone) is lost the same way, as is a scene whose setup or placement throws in
the page (`meta.hung[].failed`: the error). Either way the browser is closed (killed when it is
still open after 30 s, so it neither runs on nor holds the profile) and opened again, and the run
goes on with the scenes not finished yet. A second hung or lost scene stops the run, with the
finished scenes written. A run that makes no progress outside a scene for longer than `--hang`
plus a minute exits 1, releasing the lock.

Each scene's results are also appended to `<out>/scenes.jsonl` as it finishes, and the meta known
at the start goes to `<out>/meta.json`, so a run that dies otherwise still leaves what it measured.
`--report <dir>` (or `<dir>/scenes.jsonl`) on a folder without a profile.json (a run that crashed,
was stopped or handed back) rebuilds summary.md from them with the reports a finished run uses: A/B
deltas and their intervals per timestamps pass, a profile's tables and verdicts, the load table from
`load.jsonl`. The summary says the run is unfinished and lists the scenes left out for a missing
variant or pass; it writes no profile.json. Without `meta.json`, what the scenes do not tell is `?`.
`--report` opens no browser and takes no lock.

A page paused or pinned during the run stops it the same way. Each page's `clockPaused` and
`scalePinned` (diagnostics) are read at its load as its baseline (`?dpr` pins legitimately) and
again after every slice or measured window. A change means a key or click reached the page: a Space
pauses it, and a paused page renders at its nominal scale and stops steering, which spoils every
scene after it, since a scene switch leaves the pause alone. The run stops with the finished scenes
written (`meta.spoiled`, a section of summary.md) and exits 1; the message names the page, scene
and slice.

## Browser and caches

Chrome comes from `CHROME_PATH`, else the system Chrome, else Playwright's Chromium, with a profile
of its own kept between runs (`--profile-dir`). Every page keeps the generated island's chunks in
IndexedDB in that profile while the generator's sources are unchanged; builds that predate it load
it only with `?worldCache`, which is added to every url. `--world-cache off` loads with
`worldCache=off` instead, so the island is generated as on a first visit. A profile that another
Chrome holds (another run's) is not launched on: the run takes a temporary one, with cold caches.
