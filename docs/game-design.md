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
- Growth: the island grows tile by tile (the world is generated to grow) and more people arrive.
- The challenge grows with it: with three people the leader can talk to each one; with thirty
  they cannot, and must delegate (put someone in charge of fishing, have someone lead the roof
  repairs). Leadership structure grows out of play rather than from a rule system.

## How the island grows

- **Trigger**: population. Each time the island reaches the next population step, it grows by
  one piece of land. No story has to justify it.
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
- The trees and shrubs on today's island were placeholders for its look; plants that matter to
  play (coconut palms) are content placed in the world, not part of the terrain.

## Time and thinking

- The world never stops while an islander thinks. A model call takes seconds; meanwhile the
  islander keeps walking, working or idling, as people think while doing other things.
- So orders are directions ("get the storehouse up today"), not moment-to-moment control, and
  islanders need quick reactions of their own between thoughts (fast and slow thinking, System 1
  and System 2). How that split works is designed together with the islanders' tools.

## Not now

- Laws, decrees and other modifiers (Frostpunk's Book of Laws): later, as buffs, if at all.
- Morale or hope meters.
- Any system that does not serve the pressures, the layout or the island's growth.

## Next

- A small playable prototype to test whether talking to the islanders is fun: three islanders,
  one small island, food and water, one storm, a few buildings to place, orders in natural
  language. If ten minutes of it are fun, build on it; if not, change course while it is cheap.
- Before it: the islanders' primitive actions and what they perceive.

## Open questions

- Which primitive actions the islanders have, and what they perceive.
- How a storm is announced and how much warning the player gets.
- The population steps at which the island grows, and how big each new piece is.
- How a new islander arrives.
