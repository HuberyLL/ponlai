# Ponlai: tools and URL options

The manual of the page's URL options and of the tools under `tools/`. `AGENTS.md` lists the
everyday commands; this file has the details. Each tool's own file says the rest.

## Page

- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191, the production build). Build and typecheck run tsc and vite with
  the application policy on macOS (Process priority, below).
- The islanders load from the git-ignored `artifacts/assets/`, which only the dev server serves: a
  production build (a preview, a worktree's) needs them linked into `dist/` after each build
  (`tools/parity/README.md`, setup), or its page stays on the loading screen.
- `window.__PONLAI__` (scene handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the
  dev server or with `?debug` (or `?profile`, which also loads the frame profiler).
  `__PONLAI__.loop.step( { frames, dt, scale, camera, onFrame, clock, converge } )` stops the live loop and
  steps the tick itself with fixed timestamps, the frame pacer and the dynamic scale bypassed and
  nothing taken from the wall clock (`loop.start()` resumes the live loop); the diagnostics add
  the scene's anti-aliasing (`aa`), the pipelines created so far (`pipelines`, counted by
  `src/debug/PipelineCounter.ts`) and `graph` (the frame graph's dev counters: the attachment
  ops it rewrote and expected in the last frame, the frames they differed, targets found at a
  size other than their class's).
  `__PONLAI__.establishScene( query )` jumps to a whole scene in place, as a fresh load of
  `?<query>` would draw it (weather, day clock, moon, scene clock, camera; the leftovers of the
  scenes before cleared; load-time options must match the page's): one page can capture a whole
  set (contract in `src/main.ts`, check in `tools/verify-scene-jump.mjs`; `__PONLAI__.sceneJump`
  = 1 marks the exact jump for the capture tools).
- `__THREE_GAME_DIAGNOSTICS__.settled` (updated every frame, every anti-aliasing mode): true once
  the paused page will draw the same frame from now on, so a capture can wait for it instead of a
  fixed time or frame count (`src/post/Settled.ts`). It reuses the temporal rest's key (camera,
  scene clock, render and output sizes, epoch: `TemporalRest.ts`) and holds once that key, the
  sun maps' redraw counts and a forced strike have stayed the same for the tier's `restSettle`
  frames (8) while no sky bake or transition is in flight, nothing is pending (a periodic bake
  due, the refracted sun's map behind its light, a queued sun shadow redraw, an async pipeline
  compile) and the loading screen has faded out; under taa / taau / gt the temporal rest must also
  have converged on quiet frames only. Any change of the key (a camera move, a resize, a seek,
  `establishScene`, any scene event, which now bumps the epoch under MSAA too) turns it false.
  `settle` says why not: `frames` of `need`, `stable`, `shown`, `pending` (names), `since` (the
  frame it turned true), and under the temporal modes `stale` (the rest converged over a refresh:
  bump the epoch, `__PONLAI__.taa.epoch.bump()`, and wait again).
- Keys: H toggles the GUI, Space pauses, R or 1/2/3 jump to the island, horizon and sky views, F
  toggles a corner readout of the frame cadence.
- The island camera (`src/camera/IslandCameraControls.ts`): a left drag grabs the ground, a right
  or middle drag (or Option / Ctrl with the left) turns and tilts, the wheel zooms toward the
  pointer; on a trackpad a two-finger swipe pans, a pinch zooms and Option with a swipe turns and
  tilts; W A S D or the arrows pan, Q / E turn, T / G tilt, + / - zoom, Shift speeds them up.
- The GUI's Performance folder (`src/debug/FrameStats.ts`, from the rendered frames' rAF
  timestamps) shows the frame rate over the last second, the interval's p95 and maximum over the
  last 5 s, the frames late by a refresh against the paced interval and the intervals over 25 ms
  since the scene showed (or the reset button), the render scale and the GPU's median frame time
  (high only), and how the quality tier was chosen with the numbers behind it.

## URL options

View and capture:

- `paused`, `t` (scene time), `dpr` (render pixel ratio, pinned), `dist`, `polar`, `az` (the
  camera), `gui`, `camera` (`orbit`, the default: the island camera; or `free`: fly with the
  mouse, WASD, Q/E and Shift). A paused page lifts its loading screen at once, without the fade,
  so a capture of a paused frame never catches the screen over it.

Sky and weather:

- `hour`, `preset` (dawn, sunrise, noon, golden-hour, sunset, dusk, midnight), `dayLength`
  (seconds), `moon` (phase), `clock=paused` (freezes only the day clock; `paused` freezes it with
  the scene).
- `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load as established,
  already wet; without it the weather evolves on its own), `clouds` (coverage override).

Quality and look:

- `quality` (low, medium, high: the tier of every knob in `src/Quality.ts`; without it the tier
  measured for this GPU, `src/QualityDetect.ts`), `tier.<knob>=<value>` overrides one knob for an
  A/B (e.g. `tier.post.fogScale=0.5`).
- `autoQuality` (`detect` measures again, `off` keeps medium), `autoQualitySlow=<factor>` (scales
  the measured GPU time, to try the choice a slower GPU gets).
- `tone` (neutral-hue, the default, agx-hue, agx, neutral), `look` (soft-fantasy, the default,
  rich-fantasy, realistic).

Rendering and A/B options, read at load (runtime switches for one-page A/Bs live in
`src/debug/DebugFlags.ts`):

- `aa` (the anti-aliasing mode, `src/post/Antialiasing.ts`: `msaa`, 4 samples, or `off`, one
  sample, over the tier's `aa` knob; `taa` and `taau`, the temporal modes, from the URL only: one
  sample, jittered, with motion vectors, resolved against a history in `TemporalAA.ts`, at the
  render's size or upsampled to the canvas; a paused page shows the rest image, the jitter
  sequence averaged, once it has converged, `TemporalRest.ts`; what changes the scene raises a
  scene event, `SceneEvents.ts`, which restarts the rest and may cut the history: the diagnostics'
  `taa.lastEvent`, and `__PONLAI__.taa.restart()` by hand) and its older alias `msaa` (`4`
  reads as `aa=msaa`, `1` and `2` as `aa=off`, since WebGPU multisamples with 1 or 4 samples
  only).
- `aa=gt` (debug builds only; refused with a warning otherwise): the ground truth the temporal
  modes are measured against: the temporal graph at the canvas's resolution, no dynamic scale,
  whose rest averages `tier.taa.gtJitters` jittered frames (64 by default, 32 per frame of a
  motion clip) with a box filter, without the sharpening or the grain (the dither kept).
  `loop.step`'s `converge( i )`, where it returns true, holds the scene after frame i's tick and
  renders it until the rest has converged; `tools/capture-clip.mjs --aa gt [--gt-jitters n]` captures it that way,
  and so does a clip of one frame (`--clip rest`) under `aa=taa|taau` (their own rest sequence).
  After `loop.step`, `loop.start()` resumes the clock with a first delta of at most one frame.
- `taaResolve=off` (debug builds): the temporal modes without their resolve, the jittered frame
  shown as it renders, through the output passes with the grade's vignette and grain.
- `worldCache=off` (generate the island instead of loading it from the browser's IndexedDB cache,
  as on a first visit).
- `terrainHex=0` (the cliff's plain triplanar tiling and smooth layer masks; for an A/B inside one
  page each cliff material swaps to its other variant through `material.userData.terrainVariant`,
  as `TerrainMaterial.ts` shows: the flag itself is read only when the material is built).
- `post=legacy` (or a comma list of `inline-composite`, `full-fog`, `no-bank`, `inline-coc`,
  `three-fsr`, `store-scene`: the frame graph without the first performance round's changes).
- `shadowFilter=legacy|sl1|sl1,sl3` (the sun shadow's filter path).
- `gpuTimer=off` (high's dynamic resolution without its timestamp queries: it then steers by the
  frame intervals).
- `drsStore=on|off` (whether high starts from the render scale it last held, kept in localStorage
  per tier, AA mode, frame rate, canvas size and GPU, and saves the scale it holds: on by default,
  off in an automated browser so a profile or capture does not start where the last run ended;
  `on` tests a returning load there, `off` neither restores nor saves anywhere).
- `frameRate` (the frame rate the loop holds on a faster display, over the tier's; `frameRate=0`
  renders on every refresh, as the profiler's uncapped runs do).
- `submits=each` (three's own submit per pass, without the submit batching; at runtime
  `flags.batchSubmits`; its tracking wrappers stay installed, so compare against `main` for their
  JS cost) and `submitBatch=hold,wait,idle` (its policy, see `SubmitBatch.ts`).
- `fgOps` (the frame graph's attachment ops: `derived`, the default, per frame from the passes
  that run; `legacy`, the scene target discarded in the rain only; `store`, every store and
  resolve kept, also what `post=store-scene` and `post=legacy` choose; `off`, three's own),
  `fgPrime=0` (the warm-up renders nothing ahead, see `src/post/graph/FrameGraph.ts`).
- `fgview=<resource>[.<output>]` (debug builds: the frame graph's debug view draws one of its
  resources over the canvas, shown by what it holds, e.g. `linearDepth`, `fogMarch.a`, `FSR.easu`;
  outputs `r` / `g` / `b` / `a`, `previous`, a depth's `sample<n>`; under the temporal modes also
  `class`, `reactive`, `reproject` and `reproject.diff`, views of the motion vectors, and the
  resolve's decisions: `weight` (the history's share of the resolved pixel, black: this frame
  alone, white: all history), `disocclusion` (red where the point was hidden in the previous
  frame, green where it was off screen, blue where the history was reset) and `clip` (how far the
  history lay outside the neighbourhood's clip box, white at twice its width);
  `src/post/graph/DebugView.ts`; also the GUI's Debug folder, which reloads;
  `s.pipeline.graph.describe()` and `dot()` list the graph).
- Under the temporal modes `flags.mv.camera` / `object` = false leave a source out of the motion
  vectors, `flags.jitter = false` the jitter, `s.taaCut( reason )` cuts the history and
  `s.motionCheck()` lists the materials whose motion vectors are missing or partial.
- `vegPrepass=0` (the single coverage pass), `vegPrepass=coverage` (the prepass with coverage kept
  in the shaded draw), `windLegacy` (the old global-sine sway).
- `islander` picks the islanders' proportions (`medium`, the default, or `stock` (the kit's own),
  `subtle` and `strong` builds of `Proportions.ts`); also in the GUI's Islander folder, which
  rebuilds the scene's walker in place. In game mode the folder's proportion control is disabled:
  the game's islanders take their build from the URL option as they load, so a change applies on
  the next load.
- `profile` (`?profile`, or `?profile=frames` without GPU timestamps) loads
  `src/debug/FrameProfiler.ts`, which labels every render and compute pass, reads their GPU
  timestamps and exposes `window.__PONLAI_PROFILE__`; without it the page builds the same
  pipelines and image. Its JS times leave out the time blocked in `queue.submit`, the queue writes
  and `getCurrentTexture` (Chrome's backpressure once the GPU falls behind), reported apart.

Game:

- `game` (the island as a game), `hour` (the start hour, default 8), `dayLength` (real seconds
  per game day at 1x, default 1440: 24 minutes), `paused` (the game starts paused; the scene runs
  again once the game does), `load` (resume the game saved in this browser). The page's own
  `weather` option and auto weather work in the game as without it.
- The player's interface is a prototype HUD (`src/game/Hud.ts`): a readout of the islander (day
  and time, satiety and hydration, the bag, what they are doing, each unbuilt site's progress in
  percent, the last words said and how the last action ended) and a "Place chest" button that arms placement: a ring on the turf
  previews the spot (green, or red with the reason), a click places it, Escape cancels, and the
  control is gone once the chest is placed (`src/game/Placement.ts`). Space pauses only the game
  clock, the GUI's hour, clock pause and time preset are off (the game's clock owns the time of
  day), and its Game folder (`src/game/GameDebug.ts`) sets the speed and pauses, saves and loads, shows one islander's body
  (position, the action under way, whether a thought is in flight) and sends it walking to the
  next click on the island. The stand-in brain (`src/game/sim/standin.ts`) thinks for the islander
  by default. `window.__PONLAI__.game` is the Game for the console: `.sim`, `.tools` (the five
  actions), `setBrain( brain )` (kept across a load; `null` leaves the islander idle),
  `think( id )`, `walkTo( id, x, z )`, `placeBlueprint( kind, x, z )` (a building of a kind,
  `'chest'`, any number, each with an id like `chest1`; returns why not, or null), `focus( id )`, `setSpeed`, `togglePause`,
  `save` and `load`.

## Captures

`node tools/capture.mjs <name> [--w 1672 --h 941] [--q "paused&t=12&dpr=1"] [--eval "js"]
[--verbose]` takes a screenshot of the running dev server into `artifacts/captures/`
(git-ignored) and prints frame diagnostics. It needs Playwright's Chromium once
(`npx playwright install chromium`), or `CHROME_PATH` set to a WebGPU-capable Chrome.

Captures and clips run in "fast mode" (`tools/capture-browser.mjs`): the browser runs in a
persistent profile slot, `artifacts/.capture-profiles/<browser build>/<n>` of the main checkout
(one browser per slot, each with its own lock; `PONLAI_CAPTURE_PROFILES` moves them; safe to
delete), so the world cache and the GPU shader cache hit from the second capture on. A paused
capture is shot once its image stops changing: grabbed every 2 frames from the frame after the
evals, shot when a comparison found no pixel changed (after 40 frames, at most 5000
changed pixels count as unchanged; after 120 the view is shot anyway, marked `capped`). A paused
temporal page (taa, taau, gt) is not compared: it is shot once its rest has converged
(`TemporalRest.ts`), and the `--stable-*` options do not apply to it. Every capture waits for the
loading screen's fade-out to finish (its computed opacity 0), not only for its `done` class: a
shot during the fade has the screen blended over the whole frame.
Replayed over per-frame traces of the 24 parity views, these defaults shot no load early and every
one on its settled frame. The capture's JSON records it as `ready` (`--stable-*` options in `tools/capture.mjs`, the rule and its
evidence in `tools/capture-browser.mjs`). `--ready-frames n` waits for a fixed count instead, as a
running capture does (60); `--wait` / `--settle` ms add fixed delays. The frame loop is stopped
and the GPU queue drained before the shot. The shot is the compositor's image through CDP with
Chrome's fast PNG encoder (0.26 s instead of 1.3 s at 3456x2234): the pixels of Playwright's
screenshot, not its bytes, so the tools compare captures by decoded pixels. A paused capture takes
about 5-7 s alone.

Check visual changes with captures, compared against the previous capture (and crops, not only
the whole frame); report measured differences. `tools/img.py` does the image work around
captures (`uv run tools/img.py <cmd>`: its dependencies are inline, no system Pillow or NumPy
needed): `diff` (two images or two directories: max, mean, pixels over levels, signed bias, luma
change, bounding box, `--heat` map), `crop` (boxes or a capture's named anchors, `--zoom`),
`sheet` (a labelled grid of images, directories or crops, `--diff` for A | B | diff) and `stats`
(mean RGB, luma, percentiles per image or region); regions are `--box x,y,w,h` or `--anchor
name|all` from the capture's JSON. Its numbers are diff-set.py's and compare-captures.py's
(shared helpers in `tools/parity/pixels.py`). `tools/compare-captures.py` measures two overview
captures (`uv run --with numpy --with pillow`).

`tools/parity/` captures a fixed set of paused views with named 1:1 crop anchors
(`capture-set.mjs`) and diffs it against a reference set, pixel for pixel or within the reference's
own repeatability (`diff-set.py --aa-floor`; see its README). Temporal AA sets (taa, taau) do
not repeat pixel for pixel and are judged by a tolerance instead (`diff-set.py --temporal`: shares
of pixels over a level on the frame, in local windows and on the crops, a bound on coherent sub-level
shifts, and one recapture before a failure counts; thresholds in `tools/parity/tolerance.py`).
capture-set opens one page per set (one per `--jobs` worker) and reaches every view after the
first by the exact scene jump (`__PONLAI__.establishScene( <the view's query> )`, then the view's eval
and the usual readiness): only load-time options (quality, aa, size and dpr, debug switches) need a
new page, and a set shares them. Views need not be views.mjs's: `--view "name:query[::js]"`,
`--views-file f.json` and `--sweep "key=a,b,c"` (each view per value, e.g. `--sweep
weather=fair,rain --sweep hour=7,12,17`) capture ad-hoc views through the same pages, jump and
readiness (and `--quick`, `--reference`, `--check`); use them instead of a script that loops
capture.mjs over views, which loads a cold page per view (`tools/parity/adhoc.mjs`, the README's
capture-set). Builds without the jump's marker (`__PONLAI__.sceneJump`, older
commits) get a page per view, as `--page-per-view` forces; a failed view or a lost page is retried
and the rest of the set goes on in a fresh page. `--repeat` takes the repeats on other pages, in
reverse order.
`tools/capture-clip.mjs` captures a named clip (`tools/parity/clips.mjs`: a parity view set in
motion, its camera path a function of the frame index) frame by frame with the page's stepper, as
crops that follow their subjects, and `tools/clip-metrics.py` measures a clip against MSAA and a ground truth (`--aa gt-hi`: MSAA at
twice high's nominal ratio, downsampled) with gates from a thresholds file
(`uv run --with numpy --with pillow`, clip-metrics.py also `--with scipy`; both described in the
README). clip-metrics.py measures the
frames in worker processes: `--workers N` or `CLIP_METRICS_WORKERS`, by default a quarter of the
CPUs within 1 to 4; the output does not depend on the count.
References are stored per commit and shared (`tools/parity/reference.mjs`): `capture-set.mjs
--reference <root>/<sha>/<set>` and the baseline's and ground truth's entries of
`tools/parity/baseline.mjs` reuse a stored reference whose manifest (`complete.json`, written
last) matches the capture tools' version, the browser build and the options, wait for another live
process that is capturing it (freeing the GPU slot of a `run --shared` wrapper meanwhile), and
otherwise capture it and say why (missing, tools or browser
changed, a capture left unfinished). A capture set stored under another browser build only (an
auto-update) is verified instead: three of its views captured with the new build and compared
(decoded pixels, or the temporal tolerance), the set reused when they match. `capture-set.mjs <testUrl> <testDir> --check
<root>/<sha>/<set> [--ref-url U]` captures only the test side and diffs it against the stored
reference. Layout, manifest and rules: the README's Reference store.
For tuning, `capture-set.mjs <url> <outDir> --quick --views a,b [--crops x,y] [--variant
"[label::]js"]... --store <root>/<sha> [--ref-url U]` loads one page per view, shoots the base and
then each variant (js run in the page, ready again, shot: crops only, `--full` for whole frames)
and measures the crops against the store's MSAA and ground-truth rest entries of that commit
(clip-metrics.py), a short table per variant. It is not a gate; details in the README's Quick mode.

`baseline.mjs ... --carry-from A` takes the baseline's and the ground truth's entries over from an
earlier commit A instead of capturing them, when `tools/parity/carry.mjs` finds nothing between the
two that could change them (same build inputs; otherwise the diff against two watch lists, the
paused set S1 matching A's (and A's stored rest frames matching A's own S1), the first 16 frames of two clips and one rest ground truth captured
again and compared); an entry that may not carry is captured and the log says why.
`node tools/parity/carry.mjs check --from A --to B [--url U] [--all]` prints the verdict alone.
Rules and proof: the README's Carry-over.

## Probes

`node tools/probe.mjs [url] [--q query] [--query q]... --eval js [--until js] [--frames n]`
answers a question about the running page without a Playwright script of one's own: it loads the
scene in the capture tools' browser (headless, a warm profile slot; `--fresh` for a cold load),
holds a shared GPU slot from the load to the end (`--exclusive` for frame times), runs the steps in
the order given and prints JSON (per query: load or jump, the time until up, each step's value,
console errors and failed requests). Each `--query` after the first is reached in the same page by
the scene jump. Evals see `P` (`__PONLAI__`), `D` (the diagnostics), `frames( n )`, `sleep( ms )`
and `until( fn )` (`D` is rebuilt every 30 frames: live counters such as `P.pipelines.total` come
from `P`); `--init js` hooks the page before its scripts run. A production preview needs
`debug` in the query. Common questions:

- diagnostics and load timings: `--eval "D.timings" --eval "D.worldCache"`;
- a uniform or a setting: `--eval "P.shared.wetness.value"`, `--eval "P.camera.position"`;
- the pipelines an action creates, on a paused page (`D.settled` never turns true on a running
  one): `--q "debug&paused" --until "D.settled" --eval "P.pipelines.total"
  --eval "P.setWeather( 'storm', 0 )" --frames 120 --eval "P.pipelines.total"`;
- the game: `--q "debug&game" --eval "P.game.sim.state.villagers[ 0 ]"`;
- frame time: `--exclusive --q "debug" --frames 300 --eval "D.frameMs"` (profile-frame for A/B).

Steps, scope, the value's serialisation and the exit code are in the file's header.

## GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes the
machine-wide GPU lock in `tools/gpu-lock.mjs`: timing runs (profiles, benchmarks, running captures)
hold it alone; paused captures and the verify probes share it with each other, since their pixels
do not depend on the load. Shared holders take one of `PONLAI_GPU_SLOTS` slots (default 3) and the
rest queue first in, first out: captures are GPU-bound, so past 2-3 pages at once only each page's
latency grows. A capture-set page leases its slot (capture.mjs's worker, `leaseGpuLock`): it keeps
it from view to view and gives it up between views only when someone waits for it (an exclusive
request past its cap, below, or a shared one when every slot is taken) and it has held it for its
lease, 20 s (capture.mjs `--lease`, after capture-set's `--`; 0 frees it after every view), so a set
behind back-to-back timing runs advances about four views per run instead of one, and a timing run
past its cap waits at most 20 s plus the view in flight for it (a low page gives its slot to a
normal shared request at the next view); capture-clip.mjs holds a slot per clip. A capture that
loads a page (capture.mjs, and the first view of a capture-set page) takes its slot only once the
page has generated its world: until then it holds the page's GPU device back (the page waits in
`requestDevice`), so the world's CPU work in its workers (tens of seconds when it is not cached)
runs without a slot and without GPU work, and the slot covers the GPU set-up, warm-up and shot (a
page that does not mark its world, `window.__PONLAI_WORLD__`, takes it at the renderer's start). Under a
`run --shared` wrapper the first capture takes the wrapper's slot over and the wrapper holds nothing
from then on, so a wrapped orchestrator never holds a slot its own captures wait for. Exclusive and
shared requests wait in one queue, shared first: a shared request joins whenever a slot is free,
even with an exclusive request queued ahead of it, and an exclusive request takes the lock only
when it is really free (no holders, no shared request waiting); exclusive requests go among
themselves in arrival order. One timing run waiting is cheaper than a queue of agents waiting.
`PONLAI_GPU_EXCLUSIVE_MAX_WAIT` seconds (default 1800) after an exclusive request queued, it stops
the shared requests queued after it, waits for the holders to drain and goes next, so a timing run
waits at most about 30 min plus one hold while captures keep arriving. A killed holder's slot frees
itself at the next look, and a killed request leaves the queue. Every session's work runs at the
same class, normal: leave `PONLAI_GPU_PRIORITY` unset (a lower class made one session's agents wait
behind everyone else's, which costs as much as anyone's wait). The lock still has a low class,
`PONLAI_GPU_PRIORITY=low` (inherited by every child, so set on the outer command), for a run that
should only fill slots nobody else wants: a free slot goes to the oldest normal request first and to
a low one only when no normal request waits; holders are never preempted and exclusive requests
ignore the class. A low request ranks as a normal one from its original place
after `PONLAI_GPU_LOW_MAX_WAIT` seconds (default 600, so it never waits for ever; the reason is in
the module's header).
`node tools/gpu-lock.mjs run [--shared] [--label x] -- <command ...>` wraps any other script,
`status` names the holders (shared: their slots and classes), the queue in turn (each with its
estimated start, below) and the exclusive requests in turn (`waiting`), and `gpu` shows the GPU's
utilisation and the processes using it. A request that waits prints a timestamped line
every 30 s: its place in the queue, the next in turn, who holds the GPU (the exclusive holder or
the shared slots' labels) and why it waits (an exclusive request past its cap first, low priority,
or, for an exclusive request, shared requests first until its cap), and,
when it starts waiting and whenever the figure moves by more than a minute or a quarter, its
estimated start: `estimated start in ~12 min (range 7 min-25 min, estimate)`.
The estimate is also in `status` (`eta: { startIn, range: [ lo, hi ], basis }` on every queued
request, in seconds from now) and in `node tools/gpu-lock.mjs eta [--shared|--exclusive] [--class
low|normal] [--json]` for a request made now (`--pid p` for a waiting one). It is an estimate, not
a schedule: the queue is run forward under the lock's rules 200 times, each hold lasting a duration
drawn from what holds of that kind took (the log's recent releases of the same tool and mode,
`profile-frame` per mode; a built-in table until the log has five of a kind: `basis` counts which).
`startIn` is the median start over the runs and `range` its 10th to 90th percentile. Requests made
later are not foreseen, so a low request can start after its range when normal work keeps
arriving, and an exclusive request after its range when shared work keeps arriving: its eta's
`capIn` (and the line's "shared requests made meanwhile go first for up to ...") is the most that
can add, plus the holds in progress then. To choose between waiting and handing work back, compare
`startIn` with the threshold (the range's upper end is cautious: it adds the spread of every hold
ahead).
Every request, grant, release, timeout and abandoned request is appended to a JSON-lines log next
to the lock (`ponlai-gpu.lock.log.jsonl`, rotated to `.log.1.jsonl` past 4 MB): time, pid, label,
mode, class, ticket, wait or hold in ms, and why a hold ended when its holder did not end it (a
child took the slot over, a yielded slot, a killed holder reclaimed as stale, a lease given up for
a waiter; a leased hold's release counts the views it served).
`node tools/gpu-lock.mjs log [--since 2h] [--by class|label] [--top 5] [--json]` summarises it:
requests, waits and holds per group (median, p95, total; uses of leased holds, lease yields,
take-overs, timeouts, abandoned and stale counted apart) and the longest waits with the holds that overlapped them, so a report can say how
long a run queued and behind whom. The profiler also checks that the GPU is idle before it
measures and marks its results contended otherwise. Keep other pages that render the scene closed.

## Long jobs: `tools/job.mjs`

A command that may run longer than a few minutes (a capture set, a profile, a build of the
references) runs under `tools/job.mjs`, and whoever waits for it waits with `job.mjs wait` rather
than a loop of their own:

    node tools/job.mjs start --log artifacts/plans/<topic>/data/set.log -- node tools/capture-set.mjs ...
    node tools/job.mjs wait artifacts/plans/<topic>/data/set.log          (repeat until it exits 0 or with the job's code)

`start` runs the command detached (it outlives the calling shell) and returns at once; `run` runs
it in the foreground (under an agent's background shell, say). Either way the log holds the
command's output between a start line and an end line, `[done] exit <code> at <time> after
<duration>`. A single argument after `--` runs through `sh -c` (pipes, `&&`), several run as they
are. `wait <log>... [--max s] [--lines n]` returns when every job has ended, exiting with the first
failing job's code (0 when all succeeded), or after `--max` seconds (default and ceiling 240, so
no single wait outlives an agent's five-minute prompt cache), exiting 124 while any still runs:
call it again. A job whose runner was killed before its end line counts as ended (lost, exit 1),
and a file that is not a job's log fails at once (exit 2), so no wait can hang on a line that will
never come. It prints one screen: each job's state and elapsed time, where it stands in the GPU
lock (holding a slot or the lock alone, or queued: its place, the requests ahead of it and the
holders), its log's last lines, and the lock as a whole. `status <log>...` prints the same without
waiting.

## Process priority (macOS)

Processes an agent starts are not applications to macOS: their threads run at the legacy QoS
whatever they ask for, and on a busy machine that work is kept on the efficiency cores while the
performance cores idle, so it runs several times longer (3-14x measured while other agents captured
and built; alike on a quiet machine). `tools/qos.mjs` starts the tools with the application policy
(`taskpolicy -a`) instead, which children do not inherit, so each process gets it on its own:
- every tool that imports `gpu-lock.mjs` or `capture-browser.mjs` (the captures, capture-set and its
  workers, baseline, reference, carry, profile-frame, the verify probes) re-executes itself under it
  in place as it starts, and `gpu-lock.mjs run` and `job.mjs` start their commands with it;
- `clip-metrics.py` (and its worker processes), `diff-set.py` and `img.py` (and their threads) raise
  themselves;
- `npm run build` and `npm run typecheck` start tsc and vite through `node tools/qos.mjs <command>`,
  which runs any command so (a one-off script: `node tools/qos.mjs python3 my-script.py`).
Chrome's own helper processes (GPU, renderers, workers) set their QoS themselves and were never held
back. `PONLAI_QOS=off` keeps a process at the policy it was given (for an A/B); nothing changes on
other systems. A new CPU-heavy tool imports `tools/qos.mjs` first (node) or copies the few lines of
`diff-set.py` (Python).

## Display gate

Headed browser runs (`profile-frame --display`, any script that opens a visible Chrome window)
take over the screen of whoever is using the machine, so they run only while the user allows them:
`node tools/display-gate.mjs allow [hours]` (and `deny`, `status`) keeps the permission in a file
under the user's home, `profile-frame --display` refuses without it, and scripts that open a headed
window call `requireDisplayAllowed` from the same module. Everything else runs headless; a headed
run that is not allowed now is recorded as pending and run later in one batch.

## Frame profiler: `tools/profile-frame.mjs`

```
node tools/profile-frame.mjs [url] [--scenes a,b] [--w 1920 --h 1080 --scale 2] [--quality high]
  [--timestamps on|off|both|auto] [--eval "js"] [--repeat n] [--shots] [--vsync] [--accept [--strict]]
  [--idle-wait s] [--contended] [--hang s] [--scale-log]
  [--scales 1.5,1] [--scale-settle s] [--display [--motion user|orbit|none] [--window WxH]]
```

- Profiles a production build (`npm run build && npm run preview`; the url defaults to its port)
  in headless Chrome (`CHROME_PATH`, else the system Chrome) with the frame rate uncapped, or at
  60 Hz with `--vsync` (the intervals a player sees; uncapped, a GPU-bound scene's p95 is mostly
  pacing noise).
- It plays a matrix of named scenes (`--list`: fair, golden, horizon, sky, overcast, rain, storm,
  fog, night, close over the meadow, a weather front), each with the clock running, fixed weather
  and a slow orbit, and writes `artifacts/perf/<label>/` (profile.json, summary.md): frame interval
  median, p95 and p99, GPU time per pass, the tick's JS time, hitches with their cause, and the
  startup.
- It loads each variant once and switches scenes at runtime (`--mode reload` reloads per scene,
  the original method); every page keeps the generated island in IndexedDB (in the tool's own
  Chrome profile) while the generator's sources are unchanged (`--world-cache off` loads with
  `worldCache=off`).
- It holds the GPU lock exclusively only for what it measures, and no browser while it queues: a
  build the profile has not loaded yet (a new bundle, port or browser version) is first loaded once
  in a browser opened inside a shared slot and closed before the slot is released (the preload;
  skipped when no slot frees within `--preload-wait`, 60 s), so the loads under the exclusive lock
  hit the world cache and the shader cache, as every run but a build's first already did. The
  run's own browser opens once the exclusive lock is held and the idle check has passed (a headed
  window no longer sits on the screen, or dies, while the run queues). The idle check also stands
  for the first load's, and the pages stop before the lock is released (the GPU name, the files
  and the browser's close come after it). `wallSeconds` in profile.json is the time under the exclusive lock;
  `lockWaitSeconds`, `totalSeconds` and `preload` sit beside it.
- When its opening idle check still finds another client keeping the GPU busy after
  `--idle-wait` seconds (20; 60 with `--mode reload`), it names the client, measures nothing and
  exits with 3, releasing the lock: a contended run's numbers prove nothing. Stop the client and
  run again, or pass `--contended` to measure anyway (results marked contended, as before). A
  later page load that finds the GPU busy still marks its results contended.
- A run with several scenes holds the exclusive lock one scene at a time (every mode: profile,
  compare, toggle, accept, reload): before a scene's warm-up it asks for the lock, after its last
  slice its pages stop and drain. The pages and the browser stay open, their loops stopped, so
  they draw nothing while the lock is away. The hold is a lease (`leaseGpuLock` with
  `keepPlace`): kept from scene to scene while no shared request waits, otherwise given up and
  asked for again at once, behind the shared requests queued meanwhile (up to the exclusive cap)
  but in the run's first place among the exclusive requests, so queued captures run between the
  scenes instead of after the whole run, and a timing run queued meanwhile still goes after it. A hold taken again checks the GPU for idle; still busy after `--idle-wait`, the
  run stops with the finished scenes written and exits 3, unless `--contended` (that scene marked
  contended). The first scene's hold covers the page loads. `wallSeconds` counts only the time
  held; `meta.holds` lists each scene the lock came back for (its wait and the GPU idle with this
  run's pages stopped), also under "Lock" in summary.md.
- A scene that shows no progress for `--hang` seconds (180) is recorded as hung (profile.json
  `meta.hung`, a section of summary.md): the browser is closed and opened again and the run goes
  on with the scenes not finished yet; a second hang stops the run, with the finished scenes
  written as usual. Each scene's results are also appended to `scenes.jsonl` in the output folder
  as it finishes, so a run that dies otherwise still leaves what it measured.
- Each page's `clockPaused` and `scalePinned` (diagnostics) are read at its load as its baseline
  (`?dpr` pins legitimately) and again after every slice or measured window. A change (a key or
  click reached the page: a Space pauses it, and a paused page renders at its nominal scale and
  stops steering, spoiling every scene after it) stops the run as a second hang does, with the
  finished scenes written (`meta.spoiled`, a section of summary.md), and exits with 1; the message
  names the page, scene and slice.
- `--compare urlA urlB` runs A and B as two pages in one browser, in alternating slices with the
  other page stopped, and reports deltas with their 95 % interval, each page's render scale per
  scene (high's dynamic scale may settle higher on one side: compare the deltas with that in mind),
  and errors named by their page (`pageerror (page B): ...`). `--toggle "js"` A/Bs inside one
  page by applying the expression (with `s` = `window.__PONLAI__` and `on` false for A, true for
  B) every few frames, for example `--toggle "s.flags.myChange = on"` with a flag an optimisation
  reads from `src/debug/DebugFlags.ts`. Both give B/A as a ratio beside the delta. While a page
  of `--compare` stands stopped, its dynamic scale's clock stands still too (the debug hook
  `dynamicClock`; older builds without it let their holds and bars run out during the other
  page's slices).
- `--scale-log` writes each page's dynamic-scale changes (time on the controller's clock, from and
  to, the rule and, for the GPU's rules, the predicted and measured 90th percentile) per scene to
  the output and to each scene's `scaleLog` in profile.json; in `--compare` also, per slice, how
  long the page stood stopped, how far its controller's clock moved meanwhile and which of its
  timers (holds, a failed step's bar, the contention hold) ran out.
- `--accept` (vsync) judges the 60 fps criterion per scene: frame interval median and p95 within
  0.5 ms of 16.7 (`--target`) and no frame over 25 ms in the 7 s measured, from the run without
  timestamps, with the p99, the maximum and the GPU busy time reported beside it. A contended
  scene that fails is INCONCLUSIVE unless its GPU busy median is over the target; `--strict` exits
  with 1 on a FAIL. Its timestamps default to `auto`: every scene without them, then only the
  scenes that did not pass again with them, for the GPU busy time and the passes that explain the
  failure (no verdict on an idle GPU depends on them). A scene that passed then reports no GPU
  times; `--timestamps both` measures every scene twice, as before, for its headroom.
- Headless 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames
  (every scene once passed it while a 120 Hz display showed uneven cadence and a restless dynamic
  scale under a player's drags). `--display` measures that: headed system Chrome full screen
  (`--kiosk`; `--window WxH` opens a normal window of that outer size, as a player's, with the
  other windows on screen) at the display's own size, pixel ratio and refresh, the camera dragged
  like a player's through Chrome's input (`--motion user`, the default there: turning drags of 30
  to 200 deg/s with pauses, a wheel zoom, a flick; 20 s per scene), and per scene, by display
  refreshes, the intervals between the frames the scene rendered and between those the compositor
  presented (from a trace of Chrome's frame pipeline), the share of intervals that change cadence,
  and how much the camera's turning speed changes from frame to frame. Bringing the window to the
  front gives Chrome the keyboard focus, so every page stops all key events on the window before
  its own listeners (the tool sends none); pointer and wheel stay open for the drags. A window covers the screen
  while it runs: keep the runs short and other animated windows closed. It needs the display gate.
  `--display --compare urlA urlB` interleaves A and B in the same slices as the headless compare
  (the running page brought to the front, the drags restarted in each slice), so the drift between
  separate headed runs (a millisecond or two) cancels; its summary adds the share of late frames
  (presented intervals longer than the frame pacer's pace) per slice, as a delta with its interval, and each page's
  frames over 25 ms. One trace spans a scene's slices of both pages, split by a performance mark
  per slice (ended early at each adaptive stop check); a trace per slice nearly doubled the time a
  slice took beyond its settle and window.
- Adaptive slices: in `--compare`, `--slices` is the most a scene takes. From `--min-slices` on
  (4 with `--display`; headless it defaults to `--slices`, which turns it off), at the end of each
  balanced block of four slices (B A A B, then A B B A) a scene stops once its leading delta's 95 %
  interval clears zero by `--stop-margin` or is no wider than ± `--stop-width` (that one only with 4
  slices a side). The leading delta is the late frames on the display (a share: defaults 0.1 and
  0.02), else GPU busy with timestamps, else the median frame interval (ms: 0.2 and 0.05). The
  summary and each scene's `stop` in profile.json give the slices taken and why. A stop answers the
  leading delta only: the other deltas get fewer slices and wider intervals, so a run whose passes
  or secondary figures matter sets `--min-slices` equal to `--slices`.
- `--scales` repeats the run per render scale (the `dpr` option, which the url and `--q` must then
  leave out) and tabulates every scene at every scale. Every report gives the render scale the
  measured frames were drawn at (its median, range and changes: high's moves); `--scale-settle s`
  waits after each scene's warm-up until that scale has held for s seconds. With GPU timestamps on,
  high's reports add `gpuPixel`: the part of the GPU time in passes that follow the render's pixel
  count (the dynamic resolution's split), for fitting its cost model at fixed scales.
- `--compare` and `--accept` load their pages with `drsStore=off`, so neither side of an A/B (two
  AA modes, two builds) starts from a dynamic scale the other or an earlier run settled at;
  `--drs-store` loads them with `drsStore=on` instead (a returning load).
- `--eval` runs in the page with `s` = `window.__PONLAI__` (an ablation, e.g.
  `--eval "s.pipeline.settings.dof = 0"`); `--report profile.json` re-renders a summary.

### Measuring frame time

- Measure on a production build, under the GPU lock: the scene matrix at the default generic
  display (1920x1080 CSS at DPR 2, quality high), before and after a change (`--compare` for an
  A/B, or `--toggle` on a debug flag while the change is in development).
- Judge an A/B by its GPU time per pass (timestamps on); take frame rates from a run without GPU
  timestamps (`--timestamps off` or `both`): Chrome ran frames up to a quarter faster with them
  on, so their per-pass split shows where the time goes, not the frame rate a player sees. (High
  keeps its dynamic resolution's own timestamp queries in every run, as a player's page does;
  `--q gpuTimer=off` leaves them out.)
- Judge whether a tier holds 60 fps with `--accept` (under vsync), not from uncapped intervals, at
  the tier's own settings (high with its dynamic scale, measured at its settle point with
  `--scale-settle 5`; the report gives each scene's scale), and check how a change plays on a fast
  display with `--display` (pacing, cadence, the scale's changes under drags).
- Report contended runs as such: check `node tools/gpu-lock.mjs gpu` before each run (and during
  it when other windows stay on screen). A player's window is not full screen: other apps stay
  visible and may keep drawing (a Ponlai page in an app's hidden browser pane took half the GPU and
  held the player's scale at its floor), so check a change in a normal window too, not only
  `--kiosk`. Headless at 60 Hz matched the display's GPU times within about 5 %.

## Which tool for which question

Our tools automate and judge (`profile-frame.mjs`: the scene matrix, A/B deltas with their
intervals, per-pass GPU time under our own pass names, the 60 fps acceptance; `gpu-lock.mjs`: one
timing run at a time; the parity capture set). To find out why a frame was late or a hitch
happened, use the existing tools rather than new metrics: a Chrome trace (DevTools Performance
panel, or a trace file opened in Perfetto) shows what the main thread, the GPU process and the
compositor did in each frame, and Xcode Instruments' Metal System Trace, Game Performance and
Animation Hitches templates show when frames reached the display and what the GPU ran
(`xcrun xctrace record --template 'Metal System Trace' --attach <Chrome GPU process pid>
--time-limit 10s --output <file>.trace`, then open it in Instruments). Extend our tools only for
what these do not give (automation, A/B statistics, pass names).

## Other tools

- `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows, water and wave
  optics (each file names the server it expects); they take the GPU lock (shared).
  `tools/verify-scene.mjs` checks a production preview. `tools/verify-scene-jump.mjs` captures the
  parity views reached by scene jumps in one page and as fresh loads, for `diff-set.py`
  (`tools/parity/README.md`, One page, many views).
- `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs`, `verify-wind.mjs` and `verify-game.mjs`
  are CPU-only (plain `node`). `verify-game.mjs` checks the game's simulation: the clock, the
  ground and a path, a body walking to a point, a save round trip, a brain's late answer, and the
  first prototype's rules (needs, the bag, the palm, fishing, the chest placed as a blueprint and
  built, several chests with stable ids, two builders on one site, the actions, the perception, the stand-in brain over a few game days, a save mid-action); its island is in
  `tools/game-fixture.mjs`.
- `tools/verify-framegraph.mjs` checks the frame graph's compiler and runtime on the CPU (plain
  `node`); `tools/verify-frame-graph-gpu.mjs` checks three's cache-key patches (with plain
  materials, and with the app's vegetation and spray drawn by a fresh renderer under a shadow
  pass and their pass's MRT, both ways round) and the motion vectors' blends on the GPU;
  `tools/verify-first-use.mjs` counts the pipelines any step still creates after the warm-up
  (`--aa msaa,taa,taau,off --quality high,medium,low` runs the whole matrix, a page per run).
  It loads in a capture profile slot (as the captures' fast mode does), so the island comes from
  the world cache; the browser's shader cache in the slot does not change the counts (they are the
  page's requests to WebGPU, cached or not), and `--fresh` runs in a throwaway profile as before.
  Its steps' waits are part of what it measures and stay fixed.
- `tools/benchmark-lighting.mjs` A/B-times two builds.
- `tools/build-moon-textures.py` rebuilds the moon's textures from NASA's CGI Moon Kit
  (`uv run --with pillow --with numpy`). `tools/build-star-catalog.mjs` and
  `tools/build-milky-way.py` rebuild the night sky's data in `public/sky/` from the raw catalogue
  and map (each file says where to get them and how to run it).
  `tools/bake-rainbow-table.mjs` generates `src/sky/RainbowTable.data.ts`.
