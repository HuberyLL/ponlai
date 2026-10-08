// Data shared between the world worker and the main thread.

// a signed distance function (m), optionally with per-point values baked onto the mesh: one
// float (`tint`), four more (`detail`, written to out[ o .. o + 3 ]) and three more (`detail2`)
export interface SDF {
	( x: number, y: number, z: number ): number;
	tint?: ( x: number, y: number, z: number ) => number;
	detail?: ( x: number, y: number, z: number, out: Float32Array, o: number ) => void;
	detail2?: ( x: number, y: number, z: number, out: Float32Array, o: number ) => void;
	// how much rock a cliff has recently shed above a point of the sea floor (0 .. 1)
	shed?: ( x: number, z: number ) => number;
}

export interface MeshData {
	positions: Float32Array;
	normals: Float32Array;
	ao: Float32Array;
	tint: Float32Array;
	curv: Float32Array;
	// the island's cliff detail (see makeIslandSDF), four and three floats per vertex
	detail?: Float32Array;
	detail2?: Float32Array;
	indices: Uint32Array;
}

export type MeshKind = 'cliff' | 'rock';

export interface NamedMesh extends MeshData { name: string; kind: MeshKind }

export interface Rock { x: number; z: number; s: number; sy: number; y: number; floor: number; rot: number; seed: number }

export interface ShoreField { data: Float32Array; nx: number; nz: number; x0: number; z0: number; cell: number }

export const VEGETATION_STRIDE = 9;
// The turf anchors' jittered grid (m): one anchor per this square of meadow.
export const VEGETATION_SPACING = 0.235;

// RGBA: actual upper-coast distance, local roof height, turf retreat and exposed root depth.
export interface RimGroundField extends ShoreField {}

// A top-rooted branch centreline: x, y, z and the outward surface normal per node. `lip` is the
// node where it crosses the edge. A fork starts on node `from` of strand `parent` (an index into
// the same list) instead of in the turf. `clump`: leaf anchors ( x, y, z, normal ) of the leafy
// mound over the lip at the root of a patch, carried by the patch's first strand.
export interface RimStrand { points: Float32Array; seed: number; lip: number; parent?: number; from?: number; clump?: Float32Array }

// The turf skirt over the rim: SKIRT_RING cross-section points ( x, y, z ) per coast sample,
// per sample ( outward x, z, presence, droop ), and ( first sample, count ) per traced loop.
export interface RimSkirtData { points: Float32Array; info: Float32Array; loops: Int32Array }

export interface WorldData {
	meshes: NamedMesh[];
	rocks: Rock[];
	// bed: seagrass cover and pale-sand share per vertex (see seabedBeds)
	seabed: { positions: Float32Array; ao: Float32Array; bed: Float32Array; res: number; size: number };
	// Turf anchors: x, y, z, normal x, y, z, rim distance (m, < 0 inside), kind
	// (0 island), local sky visibility. Placement still uses the first eight.
	vegetation: Float32Array;
	// Sparse trails that start in top shrubs and overhang the upper cliff.
	rimStrands: RimStrand[];
	rimGround: RimGroundField;
	rimSkirt: RimSkirtData;
	shore: ShoreField;
	// Half-resolution island distance field for the local breaking-surf pass.
	islandShore: ShoreField;
	// The seabed's height (m) over the shoreline field's bounds, at half its resolution.
	seabedField: ShoreField;
	timings: Record<string, number>;
}

export interface WorldOptions {
	islandVoxel?: number;
	seabedRes?: number;
	seabedSize?: number;
	shoreSize?: number;
	shoreCell?: number;
	// Disable only the cross-object contact bake for CPU comparison; geometry stays identical.
	contactOcclusion?: boolean;
}
