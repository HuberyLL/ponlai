import * as THREE from 'three/webgpu';
import { noise3, smoothstep } from '../world/noise.ts';
import { ISLAND_TOP } from '../world/WorldShapes.ts';

// The blades and the ground share one growth field, so tall tufts belong to the same
// cool-green drifts as their roots instead of floating over unrelated painted patches.
export const MEADOW_EXTENT = 128;
export const MEADOW_MIN_UP = 0.85;
export const MEADOW_MAX_DROP = 0.3;

// The permissive worker rays also hit battered cliff faces. Keep their sampling order for
// stable meadow randomness, then draw plants only on the shallow top and its upper shoulder.
export function supportsMeadow( y: number, up: number ): boolean {

	return y >= ISLAND_TOP - MEADOW_MAX_DROP && up >= MEADOW_MIN_UP;

}
const MEADOW_SIZE = 512;

interface MeadowSample { growth: number; dry: number; variation: number }

const deep = new THREE.Color( 0.024, 0.062, 0.028 );
const mid = new THREE.Color( 0.062, 0.108, 0.03 );
const sunny = new THREE.Color( 0.13, 0.157, 0.044 );
const dryColor = new THREE.Color( 0.18, 0.162, 0.054 );

export function sampleMeadow( x: number, z: number ): MeadowSample {

	const broad = noise3( x * 0.24 + 2.7, 0.5, z * 0.24 - 1.3 ) * 0.5 + 0.5;
	const clump = noise3( x * 0.65 - 3.1, 2.5, z * 0.65 + 4.8 ) * 0.5 + 0.5;
	const growth = smoothstep( 0.3, 0.7, broad * 0.72 + clump * 0.28 );
	const variation = noise3( x * 1.1 + 5.4, 4.1, z * 1.1 - 7.2 ) * 0.5 + 0.5;
	const warm = noise3( x * 0.18 - 8.2, 6.3, z * 0.18 + 3.7 ) * 0.5 + 0.5;
	// Dry colour follows shorter growth in coherent drifts, rather than isolated straw tufts.
	const dry = ( 1 - growth ) * smoothstep( 0.38, 0.72, warm );
	return { growth, dry, variation };

}

function colorFromSample( sample: MeadowSample, target: THREE.Color ): THREE.Color {

	target.copy( mid ).lerp( deep, sample.growth * 0.68 );
	target.lerp( sunny, ( 1 - sample.growth ) * 0.55 );
	target.lerp( dryColor, sample.dry * 0.5 );
	// Small, continuous variation retains a quiet grass bed beneath the readable blades.
	return target.multiplyScalar( 0.9 + sample.variation * 0.2 );

}

export function meadowColor( x: number, z: number, target: THREE.Color ): THREE.Color {

	return colorFromSample( sampleMeadow( x, z ), target );

}

export function createMeadowTexture(): THREE.DataTexture {

	const data = new Uint8Array( MEADOW_SIZE * MEADOW_SIZE * 4 );
	const color = new THREE.Color();
	for ( let row = 0; row < MEADOW_SIZE; row ++ ) {

		const z = ( ( row + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
		for ( let column = 0; column < MEADOW_SIZE; column ++ ) {

			// Bake texel centres so xz / MEADOW_EXTENT + 0.5 agrees with CPU instance colours.
			const x = ( ( column + 0.5 ) / MEADOW_SIZE - 0.5 ) * MEADOW_EXTENT;
			const sample = sampleMeadow( x, z );
			colorFromSample( sample, color );
			const k = ( row * MEADOW_SIZE + column ) * 4;
			data[ k ] = Math.round( color.r * 255 );
			data[ k + 1 ] = Math.round( color.g * 255 );
			data[ k + 2 ] = Math.round( color.b * 255 );
			data[ k + 3 ] = Math.round( sample.growth * 255 );

		}

	}

	const texture = new THREE.DataTexture( data, MEADOW_SIZE, MEADOW_SIZE, THREE.RGBAFormat, THREE.UnsignedByteType );
	// Values are already linear; conversion would separate the turf from its blade colours.
	texture.colorSpace = THREE.NoColorSpace;
	texture.magFilter = THREE.LinearFilter;
	texture.minFilter = THREE.LinearFilter;
	texture.wrapS = THREE.ClampToEdgeWrapping;
	texture.wrapT = THREE.ClampToEdgeWrapping;
	texture.generateMipmaps = false;
	texture.needsUpdate = true;
	texture.name = 'meadow';
	return texture;

}
