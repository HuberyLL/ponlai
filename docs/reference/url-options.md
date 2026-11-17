# URL options

The app's URL options, by group, with the debug views and console handles that go with them. For
the tools that load pages with these options, see [Tools](tools.md). Project terms such as test
mode, scene jump and fresh load are defined in the [glossary](glossary.md).

Contents:

- [View and capture](#view-and-capture)
- [The island](#the-island)
- [Sky and weather](#sky-and-weather)
- [Quality, anti-aliasing and the frame](#quality-anti-aliasing-and-the-frame)
- [Debug flags](#debug-flags)
- [The lighting layer](#the-lighting-layer)
- [Radiance](#radiance)
- [Tunable parameters](#tunable-parameters)
- [The test scenes](#the-test-scenes)
- [Ambient light, occlusion and other views](#ambient-light-occlusion-and-other-views)
- [Wind and haze](#wind-and-haze)
- [Islanders](#islanders)
- [Profiling](#profiling)
- [Game](#game)
- [Every option](#every-option): the generated table of every option

## View and capture

- `paused` pauses the scene, `t` sets the scene time, and `dpr` pins the render pixel ratio.
- `polar` and `az` set the island view's tilt and heading (40 and 180 degrees by default).
- `dist` sets the camera's distance in metres from the default pivot. Without it, the island view
  frames the land and its shallows (`IslandFraming.ts`). When the framing of the land alone, from
  the view's heading, is nearer, the camera moves in to that distance.
- `cameraInput=off` stops the user's mouse and touch input from moving the island camera. Input is
  on by default.
- `gui` shows the GUI.
- `camera` selects the camera: `orbit`, the default, is the island camera; `free` flies with the
  mouse, WASD, Q/E and Shift.
- The island view's field of view widens as the camera zooms in. `nearFov` sets the field of view
  in degrees at the closest zoom (42 by default; `off` keeps 27 at every distance). `nearFovFrom`
  sets the distance in metres from which it widens (50 by default). The GUI's Camera folder has the
  same three controls.
- A paused page removes its loading screen at once, without the fade, so a capture of a paused
  frame never includes the loading screen.
- `paused` also puts the page in the test mode (`packages/render/debug/TestMode.ts`;
  `docs/reference/test-mode.md`). `testMode=0` keeps a paused page out of the test mode, as the
  clips do.

## The island

- `seed` sets the world's seed (1 by default: Ponlai's island). `grow` sets the number of growth
  steps after the starting island (0 by default, up to `GROWTH.maxSteps`). The app generates its
  world from that land in 16 m chunks and frames its views on it. Debug pages expose
  `window.__PONLAI__.land` for the tools to frame their views by: `seed`, `step`, `bounds`,
  `centroid`, the views' `scale` relative to the first island, and the default pivot `target`. It
  follows the island as it grows.
- `bamboo=cover,height` loads a different bamboo setup (packages/island/world/BambooGroves.ts): the
  share of the land its groves cover (0 to 1) and a grown culm's height (m). If either value is
  left out, it keeps its default. It is a load-time option for comparing looks. The culms, and the
  meadow's thinning under the groves, follow it. The canopy's shadowing baked into the world's
  chunks (their sky visibility) and the ambient light's probes
  (packages/island/world/AmbientProbes.ts) keep the default groves.
- Growing in place (packages/island/world/Growth.ts): the Grow control (the GUI's Island folder) or
  `await __PONLAI__.growth.grow()` generates the next piece in the background and swaps it in. The
  promise resolves once the frames after the swap are done. From then on, the page keeps the next
  piece generated ahead. A `?game` page generates it from its start. `growth.start()` generates it
  ahead on any page without growing, for a probe that needs the piece ready.
  - `growth.state` holds the step shown, the next piece's phase, and the last swap's chunks and
    times (the preparation, the swap's frame by part, and the frames after it). It also holds
    `work`, the growth's own main-thread time per frame: `max`, its `stage`, `frames` as pairs of
    page time and ms, steps over 0.6 ms in `slow`, and the page times when the preparation began,
    the swap happened and its frames ended.
  - `growth.chunkHashes()` returns the shown chunks' hashes. They are equal on a grown page and on a
    page loaded with `grow` at the same step. `growth.fieldBytes()` returns the world fields' GPU
    bytes.
  - The island view (key R, `setCameraView( 'island' )`) frames the land shown. A camera that holds
    the island view glides to the new framing (at once while paused). A camera moved elsewhere, by
    a tool or by the user, stays where it is.
- `soil=0` loads the ground with its soil layer off (`packages/island/materials/Soil.ts`: the root
  bed cut open at the meadow's shoulder). The GUI's Ground folder control `soil layer` switches it
  on a running page.
- `approach` (0 to 1, 0 by default) sets the progress toward the next piece, and applies the shoal
  under it (packages/island/world/SeabedRise.ts) at once. Above 0, the page generates the next
  piece and keeps its loading screen up until the shoal is written, so a paused load is
  reproducible. It is a scene option: a scene jump sets it as a load does. On a running page, use
  the Island folder's Approach slider (eased over seconds of scene time, or at once while paused),
  `growth.approach( p )` (eased) or `await growth.approachNow( p )`. `growth.rise.state` holds the
  approach; R, the shoal's rise as shown from 0 to 1 (`r`, its `target`, and the R last
  `written`); the pending `tiles`; their largest `rise` (m); the `writes`; and the last write's
  `ms`.
- `worldCache=off` generates every chunk of the island, as on a first visit, instead of loading it
  from the browser's IndexedDB cache (`packages/island/world/WorldChunks.ts`). The cache keeps one
  record per chunk, so after the land grows by a piece, a load reads from the cache the chunks the
  piece did not reach. The diagnostics' `worldCache` counts the records read (`hits`, of the chunks
  and the land). The cache keeps the records of the two land versions loaded last (each a seed and
  a `grow` step) and deletes the rest after a load. So going back to an older step rebuilds the
  chunks it does not share with those two versions.
- `terrainHex=0` gives the cliff plain triplanar tiling and smooth layer masks. The option is read
  only when the material is built. For an A/B inside one page, swap each cliff material to its
  other variant through `material.userData.terrainVariant`, as `TerrainMaterial.ts` shows.
- `wenyao` builds the wenyao, the schools of flying fish off the island
  (`packages/island/life/Wenyao.ts`). The scene leaves them out while they are parked.
- `chunkBorders` shows the world's 16 m chunks as lines above the sea and the meadow, so you can
  tell a seam from a chunk border. The GUI's Ground folder control `chunk borders` does the same.

## Sky and weather

- `hour` sets the hour of the day. `preset` sets the hour at which the sun stands at a given
  elevation, on the 52-degree sun path (`packages/render/sky/DayCycle.ts` DAY_PRESETS): dawn, -8.6
  degrees in the morning; sunrise, 2; noon, 52 at 12; golden-hour, 26.2 in the afternoon (the
  default); sunset, 2; dusk, -8.6; midnight, -52 at 0.
- `dayLength` sets the length of a day in seconds. `moon` sets the moon's phase (0.5, a full moon,
  by default). The phase shapes only the drawn moon, which stays fixed in the sky.
- `clock=paused` freezes only the day clock; `paused` freezes it together with the scene.
- `weather` holds one weather: clear, fair, cloudy, overcast, rain, storm or fog. Rain and storm
  load already established, so the scene is already wet. Without `weather`, `wind` or `windDir`,
  the weather and its wind change on their own, among the kept presets. `clouds` overrides the
  cloud coverage.
- `dayFog` turns on the day's fog layer under a clear or fair sky (off by default; the GUI's
  Weather folder control `day fog`). Its fields are tuned as `haze.fog.<field>@<day|golden|mist>`
  (`packages/render/weather/HazeKeys.ts`).
- `seaFog` turns on the deep sea fog, a switch independent of the weather, under any sky and at any
  hour (off by default; the GUI's Weather folder control `sea fog`). Its fields are tuned as
  `haze.fog.<field>@sea` (`packages/render/look/HazeLook.ts` `createHazeTables`).
- `wind` sets the wind's level: light, gentle, fresh or strong, a mean wind 10 m up of 1.5, 3.8, 7
  and 11 m/s. `windDir` sets its heading in degrees: the direction the wind comes from, in the sea
  spectrum's convention, atan2( z, x ) in the world's x-z plane. 40 is the prevailing wind, which
  the landscape and the sea's swell keep; the wind-driven sea turns with it. Each option overrides
  the sky's own wind, which is the gentle wind from 40 for every kept sky, so `weather=fair` alone
  gives the same page as before. Naming either option holds the weather, as `weather` does; both
  are scene options. On a running page, use the GUI's Weather folder (`wind`, `wind heading`, over
  its transition seconds) or `__PONLAI__.setWind( { level, heading }, seconds )`.
  `weather.windTarget` and the diagnostics' `windTarget`, `windSpeed` and `windHeading` show it
  (`packages/render/sky/Weather.ts`).
- Cloudy, overcast, rain, storm and fog are parked (`packages/render/sky/Weather.ts`
  `PARKED_WEATHER`). A production page without `?debug` refuses them with a console warning and
  shows fair. The development server, `?debug` and `?profile` still load them.

## Quality, anti-aliasing and the frame

- `quality` selects the quality tier (low, medium or high), which sets every quality setting in
  `packages/render/Quality.ts`. Without it, the tier is high, the only active tier; medium and low
  are parked (see `docs/reference/tools.md`, Parked weathers and quality tiers).
  `tier.<setting>=<value>` overrides one setting of the tier for an A/B (for example
  `tier.post.hazeGrid.width=128`). The GPU timing that once chose the tier (`app/QualityDetect.ts`,
  `autoQuality`, and `autoQualitySlow`, a factor on the time it measures) is parked with them. The
  load reads neither option to choose the tier, and the GUI's quality control removes
  `autoQuality=detect` from the address when it reloads.

The following rendering and A/B options are read at load. The runtime switches for A/Bs inside one
page are in `packages/render/debug/DebugFlags.ts`.

- `aa` selects the anti-aliasing mode (`packages/render/post/Antialiasing.ts`), over the tier's
  `aa` setting. Each tier has its default: `msaa` for high (`taau` for the parked medium tier,
  `msaa` for low). The GUI's Antialiasing control reloads the page with any of MSAA 4x, TAAU, FSR
  3.1, TAA and Off.
  - `msaa`: 4 samples, upscaled by FSR 1.
  - `off`: one sample.
  - `taa` and `taau`, the temporal modes: one sample, jittered, with motion vectors, resolved
    against a history in `TemporalAA.ts`, at the render resolution or upsampled to the canvas.
    Once it has converged, a paused page shows the rest image, the average over the jitter
    sequence (`TemporalRest.ts`). Anything that changes the scene raises a scene event
    (`SceneEvents.ts`), which restarts the rest image and may cut the history. See the
    diagnostics' `taa.lastEvent`; `__PONLAI__.taa.restart()` restarts it by hand.
  - `msaa` is also an older option, an alias of `aa`: `4` reads as `aa=msaa`, and `1` and `2` as
    `aa=off`, since WebGPU multisamples with 1 or 4 samples only.

  The capture and parity tools apply the temporal tolerances through their own `--aa` option, so a
  set of captures with the parked medium tier's default passes `--aa taau`.
- `aa=fsr3` uses AMD's FSR 3.1 upscaler (the TSL port in `packages/render/post/fsr3/`, integrated
  by `Fsr3Upscaler.ts`) at the position in the frame that AMD specifies: one sample, jittered with
  FSR's own sequence, with motion vectors. FSR takes the composite's HDR image at the render
  resolution, and the bloom and the colour grade run on its output at the canvas resolution.
  - A paused page shows FSR's rest image (`tier.taa.fsr3.restSequence` frames from a reset, then
    held), through the same `__PONLAI__.taa` handles and the diagnostics' `taa` block as the
    temporal modes. That block has an `fsr3` block: the live constants, frame index, phase count,
    jobs and clears. `__PONLAI__.fsr3` is the upscaler.
  - FSR needs the composite pass; `post=inline-composite` and `post=legacy` run msaa instead.
  - Flags: `flags=fsrMipBias:false` removes the terrain's mip bias (live: `__PONLAI__.flags`).
    `flags=fsrAutoReactive:true` runs the reactive-mask generator (read at load).
    `flags=fsrJitterSign:-1` and `fsrMotionScale:<k>` scale the jitter and the motion vectors that
    FSR is given (live). In the checks of these conventions, FSR's image against the ground truth
    is best at 1.
- `fsrDebug` (debug builds, under `aa=fsr3`) draws FSR's debug view over its output, a 3x3 grid:
  dilated motion, protected areas, dilated depth; disocclusion, shading change, detail protection
  takedown. It is drawn through the post-processing chain, so it is colour graded.
- `aa=gt` (debug builds only; refused with a warning otherwise) renders the ground truth that the
  temporal modes are measured against. It runs the temporal graph at the canvas resolution, with no
  dynamic resolution. Its rest image averages `tier.taa.gtJitters` jittered frames (64 by default,
  32 per frame of a motion clip) with a box filter, without the sharpening (the dither is kept).
  - `loop.step`'s `converge( i )`, where it returns true, holds the scene after frame i's tick and
    renders it until the rest image has converged.
  - `tools/kit/parity/capture-clip.mjs --aa gt [--gt-jitters n]` captures it that way. So does a
    clip of one frame (`--clip rest`) under `aa=taa|taau`, with their own rest sequence.
  - After `loop.step`, `loop.start()` resumes the clock with a first delta of at most one frame.
- `taaResolve=off` (debug builds) runs the temporal modes without their resolve. The jittered frame
  is shown as it renders, through the output passes with the colour grade's vignette and dither.
- `post=legacy` (or a comma list of `inline-composite`, `three-fsr`, `store-scene`) runs the frame
  graph without the changes of the first performance round.
- `gpuTimer=off` runs the high tier's dynamic resolution without its timestamp queries. It then
  adjusts the render scale from the frame intervals.
- `drsStore=on|off` sets whether the high tier starts from the render scale it last held, and saves
  the scale it holds. The scale is kept in localStorage per tier, anti-aliasing mode, frame rate,
  canvas size and GPU. It is on by default, and off in an automated browser, so that a profile or
  capture does not start where the last run ended. In an automated browser, `on` tests a returning
  visitor's load; `off` neither restores nor saves anywhere.
- `frameRate=auto|<fps>` sets the frame rate the loop holds on a faster display.
  - `auto`, the default, holds the tier's rate. When the dynamic scale's floor cannot hold that
    rate, it falls back to the next whole divisor of the refresh rate, for example 72 -> 48 fps on
    144 Hz (`packages/render/post/FramePacer.ts`).
  - A number is a cap: the fastest whole-divisor rate not above it, without the fallback.
    `frameRate=0` renders on every refresh, as the profiler's uncapped runs do.
  - `frameFallback=0` keeps `auto` at the tier's rate. profile-frame adds it on `--compare` and
    `--accept`; `--frame-fallback` keeps the fallback on.
  - A scene jump (`establishScene`) returns from the fallback to the held rate, as a fresh load
    starts at the held rate.
  - On a debug page, `__PONLAI__.pacer.choices()` lists the display's whole-divisor rates,
    `setRate( fps | 'auto' )` sets one, `mode` and `rate` read the choice, and `fps` reads the rate
    held now. A production `?game` settings menu needs the game to be given the pacer, which is
    not wired yet.
  - The diagnostics' `pacing` block shows `mode`, `fallback`, `falls` and `returns`. For the test
    mode's paused pages, it also shows `queueLimit` (the frames they may keep queued on the GPU),
    `queued` (how many are queued now) and `held` (how many due frames waited for the queue).
- `submits=each` uses three.js's own submit per pass, without the submit batching. At runtime, the
  switch is `flags.batchSubmits`. The batching's tracking wrappers stay installed, so compare
  against `main` to measure their JavaScript cost. `submitBatch=hold,wait,idle` sets the batching
  policy (see `SubmitBatch.ts`).
- `fgOps` sets the frame graph's attachment load and store ops. `derived`, the default, derives
  them each frame from the passes that run. `legacy` discards the scene target in the rain only.
  `store` keeps every store and resolve, which is also what `post=store-scene` and `post=legacy`
  choose. `off` uses three.js's own. `fgPrime=0` turns off the warm-up's render of the passes that
  cannot be precompiled (see `packages/render/post/graph/FrameGraph.ts`).
- `fgview=<resource>[.<output>]` (debug builds) draws one of the frame graph's resources over the
  canvas, in the graph's debug view, shown according to what it holds. Examples are `linearDepth`,
  `surfaceDepth`, `FSR.easu`, and `displacement` (the meadow's displacement field: its direction as
  a hue, its magnitude as brightness).
  - Outputs are `r` / `g` / `b` / `a`, `previous`, and a depth's `sample<n>`.
  - Under the temporal modes, there are also `class`, `reactive`, `reproject` and `reproject.diff`,
    views of the motion vectors, and views of the resolve's decisions. `weight` is the history's
    share of the resolved pixel (black: this frame alone, white: all history). `disocclusion` is
    red where the point was hidden in the previous frame, green where it was off screen, and blue
    where the history was reset. `clip` shows how far the history lay outside the neighbourhood's
    clip box, white at twice its width.
  - See `packages/render/post/graph/DebugView.ts`. The GUI's Debug folder sets it too, and reloads.
    `s.pipeline.graph.describe()` and `dot()` list the graph.

## Debug flags

- `debug` makes a production page a debug page, as the development server and `profile` do. A
  debug page has the handles on `window` (`__PONLAI__`, `__THREE_GAME_DIAGNOSTICS__`,
  `__PONLAI_WORLD__`), the parked weathers, and the options read on debug pages only (the table
  below marks them).
- `flags=<name>:<value>,...` (debug builds) sets `debugFlags` as the page loads, before anything
  reads them. Values are `true` / `false`, numbers or strings; `mv.<source>` sets a motion vector
  source. For example, use `flags=gtao:false` in a capture's or clip's `--q`. A name alone reads as
  `true` (`flags=lightOnly,ambientOnly`).

## The lighting layer

The lighting layer on its own (`packages/render/debug/LightLayer.ts`, read at load):

- `flags=lightOnly` sets every lit surface's diffuse albedo to 0.5 grey and keeps the specular, so
  the rendered image shows the light a grey card returns at each point. `lightOnly:2` also turns
  the specular off. `grey:<albedo>` sets that grey: `grey:0.18` puts an 18 % grey card everywhere,
  whose display values set the exposure and the tone curve.
- `ambientOnly` removes the key light (the sun or the moon, including its light through the
  vegetation and the feathers) from the lit materials, leaving the sky's light and the ground's
  bounce. It also writes the sea's metering illuminance without its key light term; the sea's
  colour is left as it is. The flags combine: one minus the ratio of the radiance under
  `lightOnly,ambientOnly` to the radiance under `lightOnly` is a point's share of direct light.
- `opaqueVegetation` lights the vegetation as opaque surfaces: no light through a leaf or blade, no
  wrap lighting, and its ambient light not weighted by its translucency. So a plant takes only the
  diffuse light that an opaque card in its place would. It combines with the others.
- `albedoOnly` draws every lit surface unlit in its own diffuse albedo (it overrides the other
  two), so the frame's linear colour at each pixel is the albedo of the surface there.
- `occlusionOnly` (it overrides the other three) draws every lit surface unlit, in grey, in the
  occlusion its ambient diffuse takes: the material's own, the screen-space occlusion where the
  surface receives it, and a plant's root-to-tip occlusion. It shows the open sky the lighting
  uses, where the screen-space occlusion alone misses the turf's roots.
- These flags leave the water, sky, clouds, haze and emission as they are. With them off, the
  shaders and frames are unchanged.
- `bareGround` hides the meadow's blades and lights its turf as bare ground
  (`packages/island/world/Grass.ts` `BARE_GROUND`). Compared with a frame that has the blades, it
  gives the light bare ground takes at the same pixels.
- `classes` draws every lit surface unlit in a colour code for its kind (ground, rock, grass,
  leaves, wood, figure, other: `packages/render/debug/Classes.ts`). `radiance`'s `aov: 'class'`
  decodes it per cell. The sky and the sea are told apart by depth.
  - Emissive surfaces (the yunpeng's glow) spoil their codes and read as no kind, and so does a
    pixel whose samples blend two kinds. So load the page with `aa=off`: under MSAA, the
    alpha-tested leaves partly cover half the island's pixels.
  - The codes are stored at the pre-exposure's scale but never above 2^15, so a page pre-exposed
    past the half float's range (a deep overcast night) still decodes. Past 2^15, the haze and
    emission over the codes keep the pre-exposure's scale, 2^( P - 15 ) times larger than the
    codes, so more hazy cells read as no kind.

## Radiance

`__PONLAI__.radiance` returns the scene's linear radiance over boxes, as numbers
(`packages/render/debug/Radiance.ts`):

```js
await __PONLAI__.radiance( { boxes: { lit: [ x, y, w, h ], ... }, image: [ 3456, 2234 ], grid: [ nx, ny ], source: 'opaque' } )
```

- Boxes are fractions of the frame from its top-left corner, or pixels of an image of size `image`
  (a capture's PNG, with the same boxes `img.py stats` takes). No boxes means the whole frame.
- `source` is `opaque` (the default: the resolved opaque colour, before the sea, the haze and the
  post-processing chain), `hdr` (the composite, with the sea and the atmosphere) or `meterLight`
  (the metering illuminance M).
- Per box: `px`, `rgb` (mean linear), `Y`, `Yp` (10th, 50th and 90th percentile of Y), `oklab`
  ( L, a, b, C, h in degrees) and `range`. `range` gives the half float's limits over the stored
  values: the shares `below` 2^-14 and `above` 65504, `min` and `max`; `nonSky: true` leaves the sky
  out.
- The render targets store radiance pre-exposed, multiplied by 2^P
  (`packages/render/post/PreExposure.ts`). Every value but `range` is in scene units, divided by
  2^P, and `preExposure` is the P (in stops) of the frame read.
- `exposure` is the exposure state (`packages/render/post/Exposure.ts`): `ev` and its `target` in
  stops, the factor `exposure` = 2^ev on scene units, ev's `velocity` in stops a second, and
  `moved`, 1 where that frame's ev differed from the previous frame's.
- `grid` adds the mean colour of each cell of an nx by ny grid (`grid.rgb`, three values per cell,
  row by row).
- Measure under `lightOnly` for the lighting alone.
- Call it from a probe (`--eval "await P.radiance( { boxes: ... } )"`, after `--until "D.settled"`
  or `--frames n`), or from a capture's `-- --eval-ready @file`. The latter runs once the page is
  ready (a capture's `--eval` only sets up the view), and its value lands in the capture's JSON
  (`readyEvals[].value`). Make one call per frame read.

For a script that reads cells:

- `cell: n` averages only the n by n texels at each grid cell's centre, and `boxes: {}` skips the
  boxes.
- `source: 'sharp'` reads the composite with the bloom added (before the local tone mapping and the
  tone curve).
- `aov: 'depth' | 'normal' | 'ao' | 'class'` returns per cell, instead of the radiance, the view
  depth with the sky's and the sea's shares, the world normal, the screen-space occlusion or the
  kind (`packages/render/debug/RadianceAov.ts`).
- `rings: { sun, step, count, sky }` returns the luminance in rings of angle around the sun, before
  and after the bloom, and over the sky's band 30 to 60 degrees from it, with each ring's count of
  sky texels (`skyCounts`). Any light's direction serves as `sun` (the moon's at night).
- `sector: [ from, to ]` keeps the texels in a sector around the light, in degrees: 0 straight
  below it, 90 to its right as seen facing it, 180 above. When from is greater than to, the sector
  wraps through 0.
- `elevation: [ lo, hi ]` keeps the texels whose ray's elevation lies in the range.
- `elevationStep: s` adds `table`: the composite's (hdr) luminance summed over the sky's texels of
  each ring and each band of s degrees of elevation (`[ ring, band, sum, count ]`, band b starting
  at b s - 90 degrees). From it, a script takes each ring's excess over a background that varies
  with elevation, texel by texel, without reading the texels.

## Tunable parameters

Tunable parameters (`packages/render/debug/Tune.ts`) are available on debug pages.

- `__PONLAI__.tune.list()` names every registered number, with its value, default, range, scale,
  and whether it is read at load.
- `tune.set( { name: value } )` sets them with no reload and no new pipeline, and reports a
  combination the code cannot use (`invalid`). A load-time parameter needs `tune=<base64 JSON>` in
  the URL, which applies before the materials build; `tune.query( values )` writes that string.
- `tune.reset()` restores the defaults. At the defaults, a paused frame is byte for byte the frame
  without them.
- A value that the sky's bake reads (a sky or haze tunable, or a field of `pipeline.air.settings`
  that the bake lays over its source) rebakes the sky as a load does, whatever set it: the GUI,
  `tune` or a plain write (`packages/render/sky/SkyRetune.ts`). So the page draws what a fresh load
  with the value draws.

The names, by group. A suffix such as `@high` names a keyframe; the other keyframes follow in
brackets.

- Exposure and local tone mapping:
  - `post.exposure.key@high`: the exposure's key value per sun-height keyframe: `@dusk`,
    `@golden`, `@low`, `@high`, `@cloudy`, `@cloudyGolden`, `@cloudySunset`, `@cloudyDusk`,
    `@cloudyLow`, `@night`, and for the rising sun `@dawn` and `@morningGolden`. `@sunset` shares
    `@golden`'s value.
  - `post.exposure.overcastKey`: overcast's key value over the cloudy one;
    `post.exposure.overcastKeyLow`: the same toward a low sun.
  - The local tone mapping's gain: `post.localTone.hinge@high`, `high`, `low` and `width`, keyed
    the same way.
- Tone curve: `post.tone.midGrey`, `post.tone.blackSlope`, `post.tone.white`.
- Desaturation: `post.desaturate.amount@golden` (`cool`; `@dawn`, `@day`, `@cloudy`, `@night`), and
  the edges of its cool share, `post.desaturate.coolFrom` and `coolTo`.
- Contrast in shadowed areas: `post.shade.pivot@day` and `slope` (`@golden`, `@day`, `@cloudy`,
  `@night`).
- Bloom and glare: the bloom's `post.bloom.strength`, and the sun's glare `post.glare`.
- White balance: `post.white.r@high` (`g`, `b`; `@day`, `@golden`, `@dawn`, `@cloudy`,
  `@overcast`, `@night`).
- Overcast's highlights toward grey: `post.highlight.amount` (`from`, `to`).
- Sky light:
  - The sky's light: `sky.light.r@high` (`g`, `b`; `@low`, `@golden`, `@dusk`, `@morning`, `@dawn`,
    `@cloudyHigh`, `@night`).
  - The clear sky's gain over it: `sky.clear.gain@high` (`@horizon`, `@golden`, `@late`, `@low`,
    and for the rising sun `@dawn`, `@early`, `@morning`).
  - The key light's colour at a low sun: `sky.key.hueDepth` (for the rising sun `dawnHueDepth`),
    `reddens`, `yellows`.
- Atmosphere:
  - The ozone's absorption: `sky.atmosphere.ozone` (its column; per band `ozoneR`, `ozoneG`,
    `ozoneB`).
  - The earth's shadow over the visible sky: `sky.atmosphere.shadowDepth` (the largest share it
    takes) and `shadowSoftness` (the degrees over its edge in which it falls).
  - The floor of the clouds' shadow ratio: `sky.atmosphere.shadowFloor` (the share of the multiple
    scattering that no shadow takes).
  - The distant sea's knee: `sky.sea.knee`. It is the light that reaches the sea, as a share of the
    sun's illuminance, above which the sea's body is lit fully.
- Twilight and night:
  - `sky.twilight.depth.sky`: for each night layer, the stops below its full level from which it
    comes in at -7 degrees after a clear sunset. The layers are `sky` (the night keyframe of the
    sky's light), `ambient`, `stars`, `haze` and `cloudMoon` (the clouds' own moonlight); see
    `packages/render/look/DayLook.ts` `createDayWindows`, `depth`.
  - `sky.twilight.ease`: the degrees at the night end of that window over which the layers ease
    into their full level (its `ease`; 0 brings them in by even stops to the end).
  - Where the moon stands: `sky.moon.elevation` (degrees up, 15 to 40) and `sky.moon.turn` (degrees
    from the noon meridian: 0 on its noon side, 180 on the pole's side, positive toward the west).
  - The stars' sky, as seen from `sky.stars.latitude` degrees south at the sidereal time
    `sky.stars.sidereal` (hours; `packages/render/sky/DayCycle.ts` MOON, STARS).
- A clouded sky's daylight: the level of the whole sky's light by day at a sun 18 degrees up, and
  how it changes with the sun's height, `sky.daySky@overcast` and `sky.daySkyExponent@overcast`
  (`@cloudy`; `packages/render/sky/Weather.ts` `daySkyAt`).
- Lighting:
  - `lighting.keyThroughCloud` (0 to 4): how much of the sunlight that a cloud passes down keeps,
    on the land under it, its direction along the sun, under every sky. Higher values give a
    stronger light from the sun's side and darker cast shadows under cloud
    (`packages/render/look/SkyLook.ts` `keyThroughCloud`).
  - The land's share of the sky's light: `lighting.relight.skyGain@high` (`@low`, `@golden`, and
    for the rising sun `@dawn`, `@sunrise`; `@cloudy`, `@cloudyBlue`, `@night`). The moon's sky has
    its own `lighting.relight.moon.skyGain@low` and `@high`; its golden and cloudy keyframes are the
    day's.
  - `lighting.relight.overcastLand` (1 to 2): the sun's part of the weather's gain under the
    overcast deck, on the land's ambient light, its sky light and the key light's bounce alike. It
    is per unit, not the land's whole light relative to a clear day's. The moon's part is fixed:
    the look's ambient `overcastLand` and `overcastMoonLand` (`packages/render/look/AmbientLook.ts`).
  - A low sun's lift of the sky's light on what it lights: `lighting.relight.lowSun` (stops), with
    its sun heights `lowSunFloor`, `lowSunFloorFull`, `lowSunFrom` and `lowSunTo`
    (`packages/render/lighting/AmbientRelight.ts`).
- Clouds:
  - The cloud model per sky of the weather's blend (`clear`, `fair`, `cloudy`, `overcast`:
    `packages/render/look/SkyLook.ts` `cloudSkies`): the shell's base and top (m), the cloud type
    (0 a stratus, 1 a cumulus), how much it varies from place to place, and how much the clouds
    thin with distance. The names are `sky.clouds.base@<sky>`, `sky.clouds.top@<sky>`,
    `sky.clouds.type@<sky>`, `sky.clouds.spread@<sky>` and `sky.clouds.farFade@<sky>`.
  - The forward lobe of the light under a low cloud layer, in the atmosphere under it (its weight
    and mean cosine): `sky.clouds.forwardWeight`, `sky.clouds.forwardLobe`.
  - How much of that forward light a closed deck spreads by the diffusion law (the weight and mean
    cosine of a lobe whose light on level ground it takes): `sky.clouds.overcastWeight`,
    `sky.clouds.overcastBroad`.
  - The closed deck's glow around the key light, drawn on the sky and its visible panorama: its
    narrow lobe's weight in the deck's mean radiance and its mean cosine, its broad lobe's, and the
    power of the base's own pattern that it follows (`packages/render/sky/SkyDome.ts` `deckGlow`).
    The names are `sky.clouds.deckGlow`, `sky.clouds.deckGlowLobe`, `sky.clouds.deckGlowBroad`,
    `sky.clouds.deckGlowBroadLobe` and `sky.clouds.deckGlowTexture`. They apply by day; the night
    keeps the moon's own form (`packages/render/sky/CloudModel.ts` MOON_DECK_GLOW).
  - The same glow as the lighting's sources take it around the sun, one smooth lobe's mean cosine
    (0.7 to 0.85) and weight (0 to 3): `sky.clouds.bakeGlowLobe`, `sky.clouds.bakeGlowGain`.
  - The closed deck's gradation from the zenith to the horizon by day under overcast, from 0 to 1
    (1 is the diffusion law's 3 : 1, 0 a uniform deck, with level irradiance kept):
    `sky.clouds.deckGradation`.
- Vegetation:
  - The key light that a tree's shaded leaves receive through the leaves above them:
    `lighting.vegetation.leaf.through@high` (`@low`, `@golden`, `@cloudy`, `@night`).
  - How much of the key light on a leaf's far face it transmits:
    `lighting.vegetation.leaf.back@high`, with the same keyframes.
  - The tint under a closed sky of the sward, `lighting.sward.tint.r` (`g`, `b`), and of the tree
    crowns, `lighting.vegetation.leaf.tint.r` (`g`, `b`).
- Sea:
  - The sea's mean reflection over the slopes that no pixel resolves: the spread of those slopes
    `sea.reflection.slopeScale`, and the lift of its sky lobe `sea.reflection.lobeLift`
    (`packages/render/ocean/SlopeLobe.ts` `REFLECTION_LOBE`).
  - `sea.meter.share`: the share of a white card's light that the sea writes into the exposure's
    meter.
  - `sea.slopes.subPixelShare`: the share of the sea's mean square slope held below every pixel
    (the sea look's `subPixelSlope`, `packages/render/ocean/OceanFFT.ts` `slopeBudget`).
- Dusk: `sky.dusk.force.<name>` forces the dusk's shares, to separate the twilight's light from the
  night's. -1, the default, leaves a share as the code computes it; 0 to 1 forces it to that value.
  The twilight's shares are weights on the sun's light. The names and what each one forces are in
  `packages/render/sky/DayCycle.ts` DUSK_FORCES. On debug pages only, `duskShares` holds the values
  the code gave them since a script last cleared it. `tools/island/dusk-grid.mjs` sets and reads
  them.

`renderLook=neutral` (debug pages only) loads the render pipeline with its neutral look instead of
the island's (`packages/render/look/NeutralLook.ts`): gains of 1, no colour grade, no vignette, no
bloom, a clear atmosphere, one exposure keyframe all day, and no night-specific adjustment. The
tunables then start from the neutral values. It shows what the render pipeline does without the
island's values; it is not an image to judge the look by. On a page that is not a debug page, the
island's look loads whatever the option says. The test scenes' page draws with the neutral look by
default, and takes the island's with `renderLook=ponlai` (see The test scenes).

## The test scenes

`scenes.html` is a second page: the render pipeline's small test scenes, built from the render
pipeline alone (`app/scenes/`), with no island and no game. The development server serves it, and
so does a preview the tools start (`tools/kit/serve.mjs`), whose build adds it
(`npm run build -- --mode scenes`). `npm run build` alone builds only the island's page, so what
ships has no test scenes. The page accepts the render pipeline's options from this page (the sky
and weather, `paused`, `t`, `quality`, `aa`, `flags`, `tune.*`, `debug`, `profile`), and none of
the island's or the game's.

- `scene` names the scene. A page without it, or with a name no scene has, shows a message that
  lists the scenes.
  - `ball`: rows of balls by roughness and by albedo, a grey and a white card, and a post on level
    grey ground. It shows how a surface responds to the key light, the sky light and the ground's
    bounce.
  - `empty`: level grey ground under the sky. It shows what the sky and the key light give through
    a day.
  - `sea`: the open sea far from any shore, over a floor 40 m down, with a floating ball and a
    half-sunk one. It shows the water's colour, the far sea against the sky, the sun's glitter,
    and the wind's four levels.
  - `plants`: a patch of a plant kind registered without art of its own, so drawn with the default
    plant, around a post whose shadow falls across it.
- `renderLook=ponlai` (debug pages only) loads the scenes with the island's look instead of the
  render pipeline's neutral one, to compare a scene with the island's own values
  (`docs/reference/look-values.md`).
- The page mounts the same handles as the island's page, on the same pages: `window.__PONLAI__`
  (the render pipeline's parts, `establishScene( query )`, `loop`, `radiance`, `tune`) and
  `window.__THREE_GAME_DIAGNOSTICS__` with its `settled`. `__PONLAI__.scenePage` holds the scene's
  own handles: its `views`, `times` (each a name and the query that loads it) and `readings`,
  `setView( name )`, and `read()`. `read()` returns every reading the frame holds: the scene's
  linear radiance over its box, the exposure, the key light, and the sky's irradiance.
  `tools/render/scenes.mjs` captures and reads them (see its header).

## Ambient light, occlusion and other views

- The ambient grade (`packages/render/lighting/AmbientGrade.ts`): `__PONLAI__.ambient.current`
  holds the five parameters that the table gives for the current sun and weather (also
  `D.ambient`), and `table` holds the table's own output. `override = true` with
  `manual.<parameter>` replaces them from the next frame; the GUI's Ambient folder does the same.
  For example, run
  `--eval "P.ambient.override = true; P.ambient.manual.skyBounce = 0.5"` before a radiance read
  under `lightOnly`.
- The meadow's lighting switches (`packages/render/debug/DebugFlags.ts` lists them all), for A/Bs
  of the look:
  - `flags=meadowShadows:false` turns off the meadow's screen-space shadows
    (`packages/render/post/MeadowShadows.ts`) and their depth pass. `fgview=meadowShadows` shows
    their shadow map.
  - `groundCast:false`, `groundShade:false`, `grassShadow:false`, `grassClumps:false`.
  - `shadowWind:false` makes the plants cast their shadows in their rest pose, and the sun's shadow
    map goes back to its stepped redraws. It is live, so `--toggle "s.flags.shadowWind = on"` times
    the swaying shadows.
  - The meadow's construction, read at load: `grassDensity:<k>` (scales the blades per m^2 over the
    meadow's 125), `grassWidth:<k>`, and `grassLod:true` (the LOD, off by default).
  - `grassMask:true` paints the blades flat red for `img.py stats --cover`
    (`packages/island/world/Grass.ts`). `grassMask:exact` draws them unlit in a red far above any
    radiance, so each pixel's coverage is exact in the opaque colour. `grassMask:albedo` draws them
    unlit in their own diffuse colour. Both are for `tools/island/meadow-light.mjs`.
- The colour grading and display switches:
  - Look adjustments that were taken out come back with `clearShade:true`, `lowSun:true`,
    `tone:0.5` and `filmNight:true`.
  - `localTone:false` builds the display chain without its local tone mapping.
  - `streaks:<n>` scales the amount of cirrus (0 turns it off), and `streakMask:true` paints its
    pixels for `img.py stats --mask` (`packages/render/sky/SkyTrack.ts`, `SkyDome.ts`).
- Exposure: the GUI's `exposure offset (stops)` (Post folder) shifts the metered exposure. Its
  keyframes are the exposure's `keys` (`packages/render/look/ExposureLook.ts` `createExposure`).
  `await __PONLAI__.pipeline.readExposure()` reads its state back from the GPU, with the same fields
  as `radiance`'s `exposure`.
- The colour grade's first lookup table is generated from parameters
  (`packages/render/post/GradeLut.ts`, `s.pipeline.grade`). Set them in the GUI's Grade table folder
  (in Post), or with
  `__PONLAI__.setGrade( { saturation: 1.1, shadows: { tint: [ 0.95, 1, 1.05 ] } } )` from a
  capture's `::js` or a quick variant. The changes are nested as in the grade's own parameters and
  set over them.
- Albedo gains:
  - The meadow's albedo relative to its lawn colour: the GUI's `meadow albedo (x)` or
    `__PONLAI__.setLawnGain( k )`.
  - The cliff's albedo above the water, relative to its stone: `cliff albedo (x)` or
    `__PONLAI__.setRockGain( k )`.
  - The trees' leaves relative to their atlas: `tree leaves albedo (x)` or
    `__PONLAI__.setLeafGain( k )`.
- The tone curve's slope at black, the mid grey it shows and the input that shows as white: the
  GUI's Tone curve folder (in Post), or `s.pipeline.settings.curve`, read every frame
  (`packages/render/look/DisplayLook.ts` `toneCurve`). If the solver cannot meet a set of values,
  it keeps the last good curve and warns; only a failure of the default set throws, on the
  development server.
- The screen-space ambient occlusion (`packages/render/post/GTAO.ts`) is on in the high tier: the
  tier's `ao` setting builds it, and the opaque scene's depth prepass, at load
  (`packages/render/post/OpaquePrepass.ts`).
  - `flags=gtao:false` builds without it, and `flags=gtao` builds with it on another tier.
  - `__PONLAI__.gtao` holds its parameters (cutoff, recede, base, maxTexels, fullDistance).
  - At run time, `flags.gtao = false` skips its passes, and the receivers read 1. So
    `--toggle "s.flags.gtao = on"` times its passes; `--compare` against `?flags=gtao:false` also
    times the depth prepass.
  - `fgview=gtao.r` shows the occlusion the materials read, and `fgview=gtaoRaw.r` the slices'
    occlusion before the blur.
- The local lights (`packages/render/lighting/LocalLights.ts`; at night, the yunpeng's light around
  its clumps):
  - `flags=localLights:0` (or `false`) turns them off, at load or at run time. So
    `--toggle "s.flags.localLights = on"` times their clusters' pass and the materials' lookup, on
    a night view; by day neither runs.
  - `flags=lightTest:N` (at load) adds N white test sources over the meadow, with the range and
    light of stand-in yunpeng clumps (the same on any land), for cost and overflow tests. 64 and
    256 are the usual counts.
  - The GUI's Local lights folder turns them off and sets their artistic gain.
  - `await __PONLAI__.localLights.info()` reads the last pass back: `sources` (in the table),
    `inView` (sorted into the clusters this frame), `fullest` (the most sources touching one
    cluster), `overflowed` (clusters with more than `perCluster` sources, whose farthest are
    dropped), `clusterBytes` and `tableBytes`.
  - `__PONLAI__.localLights.sources` lists every source, and `__PONLAI__.yunpengSites()` lists
    where the yunpeng's clumps stand on the current land (x, z and size per clump), with their
    lights.
  - `node tools/render/verify-local-lights.mjs [seed]` checks the clusters' CPU sort, slices and
    lookup (plain `node`).
- Under the temporal modes, `flags.mv.camera` / `object` = false leaves a source out of the motion
  vectors, and `flags.jitter = false` leaves out the jitter. `s.taaCut( reason )` cuts the history,
  and `s.motionCheck()` lists the materials whose motion vectors are missing or partial.
- `vegPrepass=0` draws the vegetation in a single coverage pass, without its depth prepass.
  `vegPrepass=coverage` keeps the prepass, with coverage kept in the shaded draw.
- `ambientProbes=sky|bounce|irradiance` shows the ambient light's probes (debug pages; also the
  GUI's Ground folder control `ambient probes`; `packages/render/lighting/AmbientVolume.ts`). It
  draws a small unlit sphere at each probe, where the probe was baked, coloured by its spherical
  harmonics at the sphere's normal. `sky` shows the sky visibility, white where a side sees the
  whole sky. `bounce` shows the bounced sky visibility, x8; red marks a probe that is invalid in
  both. `irradiance` shows the relit irradiance divided by pi, the light a white Lambertian face
  would reflect, in the scene's units. The view is built on first show, so a page without it
  compiles nothing for it.
  - The probe lattice from a script: `__PONLAI__.ambientVolume.info()` (origin, dims, spacing,
    probes, bytes) and `await __PONLAI__.ambientVolume.hash()` (the SHA-256 of its bits, the same
    on a grown page as on a fresh load of its land).
  - The relit output (`packages/render/lighting/AmbientRelight.ts`):
    `await __PONLAI__.ambientRelight.readback()` (its texels as floats, with the texture's size)
    and `await __PONLAI__.ambientRelight.hash()` (the SHA-256 of them; the first call builds one
    compute pipeline for the copy).
- The materials' ambient diffuse from the volume (`packages/render/lighting/AmbientSample.ts`, on
  unless set off, read at load):
  - `flags=ambientVolume:0` (or `false`) builds every lit material on the environment's irradiance
    and the whole ground bounce, with the shaders as they were before the volume. It is the A/B of
    the volume, and the byte check against those shaders. The flag cannot switch at run time,
    because the materials' pipelines differ.
  - `flags=groundBounceLand` keeps the ground bounce's land term alongside the volume
    (`packages/render/lighting/GroundBounce.ts`). By default, the volume carries the land's bounce,
    and the ground bounce carries only the sea's.
  - `flags=canopyShade` keeps the bamboo canopy's own shadowing of the sky light alongside the
    volume: the island's and the meadow's baked sky visibility, and the culms'. By default the
    volume carries it, since its probes see the groves. The chunks bake it, so with the flag they
    are generated again, or read from their own cache entries.
  - `flags=ambientVolumeOff:<kinds>` sends the named receivers back to the environment's
    irradiance and leaves the rest unchanged. Separate the names with `/`; `all` names every one.
    The kinds are `terrain`, `stones`, `meadow`, `culms`, `leaves`, `figures`, or else a material's
    name such as `yunpeng` or `fish`. It is only for timing each receiver's read of the volume: the
    chunks' bakes and the ground bounce's land term stay those of the volume path, so a receiver
    sent back looks like neither path. `flags=ambientVolume:0` gives the old path.

## Wind and haze

- `windView` makes the vegetation's wind visible (debug pages only; read at load, so without it no
  shader changes; `packages/render/debug/WindView.ts`). `windView=arrows` or `windView=plants`
  shows one half.
  - Flat unlit arrows every 2 m over the meadow, just above the grass, point where the local wind
    blows, and are longer in a gust. Their brightness shows the wind load on the plants there
    (`plantLoad`).
  - Every plant that bends from its root (the yunpeng, the bamboo; not the meadow's blades) is
    drawn unlit in the colour of its current sway s (tip offset over height). The hue is s's angle
    from the mean wind on a cyclic map: downwind blue, upwind orange, left of the wind
    (counter-clockwise seen from above) magenta, right of it green. The brightness is |s| / 0.15.
  - The numbers behind it: `__PONLAI__.windProbe( options )` (`packages/island/debug/WindProbe.ts`)
    runs the shaders' own wind functions in a compute kernel built on the first call. Per kind of
    plant (`kinds`: `grass`, `bamboo`, `yunpeng`, the last two at their main bend at the top), it
    gives angle histograms, lean and swing, neighbours' correlation, the gust field's size and
    travel, and the sea's gusts against it around the island (`gust.sea`). It also gives the
    plants' wiring, their sway rates, and per weather where every part travels and how fast: the
    plants, the sea and its swell, the open sea's gusts, the fog's drift (`fog`), the cumulus and
    the cirrus streaks. Call it through the probe as
    `--eval "return JSON.stringify( await P.windProbe() )"`.
- The haze (`packages/render/weather/VolumetricHaze.ts`): its parameters are in the GUI's Haze
  folder and in `__PONLAI__.pipeline.air.settings`, read every frame. A change of the slices, the
  jitter or the rest's length also restarts the shadow's rest accumulation.
  - Its `debug: 1` shows the key light's visibility in the froxel at each pixel's depth (a grey card
    in that light: mid grey where lit, black where shadowed). That is the shadow the light shafts
    are cut from.
  - Its `readings( height, from?, to? )` gives the medium's numbers without a capture: green's
    extinction at a height, each band's sigma, a horizontal view's RGB transmittance over 1 and
    3 km and the distance over which its luminance halves, and the transmittance between two points
    (example below).

  ```bash
  --eval "const c = P.camera.position, t = P.land.target; return P.pipeline.air.readings( c.y, c, { x: t[ 0 ], y: t[ 1 ], z: t[ 2 ] } )"
  ```

## Islanders

- `islander` selects the islanders' proportions. The default is the look's own: `real` for the
  Hanming look. The others are `stock` (the character kit's own), and the `subtle`, `medium` and
  `strong` builds of `Proportions.ts`. The GUI's Islander folder sets it too, and rebuilds the
  scene's walker in place. In game mode, the folder's proportion control is disabled: the game's
  islanders take their build from the URL option as they load, so a change applies on the next
  load.
- `body` gives the scene's walker (Hanming look) a sex and an age: `M30` (a man of 30, the
  default), `F6` (a girl of six). An age under 2 is drawn as a two-year-old
  (`packages/island/characters/Ages.ts`). The GUI's Islander folder sets both: a new sex dresses
  the walker again, and a new age prepares its body in idle time and puts it on in one frame
  (`FigureAge.ts`). In game mode, both are disabled.
- `bodies` starts a new game with islanders of these sexes and ages instead of the simulation's
  three (a man, a woman and one of either, 20 to 35 years old): `bodies=F28,M75,M6`. A resumed
  save keeps its own (add `new` to start over). They age a year per game day from there.

## Profiling

- `profile` (`?profile`, or `?profile=frames` without GPU timestamps) loads
  `packages/render/debug/FrameProfiler.ts`. It labels every render and compute pass, reads their
  GPU timestamps and exposes `window.__PONLAI_PROFILE__`. Without it, the app builds the same
  pipelines and renders the same image. Its JavaScript times leave out the time blocked in
  `queue.submit`, the queue writes and `getCurrentTexture` (Chrome's backpressure once the GPU
  falls behind), which are reported separately.

## Game

- `game` runs the island as a game.
- `hour` sets the start hour (default 8).
- `dayLength` sets the real seconds per game day at 1x (default 1440: 24 minutes).
- `paused` starts the game paused; the scene runs again once the game does.
- `load` resumes the game saved in this browser. Its world is loaded at the save's piece count
  unless `grow` is given.
- `new` starts a new game, which replaces the save when it first saves.
- `autosave=on|off` sets whether the page keeps the save itself, resuming it as it loads and saving
  every minute and when the page is hidden or left. It is on by default, and off in an automated
  browser, so that a capture or a check neither resumes a game left in its browser profile nor
  leaves one. `load` resumes the save whatever `autosave` says (`packages/game/save.ts`).
- `lang` sets the interface's language: `zh-CN`, the default, or `en`, a snapshot whose missing
  words show in Chinese (`packages/game/ui/i18n/`).
- The app's own `weather` option and the automatic weather work in the game as they do without it.
- The player's interface, its parts and its keys: [Game UI](../design/ui.md)
  (`packages/game/ui/GameUi.ts`).
  - Choosing the chest in the build bar arms its placement in the scene: a ring on the turf
    previews the spot (green, or red with the reason in the bar), and a click places it
    (`packages/game/Placement.ts`).
  - Space pauses only the game clock. The GUI's hour, clock pause and time preset are off, since the
    game's clock owns the time of day.
- The GUI's Game folder (`packages/game/GameDebug.ts`) pauses and resumes, saves, loads and starts
  a new game (`saved`: when the game was last saved, and whether autosave is on). It shows one
  islander's body (position, the action under way, whether a thought is in progress) and sends it
  walking to the next click on the island.
  - Its Growth subfolder shows the population against the next growth step and adds an islander:
    one piece per 2 islanders above 3, so the island grows at 5 islanders.
  - Its Interface subfolder shows the states the game does not reach yet: "many rows (x3)" (the
    build roster three times over, more resource kinds than the row shows in full), "placeholder
    days" (nine days in the record), "hearing agent" (hears the player, thinks for a few seconds
    with the heard words circling, and answers with a placeholder line), a line said by the
    inspected islander, their needs low or critical, and the language (reloads the page with
    `lang`).
  - The stand-in agent (`packages/game/sim/standin.ts`) thinks for the islander by default.
- `window.__PONLAI__.game` is the Game object for the console:
  - `.sim`; `act( id, calls )`: tool calls for an islander, `[ { tool, args } ]`, the five actions,
    through the same entry point as an agent's answer; `listen( fn )`: the simulation's events as
    they come; `setAgent( agent )`: kept across a load, `null` leaves the islander idle.
  - `think( id )`, `walkTo( id, x, z )`, and `placeBlueprint( kind, x, z )`: a building of a kind,
    `'chest'`, any number of them, each with an id such as `chest1`; it returns the reason it
    cannot, or null.
  - `focus( id )`, `setPaused`, `togglePause`, `addIslander()`, `save` and `load` (a save of
    another piece count loads only with the page), `startOver()` (a new game on the island shown),
    `autosave()` (the page's save, skipped when nothing changed), `.keeps` and `.savedAt`.
  - `speak( words, ids | 'all' )`: the player's words, into the record and to an agent that hears;
    it returns the reason it cannot, or null. `say( id, words )`, `setNeed( id, need, value )`,
    `forecast( hours )` (the weather's changes, in game hours), `.record` (the record's entries)
    and `.ui` (`setMany( true )`).
  - `.sim.comingLand` holds the next piece's cells once the page has them.

## Every option

The app reads its options through one entry point, `packages/render/Settings.ts`. Each layer
declares its own options there or beside its code, each with what it takes and its default: the
render pipeline in `packages/render/Settings.ts`, the island in `packages/island/IslandSettings.ts`,
the game in `packages/game/GameSettings.ts`, and the app in `app/AppSettings.ts`, which merges the
four. A project that uses the render pipeline alone reads only the render pipeline's options. The
table's Owner column is the layer whose table declares the option. The entry point parses the
address once. It warns in the console, as `[settings] ?name=value: why`, about each option that no
layer declared and each value outside what its reader distinguishes; the app then goes on as it
would without the warning. This table is written from the declarations
(`node tools/repo/verify-settings.mjs --write`; `npm run check` runs it without `--write` to keep
the two equal).

<!-- every-option:start (written by tools/repo/verify-settings.mjs --write) -->

| Option | Takes | Without it | Owner | What it sets |
| --- | --- | --- | --- | --- |
| `paused` | named (its value unread) | running | render | pauses the scene and both clocks; with it the page is in the test mode |
| `t` | a number from 0 | 0 | render | the scene time (s) |
| `dpr` | a number from 0 | the display's ratio, capped | render | pins the canvas's pixel ratio |
| `hour` | a number | golden-hour (8 under `game`) | render | the hour of the day |
| `preset` | `dawn`, `sunrise`, `noon`, `golden-hour`, `sunset`, `dusk`, `midnight` | golden-hour | render | the hour by its sun |
| `dayLength` | a number from 30 | 2880 (1440 under `game`) | render | seconds per day |
| `moon` | a number | 0.5 | render | the moon's phase (0.5 full) |
| `clock` | `paused` | running | render | `paused`: freezes the day clock only |
| `weather` | `clear`, `fair`, `cloudy`, `overcast`, `rain`, `storm`, `fog` | auto, from fair | render | holds this weather (the parked ones on debug pages only) |
| `wind` | `light`, `gentle`, `fresh`, `strong` | the sky's | render | the wind's level; holds the weather |
| `windDir` | a number | the sky's (40) | render | the wind's heading (degrees); holds the weather |
| `clouds` | a number, 0 to 1 | the weather's | render | overrides the cloud coverage |
| `dayFog` | named (its value unread) | off | render | the day's fog layer under a clear or fair sky |
| `seaFog` | named (its value unread) | off | render | the deep sea fog |
| `quality` | `low`, `medium`, `high` | high | render | the quality tier (medium and low parked) |
| `aa` | `msaa`, `taa`, `taau`, `fsr3`, `off`, `gt` | the tier's (high: msaa) | render | the anti-aliasing mode (`gt` on debug pages only) |
| `msaa` | `1`, `2`, `4` | none | render | the older alias of `aa`: `4` msaa, `1` and `2` off |
| `fsrDebug` | named (its value unread) | off | render | FSR 3's debug view over its output, under `aa=fsr3` (debug pages only) |
| `taaResolve` | `off` | on | render | `off`: the temporal modes without their resolve (debug pages only) |
| `post` | a comma list of `legacy`, `inline-composite`, `three-fsr`, `store-scene` | none | render | the frame graph without the first performance round's changes |
| `gpuTimer` | `off` | on | render | `off`: the dynamic resolution without its timestamp queries |
| `drsStore` | `on`, `off` | on, off in an automated browser | render | whether the dynamic resolution starts from the scale it last held |
| `frameRate` | a number from 0, or `auto` | auto | render | the frame rate the loop holds (0: every refresh) |
| `frameFallback` | `0` | on | render | `0`: `auto` keeps the tier's rate |
| `submits` | `each` | batched | render | `each`: three's own submit per pass |
| `submitBatch` | a comma list | SubmitBatch.ts's | render | the submit batching's policy: `hold,wait,idle` |
| `fgOps` | `derived`, `legacy`, `store`, `off` | derived | render | the frame graph's attachment ops |
| `fgPrime` | `0` | on | render | `0`: the warm-up renders nothing ahead |
| `fgview` | text | off | render | the frame graph's debug view of one resource (debug pages only) |
| `debug` | named (its value unread) | off | render | a debug page: the handles on `window`, the debug options |
| `flags` | a comma list | none | render | sets debug flags as the page loads (`name:value,...`) (debug pages only) |
| `tune` | text | none | render | tunable parameters' values before anything builds (base64 JSON) (debug pages only) |
| `testMode` | `0` | on with `paused` | render | `0`: a paused page outside the test mode |
| `profile` | named bare, `frames` | off | render | loads the frame profiler (`frames`: without GPU timestamps) |
| `vegPrepass` | `0`, `coverage` | on | render | the vegetation's depth prepass: off, or with coverage kept |
| `ambientProbes` | `off`, `sky`, `bounce`, `irradiance` | off | render | shows the ambient light's probes (debug pages only) |
| `windView` | named bare, `arrows`, `plants` | off | render | makes the vegetation's wind visible (debug pages only) |
| `cameraInput` | `on`, `off`, named bare | on | island | `off`: the hand does not move the island camera; named bare, as `on` |
| `seed` | a whole number | 1 | island | the world's seed |
| `grow` | a whole number from 0 | the save's pieces under `game`, else 0 | island | growth steps after the starting island (up to `GROWTH.maxSteps`) |
| `worldCache` | `on`, `off`, `0`, named bare | on | island | `off` or `0`: generates every chunk instead of reading the browser's cache |
| `bamboo` | a comma list | the default groves | island | another look of the bamboo: `cover,height` |
| `wenyao` | named (its value unread) | off | island | shows the wenyao, the schools of flying fish off the island (parked) |
| `approach` | a number, 0 to 1 | 0 | island | the progress toward the next piece, its shoal put on at once |
| `terrainHex` | `0` | on | island | `0`: the cliff's plain triplanar tiling |
| `chunkBorders` | named (its value unread) | off | island | shows the world's chunks as lines |
| `islander` | `stock`, `subtle`, `medium`, `strong`, `real` | the look's own | island | the islanders' proportions |
| `body` | text | M30 | island | the scene's walker's sex and age |
| `bodies` | a comma list | the simulation's three | game | a new game's islanders' sexes and ages |
| `load` | named (its value unread) | off | game | resumes the saved game |
| `new` | named (its value unread) | off | game | starts a new game |
| `autosave` | `on`, `off` | on, off in an automated browser | game | whether the app keeps the save itself |
| `lang` | text | zh-CN | game | the interface's language (`zh-CN`, `en`) |
| `polar` | a number | 40 | app | the island view's tilt (degrees) |
| `az` | a number | 180 | app | the island view's heading (degrees) |
| `dist` | a number from 0 | frames the land | app | the island view's distance from the default pivot (m) |
| `gui` | named (its value unread) | hidden | app | shows the GUI |
| `camera` | `orbit`, `free` | orbit | app | the island camera or the free flight |
| `nearFov` | a number, 1 to 179, or `off` | 42 | app | the island view's fov at its closest zoom (degrees; `off`: 27 at every distance) |
| `nearFovFrom` | a number from 0 | 50 | app | the distance the fov widens from (m) |
| `soil` | `0`, `1` | on | app | `0`: the ground without its soil layer |
| `autoQuality` | `detect`, `off` | parked | app | the GPU timing that chose the tier (parked: read by the tier's reload only) |
| `autoQualitySlow` | a number from 0.01 | 1 | app | scales the GPU timing's measured time (parked) |
| `renderLook` | `neutral`, `ponlai` | the app's own | app | the look the render pipeline draws with, over the app's own: `neutral` (the render pipeline's) on the island's page, `ponlai` (the island's) on the test scenes' (debug pages only) |
| `scene` | `ball`, `empty`, `sea`, `plants` | none | app | the test scene `scenes.html` shows |
| `game` | named (its value unread) | off | app | the island as a game |
| `tier.<setting>` | text | the tier's | render | overrides one setting of the tier (`tier.post.hazeGrid.width=128`) |

<!-- every-option:end -->
