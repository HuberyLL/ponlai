# Architecture

How Ponlai is put together: its layers, what each one owns, how data flows between them, and the
rules that cut across them. It stays at that level. What each module does and why is in the
module's header comment; the file-by-file guide is
[docs/reference/code-map.md](docs/reference/code-map.md); the game's
design (what it is, not how the code runs it) is
[docs/explanation/game-design.md](docs/explanation/game-design.md); the
look is [docs/explanation/art-direction.md](docs/explanation/art-direction.md). A change that adds a
layer, moves what a layer owns or changes a flow updates this file; a change inside a module updates
its header.

## Two halves

Ponlai is a rendered island and a game played on it.

- The **rendering side** draws a physically lit island in an open sea in the browser (WebGPU). It
  stands alone: without `?game` the page is the island and nothing else.
- The **game side** runs the islanders' world as rules, headless. Behind `?game` the page hosts it
  and draws it on the island; a tool hosts the same game in node.

They meet in four places only: the land (the game's ground is the world generator's land), the
island's growth (the game asks for a piece, the world grows it), the clock (the page's sky follows
the game's time of day) and the game's view (the islanders and their buildings drawn into the
scene).

## The game

### Layers

From the bottom up:

1. **The rules** ([packages/game/sim/](packages/game/sim/)). The simulation, in plain TypeScript
   with no three.js or DOM; node runs it by stripping types. One tick is one game second, the state
   is the save, and one seeded generator draws every chance. It owns the islanders (bodies, needs,
   bags, ages, the action under way), the places they act at (the buildings, each other, the kinds
   of place registered), the ground and its paths, the five actions as tools (each with the
   arguments it takes and the condition it holds by), the perception a brain is handed, and the
   events it emits. Its core is generic: the game's content (the needs, the items and their uses,
   the kinds of place and of building, the options they offer) is definitions in
   [sim/content/](packages/game/sim/content/), registered in
   [registry.ts](packages/game/sim/registry.ts), which the core reads by id and in order. Today that
   is satiety and hydration (thirst off), the fish and fishing at the shore, the chest with putting
   in and taking out, the work on every building, and giving to and following someone. The stand-in
   brain, plain rules that play that content, lives here; a language-model brain fills the same
   slot.
2. **The session** ([packages/game/Session.ts](packages/game/Session.ts)). Runs the rules as a game
   without a page: it installs a simulation (new or loaded) with its record
   ([Chronicle.ts](packages/game/Chronicle.ts)) and its brain, advances it frame by frame, hands the
   rules' events to its listeners, checks the player's commands at the entrance, keeps the leader's
   words for a brain that hears, asks its host for the island's growth, and writes and reads the
   save ([save.ts](packages/game/save.ts)). Everything it does is a function of its host's calls.
3. **The hosts**, the presentations on top:
   - the page's game ([packages/game/Game.ts](packages/game/Game.ts)), behind `?game`: its view
     draws the islanders and buildings into the scene ([packages/game/view/](packages/game/view/)),
     the player's interface shows the game and takes the player's commands
     ([packages/game/ui/](packages/game/ui/), spec in
     [docs/explanation/ui.md](docs/explanation/ui.md)), and it keeps the autosave and the debug
     panel;
   - the play tool ([tools/game/play-game.mjs](tools/game/play-game.mjs)), which plays the same session
     headless for days with any brain and writes a transcript, a timeline and a summary, for a
     designer or for judging a brain offline;
   - the checks ([tools/game/verify-game.mjs](tools/game/verify-game.mjs)), which drive the rules
     and the session directly.

What each owns: the rules own what is (the state) and decide what happened (the events); the
session owns the order in which the world is told and what is saved; a host owns only the
presentation (what it draws, how it words it, where it keeps the save). No host decides a rule, and
nothing below a host reads the page or the wall clock (the save's timestamp aside).

### Flows

```text
 player (speak bar, build bar, pause)            brain (stand-in, language model)
        |                                          ^ perception        | tool calls, now or later
        v                                          |                   v
 host (page / play tool) --> session --> entrance (schemas) --> rules: ticks, actions, needs, deaths
                               ^                                        |
                               |      events, in order, each at its tick|
                               +----------------------------------------+
                               |
                               v
             listeners: the record (first), the interface, the play tool

 host's view and bars <-- the state, sampled each frame (where each one is, what it does now)
```

- **Input.** The player's commands (words, a blueprint placed) and a brain's answers (tool calls)
  are outside input. They come through one entrance and are checked against the schema of the tool
  or command they name before any rule runs; what does not match is refused with the reason, and
  nothing outside a schema reaches the state or the save.
- **Thinking.** The simulation asks the brain for a thought when an islander has nothing under way
  (and the session asks a brain that hears when the leader speaks). The brain gets a perception
  (names, counts, needs and the time; never positions) and answers with tool calls, at once or
  later. The world runs on meanwhile; a late answer passes the entrance when it arrives, so one for
  an islander who has died since is refused.
- **Ticks.** A host's frame advances the session by real seconds at the day clock's rate. Each tick
  moves the needs (each registered need by its own rate), the walks and the actions under way (each
  checking its condition before it advances), and the lives.
- **Events.** Every change worth showing or keeping is emitted once, at the tick it happens. A
  system of the rules that keeps something of it takes it as it is emitted (the people system notes
  what each islander heard and was given). The session hands the events on, in order, after each
  call that can make them. The record turns them into entries; the interface's speech reads what
  was said; the play tool builds its transcript from them. The view and the interface's bars sample
  the state for what is now, never for what happened.
- **Outcomes.** Every call of an action ends in one of a few outcomes: done, failed, interrupted
  (a condition stopped holding, with the reason), refused (it never began), or replaced (another
  action took over). An outcome carries what the call moved between bags, from the items system's
  own account of the call. The interface and the play tool show an end by its category without
  knowing the action.
- **Save.** The simulation's state and the record, versioned, in one slot. Events are handed on
  before a save and are not saved, so a loaded game tells nothing twice; a save of another version
  is set aside and a new game started.
- **Growth.** The population sets how many pieces of land the island has. Once a step is due the
  session asks its host to grow: the page generates the piece and swaps it into the world in place,
  then hands the land back, and the rules' ground opens the new cells. The play tool grows the same
  land in node, or not at all.

## The rendering side

### Layers

The code is four layers, lowest first: the renderer, the island, the game and the page (rule 10).
The first three are packages, each a folder of `packages/`; the page is [app/](app/). A file's
folder is its layer.

- **The renderer** ([packages/render/](packages/render/)): what a scene in the open air needs,
  with nothing of this island's. It owns:
  - the environment: the sky, the day cycle and the weather
    ([packages/render/sky/](packages/render/sky/)), the wind, haze and rain
    ([packages/render/weather/](packages/render/weather/)), the sea
    ([packages/render/ocean/](packages/render/ocean/)), the light every material shares and the
    lighting models that take it ([packages/render/lighting/](packages/render/lighting/)), the
    generic materials ([packages/render/materials/](packages/render/materials/)) and what every
    plant kind shares ([packages/render/vegetation/](packages/render/vegetation/): the registry of
    kinds, the default plant, the instances, the cull, the levels of detail, the wind's motion);
  - the frame ([packages/render/post/](packages/render/post/)): a frame graph declares every pass
    and the targets it reads and writes, compiles their pipelines ahead and runs them: the scene's
    passes, the anti-aliasing, the upscaling and dynamic resolution, the bloom and the display
    chain;
  - the look's tables ([packages/render/look/](packages/render/look/)): the numbers chosen for a
    picture, one table per system (the sky, the day, the ambient light, the haze, the exposure,
    the display, the sea, the occlusion's floor, the local lights' gain, the meadow's canopy, the
    plants' answer to the wind). It holds the tables' types, a neutral set (gains of 1, no grade,
    one key all day) and, per system, the module that reads the numbers with their tunables and
    the CPU code that reads only them; the environment's and the frame's modules keep the shaders
    and the methods, and take the numbers from those readers (rule 16);
  - the settings' schema ([packages/render/Settings.ts](packages/render/Settings.ts)), the
    quality tiers' table of cost knobs ([packages/render/Quality.ts](packages/render/Quality.ts)),
    the declarations every extension states
    ([packages/render/Extensions.ts](packages/render/Extensions.ts)) and every reach into three.js
    beyond its public interface ([packages/render/three/](packages/render/three/), rule 23).

  What it leaves the layers above: its stages
  ([packages/render/RenderStages.ts](packages/render/RenderStages.ts)), which build its parts on
  one object (`RenderParts`) and run a frame (`createFrameStages`); the registries of rule 18; the
  settings, installed before it loads, and the look, handed to its stages (rules 14 and 16); and
  the formats of the data a scene fits it with (the ambient light's probes, the bounce's ground,
  the shore's fields), with neutral data of its own in those formats
  ([packages/render/NeutralInputs.ts](packages/render/NeutralInputs.ts)).
- **The island** ([packages/island/](packages/island/)): this island, drawn by the renderer. The
  world ([packages/island/world/](packages/island/world/)) is generated from its land: the land
  grows a piece at a time; the generator runs in 16 m chunks on a pool of workers, its chunks are
  cached, merged and drawn, and a growth swaps the changed chunks in place. Its kinds (the ground,
  cliffs, stones, the sea floor, the meadow, the yunpeng, the bamboo) and the fields their
  materials sample all derive from the land. Beside the world it holds its materials
  ([packages/island/materials/](packages/island/materials/)), the camera
  ([packages/island/camera/](packages/island/camera/)), the islanders
  ([packages/island/characters/](packages/island/characters/)), the creatures
  ([packages/island/life/](packages/island/life/)) and the island's numbers for the look's tables
  ([packages/island/look/](packages/island/look/)). Its stages
  ([packages/island/IslandStages.ts](packages/island/IslandStages.ts)) build its parts on one
  object (`IslandParts`) and fill the renderer's interfaces: they register the island's plant
  kinds, its kind of local light, its scene events, its histories and its kinds of the debug view,
  and hand the renderer the land's data. Its extra pass (the falling leaves' kernel) is handed to
  the renderer by the page. Its frame stages (`createIslandFrame`) are its work in a frame.
- **The game** ([packages/game/](packages/game/)): the game of the section above. Its rules and
  session are headless; its view and interface draw on the island.
- **The page** ([app/main.ts](app/main.ts), loaded by the entry [app/Boot.ts](app/Boot.ts)
  after [app/PageSettings.ts](app/PageSettings.ts); it imports
  [app/WorldBoot.ts](app/WorldBoot.ts) before its own parts, which starts the world's generation
  on the land a resumed save grew): the one place that assembles the renderer,
  the island and the game (rule 12). It holds the address, the reloads and the browser's storage,
  chooses the quality tier ([app/QualityDetect.ts](app/QualityDetect.ts)), installs the settings,
  picks the island's look, and builds the layers a stage at a time. Its own parts are in
  [app/](app/): the cameras' views, the frame loop, the GUI, the scene jump, the diagnostics and
  the handles the tools drive, which it mounts on `window`.
- **The scene page** ([app/scenes/](app/scenes/), loaded by its own entry
  [app/ScenesBoot.ts](app/ScenesBoot.ts) from `scenes.html`): a second page, which assembles the
  renderer alone into small test scenes (a few objects on level ground under the sky or in the
  open sea, and plant kinds drawn with the default plant). It builds and runs a frame with the
  same renderer stages as the island's page, gives the renderer the renderer's neutral data
  (level open ground, or the open sea far from any shore) where the island gives its own, and
  draws with the neutral look unless its entry is asked for the island's. Its files import only
  the renderer's exits ([tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs)). It mounts the
  same handles for the tools as the island's page.

### Flows

- **Assembly.** The page creates the three objects the page is built on (the renderer's parts,
  the island's, its own) and calls the renderer's stages, the island's and its own in turn, in
  an order that is part of the image: each stage puts what it builds on its layer's object, and
  the game starts from what the renderer's and the island's stages built. A frame is assembled
  the same way: the page's tick ([app/Frame.ts](app/Frame.ts)) calls the renderer's frame stages
  and the island's in turn, in a fixed order, and does only its own work between them (the timer,
  the game's update and draw, the render scale, the pacer).
- **Land to world.** Everything placed on the island derives from the land's footprint, its
  signed distance and noise fields with fixed seeds, per world-anchored chunk. So a new piece
  rebuilds only the chunks it reaches, and a grown page draws what a fresh load of that land draws.
  The growth ([packages/island/world/Growth.ts](packages/island/world/Growth.ts)) prepares the
  changed chunks and every dependent of the land's shape ahead, then swaps them in one frame.
- **Weather to everything.** One weather state (the sky's preset, the wind's level and heading)
  drives the sky, the one wind every plant and wave reads, the sea state and the haze; the day
  cycle sets the sun.
- **The frame.** The frame graph renders the scene's passes from what the world and the
  environment hold, then resolves, upscales and grades the image for the display.
- **Cuts and jumps.** A scene event ([packages/render/post/SceneEvents.ts](packages/render/post/SceneEvents.ts))
  cuts the temporal history when the scene changes in a way its frames do not show; a scene jump
  (`establishScene` in [app/Scene.ts](app/Scene.ts)) clears what the scenes before left behind,
  through the table of histories
  ([packages/render/post/SceneHistory.ts](packages/render/post/SceneHistory.ts)).
- **Settings to every module.** Every option of the address is declared once, with what it takes,
  its default and the layer that owns it
  ([packages/render/Settings.ts](packages/render/Settings.ts)). The entry parses the address,
  reports what nobody declared or no reader tells apart, chooses the quality tier and installs both
  before any other module loads; every module then reads its options through that one entrance, as
  it loads or when it builds. Where nothing installed them (node, a worker) every option reads as
  absent and each reader takes its default.
- **The look to its readers.** The page's entry picks the island's numbers after the settings
  ([app/PageSettings.ts](app/PageSettings.ts), `PAGE_LOOK`), and the page hands them to the
  stages, which make each system's tables from them where they create it.

## Rules across the layers

1. **An action's condition holds every tick.** Every timed action declares what it needs to go on
   (its place still there, still offering the option, still stood at), and the simulation checks
   it in one place before the action advances; when it fails the action ends interrupted, with the
   reason. A late answer from a brain passes the same entrance as a prompt one. *Why:* a
   precondition checked only when an action began went stale while the world moved on (the one
   followed died, a growth turned the coast inland), and such cases multiply with every rule. One
   check sends them all into one outcome the interface can show, while the rules keep changing.
2. **What happened is told once, as events.** The rule that makes a change emits it, at its tick;
   whoever shows or keeps it listens. What can be derived (a time of day from a tick) has one
   function and is never stored beside its source. *Why:* reading the state to find what changed
   loses a change made twice between two looks and dates it by the look, and two copies of one fact
   drift apart.
3. **Outside input is checked once, at the entrance.** Each tool and each player command has a
   schema of its arguments, checked before any rule runs; the rules take their arguments as given.
   *Why:* rules that each defend against bad data do it differently and miss cases (a count that is
   not a number fell back to 1; a key named `__proto__` broke a copy). One check keeps the rules
   short and the refusals uniform.
4. **Determinism and path independence.** The simulation, the world and its growth, the weather, the
   wind and every state integrated over time (the wind's travel, the fog's time) are functions of
   the land, the seeds, the scene clock, the weather and the calls made, never of the path taken,
   the thread count or the frame rate. A grown page holds the world a fresh load of its land holds,
   and a scene jump (`establishScene` in [app/Scene.ts](app/Scene.ts)) the scene a fresh load of the
   same query holds. The world's chunks and the growth's swap keep the rule for generation (the
   header comments of [packages/island/world/Chunks.ts](packages/island/world/Chunks.ts) and
   [packages/island/world/Growth.ts](packages/island/world/Growth.ts)).

   Rendering may keep a history-dependent effect (a temporal resolve, exposure adaptation, lighting
   or fog accumulated over frames, vegetation that responds to what passes through it, a per-frame
   physics simulation) when it meets three conditions: a scene jump clears its history, as it clears
   all state a scene leaves behind (a cache, a history, a size that only grows, a window that
   follows the camera); on a still scene it converges to the same image whatever came before, or it
   can be frozen or turned off in the test mode; and outside the test mode its frames are compared
   within a tolerance ([tools/parity/README.md](tools/parity/README.md), Temporal tolerance). Its
   per-frame update reads the scene clock's step, never the wall clock, so a stepped clip repeats
   (rule 17 names the three cadences that follow the wall clock's step). The test mode is a paused
   page under MSAA, with every history-dependent effect frozen or off, shot once the page's
   `settled` signal holds ([docs/reference/tools.md](docs/reference/tools.md), Test mode). There a
   paused frame is exactly repeatable and equals a fresh load's, and refactors are checked byte for
   byte; under the temporal modes a paused page shows its rest image, compared within the
   tolerance. A new history-dependent effect follows
   [docs/how-to/check-a-change.md](docs/how-to/check-a-change.md), Add a history-dependent effect.

   *Why:* a save must play on as the original; a grown page must hold the world a fresh load holds;
   a headless run must repeat byte for byte, so a change to the rules shows as a difference in its
   output; and captures of the paused page are compared byte for byte.
   [tools/verify-world-chunks.mjs](tools/verify-world-chunks.mjs),
   [tools/verify-growth-swap.mjs](tools/verify-growth-swap.mjs),
   [tools/verify-scene-jump.mjs](tools/verify-scene-jump.mjs) and the parity captures keep the
   rule, and the code lint's `ponlai/scene-clock` refuses the wall clock in code that changes the
   scene.
5. **Generic generation.** The island grows one piece at a time
   ([docs/explanation/game-design.md](docs/explanation/game-design.md), How the island grows), so
   everything placed on it derives from the land's footprint, the island's SDF and noise fields
   with fixed seeds (hashes of position, or random streams seeded per world-anchored cell, never one
   running stream across many items), never from coordinates placed by hand, and counts follow the
   measured coast length or area. So does everything fitted to the land on the page: the views, the
   camera's limits, the shore and rain fields, the reflection's box, the walking loop and the
   game's grid. Generation stays deterministic whatever the thread count (rule 4). *Why:* the
   island the player grows is never the one anyone tuned by hand.
6. **The game stays headless.** The rules and the session reach neither three.js nor the DOM, and
   the page only hosts them. *Why:* the same game runs in the page, in the play tool and in the
   checks, with nothing copied between them, and a brain can be judged offline against what the page
   would have played.
7. **Content is registered definitions; the core names none.** A need, an item and its uses, a
   kind of place, an option at a place and a kind of building are each one definition, registered
   once in [registry.ts](packages/game/sim/registry.ts) by its module in
   [sim/content/](packages/game/sim/content/). A definition declares what it offers, its condition
   (the `holds` of rule 1, where standing at the place is not enough), its effects and its numbers.
   The core reads the definitions by id or in the order registered, and never names one of them:
   Sim's tick, the five actions, the perception, the needs', items', places' and buildings' systems,
   the people system, the events, the schemas and the session. The stand-in brain is a player of the
   content and may name it. Adding water is adding an item, an option at a place and a need, with no
   change to the core. *Why:* the design adds content as places and items, never as new actions
   ([docs/explanation/game-design.md](docs/explanation/game-design.md), Actions). With content
   written into the core, each new resource touched the tick, the perception, the bag rules and the
   interface, and every later system would have multiplied that work.
   [tools/game/verify-game.mjs](tools/game/verify-game.mjs) keeps the
   rule: it registers content of its own, plays it with no change elsewhere, and fails on a content
   id written in the core as a string, a word of a template, a property's name or a key.
   The steps for adding a piece of content:
   [docs/how-to/add-game-content.md](docs/how-to/add-game-content.md).
8. **Systems talk through events and the state they own.** Each system changes only its own part of
   the state:
   - the items system what a bag or a store holds (`transfer`, `bring`, `spend`);
   - the needs' rule the needs (an item's use raises one through `raiseNeed`);
   - the buildings system the sites and the work on them;
   - the people system what an islander heard and was given.

   A rule that needs another system's change calls that system's operation, or emits an event that
   the system takes as it is emitted. A `said` or a `gave` is noticed by the people system
   (`notice`); the action does not write the hearer's memory. What a call moved between bags is the
   items system's own account of the call, never a comparison of the bags before and after. *Why:*
   a rule that writes into another system's state copies that system's rule, and two writers of one
   fact drift apart. The dependency it hides breaks under the next rule that changes that state.
9. **Presentation by outcome and event category, with a default.** The interface, the record and
   the play tool show what happened by its category: an action's end by its outcome (done, failed,
   interrupted, refused, replaced), an event by its kind (landed, said, gave, placed, built, need,
   and the others). Each category has a default form. A definition may give its own words, as
   catalogue keys by its id (`item.<id>`, `need.<id>`, `doing.do.<option>`, `record.need.<id>`).
   It may also give its own look: a need's icon and colour in
   [ui/data/needs.ts](packages/game/ui/data/needs.ts), an item's row in the top row, a building's
   model. A new piece of content shows with the defaults until art gives it its own. The defaults
   are:
   - its id as its name;
   - the 未绘 glyph for its icon and 缟 for its bar;
   - a building's finished site in place of a model;
   - the record's default row, for a kind of entry without one;
   - a default resource in the top row, for an item without one;
   - the play tool's `[event]` line, for an event kind nothing else shows.

   Player-facing words stay in the catalogues ([tools/game/verify-i18n.mjs](tools/game/verify-i18n.mjs)).
   *Why:* a presentation written per piece of content needs a change in every part for every new
   resource. One written per category shows anything the rules can make on the day it is added,
   and art then replaces the defaults one at a time.
10. **Four layers, one direction.** The code is four layers: the renderer
    ([packages/render/](packages/render/)), the island ([packages/island/](packages/island/)), the
    game ([packages/game/](packages/game/)) and the page ([app/](app/)), and a file's folder is
    its layer. A layer imports only from its own layer and the layers below it. Where a lower layer
    needs something an upper one has (the ground's albedo for the bounced light, the land's extent
    for the sea, a pass of the island's in the frame), the lower layer declares the interface and
    the upper one fills it when the page is assembled. That holds for what no import shows too: a
    lower layer never tells an upper layer's things apart by a name, and a key a layer names in an
    object's `userData` is one the renderer declares
    ([packages/render/UserData.ts](packages/render/UserData.ts)) or one its own layer declares it
    keeps to itself ([packages/island/world/IslandUserData.ts](packages/island/world/IslandUserData.ts)).
    What the chunk worker and the headless code load is free of three.js, whichever layer it is
    in. The tools and the checks are white-box: they may import any layer. The renderer still
    carries this island's words as names: in the look's types (the yunpeng's dusk window and night
    share, the island's sky rows), in the shared uniforms (the sward's tint, the island's irradiance
    source, the leaves' gain), as the name of its own techniques, passes and look table (`meadow`),
    in the debug flags (switches only the island reads), in the closed list of the debug view's
    kinds (rule 18), in the meadow's `userData` marks and in the walk's distance in the growth's
    input. It does not tell the island's things apart by these names, with two exceptions: the
    lighting model multiplies the blade family's ambient light by the sward's tint, and the
    profiler's labels take the page's parts by name and wrap the islanders' update. *Why:* the
    renderer is to be usable without this island, and a test scene builds it alone; a renderer that
    imports the island cannot be built, read or checked without it, and every change to the island
    then risks the frame. The worker's files are hashed into the world cache's key and run in node
    under the tools, so one import of three.js there fails the build.
    [tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs) keeps the rule: it reads every import
    (static, type-only, re-export, dynamic, a worker's URL), fails on one that points upward, fails
    on a package import within the worker's or a headless exit's reach, and fails on a `userData`
    key no list declares. It does not see a key reached through an alias of the bag or by a
    computed name.
11. **A package is imported through its exits.** The renderer, the island and the game are
    packages, and each offers two exits, files of re-exports only: one for the page
    ([packages/render/index.ts](packages/render/index.ts),
    [packages/island/index.ts](packages/island/index.ts),
    [packages/game/index.ts](packages/game/index.ts)) and a headless one, free of three.js, for the
    chunk worker and node ([packages/render/data.ts](packages/render/data.ts),
    [packages/island/land.ts](packages/island/land.ts),
    [packages/game/sim/index.ts](packages/game/sim/index.ts)). The renderer has a third, its setup
    exit ([packages/render/setup.ts](packages/render/setup.ts)): the settings and the quality tiers,
    which the page's first module installs before the renderer's other modules load and read them,
    and the look's types and neutral set, which the page picks from; node loads it too. Each exit
    exports only the names another package takes, each name from one exit. Another package, or the
    page, imports a package only through them; the modules the page loads on demand (the debug
    probes and the game itself) are lazy exits, imported dynamically, so they stay in chunks of
    their own
    ([tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs)). An exit loads its whole package,
    so a module does nothing as it loads but declare and register: no `await` and no read of the page
    ([tools/repo/verify-exits.mjs](tools/repo/verify-exits.mjs), which also loads the headless and
    setup exits in node). A module may still hold state at module level (uniforms, buffers, tables)
    and compute constants from the settings as it loads (the look it takes at creation: rule 16), so
    that state is one per process: a page
    holds one renderer, and the parts that would clash say so (a second light table and a second
    install of the shared uniforms throw). *Why:* what a package offers is a list that can be read
    and reviewed, and a change inside a package cannot break another; a module that worked as it
    loaded once made the order of the imports part of the program.
12. **One place assembles; each state has one owner.** Only the page builds across packages:
    [app/main.ts](app/main.ts) for the island's page, [app/scenes/ScenePage.ts](app/scenes/ScenePage.ts)
    for the test scenes. Each package offers stages, functions that take its layer's object and
    what they need as arguments and put what they build on that object: the renderer's
    ([packages/render/RenderStages.ts](packages/render/RenderStages.ts)) build what needs no land
    first (the renderer, the sky, the light, the sea and the frame's passes), then what takes a
    scene's data (the bounced light, the shore, the ambient volume, the water), then what closes
    the build (the warm-up, the shared builds); the island's
    ([packages/island/IslandStages.ts](packages/island/IslandStages.ts)) build the camera, the
    land, the world, the vegetation and the growth, and call a few of the renderer's in turn (the
    plant kinds' placing, their sun casters and the rain's bake, the trail's displacement field).
    The page calls the stages in one fixed order, which
    is part of the image (rule 4), because the order materials first build in changes their code.
    A part reaches another through what it was given or through a registry the other owns
    (rule 18). A state that changes has one owner, the only one that writes it; the others read it
    or call the owner's operation (rule 8, on the rendering side). This is not yet whole: the
    scene's shared uniforms ([packages/render/shared.ts](packages/render/shared.ts)) are one
    module-level object that every material imports rather than a parameter; so is the trail's
    displacement field, which the frame's passes find only when the island's trail stage made it
    before the renderer builds them (built the other way round, the frame silently has no
    displacement pass); the page and the game still set a few fields of the renderer's and the
    island's objects directly; the debug flags take a write from any layer through one setter that
    takes the flag's name (`setDebugFlag`, which the island calls), a write across layers the check
    does not see; and the module-level objects that other files write are listed in the check.
    *Why:* a test scene must be able to build the
    renderer with nothing of the island's, which it cannot while parts find each other through
    module-level objects; and two writers of one value hide a dependency that breaks under the next
    change. [tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs) lists the module-level
    objects that another file writes (`STATE`, and `ACROSS` for a writer in another layer); both
    lists only shrink. It sees an assignment rooted at the imported object, not a method that
    mutates it, a GUI bound to a field or a write to a field of a stage's object.
13. **Only the page touches the browser's page.** The renderer, the island and the game's rules
    never reach the address, the storage, the document or the window through the page's globals.
    What they need of the browser they are given: the canvas and the elements they draw into, the
    settings (rule 14), the storage's values, the address assets load from. A module handed an
    element reaches that element's document and window through it, for input, focus and
    visibility: the frame-rate readout
    ([packages/render/debug/FrameStats.ts](packages/render/debug/FrameStats.ts)), the island
    camera's two controls
    ([packages/island/camera/IslandCameraControls.ts](packages/island/camera/IslandCameraControls.ts),
    [packages/island/camera/FreeCameraControls.ts](packages/island/camera/FreeCameraControls.ts))
    and its framing ([packages/island/camera/IslandFraming.ts](packages/island/camera/IslandFraming.ts)).
    A few needs have one module each, and no other file may use them: the frame's pacing
    ([packages/render/post/FramePacer.ts](packages/render/post/FramePacer.ts)), the asset fetches
    ([packages/render/FetchAsset.ts](packages/render/FetchAsset.ts)), the world's cache in
    IndexedDB ([packages/island/world/WorldCache.ts](packages/island/world/WorldCache.ts)), a canvas
    used to draw a texture
    ([packages/render/vegetation/LeafTexture.ts](packages/render/vegetation/LeafTexture.ts)), the
    parsing of the address's query ([packages/render/Settings.ts](packages/render/Settings.ts)),
    and the workers' start, in the module that names each worker's script (the build bundles a
    worker only from a literal URL beside it), so the island's chunk workers start in
    [packages/island/world/WorldChunks.ts](packages/island/world/WorldChunks.ts) and the shore's
    in [packages/render/ocean/ShoreWaves.ts](packages/render/ocean/ShoreWaves.ts). Decoding an
    image through an off-screen canvas (`createImageBitmap`, `OffscreenCanvas`) is not the page, as
    a worker has it too: the scans' textures
    ([packages/render/materials/ProceduralTextures.ts](packages/render/materials/ProceduralTextures.ts))
    and the night sky's ([packages/render/sky/StarCatalog.ts](packages/render/sky/StarCatalog.ts))
    decode theirs that way. A constant the
    build provides (whether this is a development build, the address assets are served from) is
    not the page and may be read anywhere but in what a headless exit loads. The game's interface is
    the page's and uses it freely; the game's rules do not (rule 6). The game's save is the page's
    storage: the game's headless exit passes on the save's functions
    ([packages/game/save.ts](packages/game/save.ts)), which read `localStorage` when called. *Why:*
    the same code runs in a worker, in node under the tools and in a test scene, and none of them
    has this page; a module that reads the address decides its behaviour where nobody can pass it
    another.
    [tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs) fails on a page global outside the
    files listed for it (`PAGE_NEEDS`, each with the names it may use). It covers the renderer, the
    island and the game's rules by their folders, so it does not follow the game's headless exit
    into the save. It does not see the page reached through an element's document or window, through
    `globalThis`, or by a name off its list of the page's names (`PAGE`), and these routes are in
    use: the island asks for idle time through `globalThis.requestIdleCallback` (the growth, the
    islanders' ages) and the render scale reads `devicePixelRatio`. The frame's passes also read a
    global that a tool sets on the page (`__PONLAI_CLIP__`, set by
    [tools/capture-clip.mjs](tools/capture-clip.mjs)) and snap the exposure's adaptation while it is
    there: the renderer takes a state of the page by its name.
14. **Outside settings are checked once, at one entrance** (rule 3, on the rendering side). The
    address's options are declared once, in one schema
    ([packages/render/Settings.ts](packages/render/Settings.ts)): a name, a type, a range, a
    default and the layer that owns it. That schema is a renderer file and declares the island's,
    the game's and the page's options too, so an upper layer's new option is an edit to the
    renderer. The entry parses the address through that schema, reports
    a name nobody declared or a value out of range in one form, and installs the settings before
    any module that reads them loads; no other module parses an option. The installed settings do
    not change: an install after a read or a second install throws, an option is read as a module
    loads or when it builds, and changing one on a running page reloads it. A value that may change
    on a running page is a named number of the tune table
    ([packages/render/debug/Tune.ts](packages/render/debug/Tune.ts)). Where nothing installed them
    (node, a worker) every option reads as absent and each reader takes its default; a tool that
    hands options to the modules installs them the same way. *Why:* fifteen modules each read the
    address their own way, a mistyped option was silently ignored, and the list of options in the
    docs was kept by hand beside them. [tools/repo/verify-layers.mjs](tools/repo/verify-layers.mjs)
    fails on an address read outside the entrance;
    [tools/repo/verify-settings.mjs](tools/repo/verify-settings.mjs) fails when
    [docs/reference/url-options.md](docs/reference/url-options.md) and the schema differ, and when
    an option's layer is above a layer that reads it. It sees an option read by its name through the
    settings' entrance, not one read through a helper that takes the name as an argument.
15. **A change of the scene is announced once, and whoever keeps something of it follows.** Two
    changes reach across the layers: the scene is cut or jumps (a seek, a jump of the clock or the
    weather, a new scene, the page shown again), and the land grows. For the first, each layer
    declares its own reasons ([packages/render/post/SceneEvents.ts](packages/render/post/SceneEvents.ts)),
    and whatever keeps something of the scene (a history, a cache, a size that only grows, a window
    that follows the camera) registers how it is cleared in the table of histories
    ([packages/render/post/SceneHistory.ts](packages/render/post/SceneHistory.ts)), which a cut and
    a jump walk in the order registered and which names none of them. The land's growth does not
    have such a table yet: the growth
    ([packages/island/world/Growth.ts](packages/island/world/Growth.ts)) takes its followers as the
    named fields of one interface (`GrowthPage`: the world, its fields, the shore's waves, the
    refracted sun, the ambient volume, the rain, the islanders, the game and the measures), and only
    the plant kinds follow it through a registry (rule 18). A new follower of the land is a new
    field there and a line in the island's growth stage. *Why:* a dependent named in the announcer
    meant a change to the announcer and to the page for each new one, and one forgotten showed only
    as a stale shore on a grown page or a history that outlived a jump. An ordinary event bus would
    not do: a swap lands in one frame, never builds a pipeline, and the order of its followers is
    part of the image (rule 4), which a table walked in order keeps.
    [tools/verify-scene-jump.mjs](tools/verify-scene-jump.mjs) and
    [tools/verify-growth-swap.mjs](tools/verify-growth-swap.mjs) keep the result (a jumped or grown
    page draws a fresh load's frame); no check refuses a follower named in the growth.
16. **A material gives a surface's properties; the light is computed in one place; the look is
    passed in.** A material states what the surface is (its albedo, roughness, normal, what light
    passes through it, where it is wet) and names the lighting model that shades it; the model
    takes the key, the shadows, the ambient light, the bounce, the local lights and the metering
    from the renderer. No material reads the sun, the sky or the exposure, and none is tuned to
    make up for the light. The numbers chosen for the look rather than measured or derived (the
    ambient balance, the sky's gains, the haze's keys, the exposure's keys, the tone curve and the
    grade, by weather and hour) are the look: typed tables, one per system
    ([packages/render/look/](packages/render/look/)), which the renderer is given and does not
    own. The renderer carries a neutral set
    ([packages/render/look/NeutralLook.ts](packages/render/look/NeutralLook.ts): every gain one,
    every offset zero, no grade, one exposure key for the whole day) and its own modules hold only
    physical constants and the constants of their methods; the island's numbers are the island's
    data ([packages/island/look/](packages/island/look/)). Every system takes its tables as an
    argument where it is created, from the set the page hands its stages: the exposure,
    the day's windows, the low key's lift and the sky's tables, where the renderer's sky stage
    creates them ([packages/render/look/ExposureLook.ts](packages/render/look/ExposureLook.ts)
    `createExposure`, [packages/render/look/DayLook.ts](packages/render/look/DayLook.ts)
    `createDayWindows`, [packages/render/look/AmbientLook.ts](packages/render/look/AmbientLook.ts)
    `createKeyLift`, [packages/render/look/SkyLook.ts](packages/render/look/SkyLook.ts)
    `createSkyTables`), which the sky and the day cycle carry to their readers; the haze's keys and
    what the weather adds to them, also from the sky stage
    ([packages/render/look/HazeLook.ts](packages/render/look/HazeLook.ts) `createHazeTables`),
    which the haze's key reads by the hour and the weather
    ([packages/render/weather/HazeKeys.ts](packages/render/weather/HazeKeys.ts) `hazeKeyAt`); the
    ambient occlusion's floor and the meadow canopy's media, which every material's shader reads,
    and the wind on the plants, in the shared uniforms
    ([packages/render/shared.ts](packages/render/shared.ts) `createShared`, the wind's through
    [packages/render/weather/Wind.ts](packages/render/weather/Wind.ts) `windResponse`); the local
    lights' gain
    ([packages/render/lighting/LocalLights.ts](packages/render/lighting/LocalLights.ts)) and the
    ambient grade's table with its gains under overcast's deck, from the light stage
    ([packages/render/look/AmbientLook.ts](packages/render/look/AmbientLook.ts)
    `createAmbientTables`), which the grade's controller and the ambient light's relight read; and
    the sea's detail and distant swell
    ([packages/render/ocean/SeaDetail.ts](packages/render/ocean/SeaDetail.ts),
    [packages/render/ocean/OceanFFT.ts](packages/render/ocean/OceanFFT.ts)) and the display's
    tables, where the same stage creates the frame's passes
    ([packages/render/look/DisplayLook.ts](packages/render/look/DisplayLook.ts)
    `createDisplayTables`), which the frame's passes read each frame and build the display chain
    and the bloom from. Two of any of them
    made from two sets hold their own numbers
    ([tools/verify-look-params.mjs](tools/verify-look-params.mjs)), though on a debug page two
    exposures, two sets of the day's windows, two winds, two ambient grades, two sets of the
    haze's tables, two of the display's or two of the sky's share their tunables by name, and the
    shared uniforms, the grade's uniforms, the display chain's uniforms for the cool share and
    overcast's highlights, and the light table are still one a page (rule 11). No module holds a
    look: the island's page picks its set in its entry
    ([app/PageSettings.ts](app/PageSettings.ts)), the test scenes' entry picks one and hands it to
    the scene page ([app/ScenesBoot.ts](app/ScenesBoot.ts)), and a tool hands the set it wants to
    what it creates. Three sets
    of numbers do not pass through the look yet and stay the renderer's: the weathers'
    presets with the wind's four levels
    ([packages/render/sky/Weather.ts](packages/render/sky/Weather.ts), which the headless game
    reads too), the sea's chlorophyll
    ([packages/render/ocean/SeaOptics.ts](packages/render/ocean/SeaOptics.ts), which the chunk
    worker reads, so a change to it rebuilds the world's cache) and the quality table (rule 18).
    A few numbers that sit between a method's constants and the look stay in their modules too:
    the ambient occlusion kernel's reach
    ([packages/render/post/GTAO.ts](packages/render/post/GTAO.ts)), the meadow canopy's depths
    ([packages/render/lighting/MeadowCanopy.ts](packages/render/lighting/MeadowCanopy.ts)) and the
    meadow shade's march ([packages/render/post/MeadowShade.ts](packages/render/post/MeadowShade.ts)),
    the gust field's scale and evolution
    ([packages/render/weather/Wind.ts](packages/render/weather/Wind.ts)) and each plant part's
    answer to the wind ([packages/render/vegetation/Deform.ts](packages/render/vegetation/Deform.ts)).
    *Why:* a material tuned to make up for the light breaks when the light changes
    ([docs/explanation/art-direction.md](docs/explanation/art-direction.md), How the look is made),
    and a look spread over the sky, the haze, the exposure and the grade cannot be read, compared or
    replaced as one thing; a second scene needs its own without editing the renderer. A new
    material follows [docs/how-to/add-material.md](docs/how-to/add-material.md).
    Beyond the check that each system holds its own set's numbers, no tool checks the rest of this
    rule (whether a number is the look's or physics' is a judgement), a review does.
17. **One convention for distance, light, exposure and time.**
    - Distance is in metres, y up, and the sea's rest level is the water level every module reads.
      Angles are radians in code and degrees where a person types them.
    - Light is scene-linear, in the Rec. 709 primaries
      ([packages/render/post/ToneSpace.ts](packages/render/post/ToneSpace.ts)), in one relative
      unit: the sun above the atmosphere has the illuminance `SUN_ILLUMINANCE`
      ([packages/render/sky/Atmosphere.ts](packages/render/sky/Atmosphere.ts)), and every radiance
      and irradiance is in the same scale, so the sun, the sky and their reflections keep their
      true ratios. One factor (`SCENE_RADIANCE_SCALE`,
      [packages/render/lighting/Radiometry.ts](packages/render/lighting/Radiometry.ts)) brings that
      unit into a half float's range; it is applied where the light enters and undone where the
      exposure reads.
    - Albedo is the linear diffuse reflectance of the real thing, within the real range
      ([docs/reference/look-values.md](docs/reference/look-values.md), Albedo).
    - Exposure is in stops: EV is log2 of the factor that brings scene radiance to the exposed
      image. What a target stores is the scene's value times a whole power of two (the
      pre-exposure, [packages/render/post/PreExposure.ts](packages/render/post/PreExposure.ts)),
      which every writer multiplies by and every reader in scene units divides out; the sky's bakes
      store at a power of two of their own.
    - The metering light a material writes is the luminance a white diffuse surface would show
      there: the luminance of the irradiance over pi
      ([packages/render/lighting/MeterLight.ts](packages/render/lighting/MeterLight.ts)).
    - Time is the scene clock's, in seconds; the hour of the day is derived from it by one
      function, and a per-frame update reads the clock's step, never the wall clock. Three
      cadences are the exception: the page hands the renderer's frame stages the wall clock's
      step as well (`environmentDt`, [app/Frame.ts](app/Frame.ts)), and the sky's cross-fade
      between two bakes, the interval between periodic sky bakes and the interval between redraws
      of the refracted sun's map follow it. They decide when a bake or a redraw lands, not what it
      draws: on a paused page a sky bake is due only when the clock, the weather or the hour
      changed, the refracted sun's map is drawn exactly once the light rests, and the settled
      signal waits until the cross-fade has ended and nothing is due. A stepped clip hands the
      renderer its fixed step as that delta and restarts the two intervals with each call, so it
      repeats; on a running page the frame a bake lands in depends on the frame rate.

    *Why:* each of these was once two conventions that met in a factor nobody could name; a value's
    unit is otherwise known only to whoever wrote it.
    [tools/verify-radiometry.mjs](tools/verify-radiometry.mjs) checks the light's scale on the page;
    a new lit material follows [docs/how-to/add-material.md](docs/how-to/add-material.md).
18. **One registered definition adds one thing.** The renderer is extended at named points, each a
    registry its owner reads in the order registered and never by name (rule 7, on the rendering
    side). The steps for each: [docs/how-to/add-to-the-renderer.md](docs/how-to/add-to-the-renderer.md).
    - A plant kind ([packages/render/vegetation/Registry.ts](packages/render/vegetation/Registry.ts)):
      its root or its sites, its shadow filter, what it casts and takes, and how it follows the
      growth. The registry closes when the renderer places the kinds (`placeVegetation` in
      [packages/render/RenderStages.ts](packages/render/RenderStages.ts): the scene, the depth
      prepasses; the sun's caster box and the rain's bake read the same list), and a kind added
      after that is refused with what had already read the kinds.
    - A kind of local light
      ([packages/render/lighting/LocalLights.ts](packages/render/lighting/LocalLights.ts)): where
      its sources are, their colour and reach. It may be added at any time after the renderer's
      light stage made the table; its sources are read again whenever the table is refreshed.
    - An extra pass of the frame ([packages/render/post/ExtraPass.ts](packages/render/post/ExtraPass.ts)):
      it declares itself on the frame graph. The list is handed to the stage that builds the frame's
      passes and fixed there; the passes run in its order, ahead of the scene's passes, and their
      declarations cannot read a frame's data.
    - A layer's scene events ([packages/render/post/SceneEvents.ts](packages/render/post/SceneEvents.ts)):
      each reason is declared once, and a second declaration of a reason throws.
    - What a cut or a scene jump clears
      ([packages/render/post/SceneHistory.ts](packages/render/post/SceneHistory.ts)): a cut's
      entries where their owners are made, a jump's in the registration functions the page calls in
      order (rule 15).
    - The kinds of the debug view ([packages/render/debug/Classes.ts](packages/render/debug/Classes.ts)):
      the kinds are a closed list of the renderer's (sky, sea, ground, rock, grass, leaves, wood,
      figure, other), and a registered rule picks one of them for a material, so a scene adds rules,
      not kinds. The rules are asked as each material builds, so registered before the scene's
      materials build; a material built before a rule was registered never sees it, and nothing
      reports that.

    Two of these keep their order or their owner by hand. A jump clears the renderer's entries,
    then the island's, then the renderer's light, because the page calls the three registration
    functions in that order ([app/Scene.ts](app/Scene.ts)). A reason declares only whether it cuts
    the history, so the reasons only the page raises (the loop's start, a resize, a view jump) are
    declared among the renderer's, where the rest of what they mean is known.

    A plant kind, a kind of light and an extra pass each state three things, or the registry refuses
    them ([packages/render/Extensions.ts](packages/render/Extensions.ts)): the quality knob that
    governs their cost (or that none does), how they stand in the test mode (they keep no history,
    or how they are frozen or turned off and when they are settled), and how they follow the land's
    growth (they do not depend on the land, or their follower). The three are statements the
    registry checks for, not hooks: a follower named there is still wired by hand (rule 15). A plant
    kind without art of its own is drawn with the default plant, and a light source without a colour
    and reach of its own is a white point light; a pass has no default. The marks the layers leave
    for each other in three's `userData` are a declared list, not a registry (rule 10). Two points
    are not registries yet: a weather (the weathers are a closed set of names with their presets,
    [packages/render/sky/Weather.ts](packages/render/sky/Weather.ts)) and a thing placed on the
    island (each kind of the world is written into the generator and the growth). The quality
    table ([packages/render/Quality.ts](packages/render/Quality.ts)) is not a registry either: it
    is one closed table of the renderer's, and a new knob is a new field there. Work a scene does
    every frame is not registered: its page calls it between the renderer's frame stages
    (`createFrameStages`), where its order belongs. *Why:* a new effect that forgot one of the three
    showed only later, as a capture that did not repeat, a frame time that crept or a grown page
    that differed from a fresh load; and a renderer that names the island's plants cannot draw
    another scene. [tools/verify-extensions.mjs](tools/verify-extensions.mjs) registers definitions
    of its own and searches the registries' owners for the names of the island's. It searches the
    owners only, not the files that read a registry, and matches a name as a whole word, so not
    inside a compound identifier (`grassLod`); a registration's `cost` is checked as a quality
    table field by the types alone, not when the page runs.
19. **A source file stays under 1500 lines.** A file that passes it is split by what its parts are
    (a table of the look, the kernels of one effect, the passes of one stage), never by halving.
    The files over the limit when the rule was written are listed in the check and may only
    shrink. *Why:* files had grown past 2000 lines, each holding three or four things that changed
    for different reasons, and no reader, human or model, could hold one whole.
    [tools/repo/verify-file-size.mjs](tools/repo/verify-file-size.mjs) fails on a file under
    [packages/](packages/) or [app/](app/) over the limit and on a listed one that grew; the tools
    are not counted.
20. **Content enters through one acceptance.** A texture, a model or a baked table, and the
    definition that uses it, is accepted before it is added to the asset lock, against limits
    written in one table: an albedo's linear luminance and saturation within the range of real
    surfaces and of its class where the look gives one
    ([docs/reference/look-values.md](docs/reference/look-values.md), Albedo); a mesh's triangles at
    each level of detail within its kind's limit; a texture's size a power of two within its kind's
    limit, with the channels and colour space its use declares and mipmaps where it is minified;
    the path, the file names and the ids in one pattern, the id the one its definition registers;
    and a source, an author and a licence in [CREDITS.md](CREDITS.md). A limit is changed in the
    table, in a commit that says why, never bypassed for one asset. *Why:* a bright albedo, a mesh
    ten times its neighbours' density or a texture four times the size each look fine alone and are
    found later, as a material that glows at noon, a frame time that crept or a download that
    doubled; by then the art is made. No tool runs the acceptance yet: the asset lock pins each
    file's size and hash ([tools/repo/assets.mjs](tools/repo/assets.mjs)) and
    [CREDITS.md](CREDITS.md) its origin, and the rest is checked by hand against
    [docs/how-to/add-material.md](docs/how-to/add-material.md) and the look values.
21. **The frame's time is divided among the systems, and each keeps to its share.** High's standard
    is one frame's GPU time at the baseline ([packages/render/Quality.ts](packages/render/Quality.ts)).
    That time is to be divided in one table among the systems (the sky and the clouds, the sea,
    the shadows, the land, the vegetation, the air, the lights, the image's passes, the simulation's
    kernels), with a reserve nobody owns. A change that takes a system past its share saves the
    difference in the same system or is brought to whoever owns the table; it does not borrow from
    the reserve or from another system quietly. *Why:* a frame that holds as a whole says nothing
    about which part grew, and each part grows a little with every change that fits in the frame,
    until the next one does not and nobody can say what to cut. The table and its check do not
    exist yet, and neither the passes nor the registered definitions name their system: today
    [tools/profile-frame.mjs](tools/profile-frame.mjs) holds the frame as a whole to the standard
    and reports each pass's GPU time, and a change reports the passes it grew.
22. **Detail follows the screen, by one rule.** Everything drawn in numbers or at a distance takes
    its detail from how much of the screen it covers, not from a distance chosen per kind:
    - a kind declares its levels by the size its parts have on screen, and one standard gives the
      sizes at which a level hands over;
    - beyond a reference distance a field of parts keeps the share ( reference / distance )^2 of
      them, the kept ones standing in for the dropped, so its density, colour and brightness hold
      while the work follows the screen
      ([packages/render/vegetation/Lod.ts](packages/render/vegetation/Lod.ts));
    - a handover is a stipple between two levels drawn together, never a pop, and the level is a
      function of the view camera's distance alone, with no hysteresis and no state (rule 4);
    - a camera other than the view's (the sun's map, a bake) takes the level the kind declares for
      it;
    - a texture's detail follows the same screen: its mip bias is the render scale's, set in one
      place.

    *Why:* levels tuned per kind by distance disagreed (one kind thinned where its neighbour was
    still whole), popped where they were tuned by eye on one view, and had to be tuned again
    whenever the camera's range changed. One rule in screen terms holds at any resolution and any
    camera. The code follows part of it: the meadow keeps the share by distance
    ([packages/render/vegetation/Lod.ts](packages/render/vegetation/Lod.ts)), the authored plants
    and the bamboo hand over between two levels with a stipple
    ([packages/render/vegetation/PlantInstances.ts](packages/render/vegetation/PlantInstances.ts)),
    and FSR 3 sets its mip bias in one place
    ([packages/render/post/fsr3/MipBias.ts](packages/render/post/fsr3/MipBias.ts)). Each kind still
    chooses its own handover, the shadow cameras' levels are not declared, and the islanders and
    the creatures have one level. No tool checks the rule yet.
23. **three's internals are reached in one place.** The renderer depends on parts of three.js that
    are not its public interface: private members of the renderer and of its helpers, the WebGPU
    backend and its device, methods it replaces or wraps, and code of three's it mirrors. Every
    such reach lives in one folder ([packages/render/three/](packages/render/three/)), behind
    functions named for what they do (`gpuDevice`, `releaseAttribute`, `environmentSteps`); the
    rest of the code calls those and never names a private member or the backend. That folder
    keeps the list of what it depends on
    ([packages/render/three/three-internals.json](packages/render/three/three-internals.json)):
    for each entry, where it lives in three, how it is used and which of our files need it.
    three is pinned to one exact version in [package.json](package.json). A dependency that no
    longer holds is an error that names the entry, at the check and when the page starts
    ([packages/render/three/Internals.ts](packages/render/three/Internals.ts)), never a fallback to
    another path; the one exception is the graph's depth clears, which pass over a renderer without
    three's texture records, as the tools' stand-in renderers are. The extension hooks three leaves
    for materials, lighting models, shadows and inspectors (the `setup...` methods, the builder's
    context) are its interface, not its internals: they are used where they are needed, not
    gathered in the folder, and the list names them so that an upgrade sees one go. The tools are
    white-box and a few still reach in themselves, on a list of their own. An upgrade of three
    follows [docs/how-to/upgrade-three.md](docs/how-to/upgrade-three.md). *Why:* the reaches
    cannot be removed without changing the image, so they are kept where an upgrade can find them
    all. A fallback that draws a few pixels differently, or builds a pipeline more, is found weeks
    later in a capture; an error at start-up is found at once.
    [tools/repo/verify-three-internals.mjs](tools/repo/verify-three-internals.mjs) checks the pin,
    the list against the installed three, and that no file outside the folder reaches in (`TOOLS_KNOWN`,
    the tools' list, only shrinks).
