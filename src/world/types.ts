// Data shared between the world's workers (chunkWorker.ts) and the main thread.

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

// RG: the sea floor's seagrass cover and pale-sand share (Bathymetry's seabedBeds).
export interface SeabedBedField extends ShoreField {}

// A top-rooted branch centreline: x, y, z and the outward surface normal per node. `lip` is the
// node where it crosses the edge. A fork starts on node `from` of strand `parent` (an index into
// the same list) instead of in the turf, and takes its parent's leaves. `clump`: leaf anchors
// ( x, y, z, normal ) of the leafy mound over the lip at the root of a patch, carried by the
// patch's first strand. `leaf` (a strand rooted in the turf): its leaves' colour ( r, g, b ) and
// scale, from the nearest rim bush within 3 m, and that bush's distance (Infinity: none).
// `anchor` (a strand rooted in the turf): the anchor cell ( i, j ) of the lip its patch grows at,
// which names the patch even where the cliff left it no leaf mound.
export interface RimStrand {
	points: Float32Array; seed: number; lip: number; parent?: number; from?: number; clump?: Float32Array;
	leaf?: [ number, number, number, number, number ]; anchor?: [ number, number ];
}

// The turf skirt over the rim: SKIRT_RING cross-section points ( x, y, z ) per coast sample and
// their normals, per sample its place on the coast ( x, z ), the outward direction ( x, z ),
// presence and droop (SKIRT_INFO), and ( first sample, count ) per piece: a stretch of the coast
// inside one box, between the points where it crosses the box's border (or a whole loop).
export interface RimSkirtData { points: Float32Array; normals: Float32Array; info: Float32Array; pieces: Int32Array }

// One land version's world, merged from its chunks (ChunkMerge.ts).
export interface WorldData {
	// the grown land (LandLattice.toBytes)
	land: Uint8Array;
	// ci, cj per chunk (Chunks.ts), in the merge's order: rows ( cj, then ci )
	chunks: Int32Array;
	meshes: NamedMesh[];
	rocks: Rock[];
	// The sea floor as one mesh: its near tiles, then the far floor (SeabedTile.ts). ao: contact
	// visibility of the island and stones; bed: seagrass cover and pale-sand share (seabedBeds).
	seabed: { positions: Float32Array; normals: Float32Array; ao: Float32Array; bed: Float32Array; indices: Uint32Array };
	// Turf anchors: x, y, z, normal x, y, z, rim distance (m, < 0 inside), kind
	// (0 island), local sky visibility. Placement still uses the first eight.
	vegetation: Float32Array;
	// The rim bushes (FoliageSites' BUSH_STRIDE floats each).
	bushes: Float32Array;
	// Sparse trails that start in the meadow at the rim and overhang the upper cliff.
	rimStrands: RimStrand[];
	rimGround: RimGroundField;
	rimSkirt: RimSkirtData;
	// The sea-level section's signed distance (m, clamped to +-LAND_REACH) over the land's box and
	// 32 m round it, out to the world's 32 m grid (ChunkMerge.ts fieldBounds).
	shore: ShoreField;
	// The rendered floor's height (m) over the shoreline field's bounds, at half its resolution.
	seabedField: ShoreField;
	// The floor's beds over the same bounds at 0.5 m.
	seabedBeds: SeabedBedField;
	timings: Record<string, number>;
}

export interface WorldOptions {
	// the land: the world's seed and the growth steps taken (IslandGrowth.ts's growLand)
	worldSeed?: number;
	step?: number;
	// Disable only the cross-object contact bake for CPU comparison; geometry stays identical.
	contactOcclusion?: boolean;
}
