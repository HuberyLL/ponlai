// tools/wgsl-build.mjs's entry for the meadow's blades and the displacement field they read
// (src/world/Grass.ts, src/world/vegetation/Displacement.ts), in the order a frame draws them: the
// field's sprites (the frame graph's first pass), then the near blades and the far ones, built
// from an empty plan (no anchors: the blades' shaders do not depend on the land). Under a
// temporal mode (`--q aa=taa`) the blades also read the field of the frame before.

import { displacementField } from '../../src/world/vegetation/Displacement.ts';
import { buildGrass, plantGrass } from '../../src/world/Grass.ts';
import { shared } from '../../src/shared.ts';

export default function () {

	const shaders = [];
	if ( displacementField ) shaders.push( [ 'displacement-sprite', { material: displacementField.mesh.material, object: displacementField.mesh } ] );
	const grass = buildGrass( plantGrass( new Float32Array( 0 ) ), shared );
	for ( const mesh of grass.children ) shaders.push( [ mesh.name, { material: mesh.material, object: mesh } ] );
	return shaders;

}
