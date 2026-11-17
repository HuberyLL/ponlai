# Life and islanders

What the island's creatures and its people look like and why, and what to avoid. What every subject
shares (lighting, exposure, post-processing) is in [Art direction](art-direction.md). Of the
creatures below, only the wenyao is built (`packages/island/life/Wenyao.ts`), and it is parked:
the scene leaves it out unless the `wenyao` URL option is given. The others are designed.

Contents:

- [The creatures](#the-creatures)
- [The cast](#the-cast)
- [The islanders](#the-islanders)

## The creatures

- The island's life, in the sea, on the island and over both, is the life of Penglai and the other
  mountains of the immortals as the old texts describe it (the Liezi, the Shiji, the Shanhaijing,
  Wang Jia's Shiyi ji and their like). Avoid a generic animal added for liveliness: a crab, or a
  gull for its own sake.
- Each creature is a real species in body, gait and habitat, with one or two departures from life,
  as the texts themselves make them: the Shanhaijing's wenyao is a flying fish with a white head, a
  red beak and a bird's wings, and it flies by night; the Liezi's trees are trees whose flowers and
  fruit are pearl and jade. No creature comes from the texts alone, without a living model. Fantasy
  plants follow the same rule.
- Each has a reason in the world for being there. It lives where its real species would: a turtle on
  the seagrass it grazes, a clam in the sunlit shallows its algae need. Its numbers follow the
  extent of that habitat (the coast's length, the shallows' or the meadow's area), and nothing is
  placed by hand.
- The island's own birds and beasts are white: real species in white plumage or coat ("its birds and
  beasts are all pure white", the Liezi; "its creatures, birds and beasts, are all white", the
  Shiji). Visitors from elsewhere (the jingwei from the western mountains, the wenyao from the
  western sea) and the creatures of the sea keep their own colours.
- Creatures belong to nature, so they are shaded as realistically as the plants, never stylised.
  From the island view they read by silhouette and motion: a flock wheeling overhead, a tall bird
  standing at the water's edge, a large shadow gliding through the clear shallows, a school breaking
  the surface. A small creature of the texts is made larger than life where that view would lose it.
- No beings of human form (the jiaoren), no herds of phoenixes and qilin, and no dragons but the
  bones they shed (as on Fangzhang in the Shiyi ji), which read as rock, like a whale's fossil ribs.
  Any of these would turn the photographic image into an illustrated myth.

## The cast

The cast the texts give so far:

- In the shallows:
  - The shen: giant clams with blue-green and gold mantles in sunlit water one to five metres deep
    (in the Liji the pheasant "enters the great water and becomes a shen"). On a calm, warm
    afternoon the mirage over the sea is its breath ("by the sea the shen's breath forms towers",
    the Shiji), drawn as a real mirage, a stretched and doubled horizon. Avoid a palace painted on
    the sky.
  - The young ao, green turtles, graze the seagrass meadows. The great ao that hold the islands up
    in the Liezi are the island's story, never seen whole.
  - The luobu, Penglai's own great sea snail in the Shiyi ji, crawls out of its shell and carries it
    on its back over the cobbles at the cliff's foot while it is warm, and draws back in when it
    cools.
- In deep water: the great fish of Yingzhou, "a thousand zhang long, spotted, with a horn on its
  snout, dancing and playing in schools" (the Shiyi ji), a whale shark with a horn: now and then a
  vast spotted shadow passing beyond the shelf's edge.
- On the sea: the wenyao, flying fish in schools that break from the swell offshore and glide, by
  night as by day.
- Over the island and its coast, Penglai's own birds in the Shiyi ji:
  - The yuanyang ("like a wild goose, it wheels among the clouds, roosts on high peaks, and its feet
    never tread the ground"; not the mandarin duck) is a white skein of geese circling the island
    high up, never landing.
  - The honge ("coloured like a swan, shaped like an adjutant stork, with no gut, its feathers
    growing from the bone") is a gaunt white stork that never feeds, standing still at the water's
    edge below the cliffs.
  - The ou of the Liezi, white gulls and terns, settle beside islanders without guile, and only
    dance overhead when one schemes.
  - Now and then a jingwei, a crow-like bird with a patterned head, a white beak and red feet, flies
    in from the west and drops a pebble into the sea (the Shanhaijing).
- On the island: the xiushi of Yingzhou ("shaped like a qilin, it eats no living plant, drinks no
  muddy water, and smells gold and jade in stones", the Shiyi ji), a white deer that noses the
  stones rather than grazing.

## The islanders

- The islanders are the people of 含明, west of Penglai, who stitch birds' feathers into clothes and
  drink the dew (拾遗记 卷十).
- Their gear hides what the figures cannot render well, a face and hair: a woven bamboo hat (笠: the
  pointed 斗笠 and the flat crowned 箬笠) over a head with no hair and no worked face, in the brim's
  shadow.
- White feathers are stitched into a short-sleeved top worn open over the bare chest and belly and
  into shorts to mid-thigh, with bare arms and legs and straw sandals: little cloth, as on an island
  short of everything. No sash or headcloth: a headcloth reads as a bandit's.
- The feathers must read as feathers up close (cards cut from a photograph, laid in overlapping rows
  as a feather cloak's are), or they are not worn. The clothes keep no finer detail.
- From the game's default distance a figure reads by colour and silhouette: the straw disc, the
  white top and shorts, the skin. The feathers' and the weave's texture show from the closest zoom.
- The figures are lit as the rest of the island is, by three.js's physically based shading with
  bounce light from the ground, with no cel-shading steps and no outlines. They stand about 6.5
  heads tall
  (`packages/island/characters/FigureSurfaces.ts`; `real` in
  `packages/island/characters/Proportions.ts`).
- They are built in Blender on the character kit's rig and its clips, never modelled in code
  (`packages/island/characters/looks.ts`).
