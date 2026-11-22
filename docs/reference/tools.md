# Tools

This page indexes the tools under `tools/` by the question each one answers. Each tool's manual is
its header comment, beside its code. To read it, ask the tool:

```bash
node tools/kit/probe.mjs --help            # the purpose, the usage and the options
node tools/kit/probe.mjs --help --full     # the whole manual
uv run tools/kit/img.py --help             # a Python tool, the same way
```

`--help` answers at once: it takes no GPU lock, opens no browser and starts no server, so it is safe
to run on every tool, including the GPU tools. It needs the dependencies installed (`npm ci`),
because a tool's imports resolve before its help prints, and a missing package stops it. A manual
says what question the tool answers, how to call it, what it prints and writes, whether it takes the
GPU lock or opens a browser, its rough cost and what each exit code means.
`tools/repo/verify-tool-manuals.mjs` checks every entry tool against these rules, and checks that
this page names it. To add a tool, follow the skill
[writing-tools-and-checks](../../skills/writing-tools-and-checks/SKILL.md) and its
[binding](../bindings/writing-tools-and-checks.md).

Concepts that several tools share have reference pages of their own:

- [GPU lock](gpu-lock.md): the lock every tool that renders takes, long jobs and waiting, process
  priority and headed runs.
- [Test mode](test-mode.md): how a page is loaded so that its frames are bit-identical, and
  `settled`.
- [Debug handles and keys](debug-handles-and-keys.md): the debug handles the tools drive, the
  keyboard shortcuts and the island camera's controls.
- [URL options](url-options.md): the app's query options.
- [Frame profiler](profile-frame.md): the long part of the profiler's manual.
- The parity method (when a comparison is byte-exact, how a tolerance is set, how the reference
  library is used): `tools/kit/parity/README.md`.

The npm scripts are in `AGENTS.md`, Stack and commands.

Contents:

- [Kit: generic tools (`tools/kit/`)](#kit-generic-tools-toolskit)
- [Render: the render pipeline's tools
  (`tools/render/`)](#render-the-render-pipelines-tools-toolsrender)
- [Island: the island's tools (`tools/island/`)](#island-the-islands-tools-toolsisland)
- [Game: the game's tools (`tools/game/`)](#game-the-games-tools-toolsgame)
- [Repo: the repository's checks (`tools/repo/`,
  `tools/`)](#repo-the-repositorys-checks-toolsrepo-tools)
- [Parked weathers and quality tiers](#parked-weathers-and-quality-tiers)

## Kit: generic tools (`tools/kit/`)

| Question | Tool |
| --- | --- |
| Serve this worktree's app, or another commit's, without a port clash | `tools/kit/serve.mjs` |
| Capture one screenshot of the app, with its diagnostics | `tools/kit/capture.mjs` |
| Read a value from the running page (a diagnostic, a uniform, a timing, the pipelines an action builds) | `tools/kit/probe.mjs` |
| Diff, crop, lay out, average or measure captures, or check two captures for flicker; how much structure a cloud deck shows (`stats --deck`) | `tools/kit/img.py` |
| Measure two overview captures region by region | `tools/kit/compare-captures.py` |
| Capture a set of paused views and check it against a commit's references | `tools/kit/parity/capture-set.mjs` |
| Compare a capture set with a reference set, exactly or within a tolerance | `tools/kit/diff-set.py` |
| Keep a commit's reference captures once, for every process that checks against them | `tools/kit/reference.mjs` |
| Capture a clip frame by frame, to judge motion | `tools/kit/parity/capture-clip.mjs` |
| Render footage of a camera move as whole frames (`--clip shot --full all`) | `tools/kit/parity/capture-clip.mjs` |
| Measure a clip's image-quality and temporal metrics against MSAA and a ground truth | `tools/kit/clip-metrics.py` |
| Capture and measure a commit's MSAA baseline and ground truth for the anti-aliasing gates | `tools/kit/parity/baseline.mjs` |
| Whether a commit can take over an earlier commit's baseline without a recapture | `tools/kit/parity/carry.mjs` |
| The anti-aliasing gates' verdicts of one baseline label, per gate | `tools/kit/gates.py` |
| Several labels' metrics side by side, with ratios to a base column | `tools/kit/table.py` |
| Run a command under the GPU lock; who holds the lock, the queue, a start estimate, the scheduling table, the lock's log | `tools/kit/gpu-lock.mjs` |
| Run this copy of the lock directly (testing a change to the lock) | `tools/kit/gpu-lock-impl.mjs` |
| Run a long command as a job; wait on jobs or a condition; stop jobs | `tools/kit/job.mjs` |
| Run a command with the application scheduling policy on macOS | `tools/kit/qos.mjs` |
| Whether a headed browser run may take the screen now | `tools/kit/display-gate.mjs` |
| What the tools leave on disk, and removing it | `tools/kit/storage.mjs` |

## Render: the render pipeline's tools (`tools/render/`)

| Question | Tool |
| --- | --- |
| Whether a render pipeline change altered what the small test scenes show (a plain surface, the sky through a day, a plant kind, the open sea), before the island loads | `tools/render/scenes.mjs` |
| The frame time of named scenes, per pass; A/B comparisons; the 60 fps acceptance | `tools/render/profile-frame.mjs` |
| Time two builds of a paused page against each other in one browser page | `tools/render/benchmark-lighting.mjs` |
| What WGSL a TSL kernel, pass or material compiles to, its bindings, and whether it exceeds WebGPU's default limits, without a GPU | `tools/render/wgsl-build.mjs` |
| Which pipelines a loaded page still creates in each step a player may take | `tools/render/verify-first-use.mjs` |
| The frame graph's compiler and runtime, on the CPU | `tools/render/verify-framegraph.mjs` |
| Whether three.js draws the frame graph's passes into their MRT layouts as the graph expects | `tools/render/verify-frame-graph-gpu.mjs` |
| Whether your own definition registers at each of the render pipeline's extension points | `tools/render/verify-extensions.mjs` |
| Whether each system reads its own look tables and changes no other system's | `tools/render/verify-look-params.mjs` |
| The day cycle's clock, sun, moon, stars and exposure, on the CPU | `tools/render/verify-day-cycle.mjs` |
| The graphics menu's options against the quality tiers, the stored settings and their precedence, on the CPU | `tools/render/verify-graphics-options.mjs` |
| The weather's state, transitions, wind and auto chain, on the CPU | `tools/render/verify-weather-state.mjs` |
| The wind's state and clocks and the plants' and sea's readings of it, on the CPU | `tools/render/verify-wind.mjs` |
| The local lights' clusters against a replica of the kernel, on the CPU | `tools/render/verify-local-lights.mjs` |
| The sea's unresolved slopes: the table of what the cascades' reads lose, and the water's means over that distribution, on the CPU | `tools/render/verify-slope-variance.mjs` |
| Whether the weathers drive the sky, the lighting, the atmosphere and the scene coherently on a page | `tools/render/verify-weather.mjs` |
| The rain's wet surfaces, rings and streaks (a parked weather's check) | `tools/render/verify-weather-effects.mjs` |
| Whether the rendered sun disk gives the sun's direct light | `tools/render/verify-radiometry.mjs` |
| How light crosses the water-to-air interface | `tools/render/verify-optical-interface.mjs` |
| The sunlight refracted into the water and its shadows | `tools/render/verify-refracted-sun.mjs` |
| Whether the sun's shadow keeps one penumbra width at a low sun | `tools/render/verify-solar-shadows.mjs` |
| Whether replacing a storage buffer with a larger one builds no new pipeline | `tools/render/verify-storage-realloc.mjs` |
| Bake the rainbow's colours by angle | `tools/render/bake-rainbow-table.mjs` |

To read how much light reaches a surface, its colour and how much of it comes from the sun, apart
from the albedos and the display chain, use `flags=lightOnly` (or `ambientOnly`) and
`__PONLAI__.radiance` through `tools/kit/probe.mjs` ([URL options](url-options.md), The lighting
layer and Radiance). Do not read it from a PNG's pixels, which have been through exposure, the tone
curve, the colour grade and bloom.

To find why a frame was late or a hitch happened, use the existing profilers, not new metrics. A
Chrome trace (the DevTools Performance panel, or a trace file opened in Perfetto) shows what the
main thread, the GPU process and the compositor did in each frame. Xcode Instruments' Metal System
Trace, Game Performance and Animation Hitches templates show when frames reached the display and
what the GPU ran (`xcrun xctrace record --template 'Metal System Trace' --attach <Chrome GPU process
pid> --time-limit 10s --output <file>.trace`). Extend our tools only for what these profilers do not
give: automation, A/B statistics and our own pass names.

## Island: the island's tools (`tools/island/`)

| Question | Tool |
| --- | --- |
| What colour a surface shows on screen, by surface kind and by lighting, before and after a change | `tools/island/region-colours.mjs` |
| How the island's lighting, colour and exposure change through the day under each kept weather, and whether anything jumps at one hour | `tools/island/day-sweep.mjs` |
| The day sweep's curves as plots | `tools/island/day-sweep-plot.py` |
| Whether anything brightens as the sun goes down or comes up, and which of the dusk's shares (the weights of the night lighting layers, `DayCycle.ts`) causes it | `tools/island/dusk-grid.mjs` |
| Where the slope of each night share may start and end, from a dusk grid | `tools/island/dusk-fit.mjs` |
| How bright the meadow's sunlit blades are against bare ground, how many are lit and what colour the lawn shows; the land's ratio of key light to ambient light | `tools/island/meadow-light.mjs` |
| A base and a candidate page of the growing island side by side | `tools/island/capture-growth.mjs` |
| The parity views, their groups and their crop anchors | `tools/island/parity/views.mjs` |
| The named clips | `tools/island/parity/clips.mjs` |
| Whether a grown page draws what a fresh load of its land draws | `tools/island/verify-growth-swap.mjs` |
| Whether a scene jump draws what a fresh load draws | `tools/island/verify-scene-jump.mjs` |
| The world generator's chunks: determinism, the dirty set, seams, locality | `tools/island/verify-world-chunks.mjs` |
| The chunks' derived products against their builders | `tools/island/verify-chunk-derived.mjs` |
| Whether the chunked world keeps the statistics the island's look was tuned on | `tools/island/verify-world-stats.mjs` |
| The island's growth over many seeds: the coast's shape, single steps, the lattice's margin | `tools/island/verify-growth-shape.mjs` |
| Whether zooms, pinches and drags keep the ground under the cursor | `tools/island/verify-zoom-anchor.mjs` |
| Real-browser regression checks of the built app on a production preview | `tools/island/verify-scene.mjs` |
| Build the ground's, the moon's and the Milky Way's textures and the star list | `tools/island/build-ground-textures.py`, `tools/island/build-moon-textures.py`, `tools/island/build-milky-way.py`, `tools/island/build-star-catalog.mjs` |

## Game: the game's tools (`tools/game/`)

| Question | Tool |
| --- | --- |
| What the islanders do over days of play, how the needs and the stock develop, how an agent plays | `tools/game/play-game.mjs` |
| The game's simulation, save, growth, session and rules' structure | `tools/game/verify-game.mjs` |
| No player-facing word in the code, and each language's drift | `tools/game/verify-i18n.mjs` |
| The interface's ink effect on strokes drawn the way the app draws them | `tools/game/verify-ink.mjs` |

## Repo: the repository's checks (`tools/repo/`, `tools/`)

| Question | Tool |
| --- | --- |
| Run every check a commit passes (`npm run check`) | `tools/check.mjs` |
| Which file does something: every source file under `packages/`, `app/` and `tools/` with its header's first line | `tools/repo/code-map.mjs` |
| Which assets a commit runs with, whether `public/` matches them, and how to publish a change | `tools/repo/assets.mjs` |
| No asset and no binary file in git | `tools/verify-no-binaries.mjs` |
| Every file's copyright and licence (REUSE), and the SPDX tags in each third-party notice | `tools/repo/verify-licences.mjs` |
| The direction of imports between the layers | `tools/repo/verify-layers.mjs` |
| The packages' entry points load without doing work or reading browser globals | `tools/repo/verify-entry-points.mjs` |
| The app's settings against their docs and the tools' addresses | `tools/repo/verify-settings.mjs` |
| The three.js internals the code depends on, against the installed three | `tools/repo/verify-three-internals.mjs` |
| The code lint's own rules (the rules themselves: `tools/repo/lint/plugin.mjs`) | `tools/repo/verify-lint.mjs` |
| No code file grows past its line limit | `tools/repo/verify-file-size.mjs` |
| The generic tools stay apart from the project | `tools/repo/verify-kit.mjs` |
| The skills: their links under `.claude/` (nothing else tracked there), their frontmatter, size, reference files and bindings, and the root `AGENTS.md`'s index of them | `tools/repo/verify-skill-links.mjs` |
| Each translated page (`*.zh-CN.md`) against its English page: headings, code, links and tables | `tools/repo/verify-translations.mjs` |
| Every path to a doc, skill or tool written in tracked text exists (`npm run lint:docs`) | `tools/repo/verify-doc-paths.mjs` |
| The root `AGENTS.md` within its budget, each folder's `AGENTS.md` imported by a `CLAUDE.md` beside it, each long docs page opening with its contents (`npm run lint:docs`) | `tools/repo/verify-doc-shape.mjs` |
| Every source file under `packages/` and `app/` opens its header with one sentence of purpose | `tools/repo/verify-headers.mjs` |
| Every entry tool answers `--help` from its header manual | `tools/repo/verify-tool-manuals.mjs` |

## Parked weathers and quality tiers

Every default check covers the kept weathers (clear, fair) and the high tier at 4K output
(`AGENTS.md`, Rules for every change). The parked weathers and tiers keep compiling and loading by
name, and a tool uses them only when asked to:

- Parked weathers (cloudy, overcast, rain, storm and fog; `packages/render/sky/Weather.ts`
  `PARKED_WEATHER`) are out of every default set: views.mjs's `parity`, `taa` and `all` groups,
  clips.mjs's `all`, baseline.mjs's plan, verify-scene-jump's views, profile-frame's scene matrix
  and `--accept`, and verify-first-use's steps. The `special` group, or a name, selects a parked
  view, clip or scene. `tools/render/verify-weather-effects.mjs` and the rain parts of
  `tools/render/verify-weather.mjs` are parked with them.
- Parked quality tiers (medium and low; `packages/render/Quality.ts` `PARKED_QUALITY`) are out of
  the default choice and checks. A page without `quality` loads high, and the GUI lists only high.
  Every tool's default is high; `?quality=medium|low`, `--quality medium` or
  `--tiers high,medium,low` select the others.
