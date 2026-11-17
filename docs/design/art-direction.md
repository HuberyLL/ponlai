# Art direction

This page describes what the island looks like, why, and what to avoid. It holds what every subject
shares: the rendered image as a whole, its lighting, its exposure, its post-processing, and how the
look is judged. Each subject has its own page. Read these pages before you change the look, and
update them when an art decision changes. The measured values of the look are in
[Look values](../reference/look-values.md). Each module's header comment describes how the code
produces them.

- [The island](island.md): the land, the cliffs, the sea floor, the meadow, the bamboo, the
  yunpeng, the wind.
- [Sea and sky](sea-and-sky.md): the sea, its foam and its water, the sun, the atmosphere and fog,
  the clouds, the sky's colour through the day, the parked weathers.
- [Night](night.md): the moon, the moonlight, the stars.
- [Life and islanders](life-and-islanders.md): the creatures and the people.

Contents of this page:

- [The look](#the-look)
- [How the look is made](#how-the-look-is-made)
- [Three layers in one world](#three-layers-in-one-world)
- [Lighting](#lighting)
- [Shadows and fill light](#shadows-and-fill-light)
- [The exposure](#the-exposure)
- [Post-processing](#post-processing)
- [How the look is judged](#how-the-look-is-judged)

## The look

- The scene is a small island in an open sea, a visual sample for a game, with an eastern
  aesthetic inspired by Ghost of Tsushima. It is realistic with a touch of fantasy, with calm,
  painterly lighting, restrained colour, and wide fields of grass that move together in the wind.
- The fantasy lives in the world: the island, its bamboo, its yunpeng, its creatures from the old
  texts, and later the sea's glow at night. Post-processing adds only a light touch, so the whole
  scene keeps the airy feel of an immortals' island (Penglai). What the fantasy never includes is
  listed in [Life and islanders](life-and-islanders.md).
- On screen, you see deep clear water over a quiet sea floor with sparkling glare toward the sun,
  chunky chiselled stone, a lush meadow that runs to the cliff's lip, and bamboo groves across the
  island.
- The kept weathers are fine-day weathers: clear and fair. The others are parked
  ([Sea and sky](sea-and-sky.md#the-parked-weathers)).

## How the look is made

The rendered image is stylised realism: physically based and developed like a photograph, but not
aimed at photorealism. The method, its order and the reasons are in the skill
[building-cinematic-stylised-realism](../../skills/building-cinematic-stylised-realism/SKILL.md).
This project's facts for the skill are in its
[binding](../bindings/building-cinematic-stylised-realism.md). Within that method, this island
makes these decisions:

- Materials hold physically plausible values, and one physically based lighting model sets the
  relations between them. Grass, stone, bamboo and sand therefore read as one place without being
  tuned against each other. How to find and check a material's values is in the skill
  [building-cinematic-stylised-realism](../../skills/building-cinematic-stylised-realism/SKILL.md).
- A material is never tuned to make up for the lighting. Tuning it that way bakes the lighting's
  error into its albedo, and the material breaks again whenever the lighting changes.
- The style sits in three places: the content chosen, global departures in the lighting, and
  post-processing. The lighting departs from physical correctness only globally, by weather and
  time of day: the ambient balance, the sky's brightness and the haze. Post-processing is the
  exposure, the tone mapping and the colour grading. A change in any of these places changes every
  material together.
- The content is chosen: few kinds of plant in one place, quiet textures with little noise, and
  leaves that let light through. Which real things stand on the island is the art decision. Colour
  may be pushed, but only for the whole world at once and only within what the real things could
  be.
- A departure from physically plausible values is made for a whole class of things or for the
  whole world, or it is recorded on this page by name. One departure is on record: the cliff's
  stone is kept darker than real limestone ([The island](island.md#the-cliffs)).
- The island's values for the look's tables are in `packages/island/look/`. The measured values
  they produce are in [Look values](../reference/look-values.md).

Jasmin Patry described this approach: physically based materials, lit by lighting that departs
from physical correctness globally, by weather and time of day ("Samurai Shading in Ghost of
Tsushima", SIGGRAPH 2020; "Real-Time Samurai Cinema", SIGGRAPH 2021).

## Three layers in one world

- Nature (the cliffs, the sea, the plants, the creatures) is realistic.
- Things people make (huts, boats, baskets, lanterns) are semi-realistic and handmade: a little
  chunky and rounded in form, with real materials (wood grain, rope, fired clay). They bridge nature
  and the people.
- The people: [Life and islanders](life-and-islanders.md#the-islanders).
- All three share one lighting setup, one colour grade and one palette, so they read as one place.

## Lighting

- The lighting is photographic: the sun or the moon, the sky, and the sunlight that the ground
  bounces up. The sea receives that light as sea water does
  ([Sea and sky](sea-and-sky.md#the-water)).
- The lighting keeps the natural balance between the sun and the sky, by day and by night, so the
  land shows where the light comes from. A stone or a figure has a lit side and a shadowed side,
  and it casts its shadow on what lies beside it. The meadow shows the light in its slopes, in the
  light that passes through its blades, and in the sheen that a gust sweeps over it.
- Nothing brightens the shadows toward the lit areas except the graded bounce light described
  below. In particular, the island gets no extra share of sky light (a "clear shade"), no grade
  tone that softens the contrast and recolours the lit and shadowed areas, no extra recolouring of
  a low sun, and no film-style day for night.
- On a clear day, the higher the sun, the harder the contrast between the sunlit ground and the
  shadows.
- Sunlit ground lights what stands over it from below, with one bounce for every lit surface. The
  shallows faintly light the cliff walls. The meadow lights the islanders' undersides. The meadow
  also lights the grass in a wide shadow beside it with a flat, warm green light that does not
  follow the shadow's shape, so that grass stays green and turns only a little blue. This bounce
  light is raised above the physically correct value at every sun height the day reaches. It is
  raised most with the sun 9 to 20 degrees up, in the morning and the evening alike, and it returns
  to the physically correct value as the sun nears the horizon.
- Real phenomena are not exaggerated: there is no glow around every highlight, and no hue is turned
  by more than a few degrees (the colour grade turns no hue by more than 7 degrees).

## Shadows and fill light

- Shadowed areas are lit by the part of the sky that the island leaves visible. The ambient volume
  sees the land, its groves and its cliffs, so a grove's floor darkens, light reaches it from its
  open side, and a face turned away from the sky receives the ground's warm bounce light
  (`packages/render/lighting/AmbientSample.ts`).
- At noon on a clear or fair day, the open meadow's lit side is well above its shadowed side in
  brightness. Under a low sun the lit side comes down toward the shadowed side, and that is left as
  it is.
- Where a culm or a stone meets the ground, the contact darkens a little, and the darkening fades
  out within about a metre. It grounds the object and never reads as a dark ring.
- Where the grass, the culms and the ground's relief block the sky, shadowed areas lose some of
  their light broadly, over metres. Two effects cause this: the screen-space ambient occlusion
  (`packages/render/post/GTAO.ts`), and, at the turf's roots, the share of the sky that the blades
  leave visible. The ground among the grass in shadow and a grove's floor darken most, a culm's
  sides darken a little, and lit surfaces do not darken at all. The occlusion is a broad term, never
  a contact line, and it never affects the sun's direct light.
- The ambient light is set for shadowed areas with that loss already included, and it is never
  reduced a second time to account for it.
- The measured ratios of lit to shadowed areas are in
  [Look values](../reference/look-values.md#lighting-and-shadows).

## The exposure

- The frame's brightness comes from the exposure, which keeps the ratio between lit and shadowed
  areas. Material albedos are never pushed past real values to brighten the frame.
- The exposure is metered from the light falling on what the frame shows (illuminance), not the
  light leaving it (luminance), so a dark meadow or sea is not brightened toward grey.
- By day the sky counts in the meter, most of all under a high sun, as a region of the frame does in
  a camera's weighted metering, so the sky counts equally in every view. The frame's brightest few
  percent hold the exposure down: the bright band around a low sun makes a view toward the sun
  darker than a view away from it.
- The frame darkens as the light falls. As the sun goes down, the display value of a sunlit grey
  card on level ground goes down with it, more as the sun gets lower, so a low sun reads as a low
  sun. In the golden hour, with the sun at 3 degrees, a sunlit cliff is orange with a deep brown
  shadowed side, and the sky over it is a shade redder and dimmer. Avoid a yellow-gold face under a
  pale sky.
- The night has its own exposure: [Night](night.md#lighting).
- A clouded sky is metered from the sky itself, with its own exposure keyframes
  ([Sea and sky](sea-and-sky.md#lighting-under-cloud)).
- A sun in the frame may read a little brighter than an eye-adapting exposure would show it.
- The grey card's display values by day and by night are in
  [Look values](../reference/look-values.md#exposure).

## Post-processing

Post-processing develops the frame in stages, in this order:

- **Local tone mapping** keeps a bright sea, glare or sky from clipping and turning grey while the
  land keeps its level. By day it compresses only what lies well above the sunlit ground toward the
  ground's level. Under a low sun it also brightens the land, more where the surroundings are
  darker. Local detail is kept.
- **Shadow contrast** is deepened below a pivot, so shadows stay solid under the soft tone curve.
  Without it, the curve would lift shadows along with everything else and take away their weight.
  By day the pivot sits above the sunlit ground. Under a low sun it sits nearly a stop below mid
  grey, where the long shadows are affected most. Under clouds the effect is gentle. By night it
  lifts instead: its pivot sits below the moonlit grass, and the moon's narrow shadows are drawn
  toward the lit ground.
- **A soft filmic tone curve** is gentle in the shadows and midtones, with a long shoulder and a
  long toe. Deep in the dark, the toe halves the display value every two stops, which keeps
  gradations in the shadows, and it still reaches black, with no floor that veils the darks. Its
  contrast, shoulder, white point and toe are adjustable. It adds no saturation of its own; the
  colour grade's hue bands set saturation. The curve's working colour space keeps a low sun's reds
  from turning yellow.
- **A white balance** is given as the colour that white becomes, and it changes with the time of
  day and the weather. A clear day is cool from noon down to a low sun, against the sun's warmth, so
  sunlit rock reads as a pale neutral, the meadow keeps its green, and the sky and the sea stay
  blue. Shadowed areas keep the colour of the surfaces in them and never turn blue. The golden hour
  is a little warm; the clouded skies and the night are cool.
- **Bloom** applies only to what is truly bright: the sun's glints on the sea, the sun, a moonlit
  path on the water. It models the lens's scatter, which does not change with the sky, so under a
  clouded sky almost nothing glows. Bloom never veils the whole frame.
- **A vignette** darkens only the corners, with no visible edge. There is no film grain.
- **Two colour grading lookup tables** are generated from a grade's parameters, and a look can
  blend between them by time of day or place. The first table holds the day's grade. It applies no
  contrast or saturation change to the whole frame and moves each hue lightly on its own. The warm
  hues are a little richer, so they keep their colour under the soft tone curve. The sky's blue is a
  little richer, so the noon sky does not read pale and grey. The green is a touch quieter and
  turned a little toward yellow, against the cool white balance. The sea's blue-green is a little
  bluer. A red band is kept against the cool white balance, and the highlights are a touch cool.
  The second table is the identity.

The local tone mapping, the tone curve's working colour space, the white balance and the colour
grading lookup tables are techniques that Patry presented (SIGGRAPH 2021). The tone curve's toe,
the shadow contrast, the vignette, the bloom and the blend of two tables are this project's own.

There are no lens effects that a photograph of a real place would not have: no tilt-shift miniature
blur, and no lens flares forced into the frame.

## How the look is judged

- The look is judged from the island view (the island camera zoomed out over the island) as well as
  close up. At that distance the lighting reads through its direction and its large-scale light and
  shadow: lit and shadowed slopes and cliffs, a glint or a moon path on the sea, and later warm
  lights and the things that stand on the island. Fine detail and post-processing effects vanish at
  that distance.
- The island view's default direction is fixed and looks a little east of the noon meridian, where
  the sun culminates and the moon stands. The full moon's path is in the frame through the evening
  and at midnight. By day the sun lights the cliffs from the side, giving a lit and a shadowed side,
  without filling the frame with glare. A view from behind the sun lights the island flat and never
  shows the moon's path. The view never follows the clock, so returning to it never jumps.
- The look is judged first on the clear day at noon, then at the other hours and in the other kept
  weathers.
