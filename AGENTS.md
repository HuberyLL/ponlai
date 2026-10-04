# Soomi

A small stylised island in an open sea, rendered in the browser: a visual sample for a game.
The look is stylised fantasy-realistic: warm golden light, airy lifted shadows, deep muted
teal water with a sparkling glare toward the sun, chunky chiselled stone, a lush meadow with bushes,
wildflowers, with irregular hanging leaf clusters distributed around the rim. Keep the lower cliff stone exposed.

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
  frame diagnostics. URL options: `paused`, `t`, `dpr`, `dist`, `polar`, `az`, `gui`. It needs
  Playwright's Chromium once (`npx playwright install chromium`), or `CHROME_PATH` set to a
  WebGPU-capable Chrome.

## Layout

- `src/main.ts`: renderer, camera, sun, GUI, frame loop, diagnostics. `window.__SOOMI__` (scene
  handles) and `window.__THREE_GAME_DIAGNOSTICS__` exist only on the dev server or with `?debug`.
- `src/world/`: the island generated in a Web Worker (SDF shapes → surface nets), sea floor,
  shoreline field, vegetation anchors; instanced grass, bushes and flowers on the island top,
  with top-rooted overhanging branches of mixed lengths.
- `src/materials/`: procedural detail textures, terrain materials (triplanar stone, moss, turf,
  sea floor, light under the water).
- `src/ocean/`: FFT ocean (compute), caustics, water shading.
- `src/sky/`: atmosphere bake, environment lighting.
- `src/post/`: frame graph (opaque pass, depth resolve, water pass, bloom, tilt-shift, grade).

## Decisions (keep to these)

- No clouds, mist or aerial haze. No waterfall or pond.
- Keep the island tile layout and flat central plateau. Natural contour, slope and weathering
  variation belongs to the outer rim and cliffs. Offshore stones remain submerged and form
  patchy seabed detail; no exposed sea stacks or reefs.
- Keep plants and meadow cover rooted on the island top. Branches may hang from top shrubs and meadow
  around the upper rim, with uneven density and mixed lengths; avoid plants rooted on cliff faces.
- No glowing rings at the bases of the sea stacks.
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
