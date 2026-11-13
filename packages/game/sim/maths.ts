import type { Vec2 } from './types.ts';

// The rules' maths, in exact operations only. + − × ÷ and Math.sqrt are correctly rounded by
// IEEE 754, and floor / ceil / round / trunc / abs / min / max / sign / fround / imul are exact,
// so every engine computes them alike; Math's transcendental functions (sin, cos, atan2, log, exp,
// pow) and hypot are not specified to the last bit and differ by an ulp between engines (V8 in node
// and in the page differed for atan2 and sin / cos on a few per cent of inputs), which a game
// compounds over its ticks. So the simulation (packages/game/sim) calls none of them
// (tools/game/verify-game.mjs checks its source): directions are unit vectors, distances go through
// `planar`, and the few functions it needs are series in exact operations here, deterministic to
// the bit and within a few ulp of the true value (tools/game/verify-game.mjs measures it). The same holds for
// what the rules call outside it (characters/Ages.ts, checked with it), except the island the grid
// takes from the world's generator (grid.ts, world/WorldShapes.ts), which is not held to this.

// ln 2 split in two (Cody and Waite): the high part's trailing bits are zero, so k * LN2_HI is
// exact for any k exp meets, and the low part carries the rest
const LN2 = 0.6931471805599453, LN2_HI = 6.93147180369123816490e-01, LN2_LO = 1.90821492927058770002e-10;
// beyond these e^x is Infinity or rounds to 0
const EXP_MAX = 709.782712893384, EXP_MIN = - 745.1332191019411;

/** Length of ( dx, dz ). */
export function planar( dx: number, dz: number ): number {

	return Math.sqrt( dx * dx + dz * dz );

}

/** Distance between two points of the ground plane. */
export function distance( a: Vec2, b: Vec2 ): number {

	return planar( a.x - b.x, a.z - b.z );

}

/** The unit direction of ( dx, dz ), or null for a zero vector. */
export function direction( dx: number, dz: number ): Vec2 | null {

	const d = planar( dx, dz );
	return d > 1e-9 ? { x: dx / d, z: dz / d } : null;

}

/** e^x, by x = k ln 2 + r with | r | ≤ ln 2 / 2: a Taylor series of r, scaled by 2^k in exact
 * doublings (at most about 1075 of them). */
export function exp( x: number ): number {

	if ( Number.isNaN( x ) ) return NaN;
	if ( x > EXP_MAX ) return Infinity;
	if ( x < EXP_MIN ) return 0;
	const k = Math.round( x / LN2 ), r = ( x - k * LN2_HI ) - k * LN2_LO;
	let sum = 1, term = 1;
	for ( let n = 1; n < 24; n ++ ) {

		term = term * r / n;
		sum += term;

	}
	for ( let i = 0; i < k; i ++ ) sum *= 2;
	for ( let i = 0; i > k; i -- ) sum /= 2;
	return sum;

}

/** ln x for x > 0, by x = m 2^e with m in [ √½, √2 ) (exact halvings and doublings, so a value
 * near 1 keeps e = 0 and loses nothing to cancellation) and ln m = 2 atanh( s ),
 * s = ( m − 1 ) / ( m + 1 ), | s | < 0.172. */
export function log( x: number ): number {

	if ( ! ( x > 0 ) ) return x === 0 ? - Infinity : NaN;
	if ( x === Infinity ) return Infinity;
	let m = x, e = 0;
	while ( m >= 2 ) { m /= 2; e ++; }
	while ( m < 1 ) { m *= 2; e --; }
	if ( m > Math.SQRT2 ) { m /= 2; e ++; }
	const s = ( m - 1 ) / ( m + 1 ), s2 = s * s;
	let sum = 0, power = s;
	for ( let n = 1; n < 40; n += 2 ) {

		sum += power / n;
		power *= s2;

	}
	return ( e * LN2_HI + 2 * sum ) + e * LN2_LO;

}
