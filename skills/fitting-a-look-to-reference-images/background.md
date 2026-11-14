# Background: why the method works this way

The reasons behind the rules in [SKILL.md](SKILL.md).

## Reference images shot for the fit

A fit can only be as right as its reference. Compression moves colours in flat areas such as the
sky and blocks the shade; a resize blends sun and shade at their edge; an HDR frame saved as a
screenshot is tone-mapped again; a vignette, a filter or depth of field adds a change no light,
air or image knob of the renderer makes. Each enters the rows as a gap, and the fit then chases
it. Shooting lossless, unfiltered still frames, and writing the sun and time down at once, keeps
the gaps to what the look itself differs by. Photographs used as reference are shot the same way:
raw or lossless, with a known exposure, and a grey or colour chart in frame where one can be
placed.

## Diagnose first

A gap between two images has many possible causes, and most knobs move several regions at once.
Changing knobs before knowing which one makes the gap trades one gap for another, and the record
of what was tried is lost. An hour or two of measuring only gives a table of gaps, each with a
cause and a knob shown to move it; the fit then has a target.

## View geometry on every row

The light a region shows depends on where the sun stands against the view: a field seen with the
sun behind the camera is lit flat, the same field seen across the sun shows its shade. A row that
compares a reference region with a region of yours under another sun angle or elevation measures
the geometry, not the look, and every value fitted to it is wrong in a way no later step reveals.

## Upstream first

The layers depend on each other in one direction: the exposure scales everything, the light falls
on every surface, the air covers what lies far. A downstream knob fitted before an upstream one
absorbs the upstream error and must be fitted again when the upstream one moves. The order is the
one the skill `building-aaa-stylised-realism` uses for every change to the picture.

## Form before parameters

A least-squares fit returns the best parameters for the form it is given, however wrong the form
is. If the reference's light falls with the sun's elevation by another law than the knob's, the
fit settles on a compromise that is wrong at every elevation. Plotting the gap against what the
knob varies with shows this in minutes.

## Short run before the long one

A long fit that starts from a wrong assumption (a knob that does not move the gap, a view that
does not repeat, a unit mix-up) fails only at its end, after most of the time it took; a few
minutes of a short run show the problem.

## Stop when the fit will not close

A residual that will not fall means the knobs in the fit cannot make the reference's picture: the
form is wrong, the gap belongs to another layer, or the geometry is off. Forcing knobs to their
ends hides that and leaves values that break at other hours and weathers.

## Never fit materials

A material fitted to a finished frame takes on the share of the light's errors the frame shows,
and breaks when the light is corrected. Materials take measured, physically plausible values;
the light, the air and the image carry the look.

## Good enough on the whole frame

A frame is seen whole. Region statistics within a threshold a viewer would notice, or no
difference seen side by side, is the bar; fitting the last few rows costs more than it shows.
About four in five acceptance rows passing is a pass, with the rest written down, so the work can
end and the next gap can start.
