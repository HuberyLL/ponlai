# Background: why the layers and the order

This page explains why the skill works as it does, and lists the public sources it rests on. The
steps are in [SKILL.md](SKILL.md).

## Why materials stay physical

A physically based renderer gives every surface the same lighting. If each material holds
plausible values, the relations between materials come out right without tuning one against
another: how much darker wet stone is than dry sand, or how a leaf glows against the sky. New
content then joins without tuning of its own. A material pushed to fix something that the lighting
or post-processing got wrong carries that error in its albedo. When the lighting is corrected later,
every such material is wrong again, each in its own way.

This failure is common. Grass, stone and wood tuned one by one against finished frames each carry a
share of the lighting's errors, and every change to the lighting breaks them again. The fix is to
keep the materials at measured values and move the style into global parameters on the lighting and
post-processing.

An older form of the same loop involves exposure. An exposure metered from the frame's luminance
also reads the albedo, so a dark material does not darken anything on screen. Authors then push
albedos darker to make the image read, and the exposure follows them. Metering from the illuminance
(the light falling on the scene) breaks the loop (Patry 2021, below).

## Why style goes in three places

Style applied globally is consistent: one parameter changes every material by the same rule, under
every weather and time of day that the parameter covers. Style applied per object is inconsistent
by construction, and it has to be repeated for each new object. The three places are where a global
decision can be made:

- the content, decided per class of things;
- the lighting, as global parameters per weather and time of day over a physically based model;
- post-processing, as exposure, tone mapping and colour grading over the whole frame.

## Why this order

Each layer takes the one before it as input. The lighting falls on the materials; the atmosphere
acts on the lit surfaces; the exposure meters what the atmosphere leaves; the tone curve maps what
the exposure gives; and the colour grade colours what the curve gives. You cannot judge a
downstream layer until its input is right, and a fix made downstream for an upstream fault breaks
when the upstream fault is fixed.

The order is this skill's own arrangement by that dependency, not a published standard. It rests
on two kinds of established practice:

- Physically based rendering in games, with materials kept separate from lighting and the renderer
  checked against references: materials authored with plausible values, lights in photometric
  units, exposure from a physically based camera, and validation against measured or path-traced
  references (Lagarde and de Rousiers 2014; Patry 2020, 2021).
- Film look development: assets are developed in colour-controlled neutral lighting, with a grey
  ball, a chrome ball and a colour chart, before shot lighting gives each shot its look (Amin
  2021).

## Sources

Each entry states only what the cited page states.

- Jasmin Patry, *Samurai Shading in Ghost of Tsushima*, SIGGRAPH 2020 course Physically Based
  Shading in Theory and Practice
  (<https://blog.selfshadow.com/publications/s2020-shading-course/>). Its introduction states that
  the art direction called for "stylized realism", that the lighting models are physically based,
  that materials are authored with physically plausible values, and that lighting can deviate from
  physical correctness, with artists able to adjust it globally.
- Jasmin Patry, *Real-Time Samurai Cinema: Lighting, Atmosphere, and Tonemapping in Ghost of
  Tsushima*, SIGGRAPH 2021 course Advances in Real-Time Rendering in Games
  (<https://advances.realtimerendering.com/s2021/>). It repeats the introduction above and, on
  exposure, states that an exposure and albedo feedback loop in earlier games resulted in albedo
  values that were too dark; that the team created a diffuse colour reference chart; and that it
  switched to a primarily illuminance-based exposure, using luminance only where highlights exceed
  a threshold.
- Sébastien Lagarde and Charles de Rousiers, *Moving Frostbite to Physically Based Rendering 3.0*,
  SIGGRAPH 2014 course Physically Based Shading in Theory and Practice
  (<https://seblagarde.wordpress.com/wp-content/uploads/2015/07/course_notes_moving_frostbite_to_pbr_v32.pdf>).
  Its notes state the decoupling of material and lighting information as a core principle (section
  1); validation against measured and path-traced references and an in-engine reference mode
  (section 2); lights in photometric units (section 4); a physically based camera and the problem
  of exposing from luminance that includes the albedo (section 5.1); and, for the move to physically
  based rendering, an object viewer with a sun calibrated so that a lit object returns its diffuse
  albedo, and view modes that check material ranges and lighting illuminance (section 6).
- Jahirul Amin, *The Grey, the Chrome and the Colour Chart*, CAVE Academy, 15 July 2021
  (<https://caveacademy.com/?p=35653>). It describes the grey ball (light direction, intensity and
  shadow), the chrome ball (where things are in space), the colour chart (exposure and white
  balance, not colour correction), and a look development team using them to work in a colour
  controlled neutral space.
