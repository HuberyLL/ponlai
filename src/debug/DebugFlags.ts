// Runtime switches for timing a change inside one page (debug builds expose them as
// window.__SOOMI__.flags). An optimisation under development keeps its old path and reads a flag
// where it chooses between the two, every frame:
//
//   import { debugFlags } from '../debug/DebugFlags.ts';
//   const mesh = debugFlags.lowPolyGrass ? newGrass : oldGrass;   // or skip a pass, pick a material
//
// and tools/profile-frame.mjs flips it every few frames with --toggle "s.flags.lowPolyGrass = on",
// after warming both paths, to A/B it in seconds without a reload. A shader change keeps both
// materials (or both nodes) built and swaps them on the flag, rather than branching inside one
// shader, so each side runs its own pipeline. A missing flag reads as undefined (the old path).
export const debugFlags: Record<string, boolean | number | string | undefined> = {};
