---
name: verifying-rendering-changes
description: Proves that a change to a renderer did what was meant and nothing else, when a refactor or a speed-up must not move a pixel, a change is meant to move the picture, a history-dependent or temporal effect is added, a screenshot or golden-image check fails, or "did this change anything on screen?" is asked. Names the kind of change first, shoots the same views before the change, compares decoded pixels byte for byte where frames repeat and within a tolerance measured from the same build's own repeatability where they cannot, keeps stored references keyed by everything their pixels depend on, shoots only paused, settled frames, and reports measured differences with crops. Use with three.js WebGPU renderers, or any renderer with screenshot comparisons, whenever rendering code, a shader, a pass, a material, the light or a capture tool is changed; it hands a build that disagrees with itself to diagnosing-nonrepeating-frames, a new defect's cause to diagnosing-visual-defects and frame time to measuring-performance-changes.
---

# Verifying rendering changes

A picture can move for many reasons besides the change: an unsettled frame, another browser
build, a tool that changed with the code, noise the GPU adds. A comparison that cannot tell these
apart either passes a regression or fails a correct change, and both get waved through. This skill
fixes what the comparison means before the change is made, so its answer can be believed.

## Rules most often broken without notice

- Name the kind of change before you edit (step 1). It decides the comparison; choosing the
  comparison after seeing the result fits the test to the answer.
- Shoot "before" from the commit the change starts from, with the same views, size, pixel ratio,
  quality, browser build and capture tools as "after". A shot taken later, on another build or with
  a changed tool, is not "before".
- A change that must not move the picture is byte-exact wherever frames repeat. "Looks the same" or
  "only a few pixels" is a failure: either a bug, or a picture change that goes in its own commit.
- A tolerance is only for frames that cannot repeat by construction (temporal accumulation, the
  GPU splitting work on its own). It is set from the same build compared with itself and proven to
  fail planted regressions (step 4). Never widen one, or recapture until it passes, to make a
  failure go away.
- Shoot a frame only when the page says it is final (paused and settled). A fixed time or frame
  count passes or fails by chance on a busy GPU.
- Compare decoded pixels, never image files: encoders differ.
- Read crops of the subjects as well as the whole frame. A mean over the frame (a perceptual
  metric's included) is reported, never used to pass: it hides a missing small object.
- A view proves nothing about what it does not show. Zero difference counts only in views that
  hold what the change touches.
- Report numbers: pixels over each level, the largest difference, where, per view and crop.
- The same build disagreeing with itself is not this skill's problem: stop and use
  `diagnosing-nonrepeating-frames`.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: which checks follow which kind of
change, its views and test scenes, its capture, comparison and reference tools, its test mode,
how a history-dependent effect is registered, and how results are reported. Read section X of
`docs/bindings/verifying-rendering-changes.md` when you reach the step. If the project's
`AGENTS.md` or `CLAUDE.md` names another file for this skill, that file wins.

No binding: find each fact in the project (its screenshot or golden-image tests, a paused or test
mode in its URL options or debug globals, its image-diff tool, the checks its commit hooks run) and
ask the user for what you cannot find, above all whether frames repeat and who accepts new
reference images. When the work ends, offer to write what you found as the binding, one section
per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Name the kind of change
- [ ] 2. Choose the views and checks, cheapest first
- [ ] 3. Capture before
- [ ] 4. Compare
- [ ] 5. Judge a change meant to move the picture
- [ ] 6. A history-dependent or temporal effect
- [ ] 7. Run the regular checks and report
```

### 1. Name the kind of change (binding: Kinds)

| Kind | Examples | What proves it |
| --- | --- | --- |
| Must not move a pixel | A refactor, a rename, a move between files, a speed-up, a tool change, a cleanup | Byte-identical frames in views that show the code; no-GPU evidence first (identical generated shader text, CPU checks) |
| Meant to move the picture | A new effect, a material, a light or look value, a fix of a defect | The intended difference where it was meant, measured; byte-identical elsewhere |
| Different content | New random seeds, a regenerated or grown world, other geometry | Pixels cannot line up: judge by eye and by region statistics, not by pixel difference |
| History-dependent or temporal | Accumulation over frames, exposure adaptation, temporal anti-aliasing, a simulation stepped per frame | Step 6, then the comparison of the kind above it falls under |

A change that is both (a speed-up that also changes the image) is split into two commits, each
verified as its kind. A change that alters how work is split into draws, or the order in which
shaders are first built, can move a few pixels while being correct on some GPUs: the binding names
these cases; measure and report them rather than calling them identical.

### 2. Choose the views and checks, cheapest first (binding: Views)

1. List what the change touches: the passes, materials, light terms, hours, weathers and
   anti-aliasing modes that can show it.
2. Take the project's standard views, then add views that hold what the change touches. Name crops
   on the subjects it touches. A view of the change at a much coarser setting should differ: if it
   does not, the view cannot see the change.
3. Run the cheapest evidence first: generated shader text and CPU checks need no GPU; a small test
   scene loads in seconds. A cheap pass is not the verdict: go on to the full views, which show
   what the small scenes do not.

### 3. Capture before (binding: Capture)

1. Build the commit the change starts from as it ships (a production build), from its own
   checkout, and serve it. The working tree with the change stashed is not that commit.
2. Shoot every chosen view in the test mode: paused, and only once the page reports the frame
   settled. Use the same capture tools on both sides; when the change is to a capture tool, shoot
   both sides with one version of it.
3. Keep references by a key of everything their pixels depend on: the build's inputs, the capture
   tools' sources, the browser build, size, pixel ratio, quality and every option. Reuse a stored
   reference only while its key matches; recapture when it does not. A new browser build is
   verified on a few stored views before a whole set is recaptured.
4. Shoot each view twice from fresh loads when the comparison will judge repeatability: the two
   are the view's own A/A.

### 4. Compare (binding: Compare)

1. Make the change, build it the same way and shoot the same views with the same options.
2. Byte-exact where frames repeat: decoded pixels, zero pixels different. A view that repeats on
   the reference must repeat on the change and match it.
3. Within a tolerance where frames cannot repeat. A tolerance follows the industry's screenshot
   tests: a pixel counts as off above a level per channel; the share of off pixels is bounded on
   the frame and in every small window (a local error, so a small concentrated change cannot hide
   in a large frame) and on every named crop; few pixels per window may differ by a lot; the mean
   signed difference per window and crop is bounded, so a coherent shift under the level still
   fails; one recapture before a failure counts.
4. Setting or changing a tolerance: record A/A pairs of one build in every condition you run in
   (quiet and loaded GPU, each mode, the hardest content); put each threshold at a few times the
   worst A/A value; cut synthetic regressions into those frames (a one-level change over a small
   square, a recoloured patch, a sub-pixel shift of a crop, a missing small object) and confirm
   each fails by a clear factor. Write the calibration beside the thresholds; any change repeats
   both tests.
5. Read each differing view: pixel counts over levels, the largest difference, the boxes where it
   lies, crops side by side.
6. A change that must not move a pixel moved some: rerun "before" against itself. If it disagrees
   with itself, use `diagnosing-nonrepeating-frames`. If it repeats, the change moved the pixels:
   find which part of the change by reverting halves of it and comparing generated shader text; a
   visible defect whose cause is not known goes to `diagnosing-visual-defects`.

### 5. Judge a change meant to move the picture (binding: References)

1. The difference lies where it was meant: in the views and crops of what was changed. Views that
   do not show the change stay byte-identical.
2. Report the intended difference measured (region statistics before and after, the largest
   change) beside the crops, and judge the whole frame as well as the crops.
3. New references are written only once the differences are the intended ones, and a change to
   stored references is the reference owner's call, made on the measured report.

### 6. A history-dependent or temporal effect (binding: History)

A frame that depends on earlier frames repeats only if its history is fixed. Give the effect one
stance in the test mode, registered beside its creation:

- cleared by a jump to another scene, so a jumped-to view draws what a fresh load draws;
- converging on a still scene, with the page's settled signal held false until it has; or
- frozen or off under the test mode's switch.

Then check the jump against fresh loads, and any in-place change of the world (a growth, a swap)
against a fresh load of its result. Compare its frames outside the test mode within a tolerance
(step 4). Motion is judged on clips of a fixed, stepped motion against a many-sample reference of
the same motion, by flicker, ghosting and sharpness, on the whole frame and on crops, before and
after.

### 7. Run the regular checks and report (binding: Checks)

Run the project's checks for every commit and those named for this kind of change. Report, and
write in the commit body: the kind of change, the views and conditions, what was byte-identical,
each difference with its numbers and crops, the tolerance used and its A/A margin, what was not
checked and why. Write relative numbers, not one machine's.

Why each rule holds and the cases it comes from: [background.md](background.md).
