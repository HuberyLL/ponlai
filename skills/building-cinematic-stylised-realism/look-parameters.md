# The renderer's look parameters

This page lists where each look parameter of this renderer lives, what it does on screen, and which
place of the style it belongs to. The places are lighting (departures from physical correctness
made globally, per weather and time of day), atmosphere, and post-processing (exposure, tone
mapping, colour grading and the night treatment). Content and material values are not look
parameters: they live in the scene's content and its materials. Paths are under
`packages/render/`. Each module's header comment holds the detail.

- [How the parameters are set](#how-the-parameters-are-set)
- [Lighting](#lighting)
- [Atmosphere](#atmosphere)
- [Post-processing](#post-processing)
- [Parameters that are not style](#parameters-that-are-not-style)

## How the parameters are set

- A look is one set of values per system (`look/Look.ts`, the type `Look`), passed in by whoever
  owns the rendered image. The renderer holds the types, the code that reads them and a neutral set
  (`look/NeutralLook.ts`). In the neutral set every gain is 1, every offset, strength and cast is 0,
  and there is no grade, no vignette, no bloom and no night treatment; every table keyed by the
  sun holds one keyframe all day. A project passes its own set.
- No module holds a look at module level. Every system receives its table when it is created, so
  changing the look means changing the set, never a material.
- Most tables are keyframed by the sun's elevation and blended by the weather's mix of four skies
  (clear, fair, cloudy, overcast). `post/DayKeys.ts` holds the keyframes: named day keyframes, a clouded
  keyframe and a night keyframe, eased between. A parameter set for one hour or weather leaves the
  others unchanged.
- On debug pages each parameter is tunable (`debug/Tune.ts`) under the name given below. You can
  set it at run time without building a new pipeline, or before load through the `tune` URL
  option. A keyframed parameter is named `<prefix>.<value>@<keyframe name>`.

## Lighting

Each of these parameters acts at once on every surface lit by the shared lighting model.

| Parameter | Where | What it does on screen |
| --- | --- | --- |
| Ambient grade: `skySpecular`, `skyBounce`, `sunBounce`, `directionality`, `aoStrength` | `lighting/AmbientGrade.ts`; table `ambient.grade`, `ambient.gradeRising` (`look/AmbientLook.ts`) | Per sun elevation and per sky, in order: the sky's specular reflection on surfaces; the sky light bounced on top of the direct sky light; the sunlight that the ground bounces up into shadowed areas; how much more light a shadowed face turned to the open sky keeps than one turned to an occluder; how much of the ambient occlusion applies. |
| Sun bounce gain (`lighting.grade.sunBounce`) | `ambient.sunBounceGain` | Scales the key light's bounce at every hour: the level of shadowed areas lit by the ground. |
| Overcast land gain (`lighting.relight.overcastLand`) | `ambient.overcastLand`, `overcastMoonLand` | The land's ambient light under an overcast cloud deck, for the sun's part and the moon's part. |
| Low key-light lift | `ambient.keyLift` (`lighting/KeyLift.ts`) | Under a low sun, the elevation the key light shades with: a raised direction used for shading (`lighting/KeyLift.ts`). |
| Sky light against the sun (`sky.light.<r\|g\|b>@<keyframe>`) | `sky.skyLight` (`look/SkyLook.ts`) | A gain per channel on the sky's in-scattered light, everywhere the sky is read: the visible sky, the environment lighting on the land, the sea's reflection, and the haze's sky light. The sky you see stays the sky that lights the scene. |
| Clear sky gain (`sky.clear.gain@<keyframe>`) | `sky.clearSky` | The clear and fair day's sky relative to the key light, on the same paths. |
| Land sky | `sky.landSky`, `sky.cloudLightTint` | The sky light lent to the land after sunset and under cloud: its tint, its reach and its gain. |
| Low-sun key light gain | `sky.lowKey` | A gain on the sunlight by elevation near the horizon. Shadowed areas, which the sky lights, do not change. |
| Key light hue (`sky.key.hueDepth`, `dawnHueDepth`, `reddens`, `yellows`) | `sky.keyHue` | How warm the sunlight turns as the sun gets lower, and its white point while the sun is high. |
| Key light through cloud (`lighting.keyThroughCloud`) | `sky.keyThroughCloud` | How much of a cloud layer's light the land keeps as directional light along the key light. |
| Moonlight (`lighting.moon.red`, `blue`) | `sky.moonKey`, `moonHue`, `moonSkyHue`, `nightAmbientHue`, `nightAmbientShare` | The colour of the moonlight and of the night's ambient light. |
| Occlusion floor | `occlusion.floor` (`post/GTAO.ts`) | The least ambient occlusion a surface keeps where its own occlusion and the screen-space occlusion multiply. |
| Local lights gain | `localLights.gain` (`lighting/LocalLights.ts`) | A gain on every local light source's own intensity. |
| Day windows | `day` (`look/DayLook.ts`) | Where the key light passes from the sun to the moon, and where each night layer fades in through the dusk. |

## Atmosphere

| Parameter | Where | What it does on screen |
| --- | --- | --- |
| Haze keyframes (`haze.key.*`, `haze.fog.*`) | `haze.keys`, rows `rising`, `setting`, `settingClouded` (`look/HazeLook.ts`, read by `weather/HazeKeys.ts`) | Per hour (ten named keyframes, eased by the sun's elevation): the amount of haze; the ground layer's top and width; the deep aerosol layer; the spectral extinction (the colour the atmosphere takes on with distance); the desaturation of the haze's in-scattered light; a morning mist; the fog layer (its share, top, edge and the visibility at sea level); and the weights of the Rayleigh and Mie shares. |
| Haze per sky (`sky.weather.*@<cloudy\|overcast>`) | `haze.keep`, `gain`, `scales`, `decked`, `sunRayleigh` | What each sky in the weather's blend adds: how much of the light's colour is kept, the gain, scales on the hour's medium, and whether a cloud deck caps the aerosol layer. |
| Sea fog | `haze.seaFog` | The deep sea fog, a switch separate from the weather. |

## Post-processing

| Parameter | Where | What it does on screen |
| --- | --- | --- |
| Exposure keyframes (`post.exposure.<key\|highlight\|sky\|adaptUp\|adaptDown>@<keyframe>`) | `exposure.keys` (`look/ExposureLook.ts`, read by `post/Exposure.ts`) | In order: the exposure key value (where a white diffuser under the frame's typical light lands); the highest value the frame's bright band may reach; the sky's share of the meter; how fast the exposure adapts upward and downward. The meter reads the light falling on the scene (illuminance), not the light leaving it (luminance), so albedo does not affect it. |
| Overcast exposure (`post.exposure.overcastKey`, `overcastKeyLow`, `overcastNight`) | `exposure.overcastKey` and the fields beside it | Overcast's exposure key value on top of the clouded one, and how much of an overcast night's darkness stays on screen. |
| Base exposure by elevation; night exposure | `day.exposure`, `nightMeterLift`, `nightExposureGain`, `nightSkyExposure` | The exposure that the sky and the day cycle read by the sun's elevation; the night's lift; and the night sky's own exposure. |
| Local tone mapping (`post.localTone.<hinge\|high\|low\|width>@<keyframe>`) | `post/LocalTone.ts` `LOCAL_TONE` (in the module, not in the look's set) | Draws large regions toward each other in brightness (the bright sky and sunlit sand against shadowed areas) while each local texture keeps its contrast. |
| Shadow contrast (`post.shade.<pivot\|slope>@<keyframe>`) | `display.shadeContrast` (`look/DisplayLook.ts`) | Below a pivot, each stop darker is darkened by a further fraction of a stop: deeper shadows without changing the lit areas. |
| Desaturation (`post.desaturate.<amount\|cool>@<keyframe>`) | `display.desaturation`, `coolShare` | Draws colours toward their luminance, either all colours or only the cool ones. Below 0 it saturates. |
| Tone curve (`post.tone.blackSlope`, `midGrey`, `white`) | `display.toneCurve` (`post/ToneCurve.ts`, `post/Pipeline.ts`) | The toe's slope from black, where mid grey lands, and the white point at which the curve reaches 1. |
| Tone mapping colour space | `post/ToneSpace.ts` (code, not a look parameter) | The curve runs per channel in AP1 with its red primary moved outward, so saturated colours roll off toward white. |
| White balance (`post.white.<r\|g\|b>@<keyframe>`, `@overcast`) | `display.whiteBalance`, `whiteOvercast` | The colour that white becomes, per sun elevation, cloud cover and night: a cast over the whole frame. |
| Colour grade | `display.baseGrade` (`post/GradeLut.ts`) | Two 32^3 lookup tables, blended. Per zone (shadows, midtones, highlights): a brightness, a tint and a saturation. A contrast curve on lightness. Hue bands (grass, sky, sea, flowers, warm hues, purple) that scale chroma, brighten and rotate the hue. Use it conservatively; larger changes belong in the white balance and the exposure. |
| Overcast highlights (`post.highlight.amount`, `from`, `to`) | `display.highlightGrey` | Under overcast, draws the brightest colours toward grey. |
| Bloom and vignette (`post.bloom.*`) | `display.bloom`, `bloomStart`, `strengths`, `vignette` | The bloom's thresholds, shares and weights, and the vignette's strength and shape. |
| Purkinje shift at night (`post.purkinje.strength@night`) | `display.purkinje` (`post/Purkinje.ts`) | Lifts dark colours and turns them blue as the light falls, as the eye's rods do, so a moonlit scene is not just a darker day. |

## Parameters that are not style

- The sky's own colour comes from a physically based atmosphere model (`sky/Atmosphere.ts`). Its
  look parameters are the gains above, not the sky's model.
- The meadow canopy's media (`meadowCanopy`) are the physical model's extinction and openness. The
  wind (`wind`) and the sea's detail (`sea`) set motion and surface detail. These are content, not
  lighting or post-processing.
- A material's albedo, roughness and transmission belong to the material, not to the look's set.
