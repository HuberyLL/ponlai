import * as THREE from 'three/webgpu';
import { makeTerrainMaterial } from '../materials/TerrainMaterial.ts';
import type { DetailTextures } from '../materials/ProceduralTextures.ts';
import type { Caustics } from '../ocean/Caustics.ts';
import type { Shared } from '../shared.ts';
import { ISLAND_TOP } from './WorldShapes.ts';
import type { CasterColumns, GroundGrid, SubmergedSubset } from './ChunkDerived.ts';
import type { IslandChunk, MeshData, WorldData, ShoreField, RimGroundField, SeabedBedField } from './types.ts';

// Turns the merged world (WorldChunks.ts) into meshes and the textures of its fields.
//
// - The island is a mesh per land chunk (chunk design, section 8), all under the group 'island',
//   sharing the cliff material and one attribute set, so a chunk added later builds no pipeline.
//   Each is placed in world coordinates (identity matrices: the derived products below are world
//   space) and frustum-culled by its box, which the chunk's ground grid carries (the exact box of
//   its vertices): the page walks none of the island's vertices.
// - The stones and the sea floor stay one mesh each (ChunkMerge.ts), as every small kind does.
// - What the chunks' jobs derived from the meshes comes back with them, keyed for its consumers:
//   the island parts' caster columns (SunShadow.setCasters), the triangle subsets of the island
//   parts, the stones and the floor (RefractedSun.setCasters) and the ground grids
//   (IslandGround.fromGrids, the camera's).
// - The parts' triangles and vertices are the merged mesh's, bit for bit, and their depth is the
//   same, but about 1 % of the island's pixels shade a level or two apart from one merged draw:
//   the GPU forms its multisampled fragments and its derivatives' pixel quads within a draw, so
//   splitting the same triangles over several draws (even as draw ranges of one buffer, in the
//   same order) moves results at some partly covered pixels. Byte comparisons hold between pages
//   that split the island alike; a paused frame repeats, since the split follows the chunks.

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

// The rim ground (RimGround.ts: the chunks' tiles, assembled by ChunkMerge.ts) in half floats: filterable
// everywhere and half the memory of floats as the land grows; its distance is clamped to 1.5 m, so
// they keep it to a millimetre.
function rimGroundTextureFrom( ground: RimGroundField ): { tex: THREE.DataTexture; xform: THREE.Vector4 } {

	const half = new Uint16Array( ground.data.length );
	for ( let k = 0; k < half.length; k ++ ) half[ k ] = THREE.DataUtils.toHalfFloat( ground.data[ k ] );
	const tex = new THREE.DataTexture( half, ground.nx, ground.nz, THREE.RGBAFormat, THREE.HalfFloatType );
	tex.minFilter = tex.magFilter = THREE.LinearFilter;
	tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.needsUpdate = true;
	tex.name = 'rim-root-bed';
	return { tex, xform: new THREE.Vector4( ground.x0, ground.z0, 1 / ( ground.nx * ground.cell ), 1 / ( ground.nz * ground.cell ) ) };

}

/** The world's meshes, and what its chunks derived from them for their consumers. */
export interface WorldMeshes {
	// 'world': the island, the stones and the sea floor
	group: THREE.Group;
	// 'island': a mesh per land chunk, in the chunks' order
	island: THREE.Group;
	triangles: number;
	columns: Map<THREE.Object3D, CasterColumns>;
	subsets: Map<THREE.Object3D, SubmergedSubset>;
	grounds: GroundGrid[];
}

export function buildWorldMeshes( data: WorldData, tex: DetailTextures, shared: Shared, caustics: Caustics, shore: THREE.Texture ): WorldMeshes {

	const group = new THREE.Group();
	group.name = 'world';
	const rimGround = rimGroundTextureFrom( data.rimGround );
	const cliffMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { topY: ISLAND_TOP, rimGround: rimGround.tex, rimGroundXform: rimGround.xform } );
	const rockMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, shore, { vegetation: false } );
	const columns = new Map<THREE.Object3D, CasterColumns>(), subsets = new Map<THREE.Object3D, SubmergedSubset>();
	let triangles = 0;

	const island = new THREE.Group();
	island.name = 'island';
	for ( const part of data.islands ) {

		const mesh = new THREE.Mesh( islandGeometry( part ), cliffMat );
		mesh.name = `island ${ part.ci },${ part.cj }`;
		mesh.castShadow = true;
		mesh.receiveShadow = true;
		island.add( mesh );
		columns.set( mesh, part.columns );
		subsets.set( mesh, part.refracted );
		triangles += part.mesh.indices.length / 3;

	}
	group.add( island );

	// The sea floor's stones lie well under the surface, so they cannot shade anything lit
	// through the air; submerged receivers take their shadows from the refracted map.
	// Keeping them out of the sun's map lets it fit the island alone.
	{

		const geo = meshGeometry( data.stones );
		geo.computeBoundingSphere();
		geo.computeBoundingBox();
		const mesh = new THREE.Mesh( geo, rockMat );
		mesh.name = 'rocks';
		mesh.receiveShadow = true;
		group.add( mesh );
		subsets.set( mesh, { level: data.refracted.level, index: data.refracted.stones } );
		triangles += data.stones.indices.length / 3;

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
		subsets.set( mesh, { level: data.refracted.level, index: data.refracted.seabed } );
		triangles += indices.length / 3;

	}

	return { group, island, triangles, columns, subsets, grounds: data.islands.map( ( part ) => part.ground ) };

}

// A mesh's attributes, as the cliff material reads them (`detail` and `detail2`: the island's).
function meshGeometry( m: MeshData ): THREE.BufferGeometry {

	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( m.positions, 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( m.normals, 3 ) );
	geo.setAttribute( 'ao', new THREE.BufferAttribute( m.ao, 1 ) );
	geo.setAttribute( 'tint', new THREE.BufferAttribute( m.tint, 1 ) );
	geo.setAttribute( 'curv', new THREE.BufferAttribute( m.curv, 1 ) );
	if ( m.detail ) geo.setAttribute( 'detail', new THREE.BufferAttribute( m.detail, 4 ) );
	if ( m.detail2 ) geo.setAttribute( 'detail2', new THREE.BufferAttribute( m.detail2, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( m.indices, 1 ) );
	return geo;

}

// An island part's geometry, its bounds from its ground grid's box (the exact box of its
// vertices, as computeBoundingBox finds it) and the sphere round that box.
function islandGeometry( part: IslandChunk ): THREE.BufferGeometry {

	const geo = meshGeometry( part.mesh );
	const [ x0, y0, z0, x1, y1, z1 ] = part.ground.bounds;
	geo.boundingBox = new THREE.Box3( new THREE.Vector3( x0, y0, z0 ), new THREE.Vector3( x1, y1, z1 ) );
	geo.boundingSphere = geo.boundingBox.getBoundingSphere( new THREE.Sphere() );
	return geo;

}
