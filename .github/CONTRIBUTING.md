# Contributing to Ponlai

Thank you for your interest in Ponlai. This page says how to ask a question, report a bug and send
a change. Everyone who takes part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ask a question or share an idea

Ask questions, show what you made with the render pipeline or the tools, and float ideas in
[Discussions](https://github.com/HuberyLL/ponlai/discussions). Issues are for bugs and for concrete
requests.

## Report a bug

Open an issue with the bug form. Say what you saw and what you expected, the page's address with
its options, your browser, its version, your GPU and your operating system. A screenshot helps for
anything on screen.

Report a security issue privately, as [Security](SECURITY.md) says, never in a public issue.

## Before you start a change

For anything larger than a small fix, open an issue or a discussion first, so that we can agree on
the approach before you spend time on it.

## Set up

Follow the README's [Quick start](../README.md#quick-start). The checks and tools need a few more
programs: [lychee](https://lychee.cli.rs/) for the docs' lint, [uv](https://docs.astral.sh/uv/) for
the Python tools, and Playwright's Chromium for captures:

```bash
npx playwright install chromium
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Install lychee as its page says for your system.

## Make a change

1. Fork the repository and create a branch from `main`.
2. Follow the project's rules: [AGENTS.md](../AGENTS.md) lists them, written for AI coding agents,
   and every change follows it. Read the module's header comment before you change the module: it
   holds the module's rules and their reasons. Update it with the module's behaviour.
3. Follow the code style of three.js: tabs, spaces inside parentheses and brackets, and English
   comments that explain why.
4. Run the commit-time checks. They take seconds and need no GPU:

   ```bash
   npm run check
   ```

   The pull request's CI also runs the docs' lint (`npm run lint:docs`, which needs
   [lychee](https://lychee.cli.rs/)) and the production build (`npm run build`). A change to the
   world generator also passes `npm run check -- --full`, which adds the world's chunk checks.
5. If your change touches what renders, run the checks for it by hand on a machine with WebGPU
   ([AGENTS.md](../AGENTS.md#checks-run-by-hand)), and compare captures from before and after
   your change ([Verifying rendering changes](../skills/verifying-rendering-changes/SKILL.md)). If
   you cannot run them, say so in the pull request.

If you work with an AI coding agent, have it read `AGENTS.md` first. You remain responsible for
every line you send.

### Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/):
`type(scope): summary`, in lower case, in the imperative, with no full stop, then a body that says
why. The types are `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`,
`chore` and `revert`.

### Assets and third-party code

- Assets never go into git. If your change needs a new texture, model or other file, describe it in
  the pull request with its source and licence; the maintainer publishes it in a new asset release.
- Third-party code opens with a `/*! ... */` notice that names its source and carries its SPDX
  copyright and licence tags, and its licence must allow the MIT release. The licence texts are in
  `LICENSES/`, and [Credits](../CREDITS.md) lists the sources that ask for a credit.

## Send a pull request

- Keep a pull request to one change, and say what it changes and why.
- For a change on screen, include before and after screenshots of the same view.
- Fill in the pull request's checklist.
- The CI must pass. A first-time contributor's CI starts once the maintainer approves it.

The maintainer reviews the pull request and merges it.

## Licence

Your contribution is released under the project's [MIT License](../LICENSE), the licence of the
project itself.
