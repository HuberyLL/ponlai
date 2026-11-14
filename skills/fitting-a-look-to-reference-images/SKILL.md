---
name: fitting-a-look-to-reference-images
description: Finds the values of the light, air and image knobs of a physically based renderer (exposure, tone, sun and sky light, ambient balance, haze and fog, white balance, grade) that bring a rendered frame to the reader's own reference images, when the picture's light, colour or fog differs from them. Gets reference images shot as still, lossless, unfiltered frames with their sun and time recorded, diagnoses where each gap comes from before changing anything, measures by region class with each row's view geometry, works upstream first, checks a function's form before fitting its parameters, fits many points numerically after a short trial run, stops when a fit will not close, and judges good enough on the whole frame. Use with three.js WebGPU renderers, or any renderer with tunable look knobs, whenever a look is matched to reference images or photographs by changing light, air or image values.
---

# Fitting a look to reference images

Your reference images show the light, colour and air you want; your frame does not. This skill
finds which knobs make the gap and fits their values to many measured points. It sets light, air
and image knobs only. Material values and content are decided elsewhere (the skill
`building-aaa-stylised-realism`). Why each rule holds: [background.md](background.md).

## Rules most often broken without notice

- A reference image is shot for the fit: lossless, at native resolution, with nothing laid over
  it, and with its time, weather and sun written down. A flaw in it never shows in the rows; it
  shows as a fit that will not close.
- Diagnose before you change anything. Spend the first part of the work (on a full scene, an hour
  or two) measuring only: where does each gap come from, and which change can move it.
- Every measured row carries its view geometry: the angle between the view and the sun, the sun's
  elevation, the region class (sunlit ground, shade, sky near the sun, far land, sea). A row
  compared at the wrong geometry makes every fit built on it wrong.
- Work upstream first: exposure and tone, then sun and sky light, then air and fog, then the large
  surfaces, then the small ones. The main weather (a clear day) before the others.
- Check the function's form before you fit its parameters. If the reference's curve has another
  shape than the knob can make, no value fits.
- Run a short trial before a long fit: a long run that starts from a wrong assumption fails only
  at its end.
- When a fit will not close, the method is wrong: stop and report the readings. Do not force knobs
  past their sensible range to close it.
- Never fit a material's values to a reference image. A material fitted to a finished frame takes
  on the light's errors and breaks when the light changes.
- Nothing is set aside silently: a gap you leave, a row you drop and a knob you could not move are
  written down with the reason.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: its views and how to reach a given sun
and weather, its tools for region rows, where its look knobs are and how to set them, its
thresholds for good enough, and where measured values are recorded. Read section X of
`docs/bindings/fitting-a-look-to-reference-images.md` when you reach the step. If the project's
`AGENTS.md` or `CLAUDE.md` names another file for this skill, that file wins.

No binding: find each fact in the project (its capture and probe tools, the look's tables or
settings, its debug handles) and ask the user for what you cannot find, above all the threshold
for good enough. When the work ends, offer to write what you found as the binding, one section
per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 0. Get the reference images
- [ ] 1. Match the views
- [ ] 2. Measure rows by region class
- [ ] 3. Diagnose each gap
- [ ] 4. Plan the order and the acceptance rows
- [ ] 5. Check the form
- [ ] 6. Short run, then the fit
- [ ] 7. Judge the whole frame
- [ ] 8. Record
```

### 0. Get the reference images

Skip this step when the images are given; check them against it, and ask for what is missing.

1. Choose sources at the standard you aim for: photographs of the kind of place you are making,
   or frames you shoot yourself from games or films whose look you want. Never images found
   online: they are recompressed, resized and often graded again.
2. Shoot lossless at the display's native resolution: PNG, or the screenshot tool's uncompressed
   copy (many tools save JPEG by default). Use standard dynamic range output with HDR off, and
   leave brightness and gamma at their defaults: a frame shot otherwise is not the image a viewer
   sees.
3. Turn off what is laid over the image: the interface, filters and photo-mode looks, vignette,
   depth of field, film grain, chromatic aberration, motion blur, lens dirt. Keep the source's own
   tone and grade: they are part of its look. Use its highest quality settings, with dynamic
   resolution and upscaling off where it allows.
4. Shoot still frames: a pause, or a photo mode with time frozen, so a view can be shot again. Keep
   a photo mode's field of view and exposure at their defaults and write down any you change.
5. Write down with each image what step 1 needs: the time of day, the weather, the sun's elevation
   and its angle to the view (from the shadows when the source does not show it), the settings and
   the field of view. What is not written when the image is shot cannot be recovered.
6. Shoot sets, not single images: one view at several hours and weathers, each frame holding the
   region classes step 2 measures (sunlit ground and its shade, sky near and away from the sun,
   far land, sea).
7. Keep the images out of the repository and within their licence: frames of a game and other
   people's photographs are for comparison, never shipped.

### 1. Match the views (binding: Views)

1. For each reference image, write its view geometry: where the sun stands (elevation, and its
   angle to the view direction), the weather, the time of day, what the frame holds.
2. Set up a view of your scene with the same geometry: the same sun elevation and angle to the
   view, the same weather, a framing with the same region classes. A paused, repeatable frame
   (the project's test or still mode) is shot, not a running one.
3. Where no view of yours can match a reference's geometry, do not use that reference for
   numbers: compare it by eye only, and say so.

### 2. Measure rows by region class (binding: Measure)

1. Mark the same region classes in each reference and in your frame: sunlit ground, its shade,
   sky near and away from the sun, far land, sea, a large plant mass. Use boxes over one kind of
   light each, never over mixed sun and shade.
2. Measure each region in both: the median Oklab lightness, chroma and hue of its pixels
   (`uv run tools/kit/img.py stats <image> --box <name>=x,y,w,h --oklab --split`), and the ratios
   that carry the light (lit against shade, sky against ground, far against near).
3. Write one row per region per view: the view geometry, the region class, the reference's
   values, yours and the gap. Read your own frame's values from the renderer as well where it
   offers them (`tools/kit/probe.mjs`: the exposure, the light, linear radiance over a box), to
   tell the light from the image.

### 3. Diagnose each gap

1. Order the gaps by layer: exposure and tone, sun and sky light, air and fog, large surfaces,
   small ones. A gap that every region shares is upstream (exposure, tone, white balance); one
   that only shade shows is the ambient light; one that grows with distance is the air.
2. For each gap, name the knob that can move it, and test that it does: move the knob once each
   way, shoot, and see whether the gap moves and nothing else moves more. A knob that does not
   move the gap is not the cause.
3. A gap no light, air or image knob can move is not this skill's: a material's model or values,
   or the content. Hand it back with the readings.

### 4. Plan the order and the acceptance rows

1. List the knobs to fit in upstream order, the main weather and hour first.
2. Choose the acceptance rows: the rows that decide good enough, spread over the views and region
   classes. Set the threshold for each before fitting, from what a viewer notices side by side
   (binding: Judge).
3. Write the stop conditions: the residual above which the fit has failed, and each knob's
   sensible range.

### 5. Check the form

Before fitting a knob's parameters, compare the shapes: plot the gap against what the knob varies
with (the sun's elevation, distance, brightness). If the reference's curve rises where yours is
flat, or falls by another law (exponential against linear with distance, a toe against a straight
line), no parameter closes it. Change the form, or report that the knob cannot, before any fit.

### 6. Short run, then the fit (binding: Knobs)

1. Short run: one or two views, two or three knob values, a few minutes. Check that the gap moves
   the way the diagnosis said, that the shots repeat, and how long one point takes.
2. Then fit: many points (every row of every view the knob affects, across the hours it is keyed
   by), least squares on the gaps in units that match what is seen (stops for light, Oklab
   distance for colour). One layer at a time, in the order of step 4.
3. After each layer, measure every row again: the layers downstream were set on the old input.
4. When the residual stays above its stop condition, or a knob reaches the end of its range, stop.
   Report the rows, the residual and what you tried. Do not move to another knob to force it.

### 7. Judge the whole frame (binding: Judge)

1. Look at each reference and your frame side by side at full size, then the region statistics.
2. Good enough: the region statistics lie within the visible threshold set in step 4, or no
   difference is seen side by side. About four in five acceptance rows passing is a pass; the
   rest are written down, not iterated.
3. Stop once good enough holds: a residual far under the threshold leaves nothing to find.
4. A gap closed in an earlier round is not reopened.

### 8. Record (binding: Record)

- The fitted values, where the project keeps its look's numbers.
- In the change's notes: the rows and their residuals before and after, the rows that did not
  pass, the gaps set aside and why, and any knob that could not move its gap.
