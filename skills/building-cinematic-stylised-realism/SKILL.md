---
name: building-cinematic-stylised-realism
description: Builds or fixes a stylised-realism rendered image on a physically based renderer, and decides where a change to the look belongs, when grass reads too dark, a frame looks flat or grey, a colour cast covers everything, the distance is too clear or too milky, or a new material does not sit with the rest. Keeps materials at physically plausible values, puts the style in three places only (the content chosen, global lighting parameters per weather and time of day, post-processing), works in the order content, materials, lighting, atmosphere, exposure, tone mapping, colour grading, and sends a wrong look to the earliest layer that can cause it. Use with three.js WebGPU renderers, or any physically based renderer, whenever a material, the lighting, the haze or fog, the exposure, the tone mapping or the colour grade is changed to improve or fix the look.
---

# Building a stylised-realism rendered image

A physically based base carries the rendered image: materials authored with physically plausible
values, lit by a physically based lighting model. The style sits on top of it, in three places
only. This skill places a change in the right layer, finds and checks material values, and hands
parameter values that need fitting to reference images to another skill.

## Rules most often broken without notice

- Never tune a material to make up for the lighting, the atmosphere or post-processing. Doing so
  bakes the lighting's error into the albedo, and the material breaks again each time the lighting
  changes.
- When something downstream looks wrong (a dark surface, a colour cast, a flat frame), check the
  layers upstream of the material first, in the order below. Change a material last, and only when
  its values lie outside the real range or its shading model lacks something the real surface does.
- When something upstream changes (content, a material, the lighting), check everything downstream
  of it again: the atmosphere, the exposure, the tone mapping and the colour grade were set for the
  old input.
- Make a departure from physically plausible values for a whole class of things or for the whole
  world at once. Record a departure for one material by name, with its reason.
- A change of style is a global parameter that changes everything together, never a fix on one
  object.
- Never fit a material to a finished frame. Reference images may set lighting, atmosphere and
  post-processing parameters (the skill `fitting-a-look-to-reference-images`); content is chosen by
  eye against them.
- Judge the whole frame first, at the main view, weather and time of day. Crops and region
  statistics find causes; they do not judge.

## The model

The base is physical: materials with physically plausible values, one lighting model for every
surface, and exposure from a physically based camera. The style goes in three places:

1. Content: what is in the rendered image, chosen and simplified. Few kinds of plant per place,
   quiet textures with little noise, pushed colour, and leaves that let more light through, each
   decided for a whole class of things at once.
2. Lighting: the lighting departs from physical correctness globally, per weather and time of day
   (the ambient balance, the sky's brightness, the bounce light, the haze).
3. Post-processing: exposure, tone mapping, colour grading and the night treatment.

The order of the layers is content, materials, lighting, atmosphere (haze, fog), exposure, tone
mapping, colour grading. It is arranged by dependency: each layer takes the one before it as
input. The order is this skill's own, not a published standard. It rests on two established
practices: physically based rendering with materials kept separate from lighting, and film look
development in neutral lighting before shot lighting. The look is built over many rounds in this
order, never in one pass from zero. The reasons and the sources are in
[background.md](background.md). This renderer's parameters, layer by layer, are in
[look-parameters.md](look-parameters.md).

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: where its look is described, its kept
weathers and main view, where measured look values live, its named departures, and its tools for
the rendered image. Read section X of `docs/bindings/building-cinematic-stylised-realism.md` when
you reach the step. If the project's `AGENTS.md` or `CLAUDE.md` names another file for this skill,
that file wins.

If there is no binding, find each fact in the project (its art direction or style guide, its
README, the look's tables or settings, its capture tools) and ask the user for what you cannot
find. When the work ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Say what is wrong and place it
- [ ] 2. Content
- [ ] 3. Materials
- [ ] 4. Lighting and atmosphere
- [ ] 5. Exposure, tone mapping and colour grading
- [ ] 6. Check downstream and judge the whole frame
- [ ] 7. Record
```

Do only the steps the change needs, in this order. Work on the main weather and time of day first
(a clear day at noon is the usual one), then the others.

### 1. Say what is wrong and place it (binding: Look)

1. Write what is wrong in one sentence, in on-screen terms: what, where, in which weather and at
   which time of day, compared with what (the project's described look, a reference image, an
   earlier capture).
2. Read the project's look description for what is intended there. An intended look is not a bug.
3. Find the first layer to check in this table, and check the layers in its order. Stop at the
   first cause you find.

| What looks wrong | Check first | Then | Last |
| --- | --- | --- | --- |
| The whole frame too dark or too bright; a grey card off its expected value | Exposure: its key value and what it meters | The tone curve's mid grey | Never the albedos |
| One kind of surface too dark (the grass in sun) | Exposure, then the key light against the ambient light | The material's shading model: does it lack light transmitted through the leaf? | Its values, only if outside the real range |
| Shadowed areas too dark or too bright against sunlit ones | The ambient light: sky brightness, bounce light, ambient grade | Occlusion strength; local tone mapping, shadow contrast | Not the albedos |
| A colour cast over everything | White balance; the key light's and the sky's colour | The colour grade | Not the materials |
| One hue off across the whole frame (every green too yellow) | The lighting's colour; the colour grade's hue band for that hue | The class's values, together, within the real range | Never one material alone |
| The distance too clear, too milky or the wrong colour | The atmosphere: haze or fog density, height, colour | Exposure | Not the far materials |
| Highlights clip; the sky burns out | The exposure's highlight limit; the tone curve's shoulder | Bloom | Not the sky's own brightness alone |
| The frame flat or grey | Tone curve contrast; local tone mapping | Ambient light against key light | Not the materials' contrast |
| The frame busy, noisy, hard to read | Content: fewer kinds, quieter textures | Colour grade contrast | Not a blur or a filter |
| The night looks like a darker day | The night treatment: night exposure, the Purkinje shift, the night white balance | The night lighting | Not the materials |
| Right at noon, wrong at one time of day or in one weather | The parameter keyframed by that time of day or weather | | Never the materials |
| One material wrong while all others are right in the same lighting | The material's shading model (transmitted light, fuzz, a wet film) | Its values against the real range | |

### 2. Content (binding: Look)

Choose and simplify what is in the rendered image, by eye, with the project's look description and
any reference images beside you. Decide for a whole class at once: which kinds of plant stand in a
place, how quiet a texture is, and how far a class's colour is pushed within what the real thing
could be. Content is chosen, not fitted to a number.

### 3. Materials (binding: Materials)

1. Find the real values: the albedo (diffuse colour, linear), the roughness and, for leaves and
   thin things, how much light passes through. Take them from a scan of the real material, from a
   photograph in even daylight with a colour chart in frame (white-balanced and exposed on the
   chart's grey patches, read in linear values), or from a published measurement, credited.
2. Write the values and their source beside the material.
3. Check them against the range that real examples of that kind cover, and against the neighbouring
   materials. A value outside the range is a mistake in the source or a departure (see the rules
   above); never leave it in silently.
4. Look at the material first under neutral, known lighting: a scene whose lighting you know, with
   an 18 % grey card, a grey ball, a chrome ball and a colour chart beside it, and post-processing
   with no style (neutral exposure, no grade). The grey card must land where the lighting says it
   should.
5. Then place it in the main view at the main weather and time of day, then in the other kept
   weathers and times of day. Build it on the shared lighting model, so the same light reaches it as
   every other surface. The look's values come from the look's tables and are never written into the
   material.

### 4. Lighting and atmosphere (binding: Lighting and atmosphere)

Set the lighting parameters per weather and time of day: the key light against the ambient light,
the sky's brightness and colour, the ground's bounce light, and the occlusion's strength. Then set
the atmosphere: haze and fog density, height and colour. Each parameter changes every material
together. This renderer's parameters are in [look-parameters.md](look-parameters.md), Lighting and
Atmosphere.

### 5. Exposure, tone mapping and colour grading (binding: Post-processing)

Set the exposure (what it meters and where its key value lands), then the tone mapping (the curve
and local tone mapping), then the colour grade (white balance, lookup tables, hue bands), then the
night treatment. The parameters are in [look-parameters.md](look-parameters.md), Post-processing.

When the question becomes "what value should this lighting, atmosphere or post-processing
parameter have" and you have reference images, go to the skill
`fitting-a-look-to-reference-images`. Material values never go there.

### 6. Check downstream and judge the whole frame (binding: Check)

1. Capture the views the change affects before and after it, at the main weather and time of day,
   then at the others the project keeps.
2. Judge the whole frame first: does it read as the described look? Then measure what changed with
   crops and region statistics, and report the measured differences.
3. Every layer downstream of the change was set for the old input: look at each one again.

### 7. Record (binding: Record)

- A departure from plausible values: its class or material, the value, the real range, the reason
  and its measured effect, recorded where the project keeps its art decisions.
- A measured look value worth keeping (a grey card's level, a lighting ratio): recorded where the
  project keeps measured values.

## Scope

This skill covers surface values, lighting and post-processing. It does not cover form, texture
detail or modelling.
