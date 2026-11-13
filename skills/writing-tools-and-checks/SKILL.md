---
name: writing-tools-and-checks
description: Turns a script that keeps being written into a tool, and a mistake that keeps being made into a check, when one-off scripts pile up for the same question, a tool's options are only learnt by running it, a rule in the docs is broken a second time, a review finds the same kind of fault again, or a check passes without ever having been seen to fail. Looks for an existing tool first, gives a tool one question, its manual in its header, a --help that does nothing else, meaningful exit codes and the project's facts from one configuration; prefers making a mistake impossible in the architecture or the types over a lint rule, a check or text; proves every check by planting the fault it is for; runs checks that need no GPU with every commit and names the others beside the change that needs them. Use with any repository developed mostly by AI agents, and with renderers whose checks need a GPU, whenever a tool, a verify script, a lint rule or a rule of the rules file is written or changed.
---

# Writing tools and checks

Agents solve the same question again with a new script each time, and each script makes its own
mistakes: a sleep where a readiness signal was needed, a lock not taken, an output nobody else can
read. A rule written only as text is broken again by the next change that never read it. The
method: one tool per question, documented where it is called, and every rule that can be checked
turned into a check that has been seen to fail.

## Rules most often broken without notice

- Look for the tool before you write a script. If one almost fits, add an option to it; a second
  tool for the same question splits the fixes between two copies.
- A script needed a second time, or by another task, becomes a tool. A truly one-off script stays
  in the task's scratch folder, never in the tools folder.
- `--help` prints the manual and exits before anything else runs: no lock, no browser, no server,
  no GPU. An agent that starts a tool to read its options must not start the work.
- Wait on what the system under test reports (a ready or settled signal, a counter of rendered
  frames), never on a sleep or a fixed count: a fixed wait passes or fails by chance on a busy
  machine.
- A check is proven by planting the fault it is for and seeing it fail. A check never seen to fail
  may check nothing.
- A list of known exceptions only shrinks. A new failure is fixed in the code, never added to the
  list, and an entry that no longer applies fails the check until it is removed.
- A tolerance in a check is set from measured noise of the same thing compared with itself, never
  picked to make a failure pass.
- A faster check keeps its guarantee: it still compares against the thing it promised (a fresh
  load, a reference), not against something cheaper that agrees with the change.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: its index of tools, the manual's format
and the `--help` helper, the shared modules and configuration a tool reads, its GPU lock and job
runner, where checks run and how a rule is recorded. Read section X of
`docs/bindings/writing-tools-and-checks.md` when you reach the step. If the project's `AGENTS.md`
or `CLAUDE.md` names another file for this skill, that file wins.

No binding: find each fact in the project (its tools folder and any index of it, `package.json`'s
scripts, the checks its commit hooks run, a lint configuration, how its tools wait for a page) and
ask the user for what you cannot find, above all whether anything else may use the GPU while a
tool runs. When the work ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Find the tool that answers the question
- [ ] 2. Decide: an option, a tool or a one-off
- [ ] 3. Write the manual first
- [ ] 4. Build it on what exists
- [ ] 5. Prove it
- [ ] 6. Turn a mistake into a check
- [ ] 7. Register it
```

### 1. Find the tool that answers the question (binding: Index)

Write the question in one line ("does a grown page draw what a fresh load draws?"). Look it up in
the project's index of tools by question, then read the candidate's manual with `--help`, never by
running it. Search the tools folder for the key words of the question too: an index can lag.

### 2. Decide: an option, a tool or a one-off (binding: Index)

- A tool that already answers it, but was not found (the script was written again because the
  index and the manual did not name the question): change nothing in the code; add the question to
  its manual and to the index.
- A tool that answers a neighbouring question with the same inputs: add an option to it.
- No tool, and the question has been asked before or will be by another task (a script written a
  second time, a local copy of one passed between tasks): write a tool.
- A question for this task alone: a script in the task's scratch folder, which is not reviewed,
  kept or indexed.

When agents have been writing many one-off scripts, count them by question first and build the
tools for the most frequent ones; measure where a slow tool spends its time before changing it.

### 3. Write the manual first (binding: Manual)

The manual is the tool's header comment, written for a colleague who has never met the tool, in
this order and each part once:

1. One sentence: the question the tool answers. Indexes and maps are printed from this line.
2. When to use it and what it guarantees: what it compares or measures, under which conditions,
   and its rules with their reasons.
3. Usage, from the repository's root, and Options (or "none").
4. What it prints and what files it writes.
5. Whether it takes a lock, opens a browser or needs a GPU, and its rough cost.
6. Its exit codes, and what a failure means.

Make `--help` print the purpose, Usage and Options from that header, and the whole header with a
fuller flag, before any other code runs. A long explanation goes to a reference page the header
links, so the header stays short.

### 4. Build it on what exists (binding: Build)

- Reuse the project's shared modules (browser and readiness, lock, job runner, image metrics,
  reference store) instead of copying them.
- Read the project's facts (global names, addresses, tables of views, what a stored result depends
  on) from one configuration file, never as literals in a generic tool. The tool then works in
  another project with another configuration.
- Meet the system under test through its declared interfaces only (its options, its debug handle,
  its ready signal). A tool that needs more adds it to one of those, never a global of its own.
- Unknown options are an error, not ignored.
- Output: files a script can read (images, JSON) and a short summary on stdout, only what the
  reader acts on. Errors say what to do next. A long run prints progress lines.
- Exit codes mean one thing each: 0 passed, 1 failed, and a separate code for "could not judge"
  (bad usage, a busy GPU, a missing input), so a caller never reads "not measured" as "passed".
- Readiness: wait for the system's own signal that the state is applied or the frame is final;
  after setting a state, wait for frames the system counts as rendered, not for timers or
  animation frames.
- Take a shared resource (the GPU lock) per piece of work, in the mode the work needs, and never
  hold it during CPU work or while waiting for something else.
- Store an expensive result keyed by everything that changes it (the commit's inputs, the tool's
  own sources, the browser, the options), so it is reused only while it is still valid.

### 5. Prove it (binding: Prove)

1. Replacing a script or a manual procedure: run old and new on the same inputs and compare the
   outputs (byte for byte where they should match), and the exit codes.
2. A check: plant the fault it is for (an option that loads the wrong state, a fixture with the
   bad line, a regression cut into a frame) and see it fail, with the message you expect. Keep the
   planted fault runnable (a test option or a fixture) so it can be seen to fail again.
3. A change that makes a tool or check faster: confirm it compares against the same thing as
   before and catches the same planted fault.
4. When the proof cannot be run now (no GPU free, no page to load), hand over the exact commands
   and the result each should give, and call the tool unproven until they have run.

### 6. Turn a mistake into a check (binding: Checks)

After a bug, a review's finding or a failed check, prefer in this order:

1. Make the mistake impossible in the architecture (the wrong import cannot resolve; the state
   lives where only one writer reaches it).
2. Make it impossible in the types ("make illegal states unrepresentable").
3. A lint rule, with a fixture of the bad line and the good lines beside it.
4. A check (a verify tool or a test) that reproduces the failure.
5. Only then text, naming the mistake it came from and "judgement" as what enforces it.

Then place the check where it runs:

- It needs no GPU and runs in seconds: in the command every commit passes, keeping that command
  near a minute; a slower one goes in the fuller pass run before a merge.
- It needs a GPU or minutes: name it beside the kind of change that needs it, in the rules file
  and in the guide of that kind of change, and say whether it takes the lock shared or alone.
- A rule that is text only and is broken a second time gets its check in the change that meets
  it.

### 7. Register it (binding: Register)

Add the tool to the index of tools by its question, and record the check where the project records
what enforces the rule it holds.

Why each rule holds, the cases it comes from and the sources: [background.md](background.md).
