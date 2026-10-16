# Ponlai: tools and URL options

The manual of the page's URL options and of the tools under `tools/`. `AGENTS.md` lists the
everyday commands; this file has the details. Each tool's own file says the rest.

## Page

- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191, the production build). Build and typecheck run tsc and vite with
  the application policy on macOS (Process priority, below).
- `node tools/serve.mjs dev|preview [--port N] [--no-build]` starts a worktree's server without
  colliding with another's: it takes the first free port in 6400-6499 (or checks `--port N` and
  names the pid and cwd holding it), builds first for `preview` unless `--no-build`, runs vite
  through `job.mjs` with its log at `artifacts/jobs/serve-<mode>-<port>.log`, waits until it
  answers and prints the URL and the `job.mjs stop` command that ends it. It serves the checkout
  the cwd is in, whichever copy of serve.mjs runs (outside the repository it exits 1), and its
  first line names that checkout's path, HEAD and branch.
- `node tools/serve.mjs dev|preview --sha <rev>` serves another commit: a detached worktree at
  the main checkout's `.claude/worktrees/sha-<12 hex>`, made once and reused. Its node_modules
  links the main checkout's entries (vite's caches left out) when the commit's package-lock.json
  is the same, else `npm ci` runs there; `preview` builds once per worktree (`dist/.serve-sha`).
  The log is `artifacts/jobs/serve-<mode>-sha-<12 hex>-<port>.log` in the calling checkout.
  `node tools/serve.mjs clean` removes every sha-* worktree; one with a live job is skipped and named (stop its job first).
- The islanders load from the git-ignored `artifacts/assets/`. `tools/vite-assets.mjs` finds the
  folder (the checkout's own, else the main checkout's through git's common directory, so a fresh
  worktree needs no link): the dev server serves it and `vite build` links it into
  `dist/artifacts/assets`. Without either, the build warns once and the page stays on the loading
  screen.
- `window.__PONLAI__` (scene handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the
  dev server or with `?debug` (or `?profile`, which also loads the frame profiler).
  `__PONLAI__.loop.step( { frames, dt, scale, camera, onFrame, clock, converge } )` stops the live loop and
  steps the tick itself with fixed timestamps, the frame pacer and the dynamic scale bypassed and
  nothing taken from the wall clock (`loop.start()` resumes the live loop); the diagnostics add
  the scene's anti-aliasing (`aa`, and `aaSource`: `url` or `tier`, where it came from), the pipelines created so far (`pipelines`, counted by
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
  compile) and the loading screen has faded out; under taa / taau / gt / fsr3 the temporal rest must also
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
  (high only), and how the quality tier was chosen.

## URL options

View and capture:

- `paused`, `t` (scene time), `dpr` (render pixel ratio, pinned), `dist` (m; without it the
  island view's distance follows the land's size), `polar`, `az` (the camera), `gui`, `camera`
  (`orbit`, the default: the island camera; or `free`: fly with the mouse, WASD, Q/E and Shift).
  The island view's fov widens as it closes in: `nearFov` (degrees at the closest zoom, 42 by
  default; `off` keeps 27 at every distance) and `nearFovFrom` (the distance in m it widens from,
  50 by default); the GUI's Camera folder has the same three controls.
  A paused page lifts its loading screen at once, without the fade, so a capture of a paused frame
  never catches the screen over it.

The island:

- `seed` (the world's seed, 1 by default: Ponlai's island) and `grow` (growth steps after the
  starting island, 0 by default, up to `GROWTH.maxSteps`). The page generates its world from that
  land in 16 m chunks and frames its views on it; debug pages expose `window.__PONLAI__.land` (`seed`,
  `step`, `bounds`, `centroid`, the views' `scale` against the first island and the default pivot
  `target`) for the tools to frame by, which follows the island as it grows.
- Growing in place (src/world/Growth.ts): Grow (the GUI's Island folder) or `await
  __PONLAI__.growth.grow()` generates the next piece in the background and swaps it in (the
  promise resolves once the frames after the swap are done); from then on the page keeps a piece
  ahead. A `?game` page generates it from its start; `growth.start()` generates it ahead on any
  page without growing (a probe that wants the piece ready). `growth.state` holds the step shown,
  the next piece's phase and the last swap's chunks and times (preparation, the swap's frame by
  part, the frames after it) and its `work`: the growth's own main-thread time per frame (`max`,
  its `stage`, `frames` as page time and ms pairs, steps over 0.6 ms in `slow`, and the page
  times the preparation began, the swap happened and its frames ended); `growth.
  chunkHashes()` the shown chunks' hashes (equal on a grown page and one loaded with `grow` at the
  same step), `growth.fieldBytes()` the world fields' GPU bytes. The island view (key R,
  `setCameraView( 'island' )`) frames the land shown; the camera itself stays where it is.
- `approach` (0 .. 1, 0 by default): the progress toward the next piece, the shoal under it
  (src/world/SeabedRise.ts) put on it at once; above 0 the page generates the next piece and keeps
  its loading screen up until the shoal is written, so a paused load repeats. A scene option: a
  scene jump sets it as the load does. On a page, the Island folder's Approach slider (eased over
  seconds of scene time, or at once while paused), `growth.approach( p )` (eased) and `await
  growth.approachNow( p )`; `growth.rise.state` holds the approach, R (`r`, its `target`, the R last
  `written`), the pending `tiles`, their largest `rise` (m), the `writes` and the last one's `ms`.

Sky and weather:

- `hour`, `preset` (dawn, sunrise, noon, golden-hour, sunset, dusk, midnight), `dayLength`
  (seconds), `moon` (phase), `clock=paused` (freezes only the day clock; `paused` freezes it with
  the scene).
- `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load as established,
  already wet; without it the weather evolves on its own, among the kept presets), `clouds`
  (coverage override). Rain, storm and fog are parked (`src/sky/Weather.ts` `PARKED_WEATHER`):
  a production page without `?debug` refuses them with a console warning and shows fair; the dev
  server, `?debug` and `?profile` still reach them.

Quality and look:

- `quality` (low, medium, high: the tier of every knob in `src/Quality.ts`; without it high, the
  only active tier: medium and low are parked, see Parked quality tiers), `tier.<knob>=<value>`
  overrides one knob for an A/B (e.g. `tier.post.fogScale=0.5`). The GPU timing that once chose
  the tier (`src/QualityDetect.ts`, `autoQuality`) is parked with them.
- `tone` (neutral-hue, the default, agx-hue, agx, neutral), `look` (soft-fantasy, the default,
  rich-fantasy, realistic).

Rendering and A/B options, read at load (runtime switches for one-page A/Bs live in
`src/debug/DebugFlags.ts`):

- `aa` (the anti-aliasing mode, `src/post/Antialiasing.ts`, over the tier's `aa` knob: each tier
  has its default, high `msaa` (the parked medium `taau`, low `msaa`), and the GUI's Antialiasing
  control reloads with any of TAAU, FSR 3.1, TAA, MSAA 4x and, in debug builds, Off. `msaa`: 4 samples, upscaled by
  FSR 1; `off`: one sample; `taa` and `taau`, the temporal modes: one sample, jittered, with motion vectors, resolved against a history in `TemporalAA.ts`, at the
  render's size or upsampled to the canvas; a paused page shows the rest image, the jitter
  sequence averaged, once it has converged, `TemporalRest.ts`; what changes the scene raises a
  scene event, `SceneEvents.ts`, which restarts the rest and may cut the history: the diagnostics'
  `taa.lastEvent`, and `__PONLAI__.taa.restart()` by hand) and its older alias `msaa` (`4`
  reads as `aa=msaa`, `1` and `2` as `aa=off`, since WebGPU multisamples with 1 or 4 samples
  only). The capture and parity tools apply the temporal tolerances by their own `--aa` option, so
  a set of the parked medium's default passes `--aa taau`.
- `aa=fsr3`: AMD's FSR 3.1 upscaler (the TSL port in `src/post/fsr3/`, integrated by
  `Fsr3Upscaler.ts`) at AMD's placement: one sample, jittered with FSR's own sequence, with motion
  vectors; FSR takes the composite's HDR image at the render's size, and the blooms, the depth of
  field, the look's glow and the grade run on its output at the canvas's size. A paused page shows
  FSR's rest image (`tier.taa.fsr3.restSequence` frames from a reset, then held) through the same
  `__PONLAI__.taa` handles and diagnostics `taa` block as the temporal modes (with an `fsr3` block:
  the live constants, frame index, phase count, jobs and clears); `__PONLAI__.fsr3` is the upscaler.
  It needs the composite pass (`post=inline-composite` and `post=legacy` run msaa). Flags:
  `flags=fsrMipBias:false` takes the terrain's mip bias off (live: `__PONLAI__.flags`),
  `flags=fsrAutoReactive:true` runs the reactive-mask generator (read at load),
  `flags=fsrJitterSign:-1` / `fsrMotionScale:<k>` scale the jitter and the motion FSR is told (live;
  the conventions' checks: FSR's image against the ground truth is best at 1).
- `fsrDebug` (debug builds, under `aa=fsr3`): FSR's debug view over its output (a 3x3 grid:
  dilated motion, protected areas, dilated depth; disocclusion, shading change, detail protection
  takedown), drawn through the post chain, so graded.
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
- `worldCache=off` (generate every chunk of the island instead of loading it from the browser's
  IndexedDB cache, as on a first visit; `src/world/WorldChunks.ts`). The cache keeps one record per
  chunk, so a land grown by a piece reloads the chunks the piece did not reach; the diagnostics'
  `worldCache` counts the records read (`hits`, of the chunks and the land). It keeps the records
  of the two land versions loaded last (a seed and `grow` step each) and deletes the rest after a
  load, so going back to an older step rebuilds the chunks it does not share with them.
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
- `frameRate=auto|<fps>` (the frame rate the loop holds on a faster display: `auto`, the default,
  holds the tier's and falls back to the next whole divisor of the refresh, e.g. 72 -> 48 fps on
  144 Hz, when the dynamic scale's floor cannot hold it, `src/post/FramePacer.ts`; a number is a cap,
  the fastest whole-divisor rate not above it, without the fallback; `frameRate=0` renders on every
  refresh, as the profiler's uncapped runs do). `frameFallback=0` keeps `auto` at the tier's rate
  (profile-frame adds it on `--compare` and `--accept`; `--frame-fallback` keeps the fallback on). A
  scene jump (`establishScene`) leaves the fallback, as a fresh load starts at the held rate. In a
  debug page, `__PONLAI__.pacer.choices()` lists the display's even rates, `setRate( fps | 'auto' )`
  sets one, `mode` and `rate` read the choice and `fps` the rate held now (a production `?game`
  settings menu needs the game to be handed the pacer: not wired yet); the diagnostics' `pacing`
  block shows `mode`, `fallback`, `falls` and `returns`.
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
- `flags=<name>:<value>,...` (debug builds: sets `debugFlags` as the page loads, before anything
  reads them; values `true` / `false`, numbers or strings, `mv.<source>` a motion source), e.g.
  `flags=taaClampDrop:false` for a capture's or clip's `--q`.
- Under the temporal modes `flags.mv.camera` / `object` = false leave a source out of the motion
  vectors, `flags.jitter = false` the jitter, `s.taaCut( reason )` cuts the history and
  `s.motionCheck()` lists the materials whose motion vectors are missing or partial.
- `vegPrepass=0` (the single coverage pass), `vegPrepass=coverage` (the prepass with coverage kept
  in the shaded draw).
- `chunkBorders` shows the world's 16 m chunks as lines above the sea and the meadow (also the
  GUI's Ground folder, `chunk borders`), to tell a seam from a chunk border.
- `windView` makes the vegetation's wind visible (debug pages only; read at load, so without it
  no shader changes; `src/debug/WindView.ts`): flat unlit arrows every 2 m over the meadow, just
  above the grass, point where the local wind blows (the eddies' veer included), longer in a
  gust and brighter with the lean it gives; and every plant (grass and its flowers, the rim's hanging grass, the game's
  palm) is drawn unlit in the colour of its current sway s (tip
  offset over height): the hue is s's angle from the mean wind on a cyclic map (downwind blue,
  upwind orange, left of the wind, counter-clockwise seen from above, magenta, right of it green),
  the brightness |s| / 0.15. `windView=arrows` or `windView=plants` shows one half. The numbers
  behind it: `__PONLAI__.windProbe( options )` (`src/debug/WindProbe.ts`: the shaders' own wind
  functions in a compute kernel built on the first call; angle histograms, lean and swing,
  neighbours' correlation, the gust field's size and travel, the plants' wiring, their natural sway
  frequencies, and per weather where every part travels and how fast: the plants, the sea and its
  swell, the sea fog, the cumulus and the cirrus), through the probe as
  `--eval "return JSON.stringify( await P.windProbe() )"`.
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
  again once the game does), `load` (resume the game saved in this browser, its world loaded at the
  save's piece count unless `grow` is given). The page's own
  `weather` option and auto weather work in the game as without it.
- The player's interface is a prototype HUD (`src/game/Hud.ts`): a readout of the islander (day
  and time, satiety and hydration, the bag, what they are doing, each unbuilt site's progress in
  percent, the last words said and how the last action ended) and a "Place chest" button that arms placement: a ring on the turf
  previews the spot (green, or red with the reason), a click places it, Escape cancels, and the
  control is gone once the chest is placed (`src/game/Placement.ts`). Space pauses only the game
  clock, the GUI's hour, clock pause and time preset are off (the game's clock owns the time of
  day), and its Game folder (`src/game/GameDebug.ts`) sets the speed and pauses, saves and loads, shows one islander's body
  (position, the action under way, whether a thought is in flight) and sends it walking to the
  next click on the island; its Growth subfolder shows the population against the next step and
  adds an islander (one piece per 2 islanders above 3: the island grows at 5 islanders). The stand-in brain (`src/game/sim/standin.ts`) thinks for the islander
  by default. `window.__PONLAI__.game` is the Game for the console: `.sim`, `.tools` (the five
  actions), `setBrain( brain )` (kept across a load; `null` leaves the islander idle),
  `think( id )`, `walkTo( id, x, z )`, `placeBlueprint( kind, x, z )` (a building of a kind,
  `'chest'`, any number, each with an id like `chest1`; returns why not, or null), `focus( id )`, `setSpeed`, `togglePause`,
  `addIslander()`, `save` and `load` (a save of another piece count loads only with the page);
  `.sim.comingLand` holds the next piece's cells once the page has it.

## Test mode

The rule (AGENTS.md, Rules for every change): simulation and generation are deterministic and
path-independent; rendering may keep history-dependent effects that a scene jump clears, that
converge on a still scene (or are frozen or turned off in the test mode) and that are compared
within a tolerance; the test mode keeps the byte-for-byte checks valid.

- The test mode today: `paused` in the query, which loads `aa=msaa` whatever the tier runs (high
  runs `taau`; an explicit `aa=` wins), the shot taken once
  `__THREE_GAME_DIAGNOSTICS__.settled` holds (capture.mjs's readiness). Every capture, parity and
  verify tool already loads its pages this way, so their exact checks hold as their headers say.
  The page's only history-dependent rendering effects are the temporal resolve (`aa=taa|taau|gt`,
  frozen by its rest image, `TemporalRest.ts`, and compared within the temporal tolerance) and the
  states that settle on their own on a still scene (the clouds' view, the sky's bakes, the
  refracted sun's map, the fog's bank), which `settled` waits for.
- A new history-dependent effect:
  - `establishScene` (`src/main.ts`) clears its history; `tools/verify-scene-jump.mjs` checks it;
  - it reports itself to `settled` (main.ts `pending`, or the rest's signature) until it has
    converged on a still scene, or it is frozen or turned off in the test mode;
  - the first such effect adds the test mode's one switch, a load-time query option every such
    effect reads (frozen or off), and the capture, parity and verify tools set it by default, with
    an option to leave it out; later effects read the same switch;
  - a Grow does not clear rendering history (`tools/verify-growth-swap.mjs` shoots its first view
    without a jump), so the effect is frozen or off under the switch there, or the swap resets it;
  - its module joins `WATCH.motion` in `tools/parity/carry.mjs` when its paths are not already
    there: with it frozen or off, the paused set no longer shows it, only the clips do;
  - its frames outside the test mode (live, clips) are compared within a tolerance, as the
    temporal modes' are (`tools/parity/tolerance.py`), unless they repeat pixel for pixel.

## Captures

`node tools/capture.mjs <name> [--w 1672 --h 941] [--q "paused&t=12&dpr=1"] [--eval js|@file]...
[--verbose]` takes a screenshot of the running dev server into `artifacts/captures/`
(git-ignored) and prints frame diagnostics. It needs Playwright's Chromium once
(`npx playwright install chromium`), or `CHROME_PATH` set to a WebGPU-capable Chrome.

`--eval` takes the same forms and scope as the probe's (`tools/page-eval.mjs`, shared by both: an
expression, a function or statements with a `return`, `await`, `@file`; `P`, `D`, `frames( n )`,
`sleep( ms )`, `until( fn, timeoutMs )`): wait in an eval with `await until( () => D.settled )`,
not a polling loop. Each eval's value lands in the capture's JSON as `evals: [ { eval, value } |
{ eval, error } ]`; an eval that throws fails the capture (exit 1), which is still shot.

Captures and clips run in "fast mode" (`tools/capture-browser.mjs`): the browser runs in a
persistent profile slot, `artifacts/.capture-profiles/<browser build>/<n>` of the main checkout
(one browser per slot, each with its own lock; `PONLAI_CAPTURE_PROFILES` moves them; safe to
delete), so the world cache and the GPU shader cache hit from the second capture on. A capture
takes the free slots its page (origin and build) used last first (`affinity.json` beside the
slots), else the lowest free one. A paused
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
(mean RGB, luma, percentiles per image or region) and `flicker` (a clip's consecutive whole
frames, capture-clip's `--full`: the temporal flicker per region, mean frame difference, temporal
high-pass, one-frame flashes and a `--map` of where they fall); regions are `--box
[name=]x,y,w,h` or `--anchor name|all` from the capture's JSON. Its numbers are diff-set.py's and
compare-captures.py's (shared helpers in `tools/parity/pixels.py`). `tools/compare-captures.py` measures two overview
captures (`uv run --with numpy --with pillow`). Where shapes differ (growth steps, seeds, a
regenerated island), judge the look by eye and region statistics (`tools/capture-growth.mjs`), not
by pixel difference.

`node tools/verify-growth-swap.mjs <base url> [--steps 6] [--views island,cliffs,meadow] [--q
"query"] [--fresh-grow M] [--out dir]` checks the growth in place: a page loaded at `grow=0` and
grown N times by `__PONLAI__.growth.grow()` against a fresh load of `grow=N`, both paused and
headless in one warm capture browser. It compares the views (parity view names, or the aliases
island, cliffs, meadow; each shot twice, two frames apart, after the settled signal and a stable
image; the first shots or the second byte for byte) on decoded pixels, the chunk hashes, the rain's
collision map read back in each page (0 differing texels), the camera's ground grid, the world
fields' bytes, the pipeline count (constant across every swap, equal on both pages), renderer.info's
uniform buffers and textures (the grown page at most 2 above the fresh one) and the console (no
errors). Per step it records the swap's time and the memory. The GPU lock is shared and held only
while a page renders: it is released while the page prepares its next piece. Writes `report.json`
and the shots to `artifacts/captures/growth-swap/<time>-<pid>/` (or `--out`); exit 0 pass, 1 fail.
`--fresh-grow M` loads the fresh page at another step, only to see the check fail. Its header has
the rules.

`node tools/capture-growth.mjs --base url [--cand url] [--seeds 1,2] [--grow 0,4,12]
[--views v1,v3] [--label x] [--q "query"] [--jobs 2] [--base-ref sha] [--recheck 1]` sets a base
and a candidate page side by side in six views (v1 overview, also in golden hour; v2 top-down; v3
cliff, v4 meadow and v5 rim close; v6 sea floor), framed on the land in the page
(`__PONLAI__.land`: the overview is the page's own island view; today's framing without it; the
close views walk the camera's ground, `controls.ground`, never the drawn meshes' vertices), into
`artifacts/captures/growth/<label>/index.html` with each pair's crop statistics (mean luma,
saturation and edge density, by compare-captures.py's metrics; deltas beyond 10 % flagged) and its
pixel difference (pixels that differ, largest channel difference, on decoded pixels). A URL's own
query and `--q` pass through and override the tool's settings (`debug` is added, so a production
preview works). The shots are grouped by side and by the options a page reads at load (seed, grow,
quality, dpr, ...), and each group is one `capture.mjs --worker` page (paused, headless, the shared
GPU lock per view) that loads its first view and reaches the others by the exact scene jump, so a
group's world is generated once; `--jobs` pages run at once. Each group keeps its own browser profile
(`artifacts/.capture-profiles/growth/<side>-s<seed>-g<grow>`), so a repeat run finds its world in
the cache. A failed view or a lost page is shot again once on a fresh page. `--base-ref <sha>` keeps
the base side's shots per commit in `artifacts/captures/growth-ref/<sha>/` (one entry per shot,
keyed by its query, size, camera code, capture tools and browser) and reuses them on later runs;
the base URL must serve that commit. A pair with a tiny difference (at most 64 px and 2 levels by
default) is shot again on both sides and reported as identical, repeatable or not repeatable
(`--recheck 0` turns it off). The header of the tool has the details.

`tools/parity/` captures a fixed set of paused views with named 1:1 crop anchors
(`capture-set.mjs`; views.mjs frames and anchors them on the camera's ground, `controls.ground`:
the island's box and height grid made from the chunks in the workers, so the drawn meshes'
vertices are never read) and diffs it against a reference set, pixel for pixel or within the reference's
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
twice the former nominal ratio 1.5, downsampled) with gates from a thresholds file
(`uv run --with numpy --with pillow`, clip-metrics.py also `--with scipy`; both described in the
README). clip-metrics.py measures the
frames in worker processes: `--workers N` or `CLIP_METRICS_WORKERS`, by default a quarter of the
CPUs within 1 to 4; the output does not depend on the count.
Without `--gt` it takes each side's own metrics only; `--crops boxes.json` cuts crops from whole
frames (`{ view: { crop: [ x0, y0, x1, y1 ] } }`), and `--split-redraws` also reports each crop's
Fhp near the shadow map redraws the clip's notes mark and between them (the shadow-shimmer study:
use it instead of a script of one's own).
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

`uv run tools/parity/gates.py <root>/<sha>/<label>/metrics.json --thresholds T [--policy P]
[--normal] [--md f] [--json f] [--title t]` turns a label's metrics (baseline.mjs with
--thresholds) into gate verdicts per gate id: PASS and FAIL counts and every failing item, exit 0
only when every judged gate passes. A task's decisions on top of clip-metrics' verdicts (a gate
judged against the ground truth instead of MSAA, a gate left informational) are rules of its policy
file, matched by gate id, entry, view, clip, crop and metric with globs, never code in the tool;
`--normal` counts the special weathers (views.mjs's `special` group) apart. The policy's format is
in the tool's header.

Parked weathers: rain, storm and fog (`src/sky/Weather.ts` `PARKED_WEATHER`) are out of the default
checks. Every default set is the normal weathers' (views.mjs's `parity`, `taa` and `all`,
clips.mjs's `all`, baseline.mjs's plan without `--views` / `--clips`, verify-scene-jump's views,
profile-frame's scene matrix and `--accept`, verify-first-use's steps); `special` or a name
reaches a parked view, clip or scene, and verify-first-use runs its `weather` and `bolt` steps only
when `--steps` names them. `verify-weather-effects.mjs`, `verify-ocean-weather.mjs` and the rain
parts of `verify-weather.mjs` are parked with them: not part of any default check.

Parked quality tiers: medium and low (`src/Quality.ts` `PARKED_QUALITY`) are out of the default
choice and checks; high at 4K output (1920x1080 CSS pixels at DPR 2, profile-frame's default
viewport) is the only active tier. A page without `quality` loads high (the GPU timing that picked
a tier, `src/QualityDetect.ts`, is parked with them) and the GUI lists high alone. Every tool's
default is high: profile-frame's `--quality` (and so its scene matrix and `--accept`),
verify-first-use's `--quality`, baseline.mjs's `--tiers` (its plan keeps the lower tiers' views),
carry.mjs's `--tiers`, capture-set, quick, capture-clip and verify-scene-jump's `--quality`, and
the pages capture.mjs, probe.mjs and capture-growth.mjs load without a `quality` in their query.
`?quality=medium|low`, `--quality medium` or `--tiers high,medium,low` reach them.

`uv run tools/parity/table.py <metrics.json | label dir>... [--names a,b] [--base col]
[--refs msaa,gt] [--entries glob] [--metrics m1,m2] [--crops c1,c2] [--csv f]` tables several
labels' metrics (baseline.mjs labels or clip-metrics outputs) side by side: rows crop x metric,
a column per input's test values and per reference (MSAA, ground truth), and each column's ratio to
`--base`. Use it instead of a per-task table script.

## Probes

`node tools/probe.mjs [url] [--q query] [--query q]... --eval js [--until js] [--frames n]`
answers a question about the running page without a Playwright script of one's own: it loads the
scene in the capture tools' browser (headless, a warm profile slot; `--fresh` for a cold load),
holds a shared GPU slot from the load to the end (`--exclusive` for frame times), runs the steps in
the order given and prints JSON (per query: load or jump, the time until up, each step's value,
console errors and failed requests). Each `--query` after the first is reached in the same page by
the scene jump. Evals see `P` (`__PONLAI__`), `D` (the diagnostics), `frames( n )`, `sleep( ms )`,
`until( fn )` and `pipelines` (`mark()`, `since( mark )`: which pipelines an action built), with the same forms and scope as capture's `--eval` (`tools/page-eval.mjs`) (`D` is rebuilt every 30 frames: live counters such as `P.pipelines.total` come
from `P`); `--init js` hooks the page before its scripts run. A production preview needs
`debug` in the query. A long eval that waits on CPU work (worker generation, a grown page) stops
the loop (`await P.loop.stop()`) and waits with `until` or `sleep`: while the loop stands the probe
gives its shared slot up to a request ranked before it and takes it back before the helper resolves
(each give-up on stderr, the step's `gaveUpMs`). Common questions:
`--load` loads every query after the first in a page of its own instead of jumping to it: the
scene-jump contract covers the image, not the world's generation path, so use it to compare two
freshly loaded pages (a grown page against a fresh `grow=1` page) in one call.

- diagnostics and load timings: `--eval "D.timings" --eval "D.worldCache"`;
- a uniform or a setting: `--eval "P.shared.wetness.value"`, `--eval "P.camera.position"`;
- the pipelines an action creates, on a paused page (`D.settled` never turns true on a running
  one): `--q "debug&paused" --until "D.settled" --eval "P.pipelines.total"
  --eval "P.setWeather( 'storm', 0 )" --frames 120 --eval "P.pipelines.total"`;
- which pipelines an action built and for what: `--eval "window.m = pipelines.mark()"
  --eval "P.setWeather( 'storm', 0 )" --frames 120 --eval "pipelines.since( window.m )"`. Each
  entry has its kind, label, material and object (name and type), target (texture names or
  `canvas`, attachments, depth, sample count), frame and the first 6 app frames of its stack
  (`tools/pipeline-trace.mjs`, shared with verify-first-use; installed at the first `mark()`, so
  earlier pipelines are not listed, nor wrappers of one's own needed);
- the game: `--q "debug&game" --eval "P.game.sim.state.villagers[ 0 ]"`;
- frame time: `--exclusive --q "debug" --frames 300 --eval "D.frameMs"` (profile-frame for A/B).

Steps, scope, the value's serialisation and the exit code are in the file's header.

## GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes the
machine-wide GPU lock in `tools/gpu-lock.mjs`: timing runs (profiles, benchmarks, running captures)
hold it alone; paused captures and the verify probes share it with each other, since their pixels
do not depend on the load. Shared holders take one of `PONLAI_GPU_SLOTS` slots (default 3) and the
rest queue: captures are GPU-bound, so past 2-3 pages at once only each page's
latency grows. A capture-set page leases its slot (capture.mjs's worker, `leaseGpuLock`): it keeps
it from view to view and gives it up between views only when a request ranked before its next one
waits for it (an exclusive request, or a shared one when every slot is taken) and it has held it
for its lease, 20 s (capture.mjs `--lease`, after capture-set's `--`; 0 frees it after every view),
so a set behind back-to-back timing runs advances about four views per run instead of one, and a
timing run ranked before it waits at most 20 s plus the view in flight for it; capture-clip.mjs holds a slot per clip.
An exclusive lease can keep its place (`leaseGpuLock` with `keepPlace`, profile-frame's hold per
scene): it is ranked, and asked for again, under the ticket number of its first request, so it
yields only to a request ranked before that one (a higher level: captures at normal before a
default timing run, or a session raised with `prio set`) and keeps its rank within its level; a
timing run of the same level queued meanwhile goes after the whole series. A capture that
loads a page (capture.mjs, and the first view of a capture-set page) takes its slot only once the
page has generated its world: until then it holds the page's GPU device back (the page waits in
`requestDevice`), so the world's CPU work in its workers (tens of seconds when it is not cached)
runs without a slot and without GPU work, and the slot covers the GPU set-up, warm-up and shot (a
page that does not mark its world, `window.__PONLAI_WORLD__`, takes it at the renderer's start). Under a
`run --shared` wrapper the first capture takes the wrapper's slot over and the wrapper holds nothing
from then on, so a wrapped orchestrator never holds a slot its own captures wait for.
Exclusive and shared requests wait in one queue under one rule: they rank by level, then first in,
first out, and a request starts when nothing ranked before it still waits (an exclusive one once
every holder has left, a shared one when a slot is free; a shared one may start beside a shared
head while that leaves the head a slot). Nothing ranked after the head holds it up. The levels,
highest first: `urgent` (the user's own runs), `high`, `normal`, `low` (or 0-3). By default shared
requests are `normal` and exclusive ones `low`: timing runs get no special treatment and rank below
captures and probes. A default timing run ages: 30 min after its run's first request
(`AGE_AFTER_MS`; a `keepPlace` run such as profile-frame's scenes counts from its first scene's
request) it ranks `normal` (source `aged`), keeping its ticket, so it goes before the captures that
queued after it, still after `high` and `urgent`. Only the default ages: a request at a level from
the table, `PONLAI_GPU_PRIORITY` or a bump keeps it (a session set to `low` stays low), and shared
requests never age. `PONLAI_GPU_LOCK_AGE_S` shortens the threshold for the lock's own tests only.
To start sooner than that, raise it. Scheduling is done by the user or a main session with the scheduling table,
never by a session itself:

    node tools/gpu-lock.mjs prio                                   # the table, every holder's and ticket's level and where it comes from
    node tools/gpu-lock.mjs prio set m11-tune high --for 90m --note "timing round"
    node tools/gpu-lock.mjs prio clear m11-tune
    node tools/gpu-lock.mjs prio bump <pid|#ticket> urgent         # one request (kept for that process's later requests)

An entry's match is a substring of one of a request's session names or of its label. The session
names are the names of the checkouts (a worktree, or the main checkout) that hold the script the
request runs and its working directory, and that directory's own name. So a tool started by its
absolute path from another directory is still matched by its worktree's name, and the main
checkout's name matches only requests from the main checkout. The longest match wins, an entry past
its `--for` is ignored (and dropped at the next write), and the level applies to all the session's
requests, shared and exclusive alike. `prio set` lists the holders and queued requests the entry
applies to now, and warns when there are none (a typo, or a session that has not asked yet). A
request's level is, first match wins: a bump, the table, `PONLAI_GPU_PRIORITY`, its mode's default.
`prio bump` takes a pid (a queued request's, else a shared holder's) or a ticket number as `#n`; it
refuses an exclusive holder (it already has the GPU to itself: bump its next request) and an older
copy's request (below). Sessions never set `PONLAI_GPU_PRIORITY` (every child inherits it). The
level is worked out whenever the queue is ranked, so a table change reorders requests already
waiting. `prio --json` prints only the JSON.
Levels hold only among copies of the lock that know them; copies in worktrees branched before the
entry below still run their own rules. This copy ranks an older copy's requests at their mode's
default (shared `normal`, exclusive `low`; source `older copy`), and neither the table nor a bump
moves them: raised in this copy only, an older exclusive request and this copy's shared requests
would wait for each other. Older copies rank by their classes (`normal` first in, first out, then
`low`); main's copy from before the levels lets shared requests pass an exclusive one for up to
30 min, a copy from before that lets nothing pass it. This copy's requests tell them `low` below
normal and `normal` otherwise, so the copies agree on the defaults. Where they still disagree the
cost is a delay, not a deadlock:
- a raised (high, urgent) request of this copy goes before an older copy's earlier request here
  but not there, so both start when they can;
- an older copy's exclusive request ranks `low` here, so it waits while this copy's captures keep
  arriving, like a default timing run (that copy's own captures queued behind it wait with it);
- an older copy run with `PONLAI_GPU_PRIORITY=low` and this copy's normal captures can each wait
  for the other's request with one slot free, until a second slot frees or 10 min pass (that copy
  promotes its low requests then); sessions leave the variable unset.
A copy from before the tickets announces its exclusive request in a waiter file, which holds back
every shared request while it waits. A killed holder's slot frees itself at the next look, and a
killed request leaves the queue.
One implementation runs on the machine: `tools/gpu-lock.mjs` is an entry that loads the lock from
`tools/gpu-lock-impl.mjs`, either its own worktree's or the main checkout's, whichever declares the
higher `LOCK_VERSION` (the main checkout's on a tie; a main checkout from before the entry counts as
version 0). So a branch runs every later lock upgrade as soon as main has it, without merging main,
and once every worktree has the entry, copies with different rules no longer share the lock. If the main checkout's file does not load
(a conflict mid-merge, a syntax error), the worktree's runs and stderr says so. A change to the lock
goes in `gpu-lock-impl.mjs`, bumps `LOCK_VERSION` and keeps its exports and CLI additive; test it
with `PONLAI_GPU_LOCK_IMPL=local`, which forces the worktree's copy. `status` ends with the file
that runs and why (`impl` in its JSON).
`node tools/gpu-lock.mjs run [--shared] [--label x] -- <command ...>` wraps any other script,
`status` names the holders (shared: their slots; each with its level and source), the queue in turn (each with its
estimated start, below) and the exclusive requests in turn (`waiting`), and `gpu` shows the GPU's
utilisation and the processes using it. A request that waits prints a timestamped line
every 30 s: its place in the queue, the next in turn, who holds the GPU (the exclusive holder or
the shared slots' labels) and why it waits (an exclusive request ahead, requests of a higher
level), and,
when it starts waiting and whenever the figure moves by more than a minute or a quarter, its
estimated start: `estimated start in ~12 min (range 7 min-25 min, estimate)`.
The estimate is also in `status` (`eta: { startIn, range: [ lo, hi ], basis }` on every queued
request, in seconds from now) and in `node tools/gpu-lock.mjs eta [--shared|--exclusive] [--level
l] [--json]` for a request made now (at this shell's level unless `--level` says otherwise) (`--pid p` for a waiting one). It is an estimate, not
a schedule: the queue is run forward under the lock's rules 200 times, each hold lasting a duration
drawn from what holds of that kind took (the log's recent releases of the same tool and mode,
`profile-frame` per mode; a built-in table until the log has five of a kind: `basis` counts which).
`startIn` is the median start over the runs and `range` its 10th to 90th percentile. Requests made
later are not foreseen, so a request can start after its range when work of a higher level keeps
arriving (a default exclusive request while captures do). To choose between waiting and handing work back, compare
`startIn` with the threshold (the range's upper end is cautious: it adds the spread of every hold
ahead).
Every request, grant, release, timeout and abandoned request is appended to a JSON-lines log next
to the lock (`ponlai-gpu.lock.log.jsonl`, rotated to `.log.1.jsonl` past 4 MB): time, pid, label,
mode, class (the level), source (of the level: bump, table, env, default, aged), ticket, a
request's parent pid and working directory (`ppid`, `cwd`: who asked), wait or hold in ms, and why a hold ended when its holder did not end it (a
child took the slot over, a yielded slot, a killed holder reclaimed as stale, a lease given up for
a waiter; a leased hold's release counts the views it served).
`node tools/gpu-lock.mjs log [--since 2h] [--by class|label] [--top 5] [--json]` summarises it:
requests, waits and holds per group (median, p95, total; uses of leased holds, lease yields,
take-overs, timeouts, abandoned and stale counted apart) and the longest waits with the holds that overlapped them, so a report can say how
long a run queued and behind whom. The profiler also checks that the GPU is idle before it
measures and marks its results contended otherwise. Keep other pages that render the scene closed.

## Long jobs and waiting: `tools/job.mjs`

Every wait goes through `tools/job.mjs`: a command that may run longer than a few minutes (a
capture set, a profile, a build of the references) runs as a job, and whoever waits for it, or for
anything else, waits with `job.mjs` rather than a loop of their own. Its header is the full manual.

    node tools/job.mjs start --wait -- npm run build                        (inline when it is short)
    node tools/job.mjs start --log artifacts/plans/<topic>/data/set.log -- node tools/capture-set.mjs ...
    node tools/job.mjs wait artifacts/plans/<topic>/data/set.log          (repeat until it exits 0 or with the job's code)
    node tools/job.mjs stop artifacts/plans/<topic>/data/set.log          (before handing back with it still running)

Forms:

- `start [--log file] -- command` runs the command detached (it outlives the calling shell) and
  returns at once; `run` runs it in the foreground. Without `--log` the log goes to
  `<repo top>/artifacts/jobs/<UTC stamp>-<command>.log` and its path is printed. The log holds the
  command's output between a start line and an end line, `[done] exit <code> at <time> after
  <duration>`, with ` (stopped)` when the job was stopped. A single argument after `--` runs
  through `sh -c` (pipes, `&&`), several run as they are. A single argument with an unquoted `&`
  inside a word (`--view near:like=a&dist=40`) is refused with exit 2: quote that word.
- `start --wait [--lines n] -- command` starts the job the same way and waits on it within the
  budget: when it ends, it prints the log's last lines (20) and exits with the command's code;
  otherwise it exits 124 and prints the `wait` to call next. Nothing is killed at the budget, so a
  command that may be short or long needs no guess: run it this way in the foreground.
- `wait <log>...` returns when every job has ended, exiting with the first failing job's code (0
  when all succeeded), or at the budget, exiting 124 while any still runs: call it again. A job
  whose runner was killed before its end line counts as ended (lost, exit 1), and a file that is
  not a job's log fails at once (exit 2), so no wait can hang on a line that will never come. It
  prints one screen: each job's state and elapsed time, where it stands in the GPU lock (holding a
  slot or the lock alone, or queued: its place, the requests ahead of it and the holders), its
  log's last lines, and the lock as a whole. Wait on several jobs with one call.
- `wait` with a condition instead of logs: `--file F --match RE` (a line of F matches),
  `--exists F`, `--pid N` (the process has exited) or `--cmd 'shell'` (it exits 0; each run is
  killed at the deadline); with neither it is a plain timer. It prints `done after`, `still waiting
  after` (exit 124) or `timer ended after`, with the budget; `--tail F [n]` adds F's last lines.
- `status <log>...` prints the `wait` screen without waiting.
- `list [--cwd dir | --all]` shows the running jobs started under the current repo top, under a
  directory, or anywhere, with the same screen. Every `run` and `start` registers itself in
  `ponlai-jobs/` beside the GPU lock (a scratch `PONLAI_GPU_LOCK_DIR` moves it too).
- `stop <log>... | --cwd dir | --all [--grace 10]` ends jobs with everything they started: it
  sends SIGTERM through the job's runner, so the tools run their own cleanup (lock release, browser
  close), and after the grace SIGKILLs whatever is left of the job's process tree, children that
  detached into their own group included. `--cwd dir` matches only jobs in dir's own checkout
  (nearest `.git` entry), never a worktree nested under it. An agent hands back with nothing of its own running.

Budgets (roles). A wait ends at a wall-clock deadline counted from its start, whatever the load.
`--role agent` (the default) waits at most 240 s, because an agent's prompt cache lives five
minutes between its requests; run it in the foreground with the Bash tool's timeout above that,
one wait per message. `--role main` waits at most 3300 s, under a main session's one-hour cache: a
main session keeps `wait --role main` running in the background while it waits on agents or jobs,
and re-arms it each time it fires. `--max s` only lowers the budget.

## Disk space: `tools/storage.mjs`

Captures, clip frames and references are removed by age and held under a cap, so the disk does not
fill with frames read once (in a week they reached hundreds of GB). `job.mjs` starts
`storage.mjs clean --auto` in the background every 6 hours; nobody runs it by hand.

    node tools/storage.mjs                 what each kind holds and what a clean would remove
    node tools/storage.mjs clean           remove it now ([--days 2] [--cap 50] [--floor 12])

- Images and videos of 256 KB or more under `artifacts/{plans,archive,perf,verification,crops}` go after
  2 days, unless a report or page (.md, .html) there links to them: what the user reviews keeps
  its pictures. `artifacts/captures` (one-off screenshots) keeps them 7 days. Reports, JSON and
  small images stay; other artifacts folders are never touched.
- A commit's folder in a reference store goes once unused for 2 days, unless the commit is live (a
  worktree's HEAD, a branch tip committed to in the last 7 days, or where such a branch leaves
  main).
- Past that, the oldest go while those images (but `captures`) and dead references hold more than
  50 GB, never one less than 12 hours old.
- Idle browser profiles go after 2 days; an idle capture slot's caches past 512 MB are dropped
  (one cold load). Leftovers in the temp folder go after a day; Claude Code's temp folder of a
  session idle for 3 days goes.
- To keep a set longer (a reference a later task needs), put a `.keep` file in its folder.

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
run that is not allowed now is recorded as pending and run later in one batch. Before the window
opens, the tool posts a desktop notification (`announceHeadedRun`) and waits 10 s.

The gate is a switch, not a reason to go headed. A run is headed only for what a screen alone
shows (Frame profiler, `--display`): pacing and cadence, late frames, the frame pacer's rate, the
dynamic scale under a player's drags, and the display tools' own tests. Everything else, GPU cost
and tuning included, runs headless. A headed run covers at most 3 scenes, and whoever dispatches
one tells the user beforehand, as information rather than a question.

## Frame profiler: `tools/profile-frame.mjs`

```
node tools/profile-frame.mjs [url] [--scenes a,b] [--w 1920 --h 1080 --scale 2] [--quality high]
  [--timestamps on|off|both|auto] [--eval "js"] [--repeat n] [--shots] [--vsync] [--accept [--strict]]
  [--idle-wait s] [--contended] [--load-timeline off] [--hang s] [--scale-log]
  [--scales 1.5,1] [--scale-settle s] [--display [--motion user|orbit|none] [--window WxH]]
  [--drs-store] [--frame-fallback] [--unpinned]
```

- Profiles a production build (`npm run build && npm run preview`; the url defaults to its port)
  in headless Chrome (`CHROME_PATH`, else the system Chrome) with the frame rate uncapped, or at
  60 Hz with `--vsync` (the intervals a player sees; uncapped, a GPU-bound scene's p95 is mostly
  pacing noise).
- It plays a matrix of named scenes (`--list`: `island-fair-noon`, `island-clear-golden`,
  `horizon-fair-noon`, `sky-cloudy`, `island-overcast`, `island-night-clear`, `meadow-close` (over
  the meadow, placed on the camera's ground, `controls.ground`); the parked weathers' `island-rain`, `island-storm`, `horizon-storm`,
  `island-fog-dawn` and `weather-change` (a front sweeping in) run only when `--scenes` names
  them, and `--scenes` takes these ids), each with the clock running, fixed weather
  and a slow orbit, and writes `artifacts/perf/<label>/` (profile.json, summary.md): frame interval
  median, p95 and p99, GPU time per pass, the tick's JS time, hitches with their cause, and the
  startup.
- It loads each variant once and switches scenes at runtime (`--mode reload` reloads per scene,
  the original method); every page keeps the generated island's chunks in IndexedDB (in the
  tool's own Chrome profile) while the generator's sources are unchanged (`--world-cache off` loads with
  `worldCache=off`). A profile that another Chrome holds (another run's) is not launched on: the
  run takes a temporary one, with cold caches. (Launched on, a headed Chrome holding it opened a
  blank window of its own, in front of that run's page.)
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
- In full-screen `--display` the idle checks run with the run's window up (the opening one on its
  blank page) and sum the GPU time of the clients other than the run's Chrome and WindowServer:
  full screen hides the other windows and they stop drawing, so the GPU's utilisation before the
  window opened counted a load the run never meets and refused runs for nothing. With `--window`
  the check stays the utilisation's: the other windows stay on screen and their load is real.
- When its opening idle check still finds another client keeping the GPU busy after
  `--idle-wait` seconds (20; 60 with `--mode reload`), it names the client, measures nothing and
  exits with 3, releasing the lock: a contended run's numbers prove nothing. Stop the client and
  run again, or pass `--contended` to measure anyway (results marked contended, as before). A
  later page load that finds the GPU busy still marks its results contended. Every summary.md
  marks such a scene `(contended)` in its table, a compare's as a single profile's.
- The idle checks see a few seconds before a load or a scene; the load timeline sees the whole
  run (macOS; `tools/load-timeline.mjs`). From the exclusive lock's hold to the end of the run, one
  streaming `top` and a loop of one-second GPU client samples write `<out>/load.jsonl`, a line a
  second: `{ t, cpu, gpu }`, each by group (`run`: this run's Chrome and its descendants,
  `windowServer`, `app`: the desktop app, `otherChrome`, `kernel`: CPU only, `rest`), t in ms since
  the epoch (a page's frame time plus its `performance.timeOrigin`). Each measured slice (a
  compare's slice, a toggle's block, a profile scene's window) gets `load: { cpu, gpu }`, the mean
  outside the run (every group but `run` and `windowServer`, which composites the screen for every run)
  over its window; a slice whose outside GPU mean exceeds `--idle-threshold` (15 %) is contended,
  and a scene with more than a quarter of its slices contended is marked contended (with the
  verdict rules above). The summary's "Machine load outside the run" gives each scene its
  contended slices and mean outside load. `--load-timeline off` turns it off. It replaces the
  ad-hoc top and GPU sampler scripts run beside a profile.
- A run with several scenes holds the exclusive lock one scene at a time (every mode: profile,
  compare, toggle, accept, reload): before a scene's warm-up it asks for the lock, after its last
  slice its pages stop and drain. The pages and the browser stay open, their loops stopped, so
  they draw nothing while the lock is away. The hold is a lease (`leaseGpuLock` with
  `keepPlace`): kept from scene to scene while no request ranked before the run's first one
  waits, otherwise given up and asked for again at once under that request's ticket number, so
  queued captures (normal, before a default low timing run) run between the scenes instead of
  after the whole run, and a timing run of the same level queued meanwhile still goes after it. A hold taken again checks the GPU for idle; still busy after `--idle-wait`, the
  run stops with the finished scenes written and exits 3, unless `--contended` (that scene marked
  contended). The first scene's hold covers the page loads. `wallSeconds` counts only the time
  held; `meta.holds` lists each scene the lock came back for (its wait and the GPU idle with this
  run's pages stopped), also under "Lock" in summary.md. The run's last lines give the time held
  and, apart, the time in all without the waits for the lock (before the run, for the preload's
  slot and between scenes).
- A scene that shows no progress for `--hang` seconds (180) is recorded as hung (profile.json
  `meta.hung`, a section of summary.md), with the step it was at (a compare's load, warm-up,
  slice, trace end or results; at a scene's start, the halt, the cover, the lock's wait or its
  idle check) and what each page still did (answering, visible, its animation
  and scene frames over a second). A scene whose browser or page closes or crashes under it (a
  headed window closed, Chrome gone) is recorded as lost the same way, as is a scene whose setup
  or placement throws in the page (`meta.hung[].failed`: the error). Either way the browser is
  closed (killed when it is still open after 30 s, so it neither runs on nor holds the profile)
  and opened again, and the run goes on with the scenes not finished yet; the runner given up
  takes no lock and counts as no progress. A second hung or lost scene stops the run, with the
  finished scenes written as usual. Each scene's results are also appended to `scenes.jsonl` in
  the output folder as it finishes, so a run that dies otherwise still leaves what it measured,
  and the meta known at the start to `meta.json`. `--report <dir>` (or `<dir>/scenes.jsonl`) on
  a folder without a `profile.json` (a run that crashed, was stopped or handed back) rebuilds
  `summary.md` from them with the reports a finished run uses (A/B deltas and their intervals per
  timestamps pass, a profile's tables and verdicts, the load table from `load.jsonl`). The summary
  says the run is unfinished and lists the scenes left out for a missing variant or pass; it
  writes no `profile.json`. Without `meta.json` the meta it cannot read from the scenes is `?`.
  `--report` opens no browser and takes no lock.
- Each page's `clockPaused` and `scalePinned` (diagnostics) are read at its load as its baseline
  (`?dpr` pins legitimately) and again after every slice or measured window. A change (a key or
  click reached the page: a Space pauses it, and a paused page renders at its nominal scale and
  stops steering, spoiling every scene after it) stops the run as a second hang does, with the
  finished scenes written (`meta.spoiled`, a section of summary.md), and exits with 1; the message
  names the page, scene and slice.
- `--compare urlA urlB` (the other build from `serve.mjs preview --sha`) runs A and B as two
  pages in one browser, in alternating slices with the other page stopped, and reports deltas
  with their 95 % interval, each page's render scale per
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
  (the running page brought to the front; the drags run in the measured slices only, each page's
  on from where its last slice left them, so A's and B's k-th slices see the same motion from the
  same view; the screen changes to the other page's view at every switch, but never back to the
  scene before: a page switches scene stopped and out of sight and comes to the front with the
  new scene drawn; the surface Chrome kept from its last time in front is a cover, raised before
  the page left the front for the last time in the scene and dropped once the new scene is on
  screen, so a switch shows the loading screen's colour for a frame or two, and a scene other than
  the run's last shows it once where the page that ends its slices first leaves), so the drift between separate headed runs (a millisecond or two) cancels;
  its summary adds the share of late frames (presented intervals longer than the pace each frame
  was rendered at, the frame pacer's divisor then) per slice, as a delta with its interval, each page's frames over 25 ms, its effective rate
  (rendered frames per second) and its share of frames at the pacer's fallback rate. One trace
  spans a scene's slices of both pages, split by a performance mark per slice (ended early at each
  adaptive stop check); a trace per slice nearly doubled the time a slice took beyond its settle
  and window.
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
  waits after each scene's warm-up until that scale has held for s seconds (in `--compare` each
  page after its own warm-up; without it the run's first slices catch high's scale still stepping
  down from its nominal). `--display --compare` settles 2 s by default (`--scale-settle 0` turns it
  off); every other run 0. With GPU timestamps on,
  high's reports add `gpuPixel`: the part of the GPU time in passes that follow the render's pixel
  count (the dynamic resolution's split), for fitting its cost model at fixed scales.
- `--compare` and `--accept` load their pages with `drsStore=off`, so neither side of an A/B (two
  AA modes, two builds) starts from a dynamic scale the other or an earlier run settled at;
  `--drs-store` loads them with `drsStore=on` instead (a returning load).
- `--compare` and `--accept` also load their pages with `frameFallback=0` (the pacer holds the tier's
  rate, so both sides of an A/B run at one pace); `--frame-fallback` keeps the automatic fallback
  (72 -> 48 fps on a 144 Hz display) on.
- `--eval` runs in the page with `s` = `window.__PONLAI__` (an ablation, e.g.
  `--eval "s.pipeline.settings.dof = 0"`); `--report profile.json` re-renders a summary (`--report <dir>`
  rebuilds an unfinished run's, see above).

### Measuring frame time

- Measure on a production build, under the GPU lock: the scene matrix at the default generic
  display (1920x1080 CSS at DPR 2, quality high), before and after a change (`--compare` for an
  A/B, or `--toggle` on a debug flag while the change is in development).
- Judge an A/B by its GPU time per pass (timestamps on); take frame rates from a run without GPU
  timestamps (`--timestamps off` or `both`): Chrome ran frames up to a quarter faster with them
  on, so their per-pass split shows where the time goes, not the frame rate a player sees. (High
  keeps its dynamic resolution's own timestamp queries in every run, as a player's page does;
  `--q gpuTimer=off` leaves them out.)
- High is timed at its baseline by default: 4K output (1920x1080 CSS at DPR 2) rendered at 1440p
  (2560x1440, scale 4/3), the level every trade-off is judged at, with about 14 ms of GPU time a
  frame in the normal scenes (island views, `meadow-close`) as the budget. A profile, `--compare`
  or `--toggle` of high pins that scale (`dpr=1.3333333333333333`: two thirds of the viewport's
  ratio); `--unpinned` leaves the dynamic resolution steering, with `--scale-settle 5 --scale-log`
  to see where it settles. `--accept`, `--display`, `--scales` and a `dpr` of the url's or `--q`'s
  own are never pinned.
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

Whether a grown page draws what a fresh load of its land draws (views, chunk hashes, the rain
map, the camera's ground, pipelines and memory across swaps): `tools/verify-growth-swap.mjs`, not a
probe eval of one's own.

## Writing a tool

- Build on the shared modules instead of copying them: `capture-browser.mjs` (browser, warm
  profiles, readiness), `parity/reference.mjs` (stored references), `parity/views.mjs`,
  `parity/pixels.py` (image metrics), `gpu-lock.mjs`, `job.mjs`, `qos.mjs`.
- The header comment comes first: the usage line, what the tool guarantees (what it compares or
  measures, and under which conditions), its rules with their reasons, and its outputs. Options
  it does not know are an error, not ignored. A change that makes a check faster keeps that
  guarantee true (a scene-jump check compares jumps with fresh loads, not with other jumps).
- Output goes to files (images, JSON a script can read) with a short summary on stdout. Exit
  codes mean something: 0 passed, 1 failed, and 3 for contended (the GPU was busy, nothing
  measured). A long tool prints progress lines, so `job.mjs wait` shows where it is.
- A tool that renders takes the GPU lock (`gpu-lock.mjs`): shared for paused captures and probes,
  exclusive for timing. It holds the lock per piece of work where it can (`leaseGpuLock`), so a
  long run gives way at its boundaries to a request ranked before it. It never holds a slot while
  it does CPU work or waits for something else.
- Readiness comes from the page, never from a fixed frame count or a sleep. Use
  capture-browser's `waitForScene` and `waitForStable`, or the diagnostics' `settled`. A fixed
  40-frame wait passed or failed by chance on a busy GPU.
- Expensive results that depend only on the commit, the tool and the browser are stored and
  reused through `parity/reference.mjs`; record in the key everything that changes them.
- CPU-heavy node tools import `qos.mjs` first. Python tools declare their dependencies inline (PEP
  723) and run with `uv run`; image metrics come from `parity/pixels.py`.
- Tools are shared by every session's worktrees. A tool change goes to main promptly, and the
  sessions using it are told. Older copies in other worktrees are not kept compatible: those
  sessions update. The GPU lock runs the newest implementation on the machine, so a rule change
  bumps its `LOCK_VERSION` (`gpu-lock-impl.mjs`).

## Other tools

- `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows, water and wave
  optics (each file names the server it expects); they take the GPU lock (shared).
  `verify-optical-interface`, `verify-frame-graph-gpu`, `verify-water-energy`, `verify-refracted-sun`,
  `verify-solar-shadows`, `verify-wave-optics` and `verify-water-volume` import `/src/` modules and
  need the dev server: on any other server they exit 1 at once (`tools/dev-server.mjs`).
  `tools/verify-scene.mjs` checks a production preview. `tools/verify-scene-jump.mjs` captures the
  parity views reached by scene jumps in one page and as fresh loads, for `diff-set.py`, each shot
  ready by capture.mjs's stability rule (`tools/parity/README.md`, One page, many views);
  `--check <root>/<sha>/<set>` runs the whole check (the stored set of fresh loads, a page per
  view, both jump orders at once, the diff) in one command. `--view "name:query[::js]"`
  (repeatable) adds ad-hoc views with capture-set's syntax (`like=<view>` included), so a jump
  into a new scene option is checked as `--views island-fair-noon --view near:dist=40`; their fresh
  loads are stored with their definitions' hashes, so a changed query captures a new reference.
- `tools/verify-zoom-anchor.mjs [url] [--runs 24] [--out file.json]` checks the island camera's
  anchors in one probe page: wheel zooms with the cursor over the sea (`--runs` times) and over
  land, a pinch out and in, and a drag; it fails on any zoom anchor that found no ground or a drift
  of the point under the cursor of 0.5 px or more. Run it after a change to the island camera or
  its ground (`src/camera/`).
- `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs`, `verify-wind.mjs` and `verify-game.mjs`
  are CPU-only (plain `node`). `verify-game.mjs` checks the game's simulation: the clock, the
  ground and a path, a body walking to a point, a save round trip, a brain's late answer, and the
  first prototype's rules (needs, the bag, the palm, fishing, the chest placed as a blueprint and
  built, several chests with stable ids, two builders on one site, the actions, the perception, the stand-in brain over a few game days, a save mid-action); its island is in
  `tools/game-fixture.mjs`.
- `tools/verify-growth-shape.mjs` (plain `node`) checks the island's growth over 32 seeds and 36
  steps: the coast's solidity, elongation and share along the lattice axes, that a grown land
  equals the same steps taken one at a time through a saved land, and the lattice's margin; it
  writes a sheet of eight seeds to `artifacts/growth/shape-sheet-<label>.png`.
- `tools/verify-world-chunks.mjs [--seeds 1,2] [--steps 12] [--threads n] [--long] [--bench]
  [--sheets dir]` (plain `node`; run it before captures after any change to the world's generator)
  grows each seed's land step by step and builds every chunk of every step (`src/world/Chunks.ts`)
  on a pool of worker threads (default min( 8, cores - 4 )). It checks that the chunks built
  incrementally equal a scratch build in a fresh process in reverse order (D1), on pools of 1 and
  4 workers (D2, the 15 costliest chunks), that the land does not depend on the order of its
  pieces (D3), that only chunks in `dirtyChunks` change between steps (D4, warning when a changed
  chunk lies more than 30 m from the changed land), and that land placed just beyond the dirty
  bound (34.6 - 44 m from a coastal chunk, on the coast and offshore) changes nothing (D5); at
  steps 0 and the last, the seams: the
  island and stone meshes close up (S1), the island's shared vertices and a 2 x 2 block meshed
  whole (S2), the floor tiles' shared points, the floor at or below -1.6 m off the land and the
  tiles' outer sides on the open sea's lattice (S3), the rim's lip's border crossings (S4), a
  2 x 2 block's rim ground, shore, walk texels and anchors made in one pass (S5),
  the stones' owners and their copies in the neighbours' contact sets (S6), no island vertex or
  anchor near a chunk that carries no rim ground tile (S7), and no buried wall inland (I1). `--long` takes D1 at every step, D2 on all chunks of both seeds, the S checks at
  every fourth step and the island's inland column range against whole columns. `--bench` keeps
  only D4 and prints per growth piece the land field's time, the chunks rebuilt and changed,
  their CPU time and bytes. Every run writes a chunk sheet per seed (each step's land, new piece,
  16 m grid, dirty chunks outlined, changed chunks tinted) to `--sheets` (default
  `artifacts/captures/world-chunks/`). The checks' definitions are in the script's header. The
  pool's 1219 chunk builds dominate the time: the default run took 6 minutes and `--long` 14 on
  8 threads of a machine busy with other work, `--bench` 4.
- `tools/verify-world-stats.mjs [--seeds 1,2] [--grow 0,8] [--threads n]` (plain `node`) builds
  every chunk of whole islands on a pool of worker threads (`buildChunk`, contact shade off) and
  checks the statistics of the union of what they own, with the bounds the look was tuned on: the
  meadow's anchors, tufts and flowering tufts per m^2 against M2 (grown islands summed, 5 %; the
  flowers also printed by species, and `--flowers <dir>` writes each island's turf anchors and
  flowering tufts as JSON to map them); the stones'
  overlaps, crowns and reach per island, and over seeds 1 - 6 at steps 0, 8, 16 their classes and
  large sizes per 100 m of coast against today's (20 %) and their gathering below the scars; the
  cliff's scars, on each chunk's own wall: none cuts rock beyond its reach (4.5 m, 3 m) and none
  breaks off more than 0.6 m of rock above y -1 where its reach ends it. The
  chunk checks prove seams and locality; this probe proves the chunked world keeps its numbers.
  The default run takes about a minute on 8 threads.
- `tools/verify-chunk-derived.mjs [--seed 1] [--steps 0,8] [--threads n]` (plain `node`; run it
  after a change to `src/world/ChunkDerived.ts` or to the builders it stands in for) builds every
  chunk of the grown land on a pool of worker threads and checks the chunks' derived products,
  which the page uses, against the builders it ran before on the merged meshes (three's WebGPU
  build imported in node, RefractedSun.ts compiled with TypeScript): SunShadow's caster columns
  folded from the chunks' `casterColumns` hold every walked column and stay within one cell of it;
  RefractedSun's subsets from the chunks' `refracted` are today's cut of the merged island, stones
  and floor, triangle for triangle, and `setCasters( root, subsets )` draws them;
  `IslandGround.fromGrids` of the chunks' `ground` has the walked grid's bounds and top and every
  height within one cell. It prints each builder's time on the merged meshes against the merge's.
  About 15 s on 8 threads.
- The three world verifiers above (`verify-world-chunks`, `verify-world-stats`,
  `verify-chunk-derived`) skip a run whose inputs passed before: each pass is recorded under a key
  hashed from the node version, the run's arguments and every source file the verifier loads (its
  import graph walked from the script, plus `package-lock.json` when it imports a package), and a
  run with the same key prints one line (`skipped, these inputs passed at <commit> on <time>`) and
  exits 0 in about a second. A change to any file the verifier reaches, a comment included, or
  different arguments run it again; `--force` runs it anyway (and records the pass again).
  Failures and interrupted runs record nothing, and `verify-world-chunks --bench` is never skipped
  nor recorded. A skipped `verify-world-chunks` writes no chunk sheets. The records are JSON files
  in the main checkout's `artifacts/verify-cache/` (git-ignored), shared by every worktree, so a
  pass proven on a branch counts on its merge; delete the folder to forget them all. The helper is
  `tools/verify-cache.mjs`.
- `tools/verify-storage-realloc.mjs` (GPU, headless, shared lock; it serves its own page from a
  Vite server over the repository) checks what three's WebGPU backend does with storage buffers,
  for pools that outgrow their capacity (the meadow's, `vegetation/VegetationCull.ts`): rewritten in place and
  replaced by larger ones (a storage node's new `value`), under a compute kernel and an instanced
  draw, counting the pipelines, shader modules and bind groups the device creates and checking
  the results. Run it again after a three upgrade.
- `tools/verify-framegraph.mjs` checks the frame graph's compiler and runtime on the CPU (plain
  `node`); `tools/verify-frame-graph-gpu.mjs` checks three's cache-key patches (with plain
  materials, and with the app's vegetation and spray drawn by a fresh renderer under a shadow
  pass and their pass's MRT, both ways round) and the motion vectors' blends on the GPU;
  `tools/verify-first-use.mjs` counts the pipelines any step still creates after the warm-up
  (`--aa msaa,taa,taau,off --quality high,medium,low` runs the whole matrix, a page per run, the
  parked tiers included; its
  `weather` and `bolt` steps reach the parked weathers and run only when `--steps` names them).
  The load is judged as a step of its own, `load`: no frame of the 60 after the first may create a
  pipeline synchronously, nor may the first frame's redraw of the sun's shadow map.
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
