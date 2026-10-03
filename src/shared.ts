import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Uniforms shared by the water, the terrain and the vegetation (one node each, read by every
// material that uses it).
export const shared = {
	time: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// water optics: absorption and scattering coefficients (1 / m)
	sigA: uniform( new THREE.Vector3( 0.39, 0.18, 0.125 ) ),
	sigS: uniform( new THREE.Vector3( 0.05, 0.071, 0.078 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
};

export type Shared = typeof shared;
