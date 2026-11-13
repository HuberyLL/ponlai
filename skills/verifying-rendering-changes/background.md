# Background: why the method works this way

The reasons behind the rules in [SKILL.md](SKILL.md), and the cases they come from: the renderer's
own project, where large refactors were carried out in many steps, each proven byte-identical, and
where the comparison tools themselves were fixed several times. Cases are cited by commit hash
where the commit says it.

## Why the kind of change comes first

The three kinds ask different questions. A refactor asks "did anything move?", and only a yes or
no answers it; a change to the picture asks "did the right thing move, and only that?"; a change
of content asks "does it still look right?", which pixels cannot answer because nothing lines up.
Choosing the comparison after seeing a difference lets the difference choose its own test: a
refactor that moved a few pixels becomes "a small picture change", and a regression is accepted.

A speed-up that also changes the image cannot be judged on either count: the time saved may come
from drawing less. Splitting it into two commits makes the image check of the speed-up a yes or no.

Some correct changes move pixels on their own. In the record, splitting the island's mesh into
one draw per chunk, with the same triangles in the same order, shaded about 1 % of its pixels a
level or two apart: the GPU forms multisampled fragments and derivative quads within a draw. Byte
comparisons hold only between builds that split the draws alike, so such a change is measured and
reported, not called identical.

## Why "before" is shot from the start commit, with the same tools

A comparison is only as good as the claim that the two sides differ by the change alone. The
record's reference store keys each set by the capture tools' sources, the browser build and every
option, and refuses a server whose build inputs differ from the commit's. A browser's minor update
once changed every key and forced a full round of references, although the frames had not changed;
verifying a few stored views under the new build and reusing the set when they matched replaced
the round (`1a538e3c`).

During the large refactors the gates were run with the tools of a baseline checkout left before
the refactor: a tool changed together with the code can be wrong in the same way, and then agrees
with it.

The cheapest evidence for a refactor needs no GPU: building the shaders to their generated text in
node and comparing it. Several refactors that moved where look values come from stated it in their
commits ("the WGSL builds the same text", `c749a647`) before any capture.

## Why paused and settled, not a count

A fixed count of ready frames shot a page still settling at forty frames, made a settled page wait
out the count, and landed on sparse frame-to-frame noise in about a sixth of loads, so A/A pairs
differed; shooting once two grabs in a row agree removed it (`06f099f6`). A signal from the page
that the frame is final (no bake in flight, nothing pending, the temporal rest converged) replaced
waits that were not robust to bakes landing late on a shared GPU (`1757f5c2`). A frame drawn after
the readiness check is not covered by it: a one-frame clip stepped after the check stored the
GPU's discrete alternative image twice in 24 runs until it was shot again until two shots agreed
(`7b84f307`).

## Why a tolerance only where frames cannot repeat, and how it is set

Under multisampling a paused frame repeats pixel for pixel between loads, so any difference is
information. Temporal frames do not: the GPU ends render passes on its own at points that vary,
a split pass shades a few samples differently, and the temporal rest averages many frames and
freezes what they held. Making them bit-exact would need product changes the project chose not to
make, so they are compared within a tolerance (`4ca6c21e`).

The tolerance follows the structure engine screenshot tests use: a per-pixel threshold and a bound
on how different the whole image may be, as Unity's Graphics Test Framework describes, and a
global error with a local error over smaller parts of the image, as Unreal's screenshot comparison
describes, so a concentrated change cannot hide in a large frame. The record adds a bound on the
mean signed difference of each window and crop, which catches a one-level shift over a region that
stays under the per-pixel level everywhere.

Its thresholds were calibrated on two kinds of evidence: every A/A pair of one build, quiet and
with the GPU shared, passes using under half the tolerance; synthetic regressions cut into those
frames (a one-level change over a small square, recoloured flowers, a quarter-pixel shift of a
crop, a missing small flower or head) fail by about four times it or more (`4ca6c21e`). A
tolerance set any other way is a guess that either passes regressions or fails noise. A perceptual
metric's mean over the frame is reported only, since it hides a small missing object.

Widening a tolerance after a failure, or recapturing until a run passes, turns a cause into noise.
A same-build disagreement in a byte-exact mode is a bug with a cause; the record's diagnoses of
such cases found a derivative taken in a branch and a bake that settled on the wrong value, both
fixed at their source.

## Why history needs a stance

An effect that keeps state across frames makes a frame depend on the path that led to it. In the
record, history that outlived a scene jump made a jumped-to view differ from a fresh load of it,
and caches keyed to an object that a growth kept left the shore on the old coast after the island
grew (`c8ea517f`). Each such effect therefore declares how the test mode fixes its history, and
the jump and the growth are checked against fresh loads.

## Why numbers and crops

"Looks the same" cannot be checked by the next reader, and a whole-frame figure hides a change in a
small region. Pixel counts over levels, the largest difference and crops of named subjects say
where and how much, and let the owner of the references accept a change on what was measured.

## Sources

- Unity, Graphics Test Framework manual
  (<https://docs.unity3d.com/Packages/com.unity.testframework.graphics@8.9/manual/index.html>):
  rendered images are compared with a known good reference, with a threshold for how different
  pixels must be before they are counted and one for how different the overall image may be.
- Epic Games, Screenshot Comparison Tool in Unreal Engine
  (<https://dev.epicgames.com/documentation/en-us/unreal-engine/screenshot-comparison-tool-in-unreal-engine>):
  a colour tolerance per pixel, a maximum global error and a maximum local error that looks at a
  smaller subset of the image; the ground truth is the screenshot known to be correct.
