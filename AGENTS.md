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
  (orbit, the default, or free: fly with the mouse, WASD, Q/E and Shift). It needs
  Playwright's Chromium once (`npx playwright install chromium`), or `CHROME_PATH` set to a
  WebGPU-capable Chrome.
- Sky and weather URL options: `hour`, `preset` (dawn, sunrise, noon, golden-hour, sunset, dusk,
  midnight), `dayLength` (seconds), `moon` (phase), `clock=paused` (freezes only the day clock;
  `paused` freezes it with the scene), `weather` (clear, fair, cloudy, overcast, rain, storm, fog; rain and storm load
  as established, already wet; without it the weather evolves on its own), `clouds` (coverage
  override), `quality` (low, medium, high: the clouds' march, bake cadences and rain count, and
  the render scale, see Decisions), `tone` (neutral-hue, the default, agx-hue, agx, neutral), `look`
  (soft-fantasy, the default, rich-fantasy, realistic).
  In the page, H toggles the GUI, Space pauses, and R or 1/2/3 jump to the island, horizon and
  sky views.
- Other tools: `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows, water
  and wave optics (each file names the server it expects); `tools/verify-scene.mjs` checks a
  production preview; `tools/benchmark-lighting.mjs` A/B-times two builds;
  `tools/compare-captures.py` measures two overview captures (needs Pillow and NumPy);
  `tools/build-moon-textures.py` rebuilds the moon's textures from NASA's CGI Moon Kit
  (`uv run --with pillow --with numpy`). `tools/build-star-catalog.mjs` and
  `tools/build-milky-way.py` rebuild the night sky's data in `public/sky/` from the raw catalogue
  and map (each file says where to get them and how to run it).
  `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs` and `verify-wind.mjs` are CPU-only
  (plain `node`). Run GPU probes one at a time with no other page rendering the scene.

## Layout

- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__SOOMI__` (scene
  handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug`.
- `src/world/`: the island generated in a Web Worker (SDF shapes → surface nets; the cliff band
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
  from its own seed and merged into one mesh (`Plants.ts`, sited by `PlantSites.ts`).
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation (sun, sky, water level).
- `src/lighting/`: sun radiometry, soft solar shadows, the sun refracted below the water surface,
  the air/water optical interface, baked local sky occlusion, and the meadow's light through its
  own canopy.
- `src/materials/`: procedural detail textures, terrain materials (triplanar stone with per-block
  shade, strata, parting seams, runoff stains, upper-cliff moss and a spray zone, turf, sea floor,
  light under the water), wet surfaces after Lagarde (soaked pores, water film, runnels down the
  cliffs).
- `src/ocean/`: FFT ocean (compute), waves against the rock boundary, caustics, water shading, and
  the storm sea (`StormSea.ts`: whitecap foam integrated on a world grid around the view, the
  procedural foam pattern, spray particles).
- `src/sky/`: atmosphere LUTs, environment lighting, volumetric clouds after tidewater's port of
  the Three.js Sky Pro clouds (a cloud shell 4 - 9 km up shaped by a procedural weather map and the
  64^3 shape noise in `public/clouds/`, loaded by `src/materials/CloudNoise.ts`; traced in screen
  space a sixteenth of the pixels per frame with a reprojected history, plus a panorama map for
  reflections and the environment, and a cloud-shadow map), high cirrus (fibres baked in `Cirrus.ts`), rain curtains under
  raining clouds and showers (marched along the view ray, leaning with the wind) with the rainbows
  in their sunlit rain (colours from `RainbowTable.data.ts`, generated by
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
  drifting banks of varying height, thinner over the island, plus morning mist).
- `src/post/`: frame graph (opaque pass, depth resolve and a copy of the opaque colour, the water
  and rain drawn into the same multisampled target, crepuscular rays and sun glare, bloom,
  tilt-shift, tone curve and grade, the art-directed look, FSR 1 upscale), render scale per quality preset
  (`RenderScale.ts`).
- `src/characters/`: the islanders. Low-poly modular figures (one shared rig and its animation
  clips) assembled from parts, repainted in the island's palette as vertex colours and merged into
  one skinned mesh; a stepped light model lit by the scene's sun and sky; a small moving sun-shadow
  map multiplied into the island's. While the character art is settled, models load from the
  git-ignored `artifacts/assets/` (dev server only).

## Decisions (keep to these)

- Keep the island tile layout and flat central plateau. Natural contour, slope and weathering
  variation belongs to the outer rim and cliffs. Offshore stones remain submerged and form
  patchy seabed detail; no exposed sea stacks or reefs.
- The island must be able to grow by more tiles, so everything generated for it is generic: the
  cliffs, the shelf and its stones, the rim greenery and the planting derive from the footprint,
  the island's SDF and noise fields with fixed seeds (hashes of position, or random streams that
  draw a fixed count per vegetation anchor), never from coordinates placed by hand, and their
  counts follow the measured coast length or meadow area. Any tile layout then builds itself the
  same way.
- Cliff features (rockfall scars, joint faces, pockets, steps in the lip, gullies, the notch)
  derive from the footprint with seeds hashed from position in world-anchored cells (`Cliff.ts`),
  and an unchanged stretch of coast keeps its scars when the layout grows elsewhere: every
  property of a scar comes from its own hash, never from a running count, and each generation is
  cut into the surface the larger ones left. The wall is built as solid geometry: convex blocks
  bounded by two regional joint sets (both oblique to the tile edges), bed partings and inclined
  fractures are subtracted from a battered face, so its field stays a true distance and the
  facets stay flat up to crisp edges. It must read as natural rock, never masonry: no level
  courses or evenly spaced joints. Scar floors and roofs lie on a parting only some of the time,
  partings and soft beds open over a few metres and pinch out, pockets are shallower than they
  are wide, and under the meadow the wall weathers back to an upper slope rather than jutting as
  a slab. The wave-cut notch comes and goes with the coast's exposure and its roof stays above the
  calm sea's crests; the joint faces run on below the sea, so no ledge follows the waterline. The
  weathering relief fades out at the meadow, whose height stays `islandSurfaceHeight`. Steps where
  a block fell from the lip stop below the meadow's planting height (2.8 m) and carry no turf. No
  waterfalls. Moss and greenery on the wall stay in its upper 1.2 m.
- Around the island, the shelf's width and depth, the talus at the cliff foot, its shallow benches
  and the fallen blocks on it follow the footprint's distance, the island's SDF and world-space
  noise. The floor off the island stays below -1.6 m and every stone crown below -1.30 m, so
  nothing breaks the surface. Fallen blocks are walked out from the coast until their traced
  outline clears the island's solid, so they rest against the cliff's underwater toe wherever it
  runs; other stones keep a wider berth.
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
  their own random stream (the rim bushes' stream also places the rim trails), sway with the rim
  bushes' wind, cast into the sun's map and stop the rain. A limb casts whole or not at all: limbs
  that leave their parent 3 cm or more in radius cast; thinner twigs, shrub stems and stalks do
  not. Around their stems the turf, grass and flowers lose ambient light (baked on the CPU into the
  island's occlusion and the anchors' sky visibility), so they stand in the meadow rather than on
  it.
- Grass blades do not cast into the sun's shadow map (they are narrower than a texel and flicker as
  the sun moves); the meadow shades itself and its turf through `MeadowCanopy`. Stems, leaf stalks
  and twigs (a few millimetres across) stay out of it too. The map is fitted to the island's
  casters (the sea floor's stones cast only into the refracted map) and redrawn each time the key
  light has turned 0.2 degrees; every receiver cross-fades from the previous step's map by the
  light's progress (`SunShadow`), so shadows move smoothly instead of re-rasterising every frame,
  and a paused clock holds them exactly. On screen a blade is kept at least two pixels wide (0.75
  on the outer rim, where partly covered pixels show a pale fringe over the sea) with its coverage
  lowered to match through alpha to coverage, so the meadow does not crawl as the camera moves;
  close up the blades render unchanged.
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
  reflection panorama, environment and irradiance cross-fade between bakes.
- The exposure only rises from afternoon into night and holds from the end of the blue hour (about
  -7 degrees) on, higher than the night sky was tuned for, so the island reads by moonlight and
  starlight. The night ambient rises as the sun's skylight fades after sunset, so twilight is
  never darker than the night; the night sky's own light (stars, airglow, moon disk, the sky's
  night floor, clouds) scales back to keep its tuned look in deep night.
- The scene renders at a pixel ratio set by the quality preset (high: the display's, up to 1.5;
  medium, the default: a 1920x1080 pixel budget; low: 1600x900); `dpr` and the GUI's full
  resolution lift the budget. The canvas always matches the display (up to 2x): a render below
  it is upscaled inside the frame graph with FSR 1 and the grain added after, never stretched by
  the browser. Every pass is sized to the render, not the canvas (`rtt()` passes through
  `sizeRtt`). At the display's ratio nothing is upscaled, so `dpr=1` captures are unchanged.
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
  never a uniform tint. Weather changes sweep the sky as a front from upwind; the island's
  lighting follows the front's progress over the island.
- The directly seen clouds accumulate over frames; a scene at rest (paused clock, still camera)
  settles its clouds once and keeps them, so a paused frame is exactly repeatable. The cloud
  march assumes a camera below the cloud base.
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
- Characters are simple low-poly figures with flat colours and simple faces, recoloured into the
  island's palette and lit by the island's own light in soft cel steps; no outlines. Plants and
  props keep their realistic shading. The islanders are a Hylian-like people (after The Legend of
  Zelda: Breath of the Wild): human in every way but for long pointed ears that sweep back and a
  little up, grown on any head of the kit (`Ears.ts`) and bound to its head bone. Their dress stays
  plain while the basic look settles: undyed linen and calm earthy tones, leather shoes, no hat.
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
- Measure frame time at 2400x1500 (DPR 1.5) with background tabs closed, before and after a change.
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
  goes in its level argument); `Pipeline` resolves it to linear view z.
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
  one array texture for this reason).
