---
name: diagnosing-visual-defects
description: Finds the cause of something wrong on screen in a real-time renderer, such as a band, a seam, specks, a flicker, a dark patch, a halo or something that vanishes for a frame, by switching parts off one at a time and bisecting before anything is changed. Reproduces the defect in the cheapest still view, records its fingerprint, ablates the parts that draw there until the one that makes it is found, confirms it with a sweep of its parameter, checks the suspect quantity against a physical or published range, judges temporal defects on clips against a many-sample reference, then fixes at the source. Use with three.js WebGPU renderers, or any real-time renderer, whenever a visible artefact's cause is not yet known; it hands frames that do not repeat to diagnosing-nondeterministic-frames and pictures that are technically right but look wrong to building-cinematic-stylised-realism.
---

# Diagnosing visual defects

Something on screen is wrong and its cause is not known. Reading the code and guessing gives a
plausible story and a fix that moves the defect elsewhere. This skill finds the part that makes
the defect by experiment, confirms it, and only then changes code.

## Rules most often broken without notice

- Measure before you change anything. No edit to the code under suspicion until an experiment
  names the part that makes the defect. In one recorded case an effect took four versions of its
  design before it was right.
- Switch parts off one at a time on the same view, and read each result with numbers on the same
  box (a difference, region statistics, a clip metric), not by eye alone.
- One part removing the defect is a suspect, not a cause. Confirm it with a sweep: move the
  suspect's parameter and see the defect follow as the cause predicts.
- Check the suspect quantity against what is physically possible or published (a slope, an
  albedo, a ratio). A value outside the real range is often the cause behind a symptom.
- Fix the cause where it arises. A clamp, a blur, a threshold or a rule wrapped around the outside
  hides it and comes back. The record holds one such patch: a sleep rule of the project's own
  wrapped around a physics engine's.
- A temporal defect (flicker, shimmer, ghosting, a one-frame drop) is judged on a clip of frames
  against a many-sample reference of the same motion, never on stills, and on the whole frame as
  well as on crops.
- Same inputs, different pixels between runs: stop and use `diagnosing-nondeterministic-frames`.
  Technically correct but the look is wrong (too dark, flat, a cast): use
  `building-cinematic-stylised-realism`.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: how to open a still view, how to switch
its parts off, its capture, probe and clip tools, its earlier defects, and where findings are
written. Read section X of `docs/bindings/diagnosing-visual-defects.md` when you reach the step.
If the project's `AGENTS.md` or `CLAUDE.md` names another file for this skill, that file wins.

No binding: find each fact in the project (debug switches and URL options, the debug handle on
`window`, its screenshot and image-diff tools) and ask the user for what you cannot find. When the
diagnosis ends, offer to write what you found as the binding, one section per step.

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

1. Write the defect in one sentence on screen terms: what, where, under which light, weather,
   hour and view, still or moving.
2. Reproduce it in the cheapest view that shows it: the smallest test scene if it shows there,
   one camera, the project's still or test mode for a still defect. Capture it: this is the
   "before" every later shot is compared with.
3. Shoot the same view twice from fresh loads. If the two differ where the defect is, the frame
   does not repeat: hand over to `diagnosing-nondeterministic-frames`.
4. A defect that came with a recent change: bisect the commits with this one shot before
   ablating, and read the change that brought it.

### 2. Record the fingerprint (binding: Earlier defects)

Measure and write down, before any guess:

- where: the material or object, the screen region, the distance, the angle to the sun, the
  height above water or ground; a box around it for every later reading;
- its shape: a band along a height or an angle, a seam on a grid or along tile or chunk borders,
  single-pixel specks, a halo along edges, a patch, a flicker;
- when: which hours and weathers, after a resize or scale step, on the first frame, only moving;
- how much: the largest difference and the pixel count against a frame without it, or the
  region's statistics.

Then compare it with the project's earlier defects; a match is checked first. Shapes the record
has tied to causes:

| Fingerprint | Suspect first |
| --- | --- |
| A band along an elevation or angle, sharp-edged | A gate or threshold, or a term counted twice where two models overlap |
| Specks or crumbs over a textured surface seen through another | A slope or normal steeper than real; a texture read at one point where the pixel covers many |
| A few pixels along an edge that change with unrelated edits | Derivatives or implicit samples in a branch (`writing-tsl-and-passes`) |
| Something vanishes for one frame after a resize or scale step | A target re-created and cleared before a pass that loads it |
| Missing objects or black or white blocks after a data change | A NaN or infinity upstream (a zero matrix, a division by zero) |
| A flicker that ablation of the post chain does not change | The surface's own highlights or detail, not the post step suspected |

### 3. Ablate (binding: Switches)

1. List every part that draws in the box: passes, materials, light terms (sun, sky, bounce,
   local lights, shadows, occlusion), the air, the post steps (exposure, tone, bloom, temporal
   resolve, sharpening).
2. Switch one off, or replace its output with a constant, and shoot the same view. Read the box:
   did the defect go, stay or change shape? Restore it before the next.
3. With many parts, bisect: switch off half of them at once, then half of the half that matters.
4. Use the renderer's own views where it offers them (the light alone without albedo, one light
   term, a pass's intermediate target, a debug colour per chunk or tile) to see the defect before
   the parts that mix it.
5. A switch that changes what an automatic exposure meters (an albedo, a light) moves the
   exposure too: compare linear radiance, or hold the exposure, not screen codes.
6. The part whose removal removes the defect, and only it, is the suspect. Two parts that each
   remove it point at their interaction: switch the inputs of the later one.

### 4. Confirm with a sweep (binding: Switches)

Move the suspect's parameter over a range (an offset, a width, a sample count, a strength, an
elevation) and read the defect at each value in the same box. It must follow the way the
suspected cause predicts: grow, shrink, move or vanish at a predicted value. A defect that does
not follow is a coincidence: return to step 3. A parameter with no switch is swept by a temporary
edit of its value, restored before the fix.

### 5. Check the range (binding: Switches)

Read the quantity the suspect computes in the page (a slope variance, an albedo, a ratio of
lights, a density) and compare it with a physical bound or a published measurement for the same
conditions. A value outside the range is the cause to fix; a value inside it sends you back to
the model or its inputs.

### 6. Fix at the source and compare (binding: Compare)

1. Fix the part where the wrong value or step arises, within the real range.
2. Shoot the same views as before, with crops of the box and the whole frame, and report the
   measured differences: the defect's numbers before and after, and what moved elsewhere.
3. A temporal defect: capture clips of the same motion before and after, and a many-sample
   reference; read flicker, sharpness and ghosting against the reference, on the whole frame and
   on crops.
4. Run the project's regular checks. A fix that changes stored reference images is reported
   with its measured change for the owner of the references to accept.

### 7. Record (binding: Record)

Write the fingerprint, the cause and the experiment that proved it where the project keeps such
findings, so the next diagnosis checks it first: a renderer or GPU behaviour on the behaviour
page, a module's rule in its header, the reasoning in the commit body.

Why each step holds and the cases it comes from: [background.md](background.md).
