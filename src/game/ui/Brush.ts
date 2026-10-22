// Brush strokes drawn in code (docs/ui.md, Principles: every line is a brush stroke): each has a
// sharp entry, a full middle and a tapering exit, along a slightly curved path, its width varying
// along it; within one figure a solid axis keeps its weight against a faint paper edge (the
// caller's widths and opacities). Every function returns the stroke's outline as an SVG path to
// fill, in the caller's units; painted textures replace them later.

export interface Point { x: number; y: number }

export interface BrushShape {
	/** share of the length over which the stroke reaches its full width */
	entry?: number;
	/** share over which it tapers out */
	exit?: number;
	/** its width at the start, as a share of the full width (a sharp entry starts thin) */
	start?: number;
	/** its width at the end */
	end?: number;
	/** how much the middle swells over the full width */
	swell?: number;
}

const smooth = ( t: number ) => t * t * ( 3 - 2 * t );
const n1 = ( v: number ) => String( Math.round( v * 10 ) / 10 );

/** A stroke's width along it (t 0 at the entry, 1 at the exit), as a share of its full width. */
export function profile( t: number, shape: BrushShape = {} ): number {

	const entry = shape.entry ?? 0.12, exit = shape.exit ?? 0.4, start = shape.start ?? 0.22, end = shape.end ?? 0.04;
	let w = 1 + ( shape.swell ?? 0.08 ) * Math.sin( Math.PI * t );
	if ( t < entry ) w *= start + ( 1 - start ) * smooth( t / entry );
	if ( t > 1 - exit ) w *= end + ( 1 - end ) * smooth( ( 1 - t ) / exit );
	return w;

}

/** Points along a cubic Bézier, `n` segments. */
export function cubic( p0: Point, p1: Point, p2: Point, p3: Point, n = 24 ): Point[] {

	const out: Point[] = [];
	for ( let i = 0; i <= n; i ++ ) {

		const t = i / n, u = 1 - t;
		out.push( {
			x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
			y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
		} );

	}
	return out;

}

/** A stroke along points, `width` at its fullest (or a width for each point): its closed outline. */
export function along( points: readonly Point[], width: number | readonly number[], shape: BrushShape = {} ): string {

	const n = points.length;
	if ( n < 2 ) return '';
	const s = [ 0 ];
	for ( let i = 1; i < n; i ++ ) s.push( s[ i - 1 ] + Math.hypot( points[ i ].x - points[ i - 1 ].x, points[ i ].y - points[ i - 1 ].y ) );
	const length = s[ n - 1 ] || 1;
	const left: string[] = [], right: string[] = [];
	for ( let i = 0; i < n; i ++ ) {

		const a = points[ Math.max( i - 1, 0 ) ], b = points[ Math.min( i + 1, n - 1 ) ];
		const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot( tx, ty ) || 1;
		const half = ( typeof width === 'number' ? width * profile( s[ i ] / length, shape ) : width[ i ] ) / 2;
		const nx = - ty / tl * half, ny = tx / tl * half, p = points[ i ];
		left.push( `${ n1( p.x + nx ) } ${ n1( p.y + ny ) }` );
		right.push( `${ n1( p.x - nx ) } ${ n1( p.y - ny ) }` );

	}
	return `M${ left.join( ' L' ) } L${ right.reverse().join( ' L' ) } Z`;

}

/** A level stroke from x0 to x1 at height y, bowed by `bend` (up for a positive bend). */
export function level( x0: number, x1: number, y: number, width: number, bend = 0, shape?: BrushShape ): string {

	const dx = ( x1 - x0 ) / 3;
	return along( cubic( { x: x0, y }, { x: x0 + dx, y: y - bend }, { x: x1 - dx, y: y - bend * 0.6 }, { x: x1, y } ), width, shape );

}

/** An upright stroke (a divider, the caret, a tick) from y0 down to y1 at x, leaning by `lean`. */
export function upright( x: number, y0: number, y1: number, width: number, lean = 0, shape?: BrushShape ): string {

	const dy = ( y1 - y0 ) / 3;
	return along( cubic( { x, y: y0 }, { x: x + lean, y: y0 + dy }, { x: x + lean, y: y1 - dy }, { x: x + lean * 0.4, y: y1 } ), width, { entry: 0.2, exit: 0.45, start: 0.3, ...shape } );

}

/** A closed ring through points (a loop, first point not repeated), its width at each point: the
 * outline of its outer and inner edges, to fill with the even-odd rule. */
export function ring( points: readonly Point[], widths: readonly number[] ): string {

	const n = points.length;
	if ( n < 3 ) return '';
	const outer: string[] = [], inner: string[] = [];
	// the loop's turning sense, so "out" is away from its middle whichever way it runs
	let area = 0;
	for ( let i = 0; i < n; i ++ ) {

		const p = points[ i ], q = points[ ( i + 1 ) % n ];
		area += p.x * q.y - q.x * p.y;

	}
	const sense = area > 0 ? 1 : - 1;
	for ( let i = 0; i < n; i ++ ) {

		const a = points[ ( i + n - 1 ) % n ], b = points[ ( i + 1 ) % n ], p = points[ i ];
		const tx = b.x - a.x, ty = b.y - a.y, tl = Math.hypot( tx, ty ) || 1;
		const half = widths[ i ] / 2, nx = ty / tl * half * sense, ny = - tx / tl * half * sense;
		outer.push( `${ n1( p.x + nx ) } ${ n1( p.y + ny ) }` );
		inner.push( `${ n1( p.x - nx ) } ${ n1( p.y - ny ) }` );

	}
	return `M${ outer.join( ' L' ) } Z M${ inner.reverse().join( ' L' ) } Z`;

}
