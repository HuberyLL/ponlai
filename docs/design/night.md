# Night

What the island looks like by night and why, and what to avoid: the moon, its light, the night
sky and the stars. The night is art-directed, not a simulation of the eye's night vision. What
every subject shares is in [Art direction](art-direction.md); how the twilight falls into the night
is in [Sea and sky](sea-and-sky.md#the-skys-colour-through-the-day); the night's exposure levels
are in [Look values](../reference/look-values.md#exposure).

## The light

- The night takes the day's curve and grade under the moon's own light: its key from one side, its
  shade drawn up a little, as an eye adapted to the dark sees it. So the moonlit meadow still shows
  its clumps' lit and shaded sides, as the day does.
- The island reads by moonlight and starlight. The twilight falls into the night with no step back
  up, under every sky, and the moon takes over the key soon after the sun has gone.
- The night is cool. As the rods take over from the cones, dark colours come up and turn blue (the
  Purkinje shift), but the blue belongs to the sky and the sea. The land under them goes dark and
  quiet, far less saturated than they are: the meadow a very dark, quiet green with a hint of cool,
  never black; the rock a cool grey that catches the moon and stands as the brightest thing on the
  island.
- Under the moon, stone, sand and skin stay apart from the meadow and from each other in tone.
- One night key serves every night's sky, so the deep night holds its exposure whatever the moon.
  The exposure keeps the moonlit island readable and the moon's path on the sea crisp.
- The moon's path is pale: the moon's blue stays in the water and the sky, which meet level only far
  out, where the sea reflects the sky as drawn. The path never flashes off the glint.

## The night sky

- The night sky as drawn stands below the light it sheds, by a number of stops each weather sets
  (`seenNight` in `packages/render/sky/Weather.ts`). The moonlit sky and its clouds read dark over
  the island, while the land, the near sea and the near air keep the light the sky gives them. The
  far sea and the far air meet the drawn sky at the horizon.
- The exposure is set by the light, not by the darker sky.

## The moon

- Every night has its moon, up from dusk to dawn. The phase shows only on the drawn moon and never
  darkens the night.
- The moon stands fixed in the sky, 20 degrees up on the noon meridian, all night and every night
  (`packages/render/sky/DayCycle.ts` `MOON`). Seen from the island view its light comes in at a
  slant: slopes show a lit and a shaded side, its shadows run long and the sea carries a moon path.
  A moon near the zenith would light the island flat.
- The moon path and the moonlit meadow glow softly in the island view too.
- It neither rises nor sets, so the night's composition holds while the game is played.
- The moon is drawn where the island takes its light from, and the glow of the air around it comes
  from there too, so the disk, its glow and the light on the land stand together.
- It is drawn at about five times its true size, some 2.6 degrees across, so it reads as the
  night's light source. It is no brighter per unit of sky for it, and the moonlight on the island
  keeps its level.

## The stars

- The stars and the Milky Way are the real sky as seen from 38 degrees south (the latitude the sun's
  path is set at) at a sidereal time of 14h, fixed (`packages/render/sky/DayCycle.ts` `STARS`). They
  neither turn through the night nor drift over the year, so the night's composition holds, with the
  Milky Way rising out of the sea in the horizon view.
- They are points with a natural spread of brightness, below white except the brightest few. Only
  those near the horizon scintillate.
