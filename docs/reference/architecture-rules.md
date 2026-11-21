# Architecture rules

The rules that apply across the layers, in full. [ARCHITECTURE.md](../../ARCHITECTURE.md) states
each rule in one sentence under the same number; this page gives the rule, why it holds, what
enforces it and the mistake it came from. Where a module owns the detail, the rule links to the
module's header comment instead of repeating it. Numbers are never reused: 20, 21 and 22 are not in
use.

Contents:

- [Rule 1: An action's condition holds every tick](#rule-1-an-actions-condition-holds-every-tick)
- [Rule 2: What happened is told once, as events](#rule-2-what-happened-is-told-once-as-events)
- [Rule 3: Outside input is checked once, at the
  entrance](#rule-3-outside-input-is-checked-once-at-the-entrance)
- [Rule 4: Determinism and path independence](#rule-4-determinism-and-path-independence)
- [Rule 5: Generic generation](#rule-5-generic-generation)
- [Rule 6: The game stays headless](#rule-6-the-game-stays-headless)
- [Rule 7: Content is registered definitions; the core names
  none](#rule-7-content-is-registered-definitions-the-core-names-none)
- [Rule 8: Systems talk through events and the state they
  own](#rule-8-systems-talk-through-events-and-the-state-they-own)
- [Rule 9: Presentation by outcome and event category, with a
  default](#rule-9-presentation-by-outcome-and-event-category-with-a-default)
- [Rule 10: Four layers, one direction](#rule-10-four-layers-one-direction)
- [Rule 11: A package is imported through its entry
  points](#rule-11-a-package-is-imported-through-its-entry-points)
- [Rule 12: One place assembles; each state has one
  owner](#rule-12-one-place-assembles-each-state-has-one-owner)
- [Rule 13: Only the app layer touches browser
  globals](#rule-13-only-the-app-layer-touches-browser-globals)
- [Rule 14: Outside settings are checked once, at one
  entrance](#rule-14-outside-settings-are-checked-once-at-one-entrance)
- [Rule 15: A scene change is announced once, and whatever depends on it
  follows](#rule-15-a-scene-change-is-announced-once-and-whatever-depends-on-it-follows)
- [Rule 16: Materials describe surfaces; lighting is computed in one place; the look is passed
  in](#rule-16-materials-describe-surfaces-lighting-is-computed-in-one-place-the-look-is-passed-in)
- [Rule 17: One convention for distance, light, exposure and
  time](#rule-17-one-convention-for-distance-light-exposure-and-time)
- [Rule 18: One registered definition adds one
  thing](#rule-18-one-registered-definition-adds-one-thing)
- [Rule 19: A source file stays under 1500 lines](#rule-19-a-source-file-stays-under-1500-lines)
- [Rule 23: three.js internals are used in one
  place](#rule-23-threejs-internals-are-used-in-one-place)

## Rule 1: An action's condition holds every tick

Every timed action declares what it needs to continue: its place still exists, still offers the
option, and the islander is still standing at it. The simulation checks that condition in one place
before the action advances. When the condition fails, the action ends as interrupted, with the
reason. A late answer from an agent passes the same entrance as a prompt one. The mechanism:
[actions.ts](../../packages/game/sim/actions.ts), its header.

**Why:** one check turns every way the world can change during an action into one outcome that the
interface can show, while the rules keep changing.

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs) and review.

**Came from:** a precondition checked only when an action began went stale as the world changed
(the islander being followed died, a growth turned the coast inland), and such cases multiplied with
every rule.

## Rule 2: What happened is told once, as events

The rule that makes a change emits it, at its tick; whatever shows or keeps the change listens.
What can be derived (a time of day from a tick) has one function and is never stored beside its
source. The event stream and its listeners: [events.ts](../../packages/game/sim/events.ts) and
[Session.ts](../../packages/game/Session.ts), their headers.

**Why:** reading the state to find what changed misses a change made twice between two reads and
dates the change by the read, and two copies of one fact drift apart.

**Enforced by:** review.

**Came from:** none on record.

## Rule 3: Outside input is checked once, at the entrance

Each tool an agent can call, and each player command, has a schema for its arguments, checked
before any rule runs. The rules take their arguments as given. The entrance:
[agent.ts](../../packages/game/sim/agent.ts) `act` and
[schema.ts](../../packages/game/sim/schema.ts).

**Why:** one check keeps the rules short and the refusals uniform.

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs) and review.

**Came from:** rules that each defended against bad data did it differently and missed cases: a
count that was not a number fell back to 1, and a key named `__proto__` broke a copy.

## Rule 4: Determinism and path independence

The simulation, the world and its growth, the weather, the wind and every state integrated over time
(the wind's travel, the fog's time) are functions of the land, the seeds, the scene clock, the
weather and the calls made. They never depend on the path taken, the thread count or the frame rate.
After a growth swap, a page holds the world that a fresh load of its land holds. After a scene jump
(`establishScene` in [SceneJump.ts](../../packages/render/assemble/SceneJump.ts)), a page holds the
scene that a fresh load of the same URL holds. How the world's chunks and the growth swap keep the
rule for generation: the headers of [Chunks.ts](../../packages/island/world/Chunks.ts) and
[Growth.ts](../../packages/island/world/Growth.ts).

Rendering may keep a history-dependent effect (a temporal resolve, exposure adaptation, lighting or
fog accumulated over frames, vegetation that responds to what passes through it, a per-frame physics
simulation) when the effect meets three conditions:

- A scene jump clears its history, as the jump clears every state a scene leaves behind (a cache, a
  history, a size that only grows, a window that follows the camera).
- On a still scene it converges to the same result whatever came before, or the test mode can
  freeze it or turn it off.
- Outside the test mode, its frames are compared within a tolerance
  ([tools/kit/parity/README.md](../../tools/kit/parity/README.md), How a tolerance is set).

Its per-frame update reads the scene clock's step, never the wall clock, so a stepped clip is
reproducible (rule 17 names the three cadences that follow the wall clock's step). The test mode is
a paused page under MSAA, with every history-dependent effect frozen or off, captured once the
page's `settled` signal is true ([Test mode](test-mode.md)). In the test mode, a paused frame is
bit-identical between runs and equals a fresh load's frame, and refactors are checked byte for byte.
The exception is the pixels that the sea's held reflection reaches, which are compared within the
held tolerance (`HELD` in `tools/kit/tolerance.py`). Under the temporal anti-aliasing modes, a
paused page shows its rest image, compared within the tolerance. A new history-dependent
effect follows the
[verifying-rendering-changes binding](../bindings/verifying-rendering-changes.md), History.

**Why:** a save must play on as the original would have; a page after a growth swap must hold the
world a fresh load holds; a headless run must be reproducible byte for byte, so that a change to the
rules shows as a difference in its output; and captures of the paused page are compared byte for
byte.

**Enforced by:** [verify-world-chunks.mjs](../../tools/island/verify-world-chunks.mjs),
[verify-growth-swap.mjs](../../tools/island/verify-growth-swap.mjs),
[verify-scene-jump.mjs](../../tools/island/verify-scene-jump.mjs), the parity captures, and the
code lint's `ponlai/scene-clock`, which refuses the wall clock in code that changes the scene.

**Came from:** a cliff wall's exposure kept state across calls
([Chunks.ts](../../packages/island/world/Chunks.ts)), and a history outlived a scene jump (rule 15).

## Rule 5: Generic generation

The island grows one piece at a time
([game-design.md](../design/game-design.md), How the island grows). So everything placed on it
derives from the land's footprint, the island's SDF and noise fields with fixed seeds: hashes of
position, or random streams seeded per world-anchored cell, never one running stream across many
items. Nothing comes from coordinates placed by hand, and counts follow the measured coast length or
area. Everything the app fits to the land follows the same rule: the views, the camera's limits, the
shore and rain fields, the reflection's box, the walking loop and the game's grid. Generation stays
deterministic whatever the thread count (rule 4).

**Why:** the island the player grows is never the one anyone tuned by hand.

**Enforced by:** review; [verify-world-chunks.mjs](../../tools/island/verify-world-chunks.mjs)
for the determinism.

**Came from:** the shore's stones came from one running random stream along the coast
([Stones.ts](../../packages/island/world/Stones.ts)).

## Rule 6: The game stays headless

The game's rules and its session use neither three.js nor the DOM, and the app layer only hosts
them.

**Why:** the same game runs in the app, in the play tool
([play-game.mjs](../../tools/game/play-game.mjs)) and in the checks, with nothing copied between
them, and an agent can be evaluated offline against what the app would have played.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) (the game's headless entry
point is free of three.js) and [verify-entry-points.mjs](../../tools/repo/verify-entry-points.mjs),
which loads that entry point in Node.js.

**Came from:** none on record.

## Rule 7: Content is registered definitions; the core names none

A need, an item and its uses, a kind of place, an option at a place and a kind of building are each
one definition. Its module in [sim/content/](../../packages/game/sim/content/) registers it once in
[registry.ts](../../packages/game/sim/registry.ts). A definition declares what it offers, its
condition (the `holds` of rule 1, where standing at the place is not enough), its effects and its
numbers. The core reads the definitions by id or in the order registered, and never names one. The
core here is the tick, the five actions, the perception, the systems for needs, items, places and
buildings, the people system, the events, the schemas and the session. The stand-in agent
(`StandInAgent`) plays the content and may name it. The steps for adding content:
[add-game-content.md](../../packages/game/sim/content/README.md).

**Why:** the design adds content as places and items, never as new actions
([game-design.md](../design/game-design.md), Actions).

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs). It registers content of its
own, plays it with no change elsewhere, and fails on a content id written in the core as a string,
a word of a template, a property name or a key.

**Came from:** with content written into the core, each new resource touched the tick, the
perception, the bag rules and the interface.

## Rule 8: Systems talk through events and the state they own

Each system of the game's rules changes only its own part of the state:

- the items system changes what a bag or a store holds (`transfer`, `bring`, `spend`);
- the needs rule changes the needs (an item's use raises one through `raiseNeed`);
- the buildings system changes the sites and the work on them;
- the people system changes what an islander heard and was given.

A rule that needs another system's change calls that system's operation, or emits an event that the
system handles as it is emitted. The people system notices a `said` or a `gave` event (`notice`);
the action does not write the hearer's memory. What a call moved between bags is the items system's
own account of the call, never a comparison of the bags before and after.

**Why:** a rule that writes into another system's state copies that system's rule, and two writers
of one fact drift apart. The dependency it hides breaks under the next rule that changes that state.

**Enforced by:** review.

**Came from:** none on record.

## Rule 9: Presentation by outcome and event category, with a default

The interface, the record and the play tool show what happened by its category: an action's end by
its outcome (done, failed, interrupted, refused, replaced), an event by its kind (landed, said,
gave, placed, built, need and the others). Each category has a default form. A definition may give
its own text, as catalogue keys by its id (`item.<id>`, `need.<id>`, `doing.do.<option>`,
`record.need.<id>`), and its own appearance: a need's icon and colour in
[ui/data/needs.ts](../../packages/game/ui/data/needs.ts), an item's entry in the top row, a
building's model. A new piece of content shows with the defaults until art gives it its own:

- its id as its name;
- the 未绘 glyph for its icon and 缟 for its bar;
- a building's finished site in place of a model;
- the record's default row, for a kind of entry without one;
- a default resource in the top row, for an item without one;
- the play tool's `[event]` line, for an event kind nothing else shows.

Player-facing text stays in the catalogues ([ui/i18n/](../../packages/game/ui/i18n/)).

**Why:** a presentation written per category shows anything the rules can make on the day it is
added, and art then replaces the defaults one at a time.

**Enforced by:** [verify-i18n.mjs](../../tools/game/verify-i18n.mjs) for the text; review for the
rest.

**Came from:** none on record; a presentation written per piece of content would need a change in
every part for every new resource.

## Rule 10: Four layers, one direction

The code has four layers: the render pipeline ([packages/render/](../../packages/render/)), the
island ([packages/island/](../../packages/island/)), the game
([packages/game/](../../packages/game/)) and the app layer ([app/](../../app/)). A file's folder is
its layer. A layer imports only from its own layer and the layers below it. Where a lower layer
needs something an upper one has (the ground's albedo for the bounced light, the land's extent for
the sea, a pass of the island's in the frame), the lower layer declares the interface and the upper
one fills it when the app assembles the layers.

The rule also holds where no import shows the dependency. A lower layer never tells an upper
layer's objects apart by a name. A key a layer names in an object's `userData` is one that the
render pipeline declares ([UserData.ts](../../packages/render/UserData.ts)), or one that its own
layer declares and keeps to itself
([IslandUserData.ts](../../packages/island/world/IslandUserData.ts)).
What the chunk worker and the headless code load is free of three.js, whichever layer it is in. The
tools and the checks are white-box: they may import any layer.

The render pipeline's names hold no proper name of this island: what it shares with a scene is
named for what it is (the dusk window of what glows at night, the sky light lent to the land, the
distance to the scene's path in the growth's input). Ordinary words for an open-air scene stay the
render pipeline's own: the meadow's screen-space shadows, canopy and depth pass, the blade family's
ambient tint (`swardTint`), the debug view's kinds and the grade's bands. The sea's inputs from the
land's shape are named `seaShape`. The debug flags are one open object for every layer, and the
render pipeline's header lists the island's flags with its own.

**Why:** the render pipeline is meant to be usable without this island, and a test scene builds it
alone. A render pipeline that imports the island cannot be built, read or checked without it, and
every change to the island then risks the frame. The worker's files are hashed into the world
cache's key and run in Node.js under the tools, so one import of three.js there fails the build.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs). It reads every import
(static, type-only, re-export, dynamic, a worker's URL). It fails on an import that points upward,
on a package import within the reach of the worker or a headless entry point, and on a `userData`
key that no list declares. It does not see a key reached through an alias of the `userData` object
or by a computed name.

**Came from:** none on record.

## Rule 11: A package is imported through its entry points

The render pipeline, the island and the game are packages. Each offers two entry points, files
that hold only re-exports ([tools/repo/layers.json](../../tools/repo/layers.json),
`entryPoints`):

- the main one, for the app layer: [render/index.ts](../../packages/render/index.ts),
  [island/index.ts](../../packages/island/index.ts), [game/index.ts](../../packages/game/index.ts);
- a headless one, free of three.js, for the chunk worker and Node.js:
  [render/data.ts](../../packages/render/data.ts), [island/land.ts](../../packages/island/land.ts),
  [game/sim/index.ts](../../packages/game/sim/index.ts).

The render pipeline has two more. Its setup entry point
([render/setup.ts](../../packages/render/setup.ts)) holds the settings and the quality tiers, which
the app's first module installs before the render pipeline's other modules read them, and the
look's types and neutral set, which the app picks from. Its browser entry point
([render/browser.ts](../../packages/render/browser.ts), rule 13) holds the browser host. Each entry
point exports only the names another package takes, and each name comes from one entry point.
Another package, or the app layer, imports a package only through them. The modules the app loads
on demand (the debug probes and the game itself) are lazy entry points, imported dynamically, so
they stay in chunks of their own.

An entry point loads its whole package, so a module does nothing as it loads but declare and
register: no `await` and no read of browser globals. A module may still hold state at module level
(uniforms, buffers, tables) and compute constants from the settings as it loads, so that state is
one per process. A page holds one render pipeline at a time, and the parts that would clash say so:
a second light table, or a second install of the shared uniforms, throws while a scene holds them.
A module that holds a scene's state registers, as it loads, the release that puts the state back as
it was when the page loaded ([SceneDispose.ts](../../packages/render/SceneDispose.ts)). A running
scene's `dispose()` runs these releases, so a scene started after it on the same page draws as a
fresh load does.

**Why:** what a package offers is a list that can be read and reviewed, and a change inside a
package cannot break another.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) for the imports and the
lazy entry points ([tools/repo/layers.json](../../tools/repo/layers.json));
[verify-entry-points.mjs](../../tools/repo/verify-entry-points.mjs) for what a module does as it
loads, and it loads the headless and setup entry points in Node.js;
[scenes.mjs](../../tools/render/scenes.mjs) `--rebuild` for a scene started after another's
`dispose()`.

**Came from:** a module that did work as it loaded made the order of the imports part of the
program.

## Rule 12: One place assembles; each state has one owner

Only the app layer builds across packages: [app/main.ts](../../app/main.ts) for the island's page,
[app/scenes/ScenePage.ts](../../app/scenes/ScenePage.ts) for the test scenes. Each package offers
stages: functions that take their layer's object and what they need as arguments, and put what they
build on that object ([RenderStages.ts](../../packages/render/RenderStages.ts),
[IslandStages.ts](../../packages/island/IslandStages.ts): their headers give the stages and their
order). Both pages build through the render pipeline's assembly (`startScene`,
[StartScene.ts](../../packages/render/assemble/StartScene.ts)). The assembly calls the render
pipeline's stages in one fixed order and the app's content in named slots between them; the
island's page calls the island's stages from those slots. The order affects the rendered output
(rule 4), because the order in which materials are first built changes their shader code. A part
reaches another through what it was given or through a registry the other owns (rule 18). A state
that changes has one owner, the only code that writes it; the others read it or call the owner's
operation (rule 8, on the rendering side).

The rule is not yet fully met:

- The scene's shared uniforms ([shared.ts](../../packages/render/shared.ts)) are one module-level
  object that every material imports, instead of a parameter.
- So is the trail's displacement field, which the frame's passes find only when the island made it
  first ([Displacement.ts](../../packages/render/vegetation/Displacement.ts)
  `createDisplacementField`).
- The app layer and the game still set a few fields of the render pipeline's and the island's
  objects directly.
- The debug flags take a write from any layer through one setter that takes the flag's name
  (`setDebugFlag`, which the island calls), a write across layers that the check does not see.

**Why:** a test scene must be able to build the render pipeline with nothing of the island's, which
it cannot while parts find each other through module-level objects; and two writers of one value
hide a dependency that breaks under the next change.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) lists the module-level
objects that another file writes (`STATE`, and `ACROSS` for a writer in another layer); both lists
only shrink. It sees an assignment rooted at the imported object, not a method that mutates it, a
GUI bound to a field or a write to a field of a stage's object.

**Came from:** parts that found each other through module-level objects kept a test scene from
building the render pipeline alone.

## Rule 13: Only the app layer touches browser globals

The render pipeline, the island and the game's rules never reach the URL, the storage, the document
or the window through browser globals. They are given what they need from the browser: the canvas
and the elements they draw into, the settings (rule 14), the storage's values, and the URL that
assets load from. A module that is handed an element reaches that element's document and window
through it, for input, focus and visibility (the frame-rate readout, the island camera's two
controls and its framing).

A few needs have one module each, and no other file may use them:

- a running scene's host in a browser page: the window's size and events, the document's
  visibility, the storage, the loading screen and the globals the tools read
  ([BrowserHost.ts](../../packages/render/assemble/BrowserHost.ts)), behind the render pipeline's
  browser entry point (`render/browser.ts`), which only the app layer imports;
- the frame pacing ([FramePacer.ts](../../packages/render/post/FramePacer.ts));
- the asset fetches ([FetchAsset.ts](../../packages/render/FetchAsset.ts));
- the world's cache in IndexedDB ([WorldCache.ts](../../packages/island/world/WorldCache.ts));
- a canvas used to draw a texture
  ([LeafTexture.ts](../../packages/render/vegetation/LeafTexture.ts));
- the parsing of the URL's query ([Settings.ts](../../packages/render/Settings.ts));
- starting the workers, in the module that names each worker's script, because the build bundles a
  worker only from a literal URL beside it: the chunk workers in
  [WorldChunks.ts](../../packages/island/world/WorldChunks.ts), the shore's in
  [ShoreWaves.ts](../../packages/render/ocean/ShoreWaves.ts).

Decoding an image through an off-screen canvas (`createImageBitmap`, `OffscreenCanvas`) does not
count as a browser global, because a worker has it too. A constant the build provides (whether this
is a development build, the URL assets are served from) does not count either, and may be read
anywhere except in what a headless entry point loads. The game's interface belongs to the app side
and uses browser globals freely; the game's rules do not (rule 6). The game's save is the browser's
storage: the game's headless entry point passes on the save's functions
([save.ts](../../packages/game/save.ts)), which read `localStorage` when called.

**Why:** the same code runs in a worker, in Node.js under the tools and in a test scene, and none of
them has this page. A module that reads the URL decides its behaviour where nobody can pass it
another.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) fails on a browser global
outside the files listed for it (`PAGE_NEEDS`, each with the names it may use). It covers the
render pipeline, the island and the game's rules by their folders, so it does not follow the game's
headless entry point into the save. It does not see browser globals reached through an element's
document or window, through `globalThis`, or by a name off its list (`PAGE`). These routes are in
use: the island asks for idle time through `globalThis.requestIdleCallback` (the growth, the
islanders' ages), the render scale reads `devicePixelRatio`, and the frame's passes read a global
that a tool sets on the page (`__PONLAI_CLIP__`, set by
[capture-clip.mjs](../../tools/kit/parity/capture-clip.mjs)) and snap the exposure's adaptation
while it is set.

**Came from:** none on record.

## Rule 14: Outside settings are checked once, at one entrance

This is rule 3 on the rendering side. Each URL option is declared once, with a name, a type, a
range and a default, in the table of the lowest layer that reads it: the render pipeline's in
[Settings.ts](../../packages/render/Settings.ts), and the island's, the game's and the app's beside
their code, so a new option in an upper layer leaves the render pipeline unchanged. The entry module
merges the tables (a name that two layers declare throws), parses the URL against them and installs
the settings before any module that reads them loads; no other module parses an option. A layer
reads by its own names and those of the layers below it, so a lower layer cannot read an upper
layer's option. The installed settings never change while a page is loaded. How they are read,
what happens where nothing installed them, and what may change on a running page:
[Settings.ts](../../packages/render/Settings.ts), its header.

**Why:** one entrance reports a mistyped option, and the docs' list of the options is generated from
the tables instead of being kept by hand.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) fails on a read of the URL
outside the entrance. [verify-settings.mjs](../../tools/repo/verify-settings.mjs) fails when
[url-options.md](url-options.md) and the tables differ, and when an option's layer is above a layer
that reads it. It sees an option read by its name through the settings' entrance, not one read
through a helper that takes the name as an argument.

**Came from:** fifteen modules each read the URL their own way, a mistyped option was silently
ignored, and the list of options in the docs was kept by hand.

## Rule 15: A scene change is announced once, and whatever depends on it follows

Two changes reach across the layers: the scene is cut or jumps (a seek, a jump of the clock or the
weather, a new scene, the page shown again), and the land grows.

- For a cut or a jump, each layer declares its own reasons
  ([SceneEvents.ts](../../packages/render/post/SceneEvents.ts)). Whatever keeps state from the scene
  registers how that state is cleared in the table of histories
  ([SceneHistory.ts](../../packages/render/post/SceneHistory.ts)). A cut and a jump walk this table
  in the order registered, and the table names none of its entries. A jump clears the render
  pipeline's entries, then the island's, then the render pipeline's lighting, because the jump
  calls the three registration functions in that order
  ([SceneJump.ts](../../packages/render/assemble/SceneJump.ts)); it calls the island's through the
  app's jump content ([app/Scene.ts](../../app/Scene.ts)).
- The land's growth has no such table yet. The growth
  ([Growth.ts](../../packages/island/world/Growth.ts)) takes its followers as the named fields of
  one interface (`GrowthPage`), and only the plant kinds follow it through a registry (rule 18). A
  new follower of the land is a new field there and a line in the island's growth stage.

An ordinary event bus would not do: a swap lands in one frame and never builds a pipeline, and the
order of its followers affects the rendered output (rule 4). A table walked in order keeps both.

**Why:** when the announcer named each dependent, every new one meant a change to the announcer and
to the app layer, and a forgotten one showed only later.

**Enforced by:** [verify-scene-jump.mjs](../../tools/island/verify-scene-jump.mjs) and
[verify-growth-swap.mjs](../../tools/island/verify-growth-swap.mjs) check the result: after a scene
jump or a growth swap, the page draws a fresh load's frame. No check refuses a follower named in the
growth.

**Came from:** a stale shore after a growth swap, and a history that outlived a scene jump.

## Rule 16: Materials describe surfaces; lighting is computed in one place; the look is passed in

A material states what the surface is (its albedo, roughness, normal, what light passes through it,
where it is wet) and names the lighting model that shades it. The lighting model takes the key
light, the shadows, the ambient light, the bounce light, the local lights and the metering from the
render pipeline. No material reads the sun, the sky or the exposure, and none is tuned to make up
for the lighting.

The values chosen for the look, instead of measured or derived (the ambient balance, the sky's
gains, the haze keyframes, the exposure keyframes, the tone curve and the colour grade, by weather
and hour), are the look: typed tables, one per system
([packages/render/look/](../../packages/render/look/)), which the render pipeline is given and
does not own. The render pipeline carries a neutral set
([NeutralLook.ts](../../packages/render/look/NeutralLook.ts): every gain one, every offset zero, no
grade, one exposure keyframe for the whole day), and its own modules hold only physical constants
and the constants of their methods. The island's values are the island's data
([packages/island/look/](../../packages/island/look/)). Every system takes its tables as an argument
where it is created, from the set the app passes to its stages; no module holds a look. Where each
table is created, and the values that do not pass through the look yet:
[Look.ts](../../packages/render/look/Look.ts), its header.

**Why:** a material tuned to make up for the lighting breaks when the lighting changes
([art-direction.md](../design/art-direction.md), How the look is made). A look spread over the sky,
the haze, the exposure and the grade cannot be read, compared or replaced as one thing, and a
second scene needs its own look without editing the render pipeline.

**Enforced by:** [verify-look-params.mjs](../../tools/render/verify-look-params.mjs) checks that
each system holds its own set's values. Whether a value belongs to the look or to physics is a
judgement, left to review. A new material follows
[building-cinematic-stylised-realism](../../skills/building-cinematic-stylised-realism/SKILL.md)
and its [binding](../bindings/building-cinematic-stylised-realism.md#materials).

**Came from:** none on record.

## Rule 17: One convention for distance, light, exposure and time

- Distance is in metres, y up, and the sea's rest level is the water level every module reads.
  Angles are radians in code and degrees where a person types them.
- Light is scene-linear, in the Rec. 709 primaries
  ([ToneSpace.ts](../../packages/render/post/ToneSpace.ts)), in one relative unit: the sun above the
  atmosphere has the illuminance `SUN_ILLUMINANCE`
  ([Atmosphere.ts](../../packages/render/sky/Atmosphere.ts)), and every radiance and irradiance is
  on the same scale, so the sun, the sky and their reflections keep their true ratios. One factor
  (`SCENE_RADIANCE_SCALE`, [Radiometry.ts](../../packages/render/lighting/Radiometry.ts)) brings
  that unit into a half float's range; it is applied where the light enters and undone where the
  exposure reads.
- Albedo is the linear diffuse reflectance of the real material, within the real range
  ([look-values.md](look-values.md), Albedo).
- Exposure is in stops: EV is log2 of the factor that brings scene radiance to the exposed image.
  What a render target stores is the scene's value times a whole power of two (the pre-exposure,
  [PreExposure.ts](../../packages/render/post/PreExposure.ts)): every writer multiplies by it and
  every reader in scene units divides it out. The sky's bakes store at a power of two of their own.
- The metering light a material writes is the luminance a white diffuse surface would show there:
  the luminance of the irradiance over pi
  ([MeterLight.ts](../../packages/render/lighting/MeterLight.ts)).
- Time is the scene clock's, in seconds. The hour of the day is derived from it by one function,
  and a per-frame update reads the clock's step, never the wall clock. Three cadences are the
  exception: the sky's cross-fade between two bakes, the interval between periodic sky bakes and the
  interval between redraws of the refracted sun's map follow the wall clock's step. The frame passes
  that step to the render pipeline's frame stages as well (`environmentDt`,
  [SceneFrame.ts](../../packages/render/assemble/SceneFrame.ts)). These cadences decide when a bake
  or a redraw lands, not what it draws. On a paused page, a sky bake is due only when the clock, the
  weather or the hour changed; the refracted sun's map is drawn exactly once the lighting is at
  rest; and the `settled` signal waits until the cross-fade has ended and nothing is due. A stepped
  clip passes the render pipeline its fixed step as that delta and restarts the two intervals with
  each call, so the clip is reproducible. On a running page, the frame a bake lands in depends on
  the frame rate.

**Why:** otherwise only the person who wrote a value knows its unit.

**Enforced by:** [verify-radiometry.mjs](../../tools/render/verify-radiometry.mjs) checks the
light's scale in a loaded page; the code lint's `ponlai/scene-clock` refuses the wall clock in code
that changes the scene; review for the rest.

**Came from:** each of these was once two conventions that met in a factor nobody could name; the
sky's irradiance readback waited on a wall-clock gate.

## Rule 18: One registered definition adds one thing

The render pipeline is extended at named points. Each is a registry that its owner reads in the
order registered and never by name (rule 7, on the rendering side). Each owner's header gives its
registry's terms:

- a plant kind ([vegetation/Registry.ts](../../packages/render/vegetation/Registry.ts));
- a kind of local light ([LocalLights.ts](../../packages/render/lighting/LocalLights.ts));
- an extra pass of the frame ([ExtraPass.ts](../../packages/render/post/ExtraPass.ts));
- a layer's scene events ([SceneEvents.ts](../../packages/render/post/SceneEvents.ts));
- what a cut or a scene jump clears ([SceneHistory.ts](../../packages/render/post/SceneHistory.ts),
  rule 15);
- the kinds of the debug view ([debug/Classes.ts](../../packages/render/debug/Classes.ts)): a
  closed list owned by the render pipeline; a scene registers rules that pick one of them, not new
  kinds.

A plant kind, a kind of local light and an extra pass each declare three things, or the registry
refuses them ([Extensions.ts](../../packages/render/Extensions.ts)): the quality setting that
governs their cost (`cost`), their test-mode behaviour (`testMode`) and how they follow the land's
growth (`land`). The three are declarations that the registry checks for, not hooks: a follower
named there is still wired by hand (rule 15). What each registration takes:
[Extension points](extension-points.md).

These are not registries: the marks the layers leave for each other in three.js's `userData` (a
declared list, rule 10); a weather (a closed set of names with their presets,
[Weather.ts](../../packages/render/sky/Weather.ts)); a thing placed on the island (each kind of the
world is written into the generator and the growth); the quality table
([Quality.ts](../../packages/render/Quality.ts), one closed table, where a new setting is a new
field). Work a scene does every frame is not registered either: the app calls it between the render
pipeline's frame stages, where its order belongs.

**Why:** a render pipeline that names the island's plants cannot draw another scene.

**Enforced by:** [verify-extensions.mjs](../../tools/render/verify-extensions.mjs) registers
definitions of its own and searches the registries' owners for the names of the island's kinds. It
searches the owners only, not the files that read a registry, and matches a name as a whole word,
so not inside a compound identifier (`grassLod`). Only the types check that a registration's `cost`
is a field of the quality table; nothing checks it at run time.

**Came from:** a new effect that forgot one of the three declarations showed the fault only later:
a capture that was not reproducible, a frame time that crept up, or a page after a growth swap that
differed from a fresh load.

## Rule 19: A source file stays under 1500 lines

A file that passes the limit is split by what its parts are (a table of the look, the kernels of one
effect, the passes of one stage), never by halving. The files over the limit when the rule was
written are listed in the check and may only shrink.

**Why:** no reader, human or model, can hold a longer file whole.

**Enforced by:** [verify-file-size.mjs](../../tools/repo/verify-file-size.mjs) fails on a file
under [packages/](../../packages/) or [app/](../../app/) over the limit and on a listed one that
grew; the tools are not counted.

**Came from:** files had grown past 2000 lines, each holding three or four things that changed for
different reasons.

## Rule 23: three.js internals are used in one place

The render pipeline depends on parts of three.js that are not its public interface: private members
of the renderer and of its helpers, the WebGPU backend and its device, methods it replaces or
wraps, and three.js code it mirrors. Every such use lives in one folder
([packages/render/three/](../../packages/render/three/)), behind functions named for what they do
(`gpuDevice`, `releaseAttribute`, `wrapPipelineCreation`). The rest of the code calls those functions
and never names a private member or the backend. The folder keeps the list of what it depends on
([three-internals.json](../../packages/render/three/three-internals.json)), and three.js is pinned
to one exact version in [package.json](../../package.json). A dependency that no longer holds is an
error that names the entry, both in the check and when the app starts
([Internals.ts](../../packages/render/three/Internals.ts)), never a fallback to another path.

The extension hooks that three.js provides for materials, lighting models, shadows and inspectors
(the `setup...` methods, the builder's context) are its interface, not its internals. They are used
where they are needed, and the list names them so that an upgrade notices when one goes away. The
tools are white-box, and a few still use three.js internals themselves, on a list of their own. An
upgrade of three.js follows [upgrade-three.md](../../packages/render/three/README.md).

**Why:** these dependencies cannot be removed without changing the rendered output, so they are
kept where an upgrade can find them all. A fallback that draws a few pixels differently, or builds
one pipeline more, is found weeks later in a capture; an error at startup is found at once.

**Enforced by:** [verify-three-internals.mjs](../../tools/repo/verify-three-internals.mjs) checks
the pin, checks the list against the installed three.js, and checks that no file outside the folder
uses three.js internals (`TOOLS_KNOWN`, the tools' list, only shrinks).

**Came from:** none on record.
