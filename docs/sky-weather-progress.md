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

### Stage 5 — wind, precipitation and wet surfaces

- One integrated world-space wind drives cloud travel, rooted vegetation gusts, falling rain
  and FFT cascade amplitudes. Speed changes preserve wind phase and accumulated travel.
  Calm long swell remains restrained; weather changes never rebuild the random wave spectrum.
- Ocean displacement, gradients, signed slope covariance and horizontal Jacobian use the same
  cascade gains. The shoreline observation cache also refreshes when a paused wind gain changes.
  `verify-ocean-weather.mjs` passes actual GPU checks of linear/squared scaling, reconstructed
  Jacobian, shoreline refresh and unchanged spectrum revisions.
- Rain adds one depth-tested instanced draw (192/384/640 streaks). A conservative island height
  mask and opaque/water depth reject hidden drops. Rain has no emissive floor, and its radiance
  uses the displayed sky integral and key light before the scene grade.
- Two staggered analytic impact fields add a filtered 0.3 mm ripple gradient to the same water
  normal used for reflection and refraction. There is no foam, opaque surface layer or extra
  fluid simulation. Pixel-footprint filtering removes unresolved rings in distant water.
- Rain gradually wets exposed rock, turf and foliage; surfaces retain moisture after rain stops.
  Rock darkening is capped at 16%, vegetation at 8% (petals 5%), with bounded roughness changes.
  The existing animated tidal/submerged band is excluded from rain wetness.
- Type checking, CPU day/weather/wind continuity checks, six integrated weather GPU checks and
  the existing wave-optics regression pass. Repeated five-preset and night-rain captures remain
  deterministic; near-water rock and sand detail remains visible.
- Final review found and corrected a fast-clock edge case: a large same-source light movement
  must not trigger the dark sun/moon handoff. Explicit source roles and wall-time lighting cadence
  now preserve continuous daylight at low frame rates. The GPU regression passes three actual
  handoffs plus 30-degree sun and moon moves, with zero dark samples in either same-source case.
- Final night-sky regression and production build pass. The screenshot harness waits for the
  loading overlay's CSS fade before testing frozen pixels, avoiding false frame differences.
- Fixed dry/wet review at 16:00, established rain, t=12: cliff luma **49.11 → 48.19/255**,
  meadow **50.78 → 50.16**, shallow water **exactly unchanged**. Separate streak geometry affects
  only **0.157%** of overview pixels by more than one channel level. Native paired crops are in
  `artifacts/sky-weather/stage5-wetness/`.
- The final effects probe passes all five checks with no GPU, browser, asset or shader warnings.
  Fourteen frozen capture pairs are byte-identical. The 105,298 sampled exposed material pixels
  show a mean wetness radiance change of **5.86e-5**; tidal/submerged differences stay below **4.4e-9**, with
  **zero depth changes**. The near-water ripple crop changes 1,413 pixels by more than one
  channel level without raising average luminance or clipping; distant rings fade below a
  pixel. Evidence: `artifacts/verification/weather-effects/` and `stage5-ripples/comparison.png`.
- Low/medium/high integration checks confirm 192/384/640 rain instances, respectively. All
  three stabilize at 86 textures after rain has initialized; dry startup uses 85.
- Final required-resolution measurements use the same isolated WebGPU/Metal capture browser,
  CSS 2400 × 1500 / DPR 1.5, five samples each. There are no console or asset errors:

  | State, medium quality | Mean frame time | Sampled P95 range |
  | --- | ---: | ---: |
  | Fair, 16:00, moving clouds/waves, day clock paused | 27.362 ms | 32.5–32.9 ms |
  | Rain, 16:00, moving clouds/waves/rain | 27.910 ms | 31.0–31.3 ms |
  | Rain, midnight, moving clouds/waves/rain | 27.754 ms | 31.1–32.6 ms |
  | Fair, running day clock from noon, all lighting updates | 26.976 ms | 28.8–38.0 ms |

  Fair and rain are respectively **+3.16% / +5.23%** versus the initial 26.524 ms static
  baseline; rain adds **0.864 ms** versus stage 4. The running-clock view has different solar
  lighting and is reported separately. Periodic sky/shadow updates are visible in the P95.
  This remains above a 60 FPS budget. Evidence: `artifacts/captures/stage5-*-performance.json`.

## Implementation limits

- This is an authored fantasy day cycle, not a date/location astronomy model. One dominant
  sun/moon key keeps direct illumination, island shadows and refracted water lighting coherent.
- Clouds use a bounded low-resolution volume cache with interpolated lighting and reflections;
  the close sky view is deliberately soft. Quality changes step count, update cadence, shadow
  cadence and rain count, rather than adding an unbounded full-screen volume pass.
- Rain uses local streaks, a conservative height mask and analytic normal ripples; it does not
  simulate droplets, puddles or water impacts. Air perspective uses the underlying scene depth
  for translucent streaks, a small approximation at distant views.
- Night rain retains silhouettes and shallow-water boundaries but intentionally loses fine
  contrast; it is darker than clear full-moon illumination. No mobile performance claim is made.

## Review controls

Press **H** for controls and **Space** to pause scene animation and the day clock. `Time & moon`
offers hours, seconds per day, independent clock pause, presets, phase and optional lunar advance.
`Sky & clouds` includes island, horizon and sky review cameras.
`Weather` selects clear/fair/cloudy/overcast/rain and transition duration (0 for immediate review).
It also provides separate rain/ripple and wet-surface toggles for fixed-state comparisons.
Weather and cloud motion pause with the scene; the independent day-clock pause leaves them moving.
Reproducible URLs accept `paused&t=12&hour=16&moon=0.5&quality=medium&dpr=1`;
add `weather=rain` to load established rain, or `clouds=0` for a cloud-cover review override.
`clock=paused` freezes only the day clock. Presets include dawn, sunrise, noon, golden-hour,
sunset, dusk and midnight. The debug API is available only in development or with `?debug`.

## Re-run verification

Use the isolated worktree dev server, not another checkout's existing server. Run GPU commands
sequentially with other test pages closed:

```sh
npm run build
node tools/verify-day-cycle.mjs
node tools/verify-weather-state.mjs
node tools/verify-wind.mjs
node tools/verify-dynamic-sky.mjs http://127.0.0.1:5196
node tools/verify-night-sky.mjs http://127.0.0.1:5196
node tools/verify-celestial-handoff.mjs http://127.0.0.1:5196
node tools/verify-weather.mjs http://127.0.0.1:5196 --coupling
node tools/verify-ocean-weather.mjs http://127.0.0.1:5196
node tools/verify-weather-effects.mjs http://127.0.0.1:5196
node tools/verify-wave-optics.mjs http://127.0.0.1:5196
```

Full frame sheet: `artifacts/sky-weather/final-overview.png`. Originals and unscaled local
comparisons remain beside the individual stage reports. No reference imagery or generated
evidence enters the production build.
