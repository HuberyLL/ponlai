# Parity captures

Parity captures check that a change leaves the image as it was: paused captures of a fixed set of
views, compared view by view with a reference set, pixel for pixel or within the reference's own
repeatability, with 1:1 crops of named subjects for judging a change that is meant to show. Clips
do the same for motion. This page holds the facts that span the parity tools; the method of
verifying a change with them is the skill
[verifying-rendering-changes](../../../skills/verifying-rendering-changes/SKILL.md) and its
[binding](../../../docs/bindings/verifying-rendering-changes.md). Each tool's manual is its header
(`node <tool> --help`); the tools are listed in `docs/reference/tools.md`.

The tools:

- `tools/island/parity/views.mjs` and `tools/island/parity/clips.mjs`: the views, their crop
  anchors and the clips.
- `tools/kit/parity/capture-set.mjs`: captures a set of views; `tools/kit/diff-set.py` compares two
  sets.
- `tools/kit/reference.mjs`: the store of reference captures, one per commit.
- `tools/kit/parity/capture-clip.mjs` and `tools/kit/clip-metrics.py`: clips and their metrics
  against MSAA and a ground truth.
- `tools/kit/parity/baseline.mjs`, `tools/kit/parity/carry.mjs`, `tools/kit/gates.py` and
  `tools/kit/table.py`: the anti-aliasing gates' baseline, its carry-over, the verdicts and the
  tables.
- `tools/island/verify-scene-jump.mjs`: the views reached by scene jumps in one page, against fresh
  loads.

## Which comparison is byte-exact

MSAA sets are captured in the test mode ([Test mode](../../../docs/reference/test-mode.md)): a
paused page under MSAA, shot once `settled` holds. There the exact rules hold. A paused MSAA frame
repeats pixel for pixel between page loads, so a reference and a test set must match exactly
(`diff-set.py` with `--max-px1 0`), or within the reference's own A/A difference when both sets were
captured with `--repeat` (`--aa-floor`). A view that repeats on the reference must repeat on the
test side and match it pixel for pixel.

A scene jump keeps that contract. Only the load-time options need a new page (quality, aa, size and
device pixel ratio, the debug switches); the views' weather, time, moon and camera are runtime
state, and `__PONLAI__.establishScene( query )` reaches them in place. After the jump and one
rendered frame, the paused frame is the one a fresh load of the view's query draws, byte for byte
wherever the fresh load repeats (`app/Scene.ts`; `ARCHITECTURE.md`, rule 4: a scene jump clears
every rendering history). `verify-scene-jump.mjs` checks it, and is the regression probe for
anything that adds state a jump must clear.

Temporal frames (`aa=taa`, `taau`, `fsr3`, `gt`) do not repeat pixel for pixel, and we chose not to
make them. The GPU ends a render pass on its own (tile overflow, preemption) at points that vary from
draw to draw, a split pass shades a few samples differently (mostly through fragment derivatives),
and the temporal rest averages many such frames and freezes what they held. Under a busy GPU that
reaches a few hundredths of a percent of the pixels, a few levels each (up to 20 on dense
vegetation). Temporal sets are therefore compared within a tolerance (`diff-set.py --temporal`), the
way engine screenshot tests compare frames (Unity's Graphics Test Framework, Unreal's screenshot
tolerances).

## How a tolerance is set

A tolerance bounds what a frame's own repeatability can produce, and nothing more:

- A pixel is off when its largest channel difference exceeds a level. The share of off pixels is
  bounded on the frame, in every small window and on every named crop, and the frame's mean
  difference is bounded (global and local error).
- In every window, few pixels may differ by a lot (a missing or recoloured small object).
- The mean signed difference of each channel is bounded in every window and crop, so a coherent
  shift that stays under the level everywhere (a 1-level change over a region) still fails.
- One recapture before a failure counts: a view passes when any pairing of the two sides' captures
  passes. Capture temporal sets with `--repeat`.

The thresholds are calibrated on two kinds of evidence: they pass every A/A pair of one build's
captures, quiet and with the GPU shared, with margin (the worst A/A pair uses under half the
tolerance), and they fail every synthetic regression cut into those frames (a 1-level change over
a small square, a recoloured flower patch, a quarter-pixel shift of a crop, a missing small object)
by several times the tolerance. A new tolerance follows the same two tests. The table and its
calibration are in `tools/kit/tolerance.py`. A mean image metric over the frame (FLIP's, for one) is
reported only, never gated: a frame's mean hides a missing flower entirely.

## How the reference library is used

References are kept per commit, in a store shared by every task and process that checks against
it (`tools/kit/reference.mjs`). A reference is captured once per commit and capture-tool version;
a task that runs the usual command (`capture-set.mjs --check`, `baseline.mjs`) reuses a stored one
or waits while another process captures it.

- A reference is captured only from the commit's own production build, served from its own
  worktree (`tools/kit/serve.mjs preview`).
- A recapture is forced when the capture tools change (one reference round after a tool change
  lands), when a browser build changes and the stored samples no longer match, when a check needs
  repeats or views the stored set lacks (only those are captured), and on request.
- A browser update is verified, not recaptured: a few stored views of each kind are captured with
  the new build, and the set is reused when they match.
- A commit can take over an earlier commit's MSAA baseline and ground truth without a recapture
  when nothing it changed can move them (`tools/kit/parity/carry.mjs`). The rule cannot see a
  change that alters motion only, outside its watch list, in a view or clip its spot check does
  not cover, nor the lower tiers' ground truth; its header lists these limits.
- Compare with `--aa-floor` or `--temporal` on sets captured with `--repeat`, so a view that
  differs once is judged against its own A/A.

## Repeatability observed

- MSAA views repeat pixel for pixel between page loads, with readiness by stability
  (`tools/kit/capture.mjs`); temporal sets never do.
- A clip of a slow pan over the meadow repeats pixel for pixel between fresh loads. Vegetation crops
  elsewhere can differ in single frames: with the vegetation's depth prepass on, a few samples pass
  its equal depth test differently from frame to frame (blobs of a few to 150 pixels on leaves and
  blades; none with `vegPrepass=0`).
