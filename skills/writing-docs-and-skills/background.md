# Background: why the method works this way

The reasons behind the steps in [SKILL.md](SKILL.md), the cases they come from and the public
sources. The cases are commits of the project this skill was distilled from, cited by hash.

## Why one place per fact

An agent cannot tell which of two copies is current. Claude Code's memory page says that when two
instructions contradict each other the model may pick one arbitrarily. Copies also drift: in the
source project a page listed every file with a line on what it does, kept by hand beside headers
that already said it, and it fell behind whenever a file moved (`02106623`). The fix was not to
keep the page more carefully but to print it from the headers (`54bf9049`), and to make the
header's first line a checked sentence so the printed map stays usable.

## Why the always-loaded file holds so little

What a rules file holds is read on every turn, whether the turn needs it or not. In the source
project the rules file had grown to about 49,000 characters: every change read the whole file
map, every module's rules and a long list of shader pitfalls, and a rule was hard to find among
them (`05ae8599`). It became an index of rules every change follows, with the detail moved to
where it is owned: module headers, a reference page, the architecture page. Claude Code's memory
page gives the same advice for its own files (a size target, multi-step procedures and rules for
one part of the codebase moved to skills or scoped rules) and adds that longer files reduce
adherence. Which text goes up front and which is fetched on demand is a choice per task; the
context-engineering article describes both, used together.

## Why the architecture page is short

The architecture page is read before a structural change, and a reader has to get through it to
find the structure. In the source project it had grown to several hundred lines, mostly detail
its modules' headers already stated (`d655a90c`). It now holds an overview, a map of the folders
and one sentence per rule across the layers; each rule's full text, its reason, what enforces it
and the mistake it came from went to a reference page under the same number (`9f92fefa`), and
facts of one module went to that module's header (`161f8a58`). Numbers of dropped rules stay
unused, so every reference by number stays true.

## Why the current state only

A sentence about what was tried or what the code used to do reads, to an agent, like a fact about
the code. History belongs in the commit message, where it is dated and tied to the change. The
same goes for private notes, plans and task names: a reader of the repository cannot open them,
and a citation of them is a dead end.

## Why checks rather than care

Instruction files are context, not enforced configuration (Claude Code's memory page), and a skill
is loaded when the model judges it relevant (Claude Code's skills page). A rule that must hold has
to be held by something that runs. The order (architecture, types, lint, test, text) prefers what
makes the mistake impossible over what catches it, and what catches it over what asks for care.
Docs need the same: in the source project a path check that read only Markdown paths into one
folder let a moved tool leave stale mentions in comments, strings and prose; widened to every
tracked text file, it found one at once (`e042475c`). Skills loaded through tracked links are
checked so that nothing private is forced in beside them (`4449ee1a`).

## Why an inventory before a rewrite

A move can be checked by diff; a rewrite cannot. Without a row per item and a verdict, an item
dropped by a rewrite leaves no trace, and a rule reworded in passing changes what every later
change follows without anyone deciding it. The inventory, the old-to-new path table and the
ledger make the rewrite checkable item by item, and the list of deletions and changes of meaning
puts the decisions with the owner.

## Why skills are distilled and tested

A skill written from imagination documents problems nobody has. The authoring guide's order is to
run the model on real tasks without a skill, record the failures, build evaluations, measure a
baseline and write just enough to close the gaps. A method that already exists as a guide can be
moved into a skill without a fresh failure record, but the same task before and after should not
come out worse. Keeping the project's facts in a binding lets the method travel to another
project while each project keeps its own paths and values beside its code. The silent-failure
rules come first because, after a long session is summarized, Claude Code keeps only the first
part of each skill invoked.

## Sources

Each entry states only what the cited page states.

- Anthropic, *Skill authoring best practices*
  (<https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices>). Only add
  context Claude does not already have; `name` at most 64 characters of lower-case letters,
  numbers and hyphens, without the reserved words `anthropic` or `claude`, with the gerund form
  suggested; `description` non-empty, at most 1,024 characters, in the third person, saying what
  the skill does and when to use it; the body under 500 lines; references one level deep from
  `SKILL.md`; a table of contents for reference files over 100 lines; no time-sensitive
  information; consistent terminology; a default rather than many options; evaluations built
  before extensive documentation (run without a skill, document failures, three scenarios, a
  baseline, minimal instructions, iterate); testing with every model the skill will be used with.
- Claude Code documentation, *How Claude remembers your project*
  (<https://code.claude.com/docs/en/memory>). A target of under 200 lines per `CLAUDE.md` file,
  as longer files consume more context and reduce adherence; keep to facts for every session
  (build commands, conventions, project layout, "always do X" rules) and move a multi-step
  procedure or a rule for one part of the codebase to a skill or a path-scoped rule; imports do
  not reduce context cost; contradicting instructions may be resolved arbitrarily; the files are
  context, not enforced configuration; when `AGENTS.md` is read in place of or through
  `CLAUDE.md`.
- Claude Code documentation, *Skills* (<https://code.claude.com/docs/en/skills>). Descriptions are
  loaded into context and full skill content only when invoked; Claude uses skills when relevant;
  the description and `when_to_use` are truncated at 1,536 characters in the listing; after a
  summary each re-attached skill keeps its first 5,000 tokens, within 25,000 for all; project
  skills live in `.claude/skills/<skill-name>/SKILL.md`; `paths` limits when a skill loads.
- Anthropic, *Writing effective tools for agents*
  (<https://www.anthropic.com/engineering/writing-tools-for-agents>). Return only high-signal
  information to agents; make error responses specific and actionable; describe a tool as to a new
  hire on the team; more tools do not always lead to better outcomes. The skill borrows these for
  a command-line tool's manual in its header; the article is about tools an agent calls.
- Anthropic, *Effective context engineering for AI agents*
  (<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>). The
  smallest possible set of high-signal tokens; Claude Code drops `CLAUDE.md` files into context up
  front while glob and grep fetch files just in time; minimal does not necessarily mean short.
- *AGENTS.md* (<https://agents.md/>). A README for agents; suggested sections (project overview,
  build and test commands, code style, testing instructions, security); in a monorepo the closest
  `AGENTS.md` to the edited file wins. It sets no length.
- matklad, *ARCHITECTURE.md*, 2021
  (<https://matklad.github.io/2021/02/06/ARCHITECTURE.md.html>). Keep it short, as every recurring
  contributor has to read it; call out architectural invariants explicitly; a codemap answers
  "where's the thing that does X?"; specify only what is unlikely to change often; name files and
  types rather than linking them.
- *Diátaxis* (<https://diataxis.fr>). Four forms of documentation for four needs:
  a tutorial is a lesson, a how-to guide addresses a real-world goal or problem, reference guides
  contain the technical description, explanatory guides provide context and background. The
  skill's kinds sort by when a text is read rather than by these four; its reference and design
  pages follow the reference and explanation forms.
- Google, *Google developer documentation style guide* (<https://developers.google.com/style>),
  its highlights: use second person, use active voice, put conditions before instructions.
