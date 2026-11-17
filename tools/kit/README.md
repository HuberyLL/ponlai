# The kit

The tools in this folder capture paused frames of a page, compare them byte for byte, read values
from the page and measure frame time. They work in any project whose page is assembled by the
render pipeline's `startScene`. A project started from [the example](../../examples/rock/README.md)
has them already, configured; its Capture and compare shows them at work.

## Add the kit to a project of your own

1. Copy `tools/kit/` to `tools/kit/` in your project, and the example's `tools/project.mjs` to
   `tools/project.mjs`: the kit reads nothing else of the project. Add `artifacts/`, where it
   writes, to your `.gitignore`.
2. In your `tools/project.mjs`, set `name`, `url` (your dev server) and `reference.buildInputs` (the
   files your build reads).
3. Install Playwright at the version the kit is checked with, its browser, and
   [uv](https://docs.astral.sh/uv/), which runs the kit's Python tools:

   ```bash
   npm install -D playwright@1.63.0
   npx playwright install chromium
   curl -LsSf https://astral.sh/uv/install.sh | sh
   ```

4. Keep the project in git with at least one commit: the kit's server and its stored references
   read it.

## Manuals and other systems

Each tool's manual is its header: `node tools/kit/<tool>.mjs --help`. The tools are indexed by
question in [Tools](../../docs/reference/tools.md). The kit was written on macOS. Elsewhere, the
scheduling policy (`qos.mjs`) does nothing, the GPU lock does not see other programs' GPU use, and
`display-gate.mjs` posts no notices. `CHROME_PATH` names another Chromium build to capture with. The
kit's own environment variables start with the configuration's `machine.envPrefix` (`PONLAI_` in
this repository, as in `PONLAI_GPU_SLOTS`).
