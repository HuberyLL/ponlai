---
name: measuring-performance-changes
description: Measures whether a change makes a browser renderer faster or slower so the number can be believed, and finds where a frame's time goes, when a frame time is over budget, an optimisation is proposed, or "is it faster?" is asked. Measures a production build with the GPU held alone, fixes every setting not under test, finds the run-to-run noise with an A/A run before reading an A/B, splits the frame's GPU time by pass before guessing, proves a gain exists with the cheapest reading before building it, keeps the image unchanged, reports contended runs as such and writes relative numbers. Use with three.js WebGPU renderers, or any WebGPU or WebGL renderer, whenever a change is made for speed, a frame-time regression is suspected or a cost has to be attributed to a pass.
---

# Measuring performance changes

A frame-time number is easy to get and easy to get wrong: another page on the GPU, a dev build, a
pixel ratio left free or a page loaded second each move it by more than most optimisations do.
This skill fixes the conditions, measures the noise, attributes the time by pass, and only then
measures the change.

## Rules most often broken without notice

- Measure a production build. A dev server's numbers are for a quick look, never for a claim.
- Hold the GPU alone. Nothing else may render: no other page, no hidden browser pane, no video,
  no capture run beside it; a busy CPU slows the GPU too. In the renderer's own record a hidden
  pane playing a video spoiled the timings on three separate days.
- A run measured while something else used the GPU is reported as contended, and only its
  differences or ratios inside one page are read, never its absolute times.
- Fix every setting not under test: resolution, pixel ratio and render scale (pin a dynamic
  resolution), quality, scene, camera path, timestamps on or off. In one recorded case a
  comparison without a fixed pixel ratio voided a whole pre-merge performance check.
- Find the noise first. Run the same build as A and as B (an A/A) before trusting an A/B; a
  delta inside the A/A's spread is no result. One recorded two-page A/A gave the second page a
  frame interval 7 to 17 % longer, beyond its interval, until the tool was fixed.
- Split the frame by pass before guessing where the time goes. On a tile-based GPU a pass's
  start and end timestamps overlap other passes: charge each pass the time it adds to the GPU's
  timeline, or switch it off and read the difference. The tick's JavaScript time is not GPU time.
- Prove the gain exists with the cheapest reading before building the change (step 5).
- A performance change leaves the image as it was, byte for byte, by default. A change to the
  picture goes in a commit of its own, measured as a picture change.
- Write relative numbers (before and after, a percentage) in commits and docs, not one machine's
  milliseconds.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: its frame-time standard and scenes, how
to build and serve two commits, how to hold the GPU alone, its profiler and switches, and where
results are written. Read section X of `docs/bindings/measuring-performance-changes.md` when you
reach the step. If the project's `AGENTS.md` or `CLAUDE.md` names another file for this skill,
that file wins.

No binding: find each fact in the project (its profiling tool, a performance budget in its docs,
the build and preview scripts, its debug switches) and ask the user for what you cannot find,
above all the frame-time standard and whether anything else may use the GPU. When the work ends,
offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. State the question and the standard
- [ ] 2. Fix the conditions
- [ ] 3. Measure the noise
- [ ] 4. Attribute the frame time
- [ ] 5. Prove the gain can exist
- [ ] 6. Measure the change
- [ ] 7. Check the image
- [ ] 8. Report
```

### 1. State the question and the standard (binding: Standard)

1. Write the question in one line: which change, on which scenes, against which commit.
2. Write what decides it: the GPU time per pass and in total for an A/B; the frame interval a
   player sees for a final frame rate; the project's acceptance (for example 60 fps held under
   vsync) for a budget. Take the scenes where the change costs or saves most and the project's
   standard scenes.
3. A regression of unknown origin: find the first commit that shows it by bisecting the history
   with one short, fixed measurement, then attribute it (step 4) on that commit.

### 2. Fix the conditions (binding: Build and lock)

1. Build both sides for production: the change and the commit it starts from.
2. Pin every setting not under test (rule above). The default viewport and pixel ratio of the
   project's profiler are the standard; a run with others says so.
3. Take the GPU alone through the project's lock, check that nothing else uses the GPU before the
   run, and keep watching during it if windows stay on screen. Run headless unless the question
   is one only a real display answers (pacing, late frames on a fast display).
4. Run with timestamps on for the split by pass and off for the frame rate: timestamp queries can
   change how the browser paces frames.

### 3. Measure the noise (binding: Profiler)

1. Run an A/A: the starting build as both sides, with the same method you will use for the A/B.
2. Read the spread of each figure you will judge. Prefer the measure with the smallest spread:
   a switch inside one page beats two pages of one browser, which beat two separate runs.
3. A tool or method changed since its last A/A gets a new one before its A/Bs count.

### 4. Attribute the frame time (binding: Profiler)

1. Read the GPU time per pass on the scenes from step 1. Charge each pass the time it adds to
   the GPU's timeline, not its end minus its start.
2. Do not trust one pass's figure alone on a tile-based GPU: confirm the large ones by switching
   the pass or the object off inside the page and reading the difference in total GPU time.
3. Split each large cost into a fixed part and a part per pixel: measure at two render
   resolutions. A cost that does not change with resolution is bound by vertices, draws or
   dispatches, not by fragments; an optimisation of fragments will not move it.
4. Rank the costs and work on the largest first.

### 5. Prove the gain can exist (binding: Profiler)

1. Before building the optimisation, measure its upper bound with the cheapest stand-in: hide the
   object, skip the pass, give the material a flat shader. If even that saves little, stop.
2. For a quality knob (samples, taps, resolution of a pass), sweep its values in the views where
   it shows most and score each image against the default's with a perceptual metric, with one
   value finer than the default to show the error any change of sampling brings. Measure time
   only at the values near the knee, where the error starts to rise.
3. Write down the bound and the knee; the change is judged against them.

### 6. Measure the change (binding: Profiler)

1. Keep the old path and the new one in one build behind a switch, and A/B them inside one page
   (alternating blocks of frames, both warmed first). Otherwise compare the two builds in two
   pages of one browser, in alternating slices, each page brought to the front while it runs.
2. Use the same scenes, settings and timestamp mode as the A/A. Keep runs short; one scene at a
   time when the lock is shared with other work. A claim about the frame rate needs the A/A and
   the A/B with timestamps off as well (step 2).
3. Read the delta with its interval. Inside the A/A's spread: no measurable change, and say so.
4. A run the tool marks contended, or that you know was: rerun it alone, or report it as
   contended with only its in-page differences and ratios.

### 7. Check the image (binding: Image)

1. Shoot the project's still frames with the change and compare them with the starting commit's,
   byte for byte. A difference is either a bug in the optimisation or a picture change that goes
   in its own commit. No difference counts only in views that hold what the change affects: check
   that a much coarser value of the same setting does change them, or the view proves nothing.
2. A change that moves the picture on purpose (fewer samples at the knee) reports the measured
   image difference beside the time saved.

### 8. Report (binding: Record)

Report, and write in the commit body:

- the question, the scenes, the commits and the conditions (production, GPU alone or contended,
  timestamps on or off, pinned scale);
- the A/A's spread, then each delta with its interval, as a percentage of the frame or of the
  pass, and the passes that moved;
- the upper bound or knee from step 5, and the image check from step 7;
- what was not measured, and any run whose numbers you discarded, with why.

Why each rule holds, the cases it comes from and the sources: [background.md](background.md).
