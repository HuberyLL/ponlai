// The renderer's headless exit: its plain code, free of three.js, for the chunk worker and node.
//
// The renderer's headless exit: its plain code, free of three.js, which the island's chunk worker
// and node load (the noise, the sea's optical numbers, the formats of the data the world's chunks
// hand the renderer). Every file it loads imports relative paths only (tools/repo/verify-layers.mjs),
// and it loads in plain node (tools/repo/verify-exits.mjs). A name is in one exit only: these are not
// in render/index.ts.
export type { Bounds, ShoreField } from './RenderTypes.ts';
export { LEVEL_MARGIN } from './lighting/CasterFormat.ts';
export type { CasterColumns, SubmergedSubset } from './lighting/CasterFormat.ts';
export { META_VEC4, PROBE_STRIDE, SCATTER_VEC4, SEA_VEC4, shBasis } from './lighting/ProbeFormat.ts';
export type { AmbientLattice } from './lighting/ProbeFormat.ts';
export { bodyReflectance } from './ocean/SeaOptics.ts';
export { fbm2, hash3i, mulberry32, noise3, smax, smoothstep } from './util/noise.ts';
export type { Rng } from './util/noise.ts';
