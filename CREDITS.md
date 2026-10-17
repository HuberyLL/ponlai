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
  [`src/materials/tidewater.LICENSE.txt`](src/materials/tidewater.LICENSE.txt) and
  [`src/weather/tidewater.LICENSE.txt`](src/weather/tidewater.LICENSE.txt) (the same text)
- From the three.js (TSL) edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86):
  - `src/ocean/OceanFFT.ts`: the multi-cascade FFT ocean.
  - `src/ocean/Water.ts`: the water shading (`WaterMaterial.js`).
  - `src/ocean/Caustics.ts`: the rasterised caustics.
  - `src/ocean/FoamPattern.ts`: the procedural foam pattern from `FoamTexture.js` (rafts, holes,
    bubbles, mottling and streaks, generated on the GPU; no image asset).
  - `src/ocean/Spray.ts`: the GPU spray from `src/fx/Spray.js` (drops, ligaments, dense spray and
    mist, their integration and lighting, the puff and drop-cluster textures), without its boat,
    terrain and surf-foam couplings; emitters own fixed slot groups instead of an atomic ring.
- From the native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef):
  - `src/ocean/OceanSpectrum.ts`: the JONSWAP / TMA spectrum, directional spreading and dispersion
    helpers from `OceanFFT.js`, ported to TypeScript; `OceanFFT.ts` combines the wind sea and swell
    spectra they describe.
  - `src/ocean/StormSea.ts`: the persistent whitecap foam of `OceanFFT.js` (build-up where the
    Jacobian folds, exponential decay), here on one world-space grid of the summed cascades; and
    in `src/ocean/Water.ts` the whitecap compositing of `WaterSurface.js` (a foam pattern
    thresholded by the coverage, at a distance the coverage itself).
  - `src/ocean/Water.ts`: from `WaterMaterial.js`, the water column's sun shadowed by the surface
    point's shadow alone, and the reflectance under which no reflection ray marches
    (`ssrMinFresnel`).
  - `src/ocean/ShoreWaves.ts`, `src/ocean/ShoreWaveField.ts`: began as an adaptation of
    `ShoreWaves.js`; now mostly rewritten for this island's rocky boundary.
  - `src/sky/Atmosphere.ts`, `src/sky/Sky.ts`: the atmosphere and solar disk from `Atmosphere.js` and
    `Sky.js`, ported from WGSL to TSL.
  - `src/post/TemporalLocks.ts`: the motion cap, the temporal reactive and the clamp-drop of
    `TemporalUpscale.js`'s accumulation, which is AMD's FSR 2 (see "FSR 2" below; licence
    [`src/post/tidewater-fsr2.LICENSE.txt`](src/post/tidewater-fsr2.LICENSE.txt), both notices).
  - `src/sky/Clouds.ts`, `src/materials/CloudNoise.ts`: the volumetric cumulus from
    `SkyProClouds.js`, tidewater's port of the Three.js Sky Pro clouds ("Partly cloudy" preset),
    ported from WGSL to TSL: the procedural weather map and its bounds grid, the shell density
    (weather plus coverage, dilated and eroded by the shape noise, soft height-dependent edges),
    the cone-traced light march with three scattering orders, powder, darker bases and sky light
    occlusion, the coarse / fine march with empty-cell skipping, aerial perspective and the far
    melt, the cloud shadow, and the shape noise loader. From `Clouds.js`: the screen-space view
    trace with its reprojected, neighbourhood-clamped history and bicubic upsampling, and the
    synoptic field. The weather fronts, the mapping of this project's coverage onto the shell,
    the darker closed deck and the settled view of a paused scene are this project's (the rain
    curtains follow VolumetricCloudsCS1, below); the panorama map is this project's own, predating the port (`Clouds.js` has a
    similar one).
  - `src/sky/Cirrus.ts` and the cirrus veil in `src/sky/Clouds.ts`: the cirrus fibre bake (a flow
    field of sparse seeds and tufts drawn out by line integral convolution), its anisotropic,
    footprint-filtered lookup and the veil's coverage, optical depth and ice-crystal lighting,
    from the cirrus in `Clouds.js`, ported from WGSL to TSL.
  - `src/materials/Wetness.ts` (`runnels`): the rain-streak stains of `terrainRockSurface` in
    `src/world/terrain/TerrainShading.js` (the variation stretched down the two vertical projection
    planes, weighted by how squarely each faces the surface, and its 40 % darkening), ported from
    WGSL to TSL and turned into the paths that rain water takes down the cliffs while they are wet.
  - `src/weather/AerialPerspective.ts`: the distant air from `src/post/AirHaze.js`, ported from WGSL
    to TSL: two exponential height layers (a thin marine layer and a deeper aerosol layer, in its
    proportions) with their optical depth integrated analytically along the view ray, the sky just
    above the horizon in the view direction as the haze's light, and the key light's share of it
    scattered through its Cornette-Shanks phase function near the camera. Its volumetric and
    screen-space sun shafts were not ported (`src/post/LightShafts.ts` stays). The protected
    foreground, the sea fog banks (marched, with bank-dependent heights and a clearing over the
    island), their lighting and the morning mist are this project's.
  - The celestial clock, geometric lunar phase and the star and Milky Way rendering are original
    code; the star catalogue and Milky Way map they draw are listed under Assets. (The lunar disk's
    shading and imagery are credited under three-geospatial, a-starry-sky and the CGI Moon Kit.) Weather blending,
    integrated wind and the rain veil and ripple gradients are original Ponlai code as well; the
    wet-material response implements the published techniques acknowledged below.
  - Techniques without code: the meadow's blades thinned by distance in `src/world/Grass.ts`
    (`tuftLod`) follow the tier fade of `src/world/vegetation/GrassField.js` (each blade narrowing
    to nothing over a short distance of its own while the kept ones widen so that the blade count
    times the width holds), and its blades kept whole rather than partly covered (each widened
    blade drawn solid as far as its coverage stays above its own hash, `grassMaterial`), after the
    same file's opaque blades; written for this project's tufts, culling and coverage rules. The
    gravel of thin soil (`src/materials/ProceduralTextures.ts` `gravelBake`, read in
    `src/materials/TerrainMaterial.ts` at two rotated scales) follows the small stones of
    `src/world/terrain/DetailTextures.js` (a share of a periodic Worley lattice's cells holding a
    stone) and the multi-scale, rotated detail reads of `src/world/Terrain.js`.
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

### Bloom chains (three.js's BloomNode)

- Upstream: three.js `examples/jsm/tsl/display/BloomNode.js` (r186), after UnrealBloomPass
- Copyright: 2010-2026 three.js authors
- Licence: MIT, see [`src/post/three-bloom.LICENSE.txt`](src/post/three-bloom.LICENSE.txt)
- File: `src/post/BloomChains.ts`: the high pass, the five mips' separable Gaussian blurs and the
  composite of the tight bloom and the wide glow.
- Changes: the chains are drawn together (the high pass and each blur write every chain's target
  in one MRT pass, the composite stays a pass per chain), as passes of the frame graph into
  targets it declares and sizes; the high pass is the pipeline's own (clamped, soft-knee).

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

### Rock Face 03

- Author: Dario Barresi (photography), Rico Cilliers (processing)
- Source: [Poly Haven](https://polyhaven.com/a/rock_face_03)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: `public/textures/rock/rock_albedo.jpg` is the 1K diffuse map, unchanged.
  `public/textures/rock/rock_detail.png` packs the 1K OpenGL normal map (RGB) and roughness map
  (alpha), reduced to 8 bits.

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
  recoloured into the island's palette (the scene's islander and the game's islanders, their
  colour variants in `src/characters/looks.ts`), given procedural pointed ears and merged into one
  skinned mesh at load time. They are not in the repository yet: the dev server loads them
  from the git-ignored `artifacts/assets/` while the character art is settled.

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

## Acknowledgements

Published techniques this project implements without using their code; each is also credited in a
comment where it is used.

- FFT ocean: J. Tessendorf,
  [*Simulating Ocean Water*](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf)
  (SIGGRAPH course notes, 2002 revision).
- Rasterised caustics: Evan Wallace, [*WebGL Water*](https://madebyevan.com/webgl-water/) and
  [*Rendering Realtime Caustics in WebGL*](https://medium.com/@evanwallace/rendering-realtime-caustics-in-webgl-2a99a29a0b2c).
- Hex-tiling's predecessor, by-example noise that blends randomly placed tiles with a
  histogram-preserving blend: Eric Heitz and Fabrice Neyret,
  [*High-Performance By-Example Noise using a Histogram-Preserving Blending Operator*](https://eheitzresearch.wordpress.com/722-2/)
  (HPG 2018).
- Height-based blending of terrain layers (moss, turf, soil, lichens, runoff stains on the stone):
  Andrey Mishkinis, *Advanced Terrain Texture Splatting* (Gamasutra, 2013), and the height lerp
  of Unreal Engine's landscape materials.
- Whiteout triplanar normal blend: Ben Golus,
  [*Normal Mapping for a Triplanar Shader*](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) (2017).
- Atmosphere LUTs and multiple scattering: Sébastien Hillaire,
  [*A Scalable and Production Ready Sky and Atmosphere Rendering Technique*](https://sebh.github.io/publications/egsr2020.pdf)
  (EGSR 2020), through the adapted tidewater source above.
- Solar radiance normalisation:
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals),
  the projected-solid-angle irradiance integral.
- Air/water interface: Snell's law and dielectric transport as described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Reflection_Models/Dielectric_BSDF).
- Contact-hardening solar shadows: Randima Fernando,
  [*Percentage-Closer Soft Shadows*](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/Percentage_Closer_Soft_Shadows.pdf)
  (SIGGRAPH 2005).
- Local sky occlusion: John C. Hart, [*Sphere Tracing*](https://doi.org/10.1007/s003710050084) (1996),
  with the [cosine-weighted hemisphere sampler in PBRT](https://pbr-book.org/4ed/Sampling_Algorithms/Sampling_Multidimensional_Functions).
- Filtered wave-slope moments: Marc Olano and Dan Baker,
  [*LEAN Mapping*](https://userpages.cs.umbc.edu/olano/papers/lean/) (I3D 2010).
- Microfacet masking: Eric Heitz,
  [*Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs*](https://jcgt.org/published/0003/02/03/)
  (JCGT 2014); the error-function approximation is Abramowitz and Stegun, equation 7.1.26.
- Volumetric clouds: Andrew Schneider,
  [*The Real-time Volumetric Cloudscapes of Horizon Zero Dawn*](https://www.guerrilla-games.com/read/the-real-time-volumetric-cloudscapes-of-horizon-zero-dawn)
  (SIGGRAPH 2015): Perlin-Worley shape noise, Worley erosion, weather-map coverage and height
  profiles. Multiple-scattering octaves: Magnus Wrenninge et al.,
  [*Oz: The Great and Volumetric*](https://magnuswrenninge.com/wp-content/uploads/2021/03/Wrenninge-OzTheGreatAndVolumetric.pdf)
  (SIGGRAPH 2013 talk). Diffuse transmission through thick decks uses the two-stream
  approximation (e.g. Bohren, *Multiple scattering of light and some of its observable consequences*,
  Am. J. Phys. 55, 1987).
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
- Airglow: H. W. Jensen, F. Durand, M. M. Stark, S. Premoze, J. Dorsey and P. Shirley,
  [*A Physically-Based Night Sky Model*](https://doi.org/10.1145/383259.383306) (SIGGRAPH 2001): a
  thin emitting shell about 100 km up (the van Rhijn brightening toward the horizon) seen through
  the lower atmosphere's extinction, with F. Kasten and A. T. Young's air mass (Applied Optics 28,
  1989); dimmed by a bright moon as in [a-starry-sky](https://github.com/Dante83/a-starry-sky)
  (MIT), whose code is not used.

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
- Grass blades kept a minimum width on screen with their coverage lowered to match (drawn as
  whole blades), so thin blades stop crawling under camera motion: Emil Persson, *Phone-wire AA*
  (2012 demo and write-up on [humus.name](http://www.humus.name/)).
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
  it, leaf edges fluttering along the normal): Tiago Sousa,
  *Vegetation Procedural Animation and Shading in Crysis* (GPU Gems 3, chapter 16, 2007), in
  `src/world/vegetation/Deform.ts` (`mainBend`, `hangingSway`). Each plant answering the
  local wind like a spring at its own natural frequency: Santa Monica Studio's wind in *God of War*
  (Rupert Renard, *Wind Simulation in God of War*, GDC 2019), in `mainBend`.
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
- Gusts as a noise field scrolled with the wind, sweeping across the grass: Sucker Punch
  Productions' wind and grass in *Ghost of Tsushima* (Eric Wohllaib, *Procedural Grass in 'Ghost
  of Tsushima'*, GDC 2021: 2D Perlin noise scrolled in the wind's direction; Bill Rockenbeck,
  *Blowing from the West: Simulating Wind in Ghost of Tsushima*, GDC 2021: the wind's strength
  varied by time-varying Perlin noise), in `src/weather/Wind.ts` (`windField`) and
  `src/world/Grass.ts`. Used as a technique only; the gust map is our own.
  The map's noise is Ken Perlin's improved gradient noise (*Improving Noise*, SIGGRAPH 2002),
  made periodic.
- Each meadow blade a random mix of root and tip colours and a random value, and the sward
  darkened toward the ground by its height and density: SimonDev's *Quick_Grass*
  (github.com/simondevyoutube/Quick_Grass, MIT, copyright 2023 simondevyoutube), its grass
  shader, in `src/world/Grass.ts` (`PALETTE`, `ROOT_DARK`). Used as a technique only.

## References

Sources that informed the procedural layout; no code, data or images from them are used.

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
