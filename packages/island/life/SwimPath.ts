import type { Rng } from '../../render/data.ts';

// A closed route through the water that a group of creatures follows, as a function of arc length.
//
// A route is a loop through control points chosen round a home (`around`) or round the island
// (`ring`), each kept where the kind's habitat test passes, joined by a centripetal Catmull-Rom
// spline (no cusps or loops between unevenly spaced points) and sampled every SAMPLE metres. Every
// sample of the route and its sides out to `margin` metres must pass the habitat test; a control
// point whose stretch fails is drawn back toward the home (a ring's, out from the island), and a
// route that still fails after
// several rounds is left out (null). Each control point also carries a height, interpolated along
// the route like the points.
//
// `at( s )` returns the point, the unit heading and the height at arc length `s`, taken modulo the
// route's length, so a creature placed at `s = v t` swims on for any scene time: the motion is a
// function of the scene clock, with nothing integrated, and a paused frame, a scene jump or a fresh
// load all draw it the same.

const SAMPLE = 0.5;
const TAU = Math.PI * 2;

export type Fits = ( x: number, z: number ) => boolean;

export interface PathPoint { x: number; z: number; y: number; hx: number; hz: number; curve: number }

export class SwimPath {

	readonly length: number;
	// the samples: x, z, y, cumulative length
	private readonly xs: Float64Array;
	private readonly zs: Float64Array;
	private readonly ys: Float64Array;
	private readonly ss: Float64Array;

	/** The loop through `pts` (use `around` or `ring` to choose them inside a habitat). */
	constructor( pts: readonly { x: number; z: number; y: number }[] ) {

		const n = pts.length;
		const xs: number[] = [], zs: number[] = [], ys: number[] = [];
		for ( let i = 0; i < n; i ++ ) {

			const p0 = pts[ ( i - 1 + n ) % n ], p1 = pts[ i ], p2 = pts[ ( i + 1 ) % n ], p3 = pts[ ( i + 2 ) % n ];
			const seg = Math.hypot( p2.x - p1.x, p2.z - p1.z );
			const steps = Math.max( 2, Math.ceil( seg / SAMPLE ) );
			for ( let k = 0; k < steps; k ++ ) {

				const q = centripetal( p0, p1, p2, p3, k / steps );
				xs.push( q.x ); zs.push( q.z ); ys.push( q.y );

			}

		}
		const m = xs.length;
		this.xs = Float64Array.from( xs );
		this.zs = Float64Array.from( zs );
		this.ys = Float64Array.from( ys );
		this.ss = new Float64Array( m + 1 );
		for ( let i = 0; i < m; i ++ ) this.ss[ i + 1 ] = this.ss[ i ] + Math.hypot( xs[ ( i + 1 ) % m ] - xs[ i ], zs[ ( i + 1 ) % m ] - zs[ i ] );
		this.length = this.ss[ m ];

	}

	/** The point at arc length `s` (any real; the route repeats), into `out`. */
	at( s: number, out: PathPoint ): PathPoint {

		const L = this.length, m = this.xs.length;
		const t = ( ( s % L ) + L ) % L;
		// binary search of the sample before t
		let lo = 0, hi = m;
		while ( hi - lo > 1 ) {

			const mid = ( lo + hi ) >> 1;
			if ( this.ss[ mid ] <= t ) lo = mid; else hi = mid;

		}
		const i = lo, j = ( lo + 1 ) % m, k = ( lo + 2 ) % m;
		const f = ( t - this.ss[ i ] ) / Math.max( this.ss[ i + 1 ] - this.ss[ i ], 1e-9 );
		out.x = this.xs[ i ] + ( this.xs[ j ] - this.xs[ i ] ) * f;
		out.z = this.zs[ i ] + ( this.zs[ j ] - this.zs[ i ] ) * f;
		out.y = this.ys[ i ] + ( this.ys[ j ] - this.ys[ i ] ) * f;
		// the heading blends the two segments' directions about the sample, so it turns smoothly
		const ax = this.xs[ j ] - this.xs[ i ], az = this.zs[ j ] - this.zs[ i ];
		const bx = this.xs[ k ] - this.xs[ j ], bz = this.zs[ k ] - this.zs[ j ];
		const al = Math.hypot( ax, az ) || 1, bl = Math.hypot( bx, bz ) || 1;
		const w = Math.max( 0, f - 0.5 );
		const pi = ( lo - 1 + m ) % m;
		const cx = this.xs[ i ] - this.xs[ pi ], cz = this.zs[ i ] - this.zs[ pi ];
		const cl = Math.hypot( cx, cz ) || 1;
		const v = Math.max( 0, 0.5 - f );
		let hx = ax / al * ( 1 - w - v ) + bx / bl * w + cx / cl * v, hz = az / al * ( 1 - w - v ) + bz / bl * w + cz / cl * v;
		const hl = Math.hypot( hx, hz ) || 1;
		hx /= hl; hz /= hl;
		out.hx = hx; out.hz = hz;
		// the signed curvature (1/m, > 0 turning left seen from above, toward +x from +z), from the
		// turn between the segments
		out.curve = ( ax / al * bz / bl - az / al * bx / bl ) / Math.max( ( al + bl ) / 2, 1e-6 );
		return out;

	}

	/** A route round a home ( x, z ): `points` control points at angles evenly spread (jittered),
	 * each between `radius[ 0 ]` and `radius[ 1 ]` out, its height from `height`, every sample and
	 * its sides out to `margin` inside `fits`. */
	static around( home: { x: number; z: number }, rng: Rng, o: { points: number; radius: readonly [ number, number ]; margin: number; height: ( x: number, z: number, rng: Rng ) => number }, fits: Fits ): SwimPath | null {

		const turn = rng() < 0.5 ? 1 : - 1, a0 = rng() * TAU;
		const pts = [];
		for ( let k = 0; k < o.points; k ++ ) {

			const a = a0 + turn * ( k + ( rng() - 0.5 ) * 0.5 ) / o.points * TAU;
			const r = o.radius[ 0 ] + ( o.radius[ 1 ] - o.radius[ 0 ] ) * rng();
			pts.push( { a, r, x: 0, z: 0, y: 0 } );

		}
		return settle( pts, home, rng, o, fits );

	}

	/** A route round the island at `off` metres beyond its outline (each control point found along
	 * its ray from the centre: the last land the ray crosses, then `off` more), `points` points. */
	static ring( centre: { x: number; z: number; radius: number }, isLand: Fits, rng: Rng, o: { points: number; off: readonly [ number, number ]; margin: number; height: ( x: number, z: number, rng: Rng ) => number }, fits: Fits ): SwimPath | null {

		const turn = rng() < 0.5 ? 1 : - 1, a0 = rng() * TAU;
		const pts = [];
		for ( let k = 0; k < o.points; k ++ ) {

			const a = a0 + turn * ( k + ( rng() - 0.5 ) * 0.4 ) / o.points * TAU;
			const dx = Math.cos( a ), dz = Math.sin( a );
			// the outline along the ray: the farthest land within three radii
			let edge = 0;
			for ( let r = 0; r < centre.radius * 3 + 40; r += 1 ) if ( isLand( centre.x + dx * r, centre.z + dz * r ) ) edge = r;
			const r = edge + o.off[ 0 ] + ( o.off[ 1 ] - o.off[ 0 ] ) * rng();
			pts.push( { a, r, x: 0, z: 0, y: 0 } );

		}
		return settle( pts, centre, rng, o, fits, true );

	}

}

// Places the control points, then draws back toward the home those whose stretch leaves the
// habitat (a ring's: out from the island), a few rounds at most.
function settle( pts: { a: number; r: number; x: number; z: number; y: number }[], home: { x: number; z: number }, rng: Rng, o: { margin: number; height: ( x: number, z: number, rng: Rng ) => number }, fits: Fits, outward = false ): SwimPath | null {

	const place = () => {

		for ( const p of pts ) {

			p.x = home.x + Math.cos( p.a ) * p.r;
			p.z = home.z + Math.sin( p.a ) * p.r;

		}

	};
	place();
	for ( const p of pts ) p.y = o.height( p.x, p.z, rng );
	const sides = ( x: number, z: number, hx: number, hz: number ) => fits( x, z ) && ( o.margin <= 0 || ( fits( x - hz * o.margin, z + hx * o.margin ) && fits( x + hz * o.margin, z - hx * o.margin ) ) );
	const q: PathPoint = { x: 0, z: 0, y: 0, hx: 0, hz: 0, curve: 0 };
	for ( let round = 0; round < 8; round ++ ) {

		const path = new SwimPath( pts );
		const bad = new Set<number>();
		// which control point's stretch each failing sample falls in (the nearest point by angle)
		for ( let s = 0; s < path.length; s += 1 ) {

			path.at( s, q );
			if ( sides( q.x, q.z, q.hx, q.hz ) ) continue;
			let best = 0, bd = Infinity;
			for ( let k = 0; k < pts.length; k ++ ) {

				const d = Math.hypot( pts[ k ].x - q.x, pts[ k ].z - q.z );
				if ( d < bd ) { bd = d; best = k; }

			}
			bad.add( best );

		}
		if ( bad.size === 0 ) return path;
		for ( const k of bad ) pts[ k ].r *= outward ? 1.1 + rng() * 0.1 : 0.7 + rng() * 0.1;
		place();
		for ( const k of bad ) pts[ k ].y = o.height( pts[ k ].x, pts[ k ].z, rng );

	}
	return null;

}

// a point of the centripetal Catmull-Rom spline through p0 .. p3 (alpha 0.5), between p1 and p2
function centripetal( p0: { x: number; z: number; y: number }, p1: { x: number; z: number; y: number }, p2: { x: number; z: number; y: number }, p3: { x: number; z: number; y: number }, t: number ) {

	const d = ( a: typeof p0, b: typeof p0 ) => Math.max( Math.sqrt( Math.hypot( b.x - a.x, b.z - a.z ) ), 1e-4 );
	const t0 = 0, t1 = t0 + d( p0, p1 ), t2 = t1 + d( p1, p2 ), t3 = t2 + d( p2, p3 );
	const u = t1 + ( t2 - t1 ) * t;
	const lerp = ( a: number, b: number, ta: number, tb: number ) => ( tb - u ) / ( tb - ta ) * a + ( u - ta ) / ( tb - ta ) * b;
	const out = { x: 0, z: 0, y: 0 };
	for ( const c of [ 'x', 'z', 'y' ] as const ) {

		const a1 = lerp( p0[ c ], p1[ c ], t0, t1 ), a2 = lerp( p1[ c ], p2[ c ], t1, t2 ), a3 = lerp( p2[ c ], p3[ c ], t2, t3 );
		const b1 = lerp( a1, a2, t0, t2 ), b2 = lerp( a2, a3, t1, t3 );
		out[ c ] = lerp( b1, b2, t1, t2 );

	}
	return out;

}
