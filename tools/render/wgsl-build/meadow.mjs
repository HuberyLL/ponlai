// tools/render/wgsl-build.mjs's entry for the meadow's blades and the displacement field they read
// (packages/island/world/Grass.ts, packages/render/vegetation/Displacement.ts), in the order a frame draws them: the
// field's sprites (the frame graph's first pass), then the near blades and the far ones, built
// from an empty plan (no anchors: the blades' shaders do not depend on the land). Under a
// temporal mode (`--q aa=taa`) the blades also read the field of the frame before.

import { createDisplacementField } from '../../../packages/render/vegetation/Displacement.ts';
import { trailCurve } from '../../../packages/island/world/Trample.ts';
import { GROWTH } from '../../../packages/island/world/IslandGrowth.ts';

export default async function () {

	const shaders = [];
	// As the page makes it: over the land's whole lattice, its sprites aged by the trail's curve.
	// The blades' modules load after the sprites' material is made: three names a storage buffer by
	// its node's id, a count of the nodes made so far, so the shaders' text follows the order the
	// modules make their nodes in.
	const displacementField = createDisplacementField( 2 * GROWTH.half );
	displacementField?.source( trailCurve );
	const { buildGrass, plantGrass } = await import( '../../../packages/island/world/Grass.ts' );
	const { shared } = await import( '../../../packages/render/shared.ts' );
	if ( displacementField ) shaders.push( [ 'displacement-sprite', { material: displacementField.mesh.material, object: displacementField.mesh } ] );
	const grass = buildGrass( plantGrass( new Float32Array( 0 ), { data: new Float32Array( 4 ), nx: 1, nz: 1, x0: 0, z0: 0, cell: 0.1 } ), shared );
	for ( const mesh of grass.children ) shaders.push( [ mesh.name, { material: mesh.material, object: mesh } ] );
	return shaders;

}
