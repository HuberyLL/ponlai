// All scene-linear radiance and irradiance use the same unit scale. Keeping sunlight below
// fp16's finite range must not change its brightness relative to the sky or its reflections.
// Exposure and display-space bloom thresholds undo this scale in Pipeline.
export const SCENE_RADIANCE_SCALE = 1 / 16;
export const SUN_ANGULAR_RADIUS = 0.004675;

function solarDiskProfile( radius: number ): number {

	if ( radius >= 1 ) return 0;
	const x = Math.max( 0, Math.min( ( radius - 0.9 ) / 0.1, 1 ) );
	const edge = 1 - x * x * ( 3 - 2 * x );
	return edge * ( 0.4 + 0.6 * Math.sqrt( Math.max( 1 - radius * radius, 0 ) ) );

}

// E = integral( L * cos(theta) dOmega ). The same radial limb/edge profile is used in Sky.
// Midpoint quadrature normalises the profile rather than treating a softened disk as uniform.
// Radiometric integral: https://pbr-book.org/4ed/Radiometry,_Spectra,_and_Color/Working_with_Radiometric_Integrals
const SAMPLES = 4096;
let projectedSolidAngle = 0;
for ( let i = 0; i < SAMPLES; i ++ ) {

	const theta = ( i + 0.5 ) * SUN_ANGULAR_RADIUS / SAMPLES;
	projectedSolidAngle += solarDiskProfile( theta / SUN_ANGULAR_RADIUS )
		* Math.sin( theta ) * Math.cos( theta ) * 2 * Math.PI * SUN_ANGULAR_RADIUS / SAMPLES;

}
export const SUN_PROJECTED_SOLID_ANGLE = projectedSolidAngle;
