# Soomi

A small stylised island in an open sea, rendered in the browser: a visual sample for a game.
The look is stylised fantasy-realistic: a physically based scene graded toward a painted
game's colour, with warm golden light, softly glowing highlights, airy lifted shadows, rich greens,
deep teal water with a sparkling glare toward the sun, chunky chiselled stone, a lush meadow with
bushes and wildflowers, and irregular hanging leaf clusters around the rim. Keep the lower cliff
stone exposed.

## Stack and commands

- TypeScript (strict), Vite, three.js `WebGPURenderer` (`three/webgpu`, `three/tsl`). WebGPU is
  required: the ocean FFT runs on compute shaders. Without WebGPU the page shows a message.
- Shaders are written in TSL only (no raw WGSL or GLSL strings). Helpers called from several
  places are `Fn( ... ).setLayout( ... )` so they compile to one shader function each.
- The water shading is adapted from tidewater (physically based) and art-directed toward the look
  above; keep new water work stylised rather than strictly realistic.
- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191).
- `node tools/capture.mjs <name> [--w 1672 --h 941] [--q "paused&t=12&dpr=1"] [--eval "js"] [--verbose]`
  takes a screenshot of the running dev server into `artifacts/captures/` (git-ignored) and prints
  frame diagnostics. URL options: `paused`, `t`, `dpr`, `dist`, `polar`, `az`, `gui`, `camera`
  (orbit, the default: the island camera; or free: fly with the mouse, WASD, Q/E and Shift). It
  needs Playwright's Chromium once (`npx playwright install chromium`), or `CHROME_PATH` set to a
  WebGPU-capable Chrome.
- Sky and weather URL options: `hour`, `preset` (dawn, sunrise, noon, golden-hour, sunset, dusk,
  midnight), `dayLength` (seconds), `moon` (phase), `clock=paused` (freezes only the day clock;
  `paused` freezes it with the scene), `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load
  as established, already wet; without it the weather evolves on its own), `clouds` (coverage
  override), `quality` (low, medium, high: the tier of every knob in `src/Quality.ts`, see
  Decisions; without it the tier measured for this GPU, see `src/QualityDetect.ts`;
  `tier.<knob>=<value>` overrides one of them for an A/B, e.g. `tier.post.fogScale=0.5`),
  `autoQuality` (`detect` measures again, `off` keeps medium), `autoQualitySlow=<factor>` (scales
  the measured GPU time, to try the choice a slower GPU gets), `tone` (neutral-hue, the default,
  agx-hue, agx, neutral), `look` (soft-fantasy, the default, rich-fantasy, realistic).
  In the page, H toggles the GUI, Space pauses, R or 1/2/3 jump to the island, horizon and
  sky views, and F toggles a corner readout of the frame cadence. The GUI's Performance folder
  shows the same live lines (`src/debug/FrameStats.ts`, from the rendered frames' rAF timestamps):
  the frame rate over the last second, the interval's p95 and maximum over the last 5 s, the
  frames late by a refresh against the paced interval and the intervals over 25 ms since the scene
  showed (or the reset button), the render scale and the GPU's median frame time (high only).
  The island camera (see Decisions): a left drag grabs the ground, a right or middle drag (or
  Option / Ctrl with the left) turns and tilts, the wheel zooms toward the pointer; on a trackpad a
  two-finger swipe pans, a pinch zooms and Option with a swipe turns and tilts; W A S D or the
  arrows pan, Q / E turn, T / G tilt, + / - zoom, Shift speeds them up.
- Rendering and A/B URL options, read at load: `msaa` (the scene's sample count, `SceneSamples.ts`:
  4, the default, or 1 for none; `2` reads as 1, since WebGPU multisamples with 1 or 4 samples
  only), `worldCache=off` (generate the island instead of loading it from the browser's IndexedDB
  cache, as on a first visit), `terrainHex=0` (the cliff's plain triplanar tiling and smooth layer
  masks; for an A/B inside one page each cliff material swaps to its other variant through
  `material.userData.terrainVariant`, as `TerrainMaterial.ts` shows: the flag itself is read only
  when the material is built),
  `post=legacy` (or a comma list of `inline-composite`, `full-fog`,
  `no-bank`, `inline-coc`, `three-fsr`, `store-scene`: the frame graph without the first
  performance round's changes), `shadowFilter=legacy|sl1|sl1,sl3` (the sun shadow's filter
  path), `gpuTimer=off` (high's dynamic resolution without its timestamp queries: it then
  steers by the frame intervals) and `frameRate` (the frame rate the loop holds on a faster
  display, over the tier's; `frameRate=0` renders on every refresh, as the profiler's uncapped runs
  do), `submits=each` (three's own submit per pass, without the submit batching; at runtime
  `flags.batchSubmits`; its tracking wrappers stay installed, so compare against `main` for their
  JS cost) and `submitBatch=hold,wait,idle` (its policy, see `SubmitBatch.ts`).
  Runtime switches for one-page A/Bs live in
  `src/debug/DebugFlags.ts`. `islander` picks the islanders' proportions (`medium`, the default, or
  `stock` (the kit's own), `subtle` and `strong` builds of `Proportions.ts`; also in
  the GUI's Islander folder, which rebuilds the figure in place).
- Quality knobs: one table, `QUALITY` in `src/Quality.ts`, per tier. Load knobs are compiled into
  materials or the frame graph and read once as those are built, so a change of tier reloads the
  page (the GUI's quality control does): `QualityProfile.water` (`Water.ts`: reflection rays and
  steps, refraction steps, water-column samples, storm-foam layers), `.grass` (`setGrassQuality`:
  blades per tuft by distance, tussock segments, thin tufts, canopy light per vertex), `.shadow`
  (`SunShadow.setFilter`: PCSS taps, or the bilinear comparison alone, separately for vegetation),
  `.rainShading` (`setRainShading`: the veil's shells, the sea's ripple layers), `.post`
  (`PostOptions` for `new Pipeline`: sea-fog resolution, steps and bank map, depth-of-field taps,
  bloom chains), `.environmentSource` (`Sky.setEnvironmentSource`, before the first bake),
  `.frameRate` (`FramePacer`) and the render scale rule. Runtime ones, applied by
  `applySkyQuality` in `main.ts` (`s.applyQuality( { ... } )` overrides them in a debug page): the
  cloud view
  (`Sky.setCloudView`), the clouds' `setDome`, `setMarch` and `setShadowRefresh`,
  `Sky.setEnvironmentCadence`, the sky bake interval, the refracted sun's interval and
  `angleGate`, and the rain's drop count. Every default in the modules themselves is high's.
- `node tools/profile-frame.mjs [url] [--scenes a,b] [--w 1920 --h 1080 --scale 2] [--quality high]
  [--timestamps on|off|both] [--eval "js"] [--repeat n] [--shots] [--vsync] [--accept [--strict]]
  [--scales 1.5,1] [--scale-settle s] [--display [--motion user|orbit|none] [--window WxH]]`
  profiles a production build (`npm run build && npm run preview`; the url defaults to its port)
  in headless Chrome (`CHROME_PATH`, else the system Chrome) with the frame rate uncapped, or at
  60 Hz with `--vsync` (the intervals a player sees; uncapped, a GPU-bound scene's p95 is mostly
  pacing noise). It plays a matrix of named scenes
  (`--list`: fair, golden, horizon, sky, overcast, rain, storm, fog, night, close over the
  meadow, a weather front), each with the clock running, fixed weather and a slow orbit, and writes
  `artifacts/perf/<label>/` (profile.json, summary.md): frame interval median, p95 and p99, GPU
  time per pass, the tick's JS time, hitches with their cause, and the startup. It loads each
  variant once and switches scenes at runtime (`--mode reload` reloads per scene, the original
  method); every page keeps the generated island in IndexedDB (in the tool's own Chrome profile)
  while the generator's sources are unchanged (`--world-cache off` loads with `worldCache=off`).
  `--compare urlA urlB` runs A and B as two pages in one browser, in alternating slices with the
  other page stopped, and reports deltas with their 95 % interval; `--toggle "js"` A/Bs inside one page by applying
  the expression (with `s` = `window.__SOOMI__` and `on` false for A, true for B) every few frames,
  for example `--toggle "s.flags.myChange = on"` with a flag an optimisation reads from
  `src/debug/DebugFlags.ts`. Both give B/A as a ratio beside the delta. Decide A/Bs on GPU time
  per pass (timestamps on); take frame rates from `--timestamps off` or `both`. `--accept`
  (vsync, timestamps both) judges the 60 fps criterion per scene: frame interval median and p95
  within 0.5 ms of 16.7 (`--target`) and no frame over 25 ms in the 7 s measured, from the run
  without timestamps, with the p99, the maximum and the GPU busy time reported beside it. A
  contended scene that fails is INCONCLUSIVE unless its GPU busy median is over the target;
  `--strict` exits with 1 on a FAIL. Headless 60 Hz shows whether the GPU holds 60 fps, not how
  a faster display paces the frames: every scene passed it while a 120 Hz display showed a sixth of
  the frames 8.3 ms apart, a third of the intervals changing cadence and the dynamic scale moving
  about 16 times a minute under a player's drags. `--display` measures that: headed system Chrome
  full screen (`--kiosk`; `--window WxH` opens a normal window of that outer size, as a player's,
  with the other windows on screen) at the display's own size, pixel ratio and refresh, the camera
  dragged like a player's through Chrome's input (`--motion user`, the default there: turning drags
  of 30 to 200 deg/s with pauses, a wheel zoom, a flick; 20 s per scene), and per scene, by display
  refreshes, the intervals between the frames the scene rendered and between those the compositor
  presented (from a trace of Chrome's frame pipeline), the share of intervals that change cadence,
  and how much the camera's turning speed changes from frame to frame. A window covers the screen
  while it runs: keep the runs short and other animated windows closed.
  `--scales` repeats the run per render scale (the `dpr` option, which the url and `--q` must then
  leave out) and tabulates every scene at every scale. Every report gives the render scale the
  measured frames were drawn at (its median, range and changes: high's moves);
  `--scale-settle s` waits after each scene's warm-up until that scale has held for s seconds.
  `--eval` runs in the page with `s` =
  `window.__SOOMI__` (an ablation, e.g. `--eval "s.pipeline.settings.dof = 0"`);
  `--report profile.json` re-renders a summary. The `profile` URL option (`?profile`, or
  `?profile=frames` without GPU timestamps) loads `src/debug/FrameProfiler.ts`, which labels every
  render and compute pass, reads their GPU timestamps and exposes `window.__SOOMI_PROFILE__`;
  without it the page builds the same pipelines and image. Its JS times leave out the time blocked
  in `queue.submit`, the queue writes and `getCurrentTexture` (Chrome's backpressure once the GPU
  falls behind), reported apart.
- Which tool for which question: our tools automate and judge (`profile-frame.mjs`: the scene
  matrix, A/B deltas with their intervals, per-pass GPU time under our own pass names, the 60 fps
  acceptance; `gpu-lock.mjs`: one timing run at a time; the parity capture set). To find out why
  a frame was late or a hitch happened, use the existing tools rather than new metrics: a Chrome
  trace (DevTools Performance panel, or a trace file opened in Perfetto) shows what the main
  thread, the GPU process and the compositor did in each frame, and Xcode Instruments' Metal
  System Trace, Game Performance and Animation Hitches templates show when frames reached the
  display and what the GPU ran (`xcrun xctrace record --template 'Metal System Trace' --attach
  <Chrome GPU process pid> --time-limit 10s --output <file>.trace`, then open it in Instruments).
  Extend our tools only for what these do not give (automation, A/B statistics, pass names).
- Headed browser runs (`profile-frame --display`, any script that opens a visible Chrome window)
  take over the screen of whoever is using the machine, so they run only while the user allows
  them: `node tools/display-gate.mjs allow [hours]` (and `deny`, `status`) keeps the permission in
  a file under the user's home, `profile-frame --display` refuses without it, and scripts that open
  a headed window call `requireDisplayAllowed` from the same module. Everything else runs headless;
  a headed run that is not allowed now is recorded as pending and run later in one batch.
- Everything that renders the scene in a browser (captures, profiles, GPU probes) takes the
  machine-wide GPU lock in `tools/gpu-lock.mjs`: timing runs (profiles, benchmarks, running
  captures) hold it alone; paused captures and the verify probes share it with each other, since
  their pixels do not depend on the load. `node tools/gpu-lock.mjs run [--shared] [--label x] --
  <command ...>` wraps any other script, `status` names the holders and `gpu` shows the GPU's
  utilisation and the processes using it. The profiler also checks that the GPU is idle before it
  measures and marks its results contended otherwise.
- Other tools: `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows, water
  and wave optics (each file names the server it expects); `tools/verify-scene.mjs` checks a
  production preview; `tools/benchmark-lighting.mjs` A/B-times two builds;
  `tools/compare-captures.py` measures two overview captures (needs Pillow and NumPy);
  `tools/parity/` captures a fixed set of paused views with named 1:1 crop anchors
  (`capture-set.mjs`) and diffs it against a reference set, byte for byte or within the
  reference's own repeatability (`diff-set.py --aa-floor`; see its README);
  `tools/build-moon-textures.py` rebuilds the moon's textures from NASA's CGI Moon Kit
  (`uv run --with pillow --with numpy`). `tools/build-star-catalog.mjs` and
  `tools/build-milky-way.py` rebuild the night sky's data in `public/sky/` from the raw catalogue
  and map (each file says where to get them and how to run it).
  `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs` and `verify-wind.mjs` are CPU-only
  (plain `node`). GPU probes take the GPU lock; keep other pages that render the scene closed.

## Layout

- `src/Quality.ts`: the quality tiers, every knob of the frame's cost in one table (see
  Decisions); `src/QualityDetect.ts` chooses one for the GPU at startup.
- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics (the island camera in
  `src/camera/IslandCameraControls.ts`, with the ground it grabs in `IslandGround.ts`; the free
  flight in `FreeCameraControls.ts`).
  `window.__SOOMI__` (scene handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev
  server or with `?debug` (or `?profile`, which also loads the frame profiler in `src/debug/`).
- `src/world/`: the island generated in Web Workers (the island, the stones in up to four sets and
  the rest built in parallel copies of `worldWorker.ts` and merged in serial order, so the world is
  identical to a single thread's; kept in IndexedDB by `WorldCache.ts`, keyed by the hash of the
  generator's sources, its options and the browser; SDF shapes → surface nets; the cliff band
  places its vertices by dual contouring so scar edges stay sharp), its cliffs as a weathered face
  that has shed blocks along its joints and beds (`Cliff.ts`: rockfall scars in three generations
  of size, gullies, a wave-cut notch that follows the coast's exposure; per-vertex facet, scar
  age, bed, lip, overhang and exposure detail for the material), sea floor
  (a shelf that widens and narrows along the coast, a talus apron and shallow benches at the
  cliff foot in `Bathymetry.ts`; its seagrass beds and pale sand baked per vertex, so they never
  tile), shoreline field,
  vegetation anchors; instanced grass, rim bushes and flowers on the island top, a turf skirt over
  the lip, with clumped, top-rooted trailing branches (forking, of mixed lengths) under leaf mounds
  on the lip; shrub groups (round shrubs, broad-leaved clumps, ferns) and small trees, each grown
  from its own seed and merged into one mesh (`Plants.ts`, sited by `PlantSites.ts`). The
  alpha-to-coverage vegetation (grass, bushes, plants, rim leaves) draws after a depth prepass
  (`VegetationPrepass.ts`): a depth-only copy of each mesh with the same vertex stage, alpha and
  coverage draws first, and the shaded mesh tests depth for equality without coverage, alpha test
  or depth writes, so hidden blades and leaves are not shaded. The meadow's tuft instance data
  live in storage buffers (`GrassCull.ts`); before the view camera draws the meadow a compute pass
  culls the tufts against the frustum (and the thin tufts past their fold) into an
  order-preserving list and each batch's indirect draw arguments, so off-screen tufts run no
  vertex work.
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation (sun, sky, water level).
- `src/lighting/`: sun radiometry, soft solar shadows, the sun refracted below the water surface,
  the air/water optical interface, baked local sky occlusion, and the meadow's light through its
  own canopy. The sun's soft shadow reads each 2x2 footprint with one `textureGather` and compares
  it by hand (`SolarShadow`); its filter mode is set per quality tier before the materials build
  (`SunShadow.setFilter`). `SunShadow` also exposes a caster-depth grid (`nearestCasterDepth`) that
  bounds its 2x2 volume lookups, so a march through the water may skip them where nothing casts
  (never the surface filter's PCSS search).
- `src/materials/`: procedural detail textures, terrain materials (triplanar stone, hex-tiled
  after Mikkelsen so the scan never repeats on a lattice (`HexTiling.ts`), with per-facet
  shade, paler recent scars, strata, parting seams, runoff streaks from the lip and ledges, dry
  stone under overhangs, orange lichen near the lip, upper-cliff moss, a black lichen spray zone
  that climbs with the coast's exposure, turf, sea floor, light under the water; the layers over
  the stone meet it by the scan's relief, moss, turf, soil and runoff filling its low points and
  lichens taking its raised grain first, each keeping its mask's mean cover; stacked layers
  (cliff moss, root soil and turf) take adjacent ranges of the relief in stacking order, so each
  one's visible cover matches the plain mix's), wet surfaces after Lagarde (soaked pores, water
  film, runnels down the cliffs).
- `src/ocean/`: FFT ocean (compute: each axis's eight Stockham stages run in workgroup memory, one
  dispatch per axis after the spectrum kernel), waves against the rock boundary, caustics, water
  shading (its screen-space reflection marches only rays that cross `Water.reflectionBounds`, the
  box of everything opaque above the sea built from the tile layout, and stops them past it), and
  the storm sea (`StormSea.ts`: whitecap foam integrated on a world grid around the view, the
  procedural foam pattern, spray particles).
- `src/sky/`: atmosphere LUTs, environment lighting, volumetric clouds after tidewater's port of
  the Three.js Sky Pro clouds (a cloud shell 4 - 9 km up shaped by a procedural weather map and the
  64^3 shape noise in `public/clouds/`, loaded by `src/materials/CloudNoise.ts`; traced in screen
  space a sixteenth of the pixels per frame with a reprojected history, plus a panorama map for
  reflections and the environment, and a cloud-shadow map: the panorama 1024 x 256 with a
  thirty-second of it refreshed per frame, the shadow map an eighth of its rows, both refreshed
  whole on a jump and when a paused scene settles), high cirrus (fibres baked in `Cirrus.ts`), rain
  curtains under raining clouds and showers (marched along the view ray, leaning with the wind)
  with the rainbows in their sunlit rain (colours from `RainbowTable.data.ts`, generated by
  `tools/bake-rainbow-table.mjs`), the day cycle (sun and moon), the night sky (the Yale Bright Star
  Catalogue's stars in a sidereal frame, a Milky Way shaped by NASA's Gaia map, both in
  `public/sky/` and loaded by `StarCatalog.ts`), airglow and moon (NASA's colour and LOLA heights in
  `public/sky/moon/`, built by `tools/build-moon-textures.py`), weather presets, their blending and
  the auto-weather chain.
- `src/weather/`: wind, lightning (branching channels after three.js's former LightningStrike and
  point sources lighting the clouds' march from inside, after VolumetricCloudsCS1), puddles (with rain rings),
  rain (GPU drops in nested camera volumes, stopped by a top-down collision height map of the island and
  splashing where they land; a distant streak veil in the post pass; analytic ripples), distant air
  (two exponential height layers after tidewater's `AirHaze`, lit by the horizon sky and, near the
  camera, the key light through a phase function) and sea fog (the marine layer thickened in
  drifting banks of varying height, thinner over the island, plus morning mist; the banks' noise
  baked into a map, the march at half resolution, in `AerialPerspective.ts`). `warm()` on `Rain`,
  `StormSea` and `Lightning` (with `Sky.warm` and `Pipeline.warm`) precompiles their first-use
  pipelines at startup (`compileDraws` in `src/post/Warm.ts`), so a weather change or the first
  bolt builds none.
- `src/post/`: frame graph (opaque pass, depth resolve and a copy of the opaque colour, the water
  and rain drawn into the same multisampled target (its samples discarded after the rain), the sea
  fog marched at half resolution over a baked bank map, the composite of air, fog, veil and shafts
  rendered once for the sharp image and both blooms, crepuscular rays and sun glare, bloom,
  tilt-shift, tone curve and grade, the art-directed look, FSR 1 upscale (`FSR.ts`: an EASU pass,
  the sharpening in the canvas pass)), render scale per quality tier (`RenderScale.ts`) and
  high's dynamic resolution (`DynamicResolution.ts`: the scale steered by the GPU's frame time
  from timestamp queries), the frame pacer (`FramePacer.ts`), the submit batching
  (`SubmitBatch.ts`), the scene's sample count (`SceneSamples.ts`).
- `src/characters/`: the islanders. Low-poly modular figures (one shared rig and its animation
  clips) assembled from parts, repainted in the island's palette as vertex colours and merged into
  one skinned mesh; a stepped light model lit by the scene's sun and sky; a small moving sun-shadow
  map multiplied into the island's. The assembled figure can be re-proportioned once at build time
  (`Proportions.ts`: a larger head, shorter legs, a broader torso, thicker limbs, larger hands): its
  vertices follow their bones' new bind positions with each bone's flesh scaled, the bind pose and
  the clips' bone translations move with them, and the hips and legs are re-solved at every key
  (the hips sink, each foot keeps its height, the thigh and shin reach it as a two-bone chain), so
  feet stay planted and the stride shortens with the legs. Rotations elsewhere are untouched and
  everything is keyed by the rig's bone names, so any figure of the kit takes the same build, and
  per-frame skinning stays plain (bone matrices only). While the character art is settled, models
  load from the git-ignored `artifacts/assets/` (dev server only).

## Decisions (keep to these)

- Keep the island tile layout and flat central plateau. Natural contour, slope and weathering
  variation belongs to the outer rim and cliffs. Offshore stones remain submerged and form
  patchy seabed detail; no exposed sea stacks or reefs.
- The island must be able to grow by more tiles, so everything generated for it is generic: the
  cliffs, the shelf and its stones, the rim greenery and the planting derive from the footprint,
  the island's SDF and noise fields with fixed seeds (hashes of position, or random streams that
  draw a fixed count per vegetation anchor), never from coordinates placed by hand, and their
  counts follow the measured coast length or meadow area. Any tile layout then builds itself the
  same way. World generation stays deterministic whatever the thread count: parts never share
  running counts, and the merge restores the serial order.
- Cliff features (rockfall scars, joint faces, pockets, steps in the lip, gullies, the notch)
  derive from the footprint with seeds hashed from position in world-anchored cells (`Cliff.ts`),
  and an unchanged stretch of coast keeps its scars when the layout grows elsewhere: every
  property of a scar comes from its own hash, never from a running count, and each generation is
  cut into the surface the larger ones left. The wall is built as solid geometry: convex blocks
  bounded by two regional joint sets (both oblique to the tile edges), bed partings and inclined
  fractures are subtracted from a battered face, so its field stays a true distance and the
  facets stay flat up to crisp edges. It must read as natural rock, never masonry: no level
  courses or evenly spaced joints, and no lumps of dissolved limestone. Scar floors and roofs lie
  on a parting only some of the time, partings and soft beds open over a few metres and pinch
  out, and under the meadow the wall weathers back to an upper slope rather than jutting as a
  slab. Pockets are much shallower than they are wide and tall, their roofs open outward, two
  never crowd each other at one height, and their occlusion is lifted a little, so none reads as
  a black hole or a pair of eyes in the shade; the small breaks are flakes (a flat facet ending
  in a step). Above the waves the breaks stay sharp (rims rounded by a few centimetres at most);
  only the wave zone rounds them. The wave-cut notch comes and goes with the coast's exposure and
  its roof stays above the calm sea's crests; the joint faces run on below the sea, so no ledge
  follows the waterline. The weathering relief fades out at the meadow, whose height stays
  `islandSurfaceHeight`. Steps where a block fell from the lip stop below the meadow's planting
  height (2.8 m) and carry no turf. No waterfalls. Moss and greenery on the wall stay in its upper
  1.2 m.
- Around the island, the shelf's width and depth, the talus at the cliff foot, its shallow benches
  and the fallen blocks on it follow the footprint's distance, the island's SDF and world-space
  noise. The floor off the island stays below -1.6 m and every stone crown below -1.30 m, so
  nothing breaks the surface. Fallen blocks gather below the cliff's recent scars and are walked
  out from the coast until their traced outline clears the island's solid, so they rest against
  the cliff's underwater toe wherever it runs; other stones keep a wider berth.
- Keep plants and meadow cover rooted on the island top. Branches may hang from top shrubs and meadow
  around the upper rim, with uneven density and mixed lengths; avoid plants rooted on cliff faces.
  They grow in clumped patches of one to nine strands with runs of bare stone between (0.4-4 m,
  measured along the winding coast: a sparse patch breaks any longer run), a long tail of strands
  that wander and fork down to 1.5-2.6 m, leaves shrinking toward the tips, and a mounded leaf
  clump over each patch's lip; the lowest quarter of the cliff above the sea stays bare.
  The meadow's sod curls a little over the lip as a ragged turf skirt (`RimSkirt.ts`), swept along
  the coast line traced from the rim field, so it follows any shape the rim takes.
  The meadow is a sward: dense lawn tufts of narrow blades (doubled where the growth field runs
  thick, the extras folding away beyond about 35 m) and taller tussocks on a clump field; toward
  the coast the tufts grow taller and lean out over the lip instead of thinning, and the lip
  alternates between overgrown stretches (turf down over the shoulder) and cut-open root soil,
  by the rim field's root depth. Wildflowers are plants of four species (daisy, umbel, spike, cup)
  with leaf rosettes, their heads just above the sward, in beds of 3-9 gathered in drifts.
  Tussocks and flower beds (spikes furthest) keep off the islander's walking loop (`WalkLoop.ts`).
- Shrubs (up to about head height) and small trees (2.5 - 3.5 m) grow on the plateau in loose
  groups. Their sites come from fields and the meadow's area (one tree per about 120 m^2, one
  group per about 13 m^2). They keep off the islander's walk and out of the puddle hollows
  (`PuddleHollows.ts` repeats `puddleField`'s hollows on the CPU: change both together), draw from
  their own random stream (the rim bushes' stream also places the rim trails), sway with the
  plants' wind, cast into the sun's map and stop the rain. A limb casts whole or not at all: limbs
  that leave their parent 3 cm or more in radius cast; thinner twigs, shrub stems and stalks do
  not. Around their stems the turf, grass and flowers lose ambient light (baked on the CPU into the
  island's occlusion and the anchors' sky visibility), so they stand in the meadow rather than on
  it.
- All vegetation moves in one wind field (`windField` in `Wind.ts`): a
  tileable gust map (two channels of periodic noise, ranked to an even spread) scrolled with the
  wind's integrated along-wind travel, its gust fronts long across the wind (16 m along, 28 m
  across) and finer eddies running 1.25 times faster inside them, so gusts visibly sweep the
  meadow and change as they go. It gives a lean (tip offset over height) from the wind's pressure,
  ( speed / fair )^2, times a calm share plus the gust's, eased toward a maximum: still air is the
  rest pose, a fair day leans 0.03 between gusts and 0.13 in one, a storm 0.2 and 0.6. Plants
  answer it in Crysis's layers (Sousa, GPU Gems 3 ch. 16): the whole plant bends from its root
  with the field at the root, every vertex keeping its distance from it (`mainBend`), and sways
  about the lean at its own rate (shrubs 0.9 Hz, trees half that); sprays, fronds and leaf stalks
  swing on their own phase from where they leave the plant; leaf edges and tips flutter along
  their normals, faster as the wind rises. Grass tufts bend with the field at their root and their
  normals turn with the bend, so a gust shows as a sheen; flowers and the turf skirt follow the
  same field. Rim trails lean and swing like pendulums but may be pressed toward the wall by
  3 cm at most, and a gust lifts them off it. Everything is a function of the wind's integrated
  clocks and travel (`clock`, `flutter`, `gustScroll`, wrapped where every rate completes whole
  cycles), so a paused frame and a seek repeat exactly; shadows and the rain's collision map keep
  the rest pose. The grass cull pads each tuft's sphere by twice its origin's offset from the
  sphere's centre, since the bend turns every vertex about that origin. Each mesh keeps the old
  global-sine sway's material for A/Bs (`flags.windLegacy`, URL `windLegacy`; `WindVariants.ts`),
  and the depth prepass copies both.
- For motion vectors (TAA) every wind displacement is a function of the wind's state alone, its
  vertex inputs bound inside: each vegetation material records it with `setWindDisplacement`
  (`material.userData.windDisplacement( state )`, read by `windDisplacement( material )`), where
  `state` is `shared.wind` for the frame being drawn or `shared.wind.previous` (the same uniforms
  as the last rendered frame had them, set by `Wind.update`; equal to the current ones while
  paused and after a seek, so a jump leaves no motion). Evaluate it in the material's position
  stage (its rest inputs read `positionLocal` before three assigns the swayed position); the
  grass's widening keeps the current camera's.
- Grass blades do not cast into the sun's shadow map (they are narrower than a texel and flicker as
  the sun moves); the meadow shades itself and its turf through `MeadowCanopy`. Stems, leaf stalks
  and twigs (a few millimetres across) stay out of it too. The map is fitted to the island's
  casters (the sea floor's stones cast only into the refracted map) and redrawn each time the key
  light has turned 0.2 degrees; every receiver cross-fades from the previous step's map by the
  light's progress (`SunShadow`), so shadows move smoothly instead of re-rasterising every frame,
  and a paused clock holds them exactly. Both stepped sun maps always share one filter mode, each
  with its own blocker search, so the cross-fade stays continuous across a redraw. The underwater
  (refracted) map redraws when the key light has turned by its angle gate (0.03 degrees on high),
  and exactly whenever the light is at rest (the same direction on two consecutive updates), so a
  paused frame is the same however it was reached: after a paused seek it redraws on the second
  update. On screen a blade is kept at least two pixels wide (0.75 on the outer rim, where partly
  covered pixels show a pale fringe over the sea) with its coverage lowered to match through alpha
  to coverage, so the meadow does not crawl as the camera moves; close up the blades render
  unchanged. Beyond 40 and 70 m from a batch of tufts the lawn draws 12 and 8 of its 16 blades per
  tuft (tussocks in proportion; `GrassQuality`). Blades a few pixels wide widen and cover for the
  dropped ones (`bladeGain` = n / k, in full at 4 pixels and fading out by 16), so the meadow keeps
  its density and brightness while broad near blades keep their own width. The band follows the
  camera's position alone (no hysteresis), so a paused frame does not depend on the path the camera
  took; one box spans each batch, so a larger island keeps more of its meadow in the nearer bands.
  The thin extra tufts are not drawn once the camera is beyond their fold (42 m). Single-sampled
  (`msaa=1`), leaves take a plain alpha test and grass blades an ordered 4x4 dither in place of
  alpha to coverage (`ALPHA_TO_COVERAGE` in `Foliage.ts`), the blades kept one pixel wide rather
  than two (a blade dithered across two pixels reads as a dotted line). Vegetation materials carry
  `userData.vegetation` (`markVegetation`) for passes that treat them apart; the terrain's meadow
  detail is flagged `userData.meadowDetail` instead, so it never takes the vegetation's shadow
  filter.
- At 4x the vegetation's coverage is decided by the depth prepass alone; the shaded vegetation
  draws as plain opaque geometry limited by equal depth to the prepass's samples, so each blade
  and leaf covers exactly the samples it did. Its visible samples are shaded as an ordinary
  pipeline shades them (a little crisper inside the canopy than a coverage pipeline, the same
  brightness). `debugFlags.vegPrepass = false` (URL `vegPrepass=0`) brings back the single
  coverage pass, `vegPrepassOpaque = false` (`vegPrepass=coverage`) keeps coverage in the shaded
  draw. A depth copy follows its mesh's per-draw choices (blade count, `bladeGain`, the culled
  list), so the equal test holds for every batch.
- The view camera's grass draws are culled per tuft on the GPU by a padded bounding sphere (the
  widening's 15 half widths, sway, standing water's sink) and compacted by a scan, never an
  atomic append, so the tufts keep the order a draw of every tuft takes and a paused frame
  repeats; the dispatch is skipped while the view and the blade selection are unchanged. Without
  the prepass, or with coverage kept in its shaded draw, the image is that of a draw of every
  tuft to the byte; behind the prepass's opaque shaded draw a few isolated pixels of the meadow
  differ from it (the set depends on the drawn instance list; 2000 to 8000 px of a close meadow
  view on high and medium, by up to 25 levels). Indirect
  arguments are set on a batch's geometry for its own draw only: other draws over the same
  geometry (the rain's collision proxies, orthographic cameras) draw every tuft.
  `flags.grassCull = false` draws every tuft through the same storage path.
- The sea is calm in everyday weather: no shore foam or whitecaps. Only a storm's gale builds a
  rough sea with whitecaps on folding crests, foam that trails behind them and fades, and spray.
  Weather only scales the wave cascades' amplitude; it never rebuilds the wave spectrum. Storm foam
  and spray are lit by the scene (never self-lit), and a paused frame replays their history at
  fixed steps, so it stays exactly repeatable.
- One dominant key light (sun by day, moon by night) drives terrain, characters, water, caustics
  and every shadow map; sun/moon handoffs pass through zero direct light: the sun's key fades as
  its drawn disk sinks below the horizon, and only then turns toward the moon. The day cycle is
  authored, not astronomical. The sun and moon are drawn at twice their true size (equal to each
  other); shadows and glints use the true sun. A low sun's key stays golden orange: the optical
  depth that sets its hue is capped, while its brightness still follows the full extinction.
  The sky, sun, moon, stars, key light and grade follow the clock every frame; only the
  reflection panorama, environment and irradiance cross-fade between bakes. A periodic bake on a
  running clock spreads over frames: its panoramas and irradiance in the frame that asks for it,
  then the environment's PMREM conversion and GGX filters at most four render passes a frame,
  published (with the same products as a whole bake) a few frames later. Explicit bakes (presets,
  seeks, weather jumps, the first bake) and any bake while the scene clock is paused run whole, so
  paused frames stay exact.
- The exposure only rises from afternoon into night and holds from the end of the blue hour (about
  -7 degrees) on, higher than the night sky was tuned for, so the island reads by moonlight and
  starlight. The night ambient rises as the sun's skylight fades after sunset, so twilight is
  never darker than the night; the night sky's own light (stars, airglow, moon disk, the sky's
  night floor, clouds) scales back to keep its tuned look in deep night.
- Quality tiers (`src/Quality.ts`, one table): high, medium and low. High is the
  reference image; medium and low trade a little of it for time, each knob judged in captures:
  one screen-space reflection ray (its 14 steps grow by 1.51, so it reaches as far as high's),
  fewer refraction and water-column samples, a lighter sun-shadow filter (bilinear on
  vegetation, and on everything on low), fewer lawn blades with the canopy light per vertex, fewer
  sea-fog steps and depth-of-field taps, a cheaper cloud march and panorama refresh, slower sky
  bakes with the environment's PMREM on every second one from a 256-wide source, a coarser
  refracted-sun gate and fewer rain drops; low also marches the sea fog at a quarter resolution
  and draws fewer veil shells and ripple layers. Low keeps both bloom chains and the full storm
  foam: one merged chain veiled a golden-hour island in glow, and the merged foam turned the
  crests' streaks into scattered lace. No knob alters the weather, clock or lighting state, so a
  tier changes the cost, not the mood. A change of tier reloads the page.
- The tier is chosen at startup, as games do (`src/QualityDetect.ts`): on a first visit without
  `quality`, the page loads as high and, behind the loading screen, times the GPU's busy time for
  30 frames (after half a second of warm-up) at high's nominal render scale, the dynamic scale held
  there (timestamp queries; without them each frame's time to the queue's completion, which counts
  its JS too). A cost model per tier (a fixed part and a part that follows the pixel count, fitted
  to all three tiers at two scales) turns that into each tier's predicted time; the highest one
  under the paced interval less 2.8 ms wins, high judged at medium's render scale (a GPU that needs
  high below medium's pixel count gets medium's image instead). The choice is kept in localStorage
  with the GPU adapter's name and measured again only on request (the GUI's re-detect,
  `autoQuality=detect`) or when the adapter changes; a lower tier reloads the page into it. It
  never measures or switches while paused, under `quality`, or in an automated browser (captures,
  profiles and probes keep medium unless they pass `autoQuality=detect`), so their frames are as
  before. The Performance folder shows how the tier was chosen and the numbers behind it.
- The scene is multisampled 4x on every tier (WebGPU has only 1 or 4 samples; there is no 2x):
  without it alpha to coverage becomes a dither, the meadow turns to dots and edges alias, so the
  tiers save through their render scale and knobs, never through multisampling.
- The scene renders at a pixel ratio set by the quality tier. Medium renders at a 1600x900 pixel
  budget and low at 1280x720. High's is dynamic (`DynamicResolution.ts`): from the display's ratio
  (up to 1.5) down to a floor of 0.6 in steps of 0.05, steered by the GPU's frame time (timestamp
  queries, read as the time the GPU was busy with each frame; the frame intervals without them)
  against the paced interval: the window's 90th percentile must stay under the interval less
  1.8 ms (14.9 ms at 60 fps, 23.2 at 40). On a 120 Hz display the share of frames presented a
  refresh late held its floor of 1-2 % until that quantile passed about 14.5 ms and rose steeply
  past it (4 % at 15.1 - 15.4 ms, 13 % at 16.3, 31 % at 17.5); the 97th percentile it steered
  before sits on the periodic bake frames, which hardly follow the pixel count. The GPU's clock
  stays at its top step at every scale while frames are paced (its performance states, read
  through IOReport), so the GPU time follows the scale; another page or app drawing at the same
  time lengthens it, and the scale then goes down as it should.
  Every change softens or sharpens the whole image, so it changes as seldom as it can: down when
  the window passes its limit (at most every 1.5 s, sooner when frames take the whole interval),
  straight to the scale a cost model predicts lands under the interval less 2.4 ms (a fixed 6.8 ms,
  fitted on the display, plus a part that follows the pixel count), in one change; up after 4 s at
  a scale, by at most two steps, when the same model predicts the larger render lands there. A
  scale it had to leave needs a wider margin for a while, and one it stepped up to and had to leave
  at once is not tried again until its bar runs out (8 s, doubling up to 64 s), so a noisy load does
  not make it oscillate; the bars expire, so the scale climbs back once a heavy view or another
  page's load is gone and never drifts only down. Its first decision comes behind the loading
  screen, which waits for it (at most 3 s): from the nominal ratio it jumps once to the scale the
  first frames call for. On a 120 Hz display, in a player's normal window (four fifths of the
  screen's height) dragged over the island, it holds 1.05 (1.0 before, with five times the
  changes) at as few late frames, and 1.5 at `frameRate=40`; full screen it holds 0.9 in fair
  weather and 0.8 in a storm (0.85 and 0.7 before) under drags that switch views and zoom, which
  change its scale about 15 times a minute (as before): it follows the cost of the views (the
  horizon view and a close zoom cost more than the island's). A change only resizes the frame
  graph's targets: no pipeline is built and no frame is dropped (the cloud view
  on high is sized from the display, so its kernels never rebuild). Paused, under `dpr` or with
  the GUI's full resolution it renders at its nominal ratio, so paused frames and captures render at
  the reference scale whatever scale the running page had reached, and match the reference image.
  `dpr` and the full resolution also lift the lower tiers' budgets. The canvas always matches the
  display (up to 2x): a render below it is upscaled inside the frame graph with FSR 1 and the grain
  added after, never stretched by the browser. Every pass is sized to the render, not the canvas
  (`rtt()` passes through `sizeRtt`). At the display's ratio nothing is upscaled, so `dpr=1`
  captures are unchanged.
- The loop holds the tier's frame rate on a display faster than that (`FramePacer.ts`, 60 on high
  and medium): it renders on every second refresh at 120 Hz (every refresh at 60 Hz, 72 fps at
  144 Hz) and skips the other animation frames before three's loop sees them, so every frame stays
  on screen equally long. Unpaced, frames that keep the GPU busy for 12-16 ms finished one, two or
  three refreshes after the one before as the queue drained, a sixth of them 8.3 ms apart and a
  third of the intervals changing cadence: stutter while the camera moved, at an average above
  60 fps. Low renders on every refresh (`frameRate: 0`): its light frames, held to 60 Hz, finished
  right at the compositor's deadline and were shown one and three refreshes apart in turn. The
  refresh is measured from the animation frames' own timestamps. The scene's clock steps by the
  frames' vblank times (rAF's timestamp), not by when the tick starts (a few milliseconds into the
  frame, by a varying amount). The camera applies its input once per rendered frame (see the
  island camera below): three's OrbitControls damped on every `update()` and its pointer and wheel
  handlers called it on every event, so with input at the display's refresh a frame took one to
  three damping steps by chance and a steady drag turned the camera in uneven steps.
  A hidden page renders nothing: the loop stops while the document is hidden and starts when it
  shows (unless it was stopped or started otherwise meanwhile, as the profiler's pages are).
  Browsers stop a hidden tab's animation frames themselves, but an app's embedded browser kept
  running them: a page left in a hidden pane rendered high at 60 fps and took about half the GPU
  from the page on screen, whose scale fell from about 1.0 to its floor of 0.6.
- A frame reaches the GPU in about 16 submits, not the 90 three makes (one per render pass,
  compute group, copy and mipmap chain): `SubmitBatch.ts` holds three's command buffers for a
  fraction of a millisecond and submits them a few at a time in the same order, staging a queue
  write that would overtake a held command buffer using its buffer as a copy in its place, so the
  GPU runs the same commands in the same order and the image is unchanged. On macOS each submit
  is a Metal command buffer and the queue holds at most 64 uncompleted ones: with 90 a frame, a
  submit waited 9-20 ms whenever the GPU ran a frame behind, in the thread of Chrome's GPU process
  that also presents the page, and the display held a frame for 3 to 10 refreshes (the hitches
  over 25 ms). The first command buffer after a pause goes at once: held for most of the tick,
  the frames came late more often. A test page paced the same way and drawing the same GPU load
  in one pass was presented a refresh late 0.1-0.4 % of the time on a 120 Hz display (still, and
  dragged in a window), the scene 1.5-2 % before. On that display, against `submits=each` in the
  same build (ABBA pairs), in a player's normal window dragged over the island the share of frames
  presented a refresh or more late fell by about two fifths, the longest interval by a third or
  more and the changes of cadence by about two fifths; full screen alike. The late frames left
  follow major GCs, which the batching does not address: a GC releases the WebGPU objects
  (encoders, passes, command buffers) of every frame since the last one, and the GPU process's work
  on them is the same either way (fewer, merged encoders are left to the frame-graph refactor).
- The island camera (`IslandCameraControls.ts`) works as island and city-building games do
  (Islanders, Dorfromantik; Anno, Frostpunk and Planet Zoo differ mostly in the buttons): a left
  drag grabs the ground (the point under the press stays under the pointer, solved exactly each
  frame; a press stays a click until it moves 3 px, so a left-click action can share the button),
  a right or middle drag (Option or Ctrl with the left, for a trackpad) turns about the ground at
  the screen's centre and tilts, and the wheel zooms toward the point under the pointer while the
  view tilts toward the horizon as it closes in (12 degrees per e-fold of distance). On a trackpad
  a two-finger swipe moves the ground with the fingers and a pinch zooms (Chrome sends it as a
  wheel event with ctrlKey); a mouse wheel is told from a swipe by its deltas (macOS reports a notch
  in multiples of 4.000244140625 px, a trackpad in whole pixels with `wheelDeltaY` three times
  `-deltaY`), and the GUI's scroll setting overrides the guess. Keys pan, turn, tilt and zoom;
  panning at the window's edge is off by default (in a normal window the edge is where the pointer
  leaves). What the hand moves directly (a drag, a swipe, a pinch) has no smoothing between hand
  and view; only the wheel's zoom glides (80 ms), the keys ease in and out (100 ms), and a drag
  let go while moving glides on (220 ms). The orbit before damped every input by 6 % a 60 Hz frame
  (a 0.27 s time constant): in a steady drag on the real display the view trailed the hand by
  260 ms (120 px at 450 px/s), 290 ms to the photons, which players read as dropped frames; now it
  trails by 8 ms (3.6 px), 36 ms to the photons. Input is gathered by the event handlers and
  applied once, at the start of the tick that draws it (`advance( dt, time )`), never between
  frames. A drag is read one input sample interval (at most 8 ms) behind the frame's vblank,
  between the two pointer samples around that time (input resampling): read at its newest sample,
  a 125 Hz mouse moved the view by up to two fifths more or less from one frame to the next (p90),
  and by 4 % resampled. The motion is taken as deltas on the camera's current position and pivot,
  so placements by hand (the views, the tools) keep their pose, and the limits constrain input
  only: the pivot within the island's bounds plus 12 m, the farthest zoom from the island's
  diagonal (190 m for this layout), the camera 2 m above the ground (a height grid of the island's
  meshes, `IslandGround.ts`). At rest the update is three's OrbitControls' arithmetic to the bit,
  its constructor's update included, so paused frames do not depend on input history and match
  captures from before. The pipeline adds about 28 ms from a frame's vblank to its presentation
  (the GPU's frame and the compositor's next refresh, steady: no queued frames), and a pointer move
  waits about 8 ms for the next paced frame.
- The sea continues to the horizon (a skirt around the wave grid); the camera's far plane and
  the sky-depth thresholds (`-9e4`; the resolved sky is `-1e5`) stay beyond it.
- The tone curve is PBR Neutral with hue-kept highlights (`neutral-hue` in `src/post/Pipeline.ts`):
  PBR Neutral's toe, linear midtones and grade, where the scene was tuned, keep the water clear
  (deep sea dark and saturated, the shallows' seabed and caustics in full contrast). Above the
  start of its shoulder each colour is scaled by its brightest channel without PBR Neutral's
  desaturation, so a low sun's sky and sea keep their hue instead of washing to cream; only above
  white do highlights fade to white. A soft knee below white leaves the split tone's golden red
  room for gradation, and bright colours alone gain a little saturation; both give way for scene
  colours far above the brightest sky (8 - 32 times white), so the sun and its glints burn out. AgX was tried as the
  default and dropped: its toe greyed the deep water and its shoulder flattened the shallows.
  Each curve carries its own grade (exposure gain, saturation, vibrance, contrast); AgX with
  hue-kept highlights (`agx-hue`), plain AgX and plain PBR Neutral stay selectable in the GUI
  (`tone` URL option) for comparison. The night keeps PBR Neutral's look with its grade
  whichever curve is chosen, crossfading as the sun sets (from the horizon to about -3 degrees,
  so twilight is no darker than under PBR Neutral): its toe holds the night's dark colours
  saturated where AgX's greys and lifts them, and its short shoulder lets the brightest few stars
  reach near white.
- The fantasy look is an art-directed layer over the physically based image, never baked into the
  lighting or the tone curve: after the curve and its grade, `Pipeline`'s look adds a soft
  Orton-style glow round the island's highlights (the sky and what lies beyond a few hundred metres
  glow only weakly, and the glow is held back over dark parts and over parts far darker than the
  light it spreads from, so it never lays a veil, nor a haze over backlit foliage), richer
  greens and teal water keyed by hue and saturation (grey stone and skin stay as they are), golden
  highlights over cool teal shadows, a teal shadow lift that turns a shadow's hue but keeps its
  saturation (a dark meadow under a low sun stays green, not olive-grey), and a little depth. `soft-fantasy` is the
  default, `rich-fantasy` a bolder step toward a painted scene. `realistic` leaves the
  image exactly as the curve and grade make it and stays selectable (`look` URL option, GUI Look
  folder) for comparison; every parameter is in the GUI. The look fades out with the night (the
  night keeps its authored colours); its glow, golden highlights and lift follow the weather's
  direct sunlight, and only part of its colour holds under a closed sky, so bad weather stays dimmer
  and greyer than a clear day.
- The tilt-shift blur belongs to the island's surroundings and eases off kilometres out: a blurred
  sky reads as a low backdrop and turns stars into bokeh discs. Stars are points with a natural
  spread of brightness, kept below white except the brightest few; only those near the horizon
  scintillate. The stars and Milky Way are the real sky as seen near 28 degrees south (the
  sun's authored path fixes the latitude), turning with the clock about the south celestial pole;
  procedural grain and faint stars only add detail below the catalogue and the map.
  The night is art-directed, not a simulation of the eye's night vision: colours stay as authored
  so a future fantasy palette (glowing plants, magic) keeps its saturation.
- One cloud field feeds the visible sky, water reflections, environment lighting and cloud
  shadows. Bad weather dims and desaturates the existing light; it never adds a grey screen veil.
  Distant air fades in across a protected foreground (from 40 m, in full by 200 m, sooner in
  thick air), so the island does not fog up as the view pulls back; it scatters only the sunlight
  the cloud shadows let through. Sea fog is a low height-fog layer that may surround the island,
  never a uniform tint. The sea fog's bank noise is baked into a map around the camera in the
  drifting frame, on a lattice fixed in that frame. While the fog's clock steps forward frame by
  frame, the map is re-baked after 0.2 s of fog time or 48 m of camera travel; otherwise (paused,
  after any seek, and on the first frame after either) it is re-baked whenever its time or centre
  differs, so a paused frame stays exact. The fog is marched at half the render's resolution on
  the nearest surface depth and upsampled with Gaussian depth weights; a pixel that none of its
  texels matches in depth (sky or sea between leaves) marches its own fog at full resolution. Haze
  and rain veil stay at full resolution. Weather changes sweep the sky as a front from upwind; the
  island's lighting follows the front's progress over the island.
- The directly seen clouds accumulate over frames; a scene at rest (paused clock, still camera)
  settles its clouds once and keeps them, so a paused frame is exactly repeatable. The cloud
  march assumes a camera below the cloud base. On high the view's resolution is a share of the
  display (0.58 of the render at high's nominal ratio), not of the render, so the dynamic render
  scale neither softens the clouds again nor rebuilds the view.
- Lightning is a function of the scene clock: a paused frame holds its strike exactly
  (`sky.lightning.force` stages one for review). Its light inside the clouds stays out of the
  view's accumulated history, the bake and the panorama; channel, cloud glow and the island's
  flash share one intensity per strike.
- Rain is light streaks plus analytic ripples on the water normal. Drops are a stateless function
  of the clock, the wind's integrated travel and the camera (a paused frame repeats exactly); they
  stop on the first surface in the collision map and splash there (crown and droplets on land,
  rings on the sea). Out-of-focus drops follow the tilt-shift blur. Wetness darkens exposed rock
  and plants within small limits, glosses bare stone, persists after rain and leaves the tidal
  band alone; dry weather renders exactly as without it. Water runs down the cliffs in sparse
  darker runnels while they are wet. Standing water fills fixed hollows on level ground as the
  ground soaks, drowning the meadow blades but for a few tips, and shrinks inside its own damp
  stain as it dries. Puddles mirror the sky through an art-directed reflectance (stronger than
  water's 2 %, still following Fresnel), so they read as water from above.
- The art has three layers in one world: nature (cliffs, sea, plants) is realistic; things people
  make (huts, boats, baskets, lanterns) are semi-realistic and handmade, a little chunky and
  rounded in form but with real materials (wood grain, rope, fired clay), and bridge the other two;
  people are stylised, with simplified forms and blocks of colour. All three share one lighting,
  one grade and one palette, so they read as one place (as in Alba, Sky and Tchia).
- Characters are simple low-poly figures with flat colours and simple faces, recoloured into the
  island's palette and lit by the island's own light in soft cel steps; no outlines. Plants keep
  their realistic shading. The islanders are a Hylian-like people (after The Legend of
  Zelda: Breath of the Wild): human in every way but for long pointed ears that sweep back and a
  little up, grown on any head of the kit (`Ears.ts`) and bound to its head bone. Their dress stays
  plain while the basic look settles: undyed linen and calm earthy tones, leather shoes, no hat.
  They are built in the medium proportions of `Proportions.ts` (about 4.7 heads tall, against the
  kit's 5.5: a larger head, shorter legs, broader shoulders and hands), chosen by the user from
  four builds; the kit's own stays selectable for comparison.
- Do not commit reference images, and do not ship third-party art without a licence.
- Third-party code: files adapted from another project open with a `/*! ... */` notice (project,
  copyright line, licence) and the licence text sits next to them (see `src/ocean/tidewater.LICENSE.txt`).
  Public-domain code (CC0, Unlicense) needs no notice; credit it in a comment instead. Techniques
  borrowed without code are credited in a comment where they are used.
- `CREDITS.md` lists every third-party source: adapted code, assets (source, author, licence and how
  each file was processed) and techniques. Update it with any of these. npm dependencies are not
  listed; their licences are collected into `dist/licenses/` by the build. Any other licence text that
  must ship with the build goes in `LICENCE_FILES` in `vite.config.ts`, which copies it there too.

## Conventions

- Code style follows three.js (mrdoob): tabs, spaces inside parentheses and brackets, comments in
  English that explain why.
- Check visual changes with captures, compared against the previous capture (and crops, not only the
  whole frame); report measured differences.
- Measure frame time with `tools/profile-frame.mjs` on a production build, under the GPU lock: its
  scene matrix at the default generic display (1920x1080 CSS at DPR 2, quality high), before and
  after a change (`--compare` for an A/B, or `--toggle` on a debug flag while the change is in
  development). Judge an A/B by its GPU time per pass; take frame rates from a run without GPU
  timestamps (`--timestamps off` or `both`): Chrome ran frames up to a quarter faster with them
  on, so their per-pass split shows where the time goes, not the frame rate a player sees. (High
  keeps its dynamic resolution's own timestamp queries in every run, as a player's page does;
  `--q gpuTimer=off` leaves them out.) Judge
  whether a tier holds 60 fps with `--accept` (under vsync), not from uncapped intervals, at the
  tier's own settings (high with its dynamic scale, measured at its settle point with
  `--scale-settle 5`; the report gives each scene's scale), and check how a change plays on a fast
  display with `--display` (pacing, cadence, the scale's changes under drags). Report contended
  runs as such: check `node tools/gpu-lock.mjs gpu` before each run (and during it when other
  windows stay on screen). A player's window is not full screen: other apps stay visible
  and may keep drawing (a Soomi page in an app's hidden browser pane took half the GPU and held the
  player's scale at its floor), so check a change in a normal window too, not only `--kiosk`.
  Headless at 60 Hz matched the display's GPU times within about 5 %.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, the summary in lower case, imperative, without a full stop, the header at
  most 100 characters, and the body explaining why. Types: `feat`, `fix`, `perf`, `refactor`,
  `style`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. The scope is optional; when given, it
  names the section of the codebase changed (for example `ocean`, `world`, `ai`). Mark breaking
  changes with `!` after the scope or a `BREAKING CHANGE:` footer.

## WebGPU / TSL pitfalls met here

- Once `material.positionNode` is set, `positionLocal` reads the displaced position; use
  `positionGeometry` for the undisplaced one.
- In a full-screen pass (`QuadMesh`, `RenderPipeline`) the camera nodes refer to the pass's own
  camera: pass the scene camera's matrices as uniforms.
- Screen uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
- Multisampled depth can only be read with `textureLoad`, one sample at a time (the sample index
  goes in its level argument); `Pipeline` resolves it to linear view z. Single-sampled, that
  argument is a mip level: load sample 0 only.
- WebGPU multisamples with 1 or 4 samples only: three turns `samples: 2` into one sample, with no
  MSAA. A material with `alphaToCoverage` still builds its coverage alpha (three reads the
  requested count) and then draws it opaque. Vegetation follows `ALPHA_TO_COVERAGE`; to find
  vegetation materials use `userData.vegetation`, not `alphaToCoverage`.
- The water draws into the scene's multisampled target and cannot sample it: it reads
  `Pipeline.opaqueRT` (a copy of the opaque colour) and `depthRT` (sample 0, and the farthest
  sample for what lies behind the sea at an edge pixel). Post passes read `surfaceRT`, the
  nearest surface's depth with the sea's included.
- WebGPU needs uniform control flow for implicitly filtered texture samples and derivatives: take
  them (`.toVar()`) before any `If` / `Loop`; inside branches and loops use `.level()` or `textureLoad`.
- Nested loops: pass both ranges to one `Loop()` call so the counters get distinct names (`i`, `j`).
- Shadow passes keep `alphaTest` and `alphaMap` but not `map`: alpha-tested foliage sets both `map`
  and `alphaMap`. The leaf `map` is opaque and the silhouette lives in `alphaMap` alone, whose mips
  are built on the CPU to keep the leaf's coverage at the cutoff (box-filtered mips fill the card).
  Alpha-to-coverage turns alpha short of cutoff + `fwidth` into partial coverage, so keep leaf
  interiors at 1 rather than scaling alpha down.
- Vegetation draws before the terrain (`renderOrder = -1`) so the turf under it fails the depth test.
- A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so a standalone one
  is declared multisampled and cannot be sampled with a comparison; give it a render target.
- The water's fragment stage already binds 16 sampled textures, the most WebGPU guarantees; a new
  texture there fails pipeline creation unless another one goes (the sun's two shadow steps share
  one array texture for this reason). Data that changes over metres can be read in its vertex
  stage instead and passed on as a varying (the estimated sea floor's beds and sand), but the
  varyings have a ceiling too: the water uses 14 of the 16 inter-stage variables WebGPU
  guarantees.
- The water's reflection only finds what lies inside `Water.reflectionBounds`: the layout's box,
  padded 2.5 m for the rim overhang and to a metre above the tallest tree (`TREE_HEIGHT`), down to
  0.35 m below the sea. Anything opaque built off the island or above the trees (a boat, a hut, a
  mast) must grow that box, or the sea will not reflect it; debug builds warn once if a mesh pokes
  out.
- three picks one sampler type per depth texture per material. In a material whose shadow filter
  gathers a map (`SolarShadow`), read that map only by gather and compare by hand
  (`solarVolumeVisibility`); a comparison-sampler reference belongs in a material of its own.
- three emits a light's shadow filter inside the branch of its frustum test, where derivatives are
  undefined for quads that straddle it; `installOpenShadow` evaluates the filter first and selects
  its result. Keep any filter that takes `dFdx` / `dFdy` out of `select()` / `If` branches.
- Passes in `Pipeline.passes` are resized to the render by `sizeRtt`. The sea fog's reduced targets
  are sized by `AerialPerspective.setSize` and its bank map has a fixed size: keep new reduced or
  fixed passes out of that list. The last pass into `sceneRT` (the rain) discards its multisampled
  samples through a hook on the backend's command encoder (three r186 opens one encoder per render
  pass); a pass added after it that reads `sceneRT`'s samples or depth must move the discard.
- `renderer.compileAsync` collects its draws and reads the render target synchronously, before its
  first await: set the target, call it, restore the target at once, then await (`compileDraws`).
  It builds a transparent double-sided material's two passes after restoring its side, as one
  unused double-sided pipeline (r186): compile a copy of the material per side and keep the copies
  (disposing them releases the shared pipelines; see `Lightning.warm`).
- Dispatch a compute kernel that uses `workgroupBarrier()` by size (`computeKernel( [ n ] )` with
  `dispatchSize` set), not by a thread count: a count makes three insert an early-return bounds
  check ahead of the barriers. A multiple-render-target `QuadMesh` writing the FFT's four fields
  measured slower than four single-target passes (sky-bake frames blocked in JS), so they stay
  separate. A `Fn( ... ).setLayout( ... )` helper that reads uniforms can be emitted with another
  kernel's uniform names when two compute kernels that use it are built (r186).
- A 16-bit index is copied into a new 32-bit array when its GPU buffer is created, and the copy is
  uploaded from then on (r186): an index rewritten in place must be a `Uint32Array`. Leave
  attributes that change once per event at the default static usage and set update ranges:
  `DynamicDrawUsage` re-uploads the whole buffer on every draw.
- Two programs that must produce bit-identical depth (a depth prepass and an equal-depth draw)
  need WGSL's `@invariant` on the clip position: three r186 does not emit it, so
  `VegetationPrepass.ts` patches the material's builder (`getBuiltins`). Without it a few samples
  fail the equal test and show the clear colour. A coverage (alpha-to-coverage) pipeline shades
  differently from a plain one over the same samples, and its fragments cannot be rejected before
  shading: with a prepass, drop coverage and the alpha test from the shaded draw. Keep
  `material.alphaTest` itself at its value (the shadow passes copy it) and leave it out of the
  shader build only. A new alpha-to-coverage vegetation group joins `installVegetationPrepass`'s
  list, and anything that finds vegetation after the first frame reads `userData.vegetation`
  (the prepass turns `alphaToCoverage` off).
- A material that applies instancing itself from storage buffers (instead of three's instanced
  attributes) must hold the placed position in a variable (`toVar`), as three's instancing
  assigns it to `positionLocal`; an inline expression rounds differently and flips a few hundred
  edge samples. `instanceColor` (exported from three/tsl) multiplies the diffuse colour whenever
  the object has a truthy `instanceColor`: assign it in the vertex stage. A per-object uniform
  (`onObjectUpdate`) reads the drawn object's own `userData`: a copy drawn over the same geometry
  (the prepass's depth meshes) must carry the fields its shader reads (`grassCulled`).
- A compute kernel dispatched by the size of a target (`compute( width * height )`) is rebuilt,
  with new pipelines, whenever that size changes; at high's dynamic render scale that would be at
  every step. Size such work from something fixed (the cloud view on high follows the display) or
  keep it a render pass (render passes and their pipelines do not depend on the target's size).
- With `trackTimestamp` three resolves its timestamp queries into a single buffer and drops what
  it resolves while that one is mapped. `GpuFrameTimer` (dynamic resolution) and the frame
  profiler each take over the pools' `resolveQueriesAsync`; only one may own them, so the page
  feeds the dynamic resolution from the profiler while the profiler times passes.
- `SubmitBatch.ts` wraps the device's, queue's and encoders' methods (installed when it loads,
  before the renderer) and holds submitted command buffers: a queue operation that must not
  overtake them flushes them first (texture writes, `mapAsync`, `onSubmittedWorkDone`, `destroy`,
  error scopes, the canvas's `configure`). Raw WebGPU work outside three goes through the same
  wrappers; a new kind of queue operation needs a flush there, and a buffer a new encoder method
  reads must be added to its tracking, or a write may overtake a held command buffer that reads it.
  One invalid command buffer makes the queue reject every command buffer submitted with it, the
  staged copies included: a pipeline that fails to build (three records its pass once before it
  skips the pipeline) loses the rest of that batch, not one pass, and the frame may show stale
  uniforms or missing passes. Debug builds stop batching after the device's first uncaptured
  error (one warning); a profiler or tool that times the queue's calls wraps the natives under
  the batching (`QUEUE_NATIVES` on the queue), not `queue.submit`, or it times them twice.
- `Sky.ts` drives three's `PMREMGenerator` private steps (`_setSizeFromTexture`, `_init`,
  `_textureToCubeUV`, `_applyGGXFilter`, `_setViewport`) to spread its filter chain over frames;
  re-check them on a three upgrade. Without them it falls back to `fromEquirectangular`.
