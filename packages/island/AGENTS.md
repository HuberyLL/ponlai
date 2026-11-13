# The island's rules

`packages/island/` is the island: its world in chunks, grown in place, its materials, its look's
numbers, its camera, the islanders and creatures. These rules bind it alone; the root `AGENTS.md`
holds the rules every change follows.

- The world is built in chunks: a chunk's content is a function of its window, border data is
  bit-identical in both chunks, the chunks merge in their own order
  (`packages/island/world/Chunks.ts`, `packages/island/world/ChunkMerge.ts`). Partly held by
  `ponlai/chunk-normals` (no `computeVertexNormals` in `packages/island/world/`) and
  `verify-world-chunks` (determinism, seams and locality over grown lands), which
  `npm run check -- --full` runs; after a change to the world's generator, run
  `node tools/island/verify-world-chunks.mjs` before captures.
- The island grows in place: a Grow swaps the changed chunks in one frame, and what depends on the
  land's shape joins the swap (`packages/island/world/Growth.ts`). After such a change, run
  `verify-growth-swap` (the root's Checks run by hand).
