# Write a tool

This guide gives the rules for writing a tool in `tools/`. The tools that exist are described in
`docs/reference/tools.md`.

When to write a tool rather than add an option or keep a one-off script is in `AGENTS.md`, Tools.
A tool is written to these rules:

- Build on the shared modules instead of copying them: `capture-browser.mjs` (browser, warm
  profiles, readiness), `parity/reference.mjs` (stored references), `parity/views.mjs`,
  `parity/pixels.py` (image metrics), `gpu-lock.mjs`, `job.mjs`, `qos.mjs`.
- The header comment comes first: the usage line, what the tool guarantees (what it compares or
  measures, and under which conditions), its rules with their reasons, and its outputs. Options
  it does not know are an error, not ignored. A change that makes a check faster keeps that
  guarantee true (a scene-jump check compares jumps with fresh loads, not with other jumps).
- Output goes to files (images, JSON a script can read) with a short summary on stdout. Exit
  codes mean something: 0 passed, 1 failed, and 3 for contended (the GPU was busy, nothing
  measured). A long tool prints progress lines, so `job.mjs wait` shows where it is.
- A tool that renders takes the GPU lock (`gpu-lock.mjs`): shared for paused captures and probes,
  exclusive for timing. It holds the lock per piece of work where it can (`leaseGpuLock`), so a
  long run gives way at its boundaries to a request ranked before it. It never holds a slot while
  it does CPU work or waits for something else.
- Readiness comes from the page, never from a fixed frame count or a sleep. Use
  capture-browser's `waitForScene`, `waitForSettled` (the diagnostics' `settled`, with the loop
  running) and `waitForStable`, in that order. A fixed 40-frame wait passed or failed by chance on
  a busy GPU. A reading of the frame is taken once it is ready, not right after the load: a fresh
  load's first frames are drawn before the sun's map, with every receiver lit.
- A step that sets a state (a clock, a camera, a uniform) and reads the frame that follows waits
  for the page's rendered frames, counted by `renderer.info.frame`: page-eval's `frames( n )` in an
  eval, `renderedFrames( page, n )` (`tools/page-eval.mjs`, "Rendered frames") from a Playwright
  page of one's own, `window.__waitFrames( n )` (`installWaitFrames`) inside that page's own
  evaluate and `WAIT_FRAMES` spliced into page code written as a string: one wait, which fails at
  once while the page's loop is stopped. Never a count of animation frames: the frame pacer skips
  the refreshes between its frames, and a paused page in the test mode holds a due frame while two
  are still queued on the GPU (`docs/reference/tools.md`, Test mode), so the read saw the frame
  before whenever the page did not tick after the state was set. Rendered frames wait for the state
  the next tick applies; a still, converged image is still waited for by `settled` (the Readiness
  rule above), never by a count of frames of either kind.
- Expensive results that depend only on the commit, the tool and the browser are stored and
  reused through `parity/reference.mjs`; record in the key everything that changes them.
- CPU-heavy node tools import `qos.mjs` first. Python tools declare their dependencies inline (PEP
  723) and run with `uv run`; image metrics come from `parity/pixels.py`.
- Tools are shared by every session's worktrees. A tool change goes to main promptly, and the
  sessions using it are told. Older copies in other worktrees are not kept compatible: those
  sessions update. The GPU lock runs the newest implementation on the machine, so a rule change
  bumps its `LOCK_VERSION` (`gpu-lock-impl.mjs`).
