// Data shared between the world worker and the main thread.

// a signed distance function (m), optionally with a per-point value baked onto the mesh
export interface SDF {
	( x: number, y: number, z: number ): number;
	tint?: ( x: number, y: number, z: number ) => number;
}

export interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	ao: Float32Array;
	tint: Float32Array;
	curv: Float32Array;
	indices: Uint32Array;
}

export type MeshKind = 'cliff' | 'rock';

export interface NamedMesh extends MeshData { name: string; kind: MeshKind }

export interface Rock { x: number; z: number; s: number; sy: number; y: number; floor: number; rot: number; seed: number }

export interface ShoreField { data: Float32Array; nx: number; nz: number; x0: number; z0: number; cell: number }

export interface WorldData {
	meshes: NamedMesh[];
	rocks: Rock[];
	seabed: { positions: Float32Array; res: number; size: number };
	// turf anchors, 8 floats each: x, y, z, normal x, y, z, rim distance (m, < 0 inside), kind
	// (0 island)
	vegetation: Float32Array;
	shore: ShoreField;
	// Half-resolution island distance field for the local breaking-surf pass.
	islandShore: ShoreField;
	timings: Record<string, number>;
}

export interface WorldOptions {
	islandVoxel?: number;
	seabedRes?: number;
	seabedSize?: number;
	shoreSize?: number;
	shoreCell?: number;
}
