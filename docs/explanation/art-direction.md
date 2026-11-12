# Ponlai: art direction

The island's look and what to avoid. It says what the scene must look like, not how the code
gets there: each module's header comment holds its own rules and reasons. Change this file when an
art decision changes; images from elsewhere stay out of the repository.

## The look

- A small island in an open sea, a visual sample for a game, fantasy-realistic,
  inspired by the eastern aesthetic of Ghost of Tsushima: a calm, painterly light, restrained
  colour, and wide fields of grass and flowers that move together in the wind. The fantasy lives
  in the world (the island, its everlasting flowers, its creatures from the old texts, later the
  sea's glow at night) and in a light touch on the image, the airy feel of an immortals' island
  (Penglai). Deep clear water over a quiet floor with a sparkling glare toward the sun, chunky
  chiselled stone, a lush meadow with wildflowers, and grass hanging over the rim. Keep the lower
  cliff stone exposed.
- The light and the image are photographic: the scene is lit by the sun or moon, the sky and the
  sunlight the ground bounces up, and the sea takes that light as sea water does (see the water
  below). The frame is developed in stages: a local tone mapping keeps a bright
  sea, glare or sky from burning out and greying while the land keeps its level (by day only what
  lies well over the lit ground is drawn toward it; under a low sun the land is drawn up as well,
  the more the darker its surroundings; the detail is kept); the shade's contrast, deepened under a
  pivot so the shade stays solid under the soft curve (over the lit ground by day; a quarter of a
  stop under mid grey under a low sun, where the long shadows take the most, and gently under clouds
  and by night); a soft filmic curve (gentle in the shadows and midtones,
  with a long shoulder and a long toe, which deep in the dark halves the screen's level every
  two stops, keeping the shade's gradations, and still reaches black, with no floor veiling the
  darks; its contrast, shoulder, white and toe adjustable; no saturation of its own, which the
  grade's hue bands set) whose working space keeps a low sun's reds from turning yellow; a white
  balance given as the colour white becomes, by the time and the weather (a clear
  day cool from noon to a low sun, against the sun's warmth, so sunlit rock reads a pale neutral,
  the meadow keeps its green and the sky and the sea stay blue, while the shade stays the colour of
  what stands in it, never blue; the golden hour a little warm, the clouded
  skies and the night cool); a bloom only on what is truly bright (the sun's
  glints on the sea, the sun, a moonlit path), never a veil over the whole frame, and next to none
  under a clouded sky; a vignette that darkens only the corners, and no grain; and two grade
  tables, generated from a grade's parameters, that a look can blend between by time of day or place
  (the first holds the day's grade: no contrast or saturation over the whole frame, each hue moved
  lightly on its own, the warm hues and the sky's blue a little richer, the green a touch quieter
  and turned a little toward yellow against the cool white balance, the sea's
  blue-green a little bluer, the red flowers' colour kept against the cool white and the
  highlights a touch cool; the second is the identity). The exposure lets the frame darken as the
  sun sinks, so a low sun reads as a low sun. The local tone mapping, the curve's working space,
  the white balance and the grade tables are techniques Patry presented (SIGGRAPH 2021); the
  curve's toe, the shade's contrast, the vignette, the bloom and
  the blend of two tables are ours.
- The light keeps the sun's and the sky's own balance, by day and by night, so that the land shows
  where the light comes from: a stone or a figure has a lit side and a shaded one, and its shade
  falls on what lies beside it; the meadow shows it in its slopes, in the light through its blades
  and in the sheen a gust sweeps over it. Nothing lifts the shade toward the light: no extra share
  of sky light on the island (a "clear shade"), no grade tone that softens the contrast and
  recolours the lights and the shade, no low sun's recolouring and no film's day for night.
  Together with the meadow's own soft light they leave a shaded clump within a quarter of a lit
  one's brightness, and the meadow reads as lit by an overcast sky. On a clear day the higher the
  sun, the harder the contrast between the lit ground and the shade (the ratios:
  [Look values](../reference/look-values.md)). The frame's brightness comes from the exposure,
  which keeps the ratio between light and shade.
- The shade is lit by the sky the island lets through (the ambient volume, which sees the land,
  its groves and its cliffs: `src/lighting/AmbientSample.ts`). At noon on a clear or fair day the
  open meadow's lit side stands well over its shade; a low sun's lit side comes down toward its
  shade, and that is left as it is. A grove's floor in shade reads darker than the open shade at
  its edge, darker still deeper in. Its culms in shade stand a little darker than the crowns
  over them, dark green stems against the light between, and the faces toward the grove's open
  sides read lighter than those toward its inside. Where a culm or a stone meets the ground the
  contact darkens a little, gone within about a metre: a grounding, never a dark ring.
  Where the grass, the culms and the ground's relief close the sky, the shade loses some of its
  light broadly, over metres (the screen-space ambient occlusion, on in high: `src/post/GTAO.ts`,
  and at the turf's roots the share of the sky its blades leave): the ground among the grass in
  shade and a grove's floor darken most, a culm's sides a little, lit surfaces not at all (the
  amounts: [Look values](../reference/look-values.md)). The ambient light is set for the shade with
  that loss in it, never pressed down once more for it, and a loss two terms estimate counts
  once (the turf takes the stronger of the two).
- The air always carries a visible haze: it is part of this world, the sea's island seen through
  it. Its shape is physical: the density varies with height alone, a thin ground layer lying on the
  sea, much denser than a clean sea air near the water and clean above the layer. It answers to
  neither the camera nor the island, so the island seen from above is clear, while the far sea and
  the horizon, whose lines of sight run long and low through the layer, are hazed. Where the haze
  is thick, the player draws in closer to see.
- The sun's disk is drawn larger than life (1.1 degrees, about twice its true size), softly
  limb-darkened, its edge clean; round it a soft glow sized by the frame, not the field of view,
  near white at its core and fading as the square of the distance past half the frame, with no
  streaks, ghosts or rings. It weakens with the share of the disk left uncovered yet stays wide
  through a gap in leaves, goes with the disk when the sun leaves the frame, and is weaker against
  the bright sky round a low sun.
- Real phenomena are not exaggerated; no glow round every highlight, and no hue turned further
  than a few degrees (the grade turns no hue more than 7 degrees).
- The exposure is metered from the light falling on what the frame shows, not the light leaving it,
  so a dark meadow or sea is not brightened toward grey; by day the sky weighs into the meter, most
  of all under a high sun, and the frame's brightest few percent hold it down, which darkens a view
  toward a low sun against one away from it. The frame darkens with the light: as the sun goes down
  a sunlit grey card on level ground goes down with it, the more the lower the sun, so a low sun
  reads as a low sun (in the golden hour, with the sun at 3 degrees, a sunlit cliff is orange with
  deep brown shade, a stop or more under its light, and the sky over it a shade redder and dimmer,
  not a yellow-gold face under a pale sky); the deep night holds its exposure whatever the moon
  (the grey card's codes by day and by night: [Look values](../reference/look-values.md)). A
  clouded sky is metered by the sky itself, with a key of its own: the land under a deck is lit by
  that deck, so the sky keeps the same relation to the meadow at every height, and the land
  follows the sky's own fall into the evening with no step where a gap, or a sun dropping through a
  cloud's edge, would move a meter's reading (how the land under a deck is lit: Sea, sky and
  weather). A sun in the frame may read a little brighter than its eye-adapting exposure would
  show it. The night keeps the moonlit island readable (see Night).
- No lens effects a photograph of a real place would not have: no tilt-shift miniature blur, no
  lens flares forced into the frame.
- The look is judged from the island view, the island camera zoomed out over the island, as
  well as close up. Light reads there through its direction and large-scale light and shade (lit
  and shaded slopes and cliffs, a glint or moon path on the sea, later warm lights and what stands
  on the island), not through fine detail or post effects, which vanish at that distance.
- The sun keeps a mid-latitude equinox's path, 52 degrees up at noon, rising due east at 6 and
  setting due west at 18: high enough at noon to read as a bright day, low enough that slopes keep
  a lit and a shaded side in the island view, and slow near the horizon (11.8 degrees an hour), so
  the low sun's light lasts. A higher noon is a subtropical light, at odds with the island's
  temperate bamboo and meadow (`src/sky/DayCycle.ts` NOON_ELEVATION).
- The island view's default direction is fixed and looks a little east of the noon meridian, where
  the sun culminates and the moon stands: the full moon's path is in the frame through the evening
  and at midnight, and by day the sun lights the cliffs from the side (a lit and a shaded side)
  without filling the frame with glare. It never follows the clock, so returning to the view never
  jumps.
- Sunlit stone keeps its grain and its grey: a cliff face turned to the sun is the brightest
  ground in the frame but never a flat cream-white sheet. The stone is kept darker than real
  limestone so that the exposure set for the meadow leaves it below the curve's shoulder, but
  lighter than the meadow's albedo ([Look values](../reference/look-values.md)), so a face lit from
  the side stands out from the grass as a pale cliff rather than a dark band. The wall's foot, in
  and under the water, is the same stone wet: under the water it keeps nearly all of its dry albedo,
  and it darkens only as the water over it dims and colours the floor beside it, so nothing pale
  runs along it at a low sun or under cloud.

## How the look is made

The image is stylised realism: physically based and developed like a photograph, but not aimed at
photorealism, with the style laid over it in the light and the image. The fantasy is mostly in
what the world holds (the island, its everlasting flowers, its creatures from the old texts), with
a light touch on the image (The look, above). Physically based
materials, lit by a light that may leave physical correctness globally by weather and time of day,
is the approach Jasmin Patry described ("Samurai Shading in Ghost of Tsushima", SIGGRAPH 2020;
"Real-Time Samurai Cinema", SIGGRAPH 2021).

It is made by keeping lookdev and lighting strictly apart, a rule of our own. Lookdev (look
development) makes each material right on its own: real values checked against the real range,
then seen first on the clear day at noon, before the other weathers and hours; lighting sets the
light and the image for the whole world, by weather and hour. Neither does the other's work: no material
is tuned to fix the light, and no light is tuned for one material. Tuning a material to make up
for the light is baking lighting into albedo; it breaks again whenever the light changes.

- Lookdev: the materials are real. Grass, stone, bamboo and sand take the values the real things
  have, and one physically based light sets the relations between them, so they read as one place
  without being tuned against each other. How a material's values are found and checked:
  [Add a material](../how-to/add-material.md).
- Lighting: the style lives in the light and the image: the light's knobs per weather and hour (the
  ambient balance, the sky's brightness, the haze), the exposure, the tone mapping and the grade. A
  change there moves every material together.
- The colour comes mostly from choosing: few kinds of plant per place, quiet textures with little
  noise, leaves that let the light through. Which real things stand on the island is the art
  decision. Colour may be pushed, but for the whole world at once and within what the real things
  could be, never one material on its own.
- A few materials depart from real values on purpose: the cliff's stone is kept darker than real
  limestone (The look, above).

## Three layers in one world

- Nature (cliffs, sea, plants, creatures) is realistic.
- Things people make (huts, boats, baskets, lanterns) are semi-realistic and handmade, a little
  chunky and rounded in form but with real materials (wood grain, rope, fired clay), and bridge the
  other two.
- People are stylised, with simplified forms and blocks of colour.
- All three share one lighting, one grade and one palette, so they read as one place (as in Alba,
  Sky and Tchia).

## The island

- The island grows one piece of land at a time from a starting island at the world's centre
  (docs/explanation/game-design.md, "How the island grows"): its coast always irregular and natural,
  never drifting toward a square or a circle. Its top is a plateau that rolls as an old meadow does:
  low mounds, banks and hollows of about half a metre to a metre either
  way, some 18 m across with smaller hummocks on them, the slopes mostly under 12 degrees and never
  past what the grass holds; flat on average, never a hill, a bowl or a tilt. The cliff's height
  follows it along the coast. Contour, slope and weathering variation of the stone belong to the
  outer rim and cliffs.
- Offshore stones stay submerged and form patchy seabed detail: no exposed sea stacks or reefs;
  nothing breaks the surface off the island. Large blocks heap below the stretches of coast that
  shed them; elsewhere the shelf is mostly clear sand and platform, never stones sprinkled evenly
  round the coast.
- The floor round the coast zones as a real rocky shore's: cobbles with an olive film close against
  the cliff's foot, rounded stones in a low mottle close to the sand of their depth and a little
  greyer at every hour, with silted sand between them and thinning out within a few metres, then a
  belt of clean sand whose ripples, a hand's width apart, run along the coast, and seagrass only
  below the swell's reach (from about 3.5 m down), in meadows tens of
  metres across with sharp edges and sand holes. Nothing on the floor runs one way across the
  whole sea.
- The cliffs read as natural rock, never masonry: no level courses or evenly spaced joints, no
  lumps of dissolved limestone. A weathered face that has shed blocks along its joints and beds,
  breaks sharp above the waves, rounded in the wave zone and at the crest. No pocket reads as a
  black hole or a pair of eyes in the shade. Under the meadow the wall weathers back to an upper
  slope rather than jutting as a slab, and rolls over into the meadow in a broad convex shoulder
  of weathered stone, never a sharp corner: broader on some stretches, tighter on others, the
  breaks through it blunted rather than notched. No ledge follows the waterline. No waterfalls.
  Moss and greenery on the wall stay in its upper 1.2 m; the lower cliff stays bare stone.
- Plants and meadow cover are rooted on the island top, never on cliff faces. The meadow runs out
  onto the shoulder and meets the stone where it steepens, with no sod rolled over the edge. It
  passes into the cliff through grass growing from the lip and hanging over it as one fringe, as on
  a sea cliff's top: dense, short, nearly parallel bundles of the meadow's blades (mostly 0.15 - 0.5
  m, a few to 0.8 m), each bent by its own weight into one smooth arc (stiff at the root, soft at
  the tip: long blades arc over and hang, short ones only bend), lying on the stone where they meet
  it, combed to one side, drier and yellower than the meadow, in stretches with clumps and
  thin places, fewer where bare stone meets the meadow. Not fans of long blades like small palm
  leaves. What hangs over the rim is the meadow's own grass, not leafy branches; the lowest quarter
  of the cliff above the sea stays bare.
- The meadow is one even sward: from the island view a uniform
  carpet of grass with only soft, broad changes over it, never a field of tussocks or lumps. Close
  up it is dense, long, sword-shaped blades, wide to high up and tapering to a point, arcing over
  under their weight, each a little taller or shorter, turned and leaning its own way, so they
  cross rather than look combed. The grass is grouped into clumps that share their height, lean
  and colour and differ from each other only a little (a tenth of the height either way), so the
  field is not a mown lawn and the wind moves it in broad sweeps but never combs it flat as one
  pile; never clumps grown as visible mounds (a quarter of them half again as tall, leaning out,
  each lit on one side and shaded on the other), which draw the island top as a field of lumps.
  Each blade reads as a rounded leaf, its light turning across its width (a short one folded into
  two leaves), and only a little apart from its neighbours in value and colour; the colour (fresh
  green, yellow green, olive, a few dry leaves) changes from stroke to stroke, a few clumps sharing
  one, a little either way, so the lawn reads as a painter's strokes of one green and its
  average stays one colour; never a single dyed green, which reads as plastic, and never every
  blade and clump its own value and height, which from the island view grains the lawn into a
  scatter of tufts over dark ground. The materials keep albedos within real ones: the meadow's
  blades a sunlit leaf's ([Look values](../reference/look-values.md)), the cliff's stone a little
  lighter (The look, above); the frame's brightness is the exposure's, never albedos pushed past
  real ones. One grass colour, a bright, fresh, natural green, matte with only a faint gloss (no
  pale sheen over the blades, which reads as plastic): the gaps between blades a deep, cooler green
  (never near black) under tips that stand out lighter and yellow-green where the sun shines through
  them; under a closed sky the lawn keeps its green, the sky's light having passed among the blades,
  and does not turn yellow when the sun goes in; looking toward the sun the whole lawn glows, away
  from it it is plainer and greener; no fields of tone, dryness or bare earth (they break the lawn
  into what reads from the island view as camouflage and dark blotches), and no pattern of dots on the
  blades. The island top is one sward, about 0.5 m, with no zones across it: never tiers of height
  and tint by the soil (a short yellow-green band along the windward coast, a taller, deeper grass
  on deep soil, gravel patches inland), which read from above as a map laid over the meadow. Its
  layering comes from the grass itself, which grows in clumps about a metre across, each a little
  taller or shorter than its neighbours, giving its blades their lean and its stroke its colour. Its
  height swings gently: patches a few metres across over broad swells, a short turf here and a
  taller sward there, running into each other blade by blade: from above a soft mottling, never a
  zone, a line, a path or a hollow (a short turf walled by tall grass, two levels, reads as a hole
  dug into the lawn). From the ground up the sward has a meadow's layers: dead leaves and the old
  leaves' straw sheaths low in it and the green leaves over them; no flowering stems stand over it.
  No low herbs grow under it (clover mats, plantain rosettes): from the island view they do not
  read. The sward runs to the edge on every coast, windward and lee alike, never a windward lip
  shown short, yellow, thin over gravel and bared to the cliff's stone, which reads from above as
  one more zone. Inside the grass the shade is the grass's own, never painted: the blades and clumps
  toward the sun shade those behind them and the ground under and beside them, softly, as light
  passes between blades, darkening toward the ground (a deep green, never black); the shade of
  anything standing on it lies soft and light. The only large shadows that cross the meadow are the
  real clouds' (from the cloud layer overhead, drifting with it): no patches painted or animated
  onto the island to vary its light. The ground between the blades is a grass-coloured ground, near
  and far alike: about the blades' own mean albedo (a twentieth above it), a little warmer, in the
  lawn's tone, softly mottled over 1 - 3 m and grained by a scanned ground's value (about +-15 % in
  all), without the scan's colour. The blades thin with distance, and a ground of their own colour
  lets them thin with no ring of another colour sliding with the camera and no flat green either;
  brown earth shows only where the sward truly parts, a near detail on a few edges. The same grass
  ground runs on under the bamboo culms; the groves' own floor is their litter (see the bamboo
  below). Never a ground mapped from above on the lip's bevel (it runs down the slope in stripes).
  The short turf is a closed mat, as a wind-cropped or shallow-soil turf is: its leaves splayed out
  over the ground, its base olive with thatch and only flecks of earth, so from every view and at
  every zoom the meadow is one dense sward, a little yellower where it is short; bare earth only in
  its few gaps, never thin grass over brown ground, and never a ground that changes colour as the
  camera zooms. At the lip the turf ends on its soil over the stone, never a dark hole among the
  flowers. By night: see Night. Toward a sheltered coast the grass runs to the lip and stands there,
  and the same grass grows out over it: its tufts at the lip spill over the edge, fine blades that
  arch over and hang down the wall, lying on the stone, never through it, and the lip alternates
  between overgrown stretches and cut-open root soil.
- The flowers are off for now (`?flowers` brings them back): Penglai's bamboo grows over the whole
  island, and whether its meadow keeps flowers among the groves is still open. As they were made:
- Flowers are part of the meadow, and they are Penglai's, after the texts on the immortals'
  islands, not a generic island's: whole plants among the grass, never heads floating over it. The
  yaoxiang (遙香草, Shiyi ji: "flowers like cinnabar, leaves narrow and white, like the day lily") is
  a day lily's clump: a fountain of narrow, pale silvery leaves and two to four scapes over the
  sward, each holding cinnabar trumpets out at a slant, each its own way, dark in the throat, with
  buds, a closed trumpet or a spent flower among them; the zhuyu (祝餘, Shanhai jing: "like chives,
  with blue-green flowers") is a chive's clump of dark blue-green leaves under round heads of sky
  blue star florets, loose enough to see the stars, just over the sward, with tight pale buds and
  half-open heads among them. The plants differ: taller and shorter scapes (some heads held low
  among the blades and shaded with them), larger and smaller flowers, a little apart in colour.
  They are all in flower at once, the year round: the island's sign of an immortals' land.
- They grow in swaths of one kind as if painted by a broad
  brush; ours are some 6 m across, spread evenly over the island top, and from the island view each
  swath is one stroke of colour on the lawn, cinnabar or sky blue, its flowers covering about a
  third of its middle (the green showing between them) and thinning at its rim; a few single plants
  between the swaths. Each swath's kind is its ground's: the zhuyu in the exposed coast's
  wind-cropped turf, the shallow pockets and on dry ground (among shorter grass), the yaoxiang over
  the rest of the meadow, most in the sheltered sward. None on the lip itself and none in the
  bamboo's groves or their shade (flowers there draw dull). Flowers scattered as small drifts or
  single heads read from the island view as specks or confetti, never as the island's colour. They
  are lit as the meadow is, darker low among the blades and lighter at the top, and never brighter
  than the sunlit grass tips: a flower that outshines the lawn reads as lit from within. They sway
  with the grass.
- A herb of the sunken mountain Yuanjiao grows in the meadow: the yunpeng (芸蓬, Shiyi ji: "white
  as snow, a stem two zhang long, at night it gives a white light"), single clumps of straight white
  stalks far apart (at least about 13 m) on the open meadow, out of the bamboo's groves and their
  litter and in from the cliff's edge, an accent and never a stand: about ten on a grown island,
  and maybe none on the starting island, whose meadow is small. Its glow by night stays a soft
  white that lights the ground round a clump, never a lamp; a drift of such clumps would hide the
  islanders by night.
- Penglai's own bamboo (浮筠之簳, Shiyi ji: "green leaves, purple stems, seeds as big as pearls") grows
  over the whole island as a running bamboo left to itself takes a hillside: in groves of even
  height whose edges run out in lobes, single culms ahead of them on the open meadow, and glades of
  meadow between, never one round crown nor a closed forest. No placement rule: it stands at the
  cliff's edge as anywhere else. Its culms are tall and slender, bare to about half their height,
  their leaves narrow and in loose drooping layers, so the culms show from above between them. Its
  stems are a mid to dark green, one family with its leaves and the meadow and most of the time
  darker than the crowns, and a minority of old culms turn a dim dusty purple at the same lightness,
  so the purple of the old text shows up close and the grove still reads as one green, by its light
  and shade. Its leaves are nearly as matte as the meadow's blades: no pale sheen over a crown,
  whose lit leaves stay a plain green and whose depth stays dark, the inner leaves of a shoot and
  the shoots deep in a grove darker. Under a sun more than a few degrees up, a crown's shaded leaves
  still take a share of it through the leaves above, so its dark side reads green rather than as
  dark and as blue as the sky; at a sun on the horizon, under a closed sky and by night they take
  none. A leaf lit from behind glows on its own colour, so a grove seen against the sun has no black
  side. Under a closed sky the crowns keep their green as the lawn does, a dark, rich green, the
  sky's light having passed through and off their leaves; at a low sun they take its warm colour
  instead. A grove is dark inside, its canopy hiding most of the sky from its floor, its culms lit
  where the sun finds them. Its floor is the meadow's grass up to a couple of metres inside the culm
  line, then clearings of fallen leaves, about half of the floor where a grove is deep, with ragged
  edges about a metre across, a few stray tufts of grass left in them, and small bare discs under
  its clusters of young shoots. The litter is paler than the grass ground (about a third brighter)
  and nearly neutral, a brownish grey with the grain of leaves and twigs, never a dark brown;
  patches of a low blue-green groundcover, a metre to a few across, lie on about a seventh of it.
  The grass does not shorten toward a clearing: it stops at the litter's edge at its full height.
- Besides these, the terrain plants the meadow (grass, and the flowers when they are on) and its
  turf over the rim, and no shrub or tree: the island is a low, rolling top ringed by cliffs, with
  no lee where they would grow. The walker's loop stays open meadow. Plants that matter to play are
  content placed in the world, not terrain.
- All vegetation moves in one wind: gusts visibly sweep the meadow and change as they go; still air
  is the rest pose. The wind turns with the weather and has levels (light, gentle, fresh, strong;
  gentle most of the time, fresh at times, light or strong rarely), coming mostly from within
  40 degrees of the prevailing wind and now and then from the opposite side; the landscape keeps
  the prevailing wind (the meadow's exposure).

## Life

- The island's life, in the sea, on the island and over both, is the life of Penglai and the other
  mountains of the immortals as the old texts describe it (the Liezi, the Shiji, the Shanhaijing,
  Wang Jia's Shiyi ji and their like), never a generic animal added for liveliness (a crab, or a
  gull for its own sake). Each creature is a real species in body, gait and habitat, with one or
  two departures from life, as the texts themselves make them: the Shanhaijing's wenyao is a
  flying fish with a white head, a red beak and a bird's wings, and it flies by night; the Liezi's
  trees are trees whose flowers and fruit are pearl and jade. There is no creature of the texts
  alone, with no living model. Fantasy plants follow the same rule.
- Each has a reason the world gives. It lives where its real species would: a turtle on the
  seagrass it grazes, a clam in the sunlit shallows its algae need. Its numbers follow the extent
  of that habitat (the coast's length, the shallows' or the meadow's area), and nothing is placed
  by hand.
- The island's own birds and beasts are white: real species in white plumage or coat ("its birds
  and beasts are all pure white", the Liezi; "its creatures, birds and beasts, are all white", the
  Shiji). Visitors from elsewhere (the jingwei from the western mountains, the wenyao from the
  western sea) and the creatures of the sea keep their own colours.
- Creatures belong to nature, so they are shaded as realistically as the plants, never stylised
  like the islanders. From the island view they read by silhouette and motion: a flock wheeling
  overhead, a tall bird standing at the water's edge, a large shadow gliding through the clear
  shallows, a school breaking the surface. A small creature of the texts is made larger than life
  where that view would lose it.
- No beings of human form (the jiaoren), no herds of phoenixes and qilin, and no dragons but the
  bones they shed (as on Fangzhang in the Shiyi ji), which read as rock, like a whale's fossil
  ribs. Any of these would turn the photograph into an illustrated myth.
- The cast the texts give so far:
  - In the shallows: the shen, giant clams with blue-green and gold mantles in sunlit water one to
    five metres deep (in the Liji the pheasant "enters the great water and becomes a shen"). On a
    calm, warm afternoon the mirage over the sea is its breath ("by the sea the shen's breath
    forms towers", the Shiji), drawn as a real mirage, a stretched and doubled horizon, never a
    palace painted on the sky. The young ao, green turtles, graze the seagrass meadows; the great
    ao that hold the islands up in the Liezi are the island's story, never seen whole. The luobu,
    Penglai's own great sea snail in the Shiyi ji, crawls out of its shell and carries it on its
    back over the cobbles at the cliff's foot while it is warm, and draws back in when it cools.
  - In deep water: the great fish of Yingzhou, "a thousand zhang long, spotted, with a horn on its
    snout, dancing and playing in schools" (the Shiyi ji), a whale shark with a horn: now and then
    a vast spotted shadow passing beyond the shelf's edge.
  - On the sea: the wenyao, flying fish in schools that break from the swell offshore and glide,
    by night as by day.
  - Over the island and its coast: Penglai's own birds in the Shiyi ji. The yuanyang ("like a wild
    goose, it wheels among the clouds, roosts on high peaks, and its feet never tread the ground";
    not the mandarin duck) is a white skein of geese circling the island high up, never landing.
    The honge ("coloured like a swan, shaped like an adjutant stork, with no gut, its feathers
    growing from the bone") is a gaunt white stork that never feeds, standing still at the water's
    edge below the cliffs. The ou of the Liezi, white gulls and terns, settle beside islanders
    without guile and only dance overhead when one schemes. Now and then a jingwei, a crow-like
    bird with a patterned head, a white beak and red feet, flies in from the west and drops a
    pebble into the sea (the Shanhaijing).
  - On the island: the xiushi of Yingzhou ("shaped like a qilin, it eats no living plant, drinks
    no muddy water, and smells gold and jade in stones", the Shiyi ji), a white deer that noses
    the stones rather than grazing.

## Sea, sky and weather

- Rain, storm and fog are parked (`PARKED_WEATHER` in `src/sky/Weather.ts`): out of the rotation
  and the production page until the game needs them; the notes on them below stand for their
  revival.
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
- The water is sea water with measured optics: clear open-ocean water with a little phytoplankton
  (the amount: [Look values](../reference/look-values.md)), which takes the red out within a few
  metres and the green and blue over tens. Its colour follows from that and the light on it, with no
  colour of its own laid on: the open, deep water is a deep blue, the light its body scatters back
  under the reflection of the sky; over the shallows the floor shows through, its sand, seagrass and
  stone dimmed and turned bluer by the water over it, the more the deeper it lies, with no bright
  rim round the island. Under cloud the sea reflects the deck's grey and its body dims with the
  deck's light; where a gap in the cloud lets the sun through, its glint on the waves lies on the
  sea as a silver sheen, the same reflection of the sun as on a clear day, spread by the waves'
  slopes. At sunset the reflection takes the low sky's colour. A calm lee stands level with the sea
  round it. It stays clear to the floor in everyday weather: the stones and the seagrass's edges
  show through the water down to several metres, which wobbles them but never breaks them into
  crumbs, and the calm water carries no film of foam. The water softens the floor as real water
  does: the sand's ripples hold near the shore, finer detail goes soft from a few metres down the
  slant of the view, and past some ten metres only the floor's large shapes remain (rock against
  sand, the seagrass's patches), never glass over a sharp floor at any depth. Under a deck the water
  body takes the sky's light as the surface reflects it.
- One dominant key light, sun by day and moon by night. By day the sun is near white and the air
  hazy: the horizon reads milky white rather than a cyan band, brightest toward the sun. The
  sun's light warms from about 20 degrees, turns orange by 10 and orange red near the horizon.
  After sunset the island stays readable: through the minutes between the sun's last light and the
  moon's, the meadow goes down with the light (warm under the afterglow, then green) and settles
  into the night without a dip or a lift: it is never brighter at a lower sun, and the night's light
  comes in only as fast as the twilight's leaves, so the night is the twilight's end. The light that
  holds it up is the sky's own, raised for the island alone, and only the evening's is warm: at dawn
  the land goes from the night's blue into the day with no warm stretch. Through the twilight the
  land goes a little dark and hands over to the moonlit night, the open sea darker than the land
  before the night lifts it. The moon is drawn at about five times its true size (some 2.6 degrees
  across), so it reads as the night's light source; it is no brighter per unit of sky for it, and
  the moonlight on the island keeps its level. The day cycle is authored, not astronomical.
- The sunlit ground lights what stands over it from below, one bounce for every lit surface: the
  shallows the cliff's walls, faintly, the meadow the islanders' undersides; strongest around
  midday.
- Bad weather dims and desaturates the existing light and thickens the air as its visibility
  falls, and it stays dimmer and greyer than a clear day.
- A change of weather moves the whole sky together: the cover grows or thins everywhere at once, the
  clouds flattening or heaping and their layer sinking or rising with it, never one sky swept over
  another along a line. The clouds drift downwind with the wind aloft, faster than the surface wind
  (the cumulus and the thin layer about twice it), so they never move against the grass and the sea.
- Every sky's clouds are one kind of cloud, heaped or flat by the weather, and they stand where such
  clouds stand: the clear and fair skies' cumulus from about 4 km up, cloudy's broken layer of
  flatter heaps from about 1.5 km to 4.5 km, with blue between them, and overcast's closed deck low,
  its base under a kilometre and its tops near 3 km, so its masses are near and wide overhead and
  close into a flat, packed floor toward the horizon, seen through little of the air's haze. The
  deck's base is lit by what comes down through it, the light on its tops passed through the cloud
  above, with no gain or tint of its own: thin parts show lighter than the thick masses beside them,
  and the deck reads near grey. The air under it is lit by the deck and by the sea's reflection of
  it rather than by a clear sky, so the haze in front of the clouds is their grey. The clear and
  fair skies' cumulus are lit the same way under their tops: a shaded base takes the light the cloud
  above passes down to it, so it reads a soft grey about a stop under the sunlit tops and near the
  blue sky beside it, never a dark block.
- Under a deck the land is lit by a softened key along the sun and by the deck's sky light, under
  overcast a sky light of its own, stronger than the sea's. Under overcast the closed deck reads
  lighter than the meadow under it, lighter still toward the sun, where the lit cloud about the
  sun's place glows broad and soft, and graded more flatly from the zenith to the horizon than the
  standard overcast sky's 3 : 1 (the lightness of deck and meadow:
  [Look values](../reference/look-values.md)); the land takes its light from the sun's side of the
  deck as the deck shows it. The sky's lightness changes little between a sun at 15 degrees and one
  at 22. With the sun high the deck passes on little of a clear sky's blue, so the light lent to
  the land is a warm grey. A cloudy sky's deck lets go as the sun falls under about 6 degrees: by 3
  the low sun shines under the broken deck and the view's own light sets the exposure, so a cloudy
  evening comes on by degrees: dark at sunset, neither black nor lit yellow, the meadow never
  brighter at a lower sun but where the cloud opens for a moment. Overcast is a closed, dark deck
  at every sun height, morning and evening alike: it does not break up at a low sun, and its light
  leaves only with the sun's own, over the twilight: the land under it keeps the deck's soft light
  through sunset, with no flash of the setting beam on the slopes toward it, and goes down into the
  night as the deck's light does. Its sky is brightest about the sun's place and dim looking away,
  light near the sun, a near-neutral pale grey there, and a dark blue-green grey away from it; the
  meadow under it a quieter green, its most brightly lit grass muted toward grey. The land under it
  is lit soft: the deck's sky light from every side, its glow about the sun's place included,
  lifted well over a cloudy day's. Under the water the floor takes that light as the water column
  passes it down, so the shallows' floor is lit by the same deck, dimmed by the water above it the
  deeper it lies. The sun reaches it only through the deck: none under its rolls, and where a
  thinned region of the deck lies along the sun, a share of it in large patches that move with the
  deck, which adds a few per cent to the meadow and draws the faint shadows of everything taller
  than the meadow; the meadow does not shade itself in it, so the sward's own shade is the one the
  sky light finds under its canopy, while the bamboo, the stones and the bare ground keep their
  contact shade.
- Clear and fair skies hold a thin layer of silky fibres about 8.5 km up, combed along the wind
  aloft and gathered in patches with blue sky between them, closing up toward the horizon in
  perspective. The fibres bend and hook, run thick and thin along their length and fray at their
  ends, and lie at two scales turned against each other, so they are neither ruled lines nor
  strokes of even width and no two run quite parallel. The patches stay apart: toward the horizon
  the layer thins as its fibres blur together, so even toward a low sun the sky a few degrees over
  the horizon stays clear, with no bright sheet round the sun. Under a high sun the layer is faint
  and white, a little lighter than the sky round it (a few hundredths of Oklab lightness at most),
  never what the eye goes to first; the cumulus is drawn over it, and cloudy and overcast skies
  have none. Under a low sun, morning and evening alike, the light it takes straight from the sun
  is warm and the light it takes from the sky round it cool, so it reads rose on both sides of
  the sky, toward the sun and away from it, a little more saturated and a little lighter than the
  sky beside it rather than a pale yellow-white; it turns back to white as the sun climbs past
  about 30 degrees. Each part of it is lit by the sun as it stands over that part, so after sunset
  and before sunrise the side away from the sun goes out first, with the sun about 1.5 degrees under
  the horizon, and the side toward it last, near 3 degrees under, warmest just before it goes.
- The sky's light takes a gain of its own by the sun's height, the rising sun's apart from the
  setting sun's. Through sunset it runs from the golden hour's warm key into a dusk key, more
  orange still, at a sun 1 degree under the horizon, then moves on to the night key by -6 degrees:
  the glow stands low in the west after the sun has gone and is the brightest thing in the picture.
  The morning is not the evening turned round: its key is near grey, its display white cold, so
  the sky, the water and the shaded rock are blue together at sunrise, and only a face turned to
  the sun takes a warm colour, a pale one. On a clear morning the night goes early: with the sun
  still 7 degrees under the horizon the air is already blue over one thin pink band, and the sea a
  clear blue under it. Where the gain colours the sky it decides. Beyond it, no
  painted pink, magenta or deep-blue twilight, which dyes the sea one flat colour and reads as a
  filter; twilight's mood comes from the light on the island.
- Rain is light streaks and ripples on the water. Wetness darkens rock and plants within small
  limits and glosses bare stone; water runs down the cliffs in sparse darker runnels; puddles fill
  fixed hollows and read as water from above.

## Night

- The night takes the day's curve and grade under the moon's own light: its key from one side,
  its shade drawn up a little (as an eye adapted to the dark sees it), so the moonlit meadow still
  shows its clumps' lit and shaded sides as the day does. The night is cool: as the rods take over
  from the cones, dark colours come up and turn blue (the Purkinje shift), but the blue belongs to
  the sky and the sea: the land under them goes dark and quiet, far less saturated than they are,
  the meadow a very dark, quiet green with a hint of cool, never black, the rock a cool grey that
  catches the moon and stands as the brightest thing on the island. Its exposure keeps the moonlit
  island readable and the moon's path on the sea crisp, and that path is pale: the moon's blue stays
  in the water and the sky, which meet level only far out, where the sea reflects the sky as drawn,
  and it never flashes off the glint.
- The night sky as drawn stands below the light it sheds, by a number of stops each weather sets
  (`seenNight` in `src/sky/Weather.ts`): the moonlit sky and its clouds read dark over the island,
  while the land, the near sea and the near air keep the light the sky gives them. The far sea
  and the far air meet the drawn sky at the horizon, and the exposure is set by the light, not by
  the darker sky. Every night has its moon, up from dusk to dawn: the phase shows only on the drawn
  moon and never darkens the night.
- The island reads by moonlight and starlight; the twilight falls into the night with no step
  back up, under every sky. The moon takes over the key soon after the sun has gone.
- The moon stands fixed in the sky, 20 degrees up on the noon meridian, all night and every night
  (`src/sky/DayCycle.ts` MOON). Seen from the island view its light comes in at a slant: slopes
  show a lit and a shaded side, its shadows run long and the sea carries a moon path, where a moon
  near the zenith would light the island flat. The moon path and the moonlit meadow glow softly in
  that view too. It neither rises nor sets, so the night's composition holds while the game is
  played. The moon is drawn where the island takes its light from, and the glow of the air around it
  comes from there too, so the disk, its glow and the light on the land stand together.
- Under the moon, stone, sand and skin stay apart from the meadow and from each other in tone.
- The stars and Milky Way are the real sky as seen from 38 degrees south (the latitude the sun's
  path is set at) at a sidereal time of 14h, fixed: they neither turn through the night nor drift
  over the year, so the night's composition holds, with the Milky Way rising out of the sea in the
  horizon view (`src/sky/DayCycle.ts` STARS). They are points with a natural spread of brightness,
  below white except the brightest few; only those near the horizon scintillate.

## Islanders

- The people of 含明, west of Penglai, who stitch birds' feathers into clothes and drink the dew
  (拾遗记 卷十). Their gear covers what a figure cannot do well, as Frostpunk's winter clothes do:
  a woven bamboo hat (笠: the pointed 斗笠 and the flat crowned 箬笠) over a head with no hair and
  no worked face, in the brim's shade.
- White feathers stitched into a short-sleeved top worn open over the bare chest and belly and
  into shorts to mid-thigh, bare arms and legs, straw sandals: little cloth, as on an island short
  of everything. No sash or headcloth (a headcloth reads as a bandit's).
- The feathers must read as feathers up close (cards cut from a photograph, laid in overlapping
  rows as a feather cloak's are), or they are not worn; the clothes keep no finer detail. From the
  game's default distance the figure reads by colour and silhouette (straw disc, white top and
  shorts, skin), the feathers' and weave's texture from the closest zoom.
- Realistic, lit by the island's own light (no cel steps, no outlines), about 6.5 heads tall
  (`real` in `src/characters/Proportions.ts`).
- Built in Blender on the kit's rig and clips, never modelled in code. The kit-dressed
  islander (pointed ears, linen shirt, cel steps, the medium build) stays selectable (`look=kit`).
