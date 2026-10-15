import { uniform } from 'three/tsl';

// FSR 3's texture mip bias (AMD's guide: log2( render width / display width ) - 1), as the scale it
// takes on explicit sampling gradients: 2^bias. WebGPU samplers have no LOD bias and a `.bias()`
// on an implicit sample changes every sampling shader, so under fsr3 only (Antialiasing.ts
// `FSR3`, read when a material is built) the surfaces that sample screen-space detail through
// explicit gradients multiply them by this uniform: the terrain's triplanar heights, normals and
// rock scan (TerrainMaterial.ts, which HexTiling.ts's reads share). The upscaler sets it every frame
// from the live render and canvas widths (Fsr3Upscaler.ts), 1 (no bias) under
// `debugFlags.fsrMipBias = false`; a value change builds no pipeline. Other modes' shaders do not
// read it.
export const fsr3MipBiasScale = uniform( 1 );
