// Fixture for ponlai/chunk-normals (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';

export function chunkGeometry( positions: Float32Array ): THREE.BufferGeometry {

	const g = new THREE.BufferGeometry();
	g.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
	g.computeVertexNormals(); // reported
	return g;

}
