import type { ShoreField } from '../../render/data.ts';

/** The shore field's signed distance (m, negative on land) at ( x, z ), bilinear over its cell
 * centres with the edge continued: the ground samples its texture so (WorldFields.ts, linear
 * filtering), so what the CPU plants and the GPU draws read the same field. */
export function shoreDistance( f: ShoreField, x: number, z: number ): number {

	const fx = Math.min( Math.max( ( x - f.x0 ) / f.cell - 0.5, 0 ), f.nx - 1 ), fz = Math.min( Math.max( ( z - f.z0 ) / f.cell - 0.5, 0 ), f.nz - 1 );
	const i = Math.min( Math.floor( fx ), f.nx - 2 ), j = Math.min( Math.floor( fz ), f.nz - 2 ), u = fx - i, v = fz - j;
	const d = f.data, k = j * f.nx + i;
	return ( d[ k ] * ( 1 - u ) + d[ k + 1 ] * u ) * ( 1 - v ) + ( d[ k + f.nx ] * ( 1 - u ) + d[ k + f.nx + 1 ] * u ) * v;

}
