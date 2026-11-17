# Background: why the method works this way

This page gives the reasons behind the rules in [SKILL.md](SKILL.md).

## Reference images taken for the fit

A fit can only be as right as its reference. Compression shifts colours in flat areas such as the
sky and makes shadowed areas blocky. A resize blends sunlight and shadow at their edge. An HDR image
saved as a screenshot is tone-mapped a second time. A vignette, a filter or depth of field adds a
change that no lighting, atmosphere or post-processing parameter of the renderer makes. Each of
these enters the measurements as a gap, and the fit then chases it. Lossless, unfiltered still
images, with the sun position and time written down at once, keep the gaps to what the look itself
differs by. Photographs used as references are taken the same way: raw or lossless, with a known
exposure, and with a grey card or colour chart in the frame where one can be placed.

## Diagnose first

A gap between two images has many possible causes, and most parameters change several regions at
once. Changing parameters before you know which one causes the gap trades one gap for another, and
the record of what was tried is lost. An hour or two of only measuring gives a table of gaps, each
with a cause and a parameter shown to change it. The fit then has a clear goal.

## View geometry on every measurement

The light a region shows depends on where the sun stands relative to the view. A field seen with the
sun behind the camera is lit flat; the same field seen across the sun shows its shadows. A
measurement that compares a reference region with a region of yours under another sun angle or
elevation measures the geometry, not the look. Every value fitted to it is then wrong in a way that
no later step reveals.

## Upstream first

The layers depend on each other in one direction: the exposure scales everything, the lighting
falls on every surface, and the atmosphere covers what lies far away. A downstream parameter fitted
before an upstream one absorbs the upstream error, and must be fitted again when the upstream one
changes. The order is the one that the skill `building-cinematic-stylised-realism` uses for every
change to the rendered image.

## Form before parameters

A least-squares fit returns the best coefficients for the form it is given, however wrong the form
is. If the reference's light falls with the sun's elevation by another law than the parameter's,
the fit settles on a compromise that is wrong at every elevation. Plotting the gap against what the
parameter varies with shows this in minutes.

## Short run before the long one

A long fit that starts from a wrong assumption (a parameter that does not change the gap, a view
that is not reproducible, a mix-up of units) fails only at its end, after most of the time it took.
A short run of a few minutes shows the problem.

## Stop when the fit does not converge

A residual that does not fall means that the parameters in the fit cannot produce the reference's
image: the form is wrong, the gap belongs to another layer, or the geometry is off. Forcing
parameters to the ends of their range hides that, and leaves values that break at other hours and
weathers.

## Never fit materials

A material fitted to a finished frame absorbs the share of the lighting's errors that the frame
shows, and breaks when the lighting is corrected. Materials take measured, physically plausible
values; the lighting, the atmosphere and the post-processing carry the look.

## Good enough on the whole frame

A viewer sees a frame as a whole. The bar is region statistics within a threshold that a viewer
would notice, or no difference seen side by side; fitting the last few measurements costs more than
it shows. About four in five acceptance measurements passing is a pass, with the rest written down,
so the work can end and the next gap can start.
