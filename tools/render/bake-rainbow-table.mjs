/*!
 * Adapted from VolumetricCloudsCS1 by Anthony Ibrahim
 * (https://github.com/anthonytoumaibrahim/VolumetricCloudsCS1): VolumetricClouds/Sky/RainbowTable.cs.
 * Copyright (c) 2026 Anthony Ibrahim
 * Licensed under the MIT License; see ../../packages/render/sky/VolumetricCloudsCS1.LICENSE.txt.
 */

// Bakes the rainbow's colours by angle into packages/render/sky/RainbowTable.data.ts.
//
// The table holds how much of the sun falling rain sends back at each angle from the antisolar
// point, per linear sRGB channel, as a phase function relative to isotropic scattering (so 1 means
// "as bright as an isotropic scatterer"). Run it after a change to the bake below; the bake is
// deterministic, so the committed table can be regenerated and compared byte for byte.
//
// Usage:
//   node tools/render/bake-rainbow-table.mjs
//
// Options: none.
//
// Airy's theory of the rainbow (1838) per wavelength and drop size: near Descartes' ray the
// wavefront leaving a drop is cubic and its far field is Ai^2, scaled so that away from the bow
// it averages to geometric optics. The primary (one internal reflection) and the secondary (two)
// with Fresnel's share for each, over Marshall-Palmer drops at 8 mm/h, over the visible
// wavelengths through the CIE 1931 observer into linear sRGB (white balanced: a grey scatterer is
// exactly grey), smeared by the sun's 0.53 degree disc. Out of it come violet at about 40.6
// degrees and red at 42.5, a brighter sky inside the primary, Alexander's dark band and the
// fainter secondary at 50 - 53.5 degrees with its colours reversed.
//
// Output: a sanity line on stdout (where each colour peaks in the primary and the secondary, the
// dark band's depth, the sky's brightness inside the bow), then the file written and its size. It
// overwrites packages/render/sky/RainbowTable.data.ts.
//
// GPU lock and browser: neither.
//
// Cost: seconds, CPU only.
//
// Exit codes: 0 the table is written; 1 an error (thrown).
import '../kit/help.mjs';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const MAX_ANGLE = 64; // degrees from the antisolar point the table covers
const SIZE = 512; // entries (0.125 degrees each)
const FINE = 2048; // working resolution (0.03125 degrees)
const SUN_RADIUS = 0.2665; // degrees
const RAIN_RATE = 8; // mm/h: drops of mostly 0.3 - 0.5 mm radius
const DROP_SIZES = 24;
const WAVELENGTHS = 71; // 380 - 730 nm in 5 nm steps

// Ai( x ): its power series near 0, the asymptotic forms beyond |x| = 5 (each to its first
// correction; they meet the series to about 1e-3 there).
function airy( x ) {

	if ( x > 5 ) {

		const z = 2 / 3 * x * Math.sqrt( x );
		return Math.exp( - z ) / ( 2 * Math.sqrt( Math.PI ) * Math.pow( x, 0.25 ) ) * ( 1 - 5 / ( 72 * z ) );

	}
	if ( x < - 5 ) {

		const zz = - x, z = 2 / 3 * zz * Math.sqrt( zz ), ph = z + Math.PI / 4;
		return ( Math.sin( ph ) - 5 / ( 72 * z ) * Math.cos( ph ) ) / ( Math.sqrt( Math.PI ) * Math.pow( zz, 0.25 ) );

	}
	const x3 = x * x * x;
	let f = 1, g = x, tf = 1, tg = x;
	for ( let k = 1; k < 80; k ++ ) {

		tf *= x3 / ( ( 3 * k - 1 ) * ( 3 * k ) );
		tg *= x3 / ( ( 3 * k ) * ( 3 * k + 1 ) );
		f += tf;
		g += tg;
		if ( Math.abs( tf ) + Math.abs( tg ) < 1e-18 ) break;

	}
	return 0.355028053887817239 * f - 0.258819403792806798 * g;

}

// Water's refractive index, a Cauchy fit (1.3435 at 400 nm, 1.3328 at 589, 1.3302 at 700).
const waterIndex = ( nm ) => 1.324 + 3046 / ( nm * nm );

// Angle from the antisolar point (radians) of the ray that entered a drop at impact parameter b
// (0..1) and left after k reflections inside.
function psi( b, n, k ) {

	const i = Math.asin( b ), r = Math.asin( b / n );
	let d = ( 2 * ( i - r ) + k * ( Math.PI - 2 * r ) ) % ( 2 * Math.PI );
	if ( d < 0 ) d += 2 * Math.PI;
	const theta = d <= Math.PI ? d : 2 * Math.PI - d;
	return Math.PI - theta;

}

// Fresnel: the share of unpolarised light that enters, reflects k times inside and leaves.
function transmission( b, n, k ) {

	const ci = Math.sqrt( 1 - b * b ), sr = b / n, cr = Math.sqrt( 1 - sr * sr );
	const rs = ( ( ci - n * cr ) / ( ci + n * cr ) ) ** 2;
	const rp = ( ( n * ci - cr ) / ( n * ci + cr ) ) ** 2;
	return 0.5 * ( ( 1 - rs ) * ( 1 - rs ) * Math.pow( rs, k ) + ( 1 - rp ) * ( 1 - rp ) * Math.pow( rp, k ) );

}

// Descartes' ray for k reflections: its impact parameter, its angle from the antisolar point
// (radians) and how that angle curves there (d2psi / db2).
function bowRay( n, k ) {

	const b = Math.sqrt( 1 - ( n * n - 1 ) / ( k * ( k + 2 ) ) );
	const p = psi( b, n, k );
	const h = 1e-4;
	return { b, psi: p, curve: ( psi( b + h, n, k ) - 2 * p + psi( b - h, n, k ) ) / ( h * h ) };

}

// The CIE 1931 2 degree observer, Wyman, Sloan and Shirley's multi-lobe fit (JCGT 2013).
function xyz( nm ) {

	const g = ( x, mu, s1, s2 ) => {

		const t = ( x - mu ) / ( x < mu ? s1 : s2 );
		return Math.exp( - 0.5 * t * t );

	};
	return [
		1.056 * g( nm, 599.8, 37.9, 31.0 ) + 0.362 * g( nm, 442.0, 16.0, 26.7 ) - 0.065 * g( nm, 501.1, 20.4, 26.2 ),
		0.821 * g( nm, 568.8, 46.9, 40.5 ) + 0.286 * g( nm, 530.9, 16.3, 31.1 ),
		1.217 * g( nm, 437.0, 11.8, 36.0 ) + 0.681 * g( nm, 459.0, 26.0, 13.8 ),
	];

}

// Marshall-Palmer drops, N( D ) ~ exp( -4.1 R^-0.21 D ) (D in mm, R in mm/h), radii 0.05 - 1.25 mm
// (bigger drops flatten and make no bow), weighted by number times cross-section.
function rainDrops( mmPerHour, count ) {

	const lambda = 4.1 * Math.pow( mmPerHour, - 0.21 );
	const radii = [], weights = [];
	const lo = Math.log( 0.05 ), hi = Math.log( 1.25 ), dl = ( hi - lo ) / ( count - 1 );
	for ( let i = 0; i < count; i ++ ) {

		const a = Math.exp( lo + dl * i );
		radii.push( a );
		weights.push( Math.exp( - lambda * 2 * a ) * a * a * a * dl ); // N x a^2 x da (da = a dl)

	}
	return { radii, weights };

}

// The table: SIZE entries of RGB, entry j at ( j + 0.5 ) x MAX_ANGLE / SIZE degrees.
function build( radii, weights ) {

	const dpsi = MAX_ANGLE / FINE * Math.PI / 180;
	const acc = [ new Float64Array( FINE ), new Float64Array( FINE ), new Float64Array( FINE ) ];
	// Each wavelength's share of R, G and B, balanced so that a flat spectrum is exactly grey.
	const rgb = [], sum = [ 0, 0, 0 ];
	for ( let l = 0; l < WAVELENGTHS; l ++ ) {

		const [ x, y, z ] = xyz( 380 + 5 * l );
		const c = [ 3.2406 * x - 1.5372 * y - 0.4986 * z, - 0.9689 * x + 1.8758 * y + 0.0415 * z, 0.0557 * x - 0.2040 * y + 1.0570 * z ];
		rgb.push( c );
		for ( let i = 0; i < 3; i ++ ) sum[ i ] += c[ i ];

	}
	const total = weights.reduce( ( a, b ) => a + b, 0 );
	for ( let l = 0; l < WAVELENGTHS; l ++ ) {

		const nm = 380 + 5 * l, n = waterIndex( nm );
		for ( let k = 1; k <= 2; k ++ ) {

			const ray = bowRay( n, k );
			const sign = ray.curve < 0 ? - 1 : 1, bend = Math.abs( ray.curve );
			const share = transmission( ray.b, n, k ), sinTheta = Math.sin( Math.PI - ray.psi );
			for ( let a = 0; a < radii.length; a ++ ) {

				const beta = 2 * Math.PI * radii[ a ] * 1e6 / nm;
				const s = Math.pow( 2 * beta * beta / bend, 1 / 3 );
				const scale = 4 * Math.PI * ray.b * share * Math.sqrt( 2 * s / bend ) / sinTheta * weights[ a ] / total;
				for ( let j = 0; j < FINE; j ++ ) {

					const x = sign * ( ray.psi - ( j + 0.5 ) * dpsi ) * s;
					if ( x > 9 ) continue;
					// Where Ai^2 swings faster than 3 cells, its mean: what the sun's disc and the
					// spread of drop sizes leave of it anyway, 1 / ( 2 pi sqrt( -x ) ).
					let v;
					if ( x < - 5 && Math.PI / ( Math.sqrt( - x ) * s ) < 3 * dpsi ) v = 1 / ( 2 * Math.PI * Math.sqrt( - x ) );
					else {

						const ai = airy( x );
						v = ai * ai;

					}
					const p = scale * v;
					for ( let c = 0; c < 3; c ++ ) acc[ c ][ j ] += p * rgb[ l ][ c ] / sum[ c ];

				}

			}

		}

	}

	// The sun's disc (a chord-length kernel).
	const cell = MAX_ANGLE / FINE;
	const radius = Math.ceil( SUN_RADIUS / cell );
	const kernel = [];
	let kernelSum = 0;
	for ( let q = - radius; q <= radius; q ++ ) {

		const u = q * cell / SUN_RADIUS;
		const w = u * u < 1 ? Math.sqrt( 1 - u * u ) : 0;
		kernel.push( w );
		kernelSum += w;

	}
	const smooth = [ new Float64Array( FINE ), new Float64Array( FINE ), new Float64Array( FINE ) ];
	for ( let c = 0; c < 3; c ++ ) for ( let j = 0; j < FINE; j ++ ) {

		let v = 0;
		for ( let q = - radius; q <= radius; q ++ ) v += acc[ c ][ Math.max( 0, Math.min( FINE - 1, j + q ) ) ] * kernel[ q + radius ];
		smooth[ c ][ j ] = v / kernelSum;

	}

	// Colours outside the sRGB gamut pulled toward their own luminance (a rainbow's spectral
	// colours are purer than any screen), then a fade over the last 6 degrees.
	for ( let j = 0; j < FINE; j ++ ) {

		let r = smooth[ 0 ][ j ], g = smooth[ 1 ][ j ], b = smooth[ 2 ][ j ];
		const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
		const lowest = Math.min( r, g, b );
		if ( lowest < 0 ) {

			const t = luminance > 0 ? luminance / ( luminance - lowest ) : 0;
			r = luminance + ( r - luminance ) * t;
			g = luminance + ( g - luminance ) * t;
			b = luminance + ( b - luminance ) * t;

		}
		const degrees = ( j + 0.5 ) * cell;
		let edge = Math.min( 1, Math.max( 0, ( MAX_ANGLE - degrees ) / 6 ) );
		edge = edge * edge * ( 3 - 2 * edge );
		smooth[ 0 ][ j ] = Math.max( 0, r ) * edge;
		smooth[ 1 ][ j ] = Math.max( 0, g ) * edge;
		smooth[ 2 ][ j ] = Math.max( 0, b ) * edge;

	}

	// Box-averaged down to the table's size.
	const table = new Float64Array( 3 * SIZE );
	const per = FINE / SIZE;
	for ( let e = 0; e < SIZE; e ++ ) for ( let c = 0; c < 3; c ++ ) {

		let v = 0;
		for ( let q = 0; q < per; q ++ ) v += smooth[ c ][ e * per + q ];
		table[ 3 * e + c ] = v / per;

	}
	return table;

}

const at = ( e ) => ( e + 0.5 ) * MAX_ANGLE / SIZE;
function peak( table, c, from, to ) {

	let best = - 1, where = 0;
	for ( let e = 0; e < SIZE; e ++ ) if ( at( e ) >= from && at( e ) <= to && table[ 3 * e + c ] > best ) {

		best = table[ 3 * e + c ];
		where = at( e );

	}
	return `${ best.toFixed( 3 ) }@${ where.toFixed( 1 ) }`;

}
function stat( table, c, from, to, reduce ) {

	const values = [];
	for ( let e = 0; e < SIZE; e ++ ) if ( at( e ) >= from && at( e ) <= to ) values.push( table[ 3 * e + c ] );
	return reduce( values );

}

const { radii, weights } = rainDrops( RAIN_RATE, DROP_SIZES );
const table = build( radii, weights );
// A sanity line: where each colour peaks in the primary and the secondary, how dark Alexander's
// band gets and how bright the sky inside the bow is (all relative to isotropic scattering).
console.log( 'primary R G B', [ 0, 1, 2 ].map( ( c ) => peak( table, c, 30, 47 ) ).join( ' ' ),
	'| secondary R G B', [ 0, 1, 2 ].map( ( c ) => peak( table, c, 48, 60 ) ).join( ' ' ),
	'| dark band G', stat( table, 1, 44, 50, ( v ) => Math.min( ...v ) ).toFixed( 4 ),
	'| inside G', stat( table, 1, 25, 35, ( v ) => v.reduce( ( a, b ) => a + b, 0 ) / v.length ).toFixed( 4 ) );

// Half floats are plenty for a colour table; four significant digits keep the source short.
const values = Array.from( table, ( v ) => Number( v.toPrecision( 4 ) ) );
const rows = [];
for ( let e = 0; e < SIZE; e += 8 ) rows.push( '\t' + values.slice( 3 * e, 3 * ( e + 8 ) ).join( ', ' ) + ',' );
const source = `// Generated by tools/render/bake-rainbow-table.mjs; do not edit.
// The rainbow's colours: linear sRGB phase function of falling rain relative to isotropic
// scattering, ${ SIZE } entries over 0 - ${ MAX_ANGLE } degrees from the antisolar point (entry j at
// ( j + 0.5 ) x ${ MAX_ANGLE / SIZE } degrees), RGB interleaved.

export const RAINBOW_MAX_ANGLE = ${ MAX_ANGLE };
export const RAINBOW_SIZE = ${ SIZE };

export const RAINBOW_TABLE: readonly number[] = [
${ rows.join( '\n' ) }
];
`;
const out = fileURLToPath( new URL( '../../packages/render/sky/RainbowTable.data.ts', import.meta.url ) );
writeFileSync( out, source );
console.log( `wrote ${ out.replace( /.*\/packages\//, 'packages/' ) } (${ source.length } bytes)` );
