# Binding: writing tools and checks

This project's facts for the skill
[`writing-tools-and-checks`](../../skills/writing-tools-and-checks/SKILL.md). Each section is named
after the step of the skill that reads it. A project of your own copies the section names and fills
in its own facts.

The rules every tool follows are in `AGENTS.md` (Tools; Stack and commands); this page gives the
facts a tool is built on.

Contents:

- [Index](#index)
- [Manual](#manual)
- [Build](#build)
- [Prove](#prove)
- [Checks](#checks)
- [Register](#register)

## Index

- `docs/reference/tools.md` indexes the tools by question, one table per group. Each tool's manual
  is its header: `node <tool> --help`, `--help --full` for the whole header, and
  `uv run <tool>.py --help` for a Python tool. Never start a GPU tool to see its options.
- `node tools/repo/code-map.mjs` lists every file with its header's first line, the tools included.
- Views by name: `tools/island/parity/views.mjs` holds the named views and their crops; it is the
  table `tools/kit/parity/capture-set.mjs` (`--views`) and `tools/kit/parity/capture-clip.mjs` read.
  `tools/kit/probe.mjs` takes URL queries only: `node tools/island/parity/views.mjs query <view>`
  prints a view's query. A view whose camera is set by an eval needs capture-set.
- A one-off script stays in the task's folder under the git-ignored `artifacts/`; a tool goes in
  `tools/`, in its group: `kit/` (generic, no part of this project named), `render/`, `island/`,
  `game/`, `repo/` (the repository's own checks).

## Manual

- The header comment is the manual, in the skill's order. A section heading is a capitalised phrase
  that ends in a colon at the start of a comment line. A section ends at a blank comment line. The
  sections are `Usage:` with the command written from the repository's root, `Options:` (or
  `Options: none.`), then output, GPU lock and browser, cost and `Exit codes:`.
- The header stays within 120 lines (`MAX_LINES` in `tools/repo/verify-tool-manuals.mjs`). A
  longer explanation goes to a page under `docs/reference/` that the header links
  (`tools/render/profile-frame.mjs` and `docs/reference/profile-frame.md`).
- An entry tool (a tool you run directly) imports `import '../kit/help.mjs';` first (the path from
  its folder). On `--help`, that module prints the first line, the Usage and the Options and exits
  before any other import runs; `--help --full` prints the whole header. The other imports still
  resolve first, so `--help` needs the dependencies installed (`npm ci`). A Python tool's manual is
  its module docstring, and right after it, before any other import or a re-exec, it calls the same
  helper:

  ```python
  sys.path.insert(0, str(Path(__file__).resolve().parent))  # the path to tools/kit/
  from help import answer_help  # noqa: E402

  answer_help(__file__)
  ```

- A file is an entry tool if its header has a `Usage:` section, it exports nothing, or it runs only
  when called (`resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url )`); a Python file,
  if its docstring has `Usage:` or no other tool imports it. Anything else is a module, whose header
  still opens with one sentence (`tools/repo/verify-headers.mjs`).
- `tools/repo/verify-tool-manuals.mjs`, part of `npm run check`, finds the entry tools this way.
  It runs each one's `--help` with the GPU lock, the browser and child processes made to throw,
  and checks that `docs/reference/tools.md` names the tool.

## Build

Shared modules, used instead of copies:

- `tools/kit/capture-browser.mjs` (the browser, warm profiles, readiness), `tools/kit/reference.mjs`
  (stored references), `tools/kit/parity/tables.mjs` (the views' and clips' tables; its header gives
  their contract), `tools/kit/pixels.py` (image metrics), `tools/kit/gpu-lock.mjs`,
  `tools/kit/job.mjs`, `tools/kit/qos.mjs`.
- CPU-heavy node tools import `qos.mjs` first. Python tools declare their dependencies inline (PEP
  723) and run with `uv run`.

Output and exit codes: files under `artifacts/` (images, JSON) with a short summary on stdout; exit
0 passed, 1 failed, 3 contended (the GPU was busy, nothing measured). A long tool prints progress
lines, so `node tools/kit/job.mjs wait` shows where it is.

The GPU lock (`docs/reference/gpu-lock.md`): a tool that renders takes it, shared for paused
captures and probes and exclusive for timing. Where it can, the tool holds the lock for one piece of
work at a time (`leaseGpuLock`), so that a long run gives way at its boundaries to a request ranked
before it. It never holds a slot while it does CPU work or waits for something else.

Readiness comes from the browser page:

- Use capture-browser's `waitForScene`, `waitForSettled` (the diagnostics' `settled`, with the loop
  running) and `waitForStable`, in that order. Take a reading once the frame is ready, not right
  after the load: a fresh load draws its first frames before the sun's shadow map is rendered, so
  every shadow receiver is lit.
- A step that sets a state (a clock, a camera, a uniform) and reads the frame that follows waits for
  frames the page has rendered, counted by `renderer.info.frame`. Use page-eval's `frames( n )` in
  an eval, `renderedFrames( page, n )` (`tools/kit/page-eval.mjs`, "Rendered frames") from a
  Playwright page of your own, `window.__waitFrames( n )` (`installWaitFrames`) inside that page's
  own evaluate, or `WAIT_FRAMES` spliced into page code written as a string. All of these are the
  same wait, which fails at once while the page's frame loop is stopped. Never wait for a count of
  animation frames: the frame pacer skips the refreshes between its frames, and a paused page in the
  test mode holds a due frame while two are still queued on the GPU (`docs/reference/test-mode.md`).
  A read after animation frames therefore got the previous frame whenever the page did not tick
  after the state was set. To wait for a still, converged image, wait for `settled`, never for a
  count of frames of either kind.

The app's interfaces. A tool reaches the app only through these three:

- The URL options, declared in each layer's settings table (`packages/render/Settings.ts`'s header)
  and listed in `docs/reference/url-options.md`. A tool sets the app's state through them
  (`--q`). A node tool that loads the modules installs them as the app does (`installSettings(
  parseSettings( query ) )`, `tools/render/wgsl-build.mjs` `--q`).
- The debug handles the app mounts on `window` on debug pages: `__PONLAI__` (the app's parts and
  its controls; `heldRegion()` gives the cells where a paused frame is compared within the held
  tolerance: `packages/render/debug/HeldRegion.ts`), `__PONLAI_WORLD__` (`ready` and `ms`, set as
  the world starts: `app/WorldBoot.ts`) and, with `?profile`, `__PONLAI_PROFILE__` (the frame
  profiler's readings). The test-scenes page mounts the same handles (`app/scenes/ScenePage.ts`).
- `__THREE_GAME_DIAGNOSTICS__.settled`, true once a paused frame is final
  (`packages/render/post/Settled.ts`; `docs/reference/debug-handles-and-keys.md`).

A tool that needs more from the app adds it to one of the three, never a global of its own.

The one configuration file is `tools/project.mjs`. A kit tool (`tools/kit/`) takes these from it and
never writes them in its code: the names of the app's globals (`page`), its output folders
(`output`), the names it shares on the machine (`machine`: the GPU lock, the jobs' registry, the
temp folders' prefix) and the project's `name`. Outside `tools/kit/`, it imports only this file. A
kit Python tool reads it through `tools/kit/project.py` (`tools/repo/verify-kit.mjs` checks both).
Environment variables keep their `PONLAI_` names. The members that a kit tool uses are names in its
code, and the app implements them: on the handle `renderer.info.frame`, `renderer.info.memory`,
`renderer.domElement`, `loop.start()`, `loop.stop()`, `loop.running`, `loop.step( ... )`,
`establishScene( query )`, `sceneJump`, `camera`, `clockTime()`, `pipeline.width`,
`pipeline.height`, `pipeline.settings.exposureOffset`, `pipelines.total`, `taa.epoch.bump()`,
`taa.epoch.value`, `taa.converged` and `taa.rest`; on the diagnostics `settled`, `frame`, `aa` and
`taa`.

White-box access: a tool may import any layer's modules and run scripts in the page
(`ARCHITECTURE.md`, rule 10). It does not use three.js internals directly. It calls the render
pipeline's functions in `packages/render/three/` instead. The few tools that still use three.js
internals are listed in `tools/repo/verify-three-internals.mjs` (`TOOLS_KNOWN`), a list that only
shrinks.

Some render-pipeline systems take the look's tables. A node tool that creates one passes it the set
of tables it needs, as the app's stages do. For the values the island renders with, that is the
island's set (`ISLAND_LOOK`, `packages/island/look/IslandLook.ts`), as in
`createExposure( ISLAND_LOOK )` or `createDayWindows( ISLAND_LOOK.day )`
(`tools/render/verify-day-cycle.mjs`).

Stored results: expensive results that depend only on the commit, the tool and the browser are
stored and reused through `tools/kit/reference.mjs`. Their key records everything that changes them
(the capture tools' sources are listed in `tools/project.mjs` `reference.toolFiles`). A change to
one of those files, even to a comment, changes every stored set's key, so the next comparison
captures its references again. Make such a change only when the capture needs it, and say so in
the commit.

## Prove

- Planted faults kept runnable: `tools/island/verify-growth-swap.mjs --fresh-grow M` loads the
  fresh page at another growth step, only to see the check fail. `tools/kit/parity/capture-clip.mjs
  --test-fault` draws a frame half a stop brighter, so the second capture of a rest (a one-frame
  clip) must reject it.
- A lint rule's fixture: `tools/repo/lint/fixtures/<rule>.ts`, linted as if it were a file where
  the rule applies. Its rule must report every line marked `// reported` and nothing else
  (`tools/repo/verify-lint.mjs`). Write the fixture from the file as it was before a real fix.
- A faster check keeps its guarantee: a scene-jump check compares jumps with fresh loads, not with
  other jumps.
- Compare a replacement capture or comparison tool with the old one on the same views. Calibrate a
  temporal tolerance as `tools/kit/tolerance.py`'s header describes.

## Checks

- The order of remedies, and where a rule and its check are named: `AGENTS.md`, Adding a rule. A
  check that `npm run check` runs is named in `AGENTS.md`, What the checks hold; one run by hand,
  in Checks run by hand (or a folder's `AGENTS.md`); the mistake a rule came from goes in the
  commit message that adds it. The rules' full text: `docs/reference/architecture-rules.md`.
- Lint rules: `tools/repo/lint/plugin.mjs` (its header lists them, how to add one and how an
  exception is written: a disable comment naming the rule and a reason; a comment that no longer
  suppresses anything is an error), scoped in `eslint.config.mjs`, each with a fixture.
- Every commit: `npm run check` (`tools/check.mjs`; its header lists the checks). A check joins
  that list if it needs no GPU and the whole list stays near a minute. A slower one goes under
  `--full` (the production build and the world's chunk checks).
- Checks that render are run by hand under the GPU lock, named beside the kind of change that needs
  them: `AGENTS.md`, Checks run by hand, a folder's `AGENTS.md`, and the bindings of
  `verifying-rendering-changes` (Kinds) and `writing-tsl-and-passes`.
- Lists of known exceptions only shrink, and an entry that is no longer needed fails the check:
  `KNOWN` and `STATE` in `tools/repo/verify-layers.mjs`, `TOOLS_KNOWN` in
  `tools/repo/verify-three-internals.mjs`.

## Register

- A new entry tool gets a line in `docs/reference/tools.md` under its group, by its question;
  `verify-tool-manuals` fails until it has one.
- A new check is named where its rule is (`AGENTS.md`, What the checks hold or Checks run by hand,
  or a folder's `AGENTS.md`); the mistake behind the rule goes in the commit message. A check that
  needs no GPU is added to `tools/check.mjs`'s list and its header.
