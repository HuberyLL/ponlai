import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';

// Uniforms shared by the water, the terrain and the vegetation (one node each, read by every
// material that uses it).
export const shared = {
	time: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// water optics: absorption and scattering coefficients (1 / m)
	sigA: uniform( new THREE.Vector3( 0.4, 0.15, 0.09 ) ),
	sigS: uniform( new THREE.Vector3( 0.07, 0.088, 0.105 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
};

export type Shared = typeof shared;
