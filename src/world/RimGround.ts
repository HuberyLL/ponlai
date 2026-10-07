import { Field2D } from './Field2D.ts';
import { islandSurfaceHeight, layoutBounds } from './WorldShapes.ts';
import { noise3, smoothstep } from './noise.ts';
import type { RimGroundField, SDF } from './types.ts';

export const RIM_FRINGE_FADE = 0.12;
export const RIM_INNER_LIMIT = 0.70;
export const RIM_MAX_DROP = 0.30;

export interface RimGroundSample { distance: number; roofY: number; retreat: number; depth: number }

// The top coast differs from the nominal tile footprint. Trace its actual solid just below
// the roof so grass thinning, exposed root soil and stone shoulders share one boundary.
export function buildRimGround( sdf: SDF ): RimGroundField {

	const b = layoutBounds(), pad = 2, cell = 0.10;
	const coast = Field2D.covering( b.x0 - pad, b.x1 + pad, b.z0 - pad, b.z1 + pad, cell )
		.fill( ( x, z ) => sdf( x, islandSurfaceHeight( x, z ) - 0.25, z ) ).signedDistance();
	const data = new Float32Array( coast.nx * coast.nz * 4 );
	for ( let row = 0; row < coast.nz; row ++ ) for ( let col = 0; col < coast.nx; col ++ ) {

		const x = coast.x0 + ( col + 0.5 ) * cell, z = coast.z0 + ( row + 0.5 ) * cell;
		const broad = noise3( x * 0.49 + 3.8, 8.7, z * 0.49 - 2.1 ) * 0.5 + 0.5;
		const broken = noise3( x * 1.17 - 6.2, 3.4, z * 1.17 + 7.1 ) * 0.5 + 0.5;
		const pocket = Math.pow( smoothstep( 0.38, 0.68, broad * 0.72 + broken * 0.28 ), 1.7 );
		const roots = noise3( x * 0.67 - 2.6, 5.8, z * 0.67 + 9.3 ) * 0.5 + 0.5;
		const k = ( row * coast.nx + col ) * 4;
		data[ k ] = coast.data[ k / 4 ];
		data[ k + 1 ] = islandSurfaceHeight( x, z );
		data[ k + 2 ] = - 0.09 + pocket * 0.43;
		// The root bed's depth below the roof, patchy along the coast: deep cuts expose a band of
		// root soil, and where it runs shallow the turf creeps down over the lip instead (see
		// TerrainMaterial), so the edge alternates between earth and overgrown stretches.
		data[ k + 3 ] = 0.035 + Math.pow( smoothstep( 0.3, 0.72, roots ), 1.4 ) * 0.17;

	}
	return { data, nx: coast.nx, nz: coast.nz, x0: coast.x0, z0: coast.z0, cell };

}

// CPU bilinear lookup matches a linear-filtered texture whose texels are the cell centres.
export function sampleRimGround( field: RimGroundField, x: number, z: number ): RimGroundSample {

	const { nx, nz, cell, data } = field;
	const fx = Math.min( Math.max( ( x - field.x0 ) / cell - 0.5, 0 ), nx - 1 );
	const fz = Math.min( Math.max( ( z - field.z0 ) / cell - 0.5, 0 ), nz - 1 );
	const i = Math.floor( fx ), j = Math.floor( fz ), i1 = Math.min( i + 1, nx - 1 ), j1 = Math.min( j + 1, nz - 1 );
	const u = fx - i, v = fz - j;
	const sample = ( channel: number ) => {

		const a = data[ ( j * nx + i ) * 4 + channel ], b = data[ ( j * nx + i1 ) * 4 + channel ];
		const c = data[ ( j1 * nx + i ) * 4 + channel ], d = data[ ( j1 * nx + i1 ) * 4 + channel ];
		return ( a + ( b - a ) * u ) * ( 1 - v ) + ( c + ( d - c ) * u ) * v;

	};
	return { distance: sample( 0 ), roofY: sample( 1 ), retreat: sample( 2 ), depth: sample( 3 ) };

}

// Thin the grass only where the same field exposes a little root soil or stone beneath it.
export function rimGrassCover( ground: RimGroundSample ): number {

	return smoothstep( ground.retreat - RIM_FRINGE_FADE, ground.retreat + RIM_FRINGE_FADE, - ground.distance );

}
