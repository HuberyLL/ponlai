---
name: verifying-rendering-changes
description: Proves that a change to a renderer did what was meant and nothing else, when a refactor or a speed-up must not change a pixel, a change is meant to change the rendered image, a history-dependent or temporal effect is added, a screenshot or golden-image test fails, or "did this change anything on screen?" is asked. Names the kind of change, captures the same views before it, compares decoded pixels byte for byte where frames are deterministic and elsewhere within a tolerance set from the build's own run-to-run variation, keys stored references by everything their pixels depend on, captures only paused, settled frames, and reports measured differences with crops. Use with three.js WebGPU renderers, or any renderer with screenshot tests, whenever rendering code, a shader, a pass, a material, lighting or a capture tool changes. It hands a build that disagrees with itself to diagnosing-nondeterministic-frames, a defect of unknown cause to diagnosing-visual-defects and frame time to measuring-performance-changes.
---

# Verifying rendering changes

The rendered image can change for many reasons besides the change under test: a frame that has not
settled, another browser build, a tool that changed together with the code, or noise that the GPU
adds. A comparison that cannot tell these apart either passes a regression or fails a correct
change, and both end up waved through. This skill fixes what the comparison means before you make
the change, so you can trust its answer.

## Rules most often broken without notice

- Name the kind of change before you edit (step 1). The kind decides the comparison. If you choose
  the comparison after you see the result, you fit the test to the answer.
- Capture "before" from the commit that the change starts from. Use the same views, size, pixel
  ratio, quality, browser build and capture tools as "after". A capture taken later, on another
  build or with a changed tool, is not "before".
- A change that must not alter the rendered image is byte-exact wherever frames are
  deterministic. "Looks the same" or "only a few pixels" is a failure: either the change has a bug,
  or it changes the image and that part belongs in its own commit.
- Use a tolerance only for frames that cannot be deterministic by construction, such as temporal
  accumulation, or the GPU splitting work on its own. Set the tolerance by comparing the same build
  with itself, and prove that it fails planted regressions (step 4). Never widen a tolerance, or
  recapture until a run passes, to make a failure go away.
- Capture a frame only when the app reports that the frame is final (paused and settled). A fixed
  wait or frame count passes or fails by chance on a busy GPU.
- Compare decoded pixels, never image files: encoders differ.
- Read crops of the subjects as well as the whole frame. Report a mean over the frame (including a
  perceptual metric's mean), but never use it to pass a change: it hides a missing small object.
- A view proves nothing about what it does not show. Zero difference counts only in views that show
  what the change touches.
- Report numbers: the pixel count over each level, the largest difference, and where it lies, per
  view and per crop.
- If the same build disagrees with itself, this skill does not apply: stop and use
  `diagnosing-nondeterministic-frames`.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: which checks follow which kind of change,
its views and test scenes, its capture, comparison and reference tools, its test mode, how a
history-dependent effect is registered, and how results are reported. When you reach the step, read
section X of `docs/bindings/verifying-rendering-changes.md`. If the project's `AGENTS.md` or
`CLAUDE.md` names another file for this skill, that file wins.

If there is no binding, find each fact in the project: its screenshot or golden-image tests, a
paused or test mode in its URL options or debug globals, its image-diff tool, and the checks its
commit hooks run. Ask the user for what you cannot find, above all whether frames are deterministic
and who accepts new reference images. When the work ends, offer to write what you found as the
binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Name the kind of change
- [ ] 2. Choose the views and checks, cheapest first
- [ ] 3. Capture before
- [ ] 4. Compare
- [ ] 5. Judge a change meant to change the rendered image
- [ ] 6. A history-dependent or temporal effect
- [ ] 7. Run the regular checks and report
```

### 1. Name the kind of change (binding: Kinds)

| Kind | Examples | What proves it |
| --- | --- | --- |
| Must not change a pixel | A refactor, a rename, a move between files, a speed-up, a tool change, a cleanup | Bit-identical frames in views that show the changed code; evidence that needs no GPU first (identical generated shader text, CPU checks) |
| Meant to change the rendered image | A new effect, a material, a light or look value, a defect fix | The intended difference, measured where it was meant; bit-identical frames elsewhere |
| Different content | New random seeds, a regenerated or grown world, other geometry | Pixels cannot line up: judge by eye and by region statistics, not by pixel difference |
| History-dependent or temporal | Accumulation over frames, exposure adaptation, temporal anti-aliasing, a simulation stepped per frame | Step 6, then the comparison of the kind above that it falls under |

If a change is of two kinds (a speed-up that also changes the image), split it into two commits
and verify each as its kind. Some correct changes can alter a few pixels on some GPUs: a change to
how work is split into draws, or to the order in which shaders are first built. The binding names
these cases. Measure and report them; do not call them identical.

### 2. Choose the views and checks, cheapest first (binding: Views)

1. List what the change touches: the passes, materials, lighting terms, hours, weathers and
   anti-aliasing modes that can show it.
2. Take the project's standard views, then add views that show what the change touches. Name crops
   on the subjects it touches. Check that each view can see the change: at a much coarser setting
   of the changed part, the view should differ. If it does not, the view cannot see the change.
3. Run the cheapest evidence first. Generated shader text and CPU checks need no GPU, and a small
   test scene loads in seconds. A cheap pass is not the verdict: go on to the full views, which
   show what the small scenes do not.

### 3. Capture before (binding: Capture)

1. Build the commit that the change starts from as it ships (a production build), from its own
   checkout, and serve it. The working tree with the change stashed is not that commit.
2. Capture every chosen view in the test mode: paused, and only once the app reports the frame as
   settled. Use the same capture tools on both sides. When the change is to a capture tool, capture
   both sides with one version of it.
3. Store references under a key of everything their pixels depend on: the build's inputs, the
   capture tools' sources, the browser build, the size, the pixel ratio, the quality and every
   option. Reuse a stored reference only while its key matches; recapture when it does not. When
   the browser build changes, verify a few stored views under the new build before you recapture a
   whole set.
4. When the comparison will judge reproducibility, capture each view twice from fresh loads. The two
   captures are the view's own A/A pair.

### 4. Compare (binding: Compare)

1. Make the change, build it the same way and capture the same views with the same options.
2. Where frames are deterministic, require a byte-exact match: decoded pixels, zero pixels
   different. A view that is deterministic on the reference must be deterministic on the change and
   match the reference.
3. Where frames cannot be deterministic, compare within a tolerance. The tolerance follows the
   industry's screenshot tests:
   - A pixel counts as different above a level per channel.
   - The share of different pixels is bounded on the whole frame, in every small window and on
     every named crop. The window bound is a local error, so a small, concentrated change cannot
     hide in a large frame.
   - Only a few pixels per window may differ by a large amount.
   - The mean signed difference per window and per crop is bounded, so a coherent shift that stays
     under the per-pixel level still fails.
   - One recapture is allowed before a failure counts.
4. To set or change a tolerance, record A/A pairs of one build in every condition you run in (quiet
   and loaded GPU, each mode, the hardest content). Put each threshold at a few times the worst A/A
   value. Then cut synthetic regressions into those frames (a one-level change over a small square,
   a recoloured patch, a sub-pixel shift of a crop, a missing small object) and confirm that each
   fails by a clear factor. Write the calibration beside the thresholds. Any change to the
   thresholds repeats both tests.
5. Read each view that differs: the pixel counts over each level, the largest difference, the boxes
   where the differences lie, and the crops side by side.
6. If a change that must not alter any pixel did alter some, compare "before" against itself again.
   If "before" disagrees with itself, use `diagnosing-nondeterministic-frames`. If it is
   reproducible, the change altered the pixels: find which part of the change did it by reverting
   halves of the change and comparing the generated shader text. A visible defect whose cause is not
   known goes to `diagnosing-visual-defects`.

### 5. Judge a change meant to change the rendered image (binding: References)

1. Check that the difference lies where it was meant: in the views and crops of what was changed.
   Views that do not show the change stay bit-identical.
2. Report the intended difference as measured (region statistics before and after, the largest
   change) beside the crops. Judge the whole frame as well as the crops.
3. Write new references only once the differences are the intended ones. A change to stored
   references is the reference owner's decision, made on the measured report.

### 6. A history-dependent or temporal effect (binding: History)

A frame that depends on earlier frames is deterministic only if its history is fixed. Give the
effect one defined behaviour in the test mode, and register it next to the code that creates the
effect:

- the effect is cleared by a jump to another scene, so a view reached by the jump draws what a fresh
  load draws;
- the effect converges on a still scene, and the app's settled signal stays false until it has
  converged; or
- the effect is frozen or turned off under the test mode's switch.

Then check the scene jump against fresh loads. Check any in-place change of the world (a growth, a
swap) against a fresh load of its result. Outside the test mode, compare the effect's frames within
a tolerance (step 4). Judge motion on clips of a fixed, stepped motion against a many-sample
reference of the same motion: compare flicker, ghosting and sharpness on the whole frame and on
crops, before and after.

### 7. Run the regular checks and report (binding: Checks)

Run the project's checks for every commit and the checks named for this kind of change. Report the
following, and write it in the commit body: the kind of change, the views and conditions, what was
bit-identical, each difference with its numbers and crops, the tolerance used and its margin over
the A/A pairs, and what was not checked and why. Write relative numbers, not numbers from one
machine.

Why each rule holds and the cases it comes from: [background.md](background.md).
