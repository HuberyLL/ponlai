import * as THREE from 'three/webgpu';
import { makeTerrainMaterial } from '../materials/TerrainMaterial.ts';
import type { DetailTextures } from '../materials/ProceduralTextures.ts';
import type { Caustics } from '../ocean/Caustics.ts';
import type { Shared } from '../shared.ts';
import { ISLAND_TOP } from './WorldShapes.ts';
import type { WorldData, WorldOptions, ShoreField } from './types.ts';

// Generates the world in a worker and turns the result into meshes and the shared shoreline
// texture.

export function generateWorld( options: WorldOptions = {} ): Promise<WorldData> {

	return new Promise( ( resolve, reject ) => {

		const worker = new Worker( new URL( './worldWorker.ts', import.meta.url ), { type: 'module' } );
		worker.onmessage = ( e: MessageEvent<WorldData> ) => { worker.terminate(); resolve( e.data ); };
		worker.onerror = ( e ) => { worker.terminate(); reject( e ); };
		worker.postMessage( options );

	} );

}

export function shoreTextureFrom( shore: ShoreField ): { tex: THREE.DataTexture; xform: THREE.Vector4 } {

	const tex = new THREE.DataTexture( shore.data, shore.nx, shore.nz, THREE.RedFormat, THREE.FloatType );
	tex.minFilter = THREE.LinearFilter;
	tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.needsUpdate = true;
	const xform = new THREE.Vector4( shore.x0, shore.z0, 1 / ( shore.nx * shore.cell ), 1 / ( shore.nz * shore.cell ) );
	return { tex, xform };

}

export function buildWorldMeshes( data: WorldData, tex: DetailTextures, shared: Shared, caustics: Caustics, shore: THREE.Texture ): { group: THREE.Group; triangles: number } {

	const group = new THREE.Group();
	group.name = 'world';
	const cliffMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { topY: ISLAND_TOP } );
	const rockMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { vegetation: false } );
	let triangles = 0;

	for ( const m of data.meshes ) {

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
		geo.setAttribute( 'normal', new THREE.BufferAttribute( m.normals, 3 ) );
		geo.setAttribute( 'ao', new THREE.BufferAttribute( m.ao, 1 ) );
		geo.setAttribute( 'tint', new THREE.BufferAttribute( m.tint, 1 ) );
		geo.setAttribute( 'curv', new THREE.BufferAttribute( m.curv, 1 ) );
		geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
		geo.computeBoundingSphere();
		geo.computeBoundingBox();
		triangles += m.indices.length / 3;

		const mat = m.kind === 'cliff' ? cliffMat : rockMat;

		const mesh = new THREE.Mesh( geo, mat );
		mesh.name = m.name;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		group.add( mesh );

	}

	// seabed
	{

		const { positions, ao, res: n } = data.seabed;
		const idx = new Uint32Array( n * n * 6 );
		for ( let j = 0, k = 0; j < n; j ++ ) for ( let i = 0; i < n; i ++ ) {

			const a = j * ( n + 1 ) + i;
			idx[ k ++ ] = a; idx[ k ++ ] = a + n + 1; idx[ k ++ ] = a + 1;
			idx[ k ++ ] = a + 1; idx[ k ++ ] = a + n + 1; idx[ k ++ ] = a + n + 2;

		}

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( idx, 1 ) );
		geo.computeVertexNormals();
		geo.setAttribute( 'ao', new THREE.BufferAttribute( ao, 1 ) );
		geo.computeBoundingSphere();
		const mesh = new THREE.Mesh( geo, makeTerrainMaterial( 'seabed', tex, shared, caustics, shore ) );
		mesh.name = 'seabed';
		mesh.receiveShadow = true;
		group.add( mesh );
		triangles += idx.length / 3;

	}

	return { group, triangles };

}
