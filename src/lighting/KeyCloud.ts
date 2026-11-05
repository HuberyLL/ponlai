import * as THREE from 'three/webgpu';
import { float, mix, select, uniform } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The key's visibility under cloud, for the lit code that has no sky of its own to ask. The sky
// (Sky.ts) hands over the clouds' transmittance along the key at a world position (Clouds.ts
// `shadow`, V) and the land's floor under a deck (Sky.ts `keyCloudFloor`, the weather's `deckFloor`
// once a deck has taken over, faded with the key's sun share by night). The land's key keeps
// K = mix( floor, 1, V ) (Sky.ts `keyDirectVisibility`, three's sun through `installOpenShadow`);
// the sea, what lies under it and the air keep V alone, so the water drawn, the seabed seen through
// it and the light under it are lit by the same key.
// - The islanders (characters/CharacterMaterial.ts) read their cast shadow as the ratio of the key
//   their shadow maps let through to the key in the open. Under a deck the open key is the land's
//   K, so a figure under the floor's light reads lit and its cast shadow as a shadow: the open key
//   moves from the sky's key to it by the deck's light (`keyDeckShare`, main.ts publishLighting:
//   Weather.ts `deckLight`, 0 under a clear or a fair sky, whole under a deck by day).
// - Under the water (lighting/Underwater.ts) the refracted key takes V in place of K
//   (`keySeaShare`), so a submerged point keeps the sea's own visibility while the wet rock a trough
//   bares keeps the land's.

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
 * `deckLight`), set per frame by main.ts publishLighting. */
export const keyDeckShare = uniform( 0 );

/** The land's key visibility at world position `P` (Sky.ts `keyDirectVisibility`): the clouds'
 * own over the land's floor; 1 before the sky has set the clouds. */
export function keyLandVisibility( P: V3 ): F {

	const readers = keyCloudReaders();
	return readers ? mix( readers.floor, float( 1 ), readers.cloud( P ) ) : float( 1 );

}

/** The share of the land's key visibility the sea keeps at world position `P`: V / K, the
 * clouds' own transmittance over the land's (1 without a floor, where the two are one). */
export function keySeaShare( P: V3 ): F {

	const readers = keyCloudReaders();
	if ( ! readers ) return float( 1 );
	const V = readers.cloud( P ).toVar();
	return select( readers.floor.greaterThan( 0 ), V.div( mix( readers.floor, float( 1 ), V ) ), float( 1 ) );

}
