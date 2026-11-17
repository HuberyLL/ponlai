# Binding: writing TSL and passes

This project's facts for the skill
[`writing-tsl-and-passes`](../../skills/writing-tsl-and-passes/SKILL.md). Each section is named
after the step of the skill that reads it. A project of your own copies the section names and
fills in its own facts.

Every command that renders in a browser runs under the GPU lock, and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`). `tools/render/wgsl-build.mjs` needs neither: it renders nothing.

Contents:

- [Read first](#read-first)
- [Version](#version)
- [Write](#write)
- [WGSL build](#wgsl-build)
- [Test scenes](#test-scenes)
- [Checks](#checks)
- [Record](#record)

## Read first

The behaviour page is `docs/reference/three-behaviour.md`; the shader and GPU rules of `AGENTS.md`
(Shaders and GPU work) and `packages/render/AGENTS.md` name its sections in brackets. Read the
sections for what the change touches:

| The change touches | Sections of the behaviour page |
| --- | --- |
| TSL in a material | The displaced position; Method forms of mix, step and smoothstep; select() of large operands; Uniform control flow; Nested loops |
| A helper used in several places, a varying | Shader functions; Inline functions and varyings |
| Multiple render targets, velocity, the temporal modes | Multiple render targets; Temporal modes |
| A full-screen pass, a new pass of the frame graph | Screen conventions; A full-screen pass's camera; Frame work on the graph; Multisampled depth; Sample counts |
| A render target, a depth texture | Depth textures; Multisampled depth; Sample counts |
| What reads previous-frame data | Previous-frame data; Temporal modes |
| A compute kernel | Compute kernels; Shader functions |
| Vegetation, shadows, equal-depth passes | Shadow passes; Vegetation's cut-outs; Bit-identical depth |
| A mesh under the sea, or a tall or offshore mesh | The water's textures |
| Draws that appear only some of the time, bakes, warm-up | Pipeline precompilation; Build order; Draws skipped while compiling |
| Storage, instance, index or attribute buffers | Storage buffers; Instance matrices; Index buffers; Attribute usage |
| Raw WebGPU, the queue, timestamps | Submits and encoders; Timestamps |
| Splitting or merging draws | Split draws |

For a new pass, plant kind or kind of local light, read `docs/reference/extension-points.md` (the
three declarations each must make). For a new material, read
[building-cinematic-stylised-realism](building-cinematic-stylised-realism.md#materials). Shaders
are TSL only, never WGSL or GLSL strings (lint rule `ponlai/tsl-only`). Code that differs by
anti-aliasing mode reads `post/Antialiasing.ts`'s exports, never the quality tier.

## Version

- three.js is pinned exactly in `package.json` (`three` 0.186.1, `@types/three` 0.186.0); the
  behaviour page marks three.js's own behaviour at that version **r186**.
- After an upgrade, follow `packages/render/three/README.md`: its step 11 rechecks every r186 entry
  with its check. `tools/repo/verify-three-internals.mjs` (in `npm run check`) fails on each
  three.js internal that the render pipeline uses and whose code changed.

## Write

- A history-dependent effect (a temporal resolve, adaptation, accumulation, a bake kept between
  frames) follows [verifying-rendering-changes](verifying-rendering-changes.md), History (clearing
  it on a scene jump, `settled`'s pending list, the test mode's switch). A pass declares its
  test-mode behaviour with its `testMode` (`docs/reference/extension-points.md`, The three
  declarations).
- New per-frame GPU work is a pass on the frame graph (`packages/render/post/Pipeline.ts`,
  `packages/render/post/ExtraPass.ts`). A draw that appears only some of the time is registered as
  a latent draw of its scene pass. The lint rules `ponlai/pass-on-graph` and
  `ponlai/history-on-graph` refuse `rtt()`, `convertToTexture()` and a history copied outside the
  graph.
- Code adapted from another project opens with a `/*! ... */` notice carrying its SPDX tags
  (`AGENTS.md`, Rules for every change).

## WGSL build

```sh
node tools/render/wgsl-build.mjs <entry> [--out <dir>] [--q "<query>"] [--features <a,b>]
```

- The entries are in `tools/render/wgsl-build/`, one per area (the tool's header lists them). For a
  module without an entry, add one there that builds its shaders in the same order as the page (the
  entry's contract is in the tool's header). `<entry>` can also be a path, for a one-off entry such
  as the same shaders built in another order.
- A material is drawn on a full-screen quad unless the entry gives it an `object`; the quad has
  no normals, so a material that reads the surface normal gets a mesh with normals.
- A new file that a doc names fails `npm run lint:docs` (its path check reads tracked files only)
  until it is added to git.
- Output: `artifacts/wgsl/<entry>/` (`*.wgsl`, `bindings.txt`, `report.json`); exit 1 when a
  shader fails to build or exceeds a default limit. `--q` sets the page's options (`aa=`,
  `flags=`), and `--features` sets the device features that three.js sees (`float32-filterable`,
  `texture-formats-tier1` change the WGSL).
- For a refactor, build the same entry on the commit the change starts from (a temporary
  `git worktree add` of it, removed afterwards) and diff the two folders.

## Test scenes

- Serve the checkout with `node tools/kit/serve.mjs dev` (`--sha <rev>` serves the starting
  commit), then capture with `tools/render/scenes.mjs` (see its header):

  ```sh
  node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
    node tools/render/scenes.mjs <url> <out>/before --verify --write-ref
  node tools/kit/job.mjs start --wait -- node tools/kit/gpu-lock.mjs run --shared -- \
    node tools/render/scenes.mjs <url> <out>/after --verify --check --ref <out>/before/neutral
  ```

- The scenes are `ball`, `empty`, `plants` (compared to the pixel) and `sea` (named only, read by
  its `readings.tsv`). Which changes they cover:
  [verifying-rendering-changes](verifying-rendering-changes.md), Kinds.
- To read one value from the page without a capture, run `tools/kit/probe.mjs` on
  `<url>scenes.html`.

## Checks

- Every commit: `npm run check` (types, the code lint with the `ponlai/…` rules, the CPU checks
  including `tools/render/verify-framegraph.mjs` and `tools/render/verify-extensions.mjs`).
- By what was touched, under the GPU lock (each tool's header gives its use):
  - pipelines after the warm-up: `tools/render/verify-first-use.mjs`;
  - the frame graph's compile path, MRT layouts and warm-up:
    `tools/render/verify-frame-graph-gpu.mjs`;
  - storage buffers that grow: `tools/render/verify-storage-realloc.mjs`;
  - a history and scene jumps: `tools/island/verify-scene-jump.mjs`;
  - buffers or instances swapped as the island grows: `tools/island/verify-growth-swap.mjs`;
  - the island's still frames against references: `tools/island/parity/` and
    `tools/kit/parity/capture-set.mjs` with `--check`.
- WebGPU validation errors: the page's console (`tools/kit/probe.mjs --console`).

## Record

- A new behaviour of three.js or WebGPU: add an entry in `docs/reference/three-behaviour.md`
  (behaviour, what the code does, where, its check, **r186** when it is three.js's own). Add a line
  naming its section in `AGENTS.md`, Shaders and GPU work, or in `packages/render/AGENTS.md` when it
  applies to the render pipeline alone. The mistake it came from goes in the commit message. A
  finding that adds to an existing entry goes into that entry, under its existing line.
- A rule that can be checked: a lint rule in `tools/repo/lint/` or a `verify-*` tool, in the same
  change (`AGENTS.md`, Adding a rule).
