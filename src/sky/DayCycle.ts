import { Matrix3, Vector3 } from 'three/webgpu';

// The day cycle: authored, not astronomical. One dominant key light (the sun by day, the moon by
// night) drives terrain, characters, water, caustics and every shadow map; a sun/moon handoff
// passes through zero direct light: the sun's key fades as its drawn disk sinks below the horizon,
// and only then turns toward the moon (HANDOFF_TOP). The sun and moon are drawn at twice
// their true size (equal to each other); shadows and glints use the true sun. A low sun's key stays
// golden orange: the optical depth that sets its hue is capped, while its brightness still follows
// the full extinction (Sky.ts `capSunHue`). The sky, sun, moon, stars, key light and grade follow
// the clock every frame.
//
// The exposure only rises from afternoon into night and holds from the end of the blue hour (about
// -7 degrees) on, higher than the night sky was tuned for, so the island reads by moonlight and
// starlight. The night ambient rises as the sun's skylight fades after sunset, so twilight is never
// darker than the night; the night sky's own light (stars, airglow, moon disk, the sky's night
// floor, clouds) scales back to keep its tuned look in deep night (Sky.track). The night is
// art-directed, not a simulation of the eye's night vision (docs/art-direction.md).

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
	// clouds): it was tuned at a night exposure of NIGHT_SKY_EXPOSURE and keeps that look.
	nightSkyLevel: number;
	blackLift: number;
}

// The display's black lift by day (linear, added before the sRGB curve): black shows at about
// 31/255. Shadows stay airy; the earlier 0.027 (46/255) read as a milky veil over the frame.
export const DAY_BLACK_LIFT = 0.014;
const NIGHT_BLACK_LIFT = 0.002;

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
// The night keeps the blue hour's exposure, so a moonlit or moonless island keeps its forms and
// colours against the sea. The night sky's own light (stars, airglow, moon, clouds) was tuned at
// NIGHT_SKY_EXPOSURE and is scaled to keep its displayed brightness (see Sky.track).
export const NIGHT_EXPOSURE = 4.4 * 1.6;
export const NIGHT_SKY_EXPOSURE = 4.4;
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
		// sunrise, sunset and the blue hour stay readable. The night then holds the blue hour's
		// exposure (NIGHT_EXPOSURE): moonlight does not dim as the evening goes on.
		// lowSun stays 1 below four degrees, through the night: the night inherits the adaptation.
		const lowSun = 1 - smoothstep( 4, 18, elevation );
		// The low-sun adaptation used to fade out over -5 to -14 degrees, and the night sky was
		// tuned under it.
		const skyAdaptation = 1 + 0.6 * smoothstep( - 14, - 5, elevation ) * lowSun;
		// A closed deck hides the moon and stars, and the eye adapts further. Its night was
		// tuned at six times NIGHT_SKY_EXPOSURE and keeps that exposure; from the end of the
		// blue hour up its adaptation is as before.
		const deck = 6 * NIGHT_SKY_EXPOSURE / NIGHT_EXPOSURE - 1;
		const dusk = smoothstep( - 6, - 1, elevation );
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
			// The sun's scattered skylight falls about tenfold between the horizon and -4 degrees;
			// the night's ambient rises across the same band so the two together never dip.
			nightAmbient: 1 - smoothstep( - 5, 1, elevation ),
			// The night sky stays dark through its own scaled light (see NIGHT_SKY_EXPOSURE); the
			// display lift falls with daylight so blacks do not turn milky.
			exposure: ( 4.4 + ( 2.6 - 4.4 ) * daylight ) * ( 1 + 0.6 * lowSun ),
			overcastAdaptation: ( deck + ( 5 - deck ) * dusk ) * ( 1 - daylight ),
			nightSkyLevel: skyAdaptation / ( 1 + 0.6 * lowSun ),
			blackLift: NIGHT_BLACK_LIFT + ( DAY_BLACK_LIFT - NIGHT_BLACK_LIFT ) * daylight,
		};

	}

}
