import { mulberry32, noise3, smoothstep, type Rng } from './noise.ts';
import { supportsMeadow } from './MeadowSurface.ts';
import { VEGETATION_STRIDE as STRIDE } from './types.ts';

export interface FoliageSite { x: number; y: number; z: number; r: number; rim: number; nx: number; ny: number; nz: number; visibility: number }

/** The seed of the bushes' random stream (`buildFoliage` draws on from it for each bush's pose). */
export const FOLIAGE_SEED = 7;

/** Whether a bush site is drawn: proposals rooted on stone are dropped after the draw. */
export function bushRooted( s: FoliageSite ): boolean {

	return supportsMeadow( s.y, s.ny );

}

/** The bushes `buildFoliage` draws, for anything that must agree with them (the game's ground). */
export function drawnFoliageSites( veg: Float32Array ): FoliageSite[] {

	return pickFoliageSites( veg, mulberry32( FOLIAGE_SEED ) ).filter( bushRooted );

}

// pick bush sites among the turf anchors: crowded along the rim, scattered inland
export function pickFoliageSites( veg: Float32Array, rng: Rng ): FoliageSite[] {

	const n = veg.length / STRIDE;
	const order = Array.from( { length: n }, ( _, i ) => i );
	for ( let i = n - 1; i > 0; i -- ) {

		const j = Math.floor( rng() * ( i + 1 ) );
		[ order[ i ], order[ j ] ] = [ order[ j ], order[ i ] ];

	}

	const sites: FoliageSite[] = [];
	for ( const i of order ) {

		const k = i * STRIDE;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ], rim = veg[ k + 6 ];
		const onStack = veg[ k + 7 ] > 0;
		const nearRim = smoothstep( - 2.2, - 0.6, rim );
		const clump = noise3( x * 0.3, 7.7, z * 0.3 ) * 0.5 + 0.5;
		const p = onStack ? 0.08 : nearRim * 0.3 * smoothstep( 0.3, 0.7, clump ) + 0.015 * smoothstep( 0.6, 0.85, clump );
		if ( rng() > p ) continue;
		const r = onStack ? 0.35 + rng() * 0.25 : ( 0.35 + Math.pow( rng(), 1.5 ) * 0.75 ) * ( 0.8 + 0.5 * nearRim );
		if ( sites.some( ( s ) => Math.hypot( s.x - x, s.z - z ) < ( s.r + r ) * 0.75 ) ) continue;
		sites.push( { x, y, z, r, rim, nx: veg[ k + 3 ], ny: veg[ k + 4 ], nz: veg[ k + 5 ], visibility: veg[ k + 8 ] } );

	}

	return sites;

}
