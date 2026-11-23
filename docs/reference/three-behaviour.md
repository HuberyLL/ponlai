# three.js and WebGPU behaviour

These are the behaviours of three.js r187, WebGPU and TSL that the code is written around. Read
this page before you write or change TSL, a shader, a compute kernel or a pass of the frame graph:
most of these behaviours fail without an error. The failure shows as a shader that draws nothing,
a pipeline built at the wrong time or a few pixels that change.

Each entry gives the behaviour, what the code does about it, where in the code it occurs and the
check that detects it. An entry marked **r187** is three.js's own behaviour at the pinned version.
When you upgrade three.js, recheck each of these entries
([Upgrade three.js](../../packages/render/three/README.md), step 11). The code lint checks the
entries that name a lint rule (`tools/repo/lint/plugin.mjs`); the rest need judgement.

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

**r187.** Three TSL methods take their receiver out of order: `t.mix( a, b )` is
mix( a, b, t ), `x.step( edge )` is step( edge, x ) and `x.smoothstep( low, high )` is
smoothstep( low, high, x ). Write the function form, imported from `three/tsl`
(`post/fsr3/Upsample.ts`, the comment on `ffxLerp`).

Check: the lint rule `ponlai/tsl-method-order`; `tools/render/wgsl-build.mjs` and the byte
comparison of the parity captures across an upgrade.

### select() of large operands

TSL may compile a `select()` of large operands into branches. A node that is first built inside one
of those branches is then declared in that branch only, and the shader silently draws nothing.
Select between values built before the `select()` (`.toVar()`), or blend with weights of exactly 0
or 1 (`ocean/Water.ts`, the previous position of its vertex).

**r187.** A `.toVar()` made inside an `Fn` is emitted where it is made: it joins the function's
stack. One made outside an `Fn` has no stack to join, so its assignment is emitted where it is
first used, and that can be inside a branch; inside a `Loop` it is declared before the outermost
loop (`nodes/core/Node.js` `_updateAssignable`, `NodeBuilder.declareBeforeBlock`). Make the
`.toVar()` inside the `Fn` that builds the `select()`.

**r187.** A `select()` by a scalar condition is always an `if` / `else` (unless the build's context
sets `uniformFlow`), and its operands are built inside the branches. A node first built in one
branch is built again in every block that cannot see it: the shader compiles and draws, but does
the work twice or more, such as a nest of debug switches repeating eight texture taps. A
`select()` by a vector condition (`bvec3( c )`, or a vector `lessThan`) is WGSL's `select()`,
straight-line code with both operands built once. Choose by a vector condition
(`materials/Select.ts`, whose helpers hold the cast three's types need), or blend by a weight of
exactly 0 or 1. To find a case, build the shaders to WGSL
(`tools/render/wgsl-build.mjs`) and compare the counts of samples and calls with the previous
release.

Check: none; judgement.

### Uniform control flow

Implicitly filtered texture samples and derivatives need uniform control flow. Take them
(`.toVar()`) before any `If` or `Loop`; inside branches and loops, sample with `.level()` or
`textureLoad`. Keep filters that take `dFdx` / `dFdy` out of `select()` and `If` branches
(`lighting/SolarShadow.ts`).

**r187.** A `.toVar()` that only a sample's `.grad()` reads is declared where it is first read,
not where it was made. The texture node keeps its two gradients as a plain array, so the build's
analysis never records them as readers. The stack then skips a variable whose only reader is the
stack (a rule meant for variables read only by `toVarying`). As a result, a derivative read only by
a gradient sample inside a branch moves into that branch. Assign it before the branch instead
(`vec2( 0 ).toVar().assign( dFdx( q ) )`): an assignment is emitted where it is made
(`ocean/Water.ts`, the footprint of the refracted ray's end point).

Check: none; judgement.

### Nested loops

Pass both ranges of a nested loop to one `Loop()` call, so the counters get distinct names.

Check: none; judgement.

### Long loops

A JavaScript `for` loop around TSL unrolls its body into the shader once per step. Write a loop of
more than a few steps that holds texture loads as a `Loop()`, so the shader holds the body once.

**r187.** The meadow's ground ran its sixty-four unrolled screen-space shadow lookups
(`post/MeadowShadows.ts`) about three times as long as under r186, with the same WGSL apart from
names and the same pixels drawn. As a `Loop()`, it runs faster than the unrolled form did under
r186.

Check: none; judgement.

### Shader functions

A helper called from several places is `Fn( ... ).setLayout( ... )`, so it compiles to one shader
function.

**r187.** A laid-out helper that reads uniforms in its body can be emitted with another build's
uniform names. This happens when two shaders that use it are built, whether compute kernels or
materials: three.js emits the function once and reuses its code with the first build's names, and
the second shader fails to compile. Pass the uniforms in as the helper's arguments, or keep it a
plain function expanded where it is called. This has occurred between compute kernels
(`post/fsr3/Common.ts`, `sky/CloudKernels.ts`) and between materials (`post/PipelineDisplay.ts`
`coolShare`, which broke the rain's materials under TAA; `vegetation/VegetationLighting.ts`;
`lighting/LocalLights.ts` `shadeLocalLights`). A material built twice, for two render-target
layouts, is affected too (`post/Motion.ts`).

Check: `tools/render/wgsl-build.mjs`; the byte comparison of the parity captures.

### Inline functions and varyings

An inline `Fn( ... )()` (no layout) is set up again in every shader stage that asks for its type.
If its value reaches a varying, its statements run in the fragment stage too, and what it reads
there becomes more varyings (under the temporal modes, the meadow went past WebGPU's limit of
sixteen). Write a branch whose result reaches a varying as a `Fn( ... ).setLayout( ... )` that takes
its uniforms as arguments (for this reason, `packages/island/world/Grass.ts` builds the vertex of
its blade from plain nodes).

Check: `tools/render/wgsl-build.mjs` reports a stage over WebGPU's limits.

### Multiple render targets

A `fragmentNode` that writes multiple render targets (MRT) must be the `outputStruct( ... )` itself.
An `outputStruct` returned from inside an `Fn` is emitted with a single output (`struct member m0
not found`). Build the members in one `Fn` and return them as a matrix's columns
(`post/TemporalAA.ts` `neighbourhood`).

Check: none; the shader fails to compile.

### Bit-identical depth

**r187.** Programs that must produce bit-identical depth need `@invariant` on the clip position.
three.js emits it only for a node builder whose context asks for it, which a material cannot set;
the vegetation's depth prepass adds it
(`vegetation/VegetationPrepass.ts`). A material that instances from storage buffers holds the
placed position in a `toVar` (`vegetation/VegetationCull.ts`).

Check: `tools/render/wgsl-build.mjs` (the prepass's vertex shader); the byte comparison of the
parity captures.

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
argument. For single-sampled depth, that argument is a mip level. More in `post/Pipeline.ts`.

Check: none; judgement.

### Sample counts

WebGPU multisamples with 1 or 4 samples only, and **r187** turns a sample count of 2 into 1, which
means no MSAA. The scene's sample count comes from the anti-aliasing mode (`post/Antialiasing.ts`).

Check: the byte comparison of the parity captures.

### Depth textures

**r187.** A `DepthTexture` without a `RenderTarget` takes the renderer's sample count, so it is
declared multisampled and cannot be sampled with a comparison: give it a render target. three.js
picks one sampler type per depth texture per material (`lighting/SolarShadow.ts`). A render target
has a colour texture unless it is made with `count: 0`, so a target drawn only for its depth takes
`count: 0` (`lighting/SunShadow.ts`).

Check: the byte comparison of the parity captures; `tools/render/verify-solar-shadows.mjs` (it
builds and filters the sun's shadow).

### Shadow passes

Shadow passes keep `alphaTest` and `alphaMap` but not `map`. The vegetation draws before the
terrain (`renderOrder = -1`). See `vegetation/LeafTexture.ts` and `vegetation/Material.ts`.

Check: none; judgement.

### Vegetation's cut-outs

The vegetation's cut-outs use alpha to coverage under MSAA only. Find vegetation materials by
`userData.vegetation`, never by `alphaToCoverage`, which is off without multisampling
(`vegetation/Coverage.ts`, `post/Antialiasing.ts`).

Check: the lint rule `ponlai/vegetation-tag`.

### The water's textures

The water's fragment stage already samples 15 of the 16 textures WebGPU guarantees. It reads one
history: the sea reflection's result, read by `textureLoad` at the water's own pixel. Besides that,
the water samples neither the render target it draws into nor another history or a reactive input;
what the temporal resolve needs from it goes out through its velocity. A new mesh under the water,
a swimmer, or a tall or offshore opaque object registers with the water system (`ocean/Water.ts`;
[Materials](../bindings/building-cinematic-stylised-realism.md#materials)).

Check: none; judgement.

### Frame work on the graph

Add new per-frame GPU work as a pass on the frame graph. Declare its render targets with a size
class, and declare every texture it binds as a read: the attachment load and store operations
discard what nothing declares. Never add it as an `rtt()` inside another pass's material, or as a
call made outside the graph (`post/Pipeline.ts`).

Check: the lint rule `ponlai/pass-on-graph` (`rtt()`, `convertToTexture()`);
`tools/render/verify-framegraph.mjs` (the declarations); the reads need judgement.

### Previous-frame data

Data that a frame reads from the previous frame (a history, the previous depth, an object's
previous matrix, a clock's step) advances once per rendered frame, not once per draw or per tick.
Declare a texture's history on the graph, either as a ping-pong resource read through `previous()`
or as a frame-end `copyToPersistent` (single-sampled, same size class and format). Never write a
`copyTextureToTexture` of your own outside the graph (`post/graph/GraphCompiler.ts`).

Check: the lint rule `ponlai/history-on-graph`; `tools/render/verify-framegraph.mjs`.

### Temporal modes

Under the temporal modes:

- Every scene material writes the velocity alongside the colour (`post/Motion.ts`; how:
  [Materials](../bindings/building-cinematic-stylised-realism.md#materials)).
- The blend state of each render target comes only from the pass's own MRT (`post/Motion.ts`
  `sceneMRT`, `overlayMRT`), whatever a material's MRT node says.
- An MRT and its pass's render target are a pair. three.js keys a draw's build by the MRT and its
  pipeline by the first attachment's format, not by the later attachments' names or the MRT's
  blend per attachment. So every output of a pass's MRT names one of the pass's attachments, every
  pass that draws with one MRT has the same attachments in the same order
  (`post/graph/GraphCompiler.ts` `checkMrt`), and a material is never drawn under two MRTs that
  blend differently (`three/DrawBuilds.ts`, which refuses it in the warm-up). A material whose
  attachments blend differently by draw takes `MaterialBlending` on its MRT.
- The scene passes (the graph's jittered span) see the camera's projection jittered by a fraction
  of a render pixel. Work that the camera keys, culls or places uses the unjittered projection
  (`jitter.uniforms.unjitteredProjection`). The sky dome, the grass culling, the haze's froxel grid
  and the sun of the light shafts all do (`post/Jitter.ts`).

Code that changes the scene in a way its frames do not show (a seek, a jump, a new scene, a
control that retunes a paused frame) raises a scene event (`post/SceneEvents.ts`).

Check: `tools/render/verify-framegraph.mjs` (the MRT and its target),
`tools/render/verify-frame-graph-gpu.mjs` (the blends and the layouts); the rest needs judgement.

### Split draws

The same triangles drawn in one draw or split over several (a mesh per chunk, or draw ranges)
shade about 1 % of their pixels one or two levels apart, because multisampled fragments and
derivative quads form within a draw. Byte comparisons hold between equal splits only
(`packages/island/world/World.ts`).

Derivative quads are not deterministic either. While the GPU is busy with other work, the same
draw with the same inputs can compute `dFdx` / `dFdy` one last bit apart from one run to the next.
A pass drawn every frame overwrites such a difference on the next frame. A result drawn once and
kept (a bake on the first frame, which is the busiest) takes no screen-space derivatives where their
last bit would show (`packages/render/ocean/WaveMaps.ts`, the caustics' splats).

Check: none; judgement.

## Compiling and pipelines

### Pipeline precompilation

**r187.** `renderer.compileAsync` builds each draw under the render target, MRT, render context
and side it was queued with, but at the depth of its own call and without the vertex node that
`QuadMesh.render` sets, and it returns no node states. Precompile pipelines through the frame
graph's warm-up. Register a draw that appears only some of the time as a latent draw of its pass
(`post/graph/FrameGraph.ts`, `post/graph/Compile.ts`, `three/DrawBuilds.ts`; register a shadow
map's draws with `compileLatentInto`). The warm-up's priming renders only what keeps no state, and
it never leaves a persistent resource written (`fgPrime=0` turns priming off).

Some renders that three.js makes on its own cannot be compiled before their first frame, such as
the sun's shadow map, which is built with the first receiver. These compile by rendering once with
asynchronous pipelines (`compileByRendering`, `lighting/SunShadow.ts`).

Check: `tools/render/verify-frame-graph-gpu.mjs`, `tools/render/verify-first-use.mjs`.

### Build order

**r187.** The order in which materials first build affects the rendered image. three.js emits a
shader from node state that the builds share, so precompiling draws in a different order from the
one the frame builds them in changed other materials' code and changed a few pixels by one level.
The first lit build also makes nodes that every shadow receiver shares (the shadow's node graph,
the camera's world matrix), and it emits different code from the later builds. A throwaway receiver
builds these nodes before the loop (`three/ThreePatches.ts` `primeSharedNodes`). As a result, a
receiver's code, and the pipeline count of a kind, do not depend on which draw comes first.

Check: the byte comparison of the parity captures (`tools/kit/parity/capture-set.mjs`) and the
scene jump check (`tools/island/verify-scene-jump.mjs`).

### Draws skipped while compiling

**r187.** A draw whose pipeline an asynchronous compile is still creating is skipped silently
(`Pipelines.isReady`). A one-time render, such as a bake, therefore waits for the warm-up that
compiles it (`sky/Sky.ts` `warm`, `post/graph/Compile.ts` `compileByRendering`).

Check: `tools/render/verify-first-use.mjs`; the byte comparison of the parity captures.

### Compute kernels

A compute kernel dispatched by a render target's size is rebuilt with new pipelines whenever the
size changes, which happens at every step of the high tier's dynamic resolution. Size it from
something fixed, or keep it a render pass. Dispatch a kernel with `workgroupBarrier()` by size, not
by a thread count
(`ocean/OceanFFT.ts`).

Check: none; judgement.

## Buffers

### Storage buffers

**r187.** A storage buffer cannot grow in place: a larger array fails its `writeBuffer`. Instead,
set a new `StorageBufferAttribute` as the `value` of each storage node that reads it. This needs
new bind groups but no new pipeline, compute or render, because the shaders declare runtime-sized
arrays
(`vegetation/VegetationCull.ts`).

Check: `tools/render/verify-storage-realloc.mjs`.

### Instance matrices

**r187.** three.js binds an instanced mesh's matrices (and colours) as per-instance vertex
attributes when the geometry's attributes and the instance buffers fit in 8 vertex buffers; the
shader then does not depend on the capacity. Otherwise, up to 1024 instances, it keeps the matrices
in a uniform array whose length is exactly the capacity, the shader states that length, and each
mesh builds its own shader (`nodes/accessors/Instance.js`). A fixed capacity keeps one shader on
either path (`vegetation/Instances.ts`).

Check: `tools/island/verify-growth-swap.mjs` (a swap builds no pipeline).

### Index buffers

**r187.** An 8-bit index, and a 16-bit index that is also a storage buffer, is copied into a new
wider array when its GPU buffer is created, and from then on the copy is uploaded. An index
rewritten in place must therefore be a `Uint32Array` (`util/Upload.ts`, the merged kinds'
indices).

Check: `tools/island/verify-growth-swap.mjs`.

### Attribute usage

**r187.** `DynamicDrawUsage` re-uploads the whole buffer on every draw. Leave attributes that
change once per event at static usage, with update ranges.

Check: the lint rule `ponlai/no-dynamic-draw`.

## The device and its queue

### Submits and encoders

`post/SubmitBatch.ts` wraps the device, the queue and the command encoders, and it holds command
buffers. Raw WebGPU work and new queue operations follow its rules, and one invalid command buffer
loses its whole batch. `post/graph/AttachmentOps.ts` wraps the encoders too: a wrapper that hands
out encoders of its own must be installed before it.

**r187.** Each render pass begins on a command encoder of its own, made in `beginRender`, which
`post/graph/AttachmentOps.ts` relies on.

Check: the frame graph's dev check on the dev server (`opsMismatchFrames` in the diagnostics'
`graph`); the byte comparison of the parity captures.

### Timestamps

Timestamp queries (`trackTimestamp`) have one owner at a time (`post/DynamicResolution.ts`).
three.js resolves them into one buffer and drops what it resolves while that buffer is mapped. The
owner takes over the query pools' `resolveQueriesAsync`, so a second reader would take readings
away from the first.

The owner is chosen once, when a running scene sets up its frame
(`packages/render/assemble/SceneFrame.ts`). It is the dynamic resolution's timer (`GpuFrameTimer` in
`post/DynamicResolution.ts`; none under `?gpuTimer=off`). Under `?profile` with the GPU timestamps
on (not `?profile=frames`) the frame profiler (`debug/FrameProfiler.ts`) owns them instead, for the
whole load: no `GpuFrameTimer` is made, and the profiler hands each frame's GPU time to the dynamic
resolution from its own readings. Only these two modules and the wrappers in `three/` access the
queries.

Check: the lint rule `ponlai/timestamp-owner`.

### Draw counts

`renderer.info.render`'s `drawCalls` and `triangles` count only direct draws: an indirect draw
(`geometry.indirect`: the culled plants' and the meadow's) adds nothing, as its counts live on the GPU
(`WebGPUBackend.draw`). The frame profiler's draw calls and triangles (`debug/FrameProfiler.ts`)
therefore leave out the vegetation drawn through the culling kernels. **r187.** The counts fell
when three stopped adding the CPU side's estimate for each indirect draw; the GPU's work did not
change.

Check: none; judgement.

### Readbacks

`renderer.readRenderTargetPixelsAsync` returns the rows tightly packed, `width * channels` values
each: three copies the texture into a buffer whose rows are padded to 256 bytes and removes the
padding before it returns (`WebGPUTextureUtils.copyTextureToBuffer`). Code that indexes the result
with a padded stride places every texel of a target whose row is not a multiple of 256 bytes
wrongly, with no error. **r187.** Before r187 the rows came back padded.

Check: `debug/RadianceAov.ts` `readTexture` and `tools/island/meadow-light.mjs` throw when the
result's length is not `width * height * channels`. Read a target through `readTexture`.
