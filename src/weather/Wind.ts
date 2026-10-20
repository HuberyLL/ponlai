import { DataTexture, LinearFilter, RGFormat, RepeatWrapping, UnsignedByteType, Vector2 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, abs, clamp as clampNode, dot, float, fract, inverseSqrt, normalize, sin, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';
import { PREVAILING_HEADING, type WeatherState } from '../sky/Weather.ts';

// The weather's one wind, integrated on the CPU, what every part of the scene takes from it, and
// the one wind field all vegetation moves in.
//
// The weather's state gives three numbers (sky/Weather.ts, its wind a dimension of its own beside
// the sky: four levels and a heading that turns about the prevailing one with the weather):
// `windDirection`, a heading in the sea spectrum's convention (the wind comes from it and travels
// toward heading + 180 degrees), `windSpeed`, the mean wind 10 m up (U10), and `gustiness`, its
// gust factor (a 3 s gust over the mean). `Wind` is their one reader: it integrates them and
// publishes in `shared.wind` every quantity a part reads, so no part keeps a speed or direction of
// its own. U_ref is REFERENCE_SPEED, the gentle level's 3.8 m/s (fair's load), at which the plants
// and the sea were tuned:
// - vegetation: `direction`; `pressure` ( U / U_ref )^2, the drag that leans the plants (above
//   fair's, as the elastica of a blade under it: `pressedLean`, `pressing`); `breeze`
//   U / U_ref, their swing's amplitude; `gustLean`, a gust's added lean, from the gust factor (its
//   excess pressure G^2 - 1 against fair's); the gust map scrolled with the wind's travel
//   (`gustScroll`); and two clocks that do not follow the wind: `swayScroll`, which sets each
//   kind's natural sway frequency, and `clock`, the leaves' flutter. A stronger wind bends a plant
//   further, not faster (real plants swing near their own frequency in any wind).
// - the sea: the FFT's spectrum follows `speed` and `heading` (OceanFFT.setWind: tidewater's sea
//   state at that wind), so the sea is the same function of the weather however the page reached
//   it: the wind sea turns with the weather's wind, while the swell keeps the prevailing heading
//   (`spectrumWind`) and its own offset from it (OceanFFT `swellHeading`,
//   `swell.directionOffset`), and the shore waves follow the swell. `gale`, the wind beyond
//   1.5 U_ref, heaves the sea at the rock (Water.ts).
//   Around the island the sea's gusts (its cat's paws) are the meadow's: `gustAt`, the gust map
//   below, read by SeaDetail.ts, so a gust crosses from the water onto the meadow and off again
//   as one patch; farther out tidewater's octaves drift with `displacement`.
// - the clouds: `displacement`, which Clouds.setDrift turns into each layer's drift aloft;
//   `direction` for the fronts, the cirrus and the tops' lean (sky/Sky.ts, Clouds.ts).
// - the air: `displacement` (the clouds' drift), `velocity` (rain, the storm's spray),
//   `direction` (the storm sea's foam).
// The wind probe's W5 (`__PONLAI__.windProbe`) reports where each of them travels.
//
// `windField` (noise scrolled with the wind: Wohllaib, GDC 2021, its
// strength varied by Perlin noise, Rockenbeck, GDC 2021; the map is ours):
// a tileable gust map (two channels of periodic noise, ranked
// to an even spread) scrolled with the wind's integrated along-wind travel, its gust fronts long
// across the wind and finer eddies running faster inside them, so gusts visibly sweep the meadow
// and change as they go. It gives a lean (tip offset over height) from the wind's pressure; still
// air is the rest pose. Plants answer it in Crysis's layers (Sousa, GPU Gems 3 ch. 16): the whole
// plant bends from its root with the field at the root, every vertex keeping its distance from it
// (`mainBend`), and sways a little about that lean (`gustWave`, `swingOf`). The sway is driven by
// the gusts' travel, not by a clock and a random phase per plant: its phase is the scroll less the
// root's place along the wind, so neighbours swing together and the motion sweeps downwind with
// the gusts, as a meadow moves; each plant keeps only a small share of its own (`swayJitter`:
// +-0.4 rad, +-10 %). The swing is about a sixth of the lean, so a plant never swings upwind of
// upright and stays within a few degrees of the local wind. Rates are whole swings per gust tile
// (`swayScroll`, the natural frequencies: mainBend's 30 about 0.9 Hz; grass and its flowers 50,
// 1.5 Hz), whatever the wind; only the amplitude grows with it. Leaf edges, sprays and fronds still flutter on their own phases at fixed rates (`clock`), a small
// motion on top. Grass tufts and their flower heads bend with the field at their root (the tufts at the
// cliff's edge too, their blades draped over it), and a hanging strand swings like a pendulum with
// the same sway (vegetation/Deform.ts `hangingSway`: kept for the hanging kinds to come).
//
// Everything is a function of the wind's integrated clocks and travel (`clock`, `swayScroll`,
// `gustScroll`, wrapped where every rate completes whole cycles), never time * a changing speed,
// so a paused frame and a seek repeat exactly; shadows and the rain's collision map keep the rest
// pose. For motion vectors (TAA) every displacement is a function of the wind's state alone, its
// vertex inputs bound inside: each vegetation material records it with `setWindDisplacement`,
// evaluated in the material's position stage (its rest inputs read `positionLocal` before three
// assigns the swayed position) with `shared.wind` for the frame drawn or `shared.wind.previous`
// (the last rendered frame's, equal to the current one while paused and after a seek, so a jump
// leaves no motion); the grass's widening keeps the current camera's.
//
// `previous` is kept for motion vectors: `update` copies the current state into it before it
// integrates, once per rendered frame (main.ts calls it once per tick, and every tick renders),
// `reset` (a seek) and `cut` (Motion.ts's `taaCut`, through `onTaaCut`) make it the current state.
// The wrapped clocks may differ by a wrap between the two: every shader reads them only through
// functions periodic in their wrap (`wave` at whole cycles per CLOCK_PERIOD, the gust map's repeat
// over its tiles, `gustWave`'s whole swings per tile of `swayScroll`), so the difference of the two poses is the frame's motion alone
// (tools/verify-wind.mjs checks the sources).
// The URL option `windView` shows this field and every plant's answer to it, and
// `__PONLAI__.windProbe` measures them (src/debug/WindView.ts, WindProbe.ts; docs/tools.md).
// `debugFlags.windFreeze = true` holds the vegetation's wind (its clocks and gust scroll, previous
// equal to current) while the scene clock runs, for clips that want only the shadows or the jitter
// to move; the clouds and the sea keep their wind.

/** Fair's mean wind (m/s): the plants' lean and amplitudes, their natural frequencies and the
 * sea's calm design were tuned at it. */
export const REFERENCE_SPEED = 3.8;
/** Fair's gust factor: a gust's lean is GUST_LEAN at it. */
export const REFERENCE_GUSTINESS = 1.4;
const HEADING = PREVAILING_HEADING; // for a wind built without one
const clamp = ( value: number, low: number, high: number ) => Math.max( low, Math.min( high, value ) );
// The vegetation's clocks (seconds) wrap here. Shaders take fract( clock * f ) only at rates f
// with at most three decimals (Hz), so every one of them completes whole cycles in a period.
export const CLOCK_PERIOD = 1000;

// The gust field (see `windField`): a tileable noise map scrolled with the wind's integrated
// travel. Gust fronts are long across the wind and short along it, as they sweep a meadow; the
// finer eddies inside them run a little faster, so the pattern evolves instead of sliding by.
// Measured with the wind probe (where the correlation of `field.w` falls to 1/e) on a fair day:
// 12 - 15 m along the wind and 24 m across it, travelling about 5 % faster than the wind; a gust
// covers about a third of the land at a time. Perlin noise decorrelates within about a third of its cell, so the cells are
// three times the patches (32 m by 72 m); the eddies stay a small share, or they break the
// patches up and drag the pattern faster than the wind.
const GUST_SIZE = 128;
export const GUST_ALONG = 128; // metres per tile along the wind (four noise cells of 32 m)
export const GUST_ACROSS = 288; // across it (72 m cells)
export const EDDY_TILE = 30; // the eddies' tile, both ways (six cells: 5 m)
export const EDDY_RATE = 1.1; // eddies travel this much faster than the mean wind
const EDDY_SHARE = 0.15;
// The plants' lean (horizontal tip offset over height) is the wind's pressure, (speed / fair)^2,
// times a calm share plus the gust's (`gustLean`, GUST_LEAN at fair's gust factor), eased toward
// MAX_LEAN: about 0.035 between gusts and 0.145 at a gust's core on a fair day (four times as
// much), 0.09 and 0.34 in a storm's gale, and nothing in still air. A plant leans downwind all
// the time and a gust bends it well over: the gust's share is several times the calm one so the
// gusts read as bright and dark bands sweeping the meadow (docs/art-direction.md), while each
// plant's own swing stays a sixth of its lean.
const MEAN_LEAN = 0.035;
const GUST_LEAN = 0.13;
const MAX_LEAN = 1.2;
// Above fair's wind the plants take the shape of a blade under the wind's pressure (`pressedLean`):
// the planar elastica of a cantilever (vegetation/Physics.ts) under a uniform horizontal load of
// load number W = q L^3 / EI (q the drag per metre). Solved with Physics.ts `drape` (a vertical
// blade under a sideways load is the horizontal one under its weight, turned by 90 degrees) for
// the grass blade's taper, W from 0.02 to 630: the tip's chord leans 4 degrees at W = 1, 31 at 9,
// 66 at 43, 81 at 200, saturating toward lying flat downwind. As a tip offset over height its
// tangent is L = k0 W / sqrt( 1 + a W ) (k0 = 0.0729, the small bend's slope; a = 0.0199) within
// half a degree over the whole range, and the chord to half way leans atan( L / 2 ) within four
// degrees, the arc the bends here draw (`bendBlade`: the offset grows with the square of
// the way up). In the lean's own unit x = k0 W (the linear lean, `leanLoad`) that is
// x / sqrt( 1 + PRESS_SATURATION x ). Fair's lean (x up to 0.165 at a gust's core) is the linear
// one: the elastica and the eased lean below differ there by under a degree, so up to fair's wind
// the lean stays the eased one, to the bit, and from fair's pressure to twice it the elastica takes
// over (`pressing`). A stronger wind then presses the plants into a downwind arc that keeps
// deepening, where the eased lean stopped at 50 degrees.
const PRESS_SATURATION = 0.2725;
// The plants' own sway about the lean travels downwind (`gustWave`): its crests lie SWAY_SPREAD
// metres apart along the wind, so neighbours within a metre or two move together and plants a few
// metres apart drift out of step. With a whole-plant sway near 1 Hz the crests run about twice a
// fair wind's speed (a crest spacing of wind speed / frequency, 4 m, would put plants a metre
// apart along the wind a quarter turn out of step, which reads as each plant on its own).
const SWAY_SPREAD = 8;
const TAU = Math.PI * 2;
/** The lean of a fair day's typical gust: plants scale their authored sway amplitudes by
 * lean / LEAN_REF, so 1 reproduces the amplitude they were tuned at. */
export const LEAN_REF = 0.08;

// The wind's state as the vegetation's displacement reads it (see `windField` and
// `setWindDisplacement`); every value integrated or set from the weather, never time * a changing
// speed, so a paused frame and a seek reproduce the same pose.
function vegetationWind( direction: Vector2 ) {

	return {
		direction: uniform( direction.clone() ), // world-space travel direction; unit x/z
		pressure: uniform( 1 ), // ( speed / fair speed )^2, the drag that leans the plants
		breeze: uniform( 1 ), // speed / fair speed, for oscillation amplitudes
		gustLean: uniform( GUST_LEAN ), // the lean a gust's core adds per unit of pressure, from the gust factor
		clock: uniform( 0 ), // scene seconds modulo CLOCK_PERIOD: the leaves' flutter
		swayScroll: uniform( 0 ), // scene seconds times REFERENCE_SPEED, modulo GUST_ALONG, m: the plants' natural sway
		gustScroll: uniform( new Vector2() ), // along-wind travel of the gusts and eddies, wrapped to their tiles, m
	};

}

/** The inputs of every vegetation wind displacement besides the vertex's own (its rest position,
 * root and amplitudes). `createWindUniforms` holds two: the frame being rendered (the uniforms
 * themselves) and the frame rendered before it (`previous`), for motion vectors. */
export type WindState = ReturnType<typeof vegetationWind>;

/** A wind state's values as three vec4s, ( direction, pressure, breeze ), ( clock, sway scroll,
 * gust scroll ) and ( gust lean, 0, 0, 0 ), and the state read back from three such nodes: a debug
 * kernel's per-step wind (src/debug/WindProbe.ts), so the scrolls stay read here alone
 * (tools/verify-wind.mjs). */
export const WIND_STATE_VEC4S = 3;
export function packWindState( state: WindState ): number[] {

	return [ state.direction.value.x, state.direction.value.y, state.pressure.value, state.breeze.value,
		state.clock.value, state.swayScroll.value, state.gustScroll.value.x, state.gustScroll.value.y,
		state.gustLean.value, 0, 0, 0 ];

}

export function windStateOf( a: Node<'vec4'>, b: Node<'vec4'>, c: Node<'vec4'> ): WindState {

	return { direction: a.xy, pressure: a.z, breeze: a.w, gustLean: c.x, clock: b.x, swayScroll: b.y, gustScroll: b.zw } as unknown as WindState;

}

/** Add this object to shared before constructing materials, then give that same object to
 * Wind. Every consumer holds the same node identities throughout weather transitions. */
export function createWindUniforms() {

	const angle = HEADING * Math.PI / 180;
	const direction = new Vector2( - Math.cos( angle ), - Math.sin( angle ) );
	return {
		...vegetationWind( direction ),
		velocity: uniform( direction.clone().multiplyScalar( REFERENCE_SPEED ) ), // air velocity, m/s
		displacement: uniform( new Vector2() ), // integrated air displacement, metres
		gale: uniform( 0 ), // the wind beyond 1.5 x the fair-weather wind, U / U_ref - 1.5 in [ 0, 1.6 ]
		// The vegetation's wind as it was for the previous rendered frame: equal to the current
		// one while paused and after a seek or reset (no motion across a jump).
		previous: vegetationWind( direction ),
		gustMap: gustTexture(),
	};

}

export type WindUniforms = ReturnType<typeof createWindUniforms>;

export interface WindSettings {

	speed?: number; // mean wind 10 m up, m/s
	heading?: number; // OceanSpectrum Fourier heading, degrees; IFFT travel is opposite
	gustiness?: number; // gust factor, a 3 s gust over the mean (1 for none)
	time?: number;

}

/** A weather state's wind as Wind's settings. */
export const weatherWind = ( state: Pick<WeatherState, 'windSpeed' | 'windDirection' | 'gustiness'> ): Required<Omit<WindSettings, 'time'>> =>
	( { speed: state.windSpeed, heading: state.windDirection, gustiness: state.gustiness } );

/** The natural frequency (Hz) of a sway of `cycles` whole swings per gust tile (`gustWave`). */
export const swayFrequency = ( cycles: number ) => cycles * REFERENCE_SPEED / GUST_ALONG;

// A gust's lean grows with its excess pressure over the mean, G^2 - 1 (the gust factor G squared,
// less the mean's share), as a share of fair's.
const gustLeanOf = ( gustiness: number ) => GUST_LEAN * ( ( gustiness * gustiness - 1 ) / ( REFERENCE_GUSTINESS * REFERENCE_GUSTINESS - 1 ) );

function validate( speed: number, heading: number, gustiness: number, time: number ): void {

	if ( ! Number.isFinite( speed ) || speed < 0 ) throw new RangeError( 'Wind speed must be finite and non-negative' );
	if ( ! Number.isFinite( heading ) ) throw new RangeError( 'Wind heading must be finite' );
	if ( ! Number.isFinite( gustiness ) || gustiness < 1 ) throw new RangeError( 'Wind gustiness must be finite and at least 1' );
	if ( ! Number.isFinite( time ) || time < 0 ) throw new RangeError( 'Wind time must be finite and non-negative' );

}

// A periodic gradient noise (Ken Perlin's improved noise, SIGGRAPH 2002, in 2D, wrapped every
// `cells` cells) summed over octaves, then ranked so its values spread evenly over 0..1: a
// threshold on it then picks a known share of the area. Fixed seeds: the map is the same on every load.
function gustChannel( cells: number, seed: number ): Float32Array {

	const n = GUST_SIZE, out = new Float32Array( n * n );
	let state = seed >>> 0;
	const random = () => {

		state = ( state + 0x6d2b79f5 ) >>> 0;
		let t = Math.imul( state ^ ( state >>> 15 ), 1 | state );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};
	const octaves = [ cells, cells * 2, cells * 4 ];
	const gradients = octaves.map( ( c ) => Array.from( { length: c * c }, () => random() * Math.PI * 2 ) );
	const fade = ( t: number ) => t * t * t * ( t * ( t * 6 - 15 ) + 10 );
	for ( let y = 0; y < n; y ++ ) for ( let x = 0; x < n; x ++ ) {

		let sum = 0, amplitude = 1;
		octaves.forEach( ( c, o ) => {

			const fx = x / n * c, fy = y / n * c;
			const ix = Math.floor( fx ), iy = Math.floor( fy ), tx = fx - ix, ty = fy - iy;
			const corner = ( i: number, j: number ) => {

				const a = gradients[ o ][ ( ( iy + j ) % c ) * c + ( ix + i ) % c ];
				return Math.cos( a ) * ( tx - i ) + Math.sin( a ) * ( ty - j );

			};
			const u = fade( tx ), v = fade( ty );
			const top = corner( 0, 0 ) + ( corner( 1, 0 ) - corner( 0, 0 ) ) * u;
			const bottom = corner( 0, 1 ) + ( corner( 1, 1 ) - corner( 0, 1 ) ) * u;
			sum += ( top + ( bottom - top ) * v ) * amplitude;
			amplitude *= 0.35;

		} );
		out[ y * n + x ] = sum;

	}
	const order = Array.from( out.keys() ).sort( ( a, b ) => out[ a ] - out[ b ] );
	order.forEach( ( index, rank ) => { out[ index ] = rank / ( order.length - 1 ); } );
	return out;

}

let gustMap: DataTexture | undefined;
function gustTexture(): DataTexture {

	if ( gustMap ) return gustMap;
	const broad = gustChannel( 4, 0x9e3779b9 ), eddies = gustChannel( 6, 0x85ebca6b );
	const data = new Uint8Array( GUST_SIZE * GUST_SIZE * 2 );
	for ( let i = 0; i < broad.length; i ++ ) {

		data[ i * 2 ] = Math.round( broad[ i ] * 255 );
		data[ i * 2 + 1 ] = Math.round( eddies[ i ] * 255 );

	}
	gustMap = new DataTexture( data, GUST_SIZE, GUST_SIZE, RGFormat, UnsignedByteType );
	gustMap.wrapS = gustMap.wrapT = RepeatWrapping;
	gustMap.magFilter = gustMap.minFilter = LinearFilter;
	gustMap.generateMipmaps = false;
	gustMap.name = 'windGusts';
	gustMap.needsUpdate = true;
	return gustMap;

}

// The gust map read at a point (world x, z) in the wind's frame: the broad gusts and the eddies,
// each scrolled with its own travel, and the gust's strength they make.
function gustReads( wind: WindState, position: Node<'vec2'> ) {

	const direction = wind.direction;
	const across = vec2( direction.y.negate(), direction.x );
	const a = dot( position, direction ), c = dot( position, across );
	const broad = texture( gustTexture(), vec2( a.sub( wind.gustScroll.x ).div( GUST_ALONG ), c.div( GUST_ACROSS ) ) ).level( float( 0 ) ).x;
	const eddy = texture( gustTexture(), vec2( a.sub( wind.gustScroll.y ).div( EDDY_TILE ), c.div( EDDY_TILE ).add( 0.37 ) ) ).level( float( 0 ) ).y;
	const gust = smoothstep( 0.3, 0.95, broad.mul( 1 - EDDY_SHARE ).add( eddy.mul( EDDY_SHARE ) ) );
	return { direction, across, eddy, gust };

}

/** The gust's strength at a point (world x, z), 0 between gusts and 1 at a gust's core: the one
 * gust `windField` leans the plants with, for everything else the gusts touch (the sea's cat's
 * paws, SeaDetail.ts). Plain nodes, no function: callable in any stage, and in a vertex stage
 * whose result reaches a varying. Two texture reads. */
export function gustAt( wind: WindState, position: Node<'vec2'> ): Node<'float'> {

	return gustReads( wind, position ).gust;

}

/** The wind at a point on the island (world x, z), for the vertex stage of vegetation: gusts are a
 * noise field scrolled with the wind's integrated travel, so they visibly sweep across the meadow
 * (the scrolled noise wind of Ghost of Tsushima: Wohllaib, GDC 2021). Returns
 * ( direction x, direction z, lean, gust ): the local wind's unit direction (veering a little in
 * the eddies), the lean it gives a plant (tip offset over height, see LEAN_REF) and the gust's
 * strength, 0 between gusts and 1 at a gust's core. Two texture reads. */
export function windField( wind: WindState, position: Node<'vec2'> ): Node<'vec4'> {

	return Fn( () => {

		const { direction, across, eddy, gust } = gustReads( wind, position );
		const x = leanLoad( wind, gust );
		const eased = x.div( x.div( MAX_LEAN ).add( 1 ) );
		// (an exact 0 above at fair's wind and below: the eased lean to the bit)
		const lean = eased.add( pressedLean( x ).sub( eased ).mul( pressing( wind ) ) );
		const veer = normalize( direction.add( across.mul( eddy.sub( 0.5 ).mul( 0.45 ) ) ) );
		return vec4( veer, lean, gust );

	} )() as Node<'vec4'>;

}

/** The linear lean a wind gives a plant at a gust's strength `gust` (0..1): its pressure times the
 * calm share plus the gust's, the load in the lean's unit (tip offset over height, k0 W). */
export function leanLoad( wind: WindState, gust: Node<'float'> ): Node<'float'> {

	return wind.pressure.mul( gust.mul( wind.gustLean ).add( MEAN_LEAN ) );

}

/** A blade's lean (tip offset over height) under the linear lean `x` (`leanLoad`, scaled by the
 * kind's length and stiffness): the elastica's, x / sqrt( 1 + PRESS_SATURATION |x| ), odd in x. */
export function pressedLean( x: Node<'float'> ): Node<'float'> {

	return x.mul( pressedStiffening( x ) );

}

/** The pressed lean over the linear one at `x` (the secant of `pressedLean`): how much less a
 * pressed plant answers a change of load, 1 at rest. */
export function pressedStiffening( x: Node<'float'> ): Node<'float'> {

	return inverseSqrt( abs( x ).mul( PRESS_SATURATION ).add( 1 ) );

}

/** The linear lean that holds a plant at the pressed lean `y` (>= 0), over `y`: the inverse of
 * `pressedLean` divided by its argument, ( a y + sqrt( a^2 y^2 + 4 ) ) / 2 at a = PRESS_SATURATION,
 * 1 at rest. */
export function pressedLoadRatio( y: Node<'float'> ): Node<'float'> {

	return y.mul( PRESS_SATURATION ).add( y.mul( y ).mul( PRESS_SATURATION * PRESS_SATURATION ).add( 4 ).sqrt() ).mul( 0.5 );

}

/** How far the plants have gone over to the elastica's lean (`pressedLean`): 0 up to fair's
 * pressure, exactly, and 1 from twice it (5.4 m/s) up. */
export function pressing( wind: WindState ): Node<'float'> {

	return clampNode( wind.pressure.sub( 1 ), 0, 1 );

}

/** sin( 2 pi rate time + phase ) for the vegetation's clock (`clock`, scene seconds): `rate` in
 * Hz with at most three decimals, so it stays seamless where the clock wraps; it refuses any other
 * rate (whole cycles per CLOCK_PERIOD) when the shader is built. */
export function wave( time: Node<'float'>, rate: number, phase: Node<'float'> | number = 0 ): Node<'float'> {

	if ( Math.abs( rate * CLOCK_PERIOD - Math.round( rate * CLOCK_PERIOD ) ) > 1e-6 ) throw new RangeError( `wave: ${ rate } Hz is not whole cycles per ${ CLOCK_PERIOD } s` );
	return sin( fract( time.mul( rate ) ).mul( Math.PI * 2 ).add( phase ) );

}

/** The sway of a plant about its lean, travelling downwind with its neighbours: sin of `cycles`
 * whole swings per GUST_ALONG of `swayScroll`, less the
 * root's place along the wind over SWAY_SPREAD, plus `phase`. Its frequency is the kind's natural
 * one, `swayFrequency( cycles )`, whatever the wind (the scroll runs at REFERENCE_SPEED: a fair
 * wind's travel, so fair's sway is the gusts' own), whole swings per tile keep it seamless where
 * the scroll wraps, and plants side by side across the wind swing together. `cycles` must be a
 * whole number. */
export function gustWave( wind: WindState, position: Node<'vec2'>, cycles: number, phase: Node<'float'> | number = 0 ): Node<'float'> {

	return sin( gustTravel( wind, position, cycles ).add( phase ) );

}

/** `gustWave`'s angle at a point (world x, z) before a plant's own `phase` (0..2 pi): the same for
 * every part of a plant rooted there. */
export function gustTravel( wind: WindState, position: Node<'vec2'>, cycles: number ): Node<'float'> {

	if ( ! Number.isInteger( cycles ) ) throw new RangeError( `gustWave: ${ cycles } is not a whole number of swings per gust tile` );
	const travel = wind.swayScroll.mul( cycles / GUST_ALONG ).sub( dot( position, wind.direction ).div( SWAY_SPREAD ) );
	return fract( travel ).mul( TAU );

}

/** A plant's own swing about its lean, in LEAN_REF's unit (multiply by LEAN_REF for tip offset
 * over height): about a sixth of the lean on a fair day (the probe's swing over lean, 0.15 - 0.2),
 * wider in a gust and with the wind. */
export function swingOf( wind: WindState, gust: Node<'float'> ): Node<'float'> {

	return wind.breeze.mul( gust.mul( 0.32 ).add( 0.09 ) );

}

/** A plant's own share of the sway, from a hash of its root: a phase within +-0.4 rad and a gain
 * within +-10 %, small enough that neighbours stay in step (`gustWave`). */
export function swayJitter( root: Node<'vec2'> ): { phase: Node<'float'>; gain: Node<'float'> } {

	const gain = fract( sin( dot( root, vec2( 39.3468, 11.135 ) ) ).mul( 24634.6345 ) );
	return { phase: rootPhase( root ).div( TAU ).sub( 0.5 ).mul( 0.8 ), gain: gain.sub( 0.5 ).mul( 0.2 ).add( 1 ) };

}

/** A vegetation material's wind: its swayed vertex position (in the space of its
 * `positionNode`, world space for every vegetation mesh here) as a function of the wind's state
 * alone, the vertex's own inputs (rest position, root, amplitudes) bound inside. The material is
 * drawn with `( shared.wind )`; evaluated with `( shared.wind.previous )` in the same vertex stage
 * it gives where the vertex was in the frame before, for motion vectors. */
export type WindDisplacement = ( wind: WindState ) => Node<'vec3'>;

/** Record `displacement` on a material (and return its pose for the current frame). */
export function setWindDisplacement( material: { userData: Record<string, unknown> }, displacement: WindDisplacement, wind: WindState ): Node<'vec3'> {

	material.userData.windDisplacement = displacement;
	return displacement( wind );

}

/** The wind displacement a vegetation material was built with, if any. */
export function windDisplacement( material: { userData: Record<string, unknown> } ): WindDisplacement | undefined {

	return material.userData.windDisplacement as WindDisplacement | undefined;

}

/** A hash of a plant's root (world x, z), 0..1. */
export function rootHash( root: Node<'vec2'> ): Node<'float'> {

	return fract( sin( dot( root, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) );

}

/** A hash of a plant's root (world x, z) to a phase, 0..2 pi. */
export function rootPhase( root: Node<'vec2'> ): Node<'float'> {

	return rootHash( root ).mul( Math.PI * 2 );

}

/** CPU integration of weather wind, independent of accelerated celestial time. Weather
 * already eases its speed/heading; this class integrates that changing velocity rather than
 * multiplying it by the elapsed scene time, which would teleport clouds and plant phases. */
export class Wind {

	readonly uniforms: WindUniforms;
	private currentSpeed = REFERENCE_SPEED;
	private currentHeading = HEADING;
	private currentGustiness = REFERENCE_GUSTINESS;
	private elapsed = 0;
	private travel = 0; // integrated along-wind travel, m (float64 here; wrapped for the shaders)
	private swayTravel = 0; // the sway's clock: scene seconds times REFERENCE_SPEED, m
	private readonly previousVelocity = new Vector2();

	constructor( uniforms = createWindUniforms(), settings: WindSettings = {} ) {

		this.uniforms = uniforms;
		this.reset( settings );

	}

	get speed(): number { return this.currentSpeed; }
	get heading(): number { return this.currentHeading; }
	get gustiness(): number { return this.currentGustiness; }
	get time(): number { return this.elapsed; }

	/** The wind the sea's spectrum starts from (OceanFFT's `windSpeed`, `windDirection` and
	 * `swellHeading`): REFERENCE_SPEED and the prevailing heading, which the weather's own speed and
	 * heading replace (OceanFFT.setWind), so a page that changed its weather draws the sea a page
	 * loaded in it draws; the swell keeps the prevailing heading. */
	get spectrumWind(): { windSpeed: number; windDirection: number; swellHeading: number } {

		return { windSpeed: REFERENCE_SPEED, windDirection: PREVAILING_HEADING, swellHeading: PREVAILING_HEADING };

	}

	// Explicit seek/startup only. Reconstructing a fixed preset at time t is deterministic;
	// a live weather change must call update so its existing travel history is preserved.
	reset( { speed = REFERENCE_SPEED, heading = HEADING, gustiness = REFERENCE_GUSTINESS, time = 0 }: WindSettings = {} ): void {

		validate( speed, heading, gustiness, time );
		this.publish( speed, heading, gustiness );
		this.elapsed = time;
		this.uniforms.displacement.value.copy( this.uniforms.velocity.value ).multiplyScalar( time );
		this.travel = time * speed;
		this.swayTravel = time * REFERENCE_SPEED;
		this.publishVegetation();
		this.keepPrevious();

	}

	update( dt: number, speed = this.currentSpeed, heading = this.currentHeading, gustiness = this.currentGustiness ): void {

		validate( speed, heading, gustiness, dt );
		this.keepPrevious();
		this.integrate( dt, speed, heading, gustiness );
		// (debug) the vegetation's wind held: its clocks back to the last frame's, no motion
		if ( debugFlags.windFreeze === true ) this.hold();

	}

	/** A cut of the temporal modes' history (Motion.ts `taaCut`): the previous frame's wind becomes
	 * the current one, so nothing sways across the cut. */
	cut(): void {

		this.keepPrevious();

	}

	private integrate( dt: number, speed: number, heading: number, gustiness: number ): void {

		const previousSpeed = this.currentSpeed;
		this.previousVelocity.copy( this.uniforms.velocity.value );
		this.publish( speed, heading, gustiness );
		if ( dt === 0 ) return;
		this.elapsed += dt;
		// Trapezoidal integration follows the smoothly transitioning CPU weather state and
		// does not change when a rendering-quality setting changes its update cadence.
		this.uniforms.displacement.value.addScaledVector( this.previousVelocity.add( this.uniforms.velocity.value ), dt * 0.5 );
		this.travel += dt * ( previousSpeed + speed ) * 0.5;
		this.swayTravel += dt * REFERENCE_SPEED;
		this.publishVegetation();

	}

	// windFreeze: the integrated clocks keep the values `previous` holds, and `previous` takes the
	// rest of the current state (the weather's direction and pressure), so both stay equal.
	private hold(): void {

		const u = this.uniforms, p = u.previous;
		u.clock.value = p.clock.value;
		u.swayScroll.value = p.swayScroll.value;
		u.gustScroll.value.copy( p.gustScroll.value );
		this.keepPrevious();

	}

	// Called once per rendered frame (update) before the new state: `previous` then holds what the
	// last frame was drawn with.
	private keepPrevious(): void {

		const u = this.uniforms, p = u.previous;
		p.direction.value.copy( u.direction.value );
		p.pressure.value = u.pressure.value;
		p.breeze.value = u.breeze.value;
		p.gustLean.value = u.gustLean.value;
		p.clock.value = u.clock.value;
		p.swayScroll.value = u.swayScroll.value;
		p.gustScroll.value.copy( u.gustScroll.value );

	}

	private publishVegetation(): void {

		const u = this.uniforms;
		u.clock.value = this.elapsed % CLOCK_PERIOD;
		u.swayScroll.value = this.swayTravel % GUST_ALONG;
		u.gustScroll.value.set( this.travel % GUST_ALONG, this.travel * EDDY_RATE % EDDY_TILE );

	}

	private publish( speed: number, heading: number, gustiness: number ): void {

		const angle = ( ( heading % 360 ) + 360 ) % 360 * Math.PI / 180;
		this.currentSpeed = speed;
		this.currentHeading = heading;
		this.currentGustiness = gustiness;
		// Match ShoreWaves.setDirection: the positive inverse FFT propagates opposite k.
		this.uniforms.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );
		this.uniforms.velocity.value.copy( this.uniforms.direction.value ).multiplyScalar( speed );
		const ratio = speed / REFERENCE_SPEED;
		this.uniforms.breeze.value = ratio;
		this.uniforms.pressure.value = ratio * ratio;
		this.uniforms.gustLean.value = gustLeanOf( gustiness );
		this.uniforms.gale.value = clamp( ratio - 1.5, 0, 1.6 );

	}

}
