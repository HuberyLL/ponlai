---
name: diagnosing-visual-defects
description: Finds the cause of something wrong on screen in a real-time renderer, such as a band, a seam, specks, a flicker, a dark patch, a halo or something that vanishes for a frame, by turning parts off one at a time and bisecting before any code is changed. Reproduces the defect in the cheapest still view, records its fingerprint, ablates the parts that draw there until it finds the one that causes the defect, confirms it with a sweep of that part's parameter, checks the suspect quantity against a physical or published range, judges temporal defects on clips against a many-sample reference, and then fixes the cause at its source. Use with three.js WebGPU renderers, or any real-time renderer, whenever the cause of a visible artefact is not yet known. It hands nondeterministic frames (the same inputs giving different pixels) to diagnosing-nondeterministic-frames, and images that are technically correct but look wrong to building-cinematic-stylised-realism.
---

# Diagnosing visual defects

Something on screen is wrong and its cause is not known. Reading the code and guessing gives a
plausible story and a fix that moves the defect elsewhere. This skill finds the part that causes the
defect by experiment, confirms it, and only then changes code.

## Rules most often broken without notice

- Measure before you change anything. Do not edit the code under suspicion until an experiment
  names the part that causes the defect. In one recorded case, an effect took four versions of its
  design before it was right.
- Turn parts off one at a time on the same view. Read each result with numbers on the same box (a
  difference, region statistics, a clip metric), not by eye alone.
- One part whose removal removes the defect is a suspect, not a cause. Confirm it with a sweep: move
  the suspect's parameter and check that the defect follows as the cause predicts.
- Check the suspect quantity against what is physically possible or published (a slope, an albedo,
  a ratio). A value outside the real range is often the cause behind a symptom.
- Fix the cause where it arises. A clamp, a blur, a threshold or a rule wrapped around the outside
  hides the cause, and the defect comes back. One recorded case is such a workaround: the project's
  own sleep rule wrapped around a physics engine's.
- Judge a temporal defect (flicker, shimmer, ghosting, a one-frame drop) on a clip of frames against
  a many-sample reference of the same motion, never on stills. Judge it on the whole frame as well
  as on crops.
- If the same inputs give different pixels between runs, stop and use
  `diagnosing-nondeterministic-frames`. If the image is technically correct but looks wrong (too
  dark, flat, a colour cast), use `building-cinematic-stylised-realism`.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: how to open a still view, how to turn its
parts off, its capture, probe and clip tools, its earlier defects, and where findings are written.
When you reach the step, read section X of `docs/bindings/diagnosing-visual-defects.md`. If the
project's `AGENTS.md` or `CLAUDE.md` names another file for this skill, that file wins.

If there is no binding, find each fact in the project (debug switches and URL options, the debug
handle on `window`, its screenshot and image-diff tools) and ask the user for what you cannot find.
When the diagnosis ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Describe and reproduce
- [ ] 2. Record the fingerprint
- [ ] 3. Ablate
- [ ] 4. Confirm with a sweep
- [ ] 5. Check the range
- [ ] 6. Fix at the source and compare
- [ ] 7. Record
```

### 1. Describe and reproduce (binding: Reproduce)

1. Describe the defect in one sentence, in terms of what is on screen: what it is, where it is,
   under which lighting, weather, hour and view, and whether it is still or moving.
2. Reproduce it in the cheapest view that shows it: the smallest test scene if the defect shows
   there, one camera, and the project's still or test mode for a still defect. Capture it. This
   capture is the "before" that every later capture is compared with.
3. Capture the same view twice from fresh loads. If the two captures differ where the defect is, the
   frame is nondeterministic: hand over to `diagnosing-nondeterministic-frames`.
4. If the defect came with a recent change, bisect the commits with this one capture before you
   ablate, and read the change that brought it.

### 2. Record the fingerprint (binding: Earlier defects)

Before any guess, measure and write down:

- where: the material or object, the screen region, the distance, the angle to the sun, the height
  above water or ground, and a box around the defect for every later reading;
- its shape: a band along a height or an angle, a seam on a grid or along tile or chunk borders,
  single-pixel specks, a halo along edges, a patch, a flicker;
- when: which hours and weathers, after a resize or a render-scale step, on the first frame, only
  in motion;
- how much: the largest difference and the pixel count against a frame without the defect, or the
  region's statistics.

Then compare the fingerprint with the project's earlier defects, and check a match first. Past
cases have tied these shapes to causes:

| Fingerprint | Suspect first |
| --- | --- |
| A band along an elevation or angle, sharp-edged | A gate or threshold, or a term counted twice where two models overlap |
| Specks or crumbs over a textured surface seen through another | A slope or normal steeper than real; a texture read at one point where the pixel covers many |
| A few pixels along an edge that change with unrelated edits | Derivatives or implicit samples in a branch (`writing-tsl-and-passes`) |
| Something vanishes for one frame after a resize or render-scale step | A target re-created and cleared before a pass that loads it |
| Missing objects, or black or white blocks, after a data change | A NaN or infinity upstream (a zero matrix, a division by zero) |
| A flicker that does not change when the post-processing steps are turned off | The surface's own highlights or detail, not the suspected post-processing step |

### 3. Ablate (binding: Switches)

1. List every part that draws in the box: passes, materials, lighting terms (sun, sky, bounce
   light, local lights, shadows, occlusion), the atmosphere and fog, and the post-processing steps
   (exposure, tone mapping, bloom, temporal resolve, sharpening).
2. Turn one part off, or replace its output with a constant, and capture the same view. Read the
   box: did the defect go, stay or change shape? Restore the part before the next one.
3. With many parts, bisect: turn off half of them at once, then half of the half that matters.
4. Where the renderer offers its own debug views, use them to see the defect before the parts that
   mix it in: the lighting alone without albedo, one lighting term, a pass's intermediate target, a
   debug colour per chunk or tile.
5. A switch that changes what an automatic exposure meters (an albedo, a light) changes the exposure
   too. Compare linear radiance, or hold the exposure fixed; do not compare display values.
6. The part whose removal removes the defect, and only that part, is the suspect. If two parts each
   remove it, the defect comes from their interaction: switch the inputs of the later part.

### 4. Confirm with a sweep (binding: Switches)

Move the suspect's parameter over a range (an offset, a width, a sample count, a strength, an
elevation), and read the defect in the same box at each value. The defect must follow the way the
suspected cause predicts: it grows, shrinks, moves or vanishes at a predicted value. A defect that
does not follow is a coincidence: return to step 3. To sweep a parameter that has no switch, edit
its value temporarily, and restore it before the fix.

### 5. Check the range (binding: Switches)

Read in the page the quantity that the suspect computes (a slope variance, an albedo, a ratio of
lights, a density). Compare it with a physical bound or a published measurement for the same
conditions. A value outside the range is the cause to fix. A value inside the range sends you back
to the model or its inputs.

### 6. Fix at the source and compare (binding: Compare)

1. Fix the part where the wrong value or step arises, keeping the value within the real range.
2. Capture the same views as before, with crops of the box and the whole frame, and report the
   measured differences: the defect's numbers before and after, and what changed elsewhere.
3. For a temporal defect, capture clips of the same motion before and after, and a many-sample
   reference. Read flicker, sharpness and ghosting against the reference, on the whole frame and on
   crops.
4. Run the project's regular checks. If the fix changes stored reference images, report it with its
   measured change for the owner of the references to accept.

### 7. Record (binding: Record)

Write the fingerprint, the cause and the experiment that proved it where the project keeps such
findings, so the next diagnosis checks it first: a renderer or GPU behaviour on the behaviour page,
a module's rule in its header, and the reasoning in the commit body.

Why each step holds and the cases it comes from: [background.md](background.md).
