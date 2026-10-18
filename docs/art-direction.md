# Ponlai: art direction

The look the user chose and what to avoid. It says what the scene must look like, not how the code
gets there: each module's header comment holds its own rules and reasons. Change this file when an
art decision changes; reference images stay out of the repository.

## The look

- A small island in an open sea, a visual sample for a game, fantasy-realistic: the fantasy lives
  in the world (the island, its everlasting flowers, later the sea's glow at night) and in a light
  touch on the image, the airy feel of an immortals' island (Penglai). Deep clear water over pale
  shallows with a sparkling glare toward the sun, chunky chiselled stone, a lush meadow with
  wildflowers, and grass hanging over the rim. Keep the lower cliff stone exposed.
- The light and the image are photographic, as real as tidewater's (its water, its light under
  the water, its display chain): the scene is lit by the sun or moon, the sky and the sunlight the
  ground bounces up, and the frame takes a filmic curve (ACES), tidewater's light grade (a slight
  warm white balance, a touch more saturation and contrast, a vignette, film grain) and a faint
  physical bloom over the whole image.
- Over that photograph, a light push toward a painted one, never a veil over it:
  - The shade by day is clear, never black: the skylit faces of the cliffs and the meadow's
    shaded side open up a little, a touch cool, while cracks, the meadow's floor and what the sky
    cannot reach stay deep. It comes from more sky light on the island, not from lifting the
    blacks: a lift in the grade greyed every dark alike and laid a milky film over the frame, as
    the old art-directed layer did. A low sun's shade already holds more sky and takes less; an
    overcast island, all in shade, takes none.
  - Lights a touch golden, the shade a touch teal, the contrast a little softer, the bloom a
    little stronger (the grade's tone, at half of its full step: the full step greyed the frame).
  - A low sun (below about 12 degrees, gone by 28) lights a deeper gold toward orange, from the
    midtones up, and the island's shade turns blue-violet (its sky light, not the sea's or the
    sky's). At the horizon the frame is golden already and takes little more.
  - No thick haze or fog laid evenly over the frame for an airy feel: it reads as smog. Mist, if
    any, gathers in bright banks round the island and the cliff's foot.
  - The night is a film's night (day for night), not a dark one: the moonlit island clearly
    readable, its shade open (the night sky's light on the island, not a lifted black), the
    meadow a cool green toward blue-green, the frame a touch silver-blue, a small cool halo round
    the moon and its path on the sea (see Night).
- Real phenomena are not exaggerated beyond that; no hue turns but the night meadow's, no glow
  round every highlight.
- The exposure follows the time of day and the weather, calibrated against tidewater's frames at
  the same sun elevation, so the day reads as tidewater's does; a sun in the frame may read a
  little brighter than its eye-adapting exposure would show it. Overcast stays about three
  quarters of the same view's clear day. The night keeps the moonlit island readable (see Night).
- No lens effects a photograph of a real place would not have: no tilt-shift miniature blur, no
  lens flares forced into the frame.
- The water is tidewater's physically based model with clear water a little less pure than its
  tropical one: teal in the basin, a green turquoise (jade) over the sandy shallows, never a
  saturated navy or a blue-cyan; greener still read as a lake beside the meadow. The shallows are
  clear to the floor in everyday weather: the stones and the sunlight's network on the sand show
  through the water, which wobbles them but never breaks them into crumbs, and the calm water
  carries no film of foam.
- The look is judged from the game's own view, the island camera zoomed out over the island, as
  well as close up. Light reads there through its direction and large-scale light and shade (lit
  and shaded slopes and cliffs, a glint or moon path on the sea, later warm lights and what stands
  on the island), not through fine detail or post effects, which vanish at that distance.
- The island view's default direction is fixed and looks a little east of the meridian the sun and
  moon culminate on: the full moon's path is in the frame through the evening and at midnight, and
  by day the sun lights the cliffs from the side (a lit and a shaded side) without filling the
  frame with glare. It never follows the clock, so returning to the view never jumps.
- Sunlit stone keeps its grain and its grey: a cliff face turned to the sun is the brightest
  ground in the frame but never a flat cream-white sheet. The stone is kept darker than real
  limestone so that the exposure set for the meadow leaves it below the curve's shoulder. A wall
  over bright shallows takes their teal light from below.

## Three layers in one world

- Nature (cliffs, sea, plants) is realistic.
- Things people make (huts, boats, baskets, lanterns) are semi-realistic and handmade, a little
  chunky and rounded in form but with real materials (wood grain, rope, fired clay), and bridge the
  other two.
- People are stylised, with simplified forms and blocks of colour.
- All three share one lighting, one grade and one palette, so they read as one place (as in Alba,
  Sky and Tchia).

## The island

- The island grows one piece of land at a time from a starting island at the world's centre
  (docs/game-design.md, "How the island grows"): its coast always irregular and natural, never
  drifting toward a square or a circle. Keep a flat central plateau. Natural contour, slope and
  weathering variation belong to the outer rim and cliffs.
- Offshore stones stay submerged and form patchy seabed detail: no exposed sea stacks or reefs;
  nothing breaks the surface off the island. Large blocks heap below the stretches of coast that
  shed them; elsewhere the shelf is mostly clear sand and platform, never stones sprinkled evenly
  round the coast.
- The floor round the coast zones as a real rocky shore's: cobbles with an olive film close against
  the cliff's foot, then a belt of clean sand whose ripples, a hand's width apart, run along the
  coast, and seagrass only below the swell's reach (from about 3.5 m down), in meadows tens of
  metres across with sharp edges and sand holes. Nothing on the floor runs one way across the
  whole sea.
- The cliffs read as natural rock, never masonry: no level courses or evenly spaced joints, no
  lumps of dissolved limestone. A weathered face that has shed blocks along its joints and beds,
  breaks sharp above the waves and rounded only in the wave zone. No pocket reads as a black hole
  or a pair of eyes in the shade. Under the meadow the wall weathers back to an upper slope rather
  than jutting as a slab. No ledge follows the waterline. No waterfalls. Moss and greenery on the
  wall stay in its upper 1.2 m; the lower cliff stays bare stone.
- Plants and meadow cover are rooted on the island top, never on cliff faces. The meadow runs to
  the lip and meets the stone there, with no sod rolled over the edge. It passes into the cliff
  through grass growing from the lip and hanging over it as one fringe, as on a sea cliff's top: dense, short,
  nearly parallel bundles of the meadow's blades (mostly 0.15 - 0.5 m, a few to 0.8 m), each
  bent by its own weight into one smooth arc (stiff at the root, soft at the tip: long blades
  arc over and hang, short ones only bend), lying on the stone where they meet
  it, combed to one side, drier and yellower than the meadow, in stretches with clumps and
  thin places, fewer where bare stone meets the meadow. Not fans of long blades like small palm
  leaves. What hangs over the rim is the
  meadow's own grass, not leafy branches; the lowest quarter of the cliff above the sea stays bare.
- The meadow is a sward of tussocks, closed as a whole and every tussock and blade its own: dense,
  long, sword-shaped blades, wide to high up and tapering to a point, arcing over under their
  weight, each a little taller or shorter, turned and leaning its own way, so they cross rather
  than look combed; each tussock its own height, stiffness and lean, so the wind moves them
  together but never combs them flat as one pile. Each blade is folded along its midrib, one half
  lit and the other shaded, with a thin lighter edge, and differs clearly in value (about a third
  either way) and colour (fresh green, yellow green, olive, a few dry leaves), all of it on a
  tussock's scale or finer, so the lawn's average stays one colour; never a single dyed green,
  which reads as plastic.
  One grass colour, a bright, fresh, natural green, matte with only a faint gloss (no pale sheen
  over the blades, which reads as plastic): the gaps between blades a deep, cooler green (never
  near black) under tips that stand out lighter and yellow-green where the sun shines through
  them; looking toward the sun the whole lawn glows, away from it it is plainer and greener; no
  fields of tone, dryness or bare earth (they broke the lawn into what read from the overview as
  camouflage and dark blotches), and no pattern of dots on the blades. The island top is one
  sward, about 0.5 m, with no zones across it: tiers of height and tint by the soil (a short
  yellow-green band along the windward coast, a taller, deeper grass on deep soil, gravel patches
  inland) read from above as a map laid over the meadow. Its layering comes from the grass itself:
  each tussock from about 0.6 to 1.4 times the sward's height, its own colour and value, and now and
  then a low patch of one to a few short tussocks, where the low wildflowers grow. As in a real
  meadow its soil sets the odds: the sward rises a little where the soil is deep and damp and sinks
  a little where it is thin, over some 14 m, and in pockets of shallow soil a few metres across, a
  tenth of the meadow, the sward slopes down toward a short turf, tussock by tussock, with tall
  tussocks still standing in them: from above a soft mottling, never a zone, a line, a path or a
  hollow (a short turf walled by tall tussocks, two levels, read as a hole dug into the lawn).
  From the ground up the sward has a summer meadow's layers: dead leaves and the old leaves' straw
  sheaths low in it, the green leaves, and over them a few flowering stems from each tall tussock,
  their slender panicles purple brown to straw a hand above the leaves (none on the short turf),
  a faint haze over the green from the game's view, never a field of straw. Under the grass, where
  it is short or broken, grow the low herbs of a real meadow: white clover's mats of three-leaved
  leaves over the short turf of the shallow pockets, and greater plantain's flat rosettes of broad
  oval leaves with a slender spike or two in the gaps, a little larger than life so the game's view
  shows them, from 22 m a finer, rounder green over the earth of the openings, never a lawn of
  their own. The sward runs to the edge on
  every coast, windward and lee alike: a windward lip shown short, yellow, thin over gravel and
  bared to the cliff's stone read from above as one more zone. Inside the grass
  there are no hard shadows, only a darkening toward the ground (a deep green, never black); the
  shade of anything standing on it lies soft and light. The only shadows that cross the ground
  are the real clouds' (from the cloud layer overhead, drifting with it): no patches painted or
  animated onto the island to vary its light. The ground under the grass is what a real meadow
  shows there: under the dense sward its shaded bottom, the lower leaves' deep green with a little
  straw, where no light reaches the soil; where the sward is broken by a gap, the island's
  yellow-brown earth under lying dead leaves, never a green turf skin
  laid under the near blades (it read as one, and on the lip's bevel its texture ran down the slope
  in stripes). The short turf is a closed mat, as a wind-cropped or shallow-soil turf is: its
  leaves splayed out over the ground, its base olive with thatch and only flecks of earth, so from
  every view and at every zoom the meadow is one dense sward, a little yellower where it is short;
  bare earth only in its few gaps, never thin grass over brown ground, and never a ground that
  changes colour as the camera zooms. At the lip the turf ends on its soil over the stone, never a
  dark hole among the flowers. By night
  the lawn is a dark, readable green (see Night). Toward a sheltered coast the grass runs to the
  lip and stands there, and the same grass grows out over it: its tufts at the lip spill over the
  edge, fine blades that arch over and hang down the wall, lying on the stone, never through it, and the lip alternates between
  overgrown stretches and cut-open
  root soil.
- Wildflowers are part of the meadow: heads (a hand across at most: large enough that the game's
  close view reads them as flowers, not dots) on some of its tufts, each on a thin stem bent a
  little by its head: the low species (pinks, dandelions, violets) on lower tussocks among the
  grass, never in a patch of their own cut short,
  the pinks along the lip's edge, the tall ones
  (wild chrysanthemums, daylilies, balloon flowers) in tall tussocks, the chrysanthemums about at
  their leaves' top, some partly hidden among them, the daylilies and balloon flowers on their
  taller stems a little over the leaves, never floating over the grass. They are pinks, wild
  chrysanthemums (yellow, a few white), daylilies, dandelions, violets and a few balloon flowers,
  all in flower at once, the year round: the island's sign of an immortals' land. Each grows as a
  wildflower colony does, in drifts of its own where its habitat is: a few clumps strung together,
  long and lobed rather than round, many small drifts and a few large, thinning to single plants
  scattered round them, and where two drifts meet their flowers mingle; few flowers between the
  drifts. Pink grows along stretches of the cliff's edge with long stretches of plain turf between
  (an unbroken band round the island top read as a border drawn on it), chrysanthemums on the
  grass in from it, orange daylilies where the ground is damp, yellow and violet in small low
  patches of the short turf. Colours are soft rather than vivid, and no head (white and yellow
  least of all) outshines the lawn; never a scatter of mixed colours over the lawn, which reads as
  confetti. They sway with the grass, and from afar they are fine coloured specks in it, gathered
  in patches, not coloured stars or blots on the lawn.
- The terrain plants the meadow (grass, wildflowers) and its turf over the rim, nothing taller:
  the island is a flat top ringed by cliffs, with no lee where shrubs or trees would grow, so it
  has none (the shrubs, small trees, rim bushes and hanging leaf trails it once had were
  placeholders). The walker's loop stays open meadow. Plants that matter to play (coconut palms)
  are content placed in the world, not terrain.
- All vegetation moves in one wind: gusts visibly sweep the meadow and change as they go; still air
  is the rest pose. The wind turns with the weather and has levels (light, gentle, fresh, strong;
  gentle most of the time, fresh at times, light or strong rarely), coming mostly from within
  40 degrees of the prevailing wind and now and then from the opposite side; the landscape keeps
  the prevailing wind (the meadow's exposure).

## Sea, sky and weather

- Rain, storm and fog are parked (`PARKED_WEATHER` in `src/sky/Weather.ts`): out of the rotation
  and the production page until the game needs them; the notes on them below stand for their revival.
- The sea is calm in everyday weather: no whitecaps on the open water. Only a storm's gale builds
  a rough sea with whitecaps, trailing foam and spray. The sea continues to the horizon.
- The island stands in the sea's way. Its foam follows the waves the eye sees arrive: where a
  wave runs high against the rock the foot turns white as it strikes, and the foam spreads out and
  thins to lace as it drains; where a wave runs low the rock stays bare. A wave's foam outlasts it
  by several seconds, so the foot always carries some, which each new wave brightens and pushes out
  rather than starting again; it thickens in a set of bigger waves and thins in a lull. The
  backwash carries it out in tongues in some stretches and leaves it hugging the rock in others,
  and it breaks into patches as it ages: never a ring at one distance from the rock. The foam falls
  off as the coast turns from the swell and is absent where the waves slide along the rock. On an
  everyday sea it is a narrow band, a few decimetres to a metre or two wide. No water thrown up the
  rock, no foam that jumps or flashes, no rocks that stay white while their neighbours stay bare,
  never wide fields of foam, which belong to a surf day. The lee lies in the island's wave shadow,
  nearly smooth, without foam.
- One dominant key light, sun by day and moon by night. By day the sun is near white and the air
  hazy: the horizon reads milky white rather than a cyan band, brightest toward the sun. A low
  sun's light stays golden orange. After sunset the island stays readable: through the minutes
  between the sun's last light and the moon's, the meadow keeps its light (warm under the
  afterglow, then green), never dipping below its night brightness; the light that holds it up is
  lent to the island alone. The
  sun and moon are drawn at twice their true size. The day cycle is authored, not astronomical.
- The sunlit ground lights what stands over it from below, one bounce for every lit surface: the
  shallows' sand the cliff's walls, the meadow the islanders' undersides; strongest around midday.
- Bad weather dims and desaturates the existing light; it never adds a grey screen veil, and it
  stays dimmer and greyer than a clear day. Distant air leaves the island's foreground clear as
  the view pulls back. Sea fog is a low layer that may surround the island, never a uniform tint.
- Weather changes sweep the sky as a front from upwind. The clouds drift downwind with the wind
  aloft, faster than the surface wind (the cumulus about twice it, the cirrus about three times,
  along their fibres), so they never move against the grass and the sea.
- The sky keeps the atmosphere's own colours through sunset, twilight and the blue hour: no
  painted pink, magenta or deep-blue twilight, which dyes the sea one flat colour and reads as a
  filter. Twilight's mood comes from the light on the island, not from tinting the sky.
- Rain is light streaks and ripples on the water. Wetness darkens rock and plants within small
  limits and glosses bare stone; water runs down the cliffs in sparse darker runnels; puddles fill
  fixed hollows and read as water from above.

## Night

- The night takes the day's curve and grade with a light night grade over them, a film's day for
  night rather than a simulation of the eye's night vision: the meadow's greens turned toward
  blue-green, a slight silver-blue tint, a stronger bloom for a small cool halo round the moon,
  its clouds and its path. Stone, sand, skin and a future fantasy glow (sea life, magic) keep
  their colours and saturation. Its exposure keeps the moonlit island clearly readable and the
  moon's path on the sea crisp; the shade stays open by the night sky's light on the island; a
  moonless night is darker, a deep navy island, still readable.
- The island reads by moonlight and starlight; twilight is never darker than the night. The
  moon takes over the key soon after the sun has gone.
- The moon keeps a lower orbit than the sun (it culminates at 37 degrees, not 62), still rising
  due east and setting due west at the sun's hours, so seen from the game's overview its light
  comes in at a slant: slopes show a lit and a shaded side and the sea carries a moon path, where
  a moon near the zenith lit the island flat. The moon path and the moonlit meadow glow softly in
  that view too.
- The night meadow is a dark, readable, cool green toward blue-green (not black, olive or teal);
  stone, sand and skin keep their colours.
- The stars and Milky Way are the real sky as seen near 28 degrees south, points with a natural
  spread of brightness, below white except the brightest few; only those near the horizon
  scintillate.

## Islanders

- Simple low-poly figures with flat colours and simple faces, recoloured into the island's palette
  and lit by the island's own light in soft cel steps; no outlines. Plants keep their realistic
  shading.
- A Hylian-like people (after The Legend of Zelda: Breath of the Wild): human in every way but for
  long pointed ears that sweep back and a little up.
- Plain dress while the basic look settles: undyed linen and calm earthy tones, leather shoes, no
  hat.
- The medium proportions of `src/characters/Proportions.ts` (about 4.7 heads tall, against the
  kit's 5.5: a larger head, shorter legs, broader shoulders and hands), chosen by the user from four
  builds; the kit's own stays selectable for comparison.
