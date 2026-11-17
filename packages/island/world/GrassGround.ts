import * as THREE from 'three/webgpu';
import { MEADOW_EXTENT, MEADOW_SIZE, supportsMeadow } from '../materials/Meadow.ts';
import { runSteps } from '../../render/index.ts';
import { VEGETATION_STRIDE as STRIDE, type RimGroundField } from './types.ts';
import { RIM_INNER_LIMIT, RIM_MAX_DROP, rimTurfCover, sampleRimGround } from './RimGround.ts';
import { noise3, smoothstep as smoothstepNumber } from '../../render/data.ts';
import { grassOnLitter } from './BambooGroves.ts';

// The meadow's ground map and lip's map, baked on the CPU from the turf anchors.
//
// What the meadow's blades (Grass.ts) are planted from: over the meadow's square (MEADOW_EXTENT,
// MEADOW_SIZE texels) the turf anchors splatted bilinearly, those on the cliff's face under the lip
// left out. The ground map holds the share of the anchors that hold turf (inland `supportsMeadow`,
// on the rim the rim's turf TerrainMaterial.ts draws, RimGround.ts `rimTurfCover`, and thinning into
// the bamboo groves: BambooGroves.ts `grassOnLitter`), their mean height, their mean sky visibility
// and the grass-height map (HEIGHT_MAP) with the land's edge's share (GROUND_A). On the lip, where
// the turf falls away over the bevel, a texel's roots are a line in the rim distance instead, and
// the lip's map beside it holds that line's slope, the rim distance at each texel and how far out
// the turf reaches (LIP), so each blade there takes its own roots' height and grows no further out
// than the turf. The sward's samples, the crowns and the edge roots come from the same anchors.
// Everything here is a function of the anchors and the rim field alone, so a grown island's maps
// equal a fresh load's.

/** The roots sit this far below the anchors' mean height. */
export const SINK = 0.02;

/** The grass-height map (0..1): a mottle of patches (`patch` m) over broad swells (`swell` m),
 * `patchShare` of its variance in the patches, around `mean` by `spread` (one standard deviation,
 * clipped at 0 and 1), lower within `edge` m of the meadow's edge. NOISE_SD is noise3's standard
 * deviation over a plane. The blades' lengths follow it (LENGTH); the turf's run under the layer
 * takes it without `edge` (`meadowGroundRuns`). */
export const HEIGHT_MAP = { mean: 0.8, spread: 0.15, patch: 4.5, swell: 60, patchShare: 0.55, edge: 0.3 };
/** The ground map's A: the height map free of the land's edge in its fraction, and in its whole part
 * what `edge` takes off it, k = round( ( 1 - e ) `steps` ), e the edge's factor (0..1): inland k is 0
 * and A is the map. The map stops at `most`: a clipped 1 would read as a fraction of 0, and any
 * nearer to 1 than a float32's step at k = 255, 2^-16, the sum rounds up to k + 1 (a float's last
 * step under 1, 2^-24, does at every k from 1). It is read through `groundHeights`, on texels
 * loaded and blended by hand: a filter between two texels would break A. */
export const GROUND_A = { steps: 255, most: 1 - 2 ** - 16 };

const NOISE_SD = 0.27;

function heightMapAt( x: number, z: number ): number {

	const { mean, spread, patch, swell, patchShare } = HEIGHT_MAP;
	const n = Math.sqrt( patchShare ) * noise3( x / patch + 11.3, 3.7, z / patch - 5.1 ) + Math.sqrt( 1 - patchShare ) * noise3( x / swell - 7.9, 8.1, z / swell + 2.6 );
	return Math.min( 1, Math.max( 0, mean + spread * n / NOISE_SD ) );

}

/** The sward's depth where the meadow grows (the full shade from it up) and the crowns' height. */
export const SWARD_DEPTH = 0.73, CROWN_TOP = 0.3;

/** Anchors this far inside the rim (m, the anchor's rim distance) are the meadow's edge roots. */
const EDGE = [ - 1.5, - 0.3 ];
/** The lip's texels of the ground map (the rim's fringe, past -RIM_INNER_LIMIT of the rim
 * distance): a level turf's roots over a quarter-metre texel hold, but along the lip the turf falls
 * away over the bevel, about 0.2 m within the last 0.2 m of the rim distance, and a texel's mean
 * height, blended to a blade between texels, stood the blades there up to 0.14 m over it. There
 * the texel's roots are a line in the rim distance, fitted to its holding anchors' heights (its
 * slope shrunk toward level by `shrink` m of the distance's spread, so a texel of one or two
 * anchors stays about level, and held to `steepest`), and a blade takes the line at its own
 * distance; it grows no further out than the farthest holding anchor of its texels (`reach`): past
 * that the land is the cliff's face, which the line does not follow. `none` stands for no limit
 * (inland) and no anchor. */
export const LIP = { shrink: 0.01, steepest: 3, none: 1e3 };

/** What the meadow is planted from: the ground map's texels, the sward's samples ( x, z, depth or
 * -1 ), the crowns, the edge roots and the box the meadow grows in. */
export interface GrassPlan {
	ground: Float32Array;
	lip: Float32Array;
	sward: number[];
	crowns: { origin: THREE.Vector3; top: number }[];
	roots: number[][];
	box: THREE.Box3;
}

/** The plan for the turf anchors `veg` (VEGETATION_STRIDE floats each), in steps. The ground map's
 * texels: the mean height of the anchors that hold turf, their share (0 where they are too few),
 * their mean sky visibility (1 where none) and the grass-height map with the land's edge's share
 * (GROUND_A). */
export function* grassSteps( veg: Float32Array, rim: RimGroundField ): Generator<void, GrassPlan> {

	const size = MEADOW_SIZE, n = veg.length / STRIDE;
	const all = new Float32Array( size * size ), land = new Float32Array( size * size ), held = new Float32Array( size * size ), height = new Float32Array( size * size ), sky = new Float32Array( size * size );
	// the holding anchors' rim distance d, as sums of w d, w d^2 and w d y, and the farthest d out
	// (LIP: the lip's texels)
	const lipSums = new Float64Array( size * size * 3 ), reach = new Float32Array( size * size ).fill( - LIP.none );
	// the lip's map's R: the rim distance at each texel's centre, which a blade takes bilinear (and
	// so does an anchor here, so the fit and the reach are in the blade's measure)
	const ground = new Float32Array( size * size * 4 ), lip = new Float32Array( size * size * 4 );
	for ( let t = 0; t < size * size; t ++ ) {

		const x = ( ( t % size + 0.5 ) / size - 0.5 ) * MEADOW_EXTENT, z = ( ( Math.floor( t / size ) + 0.5 ) / size - 0.5 ) * MEADOW_EXTENT;
		lip[ t * 4 ] = sampleRimGround( rim, x, z ).distance;
		lip[ t * 4 + 2 ] = LIP.none;
		if ( ( t & 4095 ) === 4095 ) yield;

	}
	const sward: number[] = [], crowns: GrassPlan[ 'crowns' ] = [], roots: number[][] = [];
	const box = new THREE.Box3();
	for ( let a = 0; a < n; a ++ ) {

		const k = a * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		// the land holds turf (inland the meadow's level ground, on the rim the rim's turf, down the
		// lip's bevel where it wraps it: RimGround.ts `rimTurfCover`, as TerrainMaterial.ts draws it),
		// and grass grows there, thinner under the groves
		const g = sampleRimGround( rim, x, z );
		const onLand = rimTurfCover( g, y, veg[ k + 4 ], supportsMeadow( x, y, z, veg[ k + 4 ] ) ? 1 : 0 ) >= 0.5;
		const holds = onLand && grassOnLitter( x, z );
		// an anchor on the cliff's face under the lip (deeper under the roof than any turf) is no
		// part of the land's top the map describes: counted, it held the lip's texels under half
		const face = g.distance > - RIM_INNER_LIMIT && y < g.roofY - RIM_MAX_DROP;
		const fx = ( x / MEADOW_EXTENT + 0.5 ) * size - 0.5, fz = ( z / MEADOW_EXTENT + 0.5 ) * size - 0.5;
		const ix = Math.floor( fx ), iz = Math.floor( fz ), tx = fx - ix, tz = fz - iz;
		let d = 0;
		for ( let c = 0; c < 4; c ++ ) {

			const i = Math.min( Math.max( ix + ( c & 1 ), 0 ), size - 1 ), j = Math.min( Math.max( iz + ( c >> 1 ), 0 ), size - 1 );
			d += ( c & 1 ? tx : 1 - tx ) * ( c >> 1 ? tz : 1 - tz ) * lip[ ( j * size + i ) * 4 ];

		}
		for ( let c = 0; c < 4; c ++ ) {

			const i = ix + ( c & 1 ), j = iz + ( c >> 1 );
			if ( i < 0 || j < 0 || i >= size || j >= size ) continue;
			const w = ( c & 1 ? tx : 1 - tx ) * ( c >> 1 ? tz : 1 - tz );
			const t = j * size + i;
			if ( ! face ) all[ t ] += w;
			if ( onLand ) land[ t ] += w;
			if ( holds ) {

				held[ t ] += w;
				height[ t ] += w * ( y - SINK );
				sky[ t ] += w * veg[ k + 8 ];
				lipSums[ t * 3 ] += w * d;
				lipSums[ t * 3 + 1 ] += w * d * d;
				lipSums[ t * 3 + 2 ] += w * d * ( y - SINK );
				if ( w > 0 ) reach[ t ] = Math.max( reach[ t ], d );

			}

		}
		sward.push( x, z, holds ? SWARD_DEPTH : - 1 );
		if ( holds ) {

			crowns.push( { origin: new THREE.Vector3( x, y, z ), top: CROWN_TOP } );
			box.expandByPoint( crowns[ crowns.length - 1 ].origin );
			if ( veg[ k + 6 ] > EDGE[ 0 ] && veg[ k + 6 ] < EDGE[ 1 ] ) roots.push( [ x, y, z, 1 ] );

		}
		// (a step's quarter of a millisecond: the litter's test costs about a third of a microsecond)
		if ( ( a & 1023 ) === 1023 ) yield;

	}
	// each meadow texel's distance (m) to the nearest texel whose land holds no turf (a chamfer
	// distance, two passes), for the height map's edge: the land's, so the grass round a clearing
	// in the groves' litter keeps its height up to the clearing
	const edge = new Float32Array( size * size );
	for ( let t = 0; t < size * size; t ++ ) {

		const valid = held[ t ] > 1e-3;
		ground[ t * 4 ] = valid ? height[ t ] / held[ t ] : 0;
		// the lip's texels: the roots' height as a line in the rim distance d, fitted to the holding
		// anchors (its slope shrunk toward level where their d spreads little), given at the texel's
		// own d; inland a texel keeps its mean, its slope 0 and no reach
		const d = lip[ t * 4 ];
		if ( valid && d > - RIM_INNER_LIMIT ) {

			const h = held[ t ], mean = lipSums[ t * 3 ] / h, y = height[ t ] / h;
			const spread = lipSums[ t * 3 + 1 ] / h - mean * mean, along = lipSums[ t * 3 + 2 ] / h - mean * y;
			const slope = Math.min( Math.max( along / ( Math.max( spread, 0 ) + LIP.shrink ** 2 ), - LIP.steepest ), 0 );
			ground[ t * 4 ] = y + slope * ( d - mean );
			lip[ t * 4 + 1 ] = slope;
			lip[ t * 4 + 2 ] = reach[ t ];

		}
		ground[ t * 4 + 1 ] = valid ? held[ t ] / all[ t ] : 0;
		ground[ t * 4 + 2 ] = valid ? sky[ t ] / held[ t ] : 1;
		edge[ t ] = land[ t ] > 1e-3 && land[ t ] / all[ t ] >= 0.5 ? 1e9 : 0;
		if ( ( t & 65535 ) === 65535 ) yield;

	}
	const texel = MEADOW_EXTENT / size, diagonal = texel * Math.SQRT2;
	const relax = ( t: number, i: number, j: number, di: number, dj: number, d: number ) => {

		if ( i + di >= 0 && i + di < size && j + dj >= 0 && j + dj < size ) edge[ t ] = Math.min( edge[ t ], edge[ t + dj * size + di ] + d );

	};
	for ( let j = 0; j < size; j ++ ) {

		for ( let i = 0; i < size; i ++ ) {

			const t = j * size + i;
			if ( edge[ t ] === 0 ) continue;
			relax( t, i, j, - 1, 0, texel );
			relax( t, i, j, 0, - 1, texel );
			relax( t, i, j, - 1, - 1, diagonal );
			relax( t, i, j, 1, - 1, diagonal );

		}
		if ( ( j & 63 ) === 63 ) yield;

	}
	for ( let j = size - 1; j >= 0; j -- ) {

		for ( let i = size - 1; i >= 0; i -- ) {

			const t = j * size + i;
			if ( edge[ t ] === 0 ) continue;
			relax( t, i, j, 1, 0, texel );
			relax( t, i, j, 0, 1, texel );
			relax( t, i, j, 1, 1, diagonal );
			relax( t, i, j, - 1, 1, diagonal );

		}
		if ( ( j & 63 ) === 63 ) yield;

	}
	for ( let t = 0, done = 0; t < size * size; t ++ ) {

		if ( edge[ t ] === 0 ) continue;
		const x = ( ( t % size + 0.5 ) / size - 0.5 ) * MEADOW_EXTENT, z = ( ( Math.floor( t / size ) + 0.5 ) / size - 0.5 ) * MEADOW_EXTENT;
		ground[ t * 4 + 3 ] = Math.min( heightMapAt( x, z ), GROUND_A.most ) + Math.round( ( 1 - smoothstepNumber( 0, HEIGHT_MAP.edge, edge[ t ] ) ) * GROUND_A.steps );
		if ( ( ++ done & 4095 ) === 4095 ) yield;

	}
	return { ground, lip, sward, crowns, roots, box };

}

/** The plan for the turf anchors `veg`, at once (the app's load and the tools). */
export function plantGrass( veg: Float32Array, rim: RimGroundField ): GrassPlan {

	return runSteps( grassSteps( veg, rim ) );

}
