---
name: building-cinematic-stylised-realism
description: Builds or fixes a stylised-realism picture on a physically based renderer, and decides where a change to the picture goes, when grass reads too dark, a frame looks flat or grey, a colour cast covers everything, the distance is too clear or too milky, or a new material does not sit with the rest. Keeps materials at physically plausible values, puts the style in three places only (the content chosen, global light knobs per weather and hour, the image), works in the order content, materials, light, air, exposure, tone, grade, and sends a wrong look to the earliest layer that can cause it. Use with three.js WebGPU renderers, or any physically based renderer, whenever a material, the light, the air, the exposure, the tone mapping or the grade is changed to improve or fix the look.
---

# Building a stylised-realism picture

A physically based base carries the picture: materials authored with physically plausible values,
lit by a physically based lighting model. The style sits on top of it, in three places only. This
skill places a change in the right layer, finds and checks material values, and hands knob values
that need fitting to reference images to another skill.

## Rules most often broken without notice

- Never tune a material to make up for the light, the air or the image. It bakes the light's
  error into the albedo, and it breaks again each time the light changes.
- When something downstream looks wrong (a dark surface, a cast, a flat frame), check the layers
  upstream of the material first, in the order below. Change a material last, and only when its
  values lie outside the real range or its model lacks what the real surface does.
- When something upstream changes (content, a material, the light), check what is downstream of
  it again: the air, the exposure, the tone and the grade were set on the old input.
- A departure from physically plausible values is made for a whole class of things or the whole
  world at once. A departure for one material is recorded by name, with its reason.
- A change of style is a global knob that moves everything together: never a fix on one object.
- A material is never fitted to a finished frame. Reference images may set light, air and image
  knobs (the skill `fitting-a-look-to-reference-images`); content is chosen by eye against them.
- Judge the whole frame first, at the main view, weather and hour. Crops and region statistics
  find causes; they do not judge.

## The model

The base is physical: materials with physically plausible values, one lighting model for every
surface, exposure from a physically based camera. The style goes in three places:

1. Content: what is in the picture, chosen and simplified. Few kinds of plant per place, quiet
   textures with little noise, colour pushed and leaves that let more light through, each for a
   whole class of things at once.
2. Light: the lighting leaves physical correctness globally, per weather and time of day (the
   ambient balance, the sky's brightness, the bounce, the haze).
3. Image: exposure, tone mapping, grade and the night's treatment.

The order of the layers is: content, materials, light, air (haze, fog), exposure, tone, grade.
It is arranged by dependency: each layer takes the one before it as input. The order is this
skill's own, not a published standard; it rests on two established practices, physically based
rendering with materials kept apart from the light, and film look development in a neutral light
before shot lighting. The look is built over many rounds in this order, never once from zero.
Why, and the sources: [background.md](background.md). The knobs of this renderer, layer by layer:
[renderer-knobs.md](renderer-knobs.md).

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: where its look is described, its kept
weathers and main view, where measured look values live, its named departures, and its tools for
the picture. Read section X of `docs/bindings/building-cinematic-stylised-realism.md` when you
reach the step. If the project's `AGENTS.md` or `CLAUDE.md` names another file for this skill,
that file wins.

No binding: find each fact in the project (its art direction or style guide, README, the look's
tables or settings, its capture tools) and ask the user for what you cannot find. When the work
ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Say what is wrong and place it
- [ ] 2. Content
- [ ] 3. Materials
- [ ] 4. Light and air
- [ ] 5. Exposure, tone and grade
- [ ] 6. Check downstream and judge the whole frame
- [ ] 7. Record
```

Do only the steps the change needs, in this order. Work on the main weather and hour first (a
clear day at noon is the usual one), then the others.

### 1. Say what is wrong and place it (binding: Look)

1. Write what is wrong in one sentence, on screen terms: what, where, which weather and hour,
   against what (the project's described look, a reference image, an earlier capture).
2. Read the project's look description for what is intended there; an intended look is not a bug.
3. Find the first layer to check in this table, and check the layers in its order. Stop at the
   first cause found.

| What looks wrong | Check first | Then | Last |
| --- | --- | --- | --- |
| The whole frame too dark or too bright; a grey card off its expected value | Exposure: its key and what it meters | Tone curve's mid grey | Never the albedos |
| One kind of surface too dark (the grass in sun) | Exposure, then the key against the ambient light | The material's model: does it lack light through the leaf? | Its values, only if outside the real range |
| The shade too dark or too bright against the sun | The ambient light: sky brightness, bounce, ambient grade | Occlusion strength; local tone, shade contrast | Not the albedos |
| A colour cast over everything | White balance; the key's and the sky's colour | The grade | Not the materials |
| One hue off across the whole frame (every green too yellow) | The light's colour; the grade's hue band for it | The class's values, together, within the real range | Never one material alone |
| The distance too clear, too milky or the wrong colour | The air: haze or fog density, height, colour | Exposure | Not the far materials |
| Highlights clip; the sky burns out | The exposure's highlight guard; the tone curve's shoulder | Bloom | Not the sky's own brightness alone |
| The frame flat or grey | Tone curve contrast; local tone | Ambient against key | Not the materials' contrast |
| The frame busy, noisy, hard to read | Content: fewer kinds, quieter textures | Grade contrast | Not a blur or a filter |
| The night a darker day | The night's treatment: night exposure, the rods' blue shift, night white | The night's light | Not the materials |
| Right at noon, wrong at one hour or weather | The knob keyed by that hour or weather | | Never the materials |
| One material wrong while all others are right in the same light | The material's model (light through it, fuzz, a wet film) | Its values against the real range | |

### 2. Content (binding: Look)

Choose and simplify what is in the picture, by eye, with the project's look description and any
reference images beside you. Decide for a class at once: which kinds of plant stand in a place,
how quiet a texture is, how far a class's colour is pushed within what the real thing could be.
Content is chosen, not fitted to a number.

### 3. Materials (binding: Materials)

1. Find the real values: the albedo (diffuse colour, linear), the roughness and, for leaves and
   thin things, how much light passes through. Take them from a scan of the real material, from a
   photograph in even daylight with a colour chart in frame (white-balanced and exposed on the
   chart's grey patches, read in linear values), or from a published measurement, credited.
2. Write the values and their source beside the material.
3. Check them against the range real examples of that kind cover, and against the neighbouring
   materials. A value outside the range is a mistake in the source or a departure (rule above);
   it is never left in silently.
4. Look at the material first under a neutral, known light: a scene whose light you know, with an
   18 % grey card, a grey ball, a chrome ball and a colour chart beside it, and an image with no
   style (neutral exposure, no grade). The grey card must land where the light says it does.
5. Then place it in the main view at the main weather and hour, then the other kept weathers and
   hours. Build it on the shared lighting model, so the same light reaches it as every other
   surface; the look's numbers come from the look's tables, never written into the material.

### 4. Light and air (binding: Light and air)

Set the light's knobs per weather and hour: the key against the ambient light, the sky's
brightness and colour, the ground's bounce, the occlusion's strength; then the air: haze and fog
density, height and colour. Each knob moves every material together. The knobs of this
renderer: [renderer-knobs.md](renderer-knobs.md), Light and Air.

### 5. Exposure, tone and grade (binding: Image)

Set the exposure (what it meters and where the key lands), then the tone mapping (curve, local
tone), then the grade (white balance, look-up tables, hue bands), then the night's treatment.
The knobs: [renderer-knobs.md](renderer-knobs.md), Image.

When the question becomes "what value should this light, air or image knob have" and you have
reference images, go to the skill `fitting-a-look-to-reference-images`. Material values never go
there.

### 6. Check downstream and judge the whole frame (binding: Check)

1. Capture the views the change touches before and after it, at the main weather and hour, then
   at the others the project keeps.
2. Judge the whole frame first: does it read as the described look? Then measure what moved with
   crops and region statistics, and report the measured differences.
3. Every layer downstream of the change was set on the old input: look at each again.

### 7. Record (binding: Record)

- A departure from plausible values: its class or material, the value, the real range, the reason
  and its measured effect, where the project keeps its art decisions.
- A measured look value worth keeping (a grey card's level, a light ratio): where the project
  keeps measured values.

## Scope

This skill covers surface values, the light and the image. It does not cover form, texture
detail or modelling.
