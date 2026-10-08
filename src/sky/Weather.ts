export type WeatherName = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog';
export type WeatherQuality = 'low' | 'medium' | 'high';

export interface WeatherState {

	coverage: number;
	density: number;
	directVisibility: number;
	ambientGain: number;
	// Air extinction per metre at sea level, faded in across the scene's clear foreground. A clear
	// maritime day sees 20 - 50 km (Koschmieder: 3.912 / extinction), so clear and fair air stay
	// near 1 - 2e-4; cloud, rain and fog thicken it.
	haze: number;
	windSpeed: number; // m/s; kept within a calm coastal range
	windDirection: number; // degrees, using the ocean spectrum's heading convention
	rain: number;
	// Sea fog: 0 none, 1 a dense bank a few hundred metres deep in visibility.
	fog: number;
	// Thunderstorm: lightning, storm seas and whitecaps (0 none, 1 a full storm).
	storm: number;
	// Thin, high cirrus veils above the cumulus layer.
	cirrus: number;
	wetness: number;
	// Rain that fell recently: showers linger in the air nearby for a few minutes after the
	// rain overhead stops, long enough for a rainbow (0 to 1).
	showers: number;

}

type Preset = Omit<WeatherState, 'wetness' | 'showers'>;

// The atmosphere retains its colour. Cloud extinction, diffuse fill and distant air change
// together; none of these presets adds a grey screen veil. Fog is a low layer over the sea that
// the camera looks through, not a tint over the frame.
export const WEATHER_PRESETS: Readonly<Record<WeatherName, Readonly<Preset>>> = {
	clear: { coverage: 0, density: 0.8, directVisibility: 1, ambientGain: 1, haze: 0.00012, windSpeed: 2.8, windDirection: 40, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	fair: { coverage: 0.32, density: 0.9, directVisibility: 0.97, ambientGain: 0.99, haze: 0.0002, windSpeed: 3.8, windDirection: 40, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	cloudy: { coverage: 0.67, density: 1.05, directVisibility: 0.78, ambientGain: 0.91, haze: 0.00042, windSpeed: 4.3, windDirection: 40, rain: 0, fog: 0, storm: 0, cirrus: 0.15 },
	overcast: { coverage: 0.94, density: 1.6, directVisibility: 0.3, ambientGain: 0.76, haze: 0.0016, windSpeed: 4.6, windDirection: 40, rain: 0, fog: 0.08, storm: 0, cirrus: 0 },
	rain: { coverage: 1, density: 2.6, directVisibility: 0.14, ambientGain: 0.62, haze: 0.0025, windSpeed: 5.2, windDirection: 40, rain: 0.75, fog: 0.22, storm: 0, cirrus: 0 },
	// A squall: the darkest deck, heavy rain, gale-force wind and a rough, white-capped sea.
	storm: { coverage: 1, density: 3.4, directVisibility: 0.06, ambientGain: 0.45, haze: 0.0035, windSpeed: 11, windDirection: 40, rain: 1, fog: 0.3, storm: 1, cirrus: 0 },
	// Sea fog forms in calm, moist air under thin high cloud; the sun shows as a pale disk.
	fog: { coverage: 0.75, density: 0.85, directVisibility: 0.6, ambientGain: 0.92, haze: 0.0012, windSpeed: 1.8, windDirection: 40, rain: 0, fog: 1, storm: 0, cirrus: 0.4 },
};

export interface WeatherQualityProfile {

	cloudSteps: number;
	panoramaWidth: number;
	panoramaHeight: number;
	skyUpdateInterval: number;
	underwaterShadowInterval: number; // refracted sun map; the sun's own map steps with the key light (SunShadow)
	rainDrops: number;

}

// Intervals are seconds of wall time. The controller never uses a quality profile to alter
// weather state, so changing render quality cannot change the time, rain or lighting mood.
export const WEATHER_QUALITY: Readonly<Record<WeatherQuality, Readonly<WeatherQualityProfile>>> = {
	low: { cloudSteps: 6, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 1.2, underwaterShadowInterval: 0.2, rainDrops: 16384 },
	medium: { cloudSteps: 10, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 0.8, underwaterShadowInterval: 0.12, rainDrops: 32768 },
	high: { cloudSteps: 14, panoramaWidth: 512, panoramaHeight: 256, skyUpdateInterval: 0.5, underwaterShadowInterval: 0.08, rainDrops: 49152 },
};

// Auto weather: from each state, the next one and its weight. Rain builds through overcast
// and clears through cloud; fair weather is the most common resting state.
const NEXT: Readonly<Record<WeatherName, ReadonlyArray<readonly [ WeatherName, number ]>>> = {
	clear: [ [ 'fair', 0.65 ], [ 'cloudy', 0.2 ], [ 'fog', 0.15 ] ],
	fair: [ [ 'clear', 0.3 ], [ 'cloudy', 0.5 ], [ 'overcast', 0.1 ], [ 'fog', 0.1 ] ],
	cloudy: [ [ 'fair', 0.45 ], [ 'overcast', 0.35 ], [ 'rain', 0.2 ] ],
	overcast: [ [ 'rain', 0.5 ], [ 'cloudy', 0.45 ], [ 'storm', 0.05 ] ],
	rain: [ [ 'overcast', 0.5 ], [ 'cloudy', 0.3 ], [ 'storm', 0.2 ] ],
	storm: [ [ 'rain', 0.75 ], [ 'overcast', 0.25 ] ],
	fog: [ [ 'clear', 0.4 ], [ 'fair', 0.6 ] ],
};

/** A weather change as it sweeps the sky: values at the start and end, and the linear
 * progress reached at the island. Places upwind are further along, places downwind behind. */
export interface WeatherFront {
	from: Readonly<Preset>;
	to: Readonly<Preset>;
	progress: number;
}

const fields = Object.keys( WEATHER_PRESETS.clear ) as ( keyof Preset )[];
const smooth = ( t: number ) => t * t * ( 3 - 2 * t );
const smoothIntegral = ( t: number ) => t * t * t * ( 1 - 0.5 * t );
// Signed change of heading along the shorter arc, so 350° to 10° turns 20°, not 340°.
const headingDelta = ( from: number, to: number ) => ( ( ( to - from ) % 360 ) + 540 ) % 360 - 180;

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
	// Auto weather: a seeded chain, so a given start and time always give the same sky.
	auto = false;
	private dwell = 0;
	private seed = 0x5eed;

	constructor( name: WeatherName = 'fair' ) {

		const preset = presetFor( name );
		// Loading a rainy preset represents established weather for repeatable review captures.
		// Subsequent weather changes preserve moisture and let the independent drying model run.
		this.current = { ...preset, wetness: preset.rain * 0.8, showers: preset.rain };
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;

	}

	get state(): Readonly<WeatherState> { return this.current; }
	get target(): WeatherName { return this.targetName; }
	get progress(): number { return this.duration > 0 ? this.elapsed / this.duration : 1; }
	get front(): WeatherFront { return { from: this.from, to: this.destination, progress: this.progress }; }

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
		this.dwell = 0;
		if ( duration === 0 ) for ( const key of fields ) this.current[ key ] = preset[ key ];

	}

	private random(): number {

		// mulberry32
		let t = this.seed = ( this.seed + 0x6D2B79F5 ) | 0;
		t = Math.imul( t ^ ( t >>> 15 ), t | 1 );
		t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	}

	// Rest for 90 to 240 seconds, then move to a neighbouring state over 30 to 60 seconds.
	private advanceAuto( dt: number ): void {

		if ( this.duration > this.elapsed ) return;
		if ( this.dwell <= 0 ) this.dwell = 90 + this.random() * 150;
		this.dwell -= dt;
		if ( this.dwell > 0 ) return;
		let pick = this.random();
		const options = NEXT[ this.targetName ];
		let next = options[ options.length - 1 ][ 0 ];
		for ( const [ name, weight ] of options ) {

			if ( pick < weight ) { next = name; break; }
			pick -= weight;

		}
		this.setWeather( next, 30 + this.random() * 30 );

	}

	update( dt: number ): void {

		requireDuration( dt, 'Weather delta time' );
		if ( dt === 0 ) return;
		if ( this.auto ) this.advanceAuto( dt );
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
			for ( const key of fields ) {

				const delta = key === 'windDirection' ? headingDelta( this.from[ key ], this.destination[ key ] ) : this.destination[ key ] - this.from[ key ];
				this.current[ key ] = b === 1 ? this.destination[ key ] : this.from[ key ] + delta * blend;

			}

		}

		const rain = Math.min( 1, Math.max( 0, rainIntegral / dt ) );
		const soak = rain / 25, dry = ( 1 - rain ) / 240;
		const rate = soak + dry;
		const equilibrium = soak / rate;
		// Stable bounded moisture: rain darkens exposed material over tens of seconds, whereas
		// drying takes minutes. A zero-time update leaves both transition and wetness untouched.
		this.current.wetness = Math.min( 1, Math.max( 0,
			equilibrium + ( this.current.wetness - equilibrium ) * Math.exp( - rate * dt ) ) );
		this.current.showers = Math.max( this.current.rain, this.current.showers * Math.exp( - dt / 90 ) );

	}

}
