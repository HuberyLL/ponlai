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
  `tools/kit/probe.mjs` takes queries only: `node tools/island/parity/views.mjs query <view>` prints
  a view's query, and views whose camera is set by an eval need capture-set.
- A one-off script stays in the task's folder under the git-ignored `artifacts/`; a tool goes in
  `tools/`, in its group: `kit/` (generic, no part of this project named), `render/`, `island/`,
  `game/`, `repo/` (the repository's own checks).

## Manual

- The header comment is the manual, in the skill's order. A section heading is a capitalised
  phrase ending in a colon at the start of a comment line, and a section ends at a blank comment
  line: `Usage:` with the command written from the repository's root, `Options:` (or
  `Options: none.`), then output, GPU lock and browser, cost and `Exit codes:`.
- The header stays within 120 lines (`MAX_LINES` in `tools/repo/verify-tool-manuals.mjs`). A
  longer explanation goes to a page under `docs/reference/` that the header links
  (`tools/render/profile-frame.mjs` and `docs/reference/profile-frame.md`).
- An entry tool's first import is `import '../kit/help.mjs';` (the path from its folder). It prints
  the first line, the Usage and the Options and exits before any other import runs; `--help --full`
  prints the whole header. The other imports still resolve first, so `--help` needs the
  dependencies installed (`npm ci`). A Python tool's manual is its module docstring, and right after
  it, before any other import or a re-exec, it calls the same helper:

  ```python
  sys.path.insert(0, str(Path(__file__).resolve().parent))  # the path to tools/kit/
  from help import answer_help  # noqa: E402

  answer_help(__file__)
  ```

- A file is an entry tool if its header has a `Usage:` section, it exports nothing, or it runs only
  when called (`resolve( process.argv[ 1 ] ) === fileURLToPath( import.meta.url )`); a Python file,
  if its docstring has `Usage:` or no other tool imports it. Anything else is a module, whose header
  still opens with one sentence (`tools/repo/verify-headers.mjs`).
- `tools/repo/verify-tool-manuals.mjs`, part of `npm run check`, finds the entries so and runs each
  one's `--help` with the GPU lock, the browser and child processes made to throw, and checks that
  `docs/reference/tools.md` names it.

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
captures and probes, exclusive for timing. It holds the lock per piece of work where it can
(`leaseGpuLock`), so a long run gives way at its boundaries to a request ranked before it, and never
holds a slot while it does CPU work or waits for something else.

Readiness comes from the page:

- Use capture-browser's `waitForScene`, `waitForSettled` (the diagnostics' `settled`, with the loop
  running) and `waitForStable`, in that order. A reading is taken once the frame is ready, not right
  after the load: a fresh load's first frames are drawn before the sun's map, with every receiver
  lit.
- A step that sets a state (a clock, a camera, a uniform) and reads the frame that follows waits for
  the page's rendered frames, counted by `renderer.info.frame`: page-eval's `frames( n )` in an
  eval, `renderedFrames( page, n )` (`tools/kit/page-eval.mjs`, "Rendered frames") from a
  Playwright page of one's own, `window.__waitFrames( n )` (`installWaitFrames`) inside that page's
  own evaluate and `WAIT_FRAMES` spliced into page code written as a string. It is one wait, which
  fails at once while the page's loop is stopped. Never a count of animation frames: the frame
  pacer skips the refreshes between its frames, and a paused page in the test mode holds a due frame
  while two are still queued on the GPU (`docs/reference/test-mode.md`), so a read after animation
  frames saw the frame before whenever the page did not tick after the state was set. A still,
  converged image is waited for by `settled`, never by a count of frames of either kind.

The page's agreements, the only ways a tool meets it:

- The URL options, declared in each layer's settings table (`packages/render/Settings.ts`'s header)
  and listed in `docs/reference/url-options.md`. A tool sets the page's state through them (`--q`);
  a node tool that loads the modules installs them as the page does (`installSettings(
  parseSettings( query ) )`, `tools/render/wgsl-build.mjs` `--q`).
- The handles the page mounts on `window` on debug pages: `__PONLAI__` (the page's parts and its
  controls), `__PONLAI_WORLD__` (`ready` and `ms`, set as the world starts: `app/WorldBoot.ts`) and,
  with `?profile`, `__PONLAI_PROFILE__` (the frame profiler's readings). The scene page mounts the
  same handles (`app/scenes/ScenePage.ts`).
- `__THREE_GAME_DIAGNOSTICS__.settled`, true once a paused frame is final
  (`packages/render/post/Settled.ts`; `docs/reference/page.md`).

A tool that needs more of the page adds it to one of the three, never a global of its own.

The one configuration: `tools/project.mjs`. A kit tool (`tools/kit/`) takes the globals' names from
it (`page`) and never writes them in its code, and imports nothing outside `tools/kit/` but it
(`tools/repo/verify-kit.mjs`). The members a kit tool uses are names in its code, which the page
implements: on the handle `renderer.info.frame`, `renderer.info.memory`, `renderer.domElement`,
`loop.start()`, `loop.stop()`, `loop.running`, `loop.step( ... )`, `establishScene( query )`,
`sceneJump`, `camera`, `clockTime()`, `pipeline.width`, `pipeline.height`,
`pipeline.settings.exposureOffset`, `pipelines.total`, `taa.epoch.bump()`, `taa.epoch.value`,
`taa.converged` and `taa.rest`; on the diagnostics `settled`, `frame`, `aa` and `taa`.

White-box access: a tool may import any layer's modules and run scripts in the page
(`ARCHITECTURE.md`, rule 10). It does not reach into three.js's internals of its own: it calls the
renderer's functions in `packages/render/three/`, and the few tools that still reach in are listed
in `tools/repo/verify-three-internals.mjs` (`TOOLS_KNOWN`), a list that only shrinks.

A node tool that makes a system of the renderer that takes the look's tables hands it the set it
wants, as the page's stages do: the island's (`ISLAND_LOOK`, `packages/island/look/IslandLook.ts`)
for the numbers the island's page draws with, such as `createExposure( ISLAND_LOOK )` or
`createDayWindows( ISLAND_LOOK.day )` (`tools/render/verify-day-cycle.mjs`).

Stored results: expensive results that depend only on the commit, the tool and the browser are
stored and reused through `tools/kit/reference.mjs`; the key records everything that changes them
(the capture tools' sources are listed in `tools/project.mjs` `reference.toolFiles`). A change to
one of those files, a comment included, changes every stored set's key, so the next comparison
captures its references again: make such a change only when the capture needs it, and say so in
the commit.

## Prove

- Planted faults kept runnable: `tools/island/verify-growth-swap.mjs --fresh-grow M` loads the
  fresh page at another growth step, only to see the check fail; `tools/kit/parity/capture-clip.mjs
  --test-fault` draws a frame half a stop brighter, so the rest's second shot must reject it.
- A lint rule's fixture: `tools/repo/lint/fixtures/<rule>.ts`, linted as a file at the rule's
  place in the code; every line marked `// reported` must be reported by its rule and nothing else
  (`tools/repo/verify-lint.mjs`). Write the fixture from the file as it was before a real fix.
- A faster check keeps its guarantee: a scene-jump check compares jumps with fresh loads, not with
  other jumps.
- A replaced capture or comparison tool is compared with the old one on the same views; a
  temporal tolerance is calibrated as `tools/kit/tolerance.py`'s header records.

## Checks

- The order of remedies, and where a rule and its check are named: `AGENTS.md`, Adding a rule. A
  check that `npm run check` runs is named in `AGENTS.md`, What the checks hold; one run by hand,
  in Checks run by hand (or a folder's `AGENTS.md`); the mistake a rule came from goes in the
  commit message that adds it. The rules' full text: `docs/reference/architecture-rules.md`.
- Lint rules: `tools/repo/lint/plugin.mjs` (its header lists them, how to add one and how an
  exception is written: a disable comment naming the rule and a reason; a comment that no longer
  suppresses anything is an error), scoped in `eslint.config.mjs`, each with a fixture.
- Every commit: `npm run check` (`tools/check.mjs`; its header lists the checks). A check joins
  that list when it needs no GPU and the whole list stays near a minute; a slower one goes under
  `--full` (the production build and the world's chunk checks).
- Checks that render are run by hand under the GPU lock, named beside the kind of change that needs
  them: `AGENTS.md`, Checks run by hand, a folder's `AGENTS.md`, and the bindings of
  `verifying-rendering-changes` (Kinds) and `writing-tsl-and-passes`.
- Lists of known exceptions only shrink, and an entry no longer needed fails: `KNOWN` and `STATE`
  in `tools/repo/verify-layers.mjs`, `TOOLS_KNOWN` in `tools/repo/verify-three-internals.mjs`.

## Register

- A new entry tool gets a line in `docs/reference/tools.md` under its group, by its question;
  `verify-tool-manuals` fails until it has one.
- A new check is named where its rule is (`AGENTS.md`, What the checks hold or Checks run by hand,
  or a folder's `AGENTS.md`); the mistake behind the rule goes in the commit message. A check that
  needs no GPU is added to `tools/check.mjs`'s list and its header.
