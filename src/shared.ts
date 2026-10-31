import * as THREE from 'three/webgpu';
import { float, uniform, vec3 } from 'three/tsl';
import { createWindUniforms } from './weather/Wind.ts';
import { displacementUniforms } from './world/vegetation/Displacement.ts';
import { LAWN_GAIN } from './materials/Meadow.ts';

// Uniforms shared by the water, the terrain and the vegetation (one node each, read by every
// material that uses it).
export const shared = {
	time: uniform( 0 ),
	wind: createWindUniforms(),
	// the displacement field the islanders part the meadow through (world/vegetation/Trample.ts): the
	// base nodes the blades sample it by (world/vegetation/Displacement.ts)
	displacement: displacementUniforms,
	// the meadow's albedo against its lawn colour (materials/Meadow.ts LAWN): the blades', the turf's
	// under them and the ground bounce's over the plateau (GroundBounce.ts); 1 the lawn as LAWN gives
	// it. LAWN_GAIN: the blades' albedo on load (Grass.ts)
	lawnGain: uniform( LAWN_GAIN ),
	// the cliff's albedo above the water against its stone (TerrainMaterial.ts `rock`); 1 the stone as
	// it is. 1.6: the stone at about twice the meadow's albedo (about 0.18); under the water it stays
	// as it is, so the sea's shading keeps its own
	rockGain: uniform( 1.6 ),
	// the trees' leaves' albedo against their atlas (world/vegetation/TreeSurfaces.ts leafMaterial:
	// the bamboo's crowns); 1 the atlas as it is. 0.9: the leaves about 1.2 times the meadow's
	// albedo (about 0.1), so a crown parts from the sward under it under overcast and by night
	leafGain: uniform( 0.9 ),
	rain: uniform( 0 ),
	wetness: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// Clear water with a little plankton and fine sand in it (art direction: teal water, jade over
	// the shallows): red is absorbed within a couple of metres, green and blue over some 14 and 17 m
	// (the e-folding of the absorption), so the sandy shelf reads through the water as a green
	// turquoise and the basin deepens toward teal; a little scattering by suspended particles, most
	// in the green and blue. tidewater's clear tropical water (blue absorbed over 30 m, 0.035, green
	// scattering 0.018) deepened to a saturated navy and turned the shallows blue-cyan; a greener
	// step (blue 0.085, green scattering 0.026) read as a lake beside the meadow. Shared with the
	// light under the water (Underwater.ts) for both the sun and view paths (1 / m).
	sigA: uniform( new THREE.Vector3( 0.42, 0.07, 0.06 ) ),
	sigS: uniform( new THREE.Vector3( 0.012, 0.022, 0.024 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	// Storm strength: whitecaps on breaking crests (0 calm).
	storm: uniform( 0 ),
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
	// The live sky reduces hemispherical irradiance on the GPU, so shading never waits for
	// a CPU readback. The uniform above remains a readback diagnostic for explicit snapshots.
	skyFill: uniform( 1 ),
	skyIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
	// The same as lent to the island after sunset (Sky.islandIrradianceNode): the islanders' fill.
	islandIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
	// log2 of the sky's geometric-mean luminance (Sky.meterLog2Node, scene units): the exposure's
	// sky term, the dome's metering illuminance being this luminance's
	skyMeterLog2: float( 0 ) as THREE.Node<'float'>,
};

export type Shared = typeof shared;
