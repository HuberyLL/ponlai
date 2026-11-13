# Ponlai

A small island in an open sea, rendered in the browser: a visual sample for a game, and the game
growing behind `?game`. The look is a calm, painterly island,
inspired by the eastern aesthetic of Ghost of Tsushima, on a physically based scene lit as the
sun and the sky give it (deep clear water, chunky stone, a lush meadow that moves in the wind,
with wildflowers). The look and what to avoid: `docs/explanation/art-direction.md`. The game's
design: `docs/explanation/game-design.md` (read it before gameplay work).

This file is an index: the rules every change follows, what to read before a task, and the folders.
Detail lives where it is owned.

## Where things are written

- A module's rules and their reasons live in its header comment: read it before changing the
  module, and update it with a change to the module's behaviour.
- `ARCHITECTURE.md` is the structure (layers, what each owns, flows, the rules across them, why):
  read it before a structural change; update it when a change adds a layer, moves what one owns or
  changes a flow. The rules' full text: `docs/reference/architecture-rules.md`. Files:
  `node tools/repo/code-map.mjs`. Art decisions go to `docs/explanation/art-direction.md`, measured
  look values to `docs/reference/look-values.md`, URL options to `docs/reference/url-options.md`,
  tool manuals to `docs/reference/tools.md`; this file changes with a rule every change follows, the
  reading index or the folders.
- The docs follow Diátaxis (<https://diataxis.fr>), a page one kind, in its folder of `docs/`:
  tutorials (`docs/tutorials/`, none yet) for a first success, how-to guides (`docs/how-to/`) for
  one task's steps, reference (`docs/reference/`, and a module's header beside its code) for facts,
  explanation (`docs/explanation/`) for what and why. `docs/README.md` lists every page. `AGENTS.md`,
  `ARCHITECTURE.md` and `CREDITS.md` stay at the top; a README beside a tool documents its folder.
  A page links to the others rather than repeating them; a fact or a rule is written in one place.
  Docs state the current state: what was tried and dropped goes in the commit message.
- Prose follows the Google developer documentation style guide
  (<https://developers.google.com/style>): plain words, short sentences, one term per thing.

## Stack and commands

- TypeScript (strict), Vite, three.js `WebGPURenderer` (`three/webgpu`, `three/tsl`). WebGPU is
  required (the ocean FFT runs on compute shaders); without it the page shows a message.
- `npm run dev` (port 5190), `npm run build` (type-checks, then bundles), `npm run typecheck`,
  `npm run preview` (port 5191), `npm run lint` (the code lint). `npm run check`: what every commit
  passes (types, code lint, layers, exits, settings, file sizes, three's internals, CPU regression
  tools), in seconds, without a GPU; `-- --full` adds the build and the world's chunks
  (`docs/how-to/check-a-change.md`). `npm run lint:docs`: Markdown, offline links, docs paths in
  code; `npm run lint:links` adds web links. In-page keys:
  `docs/reference/tools.md`, Page.
- Tools are in `tools/`, their manual in `docs/reference/tools.md` (Which tool for which question).
  Most changes meet: `node tools/kit/serve.mjs dev|preview` (a worktree's server on a free port),
  `tools/kit/capture.mjs` (one screenshot), `tools/kit/parity/capture-set.mjs` (views on one warm
  page, not a loop), `tools/render/scenes.mjs` (the renderer's test scenes checked in seconds: run
  it first after a renderer change), `uv run tools/kit/img.py diff|crop|sheet|stats|flicker` (image
  work on captures), `tools/kit/probe.mjs` (page values as JSON), `tools/render/wgsl-build.mjs` (TSL
  to WGSL in node, no GPU), `tools/render/profile-frame.mjs` (frame time on a production build),
  `tools/repo/assets.mjs` (the assets in `public/` against `assets.lock.json`, pulled by dev and
  build) and `tools/**/verify-*.mjs` (regression probes; after a change to the world's generator,
  run `node tools/island/verify-world-chunks.mjs` before captures). Use them instead of a Pillow,
  NumPy or Playwright script of one's own.
- Everything that renders the scene in a browser takes the GPU lock
  (`node tools/kit/gpu-lock.mjs run [--shared] -- <command>`): timing runs hold it alone, paused
  captures and probes share it. Sessions leave `PONLAI_GPU_PRIORITY` unset.
- Every wait goes through `tools/kit/job.mjs`, never a sleep loop of one's own; a job is stopped with
  `job.mjs stop <log>` before an agent hands back.
- Headed browser runs take over the user's screen: run one only for what a screen alone shows, and
  only while `node tools/kit/display-gate.mjs status` allows it.
- A new CPU-heavy tool imports `tools/kit/qos.mjs` first; a one-off script runs through
  `node tools/kit/qos.mjs <command>`.

## Tools

- Before writing a script, look for the tool that answers the question (`docs/reference/tools.md`,
  Which tool for which question); if one almost fits, add an option to it.
- A script needed a second time, or by another task, becomes a tool (`docs/how-to/write-a-tool.md`).
  A truly one-off script stays in the task's artifacts folder.
- Never start a GPU tool to see its options: it queues for the lock and renders. Read its header.

## Rules for every change

"Enforced by" names a code lint rule (`ponlai/…`), a `tools/**/verify-*.mjs` check (its bare name),
a command, or judgement. "Came from" is the mistake that led to the rule; a dash means none is on
record and the rule guards a stated convention.

| Rule | Enforced by | Came from |
| --- | --- | --- |
| Lookdev and lighting are kept strictly apart (`docs/explanation/art-direction.md`, How the look is made); a new material follows `docs/how-to/add-material.md`. | judgement | - |
| Shaders are TSL only, never WGSL or GLSL strings; a helper called from several places is `Fn( ... ).setLayout( ... )`, one shader function. | `ponlai/tsl-only`; the helpers: judgement | - |
| Simulation and generation are deterministic and path-independent: the world, its growth, the weather, the wind and every integrated state are functions of the land, seeds, scene clock and weather, never of the path or thread count; a grown page or a scene jump holds what a fresh load holds (`ARCHITECTURE.md`, rule 4). | `verify-world-chunks`, `verify-growth-swap`, `verify-scene-jump`, parity captures | a cliff wall's exposure kept state across calls (`Chunks.ts`) |
| What changes the scene reads the scene clock or its step, never the wall clock (`ARCHITECTURE.md`, rule 17). | `ponlai/scene-clock` | the sky's irradiance read-back waited on a wall-clock gate |
| A history-dependent effect is cleared by a scene jump, converges on a still scene or is frozen or off in the test mode, and is compared within a tolerance (`ARCHITECTURE.md`, rule 4). | `verify-scene-jump`; parity tolerance | a history that outlived a jump (`ARCHITECTURE.md`, rule 15) |
| The test mode is a paused page under MSAA, shot once `settled` holds; a paused frame repeats exactly and equals a fresh load's. A new history-dependent effect keeps `settled` false until converged and obeys the test mode's switch (`docs/how-to/check-a-change.md`). | parity MSAA sets, `verify-scene-jump`, `verify-growth-swap` | - |
| What is generated for the island or fitted to the land derives from the land's footprint, the island's SDF and fixed-seed fields, never hand-placed coordinates; counts follow the coast or the area (`ARCHITECTURE.md`, rule 5). | judgement | the shore's stones came from one running stream along the coast (`Stones.ts`) |
| The world is built in chunks: a chunk's content is a function of its window, border data is bit-identical in both chunks, the chunks merge in their own order (`Chunks.ts`, `ChunkMerge.ts`). | `verify-world-chunks`, `ponlai/chunk-normals` | the rim's skirt and the world took normals from a chunk's own triangles |
| The island grows in place: a Grow swaps the changed chunks in one frame, and what depends on the land's shape joins the swap (`Growth.ts`). | `verify-growth-swap` | a stale shore on a grown page (`ARCHITECTURE.md`, rule 15) |
| A swap never builds a pipeline; one that needs one is a bug (`Growth.ts`). | `verify-growth-swap`, `verify-first-use` | - |
| Changes hold in the kept weathers (clear, fair) and on high (4K output: 1920x1080 CSS pixels at DPR 2) only; parked weathers (`sky/Weather.ts` `PARKED_WEATHER`) and tiers (`Quality.ts` `PARKED_QUALITY`) need no support but keep compiling and loading by name (`?weather=`, `?quality=`); default checks skip them. | `npm run typecheck`; judgement | the parked tiers slowed every line of work down (`Quality.ts`) |
| Changes are judged at high's standard: 4K output at 60 fps with MSAA 4x, about 14 ms of GPU time a frame at the baseline (`Quality.ts`; `docs/reference/tools.md`, Frame profiler). | `profile-frame`, a measurement run by hand | - |
| Quality tiers change the cost, never the mood (weather, clock, lighting). High at 4K output is the reference image, the only active tier and every module's default; a load knob is read once, so a change of tier reloads (`Quality.ts`). | judgement | - |
| Code that differs by anti-aliasing mode reads `post/Antialiasing.ts`'s exports, never the tier. | judgement | the depth resolve read four samples from a target of two |
| A layer imports only from layers below, a package only through its exits (a newly needed name is added there); a `userData` key is on its layer's list (`ARCHITECTURE.md`, rules 10, 11). | `verify-layers`, `verify-exits` | a module that worked as it loaded made import order part of the program |
| A URL option is declared in `Settings.ts` and read through it only (`ARCHITECTURE.md`, rule 14). | `verify-settings`, `verify-layers` | fifteen modules read the address their own way |
| The renderer, the island and the game's rules never touch the browser's globals; they are given what they need (`ARCHITECTURE.md`, rule 13). | `verify-layers` (named globals only); other routes: judgement | - |
| A plant kind, a kind of local light or an extra pass declares its cost knob, its test-mode stand and how it follows the growth (`Extensions.ts`). | `verify-extensions` | an effect that forgot one (`ARCHITECTURE.md`, rule 18) |
| three's internals are reached only in `packages/render/three/`; an upgrade of three follows `docs/how-to/upgrade-three.md`. | `verify-three-internals` | - |
| A file adapted from another project opens with a `/*! ... */` notice (project, copyright line, licence), its licence text beside it (`ocean/tidewater.LICENSE.txt`). Public-domain code (CC0, Unlicense) needs no notice; it and a technique borrowed without code are credited in a comment where used. | judgement | - |
| `CREDITS.md` lists every third-party source (adapted code, assets with source, author, licence and processing, techniques) but npm dependencies (the build collects theirs in `dist/licenses/`); other shipped licence text goes in `vite.config.ts` `LICENCE_FILES`. No reference images in git, no unlicensed third-party art. | judgement | - |
| No asset in git: what the page loads lives in the git-ignored `public/`, loads through `import.meta.env.BASE_URL`, ships in a GitHub release (`assets-v<N>`, never changed once published) pinned by `assets.lock.json`, the new lock in the commit whose code needs it; nothing binary or over 1 MiB is committed (`docs/reference/tools.md`, Assets). | `verify-no-binaries`; the rest: judgement | binary assets were kept in git |
| Machine details (hardware, user names, local paths) stay out of the repository; measurements are relative. | judgement | - |
| Comments and docs state what was measured and found, never cite the git-ignored `artifacts/` notes, plans or reports, or internal task and milestone names (a tool's output folder may be named). | judgement | - |
| Code style follows three.js (mrdoob): tabs, spaces inside parentheses and brackets, English comments that explain why. | judgement | - |
| No player-facing string is written in code; the words are in `packages/game/ui/i18n/`. | `verify-i18n` | the interface's Chinese was written inline across a dozen modules |
| Game UI (what the player sees in `?game`, mockups too) is built with the `threejs-game-ui-designer` skill when the agent has it, to read as a game's, not a product's. | judgement | - |
| A visual change is compared against captures from before it, crops included, and the measured differences reported (`docs/how-to/check-a-change.md`). | judgement | - |
| A performance change is measured with `profile-frame` on a production build under the GPU lock, before and after, contended runs reported as such. | judgement | - |
| `npm run lint:docs` passes before a commit that changes Markdown. | `npm run check` (on staged Markdown) | - |
| Commits follow [Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary` (lower case, imperative, no full stop, header at most 100 characters), a body saying why. Types: `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`, `chore`, `revert`; the optional scope names the section changed (`ocean`, `world`, `ai`); a breaking change takes `!` or a `BREAKING CHANGE:` footer. | judgement | - |

Shader, pass and GPU rules; the name in brackets is their section of
`docs/reference/three-behaviour.md`.

| Rule | Enforced by | Came from |
| --- | --- | --- |
| Write TSL's `mix`, `step`, `smoothstep` in the function form (Method forms of mix, step and smoothstep). | `ponlai/tsl-method-order` | fsr3's kernel bias took `.mix` out of order |
| New frame work is a pass on the frame graph, targets and reads declared, never an `rtt()` in a material or a call around the graph (Frame work on the graph). | `ponlai/pass-on-graph`, `verify-framegraph`; the reads: judgement | the display chain's composite, sharpen and blur used `rtt()` or `convertToTexture()` |
| A texture's history is declared on the graph; what a frame reads from the one before advances once per frame (The frame before). | `ponlai/history-on-graph`, `verify-framegraph`; the rest: judgement | - |
| Attributes changed once per event keep static usage with update ranges (Attribute usage). | `ponlai/no-dynamic-draw` | the lightning re-uploaded whole buffers every draw |
| Timestamp queries have one owner at a time (Timestamps). | `ponlai/timestamp-owner` | - |
| Vegetation is found by `userData.vegetation`, never `alphaToCoverage` (Vegetation's cut-outs). | `ponlai/vegetation-tag` | the sun's shadow keyed its filter on `alphaToCoverage` |
| `positionGeometry` for the undisplaced position (The displaced position). | judgement | - |
| `select()` chooses between values built before it (select() of large operands). | judgement | the water's position, built in a branch, drew nothing |
| Implicit samples and derivatives in uniform control flow (Uniform control flow). | judgement | a shadow filter's derivatives inside a select |
| Nested loops are one `Loop()` (Nested loops). | judgement | - |
| A laid-out helper that reads uniforms can take another build's uniform names when two shaders using it (compute kernels or materials) are built (Shader functions). | judgement | FSR 3's kernels (`fsr3/Common.ts`); the display chain's `coolShare` broke the rain (`PipelineDisplay.ts`) |
| A branch reaching a varying is a laid-out `Fn` (Inline functions and varyings). | judgement | the meadow passed sixteen varyings |
| Several attachments: the `outputStruct` itself (Several attachments). | judgement | an `outputStruct` from inside an `Fn`: `struct member m0 not found` |
| Bit-identical depth takes `@invariant` (Bit-identical depth). | judgement | the vegetation prepass's depth test failed a few samples |
| Screen uv, NDC and depth conventions (Screen conventions). | judgement | - |
| A full-screen pass takes the scene camera as uniforms (A full-screen pass's camera). | judgement | - |
| Multisampled depth by `textureLoad` (Multisampled depth). | judgement | - |
| 1 or 4 samples (Sample counts). | judgement | the depth resolve read samples a target of two lacked |
| A sampled `DepthTexture` has a render target (Depth textures). | judgement | met when the sun's shadow map was stepped |
| Shadow passes keep `alphaTest`, `alphaMap`, not `map` (Shadow passes). | judgement | - |
| Temporal modes: velocity, MRT blends, unjittered projection, scene events (Temporal modes). | judgement | - |
| Byte comparisons hold between equal draw splits only (Split draws). | judgement | a mesh per chunk moved 1 % of pixels (`World.ts`) |
| Draws compile ahead through the graph's warm-up (Compiling ahead). | `verify-first-use`, `verify-frame-graph-gpu` | the sun map's first redraw stalled on its pipelines |
| The order materials first build in is part of the image (Build order). | parity captures, `verify-scene-jump` | the first lit receiver emitted other code |
| A one-time render waits for its warm-up (Draws skipped while compiling). | `verify-first-use` | - |
| Compute kernels are sized from something fixed (Compute kernels). | judgement | - |
| Storage buffers grow by a new attribute (Storage buffers). | `verify-storage-realloc` | - |
| Instanced kinds keep a fixed capacity (Instance matrices). | `verify-growth-swap` | - |
| An index rewritten in place is a `Uint32Array` (Index buffers). | `verify-growth-swap` | - |
| Raw WebGPU work follows `post/SubmitBatch.ts` (Submits and encoders). | judgement | - |
| The water takes no more textures, no history; a mesh under the sea or tall or offshore tells the water (The water's textures). | judgement | - |

## Adding a rule

After a bug, a review's finding or a failed check, prefer in this order: make the mistake
impossible in the architecture, then in the types, then catch it with a lint rule, then a test, and
only then write text. A rule that can be a check gets it in the same change, and a row above; one
that needs judgement is written where it is owned, with a row here. A new rule names the mistake
that led to it. A rule without a check that is broken a second time gets one in the change that
meets it.

## Before a task, read

- Before you write or change TSL, a shader, a compute kernel, a pass of the frame graph, a GPU
  buffer, instancing or raw WebGPU work, you must read `docs/reference/three-behaviour.md`: most of
  what it lists fails without an error.
- A pass, a plant kind or a local
  light: `docs/how-to/add-to-the-renderer.md`. A material: `docs/how-to/add-material.md`.
- The world's generator: `packages/island/world/Chunks.ts`'s header. Something that depends on the
  land's shape: `packages/island/world/Growth.ts`'s header. It and a history-dependent effect:
  `docs/how-to/check-a-change.md`.
- Gameplay: `docs/explanation/game-design.md`; game content: `docs/how-to/add-game-content.md`;
  game UI: `docs/explanation/ui.md`. The look: `docs/explanation/art-direction.md`,
  `docs/reference/look-values.md`.
- A tool: `docs/how-to/write-a-tool.md`. three.js: `docs/how-to/upgrade-three.md`. A commit:
  `docs/how-to/check-a-change.md`. A file: `node tools/repo/code-map.mjs`.

## Map

- `app/`: the page (entry, assembly, frame loop, GUI, scene jump); `app/scenes/`, `scenes.html`:
  the renderer's test scenes.
- `packages/render/`: the renderer, built without the island: light, sky, sea, weather, the
  vegetation's shared parts, the frame's passes and graph, the look's readers, three's internals.
- `packages/island/`: the island: its world in chunks, grown in place, its materials, its look's
  numbers, its camera, the islanders and creatures.
- `packages/game/`: the game behind `?game`: the headless simulation (`sim/`), session, save, view
  and interface (`ui/`).
- `tools/`: checks, captures, probes, profiling, the GPU lock, the code lint (`tools/repo/lint/`).
- `skills/`: methods as skills (linked from `.claude/skills/`); a skill's facts for this project:
  `docs/bindings/<skill-name>.md`.
- `docs/`: the documentation by kind (`docs/README.md`). `public/` (git-ignored): the assets. File
  by file: `node tools/repo/code-map.mjs`.
