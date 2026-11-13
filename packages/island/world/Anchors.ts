// The meadow's planting anchors: one jittered sample per cell of a world-anchored grid, marched
// down to the island's top. Every choice belongs to the anchor's cell ( i, j ): its jitter is a
// hash of the cell, and the plants grown on it draw from a random stream seeded by the cell
// (`anchorStream`), so what grows at an anchor never depends on which other anchors were built
// before it, or in which box. A box keeps the anchors whose jittered point lies in it, so boxes
// that tile the plane build every anchor once, and a box plants exactly what the whole island
// plants there (tools/verify-world-chunks.mjs, S5).
import { hash3i, mulberry32, type Rng, type Bounds } from '../../render/data.ts';
import { VEGETATION_SPACING as CELL } from './types.ts';
import type { SDF } from './types.ts';

// The jitter keeps a point within 0.475 of a cell from its cell's centre.
const JITTER = 0.95;

/** The anchor cell ( i, j ) of an anchor's stored position. */
export function anchorCell( x: number, z: number ): [ number, number ] {

	return [ Math.round( x / CELL - 0.5 ), Math.round( z / CELL - 0.5 ) ];

}

/** A random stream for the anchor at ( x, z ), one per anchor cell and salt. */
export function anchorStream( x: number, z: number, salt: number ): Rng {

	const [ i, j ] = anchorCell( x, z );
	return cellStream( i, j, salt );

}

/** A random stream for an integer cell ( i, j ) of any world lattice, one per cell and salt. */
export function cellStream( i: number, j: number, salt: number ): Rng {

	return mulberry32( mix32( hash3i( i, j, salt ) * 4294967296 >>> 0 ) );

}

// MurmurHash3's finaliser. `hash3i` mixes a lattice cell in a single round, and streams seeded
// straight from it drew a little low where a gate is rare: the former tussocks (one anchor in ten)
// came out 2 - 4 % short of their expected count on every island measured; mixed again, they
// scatter about it as a running stream's do.
function mix32( h: number ): number {

	h = Math.imul( h ^ h >>> 16, 0x85ebca6b );
	h = Math.imul( h ^ h >>> 13, 0xc2b2ae35 );
	return ( h ^ h >>> 16 ) >>> 0;

}

/** The anchors whose jittered point lies in the half-open box `own`: each marched down from above
 * to the surface and kept if it faces up enough to hold turf (the rounded rim included). Appends
 * x, y, z, nx, ny, nz, rim (`rimDist`: signed distance to the shape's edge, negative inside) and
 * kind (0 island) per anchor, in the order of the cells ( j, then i ). */
export function scatterTop( sdf: SDF, own: Bounds, topAt: ( x: number, z: number ) => number, rimDist: ( x: number, z: number ) => number, out: number[] ): void {

	const i0 = Math.floor( own.x0 / CELL ) - 1, i1 = Math.ceil( own.x1 / CELL ) + 1;
	const j0 = Math.floor( own.z0 / CELL ) - 1, j1 = Math.ceil( own.z1 / CELL ) + 1;
	for ( let j = j0; j <= j1; j ++ ) for ( let i = i0; i <= i1; i ++ ) {

		const px = ( i + 0.5 ) * CELL + ( hash3i( i, j, 4242 ) - 0.5 ) * CELL * JITTER;
		const pz = ( j + 0.5 ) * CELL + ( hash3i( i, j, 4243 ) - 0.5 ) * CELL * JITTER;
		if ( px < own.x0 || px >= own.x1 || pz < own.z0 || pz >= own.z1 ) continue;
		const yTop = topAt( px, pz );
		let y = yTop + 1.2;
		let hit = false;
		for ( let k = 0; k < 80; k ++ ) {

			const d = sdf( px, y, pz );
			if ( d < 0.003 ) { hit = true; break; }
			y -= Math.max( d * 0.7, 0.004 );
			if ( y < yTop - 1.5 ) break;

		}

		if ( ! hit ) continue;
		const e = 0.04;
		let nx = sdf( px + e, y, pz ) - sdf( px - e, y, pz );
		let ny = sdf( px, y + e, pz ) - sdf( px, y - e, pz );
		let nz = sdf( px, y, pz + e ) - sdf( px, y, pz - e );
		const l = Math.hypot( nx, ny, nz ) || 1;
		nx /= l; ny /= l; nz /= l;
		if ( ny < 0.3 ) continue;
		out.push( px, y, pz, nx, ny, nz, rimDist( px, pz ), 0 );

	}

}
