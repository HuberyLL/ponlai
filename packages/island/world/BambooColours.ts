// The bamboo's colours, shared by its material and the ambient probes.
//
// The bamboo's colours, which the material draws (BambooMaterials.ts) and the ambient probes see
// (AmbientProbes.ts), so that what the groves scatter stays the bamboo the eye sees. They live here
// because BambooMaterials.ts imports three and the probes are built in the chunk workers.

/** The culms' colours (linear albedo): new green, the age's end on most culms, its end on the
 * minority, the wax under the nodes. Green, dull and purple share an Oklab lightness of about 0.39.
 * Purple is a violet whose red stands no higher than its green: a low sun is rich in red, and any
 * more red turns these culms a rust that leaves the grove's olive, while less leaves a slate blue
 * under cloud. A little rose stays on them at the golden hour. */
export const CULM = { green: [ 0.042, 0.07, 0.02 ], dull: [ 0.046, 0.066, 0.026 ], purple: [ 0.058, 0.058, 0.075 ], wax: [ 0.09, 0.09, 0.07 ] } as const;
/** The share of the culms whose age ends in the dusty purple. */
export const PURPLE_CULMS = 0.2;

/** The leaves' colours (sRGB): a clear green, a deeper one, a lighter one, young leaves and a few
 * old yellow ones, and their shares of a crown. Their mean in linear (0.081, 0.137, 0.034), at
 * shared.ts leafGain 1: red about 0.6 of green, below the blades' 0.7, so the crowns stay a little
 * cooler than the meadow in every light, and blue about a quarter of it, which keeps their hue on a
 * cool green under the sun where red alone would turn it toward the meadow's. */
export const LEAF_COLOURS = [ [ 71, 100, 48 ], [ 57, 84, 41 ], [ 86, 114, 56 ], [ 113, 132, 66 ], [ 169, 140, 86 ] ] as const;
export const LEAF_SHARE = [ 0.42, 0.27, 0.2, 0.08, 0.03 ] as const;
/** A leaf's underside (sRGB): a little duller and darker than the clear green. */
export const LEAF_UNDER = 'rgb(64,90,51)';
