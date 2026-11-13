---
name: writing-docs-and-skills
description: Writes and keeps the documentation of a repository that agents work in, so that an agent reads little, finds the one place a fact lives and is not misled by stale text, such as a fact written in several places that disagree, a rules file that every turn pays for growing past its budget, a doc that describes what the code no longer does, a restructuring of the docs, or a method to be kept as a skill. Puts each text in its kind and the one place that kind lives, checks each claim against the code, states the current state only, turns a rule that can be checked into a check, rewrites docs from an inventory without losing an item, and distils a skill from recorded work with the project's facts in a binding. Use with any repository developed mostly by AI agents (an AGENTS.md or CLAUDE.md, skills, a docs folder) whenever a doc, a rule, a module's header, a tool's manual or a skill is written, moved or rewritten.
---

# Writing docs and skills

An agent reads what it is given and what it finds, and trusts both. Two copies of a fact drift
apart and the agent follows either; a sentence the code has outgrown is followed as if it were
true; a rules file that every turn loads costs context on every turn. The method: put each text in
the one place its kind lives, check it against the code, write the current state only, and keep
it true with checks rather than care.

## Rules most often broken without notice

- One fact or rule in one place. Every other place links to it and does not restate it. Before
  you write a fact, search for it: an existing copy is moved or linked, never left beside yours.
- A claim about the code is checked against the code before it is written, and a doc that
  disagrees with the code is fixed to the code. Copying a sentence from another doc is not
  checking it.
- Write the current state only. What was tried, what it was before, and why it changed go in the
  commit message. Never cite private notes, plans, task names or milestones.
- The rules file is loaded on every turn: rules every change follows and an index, nothing else.
  A multi-step method goes in a skill; a rule of one module goes in that module's header.
- A rule that can be a check becomes a check in the same change. Text is the last resort.
- A path that moves is fixed everywhere in the same change: docs, code comments, strings,
  configuration, skills.
- A rewrite never drops an item or changes a rule's meaning in passing. Deletions and changes of
  meaning go to the owner first; a rule you think wrong is listed for the owner, not fixed.
- A rule that must hold is never only in a skill: whether a skill loads is the model's call. It
  gets a check, or a line in the rules file.

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
| Rules file (`AGENTS.md`, or `CLAUDE.md` importing it) | Rules every change follows (one line each, with what enforces it and the mistake it came from), the commands, the folders, an index of what to read before which task | Every turn | Steps of a method; rules of one module; reasons at length; anything a check holds |
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
- A list that can be generated is generated, not kept: a file-by-file code map printed from the
  headers' first lines cannot fall behind the code.
- A header is seen only by a reader who opens the file. A rule needed before the file exists (how
  to add a new kind of thing) goes in a skill or the rules file, not only in a header.
- A long page (over about 100 lines) opens with its contents, so a reader can take one section.

### 2. Check the claim against the code

Read the code, the tool or the measurement the sentence describes, and write what it does now.
Where docs disagree, none of them is the source: the code is. A number the code holds is named by
its constant or linked, not copied. A claim about a source outside the repository is checked by
opening that source: credit only what its page states. A stale sentence you meet on the way is
fixed in the same change or reported to the owner, never passed over in silence.

### 3. Write it once; link from the rest

1. Search the repository for the fact or rule (its key words, its number, its file name).
2. Keep it where its kind lives (step 1). Replace each other copy with a link, or delete it.
3. A link names the page and section. The reader goes there only when the task needs it.

### 4. Keep the always-loaded text in budget (binding: Budget)

What loads up front and what is fetched on demand is decided by the task: a rule that every
change must follow belongs up front; a method, a manual or a fact belongs where it is fetched.
Every line of the rules file is paid for on every turn and lowers how well the rest is followed.
Before you add a line, take one out or move one to where it is owned. A rules file over its budget
is cut before the new line goes in. Moving a rule out of the rules file changes when it is read:
it goes to the owner with the changes of meaning, unless a check now holds it.

### 5. Turn what can be checked into a check (binding: Checks)

For a new rule, prefer in order: make the mistake impossible in the architecture, then in the
types, then a lint rule, then a test or a verify tool, then text. A rule written as text names the
mistake that led to it and what enforces it ("judgement" when nothing does). A text rule broken a
second time gets a check in the change that meets it.

Docs are kept true by checks too:

- every path into the docs, skills and tools written anywhere (code comments included) exists;
- Markdown links resolve offline; web links are checked separately, less often;
- each module's header opens with one sentence of purpose (the code map is printed from it);
- a table that mirrors code (options, settings) is checked against the code;
- each tracked skill is linked where the agent loads skills;
- the rules file stays within its budget.

### 6. Run the docs checks (binding: Checks)

Run the checks for what you touched before the commit. A failure is fixed at its cause: a path is
corrected, never added to an allow list without a reason written beside it.

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

Plain words, short sentences, one idea each. One term per thing, the same term throughout. The
present tense, the second person and the active voice; a condition before the instruction it
governs. Repository text is in the project's language whatever the language of the conversation.

Why the method works this way, and the sources: [background.md](background.md).
