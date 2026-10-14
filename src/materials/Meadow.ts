import * as THREE from 'three/webgpu';
import { noise3, smoothstep } from '../world/noise.ts';
import { GROWTH } from '../world/IslandGrowth.ts';
export { MEADOW_MIN_UP, MEADOW_MAX_DROP, supportsMeadow } from '../world/MeadowSurface.ts';

// Independent fields. Growth sets the sward's structure: tuft height and density (Grass.ts).
// Tone sets the colour. Tying the colour to growth as well made dark albedo and deep canopy shade
// coincide, so ~4 m drifts swung the meadow's luminance about 2x and read as camouflage from the
// overview; separate fields with a ~1.3x albedo swing keep the lawn even, and a finer hue-only
// field (yellow-green against blue-green, about a metre across) carries the variety instead.
// The palette is a soft moss turf: warm yellow-green where the sun reaches it, a deep saturated
// green (little blue, so the shade stays green rather than grey or teal) in the low tones.
//
// Bare earth (`meadowBare`) is a field of its own too: small dark humus patches with ragged edges,
// mostly under a metre across and some 4 % of the meadow (larger or darker ones read as the very
// dark blotches this replaced, in the shade and under an overcast sky), gathered a little toward the
// flower drifts so the earth shows among the plants. Earlier the bare earth followed the growth
// field (soil pockets and humus in the shortest growth), so it came in ~4 m brown drifts that
// coincided with the canopy's shade; one field of its own keeps it small and apart. The turf, the
// tufts (folded over it) and the flowers (kept off it) read this one field.
// The map covers the land lattice's whole extent, wherever the island grows, at 0.25 m: RGB the
// turf's colour, A its bare earth.
export const MEADOW_EXTENT = 2 * GROWTH.half;
const MEADOW_SIZE = MEADOW_EXTENT * 4;

interface MeadowSample { growth: number; tone: number; dry: number; hue: number; variation: number }

const deep = new THREE.Color( 0.022, 0.064, 0.016 );
const mid = new THREE.Color( 0.066, 0.11, 0.024 );
const sunny = new THREE.Color( 0.14, 0.158, 0.036 );
const dryColor = new THREE.Color( 0.18, 0.162, 0.05 );
// Channel weights for the hue shift; each is rescaled to keep the colour's luminance.
const yellowGreen = new THREE.Color( 1.16, 1, 0.7 );
const blueGreen = new THREE.Color( 0.9, 1, 1.08 );

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

// Bare earth in [0, 1]: a spot field under a metre across, its edges broken by a finer one, and
// biased up where the flower drifts gather (Flowers.ts's drift field). The threshold sets the
// share: about 4 % of the ground above 0.5.
export function meadowBare( x: number, z: number ): number {

	const spot = noise3( x * 1.3 - 13.7, 12.4, z * 1.3 + 8.9 );
	const ragged = noise3( x * 2.2 + 4.6, 14.2, z * 2.2 - 11.3 );
	const drift = noise3( x * 0.28 + 11.0, 4.4, z * 0.28 ) * 0.5 + 0.5;
	return smoothstep( 0.31, 0.45, spot * 0.75 + ragged * 0.25 + ( smoothstep( 0.35, 0.72, drift ) - 0.5 ) * 0.15 );

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
			data[ k + 3 ] = Math.round( meadowBare( x, z ) * 255 );

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
