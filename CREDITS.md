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
- Shore-wave version: native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef),
  `src/world/ShoreField.js`, `src/ocean/ShoreWaves.js` and `src/ocean/SurfFoam.js`.
- Shore-wave files: `src/ocean/ShoreWaveField.ts`, `src/ocean/ShoreWaves.ts`,
  `src/ocean/FoamTexture.ts`; `src/ocean/Water.ts` adapts the surf-foam density and shading.
- Shore-wave changes: finite-depth travel speed and an obstacle-aware arrival-time field over the
  existing seabed, seeded only from the incoming domain edges, with grouped, asymmetric
  shoaling cross-sections ported to TSL. Soomi adds a separate upwave land-visibility field: a
  narrow angular fan and water-only smoothing soften the wave shadow, which attenuates input
  amplitude, contact, reflection and foam transport together. Residual wind ripples remain in
  sheltered water. Soomi also continues the same swell over the whole sea using a periodically
  baked phase/along-crest template; the local cache holds only the nearshore residual. Unwrapped
  travel time and depth blend to the global reference before differentiation, with an exact zero
  residual rim. The 14-wave / 128 m template is seamless and changes only with wave parameters;
  fine FFT ripples retain their continuity through the shelter transition. This global continuation
  and closed-island shelter treatment are our extensions, rather than an upstream diffraction
  solver. The horizontal profile is inverted into world space; surface normals include its complete
  changing shape. Calm offshore cross-sections stay round, with height/depth-dependent steepening;
  restrained crest polishing and scattering avoid periodic mirror-like bands. Lower FFT amplitude
  and horizontal compression soften the background wind sea. A local rock-contact
  clock supplies weak reflection and wave-triggered whitewater rather than offshore crest lace.
  Finite-depth orbital velocity advects foam, and expansion thins its density. Dense fresh churn
  opens into bubble holes, lace and short strands using the CPU-baked SurfFoam pattern, with
  small relief and cavity shading. The pattern has been scaled and its low-density strands broken
  into shorter arcs. Beach run-up, plunging sheets and spray are omitted for the steep island cliffs. See
  `docs/water.md` in the source repository for the source mapping and approximation limits.
  FFT crest compression and persistent whitecaps follow this version's `src/ocean/OceanFFT.js`.
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
- Foam density advection: Jos Stam,
  [*Real-Time Fluid Dynamics for Games*](https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/GDC03.pdf)
  (GDC 2003). Backtraced, bilinearly sampled density; original TSL implementation.
- Rasterised caustics: Evan Wallace, [*WebGL Water*](https://madebyevan.com/webgl-water/) and
  [*Rendering Realtime Caustics in WebGL*](https://medium.com/@evanwallace/rendering-realtime-caustics-in-webgl-2a99a29a0b2c).
- Whiteout triplanar normal blend: Ben Golus,
  [*Normal Mapping for a Triplanar Shader*](https://bgolus.medium.com/normal-mapping-for-a-triplanar-shader-10bf39dca05a) (2017).
- Atmosphere LUTs and multiple-scattering approximation: Sébastien Hillaire,
  [*A Scalable and Production Ready Sky and Atmosphere Rendering Technique*](https://sebh.github.io/publications/egsr2020.pdf)
  (EGSR 2020), implemented through the adapted Tidewater source above.

- Seabed substrate reference: Page C. Valentine, USGS,
  [*Sediment classification and the characterization, identification, and mapping of geologic substrates*](https://www.usgs.gov/publications/sediment-classification-and-characterization-identification-and-mapping-geologic)
  (2019, SIR 2019–5073). Rock patches, mixed clast sizes and partial sand burial inform the
  procedural seabed layout; no source code, survey data or images are used.
