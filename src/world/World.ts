import * as THREE from 'three/webgpu';
import { makeTerrainMaterial } from '../materials/TerrainMaterial.ts';
import type { DetailTextures } from '../materials/ProceduralTextures.ts';
import type { Caustics } from '../ocean/Caustics.ts';
import { refractedGroup, showUnderwater } from '../ocean/Refraction.ts';
import type { Shared } from '../shared.ts';
import { ISLAND_TOP } from './WorldShapes.ts';
import type { CasterColumns, GroundGrid, SubmergedSubset } from './ChunkDerived.ts';
import type { IslandChunk, MeshData, WorldData } from './types.ts';
import type { WorldFields } from './WorldFields.ts';

// Turns the merged world (WorldChunks.ts) into meshes (its fields' textures: WorldFields.ts).
//
// - The island is a mesh per land chunk (chunk design, section 8), all under the group 'island',
//   sharing the cliff material and one attribute set, so a chunk added later builds no pipeline.
//   Each is placed in world coordinates (identity matrices: the derived products below are world
//   space) and frustum-culled by its box, which the chunk's ground grid carries (the exact box of
//   the island as meshed, which holds the drawn mesh: the chunk's job simplifies it, its border
//   locked, IslandSimplify.ts): the page walks none of the island's vertices. A grown island (Growth.ts) takes
//   out the changed chunks' meshes and adds theirs (`islandMesh`), kept in the chunks' order
//   ( cj, ci ), and `derive` collects what they carry again.
// - The stones and the sea floor stay one mesh each (ChunkMerge.ts), as every small kind does; a
//   grown island gives them new geometry of the same layout (`stonesGeometry`, `seabedGeometry`).
// - The group 'world' is the water's refraction source's (ocean/Refraction.ts): a ClippingGroup in
//   the refraction's layer alone, every mesh in it shown to that layer too (a land chunk's mesh by
//   `islandMesh`), so that the refraction pass draws them clipped at the sea and every other pass
//   draws them whole.
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

/** The world's meshes, and what its chunks derived from them for their consumers. */
export interface WorldMeshes {
	// 'world': the island, the stones and the sea floor
	group: THREE.Group;
	// 'island': a mesh per land chunk, in the chunks' order
	island: THREE.Group;
	rocks: THREE.Mesh;
	seabed: THREE.Mesh;
	// the island's material, which every land chunk's mesh shares
	cliff: THREE.Material;
	triangles: number;
	columns: Map<THREE.Object3D, CasterColumns>;
	subsets: Map<THREE.Object3D, SubmergedSubset>;
	grounds: GroundGrid[];
}

export function buildWorldMeshes( data: WorldData, tex: DetailTextures, shared: Shared, caustics: Caustics, fields: WorldFields ): WorldMeshes {

	const group = refractedGroup( shared.waterLevel.value );
	group.name = 'world';
	const cliffMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, fields.shore, { topY: ISLAND_TOP, rimGround: fields.rim, rimGroundXform: fields.rimXform } );
	const rockMat = makeTerrainMaterial( 'cliff', tex, shared, caustics, fields.shore, { vegetation: false } );
	const island = new THREE.Group();
	island.name = 'island';
	for ( const part of data.islands ) island.add( islandMesh( part, cliffMat ) );
	group.add( island );

	// The sea floor's stones lie well under the surface, so they cannot shade anything lit
	// through the air; submerged receivers take their shadows from the refracted map.
	// Keeping them out of the sun's map lets it fit the island alone.
	const rocks = new THREE.Mesh( stonesGeometry( data ), rockMat );
	rocks.name = 'rocks';
	rocks.receiveShadow = true;
	showUnderwater( rocks );
	group.add( rocks );

	// the sea floor: its near tiles and the far floor, one mesh (their normals come with them:
	// the floor function's slopes, which agree along every tile's border)
	const seabed = new THREE.Mesh( seabedGeometry( data ), makeTerrainMaterial( 'seabed', tex, shared, caustics, fields.shore ) );
	seabed.name = 'seabed';
	seabed.receiveShadow = true;
	showUnderwater( seabed );
	group.add( seabed );

	const world: WorldMeshes = { group, island, rocks, seabed, cliff: cliffMat, triangles: 0, columns: new Map(), subsets: new Map(), grounds: [] };
	derive( world, data );
	return world;

}

/** A land chunk's mesh (World.ts's rules above: world space, its box from its ground grid), with
 * what its job derived from it in `userData.part`. */
export function islandMesh( part: IslandChunk, material: THREE.Material ): THREE.Mesh {

	const mesh = new THREE.Mesh( islandGeometry( part ), material );
	mesh.name = `island ${ part.ci },${ part.cj }`;
	mesh.castShadow = true;
	mesh.receiveShadow = true;
	mesh.userData.part = part;
	showUnderwater( mesh );
	return mesh;

}

/** The stones' merged mesh; `bounds: false` leaves its bounds to the caller (the growth finds
 * them in steps: Steps.ts boundsSteps). */
export function stonesGeometry( data: WorldData, bounds = true ): THREE.BufferGeometry {

	const geo = meshGeometry( data.stones );
	if ( ! bounds ) return geo;
	geo.computeBoundingSphere();
	geo.computeBoundingBox();
	return geo;

}

/** The sea floor's mesh: the chunks' near tiles and the far floor (`bounds`: as the stones'). */
export function seabedGeometry( data: WorldData, bounds = true ): THREE.BufferGeometry {

	const { positions, normals, ao, bed, indices } = data.seabed;
	const geo = new THREE.BufferGeometry();
	geo.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	geo.setAttribute( 'normal', new THREE.BufferAttribute( normals, 3 ) );
	geo.setIndex( new THREE.BufferAttribute( indices, 1 ) );
	geo.setAttribute( 'ao', new THREE.BufferAttribute( ao, 1 ) );
	geo.setAttribute( 'bed', new THREE.BufferAttribute( bed, 2 ) );
	if ( bounds ) geo.computeBoundingSphere();
	return geo;

}

/** The world's derived products (`columns`, `subsets`, `grounds`, `triangles`) for the meshes it
 * now holds and the version `data` they show: again after a growth step swaps them. */
export function derive( world: WorldMeshes, data: WorldData ): void {

	world.columns.clear();
	world.subsets.clear();
	let triangles = 0;
	for ( const mesh of world.island.children as THREE.Mesh[] ) {

		const part = mesh.userData.part as IslandChunk;
		world.columns.set( mesh, part.columns );
		world.subsets.set( mesh, part.refracted );
		triangles += part.mesh.indices.length / 3;

	}
	world.subsets.set( world.rocks, { level: data.refracted.level, index: data.refracted.stones } );
	world.subsets.set( world.seabed, { level: data.refracted.level, index: data.refracted.seabed } );
	triangles += data.stones.indices.length / 3 + data.seabed.indices.length / 3;
	world.triangles = triangles;
	world.grounds = ( world.island.children as THREE.Mesh[] ).map( ( mesh ) => ( mesh.userData.part as IslandChunk ).ground );

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
