# Ponlai

A physically based render pipeline for the browser, on three.js WebGPU, shown on a small island in
an open sea (features and usage: `README.md`). The island is calm and painterly, lit naturally by
the sun and the sky (deep clear water, chunky stone, a lush meadow that moves in the wind); the page
at `/` is the game, and `?review` opens the art-review scene the tools render.

## Where things are written

- A module's rules and their reasons are in its header comment (partly: `verify-headers`). Read it
  before you change the module; update it when the behaviour changes.
- `ARCHITECTURE.md` describes the structure. Read it before a structural change; update it when a
  change adds a layer, moves what a layer owns or changes a flow. The architecture rules in full:
  `docs/reference/architecture-rules.md`.
- Each text has one home: decisions in `docs/design/` (art in the page about its subject), facts in
  `docs/reference/` (look values in `look-values.md`, URL options in `url-options.md`) and module
  headers, one task's steps in the README of the folder it changes. `docs/README.md` lists every
  page. `AGENTS.md`, `ARCHITECTURE.md`, `CREDITS.md` and `README.md` stay at the top. This file
  changes for a rule every change follows, the reading index or the folders; a layer's `AGENTS.md`,
  for a rule of that layer alone.
- Write each fact or rule in one place and link to it from other pages. Docs state the current
  state; what was tried and dropped goes in the commit message. Prose follows the Google developer
  documentation style guide (<https://developers.google.com/style>).

## Stack and commands

- TypeScript (strict), Vite, three.js `WebGPURenderer` (`three/webgpu`, `three/tsl`). WebGPU is
  required; without it, the page shows a message.
- `npm run dev` (port 5190), `build` (type-checks, then bundles), `typecheck`, `preview` (port
  5191), `lint` (the code lint). `npm run check` runs what every commit passes, in seconds, without
  a GPU (`tools/check.mjs`); `-- --full` adds the build and the world's chunks. `npm run lint:docs`
  checks Markdown, offline links, docs paths and the rules files' shape; `lint:links` adds web
  links. In-page keys: `docs/reference/debug-handles-and-keys.md`.

## Tools

- Each tool's manual is its header (a README beside a tool documents its folder), indexed by
  question in `docs/reference/tools.md`. Look for a tool before you write a script; if one almost
  fits, add an option to it; never a Pillow, NumPy or Playwright script of your own. Most changes
  use `tools/kit/serve.mjs` (a worktree's server), `kit/capture.mjs`, `kit/parity/capture-set.mjs`
  (views on one loaded page, not a loop), `kit/img.py` (`uv run`), `kit/probe.mjs`,
  `render/wgsl-build.mjs`, `render/profile-frame.mjs`, `repo/assets.mjs` and
  `tools/**/verify-*.mjs`.
- Never start a GPU tool to see its options: it queues for the lock and renders. `--help` prints its
  manual and starts nothing.
- A script needed a second time, or by another task, becomes a tool. A truly one-off script stays in
  the task's artifacts folder and runs through `node tools/kit/qos.mjs <command>`.
- Everything that renders the scene in a browser takes the GPU lock
  (`node tools/kit/gpu-lock.mjs run [--shared] -- <command>`): timing runs hold it alone, paused
  captures and probes share it.
- Every wait goes through `tools/kit/job.mjs`, never a sleep loop. Before an agent hands back, it
  stops its jobs with `job.mjs stop <log>`.

## Skills

Each is `skills/<name>/SKILL.md`, with this project's facts in `docs/bindings/<name>.md`:
building-cinematic-stylised-realism (the look, materials), diagnosing-nondeterministic-frames
(frames that differ by run), diagnosing-visual-defects (faults on screen),
fitting-a-look-to-reference-images (lighting, atmosphere, post-processing),
measuring-performance-changes (speed, frame time), verifying-rendering-changes (rendering changes),
writing-docs-and-skills (docs, rules, skills), writing-tools-and-checks (tools and checks),
writing-tsl-and-passes (TSL, passes, GPU buffers).

## Rules for every change

- Lookdev and lighting are kept strictly apart (`docs/design/art-direction.md`, How the look is
  made). A new material follows the building skill and its binding's Materials section.
- Simulation and generation are deterministic and path-independent: the world, its growth, the
  weather, the wind and every integrated state are functions of the land, seeds, scene clock and
  weather, never of the path or the thread count. After a growth swap or a scene jump, the page
  holds what a fresh load holds (`ARCHITECTURE.md`, rule 4).
- Code that changes the scene reads the scene clock or its step, never the wall clock; the
  exceptions are in rule 17 (partly: `ponlai/scene-clock`).
- A scene jump clears a history-dependent effect; the effect converges on a still scene or the test
  mode freezes it or turns it off, and it is compared within a tolerance (rule 4).
- The test mode is a paused page under MSAA and captured once `settled` is true. A paused frame is
  bit-identical between runs and equals a fresh load's frame, except in the sea reflection's held
  region, compared within `HELD`. A new history-dependent effect keeps `settled` false until
  converged and obeys the test mode's switch (`docs/reference/test-mode.md`).
- What is generated for the island or fitted to the land derives from the land's footprint, the
  island's SDF and fixed-seed fields, never from hand-placed coordinates. Counts scale with the
  coast or the area (rule 5).
- Changes hold in the kept weathers (clear, fair) on every quality preset (high, medium, low), judged
  on high at 4K output (1920x1080 CSS px, DPR 2); the default checks name high, a preset's own runs
  name it (`--quality`). Parked weathers (`sky/Weather.ts` `PARKED_WEATHER`) need no support but keep
  compiling and loading by name; default checks skip them.
- Changes are judged against the high tier's performance target: 4K output at 60 fps with MSAA 4x,
  about 14 ms of GPU time a frame at the baseline (`Quality.ts`; `docs/reference/profile-frame.md`).
  A quality tier or a graphics option (`packages/render/GraphicsOptions.ts`) changes the cost, never
  the mood (weather, clock, lighting). High is the reference tier, the top preset and every module's
  default. Load-time settings are read once at load, so changing the tier or a reload option reloads
  the page.
- A URL option is declared in the settings table of the lowest layer that reads it, and read only
  through `Settings.ts`'s reader (rule 14; partly: `verify-settings`, `verify-layers`). The render
  pipeline, the island and the game's rules never touch browser globals; the app layer passes in
  what they need (rule 13).
- Licences follow REUSE: third-party code opens with a `/*! ... */` notice (source, SPDX copyright
  and licence tags), each licence's text in `LICENSES/`. `CREDITS.md` lists the sources whose
  licence asks for a notice or credit, assets included; a technique, a paper or public-domain code
  is credited in a comment where used. No reference images in git, no unlicensed third-party art.
- No assets in git: what the app loads lives in the git-ignored `public/`, loads through
  `import.meta.env.BASE_URL` and ships in a GitHub release (`assets-<date>`, fixed once published)
  pinned by `assets.lock.json`; the new lock goes in the commit whose code needs it
  (`tools/repo/assets.mjs`).
- Machine details (hardware, user names, local paths) stay out of the repository; measurements are
  relative. Comments and docs state what was measured and found and never cite the `artifacts/`
  notes, plans or reports, or internal task and milestone names (a tool's output folder may be
  named).
- Player-facing text is in `packages/game/ui/i18n/`, never in code (partly: `verify-i18n`, Chinese
  literals only).
- Code style follows three.js (mrdoob): tabs, spaces inside parentheses and brackets, English
  comments that explain why.
- Compare a visual change against captures from before it, crops included, and report the measured
  differences (the verifying skill). Measure a performance change with `profile-frame` on a
  production build under the GPU lock, before and after, with contended runs reported as such.
- Commits follow Conventional Commits: `type(scope): summary` (lower case, imperative, no full stop,
  header at most 100 characters), a body saying why. Types: `feat`, `fix`, `perf`, `refactor`,
  `style`, `test`, `docs`, `build`, `ci`, `chore`, `revert`; the optional scope names the section
  changed; a breaking change takes `!` or a `BREAKING CHANGE:` footer.

## Shaders and GPU work

Before you write or change TSL, a shader, a compute kernel, a pass of the frame graph, a GPU buffer,
instancing or raw WebGPU work, read `docs/reference/three-behaviour.md`: most of what it lists fails
without an error. Its rules for every layer, by section (the render pipeline's own:
`packages/render/AGENTS.md`):

- A helper called from several places is `Fn( ... ).setLayout( ... )`. A laid-out helper that reads
  uniforms can be emitted with another build's uniform names (Shader functions).
- `positionGeometry` for the undisplaced position (The displaced position). `select()` chooses
  between values built before it (select() of large operands). Implicit-LOD samples and derivatives
  in uniform control flow (Uniform control flow). Nested loops are one `Loop()` (Nested loops). A
  branch whose result reaches a varying is a laid-out `Fn` (Inline functions and varyings).
- New frame work is a pass on the frame graph that declares its targets and reads; never an `rtt()`
  in a material or a call around the graph (Frame work on the graph; partly: `ponlai/pass-on-graph`,
  `verify-framegraph`).
- Code that differs by anti-aliasing mode reads `post/Antialiasing.ts`'s exports, never the tier. A
  render target has 1 or 4 samples (Sample counts).
- A sampled `DepthTexture` has a render target (Depth textures). Shadow passes keep `alphaTest`,
  `alphaMap`, not `map` (Shadow passes). Byte comparisons hold only between draws split the same way
  (Split draws). Compute kernels are sized from something fixed (Compute kernels). Raw WebGPU work
  follows `post/SubmitBatch.ts` (Submits and encoders). Screen uv, NDC and depth conventions (Screen
  conventions). Temporal modes: velocity, MRT blends, unjittered projection, scene events (Temporal
  modes).
- The water samples at most 15 textures and reads no history but the sea reflection's, at its pixel.
  A mesh under the sea, or a tall or offshore one, registers with the water system (The water's
  textures).

## What the checks hold

`npm run check` holds these, and its failures say what to write instead: shaders in TSL only, never
WGSL or GLSL strings; TSL's `mix`, `step`, `smoothstep` in the function form; no `DynamicDrawUsage`;
one owner of timestamp queries; vegetation found by `userData.vegetation`, not `alphaToCoverage`;
imports only from the layers below; a package imported only through its entry points (add a newly
needed name there); each `userData` key on its layer's list; a plant kind, a kind of local light or
an extra pass declares its cost setting, test-mode behaviour and land dependence; three.js internals
used only in `packages/render/three/`; nothing binary or over 1 MiB in git; REUSE, and SPDX tags in
every `/*!` notice. Run `npm run lint:docs` before a commit that changes Markdown.

## Checks run by hand

| After changing | Run | It holds |
| --- | --- | --- |
| The growth, what depends on the land's shape, instancing, an index rewritten in place | `island/verify-growth-swap` | A grown page draws a fresh load's frame; a swap never builds a pipeline; instanced kinds keep a fixed capacity (Instance matrices); an index rewritten in place is a `Uint32Array` (Index buffers) |
| A scene event, a history, the scene jump, the build order | `island/verify-scene-jump`, parity captures | A jump draws a fresh load's frame; the order materials first build in affects the output (Build order) |
| A draw, a material, a pass, a one-time render | `render/verify-first-use`; a pass, `render/verify-frame-graph-gpu` too | The graph's warm-up precompiles each draw's pipeline (Pipeline precompilation); a one-time render waits for it (Draws skipped while compiling) |
| A storage buffer that grows | `render/verify-storage-realloc` | It grows by a new attribute (Storage buffers) |
| The sun's shadow | `render/verify-solar-shadows` | One penumbra width at any caster distance; receivers clear at a low sun |
| What a frame costs | `render/profile-frame` | The high tier's performance target, above |

## Adding a rule

After a bug, a review's finding or a failed check, prefer making the mistake impossible in the
architecture, then in the types, then a lint rule, then a test, and text last. A rule that can be a
check gets it in the same change, named in What the checks hold or Checks run by hand. A rule that
needs judgement is one line here or in its layer's `AGENTS.md`, naming the page or header that owns
its detail. The commit that adds a rule names the mistake that led to it. A rule without a check
that is broken a second time gets one in the change that meets it.

## Before a task, read

- A pass, a plant kind or a local light: `docs/reference/extension-points.md`. The world's
  generator: `packages/island/world/Chunks.ts`'s header; what depends on the land's shape:
  `Growth.ts`'s header. A history-dependent effect: `docs/bindings/verifying-rendering-changes.md`,
  History.
- Gameplay: `docs/design/game-design.md`; game content: `packages/game/sim/content/README.md`; game
  UI: `docs/design/ui.md`. The look and what to avoid: `docs/design/art-direction.md` and the pages
  it links, `docs/reference/look-values.md`.
- three.js: `packages/render/three/README.md`. A commit: `tools/check.mjs`'s header. A tool, a
  check, a doc or a change to what renders: its skill.

## Map

The folders in full: `ARCHITECTURE.md`, Code map; file by file: `node tools/repo/code-map.mjs`.
`app/`: the app layer (entry, assembly, frame loop, GUI, scene jump); `app/scenes/`, `scenes.html`:
the render pipeline's test scenes. `packages/render/`: the render pipeline, built without the
island. `packages/island/`: the island, its world in chunks, grown in place. `packages/game/`: the
game at `/` (the art-review scene behind `?review`), its headless rules in `sim/`. `tools/`: checks,
captures, probes, profiling, the GPU lock, the code lint. `packages/render/`, `packages/island/` and
`tools/` have their own rules in an `AGENTS.md`. `skills/`: linked from `.claude/skills/`. `docs/`:
the documentation by kind (`docs/README.md`). `public/` (git-ignored): the assets.
