# The renderer's rules

`packages/render/` is the renderer, built without the island: light, sky, sea, weather, the
vegetation's shared parts, the frame's passes and graph, the look's readers, three's internals.
These rules bind it alone; the root `AGENTS.md` holds the rules every change follows, and its
Shaders and GPU work the ones the island shares.

## Shaders and passes

Each rule names its section of `docs/reference/three-behaviour.md`, which holds its detail.

- A texture's history is declared on the graph; what a frame reads from the one before advances
  once per frame (The frame before).
- Several attachments: the `outputStruct` itself (Several attachments).
- Bit-identical depth takes `@invariant` (Bit-identical depth).
- Screen uv, NDC and depth conventions (Screen conventions).
- A full-screen pass takes the scene camera as uniforms (A full-screen pass's camera).
- Multisampled depth by `textureLoad` (Multisampled depth).
- Temporal modes: velocity, MRT blends, unjittered projection, scene events (Temporal modes).

## Checks run by hand

- After a change to the renderer, run `tools/render/scenes.mjs` first: the renderer's test scenes,
  checked in seconds.
- After a change to instancing or to an index rewritten in place, run `verify-growth-swap`: instanced
  kinds keep a fixed capacity (Instance matrices); an index rewritten in place is a `Uint32Array`
  (Index buffers).
