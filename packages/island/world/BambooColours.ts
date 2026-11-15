// The bamboo's colours, shared by its material and the ambient probes.
//
// The bamboo's colours, which the material draws (BambooMaterials.ts) and the ambient probes see
// (AmbientProbes.ts), so that what the groves scatter stays the bamboo the eye sees. They live here
// because BambooMaterials.ts imports three and the probes are built in the chunk workers.

/** The culms' colours (linear albedo): new green, the age's end, the brown mottle of old culms, the
 * wax under the nodes. The green is a warm olive (red about three quarters of green, a linear
 * luminance about 0.07), the old darker (about 0.65 times) and browner, the mottle a dull brown
 * about as dark, the wax a little paler. Most culms are old, so the old colour sets the groves'
 * mean: about 0.052, which keeps a culm the sun lights at a low sun darker than the lit crowns. */
export const CULM = { green: [ 0.058, 0.078, 0.03 ], old: [ 0.042, 0.05, 0.019 ], mottle: [ 0.048, 0.042, 0.017 ], wax: [ 0.10, 0.105, 0.085 ] } as const;
/** The culms' mottle: its cover of an old culm's foot (it grows with the culm's age from none on a
 * new one), and the share of that cover left at the culm's top. */
export const MOTTLE = { cover: 0.3, top: 0.25 } as const;
/** The ring at each node: its width (of the internode), its colour over the internode's (a pale
 * yellowish band, its luminance about 1.37 times), and the darker band of the same width above it. */
export const NODE_RING = { width: 0.025, light: [ 1.45, 1.38, 1.12 ], dark: 0.85 } as const;

/** The leaves' colours (sRGB): a clear green, a deeper one, a lighter one, young leaves and a few
 * old yellow ones, and their shares of a crown. Their mean in linear (0.081, 0.137, 0.034), at
 * shared.ts leafGain 1: red about 0.6 of green, below the blades' 0.7, so the crowns stay a little
 * cooler than the meadow in every light, and blue about a quarter of it, which keeps their hue on a
 * cool green under the sun where red alone would turn it toward the meadow's. */
export const LEAF_COLOURS = [ [ 71, 100, 48 ], [ 57, 84, 41 ], [ 86, 114, 56 ], [ 113, 132, 66 ], [ 169, 140, 86 ] ] as const;
export const LEAF_SHARE = [ 0.42, 0.27, 0.2, 0.08, 0.03 ] as const;
/** A leaf's underside (sRGB): a little duller and darker than the clear green. */
export const LEAF_UNDER = 'rgb(64,90,51)';
