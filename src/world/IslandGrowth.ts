// The island's growth: the land on a bit lattice, grown one piece at a time from the world's
// centre outward (docs/game-design.md, "How the island grows"). Worker-safe (no three).
//
// The land follows a fixed hidden relief, a warped fractal sum (coastlines as the level sets of a
// fractal surface after Mandelbrot, *The Fractal Geometry of Nature*, 1982; islands shaped from
// noise as in Amit Patel's *Making maps with noise* (Red Blob Games); the domain warp after Inigo
// Quilez's *Domain warping*). Each piece is a priority flood over the sea from a site on the coast
// (invasion percolation after Wilkinson and Willemsen, *Invasion percolation: a new form of
// percolation theory*, J. Phys. A 16, 1983; the flood's queue as in Barnes, Lehman and Mulla,
// *Priority-Flood*, Computers & Geosciences 62, 2014): the front climbs the relief, held compact by
// its distance from the site, so it stops on a contour of the relief and the new coast is a natural
// one. The union is rounded (a morphological close, then open), kept to the island's component,
// its lakes filled; old land is never removed. Sites are drawn from the coast nearest the island's
// middle, away from the last pieces' directions and across the island's long axis, so it grows
// all round without drifting toward a circle or a square.
//
// Exact arithmetic only (+ - * /, square roots, floor; no library transcendentals), so a seed
// grows the same island in every engine: directions come from polynomials (`turn`), angular gaps
// are dot products, the exponential weights are ( 1 + x / 16 )^16, and the flood's ties break by
// cell index.
//
// The land is a bit lattice (`LandLattice`, 0.25 m cells over +-96 m, saved with `toBytes`). The
// site is chosen over the whole island (its middle needs the whole land's distance field); the
// flood and the rounding work in windows around the piece. `GROWTH` holds every parameter.

import { Field2D, roundCorners } from './Field2D.ts';
import { fbm2, hash3i, mulberry32, smoothstep } from './noise.ts';

export const GROWTH = {
	cell: 0.25, // the land lattice's cell (m)
	half: 96, // its half extent (m)
	maxSteps: 36, // the growth horizon: steps after the starting island
	// the hidden relief (m): a warped fractal sum, a broad low octave and a gentle dome toward the
	// world's centre
	warpAmp: 5, warpFreq: 0.03,
	noiseAmp: 28, noiseFreq: 0.025, noiseOctaves: 5,
	lowAmp: 12, lowFreq: 0.008,
	dome: 0.35, // m per m from the centre: keeps a long run of pieces from carrying the land off one way
	// a piece: the flood's priority is the relief less pull times the elliptic distance from the site
	startArea: 400, pieceArea: 180, pieceSpread: [ 0.55, 1.5 ], // m^2, the piece's area times U( spread )
	pull: 1.2, // about the relief's slope: a piece follows its contours into headlands and bays, yet stays
	// a lobe rather than a crescent round the coast (a crescent's length over its thickness is about
	// twice the slope over the pull)
	startAspect: [ 1, 1.4 ], aspect: [ 1, 1.8 ], // a piece is longer out from the coast than along it
	axisSpread: 0.125, // turns either side of the coast normal for the piece's long axis (45 degrees)
	close: 4, open: 3, // no inlet narrower than about 8 m, no neck narrower than about 6 m
	// the site: the first coast point along stratified directions from the island's middle, weighted
	candidates: 10,
	centrePull: 0.8, // toward the coast nearest the middle
	spreadDot: [ 0.8776, 0.17 ], // away from the recent pieces' directions: in full beyond 1.4 rad, none within 0.5 rad
	recent: 2,
	ahead: 5, siteT: 16, // toward high relief 5 m out (m, m per e-fold)
	axisBias: 3, // across the island's long axis, by its elongation
	// windows (m): the flood's reach from its site, and how far beyond the flood the rounding may
	// change the land
	floodReach: 48, settleReach: 8,
} as const;

const CELL = GROWTH.cell;
const N = Math.round( 2 * GROWTH.half / CELL ); // 768
const X0 = - GROWTH.half;
const ROW_WORDS = N / 32;
const WORDS = N * ROW_WORDS;

// cells [ i0, i1 ) x [ j0, j1 ) of the lattice
export interface Window { i0: number; j0: number; i1: number; j1: number }
export interface Box { xMin: number; zMin: number; xMax: number; zMax: number }

// a piece's site on the coast, and its heading ( ux, uz ) from the island's middle (zero for the start)
export interface Site { x: number; z: number; ux: number; uz: number }

// One step's land: the cells it adds (the flood, the rounding's fillets and any lakes it closes),
// bit-packed row by row over its window.
export interface Piece { step: number; site: Site; area: number; window: Window; bits: Uint32Array }

const centre = ( i: number ) => X0 + ( i + 0.5 ) * CELL;

function clip( w: Window ): Window {

	return { i0: Math.max( 0, w.i0 ), j0: Math.max( 0, w.j0 ), i1: Math.min( N, w.i1 ), j1: Math.min( N, w.j1 ) };

}

const pad = ( w: Window, n: number ): Window => clip( { i0: w.i0 - n, j0: w.j0 - n, i1: w.i1 + n, j1: w.j1 + n } );

export class LandLattice {

	words: Uint32Array;
	headings: number[]; // ( ux, uz ) of the last GROWTH.recent pieces, oldest first

	constructor( words = new Uint32Array( WORDS ), headings: number[] = [] ) {

		this.words = words;
		this.headings = headings;

	}

	has( i: number, j: number ): boolean {

		const k = j * N + i;
		return ( ( this.words[ k >>> 5 ] >>> ( k & 31 ) ) & 1 ) === 1;

	}

	inside( x: number, z: number ): boolean {

		const i = Math.floor( ( x - X0 ) / CELL ), j = Math.floor( ( z - X0 ) / CELL );
		return i >= 0 && j >= 0 && i < N && j < N && this.has( i, j );

	}

	// the land's signed distance (m, negative inside) over a window, by Field2D's exact EDT
	signedDistance( w: Window ): Field2D {

		const nx = w.i1 - w.i0, nz = w.j1 - w.j0;
		const f = new Field2D( X0 + w.i0 * CELL, X0 + w.j0 * CELL, nx, nz, CELL );
		for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) f.data[ j * nx + i ] = this.has( w.i0 + i, w.j0 + j ) ? - 1 : 1;
		return f.signedDistance();

	}

	// the window of the land's cells
	cells(): Window {

		let i0 = N, j0 = N, i1 = 0, j1 = 0;
		for ( let j = 0; j < N; j ++ ) for ( let q = 0; q < ROW_WORDS; q ++ ) {

			const v = this.words[ j * ROW_WORDS + q ];
			if ( v === 0 ) continue;
			j0 = Math.min( j0, j ); j1 = j + 1;
			i0 = Math.min( i0, q * 32 + 31 - Math.clz32( v & - v ) );
			i1 = Math.max( i1, q * 32 + 32 - Math.clz32( v ) );

		}

		return { i0, j0, i1, j1 };

	}

	bounds(): Box {

		const w = this.cells();
		return { xMin: X0 + w.i0 * CELL, zMin: X0 + w.j0 * CELL, xMax: X0 + w.i1 * CELL, zMax: X0 + w.j1 * CELL };

	}

	add( piece: Piece ): void {

		const { i0, j0, i1 } = piece.window, nx = i1 - i0, bits = piece.bits;
		for ( let q = 0; q < bits.length; q ++ ) for ( let v = bits[ q ]; v !== 0; v &= v - 1 ) {

			const b = q * 32 + 31 - Math.clz32( v & - v );
			const k = ( j0 + Math.floor( b / nx ) ) * N + i0 + b % nx;
			this.words[ k >>> 5 ] |= 1 << ( k & 31 );

		}

		this.headings.push( piece.site.ux, piece.site.uz );
		if ( this.headings.length > 2 * GROWTH.recent ) this.headings.splice( 0, 2 );

	}

	// the cells, then the recent headings as float64
	toBytes(): Uint8Array {

		const out = new Uint8Array( WORDS * 4 + 8 * this.headings.length );
		out.set( new Uint8Array( this.words.buffer, this.words.byteOffset, WORDS * 4 ) );
		new Float64Array( out.buffer, WORDS * 4, this.headings.length ).set( this.headings );
		return out;

	}

	static fromBytes( bytes: Uint8Array ): LandLattice {

		const copy = bytes.slice();
		return new LandLattice( new Uint32Array( copy.buffer, 0, WORDS ), Array.from( new Float64Array( copy.buffer, WORDS * 4 ) ) );

	}

}

// The hidden relief (m) of a world seed: land comes where the pieces' floods climb it.
export function relief( seed: number ): ( x: number, z: number ) => number {

	const G = GROWTH;
	const ox = hash3i( seed, 1, 11 ) * 160, oz = hash3i( seed, 2, 13 ) * 160;
	return ( x, z ) => {

		const f = G.warpFreq;
		const ux = x + fbm2( x * f + ox + 3.1, z * f + oz - 1.7, 3 ) * G.warpAmp * 2;
		const uz = z + fbm2( x * f + ox - 5.3, z * f + oz + 8.9, 3 ) * G.warpAmp * 2;
		return fbm2( ux * G.noiseFreq + ox + 0.37, uz * G.noiseFreq + oz + 4.1, G.noiseOctaves ) * 2 * G.noiseAmp
			+ fbm2( ux * G.lowFreq + ox - 7.7, uz * G.lowFreq + oz + 2.2, 2 ) * 2 * G.lowAmp
			- G.dome * Math.sqrt( x * x + z * z );

	};

}

// A unit vector t turns anticlockwise from +x (toward +z): the quarter turn's Taylor series to the
// 13th and 14th powers (within 1e-11), normalised, then turned by whole quarters.
function turn( t: number ): [ number, number ] {

	t -= Math.floor( t );
	const q = Math.floor( t * 4 ), a = ( t * 4 - q ) * ( Math.PI / 2 ), a2 = a * a;
	let s = a * ( 1 - a2 / 6 * ( 1 - a2 / 20 * ( 1 - a2 / 42 * ( 1 - a2 / 72 * ( 1 - a2 / 110 * ( 1 - a2 / 156 ) ) ) ) ) );
	let c = 1 - a2 / 2 * ( 1 - a2 / 12 * ( 1 - a2 / 30 * ( 1 - a2 / 56 * ( 1 - a2 / 90 * ( 1 - a2 / 132 * ( 1 - a2 / 182 ) ) ) ) ) );
	const l = Math.sqrt( s * s + c * c );
	s /= l; c /= l;
	return q === 0 ? [ c, s ] : q === 1 ? [ - s, c ] : q === 2 ? [ - c, - s ] : [ s, - c ];

}

// e^x as ( 1 + x / 16 )^16 by four squarings: close enough for the site weights (x within about
// [ -4, 1 ]) and exact arithmetic
function exp16( x: number ): number {

	let y = Math.max( 0, 1 + x / 16 );
	y *= y; y *= y; y *= y; y *= y;
	return y;

}

const lerp = ( r: readonly [ number, number ], t: number ) => r[ 0 ] + t * ( r[ 1 ] - r[ 0 ] );

// A max-heap of cells by priority; equal priorities pop the lower cell index first, so the flood
// does not depend on the order cells were queued in.
class Heap {

	k: number[] = [];
	p: number[] = [];

	before( p: number, k: number, q: number, l: number ): boolean {

		return p > q || ( p === q && k < l );

	}

	push( k: number, p: number ): void {

		const K = this.k, P = this.p;
		let i = K.length;
		K.push( k ); P.push( p );
		while ( i > 0 ) {

			const j = ( i - 1 ) >> 1;
			if ( ! this.before( p, k, P[ j ], K[ j ] ) ) break;
			K[ i ] = K[ j ]; P[ i ] = P[ j ]; i = j;

		}

		K[ i ] = k; P[ i ] = p;

	}

	pop(): number {

		const K = this.k, P = this.p, top = K[ 0 ];
		const k = K.pop() as number, p = P.pop() as number;
		if ( K.length ) {

			let i = 0;
			for ( ;; ) {

				let c = 2 * i + 1;
				if ( c >= K.length ) break;
				if ( c + 1 < K.length && this.before( P[ c + 1 ], K[ c + 1 ], P[ c ], K[ c ] ) ) c ++;
				if ( ! this.before( P[ c ], K[ c ], p, k ) ) break;
				K[ i ] = K[ c ]; P[ i ] = P[ c ]; i = c;

			}

			K[ i ] = k; P[ i ] = p;

		}

		return top;

	}

}

// One piece's flood: from the site over the sea, highest priority first, until it covers `target`
// m^2; returns the lattice indices of the cells it took.
function flood( height: ( x: number, z: number ) => number, land: LandLattice, site: { x: number; z: number }, target: number, aspect: number, ax: number, az: number ): number[] {

	const i0 = Math.floor( ( site.x - X0 ) / CELL ), j0 = Math.floor( ( site.z - X0 ) / CELL );
	const reach = Math.ceil( GROWTH.floodReach / CELL );
	const w = clip( { i0: i0 - reach, j0: j0 - reach, i1: i0 + reach + 1, j1: j0 + reach + 1 } );
	const nx = w.i1 - w.i0;
	const queued = new Uint8Array( nx * ( w.j1 - w.j0 ) );
	const prio = ( i: number, j: number ) => {

		const x = centre( i ), z = centre( j ), dx = x - site.x, dz = z - site.z;
		const u = ax * dx + az * dz, v = ( az * dx - ax * dz ) * aspect;
		return height( x, z ) - GROWTH.pull * Math.sqrt( u * u + v * v );

	};
	const heap = new Heap(), out: number[] = [];
	queued[ ( j0 - w.j0 ) * nx + i0 - w.i0 ] = 1;
	heap.push( j0 * N + i0, prio( i0, j0 ) );
	const need = target / ( CELL * CELL );
	while ( out.length < need && heap.k.length ) {

		const k = heap.pop(), i = k % N, j = ( k - i ) / N;
		out.push( k );
		for ( let n = 0; n < 4; n ++ ) {

			const ii = i + ( n === 0 ? 1 : n === 1 ? - 1 : 0 ), jj = j + ( n === 2 ? 1 : n === 3 ? - 1 : 0 );
			if ( ii < w.i0 || jj < w.j0 || ii >= w.i1 || jj >= w.j1 ) continue;
			const q = ( jj - w.j0 ) * nx + ii - w.i0;
			if ( queued[ q ] || land.has( ii, jj ) ) continue;
			queued[ q ] = 1;
			heap.push( jj * N + ii, prio( ii, jj ) );

		}

	}

	return out;

}

// 4-connected flood fill over a window's grid from the given cells, through cells where pass( q )
function fill( nx: number, nz: number, seeds: number[], pass: ( q: number ) => boolean ): Uint8Array {

	const seen = new Uint8Array( nx * nz ), stack: number[] = [];
	for ( const q of seeds ) if ( ! seen[ q ] ) { seen[ q ] = 1; stack.push( q ); }
	while ( stack.length ) {

		const q = stack.pop() as number, i = q % nx, j = ( q - i ) / nx;
		const next = [ i + 1 < nx ? q + 1 : - 1, i > 0 ? q - 1 : - 1, j + 1 < nz ? q + nx : - 1, j > 0 ? q - nx : - 1 ];
		for ( const r of next ) if ( r >= 0 && ! seen[ r ] && pass( r ) ) { seen[ r ] = 1; stack.push( r ); }

	}

	return seen;

}

// The land a flood adds once settled: the union rounded (close, then open) in a window around the
// flood, kept to the island's component (the starting island: to its deepest point), the lakes it
// closes filled. Changes stay within GROWTH.settleReach of the flood.
function settle( land: LandLattice, flooded: number[], step: number, site: Site ): Piece {

	const G = GROWTH;
	let fi0 = N, fj0 = N, fi1 = 0, fj1 = 0;
	for ( const k of flooded ) {

		const i = k % N, j = ( k - i ) / N;
		fi0 = Math.min( fi0, i ); fj0 = Math.min( fj0, j ); fi1 = Math.max( fi1, i + 1 ); fj1 = Math.max( fj1, j + 1 );

	}

	const inner = pad( { i0: fi0, j0: fj0, i1: fi1, j1: fj1 }, Math.ceil( G.settleReach / CELL ) );
	// the rounding's four distance transforms read up to 2 ( close + open ) from a cell
	const outer = pad( inner, Math.ceil( 2 * ( G.close + G.open ) / CELL ) + 2 );
	const ox = outer.i1 - outer.i0, oz = outer.j1 - outer.j0;
	const union = new Field2D( X0 + outer.i0 * CELL, X0 + outer.j0 * CELL, ox, oz, CELL );
	for ( let j = 0; j < oz; j ++ ) for ( let i = 0; i < ox; i ++ ) union.data[ j * ox + i ] = land.has( outer.i0 + i, outer.j0 + j ) ? - 1 : 1;
	for ( const k of flooded ) union.data[ ( Math.floor( k / N ) - outer.j0 ) * ox + k % N - outer.i0 ] = - 1;
	const rounded = roundCorners( union.signedDistance(), G.close, G.open ).data;

	// inside the inner window: 2 old land, 1 new land, 0 sea
	const nx = inner.i1 - inner.i0, nz = inner.j1 - inner.j0;
	const m = new Uint8Array( nx * nz ), seeds: number[] = [];
	let deepest = - 1;
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const q = j * nx + i, r = rounded[ ( j + inner.j0 - outer.j0 ) * ox + i + inner.i0 - outer.i0 ];
		m[ q ] = land.has( inner.i0 + i, inner.j0 + j ) ? 2 : r < 0 ? 1 : 0;
		if ( m[ q ] === 2 ) seeds.push( q );
		if ( m[ q ] === 1 && ( deepest < 0 || r < rounded[ deepest ] ) ) deepest = ( j + inner.j0 - outer.j0 ) * ox + i + inner.i0 - outer.i0;

	}

	if ( step === 0 ) seeds.push( ( Math.floor( deepest / ox ) + outer.j0 - inner.j0 ) * nx + deepest % ox + outer.i0 - inner.i0 );
	const kept = fill( nx, nz, seeds, ( q ) => m[ q ] > 0 );

	// lakes: sea the open sea cannot reach, over the land's window and the piece's
	const cells = step === 0 ? inner : land.cells();
	const all = pad( { i0: Math.min( cells.i0, inner.i0 ), j0: Math.min( cells.j0, inner.j0 ), i1: Math.max( cells.i1, inner.i1 ), j1: Math.max( cells.j1, inner.j1 ) }, 1 );
	const ax = all.i1 - all.i0, az = all.j1 - all.j0;
	const solid = new Uint8Array( ax * az );
	for ( let j = 0; j < az; j ++ ) for ( let i = 0; i < ax; i ++ ) {

		const gi = all.i0 + i, gj = all.j0 + j, ii = gi - inner.i0, jj = gj - inner.j0;
		const isNew = ii >= 0 && jj >= 0 && ii < nx && jj < nz && m[ jj * nx + ii ] === 1 && kept[ jj * nx + ii ] === 1;
		solid[ j * ax + i ] = isNew ? 2 : land.has( gi, gj ) ? 1 : 0;

	}

	const border: number[] = [];
	for ( let i = 0; i < ax; i ++ ) border.push( i, ( az - 1 ) * ax + i );
	for ( let j = 0; j < az; j ++ ) border.push( j * ax, j * ax + ax - 1 );
	const sea = fill( ax, az, border.filter( ( q ) => solid[ q ] === 0 ), ( q ) => solid[ q ] === 0 );

	// the piece: new land and filled lakes, packed over their window
	let pi0 = N, pj0 = N, pi1 = 0, pj1 = 0, count = 0;
	const added = ( q: number ) => solid[ q ] === 2 || ( solid[ q ] === 0 && ! sea[ q ] );
	for ( let q = 0; q < ax * az; q ++ ) if ( added( q ) ) {

		const i = q % ax + all.i0, j = Math.floor( q / ax ) + all.j0;
		pi0 = Math.min( pi0, i ); pj0 = Math.min( pj0, j ); pi1 = Math.max( pi1, i + 1 ); pj1 = Math.max( pj1, j + 1 );
		count ++;

	}

	const window = { i0: pi0, j0: pj0, i1: pi1, j1: pj1 }, wx = pi1 - pi0;
	const bits = new Uint32Array( Math.ceil( wx * ( pj1 - pj0 ) / 32 ) );
	for ( let q = 0; q < ax * az; q ++ ) if ( added( q ) ) {

		const b = ( Math.floor( q / ax ) + all.j0 - pj0 ) * wx + q % ax + all.i0 - pi0;
		bits[ b >>> 5 ] |= 1 << ( b & 31 );

	}

	return { step, site, area: count * CELL * CELL, window, bits };

}

// The piece a step adds to the land: step 0 is the starting island, flooded from the world's centre;
// every later step draws from its own stream, so a piece does not depend on how many draws the
// earlier steps took, and the land (with its recent headings) is all it reads.
export function nextPiece( seed: number, land: LandLattice, step: number ): Piece {

	const G = GROWTH;
	const rng = mulberry32( ( hash3i( seed, step, 101 ) * 4294967296 ) >>> 0 );
	const height = relief( seed );

	if ( step === 0 ) {

		const aspect = lerp( G.startAspect, rng() );
		const [ ax, az ] = turn( rng() * 0.5 );
		const site = { x: 0, z: 0, ux: 0, uz: 0 };
		return settle( land, flood( height, land, site, G.startArea, aspect, ax, az ), 0, site );

	}

	// the island's middle: its deepest point
	const w = pad( land.cells(), Math.ceil( 2 / CELL ) );
	const sd = land.signedDistance( w );
	let mid = 0;
	for ( let k = 0; k < sd.data.length; k ++ ) if ( sd.data[ k ] < sd.data[ mid ] ) mid = k;
	const nx = w.i1 - w.i0;
	const mx = centre( w.i0 + mid % nx ), mz = centre( w.j0 + Math.floor( mid / nx ) );

	// candidate sites: the first coast point along stratified directions
	const cands: { x: number; z: number; ux: number; uz: number; r: number; rel: number; w: number }[] = [];
	for ( let c = 0; c < G.candidates; c ++ ) {

		const [ ux, uz ] = turn( ( c + rng() ) / G.candidates );
		let t = 0;
		while ( sd.sample( mx + ux * t, mz + uz * t ) < 0 ) t += 0.1;
		t += CELL;
		const x = mx + ux * t, z = mz + uz * t;
		cands.push( { x, z, ux, uz, r: t, rel: height( x + ux * G.ahead, z + uz * G.ahead ), w: 0 } );

	}

	// the island's long axis ( ex, ez ) and its elongation, from the land's second moments
	let a = 0, sx = 0, sz = 0, xx = 0, zz = 0, xz = 0;
	for ( let j = w.j0; j < w.j1; j ++ ) for ( let i = w.i0; i < w.i1; i ++ ) if ( land.has( i, j ) ) {

		const x = centre( i ), z = centre( j );
		a ++; sx += x; sz += z; xx += x * x; zz += z * z; xz += x * z;

	}

	sx /= a; sz /= a; xx = xx / a - sx * sx; zz = zz / a - sz * sz; xz = xz / a - sx * sz;
	const tr = xx + zz, disc = Math.sqrt( Math.max( 0, tr * tr / 4 - ( xx * zz - xz * xz ) ) );
	const major = tr / 2 + disc, elong = Math.sqrt( major / ( tr / 2 - disc ) );
	// the major eigenvector, from whichever row of ( C - major I ) is the better conditioned
	let ex = xz, ez = major - xx;
	if ( ex * ex + ez * ez < ( major - zz ) * ( major - zz ) + xz * xz ) { ex = major - zz; ez = xz; }
	const el = Math.sqrt( ex * ex + ez * ez ) || 1;
	ex /= el; ez /= el;

	let rMean = 0, relMax = - Infinity;
	for ( const c of cands ) { rMean += c.r / cands.length; relMax = Math.max( relMax, c.rel ); }
	let total = 0;
	for ( const c of cands ) {

		// the angular gap to the recent pieces, as the largest dot product with their headings
		let near = - 1;
		for ( let h = 0; h < land.headings.length; h += 2 ) near = Math.max( near, c.ux * land.headings[ h ] + c.uz * land.headings[ h + 1 ] );
		const across = c.ux * ex + c.uz * ez;
		c.w = exp16( - G.centrePull * ( c.r / rMean - 1 ) ) * ( 0.1 + smoothstep( G.spreadDot[ 0 ], G.spreadDot[ 1 ], near ) )
			* exp16( - G.axisBias * ( elong - 1 ) * across * across ) * exp16( ( c.rel - relMax ) / G.siteT );
		total += c.w;

	}

	let pick = rng() * total, chosen = cands[ 0 ];
	for ( const c of cands ) { pick -= c.w; if ( pick <= 0 ) { chosen = c; break; } }
	const aspect = lerp( G.aspect, rng() );

	// the piece's long axis: within axisSpread of the outward coast normal at the site
	const e = 0.5;
	let gx = sd.sample( chosen.x + e, chosen.z ) - sd.sample( chosen.x - e, chosen.z );
	let gz = sd.sample( chosen.x, chosen.z + e ) - sd.sample( chosen.x, chosen.z - e );
	const gl = Math.sqrt( gx * gx + gz * gz ) || 1;
	gx /= gl; gz /= gl;
	const [ rx, rz ] = turn( ( rng() - 0.5 ) * 2 * G.axisSpread );
	const ax = gx * rx - gz * rz, az = gx * rz + gz * rx;
	const target = G.pieceArea * lerp( G.pieceSpread, rng() );
	const site = { x: chosen.x, z: chosen.z, ux: chosen.ux, uz: chosen.uz };
	return settle( land, flood( height, land, site, target, aspect, ax, az ), step, site );

}

// The land after the starting island and `steps` pieces, and every piece (step 0 first).
export function growLand( seed: number, steps: number ): { land: LandLattice; pieces: Piece[] } {

	const land = new LandLattice(), pieces: Piece[] = [];
	for ( let step = 0; step <= steps; step ++ ) {

		const piece = nextPiece( seed, land, step );
		land.add( piece );
		pieces.push( piece );

	}

	return { land, pieces };

}
