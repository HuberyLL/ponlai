# Credits

Ponlai is released under the MIT License (see `LICENSE`). The third-party code and assets listed here
keep their own licences. Adapted source files also carry the upstream notice in their header. A
production build copies this file and the required licence texts, including those of the bundled npm
packages, into `dist/licenses/`.

## Adapted code

### tidewater

- Upstream: https://github.com/dgreenheck/tidewater, by Daniel Greenheck
- Copyright: (c) 2026 DRG Software Solutions LLC
- Licence: MIT, see [`src/ocean/tidewater.LICENSE.txt`](src/ocean/tidewater.LICENSE.txt),
  [`src/sky/tidewater.LICENSE.txt`](src/sky/tidewater.LICENSE.txt),
  [`src/materials/tidewater.LICENSE.txt`](src/materials/tidewater.LICENSE.txt),
  [`src/lighting/tidewater.LICENSE.txt`](src/lighting/tidewater.LICENSE.txt),
  [`src/post/tidewater.LICENSE.txt`](src/post/tidewater.LICENSE.txt),
  [`src/weather/tidewater.LICENSE.txt`](src/weather/tidewater.LICENSE.txt) and
  [`src/life/tidewater.LICENSE.txt`](src/life/tidewater.LICENSE.txt) (the same text)
- From the three.js (TSL) edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86):
  - `src/ocean/OceanFFT.ts`: the multi-cascade FFT ocean (its time evolution and inverse FFT).
  - `src/ocean/Water.ts`: the water shading (`WaterMaterial.js`).
  - `src/ocean/FoamPattern.ts`: the procedural foam pattern from `FoamTexture.js` (rafts, holes,
    bubbles, mottling and streaks, generated on the GPU; no image asset).
  - `src/ocean/Spray.ts`: the GPU spray from `src/fx/Spray.js` (drops, ligaments, dense spray and
    mist, their integration and lighting, the puff and drop-cluster textures), without its boat,
    terrain and surf-foam couplings; emitters own fixed slot groups instead of an atomic ring.
- From the native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef):
  - `src/ocean/OceanSpectrum.ts`: the JONSWAP / TMA spectrum, directional spreading and dispersion
    helpers from `OceanFFT.js`, ported to TypeScript, and the sea states of `src/ui/AppUI.js`;
    `OceanFFT.ts` sums its two wave systems (`local` and `swell`) into four cascades of its sizes
    and bands, and takes the shallow-water attenuation of each cascade from `WaterSurface.js`.
  - `src/ocean/WaveMaps.ts`: the wave maps of `UnderwaterLighting.js` (the long waves and the mean
    level baked once a frame into two maps centred on the camera, with their lookup), ported from
    WGSL to TSL.
  - `src/lighting/Underwater.ts`: the key light and ambient under the water of
    `UnderwaterLighting.js`'s direct and ambient hooks (the depth under the long waves, the
    ambient's attenuation); `src/lighting/RefractedSun.ts` reads the air's shadow map at
    the entry point of its shadow position hook.
  - `src/lighting/GroundBounce.ts`: the ground bounce of `GroundBounce.js` (the map of the light
    the ground reflects, its land cover and sea seen through the water column, the environment's
    own ground taken off, the binomial blur, and its lookup: the lower hemisphere's view factor,
    the fade with height and the self-shading of faces turned from a low sun), ported from WGSL to
    TSL, on this project's world fields and shadow map.
  - `src/ocean/StormSea.ts`: the persistent whitecap foam of `OceanFFT.js` (build-up where the
    Jacobian folds, exponential decay), here on one world-space grid of the summed cascades.
  - `src/ocean/Water.ts`: the above-water shading of `WaterMaterial.js` (Fresnel, the sky
    reflection lifted by the unresolved slopes and darkened below the horizon, the reflection's
    gate, the GGX glint with Cox-Munk roughness, the refracted ray traced to the floor, the
    analytic water body, the crests' translucency and the lit foam), the normal, near-field
    ripples and whitecap compositing of `WaterSurface.js` (fresh foam on the Jacobian, a foam
    pattern thresholded by the coverage, at a distance the coverage itself), ported from WGSL to
    TSL.
    Its reflection march takes the steps that grow with the distance and the 260 m stop of
    `WaterMaterial.js`'s `_waterSSR`, and its refraction the lookups into the refraction image.
  - `src/life/FishGeometry.ts`: the procedural fish mesh of `src/world/fish/FishGeometry.js` (the
    body lofted from superellipse rings of an anatomy table, the fins as membranes between rays),
    cut to a swimming fish, ported to TypeScript, with paired fins spread as wings.
  - `src/life/Wenyao.ts`: the schooling of `src/world/Fish.js` (separation, alignment and cohesion
    within a school, its goal in long straight runs, the turn back from shallow water, the heading,
    bank and bend of each fish), with a flight of its own.
  - `src/life/FishMaterial.ts`: the swimming wave and turning bend of `src/world/fish/FishMaterial.js`
    (its three.js edition at fd6cae6, `swimVertex`).
  - `src/ocean/SeaDetail.ts`: the gusts, slicks and windrows of `SeaDetail.js` (its noise texture
    and sampling, ported from WGSL to TSL), driven by this project's wind.
  - `src/ocean/Refraction.ts`: the refraction source of `RefractionPass.js` (the scene below the
    water only, clipped above the sea level, half resolution, through a guard band wider than the
    screen), as a frame graph pass drawing a clipping group.
  - `src/ocean/ShoreWaves.ts`, `src/ocean/ShoreWaveField.ts`: began as an adaptation of
    `ShoreWaves.js`; now mostly rewritten for this island's rocky boundary.
  - `src/sky/Atmosphere.ts`, `src/sky/Sky.ts`: the atmosphere and solar disk from `Atmosphere.js` and
    `Sky.js`, ported from WGSL to TSL.
  - `src/post/PhysicalBloom.ts`: the physically motivated bloom of `PostFX.js` (after Jimenez,
    SIGGRAPH 2014: 13-tap downsamples, the first through the Karis average, and 3x3 tent
    upsamples; its threshold the quadratic soft knee of Unity's Post Processing Stack v2 bloom,
    below; with a threshold of the sky's own and a weight per level);
    `src/post/Pipeline.ts`: its grade (saturation and contrast round mid grey, the
    vignette, the luminance-weighted grain; its warm white balance nudge is now the white
    balance's default) before the ACES fit at its exposure, ported from WGSL to TSL.
  - `src/post/TemporalLocks.ts`: the motion cap, the temporal reactive and the clamp-drop of
    `TemporalUpscale.js`'s accumulation, which is AMD's FSR 2 (see "FSR 2" below; licence
    [`src/post/tidewater-fsr2.LICENSE.txt`](src/post/tidewater-fsr2.LICENSE.txt), both notices).
  - `src/sky/Clouds.ts`, `src/materials/CloudNoise.ts`: the volumetric cumulus from
    `SkyProClouds.js`, tidewater's port of the Three.js Sky Pro clouds ("Partly cloudy" preset),
    ported from WGSL to TSL: the procedural weather map and its bounds grid, the shell density
    (weather plus coverage, dilated and eroded by the shape noise, soft height-dependent edges),
    darker bases and sky light occlusion, the coarse / fine march with empty-cell skipping, aerial perspective (the rain
    curtains'), the cloud shadow, and the shape noise loader. From `Clouds.js`: the screen-space view
    trace with its reprojected, neighbourhood-clamped history and bicubic upsampling, and the
    synoptic field. The weather fronts, the mapping of this project's coverage onto the shell,
    the darker closed deck and the settled view of a paused scene are this project's (the rain
    curtains follow VolumetricCloudsCS1, below); the panorama map is this project's own, predating the port (`Clouds.js` has a
    similar one).
  - The thin cloud layer (`src/sky/Clouds.ts` `streaksAt`, `src/sky/Streaks.ts`): the fibre bake
    (a flow field of sparse seeds and tufts drawn out by line integral convolution, hooked tails
    downwind of tufts), the sheet's footprint on the curved Earth and its anisotropic,
    footprint-filtered lookup, from the cirrus in `Clouds.js`, ported from WGSL to TSL. The fibres'
    two turned scales, their silk, the patches' edge and thinning, and the layer's light are this
    project's.
  - `src/materials/Wetness.ts` (`runnels`): the rain-streak stains of `terrainRockSurface` in
    `src/world/terrain/TerrainShading.js` (the variation stretched down the two vertical projection
    planes, weighted by how squarely each faces the surface, and its 40 % darkening), ported from
    WGSL to TSL and turned into the paths that rain water takes down the cliffs while they are wet.
  - `src/weather/VolumetricHaze.ts`: from `src/post/AirHaze.js`, the haze's two exponential
    height layers (a thin marine layer and a deeper aerosol layer, in its proportions and scale
    heights) and its Cornette-Shanks phase function with a share of isotropic scattering. The
    froxel volume they now fill, its lighting, its shadow and its composite are this project's
    (after Patry: see Acknowledgements), as is the morning mist.
  - The celestial clock, geometric lunar phase and the star and Milky Way rendering are original
    code; the star catalogue and Milky Way map they draw are listed under Assets. (The lunar disk's
    shading and imagery are credited under three-geospatial, a-starry-sky and the CGI Moon Kit.) Weather blending,
    integrated wind and the rain veil and ripple gradients are original Ponlai code as well; the
    wet-material response implements the published techniques acknowledged below.
  - Techniques without code: the gravel of thin soil (`src/materials/ProceduralTextures.ts` `gravelBake`, read in
    `src/materials/TerrainMaterial.ts` at two rotated scales) follows the small stones of
    `src/world/terrain/DetailTextures.js` (a share of a periodic Worley lattice's cells holding a
    stone) and the multi-scale, rotated detail reads of `src/world/Terrain.js`. The trees' leaf
    clumps (`src/world/vegetation/TreeMesh.ts` `leafClump`) follow the canopy cards of
    `src/world/vegetation/PlantGeometry.js` (`addCard`, `lobeCards`: cards toward a lobe's shell,
    their normals bent out from the lobe and from the crown, an exposure darkening the inside).
    The local lights (`src/lighting/LocalLights.ts`) follow `src/materials/LocalLights.js`: the
    sources a project's own list rather than three lights, evaluated by every lit material in a
    loop, inverse-square with the smooth range window ( 1 - ( d / r )^4 )^2, no shadows (the
    nearest-lights selection and its faded edge since replaced by clusters, below).
- Changes: ported to TSL and TypeScript and modified throughout for this project's stylised look.

### three-geospatial

- Upstream: https://github.com/takram-design-engineering/three-geospatial, by Shota Matsuda
  (takram)
- Copyright: (c) 2024 Shota Matsuda
- Licence: MIT, see [`src/sky/three-geospatial.LICENSE.txt`](src/sky/three-geospatial.LICENSE.txt)
- From `packages/atmosphere/src/webgpu/MoonNode.ts` at commit
  [`2047b5f`](https://github.com/takram-design-engineering/three-geospatial/blob/2047b5fbb31899bbab541274f6cf78d091872016/packages/atmosphere/src/webgpu/MoonNode.ts):
  the lunar disk in `src/sky/NightSky.ts`: the ray/sphere intersection normal, the equirectangular
  colour lookup, normals perturbed by the LOLA heights through a screen-space cotangent frame,
  Oren-Nayar diffuse of roughness 1 and the limb antialiased by the chord's screen derivative.
- Changes: written against this project's own sun and moon directions and lunar frame (north up)
  instead of an Earth-fixed frame; explicit-gradient lookups with a capped footprint, a capped
  relief slope and the disk's brightness normalised to this project's moon; an art-directed lift for
  crescents.

### a-starry-sky

- Upstream: https://github.com/Dante83/a-starry-sky, by David Evans
- Copyright: (c) 2018-2026 David Evans
- Licence: MIT, see [`src/sky/a-starry-sky.LICENSE.txt`](src/sky/a-starry-sky.LICENSE.txt)
- From `src/glsl/moon/base-moon-partial.glsl` and `src/cpp/state-engine/astro_bodies/Moon.cpp` at
  commit [`8ef1c8a`](https://github.com/Dante83/a-starry-sky/tree/8ef1c8a35da8d568eb2684a858499934b80188b7):
  the earthshine in `src/sky/NightSky.ts`: its blue-biased colour, full-Earth strength, the
  Lommel-Seeliger phase law and the night-side mask. None of its moon textures are used.
- Changes: ported to TSL; the phase law is taken at Earth's phase as seen from the moon, and the
  earthshine fades out close to conjunction.

### Godot_rain_shader

- Upstream: https://github.com/Lexpartizan/Godot_rain_shader, by Lexpartizan, commit
  [`0d38727`](https://github.com/Lexpartizan/Godot_rain_shader/tree/0d38727cd29eb1323c4b68fe689413859c525b10)
- Copyright: (c) 2020 Lexpartizan
- Licence: MIT, see [`src/materials/godot-rain-shader.LICENSE.txt`](src/materials/godot-rain-shader.LICENSE.txt)
- Files: `runnels` in `src/materials/Wetness.ts`: the falling streak gradient of `rain.shader` (the
  streak pattern sampled again with a scrolling vertical offset and thresholded into moving slugs
  of water), ported from Godot shading language to TSL. No textures from the repository are used.

### Hash without Sine

- Upstream: https://www.shadertoy.com/view/4djSRW, by David Hoskins
- Copyright: (c) 2014 David Hoskins
- Licence: MIT, see [`src/materials/hoskins-hash.LICENSE.txt`](src/materials/hoskins-hash.LICENSE.txt)
- Files: `hash22` in `src/materials/ProceduralTextures.ts` (also seeding the hex tiles of
  `src/materials/HexTiling.ts`) and `src/ocean/Water.ts`; `hash33` in
  `src/materials/CloudNoise.ts`
- Changes: ported to TSL; the procedural textures remap it to [-1, 1].

### hextile-demo

- Upstream: https://github.com/mmikk/hextile-demo, by Morten S. Mikkelsen, commit
  [`43c3ed7`](https://github.com/mmikk/hextile-demo/tree/43c3ed7e18e1e4539fa9323f72d5e2a65147ebb3),
  the code of [*Practical Real-Time Hex-Tiling*](https://jcgt.org/published/0011/03/05/)
  (Journal of Computer Graphics Techniques 11(3), 2022)
- Copyright: (c) 2022 mmikk
- Licence: MIT, see [`src/materials/hextile-demo.LICENSE.txt`](src/materials/hextile-demo.LICENSE.txt)
- Files: `src/materials/HexTiling.ts`: the triangle grid (`TriangleGrid`), the tiles' centres
  (`MakeCenST`), the blend's weights, and the rotated, offset reads with rotated gradients and
  their weighted sum of colour, slope and roughness (`hex2colTex`, `bumphex2derivNMap`, in
  `hexReadScan`), ported from HLSL to TSL.
- Changes: each tile's offset and rotation come from Hoskins's hash (above) instead of the demo's
  sine hash and integer angle formula, the rotation is limited to 0.4 rad; the blend is weighted by
  a height read from the stone scan's brightness and shared by its colour, normal (as slopes,
  turned back by each tile's rotation) and roughness; tiles under 3 % of the strongest
  one's weight are not read, and those under 6 % fade out.

### LightningStrike (three.js / three-stdlib)

- Upstream: `LightningStrike.js` by yomboprime, from the three.js examples (removed in r153), as
  kept in [three-stdlib](https://github.com/pmndrs/three-stdlib) (`src/geometries/LightningStrike.js`)
- Copyright: 2010-2023 three.js authors; (c) 2021-2023 Poimandres
- Licence: MIT, see [`src/weather/LightningStrike.LICENSE.txt`](src/weather/LightningStrike.LICENSE.txt)
  (both notices)
- Files: `src/weather/LightningStrike.ts`: the recursive midpoint-displaced channel, its subrays
  (branches) in a cone around their parent, the triangular prism mesh and the seekable seeded
  generator.
- Changes: ported to TypeScript; the tree is built once per strike instead of every frame, and
  its propagation and vanishing moved to per-vertex times compared on the GPU; vertices keep their
  axis point so distant channels can be widened to a pixel; branches drop and lean out at set
  angles, are not recycled over time and stay above the sea; all randomness comes from one seed.
  `LightningStorm.js` was read but not used.

### VolumetricCloudsCS1

- Upstream: https://github.com/anthonytoumaibrahim/VolumetricCloudsCS1, by Anthony Ibrahim (a
  volumetric clouds mod for Cities: Skylines), commit
  [`83b5e78`](https://github.com/anthonytoumaibrahim/VolumetricCloudsCS1/tree/83b5e7802aa2ce8e72c3f6525cbd9fab3d0bde62)
- Copyright: (c) 2026 Anthony Ibrahim
- Licence: MIT, see [`src/sky/VolumetricCloudsCS1.LICENSE.txt`](src/sky/VolumetricCloudsCS1.LICENSE.txt)
  (the upstream file; its exception covers light halo shaders that are not used here)
- Files:
  - `src/weather/Lightning.ts`: each strike's profile (duration, return strokes, flicker
    reseed, power, reach, tint), the pulse envelope with its flicker and the in-cloud source depth,
    from `VolumetricClouds/Sky/LightningFlicker.cs` and `CloudLightning.cs`, ported from C#.
  - `src/sky/Clouds.ts`: the light of up to four point sources inside the cloud (an inverse-square
    core times an exponential reach) added inside the front-to-back march, from
    `CloudRaymarch.shader`, ported from HLSL to TSL.
  - `tools/bake-rainbow-table.mjs`: a port of `VolumetricClouds/Sky/RainbowTable.cs` to
    JavaScript (Airy theory per wavelength and drop size, primary and secondary bows with
    Fresnel, a Marshall-Palmer drop spectrum, CIE 1931 to linear sRGB, the solar disc). It
    generates `src/sky/RainbowTable.data.ts`, 512 RGB entries over 0 - 64 degrees from the
    antisolar point, rounded to four significant digits (13.7 kB of source).
  - The rain curtains in `src/sky/Clouds.ts` (`rainAt`): the rain march along the view ray under
    the clouds (`MarchRain` in `CloudRaymarch.shader`), the rain read from the weather map where
    a drop left the cloud base so the curtains lean with the wind (`SampleRain` in
    `CloudCommon.cginc`), the noise stretched along the fall and sliding down with it
    (`RainSigma` in `CloudMedia.cginc`), and the rainbow colours looked up by the angle from the
    antisolar point and lit by the sun reaching the rain (`BowColour`).
- Changes: ported to TSL and JavaScript; the curtains are shaped by this project's cloud shell,
  weather fronts and lingering showers, lit by the light under the cloud, and fade into this
  project's haze. The rainbow is drawn per camera in the rain it lights, not as the upstream's
  arch fixed in the world. For the lightning, strikes follow a seeded schedule of the scene clock
  instead of a random draw per frame; channels get sharp return strokes after their leader; the
  light is kept out of the view's accumulated history; reflections evaluate it where the ray meets
  the deck.

### threejs-conference collision rain

- Upstream: https://github.com/ektogamat/threejs-conference, by Anderson Mancini and Sunag
- Copyright: (c) 2026 Anderson Mancini and Sunag
- Licence: MIT, see [`src/weather/threejs-conference.LICENSE.txt`](src/weather/threejs-conference.LICENSE.txt)
- Files: `src/weather/RainCollision.ts` and `src/weather/RainDrops.ts`, after
  `src/world/weather/createCollisionHeight.js`, `createCollisionRain.js` and
  `docs/techniques/collision-rain.md`: a top-down orthographic pass that draws world height into a
  nearest-filtered half-float target, rain drops in a camera-centred toroidal volume moved by a
  compute pass that tests them against that map, and instanced billboards for the streaks and
  splashes. The same pattern is in the three.js example `webgpu_compute_particles_rain.html`
  (r186, MIT, three.js authors; the `three` package's licence ships with the build).
- Changes: rewritten in TypeScript for this scene. The map is drawn once from the island's own
  meshes with each material's rest pose and alpha test; drops are a stateless function of the
  clock, the wind's integrated travel and the camera (no per-frame random respawn), in nested
  volumes, searched along their wind-leaning path for the first surface; splashes (a crown with
  droplets on land, rings on the sea) are procedural. Nothing from the project's `public/`
  folder or its CC BY-NC-SA derived shaders (`rainRipples.js`, `surfaceRain.js`, `rainGlass.js`)
  is used.

### FSR 1 (AMD FidelityFX, through three.js's FSR1Node)

- Upstream: three.js `examples/jsm/tsl/display/FSR1Node.js` (r186), a TSL port of AMD FidelityFX
  Super Resolution 1 ([FidelityFX-FSR](https://github.com/GPUOpen-Effects/FidelityFX-FSR),
  `ffx_fsr1.h`: EASU and RCAS)
- Copyright: (c) 2021 Advanced Micro Devices, Inc.; 2010-2026 three.js authors
- Licence: MIT, see [`src/post/fsr.LICENSE.txt`](src/post/fsr.LICENSE.txt) (both notices)
- File: `src/post/FSR.ts`: the edge-adaptive upsampling (EASU) and the contrast-adaptive
  sharpening (RCAS).
- Changes: EASU runs as its own pass and fetches its 12 texels as four 2x2 gathers per channel
  (AMD's layout) where the input is filterable; RCAS is a function the frame graph's canvas pass
  calls before the grain, instead of a second canvas-sized pass and target; the unused alpha
  channel is dropped.

### FSR 2 (AMD FidelityFX, through tidewater)

- Upstream: tidewater's `src/post/TemporalUpscale.js` (commit 4811ba4, above), the accumulation of AMD
  FidelityFX Super Resolution 2 2.2 ([FidelityFX-FSR2](https://github.com/GPUOpen-Effects/FidelityFX-FSR2),
  `ffx_fsr2_accumulate.h`)
- Copyright: (c) 2022-2023 Advanced Micro Devices, Inc.; (c) 2026 DRG Software Solutions LLC
- Licence: MIT, see [`src/post/tidewater-fsr2.LICENSE.txt`](src/post/tidewater-fsr2.LICENSE.txt) (both
  notices)
- File: `src/post/TemporalLocks.ts`: the accumulation cap of a moving pixel, the temporal reactive
  factor carried to the next frame (its sign: the pixel moved) and the weight a clipped history
  drops.
- Changes: TSL; weights in frames' worth of a frame's weight instead of Lanczos sample weights;
  display-referred input; the reactive inputs left out of the carried factor, which scales the
  capped frames (after the cap, not before it) and is not set to 1 where the history is new; the
  clamp-drop only on moving pixels, to one frame, by how far the history lay outside the box.

### FSR 3 upscaler's history sample (AMD FidelityFX SDK)

- Upstream: [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) 2.3.0,
  FSR 3 upscaler 3.1.5: `upscalers/fsr3/include/gpu/fsr3upscaler/ffx_fsr3upscaler_sample.h` (the
  Lanczos 2 kernel, FSR 1's polynomial approximation of it, the 4 x 4 fetch and its deringing) and
  `ffx_fsr3upscaler_reproject.h` (the history sample at the reprojected position)
- Copyright: (C) 2026 Advanced Micro Devices, Inc.
- Licence: MIT (the MIT section of the SDK's `docs/license.md`), see
  [`src/post/fidelityfx-fsr3.LICENSE.txt`](src/post/fidelityfx-fsr3.LICENSE.txt)
- File: `src/post/TemporalHistory.ts`: the running temporal resolve's history fetch (taa, taau).
- Changes: HLSL to TSL; only the history sample; 32-bit only, no LUT; each axis's four weights
  computed once; the separable filter's two normalisations as one division.

### FSR 3 upscaler (AMD FidelityFX SDK)

- Upstream: [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) 2.3.0
  (commit 60f4ea8), FSR 3 upscaler 3.1.5: `upscalers/fsr3/include/gpu/fsr3upscaler/*.h`, the
  `ffx_fsr3upscaler_*_pass.hlsl` entry points, `spd/ffx_spd.h`, the RCAS part of `fsr1/ffx_fsr1.h`,
  the ffx_core helpers they call (`ffx_core_hlsl.h`, `ffx_core_gpu_common.h`, `ffx_core_cpu.h`) and
  the host maths of `internal/ffx_fsr3upscaler.cpp` and its headers
- Copyright: (C) 2026 Advanced Micro Devices, Inc.
- Licence: MIT (the MIT section of the SDK's `docs/license.md`), see
  [`src/post/fsr3/FidelityFX.LICENSE.txt`](src/post/fsr3/FidelityFX.LICENSE.txt)
- Files: `src/post/fsr3/*.ts`, one module per upstream file: the upscaler's passes (prepare inputs,
  luminance and shading-change pyramids, shading change, prepare reactivity, luma instability,
  accumulation, RCAS), its debug view, its reactive-mask generator, the single-pass downsampler,
  the bindings and resources, and the host's constants, jitter and clears.
- Changes: HLSL to TSL, line by line, upstream's names kept; 32-bit only (no FP16 or wave
  operations); WebGPU core formats in place of those that are not storage-capable or filterable;
  the reconstructed depth's texture atomics as a storage buffer; SPD's last-workgroup tail as a
  second dispatch; kernels dispatched over a fixed grid that skip the workgroups past upstream's
  counts. Each module's header lists its differences.

### meshoptimizer (through three.js)

- Upstream: [meshoptimizer](https://github.com/zeux/meshoptimizer) 1.1, by Arseny Kapoulkine, as
  three.js ships its simplifier (`examples/jsm/libs/meshopt_simplifier.module.js`, r186)
- Copyright: (c) 2016-2026 Arseny Kapoulkine
- Licence: MIT, see [`src/world/meshoptimizer.LICENSE.txt`](src/world/meshoptimizer.LICENSE.txt)
- File: `src/world/IslandSimplify.ts` runs it unchanged (`simplifyWithAttributes`) on the island's
  chunk meshes. It is bundled from the npm package, but the file's copyright comment does not
  survive the build, so the notice ships separately.

## Assets

These files are not in the repository: they ship in the assets release that `assets.lock.json`
names, under the paths given here in `public/` (`tools/assets.mjs`).

### Rock Face 03

- Author: Dario Barresi (photography), Rico Cilliers (processing)
- Source: [Poly Haven](https://polyhaven.com/a/rock_face_03)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: `public/textures/rock/rock_albedo.jpg` is the 1K diffuse map, unchanged.
  `public/textures/rock/rock_detail.png` packs the 1K OpenGL normal map's x and y (red, green) and
  the roughness map (blue), reduced to 8 bits.

### Brown Mud Leaves 01

- Author: Rob Tuytel
- Source: [Poly Haven](https://polyhaven.com/a/brown_mud_leaves_01)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: built by `tools/build-ground-textures.py` from the 1K maps.
  `public/textures/ground/meadow_albedo.jpg` is the diffuse map, unchanged;
  `public/textures/ground/meadow_detail.png` packs the OpenGL normal map's x and y (red, green) and
  the roughness map (blue). The open meadow's ground.

### Forest Ground 01

- Author: Rob Tuytel
- Source: [Poly Haven](https://polyhaven.com/a/forrest_ground_01)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: built by `tools/build-ground-textures.py` from the 1K maps, as Brown Mud Leaves 01:
  `public/textures/ground/grove_albedo.jpg` and `grove_detail.png`. The bamboo groves' floor.

### CGI Moon Kit

- Author: Ernie Wright, NASA's Scientific Visualization Studio, from Lunar Reconnaissance Orbiter
  data (LROC WAC colour mosaic, LOLA elevation)
- Source: [NASA SVS 4720](https://svs.gsfc.nasa.gov/4720/)
- Licence: public domain (NASA); credited as "NASA's Scientific Visualization Studio"
- Files: built by `tools/build-moon-textures.py` from `lroc_color_2k.jpg` and `ldem_4_uint.tif`.
  `public/sky/moon/moon_color.jpg` is the colour map halved to 1024 x 512 (a 2 x 2 average in
  linear light, re-encoded as sRGB JPEG). `public/sky/moon/moon_height.png` is the LOLA height
  grid area-averaged to 512 x 256, kept in the kit's 16-bit units (half-metres, +10 km) and split
  into its high byte (red) and low byte (green).

### Ultimate Modular Men Pack

- Author: Quaternius
- Source: [quaternius.com](https://quaternius.com/packs/ultimatemodularcharacters.html) (February 2022;
  the pack's own `License.txt` calls it "Ultimate Modular Males")
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: parts of `Farmer.gltf` (its rig, clips and feet), `Adventurer.gltf` and `Casual_2.gltf`,
  recoloured into the island's palette (the kit-dressed islanders, `look=kit`, their colour
  variants in `src/characters/looks.ts`), given procedural pointed ears and merged into one
  skinned mesh at load time. The Hanming islanders are built from them in Blender: the Farmer's
  rig and clips, the Casual 2 head without its hair, the Beach outfit's body, legs and sandalled
  feet, under a feather-carrying shell and a revolved bamboo hat of our own, with a woman's dress
  and shape keys of our own for a woman's figure, a child's and an elder's. The three kit files
  are `public/characters/quaternius/ultimate-modular-characters/`, unchanged; the Hanming
  islanders are `public/characters/hanming/Hanming.gltf` and `Hanming.bin`.

### A single white feather closeup

- Author: João Estevão Andrade de Freitas
- Source: [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:A_single_white_feather_closeup.jpg)
  (2004, from stock.xchng)
- Licence: public domain
- Files: cut out of its dark ground (the ground un-mixed from the edge's colour) into four feather
  shapes in a 2048 x 1024 atlas, the Hanming islanders' feather cards
  (`public/characters/hanming/textures/feather-atlas.png`).

### Wicker 005

- Author: ambientCG (Lennart Demes)
- Source: [ambientCG](https://ambientcg.com/view?id=Wicker005)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: the colour, normal and roughness maps reduced to 512 px, the Hanming islanders' bamboo
  hats, tinted to straw in `src/characters/FigureSurfaces.ts`
  (`public/characters/hanming/textures/wicker-*`).

### Cloud shape noise

- Author: Daniel Greenheck, from the Three.js Sky Pro clouds as bundled with tidewater
- Source: `public/clouds/baseShape64.bin` in [tidewater](https://github.com/dgreenheck/tidewater) at commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef)
- Licence: tidewater's repository is MIT licensed (see `src/sky/tidewater.LICENSE.txt`). The
  `LICENSING.md` beside this file in `public/clouds/` says the textures it lists "are not covered by
  the Three.js Sky Pro license", which suggests the other files there, this one included, come
  under that licence.
- Files: `public/clouds/baseShape64.bin`, unchanged: a gzip-compressed 64^3 RGBA8 Perlin-Worley
  shape noise with its mip chain.

### Yale Bright Star Catalogue

- Authors: D. Hoffleit and W. H. Warren Jr., *The Bright Star Catalogue*, 5th Revised Ed. (1991),
  Astronomical Data Center, NASA Goddard Space Flight Center
- Source: the CDS catalogue [V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50) (`catalog.gz` and
  its `ReadMe`)
- Licence: none stated; the CDS distributes the catalogue freely and asks for an acknowledgement,
  which this entry is.
- Files: `public/sky/stars.bin`, written by `tools/build-star-catalog.mjs`: for each of the 9096
  stars with a position, the J2000 right ascension and declination, the V magnitude and a colour
  from B-V (see the star colours under Acknowledgements), 8 bytes per star.

### Deep Star Maps 2020 (Milky Way)

- Credit: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.
- Source: [NASA SVS 4851](https://svs.gsfc.nasa.gov/4851), `milkyway_2020_4k.exr` (the Milky Way
  background in celestial coordinates)
- Licence: NASA SVS asks for the credit line above.
- Files: `public/sky/milkyway.png`, written by `tools/build-milky-way.py`: the luminance halved,
  cleared of residual point sources by a median filter, reduced to 1024 x 512, blurred along right
  ascension toward the poles, and stored as the square root of its share of the brightest star
  clouds in 8 bits.

### LXGW WenKai GB (霞鹜文楷 GB)

- Author: LXGW, from Fontworks' Klee One; web font package `lxgw-wenkai-gb-web` by CM_Bill
- Source: [LxgwWenKaiGB](https://github.com/lxgw/LxgwWenKaiGB), through npm
  [`lxgw-wenkai-gb-web`](https://www.npmjs.com/package/lxgw-wenkai-gb-web)
- Licence: SIL Open Font License 1.1, see
  [`src/game/ui/fonts/LXGWWenKaiGB.OFL.txt`](src/game/ui/fonts/LXGWWenKaiGB.OFL.txt)
- Files: the regular weight as the package ships it, sliced by `unicode-range` into small WOFF2
  files, so a page loads only the slices its characters need; the game interface's running text
  (`src/game/ui/GameUi.ts`). Unchanged.

### Ma Shan Zheng (马善政)

- Author: The MaShanZheng Project Authors (Ma Shan Zheng); web font package by Fontsource
- Source: [googlefonts/mashanzheng](https://github.com/googlefonts/mashanzheng), through npm
  [`@fontsource/ma-shan-zheng`](https://www.npmjs.com/package/@fontsource/ma-shan-zheng)
- Licence: SIL Open Font License 1.1, see
  [`src/game/ui/fonts/MaShanZheng.OFL.txt`](src/game/ui/fonts/MaShanZheng.OFL.txt)
- Files: the package's `unicode-range` slices, unchanged; the game interface's calligraphy (the
  day, name tags, the record's title).

## Acknowledgements

Published techniques this project implements without using their code; each is also credited in a
comment where it is used.

- FFT ocean: J. Tessendorf,
  [*Simulating Ocean Water*](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf)
  (SIGGRAPH course notes, 2002 revision).
- Hex-tiling's predecessor, by-example noise that blends randomly placed tiles with a
  histogram-preserving blend: Eric Heitz and Fabrice Neyret,
  [*High-Performance By-Example Noise using a Histogram-Preserving Blending Operator*](https://eheitzresearch.wordpress.com/722-2/)
  (HPG 2018).
- Height-based blending of terrain layers (moss, turf, soil, lichens, runoff stains on the stone):
  Andrey Mishkinis, *Advanced Terrain Texture Splatting* (Gamasutra, 2013), and the height lerp
  of Unreal Engine's landscape materials.
- Whiteout triplanar normal blend: Ben Golus,
  [*Normal Mapping for a Triplanar Shader*](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) (2017).
- Overcast sky's luminance by elevation, ( 1 + 2 sin h ) / 3 (`src/weather/VolumetricHaze.ts`, overcast's deck):
  P. Moon and D. E. Spencer, *Illumination from a Non-Uniform Sky* (Illuminating Engineering 37,
  1942): the CIE standard overcast sky, as given in ISO 15469:2004 / CIE S 011/E:2003,
  *Spatial distribution of daylight - CIE standard general sky*.
- Atmosphere LUTs and multiple scattering: Sébastien Hillaire,
  [*A Scalable and Production Ready Sky and Atmosphere Rendering Technique*](https://sebh.github.io/publications/egsr2020.pdf)
  (EGSR 2020), through the adapted tidewater source above.
- Line integral convolution, which draws the thin cloud layer's fibres out along a flow
  (`src/sky/Streaks.ts`): Brian Cabral and Leith (Casey) Leedom, *Imaging Vector Fields Using
  Line Integral Convolution* (SIGGRAPH 1993), through the adapted tidewater source above.
- The ozone's absorption per display channel (`src/sky/Atmosphere.ts` OZONE), our integration over
  each channel's band of the cross sections of A. Serdyuchenko, V. Gorshelev, M. Weber, W. Chehade
  and J. P. Burrows,
  [*High spectral resolution ozone absorption cross-sections – Part 2: Temperature dependence*](https://doi.org/10.5194/amt-7-625-2014)
  (Atmospheric Measurement Techniques 7, 2014; data from IUP Bremen), through linear Rec. 709
  responses from the CIE 1931 2° colour matching functions (CVRL, UCL). Only the three integrated
  values are used; no data ships.
- Solar radiance normalisation:
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals),
  the projected-solid-angle irradiance integral.
- Air/water interface: Snell's law and dielectric transport as described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Reflection_Models/Dielectric_BSDF).
- The figures' shadow map read with a 5 x 5 texel tent from nine bilinear comparisons, in
  `src/characters/CharacterShadow.ts`: Ignacio Castaño, *Shadow Mapping Summary – Part 1* (The
  Witness blog, 2013), its weights for a tent filter made of fewer bilinear PCF taps. Used as a
  technique only.
- Local sky occlusion: John C. Hart, [*Sphere Tracing*](https://doi.org/10.1007/s003710050084) (1996),
  with the [cosine-weighted hemisphere sampler in PBRT](https://pbr-book.org/4ed/Sampling_Algorithms/Sampling_Multidimensional_Functions).
- Filtered wave-slope moments: Marc Olano and Dan Baker,
  [*LEAN Mapping*](https://userpages.cs.umbc.edu/olano/papers/lean/) (I3D 2010).
- The sea's mean reflection over the slopes no pixel resolves, in `src/ocean/Water.ts`: the
  visible facets weighted by their projected area and Smith's shadowing of the reflected rays, from
  Eric Heitz,
  [*Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs*](https://jcgt.org/published/0003/02/03/)
  (JCGT 2014); Smith's G1 for Gaussian (Beckmann) slopes in the rational form of Bruce Walter,
  Stephen R. Marschner, Hongsong Li and Kenneth E. Torrance,
  [*Microfacet Models for Refraction through Rough Surfaces*](https://www.graphics.cornell.edu/~bjw/microfacetbsdf.pdf)
  (EGSR 2007); the error-function approximation is Abramowitz and Stegun, equation 7.1.26.
- The shared specular BRDF, in `src/lighting/SurfaceBRDF.ts` and `src/lighting/EnvironmentBRDF.ts`:
  Smith's visibility for GGX in Schlick's form with k = alpha / 2, and the environment's specular
  as the split sum, the prefiltered environment times the environment BRDF integrated for the
  same GGX into a scale and a bias on F0, and the key's glint from a representative point, the
  point of the key's disk closest to the reflected ray, its highlight renormalised by the widened
  lobe's ( alpha / alpha' )^2, from Brian Karis,
  [*Real Shading in Unreal Engine 4*](https://cdn2.unrealengine.com/Resources/files/2013SiggraphPresentationsNotes-26915738.pdf)
  (SIGGRAPH 2013 Physically Based Shading course notes); the closest point applied to a disk
  light as in Sébastien Lagarde and Charles de Rousiers,
  [*Moving Frostbite to Physically Based Rendering 3.0*](https://seblagarde.wordpress.com/wp-content/uploads/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf)
  (SIGGRAPH 2014 Physically Based Shading course notes). GGX's alpha as the perceptual roughness
  squared, Disney's reparameterisation as Karis 2013 (above) adopts it from Brent Burley,
  *Physically-Based Shading at Disney* (SIGGRAPH 2012 Physically Based Shading course notes); the
  Fresnel's value at grazing angles from F0, saturate( 50 F0 ), Christian Schüler's rule (ShaderX7,
  2009) as given by Lagarde and de Rousiers (above). Used as techniques only; the table's layout,
  the widened alpha and the glint's clamp at grazing views are our own.
- Volumetric clouds: Andrew Schneider,
  [*The Real-time Volumetric Cloudscapes of Horizon Zero Dawn*](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn)
  (SIGGRAPH 2015): Perlin-Worley shape noise, Worley erosion, weather-map coverage and height
  profiles.
- Lunar shading: Yasuhiro Fujii,
  [*A tiny improvement of Oren-Nayar reflectance model*](https://mimosa-pudica.net/improved-oren-nayar.html),
  through the adapted three-geospatial source above.
- Star colours: the effective temperature from B-V of F. J. Ballesteros,
  [*New insights into black bodies*](https://doi.org/10.1209/0295-5075/97/34008) (EPL 97, 2012),
  then Planck's law weighted by the CIE 1931 colour matching functions in the analytic fit of
  C. Wyman, P.-P. Sloan and P. Shirley,
  [*Simple Analytic Approximations to the CIE XYZ Color Matching Functions*](https://jcgt.org/published/0002/02/01/)
  (JCGT 2013), and the sRGB matrix (`tools/build-star-catalog.mjs`).
- Crepuscular rays: Kenny Mitchell,
  [*Volumetric Light Scattering as a Post-Process*](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process)
  (GPU Gems 3, 2007): a radial blur of the open sky toward the sun.
- Raindrop rings: Sébastien Lagarde,
  [*Water drop 2b – Dynamic rain and its effects*](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/)
  (2013): the ring profile sin( clamp( 9 ( t - r ), 0, 3 ) pi ), a wave and a half behind the
  front, for the rain's ring sprites on the sea.
- Whitecaps: the horizontal Jacobian of the displaced surface as a breaking criterion, after
  J. Tessendorf, *Simulating Ocean Water* (above).
- Wet surfaces: Sébastien Lagarde,
  [*Water drop 3a – Physically based wet surfaces*](https://seblagarde.wordpress.com/2013/03/19/water-drop-3a-physically-based-wet-surfaces/)
  and [*Water drop 3b – Physically based wet surfaces*](https://seblagarde.wordpress.com/2013/04/14/water-drop-3b-physically-based-wet-surfaces/)
  (2013): porosity from roughness, darkening and gloss as the pores fill, a water film with water's
  specular reflectance and a flattened normal, and puddles whose shallow edges keep the ground's
  relief. The darkening uses the total-internal-reflection model of J. Lekner and M. C. Dorf,
  *Why some things are darker when wet* (Applied Optics 27, 1988), as summarised there. Rain rings
  on puddles: Lagarde,
  [*Water drop 2b – Dynamic rain and its effects*](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/)
  (2013), its ripple texture's terms computed analytically per cell. In `src/materials/Wetness.ts`
  and `src/weather/Puddles.ts`.
- Depth-dependent water shadows: the volume-lighting integral described in
  [*Physically Based Rendering*, third edition](https://pbr-book.org/3ed-2018/Light_Transport_II_Volume_Rendering/Volumetric_Light_Transport),
  independently implemented in TSL with exponential depth strata, exact per-channel attenuation
  weights and separate air/submerged visibility along each scattering point's refracted solar path.
  No source code is copied; the retained multiple-scattering boost is empirical.
- Coverage-preserving alpha mips for the leaves: Ignacio Castano,
  [*Computing Alpha Mipmaps*](http://the-witness.net/news/2010/09/computing-alpha-mipmaps/) (2010):
  each mip keeps the full-size leaf's share above the alpha-test cutoff, remapped through a steep
  ramp instead of a scale so alpha-to-coverage keeps leaves solid (`src/world/vegetation/LeafTexture.ts`).
- Rainbow colours (through the adapted table bake above): G. B. Airy, *On the intensity of light
  in the neighbourhood of a caustic* (Trans. Camb. Phil. Soc., 1838); J. S. Marshall and W. M.
  Palmer, *The distribution of raindrops with size* (J. Meteorology 5, 1948); C. Wyman, P.-P. Sloan
  and P. Shirley, [*Simple Analytic Approximations to the CIE XYZ Color Matching Functions*](https://jcgt.org/published/0002/02/01/)
  (JCGT 2013). The baked bows peak where the classic values put them: the primary's red at about
  42 degrees from the antisolar point, the secondary's at about 51.
- Upscaling a render below the display's resolution: AMD FidelityFX Super Resolution 1 (EASU
  edge-adaptive upsampling and RCAS sharpening), [GPUOpen](https://gpuopen.com/fidelityfx-superresolution/);
  the code is adapted from three.js's `FSR1Node` (see "FSR 1" above).
- Tone curve: Troy Sobotka's [AgX](https://github.com/sobotka/AgX), through three.js's
  `agxToneMapping` (Benjamin Wrensch's
  [minimal AgX fit](https://iolite-engine.com/blog_posts/minimal_agx_implementation)); the hue-kept
  highlights scale each colour by its brightest channel as Khronos'
  [PBR Neutral](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral) does.
- Default tone curve: Khronos' [PBR Neutral](https://github.com/KhronosGroup/ToneMapping/tree/main/PBR_Neutral)
  (Emmett Lalish's curve, as in three.js's `neutralToneMapping`), reimplemented in TSL without its
  desaturation toward white so highlights keep their hue.
- Depth of field, highlights averaged compressed by their luminance (c / (1 + L)) and expanded
  again: Brian Karis, [*Tone mapping*](https://graphicrants.blogspot.com/2013/12/tone-mapping.html)
  (2013).
- Depth of field, gather taps weighted by depth order (a tap behind the pixel reaches no further
  than the pixel's own blur): Jorge Jimenez,
  [*Next Generation Post Processing in Call of Duty: Advanced Warfare*](https://www.iryoku.com/next-generation-post-processing-in-call-of-duty-advanced-warfare)
  (SIGGRAPH 2014 course *Advances in Real-Time Rendering in Games*).
- The fantasy look's glow: Michael Orton's "Orton imagery" (slide sandwiches of a sharp and an
  overexposed, defocused exposure of the same view, 1980s), as a blurred copy of the highlights added
  back over the image (`src/post/Pipeline.ts`). Its hue-selective colour follows the secondary
  (HSL-keyed) correction of colour grading, and its warm / cool split the photographic split tone.
- Sharp cliff edges on the island mesh (vertices placed at the least-squares point of the edge
  crossings' tangent planes): Tao Ju, Frank Losasso, Scott Schaefer and Joe Warren,
  [*Dual Contouring of Hermite Data*](https://www.cs.rice.edu/~jwarren/papers/dualcontour.pdf)
  (SIGGRAPH 2002).
- Rounded rims of the cliff's scars, the polynomial smooth maximum of two distance fields:
  Inigo Quilez, [*smooth minimum*](https://iquilezles.org/articles/smin/), used as a technique only.
- Telling a mouse wheel from a trackpad's scroll by its deltas (macOS reports a wheel notch in
  multiples of 4.000244140625 px; deltas under 4 px are a trackpad's): the scroll zoom handler of
  [Mapbox GL JS](https://github.com/mapbox/mapbox-gl-js/blob/main/src/ui/handler/scroll_zoom.ts),
  used as a technique only (`src/camera/IslandCameraControls.ts`).
- A drag sampled at a fixed delay behind the frame, interpolated between the input samples around
  it, so a steady drag moves the view by the same amount every frame: the input resampling of
  Android's `InputTransport` (`RESAMPLE_LATENCY`), used as a technique only.
- Vegetation wind in layers (the whole plant bent from its root keeping each vertex's distance to
  it; a detail bend of each branch on a phase of its own; leaf edges fluttering along the normal;
  smoothed triangle waves in place of sines): Tiago Sousa,
  *Vegetation Procedural Animation and Shading in Crysis* (GPU Gems 3, chapter 16, 2007), in
  `src/world/vegetation/Deform.ts` (`mainBend`; the branches' and sprays' bends, `branchBend` and
  `sprayBend`; `leafFlutter`) and `src/weather/Wind.ts` (`flutterWave`, the smooth triangle wave).
  Used as techniques only; the branches pressed downwind across the wind, the sprays' bend on their
  branch and the numbers are our own.
- The island's growth (`src/world/IslandGrowth.ts`): coastlines as the level sets of a fractal
  surface, after Benoit B. Mandelbrot, *The Fractal Geometry of Nature* (1982); islands shaped
  from noise, after Amit Patel, [*Making maps with noise*](https://www.redblobgames.com/maps/terrain-from-noise/)
  (Red Blob Games); the relief's domain warp, after Inigo Quilez,
  [*Domain warping*](https://iquilezles.org/articles/warp/); each new piece grown as invasion
  percolation, after David Wilkinson and Jorge F. Willemsen, *Invasion percolation: a new form
  of percolation theory* (Journal of Physics A 16, 1983), with the priority queue of Richard
  Barnes, Clarence Lehman and David Mulla, *Priority-Flood: An optimal depression-filling and
  watershed-labeling algorithm for digital elevation models* (Computers & Geosciences 62, 2014).
- Temporal anti-aliasing and upsampling (`src/post/TemporalAA.ts`, `Jitter.ts`, `Motion.ts`): a
  Halton (2, 3) sub-pixel jitter, the motion of the nearest surface in a 3x3 neighbourhood and a
  clipped history, after Brian Karis,
  [*High Quality Temporal Supersampling*](https://advances.realtimerendering.com/s2014/) (SIGGRAPH
  2014), and Lasse Jon Fuglsang Pedersen,
  [*Temporal Reprojection Anti-Aliasing in INSIDE*](https://github.com/playdeadgames/temporal)
  (Playdead, GDC 2016); variance clipping in YCoCg: Marco Salvi, *An Excursion in Temporal
  Supersampling* (GDC 2016); the history fetched by FSR 3.1's Lanczos 2 sample with its deringing
  (its code is listed under "FSR 3 upscaler's history sample" above); the current frame's samples weighted by their
  distance to each output pixel with the accumulated weight kept in the history, reactive masks that limit the history where nothing
  describes the motion (rain, spray, a lightning strike), and TAAU's split into a pass at the
  render's size that takes what depends only on the nearest input pixel (the clip box, the nearest
  motion and depth) and the resolve at the canvas's size, after FSR 2's reconstruct-and-dilate
  pass: AMD FidelityFX Super Resolution 2
  ([its documentation](https://gpuopen.com/manuals/fidelityfx_sdk/techniques/super-resolution-temporal/))
  and Unreal Engine's Temporal Super Resolution, used as techniques (FSR 2's code that is used is
  listed under "FSR 2" above); no code of three.js's `TRAANode` or `TAAUNode` is used. A history
  rejected where the motion it was written with differs from this pixel's: after Unity HDRP's TAA
  (motion vector rejection) and Unreal's TSR (history rejection), as a technique.
- The frame graph (`src/post/graph/`: passes that declare what they read and write, versioned
  resources, the declared order checked, passes nothing reads culled, the attachments' load and
  store derived from the passes that run): Yuriy O'Donnell,
  [*FrameGraph: Extensible Rendering Architecture in Frostbite*](https://www.gdcvault.com/play/1024612/FrameGraph-Extensible-Rendering-Architecture-in)
  (GDC 2017), used as a technique only.
- The tolerance that compares temporal AA captures (`tools/parity/tolerance.py`): a per-pixel
  level with the share of pixels over it bounded on the frame and in local blocks, and a mean
  error, after Unity's Graphics Test Framework (`ImageComparisonSettings`) and Unreal Engine's
  automation screenshot comparison (`FAutomationScreenshotTolerance`); NVIDIA FLIP (Andersson et
  al., *FLIP: A Difference Evaluator for Alternating Images*, HPG 2020) is reported through the
  optional `flip-evaluator` package (BSD-3-Clause). Used as techniques only.
- Gusts as a noise field scrolled with the wind, sweeping across the grass: techniques Eric
  Wohllaib and Bill Rockenbeck presented (Eric Wohllaib, *Procedural Grass in 'Ghost of Tsushima'*, GDC 2021:
  2D Perlin noise scrolled in the wind's direction; Bill Rockenbeck,
  *Blowing from the West: Simulating Wind in Ghost of Tsushima*, GDC 2021: the wind's strength
  varied by time-varying Perlin noise), in `src/weather/Wind.ts` (`gustAt`, read by `windField`,
  the meadow's blades and the sea's gusts). Used as a technique only; the noise's time axis, the
  wind's integrated travel and time, the scale and the strength's linear law are our own.
  The noise is Ken Perlin's improved gradient noise (*Improving Noise*, SIGGRAPH 2002) in 3D, made
  periodic; its lattice is hashed by PCG's output permutation (Mark Jarzynski and Marc Olano,
  *Hash Functions for GPU Rendering*, Journal of Computer Graphics Techniques 9(3), 2020).
- The displacement field the islanders part the meadow through: a 2D displacement buffer about
  the camera, written by particles of their own kind, a technique Bill Rockenbeck presented
  (*Blowing from the West: Simulating Wind in Ghost of Tsushima*, GDC 2021), in `src/world/vegetation/Displacement.ts`. Used as a technique only; the window's size,
  the analytic sprites and their strengths from the trail's recovery are our own. Its readers
  sample it with a cubic B-spline in four bilinear taps: Christian Sigg and Markus Hadwiger, *Fast
  Third-Order Texture Filtering* (GPU Gems 2, chapter 20, 2005).
- The meadow's procedural blades, techniques Eric Wohllaib presented
  (*Procedural Grass in 'Ghost of Tsushima'*, GDC 2021), in `src/world/Grass.ts`:
  single blades instead of cards; one blade per cell of a tile grid, offset at random and culled
  by distance and by the view; the ground map's texel picked at random among the four nearest,
  weighted by the position, so the meadow's edge is dithered; sixteen numbers a blade; Voronoi
  clumps (the nearest of nine jittered points) that set their blades' height and facing and draw
  them toward their centre (`CLUMP`); the camera's position among what shapes a blade (`NEAR`);
  compute passes that count the blades and write the indirect draw's arguments; vertices made
  from the vertex and instance index alone, 15 to a blade, the rows' spacing along it a parameter
  of its own (`ROWS`), the near tiles keeping one blade of four where the far ones take over
  (`LOD`); a short blade folded into two leaves on one strip (an idea the talk credits to
  Outerra); a quadratic Bezier whose tip the tilt and facing place and whose middle control point
  the bend pushes off the chord, the width stepped along the axis square to the facing and the
  normal from the curve's derivative and that axis (`bladeVertex`); the facing taken from the wind
  (`bladeFacing`) and a sine's bob phased by each blade's hash and the place along it (`swingAt`);
  normals tilted outward for a rounded blade, edge-on blades thickened across the view
  (`THICKEN`), and far off the normal leaned toward a common one and the gloss lowered
  (`SURFACE`); the colour along the blade, chosen per clump between two columns kept close
  (`BLADE_COLOUR`); the light through the blade and its occlusion given along its length
  (`TRANSLUCENCY`, `AO`); and the grass's shadow from the ground raised to the blades' height
  (`meadowLayerLight`; the crowns' heights the turf is shaded by: `src/world/SwardField.ts`,
  `src/lighting/MeadowCanopy.ts`) with screen-space shadows for the detail
  (`src/post/MeadowShade.ts`). Used as techniques only; the far draw of fewer rows, the folded
  blade's shared root row, the shadow worked out where it is received and the numbers are our own.
- The meadow's blades bent by their sway (`SWING`, `swingPush` in `src/world/Grass.ts`): the
  Euler-Bernoulli relation of a beam's curvature to its bending moment (M = EI kappa), the blade's
  curvature following the moment of the drag along it. Used as a technique only; the bend from the
  root is our own.
- Short blades folded into two leaves, and each level of the grass's distance LOD halving the
  blades and doubling the width of the rest: Outerra,
  [*Procedural grass rendering*](https://outerra.blogspot.com/2012/05/procedural-grass-rendering.html)
  (2012-05-27), in `src/world/Grass.ts`. Used as techniques only.
- Screen-space shadows for the key light over the depth: a technique Graham Aldridge presented
  for *Days Gone* (Sony Creators Conference / SIGGRAPH 2023), in `src/post/MeadowShade.ts`, as a plain
  per-pixel march. Used as a technique only.
- The display chain, techniques Jasmin Patry presented
  (*Real-Time Samurai Cinema: Lighting, Atmosphere, and Tonemapping in Ghost of Tsushima*, SIGGRAPH 2021
  Advances in Real-Time Rendering in Games course): local tone mapping as a
  detail-preserving contrast change on a 64x32x64 bilateral grid blended 40 / 60 with a wide
  Gaussian (`src/post/LocalTone.ts`), per-channel tone mapping in AP1 with its red primary moved
  out to x 0.75 and a white balance chosen as the colour white becomes, folded into the curve's
  input matrix (`src/post/ToneSpace.ts`), 32^3 grade tables used conservatively (blending two is
  ours: `src/post/GradeLut.ts`), and an exposure metered primarily from the illuminance rather than
  the frame's luminance (`src/post/Exposure.ts`). Used as techniques only; the tables' content
  and the exposure's compensation are our own. The exposure's compensation looked up by the
  metered EV: the exposure compensation curve of Unreal Engine's auto exposure. The
  bilateral grid: Jiawen Chen, Sylvain Paris and Frédo Durand, *Real-time Edge-Aware Image
  Processing with the Bilateral Grid* (SIGGRAPH 2007). The white balance's chromatic adaptation:
  the von Kries transform in K. M. Lam's Bradford cone space (1985). The curve itself is Stephen
  Hill's fit of ACES's RRT and ODT, as three.js's `acesFilmicToneMapping` has it (its matrices, now
  without their saturation). The tables are
  generated from parameters in Björn Ottosson's Oklab (*A perceptual color space for image
  processing*, 2020): its lightness, chroma and hue for the zones, the contrast curve and the hue
  bands (`src/post/GradeLut.ts`); the shadows / midtones / highlights split is an editor's colour
  wheels'. Used as techniques only. The tone curve's family is Timothy Lottes's (*Advanced
  Techniques and Optimization of HDR Color Pipelines*, GDC 2016): contrast, shoulder, white point
  and mid grey, its two constants solved from them (`src/post/Pipeline.ts`); its bent toe and its
  defaults (at first fitted to Hill's curve, now set on our own frames) are ours.
- The clouds' two phase lobes, all back lobe deep in the cloud and blended toward their share
  where the light gets through by the light's transmittance through each step
  (`src/sky/Clouds.ts`), after the same talk (Patry 2021, p. 97). Used as a technique only; the
  lobes are tidewater's droplet phase's first order (above).
- The thin cloud layer's density lowered where its position on the layer moves fast with the
  panorama's texture coordinate, so the far layer shows an even veil rather than sparkle
  (`src/sky/Clouds.ts` `streaksAt`), after the same talk (Patry 2021, p. 94-96), and its two phase
  lobes weighted by the light through the layer, after p. 97. Used as techniques only; the fade's
  scale, the lobes' blend and the layer's gains are ours.
- The Purkinje shift after the same talk (Patry 2021, p. 160-168: the rods' change to the cones'
  signals in an opponent colour space, with the constants and the shader's form it gives), in
  `src/post/Purkinje.ts`; the model is Dingcai Cao, Joel Pokorny, Vivianne C. Smith and Andrew J.
  Zele, *Rod contributions to color perception: linear with rod contrast* (Vision Research 48,
  2008), the receptors' curves normalised as Adam G. Kirk and James F. O'Brien have them
  (*Perceptually Based Tone Mapping for Low-Light Conditions*, SIGGRAPH 2011), and the RGB
  colours' spectra follow Brian Smits's method (*An RGB-to-Spectrum Conversion for Reflectances*,
  Journal of Graphics Tools, 1999). Its matrices are computed from the CIE 1931 2-degree colour
  matching functions, Andrew Stockman and Lindsay T. Sharpe's 2-degree cone fundamentals (2000)
  and the CIE 1951 scotopic luminous efficiency, as the Colour & Vision Research Laboratory's
  database (cvrl.org) has them, and the CIE's standard illuminant D65. Used as a technique only;
  the input's scale and the strength are ours.
- The ambient light's probes after the same talk (Patry 2021, its diffuse indirect lighting), in
  `src/world/AmbientProbes.ts`: a regular grid of probes in degree-2 spherical harmonics (p. 16),
  each baked with its sky visibility, mono, for the sky's harmonics to be multiplied by at run time
  (p. 24), and its bounced sky visibility, the world lit by a uniform white sky, for the sky's
  average colour to be multiplied by (p. 25). Used as techniques only; the lattice, the rays, the
  occluders and the albedos are our own. Probes caught in a solid moved to the nearest free point or
  marked invalid: Zander Majercik, Adam Marrs, Josef Spjut and Morgan McGuire, *Scaling Probe-Based
  Real-Time Dynamic Global Illumination for Production* (JCGT 10(2), 2021). The harmonics' basis and
  cosine lobe: Ravi Ramamoorthi and Pat Hanrahan, *An Efficient Representation for Irradiance
  Environment Maps* (SIGGRAPH 2001).
- The ambient light's relight after the same talk (Patry 2021), in `src/lighting/AmbientRelight.ts`
  and `src/lighting/Harmonics.ts`: the sky's radiance projected onto the harmonics and multiplied by
  each probe's sky visibility (p. 24), the bounced sky visibility lit by the sky's average (p. 25,
  from the constant band; we take the upper half's mean), the sun's bounce as two windowed lobes off
  an imaginary ground and wall facing the sun (pp. 32-33), the directionality boost toward the
  linear band's maximum (p. 43) and the deringing window found on the GPU (p. 46). Used as
  techniques only; the lobes' weights, the search for the minimum and the output's layout are our
  own. The product of two functions in the harmonics through their triple integrals: Peter-Pike
  Sloan, *Stupid Spherical Harmonics (SH) Tricks* (GDC 2008). The window: Peter-Pike Sloan,
  *Deringing Spherical Harmonics* (SIGGRAPH Asia 2017 Technical Briefs). The cosine lobe:
  Ramamoorthi and Hanrahan (2001, above).
- The materials' reading of the ambient light's probes, in `src/lighting/AmbientSample.ts`: the
  probes' irradiance evaluated at each surface's normal from their harmonics, degree 1 or 2 by the
  receiver (Ramamoorthi and Hanrahan 2001, above), blended into the open sea's at the box's edge,
  and for the translucent receivers through band weights projected from their wrapped lobe by the
  same paper's Legendre coefficients of a clamped cosine;
  and the environment's specular normalised by the irradiance where it is read, after the same
  talk (Patry 2021, p. 63: the reflection probes' luminance normalised by a single sample of the
  harmonics' irradiance, converted to luminance), here the ratio of the local irradiance's
  luminance to that of the environment's own harmonics at the same normal, capped. The specular's
  occlusion by a cone round the reflected direction, its half-angle from the lobe's roughness,
  against an occluder: after Sébastien Lagarde and Charles de Rousiers, *Moving Frostbite to
  Physically Based Rendering 3.0* (above, its specular occlusion), here against the surface's own
  horizon. Used as techniques only; the sampling point's offsets, the seam's blend, the ratio's
  form and cap, and the cone's test against the horizon, its form and its constants are our own.
  The sample moved off the surface along its normal and toward the eye against leaks through thin
  walls: after Majercik et al. (2021, above).
- The volumetric haze after the same talk (Patry 2021, its atmospheric lighting and volumetric
  haze), in `src/weather/VolumetricHaze.ts`: a froxel grid over the whole view from 10 cm to
  100 km in slices each 20 % deeper than the last, a density made only of analytic, integrable
  height functions (exponential layers and a sigmoidal layer), the key light's shadow sampled at a
  jittered point per froxel and filtered over frames (its share alone, not the light), Mie light
  by the shadow and the rest by an ambient occlusion, the in-scattered light stored divided by its
  opacity with the opacity recomputed exactly per pixel (density anti-aliasing), and a tricubic
  B-spline lookup. Used as techniques only; the densities and the light's balance are our own.
  The froxel volume itself: Bartlomiej Wronski, *Volumetric Fog: Unified Compute Shader-Based
  Solution to Atmospheric Scattering* (SIGGRAPH 2014 Advances in Real-Time Rendering course), and
  Michal Drobot, *Rendering of Call of Duty: Infinite Warfare* (Digital Dragons 2017).
  The tricubic B-spline in eight trilinear taps, and the cloud shadow map's cubic B-spline in four
  bilinear taps (`src/sky/Clouds.ts`): Christian Sigg and Markus Hadwiger, *Fast Third-Order
  Texture Filtering* (GPU Gems 2, 2005). The jitter's per-froxel offset: Jorge
  Jimenez's interleaved gradient noise (*Next Generation Post Processing in Call of Duty: Advanced
  Warfare*, SIGGRAPH 2014).
- The ambient grade after the same talk (Patry 2021, p. 10) and
  Jasmin Patry, *Samurai Shading in Ghost of Tsushima* (SIGGRAPH 2020 Physically Based Shading course, p. 9): global knobs on the
  lighting, among them the ambient diffuse and specular balance and the sky's brightness, set per
  weather and time of day over physically based lighting, in `src/lighting/AmbientGrade.ts`. Used
  as a technique only; the table's knobs, rows and values are our own.
- The vegetation's wrapped diffuse, in `src/world/VegetationLighting.ts`: the half-Lambert's shape,
  the cosine scaled by a half, biased by a half and squared, from Jason Mitchell, *Shading in
  Valve's Source Engine* (SIGGRAPH 2006, slide 25); a translucency kept energy-conserving beside
  the Lambertian diffuse, after Patry 2020 (above, p. 9, its notes). Used as techniques only; the
  normalisation to the clamped cosine's integral over the sphere, the blend between them by
  translucency and the light through the blades and leaves (`src/world/vegetation/Material.ts`
  `transmission`) are our own, but for its forward lobe, Schlick's phase function
  ( 1 - k^2 ) / ( 4 pi ( 1 - k cos )^2 ): Philippe Blasi, Bertrand Le Saëc and Christophe Schlick,
  *A Rendering Algorithm for Discrete Volume Density Objects* (Computer Graphics Forum 12(3),
  Eurographics 1993). The leaves' thin layer, single scattering in a layer seen from the lit side:
  Pat Hanrahan and Wolfgang Krueger, *Reflection from Layered Surfaces due to Subsurface
  Scattering* (SIGGRAPH 1993), its single-scattering term in the layer's optical depth and the
  two cosines. Used as a technique only; the lobe round the half vector, the gain, the light's
  wrapped cosine and the layer's response under a uniform sky are our own.
- The local lights' clusters, in `src/lighting/LocalLights.ts` and
  `src/lighting/LocalLightClusters.ts`: Ola Olsson, Markus Billeter and Ulf Assarsson,
  *Clustered Deferred and Forward Shading* (HPG 2012), the view cut into screen tiles and exponential depth slices, each cluster listing
  the lights whose spheres meet its box; the per-cluster compute pass over a fixed grid with lists
  in storage buffers as three.js r186's `ClusteredLightsNode` builds them (mechanism only; our
  sort, slices, packing and lookup are our own). The range window and the inverse-square
  falloff's softening: Brian Karis, *Real Shading in Unreal Engine 4* (above).
- The screen-space ambient occlusion, in `src/post/GTAO.ts`: Jorge Jimenez, Xian-Chun Wu, Angelo
  Pesce and Adrian Jarabo, *Practical Realtime Strategies for Accurate Indirect Occlusion*
  (Activision technical memo ATVI-TR-16-01, 2016): horizon search per slice and the cosine-weighted
  visible arc against the slice's projected normal in closed form. Its practical shape (the
  horizons' distance falloff, the low starting horizons, the projected normal's length as the
  slice's weight, and the thin-occluder heuristic that stretches a sample's distance along the
  view) follows Intel's [XeGTAO](https://github.com/GameTechDev/XeGTAO) (MIT). Used as techniques
  only; the code is our own.
- The exposure's adaptation, a critically damped second-order filter on the EV: Thomas Lowe,
  *Critically Damped Ease-In/Ease-Out Smoothing* (Game Programming Gems 4, 2004), in
  `src/post/Exposure.ts`. Used as a technique only; the exact step per frame is our own. Its time
  constants follow the cones' light adaptation, a time constant of 0.1 s: Frédo Durand and Julie
  Dorsey, *Interactive Tone Mapping* (Eurographics Workshop on Rendering, 2000).
- The bloom's threshold, a quadratic soft knee on the brightest channel that scales the colour
  whole: the curve of Unity Technologies' *Post Processing Stack v2* bloom
  ([PostProcessing](https://github.com/Unity-Technologies/PostProcessing)), in
  `src/post/PhysicalBloom.ts`, set so the glow starts at the threshold. Used as a technique only,
  with no code.

## Sources

Sources that informed the procedural layout, the islanders' bodies and the physical constants
behind the wind and the leaves' light; no code, data tables or images from them are used (the
bodies' curves take a few rounded key values off theirs).

- Seabed substrate: Page C. Valentine, USGS,
  [*Sediment classification and the characterization, identification, and mapping of geologic substrates*](https://www.usgs.gov/publications/sediment-classification-and-characterization-identification-and-mapping-geologic)
  (2019, SIR 2019–5073).
- Shelf at the cliff foot (talus aprons and wave-cut shore platforms, art-directed rather than
  modelled): Alan S. Trenhaile, *The Geomorphology of Rock Coasts* (Oxford University Press, 1987).
- Cliffs and rim: U.S. National Park Service,
  [*Coastal Processes—Erosion*](https://www.nps.gov/articles/coastal-processes-erosion.htm), and USGS,
  [*Factors affecting sea cliff erosion*](https://www.usgs.gov/media/images/factors-affecting-sea-cliff-erosion).
- Rockfall scars bounded by joint sets and bed partings, nested in size, and the debris below
  them: Mélody Prémaillon, Thomas J. B. Dewez, Vincent Regard et al.,
  [*Conceptual model of fracture-limited sea cliff erosion*](https://archimer.ifremer.fr/doc/00705/81660/)
  (Earth Surface Processes and Landforms 46, 2021).
- The wave-cut notch (a sharp roof and a sloping floor near sea level, its depth varying along
  the coast): Fabrizio Antonioli et al., *Tidal notches in Mediterranean Sea: a comprehensive
  analysis* (Quaternary Science Reviews 119, 2015).
- The cliff's shore zones and stains: the black *Verrucaria* band above the tide and the orange and
  grey lichens of the splash zone, MarLIN,
  [*Yellow and grey lichens on supralittoral rock*](https://www.marlin.ac.uk/habitats/detail/96/yellow_and_grey_lichens_on_supralittoral_rock);
  the dark runoff streaks of rock-dwelling cyanobacteria ("Tintenstriche"),
  [*Gloeocapsa magma*](https://en.wikipedia.org/wiki/Gloeocapsa_magma) and the literature it cites.
- The islanders' growth and ageing (`src/characters/Ages.ts`): stature by age, the CDC 2000 growth
  charts' medians ([CDC Growth Charts](https://www.cdc.gov/growthcharts/), public domain); the
  leg's share of the height, Barry Bogin and Maria Inês Varela-Silva,
  [*Leg length, body proportion, and health: a review with a note on beauty*](https://doi.org/10.3390/ijerph7031047)
  (International Journal of Environmental Research and Public Health 7, 2010); the stature lost
  in old age, as the Baltimore Longitudinal Study of Aging reports it.
- The islanders' lifespans (`src/game/sim/life.ts`): Gompertz's law of mortality (Benjamin
  Gompertz, *On the Nature of the Function Expressive of the Law of Human Mortality*,
  Philosophical Transactions of the Royal Society 115, 1825), fitted to the old ages of Japan's
  abridged life table for 2022, Ministry of Health, Labour and Welfare,
  [*令和4年簡易生命表の概況*](https://www.mhlw.go.jp/toukei/saikin/hw/life/life22/index.html).
- The wind's gusts and the plants' sway (`src/weather/Wind.ts`, `src/world/vegetation/Deform.ts`):
  the turbulence length scale of EN 1991-1-4's Annex B and its peak velocity pressure, as given in
  Casimir Katz, *Computational Mechanics: Enhanced Civil Engineering Applications
  (Wind)* (TU München lecture slides) and in Zlatko Marković, Jelena Dobrić and Nina Gluhović,
  *Comparison of wind actions according to Eurocode and previous regulations* (Scientific Journal
  of Civil Engineering 9 (1), 2020): the gusts' size from terrain category 0 at the code's least
  height, the plants' swing from each wind level's turbulence intensity. The gusts' travel from
  how fast the large eddies over a canopy go: M. R. Raupach, J. J. Finnigan and Y. Brunet,
  *Coherent eddies and turbulence in vegetation canopies: the mixing-layer analogy*
  (Boundary-Layer Meteorology 78, 1996), as given in Ian C. Tse, Cristina M. Poindexter and Evan A.
  Variano, *Wind-driven water motions in wetlands with emergent vegetation* (Water Resources
  Research, 2016); Andreas Christen, D. Scherer, D. Schindler and R. Vogt, *Convection velocity
  and spatial turbulence statistics in the trunk space of a forest* (18th Symposium on Boundary
  Layers and Turbulence, 2008).
- The grass blade's bend under the wind (`src/world/Grass.ts`): the drag's bound on a flexible
  blade's turning, Frédérick Gosselin, Emmanuel de Langre and Bruno A. Machado-Almeida, *Drag
  reduction of flexible plates by reconfiguration* (Journal of Fluid Mechanics 650, 2010), and
  Mitul Luhar and Heidi M. Nepf, *Flow-induced reconfiguration of buoyant and flexible aquatic
  vegetation* (Limnology and Oceanography 56, 2011).
- The leaves' diffuse reflection (`src/world/VegetationLighting.ts` THIN_LAYER): leaves' BRDF
  modelled as a specular sheen off the cuticle plus a diffuse component taken as Lambertian, Laurent
  Bousquet, Sophie Lachérade, Stéphane Jacquemoud and Ismaël Moya, *Leaf BRDF measurements and
  model for specular and diffuse components differentiation* (Remote Sensing of Environment 98,
  2005), and the same authors without Lachérade, *Leaf BRDF and BTDF measurements and model*
  (ISPMSRS 2005, Beijing); Lifeng Wang, Wenle Wang, Julie Dorsey, Xu Yang, Baining Guo and
  Heung-Yeung Shum, *Real-time rendering of plant leaves* (SIGGRAPH 2005).
- The plants' main bend under the wind's drag (`src/world/vegetation/Deform.ts`,
  `src/world/Bamboo.ts`, `src/world/Yunpeng.ts`): a leaved crown's drag coefficient and its fall
  with the wind as a power law, A. Koizumi, J. Motoyama, K. Sawata, Y. Sasaki and T. Hirai,
  *Evaluation of drag coefficients of poplar-tree crowns by a field test method* (Journal of Wood
  Science 56 (3), 2010); the bamboo culm's wall and modulus, P. G. Dixon and L. J. Gibson, *The structure and
  mechanics of Moso bamboo material* (Journal of the Royal Society Interface 11, 2014); the
  yunpeng's stalk drawn on the giant reed: the ceiling on a smooth cylinder's force coefficient as
  given in A. Padewska-Jurczak, P. Szczepaniak and R. Walentyński, *Experimental and numerical analyses of
  airflow around two cylinders angled to the direction of wind* (Bulletin of the Polish Academy of
  Sciences: Technical Sciences 71 (1), 2023), the reed's wall from F. S. Coppolino, *Prove di
  caratterizzazione meccanica della canna comune (Arundo Donax) in prospettiva di un uso
  strutturale sostenibile* (master's thesis, University of Bologna, 2020), and the moduli of its
  parenchyma in bending and its rind in tension from H.-C. Spatz et al., *Biomechanics of the giant
  reed Arundo donax* (Philosophical Transactions of the Royal Society B 352, 1997), as Coppolino
  reports them; the wind's log law over
  EN 1991-1-4's terrain category 0, as given in Marković, Dobrić and Gluhović (above).
