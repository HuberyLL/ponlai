# Credits

Soomi is released under the MIT License (see `LICENSE`). The third-party code and assets listed here
keep their own licences. Adapted source files also carry the upstream notice in their header. A
production build copies this file and the required licence texts, including those of the bundled npm
packages, into `dist/licenses/`.

## Adapted code

### tidewater

- Upstream: https://github.com/dgreenheck/tidewater
- Ocean version: the three.js (TSL) edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86)
  (2026). Later commits port tidewater to its own WebGPU engine, so they no longer match this code.
- Copyright: (c) 2026 DRG Software Solutions LLC
- Sky version: native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef)
  (2026-09-25), `src/sky/Atmosphere.js` and `src/sky/Sky.js`.
- License: MIT, see [`src/ocean/tidewater.LICENSE.txt`](src/ocean/tidewater.LICENSE.txt) and
  [`src/sky/tidewater.LICENSE.txt`](src/sky/tidewater.LICENSE.txt).
- Ocean files: `src/ocean/OceanFFT.ts`, `src/ocean/Water.ts`, `src/ocean/Caustics.ts`.
- Ocean changes: ported to TSL and modified for this project's stylised rendering.
- Sky files: `src/sky/Atmosphere.ts`, `src/sky/Sky.ts`.
- Sky changes: the WGSL atmosphere and solar disk are ported to TSL; compute LUT generation is
  replaced by render-target bakes, the transmittance coordinates are made symmetric, and the
  display, reflection and PBR environment share the same atmosphere. A flat distant-sea reflection
  completes the finite wave grid. Clouds, aerial perspective, stars and moon rendering are omitted.

## Assets

### Rock Face 03

- Author: Dario Barresi (photography), Rico Cilliers (processing)
- Source: [Poly Haven](https://polyhaven.com/a/rock_face_03)
- License: [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)
- Files: `public/textures/rock/rock_albedo.jpg` is the 1K diffuse map, unchanged.
  `public/textures/rock/rock_detail.png` packs the 1K OpenGL normal map (RGB) and roughness map
  (alpha), reduced to 8 bits.

## Acknowledgements

Published techniques this project implements without using their code. Each is also credited in a
comment where it is used.

- FFT ocean: J. Tessendorf,
  [*Simulating Ocean Water*](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2002.pdf)
  (SIGGRAPH course notes, 2002 revision).
- Rasterised caustics: Evan Wallace, [*WebGL Water*](https://madebyevan.com/webgl-water/) and
  [*Rendering Realtime Caustics in WebGL*](https://medium.com/@evanwallace/rendering-realtime-caustics-in-webgl-2a99a29a0b2c).
- Whiteout triplanar normal blend: Ben Golus,
  [*Normal Mapping for a Triplanar Shader*](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) (2017).
- Atmosphere LUTs and multiple-scattering approximation: Sébastien Hillaire,
  [*A Scalable and Production Ready Sky and Atmosphere Rendering Technique*](https://sebh.github.io/publications/egsr2020.pdf)
  (EGSR 2020), implemented through the adapted Tidewater source above.
- Solar radiance normalisation: the projected-solid-angle irradiance integral described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals),
  independently implemented with a shared scene radiance unit and an integrated limb-darkening profile.
- Contact-hardening solar shadows: Randima Fernando,
  [*Percentage-Closer Soft Shadows*](https://developer.download.nvidia.com/shaderlibrary/docs/shadow_PCSS.pdf)
  (SIGGRAPH 2005), independently implemented in TSL for a directional solar disk.
- Air/water optical interface: Snell's law and dielectric transport as described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Reflection_Models/Dielectric_BSDF),
  independently implemented for solar direction, beam-area conservation and two-segment shadows.
- Static local sky/contact visibility: John C. Hart,
  [*Sphere Tracing*](https://doi.org/10.1007/s003710050084) (1996), and the
  [cosine-weighted hemisphere sampler in PBRT](https://pbr-book.org/4ed/Sampling_Algorithms/Sampling_Multidimensional_Functions),
  independently implemented on bounded procedural fields; this is finite-radius contact visibility.
