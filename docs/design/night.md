# Night

This page describes what the island looks like by night, why, and what to avoid: the moon, the
moonlight, the night sky and the stars. The night is art-directed, not a simulation of the eye's
night vision. What every subject shares is in [Art direction](art-direction.md). How the twilight
turns into night is in [Sea and sky](sea-and-sky.md#the-skys-colour-through-the-day). The night's
exposure values are in [Look values](../reference/look-values.md#exposure).

## Lighting

- The night uses the day's tone curve and colour grade under the moon's own light. The moon is the
  key light, from one side, and the shadowed areas are lifted a little, as an eye adapted to the
  dark sees them. The moonlit meadow therefore still shows lit and shadowed sides on its clumps, as
  it does by day.
- The island reads by moonlight and starlight. The twilight turns into night with no step back up
  in brightness, under every sky, and the moon takes over as the key light soon after the sun has
  set.
- The night is cool. As the eye's rods take over from its cones, dark colours brighten and turn
  blue (the Purkinje shift), but the blue belongs to the sky and the sea. The land under them goes
  dark and quiet, far less saturated than the sky and the sea. The meadow is a very dark, quiet
  green with a hint of cool, never black. The rock is a cool grey that catches the moonlight and is
  the brightest thing on the island.
- At night the atmosphere adds no light of its own to the land. The dark land's lift comes from the
  Purkinje shift alone, so the far land's shadows are no brighter or bluer than the near land's.
  The atmosphere's in-scattered light stays on the sea and the sky.
- Under the moon, stone, sand and skin stay distinct in tone from the meadow and from each other.
- One night exposure keyframe serves every night sky, so the deep night keeps its exposure whatever
  the moon's phase. The exposure keeps the moonlit island readable and the moon's path on the sea
  crisp.
- The moon's path on the sea is pale. The moon's blue stays in the water and the sky, and the two
  match in brightness only far out, where the sea reflects the sky as it is drawn. The path never
  flashes brighter than the glint.

## The night sky

- The night sky as drawn is darker than the light it casts, by a number of stops that each weather
  sets (`seenNight` in `packages/render/sky/Weather.ts`). The moonlit sky and its clouds read dark
  over the island, while the land, the near sea and the nearby haze keep the light that the sky
  gives them. The far sea and the distant haze meet the drawn sky at the horizon.
- The exposure is set by the light the sky casts, not by the darker drawn sky.

## The moon

- Every night has a moon, up from dusk to dawn. The phase shows only on the drawn moon and never
  darkens the night.
- The moon is fixed in the sky, 20 degrees up on the noon meridian, all night and every night
  (`packages/render/sky/DayCycle.ts` `MOON`). Seen from the island view, its light comes in at a
  slant: slopes show a lit and a shadowed side, its shadows run long and the sea carries a moon
  path. A moon near the zenith would light the island flat.
- The moon path and the moonlit meadow glow softly in the island view too.
- The moon neither rises nor sets, so the night's composition holds while the game is played.
- The moon is drawn at the direction the island takes its light from, and the glow of the haze
  around it comes from there too, so the disk, its glow and the light on the land agree.
- It is drawn at about five times its true size, some 2.6 degrees across, so it reads as the
  night's light source. Its brightness per unit of sky does not increase with the size, and the
  moonlight on the island keeps its level.

## The stars

- The stars and the Milky Way show the real sky as seen from 38 degrees south (the latitude that
  the sun's path is set at) at a fixed sidereal time of 14h (`packages/render/sky/DayCycle.ts`
  `STARS`). They neither turn through the night nor drift over the year, so the night's composition
  holds, with the Milky Way rising out of the sea in the horizon view.
- They are points with a natural spread of brightness, all below white except the brightest few.
  Only stars near the horizon twinkle.
