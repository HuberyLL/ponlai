# The tools' rules

`tools/` holds the checks, captures, probes, profiling, the GPU lock and the code lint
(`tools/repo/lint/`). Each tool's manual is its header, indexed by question in
`docs/reference/tools.md`; a new tool or check follows the `writing-tools-and-checks` skill. These
rules bind this folder alone; the root `AGENTS.md` holds the rules every change follows.

- A new CPU-heavy tool imports `tools/kit/qos.mjs` first.
