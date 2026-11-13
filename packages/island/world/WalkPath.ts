import * as THREE from 'three/webgpu';

// The walking loop's curve and the distance to it.
//
// The walking loop's curve (WalkLoop.ts gives its waypoints) and the distance to it, which every
// kind's growth preparation is given (Growth.ts, `walkDistance`). The meadow's flowers kept clear of
// the loop by it; the meadow draws none now, and no kind reads it.

/** The waypoints of a walking loop kept as x, z pairs (WorldData.walk). */
export function walkPoints( flat: Float64Array ): [ number, number ][] {

	const points: [ number, number ][] = [];
	for ( let k = 0; k + 1 < flat.length; k += 2 ) points.push( [ flat[ k ], flat[ k + 1 ] ] );
	return points;

}

/** The closed curve the walker follows through `points` (the same centripetal Catmull-Rom). */
export function walkCurve( points: [ number, number ][] ): THREE.CatmullRomCurve3 {

	return new THREE.CatmullRomCurve3( points.map( ( [ x, z ] ) => new THREE.Vector3( x, 0, z ) ), true, 'centripetal' );

}

/** Horizontal distance (m) from ( x, z ) to the walking loop, as a polyline of fine samples. */
export function walkLoopDistance( points: [ number, number ][] ): ( x: number, z: number ) => number {

	const curve = walkCurve( points );
	const samples = curve.getSpacedPoints( 400 );
	return ( x, z ) => {

		let best = Infinity;
		for ( let i = 0; i < samples.length - 1; i ++ ) {

			const a = samples[ i ], b = samples[ i + 1 ];
			const ex = b.x - a.x, ez = b.z - a.z;
			const t = Math.min( Math.max( ( ( x - a.x ) * ex + ( z - a.z ) * ez ) / ( ex * ex + ez * ez || 1 ), 0 ), 1 );
			best = Math.min( best, Math.hypot( x - a.x - ex * t, z - a.z - ez * t ) );

		}
		return best;

	};

}
