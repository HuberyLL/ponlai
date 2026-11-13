// Fixture for ponlai/vegetation-tag (tools/verify-lint.mjs): each line marked `reported` must be
// reported by that rule, and no other line.
import * as THREE from 'three/webgpu';

export const isVegetation = ( m: THREE.Material ): boolean => m.alphaToCoverage === true; // reported
export function coverage( m: THREE.Material ): boolean {

	const { alphaToCoverage } = m; // reported
	return alphaToCoverage;

}
// setting it, and the tag
export function setup( m: THREE.Material ): boolean {

	m.alphaToCoverage = false;
	const n = new THREE.MeshStandardNodeMaterial( { alphaToCoverage: true } );
	return n.userData.vegetation === true;

}
