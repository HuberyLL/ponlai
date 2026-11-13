// tools/wgsl-build.mjs's entry for the plants that bend from their root in the one wind
// (packages/render/vegetation/Deform.ts): the bamboo's culms and leaves (packages/island/world/BambooMaterials.ts) and
// the yunpeng (packages/island/world/Yunpeng.ts). The bamboo is built as the page builds it, its prototypes
// drawn as instances (packages/render/vegetation/PlantInstances.ts), over one culm and one shoot (the
// shaders do not depend on the sites), its leaves on a stand-in atlas (the painter draws on
// canvases, which node lacks): one draw per material, the culms' whole draws, their fading draws
// and the leaves; the yunpeng is built the same way over one clump, its whole and fading draws.

import * as THREE from 'three/webgpu';
import { Bamboo } from '../../packages/island/world/Bamboo.ts';
import { Yunpeng } from '../../packages/island/world/Yunpeng.ts';
import { shared } from '../../packages/render/shared.ts';

const texture = () => {

	const t = new THREE.DataTexture( new Uint8Array( 4 ), 1, 1 );
	t.needsUpdate = true;
	return t;

};

/** A bamboo over one culm and one shoot (Bamboo.ts), for the entries that build its materials. */
export function standInBamboo( atlas = { map: texture(), alpha: texture(), ids: texture() } ) {

	const culm = { x: 0, y: 0, z: 0, grove: 0.5, height: 7, radius: 0.035, age: 0.5, outX: 1, outZ: 0, lean: 0.05, bow: 0.3, seed: 1 };
	const shoot = { x: 1, y: 0, z: 0, height: 0.4, turn: 0, light: 0.5, seed: 2 };
	return new Bamboo( { culms: [ culm ], shoots: [ shoot ] }, { shared, atlas } );

}

/** The yunpeng over one clump (Yunpeng.ts). */
export function standInYunpeng() {

	return new Yunpeng( [ { x: 0, z: 0, size: 0, seed: 1 } ], shared );

}

/** The first mesh of each of a plant kind's materials (the bamboo's, the yunpeng's), named by its
 * part and draw. */
export function plantDraws( plants ) {

	const seen = new Map();
	for ( const mesh of plants.plants.meshes ) if ( ! seen.has( mesh.material ) ) seen.set( mesh.material, mesh );
	return [ ...seen.values() ].map( ( mesh ) => [ mesh.material.name.replace( / /g, '-' ) + ( mesh.name.endsWith( 'fading' ) ? '-fading' : '' ), mesh ] );

}

export default function () {

	const shaders = [];
	for ( const [ name, mesh ] of plantDraws( standInBamboo() ) ) shaders.push( [ name, { material: mesh.material, object: mesh } ] );
	for ( const [ name, mesh ] of plantDraws( standInYunpeng() ) ) shaders.push( [ name, { material: mesh.material, object: mesh } ] );
	return shaders;

}
