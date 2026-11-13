# Add to the renderer

This guide gives the steps for adding a plant kind, a kind of local light or an extra pass of the
frame to the renderer, and for declaring the scene events and histories that come with them. The
renderer names none of these: each is a definition registered at one of its extension points, from
the layer that owns it (the island, or a test scene). Why it works this way:
[ARCHITECTURE.md](../../ARCHITECTURE.md), Rules across the layers, rule 18.

## Before you start

Every plant kind, kind of light and extra pass states three things, or its registry refuses it
(`packages/render/Extensions.ts`). Decide them first:

- `cost`: the field of the quality table (`packages/render/Quality.ts`) that governs its cost, or
  `'none'` when no tier changes it. The table is closed: a new knob is a new field there.
- `testMode`: `'stateless'` when what it draws is a function of the scene alone, with no history.
  Otherwise `{ held, by, settled }`: whether the test mode freezes it or turns it off, the switch
  or site that does so, and what the page's `settled` signal waits for. A history-dependent effect
  also follows `docs/how-to/check-a-change.md`, Add a history-dependent effect.
- `land`: `'independent'` when it does not depend on the land's shape, otherwise
  `{ follower }`, naming what carries it through a growth. The declaration is a statement; the
  follower itself is wired by hand (`docs/how-to/check-a-change.md`, Add something that depends on
  the land's shape).

A layer above the renderer imports everything below through the renderer's exit,
`packages/render/index.ts`. A name it needs that the exit lacks is added to the exit.

## Register a plant kind

1. Write the kind (`VegetationKind` in `packages/render/vegetation/Registry.ts`): its `name`, its
   `root` (the object the scene draws) or, for a kind without art of its own, its `sites` (where
   the default plant stands), whether it takes the depth prepass (`prepass`), its shadow filter
   (`shadowFilter`, which must match the vegetation tag on its materials), whether it casts into
   the sun's map (`sunCaster`) and is baked into the rain's collision map (`rainBake`), and the
   three declarations. A kind that changes with the land adds `growth` (`prepare` and `swap`) and
   names its follower in `land`.

   The test scene `app/scenes/plants.ts` registers a kind without art of its own:

   ```ts
   {
       name: 'patch', sites: sites(),
       prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true,
       cost: 'none', testMode: 'stateless', land: 'independent',
   }
   ```

2. Add it to the page's registry before the renderer places the kinds. The page makes one
   registry (`new Vegetation( defaultRoot )`), adds every kind with `add` in the order the scene
   draws them, then calls `placeVegetation` (`packages/render/RenderStages.ts`), which closes it.
   On the island this is `createVegetation` in `packages/island/IslandStages.ts`; on the scene
   page a scene returns its kinds from `build()` as `plants`, and `app/scenes/ScenePage.ts` adds
   them. A kind added after `placeVegetation` throws.
3. Check it on the plant patch: `node tools/scenes.mjs <baseUrl> <outDir> --scenes plants`
   (`docs/how-to/check-a-change.md`, Run the small scenes first).

A kind drawn with the default plant (`packages/render/vegetation/DefaultPlant.ts`) is a merged
mesh of leaf cards: it does not move in the wind, read the displacement field or thin with
distance. A kind with those has a `root` of its own.

## Register a kind of local light

1. Write the kind (`LocalLightKind` in `packages/render/lighting/LocalLights.ts`): its `name`,
   the three declarations and `sources()`, which returns where its sources stand now. Each source
   gives a `position` and may give an `intensity` (linear RGB, the illuminance at 1 m) and a
   `range` (m); without them it is a white point light (`DEFAULT_SOURCE`).

   ```ts
   render.localLights.add( {
       name: 'light test', cost: 'none', testMode: 'stateless', land: 'independent',
       sources: () => testLights,
   } );
   ```

2. Add it with `render.localLights.add` at any time after the renderer's `createLight` stage has
   made the light table. The table reads the kind's sources when it is added.
3. When the sources move or change (a growth, a test flag), call `render.localLights.refresh()`,
   which reads every kind's sources again. Every kind's light is scaled by the table's one
   strength, which the page sets each frame through the renderer's frame stages (`lightNight`).

## Add an extra pass of the frame

1. Write the pass (`ExtraPass` in `packages/render/post/ExtraPass.ts`): its `name`, the three
   declarations and `declare( graph )`, which adds the pass to the frame graph with `addPass`,
   declaring its size class, when it runs and every texture it reads. `declare` runs when the
   graph is built, so it cannot read a frame's data; the pass reads its state when it runs.
   `leavesPass` in `packages/island/world/FallingLeaves.ts` is a compute pass written this way.
2. Hand it to the renderer in the list of extra passes the page gives the stage that builds the
   frame's passes:

   ```ts
   createSeaAndPipeline( render, { rainCeiling, extraPasses: [ leavesPass( () => island.fallingLeaves ) ] } );
   ```

   The list is fixed there. The passes run in its order, after the displacement field's pass and
   before the wave maps', ahead of the scene's passes.
3. A draw that shows only at times (a mesh that appears later) is compiled ahead by registering it
   as a latent of its scene pass: `render.latents.latent( 'opaque', [ mesh ], kernels )`. Write the
   pass's name as a literal; the latent's signature types it, so a name that is not a scene pass
   does not compile.

## Declare scene events and histories

1. Declare the layer's reasons once, where it raises them, with whether each cuts the temporal
   history (`declareSceneEvents` in `packages/render/post/SceneEvents.ts`). The declaration
   returns the function that raises them:

   ```ts
   const islandEvent = declareSceneEvents( { 'world swap': false, 'approach': false } );
   ```

   A reason declared twice throws. Raise one at the site that changes the scene in a way its
   frames do not show.
2. Register how a history is cleared in the renderer's table (`render.history`,
   `packages/render/post/SceneHistory.ts`): `onCut( name, clear )` where its owner is made, for a
   cut of the temporal history, and `onJump( name, clear )` for a scene jump, with
   `'after bake'` for an entry that needs the light the jump's sky bake publishes. The island's
   jump entries are registered in `registerIslandHistories` (`packages/island/IslandStages.ts`),
   which the page calls in order with the renderer's (`app/Scene.ts`). Each list runs in the order
   registered.
3. Run `node tools/verify-scene-jump.mjs` (`docs/reference/tools.md`) to check that a jumped page
   draws what a fresh load draws.

## Check the registration

1. Run `npm run check`. Its `tools/verify-extensions.mjs` registers definitions of its own at
   every point, checks that one without its declarations is refused, and searches the
   registries' owners for the names of the island's definitions: a registry that names a kind
   fails it.
2. Run the small scenes and the captures that show the definition
   (`docs/how-to/check-a-change.md`).
