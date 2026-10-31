// A look's values through the day: a few keys by the sun's elevation (degrees), each key's values
// reached at its elevation and blended between neighbouring keys by a smoothstep (so a value rests
// at each key and moves between them), held beyond the first and the last; a clouded day's values,
// where a look has them, come in over them by the weather's cloud (Pipeline.ts `cloud`: 0 under a
// clear or fair sky, 1 under a cloudy or overcast one), and the night's over both by the night's
// weight (Pipeline.ts `night`, from the daylight). Each look sets its own keys: the shade's contrast
// holds one value from the noon down to a 9 degree sun, the exposure and the local tone move between
// 40, 12 and 3 degrees. Read on the
// CPU once a frame into uniforms, so a value is a function of the clock and the weather alone and
// a paused frame repeats. A day key may carry a `name` (`golden`), which names its values as
// tunables (debug/Tune.ts `tuneKeys`: `<prefix>.<value>@<name>`, else `@day<i>`).

export type KeyValues = Record<string, number>;
export interface DayKeys<T extends KeyValues> {
	// ascending by elevation
	readonly day: readonly { readonly at: number; readonly values: T; readonly name?: string }[];
	// a cloudy or overcast day's, whatever the sun's elevation (none: the clear day's)
	readonly cloudy?: T;
	readonly night: T;
}

const smooth = ( t: number ) => t * t * ( 3 - 2 * t );

/** `keys`' values at the sun's `elevation` (degrees), the night's weight `night` and the weather's
 * cloud `cloud`, into `out`. */
export function keyed<T extends KeyValues>( keys: DayKeys<T>, elevation: number, night: number, out: T, cloud = 0 ): T {

	const { day } = keys;
	let i = 0;
	while ( i < day.length - 1 && elevation > day[ i + 1 ].at ) i ++;
	const a = day[ i ], b = day[ Math.min( i + 1, day.length - 1 ) ];
	const t = b.at > a.at ? smooth( Math.min( Math.max( ( elevation - a.at ) / ( b.at - a.at ), 0 ), 1 ) ) : 0;
	const o = out as KeyValues;
	for ( const k in a.values ) {

		let v = a.values[ k ] + ( b.values[ k ] - a.values[ k ] ) * t;
		if ( keys.cloudy ) v += ( keys.cloudy[ k ] - v ) * cloud;
		o[ k ] = v + ( keys.night[ k ] - v ) * night;

	}
	return out;

}
