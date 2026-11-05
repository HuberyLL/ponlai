# Architecture

How Ponlai is put together: its layers, what each one owns, how data flows between them, and the
rules that cut across them. It stays at that level. What each module does and why is in the
module's header comment; the file-by-file guide is the Map in [AGENTS.md](AGENTS.md); the game's
design (what it is, not how the code runs it) is [docs/game-design.md](docs/game-design.md); the
look is [docs/art-direction.md](docs/art-direction.md). A change that adds a layer, moves what a
layer owns or changes a flow updates this file; a change inside a module updates its header.

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
   ages, the action under way), the places they act at (the shore, the buildings, each other), the
   ground and its paths, the five actions as tools (each with the arguments it takes and the
   condition it holds by), the perception a brain is handed, and the events it emits. The stand-in
   brain, plain rules, lives here; a language-model brain fills the same slot.
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
     in [docs/ui.md](docs/ui.md)), and it keeps the autosave and the debug panel;
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

```
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
  moves the needs, the walks and the actions under way (each checking its condition before it
  advances), and the lives.
- **Events.** Every change worth showing or keeping is emitted once, at the tick it happens. The
  session hands the events on, in order, after each call that can make them. The record turns them
  into entries; the interface's speech reads what was said; the play tool builds its transcript
  from them. The view and the interface's bars sample the state for what is now, never for what
  happened.
- **Outcomes.** Every call of an action ends in one of a few outcomes: done, failed, interrupted
  (a condition stopped holding, with the reason), refused (it never began), or replaced (another
  action took over). The interface and the play tool show an end by its category without knowing
  the action.
- **Save.** The simulation's state and the record, versioned, in one slot. Events are handed on
  before a save and are not saved, so a loaded game tells nothing twice; a save of another version
  is set aside and a new game started.
- **Growth.** The population sets how many pieces of land the island has. Once a step is due the
  session asks its host to grow: the page generates the piece and swaps it into the world in place,
  then hands the land back, and the rules' ground opens the new cells. The play tool grows the same
  land in node, or not at all.

## The rendering side

### Layers

- **The page** ([src/main.ts](src/main.ts)): the renderer, the cameras, the frame loop, the GUI,
  the diagnostics and the handles the tools drive, and the quality tier's table of cost knobs
  ([src/Quality.ts](src/Quality.ts)).
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

### Flows

- **Land to world.** Everything placed on the island derives from the land's footprint, its
  signed distance and noise fields with fixed seeds, per world-anchored chunk. So a new piece
  rebuilds only the chunks it reaches, and a grown page draws what a fresh load of that land draws.
- **Weather to everything.** One weather state (the sky's preset, the wind's level and heading)
  drives the sky, the one wind every plant and wave reads, the sea state and the haze; the day
  cycle sets the sun.
- **The frame.** The frame graph renders the scene's passes from what the world and the
  environment hold, then resolves, upscales and grades the image for the display.

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
