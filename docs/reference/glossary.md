# Glossary

The project's own words, as the docs and the code use them. Each entry names where the term is
explained in full.

Ambient volume
: The ambient light's probes, baked per chunk (`src/world/AmbientProbes.ts`) and relit every frame
  by the sky's harmonics and the key (`src/lighting/AmbientRelight.ts`). It sees the land, its
  groves and its cliffs, and lights the shade: every lit island material reads it for its ambient
  diffuse (`src/lighting/AmbientSample.ts`).

Baking lighting into albedo
: Tuning a material's colour to make up for an error in the light ([Art
  direction](../explanation/art-direction.md), How the look is made).

Chunk
: A 16 m square of the world (`src/world/Chunks.ts`). A chunk's content is a function of its
  window of the land field, the chunk grown by 32 m (`AGENTS.md`, Rules for every change).

GPU lock
: The lock every tool that renders the scene in a browser takes (`tools/gpu-lock.mjs`): timing
  runs hold it alone, paused captures and probes share it ([Tools](tools.md), GPU lock).

Grow
: The step that adds the next piece to the island in place: it swaps in only the changed chunks in
  one frame (`src/world/Growth.ts`).

Island view
: The game's own view: the island camera zoomed out over the island, from which the look is judged,
  as well as close up ([Art direction](../explanation/art-direction.md), The look).

Kept weathers
: Clear, fair, cloudy and overcast: the weathers every change must hold in.

Key
: The one dominant light: the sun by day, the moon by night
  ([Art direction](../explanation/art-direction.md), Sea, sky and weather).

Lighting
: Setting the light and the image for the whole world, by weather and hour ([Art
  direction](../explanation/art-direction.md), How the look is made).

Lip
: The top edge of the cliff, where the meadow meets the stone and its grass hangs over
  ([Art direction](../explanation/art-direction.md), The island).

Lookdev
: Look development: making each material right on its own: real values checked against the real
  range, then seen first on the clear day at noon, before the other weathers and hours ([Add a
  material](../how-to/add-material.md)).

Parked
: Kept compiling and loadable by name but out of the default checks, until revived as its own
  milestone: the weathers rain, storm and fog (`PARKED_WEATHER` in `src/sky/Weather.ts`) and the
  quality tiers medium and low (`PARKED_QUALITY` in `src/Quality.ts`).

Piece
: One piece of land: the island grows one piece at a time from a starting island at the world's
  centre ([Game design](../explanation/game-design.md), How the island grows).

Pre-exposure
: The scale every writer of the scene's colour and metering light multiplies by and every
  scene-unit reader divides out (`src/post/PreExposure.ts`).

Scene jump
: `establishScene` in `src/main.ts`: it moves a page to another scene, which then holds what a
  fresh load of the same query holds, and clears all state the scene leaves behind.

Settled
: The page's signal that a paused frame is final (`src/post/Settled.ts`); captures are shot once
  it holds.

Stylised realism
: The island's image: physically based and developed like a photograph, but not aimed at
  photorealism ([Art direction](../explanation/art-direction.md), How the look is made).

Sward
: The meadow's grass as one even cover, about 0.5 m tall
  ([Art direction](../explanation/art-direction.md), The island).

Temporal modes
: The anti-aliasing modes that resolve over frames, `taa` and `taau`, as against `msaa` and `off`
  (`src/post/Antialiasing.ts`).

Test mode
: A paused page that runs MSAA, with every history-dependent effect frozen or off, shot once
  `settled` holds; there a paused frame is exactly repeatable ([Tools](tools.md), Test mode).

Tier
: A quality tier, every cost knob in one table (`src/Quality.ts`): high is the only active one.

Wenyao
: The flying fish of the old texts, in schools that break from the swell offshore and glide
  (`src/life/Wenyao.ts`; [Art direction](../explanation/art-direction.md), Life).

Yunpeng
: A herb of the old texts: single clumps of straight white stalks far apart on the open meadow,
  which glow softly by night (`src/world/Yunpeng.ts`;
  [Art direction](../explanation/art-direction.md), The island).
