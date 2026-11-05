import * as THREE from 'three/webgpu';
import { Fn, If, dot, float, max, mix, pow, smoothstep, uniform, vec3 } from 'three/tsl';
import { shared } from '../shared.ts';
import { liftKeyWorld } from './KeyLift.ts';
import { keyCloudReaders } from './KeyCloud.ts';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The key's gain under a deck, per point. Both gains (main.ts OVERCAST_KEY_GAIN, CLOUDY_KEY_GAIN)
// start at 1, where nothing here is built: under a deck the land's directional light is the
// weather's floor of the key through the sun's map (sky/Weather.ts `deckFloor`), and the wider
// forward light the deck scatters about the sun's place is drawn in the sky, which the land's
// ambient light takes (lighting/AmbientRelight.ts OVERCAST_LAND, CLOUDY_LAND). A gain over 1
// stands for more of the deck's forward light the key's direction carries through a thin part of
// the deck, which the sky's one key does not: it belongs to the key's path through cloud, so it is
// gated by the clouds' transmittance T along that path at the point (Clouds.ts `shadow`, the T the
// clouds' shadow takes). Where the deck lets T 0.6 or less through, the key takes
// the weather's whole gain; from 0.6 to 1 its share falls to none on a smoothstep, so in a gap,
// where the sun reaches the ground through no cloud, the key is the sky's own and a gap's lit
// ground stands as a clear day's under the same sun but for the sky's light. The curve is
// continuous with a continuous slope, so a lit patch's edge shows no step. The key times T times
// the gain peaks about T 0.66 (2.5 times the sky's own key under a gain of 4, 1.9 under 3) and
// falls to the sky's own key at 1: a patch's rim, where the sun passes through the deck's thinnest
// part, takes more of the key than the gap's centre, a cloud's bright edge.
// - Where it goes: the gain is the deck's forward light, which a deck a few optical depths thick has
//   scattered out of the beam into diffuse light: the beam the clouds' transmittance keeps is the
//   sun's own. So the direct key (three's sun, main.ts publishLighting) is the sky's key
//   without the gain, cut per point by the clouds' shadow over the weather's floor alone (Sky.ts
//   `keyDirectVisibility`), and what the gain added over it, x = mix( floor, 1, T ) ( 1 - 1 / gain )
//   ( 1 - smoothstep( 0.6, 1, T ) ) of the land's key (`keyLobeShare`, the land's key carrying the
//   gain), is ambient light: a wide lobe toward the key (`keyLobeLight`), which every physical lit
//   model adds to its irradiance with the ground's bounce (lighting/GroundBounce.ts
//   `GroundBounceLightingModel.indirect`) and the islanders to their fill
//   (characters/CharacterMaterial.ts). As ambient light it takes the occlusion (the blades' root to
//   tip, the material's and the screen's) and none of what bounds the key's beam: the sun's map,
//   the meadow's screen-space shade and its layer, the canopy's light, the hotspot (the bright
//   sunward patch of a canopy seen with the sun behind the eye is the shadows a small source's
//   beam hides there, Kuusk, "The hot-spot effect of a uniform vegetative cover", Sov. J. Remote
//   Sens. 3, 1985: a diffuse source casts none), the specular and the light through a leaf.
//   The lobe's radiance over the upper sky is c ( 1 + v.L ), v the direction in the sky, L the
//   key's shading direction (lighting/KeyLift.ts: the lifted one under a low key, as the direct
//   term takes; its axis turns toward the zenith under a thick deck, below); on a face of
//   normal N it gives the irradiance c ( pi + ( 2 pi / 3 ) N.L ) ( 1 + N.y ) / 2 (the isotropic part
//   exact, the lobe's part as the full sphere's under the upper sky's view factor), so on level
//   ground c pi ( 1 + ( 2 / 3 ) L.y ). c is set so that this equals x times the key's irradiance
//   there, x L.y: level open ground takes exactly the light the direct term gave up, and a face
//   turned to the key less (5 / 3 L.y / ( 1 + 2 / 3 L.y ) of x where it took x), one turned away a
//   little.
// - The lobe's axis: the forward light a thin part of the deck passes on still keeps the key's
//   direction, a halo round the sun; through a thick part it has been scattered so often that it
//   no longer remembers where the sun stands: multiple scattering makes the sky under a thick cloud
//   evenly bright. A droplet scatters mostly forward (asymmetry g about 0.85), so
//   the direction is lost over the scaled optical depth ( 1 - g ) tau, not over tau (the similarity
//   relation: van de Hulst, "Multiple Light Scattering", 1980). Our approximation built on it takes
//   the share of the lobe still turned to the key as exp( - ( 1 - g ) tau ) = T^( 1 - g ),
//   T = exp( - tau ) the deck's
//   transmittance along the key at the point (the clouds' shadow: Beer's law over the deck's own
//   optical depth, Clouds.ts `shadow`), and the rest is turned to the zenith: the axis is
//   A = w L + ( 1 - w ) up, w = T^0.15 (0.9 at T 0.5, 0.5 at T 0.01, about the least T the map
//   stores: its march stops past tau 12, where the multiple-scattering share it keeps,
//   0.2 e^( - tau / 4 ), is 0.01). The two lobes mix linearly, so the irradiance is the form above
//   with A in place of L, and its normalisation divides by ( 1 + 2/3 A.y ): level open ground still
//   takes x L.y exactly, whatever the axis.
//   The ground's bounce (lighting/GroundBounce.ts) and the ambient volume's bounce lobe
//   (lighting/AmbientRelight.ts), the light the ground sends back up, keep the gained key under
//   `keyCloudVisibility` (the whole key the ground takes, beam and lobe) where the ground is land.
//   The sea takes no gain (lighting/KeyCloud.ts): the water drawn (ocean/Water.ts), the floor seen
//   through it, the sea's share of the ground's bounce and the sea the ambient volume sees take
//   the sky's key through the clouds' own transmittance, and under a deck the sea's soft sheen
//   toward the sun is the sky's reflection. Wherever the gain is 1 (a clear or fair sky, by night)
//   the lobe is not built at run time (a branch on the gain) and the direct key is the sky's key.
// - Why 0.6: overcast's closed deck lets far less through everywhere (sky/Clouds.ts), so under it a
//   gain is whole; a cloudy deck's thin parts reach past 0.6 toward its gaps, which keep none of it,
//   so a gap's lit ground stands as a clear day's under the same sun but for the sky's light, not
//   times the gain.

/** The weather's key gain under its deck (main.ts publishLighting), 1 without a deck. */
export const keyDeckGain = uniform( 1 );

/** Where the key's gain starts to fall with the clouds' transmittance, and where it is gone. */
const SHARE_START = 0.6, SHARE_END = 1;

/** The share of the weather's key gain `gain` a point keeps under the clouds' transmittance `t`, as
 * a factor on the key that already carries the gain: 1 up to SHARE_START, 1 / gain at SHARE_END. */
export const keyGainShare = Fn( ( [ t, gain ]: [ F, F ] ) => {

	return float( 1 ).sub( float( 1 ).sub( float( 1 ).div( gain ) ).mul( smoothstep( SHARE_START, SHARE_END, t ) ) );

} ).setLayout( { name: 'keyGainShare', type: 'float', inputs: [ { name: 't', type: 'float' }, { name: 'gain', type: 'float' } ] } );

/** The share of the land's key (the weather's gain in it) that leaves the direct key for the lobe,
 * under the clouds' transmittance `t` over the weather's floor `floor`: mix( floor, 1, t ) times
 * ( 1 - 1 / gain ) times what the point keeps of the gain's share (0 from SHARE_END). */
export const keyLobeShare = Fn( ( [ t, floor, gain ]: [ F, F, F ] ) => {

	return mix( floor, float( 1 ), t ).mul( float( 1 ).sub( float( 1 ).div( gain ) ) ).mul( float( 1 ).sub( smoothstep( SHARE_START, SHARE_END, t ) ) );

} ).setLayout( { name: 'keyLobeShare', type: 'float', inputs: [ { name: 't', type: 'float' }, { name: 'floor', type: 'float' }, { name: 'gain', type: 'float' } ] } );

/** The droplets' asymmetry: the lobe's share still turned to the key is T^( 1 - g ) (see the header). */
const DROPLET_G = 0.85;

/** The lobe's irradiance on a face of world normal `N` per unit of the key's irradiance on level
 * ground, for the key's world shading direction `L` and the clouds' transmittance `t` along it (see
 * the header): L.y ( 1 + 2/3 N.A ) ( 1 + N.y ) / 2 / ( 1 + 2/3 A.y ), A = w L + ( 1 - w ) up,
 * w = t^( 1 - g ), L.y at 0 or more. */
export const keyLobeIrradiance = Fn( ( [ N, L, t ]: [ V3, V3, F ] ) => {

	const up = max( L.y, 0 );
	const w = pow( max( t, 1e-6 ), 1 - DROPLET_G );
	const A = mix( vec3( 0, 1, 0 ), L, w );
	return up.mul( dot( N, A ).mul( 2 / 3 ).add( 1 ) ).mul( N.y.mul( 0.5 ).add( 0.5 ) ).div( A.y.mul( 2 / 3 ).add( 1 ) );

} ).setLayout( { name: 'keyLobeIrradiance', type: 'float', inputs: [ { name: 'N', type: 'vec3' }, { name: 'L', type: 'vec3' }, { name: 't', type: 'float' } ] } );

/** The lobe's irradiance at world position `P` and world normal `N` (see the header): none where
 * the gain is 1, or before the sky has set the clouds. */
export function keyLobeLight( P: V3, N: V3 ): V3 {

	const E = vec3( 0 ).toVar();
	const readers = keyCloudReaders();
	if ( ! readers ) return E;
	const { cloud, floor } = readers;
	If( keyDeckGain.greaterThan( 1 ), () => {

		const t = cloud( P ).toVar();
		const x = keyLobeShare( t, floor, keyDeckGain );
		E.assign( vec3( shared.landKey ).mul( x.mul( keyLobeIrradiance( N, liftKeyWorld( shared.sunDir ), t ) ) ) );

	} );
	return E;

}
