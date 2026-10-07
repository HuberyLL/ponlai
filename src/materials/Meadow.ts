import * as THREE from 'three/webgpu';
import { noise3, smoothstep } from '../world/noise.ts';
export { MEADOW_MIN_UP, MEADOW_MAX_DROP, supportsMeadow } from '../world/MeadowSurface.ts';

// Two independent fields. Growth sets the sward's structure: tuft height (and with it the canopy
// that shades the meadow, see MeadowCanopy), soil pockets and the humus between short shoots.
// Tone sets the colour. Tying the colour to growth as well made dark albedo and deep canopy shade
// coincide, so ~4 m drifts swung the meadow's luminance about 2x and read as camouflage from the
// overview; separate fields with a ~1.3x albedo swing keep the lawn even, and a finer hue-only
// field (yellow-green against blue-green, about a metre across) carries the variety instead.
export const MEADOW_EXTENT = 128;
const MEADOW_SIZE = 512;

interface MeadowSample { growth: number; tone: number; dry: number; hue: number; variation: number }

const deep = new THREE.Color( 0.024, 0.062, 0.028 );
const mid = new THREE.Color( 0.062, 0.108, 0.03 );
const sunny = new THREE.Color( 0.13, 0.157, 0.044 );
const dryColor = new THREE.Color( 0.18, 0.162, 0.054 );
// Channel weights for the hue shift; each is rescaled to keep the colour's luminance.
const yellowGreen = new THREE.Color( 1.16, 1, 0.7 );
const blueGreen = new THREE.Color( 0.88, 1, 1.2 );

export function sampleMeadow( x: number, z: number ): MeadowSample {

	const broad = noise3( x * 0.24 + 2.7, 0.5, z * 0.24 - 1.3 ) * 0.5 + 0.5;
	const clump = noise3( x * 0.65 - 3.1, 2.5, z * 0.65 + 4.8 ) * 0.5 + 0.5;
	const growth = smoothstep( 0.3, 0.7, broad * 0.72 + clump * 0.28 );
	const variation = noise3( x * 1.1 + 5.4, 4.1, z * 1.1 - 7.2 ) * 0.5 + 0.5;
	const warm = noise3( x * 0.18 - 8.2, 6.3, z * 0.18 + 3.7 ) * 0.5 + 0.5;
	const lush = noise3( x * 0.22 + 11.3, 7.7, z * 0.22 - 4.6 ) * 0.5 + 0.5;
	const patch = noise3( x * 0.55 - 6.9, 9.1, z * 0.55 + 2.2 ) * 0.5 + 0.5;
	const tone = smoothstep( 0.3, 0.7, lush * 0.7 + patch * 0.3 );
	// Dry colour follows the paler tone in coherent drifts, rather than isolated straw tufts.
	const dry = ( 1 - tone ) * smoothstep( 0.38, 0.72, warm );
	const hue = smoothstep( 0.25, 0.75, ( noise3( x * 0.8 - 1.7, 3.3, z * 0.8 + 6.1 ) * 0.65 + noise3( x * 1.35 + 9.4, 5.9, z * 1.35 - 2.8 ) * 0.35 ) * 0.5 + 0.5 );
	return { growth, tone, dry, hue, variation };

}

const shift = new THREE.Color();
const luminance = ( c: THREE.Color ) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

function colorFromSample( sample: MeadowSample, target: THREE.Color ): THREE.Color {

	// Small pulls keep the albedo within about 1.3x across the drifts, at the old mean.
	target.copy( mid ).lerp( deep, sample.tone * 0.15 );
	target.lerp( sunny, ( 1 - sample.tone ) * 0.3 );
	target.lerp( dryColor, sample.dry * 0.2 );
	const l = luminance( target );
	target.multiply( shift.copy( blueGreen ).lerp( yellowGreen, sample.hue ) );
	target.multiplyScalar( l / luminance( target ) );
	// Small, continuous variation retains a quiet grass bed beneath the readable blades.
	return target.multiplyScalar( 0.92 + sample.variation * 0.16 );

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
