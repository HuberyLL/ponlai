# Game content

This folder holds the content of the simulation behind `?game`, and this page gives the steps for
adding a piece of it. Why content is registered definitions that the core never names: [Rules across
the
layers](../../../../docs/reference/architecture-rules.md#rule-7-content-is-registered-definitions-the-core-names-none),
rule 7. What the game is: [Game design](../../../../docs/design/game-design.md).

A piece of content (a resource and what answers it, a kind of place, a building) is a module in
this folder. It registers its definitions with `register` ([registry.ts](../registry.ts)) and is
imported, in order, by [index.ts](index.ts). Its numbers and their reasons go in the module's
header.

## Add a piece of content

1. **Its definitions.** Write the ones it needs:
   - a need (`NeedDef`: where it starts, how much it falls a game day);
   - an item with its uses (`ItemDef`);
   - a kind of place (`PlaceKindDef`, derived from the ground and the land: [Rules across the
     layers](../../../../docs/reference/architecture-rules.md#rule-5-generic-generation), rule 5);
   - an option at a kind of place (`OptionDef`, with `open`, `start`, `holds` when standing at the
     place is not enough, `during` and `finish`);
   - a kind of building (`BuildingDef`: its footprint, its work, its store).

   It changes items only through the items system (`transfer`, `bring`, `spend`). It checks counts
   and free space first, and refuses with a reason of its own. It changes needs through `raiseNeed`.
   Anything others show or keep is an event of [events.ts](../../sim/events.ts).
2. **Its words and looks, where the defaults are not enough** (the defaults: [Rules across the
   layers](../../../../docs/reference/architecture-rules.md#rule-9-presentation-by-outcome-and-event-category-with-a-default),
   rule 9).
   - Words: keys by its id in [zh-CN.json](../../ui/i18n/zh-CN.json) (`item`, `unit`,
     `need`, `place`, `doing.do`, `record.need`).
   - A need's icon and colour: [ui/data/needs.ts](../../ui/data/needs.ts).
   - An item's row in the top row: [ui/data/resources.ts](../../ui/data/resources.ts).
   - A building's model: [view/GameView.ts](../../view/GameView.ts). A model placed off the island
     or standing above 3 m registers with the water system
     ([Materials](../../../../docs/bindings/building-cinematic-stylised-realism.md#materials)).
   - A building the player places also needs its row in the build bar
     ([ui/data/buildings.ts](../../ui/data/buildings.ts)). Its place in the bar and
     its cost are design decisions, so a kind without a row has no default and cannot be chosen.
3. **The save.** A change to what is saved bumps `SAVE_VERSION`
   ([save.ts](../../save.ts)). A new need is in every body, and a new kind of building
   is in the buildings' state.
4. **The checks.**
   - `node tools/game/verify-game.mjs`: the rules, with the new content's asserts beside today's;
     its own content check, with the core naming none; and the exact maths of the rules and the
     content.
   - `node tools/game/verify-i18n.mjs` and `npm run typecheck`.
   - A run of `tools/game/play-game.mjs` with the stand-in agent (`--agent standin`, the default).
     Its transcript, timeline and summary show the content played, moved between bags and recorded,
     without the tool naming the content anywhere.
     For a change that should leave today's game as it was, compare the tool's outputs before and
     after, byte for byte.

   The stand-in agent (`packages/game/sim/standin.ts`) plays only the content it is written for. An
   agent that reads its perception (the needs, the bag, the options at hand) meets new content there
   with no change to the agent.
