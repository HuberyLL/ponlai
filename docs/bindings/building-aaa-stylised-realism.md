# Binding: building a stylised-realism picture

This project's facts for the skill
[`building-aaa-stylised-realism`](../../skills/building-aaa-stylised-realism/SKILL.md). Each
section is named after the step of the skill that reads it. A project of your own copies the
section names and fills in its own facts.

Every command that renders in a browser runs under the GPU lock and every wait goes through
`tools/kit/job.mjs` (`AGENTS.md`).

## Look

- The look this project means, and what to avoid: `docs/explanation/art-direction.md` (The look;
  How the look is made; then a section per subject: the island, life, sea, sky and weather, night).
- Kept weathers: clear and fair. The others are parked (`packages/render/sky/Weather.ts`
  `PARKED_WEATHER`) and need no support (`AGENTS.md`, Rules for every change).
- Main view and condition: the island view on the clear day at noon, at high quality and 4K output.
  The test scenes (`scenes.html`) draw with the renderer's neutral look instead, which holds no
  style: every gain 1, every offset 0 (`packages/render/look/NeutralLook.ts`); a value there that
  breaks that is a fault, not a look.
- The island's numbers for the look are its own set, `packages/island/look/`; the renderer's tables
  and their readers are in `packages/render/look/` (the skill's knob reference).

## Materials

- This project's steps for a material (its layer, the lighting model it is built on, what the
  water must be told): `docs/how-to/add-material.md`. Each material's header comment states its
  values and their source.
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
  with the window its `--expect` takes (`docs/reference/tools.md`, Probes).
- Whether the land, sky, sea or air brightens anywhere through the dusk:
  `tools/island/dusk-grid.mjs`.

## Image

- The exposure, display and grade tables are in the same set (`packages/island/look/Exposure.ts`,
  `Display.ts`); the local tone's keys are in `packages/render/post/LocalTone.ts`.
- What the grey card lands at under the island's look: `docs/reference/look-values.md`, Exposure.

## Check

- Steps: `docs/how-to/check-a-change.md`, Run the small scenes first (after a change to the
  renderer's light, sky, exposure or display chain) and Check a visual change.
- One view: `tools/kit/capture.mjs`. Views on one warm page: `tools/kit/parity/capture-set.mjs`.
  Diffs, crops, sheets and region statistics: `uv run tools/kit/img.py`.
- What colour each kind of surface shows by kind of light, before and after:
  `tools/island/colour-rows.mjs`. The whole day under each kept weather:
  `tools/island/day-sweep.mjs` with `--compare`.

## Record

- Art decisions and departures from real values: `docs/explanation/art-direction.md`, with the
  measured effect in the module's header comment. The departure on record: the cliff's stone is
  kept darker than real limestone (The look, and How the look is made).
- Measured look values (light and shade ratios, the grey card's levels, albedos):
  `docs/reference/look-values.md`.
