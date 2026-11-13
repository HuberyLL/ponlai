// tools/render/wgsl-build.mjs's entry for the ambient occlusion's passes (packages/render/post/GTAO.ts), in the order
// a frame draws them: the half-resolution view z over the multisampled depth, the slices and the
// blur's two axes. The graph's resources are stand-ins in Pipeline.ts's formats (the sizes reach the shaders
// through uniforms only).

import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { gtaoBlurMaterial, gtaoDepthMaterial, gtaoMaterial } from '../../../packages/render/post/GTAO.ts';

// a graph resource as Pipeline.ts declares it
function resource( name, format, type ) {

	const texture = new THREE.Texture();
	texture.name = name;
	texture.isRenderTargetTexture = true;
	texture.generateMipmaps = false;
	texture.format = format;
	texture.type = type;
	texture.minFilter = texture.magFilter = THREE.NearestFilter;
	return texture;

}

export default function () {

	const depth = new THREE.DepthTexture( 1, 1, THREE.FloatType );
	depth.name = 'sceneDepth';
	const target = new THREE.RenderTarget( 1, 1, { samples: 4, depthTexture: depth } );
	target.texture.name = 'meadowCoverage';
	const gtaoOpaque = resource( 'gtaoOpaque', THREE.RedFormat, THREE.FloatType );
	const gtaoDepth = resource( 'gtaoDepth', THREE.RedFormat, THREE.FloatType );
	const gtaoRaw = resource( 'gtaoRaw', THREE.RGFormat, THREE.HalfFloatType );
	const gtaoBlur = resource( 'gtaoBlur', THREE.RGFormat, THREE.HalfFloatType );
	return [
		[ 'gtao-depth', gtaoDepthMaterial( depth, gtaoOpaque, uniform( new THREE.Matrix4() ) ) ],
		[ 'gtao', gtaoMaterial( gtaoDepth ) ],
		[ 'gtao-blur-x', gtaoBlurMaterial( gtaoRaw, gtaoDepth, 1, 0 ) ],
		[ 'gtao-blur-y', gtaoBlurMaterial( gtaoBlur, gtaoDepth, 0, 1 ) ],
	];

}
