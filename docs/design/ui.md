# Game UI (蜃光, "mirage light")

The interface of `?game`: what the player sees over the scene, built in `packages/game/ui/`
(`GameUi.ts` and its parts). This page is its spec: each decision says what it is, why, what to
avoid and how it shows on screen. How the code gets there is in each module's header comment. The
game behind it: [Game design](game-design.md).

- [Scope now](#scope-now)
- [Principles](#principles)
  - [Screen and world](#screen-and-world)
  - [Palette](#palette)
  - [Type](#type)
  - [Button states](#button-states)
  - [Keyboard and screen readers](#keyboard-and-screen-readers)
- [Components](#components)
  - [Top row](#top-row)
  - [Resources](#resources)
  - [Islanders: selection and alerts](#islanders-selection-and-alerts)
  - [Speaking](#speaking)
  - [Build bar](#build-bar)
  - [沧海录, the record](#沧海录-the-record)
- [Motion](#motion)
- [Ink](#ink)
- [Rules for the code](#rules-for-the-code)

## Scope now

- **Build the framework, not the content.** The game's buildings, resources and record entries are
  not settled, so every list the interface shows is data (a table of rows): the build bar's roster,
  the resources, the weather kinds, the record's kinds of entry, the icons. Later work only adds
  rows; adding a building, a resource, a weather kind or a record entry never touches the
  components. Each list ships with a few placeholder rows that show every state the component
  draws (buildable, not yet buildable, short of a material, no icon yet).
- **Out of scope for now**: a settings menu (frame rate, anti-aliasing and the rest wait); the
  placement of any building in the world but the chest (it belongs to the 3D scene:
  `packages/game/Placement.ts`); telling time in 时辰 (the clock reads `08:00` until that is
  decided); the English version (its catalogue is a snapshot, not kept up until then:
  `packages/game/ui/i18n/i18n.ts`).
- **No save menu.** With no menu, the player has no save or load control and no sign that the game
  was saved. The app saves the game itself and resumes it when the page loads
  (`packages/game/save.ts` says when).
- **Not built yet**: a choice in an islander's bag does nothing beyond marking the slot, and the
  stand-in agent (`packages/game/sim/standin.ts`) never starts a thought from what it hears (an
  agent that hears does: [Speaking](#speaking)).
- **Weather**: only the kept weathers are shown, because the auto-weather chain picks only them
  (`packages/render/sky/Weather.ts`): 晴 (clear and fair), with a night face (the moon). 多云 and 阴
  (the parked cloudy and overcast) keep their rows, 多云 with its night face (the moon behind
  cloud), so a parked sky loaded by name still has a kind to show as. The other parked kinds (雨,
  风暴, 雾) join as rows when their weathers return.
- **Resources**: bamboo (竹) is a material.

## Principles

The interface is a mirage over the sea: hidden in mist until needed, then it surfaces.

- **Chinese** is the language the interface is designed and written in. Another language is a
  translation of every word. An English version is made separately; avoid mixing it with the
  Chinese once released.
- **No frames.** No borders, boxes or panels. A soft mist shadow (黛 at low alpha, blurred) holds
  the text up off the scene.
- **Every line is a brush stroke**: a sharp entry, a full middle, a tapering exit and a slight
  curve. Icons, dividers, bars, rings and leader lines all follow it. Within one figure, keep the
  weight contrast (a solid axis against a faint paper edge). Strokes are drawn in code, their width
  varying along the path, and the long ones are inked as a brush leaves them ([Ink](#ink)).
- **Icons are the buttons**: white line art with no label on the button (`aria-label` names it for
  screen readers). On hover the icon turns 精白, with a faint stroke rising beneath it.
- **No ornaments**: no corner pieces, dots, glints or extra connecting lines.
- **Status is a thin brush bar** with its exact number after it. The bar's fill blends from its own
  colour to 朱 as it runs low. Avoid dials and cards.
- **Numbers are exact**: `08:00`, a need of `74`, progress in percent. The islanders perceive
  numbers too, so the player reads what they read.
- **Calligraphy only for big moments**: the day (第一日), name tags and the record's title.
  Everything else is in the running text.
- **Only the player's voice is 精白**; every other white is 缟.

### Screen and world

The player watches the island from behind the screen, as its maker, and the camera is their eye.
So what they read about the world stays on the screen: the top row, the forecast, the resources,
the bars, the record, and beside an islander their tag and alerts. What belongs to the islanders'
world stands in it, in the camera's perspective: the ring lies on the ground at the feet, the
thinking ring turns round the head, the speech stands over it, and the player's words leave the
screen and fly into the world to the listener.

- Nothing in the scene hides the interface, what stands in the world included: the ring at the feet
  passes over the figure's legs, as the placement ring passes over the meadow, and words pass in
  front of trees.
- What stands in the world is sized from the islander's size on screen, so a far islander's words
  stay readable.

### Palette

The colours are Chinese traditional colours. Their values are written once, in
`packages/game/ui/Palette.ts`.

| Colour | Role |
| --- | --- |
| 缟 gao | the main white: text and icons |
| 月白 yuebai | the sheen inside a white |
| 精白 jingbai | the player's words only |
| 黛 dai | the mist shadow under text |
| 苍 cang | labels and inactive choices |
| 金 jin | selection only |
| 琥珀 hupo | the satiety bar |
| 天水碧 tianshuibi | the hydration bar |
| 朱 zhu | alerts and shortages |

Large words take a gradient (精白 to 缟 to 月白) with a hairline 黛 shadow; small text is flat 缟.

### Type

The type has three layers:

- **Calligraphy**: Ma Shan Zheng (马善政, OFL) for the day, name tags and the record's title.
- **Running text**: LXGW WenKai GB (霞鹜文楷 GB, OFL), loaded in slices by `unicode-range`, so a
  page loads only the slices its characters need: the islanders may say anything.
- **Numerals and Latin**: our own brush fonts, drawn with the icons' brush (`PonlaiBrush.woff2`
  for text, `PonlaiBrushDisplay.woff2` from 24 px up, in `public/fonts/`). They come first in every
  font stack and cover only digits, Latin and the middle dot, so every digit and Latin letter in any
  text switches to the brush while Chinese falls through to the fonts after them. Their figures are
  tabular, so a changing number never shifts its neighbours.

Avoid faked bold or italic: the browser never synthesises a style (`font-synthesis: none`).
Labels are 苍, with wider letter spacing. The declarations and the stacks are in
`packages/game/ui/ui.css`.

### Button states

Normal (缟), hover (精白, with a faint stroke beneath), pressed (it sinks and dims), disabled
(faint, no pointer), selected (one 金 stroke beneath). In a set of exclusive choices (pause and
play), the current one is 缟 and the others 苍.

### Keyboard and screen readers

- Every control takes the keyboard's focus and has an `aria-label`.
- The keyboard's focus shows as the pointer's hover does (精白, the stroke beneath), never as a
  frame, which the interface has none of.
- While the record is open, no key but its own reaches the page.
- Text fits its longest likely value at 1920 x 1080 CSS pixels.

## Components

### Top row

Left to right: the day and time (`第一日` in calligraphy, `08:00` in the brush numerals); pause
and play, with no speed control, since the game runs at one speed; the weather forecast; then, at
the right, the resources and the record's scroll icon (沧海录).

#### Weather forecast

- The live "now" icon is one drawing in parts that morphs when the weather turns: a cloud slides
  in and the sun shrinks behind it through a mask; at sunset the sun sinks and the moon rises.
- Beside it, one brush stroke spans the next 24 game hours: 9 px an hour, thick by day and thin by
  night, with a tick at midnight, flowing left as time passes. A small icon stands at each turn of
  the weather (the middle of its front). Of two turns closer than 20 px, the worse one stays.
- The forecast is the weather's own future, not a guess: it is the auto-weather chain read ahead,
  which is seeded, so the future is known (`packages/render/sky/Weather.ts`). It counts in game
  hours.

### Resources

- The resources are always in view: one icon and one tabular number per kind, in groups
  (materials, food, water) with space between the groups.
- They count what the chests and stores hold, not the bags: what an islander carries is their own,
  not the island's.
- When the building chosen in the build bar lacks a material, that number turns 朱.
- With more than 8 kinds, the row keeps the common ones and merges the rest by group, and a group
  opens on hover.
- The placeholder rows: 木 竹 石 叶 | 鱼 | 水.

### Islanders: selection and alerts

- **Name tag beside the islander** (人旁浮签), opened by selecting them: a short brush leader line
  to the shoulder; the name in calligraphy; what they are doing (缟, faint); the two needs as thin
  bars with numbers (satiety 琥珀, hydration 天水碧, each blending to 朱 from 50 down to 20); the
  bag as slots (a faint ring for an empty slot, a 金 stroke under the chosen one).
- **Selection**: a 金 stroke and a ring at the feet, thick in front and thin behind.
- **Alerts**: an unselected islander whose need is critical shows a 朱 icon over the head, with no
  ring or backing; two stand side by side, satiety on the left.

### Speaking

The player talks to the islanders in words, through the speak bar at the bottom centre.

- The bar has brush strokes fading outwards on both sides. It unfolds from the middle as
  characters are typed, holds about 27 characters (560 px) and then scrolls left with a fade. Enter
  sends; the bar stays open, and each character that flies away makes room for the next. The caret
  is a single brush stroke. The placeholder reads 说话. With one islander selected, the bar shows
  only their name above it; to everyone, it shows nothing above.
- **To one islander, the words fly**: from the first character on, one leaves the bar about every
  0.08 s (pausing a little at punctuation) and travels about 1.3 s along an arc on the listener's
  left into their head, shrinking and fading as it goes. Each character's arc and sway differ a
  little. The end point follows the head every frame, so the words turn when the islander walks.
  Avoid a hit effect: a character sinking into the head is heard.
- **The words leave the screen for the world** ([Screen and world](#screen-and-world)): a
  character lifts off the glass toward the player, its top tipping out, then dives into the scene to
  the head, turning in the air as a leaf does.
- **To everyone**: the line is cut into runs, left to right across the listeners in view, and the
  runs fly at once. With fewer characters than listeners, the outer listeners take them.
- **Thinking**: the heard characters circle above the head, at most six at a time, the whole line
  taking turns. Words heard while thinking wait until the thought ends. The ring turns round the
  head in the world: each character faces out from it, turned half toward the viewer, so the ones at
  the sides show narrowed and the ones behind the head turn edge on and fade. Only an agent that
  hears thinks over the player's words.
- **An islander speaks**: the characters pop out above the head one at a time, sized by the
  camera's distance. The line holds 2.5 s plus 0.3 s per character, then melts away character by
  character. In the world, a character comes out of the mouth small and edge on, and swings open to
  face the viewer as it takes its place; melting, it rises, turns aside and blurs.

### Build bar

The mallet at the bottom right opens the build bar and closes it again. While the bar is open,
the speak bar fades aside, and an unsent line stays in its field. The bar is two tiers drawn as
brush strokes leftward from the mallet.

- **Groups** (tier 1): a fixed handful, 近用 (recently placed) nearest the mallet, a magnifier at
  the far left.
- **Buildings** (tier 2): the chosen group's buildings, in small groups separated by space, with a
  tiny 苍 name under the stroke; the group's name in calligraphy at the head. About 8 are in view
  (600 px), and the rest scroll (the wheel, brush arrows at the ends, ←/→). A fade shows at an edge
  only where more lies that way.
- **Search**: the magnifier or `/` opens it, and it matches name, use, group, small group and
  search words across all groups. Avoid opening it on any key: a Chinese input method would lose
  the first letter.
- **Keys**: 1–9 pick from what is in view. Esc clears the search, then the choice, then closes the
  bar. Enter closes it and returns to talking. The bar's keys come before the speak bar's.
- **Chosen**: the building lifts, with one 金 stroke between icon and line, and its name, use,
  cost and hours float above. A material it lacks shows in 朱, here and in the top row.

**The roster is data**, one row per building:

| Field | Example |
| --- | --- |
| name | 草棚 |
| group · small group | 居所 · 住 |
| icon | brush line art; the 未绘 ("not drawn") glyph until drawn |
| cost | 木 6, 叶 8 |
| hours | 3 (person-hours: one person 3 h, two about 1.5 h) |
| use | 遮风挡雨，可睡 2 人 |
| search words | 屋, 睡 |
| buildable | not yet buildable: faint and unclickable |

Today's rows (`packages/game/ui/data/buildings.ts`) are an example of scale, not content: their
names and costs are tentative. Placing the chosen building hands over to the game's placement in
the scene.

### 沧海录, the record

The record opens from the scroll icon at the top right, over the dimmed, stopped world. The rest
of the interface hides. Esc or × closes it, and ←/→ step the days.

- **Left**: 蓬莱 (the whole island) pinned on top, then every islander who has landed. The list
  scrolls past about 7 names, with no scrollbar; a fade shows at an edge only where more names lie
  beyond.
- **A page**: 蓬莱's page logs everything. An islander's page is their life from landing on, with
  a large brush silhouette (the list's person icon drawn big; no portraits) and their name. Landing
  (登岛) is a log entry. Each log row has the game time, who, and the words (the player's 精白, an
  islander's 缟) or a deed.
- **River of days**: one ink drop per day, always seven in view, the rest reached by the wheel,
  brush arrows (shown only where more lie) or ←/→. Days slide in and out, and the chosen day is
  ringed. A person's river starts at their landing. Above a drop stands the day's notable
  happening (a landing as a boat, a building as the mallet, a critical need in 朱; 蓬莱 groups
  landings as N人登岛, with +N for more). Below it stand that day's weather icon and name: the kind
  that held longest that day.

## Motion

Each component's motion is given with it above (Top row, Speaking, Build bar, the record).
Besides those:

- The forecast's turn icons travel with its stroke as it flows left.
- The build bar's two strokes unfold leftward from the mallet; a change of group replaces the top
  tier.

## Ink

The long strokes are inked as a brush leaves them: the record's strokes, the build bar's, the
speak bar's, the need bars, the forecast's stroke, the ring at the feet with its 金 stroke and the
leader, and the top row's dividers.

- A stroke keeps its outline exactly as drawn, and the ink only leaves it. Its tail runs dry from
  halfway (飞白: streaks of bare paper along the stroke, the tip parting into threads), three
  quarters dry at the exit. A few thin gaps of bare paper run through it, its edge is drunk in a
  little by the paper, and the ink thins slightly after the first press.
- A stroke is ink or paper. Avoid a lighter grey of ink in lines or patches: on the dark scene it
  reads as a stain.
- How dry a stroke runs comes with its length in widths: a short stroke never runs out of ink, so
  an icon's strokes stay as drawn, and icons and ticks are not inked. A thin stroke dries half as
  much, since its streaks would be crumbs. The gaps, the edge and the tone show only on a stroke
  wide enough on screen to hold them.
- A need's bar is a gauge and does not dry: its ends say the value and the whole.
- The ring at the feet is an ensō. It starts at its front left and goes round the back, so its dry
  tail falls on its heavy near side.

## Rules for the code

- The interface reads the simulation and acts only through `Game`'s methods, and asks the
  simulation for a game rule (a refusal, a cost check) instead of repeating it
  ([Architecture rules](../reference/architecture-rules.md), rules 3 and 6).
- It never touches the canvas's pixels, so paused frames stay bit-identical, and it writes the DOM
  only where it changed. What stands in the world is DOM too, laid into the scene through the camera
  (`packages/game/ui/Space.ts`). What is drawn in the 3D scene itself (the placement ring) raises a
  scene event when it changes on a paused page (`packages/game/Placement.ts`).
- Every word the player reads is a key of the catalogue, never a string in code
  (`packages/game/ui/i18n/i18n.ts` has the rules).
