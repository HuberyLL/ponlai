# Architecture

How Ponlai is put together: its layers, what each one owns, how data flows between them, and the
rules that cut across them. It stays at that level. What each module does and why is in the
module's header comment; the file-by-file guide is the Map in [AGENTS.md](AGENTS.md); the game's
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

1. **The rules** ([src/game/sim/](src/game/sim/)). The simulation, in plain TypeScript with no
   three.js or DOM; node runs it by stripping types. One tick is one game second, the state is the
   save, and one seeded generator draws every chance. It owns the islanders (bodies, needs, bags,
   ages, the action under way), the places they act at (the buildings, each other, the kinds of
   place registered), the ground and its paths, the five actions as tools (each with the arguments
   it takes and the condition it holds by), the perception a brain is handed, and the events it
   emits. Its core is generic: the game's content (the needs, the items and their uses, the kinds of
   place and of building, the options they offer) is definitions in
   [sim/content/](src/game/sim/content/), registered in [registry.ts](src/game/sim/registry.ts),
   which the core reads by id and in order. Today that is satiety and hydration (thirst off), the
   fish and fishing at the shore, the chest with putting in and taking out, the work on every
   building, and giving to and following someone. The stand-in brain, plain rules that play that
   content, lives here; a language-model brain fills the same slot.
2. **The session** ([src/game/Session.ts](src/game/Session.ts)). Runs the rules as a game without a
   page: it installs a simulation (new or loaded) with its record
   ([Chronicle.ts](src/game/Chronicle.ts)) and its brain, advances it frame by frame, hands the
   rules' events to its listeners, checks the player's commands at the entrance, keeps the leader's
   words for a brain that hears, asks its host for the island's growth, and writes and reads the
   save ([save.ts](src/game/save.ts)). Everything it does is a function of its host's calls.
3. **The hosts**, the presentations on top:
   - the page's game ([src/game/Game.ts](src/game/Game.ts)), behind `?game`: its view draws the
     islanders and buildings into the scene ([src/game/view/](src/game/view/)), the player's
     interface shows the game and takes the player's commands ([src/game/ui/](src/game/ui/), spec
     in [docs/explanation/ui.md](docs/explanation/ui.md)), and it keeps the autosave and the debug
     panel;
   - the play tool ([tools/play-game.mjs](tools/play-game.mjs)), which plays the same session
     headless for days with any brain and writes a transcript, a timeline and a summary, for a
     designer or for judging a brain offline;
   - the checks ([tools/verify-game.mjs](tools/verify-game.mjs)), which drive the rules and the
     session directly.

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

- **The page** ([src/main.ts](src/main.ts), loaded by the entry [src/Boot.ts](src/Boot.ts)
  after [src/PageSettings.ts](src/PageSettings.ts)): the one place that assembles the renderer, the
  island and the game. It builds them a stage at a time, the renderer's stages
  ([src/RenderStages.ts](src/RenderStages.ts)) and the island's
  ([src/IslandStages.ts](src/IslandStages.ts)) alternating in a fixed order, each stage putting
  what it builds on its layer's one object; the game starts from those two objects. The page's own
  parts are in [src/app/](src/app/): the cameras' views, the frame loop, the GUI, the scene jump,
  the diagnostics and the handles the tools drive (it mounts them on `window`). The page also holds
  the address, the reloads and the browser's storage, and the quality tier's table of cost knobs
  ([src/Quality.ts](src/Quality.ts)). It is the only part that touches the browser's page: the
  layers below take the canvas, the settings and the storage from it
  ([tools/verify-layers.mjs](tools/verify-layers.mjs), its page check, keeps them off the page).
- **The world** ([src/world/](src/world/)): the island generated from its land. The land grows a
  piece at a time; the generator runs in 16 m chunks on a pool of workers, its chunks are cached,
  merged and drawn, and a growth swaps the changed chunks in place. Its kinds (the ground, cliffs,
  stones, the sea floor, the meadow, bamboo and the other plants) and the fields their materials
  sample all derive from the land.
- **The environment**: the sky, the day cycle and the weather ([src/sky/](src/sky/)), the wind,
  haze, rain and falling leaves ([src/weather/](src/weather/)), the sea ([src/ocean/](src/ocean/)),
  the light every material shares ([src/lighting/](src/lighting/)), the materials
  ([src/materials/](src/materials/)), and the creatures and characters ([src/life/](src/life/),
  [src/characters/](src/characters/)).
- **The frame** ([src/post/](src/post/)): a frame graph declares every pass and the targets it
  reads and writes, compiles their pipelines ahead and runs them: the scene's passes, the
  anti-aliasing, the upscaling and dynamic resolution, the bloom and the display chain.
- **The look** ([src/look/](src/look/)): the numbers chosen for the island's look, one file per
  system (the sky, the day, the ambient light, the haze, the exposure, the display, the sea), each
  with its tunables and the CPU code that reads only those numbers. The environment's and the
  frame's modules keep the shaders and the methods, and take the numbers from here.

### Flows

- **Land to world.** Everything placed on the island derives from the land's footprint, its
  signed distance and noise fields with fixed seeds, per world-anchored chunk. So a new piece
  rebuilds only the chunks it reaches, and a grown page draws what a fresh load of that land draws.
- **Weather to everything.** One weather state (the sky's preset, the wind's level and heading)
  drives the sky, the one wind every plant and wave reads, the sea state and the haze; the day
  cycle sets the sun.
- **The frame.** The frame graph renders the scene's passes from what the world and the
  environment hold, then resolves, upscales and grades the image for the display.
- **Settings to every module.** Every option of the address is declared once, with what it takes,
  its default and the layer that owns it ([src/Settings.ts](src/Settings.ts)). The entry parses the
  address, reports what nobody declared or no reader tells apart, chooses the quality tier and
  installs both before any other module loads; every module then reads its options through that
  one entrance, as it loads or when it builds. Where nothing installed them (node, a worker) every
  option reads as absent and each reader takes its default.

### Extension points

The renderer is extended by registering definitions, and the files that own a registry name none
of them: a plant kind ([Registry.ts](src/world/vegetation/Registry.ts)), a kind of local light
([LocalLights.ts](src/lighting/LocalLights.ts)), an extra pass of the frame
([ExtraPass.ts](src/post/ExtraPass.ts)), a layer's scene events
([SceneEvents.ts](src/post/SceneEvents.ts)), what a cut or a scene jump clears
([SceneHistory.ts](src/post/SceneHistory.ts)) and the kinds of the debug view
([Classes.ts](src/debug/Classes.ts)). A plant kind, a kind of light and a pass each state three
things, or the registry refuses them ([Extensions.ts](src/Extensions.ts)): the quality knob that
governs their cost, how they stand in the test mode, and how they follow the land's growth. The
marks the layers leave for each other in three's `userData` are one declared list
([UserData.ts](src/UserData.ts)). *Why:* a new effect that forgot one of the three showed only
later, as a capture that did not repeat, a frame time that crept or a grown page that differed from
a fresh load; and a renderer that names the island's plants cannot draw another scene.
[tools/verify-extensions.mjs](tools/verify-extensions.mjs) registers definitions of its own and
searches the owners for the scene's names.

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
4. **Determinism and path independence.** The simulation, the world and its growth, the weather and
   every state integrated over time are functions of the land, the seeds, the clock and the calls
   made, never of the path taken, the thread count or the frame rate. *Why:* a save must play on as
   the original; a grown page must hold the world a fresh load holds; a headless run must repeat
   byte for byte, so a change to the rules shows as a difference in its output; and captures of the
   paused page are compared byte for byte. AGENTS.md's "Rules for every change" gives the rendering
   side's forms of this rule: the test mode, the chunk contract, the growth swap.
5. **Generic generation.** The island grows one piece at a time, so everything placed on it or
   fitted to it derives from the land and fixed-seed fields, never from coordinates placed by hand,
   and counts follow the measured coast or area. *Why:* the island the player grows is never the one
   anyone tuned by hand.
6. **The game stays headless.** The rules and the session reach neither three.js nor the DOM, and
   the page only hosts them. *Why:* the same game runs in the page, in the play tool and in the
   checks, with nothing copied between them, and a brain can be judged offline against what the page
   would have played.
7. **Content is registered definitions; the core names none.** A need, an item and its uses, a
   kind of place, an option at a place and a kind of building are each one definition, registered
   once in [registry.ts](src/game/sim/registry.ts) by its module in
   [sim/content/](src/game/sim/content/). A definition declares what it offers, its condition (the
   `holds` of rule 1, where standing at the place is not enough), its effects and its numbers. The
   core reads the definitions by id or in the order registered, and never names one of them: Sim's
   tick, the five actions, the perception, the needs', items', places' and buildings' systems, the
   people system, the events, the schemas and the session. The stand-in brain is a player of the
   content and may name it. Adding water is adding an item, an option at a place and a need, with no
   change to the core. *Why:* the design adds content as places and items, never as new actions
   ([docs/explanation/game-design.md](docs/explanation/game-design.md), Actions). With content
   written into the core, each new resource touched the tick, the perception, the bag rules and the
   interface, and every later system would have multiplied that work.
   [tools/verify-game.mjs](tools/verify-game.mjs) keeps the
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
   [ui/data/needs.ts](src/game/ui/data/needs.ts), an item's row in the top row, a building's model.
   A new piece of content shows with the defaults until art gives it its own. The defaults are:
   - its id as its name;
   - the 未绘 glyph for its icon and 缟 for its bar;
   - a building's finished site in place of a model;
   - the record's default row, for a kind of entry without one;
   - a default resource in the top row, for an item without one;
   - the play tool's `[event]` line, for an event kind nothing else shows.

   Player-facing words stay in the catalogues ([tools/verify-i18n.mjs](tools/verify-i18n.mjs)).
   *Why:* a presentation written per piece of content needs a change in every part for every new
   resource. One written per category shows anything the rules can make on the day it is added,
   and art then replaces the defaults one at a time.
