// Naive surface nets: one vertex per sign-changing voxel (mean of its edge crossings), one quad
// per sign-changing grid edge. Normals come from the SDF gradient (not the faceted mesh), a cheap
// SDF ambient occlusion is baked per vertex, plus an optional per-vertex value from `sdf.tint`,
// four from `sdf.detail` and three from `sdf.detail2`, and the mesh's mean curvature (convex
// arrises > 0, hollows < 0).
//
// surfaceNets( sdf, { min: [x,y,z], max: [x,y,z], voxel, ao, ... } )
//   -> { positions, normals, ao, tint, curv, detail?, detail2?: Float32Array, indices: Uint32Array }
//
// Chunk mode (`own`): the island is meshed per 16 m chunk, and two neighbouring chunks must meet
// with no crack and no shading seam (chunk design, sections 3.3 and 5.3).
// - The lattice is world-anchored: point ( i, j, k ) lies at ( i voxel, min.y + j voxel, k voxel ),
//   with a voxel exact in binary (0.125 m), so every chunk evaluates the same floats at a shared
//   point. Only min.y and max.y are read then; the island passes ISLAND_BOTTOM + 0.5 (-5.1), which
//   leaves out the bottom face nobody sees: the walls end open below the sea floor.
// - `own: [ i0, k0, i1, k1 ]` are the owned lattice columns, half-open ( i0 <= i < i1, likewise k ).
//   A quad belongs to the chunk owning the lower lattice endpoint of its sign-changing edge (the
//   edge's base point; every edge runs in +x, +y or +z), so each quad has exactly one owner.
// - The call samples the columns [ i0 - apron, i1 + apron ] and builds the complete mesh there.
//   An owned quad uses cells down to i0 - 1; mean curvature reads a vertex's 1-ring and, through
//   the smoothing pass, its neighbours' 1-rings: cells down to i0 - 3, whose low quads are built
//   from lattice point i0 - 2. So `apron` is 3 at least (2 would do on the high side; one number
//   keeps the window symmetric).
// - Positions, normals, AO, tint and detail are functions of the world position (positions from the
//   global lattice index, the rest from the SDF, which must not depend on the window near the
//   chunk): identical in every chunk. Curvature sums floats over triangles: the triangles are
//   visited in lattice order ( k, j, i, then the x, y, z edge ) in every window, which keeps the
//   relative order of any two triangles, so the sums match bit for bit too.
// - The result keeps the owned quads (triangles in lattice order) and the vertices they use (in
//   cell order). A vertex on a border is emitted by every chunk whose quads use it, bit-identical.
// - Apron vertices that no owned quad uses get positions and normals (curvature reads them) but
//   no AO, tint or detail: the AO probes are most of a vertex's cost.
// - Every chunk mesh carries the same attributes, even an empty one: `detail` and `detail2` are
//   always present (zero when the SDF has none), so no chunk asks for another pipeline variant.
//
// `columnRange( x, z )` (any call; the island's rule is `islandColumnRange` in WorldShapes.ts): a
// column for which it returns [ lo, hi ] samples the field only on the lattice points from just
// below lo to just above hi and fills the rest with a constant of the right sign: inside below,
// outside above. The caller promises that the field has no sign change outside that range, in this
// column or within a voxel of it, so the mesh is the same (tools/verify-world-chunks.mjs compares
// every chunk with and without). It saves about a tenth of an inland chunk's time, not the nine
// tenths the design estimated: far from the coast the wall's SDF already costs little per sample
// (CliffWall's column cache), and the vertices' normals and AO dominate.
//
// The call without `own` (the page's single island mesh) is unchanged: its lattice starts at min.

import type { SDF, MeshData } from './types.ts';

const EDGES = [
	[ 0, 1 ], [ 2, 3 ], [ 4, 5 ], [ 6, 7 ], // x
	[ 0, 2 ], [ 1, 3 ], [ 4, 6 ], [ 5, 7 ], // y
	[ 0, 4 ], [ 1, 5 ], [ 2, 6 ], [ 3, 7 ], // z
];
// corner c = ( dx, dy, dz ) with bit 0 = x, bit 1 = y, bit 2 = z

export interface NetsOptions {
	min: number[];
	max: number[];
	voxel: number;
	ao?: boolean;
	aoSdf?: SDF;
	contactVisibility?: ( x: number, y: number, z: number, nx: number, ny: number, nz: number ) => number;
	// central-difference step of the normals (m; half a voxel by default)
	normalStep?: number;
	// Cells for which this returns true (asked with the cell's mean crossing) place their vertex
	// by dual contouring instead: it then sits on the shape's sharp edges and corners.
	sharpen?: ( x: number, y: number, z: number ) => boolean;
	// Chunk mode: the owned lattice columns [ i0, k0, i1, k1 ] (half-open) of the world-anchored
	// lattice; min and max then give only the y range (see the header).
	own?: readonly [ number, number, number, number ];
	// lattice columns sampled around the owned ones in chunk mode (3 at least)
	apron?: number;
	// A column ( x, z ) for which this returns [ lo, hi ] samples only that y range (see the
	// header). The returned array is read at once, so it may be reused between calls.
	columnRange?: ( x: number, z: number ) => readonly [ number, number ] | null;
}

// The value written for a column's lattice points outside its sampled range: only its sign is
// meant to be read (a mesh that used it in a crossing would show a step a metre deep).
const COLUMN_FILL = 1;

// Dual contouring's vertex (after Ju et al., "Dual Contouring of Hermite Data", SIGGRAPH 2002):
// the point nearest to the tangent planes at the cell's edge crossings, pulled weakly toward
// their mean so flat and singular cases stay at it, and kept inside the cell. Coordinates are
// in voxels relative to the cell's corner; the result is written back to px, py, pz[ 0 ].
const QEF_PULL = 0.06, QEF_REACH = 0.5;
function placeSharp( n: number, px: Float64Array, py: Float64Array, pz: Float64Array,
	gx: Float64Array, gy: Float64Array, gz: Float64Array, cx: number, cy: number, cz: number ): void {

	let a00 = QEF_PULL, a01 = 0, a02 = 0, a11 = QEF_PULL, a12 = 0, a22 = QEF_PULL, b0 = 0, b1 = 0, b2 = 0;
	for ( let i = 0; i < n; i ++ ) {

		const x = gx[ i ], y = gy[ i ], z = gz[ i ];
		const d = x * ( px[ i ] - cx ) + y * ( py[ i ] - cy ) + z * ( pz[ i ] - cz );
		a00 += x * x; a01 += x * y; a02 += x * z; a11 += y * y; a12 += y * z; a22 += z * z;
		b0 += x * d; b1 += y * d; b2 += z * d;

	}
	// symmetric 3 x 3 solve by cofactors
	const c00 = a11 * a22 - a12 * a12, c01 = a02 * a12 - a01 * a22, c02 = a01 * a12 - a02 * a11;
	const det = a00 * c00 + a01 * c01 + a02 * c02;
	let x = cx, y = cy, z = cz;
	if ( Math.abs( det ) > 1e-9 ) {

		const c11 = a00 * a22 - a02 * a02, c12 = a01 * a02 - a00 * a12, c22 = a00 * a11 - a01 * a01;
		x += ( c00 * b0 + c01 * b1 + c02 * b2 ) / det;
		y += ( c01 * b0 + c11 * b1 + c12 * b2 ) / det;
		z += ( c02 * b0 + c12 * b1 + c22 * b2 ) / det;

	}
	x = Math.min( Math.max( x, 0 ), 1 );
	y = Math.min( Math.max( y, 0 ), 1 );
	z = Math.min( Math.max( z, 0 ), 1 );
	// A vertex pulled far from the crossings' mean (by noisy or nearly parallel planes) folds
	// the triangles around it: keep the mean there.
	if ( ( x - cx ) ** 2 + ( y - cy ) ** 2 + ( z - cz ) ** 2 > QEF_REACH * QEF_REACH ) { x = cx; y = cy; z = cz; }
	px[ 0 ] = x; py[ 0 ] = y; pz[ 0 ] = z;

}

export function surfaceNets( sdf: SDF, { min, max, voxel, ao = true, aoSdf = sdf, contactVisibility, normalStep = voxel * 0.5, sharpen, own, apron = 3, columnRange }: NetsOptions ): MeshData {

	// This call's lattice point ( i, j, k ) lies at ( ox + ( io + i ) voxel, min.y + j voxel,
	// oz + ( ko + k ) voxel ): at min without `own` (io = ko = 0 adds exactly nothing, so that
	// mesh keeps its floats), on the world-anchored lattice with it.
	let ox = min[ 0 ], oz = min[ 2 ], io = 0, ko = 0, nx: number, nz: number;
	if ( own ) {

		ox = 0; oz = 0;
		io = own[ 0 ] - apron; ko = own[ 1 ] - apron;
		nx = own[ 2 ] - own[ 0 ] + 2 * apron; nz = own[ 3 ] - own[ 1 ] + 2 * apron;

	} else {

		nx = Math.ceil( ( max[ 0 ] - min[ 0 ] ) / voxel );
		nz = Math.ceil( ( max[ 2 ] - min[ 2 ] ) / voxel );

	}
	const ny = Math.ceil( ( max[ 1 ] - min[ 1 ] ) / voxel );
	const sx = nx + 1, sy = ny + 1, sz = nz + 1;
	const sxy = sx * sy;

	// y innermost: shapes that do per-(x, z) work (the cliff wall's footprint lookup) cache it across a column
	const field = new Float32Array( sx * sy * sz );
	for ( let k = 0; k < sz; k ++ ) {

		const z = oz + ( ko + k ) * voxel;
		for ( let i = 0; i < sx; i ++ ) {

			const x = ox + ( io + i ) * voxel;
			let j0 = 0, j1 = ny;
			const range = columnRange?.( x, z );
			if ( range ) {

				j0 = Math.min( Math.max( Math.floor( ( range[ 0 ] - min[ 1 ] ) / voxel ), 0 ), sy );
				j1 = Math.min( Math.ceil( ( range[ 1 ] - min[ 1 ] ) / voxel ), ny );

			}
			for ( let j = 0, p = k * sxy + i; j < sy; j ++, p += sx ) {

				field[ p ] = j < j0 ? - COLUMN_FILL : j > j1 ? COLUMN_FILL : sdf( x, min[ 1 ] + j * voxel, z );

			}

		}

	}

	const cellVert = new Int32Array( nx * ny * nz ).fill( - 1 );
	const pos: number[] = [];
	const sharpVert = new Set<number>();
	const cv = new Float32Array( 8 );
	const off = [ 0, 1, sx, sx + 1, sxy, sxy + 1, sxy + sx, sxy + sx + 1 ];
	const qx = new Float64Array( 12 ), qy = new Float64Array( 12 ), qz = new Float64Array( 12 );
	const nqx = new Float64Array( 12 ), nqy = new Float64Array( 12 ), nqz = new Float64Array( 12 );
	const h = voxel * 0.05;
	// Up to four cells share an edge crossing: its tangent plane is computed once.
	const planes = new Map<number, number>();
	const planeNormals: number[] = [];
	const edgeOf = new Int32Array( 12 );
	for ( let k = 0; k < nz; k ++ ) for ( let j = 0; j < ny; j ++ ) for ( let i = 0; i < nx; i ++ ) {

		const base = k * sxy + j * sx + i;
		let mask = 0;
		for ( let c = 0; c < 8; c ++ ) {

			cv[ c ] = field[ base + off[ c ] ];
			if ( cv[ c ] < 0 ) mask |= 1 << c;

		}

		if ( mask === 0 || mask === 255 ) continue;
		let ax = 0, ay = 0, az = 0, n = 0;
		for ( let e = 0; e < 12; e ++ ) {

			const a = EDGES[ e ][ 0 ], b = EDGES[ e ][ 1 ];
			const va = cv[ a ], vb = cv[ b ];
			if ( ( va < 0 ) === ( vb < 0 ) ) continue;
			const t = va / ( va - vb );
			qx[ n ] = ( a & 1 ) + ( ( b & 1 ) - ( a & 1 ) ) * t;
			qy[ n ] = ( ( a >> 1 ) & 1 ) + ( ( ( b >> 1 ) & 1 ) - ( ( a >> 1 ) & 1 ) ) * t;
			qz[ n ] = ( ( a >> 2 ) & 1 ) + ( ( ( b >> 2 ) & 1 ) - ( ( a >> 2 ) & 1 ) ) * t;
			edgeOf[ n ] = ( base + off[ a ] ) * 3 + ( e >> 2 );
			ax += qx[ n ]; ay += qy[ n ]; az += qz[ n ];
			n ++;

		}

		let vx = ax / n, vy = ay / n, vz = az / n;
		const wx = ox + ( io + i + vx ) * voxel, wy = min[ 1 ] + ( j + vy ) * voxel, wz = oz + ( ko + k + vz ) * voxel;
		if ( sharpen && sharpen( wx, wy, wz ) ) {

			// tangent planes at the crossings, from the field's gradient (tetrahedral differences)
			for ( let c = 0; c < n; c ++ ) {

				let slot = planes.get( edgeOf[ c ] );
				if ( slot === undefined ) {

					const x = ox + ( io + i + qx[ c ] ) * voxel, y = min[ 1 ] + ( j + qy[ c ] ) * voxel, z = oz + ( ko + k + qz[ c ] ) * voxel;
					const f0 = sdf( x + h, y - h, z - h ), f1 = sdf( x - h, y - h, z + h ), f2 = sdf( x - h, y + h, z - h ), f3 = sdf( x + h, y + h, z + h );
					const gx = f0 - f1 - f2 + f3, gy = - f0 - f1 + f2 + f3, gz = - f0 + f1 - f2 + f3;
					const l = Math.hypot( gx, gy, gz ) || 1;
					slot = planeNormals.length;
					planeNormals.push( gx / l, gy / l, gz / l );
					planes.set( edgeOf[ c ], slot );

				}
				nqx[ c ] = planeNormals[ slot ]; nqy[ c ] = planeNormals[ slot + 1 ]; nqz[ c ] = planeNormals[ slot + 2 ];

			}
			placeSharp( n, qx, qy, qz, nqx, nqy, nqz, vx, vy, vz );
			vx = qx[ 0 ]; vy = qy[ 0 ]; vz = qz[ 0 ];
			sharpVert.add( pos.length / 3 );

		}

		cellVert[ ( k * ny + j ) * nx + i ] = pos.length / 3;
		pos.push( ox + ( io + i + vx ) * voxel, min[ 1 ] + ( j + vy ) * voxel, oz + ( ko + k + vz ) * voxel );

	}

	const cell = ( i: number, j: number, k: number ) => cellVert[ ( k * ny + j ) * nx + i ];
	const idx: number[] = [];
	const quad = ( a: number, b: number, c: number, d: number, flip: boolean ) => {

		if ( a < 0 || b < 0 || c < 0 || d < 0 ) return;
		// A quad around a sharpened vertex folds along an edge of the shape: split it along the
		// diagonal that lies on the surface, so the fold keeps the edge instead of cutting it.
		if ( sharpVert.size && ( sharpVert.has( a ) || sharpVert.has( b ) || sharpVert.has( c ) || sharpVert.has( d ) ) ) {

			const mid = ( u: number, v: number ) => Math.abs( sdf( ( pos[ u * 3 ] + pos[ v * 3 ] ) * 0.5,
				( pos[ u * 3 + 1 ] + pos[ v * 3 + 1 ] ) * 0.5, ( pos[ u * 3 + 2 ] + pos[ v * 3 + 2 ] ) * 0.5 ) );
			if ( mid( b, d ) < mid( a, c ) ) {

				if ( flip ) idx.push( a, d, b, b, d, c );
				else idx.push( a, b, d, b, c, d );
				return;

			}

		}
		if ( flip ) idx.push( a, c, b, a, d, c );
		else idx.push( a, b, c, a, c, d );

	};

	// In chunk mode `idx` is the complete apron mesh (curvature reads it) and `ownIdx` the owned
	// quads' triangles, both in lattice order.
	const ownIdx: number[] = [];
	for ( let k = 0; k < sz; k ++ ) for ( let j = 0; j < sy; j ++ ) for ( let i = 0; i < sx; i ++ ) {

		const p = k * sxy + j * sx + i;
		const inside = field[ p ] < 0;
		const first = idx.length;
		// +x edge: cells around it in the y-z plane
		if ( i < nx && j > 0 && k > 0 && j < sy - 1 && k < sz - 1 && inside !== ( field[ p + 1 ] < 0 ) ) {

			quad( cell( i, j - 1, k - 1 ), cell( i, j, k - 1 ), cell( i, j, k ), cell( i, j - 1, k ), ! inside );

		}

		if ( j < ny && i > 0 && k > 0 && i < sx - 1 && k < sz - 1 && inside !== ( field[ p + sx ] < 0 ) ) {

			quad( cell( i - 1, j, k - 1 ), cell( i - 1, j, k ), cell( i, j, k ), cell( i, j, k - 1 ), ! inside );

		}

		if ( k < nz && i > 0 && j > 0 && i < sx - 1 && j < sy - 1 && inside !== ( field[ p + sxy ] < 0 ) ) {

			quad( cell( i - 1, j - 1, k ), cell( i, j - 1, k ), cell( i, j, k ), cell( i - 1, j, k ), ! inside );

		}

		// the three edges start at this point: its column owns their quads
		if ( own && io + i >= own[ 0 ] && io + i < own[ 2 ] && ko + k >= own[ 1 ] && ko + k < own[ 3 ] ) {

			for ( let t = first; t < idx.length; t ++ ) ownIdx.push( idx[ t ] );

		}

	}

	const positions = new Float32Array( pos );
	const vCount = positions.length / 3;
	const indices = new Uint32Array( idx );
	// chunk mode: each vertex's index in the result (in cell order), - 1 if no owned quad uses it
	let remap: Int32Array | undefined, outCount = vCount;
	if ( own ) {

		remap = new Int32Array( vCount ).fill( - 1 );
		for ( const v of ownIdx ) remap[ v ] = 0;
		outCount = 0;
		for ( let v = 0; v < vCount; v ++ ) if ( remap[ v ] === 0 ) remap[ v ] = outCount ++; else remap[ v ] = - 1;

	}

	const normals = new Float32Array( vCount * 3 );
	const occl = new Float32Array( outCount );
	const tint = new Float32Array( outCount ).fill( 0.5 );
	const detail = sdf.detail || own ? new Float32Array( outCount * 4 ) : undefined;
	const detail2 = sdf.detail2 || own ? new Float32Array( outCount * 3 ) : undefined;
	const e = normalStep;
	for ( let v = 0; v < vCount; v ++ ) {

		const x = positions[ v * 3 ], y = positions[ v * 3 + 1 ], z = positions[ v * 3 + 2 ];
		let gx = sdf( x + e, y, z ) - sdf( x - e, y, z );
		let gy = sdf( x, y + e, z ) - sdf( x, y - e, z );
		let gz = sdf( x, y, z + e ) - sdf( x, y, z - e );
		const l = Math.hypot( gx, gy, gz ) || 1;
		gx /= l; gy /= l; gz /= l;
		normals[ v * 3 ] = gx; normals[ v * 3 + 1 ] = gy; normals[ v * 3 + 2 ] = gz;

		// an apron vertex only lends its position and normal to the curvature
		const o = remap ? remap[ v ] : v;
		if ( o < 0 ) continue;

		if ( ao ) {

			const visible = contactVisibility?.( x, y, z, gx, gy, gz ) ?? 1;
			// occlusion from how far the field falls short of the free distance along the normal
			let occ = 0, w = 1;
			// A face enclosed by a neighbouring solid cannot receive local indirect light. Its
			// zero visibility already wins the minimum, so skip redundant crevice probes there.
			if ( visible > 0 ) for ( const h of [ 0.12, 0.3, 0.6, 1.1, 1.8 ] ) {

				occ += w * Math.max( h - aoSdf( x + gx * h, y + gy * h, z + gz * h ), 0 ) / h;
				w *= 0.62;

			}

			occl[ o ] = Math.min( Math.max( 1 - occ * 0.42, 0 ), 1 );
			// Keep the stronger result rather than multiplying overlapping estimates of the
			// same contact. Both feed material AO, so direct sunlight remains unaffected.
			occl[ o ] = Math.min( occl[ o ], visible );

		} else occl[ o ] = 1;

		if ( sdf.tint ) tint[ o ] = sdf.tint( x - gx * voxel * 0.5, y - gy * voxel * 0.5, z - gz * voxel * 0.5 );
		if ( sdf.detail ) sdf.detail( x, y, z, detail!, o * 4 );
		if ( sdf.detail2 ) sdf.detail2( x, y, z, detail2!, o * 3 );

	}

	const curv = meanCurvature( positions, normals, indices );
	if ( ! remap ) return { positions, normals, ao: occl, tint, curv, detail, detail2, indices };

	const keptPositions = new Float32Array( outCount * 3 ), keptNormals = new Float32Array( outCount * 3 );
	const keptCurv = new Float32Array( outCount );
	for ( let v = 0; v < vCount; v ++ ) {

		const o = remap[ v ];
		if ( o < 0 ) continue;
		for ( let c = 0; c < 3; c ++ ) {

			keptPositions[ o * 3 + c ] = positions[ v * 3 + c ];
			keptNormals[ o * 3 + c ] = normals[ v * 3 + c ];

		}
		keptCurv[ o ] = curv[ v ];

	}
	const keptIndices = new Uint32Array( ownIdx.length );
	for ( let t = 0; t < ownIdx.length; t ++ ) keptIndices[ t ] = remap[ ownIdx[ t ] ];
	return { positions: keptPositions, normals: keptNormals, ao: occl, tint, curv: keptCurv, detail, detail2, indices: keptIndices };

}

// discrete mean curvature per vertex: how fast the normal turns away along the mesh edges
// (1 / m; positive on convex arrises, negative in hollows and joints), smoothed once
function meanCurvature( positions: Float32Array, normals: Float32Array, indices: Uint32Array ): Float32Array {

	const n = positions.length / 3;
	const sum = new Float32Array( n ), cnt = new Float32Array( n );
	const edge = ( a: number, b: number ) => {

		const dx = positions[ b * 3 ] - positions[ a * 3 ], dy = positions[ b * 3 + 1 ] - positions[ a * 3 + 1 ], dz = positions[ b * 3 + 2 ] - positions[ a * 3 + 2 ];
		const l2 = dx * dx + dy * dy + dz * dz;
		if ( l2 < 1e-12 ) return;
		const k = ( ( normals[ b * 3 ] - normals[ a * 3 ] ) * dx + ( normals[ b * 3 + 1 ] - normals[ a * 3 + 1 ] ) * dy + ( normals[ b * 3 + 2 ] - normals[ a * 3 + 2 ] ) * dz ) / l2;
		sum[ a ] += k; cnt[ a ] ++;
		sum[ b ] += k; cnt[ b ] ++;

	};

	for ( let t = 0; t < indices.length; t += 3 ) {

		const a = indices[ t ], b = indices[ t + 1 ], c = indices[ t + 2 ];
		edge( a, b ); edge( b, c ); edge( c, a );

	}

	const k0 = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) k0[ i ] = cnt[ i ] ? sum[ i ] / cnt[ i ] : 0;
	// one smoothing pass over the 1-ring
	sum.fill( 0 ); cnt.fill( 0 );
	for ( let t = 0; t < indices.length; t += 3 ) {

		const a = indices[ t ], b = indices[ t + 1 ], c = indices[ t + 2 ];
		sum[ a ] += k0[ b ] + k0[ c ]; cnt[ a ] += 2;
		sum[ b ] += k0[ a ] + k0[ c ]; cnt[ b ] += 2;
		sum[ c ] += k0[ a ] + k0[ b ]; cnt[ c ] += 2;

	}

	const out = new Float32Array( n );
	for ( let i = 0; i < n; i ++ ) out[ i ] = cnt[ i ] ? ( k0[ i ] * 2 + sum[ i ] / cnt[ i ] ) / 3 : k0[ i ];
	return out;

}
