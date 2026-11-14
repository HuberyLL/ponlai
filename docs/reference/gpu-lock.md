# GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes one
machine-wide GPU lock, so parallel sessions and agents share the GPU without disturbing each
other's timings. This page gives the lock's rules, and the rules for long jobs and waiting, process
priority and headed runs that go with it. The commands are in the tools' own headers:
`tools/kit/gpu-lock.mjs` (run under the lock, status, estimates, scheduling, the log),
`tools/kit/job.mjs` (long jobs and every wait), `tools/kit/qos.mjs` (process priority) and
`tools/kit/display-gate.mjs` (headed runs). The lock's design (its files, the rules between copies
of the lock) is the comment below the imports of `tools/kit/gpu-lock-impl.mjs`.

Contents:

- [Modes and slots](#modes-and-slots)
- [Holding a slot](#holding-a-slot)
- [The queue and the levels](#the-queue-and-the-levels)
- [Copies of the lock](#copies-of-the-lock)
- [Before a timing run](#before-a-timing-run)
- [Long jobs and waiting](#long-jobs-and-waiting)
- [Process priority](#process-priority)
- [Headed runs](#headed-runs)

## Modes and slots

Frame times are meaningful only one browser at a time: two pages that share the GPU each measure
the other's work. Pixels are not affected: a paused capture or a probe renders the same image however
busy the GPU is. So the lock has two modes:

- Exclusive: one holder and nothing else rendering. Timing runs (profiles, benchmarks, running
  captures) take it so.
- Shared: up to `PONLAI_GPU_SLOTS` holders together (default 2), and none while an exclusive holder
  runs. Paused captures, the verify probes and `tools/kit/probe.mjs` take it so.

Captures are GPU-bound. Two pages at once give about 1.75 times one page's throughput, a third about
2 times (with the slowest views taking twice as long as at two), and a fourth hardly more; the
frames are identical at every count. Probes that sweep many points gain about 1.35 times at two and
1.4 times at three, but at three a reading now and then differs from a lone probe's in the last
digit. Two slots take most of the gain with the readings exact.

## Holding a slot

- A slot is held per capture, not per set or page, so a long set and a one-view probe interleave.
  `tools/kit/parity/capture-clip.mjs` holds a slot per clip.
- A capture-set page leases its slot (`leaseGpuLock`, in `tools/kit/capture.mjs`'s worker). It keeps
  the slot from view to view, and gives it up between views only when a request ranked before its
  next one waits and it has held the slot for its lease (20 s; `--lease` of capture.mjs). A set
  behind back-to-back timing runs then advances several views per run instead of one, and a timing
  run ranked before it waits at most the lease plus the view in flight.
- An exclusive lease can keep its place (`keepPlace`, as `tools/render/profile-frame.mjs` holds the
  lock one scene at a time). It is ranked, and asked for again, under the ticket number of its
  first request, so it yields only to a request ranked before that one and keeps its rank within
  its level. A timing run of the same level queued meanwhile goes after the whole series.
- A capture that loads a page takes its slot only once the page has generated its world. Until
  then it holds the page's GPU device back (the page waits in `requestDevice`), so the world's CPU
  work in its workers runs without a slot. The slot covers the GPU set-up, the warm-up and the shot.
  A page that does not mark its world (`window.__PONLAI_WORLD__`) takes the slot at the renderer's
  start.
- A command started by `gpu-lock.mjs run`, and any process below a holder, inherits the hold. Below
  an exclusive holder everything is re-entrant. Below a shared holder, the first descendant that
  asks for a shared slot takes its ancestor's slot over, and the ancestor holds nothing from then
  on. So a wrapped orchestrator (a `run --shared` around a capture set) never holds a slot its own
  captures wait for.

## The queue and the levels

Exclusive and shared requests wait in one queue under one rule. They rank by level, then first in,
first out. A request starts when nothing ranked before it still waits: an exclusive one once every
holder has left, a shared one when a slot is free. A shared request may also start beside a shared
head while that leaves the head a slot. Nothing ranked after the head holds it up.

The levels, highest first, are `urgent` (the user's own runs), `high`, `normal` and `low` (or 0 to
3). A request's level is, first match wins:

1. a bump of that request (`prio bump`), which its process keeps for its later requests;
2. the scheduling table (`prio set`);
3. `PONLAI_GPU_PRIORITY`, which sessions leave unset (every child would inherit it);
4. its mode's default: `normal` for shared requests, `low` for exclusive ones.

So by default timing runs get no special treatment and rank below captures and probes. A default
exclusive request ages: 30 min after its run's first request it ranks `normal` (source `aged`) and
keeps its ticket, so it goes before the captures that queued after it, still after `high` and
`urgent`. A `keepPlace` run ages once, from its first piece's request. Only the default ages: a
request at a level from the table, the variable or a bump keeps it, and shared requests never age.
`PONLAI_GPU_LOCK_AGE_S` shortens the threshold for the lock's own tests only. The level is worked
out whenever the queue is ranked, so a table change reorders requests already waiting.

The scheduling table ranks other runs: `prio set` adds or replaces an entry, and a run never adds
one for itself. An entry's match is a substring of one of a request's session names or of its label.
A request's session names are the names of the checkouts (a worktree, or the main checkout) that
hold the script it runs and its working directory, and that directory's own name. So a tool started
by its absolute path from another directory is still matched by its worktree's name, and the main
checkout's name matches only requests from the main checkout. The longest match wins, an entry past
its `--for` is ignored, and the level applies to all of the session's requests, shared and exclusive
alike.

A killed holder's slot frees itself at the next look, and a killed request leaves the queue.

## Copies of the lock

Every worktree carries a copy of the lock, and one lock serves them all. `tools/kit/gpu-lock.mjs`
loads whichever implementation declares the higher `LOCK_VERSION`, its own worktree's or the main
checkout's (the main checkout's on a tie), so a branch runs every later lock upgrade as soon as main
has it. Levels hold only among copies that know them. A copy ranks an older copy's requests at their
mode's default (source `older copy`), and neither the table nor a bump moves them. Where the copies
still disagree, the cost is a delay, not a deadlock; the cases are in the design comment of
`tools/kit/gpu-lock-impl.mjs`.

## Before a timing run

Keep other pages that render the scene closed. The frame profiler also checks that the GPU is idle
before it measures, and marks its results contended otherwise (`docs/reference/profile-frame.md`).

## Long jobs and waiting

Every wait goes through `tools/kit/job.mjs`, never a sleep loop of one's own. A command that may run
longer than a few minutes (a capture set, a profile, a build of the references) runs as a job, and
whoever waits for it, or for anything else, waits with `job.mjs wait`. A wait ends at a wall-clock
budget and is called again; `job.mjs` shows where each job stands in the GPU lock while it waits.
An agent stops its own jobs (`job.mjs stop`) before it hands back.

## Process priority

On macOS, processes an agent starts are not applications: their threads run at the legacy QoS, and
on a busy machine that work is kept on the efficiency cores while the performance cores idle, so it
runs several times longer. `tools/kit/qos.mjs` starts the tools with the application policy instead.
Every tool that imports `tools/kit/gpu-lock.mjs` or `tools/kit/capture-browser.mjs` raises itself as
it starts, the heavy Python tools raise themselves, and `gpu-lock.mjs run` and `job.mjs` start their
commands so. A new CPU-heavy tool imports `tools/kit/qos.mjs` first; a one-off script runs through
`node tools/kit/qos.mjs <command>`.

## Headed runs

A headed browser run takes over the screen of whoever uses the machine, so it runs only while the
user allows it (`node tools/kit/display-gate.mjs status`). The gate is a switch, not a reason to go
headed. A run is headed only for what a screen alone shows: pacing and cadence, late frames, the
frame pacer's rate, the dynamic scale under a player's drags, and the display tools' own tests
(`tools/render/profile-frame.mjs --display`). Everything else, GPU cost and tuning included, runs
headless. A headed run covers at most 3 scenes. A headed run that is not allowed now is recorded as
pending and run later in one batch.
