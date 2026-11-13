# The renderer's look knobs

Where each knob of this renderer is, what it does on screen, and which place of the style it
belongs to: light (the lighting leaving physical correctness globally, per weather and time of
day), air, or image (exposure, tone mapping, grade, the night's treatment). Content and material
values are not knobs here: they live in the scene's content and its materials. Paths are under
`packages/render/`. Each module's header comment holds the detail.

- [How the knobs are set](#how-the-knobs-are-set)
- [Light](#light)
- [Air](#air)
- [Image](#image)
- [Not style knobs](#not-style-knobs)

## How the knobs are set

- A look is one set of numbers per system (`look/Look.ts`, the type `Look`), handed in by whoever
  owns the picture. The renderer holds the types, the code that reads them and a neutral set
  (`look/NeutralLook.ts`): every gain 1, every offset, strength and cast 0, no grade, no vignette,
  no bloom, nothing done for the night, one key held all day. A project passes its own set.
- No module holds a look at module level: every system takes its table where it is created, so a
  change of look is a change of the set, never of a material.
- Most tables are keyed by the sun's elevation (`post/DayKeys.ts`: named day keys, a clouded key
  and a night key, eased between) and by the weather's blend of four skies (clear, fair, cloudy,
  overcast). A knob set for one hour or weather leaves the others.
- On debug pages each knob is a tunable (`debug/Tune.ts`) under the name given below, set at run
  time without a new pipeline, or before load through the page's `tune` URL option. A keyed knob
  is named `<prefix>.<value>@<key name>`.

## Light

All of these act on every surface lit by the shared lighting model at once.

| Knob | Where | What it does on screen |
| --- | --- | --- |
| Ambient grade: `skySpecular`, `skyBounce`, `sunBounce`, `directionality`, `aoStrength` | `lighting/AmbientGrade.ts`; table `ambient.grade`, `ambient.gradeRising` (`look/AmbientLook.ts`) | Per sun elevation and per sky: the sky's reflection on surfaces; the bounced sky on top of the sky's light; the sunlight the ground bounces up into the shade; how much more light a shaded face turned to the open sky keeps than one turned to an occluder; how much of the ambient occlusion applies. |
| Sun bounce gain (`lighting.grade.sunBounce`) | `ambient.sunBounceGain` | Scales the key's bounce at every hour: the level of the shade lit by the ground. |
| Overcast land gain (`lighting.relight.overcastLand`) | `ambient.overcastLand`, `overcastMoonLand` | The land's ambient light under an overcast deck, the sun's and the moon's parts. |
| Low key lift | `ambient.keyLift` (`lighting/KeyLift.ts`) | Under a low sun, the elevation the key shades with: a lifted direction for the shading (`lighting/KeyLift.ts`). |
| Sky light against the sun (`sky.light.<r\|g\|b>@<key>`) | `sky.skyLight` (`look/SkyLook.ts`) | A gain per channel on the sky's in-scattered light, everywhere the sky is read: the seen sky, the environment that lights the land, the sea's reflection, the haze's sky light. The sky that is seen stays the sky that lights. |
| Clear sky gain (`sky.clear.gain@<key>`) | `sky.clearSky` | The clear and fair day's sky against the key, on the same paths. |
| Island sky | `sky.islandSky`, `sky.cloudLightTint` | The light the sky lends the land after sunset and under cloud: its tint, how far, its gain. |
| Low sun key | `sky.lowKey` | A gain on the sunlight by elevation near the horizon; the shade, lit by the sky, does not move. |
| Key hue (`sky.key.hueDepth`, `dawnHueDepth`, `reddens`, `yellows`) | `sky.keyHue` | How warm the sunlight turns as the sun lowers, and its white while the sun is high. |
| Key through cloud (`lighting.keyThroughCloud`) | `sky.keyThroughCloud` | How much of a cloud layer's light the land keeps as a light along the key. |
| Moon light (`lighting.moon.red`, `blue`) | `sky.moonKey`, `moonHue`, `moonSkyHue`, `nightAmbientHue`, `nightAmbientShare` | The colour of the moonlight and of the night's ambient light. |
| Occlusion floor | `occlusion.floor` (`post/GTAO.ts`) | The least ambient occlusion a surface keeps where its own and the screen's multiply. |
| Local lights gain | `localLights.gain` (`lighting/LocalLights.ts`) | A gain on every local source's own intensity. |
| Day windows | `day` (`look/DayLook.ts`) | Where the key passes from the sun to the moon, and where each night layer comes in through the dusk. |

## Air

| Knob | Where | What it does on screen |
| --- | --- | --- |
| Haze keys (`haze.key.*`, `haze.fog.*`) | `haze.keys`, rows `rising`, `setting`, `settingClouded` (`look/HazeLook.ts`, read by `weather/HazeKeys.ts`) | Per hour (ten named keys, eased by the sun's elevation): how much haze, the ground layer's top and width, the deep aerosol layer, the spectral extinction (the colour the air takes from the distance), the desaturation of the air's light, a morning mist, the fog layer (its share, top, edge and the visibility at the sea), and the Rayleigh and Mie shares' weights. |
| Haze per sky (`sky.weather.*@<cloudy\|overcast>`) | `haze.keep`, `gain`, `scales`, `decked`, `sunRayleigh` | What each sky of the weather's blend adds: the light's colour kept, the gain, scales on the hour's medium, whether a deck caps the aerosol layer. |
| Sea fog | `haze.seaFog` | The deep sea fog, a switch beside the weather. |

## Image

| Knob | Where | What it does on screen |
| --- | --- | --- |
| Exposure keys (`post.exposure.<key\|highlight\|sky\|adaptUp\|adaptDown>@<key>`) | `exposure.keys` (`look/ExposureLook.ts`, read by `post/Exposure.ts`) | Where a white diffuser under the frame's typical light lands; the highest the frame's bright band may land; the sky's share of the meter; how fast the exposure adapts each way. The meter reads the light falling on the scene, not the light leaving it, so the albedo stays out of it. |
| Overcast exposure (`post.exposure.overcastKey`, `overcastKeyLow`, `overcastNight`) | `exposure.overcastKey` and beside it | Overcast's key over the clouded one, and how much of an overcast night's darkness stays on screen. |
| Base exposure by elevation; night exposure | `day.exposure`, `nightMeterLift`, `nightExposureGain`, `nightSkyExposure` | The exposure the sky and the day cycle read by the sun's elevation, and the night's lift and the night sky's own exposure. |
| Local tone (`post.localTone.<hinge\|high\|low\|width>@<key>`) | `post/LocalTone.ts` `LOCAL_TONE` (in the module, not in the look's set) | Draws large regions toward each other (the bright sky and sunlit sand against the shade) while each local texture keeps its contrast. |
| Shade contrast (`post.shade.<pivot\|slope>@<key>`) | `display.shadeContrast` (`look/DisplayLook.ts`) | Under a pivot, each stop darker darkens by a share of a stop more: deeper shade without touching the light. |
| Desaturation (`post.desaturate.<amount\|cool>@<key>`) | `display.desaturation`, `coolShare` | Draws colours toward their luminance, all or only the cool ones; below 0 it saturates. |
| Tone curve (`post.tone.blackSlope`, `midGrey`, `white`) | `display.toneCurve` (`post/ToneCurve.ts`, `post/Pipeline.ts`) | The toe's slope from black, where mid grey lands, and the white the curve reaches 1 at. |
| Tone space | `post/ToneSpace.ts` (code, not a look knob) | The curve runs per channel in AP1 with its red primary moved out, so saturated colours roll off toward white. |
| White balance (`post.white.<r\|g\|b>@<key>`, `@overcast`) | `display.whiteBalance`, `whiteOvercast` | The colour white becomes, per sun elevation, cloud and night: a cast over the whole frame. |
| Grade | `display.baseGrade` (`post/GradeLut.ts`) | Two 32^3 tables blended: per zone (shadows, midtones, highlights) a brightness, tint and saturation; a contrast curve on lightness; hue bands (grass, sky, sea, flowers, warm hues, purple) that scale chroma, brighten and turn the hue. Used conservatively; larger moves go to the white balance and the exposure. |
| Overcast highlights (`post.highlight.amount`, `from`, `to`) | `display.highlightGrey` | Under overcast, draws the brightest colours toward grey. |
| Bloom and vignette (`post.bloom.*`) | `display.bloom`, `bloomStart`, `strengths`, `vignette` | The glow's thresholds, shares and weights, and the vignette's strength and shape. |
| Rods' blue shift at night (`post.purkinje.strength@night`) | `display.purkinje` (`post/Purkinje.ts`) | Lifts dark colours and turns them blue as the light falls, so a moonlit scene is not a darker day. |

## Not style knobs

- The sky's own colour comes from a physically based atmosphere (`sky/Atmosphere.ts`); its look
  knobs are the gains above, not the sky's model.
- The meadow canopy's media (`meadowCanopy`) are the physical model's extinction and openness, and
  the wind (`wind`) and the sea's detail (`sea`) set motion and surface detail: content, not light
  or image.
- A material's albedo, roughness and transmission are its own, not part of the look's set.
