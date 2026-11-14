# three.js and WebGPU behaviour

These are the behaviours of three.js r186, WebGPU and TSL that the code is written around. Read
this page before you write or change TSL, a shader, a compute kernel or a pass of the frame graph:
most of these behaviours fail without an error, as a shader that draws nothing, a pipeline built at
the wrong time or a few pixels that move.

Each entry gives the behaviour, what the code does about it, where the code meets it and the check
that sees it. An entry marked **r186** is three's own behaviour at the pinned version: an upgrade
of three goes through each of them ([Upgrade three.js](../how-to/upgrade-three.md), step 11). The
code lint checks the entries that name a lint rule
(`tools/repo/lint/plugin.mjs`); the rest need judgement.

Module paths are under `packages/render/` unless they say otherwise.

Contents:

- [TSL](#tsl)
- [Screen and passes](#screen-and-passes)
- [Compiling and pipelines](#compiling-and-pipelines)
- [Buffers](#buffers)
- [The device and its queue](#the-device-and-its-queue)

## TSL

### The displaced position

Once `material.positionNode` is set, `positionLocal` reads the displaced position. Use
`positionGeometry` for the undisplaced one.

Check: none; judgement.

### Method forms of mix, step and smoothstep

**r186.** Three TSL methods take their receiver out of order: `t.mix( a, b )` is
mix( a, b, t ), `x.step( edge )` is step( edge, x ) and `x.smoothstep( low, high )` is
smoothstep( low, high, x ). Write the function form, imported from `three/tsl`
(`post/fsr3/Upsample.ts`, the comment on `ffxLerp`).

Check: the lint rule `ponlai/tsl-method-order`; `tools/render/wgsl-build.mjs` and the byte
comparison of the parity captures across an upgrade.

### select() of large operands

TSL may compile a `select()` of large operands into branches. A node first built inside one is
then declared in that branch only, and the shader silently draws nothing. Select between values
built before the `select()` (`.toVar()`), or blend with weights of exactly 0 or 1
(`ocean/Water.ts`, its vertex's previous position).

**r186.** A `.toVar()` made inside an `Fn` is emitted where it is made: it joins the function's
stack. One made outside an `Fn` has no stack to join, so its assignment is emitted where it is
first used, once per shader stage, and that can be inside a branch. Make the `.toVar()` inside the
`Fn` that builds the `select()` (`nodes/core/VarNode.js` `Var`, `nodes/tsl/TSLCore.js` `Stack`).

Check: none; judgement.

### Uniform control flow

Implicitly filtered texture samples and derivatives need uniform control flow. Take them
(`.toVar()`) before any `If` or `Loop`; inside branches and loops, sample with `.level()` or
`textureLoad`. Keep filters that take `dFdx` / `dFdy` out of `select()` and `If` branches
(`lighting/SolarShadow.ts`).

Check: none; judgement.

### Nested loops

Pass both ranges of a nested loop to one `Loop()` call, so the counters get distinct names.

Check: none; judgement.

### Shader functions

A helper called from several places is `Fn( ... ).setLayout( ... )`, so it compiles to one shader
function.

**r186.** A laid-out helper that reads uniforms in its body can be emitted with another build's
uniform names when two shaders that use it are built, compute kernels or materials: three emits
the function once and reuses its code with the first build's names, and the second shader fails
to compile. Pass the uniforms in as the helper's arguments, or keep it a
plain function expanded where it is called. Met between compute kernels (`post/fsr3/Common.ts`,
`sky/CloudKernels.ts`) and between materials (`post/PipelineDisplay.ts` `coolShare`, which broke
the rain's materials under taa; `vegetation/VegetationLighting.ts`; `lighting/LocalLights.ts`
`shadeLocalLights`). A material built twice, in two target layouts, meets it too
(`post/Motion.ts`).

Check: `tools/render/wgsl-build.mjs`; the byte comparison of the parity captures.

### Inline functions and varyings

An inline `Fn( ... )()` (no layout) is set up again in every stage that asks its type. One whose
value reaches a varying runs its statements in the fragment stage too, and what it reads there
becomes more varyings (the meadow went past WebGPU's sixteen under the temporal modes). A branch
whose result reaches a varying is a `Fn( ... ).setLayout( ... )` that takes its uniforms as
arguments (`packages/island/world/Grass.ts` builds its blade's vertex from plain nodes for this
reason).

Check: `tools/render/wgsl-build.mjs` reports a stage over WebGPU's limits.

### Several attachments

A `fragmentNode` that writes several attachments must be the `outputStruct( ... )` itself. One
returned from inside an `Fn` is emitted with a single output (`struct member m0 not found`). Build
the members in one `Fn` and return them as a matrix's columns (`post/TemporalAA.ts`
`neighbourhood`).

Check: none; the shader fails to compile.

### Bit-identical depth

**r186.** Programs that must produce bit-identical depth need `@invariant` on the clip position,
which three does not emit; the vegetation's depth prepass adds it
(`vegetation/VegetationPrepass.ts`). A material that instances from storage buffers holds the
placed position in a `toVar` (`vegetation/VegetationCull.ts`).

Check: `tools/render/wgsl-build.mjs` (the prepass's vertex shader); the byte comparison of the parity
captures.

## Screen and passes

### Screen conventions

Screen uv ( 0, 0 ) is the top-left corner, NDC y points up, and depth runs 0..1.

Check: none; judgement.

### A full-screen pass's camera

In a full-screen pass (`QuadMesh`, `RenderPipeline`) the camera nodes are the pass's own camera.
Pass the scene camera's matrices as uniforms.

Check: none; judgement.

### Multisampled depth

Multisampled depth is read with `textureLoad`, one sample at a time, the sample index in its level
argument; single-sampled, that argument is a mip level. More in `post/Pipeline.ts`.

Check: none; judgement.

### Sample counts

WebGPU multisamples with 1 or 4 samples only, and **r186** turns a count of 2 into 1, with no
MSAA. The scene's sample count comes from the anti-aliasing mode (`post/Antialiasing.ts`).

Check: the byte comparison of the parity captures.

### Depth textures

**r186.** A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so it is
declared multisampled and cannot be sampled with a comparison: give it a render target. three
picks one sampler type per depth texture per material (`lighting/SolarShadow.ts`).

Check: the byte comparison of the parity captures; `tools/render/verify-solar-shadows.mjs` (the sun's
shadow builds and filters).

### Shadow passes

Shadow passes keep `alphaTest` and `alphaMap` but not `map`. The vegetation draws before the
terrain (`renderOrder = -1`). See `vegetation/LeafTexture.ts` and `vegetation/Material.ts`.

Check: none; judgement.

### Vegetation's cut-outs

The vegetation's cut-outs are alpha to coverage under MSAA only. Find vegetation materials by
`userData.vegetation`, never by `alphaToCoverage`, which is off without multisampling
(`vegetation/Coverage.ts`, `post/Antialiasing.ts`).

Check: the lint rule `ponlai/vegetation-tag`.

### The water's textures

The water's fragment stage already samples 14 of the 16 textures WebGPU guarantees, so the water
samples neither the target it draws into nor a history or a reactive input: what the resolve needs
from it goes out through its velocity. A new mesh under the water, a swimmer, or a tall or offshore
opaque object tells the water (`ocean/Water.ts`;
[Materials](../bindings/building-cinematic-stylised-realism.md#materials)).

Check: none; judgement.

### Frame work on the graph

New frame work is a pass on the frame graph. Its targets are declared with a size class, and every
texture it binds is declared as a read: the attachment ops discard what nothing declares. It is
never an `rtt()` inside another pass's material, and never a call around the graph
(`post/Pipeline.ts`).

Check: the lint rule `ponlai/pass-on-graph` (`rtt()`, `convertToTexture()`);
`tools/render/verify-framegraph.mjs` (the declarations); the reads need judgement.

### The frame before

What a frame reads from the frame before (a history, the previous depth, an object's previous
matrix, a clock's step) advances once per rendered frame, not per draw or per tick. A texture's
history is declared on the graph: a ping-pong resource read through `previous()`, or a frame-end
`copyToPersistent` (single-sampled, same size class and format), never a `copyTextureToTexture` of
its own around the graph (`post/graph/GraphCompiler.ts`).

Check: the lint rule `ponlai/history-on-graph`; `tools/render/verify-framegraph.mjs`.

### Temporal modes

Under the temporal modes:

- Every scene material writes the velocity beside the colour (`post/Motion.ts`; how:
  [Materials](../bindings/building-cinematic-stylised-realism.md#materials)).
- The blend of each attachment comes only from the pass's own MRT (`post/Motion.ts` `sceneMRT`,
  `overlayMRT`), whatever a material's MRT node says.
- **r186.** A material drawn into two attachment layouts needs a pipeline per layout, which three's
  cache keys do not tell apart: it builds once per layout through the cache keys of
  `three/ThreePatches.ts` (`installCacheKeyPatches`).
- The scene passes (the graph's jittered span) see the camera's projection jittered by a fraction
  of a render pixel. Work keyed, culled or placed by the camera takes the unjittered projection
  (`jitter.uniforms.unjitteredProjection`): the sky dome, the grass cull, the haze's froxel grid and
  the light shafts' sun do (`post/Jitter.ts`).

A new site that changes the scene in a way its frames do not show (a seek, a jump, a new scene, a
control that retunes a paused frame) raises a scene event (`post/SceneEvents.ts`).

Check: `tools/render/verify-frame-graph-gpu.mjs` (the layouts); the rest needs judgement.

### Split draws

The same triangles drawn in one draw or split over several (a mesh per chunk, or draw ranges)
shade about 1 % of their pixels a level or two apart: multisampled fragments and derivative quads
form within a draw. Byte comparisons hold between equal splits only
(`packages/island/world/World.ts`).

Derivative quads do not repeat either: the same draw with the same inputs can take `dFdx` /
`dFdy` a last bit apart from one run to the next while the GPU is busy with other work. A pass drawn
every frame overwrites such a difference on the next frame; a result drawn once and kept (a bake
on the first frame, the busiest) takes no screen derivatives where their last bit shows
(`packages/render/ocean/WaveMaps.ts`, the caustics' splats).

Check: none; judgement.

## Compiling and pipelines

### Compiling ahead

**r186.** `renderer.compileAsync` alone does not compile what a render draws (its target, MRT,
side, call depth, a render context shared by targets of the same attachments). Compile ahead
through the frame graph's warm-up, and register a draw that shows only at times as a latent of its
pass (`post/graph/FrameGraph.ts`, `post/graph/Compile.ts`, `three/DrawBuilds.ts`; a shadow map's
draws with `compileLatentInto`). The warm-up's priming renders only what keeps no state and never
leaves a persistent resource written (`fgPrime=0` turns it off).

A render three makes of its own that cannot be compiled before its first frame (the sun's map,
built with the first receiver) compiles by rendering it once with asynchronous pipelines
(`compileByRendering`, `lighting/SunShadow.ts`).

Check: `tools/render/verify-frame-graph-gpu.mjs`, `tools/render/verify-first-use.mjs`.

### Build order

**r186.** The order materials first build in is part of the image: three emits a shader from node
state the builds share, so compiling draws ahead in another order than the frame builds them
changed other materials' code and moved a few pixels by one level. The first lit build also makes
nodes every receiver shares (the shadow's graph, the camera's world matrix) and emits other code
than the later ones: a throwaway receiver builds them before the loop (`three/ThreePatches.ts`
`primeSharedNodes`), so a receiver's code, and a kind's pipeline count, does not depend on which
draws first.

Check: the byte comparison of the parity captures (`tools/kit/parity/capture-set.mjs`) and the scene
jump (`tools/island/verify-scene-jump.mjs`).

### Draws skipped while compiling

**r186.** A draw whose pipeline an asynchronous compile is still creating is skipped without a
word (`Pipelines.isReady`), so a one-time render such as a bake waits for the warm-up that compiles
it (`sky/Sky.ts` `warm`, `post/graph/Compile.ts` `compileByRendering`).

Check: `tools/render/verify-first-use.mjs`; the byte comparison of the parity captures.

### Compute kernels

A compute kernel dispatched by a target's size is rebuilt with new pipelines whenever the size
changes, at every step of high's dynamic scale: size it from something fixed, or keep it a render
pass. A kernel with `workgroupBarrier()` is dispatched by size, not by a thread count
(`ocean/OceanFFT.ts`).

Check: none; judgement.

## Buffers

### Storage buffers

**r186.** A storage buffer cannot grow in place: a larger array fails its `writeBuffer`. A new
`StorageBufferAttribute` as each reading storage node's `value` takes new bind groups and no
pipeline, compute or render, because the shaders declare runtime-sized arrays
(`vegetation/VegetationCull.ts`).

Check: `tools/render/verify-storage-realloc.mjs`.

### Instance matrices

**r186.** Up to 1024 instances three keeps the matrices in a uniform array of exactly the
capacity, which the shader names, so a fixed capacity keeps one shader
(`vegetation/Instances.ts`).

Check: `tools/island/verify-growth-swap.mjs` (a swap builds no pipeline).

### Index buffers

**r186.** A 16-bit index is copied into a new 32-bit array when its GPU buffer is created, and the
copy is uploaded from then on: an index rewritten in place must be a `Uint32Array`
(`util/Upload.ts`, the merged kinds' indices).

Check: `tools/island/verify-growth-swap.mjs`.

### Attribute usage

**r186.** `DynamicDrawUsage` re-uploads the whole buffer on every draw. Leave attributes that
change once per event at static usage, with update ranges.

Check: the lint rule `ponlai/no-dynamic-draw`.

## The device and its queue

### Submits and encoders

`post/SubmitBatch.ts` wraps the device, the queue and the encoders and holds command buffers: raw
WebGPU work and new queue operations go through its rules, and one invalid command buffer loses
its whole batch. `post/graph/AttachmentOps.ts` wraps the encoders too: a wrapper that hands out
encoders of its own must be installed before it.

**r186.** Each render pass begins on a command encoder of its own, made in `beginRender`, which
`post/graph/AttachmentOps.ts` relies on.

Check: the frame graph's dev check on the dev server (`opsMismatchFrames` in the diagnostics'
`graph`); the byte comparison of the parity captures.

### Timestamps

Timestamp queries (`trackTimestamp`) have one owner at a time (`post/DynamicResolution.ts`).
three resolves them into one buffer and drops what it resolves while that buffer is mapped, and
the owner takes over the pools' `resolveQueriesAsync`, so a second reader takes readings from the
first.

The owner is chosen once, when a running scene sets up its frame
(`packages/render/assemble/SceneFrame.ts`). It is the dynamic resolution's timer (`GpuFrameTimer` in
`post/DynamicResolution.ts`; none under `?gpuTimer=off`). Under `?profile` with the GPU timestamps
on (not `?profile=frames`) the frame profiler (`debug/FrameProfiler.ts`) owns them instead, for the
whole load: no `GpuFrameTimer` is made, and the profiler hands each frame's GPU time to the dynamic
resolution from its own readings. Only these two modules and the wrappers in `three/` reach the
queries.

Check: the lint rule `ponlai/timestamp-owner`.
