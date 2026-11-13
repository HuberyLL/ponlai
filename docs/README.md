# Documentation

The documentation is sorted by the four kinds of Diátaxis (<https://diataxis.fr>). Rules for
contributors and agents are in [AGENTS.md](../AGENTS.md); the project's structure is in
[ARCHITECTURE.md](../ARCHITECTURE.md); third-party sources are in [CREDITS.md](../CREDITS.md).

## How-to guides

Steps for one task.

- [Add game content](how-to/add-game-content.md): a need, an item, a place, an option or a
  building in the game's simulation.
- [Upgrade three.js](how-to/upgrade-three.md): move to another version of three.js.

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
- Skill bindings (`docs/bindings/`): this project's facts for each skill in `skills/`, a page per
  skill under its name.

## Explanation

What something is and why.

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
