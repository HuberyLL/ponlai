import * as THREE from 'three/webgpu';
import { uniform, vec3 } from 'three/tsl';
import { createWindUniforms } from './weather/Wind.ts';

// Uniforms shared by the water, the terrain and the vegetation (one node each, read by every
// material that uses it).
export const shared = {
	time: uniform( 0 ),
	wind: createWindUniforms(),
	rain: uniform( 0 ),
	wetness: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// Clear, deeper water: retain coloured absorption while keeping suspended-particle
	// scattering low, so the shelf reads through a volume rather than a milky surface.
	// Coefficients are shared with seabed lighting for both the sun and view paths (1 / m).
	sigA: uniform( new THREE.Vector3( 0.28, 0.12, 0.10 ) ),
	sigS: uniform( new THREE.Vector3( 0.02, 0.03, 0.03 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	// The key's share in mirror-like glints. The art-directed moonlight that keeps the island
	// readable is far brighter than the small disk could reflect; glints keep a faint fraction.
	glintScale: uniform( 1 ),
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
	// The live sky reduces hemispherical irradiance on the GPU, so shading never waits for
	// a CPU readback. The uniform above remains a readback diagnostic for explicit snapshots.
	skyFill: uniform( 1 ),
	skyIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
};

export type Shared = typeof shared;
