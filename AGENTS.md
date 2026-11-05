# Ponlai

A small island in an open sea, rendered in the browser: a visual sample for a game, and the game
growing behind `?game`. The look is a calm, painterly island,
inspired by the eastern aesthetic of Ghost of Tsushima, on a physically based scene lit as the
sun and the sky give it (deep clear water, chunky stone, a lush meadow that moves in the wind,
with wildflowers). The look and what to avoid: `docs/art-direction.md`. The game's design:
`docs/game-design.md` (read it before gameplay work).

## Where things are written

- This file holds only what every change needs. Each module's rules and their reasons live in its
  header comment: read it before changing the module.
- A change to a module's behaviour updates that module's header comment. AGENTS.md is updated when
  a cross-cutting rule or the map below changes (no size limit, but module-specific detail stays in
  the module). Art decisions go to `docs/art-direction.md`, tool manuals to `docs/tools.md`.

## Stack and commands

- TypeScript (strict), Vite, three.js `WebGPURenderer` (`three/webgpu`, `three/tsl`). WebGPU is
  required (the ocean FFT runs on compute shaders); without it the page shows a message.
- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191). URL options and in-page keys: `docs/tools.md`.
- The tools are in `tools/`, their manual in `docs/tools.md` (Which tool for which question). The
  ones most changes meet:
  - `node tools/serve.mjs dev|preview`: a server for a worktree on a free port.
  - `tools/capture.mjs` (one screenshot), `tools/parity/capture-set.mjs` (a list of views on one
    warm page, instead of a loop of capture.mjs), `uv run tools/img.py diff|crop|sheet|stats|flicker`
    (image work on captures, instead of a Pillow/NumPy script of one's own).
  - `tools/probe.mjs`: reads values from the page as JSON, instead of a Playwright script of one's
    own. `tools/wgsl-build.mjs`: builds TSL to WGSL in node, without a GPU.
  - `tools/profile-frame.mjs`: frame time on a production build.
  - `tools/assets.mjs`: the game's assets in `public/` against `assets.lock.json` (status, pull,
    release, publish); the dev server and the build pull what is missing on their own.
  - `tools/verify-*.mjs`: regression probes. After any change to the world's generator, run
    `node tools/verify-world-chunks.mjs` before captures.
- Everything that renders the scene in a browser takes the GPU lock
  (`node tools/gpu-lock.mjs run [--shared] -- <command>`): timing runs hold it alone, paused
  captures and probes share it. Sessions leave `PONLAI_GPU_PRIORITY` unset.
- Every wait goes through `tools/job.mjs`, never a sleep loop of one's own; a job is stopped with
  `job.mjs stop <log>` before an agent hands back.
- Headed browser runs take over the user's screen: run one only for what a screen alone shows, and
  only while `node tools/display-gate.mjs status` allows it.
- A new CPU-heavy tool imports `tools/qos.mjs` first, and a one-off script runs through
  `node tools/qos.mjs <command>`.

## Map

- `docs/`: `art-direction.md`, `game-design.md`, `tools.md`, `ui.md` (the game UI's spec: read it before UI work).
- `public/` (git-ignored): the game's assets, filled from the GitHub release `assets.lock.json`
  names (`tools/assets.mjs`, `tools/vite-assets.mjs`; `docs/tools.md`, Assets).
- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__PONLAI__` and
  `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug` / `?profile`.
- `src/Quality.ts`: the quality tiers, every cost knob in one table (high the only active one);
  `src/QualityDetect.ts` takes `?quality` or high (its GPU timing is parked with the lower tiers).
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation.
- `src/camera/`: the island camera, which starts framing the land alone from its heading
  (`IslandFraming.ts`, main.ts `placeOrbit`) and which the hand pans within the land's soft
  bounds, turns, tilts and zooms (`IslandCameraControls.ts`, the ground it grabs in
  `IslandGround.ts`), and the free flight.
- `src/world/`: the world generated from the grown land (`IslandGrowth.ts`) in 16 m chunks
  (`Chunks.ts`, `IslandSimplify.ts`, `ChunkDerived.ts`), built on a pool of workers
  (`WorldStart.ts`, `WorldChunks.ts`, `chunkWorker.ts`), cached per chunk (`WorldCache.ts`), merged
  (`ChunkMerge.ts`) and drawn (`World.ts`, the world fields' textures in `WorldFields.ts`), and grown
  in place (`Growth.ts`, the shoal of a coming piece in `SeabedRise.ts`). Its kinds: the shapes and the
  top's low swells (`WorldShapes.ts`), cliffs (`Cliff.ts`), submerged stones (`Stones.ts`), sea floor
  (`Bathymetry.ts`, `SeabedTile.ts`), rim (`RimGround.ts`), the meadow (`Grass.ts`,
  its blades generated on the GPU as they draw; its crowns' heights in `SwardField.ts`; anchors `Anchors.ts`, soil from `ShoreSample.ts`; the
  sward's depth over its ground in the meadow map, `SwardField.ts`), the yunpeng that stands
  among it, single clumps far apart (where: `YunpengSites.ts`; its stalks instances of a few
  prototypes at two levels and its lights: `Yunpeng.ts`), the islander's
  walking loop (`WalkLoop.ts`, `WalkPath.ts`), the bamboo over the whole island that the
  islanders' building stock will come from (where its culms stand and the litter on its groves' floor, which the grass keeps off:
  `BambooGroves.ts`; the culms, instances of a few prototypes at two levels: `Bamboo.ts`,
  `BambooMaterials.ts`, their colours, which the probes see too, in `BambooColours.ts`), the vegetation's depth prepass (`VegetationPrepass.ts`)
  and the opaque scene's, for the ambient occlusion (`OpaquePrepass.ts`), and the ambient light's
  probes, baked per chunk (`AmbientProbes.ts`). `src/world/vegetation/` holds what every plant kind
  shares (material, coverage, leaf textures, instances, GPU cull, wind deforms, LOD, physics, the
  registry of kinds, the trees' tubes and leaf cards in `TreeMesh.ts` and their bark and leaf surfaces in
  `TreeSurfaces.ts`, the authored plants drawn as instances of a few prototypes with two levels and
  a stipple between them in `PlantInstances.ts`, what a tree's leaves pass on of the key in `LeafLight.ts`) and the islanders' trail through the meadow (`Trample.ts`, drawn as sprites
  into the displacement field the blades read, `Displacement.ts`, a frame-graph pass).
- `src/lighting/`: sun radiometry, the sun's stepped soft shadow (`SunShadow.ts`, `SolarShadow.ts`),
  the key's gain under a deck, kept per point by the clouds' transmittance along the key
  (`KeyGain.ts`: a new term that cuts the key by the clouds' shadow takes `keyGainShare`),
  the refracted sun under water, the light every submerged material shares (`Underwater.ts`: a new
  underwater material lights with it, as the terrain does), the air/water interface, sky occlusion,
  the meadow's canopy light and its crowns' shade (`MeadowCanopy.ts`), the ambient light's probes
  on the GPU (`AmbientVolume.ts`: the lattice's buffer and uniforms, its output texture, its debug
  view), relit every frame by the sky's harmonics and the key into their irradiance
  (`AmbientRelight.ts`: the output's packing; the harmonics' operations in `Harmonics.ts`), which
  every lit island material reads for its ambient diffuse (`AmbientSample.ts`: a new lit material
  takes it through its lighting model, `GroundBounceLightingModel`'s `ambient`, never the
  environment's irradiance alone; `flags=ambientVolume:0` builds them without it), the sunlight the ground bounces up (`GroundBounce.ts`: a new lit
  material adds it in its lighting model, `addGroundBounce` or `groundBounceLight`, never a bounce
  of its own), the ambient grade's per-weather, per-elevation knobs on the island's ambient light
  (`AmbientGrade.ts`: a new lit material builds on `GroundBounceLightingModel` or reads its
  uniforms), the local lights (`LocalLights.ts`: every source in view, such as the yunpeng's
  clumps by night, sorted into clusters of the main view by a compute pass ahead of the scene
  passes, which every lit model looks its fragment's list up in; the grid and the CPU sort in
  `LocalLightClusters.ts`; a new source joins `localLights.sources`, never a three light, and a
  lit model of its own adds `addLocalLights`), the low key's lift of the diffuse's cosine (`KeyLift.ts`: a lit model of its
  own takes its key's cosine from `GroundBounceLightingModel`'s `shadeDirection`), the metering
  illuminance every lit material writes beside its colour for the exposure (`MeterLight.ts`: a new
  lit material calls `writeMeter` and draws only in passes with an MRT).
- `src/materials/`: procedural textures (the gravel bake and the scans' texture arrays:
  `ProceduralTextures.ts`), the terrain (`TerrainMaterial.ts`, its ground scans hex-tiled), the sea floor's colour (`SeabedLook.ts`), wet surfaces, the meadow's habitat and soil-depth fields (`Meadow.ts`), what a closed sky's light turns into in the sward (`SwardTint.ts`, shared by the blades and the turf).
- `src/ocean/`: FFT ocean, shore waves, the share of each wave cascade a point of the sea keeps
  (`WaveDamping.ts`), the wave maps the light under the water reads (`WaveMaps.ts`),
  water shading (`Water.ts`), the sea's large-scale detail (`SeaDetail.ts`: gusts, slicks,
  windrows), the water's refraction source (`Refraction.ts`), the storm sea.
- `src/sky/`: atmosphere, environment bakes (`Sky.ts`), volumetric clouds, the thin cloud layer's
  fibres (`Streaks.ts`), the day cycle (`DayCycle.ts`), the night sky and its data (`NightSky.ts`, `StarCatalog.ts`), the weather: its sky presets, its wind's levels and heading and the auto chain (`Weather.ts`).
- `src/weather/`: wind (`Wind.ts`: the weather's one wind, which every part reads from it, and the
  one wind field all vegetation moves in), lightning, rain,
  puddles, the air's haze and sea fog as one froxel volume lit by the atmosphere and shadowed by
  the sun's maps and the clouds (`VolumetricHaze.ts`, its keys by the hour and the weather in `HazeKeys.ts`, its medium's closed form in `HazeDepth.ts`), the bamboo leaves the wind takes off the
  island (`FallingLeaves.ts`: a fixed ring of leaves born round the view and stepped on the GPU by one
  compute pass).
- `src/post/`: the frame's passes and tidewater's display chain (`Pipeline.ts`, its bloom in
  `PhysicalBloom.ts`, the colour the rods lend low light in `Purkinje.ts`), the pre-exposure every writer of the scene's colour and metering light
  multiplies by and every scene-unit reader divides out (`PreExposure.ts`), the key's screen-space shade over the vegetation's and the opaque scene's depth (`MeadowShade.ts`),
  the screen-space ambient occlusion the ambient light takes (`GTAO.ts`, on in high),
  the sun's flare (added to the bloom, `PhysicalBloom.ts`) and the screen-space light shafts, off by default (`LightShafts.ts`), FSR 1, render scale and dynamic resolution (`RenderScale.ts`,
  `DynamicResolution.ts`), the frame pacer, the submit batching, the signal that a paused frame is
  final (`Settled.ts`), the anti-aliasing mode and the scene's sample count (`Antialiasing.ts`); under the
  temporal modes the jitter (`Jitter.ts`), the motion vectors (`Motion.ts`), the temporal resolve
  (`TemporalAA.ts`), its history fetch (FSR 3.1's Lanczos 2 and deringing: `TemporalHistory.ts`) and the FSR 2 measures it takes for moving pixels (`TemporalLocks.ts`), the
  image of a resting scene (`TemporalRest.ts`), the scene events that restart it or cut the
  history (`SceneEvents.ts`) and the rain's streaks and the storm's spray drawn after the resolve
  (`AfterResolve.ts`).
- `src/post/graph/`: the frame graph: its declarations and compiler (`GraphCompiler.ts`, pure
  TypeScript, checked by `tools/verify-framegraph.mjs`), its runtime and warm-up (`FrameGraph.ts`,
  `Compile.ts`), the derived attachment ops (`AttachmentOps.ts`), three r186's cache-key patches and its first lit build made
  ahead (`ThreePatches.ts`) and the debug view (`DebugView.ts`, `fgview`).
- `src/post/fsr3/`: the TSL port of AMD's FSR 3.1.5 upscaler (`aa=fsr3`): the host's maths and frame
  plan (`Host.ts`), its resources (`Resources.ts`) and bindings (`Bindings.ts`), one module per
  upstream shader header, the kernels (`Passes.ts`); the page's integration, its passes on the
  frame graph, rest and diagnostics (`Fsr3Upscaler.ts`) and its mip bias (`MipBias.ts`).
- `src/characters/`: the islanders (figures assembled on the kit's rig, their looks and proportions;
  the kit look's cel light and ears, the Hanming look's feather and woven surfaces in
  `FigureSurfaces.ts`; their bodies by sex and age as growth curves in `Ages.ts`, which a figure
  takes on its rig and shape keys in `FigureAge.ts`).
- `src/life/`: the island's creatures (`docs/art-direction.md`, Life), simulated per frame on the
  rendering side: the wenyao's schools of flying fish (`Wenyao.ts`), the fish's mesh and material
  (`FishGeometry.ts`, `FishMaterial.ts`).
- `src/game/`: the game behind `?game` (`Game.ts`, which also drives the island's growth by the
  population through `world/Growth.ts`): `sim/` is the headless simulation (no three.js or DOM;
  node runs it by stripping types; the other islanders as places, hearing, giving and following,
  in `sim/people.ts`; only exact operations in the rules, the few functions they need in
  `sim/maths.ts`), `save.ts` is the save (one slot: the simulation's state and the
  record, versioned: a save of another version is set aside and a new game started; the world's
  start reads its piece count),
  `view/`
  draws the islanders and the chest, `Chronicle.ts` keeps the record of what happened and
  `Placement.ts` places a building chosen in the build bar. `ui/` is the player's interface
  (`GameUi.ts`, spec `docs/ui.md`): its parts (`TopRow.ts`, `Forecast.ts`, `ResourceRow.ts`,
  `People.ts`, `SpeakBar.ts`, `BuildBar.ts`, `Record.ts`), the lists it shows as data with
  placeholder rows (`data/`: buildings, resources, weather kinds, the record's kinds, the words for
  the simulation's states), its words in i18next catalogues (`i18n/`: `zh-CN.json` the source,
  `en.json` an unmaintained snapshot; no player-facing string is written in code,
  `tools/verify-i18n.mjs`), the brush icons (`Icons.ts`), strokes (`Brush.ts`) and the ink of the
  long ones (`Ink.ts`, drawn by `InkPath.ts`, `tools/verify-ink.mjs`), what it lays into the
  scene in the camera's perspective (`Space.ts`: the words over the islanders and in flight),
  palette (`Palette.ts`), styles (`ui.css`) and the licences of its fonts (`fonts/`; our own brush
  fonts are assets, `public/fonts/`).
- `src/debug/`: runtime A/B flags (`DebugFlags.ts`), the test mode's switch (`TestMode.ts`), the frame profiler, the frame-rate readout,
  the pipeline counter (`PipelineCounter.ts`), the wind view and its probe (`WindView.ts`,
  `WindArrows.ts`, `WindProbe.ts`), the lighting layer's light-only and ambient-only views
  (`LightLayer.ts`), the scene's linear radiance over screen boxes (`Radiance.ts`) and what each
  cell of a grid shows (`RadianceAov.ts`, the kinds' codes in `Classes.ts`), and the named numbers
  a script or the console can set on a running page (`Tune.ts`).
- `tools/`: captures, profiling, the GPU lock and the probes (`docs/tools.md`); the WGSL build
  (`wgsl-build.mjs`, its entries in `wgsl-build/`); the world's chunk checks
  (`verify-world-chunks.mjs`) and statistics (`verify-world-stats.mjs`), on the node helpers in
  `world-node.mjs`.

## Rules for every change

- Shaders are written in TSL only (no raw WGSL or GLSL strings). Helpers called from several
  places are `Fn( ... ).setLayout( ... )`, so they compile to one shader function each.
- Simulation and generation are deterministic and path-independent: the world, its growth, the
  weather, the wind and every integrated state (wind travel, fog time) are functions of the land,
  the seeds, the scene clock and the weather, never of the path taken to get there or of the
  thread count. A grown page holds the world a fresh load of its land holds, and a scene jump
  (`establishScene` in `main.ts`) the scene a fresh load of the same query holds.
- Rendering may keep history-dependent effects (a temporal resolve, exposure adaptation, lighting
  or fog accumulated over frames, vegetation that responds to what passes through it, a per-frame
  physics simulation) when each one meets three conditions: a scene jump clears its history, as it
  clears all state a scene leaves behind (a cache, a history, a size that only grows, a window that
  follows the camera: `tools/verify-scene-jump.mjs`); on a still scene it converges to the same
  image whatever came before, or it can be frozen or turned off in the test mode; and outside the
  test mode its frames are compared within a tolerance (`tools/parity/README.md`, Temporal
  tolerance). Its per-frame update reads the scene clock's step, never the wall clock, so a stepped
  clip repeats.
- The test mode is a paused page, which runs MSAA whatever the tier runs (`Antialiasing.ts`),
  with every history-dependent effect frozen or off, shot once the page's `settled` signal holds (`src/post/Settled.ts`). There a paused frame is
  exactly repeatable and equals a fresh load's, and refactors are checked byte for byte (the parity
  MSAA sets, `tools/verify-scene-jump.mjs`, `tools/verify-growth-swap.mjs`). Under the temporal
  modes a paused page shows its rest image, its own jitter sequence averaged once converged
  (`TemporalRest.ts`), compared within the tolerance. A new history-dependent effect keeps
  `settled` false until it has converged, and the test mode's one shared switch, which the
  capture, parity and verify tools set by default, freezes or turns it off (`docs/tools.md`, Test
  mode).
- Everything generated for the island is generic, because the island grows one piece at a time
  (`docs/game-design.md`, "How the island grows"): it derives from the land's footprint, the
  island's SDF and noise fields with fixed seeds (hashes of position, or random streams seeded per
  world-anchored cell, never one running stream across many items), never from coordinates placed
  by hand, and counts follow the measured coast length or area. So does everything fitted to the
  land on the page (the views, the camera's limits, the shore and rain fields, the reflection's
  box, the walking loop, the game's grid). Generation stays deterministic
  whatever the thread count.
- The world is built in chunks (`Chunks.ts`): a chunk's content is a function of its window of the
  land field (the chunk grown by 32 m); a new piece rebuilds the chunks whose window meets it
  grown by 2 m (`dirtyChunks`). For most kinds the reach stays below 34 m; the stones, trails and
  shore read farther in principle, and D4 / D5 (`tools/verify-world-chunks.mjs`) measure that
  nothing outside the dirty set changes. A chunk built alone, in a block or on any thread equals
  itself. Data on a chunk border must be bit-identical in both chunks: lattices are world-anchored,
  scars are cut in canonical order, curvature comes from the apron, and a chunk's own triangles
  never go through `computeVertexNormals`. The page draws the island a mesh per land chunk and
  every other kind as one mesh or pool (the bamboo an instance pool), concatenated in the chunks'
  order ( cj, ci ) whatever order the workers finished in (`ChunkMerge.ts`, `World.ts`).
- The island grows in place (`Growth.ts`): a Grow swaps in only the changed chunks in one frame, and
  every dependent of the land's shape follows it, the same function of the version as at load (a
  grown page draws a page loaded on that land bit for bit in the test mode:
  `tools/verify-growth-swap.mjs`).
  Anything new that depends on the land's shape joins the swap (`GrowthPage`, a vegetation kind's
  `growth` in `vegetation/Registry.ts`, and main.ts's `onSwap`), and work it needs on the main thread goes into the preparation's idle-time steps, never
  into the swap's frame. A step takes a few tenths of a millisecond (a generator yielding inside its
  loops: `Steps.ts`, uploads through `Upload.ts`), so the growth's share of any frame stays under
  2 ms (`growth.work`).
- A swap never builds a pipeline; one that needs one is a bug. New chunk meshes share their kind's
  material and layout, so they draw with the loaded chunks' pipelines; merged kinds take new
  geometry of the same layout, uploaded ahead; instanced kinds hold a capacity whose shader does not
  change (three puts up to 1024 instance matrices in a uniform array of exactly the capacity:
  `vegetation/Instances.ts`); the meadow's pool takes new buffers on its storage nodes, its kernels
  reading their bounds from uniforms (`vegetation/VegetationCull.ts`); the world fields swap textures through the
  one base node each material samples them by (`WorldFields.ts`), and other passes keep their
  materials across rebakes (`RainCollision.ts`).
- Changes need to hold in the kept weathers only (clear, fair, cloudy, overcast), and on high only
  (4K output: 1920x1080 CSS pixels at DPR 2). The parked weathers (rain, storm, fog:
  `PARKED_WEATHER` in `src/sky/Weather.ts`) and quality tiers (medium, low: `PARKED_QUALITY` in
  `src/Quality.ts`) are revived later as their own milestones: new work need not support them, but
  must keep them compiling and loadable by name (`?weather=`, `?quality=`). The default checks
  leave them out (`docs/tools.md`, Parked weathers, Parked quality tiers). Changes are judged at
  high's standard: 4K output at 60 fps with MSAA 4x, about 14 ms of GPU time a frame in the normal
  scenes at the baseline; the dynamic resolution keeps 1440p's pixel count as its baseline on any
  display (upscaled by FSR 1 on a 4K one, native on a 2K one), climbs to the display's own ratio
  with headroom and drops to about 1080p's pixel count when busy, and a paused page renders at the
  baseline (`src/Quality.ts`, profile-frame's default pin: `docs/tools.md`, Measuring frame time).
- Quality tiers change the cost, never the mood: no knob alters the weather, clock or lighting
  state. High at 4K output is the reference image, the only active tier and the one every
  trade-off is judged on; every default in the modules is high's. A load knob is read
  once when materials and the frame graph are built, so a change of tier reloads the page.
- Third-party code: files adapted from another project open with a `/*! ... */` notice (project,
  copyright line, licence) and the licence text sits next to them (see
  `src/ocean/tidewater.LICENSE.txt`). Public-domain code (CC0, Unlicense) needs no notice; credit
  it in a comment. Techniques borrowed without code are credited in a comment where they are used.
- `CREDITS.md` lists every third-party source (adapted code, assets with source, author, licence
  and processing, techniques); update it with any of these. npm dependencies are not listed (the
  build collects their licences into `dist/licenses/`); any other licence text that must ship goes
  in `LICENCE_FILES` in `vite.config.ts`. Do not commit reference images, and do not ship
  third-party art without a licence.
- No asset goes into git: every binary file the page loads (textures, models, fonts, audio, baked
  data) lives in the git-ignored `public/`, is loaded through `import.meta.env.BASE_URL`, and ships
  in a GitHub release (`assets-v<N>`) that `assets.lock.json` pins. A change to the assets cuts the
  next release (a published one never changes), and the new lock goes in the commit whose code
  needs it. Nothing binary or over 1 MiB is committed anywhere (`tools/verify-no-binaries.mjs`;
  `docs/tools.md`, Assets).
- Keep machine details out of the repository (hardware, user names, local paths); describe
  measurements in relative terms.
- Comments and docs state what was measured and found, not where the notes are: never cite the
  git-ignored `artifacts/` notes, plans or reports, or internal task and milestone names. Naming a
  folder a tool writes its output to is fine.
- Code style follows three.js (mrdoob): tabs, spaces inside parentheses and brackets, comments in
  English that explain why.
- Game UI (anything the player sees in `?game`: HUD, menus, overlays, in-world labels, mockups of
  them): design and build it with the `threejs-game-ui-designer` skill when the agent has it (the
  threejs-* skill pack), so it reads as a game's interface rather than a product's.
- Visual changes: compare captures against the previous capture (and crops, not only the whole
  frame); report measured differences. Where shapes differ (growth steps, seeds), judge the look by
  eye and region statistics (`tools/capture-growth.mjs`), not by pixel difference.
- Performance changes: `tools/profile-frame.mjs` on a production build under the GPU lock, before
  and after (`--compare`, or `--toggle` on a debug flag); judge an A/B by GPU time per pass, frame
  rates from runs without timestamps, 60 fps with `--accept`. Report contended runs as such.
  Details: `docs/tools.md`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
  `type(scope): summary`, the summary in lower case, imperative, without a full stop, the header at
  most 100 characters, and the body explaining why. Types: `feat`, `fix`, `perf`, `refactor`,
  `style`, `test`, `docs`, `build`, `ci`, `chore`, `revert`. The optional scope names the section
  of the codebase changed (for example `ocean`, `world`, `ai`). Mark breaking changes with `!`
  after the scope or a `BREAKING CHANGE:` footer.

## Tools

- Before writing a script, look for the tool that answers the question (`docs/tools.md`, Which
  tool for which question); if one almost fits, add an option to it.
- A script needed a second time, or by another task, becomes a tool (`docs/tools.md`, Writing a
  tool). A truly one-off script stays in the task's artifacts folder.
- Never start a GPU tool to see its options: it queues for the lock and renders. Read its header.

## WebGPU / TSL pitfalls

- Once `material.positionNode` is set, `positionLocal` reads the displaced position; use
  `positionGeometry` for the undisplaced one.
- In a full-screen pass (`QuadMesh`, `RenderPipeline`) the camera nodes are the pass's own camera:
  pass the scene camera's matrices as uniforms.
- Screen uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
- Multisampled depth is read with `textureLoad`, one sample at a time (the sample index in its level
  argument); single-sampled, that argument is a mip level. More in `Pipeline.ts`.
- WebGPU multisamples with 1 or 4 samples only (three turns 2 into 1, with no MSAA). The
  anti-aliasing mode (`msaa`, the temporal `taa` and `taau`, `off`) is a load knob of the tier
  (`aa` in `Quality.ts`, whose header says which tier runs which and why: high, the only active
  tier, runs `msaa`, as a paused page does); `aa=` or the GUI picks any mode on any tier. Code that differs by mode reads `Antialiasing.ts`'s exports (`TEMPORAL`,
  `SCENE_SAMPLES`, `ALPHA_TO_COVERAGE`), never the tier. The vegetation's cut-outs are alpha to
  coverage under MSAA only: find vegetation by `userData.vegetation`, never by `alphaToCoverage`
  (`vegetation/Coverage.ts`).
- Implicitly filtered texture samples and derivatives need uniform control flow: take them
  (`.toVar()`) before any `If` / `Loop`; inside branches and loops use `.level()` or `textureLoad`.
  Keep filters that take `dFdx` / `dFdy` out of `select()` / `If` branches (`SolarShadow.ts`).
- Nested loops: pass both ranges to one `Loop()` call so the counters get distinct names.
- Three TSL methods take their receiver out of order (r186): `t.mix( a, b )` is mix( a, b, t ),
  `x.step( edge )` is step( edge, x ), `x.smoothstep( low, high )` is smoothstep( low, high, x ).
  Write the function form (`src/post/fsr3/Upsample.ts`).
- TSL may compile a `select()` of large operands into branches: a node first built inside one is
  declared in that branch only, and the shader silently draws nothing. Select between values
  built before it (`.toVar()`), or blend with 0/1 weights (`Water.ts`).
- An inline `Fn( ... )()` (no layout) is set up again in every stage that asks its type: one a
  varying's value reaches runs its statements in the fragment stage too, and what it reads there
  becomes more varyings (the meadow went past WebGPU's sixteen under the temporal modes). A branch
  whose result reaches a varying is a `Fn( ... ).setLayout( ... )` taking its uniforms as arguments
  (`Grass.ts` `flowerHead`).
- A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so it is declared
  multisampled and cannot be sampled with a comparison; give it a render target. three picks one
  sampler type per depth texture per material (`SolarShadow.ts`).
- Shadow passes keep `alphaTest` and `alphaMap` but not `map`; vegetation draws before the terrain
  (`renderOrder = -1`). See `vegetation/LeafTexture.ts` and `vegetation/Material.ts`.
- The water samples neither the target it draws into nor many more textures (14 of WebGPU's 16
  in its fragment stage: `Water.ts`), so it takes no history or reactive input: what the resolve
  needs from it goes out through its velocity. It refracts the refraction pass's image of what lies
  under the sea: a new mesh that can reach under the water joins it (`Refraction.ts`
  `showUnderwater`), or the water shows what lies straight behind it in the opaque copy there; what
  swims in the upper water (a fish) is marked instead (`markSwimmer`), and its material adds
  `Water.ts` `swimmerSway` to its position. It reflects only what lies inside `Water.reflectionBounds`: anything opaque placed off the island or
  above 3 m must grow that box through `Water.hold` (the game's props do: main.ts `holdOpaque`).
- New frame work is a pass on the frame graph, its targets declared with a size class and every
  texture it binds declared as a read (the attachment ops discard what nothing declares), never an
  rtt() inside another pass's material or a call around the graph (`Pipeline.ts`).
- A compute kernel dispatched by a target's size is rebuilt with new pipelines whenever the size
  changes (at every step of high's dynamic scale): size it from something fixed or keep it a render
  pass. A kernel with `workgroupBarrier()` is dispatched by size, not by a thread count
  (`OceanFFT.ts`). A `Fn( ... ).setLayout( ... )` helper that reads uniforms can be emitted with
  another kernel's uniform names when two compute kernels that use it are built (r186).
- The same triangles drawn in one draw or split over several (a mesh per chunk, or draw ranges)
  shade about 1 % of their pixels a level or two apart: multisampled fragments and derivative
  quads form within a draw. Byte comparisons hold between equal splits only (`World.ts`).
- A storage buffer cannot grow in place (a larger array fails its `writeBuffer`). A new
  `StorageBufferAttribute` as each reading storage node's `value` takes new bind groups and no
  pipeline, compute or render: the shaders declare runtime-sized arrays (r186,
  `tools/verify-storage-realloc.mjs`).
- A 16-bit index is copied into a new 32-bit array when its GPU buffer is created, and the copy is
  uploaded from then on (r186): an index rewritten in place must be a `Uint32Array`. Leave
  attributes that change once per event at static usage with update ranges: `DynamicDrawUsage`
  re-uploads the whole buffer on every draw.
- Programs that must produce bit-identical depth need `@invariant` on the clip position, which
  three r186 does not emit (`VegetationPrepass.ts`). A material that instances from storage
  buffers holds the placed position in a `toVar` (`vegetation/VegetationCull.ts`).
- `renderer.compileAsync` alone does not compile what a render draws (target, MRT, side, call
  depth, a render context shared by targets of the same attachments): compile ahead through the
  frame graph's warm-up, a draw that shows only at times registered as a latent of its pass
  (`FrameGraph.ts`, `graph/Compile.ts`; a shadow map's draws with `compileLatentInto`). The
  warm-up's priming renders only what keeps no state and never leaves a persistent resource
  written (`fgPrime=0` turns it off). The order materials first build in is part of the image:
  r186 emits a shader from node state the builds share, so compiling draws ahead in another order
  than the frame builds them changed other materials' code and moved a few pixels by one level.
  The first lit build also makes nodes every receiver shares (the shadow's graph, the camera's world
  matrix) and emits other code than the later ones: a throwaway receiver builds them before the
  loop (`ThreePatches.ts` `primeSharedNodes`), so a receiver's code (and a kind's pipeline count)
  does not depend on which draws first. A
  render three makes of its own that cannot be compiled before its first frame (the sun's map,
  built with the first receiver) compiles by rendering it once with asynchronous pipelines
  (`compileByRendering`, `SunShadow.ts`).
- A draw whose pipeline an asynchronous compile is still creating is skipped without a word (r186,
  `Pipelines.isReady`), so a one-time render such as a bake waits for the warm-up that compiles it
  (`Sky.ts` `warm`).
- A fragmentNode that writes several attachments must be the `outputStruct( ... )` itself: one
  returned from inside an `Fn` is emitted with a single output (`struct member m0 not found`).
  Build the members in one `Fn` and return them as a matrix's columns (`TemporalAA.ts`
  `neighbourhood`).
- Under the temporal modes every scene material writes the velocity beside the colour: one with
  a fragmentNode writes both outputs, one whose positionNode animates supplies `positionPrevious`
  and sets `userData.previousPosition` (`Motion.ts`). The blend of each attachment comes only from
  the pass's own MRT (`Motion.ts` `sceneMRT`, `overlayMRT`), whatever a material's MRT node says;
  a material drawn into two attachment layouts builds once per layout through
  `graph/ThreePatches.ts`'s cache keys. A new site that changes the scene in a way its frames do not show (a seek, a jump,
  a new scene, a control that retunes a paused frame) raises a scene event (`SceneEvents.ts`).
- `SubmitBatch.ts` wraps the device, queue and encoders and holds command buffers: raw WebGPU work
  and new queue operations must go through its rules, and one invalid command buffer loses its
  whole batch. `graph/AttachmentOps.ts` wraps the encoders too: a wrapper that hands out encoders
  of its own must be installed before it.
- Under the temporal modes the scene passes (the graph's jittered span) see the camera's projection
  jittered by a fraction of a render pixel. Work keyed, culled or placed by the camera takes the
  unjittered projection (`jitter.uniforms.unjitteredProjection`): the sky dome, the grass cull, the
  haze's froxel grid and the light shafts' sun do (`Jitter.ts`).
- What a frame reads from the frame before (a history, the previous depth, an object's previous
  matrix, a clock's step) advances once per rendered frame, not per draw or per tick. A texture's
  history is declared on the graph: a ping-pong resource read through `previous()`, or a frame-end
  `copyToPersistent` (single-sampled, same size class and format), never a `copyTextureToTexture`
  of its own around the graph (`GraphCompiler.ts`).
- Timestamp queries (`trackTimestamp`) have one owner at a time (`DynamicResolution.ts`).
- `Sky.ts` drives three's private `PMREMGenerator` steps, `SunShadow.compileCasters` mirrors
  three's shadow-pass material, `debug/AmbientProbe.ts` frees its storage buffers through the
  renderer's private attribute map, and `graph/ThreePatches.ts`, `graph/AttachmentOps.ts` and
  `graph/Compile.ts` patch or stand in for r186 internals: re-check them on a three upgrade.
