import * as THREE from 'three/webgpu';
import { Fn, float, log2, exp2, max, mix, dot, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

// The frame's exposure, metered from the light. The meter reads the illuminance, not the frame's
// luminance, so the albedo stays out of it: a dark meadow or sea is not brightened toward mid grey
// (after Patry, "Real-Time Samurai Cinema", SIGGRAPH 2021: a primarily illuminance-based exposure).
// A compensation looked up by the scene's brightness then sets the look of each scene, as an
// exposure compensation curve over the metered EV does (Unreal Engine's auto exposure).
// - The meter: the island's illuminance on level ground, the key light (the sun, or the moon) at
//   its height plus the sky's irradiance as the island takes it (Sky.ts islandIrradianceNode),
//   evaluated in the shaders from this frame's light: a function of the clock and the weather, so
//   a paused frame repeats and every pass reads the same value; nothing adapts over time.
// - Its EV: log2 of the illuminance, 15 at the fair noon island view's (METER.reference, measured).
// - The exposure: CALIBRATION / E x 2^compensation, so an 18 % grey card on level ground shows at
//   0.18 CALIBRATION / pi times 2^compensation whatever the light. With no compensation the card
//   shows at 0.74, two stops over mid grey: the level the clock's exposure (calibrated against
//   tidewater's frames, whose meter weighs their dark sea and meadow) gave the fair noon.
// - The compensation, in stops: a curve by day and one by night over the EV (points linear
//   between, extended with their end segments' slopes), blended as the night's grade comes in
//   (`night`, Pipeline's), plus the cloud deck's term (`deck`, Sky.ts grade.deck) times its stops.
//   Two curves, because the night is lit far above a real night (a full moon gives the island
//   about a sunset's light), so the EV alone cannot tell a moonlit night from a sunset. The deck's
//   term, because a light meter does not lift the dim, diffusely lit overcast frame: without it
//   the overcast noon showed at two fifths of the clear one, where the art direction keeps about
//   three quarters.
// - The default points are the clock's exposure the meter replaced, measured over the meter: the
//   clear day hour by hour from sunrise to sunset, the night at dawn, dusk and midnight with and
//   without the moon, the overcast noon and midnight. The meter lands with those frames as they
//   were, within about a tenth of a stop (an overcast low sun, which the clock's exposure lifted to
//   show a grey card near white, now shows darker), and the points are the look's knobs. The
//   night's is a line of a stop per stop: the exposure holds by night, as the clock's did.

/** The meter's reference: the fair noon island view's illuminance (scene units) reads as EV 15. */
export const METER = { reference: 0.564, ev: 15 } as const;
const CALIBRATION = 12.89;
type Curve = readonly ( readonly [ number, number ] )[];
/** The compensation by day and by night: [ EV, stops ] ascending, and the deck's stops. */
export const COMPENSATION: { readonly day: { curve: Curve; deck: number }; readonly night: { curve: Curve; deck: number } } = {
	day: { curve: [ [ 9.9, - 2.0 ], [ 10.85, - 1.45 ], [ 11.85, - 1.0 ], [ 12.8, - 0.65 ], [ 13.9, - 0.48 ], [ 14.8, - 0.2 ], [ 15, 0 ], [ 16, 0 ] ], deck: 1.18 },
	night: { curve: [ [ 7.84, - 2.31 ], [ 9.84, - 0.31 ] ], deck: 1.62 },
};

// the stops on `curve` at `ev`, linear between its points and along its end segments beyond
const along = ( curve: Curve, ev: F ): F => {

	const slope = ( i: number ) => ( curve[ i + 1 ][ 1 ] - curve[ i ][ 1 ] ) / ( curve[ i + 1 ][ 0 ] - curve[ i ][ 0 ] );
	let c: F = float( curve[ 0 ][ 1 ] ).add( ev.sub( curve[ 0 ][ 0 ] ).mul( slope( 0 ) ) );
	for ( let i = 1; i < curve.length - 1; i ++ ) c = c.add( max( ev.sub( curve[ i ][ 0 ] ), 0 ).mul( slope( i ) - slope( i - 1 ) ) );
	return c;

};
const alongCPU = ( curve: Curve, ev: number ): number => {

	const slope = ( i: number ) => ( curve[ i + 1 ][ 1 ] - curve[ i ][ 1 ] ) / ( curve[ i + 1 ][ 0 ] - curve[ i ][ 0 ] );
	let c = curve[ 0 ][ 1 ] + ( ev - curve[ 0 ][ 0 ] ) * slope( 0 );
	for ( let i = 1; i < curve.length - 1; i ++ ) c += Math.max( ev - curve[ i ][ 0 ], 0 ) * ( slope( i ) - slope( i - 1 ) );
	return c;

};

/** The exposure (scene radiance to the exposed image) for the key light's illuminance on level
 * ground `key`, the sky's irradiance over pi `sky`, the night's weight `night` and the deck's
 * closure `deck`, times 2^`offset` (stops: the GUI's). */
export const meteredExposure = Fn( ( [ key, sky, night, deck, offset ]: [ F, V3, F, F, F ] ) => {

	const e = max( key.add( dot( sky, vec3( 0.2126, 0.7152, 0.0722 ) ).mul( Math.PI ) ), 1e-8 ).toVar();
	const ev = log2( e.div( METER.reference ) ).add( METER.ev ).toVar();
	const { day, night: dark } = COMPENSATION;
	const byDay = along( day.curve, ev ).add( deck.mul( day.deck ) );
	const byNight = along( dark.curve, ev ).add( deck.mul( dark.deck ) );
	return exp2( mix( byDay, byNight, night ).add( offset ) ).mul( CALIBRATION ).div( e );

} ).setLayout( { name: 'meteredExposure', type: 'float', inputs: [
	{ name: 'key', type: 'float' }, { name: 'sky', type: 'vec3' }, { name: 'night', type: 'float' }, { name: 'deck', type: 'float' }, { name: 'offset', type: 'float' },
] } );

/** The same on the CPU, for diagnostics (`sky`: the irradiance over pi, as lent to the island). */
export function meter( key: number, sky: THREE.Color, night: number, deck: number, offset = 0 ): { illuminance: number; ev: number; compensation: number; exposure: number } {

	const e = Math.max( key + Math.PI * ( 0.2126 * sky.r + 0.7152 * sky.g + 0.0722 * sky.b ), 1e-8 );
	const ev = Math.log2( e / METER.reference ) + METER.ev;
	const { day, night: dark } = COMPENSATION;
	const c = THREE.MathUtils.lerp( alongCPU( day.curve, ev ) + deck * day.deck, alongCPU( dark.curve, ev ) + deck * dark.deck, night );
	return { illuminance: e, ev, compensation: c, exposure: 2 ** ( c + offset ) * CALIBRATION / e };

}
