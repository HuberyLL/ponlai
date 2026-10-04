import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { sampleMeadow } from './Meadow.ts';
import { ISLAND_TOP, islandSurfaceHeight } from '../world/WorldShapes.ts';
import { noise3, smoothstep } from '../world/noise.ts';

// The narrow height encoding retains millimetre precision in an inexpensive RGBA8 map.
// Thickness and exposed patches vary independently, so the root bed never becomes a belt.
export const SOIL_EXTENT = 128;
export const SOIL_HEIGHT_RANGE = 0.5;
const SOIL_SIZE = 512;

export const soilUniforms = {
	strength: uniform( 1 ),
	depth: uniform( 1 ),
};

const pack = ( value: number ) => Math.round( Math.min( 1, Math.max( 0, value ) ) * 255 );

export function createSoilTexture(): THREE.DataTexture {

	const data = new Uint8Array( SOIL_SIZE * SOIL_SIZE * 4 );
	for ( let row = 0; row < SOIL_SIZE; row ++ ) {

		const z = ( ( row + 0.5 ) / SOIL_SIZE - 0.5 ) * SOIL_EXTENT;
		for ( let column = 0; column < SOIL_SIZE; column ++ ) {

			const x = ( ( column + 0.5 ) / SOIL_SIZE - 0.5 ) * SOIL_EXTENT;
			const meadow = sampleMeadow( x, z );
			const broad = noise3( x * 0.27 + 3.8, 8.7, z * 0.27 - 2.1 ) * 0.5 + 0.5;
			const pocket = noise3( x * 0.61 - 6.2, 3.4, z * 0.61 + 7.1 ) * 0.5 + 0.5;
			const depth = noise3( x * 0.19 - 2.6, 5.8, z * 0.19 + 9.3 ) * 0.5 + 0.5;
			// Broad patches expose only part of the rim. Short growth increases their strength
			// after the patch gate, so a short meadow patch is not automatically bare soil.
			const exposure = smoothstep( 0.51, 0.68, broad * 0.72 + pocket * 0.28 ) * ( 0.3 + ( 1 - meadow.growth ) * 0.7 );
			const thickness = smoothstep( 0.23, 0.72, depth * 0.7 + meadow.growth * 0.3 );
			// The quarter-metre grid supports colour drifts; grain comes from the existing
			// terrain detail maps so this field does not bake sub-texel freckles into the lip.
			const variation = noise3( x * 1.05 + 8.6, 1.7, z * 1.05 - 5.3 ) * 0.5 + 0.5;
			const k = ( row * SOIL_SIZE + column ) * 4;
			data[ k ] = pack( ( islandSurfaceHeight( x, z ) - ISLAND_TOP ) / SOIL_HEIGHT_RANGE + 0.5 );
			data[ k + 1 ] = pack( thickness );
			data[ k + 2 ] = pack( exposure );
			data[ k + 3 ] = pack( variation );

		}

	}

	const texture = new THREE.DataTexture( data, SOIL_SIZE, SOIL_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType );
	texture.colorSpace = THREE.NoColorSpace;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	// Height mip averages could smear a root band across neighbouring rock shoulders.
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	texture.name = 'soil-support';
	return texture;

}
