// tools/wgsl-build.mjs's entry for the volumetric clouds (src/sky/Clouds.ts): the deck top's light,
// the panorama's march, the cloud shadow and the view's trace, high, box and resolve kernels at a 2K view, on the page's
// atmosphere (whose earth shadow the march reads). The shape noise is an asset and the weather and
// cirrus bakes run on the GPU: the entry stands in a 1 x 1 x 1 shape and skips the bakes' dispatches
// (the renderer here is never initialised), so the kernels build with the page's bindings and code.

import * as THREE from 'three/webgpu';
import { Atmosphere } from '../../src/sky/Atmosphere.ts';
import { Clouds } from '../../src/sky/Clouds.ts';

export default function ( { renderer } ) {

	renderer.compute = () => {};
	renderer.render = () => {};
	renderer.initTexture = () => {};
	const atmosphere = new Atmosphere( renderer );
	const clouds = new Clouds( atmosphere );
	const shape = new THREE.Data3DTexture( new Uint8Array( 4 ), 1, 1, 1 );
	shape.format = THREE.RGBAFormat;
	shape.type = THREE.UnsignedByteType;
	clouds.build( renderer, shape );
	clouds.buildView( 2560, 1440 );
	const { trace, high, box, resolve } = clouds.view.kernels;
	return [
		[ 'clouds-column-top', clouds.columnKernel ], [ 'clouds-panorama', clouds.partialKernel ], [ 'clouds-shadow', clouds.shadowKernel ],
		[ 'clouds-view-trace', trace ], [ 'clouds-view-high', high ], [ 'clouds-view-box', box ], [ 'clouds-view-resolve', resolve[ 0 ] ],
	];

}
