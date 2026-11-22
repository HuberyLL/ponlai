<!-- markdownlint-disable MD033 MD041 -->
<div align="center">

<img src="https://github.com/user-attachments/assets/3e5ff102-f817-4f03-9ffe-b141263a4218"
  alt="The island in the afternoon, at sunset and at midnight" width="100%">

# Ponlai

**A physically based render pipeline for cinematic game visuals in the browser.**

**English** | [简体中文](README.zh-CN.md)

[![Check](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml/badge.svg)](https://github.com/HuberyLL/ponlai/actions/workflows/check.yml)
[![MIT License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![three.js r187](https://img.shields.io/badge/three.js-r187-black?logo=threedotjs)](https://threejs.org/)
[![WebGPU](https://img.shields.io/badge/WebGPU-required-005a9c)](https://www.w3.org/TR/webgpu/)
[![Node.js 26](https://img.shields.io/badge/Node.js-26-5fa04e?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

</div>
<!-- markdownlint-enable MD033 -->

Ponlai is a physically based render pipeline for the web, built on three.js and WebGPU. This
repository uses it to render a small island in the open sea: deep, clear water, rugged rocks and a
meadow swaying in the wind, all lit by a physically based sun and sky.
Its look draws on an eastern aesthetic, inspired by Ghost of Tsushima.

<!-- markdownlint-disable-next-line MD034 -->
https://github.com/user-attachments/assets/3d383d7f-1f63-4c0b-93e5-de34c9e9061d

## Features

### Rendering

- **Ocean**: FFT waves, shoreline waves, foam, refraction, screen-space reflections
- **Sky**: physically based atmosphere, volumetric clouds and cloud shadows, day-night cycle, a
  night sky with a real star catalogue and the moon
- **Lighting**: soft sun shadows, ambient light probes, ground bounce light, clustered local
  lights, GTAO, god rays
- **Fog**: volumetric distance and height fog
- **Vegetation**: instanced plants with LOD, animated by the wind
- **Post-processing**: auto exposure with the Purkinje shift, local tone mapping, LUT colour
  grading, physically based bloom, TAA or MSAA, FSR upscaling, dynamic resolution

### Built for AI agents to iterate on their own

- **Reproducible frames**: a paused page renders the same frame on every load, within a measured
  tolerance, so an agent can prove a change did what it meant, and nothing else, by comparing
  screenshots.
- **Tools**: the agent captures and compares screenshots, measures frame time and breaks down GPU
  time by render pass itself, without a person looking at the screen.
- **Skills**: written workflows for the agent, from building a look and matching it to reference
  images to verifying, profiling and debugging a change.
- **Frame graph**: every render pass declares the render targets it reads and writes, so the agent
  can add or change a pass without breaking the others.

## Why Ponlai

Ponlai aims to let anyone working with an AI coding agent create game visuals on par with AAA games
and film. The render pipeline gives the agent a physically based foundation, the skills teach it the
craft of making game visuals, from art to engineering, and the tools let it see, compare and measure
its results, so it can check its own work.

## Status

Ponlai is tuned and tested on the high quality preset at native 4K, in clear and fair weather at
every time of day, from day through sunset to night. The other presets (`medium`, `low`) and
weathers (`cloudy`, `overcast`, `rain`, `storm`, `fog`) still load, but they have not been tuned
recently and may look worse or run slower. The page at `/` is an early game prototype on the island; `?review` shows the island alone.

## Quick start

You need Node.js 26 and a browser with WebGPU support, such as a recent Chrome or Edge.

```bash
git clone https://github.com/HuberyLL/ponlai.git
cd ponlai
npm ci
npm run dev
```

Then open <http://127.0.0.1:5190/>. The first time the dev server starts, it downloads the assets
(textures, sky data, characters) into `public/`, which git ignores.

Pages to try:

| Address | What you see |
| --- | --- |
| <http://127.0.0.1:5190/> | The game: the title screen, then play |
| <http://127.0.0.1:5190/?review&weather=fair&preset=sunset> | The art-review scene: the island at sunset in fair weather |
| <http://127.0.0.1:5190/?review&paused&t=12> | The art-review scene paused at 12 seconds, as the tools capture it |
| <http://127.0.0.1:5190/scenes.html?scene=ball> | A test scene without the island (`ball`, `empty`, `sea` or `plants`) |

See [URL options](docs/reference/url-options.md) for every option.

## Use Ponlai in your own project

To start a new project, copy [the blank project](templates/blank/README.md): a minimal scene with
the sky, sea, lighting and post-processing around a single rock for you to replace, with the tools
set up and the assets included. From your clone of this repository:

```bash
node tools/repo/assets.mjs pull
cp -RL templates/blank ~/my-project
cd ~/my-project
npm install
npm run dev
```

`cp -RL` follows the template's symbolic links, so the copy includes the render pipeline, the
tools and the assets, and runs on its own. Its README explains each file, how to choose a look and
how to set up the tools.

To add the tools to an existing project, see [the tools' README](tools/kit/README.md). The agent
skills work in any project ([see below](#agent-skills)).

To contribute to Ponlai itself, [Contributing](.github/CONTRIBUTING.md) lists the extra programs
the checks and tools need.

### Agent skills

Each skill is a general workflow that works in any project; your project's specifics go in a
separate binding file next to it (this repository's are in `docs/bindings/`). Two of them are about
the look:

- [Building cinematic stylised realism](skills/building-cinematic-stylised-realism/SKILL.md): get a
  stylised look without breaking physically based rendering. Materials stay realistic; the styling
  is done through the content, a few global lighting settings per weather and time of day, and
  post-processing.
- [Fitting a look to reference images](skills/fitting-a-look-to-reference-images/SKILL.md): tune
  exposure, lighting, fog and colour grading until your renders match your own reference images.

The others cover verifying changes, measuring performance, debugging visual artifacts and frames
that differ between runs, and writing shaders, tools and docs (see Skills in [the docs
index](docs/README.md)).

To install them in Claude Code:

```bash
claude plugin marketplace add HuberyLL/ponlai --sparse .claude-plugin plugins skills
claude plugin install ponlai@ponlai
```

Update them with `claude plugin marketplace update ponlai`. For other agents, copy a skill's folder
into the agent's skills directory. Either way, write your own binding file with the same sections
as this repository's.

## Structure

The code is organised in layers, from the bottom up: the render pipeline (`packages/render/`), the
island (`packages/island/`), the game (`packages/game/`) and the app (`app/`). Each layer imports
only from the layers below it. [Architecture](ARCHITECTURE.md) describes the layers, how data flows
through them and the rules that span them, and [the docs index](docs/README.md) lists every page.

## Contribute

Ask questions and share ideas in [Discussions](https://github.com/HuberyLL/ponlai/discussions);
report bugs and request features in the issues. [Contributing](.github/CONTRIBUTING.md) explains how
to set up and submit a change, and everyone taking part follows the [Code of
Conduct](.github/CODE_OF_CONDUCT.md). To report a security issue, see [Security](.github/SECURITY.md).

## Licence

Ponlai is released under the [MIT License](LICENSE). [Credits](CREDITS.md) lists the third-party
code and assets and their licences.
