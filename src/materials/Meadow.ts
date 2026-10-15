import * as THREE from 'three/webgpu';
import { noise3, smoothstep } from '../world/noise.ts';
import { GROWTH } from '../world/IslandGrowth.ts';
export { MEADOW_MIN_UP, MEADOW_MAX_DROP, supportsMeadow } from '../world/MeadowSurface.ts';

// The lawn is one grass colour (docs/art-direction.md): every tuft takes it and the turf under
// the blades shows it too, so the far meadow, where the blades are under a pixel and the turf shows
// between them, reads as one carpet with the near blades. Only a gentle, low-frequency swing of its
// value (+-4 %, drifts some 10 m across) keeps a large lawn from looking printed; the blades' own
// root-to-tip colour (Grass.ts) carries the rest. Separate fields of tone, dryness and hue, and a
// field of bare earth, once broke it into patches that from the overview read as camouflage and
// dark blotches.
// The growth field is the island top's structure for the root bed at the rim (Soil.ts); the lawn
// itself grows to one height (SWARD_HEIGHT). The habitat fields (`meadowMoisture`, `meadowTurf`)
// site the wildflowers' patches.
// The map covers the land lattice's whole extent, wherever the island grows, at 0.25 m: RGB the
// turf's colour (A unused).
export const MEADOW_EXTENT = 2 * GROWTH.half;
const MEADOW_SIZE = MEADOW_EXTENT * 4;

/** The lawn's tuft height scale (m): every tuft of the plateau grows to it, its flower heads
 * among its blades' tips (Grass.ts). */
export const SWARD_HEIGHT = 0.28;

interface MeadowSample { growth: number; tone: number }

// Linear albedo, before the blades' root-to-tip colour: a muted, slightly cool green (red at
// about 0.8 of green on screen, and enough blue that the lit lawn reads soft and green rather than
// lime; the yellow of the lit tips comes from the light through them, Grass.ts).
const LAWN = new THREE.Color( 0.06, 0.1, 0.029 );

export function sampleMeadow( x: number, z: number ): MeadowSample {

	const broad = noise3( x * 0.24 + 2.7, 0.5, z * 0.24 - 1.3 ) * 0.5 + 0.5;
	const clump = noise3( x * 0.65 - 3.1, 2.5, z * 0.65 + 4.8 ) * 0.5 + 0.5;
	const growth = smoothstep( 0.3, 0.7, broad * 0.72 + clump * 0.28 );
	const tone = noise3( x * 0.1 + 11.3, 7.7, z * 0.1 - 4.6 );
	return { growth, tone };

}

// The meadow's habitat: two broad fields of fixed seeds that say where its plants grow, the way a
// real island top's turf and wildflowers follow the ground (Grass.ts sites the flower patches by
// them). Neither changes the lawn's colour or height yet.

/** The ground's moisture under the meadow at ( x, z ), 0 dry to 1 damp: a low-frequency field (its
 * drifts some 25 m across), so the island top has a damp hollow or two and a dry stretch or two. */
export function meadowMoisture( x: number, z: number ): number {

	return smoothstep( - 0.45, 0.45, noise3( x * 0.035 + 21.7, 4.3, z * 0.035 - 13.9 ) );

}

/** The sward at ( x, z ), `rim` m from the land's edge (negative inside, as the anchors carry it):
 * 0 short turf, 1 tall tussocks. A low-frequency field (drifts some 20 m across) with a little of a
 * mid one (5 m) to break its edges, shortened toward the cliff, where the soil is thin and the
 * wind and salt keep the turf low. The blades do not follow it yet; it is meant to set the lawn's
 * height and colour, and decides where the flowers of short turf grow (Grass.ts). */
export function meadowTurf( x: number, z: number, rim: number ): number {

	const broad = noise3( x * 0.05 - 17.2, 9.1, z * 0.05 + 6.4 ), mid = noise3( x * 0.2 + 3.3, 12.7, z * 0.2 - 9.8 );
	return smoothstep( - 0.25, 0.4, broad * 0.8 + mid * 0.3 ) * smoothstep( - 1, - 6, rim );

}

function colorFromSample( sample: MeadowSample, target: THREE.Color ): THREE.Color {

	return target.copy( LAWN ).multiplyScalar( 1 + sample.tone * 0.04 );

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
			data[ k + 3 ] = 255;

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
