import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { noise3, smoothstep } from '../../render/data.ts';
import { GROWTH } from '../world/IslandGrowth.ts';
import { cellStream } from '../world/Anchors.ts';
export { MEADOW_MIN_UP, MEADOW_MAX_DROP, supportsMeadow } from '../world/MeadowSurface.ts';

// The meadow's ground: the lawn's one colour, its gains and the soil and habitat fields.
//
// The lawn is one grass colour (docs/explanation/art-direction.md): every tuft takes it and the turf under
// the blades shows it too, so the far meadow, where the blades are under a pixel and the turf shows
// between them, reads as one carpet with the near blades. Only a gentle, low-frequency swing of its
// value (+-4 %, drifts some 10 m across) keeps a large lawn from looking printed; the blades' own
// root-to-tip colour (Grass.ts) carries the rest. Separate fields of tone, dryness and hue, and a
// field of bare earth, once broke it into patches that from the overview read as camouflage and
// dark blotches.
// The growth field is the island top's structure for the root bed at the rim (Soil.ts). The sward's
// layering comes from the blades themselves (Grass.ts: each blade's length and lean, its clump's
// height and colour), never from zones of the soil. Height tiers by the soil (short exposed turf, a
// deep soil's taller grass) and their tints read from above as zoning across the island top, a map
// laid over the meadow, and were taken off the screen. The soil's fields stay in code (`meadowSoil`,
// `meadowTurf`, `soilShort`, `soilDeep`, `meadowVigour`, `meadowShallow`): the plants to come will
// be placed by the habitat fields (`meadowMoisture`, `meadowTurf`). The sward runs to the edge on
// every coast: a windward lip shown short, yellow, thin over gravel and bared to the cliff's stone
// in stretches read from above as one more zone, and was taken off.
// The map covers the land lattice's whole extent, wherever the island grows, at 0.25 m: R the
// turf's tone, G the sward's cover, B the height of its crowns over the ground and A the sward's
// depth over it, the last three baked from the meadow's anchors (world/SwardField.ts, which holds
// the map; Grass.ts gives each anchor that holds turf the sward's depth).
export const MEADOW_EXTENT = 2 * GROWTH.half;
export const MEADOW_SIZE = MEADOW_EXTENT * 4;

/** The lawn's tuft height scale (m) on ordinary soil, the middle of its three levels: the mean
 * length of its blades, which arc over under their weight (Grass.ts). */
export const SWARD_HEIGHT = 0.45;

interface MeadowSample { growth: number; tone: number }

// Linear albedo of the lawn as a whole, a deep olive green: the blades' mean (Grass.ts meadowMean)
// over LAWN_GAIN. The tone's knob (`groundGains.lawnGain`) lightens or darkens the blades (Grass.ts)
// and the turf together. The land's bounce reads it (BounceGround.ts), and the ambient light's
// bake holds a copy (AmbientProbes.ts LAWN_TOP).
const LAWN = new THREE.Color( 0.0700, 0.0978, 0.0109 );
/** The lawn's colour (linear albedo), before its tone. */
export const LAWN_COLOUR = LAWN.toArray() as [ number, number, number ];
/** The meadow's albedo against LAWN_COLOUR on load (`groundGains.lawnGain`, a knob): LAWN_COLOUR times it
 * is the blades' mean. The blades' colours and the turf set against them (TerrainMaterial.ts,
 * Grass.ts GRASS_ROOTS) are divided by it, so at LAWN_GAIN they are their own. */
export const LAWN_GAIN = 0.926;
/** The knobs on the island's ground albedos, one uniform each, read by every material that uses
 * it. */
export const groundGains = {
	// the meadow's albedo against its lawn colour (LAWN): the blades', the turf's under them and the
	// ground bounce's over the plateau (BounceGround.ts); 1 the lawn as LAWN gives it. LAWN_GAIN: the
	// blades' albedo on load (Grass.ts)
	lawnGain: uniform( LAWN_GAIN ),
	// the cliff's albedo above the water against its stone (TerrainMaterial.ts `rock`); 1 the stone as
	// it is. 1.6: the stone at about twice the meadow's albedo (about 0.18); under the water it keeps
	// SUBMERGED_ROCK of it (TerrainMaterial.ts), darker only by the water round it
	rockGain: uniform( 1.6 ),
};
/** Sets a ground albedo's gain: the page's debug handles do (`setLawnGain`, `setRockGain`). */
export function setGroundGain( name: keyof typeof groundGains, gain: number ): void {

	groundGains[ name ].value = gain;

}
/** How far the turf's value varies about the lawn's colour (a broad noise's -1 to 1 times it). */
export const LAWN_TONE = 0.04;

export function sampleMeadow( x: number, z: number ): MeadowSample {

	const broad = noise3( x * 0.24 + 2.7, 0.5, z * 0.24 - 1.3 ) * 0.5 + 0.5;
	const clump = noise3( x * 0.65 - 3.1, 2.5, z * 0.65 + 4.8 ) * 0.5 + 0.5;
	const growth = smoothstep( 0.3, 0.7, broad * 0.72 + clump * 0.28 );
	const tone = noise3( x * 0.1 + 11.3, 7.7, z * 0.1 - 4.6 );
	return { growth, tone };

}

// The meadow's habitat: two broad fields of fixed seeds that say where its plants grow, the way a
// real island top's turf and wildflowers follow the ground; the plants to come will be placed by
// them. Neither changes the lawn's colour or height.

/** The ground's moisture under the meadow at ( x, z ), 0 dry to 1 damp: a low-frequency field (its
 * drifts some 25 m across), so the island top has a damp hollow or two and a dry stretch or two. */
export function meadowMoisture( x: number, z: number ): number {

	return smoothstep( - 0.45, 0.45, noise3( x * 0.035 + 21.7, 4.3, z * 0.035 - 13.9 ) );

}

// The soil (docs/explanation/art-direction.md, the meadow): on a real island top the salt spray and the wind
// come from the prevailing wind's side, and they set the turf. On the windward coast a band of
// short, salt-pruned turf reaches far in from the edge, the farther the more exposed the coast; on
// the lee coast the tall turf runs to the edge. A headland, the sea round it on several sides, is
// the most exposed (the turf shortest, the soil thinnest); a cove the
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
// stretched SOIL.stretch times along the wind (`meadowTongueWith`), it
// draws the short turf's inner edge out into downwind tongues and gives the moderately exposed
// ground downwind of the windward coast a streak or two. The soil's `depth` is the shelter squared
// times the distance from the coast (SOIL.far) times a broad field (SOIL.deepRate, a few patches
// across a large island). Measured on the anchors (each about equal area):
// at the twelfth growth step the short tier is some 27 % of the meadow (the windward coast's band
// 21 %, half of it 6 m deep and its tongues to 13 m; the lee coast's 0 - 1 m 4 %; inland streaks
// under 1 %), its core 4 % and deep soil 18 %; at the start the short tier is 46 % (the windward
// half of a small island), its core 11 %, deep soil 12 % at its centre, the lee half green, so the
// starting island shows all three of the sward's levels (deep soil was 3 % of it and 14 % at the
// twelfth step with the depth reaching full from 8 m in and the tier over 0.53 - 0.78 of it). The
// blades do not read it (Grass.ts); the plants to come will.

/** The prevailing wind's origin at rest: the unit vector toward where it comes from (Wind.ts's
 * heading of 40 degrees). */
export const UPWIND = [ Math.cos( 40 * Math.PI / 180 ), Math.sin( 40 * Math.PI / 180 ) ];

/** The soil's numbers (see above): the upwind samples' distances (m) and weights; the off-wind
 * samples' angles from upwind (degrees, taken either side), distance (m) and the scale they set
 * (base + gain times their mean sea); how far below the cliff's top edge a sample starts to count
 * as sea (`soft`, m) and the share of its distance the coast must lie behind it to count fully
 * (`open`); the lip's own exposure (its range of m in from the edge and its weight); the tongues'
 * noise (amplitude, across-wind rates in cycles per metre with their weights, their stretch along
 * the wind, and the exposure below which they fade out, `fray`); the depth's distance from the
 * coast (m) and its broad field (rate in cycles per metre, the noise's range). */
export const SOIL = {
	reach: [ 3, 9, 18, 34 ], weight: [ 0.35, 0.3, 0.2, 0.15 ],
	side: [ 50, 100 ], sideReach: 6, sideBase: 0.7, sideGain: 0.6,
	soft: 1, open: 0.6, lip: [ 0.3, 2 ], lipWeight: 0.1,
	tongue: 1.6, tongueRate: [ 0.09, 0.25 ], tongueMix: [ 0.8, 0.3 ], stretch: 3.5, fray: 0.15,
	far: [ 1.2, 5 ], deepRate: 0.04, deepNoise: [ - 0.6, 0.3 ],
	// the fields' tiers (habitats only): short turf over `short` of the exposure, deep soil over
	// `deep` of the depth
	short: [ 0.2, 0.34 ], deep: [ 0.58, 0.82 ],
};
// The sea-level coast of the shore field lies about SHORE_RIM in from the cliff's top edge the
// anchors measure (the sea-level section against the top's outline, 0.75 - 0.87 m): the top edge's
// distance is shore + SHORE_RIM.
export const SHORE_RIM = - 0.8;
/** The soil at a point: its `exposure` to the wind and salt (0 sheltered, 1 the windward lip or a
 * headland's tip), its `depth` (0 thin, 1 deep), how far in from the cliff's top edge it lies
 * (`inside`, m). */
export interface MeadowSoil { exposure: number; depth: number; inside: number }

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
	};

}

// The noise that frays the soil's zones, 0 to 1, stretched along the wind.
function meadowTongueWith( P: typeof SOIL, x: number, z: number ): number {

	const along = ( x * UPWIND[ 0 ] + z * UPWIND[ 1 ] ) / P.stretch, across = z * UPWIND[ 0 ] - x * UPWIND[ 1 ];
	const [ f0, f1 ] = P.tongueRate, [ m0, m1 ] = P.tongueMix;
	const n = noise3( along * f0 - 17.2, 9.1, across * f0 + 6.4 ) * m0 + noise3( along * f1 + 3.3, 12.7, across * f1 - 9.8 ) * m1;
	return Math.min( Math.max( n * 0.5 + 0.5, 0 ), 1 );

}

// The sward's soil: how tall and close the turf grows, from the depth and water of its soil. In a
// real meadow the grass is taller and lusher where the soil is deep and damp, and over shallow soil
// (the rock near the surface, in pockets a few metres across) it is a short, open turf; they run
// into each other over metres, never along a line. Two fields of fixed seeds, which the blades do
// not read (Grass.ts):
// - `meadowVigour`, the soil's depth and water over some 14 m (SWARD_SOIL.broad cycles per metre)
//   and the moisture field's 25 m (SWARD_SOIL.wet of it): its median about 0.5, its 5th and 95th
//   percentiles about 0.25 and 0.75 on a grown island.
// - `meadowShallow`, the pockets of shallow soil: on a world-anchored lattice of POCKET.cell (m),
//   a cell holds one for POCKET.share of them, times POCKET.vigour's factor (from its first where
//   the vigour at its centre is 0 to its second at 1), its centre clear of the cell's sides by its
//   largest radius (so a point looks at its own cell and the eight round it), its radius
//   POCKET.radius (m), frayed by POCKET.fray of it by a noise of POCKET.frayRate cycles per metre;
//   full over its inner POCKET.core of the radius and easing out to its edge: a pocket of 3 - 6 m
//   every few cells, their weight 11 % of the first island's meadow, 8 % at the twelfth growth
//   step.
// Neither is the wind's exposure: from the coast's side a band of short turf across the windward
// half of a small island read from above as a zone laid over the meadow. Nor the low end of a
// noise: its 14 m drifts made a third of the first island short, and its 5 m valleys ran into
// curving strips that read as footpaths.
const SWARD_SOIL = { broad: 0.07, wet: 0.4 };
const POCKET = { cell: 6, share: 0.45, vigour: [ 1.4, 0.6 ], radius: [ 1.2, 3 ], fray: 0.3, frayRate: 0.7, core: 0.35 };

/** The sward's vigour at ( x, z ), 0 thin and dry to 1 deep and damp (see SWARD_SOIL). */
export function meadowVigour( x: number, z: number ): number {

	const n = noise3( x * SWARD_SOIL.broad + 3.7, 14.2, z * SWARD_SOIL.broad - 9.1 );
	return Math.min( Math.max( 0.5 + 0.5 * ( n * ( 1 - SWARD_SOIL.wet ) + ( 2 * meadowMoisture( x, z ) - 1 ) * SWARD_SOIL.wet ), 0 ), 1 );

}

// each lattice cell's pocket ( x, z, radius ), or null, worked out once (a function of the cell
// alone; the lattice over the land's extent holds about a thousand cells)
const pockets = new Map<number, [ number, number, number ] | null>();
function pocket( i: number, j: number ): [ number, number, number ] | null {

	const key = i * 65536 + j;
	let p = pockets.get( key );
	if ( p !== undefined ) return p;
	const m = POCKET.radius[ 1 ] * ( 1 + POCKET.fray ), span = POCKET.cell - 2 * m;
	const r = cellStream( i, j, 523 );
	const take = r(), px = i * POCKET.cell + m + r() * span, pz = j * POCKET.cell + m + r() * span;
	const radius = POCKET.radius[ 0 ] + r() * ( POCKET.radius[ 1 ] - POCKET.radius[ 0 ] );
	const v = POCKET.vigour[ 0 ] + ( POCKET.vigour[ 1 ] - POCKET.vigour[ 0 ] ) * meadowVigour( px, pz );
	p = take < POCKET.share * v ? [ px, pz, radius ] : null;
	pockets.set( key, p );
	return p;

}

/** How far ( x, z ) lies in a pocket of shallow soil, 0 none to 1 its core (see POCKET). */
export function meadowShallow( x: number, z: number ): number {

	const ci = Math.floor( x / POCKET.cell ), cj = Math.floor( z / POCKET.cell );
	const fray = 1 + POCKET.fray * noise3( x * POCKET.frayRate + 1.9, 7.3, z * POCKET.frayRate - 2.6 );
	let shallow = 0;
	for ( let j = cj - 1; j <= cj + 1; j ++ ) for ( let i = ci - 1; i <= ci + 1; i ++ ) {

		const p = pocket( i, j );
		if ( p ) shallow = Math.max( shallow, 1 - smoothstep( POCKET.core, 1, Math.hypot( x - p[ 0 ], z - p[ 1 ] ) / ( p[ 2 ] * fray ) ) );

	}
	return shallow;

}

/** The sward the soil `soil` grows, 0 short to 1 tall: the wildflowers' habitat. */
export function meadowTurf( soil: MeadowSoil ): number {

	return ( 1 - soilShort( soil.exposure ) ) * ( 0.55 + 0.45 * soilDeep( soil.depth ) );

}

/** How short the turf at exposure `exposure` grows: 1 short, 0 ordinary or deep. */
export function soilShort( exposure: number ): number {

	return smoothstep( SOIL.short[ 0 ], SOIL.short[ 1 ], exposure );

}

/** How deep the soil of depth `depth` is: 0 ordinary or thin, 1 deep. */
export function soilDeep( depth: number ): number {

	return smoothstep( SOIL.deep[ 0 ], SOIL.deep[ 1 ], depth );

}

function colorFromSample( sample: MeadowSample, target: THREE.Color ): THREE.Color {

	return target.copy( LAWN ).multiplyScalar( 1 + sample.tone * LAWN_TONE );

}

export function meadowColor( x: number, z: number, target: THREE.Color ): THREE.Color {

	return colorFromSample( sampleMeadow( x, z ), target );

}

let texels: Uint8Array | null = null;

/** The meadow map's texels, MEADOW_SIZE square: R the turf's tone (its colour is the lawn's times
 * 1 + LAWN_TONE ( 2 R - 1 ), `colorFromSample`), G, B and A left at 0 for the sward's cover, crowns and depth
 * (world/SwardField.ts). Baked once: a function of position alone. (The turf's colour, one hue
 * whose value alone varies, took three channels the sward's cover now needs one of.) */
export function meadowTexels(): Uint8Array {

	if ( texels ) return texels;
	const data = texels = new Uint8Array( MEADOW_SIZE * MEADOW_SIZE * 4 );
	for ( let row = 0; row < MEADOW_SIZE; row ++ ) {

		const z = ( ( row + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
		for ( let column = 0; column < MEADOW_SIZE; column ++ ) {

			// Bake texel centres so xz / MEADOW_EXTENT + 0.5 agrees with CPU instance colours.
			const x = ( ( column + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
			const k = ( row * MEADOW_SIZE + column ) * 4;
			data[ k ] = Math.round( ( sampleMeadow( x, z ).tone * 0.5 + 0.5 ) * 255 );

		}

	}
	return data;

}
