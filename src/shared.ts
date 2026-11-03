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
	// it is. 1.6: the stone at about twice the meadow's albedo (about 0.18); under the water it takes
	// 0.7 (TerrainMaterial.ts), so a stone parts from the sand round it
	rockGain: uniform( 1.6 ),
	// the trees' leaves' albedo against their atlas (world/vegetation/TreeSurfaces.ts leafMaterial:
	// the bamboo's crowns); 1 the atlas as it is: the leaves about 1.5 times the meadow's albedo
	// (about 0.12), so a crown parts from the sward under it under overcast and by night
	leafGain: uniform( 1 ),
	// the weather's share of a cloudy or overcast sky: 0 under a clear or fair one, 1 under a closed one
	clouded: uniform( 0 ),
	// the sky's light in the water body under a deck, over the bake's (sky/Weather.ts `deckSkyGain`)
	deckSky: uniform( 1 ),
	// the part of `deckSky` a cloudy deck's gaps take back, by the clouds' visibility over the water
	// (sky/Weather.ts `deckSkyGap`): in a gap the water takes the key itself
	deckSkyGap: uniform( 0 ),
	// what the sward's ambient diffuse is multiplied by (materials/SwardTint.ts); white under a clear
	// or fair sky
	swardTint: uniform( new THREE.Vector3( 1, 1, 1 ) ),
	rain: uniform( 0 ),
	wetness: uniform( 0 ),
	waterLevel: uniform( 0 ),
	// Clear temperate water with a little plankton and fine sand in it: red is absorbed over some
	// 9 m, green and blue over some 16 and 13.5 m (the e-folding of the absorption), so the floor
	// reads through the shallows near its own colour, with no bright rim, and the deep water holds a
	// grey green-blue; a little scattering by suspended particles, near grey and most in the blue,
	// which keeps the open sea slate rather than teal. Shared with the light under the water
	// (Underwater.ts) for both the sun and view paths (1 / m).
	sigA: uniform( new THREE.Vector3( 0.108, 0.062, 0.074 ) ),
	sigS: uniform( new THREE.Vector3( 0.027, 0.0236, 0.033 ) ),
	sunIntoWater: uniform( 1 ), // 1 - Fresnel of the sun at the surface
	// Storm strength: whitecaps on breaking crests (0 calm).
	storm: uniform( 0 ),
	muSun: uniform( 1 ), // cosine of the refracted sun below the surface
	shoreXform: uniform( new THREE.Vector4() ), // x0, z0, 1 / width, 1 / depth of the shoreline field
	sunDir: uniform( new THREE.Vector3( 0, 1, 0 ) ),
	sunColor: uniform( new THREE.Vector3() ), // linear rgb
	// the key on the land (main.ts publishLighting): sunColor's in every weather, the clouds' shadow
	// cutting it per point where it is read
	landKey: uniform( new THREE.Vector3() ),
	skyIrradiance: uniform( new THREE.Vector3() ), // linear rgb
	// The live sky reduces hemispherical irradiance on the GPU, so shading never waits for
	// a CPU readback. The uniform above remains a readback diagnostic for explicit snapshots.
	skyFill: uniform( 1 ),
	// a low sun's lift of the sky's light on what it lights: the land's ambient, the sky's light in
	// the water (`skyIrradianceSource`) and the sea's reflection of the sky, never the sky drawn or
	// its meter (lighting/AmbientRelight.ts `lowSunSkyLift`); 1 from its top up and under cloud.
	// Whatever else reads `skyIrradianceSource` takes it too: the rain's light (main.ts
	// `rain.setLightNode`), the storm's spray (StormSea's `sky`) and its whitecaps (ocean/Water.ts).
	// Those draw only under rain and storm, which count as overcast (1), so only through a front from
	// a clear or fair sky into them under a low sun, by the share of the clear sky left
	skyLift: uniform( 1 ),
	skyIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
	// The same as lent to the island after sunset (Sky.islandIrradianceNode): the islanders' fill.
	islandIrradianceSource: vec3( 0 ) as THREE.Node<'vec3'>,
	// log2 of the sky's geometric-mean luminance (Sky.meterLog2Node, scene units): the exposure's
	// sky term, the dome's metering illuminance being this luminance's
	skyMeterLog2: float( 0 ) as THREE.Node<'float'>,
};

export type Shared = typeof shared;
