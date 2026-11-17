---
name: writing-docs-and-skills
description: Writes and maintains the documentation of a repository that agents work in, so that an agent reads little, finds the one place each fact lives and is not misled by stale text. Symptoms: a fact written in several places that disagree, a rules file loaded on every turn that has grown past its budget, a doc that describes what the code no longer does, docs written in house terms instead of the field's standard terms, a restructuring of the docs, or a method to be kept as a skill. Puts each text in its kind and the one place that kind lives, checks each claim against the code, states the current state only, turns a rule that can be checked into a check, rewrites docs from an inventory without losing an item, and distils a skill from recorded work with the project's facts in a binding. Use with any repository developed mostly by AI agents (an AGENTS.md or CLAUDE.md, skills, a docs folder) whenever a doc, a rule, a module's header, a tool's manual or a skill is written, moved or rewritten.
---

# Writing docs and skills

An agent reads what it is given and what it finds, and trusts both. Two copies of a fact drift
apart, and the agent follows either one. A sentence that the code has outgrown is followed as if it
were still true. A rules file is loaded on every turn, so each of its lines costs context on every
turn. The method is to put each text in the one place where its kind lives, check it against the
code, write only the current state, and keep it true with checks rather than with care.

## Rules most often broken without notice

- Write each fact or rule in one place. Every other place links to it and does not restate it.
  Before you write a fact, search for it. Move or link an existing copy; never leave it beside
  yours.
- Check a claim about the code against the code before you write it. If a doc disagrees with the
  code, fix the doc to match the code. Copying a sentence from another doc is not checking it.
- Write only the current state. What was tried, what the code did before, and why it changed go in
  the commit message. Never cite private notes, plans, task names or milestones.
- The rules file is loaded on every turn. It holds the rules that every change follows and an
  index, nothing else. A multi-step method goes in a skill; a rule of one module goes in that
  module's header.
- If a rule can be a check, make it a check in the same change. Text is the last resort.
- When a path moves, fix it everywhere in the same change: docs, code comments, strings,
  configuration and skills.
- A rewrite never drops an item or changes a rule's meaning in passing. Take deletions and changes
  of meaning to the owner first. If you think a rule is wrong, list it for the owner; do not fix
  it.
- A rule that must hold is never only in a skill, because the model decides whether a skill loads.
  Give the rule a check, or a line in the rules file.

## The project's facts: the binding

Steps marked "(binding: X)" need facts about the project: where each kind of text lives, the size
budget of the rules file, the docs checks and how to run them, the commit convention, where skills
and their bindings live. Read section X of `docs/bindings/writing-docs-and-skills.md` when you
reach the step. If the project's `AGENTS.md` or `CLAUDE.md` names another file for this skill,
that file wins.

No binding: find each fact in the project (the rules file, the docs index, `package.json`'s
scripts, the checks the commit hooks run) and ask the owner for what you cannot find. When the
work ends, offer to write what you found as the binding, one section per step.

## Workflow

Copy this checklist and keep it up to date:

```text
- [ ] 1. Name the kind and where it lives
- [ ] 2. Check the claim against the code
- [ ] 3. Write it once; link from the rest
- [ ] 4. Keep the always-loaded text in budget
- [ ] 5. Turn what can be checked into a check
- [ ] 6. Run the docs checks
- [ ] 7. Commit, with the history in the message
```

For a restructuring of existing docs, follow "Rewriting docs" below as well; for a new skill,
"Writing a skill".

### 1. Name the kind and where it lives (binding: Kinds)

Each text is one kind, and each kind has one home and one time it is read:

| Kind | What it holds | Read when | What does not belong |
| --- | --- | --- | --- |
| Rules file (`AGENTS.md`, or `CLAUDE.md` importing it) | Rules every change follows (one line each; what enforces each and the mistake behind it are recorded where the binding says), the commands, the folders, an index of what to read before which task | Every turn | Steps of a method; rules of one module; reasons at length; anything a check holds |
| Skill | A method for one kind of task, its silent-failure rules first | When the task comes up | The project's paths and values (the binding); what the model already knows |
| Binding | One project's facts for a skill, a section per step | At the step that needs it | The method |
| Tool manual (the tool's header, printed by `--help`) | The question it answers, how to call it, its output, what it needs (a GPU, a server) | When the tool is used | How it came to be |
| Architecture page | What the project is, its layers and what each owns, the main flows, the folders, the rules across layers in one sentence each | Before a structural change | Implementation detail; each rule's full text (a reference page) |
| Reference page | Facts on one subject, looked up a section at a time | When looking something up | Steps; reasons |
| Design page | Decisions: what, why, what to avoid, what it shows as on screen or in play | Before a decision of direction | Measured values (reference) |
| Module header | That module's purpose (first line, one sentence), its rules and their reasons | When the module is opened | Rules that span modules |
| Commit message | Why the change, what was tried and dropped | When tracing history | — |

- A fact or rule of one module lives in that module's header, beside the code it describes. A
  reference page holds what no one module owns (a table of options, a convention across modules)
  and links to the headers for the rest; a header is never emptied into a page.
- If a list can be generated, generate it instead of maintaining it by hand. A file-by-file code
  map printed from the headers' first lines cannot fall behind the code.
- Only a reader who opens the file sees its header. A rule that is needed before the file exists
  (how to add a new kind of thing) goes in a skill or the rules file, not only in a header.
- A long page (over about 100 lines) opens with its contents, so a reader can take one section.

### 2. Check the claim against the code

Read the code, the tool or the measurement that the sentence describes, and write what it does
now. Where docs disagree, none of them is the source: the code is. For a number that the code
holds, name its constant or link to it; do not copy the value. To check a claim about a source
outside the repository, open that source, and credit only what its page states. If you meet a
stale sentence on the way, fix it in the same change or report it to the owner; never pass over it
in silence.

### 3. Write it once; link from the rest

1. Search the repository for the fact or rule (its key words, its number, its file name).
2. Keep it where its kind lives (step 1). Replace each other copy with a link, or delete it.
3. A link names the page and section. The reader goes there only when the task needs it.

### 4. Keep the always-loaded text in budget (binding: Budget)

The task decides what loads up front and what is fetched on demand. A rule that every change must
follow belongs up front; a method, a manual or a fact belongs where it is fetched. Every line of
the rules file costs context on every turn and lowers how well the rest is followed. Before you
add a line, take one out or move one to where it is owned. If the rules file is over its budget,
cut it before the new line goes in. Moving a rule out of the rules file changes when it is read,
so take the move to the owner with the changes of meaning, unless a check now enforces the rule.

### 5. Turn what can be checked into a check (binding: Checks)

For a new rule, prefer in order: make the mistake impossible in the architecture, then in the
types, then a lint rule, then a test or a verify tool, then text. Write a text rule as one line.
Record what enforces it ("judgement" when nothing does) and the mistake that led to it where the
binding says. If a text rule is broken a second time, add a check in the change that finds the
breach.

Docs are kept true by checks too:

- every path into the docs, skills and tools written anywhere (code comments included) exists;
- Markdown links resolve offline; web links are checked separately, less often;
- each module's header opens with one sentence of purpose (the code map is printed from it);
- a table that mirrors code (options, settings) is checked against the code;
- each tracked skill is linked where the agent loads skills;
- the rules file stays within its budget.

### 6. Run the docs checks (binding: Checks)

Before the commit, run the checks for what you touched. Fix a failure at its cause: correct the
path, and never add it to an allow list without a reason written beside it.

### 7. Commit, with the history in the message (binding: Commit)

The message says why: what was wrong, what was tried, what was dropped. The docs say only what is.

## Rewriting docs (binding: Rewrite)

A rewrite is harder to check than a move, so the inventory comes before the writing.

1. Inventory every page: one row per rule and per block of facts, each with a verdict: kept at X,
   moved to Y, merged into Z, replaced by check C, or deleted (with the reason).
2. Write a table of every old path to its new path, before anything moves.
3. Show the owner the deletions and the changes of meaning. A rule you think wrong goes on that
   list; the rewrite does not change it.
4. Rewrite page by page in the order the paths allow, each change fixing every path it moves across
   the whole repository, so the checks pass at every commit.
5. Keep a ledger: where each inventory row went. At the end, go through it row by row against the
   new docs.
6. Where no check can see the result (prose, whether a page reads for its reader), have it
   reviewed by a reader who did not write it.

## Writing a skill (binding: Skills)

1. Write a skill for a method used more than once, from recorded work: the commits, the mistakes
   that led to rules, the context that was given again and again. A method with no record of a
   failure is not written ahead.
2. Keep the method apart from the project: `SKILL.md` holds what holds in any project; the binding
   holds this project's paths, commands and values, a section per step, and each step that needs
   one says "(binding: Section)". Say what to do when a project has no binding.
3. Put the rules most often broken without notice in the first lines: after a long session only
   the start of a skill may be kept. Keep the body short (under 500 lines is the limit; a short
   skill is read whole) and reference files one level below `SKILL.md`.
4. Frontmatter: `name` in lower case with hyphens; `description` in the third person, the key use
   first: what goes wrong or is wanted, what the skill does, when to use it.
5. The why and the sources go in a background file, each source credited only for what its page
   states, opened before it is cited.
6. Test it: the same task once without the skill and once with it, a task hard enough that the two
   can differ. Record what each run did (where it put the text, whether it checked the code,
   whether it left one copy, whether it proposed a check) and what you changed because of it. One
   comparison shows what one run did, not how often.

## Prose

Use plain words and short sentences, one idea each, each with a subject and a verb. Use one term per
thing, the same term throughout. Use the field's standard term, not a house word: "post-processing",
not "the image"; "capture", not "shoot"; "deterministic", not "repeats". Describe a thing in other
words only when the field has no term for it. Write for a newcomer to the project, not for the team:
"a load knob is read once" becomes "load-time settings are read once at startup". Use the present
tense, the second person and the active voice, and put a condition before the instruction it
governs. Repository text is in the project's language, whatever the language of the conversation.

Why the method works this way, and the sources: [background.md](background.md).
