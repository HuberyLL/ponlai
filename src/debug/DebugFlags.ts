// Runtime switches for timing a change inside one page (debug builds expose them as
// window.__PONLAI__.flags). An optimisation under development keeps its old path and reads a flag
// where it chooses between the two, every frame:
//
//   import { debugFlags } from '../debug/DebugFlags.ts';
//   const mesh = debugFlags.lowPolyGrass ? newGrass : oldGrass;   // or skip a pass, pick a material
//
// and tools/profile-frame.mjs flips it every few frames with --toggle "s.flags.lowPolyGrass = on",
// after warming both paths, to A/B it in seconds without a reload. A shader change keeps both
// materials (or both nodes) built and swaps them on the flag, rather than branching inside one
// shader, so each side runs its own pipeline. A missing flag reads as undefined: the old path
// while a change is under development. Once an optimisation ships, a missing flag must mean the
// shipped path, so its flag either selects the old path only on an explicit `false`
// (`flags.ssrCull = false`) or is named for the old path (`flags.skyWholeBake = true`); the code
// that reads the flag says which. --toggle sets the flag explicitly on both sides either way.
export const debugFlags: Record<string, boolean | number | string | undefined> = {};
