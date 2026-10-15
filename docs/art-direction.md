# Ponlai: art direction

The look the user chose and what to avoid. It says what the scene must look like, not how the code
gets there: each module's header comment holds its own rules and reasons. Change this file when an
art decision changes; reference images stay out of the repository.

## The look

- A small stylised island in an open sea, a visual sample for a game. Stylised fantasy-realistic:
  a physically based scene graded toward a painted game's colour. By day the light is high-key,
  airy and soft: a near-white sun, a milky horizon that glows wide and cream on the side toward
  the sun, fresh cool greens; a low sun's light turns warm and golden. Softly glowing highlights,
  airy lifted shadows, deep teal water with a sparkling glare toward the sun, chunky chiselled
  stone, a lush meadow with wildflowers, and grass hanging over the rim. Keep the lower cliff
  stone exposed.
- The fantasy look is an art-directed layer over the physically based image (a wide soft glow
  that spreads from the sunlit grass tips, the horizon and the glints into what is round them,
  greens turned toward pure green and a touch darker, richer teal water, golden highlights over
  cool teal shadows, airy lifted shadows that keep their saturation, a little less contrast and a
  little more brightness: high-key and soft), never baked into the lighting or the tone curve. The
  glow is a soft light round the bright parts, not a grey screen over the whole frame; grey stone
  and skin keep their colour; a dark meadow under a low sun stays green, not olive-grey.
  `soft-fantasy` is the default, `rich-fantasy` a bolder step toward a painted scene, `realistic`
  the plain image for comparison (`src/post/Pipeline.ts`).
- The tone curve keeps the water clear (deep sea dark and saturated, the shallows' seabed and
  caustics in full contrast) and a low sun's sky and sea in their hue rather than washed to cream;
  the sun and its glints burn out. AgX was tried as the default and dropped: its toe greyed the
  deep water and its shoulder flattened the shallows.
- The water is adapted from a physically based model (tidewater) and art-directed toward this
  look: keep new water work stylised rather than strictly realistic.

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
  nothing breaks the surface off the island.
- The cliffs read as natural rock, never masonry: no level courses or evenly spaced joints, no
  lumps of dissolved limestone. A weathered face that has shed blocks along its joints and beds,
  breaks sharp above the waves and rounded only in the wave zone. No pocket reads as a black hole
  or a pair of eyes in the shade. Under the meadow the wall weathers back to an upper slope rather
  than jutting as a slab. No ledge follows the waterline. No waterfalls. Moss and greenery on the
  wall stay in its upper 1.2 m; the lower cliff stays bare stone.
- Plants and meadow cover are rooted on the island top, never on cliff faces. The meadow's sod
  curls a little over the lip as a ragged turf skirt, and the meadow passes into the cliff through
  grass hanging from that lip, as on a sea cliff's top: bundles of the meadow's blades, of mixed
  lengths (0.2 - 1 m), combed to one side, drier and yellower than the meadow, in stretches with
  clumps and thin places, fewer where bare stone meets the meadow. What hangs over the rim is the
  meadow's own grass, not leafy branches; the lowest quarter of the cliff above the sea stays bare.
- The meadow is a lawn, even as a whole and every blade its own: dense, sword-shaped blades, wide
  to high up and tapering to a point, standing nearly upright but each a little taller or shorter,
  turned and leaning its own way with a slight arc, so they cross rather than look combed; they
  bend with the wind together. Each blade is folded along its midrib, one half lit and the other
  shaded, with a thin lighter edge, and differs a little in value and tint (now and then a yellower
  or a deeper green), all of it far finer than any patch, so the lawn's average stays one colour.
  One grass colour, a bright, fresh, natural green, matte with only a faint gloss (no pale sheen
  over the blades, which reads as plastic): the gaps between blades a deep, cooler green (never
  near black) under tips that stand out lighter and yellow-green where the sun shines through
  them; looking toward the sun the whole lawn glows, away from it it is plainer and greener; no
  clumps, tall islands or bare patches, and no pattern of dots on the blades. Inside the grass
  there are no hard shadows, only an even darkening toward the ground; the shade of anything
  standing on it lies soft and light. Cloud shadows are soft patches a few tens of metres across
  that drift slowly over the island and the sea with the wind: none under a clear sky, some in
  fair weather, more and softer as cloud gathers, merging into one even shade under overcast.
  The light moves; nothing dark is painted onto the ground. The turf under the blades is the
  deeper green of their lower part,
  so from afar the meadow reads as one smooth carpet. By night the lawn is a dark blue-green, its
  blades lit only as the moon's own strength allows. Toward the coast the tufts grow taller and lean out over the lip
  instead of thinning, and the lip alternates between overgrown stretches and cut-open root soil.
- Wildflowers are part of the meadow: heads (a hand across at most: large enough that the game's
  close view reads them as flowers, not dots) on some of its tufts, about at the blades' tips,
  some partly hidden among them, with no stem or leaves showing. They are a warm temperate
  coast's: pinks, wild chrysanthemums (yellow, a few white), daylilies, dandelions, violets and a
  few balloon flowers, all in flower at once, the year round: the island's sign of an immortals'
  land. Each grows in patches of its own where its habitat is, dense at the centre and thinning
  to the edge, with almost no flowers between: a broken band of pink along the cliff's edge,
  chrysanthemums on the grass in from it, orange daylilies where the ground is damp, yellow and
  violet in the short turf. Colours are soft rather than vivid, and no head (white and yellow
  least of all) outshines the lawn; never a scatter of mixed colours over the lawn, which reads as
  confetti. They sway with the grass, and from afar they are fine coloured specks in it, gathered
  in patches, not coloured stars or blots on the lawn.
- The terrain plants the meadow (grass, wildflowers) and its turf over the rim, nothing taller:
  the island is a flat top ringed by cliffs, with no lee where shrubs or trees would grow, so it
  has none (the shrubs, small trees, rim bushes and hanging leaf trails it once had were
  placeholders). The walker's loop stays open meadow. Plants that matter to play (coconut palms)
  are content placed in the world, not terrain.
- All vegetation moves in one wind: gusts visibly sweep the meadow and change as they go; still air
  is the rest pose.

## Sea, sky and weather

- Rain, storm and fog are parked (`PARKED_WEATHER` in `src/sky/Weather.ts`): out of the rotation
  and the production page until the game needs them; the notes on them below stand for their revival.
- The sea is calm in everyday weather: no shore foam or whitecaps. Only a storm's gale builds a
  rough sea with whitecaps, trailing foam and spray. The sea continues to the horizon.
- One dominant key light, sun by day and moon by night. By day the sun is near white and the air
  hazy: the horizon reads milky white rather than a cyan band, brightest toward the sun. A low
  sun's light stays golden orange. After sunset the island stays readable: through the minutes
  between the sun's last light and the moon's, the meadow keeps its light (warm under the
  afterglow, then green), never dipping below its night brightness; the light that holds it up is
  lent to the island alone. The
  sun and moon are drawn at twice their true size. The day cycle is authored, not astronomical.
- Bad weather dims and desaturates the existing light; it never adds a grey screen veil, and it
  stays dimmer and greyer than a clear day. Distant air leaves the island's foreground clear as
  the view pulls back. Sea fog is a low layer that may surround the island, never a uniform tint.
- Weather changes sweep the sky as a front from upwind.
- Rain is light streaks and ripples on the water. Wetness darkens rock and plants within small
  limits and glosses bare stone; water runs down the cliffs in sparse darker runnels; puddles fill
  fixed hollows and read as water from above.
- The tilt-shift blur belongs to the island's surroundings: the sky stays sharp (a blurred sky
  reads as a low backdrop and turns stars into bokeh discs).

## Night

- The night is art-directed, not a simulation of the eye's night vision: colours stay as authored,
  so a future fantasy palette (glowing plants, magic) keeps its saturation. The night has a
  fantasy look of its own rather than none: a cool soft glow round the moon, the clouds it lights
  and the moonlit surfaces, cool highlights, a lighter night whose shade does not sink to black,
  and the day's look crosses into it as the sun sets.
- The island reads by moonlight and starlight; twilight is never darker than the night. The
  moon takes over the key soon after the sun has gone.
- The night meadow is a dark, readable, cool green turning toward blue-green (not black, olive or
  teal), turned by the night's own grade rather than by a bluer light, so stone, sand and skin keep
  their colours.
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
