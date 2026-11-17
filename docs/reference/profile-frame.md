# Frame profiler

The frame profiler, `tools/render/profile-frame.mjs`, plays named scenes on a build of the app in
Chrome. It reports the frame interval, the GPU time per pass, the tick's JavaScript time, hitches
with their cause, and the startup. Its usage, options, output, lock and exit codes are in its
header (`node tools/render/profile-frame.mjs --help --full`). This page covers the rest: the
scenes, the modes, how runs hold the GPU lock, and how to read the results. For the steps of
measuring a change, see the skill
[measuring-performance-changes](../../skills/measuring-performance-changes/SKILL.md) and its
[binding](../bindings/measuring-performance-changes.md).

Contents:

- [Scenes](#scenes)
- [The high tier's performance target](#the-high-tiers-performance-target)
- [Timestamps](#timestamps)
- [Modes](#modes)
- [A/B comparisons](#ab-comparisons)
- [Reading the results](#reading-the-results)
- [Display mode](#display-mode)
- [The GPU lock and the machine's load](#the-gpu-lock-and-the-machines-load)
- [Hangs, lost scenes and unfinished runs](#hangs-lost-scenes-and-unfinished-runs)
- [Browser and caches](#browser-and-caches)

## Scenes

Every scene runs its clock with a fixed weather, and the camera moves as in play: a slow orbit
around the target, or in place for the sky and meadow views. A paused scene settles its clouds
once and skips the clouds' ray march and the shadow map's stepped redraws, so it would measure
less than the scene costs. `--list` prints the scenes with their queries and views.

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

The scenes of the parked weathers (`packages/render/sky/Weather.ts` `PARKED_WEATHER`) are left out
of the default set and of the set `--accept` runs. `--scenes` selects them, and `?profile` makes
them load on a production build. The horizon views under cloud are where the low cloud deck's ray
march costs the most, since the sky fills half the frame there; `horizon-clear-noon` is the same
view without a deck. `meadow-close` places the camera on the camera controls' ground
(`controls.ground`). `weather-change` measures a weather front sweeping in, with its pipeline
compiles and bakes. Scenes with a weather change run last.

## The high tier's performance target

Measure a production build (`npm run build && npm run preview`, port 5191, the default URL). The
development server works for quick checks. The default viewport is a generic 4K display: 1920 by
1080 CSS pixels at a pixel ratio of 2.

The high tier is timed at its performance target (`packages/render/Quality.ts`): 4K output at
1440p's pixel count, upscaled by FSR 1, with MSAA 4x. A profile, `--compare` or `--toggle` run of
the high tier pins the render scale at the baseline of its dynamic-resolution rule for the
viewport, by adding a `dpr` to the query. That is `dpr=1.3333333333333333` at the default
viewport, and `dpr=1` at `--w 2560 --h 1440 --scale 1`, a 2K display
(`packages/render/post/RenderScale.ts` `dynamicRange`). So profiles and A/Bs measure at the level
every trade-off is judged at.

`--unpinned` keeps the tier's own rule, with the dynamic render scale adjusting itself. Add
`--scale-settle 5 --scale-log` to see where it settles. `--accept` (the frame rate a player sees),
`--display`, `--scales`, and a `dpr` in the URL or in `--q` are never pinned.

## Timestamps

GPU timestamps give the time per pass. With timestamp queries on, Chrome ran the same frames up to
a quarter faster: light scenes the most, a GPU-bound heavy scene hardly at all. So the split by
pass shows where the time goes, but not the frame rate a player sees. Take frame rates for final
numbers from a run without timestamps. An A/B in one mode cancels the bias.

- `--timestamps on` (the default): frame intervals and the GPU time per pass.
- `--timestamps off`: frame intervals only. This is the default with `--display`, as a player's
  page runs.
- `--timestamps both`: every scene twice, its frame intervals from the run without timestamps and
  its passes from the run with them.
- `--timestamps auto` (only with `--accept`, where it is the default): every scene without
  timestamps, then the scenes that did not pass again with timestamps.

A tier with a dynamic resolution keeps its own timestamp queries in every run, as a player's page
does. `--q gpuTimer=off` leaves them out.

When the frame rate is uncapped, the page runs about 120 frames ahead of the GPU, so a frame's
timestamps come back seconds later (a scene's `profiler.readbackMs`). The profiler waits for each
frame's own read-back, with no time limit. `missingPasses` counts only passes whose query was never
written or whose read-back failed. A run with `timedFrames` 0 is a bug, not a busy GPU.

## Modes

### Page mode

The default (`--mode page`) loads each variant once. Each scene is set up at runtime through
`window.__PONLAI__`, as its URL options would load it: the weather already established (wet in
rain), the time preset, the clock from 0, the camera view and its motion. The loop is stopped
meanwhile, so no frame mixes two scenes. The scene then warms up for `--warmup` seconds (1.5), and
until no pipeline has been created for a second. A new weather compiles its pipelines on first
use; that compile time is reported per scene, outside the measured window. Most of a page load is
the island's generation, so switching scenes is far cheaper than loading them.

### Reload mode

`--mode reload` loads a fresh page for each group of scenes that share a query, or for each scene
with `--fresh`. Its warm-up defaults to 3 s and its idle wait to 60 s. `--compare` then alternates
page loads in the order A B B A.

### Compare

`--compare urlA urlB` measures two builds. Serve the other build with
`node tools/kit/serve.mjs preview --sha`. See [A/B comparisons](#ab-comparisons).

### Toggle

`--toggle "js"` is an A/B inside one page. It is the fastest and most precise A/B, with no reload
and no drain. The expression runs with `s` = `window.__PONLAI__` and `on` (false for A, true for
B). It is applied every `--block` frames (60) in an A B B A B A A B pattern, for `--blocks` blocks
(8), after both states have warmed up. For example, `--toggle "s.water.mesh.visible = !on"`, or
`--toggle "s.flags.fastWater = on"` for an optimisation that reads a flag of
`packages/render/debug/DebugFlags.ts` (`fastWater` stands for the flag's name). Each frame counts
for the state its tick ran in. GPU figures drop the first 2 frames after a change, and frame
intervals drop the first `--lag` frames (30). Headless Chrome queues about two dozen frames, so a
change reaches the animation frame's interval that many frames later.

### Vsync

`--vsync` keeps Chrome's vsync and frame-rate limit (60 Hz headless), so the frame interval is what
a player sees: 16.7 ms while every frame makes its vblank, 33.3 ms when one misses. When the frame
rate is uncapped, a GPU-bound scene's p95 is mostly pacing noise: a sky view that holds 60 Hz under
vsync showed a p95 of twice that uncapped. With vsync, the queue stays shallow and the intervals
fall on vblanks.

### Acceptance

`--accept` implies `--vsync` and judges the 60 fps criterion per scene. In the run without
timestamps, the median and the p95 must be within half a millisecond of `--target` (16.7), with
no frame over 25 ms in the measured window (7 s by default). The p99, the maximum and the GPU busy
time from a run with timestamps are reported beside the verdict.

Other work on the GPU costs frames. A scene is contended when it was measured while something else
kept the GPU busy: either `--contended` was given, or a later page load found the GPU busy. A
contended scene that fails is INCONCLUSIVE, unless its own median GPU busy time is over the target,
which an idle GPU could not make up. A contended scene that passes is PASS (contended). Contended
here means that the run without timestamps was contended, since its frames are the ones judged.
The exit code stays 0 unless `--strict` is given, which exits with 1 on a FAIL.

On an idle GPU, the run with timestamps decides no verdict. It only turns a contended failure into
a FAIL. So `auto` runs it only for the scenes that did not pass, where the GPU busy time and the
passes explain the failure. A run where every scene passes has no run with timestamps, and holds
the lock exclusively for about half as long as `both`. A scene that passed then reports no GPU busy
time, no passes and no GPU hitches (its headroom under the frame). For those, `--timestamps both`
measures every scene twice; `off` never measures with timestamps.

Headless at 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames.
See [Display mode](#display-mode).

### Scales

`--scales 1,0.9,0.75` repeats the run once per render scale (the app's `dpr` option) in one
invocation, and gives a table of every scene at every scale. It shows the scale threshold at which
a scene holds 60 Hz, and the points where a dynamic resolution settles. The URL and `--q` must not
set `dpr` themselves, since the app reads the first of a repeated option. The app caps a scale
above the display's pixel ratio, and the run warns when the rendered pixel ratio differs from the
scale. With timestamps on, the high tier's reports add `gpuPixel`: the part of the GPU time spent
in passes that scale with the rendered pixel count (the dynamic resolution's split). Use it to fit
the dynamic resolution's cost model at fixed scales.

### Scale settle

A tier with a dynamic render scale (high) changes the scale according to the GPU's frame time.
`--scale-settle s` waits after each scene's warm-up until the scale has held for s seconds (at most
60), so the scene is measured where the scale settles. In `--compare`, each page settles after its
own warm-up. Every report gives the scale the measured frames were drawn at (its median, range and
changes) beside the frame times.

Without a settle wait, the high tier's scale stepped down from its nominal value within the first
slices of a run's first scene, on both pages. So `--display --compare` settles for 2 s by default.
In display A/As without it, both pages stepped down within their first slice but at different
times, which put a scale step into one side's measured frames and not the other's. With 2 s, no
scale change fell inside a measured slice. The wait costs a few seconds per page per scene under
the exclusive lock. `--scale-settle 0` turns it off. Every other run defaults to 0: headless A/Bs
are judged by the passes, and a scale step changes those on both sides alike.

`--scale-log` writes each page's dynamic-scale changes per scene to the output and to each scene's
`scaleLog` in profile.json. Each entry gives the time on the controller's clock, the scale before
and after, the rule, and for the GPU-time rules the predicted and measured 90th percentile. In
`--compare`, it also gives per slice how long the page was stopped, how far its controller's clock
moved meanwhile, and which of its timers ran out (holds, a failed step's bar, the contention hold).

### The remembered scale and the frame rate's fallback

The high tier starts from the dynamic scale it last held (`drsStore`; off in an automated browser
anyway). `--compare` and `--accept` load their pages with `drsStore=off`. So neither side of an
A/B (two anti-aliasing modes, two builds) starts from a scale that the other side or an earlier run
settled at. `--drs-store` loads them with `drsStore=on` instead, to measure a returning visitor's
load.

On a faster display, the frame pacer may step down from the tier's frame rate to the next divisor
of the refresh rate (72 to 48 fps on 144 Hz) when the dynamic scale's floor cannot hold the rate
(`packages/render/post/FramePacer.ts`). `--compare` and `--accept` load their pages with
`frameFallback=0`, so both sides hold one rate and stay comparable. `--frame-fallback` keeps the
fallback on. The app reads the option once at load, so it holds on a page kept open from scene to
scene. On the display, each scene reports its effective rate (rendered frames per second) and its
share of frames at the fallback rate. Late frames are judged against the pace each frame was
rendered at.

## A/B comparisons

`--compare urlA urlB` loads A and B once each, in two pages of one browser, and measures them in
alternating slices under the same conditions: `--slices` slices (8) in the order B A A B A B B A,
each `--slice` seconds long (1.5), after `--settle` seconds (1) at each switch. One page runs at a
time. The other is stopped: it requests no animation frames and does no GPU work. Its queued
frames and any sky bake are drained before the other page starts. Its camera and clock wait, and
so does its dynamic scale's clock (the debug hook `dynamicClock`), so its holds and bars do not run
out during the other page's slices. When both pages ran at once, Chrome let one page's frames
starve the other's queue.

The page that runs is brought to the front first, headless too. The two pages are tabs of one
window. A background tab still runs its frames (Playwright keeps it visible to the page), but they
are not presented, so it paces its frames differently. When the tab opened last (B) was left in
front, A/A runs on one build gave B a median frame interval 7-17 % longer with GPU timestamps off,
and longer still with them on. That was outside the 95 % confidence interval, with B's GPU busy
time unchanged, and an A/B read a build's gain as a loss. With each page in front while it runs,
the same A/As came out within their interval, with timestamps on and off. A/A runs (one build as
both A and B) are the check for any change to how the comparison runs.

Deltas are reported with their 95 % confidence interval from the slices' spread, and as a ratio
B/A, beside each page's render scale per scene. The high tier's dynamic scale can settle higher on
one side, which the load-time render scale in the summary's header does not show; read the deltas
with that in mind. Errors name their page (`pageerror (page B): ...`). `--eval-a` and `--eval-b`
run an expression in one page only.

Adaptive slices: `--slices` is the most slices a scene takes. From `--min-slices` on, a scene can
stop early. `--min-slices` is 4 with `--display`; headless, it defaults to `--slices`, which turns
early stops off. The stop check runs at the end of each balanced block of four slices (B A A B,
then A B B A, so a drift over the run stays cancelled). A scene stops once its leading delta's 95 %
confidence interval clears zero by `--stop-margin`, or is no wider than ± `--stop-width`. The width
test applies only with 4 slices a side, because with 2 a side the interval can come out narrow by
chance. The leading delta is the one the summary leads with: on the display, the share of late
frames (defaults 0.1 and 0.02); otherwise the GPU busy time with timestamps, or else the median
frame interval (in ms, defaults 0.2 and 0.05). The display's defaults come from a replay of
display comparisons, where early stops saved about a sixth of the slices and the late-frame
verdicts held, except for two borderline scenes. Headless, an A/B is judged by the passes, whose
deltas need every slice. The summary and each scene's `stop` in profile.json give the number of
slices taken and why. A stop decides on the leading delta only. The other deltas get fewer slices
and wider intervals, so a run whose passes or secondary figures matter sets `--min-slices` equal to
`--slices`.

## Reading the results

Base A/B decisions on GPU time, per pass and in total. It is measured per frame on the GPU's
timeline, and it converges in far fewer frames than the frame interval does. Take frame rates for
final numbers from `--timestamps off` or `both` (see [Timestamps](#timestamps)).

Each scene reports the frame interval's median, p95 and p99, the GPU time per pass, the tick's
JavaScript time, the hitches with their cause, the render scale the frames were drawn at, and the
startup. `--detail` adds each pass's own time, and `--raw` every frame. `--screenshots` saves a
JPEG of each scene after its measurement (in profile runs, not A/Bs). A scene measured while
something else kept the GPU busy is marked `(contended)` in summary.md's table, in a comparison as
in a single profile.

`--eval` runs in the page for every scene, after its camera is placed and before its warm-up, with
`s` = `window.__PONLAI__`. Use it for an ablation, for example
`--eval "s.water.mesh.visible = false"` or `--eval "s.pipeline.settings.bloom = 0"`. A URL's own
query options take effect first, so `http://host/?profile=frames` runs that side without
timestamps. `--hooks off` leaves out `?profile` (frame intervals only, as for a build without the
profiler). Older builds ignore options they do not know, and where they lack the tool's runtime
hooks, the tool drives their debug handles directly.

`--report <dir>/profile.json` renders summary.md again from a finished run, after a change to the
report.

## Display mode

Headless at 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames.
Every scene once passed headless while a 120 Hz display showed an uneven cadence and a restless
dynamic scale under a player's camera drags. `--display` measures that on the real display, in a
headed browser. It needs the display gate (`tools/kit/display-gate.mjs`; [GPU lock](gpu-lock.md)).
Run headed only for what a screen alone shows: frame pacing and cadence, late frames, the frame
pacer's rate, and the dynamic scale under a player's drags. Measure GPU cost and tune settings
headless.

Chrome (the system's Chrome, without the switches the headless runs use) opens full screen
(`--kiosk`) at the display's own size, pixel ratio and refresh rate, so a 120 Hz display runs
animation frames at 120 Hz. `--window WxH` opens a normal window of that outer size instead, as a
player's would be, with its tab strip and toolbar and the other windows on screen. The camera is
dragged like a player's through Chrome's input for `--seconds` (20) per scene. That is
`--motion user`, the default here, which loads the pages with `cameraInput`: drags of 30 to 200
deg/s with pauses, a wheel zoom and a flick. `orbit` keeps the slow orbit, and `none` holds the
camera still. If a drag loses its pointer to an event the run did not send (the system cursor's
events, which reach the headed page), the run presses again and logs it.

Besides the usual figures, each scene reports, counted in display refreshes, the intervals between
the frames the scene rendered and between the frames the compositor presented (from a trace of
Chrome's frame pipeline). It also reports the share of intervals that change cadence (judder at a
steady pace), and how much the camera's turning speed changes from frame to frame while it turns.

A window covers the screen while the run lasts. Keep the runs short (at most 3 scenes), and close
other pages and animated windows. The window server itself took 15-30 % of the GPU's time during
these runs. Full screen hides the other windows, and they stop drawing. In a window they stay on
screen, and a page drawing in one of them (an app's hidden browser pane rendering a second page)
shares the GPU and lowers the high tier's render scale. Such a pane took a tenth of the GPU beside
a window, and a hundredth behind full screen.

Bringing a page to the front gives Chrome the keyboard focus, so keys typed for another window
reach it. Every page of a `--display` run stops key events (keydown, keyup, keypress) on the window
in the capture phase, before the page's own listeners; the tool sends no keys. Pointer and wheel
events stay open for the drags.

### Display compare

`--display --compare urlA urlB` interleaves A and B in the same slices as the headless comparison,
so the drift between separate headed runs (a millisecond or two) cancels. The running page is
brought to the front, since a background tab gets no animation frames. The drags run in the
measured slices only. Each page's drags continue from where its last slice left them, so the k-th
slices of A and B see the same motion from the same view. The screen changes to the other page's
view at every switch; this is expected.

A scene switch never shows the previous scene. Each page switches with its loop stopped, out of
sight, and starts before it comes to the front, so its first frame on screen is the new scene's.
However, Chrome shows a page that comes to the front with the surface it kept when it last went to
the background, for about a frame. So, when a page leaves the front for the last time in a scene,
it does so under a cover (opaque, in the loading screen's colour). It shows that cover when it
comes back with the next scene, and drops it once it has drawn a few frames under it. The cover
goes up and down outside the measured windows. On screen, it shows for a frame or two at each
scene switch, and once inside every scene but the run's last, where the page that ends its slices
first leaves the front.

The summary adds the share of late frames per slice as a delta with its interval. A late frame is
a presented interval longer than the pace the frame was rendered at (the frame pacer's divisor at
the time). The summary also gives each page's frames over 25 ms, its effective rate (rendered
frames per second) and its share of frames at the pacer's fallback rate. One trace spans a scene's
slices of both pages, since Chrome traces one session at a time. It is split by a performance mark
per slice, and ended early at each adaptive stop check. A trace per slice nearly doubled the time a
slice took beyond its settle time and measured window. The run log gives each scene's time spent
in its settles and slices.

## The GPU lock and the machine's load

The run holds the [GPU lock](gpu-lock.md) exclusively only for what it measures. It opens no
browser while it waits in the queue, because a headed window must not sit on the screen, or close,
while the request waits.

- Preload: a build this browser profile has not loaded yet (a new bundle, port or browser version)
  is first loaded once in a browser opened inside a shared slot of the lock, and closed before the
  slot is released. The loads under the exclusive lock then find the world cache and the shader
  cache warm. The preload is skipped when no slot frees within `--preload-wait` seconds (60). On a
  cache miss, the app generates the island: seconds when the CPU is idle, a minute under a busy
  CPU.
- Under the exclusive lock: the idle check, then the browser's launch, each load, and each scene's
  switch, warm-up, scale settle and measured window. The pages' loops stop before the lock is
  released. The GPU name, the files and the browser's close come after the release.
- A run with several scenes holds the lock one scene at a time, in every mode. Before a scene's
  warm-up it requests the lock; after the scene's last slice, its pages stop and drain. The pages
  and the browser stay open with their loops stopped, so they draw nothing while another job has
  the lock. The hold is a lease (`leaseGpuLock` with `keepPlace`). The run keeps it from scene to
  scene while no request ranked before the run's first request is waiting. Otherwise, it gives the
  lock up and at once requests it again under that first request's ticket number. So queued
  captures run between the scenes instead of after the whole run, and a timing run of the same
  [level](gpu-lock.md#the-queue-and-the-levels) queued meanwhile still goes after this one. The
  first scene's hold covers the page loads.
- profile.json's `wallSeconds` is the time under the exclusive lock, with `lockWaitSeconds`,
  `totalSeconds` and `preload` beside it. `meta.holds` lists each scene the lock was taken again
  for: its wait, and the GPU's idle state with this run's pages stopped. summary.md shows the same
  under "Lock". The run's last lines give the time held and, separately, the total time without
  the waits for the lock.

### Idle checks

Before it measures, the run checks that nothing else keeps the GPU busy: the GPU's utilisation must
fall below `--idle-threshold` (15 %). If another client still keeps it busy after `--idle-wait`
seconds (20; 60 in reload mode), the run names the client, measures nothing, releases the lock and
exits with 3: a contended run's frame rates and verdicts prove nothing. Stop the client and run
again, or pass `--contended` to measure anyway, with the results marked as contended. The opening
check also counts as the first load's check. A later page load that finds the GPU busy still marks
its results as contended. When the run takes the lock again between scenes, it checks the GPU too.
If the GPU is still busy after `--idle-wait`, the run stops with the finished scenes written and
exits with 3, unless `--contended` is given (then that scene is marked as contended).

In full-screen `--display`, the checks run with the run's window up (the opening check on its
blank page). They sum the GPU time of the clients other than the run's Chrome and the window
server (WindowServer). Full screen hides the other windows and they stop drawing, so the
utilisation measured before the window opened counted a load the run never meets. With `--window`,
the check stays the utilisation check, since the other windows stay on screen and their load is
real.

### Load timeline

The idle checks see a few seconds before a load or a scene; the load timeline sees the whole run
(macOS; `tools/kit/load-timeline.mjs`). From the moment the exclusive lock is held to the end of
the run, one streaming `top` and a loop of one-second GPU client samples write `<out>/load.jsonl`,
one line a second: `{ t, cpu, gpu }`. Each figure is given by group: `run` (this run's Chrome and
its descendants), `windowServer`, `app` (the desktop app), `otherChrome`, `kernel` (CPU only) and
`rest`. `t` is in ms since the epoch (a page's frame time plus its `performance.timeOrigin`).

Each measured slice (a comparison's slice, a toggle's block, a profile scene's window) gets
`load: { cpu, gpu }`: the mean load from outside the run over its window. That is every group but
`run` and `windowServer`, which composites the screen for every run. A slice whose outside GPU mean
exceeds `--idle-threshold` is contended. A scene with more than a quarter of its slices contended
is marked as contended, with the verdict rules of [Acceptance](#acceptance). The summary's "Machine
load outside the run" gives each scene's contended slices and mean outside load.
`--load-timeline off` turns the timeline off.

## Hangs, lost scenes and unfinished runs

A hang loses one scene, not the run. A scene that shows no progress for `--hang` seconds (180) is
recorded as hung (profile.json `meta.hung`, and a section of summary.md). The record gives the step
it was at: in a comparison, the load, warm-up, slice, trace end or results; at a scene's start,
the halt, the cover, the lock's wait or its idle check. It also gives what each page was still
doing: whether it was answering and visible, and its animation frames and scene frames over a
second. A scene is lost the same way when its browser or page closes or crashes under it (a headed
window closed, Chrome gone), or when its setup or camera placement throws in the page
(`meta.hung[].failed` gives the error). In each case, the browser is closed (killed if it is still
open after 30 s, so it neither runs on nor holds the browser profile) and opened again, and the run
goes on with the scenes not finished yet. A second hung or lost scene stops the run, with the
finished scenes written. A run that makes no progress outside a scene for longer than `--hang` plus
a minute exits with 1 and releases the lock.

Each scene's results are also appended to `<out>/scenes.jsonl` as the scene finishes, and the meta
data known at the start goes to `<out>/meta.json`. So a run that dies for another reason still
leaves what it measured. `--report <dir>` (or `<dir>/scenes.jsonl`) on a folder without a
profile.json (a run that crashed, was stopped or was handed back) rebuilds summary.md from them,
with the reports a finished run uses: A/B deltas and their intervals per timestamp mode, a
profile's tables and verdicts, and the load table from `load.jsonl`. The summary says the run is
unfinished and lists the scenes left out for a missing variant or timestamp mode; it writes no
profile.json. Without `meta.json`, what the scenes do not record shows as `?`. `--report` opens no
browser and takes no lock.

A page paused or pinned during the run stops the run the same way. Each page's `clockPaused` and
`scalePinned` (diagnostics) are read at its load as its baseline (`?dpr` pins legitimately), and
again after every slice or measured window. A change means a key press or click reached the page.
A Space press pauses it, and a paused page renders at its nominal scale and stops adjusting the
scale. That spoils every scene after it, since a scene switch leaves the pause in place. The run
stops with the finished scenes written (`meta.spoiled`, and a section of summary.md) and exits with
1; the message names the page, scene and slice.

## Browser and caches

Chrome comes from `CHROME_PATH`, else the system Chrome, else Playwright's Chromium, with a browser
profile of its own kept between runs (`--profile-dir`). Every page keeps the generated island's
chunks in IndexedDB in that browser profile while the generator's sources are unchanged. Builds
that predate the cache load it only with `?worldCache`, which is added to every URL.
`--world-cache off` loads with `worldCache=off` instead, so the island is generated as on a first
visit. The run does not launch on a browser profile that another Chrome holds (another run's): it
takes a temporary one, with cold caches.
