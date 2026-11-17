---
name: diagnosing-nondeterministic-frames
description: Diagnoses a rendered frame that should repeat exactly but does not, such as a paused, test-mode or golden-image screenshot that differs between runs or fresh loads of the same build by a few pixels, a flaky visual or byte-for-byte test, or a render target that differs between loads. Finds the GPU result and the operation that vary, fixes the cause at its source and proves the fix with a run count. Use with WebGPU or WebGL renderers (three.js first) whenever the same inputs give different pixels.
---

# Diagnosing non-repeating frames

A frame that should repeat exactly differs between runs. The method: measure how often, hash every
GPU result to find the first one that differs, decide whether its inputs or its draw vary, isolate
the operation, fix it at the source, and prove the fix with a run count.

## Rules for the whole diagnosis

- Never make the comparison pass by masking the difference: no wider tolerance, no retry until it
  passes, no longer wait, no "GPU noise" verdict before the operation that varies is named. Masking
  hides a cause that comes back; whether to accept a tolerance is the project owner's call, made
  after the cause is known.
- Measure before you guess. Every step ends in a count (k of n runs differ) or a table of hashes,
  written down with the command that produced it. A hypothesis read from the code is checked by an
  experiment before the next step builds on it.
- Compare decoded pixels or raw texture bytes, never encoded image files.
- Change one thing per experiment, on the same build and server, and keep every run's output.
- Suspect first what is drawn once and kept: bakes, caches, first-frame set-up, converged history.
  A result redrawn every frame from equal inputs overwrites a one-off difference; a kept one
  carries it into every later frame, and the first frames after a load are the busiest.
- A fix is proven by a run count chosen from the measured rate (step 7), not by a few passes.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: how to open a still frame and know it is
final, how to capture and compare, how to run code in the page and reach the renderer, the rules for
using the GPU, earlier causes, and who accepts new reference images. Read them when you reach that
step, not before, from section X of the project's binding for this skill:
`docs/bindings/diagnosing-nondeterministic-frames.md`. If the project's `AGENTS.md` or `CLAUDE.md`
names another file for this skill, that file wins.

No binding: find each fact in the project (README, package scripts, test configuration, the debug
globals the page exposes) and ask the user for what you cannot find. When the diagnosis ends, offer
to write what you found as the binding, one section per step, so the next diagnosis starts there.

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

1. Take the cheapest page that shows the difference: the smallest test scene, one view, in the
   project's still or test mode. Read the binding's earlier causes: a fingerprint that matches one
   is checked first.
2. Load it fresh n times (start with 8 to 12) on one build and server, and compare each run with
   the first. Write down k of n.
3. Find which of three cases it is; each has other suspects:
   - The same page shot twice differs: the page has not converged. Something still moves (history,
     the wall clock, asynchronous work landing late), or the ready signal fires too early.
   - Each page repeats itself, but fresh loads differ: each load converges to another still frame.
     Something was computed once from whatever was there at the time.
   - Only after a scene change (a jump, a reset): state the change did not clear.
4. Record the fingerprint: where the pixels differ (material, region, shape), by how much (largest
   difference, pixel count), and which of the page's numeric readings differ. A whole-frame value
   (exposure, a metering sum) apart in its last bits points at an input of that reduction. Failing
   images whose differences from the reference correlate are one continuous disturbance, not two
   states.
5. No difference in n runs is not an answer. Raise the rate: the busiest frames are the first ones
   after a load with cold shader compiles (a build with new content) and with other GPU work running
   beside the page. Or go on to step 2 with the fingerprint and the cheapest page.

### 2. Hash every GPU result on fresh runs (binding: Hash)

Do not capture intermediate views one by one; hash everything at once.

1. On each of 6 or more fresh pages, at the still frame, with the render loop stopped, run this
   skill's `scripts/hash-targets.js` in the page. It hashes every texture and render target the
   given roots reach, each layer and mip level apart (raw GPU copies on WebGPU), and records every
   number it reaches bit for bit. Its header gives the call. Save one JSON file per page.
2. Run `node scripts/compare-runs.mjs <run.json>...` (this skill's folder). It lists the keys that
   differ, with each one's pattern over the runs.
3. Clocks, timers and frame pacing differ by nature: set them aside and read the rest. Hash a
   texture the script skipped (multisampled, depth) through its resolve target or a copy if it is a
   suspect.

### 3. Pick the first result that differs

1. Order the differing results by dependency (read the code: what samples what). Results that read
   a differing one differ because of it. The earliest differing result is the one to study.
2. Find in the code when it is drawn: every frame, or once (or on a signature change) and then kept.
   Kept: study it. Every frame: either its inputs differ (go upstream) or the last frame drawn
   before the stop differed, which is step 4 applied to that frame.
3. Read the pattern of hashes: a few values that recur (ABACBA) suggest a discrete choice (which
   draws ran, what had loaded); a new value every run suggests a continuous disturbance.

### 4. Tell its inputs from its draw

1. Hash its inputs at the moment it is drawn: copy them in the same frame, just before the draw.
   Hashes read at the end of the run can miss an input that changed after the draw.
2. Inputs differ: it was drawn before an input was final (an asynchronous load, a value of the
   first frame, a draw skipped while its pipeline compiled). Go upstream to that input and repeat.
3. Inputs equal: redraw the result alone, with the same inputs, 32 or more times on one page, and
   compare each redraw with one reference redraw texel by texel. Do it twice: with the GPU idle
   (render loop stopped) and while frames render. Differences only under load mean the draw itself
   does not repeat; no delay of its first draw fixes that.

### 5. Isolate the operation

When the draw itself does not repeat, replace the shader's output one experiment at a time and
redraw under load 32 or more times each:

- a constant: tests coverage and blending;
- an interpolated varying: tests the vertex stage and interpolation;
- each intermediate value of the real output, in turn.

The first output that varies names the operation. Record its shape: which channel, which texels
(columns, rows), how far apart. Operations seen to vary between runs of one draw:

- Screen-space derivatives (`dFdx`, `dFdy`, `fwidth`, and sampling with an implicit mip level):
  their last bits can differ between runs while the GPU is busy, and a division or a fold (an area
  ratio, a normalisation near zero) turns them into visible changes. Harmless in a pass redrawn
  every frame; not in a result drawn once and kept.
- The same triangles drawn in one draw or split over several shade a few pixels apart: derivative
  quads and multisample coverage form within a draw.
- Float atomics and unordered reductions in compute shaders: the order of the sum varies.
- Memory read before anything wrote it: a new target loaded instead of cleared.

Two causes on the inputs side that three.js's `WebGPURenderer` adds: a draw whose pipeline is still
compiling asynchronously is skipped without an error, and the order in which node materials first
build can change the shader code they emit.

### 6. Fix at the source (binding: Fix)

1. Make the kept result a function of its inputs: compute it without the operation that varies
   (for a derivative, compute the quantity from the triangle's corners in the vertex stage and pass
   it on flat), or draw it only once every input is final and hold the page's ready signal until
   then.
2. Tolerances, retries, longer waits and drawing it twice in the hope it settles are not fixes.
3. If the fix changes the converged image, the stored reference images change. Report the measured
   change and let whoever owns the references decide before you write new ones.
4. Write the finding where the project keeps such facts, so the next diagnosis checks it first.

### 7. Prove the fix (binding: Prove)

1. Run the reproduction of step 1 again, otherwise unchanged. From the measured rate p = k / n,
   choose N with (1 - p)^N < 0.01, and at least the n of step 1: for p = 1/3, N = 12; for p = 1/20,
   N = 90. All N runs must agree.
2. Repeat the isolated redraw under load of step 4 the same number of times: no difference.
3. Run the project's regular checks.
4. Report the rate before (k of n) and after (0 of N), the chance that a run of N passes by luck,
   the cause in one sentence, and the image change the fix made.
