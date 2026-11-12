import { tune } from '../debug/Tune.ts';
import { readLook, type AmbientColumn, type AmbientKnobs, type AmbientRowLook } from './Look.ts';

// The environment light's look tables, as the renderer reads them (look/Look.ts: the numbers are
// the installed look's, the neutral set's where none is): the ambient grade's table by the sun's
// elevation and the weather's skies, with the gains under overcast's deck, which
// lighting/AmbientGrade.ts writes into the lighting models' uniforms once a frame; and the low
// key's lift, the shading elevation under a low sun, which lighting/KeyLift.ts turns into the
// lifted direction. The land's floor under cloud is the sky's (look/SkyLook.ts KEY_THROUGH_CLOUD).
// Each module's header says what its numbers do on screen.

export type { AmbientKnobs };

const LOOK = readLook( 'ambient', 'look/AmbientLook.ts' );

export const AMBIENT_KNOBS: ReadonlyArray<keyof AmbientKnobs> = [ 'skySpecular', 'skyBounce', 'sunBounce', 'directionality', 'aoStrength' ];

/** The table's columns, the skies of the weather's blend (Weather.ts MIX_SKIES' order). */
export const AMBIENT_COLUMNS = [ 'clear', 'fair', 'cloudy', 'overcast' ] as const satisfies readonly AmbientColumn[];
type AmbientRow = { at: number } & Record<AmbientColumn, Readonly<AmbientKnobs>>;

// The knobs at no grade: a look's rows spell their changes over it.
export const DEFAULT_KNOBS: Readonly<AmbientKnobs> = { skySpecular: 1, skyBounce: 1, sunBounce: 1, directionality: 0.25, aoStrength: 1 };
const D = DEFAULT_KNOBS;
const whole = ( row: AmbientRowLook ): AmbientRow => ( { at: row.at, clear: { ...D, ...row.clear }, fair: { ...D, ...row.fair }, cloudy: { ...D, ...row.cloudy }, overcast: { ...D, ...row.overcast } } );

// The grade by the sun's elevation (degrees, descending), and the rising sun's.
export const AMBIENT_GRADE: readonly AmbientRow[] = LOOK.grade.map( whole );
export const AMBIENT_GRADE_RISING: readonly AmbientRow[] = LOOK.gradeRising.map( whole );

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
export const sunBounceGain = tune( 'lighting.grade.sunBounce', LOOK.sunBounceGain, { min: 0.25, max: 4, scale: 'log' } );

/** The moon's part of the weather's land gain under overcast's deck (OVERCAST_LAND is the sun's):
 * the moonlit land's sky light and the moon's bounce under the deck. */
export const OVERCAST_MOON_LAND = LOOK.overcastMoonLand;

/** The sun's part of the weather's gain under overcast's deck, per unit, on the land's ambient
 * light: on the sky's light per unit of the bake (after the unit that makes it a clear day's in the
 * same place: AmbientRelight.ts OVERCAST_LAND_UNIT), its bounce with it, by overcast's share and its
 * deck's light (`overcastLandWeight`), and on the key's bounce per unit of the table's (`update`),
 * by overcast's share and the deck's light at the sun's height (the moon's at its own height takes
 * OVERCAST_MOON_LAND). It is not the land's whole ambient light under the deck over a clear day's:
 * that ratio also holds the bake's ratio of the two skies and the sun's bounce's share of the
 * light. 1 leaves the land as the sky and the table give it. Tunable:
 * `lighting.relight.overcastLand`. */
export const OVERCAST_LAND = tune( 'lighting.relight.overcastLand', LOOK.overcastLand, { min: 1, max: 2 } );

// ---- the low key's lift (lighting/KeyLift.ts)

/** The elevations (degrees): the shading direction's at the sun key's (`at`, ascending), held below
 * the first row; from the last row's on, the shading holds at the last row's `shading` until the
 * key's own elevation passes it, the corner rounded over `join` degrees either side. A moon key
 * shades from the moon's own direction (sky/DayCycle.ts MOON). */
export const KEY_LIFT = LOOK.keyLift;

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
