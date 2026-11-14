# Architecture

How Ponlai is put together: its layers, what each owns, how the main flows run through them, where
the code lives by folder, and the rules that cut across the layers. Read it before a change that
adds a layer, moves what a layer owns or changes a flow, and update it with that change. Everything
below that level is written where it is owned:

- What a module does and why: its header comment. `node tools/repo/code-map.mjs [folder]` prints
  each file with the first line of its header, one level below this page's map of the folders.
- The rules across the layers in full: [Architecture rules](docs/reference/architecture-rules.md).
- What the game is: [Game design](docs/design/game-design.md). What the island looks like:
  [Art direction](docs/design/art-direction.md).

## Overview

### Two halves

Ponlai is a rendered island and a game played on it. The rendering side draws a physically lit
island in an open sea in the browser, with WebGPU. It stands alone: without `?game` the page is the
island and nothing else. The game side runs the islanders' world as rules, headless. Behind `?game`
the page hosts the game and draws it on the island; a tool hosts the same game in node.

The halves meet in four places only:

- the land: the game's ground is the world generator's land;
- the island's growth: the game asks for a piece of land, and the world grows it;
- the clock: the page's sky follows the game's time of day;
- the game's view: the islanders and their buildings are drawn into the scene.

### The layers

The code is four layers, lowest first. The first three are packages, a folder each under
`packages/`; the page is `app/`. A file's folder is its layer, and a layer imports only from itself
and the layers below (rule 10), through each package's exits (rule 11).

- **The renderer** (`packages/render/`) is what a scene in the open air needs, with nothing of this
  island's. It owns the environment (the sky, the day, the weather and the wind, the sea, the light
  every material shares, the generic materials, what every plant kind shares), the frame (a frame
  graph of passes, from the scene's passes to the display), the look's tables, the settings' schema,
  the quality tiers and every reach into three.js beyond its public interface. It offers its
  assembly (`startScene`: a running scene from its stages and the caller's content, with the frame
  loop, the scene jump and the tools' handles), its registries (rule 18), and the formats of the data
  a scene fits it with, with neutral data of its own in those formats for a scene that has none.
- **The island** (`packages/island/`) is this island, drawn by the renderer. Its world is generated
  from the land in chunks and grows a piece at a time. Beside the world it holds its materials, its
  camera, the islanders, the creatures and its numbers for the look's tables. Its stages fill the
  renderer's interfaces: they register its plant kinds, its local lights, its scene events and its
  histories, and hand the renderer the land's data.
- **The game** (`packages/game/`) is the game behind `?game`, in three parts:
  - the rules (`sim/`): the simulation in plain TypeScript, with no three.js or DOM. One tick is one
    game second, the state is the save, and one seeded generator draws every chance. The rules own
    what is (the state) and decide what happened (the events). Its core is generic: the content is
    registered definitions (rule 7);
  - the session (`Session.ts`): the rules run as a game without a page. It owns the order in which
    the world is told and what is saved, and everything it does is a function of its host's calls;
  - the hosts, which own only the presentation: the page's game (`Game.ts`, with its view and the
    player's interface), the play tool that plays the same session headless, and the checks.
- **The page** (`app/`) is the one place that assembles the renderer, the island and the game
  (rule 12). It holds the address, the reloads and the browser's storage, chooses the quality tier,
  installs the settings, picks the look and builds the layers through the renderer's assembly, the
  island's stages in its slots. Its own parts are the camera's views, the GUI and its part of the
  frame, the scene jump and the handles the tools drive. A second page (`app/scenes/`, from
  `scenes.html`) assembles the renderer alone into small test scenes, on the renderer's neutral data
  and look.

### Why the layers are cut this way

The renderer is cut from the island so that it can be built, read and checked without it: a test
scene builds the renderer alone, and a change to the island cannot reach the frame except through
an interface the renderer declares. The game is cut from the page so that the same game runs in the
page, in the play tool and in the checks, and a brain can be judged offline against what the page
would have played. One place assembles, so that the order of the build, which is part of the image,
is written once. Each package is reached through its exits, so that what it offers is a list that
can be read and reviewed.

### Main flows

- **A load.** The entry parses the address once, reports what nobody declared, chooses the quality
  tier and installs the settings before any other module loads (rule 14); it also picks the look,
  which the page hands to the stages (rule 16). The world's generation starts at once, on a pool of
  workers. The page then hands the renderer's assembly its content: the assembly calls the
  renderer's stages in one fixed order and the island's and the page's in the slots between them, an
  order which is part of the image: the order materials first build in decides their shader code.
  The game starts from what those stages built.
- **A frame.** The assembly's tick calls the renderer's frame stages in a fixed order and the page's
  content in the slots between them (the island's frame stages, the game's update and draw); its own
  work is the timer, the render scale and the pacer. One weather state drives the sky, the one wind
  every plant and wave reads, the sea state and the haze; the day sets the sun. The frame graph
  renders the scene's passes, then resolves, upscales and grades the image for the display. In the
  game, a frame advances the session by the day clock's seconds: the needs fall, the walks and the
  actions under way go on (rule 1), and what happened is emitted once, as events, which the session
  hands to the record, the interface and the play tool (rule 2).
- **A growth swap.** Everything placed on the island derives from the land, per world-anchored
  chunk (rule 5), so a new piece rebuilds only the chunks it reaches. The growth prepares the changed
  chunks and every dependent of the land's shape ahead, in idle time, then swaps them in one frame
  without building a pipeline (rule 15). In the game, the population sets the island's size: the
  session asks its host to grow, and the new land opens the game's ground.
- **A scene jump.** A scene event cuts the temporal history when the scene changes in a way its
  frames do not show. A scene jump (`establishScene`) clears what the scenes before left behind,
  through the table of histories, so that the page holds what a fresh load of the same query holds
  (rules 4 and 15).

## Code map

The folders, with what each holds. For the files in a folder, run
`node tools/repo/code-map.mjs <folder>`.

| Folder | What it holds |
| --- | --- |
| `app/` | The page: its entry, its content for the renderer's assembly (the island's stages, its part of the frame, the scene jump and the handles) and the GUI. |
| `app/scenes/` | The renderer's test scenes, a second page loaded from `scenes.html`. |
| `packages/render/` | The renderer's stages, exits, settings, quality tiers, extension declarations and neutral inputs. |
| `packages/render/assemble/` | The assembly: a running scene from the renderer's stages and the caller's content, its frame loop, scene jump, handles and browser host. |
| `packages/render/sky/` | The atmosphere, the clouds, the day cycle, the weathers and the night sky. |
| `packages/render/weather/` | The wind, the haze, the rain, the puddles and the lightning. |
| `packages/render/ocean/` | The FFT sea, the shore's waves, the water's optics and its refraction. |
| `packages/render/lighting/` | The light every material shares and the lighting models that take it. |
| `packages/render/materials/` | The generic materials, procedural textures and wet surfaces. |
| `packages/render/vegetation/` | What every plant kind shares: the registry, the default plant, the instances, the cull, the levels of detail, the wind's motion. |
| `packages/render/post/` | The frame's passes: the scene's passes, anti-aliasing, upscaling, exposure, bloom and the display chain. |
| `packages/render/post/graph/` | The frame graph, which declares every pass and its targets and compiles their pipelines ahead. |
| `packages/render/post/fsr3/` | The FSR 3 upscaler. |
| `packages/render/look/` | The look's table types, their readers and the neutral set. |
| `packages/render/three/` | Every reach into three.js beyond its public interface (rule 23). |
| `packages/render/debug/` | Debug flags, the test mode's switch, the profiler, tunables and debug views. |
| `packages/render/util/` | Deterministic noise, and work and uploads done in small steps. |
| `packages/island/` | The island's stages and exits. |
| `packages/island/world/` | The land, the world generated from it in chunks, its kinds, and the growth in place. |
| `packages/island/materials/` | The island's terrain, sea floor and meadow materials. |
| `packages/island/camera/` | The island camera and the free camera. |
| `packages/island/characters/` | The islanders' figures, looks and ages. |
| `packages/island/life/` | The island's creatures. |
| `packages/island/look/` | The island's numbers for the look's tables. |
| `packages/island/debug/` | The wind's arrows and probe, and the chunks' borders. |
| `packages/game/` | The game's session, record, save, page host and placement. |
| `packages/game/sim/` | The headless rules: the islanders, their actions, needs and places, the events. |
| `packages/game/sim/content/` | The game's content as registered definitions. |
| `packages/game/view/` | The game drawn into the scene. |
| `packages/game/ui/` | The player's interface, with its words in `i18n/`. |
| `tools/` | Checks, captures, probes, profiling and the GPU lock ([Tools](docs/reference/tools.md)). |
| `tools/kit/` | What the other tools share: servers, captures, image work, the GPU lock, jobs. |
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

- **1. An action's condition holds every tick:** each timed action declares what it needs to go on,
  and the simulation checks it in one place before the action advances.
- **2. What happened is told once, as events:** the rule that makes a change emits it at its tick,
  and whoever shows or keeps it listens.
- **3. Outside input is checked once, at the entrance:** every brain's tool and player command is
  checked against its schema before any rule runs.
- **4. Determinism and path independence:** the world, its growth, the simulation, the weather, the
  wind and every integrated state are functions of the land, the seeds, the scene clock, the weather
  and the calls made, and a history-dependent effect is cleared by a jump, converges or is frozen in
  the test mode.
- **5. Generic generation:** everything placed on or fitted to the island derives from the land and
  fixed-seed fields, never from coordinates placed by hand.
- **6. The game stays headless:** the game's rules and session reach neither three.js nor the DOM.
- **7. Content is registered definitions; the core names none:** a need, an item, a place, an option
  or a building is one registered definition, read by id or in order.
- **8. Systems talk through events and the state they own:** each system of the game writes only its
  own part of the state, and the others call its operations or emit events.
- **9. Presentation by outcome and event category, with a default:** what happened is shown by its
  category, so new content shows with defaults until art gives it its own.
- **10. Four layers, one direction:** a layer imports only from itself and the layers below, and a
  lower layer declares the interface an upper one fills.
- **11. A package is imported through its exits:** another package takes a package's names only from
  its exits, and a module does nothing as it loads but declare and register.
- **12. One place assembles; each state has one owner:** only the page builds across packages,
  through the renderer's assembly, by stages in one fixed order, and a state that changes has one
  writer.
- **13. Only the page touches the browser's page:** the renderer, the island and the game's rules
  are given what they need of the browser and never reach for its globals; a running scene is given
  a host, which the page takes from the renderer's browser exit.
- **14. Outside settings are checked once, at one entrance:** every URL option is declared in the
  table of the lowest layer that reads it, and the page installs the merged tables' settings once,
  before any module reads them.
- **15. A change of the scene is announced once, and whoever keeps something of it follows:** a cut,
  a jump or a growth reaches its followers through a table or interface walked in order.
- **16. A material gives a surface's properties; the light is computed in one place; the look is
  passed in:** no material reads the sun, the sky or the exposure, and the look's numbers are tables
  the renderer is given.
- **17. One convention for distance, light, exposure and time:** metres with y up, one scene-linear
  unit of light, exposure in stops and the scene clock's seconds.
- **18. One registered definition adds one thing:** the renderer is extended at named registries,
  each read in order and never by name, and each definition states its cost, its test-mode stand and
  its growth.
- **19. A source file stays under 1500 lines:** a file over the limit is split by what its parts
  are.
- **23. three's internals are reached in one place:** every reach into three.js beyond its public
  interface is in `packages/render/three/`, on a checked list.
