# Credits

Soomi is released under the MIT License (see `LICENSE`). The third-party code and assets listed here
keep their own licences. Adapted source files also carry the upstream notice in their header. A
production build copies this file and the required licence texts, including those of the bundled npm
packages, into `dist/licenses/`.

## Adapted code

### tidewater

- Upstream: https://github.com/dgreenheck/tidewater
- Version: the three.js (TSL) edition, commit
  [`fd6cae6`](https://github.com/dgreenheck/tidewater/tree/fd6cae6fa57343d344e5c008e1abda974c824b86)
  (2026). Later commits port tidewater to its own WebGPU engine, so they no longer match this code.
- Copyright: (c) 2026 DRG Software Solutions LLC
- License: MIT, see [`src/ocean/tidewater.LICENSE.txt`](src/ocean/tidewater.LICENSE.txt)
- Files: `src/ocean/OceanFFT.ts`, `src/ocean/Water.ts`, `src/ocean/Caustics.ts`
- Changes: ported to TSL and modified for this project.

### glsl-atmosphere

- Upstream: https://github.com/wwwtyro/glsl-atmosphere
- License: Unlicense (public domain); no notice is required.
- Files: `src/sky/Sky.ts`
- Changes: the ray march is ported to TSL and baked into an equirectangular texture.

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
- Single-scattering atmosphere: T. Nishita, T. Shirai, K. Tadamura and E. Nakamae,
  [*Display of the Earth Taking into Account Atmospheric Scattering*](https://doi.org/10.1145/166117.166140)
  (SIGGRAPH 1993).
