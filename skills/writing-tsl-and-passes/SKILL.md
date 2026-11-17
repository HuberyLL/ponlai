---
name: writing-tsl-and-passes
description: Writes or changes TSL shaders, compute kernels, render passes and GPU buffers on three.js's WebGPURenderer without the failures that give no error, such as a shader that draws nothing, a helper emitted with another shader's uniform names, derivatives taken in a branch, a stage over WebGPU's limits, a pass whose input was discarded, a draw skipped while its pipeline compiles, or a few pixels that change between equivalent builds. Before writing, reads the project's page of three.js behaviour for what the change touches; builds the shaders to WGSL in Node.js to see what three.js generated; runs the renderer's small test scenes before the full scene; then runs the checks that detect each silent failure. Use with three.js WebGPURenderer (three/webgpu, three/tsl) whenever TSL, a node material, a compute kernel, a render pass, a render target or a GPU buffer is written or changed.
---

# Writing TSL and passes

Most of what goes wrong in TSL and WebGPU passes gives no error: the console stays clean and the
frame is wrong, or it is right today and wrong after an unrelated edit. This skill is the working
method around the project's page of three.js behaviour: read the entries for what you touch, look at
the code three.js generated, test on small scenes, run the checks that detect silent failures, and
record what you find.

## Rules most often broken without notice

- Read the behaviour page's entries for each thing the change touches before you write a line
  (step 1). Most of them fail without an error.
- No error is not success. A shader that builds can draw nothing, read undefined derivatives or
  be skipped. Judge a change by the WGSL that three.js generated and by what the frame shows.
- The behaviour is version-bound. Entries were written against one three.js release; on another,
  treat every version-marked entry as unverified until its check has run (step 2).
- Take derivatives and implicitly filtered samples (`dFdx`, `fwidth`, `texture()` without a
  level) only in uniform control flow: take them before any `If`, `Loop` or `select()`, and inside
  a branch, sample with an explicit level. WGSL makes this an error by default
  (`derivative_uniformity`), but three.js's WGSL builder turns that diagnostic off at r186. A wrong
  one therefore compiles, and its pixels change with unrelated edits.
- A helper used by several shaders takes the uniforms it reads as arguments. A laid-out `Fn`
  that reads a uniform in its body can be emitted with the first build's uniform names, and the
  second shader fails to compile only where both are built.
- Add new per-frame GPU work as a pass of the renderer's frame graph, with every read declared.
  Never add it as a render-to-texture call inside a material or a render call outside the graph.
  The attachment load and store operations can discard an undeclared read.
- A pass or kernel that keeps state across frames (a history, an accumulation, a bake drawn once)
  follows the project's rules for the test mode and scene jumps (step 3).
- Never start a GPU tool to see its options: read its header. A GPU run goes through the
  project's GPU rules (binding: Checks).

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: where its behaviour page is and which of
its entries go with which kind of work, the pinned three.js version, how to build WGSL in Node.js,
its test scenes, its checks and where a new finding is written. Read section X of
`docs/bindings/writing-tsl-and-passes.md` when you reach the step. If the project's `AGENTS.md` or
`CLAUDE.md` names another file for this skill, that file wins.

No binding: find each fact in the project (a docs page on three.js or WebGPU pitfalls, the shader
rules in `AGENTS.md`, the tools folder, the three.js version in `package.json`) and ask the user for
what you cannot find. If the project keeps no behaviour page, start one with the first silent
failure you meet (step 7). When the work ends, offer to write what you found as the binding, one
section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Name what the change touches and read first
- [ ] 2. Check the three.js version
- [ ] 3. Write it in the forms that do not fail silently
- [ ] 4. Build to WGSL and read what three.js generated
- [ ] 5. Small test scenes first
- [ ] 6. The checks that see silent failures
- [ ] 7. Record what you found
```

### 1. Name what the change touches and read first (binding: Read first)

1. List what the change touches: TSL nodes in a material, a shared helper `Fn`, a varying, multiple
   render targets (MRT), a compute kernel, a full-screen pass, a render target or depth texture, a
   history, a storage buffer, instancing, an index or attribute buffer, raw WebGPU calls, timestamp
   queries.
2. For each, read its entries on the behaviour page (the binding maps each kind to its sections),
   and the header comment of each module you change.
3. Read how the renderer takes new work (the project's guide for adding a pass, a plant kind or a
   light): what each must declare.

### 2. Check the three.js version (binding: Version)

1. Compare the installed three.js (`node_modules/three/package.json`) with the version the
   behaviour page names. If they match, go on.
2. If they differ, every entry marked with the old version is unverified. Run each entry's check
   before you rely on it, and follow the project's upgrade guide; the three.js migration guide lists
   the breaking changes per release (`X → Y`).

### 3. Write it in the forms that do not fail silently (binding: Write)

The behaviour page gives each form and the reason for it. These are the ones you meet most often:

- Write TSL's `mix`, `step` and `smoothstep` in the function form: the method forms take the
  receiver out of order (`t.mix( a, b )` is `mix( a, b, t )`).
- Make `select()` pick between values built before it (`.toVar()` inside the same `Fn`). A node
  first built inside a `select()` of large operands can be declared in one branch only, and the
  shader then draws nothing. Outside an `Fn` (a node assigned straight to a material's colour), a
  `.toVar()` is emitted where it is first used, which can be inside the branch, and this includes
  derivatives. Build the `select()` and its operands in one `Fn`, then check the order in the WGSL
  (step 4).
- Write a branch whose result reaches a varying as a laid-out `Fn` (`.setLayout`). An inline `Fn`
  is set up again in the fragment stage, and what it reads there becomes more varyings.
- A fragment node that writes multiple render targets must be the `outputStruct( ... )` itself.
- A full-screen pass sees its own camera: pass the scene camera's matrices as uniforms.
- Size a compute kernel from something fixed. A kernel sized by a render target that resizes is
  rebuilt with new pipelines at every resize.
- Buffers: a storage buffer grows by a new attribute, not in place; an instanced kind keeps a
  fixed capacity; an index rewritten in place is a `Uint32Array`; attributes that change once per
  event keep static usage with update ranges.
- A one-time render (a bake) waits for its pipelines: a draw whose pipeline is still compiling
  asynchronously is skipped silently.
- State across frames: declare a history on the graph, where it advances once per rendered frame.
  A scene jump clears it. The page's ready signal waits for it to converge, or the test mode
  freezes it.

### 4. Build to WGSL and read what three.js generated (binding: WGSL build)

Before you open a page, build the shaders you changed in Node.js, with no GPU. Use the project's
entry for that module, or write one that builds them in the same order as the page does. three.js
emits code from state that its builds share, so the order affects the output.

Read the output for:

- every stage built (a build error names the node that has no type or input);
- a node your code uses outside a branch that is declared inside one;
- derivatives or implicit samples inside an `if` or a loop;
- the uniform names a shared helper reads, against the uniforms this shader declares;
- the varyings, sampled textures, storage buffers and attachments per stage, against WebGPU's
  default limits (16 inter-stage variables, 16 sampled textures, 8 storage buffers per stage);
- for a refactor, a diff against the WGSL of the previous commit: only the node numbers may differ.

The build does not validate the WGSL: a shader that builds can still fail on the device. Step 6
catches that.

### 5. Small test scenes first (binding: Test scenes)

1. Before the change, write the test scenes' references on the commit that the change starts
   from.
2. After the change, capture the scenes again and compare them by decoded pixels. A refactor passes
   when every capture is identical. A change meant to change the rendered image differs where it
   should and nowhere else: read the scenes' readings side by side, and look at each capture that
   differs.
3. Then test the full scene. The small scenes load in seconds and the full scene in minutes, and
   the small ones isolate the renderer from the content.

### 6. The checks that see silent failures (binding: Checks)

Run the checks for what you touched; each one detects a failure that produces no error:

| What you touched | The failure it hides | What detects it |
| --- | --- | --- |
| A material or pass drawn later, only some of the time, or after an event | A pipeline built mid-frame (a stall) or a draw skipped | A first-use check: no pipeline created after the warm-up |
| A pass, its render targets or reads | A read discarded, a render-target layout without its pipeline | The frame graph's checks |
| A buffer that grows or is rewritten | A failed write, a new pipeline on a swap | A reallocation probe, a swap check |
| Anything kept across frames | A history that outlives a scene jump; a ready signal that comes too early | A scene-jump check, still frames captured more than once |
| Anything | A few pixels changed by build order or a split draw | Byte comparison of still frames against references |

Also read the browser console on a real page for WebGPU validation errors: the WGSL build does
not catch them.

### When a draw shows nothing, or pixels change

Work from the symptom; change nothing until you know which cause it is.

| Symptom | Look first at |
| --- | --- |
| A mesh or pass draws nothing, no error | The WGSL (step 4): a value declared in a branch; a varying past the limit; an MRT output missing; a draw skipped while compiling (a one-time render) |
| One shader fails to compile only beside another | A shared helper reading uniforms in its body |
| A few pixels change between equivalent builds | Derivatives or implicit samples in non-uniform control flow; build order; draws split differently |
| Something vanishes for one frame after a resize or a dynamic-resolution step | A render target re-created and cleared, or its depth cleared before a pass that loads it |
| Equal-depth tests fail on a few samples | Two programs that place vertices differently: the clip position needs `@invariant` |
| The frame differs between runs of the same build | Not this skill: `diagnosing-nondeterministic-frames` |
| A defect on screen whose part is not yet known | Not this skill: `diagnosing-visual-defects` |

### 7. Record what you found (binding: Record)

- A behaviour of three.js or WebGPU that you met and the page lacks: add an entry with the
  behaviour, what the code does about it, where in the code it occurs and the check that detects
  it. Mark it with the three.js version when it is three.js's own behaviour.
- A rule that can be checked becomes a check (a lint rule, a verify tool) in the same change.
- The module's rule and its reason go into its header comment.

Why the method works this way, the cases it comes from and the sources:
[background.md](background.md).
