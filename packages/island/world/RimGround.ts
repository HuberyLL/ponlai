import { Field2D } from './Field2D.ts';
import { ISLAND_TOP, islandSurfaceHeight, solidSide, type Footprint } from './WorldShapes.ts';
import { type Bounds, type ShoreField, noise3, smoothstep } from '../../render/data.ts';
import type { RimGroundField, RimLipData, SDF } from './types.ts';

// The rim ground: the coast's lip, the turf's retreat and the root depth, on a world lattice.

export const RIM_FRINGE_FADE = 0.12;
export const RIM_INNER_LIMIT = 0.70;
export const RIM_MAX_DROP = 0.30;

export interface RimGroundSample { distance: number; roofY: number; retreat: number; depth: number }

// The rim field: the actual upper coast, the turf's retreat and the exposed root depth. By that
// depth the lip alternates between overgrown stretches (turf down over the shoulder) and cut-open
// root soil (TerrainMaterial); the meadow's blades shorten and thin toward the land's edge (Grass.ts,
// the grass-height map's `edge`). It is built per box of a world grid (RIM_BOX) and is
// the same, bit for bit, whichever box computed it (tools/island/verify-world-chunks.mjs, S4 and S5).

// The rim ground lies on a world lattice: texel ( i, j ) is centred on ( ( i + 0.5 ) * RIM_CELL,
// ( j + 0.5 ) * RIM_CELL ) whatever box it is computed for, so every box evaluates the same points.
export const RIM_CELL = 0.1;
// Its distance is clamped to +-RIM_REACH (m), and a box's tile spans RIM_PAD round the box: the
// texels of the box then find every cell their clamped distance depends on inside the tile (the
// transform is exact), so they equal those of any larger tile, bit for bit, and so do the texels
// the lip reads in the tile's first half metre outside the box.
export const RIM_REACH = 1.5;
export const RIM_PAD = 2;
const PAD_TEXELS = Math.round( RIM_PAD / RIM_CELL );

// The world's grid of boxes the page builds the rim in (a chunk's box, in the worker for now).
export const RIM_BOX = 16;

const grow = ( b: Bounds, m: number ): Bounds => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );

/** The boxes of a world grid of `size` (m) that meet `b`, in rows of z, then x. */
export function gridBoxes( b: Bounds, size: number ): Bounds[] {

	const boxes: Bounds[] = [];
	for ( let cj = Math.floor( b.z0 / size ); cj * size < b.z1; cj ++ ) for ( let ci = Math.floor( b.x0 / size ); ci * size < b.x1; ci ++ ) {

		boxes.push( { x0: ci * size, z0: cj * size, x1: ( ci + 1 ) * size, z1: ( cj + 1 ) * size } );

	}
	return boxes;

}

// The lattice's texels whose centres lie in [ a, b ): as the centres are computed, so each texel
// belongs to exactly one of the boxes that tile the plane.
function texelRange( a: number, b: number ): [ number, number ] {

	const first = ( v: number ) => {

		let i = Math.ceil( v / RIM_CELL - 0.5 );
		while ( ( i - 0.5 ) * RIM_CELL >= v ) i --;
		while ( ( i + 0.5 ) * RIM_CELL < v ) i ++;
		return i;

	};
	return [ first( a ), first( b ) ];

}

/** The top coast differs from the land's footprint: the island's actual solid just below the
 * roof, on the rim ground's lattice over the texels whose centres lie in `box`. Grass thinning,
 * exposed root soil and stone shoulders all share this one boundary. */
export class RimLattice {

	readonly i0: number;
	readonly j0: number;
	readonly nx: number;
	readonly nz: number;
	// 1 where the texel's centre lies in the solid
	readonly inside: Uint8Array;

	// With the island's footprint `fp` (the one `sdf` was made from), texels farther from its coast
	// than WorldShapes' `solidSide` band take their side from it, bit for bit what the SDF gives:
	// most of a lattice lies there, and the wall is the costly part of the SDF.
	constructor( sdf: SDF, box: Bounds, fp?: Footprint ) {

		const [ i0, i1 ] = texelRange( box.x0, box.x1 ), [ j0, j1 ] = texelRange( box.z0, box.z1 );
		this.i0 = i0; this.j0 = j0; this.nx = i1 - i0; this.nz = j1 - j0;
		this.inside = new Uint8Array( this.nx * this.nz );
		for ( let j = 0; j < this.nz; j ++ ) for ( let i = 0; i < this.nx; i ++ ) {

			const x = ( i0 + i + 0.5 ) * RIM_CELL, z = ( j0 + j + 0.5 ) * RIM_CELL;
			const side = fp ? solidSide( fp, x, z ) : 0;
			this.inside[ j * this.nx + i ] = ( side !== 0 ? side : sdf( x, islandSurfaceHeight( x, z ) - 0.25, z ) ) < 0 ? 1 : 0;

		}

	}

	/** Whether world texel ( i, j ) lies in the solid. */
	at( i: number, j: number ): number {

		const li = i - this.i0, lj = j - this.j0;
		if ( li < 0 || lj < 0 || li >= this.nx || lj >= this.nz ) throw new RangeError( `texel ( ${ i }, ${ j } ) is outside the rim lattice` );
		return this.inside[ lj * this.nx + li ];

	}

}

/** A box's rim ground tile, over its texels and RIM_PAD round them (the lattice must cover that):
 * RGBA per texel, the distance to the top coast (m, negative inside, clamped to +-RIM_REACH), the
 * local roof height, the turf's retreat and the exposed root bed's depth. */
export function rimGroundTile( lattice: RimLattice, box: Bounds ): RimGroundField {

	const [ a, b ] = texelRange( box.x0, box.x1 ), [ c, d ] = texelRange( box.z0, box.z1 );
	const i0 = a - PAD_TEXELS, j0 = c - PAD_TEXELS, nx = b - a + 2 * PAD_TEXELS, nz = d - c + 2 * PAD_TEXELS;
	const mask = new Field2D( i0 * RIM_CELL, j0 * RIM_CELL, nx, nz, RIM_CELL );
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) mask.data[ j * nx + i ] = lattice.at( i0 + i, j0 + j ) ? - 1 : 1;
	const coast = mask.signedDistance();
	const data = new Float32Array( nx * nz * 4 );
	for ( let row = 0; row < nz; row ++ ) for ( let col = 0; col < nx; col ++ ) {

		const x = ( i0 + col + 0.5 ) * RIM_CELL, z = ( j0 + row + 0.5 ) * RIM_CELL;
		const broad = noise3( x * 0.49 + 3.8, 8.7, z * 0.49 - 2.1 ) * 0.5 + 0.5;
		const broken = noise3( x * 1.17 - 6.2, 3.4, z * 1.17 + 7.1 ) * 0.5 + 0.5;
		const pocket = Math.pow( smoothstep( 0.55, 0.85, broad * 0.72 + broken * 0.28 ), 1.7 );
		const roots = noise3( x * 0.67 - 2.6, 5.8, z * 0.67 + 9.3 ) * 0.5 + 0.5;
		const k = ( row * nx + col ) * 4;
		data[ k ] = Math.max( - RIM_REACH, Math.min( RIM_REACH, coast.data[ k / 4 ] ) );
		data[ k + 1 ] = islandSurfaceHeight( x, z );
		data[ k + 2 ] = - 0.09 + pocket * 0.43;
		// The root bed's depth below the roof, patchy along the coast: deep cuts expose a band of
		// root soil, and where it runs shallow the turf creeps down over the lip instead (see
		// TerrainMaterial), so the edge alternates between earth and overgrown stretches. Both the
		// band (3 - 15 cm) and the retreat pockets stay small.
		data[ k + 3 ] = 0.03 + Math.pow( smoothstep( 0.45, 0.8, roots ), 1.4 ) * 0.12;

	}
	return { data, nx, nz, x0: i0 * RIM_CELL, z0: j0 * RIM_CELL, cell: RIM_CELL };

}

/** The texels of `field` whose centres lie in `box` (a box's own share of its tile). */
export function ownTexels( field: RimGroundField, box: Bounds ): RimGroundField {

	const [ a, b ] = texelRange( box.x0, box.x1 ), [ c, d ] = texelRange( box.z0, box.z1 );
	const fi = Math.round( field.x0 / field.cell ), fj = Math.round( field.z0 / field.cell );
	const nx = b - a, nz = d - c, data = new Float32Array( nx * nz * 4 );
	for ( let j = 0; j < nz; j ++ ) {

		const from = ( ( c - fj + j ) * field.nx + a - fi ) * 4;
		data.set( field.data.subarray( from, from + nx * 4 ), j * nx * 4 );

	}
	return { data, nx, nz, x0: a * RIM_CELL, z0: c * RIM_CELL, cell: RIM_CELL };

}

/** One field from boxes' own texels: the rectangle round them all, where no box lies the open
 * sea's values (outside the coast, at the meadow's height). */
export function assembleRimGround( parts: RimGroundField[] ): RimGroundField {

	let i0 = Infinity, j0 = Infinity, i1 = - Infinity, j1 = - Infinity;
	for ( const p of parts ) {

		const pi = Math.round( p.x0 / p.cell ), pj = Math.round( p.z0 / p.cell );
		i0 = Math.min( i0, pi ); j0 = Math.min( j0, pj ); i1 = Math.max( i1, pi + p.nx ); j1 = Math.max( j1, pj + p.nz );

	}
	const nx = i1 - i0, nz = j1 - j0, data = new Float32Array( nx * nz * 4 );
	for ( let k = 0; k < nx * nz; k ++ ) { data[ k * 4 ] = RIM_REACH; data[ k * 4 + 1 ] = ISLAND_TOP; }
	for ( const p of parts ) {

		const pi = Math.round( p.x0 / p.cell ) - i0, pj = Math.round( p.z0 / p.cell ) - j0;
		for ( let j = 0; j < p.nz; j ++ ) data.set( p.data.subarray( j * p.nx * 4, ( j + 1 ) * p.nx * 4 ), ( ( pj + j ) * nx + pi ) * 4 );

	}
	return { data, nx, nz, x0: i0 * RIM_CELL, z0: j0 * RIM_CELL, cell: RIM_CELL };

}

/** The world's RIM_BOX boxes that meet the land's box `b` and RIM_PAD round it, and one lattice
 * over them and RIM_PAD round, from which each box's tile is cut as its own window would build it. */
export function rimBoxes( sdf: SDF, b: Bounds ): { boxes: Bounds[]; lattice: RimLattice } {

	const boxes = gridBoxes( grow( b, RIM_PAD ), RIM_BOX ), last = boxes[ boxes.length - 1 ];
	return { boxes, lattice: new RimLattice( sdf, grow( { x0: boxes[ 0 ].x0, z0: boxes[ 0 ].z0, x1: last.x1, z1: last.z1 }, RIM_PAD ) ) };

}

/** The rim ground over the land's box `b` and RIM_PAD round it, assembled from the tiles of the
 * world's RIM_BOX boxes that cover it: the tests' entry point (the worker assembles the same tiles
 * in each chunk (Chunks.ts), where it also traces the lip over them). */
export function buildRimGround( sdf: SDF, b: Bounds ): RimGroundField {

	const { boxes, lattice } = rimBoxes( sdf, b );
	return assembleRimGround( boxes.map( ( box ) => ownTexels( rimGroundTile( lattice, box ), box ) ) );

}

// CPU bilinear lookup matches a linear-filtered texture whose texels are the cell centres. The
// arithmetic runs on the world lattice's indices, so any two fields that hold the same texels
// round a lookup alike.
export function sampleRimGround( field: RimGroundField, x: number, z: number ): RimGroundSample {

	const { nx, nz, cell, data } = field;
	const fx = x / cell - 0.5, fz = z / cell - 0.5;
	const wi = Math.floor( fx ), wj = Math.floor( fz );
	let i = wi - Math.round( field.x0 / cell ), j = wj - Math.round( field.z0 / cell ), u = fx - wi, v = fz - wj;
	// outside, values continue the edge texel
	if ( i < 0 ) { i = 0; u = 0; } else if ( i >= nx - 1 ) { i = nx - 1; u = 0; }
	if ( j < 0 ) { j = 0; v = 0; } else if ( j >= nz - 1 ) { j = nz - 1; v = 0; }
	const i1 = Math.min( i + 1, nx - 1 ), j1 = Math.min( j + 1, nz - 1 );
	const sample = ( channel: number ) => {

		const a = data[ ( j * nx + i ) * 4 + channel ], b = data[ ( j * nx + i1 ) * 4 + channel ];
		const c = data[ ( j1 * nx + i ) * 4 + channel ], d = data[ ( j1 * nx + i1 ) * 4 + channel ];
		return ( a + ( b - a ) * u ) * ( 1 - v ) + ( c + ( d - c ) * u ) * v;

	};
	return { distance: sample( 0 ), roofY: sample( 1 ), retreat: sample( 2 ), depth: sample( 3 ) };

}

// Thin the grass only where the same field exposes a little root soil or stone beneath it.
export function rimGrassCover( ground: RimGroundSample ): number {

	return smoothstep( ground.retreat - RIM_FRINGE_FADE, ground.retreat + RIM_FRINGE_FADE, - ground.distance );

}

// ------------------------------------------------------------------ the traced coast

// A traced coast line: its vertices in order, the solid on one consistent side, from an edge of
// the field to another (open) or round to its first vertex again (closed).
export interface CoastChain { x: number[]; z: number[]; closed: boolean }

/** The iso-line d = 0 of a field on the rim ground's lattice (the first of `stride` values per
 * texel), by marching squares, chained in its direction. A vertex is the line's crossing of a
 * lattice edge, interpolated from the edge's two values, so fields that share those values share
 * the vertex; open chains run from the field's border to its border, and a closed loop starts at
 * its lowest edge (by row, then column, of the world lattice), so every field that holds a loop
 * starts it alike. */
export function coastChains( field: ShoreField, stride = 4 ): CoastChain[] {

	const { nx, nz, cell, data } = field;
	const I0 = Math.round( field.x0 / cell ), J0 = Math.round( field.z0 / cell );
	const d = ( i: number, j: number ) => data[ ( j * nx + i ) * stride ];
	const next = new Map<number, number>(), entered = new Set<number>();
	for ( let j = 0; j + 1 < nz; j ++ ) for ( let i = 0; i + 1 < nx; i ++ ) {

		for ( const [ a, b ] of cellSegments( d( i, j ), d( i + 1, j ), d( i + 1, j + 1 ), d( i, j + 1 ), i, j, nx ) ) {

			next.set( a, b );
			entered.add( b );

		}

	}
	const vertex = ( id: number, chain: CoastChain ) => {

		const k = id >> 1, i = k % nx, j = ( k - i ) / nx;
		const a = d( i, j ), b = id & 1 ? d( i, j + 1 ) : d( i + 1, j );
		const t = a / ( a - b );
		chain.x.push( ( I0 + i + 0.5 + ( id & 1 ? 0 : t ) ) * cell );
		chain.z.push( ( J0 + j + 0.5 + ( id & 1 ? t : 0 ) ) * cell );

	};
	const ids = [ ...next.keys() ].sort( ( a, b ) => a - b );
	const seen = new Set<number>();
	const chains: CoastChain[] = [];
	const follow = ( first: number, closed: boolean ) => {

		const chain: CoastChain = { x: [], z: [], closed };
		let id: number | undefined = first;
		while ( id !== undefined && ! seen.has( id ) ) {

			seen.add( id );
			vertex( id, chain );
			id = next.get( id );

		}
		if ( ! closed && id !== undefined ) throw new Error( 'an open coast chain ran into a traced edge' );
		chains.push( chain );

	};
	// open chains from their first edge, then the loops left, each from its lowest edge
	for ( const id of ids ) if ( ! entered.has( id ) ) follow( id, false );
	for ( const id of ids ) if ( ! seen.has( id ) ) follow( id, true );
	return chains;

}

// The segments of one marching-squares cell (corner values v0 .. v3 counter-clockwise from
// ( i, j )) as pairs of edge ids: horizontal edge 2 * ( j * nx + i ), vertical + 1. Segments run
// with the solid on one consistent side, so lines chain in one direction.
function cellSegments( v0: number, v1: number, v2: number, v3: number, i: number, j: number, nx: number ): [ number, number ][] {

	const code = ( v0 < 0 ? 1 : 0 ) | ( v1 < 0 ? 2 : 0 ) | ( v2 < 0 ? 4 : 0 ) | ( v3 < 0 ? 8 : 0 );
	if ( code === 0 || code === 15 ) return [];
	const bottom = 2 * ( j * nx + i ), top = 2 * ( ( j + 1 ) * nx + i );
	const left = 2 * ( j * nx + i ) + 1, right = 2 * ( j * nx + i + 1 ) + 1;
	const centre = ( v0 + v1 + v2 + v3 ) < 0;
	return ( {
		1: [ [ left, bottom ] ], 2: [ [ bottom, right ] ], 3: [ [ left, right ] ], 4: [ [ right, top ] ],
		5: centre ? [ [ left, top ], [ right, bottom ] ] : [ [ left, bottom ], [ right, top ] ],
		6: [ [ bottom, top ] ], 7: [ [ left, top ] ], 8: [ [ top, left ] ], 9: [ [ top, bottom ] ],
		10: centre ? [ [ bottom, left ], [ top, right ] ] : [ [ bottom, right ], [ top, left ] ],
		11: [ [ top, right ] ], 12: [ [ right, left ] ], 13: [ [ right, bottom ] ], 14: [ [ bottom, left ] ],
	} as Record<number, [ number, number ][]> )[ code ];

}

// A place on a chain: segment k (from vertex k to the next) and the point ( x, z ) on it.
interface ChainPoint { k: number; x: number; z: number }

const segments = ( chain: CoastChain ) => chain.closed ? chain.x.length : chain.x.length - 1;

// The point at parameter t of segment k, its ends exactly.
function pointOn( chain: CoastChain, k: number, t: number ): ChainPoint {

	const e = ( k + 1 ) % chain.x.length;
	if ( t === 0 ) return { k, x: chain.x[ k ], z: chain.z[ k ] };
	if ( t === 1 ) return { k, x: chain.x[ e ], z: chain.z[ e ] };
	return { k, x: chain.x[ k ] + ( chain.x[ e ] - chain.x[ k ] ) * t, z: chain.z[ k ] + ( chain.z[ e ] - chain.z[ k ] ) * t };

}

/** The point `distance` metres along the chain from `from` (backward when negative), or undefined
 * past an open chain's end. The walk depends only on the vertices it passes, so two fields that
 * share them walk alike. */
export function walkChain( chain: CoastChain, from: ChainPoint, distance: number ): ChainPoint | undefined {

	const n = chain.x.length, count = segments( chain );
	let { k, x, z } = from, rest = Math.abs( distance );
	for ( ;; ) {

		const e = distance >= 0 ? ( k + 1 ) % n : k;
		const ex = chain.x[ e ], ez = chain.z[ e ];
		const l = Math.hypot( ex - x, ez - z );
		if ( rest <= l ) return l > 0 ? { k, x: x + ( ex - x ) * ( rest / l ), z: z + ( ez - z ) * ( rest / l ) } : { k, x, z };
		rest -= l; x = ex; z = ez;
		k += distance >= 0 ? 1 : - 1;
		if ( k >= count || k < 0 ) {

			if ( ! chain.closed ) return;
			k = ( k + count ) % count;

		}

	}

}

// The part of the segment from ( px, pz ) to ( qx, qz ) inside the box, as [ t0, t1 ] (Liang and
// Barsky), or null. A side's crossing comes out the same from either box that shares it, and a
// segment lying on a side belongs to the box above it, as the half-open boxes' points do.
function clip( px: number, pz: number, qx: number, qz: number, box: Bounds ): [ number, number ] | null {

	let t0 = 0, t1 = 1;
	const dx = qx - px, dz = qz - pz;
	for ( const [ p, q, upper ] of [ [ - dx, px - box.x0, false ], [ dx, box.x1 - px, true ], [ - dz, pz - box.z0, false ], [ dz, box.z1 - pz, true ] ] as [ number, number, boolean ][] ) {

		if ( p === 0 ) {

			if ( q < 0 || ( upper && q === 0 ) ) return null;
			continue;

		}
		const r = q / p;
		if ( p < 0 ) t0 = Math.max( t0, r ); else t1 = Math.min( t1, r );

	}
	return t0 < t1 ? [ t0, t1 ] : null;

}

// One stretch of a chain inside a box: from where it enters to where it leaves (points on the
// box's border, the same from the box on either side), or a whole loop inside the box.
interface ChainPiece { chain: CoastChain; start: ChainPoint; end: ChainPoint; loop: boolean }

function piecesInBox( chain: CoastChain, box: Bounds ): ChainPiece[] {

	const count = segments( chain );
	const parts = Array.from( { length: count }, ( _, k ) => {

		const e = ( k + 1 ) % chain.x.length;
		return clip( chain.x[ k ], chain.z[ k ], chain.x[ e ], chain.z[ e ], box );

	} );
	// segment k carries on into segment k + 1 inside the box
	const joins = ( k: number ) => {

		const a = parts[ k ], b = chain.closed || k + 1 < count ? parts[ ( k + 1 ) % count ] : null;
		return a !== null && b !== null && a[ 1 ] === 1 && b[ 0 ] === 0;

	};
	if ( chain.closed && parts.every( ( p ) => p !== null && p[ 0 ] === 0 && p[ 1 ] === 1 ) ) {

		return [ { chain, start: pointOn( chain, 0, 0 ), end: pointOn( chain, count - 1, 1 ), loop: true } ];

	}
	const pieces: ChainPiece[] = [];
	for ( let k = 0; k < count; k ++ ) {

		if ( parts[ k ] === null || joins( ( k - 1 + count ) % count ) && ( chain.closed || k > 0 ) ) continue;
		let e = k;
		while ( joins( e ) ) e = ( e + 1 ) % count;
		pieces.push( { chain, start: pointOn( chain, k, parts[ k ]![ 0 ] ), end: pointOn( chain, e, parts[ e ]![ 1 ] ), loop: false } );

	}
	return pieces;

}

// The piece resampled every `step` metres or a little less: n = ceil( length / step ) equal steps,
// so both its ends are samples.
function resamplePiece( piece: ChainPiece, step: number ): ChainPoint[] {

	const { chain, start, end } = piece;
	const n = chain.x.length;
	// the piece's polyline: its start, the vertices it passes, its end
	const line: ChainPoint[] = [ start ];
	for ( let k = start.k; k !== end.k || ( piece.loop && line.length === 1 ); k = ( k + 1 ) % segments( chain ) ) {

		const e = ( k + 1 ) % n;
		line.push( { k: ( k + 1 ) % segments( chain ), x: chain.x[ e ], z: chain.z[ e ] } );

	}
	line.push( end );
	let length = 0;
	for ( let i = 1; i < line.length; i ++ ) length += Math.hypot( line[ i ].x - line[ i - 1 ].x, line[ i ].z - line[ i - 1 ].z );
	const count = Math.max( 1, Math.ceil( length / step ) );
	const samples: ChainPoint[] = [ start ];
	let i = 1, before = 0;
	for ( let q = 1; q < count; q ++ ) {

		const s = length * q / count;
		let l = Math.hypot( line[ i ].x - line[ i - 1 ].x, line[ i ].z - line[ i - 1 ].z );
		while ( before + l < s && i + 1 < line.length ) {

			before += l; i ++;
			l = Math.hypot( line[ i ].x - line[ i - 1 ].x, line[ i ].z - line[ i - 1 ].z );

		}
		// ( a, b ) lies on the chain's segment a.k: a is the piece's start or a vertex, labelled
		// with the segment that leaves it
		const f = l > 0 ? Math.min( 1, ( s - before ) / l ) : 0, a = line[ i - 1 ], b = line[ i ];
		samples.push( { k: a.k, x: a.x + ( b.x - a.x ) * f, z: a.z + ( b.z - a.z ) * f } );

	}
	samples.push( end );
	return samples;

}

// ------------------------------------------------------------------ the lip

// How far the meadow's turf holds at the rim, 0..1: a function of position and of the root bed
// (retreat pockets, where the turf already gives way to soil and stone, hold none). Most of the
// coast is covered; the rest is thinner in stretches of one to a few metres, and a finer field
// breaks the longest runs. Nothing is placed by hand, so it follows any coast the island takes.
// Each lip sample carries it; the page reads none of the lip today (it was built for blades draped
// over the edge, which the meadow no longer has).
export function rimLipPresence( x: number, z: number, retreat: number ): number {

	const broad = noise3( x * 0.41 + 1.3, 6.1, z * 0.41 - 4.4 ) * 0.5 + 0.5;
	const breakup = noise3( x * 1.6 - 3.7, 0.9, z * 1.6 + 8.1 ) * 0.5 + 0.5;
	return smoothstep( 0.12, 0.34, broad ) * smoothstep( 0.14, 0.36, breakup ) * ( 1 - smoothstep( - 0.03, 0.09, retreat ) );

}

// The highest solid surface in a column, marched down from above the plateau.
export function topAt( sdf: SDF, x: number, z: number ): number | undefined {

	const top = islandSurfaceHeight( x, z );
	let y = top + 0.6;
	for ( let i = 0; i < 70; i ++ ) {

		const d = sdf( x, y, z );
		if ( d < 0.002 ) return y;
		y -= Math.max( 0.004, d * 0.7 );
		if ( y < top - 0.3 ) return;

	}

}

// Per lip sample, a root span on the meadow's ground just inside the lip: LIP_POINTS points
// ( x, y, z ) from LIP_SPAN[ 0 ] to LIP_SPAN[ 1 ] (m, inside the traced coast), a centimetre above
// the ground (the page reads none of it today, as with the presence).
export const LIP_POINTS = 2;
const LIP_SPAN = [ - 0.16, - 0.02 ];
// Per lip sample: its place on the coast ( x, z ), the outward direction ( x, z ), presence, the
// roof's height and the wall below it: at each of LIP_WALL's depths under the roof (every 10 cm
// down to the longest hanging blade's reach), the outward offset from the coast (m) where the
// stone is LIP_CLEAR away, for blades draped over the edge to lie on, so that they drape over a
// battered wall instead of passing into it (no blade drapes over the edge today).
export const LIP_WALL = Array.from( { length: 15 }, ( _, k ) => Math.round( ( k + 1 ) * 10 ) / 100 );
export const LIP_INFO = 6 + LIP_WALL.length;
const LIP_CLEAR = 0.03;
// The lip's samples lie this far apart along the coast, or a little less.
export const LIP_STEP = 0.05;
// Where the noise fields cross their thresholds steeply, the lip's grass would end in a cut. A
// triangular filter along the coast (taps LIP_STEP apart, half-width EASE taps) eases the
// presence over a few decimetres instead.
const EASE = 4;

// The lip at a place on the coast: its root span and its record (LIP_INFO without the wall).
// Everything it reads is the tile near the place, the SDF and the chain within EASE steps of it,
// so a place both boxes share gives both the same sample.
function lipSample( sdf: SDF, tile: RimGroundField, chain: CoastChain, at: ChainPoint, points: number[], info: number[] ): void {

	const { x, z } = at;
	const presenceAt = ( p: ChainPoint ) => rimLipPresence( p.x, p.z, sampleRimGround( tile, p.x, p.z ).retreat );
	let sum = 0, weight = 0;
	for ( let j = - EASE; j <= EASE; j ++ ) {

		const tap = j === 0 ? at : walkChain( chain, at, j * LIP_STEP );
		if ( ! tap ) continue;
		const w = EASE + 1 - Math.abs( j );
		sum += presenceAt( tap ) * w; weight += w;

	}
	const presence = sum / weight;
	const g = sampleRimGround( tile, x, z );
	const e = 0.15;
	let nx = sampleRimGround( tile, x + e, z ).distance - sampleRimGround( tile, x - e, z ).distance;
	let nz = sampleRimGround( tile, x, z + e ).distance - sampleRimGround( tile, x, z - e ).distance;
	const l = Math.hypot( nx, nz ) || 1;
	nx /= l; nz /= l;
	const roof = topAt( sdf, x - nx * 0.22, z - nz * 0.22 ) ?? g.roofY;
	// the inner root on the meadow; the outer one where the ground falls away, held within 15 cm
	// below the inner one (and there where the wall has receded under it)
	const inner = topAt( sdf, x + nx * LIP_SPAN[ 0 ], z + nz * LIP_SPAN[ 0 ] ) ?? roof;
	const outer = Math.min( inner, Math.max( topAt( sdf, x + nx * LIP_SPAN[ 1 ], z + nz * LIP_SPAN[ 1 ] ) ?? - Infinity, inner - 0.15 ) );
	points.push( x + nx * LIP_SPAN[ 0 ], inner + 0.01, z + nz * LIP_SPAN[ 0 ], x + nx * LIP_SPAN[ 1 ], outer + 0.01, z + nz * LIP_SPAN[ 1 ] );
	info.push( x, z, nx, nz, presence, roof );
	lipWall( sdf, x, z, nx, nz, roof, info );

}

// The wall under a lip sample (LIP_INFO): from 0.3 m inside the coast, outward until the stone
// is LIP_CLEAR away, at each of LIP_WALL's depths under the roof. Where the wall recedes the
// offset stays at -0.3 (nothing to keep clear of); it reaches out at most 1.5 m.
function lipWall( sdf: SDF, x: number, z: number, nx: number, nz: number, roof: number, out: number[] ): void {

	for ( const depth of LIP_WALL ) {

		let s = - 0.3;
		for ( let i = 0; i < 12 && s < 1.5; i ++ ) {

			const d = sdf( x + nx * s, roof - depth, z + nz * s );
			if ( d >= LIP_CLEAR ) break;
			s += LIP_CLEAR - d;

		}
		out.push( Math.min( s, 1.5 ) );

	}

}

/** The lip a box owns: the coast traced in its tile (`rimGroundTile`), cut where it crosses the
 * box's border, each piece between two crossings resampled evenly so both crossings are samples
 * (and a loop inside the box from its first vertex), with each sample's root span and record.
 * Neighbouring boxes compute a crossing they share alike, so the grass along their pieces meets
 * without a seam; a segment belongs to the box of the piece it lies in. */
export function buildRimLip( sdf: SDF, tile: RimGroundField, box: Bounds ): RimLipData {

	const points: number[] = [], info: number[] = [], pieces: number[] = [];
	for ( const chain of coastChains( tile ) ) {

		// specks of solid or of open stone a few texels across hold no grass
		if ( chain.closed ) {

			let length = 0;
			for ( let k = 0; k < chain.x.length; k ++ ) {

				const e = ( k + 1 ) % chain.x.length;
				length += Math.hypot( chain.x[ e ] - chain.x[ k ], chain.z[ e ] - chain.z[ k ] );

			}
			if ( length < 0.6 ) continue;

		}
		for ( const piece of piecesInBox( chain, box ) ) {

			const samples = resamplePiece( piece, LIP_STEP );
			pieces.push( info.length / LIP_INFO, samples.length );
			for ( const at of samples ) lipSample( sdf, tile, chain, at, points, info );

		}

	}
	return { points: new Float32Array( points ), info: new Float32Array( info ), pieces: new Int32Array( pieces ) };

}

/** Boxes' lips in one, in the order given. */
export function mergeRimLips( parts: RimLipData[] ): RimLipData {

	const sum = ( key: 'points' | 'info' | 'pieces' ) => parts.reduce( ( n, p ) => n + p[ key ].length, 0 );
	const merged: RimLipData = { points: new Float32Array( sum( 'points' ) ), info: new Float32Array( sum( 'info' ) ), pieces: new Int32Array( sum( 'pieces' ) ) };
	let points = 0, info = 0, pieces = 0;
	for ( const p of parts ) {

		merged.points.set( p.points, points );
		merged.info.set( p.info, info );
		for ( let k = 0; k < p.pieces.length; k += 2 ) {

			merged.pieces[ pieces + k ] = p.pieces[ k ] + info / LIP_INFO;
			merged.pieces[ pieces + k + 1 ] = p.pieces[ k + 1 ];

		}
		points += p.points.length; info += p.info.length; pieces += p.pieces.length;

	}
	return merged;

}

// Iso-line d = 0 of the field's distance channel (the first of `stride` per texel), as closed (or
// border-clipped) polylines.
export function coastLoops( field: ShoreField, stride = 4 ): [ number, number ][][] {

	const { nx, nz, cell, data } = field;
	const d = ( i: number, j: number ) => data[ ( j * nx + i ) * stride ];
	const px = ( i: number ) => field.x0 + ( i + 0.5 ) * cell, pz = ( j: number ) => field.z0 + ( j + 0.5 ) * cell;
	// Crossing on a cell edge: horizontal edge id 2 * ( j * nx + i ), vertical + 1.
	const crossing = new Map<number, [ number, number ]>();
	const at = ( id: number ): [ number, number ] => {

		let p = crossing.get( id );
		if ( p ) return p;
		const k = id >> 1, i = k % nx, j = Math.floor( k / nx );
		const a = d( i, j ), b = id & 1 ? d( i, j + 1 ) : d( i + 1, j );
		const t = a / ( a - b );
		p = id & 1 ? [ px( i ), pz( j ) + t * cell ] : [ px( i ) + t * cell, pz( j ) ];
		crossing.set( id, p );
		return p;

	};
	const next = new Map<number, number>();
	for ( let j = 0; j + 1 < nz; j ++ ) for ( let i = 0; i + 1 < nx; i ++ ) {

		for ( const [ a, b ] of cellSegments( d( i, j ), d( i + 1, j ), d( i + 1, j + 1 ), d( i, j + 1 ), i, j, nx ) ) next.set( a, b );

	}
	const loops: [ number, number ][][] = [];
	const seen = new Set<number>();
	for ( const first of next.keys() ) {

		if ( seen.has( first ) ) continue;
		const loop: [ number, number ][] = [];
		let id: number | undefined = first;
		while ( id !== undefined && ! seen.has( id ) ) {

			seen.add( id );
			loop.push( at( id ) );
			id = next.get( id );

		}
		if ( id === first ) loop.push( at( first ) );
		loops.push( loop );

	}
	return loops;

}
