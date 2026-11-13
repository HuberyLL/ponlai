import type { Frame } from './Brush.ts';

// The ink of the interface's long strokes: the tail runs dry as a brush's does.
//
// The ink of the interface's long strokes (docs/explanation/ui.md, Principles: every line is a brush stroke): a
// stroke keeps its outline exactly (Brush.ts) and the ink only leaves it, as a brush's does.
//
// - Its tail runs dry (飞白): from halfway on, streaks of bare paper open along the stroke, the outer
//   bristles first and more toward the exit, until the tip parts into a few threads. How dry comes
//   with the stroke's length in widths: a short stroke never runs out of ink, so an icon's strokes
//   stay as drawn. A thin stroke on screen dries half as much (its streaks would be crumbs).
// - Through the stroke, past the first press, a few thin gaps of bare paper run along it.
// - Its edge is drunk in by the paper: slow round scallops, at most a third of the half-width,
//   fading out over about a pixel through fibres along the stroke, so it frays and never steps.
//   Where strokes join, the edge of the whole drawn shape decides, not each stroke's own outline.
// - The ink is fullest where the brush first presses and a little thinner after, changing slowly
//   along the stroke across its whole width.
// The gaps, the edge and the tone show only on a stroke wide enough on screen to hold them (from
// about 4 device pixels, fully from 12): a thin one keeps its clean outline and dries only at its
// tail.
//
// Rules: a stroke is ink or paper, never a lighter grey of ink in lines or patches (on the dark
// scene a thinner ink reads as a stain); only the gentle tone is in between. Every mark is placed
// in the stroke's own frame (t along it, u across it), never on the screen's grid, so it moves with
// the stroke and does not shimmer as the stroke moves; a pixel belongs to the stroke it lies
// deepest in, blending into the next deepest over a couple of pixels where strokes join. Sizes are
// in the interface's units (`unit` device pixels each), so a stroke keeps its look at any scale;
// noise comes from hashes of positions and the stroke's seed, so a stroke inks the same every time.
// Pure TypeScript (no DOM), checked by tools/game/verify-ink.mjs; InkPath.ts draws it into the page.

/** A stroke to ink: its frame in device pixels, the seed its marks come from, and how dry its tail
 * runs as a share of the style's (1 by default; 0 for a gauge, whose ends must stay exact). */
export interface InkStroke {
	frame: Frame;
	seed: number;
	dry?: number;
}

// where the tail starts to dry (t), and how dry it is at the exit (0..1)
const DRY_FROM = 0.5, DRY_AMOUNT = 0.75;
// a dry streak's length, in widths, and how much the paper's tooth shows in the dry part
const STREAK = 4, GRAIN = 0.5;
// how many gaps run through the stroke, how far the edge is drunk in, how much the tone changes
const GAPS = 1.6, RAGGED = 1, TONE = 1;

function hash( a: number, b: number, seed: number ): number {

	let h = Math.imul( a | 0, 0x27d4eb2d ) ^ Math.imul( b | 0, 0x165667b1 ) ^ Math.imul( seed | 0, 0x9e3779b1 );
	h = Math.imul( h ^ ( h >>> 15 ), 0x85ebca6b );
	h = Math.imul( h ^ ( h >>> 13 ), 0xc2b2ae35 );
	return ( ( h ^ ( h >>> 16 ) ) >>> 0 ) / 4294967296;

}

const fade = ( t: number ) => t * t * ( 3 - 2 * t );
const smoothstep = ( a: number, b: number, x: number ) => fade( Math.min( Math.max( ( x - a ) / ( b - a ), 0 ), 1 ) );

// value noise, 0..1
function noise2( x: number, y: number, seed: number ): number {

	const i = Math.floor( x ), j = Math.floor( y ), u = fade( x - i ), v = fade( y - j );
	const a = hash( i, j, seed ), b = hash( i + 1, j, seed ), c = hash( i, j + 1, seed ), d = hash( i + 1, j + 1, seed );
	return ( a * ( 1 - u ) + b * u ) * ( 1 - v ) + ( c * ( 1 - u ) + d * u ) * v;

}

/**
 * The share of its ink each pixel of a drawing keeps (0..1; 1 where no stroke reaches): `image` is
 * the drawing's coverage (its alpha), `strokes` its strokes' frames in the same pixels, `unit` the
 * device pixels of one unit of the interface. Multiply the drawing's alpha by it.
 */
export function inkShares( image: { data: ArrayLike<number>; width: number; height: number }, strokes: readonly InkStroke[], unit: number ): Float32Array {

	const W = image.width, H = image.height, alpha = image.data, shares = new Float32Array( W * H ).fill( 1 );
	// each pixel's stroke, its place in it (t along, u across), its distance in from that stroke's
	// edge and the stroke's half-width there (pixels); and the next deepest stroke's, where two meet
	const OWN = new Int16Array( W * H ).fill( - 1 ), T = new Float32Array( W * H ), U = new Float32Array( W * H );
	const E = new Float32Array( W * H ), HW = new Float32Array( W * H );
	const OWN2 = new Int16Array( W * H ).fill( - 1 ), T2 = new Float32Array( W * H ), U2 = new Float32Array( W * H ), E2 = new Float32Array( W * H );
	const each = strokes.map( ( { frame: { points, half }, seed, dry = 1 }, j ) => {

		const n = points.length, cum = [ 0 ];
		for ( let i = 1; i < n; i ++ ) cum.push( cum[ i - 1 ] + Math.hypot( points[ i ].x - points[ i - 1 ].x, points[ i ].y - points[ i - 1 ].y ) );
		const length = n > 1 ? cum[ n - 1 ] : 0, widest = n > 1 ? Math.max( ...half ) * 2 : 0;
		if ( length <= 0 || widest <= 0 ) return null;
		let seg = 1;
		// past both ends by the width and a pixel and a half, so a round cap is placed with its end
		const steps = Math.ceil( length * 3 ), over = Math.ceil( ( Math.max( half[ 0 ], half[ n - 1 ] ) + 1.5 ) * 3 );
		for ( let k = - over; k <= steps + over; k ++ ) {

			const s = Math.min( Math.max( k / steps, 0 ), 1 ) * length, beyond = ( k < 0 ? k : k > steps ? k - steps : 0 ) / 3;
			while ( seg < n - 1 && cum[ seg ] < s ) seg ++;
			const p = points[ seg - 1 ], q = points[ seg ], f = ( s - cum[ seg - 1 ] ) / ( ( cum[ seg ] - cum[ seg - 1 ] ) || 1 );
			const x = p.x + ( q.x - p.x ) * f, y = p.y + ( q.y - p.y ) * f, tl = Math.hypot( q.x - p.x, q.y - p.y ) || 1;
			const nx = - ( q.y - p.y ) / tl, ny = ( q.x - p.x ) / tl, h = half[ seg - 1 ] + ( half[ seg ] - half[ seg - 1 ] ) * f;
			const cx = x + ( q.x - p.x ) / tl * beyond, cy = y + ( q.y - p.y ) / tl * beyond;
			const t = Math.min( Math.max( k / steps, 0 ), 1 );
			// across, past the edge by a pixel and a half, so the anti-aliased rim is placed too
			const reach = h + 1.5, across = Math.ceil( reach * 3 );
			for ( let i = - across; i <= across; i ++ ) {

				const o = i / across * reach, px = Math.floor( cx + nx * o ), py = Math.floor( cy + ny * o );
				if ( px < 0 || py < 0 || px >= W || py >= H ) continue;
				// the pixel's own centre across the stroke, not the sample's that reached it (that one
				// lands anywhere in the pixel and would step the edge by up to half a pixel); past an
				// end, the distance from the end too: the edge there is a round cap's
				const off = ( px + 0.5 - cx ) * nx + ( py + 0.5 - cy ) * ny;
				const past = beyond === 0 ? 0 : Math.max( 0, ( ( px + 0.5 - x ) * ( q.x - p.x ) + ( py + 0.5 - y ) * ( q.y - p.y ) ) / tl * Math.sign( beyond ) );
				const k2 = py * W + px, e = h - Math.hypot( off, past ), u = Math.max( - 1, Math.min( 1, off / Math.max( h, 0.5 ) ) );
				if ( OWN[ k2 ] >= 0 && e <= E[ k2 ] ) {

					// another stroke lies deeper here: this one may be the next deepest
					if ( OWN[ k2 ] !== j && ( OWN2[ k2 ] < 0 || e > E2[ k2 ] ) ) {

						OWN2[ k2 ] = j;
						T2[ k2 ] = t;
						U2[ k2 ] = u;
						E2[ k2 ] = e;

					}
					continue;

				}
				if ( OWN[ k2 ] >= 0 && OWN[ k2 ] !== j ) {

					OWN2[ k2 ] = OWN[ k2 ];
					T2[ k2 ] = T[ k2 ];
					U2[ k2 ] = U[ k2 ];
					E2[ k2 ] = E[ k2 ];

				}
				OWN[ k2 ] = j;
				T[ k2 ] = t;
				U[ k2 ] = u;
				E[ k2 ] = e;
				HW[ k2 ] = h;

			}

		}
		// the marks within the stroke show on a stroke wide enough on screen to hold them
		const shows = smoothstep( 4, 12, widest );
		return {
			length, widest, seed, gaps: GAPS * shows, ragged: RAGGED * shows, tone: TONE * shows,
			// a short stroke never runs out of ink: the dryness comes in with its length in widths;
			// a thin one dries half as much, its few streaks would be crumbs
			dry: DRY_AMOUNT * dry * smoothstep( 3, 18, length / widest ) * ( 0.5 + 0.5 * shows ),
			// a pattern's lanes across the stroke, about two units apart (closer, a lane would be
			// thinner than two pixels and step across the pixel rows)
			lanes: Math.max( 3, widest / unit * 0.55 ),
		};

	} );
	// each pixel's distance in from the edge of the whole drawn shape (a stroke's own edge is not the
	// shape's where another stroke goes on past it)
	const inside = each.some( ( e ) => e && e.ragged > 0 ) ? distanceInside( alpha, W, H ) : null;

	// the share of its ink a stroke leaves at a place in it: the tone, the gaps through it, its dry tail
	const share = ( stroke: NonNullable<typeof each[ number ]>, t: number, u: number, hw: number ): number => {

		const { length, widest, seed, gaps, tone, dry, lanes } = stroke;
		const row = ( u + 1 ) / 2;
		let ink = 1;
		// thinner after the first press, and slowly along the stroke across its whole width
		// (patches narrower than the stroke read as stains)
		if ( tone > 0 ) ink *= 1 - tone * ( 0.1 * smoothstep( 0.02, 0.45, t ) + 0.05 * noise2( t * length / ( widest * 4 ), row * 0.7, seed + 7 ) );
		// the gaps through it: bare paper where a thin, long pattern runs lowest (a hair or two
		// wide, some widths long), more where a slower one gathers them; past the first press
		if ( gaps > 0 ) {

			const a = t * length / widest;
			const lane = noise2( a / 3, row * lanes * 1.4, seed + 12 ), gather = noise2( a / 1.2, row * lanes * 0.7, seed + 13 );
			const bar = gaps * 0.1 * smoothstep( 0.03, 0.15, t ) * ( 0.4 + 1.2 * gather );
			ink *= smoothstep( bar - 0.03, bar + 0.03, lane );

		}
		// the dry tail: a streak stays paper where its pattern falls under a bar that rises with
		// the dryness, the paper's tooth first; the tooth is drawn out along the stroke, as the
		// dragged brush meets it, so even a thin stroke skips in streaks rather than dots
		const d = Math.min( 1, dry * smoothstep( DRY_FROM, 1, t ) ** 0.8 * ( 1 + 0.6 * u * u ) + 0.3 * dry * smoothstep( 0.92, 1, t ) );
		if ( d > 0 ) {

			const along = t * length / ( widest * STREAK );
			const value = 0.65 * noise2( along, row * 6, seed ) + 0.35 * noise2( along * 2.5, row * lanes, seed + 1 );
			const a = t * length / unit, c = u * hw / unit;
			const paper = noise2( a / 1.1, c / 0.4, seed + 2 ) * 0.6 + noise2( a / 3, c, seed + 3 ) * 0.4;
			const bar = d * 1.1 - 0.15 + GRAIN * ( paper - 0.5 ) * ( 0.3 + 0.6 * d ) + 0.08 * ( noise2( along * 6, row * lanes * 2, seed + 4 ) - 0.5 );
			ink *= smoothstep( bar - 0.035, bar + 0.035, value );

		}
		return ink;

	};

	for ( let k = 0; k < W * H; k ++ ) {

		const covered = alpha[ k * 4 + 3 ];
		if ( OWN[ k ] < 0 || covered === 0 ) continue;
		const stroke = each[ OWN[ k ] ];
		if ( ! stroke ) continue;
		const t = T[ k ], u = U[ k ];
		let ink = share( stroke, t, u, HW[ k ] );
		// where another stroke is nearly as deep, the two blend: half and half where they are equal
		const next = OWN2[ k ] >= 0 ? each[ OWN2[ k ] ] : null;
		if ( next ) {

			const w = 0.5 * ( 1 - smoothstep( 0, 2.5, E[ k ] - E2[ k ] ) );
			if ( w > 0 ) ink += ( share( next, T2[ k ], U2[ k ], HW[ k ] ) - ink ) * w;

		}
		// the edge, where the stroke's edge is the shape's (the shape's distance in, measured on the
		// pixel grid, agrees with the stroke's own): slow round scallops, each side its own, then a
		// fade over about a pixel through fibres that run along the stroke
		const { length, seed, ragged } = stroke;
		if ( ragged > 0 && Math.abs( inside![ k ] - E[ k ] ) < 1.5 ) {

			const side = u < 0 ? 0.5 : 13.5, along = t * length / unit;
			const bite = Math.min( ragged * unit * ( 0.08 + 0.65 * noise2( along / 5, side, seed + 8 ) ** 2 + 0.12 * noise2( along / 1.8, side + 3, seed + 11 ) ), 0.3 * HW[ k ] );
			const fibre = ragged * Math.min( unit * 0.3, 1.2 ) * ( noise2( along / 1.6, E[ k ] / Math.max( unit, 2 ) + side, seed + 9 ) - 0.5 ) * 2;
			const edge = Math.min( 1, Math.max( 0, ( E[ k ] - bite - fibre ) / ( 1 + 0.6 * ragged ) + 0.5 ) );
			ink = Math.min( ink, 255 * edge / covered );

		}
		shares[ k ] = ink;

	}
	return shares;

}

// Each pixel's distance (pixels) in from the edge of what is drawn (alpha over half), by a 3-4
// chamfer in two passes; outside, 0.
function distanceInside( alpha: ArrayLike<number>, W: number, H: number ): Float32Array {

	const D = new Float32Array( W * H );
	for ( let k = 0; k < W * H; k ++ ) D[ k ] = alpha[ k * 4 + 3 ] > 127 ? 1e6 : 0;
	const at = ( x: number, y: number ) => x < 0 || y < 0 || x >= W || y >= H ? 0 : D[ y * W + x ];
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		const k = y * W + x;
		if ( D[ k ] > 0 ) D[ k ] = Math.min( D[ k ], at( x - 1, y ) + 3, at( x, y - 1 ) + 3, at( x - 1, y - 1 ) + 4, at( x + 1, y - 1 ) + 4 );

	}
	for ( let y = H - 1; y >= 0; y -- ) for ( let x = W - 1; x >= 0; x -- ) {

		const k = y * W + x;
		if ( D[ k ] > 0 ) D[ k ] = Math.min( D[ k ], at( x + 1, y ) + 3, at( x, y + 1 ) + 3, at( x + 1, y + 1 ) + 4, at( x - 1, y + 1 ) + 4 );

	}
	// in pixels, measured from the edge between the last pixel out and the first in
	for ( let k = 0; k < W * H; k ++ ) D[ k ] = D[ k ] > 0 ? D[ k ] / 3 - 0.5 : 0;
	return D;

}
