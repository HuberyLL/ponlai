# Background: why the method works this way

The reasons behind the steps in [SKILL.md](SKILL.md), and typical cases of the method at work.

## Why ablate before reading code

A rendered pixel is the sum of many parts: the material, several light terms, shadows, the air,
the exposure, the tone curve, a temporal resolve. Reading the code finds a part that could make
the defect, and usually several. Switching each off on the same view finds the one that does, in
minutes, and leaves a record a reviewer can repeat. A fix built on a guess moves the defect or
hides it, and the next defect of the same cause is diagnosed from scratch.

## Cases

- A band. The low sky toward a set sun fell into a band darker than the sky above it. The haze's
  aerosol share applied a gate around the sun's rise over the horizon on top of tables that
  already held the earth's shadow, so the shadow was counted twice. Removing the gate lifted the
  band, measured as the ratio of the sky just above the horizon to the sky a few degrees up at
  three sun elevations, and left the day unchanged.
- Crumbs through the water. The floor seen through the shallows broke into crumbs. Switching the
  sea's parts off one by one led to the finest wave band; its mean square slope, summed over the
  bands, was above Cox and Munk's measurement for the same wind. Holding the slope to that
  measurement removed the crumbs. Single-pixel specks that remained came from reading
  the floor's image at one point per pixel where the refracted pixel covers many; reading it over
  the pixel's footprint brought them down to the coarse image's count.
- Waterline pixels that changed with unrelated edits: a shadow filter's derivatives taken inside a
  branch.
- The vegetation vanished for one frame after each step of the dynamic resolution: a depth target
  re-created and cleared before the pass that loads it.
- A flicker blamed on the local tone mapping. Clip metrics with the tone step on and off showed the
  flicker was the sea's own highlights, which the step only passed on.
- Ghosting under one temporal mode and not another: an ablation against the many-sample reference
  found the whole gap in the history's resampling kernel, and only that part was taken over.
- A NaN bounding box from zero matrices in a buffer's padding tripped a bounds check downstream.

## Why a sweep

Switching a part off removes everything it does, so a defect that disappears with it may come
from any of its effects, or from what the part's absence changes downstream. Moving one parameter
and seeing the defect follow the predicted law (a speck field that moves with an offset, a band
that shifts with the gate's width) ties the defect to that parameter, not to the part as a whole.
Specks on a cliff can be found this way: a probe of the shading at the speck and a sweep of
one offset.

## Why the range

Many defects are a quantity outside what the real thing can be: a slope steeper than any sea at
that wind, an albedo darker than any rock, light counted twice. A published measurement or a
physical bound says at once whether the suspect is wrong or the model around it is. The fix then
brings the quantity into the range instead of masking its effect.

## Why clips against a reference for temporal defects

A still shows one frame; flicker, shimmer and ghosting are differences between frames. A clip of
fixed motion, stepped frame by frame with a fixed time step, repeats; a reference of the same clip
rendered with many samples per pixel shows what the motion itself changes. Flicker is read as the
frame-to-frame change beyond the reference's, sharpness and ghosting against the reference's. The
renderer's anti-aliasing and the meadow's blade counts were chosen on these numbers: one choice
held the frame's flicker and sharpness within about 5 % of the reference, where one sample per
pixel added a fifth to a third more flicker. Crops show where; the whole frame shows
whether a viewer sees it.

## Sources

- Charles Cox and Walter Munk, *Measurement of the Roughness of the Sea Surface from Photographs
  of the Sun's Glitter*, Journal of the Optical Society of America 44 (11), 838-850, 1954
  (<https://opg.optica.org/josa/abstract.cfm?uri=josa-44-11-838>). Its abstract states that the
  mean square slope of the sea surface, regardless of direction, increases linearly with the
  wind speed, measured from aerial photographs of the sun's glitter. It is the published range the
  crumbs above were checked against.
