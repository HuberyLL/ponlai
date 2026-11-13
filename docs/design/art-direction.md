# Art direction

What the island looks like and why, and what to avoid. This page holds what every subject shares:
the picture as a whole, its light, its exposure and its image, and how the look is judged. Each
subject has its own page. Read these pages before a change to the look; change them when an art
decision changes. The measured readings of the look are in
[Look values](../reference/look-values.md); each module's header comment holds how the code gets
there.

- [The island](island.md): the land, the cliffs, the sea floor, the meadow, the bamboo, the
  yunpeng, the wind.
- [Sea and sky](sea-and-sky.md): the sea, its foam and its water, the sun, the air, the clouds, the
  sky's colour through the day, the parked weathers.
- [Night](night.md): the moon, its light, the stars.
- [Life and islanders](life-and-islanders.md): the creatures and the people.

Contents of this page:

- [The look](#the-look)
- [How the look is made](#how-the-look-is-made)
- [Three layers in one world](#three-layers-in-one-world)
- [The light](#the-light)
- [The shade](#the-shade)
- [The exposure](#the-exposure)
- [The image](#the-image)
- [How the look is judged](#how-the-look-is-judged)

## The look

- A small island in an open sea, a visual sample for a game,
  inspired by the eastern aesthetic of Ghost of Tsushima: realistic with a touch of fantasy, a
  calm, painterly light, restrained colour, and wide fields of grass that move together in the
  wind.
- The fantasy lives in the world: the island, its bamboo, its yunpeng and its creatures from the
  old texts, later the sea's glow at night. The image itself takes only a light touch,
  so the whole keeps the airy feel of an immortals' island (Penglai). What the fantasy never
  includes is listed under [Life and islanders](life-and-islanders.md).
- On screen: deep clear water over a quiet floor with a sparkling glare toward the sun, chunky
  chiselled stone, a lush meadow running to the cliff's lip, and bamboo groves over the island.
- The weathers kept are a fine day's: clear and fair. The others are parked
  ([Sea and sky](sea-and-sky.md#the-parked-weathers)).

## How the look is made

The picture is stylised realism: physically based and developed like a photograph, but not aimed
at photorealism. The method, its order and the reasons are in the skill
[building-aaa-stylised-realism](../../skills/building-aaa-stylised-realism/SKILL.md), and this
project's facts for it in its [binding](../bindings/building-aaa-stylised-realism.md). What this
island decides within it:

- The materials hold physically plausible values, and one physically based light sets the
  relations between them, so grass, stone, bamboo and sand read as one place without being tuned
  against each other. How a material's values are found and checked:
  [Add a material](../how-to/add-material.md).
- A material is never tuned to make up for the light. Tuning it so bakes the light's error into
  its albedo, and it breaks again whenever the light changes.
- The style sits in three places: the content chosen, the light's global departures, and the
  image. The light leaves physical correctness only globally, by weather and time of day (the
  ambient balance, the sky's brightness, the haze); the image is the exposure, the tone mapping and
  the grade. A change there moves every material together.
- The content is chosen: few kinds of plant in one place, quiet textures with little noise, and
  leaves that let the light through. Which real things stand on the island is the art decision.
  Colour may be pushed, but for the whole world at once and within what the real things could be.
- A departure from physically plausible values is made for a whole class or the whole world, or
  is recorded here by name. The one on record: the cliff's stone is kept darker than real
  limestone ([The island](island.md#the-cliffs)).
- The island's numbers for the look's tables are in `packages/island/look/`; the measured readings
  they give are in [Look values](../reference/look-values.md).

Physically based materials, lit by a light that leaves physical correctness globally, by weather
and time of day, is the approach Jasmin Patry described ("Samurai Shading in Ghost of Tsushima",
SIGGRAPH 2020; "Real-Time Samurai Cinema", SIGGRAPH 2021).

## Three layers in one world

- Nature (the cliffs, the sea, the plants, the creatures) is realistic.
- Things people make (huts, boats, baskets, lanterns) are semi-realistic and handmade: a little
  chunky and rounded in form, with real materials (wood grain, rope, fired clay). They bridge
  nature and the people.
- The people: [Life and islanders](life-and-islanders.md#the-islanders).
- All three share one lighting, one grade and one palette, so they read as one place (as in Alba,
  Sky and Tchia).

## The light

- The light is photographic: the sun or the moon, the sky, and the sunlight the ground bounces up.
  The sea takes that light as sea water does ([Sea and sky](sea-and-sky.md#the-water)).
- The light keeps the sun's and the sky's own balance, by day and by night, so the land shows where
  the light comes from. A stone or a figure has a lit side and a shaded one, and its shade falls on
  what lies beside it. The meadow shows the light in its slopes, in the light through its blades and
  in the sheen a gust sweeps over it.
- Nothing lifts the shade toward the light: no extra share of sky light on the island (a "clear
  shade"), no grade tone that softens the contrast and recolours the lights and the shade, no low
  sun's recolouring, and no film's day for night. Together with the meadow's own soft light, they
  leave a shaded clump within a quarter of a lit one's brightness, and the meadow reads as lit by an
  overcast sky.
- On a clear day the higher the sun, the harder the contrast between the lit ground and the shade.
- The sunlit ground lights what stands over it from below, one bounce for every lit surface: the
  shallows light the cliff's walls faintly, the meadow the islanders' undersides. It is strongest
  around midday.
- Real phenomena are not exaggerated: no glow round every highlight, and no hue turned further than
  a few degrees (the grade turns none more than 7 degrees).

## The shade

- The shade is lit by the sky the island lets through: the ambient volume, which sees the land, its
  groves and its cliffs, so a grove's floor darkens, light reaches it from its open side, and a face
  turned from the sky takes the ground's warm bounce (`packages/render/lighting/AmbientSample.ts`).
- At noon on a clear or fair day the open meadow's lit side stands well over its shade. A low sun's
  lit side comes down toward its shade, and that is left as it is.
- Where a culm or a stone meets the ground the contact darkens a little and is gone within about a
  metre: a grounding, never a dark ring.
- Where the grass, the culms and the ground's relief close the sky, the shade loses some of its
  light broadly, over metres: the screen-space ambient occlusion (`packages/render/post/GTAO.ts`),
  and at the turf's roots the share of the sky its blades leave. The ground among the grass in shade
  and a grove's floor darken most, a culm's sides a little, lit surfaces not at all. The occlusion
  is a broad term, never a contact line, and it never touches the sun's direct light.
- The ambient light is set for the shade with that loss in it, and is never pressed down once more
  for it.
- The measured ratios of light and shade: [Look values](../reference/look-values.md#light-and-shade).

## The exposure

- The frame's brightness comes from the exposure, which keeps the ratio between light and shade.
  The materials' albedos are never pushed past real ones to brighten it.
- The exposure is metered from the light falling on what the frame shows, not the light leaving
  it, so a dark meadow or sea is not brightened toward grey.
- By day the sky weighs into the meter, most of all under a high sun, as a region of the frame does
  in a camera's weighted metering, so the sky weighs the same in every view. The frame's brightest
  few percent hold it down: the bright band about a low sun darkens a view toward it against one
  away from it.
- The frame darkens with the light. As the sun goes down, a sunlit grey card on level ground goes
  down with it, the more the lower the sun, so a low sun reads as a low sun. In the golden hour,
  with the sun at 3 degrees, a sunlit cliff is orange with a deep brown shade, and the sky over it a
  shade redder and dimmer. Avoid a yellow-gold face under a pale sky.
- The night has an exposure of its own: [Night](night.md#the-light).
- A clouded sky is metered by the sky itself, with a key of its own
  ([Sea and sky](sea-and-sky.md#the-light-under-cloud)).
- A sun in the frame may read a little brighter than its eye-adapting exposure would show it.
- The grey card's levels by day and by night: [Look values](../reference/look-values.md#exposure).

## The image

The frame is developed in stages, in this order:

- **Local tone mapping** keeps a bright sea, glare or sky from burning out and greying while the
  land keeps its level. By day only what lies well over the lit ground is drawn toward it; under a
  low sun the land is drawn up as well, the more the darker its surroundings. The detail is kept.
- **The shade's contrast** is deepened under a pivot, so the shade stays solid under the soft curve,
  which would otherwise lift it with everything else and take its weight. By day the pivot sits over
  the lit ground. Under a low sun it sits a quarter of a stop under mid grey, where the long shadows
  take the most. Under clouds and by night it acts gently.
- **A soft filmic curve**, gentle in the shadows and midtones, with a long shoulder and a long toe.
  Deep in the dark the toe halves the screen's level every two stops, keeping the shade's
  gradations, and it still reaches black, with no floor veiling the darks. Its contrast, shoulder,
  white and toe are adjustable. It has no saturation of its own: the grade's hue bands set that. Its
  working space keeps a low sun's reds from turning yellow.
- **A white balance**, given as the colour white becomes, by the time and the weather. A clear day
  is cool from noon to a low sun, against the sun's warmth, so sunlit rock reads a pale neutral, the
  meadow keeps its green, and the sky and the sea stay blue. The shade stays the colour of what
  stands in it, never blue. The golden hour is a little warm; the clouded skies and the night are
  cool.
- **A bloom** only on what is truly bright: the sun's glints on the sea, the sun, a moonlit path.
  It stands for the lens's scatter, which does not change with the sky, so under a clouded sky
  next to nothing glows. Never a veil over the whole frame.
- **A vignette** that darkens only the corners, with no visible edge. No grain.
- **Two grade tables**, generated from a grade's parameters, that a look can blend between by time
  of day or place. The first holds the day's grade: no contrast or saturation over the whole frame,
  each hue moved lightly on its own. The warm hues are a little richer, so they keep their colour
  under the soft curve; the sky's blue is a little richer, so the noon sky does not read pale and
  grey; the green is a touch quieter and turned a little toward yellow against the cool white
  balance; the sea's blue-green is a little bluer; a red band is kept against the cool white; and
  the highlights are a touch cool. The second table is the identity.

The local tone mapping, the curve's working space, the white balance and the grade tables are
techniques Patry presented (SIGGRAPH 2021). The curve's toe, the shade's contrast, the vignette,
the bloom and the blend of two tables are ours.

No lens effects that a photograph of a real place would not have: no tilt-shift miniature blur, no
lens flares forced into the frame.

## How the look is judged

- The look is judged from the island view, the island camera zoomed out over the island, as well
  as close up. Light reads there through its direction and its large-scale light and shade: lit and
  shaded slopes and cliffs, a glint or a moon path on the sea, later warm lights and what stands on
  the island. Fine detail and post effects vanish at that distance.
- The island view's default direction is fixed and looks a little east of the noon meridian, where
  the sun culminates and the moon stands. The full moon's path is in the frame through the evening
  and at midnight, and by day the sun lights the cliffs from the side, a lit and a shaded side,
  without filling the frame with glare. A view from behind the sun lights the island flat and never
  shows the moon's path. The view never follows the clock, so returning to it never jumps.
- The look is judged first on the clear day at noon, then at the other hours and the kept weathers.
