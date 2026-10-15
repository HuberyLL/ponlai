// The part of meshoptimizer's simplifier (three's copy, examples/jsm/libs) that IslandSimplify.ts
// uses: @types/three declares no types for it.
declare module 'three/examples/jsm/libs/meshopt_simplifier.module.js' {

	type Flag = 'LockBorder' | 'Sparse' | 'ErrorAbsolute' | 'Prune' | 'Regularize' | 'Permissive' | 'RegularizeLight';

	export const MeshoptSimplifier: {
		ready: Promise<void>;
		simplifyWithAttributes(
			indices: Uint32Array, positions: Float32Array, positionStride: number,
			attributes: Float32Array, attributeStride: number, weights: number[], lock: Uint8Array | null,
			targetIndexCount: number, targetError: number, flags?: Flag[]
		): [ Uint32Array, number ];
	};

}
