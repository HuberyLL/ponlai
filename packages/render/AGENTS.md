# The render pipeline's rules

`packages/render/` is the render pipeline, built without the island: light, sky, sea, weather, the
vegetation's shared parts, the frame's passes and graph, the look's readers, three's internals.
These rules bind it alone; the root `AGENTS.md` holds the rules every change follows, and its
Shaders and GPU work the ones the island shares.

## Shaders and passes

Each rule names its section of `docs/reference/three-behaviour.md`, which holds its detail.

- A texture's history is declared on the graph; what a frame reads from the one before advances
  once per frame (Previous-frame data; partly: `ponlai/history-on-graph`, `verify-framegraph`).
- Multiple render targets: the `outputStruct` itself (Multiple render targets).
- Bit-identical depth takes `@invariant` (Bit-identical depth).
- A full-screen pass takes the scene camera as uniforms (A full-screen pass's camera).
- Multisampled depth by `textureLoad` (Multisampled depth).

## Checks run by hand

- After a change to the render pipeline, run `tools/render/scenes.mjs` first: the render pipeline's
  test scenes, checked in seconds.
