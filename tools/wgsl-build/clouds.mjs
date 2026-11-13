// tools/wgsl-build.mjs's entry for the volumetric clouds (packages/render/sky/Clouds.ts): the light on the
// layer's tops, the panorama's march, the cloud shadow, the closed layer's mean transmittance and
// the view's trace, high, box and resolve kernels at a 2K view, on the page's atmosphere (whose
// earth shadow the march reads). The shape noise is an asset and the bakes run on the GPU: the
// entry stands in a 1 x 1 x 1 shape and skips every dispatch and copy (the renderer here is never
// initialised), so the kernels build with the page's bindings and code.

import * as THREE from 'three/webgpu';
import { Atmosphere } from '../../packages/render/sky/Atmosphere.ts';
import { Clouds } from '../../packages/render/sky/Clouds.ts';
import { buildView } from '../../packages/render/sky/CloudView.ts';

export default function ( { renderer } ) {

	renderer.compute = () => {};
	renderer.copyTextureToTexture = () => {};
	renderer.render = () => {};
	renderer.initTexture = () => {};
	const atmosphere = new Atmosphere( renderer );
	const clouds = new Clouds( atmosphere );
	const shape = new THREE.Data3DTexture( new Uint8Array( 4 ), 1, 1, 1 );
	shape.format = THREE.RGBAFormat;
	shape.type = THREE.UnsignedByteType;
	clouds.build( renderer, shape );
	buildView( clouds, 2560, 1440 );
	const { trace, high, box, resolve } = clouds.view.kernels;
	return [
		[ 'clouds-column-top', clouds.columnKernel ], [ 'clouds-panorama', clouds.panoramaKernel ], [ 'clouds-shadow', clouds.shadowKernel ],
		[ 'clouds-deck-mean', clouds.deckMeanKernel ], [ 'clouds-deck-mean-sum', clouds.deckMeanSumKernel ],
		[ 'clouds-view-trace', trace ], [ 'clouds-view-high', high ], [ 'clouds-view-box', box ], [ 'clouds-view-resolve', resolve[ 0 ] ],
	];

}
