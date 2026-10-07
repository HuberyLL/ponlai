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
	// Clear teal water: red is absorbed within a few metres, green and blue alike over about
	// 10 m (e-folding of the extinction), so the sandy shelf reads through 2 - 5 m of water as
	// bright teal shallows while the 9 - 15 m basin deepens to a muted teal. Coastal water's
	// faster green and blue absorption veils the shelf and turns the low sun's light grey;
	// tidewater's open ocean, absorbing blue far less than green, would read blue.
	// Red absorbed a little below pure water's mean keeps the shallows from going neon cyan.
	// Low suspended-particle scattering keeps the volume from going milky. Shared with the
	// seabed lighting for both the sun and view paths (1 / m).
	sigA: uniform( new THREE.Vector3( 0.25, 0.08, 0.066 ) ),
	sigS: uniform( new THREE.Vector3( 0.014, 0.024, 0.028 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	// Storm strength: whitecaps on breaking crests (0 calm).
	storm: uniform( 0 ),
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
