// tools/wgsl-build.mjs's entry for the volumetric haze (src/weather/VolumetricHaze.ts): its light
// kernel (each column of froxels integrated front to back) and the haze the sky dome lays on itself
// (`skyHaze`, drawn as a full-screen pass toward a fixed direction), on the page's atmosphere. The
// shadow kernel and the composite need the sun's maps, the sky and the frame graph, which this
// entry does not build; the composite and the probe take the same optical depth `skyHaze` does.

import * as THREE from 'three/webgpu';
import { vec3, vec4, normalize } from 'three/tsl';
import { Atmosphere } from '../../src/sky/Atmosphere.ts';
import { VolumetricHaze } from '../../src/weather/VolumetricHaze.ts';

export default function ( { renderer } ) {

	const atmosphere = new Atmosphere( renderer );
	// (the light kernel never reads the sun's maps: only the shadow kernel does)
	const haze = new VolumetricHaze( {}, atmosphere );
	const sky = new THREE.NodeMaterial();
	sky.name = 'haze-sky';
	sky.fragmentNode = vec4( haze.skyHaze( normalize( vec3( 0.3, 0.1, - 1 ) ) ).light, 1 );
	return [ [ 'haze-light', haze.buildLightKernel( 0 ) ], [ 'haze-sky', sky ] ];

}
