# Code map

Where each part of the code lives: a section per folder and a line per file or group of files,
saying what it owns. What a module does and why is in its header comment; the layers, what each
owns and the rules across them are in [ARCHITECTURE.md](../../ARCHITECTURE.md). The code is four
layers, a folder each: the page (`app/`), the game (`packages/game/`), the island
(`packages/island/`) and the renderer (`packages/render/`).

## The page: `app/`

- `Boot.ts`: the entry. It loads `PageSettings.ts` (the address parsed, its problems warned, the
  tier chosen, the settings installed; the reloads and the browser's storage), then `main.ts`,
  which imports `WorldBoot.ts` (the world's generation started on the land a resumed save grew)
  before its own parts.
- `main.ts`: the one place that assembles the page. It calls the renderer's stages, the island's
  and the page's own in an order that is part of the image, and starts the game from the parts
  they build. Each stage puts what it builds on its layer's one object.
- `Page.ts`: the page's own parts: the camera's views (`CameraViews.ts`), the GUI (`Gui.ts`), the
  frame loop and the render scale (`Frame.ts`: the page's tick, which calls the renderer's and the
  island's frame stages in a fixed order), the scene jump (`Scene.ts`, `establishScene`) and the
  diagnostics (`Diagnostics.ts`).
- `QualityDetect.ts`: takes `?quality`, or high (its GPU timing is parked with the lower tiers).
- `window.__PONLAI__`, `window.__THREE_GAME_DIAGNOSTICS__` and `window.__PONLAI_WORLD__` (whether
  the world is generated, set by `WorldBoot.ts`) exist only on the dev server or with `?debug` /
  `?profile`.
- `scenes.html` (at the top), `ScenesBoot.ts` and `scenes/`: the renderer's test scenes, a second
  page (`?scene=ball|empty|sea|plants`) built from the renderer's stages alone, with no island or
  game. `scenes/ScenePage.ts` builds the page, `scenes/TestScene.ts` is a scene's type,
  `scenes/index.ts` the list, and each scene is a module beside them. Their files import only the
  renderer's exits (`tools/repo/verify-layers.mjs`). The page draws with the renderer's neutral look
  (`renderLook=ponlai` picks the island's, in the entry, which hands the look to the page) and
  takes the island's inputs from `packages/render/NeutralInputs.ts`. `tools/scenes.mjs` shoots,
  reads and checks them.

## The packages' exits

Another package, or the page, imports the renderer, the island and the game only through their
exits (`ARCHITECTURE.md`, rule 11; `tools/repo/layers.json`, `tools/repo/verify-layers.mjs`,
`tools/repo/verify-exits.mjs`):

- the page's: `packages/render/index.ts`, `packages/island/index.ts` and `packages/game/index.ts`
  (the game is loaded on demand);
- the headless ones, free of three.js, for the chunk worker and node: `packages/render/data.ts`,
  `packages/island/land.ts` and `packages/game/sim/index.ts`;
- the renderer's setup exit, `packages/render/setup.ts`: the settings and the quality tiers, which
  the page installs before the renderer's other modules load, and the look's types and the
  renderer's neutral set (`NEUTRAL_LOOK`), which the page picks from.

The modules loaded on demand are lazy exits.

## The renderer: `packages/render/`

- `RenderStages.ts`: the renderer's stages (the renderer, the sky, the sun, the sea, the frame's
  passes, then what the island's data builds) and its frame stages (`createFrameStages`).
  `placeVegetation` places the registered plant kinds and closes their registry.
- `Settings.ts`: declares every URL option and is the one entrance every module reads them through
  (`settings.get( 'name' )`; `tools/repo/verify-settings.mjs`).
- `Quality.ts`: the quality tiers, every cost knob in one table (high the only active one).
- `shared.ts`: the uniforms shared by the water, the terrain and the vegetation, which the entry
  creates (with the look's numbers every material's shader reads) and installs before anything
  builds.
- `FetchAsset.ts`: fetches the assets.
- `Extensions.ts`: the three declarations every definition registered with the renderer states (a
  plant kind, a kind of local light, an extra pass: its cost knob, its stand in the test mode, how
  it follows the land's growth; `tools/verify-extensions.mjs`).
- `UserData.ts`: the `userData` keys the renderer sets or reads (`tools/repo/verify-layers.mjs`).
- `NeutralInputs.ts`: the island's inputs for the test scenes: the probes, the bounce's ground and
  the shore's fields of level open ground or of the open sea far from any shore.

### `vegetation/`

What every plant kind shares: the material, the coverage (`Coverage.ts`), the leaf textures, the
instances (`Instances.ts`, kept for kinds to come: no kind uses it today), the GPU cull
(`VegetationCull.ts`), the wind's deforms, the LOD (`Lod.ts`) and the physics (`Physics.ts`, kept
for the hanging kinds to come: no kind uses it today).

- `Registry.ts`: the registry of plant kinds. `DefaultPlant.ts`: the plant a kind without art is
  drawn with.
- `TreeMesh.ts`: the trees' tubes and leaf cards; `TreeSurfaces.ts`: their bark and leaf surfaces.
- `PlantInstances.ts`: the authored plants, drawn as instances of a few prototypes at two levels
  with a stipple between them.
- `LeafLight.ts`: what a tree's leaves pass on of the key.
- `VegetationLighting.ts`, `VegetationShadow.ts`, `WindMotion.ts`: the vegetation's light, shadow
  and wind motion. `VegetationPrepass.ts`: its depth prepass.
- `Displacement.ts`: the displacement field the blades read, a frame-graph pass.

### `util/`

- `noise.ts`: the world generator's deterministic noise.
- `Steps.ts`, `Upload.ts`: the growth's work and uploads in steps of a fraction of a millisecond.

### `lighting/`

Sun radiometry, the air/water interface and the refracted sun under water, and:

- `SunShadow.ts`, `SolarShadow.ts`: the sun's stepped soft shadow.
- `KeyCloud.ts`: the key's visibility under cloud for the lit code without a sky (the land's floor
  under a deck, which the islanders read; the sea takes the same floor from the sky, `Sky.ts`
  `seaKeyFloor`).
- `Underwater.ts`: the light every submerged material shares.
- `MeadowCanopy.ts`: the meadow's canopy light and its crowns' shade.
- `AmbientVolume.ts`: the ambient light's probes on the GPU (the lattice's buffer and uniforms, its
  output texture, its debug view). `AmbientRelight.ts`: relights them every frame by the sky's
  harmonics and the key (`Harmonics.ts`: the harmonics' operations). `AmbientSample.ts`: the
  ambient diffuse every lit island material reads.
- `GroundBounce.ts`: the sunlight the ground bounces up.
- `AmbientGrade.ts`: the ambient grade's per-weather, per-elevation knobs on the island's ambient
  light.
- `LocalLights.ts`: the local lights, such as the yunpeng's clumps by night, sorted into clusters
  of the main view by a compute pass ahead of the scene passes; `LocalLightClusters.ts`: the grid
  and the CPU sort.
- `KeyLift.ts`: the low key's lift of the diffuse's cosine.
- `MeterLight.ts`: the metering illuminance every lit material writes beside its colour for the
  exposure.

A new lit material takes all of these through the island's lighting model
(`docs/how-to/add-material.md`).

### `materials/`

- `ProceduralTextures.ts`: procedural textures (the gravel bake, the scans' texture arrays).
- `HexTiling.ts`: their hex tiling. `Wetness.ts`: wet surfaces.

### `ocean/`

The FFT ocean (`OceanFFT.ts`), the shore's waves and the storm sea, and:

- `WaveDamping.ts`: the share of each wave cascade a point of the sea keeps.
- `WaveMaps.ts`: the wave maps and caustics the light under the water reads, baked by a pass on
  the frame graph.
- `Water.ts`: the water's shading.
- `SeaOptics.ts`: the sea's optical properties as plain numbers, which the page's uniforms, the
  ground bounce and the ambient probes read. A change to them rebuilds the world's cache.
- `SeaDetail.ts`: the sea's large-scale detail (gusts, slicks, windrows).
- `Refraction.ts`: the water's refraction source.

### `sky/`

- `Sky.ts`: the atmosphere and the environment's bakes; `SkyDome.ts`: its colour nodes for the
  dome and the bakes; `SkyBake.ts`: the bakes; `SkyTrack.ts`: its state for a frame.
- `Clouds.ts`: the volumetric clouds; `CloudModel.ts`: their model's constants and shared helpers;
  `CloudKernels.ts`: their kernels; `CloudView.ts`: the traced and resolved view;
  `CloudShadow.ts`: the shadow as surfaces and the air read it.
- `Streaks.ts`: the thin cloud layer's fibres.
- `DayCycle.ts`: the day cycle.
- `NightSky.ts`, `StarCatalog.ts`: the night sky and its data.
- `Weather.ts`: the weather: its sky presets, its wind's levels and heading, and the auto chain.

### `weather/`

Lightning, rain and puddles, and:

- `Wind.ts`: the weather's one wind, which every part reads from it, and the one wind field all
  vegetation moves in.
- `VolumetricHaze.ts`: the air's haze and sea fog as one froxel volume lit by the atmosphere and
  shadowed by the sun's maps and the clouds; `HazeKeys.ts`: its keys by the hour and the weather;
  `HazeDepth.ts`: its medium's closed form.
- `RainCollision.ts`: the rain's collision map.

### `look/`

The look the renderer draws with, passed in. `Look.ts`: the types of its tables, one set per
system. `NeutralLook.ts`: the renderer's neutral set, which the test scenes draw with. Per system,
the module that makes its tables from the numbers it is handed, with their tunables and the CPU
code that reads only them (the shaders and the methods that take them stay in their modules):

- `SkyLook.ts` (from the sky's table the sky stage hands `createSkyTables`), `ExposureLook.ts` (its
  keys and base exposure, `createExposure`), `HazeLook.ts` (`createHazeTables`), `DayLook.ts` (the
  day's windows, `createDayWindows`), `AmbientLook.ts` (the ambient grade's tables in the light
  stage, `createAmbientTables`; the low key's lift in the sky stage, `createKeyLift`) and
  `DisplayLook.ts` (contrast, desaturation, white balance, tone curve, base grade, bloom and the
  rods' colour, from the table the stage of the frame's passes hands `createDisplayTables`).
- The systems whose tables are passed where they are created have no reader here: the sea's
  detail and distant swell (`ocean/SeaDetail.ts`, `ocean/OceanFFT.ts`), the ambient occlusion's
  floor, the meadow canopy's media and the plants' answer to the wind (the shared uniforms,
  `shared.ts`; the wind's through `weather/Wind.ts` `windResponse`) and the local lights' gain
  (`lighting/LocalLights.ts`).

`tools/verify-look-params.mjs` checks the passed tables, the exposure, the day's windows, the
ambient light's look, the haze's keys, the display's and the sky's.

### `post/`

The frame's passes and tidewater's display chain:

- `Pipeline.ts`: the frame's passes; `PostOptions.ts`: its options of the graph's structure;
  `PipelineDisplay.ts`: the display chain's materials; `PipelinePasses.ts`: the passes declared on
  the frame graph.
- `PhysicalBloom.ts`: the bloom, the sun's flare added to it. `Purkinje.ts`: the colour the rods
  lend low light.
- `PreExposure.ts`: the pre-exposure every writer of the scene's colour and metering light
  multiplies by and every scene-unit reader divides out. The sky's bakes and the clouds' panorama
  store at a power of two of their own instead (`storeStops`), and their readers multiply by their
  read gain (`Sky.ts` `environmentRead` and the like).
- `MeadowShade.ts`: the key's screen-space shade over the vegetation's and the opaque scene's
  depth.
- `GTAO.ts`: the screen-space ambient occlusion the ambient light takes (on in high), over the
  opaque scene's depth prepass (`OpaquePrepass.ts`).
- `LightShafts.ts`: the screen-space light shafts, off by default.
- `FSR.ts`, `RenderScale.ts`, `DynamicResolution.ts`: FSR 1, the render scale and the dynamic
  resolution.
- `FramePacer.ts`: the frame pacer. `SubmitBatch.ts`: the submit batching.
- `Settled.ts`: the signal that a paused frame is final.
- `Antialiasing.ts`: the anti-aliasing mode and the scene's sample count.
- Under the temporal modes: the jitter (`Jitter.ts`), the motion vectors (`Motion.ts`), the
  temporal resolve (`TemporalAA.ts`), its history fetch (FSR 3.1's Lanczos 2 and deringing:
  `TemporalHistory.ts`), the FSR 2 measures it takes for moving pixels (`TemporalLocks.ts`) and the
  image of a resting scene (`TemporalRest.ts`).
- `SceneEvents.ts`: the scene events that restart the resting image or cut the history; each
  layer declares its own reasons. `SceneHistory.ts`: the table of what a cut or a scene jump
  clears.
- `ExtraPass.ts`: the scene's extra passes and the typed names of the scene passes that take
  latent draws.
- `AfterResolve.ts`: the rain's streaks and the storm's spray, drawn after the resolve.

### `post/graph/`

The frame graph:

- `GraphCompiler.ts`: its declarations and compiler, pure TypeScript
  (`tools/verify-framegraph.mjs`).
- `FrameGraph.ts`, `Compile.ts`: its runtime and its warm-up.
- `AttachmentOps.ts`: the derived attachment ops.
- `DebugView.ts`: the debug view (`fgview`).

### `post/fsr3/`

The TSL port of AMD's FSR 3.1.5 upscaler (`aa=fsr3`): the host's maths and frame plan
(`Host.ts`), its resources (`Resources.ts`) and bindings (`Bindings.ts`), a module per upstream
shader header, the kernels (`Passes.ts`); the page's integration, its passes on the frame graph,
rest and diagnostics (`Fsr3Upscaler.ts`) and its mip bias (`MipBias.ts`).

### `three/`

Every reach into three.js beyond its public interface, each a function named for what it does,
which the rest of the code calls instead of naming a private member or the backend
(`ARCHITECTURE.md`, rule 23):

- `Backend.ts`: the backend and its device, the GPU objects behind textures and attributes, the
  timestamp pools and the methods we wrap.
- `Attributes.ts`: the renderer's attribute records.
- `DrawBuilds.ts`: three's steps for building a draw ahead, and a bloom's passes.
- `Environment.ts`: the PMREM generator's bake in steps.
- `ShadowPass.ts`: a light's shadow pass.
- `FrameLoop.ts`: the animation loop and its per-frame bookkeeping.
- `ThreePatches.ts`: r186's cache-key patches and its first lit build made ahead.
- `Internals.ts`: the start-up check of the renderer's members and the error naming what is
  missing.
- `three-internals.json`: the internals the code depends on (`tools/repo/verify-three-internals.mjs`).

### `debug/`

Runtime A/B flags (`DebugFlags.ts`), the test mode's switch (`TestMode.ts`), the frame profiler
(`FrameProfiler.ts`), the frame-rate readout (`FrameStats.ts`), the pipeline counter
(`PipelineCounter.ts`), the wind view (`WindView.ts`), the lighting layer's light-only and
ambient-only views (`LightLayer.ts`), the scene's linear radiance over screen boxes (`Radiance.ts`)
and what each cell of a grid shows (`RadianceAov.ts`; the kinds' codes in `Classes.ts`), and the
named numbers a script or the console can set on a running page (`Tune.ts`).

## The island: `packages/island/`

- `IslandStages.ts`: the island's stages (the camera, the land, the world, the vegetation, the
  growth) and its frame stage (`createIslandFrame`).

### `camera/`

The island camera, which starts framing the land alone from its heading (`IslandFraming.ts`;
`app/CameraViews.ts` `placeOrbit`) and which the hand pans within the land's soft bounds, turns,
tilts and zooms (`IslandCameraControls.ts`; the ground it grabs in `IslandGround.ts`), and the free
flight (`FreeCameraControls.ts`).

### `world/`

The world generated from the grown land (`IslandGrowth.ts`) in 16 m chunks:

- `Chunks.ts`, `IslandSimplify.ts`, `ChunkDerived.ts`: a chunk's content.
- `WorldStart.ts`, `WorldChunks.ts`, `chunkWorker.ts`: the chunks built on a pool of workers.
- `WorldCache.ts`: the cache per chunk. `ChunkMerge.ts`: the chunks merged.
- `World.ts`: the world drawn; `WorldFields.ts`: the world fields' textures.
- `Growth.ts`: the world grown in place; `SeabedRise.ts`: the shoal of a coming piece.
- `IslandUserData.ts`: the `userData` keys the island keeps to itself (`tools/repo/verify-layers.mjs`).
- `IslandClasses.ts`: the island's kinds for the debug view's grid.

Its kinds:

- `WorldShapes.ts`: the shapes and the top's low swells. `Cliff.ts`: the cliffs. `Stones.ts`: the
  submerged stones. `Bathymetry.ts`, `SeabedTile.ts`: the sea floor. `RimGround.ts`: the rim.
- The meadow: `Grass.ts` (its blades generated on the GPU as they draw), `SwardField.ts` (its
  crowns' heights, and the sward's depth over its ground in the meadow map), `Anchors.ts` (its
  anchors) and `ShoreSample.ts` (its soil).
- The yunpeng that stands among it, single clumps far apart: `YunpengSites.ts` (where) and
  `Yunpeng.ts` (its stalks, instances of a few prototypes at two levels, and its lights).
- `WalkLoop.ts`, `WalkPath.ts`: the islander's walking loop.
- The bamboo over the whole island, which the islanders' building stock will come from:
  `BambooGroves.ts` (where its culms stand, and the litter on its groves' floor, which the grass
  keeps off), `Bamboo.ts` and `BambooMaterials.ts` (the culms, instances of a few prototypes at two
  levels) and `BambooColours.ts` (their colours, which the probes see too).
- `AmbientProbes.ts`: the ambient light's probes, baked per chunk.
- `SkyOcclusion.ts`: the sky's occlusion over the land.
- `Trample.ts`: the islanders' trail through the meadow, drawn as sprites into the displacement
  field the blades read (`packages/render/vegetation/Displacement.ts`).
- `FallingLeaves.ts`: the bamboo leaves the wind takes off the island, a fixed ring of leaves born
  round the view and stepped on the GPU by one compute pass.

### `materials/`

- `TerrainMaterial.ts`: the terrain, its ground scans hex-tiled.
- `SeabedLook.ts`: the sea floor's colour.
- `Meadow.ts`: the meadow's habitat and soil-depth fields.
- `SwardTint.ts`: what a closed sky's light turns into in the sward, shared by the blades and the
  turf.

### `look/`

The island's numbers for the renderer's look tables, one file per system (`Sea.ts`, `Day.ts`,
`Ambient.ts`, `Exposure.ts`, `Display.ts`, `Haze.ts`, `Sky.ts`, `Occlusion.ts`, `LocalLights.ts`,
`MeadowCanopy.ts`, `Wind.ts`): numbers and pure functions of numbers only, gathered in
`IslandLook.ts`. The entry picks them after the settings (`app/PageSettings.ts`) and the page hands
them to the stages; a node tool hands them to what it creates.

### `characters/`

The islanders: figures assembled on the kit's rig, their looks and proportions. `FigureSurfaces.ts`:
the kit look's cel light and ears, the Hanming look's feather and woven surfaces. `Ages.ts`: their
bodies by sex and age as growth curves, which a figure takes on its rig and shape keys
(`FigureAge.ts`).

### `life/`

The island's creatures (`docs/explanation/art-direction.md`, Life), simulated per frame on the
rendering side: the wenyao's schools of flying fish (`Wenyao.ts`) and the fish's mesh and material
(`FishGeometry.ts`, `FishMaterial.ts`).

### `debug/`

The wind's arrows and probe (`WindArrows.ts`, `WindProbe.ts`) and the chunks' borders
(`ChunkBorders.ts`).

## The game: `packages/game/`

The game behind `?game`:

- `Game.ts`: the page's host of the game's session.
- `Session.ts`: the session, headless. It runs the simulation with its record, hands the
  simulation's events to its listeners, checks the player's commands, keeps the leader's words as
  heard and the save, and asks the page's `world/Growth.ts` for the island's growth by the
  population. `tools/play-game.mjs` runs the same session in node.
- `save.ts`: the save: one slot, the simulation's state and the record, versioned; a save of
  another version is set aside and a new game started. The world's start reads its piece count.
- `Chronicle.ts`: the record of what happened, the events' first listener.
- `Placement.ts`: places a building chosen in the build bar.
- `view/`: draws the islanders and the chest.

### `sim/`

The headless simulation: no three.js or DOM; node runs it by stripping types.

- `actions.ts`: the five actions, each with its arguments and the condition it holds by every
  tick.
- `agent.ts` `act`: the entrance that checks a brain's calls, against the schemas of `schema.ts`.
- `events.ts`: what happened, as events.
- `clock.ts`: a tick's time of day, only here.
- `people.ts`: the other islanders as places, and what they heard and were given.
- `registry.ts`: the game's content (needs, items and their uses, kinds of place and of building,
  the options at them) as definitions registered by the modules of `content/`. The core names none
  (`ARCHITECTURE.md`, rule 7; adding content: `docs/how-to/add-game-content.md`).
- `maths.ts`: the few functions the rules need; the rules use exact operations only.

### `ui/`

The player's interface (`GameUi.ts`; its spec: `docs/explanation/ui.md`):

- Its parts: `TopRow.ts`, `Forecast.ts`, `ResourceRow.ts`, `People.ts`, `SpeakBar.ts`,
  `BuildBar.ts`, `Record.ts`.
- `data/`: the lists it shows as data, with placeholder rows, and the defaults for content without
  its own (buildings, resources, the needs' looks, weather kinds, the record's kinds, the words for
  the simulation's states).
- `i18n/`: its words in i18next catalogues (`zh-CN.json` the source, `en.json` an unmaintained
  snapshot). No player-facing string is written in code (`tools/verify-i18n.mjs`).
- `Icons.ts`: the brush icons; `Brush.ts`: strokes; `Ink.ts`: the ink of the long ones, drawn by
  `InkPath.ts` (`tools/verify-ink.mjs`).
- `Space.ts`: what it lays into the scene in the camera's perspective (the words over the
  islanders and in flight).
- `Palette.ts`: the palette; `ui.css`: the styles; `fonts/`: the licences of its fonts (our own
  brush fonts are assets, `public/fonts/`).

## Tools: `tools/`

Captures, profiling, the GPU lock and the probes ([Tools](tools.md)), and:

- `wgsl-build.mjs`: the WGSL build; its entries in `wgsl-build/`.
- `verify-world-chunks.mjs`, `verify-world-stats.mjs`: the world's chunk checks and statistics, on
  the node helpers in `world-node.mjs`; `verify-chunk-derived.mjs`: the chunks' derived products
  against the builders they stand in for.
- `play-game.mjs`: the game played headless for days, with a transcript, a timeline and a summary
  of what the islanders did, for a designer or a brain judged offline.
- `lint/`: the code lint's rules and fixtures ([Tools](tools.md#code-lint)).

## Assets: `public/`

Git-ignored: the game's assets, filled from the GitHub release that `assets.lock.json` names
(`tools/repo/assets.mjs`, `tools/repo/vite-assets.mjs`; [Tools](tools.md#assets)).
