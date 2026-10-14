# Ponlai

A small stylised island in an open sea, rendered in the browser: a visual sample for a game, and
the game growing behind `?game`. The look is stylised fantasy-realistic: a physically based scene
graded toward a painted game's colour (warm golden light, rich greens, deep teal water, chunky
stone, a lush meadow). The look and what to avoid: `docs/art-direction.md`. The game's design:
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
- `node tools/serve.mjs dev|preview` starts one for a worktree on a free port (`--sha` for another
  commit; `docs/tools.md`).
- `node tools/capture.mjs <name> [--q "paused&t=12&dpr=1"]` screenshots the dev server into
  `artifacts/captures/` (git-ignored).
- A list of views, ad-hoc ones included (`--view "name:query"`, `--views-file`, `--sweep
  "key=a,b"`), is captured with `node tools/parity/capture-set.mjs <url> <outDir>`: one warm page per
  set, the scene jump between views. Use it instead of a script that loops capture.mjs.
- `uv run tools/img.py diff|crop|sheet|stats` does the image work on captures (differences, crops,
  A/B sheets, region statistics), with its dependencies inline. Use it instead of an inline
  Pillow/NumPy script (`docs/tools.md`, Captures).
- `node tools/probe.mjs [url] --q "<query>" --eval "<js>"` reads values from the page (diagnostics,
  timings, uniforms, pipeline counts after an action) as JSON, under the GPU lock and in a warm
  profile: use it instead of a Playwright script of one's own (`docs/tools.md`, Probes).
- `node tools/profile-frame.mjs` profiles a production build (scene matrix, A/B deltas, per-pass
  GPU time, the 60 fps acceptance); its options and modes are in `docs/tools.md`.
- Everything that renders the scene in a browser takes the GPU lock:
  `node tools/gpu-lock.mjs run [--shared] -- <command>` (`status`, `gpu`): timing runs hold it
  alone, paused captures and probes share it. Sessions leave `PONLAI_GPU_PRIORITY` unset; the user
  or a main session schedules with `gpu-lock.mjs prio set` (`docs/tools.md`, GPU lock).
- Processes an agent starts run at a starved QoS on a busy Mac: the tools raise themselves to the
  application policy (`tools/qos.mjs`); a new CPU-heavy tool imports it first, and a one-off script
  runs through `node tools/qos.mjs <command>` (`docs/tools.md`, Process priority).
- Every wait goes through `tools/job.mjs`, never a sleep loop of one's own: a command that may run
  for minutes runs as `node tools/job.mjs start --wait -- <command>`, is waited on with
  `node tools/job.mjs wait <log>` (at most 4 minutes per call), and is stopped with
  `job.mjs stop <log>` before an agent hands back (`docs/tools.md`, Long jobs and waiting).
- Clip frames, capture sets and references older than 2 days are removed on their own
  (`tools/storage.mjs`, started by `job.mjs`); images a report or page links to stay, and a folder
  with a `.keep` file is kept (`docs/tools.md`, Disk space).
- Headed browser runs take over the user's screen: run one only for what a screen alone shows, and
  only while `node tools/display-gate.mjs status` allows it (`docs/tools.md`, Display gate).
- `tools/verify-*.mjs` are regression probes (GPU ones take the lock; `verify-day-cycle`,
  `verify-weather-state`, `verify-wind`, `verify-game`, `verify-framegraph`, `verify-growth-shape`,
  `verify-world-chunks`, `verify-world-stats` are plain `node`): see `docs/tools.md`.
- After any change to the world's generator, run `node tools/verify-world-chunks.mjs` before
  captures.
- `node tools/capture-growth.mjs --base url [--cand url]` captures two pages side by side over
  seeds, growth steps and six views, with region statistics (`docs/tools.md`).
- `node tools/verify-growth-swap.mjs <url> [--steps N]` grows a page N times and compares it with a
  fresh load of that land: views byte for byte, chunk hashes, the rain map, the camera's ground,
  pipelines and memory across swaps (`docs/tools.md`).
- `tools/parity/` captures sets of paused views and motion clips and measures them against
  references stored per commit: MSAA byte for byte, the temporal modes within a tolerance, both
  against a ground truth (`aa=gt`); `tools/verify-first-use.mjs` counts the pipelines still created
  after the warm-up. Captures of a paused temporal page wait for its rest to converge. Manuals:
  `tools/parity/README.md`, `docs/tools.md`.

## Map

- `docs/`: `art-direction.md`, `game-design.md`, `tools.md`.
- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__PONLAI__` and
  `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug` / `?profile`.
- `src/Quality.ts`: the quality tiers, every cost knob in one table (high the only active one);
  `src/QualityDetect.ts` takes `?quality` or high (its GPU timing is parked with the lower tiers).
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation.
- `src/camera/`: the island camera (`IslandCameraControls.ts`, the ground it grabs in
  `IslandGround.ts`) and the free flight.
- `src/world/`: the world generated from the grown land (`IslandGrowth.ts`: the land lattice grown
  one piece at a time) in 16 m chunks, each from its window of the land field (`Chunks.ts`; the
  island's mesh simplified per chunk, its border locked: `IslandSimplify.ts`; what the
  page derives from its meshes, so it never walks their vertices: `ChunkDerived.ts`), on a pool of
  `chunkWorker.ts` workers run by `WorldChunks.ts` (started by `WorldStart.ts` as the page loads),
  one IndexedDB record per chunk (`WorldCache.ts`, keyed by the generator's hash, options, browser,
  chunk and the pieces in its window), merged by `ChunkMerge.ts` and drawn by `World.ts` (the
  island a mesh per land chunk; the world fields' textures in `WorldFields.ts`); the island grown in
  place by `Growth.ts` (the next version generated and prepared ahead, then swapped in one frame,
  every dependent following: the GUI's Island folder, `__PONLAI__.growth`; the only sign of a
  coming piece is the shoal, `SeabedRise.ts`: the floor tiles under it rise toward their grown form
  as the approach grows, while the stones, the contact shade and every other kind change at the
  swap); the footprint, SDF
  shapes and surface nets (`WorldShapes.ts`), the
  cliffs (`Cliff.ts`), the submerged stones (`Stones.ts`), the sea floor (`Bathymetry.ts`, drawn as
  tiles by `SeabedTile.ts`), the rim (`RimGround.ts`, `RimTrails.ts`, `RimFoliage.ts`,
  `RimSkirt.ts`), the meadow's anchors (`Anchors.ts`), the meadow (`Grass.ts`, one pool culled on the GPU
  by `vegetation/VegetationCull.ts`), flowers, the rim bushes (`FoliageSites.ts`, `Foliage.ts`), the plateau's shrubs and small trees (sited on the page off the walking loop by
  `PlantSites.ts`, grown each from its seed and merged into one mesh by `Plants.ts`), the islander's walking loop (`WalkLoop.ts`, its curve `WalkPath.ts`), the
  vegetation's depth prepass
  (`VegetationPrepass.ts`); what the vegetation's materials share in `src/world/vegetation/`: the
  material factory every plant kind builds with (`Material.ts`), the coverage paths
  and the vegetation tag (`Coverage.ts`), the folded leaf's textures (`LeafTexture.ts`), the
  instance pool (`Instances.ts`), the GPU cull of a storage-instanced kind, its payload declared by
  the kind (`VegetationCull.ts`, the meadow's), the wind's deforms and each kind's wind numbers
  (`Deform.ts`), and the registry of the plant kinds the page's vegetation lists and the growth
  read (`Registry.ts`; each kind's entry exported by its own module).
- `src/lighting/`: sun radiometry, the sun's stepped soft shadow (`SunShadow.ts`, `SolarShadow.ts`),
  the refracted sun under water, the air/water interface, sky occlusion, the meadow's canopy light.
- `src/materials/`: procedural textures, the terrain (`TerrainMaterial.ts`), wet surfaces.
- `src/ocean/`: FFT ocean, shore waves, caustics, water shading (`Water.ts`), the storm sea.
- `src/sky/`: atmosphere, environment bakes (`Sky.ts`), volumetric clouds, cirrus, the day cycle
  (`DayCycle.ts`), the night sky and its data (`NightSky.ts`, `StarCatalog.ts`), weather presets.
- `src/weather/`: wind (`Wind.ts`: the one wind field all vegetation moves in), lightning, rain,
  puddles, distant air and sea fog (`AerialPerspective.ts`).
- `src/post/`: the frame's passes, tone curve and look (`Pipeline.ts`), light shafts
  (`LightShafts.ts`), FSR 1, render scale and dynamic resolution (`RenderScale.ts`,
  `DynamicResolution.ts`), the frame pacer, the submit batching, the signal that a paused frame is
  final (`Settled.ts`), the anti-aliasing mode and the scene's sample count (`Antialiasing.ts`); under the
  temporal modes the jitter (`Jitter.ts`), the motion vectors (`Motion.ts`), the temporal resolve
  (`TemporalAA.ts`) and the FSR 2 measures it takes for moving pixels (`TemporalLocks.ts`), the
  image of a resting scene (`TemporalRest.ts`), the scene events that restart it or cut the
  history (`SceneEvents.ts`) and the rain's streaks and the storm's spray drawn after the resolve
  (`AfterResolve.ts`).
- `src/post/graph/`: the frame graph: its declarations and compiler (`GraphCompiler.ts`, pure
  TypeScript, checked by `tools/verify-framegraph.mjs`), its runtime and warm-up (`FrameGraph.ts`,
  `Compile.ts`), the derived attachment ops (`AttachmentOps.ts`), three r186's cache-key patches
  (`ThreePatches.ts`) and the debug view (`DebugView.ts`, `fgview`).
- `src/characters/`: the islanders (modular low-poly figures, their light, ears, proportions).
- `src/game/`: the game behind `?game` (`Game.ts`, which also drives the island's growth by the
  population through `world/Growth.ts`): `sim/` is the headless simulation (no three.js or DOM;
  node runs it by stripping types; `sim/save.ts` is the save slot the world's start reads), `view/`
  draws the islanders, the palm and the chest, and `Hud.ts` / `Placement.ts` are the player's
  prototype HUD.
- `src/debug/`: runtime A/B flags (`DebugFlags.ts`), the frame profiler, the frame-rate readout,
  the pipeline counter (`PipelineCounter.ts`), the wind view and its probe (`WindView.ts`,
  `WindArrows.ts`, `WindProbe.ts`).
- `tools/`: captures, profiling, the GPU lock and the probes (`docs/tools.md`); the world's chunk
  checks (`verify-world-chunks.mjs`) and statistics (`verify-world-stats.mjs`), on the node
  helpers in `world-node.mjs`.

## Rules for every change

- Shaders are written in TSL only (no raw WGSL or GLSL strings). Helpers called from several
  places are `Fn( ... ).setLayout( ... )`, so they compile to one shader function each.
- Paused frames are exactly repeatable: everything animated is a function of the scene clock, the
  weather and integrated state (wind travel, fog time), never of the path taken to get there.
  A scene jump (`establishScene` in `main.ts`) draws the frame a fresh load of the same query
  draws: state a scene leaves behind (a cache, a history, a size that only grows, a window that
  follows the camera) is cleared there (`tools/verify-scene-jump.mjs`). Captures and probes depend
  on it. Under the temporal modes a paused page shows its rest image, its own jitter sequence
  averaged once converged (`TemporalRest.ts`), so it does not depend on the frames before either.
  Temporal AA modes are compared within a tolerance, not byte
  for byte: the GPU splits render passes on its own, which moves a few samples, and the temporal
  rest freezes that (`tools/parity/README.md`).
- Everything generated for the island is generic, because the island grows one piece at a time
  (`docs/game-design.md`, "How the island grows"): it derives from the land's footprint, the
  island's SDF and noise fields with fixed seeds (hashes of position, or random streams seeded per
  world-anchored cell, never one running stream across many items), never from coordinates placed
  by hand, and counts follow the measured coast length or area. So does everything fitted to the
  land on the page (the views, the camera's limits, the shore and rain fields, the reflection's
  box, the sea fog's clearing, the walking loop, the game's grid). Generation stays deterministic
  whatever the thread count.
- The world is built in chunks (`Chunks.ts`): a chunk's content is a function of its window of the
  land field (the chunk grown by 32 m); a new piece rebuilds the chunks whose window meets it
  grown by 2 m (`dirtyChunks`). For most kinds the reach stays below 34 m; the stones, trails and
  shore read farther in principle, and D4 / D5 (`tools/verify-world-chunks.mjs`) measure that
  nothing outside the dirty set changes. A chunk built alone, in a block or on any thread equals
  itself. Data on a chunk border must be bit-identical in both chunks: lattices are world-anchored,
  scars are cut in canonical order, curvature comes from the apron, and a chunk's own triangles
  never go through `computeVertexNormals`. The page draws the island a mesh per land chunk and
  every other kind as one mesh or pool, concatenated in the chunks' order ( cj, ci ) whatever
  order the workers finished in (`ChunkMerge.ts`, `World.ts`).
- The island grows in place (`Growth.ts`): a Grow swaps in only the changed chunks in one frame, and
  every dependent of the land's shape follows it, the same function of the version as at load (a
  grown page draws a page loaded on that land bit for bit, paused: `tools/verify-growth-swap.mjs`).
  Anything new that depends on the land's shape joins the swap (`GrowthPage`, a vegetation kind's
  `growth` in `vegetation/Registry.ts`, and main.ts's `onSwap`), and work it needs on the main thread goes into the preparation's idle-time steps, never
  into the swap's frame. A step takes a few tenths of a millisecond (a generator yielding inside its
  loops: `Steps.ts`, uploads through `Upload.ts`), so the growth's share of any frame stays under
  2 ms (`growth.work`).
- A swap never builds a pipeline; one that needs one is a bug. New chunk meshes share their kind's
  material and layout, so they draw with the loaded chunks' pipelines; merged kinds take new
  geometry of the same layout, uploaded ahead; instanced kinds hold a capacity whose shader does not
  change (three puts up to 1024 instance matrices in a uniform array of exactly the capacity:
  `Flowers.ts`, `Foliage.ts`); the meadow's pool takes new buffers on its storage nodes, its kernels
  reading their bounds from uniforms (`vegetation/VegetationCull.ts`); the world fields swap textures through the
  one base node each material samples them by (`WorldFields.ts`), and other passes keep their
  materials across rebakes (`RainCollision.ts`).
- Changes need to hold in the kept weathers only (clear, fair, cloudy, overcast), and on high only
  (4K output: 1920x1080 CSS pixels at DPR 2). The parked weathers (rain, storm, fog:
  `PARKED_WEATHER` in `src/sky/Weather.ts`) and quality tiers (medium, low: `PARKED_QUALITY` in
  `src/Quality.ts`) are revived later as their own milestones: new work need not support them, but
  must keep them compiling and loadable by name (`?weather=`, `?quality=`). The default checks
  leave them out (`docs/tools.md`, Parked weathers, Parked quality tiers). Changes are judged at
  high's baseline: 4K output rendered at 1440p (scale 4/3) at 60 fps, about 14 ms of GPU time a
  frame in the normal scenes; the dynamic resolution climbs to native 4K with headroom and drops to
  1080p when busy, and a paused page renders at the baseline (`src/Quality.ts`, profile-frame's
  default pin: `docs/tools.md`, Measuring frame time).
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
  tier, runs `msaa`); `aa=` or the GUI picks any mode on any tier. Code that differs by mode reads `Antialiasing.ts`'s exports (`TEMPORAL`,
  `SCENE_SAMPLES`, `ALPHA_TO_COVERAGE`), never the tier. The vegetation's cut-outs are alpha to
  coverage under MSAA only: find vegetation by `userData.vegetation`, never by `alphaToCoverage`
  (`vegetation/Coverage.ts`).
- Implicitly filtered texture samples and derivatives need uniform control flow: take them
  (`.toVar()`) before any `If` / `Loop`; inside branches and loops use `.level()` or `textureLoad`.
  Keep filters that take `dFdx` / `dFdy` out of `select()` / `If` branches (`SolarShadow.ts`).
- Nested loops: pass both ranges to one `Loop()` call so the counters get distinct names.
- TSL may compile a `select()` of large operands into branches: a node first built inside one is
  declared in that branch only, and the shader silently draws nothing. Select between values
  built before it (`.toVar()`), or blend with 0/1 weights (`Water.ts`).
- A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so it is declared
  multisampled and cannot be sampled with a comparison; give it a render target. three picks one
  sampler type per depth texture per material (`SolarShadow.ts`).
- Shadow passes keep `alphaTest` and `alphaMap` but not `map`; vegetation draws before the terrain
  (`renderOrder = -1`). See `vegetation/LeafTexture.ts` and `Foliage.ts`.
- The water samples neither the target it draws into nor more textures (it is at WebGPU's 16, its
  varyings near the limit: `Water.ts`), so it takes no history or reactive input: what the resolve
  needs from it goes out through its velocity. It reflects only what lies inside
  `Water.reflectionBounds`: anything opaque placed off the island or above 3 m must grow that box
  (the plateau's small trees do: main.ts).
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
  than the frame builds them changed other materials' code and moved a few pixels by one level. A
  render three makes of its own that cannot be compiled before its first frame (the sun's map,
  built with the first receiver) compiles by rendering it once with asynchronous pipelines
  (`compileByRendering`, `SunShadow.ts`).
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
  unjittered projection (`jitter.uniforms.unjitteredProjection`): the sky dome, the grass cull and
  the light shafts' sun do (`Jitter.ts`).
- What a frame reads from the frame before (a history, the previous depth, an object's previous
  matrix, a clock's step) advances once per rendered frame, not per draw or per tick. A texture's
  history is declared on the graph: a ping-pong resource read through `previous()`, or a frame-end
  `copyToPersistent` (single-sampled, same size class and format), never a `copyTextureToTexture`
  of its own around the graph (`GraphCompiler.ts`).
- Timestamp queries (`trackTimestamp`) have one owner at a time (`DynamicResolution.ts`).
- `Sky.ts` drives three's private `PMREMGenerator` steps, `SunShadow.compileCasters` mirrors
  three's shadow-pass material, and `graph/ThreePatches.ts`, `graph/AttachmentOps.ts` and
  `graph/Compile.ts` patch or stand in for r186 internals: re-check them on a three upgrade.
