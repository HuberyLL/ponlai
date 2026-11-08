// tools/wgsl-build.mjs's entry for the volumetric clouds (src/sky/Clouds.ts): the deck top's light,
// the panorama's march, the cloud shadow, the closed deck's mean transmittance and the view's trace, high, box and resolve kernels at a 2K view
// (the marching kernels in both builds, without the deck and with it: `-deck` names), and the deck
// noise's two bake kernels (CloudNoise.ts `bakeDeckNoise`: its top level and the mip kernel every
// next level runs), on the page's atmosphere (whose earth shadow the march reads). The shape noise
// is an asset and the bakes run on the GPU: the entry stands in a 1 x 1 x 1 shape and skips every
// dispatch and copy (the renderer here is never initialised), keeping the deck noise's kernels as
// they are handed over, so the kernels build with the page's bindings and code.

import * as THREE from 'three/webgpu';
import { Atmosphere } from '../../src/sky/Atmosphere.ts';
import { Clouds } from '../../src/sky/Clouds.ts';

export default function ( { renderer } ) {

	const bakes = new Map();
	renderer.compute = ( kernel ) => {

		if ( kernel.name?.startsWith( 'Clouds.DeckNoise' ) ) bakes.set( kernel.name, kernel );

	};
	renderer.copyTextureToTexture = () => {};
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
		[ 'clouds-deck-noise', bakes.get( 'Clouds.DeckNoise' ) ], [ 'clouds-deck-noise-mip', bakes.get( 'Clouds.DeckNoiseMip' ) ],
		[ 'clouds-view-trace', trace[ 0 ] ], [ 'clouds-view-trace-deck', trace[ 1 ] ], [ 'clouds-view-high', high ], [ 'clouds-view-box', box ], [ 'clouds-view-resolve', resolve[ 0 ] ],
	];

}
