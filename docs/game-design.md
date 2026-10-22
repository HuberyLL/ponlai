# Ponlai: game design

The living design document for the game. It records what the game is and the decisions behind it,
not how the code does it (that is in the modules' header comments; `AGENTS.md` has the map). Keep
it short; change it when a decision changes.

## The game in one sentence

You lead the people of a small island: you plan its layout and build it, and you direct its
islanders in plain language. Under the pressure of scarce food, scarce fresh water and rough
weather, a few people on a small island grow into a larger island with more people, which is
ever harder to lead.

## Why it should be fun

- **You talk to people, you do not press buttons.** Orders are given in natural language to
  islanders driven by a language model. They understand, misunderstand, agree, argue and suggest;
  how you speak to them is part of the play.
- **You decide the layout.** Planning where things go is the heart of a management game
  (Frostpunk, Banished, Islanders). The islanders build what you plan; they do not plan the town,
  which they would do chaotically.
- **The pressure is plain.** Hunger, thirst and storms need no explanation, and the sea, the sky
  and the weather the player watches are the same ones that threaten the island.

This is not an "AI town" to watch: the player acts all the time, and the islanders answer to them.

## The player

- The player is the island's leader, like the Captain in Frostpunk. The islanders know the
  player exists and speak to them directly.
- The player never controls an islander's body. They give orders and directions; the islanders
  carry them out in their own way.
- The player plans and places buildings and the layout.

## The islanders

- Each islander is a person with a character, a memory and their own judgement.
- They can trust the leader, push back ("not now, the storm is coming"), ask, or propose a better
  way. Their attitude to the leader follows from what happened when they followed past orders; it
  is held in their memory rather than in a morale number.
- They act through a few primitive actions of the body (the way a computer-using agent has a
  browser, not a "search Twitter" tool); every task, from fetching water to building a hut, is
  composed from those. What using a thing does is defined by the thing, so new content adds
  things to the world, not new actions.

## Pressure

1. **Food**: the island holds little food, and more people need more.
2. **Fresh water**: the sea is all around but cannot be drunk.
3. **Weather**: storms, long rain and fog have to be prepared for; the existing weather system is
   the source of this pressure.

Without pressure, orders and layout would not matter. Every core system must feed one of these
or the island's growth.

## Layout matters

The layout must change outcomes, not just look good: distances set how long work takes, where a
building stands decides how it fares in a storm, and what stands next to what can help or hinder.
The player should want to rebuild after watching their islanders walk the long way every day.

## The long arc

- Start: a few islanders on a small island.
- Growth: the island grows piece by piece (the world is generated to grow) and more people arrive.
- The challenge grows with it: with three people the leader can talk to each one; with thirty
  they cannot, and must delegate (put someone in charge of fishing, have someone lead the roof
  repairs). Leadership structure grows out of play rather than from a rule system.

## How the island grows

- **Trigger**: population. Each time the island reaches the next population step, it grows by
  one piece of land. No story has to justify it.
- **How much**: the island starts at about 400 m^2 (a little larger than today's) and a piece
  adds about 180 m^2 on average (from about 100 to 270 m^2), for at most 36 steps, by which
  the island has grown to about 7,500 m^2.
- **Where**: chosen at random, but from the centre outward: each new piece joins the island's
  current edge near its middle, so the island grows all round rather than stretching one way,
  and the player can plan around it. The shape must stay irregular and natural, like a real
  island: never drifting toward a square or a circle.
- **Known in advance**: the next piece is decided (and generated) ahead of time. The sea floor
  there rises gradually as the population approaches the step, so the water turns shallower and
  brighter and the player can see where land will come and plan for it.
- **How it appears**: the new piece rises out of the sea, water running off its rock, with spray
  and mist around it; the old coast it meets turns into inland ground under that cover.
- **Incremental, never regenerated**: the world is built in chunks, and everything on the land
  (rock, cliffs, soil, turf, the grass and flowers, the rim's hanging growth) and the sea floor
  belongs to a chunk. What a chunk holds depends only on the land within a fixed distance of it,
  so a new piece rebuilds only itself and its neighbours; everything else stays exactly as it
  was. The sea floor near the island follows the coast locally in the same way.
- **As built** (the trigger, against the instant swap; the rise is not built): the population is
  the islanders' count, and the steps are a table (`GROWTH_STEPS` in `src/game/sim/types.ts`),
  for now one piece per 2 islanders above the starting 3 (a piece at 5, 7, 9, ... up to the 36th
  step). Once a step is due the game asks the page to grow, and the next piece swaps in at once;
  the simulation's ground opens the new cells (every index and path stays valid) and counts the
  piece. The pending piece is generated from the moment the game shows, and its cells are given
  to the simulation ahead (`comingLand`) for planning. A save keeps the piece count, and a resumed
  game loads its world at it. How a new islander arrives is not designed: the debug panel adds
  one by hand.
- The trees and shrubs on today's island were placeholders for its look; plants that matter to
  play are content placed in the world, not part of the terrain.

## Time and thinking

- The world never stops while an islander thinks. A model call takes seconds; meanwhile the
  islander keeps walking, working or idling, as people think while doing other things.
- So orders are directions ("get the storehouse up today"), not moment-to-moment control, and
  islanders need quick reactions of their own between thoughts (fast and slow thinking, System 1
  and System 2). How that split works is designed together with the language model.

## Actions and perception

### Actions

An islander acts through five primitive actions. They never change: new content adds places and
items with their own options, never a new action.

| Kind | Action | Its options come from |
|---|---|---|
| The body's own | `go( place )`, `say( words )`, `wait( time )` | fixed, available anywhere |
| A place's | `do( action )` | the place the islander stands at |
| An item's | `use( item )` | the item, carried in the bag |

- `go` names a place, never a point or a distance: finding the way and walking it is the body's
  job, not the mind's.
- `do` runs one of the actions the islander's current place offers (fish at the shore, put
  in or take out at the chest, build at a construction site). Fishing is an option of a place,
  not a verb of the islander.
- `use` uses an item the islander carries (eat a fish).
- A new action replaces the one under way; stopping is not an action. `say` is the exception:
  speech comes from the mind, like thinking, so the islander talks while the body goes on.
- People (giving, following, talking among islanders) are decided when there is more than one
  islander.

### Building

- The player plans, the islanders build. A building the player places is a blueprint: a
  construction site, a place whose only option is `build`. Building takes a while and can be
  interrupted and resumed; the work done stays. When the work is done the site is the finished
  building with its own options (the chest's put and take).
- The player may place any number of a kind. Each building is a place with an id of its own,
  its kind's name and a count (chest1, chest2), never reused, so the islanders and the saves name
  it the same for good. Perception names each place by its id and kind.
- Several islanders may build one site, each adding their work; when it is done, everyone on it
  stops, the one who finished it and the others who find it finished.
- Every kind goes through the same stages, shaped by its footprint: planned (marked out), being
  built, built. The site blocks walking from the moment it is placed. Perception shows how far
  along it is as a number, like every state that decides outcomes.
- No materials yet: building costs time only, until something on the island gives wood or stone.

### Items

- Each islander carries a small bag (a few items; items of a kind stack). What is picked or
  caught goes into the bag; a full bag refuses it.
- A chest is a place that holds more; the islander puts in and takes out there.

### Needs

Satiety and hydration, 0 to 100, fall with time and rise when the islander eats or drinks. They
are rules and numbers, like everything that decides outcomes (capacities, counts, how long an
action takes, the chance of a catch, walking speed). What the islander knows and believes is not:
distances, routes, how far or hard something is.

Thirst is off for now: hydration holds where it starts, because nothing on the island gives water
until the island has a water source of its own. The HUD still shows it.

### Perception

An islander perceives what a person would, not the world's state:

- **seen**: the places and things in sight, and what shows on them (a site's progress, a chest's contents while at it), with no
  positions or distances;
- **at hand**: the place they stand at, and so which `do` options are open;
- **the body**: satiety, hydration and the bag's contents, as numbers;
- **the time**: the day and the time of day.

Memory (what they saw last, what happened when they acted), hearing the leader, and what starts a
thought are designed with the language model. As built, the player's words wait for each listener's
next thought, and a brain that hears is asked for one as they are said; the stand-in does not hear.

## Not now

- Laws, decrees and other modifiers (Frostpunk's Book of Laws): later, as buffs, if at all.
- Morale or hope meters.
- Any system that does not serve the pressures, the layout or the island's growth.

## Next

- The first prototype: one islander on the small island, with food (water waits for a water
  source of the island's own: thirst is off until then).
  - **Places**: the shore (fish: takes a while, a fish by chance) and a chest the player places
    by hand.
  - **Items**: fish (eat: satiety).
  - **Needs** fall to zero with no consequence yet; hydration holds.
  - **A stand-in brain** of plain rules thinks for the islander until the language model is
    connected; no weather and no talking yet.
- After it, the prototype that tests whether talking to the islanders is fun: three islanders,
  food and water, one storm, a few buildings to place, orders in natural language. If ten minutes
  of it are fun, build on it; if not, change course while it is cheap.

## Open questions

- How a storm is announced and how much warning the player gets.
- The population steps at which the island grows, and whether a piece's size should grow with the population.
- How a new islander arrives.
