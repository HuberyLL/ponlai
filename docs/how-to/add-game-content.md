# Add game content

This guide gives the steps for adding a piece of game content to the simulation behind `?game`.
Why content is registered definitions that the core never names:
[ARCHITECTURE.md](../../ARCHITECTURE.md), Rules across the layers, rule 7.

A piece of content (a resource and what answers it, a kind of place, a building) is a module in
[src/game/sim/content/](../../src/game/sim/content/). It registers its definitions with `register`
([registry.ts](../../src/game/sim/registry.ts)) and is imported, in order, by
[content/index.ts](../../src/game/sim/content/index.ts). Its numbers and their reasons go in the
module's header.

1. **Its definitions.** Write the ones it needs:
   - a need (`NeedDef`: where it starts, how much it falls a game day);
   - an item with its uses (`ItemDef`);
   - a kind of place (`PlaceKindDef`, derived from the ground and the land:
     [ARCHITECTURE.md](../../ARCHITECTURE.md), Rules across the layers, rule 5);
   - an option at a kind of place (`OptionDef`, with `open`, `start`, `holds` when standing at the
     place is not enough, `during` and `finish`);
   - a kind of building (`BuildingDef`: its footprint, its work, its store).

   It changes items only through the items system (`transfer`, `bring`, `spend`), checking counts
   and room first and refusing in its own words. It changes needs through `raiseNeed`. Anything
   others show or keep is an event of [events.ts](../../src/game/sim/events.ts).
2. **Its words and looks, where the defaults are not enough** (the defaults:
   [ARCHITECTURE.md](../../ARCHITECTURE.md), Rules across the layers, rule 9).
   - Words: keys by its id in [zh-CN.json](../../src/game/ui/i18n/zh-CN.json) (`item`, `unit`,
     `need`, `place`, `doing.do`, `record.need`).
   - A need's icon and colour: [ui/data/needs.ts](../../src/game/ui/data/needs.ts).
   - An item's row in the top row: [ui/data/resources.ts](../../src/game/ui/data/resources.ts).
   - A building's model: [view/GameView.ts](../../src/game/view/GameView.ts).
   - A building the player places also needs its row in the build bar
     ([ui/data/buildings.ts](../../src/game/ui/data/buildings.ts)). Where it stands there and what it
     costs are the design's, so a kind without a row has no default and cannot be chosen.
3. **The save.** A change to what is saved bumps `SAVE_VERSION`
   ([save.ts](../../src/game/save.ts)). A new need is in every body, and a new kind of building is
   in the buildings' state.
4. **The checks.**
   - `node tools/verify-game.mjs`: the rules, with the new content's asserts beside today's; its
     own content check, with the core naming none; and the exact maths of the rules and the content.
   - `node tools/verify-i18n.mjs` and `npm run typecheck`.
   - A run of `tools/play-game.mjs` with the stand-in brain. Its transcript, timeline and summary
     show the content played, moved between bags and noted, with nothing in the tool named for it.
     A change that should leave today's game as it was compares the tool's outputs before and
     after, byte for byte.

   The stand-in brain plays only the content it is written for. A brain that reads its perception
   (the needs, the bag, the options at hand) meets new content there with no change to it.
