---
name: fitting-a-look-to-reference-images
description: Finds the values of a physically based renderer's lighting, atmosphere and post-processing parameters (exposure, tone mapping, sun and sky light, ambient balance, haze and fog, white balance, colour grading) that bring a rendered frame close to the reader's own reference images, when the render's lighting, colour or fog differs from them. Gets still, lossless, unfiltered reference images with their sun position and time of day recorded, diagnoses where each gap comes from before changing anything, measures by region class with each measurement's view geometry, works upstream first, checks a function's form before fitting its parameters, fits many points numerically after a short trial run, stops when a fit does not converge, and judges good enough on the whole frame. Use with three.js WebGPU renderers, or any renderer with tunable look parameters, whenever a look is matched to reference images or photographs by changing lighting, atmosphere or post-processing values.
---

# Fitting a look to reference images

Your reference images show the lighting, colour and atmosphere you aim for, and your frame does not.
This skill finds which parameters cause the gap and fits their values to many measured points. It
sets lighting, atmosphere and post-processing parameters only. Material values and content are
decided elsewhere (the skill `building-cinematic-stylised-realism`). Why each rule holds:
[background.md](background.md).

## Rules most often broken without notice

- Take each reference image for the fit: lossless, at native resolution, with nothing overlaid on
  it, and with its time, weather and sun position written down. A flaw in a reference image never
  shows in the measurements; it shows as a fit that does not converge.
- Diagnose before you change anything. Spend the first part of the work (on a full scene, an hour
  or two) only measuring: where each gap comes from, and which change can reduce it.
- Every measurement carries its view geometry: the angle between the view and the sun, the sun's
  elevation, and the region class (sunlit ground, shadow, sky near the sun, distant land, sea). A
  measurement compared at the wrong geometry makes every fit built on it wrong.
- Work upstream first: exposure and tone mapping, then sun and sky light, then atmosphere and fog,
  then the large surfaces, then the small ones. Fit the main weather (a clear day) before the
  others.
- Check the function's form before you fit its parameters. If the reference's curve has a shape that
  the parameter cannot produce, no value fits.
- Run a short trial before a long fit. A long run that starts from a wrong assumption fails only at
  its end.
- When a fit does not converge, the method is wrong: stop and report the readings. Do not force
  parameters past their sensible range to make it converge.
- Never fit a material's values to a reference image. A material fitted to a finished frame absorbs
  the lighting's errors and breaks when the lighting changes.
- Set nothing aside silently. Write down, with the reason, every gap you leave, every measurement
  you drop and every parameter you could not move.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: its views and how to reach a given sun
position and weather, its tools for measuring regions, where its look parameters are and how to set
them, its thresholds for good enough, and where measured values are recorded. When you reach the
step, read section X of `docs/bindings/fitting-a-look-to-reference-images.md`. If the project's
`AGENTS.md` or `CLAUDE.md` names another file for this skill, that file wins.

If there is no binding, find each fact in the project (its capture and probe tools, the look's
tables or settings, its debug handles) and ask the user for what you cannot find, above all the
threshold for good enough. When the work ends, offer to write what you found as the binding, one
section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 0. Get the reference images
- [ ] 1. Match the views
- [ ] 2. Measure by region class
- [ ] 3. Diagnose each gap
- [ ] 4. Plan the order and the acceptance measurements
- [ ] 5. Check the form
- [ ] 6. Short run, then the fit
- [ ] 7. Judge the whole frame
- [ ] 8. Record
```

### 0. Get the reference images

If the images are given, skip this step, but check them against it and ask for what is missing.

1. Choose sources of the quality you aim for: photographs of the kind of place you are making, or
   screenshots you take yourself from games or films. Never use images found online: they are
   recompressed, resized and often colour-graded again.
2. Save lossless images at the display's native resolution: PNG, or the screenshot tool's
   uncompressed copy (many tools save JPEG by default). Use standard dynamic range output with HDR
   off, and leave brightness and gamma at their defaults. An image saved any other way is not the
   image a viewer sees.
3. Turn off everything overlaid on the image: the user interface, filters and photo-mode looks,
   vignette, depth of field, film grain, chromatic aberration, motion blur and lens dirt. Keep the
   source's own tone mapping and colour grading: they are part of its look. Use the source's highest
   quality settings, with dynamic resolution and upscaling off where it allows.
4. Take still images: pause, or use a photo mode with time frozen, so that you can take a view
   again. Keep a photo mode's field of view and exposure at their defaults, and write down any that
   you change.
5. With each image, write down what step 1 needs: the time of day, the weather, the sun's elevation
   and its angle to the view (estimated from the shadows when the source does not show it), the
   settings and the field of view. What you do not write down when you take the image cannot be
   recovered.
6. Take sets, not single images: one view at several hours and weathers. Each image should hold
   the region classes that step 2 measures (sunlit ground and its shadow, sky near and away from the
   sun, distant land, sea).
7. Keep the images out of the repository and within their licence. Images from a game and other
   people's photographs are for comparison only, never shipped.

### 1. Match the views (binding: Views)

1. For each reference image, write down its view geometry: where the sun stands (its elevation, and
   its angle to the view direction), the weather, the time of day, and what the image holds.
2. Set up a view of your scene with the same geometry: the same sun elevation and angle to the
   view, the same weather, and a framing with the same region classes. Render a paused, reproducible
   frame (the project's test or still mode), not a running one.
3. Where no view of yours can match a reference's geometry, do not use that reference for numbers.
   Compare it by eye only, and say so.

### 2. Measure by region class (binding: Measure)

1. Mark the same region classes in each reference and in your frame: sunlit ground, its shadow, sky
   near and away from the sun, distant land, sea, a large mass of plants. Place each box over one
   kind of light, never over mixed sunlight and shadow.
2. Measure each region in both images: the median Oklab lightness, chroma and hue of its pixels
   (`uv run tools/kit/img.py stats <image> --box <name>=x,y,w,h --oklab --split`), and the ratios
   that carry the lighting (lit against shadowed, sky against ground, distant against near).
3. Record one measurement per region per view: the view geometry, the region class, the reference's
   values, your values and the gap. Where the renderer offers them, also read your frame's values
   from the renderer (`tools/kit/probe.mjs`: the exposure, the lights, linear radiance over a box).
   They tell a lighting gap apart from a post-processing gap.

### 3. Diagnose each gap

1. Order the gaps by layer: exposure and tone mapping, sun and sky light, atmosphere and fog, large
   surfaces, small surfaces. A gap that every region shares is upstream (exposure, tone mapping,
   white balance). A gap that only shadowed areas show is in the ambient light. A gap that grows
   with distance is in the atmosphere.
2. For each gap, name the parameter that can reduce it, and test that it does: move the parameter
   once in each direction, render, and check whether the gap changes and nothing else changes more.
   A parameter that does not change the gap is not the cause.
3. A gap that no lighting, atmosphere or post-processing parameter can change is outside this
   skill: it lies in a material's model or values, or in the content. Hand it back with the
   readings.

### 4. Plan the order and the acceptance measurements

1. List the parameters to fit in upstream order, the main weather and hour first.
2. Choose the acceptance measurements: the measurements that decide good enough, spread over the
   views and region classes. Before fitting, set the threshold for each from what a viewer notices
   side by side (binding: Judge).
3. Write down the stop conditions: the residual above which the fit has failed, and each parameter's
   sensible range.

### 5. Check the form

Before you fit a parameter's coefficients, compare the shapes. Plot the gap against what the
parameter varies with (the sun's elevation, the distance, the brightness). If the reference's curve
rises where yours is flat, or falls by another law (exponential against linear with distance, a toe
against a straight line), no coefficient value removes the gap. Change the form, or report that the
parameter cannot fit it, before any fit.

### 6. Short run, then the fit (binding: Parameters)

1. Short run: one or two views, two or three parameter values, a few minutes. Check that the gap
   changes the way the diagnosis said, that the renders are reproducible, and how long one point
   takes.
2. Then fit: many points (every measurement of every view the parameter affects, across the hours
   at which it has keyframes), by least squares on the gaps, in units that match what a viewer sees
   (stops for light, Oklab distance for colour). Fit one layer at a time, in the order of step 4.
3. After each layer, measure everything again: the downstream layers were set on the old input.
4. When the residual stays above its stop condition, or a parameter reaches the end of its range,
   stop. Report the measurements, the residual and what you tried. Do not move to another parameter
   to force the fit.

### 7. Judge the whole frame (binding: Judge)

1. Look at each reference and your frame side by side at full size, then at the region statistics.
2. Good enough means that the region statistics lie within the visible threshold set in step 4, or
   that no difference is seen side by side. About four in five acceptance measurements passing is a
   pass; write the rest down, and do not iterate on them.
3. Stop once good enough holds: a residual far under the threshold leaves nothing to find.
4. Do not reopen a gap that an earlier round closed.

### 8. Record (binding: Record)

- Write the fitted values where the project keeps its look's numbers.
- In the change's notes, write the measurements and their residuals before and after, the
  measurements that did not pass, the gaps set aside and why, and any parameter that could not
  change its gap.
