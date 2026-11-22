# Test mode

The test mode is a way of loading a page so that its frames are reproducible. The same query gives
the same bytes on every load, after every scene jump and after every growth swap. The one exception
is the pixels that the sea's held reflection reaches: these are reproducible within a tolerance
(described below). The byte-for-byte checks of the capture, parity and verify tools rely on the test
mode. The rule behind it is `ARCHITECTURE.md`, rule 4
([its full text](architecture-rules.md#rule-4-determinism-and-path-independence)).

## What the test mode is

- The query contains `paused`. It loads `aa=msaa` whatever anti-aliasing mode the quality tier uses
  (the high tier uses `msaa` too); an explicit `aa=` takes precedence.
- The capture is taken once `__THREE_GAME_DIAGNOSTICS__.settled` is true (described below). This is
  what `tools/kit/capture.mjs` waits for before it captures.
- Every capture, parity and verify tool loads its pages this way.

## The switch

The test mode has one switch, in `packages/render/debug/TestMode.ts`. It is read once at load. It
is on with `paused`, unless `testMode=0` turns it off. `tools/kit/parity/capture-clip.mjs` loads
with `testMode=0`, so its clips show the motion. Every history-dependent rendering effect that does
not settle on its own on a still scene reads the switch, and the switch freezes it or turns it off.

## The history-dependent effects

| Effect | How the test mode handles it |
| --- | --- |
| The temporal resolve (`aa=taa`, `taau`, `fsr3`, `gt`) | Frozen by its rest image (`TemporalRest.ts`) and compared within the temporal tolerance (`tools/kit/tolerance.py`). |
| The clouds' view, the sky's bakes, the refracted sun's map | They settle on their own on a still scene; `settled` waits for them. |
| The haze's shadow (`packages/render/weather/VolumetricHaze.ts`) | On a still scene, it averages a fixed sequence of jitters, starting from nothing, and then holds the result; `settled` waits for it. |
| The sea's reflection (`packages/render/ocean/SeaReflection.ts`) | It averages a fixed 32-frame sequence from cleared histories and then holds the result; `settled` waits for it, and a scene jump clears it. A few of the opaque frames it averages can differ in their last bits from one load to the next. The pixels it reaches (`__PONLAI__.heldRegion()`, `packages/render/debug/HeldRegion.ts`) are therefore compared within the held-region tolerance (`HELD` in `tools/kit/tolerance.py`; `diff-set.py --held`). The rest of the frame is compared byte for byte but for a few pixels that may differ by 1 level: the local tone mapping's wide base carries the reflection's last-bit changes there. |
| The exposure's adaptation (`packages/render/post/Exposure.ts`) | While the scene clock does not step, it reaches its target exposure at once, so the pause freezes it. It keeps `settled` false until it has reached its target. |
| The pre-exposure (`packages/render/post/PreExposure.ts`) | A whole-stop scale of the stored radiance, taken from the exposure read back from the GPU. A scene jump resets it, and on a still scene it reaches the same value whatever came before. It keeps `settled` false until the scale a frame used is the one that frame's own exposure asks for. That exposure is read from a frame drawn at least the tier's settle frames (`restSettle`) into a run of quiet frames of the same view. Under MSAA the scale does not change once the page is settled. Under the temporal modes, an exposure close to a half stop can still change it, and `settled` then turns false. |
| The sea life (`packages/island/life/SeaLife.ts`) | Each creature's pose is a function of the scene clock and of a layout that the land determines, with no history: a paused page never moves it, a scene jump or a growth swap draws what a fresh load draws. It needs no switch. |
| The falling leaves (`packages/island/world/FallingLeaves.ts`) | Off under the switch: they are not created, so `settled` never waits for them. |

A new history-dependent effect follows `docs/bindings/verifying-rendering-changes.md`, History.

## Settled

`__THREE_GAME_DIAGNOSTICS__.settled` is updated every frame, in every anti-aliasing mode. It is true
once the paused page will draw the same frame from then on. A capture therefore waits for it instead
of for a fixed time or frame count (`packages/render/post/Settled.ts`).

- It reuses the temporal rest's key (camera, scene clock, render and output sizes, epoch:
  `TemporalRest.ts`).
- It becomes true once that key, the redraw counts of the sun's maps and a forced lightning strike
  have stayed the same for the tier's `restSettle` frames (8). In addition, no sky bake or
  transition may be in progress, nothing may be pending (a periodic bake that is due, the refracted
  sun's map lagging behind its light, a queued redraw of the sun's shadow, an asynchronous pipeline
  compile), and the loading screen must have faded out.
- Under `taa`, `taau`, `gt` and `fsr3`, the temporal rest must also have converged on quiet frames
  only.
- Any change of the key turns it false: a camera move, a resize, a seek, `establishScene`, or any
  scene event, which increments the epoch under MSAA too.

`__THREE_GAME_DIAGNOSTICS__.settle` says why the page is not settled yet: `frames` of `need`,
`stable`, `shown`, `pending` (names), `since` (the frame on which it turned true) and, under the
temporal modes, `stale`. `stale` means the rest converged across a refresh: increment the epoch
(`__PONLAI__.taa.epoch.bump()`) and wait again.

## A paused page's frame queue

In the test mode, a paused page keeps at most two rendered frames queued on the GPU
(`packages/render/post/FramePacer.ts`, "A paused page's queue"). The tools' headless browser has no
vsync and no frame-rate limit. Without this bound, two pages sharing the GPU each queued hundreds of
frames of work, and every readback (the pre-exposure's, a probe's radiance) and every screenshot
waited behind that work.

The bound changes how many frames per second a paused page draws, never what it draws: the parity
views and the probe readings are the same bytes with and without it. A running page is not bounded,
and neither is a paused page loaded with `testMode=0`. A held frame is an animation frame on which
the page does not advance its frame loop (`docs/bindings/writing-tools-and-checks.md`, Build, on
waiting for rendered frames).
