# Game design

What the game (the page at `/`) is, the decisions behind it, and what to avoid. Read this page before
gameplay work; change it when a decision changes. Nothing is built ahead of it. How the code carries
a decision out is in the header comment of the module that owns it; where the code lives is in
[Architecture](../../ARCHITECTURE.md#code-map). What the player sees on screen is in
[Game UI](ui.md).

Contents:

- [The game in one sentence](#the-game-in-one-sentence)
- [Why it should be fun](#why-it-should-be-fun)
- [The player](#the-player)
- [The islanders](#the-islanders)
- [Pressure](#pressure)
- [Layout matters](#layout-matters)
- [The long arc](#the-long-arc)
- [How the island grows](#how-the-island-grows)
- [Time and thinking](#time-and-thinking)
- [Actions and perception](#actions-and-perception): actions, people, building, items, rules and
  beliefs, needs, perception
- [Not now](#not-now)
- [Open questions](#open-questions)

## The game in one sentence

You lead the people of a small island: you plan its layout and build it, and you direct its
islanders in plain language. Under the pressure of scarce food, scarce fresh water and rough
weather, a few people on a small island grow into a larger island with more people, which is ever
harder to lead.

## Why it should be fun

- **You talk to people, you do not press buttons.** Orders are given in natural language to
  islanders driven by a language model. They understand, misunderstand, agree, argue and suggest;
  how you speak to them is part of the play.
- **You decide the layout.** Planning where things go is the heart of a management game
  (Frostpunk, Banished, Islanders). The player plans and places the buildings and the layout. The
  islanders build what the player plans; they do not plan the town, which they would do chaotically.
- **The pressure is plain.** Hunger, thirst and storms need no explanation, and the sea, the sky
  and the weather the player watches are the same ones that threaten the island.
- **Not an "AI town" to watch.** The player acts all the time, and the islanders answer to them.

## The player

- The player is the island's leader, like the Captain in Frostpunk. The islanders know the player
  exists and speak to them directly.
- The player never controls an islander's body. They give orders and directions, and the islanders
  carry them out in their own way, since talking to people is the play (above).

## The islanders

- Each islander is a person with a character, a memory and their own judgement, so that how the
  player speaks to them matters.
- They can trust the leader, push back ("not now, the storm is coming"), ask, or propose a better
  way. Their attitude to the leader follows from what happened when they followed past orders. It
  is held in their memory, never in a morale number.
- They act through five primitive actions of the body ([Actions](#actions)).
- They live a life, and a game day is a year of it. A body is a man's or a woman's at its age, from
  a child of two to the stooped old (`packages/island/characters/Ages.ts`), and it changes smoothly
  as it ages, walking slower as a child and when old.
- Each islander dies of old age at a lifespan drawn once, when they arrive, the way lifespans are
  distributed in a present-day population with accidents left out: the life the body was born with
  (`packages/game/sim/life.ts`). The island's record notes the death.
- A game starts with three grown islanders: a man, a woman and one of either, 20 to 35 years old.
- They live among each other: they hear what is said near them, hand each other things and follow
  one another ([People](#people)).

## Pressure

1. **Food**: the island holds little food, and more people need more.
2. **Fresh water**: the sea is all around but cannot be drunk.
3. **Weather**: storms, long rain and fog have to be prepared for. The weather that the scene
   already simulates is the source of this pressure.

Without pressure, orders and layout would not matter. So every core system feeds one of these
pressures or the island's growth; a system that feeds none is left out ([Not now](#not-now)).

## Layout matters

The layout changes outcomes, not just the look. Distances set how long work takes, where a building
stands decides how it fares in a storm, and what stands next to what can help or hinder. Avoid a
layout that is only decoration. In play, the player wants to rebuild after watching their islanders
walk the long way every day.

## The long arc

- Start: a few islanders on a small island.
- Growth: the island grows piece by piece ([How the island grows](#how-the-island-grows)) and more
  people arrive.
- The challenge grows with it. With three people the leader can talk to each one; with thirty they
  cannot, and must delegate: put someone in charge of fishing, have someone lead the roof repairs.
  Leadership structure grows out of play, never from a rule system.

## How the island grows

- **Trigger**: the population, the islanders' count. Each time it reaches the next step, the island
  grows by one piece of land. No story has to justify it. For now a piece comes for every two
  islanders above the starting three; the steps are not settled ([Open questions](#open-questions)).
- **How much**: the island starts at about 1,000 m^2, room for a bamboo grove and a meadow for the
  first islanders. A piece adds about 180 m^2 on average (from about 100 to 270 m^2), for at most 36
  steps, by which the island has grown to about 8,000 m^2.
- **Where**: chosen at random, but from the centre outward. Each new piece joins the island's
  current edge near its middle, so the island grows all round rather than stretching one way, and
  the player can plan around it. The shape stays irregular and natural, like a real island. Avoid
  a shape drifting toward a square or a circle.
- **Known in advance**: the next piece is decided and generated ahead of time, and the simulation
  knows its ground for planning. The sea floor there rises as the population approaches the step,
  so the water turns shallower and brighter and the player sees where land will come.
- **How it appears**: the new piece rises out of the sea, water running off its rock, with spray
  and mist around it; under that cover the old coast it meets turns into inland ground. This is not
  built yet: today the piece swaps in at once.
- **Incremental, never regenerated**: a new piece rebuilds only the land near it, and everything
  else on the island stays exactly as it was. The world is built in chunks for this; what a chunk
  holds and how far beyond its edges it reads the land is in the header of
  `packages/island/world/Chunks.ts`.
- Plants that matter to play are content placed in the world, not part of the terrain.

## Time and thinking

- The world never stops while an islander thinks. A model call takes seconds; meanwhile the
  islander keeps walking, working or idling, as people think while doing other things. Avoid a
  world that pauses for an answer.
- So orders are directions ("get the storehouse up today"), not moment-to-moment control, and the
  islanders need quick reactions of their own between thoughts (fast and slow thinking, System 1
  and System 2).

## Actions and perception

### Actions

An islander acts through five primitive actions of the body, just as an AI agent that uses a
computer gets a browser rather than a "search Twitter" tool. Every task, from fetching water to
building a hut, is composed from them. The actions never change: what using a thing does is defined
by the thing, so new content adds places and items with their own options, never a new action.

| Kind | Action | Its options come from |
|---|---|---|
| The body's own | `go( place )`, `say( words )`, `wait( time )` | fixed, available anywhere |
| A place's | `do( action )` | the place or person the islander stands at |
| An item's | `use( item )` | the item, carried in the bag |

- `go` names a place or a person, never a point or a distance: finding the way and walking it is
  the body's job, not the mind's. A person moves, so the body keeps following them until it is
  beside them.
- `do` runs one of the actions the islander's current place offers: fish at the shore, put in or
  take out at the chest, build at a construction site. Fishing is an option of a place, not a verb
  of the islander, so a new kind of place, or a new option at one, is a definition and needs no
  new rule. Where several places are at hand, `do` may name the one it means.
- `use` uses an item the islander carries (eat a fish), and spends it. A new item is a definition
  too, never a new action.
- A new action replaces the one under way; stopping is not an action. `say` is the exception:
  speech comes from the mind, like thinking, so the islander talks while the body goes on.

### People

The other islanders are part of the world, like places, and have no action of their own. A person
is a place that moves, and offers its options to whoever stands beside them.

- **Talking**: what an islander says is heard by every other islander within earshot (15 m), who
  notices it: who said what, and when. Words are the only way to ask, agree or refuse; nothing else
  needs the other's consent.
- **Giving**: `do( give )` beside someone hands them items from the bag. A giver gives only what
  they carry, and a full bag cannot take more, so then the gift is refused and stays with the giver.
  The one given to notices who gave them what.
- **Following**: `do( follow )` beside someone keeps a step or two behind them wherever they walk,
  until a new action replaces it or the one followed is gone.

### Building

- The player plans, the islanders build. A building the player places is a blueprint: a
  construction site, a place whose only option is `build`. Building takes a while and can be
  interrupted and resumed; the work done stays. When the work is done the site is the finished
  building with its own options (the chest's put and take).
- The player may place any number of a kind. Each building is a place with an id of its own: its
  kind's name and a count (chest1, chest2), never reused, so the islanders and the saves name it
  the same for good. Perception names each place by its id and kind.
- Several islanders may build one site, each adding their work. When it is done, everyone on it
  stops: the one who finished it, and the others when they find it finished.
- Every kind goes through the same stages, shaped by its footprint: planned (marked out), being
  built, built. The site blocks walking from the moment it is placed. Perception shows how far
  along it is as a number.
- No materials yet: building costs time only, until something on the island gives wood or stone.

### Items

- Each islander carries a small bag: a few items, and items of a kind stack. What is picked or
  caught goes into the bag; a full bag refuses it.
- A chest is a place that holds more; the islander puts in and takes out there.

### Rules and beliefs

What decides an outcome is a rule with a number: capacities, counts, how long an action takes, the
chance of a catch, walking speed, a need's level. What an islander knows and believes is not a
number: distances, routes, how far or hard something is. Perception shows the numbers that decide
outcomes, such as a site's progress and the body's needs, and never the positions.

### Needs

- Satiety and hydration, 0 to 100, fall with time and rise when the islander eats or drinks. They
  are how the pressures of food and fresh water reach each islander ([Pressure](#pressure)).
- Thirst is off until the island has a water source of its own: hydration holds where it starts,
  because nothing on the island gives water yet. The interface still shows it.
- A need that falls to zero has no consequence yet.

### Perception

An islander perceives what a person would, not the world's state:

- **seen**: the places, people and things in sight, and what shows on them: a site's progress, a
  chest's contents while at it, a person's name, age and what they are doing. Never a person's
  needs or bag, and no positions or distances.
- **at hand**: the place they stand at, and so which `do` options are open.
- **noticed**: what others did to them since their last thought: the words heard, what was handed
  to them.
- **the body**: satiety, hydration and the bag's contents, as numbers.
- **the time**: the day and the time of day.

## Not now

- Laws, decrees and other modifiers (Frostpunk's Book of Laws): later, as buffs, if at all.
- Morale or hope meters.
- Any system that does not serve the pressures, the layout or the island's growth.

## Open questions

- How a storm is announced, and how much warning the player gets.
- The population steps at which the island grows, and whether a piece's size grows with the
  population.
- How a new islander arrives, and births.
- How fast and slow thinking split between the islander's own reactions and the language model.
- An islander's memory (what they saw last, what happened when they acted), how they hear the
  leader, and what starts a thought: designed with the language model.
