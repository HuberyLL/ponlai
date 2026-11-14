import * as THREE from 'three/webgpu';
import { float, mix, uniform } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The key's visibility under cloud, for the lit code that has no sky of its own to ask.
//
// The key's visibility under cloud, for the lit code that has no sky of its own to ask. The sky
// (Sky.ts) hands over the clouds' transmittance along the key at a world position (Clouds.ts
// `shadow`, V) and the land's floor under cloud (Sky.ts `keyCloudFloor`: a share of what the cloud
// layer passes down, on the moon's light by night as on the sun's by day). The land's key
// keeps K = mix( floor, 1, V ) (Sky.ts `keyDirectVisibility`, three's sun through
// `installOpenShadow`), and the sea and what lies under it keep K too (Sky.ts `seaKeyVisibility`):
// the sunlight the clouds pass down reaches the sea's surface as it reaches the land, so the water drawn, the seabed seen
// through it and the light under it (lighting/Underwater.ts, through three's sun) are lit by the
// land's key (the air under a deck keeps the deck's floor alone: Sky.ts `deckKeyFloor`).
// - The islanders (characters/CharacterMaterial.ts) read their cast shadow as the ratio of the key
//   their shadow maps let through to the key in the open. Under a deck the open key is the land's
//   K, so a figure under the floor's light reads lit and its cast shadow as a shadow: the open key
//   moves from the sky's key to it by the deck's light (`keyDeckShare`, RenderStages.ts publishLighting:
//   Weather.ts `deckLight`, 0 under a clear or a fair sky, whole under a deck by day).

let keyCloud: ( ( position: V3 ) => F ) | null = null;
let keyFloor: F | null = null;

/** Sets the clouds' transmittance along the key at a world position and the land's floor under a
 * deck (the sky, Sky.ts, once its clouds exist). */
export function setKeyCloud( cloud: ( position: V3 ) => F, floor: F ): void {

	keyCloud = cloud;
	keyFloor = floor;

}

/** The clouds' transmittance along the key and the land's floor, or null before the sky has set
 * them. */
export function keyCloudReaders(): { cloud: ( position: V3 ) => F; floor: F } | null {

	return keyCloud && keyFloor ? { cloud: keyCloud, floor: keyFloor } : null;

}

/** How far the open key on the land is its floor's under a deck: the deck's light (Weather.ts
 * `deckLight`), set per frame by RenderStages.ts publishLighting. */
export const keyDeckShare = uniform( 0 );

/** The land's key visibility at world position `P` (Sky.ts `keyDirectVisibility`): the clouds'
 * own over the land's floor; 1 before the sky has set the clouds. */
export function keyLandVisibility( P: V3 ): F {

	const readers = keyCloudReaders();
	return readers ? mix( readers.floor, float( 1 ), readers.cloud( P ) ) : float( 1 );

}
