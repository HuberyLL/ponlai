# Upgrade three.js

This guide gives the steps for moving the project to another version of three.js. The renderer
depends on parts of three that are not its public interface: private members of the renderer and
its helpers, the WebGPU backend and its device, methods it replaces and code of three's it mirrors.
Each of these reaches is a function of `packages/render/three/`, and
`packages/render/three/three-internals.json` lists what they depend on. three and `@types/three` are
pinned to exact versions, so the list holds until someone changes the pin.

An upgrade is the only time the list can stop holding, and then the code says so instead of taking
another path:

- `tools/verify-three-internals.mjs` fails on each entry missing from the installed three, and on
  each replaced, wrapped, mirrored or relied-on function whose code changed (its fingerprint).
- On the page, `checkRenderer` (`packages/render/three/Internals.ts`) checks the renderer's members
  once it is initialised, and each function of `packages/render/three/` throws when a member it
  needs is missing. The error names the list's entry and the function that needs it.

The other dependencies are on three's behaviour, with no line that reaches in; the
[table at the end](#behaviour-the-code-depends-on) lists them, each with the check that sees it.

## Steps

1. Create a branch. Read three's migration guide and release notes for every version between the
   pinned one and the new one, and note what touches an entry of `three-internals.json` or a row of
   the behaviour table.
2. Change `three` and `@types/three` together, to exact versions (no `^` or `~`), and install:
   `npm install --save-exact three@<version> @types/three@<version>`. Set the list's `three`,
   `types` and `revision` to the new versions.
3. Run `node tools/verify-three-internals.mjs`. For each failure, read three's new code, change
   the function of `packages/render/three/` that depends on the entry (or its patch, wrapper or
   mirrored copy), and update the entry. Print the new fingerprints with `--fingerprints` and record
   each only after reading the code it covers. Repeat until the check passes.
4. Run `npm run typecheck` and `npm run build`.
5. Compare the shader code: build the WGSL with `tools/wgsl-build.mjs` on the old version and the
   new one (`docs/reference/tools.md`, WGSL builds), and note which shaders changed and why.
6. Run the checks that need no GPU: `npm run check -- --full`.
7. Run the GPU checks that compare two paths of the same code, which must still pass byte for byte:
   the scene jump (`tools/verify-scene-jump.mjs`) and the growth swap
   (`tools/verify-growth-swap.mjs`). The page must also start without an error from
   `packages/render/three/`.
8. Compare the image with captures from before the upgrade (`tools/parity/capture-set.mjs`). An
   upgrade need not match byte for byte: judge it within the temporal tolerance
   (`tools/parity/README.md`, Temporal tolerance), explain each difference, then capture new
   reference sets.
9. Check the pipelines: the count the page creates (`diagnostics.pipelines`,
   `packages/render/debug/PipelineCounter.ts`), that no player step creates one
   (`tools/verify-first-use.mjs`), and that a growth swap creates none
   (`tools/verify-growth-swap.mjs`).
10. Measure the frame time before and after the upgrade (`docs/how-to/check-a-change.md`, Measure a
    performance change).
11. Go through the behaviour table below, each row with its check. Where three no longer behaves as
    a row says, remove the code that works around it, the row, and the item of `AGENTS.md`, WebGPU /
    TSL pitfalls, that states it.
12. Update the comments that name the old version (search for `r186`, the current revision) and
    `CREDITS.md` where it names one.

## Behaviour the code depends on

These are behaviours of three r186 that the code is written around. No shape check sees them;
the check named in each row does.

| Behaviour | Where the code meets it | Check |
| --- | --- | --- |
| A material's shader code depends on the order materials first build in, and the first lit build makes nodes every receiver shares | `post/graph/Compile.ts`, `three/ThreePatches.ts` `primeSharedNodes` | Byte comparison of the parity captures (`tools/parity/capture-set.mjs`) and the scene jump (`tools/verify-scene-jump.mjs`) |
| `renderer.compileAsync` alone does not compile what a render draws (target, MRT, side, call depth) | `post/graph/Compile.ts`, `three/DrawBuilds.ts` | `tools/verify-frame-graph-gpu.mjs`, `tools/verify-first-use.mjs` |
| A material drawn into two attachment layouts needs a pipeline per layout, which three's cache keys do not tell apart | `three/ThreePatches.ts` `installCacheKeyPatches` | `tools/verify-frame-graph-gpu.mjs` |
| A draw whose pipeline an asynchronous compile is still creating is skipped without a word | `sky/Sky.ts` `warm`, `post/graph/Compile.ts` `compileByRendering` | `tools/verify-first-use.mjs`; byte comparison of the parity captures |
| A storage buffer cannot grow in place; a new attribute as a storage node's `value` takes new bind groups and no pipeline | `vegetation/VegetationCull.ts` | `tools/verify-storage-realloc.mjs` |
| Up to 1024 instance matrices sit in a uniform array of exactly the capacity, so a fixed capacity keeps one shader | `vegetation/Instances.ts` | `tools/verify-growth-swap.mjs` (a swap builds no pipeline) |
| A 16-bit index is copied into a 32-bit array when its buffer is made, and the copy is uploaded from then on | `util/Upload.ts`, the merged kinds' indices | `tools/verify-growth-swap.mjs` |
| The clip position has no `@invariant`, which the vegetation's depth prepass adds | `vegetation/VegetationPrepass.ts` | `tools/wgsl-build.mjs` (the prepass's vertex shader); byte comparison of the parity captures |
| A `Fn( ... ).setLayout( ... )` helper that reads uniforms can be emitted with another compute kernel's uniform names | the compute kernels that share helpers | `tools/wgsl-build.mjs`; byte comparison of the parity captures |
| `mix`, `step` and `smoothstep` as methods take their receiver out of order | every TSL shader | `tools/wgsl-build.mjs`; byte comparison of the parity captures |
| A sample count of 2 is taken as 1, with no MSAA | `post/Antialiasing.ts` | Byte comparison of the parity captures |
| A `DepthTexture` without a render target takes the renderer's sample count, and each material gets one sampler type per depth texture | `lighting/SolarShadow.ts` | Byte comparison of the parity captures; `tools/verify-solar-shadows.mjs` (the sun's shadow builds and filters) |
| Each render pass begins on a command encoder of its own, made in `beginRender` | `post/graph/AttachmentOps.ts` | The frame graph's dev check on the dev server (`opsMismatchFrames` in the diagnostics' `graph`); byte comparison of the parity captures |
