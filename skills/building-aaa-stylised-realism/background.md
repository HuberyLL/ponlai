# Background: why the layers and the order

Why the skill works as it does, and the public sources it rests on. The steps are in
[SKILL.md](SKILL.md).

## Why materials stay physical

A physically based renderer gives every surface the same light. If each material holds plausible
values, the relations between them (how much darker wet stone is than dry sand, how a leaf glows
against the sky) come out right without tuning one against another, and new content joins without
tuning of its own. A material pushed to fix something the light or the image got wrong carries
that error in its albedo. When the light is corrected later, every such material is wrong again,
each in its own way.

The failure is common: grass, stone and wood tuned one by one against finished frames each carry
a share of the light's errors, and every change of the light breaks them again. The fix is to keep
the materials at measured values and move the style into global knobs on the light and the image.

A second, older form of the same loop: an exposure metered from the frame's luminance reads the
albedo too, so a dark material darkens nothing on screen; authors then push albedos darker to make
the image read, and the exposure follows them. Metering from the illuminance (the light falling on
the scene) breaks the loop (Patry 2021, below).

## Why style goes in three places

Style made globally is consistent: one knob moves every material by the same rule, under every
weather and hour that knob covers. Style made per object is inconsistent by construction and has
to be repeated for each new object. The three places are where a global decision can be made:

- the content, decided per class of things;
- the light, as global knobs per weather and time of day over a physically based model;
- the image, as exposure, tone mapping and grade over the whole frame.

## Why this order

Each layer takes the one before it as input: the light falls on the materials, the air takes the
lit surfaces, the exposure meters what the air leaves, the tone curve maps what the exposure gives,
and the grade colours what the curve gives. A downstream layer cannot be judged until its input
is right, and a fix made downstream for an upstream fault breaks when the fault is fixed.

The order is this skill's own arrangement by that dependency, not a published standard. It rests
on two kinds of established practice:

- Physically based rendering in games, with materials kept apart from the light and the renderer
  checked against references: materials authored with plausible values, lights in photometric
  units, exposure from a physically based camera, and validation against measured or path-traced
  references (Lagarde and de Rousiers 2014; Patry 2020, 2021).
- Film look development: assets are developed in a colour-controlled neutral light, with a grey
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
