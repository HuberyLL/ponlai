import * as THREE from 'three/webgpu';

// The islander's walking loop (x, z), shared by the figure that walks it and by the planting that
// must leave it clear: tussocks and tall flowers there would hide the walker's legs, shrubs and
// trees would stand in the way.
export const WALK_LOOP: [ number, number ][] = [ [ - 5.5, 1.5 ], [ - 1.5, 3.3 ], [ 3, 2.6 ], [ 5.6, 0 ], [ 3.8, - 2.8 ], [ - 0.5, - 2.7 ], [ - 4.5, - 1.8 ] ];

/** The closed curve the walker follows through `points` (the same centripetal Catmull-Rom). */
export function walkCurve( points: [ number, number ][] = WALK_LOOP ): THREE.CatmullRomCurve3 {

	return new THREE.CatmullRomCurve3( points.map( ( [ x, z ] ) => new THREE.Vector3( x, 0, z ) ), true, 'centripetal' );

}

/** Horizontal distance (m) from ( x, z ) to the walking loop, as a polyline of fine samples. */
export function walkLoopDistance( points: [ number, number ][] = WALK_LOOP ): ( x: number, z: number ) => number {

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
