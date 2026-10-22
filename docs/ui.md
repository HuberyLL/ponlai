# Ponlai: game UI (蜃光, "mirage light")

The interface of `?game`: what the player sees over the scene, built in `src/game/ui/`
(`GameUi.ts` and its parts; As built, at the end, says where it departs from or adds to this
file). The designs live on the project's design canvas as boards (named below:
**Style**, **Type**, **SpeakFlow**, **BuildNotes**, **WeatherAnim**); this file is the spec the
code follows, and where it and a board disagree, this file wins (the boards predate the decisions
marked *changed*).

## Scope now

- **Build the framework, not the content.** The game's buildings, resources and record entries are
  not settled. Every list the UI shows is data (a roster, a table), so later work only adds rows:
  the build bar's roster, the resources, the weather kinds, the record's entries, the icons.
  Ship each list with a few placeholder rows that exercise every state (buildable, not buildable,
  short of a material, no icon yet).
- **Out of scope for now**: a settings menu (frame rate, anti-aliasing and the rest wait); the
  placement of a building in the world (it belongs to the 3D scene: `src/game/Placement.ts`);
  telling time in 时辰 (the clock reads `08:00` until decided); the English version (its catalogue
  is a snapshot, not maintained until then: As built, Languages).
- **Weather**: only the kept weathers are shown (*changed*): 晴 (clear and fair), 多云 (cloudy)
  and 阴 (overcast), with night faces for 晴 (moon) and 多云 (moon behind cloud). The parked kinds
  (雨, 风暴, 雾) are drawn on the canvas and join when their weathers return.
- **Resources** (*changed*): the coconut (椰子) is gone with the palm; bamboo (竹) is a material.

## Principles

The interface is a mirage over the sea: hidden in mist until needed, then it surfaces. Chinese
is the language it is designed and written in; another language is a translation of every word
(an English version is made separately, never mixed with the Chinese once released).

- **No frames.** No borders, boxes or panels: a soft mist shadow (黛 at low alpha, blurred) holds
  the text up off the scene.
- **Every line is a brush stroke**: sharp entry, a full middle, a tapering exit, a slight curve.
  Icons, dividers, bars, rings and leader lines all follow it. Within one figure keep weight
  contrast (a solid axis, a faint paper edge). Strokes are drawn in code (width varying along the
  path) until painted textures replace them.
- **Icons are the buttons**: white line art with no label on the button (`aria-label` for screen
  readers). Hover turns it 精白 with a faint stroke rising beneath it.
- **No ornaments**: no corner pieces, dots, glints or extra connecting lines.
- **Status is a thin brush bar** with its exact number after it; the bar's fill blends from its
  own colour to 朱 as it runs low. No dials or cards.
- **Numbers are exact**: `08:00`, a need of `74`, progress in percent. The islanders perceive
  numbers too.
- **Calligraphy only for big moments**: the day (第一日), name tags, the record's title.
- **Only the player's voice is 精白**; every other white is 缟.

### Palette (Chinese traditional colours)

| Token | Hex | Use |
| --- | --- | --- |
| 缟 gao | `#F2ECDE` | the main white: text, icons |
| 月白 yuebai | `#D6ECF0` | the sheen inside a white |
| 精白 jingbai | `#FFFFFF` | the player's words only |
| 黛 dai | `#0F1E21` | the mist shadow under text |
| 苍 cang | `#8A9D9E` | labels, inactive choices |
| 金 jin | `#EACD76` | selection only |
| 琥珀 hupo | `#CA6924` | the satiety bar |
| 天水碧 tianshuibi | `#5AA4AE` | the hydration bar |
| 朱 zhu | `#ED5736` | alerts, shortages |

Large words take a gradient (精白 → 缟 → 月白) with a hairline 黛 shadow; small text is flat 缟.

### Type

Three layers:

- **Calligraphy**: Ma Shan Zheng (马善政, OFL; npm `@fontsource/ma-shan-zheng`) for the day, name
  tags and the record's title.
- **Running text**: LXGW WenKai GB (霞鹜文楷 GB, OFL; npm `lxgw-wenkai-gb-web`, which ships it
  sliced by `unicode-range`, so a page loads only the slices its characters need: the islanders
  may say anything).
- **Numerals and Latin**: our own brush fonts, drawn with the icons' brush, in
  `src/game/ui/fonts/`: `PonlaiBrush.woff2` (text cut) and `PonlaiBrushDisplay.woff2` (from
  24 px up). Declare them with `unicode-range: U+0020-007E, U+00B7` and put them first in every
  stack, so every digit and Latin letter in any text switches to the brush while CJK falls through.
  Their figures are tabular: a changing number never shifts its neighbours.

Stacks: body `'Ponlai Brush', 'LXGW WenKai GB', serif`; titles `'Ponlai Brush Display',
'Ma Shan Zheng', serif`. Set `font-synthesis: none` everywhere (never fake bold or italic). Labels
are 苍 with wider letter spacing.

### Button states

Normal (缟), hover (精白, a faint stroke beneath), pressed (sinks, dimmer), disabled (faint, no
pointer), selected (one 金 stroke beneath). In a set of exclusive choices the current one is 缟
and the others 苍 (the speeds).

## Components

The layout of each is on the Style board ("组件 · 叠在场景上看"); the live behaviour is the
SpeakFlow prototype.

### Top row

Left to right: the day and time (`第一日` in calligraphy, `08:00` in the brush numerals); the
speeds (pause, 1×, 3×, 6×: `SPEED_FACTORS` in `src/game/sim/types.ts`); the weather forecast;
then, at the right, the resources and the record's scroll icon (沧海录).

**Weather forecast** (board WeatherAnim). The live "now" icon is one drawing in parts that morphs
when the weather turns (a cloud slides in and the sun shrinks behind it through a mask; at sunset
the sun sinks and the moon rises). Beside it, one brush stroke for the next 24 game hours: 9 px an
hour, thick by day and thin by night, a tick at midnight, flowing left as time passes; a small icon
stands at each turn of the weather (at the middle of the front), and of two turns closer than
20 px the worse one stays. The forecast is the engine's own auto chain read ahead
(`src/sky/Weather.ts`: seeded, so the future is known); it counts in game hours.

**Resources**: always in view, one icon and one tabular number per kind, grouped (materials, food,
water) with space between groups. They count what the chests and stores hold, not the bags. When
a chosen building lacks a material, that number turns 朱. With more than 8 kinds the row keeps the
common ones and merges the rest by group, expanding on hover. Placeholder rows: 木 竹 石 叶 | 鱼 |
水.

### Islanders: selection and alerts

- **Name tag beside the islander** (人旁浮签), opened by selecting them: a short brush leader line
  to the shoulder; the name (calligraphy); what they are doing (缟, faint); the two needs as thin
  bars with numbers (satiety 琥珀, hydration 天水碧, each blending to 朱 from 50 down to 20); the
  bag as slots (a faint ring for an empty slot, a 金 stroke under the chosen one).
- **Selection**: a 金 stroke and a ring at the feet, thick in front and thin behind.
- **Alerts**: an unselected islander whose need is critical shows a 朱 icon over the head, with no
  ring or backing; two side by side, satiety on the left.

### Speaking (the speak bar)

The player talks to the islanders in words. A bar at the bottom centre, with brush strokes fading
outwards on both sides; it unfolds from the middle as characters are typed, holds about 27
characters (560 px) and then scrolls left with a fade. Enter sends; the bar stays open, and each
character that flies away makes room for the next. A caret is a single brush stroke. The
placeholder reads 说话; with one islander selected, the bar shows only their name; to everyone it
shows nothing above.

- **To one islander, the words fly**: from the first character on, one leaves the bar about every
  0.08 s (pausing a little at punctuation) and travels about 1.3 s along an arc on the listener's
  left into their head, shrinking and fading as it goes; each character's arc and sway differ a
  little. The end point follows the head every frame, so the words turn when the islander walks.
  No hit effect: a character sinking into the head is heard.
- **To everyone**: the line is cut into runs, left to right across the listeners in view, and the
  runs fly at once; with fewer characters than listeners, the outer listeners take them.
- **Thinking**: the heard characters circle above the head, at most six at a time, the whole line
  taking turns; words heard while thinking queue until the thought ends.
- **An islander speaks**: the characters pop out above the head one at a time, sized by the
  camera's distance; the line holds 2.5 s plus 0.3 s per character, then melts away character by
  character.

### Build bar

Opened by the mallet at the bottom right (which toggles it); the speak bar fades aside while it is
open (an unsent line stays in its field). Two tiers drawn as brush strokes leftward from the
mallet (board BuildNotes):

- **Groups** (tier 1): a fixed handful, 近用 (recently placed) nearest the mallet, a magnifier at
  the far left.
- **Buildings** (tier 2): the chosen group's buildings, in small groups separated by space with a
  tiny 苍 name under the stroke; the group's name in calligraphy at the head; about 8 in view
  (600 px), the rest scroll (wheel, brush arrows at the ends, ←/→; a fade at an edge only where
  more lies that way).
- **Search**: the magnifier or `/` (not any key: a Chinese IME would lose the first letter) matches
  name, use, group, small group and search words across all groups.
- **Keys**: 1–9 pick from what is in view; Esc clears the search, then the choice, then closes;
  Enter closes and returns to talking. The bar's keys come before the speak bar's.
- **Chosen**: it lifts, one 金 stroke between icon and line; its name, use, cost and hours float
  above. A short material shows in 朱, here and in the top row.

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

The canvas roster (26 buildings, groups 居所 食物 淡水 储藏 工坊 防灾) is an example of scale, not
content; costs and names are tentative and the coconut grove goes with the coconut. Placing the
chosen building hands over to the game's placement in the scene.

### 沧海录, the record

Opens from the scroll icon at the top right over the dimmed, stopped world: the rest of the
interface hides; Esc or × closes; ←/→ step days.

- **Left**: 蓬莱 (the whole island) pinned on top, then every islander who has landed, scrolling
  past about 7 names (scrollbar hidden, a fade at an edge only where more names lie beyond).
- **A page**: 蓬莱 logs everything; an islander's page is their life from landing on, with a large
  brush silhouette (the list's person icon drawn big; no portraits) and their name. Landing (登岛)
  is a log entry. Log rows: game time, who, the words (the player's 精白, islanders' 缟) or a deed.
- **River of days**: one ink drop per day, always seven in view, the rest reached by wheel, brush
  arrows (shown only where more lie) or ←/→; days slide in and out; the chosen day is ringed; a
  person's river starts at their landing. Above a drop, the day's notable happening (a landing as
  a boat, a building as the mallet, a critical need in 朱; 蓬莱 groups landings as N人登岛, +N for
  more); below it, that day's weather icon and name: the longest kind of the day.

## Motion

- Words to an islander: as in Speaking (0.08 s apart, 1.3 s flight, following the head).
- The weather icon morphs between kinds; the forecast stroke flows left with time and its turn
  icons travel with it.
- The build bar: the two strokes unfold leftward from the mallet; a change of group replaces the
  top tier; more than fits slides; the chosen lifts and its detail floats up.
- The record: days slide in and out of the river.

## Rules for the code

- The UI reads the simulation and acts only through `Game`'s methods; it never duplicates a game
  rule (a refusal, a cost check) but asks the simulation for it.
- It never touches the canvas's pixels, so paused frames stay exact; DOM is written only where its
  text changed. Anything drawn in the 3D scene (the ring at the feet, words flying to a head)
  that changes on a paused page raises a scene event (`src/post/SceneEvents.ts`).
- Lists render from data; adding a building, a resource, a weather kind or a record event never
  touches the components.
- Every word the player reads is a key of the catalogue (`src/game/ui/i18n/`), never a string in
  code; a list's row names its words by its id.
- Keyboard focus and `aria-label` on every control; text fits its longest likely value at
  1920×1080 CSS pixels.

## As built

`src/game/ui/` follows this file; where it had to decide something this file leaves open, or departs
from a board, it is said here.

- **Scale**: the parts are laid out on the boards' 1600 x 900 and scaled to the window by the
  smaller of its width over 1600 and its height over 900 (1.2 at 1920 x 1080 CSS pixels), each
  anchored to the edge it is drawn against.
- **Forecast**: the auto chain read ahead by `Weather.forecast` (seeded: a turn comes within a
  frame of when it was read); with auto weather off the sky holds and the stroke has no marks.
- **Resources**: a kind the simulation has as an item (fish) counts the stores (`sim/stock.ts`);
  the others show their row's placeholder count until the simulation has materials. What a
  building lacks is the simulation's `shortfall`, never the bar's own sum.
- **Islanders**: their names are Chinese (`sim/Sim.ts`). The ring at the feet and the words over
  the heads are drawn over the canvas through the camera each frame (the placement's ring stays in
  the scene); the ring passes over the figure's legs, as the placement ring passes over the meadow.
  The bag shows a slot per kind with its count, then a faint ring per free place; a click marks a
  slot 金 and does nothing more yet.
- **Speaking**: the words go into the record; for a brain that hears (`Brain.hears`) they wait for
  each listener's next thought (`Game.takeHeard`), and it is asked for one as they are said.
  The stand-in does not hear, so its islanders never think aloud; the debug panel's hearing brain
  shows the whole loop (words landing, the thinking ring, an answer).
- **Build bar**: only a building the simulation knows (its row's `kind`: the chest) hands over to
  the placement in the scene; the detail then says how (点岛上放下) or why the spot is refused. A
  row not yet buildable still shows its detail on hover (还不能建). The recent group lists what
  the island has had placed, the latest first.
- **Record**: the game keeps it (`src/game/Chronicle.ts`) and it is part of the save
  (`src/game/save.ts`): a resumed game's record goes on from where it was saved, and a game saved
  before it was (save version 17) resumes with an empty one, its islanders' landings unknown. Its
  river runs to today, or to the last day it names (the debug panel's placeholder days, which are
  entries like any other and so are saved too).
- **Saving**: there is no save or load control for the player yet (no menu: Scope now). The page
  saves the game itself, every minute while it runs and when it is hidden or left, and resumes it
  when it loads (`src/game/save.ts`).
- **Languages**: the words are i18next catalogues in `src/game/ui/i18n/` (its header has the
  rules): `zh-CN.json` is the source and the default, `en.json` a snapshot of it that is not kept up
  while the game is in development, so a key it lacks shows the Chinese. `?lang=en` (or the debug
  panel's Interface › language) loads the page in English; the language is read once at load. The
  islanders' names and what people say (the placeholder days, the hearing brain's lines) are
  content, not catalogue words. The English page is laid out with the Chinese page's measures and
  letter spacing, untuned. `tools/verify-i18n.mjs` fails on Chinese written in code outside the
  catalogues and reports how far `en.json` has drifted.
- **Focus**: the keyboard's focus is shown as the pointer's hover is (精白, the stroke beneath),
  never a frame. The record takes the focus itself on opening (not its ×, which Space would press)
  and gives it back on closing; while it is open no key but its own reaches the page.
- **Not yet**: painted brush textures (every stroke is drawn in code), the placement of any
  building but the chest, a player's save or load control or a sign that the game was saved, a
  thought started by hearing for the stand-in,
  and everything Scope now leaves out.
