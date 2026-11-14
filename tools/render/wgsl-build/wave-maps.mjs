// tools/render/wgsl-build.mjs's entry for the caustics' splats (packages/render/ocean/WaveMaps.ts): the fine and the
// broad layer's draws at each of their two focal planes, each plane drawn as its grid's two
// halves of triangles (the lower-left and the upper-right of each cell), as the page builds them
// into the wave maps' array target. (The wave maps' own bakes read the shore waves and the world's fields, which the
// page alone builds.)
//
// Stand-ins: an ocean FFT of three cascades whose derivatives are a 1 x 1 array texture.

import * as THREE from 'three/webgpu';
import { WaveMaps } from '../../../packages/render/ocean/WaveMaps.ts';

export default function ( { renderer } ) {

	const derivatives = new THREE.DataArrayTexture( new Uint16Array( 4 * 3 ), 1, 1, 3 );
	derivatives.type = THREE.HalfFloatType;
	derivatives.name = 'derivatives';
	const maps = new WaveMaps( renderer, { cascades: 3, sizes: [ 250, 50, 10 ], derivatives } );
	// in the order CausticLayer adds them: per layer, per plane, the two halves
	const names = [ 'fine', 'broad' ].flatMap( ( layer ) => [ 'shallow', 'deep' ].flatMap( ( plane ) => [ 'lower', 'upper' ].map( ( half ) => `caustics-${ layer }-${ plane }-${ half }` ) ) );
	if ( maps.splats.children.length !== names.length ) throw new Error( `the splats are ${ maps.splats.children.length } draws, the entry names ${ names.length }` );
	return maps.splats.children.map( ( mesh, i ) => [ names[ i ], { material: mesh.material, object: mesh, scene: maps.splats, camera: maps.splatCamera } ] );

}
