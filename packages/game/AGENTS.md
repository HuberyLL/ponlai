# The game's rules

`packages/game/` is the game behind `?game`: the headless simulation (`sim/`), session, save, view
and interface (`ui/`). These rules bind it alone; the root `AGENTS.md` holds the rules every change
follows.

- No player-facing string is written in code; the words are in `packages/game/ui/i18n/`.
- Game UI (what the player sees in `?game`, mockups too) is built with the
  `threejs-game-ui-designer` skill when the agent has it, to read as a game's, not a product's
  (`docs/design/ui.md`).
