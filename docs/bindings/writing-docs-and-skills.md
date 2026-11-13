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
| Rules file | `AGENTS.md`; `CLAUDE.md` imports it and keeps Claude-only notes |
| Skill | `skills/<name>/` (`SKILL.md`, `background.md`, reference files) |
| Binding | `docs/bindings/<name>.md` |
| Tool manual | `docs/reference/tools.md` (the manuals, and Which tool for which question) and the tool's header; `tools/kit/parity/README.md` documents its folder |
| Architecture page | `ARCHITECTURE.md`; each rule's full text in `docs/reference/architecture-rules.md`, under the same number |
| Reference page | `docs/reference/` |
| Design page | `docs/design/` (art direction and its subject pages, game design, game UI) |
| How-to guide | `docs/how-to/`: one task's steps in this project |
| Module header | The header comment of each file under `packages/` and `app/` |
| Third-party sources | `CREDITS.md` |

- A new page gets a line in the docs index, `docs/README.md`.
- The code map is printed, not kept: `node tools/repo/code-map.mjs [folder]` lists each file with
  its header's first line.

## Budget

- `AGENTS.md`: at most 20,000 characters. The docs lint does not count them at present; count with
  `wc -m AGENTS.md` before adding a line, and take one out first when the file is at its limit.
- Other pages have no hard limit.

## Checks

- `npm run check`, before every commit (`tools/check.mjs`, its header lists every check). Among
  them, for docs: `tools/repo/verify-headers.mjs` (each module's header opens with one sentence),
  `tools/repo/verify-settings.mjs` (the URL options page against `packages/render/Settings.ts`; `--write`
  rewrites its table of every option),
  `tools/repo/verify-skill-links.mjs` (nothing tracked under `.claude/` but the skills' links),
  and the docs lint when a Markdown file is staged. `npm run check -- --full` runs the docs lint
  whatever is staged; run it before a merge.
- `npm run lint:docs`, before a commit that changes Markdown: markdownlint-cli2
  (`.markdownlint-cli2.jsonc`: prose wrapped at 100 columns), `tools/repo/verify-doc-paths.mjs`
  (every path into `docs/`, `skills/` or `tools/` in a tracked text file exists; every file
  `AGENTS.md` and `ARCHITECTURE.md` name in backticks is tracked) and lychee's offline link check.
  lychee is a separate binary (`docs/reference/tools.md`, Docs checks).
- `npm run lint:links`: the web links too, run by hand.
- A rule turned into a check: a lint rule in `tools/repo/lint/` (named `ponlai/…`) or a `verify-*`
  tool, with a row in `AGENTS.md`'s rules naming what enforces it and the mistake it came from
  (`AGENTS.md`, Adding a rule).

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

- Files: `skills/<name>/SKILL.md` and `background.md` (the why, the cases by commit hash, the
  sources, each credited only for what its page states); a reference file only when the body
  would pass about 200 lines. The existing skills are the model for the layout.
- Loading: a tracked link `.claude/skills/<name>` pointing to `../../skills/<name>`, and a line
  `!.claude/skills/<name>` in `.gitignore`; a skill without that line stays private.
  `tools/repo/verify-skill-links.mjs` checks the links. `.claude-plugin/plugin.json` declares the
  same `skills/` as a plugin.
- Binding: `docs/bindings/<name>.md`, opening with the paragraph above, a section per step that
  needs one, named after it.
