// tools/wgsl-build.mjs's entry for the volumetric haze (src/weather/VolumetricHaze.ts): its light
// kernel (each column of froxels integrated front to back) and the haze the sky dome lays on itself
// (`skyHaze`, drawn as a full-screen pass toward a fixed direction), on the page's atmosphere. The
// light kernel reads the deck's irradiance from the sky's bake (Sky.ts `deckIrradianceNode`, which
// this entry stands in for with a uniform of the same type) and the form of the deck's light from
// the clouds (Clouds.ts `forwardWeight`, `forwardLobe`, `forwardLevel`, `lightDir`, `columnTop`),
// whose uniforms the entry's own clouds hold (their constructor builds no kernel and loads nothing).
// The shadow kernel and the composite need
// the sun's maps, the sky and the frame graph, which this entry does not build; the composite and
// the probe take the same optical depth `skyHaze` does.

import * as THREE from 'three/webgpu';
import { vec3, vec4, normalize, uniform } from 'three/tsl';
import { Atmosphere } from '../../src/sky/Atmosphere.ts';
import { Clouds } from '../../src/sky/Clouds.ts';
import { VolumetricHaze } from '../../src/weather/VolumetricHaze.ts';

export default function ( { renderer } ) {

	const atmosphere = new Atmosphere( renderer );
	// (the light kernel never reads the sun's maps: only the shadow kernel does)
	const haze = new VolumetricHaze( {}, atmosphere );
	const sky = new THREE.NodeMaterial();
	sky.name = 'haze-sky';
	sky.fragmentNode = vec4( haze.skyHaze( normalize( vec3( 0.3, 0.1, - 1 ) ) ).light, 1 );
	return [ [ 'haze-light', haze.buildLightKernel( 0, uniform( new THREE.Vector3() ), new Clouds( atmosphere ) ) ], [ 'haze-sky', sky ] ];

}
