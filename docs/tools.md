# Ponlai: tools and URL options

The manual of the page's URL options and of the tools under `tools/`. `AGENTS.md` lists the
everyday commands; this file has the details. Each tool's own file says the rest.

## Page

- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191, the production build).
- `window.__PONLAI__` (scene handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the
  dev server or with `?debug` (or `?profile`, which also loads the frame profiler).
  `__PONLAI__.loop.step( { frames, dt, scale, camera, onFrame, clock, converge } )` stops the live loop and
  steps the tick itself with fixed timestamps, the frame pacer and the dynamic scale bypassed and
  nothing taken from the wall clock (`loop.start()` resumes the live loop); the diagnostics add
  the scene's anti-aliasing (`aa`), the pipelines created so far (`pipelines`, counted by
  `src/debug/PipelineCounter.ts`) and `graph` (the frame graph's dev counters: the attachment
  ops it rewrote and expected in the last frame, the frames they differed, targets found at a
  size other than their class's).
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
  mouse, WASD, Q/E and Shift).

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
changed pixels count as unchanged; after 120 the view is shot anyway, marked `capped`; a temporal
page compares converged rests, two in a row, with the tolerance at once and a cap of 400 frames).
Replayed over per-frame traces of the 24 parity views, these defaults shot no load early and every
one on its settled frame. The capture's JSON records it as `ready` (`--stable-*` options in `tools/capture.mjs`, the rule and its
evidence in `tools/capture-browser.mjs`). `--ready-frames n` waits for a fixed count instead, as a
running capture does (60); `--wait` / `--settle` ms add fixed delays. The frame loop is stopped
and the GPU queue drained before the shot. A paused capture takes about 5-7 s alone.

Check visual changes with captures, compared against the previous capture (and crops, not only
the whole frame); report measured differences. `tools/compare-captures.py` measures two overview
captures (needs Pillow and NumPy).

`tools/parity/` captures a fixed set of paused views with named 1:1 crop anchors
(`capture-set.mjs`) and diffs it against a reference set, byte for byte or within the reference's
own repeatability (`diff-set.py --aa-floor`; see its README). Temporal AA sets (taa, taau) are
not byte-repeatable and are judged by a tolerance instead (`diff-set.py --temporal`: shares of
pixels over a level on the frame, in local windows and on the crops, a bound on coherent sub-level
shifts, and one recapture before a failure counts; thresholds in `tools/parity/tolerance.py`).
`tools/capture-clip.mjs` captures a named clip (`tools/parity/clips.mjs`: a parity view set in
motion, its camera path a function of the frame index) frame by frame with the page's stepper, as
crops that follow their subjects, and `tools/clip-metrics.py` measures a clip against MSAA and a ground truth (`--aa gt-hi`: MSAA at
twice high's nominal ratio, downsampled) with gates from a thresholds file
(`uv run --with numpy --with pillow`; both described in the README).

## GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes the
machine-wide GPU lock in `tools/gpu-lock.mjs`: timing runs (profiles, benchmarks, running captures)
hold it alone; paused captures and the verify probes share it with each other, since their pixels
do not depend on the load. Shared holders take one of `PONLAI_GPU_SLOTS` slots (default 3) and the
rest queue first in, first out: captures are GPU-bound, so past 2-3 pages at once only each page's
latency grows. A slot is held per browser (capture.mjs and capture-clip.mjs take one each), so
capture-set `--jobs n` and baseline.mjs interleave with other sets capture by capture; under a
`run --shared` wrapper the first capture takes the wrapper's slot over and the wrapper holds nothing
from then on, so a wrapped orchestrator never holds a slot its own captures wait for. An exclusive
request waits for the slots in use, blocks new ones, and the queue resumes after it. A killed
holder's slot frees itself at the next look.
`node tools/gpu-lock.mjs run [--shared] [--label x] -- <command ...>` wraps any other script,
`status` names the holders (shared: their slots and the queue) and `gpu` shows the GPU's
utilisation and the processes using it. The profiler also checks that the GPU is idle before it
measures and marks its results contended otherwise. Keep other pages that render the scene closed.

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
  [--timestamps on|off|both] [--eval "js"] [--repeat n] [--shots] [--vsync] [--accept [--strict]]
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
- `--compare urlA urlB` runs A and B as two pages in one browser, in alternating slices with the
  other page stopped, and reports deltas with their 95 % interval. `--toggle "js"` A/Bs inside one
  page by applying the expression (with `s` = `window.__PONLAI__` and `on` false for A, true for
  B) every few frames, for example `--toggle "s.flags.myChange = on"` with a flag an optimisation
  reads from `src/debug/DebugFlags.ts`. Both give B/A as a ratio beside the delta.
- `--accept` (vsync, timestamps both) judges the 60 fps criterion per scene: frame interval median
  and p95 within 0.5 ms of 16.7 (`--target`) and no frame over 25 ms in the 7 s measured, from the
  run without timestamps, with the p99, the maximum and the GPU busy time reported beside it. A
  contended scene that fails is INCONCLUSIVE unless its GPU busy median is over the target;
  `--strict` exits with 1 on a FAIL.
- Headless 60 Hz shows whether the GPU holds 60 fps, not how a faster display paces the frames
  (every scene once passed it while a 120 Hz display showed uneven cadence and a restless dynamic
  scale under a player's drags). `--display` measures that: headed system Chrome full screen
  (`--kiosk`; `--window WxH` opens a normal window of that outer size, as a player's, with the
  other windows on screen) at the display's own size, pixel ratio and refresh, the camera dragged
  like a player's through Chrome's input (`--motion user`, the default there: turning drags of 30
  to 200 deg/s with pauses, a wheel zoom, a flick; 20 s per scene), and per scene, by display
  refreshes, the intervals between the frames the scene rendered and between those the compositor
  presented (from a trace of Chrome's frame pipeline), the share of intervals that change cadence,
  and how much the camera's turning speed changes from frame to frame. A window covers the screen
  while it runs: keep the runs short and other animated windows closed. It needs the display gate.
- `--scales` repeats the run per render scale (the `dpr` option, which the url and `--q` must then
  leave out) and tabulates every scene at every scale. Every report gives the render scale the
  measured frames were drawn at (its median, range and changes: high's moves); `--scale-settle s`
  waits after each scene's warm-up until that scale has held for s seconds.
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
  `tools/verify-scene.mjs` checks a production preview.
- `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs`, `verify-wind.mjs` and `verify-game.mjs`
  are CPU-only (plain `node`). `verify-game.mjs` checks the game's simulation: the clock, the
  ground and a path, a body walking to a point, a save round trip, a brain's late answer, and the
  first prototype's rules (needs, the bag, the palm, fishing, the chest placed as a blueprint and
  built, several chests with stable ids, two builders on one site, the actions, the perception, the stand-in brain over a few game days, a save mid-action); its island is in
  `tools/game-fixture.mjs`.
- `tools/verify-framegraph.mjs` checks the frame graph's compiler and runtime on the CPU (plain
  `node`); `tools/verify-frame-graph-gpu.mjs` checks three's cache-key patches and the motion
  vectors' blends on the GPU; `tools/verify-first-use.mjs` counts the pipelines any step still
  creates after the warm-up.
- `tools/benchmark-lighting.mjs` A/B-times two builds.
- `tools/build-moon-textures.py` rebuilds the moon's textures from NASA's CGI Moon Kit
  (`uv run --with pillow --with numpy`). `tools/build-star-catalog.mjs` and
  `tools/build-milky-way.py` rebuild the night sky's data in `public/sky/` from the raw catalogue
  and map (each file says where to get them and how to run it).
  `tools/bake-rainbow-table.mjs` generates `src/sky/RainbowTable.data.ts`.
