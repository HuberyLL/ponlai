import { Vector2, Vector3 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { Fn, dot, sin, uniform } from 'three/tsl';

const BASE_SPEED = 3.8;
const CLOUD_DRIFT = 0.21;
const clamp = ( value: number, low: number, high: number ) => Math.max( low, Math.min( high, value ) );
// Shaders take sines of the phase at these rates: windGust 1 and 2.7; bushes and rim strands
// 13/16 of it, times 1.3, .91 and .83. 1600 turns is a whole number of periods for every one of
// them, so wrapping there is seamless and keeps the float32 phase precise in long sessions.
const PHASE_PERIOD = 1600 * 2 * Math.PI;

/** Add this object to shared before constructing materials, then give that same object to
 * Wind. Every consumer holds the same node identities throughout weather transitions. */
export function createWindUniforms() {

	const angle = 40 * Math.PI / 180;
	const direction = new Vector2( - Math.cos( angle ), - Math.sin( angle ) );
	return {
		direction: uniform( direction ), // world-space travel direction; unit x/z
		velocity: uniform( direction.clone().multiplyScalar( BASE_SPEED ) ), // air velocity, m/s
		strength: uniform( 1 ), // vegetation amplitude relative to the authored fair-weather wind
		phase: uniform( 0 ), // integrated gust phase, radians, modulo PHASE_PERIOD; never time * changing speed
		displacement: uniform( new Vector2() ), // integrated air displacement, metres
		cloudOffset: uniform( new Vector2() ), // offset for a density field sampled at p + offset
		oceanGain: uniform( new Vector3( 1, 1, 1 ) ), // amplitude, not energy, for the FFT cascades
	};

}

export type WindUniforms = ReturnType<typeof createWindUniforms>;

export interface WindSettings {

	speed?: number;
	heading?: number; // OceanSpectrum Fourier heading, degrees; IFFT travel is opposite
	time?: number;

}

function validate( speed: number, heading: number, time: number ): void {

	if ( ! Number.isFinite( speed ) || speed < 0 ) throw new RangeError( 'Wind speed must be finite and non-negative' );
	if ( ! Number.isFinite( heading ) ) throw new RangeError( 'Wind heading must be finite' );
	if ( ! Number.isFinite( time ) || time < 0 ) throw new RangeError( 'Wind time must be finite and non-negative' );

}

// Original travelling gust shared by vegetation types. Their own root/tip weights and
// displacement amplitudes remain responsible for keeping every plant attached to the soil.
export const windGust = Fn( ( [ position, direction, phase ]: [ Node<'vec2'>, Node<'vec2'>, Node<'float'> ] ) => {

	const p = dot( position, direction ).mul( 0.45 ).sub( phase ).toVar();
	return sin( p ).mul( 0.45 ).add( 0.55 ).add( sin( p.mul( 2.7 ).add( position.x.mul( 0.9 ) ) ).mul( 0.2 ) );

} ).setLayout( { name: 'soomiWindGust', type: 'float', inputs: [
	{ name: 'position', type: 'vec2' }, { name: 'direction', type: 'vec2' }, { name: 'phase', type: 'float' },
] } );

/** CPU integration of weather wind, independent of accelerated celestial time. Weather
 * already eases its speed/heading; this class integrates that changing velocity rather than
 * multiplying it by the elapsed scene time, which would teleport clouds and plant phases. */
export class Wind {

	readonly uniforms: WindUniforms;
	private currentSpeed = BASE_SPEED;
	private currentHeading = 40;
	private elapsed = 0;
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

	}

	update( dt: number, speed = this.currentSpeed, heading = this.currentHeading ): void {

		validate( speed, heading, dt );
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
