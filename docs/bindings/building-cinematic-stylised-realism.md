# Binding: building a stylised-realism rendered image

This page holds this project's facts for the skill
[`building-cinematic-stylised-realism`](../../skills/building-cinematic-stylised-realism/SKILL.md).
Each section is named after the step of the skill that reads it. For a project of your own, copy
the section names and fill in your own facts.

Every command that renders in a browser runs under the GPU lock, and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`).

Contents:

- [Look](#look)
- [Materials](#materials)
- [Lighting and atmosphere](#lighting-and-atmosphere)
- [Post-processing](#post-processing)
- [Check](#check)
- [Record](#record)

## Look

- The look this project means, and what to avoid: `docs/design/art-direction.md` (The look; How
  the look is made; Lighting; Shadows and fill light; The exposure; Post-processing), and one page
  per subject beside it: `island.md`, `sea-and-sky.md`, `night.md`, `life-and-islanders.md`.
- Kept weathers: clear and fair. The others are parked (`packages/render/sky/Weather.ts`
  `PARKED_WEATHER`) and need no support (`AGENTS.md`, Rules for every change).
- Main view and conditions: the island view on the clear day at noon, on the high quality tier at
  4K output. The test scenes (`scenes.html`) render with the render pipeline's neutral look
  instead, which holds no style: every gain is 1 and every offset 0
  (`packages/render/look/NeutralLook.ts`). A value there that breaks this is a fault, not a look.
- The island's values for the look are its own set, in `packages/island/look/`. The render
  pipeline's tables and the code that reads them are in `packages/render/look/` (the skill's
  parameter reference: `look-parameters.md`).

## Materials

- Each material's header comment states its values and their source. Before you write its shader,
  read `docs/reference/three-behaviour.md`.
- Choose the material's layer (`ARCHITECTURE.md`, rules 10 and 11). A material any scene could use
  (a generic ground, the rain's wet film) belongs to the render pipeline, in
  `packages/render/materials/`, and imports the lighting modules directly. A material of this
  island (its terrain, a plant kind, an islander's fabric) belongs to the island, in
  `packages/island/materials/` or beside the kind it draws. It reaches the lighting model only
  through the render pipeline's entry point, `packages/render/index.ts`; if it needs a name that the
  entry point does not export, add the name there. Either way, the values chosen for the look come
  from the code that reads the look (`packages/render/look/`) and are never written into the
  material (`ARCHITECTURE.md`, rule 16).
- Light the material as every other surface is lit. The modules named here are in
  `packages/render/lighting/`, `packages/render/ocean/` and `packages/render/post/`; each header
  comment says more.
  1. Build the material on `GroundBounceLightingModel`, or read its uniforms (`AmbientGrade.ts`).
  2. Take the ambient diffuse light through the lighting model's `ambient` (`AmbientSample.ts`),
     never from the environment's irradiance alone. `flags=ambientVolume:0` builds the lit
     materials without it.
  3. Add the sunlight that the ground bounces up inside the lighting model, with `addGroundBounce`
     or `groundBounceLight` (`GroundBounce.ts`), never with a bounce of the material's own.
  4. A material with its own lit shading model adds `shadeLocalLights` (`LocalLights.ts`) and takes
     its key light's cosine from `GroundBounceLightingModel`'s `shadeDirection` (`KeyLift.ts`). A
     new light source is a kind of local light registered on the render pipeline's `localLights`
     (`add`), never a three.js light.
  5. Write the metering illuminance beside the colour with `writeMeter` (`MeterLight.ts`), and draw
     only in passes with multiple render targets (MRT).
  6. A material under water is lit with `Underwater.ts`, as the terrain is.
  7. In the temporal modes (temporal anti-aliasing and upsampling), write the velocity beside the
     colour (`Motion.ts`). A material with a fragmentNode writes both outputs. A material whose
     positionNode animates supplies `positionPrevious` and sets `userData.previousPosition`.
- Register the mesh with the water system (`Water.ts`, `Refraction.ts`) when it can reach under the
  sea or stands high:
  - A mesh that can reach under the water joins the refraction pass (`Refraction.ts`
    `showUnderwater`). Otherwise the water shows whatever lies straight behind it in the opaque
    copy at that point.
  - Something that swims in the upper water (a fish) is marked instead (`markSwimmer`), and its
    material adds `Water.ts` `swimmerSway` to its position.
  - The water reflects only what lies inside `Water.reflectionBounds`. Anything opaque placed off
    the island or higher than 3 m grows that box through `Water.hold`. The game's props do this
    through the island's `holdOpaque` in `packages/island/IslandStages.ts`.
- Neutral, known lighting: the test scenes' page renders with the render pipeline's neutral look.
  The scene `ball` holds an 18 % grey card, a white card, a row of albedos from 0.03 to 0.8 and a
  row of roughness values; `empty` is level grey ground under the sky
  (`docs/reference/url-options.md`, The test scenes). Capture and read them with
  `tools/render/scenes.mjs`; `--look ponlai` loads the island's look instead.
- The lighting alone, without the albedos and post-processing: `flags=lightOnly` (and
  `ambientOnly`) with `__PONLAI__.radiance` (`docs/reference/url-options.md`, The lighting layer
  and Radiance).

## Lighting and atmosphere

- Change the island's set in `packages/island/look/`, never a material.
- To try a value on a debug page without a rebuild, use the tunable parameters
  (`docs/reference/url-options.md`, Tunable parameters): `__PONLAI__.tune.set( { name: value } )`
  at run time, or `tune=<base64 JSON>` in the URL.
- The clear day's key-to-ambient ratio on the meadow: `tools/island/meadow-light.mjs`, with the
  window its `--expect` option takes (see its header).
- Whether the land, sky, sea or haze brightens anywhere through the dusk:
  `tools/island/dusk-grid.mjs`.

## Post-processing

- The exposure, display and colour grading tables are in the same set
  (`packages/island/look/Exposure.ts`, `Display.ts`). The local tone mapping keyframes are in
  `packages/render/post/LocalTone.ts`.
- Where the grey card lands under the island's look: `docs/reference/look-values.md`, Exposure.

## Check

- Steps: the skill `verifying-rendering-changes` and its binding
  ([verifying-rendering-changes](verifying-rendering-changes.md): Kinds, for the small scenes after
  a change to the render pipeline's lighting, sky, exposure or post-processing chain).
- One view: `tools/kit/capture.mjs`. Views on one warm page: `tools/kit/parity/capture-set.mjs`.
  Diffs, crops, comparison sheets and region statistics: `uv run tools/kit/img.py`.
- The colour each kind of surface shows under each kind of light, before and after:
  `tools/island/region-colours.mjs`. The whole day under each kept weather:
  `tools/island/day-sweep.mjs` with `--compare`.

## Record

- Art decisions and departures from real values: `docs/design/art-direction.md`, with the measured
  effect in the module's header comment. The departure on record: the cliff's stone is kept darker
  than real limestone (`docs/design/island.md`, The cliffs).
- Measured look values (lighting ratios, the grey card's levels, albedos):
  `docs/reference/look-values.md`.
