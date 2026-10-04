# Dynamic sky and weather

Worktree branch: `codex/dynamic-sky-weather`, based on `16bd6a1`.

## Review stages

1. Clear sky and clouds: retain atmosphere LUTs; add bounded volumetric cloud lighting and matched reflections.
2. Time, sun and moon: continuous clock, presets, one coherent dominant direct light and exposure.
3. Night sky: stable stars, lunar phase, readable dark values.
4. Weather: smooth clear/fair/cloudy/overcast/rain transitions, distant aerial perspective.
5. Coupling: common wind, restrained precipitation, water ripples and persistent wetness.

Each stage receives fixed-camera overview and horizon captures, crops, frame measurements at
2400 × 1500 CSS pixels / DPR 1.5, and a local commit. No remote pushes.

## Existing systems retained

- Hillaire/tidewater atmosphere, transmittance and multiple-scattering LUT caches.
- Atmosphere-derived direct irradiance, equirectangular water reflections and PMREM environment.
- Solar/character shadows, refracted underwater sunlight, FFT ocean and shoreline transport.
- Existing vegetation geometry, character shading, island layout and transparent calm water.

## Audit findings

- The old full sky update pauses rendering during a GPU readback and recreates the PMREM target.
- Continuously moving the light also rebakes the refracted underwater shadow map.
- Character and underwater lighting assume a single primary source; use one coherent sun/moon key.
- Existing vegetation wind is independent per material. Changing the water wind uniform alone has no effect.
- Fixed sea-panorama radiance and display black lift must follow night illumination.

## Evidence

Generated evidence is kept in `artifacts/` and is not shipped. Captures run in an isolated
single-page headless Chromium with WebGPU; no other page is opened in the capture browser.

### Stage 1 — static sky and clouds

- Original three-dimensional cloud field, bounded 6/10/14-step integration, internal light
  attenuation, shared cloud transmission for sun, island, characters and water.
- Same cloud panorama feeds the visible sky, water reflections and PMREM. No extra screen veil.
- Initial lattice-cloud version was rejected: sea crop became 49.44/255 brighter and shapes
  appeared rectangular. Revised rounded cloud groups and lower ambient response remove this.
- `stage0-overview.png` → `stage1-overview.png`: meadow luma 117.21 → 120.00, cliff
  88.28 → 90.57, shallow water 83.11 → 85.44, open water 77.20 → 79.02.
- `stage0-horizon.png` → `stage1-horizon.png`: sea luma 121.29 → 122.85 (+1.56/255).
- Original paired crops and full metrics: `artifacts/sky-weather/stage1-{overview,horizon}/`.
- Required-resolution mean over five diagnostic samples: baseline **26.524 ms**, stage 1
  **26.730 ms** (+0.206 ms, +0.78%). Actual canvas 3600 × 2250, CSS 2400 × 1500 / DPR 1.5.
  This is above a 16.67 ms frame budget; do not claim 60 FPS or mobile validation.
- Same 53 draw calls / 1,918,066 rendered triangles; 74 → 75 textures. Cloud passes are baked
  in this static stage. Dynamic bake cost is measured separately in stage 2.
- Build and actual WebGPU captures pass. Sky-only cloud close view: `stage1-clouds.png`.
