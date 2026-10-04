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
    `Sky.js`, ported from WGSL to TSL. The new cloud density, bounded ray march and cloud shadows
    in `src/sky/Clouds.ts` are original Soomi code, not copied from tidewater. The celestial
    clock, geometric lunar phase and filtered procedural stars are also original code;
    they introduce no third-party imagery or additional asset licence. Weather blending,
    integrated wind, analytic rain streaks/ripple gradients and wet-material response are
    original Soomi code as well.
- Changes: ported to TSL and TypeScript and modified throughout for this project's stylised look.

### Hash without Sine

- Upstream: https://www.shadertoy.com/view/4djSRW, by David Hoskins
- Copyright: (c) 2014 David Hoskins
- Licence: MIT, see [`src/materials/hoskins-hash.LICENSE.txt`](src/materials/hoskins-hash.LICENSE.txt)
- Files: `hash22` in `src/materials/ProceduralTextures.ts` and `src/ocean/Water.ts`
- Changes: ported to TSL; the procedural textures remap it to [-1, 1].

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
