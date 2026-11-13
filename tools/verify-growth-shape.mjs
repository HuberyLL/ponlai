// Checks the island's growth (packages/island/world/IslandGrowth.ts) over many seeds, CPU only (plain node):
// the coast's shape at every checked step (traced by marching squares at 0.5 m over the land's
// signed distance), that a grown land equals the same steps taken one at a time through a saved
// land, that old land is never lost and that the land stays 16 m inside the lattice at the growth
// horizon. Writes a sheet of the first eight seeds to artifacts/growth/shape-sheet-<label>.png.
//
// node tools/verify-growth-shape.mjs [--label name] [--seeds 32]

import { assert, assertions } from './assert-count.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { GROWTH, LandLattice, growLand, nextPiece } from '../packages/island/world/IslandGrowth.ts';

const args = process.argv.slice( 2 );
const arg = ( name, fallback ) => {

	const i = args.indexOf( `--${ name }` );
	return i >= 0 ? args[ i + 1 ] : fallback;

};

const LABEL = arg( 'label', 'latest' );
const SEEDS = Number( arg( 'seeds', 32 ) );
const STEPS = [ 1, 2, 4, 8, 16, 24, 36 ];
const SHEET_STEPS = [ 0, 2, 4, 8, 16, 24, 36 ];
const SHEET_SEEDS = 8;
const MAX = GROWTH.maxSteps;
const CELL = GROWTH.cell, N = Math.round( 2 * GROWTH.half / CELL ), X0 = - GROWTH.half;
// Solidity keeps the coast between a ragged sprawl and a convex blob; an island of a few pieces
// (steps 4 and 8, about 1000-2000 m^2) is naturally rounder, so its cap is looser until step 16.
// The bands hold the sketch's look (pieces that follow the relief into headlands and bays): a
// tighter band only passes by evening the pieces into a ring of like lobes.
const LIMITS = { fromStep: 4, solidity: [ 0.69, 0.92 ], smallUntil: 8, smallSolidity: 0.96, elong: 2.0, axisShare: 0.30 };
const MARGIN = 16; // m inside the lattice at the horizon

// ------------------------------------------------------------------ coast metrics

// the land's coast: the longest loop of its signed distance's zero set, by marching squares at `step`
function coastLoop( land, step = 0.5 ) {

	const w = land.cells(), p = 8;
	const win = { i0: w.i0 - p, j0: w.j0 - p, i1: w.i1 + p, j1: w.j1 + p };
	const sd = land.signedDistance( win );
	const x0 = X0 + win.i0 * CELL, z0 = X0 + win.j0 * CELL;
	const nx = Math.floor( ( win.i1 - win.i0 ) * CELL / step ) + 1, nz = Math.floor( ( win.j1 - win.j0 ) * CELL / step ) + 1;
	const v = new Float64Array( nx * nz );
	for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) v[ j * nx + i ] = sd.sample( x0 + i * step, z0 + j * step ) || 1e-9;
	const d = ( i, j ) => v[ j * nx + i ];
	// an edge id: 2 * node + ( 0 along x, 1 along z ); its crossing by linear interpolation
	const at = ( id ) => {

		const k = id >> 1, i = k % nx, j = Math.floor( k / nx );
		const a = d( i, j ), b = id & 1 ? d( i, j + 1 ) : d( i + 1, j ), t = a / ( a - b );
		return id & 1 ? [ x0 + i * step, z0 + ( j + t ) * step ] : [ x0 + ( i + t ) * step, z0 + j * step ];

	};
	const next = new Map();
	for ( let j = 0; j + 1 < nz; j ++ ) for ( let i = 0; i + 1 < nx; i ++ ) {

		const v0 = d( i, j ), v1 = d( i + 1, j ), v2 = d( i + 1, j + 1 ), v3 = d( i, j + 1 );
		const code = ( v0 < 0 ? 1 : 0 ) | ( v1 < 0 ? 2 : 0 ) | ( v2 < 0 ? 4 : 0 ) | ( v3 < 0 ? 8 : 0 );
		if ( code === 0 || code === 15 ) continue;
		const bottom = 2 * ( j * nx + i ), top = 2 * ( ( j + 1 ) * nx + i ), left = bottom + 1, right = 2 * ( j * nx + i + 1 ) + 1;
		const joined = v0 + v1 + v2 + v3 < 0;
		const segs = {
			1: [ [ left, bottom ] ], 2: [ [ bottom, right ] ], 3: [ [ left, right ] ], 4: [ [ right, top ] ],
			5: joined ? [ [ left, top ], [ right, bottom ] ] : [ [ left, bottom ], [ right, top ] ],
			6: [ [ bottom, top ] ], 7: [ [ left, top ] ], 8: [ [ top, left ] ], 9: [ [ top, bottom ] ],
			10: joined ? [ [ bottom, left ], [ top, right ] ] : [ [ bottom, right ], [ top, left ] ],
			11: [ [ top, right ] ], 12: [ [ right, left ] ], 13: [ [ right, bottom ] ], 14: [ [ bottom, left ] ],
		}[ code ];
		for ( const [ a, b ] of segs ) next.set( a, b );

	}

	const seen = new Set();
	let best = [];
	for ( const first of next.keys() ) {

		if ( seen.has( first ) ) continue;
		const loop = [];
		for ( let id = first; id !== undefined && ! seen.has( id ); id = next.get( id ) ) { seen.add( id ); loop.push( at( id ) ); }
		if ( loop.length > best.length ) best = loop;

	}

	return best;

}

const polygonArea = ( p ) => {

	let s = 0;
	for ( let i = 0; i < p.length; i ++ ) { const a = p[ i ], b = p[ ( i + 1 ) % p.length ]; s += a[ 0 ] * b[ 1 ] - b[ 0 ] * a[ 1 ]; }
	return s / 2;

};

function resample( p, step ) {

	const out = [ p[ 0 ] ];
	let carry = 0;
	for ( let i = 0; i < p.length; i ++ ) {

		const a = p[ i ], b = p[ ( i + 1 ) % p.length ], L = Math.hypot( b[ 0 ] - a[ 0 ], b[ 1 ] - a[ 1 ] );
		let t = step - carry;
		for ( ; t <= L; t += step ) out.push( [ a[ 0 ] + ( b[ 0 ] - a[ 0 ] ) * t / L, a[ 1 ] + ( b[ 1 ] - a[ 1 ] ) * t / L ] );
		carry = L - ( t - step );

	}

	return out;

}

function hull( pts ) {

	const p = [ ...pts ].sort( ( a, b ) => a[ 0 ] - b[ 0 ] || a[ 1 ] - b[ 1 ] );
	const cross = ( o, a, b ) => ( a[ 0 ] - o[ 0 ] ) * ( b[ 1 ] - o[ 1 ] ) - ( a[ 1 ] - o[ 1 ] ) * ( b[ 0 ] - o[ 0 ] );
	const lower = [], upper = [];
	for ( const q of p ) { while ( lower.length >= 2 && cross( lower.at( - 2 ), lower.at( - 1 ), q ) <= 0 ) lower.pop(); lower.push( q ); }
	for ( const q of p.reverse() ) { while ( upper.length >= 2 && cross( upper.at( - 2 ), upper.at( - 1 ), q ) <= 0 ) upper.pop(); upper.push( q ); }
	return lower.slice( 0, - 1 ).concat( upper.slice( 0, - 1 ) );

}

// solidity (area over its convex hull's), elongation (of the outline's second moments), the share of
// the coast running within 7.5 degrees of a lattice axis at a 2 m scale, and, reported only, the
// radial profile's coefficient of variation and the share of the coast that is concave
function shapeMetrics( loop ) {

	if ( polygonArea( loop ) < 0 ) loop = [ ...loop ].reverse();
	const area = polygonArea( loop );
	const step = 0.25, p = resample( loop, step ), n = p.length;
	const solidity = area / Math.abs( polygonArea( hull( p ) ) );
	let cx = 0, cz = 0;
	for ( const q of p ) { cx += q[ 0 ] / n; cz += q[ 1 ] / n; }
	let sxx = 0, szz = 0, sxz = 0;
	for ( const q of p ) { const dx = q[ 0 ] - cx, dz = q[ 1 ] - cz; sxx += dx * dx / n; szz += dz * dz / n; sxz += dx * dz / n; }
	const tr = sxx + szz, disc = Math.sqrt( Math.max( 0, tr * tr / 4 - ( sxx * szz - sxz * sxz ) ) );
	const elong = Math.sqrt( ( tr / 2 + disc ) / ( tr / 2 - disc ) );
	const bins = new Float64Array( 72 );
	for ( const q of p ) {

		const b = Math.min( 71, Math.floor( ( Math.atan2( q[ 1 ] - cz, q[ 0 ] - cx ) + Math.PI ) / ( 2 * Math.PI ) * 72 ) );
		bins[ b ] = Math.max( bins[ b ], Math.hypot( q[ 0 ] - cx, q[ 1 ] - cz ) );

	}

	const rm = bins.reduce( ( s, r ) => s + r, 0 ) / 72;
	const radialCV = Math.sqrt( bins.reduce( ( s, r ) => s + ( r - rm ) * ( r - rm ), 0 ) / 72 ) / rm;
	const w = 8; // samples either side: a 2 m tangent scale
	let axis = 0, concave = 0;
	for ( let i = 0; i < n; i ++ ) {

		const a = p[ ( i - w + n ) % n ], b = p[ ( i + w ) % n ], c = p[ i ];
		const ang = Math.atan2( b[ 1 ] - a[ 1 ], b[ 0 ] - a[ 0 ] ), m = ( ( ang % ( Math.PI / 2 ) ) + Math.PI / 2 ) % ( Math.PI / 2 );
		if ( Math.min( m, Math.PI / 2 - m ) < 7.5 * Math.PI / 180 ) axis ++;
		const ux = c[ 0 ] - a[ 0 ], uz = c[ 1 ] - a[ 1 ], vx = b[ 0 ] - c[ 0 ], vz = b[ 1 ] - c[ 1 ];
		const k = ( ux * vz - uz * vx ) / ( Math.hypot( ux, uz ) * Math.hypot( vx, vz ) ) / ( w * step );
		if ( k < - 0.05 ) concave ++;

	}

	return { area, solidity, elong, axisShare: axis / n, radialCV, concaveShare: concave / n };

}

// ------------------------------------------------------------------ the sweep

const popcount = ( words ) => {

	let c = 0;
	for ( let v of words ) for ( ; v !== 0; v &= v - 1 ) c ++;
	return c;

};

const equalBytes = ( a, b ) => a.length === b.length && a.every( ( v, i ) => v === b[ i ] );
const fails = [];
const rows = {}; // step -> metrics per seed
const sheet = []; // the first seeds' lands at the sheet's steps, with their pieces
const t0 = performance.now();

for ( let seed = 1; seed <= SEEDS; seed ++ ) {

	// one step at a time, the land saved and restored between steps as a game would
	let land = new LandLattice();
	const pieces = [], lands = {};
	for ( let step = 0; step <= MAX; step ++ ) {

		const before = popcount( land.words );
		const piece = nextPiece( seed, land, step );
		land.add( piece );
		assert.equal( popcount( land.words ) - before, popcount( piece.bits ), `seed ${ seed } step ${ step }: a piece overlaps old land` );
		land = LandLattice.fromBytes( land.toBytes() );
		pieces.push( piece );
		if ( STEPS.includes( step ) || ( seed <= SHEET_SEEDS && SHEET_STEPS.includes( step ) ) ) lands[ step ] = LandLattice.fromBytes( land.toBytes() );

	}

	// the same steps in one call
	const grown = growLand( seed, MAX );
	assert.ok( equalBytes( grown.land.toBytes(), land.toBytes() ), `seed ${ seed }: growLand( ${ MAX } ) differs from ${ MAX } single steps` );
	grown.pieces.forEach( ( p, s ) => assert.ok( equalBytes( p.bits, pieces[ s ].bits ) && JSON.stringify( p.window ) === JSON.stringify( pieces[ s ].window ), `seed ${ seed } step ${ s }: piece differs` ) );
	if ( seed <= 4 ) for ( const k of [ 4, 16 ] ) assert.ok( equalBytes( growLand( seed, k ).land.toBytes(), lands[ k ].toBytes() ), `seed ${ seed }: growLand( ${ k } ) differs` );

	// the lattice margin at the horizon
	const b = land.bounds(), lim = GROWTH.half - MARGIN;
	if ( b.xMin < - lim || b.zMin < - lim || b.xMax > lim || b.zMax > lim ) fails.push( `seed ${ seed }: land reaches ${ JSON.stringify( b ) }, inside +-${ lim } m wanted` );

	for ( const step of STEPS ) {

		const m = shapeMetrics( coastLoop( lands[ step ] ) );
		( rows[ step ] ??= [] ).push( { seed, ...m } );
		if ( step >= LIMITS.fromStep ) {

			const bad = [];
			const cap = step <= LIMITS.smallUntil ? LIMITS.smallSolidity : LIMITS.solidity[ 1 ];
			if ( m.solidity < LIMITS.solidity[ 0 ] || m.solidity > cap ) bad.push( `solidity ${ m.solidity.toFixed( 3 ) }` );
			if ( m.elong > LIMITS.elong ) bad.push( `elongation ${ m.elong.toFixed( 2 ) }` );
			if ( m.axisShare > LIMITS.axisShare ) bad.push( `axis share ${ m.axisShare.toFixed( 2 ) }` );
			if ( bad.length ) fails.push( `seed ${ seed } step ${ step }: ${ bad.join( ', ' ) }` );

		}

	}

	if ( seed <= SHEET_SEEDS ) {

		const next = nextPiece( seed, land, MAX + 1 );
		sheet.push( { seed, lands, pieces: [ ...pieces, next ] } );

	}

}

const seconds = ( performance.now() - t0 ) / 1000;
const fmt = ( v, d = 2 ) => v.toFixed( d );
console.log( `growth shape: ${ SEEDS } seeds x ${ MAX } steps in ${ fmt( seconds, 1 ) } s (each grown twice)` );
console.log( 'step   area (min-max)   solidity    elongation  axis share  radial CV   concave' );
for ( const step of STEPS ) {

	const r = rows[ step ], range = ( k, d = 2 ) => `${ fmt( Math.min( ...r.map( ( m ) => m[ k ] ) ), d ) }-${ fmt( Math.max( ...r.map( ( m ) => m[ k ] ) ), d ) }`;
	console.log( `${ String( step ).padStart( 4 ) }   ${ range( 'area', 0 ).padEnd( 15 ) }  ${ range( 'solidity' ).padEnd( 10 ) }  ${ range( 'elong' ).padEnd( 10 ) }  ${ range( 'axisShare' ).padEnd( 10 ) }  ${ range( 'radialCV' ).padEnd( 10 ) }  ${ range( 'concaveShare' ) }` );

}

// ------------------------------------------------------------------ the sheet

const FONT = {};
{

	const glyphs = {
		A: '010101111101101', B: '110101110101110', C: '011100100100011', D: '110101101101110', E: '111100110100111',
		F: '111100110100100', G: '011100101101011', H: '101101111101101', I: '111010010010111', J: '001001001101010',
		K: '101101110101101', L: '100100100100111', M: '101111111101101', N: '110101101101101', O: '010101101101010',
		P: '110101110100100', Q: '010101101110011', R: '110101110101101', S: '011100010001110', T: '111010010010010',
		U: '101101101101111', V: '101101101101010', W: '101101111111101', X: '101101010101101', Y: '101101010010010',
		Z: '111001010100111', 0: '111101101101111', 1: '010110010010111', 2: '110001010100111', 3: '110001010001110',
		4: '101101111001001', 5: '111100110001110', 6: '011100111101111', 7: '111001010010010', 8: '111101111101111',
		9: '111101111001110', '.': '000000000000010', '-': '000000111000000', ':': '000010000010000', '/': '001001010100100',
		'+': '000010111010000', '=': '000111000111000', ' ': '000000000000000', '(': '010100100100010', ')': '010001001001010',
	};
	for ( const [ k, v ] of Object.entries( glyphs ) ) FONT[ k ] = v;

}

class Image {

	constructor( w, h, bg ) {

		this.w = w; this.h = h; this.px = new Uint8Array( w * h * 3 );
		for ( let i = 0; i < w * h; i ++ ) this.px.set( bg, i * 3 );

	}

	set( x, y, c ) {

		if ( x < 0 || y < 0 || x >= this.w || y >= this.h ) return;
		this.px.set( c.map( Math.round ), ( y * this.w + x ) * 3 );

	}

	text( s, x, y, c, scale = 2 ) {

		for ( const ch of s.toUpperCase() ) {

			const g = FONT[ ch ] ?? FONT[ ' ' ];
			for ( let r = 0; r < 5; r ++ ) for ( let q = 0; q < 3; q ++ ) if ( g[ r * 3 + q ] === '1' ) {

				for ( let dy = 0; dy < scale; dy ++ ) for ( let dx = 0; dx < scale; dx ++ ) this.set( x + q * scale + dx, y + r * scale + dy, c );

			}

			x += 4 * scale;

		}

	}

	png() {

		const crcTable = new Uint32Array( 256 ).map( ( _, n ) => {

			let c = n;
			for ( let k = 0; k < 8; k ++ ) c = c & 1 ? 0xedb88320 ^ ( c >>> 1 ) : c >>> 1;
			return c >>> 0;

		} );
		const crc = ( buf ) => {

			let c = 0xffffffff;
			for ( const b of buf ) c = crcTable[ ( c ^ b ) & 255 ] ^ ( c >>> 8 );
			return ( c ^ 0xffffffff ) >>> 0;

		};
		const chunk = ( type, data ) => {

			const out = Buffer.alloc( 12 + data.length );
			out.writeUInt32BE( data.length, 0 );
			out.write( type, 4, 'ascii' );
			data.copy( out, 8 );
			out.writeUInt32BE( crc( out.subarray( 4, 8 + data.length ) ), 8 + data.length );
			return out;

		};
		const raw = Buffer.alloc( ( this.w * 3 + 1 ) * this.h );
		for ( let y = 0; y < this.h; y ++ ) raw.set( this.px.subarray( y * this.w * 3, ( y + 1 ) * this.w * 3 ), y * ( this.w * 3 + 1 ) + 1 );
		const ihdr = Buffer.alloc( 13 );
		ihdr.writeUInt32BE( this.w, 0 ); ihdr.writeUInt32BE( this.h, 4 );
		ihdr[ 8 ] = 8; ihdr[ 9 ] = 2;
		return Buffer.concat( [ Buffer.from( [ 137, 80, 78, 71, 13, 10, 26, 10 ] ), chunk( 'IHDR', ihdr ), chunk( 'IDAT', deflateSync( raw ) ), chunk( 'IEND', Buffer.alloc( 0 ) ) ] );

	}

}

const VIRIDIS = [ [ 68, 1, 84 ], [ 59, 82, 139 ], [ 33, 145, 140 ], [ 94, 201, 98 ], [ 253, 231, 37 ] ];
const ramp = ( t ) => {

	t = Math.min( 1, Math.max( 0, t ) ) * ( VIRIDIS.length - 1 );
	const i = Math.min( VIRIDIS.length - 2, Math.floor( t ) ), f = t - i;
	return VIRIDIS[ i ].map( ( c, k ) => c + ( VIRIDIS[ i + 1 ][ k ] - c ) * f );

};

function pieceCells( piece, fn ) {

	const { i0, j0, i1 } = piece.window, nx = i1 - i0;
	piece.bits.forEach( ( word, q ) => {

		for ( let v = word; v !== 0; v &= v - 1 ) {

			const b = q * 32 + 31 - Math.clz32( v & - v );
			fn( i0 + b % nx, j0 + Math.floor( b / nx ) );

		}

	} );

}

{

	const size = 230, gap = 8, caption = 40, head = 34, side = 40;
	const img = new Image( side + SHEET_STEPS.length * ( size + gap ) + gap, head + sheet.length * ( size + caption + gap ) + gap, [ 245, 243, 238 ] );
	img.text( `island growth shape  ${ LABEL }  seeds 1-${ sheet.length }  colour: arrival step 0-${ MAX }  hatched: next piece  bar 10 m`, gap, 8, [ 30, 30, 30 ], 2 );
	SHEET_STEPS.forEach( ( s, c ) => img.text( `step ${ s }`, side + gap + c * ( size + gap ), 22, [ 30, 30, 30 ], 2 ) );
	// one scale for the whole sheet: the largest island at the horizon
	let span = 0;
	for ( const row of sheet ) { const b = row.lands[ MAX ].bounds(); span = Math.max( span, b.xMax - b.xMin, b.zMax - b.zMin ); }
	span += 10;
	sheet.forEach( ( row, r ) => {

		const arrival = new Int8Array( N * N ).fill( - 1 );
		row.pieces.forEach( ( p, s ) => pieceCells( p, ( i, j ) => { arrival[ j * N + i ] = s; } ) );
		const b = row.lands[ MAX ].bounds(), cx = ( b.xMin + b.xMax ) / 2, cz = ( b.zMin + b.zMax ) / 2;
		const oy = head + gap + r * ( size + caption + gap );
		img.text( `${ row.seed }`, 10, oy + size / 2 - 5, [ 30, 30, 30 ], 2 );
		SHEET_STEPS.forEach( ( s, c ) => {

			const ox = side + gap + c * ( size + gap );
			const cellAt = ( px, py ) => {

				const x = cx + ( ( px + 0.5 ) / size - 0.5 ) * span, z = cz + ( ( py + 0.5 ) / size - 0.5 ) * span;
				const i = Math.floor( ( x - X0 ) / CELL ), j = Math.floor( ( z - X0 ) / CELL );
				return i < 0 || j < 0 || i >= N || j >= N ? - 1 : j * N + i;

			};
			const kind = ( k ) => k < 0 ? 0 : arrival[ k ] >= 0 && arrival[ k ] <= s ? 1 : arrival[ k ] === s + 1 ? 2 : 0;
			for ( let py = 0; py < size; py ++ ) for ( let px = 0; px < size; px ++ ) {

				const k = cellAt( px, py ), t = kind( k );
				let col = [ 34, 86, 112 ];
				if ( t === 1 ) col = ramp( arrival[ k ] / MAX );
				if ( t === 2 ) col = ( px + py ) % 6 < 3 ? [ 150, 200, 196 ] : [ 70, 130, 140 ];
				const kr = cellAt( px + 1, py ), kd = cellAt( px, py + 1 );
				if ( px + 1 < size && py + 1 < size && ( ( kind( k ) === 1 ) !== ( kind( kr ) === 1 ) || ( kind( k ) === 1 ) !== ( kind( kd ) === 1 ) ) ) col = [ 15, 20, 25 ];
				img.set( ox + px, oy + py, col );

			}

			const bar = Math.round( 10 / span * size );
			for ( let x = 0; x < bar; x ++ ) for ( let y = 0; y < 3; y ++ ) img.set( ox + 6 + x, oy + size - 9 + y, [ 255, 255, 255 ] );
			const m = shapeMetrics( coastLoop( row.lands[ s ] ) );
			img.text( `a ${ Math.round( m.area ) }  sol ${ fmt( m.solidity ) }`, ox, oy + size + 4, [ 30, 30, 30 ], 2 );
			img.text( `el ${ fmt( m.elong ) } ax ${ fmt( m.axisShare ) }`, ox, oy + size + 16, [ 30, 30, 30 ], 2 );
			img.text( `cv ${ fmt( m.radialCV ) } cc ${ fmt( m.concaveShare ) }`, ox, oy + size + 28, [ 30, 30, 30 ], 2 );

		} );

	} );
	mkdirSync( 'artifacts/growth', { recursive: true } );
	const file = `artifacts/growth/shape-sheet-${ LABEL }.png`;
	writeFileSync( file, img.png() );
	console.log( `sheet: ${ file }` );

}

if ( fails.length ) {

	console.error( `FAIL (${ fails.length }):\n  ${ fails.join( '\n  ' ) }` );
	process.exit( 1 );

}

console.log( `PASS: solidity ${ LIMITS.solidity.join( '-' ) } (to ${ LIMITS.smallSolidity } up to step ${ LIMITS.smallUntil }), elongation <= ${ LIMITS.elong }, axis share <= ${ LIMITS.axisShare } at steps >= ${ LIMITS.fromStep }; growLand equals single steps; land ${ MARGIN } m inside the lattice at step ${ MAX } (${ assertions() } assertions)` );
