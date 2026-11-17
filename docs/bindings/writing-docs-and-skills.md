# Binding: writing docs and skills

This project's facts for the skill
[`writing-docs-and-skills`](../../skills/writing-docs-and-skills/SKILL.md). Each section is named
after the step of the skill that reads it. A project of your own copies the section names and
fills in its own facts.

## Kinds

Where each kind is written, and when to update it: `AGENTS.md`, Where things are written. The
homes in this repository:

| Kind | Here |
| --- | --- |
| Rules file | The root `AGENTS.md` (the index and the rules every change follows) and one in `packages/render/`, `packages/island/` and `tools/` (the rules of that folder alone); a `CLAUDE.md` beside each imports it, and the root's keeps Claude-only notes |
| Skill | `skills/<name>/` (`SKILL.md`, `background.md`, reference files) |
| Binding | `docs/bindings/<name>.md` |
| Tool manual | The tool's header, printed by `--help`; `docs/reference/tools.md` indexes the tools by question |
| Architecture page | `ARCHITECTURE.md`; each rule's full text in `docs/reference/architecture-rules.md`, under the same number |
| Reference page | `docs/reference/` |
| Design page | `docs/design/` (art direction and its subject pages, game design, game UI) |
| Folder README | A `README.md` in the folder it documents: what the folder holds and one task's steps on it that no skill covers (`tools/kit/`, `tools/kit/parity/`, `packages/render/three/`, `packages/game/sim/content/`, `examples/rock/`); a method used across tasks is a skill |
| Module header | The header comment of each file under `packages/` and `app/` |
| Third-party sources whose licence asks for a notice or credit | `CREDITS.md` |
| A file's copyright and licence | SPDX tags in its `/*! ... */` notice, `REUSE.toml`, `LICENSES/` |
| A technique, paper or talk | A comment where it is used |

- A rule in a rules file is one line. What enforces it is recorded in the file's lists (Checks,
  below); the mistake behind it goes in the commit message that adds it, never in the file.
- A new page gets a line in the docs index, `docs/README.md`.
- The code map is printed, not kept: `node tools/repo/code-map.mjs [folder]` lists each file with
  its header's first line.

## Budget

- The root `AGENTS.md`: at most `ROOT_LINES` lines and `ROOT_CHARS` characters, the constants of
  `tools/repo/verify-doc-shape.mjs`, which `npm run lint:docs` runs. Take a line out first when the
  file is at its limit.
- A folder's `AGENTS.md` holds the rules of that folder alone; it and the other pages have no hard
  limit. A page over 100 lines opens with its contents (`verify-doc-shape` checks it).

## Checks

- `npm run check`, before every commit (`tools/check.mjs`, its header lists every check). Among
  them, for docs: `tools/repo/verify-headers.mjs` (each module's header opens with one sentence),
  `tools/repo/verify-settings.mjs` (the URL options page against the layers' settings tables; `--write`
  rewrites its table of every option),
  `tools/repo/verify-skill-links.mjs` (the skills' links under `.claude/`, their frontmatter, size,
  reference files and bindings, and the root's index of them),
  and the docs lint when a Markdown file is staged. `npm run check -- --full` runs the docs lint
  whatever is staged; run it before a merge.
- `npm run lint:docs`, before a commit that changes Markdown: markdownlint-cli2
  (`.markdownlint-cli2.jsonc`: prose wrapped at 100 columns), `tools/repo/verify-doc-paths.mjs`
  (every path into `docs/`, `skills/` or `tools/` in a tracked text file exists; every file the
  rules files and `ARCHITECTURE.md` name in backticks is tracked), `tools/repo/verify-doc-shape.mjs`
  (Budget) and lychee's offline link check. lychee is a separate binary
  (`tools/repo/verify-doc-paths.mjs`'s header).
- `npm run lint:links`: the web links too, run by hand.
- A rule turned into a check: a lint rule in `tools/repo/lint/` (named `ponlai/…`) or a `verify-*`
  tool, named in `AGENTS.md`, What the checks hold or Checks run by hand (or a folder's
  `AGENTS.md`); the mistake it came from goes in the commit message (`AGENTS.md`, Adding a rule).
- A rule that needs judgement: one line in the rules file naming the page or header that owns its
  detail, with nothing written for what enforces it; the mistake goes in the commit message.

## Commit

- Conventional Commits (`AGENTS.md`, Rules for every change). Docs take `docs` with the section
  as scope (`docs(architecture): ...`, `docs(tools): ...`); a change to the docs lint takes
  `build(docs)`; a new skill takes `feat(skills)`.
- The body says why; what was tried and dropped goes there, never into the docs.

## Rewrite

- The inventory, the old-to-new path table and the ledger are working notes outside the
  repository; committed text never cites them.
- Each commit that moves a file fixes every path to it across the repository, `AGENTS.md`,
  `ARCHITECTURE.md`, `CREDITS.md` and code comments included, so `npm run check -- --full` passes
  at the merge. A path that follows a move is not a change of a rule's text; a change of a rule's
  text goes to the owner.

## Skills

- Files: `skills/<name>/SKILL.md` and `background.md` (the why, typical cases told in general
  terms with no commit of this repository, the sources, each credited only for what its page
  states); a reference file only when the body would pass about 200 lines. The existing skills are
  the model for the layout.
- Loading: a tracked link `.claude/skills/<name>` pointing to `../../skills/<name>`, and a line
  `!.claude/skills/<name>` in `.gitignore`; a skill without that line stays private.
  `tools/repo/verify-skill-links.mjs` checks the links. The same `skills/` ships as a Claude Code
  plugin: `.claude-plugin/marketplace.json` lists `plugins/ponlai/`, whose `skills` is a link to
  `skills/`, so an install copies the skills and nothing else (a plugin at the root would also get
  the root's npm packages installed).
- Binding: `docs/bindings/<name>.md`, opening with the paragraph above, a section per step that
  needs one, named after it.
