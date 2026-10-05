# Credits

Soomi is released under the MIT License (see `LICENSE`). The third-party code and assets listed here
keep their own licences. Adapted source files also carry the upstream notice in their header. A
production build copies this file and the required licence texts, including those of the bundled npm
packages, into `dist/licenses/`.

## Adapted code

### tidewater

- Upstream: https://github.com/dgreenheck/tidewater, by Daniel Greenheck
- Copyright: (c) 2026 DRG Software Solutions LLC
- Licence: MIT, see [`src/ocean/tidewater.LICENSE.txt`](src/ocean/tidewater.LICENSE.txt) and
  [`src/sky/tidewater.LICENSE.txt`](src/sky/tidewater.LICENSE.txt) (the same text)
- From the three.js (TSL) edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86):
  - `src/ocean/OceanFFT.ts`: the multi-cascade FFT ocean.
  - `src/ocean/Water.ts`: the water shading (`WaterMaterial.js`).
  - `src/ocean/Caustics.ts`: the rasterised caustics.
- From the native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef):
  - `src/ocean/OceanSpectrum.ts`: the JONSWAP / TMA spectrum, directional spreading and dispersion
    helpers from `OceanFFT.js`, ported to TypeScript; `OceanFFT.ts` combines the wind sea and swell
    spectra they describe.
  - `src/ocean/GlitterMask.ts`: the density channel of the lace pattern in `SurfFoam.js`.
  - `src/ocean/ShoreWaves.ts`, `src/ocean/ShoreWaveField.ts`: began as an adaptation of
    `ShoreWaves.js`; now mostly rewritten for this island's rocky boundary.
  - `src/sky/Atmosphere.ts`, `src/sky/Sky.ts`: the atmosphere and solar disk from `Atmosphere.js` and
    `Sky.js`, ported from WGSL to TSL.
  - `src/sky/Clouds.ts`, `src/materials/CloudNoise.ts`: the volumetric cumulus from
    `SkyProClouds.js`, tidewater's port of the Three.js Sky Pro clouds ("Partly cloudy" preset),
    ported from WGSL to TSL: the procedural weather map and its bounds grid, the shell density
    (weather plus coverage, dilated and eroded by the shape noise, soft height-dependent edges),
    the cone-traced light march with three scattering orders, powder, darker bases and sky light
    occlusion, the coarse / fine march with empty-cell skipping, aerial perspective and the far
    melt, the cloud shadow, and the shape noise loader. From `Clouds.js`: the screen-space view
    trace with its reprojected, neighbourhood-clamped history and bicubic upsampling, and the
    synoptic field. The weather fronts, the mapping of this project's coverage onto the shell,
    the darker closed deck, rain curtains and the settled view of a paused scene are this
    project's; the panorama map is this project's own, predating the port (`Clouds.js` has a
    similar one).
  - `src/sky/Cirrus.ts` and the cirrus veil in `src/sky/Clouds.ts`: the cirrus fibre bake (a flow
    field of sparse seeds and tufts drawn out by line integral convolution), its anisotropic,
    footprint-filtered lookup and the veil's coverage, optical depth and ice-crystal lighting,
    from the cirrus in `Clouds.js`, ported from WGSL to TSL.
  - The celestial clock, geometric lunar phase and filtered procedural stars are original code;
    they introduce no third-party imagery or additional asset licence. Weather blending,
    integrated wind, the rain veil and ripple gradients and wet-material response are original
    Soomi code as well.
- Changes: ported to TSL and TypeScript and modified throughout for this project's stylised look.

### Hash without Sine

- Upstream: https://www.shadertoy.com/view/4djSRW, by David Hoskins
- Copyright: (c) 2014 David Hoskins
- Licence: MIT, see [`src/materials/hoskins-hash.LICENSE.txt`](src/materials/hoskins-hash.LICENSE.txt)
- Files: `hash22` in `src/materials/ProceduralTextures.ts` and `src/ocean/Water.ts`; `hash33` in
  `src/materials/CloudNoise.ts`
- Changes: ported to TSL; the procedural textures remap it to [-1, 1].

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

## Assets

### Rock Face 03

- Author: Dario Barresi (photography), Rico Cilliers (processing)
- Source: [Poly Haven](https://polyhaven.com/a/rock_face_03)
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: `public/textures/rock/rock_albedo.jpg` is the 1K diffuse map, unchanged.
  `public/textures/rock/rock_detail.png` packs the 1K OpenGL normal map (RGB) and roughness map
  (alpha), reduced to 8 bits.

### Ultimate Modular Men Pack

- Author: Quaternius
- Source: [quaternius.com](https://quaternius.com/packs/ultimatemodularcharacters.html) (February 2022;
  the pack's own `License.txt` calls it "Ultimate Modular Males")
- Licence: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: parts of `Farmer.gltf` and `Adventurer.gltf`, recoloured into the island's palette and merged
  into one skinned mesh at load time. They are not in the repository yet: the dev server loads them
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

## Acknowledgements

Published techniques this project implements without using their code; each is also credited in a
comment where it is used.

- FFT ocean: J. Tessendorf,
  [*Simulating Ocean Water*](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf)
  (SIGGRAPH course notes, 2002 revision).
- Rasterised caustics: Evan Wallace, [*WebGL Water*](https://madebyevan.com/webgl-water/) and
  [*Rendering Realtime Caustics in WebGL*](https://medium.com/@evanwallace/rendering-realtime-caustics-in-webgl-2a99a29a0b2c).
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
- Crepuscular rays: Kenny Mitchell,
  [*Volumetric Light Scattering as a Post-Process*](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process)
  (GPU Gems 3, 2007): a radial blur of the open sky toward the sun.
- Raindrop rings: Sébastien Lagarde,
  [*Water drop 2b – Dynamic rain and its effects*](https://seblagarde.wordpress.com/2013/01/03/water-drop-2b-dynamic-rain-and-its-effects/)
  (2013): the ring profile sin( clamp( 9 ( t - r ), 0, 3 ) pi ), a wave and a half behind the
  front, for the rain's ring sprites on the sea.
- Whitecaps: the horizontal Jacobian of the displaced surface as a breaking criterion, after
  J. Tessendorf, *Simulating Ocean Water* (above).
- Depth-dependent water shadows: the volume-lighting integral described in
  [*Physically Based Rendering*, third edition](https://pbr-book.org/3ed-2018/Light_Transport_II_Volume_Rendering/Volumetric_Light_Transport),
  independently implemented in TSL with exponential depth strata, exact per-channel attenuation
  weights and separate air/submerged visibility along each scattering point's refracted solar path.
  No source code is copied; the retained multiple-scattering boost is empirical.

## References

Sources that informed the procedural layout; no code, data or images from them are used.

- Seabed substrate: Page C. Valentine, USGS,
  [*Sediment classification and the characterization, identification, and mapping of geologic substrates*](https://www.usgs.gov/publications/sediment-classification-and-characterization-identification-and-mapping-geologic)
  (2019, SIR 2019–5073).
- Cliffs and rim: U.S. National Park Service,
  [*Coastal Processes—Erosion*](https://www.nps.gov/articles/coastal-processes-erosion.htm), and USGS,
  [*Factors affecting sea cliff erosion*](https://www.usgs.gov/media/images/factors-affecting-sea-cliff-erosion).
