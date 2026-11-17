# The island's rules

`packages/island/` is the island: its world in chunks, grown in place, its materials, its values
for the look's tables, its camera, the islanders and the creatures. These rules apply to this folder
alone; the root `AGENTS.md` holds the rules every change follows.

- The world is built in chunks. A chunk's content is a function of its window, data on a border is
  bit-identical in both chunks that share it, and the chunks merge in their own order
  (`packages/island/world/Chunks.ts`, `packages/island/world/ChunkMerge.ts`). This is partly
  checked by `ponlai/chunk-normals` (no `computeVertexNormals` in `packages/island/world/`) and by
  `verify-world-chunks` (determinism, seams and locality over grown lands), which
  `npm run check -- --full` runs. After a change to the world's generator, run
  `node tools/island/verify-world-chunks.mjs` before taking captures.
- The island grows in place. A Grow (`grow()`) swaps the changed chunks in within one frame, and
  everything that depends on the land's shape joins the swap (`packages/island/world/Growth.ts`).
  After such a change, run `verify-growth-swap` (the root `AGENTS.md`, Checks run by hand).
