// Checks of the interface's ink (src/game/ui/Ink.ts, its header has the rules), asserted on strokes
// drawn here as the page draws them (a centreline and half-widths, coverage anti-aliased over a
// pixel), at high's scale (1.2 at 1920 x 1080 CSS pixels, device pixel ratio 2): the ink is the same
// for the same stroke and seed and another for another seed; it never adds ink, and never reaches
// past the outline; a short stroke (an icon's) keeps its ink; a long stroke keeps its first press
// and dries toward its exit, more on a broad stroke than on a thin one; a stroke told not to dry (a
// gauge) keeps its ink to its exit.
// Pure CPU; Node 22.18+ strips the imported TypeScript.
// Run: node tools/verify-ink.mjs
import assert from 'node:assert/strict';
import { inkShares } from '../src/game/ui/Ink.ts';

const UNIT = 1.2 * 2;

// A level stroke `length` units long and `width` wide at its fullest, tapering at both ends as the
// interface's do (Brush.ts profile), placed in an image of its size: its frame in device pixels
// and its coverage (alpha, RGBA as a canvas gives it).
function level( length, width ) {

	const pad = 6, W = Math.ceil( length * UNIT ) + 2 * pad, H = Math.ceil( width * UNIT ) + 2 * pad;
	const points = [], half = [];
	for ( let i = 0; i <= 64; i ++ ) {

		const t = i / 64, w = width * Math.min( 1, 0.3 + t / 0.1 ) * Math.min( 1, 0.05 + ( 1 - t ) / 0.3 );
		points.push( { x: pad + t * length * UNIT, y: H / 2 } );
		half.push( w * UNIT / 2 );

	}
	const data = new Uint8ClampedArray( W * H * 4 );
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		const i = Math.min( 64, Math.max( 0, Math.round( ( x + 0.5 - pad ) / ( length * UNIT ) * 64 ) ) );
		const inside = x + 0.5 >= pad && x + 0.5 <= pad + length * UNIT ? half[ i ] - Math.abs( y + 0.5 - H / 2 ) : - 1;
		data[ ( y * W + x ) * 4 + 3 ] = Math.round( 255 * Math.min( 1, Math.max( 0, inside + 0.5 ) ) );

	}
	return { image: { data, width: W, height: H }, frame: { points, half }, pad, length };

}

// The mean share of the ink the covered pixels keep, between two shares of the stroke's length.
function kept( stroke, shares, from, to ) {

	const { image: { data, width: W, height: H }, pad, length } = stroke;
	let sum = 0, n = 0;
	for ( let y = 0; y < H; y ++ ) for ( let x = 0; x < W; x ++ ) {

		const t = ( x + 0.5 - pad ) / ( length * UNIT ), k = y * W + x;
		if ( data[ k * 4 + 3 ] < 128 || t < from || t >= to ) continue;
		sum += shares[ k ];
		n ++;

	}
	return sum / n;

}

const ink = ( stroke, seed, dry ) => inkShares( stroke.image, [ { frame: stroke.frame, seed, dry } ], UNIT );

// the record's river: long and broad
const river = level( 1160, 11 );
const a = ink( river, 33 ), b = ink( river, 33 ), c = ink( river, 34 );
assert.deepEqual( a, b, 'the same stroke and seed ink the same' );
assert.notDeepEqual( a, c, 'another seed inks otherwise' );
for ( let k = 0; k < a.length; k ++ ) {

	assert.ok( a[ k ] >= 0 && a[ k ] <= 1, 'a share of the ink, never more' );
	if ( river.image.data[ k * 4 + 3 ] === 0 ) assert.equal( a[ k ], 1, 'nothing outside the outline' );

}
const start = kept( river, a, 0.05, 0.3 ), tail = kept( river, a, 0.8, 0.95 );
// (the first press loses a little to the tone, the frayed edge and a few gaps)
assert.ok( start > 0.8, `the first press keeps its ink (${ start.toFixed( 3 ) })` );
assert.ok( tail < 0.4, `the tail runs dry (${ tail.toFixed( 3 ) })` );
assert.ok( kept( river, a, 0.3, 0.5 ) > tail, 'drier toward the exit' );

// an icon's stroke: short, so its ink holds
const icon = level( 18, 2.6 ), iconInk = ink( icon, 30 );
const iconKept = kept( icon, iconInk, 0, 1 );
assert.ok( iconKept > 0.9, `a short stroke keeps its ink (${ iconKept.toFixed( 3 ) })` );

// a thin long stroke (the speak bar's) dries less than a broad one
const thin = level( 255, 2.4 ), thinInk = ink( thin, 51 );
const thinTail = kept( thin, thinInk, 0.8, 0.95 );
assert.ok( thinTail > tail, `a thin stroke dries less (${ thinTail.toFixed( 3 ) } against ${ tail.toFixed( 3 ) })` );

// a gauge (a need's bar): told not to dry, it keeps its ink to its exit (its tapering tip loses a
// little more to the frayed edge than its body), where the same bar drying would not
const bar = level( 128, 4.4 );
const barTail = kept( bar, ink( bar, 65, 0 ), 0.8, 0.95 ), dryBarTail = kept( bar, ink( bar, 65, 1 ), 0.8, 0.95 );
assert.ok( barTail > 0.6 && barTail > dryBarTail + 0.15, `a gauge keeps its exit (${ barTail.toFixed( 3 ) }; drying, ${ dryBarTail.toFixed( 3 ) })` );

console.log( `ink: the river keeps ${ ( 100 * start ).toFixed( 0 ) } % of its ink at the start and ${ ( 100 * tail ).toFixed( 0 ) } % in its tail; a thin stroke's tail ${ ( 100 * thinTail ).toFixed( 0 ) } %, an icon's stroke ${ ( 100 * iconKept ).toFixed( 1 ) } %, a gauge's tail ${ ( 100 * barTail ).toFixed( 0 ) } % (${ ( 100 * dryBarTail ).toFixed( 0 ) } % drying)` );
console.log( 'verify-ink: all checks passed' );
