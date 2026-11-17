# Blank project

**English** | [简体中文](README.zh-CN.md)

The starting point for a project of your own on Ponlai's render pipeline: the render pipeline's sky,
sea, light and post-processing, one rock in the open sea to replace with your own content, and the
tools that capture, compare and measure its frames. Copy it to start a project, as the repository's
[README](https://github.com/HuberyLL/ponlai#use-ponlai-in-your-own-project) shows.

## Run it

After `npm install`, `npm run dev` serves the page; open the address Vite prints. The render
pipeline's URL options work on the page, for example `?paused&t=12` or `?weather=fair&hour=7`.

To use the tools as well, install Playwright's browser and [uv](https://docs.astral.sh/uv/), which
runs the Python tools, and keep the project in git with at least one commit (the tools read it):

```bash
npx playwright install chromium
curl -LsSf https://astral.sh/uv/install.sh | sh
git init && git add -A && git commit -m "Start from Ponlai's blank project"
```

For the agent skills, install Ponlai's Claude Code plugin (the README's
[Agent skills](https://github.com/HuberyLL/ponlai#agent-skills)).

## What is in it

| File | What it does |
| --- | --- |
| `package.json` | three.js at exactly 0.186.1 (the render pipeline reaches into three's internals), Vite, TypeScript and Playwright |
| `vite.config.ts` | Vite builds the render pipeline's workers as ES modules |
| `tsconfig.json` | Allows the render pipeline's imports, which name `.ts` files |
| `index.html` | The page: the canvas's host and a loading screen |
| `src/main.ts` | Installs the page's settings, then loads the scene: the render pipeline's modules read the settings as they load |
| `src/scene.ts` | The scene: a rock, its ground and its water, given to `startScene` |
| `src/render/` | The render pipeline |
| `src/looks/ponlai/` | Ponlai's look: the light, air and image values the island is drawn with |
| `public/` | The clouds' shape noise, the star catalogue, the Milky Way and the moon ([Credits](https://github.com/HuberyLL/ponlai/blob/main/CREDITS.md), Assets) |
| `tools/kit/` | The tools ([their README](https://github.com/HuberyLL/ponlai/blob/main/tools/kit/README.md)) |
| `tools/project.mjs` | The tools' configuration for this project |

`startScene( host, options, content )` runs the render pipeline's stages in their fixed order and
calls your content in the slots between them: `passes`, `ground`, `ambient` and `water` give the
stages their inputs, and the optional `after...` slots add your objects. The neutral inputs
(`neutralFields`, `neutralBounceGround`, `neutralSeaLattice`, `neutralLattice`) describe a level
floor or level ground for a scene without a world of its own. The camera (`render.camera`) has a
vertical field of view of 27 degrees; place it in `afterSky`. The slots and options are documented
in `packages/render/assemble/StartScene.ts`, and the test scenes in `app/scenes/` are fuller
examples. To load the assets from another address, pass `assetBase` to `startScene`.

## Choose a look

The scene starts from one of two looks, chosen by `LOOK` at the top of `src/scene.ts`:

- `PONLAI_LOOK` (recommended, the default): Ponlai's own values for the exposure, the haze, the
  ambient light, bloom and the grade, by weather and hour of the day, as the island is drawn.
- `NEUTRAL_LOOK`: every gain 1, no haze, no bloom and no grade. A plain start for a look of your
  own, made with the skills that build a look and fit it to your reference images.

The sky, the sun and the sea are physically based in both; a look sets only the values around
them.

## Capture and compare

Start the dev server through the tools: `serve.mjs` starts Vite in the background on the first free
port from 6400 and prints its address and the command that stops it. Then take two captures of the
paused scene and compare them:

```bash
node tools/kit/serve.mjs dev
node tools/kit/gpu-lock.mjs run --shared -- node tools/kit/capture.mjs first --url http://127.0.0.1:6400/
node tools/kit/gpu-lock.mjs run --shared -- node tools/kit/capture.mjs second --url http://127.0.0.1:6400/
uv run tools/kit/img.py diff artifacts/captures/first.png artifacts/captures/second.png
```

The two captures match byte for byte. Each tool's manual is its `--help`.

## Known limits

- One page holds one render pipeline at a time. To show another scene, call `dispose()` on the
  running scene first; the next `startScene` then draws as a fresh load does.
- Ponlai is tuned and checked in the quality tier and weathers the README's
  [Status](https://github.com/HuberyLL/ponlai#status) names.
- The render pipeline and the tools are not npm packages: you copy them, and update them by copying
  them again.
