# Ponlai

Ponlai is a small island in an open sea, rendered in the browser with three.js and WebGPU: a visual
sample for a game, with the game growing behind the `?game` option. The island is lit as the sun and
the sky light it, on a physically based renderer, with deep clear water, chunky stone and a meadow
that moves in the wind. The look is inspired by the eastern aesthetic of Ghost of Tsushima.

<!-- SCREENSHOT: replace the next line with the image's GitHub attachment link. -->
*Screenshot to come.*

The renderer (`packages/render/`) is built without the island, so you can copy it into a project of
your own, together with the capture and measuring tools (`tools/kit/`) and the agent skills
(`skills/`).

## Requirements

- A browser with WebGPU, such as a current Chrome or Edge. Without WebGPU, the page shows a message.
- Node.js 26 and npm.
- For the tools: [uv](https://docs.astral.sh/uv/) for the Python tools, and Playwright's Chromium
  for captures (`npx playwright install chromium`).

## Run this repository

```bash
npm ci
npm run dev
```

The dev server runs at <http://127.0.0.1:5190/>. On its first start it downloads the assets (the
textures, the sky's catalogues, the characters) from the GitHub release that `assets.lock.json`
names, into the git-ignored `public/` folder.

Some pages to try:

- <http://127.0.0.1:5190/?weather=fair&preset=sunset>: the island at sunset on a fair day.
- <http://127.0.0.1:5190/?paused&t=12>: the scene paused at 12 seconds, the way the tools shoot it.
- <http://127.0.0.1:5190/?game>: the island as a game.
- <http://127.0.0.1:5190/scenes.html?scene=ball>: one of the renderer's test scenes, without the
  island (`ball`, `empty`, `sea` or `plants`).

Every option of the address is listed in [URL options](docs/reference/url-options.md).

## Use the renderer in your own project

The renderer is TypeScript that a bundler compiles with your code. It needs:

- three.js 0.186.1, at exactly this version: the renderer reaches into three's internals in
  `packages/render/three/`.
- Vite 8. The renderer reads `import.meta.env` and starts workers with
  `new Worker( new URL( ..., import.meta.url ) )`. Set `worker: { format: 'es' }` in your Vite
  configuration, `vite.config.ts`:

  ```ts
  import { defineConfig } from 'vite';

  export default defineConfig( { worker: { format: 'es' } } );
  ```

- An ES module project: `"type": "module"` in your `package.json`, as a Vite template sets it.
- To type-check with TypeScript 5, a `tsconfig.json` with `allowImportingTsExtensions` (the
  renderer's imports name `.ts` files) and `"types": [ "vite/client" ]`. Use this one, in place of
  any a template made (a template's stricter options reject the renderer's code):

  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "lib": [ "ES2022", "DOM", "DOM.Iterable" ],
      "types": [ "vite/client" ],
      "strict": true,
      "isolatedModules": true,
      "allowImportingTsExtensions": true,
      "skipLibCheck": true,
      "noEmit": true
    },
    "include": [ "src", "vite.config.ts" ]
  }
  ```

### Copy the renderer and its assets

1. Copy `packages/render/` into your source folder, for example as `src/render/`.
2. Install the packages:

   ```bash
   npm install -E three@0.186.1
   npm install -D vite@^8 typescript@^5.9 @types/three@0.186.0
   ```

3. Copy the renderer's assets into your `public/` folder, at the same paths. After `npm run dev`
   has run once in this repository, they are in its `public/` folder:

   | File | What it is |
   | --- | --- |
   | `clouds/baseShape64.bin` | The clouds' shape noise |
   | `sky/stars.bin` | The star catalogue |
   | `sky/milkyway.png` | The Milky Way |
   | `sky/moon/moon_color.jpg`, `sky/moon/moon_height.png` | The moon's colour and heights |

   Their sources and licences are in [Credits](CREDITS.md), Assets. The renderer loads them from
   your site's base address; to load them from elsewhere, pass `assetBase` to `startScene`.

### A minimal scene

A page installs its settings before any of the renderer loads, since the renderer's modules read
them as they load. So the page's entry installs them, then loads the scene with a dynamic import.

`index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Rock by the sea</title>
  <link rel="icon" href="data:," />
  <style>
    html, body { margin: 0; height: 100%; overflow: hidden; background: #000; }
    #app { position: fixed; inset: 0; }
    #loading { position: fixed; inset: 0; display: grid; place-items: center; color: #ccc; background: #000; }
    #loading.done { opacity: 0; pointer-events: none; }
  </style>
</head>
<body>
  <div id="app"></div>
  <div id="loading">Loading…</div>
  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

`src/main.ts`, the entry:

```ts
import { installSettings, parseSettings, settingProblems, RENDER_SETTINGS } from './render/setup.ts';

const query = parseSettings( location.search );
for ( const problem of settingProblems( query, RENDER_SETTINGS ) ) console.warn( `[settings] ${ problem }` );
installSettings( query );

const { startRock } = await import( './scene.ts' );
await startRock();
```

`src/scene.ts`, a rock in the open sea:

```ts
import * as THREE from 'three/webgpu';
import { startScene, neutralFields, neutralBounceGround, neutralSeaLattice, OPEN_SEA_SHORE } from './render/index.ts';
import { browserHost } from './render/browser.ts';
import { NEUTRAL_LOOK } from './render/setup.ts';

export async function startRock() {

  const host = browserHost( { canvasHost: document.getElementById( 'app' )!, loading: document.getElementById( 'loading' ) } );
  const rock = new THREE.Mesh( new THREE.DodecahedronGeometry( 2 ), new THREE.MeshStandardNodeMaterial( { color: 0x6b665e, roughness: 0.9 } ) );
  const world = new THREE.Group();
  world.add( rock );
  let fields!: ReturnType<typeof neutralFields>;

  return startScene( host, { look: NEUTRAL_LOOK, defaults: { hour: 15, dayLength: 2880 } }, {
    afterSky( { render } ) {

      render.camera.position.set( 8, 3, 10 );
      render.camera.lookAt( 0, 0.5, 0 );

    },
    passes: ( { shared } ) => ( { rainCeiling: shared.waterLevel.value + 8, extraPasses: [] } ),
    ground( { shared } ) {

      const floor = shared.waterLevel.value - 3;
      fields = neutralFields( { half: 64, shore: OPEN_SEA_SHORE, floor, xform: shared.shoreXform.value } );
      return { fields: fields.fields, shoreData: fields.shoreData, bounceGround: neutralBounceGround( { ground: floor, albedo: [ 0.3, 0.3, 0.3 ] } ) };

    },
    afterBounce( { render, shared } ) {

      rock.position.y = shared.waterLevel.value - 1;
      render.scene.add( world );
      world.updateMatrixWorld( true );

    },
    ambient: ( { shared } ) => ( { ambientData: neutralSeaLattice( { sea: shared.waterLevel.value } ), world: { group: world } } ),
    afterAmbient( { render } ) {

      render.sunShadow.setCasters( new THREE.Box3().setFromObject( rock ) );

    },
    water: () => ( {
      fields: fields.fields,
      landBox: { x0: - 2, z0: - 2, x1: 2, z1: 2 },
      seaShape: { openSea: { from: 1e5, to: 2e5 }, reflectorTop: 3 },
      heldOpaque: [],
    } ),
    afterWater( { sizing } ) {

      sizing.resize();

    },
  } );

}
```

`startScene( host, options, content )` runs the renderer's stages in their fixed order and calls
your content in the slots between them: `passes`, `ground`, `ambient` and `water` give the stages
their inputs, and the optional `after...` slots add your objects. The neutral inputs
(`neutralFields`, `neutralBounceGround`, `neutralSeaLattice`, `neutralLattice`) describe a level
floor or level ground for a scene without a world of its own. The renderer's camera
(`render.camera`) has a vertical field of view of 27 degrees; place it in `afterSky`. The slots and
options are documented in `packages/render/assemble/StartScene.ts`. The test scenes in
`app/scenes/` are fuller examples.

Run `npx vite`, then open the page. The renderer's own URL options work on it, for example
`?paused&t=12` or `?weather=fair&hour=7`.

### Known limits

- One page holds one renderer at a time. To show another scene, call `dispose()` on the running
  scene first; the next `startScene` then draws as a fresh load does.
- Only the `high` quality tier and the `clear` and `fair` weathers are kept up to date, judged at 4K
  output (1920x1080 CSS pixels at a device pixel ratio of 2). The other tiers and weathers still
  load by name.
- The renderer is not an npm package: you copy it and update it by copying again.

## Use the tools and skills

The kit (`tools/kit/`) captures paused frames of a page, compares them byte for byte, reads values
from the page and measures frame time. A page assembled by `startScene` gives the kit what it reads.

1. Copy `tools/kit/` to `tools/kit/` in your project, and this repository's `tools/project.mjs` to
   `tools/project.mjs`. The kit reads nothing else of the project. It writes its logs and captures
   under `artifacts/`: add that folder to your `.gitignore`.
2. In your `tools/project.mjs`, set `name` to your project's name, and set `tables`,
   `sceneOptions`, `pipelines` and `serve.prepare` to `null`: they point to this repository's
   files. Set `reference.buildInputs` to the files your build reads. Keep `machine.gpuLock`
   unchanged if another project renders on the same machine, so that the two share one lock. The
   steps below read nothing else there: `url` is the page a tool opens when given no `--url`, and
   `reference.toolFiles` and `reference.watch` serve the stored references of the capture sets and
   clips, so point them at your own files when you use those tools.
3. Install Playwright at the version the kit is checked with, and its browser:

   ```bash
   npm install -D playwright@1.63.0
   npx playwright install chromium
   ```

4. Keep the project in a git repository with at least one commit: the kit's server and its stored
   references read the commit.
5. Start your dev server through the kit. `serve.mjs` starts Vite as a background job on the first
   free port from 6400 on, prints the server's address and the command that stops it, and exits;
   the server runs until you stop it. Take a capture at the address it printed, here
   `http://127.0.0.1:6400/`:

   ```bash
   node tools/kit/serve.mjs dev
   ```

   ```bash
   node tools/kit/gpu-lock.mjs run --shared -- node tools/kit/capture.mjs rock --url http://127.0.0.1:6400/
   ```

   The capture is `artifacts/captures/rock.png`, with the page's diagnostics in `rock.json`. It is
   shot on a paused page (the configuration's default query, `paused&t=12&dpr=1`) once its frames
   stop changing. Take a second capture named `rock2` and compare the two:

   ```bash
   uv run tools/kit/img.py diff artifacts/captures/rock.png artifacts/captures/rock2.png
   ```

   Then stop the server with the command `serve.mjs` printed (`node tools/kit/job.mjs stop` and the
   server's log).

Each tool's manual is its header: `node tools/kit/<tool>.mjs --help`. The tools are indexed by
question in [Tools](docs/reference/tools.md). The kit was written on macOS. Elsewhere, the scheduling
policy (`qos.mjs`) does nothing, the GPU lock does not see other programs' GPU use, and
`display-gate.mjs` posts no notices. `CHROME_PATH` names another Chromium build to capture with. The
kit's own environment variables start with the configuration's `machine.envPrefix` (`PONLAI_` in
this repository, as in `PONLAI_GPU_SLOTS`); set a prefix of your own there.

The skills in `skills/` are written for any project: each is a method, and the project's facts are in
a binding page in `docs/bindings/`. To use one, copy its folder into your agent's skills folder (for
Claude Code, `.claude/skills/`), and write a binding page of your own with the same sections as
this repository's.

## Structure

The code is in layers, lowest first: the renderer (`packages/render/`), the island
(`packages/island/`), the game (`packages/game/`) and the page (`app/`). Each layer imports only from
the layers below it. [Architecture](ARCHITECTURE.md) describes the layers, the flows and the rules
across them, and [the docs' index](docs/README.md) lists every page.

## Licence

Ponlai is released under the [MIT License](LICENSE). [Credits](CREDITS.md) lists the third-party
code and assets, with their licences.
