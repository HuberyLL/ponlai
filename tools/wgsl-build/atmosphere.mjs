// tools/wgsl-build.mjs's entry for the atmosphere (src/sky/Atmosphere.ts): its bakes (the
// transmittance and multiple-scattering LUTs, the in-scatter table's two parts), the slices cut
// from the table (the sky row and the fog table, each in two parts), the earth shadow's mean over
// the azimuth, and the sky's radiance toward a fixed direction (`skyRadiance`, drawn as a
// full-screen pass), which reads the sky row and the earth's shadow for both bodies.

import * as THREE from 'three/webgpu';
import { vec3, vec4, normalize } from 'three/tsl';
import { Atmosphere } from '../../src/sky/Atmosphere.ts';

const BAKES = [ 'transmittance', 'multiscat', 'table', 'table-mie', 'sky-row', 'sky-row-mie', 'fog-table', 'fog-table-mie', 'shadow-mean' ];

export default function ( { renderer } ) {

	const atmosphere = new Atmosphere( renderer );
	// (the bakes' quads are private to the module: the entry reads them as the page draws them)
	const shaders = atmosphere.quads.map( ( quad, i ) => [ `atmosphere-${ BAKES[ i ] }`, quad.material ] );
	const sky = new THREE.NodeMaterial();
	sky.name = 'atmosphere-sky';
	sky.fragmentNode = vec4( atmosphere.skyRadiance( normalize( vec3( - 0.3, 0.1, - 1 ) ) ), 1 );
	return [ ...shaders, [ 'atmosphere-sky', sky ] ];

}
