# Upgrade three.js

This guide gives the steps for moving the project to another version of three.js. The renderer
depends on parts of three that are not its public interface: private members of the renderer and
its helpers, the WebGPU backend and its device, methods it replaces and code of three's it mirrors.
Each of these reaches is a function of `packages/render/three/`, and
`packages/render/three/three-internals.json` lists what they depend on. three and `@types/three` are
pinned to exact versions, so the list holds until someone changes the pin.

An upgrade is the only time the list can stop holding, and then the code says so instead of taking
another path:

- `tools/repo/verify-three-internals.mjs` fails on each entry missing from the installed three, and
  on each replaced, wrapped, mirrored or relied-on function whose code changed (its fingerprint).
- On the page, `checkRenderer` (`packages/render/three/Internals.ts`) checks the renderer's members
  once it is initialised, and each function of `packages/render/three/` throws when a member it
  needs is missing. The error names the list's entry and the function that needs it.

The other dependencies are on three's behaviour, with no line that reaches in:
[three.js and WebGPU behaviour](../reference/three-behaviour.md) lists them, the entries marked
r186, each with the check that sees it.

## Steps

1. Create a branch. Read three's migration guide and release notes for every version between the
   pinned one and the new one, and note what touches an entry of `three-internals.json` or an
   entry marked r186 in `docs/reference/three-behaviour.md`.
2. Change `three` and `@types/three` together, to exact versions (no `^` or `~`), and install:
   `npm install --save-exact three@<version> @types/three@<version>`. Set the list's `three`,
   `types` and `revision` to the new versions.
3. Run `node tools/repo/verify-three-internals.mjs`. For each failure, read three's new code, change
   the function of `packages/render/three/` that depends on the entry (or its patch, wrapper or
   mirrored copy), and update the entry. Print the new fingerprints with `--fingerprints` and record
   each only after reading the code it covers. Repeat until the check passes.
4. Run `npm run typecheck` and `npm run build`.
5. Compare the shader code: build the WGSL with `tools/render/wgsl-build.mjs` on the old version and
   the new one (`docs/reference/tools.md`, WGSL builds), and note which shaders changed and why.
6. Run the checks that need no GPU: `npm run check -- --full`.
7. Run the GPU checks that compare two paths of the same code, which must still pass byte for byte:
   the scene jump (`tools/island/verify-scene-jump.mjs`) and the growth swap
   (`tools/island/verify-growth-swap.mjs`). The page must also start without an error from
   `packages/render/three/`.
8. Compare the image with captures from before the upgrade (`tools/island/parity/capture-set.mjs`).
   An upgrade need not match byte for byte: judge it within the temporal tolerance
   (`tools/island/parity/README.md`, Temporal tolerance), explain each difference, then capture new
   reference sets.
9. Check the pipelines: the count the page creates (`diagnostics.pipelines`,
   `packages/render/debug/PipelineCounter.ts`), that no player step creates one
   (`tools/render/verify-first-use.mjs`), and that a growth swap creates none
   (`tools/island/verify-growth-swap.mjs`).
10. Measure the frame time before and after the upgrade (`docs/how-to/check-a-change.md`, Measure a
    performance change).
11. Go through the entries marked r186 in `docs/reference/three-behaviour.md`, each with its
    check. Where three no longer behaves as an entry says, remove the code that works around it and
    the entry, and the line of `AGENTS.md`'s rule table or the lint rule that states it.
12. Update the comments that name the old version (search for `r186`, the current revision) and
    `CREDITS.md` where it names one.
