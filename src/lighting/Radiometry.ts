// All scene-linear radiance and irradiance use the same unit scale. Keeping sunlight below
// fp16's finite range must not change its brightness relative to the sky or its reflections.
// Exposure and display-space bloom thresholds undo this scale in Pipeline.
export const SCENE_RADIANCE_SCALE = 1 / 16;
// The physical sun (0.27 degrees) for shadow penumbrae and glints. The sky draws its disk at
// SUN_DISPLAY_RADIUS: twice as wide, as games commonly do, since a true-size disk reads as a
// point at a game's field of view. The moon matches it, as in reality.
export const SUN_ANGULAR_RADIUS = 0.004675;
export const SUN_DISPLAY_RADIUS = 2 * SUN_ANGULAR_RADIUS;

type RGB = [ number, number, number ];

// Solar limb darkening per channel: I( mu ) / I( 1 ) = mu ^ alpha, with the wavelength law
// alpha = -0.023 + 0.292 / lambda (lambda in micrometres) fitted to the Sun from 0.3 to 2.4 um by
// D. Hestroffer and C. Magnan, "Wavelength dependency of the Solar limb darkening" (A&A 333,
// 1998), evaluated at the Rec.709 primaries' dominant wavelengths. Blue darkens most toward the
// limb, so the rim reddens; per-channel coefficients follow a-starry-sky
// (https://github.com/Dante83/a-starry-sky), which uses the same paper.
export const SUN_LIMB_EXPONENT = [ 0.611, 0.549, 0.464 ].map( ( lambda ) => - 0.023 + 0.292 / lambda ) as RGB;

function solarDiskProfile( radius: number, exponent: number ): number {

	if ( radius >= 1 ) return 0;
	const x = Math.max( 0, Math.min( ( radius - 0.9 ) / 0.1, 1 ) );
	const edge = 1 - x * x * ( 3 - 2 * x );
	return edge * Math.max( 1 - radius * radius, 0 ) ** ( 0.5 * exponent );

}

// E = integral( L * cos(theta) dOmega ). The same radial limb/edge profile is used in Sky.
// Midpoint quadrature normalises the profile rather than treating a softened disk as uniform;
// each channel is normalised on its own, so the limb's colour never changes the sunlight.
// Radiometric integral: https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals
const SAMPLES = 4096;
function projectedSolidAngle( radius: number ): RGB {

	return SUN_LIMB_EXPONENT.map( ( exponent ) => {

		let sum = 0;
		for ( let i = 0; i < SAMPLES; i ++ ) {

			const theta = ( i + 0.5 ) * radius / SAMPLES;
			sum += solarDiskProfile( theta / radius, exponent ) * Math.sin( theta ) * Math.cos( theta ) * 2 * Math.PI * radius / SAMPLES;

		}
		return sum;

	} ) as RGB;

}
export const SUN_PROJECTED_SOLID_ANGLE = projectedSolidAngle( SUN_ANGULAR_RADIUS );
// The displayed disk spreads the same irradiance over its larger area.
export const SUN_DISPLAY_SOLID_ANGLE = projectedSolidAngle( SUN_DISPLAY_RADIUS );
