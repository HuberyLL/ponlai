# Credits

Soomi is released under the MIT License (see `LICENSE`). The third-party code and assets listed here
keep their own licences. Adapted source files also carry the upstream notice in their header. A
production build copies this file and the required licence texts, including those of the bundled npm
packages, into `dist/licenses/`.

## Adapted code

### tidewater

- Upstream: [tidewater](https://github.com/dgreenheck/tidewater), by Daniel Greenheck.
- Copyright: (c) 2026 DRG Software Solutions LLC.
- License: MIT, see [`src/ocean/tidewater.LICENSE.txt`](src/ocean/tidewater.LICENSE.txt) and
  [`src/sky/tidewater.LICENSE.txt`](src/sky/tidewater.LICENSE.txt).
- Base ocean version: the three.js / TSL edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86).
  `src/ocean/OceanFFT.ts`, `src/ocean/Water.ts` and `src/ocean/Caustics.ts` adapt the FFT structure,
  water optics and rasterised caustics for this project's stylised rendering.
- Spectrum and foam version: native WebGPU edition, commit
  [`4811ba4`](https://github.com/dgreenheck/tidewater/tree/4811ba48d795197de5621985f404e765c0b7c0ef).
  [`src/ocean/OceanFFT.js`](https://github.com/dgreenheck/tidewater/blob/4811ba48d795197de5621985f404e765c0b7c0ef/src/ocean/OceanFFT.js)
  supplies the JONSWAP / TMA spectrum helpers, frequency-dependent directional spreading,
  frequency-to-wavenumber conversion, dual local-wind/swell spectrum reference and persistent
  compression-driven whitecaps. `src/ocean/OceanSpectrum.ts` ports the spectrum helpers to CPU
  TypeScript; `src/ocean/OceanFFT.ts` combines both spectra before one FFT evolution pipeline.
  Soomi normalises the authored swell significant height over the represented modes and computes
  finite-depth Airy surface velocities from the same forward/backward Fourier phases, independently
  of artistic horizontal compression. Additional velocity fields increase the FFT data processed;
  the two wave systems do not run as separate FFT simulations.
- Foam files: `src/ocean/FoamTexture.ts` adapts the CPU lace generation from
  [`src/ocean/SurfFoam.js`](https://github.com/dgreenheck/tidewater/blob/4811ba48d795197de5621985f404e765c0b7c0ef/src/ocean/SurfFoam.js);
  `src/ocean/Water.ts` adapts its density-to-hole mapping, pattern-only surface-gradient
  normals, bubbly relief and cavity shading.
  The repeatable pattern is mipmapped, scaled down and has its low-density strands broken into
  shorter arcs. These foam adaptations remain in the source for reference; the current scene disables
  all visible shore foam and offshore whitecaps, and leaves the foam-history update idle.
- Rocky-boundary changes: `src/ocean/ShoreWaves.ts` and `src/ocean/ShoreWaveField.ts` retain the
  notice from the earlier shore-wave adaptation. Their current geometric boundary, weak mirrored
  response and closed-island shelter are Soomi extensions. They read actual FFT heights and Airy
  velocities instead of adding a separate single-period beach wave or an arrival-time wave field.
  A narrow dominant-direction ray fan and water-only smoothing approximate land shelter; the local
  correction has an exact zero rim. Contact energy is driven by a raised incident surface and
  inward particle motion, with separate water-side exposure suppression. The mirror shares the
  incident phase and supplies weak local height/velocity correction; it is not a diffraction or
  fluid-impact solver. Geometry normals include spatial damping-gradient terms. Local seabed
  refraction, beach run-up, plunging sheets and spray are not implemented.
- Foam transport reference: the carried-foam / fresh-whitewater separation, density-dependent
  lifetime and expansion-driven thinning are informed by
  [`src/ocean/ShoreSim.js`](https://github.com/dgreenheck/tidewater/blob/4811ba48d795197de5621985f404e765c0b7c0ef/src/ocean/ShoreSim.js).
  `src/ocean/OceanFoam.ts` is an original TSL history/advection implementation using the FFT-driven
  rock-boundary flow, with land checks; the backtracing technique is credited to Jos Stam below.
  It does not port Tidewater's analytic beach clock, sand wetness, stranded sand foam or spray
  deposition. See [`docs/water.md`](docs/water.md) for the current source map, defaults and limits.
- Sky version: native WebGPU edition, the same pinned `4811ba4` commit (2026-09-25),
  `src/sky/Atmosphere.js` and `src/sky/Sky.js`.
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
- Solar radiance normalisation: the projected-solid-angle irradiance integral described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals),
  independently implemented with a shared scene radiance unit and an integrated limb-darkening profile.
- Contact-hardening solar shadows: Randima Fernando,
  [*Percentage-Closer Soft Shadows*](https://download.nvidia.com/developer/presentations/2005/SIGGRAPH/Percentage_Closer_Soft_Shadows.pdf)
  (SIGGRAPH 2005), independently implemented in TSL for a directional solar disk.
- Air/water optical interface: Snell's law and dielectric transport as described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Reflection_Models/Dielectric_BSDF),
  independently implemented for solar direction, beam-area conservation, two-segment shadows,
  full view-ray refraction and the radiance/index-squared invariant at the exit interface.
- Static local sky/contact visibility: John C. Hart,
  [*Sphere Tracing*](https://doi.org/10.1007/s003710050084) (1996), and the
  [cosine-weighted hemisphere sampler in PBRT](https://pbr-book.org/4ed/Sampling_Algorithms/Sampling_Multidimensional_Functions),
  independently implemented on bounded procedural fields; this is finite-radius contact visibility.
- Filtered wave-slope moments: Marc Olano and Dan Baker,
  [*LEAN Mapping*](https://userpages.cs.umbc.edu/olano/papers/lean/) (I3D 2010),
  independently implemented for the FFT cascades with an anisotropic Beckmann slope distribution.
- Microfacet masking: Eric Heitz,
  [*Understanding the Masking-Shadowing Function in Microfacet-Based BRDFs*](https://jcgt.org/published/0003/02/03/)
  (JCGT 2014), independently implemented with correlated Smith visibility. The error-function
  approximation uses Abramowitz and Stegun, equation 7.1.26.
- Bounded foam diffuse reflectance: Lambert's irradiance/radiance relation described in
  [*Physically Based Rendering*, fourth edition](https://pbr-book.org/4ed/Reflection_Models/Diffuse_Reflection),
  independently implemented with a 0.95 hemispheric reflectance and separate direct/sky inputs.

- Seabed substrate reference: Page C. Valentine, USGS,
  [*Sediment classification and the characterization, identification, and mapping of geologic substrates*](https://www.usgs.gov/publications/sediment-classification-and-characterization-identification-and-mapping-geologic)
  (2019, SIR 2019–5073). Rock patches, mixed clast sizes and partial sand burial inform the
  procedural seabed layout; no source code, survey data or images are used.

- Cliff and rim reference: U.S. National Park Service,
  [*Coastal Processes—Erosion*](https://www.nps.gov/articles/coastal-processes-erosion.htm),
  and USGS, [*Factors affecting sea cliff erosion*](https://www.usgs.gov/media/images/factors-affecting-sea-cliff-erosion).
  Uneven retreat, varied cliff slopes and local toe wear inform the procedural island edge;
  no source code, survey data or images are used.
