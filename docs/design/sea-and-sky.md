# Sea and sky

What the sea, the sun, the air, the clouds and the sky look like and why, and what to avoid. What
every subject shares (the light, the exposure, the image) is in [Art direction](art-direction.md);
the measured readings are in [Look values](../reference/look-values.md). The moon and the stars:
[Night](night.md).

Contents:

- [The weathers](#the-weathers)
- [The sea](#the-sea)
- [The foam at the rock](#the-foam-at-the-rock)
- [The water](#the-water)
- [The sun](#the-sun)
- [The air](#the-air)
- [The clouds](#the-clouds)
- [The thin layer](#the-thin-layer)
- [The light under cloud](#the-light-under-cloud)
- [The sky's colour through the day](#the-skys-colour-through-the-day)
- [The parked weathers](#the-parked-weathers)

## The weathers

- The weather is a fine day's: clear and fair.
- Cloudy and overcast are parked until their clouds are developed further; rain, storm and fog are
  parked until the game needs them as pressure. Parked weathers are out of the rotation and
  the production page (`PARKED_WEATHER` in `packages/render/sky/Weather.ts`). Their design stands
  under [The parked weathers](#the-parked-weathers) for their revival.

## The sea

- The sea is calm in everyday weather: no whitecaps on the open water. Only a storm's gale builds a
  rough sea with whitecaps, trailing foam and spray.
- The sea continues to the horizon.

## The foam at the rock

- The island stands in the sea's way. Its foam follows the waves the eye sees arrive: where a wave
  runs high against the rock the foot turns white as it strikes, and the foam spreads out and thins
  to lace as it drains. Where a wave runs low the rock stays bare.
- A wave's foam outlasts it by several seconds, so the foot always carries some, which each new wave
  brightens and pushes out rather than starting again. The foam thickens in a set of bigger waves
  and thins in a lull.
- The backwash carries the foam out in tongues on some stretches and leaves it hugging the rock on
  others, and it breaks into patches as it ages. Avoid a ring at one distance from the rock.
- The foam falls off as the coast turns from the swell, and is absent where the waves slide along
  the rock.
- On an everyday sea it is a narrow band, a few decimetres to a metre or two wide. Avoid water
  thrown up the rock, foam that jumps or flashes, rocks that stay white while their neighbours stay
  bare, and wide fields of foam, which belong to a surf day.
- The lee lies in the island's wave shadow, nearly smooth, without foam.

## The water

- The water is sea water with measured optics: clear open-ocean water with a little phytoplankton,
  which takes the red out within a few metres and the green and the blue over tens. The amount:
  [Look values](../reference/look-values.md#water).
- Its colour follows from those optics and the light on it, with no colour of its own laid on. The
  open, deep water is a deep blue: the light its body scatters back, under the reflection of the
  sky. Over the shallows the floor shows through, its sand, seagrass and stone dimmed and turned
  bluer by the water over it, the more the deeper it lies. No bright rim round the island.
- At sunset the reflection takes the low sky's colour.
- A calm lee stands level with the sea round it.
- The water stays clear to the floor in everyday weather. The stones and the seagrass's edges show
  through the water down to several metres; the water wobbles them but never breaks them into
  crumbs. The calm water carries no film of foam.
- The water softens the floor as real water does: the sand's ripples hold near the shore, finer
  detail goes soft from a few metres down the slant of the view, and past some ten metres only the
  floor's large shapes remain (rock against sand, the seagrass's patches). Avoid glass over a sharp
  floor at any depth.
- Under cloud the sea reflects the deck's grey, and its body dims with the deck's light: the water's
  body takes the sky's light as the surface reflects it. Where a gap in the cloud lets the sun
  through, its glint on the waves lies on the sea as a silver sheen: the same reflection of the sun
  as on a clear day, spread by the waves' slopes.

## The sun

- One dominant key light: the sun by day, the moon by night ([Night](night.md)).
- The sun keeps a mid-latitude equinox's path: 52 degrees up at noon, rising due east at 6 and
  setting due west at 18. That is high enough at noon to read as a bright day, and low enough that
  slopes keep a lit and a shaded side in the island view. Near the horizon it moves slowly
  (11.8 degrees an hour), so the low sun's light lasts. Avoid a higher noon: it is a subtropical
  light, at odds with the island's temperate bamboo and meadow
  (`packages/render/sky/DayCycle.ts` `NOON_ELEVATION`).
- The day cycle is authored, not astronomical.
- By day the sun is near white. Its light warms from about 20 degrees up, turns orange by 10 and
  orange red near the horizon.
- The sun's disk is drawn larger than life, a radius of 1.1 degrees, about four times the true
  one: a true-size disk reads as a point at the island camera's field of view. It is softly
  limb-darkened, its edge clean.
- Round it lies a soft glow sized by the frame, not the field of view: near white at its core and
  fading as the square of the distance past half the frame. No streaks, ghosts or rings. The glow
  weakens with the share of the disk left uncovered, yet stays wide through a gap in leaves. It goes
  with the disk when the sun leaves the frame, and it is weaker against the bright sky round a low
  sun.

## The air

- The air always carries a visible haze: it is part of this world, the island seen through it.
- By day the air is hazy, so the horizon reads milky white, brightest toward the sun. Avoid a cyan
  band at the horizon.
- The haze's shape is physical: its density varies with height alone, a thin ground layer lying on
  the sea, much denser than a clean sea air near the water, and clean above the layer. It answers to
  neither the camera nor the island. So the island seen from above is clear, while the far sea and
  the horizon, whose lines of sight run long and low through the layer, are hazed.
- Where the haze is thick, the player draws in closer to see.

## The clouds

- Every sky's clouds are one kind of cloud, heaped or flat by the weather, and they stand where such
  clouds stand:
  - the clear and fair skies' cumulus from about 4 km up;
  - cloudy's broken layer of flatter heaps from about 1.5 km to 4.5 km, with blue between them;
  - overcast's closed deck low, its base under a kilometre and its tops near 3 km, so its masses are
    near and wide overhead and close into a flat, packed floor toward the horizon, seen through
    little of the air's haze.
- A change of weather moves the whole sky together: the cover grows or thins everywhere at once, the
  clouds flatten or heap, and their layer sinks or rises with it. Avoid one sky swept over another
  along a line.
- The clouds drift downwind with the wind aloft, faster than the surface wind (the cumulus and the
  thin layer about twice it), so they never move against the grass and the sea.
- The clear and fair skies' cumulus are lit under their tops by what the cloud above passes down: a
  shaded base reads a soft grey, a little under the sunlit tops and near the blue sky beside it.
  Avoid a dark block. The reading: [Look values](../reference/look-values.md#light-and-shade).
- A deck's base is lit by what comes down through it, the light on its tops passed through the
  cloud above, with no gain or tint of its own: thin parts show lighter than the thick masses beside
  them, and the deck reads near grey. The air under it is lit by the deck and by the sea's
  reflection of it rather than by a clear sky, so the haze in front of the clouds is their grey.

## The thin layer

- Clear and fair skies hold a thin layer of silky fibres about 8.5 km up, combed along the wind
  aloft and gathered in patches with blue sky between them, closing up toward the horizon in
  perspective. Cloudy and overcast skies have none.
- The fibres bend and hook, run thick and thin along their length and fray at their ends, and lie at
  two scales turned against each other. Avoid ruled lines and strokes of even width; no two fibres
  run quite parallel.
- The patches stay apart. Toward the horizon the layer thins as its fibres blur together, so even
  toward a low sun the sky a few degrees over the horizon stays clear. Avoid a bright sheet round
  the sun.
- Under a high sun the layer is faint and white, a little lighter than the sky round it, never what
  the eye goes to first. The cumulus is drawn over it. The reading:
  [Look values](../reference/look-values.md#light-and-shade).
- Under a low sun, morning and evening alike, the light it takes straight from the sun is warm and
  the light it takes from the sky round it cool. So it reads rose on both sides of the sky, toward
  the sun and away from it, a little more saturated and a little lighter than the sky beside it.
  Avoid a pale yellow-white. It turns back to white as the sun climbs past about 30 degrees.
- Each part of it is lit by the sun as it stands over that part. So after sunset and before sunrise
  the side away from the sun goes out first, with the sun about 1.5 degrees under the horizon, and
  the side toward it last, near 3 degrees under, warmest just before it goes.

## The light under cloud

- A clouded sky is metered by the sky itself, with a key of its own. The land under a deck is lit
  by that deck, so the sky keeps the same relation to the meadow at every height, and the land
  follows the sky's own fall into the evening. Avoid a step where a gap, or a sun dropping through a
  cloud's edge, would move a meter's reading.
- Under cloud the land keeps a light along the sun and the shadows it casts, by one rule under every
  sky: a cloud passes down a part of the sunlight it takes, and the land under it keeps a share of
  that as a soft key. So a cloud's shadow, a cloudy day and an overcast one all show the bamboo's,
  the cliffs' and the islanders' shadows and the lit side of every form, softer and shallower the
  thicker the cloud. A land lit by the sky alone reads flat, without depth; only real rain may lose
  the key.
- Under a deck the land is lit by that softened key and by the deck's sky light.
- With the sun high the deck passes on little of a clear sky's blue, so the light lent to the land
  is a warm grey.

## The sky's colour through the day

- The sky's light takes a gain of its own by the sun's height, the rising sun's apart from the
  setting sun's. Where the gain colours the sky, it decides. Beyond it, avoid a painted pink,
  magenta or deep-blue twilight, which dyes the sea one flat colour and reads as a filter.
  Twilight's mood comes from the light on the island.
- Through sunset the light runs from the golden hour's warm key into a dusk key, more orange still,
  at a sun 1 degree under the horizon, then moves on to the night key by 6 degrees under. The glow
  stands low in the west after the sun has gone and is the brightest thing in the picture.
- After sunset the island stays readable. Through the minutes between the sun's last light and the
  moon's, the meadow goes down with the light, warm under the afterglow, then green, and settles
  into the night without a dip or a lift. It is never brighter at a lower sun, and the night's light
  comes in only as fast as the twilight's leaves, so the night is the twilight's end.
- The light that holds the island up is the sky's own, raised for the island alone, and only the
  evening's is warm: at dawn the land goes from the night's blue into the day with no warm stretch.
- Through the twilight the land goes a little dark and hands over to the moonlit night, the open
  sea darker than the land before the night lifts it.
- The morning is not the evening turned round. Its key is near grey and its display white cold, so
  the sky, the water and the shaded rock are blue together at sunrise, and only a face turned to the
  sun takes a warm colour, a pale one.
- On a clear morning the night goes early: with the sun still 7 degrees under the horizon the air is
  already blue over one thin pink band, and the sea a clear blue under it.

## The parked weathers

The kept weathers need none of this; it stands for the parked weathers' revival.

- Bad weather dims and desaturates the existing light and thickens the air as its visibility falls,
  and it stays dimmer and greyer than a clear day. It never adds a grey veil over the screen.
- A cloudy sky's deck lets go as the sun falls under about 6 degrees: by 3 degrees the low sun
  shines under the broken deck and the view's own light sets the exposure. So a cloudy evening comes
  on by degrees: dark at sunset, neither black nor lit yellow, the meadow never brighter at a lower
  sun except where the cloud opens for a moment.
- Under overcast the land is lit by the softened key and by the deck's own sky light, stronger than
  the sea's. The closed deck reads lighter than the meadow under it, and lighter still toward the
  sun, where the lit cloud about the sun's place glows broad and soft. It is graded more flatly from
  the zenith to the horizon than the standard overcast sky's 3 : 1. The land takes its light from
  the sun's side of the deck as the deck shows it. The sky's lightness holds as a low sun climbs
  ([Look values](../reference/look-values.md#light-and-shade)).
- Overcast is a closed, dark deck at every sun height, morning and evening alike. It does not break
  up at a low sun, and its light leaves only with the sun's own, over the twilight: the land under
  it keeps the deck's soft light through sunset, with no flash of the setting beam on the slopes
  toward it, and goes down into the night as the deck's light does.
- An overcast sky is brightest about the sun's place and dim looking away: a near-neutral pale grey
  near the sun, a dark blue-green grey away from it. The meadow under it is a quieter green, its
  most brightly lit grass muted toward grey.
- The land under overcast is lit soft: the deck's sky light from every side, its glow about the
  sun's place included, lifted well over a cloudy day's. Under the water the floor takes that light
  as the water column passes it down, so the shallows' floor is lit by the same deck, dimmed by the
  water above it the deeper it lies.
- The sun reaches overcast land only through the deck, as the soft key every cloud leaves the land,
  a little more where a thinned region of the deck lies along the sun, in large patches that move
  with the deck. It draws the soft shadows of everything taller than the meadow. The meadow does not
  shade itself in it, so the sward's own shade is the one the sky light finds under its canopy,
  while the bamboo, the stones and the bare ground keep their contact shade.
- Rain is light streaks and ripples on the water. Wetness darkens rock and plants within small
  limits and glosses bare stone; water runs down the cliffs in sparse darker runnels; puddles fill
  fixed hollows and read as water from above.
