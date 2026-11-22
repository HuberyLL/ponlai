# Credits

Ponlai is released under the MIT License (`LICENSE`). This page lists the third-party sources whose
licences ask for a notice or a credit. The repository follows the
[REUSE specification](https://reuse.software/spec-3.3/): a file holding third-party code carries
that code's SPDX copyright and licence tags in its `/*! */` notice, `REUSE.toml` covers the files
that carry none, and `LICENSES/` holds the text of every licence used, named by its SPDX id. A
production build keeps the notices in the bundle and copies this page, `LICENSE`, `LICENSES/`, the
fonts' licences and those of the bundled npm packages (`dependencies.md`) into `dist/licenses/`.
Papers, talks and techniques are credited in a comment where they are used.

<!-- REUSE-IgnoreStart -->

## Adapted code

All MIT ([`LICENSES/MIT.txt`](LICENSES/MIT.txt)) but pbrt-v3, BSD-2-Clause
([`LICENSES/BSD-2-Clause.txt`](LICENSES/BSD-2-Clause.txt)); each adapted file names its source and
carries the notice.

- [tidewater](https://github.com/dgreenheck/tidewater), by Daniel Greenheck: © 2026 DRG Software
  Solutions LLC. The ocean, the water, the sky, the clouds, the post-processing and the sea's
  creatures, in `packages/render/` and `packages/island/life/`.
- [three-geospatial](https://github.com/takram-design-engineering/three-geospatial), by Shota
  Matsuda: © 2024 Shota Matsuda. The lunar disk (`packages/render/sky/NightSky.ts`).
- [a-starry-sky](https://github.com/Dante83/a-starry-sky), by David Evans: © 2018-2026 David Evans.
  Earthshine (`packages/render/sky/NightSky.ts`).
- [Godot_rain_shader](https://github.com/Lexpartizan/Godot_rain_shader), by Lexpartizan: © 2020
  Lexpartizan. The flow in the rain runnels (`packages/render/materials/Wetness.ts`).
- [Hash without Sine](https://www.shadertoy.com/view/4djSRW), by David Hoskins: © 2014 David
  Hoskins. Hashes in `packages/render/materials/` and `packages/render/ocean/Water.ts`.
- [hextile-demo](https://github.com/mmikk/hextile-demo), by Morten S. Mikkelsen: © 2022 mmikk. Hex
  tiling (`packages/render/materials/HexTiling.ts`).
- `LightningStrike.js`, by yomboprime, from the three.js examples as kept in
  [three-stdlib](https://github.com/pmndrs/three-stdlib): © 2010-2023 three.js authors,
  © 2021-2023 Poimandres. The lightning channel (`packages/render/weather/LightningStrike.ts`).
- [VolumetricCloudsCS1](https://github.com/anthonytoumaibrahim/VolumetricCloudsCS1), by Anthony
  Ibrahim: © 2026 Anthony Ibrahim. Lightning, rain curtains and the rainbow's bake, in
  `packages/render/sky/`, `packages/render/weather/Lightning.ts` and
  `tools/render/bake-rainbow-table.mjs`. Its licence's exception covers light halo shaders, which
  Ponlai does not use.
- [threejs-conference](https://github.com/ektogamat/threejs-conference), by Anderson Mancini and
  Sunag: © 2026 Anderson Mancini and Sunag; the same pattern in the three.js example
  `webgpu_compute_particles_rain.html`, © 2010-2026 three.js authors. Collision rain
  (`packages/render/weather/RainCollision.ts`, `RainDrops.ts`).
- AMD FidelityFX Super Resolution 1, through three.js's `FSR1Node`: © 2021 Advanced Micro Devices,
  Inc., © 2010-2026 three.js authors. `packages/render/post/FSR.ts`.
- three.js's `PMREMGenerator` and `PMREMUtils`: © 2010-2026 three.js authors. The environment's GGX
  prefilter (`packages/render/sky/Prefilter.ts`).
- AMD FidelityFX Super Resolution 2, through tidewater's `TemporalUpscale.js`: © 2022-2023 Advanced
  Micro Devices, Inc., © 2026 DRG Software Solutions LLC. `packages/render/post/TemporalLocks.ts`.
- [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) 2.3.0, FSR 3
  upscaler: © 2026 Advanced Micro Devices, Inc. (the MIT section of the SDK's licence).
  `packages/render/post/fsr3/` and `packages/render/post/TemporalHistory.ts`.
- [AMD FidelityFX SDK](https://github.com/GPUOpen-LibrariesAndSDKs/FidelityFX-SDK) 1.1.4,
  Stochastic Screen-Space Reflections and the reflection denoiser: © 2024 Advanced Micro Devices,
  Inc. The sea's reflection (`packages/render/ocean/SeaReflection.ts`,
  `packages/render/ocean/ScreenReflection.ts`).
- [temporal](https://github.com/playdeadgames/temporal), by Playdead: © 2015 Playdead. Clipping the
  history to a box, as the FidelityFX denoiser does it (`packages/render/ocean/SeaReflection.ts`).
- [pbrt-v3](https://github.com/mmp/pbrt-v3), by Matt Pharr, Greg Humphreys and Wenzel Jakob:
  © 1998-2015 Matt Pharr, Greg Humphreys and Wenzel Jakob (BSD-2-Clause). The sampling of
  Beckmann's visible normals (`packages/render/ocean/ScreenReflection.ts`).
- [meshoptimizer](https://github.com/zeux/meshoptimizer), by Arseny Kapoulkine, bundled from three's
  `examples/jsm/libs/meshopt_simplifier.module.js`: © 2016-2026 Arseny Kapoulkine. Its notice
  ships in the bundle through `packages/island/world/IslandSimplify.ts`.

## Assets

Not in the repository: they ship in the assets release that `assets.lock.json` names, at the paths
given in `public/` (`tools/repo/assets.mjs`). A file made by a tool says how in the tool's header.

- *Rock Face 03*, Dario Barresi and Rico Cilliers,
  [Poly Haven](https://polyhaven.com/a/rock_face_03), CC0-1.0: `public/textures/rock/`.
- *Brown Mud Leaves 01*, Rob Tuytel,
  [Poly Haven](https://polyhaven.com/a/brown_mud_leaves_01), CC0-1.0: `public/textures/ground/`.
- *CGI Moon Kit*, Ernie Wright, NASA's Scientific Visualization Studio,
  [SVS 4720](https://svs.gsfc.nasa.gov/4720/), public domain; credit: NASA's Scientific
  Visualization Studio. `public/sky/moon/`.
- *Deep Star Maps 2020*, [SVS 4851](https://svs.gsfc.nasa.gov/4851), with the credit line it asks
  for: NASA/Goddard Space Flight Center Scientific Visualization Studio. Gaia DR2: ESA/Gaia/DPAC.
  `public/sky/milkyway.png`.
- *The Bright Star Catalogue*, 5th Revised Ed., D. Hoffleit and W. H. Warren Jr. (1991),
  Astronomical Data Center, NASA Goddard Space Flight Center, from the CDS catalogue
  [V/50](https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50), no licence stated; the CDS asks for an
  acknowledgement, which this is. `public/sky/stars.bin`.
- *Ultimate Modular Men Pack*, Quaternius,
  [quaternius.com](https://quaternius.com/packs/ultimatemodularcharacters.html), CC0-1.0:
  `public/characters/hanming/` is built from it.
- *A single white feather closeup*, João Estevão Andrade de Freitas,
  [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:A_single_white_feather_closeup.jpg),
  public domain: `public/characters/hanming/textures/feather-atlas.png`.
- *Wicker 005*, Lennart Demes, [ambientCG](https://ambientcg.com/view?id=Wicker005), CC0-1.0:
  `public/characters/hanming/textures/wicker-*`.
- Cloud shape noise, © 2026 DRG Software Solutions LLC, from
  [tidewater](https://github.com/dgreenheck/tidewater) (`public/clouds/baseShape64.bin` at commit
  `4811ba4`), MIT: tidewater's credits say its cloud noise comes from the same holder's Sky Pro
  WebGPU and is published there under its MIT licence. `public/clouds/baseShape64.bin`.

## Fonts

From npm, shipped with their licence texts.

- *LXGW WenKai GB*, LXGW, from Fontworks' Klee One
  ([LxgwWenKaiGB](https://github.com/lxgw/LxgwWenKaiGB), npm `lxgw-wenkai-gb-web`), OFL-1.1:
  [`packages/game/ui/fonts/LXGWWenKaiGB.OFL.txt`](packages/game/ui/fonts/LXGWWenKaiGB.OFL.txt).
- *Ma Shan Zheng*, The MaShanZheng Project Authors
  ([googlefonts/mashanzheng](https://github.com/googlefonts/mashanzheng), npm
  `@fontsource/ma-shan-zheng`), OFL-1.1:
  [`packages/game/ui/fonts/MaShanZheng.OFL.txt`](packages/game/ui/fonts/MaShanZheng.OFL.txt).

## Documents

- The [Code of Conduct](.github/CODE_OF_CONDUCT.md) is the
  [Contributor Covenant](https://www.contributor-covenant.org), version 2.1, CC-BY-4.0
  ([`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt)).

<!-- REUSE-IgnoreEnd -->
