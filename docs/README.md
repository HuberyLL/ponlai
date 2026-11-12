# Documentation

The documentation is sorted by the four kinds of Diátaxis (<https://diataxis.fr>). Rules for
contributors and agents are in [AGENTS.md](../AGENTS.md); the project's structure is in
[ARCHITECTURE.md](../ARCHITECTURE.md); third-party sources are in [CREDITS.md](../CREDITS.md).

## How-to guides

Steps for one task.

- [Add a material](how-to/add-material.md)
- [Add game content](how-to/add-game-content.md): a need, an item, a place, an option or a
  building in the game's simulation.
- [Check a change](how-to/check-a-change.md): a visual change, a performance change, a new
  history-dependent effect, something that depends on the land's shape.
- [Upgrade three.js](how-to/upgrade-three.md): move to another version of three.js, with the
  behaviour of three's that the code depends on.
- [Write a tool](how-to/write-a-tool.md): the rules a tool in `tools/` follows.

## Reference

Facts to look up.

- [URL options](reference/url-options.md): the page's URL options, debug views and console
  handles.
- [Tools](reference/tools.md): the tools in `tools/`, the page's keys, the test mode, captures,
  probes, the GPU lock, frame profiling and the docs checks.
- [Look values](reference/look-values.md): the measured values of the island's look (light and
  shade, exposure, water).
- [Glossary](reference/glossary.md): the project's own words.
- [Parity captures](../tools/parity/README.md): capture sets, comparisons and their tolerances.

## Explanation

What something is and why.

- [Art direction](explanation/art-direction.md): the island's look and what to avoid.
- [Game design](explanation/game-design.md): the game behind `?game`.
- [Game UI](explanation/ui.md): the player's interface.
