import type * as THREE from 'three/webgpu';
import { Fn, abs, atan, clamp, dot, fract, length, output, varyingProperty, vec2, vec3, vec4 } from 'three/tsl';
import type { WindUniforms } from '../weather/Wind.ts';

type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;

// A debug view of the vegetation's wind (src/weather/Wind.ts `windField`), the URL option
// `windView` on debug pages (the dev server, `?debug`, `?profile`), read once as the modules load,
// since it changes how the vegetation's materials are built: without it no shader or pipeline
// differs. `windView=arrows` shows only the arrows, `windView=plants` only the plants' colours,
// `windView` (any other value) both.
//
// - Arrows: one flat arrow every 2 m over the meadow shown (inside the coast), lying just
//   above the meadow's canopy, pointing where the local wind blows (`windField`'s direction, with
//   the eddies' veer), longer in a gust (`field.w`) and brighter with the lean it gives (`field.z`),
//   unlit. Their vertex stage calls `windField( shared.wind, cell )` itself, so they move with
//   the wind, and record their displacement as the vegetation does (`setWindDisplacement`,
//   `previousSway`), so the temporal modes see their motion. Built by WindArrows.ts.
// - Plants: every vegetation material (the grass, flowers, rim bushes, rim trails, turf skirt and
//   the game's palm) draws, unlit, a colour for its plant's current sway s, its horizontal tip
//   offset over its height (lean plus swing, the unit of LEAN_REF): the hue is the angle of s from
//   the mean wind (`shared.wind.direction`), on a cyclic map: downwind blue, upwind orange, s
//   turned left of the wind (counter-clockwise seen from above) magenta, right of it green; the
//   brightness is |s| / 0.15, saturating. Each material passes the sway its displacement
//   computes (Grass.ts `bendBlade`'s lean, vegetation/Deform.ts `mainBend`'s, `hangingSway`'s and
//   `skirtLean`'s sway) through `showSway`; the colour is taken in the vertex stage and passes as a
//   varying. A right wind shows a patch of meadow in one hue, brightening and darkening as gusts
//   cross it, the hue shifting only slowly at a gust's edge.
// The numbers behind the view come from `__PONLAI__.windProbe` (src/debug/WindProbe.ts).

const params = new URLSearchParams( location.search );
const debugPage = import.meta.env.DEV || params.has( 'debug' ) || params.has( 'profile' );
const option = debugPage && params.has( 'windView' ) ? params.get( 'windView' ) : null;
export const WIND_VIEW = {
	arrows: option !== null && option !== 'plants',
	plants: option !== null && option !== 'arrows',
};

// The colours are drawn unlit into the scene's HDR target: this gain puts a saturated one near the
// top of the tone curve at a day's exposure.
export const GAIN = 0.15;
// |s| at full brightness
const FULL = 0.15;

/** The cyclic colour of a sway `s` against the mean wind `direction` (see the header). */
export const swayColour = ( s: V2, direction: V2 ): V3 => {

	const along = dot( s, direction ), across = dot( s, vec2( direction.y.negate(), direction.x ) );
	// 0 downwind, +-0.5 upwind, +0.25 to the left
	const turn = atan( across, along ).div( Math.PI * 2 );
	const hue = fract( turn.add( 0.6 ) );
	const rgb = clamp( abs( fract( vec3( hue ).add( vec3( 0, 2 / 3, 1 / 3 ) ) ).mul( 6 ).sub( 3 ) ).sub( 1 ), 0, 1 );
	return rgb.mul( clamp( length( s ).div( FULL ), 0, 1 ) );

};

/** In the plants' wind view, draw `material` unlit in the colour of `sway` (a plant's tip offset
 * over its height, world x, z: see the header). Call it once its position node is set. */
export function showSway( material: THREE.NodeMaterial, sway: V2, wind: WindUniforms ): void {

	if ( ! WIND_VIEW.plants ) return;
	const code = varyingProperty( 'vec3', 'vWindSway' );
	const placed = material.positionNode!;
	material.positionNode = Fn( () => {

		code.assign( swayColour( sway, wind.direction ) );
		return placed;

	} )();
	material.outputNode = vec4( code.mul( GAIN ), output.a );
	material.needsUpdate = true;

}
