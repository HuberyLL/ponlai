// Weather presets, their blending and the auto-weather chain. Bad weather dims and desaturates the
// existing light; it never adds a grey screen veil (docs/art-direction.md). A weather change sweeps
// the sky as a front from upwind, and the island's lighting follows the front's progress over the
// island. No tier or knob alters the weather state (Quality.ts).
//
// The wind is a dimension of its own beside the sky (`WIND_LEVELS`, a heading): any kept sky goes
// with any level, as a day's wind follows the pressure pattern rather than the cloud. A real day's
// wind comes from any side with the weather, and swings right round as a front passes; the
// landscape remembers only the prevailing wind (PREVAILING_HEADING: the meadow's exposure, the rim
// grass's combing, and at sea the swell), so those stay on it while the weather's wind and the wind
// sea turn. Over most coasts the wind
// is force 2 - 4 most of the time, force 5 at times and force 6 or more rarely; a cold front
// often leaves a clear, windy day behind it.
// - Levels (U10, the mean wind 10 m up): light 1.5 m/s, gentle 3.8 (fair's wind, at which the
//   plants and the sea were tuned), fresh 7 and strong 11. The gust factor falls a little as the
//   wind rises (light airs are fitful; a strong wind blows steadily hard): 1.5, 1.4, 1.35, 1.3.
// - A kept sky loads with the gentle wind from the prevailing heading; a parked one with its own
//   (`PRESET_WIND`: rain fresh, a storm's squall strong, fog light). `setWeather` keeps the wind's
//   target unless the parked sky named brings its own; `setWind` changes the wind alone.
// - Auto weather: each change of sky also moves the wind one level at most (`NEXT_WIND`, its
//   stronger levels' weights scaled by the coming sky's `WINDIER`: overcast and cloudy raise the
//   wind more often, fair less, a clear sky as often as the base chain, a cold surge's clear day)
//   and turns it to a new heading: the prevailing 40 degrees plus an offset, nine times in ten a
//   triangular one within +-40 degrees (most often near 0), one time in ten from the opposite
//   quadrant (180 +- 45). Over hundreds of hours the wind is gentle 67 % of the time, fresh 16 %,
//   light 13 % and strong 5 % (strong 6 % under overcast, 4 % under fair;
//   tools/verify-weather-state.mjs measures it). The wind's draws take a random stream of their
//   own, so the sky's sequence is the one it was before the wind had levels.
//
// The auto chain's sky takes its draws from one seeded stream (dwell, pick, the front's length, in
// that order each turn), so its future is known: `forecast` reads it ahead without moving it (the
// game's forecast, src/game/ui/Forecast.ts). The chain counts its dwell down by the frames' steps
// from the frame after a front ends, so a turn comes up to a step either side of the time read
// ahead (tools/verify-weather-state.mjs); the forecast is read again as the weather moves on.
//
// Parked weathers (`PARKED_WEATHER`: rain, storm, fog) slowed every line of work down, so until the
// game needs them as pressure (docs/game-design.md) they are out of the rotation: the auto chain
// never reaches them, the production page refuses them (main.ts falls back to fair) and the default
// checks skip them. Their code stays and keeps compiling; debug builds (the dev server, `?debug`)
// still reach every preset, so captures, probes and a later revival can use them.

export type WeatherName = 'clear' | 'fair' | 'cloudy' | 'overcast' | 'rain' | 'storm' | 'fog';

export const PARKED_WEATHER: ReadonlyArray<WeatherName> = [ 'rain', 'storm', 'fog' ];
export const isParkedWeather = ( name: string ): boolean => ( PARKED_WEATHER as readonly string[] ).includes( name );

export interface WeatherState {

	coverage: number;
	density: number;
	directVisibility: number;
	ambientGain: number;
	// Air extinction per metre at sea level, from the camera on (weather/VolumetricHaze.ts). A clear
	// maritime day sees 20 - 50 km (Koschmieder: 3.912 / extinction), so clear and fair air stay
	// near 1 - 2e-4; an overcast or cloudy sea about 10 km (4e-4); rain and fog thicken it.
	haze: number;
	// The weather's one wind, which every part of the scene takes from weather/Wind.ts. The mean
	// wind 10 m up (U10), m/s: its level's (`WIND_LEVELS`).
	windSpeed: number;
	// Degrees, in the ocean spectrum's heading convention: the wind comes from the heading and
	// travels toward the heading plus 180 degrees (40, the prevailing wind: toward 220 degrees,
	// atan2( z, x ) in the world's x-z plane). The sea's spectrum stays on the prevailing heading
	// (Wind.ts `spectrumWind`).
	windDirection: number;
	// The gust factor, a 3 s gust over the mean wind (about 1.2 - 1.3 over open sea, 1.4 - 1.5
	// over land), its level's; the plants' gusts lean them by its excess pressure (Wind.ts).
	gustiness: number;
	rain: number;
	// Sea fog: 0 none, 1 a layer at the cliff's foot that sees 1 km, the threshold of fog (below it
	// mist; VolumetricHaze.ts sets the layer's top and its extinction per unit).
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

/** A transition's endpoint: a sky and a wind. */
type Preset = Omit<WeatherState, 'wetness' | 'showers'>;
type WindFields = 'windSpeed' | 'windDirection' | 'gustiness';
/** A sky preset: everything but the wind. */
type SkyPreset = Omit<Preset, WindFields>;

export type WindLevel = 'light' | 'gentle' | 'fresh' | 'strong';
export const WIND_LEVELS: Readonly<Record<WindLevel, Readonly<Pick<WeatherState, 'windSpeed' | 'gustiness'>>>> = {
	light: { windSpeed: 1.5, gustiness: 1.5 },
	gentle: { windSpeed: 3.8, gustiness: 1.4 },
	fresh: { windSpeed: 7, gustiness: 1.35 },
	strong: { windSpeed: 11, gustiness: 1.3 },
};
/** The prevailing wind's heading (degrees, WeatherState `windDirection`'s convention): the
 * weather's wind turns about it, the landscape and the sea's swell keep it. */
export const PREVAILING_HEADING = 40;
/** A wind to set: its level, its heading, or both (what is left out stays). */
export interface WindChoice { level?: WindLevel; heading?: number }
// The parked skies' own winds; a kept sky has none and takes the wind it is given.
const PRESET_WIND: Partial<Record<WeatherName, WindLevel>> = { rain: 'fresh', storm: 'strong', fog: 'light' };

// The atmosphere retains its colour. Cloud extinction, diffuse fill and distant air change
// together; none of these presets adds a grey screen veil. Fog is a low layer over the sea that
// the camera looks through, not a tint over the frame.
export const WEATHER_PRESETS: Readonly<Record<WeatherName, Readonly<SkyPreset>>> = {
	clear: { coverage: 0, density: 0.8, directVisibility: 1, ambientGain: 1, haze: 0.00012, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	fair: { coverage: 0.32, density: 0.9, directVisibility: 0.97, ambientGain: 0.99, haze: 0.0002, rain: 0, fog: 0, storm: 0, cirrus: 0.3 },
	cloudy: { coverage: 0.67, density: 1.05, directVisibility: 0.78, ambientGain: 0.91, haze: 0.00042, rain: 0, fog: 0, storm: 0, cirrus: 0.15 },
	overcast: { coverage: 0.94, density: 1.6, directVisibility: 0.3, ambientGain: 0.76, haze: 0.00039, rain: 0, fog: 0.08, storm: 0, cirrus: 0 },
	rain: { coverage: 1, density: 2.6, directVisibility: 0.14, ambientGain: 0.62, haze: 0.0025, rain: 0.75, fog: 0.22, storm: 0, cirrus: 0 },
	// A squall: the darkest deck, heavy rain, a strong wind (PRESET_WIND) and a rough, white-capped sea.
	storm: { coverage: 1, density: 3.4, directVisibility: 0.06, ambientGain: 0.45, haze: 0.0035, rain: 1, fog: 0.3, storm: 1, cirrus: 0 },
	// Sea fog forms in calm, moist air under thin high cloud; the sun shows as a pale disk.
	fog: { coverage: 0.75, density: 0.85, directVisibility: 0.6, ambientGain: 0.92, haze: 0.0012, rain: 0, fog: 1, storm: 0, cirrus: 0.4 },
};

// Auto weather: from each state, the next one and its weight. The chain moves among the kept
// presets only (PARKED_WEATHER never appears): cloud thickens through cloudy to overcast and clears
// back the same way; fair weather is the most common resting state. The parked states keep a way
// back, for a page that loaded one in a debug build.
const NEXT: Readonly<Record<WeatherName, ReadonlyArray<readonly [ WeatherName, number ]>>> = {
	clear: [ [ 'fair', 0.75 ], [ 'cloudy', 0.25 ] ],
	fair: [ [ 'clear', 0.35 ], [ 'cloudy', 0.5 ], [ 'overcast', 0.15 ] ],
	cloudy: [ [ 'fair', 0.6 ], [ 'overcast', 0.4 ] ],
	overcast: [ [ 'cloudy', 0.7 ], [ 'fair', 0.3 ] ],
	rain: [ [ 'overcast', 0.6 ], [ 'cloudy', 0.4 ] ],
	storm: [ [ 'overcast', 1 ] ],
	fog: [ [ 'clear', 0.4 ], [ 'fair', 0.6 ] ],
};

// Auto weather's wind: from each level, the next one and its weight, before the coming sky's bias
// (`WINDIER` scales the weights of the levels above the current one). The wind moves one level at
// most per change of sky.
const NEXT_WIND: Readonly<Record<WindLevel, ReadonlyArray<readonly [ WindLevel, number ]>>> = {
	light: [ [ 'light', 0.2 ], [ 'gentle', 0.8 ] ],
	gentle: [ [ 'light', 0.15 ], [ 'gentle', 0.71 ], [ 'fresh', 0.14 ] ],
	fresh: [ [ 'gentle', 0.6 ], [ 'fresh', 0.2 ], [ 'strong', 0.2 ] ],
	strong: [ [ 'fresh', 0.7 ], [ 'strong', 0.3 ] ],
};
const WIND_ORDER: ReadonlyArray<WindLevel> = [ 'light', 'gentle', 'fresh', 'strong' ];
const WINDIER: Readonly<Record<WeatherName, number>> = { clear: 1, fair: 0.7, cloudy: 1.3, overcast: 1.6, rain: 1.6, storm: 2, fog: 0.3 };

/** A weather change as it sweeps the sky: values at the start and end, and the linear
 * progress reached at the island. Places upwind are further along, places downwind behind. */
export interface WeatherFront {
	from: Readonly<Preset>;
	to: Readonly<Preset>;
	progress: number;
}

/** A change of sky in the forecast: when its front starts (seconds of the weather's clock from
 * now; negative for the front under way), how long it takes, and the skies it moves between. */
export interface WeatherTurn {
	at: number;
	duration: number;
	from: WeatherName;
	to: WeatherName;
}

// mulberry32: one draw from a seed, and the seed after it
function mulberry32( seed: number ): { seed: number; value: number } {

	const s = ( seed + 0x6D2B79F5 ) | 0;
	let t = Math.imul( s ^ ( s >>> 15 ), s | 1 );
	t ^= t + Math.imul( t ^ ( t >>> 7 ), t | 61 );
	return { seed: s, value: ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296 };

}

// The auto chain's next sky from the current one, for a draw in [ 0, 1 ).
function nextSky( name: WeatherName, pick: number ): WeatherName {

	const options = NEXT[ name ];
	for ( const [ next, weight ] of options ) {

		if ( pick < weight ) return next;
		pick -= weight;

	}
	return options[ options.length - 1 ][ 0 ];

}

const fields = [ ...Object.keys( WEATHER_PRESETS.clear ), 'windSpeed', 'windDirection', 'gustiness' ] as ( keyof Preset )[];
// The auto-weather chain's seeds (mulberry32), at construction and at `establish`: the sky's, and
// the wind's own stream.
const SEED = 0x5eed;
const WIND_SEED = 0x3b1d;
const smooth = ( t: number ) => t * t * ( 3 - 2 * t );
const smoothIntegral = ( t: number ) => t * t * t * ( 1 - 0.5 * t );
// Signed change of heading along the shorter arc, so 350° to 10° turns 20°, not 340°.
const headingDelta = ( from: number, to: number ) => ( ( ( to - from ) % 360 ) + 540 ) % 360 - 180;
const wrapHeading = ( heading: number ) => ( ( heading % 360 ) + 360 ) % 360;

function presetFor( name: WeatherName ): Readonly<SkyPreset> {

	if ( ! Object.hasOwn( WEATHER_PRESETS, name ) ) throw new RangeError( `Unknown weather preset: ${ String( name ) }` );
	return WEATHER_PRESETS[ name ];

}

export const isWindLevel = ( name: unknown ): name is WindLevel => typeof name === 'string' && Object.hasOwn( WIND_LEVELS, name );

function requireWind( { level, heading }: WindChoice ): void {

	if ( level !== undefined && ! isWindLevel( level ) ) throw new RangeError( `Unknown wind level: ${ String( level ) }` );
	if ( heading !== undefined && ( typeof heading !== 'number' || ! Number.isFinite( heading ) ) ) throw new RangeError( 'Wind heading must be a finite number' );

}

// A sky with a wind: the endpoint of a transition.
const endpoint = ( name: WeatherName, level: WindLevel, heading: number ): Preset =>
	( { ...presetFor( name ), ...WIND_LEVELS[ level ], windDirection: heading } );

function requireDuration( value: number, label: string ): void {

	if ( ! Number.isFinite( value ) || value < 0 ) throw new RangeError( `${ label } must be a finite, non-negative number` );

}

export class Weather {

	private current: WeatherState;
	private from: Preset;
	private destination: Readonly<Preset>;
	private targetName: WeatherName;
	// the sky the front under way left (the target itself once it has arrived)
	private originName: WeatherName;
	private windLevel: WindLevel;
	private windHeading: number;
	private elapsed = 0;
	private duration = 0;
	// Auto weather: a seeded chain, so a given start and time always give the same sky and wind.
	auto = false;
	private dwell = 0;
	private seed = SEED;
	private windSeed = WIND_SEED;

	/** `wind` overrides the wind the sky loads with (the gentle wind from the prevailing heading,
	 * or a parked sky's own). */
	constructor( name: WeatherName = 'fair', wind: WindChoice = {} ) {

		presetFor( name );
		requireWind( wind );
		this.windLevel = wind.level ?? PRESET_WIND[ name ] ?? 'gentle';
		this.windHeading = wrapHeading( wind.heading ?? PREVAILING_HEADING );
		const preset = endpoint( name, this.windLevel, this.windHeading );
		// Loading a rainy preset represents established weather for repeatable review captures.
		// Subsequent weather changes preserve moisture and let the independent drying model run.
		this.current = { ...preset, wetness: preset.rain * 0.8, showers: preset.rain };
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;
		this.originName = name;

	}

	/** Jumps to `name` (and `wind`, as the constructor takes it) as established weather, the way
	 * loading it does: no transition, a sky without a front, the ground as wet as the constructor
	 * leaves it, and the auto-weather chain from its seeds. */
	establish( name: WeatherName, wind: WindChoice = {} ): void {

		presetFor( name );
		requireWind( wind );
		this.windLevel = wind.level ?? PRESET_WIND[ name ] ?? 'gentle';
		this.windHeading = wrapHeading( wind.heading ?? PREVAILING_HEADING );
		const preset = endpoint( name, this.windLevel, this.windHeading );
		Object.assign( this.current, preset, { wetness: preset.rain * 0.8, showers: preset.rain } );
		this.from = { ...preset };
		this.destination = preset;
		this.targetName = name;
		this.originName = name;
		this.elapsed = 0;
		this.duration = 0;
		this.dwell = 0;
		this.seed = SEED;
		this.windSeed = WIND_SEED;

	}

	get state(): Readonly<WeatherState> { return this.current; }
	get target(): WeatherName { return this.targetName; }
	/** The sky the front under way set out from (the target once it has arrived). */
	get origin(): WeatherName { return this.duration > this.elapsed ? this.originName : this.targetName; }
	/** The wind the weather is at or moving to: its level and heading (0 - 360 degrees). */
	get windTarget(): { level: WindLevel; heading: number } { return { level: this.windLevel, heading: this.windHeading }; }
	get progress(): number { return this.duration > 0 ? this.elapsed / this.duration : 1; }
	get front(): WeatherFront { return { from: this.from, to: this.destination, progress: this.progress }; }

	snapshot(): WeatherState { return { ...this.current }; }

	/** Moves to the sky `name` over `duration` seconds. The wind keeps its target unless `wind`
	 * names one, or the sky is a parked one with a wind of its own. */
	setWeather( name: WeatherName, duration = 20, wind: WindChoice = {} ): void {

		presetFor( name );
		requireDuration( duration, 'Weather transition duration' );
		requireWind( wind );
		this.moveTo( name, wind.level ?? PRESET_WIND[ name ] ?? this.windLevel, wind.heading ?? this.windHeading, duration );

	}

	/** Moves the wind alone to `wind` (its level, its heading or both) over `duration` seconds,
	 * the sky keeping its target. */
	setWind( wind: WindChoice, duration = 20 ): void {

		requireWind( wind );
		requireDuration( duration, 'Weather transition duration' );
		this.moveTo( this.targetName, wind.level ?? this.windLevel, wind.heading ?? this.windHeading, duration );

	}

	private moveTo( name: WeatherName, level: WindLevel, heading: number, duration: number ): void {

		const preset = endpoint( name, level, wrapHeading( heading ) );
		// Start from the displayed state, including mid-transition values. Reversals never jump
		// back to the previous named preset, and every new transition eases out of its snapshot.
		this.from = { ...this.current };
		this.destination = preset;
		this.originName = this.targetName;
		this.targetName = name;
		this.windLevel = level;
		this.windHeading = preset.windDirection;
		this.elapsed = 0;
		this.duration = duration;
		this.dwell = 0;
		if ( duration === 0 ) for ( const key of fields ) this.current[ key ] = preset[ key ];

	}

	private random(): number {

		const draw = mulberry32( this.seed );
		this.seed = draw.seed;
		return draw.value;

	}

	// The wind's own stream (mulberry32), so its draws leave the sky's sequence as it was.
	private windRandom(): number {

		const draw = mulberry32( this.windSeed );
		this.windSeed = draw.seed;
		return draw.value;

	}

	/**
	 * The skies the weather moves through over the next `seconds` of its clock (the seconds `update`
	 * is given): the front under way first (its `at` negative), then each turn the auto chain will
	 * take, read ahead from its seeds without moving it (see the header). Without auto weather the
	 * sky holds after the front under way.
	 */
	forecast( seconds: number ): WeatherTurn[] {

		const turns: WeatherTurn[] = [];
		let t = 0;
		if ( this.duration > this.elapsed ) {

			turns.push( { at: - this.elapsed, duration: this.duration, from: this.originName, to: this.targetName } );
			t = this.duration - this.elapsed;

		}
		if ( ! this.auto ) return turns;
		let seed = this.seed, dwell = this.dwell, name = this.targetName;
		while ( t < seconds ) {

			let draw;
			if ( dwell <= 0 ) {

				draw = mulberry32( seed );
				seed = draw.seed;
				dwell = 90 + draw.value * 150;

			}
			t += dwell;
			if ( t >= seconds ) break;
			draw = mulberry32( seed );
			seed = draw.seed;
			const next = nextSky( name, draw.value );
			draw = mulberry32( seed );
			seed = draw.seed;
			const duration = 30 + draw.value * 30;
			turns.push( { at: t, duration, from: name, to: next } );
			name = next;
			t += duration;
			dwell = 0;

		}
		return turns;

	}

	// The wind's next level, one step at most, its stronger options weighted by the coming sky.
	private nextWindLevel( sky: WeatherName ): WindLevel {

		const rank = WIND_ORDER.indexOf( this.windLevel );
		const options = NEXT_WIND[ this.windLevel ].map( ( [ level, weight ] ) =>
			[ level, WIND_ORDER.indexOf( level ) > rank ? weight * WINDIER[ sky ] : weight ] as const );
		let pick = this.windRandom() * options.reduce( ( sum, [ , weight ] ) => sum + weight, 0 );
		for ( const [ level, weight ] of options ) {

			if ( pick < weight ) return level;
			pick -= weight;

		}
		return options[ options.length - 1 ][ 0 ];

	}

	// The wind's next heading: the prevailing one plus an offset, nine times in ten triangular
	// within +-40 degrees, one in ten from the opposite quadrant (180 +- 45).
	private nextWindHeading(): number {

		const offset = this.windRandom() < 0.1 ? 180 + ( this.windRandom() * 2 - 1 ) * 45 : ( this.windRandom() + this.windRandom() - 1 ) * 40;
		return wrapHeading( PREVAILING_HEADING + offset );

	}

	// Rest for 90 to 240 seconds, then move to a neighbouring sky and a new wind over 30 to 60 seconds.
	private advanceAuto( dt: number ): void {

		if ( this.duration > this.elapsed ) return;
		if ( this.dwell <= 0 ) this.dwell = 90 + this.random() * 150;
		this.dwell -= dt;
		if ( this.dwell > 0 ) return;
		const next = nextSky( this.targetName, this.random() );
		const duration = 30 + this.random() * 30;
		this.moveTo( next, this.nextWindLevel( next ), this.nextWindHeading(), duration );

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
