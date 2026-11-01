import * as THREE from 'three/webgpu';
import { cameraViewMatrix, uniform, vec3, vec4 } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';
import { MOON_CULMINATION } from '../sky/DayCycle.ts';
import { tuneObject } from '../debug/Tune.ts';
import { markSkyRetune } from '../sky/SkyRetune.ts';

type V3 = THREE.Node<'vec3'>;

// The low key's lift: under a key low over the horizon, the direction the surfaces take its light
// from (every term of how a surface receives it) and the sun's shadows fall along climbs above the
// key's own. Under a true sun a few degrees high, level ground takes a twentieth of the light a
// surface facing the sun takes, and the sky lights its shade as much as the sun lights the rest:
// lit and shaded ground merge into one dim plane, with a lit to shade ratio under 3 on flat bare
// ground in the lighting layer at 3 degrees, and the shadows run out across the whole island. The
// golden hour's ground stays clearly lit, stained by the low sun's colour, under shadows a few
// times their casters' height. So the shading direction's elevation never falls
// below 14 degrees: it follows the key down to there, its corner rounded over a degree either side
// (`join`), holds at 14 while the key sinks to 6, climbs to 18 over the next degree (the golden
// hour, from the key at about 5.5: a monotone cubic over KEY_LIFT's rows, one degree wide, so no
// step shows and no frame jumps) and holds at 18 down to the horizon, at the key's own azimuth.
// The shading elevation is a function of the key's elevation alone, so a time of day and a weather
// give one direction whichever way the clock ran, mornings as evenings.
// What moves to the lifted direction is everything about how a surface receives the key: the whole
// direct term (GroundBounceLightingModel `direct`: the diffuse, the specular with its Fresnel and
// the disk's representative point, lighting/SurfaceBRDF.ts), the vegetation's wrap and light
// through to the far side (VegetationLighting), the feathers' (characters/FigureSurfaces.ts), the
// islanders' cel light (characters/CharacterMaterial.ts), the terrain's terminator
// (lighting/Underwater.ts), and the shadows that bound them: the sun's map is drawn along the
// lifted direction (main.ts passes it to SunShadow, and the figures' map follows that map:
// characters/CharacterShadow.ts), and the meadow's layer shades its blades and the ground under
// them along it (`liftKeyWorld`, Grass.ts `meadowLayerDepth`), as the meadow's screen-space shade
// does (post/MeadowShade.ts). Lit faces, highlights and shadows so turn to one side together;
// with only the diffuse lifted, the dusk's highlights and back light still faced the grazing sun,
// apart from the ground's shading. What keeps the key's true direction is everything about where
// the light comes from: the key's colour and brightness (Sky.ts: the atmosphere's transmittance,
// dimmed under 6 degrees), the drawn sun, the sky and its harmonics, the aerial
// perspective, the clouds' shadows, the haze's scattering, the water's own glint (it must meet the
// drawn sun or moon), the refracted sun under the water and its map (UnderwaterLightingModel), and
// the bounces' directions (the ambient volume's lobes, GroundBounce.ts's map); the ambient volume
// weighs its bounce by the lifted cosine, the light level ground takes (AmbientRelight.ts). The
// haze's shadow is the sun's map, so its shafts follow the lifted shadows. Nothing else brightens
// the dusk: the rest is the exposure's. The metering illuminance a lit material writes
// (Pipeline.ts `meterLight`) is its incident light, the lifted cosine included.
// The moon, the night's key, shades from one fixed world direction for as long as it is the key:
// `moon` degrees up (20, its orbit's culmination: sky/DayCycle.ts) at the azimuth of
// its culmination (DayCycle `MOON_CULMINATION`, the middle of its night, as its orbit runs east,
// up to the meridian and west), whatever its own height and azimuth, so the night keeps one
// shading and one level from dusk to dawn. Unlike the sun, the moon is also drawn there while it
// is up (`moonDirection`), and the key's own direction is that one too (Sky.ts `keyDir`), so
// everything that keeps the key's true direction above (the water's glint and so the moon's path
// on the sea, the refracted light under the water, the clouds, the haze) sees the
// moon where it is drawn: the disk, the glow of the air around it, its path on the water and the
// island's shading and shadows stand in one place. Its phase keeps its angle to the orbit's sun
// (Sky.ts `track`). Over the handoff (from 0.7 to 2.5 degrees under the horizon, through no key
// light) the key turns from the sun to that direction, and arrives there as the moon becomes the
// key: a key above the lift's floor shades from its own direction, so with `moon` above 15 the
// shading and the shadows turn with it and nothing jumps when the moon takes over (below 15 the
// floor holds the shading up to the last moment, a small turn at no light).
// The lifted direction is the key's L scale + U up + W side, U the world's up and W the moon's
// fixed direction in view space, with `scale`, `up` and `side` set on the CPU from the key
// (`updateKeyLift`, every publish of the lighting): with no lift they are 1, 0 and 0, and the
// lifted direction is the key's bit for bit; under a sun key side is 0, under the moon scale and up
// are 0 and side 1. The shadow's is `liftedKeyDirection`, the same direction in world space.
// Off with `flags=keyLift:false` (at run time from the next publish of the lighting). Ours.

/** The elevations (degrees): the shading direction's at the sun key's (`at`, ascending), held below
 * the first row; from the last row's on, the shading holds at the last row's `shading` until the
 * key's own elevation passes it, the corner rounded over `join` degrees either side; a moon key
 * shades from `moon` at the azimuth of its culmination, where the moon is drawn too
 * (`moonDirection`): 20, the elevation its orbit culminates at (sky/DayCycle.ts MOON_TILT).
 * Tunable on debug pages (debug/Tune.ts): `lighting.moon.elevation`. */
export const KEY_LIFT = tuneObject( {
	rows: [ { at: 0, shading: 18 }, { at: 5, shading: 18 }, { at: 6, shading: 14 } ],
	join: 1,
	moon: 20,
}, { moon: 'lighting.moon.elevation' }, { moon: { min: 10, max: 40, onChange: () => {

	placeMoonShade();
	markSkyRetune();

} } } );

// The rows' slopes (shading per degree of the key): Fritsch and Carlson's monotone cubic
// ("Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 1980), flat at both ends, so the
// lift meets the hold below and the floor above smoothly.
const SLOPE = KEY_LIFT.rows.map( ( r, i, rows ) => {

	if ( i === 0 || i === rows.length - 1 ) return 0;
	const h0 = r.at - rows[ i - 1 ].at, h1 = rows[ i + 1 ].at - r.at;
	const d0 = ( r.shading - rows[ i - 1 ].shading ) / h0, d1 = ( rows[ i + 1 ].shading - r.shading ) / h1;
	return d0 * d1 <= 0 ? 0 : 3 * ( h0 + h1 ) / ( ( 2 * h1 + h0 ) / d0 + ( h1 + 2 * h0 ) / d1 );

} );

// the shading elevation under a sun key at `elevation` (degrees)
function shading( elevation: number ): number {

	const rows = KEY_LIFT.rows, last = rows[ rows.length - 1 ];
	if ( elevation <= rows[ 0 ].at ) return rows[ 0 ].shading;
	if ( elevation >= last.at ) {

		// max( elevation, floor ), its corner a parabola meeting both lines with their slopes
		const floor = last.shading, w = KEY_LIFT.join, x = elevation - floor;
		return x <= - w ? floor : x >= w ? elevation : floor + ( x + w ) * ( x + w ) / ( 4 * w );

	}
	let i = 1;
	while ( elevation >= rows[ i ].at ) i ++;
	const a = rows[ i - 1 ], b = rows[ i ], h = b.at - a.at, t = ( elevation - a.at ) / h, t2 = t * t, t3 = t2 * t;
	return ( 2 * t3 - 3 * t2 + 1 ) * a.shading + ( t3 - 2 * t2 + t ) * h * SLOPE[ i - 1 ]
		+ ( 3 * t2 - 2 * t3 ) * b.shading + ( t3 - t2 ) * h * SLOPE[ i ];

}

const scale = uniform( 1 ), up = uniform( 0 ), side = uniform( 0 );
// the moon's fixed shading direction (world, unit): `moon` degrees up at its culmination's azimuth,
// on the CPU and for the shaders, placed again when `moon` is set
const MOON_SHADE = new THREE.Vector3();
const moonShade = uniform( new THREE.Vector3() );
function placeMoonShade(): void {

	const across = Math.hypot( MOON_CULMINATION.x, MOON_CULMINATION.z ), e = THREE.MathUtils.degToRad( KEY_LIFT.moon );
	const k = Math.cos( e ) / across;
	MOON_SHADE.set( MOON_CULMINATION.x * k, Math.sin( e ), MOON_CULMINATION.z * k );
	moonShade.value.copy( MOON_SHADE );

}
placeMoonShade();

// how the key's world direction is lifted: under the sun its elevation and the lifted one (radians);
// under the moon the fixed direction (`moon`); neither where nothing lifts it
function lifted( key: THREE.Vector3, moon: boolean ): { elevation: number; lifted: number; lift: boolean; moon: boolean } {

	const across = Math.hypot( key.x, key.z );
	const elevation = THREE.MathUtils.radToDeg( Math.atan2( key.y, across ) );
	const off = debugFlags.keyLift === false;
	if ( moon && ! off ) return { elevation: THREE.MathUtils.degToRad( elevation ), lifted: THREE.MathUtils.degToRad( KEY_LIFT.moon ), lift: true, moon: true };
	const shade = off || across === 0 ? elevation : shading( elevation );
	return { elevation: THREE.MathUtils.degToRad( elevation ), lifted: THREE.MathUtils.degToRad( shade ), lift: shade !== elevation, moon: false };

}

/** The sine of the elevation the surfaces take the key's light from under the key's world
 * direction `key` (the moon's if `moon`): the cosine level ground takes (the ambient volume's key
 * bounce, AmbientRelight.ts). None from a key below the
 * horizon, which lights no level ground. */
export function liftedKeyHeight( key: THREE.Vector3, moon = false ): number {

	return key.y > 0 ? Math.sin( lifted( key, moon ).lifted ) : 0;

}

/** The key's world direction `key` (the moon's if `moon`) lifted, into `target`: the direction the
 * surfaces take its light from and the sun's map is drawn along (main.ts, SunShadow.ts); `key`
 * itself where nothing lifts it. */
export function liftedKeyDirection( key: THREE.Vector3, moon: boolean, target: THREE.Vector3 ): THREE.Vector3 {

	const { lifted: l, lift, moon: fixed } = lifted( key, moon );
	if ( fixed ) return target.copy( MOON_SHADE );
	if ( ! lift ) return target.copy( key );
	const across = Math.cos( l ) / Math.hypot( key.x, key.z );
	return target.set( key.x * across, Math.sin( l ), key.z * across );

}

/** The direction the moon stands in, drawn and lighting the sky and the haze, while it is up
 * (Sky.ts `track`): the night key's fixed shading direction, so the moon the eye sees, the light
 * in the air around it and the shading and shadows it casts on the island come from one place,
 * and the key's direction by night (Sky.ts `keyDir`); its orbit's own direction `orbit` with the
 * lift off (`flags=keyLift:false`), where the key keeps its orbit's direction too. Into `target`. */
export function moonDirection( orbit: THREE.Vector3, target: THREE.Vector3 ): THREE.Vector3 {

	return target.copy( debugFlags.keyLift === false ? orbit : MOON_SHADE );

}

/** Sets the lift for the key's world direction, the moon's if `moon` (main.ts `publishLighting`). */
export function updateKeyLift( key: THREE.Vector3, moon = false ): void {

	const { elevation: e, lifted: l, lift, moon: fixed } = lifted( key, moon );
	if ( fixed ) {

		scale.value = 0;
		up.value = 0;
		side.value = 1;
		return;

	}
	side.value = 0;
	if ( ! lift ) {

		scale.value = 1;
		up.value = 0;
		return;

	}
	const k = Math.cos( l ) / Math.cos( e );
	scale.value = k;
	up.value = Math.sin( l ) - Math.sin( e ) * k;

}

/** The key's world direction L lifted: `liftedKeyDirection` on the GPU, the direction the sun's
 * map is drawn along (the meadow's layer shade, Grass.ts `meadowLayerDepth`, takes it). */
export function liftKeyWorld( L: V3 ): V3 {

	return L.mul( scale ).add( vec3( 0, up, 0 ) ).add( moonShade.mul( side ) );

}

/** The key's view-space direction L lifted: the direction the surfaces take its light from. */
export function liftKey( L: V3 ): V3 {

	const U = cameraViewMatrix.mul( vec4( 0, 1, 0, 0 ) ).xyz;
	const W = cameraViewMatrix.mul( vec4( moonShade, 0 ) ).xyz;
	return L.mul( scale ).add( U.mul( up ) ).add( W.mul( side ) );

}
