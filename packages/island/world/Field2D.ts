// A scalar field on a 2D grid over world xz, with bilinear lookup and an exact distance transform.
//
// A scalar field on a regular 2D grid over world xz, with bilinear lookup, plus the exact
// Euclidean signed distance transform (Felzenszwalb & Huttenlocher) used to turn masks into
// distance fields and to round the island footprint's corners (morphological open / close).

export class Field2D {

	x0: number; z0: number; nx: number; nz: number; cell: number;
	data: Float32Array;

	// cell centres at x0 + ( i + 0.5 ) * cell
	constructor( x0: number, z0: number, nx: number, nz: number, cell: number, data: Float32Array | null = null ) {

		this.x0 = x0; this.z0 = z0; this.nx = nx; this.nz = nz; this.cell = cell;
		this.data = data ?? new Float32Array( nx * nz );

	}

	static covering( xMin: number, xMax: number, zMin: number, zMax: number, cell: number ): Field2D {

		const nx = Math.ceil( ( xMax - xMin ) / cell ), nz = Math.ceil( ( zMax - zMin ) / cell );
		return new Field2D( xMin, zMin, nx, nz, cell );

	}

	fill( fn: ( x: number, z: number ) => number ): this {

		const { nx, nz, cell, x0, z0, data } = this;
		for ( let j = 0; j < nz; j ++ ) {

			const z = z0 + ( j + 0.5 ) * cell;
			for ( let i = 0; i < nx; i ++ ) data[ j * nx + i ] = fn( x0 + ( i + 0.5 ) * cell, z );

		}

		return this;

	}

	// bilinear, clamped at the border (outside values continue the edge texel)
	sample( x: number, z: number ): number {

		const { nx, nz, cell, data } = this;
		let fx = ( x - this.x0 ) / cell - 0.5, fz = ( z - this.z0 ) / cell - 0.5;
		fx = Math.min( Math.max( fx, 0 ), nx - 1.001 );
		fz = Math.min( Math.max( fz, 0 ), nz - 1.001 );
		const i = Math.floor( fx ), j = Math.floor( fz );
		const tx = fx - i, tz = fz - j;
		const k = j * nx + i;
		const a = data[ k ], b = data[ k + 1 ], c = data[ k + nx ], d = data[ k + nx + 1 ];
		return ( a + ( b - a ) * tx ) * ( 1 - tz ) + ( c + ( d - c ) * tx ) * tz;

	}

	contains( x: number, z: number ): boolean {

		return x > this.x0 && z > this.z0 && x < this.x0 + this.nx * this.cell && z < this.z0 + this.nz * this.cell;

	}

	// signed distance (m) of the set { data < 0 }: negative inside
	signedDistance(): Field2D {

		const { nx, nz, cell, data } = this;
		const inside = new Uint8Array( nx * nz );
		for ( let k = 0; k < data.length; k ++ ) inside[ k ] = data[ k ] < 0 ? 1 : 0;
		const dOut = edt( inside, nx, nz, 1 ); // distance to the nearest inside cell
		const dIn = edt( inside, nx, nz, 0 ); // distance to the nearest outside cell
		const out = new Field2D( this.x0, this.z0, nx, nz, cell );
		for ( let k = 0; k < data.length; k ++ ) {

			// cell-centre distances; the boundary sits half a cell between the two sides
			out.data[ k ] = inside[ k ] ? - ( Math.sqrt( dIn[ k ] ) - 0.5 ) * cell : ( Math.sqrt( dOut[ k ] ) - 0.5 ) * cell;

		}

		return out;

	}

	offset( r: number ): Field2D {

		const out = new Field2D( this.x0, this.z0, this.nx, this.nz, this.cell );
		for ( let k = 0; k < this.data.length; k ++ ) out.data[ k ] = this.data[ k ] - r;
		return out;

	}

}

// squared distance (in cells) from every cell to the nearest cell whose mask equals `target`
function edt( mask: Uint8Array, nx: number, nz: number, target: number ): Float64Array {

	const INF = 1e20;
	const f = new Float64Array( Math.max( nx, nz ) );
	const d = new Float64Array( Math.max( nx, nz ) );
	const v = new Int32Array( Math.max( nx, nz ) );
	const zb = new Float64Array( Math.max( nx, nz ) + 1 );
	const g = new Float64Array( nx * nz );
	for ( let k = 0; k < g.length; k ++ ) g[ k ] = mask[ k ] === target ? 0 : INF;

	// columns then rows
	for ( let i = 0; i < nx; i ++ ) {

		for ( let j = 0; j < nz; j ++ ) f[ j ] = g[ j * nx + i ];
		dt1( f, nz, d, v, zb );
		for ( let j = 0; j < nz; j ++ ) g[ j * nx + i ] = d[ j ];

	}

	for ( let j = 0; j < nz; j ++ ) {

		for ( let i = 0; i < nx; i ++ ) f[ i ] = g[ j * nx + i ];
		dt1( f, nx, d, v, zb );
		for ( let i = 0; i < nx; i ++ ) g[ j * nx + i ] = d[ i ];

	}

	return g;

}

function dt1( f: Float64Array, n: number, d: Float64Array, v: Int32Array, z: Float64Array ): void {

	let k = 0;
	v[ 0 ] = 0; z[ 0 ] = - Infinity; z[ 1 ] = Infinity;
	for ( let q = 1; q < n; q ++ ) {

		let s: number;
		do {

			const p = v[ k ];
			s = ( ( f[ q ] + q * q ) - ( f[ p ] + p * p ) ) / ( 2 * q - 2 * p );
			if ( s <= z[ k ] ) k --;
			else break;

		} while ( k >= 0 );

		k ++;
		v[ k ] = q; z[ k ] = s; z[ k + 1 ] = Infinity;

	}

	k = 0;
	for ( let q = 0; q < n; q ++ ) {

		while ( z[ k + 1 ] < q ) k ++;
		const p = v[ k ];
		d[ q ] = ( q - p ) * ( q - p ) + f[ p ];

	}

}

// morphological rounding of a signed distance field: closing (concave corners, radius rc) then
// opening (convex corners, radius ro)
export function roundCorners( sdf: Field2D, rc: number, ro: number ): Field2D {

	let f = sdf.offset( rc ).signedDistance(); // dilate
	f = f.offset( - rc ).signedDistance(); // erode -> closed
	f = f.offset( - ro ).signedDistance(); // erode
	return f.offset( ro ).signedDistance(); // dilate -> opened

}
