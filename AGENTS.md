# Soomi

A small stylised island in an open sea, rendered in the browser: a visual sample for a game.
The look is stylised fantasy-realistic: warm golden light, airy lifted shadows, deep muted
teal water with a sparkling glare toward the sun, chunky chiselled stone, a lush meadow with bushes
and wildflowers, and irregular hanging leaf clusters around the rim. Keep the lower cliff stone
exposed.

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
  override), `quality` (low, medium, high).
  In the page, H toggles the GUI, Space pauses, and R or 1/2/3 jump to the island, horizon and
  sky views.
- Other tools: `tools/verify-*.mjs` are GPU regression probes for the sky, lighting, shadows, water
  and wave optics (each file names the server it expects); `tools/verify-scene.mjs` checks a
  production preview; `tools/benchmark-lighting.mjs` A/B-times two builds;
  `tools/compare-captures.py` measures two overview captures (needs Pillow and NumPy).
  `tools/verify-day-cycle.mjs`, `verify-weather-state.mjs` and `verify-wind.mjs` are CPU-only
  (plain `node`). Run GPU probes one at a time with no other page rendering the scene.

## Layout

- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__SOOMI__` (scene
  handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug`.
- `src/world/`: the island generated in a Web Worker (SDF shapes → surface nets), sea floor,
  shoreline field, vegetation anchors; instanced grass, bushes and flowers on the island top,
  with top-rooted overhanging branches of mixed lengths.
- `src/shared.ts`: uniforms shared by the water, terrain and vegetation (sun, sky, water level).
- `src/lighting/`: sun radiometry, soft solar shadows, the sun refracted below the water surface,
  the air/water optical interface, baked local sky occlusion, and the meadow's light through its
  own canopy.
- `src/materials/`: procedural detail textures, terrain materials (triplanar stone, moss, turf,
  sea floor, light under the water).
- `src/ocean/`: FFT ocean (compute), waves against the rock boundary, caustics, water shading.
- `src/sky/`: atmosphere LUTs, environment lighting, volumetric clouds after tidewater's port of
  the Three.js Sky Pro clouds (a cloud shell 4 - 9 km up shaped by a procedural weather map and the
  64^3 shape noise in `public/clouds/`, loaded by `src/materials/CloudNoise.ts`; traced in screen
  space a sixteenth of the pixels per frame with a reprojected history, plus a panorama map for
  reflections and the environment, and a cloud-shadow map), high cirrus (fibres baked in `Cirrus.ts`), rain curtains under
  raining clouds, the day cycle (sun and moon), stars, Milky Way and moon, rainbows, weather
  presets, their blending and the auto-weather chain.
- `src/weather/`: wind, lightning, puddles, rain (a streak veil in the post pass, world-space streaks, ripples),
  distant air (aerial perspective) and sea fog (a low layer drifting in banks, plus morning mist).
- `src/post/`: frame graph (opaque pass, depth resolve, water pass, crepuscular rays and sun
  glare, bloom, tilt-shift, grade).
- `src/characters/`: the islanders. Low-poly modular figures (one shared rig and its animation
  clips) assembled from parts, repainted in the island's palette as vertex colours and merged into
  one skinned mesh; a stepped light model lit by the scene's sun and sky; a small moving sun-shadow
  map multiplied into the island's static one. While the character art is settled, models load from the
  git-ignored `artifacts/assets/` (dev server only).

## Decisions (keep to these)

- Keep the island tile layout and flat central plateau. Natural contour, slope and weathering
  variation belongs to the outer rim and cliffs. Offshore stones remain submerged and form
  patchy seabed detail; no exposed sea stacks or reefs.
- Keep plants and meadow cover rooted on the island top. Branches may hang from top shrubs and meadow
  around the upper rim, with uneven density and mixed lengths; avoid plants rooted on cliff faces.
- Grass blades do not cast into the sun's shadow map (they are narrower than a texel and flicker as
  the sun moves); the meadow shades itself and its turf through `MeadowCanopy`. Larger casters keep
  the map, which redraws whenever the key light moves.
- The sea is calm in everyday weather: no shore foam or whitecaps. Only a storm's gale builds a
  rough sea with whitecaps on folding crests. Weather only scales the wave cascades' amplitude;
  it never rebuilds the wave spectrum.
- One dominant key light (sun by day, moon by night) drives terrain, characters, water, caustics
  and every shadow map; sun/moon handoffs pass through zero direct light. The day cycle is
  authored, not astronomical. The sun and moon are drawn at twice their true size (equal to each
  other); shadows and glints use the true sun. The sky, sun, moon, stars, key light and grade follow the clock
  every frame; only the reflection panorama, environment and irradiance cross-fade between bakes.
- The sea continues to the horizon (a skirt around the wave grid); the camera's far plane and
  the sky-depth thresholds (`-9e4`; the resolved sky is `-1e5`) stay beyond it.
- The tilt-shift blur belongs to the island's surroundings and eases off kilometres out: a blurred
  sky reads as a low backdrop and turns stars into bokeh discs. Stars are points with a natural
  spread of brightness, kept below white except the brightest few; only those near the horizon
  scintillate.
- One cloud field feeds the visible sky, water reflections, environment lighting and cloud
  shadows. Bad weather dims and desaturates the existing light; it never adds a grey screen veil.
  Distant air applies only beyond the protected foreground; sea fog is a low height-fog layer
  that may surround the island, never a uniform tint. Weather changes sweep the sky as a
  front from upwind; the island's lighting follows the front's progress over the island.
- The directly seen clouds accumulate over frames; a scene at rest (paused clock, still camera)
  settles its clouds once and keeps them, so a paused frame is exactly repeatable. The cloud
  march assumes a camera below the cloud base.
- Rain is light streaks plus analytic ripples on the water normal. Wetness darkens exposed rock
  and plants within small limits, glosses bare stone, persists after rain and leaves the tidal
  band alone. Standing water fills fixed hollows on level ground as the ground soaks, drowning
  the lower meadow blades, and shrinks as it dries.
- Characters are simple low-poly figures with flat colours and simple faces, recoloured into the
  island's palette and lit by the island's own light in soft cel steps; no outlines. Plants and
  props keep their realistic shading.
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
- Multisampled depth can only be read with `textureLoad`; `Pipeline` resolves it to linear view z.
- WebGPU needs uniform control flow for implicitly filtered texture samples and derivatives: take
  them (`.toVar()`) before any `If` / `Loop`; inside branches and loops use `.level()` or `textureLoad`.
- Nested loops: pass both ranges to one `Loop()` call so the counters get distinct names (`i`, `j`).
- Shadow passes keep `alphaTest` and `alphaMap` but not `map`: alpha-tested foliage sets both `map`
  and `alphaMap`.
- Vegetation draws before the terrain (`renderOrder = -1`) so the turf under it fails the depth test.
