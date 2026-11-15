import { mulberry32 } from '../../render/data.ts';

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

/** The leaves' own colours in the atlas (sRGB) and their shares: a clear green about the band's
 * middle (LEAF_BAND), a little darker and lighter ones, and a few old yellow leaves; each leaf a
 * little lighter or darker again (BambooMaterials.ts leafAtlas). A crown's colour is its plant's,
 * from the band; the atlas keeps only small changes of lightness between its leaves. */
export const LEAF_COLOURS = [ [ 74, 105, 53 ], [ 67, 98, 49 ], [ 81, 112, 57 ], [ 150, 132, 76 ] ] as const;
export const LEAF_SHARE = [ 0.45, 0.27, 0.25, 0.03 ] as const;

/** The crowns' mean albedo (linear): red about 0.6 of green, below the meadow blades' 0.7, so the
 * crowns stay a little cooler than the meadow in every light, and blue about a quarter of it,
 * which keeps their hue on a cool green under the sun. */
const LEAF_CROWNS = [ 0.081, 0.137, 0.034 ] as const;
const DARK_SHARE = 0.12, DARK = [ 0.025, 0.033, 0.018 ] as const, LIGHT = [ 0.103, 0.148, 0.035 ] as const;

/** The band each plant's leaves take their colour from (linear albedo): a dull grey green at its
 * dark end (a linear luminance of 0.03), a clear saturated green in its middle and a pale yellow
 * green at its light end (0.13), hue and lightness moving together along it. A plant's place on
 * the band (`leafBandAt`) falls in the dark half for `darkShare` of the plants, evenly within
 * each half, so most plants are between the middle and the light end. The middle is what makes
 * the plants' mean the crowns' (`LEAF_CROWNS`): its luminance comes out about 0.117. */
export const LEAF_BAND = {
	dark: DARK, light: LIGHT, darkShare: DARK_SHARE,
	// the mean over the plants is darkShare ( dark + middle ) / 2 + ( 1 - darkShare ) ( middle + light ) / 2
	middle: LEAF_CROWNS.map( ( m, c ) => ( m - DARK_SHARE / 2 * DARK[ c ] - ( 1 - DARK_SHARE ) / 2 * LIGHT[ c ] ) / 0.5 ) as [ number, number, number ],
} as const;

/** A plant's place on the leaf band (0 the dark end, 1 the light end) from its seed
 * (BambooGroves.ts CulmSite `seed`), by a hash of its own. */
export function leafBandAt( seed: number ): number {

	return leafBandOf( mulberry32( seed ^ 0x1eafba4d )() );

}

/** The place on the leaf band at `u`, a uniform draw (0..1): the dark half for `darkShare` of it. */
export function leafBandOf( u: number ): number {

	const s = LEAF_BAND.darkShare;
	return u < s ? 0.5 * u / s : 0.5 + 0.5 * ( u - s ) / ( 1 - s );

}

/** The leaf band's colour at `t` (linear). */
export function leafBandColour( t: number ): [ number, number, number ] {

	const { dark, middle, light } = LEAF_BAND;
	return [ 0, 1, 2 ].map( ( c ) => t < 0.5 ? dark[ c ] + ( middle[ c ] - dark[ c ] ) * 2 * t : middle[ c ] + ( light[ c ] - middle[ c ] ) * ( 2 * t - 1 ) ) as [ number, number, number ];

}

/** The atlas's mean colour (linear), its leaves' colours by their shares. */
export const LEAF_ATLAS_MEAN = [ 0, 1, 2 ].map( ( c ) => LEAF_COLOURS.reduce( ( sum, rgb, k ) => sum + srgbToLinear( rgb[ c ] ) * LEAF_SHARE[ k ], 0 ) ) as [ number, number, number ];

/** Each plant's factor over the atlas at the band's three keys (linear), the plant's colour over
 * the atlas's mean, which the leaves' material lays over the atlas (BambooMaterials.ts BAMBOO_TINT). */
export const LEAF_BAND_FACTORS = [ LEAF_BAND.dark, LEAF_BAND.middle, LEAF_BAND.light ].map( ( key ) => key.map( ( v, c ) => v / LEAF_ATLAS_MEAN[ c ] ) as [ number, number, number ] );

/** The crowns' mean albedo (linear): the atlas's mean times each plant's factor, averaged over
 * the plants' places on the band (the ambient probes', AmbientProbes.ts). */
export const LEAF_MEAN = [ 0, 1, 2 ].map( ( c ) => {

	const [ f0, f1, f2 ] = LEAF_BAND_FACTORS.map( ( f ) => f[ c ] ), s = LEAF_BAND.darkShare;
	return LEAF_ATLAS_MEAN[ c ] * ( s * ( f0 + f1 ) / 2 + ( 1 - s ) * ( f1 + f2 ) / 2 );

} ) as [ number, number, number ];

/** The atlas's ground under its leaves (sRGB): their mean colour, so its mips keep the leaves'
 * colour at their edges (vegetation/TreeSurfaces.ts LeafPainter). Both faces of a leaf take the
 * atlas's colour. */
export const LEAF_UNDER = `rgb(${ LEAF_ATLAS_MEAN.map( ( v ) => Math.round( 255 * linearToSrgb( v ) ) ).join( ',' ) })`;

/** An 8-bit sRGB value in linear. */
export function srgbToLinear( v: number ): number {

	const c = v / 255;
	return c <= 0.04045 ? c / 12.92 : ( ( c + 0.055 ) / 1.055 ) ** 2.4;

}

function linearToSrgb( v: number ): number {

	return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** ( 1 / 2.4 ) - 0.055;

}
