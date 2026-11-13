import { coastLoops } from './RimGround.ts';
import type { LandLattice } from './IslandGrowth.ts';

// The islander's walking loop: waypoints round the land 5 m in from its coast.
//
// The islander's walking loop (x, z), shared by the figure that walks it and by the growth's
// preparation, which is given the distance to it (WalkPath.ts) so that a planting can leave it
// clear (the meadow's flowers did, which hid the walker's legs; it draws none now). It runs round
// the land 5 m in from its coast: the largest loop of the land's signed distance at -5 m, smoothed
// over a couple of metres and kept every 2.5 m as the waypoints of a centripetal Catmull-Rom loop,
// so it follows any shape the land grows into. A function of the land alone, without three (the
// land job computes it in the world's workers, chunkWorker.ts); the curve and the distance to it
// are WalkPath.ts's.
const INSET = 5;
const SAMPLE = 0.5, SMOOTH = 4, PASSES = 3, WAYPOINT = 5;

export function walkLoop( land: LandLattice ): [ number, number ][] {

	const w = land.cells(), pad = 2;
	const sd = land.signedDistance( { i0: w.i0 - pad, j0: w.j0 - pad, i1: w.i1 + pad, j1: w.j1 + pad } );
	for ( let k = 0; k < sd.data.length; k ++ ) sd.data[ k ] += INSET;
	let loop: [ number, number ][] = [], largest = 0;
	for ( const line of coastLoops( sd, 1 ) ) {

		let area = 0;
		for ( let i = 0; i + 1 < line.length; i ++ ) area += line[ i ][ 0 ] * line[ i + 1 ][ 1 ] - line[ i + 1 ][ 0 ] * line[ i ][ 1 ];
		if ( Math.abs( area ) > largest ) { largest = Math.abs( area ); loop = line; }

	}
	// even samples round the closed loop (its last point repeats its first), then a moving average
	const along = [ 0 ];
	for ( let i = 1; i < loop.length; i ++ ) along.push( along[ i - 1 ] + Math.hypot( loop[ i ][ 0 ] - loop[ i - 1 ][ 0 ], loop[ i ][ 1 ] - loop[ i - 1 ][ 1 ] ) );
	const length = along[ along.length - 1 ], count = Math.round( length / SAMPLE );
	let points: [ number, number ][] = [];
	for ( let k = 0, i = 0; k < count; k ++ ) {

		const s = k * length / count;
		while ( along[ i + 1 ] < s ) i ++;
		const t = ( s - along[ i ] ) / ( along[ i + 1 ] - along[ i ] || 1 );
		points.push( [ loop[ i ][ 0 ] + ( loop[ i + 1 ][ 0 ] - loop[ i ][ 0 ] ) * t, loop[ i ][ 1 ] + ( loop[ i + 1 ][ 1 ] - loop[ i ][ 1 ] ) * t ] );

	}
	for ( let pass = 0; pass < PASSES; pass ++ ) points = points.map( ( _, i ) => {

		let x = 0, z = 0;
		for ( let o = - SMOOTH; o <= SMOOTH; o ++ ) {

			const [ px, pz ] = points[ ( i + o + points.length ) % points.length ];
			x += px; z += pz;

		}
		return [ x / ( 2 * SMOOTH + 1 ), z / ( 2 * SMOOTH + 1 ) ];

	} );
	return points.filter( ( _, i ) => i % WAYPOINT === 0 );

}

