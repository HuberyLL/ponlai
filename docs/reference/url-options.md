# URL options

The page's URL options, by group, with the debug views and console handles that go with them.
The tools that load pages with these options: [Tools](tools.md).

## View and capture

- `paused`, `t` (scene time), `dpr` (render pixel ratio, pinned), `polar`, `az` (the island
  view's tilt and heading, 40 and 180 degrees by default), `dist` (m; without it the island view
  frames the land and its shallows, IslandFraming.ts, brought in to where it frames the land alone
  from its heading when that framing stands farther; with it the camera stands that far from the
  default pivot), `cameraInput=off` (the hand does not move the island camera: on by default),
  `gui`, `camera` (`orbit`, the default: the island camera; or `free`: fly with the mouse, WASD, Q/E
  and Shift). The island view's fov widens as it closes in: `nearFov` (degrees at the closest zoom,
  42 by default; `off` keeps 27 at every distance) and `nearFovFrom` (the distance in m it widens
  from, 50 by default); the GUI's Camera folder has the same three controls.
  A paused page lifts its loading screen at once, without the fade, so a capture of a paused frame
  never catches the screen over it.

## The island

- `seed` (the world's seed, 1 by default: Ponlai's island) and `grow` (growth steps after the
  starting island, 0 by default, up to `GROWTH.maxSteps`). The page generates its world from that
  land in 16 m chunks and frames its views on it; debug pages expose `window.__PONLAI__.land`
  (`seed`, `step`, `bounds`, `centroid`, the views' `scale` against the first island and the default
  pivot `target`) for the tools to frame by, which follows the island as it grows.
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

## Sky and weather

- `hour`, `preset` (each the hour its sun stands at its elevation, on the 52 degree path: dawn,
  -8.6 degrees in the morning; sunrise, 2; noon, 52 at 12; golden-hour, 26.2 in the afternoon, the
  default; sunset, 2; dusk, -8.6; midnight, -52 at 0: `src/sky/DayCycle.ts` DAY_PRESETS),
  `dayLength` (seconds), `moon` (phase: 0.5, a full moon, by default; it shapes only the drawn
  moon, which stands fixed in the sky), `clock=paused` (freezes only the day clock; `paused` freezes
  it with the scene).
- `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load as established,
  already wet; without it, `wind` and `windDir` the weather and its wind evolve on their own, among
  the kept presets), `clouds` (coverage override).
- `dayFog`: the day's fog layer under a clear or fair sky (off by default; the GUI's Weather
  folder, `day fog`). Its fields tune as `haze.fog.<field>@<day|golden|mist>`
  (`src/weather/HazeKeys.ts`).
- `seaFog`: the deep sea fog, a switch beside the weather under any sky and at any hour (off by
  default; the GUI's Weather folder, `sea fog`). Its fields tune as `haze.fog.<field>@sea`
  (`src/weather/HazeKeys.ts` SEA_FOG).
- `wind` (light, gentle, fresh, strong: the wind's level, a mean wind 10 m up of 1.5, 3.8, 7 and
  11 m/s) and `windDir` (its heading in degrees: where the wind comes from, in the sea spectrum's
  convention, atan2( z, x ) in the world's x-z plane; 40 is the prevailing wind, which the
  landscape and the sea's swell keep; the wind sea turns with it), each over the sky's own wind (the
  gentle one from 40 for every kept sky, so `weather=fair` alone is the page it always was). Naming
  either holds the weather, as `weather` does; both are scene options. On a page, the GUI's Weather
  folder (`wind`, `wind heading`, over its transition seconds) or `__PONLAI__.setWind( { level,
  heading }, seconds )`; `weather.windTarget` and the diagnostics' `windTarget`, `windSpeed` and
  `windHeading` show it (`src/sky/Weather.ts`). Rain, storm and fog are parked (`src/sky/Weather.ts`
  `PARKED_WEATHER`): a production page without `?debug` refuses them with a console warning and
  shows fair; the dev server, `?debug` and `?profile` still reach them.

## Quality, anti-aliasing and the frame

- `quality` (low, medium, high: the tier of every knob in `src/Quality.ts`; without it high, the
  only active tier: medium and low are parked, see `docs/reference/tools.md`, Parked quality
  tiers), `tier.<knob>=<value>`
  overrides one knob for an A/B (e.g. `tier.post.hazeGrid.width=128`). The GPU timing that once
  chose the tier (`src/QualityDetect.ts`, `autoQuality`) is parked with them.

Rendering and A/B options, read at load (runtime switches for one-page A/Bs live in
`src/debug/DebugFlags.ts`):

- `aa` (the anti-aliasing mode, `src/post/Antialiasing.ts`, over the tier's `aa` knob: each tier
  has its default, high `msaa` (the parked medium `taau`, low `msaa`), and the GUI's Antialiasing
  control reloads with any of MSAA 4x, TAAU, FSR 3.1, TAA and Off. `msaa`: 4 samples, upscaled by
  FSR 1; `off`: one sample; `taa` and `taau`, the temporal modes: one sample, jittered, with motion
  vectors, resolved against a history in `TemporalAA.ts`, at the
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
  renders it until the rest has converged; `tools/capture-clip.mjs --aa gt [--gt-jitters n]`
  captures it that way, and so does a clip of one frame (`--clip rest`) under `aa=taa|taau` (their
  own rest sequence). After `loop.step`, `loop.start()` resumes the clock with a first delta of at
  most one frame.
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
- `post=legacy` (or a comma list of `inline-composite`, `three-fsr`, `store-scene`: the frame graph
  without the first performance round's changes).
- `gpuTimer=off` (high's dynamic resolution without its timestamp queries: it then steers by the
  frame intervals).
- `drsStore=on|off` (whether high starts from the render scale it last held, kept in localStorage
  per tier, AA mode, frame rate, canvas size and GPU, and saves the scale it holds: on by default,
  off in an automated browser so a profile or capture does not start where the last run ended;
  `on` tests a returning load there, `off` neither restores nor saves anywhere).
- `frameRate=auto|<fps>` (the frame rate the loop holds on a faster display: `auto`, the default,
  holds the tier's and falls back to the next whole divisor of the refresh, e.g. 72 -> 48 fps on
  144 Hz, when the dynamic scale's floor cannot hold it, `src/post/FramePacer.ts`; a number is a
  cap, the fastest whole-divisor rate not above it, without the fallback; `frameRate=0` renders on
  every refresh, as the profiler's uncapped runs do). `frameFallback=0` keeps `auto` at the tier's
  rate (profile-frame adds it on `--compare` and `--accept`; `--frame-fallback` keeps the fallback
  on). A scene jump (`establishScene`) leaves the fallback, as a fresh load starts at the held rate.
  In a debug page, `__PONLAI__.pacer.choices()` lists the display's even rates, `setRate( fps |
  'auto' )` sets one, `mode` and `rate` read the choice and `fps` the rate held now (a production
  `?game` settings menu needs the game to be handed the pacer: not wired yet); the diagnostics'
  `pacing` block shows `mode`, `fallback`, `falls` and `returns`, and for the test mode's paused
  pages `queueLimit` (the frames they may keep queued on the GPU), `queued` (how many are now) and
  `held` (how many due frames waited for the queue).
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

## Debug flags

- `flags=<name>:<value>,...` (debug builds: sets `debugFlags` as the page loads, before anything
  reads them; values `true` / `false`, numbers or strings, `mv.<source>` a motion source), e.g.
  `flags=taaClampDrop:false` for a capture's or clip's `--q`. A name alone reads as `true`
  (`flags=lightOnly,ambientOnly`).

## The lighting layer

- The lighting layer on its own (`src/debug/LightLayer.ts`, read at load): `flags=lightOnly` makes
  every lit surface's diffuse albedo 0.5 grey, specular kept, so the image is the light a grey card
  returns there; `lightOnly:2` also turns the specular off; `grey:<albedo>` sets that grey
  (`grey:0.18`: an 18 % grey card everywhere, whose screen code values set the exposure and the
  tone curve); `ambientOnly` takes the key light (the
  sun or the moon, with the vegetation's and the feathers' light through them) out of the lit
  materials, leaving the sky's light and the ground's bounce, and writes the sea's metering
  illuminance without its key term (the sea's colour is left as it is). They combine: one minus the
  radiance under `lightOnly,ambientOnly` over that under `lightOnly` is a point's share of direct
  light. `opaqueVegetation` lights the vegetation as opaque surfaces (no light through a leaf or
  blade, no wrap, its ambient unweighted by its translucency), so a plant takes only the diffuse
  light an opaque card in its place would; it combines with the others.
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
  (the cut-out leaves cover half the island's pixels in part under MSAA). The codes are stored at
  the pre-exposure's scale but never above 2^15, so a page pre-exposed past half float's range (a
  deep overcast night) still decodes; past 2^15 the haze and emission over the codes keep the
  pre-exposure's scale, 2^( P - 15 ) times larger beside them, so more hazy cells read as no kind.

## Radiance

- The scene's linear radiance over boxes, as numbers (`src/debug/Radiance.ts`): `await
  __PONLAI__.radiance( { boxes: { lit: [ x, y, w, h ], ... }, image: [ 3456, 2234 ], grid: [ nx, ny
  ], source: 'opaque' } )`. Boxes are fractions of the frame from its top-left, or pixels of an
  image of size `image` (a capture's PNG, the boxes `img.py stats` takes); none means the whole
  frame. `source` is `opaque` (the default: the resolved opaque colour, before the sea, the haze and
  the post chain), `hdr` (the composite, with the sea and the air) or `meterLight` (the metering
  illuminance M). Per box: `px`, `rgb` (mean linear), `Y`, `Yp` (10th, 50th, 90th percentile of Y),
  `oklab` ( L, a, b, C, h in degrees) and `range` (the half float's limits over the stored values:
  the shares `below` 2^-14 and `above` 65504, `min`, `max`; `nonSky: true` leaves the sky out).
  The targets store radiance pre-exposed, times 2^P (`src/post/PreExposure.ts`): every value but
  `range` is in scene units, divided by 2^P, and `preExposure` is the P (stops) of the frame read.
  `exposure` is the exposure state (`ev` and its `target` in stops, the
  factor `exposure` = 2^ev on scene units, ev's `velocity` in stops a second and `moved`, 1 where
  that frame's ev differed from the frame's before: `src/post/Exposure.ts`); `grid` adds the mean
  colour of each cell of an nx by ny grid (`grid.rgb`, three per cell, row by row). Measure under
  `lightOnly` for the light alone. From a probe (`--eval "await P.radiance( { boxes: ... } )"`,
  after `--until "D.settled"` or `--frames n`) or from a capture's `-- --eval-ready @file`, which
  runs once the page is ready (a capture's `--eval` only sets the view up) and whose value lands in
  the capture's JSON (`readyEvals[].value`); one call per frame read.
  For a script that reads cells: `cell: n` averages only the n by n texels at each grid cell's
  centre and `boxes: {}` skips the boxes; `source: 'sharp'` reads the composite with the bloom added
  (before the local tone and the tone curve); `aov: 'depth' | 'normal' | 'ao' | 'class'` returns
  per cell, instead of the radiance, the view depth with the sky's and the sea's shares, the world
  normal, the screen-space occlusion or the kind (`src/debug/RadianceAov.ts`); `rings: { sun, step,
  count, sky }` the luminance in rings of angle around the sun before and after the bloom, and over
  the sky's band 30 to 60 degrees from it, with each ring's count of sky texels (`skyCounts`); any
  light's direction serves as `sun` (the moon's by night). `sector: [ from, to ]` keeps the texels
  in a sector about the light (degrees, 0 straight below it, 90 to its right as seen facing it, 180
  above; from over to wraps through 0), `elevation: [ lo, hi ]` those whose ray's elevation lies in
  the range, and `elevationStep: s` adds `table`, the composite's (hdr) luminance summed over the
  sky's texels of each ring and band of s degrees of elevation ( [ ring, band, sum, count ], band b
  from b s - 90 degrees), from which a script takes each ring's excess over a background that varies
  with elevation, texel by texel, without reading the texels.

## Tunable parameters

- Tunable parameters (`src/debug/Tune.ts`, debug pages): `__PONLAI__.tune.list()` names every
  registered number (its value, default, range, scale, and whether it is read at load),
  `tune.set( { name: value } )` sets them with no reload and no new pipeline (a load-time one needs
  `tune=<base64 JSON>` in the URL, which applies before the materials build; `tune.query( values )`
  writes it) and reports a combination the code cannot use (`invalid`), `tune.reset()` restores the
  defaults. At the defaults a paused frame is byte for byte the frame without them. A value the
  sky's bake reads (a sky or haze tunable, or a field of `pipeline.air.settings` the bake lays
  over its source) rebakes it as the load bakes, whatever set it (the GUI, `tune`, a plain write:
  `src/sky/SkyRetune.ts`), so the page draws what a fresh load with the value draws. Names:
  `post.exposure.key@high` (an exposure key per sun height, `@dusk`, `@golden`, `@low`, `@high`,
  `@cloudy`, `@cloudyGolden`, `@cloudySunset`, `@cloudyDusk`, `@cloudyLow`, `@night`, and the
  rising sun's `@dawn`, `@morningGolden`; `@sunset` shares `@golden`'s; overcast's key over the
  clouded one `post.exposure.overcastKey`, toward a low sun `post.exposure.overcastKeyLow`; the
  local gain's `post.localTone.hinge@high`, `high`, `low`, `width` alike), `post.tone.midGrey`,
  `post.tone.blackSlope`, `post.tone.white`; the desaturation's `post.desaturate.amount@golden`
  (`cool`; `@dawn`, `@day`, `@cloudy`, `@night`) and its cool share's `post.desaturate.coolFrom`,
  `coolTo`; the shade's contrast `post.shade.pivot@day`, `slope`
  (`@golden`, `@day`, `@cloudy`, `@night`), the bloom's `post.bloom.strength` and the sun's glare
  `post.glare`; the display's white `post.white.r@high` (`g`, `b`; `@day`, `@golden`, `@dawn`,
  `@cloudy`, `@overcast`, `@night`), overcast's highlights toward grey `post.highlight.amount`
  (`from`, `to`), the sky's light `sky.light.r@high` (`g`, `b`; `@low`, `@golden`, `@dusk`,
  `@morning`, `@dawn`, `@cloudyHigh`, `@night`) and the clear sky's gain over it
  `sky.clear.gain@high` (`@horizon`, `@golden`, `@late`, `@low`, the rising sun's `@dawn`, `@early`,
  `@morning`), the key's colour at a low sun `sky.key.hueDepth` (the rising sun's `dawnHueDepth`),
  `reddens`, `yellows`, the ozone's absorption `sky.atmosphere.ozone` (its column; per band
  `ozoneR`, `ozoneG`, `ozoneB`), the earth's shadow over the seen sky `sky.atmosphere.shadowDepth`
  (the share it takes at most; `shadowSoftness`, the degrees over its edge in which it falls) and
  the floor of the clouds' shadow ratio `sky.atmosphere.shadowFloor` (the multiple scattering's
  share no shadow takes), the distant sea's knee `sky.sea.knee` (the light that reaches the sea, as
  a share of the sun's illuminance, above which its body is lit fully), the stops under all of it
  each night layer comes in from at -7 degrees after a clear sunset `sky.twilight.depth.sky` (the
  sky's night key; `ambient`; `stars`; `haze`; `cloudMoon`, the clouds' own moonlight:
  `src/sky/DayCycle.ts` DUSK_DEPTH) and the
  degrees at the night's end of that window over which they ease into all of it `sky.twilight.ease`
  (DUSK_EASE; 0 takes them in by even stops to the end), where the moon stands
  `sky.moon.elevation` (degrees up, 15 to 40) and `sky.moon.turn` (degrees from the noon meridian:
  0 its noon side, 180 the pole's, positive toward the west), and the stars' sky, the one seen
  from `sky.stars.latitude` degrees south at the sidereal time `sky.stars.sidereal` (hours:
  `src/sky/DayCycle.ts` MOON, STARS), a clouded sky's floor of the key on the land under its deck
  `sky.deckFloor@overcast` (`@cloudy`) and its day sky, the level of the whole sky's light by day at
  a sun 18 degrees up and how it goes with the sun's height, `sky.daySky@overcast`,
  `sky.daySkyExponent@overcast` (`@cloudy`:
  `src/sky/Weather.ts` `daySkyAt`), the key's gain on that floor under overcast's deck
  `lighting.overcastKey` (under a cloudy deck's, `lighting.cloudyKey`: `src/sky/Sky.ts`
  OVERCAST_KEY_GAIN), and the land's share of the sky's light `lighting.relight.skyGain@high`
  (`@low`, `@golden`, the rising sun's `@dawn`, `@sunrise`, `@cloudy`, `@cloudyBlue`, `@night`; the
  moon's sky's own `lighting.relight.moon.skyGain@low` and `@high`, its golden and cloudy keys the
  day's), the sun's part of the weather's gain under overcast's deck on the land's ambient light,
  its sky light and the key's bounce alike (per unit, not the land's whole light over a clear day's;
  the moon's part is fixed: `src/lighting/AmbientGrade.ts` OVERCAST_LAND, OVERCAST_MOON_LAND)
  `lighting.relight.overcastLand` (1 to 2), a low
  sun's lift of the sky's light on what it lights `lighting.relight.lowSun` (stops; `lowSunFloor`,
  `lowSunFloorFull`, `lowSunFrom`, `lowSunTo` its sun heights: `src/lighting/AmbientRelight.ts`),
  the clouds' model per kept sky (`clear`, `fair`, `cloudy`, `overcast`: `src/sky/Sky.ts`
  CLOUD_SKIES), the shell's base and top (m), the cloud type (0 a stratus, 1 a cumulus), how far
  it varies from place to place and how far the clouds thin with distance
  `sky.clouds.base@<sky>`, `sky.clouds.top@<sky>`, `sky.clouds.type@<sky>`,
  `sky.clouds.spread@<sky>`, `sky.clouds.farFade@<sky>`, the forward lobe of the light under a low
  layer, in the air under it (its weight and mean cosine) `sky.clouds.forwardWeight`,
  `sky.clouds.forwardLobe`, the amount of that forward light a closed deck spreads by the
  diffusion law (a lobe's weight and mean cosine whose light on level ground it takes)
  `sky.clouds.overcastWeight`, `sky.clouds.overcastBroad`, the closed deck's glow about the key
  light drawn on the sky and its
  seen panorama (its narrow lobe's weight in the deck's mean radiance and mean cosine, its broad
  lobe's, and the power of the base's own pattern it follows: `src/sky/Sky.ts` `deckGlow`)
  `sky.clouds.deckGlow`, `sky.clouds.deckGlowLobe`, `sky.clouds.deckGlowBroad`,
  `sky.clouds.deckGlowBroadLobe`, `sky.clouds.deckGlowTexture` (by day; the night keeps the moon's
  own form, `src/sky/Clouds.ts` MOON_DECK_GLOW), the same glow as the lighting's sources take it
  about the sun, one smooth lobe's mean cosine (0.7 to 0.85) and weight (0 to 3)
  `sky.clouds.bakeGlowLobe`, `sky.clouds.bakeGlowGain`, and the closed deck's gradation from the
  zenith to the horizon by day under overcast
  (0 to 1: 1 the diffusion law's 3 : 1, 0 a uniform deck, level irradiance kept)
  `sky.clouds.deckGradation`, and the key a tree's shaded leaves
  take through the leaves over them `lighting.vegetation.leaf.through@high` (`@low`, `@golden`,
  `@cloudy`, `@night`) and what a leaf sends on of the key on its far face,
  `lighting.vegetation.leaf.back@high` alike, the sward's tint under a closed sky
  `lighting.sward.tint.r` (`g`, `b`) and the crowns', `lighting.vegetation.leaf.tint.r` (`g`, `b`);
  the sea's mean reflection over the slopes no pixel resolves, the spread of those slopes
  `sea.reflection.slopeScale` and the lift of its sky lobe `sea.reflection.lobeLift`
  (`src/ocean/Water.ts` `REFLECTION_LOBE`), and the share of a white card's light the sea writes
  into the exposure's meter, `sea.meter.share`; and the dusk's shares, forced to take the twilight's
  light and the night's apart, `sky.dusk.force.<name>` (-1, the default, leaves a share as the code
  makes it, 0 to 1 forces it to that value; the twilight's are weights on the sun's light; the names
  and what each one forces: `src/sky/DayCycle.ts` DUSK_FORCES, the values the code gave them since
  a script cleared it, on debug pages only: `duskShares`; `tools/dusk-grid.mjs` sets and reads
  them).

## Ambient light, occlusion and other views

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
  make at load: `grassDensity:<k>` (blades per m^2 over the meadow's 125), `grassWidth:<k>`,
  `grassLod:false`, and `grassMask:true`, which paints the blades flat red for `img.py stats
  --cover` (`src/world/Grass.ts`), or `grassMask:exact`, which draws them unlit in a red far above
  any radiance, so each pixel's cover is exact in the opaque colour, or `grassMask:albedo`, unlit in
  their own diffuse colour (both for `tools/meadow-light.mjs`); the look taken off
  comes back by `clearShade:true`, `lowSun:true`, `tone:0.5`, `filmNight:true`; `localTone:false`
  builds the display chain without its local tone mapping; `streaks:<n>` scales the thin cloud
  layer's amount (0 turns it off) and `streakMask:true` paints its pixels for `img.py stats --mask`
  (`src/sky/Sky.ts`). The metered exposure is shifted by the
  GUI's `exposure offset (stops)` (Post folder); its keys are `src/post/Exposure.ts`
  `EXPOSURE_KEYS`, and `await __PONLAI__.pipeline.readExposure()` reads its state back from the GPU
  (the same fields as `radiance`'s `exposure`). The grade's
  first table is generated from parameters
  (`src/post/GradeLut.ts`, `s.pipeline.grade`): the GUI's Grade table folder (in Post), or
  `__PONLAI__.setGrade( { saturation: 1.1, shadows: { tint: [ 0.95, 1, 1.05 ] } } )` from a
  capture's `::js` or a quick variant (the changes nested as the grade's own, set over it). The
  meadow's albedo against its lawn colour: the GUI's `meadow albedo (x)` or `__PONLAI__.setLawnGain(
  k )`; the cliff's above the water against its stone: `cliff albedo (x)` or
  `__PONLAI__.setRockGain( k )`;
  the trees' leaves against their atlas: `tree leaves albedo (x)` or `__PONLAI__.setLeafGain( k )`.
  The tone curve's slope at black, the mid grey it shows and the input that shows white: the GUI's
  Tone curve folder (in Post), or `s.pipeline.settings.curve` (read every frame;
  `src/post/ToneCurve.ts` TONE_CURVE; a set the solve cannot meet keeps the last good curve and
  warns, and only the default set failing throws, on the dev server).
  `fgview=meadowShade` shows the shade's map.
- The screen-space ambient occlusion (`src/post/GTAO.ts`, on in high: the tier's `ao` knob builds it
  and the opaque scene's depth prepass at load, `src/world/OpaquePrepass.ts`): `flags=gtao:false`
  builds without it, `flags=gtao` with it on another tier; `__PONLAI__.gtao` holds its knobs
  (cutoff, recede, base, maxTexels, fullDistance). At run time
  `flags.gtao = false` skips its passes and the receivers read 1 (`--toggle "s.flags.gtao = on"`
  times its passes; `--compare` against `?flags=gtao:false` the depth prepass too). `fgview=gtao.r`
  shows the occlusion the materials read, `fgview=gtaoRaw.r` the slices' before the blur.
- The local lights (`src/lighting/LocalLights.ts`: by night the yunpeng's light round its clumps):
  `flags=localLights:0` (or `false`) turns them off, at load or at run time, so
  `--toggle "s.flags.localLights = on"` times their clusters' pass and the materials' lookup (on
  a night view: by day neither runs). `flags=lightTest:N` (at load) adds N white test sources
  over the meadow, with the range and light of stand-in yunpeng clumps (the same on any land), for
  cost and overflow tests (64 and 256 are the usual loads). The GUI's Local lights folder turns them
  off and sets their art gain; `await __PONLAI__.localLights.info()` reads the last pass back:
  `sources` (in the table), `inView` (sorted into the clusters this frame), `fullest` (the most
  sources touching one cluster), `overflowed` (clusters with more than `perCluster`, whose farthest
  are dropped), `clusterBytes` and `tableBytes`; `__PONLAI__.localLights.sources` lists every
  source, and `__PONLAI__.yunpengSites()` where the yunpeng's clumps stand on the current land ( x,
  z, size per clump) with their lights. `node tools/verify-local-lights.mjs [seed]` checks the
  clusters' CPU sort, slices and lookup (plain `node`).
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

## Wind and haze

- `windView` makes the vegetation's wind visible (debug pages only; read at load, so without it
  no shader changes; `src/debug/WindView.ts`): flat unlit arrows every 2 m over the meadow, just
  above the grass, point where the local wind blows, longer in a gust, and their brightness
  shows the load the plants take there (`plantLoad`); and every plant that bends from its root
  (the yunpeng, the bamboo; not the meadow's blades) is drawn unlit in the colour of its current
  sway s (tip offset over height): the hue is s's angle from the mean wind on a cyclic map (downwind
  blue, upwind orange, left of the wind, counter-clockwise seen from above, magenta, right of it
  green), the brightness |s| / 0.15. `windView=arrows` or `windView=plants` shows one half. The
  numbers behind it: `__PONLAI__.windProbe( options )` (`src/debug/WindProbe.ts`: the shaders' own
  wind functions in a compute kernel built on the first call; per kind of plant (`kinds`: `grass`,
  `bamboo`, `yunpeng`, the last two their main bend at the top) angle histograms, lean and swing,
  neighbours' correlation, the gust field's size and travel, the sea's gusts against it around the
  island (`gust.sea`), the plants' wiring, their sway
  rates, and per weather where every part travels and how fast: the plants, the sea and its
  swell, the open sea's gusts, the air's displacement (`fog`), the cumulus and the thin layer's
  streaks), through the probe as `--eval "return JSON.stringify( await P.windProbe() )"`.
- The haze (`src/weather/VolumetricHaze.ts`): its knobs are the GUI's Haze folder and
  `__PONLAI__.pipeline.air.settings` (read every frame; a change of the slices, the jitter or the
  rest's length also restarts the shadow's rest); its
  `debug: 1` shows the key light's visibility in the froxel at each pixel's depth (a grey card in
  that light: mid grey lit, black shadowed), the shadow the shafts are cut from. Its
  `readings( height, from?, to? )` gives the medium's numbers without a capture: green's
  extinction at a height, each band's sigma, a horizontal view's RGB transmittance over 1 and 3 km
  and the distance its luminance halves in, and the transmittance between two points (probe below).

  ```bash
  --eval "const c = P.camera.position, t = P.land.target; return P.pipeline.air.readings( c.y, c, { x: t[ 0 ], y: t[ 1 ], z: t[ 2 ] } )"
  ```

## Islanders

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

## Profiling

- `profile` (`?profile`, or `?profile=frames` without GPU timestamps) loads
  `src/debug/FrameProfiler.ts`, which labels every render and compute pass, reads their GPU
  timestamps and exposes `window.__PONLAI_PROFILE__`; without it the page builds the same
  pipelines and image. Its JS times leave out the time blocked in `queue.submit`, the queue writes
  and `getCurrentTexture` (Chrome's backpressure once the GPU falls behind), reported apart.

## Game

- `game` (the island as a game), `hour` (the start hour, default 8), `dayLength` (real seconds
  per game day at 1x, default 1440: 24 minutes), `paused` (the game starts paused; the scene runs
  again once the game does), `load` (resume the game saved in this browser, its world loaded at the
  save's piece count unless `grow` is given), `new` (start a new game, which replaces the save at
  its first save), `autosave=on|off` (whether the page keeps the save itself, resuming it as it
  loads and saving every minute and when the page is hidden or left: on by default, off in an
  automated browser so a capture or a check neither resumes a game left in its profile nor leaves
  one; `load` resumes whatever it says; `src/game/save.ts`), `lang` (the interface's language:
  `zh-CN`, the default, or `en`, a snapshot whose missing words show in Chinese:
  `src/game/ui/i18n/`). The page's own `weather` option and auto weather work in the game as without
  it.
- The player's interface is 蜃光 (`src/game/ui/GameUi.ts`, its spec `docs/explanation/ui.md`): the top
  row (day and time, pause and play, the weather now and the next 24 game hours read ahead from the
  auto chain, the island's resources, the record's scroll), a click on an islander for their tag and
  ring (again, or on open ground, lets go; Esc too), the speak bar (Enter opens it and sends; the
  words fly to the islander selected, or to everyone in view), the build bar (the mallet at the
  bottom right; groups, buildings, `/` to search, 1-9 to choose, the arrows to scroll, Esc and
  Enter) and the record (沧海录: the scroll; Esc, the arrows). Choosing the chest in the build bar
  arms its placement in the scene: a ring on the turf previews the spot (green, or red with the
  reason in the bar), a click places it (`src/game/Placement.ts`). Space pauses only the game
  clock, the GUI's hour, clock pause and time preset are off (the game's clock owns the time of
  day), and its Game folder (`src/game/GameDebug.ts`) pauses and resumes, saves, loads and
  starts a new game (`saved`: when the game was last saved, and whether autosave is on), shows one
  islander's body (position, the action under way, whether a thought is in flight) and sends it
  walking to the next click on the island; its Growth subfolder shows the population against the
  next step and adds an islander (one piece per 2 islanders above 3: the island grows at 5
  islanders). Its Interface subfolder shows the states the game does not reach yet: "many rows" (the
  build roster three times over, more resource kinds than the row shows whole), "placeholder days"
  (nine days in the record), "hearing brain" (hears the player, thinks a few seconds with the heard
  words circling, answers a placeholder line), a line said by the inspected islander, their
  needs low or critical, and the language (reloads the page with `lang`). The stand-in brain
  (`src/game/sim/standin.ts`) thinks for the islander
  by default. `window.__PONLAI__.game` is the Game for the console: `.sim`, `act( id, calls )` (tool
  calls for an islander, `[ { tool, args } ]`: the five actions, through the entrance a brain's
  answer takes), `listen( fn )` (the simulation's events as they come), `setBrain( brain )` (kept
  across a load; `null` leaves the islander idle),
  `think( id )`, `walkTo( id, x, z )`, `placeBlueprint( kind, x, z )` (a building of a kind,
  `'chest'`, any number, each with an id like `chest1`; returns why not, or null), `focus( id )`,
  `setPaused`, `togglePause`, `addIslander()`, `save` and `load` (a save of another piece count
  loads only with the page), `startOver()` (a new game on the island shown), `autosave()` (the
  page's save: skipped when nothing changed), `.keeps` and `.savedAt`,
  `speak( words, ids | 'all' )` (the player's words: into the record, and to a brain that hears;
  returns why not, or null), `say( id, words )`, `setNeed( id, need, value )`, `forecast( hours )`
  (the weather's turns, in game hours), `.record` (the record's entries) and `.ui` (`setMany( true
  )`); `.sim.comingLand` holds the next piece's cells once the page has it.
