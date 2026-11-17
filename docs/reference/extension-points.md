# Extension points

The render pipeline's extension points: where a plant kind, a kind of local light, an extra pass of
the frame, a scene event or a history is registered, and what each registration takes. The render
pipeline names none of these: each is a definition registered from the layer that owns it (the
island, or a test scene). Why it works this way: [Architecture rules](architecture-rules.md), rule
18. Before writing a shader or a pass: [three.js and WebGPU behaviour](three-behaviour.md).

Contents:

- [The three declarations](#the-three-declarations)
- [Plant kinds](#plant-kinds)
- [Kinds of local light](#kinds-of-local-light)
- [Extra passes](#extra-passes)
- [Scene events](#scene-events)
- [Histories](#histories)
- [What checks a registration](#what-checks-a-registration)

A layer above the render pipeline imports everything it uses from the render pipeline through the
render pipeline's main entry point, `packages/render/index.ts`. When it needs a name that the entry
point does not export, add the name to the entry point.

## The three declarations

Every plant kind, kind of local light and extra pass declares three things, or its registry refuses
it (`packages/render/Extensions.ts`):

| Field | Value | Meaning |
| --- | --- | --- |
| `cost` | a field of the quality table (`packages/render/Quality.ts`), or `'none'` | The quality setting that governs its cost; `'none'` when no tier changes it. The table is closed: a new setting is a new field there. |
| `testMode` | `'stateless'`, or `{ held, by, settled }` | Its test-mode behaviour. `'stateless'` when what it draws is a function of the scene alone, with no history. Otherwise: whether the test mode freezes it or turns it off (`held`), the switch or site that does so (`by`), and what the page's `settled` signal waits for (`settled`). |
| `land` | `'independent'`, or `{ follower }` | `'independent'` when it does not depend on the land's shape; otherwise the follower that prepares its next version and swaps it in during a growth swap. |

The declarations are statements that the registry checks for, not hooks: a follower named in `land`
is still wired by hand. A history-dependent effect follows
[verifying-rendering-changes](../bindings/verifying-rendering-changes.md#history); something that
depends on the land's shape follows `packages/island/world/Growth.ts`'s header.

## Plant kinds

The type is `VegetationKind` in `packages/render/vegetation/Registry.ts`. Its fields:

| Field | Meaning |
| --- | --- |
| `name` | The kind's name. |
| `root` | The object the scene draws, for a kind with art of its own. |
| `sites` | Where the default plant stands, for a kind without art of its own (in place of `root`). |
| `prepass` | Whether it takes the depth prepass. |
| `shadowFilter` | Its shadow filter; it must match the vegetation tag on its materials. |
| `sunCaster` | Whether it casts into the sun's map. |
| `rainBake` | Whether it is baked into the rain's collision map. |
| `growth` | For a kind that changes with the land: `prepare` and `swap`. Its follower is named in `land`. |
| `cost`, `testMode`, `land` | [The three declarations](#the-three-declarations). |

The test scene `app/scenes/plants.ts` registers a kind without art of its own:

```ts
{
    name: 'patch', sites: sites(),
    prepass: true, shadowFilter: 'vegetation', sunCaster: true, rainBake: true,
    cost: 'none', testMode: 'stateless', land: 'independent',
}
```

The registry:

- Each page makes one registry (`new Vegetation( defaultRoot )`) and adds every kind with `add`, in
  the order the scene draws them. `placeVegetation` (`packages/render/RenderStages.ts`) places the
  kinds and closes the registry; a kind added after it throws.
- On the island the kinds are added in `createVegetation` (`packages/island/IslandStages.ts`). On
  the test scenes' page, a scene returns its kinds from `build()` as `plants`, and
  `app/scenes/ScenePage.ts` adds them.
- A kind drawn with the default plant (`packages/render/vegetation/DefaultPlant.ts`) is a merged
  mesh of leaf cards: it does not move in the wind, read the displacement field or thin with
  distance. A kind with those has a `root` of its own.
- The plant patch scene shows a kind on its own:
  `node tools/render/scenes.mjs <baseUrl> <outDir> --scenes plants`
  ([verifying-rendering-changes](../bindings/verifying-rendering-changes.md#kinds)).

## Kinds of local light

The type is `LocalLightKind` in `packages/render/lighting/LocalLights.ts`. Its fields are `name`,
the three declarations and `sources()`, which returns where its sources stand now. Each source gives
a `position`, and may give an `intensity` (linear RGB, the illuminance at 1 m) and a `range` (m);
without them it is a white point light (`DEFAULT_SOURCE`).

```ts
render.localLights.add( {
    name: 'light test', cost: 'none', testMode: 'stateless', land: 'independent',
    sources: () => testLights,
} );
```

- `render.localLights.add` takes a kind at any time after the render pipeline's `createLight` stage
  has made the light table. The table reads the kind's sources when it is added.
- `render.localLights.refresh()` reads every kind's sources again, for sources that moved or changed
  (a growth, a test flag).
- Every kind's light is scaled by the table's single strength, which the app sets each frame through
  the render pipeline's frame stages (`lightNight`).

## Extra passes

The type is `ExtraPass` in `packages/render/post/ExtraPass.ts`. Its fields are `name`, the three
declarations and `declare( graph )`, which adds the pass to the frame graph with `addPass`,
declaring its size class, when it runs and every texture it reads. `declare` runs when the graph is
built, so it cannot read a frame's data; the pass reads its state when it runs. `leavesPass` in
`packages/island/world/FallingLeaves.ts` is a compute pass written this way.

- The app passes its extra passes to the render pipeline in a list, given to the stage that builds
  the frame's passes. The list is fixed there:

  ```ts
  createSeaAndPipeline( render, { rainCeiling, extraPasses: [ leavesPass( () => island.fallingLeaves ) ] } );
  ```

- The passes run in the list's order, after the displacement field's pass and before the wave maps',
  ahead of the scene's passes.
- A draw that shows only at times (a mesh that appears later) has its pipeline precompiled as a
  latent draw of its scene pass: `render.latents.latent( 'opaque', [ mesh ], kernels )`. The pass's
  name is a literal that the latent's signature types, so a name that is not a scene pass does not
  compile.

## Scene events

`declareSceneEvents` (`packages/render/post/SceneEvents.ts`) declares a layer's reasons once, where
it raises them, each with whether it resets the temporal history. It returns the function that
raises them:

```ts
const islandEvent = declareSceneEvents( { 'world swap': false, 'approach': false } );
```

A reason declared twice throws. A reason is raised at the site that changes the scene in a way that
its earlier frames do not predict.

## Histories

The render pipeline's table of how each history is cleared is `render.history`
(`packages/render/post/SceneHistory.ts`):

- `onCut( name, clear )`, registered where the history's owner is made, clears the history when the
  temporal history is reset.
- `onJump( name, clear )` clears it on a scene jump; `'after bake'` marks an entry that needs the
  lighting that the jump's sky bake publishes.
- The island's jump entries are registered in `registerIslandHistories`
  (`packages/island/IslandStages.ts`), which the scene jump calls in order with the render
  pipeline's (`packages/render/assemble/SceneJump.ts`, through the app's `app/Scene.ts`). Each list
  runs in the order registered.
- `node tools/island/verify-scene-jump.mjs` checks that a page after a scene jump draws what a fresh
  load draws (its header).

## What checks a registration

- `npm run check` runs `tools/render/verify-extensions.mjs`. It registers definitions of its own at
  every point, checks that one without its declarations is refused, and searches the registries'
  owners for the names of the island's definitions: a registry that names a kind fails it.
- The small scenes and the captures that show a definition:
  [verifying-rendering-changes](../bindings/verifying-rendering-changes.md).
