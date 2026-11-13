// Fixture for ponlai/timestamp-owner (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';
import { resolveTimestamps, takeTimestamps, timestampPools, type TimestampPool } from '../three/Backend.ts';

declare const renderer: THREE.WebGPURenderer;
export const create = () => new THREE.WebGPURenderer( { trackTimestamp: true } ); // reported
export async function readGpu( encoder: unknown, target: object ): Promise<void> {

	await renderer.resolveTimestampsAsync(); // reported
	for ( const pool of timestampPools( renderer, 'mine', () => {} ) ) { // reported

		const { count } = takeTimestamps( pool as TimestampPool ); // reported
		resolveTimestamps( encoder, pool, count, target ); // reported

	}

}
