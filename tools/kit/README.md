# The kit

The tools in this folder capture paused frames of a page, compare them byte for byte, read values
from the page and measure frame time. They work in any project whose page is assembled by the
render pipeline's `startScene` (as in [the example](../../examples/rock/README.md)).

## Use the kit in your project

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
3. Install Playwright at the version the kit is checked with and its browser, and
   [uv](https://docs.astral.sh/uv/), which runs the kit's Python tools:

   ```bash
   npm install -D playwright@1.63.0
   npx playwright install chromium
   curl -LsSf https://astral.sh/uv/install.sh | sh
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

## Manuals and other systems

Each tool's manual is its header: `node tools/kit/<tool>.mjs --help`. The tools are indexed by
question in [Tools](../../docs/reference/tools.md). The kit was written on macOS. Elsewhere, the scheduling
policy (`qos.mjs`) does nothing, the GPU lock does not see other programs' GPU use, and
`display-gate.mjs` posts no notices. `CHROME_PATH` names another Chromium build to capture with. The
kit's own environment variables start with the configuration's `machine.envPrefix` (`PONLAI_` in
this repository, as in `PONLAI_GPU_SLOTS`); set a prefix of your own there.
