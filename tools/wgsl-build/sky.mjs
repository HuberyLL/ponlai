// tools/wgsl-build.mjs's entry for the sky (packages/render/sky/Sky.ts): the materials that read the clear
// sky (`Atmosphere.skyRadiance`, and so the earth's shadow and its mean over the azimuth). The
// environment's panorama bake and the cloudless sky's irradiance, as the first bake draws them,
// then the dome as the page draws it, fogged by the haze (`fogDome`, VolumetricHaze.ts `skyHaze`),
// with the clouds' view built at 2K, into the scene pass's MRT (Motion.ts `sceneMRT`, which its
// meter output merges into). The moon's maps stand in empty textures. The renderer is never
// initialised: the entry skips the clouds' bakes and their copies, as the clouds' entry does.

import * as THREE from 'three/webgpu';
import { Sky } from '../../packages/render/sky/Sky.ts';
import { createExposure } from '../../packages/render/look/ExposureLook.ts';
import { createDayWindows } from '../../packages/render/look/DayLook.ts';
import { installedLook } from '../../packages/render/look/Look.ts';
import { VolumetricHaze } from '../../packages/render/weather/VolumetricHaze.ts';
import { sceneMRT } from '../../packages/render/post/Motion.ts';
import { buildView } from '../../packages/render/sky/CloudView.ts';

export default function ( { renderer } ) {

	renderer.compute = () => {};
	renderer.render = () => {};
	renderer.initTexture = () => {};
	renderer.copyTextureToTexture = () => {};
	// The moon's maps are assets an image loader reads, which node lacks: they stand in empty, with
	// the page's texture settings.
	const load = THREE.TextureLoader.prototype.load;
	THREE.TextureLoader.prototype.load = () => new THREE.Texture();
	let sky;
	try {

		// the exposure from the look the build installed, as the page's sky stage makes it
		sky = new Sky( renderer, { exposure: createExposure( installedLook() ), dayWindows: createDayWindows( installedLook().day ) } );

	} finally {

		THREE.TextureLoader.prototype.load = load;

	}
	const shape = new THREE.Data3DTexture( new Uint8Array( 4 ), 1, 1, 1 );
	shape.format = THREE.RGBAFormat;
	shape.type = THREE.UnsignedByteType;
	sky.clouds.build( renderer, shape );
	buildView( sky.clouds, 2560, 1440 );
	// (the light kernel never reads the sun's maps, and neither does `skyHaze`)
	const haze = new VolumetricHaze( {}, sky.atmosphere );
	sky.fogDome( ( d, distance ) => haze.skyHaze( d, distance ) );
	// The first bake's publish points the cross-fade's two panoramas at the two endpoints before the
	// dome first draws; three shares one binding between texture nodes of the same texture, so the
	// dome built on the constructor's state would bind one panorama less than the page's.
	sky.panoramaA.value = sky.endpoints[ 0 ].equirect.texture;
	sky.panoramaB.value = sky.endpoints[ 1 ].equirect.texture;
	const camera = new THREE.PerspectiveCamera( 50, 16 / 9, 0.1, 5000 );
	camera.position.set( 0, 40, 60 );
	camera.lookAt( 0, 10, 0 );
	camera.updateMatrixWorld();
	// (the bakes' quads are private to Sky: the entry reads them as the page draws them)
	return [
		[ 'sky-panorama-bake', sky.quad.material ],
		[ 'sky-clear-irradiance', sky.clearIrradianceQuad.material ],
		[ 'sky-dome', { material: sky.dome.material, object: sky.dome, camera, mrt: sceneMRT } ],
	];

}
