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
- `node tools/capture.mjs <name> [--q "paused&t=12&dpr=1"]` screenshots the dev server into
  `artifacts/captures/` (git-ignored).
- `node tools/profile-frame.mjs` profiles a production build (scene matrix, A/B deltas, per-pass
  GPU time, the 60 fps acceptance); its options and modes are in `docs/tools.md`.
- Everything that renders the scene in a browser takes the GPU lock:
  `node tools/gpu-lock.mjs run [--shared] -- <command>` (`status`, `gpu`). Timing runs hold it
  alone; paused captures and verify probes share it.
- Headed browser runs take over the user's screen: they run only while
  `node tools/display-gate.mjs status` allows them; otherwise run headless and record the headed
  run as pending.
- `tools/verify-*.mjs` are regression probes (GPU ones take the lock; `verify-day-cycle`,
  `verify-weather-state`, `verify-wind`, `verify-game` are plain `node`): see `docs/tools.md`.

## Map

- `docs/`: `art-direction.md`, `game-design.md`, `tools.md`.
- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__PONLAI__` and
  `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug` / `?profile`.
- `src/Quality.ts`: the quality tiers, every cost knob in one table; `src/QualityDetect.ts` picks
  the tier for the GPU at startup.
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation.
- `src/camera/`: the island camera (`IslandCameraControls.ts`, the ground it grabs in
  `IslandGround.ts`) and the free flight.
- `src/world/`: the island generated in Web Workers (`worldWorker.ts`, cached by `WorldCache.ts`):
  SDF shapes and surface nets (`WorldShapes.ts`), the cliffs (`Cliff.ts`), the sea floor
  (`Bathymetry.ts`), the rim (`RimGround.ts`, `RimTrails.ts`, `RimFoliage.ts`, `RimSkirt.ts`), the
  meadow (`Grass.ts`, culled by `GrassCull.ts`), flowers, bushes (`Foliage.ts`: what all vegetation
  materials share), shrubs and trees (`PlantSites.ts`, `Plants.ts`), the vegetation's depth
  prepass (`VegetationPrepass.ts`).
- `src/lighting/`: sun radiometry, the sun's stepped soft shadow (`SunShadow.ts`, `SolarShadow.ts`),
  the refracted sun under water, the air/water interface, sky occlusion, the meadow's canopy light.
- `src/materials/`: procedural textures, the terrain (`TerrainMaterial.ts`), wet surfaces.
- `src/ocean/`: FFT ocean, shore waves, caustics, water shading (`Water.ts`), the storm sea.
- `src/sky/`: atmosphere, environment bakes (`Sky.ts`), volumetric clouds, cirrus, the day cycle
  (`DayCycle.ts`), the night sky and its data (`NightSky.ts`, `StarCatalog.ts`), weather presets.
- `src/weather/`: wind (`Wind.ts`: the one wind field all vegetation moves in), lightning, rain,
  puddles, distant air and sea fog (`AerialPerspective.ts`).
- `src/post/`: the frame graph, tone curve and look (`Pipeline.ts`), FSR 1, render scale and
  dynamic resolution, the frame pacer, the submit batching, the sample count, pipeline warm-up.
- `src/characters/`: the islanders (modular low-poly figures, their light, ears, proportions).
- `src/game/`: the game behind `?game` (`Game.ts`): `sim/` is the headless simulation (no three.js
  or DOM; node runs it by stripping types), `view/` draws the islanders, the palm and the
  chest, and `Hud.ts` / `Placement.ts` are the player's prototype HUD.
- `src/debug/`: runtime A/B flags (`DebugFlags.ts`), the frame profiler, the frame-rate readout.

## Rules for every change

- Shaders are written in TSL only (no raw WGSL or GLSL strings). Helpers called from several
  places are `Fn( ... ).setLayout( ... )`, so they compile to one shader function each.
- Paused frames are exactly repeatable: everything animated is a function of the scene clock, the
  weather and integrated state (wind travel, fog time), never of the path taken to get there.
  Captures and probes depend on it.
- Everything generated for the island is generic, because the island must grow by more tiles: it
  derives from the footprint, the island's SDF and noise fields with fixed seeds (hashes of
  position, or random streams that draw a fixed count per anchor), never from coordinates placed
  by hand, and counts follow the measured coast length or area. Generation stays deterministic
  whatever the thread count.
- Quality tiers change the cost, never the mood: no knob alters the weather, clock or lighting
  state. High is the reference image; every default in the modules is high's. A load knob is read
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
- Code style follows three.js (mrdoob): tabs, spaces inside parentheses and brackets, comments in
  English that explain why.
- Game UI (anything the player sees in `?game`: HUD, menus, overlays, in-world labels, mockups of
  them): design and build it with the `threejs-game-ui-designer` skill when the agent has it (the
  threejs-* skill pack), so it reads as a game's interface rather than a product's.
- Visual changes: compare captures against the previous capture (and crops, not only the whole
  frame); report measured differences.
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

## WebGPU / TSL pitfalls

- Once `material.positionNode` is set, `positionLocal` reads the displaced position; use
  `positionGeometry` for the undisplaced one.
- In a full-screen pass (`QuadMesh`, `RenderPipeline`) the camera nodes are the pass's own camera:
  pass the scene camera's matrices as uniforms.
- Screen uv ( 0, 0 ) is the top-left corner, NDC y points up, depth runs 0..1.
- Multisampled depth is read with `textureLoad`, one sample at a time (the sample index in its level
  argument); single-sampled, that argument is a mip level. More in `Pipeline.ts`.
- WebGPU multisamples with 1 or 4 samples only (three turns 2 into 1, with no MSAA). The scene is
  4x on every tier. Find vegetation by `userData.vegetation`, never by `alphaToCoverage`
  (`Foliage.ts`).
- Implicitly filtered texture samples and derivatives need uniform control flow: take them
  (`.toVar()`) before any `If` / `Loop`; inside branches and loops use `.level()` or `textureLoad`.
  Keep filters that take `dFdx` / `dFdy` out of `select()` / `If` branches (`SolarShadow.ts`).
- Nested loops: pass both ranges to one `Loop()` call so the counters get distinct names.
- A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so it is declared
  multisampled and cannot be sampled with a comparison; give it a render target.
- three picks one sampler type per depth texture per material: a material that gathers a shadow
  map reads it only by gather (`SolarShadow.ts`).
- Shadow passes keep `alphaTest` and `alphaMap` but not `map`; vegetation draws before the terrain
  (`renderOrder = -1`). See `Foliage.ts`.
- The water samples neither the target it draws into nor more textures: it already binds 16
  sampled textures and 14 of 16 varyings (`Water.ts`). It reflects only what lies inside
  `Water.reflectionBounds`: anything opaque off the island or above the trees must grow that box.
- New passes: `Pipeline.passes` are resized to the render by `sizeRtt` (keep reduced or
  fixed-size passes out); a pass after the rain that reads `sceneRT`'s samples must move its
  discard (`Pipeline.ts`).
- A compute kernel dispatched by a target's size is rebuilt with new pipelines whenever the size
  changes (at every step of high's dynamic scale): size it from something fixed or keep it a render
  pass. A kernel with `workgroupBarrier()` is dispatched by size, not by a thread count
  (`OceanFFT.ts`). A `Fn( ... ).setLayout( ... )` helper that reads uniforms can be emitted with
  another kernel's uniform names when two compute kernels that use it are built (r186).
- A 16-bit index is copied into a new 32-bit array when its GPU buffer is created, and the copy is
  uploaded from then on (r186): an index rewritten in place must be a `Uint32Array`. Leave
  attributes that change once per event at static usage with update ranges: `DynamicDrawUsage`
  re-uploads the whole buffer on every draw.
- Programs that must produce bit-identical depth need `@invariant` on the clip position, which
  three r186 does not emit (`VegetationPrepass.ts`). A material that instances from storage
  buffers holds the placed position in a `toVar` (`GrassCull.ts`).
- `renderer.compileAsync` reads the render target before its first await, builds a
  double-sided transparent material as one unused pipeline, and builds later with a render context
  shared by every target of the same attachments whatever its depth format (`Warm.ts`).
- `SubmitBatch.ts` wraps the device, queue and encoders and holds command buffers: raw WebGPU work
  and new queue operations must go through its rules, and one invalid command buffer loses its
  whole batch.
- Timestamp queries (`trackTimestamp`) have one owner at a time (`DynamicResolution.ts`).
- `Sky.ts` drives three's private `PMREMGenerator` steps, and `SunShadow.compileCasters` mirrors
  three's shadow-pass material: re-check them on a three upgrade.
