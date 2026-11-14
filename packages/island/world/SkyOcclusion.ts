import type { SDF } from './types.ts';

// Local sky and contact visibility of generated solids, traced through their distance fields.

export interface SolidBounds {
	field: SDF;
	min: readonly number[];
	max: readonly number[];
}

export interface LocalVisibilityOptions {
	radius?: number;
	samples?: number;
	steps?: number;
	bias?: number;
}

// Squared distance from a point to a solid's bounds: the filters below compare it with the squared
// radius, which skips Math.hypot's careful (and slow) scaling in the generator's hottest loop.
function boundsDistance2( solid: SolidBounds, x: number, y: number, z: number ): number {

	const dx = Math.max( solid.min[ 0 ] - x, 0, x - solid.max[ 0 ] );
	const dy = Math.max( solid.min[ 1 ] - y, 0, y - solid.max[ 1 ] );
	const dz = Math.max( solid.min[ 2 ] - z, 0, z - solid.max[ 2 ] );
	return dx * dx + dy * dy + dz * dz;

}

// Spatial buckets keep a contact query independent of the number of distant rocks. The field
// beyond the contact radius is deliberately clamped: it is not used to generate geometry.
export function boundedSceneField( solids: readonly SolidBounds[], radius = 1.8, cell = 4 ): SDF {

	const buckets = new Map<string, SolidBounds[]>();
	for ( const solid of solids ) {

		for ( let iz = Math.floor( ( solid.min[ 2 ] - radius ) / cell ); iz <= Math.floor( ( solid.max[ 2 ] + radius ) / cell ); iz ++ ) {
			for ( let iy = Math.floor( ( solid.min[ 1 ] - radius ) / cell ); iy <= Math.floor( ( solid.max[ 1 ] + radius ) / cell ); iy ++ ) {
				for ( let ix = Math.floor( ( solid.min[ 0 ] - radius ) / cell ); ix <= Math.floor( ( solid.max[ 0 ] + radius ) / cell ); ix ++ ) {

					const key = `${ix},${iy},${iz}`;
					const list = buckets.get( key );
					if ( list ) list.push( solid );
					else buckets.set( key, [ solid ] );

				}
			}
		}

	}

	const radius2 = radius * radius;
	let previousKey = '', previous: readonly SolidBounds[] = [];
	return ( x, y, z ) => {

		const key = `${Math.floor( x / cell )},${Math.floor( y / cell )},${Math.floor( z / cell )}`;
		if ( key !== previousKey ) {

			previousKey = key;
			previous = buckets.get( key ) ?? [];

		}
		let distance = radius;
		for ( const solid of previous ) {

			// Test against the query radius, not the current signed minimum: overlapping
			// solids can both be negative, and their union must keep the more negative one.
			if ( boundsDistance2( solid, x, y, z ) < radius2 ) distance = Math.min( distance, solid.field( x, y, z ) );

		}
		return distance;

	};

}

// Cosine-weighted hemisphere integration estimates the fraction of a uniform local sky that
// remains visible. Sphere tracing follows Hart's distance-bound method; the shortened steps
// reduce overshoot on procedural distance proxies. They do not establish an exact distance
// bound for every noise perturbation. A finite radius
// and distance falloff make this contact visibility, not a global-illumination solution.
// Techniques, not copied code: https://doi.org/10.1007/s003710050084 and PBRT 4e,
// https://pbr-book.org/4ed/Sampling_Algorithms/Sampling_Multidimensional_Functions
export function localSkyVisibility( field: SDF, x: number, y: number, z: number,
	nx: number, ny: number, nz: number, { radius = 1.5, samples = 8, steps = 16, bias = 0.06 }: LocalVisibilityOptions = {} ): number {

	const nl = Math.hypot( nx, ny, nz );
	if ( nl === 0 ) return 1;
	nx /= nl; ny /= nl; nz /= nl;
	let tx = Math.abs( ny ) < 0.9 ? - nz : ny;
	let ty = Math.abs( ny ) < 0.9 ? 0 : - nx;
	let tz = Math.abs( ny ) < 0.9 ? nx : 0;
	const tl = Math.hypot( tx, ty, tz );
	tx /= tl; ty /= tl; tz /= tl;
	const bx = ny * tz - nz * ty, by = nz * tx - nx * tz, bz = nx * ty - ny * tx;
	const ox = x + nx * bias, oy = y + ny * bias, oz = z + nz * bias;
	// Buried faces lie inside a different solid (usually the sea floor). All directions share
	// that immediate obstruction, so a single probe replaces eight identical trace starts.
	if ( field( ox, oy, oz ) < 0.008 ) return 0;
	let visibility = 0;
	for ( let i = 0; i < samples; i ++ ) {

		const u = ( i + 0.5 ) / samples, angle = i * 2.399963229728653;
		const r = Math.sqrt( u ), a = r * Math.cos( angle ), b = r * Math.sin( angle ), c = Math.sqrt( 1 - u );
		const dx = tx * a + bx * b + nx * c, dy = ty * a + by * b + ny * c, dz = tz * a + bz * b + nz * c;
		let travel = 0, visible = 1;
		for ( let step = 0; step < steps && travel < radius; step ++ ) {

			const distance = field( ox + dx * travel, oy + dy * travel, oz + dz * travel );
			if ( distance < 0.008 ) {

				const fade = Math.max( 0, Math.min( 1, ( travel / radius - 0.65 ) / 0.35 ) );
				visible = fade * fade * ( 3 - 2 * fade );
				break;

			}
			travel += Math.max( distance * 0.65, 0.015 );

		}
		visibility += visible;

	}
	return visibility / samples;

}

// Most vertices have no neighbour within the contact radius. Avoid tracing their hemisphere;
// the original per-shape AO still supplies their crevice detail. Excluding the receiver avoids
// counting that self-occlusion twice when this local result is combined with its existing AO.
export function contactVisibilitySampler( solids: readonly SolidBounds[], receiver?: SDF,
	options: LocalVisibilityOptions = {} ): ( x: number, y: number, z: number, nx: number, ny: number, nz: number ) => number {

	const radius = options.radius ?? 1.5;
	const radius2 = radius * radius;
	const others = solids.filter( ( solid ) => solid.field !== receiver );
	return ( x, y, z, nx, ny, nz ) => {

		const neighbours = others.filter( ( solid ) => boundsDistance2( solid, x, y, z ) < radius2 );
		if ( neighbours.length === 0 ) return 1;
		const field: SDF = ( px, py, pz ) => {

			let distance = radius;
			for ( const solid of neighbours ) {

				if ( boundsDistance2( solid, px, py, pz ) < radius2 ) distance = Math.min( distance, solid.field( px, py, pz ) );

			}
			return distance;

		};
		return localSkyVisibility( field, x, y, z, nx, ny, nz, options );

	};

}
