// tools/wgsl-build.mjs's entry for the falling leaves (src/weather/FallingLeaves.ts): their live
// step and prewarm kernels and their draw, as the page builds them.
//
// Stand-ins: the world's shore field and the soil map as small textures of zeros, the leaf's atlas
// as 1 x 1 textures (painted on canvases in the page), one directional light and no environment.

import * as THREE from 'three/webgpu';
import { texture, vec2 } from 'three/tsl';
import { FallingLeaves } from '../../src/weather/FallingLeaves.ts';
import { Wind } from '../../src/weather/Wind.ts';
import { shared } from '../../src/shared.ts';

export default function () {

	const data = ( name, w, h, array, format = THREE.RGBAFormat, type = THREE.UnsignedByteType ) => {

		const t = new THREE.DataTexture( array, w, h, format, type );
		t.name = name;
		return t;

	};
	const shore = data( 'shore-distance', 2, 2, new Float32Array( 4 ), THREE.RedFormat, THREE.FloatType );
	const soil = new THREE.DataArrayTexture( new Uint8Array( 2 * 2 * 4 * 2 ), 2, 2, 2 );
	soil.name = 'soil';
	const fields = { shore: texture( shore, vec2( 0 ) ) };
	const atlas = { map: data( 'leafMap', 1, 1, new Uint8Array( 4 ) ), alpha: data( 'leafAlpha', 1, 1, new Uint8Array( 4 ) ), ids: data( 'leafIds', 1, 1, new Uint8Array( 4 ) ) };
	const leaves = new FallingLeaves( { shared, fields, soil, wind: new Wind( shared.wind ), atlas } );

	const scene = new THREE.Scene();
	const light = new THREE.DirectionalLight( 0xffffff, 1 );
	light.position.set( 1, 2, 1 );
	scene.add( light );
	const camera = new THREE.PerspectiveCamera();
	return [
		[ 'falling-leaves-step', leaves.kernel ],
		[ 'falling-leaves-prewarm', leaves.prewarm ],
		[ 'falling-leaves', { material: leaves.mesh.material, object: leaves.mesh, scene, camera } ],
	];

}
