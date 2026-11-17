---
name: diagnosing-nondeterministic-frames
description: Diagnoses a rendered frame that should be bit-identical between runs but is not, such as a paused, test-mode or golden-image screenshot that differs between runs or fresh loads of the same build by a few pixels, a flaky visual or byte-for-byte test, or a render target whose contents differ between loads. Finds the GPU result that varies and the operation that makes it vary, fixes the cause at its source and proves the fix with a run count. Use with WebGPU or WebGL renderers (three.js first) whenever the same inputs give different pixels.
---

# Diagnosing nondeterministic frames

A frame that should be bit-identical between runs differs. The method: measure how often it
differs, hash every GPU result to find the first one that differs, decide whether its inputs or its
draw vary, isolate the operation, fix it at the source, and prove the fix with a run count.

## Rules for the whole diagnosis

- Never make the comparison pass by masking the difference: no wider tolerance, no retry until it
  passes, no longer wait, and no "GPU noise" verdict before you name the operation that varies.
  Masking hides a cause that comes back. Whether to accept a tolerance is the project owner's
  decision, made after the cause is known.
- Measure before you guess. End every step in a count (k of n runs differ) or a table of hashes,
  and write it down with the command that produced it. Before the next step builds on a hypothesis
  that you read from the code, check it by an experiment.
- Compare decoded pixels or raw texture bytes, never encoded image files.
- Change one thing per experiment, on the same build and server, and keep every run's output.
- First suspect what is drawn once and kept: bakes, caches, first-frame setup and converged history.
  A result redrawn every frame from equal inputs overwrites a one-off difference. A kept result
  carries the difference into every later frame, and the first frames after a load are the busiest.
- Prove a fix by a run count chosen from the measured rate (step 7), not by a few passing runs.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: how to open a still frame and know that
it is final, how to capture and compare, how to run code in the page and reach the renderer, the
rules for using the GPU, earlier causes, and who accepts new reference images. Read them when you
reach that step, not before, from section X of the project's binding for this skill:
`docs/bindings/diagnosing-nondeterministic-frames.md`. If the project's `AGENTS.md` or `CLAUDE.md`
names another file for this skill, that file wins.

If there is no binding, find each fact in the project (the README, package scripts, test
configuration, the debug globals that the page exposes) and ask the user for what you cannot find.
When the diagnosis ends, offer to write what you found as the binding, one section per step, so the
next diagnosis starts there.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Reproduce and measure the rate
- [ ] 2. Hash every GPU result on fresh runs
- [ ] 3. Pick the first result that differs
- [ ] 4. Tell its inputs from its draw
- [ ] 5. Isolate the operation
- [ ] 6. Fix at the source
- [ ] 7. Prove the fix
```

### 1. Reproduce and measure the rate (binding: Reproduce)

1. Take the cheapest page that shows the difference: the smallest test scene and one view, in the
   project's still or test mode. Read the binding's earlier causes, and check first any cause whose
   fingerprint matches.
2. Load the page fresh n times (start with 8 to 12) on one build and server, and compare each run
   with the first. Write down k of n.
3. Find which of three cases it is. Each case has other suspects:
   - The same page captured twice differs: the page has not converged. Something still changes
     (history, the wall clock, asynchronous work that lands late), or the ready signal fires too
     early.
   - Each page is reproducible by itself, but fresh loads differ: each load converges to a
     different still frame. Something was computed once from whatever was there at the time.
   - Frames differ only after a scene change (a jump, a reset): the change did not clear some
     state.
4. Record the fingerprint: where the pixels differ (material, region, shape), by how much (the
   largest difference, the pixel count), and which of the page's numeric readings differ. A
   whole-frame value (the exposure, a metering sum) that differs in its last bits points at an
   input of that reduction. If the failing images' differences from the reference correlate, they
   show one continuous disturbance, not two discrete states.
5. No difference in n runs is not an answer. Raise the rate: the busiest frames are the first ones
   after a load, with cold shader compiles (a build with new content) and with other GPU work
   running beside the page. Or go on to step 2 with the fingerprint and the cheapest page.

### 2. Hash every GPU result on fresh runs (binding: Hash)

Do not capture intermediate results one by one; hash everything at once.

1. On each of 6 or more fresh pages, at the still frame and with the render loop stopped, run this
   skill's `scripts/hash-targets.js` in the page. It hashes every texture and render target that the
   given roots reach, each layer and mip level separately (from raw GPU copies on WebGPU). It also
   records every number it reaches, bit for bit. Its header gives the call. Save one JSON file per
   page.
2. Run `node scripts/compare-runs.mjs <run.json>...` from this skill's folder. It lists the keys
   that differ, with each key's pattern over the runs.
3. Clocks, timers and frame pacing differ by nature: set them aside and read the rest. If a texture
   that the script skipped (multisampled, depth) is a suspect, hash it through its resolve target or
   a copy.

### 3. Pick the first result that differs

1. Order the differing results by dependency (read the code to see what samples what). A result
   that reads a differing result differs because of it. Examine the earliest differing result.
2. Find in the code when that result is drawn: every frame, or once (or on a signature change) and
   then kept. If it is kept, examine it. If it is drawn every frame, either its inputs differ (go
   upstream), or the last frame drawn before the loop stopped differed, which is step 4 applied to
   that frame.
3. Read the pattern of hashes. A few values that recur (ABACBA) suggest a discrete choice (which
   draws ran, what had loaded). A new value in every run suggests a continuous disturbance.

### 4. Tell its inputs from its draw

1. Hash the result's inputs at the moment it is drawn: copy them in the same frame, just before the
   draw. Hashes read at the end of the run can miss an input that changed after the draw.
2. If the inputs differ, the result was drawn before an input was final (an asynchronous load, a
   value from the first frame, a draw skipped while its pipeline compiled). Go upstream to that
   input and repeat.
3. If the inputs are equal, redraw the result alone, with the same inputs, 32 or more times on one
   page, and compare each redraw with one reference redraw texel by texel. Do it twice: once with
   the GPU idle (render loop stopped) and once while frames render. Differences only under load
   mean that the draw itself is nondeterministic, and no delay of its first draw fixes that.

### 5. Isolate the operation

When the draw itself is nondeterministic, replace the shader's output one experiment at a time, and
redraw under load 32 or more times for each experiment:

- a constant: tests coverage and blending;
- an interpolated varying: tests the vertex stage and interpolation;
- each intermediate value of the real output, in turn.

The first output that varies names the operation. Record its shape: which channel, which texels
(columns, rows) and how far apart. These operations have been seen to vary between runs of one draw:

- Screen-space derivatives (`dFdx`, `dFdy`, `fwidth`, and sampling with an implicit mip level):
  their last bits can differ between runs while the GPU is busy. A division or a fold (an area
  ratio, a normalisation near zero) turns those bits into visible changes. This is harmless in a
  pass redrawn every frame, but not in a result drawn once and kept.
- The same triangles drawn in one draw or split over several draws shade a few pixels differently,
  because derivative quads and multisample coverage are formed within a draw.
- Float atomics and unordered reductions in compute shaders: the order of the sum varies.
- Memory read before anything wrote it: a new target loaded instead of cleared.

three.js's `WebGPURenderer` adds two causes on the inputs side. A draw whose pipeline is still
compiling asynchronously is skipped without an error. The order in which node materials are first
built can change the shader code they emit.

### 6. Fix at the source (binding: Fix)

1. Make the kept result a function of its inputs. Either compute it without the operation that
   varies (for a derivative, compute the quantity from the triangle's corners in the vertex stage
   and pass it on as a flat varying), or draw it only once every input is final, and hold the
   page's ready signal until then.
2. Tolerances, retries, longer waits and drawing the result twice in the hope that it settles are
   not fixes.
3. If the fix changes the converged image, the stored reference images change. Report the measured
   change, and let whoever owns the references decide before you write new ones.
4. Write the finding where the project keeps such facts, so the next diagnosis checks it first.

### 7. Prove the fix (binding: Prove)

1. Run the reproduction of step 1 again, otherwise unchanged. From the measured rate p = k / n,
   choose N so that (1 - p)^N < 0.01, and at least the n of step 1: for p = 1/3, N = 12; for
   p = 1/20, N = 90. All N runs must agree.
2. Repeat the isolated redraw under load from step 4 the same number of times: there must be no
   difference.
3. Run the project's regular checks.
4. Report the rate before (k of n) and after (0 of N), the chance that N runs pass by luck, the
   cause in one sentence, and the change the fix made to the image.
