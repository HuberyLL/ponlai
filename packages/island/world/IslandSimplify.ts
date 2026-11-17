/*! REUSE-IgnoreStart: the meshoptimizer code three bundles, not this file.
 * meshoptimizer (https://github.com/zeux/meshoptimizer), the simplifier three.js ships as
 * examples/jsm/libs/meshopt_simplifier.module.js. Copyright (c) 2016-2026 Arseny Kapoulkine.
 * MIT License: licenses/MIT.txt REUSE-IgnoreEnd */

// The island's chunk mesh simplified in its job (Chunks.ts `buildChunk`), its borders locked.
//
// - Why: surface nets give two triangles per voxel face (0.125 m), so at the island views a
//   triangle covers a pixel or two. The terrain's fragment shader runs per covered sample and per
//   2x2 quad of each triangle, so the island's fixed cost (the part that does not follow the
//   resolution) followed its triangle count, about four times a plant's per triangle. The meadow's
//   plateau, which grows with the island's area while the coast grows with its length, is nearly
//   flat at that scale.
// - How: meshoptimizer's quadric simplifier with attributes (`simplifyWithAttributes`), to an
//   absolute error of ISLAND_SIMPLIFY_ERROR and no target count, flags LockBorder and
//   ErrorAbsolute (not Prune: it would drop the small chips of fallen rock). Collapses only merge
//   a vertex into a neighbour, so the result indexes the original vertices; they are compacted in
//   their original order, every attribute copied bit for bit.
// - The attributes the error measures, with their weights (ATTRIBUTES): the normal (the shading's,
//   from the SDF), the contact AO, the tint, the cliff's detail (scar identity, freshness, strata
//   bed, depth below the column's top) and detail2 (shelter, exposure, pocket), the curvature.
//   An attribute's error is about the position error over its weight: at 1 cm the normal moves
//   about 0.02 (1 degree), the AO 0.02. The normal and the AO bind most. The strata's bed
//   coordinate (detail z) weighs 1 (1.5 % more triangles than 0.1): the material draws a parting
//   line 0.03 wide where it crosses a whole number in a groove (negative curvature), an iso-line
//   of two interpolated attributes. On the close walls those thin lines still change shape where
//   triangles merged; a heavier curvature weight moved them as much, at a sixth more triangles.
// - Measured on seed 1 (tools/island/verify-chunk-derived.mjs prints the drawn and meshed counts): the
//   island keeps about half of its triangles at growth step 0 and two fifths at step 12, where
//   positions alone would keep a sixth; the plateau goes furthest, so the share kept falls as the
//   island grows. The simplifier adds a few hundredths of a second to a chunk's job.
// - The chunk rules (Chunks.ts): a chunk's open border (the edges its neighbour's quads continue)
//   and the open foot of the wall are locked, so every vertex and edge on a border is kept and
//   two chunks still meet bit for bit, with no crack. The simplifier is deterministic,
//   single-threaded wasm: the same mesh gives the same result in node, a browser worker, on any
//   thread. A block meshed in one call (the checks) is split by chunk first and each part
//   simplified on its own, as its chunk is.
// - The curvature and every per-vertex attribute are computed on the full mesh before this runs.
//   What the app derives from the positions (ChunkDerived.ts) is taken from the full mesh too:
//   the simplified plateau's triangles are metres wide, which left the ground's and the caster
//   columns' cells empty where no vertex remained, while the full mesh lies within the error of
//   the drawn one. The refracted map's subsets index the drawn (simplified) triangles.
// - `simplifierReady` resolves once the wasm is compiled: the chunk worker and the node tools
//   await it before their first chunk; `simplifyIslandMesh` throws before then.

import { MeshoptSimplifier } from 'three/examples/jsm/libs/meshopt_simplifier.module.js';
import type { MeshData } from './types.ts';

/** The largest distance (m) the simplified island may lie from the meshed one. */
export const ISLAND_SIMPLIFY_ERROR = 0.01;

// The attributes the simplifier weighs, in this order: normal 3, ao, tint, detail 4, detail2 3, curv
const ATTRIBUTES = 13;
const WEIGHTS = [ 0.5, 0.5, 0.5, 0.5, 0.2, 1, 0.5, 1, 1, 0.5, 0.5, 0.5, 0.05 ];

let ready = false;

/** Resolves once the simplifier can run. (Pure for the bundler: the app's main thread imports
 * Chunks.ts for its grid, and only the worker should carry the wasm.) */
export const simplifierReady: Promise<void> = /* @__PURE__ */ MeshoptSimplifier.ready.then( () => { ready = true; } );

/** The island mesh simplified to ISLAND_SIMPLIFY_ERROR, its border locked: a new MeshData of the
 * vertices it keeps, in their order, and its triangles. */
export function simplifyIslandMesh( mesh: MeshData ): MeshData {

	if ( ! ready ) throw new Error( 'IslandSimplify: await simplifierReady first' );
	const nv = mesh.positions.length / 3;
	if ( mesh.indices.length === 0 ) return mesh;
	const { normals, ao, tint, curv } = mesh;
	const detail = mesh.detail!, detail2 = mesh.detail2!;
	const attributes = new Float32Array( nv * ATTRIBUTES );
	for ( let v = 0; v < nv; v ++ ) {

		const o = v * ATTRIBUTES;
		attributes[ o ] = normals[ v * 3 ]; attributes[ o + 1 ] = normals[ v * 3 + 1 ]; attributes[ o + 2 ] = normals[ v * 3 + 2 ];
		attributes[ o + 3 ] = ao[ v ];
		attributes[ o + 4 ] = tint[ v ];
		for ( let c = 0; c < 4; c ++ ) attributes[ o + 5 + c ] = detail[ v * 4 + c ];
		for ( let c = 0; c < 3; c ++ ) attributes[ o + 9 + c ] = detail2[ v * 3 + c ];
		attributes[ o + 12 ] = curv[ v ];

	}
	const [ kept ] = MeshoptSimplifier.simplifyWithAttributes( mesh.indices, mesh.positions, 3, attributes, ATTRIBUTES, WEIGHTS, null,
		0, ISLAND_SIMPLIFY_ERROR, [ 'LockBorder', 'ErrorAbsolute' ] );
	return compactMesh( mesh, kept );

}

/** The triangles `indices` (of `mesh`'s vertices) as a mesh of the vertices they use, kept in
 * their order with every attribute bit for bit, the indices renumbered. */
export function compactMesh( mesh: MeshData, indices: Uint32Array ): MeshData {

	const nv = mesh.positions.length / 3, remap = new Int32Array( nv ).fill( - 1 );
	for ( let k = 0; k < indices.length; k ++ ) remap[ indices[ k ] ] = 0;
	let count = 0;
	for ( let v = 0; v < nv; v ++ ) if ( remap[ v ] === 0 ) remap[ v ] = count ++;
	const pick = ( source: Float32Array, n: number ) => {

		const out = new Float32Array( count * n );
		for ( let v = 0; v < nv; v ++ ) if ( remap[ v ] >= 0 ) for ( let c = 0; c < n; c ++ ) out[ remap[ v ] * n + c ] = source[ v * n + c ];
		return out;

	};
	const out = new Uint32Array( indices.length );
	for ( let k = 0; k < indices.length; k ++ ) out[ k ] = remap[ indices[ k ] ];
	return {
		positions: pick( mesh.positions, 3 ), normals: pick( mesh.normals, 3 ), ao: pick( mesh.ao, 1 ), tint: pick( mesh.tint, 1 ),
		curv: pick( mesh.curv, 1 ), detail: pick( mesh.detail!, 4 ), detail2: pick( mesh.detail2!, 3 ), indices: out,
	};

}
