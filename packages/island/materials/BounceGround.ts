import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, texture, vec3 } from 'three/tsl';
import type { BounceGround } from '../../render/index.ts';
import { ISLAND_TOP } from '../world/WorldShapes.ts';
import { FLOOR_ALBEDO } from '../world/SeabedTile.ts';
import { LAWN_COLOUR, groundGains } from './Meadow.ts';
import { soilGroveSwell } from './Soil.ts';

// The island's ground as the ground bounce's bake reads it: turf, stone, sand, seagrass, rubble.
//
// The island's ground as the ground bounce's bake reads it (lighting/GroundBounce.ts
// `BounceGround`): the plateau's turf, stone over the rim's last metre and a half; under the sea
// the floor's sand, seagrass over its beds and the cliff foot's rubble, at the gain the floor is
// seen at (SeabedTile.ts FLOOR_ALBEDO); the land's bouncing surface the plateau's top over its
// swells.

/** `beds`: the floor's beds over the world fields' bounds (WorldFields.ts); `soil`: the soil map
 * (Soil.ts), whose swell lifts the plateau. */
export function islandBounceGround( beds: THREE.TextureNode, soil: THREE.Texture ): BounceGround {

	// linear albedos: the plateau's lawn, which times the lawn's gain is the blades' mean, as the
	// probes' bake sees it (AmbientProbes.ts LAWN_TOP), the rim's stone, and the floor's (its means
	// at the gain it is seen at, the sand its `sandGain` on top; the seagrass SeabedLook.ts's mean)
	const LAWN = vec3( ...LAWN_COLOUR ), RIM = vec3( 0.08, 0.075, 0.065 );
	const SAND = vec3( ...FLOOR_ALBEDO.sand ).mul( FLOOR_ALBEDO.gain * FLOOR_ALBEDO.sandGain ), SEAGRASS = vec3( 0.2475, 0.304, 0.124 ).mul( FLOOR_ALBEDO.gain ), RUBBLE = vec3( ...FLOOR_ALBEDO.rubble ).mul( FLOOR_ALBEDO.gain );
	return {
		land: ( { shore } ) => mix( LAWN.mul( groundGains.lawnGain ), RIM, smoothstep( - 1.5, 0, shore ) ),
		floor: ( { at, shore } ) => {

			const bed = texture( beds, at ).level( float( 0 ) ).rg;
			return mix( mix( SAND, SEAGRASS, smoothstep( 0.3, 0.7, bed.x ) ), RUBBLE, smoothstep( 6.5, 0.5, shore ).mul( 0.5 ) );

		},
		height: ( { xz } ) => float( ISLAND_TOP ).add( soilGroveSwell( soil, xz ).swell ),
	};

}
