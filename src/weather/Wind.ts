import { DataTexture, LinearFilter, RGFormat, RepeatWrapping, UnsignedByteType, Vector2, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, dot, float, fract, normalize, sin, smoothstep, texture, uniform, vec2, vec4 } from 'three/tsl';
import { debugFlags } from '../debug/DebugFlags.ts';

// The weather's wind, integrated on the CPU, and the one wind field all vegetation moves in.
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
// (the rim bushes 30, about 0.9 Hz in a fair wind; flowers 40; grass 50; the palm half a bush's).
// Leaf edges, sprays and fronds still flutter on their own phases, a small motion on top, faster as
// the wind rises. Grass tufts bend with the field at their root, flowers and the turf skirt follow
// the same field, and rim trails swing like pendulums with the same sway (RimFoliage.ts).
//
// Everything is a function of the wind's integrated clocks and travel (`clock`, `flutter`,
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
// over its tiles, `gustWave`'s whole swings per tile), so the difference of the two poses is the frame's motion alone
// (tools/verify-wind.mjs checks the sources).
// The URL option `windView` shows this field and every plant's answer to it, and
// `__PONLAI__.windProbe` measures them (src/debug/WindView.ts, WindProbe.ts; docs/tools.md).
// `debugFlags.windFreeze = true` holds the vegetation's wind (its clocks and gust scroll, previous
// equal to current) while the scene clock runs, for clips that want only the shadows or the jitter
// to move; the clouds and the sea keep their wind.

const BASE_SPEED = 3.8;
const CLOUD_DRIFT = 0.21;
const clamp = ( value: number, low: number, high: number ) => Math.max( low, Math.min( high, value ) );
// The integrated gust phase (`uniforms.phase`) and the amplitude (`uniforms.strength`) drove the
// old global-sine sway; no shader reads them now, and they stay as CPU values the weather checks
// read (tools/verify-weather.mjs, verify-wind.mjs). The phase wraps at 1600 turns, a whole number
// of periods for the rates that sway used, which keeps the float32 phase precise in long sessions.
const PHASE_PERIOD = 1600 * 2 * Math.PI;
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
// times a calm share plus the gust's, eased toward MAX_LEAN: about 0.035 between gusts and 0.145
// at a gust's core on a fair day (four times as much), 0.09 and 0.34 in a storm's gale, and
// nothing in still air. A plant leans downwind all the time and a gust bends it well over: the
// gust's share is several times the calm one so the gusts read as bright and dark bands sweeping
// the meadow (docs/art-direction.md), while each plant's own swing stays a sixth of its lean.
const MEAN_LEAN = 0.035;
const GUST_LEAN = 0.13;
const MAX_LEAN = 1.2;
// The plants' own sway about the lean travels with the gusts (`gustWave`): its crests lie
// SWAY_SPREAD metres apart along the wind, so neighbours within a metre or two move together and
// plants a few metres apart drift out of step. With a whole-plant sway near 1 Hz the crests run
// about twice the wind's speed (a crest spacing of wind speed / frequency, 4 m, would put plants
// a metre apart along the wind a quarter turn out of step, which reads as each plant on its own).
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
		clock: uniform( 0 ), // scene seconds modulo CLOCK_PERIOD: plants' natural sway
		flutter: uniform( 0 ), // seconds that run faster in strong wind, modulo CLOCK_PERIOD: leaves
		gustScroll: uniform( new Vector2() ), // along-wind travel of the gusts and eddies, wrapped to their tiles, m
	};

}

/** The inputs of every vegetation wind displacement besides the vertex's own (its rest position,
 * root and amplitudes). `createWindUniforms` holds two: the frame being rendered (the uniforms
 * themselves) and the frame rendered before it (`previous`), for motion vectors. */
export type WindState = ReturnType<typeof vegetationWind>;

/** A wind state's values as two vec4s, ( direction, pressure, breeze ) and ( clock, flutter, gust
 * scroll ), and the state read back from two such nodes: a debug kernel's per-step wind
 * (src/debug/WindProbe.ts), so the gust scroll stays read here alone (tools/verify-wind.mjs). */
export function packWindState( state: WindState ): number[] {

	return [ state.direction.value.x, state.direction.value.y, state.pressure.value, state.breeze.value,
		state.clock.value, state.flutter.value, state.gustScroll.value.x, state.gustScroll.value.y ];

}

export function windStateOf( a: Node<'vec4'>, b: Node<'vec4'> ): WindState {

	return { direction: a.xy, pressure: a.z, breeze: a.w, clock: b.x, flutter: b.y, gustScroll: b.zw } as unknown as WindState;

}

/** Add this object to shared before constructing materials, then give that same object to
 * Wind. Every consumer holds the same node identities throughout weather transitions. */
export function createWindUniforms() {

	const angle = 40 * Math.PI / 180;
	const direction = new Vector2( - Math.cos( angle ), - Math.sin( angle ) );
	return {
		...vegetationWind( direction ),
		velocity: uniform( direction.clone().multiplyScalar( BASE_SPEED ) ), // air velocity, m/s
		strength: uniform( 1 ), // vegetation amplitude relative to the authored fair-weather wind
		phase: uniform( 0 ), // integrated gust phase, radians, modulo PHASE_PERIOD; never time * changing speed
		displacement: uniform( new Vector2() ), // integrated air displacement, metres
		cloudOffset: uniform( new Vector2() ), // offset for a density field sampled at p + offset
		oceanGain: uniform( new Vector3( 1, 1, 1 ) ), // amplitude, not energy, for the FFT cascades
		// The vegetation's wind as it was for the previous rendered frame: equal to the current
		// one while paused and after a seek or reset (no motion across a jump).
		previous: vegetationWind( direction ),
		gustMap: gustTexture(),
	};

}

export type WindUniforms = ReturnType<typeof createWindUniforms>;

export interface WindSettings {

	speed?: number;
	heading?: number; // OceanSpectrum Fourier heading, degrees; IFFT travel is opposite
	time?: number;

}

// Leaves flutter faster as the wind rises: half their rate in still air, twice it in a gale.
const flutterRate = ( speed: number ) => 0.5 + 0.5 * speed / BASE_SPEED;

function validate( speed: number, heading: number, time: number ): void {

	if ( ! Number.isFinite( speed ) || speed < 0 ) throw new RangeError( 'Wind speed must be finite and non-negative' );
	if ( ! Number.isFinite( heading ) ) throw new RangeError( 'Wind heading must be finite' );
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

/** The wind at a point on the island (world x, z), for the vertex stage of vegetation: gusts are a
 * noise field scrolled with the wind's integrated travel, so they visibly sweep across the meadow
 * (the scrolled noise wind of Ghost of Tsushima: Wohllaib, GDC 2021). Returns
 * ( direction x, direction z, lean, gust ): the local wind's unit direction (veering a little in
 * the eddies), the lean it gives a plant (tip offset over height, see LEAN_REF) and the gust's
 * strength, 0 between gusts and 1 at a gust's core. Two texture reads. */
export function windField( wind: WindState, position: Node<'vec2'> ): Node<'vec4'> {

	return Fn( () => {

		const direction = wind.direction;
		const across = vec2( direction.y.negate(), direction.x );
		const a = dot( position, direction ), c = dot( position, across );
		const broad = texture( gustTexture(), vec2( a.sub( wind.gustScroll.x ).div( GUST_ALONG ), c.div( GUST_ACROSS ) ) ).level( float( 0 ) ).x;
		const eddy = texture( gustTexture(), vec2( a.sub( wind.gustScroll.y ).div( EDDY_TILE ), c.div( EDDY_TILE ).add( 0.37 ) ) ).level( float( 0 ) ).y;
		const gust = smoothstep( 0.3, 0.95, broad.mul( 1 - EDDY_SHARE ).add( eddy.mul( EDDY_SHARE ) ) );
		const x = wind.pressure.mul( gust.mul( GUST_LEAN ).add( MEAN_LEAN ) );
		const lean = x.div( x.div( MAX_LEAN ).add( 1 ) );
		const veer = normalize( direction.add( across.mul( eddy.sub( 0.5 ).mul( 0.45 ) ) ) );
		return vec4( veer, lean, gust );

	} )() as Node<'vec4'>;

}

/** sin( 2 pi rate time + phase ) for one of the vegetation clocks (`clock`, `flutter`): `rate`
 * in Hz with at most three decimals, so it stays seamless where the clock wraps. */
export function wave( time: Node<'float'>, rate: number, phase: Node<'float'> | number = 0 ): Node<'float'> {

	return sin( fract( time.mul( rate ) ).mul( Math.PI * 2 ).add( phase ) );

}

/** The sway of a plant about its lean, driven by the gusts' own travel rather than a clock of its
 * own: sin of `cycles` whole swings per GUST_ALONG of the gusts'
 * travel, less the root's place along the wind over SWAY_SPREAD, plus `phase`. Its frequency is
 * the wind's speed times cycles / GUST_ALONG (it quickens in a stronger wind and stops in still
 * air), whole swings per tile keep it seamless where the scroll wraps, and plants side by side
 * across the wind swing together. `cycles` must be a whole number. */
export function gustWave( wind: WindState, position: Node<'vec2'>, cycles: number, phase: Node<'float'> | number = 0 ): Node<'float'> {

	if ( ! Number.isInteger( cycles ) ) throw new RangeError( `gustWave: ${ cycles } is not a whole number of swings per gust tile` );
	const travel = wind.gustScroll.x.mul( cycles / GUST_ALONG ).sub( dot( position, wind.direction ).div( SWAY_SPREAD ) );
	return sin( fract( travel ).mul( TAU ).add( phase ) );

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

/** A hash of a plant's root (world x, z) to a phase, 0..2 pi. */
export function rootPhase( root: Node<'vec2'> ): Node<'float'> {

	return fract( sin( dot( root, vec2( 12.9898, 78.233 ) ) ).mul( 43758.5453 ) ).mul( Math.PI * 2 );

}

/** CPU integration of weather wind, independent of accelerated celestial time. Weather
 * already eases its speed/heading; this class integrates that changing velocity rather than
 * multiplying it by the elapsed scene time, which would teleport clouds and plant phases. */
export class Wind {

	readonly uniforms: WindUniforms;
	private currentSpeed = BASE_SPEED;
	private currentHeading = 40;
	private elapsed = 0;
	private travel = 0; // integrated along-wind travel, m (float64 here; wrapped for the shaders)
	private flutterTime = 0;
	private readonly previousVelocity = new Vector2();

	constructor( uniforms = createWindUniforms(), settings: WindSettings = {} ) {

		this.uniforms = uniforms;
		this.reset( settings );

	}

	get speed(): number { return this.currentSpeed; }
	get heading(): number { return this.currentHeading; }
	get time(): number { return this.elapsed; }

	// Explicit seek/startup only. Reconstructing a fixed preset at time t is deterministic;
	// a live weather change must call update so its existing travel history is preserved.
	reset( { speed = BASE_SPEED, heading = 40, time = 0 }: WindSettings = {} ): void {

		validate( speed, heading, time );
		this.publish( speed, heading );
		this.elapsed = time;
		this.uniforms.phase.value = ( time * speed / BASE_SPEED * 1.6 ) % PHASE_PERIOD;
		this.uniforms.displacement.value.copy( this.uniforms.velocity.value ).multiplyScalar( time );
		this.uniforms.cloudOffset.value.copy( this.uniforms.displacement.value ).multiplyScalar( - CLOUD_DRIFT );
		this.travel = time * speed;
		this.flutterTime = time * flutterRate( speed );
		this.publishVegetation();
		this.keepPrevious();

	}

	update( dt: number, speed = this.currentSpeed, heading = this.currentHeading ): void {

		validate( speed, heading, dt );
		this.keepPrevious();
		this.integrate( dt, speed, heading );
		// (debug) the vegetation's wind held: its clocks back to the last frame's, no motion
		if ( debugFlags.windFreeze === true ) this.hold();

	}

	/** A cut of the temporal modes' history (Motion.ts `taaCut`): the previous frame's wind becomes
	 * the current one, so nothing sways across the cut. */
	cut(): void {

		this.keepPrevious();

	}

	private integrate( dt: number, speed: number, heading: number ): void {

		const previousSpeed = this.currentSpeed;
		this.previousVelocity.copy( this.uniforms.velocity.value );
		this.publish( speed, heading );
		if ( dt === 0 ) return;
		this.elapsed += dt;
		// Trapezoidal integration follows the smoothly transitioning CPU weather state and
		// does not change when a rendering-quality setting changes its update cadence.
		this.uniforms.phase.value = ( this.uniforms.phase.value + dt * ( previousSpeed + speed ) * 0.5 / BASE_SPEED * 1.6 ) % PHASE_PERIOD;
		this.uniforms.displacement.value.addScaledVector( this.previousVelocity.add( this.uniforms.velocity.value ), dt * 0.5 );
		this.uniforms.cloudOffset.value.copy( this.uniforms.displacement.value ).multiplyScalar( - CLOUD_DRIFT );
		this.travel += dt * ( previousSpeed + speed ) * 0.5;
		this.flutterTime += dt * ( flutterRate( previousSpeed ) + flutterRate( speed ) ) * 0.5;
		this.publishVegetation();

	}

	// windFreeze: the integrated clocks keep the values `previous` holds, and `previous` takes the
	// rest of the current state (the weather's direction and pressure), so both stay equal.
	private hold(): void {

		const u = this.uniforms, p = u.previous;
		u.clock.value = p.clock.value;
		u.flutter.value = p.flutter.value;
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
		p.clock.value = u.clock.value;
		p.flutter.value = u.flutter.value;
		p.gustScroll.value.copy( u.gustScroll.value );

	}

	private publishVegetation(): void {

		const u = this.uniforms;
		u.clock.value = this.elapsed % CLOCK_PERIOD;
		u.flutter.value = this.flutterTime % CLOCK_PERIOD;
		u.gustScroll.value.set( this.travel % GUST_ALONG, this.travel * EDDY_RATE % EDDY_TILE );

	}

	private publish( speed: number, heading: number ): void {

		const angle = ( ( heading % 360 ) + 360 ) % 360 * Math.PI / 180;
		this.currentSpeed = speed;
		this.currentHeading = heading;
		// Match ShoreWaves.setDirection: the positive inverse FFT propagates opposite k.
		this.uniforms.direction.value.set( - Math.cos( angle ), - Math.sin( angle ) );
		this.uniforms.velocity.value.copy( this.uniforms.direction.value ).multiplyScalar( speed );
		const ratio = speed / BASE_SPEED;
		this.uniforms.strength.value = clamp( ratio, 0, 1.6 );
		this.uniforms.breeze.value = ratio;
		this.uniforms.pressure.value = ratio * ratio;
		// Long swell changes little; local and capillary bands respond more. These gentle
		// amplitude limits keep everyday weather within the island's calm-water design; only a
		// gale (above about 1.5 x the fair-weather wind) builds a rough storm sea beyond them.
		const gale = clamp( ratio - 1.5, 0, 1.6 );
		this.uniforms.oceanGain.value.set(
			clamp( 1 + ( ratio - 1 ) * 0.18, 0.82, 1.15 ) + gale * 1.2,
			clamp( 1 + ( ratio - 1 ) * 0.55, 0.55, 1.45 ) + gale * 1.5,
			clamp( 1 + ( ratio - 1 ) * 0.85, 0.35, 1.65 ) + gale * 0.5,
		);

	}

}
