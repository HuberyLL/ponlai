export type WeatherName = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'rain';
export type WeatherQuality = 'low' | 'medium' | 'high';

export interface WeatherState {

	coverage: number;
	density: number;
	directVisibility: number;
	ambientGain: number;
	// Air extinction per metre, applied only beyond the scene's clear foreground.
	haze: number;
	windSpeed: number; // m/s; kept within a calm coastal range
	windDirection: number; // degrees, using the ocean spectrum's heading convention
	rain: number;
	wetness: number;

}

type Preset = Omit<WeatherState, 'wetness'>;

// The atmosphere retains its colour. Cloud extinction, diffuse fill and distant air change
// together; none of these presets adds a grey screen veil or rough storm seas.
export const WEATHER_PRESETS: Readonly<Record<WeatherName, Readonly<Preset>>> = {
	clear: { coverage: 0, density: 0.8, directVisibility: 1, ambientGain: 1, haze: 0.00035, windSpeed: 2.8, windDirection: 40, rain: 0 },
	fair: { coverage: 0.32, density: 0.9, directVisibility: 0.97, ambientGain: 0.99, haze: 0.0005, windSpeed: 3.8, windDirection: 40, rain: 0 },
	cloudy: { coverage: 0.67, density: 1.05, directVisibility: 0.78, ambientGain: 0.91, haze: 0.0009, windSpeed: 4.3, windDirection: 40, rain: 0 },
	overcast: { coverage: 0.94, density: 1.35, directVisibility: 0.3, ambientGain: 0.76, haze: 0.0016, windSpeed: 4.6, windDirection: 40, rain: 0 },
	rain: { coverage: 1, density: 1.55, directVisibility: 0.14, ambientGain: 0.62, haze: 0.0025, windSpeed: 5.2, windDirection: 40, rain: 0.75 },
};

export interface WeatherQualityProfile {

	cloudSteps: number;
	panoramaWidth: number;
	panoramaHeight: number;
	skyUpdateInterval: number;
	shadowUpdateInterval: number;
	rainDrops: number;

}

// Intervals are seconds of wall time. The controller never uses a quality profile to alter
// weather state, so changing render quality cannot change the time, rain or lighting mood.
export const WEATHER_QUALITY: Readonly<Record<WeatherQuality, Readonly<WeatherQualityProfile>>> = {
	low: { cloudSteps: 6, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 1.2, shadowUpdateInterval: 0.2, rainDrops: 192 },
	medium: { cloudSteps: 10, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 0.8, shadowUpdateInterval: 0.12, rainDrops: 384 },
	high: { cloudSteps: 14, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 0.5, shadowUpdateInterval: 0.08, rainDrops: 640 },
};

const fields = Object.keys( WEATHER_PRESETS.clear ) as ( keyof Preset )[];
const smooth = ( t: number ) => t * t * ( 3 - 2 * t );
const smoothIntegral = ( t: number ) => t * t * t * ( 1 - 0.5 * t );

function presetFor( name: WeatherName ): Readonly<Preset> {

	if ( ! Object.hasOwn( WEATHER_PRESETS, name ) ) throw new RangeError( `Unknown weather preset: ${ String( name ) }` );
	return WEATHER_PRESETS[ name ];

}

function requireDuration( value: number, label: string ): void {

	if ( ! Number.isFinite( value ) || value < 0 ) throw new RangeError( `${ label } must be a finite, non-negative number` );

}

export class Weather {

	private current: WeatherState;
	private from: Preset;
	private destination: Readonly<Preset>;
	private targetName: WeatherName;
	private elapsed = 0;
	private duration = 0;

	constructor( name: WeatherName = 'fair' ) {

		const preset = presetFor( name );
		// Loading a rainy preset represents established weather for repeatable review captures.
		// Subsequent weather changes preserve moisture and let the independent drying model run.
		this.current = { ...preset, wetness: preset.rain * 0.8 };
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;

	}

	get state(): Readonly<WeatherState> { return this.current; }
	get target(): WeatherName { return this.targetName; }
	get progress(): number { return this.duration > 0 ? this.elapsed / this.duration : 1; }

	snapshot(): WeatherState { return { ...this.current }; }

	setWeather( name: WeatherName, duration = 20 ): void {

		const preset = presetFor( name );
		requireDuration( duration, 'Weather transition duration' );
		// Start from the displayed state, including mid-transition values. Reversals never jump
		// back to the previous named preset, and every new transition eases out of its snapshot.
		this.from = { ...this.current };
		this.destination = preset;
		this.targetName = name;
		this.elapsed = 0;
		this.duration = duration;
		if ( duration === 0 ) for ( const key of fields ) this.current[ key ] = preset[ key ];

	}

	update( dt: number ): void {

		requireDuration( dt, 'Weather delta time' );
		if ( dt === 0 ) return;
		const previous = this.elapsed;
		const transitioning = this.duration > previous;
		let rainIntegral = this.current.rain * dt;
		if ( transitioning ) {

			this.elapsed = Math.min( previous + dt, this.duration );
			const a = previous / this.duration, b = this.elapsed / this.duration;
			const movingTime = this.elapsed - previous;
			// Integrate rainfall across smoothstep, including any time beyond the endpoint. This
			// keeps wetness stable with a large manual time step and with interrupted transitions.
			rainIntegral = this.from.rain * movingTime + ( this.destination.rain - this.from.rain ) * this.duration *
				( smoothIntegral( b ) - smoothIntegral( a ) ) + this.destination.rain * ( dt - movingTime );
			const blend = smooth( b );
			for ( const key of fields ) this.current[ key ] = b === 1 ? this.destination[ key ] :
				this.from[ key ] + ( this.destination[ key ] - this.from[ key ] ) * blend;

		}

		const rain = Math.min( 1, Math.max( 0, rainIntegral / dt ) );
		const soak = rain / 25, dry = ( 1 - rain ) / 240;
		const rate = soak + dry;
		const equilibrium = soak / rate;
		// Stable bounded moisture: rain darkens exposed material over tens of seconds, whereas
		// drying takes minutes. A zero-time update leaves both transition and wetness untouched.
		this.current.wetness = Math.min( 1, Math.max( 0,
			equilibrium + ( this.current.wetness - equilibrium ) * Math.exp( - rate * dt ) ) );

	}

}
