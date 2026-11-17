---
name: measuring-performance-changes
description: Measures whether a change makes a browser renderer faster or slower so the number can be believed, and finds where a frame's time goes, when a frame time is over budget, an optimisation is proposed, or "is it faster?" is asked. Measures a production build with exclusive use of the GPU, fixes every setting not under test, finds the run-to-run noise with an A/A run before reading an A/B, splits the frame's GPU time by pass before guessing, proves a gain exists with the cheapest measurement before building it, leaves the rendered output unchanged, reports contended runs as such and writes relative numbers. Use with three.js WebGPU renderers, or any WebGPU or WebGL renderer, whenever a change is made for speed, a frame-time regression is suspected or a cost has to be attributed to a pass.
---

# Measuring performance changes

A frame-time number is easy to get and easy to get wrong. Another page on the GPU, a development
build, an unpinned pixel ratio or a page loaded second each changes it by more than most
optimisations do. This skill fixes the conditions, measures the noise, attributes the time to
passes, and only then measures the change.

## Rules most often broken without notice

- Measure a production build. Use a development server's numbers for a quick look only, never for
  a claim.
- Give the run exclusive use of the GPU. Nothing else may render during the run: no other page,
  no hidden browser pane, no video and no capture run. A busy CPU slows the GPU too. In this
  renderer's history, a hidden pane playing a video spoiled the timings on three separate days.
- If something else used the GPU during a run, report the run as contended. Read only its
  differences or ratios inside one page, never its absolute times.
- Fix every setting that is not under test: resolution, pixel ratio and render scale (pin a
  dynamic resolution), quality, scene, camera path, and timestamps on or off. In one recorded case,
  a comparison without a fixed pixel ratio voided a whole pre-merge performance check.
- Measure the noise first. Before you trust an A/B, run the same build as both A and B (an A/A). A
  delta inside the A/A's spread is no result. One recorded two-page A/A gave the second page a
  frame interval 7 to 17 % longer, outside its confidence interval, until the tool was fixed.
- Split the frame's time by pass before you guess where it goes. On a tile-based GPU, a pass's
  start and end timestamps overlap other passes. Charge each pass the time it adds to the GPU's
  timeline, or switch the pass off and read the difference. The tick's JavaScript time is not GPU
  time.
- Before you build the change, prove that the gain exists with the cheapest measurement (step 5).
- By default, a performance change leaves the rendered output unchanged, byte for byte. A change
  to the rendered image goes in a commit of its own and is measured as an image change.
- Write relative numbers (before and after, a percentage) in commits and docs, not one machine's
  milliseconds.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: its frame-time target and scenes, how to
build and serve two commits, how to get exclusive use of the GPU, its profiler and switches, and
where results are written. When you reach the step, read section X of
`docs/bindings/measuring-performance-changes.md`. If the project's `AGENTS.md` or `CLAUDE.md` names
another file for this skill, that file takes precedence.

If the project has no binding, find each fact in the project: its profiling tool, a performance
budget in its docs, the build and preview scripts, and its debug switches. Ask the user for what
you cannot find, above all the frame-time target and whether anything else may use the GPU. When
the work ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. State the question and the performance target
- [ ] 2. Fix the conditions
- [ ] 3. Measure the noise
- [ ] 4. Attribute the frame time
- [ ] 5. Prove the gain can exist
- [ ] 6. Measure the change
- [ ] 7. Check the rendered output
- [ ] 8. Report
```

### 1. State the question and the performance target (binding: Performance target)

1. Write the question in one line: which change, on which scenes, against which commit.
2. Write what decides it. For an A/B, that is the GPU time per pass and in total. For a final
   frame rate, it is the frame interval a player sees. For a budget, it is the project's acceptance
   criterion (for example, 60 fps held under vsync). Use the scenes where the change costs or saves
   the most, and the project's standard scenes.
3. For a regression of unknown origin, bisect the history with one short, fixed measurement to
   find the first commit that shows it. Then attribute the time on that commit (step 4).

### 2. Fix the conditions (binding: Build and lock)

1. Build both sides for production: the change and the commit it starts from.
2. Pin every setting that is not under test (see the rule above). The project's profiler's default
   viewport and pixel ratio are the standard ones; a run with other values says so.
3. Get exclusive use of the GPU through the project's lock. Check that nothing else uses the GPU
   before the run, and keep watching during the run if windows stay on screen. Run headless unless
   only a real display can answer the question (frame pacing, late frames on a fast display).
4. Run with timestamps on for the split by pass, and with timestamps off for the frame rate.
   Timestamp queries can change how the browser paces frames.

### 3. Measure the noise (binding: Profiler)

1. Run an A/A: the starting build as both sides, with the same method you will use for the A/B.
2. Read the spread of each figure you will judge. Prefer the method with the smallest spread. A
   switch inside one page is better than two pages of one browser, which are better than two
   separate runs.
3. If a tool or method changed since its last A/A, run a new A/A before its A/Bs count.

### 4. Attribute the frame time (binding: Profiler)

1. Read the GPU time per pass on the scenes from step 1. Charge each pass the time it adds to the
   GPU's timeline, not its end timestamp minus its start timestamp.
2. On a tile-based GPU, do not trust one pass's figure alone. Confirm the large ones: switch the
   pass or the object off inside the page and read the difference in total GPU time.
3. Split each large cost into a fixed part and a per-pixel part by measuring at two render
   resolutions. A cost that does not change with resolution is bound by vertices, draw calls or
   dispatches, not by fragments, and a fragment optimisation will not reduce it.
4. Rank the costs and work on the largest first.

### 5. Prove the gain can exist (binding: Profiler)

1. Before you build the optimisation, measure its upper bound with the cheapest stand-in: hide
   the object, skip the pass, or give the material a flat shader. If even that saves little, stop.
2. For a quality setting (samples, taps, a pass's resolution), sweep its values in the views where
   it shows the most. Score each image against the default's with a perceptual metric. Include one
   value finer than the default, to show the error that any change of sampling brings. Measure
   time only at the values near the knee, where the error starts to rise.
3. Write down the bound and the knee. The change is judged against them.

### 6. Measure the change (binding: Profiler)

1. Keep the old path and the new one in one build behind a switch, and A/B them inside one page
   (alternating blocks of frames, both warmed up first). If you cannot, compare the two builds in
   two pages of one browser, in alternating slices, with each page brought to the front while it
   runs.
2. Use the same scenes, settings and timestamp mode as the A/A. Keep runs short. When the lock is
   shared with other work, run one scene at a time. A claim about the frame rate also needs the
   A/A and the A/B with timestamps off (step 2).
3. Read the delta with its confidence interval. If it is inside the A/A's spread, there is no
   measurable change; say so.
4. If the tool marks a run as contended, or you know it was, rerun it with exclusive use of the
   GPU. Otherwise, report it as contended with only its in-page differences and ratios.

### 7. Check the rendered output (binding: Rendered output)

1. Capture the project's still frames with the change and compare them byte for byte with the
   starting commit's. A difference is either a bug in the optimisation or an image change that
   goes in its own commit. A result of no difference counts only in views that show what the
   change affects. Check that a much coarser value of the same setting does change those views;
   otherwise the view proves nothing.
2. If a change alters the rendered image on purpose (fewer samples at the knee), report the
   measured image difference beside the time saved.

### 8. Report (binding: Record)

Report, and write in the commit body:

- the question, the scenes, the commits and the conditions (production build, exclusive or
  contended GPU, timestamps on or off, pinned render scale);
- the A/A's spread, then each delta with its confidence interval, as a percentage of the frame or
  of the pass, and the passes that changed;
- the upper bound or knee from step 5, and the output check from step 7;
- what was not measured, and any run whose numbers you discarded, with why.

Why each rule holds, the cases it comes from and the sources: [background.md](background.md).
