import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { createWindUniforms } from './weather/Wind.ts';
import { createTrampleUniforms } from './world/vegetation/Trample.ts';

// Uniforms shared by the water, the terrain and the vegetation (one node each, read by every
// material that uses it).
export const shared = {
	time: uniform( 0 ),
	wind: createWindUniforms(),
	// the islanders' trail through the meadow (world/vegetation/Trample.ts)
	trample: createTrampleUniforms(),
	rain: uniform( 0 ),
	wetness: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// tidewater's clear tropical water (its clarity 1): red is absorbed within a couple of metres,
	// green over some 13 m and blue over about 30 (the e-folding of the absorption), so the sandy
	// shelf reads through the water as bright turquoise and the basin deepens toward blue; a little
	// scattering by suspended particles, more in the blue. Shared with the light under the water
	// (Underwater.ts) for both the sun and view paths (1 / m).
	sigA: uniform( new THREE.Vector3( 0.42, 0.075, 0.035 ) ),
	sigS: uniform( new THREE.Vector3( 0.012, 0.018, 0.024 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	// Storm strength: whitecaps on breaking crests (0 calm).
	storm: uniform( 0 ),
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
	// The live sky reduces hemispherical irradiance on the GPU, so shading never waits for
	// a CPU readback. The uniform above remains a readback diagnostic for explicit snapshots.
	skyFill: uniform( 1 ),
	skyIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
	// The same as lent to the island after sunset (Sky.islandIrradianceNode): the islanders' fill.
	islandIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
};

export type Shared = typeof shared;
