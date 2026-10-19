import { Matrix3, Vector3 } from 'three/webgpu';

// The day cycle: authored, not astronomical. One dominant key light (the sun by day, the moon by
// night) drives terrain, characters, water, caustics and every shadow map; a sun/moon handoff
// passes through zero direct light: the sun's key fades as its drawn disk sinks below the horizon,
// and only then turns toward the moon (HANDOFF_TOP). The sun and moon are drawn at twice
// their true size (equal to each other); shadows and glints use the true sun. A low sun's key stays
// golden orange: the optical depth that sets its hue is capped (and by day shortened, so a high
// sun's key is near white), while its brightness still follows the full extinction (Sky.ts
// `capSunHue`). The sky, sun, moon, stars, key light and grade follow
// the clock every frame. `reset` sets the clock as the constructor does (a scene jump).
//
// The exposure follows the sun's elevation (EXPOSURE_KEYS), calibrated against tidewater under its
// display chain (Pipeline.ts): it only rises from afternoon into night and holds from about -6
// degrees on. It no longer sets the frame's exposure, which the display chain meters from the
// light (post/Exposure.ts): it stays the reference the night sky's own light is tuned against
// (`nightSkyLevel`).
// The night ambient rises as the sun's skylight fades after sunset, and the moon's key comes in
// as soon as the handoff has turned it (MOON_KEY_TOP), so twilight is never darker than the
// night; the night sky's own light (stars, airglow, moon disk, the sky's night
// floor, clouds) scales back to keep its tuned look in deep night (Sky.track). The night is
// art-directed, not a simulation of the eye's night vision (docs/art-direction.md).
//
// The moon's orbit is authored too: not the sun's path but a great circle through the same east
// and west points, tilted MOON_TILT toward the horizon about the east-west axis, so it culminates
// at 37 degrees instead of the sun's 62. A full moon still rises due east at 18:00 and sets due
// west at 6:00, and each phase keeps its hours; seen from the game's overview camera the moonlight
// comes in at a slant, so slopes have a lit and a shaded side and the sea carries a moon path,
// where a moon near the zenith lit the island flat. Its visibility (and so the key's moonlight)
// rises along the orbit as on the sun's path, so the evening handoff keeps its timing although the
// lower orbit climbs out of the sea more slowly. The sun and the stars keep their paths.

export const DAY_PRESETS = {
	'dawn': 5.35,
	'sunrise': 6.15,
	'noon': 12,
	'golden-hour': 16,
	'sunset': 17.85,
	'dusk': 18.65,
	'midnight': 0,
} as const;

export type DayPreset = keyof typeof DAY_PRESETS;

export interface DayCycleOptions {
	hour?: number;
	dayLength?: number;
	paused?: boolean;
	moonPhase?: number;
	advanceMoonPhase?: boolean;
	lunarPeriodDays?: number;
}

export interface DayCycleSnapshot {
	hour: number;
	day: number;
	sunDir: Vector3;
	moonDir: Vector3;
	keyDir: Vector3;
	elevation: number;
	azimuth: number;
	moonElevation: number;
	moonAzimuth: number;
	moonPhase: number;
	moonIllumination: number;
	moonVisibility: number;
	moonKeyGain: number;
	// World to equatorial (J2000) frame: x toward right ascension 0h, z toward the north
	// celestial pole. The stars turn with the sun about the pole of its path.
	starFrame: Matrix3;
	daylight: number;
	// The stars, airglow and Milky Way: they come out late, as the sky darkens.
	nightVisibility: number;
	// The authored night ambient that lights the island: it takes over as the sun's own sky fades
	// soon after sunset, so the blue hour reads blue and is never darker than the night.
	nightAmbient: number;
	exposure: number;
	// Further exposure, as a fraction, under a fully closed deck after dark (see Sky.track).
	overcastAdaptation: number;
	// Scale on the night sky's own light (stars, airglow, moon disk, the sky's night floor,
	// clouds): it was tuned at a night exposure of NIGHT_SKY_EXPOSURE and keeps that look, brighter
	// by NIGHT_EXPOSURE_GAIN, whatever the frame's exposure.
	nightSkyLevel: number;
}

const TAU = 2 * Math.PI;
const DEG = 180 / Math.PI;
const INCLINATION = 62 / DEG;
const SIN_INCLINATION = Math.sin( INCLINATION );
const COS_INCLINATION = Math.cos( INCLINATION );
// Rotate one orthonormal orbital plane to keep the established afternoon light direction.
// At 16:00 its hour angle is pi/3 and its horizontal azimuth must be -8 degrees.
const NOON_AZIMUTH = - 8 / DEG + Math.atan2( Math.sin( Math.PI / 3 ), COS_INCLINATION * Math.cos( Math.PI / 3 ) );
const SIN_NOON_AZIMUTH = Math.sin( NOON_AZIMUTH );
const COS_NOON_AZIMUTH = Math.cos( NOON_AZIMUTH );
// direction(a) = cos(a) MERIDIAN + sin(a) WEST: a rotation by a about MERIDIAN x WEST.
// The sun stands at the celestial equator (an equinox, every day): at noon it marks where the
// equator crosses the meridian and at 18:00 the west point. Its path is tilted 62 degrees, so
// the elevated pole is 28 degrees up. Seen from above, the sun turns anticlockwise, so that pole
// is the south celestial pole and the island lies near 28 degrees south, like Rapa Nui.
const MERIDIAN = new Vector3( COS_INCLINATION * COS_NOON_AZIMUTH, SIN_INCLINATION, COS_INCLINATION * SIN_NOON_AZIMUTH );
const WEST = new Vector3( SIN_NOON_AZIMUTH, 0, - COS_NOON_AZIMUTH );
const NORTH_POLE = WEST.clone().cross( MERIDIAN ).normalize();
// How far the moon's orbit is tilted from the sun's toward the horizon, about the east-west axis
// (see the header): it culminates at 62 - 25 = 37 degrees.
const MOON_TILT = 25 / DEG;
// Local sidereal time at midnight (radians): 14h puts Scorpius high in the east with the Milky
// Way's core below it, Crux and Alpha Centauri high in the south, and the band through Aquila,
// split by the Great Rift, rising out of the sea in the horizon view. The sky gains a turn a year
// on the sun, so each authored day starts a little further on.
const MIDNIGHT_SIDEREAL = 14 / 24 * TAU;
const SIDEREAL_DAYS_PER_YEAR = 365.2422;
// The exposure by the sun's elevation (degrees): [ elevation, exposure ], interpolated in log
// exposure and held beyond the ends. With the sun up, tidewater's auto exposure brings its frames to
// one metered level (its meter's centre-weighted log average: about 0.15 of ACES's input by day,
// falling through the low sun to about 0.03 at the horizon), and these bring the island views
// (toward and away from the sun, clear weather, the log mean of the two) to the same level at the
// same sun heights. After sunset tidewater's frame falls to near black, lit by its village; the
// night here keeps the brightness the island showed under the earlier grade, readable against the
// sea by moonlight, from about -6 degrees on (NIGHT_EXPOSURE).
const EXPOSURE_KEYS: readonly ( readonly [ number, number ] )[] = [
	[ - 6, 25 ], [ - 2.65, 19 ], [ 0, 11 ], [ 2, 10 ], [ 6.6, 5.5 ], [ 13.2, 3.4 ], [ 16.5, 2.85 ],
	[ 19.75, 2.4 ], [ 26.2, 1.82 ], [ 32.5, 1.48 ], [ 50, 1.19 ],
];
export const NIGHT_EXPOSURE = EXPOSURE_KEYS[ 0 ][ 1 ];
export const DAY_EXPOSURE = EXPOSURE_KEYS[ EXPOSURE_KEYS.length - 1 ][ 1 ];
export function exposureAt( elevation: number ): number {

	const keys = EXPOSURE_KEYS;
	if ( elevation <= keys[ 0 ][ 0 ] ) return keys[ 0 ][ 1 ];
	for ( let i = 1; i < keys.length; i ++ ) {

		const [ e1, x1 ] = keys[ i ];
		if ( elevation > e1 ) continue;
		const [ e0, x0 ] = keys[ i - 1 ];
		return x0 * Math.pow( x1 / x0, ( elevation - e0 ) / ( e1 - e0 ) );

	}
	return DAY_EXPOSURE;

}
// The night sky's own light (stars, airglow, moon, clouds) was tuned at NIGHT_SKY_EXPOSURE, with the
// night's own gain over it (NIGHT_EXPOSURE_GAIN) and the blue hour's adaptation, and keeps that
// displayed brightness whatever the frame's exposure (see Sky.track).
export const NIGHT_EXPOSURE_GAIN = 1.25;
export const NIGHT_SKY_EXPOSURE = 4.4;
// A closed deck after dark: the eye adapts further so a rainy dusk or night stays readable, still
// darker than a clear moonlit night: three times the clear night's exposure, as it was tuned.
const DECK_NIGHT_GAIN = 3;
// Highest elevation (degrees) at which the key may turn from the sun toward the moon: below the
// end of the sun's fade as its drawn disk sinks into the sea (see Atmosphere.sunlightAt).
const HANDOFF_TOP = - 0.7;
// Elevation (degrees) at which the moon's key starts to rise, in full two degrees lower: the
// handoff has just turned the key to the moon, so it turns through zero light (HANDOFF_TOP to here).
const MOON_KEY_TOP = - 2.5;

function finite( value: number, name: string ): number {

	if ( ! Number.isFinite( value ) ) throw new RangeError( `${ name } must be finite` );
	return value;

}

function positive( value: number, name: string ): number {

	finite( value, name );
	if ( value <= 0 ) throw new RangeError( `${ name } must be greater than zero` );
	return value;

}

function wrap( value: number, period: number ): number {

	return ( value % period + period ) % period;

}

function smoothstep( low: number, high: number, value: number ): number {

	const t = Math.max( 0, Math.min( 1, ( value - low ) / ( high - low ) ) );
	return t * t * ( 3 - 2 * t );

}

// World to equatorial frame at a local sidereal time: a star at right ascension a and
// declination d lies at hour angle (time - a), cos(H) MERIDIAN + sin(H) WEST, raised by d.
function equatorialFrame( sidereal: number ): Matrix3 {

	const c = Math.cos( sidereal ), s = Math.sin( sidereal );
	const x = MERIDIAN.clone().multiplyScalar( c ).addScaledVector( WEST, s );
	const y = MERIDIAN.clone().multiplyScalar( s ).addScaledVector( WEST, - c );
	const z = NORTH_POLE;
	return new Matrix3().set( x.x, x.y, x.z, y.x, y.y, y.z, z.x, z.y, z.z );

}

function direction( angle: number ): Vector3 {

	const c = Math.cos( angle ), s = Math.sin( angle );
	return new Vector3(
		COS_INCLINATION * c * COS_NOON_AZIMUTH + s * SIN_NOON_AZIMUTH,
		SIN_INCLINATION * c,
		COS_INCLINATION * c * SIN_NOON_AZIMUTH - s * COS_NOON_AZIMUTH,
	).normalize();

}

// The meridian point of an orbit through the east and west points, tilted `tilt` (radians) from
// the sun's toward the horizon: MERIDIAN turned about WEST.
function orbitMeridian( tilt: number ): Vector3 {

	const elevation = INCLINATION - tilt;
	return new Vector3( Math.cos( elevation ) * COS_NOON_AZIMUTH, Math.sin( elevation ), Math.cos( elevation ) * SIN_NOON_AZIMUTH );

}

const MOON_MERIDIAN = orbitMeridian( MOON_TILT );

// cos(a) meridian + sin(a) WEST: a point of the orbit through `meridian` at angle a past it.
function orbitDirection( angle: number, meridian: Vector3 ): Vector3 {

	return meridian.clone().multiplyScalar( Math.cos( angle ) ).addScaledVector( WEST, Math.sin( angle ) ).normalize();

}

/** A deterministic art-directed celestial clock. Hours and moon phase are independent of the
 * wave/vegetation animation clock, so lighting presets do not jump existing scene animation. */
export class DayCycle {

	paused: boolean;
	advanceMoonPhase: boolean;
	private currentHour = 16;
	private secondsPerDay = 2880;
	private phase = 0.25;
	private lunarDays = 29.53;
	private completedDays = 0;

	constructor( options: DayCycleOptions = {} ) {

		this.paused = false;
		this.advanceMoonPhase = false;
		this.reset( options );

	}

	/** The clock as the constructor sets it from `options` (a scene jump: no days completed). */
	reset( options: DayCycleOptions = {} ): void {

		this.hour = options.hour ?? 16;
		this.dayLength = options.dayLength ?? 2880;
		this.moonPhase = options.moonPhase ?? 0.25;
		this.lunarPeriodDays = options.lunarPeriodDays ?? 29.53;
		this.paused = options.paused ?? false;
		this.advanceMoonPhase = options.advanceMoonPhase ?? false;
		this.completedDays = 0;

	}

	get hour(): number { return this.currentHour; }
	set hour( value: number ) { this.currentHour = wrap( finite( value, 'hour' ), 24 ); }
	get dayLength(): number { return this.secondsPerDay; }
	set dayLength( value: number ) { this.secondsPerDay = positive( value, 'dayLength' ); }
	get moonPhase(): number { return this.phase; }
	set moonPhase( value: number ) { this.phase = wrap( finite( value, 'moonPhase' ), 1 ); }
	get lunarPeriodDays(): number { return this.lunarDays; }
	set lunarPeriodDays( value: number ) { this.lunarDays = positive( value, 'lunarPeriodDays' ); }
	get day(): number { return this.completedDays; }

	setHour( hour: number ): void { this.hour = hour; }

	setPreset( preset: DayPreset ): void {

		if ( ! Object.hasOwn( DAY_PRESETS, preset ) ) throw new RangeError( `Unknown day preset: ${ preset }` );
		this.hour = DAY_PRESETS[ preset ];

	}

	advance( dt: number ): void {

		finite( dt, 'dt' );
		if ( dt < 0 ) throw new RangeError( 'dt must not be negative' );
		if ( this.paused || dt === 0 ) return;
		const days = dt / this.secondsPerDay;
		const hours = finite( this.currentHour + days * 24, 'advanced hour' );
		const phaseStep = this.advanceMoonPhase ? finite( days / this.lunarDays, 'advanced moon phase' ) : 0;
		this.completedDays += Math.floor( hours / 24 );
		this.currentHour = wrap( hours, 24 );
		this.phase = wrap( this.phase + phaseStep, 1 );

	}

	snapshot(): DayCycleSnapshot {

		const hourAngle = ( this.currentHour - 12 ) / 24 * TAU;
		const sunDir = direction( hourAngle );
		// A waxing quarter moon culminates at sunset; only a full moon opposes the sun. The moon
		// trails the sun by its phase along its own, lower orbit (see the header): both orbits
		// share the east and west points, so at 6:00 and 18:00 their separation is the phase's.
		const moonAngle = hourAngle - this.phase * TAU;
		const moonDir = orbitDirection( moonAngle, MOON_MERIDIAN );
		const elevation = Math.asin( Math.max( - 1, Math.min( 1, sunDir.y ) ) ) * DEG;
		const moonElevation = Math.asin( Math.max( - 1, Math.min( 1, moonDir.y ) ) ) * DEG;
		// The elevation the moon would have on the sun's path at the same point of its orbit: the
		// same sign as its own, and what its visibility rises with.
		const moonOrbitElevation = Math.asin( Math.max( - 1, Math.min( 1, Math.cos( moonAngle ) * SIN_INCLINATION ) ) ) * DEG;
		const daylight = smoothstep( - 7, 8, elevation );
		// The night sky was tuned under a low-sun adaptation that faded out over -5 to -14 degrees.
		const skyAdaptation = 1 + 0.6 * smoothstep( - 14, - 5, elevation ) * ( 1 - smoothstep( 4, 18, elevation ) );
		const exposure = exposureAt( elevation );
		// A closed deck hides the moon and stars (see DECK_NIGHT_GAIN); from the end of the blue
		// hour up its adaptation rises to five.
		const deck = DECK_NIGHT_GAIN - 1;
		const dusk = smoothstep( - 6, - 1, elevation );
		const moonIllumination = ( 1 - Math.cos( TAU * this.phase ) ) * 0.5;
		// Over the first five degrees of the sun's path, measured along the moon's orbit: on the
		// lower orbit the same rise climbs about 3.4 degrees, and the evening's moonlight (the key's
		// gain below) keeps the timing it had when the moon shared the sun's path.
		const moonVisibility = smoothstep( 0, 5, moonOrbitElevation );
		// Rotate along the orbit, its tilt following, only after the sun is blocked and before the
		// moon's key light fades in. Opposing full-moon vectors never cancel as in a lerp.
		const handoff = 1 - smoothstep( - 2.5, HANDOFF_TOP, elevation );
		const keyDir = handoff === 0 ? sunDir.clone() : handoff === 1 ? moonDir.clone() :
			orbitDirection( hourAngle - this.phase * TAU * handoff, orbitMeridian( MOON_TILT * handoff ) );
		return {
			hour: this.currentHour,
			day: this.completedDays,
			sunDir,
			moonDir,
			keyDir,
			elevation,
			azimuth: Math.atan2( sunDir.z, sunDir.x ) * DEG,
			moonElevation,
			moonAzimuth: Math.atan2( moonDir.z, moonDir.x ) * DEG,
			moonPhase: this.phase,
			moonIllumination,
			moonVisibility,
			// The moon's key comes in as soon as the handoff has turned it (from MOON_KEY_TOP), not
			// four degrees later: between the sun's last light and the night's ambient the meadow
			// fell to about half its night brightness.
			moonKeyGain: ( 1 - smoothstep( MOON_KEY_TOP - 2, MOON_KEY_TOP, elevation ) ) * moonVisibility * moonIllumination,
			starFrame: equatorialFrame( MIDNIGHT_SIDEREAL + hourAngle + Math.PI + TAU * ( this.completedDays + this.currentHour / 24 ) / SIDEREAL_DAYS_PER_YEAR ),
			daylight,
			nightVisibility: 1 - smoothstep( - 15, - 3, elevation ),
			// The sun's scattered skylight falls about tenfold between the horizon and -4 degrees;
			// the night's ambient rises across the same band so the two together never dip.
			nightAmbient: 1 - smoothstep( - 5, 1, elevation ),
			// (the night sky stays dark through its own scaled light: see NIGHT_SKY_EXPOSURE)
			exposure,
			overcastAdaptation: ( deck + ( 5 - deck ) * dusk ) * ( 1 - daylight ),
			nightSkyLevel: Math.min( 1, NIGHT_SKY_EXPOSURE * NIGHT_EXPOSURE_GAIN * skyAdaptation / exposure ),
		};

	}

}
