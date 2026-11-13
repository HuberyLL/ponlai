# Add a material

This guide gives the steps for adding a material, a new surface such as a stone, a plant or a
fabric, so that it joins the look with no tuning of its own. It is the lookdev side of keeping
lookdev and lighting strictly apart. Why it works this way: `docs/explanation/art-direction.md`,
How the look is made. Before you write its shader, read
[three.js and WebGPU behaviour](../reference/three-behaviour.md).

## 1. Find the real values

Take the material's albedo (the diffuse colour, in linear values), roughness and, for leaves and
thin things, how much light passes through, from one of these sources:

- a scan of the real material;
- a photograph taken in even daylight with a colour chart in the frame, white-balanced and exposed
  on the chart's grey patches, then read in linear values;
- a published measurement (a paper or an albedo table), credited in `CREDITS.md`.

Write the values and their source in the module's header comment.

## 2. Check them against the real range

Compare the values with the range real examples of that kind cover, and with the island's
neighbouring materials (each module's header comment states its values). A value outside the real
range is either a mistake in the source or a deliberate departure (step 6); it is never left in
silently.

## 3. Light it as every other surface

A lit material is built on the renderer's lighting model, so the same light reaches it as every
other surface. The modules named below are in `packages/render/lighting/`, `packages/render/ocean/`
and `packages/render/post/`; each header comment says more.

Put the material in its layer first (`ARCHITECTURE.md`, rules 10 and 11). A material any scene
could use (a generic ground, the rain's wet film) is the renderer's, in
`packages/render/materials/`, and imports the lighting modules directly. A material of this
island (its terrain, a plant kind, an islander's fabric) is the island's, in
`packages/island/materials/` or beside the kind it draws, and takes the lighting model only
through the renderer's exit, `packages/render/index.ts`; a name it needs that the exit lacks is
added to the exit. Either way the numbers chosen for the look come from the look's readers
(`packages/render/look/`), never written into the material (`ARCHITECTURE.md`, rule 16).

1. Build the material on `GroundBounceLightingModel`, or read its uniforms (`AmbientGrade.ts`).
2. Take the ambient diffuse through the lighting model's `ambient` (`AmbientSample.ts`), never the
   environment's irradiance alone. `flags=ambientVolume:0` builds the lit materials without it.
3. Add the sunlight the ground bounces up in the lighting model, with `addGroundBounce` or
   `groundBounceLight` (`GroundBounce.ts`), never a bounce of its own.
4. A lit model of its own adds `shadeLocalLights` (`LocalLights.ts`) and takes its key's cosine from
   `GroundBounceLightingModel`'s `shadeDirection` (`KeyLift.ts`). A new light source is a
   kind of local light registered on the renderer's `localLights` (`add`), never a three light.
5. Write the metering illuminance beside the colour with `writeMeter` (`MeterLight.ts`), and draw
   only in passes with an MRT.
6. A material under water lights with `Underwater.ts`, as the terrain does.
7. Under the temporal modes, write the velocity beside the colour (`Motion.ts`): a material with a
   fragmentNode writes both outputs; one whose positionNode animates supplies `positionPrevious`
   and sets `userData.previousPosition`.

If the mesh can reach under the sea or stands high, tell the water (`Water.ts`, `Refraction.ts`):

- A mesh that can reach under the water joins the refraction pass (`Refraction.ts`
  `showUnderwater`); otherwise the water shows what lies straight behind it in the opaque copy
  there.
- What swims in the upper water (a fish) is marked instead (`markSwimmer`), and its material adds
  `Water.ts` `swimmerSway` to its position.
- The water reflects only what lies inside `Water.reflectionBounds`: anything opaque placed off the
  island or above 3 m grows that box through `Water.hold` (the game's props do, through the
  island's `holdOpaque` in `packages/island/IslandStages.ts`).

## 4. Place it and judge the whole frame

Capture the island view before and after the change (`tools/kit/parity/capture-set.mjs`,
its header): first on the clear day at noon, then under the other kept
weather (fair) at the usual hours. Judge the whole frame first; crops and
region statistics (`uv run tools/kit/img.py`) find causes, they do not judge. What colour each surface
shows on screen by kind and by light: `tools/island/colour-rows.mjs`.

## 5. When it looks wrong, look upstream first

Check in this order, and stop at the first cause found:

1. The exposure and the tone mapping: is the whole frame too bright or too dark?
2. The light for that weather and hour: the balance between the key and the ambient light
   (`tools/island/meadow-light.mjs` on the clear day), the sky's brightness, the haze.
3. The grade.
4. The material's model: does it lack something the real surface does (light through a leaf, the
   fuzz of moss, a wet film)? Add that to the model.
5. The material's values: change them only if they lie outside the real range.

Never push a material past real values to make up for an error found in 1 to 3 (baking lighting
into albedo). Fix the light instead, and recheck every material it touches.

## 6. Record a deliberate departure

When the look needs a material outside its real range, write it in
`docs/explanation/art-direction.md` with the
reason, and in the module's header comment with the measured effect. Keep these few.
