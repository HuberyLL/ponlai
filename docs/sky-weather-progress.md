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

### Stage 2 — clock, sun and moon

- Independent pause/speed/hour controls, seven presets, continuous solar orbit and geometric
  lunar phase. The sun/moon key drives terrain, characters, water, caustics and both shadow maps.
- Reusable paired panorama/PMREM endpoints blend with their cloud shadows and direct light.
  A GPU hemisphere integral supplies water and character fill; CPU readback is diagnostic only.
  The cloud/atmosphere march runs once over the upper hemisphere per bake.
- Night exposure is 4.4 versus 2.35 by day, with black lift reduced from .027 to .002.
  Full-moon energy remains below 15% of noon; darkness comes from reduced radiance throughout
  the scene. This is an art-directed orbit and moonlight scale, not an astronomical calendar.
- CPU clock tests, production build and five integrated WebGPU checks pass, including GPU/CPU
  irradiance agreement, seven hours, phase-dependent lighting, running/pause behavior and
  bounded GPU resources over repeated changes. Evidence: `artifacts/verification/dynamic-sky/`.
- Noon → midnight displayed luma: meadow 129.96 → 25.20, cliff 115.41 → 19.63,
  shallow water 109.81 → 26.02, open sea 88.74 → 20.48. Paired crops:
  `artifacts/sky-weather/stage2-night/`. Water and cliff detail remains present at night.
- The 16:00 preset places the sun at 26.2° instead of the previous manual 32°; its meadow crop
  changes from 120.00 to 109.94. Matched crops: `artifacts/sky-weather/stage2-golden/`.
- Dynamic required-resolution measurement: see `stage2-live-performance.json`; **26.901 ms**
  mean (+1.42%) and 35.6–38.4 ms sampled P95, versus the 26.524 ms static baseline. Sky updates have a measurable
  periodic cost; this is not a 60 FPS claim. Texture count stabilizes at 84.

### Stage 3 — stars and lunar detail

- A fixed celestial star field uses angular, energy-preserving pixel filtering. Visible stars,
  water reflections, PMREM and hemisphere irradiance share the field and cloud transmission.
  The displayed panorama remains star-free so analytical stars are not counted twice.
- New moon has exactly zero disk radiance. Resolved crescent/quarter/full lunar areas are
  388/1167/2188 pixels in the fixed test. Lower disk radiance retains lunar markings without
  the previous strong bloom; moonlight on the island is unchanged.
- `verify-night-sky.mjs` passes: 1499 contributing star pixels in the 512² raw probe,
  maximum scene radiance .01093; frozen-repeat and camera-return errors are exactly zero,
  and daytime stellar contribution is exactly zero. Four lunar image pairs and the star pair
  are byte-identical. Evidence: `artifacts/verification/night-sky/`.
- Display grade follows the published sky endpoints. Fast sun/moon handoffs fade out the old
  key, turn with zero direct energy, then fade in the new key, preventing an illuminated swing.
- `verify-celestial-handoff.mjs` passes three rapid sunset/sunrise transitions with 36 samples
  each, including 15 exactly dark turning samples. Published exposure agrees with the sky.
- Required-resolution daylight benchmark: **27.060 ms** mean (+0.159 ms versus stage 2),
  sampled P95 38.4–38.7 ms. Star reflection source adds one stable texture (85 total).

### Stage 4 — coherent weather and distant air

- Clear, fair, cloudy, overcast and rain presets interpolate cloud amount/density, direct
  visibility, diffuse sky, distant air and wind. A new request starts from the current state,
  so a transition can be reversed without resetting to the previous preset.
- Sky, reflected panorama, PMREM, cloud shadows, celestial disks and displayed haze share
  completed endpoints. Dense clouds desaturate their existing radiance rather than adding grey.
- Air perspective reads the nearest opaque/water depth after water compositing; the first
  85 m are protected and the original refraction source remains unchanged.
- Initial night rain was rejected as too dark: meadow/cliff luma 11.64/10.56. Increasing only
  the dense-cloud night diffuse fill gives 18.41/16.40, below clear full moon 25.20/19.63.
  Evidence and paired crops: `artifacts/sky-weather/stage4-night/`.
- Initial five-preset GPU verification passes fixed states, night rain, interrupted live
  five-second transitions, and bounded resources across twelve repeated weather changes.
  Evidence: `artifacts/verification/weather/`.
- Reduced daytime overcast black lift from .027 to .01404 removes the grey floor without
  changing exposure: rain meadow/cliff luma 60.29/58.86 → 50.79/49.13. Local adjacent-pixel
  contrast rises from 3.04/1.63 to 3.60/1.93. Crops: `stage4-rain-afternoon/`.
- Required-resolution live mean: fair **27.148 ms**, rain **27.046 ms**, with respective
  sampled P95 ranges 32.3–32.7 / 32.3–32.4 ms. The medium sky interval is now .8 seconds;
  low/medium/high use 6/10/14 cloud steps and 1.2/.8/.5-second bake intervals.
- Final five-check weather regression and production build pass. Rain fog off/on gives
  exactly **0/255 RGB difference** over the protected meadow, cliff, shallow-water and
  foreground-sea crops; the distant sea changes by **32.77/255**. It is distance-based air,
  not a white overlay across the island. See `report.json` fog measurements and paired PNGs.

## Review controls

Press **H** for controls and **Space** to pause scene animation and the day clock. `Time & moon`
offers hours, seconds per day, independent clock pause, presets, phase and optional lunar advance.
`Sky & clouds` includes island, horizon and sky review cameras.
`Weather` selects clear/fair/cloudy/overcast/rain and transition duration (0 for immediate review).
Weather and cloud motion pause with the scene; the independent day-clock pause leaves them moving.
Reproducible URLs accept `paused&t=12&hour=16&moon=0.5&quality=medium&dpr=1`;
add `weather=rain` to load established rain, or `clouds=0` for a cloud-cover review override.
`clock=paused` freezes only the day clock. Presets include dawn, sunrise, noon, golden-hour,
sunset, dusk and midnight. The debug API is available only in development or with `?debug`.
