# GPU lock

Everything that renders the scene in a browser (captures, profiles, GPU probes) takes one
machine-wide GPU lock, so parallel sessions and agents share the GPU without disturbing each
other's timings. This page gives the lock's rules, and the related rules for long jobs and waiting,
process priority and headed runs. The commands are in the tools' own headers:
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

Frame times are meaningful only when one browser renders at a time: two pages that share the GPU
each measure the other's work. Pixels are not affected: a paused capture or a probe renders the same
pixels however busy the GPU is. The lock therefore has two modes:

- Exclusive: one holder, and nothing else renders. Timing runs (profiles, benchmarks, captures of a
  running page) take this mode.
- Shared: up to `PONLAI_GPU_SLOTS` holders together (default 2), and none while an exclusive holder
  runs. Paused captures, the verify probes and `tools/kit/probe.mjs` take this mode.

The lock's environment variables start with the configuration's `machine.envPrefix`
([tools/project.mjs](../../tools/project.mjs)), `PONLAI_` here.

Captures are GPU-bound. Two pages at once give about 1.75 times the throughput of one page. A third
page gives about 2 times (with the slowest views taking twice as long as with two pages), and a
fourth adds hardly anything. The frames are identical at every page count. Probes that sweep many
points gain about 1.35 times with two pages and 1.4 times with three. With three pages, however, a
reading sometimes differs from a lone probe's in the last digit. Two slots give most of the gain and
keep the readings exact.

## Holding a slot

- A slot is held per capture, not per capture set or page, so a long set and a one-view probe
  interleave. `tools/kit/parity/capture-clip.mjs` holds a slot per clip.
- A capture-set page leases its slot (`leaseGpuLock`, in `tools/kit/capture.mjs`'s worker). It keeps
  the slot from view to view. It gives the slot up between views only when both of these hold: a
  request ranked before its next request is waiting, and it has held the slot for its lease (20 s;
  `--lease` of capture.mjs). As a result, a set queued behind back-to-back timing runs advances
  several views per run instead of one, and a timing run ranked before the set waits at most the
  lease plus the view in progress.
- An exclusive lease can keep its place in the queue (`keepPlace`; `tools/render/profile-frame.mjs`
  uses it to hold the lock one scene at a time). It is ranked, and requested again, under the ticket
  number of its first request. It therefore yields only to a request ranked before that one, and it
  keeps its rank within its level. A timing run of the same level that queues in the meantime goes
  after the whole series.
- A capture that loads a page takes its slot only once the page has generated its world. Until then,
  it holds back the page's GPU device (the page waits in `requestDevice`), so the world's CPU work
  in its workers runs without a slot. The slot covers the GPU setup, the warm-up and the capture. A
  page that does not mark its world (`window.__PONLAI_WORLD__`) takes the slot when the render
  pipeline starts.
- A command started by `gpu-lock.mjs run`, and any descendant process of a holder, inherits the
  hold. Under an exclusive holder, everything is re-entrant. Under a shared holder, the first
  descendant that asks for a shared slot takes over its ancestor's slot, and the ancestor holds
  nothing from then on. A wrapped orchestrator (a `run --shared` around a capture set) therefore
  never holds a slot that its own captures wait for.

## The queue and the levels

Exclusive and shared requests wait in one queue under one rule. They rank by level, then first in,
first out. A request starts when nothing ranked before it is still waiting: an exclusive request
once every holder has left, a shared request when a slot is free. A shared request may also start
alongside a shared request at the head of the queue, as long as a slot remains for the head. Nothing
ranked after the head delays it.

The levels, highest first, are `urgent` (the user's own runs), `high`, `normal` and `low` (or 0 to
3). A request's level is the first of these that applies:

1. a bump of that request (`prio bump`), which its process keeps for its later requests;
2. the scheduling table (`prio set`);
3. `PONLAI_GPU_PRIORITY`, which sessions leave unset (every child would inherit it);
4. its mode's default: `normal` for shared requests, `low` for exclusive ones.

By default, therefore, timing runs get no special treatment and rank below captures and probes. An
exclusive request at the default level ages: 30 min after its run's first request, it ranks
`normal` (source `aged`) and keeps its ticket. It then goes before the captures that queued after
it, but still after `high` and `urgent`. A `keepPlace` run ages once, counted from the request of
its first part. Only the default level ages: a request whose level comes from the table, the
variable or a bump keeps that level, and shared requests never age. `PONLAI_GPU_LOCK_AGE_S` shortens
the threshold, for the lock's own tests only. The level is computed whenever the queue is ranked,
so a change to the table reorders requests that are already waiting.

The scheduling table ranks other runs: `prio set` adds or replaces an entry, and a run never adds an
entry for itself. An entry matches a request when the entry is a substring of one of the request's
session names or of its label. A request's session names are the names of the checkouts (a
worktree, or the main checkout) that hold the script it runs and its working directory, plus that
directory's own name. A tool started by its absolute path from another directory is therefore still
matched by its worktree's name, and the main checkout's name matches only requests from the main
checkout. The longest match wins, an entry past its `--for` time is ignored, and the level applies
to all of the session's requests, shared and exclusive alike.

When a holder is killed, its slot is freed the next time the lock checks it. A killed request leaves
the queue.

## Copies of the lock

Every worktree carries a copy of the lock, and one lock serves them all. `tools/kit/gpu-lock.mjs`
loads whichever implementation declares the higher `LOCK_VERSION`, its own worktree's or the main
checkout's (the main checkout's on a tie), so a branch runs every later lock upgrade as soon as main
has it. Levels apply only among copies that know them. A copy ranks an older copy's requests at
their mode's default (source `older copy`), and neither the table nor a bump moves them. Where the
copies still disagree, the cost is a delay, not a deadlock; the cases are in the design comment of
`tools/kit/gpu-lock-impl.mjs`.

## Before a timing run

Close other pages that render the scene. The frame profiler also checks that the GPU is idle before
it measures, and otherwise marks its results as contended (`docs/reference/profile-frame.md`).

## Long jobs and waiting

Every wait goes through `tools/kit/job.mjs`, never through a sleep loop of your own. A command that
may run longer than a few minutes (a capture set, a profile, a build of the references) runs as a
job. Whoever waits for it, or for anything else, waits with `job.mjs wait`. A wait ends when its
wall-clock budget runs out, and you call it again; while it waits, `job.mjs` shows where each job
stands in the GPU lock's queue. An agent stops its own jobs (`job.mjs stop`) before it hands back.

## Process priority

On macOS, processes that an agent starts are not applications: their threads run at the legacy
quality-of-service (QoS) class. On a busy machine, that work is kept on the efficiency cores while
the performance cores are idle, so it takes several times longer. `tools/kit/qos.mjs` starts the
tools with the application policy instead. Every tool that imports `tools/kit/gpu-lock.mjs` or
`tools/kit/capture-browser.mjs` raises its own priority as it starts, and the heavy Python tools
raise their own priority too. `gpu-lock.mjs run` and `job.mjs` start their commands with the
application policy. A new CPU-heavy tool imports `tools/kit/qos.mjs` first; a one-off script runs
through `node tools/kit/qos.mjs <command>`.

## Headed runs

A headed browser run takes over the screen of whoever uses the machine, so it runs only while the
user allows it (`node tools/kit/display-gate.mjs status`). The gate is a switch, not a reason to run
headed. A run is headed only for what a real screen alone shows: pacing and cadence, late frames,
the frame pacer's rate, the dynamic resolution under a player's drags, and the display tools' own
tests (`tools/render/profile-frame.mjs --display`). Everything else, GPU cost and tuning included,
runs headless. A headed run covers at most 3 scenes. A headed run that is not allowed now is
recorded as pending and run later in one batch.
