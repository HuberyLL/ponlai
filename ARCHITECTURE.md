# Architecture

How Ponlai is put together: its layers, what each layer owns, how the main flows run through them,
where the code lives by folder, and the rules that apply across the layers. Read this page before a
change that adds a layer, moves what a layer owns or changes a flow, and update it in the same
change. Everything below that level is written where it is owned:

- What a module does and why: its header comment. `node tools/repo/code-map.mjs [folder]` prints
  each file with the first line of its header, one level below this page's map of the folders.
- The rules across the layers in full: [Architecture rules](docs/reference/architecture-rules.md).
- What the game is: [Game design](docs/design/game-design.md). What the island looks like:
  [Art direction](docs/design/art-direction.md).

## Overview

### Two halves

Ponlai is a rendered island and a game played on it. The rendering side draws a physically lit
island in an open sea in the browser, with WebGPU. It works on its own: without `?game`, the app
shows the island and nothing else. The game side runs the islanders' world as headless rules. With
`?game`, the app hosts the game and draws it on the island; a tool hosts the same game in Node.js.

The two halves meet in four places only:

- the land: the game's ground is the world generator's land;
- the island's growth: the game asks for a piece of land, and the world grows it;
- the clock: the sky follows the game's time of day;
- the game's view: the islanders and their buildings are drawn into the scene.

### The layers

The code has four layers, lowest first. The first three are packages, each a folder under
`packages/`; the fourth, the app layer, is `app/`. A file's folder is its layer. A layer imports
only from itself and the layers below it (rule 10), and imports a package only through that
package's entry points (rule 11).

- **The render pipeline** (`packages/render/`) holds what any open-air scene needs, and nothing
  specific to this island. It owns the environment (the sky, the day cycle, the weather and the
  wind, the sea, the shared lighting that every material receives, the generic materials, and what
  every plant kind shares). It owns the frame (a frame graph of passes, from the scene's passes to
  the display), the look's parameter tables, the settings schema, the quality tiers and every use of
  three.js internals. It offers its assembly (`startScene`, which builds a running scene from the
  pipeline's stages and the caller's content, with the frame loop, the scene jump and the debug
  handles that tools use), its registries (rule 18), and the data formats a scene supplies. For a
  scene that supplies no data, it has neutral defaults in those formats.
- **The island** (`packages/island/`) is this island, drawn by the render pipeline. Its world is
  generated from the land in chunks and grows one piece at a time. Beside the world, the island
  holds its materials, its camera, the islanders, the creatures and its values for the look's
  tables. Its stages fill the render pipeline's interfaces: they register its plant kinds, its local
  lights, its scene events and its histories, and they pass the land's data to the render pipeline.
- **The game** (`packages/game/`) is the game behind `?game`, in three parts:
  - The rules (`sim/`): the simulation in plain TypeScript, with no three.js or DOM. One tick is one
    game second, the state is the save, and one seeded random generator makes every random choice.
    The rules own the current state and decide what happened (the events). The core is generic: the
    content is registered definitions (rule 7).
  - The session (`Session.ts`): the rules run as a game, without a browser page. The session owns
    the order in which listeners hear what happened, and what is saved. Everything it does is a
    function of its host's calls.
  - The hosts, which own only the presentation: the app's game (`Game.ts`, with its view and the
    player's interface), the play tool that plays the same session headless, and the checks.
- **The app layer** (`app/`) is the one place that assembles the render pipeline, the island and the
  game (rule 12). It owns the URL, the reloads and the browser's storage. It chooses the quality
  tier, installs the settings, picks the look, and builds the layers through the render pipeline's
  assembly, with the island's stages in the assembly's slots. Its own parts are the camera views,
  the GUI and its share of the per-frame work, the scene jump and the debug handles that the tools
  drive. A second browser page (`app/scenes/`, loaded from `scenes.html`) assembles the render
  pipeline alone into small test scenes, on the render pipeline's neutral data and look.

### Why the layers are split this way

The render pipeline is separate from the island so that it can be built, read and checked without
the island. A test scene builds the render pipeline alone, and a change to the island can reach the
frame only through an interface the render pipeline declares. The game is separate from the app so
that the same game runs in the app, in the play tool and in the checks, and an agent can be
evaluated offline against what the app would have played. One place assembles the layers, so the
build order, which affects the rendered output, is written once. Each package is imported only
through its entry points, so what it offers is a list that can be read and reviewed.

### Main flows

- **A load.** The entry module parses the URL once, reports options that no layer declared, chooses
  the quality tier and installs the settings before any other module loads (rule 14). It also picks
  the look, which the app passes to the stages (rule 16). The world's generation starts at once, on
  a pool of workers. The app then passes its content to the render pipeline's assembly. The assembly
  calls the render pipeline's stages in one fixed order, and the island's and the app's stages in
  the slots between them. This order affects the rendered output, because the order in which
  materials are first built decides their shader code. The game starts from what those stages
  built.
- **A frame.** The assembly's tick calls the render pipeline's frame stages in a fixed order, and
  the app's content in the slots between them (the island's frame stages, the game's update and
  draw). The assembly's own work is the timer, the render scale and the frame pacer. One weather
  state drives the sky, the single wind that every plant and wave reads, the sea state and the haze;
  the day cycle sets the sun. The frame graph renders the scene's passes, then resolves, upscales,
  tone-maps and grades the result for the display. In the game, a frame advances the session by the
  day clock's seconds: the needs fall, and the walks and actions under way continue (rule 1). What
  happened is emitted once, as events, which the session passes to the record, the interface and
  the play tool (rule 2).
- **A growth swap.** Everything placed on the island derives from the land, per world-anchored
  chunk (rule 5), so a new piece of land rebuilds only the chunks it reaches. The growth prepares
  the changed chunks, and everything else that depends on the land's shape, in advance during idle
  time. It then swaps them in within one frame, without building a pipeline (rule 15). In the game,
  the population sets the island's size: the session asks its host to grow the island, and the new
  land extends the game's ground.
- **A scene jump.** A scene event resets the temporal history when the scene changes in a way that
  its earlier frames do not predict. A scene jump (`establishScene`) clears what earlier scenes left
  behind, through the table of histories, so that the page then holds what a fresh load of the same
  URL holds (rules 4 and 15).

## Code map

The folders, with what each holds. For the files in a folder, run
`node tools/repo/code-map.mjs <folder>`.

| Folder | What it holds |
| --- | --- |
| `app/` | The app layer: its entry module, its content for the render pipeline's assembly (the island's stages, its per-frame work, the scene jump and the debug handles) and the GUI. |
| `app/scenes/` | The render pipeline's test scenes, a second browser page loaded from `scenes.html`. |
| `packages/render/` | The render pipeline's stages, entry points, settings, quality tiers, extension declarations and neutral inputs. |
| `packages/render/assemble/` | The assembly: a running scene built from the render pipeline's stages and the caller's content, with its frame loop, scene jump, debug handles and browser host. |
| `packages/render/sky/` | The atmosphere, the clouds, the day cycle, the weathers and the night sky. |
| `packages/render/weather/` | The wind, the haze, the rain, the puddles and the lightning. |
| `packages/render/ocean/` | The FFT sea, the shore's waves, the water's optics and its refraction. |
| `packages/render/lighting/` | The shared lighting every material receives, and the lighting models that use it. |
| `packages/render/materials/` | The generic materials, procedural textures and wet surfaces. |
| `packages/render/vegetation/` | What every plant kind shares: the registry, the default plant, the instances, the culling, the levels of detail and the wind's motion. |
| `packages/render/post/` | The frame's passes: the scene's passes, anti-aliasing, upscaling, exposure, bloom and the display chain. |
| `packages/render/post/graph/` | The frame graph, which declares every pass and its targets and precompiles their pipelines. |
| `packages/render/post/fsr3/` | The FSR 3 upscaler. |
| `packages/render/look/` | The look's table types, their readers and the neutral set. |
| `packages/render/three/` | Every use of three.js internals beyond its public interface (rule 23). |
| `packages/render/debug/` | Debug flags, the test mode's switch, the profiler, tunable parameters and debug views. |
| `packages/render/util/` | Deterministic noise, and work and uploads split into small steps. |
| `packages/island/` | The island's stages and entry points. |
| `packages/island/world/` | The land, the world generated from it in chunks, its kinds, and the growth in place. |
| `packages/island/materials/` | The island's terrain, sea floor and meadow materials. |
| `packages/island/camera/` | The island camera and the free camera. |
| `packages/island/characters/` | The islanders' figures, appearance and ages. |
| `packages/island/life/` | The island's creatures. |
| `packages/island/look/` | The island's values for the look's tables. |
| `packages/island/debug/` | The wind's arrows and probe, and the chunks' borders. |
| `packages/game/` | The game's session, record, save, browser host and placement. |
| `packages/game/sim/` | The headless rules: the islanders, their actions, needs and places, and the events. |
| `packages/game/sim/content/` | The game's content as registered definitions. |
| `packages/game/view/` | The game drawn into the scene. |
| `packages/game/ui/` | The player's interface, with its text in `i18n/`. |
| `tools/` | Checks, captures, probes, profiling and the GPU lock ([Tools](docs/reference/tools.md)). |
| `tools/kit/` | What the other tools share: servers, captures, image work, the GPU lock and jobs. |
| `tools/repo/` | The repository's own checks, the code lint, the code map and the assets. |
| `tools/render/`, `tools/island/`, `tools/game/` | The tools and checks for each package. |
| `docs/` | The documentation by kind ([docs/README.md](docs/README.md)). |
| `skills/` | Methods as skills, linked from `.claude/skills/`. |
| `public/` | The assets, git-ignored, filled from the release that `assets.lock.json` pins. |
| `LICENSES/` | Each licence's text, by SPDX id; `REUSE.toml` licenses the files without tags ([CREDITS.md](CREDITS.md)). |

## Rules across the layers

Each rule in one sentence. Its full text, why it holds, what enforces it and the mistake it came
from: [Architecture rules](docs/reference/architecture-rules.md), under the same number. Numbers 20
to 22 are not in use.

- **1. An action's condition holds every tick:** each timed action declares what it needs to
  continue, and the simulation checks it in one place before the action advances.
- **2. What happened is told once, as events:** the rule that makes a change emits it at its tick,
  and whatever shows or keeps it listens.
- **3. Outside input is checked once, at the entrance:** every agent's tool call and every player
  command is checked against its schema before any rule runs.
- **4. Determinism and path independence:** the world, its growth, the simulation, the weather, the
  wind and every integrated state are functions of the land, the seeds, the scene clock, the weather
  and the calls made; a scene jump clears a history-dependent effect, and the effect converges or
  the test mode freezes it.
- **5. Generic generation:** everything placed on or fitted to the island derives from the land and
  fixed-seed fields, never from coordinates placed by hand.
- **6. The game stays headless:** the game's rules and session use neither three.js nor the DOM.
- **7. Content is registered definitions; the core names none:** a need, an item, a place, an option
  or a building is one registered definition, read by id or in order.
- **8. Systems talk through events and the state they own:** each system of the game writes only its
  own part of the state, and the others call its operations or emit events.
- **9. Presentation by outcome and event category, with a default:** what happened is shown by its
  category, so new content shows with defaults until art gives it its own.
- **10. Four layers, one direction:** a layer imports only from itself and the layers below, and a
  lower layer declares the interface an upper one fills.
- **11. A package is imported through its entry points:** another package takes a package's names
  only from its entry points, and a module does nothing as it loads but declare and register.
- **12. One place assembles; each state has one owner:** only the app layer builds across packages,
  through the render pipeline's assembly, by stages in one fixed order, and a state that changes has
  one writer.
- **13. Only the app layer touches browser globals:** the render pipeline, the island and the game's
  rules are given what they need from the browser and never read its globals; a running scene is
  given a host, which the app layer takes from the render pipeline's browser entry point.
- **14. Outside settings are checked once, at one entrance:** every URL option is declared in the
  table of the lowest layer that reads it, and the app layer installs the merged tables' settings
  once, before any module reads them.
- **15. A scene change is announced once, and whatever depends on it follows:** a cut, a jump or a
  growth reaches the code that depends on it through a table or interface walked in order.
- **16. Materials describe surfaces; lighting is computed in one place; the look is passed in:** no
  material reads the sun, the sky or the exposure, and the look's values are tables the render
  pipeline is given.
- **17. One convention for distance, light, exposure and time:** metres with y up, one scene-linear
  unit of light, exposure in stops and the scene clock's seconds.
- **18. One registered definition adds one thing:** the render pipeline is extended at named
  registries, each read in order and never by name, and each definition declares its cost setting,
  its test-mode behaviour and how it follows the growth.
- **19. A source file stays under 1500 lines:** a file over the limit is split by what its parts
  are.
- **23. three.js internals are used in one place:** every use of three.js beyond its public
  interface is in `packages/render/three/`, on a checked list.
