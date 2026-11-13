// Pack the Yale Bright Star Catalogue into the compact star list the night sky draws:
//   node tools/island/build-star-catalog.mjs <bsc5 catalog.gz> [public/sky/stars.bin]
//
// Source: the Bright Star Catalogue, 5th Revised Ed. (Hoffleit and Warren 1991), CDS catalogue
// V/50 (https://cdsarc.cds.unistra.fr/viz-bin/cat/V/50), file `catalog.gz`; the byte layout is in
// the catalogue's ReadMe. From each of its 9110 entries this keeps the J2000 position, the visual
// magnitude and a colour from B-V; the 14 entries removed from the catalogue (blank positions)
// are skipped.
//
// Output, little-endian: 'BSC5', a u32 star count, then 8 bytes per star, brightest first:
//   u16 right ascension (65536 per turn), i16 declination (32767 per 90 degrees),
//   u8 V magnitude ((V + 2) * 20), u8 x3 linear sRGB colour (brightest channel 255).
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { gunzipSync } from 'node:zlib';

const [ source, target = 'public/sky/stars.bin' ] = process.argv.slice( 2 );
if ( ! source ) throw new Error( 'usage: node tools/island/build-star-catalog.mjs <catalog.gz> [out.bin]' );

// Fixed-width fields by the ReadMe's 1-based byte positions.
const field = ( line, from, to ) => line.slice( from - 1, to ).trim();

// Effective temperature from B-V: F. J. Ballesteros, "New insights into black bodies",
// EPL 97 (2012) 34008, equation 14.
const temperature = ( bv ) => 4600 * ( 1 / ( 0.92 * bv + 1.7 ) + 1 / ( 0.92 * bv + 0.62 ) );

// CIE 1931 2-degree colour matching functions, the multi-lobe fit of C. Wyman, P.-P. Sloan and
// P. Shirley, "Simple Analytic Approximations to the CIE XYZ Color Matching Functions",
// JCGT 2 (2013) 1-11.
const lobe = ( l, mu, s1, s2 ) => {

	const t = ( l - mu ) / ( l < mu ? s1 : s2 );
	return Math.exp( - 0.5 * t * t );

};
const cmf = ( l ) => [
	1.056 * lobe( l, 599.8, 37.9, 31.0 ) + 0.362 * lobe( l, 442.0, 16.0, 26.7 ) - 0.065 * lobe( l, 501.1, 20.4, 26.2 ),
	0.821 * lobe( l, 568.8, 46.9, 40.5 ) + 0.286 * lobe( l, 530.9, 16.3, 31.1 ),
	1.217 * lobe( l, 437.0, 11.8, 36.0 ) + 0.681 * lobe( l, 459.0, 26.0, 13.8 ),
];

// Linear sRGB (D65 white) of a black body: Planck's law integrated against the matching
// functions, then the sRGB (IEC 61966-2-1) XYZ to RGB matrix. Only the chromaticity is kept.
function blackBody( kelvin ) {

	const xyz = [ 0, 0, 0 ];
	for ( let nm = 380; nm <= 780; nm ++ ) {

		const l = nm * 1e-9;
		const radiance = 1 / ( l ** 5 * ( Math.exp( 1.438777e-2 / ( l * kelvin ) ) - 1 ) );
		const [ x, y, z ] = cmf( nm );
		xyz[ 0 ] += radiance * x; xyz[ 1 ] += radiance * y; xyz[ 2 ] += radiance * z;

	}
	const [ X, Y, Z ] = xyz;
	const rgb = [
		3.2406 * X - 1.5372 * Y - 0.4986 * Z,
		- 0.9689 * X + 1.8758 * Y + 0.0415 * Z,
		0.0557 * X - 0.2040 * Y + 1.0570 * Z,
	].map( ( c ) => Math.max( c, 0 ) );
	const peak = Math.max( ...rgb );
	return rgb.map( ( c ) => c / peak );

}

// A few entries lack B-V; their spectral class stands in with a typical dwarf's colour.
const CLASS_BV = { O: - 0.3, B: - 0.15, A: 0.1, F: 0.4, G: 0.65, K: 1.1, M: 1.6, C: 2, N: 2, S: 1.6 };

const text = gunzipSync( await readFile( source ) ).toString( 'latin1' );
const stars = [];
for ( const line of text.split( '\n' ) ) {

	const raH = field( line, 76, 77 ), vmag = field( line, 103, 107 );
	if ( ! raH || ! vmag ) continue;
	const ra = ( Number( raH ) + Number( field( line, 78, 79 ) ) / 60 + Number( field( line, 80, 83 ) ) / 3600 ) * 15;
	const dec = ( field( line, 84, 84 ) === '-' ? - 1 : 1 ) *
		( Number( field( line, 85, 86 ) ) + Number( field( line, 87, 88 ) ) / 60 + Number( field( line, 89, 90 ) ) / 3600 );
	const bvField = field( line, 110, 114 );
	const bv = bvField ? Number( bvField ) : CLASS_BV[ field( line, 128, 147 ).replace( /^[^OBAFGKMCNS]*/, '' )[ 0 ] ] ?? 0.6;
	stars.push( { ra, dec, v: Number( vmag ), color: blackBody( temperature( bv ) ) } );

}
stars.sort( ( a, b ) => a.v - b.v );

const buffer = Buffer.alloc( 8 + stars.length * 8 );
buffer.write( 'BSC5', 0, 'latin1' );
buffer.writeUInt32LE( stars.length, 4 );
stars.forEach( ( star, i ) => {

	const o = 8 + i * 8;
	buffer.writeUInt16LE( Math.round( star.ra / 360 * 65536 ) % 65536, o );
	buffer.writeInt16LE( Math.round( star.dec / 90 * 32767 ), o + 2 );
	buffer.writeUInt8( Math.min( 255, Math.max( 0, Math.round( ( star.v + 2 ) * 20 ) ) ), o + 4 );
	star.color.forEach( ( c, k ) => buffer.writeUInt8( Math.round( c * 255 ), o + 5 + k ) );

} );
await mkdir( dirname( target ), { recursive: true } );
await writeFile( target, buffer );
console.log( `${ target }: ${ stars.length } stars, V ${ stars[ 0 ].v } to ${ stars.at( - 1 ).v }, ${ buffer.length } bytes` );
