# Sea and sky

This page describes what the sea, the sun, the atmosphere, the clouds and the sky look like, why,
and what to avoid. What every subject shares (the lighting, the exposure, post-processing) is in
[Art direction](art-direction.md). The measured values are in
[Look values](../reference/look-values.md). The moon and the stars are in [Night](night.md).

Contents:

- [The weathers](#the-weathers)
- [The sea](#the-sea)
- [The foam at the rock](#the-foam-at-the-rock)
- [The water](#the-water)
- [The sun](#the-sun)
- [Atmosphere and fog](#atmosphere-and-fog)
- [The clouds](#the-clouds)
- [Cirrus](#cirrus)
- [Lighting under cloud](#lighting-under-cloud)
- [The sky's colour through the day](#the-skys-colour-through-the-day)
- [The parked weathers](#the-parked-weathers)

## The weathers

- The weather is fine-day weather: clear and fair.
- Cloudy and overcast are parked until their clouds are developed further. Rain, storm and fog are
  parked until the game needs them as pressure on the player. Parked weathers are out of the
  weather rotation and do not load on the production page (`PARKED_WEATHER` in
  `packages/render/sky/Weather.ts`). Their design is kept in
  [The parked weathers](#the-parked-weathers) for when they come back.

## The sea

- The sea is calm in everyday weather, with no whitecaps on the open water. Only a storm's gale
  builds a rough sea with whitecaps, trailing foam and spray.
- The sea continues to the horizon.

## The foam at the rock

- The island stands in the waves' path. Its foam follows the waves you see arrive. Where a wave
  runs high against the rock, the foot of the rock turns white as the wave strikes, and the foam
  spreads out and thins to lace as it drains. Where a wave runs low, the rock stays bare.
- A wave's foam outlasts the wave by several seconds, so the foot of the rock always carries some
  foam. Each new wave brightens it and pushes it out rather than starting it again. The foam
  thickens during a set of bigger waves and thins during a lull.
- On some stretches the backwash carries the foam out in tongues; on others it leaves the foam
  close against the rock. The foam breaks into patches as it ages. Avoid a ring of foam at one fixed
  distance from the rock.
- The foam fades out where the coast turns away from the swell, and it is absent where the waves
  slide along the rock.
- On an everyday sea the foam is a narrow band, a few decimetres to a metre or two wide. Avoid
  water thrown up the rock, foam that jumps or flashes, rocks that stay white while their neighbours
  stay bare, and wide fields of foam, which belong to a surf day.
- The lee side lies in the island's wave shadow. It is nearly smooth and has no foam.

## The water

- The water is sea water with measured optical properties: clear open-ocean water with a little
  phytoplankton. It absorbs the red within a few metres and the green and the blue over tens of
  metres. The amount of phytoplankton is in [Look values](../reference/look-values.md#water).
- The water's colour follows from those optical properties and the light on it; no colour of its
  own is added. The open, deep water is a deep blue: the light that the water body scatters back,
  under the reflection of the sky. Over the shallows the sea floor shows through. Its sand,
  seagrass and stone are dimmed and turned bluer by the water above them, more the deeper they lie.
  There is no bright rim around the island.
- At sunset the reflection takes on the low sky's colour.
- A calm lee is level with the sea around it.
- The water stays clear to the floor in everyday weather. The stones and the seagrass's edges show
  through the water down to several metres. The water wobbles them but never breaks them into
  fragments. The calm water carries no film of foam.
- The water softens the floor as real water does. The sand's ripples stay sharp near the shore.
  Finer detail goes soft from a few metres along the view ray, and past about ten metres only the
  floor's large shapes remain (rock against sand, the seagrass's patches). Avoid the look of glass
  over a sharp floor at any depth.
- Under cloud the sea reflects the cloud deck's grey, and the water body dims with the deck's
  light: the water body receives the sky's light as the surface reflects it. Where a gap in the
  cloud lets the sun through, its glint on the waves lies on the sea as a silver sheen. This is the
  same reflection of the sun as on a clear day, spread by the slopes of the waves.

## The sun

- There is one dominant key light: the sun by day, the moon by night ([Night](night.md)).
- The sun follows the path of a mid-latitude equinox: 52 degrees up at noon, rising due east at 6
  and setting due west at 18. That is high enough at noon to read as a bright day, and low enough
  that slopes keep a lit and a shadowed side in the island view. Near the horizon the sun moves
  slowly (11.8 degrees an hour), so the low-sun lighting lasts. Avoid a higher noon sun: it gives
  subtropical light, at odds with the island's temperate bamboo and meadow
  (`packages/render/sky/DayCycle.ts` `NOON_ELEVATION`).
- The day cycle is authored, not astronomical.
- By day the sun is near white. Its light warms from about 20 degrees up, turns orange by 10
  degrees and orange red near the horizon.
- The sun's disk is drawn larger than life, with a radius of 1.1 degrees, about four times the true
  radius: a disk of true size reads as a point at the island camera's field of view. The disk is
  softly limb-darkened, with a clean edge.
- Around the disk lies a soft glow, sized by the frame rather than the field of view. It is near
  white at its core and falls off as the square of the distance beyond half the frame. There are no
  streaks, ghosts or rings. The glow weakens with the share of the disk left uncovered, yet stays
  wide through a gap in leaves. It goes with the disk when the sun leaves the frame, and it is
  weaker against the bright sky around a low sun.

## Atmosphere and fog

- The atmosphere always carries a visible haze. The haze is part of this world, and you see the
  island through it.
- By day the haze makes the horizon read milky white, brightest toward the sun. Avoid a cyan band
  at the horizon.
- The haze's shape is physical. Its density varies with height alone: a thin ground layer lies on
  the sea, much denser near the water than clean sea air, and the air is clean above that layer.
  The haze depends on neither the camera nor the island. So the island seen from above is clear,
  while the far sea and the horizon, whose lines of sight run long and low through the layer, are
  hazy.
- Where the haze is thick, the player moves the camera in closer to see.

## The clouds

- Every sky's clouds are one kind of cloud, heaped or flat depending on the weather, and they sit
  at the heights where such clouds form:
  - the clear and fair skies' cumulus, from about 4 km up;
  - cloudy's broken layer of flatter heaps, from about 1.5 km to 4.5 km, with blue sky between
    them;
  - overcast's closed cloud deck, low, with its base under a kilometre and its tops near 3 km. Its
    masses are near and wide overhead and close into a flat, packed floor toward the horizon, seen
    through little haze.
- A change of weather changes the whole sky together. The cover grows or thins everywhere at once,
  the clouds flatten or heap, and their layer sinks or rises with them. Avoid one sky sweeping over
  another along a line.
- The clouds drift downwind with the wind aloft, faster than the surface wind (the cumulus and the
  cirrus at about twice its speed), so they never move against the grass and the sea.
- The clear and fair skies' cumulus are lit below their tops by the light that the cloud above
  passes down. A shadowed cloud base reads as a soft grey, a little darker than the sunlit tops and
  close to the blue sky beside it. Avoid a dark block. The measured value is in
  [Look values](../reference/look-values.md#lighting-and-shadows).
- A cloud deck's base is lit by the light that comes down through it: the light on its tops,
  transmitted through the cloud above, with no gain or tint of its own. Thin parts show lighter than
  the thick masses beside them, and the deck reads near grey. The air under the deck is lit by the
  deck and by the sea's reflection of it rather than by a clear sky, so the haze in front of the
  clouds takes their grey.

## Cirrus

- Clear and fair skies hold a thin layer of cirrus about 8.5 km up. Its silky fibres are combed
  along the wind aloft and gathered in patches with blue sky between them, and they close up toward
  the horizon in perspective. Cloudy and overcast skies have no cirrus.
- The fibres bend and hook, run thick and thin along their length and fray at their ends. They lie
  at two scales, turned against each other. Avoid ruled lines and strokes of even width; no two
  fibres run quite parallel.
- The patches stay apart. Toward the horizon the cirrus thins as its fibres blur together, so even
  toward a low sun the sky a few degrees above the horizon stays clear. Avoid a bright sheet around
  the sun.
- Under a high sun the cirrus is faint and white, a little lighter than the sky around it, and never
  the first thing you notice. The cumulus is drawn over it. The measured value is in
  [Look values](../reference/look-values.md#lighting-and-shadows).
- Under a low sun, in the morning and the evening alike, the light the cirrus receives directly from
  the sun is warm, and the light it receives from the sky around it is cool. So it reads rose on both
  sides of the sky, toward the sun and away from it, a little more saturated and a little lighter
  than the sky beside it. Avoid a pale yellow-white. It turns back to white as the sun climbs past
  about 30 degrees.
- Each part of the cirrus is lit by the sun as seen from that part. So after sunset and before
  sunrise, the side away from the sun goes dark first, with the sun about 1.5 degrees below the
  horizon, and the side toward the sun goes dark last, near 3 degrees below, warmest just before it
  goes dark.

## Lighting under cloud

- A clouded sky is metered from the sky itself, with its own exposure keyframes. The land under a
  cloud deck is lit by that deck, so the sky keeps the same brightness relative to the meadow at
  every sun height, and the land follows the sky as it darkens into the evening. Avoid a step in
  brightness where a gap, or a sun dropping through a cloud's edge, would change the meter's
  reading.
- Under cloud the land keeps some directional light along the sun's direction, with the shadows it
  casts, by one rule under every sky: a cloud passes down part of the sunlight it receives, and the
  land under it keeps a share of that as a soft key light. So a cloud's shadow, a cloudy day and an
  overcast day all show the shadows of the bamboo, the cliffs and the islanders, and the lit side of
  every form, softer and shallower the thicker the cloud. Land lit by the sky alone reads flat,
  without depth; only real rain may lose the key light.
- Under a cloud deck the land is lit by that softened key light and by the deck's sky light.
- With the sun high, the deck passes on little of a clear sky's blue, so the light it lends the
  land is a warm grey.

## The sky's colour through the day

- The sky's light takes its own gain by the sun's height, with separate values for the rising and
  the setting sun. Where that gain colours the sky, it decides the colour. Beyond it, avoid a
  painted pink, magenta or deep-blue twilight, which dyes the sea one flat colour and reads as a
  filter. Twilight's mood comes from the light on the island.
- Through sunset the lighting runs from the golden hour's warm keyframe into a dusk keyframe, more
  orange still, at a sun 1 degree below the horizon, then moves on to the night keyframe by 6
  degrees below. The glow stays low in the west after the sun has set and is the brightest thing in
  the rendered image.
- After sunset the island stays readable. In the minutes between the sun's last light and the
  moon's, the meadow darkens with the light: warm under the afterglow, then green. It settles into
  the night without a dip or a lift in brightness. It is never brighter at a lower sun, and the
  night's light comes in only as fast as the twilight's light fades, so the night is the twilight's
  end.
- The light that keeps the island readable is the sky's own, raised for the island alone, and only
  the evening's is warm. At dawn the land goes from the night's blue into the day with no warm
  period.
- Through the twilight the land darkens a little and hands over to the moonlit night. The open sea
  is darker than the land until the night lighting lifts it.
- The morning is not the evening reversed. Its key light is near grey and its white balance cold,
  so the sky, the water and the shadowed rock are blue together at sunrise, and only a face turned
  to the sun takes on a warm colour, a pale one.
- On a clear morning the night ends early: with the sun still 7 degrees below the horizon, the sky
  is already blue over one thin pink band, and the sea is a clear blue under it.

## The parked weathers

The kept weathers need none of this section. It is kept for when the parked weathers come back.

- Bad weather dims and desaturates the existing lighting and thickens the haze as visibility falls,
  and it stays dimmer and greyer than a clear day. It never adds a grey veil over the screen.
- A cloudy sky's deck light gives way as the sun falls below about 6 degrees. By 3 degrees
  the low sun shines under the broken deck, and the view's own light sets the exposure. So a cloudy
  evening comes on gradually: dark at sunset, neither black nor lit yellow, and the meadow is never
  brighter at a lower sun except where the cloud opens for a moment.
- Under overcast the land is lit by the softened key light and by the deck's own sky light, which
  is stronger than the sea's. The closed deck reads lighter than the meadow under it, and lighter
  still toward the sun, where the lit cloud around the sun's position glows broad and soft. Its
  brightness changes more gently from the zenith to the horizon than the standard overcast sky's
  3 : 1. The land takes its light from the sun's side of the deck as the deck shows it. The sky's
  lightness stays steady as a low sun climbs
  ([Look values](../reference/look-values.md#lighting-and-shadows)).
- Overcast is a closed, dark deck at every sun height, in the morning and the evening alike. It
  does not break up under a low sun, and its light fades only with the sun's own light, over the
  twilight. The land under it keeps the deck's soft light through sunset, with no flash of the
  setting sun's beam on the slopes facing it, and darkens into the night as the deck's light does.
- An overcast sky is brightest around the sun's position and dim away from it: a near-neutral pale
  grey near the sun, a dark blue-green grey away from it. The meadow under it is a quieter green,
  and its most brightly lit grass is muted toward grey.
- The land under overcast is softly lit: the deck's sky light comes from every side, including its
  glow around the sun's position, and is well above a cloudy day's. Under the water the floor
  receives that light as the water column passes it down, so the shallows' floor is lit by the same
  deck, dimmed by the water above it the deeper it lies.
- The sun reaches overcast land only through the deck, as the soft key light that every cloud
  leaves the land. It is a little stronger where a thinner region of the deck lies along the sun's
  direction, in large patches that move with the deck. It casts the soft shadows of everything
  taller than the meadow. The meadow does not shadow itself in this light, so the sward's own
  shadow is the one the sky light finds under its canopy, while the bamboo, the stones and the bare
  ground keep their contact shadows.
- Rain is light streaks and ripples on the water. Wetness darkens rock and plants within small
  limits and makes bare stone glossy. Water runs down the cliffs in sparse, darker runnels, and
  puddles fill fixed hollows and read as water from above.
