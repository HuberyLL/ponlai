# Ponlai: art direction

The look the user chose and what to avoid. It says what the scene must look like, not how the code
gets there: each module's header comment holds its own rules and reasons. Change this file when an
art decision changes; images from elsewhere stay out of the repository.

## The look

- A small island in an open sea, a visual sample for a game, fantasy-realistic,
  inspired by the eastern aesthetic of Ghost of Tsushima: a calm, painterly light, restrained
  colour, and wide fields of grass and flowers that move together in the wind. The fantasy lives
  in the world (the island, its everlasting flowers, its creatures from the old texts, later the
  sea's glow at night) and in a light touch on the image, the airy feel of an immortals' island
  (Penglai). Deep clear water over pale shallows with a sparkling glare toward the sun, chunky
  chiselled stone, a lush meadow with wildflowers, and grass hanging over the rim. Keep the lower
  cliff stone exposed.
- The light and the image are photographic, as real as tidewater's (its water, its light under
  the water): the scene is lit by the sun or moon, the sky and the sunlight the ground bounces up.
  The frame is developed in stages: a local tone mapping keeps a bright
  sea, glare or sky from burning out and greying while the land keeps its level (by day only what
  lies well over the lit ground is drawn toward it; under a low sun the land is drawn up as well,
  the more the darker its surroundings; the detail is kept); the shade's contrast, deepened under a
  pivot so the shade stays solid under the soft curve (over the lit ground by day; a quarter of a
  stop under mid grey under a low sun, where the long shadows take the most, and gently under clouds
  and by night); a soft filmic curve (gentle in the shadows and midtones,
  with a long shoulder and a long toe, which deep in the dark halves the screen's level every
  two stops, keeping the shade's gradations, and still reaches black, with no floor veiling the
  darks; its contrast, shoulder, white and toe adjustable; no saturation of its own, which the
  grade's hue bands set)
  whose working space keeps a low sun's reds from turning yellow; a white balance given as the colour white becomes, by the time and the weather (a clear
  day cool from noon to a low sun, against the sun's warmth, so sunlit rock reads a pale neutral, the
  meadow keeps its green and the sky and the sea stay blue, while the shade stays the colour of what
  stands in it, never blue; the golden hour a little warm, the clouded
  skies and the night cool); a bloom only on what is truly bright (the sun's
  glints on the sea, the sun, a moonlit path), never a veil over the whole frame, and next to none
  under a clouded sky; a vignette that darkens only the corners, and no grain; and two grade
  tables, generated from a grade's
  parameters, that a look can blend between by time of day or place (the first holds the day's
  grade: no contrast or saturation over the whole frame, each hue moved lightly on its own, the
  warm hues and the sky's blue a little richer, the green a touch quieter and turned a little toward yellow against the cool white balance, the sea's
  blue-green a little bluer, the red flowers' colour kept against the cool white and the
  highlights a touch cool; the second is the identity). The exposure lets the frame darken as the
  sun sinks, so a low sun reads as a low sun. The local tone mapping, the curve's working space,
  the white balance and the grade tables are techniques Patry presented (SIGGRAPH 2021); the
  curve's toe, the shade's contrast, the vignette, the bloom and
  the blend of two tables are ours.
- The light keeps the sun's and the sky's own balance, by day and by night, so that the land shows
  where the light comes from: a stone or a figure has a lit side and a shaded one, and its shade
  falls on what lies beside it; the meadow shows it in its slopes, in the light through its blades
  and in the sheen a gust sweeps over it. Nothing lifts the shade toward the light: an
  extra share of sky light on the island (a "clear shade"), a grade tone that softened the
  contrast and recoloured the lights and the shade, a low sun's recolouring and a film's day for
  night were all tried and taken off, because together with the meadow's own soft light they left
  a shaded clump within a quarter of a lit one's brightness (on a clear day the shade on flat
  ground holds about a tenth to a thirteenth of the lit ground's light at noon, about an eighth
  in the afternoon and a third to a sixth under a low sun: the higher the sun, the harder the
  contrast) and the meadow read as lit by an overcast sky. The
  frame's brightness comes from the exposure, which keeps the ratio between light and shade.
- The shade is lit by the sky the island lets through (the ambient volume, which sees the land,
  its groves and its cliffs: `src/lighting/AmbientSample.ts`). At noon on a clear or fair day the
  open meadow's lit side is about 3 to 4.5 times its shade; a low sun's lit side comes down toward
  its shade, and that is left as it is. A grove's floor in shade should read about half the open
  shade at its edge, darker deeper in. Its culms in shade stand a little darker than the crowns
  over them, dark green stems against the light between, and the faces toward the grove's open
  sides read lighter than those toward its inside. Where a culm or a stone meets the ground the
  contact darkens by a tenth at most, gone within about a metre: a grounding, never a dark ring. Where
  the grass, the culms and the ground's relief close the sky, the shade loses some of its light
  broadly, over metres (the screen-space ambient occlusion, on in high: `src/post/GTAO.ts`, and
  at the turf's roots the share of the sky its blades leave): the ground among the grass in shade
  about a quarter to a third darker than without that loss, a grove's floor about a fifth, a
  culm's sides a little, lit surfaces not at all. The ambient light is set for the shade with
  that loss in it, never pressed down once more for it, and a loss two terms estimate counts
  once (the turf takes the stronger of the two).
- The air is a lit medium, a volumetric haze: haze and mist are one volume
  of air, lit by the sun and the sky and cut by every shadow, thin and layered by height, never a
  flat tint laid over the frame for an airy feel (that reads as smog). Its density follows what the
  weather lets one see, and it is coloured: a clear day's air is a blue layer whose light falls to
  half in about 2 km at the game's camera height, the blue lost first (within a kilometre less than
  half of it gets through, three kilometres off almost none), so far sea and land turn blue-grey and
  the low sun's light reddens; a cloudy sky's air is grey and about as thick. It lies as a ground
  layer with a soft top tens of metres up: the hills rise out of it, the camera stands in its upper
  half, and the distant haze thins slowly with height. From the game's
  views the island keeps its colour (at least nine tenths of its light reaches the camera by day,
  the air of the first few hundred metres thin under every kept sky, so the shade stays the land's
  own colour and no veil of the sky's light lies over the island)
  and the haze gathers with distance toward the horizon. The far sea and the low sky end in the same
  haze: a milky band, brighter than the sky above it, closes over the horizon with no step or dark
  line where sea meets sky, and fades by 10 - 15 degrees up. Across from the sun
  the haze lifts the atmosphere's dim low sky (about twice); beside the sun it is flatter than the
  atmosphere's own glow and dims it a little. The air follows the hour more than anything else: clear before dawn; on calm, dry
  mornings a mist as the sun comes up, a soft low layer over the whole island that the camera
  stands in (never a sheet on the sea), near neutral, its band over the horizon a few times as
  bright as the lit grass in front of it, gone once the sun is 7 degrees up; coloured and even
  through the day; thick and fully orange at the golden hour, yet paler than the lit ground;
  thinner after sunset; a visible grey-blue layer by night. A cloudy day's air keeps less colour
  and shows brighter than a clear day's (about twice with the sun 25 degrees up). It lies over the
  land, the sea and the low sky alike; the light the sky lends the scene is the atmosphere's alone.
  Shafts show only where the
  air is thick enough and lit from the side or behind against darker ground, the haze's own
  (strongest in the morning mist and at the golden hour, faint at a clear noon); no rays are
  painted over the sky. The sun's disk is drawn larger than life (1.1 degrees), softly
  limb-darkened, its edge clean; round it a soft glow sized by the frame, not the field of view, near white at its core and fading
  as the square of the distance past half the frame, with no streaks, ghosts or rings. It weakens
  with the share of the disk left uncovered yet stays wide through a gap in leaves, goes with the
  disk when the sun leaves the frame, and is weaker against the bright sky round a low sun. Mist also gathers in bright banks and
  wisps round the island and the cliff's foot (not drawn yet).
- Real phenomena are not exaggerated; no glow round every highlight, and no hue turned further
  than a few degrees (the grade turns no hue more than 7 degrees).
- The exposure is metered from the light falling on what the frame shows, not the light leaving it,
  so a dark meadow or sea is not brightened toward grey; by day the sky weighs into the meter, most
  of all under a high sun, and the frame's brightest few percent hold it down, which darkens a view
  toward a low sun against one away from it. The frame darkens with the light: a clear noon shows a
  sunlit grey card on level ground at a screen code of about 0.70 to 0.75 (its open shade near
  0.15), and as the sun goes down the card goes down with it, the more the lower the sun, so a low
  sun reads as a low sun (in the golden hour, with the sun at 3 degrees, a sunlit cliff is orange
  with deep brown shade, a stop or more under its light, and the sky over it a shade redder and
  dimmer, not a yellow-gold face under a pale sky); the deep night shows a
  moonlit grey card at a green code of about 0.1 to 0.2, and holds its exposure whatever the moon. A
  clouded sky is metered by the view's own light: in the view of the whole island the ground shows
  about a stop under a clear day's sunlit ground at the same hour, on a cloudy and an overcast
  day alike, and other views lie within about half a stop of that. Under cloud the land takes about
  four times a clear day's share of the sky's light, so it stands in soft daylight under a pale sky
  rather than as a dim island under a bright one, lit to shaded about 2 to 4. A sun in the frame
  may read a little brighter than its eye-adapting exposure would show it. The night keeps the
  moonlit island readable (see Night).
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
  limestone so that the exposure set for the meadow leaves it below the curve's shoulder, but
  lighter than the meadow's albedo (about one and a half times it), so a face lit from the side
  stands out from the grass as a pale cliff rather than a dark band. A wall
  over bright shallows takes their teal light from below.

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
  (docs/game-design.md, "How the island grows"): its coast always irregular and natural, never
  drifting toward a square or a circle. Its top is a plateau that rolls as an old meadow does:
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
  the cliff's foot, then a belt of clean sand whose ripples, a hand's width apart, run along the
  coast, and seagrass only below the swell's reach (from about 3.5 m down), in meadows tens of
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
  passes into the cliff through grass growing from the lip and hanging over it as one fringe, as on a sea cliff's top: dense, short,
  nearly parallel bundles of the meadow's blades (mostly 0.15 - 0.5 m, a few to 0.8 m), each
  bent by its own weight into one smooth arc (stiff at the root, soft at the tip: long blades
  arc over and hang, short ones only bend), lying on the stone where they meet
  it, combed to one side, drier and yellower than the meadow, in stretches with clumps and
  thin places, fewer where bare stone meets the meadow. Not fans of long blades like small palm
  leaves. What hangs over the rim is the
  meadow's own grass, not leafy branches; the lowest quarter of the cliff above the sea stays bare.
- The meadow is one even sward: from the game's view a uniform
  carpet of grass with only soft, broad changes over it, never a field of tussocks or lumps. Close
  up it is dense, long, sword-shaped blades, wide to high up and tapering to a point, arcing over
  under their weight, each a little taller or shorter, turned and leaning its own way, so they
  cross rather than look combed. The grass is grouped into clumps that share their height, lean
  and colour and differ from each other only a little (a tenth of the height either way), so the
  field is not a mown lawn and the wind moves it in broad sweeps but never combs it flat as one
  pile; clumps grown as visible mounds (a quarter of them half again as tall, leaning out, each lit
  on one side and shaded on the other) drew the island top as a field of lumps. Each blade reads
  as a rounded leaf, its light turning across its width (a short one folded into two leaves), and
  only a little apart from its neighbours in value and colour; the colour (fresh green, yellow green,
  olive, a few dry leaves) changes from stroke to stroke, a few clumps sharing one, a little either
  way, so the lawn reads as a painter's strokes of one green and its
  average stays one colour; never a single dyed green, which reads as plastic, and never every
  blade and clump its own value and height, which from the game's view grains the lawn into a
  scatter of tufts over dark ground.
  The materials keep albedos within real ones: the meadow's blades a sunlit leaf's
  (about 0.08), the cliff's stone about twice the grass, the trees' leaves about a fifth lighter
  than the grass as painted and a little darker than it as a crown draws them, its inner leaves
  greyed, so a crown stands a little under the sward's value; the frame's brightness is the
  exposure's, never albedos pushed past real ones. A tree's leaves are as matte as the blades:
  no pale sheen over a crown, whose lit leaves stay a plain green and whose depth stays dark.
  One grass colour, a bright, fresh, natural green, matte with only a faint gloss (no pale sheen
  over the blades, which reads as plastic): the gaps between blades a deep, cooler green (never
  near black) under tips that stand out lighter and yellow-green where the sun shines through
  them; looking toward the sun the whole lawn glows, away from it it is plainer and greener; no
  fields of tone, dryness or bare earth (they broke the lawn into what read from the overview as
  camouflage and dark blotches), and no pattern of dots on the blades. The island top is one
  sward, about 0.5 m, with no zones across it: tiers of height and tint by the soil (a short
  yellow-green band along the windward coast, a taller, deeper grass on deep soil, gravel patches
  inland) read from above as a map laid over the meadow. Its layering comes from the grass itself,
  which grows in clumps about a metre across, each a little taller or shorter than its neighbours,
  giving its blades their lean and its stroke its colour. Its height swings gently: patches a few
  metres across over broad swells, a short turf here and a taller sward there, running into each
  other blade by blade: from above a soft mottling, never a zone, a line, a path or a hollow (a
  short turf walled by tall grass, two levels, read as a hole dug into the lawn).
  From the ground up the sward has a meadow's layers: dead leaves and the old leaves' straw sheaths
  low in it and the green leaves over them; no flowering stems stand over it. No low herbs grow
  under it (clover mats and plantain rosettes were tried: from the game's view they did not read).
  The sward runs to the edge on
  every coast, windward and lee alike: a windward lip shown short, yellow, thin over gravel and
  bared to the cliff's stone read from above as one more zone. Inside the grass the shade is the
  grass's own, never painted: the blades and clumps toward the sun shade those behind them and the
  ground under and beside them, softly, as light passes between blades, darkening toward the
  ground (a deep green, never black); the shade of anything standing on it lies soft and light.
  The only large shadows that cross the meadow are the real clouds' (from the cloud layer
  overhead, drifting with it): no patches painted or animated onto the island to vary its light.
  The ground between the blades is a grass-coloured ground, near and far alike: about the blades'
  own mean albedo (a twentieth above it), a little warmer, in the lawn's tone, softly mottled over
  1 - 3 m and grained by a scanned ground's value (about +-15 % in all), without the scan's colour.
  The blades thin with distance, and a ground of their own colour lets them thin with no ring of
  another colour sliding with the camera and no flat green either; brown earth shows only where
  the sward truly parts, a near detail on a few edges. The same grass ground runs on under the
  bamboo culms; the groves' own floor is their litter (see the bamboo below). Never a ground mapped
  from above on the lip's bevel (it ran down the slope in
  stripes). The short turf is a closed mat, as a wind-cropped or shallow-soil turf is: its
  leaves splayed out over the ground, its base olive with thatch and only flecks of earth, so from
  every view and at every zoom the meadow is one dense sward, a little yellower where it is short;
  bare earth only in its few gaps, never thin grass over brown ground, and never a ground that
  changes colour as the camera zooms. At the lip the turf ends on its soil over the stone, never a
  dark hole among the flowers. By night
  the lawn is a dark, quiet green with a hint of cool (see Night). Toward a sheltered coast the grass runs to the
  lip and stands there, and the same grass grows out over it: its tufts at the lip spill over the
  edge, fine blades that arch over and hang down the wall, lying on the stone, never through it, and the lip alternates between
  overgrown stretches and cut-open
  root soil.
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
  brush; ours are some 6 m across, spread evenly over the island top, and from the game's view each
  swath is one stroke of colour on the lawn, cinnabar or sky blue, its flowers covering about a
  third of its middle (the green showing between them) and thinning at its rim; a few single plants
  between the swaths. Each swath's kind is its ground's: the zhuyu in the exposed coast's
  wind-cropped turf, the shallow pockets and on dry ground (among shorter grass), the yaoxiang over
  the rest of the meadow, most in the sheltered sward. None on the lip itself and none in the
  bamboo's groves or their shade (flowers there drew dull). Flowers scattered as small drifts or
  single heads read from the game's view as specks or confetti, never as the island's colour. They
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
- Penglai's own bamboo (浮筠之簳, Shiyi ji: "green leaves, purple stems, seeds as big as pearls")
  grows over the whole island as a running bamboo left to itself takes a hillside: in groves of
  even height whose edges run out in lobes, single culms ahead of them on the open meadow, and
  glades of meadow between, never one round crown nor a closed forest. No placement rule: it
  stands at the cliff's edge as anywhere else. Its culms are tall and slender, bare to about half
  their height, their leaves narrow and in loose drooping layers, so the culms show from above
  between them. Its stems are a mid to dark green, one family with its leaves and the meadow and
  most of the time darker than the crowns, and a minority of old culms turn a dim dusty purple at
  the same lightness, so the purple of the old text shows up close and the grove still reads as
  one green, by its light and shade. A grove is dark inside, its canopy hiding most of the sky from
  its floor, its culms lit where the sun finds them. Its floor is the meadow's
  grass up to a couple of metres inside the culm line, then clearings of fallen leaves, about
  half of the floor where a grove is deep, with ragged edges about a metre across, a few stray
  tufts of grass left in them, and small bare discs under its clusters of young shoots. The
  litter is paler than the grass ground (about a third brighter) and nearly neutral, a
  brownish grey with the grain of leaves and twigs, never a dark brown; patches of a low
  blue-green groundcover, a metre to a few across, lie on about a seventh of it. The grass does
  not shorten toward a clearing: it stops at the litter's edge at its full height.
- Besides these, the terrain plants the meadow (grass, and the flowers when they are on) and its turf over the rim, and no
  shrub or tree: the island is a low, rolling top ringed by cliffs, with no lee where they would grow (the
  shrubs, small trees, rim bushes and hanging leaf trails it once had were placeholders). The
  walker's loop stays open meadow. Plants that matter to play are content placed in the world, not
  terrain.
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
  like the islanders. From the game's view they read by silhouette and motion: a flock wheeling
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
  hazy: the horizon reads milky white rather than a cyan band, brightest toward the sun. The
  sun's light warms from about 20 degrees, turns orange by 10 and orange red near the horizon.
  After sunset the island stays readable: through the minutes between the sun's last light and the moon's, the meadow keeps its light (warm under the
  afterglow, then green), never dipping below its night brightness; the light that holds it up is
  lent to the island alone. The
  sun is drawn at twice its true size, the moon at about five times (some 2.6 degrees across),
  so it reads as the night's light source; it is no brighter per unit of sky for it, and the
  moonlight on the island keeps its level. The day cycle is authored, not astronomical.
- The sunlit ground lights what stands over it from below, one bounce for every lit surface: the
  shallows' sand the cliff's walls, the meadow the islanders' undersides; strongest around midday.
- Bad weather dims and desaturates the existing light and thickens the air as its visibility
  falls; the haze it adds is the air's own, lit and shaded like the rest of the scene, never a grey
  screen veil, and it stays dimmer and greyer than a clear day. The haze starts at the camera, as
  air does, yet from the game's views the island's foreground stays clear (a few percent of veil
  from 45 to 190 m). Sea fog is a low layer at the cliff's foot that may surround the island,
  never a uniform tint.
- Weather changes sweep the sky as a front from upwind. The clouds drift downwind with the wind
  aloft, faster than the surface wind (the cumulus about twice it, the cirrus about three times,
  along their fibres), so they never move against the grass and the sea.
- Through sunset the sky's light takes a gain of its own: the golden hour's warm one down to a sun
  at 2 degrees, then a continuous move to the night key by -6 degrees. It sets the dusk's warm
  light, and where it colours the sky it decides. Beyond it, no
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
  the meadow nearly black with a hint of cool green, the rock a cool grey that catches the moon and
  stands as the brightest thing on the island. Its exposure keeps the moonlit island readable and the moon's path on the sea crisp.
  Every night has its moon, up from dusk to dawn: the phase shows only on the drawn moon and
  never darkens the night.
- The island reads by moonlight and starlight; twilight is never darker than the night. The
  moon takes over the key soon after the sun has gone.
- The moon keeps a lower orbit than the sun (it culminates at 20 degrees, not 62), rising due
  east at sunset and setting due west at sunrise, so seen from the game's overview its light
  comes in at a slant: slopes show a lit and a shaded side and the sea carries a moon path, where
  a moon near the zenith lit the island flat. The moon path and the moonlit meadow glow softly in
  that view too. While it is up the moon is drawn where the island takes its light from (one fixed
  place all night, a little above its orbit's culmination), and the glow of the air around it
  comes from there too, so the disk, its glow and the light on the land stand together.
- The night meadow is a dark, quiet green with a hint of cool under the moon (not black); stone,
  sand and skin stay apart from it and from each other in tone.
- The stars and Milky Way are the real sky as seen near 28 degrees south, points with a natural
  spread of brightness, below white except the brightest few; only those near the horizon
  scintillate.

## Islanders

- The people of 含明, west of Penglai, who stitch birds' feathers into clothes and drink the dew
  (拾遗记 卷十). Their gear covers what a figure cannot do well, as Frostpunk's winter clothes do:
  a woven bamboo hat (笠: the pointed 斗笠 and the flat crowned 箬笠) over a head with no hair and
  no worked face, in the brim's shade.
- White feathers stitched into a short-sleeved top worn open over the bare chest and belly and
  into shorts to mid-thigh, bare arms and legs, straw sandals: little cloth, as on an island short
  of everything. No sash or headcloth (a headcloth read as a bandit's).
- The feathers must read as feathers up close (cards cut from a photograph, laid in overlapping
  rows as a feather cloak's are), or they are not worn; the clothes keep no finer detail. From the
  game's default distance the figure reads by colour and silhouette (straw disc, white top and
  shorts, skin), the feathers' and weave's texture from the closest zoom.
- Realistic, lit by the island's own light (no cel steps, no outlines), about 6.5 heads tall
  (`real` in `src/characters/Proportions.ts`).
- Built in Blender on the kit's rig and clips, never modelled in code. The earlier kit-dressed
  islander (pointed ears, linen shirt, cel steps, the medium build) stays selectable (`look=kit`).
