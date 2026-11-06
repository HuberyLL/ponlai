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
  answers and prints the URL and the `job.mjs stop` command that ends it. The URL it prints is
  always its own server's: it reports success only while its job runs and the job's log shows
  vite's ready line for that port, so a port another session takes at the same moment never
  passes for its own. When vite finds the port taken it tries the next free one (with `--port N`
  it exits 1 naming the holder). It serves the checkout
  the cwd is in, whichever copy of serve.mjs runs (outside the repository it exits 1), and its
  first line names that checkout's path, HEAD and branch.
- `node tools/serve.mjs dev|preview --sha <rev>` serves another commit: a detached worktree at
  the main checkout's `.claude/worktrees/sha-<12 hex>`, made once and reused. Its node_modules
  links the main checkout's entries (vite's caches left out) when the commit's package-lock.json
  is the same, else `npm ci` runs there; `preview` builds once per worktree (`dist/.serve-sha`).
  The log is `artifacts/jobs/serve-<mode>-sha-<12 hex>-<port>.log` in the calling checkout.
  A commit from before the assets left git (no `assets.lock.json`) gets the files it lacks from
  the calling checkout's `public/`, in their current versions.
  `node tools/serve.mjs clean` removes every sha-* worktree; one with a live job is skipped and named (stop its job first).
- The game's assets (textures, models, fonts, baked data) are not in git: the dev server and the
  build fill the git-ignored `public/` from the release `assets.lock.json` names (Assets, below),
  so a fresh clone or worktree needs no setup.
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
- The island camera starts at the island view's pose: the land's centre in the middle of the
  frame, as far out as frames the land alone from that heading with a margin of sea (about 96 m on
  the starting island), looking 50 degrees down (`polar` 40) from the `az` heading (a land framed
  nearer with its ring of shallows keeps that framing: `src/camera/IslandFraming.ts`).
  While the camera still holds that pose it follows it when the window's shape changes, and glides
  to it (about 1.6 s, on the scene clock) when the land grows; a paused page takes it at once. The
  hand moves it (`src/camera/IslandCameraControls.ts`): a left drag grabs the ground, a right or
  middle drag (or Option / Ctrl with the left) turns and tilts, the wheel zooms toward the pointer
  out from the island view's own distance to 70 m (or that distance, if farther), never in past it
  (main.ts `islandNearest`; the review views keep 22 m); on a trackpad a two-finger swipe pans, a pinch zooms and Option with a swipe
  turns and tilts; W A S D or the arrows pan, Q / E turn, T / G tilt (straight down to 8 degrees
  over the horizon), + / - zoom, Shift speeds them up. The pivot stays over the land and its ring of
  shallows (its convex hull grown by 14 m); pulled past that, it goes on against a growing
  resistance (at most 10 m farther) and springs back once let go. R returns to the island view's pose. `cameraInput=off` (or the GUI's Camera ›
  move by hand) holds the view at its pose: Q / E or a right or middle drag then turn it about the
  land's centre, and the wheel does not zoom.
- The GUI's Performance folder (`src/debug/FrameStats.ts`, from the rendered frames' rAF
  timestamps) shows the frame rate over the last second, the interval's p95 and maximum over the
  last 5 s, the frames late by a refresh against the paced interval and the intervals over 25 ms
  since the scene showed (or the reset button), the render scale and the GPU's median frame time
  (high only), and how the quality tier was chosen.

## Assets

Every binary file the page loads (textures, models, fonts, audio, baked data) is an asset, and no
asset goes into git: a repository that keeps every version of every binary only grows, and its
history cannot be cut back without rewriting it. The assets live in `public/`, git-ignored, which
Vite serves at the site's root and copies into `dist/`. Each version of the whole set is published
as one archive (`ponlai-assets-v<N>.tar.gz`) on a GitHub release tagged `assets-v<N>`.
`assets.lock.json`, committed, pins the release, the archive's size and SHA-256 and every file's,
so a commit names the assets it runs with and a checkout of it gets exactly those back.

- The dev server and the build pull the files `public/` lacks (`tools/vite-assets.mjs`). They are
  downloaded once into git's common directory (`ponlai-assets/<release>/`, shared by every
  worktree) and copied into each checkout's `public/`. A file that differs from the lock is work
  in progress: it is kept and named. A build fails when a listed file is missing; the dev server
  starts without it (the page waits at its loading screen).
- `node tools/assets.mjs [status]` compares `public/` with the lock (missing, changed and unlisted
  files; exit 1 when it differs). `pull [--force]` fills `public/` from the lock's release
  (`--force` also replaces changed files). Downloads go through `gh` while the repository is
  private, else the release's public URL.
- `node tools/assets.mjs release [--notes <text>] [--attach <file>]...` publishes `public/` as the
  next release: it packs the whole set, creates the release with `gh` (its notes list what was
  added, changed and removed) and rewrites `assets.lock.json`. `--attach` uploads more files
  beside the archive: the masters of our own assets that the page does not load (a Blender file, a
  layered source image).
- `release --local` packs the next release into the cache and rewrites the lock without uploading
  anything (no `gh` needed); `publish [--attach <file>]...` later uploads the lock's release from
  the cache as it was packed, so the committed lock stays valid. Until then the release exists on
  this machine only: its cache must be kept, and a checkout elsewhere cannot pull it. A release
  takes the first number past the lock's that the cache does not hold, so a branch packing from an
  older lock never overwrites another branch's pack (the two locks then merge by hand: the later
  release repacked over both sets of changes).
- `node tools/verify-no-binaries.mjs [--staged | --history]` fails on an asset type, a file git
  reads as binary or one over 1 MiB in the index (`--staged`: in what a commit adds; the
  pre-commit hook runs it), or anywhere in history (`--history`). `.gitignore` refuses the asset
  types to `git add` as well.

Rules:

- A file the page loads is placed under `public/` and loaded through
  `import.meta.env.BASE_URL + '<path under public/>'` (a stylesheet: `url( '/<path>' )`, which Vite
  rewrites for the base), never from `artifacts/` or another machine path.
- Adding, changing or removing an asset cuts the next release; a published release never changes
  (a broken one is followed by the next, never replaced). The commit that needs the new files
  carries the new `assets.lock.json`, so every commit still builds with its own assets.
- A release holds only files that may be redistributed: every third-party file is listed in
  `CREDITS.md` (source, author, licence, processing) under its path in `public/` before it ships.
- A file made by a tool from a source (the moon, the stars, the Milky Way) keeps its tool in
  `tools/`; the release holds the output, and `CREDITS.md` names the tool and the source.
- Masters of our own (Blender files, layered images) that the page does not load go beside the
  archive with `--attach`, on the release whose files they were exported for. Third-party sources
  stay with their publisher; `CREDITS.md` links them.

## URL options

View and capture:

- `paused`, `t` (scene time), `dpr` (render pixel ratio, pinned), `polar`, `az` (the island
  view's tilt and heading, 40 and 180 degrees by default), `dist` (m; without it the island view
  frames the land and its shallows, IslandFraming.ts, brought in to where it frames the land alone
  from its heading when that framing stands farther; with it the camera stands that far from the default pivot), `cameraInput=off` (the hand does not move the island camera: on by default), `gui`, `camera` (`orbit`, the
  default: the island camera; or `free`: fly with the mouse, WASD, Q/E and Shift).
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
- `bamboo=cover,height` loads another look of the bamboo (src/world/BambooGroves.ts): the share
  of the land its groves hold (0 to 1) and a grown culm's height (m); either left out keeps the
  default. A load-time option, for comparing looks: the culms, their young shoots and the
  meadow's thinning under the groves follow it, the canopy's shade baked into the world's chunks
  (their sky visibility) and the ambient light's probes (src/world/AmbientProbes.ts) keep the
  default groves.
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
  `setCameraView( 'island' )`) frames the land shown; a camera that holds it glides to the new
  framing (at once while paused), one moved elsewhere (by a tool or by hand)
  stays where it is.
- `approach` (0 .. 1, 0 by default): the progress toward the next piece, the shoal under it
  (src/world/SeabedRise.ts) put on it at once; above 0 the page generates the next piece and keeps
  its loading screen up until the shoal is written, so a paused load repeats. A scene option: a
  scene jump sets it as the load does. On a page, the Island folder's Approach slider (eased over
  seconds of scene time, or at once while paused), `growth.approach( p )` (eased) and `await
  growth.approachNow( p )`; `growth.rise.state` holds the approach, R (`r`, its `target`, the R last
  `written`), the pending `tiles`, their largest `rise` (m), the `writes` and the last one's `ms`.

Sky and weather:

- `hour`, `preset` (dawn, sunrise, noon, golden-hour, sunset, dusk, midnight), `dayLength`
  (seconds), `moon` (phase: 0.5, a full moon, by default; it shapes only the drawn moon),
  `clock=paused` (freezes only the day clock; `paused` freezes it with the scene).
- `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load as established,
  already wet; without it, `wind` and `windDir` the weather and its wind evolve on their own, among
  the kept presets), `clouds` (coverage override).
- `wind` (light, gentle, fresh, strong: the wind's level, a mean wind 10 m up of 1.5, 3.8, 7 and
  11 m/s) and `windDir` (its heading in degrees: where the wind comes from, in the sea spectrum's
  convention, atan2( z, x ) in the world's x-z plane; 40 is the prevailing wind, which the
  landscape and the sea's swell keep; the wind sea turns with it), each over the sky's own wind (the gentle one from 40 for
  every kept sky, so `weather=fair` alone is the page it always was). Naming either holds the
  weather, as `weather` does; both are scene options. On a page, the GUI's Weather folder (`wind`,
  `wind heading`, over its transition seconds) or `__PONLAI__.setWind( { level, heading },
  seconds )`; `weather.windTarget` and the diagnostics' `windTarget`, `windSpeed` and
  `windHeading` show it (`src/sky/Weather.ts`). Rain, storm and fog are parked (`src/sky/Weather.ts` `PARKED_WEATHER`):
  a production page without `?debug` refuses them with a console warning and shows fair; the dev
  server, `?debug` and `?profile` still reach them.

Quality and look:

- `quality` (low, medium, high: the tier of every knob in `src/Quality.ts`; without it high, the
  only active tier: medium and low are parked, see Parked quality tiers), `tier.<knob>=<value>`
  overrides one knob for an A/B (e.g. `tier.post.hazeGrid.width=128`). The GPU timing that once chose
  the tier (`src/QualityDetect.ts`, `autoQuality`) is parked with them.

Rendering and A/B options, read at load (runtime switches for one-page A/Bs live in
`src/debug/DebugFlags.ts`):

- `aa` (the anti-aliasing mode, `src/post/Antialiasing.ts`, over the tier's `aa` knob: each tier
  has its default, high `msaa` (the parked medium `taau`, low `msaa`), and the GUI's Antialiasing
  control reloads with any of MSAA 4x, TAAU, FSR 3.1, TAA and Off. `msaa`: 4 samples, upscaled by
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
  vectors; FSR takes the composite's HDR image at the render's size, and the bloom and the grade
  run on its output at the canvas's size. A paused page shows
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
  motion clip) with a box filter, without the sharpening (the dither kept).
  `loop.step`'s `converge( i )`, where it returns true, holds the scene after frame i's tick and
  renders it until the rest has converged; `tools/capture-clip.mjs --aa gt [--gt-jitters n]` captures it that way,
  and so does a clip of one frame (`--clip rest`) under `aa=taa|taau` (their own rest sequence).
  After `loop.step`, `loop.start()` resumes the clock with a first delta of at most one frame.
- `taaResolve=off` (debug builds): the temporal modes without their resolve, the jittered frame
  shown as it renders, through the output passes with the grade's vignette and dither.
- `worldCache=off` (generate every chunk of the island instead of loading it from the browser's
  IndexedDB cache, as on a first visit; `src/world/WorldChunks.ts`). The cache keeps one record per
  chunk, so a land grown by a piece reloads the chunks the piece did not reach; the diagnostics'
  `worldCache` counts the records read (`hits`, of the chunks and the land). It keeps the records
  of the two land versions loaded last (a seed and `grow` step each) and deletes the rest after a
  load, so going back to an older step rebuilds the chunks it does not share with them.
- `terrainHex=0` (the cliff's plain triplanar tiling and smooth layer masks; for an A/B inside one
  page each cliff material swaps to its other variant through `material.userData.terrainVariant`,
  as `TerrainMaterial.ts` shows: the flag itself is read only when the material is built).
- `post=legacy` (or a comma list of `inline-composite`, `three-fsr`, `store-scene`: the frame graph without the first performance round's changes).
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
  block shows `mode`, `fallback`, `falls` and `returns`, and for the test mode's paused pages
  `queueLimit` (the frames they may keep queued on the GPU), `queued` (how many are now) and `held`
  (how many due frames waited for the queue).
- `submits=each` (three's own submit per pass, without the submit batching; at runtime
  `flags.batchSubmits`; its tracking wrappers stay installed, so compare against `main` for their
  JS cost) and `submitBatch=hold,wait,idle` (its policy, see `SubmitBatch.ts`).
- `fgOps` (the frame graph's attachment ops: `derived`, the default, per frame from the passes
  that run; `legacy`, the scene target discarded in the rain only; `store`, every store and
  resolve kept, also what `post=store-scene` and `post=legacy` choose; `off`, three's own),
  `fgPrime=0` (the warm-up renders nothing ahead, see `src/post/graph/FrameGraph.ts`).
- `fgview=<resource>[.<output>]` (debug builds: the frame graph's debug view draws one of its
  resources over the canvas, shown by what it holds, e.g. `linearDepth`, `surfaceDepth`, `FSR.easu`,
  `displacement` (the meadow's displacement field: its direction as a hue, its size as brightness);
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
  `flags=taaClampDrop:false` for a capture's or clip's `--q`. A name alone reads as `true`
  (`flags=lightOnly,ambientOnly`).
- The lighting layer on its own (`src/debug/LightLayer.ts`, read at load): `flags=lightOnly` makes
  every lit surface's diffuse albedo 0.5 grey, specular kept, so the image is the light a grey card
  returns there; `lightOnly:2` also turns the specular off; `grey:<albedo>` sets that grey
  (`grey:0.18`: an 18 % grey card everywhere, whose screen code values set the exposure and the
  tone curve); `ambientOnly` takes the key light (the
  sun or the moon, with the vegetation's and the feathers' light through them) out of the lit
  materials, leaving the sky's light and the ground's bounce. They combine: one minus the radiance under
  `lightOnly,ambientOnly` over that under `lightOnly` is a point's share of direct light.
  `opaqueVegetation` lights the vegetation as opaque surfaces (no light through a leaf or blade,
  no wrap, its ambient unweighted by its translucency), so a plant takes only the diffuse light an
  opaque card in its place would; it combines with the others.
  `albedoOnly` draws every lit surface unlit in its own diffuse albedo (over the other two), so the
  frame's linear colour is the albedo where each surface lies on screen. `occlusionOnly` (over the
  three) draws every lit surface unlit in the occlusion its ambient diffuse takes (the material's,
  the screen's where it receives it, a plant's root-to-tip occlusion), grey: the open sky the light
  uses, where the screen-space occlusion alone misses the turf's roots. The water, sky, clouds,
  haze and emission are left as they are. Off, the shaders and frames are unchanged.
  `bareGround` hides the meadow's blades and lights its turf as bare ground (`src/world/Grass.ts`
  `BARE_GROUND`): beside a frame with the blades, the light bare ground takes at the same pixels.
  `classes` draws every lit surface unlit in a code of its kind (ground, rock, grass, leaves, wood,
  figure, other: `src/debug/Classes.ts`), which `radiance`'s `aov: 'class'` decodes per cell; the
  sky and the sea are told by depth. Emissive surfaces (the yunpeng's glow) spoil their codes and
  read as no kind, and so does a pixel whose samples blend two kinds: load the page with `aa=off`
  (the cut-out leaves cover half the island's pixels in part under MSAA).
- The scene's linear radiance over boxes, as numbers (`src/debug/Radiance.ts`): `await
  __PONLAI__.radiance( { boxes: { lit: [ x, y, w, h ], ... }, image: [ 3456, 2234 ], grid: [ nx, ny ],
  source: 'opaque' } )`. Boxes are fractions of the frame from its top-left, or pixels of an image
  of size `image` (a capture's PNG, the boxes `img.py stats` takes); none means the whole frame.
  `source` is `opaque` (the default: the resolved opaque colour, before the sea, the haze and the
  post chain), `hdr` (the composite, with the sea and the air) or `meterLight` (the metering
  illuminance M). Per box: `px`, `rgb` (mean linear), `Y`, `Yp` (10th, 50th, 90th percentile of Y),
  `oklab` ( L, a, b, C, h in degrees) and `range` (the half float's limits over the stored values:
  the shares `below` 2^-14 and `above` 65504, `min`, `max`; `nonSky: true` leaves the sky out).
  The targets store radiance pre-exposed, times 2^P (`src/post/PreExposure.ts`): every value but
  `range` is in scene units, divided by 2^P, and `preExposure` is the P (stops) of the frame read.
  `exposure` is the exposure state (`ev` and its `target` in stops, the
  factor `exposure` = 2^ev on scene units, ev's `velocity` in stops a second and `moved`, 1 where that
  frame's ev differed from the frame's before: `src/post/Exposure.ts`); `grid` adds the mean colour of each cell of an
  nx by ny grid (`grid.rgb`, three per cell, row by row). Measure under `lightOnly` for the light
  alone. From a probe (`--eval "await P.radiance( { boxes: ... } )"`, after `--until "D.settled"`
  or `--frames n`) or from a capture's `-- --eval-ready @file`, which runs once the page is ready
  (a capture's `--eval` only sets the view up) and whose value lands in the capture's JSON
  (`readyEvals[].value`); one call per frame read.
  For a script that reads cells: `cell: n` averages only the n by n texels at each grid cell's
  centre and `boxes: {}` skips the boxes; `source: 'sharp'` reads the composite with the bloom added
  (before the local tone and the tone curve); `aov: 'depth' | 'normal' | 'ao' | 'class'` returns
  per cell, instead of the radiance, the view depth with the sky's and the sea's shares, the world
  normal, the screen-space occlusion or the kind (`src/debug/RadianceAov.ts`); `rings: { sun, step,
  count, sky }` the luminance in rings of angle around the sun before and after the bloom, and over
  the sky's band 30 to 60 degrees from it.
- Tunable parameters (`src/debug/Tune.ts`, debug pages): `__PONLAI__.tune.list()` names every
  registered number (its value, default, range, scale, and whether it is read at load),
  `tune.set( { name: value } )` sets them with no reload and no new pipeline (a load-time one needs
  `tune=<base64 JSON>` in the URL, which applies before the materials build; `tune.query( values )`
  writes it) and reports a combination the code cannot use (`invalid`), `tune.reset()` restores the
  defaults. At the defaults a paused frame is byte for byte the frame without them. Names:
  `post.exposure.key@high` (an exposure key per sun height, `@golden`, `@low`, `@high`, `@cloudy`,
  `@night`; the local gain's `post.localTone.hinge@high`, `high`, `low`, `width` alike), `post.tone.midGrey`,
  `post.tone.blackSlope`, `post.tone.white`; the shade's contrast `post.shade.pivot@day`, `slope`
  (`@golden`, `@day`, `@cloudy`, `@night`), the bloom's `post.bloom.strength` and the sun's glare
  `post.glare`.
- The ambient grade (`src/lighting/AmbientGrade.ts`): `__PONLAI__.ambient.current` holds the five
  knobs the table gives for the sun and the weather now (also `D.ambient`), `table` the table's own
  output; `override = true` with `manual.<knob>` replaces it from the next frame (the GUI's Ambient
  folder does the same), e.g. `--eval "P.ambient.override = true; P.ambient.manual.skyBounce =
  0.5"` before a radiance read under `lightOnly`.
- The meadow's light and the grade's switches (`src/debug/DebugFlags.ts` lists them all), for A/Bs
  of the look: `flags=meadowShade:false` (the screen-space shade and its depth pass),
  `groundCast:false`, `groundShade:false`, `grassShadow:false`, `grassClumps:false`,
  `shadowWind:false` (the plants cast their rest pose and the sun's map goes back to its stepped
  redraws; live, so `--toggle "s.flags.shadowWind = on"` times the swayed shadows); the meadow's
  make at load: `grassDensity:<k>` (blades per m^2 over the meadow's 125), `grassWidth:<k>`, `grassLod:false`,
  and `grassMask:true`, which paints the blades flat red for `img.py stats
  --cover` (`src/world/Grass.ts`), or `grassMask:exact`, which draws them unlit in a red far above
  any radiance, so each pixel's cover is exact in the opaque colour, or `grassMask:albedo`, unlit in
  their own diffuse colour (both for `tools/meadow-light.mjs`); the look taken off
  comes back by `clearShade:true`, `lowSun:true`, `tone:0.5`, `filmNight:true`; `localTone:false`
  builds the display chain without its local tone mapping. The metered exposure is shifted by the
  GUI's `exposure offset (stops)` (Post folder); its keys are `src/post/Exposure.ts`
  `EXPOSURE_KEYS`, and `await __PONLAI__.pipeline.readExposure()` reads its state back from the GPU
  (the same fields as `radiance`'s `exposure`). The grade's
  first table is generated from parameters
  (`src/post/GradeLut.ts`, `s.pipeline.grade`): the GUI's Grade table folder (in Post), or
  `__PONLAI__.setGrade( { saturation: 1.1, shadows: { tint: [ 0.95, 1, 1.05 ] } } )` from a capture's
  `::js` or a quick variant (the changes nested as the grade's own, set over it). The meadow's
  albedo against its lawn colour: the GUI's `meadow albedo (x)` or `__PONLAI__.setLawnGain( k )`; the
  cliff's above the water against its stone: `cliff albedo (x)` or `__PONLAI__.setRockGain( k )`;
  the trees' leaves against their atlas: `tree leaves albedo (x)` or `__PONLAI__.setLeafGain( k )`.
  The tone curve's slope at black, the mid grey it shows and the input that shows white: the GUI's
  Tone curve folder (in Post), or `s.pipeline.settings.curve` (read every frame; `src/post/ToneCurve.ts`
  TONE_CURVE; a set the solve cannot meet keeps the last good curve and warns, and only the default
  set failing throws, on the dev server).
  `fgview=meadowShade` shows the shade's map.
- The screen-space ambient occlusion (`src/post/GTAO.ts`, on in high: the tier's `ao` knob builds it
  and the opaque scene's depth prepass at load, `src/world/OpaquePrepass.ts`): `flags=gtao:false`
  builds without it, `flags=gtao` with it on another tier; `__PONLAI__.gtao` holds its knobs (cutoff, recede, base, maxTexels, fullDistance). At run time
  `flags.gtao = false` skips its passes and the receivers read 1 (`--toggle "s.flags.gtao = on"`
  times its passes; `--compare` against `?flags=gtao:false` the depth prepass too). `fgview=gtao.r`
  shows the occlusion the materials read, `fgview=gtaoRaw.r` the slices' before the blur.
- The local lights (`src/lighting/LocalLights.ts`: by night the yunpeng's light round its clumps):
  `flags=localLights:0` (or `false`) turns them off, at load or at run time, so
  `--toggle "s.flags.localLights = on"` times their clusters' pass and the materials' lookup (on
  a night view: by day neither runs). `flags=lightTest:N` (at load) adds N white test sources
  over the meadow, with the range and light of stand-in yunpeng clumps (the same on any land), for
  cost and overflow tests (64 and 256 are the usual loads). The GUI's Local lights folder turns them off and sets their art gain;
  `await __PONLAI__.localLights.info()` reads the last pass back: `sources` (in the table),
  `inView` (sorted into the clusters this frame), `fullest` (the most sources touching one
  cluster), `overflowed` (clusters with more than `perCluster`, whose farthest are dropped),
  `clusterBytes` and `tableBytes`; `__PONLAI__.localLights.sources` lists every source, and
  `__PONLAI__.yunpengSites()` where the yunpeng's clumps stand on the current land ( x, z, size
  per clump) with their lights.
  `node tools/verify-local-lights.mjs [seed]` checks the clusters' CPU sort, slices and lookup
  (plain `node`).
- Under the temporal modes `flags.mv.camera` / `object` = false leave a source out of the motion
  vectors, `flags.jitter = false` the jitter, `s.taaCut( reason )` cuts the history and
  `s.motionCheck()` lists the materials whose motion vectors are missing or partial.
- `vegPrepass=0` (the single coverage pass), `vegPrepass=coverage` (the prepass with coverage kept
  in the shaded draw).
- `chunkBorders` shows the world's 16 m chunks as lines above the sea and the meadow (also the
  GUI's Ground folder, `chunk borders`), to tell a seam from a chunk border.
- `ambientProbes=sky|bounce|irradiance` shows the ambient light's probes (debug pages; also the
  GUI's Ground folder, `ambient probes`; `src/lighting/AmbientVolume.ts`): a small unlit sphere at
  each probe, where it was baked, coloured by its harmonics at the sphere's normal (`sky` the sky
  visibility, white where a side sees the whole sky; `bounce` the bounced sky visibility, x8; red
  where the probe is invalid in both; `irradiance` the relight's output over pi, the light a white
  Lambertian face would reflect, in the scene's units). Built on first show, so a page without it
  compiles nothing for it. The lattice from a script: `__PONLAI__.ambientVolume.info()` (origin,
  dims, spacing, probes, bytes) and `await __PONLAI__.ambientVolume.hash()` (SHA-256 of its bits,
  the same on a grown page as on a fresh load of its land); the relight's output
  (`src/lighting/AmbientRelight.ts`): `await __PONLAI__.ambientRelight.readback()` (its texels as
  floats, with the texture's size) and `await __PONLAI__.ambientRelight.hash()` (SHA-256 of them;
  the first call builds one compute pipeline for the copy).
- The materials' ambient diffuse from the volume (`src/lighting/AmbientSample.ts`, on unless set
  off, read at load): `flags=ambientVolume:0` (or `false`) builds every lit material on the
  environment's irradiance and the ground bounce whole, the shaders as before the volume (the A/B
  of the volume, and the byte check against them; the flag cannot switch at run time, as the
  materials' pipelines differ); `flags=groundBounceLand` keeps the ground bounce's land beside the
  volume (`src/lighting/GroundBounce.ts`; by default the volume carries the land's bounce and the
  ground bounce its sea alone); `flags=canopyShade` keeps the bamboo canopy's own shade on the sky
  light beside the volume (the island's and the meadow's baked sky visibility and the culms':
  by default the volume, whose probes see the groves, carries it; the chunks bake it, so they
  are generated again, or read from their own cache entries); `flags=ambientVolumeOff:<kinds>`
  sends the receivers named (`/` between them, `all` every one: `terrain`, `stones`, `meadow`,
  `culms`, `leaves`, `figures`, else a material's name such as `yunpeng` or `fish`) back to the
  environment's irradiance, the rest unchanged. It is for timing each receiver's read of the
  volume only: the chunks' bakes and the ground bounce's land stay the volume path's, so a
  receiver sent back looks as neither path does; `flags=ambientVolume:0` gives the old path.
- `windView` makes the vegetation's wind visible (debug pages only; read at load, so without it
  no shader changes; `src/debug/WindView.ts`): flat unlit arrows every 2 m over the meadow, just
  above the grass, point where the local wind blows, longer in a gust, and their brightness
  shows the load the plants take there (`plantLoad`); and every plant that bends from its root
  (the yunpeng, the bamboo; not the meadow's blades) is drawn unlit in the colour of its current
  sway s (tip offset over height): the hue is s's angle from the mean wind on a cyclic map (downwind blue,
  upwind orange, left of the wind, counter-clockwise seen from above, magenta, right of it green),
  the brightness |s| / 0.15. `windView=arrows` or `windView=plants` shows one half. The numbers
  behind it: `__PONLAI__.windProbe( options )` (`src/debug/WindProbe.ts`: the shaders' own wind
  functions in a compute kernel built on the first call; per kind of plant (`kinds`: `grass`,
  `bamboo`, `yunpeng`, the last two their main bend at the top) angle histograms, lean and swing,
  neighbours' correlation, the gust field's size and travel, the sea's gusts against it around the
  island (`gust.sea`), the plants' wiring, their sway
  rates, and per weather where every part travels and how fast: the plants, the sea and its
  swell, the open sea's gusts, the air's displacement (`fog`), the cumulus and the cirrus), through the probe as
  `--eval "return JSON.stringify( await P.windProbe() )"`.
- The haze (`src/weather/VolumetricHaze.ts`): its knobs are the GUI's Haze folder and
  `__PONLAI__.pipeline.air.settings` (read every frame; a change of the slices, the jitter or the
  rest's length also restarts the shadow's rest); its
  `debug: 1` shows the key light's visibility in the froxel at each pixel's depth (a grey card in
  that light: mid grey lit, black shadowed), the shadow the shafts are cut from. Its
  `readings( height, from?, to? )` gives the medium's numbers without a capture: green's
  extinction at a height, each band's sigma, a horizontal view's RGB transmittance over 1 and 3 km and the
  distance its luminance halves in, and the transmittance between two points (probe:
  `--eval "const c = P.camera.position, t = P.land.target; return P.pipeline.air.readings( c.y, c, { x: t[ 0 ], y: t[ 1 ], z: t[ 2 ] } )"`).
- `look=kit` dresses the islanders in the earlier kit look (pointed ears, linen shirt, cel steps)
  instead of the feather-clad Hanming look (`src/characters/looks.ts`).
- `islander` picks the islanders' proportions (the look's own by default: `real` for the Hanming
  look, `medium` for the kit's; or `stock` (the kit's own), `subtle` and `strong` builds of
  `Proportions.ts`); also in the GUI's Islander folder, which
  rebuilds the scene's walker in place. In game mode the folder's proportion control is disabled:
  the game's islanders take their build from the URL option as they load, so a change applies on
  the next load.
- `body` gives the scene's walker (Hanming look) a sex and an age: `M30` (a man of 30, the default),
  `F6` (a girl of six); an age under 2 is drawn as a two-year-old (`src/characters/Ages.ts`). The
  GUI's Islander folder sets both (a new sex dresses the walker again, a new age prepares its body
  in idle time and puts it on in one frame: `FigureAge.ts`); in game mode both are disabled.
  `bodies` starts a new game with islanders of these sexes and ages instead of the simulation's
  three (a man, a woman and one of either, 20 to 35 years old): `bodies=F28,M75,M6`; a resumed
  save keeps its own (add `new` to start over). They age a year a game day from there.
- `profile` (`?profile`, or `?profile=frames` without GPU timestamps) loads
  `src/debug/FrameProfiler.ts`, which labels every render and compute pass, reads their GPU
  timestamps and exposes `window.__PONLAI_PROFILE__`; without it the page builds the same
  pipelines and image. Its JS times leave out the time blocked in `queue.submit`, the queue writes
  and `getCurrentTexture` (Chrome's backpressure once the GPU falls behind), reported apart.

Game:

- `game` (the island as a game), `hour` (the start hour, default 8), `dayLength` (real seconds
  per game day at 1x, default 1440: 24 minutes), `paused` (the game starts paused; the scene runs
  again once the game does), `load` (resume the game saved in this browser, its world loaded at the
  save's piece count unless `grow` is given), `new` (start a new game, which replaces the save at
  its first save), `autosave=on|off` (whether the page keeps the save itself, resuming it as it
  loads and saving every minute and when the page is hidden or left: on by default, off in an
  automated browser so a capture or a check neither resumes a game left in its profile nor leaves
  one; `load` resumes whatever it says; `src/game/save.ts`), `lang` (the interface's language: `zh-CN`, the
  default, or `en`, a snapshot whose missing words show in Chinese: `src/game/ui/i18n/`). The
  page's own `weather` option and auto weather work in the game as without it.
- The player's interface is 蜃光 (`src/game/ui/GameUi.ts`, its spec `docs/ui.md`): the top row
  (day and time, pause and play, the weather now and the next 24 game hours read ahead from the auto
  chain, the island's resources, the record's scroll), a click on an islander for their tag and
  ring (again, or on open ground, lets go; Esc too), the speak bar (Enter opens it and sends; the
  words fly to the islander selected, or to everyone in view), the build bar (the mallet at the
  bottom right; groups, buildings, `/` to search, 1-9 to choose, the arrows to scroll, Esc and
  Enter) and the record (沧海录: the scroll; Esc, the arrows). Choosing the chest in the build bar
  arms its placement in the scene: a ring on the turf previews the spot (green, or red with the
  reason in the bar), a click places it (`src/game/Placement.ts`). Space pauses only the game
  clock, the GUI's hour, clock pause and time preset are off (the game's clock owns the time of
  day), and its Game folder (`src/game/GameDebug.ts`) pauses and resumes, saves, loads and
  starts a new game (`saved`: when the game was last saved, and whether autosave is on), shows one islander's body
  (position, the action under way, whether a thought is in flight) and sends it walking to the
  next click on the island; its Growth subfolder shows the population against the next step and
  adds an islander (one piece per 2 islanders above 3: the island grows at 5 islanders). Its
  Interface subfolder shows the states the game does not reach yet: "many rows" (the build
  roster three times over, more resource kinds than the row shows whole), "placeholder days" (nine
  days in the record), "hearing brain" (hears the player, thinks a few seconds with the heard
  words circling, answers a placeholder line), a line said by the inspected islander, their
  needs low or critical, and the language (reloads the page with `lang`). The stand-in brain (`src/game/sim/standin.ts`) thinks for the islander
  by default. `window.__PONLAI__.game` is the Game for the console: `.sim`, `act( id, calls )` (tool
  calls for an islander, `[ { tool, args } ]`: the five actions, through the entrance a brain's
  answer takes), `listen( fn )` (the simulation's events as they come), `setBrain( brain )` (kept across a load; `null` leaves the islander idle),
  `think( id )`, `walkTo( id, x, z )`, `placeBlueprint( kind, x, z )` (a building of a kind,
  `'chest'`, any number, each with an id like `chest1`; returns why not, or null), `focus( id )`, `setPaused`, `togglePause`,
  `addIslander()`, `save` and `load` (a save of another piece count loads only with the page),
  `startOver()` (a new game on the island shown), `autosave()` (the page's save: skipped when
  nothing changed), `.keeps` and `.savedAt`,
  `speak( words, ids | 'all' )` (the player's words: into the record, and to a brain that hears;
  returns why not, or null),
  `say( id, words )`, `setNeed( id, need, value )`, `forecast( hours )` (the weather's turns, in
  game hours), `.record` (the record's entries) and `.ui` (`setMany( true )`);
  `.sim.comingLand` holds the next piece's cells once the page has it.

## Test mode

The rule (AGENTS.md, Rules for every change): simulation and generation are deterministic and
path-independent; rendering may keep history-dependent effects that a scene jump clears, that
converge on a still scene (or are frozen or turned off in the test mode) and that are compared
within a tolerance; the test mode keeps the byte-for-byte checks valid.

- The test mode today: `paused` in the query, which loads `aa=msaa` whatever the tier runs (high
  runs `msaa` too; an explicit `aa=` wins), the shot taken once
  `__THREE_GAME_DIAGNOSTICS__.settled` holds (capture.mjs's readiness). Every capture, parity and
  verify tool already loads its pages this way, so their exact checks hold as their headers say.
  The page's only history-dependent rendering effects are the temporal resolve (`aa=taa|taau|gt`,
  frozen by its rest image, `TemporalRest.ts`, and compared within the temporal tolerance), the
  states that settle on their own on a still scene (the clouds' view, the sky's bakes, the
  refracted sun's map, the haze's shadow, which averages a fixed sequence of jitters from nothing
  on a still scene and holds it: `src/weather/VolumetricHaze.ts`), which `settled` waits for,
  the exposure's adaptation (`src/post/Exposure.ts`), which takes its target at once while the
  scene clock does not step, so the pause itself freezes it, and keeps `settled` false until it
  has reached its target, the pre-exposure (`src/post/PreExposure.ts`), a whole-stop scale of the
  stored radiance taken from the exposure read back, which a scene jump resets, which reaches the
  same value on a still scene whatever came before and keeps `settled` false until the P a frame
  used is the one its own exposure asks for, read from a frame drawn the settle frames into a
  quiet run of the view (so under MSAA, the test mode's, P does not change under a settled page;
  under the temporal modes an EV at a hair from a half stop can still move it, and `settled` then
  turns false), and the wenyao's schools
  (`src/life/Wenyao.ts`), which step only with the scene clock's step from a layout the land gives:
  a page loaded paused never steps them, `establishScene` returns them to that layout and a Grow
  does too while they have not stepped, so the pause itself freezes them and they need no switch.
  The falling leaves (`src/weather/FallingLeaves.ts`) are history-dependent and off under the
  test mode's switch (below): not made, so `settled` never waits for them.
- The test mode's paused pages keep at most two rendered frames queued on the GPU
  (`src/post/FramePacer.ts`, "A paused page's queue"): the tools' headless browser has no vsync and
  no frame-rate limit, so without the bound two pages sharing the GPU each queued hundreds of frames
  of work, and every read-back (the pre-exposure's, a probe's radiance) and screenshot waited behind
  it. The bound changes how many frames a second a paused page draws, never what it draws: the
  parity views and the probe readings are the same bytes with and without it. A running page, and a
  paused one with `testMode=0` (capture-clip's), is not bounded. A held frame is an animation frame
  on which the page does not tick (Writing a tool, on waiting for rendered frames).
- A new history-dependent effect:
  - `establishScene` (`src/main.ts`) clears its history; `tools/verify-scene-jump.mjs` checks it;
  - it reports itself to `settled` (main.ts `pending`, or the rest's signature) until it has
    converged on a still scene, or it is frozen or turned off in the test mode;
  - under the test mode's one switch (`src/debug/TestMode.ts`: on with `paused`, which every
    capture, parity and verify tool loads with, unless `testMode=0` leaves it out, as
    `tools/capture-clip.mjs` does so the clips show what moves) it is frozen or off;
  - a Grow does not clear rendering history (`tools/verify-growth-swap.mjs` shoots its first view
    without a jump), so the effect is frozen or off under the switch there, or the swap resets it;
  - its module joins `WATCH.motion` in `tools/parity/carry.mjs` when its paths are not already
    there: with it frozen or off, the paused set no longer shows it, only the clips do;
  - its frames outside the test mode (live, clips) are compared within a tolerance, as the
    temporal modes' are (`tools/parity/tolerance.py`), unless they repeat pixel for pixel.

## Captures

`node tools/capture.mjs <name> [--w 1672 --h 941] [--q "paused&t=12&dpr=1"] [--eval js|@file]...
[--eval-ready js|@file]... [--verbose]` takes a screenshot of the running dev server into `artifacts/captures/`
(git-ignored) and prints frame diagnostics. It needs Playwright's Chromium once
(`npx playwright install chromium`), or `CHROME_PATH` set to a WebGPU-capable Chrome.

`--eval` takes the same forms and scope as the probe's (`tools/page-eval.mjs`, shared by both: an
expression, a function or statements with a `return`, `await`, `@file`; `P`, `D`, `frames( n )`,
`sleep( ms )`, `until( fn, timeoutMs )`): wait in an eval with `await until( () => D.settled )`,
not a polling loop. Each eval's value lands in the capture's JSON as `evals: [ { eval, value } |
{ eval, error } ]`; an eval that throws fails the capture (exit 1), which is still shot.
`--eval` runs before readiness, on a fresh load before the sun's map has even drawn (receivers
read lit until it has), so it sets the view up; a reading of the frame that is shot goes in
`--eval-ready`, which runs once the page is ready, with the loop stopped on that frame (JSON
`readyEvals`). capture-set passes both through after its `--`.

Captures and clips run in "fast mode" (`tools/capture-browser.mjs`): the browser runs in a
persistent profile slot, `artifacts/.capture-profiles/<browser build>/<n>` of the main checkout
(one browser per slot, each with its own lock; `PONLAI_CAPTURE_PROFILES` moves them; safe to
delete), so the world cache and the GPU shader cache hit from the second capture on. A capture
takes the free slots its page (origin and build) used last first (`affinity.json` beside the
slots), else the lowest free one. A paused
capture waits for the page's `settled` signal (`src/post/Settled.ts`, with the loop running; past
`--timeout` it goes on and prints `unsettled`) and is then shot once its image stops changing:
grabbed every 2 frames, shot when a comparison found no pixel changed (after 40 frames, at most 5000
changed pixels count as unchanged; after 120 the view is shot anyway, marked `capped`). A paused
temporal page (taa, taau, gt) is not compared: it is shot once its rest has converged
(`TemporalRest.ts`) and `settled` holds, and the `--stable-*` options do not apply to it. Every capture waits for the
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
(mean RGB, luma, percentiles per image or region; `--oklab` adds the Oklab lightness, chroma and
hue medians, `--cover` the share of a mask capture's pixels painted flat red, as `grassMask:true`
paints the blades) and `flicker` (a clip's consecutive whole
frames, capture-clip's `--full`: the temporal flicker per region, mean frame difference, temporal
high-pass, one-frame flashes and a `--map` of where they fall) and `radial` (the median colour,
luma and linear luma ring by ring around a point, such as the sun's place an `--eval-ready` step
returned: `--centre-key`; rings in percent of the frame's height, or degrees with `--fov`; `--half up`
keeps the sky over a low sun without the sea under it); regions are `--box
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
fields' bytes, the ambient light's probe lattice and its relit irradiance (their SHA-256), the pipeline count (constant across every swap, equal on both pages), renderer.info's
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
when `--steps` names them. `verify-weather-effects.mjs` and the rain parts of `verify-weather.mjs`
are parked with them: not part of any default check.

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
(each give-up on stderr, the step's `gaveUpMs`). Probes share the GPU as capture pages do: two
probes sweeping six points of a paused, grown island at 4K each took about 1.4 times one probe's
time (1.45 times its throughput), and a probe beside a capture-set page 1.1 times its time alone,
with readings identical to a probe alone. Sweeping 21 points, two probes gave about 1.35 times one
probe's throughput and three about 1.4 times, but at three one or two of the probes in a run read a
value that differed from a probe alone's in the last digit. (A paused page bounds its GPU queue,
Test mode above; before that bound two six-point probes each ran 12 times as long as one alone.) Common questions:
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
- the light in linear radiance over boxes: `--q "debug&paused&flags=lightOnly" --frames 60
  --eval "await P.radiance( { boxes: { a: [ 0.4, 0.6, 0.1, 0.1 ] } } )"` (URL options, the lighting
  layer).

Steps, scope, the value's serialisation and the exit code are in the file's header.

`node tools/meadow-light.mjs [url] [--elev 50,20] [--azimuth 135] [--view name=tilt,dist,fov]...
[--views-file f.json [--views a,b]]` measures the meadow's light on its leaf pixels in linear
radiance: the sunlit blades' bright and dark clusters against the bare ground in the same sun,
their mean, the share that is lit, the shaded blades against shaded bare ground, the light the turf
under the sward takes, the blades' cover (over the lawn, the frame's centre and bands of view
depth), their albedo and its spread and the turf's between them, the leaf's and the turf's colour,
the Oklab of the sunlit lawn on the canvas, and the sunlit leaf and bare turf on the canvas as a
close look reads them (their luminance, colour and texture's swing) with the share of the frame the
gaps between the blades take, the spread of the lawn's luminance, the specular's share of the
sunlit blades' light, and the soil between them against the sunlit blades (a table of its own: the
colour of the brighter half of the bare pixels redder than green and of the blades' brightest
third, their ratios, and the soil's relief, its luminance's 90th over its 10th percentile). Each view is read on seven fresh loads (the blades'
exact cover mask with everything but the land and the blades hidden, every surface's albedo
(`albedoOnly`), `lightOnly`, with `bareGround`, with `ambientOnly` too,
the normal frame, and `lightOnly:2`, the light without its specular) once `settled` holds, its views reached by the scene jump and a camera placed
relative to the sun (so elevations compare like for like) or by a views file's evals, as
capture-set takes them. Lawn that something stands in front of counts for the cover only. It writes
`meadow-light.json`, the canvas and a picture of the pixel sort per view, and prints a table. The
sort and every measure are in the file's header. A change to the blades' shading alone moves three
of the seven pages: `--save dir` keeps a run's pages on disk (about 30 MB a view and page) and
`--pages light,normal,matte --reuse dir` shoots only those three, reading the others from it; `--pages none`
reads them all, with no browser, to run changed measures on a saved run. `lean` in `--pages` adds an
eighth load (`grassMask:lean`) and a table of the blades' lean from upright over the lawn they
cover, as drawn (the wind's nod and the push away from a near eye included) and by their pose
alone: its 10th, 50th and 90th percentiles and the shares under 15 and over 60 degrees.

## WGSL builds: `tools/wgsl-build.mjs`

`node tools/wgsl-build.mjs <entry> [--out dir] [--features a,b] [--q query]` builds TSL shaders to
WGSL in node, with no GPU, no browser and no GPU lock: three's WGSL node builder on a WebGPURenderer
that is never initialised. The entry is a module that returns the shaders to build (compute kernels,
full-screen passes as a NodeMaterial, draws as `{ material, object, scene, camera, mrt }`, `mrt`
the pass's MRT a scene material draws into), in the order
the page first builds them; the tool loads it through Vite's SSR loader with the project's config,
so it imports the page's modules as the dev server serves them, and `--q` sets the `location.search`
their load knobs read. Entries live in `tools/wgsl-build/` (`fsr3`: every kernel of
`src/post/fsr3/`, built by the page's own `Fsr3Upscaler` in a frame's order, the reactive-mask
generator and the debug view included; `ambient-relight`: the sky's projection, the relight, its
readback and the probes' debug view, `src/lighting/AmbientRelight.ts`; `ambient-materials`: the
lit materials that read the ambient volume, `src/lighting/AmbientSample.ts`, with the volume or,
under `--q "flags=ambientVolume:0"`, without it; `gtao`: the ambient
occlusion's depth, slices and blur, `src/post/GTAO.ts`; `meadow`: the displacement field's
sprites and the near and far blades that read it, `src/world/vegetation/Displacement.ts` and
`src/world/Grass.ts`, built from an empty plan; `falling-leaves`: the falling leaves' step and
prewarm kernels and draw, `src/weather/FallingLeaves.ts`; `local-lights`: the local lights'
clusters kernel and the lit materials that bind the most with their lookup, the terrain's cliff
and seabed and the islanders' figure, `src/lighting/LocalLights.ts`; `haze`: the volumetric haze's
light kernel and the haze the sky dome lays on itself, `src/weather/VolumetricHaze.ts`; `night`:
the moon on the dome (`src/sky/NightSky.ts`), the flare and its visibility
(`src/post/LightShafts.ts`) and the composite's rods' colour (`src/post/Purkinje.ts`); `terrain`:
the island's ground, the stones and the sea floor, `src/materials/TerrainMaterial.ts`; `post`: the
post chain's own passes, the exposure's meter, the bloom's levels and the local tone's grid and
slicing, `src/post/Metering.ts`, `Exposure.ts`, `PhysicalBloom.ts`, `LocalTone.ts`; `clouds`: the
clouds' panorama march, shadow and view kernels on the page's atmosphere, `src/sky/Clouds.ts`, with
a stand-in shape noise and the GPU bakes skipped; `atmosphere`: the atmosphere's bakes, the
slices cut from its table, the earth shadow's mean over the azimuth and the sky's radiance,
`src/sky/Atmosphere.ts`; `sky`: the materials that read the clear sky, and so the earth's shadow:
the environment's panorama bake, the cloudless sky's irradiance and the dome as the page draws it
(fogged by the haze, into the scene pass's MRT), `src/sky/Sky.ts`, with the moon's maps stood in
empty); the entry's contract is in the tool's
header. `--features` gives the device features three sees: default none (WebGPU core), while the
page's device has every feature its adapter offers, and `float32-filterable` and
`texture-formats-tier1` change the WGSL.

Each shader goes to `artifacts/wgsl/<entry>/<name>.wgsl` (a draw's to `.vert.wgsl` and
`.frag.wgsl`), and `bindings.txt` (`report.json` for a script) lists per stage every binding with
the resource behind it (a texture's name, a storage texture's mip level), each uniform buffer's
members and size (`nodeUniformN`: a uniform the code did not name), the workgroup size and
storage, a draw's varyings and colour outputs, and a warning for each of WebGPU's default limits
the stage exceeds (the page's device requests none above them). Exit 1 when a shader fails to
build or exceeds a limit. FSR 3's twenty kernels build in about two seconds.

It does not validate the WGSL (no naga or tint): it reports three's own build errors and shows
what three generated (the bindings a kernel declares, such as several writes sharing one binding
or a storage texture's level dropped, the uniforms it reads, such as a uv matrix per texture read,
and the limits), while a module's or a pipeline's creation is still proven on the page
(`tools/verify-first-use.mjs`, the console's WebGPU errors).

## GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes the
machine-wide GPU lock in `tools/gpu-lock.mjs`: timing runs (profiles, benchmarks, running captures)
hold it alone; paused captures and the verify probes share it with each other, since their pixels
do not depend on the load. Shared holders take one of `PONLAI_GPU_SLOTS` slots (default 2) and the
rest queue: captures are GPU-bound, so two pages at once give about 1.75 times one page's
throughput, a third about 2 times with the slowest views taking twice as long as at two, and a
fourth hardly more (21 paused views, the frames identical at every count); probes that sweep many
points gain about 1.35 times at two and 1.4 at three, where their readings lose the last digit now
and then (Probes, above). Two slots take most of the gain with the readings exact. A capture-set page leases its slot (capture.mjs's worker, `leaseGpuLock`): it keeps
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
  [--scales 1,0.75] [--scale-settle s] [--display [--motion user|orbit|none] [--window WxH]]
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
  page's slices). The page that runs is brought to the front first, headless too: the two pages
  are tabs of one window, and a tab behind still runs its frames (Playwright keeps it visible to
  its page) but they are not presented, so it paces otherwise. With the tab opened last (B) left
  in front, A/A runs on one build gave B a median frame interval 7-17 % longer with GPU
  timestamps off, and longer with them on, beyond the interval, its GPU busy time unchanged. With
  each page in front while it runs, the same A/As came out within their interval, on and off.
  A/A runs (one build as both A and B) are the check for any change to how the compare runs.
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
  like a player's through Chrome's input (`--motion user`, the default there, loads its pages with
  `cameraInput`: turning drags of 30
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
  `--eval "s.pipeline.settings.bloom = 0"`); `--report profile.json` re-renders a summary (`--report <dir>`
  rebuilds an unfinished run's, see above).

### Measuring frame time

- Measure on a production build, under the GPU lock: the scene matrix at the default generic
  display (1920x1080 CSS at DPR 2, quality high), before and after a change (`--compare` for an
  A/B, or `--toggle` on a debug flag while the change is in development).
- Judge an A/B by its GPU time per pass (timestamps on); take frame rates from a run without GPU
  timestamps (`--timestamps off` or `both`): Chrome ran frames up to a quarter faster with them
  on, so their per-pass split shows where the time goes, not the frame rate a player sees. (A tier
  with a dynamic resolution keeps its own timestamp queries in every run, as a player's page does;
  `--q gpuTimer=off` leaves them out.) Uncapped, the page runs about 120 frames ahead of the GPU,
  so a frame's timestamps come back seconds later (a scene's `profiler.readbackMs`: 2.5-6.5 s on
  `island-fair-noon` and `meadow-close`); the profiler waits for each frame's own read-back, with
  no time limit, and `missingPasses` counts only passes whose query was never written or whose
  read-back failed. A run with `timedFrames` 0 is a bug, not a busy GPU.
- High is timed at its standard by default: 4K output (1920x1080 CSS at DPR 2) at 1440p's pixel
  count, upscaled by FSR 1, with MSAA 4x, the level every trade-off is judged at, with about 14 ms
  of GPU time a frame in the normal scenes (island views, `meadow-close`) as the budget. A profile,
  `--compare` or `--toggle` of high pins the baseline of its dynamic rule for the viewport
  (`dpr=1.3333333333333333` at the default; `dpr=1` at `--w 2560 --h 1440 --scale 1`, a 2K display:
  `src/post/RenderScale.ts` `dynamicRange`); `--unpinned` leaves the
  tier's own rule (a dynamic one steering, with `--scale-settle 5 --scale-log` to see where it
  settles). `--accept`, `--display`, `--scales` and a `dpr` of the url's or `--q`'s own are never
  pinned.
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
map, the camera's ground, the ambient probes, pipelines and memory across swaps): `tools/verify-growth-swap.mjs`, not a
probe eval of one's own.

How much light reaches a surface, its colour, and how much of it is the sun's, apart from the
albedos and the display chain: `flags=lightOnly` (and `ambientOnly`) with `__PONLAI__.radiance`
(URL options), not a PNG's pixel values, which have been through exposure, the tone curve, the
grade and bloom.

How bright the meadow's sunlit blades are against bare ground, how many of them are lit, how dark
the shaded ones are, how much of the lawn they cover and what colour the lit lawn shows:
`tools/meadow-light.mjs` (Probes), not a radiance box of one's own over a mixed patch.

Which assets a commit runs with, whether `public/` matches them, and how to publish a change to
them: `tools/assets.mjs` (Assets), never a file committed to git.

What the islanders do over days of play, how the needs and the stock run, and how a brain plays
from what it perceives: `tools/play-game.mjs` (Other tools), not a loop over the simulation of
one's own.

What WGSL a TSL kernel, pass or material compiles to, which bindings and uniforms each stage
declares, and whether one exceeds WebGPU's default limits, without a GPU: `tools/wgsl-build.mjs`
with an entry in `tools/wgsl-build/` for the module, not a stub-renderer script of one's own.

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
  capture-browser's `waitForScene`, `waitForSettled` (the diagnostics' `settled`, with the loop
  running) and `waitForStable`, in that order. A fixed 40-frame wait passed or failed by chance on
  a busy GPU. A reading of the frame is taken once it is ready, not right after the load: a fresh
  load's first frames are drawn before the sun's map, with every receiver lit.
- A step that sets a state (a clock, a camera, a uniform) and reads the frame that follows waits
  for the page's rendered frames, counted by `renderer.info.frame`: page-eval's `frames( n )` in an
  eval, `renderedFrames( page, n )` (`tools/page-eval.mjs`, "Rendered frames") from a Playwright page
  of one's own, never a count of animation frames: the frame pacer skips the refreshes between its
  frames, and a paused page in the test mode holds a due frame while two are still queued on the GPU
  (Test mode), so the read saw the frame before whenever the page did not tick after the state was
  set. Rendered frames wait for the state the next tick applies; a still, converged image is still
  waited for by `settled` (the Readiness rule above), never by a count of frames of either kind.
- Expensive results that depend only on the commit, the tool and the browser are stored and
  reused through `parity/reference.mjs`; record in the key everything that changes them.
- CPU-heavy node tools import `qos.mjs` first. Python tools declare their dependencies inline (PEP
  723) and run with `uv run`; image metrics come from `parity/pixels.py`.
- Tools are shared by every session's worktrees. A tool change goes to main promptly, and the
  sessions using it are told. Older copies in other worktrees are not kept compatible: those
  sessions update. The GPU lock runs the newest implementation on the machine, so a rule change
  bumps its `LOCK_VERSION` (`gpu-lock-impl.mjs`).

## Other tools

- `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows and water (each
  file names the server it expects); they take the GPU lock (shared).
  `verify-optical-interface`, `verify-frame-graph-gpu`, `verify-refracted-sun` and
  `verify-solar-shadows` import `/src/` modules and need the dev server: on any other server they
  exit 1 at once (`tools/dev-server.mjs`).
  `tools/verify-scene.mjs` checks a production preview. `tools/verify-scene-jump.mjs` captures the
  parity views reached by scene jumps in one page and as fresh loads, for `diff-set.py`, each shot
  ready as capture.mjs's paused shots are (the page's settled signal, then the stability rule:
  `tools/parity/README.md`, One page, many views);
  `--check <root>/<sha>/<set>` runs the whole check (the stored set of fresh loads, a page per
  view, both jump orders at once, the diff) in one command. `--view "name:query[::js]"`
  (repeatable) adds ad-hoc views with capture-set's syntax (`like=<view>` included), so a jump
  into a new scene option is checked as `--views island-fair-noon --view near:dist=40`; their fresh
  loads are stored with their definitions' hashes, so a changed query captures a new reference.
- `tools/verify-zoom-anchor.mjs [url] [--runs 24] [--out file.json]` checks the island camera's
  anchors in one probe page (with `cameraInput`): wheel zooms out with the cursor over the sea (`--runs` times) and
  over land, two pinches out, and a drag (the island view zooms out only, from its pose's distance); it fails on any zoom anchor that found no ground or a drift
  of the point under the cursor of 0.5 px or more. Run it after a change to the island camera or
  its ground (`src/camera/`).
- `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs`, `verify-wind.mjs` and `verify-game.mjs`
  are CPU-only (plain `node`). `verify-game.mjs` checks the game's simulation: the clock, the
  ground and a path, a body walking to a point, a save round trip, a brain's late answer, and the
  first prototype's rules (needs, thirst off, the bag, fishing, the chest placed as a blueprint and
  built, several chests with stable ids, two builders on one site, the actions, the perception, the stand-in brain over a few game days, a save mid-action), the save file
  (`src/game/save.ts`: the simulation and the record read back as written and played on the same,
  saves of another version and saves no step reaches refused), the island's growth, the session
  the page and the play tool run the game in (`src/game/Session.ts`: the landings handed on as a
  game is installed, the player's commands checked at the entrance, the skies of its frames, the
  leader's words heard, a save read into another session, the growth asked of its host), the
  islanders among themselves, and the rules' structure (an action's condition held every tick, a
  late answer for an islander who died refused, the entrance's refusals, what happened recorded
  once at its tick, content added with no change to the core: a need, an item with a use, a kind
  of place and of building with their options, registered by the check alone, played, perceived,
  recorded, saved and shown with the presentation's defaults, then taken away, and no content id
  written as a string in the core: ARCHITECTURE.md, Adding content); its island is in
  `tools/game-fixture.mjs`.
- `tools/play-game.mjs [--days 5] [--seed 1] [--hour 8] [--pieces 0] [--grow] [--population 0]
  [--place kind[@x,z]]... [--script file.json] [--brain standin|<module>] [--latency 90] [--thoughts]
  [--out dir]`
  (plain `node`) plays the game headless in the page's own session (`src/game/Session.ts`, nothing
  copied from the page: a frame of one tick at a time, a growth due asked for before it, the record
  looking after each, the leader's lines between them), and writes what happened to
  `artifacts/play/<stamp>/` (`--out`): `transcript.md` (day by day, the record's entries in the
  record page's words, `src/game/ui/data/record.ts` and its catalogue, so a new kind of entry needs
  no change to the tool, and an event kind that neither its lines nor the record show prints as an
  `[event]` line; the islanders' actions with their outcomes as the session's events tell
  them (done, failed, interrupted with the reason, refused), consecutive alike ones merged, their words, needs every
  six game hours and a table per day), `timeline.json` (every islander each game hour: position,
  needs, bag, action), `summary.json` (per islander the share of time by activity, each need's
  lowest, mean and highest, each item's flows by the call that moved it, so a new need, item or
  option shows without a change to the tool; the dead, the buildings and when
  they were built, the stock), `record.json` and, with `--thoughts`, `thoughts.jsonl` (a line per
  thought: what the islander perceived and the brain's answer, for judging a brain offline; about
  1 MB for four islanders over five days), with a short summary on stdout. `--place` puts
  blueprints down at the start (at the first ground that takes one without a point), `--population`
  adds islanders, `--grow` adds the next piece when the population reaches a step, and `--script`
  has the leader speak at given times (`[ { "at": "d1 08:30", "to": "all" | [ "v1" ], "words": "..." } ]`),
  as the speak bar does (`Session.speak`). `--brain` takes a module whose `createBrain` (or
  default export) receives `{ heard, takeHeard, hasHeard, islander, note, options }` and returns a
  Brain; an asynchronous one's answers land `--latency` game seconds after each thought is asked
  (90: three real seconds at the default day clock), the run waiting for an answer that takes longer,
  so the timing never depends on the wall clock. With the stand-in the same options write the same
  files byte for byte. Five game days of the stand-in take about two seconds; a run with a
  language-model brain goes through `tools/job.mjs`. The options and guarantees are in its header.
- `tools/verify-i18n.mjs [--strict] [--list]` (plain `node`) checks the game interface's words:
  it fails on Chinese written in `src/` outside the catalogues (`src/game/ui/i18n/`; the content
  it allows, the islanders' names and the debug panel's placeholder lines, is listed in the tool)
  and on an empty source string, and reports how far each other catalogue has drifted from
  `zh-CN.json`: keys missing (shown in Chinese), keys the source no longer has, values naming
  `{{values}}` the source does not give. `--strict` fails on the drift too; `--list` names every
  drifted key. Run it after a change to the interface's text.
- `tools/verify-ink.mjs` (plain `node`) checks the interface's ink (`src/game/ui/Ink.ts`) on
  strokes drawn as the page draws them, at high's scale: the same stroke and seed ink the same; it
  never adds ink or reaches past the outline; a short stroke keeps its ink; a long one keeps its
  first press and dries toward its exit, a thin one less than a broad one; a gauge told not to dry
  keeps its exit.
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
  meadow's anchors per m^2 against M2 (grown islands summed, 5 %); the stones'
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
  parked tiers included; its `wind` step jumps to each wind level and heading and changes them over
  seconds; its `weather` and `bolt` steps reach the parked weathers and run only when `--steps`
  names them).
  The load is judged as a step of its own, `load`: no frame of the 60 after the first may create a
  pipeline synchronously, nor may the first frame's redraw of the sun's shadow map.
  It loads in a capture profile slot (as the captures' fast mode does), so the island comes from
  the world cache; the browser's shader cache in the slot does not change the counts (they are the
  page's requests to WebGPU, cached or not), and `--fresh` runs in a throwaway profile as before.
  Its steps' waits are part of what it measures and stay fixed.
- `tools/benchmark-lighting.mjs` A/B-times two builds.
- `tools/build-moon-textures.py` rebuilds the moon's textures from NASA's CGI Moon Kit
  (`uv run --with pillow --with numpy`), `tools/build-ground-textures.py` the meadow ground's from
  two Poly Haven scans (the same way). `tools/build-star-catalog.mjs` and
  `tools/build-milky-way.py` rebuild the night sky's data in `public/sky/` from the raw catalogue
  and map (each file says where to get them and how to run it).
  `tools/bake-rainbow-table.mjs` generates `src/sky/RainbowTable.data.ts`.
