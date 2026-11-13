# Glossary

The project's own words, as the docs and the code use them. Each entry names where the term is
explained in full.

Ambient volume
: The ambient light's probes, baked per chunk (`packages/island/world/AmbientProbes.ts`) and relit
  every frame by the sky's harmonics and the key (`packages/render/lighting/AmbientRelight.ts`). It
  sees the land, its groves and its cliffs, and lights the shade: every lit island material reads it
  for its ambient diffuse (`packages/render/lighting/AmbientSample.ts`).

Baking lighting into albedo
: Tuning a material's colour to make up for an error in the light ([Art
  direction](../design/art-direction.md), How the look is made).

Chunk
: A 16 m square of the world (`packages/island/world/Chunks.ts`). A chunk's content is a function of
  its window of the land field, the chunk grown by 32 m (`packages/island/world/Chunks.ts`, its header).

GPU lock
: The lock every tool that renders the scene in a browser takes (`tools/kit/gpu-lock.mjs`): timing
  runs hold it alone, paused captures and probes share it ([GPU lock](gpu-lock.md)).

Grow
: The step that adds the next piece to the island in place: it swaps in only the changed chunks in
  one frame (`packages/island/world/Growth.ts`).

Island view
: The game's own view: the island camera zoomed out over the island, from which the look is judged,
  as well as close up ([Art direction](../design/art-direction.md), The look).

Kept weathers
: Clear and fair: the weathers every change must hold in.

Key
: The one dominant light: the sun by day, the moon by night
  ([Sea and sky](../design/sea-and-sky.md#the-sun)).

Lighting
: Setting the light and the image for the whole world, by weather and hour ([Art
  direction](../design/art-direction.md), How the look is made).

Lip
: The top edge of the cliff, where the meadow meets the stone
  ([The island](../design/island.md#the-rim)).

Lookdev
: Look development: making each material right on its own: real values checked against the real
  range, then seen first on the clear day at noon, before the other weathers and hours ([Add a
  material](../how-to/add-material.md)).

Parked
: Kept compiling and loadable by name but out of the default checks, until revived as its own
  milestone: the weathers cloudy, overcast, rain, storm and fog (`PARKED_WEATHER` in
  `packages/render/sky/Weather.ts`) and the quality tiers medium and low (`PARKED_QUALITY` in
  `packages/render/Quality.ts`).

Piece
: One piece of land: the island grows one piece at a time from a starting island at the world's
  centre ([Game design](../design/game-design.md), How the island grows).

Pre-exposure
: The scale every writer of the scene's colour and metering light multiplies by and every
  scene-unit reader divides out (`packages/render/post/PreExposure.ts`).

Scene jump
: `establishScene` in `app/Scene.ts`: it moves a page to another scene, which then holds what a
  fresh load of the same query holds, and clears all state the scene leaves behind.

Settled
: The page's signal that a paused frame is final (`packages/render/post/Settled.ts`); captures are
  shot once it holds.

Stylised realism
: The island's image: physically based and developed like a photograph, but not aimed at
  photorealism ([Art direction](../design/art-direction.md), How the look is made).

Sward
: The meadow's grass as one even cover, about 0.5 m tall
  ([The island](../design/island.md#the-meadow)).

Temporal modes
: The anti-aliasing modes that resolve over frames: `taa`, `taau`, `fsr3` and `gt` (the ground
  truth, debug builds only), as against `msaa` and `off` (`packages/render/post/Antialiasing.ts`).

Test mode
: A paused page that runs MSAA, with every history-dependent effect frozen or off, shot once
  `settled` holds; there a paused frame is exactly repeatable ([Test mode](test-mode.md)).

Tier
: A quality tier, every cost knob in one table (`packages/render/Quality.ts`): high is the only
active one.

Wenyao
: The flying fish of the old texts, in schools that break from the swell offshore and glide
  (`packages/island/life/Wenyao.ts`;
  [Life and islanders](../design/life-and-islanders.md#the-cast)).

Yunpeng
: A herb of the old texts: single clumps of straight white stalks far apart on the open meadow,
  which glow softly by night (`packages/island/world/Yunpeng.ts`;
  [The island](../design/island.md#the-yunpeng)).
