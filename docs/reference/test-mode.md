# Test mode

The test mode is how a page is loaded so that a frame repeats: the same query gives the same bytes
on every load, in every scene jump and after every growth swap, but for the pixels the sea's held
reflection reaches, which repeat within a tolerance (below). The byte-for-byte checks of the
capture, parity and verify tools rely on it. The rule behind it is `ARCHITECTURE.md`, rule 4
([its full text](architecture-rules.md#rule-4-determinism-and-path-independence)).

## What the test mode is

- `paused` in the query. It loads `aa=msaa` whatever the tier runs (high runs `msaa` too); an
  explicit `aa=` wins.
- The shot is taken once `__THREE_GAME_DIAGNOSTICS__.settled` holds (below). This is
  `tools/kit/capture.mjs`'s readiness.
- Every capture, parity and verify tool loads its pages this way.

## The switch

The test mode's one switch is `packages/render/debug/TestMode.ts`. It is read once at load and is on
with `paused`, unless `testMode=0` leaves it out. `tools/kit/parity/capture-clip.mjs` loads with
`testMode=0`, so its clips show what moves. Every history-dependent rendering effect that does not
settle on its own on a still scene reads the switch, and is frozen or off under it.

## The history-dependent effects

| Effect | How the test mode handles it |
| --- | --- |
| The temporal resolve (`aa=taa`, `taau`, `fsr3`, `gt`) | Frozen by its rest image (`TemporalRest.ts`) and compared within the temporal tolerance (`tools/kit/tolerance.py`). |
| The clouds' view, the sky's bakes, the refracted sun's map | Settle on their own on a still scene; `settled` waits for them. |
| The haze's shadow (`packages/render/weather/VolumetricHaze.ts`) | Averages a fixed sequence of jitters from nothing on a still scene and holds it; `settled` waits for it. |
| The sea's reflection (`packages/render/ocean/SeaReflection.ts`) | Averages a fixed 32-frame sequence from cleared histories and holds it; `settled` waits for it, and a scene jump clears it. A few of the opaque frames it averages can differ in their last bits from load to load, so the pixels it reaches (`__PONLAI__.heldRegion()`, `packages/render/debug/HeldRegion.ts`) are compared within the held tolerance (`HELD` in `tools/kit/tolerance.py`; `diff-set.py --held`) and the rest of the frame byte for byte. |
| The exposure's adaptation (`packages/render/post/Exposure.ts`) | Takes its target at once while the scene clock does not step, so the pause freezes it; it keeps `settled` false until it has reached its target. |
| The pre-exposure (`packages/render/post/PreExposure.ts`) | A whole-stop scale of the stored radiance, taken from the exposure read back. A scene jump resets it, and it reaches the same value on a still scene whatever came before. It keeps `settled` false until the scale a frame used is the one its own exposure asks for, read from a frame drawn the settle frames into a quiet run of the view. Under MSAA the scale does not change under a settled page; under the temporal modes an exposure close to a half stop can still move it, and `settled` then turns false. |
| The wenyao's schools (`packages/island/life/Wenyao.ts`, built only under `wenyao`) | Step only with the scene clock's step, from a layout the land gives. A page loaded paused never steps them; `establishScene` returns them to that layout, and so does a Grow while they have not stepped. They need no switch. |
| The falling leaves (`packages/island/world/FallingLeaves.ts`) | Off under the switch: not made, so `settled` never waits for them. |

A new history-dependent effect follows `docs/bindings/verifying-rendering-changes.md`, History.

## Settled

`__THREE_GAME_DIAGNOSTICS__.settled` is updated every frame, in every anti-aliasing mode. It is true
once the paused page will draw the same frame from now on, so a capture waits for it instead of a
fixed time or frame count (`packages/render/post/Settled.ts`).

- It reuses the temporal rest's key (camera, scene clock, render and output sizes, epoch:
  `TemporalRest.ts`).
- It holds once that key, the sun maps' redraw counts and a forced strike have stayed the same for
  the tier's `restSettle` frames (8), while no sky bake or transition is in flight, nothing is
  pending (a periodic bake due, the refracted sun's map behind its light, a queued sun shadow
  redraw, an async pipeline compile) and the loading screen has faded out.
- Under `taa`, `taau`, `gt` and `fsr3` the temporal rest must also have converged on quiet frames
  only.
- Any change of the key turns it false: a camera move, a resize, a seek, `establishScene`, or any
  scene event, which bumps the epoch under MSAA too.

`__THREE_GAME_DIAGNOSTICS__.settle` says why it is not settled yet: `frames` of `need`, `stable`,
`shown`, `pending` (names), `since` (the frame it turned true) and, under the temporal modes,
`stale`. `stale` means the rest converged over a refresh: bump the epoch
(`__PONLAI__.taa.epoch.bump()`) and wait again.

## A paused page's frame queue

The test mode's paused pages keep at most two rendered frames queued on the GPU
(`packages/render/post/FramePacer.ts`, "A paused page's queue"). The tools' headless browser has no
vsync and no frame-rate limit. Without the bound, two pages sharing the GPU each queued hundreds of
frames of work, and every read-back (the pre-exposure's, a probe's radiance) and every screenshot
waited behind it.

The bound changes how many frames a second a paused page draws, never what it draws: the parity
views and the probe readings are the same bytes with and without it. A running page, and a paused
one with `testMode=0`, is not bounded. A held frame is an animation frame on which the page does not
tick (`docs/bindings/writing-tools-and-checks.md`, Build, on waiting for rendered frames).
