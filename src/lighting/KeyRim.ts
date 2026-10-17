import * as THREE from 'three/webgpu';
import {
	Fn, float, vec3, vec4, uniform, dot, clamp, max, mix, pow, smoothstep, length,
	cameraViewMatrix, normalView, positionViewDirection,
} from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The key light's rim and backlight: one term every lit material adds to its direct light, so
// everything the key light (the sun by day, the moon by night) falls on catches it the same way
// along its silhouette and when it stands against the light. Vegetation (the factory in
// world/vegetation/Material.ts), the terrain and stones (TerrainMaterial.ts) and the islanders
// (CharacterMaterial.ts) take it; a new lit material (animals, buildings) calls `keyRimLight` in
// its lighting model's `direct` and gives only its surface's parameters (`KeyRimSurface`, a preset
// in KEY_RIM), never lighting code of its own. The water keeps its own highlights.
//
// The term is the light's colour as it reaches the surface (already through the shadow map, the
// meadow's canopy or the water), so a silhouette in shade stays dark, times:
//   - the edge: a band of the view's grazing angle (1 - N.V from `edgeFrom` to `edgeTo`; a narrow
//     band reads as a crisp, cel-like step), on the side facing the light (a thin surface takes it
//     from either side), brightest looking into the light: in 3D, or in plan, since the game's
//     camera looks down on the island and a low key ahead of it still backlights what stands
//     there; a floor (EDGE_FLOOR) keeps a side light's edge. Its colour is the albedo times `rim`
//     plus `sheen`, a neutral share that keeps the light's own colour (a cool edge under the moon).
//   - the backlight: light round or through the surface looking into the key, the albedo times
//     `back`, a lobe of power `backPower`: half-wrapped through a thin surface (as `forwardLight`
//     in the vegetation factory), at the silhouette alone on an opaque one.
// The vegetation's thin leaves and blades keep their own transmission (the factory's `extra`)
// and take only the edge here.
//
// By day the term stays restrained: it shows mostly under a low sun, from the side or against it.
// The moon's edge is art-directed brighter than physics (NIGHT_GAIN, and from every side:
// NIGHT_EDGE_FLOOR), over the moon's share of the key light, which DayCycle's `moonKeyGain` brings
// in; so the moonlit meadow, leaves and figures have cool bright edges for the look's soft glow to
// spread. It shows most in near views and under a lower moon: a high midnight moon over the
// overview meets few surfaces at a grazing angle (that view's 95th percentile rose about 2 %, a
// near view's toward the moon about 18 %).

/** A surface type's rim and backlight (numbers, or per-vertex / per-fragment nodes). */
export interface KeyRimSurface {
	/** The edge's strength, times the albedo. */
	rim: number | F;
	/** The edge's neutral share, the light's own colour. */
	sheen: number | F;
	/** The edge's band over the grazing angle (1 - N.V). */
	edgeFrom: number | F;
	edgeTo: number | F;
	/** The backlight's strength, times the albedo, and its lobe's power. */
	back: number | F;
	backPower: number | F;
	/** 1 thin (lit from either side, the backlight through it), 0 opaque. */
	thin: number | F;
}

/** The surface types' parameters. A new kind of surface starts from the nearest. */
export const KEY_RIM = {
	// Grass blades, on the tuft's envelope normal (Grass.ts): the tufts' flanks seen from above
	// take a faint edge across the lawn, mostly in the blades' own green (a neutral share greys
	// the moonlit lawn).
	blade: { rim: 0.5, sheen: 0.012, edgeFrom: 0.45, edgeTo: 0.92, back: 0, backPower: 4, thin: 1 },
	// Folded leaves (the leaf family: the plant kinds to come; the flower heads are blades).
	leaf: { rim: 0.45, sheen: 0.025, edgeFrom: 0.6, edgeTo: 0.95, back: 0, backPower: 4, thin: 1 },
	// Untagged grass (the vegetation's 'sod' family: kept for the kinds to come).
	sod: { rim: 0.4, sheen: 0.02, edgeFrom: 0.6, edgeTo: 0.95, back: 0, backPower: 4, thin: 0 },
	// Bark (for the trees to come): opaque, a thin halo where it stands against the light.
	bark: { rim: 0.5, sheen: 0.02, edgeFrom: 0.55, edgeTo: 0.92, back: 0.6, backPower: 6, thin: 0 },
	// The cliff and stones, on their geometric normal (the detail normals' grazing texels sparkle).
	stone: { rim: 0.5, sheen: 0.02, edgeFrom: 0.6, edgeTo: 0.95, back: 0.4, backPower: 6, thin: 0 },
	// The islanders' cel rim: a narrow, stepped band and a bright neutral share, as painted.
	character: { rim: 2.4, sheen: 0.06, edgeFrom: 0.46, edgeTo: 0.72, back: 0, backPower: 4, thin: 0 },
} satisfies Record<string, KeyRimSurface>;

// The edge's share where the view does not look into the light at all (a side light's edge), by
// day and under the moon: a high moon over the game's downward view never stands against it, so
// its edges show from every side.
const EDGE_FLOOR = 0.2;
const NIGHT_EDGE_FLOOR = 0.8;
// The moon's edge against physics.
const NIGHT_GAIN = 4;

export const keyRim = {
	// the gain on the term: 1 under the sun, NIGHT_GAIN under the moon (`trackKeyRim`)
	gain: uniform( 1 ),
	// the edge's floor: EDGE_FLOOR under the sun, NIGHT_EDGE_FLOOR under the moon
	floor: uniform( EDGE_FLOOR ),
};

/** Follow the key light: the moon's share of it sets the night's gain. `sun` is the sun's part of
 * the key light, `key` the whole (Sky.sunColor, Sky.keyColor). */
export function trackKeyRim( sun: THREE.Color, key: THREE.Color ): void {

	const keyLuma = key.r * 0.2126 + key.g * 0.7152 + key.b * 0.0722;
	const sunLuma = sun.r * 0.2126 + sun.g * 0.7152 + sun.b * 0.0722;
	const moon = keyLuma > 0 ? THREE.MathUtils.clamp( 1 - sunLuma / keyLuma, 0, 1 ) : 0;
	keyRim.gain.value = 1 + ( NIGHT_GAIN - 1 ) * moon;
	keyRim.floor.value = EDGE_FLOOR + ( NIGHT_EDGE_FLOOR - EDGE_FLOOR ) * moon;

}

// View space. `up` is the world's up in view space. Uniforms reach a layout function only as
// arguments.
const keyRimTerm = Fn( ( [ L, V, N, up, albedo, rim, sheen, edgeFrom, edgeTo, back, backPower, thin, floor, gain ]: [ V3, V3, V3, V3, V3, F, F, F, F, F, F, F, F, F ] ) => {

	const grazing = float( 1 ).sub( clamp( dot( N, V ), 0, 1 ) );
	const edge = smoothstep( edgeFrom, edgeTo, grazing );
	const facing = mix( smoothstep( - 0.25, 0.35, dot( N, L ) ), float( 1 ), thin );
	const into = clamp( dot( V, L ).negate(), 0, 1 );
	// in plan: both directions with their vertical part removed (a vanishing one counts as not
	// looking into the light)
	const vPlan = V.sub( up.mul( dot( V, up ) ) ), lPlan = L.sub( up.mul( dot( L, up ) ) );
	const intoPlan = clamp( dot( vPlan, lPlan ).negate().div( max( length( vPlan ).mul( length( lPlan ) ), 1e-4 ) ), 0, 1 );
	const against = max( into, intoPlan.mul( 0.85 ) );
	const edgeLight = edge.mul( facing ).mul( mix( floor, float( 1 ), against ) );
	const lobe = mix( pow( into, backPower ).mul( edge ), pow( clamp( dot( V, L ).negate().mul( 0.5 ).add( 0.5 ), 0, 1 ), backPower ), thin );
	return albedo.mul( rim.mul( edgeLight ).add( back.mul( lobe ) ) ).add( sheen.mul( edgeLight ) ).mul( gain );

} ).setLayout( { name: 'ponlaiKeyRim', type: 'vec3', inputs: [
	{ name: 'L', type: 'vec3' }, { name: 'V', type: 'vec3' }, { name: 'N', type: 'vec3' }, { name: 'up', type: 'vec3' },
	{ name: 'albedo', type: 'vec3' }, { name: 'rim', type: 'float' }, { name: 'sheen', type: 'float' },
	{ name: 'edgeFrom', type: 'float' }, { name: 'edgeTo', type: 'float' }, { name: 'back', type: 'float' },
	{ name: 'backPower', type: 'float' }, { name: 'thin', type: 'float' }, { name: 'floor', type: 'float' }, { name: 'gain', type: 'float' },
] } );

const f = ( x: number | F ): F => typeof x === 'number' ? float( x ) : x;

/** The key light's rim and backlight on a surface, as direct diffuse radiance: `lightColor` is the
 * key's colour as it reaches the surface (shadowed), `L` the direction toward it, `N` and `V` the
 * normal and the direction toward the eye (all view space; default the material's). */
export function keyRimLight( lightColor: V3, L: V3, albedo: V3, surface: KeyRimSurface, N: V3 = normalView, V: V3 = positionViewDirection ): V3 {

	const up = cameraViewMatrix.mul( vec4( 0, 1, 0, 0 ) ).xyz;
	const s = surface;
	return lightColor.mul( keyRimTerm( L, V, N, up, vec3( albedo ), f( s.rim ), f( s.sheen ), f( s.edgeFrom ), f( s.edgeTo ),
		f( s.back ), f( s.backPower ), f( s.thin ), keyRim.floor, keyRim.gain ) ).mul( 1 / Math.PI );

}
