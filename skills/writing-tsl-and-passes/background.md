# Background: why the method works this way

The reasons behind the steps in [SKILL.md](SKILL.md), typical cases and the public sources.

## Why read before writing

The failures this skill guards against give no error. The page of three.js behaviour exists
because each entry first appeared as a wrong frame with a clean console, often found days later by
a byte comparison. Reading the entries for what you touch takes minutes; finding one from its
symptom has taken a diagnosis each time:

- A laid-out helper read two uniforms in its body. three.js emitted it once, with the first build's
  uniform names, and the rain's materials stopped compiling under one anti-aliasing mode only.
- three.js emits a light's shadow filter inside the branch of its frustum test, and another filter
  ran inside a `select()`. The filter takes derivatives of its coordinate, which are undefined in a
  quad whose lanes take different branches. At the waterline, a handful of pixels changed by up to
  85 levels of 255 between two equivalent builds. In the same fault, a blur's fallback sample sat in
  a `select()` that three.js compiles to a per-pixel branch.
- An inline function whose value reached a varying was set up again in the fragment stage. What it
  read there became two more varyings, which took the shader past WebGPU's limit of sixteen under
  the temporal modes.
- A depth prepass and the shaded draw tested depth for equality. three.js does not emit WGSL's
  `@invariant`, so a few samples failed the test and showed the clear colour until both programs
  declared the clip position invariant.
- three.js cleared a render target's depth before its first render, and a resize disposed the target
  with its record of that render. After every step of the dynamic resolution the vegetation
  vanished for one frame.

## Why the version matters

Many entries are three.js's own behaviour at one release: how the WGSL builder emits shared
functions, which diagnostics it turns off, how it keys pipelines, when it clears. They hold until
the pinned version changes. A page that does not say which release it was checked against cannot
be trusted after an upgrade, and an entry that no longer holds leaves a workaround that hides the
next fault. Each version-bound entry therefore carries its check, and an upgrade runs these
checks.

## Why WGSL in Node.js first

What three.js generates is the only ground truth for what a node graph became. Reading it shows a
value declared in one branch, a derivative inside an `if`, the uniform names a helper reads and the
count of varyings and bindings per stage, all before a page loads. Building a port's twenty compute
kernels in Node.js can find bugs without a GPU: several writes to storage-texture mip levels merged
into one binding, a storage texture's size query that dropped its level, and a uv-matrix uniform
for every texture read. The build does not validate the WGSL, so it complements a test on a page
and never replaces it.

## Why the small scenes first

A full scene loads in minutes and mixes the renderer with the content. The renderer's test scenes
load in seconds and hold a few objects under known lighting. A change to a pass or a material
shows there first, and an exact comparison catches a refactor that changes one pixel before the
full scene's captures are needed.

## Why the checks

Each check detects one class of failure that the console does not show: a pipeline created after
the warm-up (a stall on first use, or a draw skipped), a declared graph that discards a read, a
buffer swap that builds a pipeline, a history that outlives a scene jump, a few pixels changed by
build order.
A change is done when the checks for what it touched pass, not when the frame looks right once.

## Sources

Each entry states only what the cited page states.

- W3C, *WebGPU Shading Language*, section 2.3.2, Filterable Triggering Rules
  (<https://www.w3.org/TR/WGSL/>). It lists the `derivative_uniformity` diagnostic, default
  severity error, triggered when a call to a built-in that computes derivatives (the derivative
  built-ins, `textureSample`, `textureSampleBias`, `textureSampleCompare`) is not proven to be in
  uniform control flow.
- three.js r187, `src/renderers/webgpu/nodes/WGSLNodeBuilder.js`: the builder writes
  `diagnostic( off, derivative_uniformity );` into the shaders it emits (read in the installed
  package; check it again after an upgrade).
- W3C, *WebGPU*, section 3.6.2, Limits (<https://www.w3.org/TR/webgpu/>). Default
  `maxSampledTexturesPerShaderStage` 16 and `maxStorageBuffersPerShaderStage` 8.
- three.js wiki, *Migration Guide* (<https://github.com/mrdoob/three.js/wiki/Migration-Guide>):
  a section per release step, headed `X → Y`, listing breaking changes, deprecations and renames.
