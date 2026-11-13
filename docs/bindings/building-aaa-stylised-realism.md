# Binding: building a stylised-realism picture

This project's facts for the skill
[`building-aaa-stylised-realism`](../../skills/building-aaa-stylised-realism/SKILL.md). Each
section is named after the step of the skill that reads it. A project of your own copies the
section names and fills in its own facts.

Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`).

## Look

- The look this project means, and what to avoid: `docs/design/art-direction.md` (The look;
  How the look is made; the light, the shade, the exposure and the image), and a page per subject
  beside it: `island.md`, `sea-and-sky.md`, `night.md`, `life-and-islanders.md`.
- Kept weathers: clear and fair. The others are parked (`packages/render/sky/Weather.ts`
  `PARKED_WEATHER`) and need no support (`AGENTS.md`, Rules for every change).
- Main view and condition: the island view on the clear day at noon, at high quality and 4K output.
  The test scenes (`scenes.html`) draw with the renderer's neutral look instead, which holds no
  style: every gain 1, every offset 0 (`packages/render/look/NeutralLook.ts`); a value there that
  breaks that is a fault, not a look.
- The island's numbers for the look are its own set, `packages/island/look/`; the renderer's tables
  and their readers are in `packages/render/look/` (the skill's knob reference).

## Materials

- Each material's header comment states its values and their source. Before writing its shader,
  read `docs/reference/three-behaviour.md`.
- Its layer (`ARCHITECTURE.md`, rules 10 and 11). A material any scene could use (a generic
  ground, the rain's wet film) is the renderer's, in `packages/render/materials/`, and imports the
  lighting modules directly. A material of this island (its terrain, a plant kind, an islander's
  fabric) is the island's, in `packages/island/materials/` or beside the kind it draws, and takes
  the lighting model only through the renderer's exit, `packages/render/index.ts`; a name it needs
  that the exit lacks is added to the exit. Either way the numbers chosen for the look come from
  the look's readers (`packages/render/look/`), never written into the material
  (`ARCHITECTURE.md`, rule 16).
- Lit as every other surface. The modules named here are in `packages/render/lighting/`,
  `packages/render/ocean/` and `packages/render/post/`; each header comment says more.
  1. Build the material on `GroundBounceLightingModel`, or read its uniforms (`AmbientGrade.ts`).
  2. Take the ambient diffuse through the lighting model's `ambient` (`AmbientSample.ts`), never
     the environment's irradiance alone. `flags=ambientVolume:0` builds the lit materials without
     it.
  3. Add the sunlight the ground bounces up in the lighting model, with `addGroundBounce` or
     `groundBounceLight` (`GroundBounce.ts`), never a bounce of its own.
  4. A lit model of its own adds `shadeLocalLights` (`LocalLights.ts`) and takes its key's cosine
     from `GroundBounceLightingModel`'s `shadeDirection` (`KeyLift.ts`). A new light source is a
     kind of local light registered on the renderer's `localLights` (`add`), never a three light.
  5. Write the metering illuminance beside the colour with `writeMeter` (`MeterLight.ts`), and draw
     only in passes with an MRT.
  6. A material under water lights with `Underwater.ts`, as the terrain does.
  7. Under the temporal modes, write the velocity beside the colour (`Motion.ts`): a material with
     a fragmentNode writes both outputs; one whose positionNode animates supplies
     `positionPrevious` and sets `userData.previousPosition`.
- Tell the water (`Water.ts`, `Refraction.ts`) when the mesh can reach under the sea or stands
  high:
  - A mesh that can reach under the water joins the refraction pass (`Refraction.ts`
    `showUnderwater`); otherwise the water shows what lies straight behind it in the opaque copy
    there.
  - What swims in the upper water (a fish) is marked instead (`markSwimmer`), and its material
    adds `Water.ts` `swimmerSway` to its position.
  - The water reflects only what lies inside `Water.reflectionBounds`: anything opaque placed off
    the island or above 3 m grows that box through `Water.hold` (the game's props do, through the
    island's `holdOpaque` in `packages/island/IslandStages.ts`).
- The neutral, known light: the test scenes' page draws with the renderer's neutral look. The
  scene `ball` holds an 18 % grey card, a white card, a row of albedos from 0.03 to 0.8 and a row
  of roughness; `empty` is level grey ground under the sky (`docs/reference/url-options.md`, The
  test scenes). Shoot and read them with `tools/render/scenes.mjs`; `--look ponlai` loads the
  island's look instead.
- The light alone, apart from the albedos and the display chain: `flags=lightOnly` (and
  `ambientOnly`) with `__PONLAI__.radiance` (`docs/reference/url-options.md`, The lighting layer
  and Radiance).

## Light and air

- Change the island's set in `packages/island/look/`, never a material.
- Try a value on a debug page without a rebuild: the tunables (`docs/reference/url-options.md`,
  Tunable parameters): `__PONLAI__.tune.set( { name: value } )` at run time, or `tune=<base64 JSON>`
  in the URL.
- The clear day's key against the ambient light on the meadow: `tools/island/meadow-light.mjs`,
  with the window its `--expect` takes (its header).
- Whether the land, sky, sea or air brightens anywhere through the dusk:
  `tools/island/dusk-grid.mjs`.

## Image

- The exposure, display and grade tables are in the same set (`packages/island/look/Exposure.ts`,
  `Display.ts`); the local tone's keys are in `packages/render/post/LocalTone.ts`.
- What the grey card lands at under the island's look: `docs/reference/look-values.md`, Exposure.

## Check

- Steps: the skill `verifying-rendering-changes` and its binding
  ([verifying-rendering-changes](verifying-rendering-changes.md): Kinds for the small scenes after
  a change to the renderer's light, sky, exposure or display chain).
- One view: `tools/kit/capture.mjs`. Views on one warm page: `tools/kit/parity/capture-set.mjs`.
  Diffs, crops, sheets and region statistics: `uv run tools/kit/img.py`.
- What colour each kind of surface shows by kind of light, before and after:
  `tools/island/colour-rows.mjs`. The whole day under each kept weather:
  `tools/island/day-sweep.mjs` with `--compare`.

## Record

- Art decisions and departures from real values: `docs/design/art-direction.md`, with the
  measured effect in the module's header comment. The departure on record: the cliff's stone is
  kept darker than real limestone (`docs/design/island.md`, The cliffs).
- Measured look values (light and shade ratios, the grey card's levels, albedos):
  `docs/reference/look-values.md`.
