import { tune } from '../debug/Tune.ts';

// The look's environment-light tables (src/look/: the numbers chosen for the look, their
// tunables and the CPU code that reads only them): the ambient grade's table by the sun's
// elevation and the weather's skies, with the gains under overcast's deck, which
// lighting/AmbientGrade.ts writes into the lighting models' uniforms once a frame; and the low
// key's lift, the shading elevation under a low sun, which lighting/KeyLift.ts turns into the
// lifted direction. The land's floor under cloud is the sky's (look/SkyLook.ts KEY_THROUGH_CLOUD).
// Each module's header says what its numbers do on screen.

export interface AmbientKnobs {
	skySpecular: number;
	skyBounce: number;
	sunBounce: number;
	directionality: number;
	aoStrength: number;
}
export const AMBIENT_KNOBS: ReadonlyArray<keyof AmbientKnobs> = [ 'skySpecular', 'skyBounce', 'sunBounce', 'directionality', 'aoStrength' ];

/** The table's columns, the skies of the weather's blend (Weather.ts MIX_SKIES' order). */
export const AMBIENT_COLUMNS = [ 'clear', 'fair', 'cloudy', 'overcast' ] as const;
type Column = typeof AMBIENT_COLUMNS[ number ];
type AmbientRow = { at: number } & Record<Column, Readonly<AmbientKnobs>>;

// The knobs at no grade: the rows below spell their changes over it.
export const DEFAULT_KNOBS: Readonly<AmbientKnobs> = { skySpecular: 1, skyBounce: 1, sunBounce: 1, directionality: 0.25, aoStrength: 1 };
const D = DEFAULT_KNOBS;

// The key's bounce by day under the clouded skies, in clear's unit (`D`, 1): the cloudy sky's about
// half (8 / 15), overcast's a third (the header). Overcast's keeps 0.33 from 2 degrees down.
const CLOUDY_BOUNCE = 8 / 15, OVERCAST_BOUNCE = 1 / 3;

// the high sun, the afternoon, the low sun (13 to 7 degrees), the sky's reflection letting go (5.5
// to 4 degrees), golden hour,
// where the sky's gain starts toward the night key (2 degrees), sunset, the afterglow (-1.3 and -2.6 degrees), the
// blue hour, the night
export const AMBIENT_GRADE: readonly AmbientRow[] = [
	{ at: 60, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 30, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 20, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 13, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 10, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 9, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 7, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 5.5, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 4, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: OVERCAST_BOUNCE } },
	{ at: 2, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: 0, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 1.3, clear: { ...D, skySpecular: 0.5 }, fair: { ...D, skySpecular: 0.5 }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 2.6, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 4, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
	{ at: - 18, clear: { ...D }, fair: { ...D }, cloudy: { ...D, sunBounce: CLOUDY_BOUNCE }, overcast: { ...D, sunBounce: 0.33 } },
];

// The rising sun's (the header): the clear and the fair sky's reflection at 0.1 from -2.6 to -12
// degrees, the night's from -13 down; the clouded columns are the evening's.
const DAWN_SPECULAR = 0.1;
const dawn = ( row: AmbientRow, skySpecular: number ): AmbientRow => ( { ...row, at: row.at, clear: { ...row.clear, skySpecular }, fair: { ...row.fair, skySpecular } } );
export const AMBIENT_GRADE_RISING: readonly AmbientRow[] = [
	...AMBIENT_GRADE.filter( ( row ) => row.at > - 2.6 ),
	dawn( AMBIENT_GRADE[ AMBIENT_GRADE.length - 3 ], DAWN_SPECULAR ),
	dawn( AMBIENT_GRADE[ AMBIENT_GRADE.length - 2 ], DAWN_SPECULAR ),
	dawn( { ...AMBIENT_GRADE[ AMBIENT_GRADE.length - 2 ], at: - 12 }, DAWN_SPECULAR ),
	{ ...AMBIENT_GRADE[ AMBIENT_GRADE.length - 1 ], at: - 13 },
	AMBIENT_GRADE[ AMBIENT_GRADE.length - 1 ],
];

/** The table at a sun elevation (degrees), `rising` or setting, and the weather's column weights,
 * into `out`. */
export function evaluateAmbient( elevation: number, weights: readonly number[], out: AmbientKnobs, rising = false ): AmbientKnobs {

	const rows = rising ? AMBIENT_GRADE_RISING : AMBIENT_GRADE;
	let a = rows[ rows.length - 1 ], b = a, t = 0;
	if ( elevation >= rows[ 0 ].at ) a = b = rows[ 0 ];
	else for ( let i = 1; i < rows.length; i ++ ) if ( elevation >= rows[ i ].at ) {

		a = rows[ i ]; b = rows[ i - 1 ];
		t = ( elevation - a.at ) / ( b.at - a.at );
		break;

	}
	for ( const key of AMBIENT_KNOBS ) {

		let sum = 0, weight = 0;
		AMBIENT_COLUMNS.forEach( ( column, c ) => {

			const w = weights[ c ] ?? 0, x = a[ column ][ key ];
			sum += w * ( x + ( b[ column ][ key ] - x ) * t );
			weight += w;

		} );
		out[ key ] = weight > 0 ? sum / weight : D[ key ];

	}
	return out;

}

/** A gain on the table's `sunBounce` at every hour and in every weather: scales the key's bounce
 * throughout without reshaping the table: the shade's level is the light the ground sends up. */
export const sunBounceGain = tune( 'lighting.grade.sunBounce', 1, { min: 0.25, max: 4, scale: 'log' } );

/** The moon's part of the weather's land gain under overcast's deck (OVERCAST_LAND is the sun's):
 * the moonlit land's sky light and the moon's bounce under the deck. */
export const OVERCAST_MOON_LAND = 1.75;

/** The sun's part of the weather's gain under overcast's deck, per unit, on the land's ambient
 * light: on the sky's light per unit of the bake (after the unit that makes it a clear day's in the
 * same place: AmbientRelight.ts OVERCAST_LAND_UNIT), its bounce with it, by overcast's share and its
 * deck's light (`overcastLandWeight`), and on the key's bounce per unit of the table's (`update`),
 * by overcast's share and the deck's light at the sun's height (the moon's at its own height takes
 * OVERCAST_MOON_LAND). It is not the land's whole ambient light under the deck over a clear day's:
 * that ratio also holds the bake's ratio of the two skies and the sun's bounce's share of the
 * light. 1 leaves the land as the sky and the table give it. At 1.35, with overcast's dimmer day
 * sky (Weather.ts `daySky` 0.074), on lit open ground (a white card's light, the brighter half of
 * the ground and meadow within 40 m on two eye-height views beside and away from the sun), the
 * ambient light reads about 0.95 of the sky's irradiance over pi and the card's whole light 5.3
 * times it, the direct light making 0.82 of it with the sun 22 degrees up and 0.81 at 15. Tunable:
 * `lighting.relight.overcastLand`. */
export const OVERCAST_LAND = tune( 'lighting.relight.overcastLand', 1.35, { min: 1, max: 2 } );

// ---- the low key's lift (lighting/KeyLift.ts)

/** The elevations (degrees): the shading direction's at the sun key's (`at`, ascending), held below
 * the first row; from the last row's on, the shading holds at the last row's `shading` until the
 * key's own elevation passes it, the corner rounded over `join` degrees either side. A moon key
 * shades from the moon's own direction (sky/DayCycle.ts MOON). */
export const KEY_LIFT = {
	rows: [ { at: 0, shading: 18 }, { at: 5, shading: 18 }, { at: 6, shading: 14 } ],
	join: 1,
};

// The rows' slopes (shading per degree of the key): Fritsch and Carlson's monotone cubic
// ("Monotone Piecewise Cubic Interpolation", SIAM J. Numer. Anal. 1980), flat at both ends, so the
// lift meets the hold below and the floor above smoothly.
const SLOPE = KEY_LIFT.rows.map( ( r, i, rows ) => {

	if ( i === 0 || i === rows.length - 1 ) return 0;
	const h0 = r.at - rows[ i - 1 ].at, h1 = rows[ i + 1 ].at - r.at;
	const d0 = ( r.shading - rows[ i - 1 ].shading ) / h0, d1 = ( rows[ i + 1 ].shading - r.shading ) / h1;
	return d0 * d1 <= 0 ? 0 : 3 * ( h0 + h1 ) / ( ( 2 * h1 + h0 ) / d0 + ( h1 + 2 * h0 ) / d1 );

} );

// the shading elevation under a sun key at `elevation` (degrees)
export function keyLiftShading( elevation: number ): number {

	const rows = KEY_LIFT.rows, last = rows[ rows.length - 1 ];
	if ( elevation <= rows[ 0 ].at ) return rows[ 0 ].shading;
	if ( elevation >= last.at ) {

		// max( elevation, floor ), its corner a parabola meeting both lines with their slopes
		const floor = last.shading, w = KEY_LIFT.join, x = elevation - floor;
		return x <= - w ? floor : x >= w ? elevation : floor + ( x + w ) * ( x + w ) / ( 4 * w );

	}
	let i = 1;
	while ( elevation >= rows[ i ].at ) i ++;
	const a = rows[ i - 1 ], b = rows[ i ], h = b.at - a.at, t = ( elevation - a.at ) / h, t2 = t * t, t3 = t2 * t;
	return ( 2 * t3 - 3 * t2 + 1 ) * a.shading + ( t3 - 2 * t2 + t ) * h * SLOPE[ i - 1 ]
		+ ( 3 * t2 - 2 * t3 ) * b.shading + ( t3 - t2 ) * h * SLOPE[ i ];

}
