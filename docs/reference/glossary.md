# Glossary

The project's own terms, and standard terms with a meaning specific to this project, as the docs and
the code use them. Each entry names the file or page that explains the term in full.

Ambient volume
: A grid of ambient light probes, baked per chunk (`packages/island/world/AmbientProbes.ts`) and
  relit every frame from the sky's spherical harmonics and the key light
  (`packages/render/lighting/AmbientRelight.ts`). The probes see the land, its groves and its cliffs,
  and supply the fill light in shadowed areas: every lit island material reads the volume for its
  ambient diffuse lighting (`packages/render/lighting/AmbientSample.ts`).

Baking lighting into albedo
: Tuning a material's colour to make up for an error in the lighting
  ([Art direction](../design/art-direction.md), How the look is made).

Binding
: The page of this project's facts that goes with a skill: a skill in `skills/<name>/SKILL.md`
  states a general method, and its binding in `docs/bindings/<name>.md` gives the files, tools,
  values and checks that the method uses here.

Chunk
: A 16 m square of the world (`packages/island/world/Chunks.ts`). A chunk's content is a function of
  its window of the land field, which is the chunk extended by 32 m on each side
  (`packages/island/world/Chunks.ts`, its header).

Cloud deck
: A closed, continuous layer of cloud covering the sky, as under the parked overcast weather
  ([Sea and sky](../design/sea-and-sky.md#the-clouds)).

Fresh load
: A browser page loaded from scratch with a given URL, with no earlier scene, growth or history. A
  growth swap or a scene jump must leave the page in the same state as a fresh load
  ([Architecture rules](architecture-rules.md#rule-4-determinism-and-path-independence)).

GPU lock
: The lock that every tool rendering the scene in a browser takes (`tools/kit/gpu-lock.mjs`).
  Timing runs hold it alone; paused captures and probes share it ([GPU lock](gpu-lock.md)).

Grow, growth and growth swap
: The island grows one piece of land at a time, in place. The growth
  (`packages/island/world/Growth.ts`) prepares the changed chunks, and everything else that depends
  on the land's shape, in the background. A Grow (`grow()`) then performs the growth swap: it swaps
  in only the changed chunks within one frame, without building a pipeline.

Held region
: The pixels that the sea's reflection reaches (`packages/render/debug/HeldRegion.ts`). The
  reflection averages a fixed sequence of frames and then holds the result, and a few of those
  frames can differ in their last bits between loads. So in the test mode these pixels are compared
  within a tolerance (`HELD` in `tools/kit/tolerance.py`), and the rest of the frame byte for byte
  ([Test mode](test-mode.md)).

History-dependent effect
: A rendering effect whose output depends on earlier frames: a temporal resolve, exposure
  adaptation, lighting or fog accumulated over frames, vegetation that responds to what passes
  through it, a per-frame physics simulation. A scene jump clears its history, and on a still scene
  it converges or the test mode freezes it or turns it off
  ([Architecture rules](architecture-rules.md#rule-4-determinism-and-path-independence)).

Island view
: The game's own view: the island camera zoomed out over the island. The look is judged from this
  view as well as close up ([Art direction](../design/art-direction.md), How the look is judged).

Kept weathers
: Clear and fair: the weathers in which every change must work. The other weathers are parked.

Key light
: The one dominant light in the scene: the sun by day, the moon by night
  ([Sea and sky](../design/sea-and-sky.md#the-sun)).

Keyframe
: A set of look values given at one sun elevation (`packages/render/post/DayKeys.ts`). A value
  rests at each keyframe and is blended smoothly between neighbouring keyframes. The code calls a
  keyframe a key, as an animation curve does (`DayKeys`, `HazeKey`, `ExposureKey`).

Lighting
: The stage of the look that sets the lighting and post-processing for the whole scene, by weather
  and hour, after lookdev has made each material right on its own
  ([Art direction](../design/art-direction.md), How the look is made).

Lip and rim
: The rim is the island's top edge above the cliffs, where the meadow meets the stone; the lip is
  the edge line of the rim itself, where the turf ends over the stone
  ([The island](../design/island.md#the-rim)).

`Look`
: The type of a complete set of look values (`packages/render/look/Look.ts`): the values chosen for
  the rendered image rather than measured or derived, one table per system (ambient balance, sky,
  haze, exposure, tone curve and colour grade, and others). The app picks one set and passes it to
  the render pipeline's stages; the render pipeline also carries a neutral set
  (`packages/render/look/NeutralLook.ts`).

Lookdev
: Look development: making each material right on its own. Its values are checked against the
  real range, then seen first on the clear day at noon, before the other weathers and hours
  ([building-cinematic-stylised-realism](../../skills/building-cinematic-stylised-realism/SKILL.md)).

Parked
: Kept compiling and loadable by name, but out of the default checks until revived as its own
  milestone: the weathers cloudy, overcast, rain, storm and fog (`PARKED_WEATHER` in
  `packages/render/sky/Weather.ts`). New work need not support them.

Piece
: One piece of land: the island grows one piece at a time from a starting island at the world's
  centre ([Game design](../design/game-design.md), How the island grows).

Pre-exposure
: The scale that every writer of the scene's colour and metering light multiplies by, and every
  reader in scene units divides out (`packages/render/post/PreExposure.ts`).

Quality tier
: A named set of the settings that a frame's cost depends on, all in one table
  (`packages/render/Quality.ts`): high (the reference), medium and low, the settings menu's
  presets. A tier changes the cost, never the weather, the clock or the lighting.

Scene jump
: A move of a loaded page to another scene (`establishScene` in
  `packages/render/assemble/SceneJump.ts`). It clears every state the earlier scene left behind, so
  the page then holds what a fresh load of the same URL holds.

Settled
: The page's signal that a paused frame is final (`settled`, `packages/render/post/Settled.ts`).
  Captures are taken once it is true.

Stylised realism
: The island's rendered image: physically based and developed like a photograph, but not aimed at
  photorealism ([Art direction](../design/art-direction.md), How the look is made).

Sward
: The meadow's grass as one even cover, about 0.5 m tall
  ([The island](../design/island.md#the-meadow)).

Temporal modes
: The anti-aliasing modes that resolve over frames: `taa`, `taau`, `fsr3` and `gt` (the ground
  truth, debug builds only), as opposed to `msaa` and `off` (`packages/render/post/Antialiasing.ts`).

Test mode
: A paused page rendered with MSAA, with every history-dependent effect frozen or off, and captured
  once `settled` is true. In the test mode, a paused frame is bit-identical between runs and equals
  a fresh load's frame, except in the held region ([Test mode](test-mode.md)).

Yunpeng
: A herb of the old texts: single clumps of straight white stalks far apart on the open meadow,
  which glow softly at night (`packages/island/world/Yunpeng.ts`;
  [The island](../design/island.md#the-yunpeng)).
