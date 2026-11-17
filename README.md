<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

<!-- HEADER IMAGE: the header image's GitHub attachment link goes here. -->

# Ponlai

**A physically based render pipeline for cinematic game visuals in the browser.**

[![Check](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml/badge.svg)](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![three.js r186](https://img.shields.io/badge/three.js-r186-black?logo=threedotjs)](https://threejs.org/)
[![WebGPU](https://img.shields.io/badge/WebGPU-required-005a9c)](https://www.w3.org/TR/webgpu/)
[![Node.js 26](https://img.shields.io/badge/Node.js-26-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>
<!-- markdownlint-enable MD033 -->

Ponlai is a render pipeline for the browser, built on three.js and WebGPU. Everything in it is
physically based:

- **Ocean**: an FFT sea with shore waves, foam, refraction, and reflections of the sky and the
  shore.
- **Sky**: a physical atmosphere, volumetric clouds and their shadows, a day cycle, and a night sky
  with a real star catalogue and the moon.
- **Light**: soft sun shadows, ambient light probes, light bounced from the ground, clustered local
  lights, ambient occlusion (GTAO) and light shafts.
- **Air**: a volumetric haze that thickens with distance and thins with height.
- **Vegetation**: instanced plants with levels of detail that move in the wind.
- **Image**: automatic exposure with the Purkinje shift in low light, local tone mapping, a
  colour-grading LUT, physical bloom, TAA or MSAA, FSR upscaling and dynamic resolution.
- **Frame graph**: every pass declares the targets it reads and writes.
- **Repeatable frames**: a paused page draws the same frame on every load, so a change can be
  checked by comparing captures.

With it come agent skills for making the look, and tools that capture, compare and measure its
frames.

This repository shows it on a small island in an open sea, with deep clear water, chunky stone and
a meadow that moves in the wind, lit by the sun and the sky.
The look is inspired by the eastern aesthetic of Ghost of Tsushima.

## Why Ponlai

Ponlai's aim is that anyone working with an AI coding agent can make game visuals of the quality of
AAA games and film. The render pipeline gives the agent a physically based ground to build on, the
skills give it the methods a lighting artist and a graphics engineer work by, and the tools let it
see, compare and measure what it made, so it can check its own work.

## Status

The high quality tier at 4K output (1920x1080 CSS pixels at a device pixel ratio of 2), in the clear
and fair weathers, is the one kept up to date. The other quality tiers (`medium`, `low`) and
weathers (`cloudy`, `overcast`, `rain`, `storm`, `fog`) are parked: they are still in the code, but
their look and cost are not maintained. `?game` opens an early game prototype on the island.

## Quick start

You need a browser with WebGPU, such as a current Chrome or Edge, and Node.js 26 with npm.

```bash
git clone https://github.com/HuberyLL/ponlai.git
cd ponlai
npm ci
npm run dev
```

Then open <http://127.0.0.1:5190/>. On its first start, the dev server downloads the assets
(textures, sky catalogues, characters) into the git-ignored `public/` folder.

Some pages to try:

| Address | What it shows |
| --- | --- |
| <http://127.0.0.1:5190/?weather=fair&preset=sunset> | The island at sunset on a fair day |
| <http://127.0.0.1:5190/?paused&t=12> | The scene paused at 12 seconds, as the tools capture it |
| <http://127.0.0.1:5190/?game> | The game prototype |
| <http://127.0.0.1:5190/scenes.html?scene=ball> | A test scene without the island (`ball`, `empty`, `sea` or `plants`) |

[URL options](docs/reference/url-options.md) lists every option.

## Use Ponlai in your own project

- **Start a project**: copy [the example](examples/rock/README.md), a rock in the open sea. It
  brings the render pipeline, the tools (already configured) and the assets, and installs and runs on
  its own.
- **Add the tools to a project you have**: follow [the kit's README](tools/kit/README.md).
- **Use the agent skills**: install them as a Claude Code plugin ([below](#agent-skills)). They work
  in any project.

To work on Ponlai itself, [Contributing](.github/CONTRIBUTING.md) lists the programs the checks and
tools need beyond the quick start.

### Agent skills

Each skill is a method for any project. What it needs to know about your project, such as which
tool takes a capture, which views to compare and which tolerances hold, goes in a binding page that
it reads (this repository's are in `docs/bindings/`). Two of the skills make the look:

- [Building a stylised-realism picture](skills/building-cinematic-stylised-realism/SKILL.md) keeps
  materials and light physically plausible, and puts the style in the content, a few global light
  values per weather and hour, and the image.
- [Fitting a look to reference images](skills/fitting-a-look-to-reference-images/SKILL.md) finds
  the light, air and image values that bring a frame to your own reference images.

The others verify a change, measure frame time, find the cause of a defect or of a frame that does
not repeat, and write shaders, tools and docs ([the docs' index](docs/README.md), Skills).

To install them in Claude Code:

```bash
claude plugin marketplace add HuberyLL/ponlai --sparse .claude-plugin plugins skills
claude plugin install ponlai@ponlai
```

The `--sparse` option downloads only the folders the plugin needs. The skills then carry the
plugin's name, such as `ponlai:verifying-rendering-changes`; update them with
`claude plugin marketplace update ponlai`. With another agent, copy a skill's folder into the
agent's skills folder. Either way, write a binding page of your own with the same sections as this
repository's. The plugin brings only the skills; the tools come with the example.

## Structure

The code is in layers, lowest first: the render pipeline (`packages/render/`), the island
(`packages/island/`), the game (`packages/game/`) and the page (`app/`). Each layer imports only from
the layers below it. [Architecture](ARCHITECTURE.md) describes the layers, the flows and the rules
across them, and [the docs' index](docs/README.md) lists every page.

## Contribute

Questions and ideas go to [Discussions](https://github.com/HuberyLL/ponlai/discussions), bugs and
requests to the issues. [Contributing](.github/CONTRIBUTING.md) says how to set up and send a
change, and everyone who takes part follows the [Code of Conduct](.github/CODE_OF_CONDUCT.md).
Report a security issue as [Security](.github/SECURITY.md) says.

## Licence

Ponlai is released under the [MIT License](LICENSE). [Credits](CREDITS.md) lists the third-party
code and assets, with their licences.
