// tools/wgsl-build.mjs's entry for the volumetric clouds (src/sky/Clouds.ts): the deck top's light,
// the panorama's march, the cloud shadow, the closed deck's mean transmittance and the view's trace, high, box and resolve kernels at a 2K view
// (the marching kernels in both builds, without the deck and with it: `-deck` names), on the page's
// atmosphere (whose earth shadow the march reads). The shape noise is an asset and the weather and
// streak bakes run on the GPU: the entry stands in a 1 x 1 x 1 shape and skips the bakes' dispatches
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
		[ 'clouds-column-top', clouds.columnKernel ], [ 'clouds-panorama', clouds.panoramaKernels[ 0 ] ], [ 'clouds-panorama-deck', clouds.panoramaKernels[ 1 ] ],
		[ 'clouds-shadow', clouds.shadowKernels[ 0 ] ], [ 'clouds-shadow-deck', clouds.shadowKernels[ 1 ] ],
		[ 'clouds-deck-mean', clouds.deckMeanKernel ], [ 'clouds-deck-mean-sum', clouds.deckMeanSumKernel ],
		[ 'clouds-view-trace', trace[ 0 ] ], [ 'clouds-view-trace-deck', trace[ 1 ] ], [ 'clouds-view-high', high ], [ 'clouds-view-box', box ], [ 'clouds-view-resolve', resolve[ 0 ] ],
	];

}
