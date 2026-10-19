import * as THREE from 'three/webgpu';
import { float, texture3D } from 'three/tsl';

// The grade's look-up tables: colour cubes of LUT_SIZE^3 in display (sRGB-encoded) values, applied
// after the tone curve, two of them blended by a weight (Pipeline.ts `settings.lut`) so a look can
// move between two grades, by the time of day or by place. After Patry, "Real-Time Samurai Cinema"
// (SIGGRAPH 2021): 32^3 sRGB tables, graded in an image editor over a screenshot with the identity
// table embedded. Both start as the identity; their content is ours, tuned in our own scenes.
// - Half float: the identity cube holds its values to 2^-12, so it returns its input within a
//   tenth of a display level (eight-bit texels would round to half a level).
// - Sampled at texel centres (the colour scaled by ( size - 1 ) / size and offset half a texel),
//   trilinear, at level 0: the rain layer grades inside branches, where an implicit level is not
//   allowed.
// - The page samples each table through one base node (`lutNodes`), so a table is swapped by
//   setting its `value` (a table of LUT_SIZE^3): new bind groups, no new pipeline.

export const LUT_SIZE = 32;

/** The identity table: each texel holds its own colour. */
export function identityLut( size = LUT_SIZE ): THREE.Data3DTexture {

	const data = new Uint16Array( size * size * size * 4 );
	const one = THREE.DataUtils.toHalfFloat( 1 );
	for ( let b = 0, i = 0; b < size; b ++ ) for ( let g = 0; g < size; g ++ ) for ( let r = 0; r < size; r ++, i += 4 ) {

		data[ i ] = THREE.DataUtils.toHalfFloat( r / ( size - 1 ) );
		data[ i + 1 ] = THREE.DataUtils.toHalfFloat( g / ( size - 1 ) );
		data[ i + 2 ] = THREE.DataUtils.toHalfFloat( b / ( size - 1 ) );
		data[ i + 3 ] = one;

	}
	const lut = new THREE.Data3DTexture( data, size, size, size );
	lut.format = THREE.RGBAFormat;
	lut.type = THREE.HalfFloatType;
	lut.minFilter = lut.magFilter = THREE.LinearFilter;
	lut.wrapS = lut.wrapT = lut.wrapR = THREE.ClampToEdgeWrapping;
	lut.generateMipmaps = false;
	lut.colorSpace = THREE.NoColorSpace;
	lut.needsUpdate = true;
	return lut;

}

/** The base nodes of the two tables, each the identity until a table is set as its `value`. */
export function lutNodes(): [ THREE.Texture3DNode, THREE.Texture3DNode ] {

	return [ texture3D( identityLut() ), texture3D( identityLut() ) ];

}

/** A display colour ( 0..1 ) through a table's base node, at texel centres and level 0. */
export function sampleLut( lut: THREE.Texture3DNode, c: THREE.Node<'vec3'> ): THREE.Node<'vec3'> {

	const n = LUT_SIZE;
	return ( lut.sample( c.mul( ( n - 1 ) / n ).add( 0.5 / n ) ).level( float( 0 ) ) as unknown as THREE.Node<'vec4'> ).rgb;

}
