import * as THREE from 'three/webgpu';
import { noise3, smoothstep } from '../world/noise.ts';
import { GROWTH } from '../world/IslandGrowth.ts';
export { MEADOW_MIN_UP, MEADOW_MAX_DROP, supportsMeadow } from '../world/MeadowSurface.ts';

// The lawn is one grass colour (docs/art-direction.md): every tuft takes it and the turf under
// the blades shows it too, so the far meadow, where the blades are under a pixel and the turf shows
// between them, reads as one carpet with the near blades. Only a gentle, low-frequency swing of its
// value (+-4 %, drifts some 10 m across) keeps a large lawn from looking printed; the blades' own
// root-to-tip colour (Grass.ts) carries the rest. Separate fields of tone, dryness and hue, and a
// field of bare earth, once broke it into patches that from the overview read as camouflage and
// dark blotches.
// The growth field is the island top's structure for the root bed at the rim (Soil.ts); the lawn
// grows to one height (SWARD_HEIGHT) on ordinary soil. The habitat fields (`meadowMoisture`,
// `meadowTurf`) site the wildflowers' patches; `meadowTurf` is the sward the soil grows
// (`meadowSoil`, below: the wind's exposure and the soil's depth). Where the ground is exposed the
// lawn grows short and a fresher yellow-green, as thick as elsewhere (`soilShort`); on the windward
// edge's first few metres and on headland tips its blades thin and dry soil and pale limestone
// gravel show between them (`soilCore`), and in stretches of the edge some 3 - 12 m long, turf to
// the edge between them, the cliff's own stone over its last 0.5 - 1.2 m (`soilOutcrop`,
// `outcropStretch`); where the soil is deep the lawn grows a little taller and deeper green
// (`soilDeep`). Each tier fades in over a few metres and goes lighter and yellower, never darker.
// The map covers the land lattice's whole extent, wherever the island grows, at 0.25 m: RGB the
// turf's colour, A the noise that frays the soil's zones (`meadowTongue`; read faster and folded
// over, it also sets the lip's stretches of stone, `outcropNoise`).
export const MEADOW_EXTENT = 2 * GROWTH.half;
const MEADOW_SIZE = MEADOW_EXTENT * 4;

/** The lawn's tuft height scale (m): every tuft of the plateau grows to it, its flower heads
 * among its blades' tips (Grass.ts). */
export const SWARD_HEIGHT = 0.28;

interface MeadowSample { growth: number; tone: number }

// Linear albedo, before the blades' root-to-tip colour: a muted, slightly cool green (red at
// about 0.8 of green on screen, and enough blue that the lit lawn reads soft and green rather than
// lime; the yellow of the lit tips comes from the light through them, Grass.ts).
const LAWN = new THREE.Color( 0.06, 0.1, 0.029 );

export function sampleMeadow( x: number, z: number ): MeadowSample {

	const broad = noise3( x * 0.24 + 2.7, 0.5, z * 0.24 - 1.3 ) * 0.5 + 0.5;
	const clump = noise3( x * 0.65 - 3.1, 2.5, z * 0.65 + 4.8 ) * 0.5 + 0.5;
	const growth = smoothstep( 0.3, 0.7, broad * 0.72 + clump * 0.28 );
	const tone = noise3( x * 0.1 + 11.3, 7.7, z * 0.1 - 4.6 );
	return { growth, tone };

}

// The meadow's habitat: two broad fields of fixed seeds that say where its plants grow, the way a
// real island top's turf and wildflowers follow the ground (Grass.ts sites the flower patches by
// them). Neither changes the lawn's colour or height yet.

/** The ground's moisture under the meadow at ( x, z ), 0 dry to 1 damp: a low-frequency field (its
 * drifts some 25 m across), so the island top has a damp hollow or two and a dry stretch or two. */
export function meadowMoisture( x: number, z: number ): number {

	return smoothstep( - 0.45, 0.45, noise3( x * 0.035 + 21.7, 4.3, z * 0.035 - 13.9 ) );

}

// The soil (docs/art-direction.md, the meadow): on a real island top the salt spray and the wind
// come from the prevailing wind's side, and they set the turf. On the windward coast a band of
// short, salt-pruned turf reaches far in from the edge, the farther the more exposed the coast; on
// the lee coast the tall turf runs to the edge. A headland, the sea round it on several sides, is
// the most exposed (the turf shortest, the soil thinnest, the stone showing most); a cove the
// least. The spray thins inland, so the short turf's inner edge is ragged, with tongues of it
// stretched downwind into the ordinary sward. The soil is thinnest at the windward lip and on
// headland tips, and deepest on the sheltered ground far from any coast, where the island's tall
// grasses will grow. (Cliff-top vegetation in the JNCC and EUNIS descriptions of sea cliffs; a
// Californian headland's soil salinity and annual grasses zoned some 240 m in from its edge;
// the grazed turf on top of the Oki islands' Matengai cliff and the wind-cropped turf of Penghu's
// basalt mesas.)
// So the soil is a function of the land's shape and the wind at rest (Wind.ts: heading 40 degrees,
// coming from UPWIND), read from the world's shore field: `exposure` sums how much of the ground
// upwind is sea (SOIL.reach and SOIL.weight: near sea counts most; a sample counts fully only once
// the coast lies SOIL.open of its distance behind it, so the samples that just clear a small
// island's far coast leave its lee green), scaled by the sea on either side of the wind
// (SOIL.side: a headland into the wind takes more, a cove less, a lee shore nothing), with a little
// more on the lip itself (SOIL.lip, the coast's own salt: the lee keeps 0 - 1 m of short turf at
// most). Noise only frays the exposed ground's edges (none where the exposure is under SOIL.fray):
// stretched SOIL.stretch times along the wind (`meadowTongue`, the meadow map's A channel), it
// draws the short turf's inner edge out into downwind tongues and gives the moderately exposed
// ground downwind of the windward coast a streak or two. The soil's `depth` is the shelter squared
// times the distance from the coast (SOIL.far) times a broad field (SOIL.deepRate, a few patches
// across a large island; only the grass reads it). Measured on the anchors (each about equal area):
// at the twelfth growth step the short tier is some 27 % of the meadow (the windward coast's band
// 21 %, half of it 6 m deep and its tongues to 13 m; the lee coast's 0 - 1 m 4 %; inland streaks
// under 1 %), its core 4 % and deep soil 14 %; at the start the short tier is 46 % (the windward
// half of a small island), its core 11 %, deep soil 3 % at its centre, the lee half green. The grass
// (Grass.ts, on the CPU, the shore field bilinear) and the ground (TerrainMaterial.ts, the same
// samples of the shore texture, nine a pixel of the island's ground) read the same function; the
// hanging grass and the lip's stone (`outcropReach`, one more sample of the map) too. Measured on
// the cached land's top edge (the windward coast facing within 73 degrees of the wind): at the
// twelfth step the stone shows on 36 % of it (on 83 % of its headland tips), in stretches of 4 - 14 m
// (median 7 m) with turf to the edge over 2 - 18 m between them (median 6 m); at the start on 46 %,
// in two stretches of 7 and 8 m.

/** The prevailing wind's origin at rest: the unit vector toward where it comes from (Wind.ts's
 * heading of 40 degrees; RimGrass.ts PREVAILING is its travel, the opposite). */
export const UPWIND = [ Math.cos( 40 * Math.PI / 180 ), Math.sin( 40 * Math.PI / 180 ) ];

/** The soil's numbers (see above): the upwind samples' distances (m) and weights; the off-wind
 * samples' angles from upwind (degrees, taken either side), distance (m) and the scale they set
 * (base + gain times their mean sea); how far below the cliff's top edge a sample starts to count
 * as sea (`soft`, m) and the share of its distance the coast must lie behind it to count fully
 * (`open`); the lip's own exposure (its range of m in from the edge and its weight); the tongues'
 * noise (amplitude, across-wind rates in cycles per metre with their weights, their stretch along
 * the wind, and the exposure below which they fade out, `fray`); the depth's distance from the
 * coast (m) and its broad field (rate in cycles per metre, the noise's range); and the lip's stone:
 * how far in from the edge it shows at most (m) as the exposure rises over `outcrop`, in stretches
 * where the tongues' noise read at `outcropRate` times its scale (`outcropNoise`), raised on
 * headlands (`outcropHead` times the sea either side less a half), clears `outcropGate` (the
 * reach growing from 0 to `outcropWidth` over that range). */
export const SOIL = {
	reach: [ 3, 9, 18, 34 ], weight: [ 0.35, 0.3, 0.2, 0.15 ],
	side: [ 50, 100 ], sideReach: 6, sideBase: 0.7, sideGain: 0.6,
	soft: 1, open: 0.6, lip: [ 0.3, 2 ], lipWeight: 0.1,
	tongue: 1.6, tongueRate: [ 0.09, 0.25 ], tongueMix: [ 0.8, 0.3 ], stretch: 3.5, fray: 0.15,
	far: [ 1.5, 8 ], deepRate: 0.04, deepNoise: [ - 0.6, 0.3 ],
	outcrop: [ 0.55, 0.9 ], outcropWidth: 1.2, outcropGate: [ 0.5, 0.65 ], outcropHead: 0.7, outcropRate: 2,
	// the tiers: short turf over `short` of the exposure; its core (sparse, soil and gravel showing)
	// over `core`, and only within `coreReach` m of the edge (its first value full, its second none);
	// deep soil over `deep` of the depth
	short: [ 0.2, 0.34 ], core: [ 0.7, 0.88 ], coreReach: [ 2.5, 4.5 ], deep: [ 0.53, 0.78 ],
};
// The sea-level coast of the shore field lies about SHORE_RIM in from the cliff's top edge the
// anchors measure (the sea-level section against the top's outline, 0.75 - 0.87 m): the top edge's
// distance is shore + SHORE_RIM.
export const SHORE_RIM = - 0.8;
// The short turf's colour against the lawn's (a multiplier of its linear albedo, the blades' and the
// turf's under them alike): toward yellow by more red and less blue, a little lighter, so it reads
// as a fresher yellow-green, as alive as the lawn, never as straw or a darker patch. The most
// exposed ground (EXPOSED over the exposure) goes a little yellower still (EXPOSED_TINT), so the
// windward coast reads from the island view; never darker.
export const SHORT_TINT = [ 1.3, 1.12, 0.62 ], EXPOSED_TINT = [ 1.1, 1.05, 0.86 ], EXPOSED = [ 0.75, 1 ];

/** The soil at a point: its `exposure` to the wind and salt (0 sheltered, 1 the windward lip or a
 * headland's tip), its `depth` (0 thin, 1 deep), how far in from the cliff's top edge it lies
 * (`inside`, m) and how far in the lip's stone shows there (`outcropReach`, m). */
export interface MeadowSoil { exposure: number; depth: number; inside: number; outcropReach: number }

/** The shore field's signed distance (m, negative on land) at a point, as Grass.ts samples it. */
export type ShoreAt = ( x: number, z: number ) => number;

/** The soil at ( x, z ) on the land the shore field `shore` describes. */
export function meadowSoil( x: number, z: number, shore: ShoreAt ): MeadowSoil {

	return meadowSoilWith( SOIL, x, z, shore );

}

/** `meadowSoil` with the numbers `P` (a sweep's). */
export function meadowSoilWith( P: typeof SOIL, x: number, z: number, shore: ShoreAt ): MeadowSoil {

	// a sample's sea counts fully once the coast lies `open` of its distance behind it, so far samples
	// that only just clear a small island's far coast add little
	const sea = ( d: number, t: number ) => smoothstep( - P.soft, t * P.open, d + SHORE_RIM );
	let e = 0, side = 0;
	for ( let k = 0; k < P.reach.length; k ++ ) e += P.weight[ k ] * sea( shore( x + UPWIND[ 0 ] * P.reach[ k ], z + UPWIND[ 1 ] * P.reach[ k ] ), P.reach[ k ] );
	for ( const degrees of P.side ) for ( const turn of [ - 1, 1 ] ) {

		const a = turn * degrees * Math.PI / 180, c = Math.cos( a ), s = Math.sin( a );
		side += sea( shore( x + ( UPWIND[ 0 ] * c - UPWIND[ 1 ] * s ) * P.sideReach, z + ( UPWIND[ 0 ] * s + UPWIND[ 1 ] * c ) * P.sideReach ), P.sideReach );

	}
	// the sea either side of the wind only scales the exposure the upwind sea gives: a headland into
	// the wind takes more, a cove less, a lee shore none
	e *= P.sideBase + P.sideGain * side / ( 2 * P.side.length );
	const inside = - ( shore( x, z ) + SHORE_RIM );
	e += P.lipWeight * ( 1 - smoothstep( P.lip[ 0 ], P.lip[ 1 ], inside ) );
	// the noise frays only exposed ground's edges
	const tongue = meadowTongueWith( P, x, z );
	const exposure = Math.min( Math.max( e + P.tongue * ( tongue - 0.5 ) * smoothstep( 0, P.fray, e ), 0 ), 1 );
	return {
		exposure,
		depth: ( 1 - exposure ) ** 2 * smoothstep( P.far[ 0 ], P.far[ 1 ], inside ) * smoothstep( P.deepNoise[ 0 ], P.deepNoise[ 1 ], noise3( x * P.deepRate + 5.3, 21.4, z * P.deepRate - 8.1 ) ), inside,
		outcropReach: P.outcropWidth * smoothstep( P.outcrop[ 0 ], P.outcrop[ 1 ], exposure )
			* outcropStretch( P, outcropNoiseWith( P, x, z ), side / ( 2 * P.side.length ) ),
	};

}

/** Where along the coast the lip's stone shows, 0 to 1 (its share of the reach), from the noise
 * `noise` (`outcropNoise`) and the mean sea `sea` either side of the wind (0 - 1): along the
 * windward coast, which runs across the wind, the noise rises and falls every 10 m or so, so the
 * stone shows in stretches of some 3 - 12 m with turf to the edge between them, its inner edge
 * widening from the stretch's ends to its middle; a headland tip, sea on either side, keeps the
 * most. The ground (TerrainMaterial.ts) reads it from the same samples. */
export function outcropStretch( P: typeof SOIL, noise: number, sea: number ): number {

	return smoothstep( P.outcropGate[ 0 ], P.outcropGate[ 1 ], noise + P.outcropHead * ( sea - 0.5 ) );

}

/** The noise the lip's stone comes in stretches by: the tongues' (`meadowTongue`) at SOIL.outcropRate
 * times their rate, the map folded over (its extent repeats), so the ground reads it from the same
 * map (the meadow map's A channel, at `outcropMapUv`). */
export function outcropNoise( x: number, z: number ): number {

	return outcropNoiseWith( SOIL, x, z );

}

function outcropNoiseWith( P: typeof SOIL, x: number, z: number ): number {

	const fold = ( v: number ) => ( v / MEADOW_EXTENT + 0.5 - Math.floor( v / MEADOW_EXTENT + 0.5 ) - 0.5 ) * MEADOW_EXTENT;
	return meadowTongueWith( P, fold( x * P.outcropRate + OUTCROP_SHIFT[ 0 ] ), fold( z * P.outcropRate + OUTCROP_SHIFT[ 1 ] ) );

}
// The folded map's shift (m), so the stretches' noise is not the tongues' own at the island's centre.
export const OUTCROP_SHIFT = [ 37.1, - 21.7 ];

/** The noise that frays the soil's zones, 0 to 1, stretched along the wind: the meadow map's A
 * channel. */
export function meadowTongue( x: number, z: number ): number {

	return meadowTongueWith( SOIL, x, z );

}

function meadowTongueWith( P: typeof SOIL, x: number, z: number ): number {

	const along = ( x * UPWIND[ 0 ] + z * UPWIND[ 1 ] ) / P.stretch, across = z * UPWIND[ 0 ] - x * UPWIND[ 1 ];
	const [ f0, f1 ] = P.tongueRate, [ m0, m1 ] = P.tongueMix;
	const n = noise3( along * f0 - 17.2, 9.1, across * f0 + 6.4 ) * m0 + noise3( along * f1 + 3.3, 12.7, across * f1 - 9.8 ) * m1;
	return Math.min( Math.max( n * 0.5 + 0.5, 0 ), 1 );

}

/** The sward the soil `soil` grows, 0 short to 1 tall: the wildflowers' habitat (Grass.ts). */
export function meadowTurf( soil: MeadowSoil ): number {

	return ( 1 - soilShort( soil.exposure ) ) * ( 0.55 + 0.45 * soilDeep( soil.depth ) );

}

/** How short the turf at exposure `exposure` grows: 1 short, 0 ordinary or deep. */
export function soilShort( exposure: number ): number {

	return smoothstep( SOIL.short[ 0 ], SOIL.short[ 1 ], exposure );

}

/** How far the soil `soil` is in the short tier's core, where the blades thin and the soil shows:
 * 1 at its heart, 0 outside. */
export function soilCore( soil: MeadowSoil ): number {

	return smoothstep( SOIL.core[ 0 ], SOIL.core[ 1 ], soil.exposure ) * ( 1 - smoothstep( SOIL.coreReach[ 0 ], SOIL.coreReach[ 1 ], soil.inside ) );

}

/** How deep the soil of depth `depth` is: 0 ordinary or thin, 1 deep. */
export function soilDeep( depth: number ): number {

	return smoothstep( SOIL.deep[ 0 ], SOIL.deep[ 1 ], depth );

}

/** How far the lip's stone shows at a point `rim` m from the cliff's top edge (negative inside),
 * where it reaches `reach` m in (`MeadowSoil.outcropReach`): 1 on the stone, fading over
 * OUTCROP_FADE m either side of its reach, and in as the reach opens. The reach stays within the rim
 * field's clamp (RimGround.ts RIM_REACH), so the ground and the grass read it from that field. */
export function soilOutcrop( rim: number, reach: number ): number {

	return smoothstep( - reach - OUTCROP_FADE, - reach + OUTCROP_FADE, rim ) * smoothstep( 0, 2 * OUTCROP_FADE, reach );

}
export const OUTCROP_FADE = 0.3;

function colorFromSample( sample: MeadowSample, target: THREE.Color ): THREE.Color {

	return target.copy( LAWN ).multiplyScalar( 1 + sample.tone * 0.04 );

}

export function meadowColor( x: number, z: number, target: THREE.Color ): THREE.Color {

	return colorFromSample( sampleMeadow( x, z ), target );

}

export function createMeadowTexture(): THREE.DataTexture {

	const data = new Uint8Array( MEADOW_SIZE * MEADOW_SIZE * 4 );
	const color = new THREE.Color();
	for ( let row = 0; row < MEADOW_SIZE; row ++ ) {

		const z = ( ( row + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
		for ( let column = 0; column < MEADOW_SIZE; column ++ ) {

			// Bake texel centres so xz / MEADOW_EXTENT + 0.5 agrees with CPU instance colours.
			const x = ( ( column + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
			const sample = sampleMeadow( x, z );
			colorFromSample( sample, color );
			const k = ( row * MEADOW_SIZE + column ) * 4;
			data[ k ] = Math.round( color.r * 255 );
			data[ k + 1 ] = Math.round( color.g * 255 );
			data[ k + 2 ] = Math.round( color.b * 255 );
			data[ k + 3 ] = Math.round( meadowTongue( x, z ) * 255 );

		}

	}

	const texture = new THREE.DataTexture( data, MEADOW_SIZE, MEADOW_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType );
	// Values are already linear; conversion would separate the turf from its blade colours.
	texture.colorSpace = THREE.NoColorSpace;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	texture.name = 'meadow';
	return texture;

}
