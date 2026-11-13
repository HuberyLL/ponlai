# Architecture rules

The rules that cut across the layers, in full. [ARCHITECTURE.md](../../ARCHITECTURE.md) states each
in one sentence under the same number; this page gives the rule, why it holds, what enforces it and
the mistake it came from. Where a module owns the detail, the rule links to its header comment
rather than repeating it. Numbers are never reused: 20, 21 and 22 are not in use.

## Rule 1: An action's condition holds every tick

Every timed action declares what it needs to go on: its place still there, still offering the
option, still stood at. The simulation checks that condition in one place before the action
advances. When it fails, the action ends interrupted, with the reason. A late answer from a brain
passes the same entrance as a prompt one. The mechanism:
[actions.ts](../../packages/game/sim/actions.ts), its header.

**Why:** one check sends every way a world can move on under an action into one outcome the
interface can show, while the rules keep changing.

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs) and review.

**Came from:** a precondition checked only when an action began went stale as the world moved on
(the one followed died, a growth turned the coast inland), and such cases multiplied with every
rule.

## Rule 2: What happened is told once, as events

The rule that makes a change emits it, at its tick; whoever shows or keeps it listens. What can be
derived (a time of day from a tick) has one function and is never stored beside its source. The
stream and its listeners: [events.ts](../../packages/game/sim/events.ts) and
[Session.ts](../../packages/game/Session.ts), their headers.

**Why:** reading the state to find what changed loses a change made twice between two looks and
dates it by the look, and two copies of one fact drift apart.

**Enforced by:** review.

**Came from:** none on record.

## Rule 3: Outside input is checked once, at the entrance

Each tool of a brain and each player command has a schema of its arguments, checked before any rule
runs. The rules take their arguments as given. The entrance:
[agent.ts](../../packages/game/sim/agent.ts) `act` and
[schema.ts](../../packages/game/sim/schema.ts).

**Why:** one check keeps the rules short and the refusals uniform.

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs) and review.

**Came from:** rules that each defended against bad data did it differently and missed cases: a
count that was not a number fell back to 1, and a key named `__proto__` broke a copy.

## Rule 4: Determinism and path independence

The simulation, the world and its growth, the weather, the wind and every state integrated over
time (the wind's travel, the fog's time) are functions of the land, the seeds, the scene clock, the
weather and the calls made. They never depend on the path taken, the thread count or the frame
rate. A grown page holds the world a fresh load of its land holds. A scene jump (`establishScene`
in [app/Scene.ts](../../app/Scene.ts)) holds the scene a fresh load of the same query holds. The
world's chunks and the growth's swap keep the rule for generation: see the headers of
[Chunks.ts](../../packages/island/world/Chunks.ts) and
[Growth.ts](../../packages/island/world/Growth.ts).

Rendering may keep a history-dependent effect (a temporal resolve, exposure adaptation, lighting or
fog accumulated over frames, vegetation that responds to what passes through it, a per-frame physics
simulation) when it meets three conditions:

- A scene jump clears its history, as it clears every state a scene leaves behind (a cache, a
  history, a size that only grows, a window that follows the camera).
- On a still scene it converges to the same image whatever came before, or it can be frozen or
  turned off in the test mode.
- Outside the test mode its frames are compared within a tolerance
  ([tools/kit/parity/README.md](../../tools/kit/parity/README.md), How a tolerance is set).

Its per-frame update reads the scene clock's step, never the wall clock, so a stepped clip repeats
(rule 17 names the three cadences that follow the wall clock's step). The test mode is a paused page
under MSAA, with every history-dependent effect frozen or off, shot once the page's `settled` signal
holds ([Test mode](test-mode.md)). There a paused frame repeats exactly and equals a fresh
load's, and refactors are checked byte for byte. Under the temporal modes a paused page shows its
rest image, compared within the tolerance. A new history-dependent effect follows
[check-a-change.md](../how-to/check-a-change.md), Add a history-dependent effect.

**Why:** a save must play on as the original; a grown page must hold the world a fresh load
holds; a headless run must repeat byte for byte, so that a change to the rules shows as a
difference in its output; and captures of the paused page are compared byte for byte.

**Enforced by:** [verify-world-chunks.mjs](../../tools/island/verify-world-chunks.mjs),
[verify-growth-swap.mjs](../../tools/island/verify-growth-swap.mjs),
[verify-scene-jump.mjs](../../tools/island/verify-scene-jump.mjs), the parity captures, and the
code lint's `ponlai/scene-clock`, which refuses the wall clock in code that changes the scene.

**Came from:** a cliff wall's exposure kept state across calls
([Chunks.ts](../../packages/island/world/Chunks.ts)), and a history outlived a jump (rule 15).

## Rule 5: Generic generation

The island grows one piece at a time
([game-design.md](../design/game-design.md), How the island grows). So everything placed on it
derives from the land's footprint, the island's SDF and noise fields with fixed seeds: hashes of
position, or random streams seeded per world-anchored cell, never one running stream across many
items. Nothing comes from coordinates placed by hand, and counts follow the measured coast length or
area. Everything fitted to the land on the page follows the same rule: the views, the camera's
limits, the shore and rain fields, the reflection's box, the walking loop and the game's grid.
Generation stays deterministic whatever the thread count (rule 4).

**Why:** the island the player grows is never the one anyone tuned by hand.

**Enforced by:** review; [verify-world-chunks.mjs](../../tools/island/verify-world-chunks.mjs)
for the determinism.

**Came from:** the shore's stones came from one running stream along the coast
([Stones.ts](../../packages/island/world/Stones.ts)).

## Rule 6: The game stays headless

The game's rules and its session reach neither three.js nor the DOM, and the page only hosts them.

**Why:** the same game runs in the page, in the play tool
([play-game.mjs](../../tools/game/play-game.mjs)) and in the checks, with nothing copied between
them, and a brain can be judged offline against what the page would have played.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) (the game's headless exit
is free of three.js) and [verify-exits.mjs](../../tools/repo/verify-exits.mjs), which loads it in
node.

**Came from:** none on record.

## Rule 7: Content is registered definitions; the core names none

A need, an item and its uses, a kind of place, an option at a place and a kind of building are each
one definition. Its module in [sim/content/](../../packages/game/sim/content/) registers it once in
[registry.ts](../../packages/game/sim/registry.ts). A definition declares what it offers, its
condition (the `holds` of rule 1, where standing at the place is not enough), its effects and its
numbers. The core reads the definitions by id or in the order registered, and never names one: not
the tick, the five actions, the perception, the needs', items', places' and buildings' systems, the
people system, the events, the schemas or the session. The stand-in brain is a player of the content
and may name it. The steps for adding content:
[add-game-content.md](../how-to/add-game-content.md).

**Why:** the design adds content as places and items, never as new actions
([game-design.md](../design/game-design.md), Actions).

**Enforced by:** [verify-game.mjs](../../tools/game/verify-game.mjs): it registers content of its
own, plays it with no change elsewhere, and fails on a content id written in the core as a string,
a word of a template, a property's name or a key.

**Came from:** with content written into the core, each new resource touched the tick, the
perception, the bag rules and the interface.

## Rule 8: Systems talk through events and the state they own

Each system of the game's rules changes only its own part of the state:

- the items system what a bag or a store holds (`transfer`, `bring`, `spend`);
- the needs' rule the needs (an item's use raises one through `raiseNeed`);
- the buildings system the sites and the work on them;
- the people system what an islander heard and was given.

A rule that needs another system's change calls that system's operation, or emits an event that the
system takes as it is emitted. A `said` or a `gave` is noticed by the people system (`notice`); the
action does not write the hearer's memory. What a call moved between bags is the items system's own
account of the call, never a comparison of the bags before and after.

**Why:** a rule that writes into another system's state copies that system's rule, and two
writers of one fact drift apart. The dependency it hides breaks under the next rule that changes
that state.

**Enforced by:** review.

**Came from:** none on record.

## Rule 9: Presentation by outcome and event category, with a default

The interface, the record and the play tool show what happened by its category: an action's end by
its outcome (done, failed, interrupted, refused, replaced), an event by its kind (landed, said,
gave, placed, built, need and the others). Each category has a default form. A definition may give
its own words, as catalogue keys by its id (`item.<id>`, `need.<id>`, `doing.do.<option>`,
`record.need.<id>`), and its own look: a need's icon and colour in
[ui/data/needs.ts](../../packages/game/ui/data/needs.ts), an item's row in the top row, a building's
model. A new piece of content shows with the defaults until art gives it its own:

- its id as its name;
- the 未绘 glyph for its icon and 缟 for its bar;
- a building's finished site in place of a model;
- the record's default row, for a kind of entry without one;
- a default resource in the top row, for an item without one;
- the play tool's `[event]` line, for an event kind nothing else shows.

Player-facing words stay in the catalogues ([ui/i18n/](../../packages/game/ui/i18n/)).

**Why:** a presentation written per category shows anything the rules can make on the day it is
added, and art then replaces the defaults one at a time.

**Enforced by:** [verify-i18n.mjs](../../tools/game/verify-i18n.mjs) for the words; review for
the rest.

**Came from:** none on record; a presentation written per piece of content would need a change in
every part for every new resource.

## Rule 10: Four layers, one direction

The code is four layers: the renderer ([packages/render/](../../packages/render/)), the island
([packages/island/](../../packages/island/)), the game ([packages/game/](../../packages/game/)) and
the page ([app/](../../app/)). A file's folder is its layer. A layer imports only from its own layer
and the layers below it. Where a lower layer needs something an upper one has (the ground's albedo
for the bounced light, the land's extent for the sea, a pass of the island's in the frame), the
lower layer declares the interface and the upper one fills it when the page is assembled.

The rule holds for what no import shows too. A lower layer never tells an upper layer's things apart
by a name. A key a layer names in an object's `userData` is one the renderer declares
([UserData.ts](../../packages/render/UserData.ts)) or one its own layer declares it keeps to itself
([IslandUserData.ts](../../packages/island/world/IslandUserData.ts)). What the chunk worker and the
headless code load is free of three.js, whichever layer it is in. The tools and the checks are
white-box: they may import any layer.

The renderer still carries this island's words as names: in the look's types (the yunpeng's dusk
window and night share, the island's sky rows), in the shared uniforms (the sward's tint, the
island's irradiance source, the leaves' gain), as the name of its own techniques, passes and look
table (`meadow`), in the debug flags, in the closed list of the debug view's kinds (rule 18), in the
meadow's `userData` marks and in the walk's distance in the growth's input. It tells the island's
things apart by these names in two places only: the lighting model multiplies the blade family's
ambient light by the sward's tint, and the profiler's labels take the page's parts by name and wrap
the islanders' update.

**Why:** the renderer is to be usable without this island, and a test scene builds it alone. A
renderer that imports the island cannot be built, read or checked without it, and every change to
the island then risks the frame. The worker's files are hashed into the world cache's key and run
in node under the tools, so one import of three.js there fails the build.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs). It reads every import
(static, type-only, re-export, dynamic, a worker's URL), fails on one that points upward, fails on
a package import within the worker's or a headless exit's reach, and fails on a `userData` key no
list declares. It does not see a key reached through an alias of the bag or by a computed name.

**Came from:** none on record.

## Rule 11: A package is imported through its exits

The renderer, the island and the game are packages, and each offers two exits, files of re-exports
only:

- one for the page: [render/index.ts](../../packages/render/index.ts),
  [island/index.ts](../../packages/island/index.ts), [game/index.ts](../../packages/game/index.ts);
- a headless one, free of three.js, for the chunk worker and node:
  [render/data.ts](../../packages/render/data.ts), [island/land.ts](../../packages/island/land.ts),
  [game/sim/index.ts](../../packages/game/sim/index.ts).

The renderer has a third, its setup exit ([render/setup.ts](../../packages/render/setup.ts)): the
settings and the quality tiers, which the page's first module installs before the renderer's other
modules read them, and the look's types and neutral set, which the page picks from. Each exit
exports only the names another package takes, each name from one exit. Another package, or the page,
imports a package only through them. The modules the page loads on demand (the debug probes and the
game itself) are lazy exits, imported dynamically, so they stay in chunks of their own.

An exit loads its whole package, so a module does nothing as it loads but declare and register: no
`await` and no read of the page. A module may still hold state at module level (uniforms, buffers,
tables) and compute constants from the settings as it loads, so that state is one per process: a
page holds one renderer, and the parts that would clash say so (a second light table and a second
install of the shared uniforms throw).

**Why:** what a package offers is a list that can be read and reviewed, and a change inside a
package cannot break another.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) for the imports and the
lazy exits ([tools/repo/layers.json](../../tools/repo/layers.json));
[verify-exits.mjs](../../tools/repo/verify-exits.mjs) for what a module does as it loads, and it
loads the headless and setup exits in node.

**Came from:** a module that worked as it loaded made the order of the imports part of the
program.

## Rule 12: One place assembles; each state has one owner

Only the page builds across packages: [app/main.ts](../../app/main.ts) for the island's page,
[app/scenes/ScenePage.ts](../../app/scenes/ScenePage.ts) for the test scenes. Each package offers
stages, functions that take its layer's object and what they need as arguments and put what they
build on that object ([RenderStages.ts](../../packages/render/RenderStages.ts),
[IslandStages.ts](../../packages/island/IslandStages.ts): their headers give the stages and their
order). The page calls the stages in one fixed order, which is part of the image (rule 4), because
the order materials first build in changes their code. A part reaches another through what it was
given or through a registry the other owns (rule 18). A state that changes has one owner, the only
one that writes it; the others read it or call the owner's operation (rule 8, on the rendering
side).

The rule is not yet whole:

- The scene's shared uniforms ([shared.ts](../../packages/render/shared.ts)) are one module-level
  object that every material imports rather than a parameter.
- So is the trail's displacement field, which the frame's passes find only when the island made it
  first ([Displacement.ts](../../packages/render/vegetation/Displacement.ts)
  `createDisplacementField`).
- The page and the game still set a few fields of the renderer's and the island's objects directly.
- The debug flags take a write from any layer through one setter that takes the flag's name
  (`setDebugFlag`, which the island calls), a write across layers the check does not see.

**Why:** a test scene must be able to build the renderer with nothing of the island's, which it
cannot while parts find each other through module-level objects; and two writers of one value
hide a dependency that breaks under the next change.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) lists the module-level
objects that another file writes (`STATE`, and `ACROSS` for a writer in another layer); both lists
only shrink. It sees an assignment rooted at the imported object, not a method that mutates it, a
GUI bound to a field or a write to a field of a stage's object.

**Came from:** parts that found each other through module-level objects kept a test scene from
building the renderer alone.

## Rule 13: Only the page touches the browser's page

The renderer, the island and the game's rules never reach the address, the storage, the document or
the window through the page's globals. What they need of the browser they are given: the canvas and
the elements they draw into, the settings (rule 14), the storage's values, the address assets load
from. A module handed an element reaches that element's document and window through it, for input,
focus and visibility (the frame-rate readout, the island camera's two controls and its framing).

A few needs have one module each, and no other file may use them:

- the frame's pacing ([FramePacer.ts](../../packages/render/post/FramePacer.ts));
- the asset fetches ([FetchAsset.ts](../../packages/render/FetchAsset.ts));
- the world's cache in IndexedDB ([WorldCache.ts](../../packages/island/world/WorldCache.ts));
- a canvas used to draw a texture ([LeafTexture.ts](../../packages/render/vegetation/LeafTexture.ts));
- the parsing of the address's query ([Settings.ts](../../packages/render/Settings.ts));
- the workers' start, in the module that names each worker's script, because the build bundles a
  worker only from a literal URL beside it: the chunk workers in
  [WorldChunks.ts](../../packages/island/world/WorldChunks.ts), the shore's in
  [ShoreWaves.ts](../../packages/render/ocean/ShoreWaves.ts).

Decoding an image through an off-screen canvas (`createImageBitmap`, `OffscreenCanvas`) is not the
page, as a worker has it too. A constant the build provides (whether this is a development build,
the address assets are served from) is not the page and may be read anywhere but in what a headless
exit loads. The game's interface is the page's and uses it freely; the game's rules do not
(rule 6). The game's save is the page's storage: the game's headless exit passes on the save's
functions ([save.ts](../../packages/game/save.ts)), which read `localStorage` when called.

**Why:** the same code runs in a worker, in node under the tools and in a test scene, and none of
them has this page. A module that reads the address decides its behaviour where nobody can pass
it another.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) fails on a page global
outside the files listed for it (`PAGE_NEEDS`, each with the names it may use). It covers the
renderer, the island and the game's rules by their folders, so it does not follow the game's
headless exit into the save. It does not see the page reached through an element's document or
window, through `globalThis`, or by a name off its list (`PAGE`). These routes are in use: the
island asks for idle time through `globalThis.requestIdleCallback` (the growth, the islanders'
ages), the render scale reads `devicePixelRatio`, and the frame's passes read a global a tool sets
on the page (`__PONLAI_CLIP__`, set by
[capture-clip.mjs](../../tools/kit/parity/capture-clip.mjs)) and snap the exposure's adaptation
while it is there.

**Came from:** none on record.

## Rule 14: Outside settings are checked once, at one entrance

This is rule 3 on the rendering side. The address's options are declared once, in one schema
([Settings.ts](../../packages/render/Settings.ts)): a name, a type, a range, a default and the layer
that owns it. That schema is a renderer file and declares the island's, the game's and the page's
options too, so an upper layer's new option is an edit to the renderer. The entry parses the address
through that schema and installs the settings before any module that reads them loads; no other
module parses an option. The installed settings never change on a page. How they are read, where
nothing installed them and what may change on a running page:
[Settings.ts](../../packages/render/Settings.ts), its header.

**Why:** one entrance reports a mistyped option, and the docs' list of the options is written from
the schema rather than kept by hand.

**Enforced by:** [verify-layers.mjs](../../tools/repo/verify-layers.mjs) fails on an address read
outside the entrance. [verify-settings.mjs](../../tools/repo/verify-settings.mjs) fails when
[url-options.md](url-options.md) and the schema differ, and when an option's layer is above a
layer that reads it. It sees an option read by its name through the settings' entrance, not one
read through a helper that takes the name as an argument.

**Came from:** fifteen modules each read the address their own way, a mistyped option was
silently ignored, and the list of options in the docs was kept by hand.

## Rule 15: A change of the scene is announced once, and whoever keeps something of it follows

Two changes reach across the layers: the scene is cut or jumps (a seek, a jump of the clock or the
weather, a new scene, the page shown again), and the land grows.

- For a cut or a jump, each layer declares its own reasons
  ([SceneEvents.ts](../../packages/render/post/SceneEvents.ts)). Whatever keeps something of the
  scene registers how it is cleared in the table of histories
  ([SceneHistory.ts](../../packages/render/post/SceneHistory.ts)), which a cut and a jump walk in
  the order registered and which names none of them. A jump clears the renderer's entries, then the
  island's, then the renderer's light, because the page calls the three registration functions in
  that order ([app/Scene.ts](../../app/Scene.ts)).
- The land's growth has no such table yet. The growth
  ([Growth.ts](../../packages/island/world/Growth.ts)) takes its followers as the named fields of one
  interface (`GrowthPage`), and only the plant kinds follow it through a registry (rule 18). A new
  follower of the land is a new field there and a line in the island's growth stage.

An ordinary event bus would not do: a swap lands in one frame, never builds a pipeline, and the
order of its followers is part of the image (rule 4), which a table walked in order keeps.

**Why:** a dependent named in the announcer meant a change to the announcer and to the page for
each new one, and a forgotten one showed only later.

**Enforced by:** [verify-scene-jump.mjs](../../tools/island/verify-scene-jump.mjs) and
[verify-growth-swap.mjs](../../tools/island/verify-growth-swap.mjs) check the result (a jumped or
grown page draws a fresh load's frame). No check refuses a follower named in the growth.

**Came from:** a stale shore on a grown page, and a history that outlived a jump.

## Rule 16: Materials give surfaces; the light is computed in one place; the look is passed in

A material states what the surface is (its albedo, roughness, normal, what light passes through it,
where it is wet) and names the lighting model that shades it. The model takes the key, the shadows,
the ambient light, the bounce, the local lights and the metering from the renderer. No material
reads the sun, the sky or the exposure, and none is tuned to make up for the light.

The numbers chosen for the look rather than measured or derived (the ambient balance, the sky's
gains, the haze's keys, the exposure's keys, the tone curve and the grade, by weather and hour) are
the look: typed tables, one per system ([packages/render/look/](../../packages/render/look/)), which
the renderer is given and does not own. The renderer carries a neutral set
([NeutralLook.ts](../../packages/render/look/NeutralLook.ts): every gain one, every offset zero, no
grade, one exposure key for the whole day), and its own modules hold only physical constants and
the constants of their methods. The island's numbers are the island's data
([packages/island/look/](../../packages/island/look/)). Every system takes its tables as an argument
where it is created, from the set the page hands its stages; no module holds a look. Where each
table is created, and the numbers that do not pass through the look yet:
[Look.ts](../../packages/render/look/Look.ts), its header.

**Why:** a material tuned to make up for the light breaks when the light changes
([art-direction.md](../design/art-direction.md), How the look is made). A look spread over
the sky, the haze, the exposure and the grade cannot be read, compared or replaced as one thing,
and a second scene needs its own without editing the renderer.

**Enforced by:** [verify-look-params.mjs](../../tools/render/verify-look-params.mjs) checks that
each system holds its own set's numbers. Whether a number is the look's or physics' is a
judgement, left to review. A new material follows
[add-material.md](../how-to/add-material.md).

**Came from:** none on record.

## Rule 17: One convention for distance, light, exposure and time

- Distance is in metres, y up, and the sea's rest level is the water level every module reads.
  Angles are radians in code and degrees where a person types them.
- Light is scene-linear, in the Rec. 709 primaries
  ([ToneSpace.ts](../../packages/render/post/ToneSpace.ts)), in one relative unit: the sun above the
  atmosphere has the illuminance `SUN_ILLUMINANCE`
  ([Atmosphere.ts](../../packages/render/sky/Atmosphere.ts)), and every radiance and irradiance is in
  the same scale, so the sun, the sky and their reflections keep their true ratios. One factor
  (`SCENE_RADIANCE_SCALE`, [Radiometry.ts](../../packages/render/lighting/Radiometry.ts)) brings
  that unit into a half float's range; it is applied where the light enters and undone where the
  exposure reads.
- Albedo is the linear diffuse reflectance of the real thing, within the real range
  ([look-values.md](look-values.md), Albedo).
- Exposure is in stops: EV is log2 of the factor that brings scene radiance to the exposed image.
  What a target stores is the scene's value times a whole power of two (the pre-exposure,
  [PreExposure.ts](../../packages/render/post/PreExposure.ts)), which every writer multiplies by and
  every reader in scene units divides out; the sky's bakes store at a power of two of their own.
- The metering light a material writes is the luminance a white diffuse surface would show there:
  the luminance of the irradiance over pi ([MeterLight.ts](../../packages/render/lighting/MeterLight.ts)).
- Time is the scene clock's, in seconds. The hour of the day is derived from it by one function, and
  a per-frame update reads the clock's step, never the wall clock. Three cadences are the exception:
  the sky's cross-fade between two bakes, the interval between periodic sky bakes and the interval
  between redraws of the refracted sun's map follow the wall clock's step, which the page hands the
  renderer's frame stages as well (`environmentDt`, [app/Frame.ts](../../app/Frame.ts)). They decide
  when a bake or a redraw lands, not what it draws: on a paused page a sky bake is due only when the
  clock, the weather or the hour changed, the refracted sun's map is drawn exactly once the light
  rests, and the settled signal waits until the cross-fade has ended and nothing is due. A stepped
  clip hands the renderer its fixed step as that delta and restarts the two intervals with each
  call, so it repeats; on a running page the frame a bake lands in depends on the frame rate.

**Why:** a value's unit is otherwise known only to whoever wrote it.

**Enforced by:** [verify-radiometry.mjs](../../tools/render/verify-radiometry.mjs) checks the
light's scale on the page; the code lint's `ponlai/scene-clock` refuses the wall clock in code that
changes the scene; review for the rest.

**Came from:** each of these was once two conventions that met in a factor nobody could name; the
sky's irradiance read-back waited on a wall-clock gate.

## Rule 18: One registered definition adds one thing

The renderer is extended at named points, each a registry its owner reads in the order registered
and never by name (rule 7, on the rendering side). Each owner's header gives its registry's terms:

- a plant kind ([vegetation/Registry.ts](../../packages/render/vegetation/Registry.ts));
- a kind of local light ([LocalLights.ts](../../packages/render/lighting/LocalLights.ts));
- an extra pass of the frame ([ExtraPass.ts](../../packages/render/post/ExtraPass.ts));
- a layer's scene events ([SceneEvents.ts](../../packages/render/post/SceneEvents.ts));
- what a cut or a scene jump clears ([SceneHistory.ts](../../packages/render/post/SceneHistory.ts),
  rule 15);
- the kinds of the debug view ([debug/Classes.ts](../../packages/render/debug/Classes.ts)): a
  closed list of the renderer's, and a scene registers rules that pick one of them, not kinds.

A plant kind, a kind of light and an extra pass each state three things, or the registry refuses
them ([Extensions.ts](../../packages/render/Extensions.ts)): the quality knob that governs their
cost, how they stand in the test mode, and how they follow the land's growth. The three are
statements the registry checks for, not hooks: a follower named there is still wired by hand
(rule 15). What each registration takes: [Extension points](extension-points.md).

These are not registries: the marks the layers leave for each other in three's `userData` (a
declared list, rule 10); a weather (a closed set of names with their presets,
[Weather.ts](../../packages/render/sky/Weather.ts)); a thing placed on the island (each kind of the
world is written into the generator and the growth); the quality table
([Quality.ts](../../packages/render/Quality.ts), one closed table, where a new knob is a new
field). Work a scene does every frame is not registered either: its page calls it between the
renderer's frame stages, where its order belongs.

**Why:** a renderer that names the island's plants cannot draw another scene.

**Enforced by:** [verify-extensions.mjs](../../tools/render/verify-extensions.mjs) registers
definitions of its own and searches the registries' owners for the names of the island's. It
searches the owners only, not the files that read a registry, and matches a name as a whole word,
so not inside a compound identifier (`grassLod`). A registration's `cost` is checked as a quality
table field by the types alone, not when the page runs.

**Came from:** a new effect that forgot one of the three declarations showed only later, as a
capture that did not repeat, a frame time that crept or a grown page that differed from a fresh
load.

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

## Rule 23: three's internals are reached in one place

The renderer depends on parts of three.js that are not its public interface: private members of the
renderer and of its helpers, the WebGPU backend and its device, methods it replaces or wraps, and
code of three's it mirrors. Every such reach lives in one folder
([packages/render/three/](../../packages/render/three/)), behind functions named for what they do
(`gpuDevice`, `releaseAttribute`, `environmentSteps`). The rest of the code calls those and never
names a private member or the backend. The folder keeps the list of what it depends on
([three-internals.json](../../packages/render/three/three-internals.json)), and three is pinned to
one exact version in [package.json](../../package.json). A dependency that no longer holds is an
error that names the entry, at the check and when the page starts
([Internals.ts](../../packages/render/three/Internals.ts)), never a fallback to another path.

The extension hooks three leaves for materials, lighting models, shadows and inspectors (the
`setup...` methods, the builder's context) are its interface, not its internals: they are used where
they are needed, and the list names them so that an upgrade sees one go. The tools are white-box,
and a few still reach in themselves, on a list of their own. An upgrade of three follows
[upgrade-three.md](../how-to/upgrade-three.md).

**Why:** the reaches cannot be removed without changing the image, so they are kept where an
upgrade can find them all. A fallback that draws a few pixels differently, or builds a pipeline
more, is found weeks later in a capture; an error at start-up is found at once.

**Enforced by:** [verify-three-internals.mjs](../../tools/repo/verify-three-internals.mjs) checks
the pin, the list against the installed three, and that no file outside the folder reaches in
(`TOOLS_KNOWN`, the tools' list, only shrinks).

**Came from:** none on record.
