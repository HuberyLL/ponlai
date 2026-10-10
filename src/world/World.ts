import * as THREE from 'three/webgpu';
import { makeTerrainMaterial } from '../materials/TerrainMaterial.ts';
import type { DetailTextures } from '../materials/ProceduralTextures.ts';
import type { Caustics } from '../ocean/Caustics.ts';
import type { Shared } from '../shared.ts';
import { ISLAND_TOP } from './WorldShapes.ts';
import type { WorldData, WorldOptions, ShoreField, RimGroundField, SeabedBedField } from './types.ts';
import type { PageJob, WorldReply } from './worldWorker.ts';
import { WORLD_GENERATOR_HASH } from 'virtual:world-generator';

// Generates the world in a worker and turns the result into meshes and the shared shoreline
// texture.

// The world cache's key (see WorldCache.ts): the hash of every source file the worker imports
// (vite.config.ts's world generator plugin), the options (the land's seed and step always among
// them), a format version, and the browser.
const CACHE_FORMAT = 3;
function worldCacheKey( options: WorldOptions ): string {

	return JSON.stringify( [ CACHE_FORMAT, WORLD_GENERATOR_HASH, { worldSeed: 1, step: 0, ...options }, navigator.userAgent ] );

}

export interface LoadedWorld {
	data: WorldData;
	cache: WorldReply[ 'cache' ];
	// time spent reading the cache (a hit) or handing the world to it (a miss)
	ms: number;
}

// The world, from the cache when it holds one for these options and this generator, else
// generated (then stored). The worker shares the generation with copies of itself (see
// worldWorker.ts); the world it returns is the same as a single thread's, bit for bit.
export function loadWorld( options: WorldOptions = {}, { cache = true } = {} ): Promise<LoadedWorld> {

	return new Promise( ( resolve, reject ) => {

		const worker = new Worker( new URL( './worldWorker.ts', import.meta.url ), { type: 'module' } );
		// The worker closes itself once it has stored the world in the cache.
		worker.onmessage = ( e: MessageEvent<WorldReply> ) => resolve( { data: e.data.world, cache: e.data.cache, ms: e.data.cacheMs } );
		worker.onerror = ( e ) => { worker.terminate(); reject( e ); };
		worker.onmessageerror = () => { worker.terminate(); reject( new Error( 'The world worker\'s reply could not be read' ) ); };
		worker.postMessage( { options, cacheKey: cache ? worldCacheKey( options ) : null } satisfies PageJob );

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

// The floor's beds (seagrass cover, pale-sand share) over the shoreline field's bounds, in half
// floats (filterable everywhere); read through the same transform as the shoreline field.
export function seabedBedTextureFrom( beds: SeabedBedField ): THREE.DataTexture {

	const half = new Uint16Array( beds.data.length );
	for ( let k = 0; k < half.length; k ++ ) half[ k ] = THREE.DataUtils.toHalfFloat( beds.data[ k ] );
	const tex = new THREE.DataTexture( half, beds.nx, beds.nz, THREE.RGFormat, THREE.HalfFloatType );
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	tex.name = 'seabed-beds';
	return tex;

}

function rimGroundTextureFrom( ground: RimGroundField ): { tex: THREE.DataTexture; xform: THREE.Vector4 } {

	const tex = new THREE.DataTexture( ground.data, ground.nx, ground.nz, THREE.RGBAFormat, THREE.FloatType );
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	tex.name = 'rim-root-bed';
	return { tex, xform: new THREE.Vector4( ground.x0, ground.z0, 1 / ( ground.nx * ground.cell ), 1 / ( ground.nz * ground.cell ) ) };

}

export function buildWorldMeshes( data: WorldData, tex: DetailTextures, shared: Shared, caustics: Caustics, shore: THREE.Texture ): { group: THREE.Group; triangles: number } {

	const group = new THREE.Group();
	group.name = 'world';
	const rimGround = rimGroundTextureFrom( data.rimGround );
	const cliffMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { topY: ISLAND_TOP, rimGround: rimGround.tex, rimGroundXform: rimGround.xform } );
	const rockMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { vegetation: false } );
	let triangles = 0;

	for ( const m of data.meshes ) {

		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
		geo.setAttribute( 'normal', new THREE.BufferAttribute( m.normals, 3 ) );
		geo.setAttribute( 'ao', new THREE.BufferAttribute( m.ao, 1 ) );
		geo.setAttribute( 'tint', new THREE.BufferAttribute( m.tint, 1 ) );
		geo.setAttribute( 'curv', new THREE.BufferAttribute( m.curv, 1 ) );
		if ( m.detail ) geo.setAttribute( 'detail', new THREE.BufferAttribute( m.detail, 4 ) );
		if ( m.detail2 ) geo.setAttribute( 'detail2', new THREE.BufferAttribute( m.detail2, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
		geo.computeBoundingSphere();
		geo.computeBoundingBox();
		triangles += m.indices.length / 3;

		const mat = m.kind === 'cliff' ? cliffMat : rockMat;

		const mesh = new THREE.Mesh( geo, mat );
		mesh.name = m.name;
		// The sea floor's stones lie well under the surface, so they cannot shade anything lit
		// through the air; submerged receivers take their shadows from the refracted map.
		// Keeping them out of the sun's map lets it fit the island alone.
		mesh.castShadow = m.kind === 'cliff';
		mesh.receiveShadow = true;
		group.add( mesh );

	}

	// the sea floor: its near tiles and the far floor, one mesh (their normals come with them:
	// the floor function's slopes, which agree along every tile's border)
	{

		const { positions, normals, ao, bed, indices } = data.seabed;
		const geo = new THREE.BufferGeometry();
		geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geo.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
		geo.setIndex( new THREE.BufferAttribute( indices, 1 ) );
		geo.setAttribute( 'ao', new THREE.BufferAttribute( ao, 1 ) );
		geo.setAttribute( 'bed', new THREE.BufferAttribute( bed, 2 ) );
		geo.computeBoundingSphere();
		const mesh = new THREE.Mesh( geo, makeTerrainMaterial( 'seabed', tex, shared, caustics, shore ) );
		mesh.name = 'seabed';
		mesh.receiveShadow = true;
		group.add( mesh );
		triangles += indices.length / 3;

	}

	return { group, triangles };

}
