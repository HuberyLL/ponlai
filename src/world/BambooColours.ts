// The bamboo's colours, which the material draws (BambooMaterials.ts) and the ambient probes see
// (AmbientProbes.ts), so that what the groves scatter stays the bamboo the eye sees. They live here
// because BambooMaterials.ts imports three and the probes are built in the chunk workers.

/** The culms' colours (linear albedo): new green, the age's end on most culms, its end on the
 * minority, the wax under the nodes. Green, dull and purple share an Oklab lightness of about 0.39. */
export const CULM = { green: [ 0.042, 0.07, 0.02 ], dull: [ 0.046, 0.066, 0.026 ], purple: [ 0.068, 0.054, 0.072 ], wax: [ 0.09, 0.09, 0.07 ] } as const;
/** The share of the culms whose age ends in the dusty purple. */
export const PURPLE_CULMS = 0.2;

/** The leaves' colours (sRGB): a clear green, a deeper one, a lighter one, young leaves and a few
 * old yellow ones, and their shares of a crown. */
export const LEAF_COLOURS = [ [ 62, 100, 36 ], [ 50, 84, 30 ], [ 76, 114, 42 ], [ 100, 132, 50 ], [ 150, 140, 66 ] ] as const;
export const LEAF_SHARE = [ 0.42, 0.27, 0.2, 0.08, 0.03 ] as const;
