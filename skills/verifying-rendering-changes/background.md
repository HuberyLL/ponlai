# Background: why the method works this way

This page gives the reasons behind the rules in [SKILL.md](SKILL.md), with typical cases: large
refactors carried out in many steps, each proven bit-identical, and comparison tools that were
themselves wrong in ways that hid or invented differences.

## Why the kind of change comes first

The kinds of change ask different questions. A refactor asks "did anything change?", and only a yes
or a no answers it. A change to the rendered image asks "did the right thing change, and only
that?". A change of content asks "does it still look right?", which a pixel comparison cannot
answer because nothing lines up. If you choose the comparison after you see a difference, the
difference chooses its own test: a refactor that altered a few pixels becomes "a small image
change", and a regression is accepted.

A speed-up that also changes the image cannot be judged as either kind: the time saved may come
from drawing less. If you split it into two commits, the image check of the speed-up becomes a yes
or a no.

Some correct changes alter pixels by themselves. For example, a terrain mesh was split into one
draw per chunk, with the same triangles in the same order, and about 1 % of its pixels were shaded
a level or two apart. The cause is that the GPU forms multisampled fragments and derivative quads
within a draw. Byte comparisons therefore hold only between builds that split the draws alike, so
such a change is measured and reported, not called identical.

## Why "before" is captured from the start commit, with the same tools

A comparison is only as good as the claim that the two sides differ by the change alone. A sound
reference store keys each set by the capture tools' sources, the browser build and every option. It
refuses a server whose build inputs differ from the commit's. A minor browser update can change
every key and force a full round of new references, although the frames have not changed. Verifying
a few stored views under the new build, and reusing the set when they match, replaces that round.

During a large refactor, the checks run with the tools of a baseline checkout made before the
refactor. A tool changed together with the code can be wrong in the same way as the code, and then
agree with it.

The cheapest evidence for a refactor needs no GPU: build the shaders to their generated text in
Node.js and compare the text. For example, a refactor that moves where look values come from can
show that the WGSL is the same text before any capture.

## Why paused and settled, not a frame count

A fixed count of ready frames caused three faults. It captured an app that was still settling at
forty frames, it made a settled app wait out the count, and in about a sixth of loads it landed on
sparse frame-to-frame noise, so A/A pairs differed. Capturing once two grabs in a row agree removed
the noise. A signal from the app that the frame is final (no bake in flight, nothing pending, the
still-scene temporal accumulation converged) replaced fixed waits, which failed when bakes landed
late on a shared GPU.

A frame drawn after the readiness check is not covered by it. In one case, a one-frame clip stepped
after the check stored the GPU's discrete alternative image twice in 24 runs. Capturing it again
until two captures agreed fixed it.

## Why a tolerance applies only where frames cannot be deterministic, and how it is set

Under multisampling, a paused frame is bit-identical between loads, so any difference is
information. Temporal frames are not. The GPU ends render passes by itself at points that vary, a
split pass shades a few samples differently, and the still-scene temporal accumulation averages many
frames and freezes what they held. Making these frames bit-exact would need product changes the
project chose not to make, so they are compared within a tolerance.

The tolerance follows the structure of engine screenshot tests. Unity's Graphics Test Framework
describes a per-pixel threshold and a bound on how different the whole image may be. Unreal's
screenshot comparison describes a global error and a local error over smaller parts of the image,
so a concentrated change cannot hide in a large frame. The project's tolerance adds a bound on the
mean signed difference of each window and crop. That bound catches a one-level shift over a region
that stays under the per-pixel level everywhere.

The thresholds were calibrated on two kinds of evidence. Every A/A pair of one build, on a quiet GPU
and on a shared one, passes using under half the tolerance. Synthetic regressions cut into those
frames (a one-level change over a small square, recoloured flowers, a quarter-pixel shift of a
crop, a missing small flower or head) fail by about four times the tolerance or more. A tolerance
set any other way is a guess that either passes regressions or fails on noise. A perceptual
metric's mean over the frame is only reported, since it hides a small missing object.

Widening a tolerance after a failure, or recapturing until a run passes, turns a cause into noise.
A disagreement of one build with itself in a byte-exact mode is a bug with a cause. Diagnoses of
such cases typically find a derivative taken in a branch, or a bake that settled on the wrong value;
each was fixed at its source.

## Why a history-dependent effect needs a defined test-mode behaviour

An effect that keeps state across frames makes a frame depend on the path that led to it. In past
cases, history that outlived a scene jump made the view reached by the jump differ from a fresh load
of that view. In another, caches keyed to an object that a growth kept left the shore on the old
coast after the island grew. Each such effect therefore declares how the test mode fixes its
history, and the scene jump and the growth are checked against fresh loads.

## Why numbers and crops

The next reader cannot check "looks the same", and a whole-frame figure hides a change in a small
region. Pixel counts over each level, the largest difference and crops of named subjects say where
and how much. They let the owner of the references accept a change on what was measured.

## Sources

- Unity, Graphics Test Framework manual
  (<https://docs.unity3d.com/Packages/com.unity.testframework.graphics@8.9/manual/index.html>):
  rendered images are compared with a known good reference, with a threshold for how different
  pixels must be before they are counted and one for how different the overall image may be.
- Epic Games, Screenshot Comparison Tool in Unreal Engine
  (<https://dev.epicgames.com/documentation/en-us/unreal-engine/screenshot-comparison-tool-in-unreal-engine>):
  a colour tolerance per pixel, a maximum global error and a maximum local error that looks at a
  smaller subset of the image; the ground truth is the screenshot known to be correct.
