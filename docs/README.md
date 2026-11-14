# Documentation

Every page of the documentation, the skills and the rules files. The project's structure is in
[ARCHITECTURE.md](../ARCHITECTURE.md); the third-party sources whose licences ask for a credit are
in [CREDITS.md](../CREDITS.md).

## Rules files

The rules an agent or a contributor follows, loaded as the work reaches their folder.

- [AGENTS.md](../AGENTS.md): the index and the rules every change follows.
- [The render pipeline's rules](../packages/render/AGENTS.md): the shader and pass rules of
  `packages/render/` alone, and its checks run by hand.
- [The island's rules](../packages/island/AGENTS.md): the world in chunks and the growth in place.
- [The tools' rules](../tools/AGENTS.md): what a new tool in `tools/` does first.

## Skills

Methods for one kind of task, each with this project's facts in its binding (`docs/bindings/`).

- [Building a stylised-realism picture](../skills/building-cinematic-stylised-realism/SKILL.md)
  ([binding](bindings/building-cinematic-stylised-realism.md)): where a change to the look goes,
  and a new material.
- [Diagnosing frames that do not repeat](../skills/diagnosing-nonrepeating-frames/SKILL.md)
  ([binding](bindings/diagnosing-nonrepeating-frames.md)): a frame that differs between runs of the
  same build.
- [Diagnosing visual defects](../skills/diagnosing-visual-defects/SKILL.md)
  ([binding](bindings/diagnosing-visual-defects.md)): the cause of something wrong on screen.
- [Fitting a look to reference images](../skills/fitting-a-look-to-reference-images/SKILL.md)
  ([binding](bindings/fitting-a-look-to-reference-images.md)): the light, air and image values that
  bring a frame to the reader's own reference images.
- [Measuring performance changes](../skills/measuring-performance-changes/SKILL.md)
  ([binding](bindings/measuring-performance-changes.md)): whether a change is faster, and where a
  frame's time goes.
- [Verifying rendering changes](../skills/verifying-rendering-changes/SKILL.md)
  ([binding](bindings/verifying-rendering-changes.md)): proving a change did what was meant and
  nothing else.
- [Writing docs and skills](../skills/writing-docs-and-skills/SKILL.md)
  ([binding](bindings/writing-docs-and-skills.md)): where each text lives and how it is kept true.
- [Writing tools and checks](../skills/writing-tools-and-checks/SKILL.md)
  ([binding](bindings/writing-tools-and-checks.md)): a tool, its manual, and a check proved by its
  planted fault.
- [Writing TSL and passes](../skills/writing-tsl-and-passes/SKILL.md)
  ([binding](bindings/writing-tsl-and-passes.md)): shaders, compute kernels, passes and GPU buffers
  without the failures that give no error.

## Design

What the look and the game are, and why.

- [Art direction](design/art-direction.md): the island's look as a whole (the light, the
  shade, the exposure, the image) and how it is judged.
  - [The island](design/island.md): the land, the cliffs, the sea floor, the meadow, the
    bamboo, the yunpeng, the wind.
  - [Sea and sky](design/sea-and-sky.md): the sea, its foam and its water, the sun, the air,
    the clouds, the sky's colour, the parked weathers.
  - [Night](design/night.md): the moon, its light, the stars.
  - [Life and islanders](design/life-and-islanders.md): the creatures and the people.
- [Game design](design/game-design.md): the game behind `?game`.
- [Game UI](design/ui.md): the player's interface.

## Reference

Facts to look up.

- [URL options](reference/url-options.md): the page's URL options, debug views and console
  handles.
- [Tools](reference/tools.md): the index of the tools in `tools/`, by the question each answers;
  each tool's manual is its header (`node <tool> --help`).
- [Test mode](reference/test-mode.md): how a page is loaded so that a frame repeats exactly, and
  the `settled` signal.
- [GPU lock](reference/gpu-lock.md): the lock every tool that renders takes, long jobs and waiting,
  process priority and headed runs.
- [The page's handles and keys](reference/page.md): the debug handles the tools drive, the keys, the
  island camera's controls and the performance readout.
- [Frame profiler](reference/profile-frame.md): what `tools/render/profile-frame.mjs` measures and
  how to read its results.
- [Extension points](reference/extension-points.md): where a plant kind, a kind of local light, an
  extra pass of the frame, a scene event or a history is registered, and what each takes.
- [Look values](reference/look-values.md): the measured values of the island's look (light and
  shade, exposure, water).
- [Architecture rules](reference/architecture-rules.md): the rules across the layers in full, each
  with why it holds, what enforces it and the mistake it came from.
- [three.js and WebGPU behaviour](reference/three-behaviour.md): what three r186, WebGPU and TSL
  do that the code is written around; read it before writing TSL or a pass of the frame graph.
- [Glossary](reference/glossary.md): the project's own words.
- [Parity captures](../tools/kit/parity/README.md): the facts across the parity tools: which
  comparison is byte-exact, how a tolerance is set and how the stored references are used.

## How-to guides

Steps for one task that no skill covers.

- [Add game content](how-to/add-game-content.md): a need, an item, a place, an option or a
  building in the game's simulation.
- [Upgrade three.js](how-to/upgrade-three.md): move to another version of three.js.
