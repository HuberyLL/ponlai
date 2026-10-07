import { Matrix3, Vector3 } from 'three/webgpu';

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
	nightVisibility: number;
	exposure: number;
	blackLift: number;
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
// Local sidereal time at midnight (radians): 14h puts Scorpius high in the east with the Milky
// Way's core below it, Crux and Alpha Centauri high in the south, and the band through Aquila,
// split by the Great Rift, rising out of the sea in the horizon view. The sky gains a turn a year
// on the sun, so each authored day starts a little further on.
const MIDNIGHT_SIDEREAL = 14 / 24 * TAU;
const SIDEREAL_DAYS_PER_YEAR = 365.2422;
// Highest elevation (degrees) at which the key may turn from the sun toward the moon: below the
// end of the sun's fade as its drawn disk sinks into the sea (see Atmosphere.sunlightAt).
const HANDOFF_TOP = - 0.7;

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

		this.hour = options.hour ?? 16;
		this.dayLength = options.dayLength ?? 2880;
		this.moonPhase = options.moonPhase ?? 0.25;
		this.lunarPeriodDays = options.lunarPeriodDays ?? 29.53;
		this.paused = options.paused ?? false;
		this.advanceMoonPhase = options.advanceMoonPhase ?? false;

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
		// A waxing quarter moon culminates at sunset; only a full moon opposes the sun.
		// Using the same orbital plane preserves the phase's actual angular separation.
		const moonDir = direction( hourAngle - this.phase * TAU );
		const elevation = Math.asin( Math.max( - 1, Math.min( 1, sunDir.y ) ) ) * DEG;
		const moonElevation = Math.asin( Math.max( - 1, Math.min( 1, moonDir.y ) ) ) * DEG;
		const daylight = smoothstep( - 7, 8, elevation );
		// A low sun's light is thin and warm, and twilight thinner still; adapt toward both so
		// sunrise, sunset and the blue hour stay readable. Deep night keeps its own exposure.
		const lowSun = smoothstep( - 14, - 5, elevation ) * ( 1 - smoothstep( 4, 18, elevation ) );
		const moonIllumination = ( 1 - Math.cos( TAU * this.phase ) ) * 0.5;
		const moonVisibility = smoothstep( 0, 5, moonElevation );
		// Rotate within the orbital plane only after the sun is blocked and before the
		// moon's key light fades in. Opposing full-moon vectors never cancel as in a lerp.
		const handoff = 1 - smoothstep( - 2.5, HANDOFF_TOP, elevation );
		const keyDir = direction( hourAngle - this.phase * TAU * handoff );
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
			moonKeyGain: ( 1 - smoothstep( - 7, - 3, elevation ) ) * moonVisibility * moonIllumination,
			starFrame: equatorialFrame( MIDNIGHT_SIDEREAL + hourAngle + Math.PI + TAU * ( this.completedDays + this.currentHour / 24 ) / SIDEREAL_DAYS_PER_YEAR ),
			daylight,
			nightVisibility: 1 - smoothstep( - 15, - 3, elevation ),
			// Modest adaptation preserves a visibly dark night. Scene lighting, not exposure,
			// supplies its readable forms; reduce display lift so blacks do not turn milky.
			exposure: ( 4.4 + ( 2.6 - 4.4 ) * daylight ) * ( 1 + 0.6 * lowSun ),
			blackLift: 0.002 + ( 0.027 - 0.002 ) * daylight,
		};

	}

}
