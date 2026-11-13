import type * as THREE from 'three/webgpu';
import { tuneObject } from '../../render/index.ts';

// What a closed sky's light turns into in the sward. Under a sun the sward's colour is the key's on
// the blades. Under a closed sky only the ambient lights it, and what reaches the eye of it has
// passed among the blades, through and off several of them, each keeping green and taking red and
// blue: read plainly off the albedo, the sward under cloud stood yellower than under the sun. So the ambient
// diffuse on the blades (vegetation/VegetationLighting.ts) and on the turf under them
// (TerrainMaterial.ts, by the turf's cover) is multiplied by this tint, weighted by the cloud and
// gone by night. The local lights' diffuse, gathered with it (lighting/GroundBounce.ts), takes the
// tint too. It stays near neutral in luminance, and the metering illuminance
// (lighting/MeterLight.ts) leaves it out, so it moves no exposure. One tint for a cloudy and an
// overcast sky.
//
// Read once a frame into shared.ts `swardTint` (main.ts), exactly white under a clear or fair sky.
// Tunable on debug pages (debug/Tune.ts): `lighting.sward.tint.r`, `g`, `b`.
const TINT = tuneObject( { r: 0.5, g: 1.1, b: 0.9 }, { r: 'lighting.sward.tint.r', g: 'lighting.sward.tint.g', b: 'lighting.sward.tint.b' }, {
	r: { min: 0.2, max: 1.2 }, g: { min: 0.8, max: 1.4 }, b: { min: 0.8, max: 1.4 },
} );

/** The sward's tint in `out` for the weather's cloud `clouded` and the night's weight `night`. */
export function updateSwardTint( out: THREE.Vector3, clouded: number, night: number ): void {

	const weight = clouded * ( 1 - night );
	out.set( 1 + ( TINT.r - 1 ) * weight, 1 + ( TINT.g - 1 ) * weight, 1 + ( TINT.b - 1 ) * weight );

}
