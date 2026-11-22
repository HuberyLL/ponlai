import * as THREE from 'three/webgpu';
import { mulberry32, type Rng } from '../../render/data.ts';

// The sea floor's fixed life as models, built in code at a reference individual's size in metres.
//
// Each model stands on its base at the origin, growing up +y (the instance turns it onto the floor
// or the stone it grows on, FloorLife.ts). Its vertices carry aData:
//   x the flex: how far the water moves the point (0 at the holdfast, 1 at a free tip), which the
//     material's sway (FloorMaterial.ts) takes as it is
//   y the part (PART below), which the painter reads
//   z a random number per piece (a leaf, a branch, a polyp), for its own shade
//   w the place along the piece (0 at its base, 1 at its tip; a plate's distance from its centre)
// and aSide, the half-width vector of a ribbon at that vertex (zero elsewhere): the material widens a
// leaf seen from far along it, so that a blade narrower than a pixel keeps its coverage (fewer
// blades, each wider) instead of flickering.
//
// The reference sizes (the instance's scale multiplies them):
//   - eelgrass (Zostera marina): a shoot of four leaves 1 m long, 1.2 cm wide, from a flat sheath,
//     in one plane (the leaves of a shoot are two-ranked), arching out as they rise
//   - kelp (Ecklonia cava): a stipe of 0.6 m and a crown of a primary blade with secondary blades
//     from its margins, 1.1 m in all
//   - table coral (Acropora hyacinthus): a plate of 0.5 m radius on a short stalk
//   - branching coral (Acropora): a bush of tapering branches, 0.3 m across
//   - massive coral (Porites): a lobed dome of 0.5 m radius
//   - soft coral (Dendronephthya): a pale stalk branching into clusters of coloured polyps, 0.35 m
//   - sea fan (a gorgonian, Melithaea): a fan of thin branches in one plane, 0.5 m tall
//   - long-spined urchin (Diadema setosum): a test of 7 cm with spines to 0.2 m

export const FLOOR_PART = { LEAF: 0, STIPE: 1, BLADE: 2, PLATE: 3, STALK: 4, BRANCH: 5, DOME: 6, POLYP: 7, FAN: 8, TEST: 9, SPINE: 10 } as const;

const TAU = Math.PI * 2;
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3();

class FloorMesh {

	pos: number[] = [];
	nrm: number[] = [];
	dat: number[] = [];
	side: number[] = [];
	idx: number[] = [];

	v( p: THREE.Vector3, n: THREE.Vector3, d: readonly [ number, number, number, number ], s?: THREE.Vector3 ): number {

		this.pos.push( p.x, p.y, p.z );
		this.nrm.push( n.x, n.y, n.z );
		this.dat.push( d[ 0 ], d[ 1 ], d[ 2 ], d[ 3 ] );
		this.side.push( s ? s.x : 0, s ? s.y : 0, s ? s.z : 0 );
		return this.pos.length / 3 - 1;

	}

	quad( a: number, b: number, c: number, d: number ): void {

		this.idx.push( a, b, d, b, c, d );

	}

	tri( a: number, b: number, c: number ): void {

		this.idx.push( a, b, c );

	}

	build(): THREE.BufferGeometry {

		const g = new THREE.BufferGeometry();
		g.setAttribute( 'position', new THREE.Float32BufferAttribute( this.pos, 3 ) );
		g.setAttribute( 'normal', new THREE.Float32BufferAttribute( this.nrm, 3 ) );
		g.setAttribute( 'aData', new THREE.Float32BufferAttribute( this.dat, 4 ) );
		g.setAttribute( 'aSide', new THREE.Float32BufferAttribute( this.side, 3 ) );
		g.setIndex( this.idx );
		g.computeBoundingSphere();
		return g;

	}

}

// A ribbon along `pts`, its half-width `half( t )` across the unit vectors `across` (one per point);
// the normal faces `across` x tangent. aData from `data( t )`.
function ribbon( M: FloorMesh, pts: THREE.Vector3[], across: THREE.Vector3[], half: ( t: number ) => number, data: ( t: number ) => [ number, number, number, number ] ): void {

	const n = pts.length;
	let prev = - 1;
	for ( let i = 0; i < n; i ++ ) {

		const t = i / ( n - 1 );
		const tan = _a.subVectors( pts[ Math.min( i + 1, n - 1 ) ], pts[ Math.max( i - 1, 0 ) ] ).normalize();
		const nrm = _b.crossVectors( across[ i ], tan ).normalize();
		const w = half( t ), d = data( t );
		const s = across[ i ].clone().multiplyScalar( w );
		const l = M.v( _c.copy( pts[ i ] ).sub( s ), nrm, d, s.clone().negate() );
		M.v( _c.copy( pts[ i ] ).add( s ), nrm, d, s );
		if ( prev >= 0 ) M.quad( prev, prev + 1, l + 1, l );
		prev = l;

	}

}

// A tapered tube along `pts` with radii `radius( t )`, `sides` round, its far end closed to a point
// if `tip`. aData from `data( t )`.
function tube( M: FloorMesh, pts: THREE.Vector3[], radius: ( t: number ) => number, sides: number, data: ( t: number ) => [ number, number, number, number ], tip = false ): void {

	const n = pts.length, rows: number[] = [];
	const ref = new THREE.Vector3( 1, 0, 0 ), u = new THREE.Vector3(), w = new THREE.Vector3(), nrm = new THREE.Vector3(), p = new THREE.Vector3();
	for ( let i = 0; i < n; i ++ ) {

		const t = i / ( n - 1 );
		const tan = _a.subVectors( pts[ Math.min( i + 1, n - 1 ) ], pts[ Math.max( i - 1, 0 ) ] ).normalize();
		if ( Math.abs( tan.dot( ref ) ) > 0.9 ) ref.set( 0, 0, 1 );
		u.crossVectors( tan, ref ).normalize();
		w.crossVectors( tan, u );
		ref.copy( u );
		rows.push( M.pos.length / 3 );
		const r = radius( t ), d = data( t );
		for ( let k = 0; k < sides; k ++ ) {

			const a = k / sides * TAU;
			nrm.copy( u ).multiplyScalar( Math.cos( a ) ).addScaledVector( w, Math.sin( a ) );
			M.v( p.copy( pts[ i ] ).addScaledVector( nrm, r ), nrm, d );

		}

	}
	for ( let i = 0; i + 1 < n; i ++ ) for ( let k = 0; k < sides; k ++ ) {

		const k1 = ( k + 1 ) % sides;
		M.quad( rows[ i ] + k, rows[ i ] + k1, rows[ i + 1 ] + k1, rows[ i + 1 ] + k );

	}
	if ( tip ) {

		const end = pts[ n - 1 ], dir = _a.subVectors( end, pts[ n - 2 ] ).normalize();
		const c = M.v( _c.copy( end ).addScaledVector( dir, radius( 1 ) * 1.5 ), dir, data( 1 ) );
		for ( let k = 0; k < sides; k ++ ) M.tri( rows[ n - 1 ] + k, rows[ n - 1 ] + ( k + 1 ) % sides, c );

	}

}

// A sphere of `rows` by `cols`, its radius at a unit direction `radius( dir )`.
function blob( M: FloorMesh, centre: THREE.Vector3, radius: ( dir: THREE.Vector3 ) => number, rows: number, cols: number, data: ( dir: THREE.Vector3 ) => [ number, number, number, number ], from = 0 ): void {

	const first = M.pos.length / 3, dir = new THREE.Vector3(), p = new THREE.Vector3();
	for ( let i = 0; i <= rows; i ++ ) {

		const th = from + ( Math.PI - from ) * i / rows;
		for ( let k = 0; k <= cols; k ++ ) {

			const ph = k / cols * TAU;
			dir.set( Math.sin( th ) * Math.cos( ph ), Math.cos( th ), Math.sin( th ) * Math.sin( ph ) );
			M.v( p.copy( centre ).addScaledVector( dir, radius( dir ) ), dir, data( dir ) );

		}

	}
	for ( let i = 0; i < rows; i ++ ) for ( let k = 0; k < cols; k ++ ) {

		const a = first + i * ( cols + 1 ) + k, b = a + cols + 1;
		M.quad( a, a + 1, b + 1, b );

	}

}

// the normals of the vertices from `first` on, from their triangles (the blobs' lobes)
function smoothNormals( M: FloorMesh, first: number, firstIndex: number ): void {

	const n = new Float64Array( M.nrm.length );
	const P = M.pos, I = M.idx;
	for ( let t = firstIndex; t < I.length; t += 3 ) {

		const a = I[ t ], b = I[ t + 1 ], c = I[ t + 2 ];
		if ( a < first ) continue;
		_a.set( P[ b * 3 ] - P[ a * 3 ], P[ b * 3 + 1 ] - P[ a * 3 + 1 ], P[ b * 3 + 2 ] - P[ a * 3 + 2 ] );
		_b.set( P[ c * 3 ] - P[ a * 3 ], P[ c * 3 + 1 ] - P[ a * 3 + 1 ], P[ c * 3 + 2 ] - P[ a * 3 + 2 ] );
		_c.crossVectors( _a, _b );
		for ( const v of [ a, b, c ] ) {

			n[ v * 3 ] += _c.x; n[ v * 3 + 1 ] += _c.y; n[ v * 3 + 2 ] += _c.z;

		}

	}
	for ( let v = first; v < M.pos.length / 3; v ++ ) {

		_a.set( n[ v * 3 ], n[ v * 3 + 1 ], n[ v * 3 + 2 ] ).normalize();
		M.nrm[ v * 3 ] = _a.x; M.nrm[ v * 3 + 1 ] = _a.y; M.nrm[ v * 3 + 2 ] = _a.z;

	}

}

// a direction at polar angle `th` from +y, azimuth `ph`
const dirAt = ( th: number, ph: number ) => new THREE.Vector3( Math.sin( th ) * Math.cos( ph ), Math.cos( th ), Math.sin( th ) * Math.sin( ph ) );

// ------------------------------------------------------------------ the kinds

/** An eelgrass shoot: four leaves 1 m long at most, two-ranked, arching out as they rise. */
export function eelgrassGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0x2057 );
	const lengths = [ 0.62, 0.88, 1.0, 0.8 ];
	// four segments: the arch reads from the island's views, and the meadow's vertices are most of its cost
	const segments = 4;
	for ( let i = 0; i < lengths.length; i ++ ) {

		const L = lengths[ i ];
		// the two ranks, each leaf a little off its plane
		const ph = ( i % 2 ? Math.PI : 0 ) + ( rng() - 0.5 ) * 0.5;
		const lean0 = 0.05 + rng() * 0.12, bend = 0.45 + rng() * 0.5;
		const twist = ( rng() - 0.5 ) * 2.4;
		const out = new THREE.Vector3( Math.cos( ph ), 0, Math.sin( ph ) );
		const pts: THREE.Vector3[] = [], across: THREE.Vector3[] = [];
		const p = new THREE.Vector3( out.x * 0.003 * i, 0, out.z * 0.003 * i );
		const seed = rng();
		for ( let k = 0; k <= segments; k ++ ) {

			const t = k / segments;
			pts.push( p.clone() );
			const th = lean0 + bend * t * t;
			const tan = new THREE.Vector3( out.x * Math.sin( th ), Math.cos( th ), out.z * Math.sin( th ) );
			// across: horizontal, normal to the leaf's plane, turned about the leaf by its twist
			const flat = new THREE.Vector3( - out.z, 0, out.x );
			const normal = new THREE.Vector3().crossVectors( flat, tan );
			const a = twist * t;
			across.push( flat.clone().multiplyScalar( Math.cos( a ) ).addScaledVector( normal, Math.sin( a ) ).normalize() );
			p.addScaledVector( tan, L / segments );

		}
		// 1.2 cm wide at the longest leaf (a leaf is narrower as it is shorter), rounded at the tip
		const half = 0.006 * ( 0.7 + 0.3 * L );
		ribbon( M, pts, across, ( t ) => half * ( t < 0.85 ? 1 : 0.35 + 0.65 * ( 1 - t ) / 0.15 ), ( t ) => [ t * L, FLOOR_PART.LEAF, seed, t ] );

	}
	return M.build();

}

/** Ecklonia cava: a stipe and a crown of strap blades from a primary blade's margins. */
export function kelpGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0xec10 );
	const stipe = 0.6, lean = new THREE.Vector3( 0.06, 1, 0.02 ).normalize();
	const stipePts: THREE.Vector3[] = [];
	for ( let k = 0; k <= 4; k ++ ) stipePts.push( lean.clone().multiplyScalar( stipe * k / 4 ).add( new THREE.Vector3( 0, 0, 0 ) ) );
	// the stipe bends little: its flex grows with the square of the height
	tube( M, stipePts, ( t ) => 0.013 - 0.004 * t, 6, ( t ) => [ 0.15 * t * t, FLOOR_PART.STIPE, 0.5, t ] );
	const top = stipePts[ 4 ];
	// the primary blade, flat, up from the stipe's top
	const pFlat = new THREE.Vector3( 1, 0, 0 );
	const prim: THREE.Vector3[] = [], primAcross: THREE.Vector3[] = [];
	for ( let k = 0; k <= 4; k ++ ) {

		prim.push( top.clone().add( new THREE.Vector3( 0.02 * k / 4, 0.28 * k / 4, 0 ) ) );
		primAcross.push( pFlat );

	}
	ribbon( M, prim, primAcross, ( t ) => 0.035 * ( 1 - 0.6 * t ), ( t ) => [ 0.15 + 0.2 * t, FLOOR_PART.BLADE, 0.3, t * 0.4 ] );
	// the secondary blades along both margins, out and down
	const n = 12;
	for ( let i = 0; i < n; i ++ ) {

		const along = 0.08 + 0.85 * ( Math.floor( i / 2 ) / ( n / 2 - 1 ) );
		const side = i % 2 ? 1 : - 1;
		const base = top.clone().add( new THREE.Vector3( side * 0.03 * ( 1 - 0.6 * along ), 0.28 * along, ( rng() - 0.5 ) * 0.01 ) );
		const ph = ( side > 0 ? 0 : Math.PI ) + ( rng() - 0.5 ) * 1.4;
		const L = ( 0.38 + rng() * 0.16 ) * ( 1 - 0.35 * along );
		const out = new THREE.Vector3( Math.cos( ph ), 0, Math.sin( ph ) );
		const rise = 0.5 + rng() * 0.5, droop = 1.6 + rng() * 0.6;
		const pts: THREE.Vector3[] = [], across: THREE.Vector3[] = [];
		const p = base.clone(), seed = rng();
		for ( let k = 0; k <= 5; k ++ ) {

			const t = k / 5;
			pts.push( p.clone() );
			const th = Math.PI / 2 - rise + droop * t;
			const tan = new THREE.Vector3( out.x * Math.sin( th ), Math.cos( th ), out.z * Math.sin( th ) );
			const flat = new THREE.Vector3( - out.z, 0, out.x );
			// a strap's wavy margin turns it a little about its length
			const a = Math.sin( t * 9 + seed * 6 ) * 0.25;
			const normal = new THREE.Vector3().crossVectors( flat, tan );
			across.push( flat.clone().multiplyScalar( Math.cos( a ) ).addScaledVector( normal, Math.sin( a ) ).normalize() );
			p.addScaledVector( tan, L / 5 );

		}
		ribbon( M, pts, across, ( t ) => 0.028 * ( t < 0.8 ? 0.8 + 0.25 * t : 1 - ( t - 0.8 ) * 3.5 ), ( t ) => [ 0.25 + 0.75 * t, FLOOR_PART.BLADE, seed, t ] );

	}
	return M.build();

}

/** Acropora hyacinthus: a thin plate of 0.5 m radius, its rim lobed and a little raised, on a
 * short stalk. */
export function tableCoralGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0x7ab1 );
	const R = 0.5, h = 0.2, rings = 6, sectors = 28;
	const stalk: THREE.Vector3[] = [ new THREE.Vector3( 0, 0, 0 ), new THREE.Vector3( 0.01, h * 0.5, 0 ), new THREE.Vector3( 0, h, 0 ) ];
	tube( M, stalk, ( t ) => 0.07 + 0.03 * t * t, 8, ( t ) => [ 0, FLOOR_PART.STALK, 0.5, t * 0.2 ] );
	// the outline's lobes
	const lobes: number[] = [];
	for ( let k = 0; k < 4; k ++ ) lobes.push( rng() * TAU );
	const rim = ( a: number ) => R * ( 1 + 0.08 * Math.sin( 3 * a + lobes[ 0 ] ) + 0.06 * Math.sin( 5 * a + lobes[ 1 ] ) + 0.04 * Math.sin( 9 * a + lobes[ 2 ] ) );
	// the plate's surface: flat, rising a little to its rim, tilted by a few degrees
	const surf = ( r: number, a: number, top: boolean ) => {

		const ro = rim( a ), f = r;
		const x = Math.cos( a ) * ro * f, z = Math.sin( a ) * ro * f;
		const lift = 0.04 * f * f + 0.02 * x / R;
		const thick = 0.035 * ( 1 - f * 0.75 );
		return new THREE.Vector3( x, h + lift + ( top ? thick * 0.5 : - thick * 0.5 ), z );

	};
	for ( const top of [ true, false ] ) {

		const first = M.pos.length / 3, i0 = M.idx.length;
		const up = new THREE.Vector3( 0, top ? 1 : - 1, 0 );
		const centre = M.v( new THREE.Vector3( 0, h + ( top ? 0.018 : - 0.018 ), 0 ), up, [ 0, FLOOR_PART.PLATE, top ? 1 : 0, 0 ] );
		for ( let i = 1; i <= rings; i ++ ) for ( let k = 0; k < sectors; k ++ ) {

			const f = i / rings;
			M.v( surf( f, k / sectors * TAU, top ), up, [ 0, FLOOR_PART.PLATE, top ? 1 : 0, f ] );

		}
		const at = ( i: number, k: number ) => centre + 1 + ( i - 1 ) * sectors + ( k % sectors );
		for ( let k = 0; k < sectors; k ++ ) top ? M.tri( centre, at( 1, k + 1 ), at( 1, k ) ) : M.tri( centre, at( 1, k ), at( 1, k + 1 ) );
		for ( let i = 1; i < rings; i ++ ) for ( let k = 0; k < sectors; k ++ ) {

			if ( top ) M.quad( at( i, k ), at( i, k + 1 ), at( i + 1, k + 1 ), at( i + 1, k ) );
			else M.quad( at( i, k ), at( i + 1, k ), at( i + 1, k + 1 ), at( i, k + 1 ) );

		}
		smoothNormals( M, first, i0 );

	}
	// the rim's edge
	const first = M.pos.length / 3;
	for ( let k = 0; k <= sectors; k ++ ) {

		const a = k / sectors * TAU, out = new THREE.Vector3( Math.cos( a ), 0, Math.sin( a ) );
		M.v( surf( 1, a, true ), out, [ 0, FLOOR_PART.PLATE, 1, 1 ] );
		M.v( surf( 1, a, false ), out, [ 0, FLOOR_PART.PLATE, 0, 1 ] );

	}
	for ( let k = 0; k < sectors; k ++ ) M.quad( first + k * 2, first + k * 2 + 1, first + k * 2 + 3, first + k * 2 + 2 );
	return M.build();

}

// branches from `p` along `dir`, `depth` more times, into `M`
function branches( M: FloorMesh, rng: Rng, p: THREE.Vector3, dir: THREE.Vector3, len: number, r: number, depth: number, o: { split: number; spread: number; rise: number; part: number; sides: number; plane?: boolean }, level = 0, total = depth ): void {

	const pts: THREE.Vector3[] = [ p.clone() ];
	const d = dir.clone();
	const q = p.clone();
	// two segments a branch (at the island's distances a branch is a few pixels; its triangles
	// are the reef's cost), each turning as far as `rise` would over a third of the branch twice
	// over and a half
	const rise = 1 - Math.pow( 1 - o.rise, 1.5 );
	for ( let k = 1; k <= 2; k ++ ) {

		// each branch curves toward the light (up)
		d.lerp( new THREE.Vector3( 0, 1, 0 ), rise ).normalize();
		if ( o.plane ) d.z = 0, d.normalize();
		q.addScaledVector( d, len / 2 );
		pts.push( q.clone() );

	}
	const seed = rng(), end = depth === 0;
	const f0 = level / ( total + 1 ), f1 = ( level + 1 ) / ( total + 1 );
	tube( M, pts, ( t ) => r * ( 1 - 0.35 * t ), o.sides, ( t ) => [ f0 + ( f1 - f0 ) * t, o.part, seed, ( level + t ) / ( total + 1 ) ], end );
	if ( end ) return;
	const n = o.split;
	for ( let i = 0; i < n; i ++ ) {

		const nd = d.clone();
		if ( o.plane ) {

			const a = ( i / Math.max( n - 1, 1 ) - 0.5 ) * o.spread * 2 + ( rng() - 0.5 ) * 0.3;
			nd.applyAxisAngle( new THREE.Vector3( 0, 0, 1 ), a );

		} else {

			const axis = new THREE.Vector3().crossVectors( d, new THREE.Vector3( Math.cos( i / n * TAU + rng() ), 0, Math.sin( i / n * TAU + rng() ) ) ).normalize();
			nd.applyAxisAngle( axis, o.spread * ( 0.7 + rng() * 0.6 ) );

		}
		branches( M, rng, q, nd, len * ( 0.72 + rng() * 0.2 ), r * 0.68, depth - 1, o, level + 1, total );

	}

}

/** A branching Acropora: a bush of tapering branches, 0.3 m across. */
export function branchingCoralGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0xb4a7 );
	const n = 6;
	for ( let i = 0; i < n; i ++ ) {

		const d = dirAt( 0.5 + rng() * 0.5, i / n * TAU + rng() * 0.6 );
		branches( M, rng, new THREE.Vector3( d.x * 0.02, 0, d.z * 0.02 ), d, 0.09, 0.012, 2, { split: 2, spread: 0.5, rise: 0.18, part: FLOOR_PART.BRANCH, sides: 4 } );

	}
	return M.build();

}

/** A massive Porites: a lobed dome of 0.5 m radius, flaring onto the floor. */
export function massiveCoralGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0x9047 );
	const lobes: { d: THREE.Vector3; w: number }[] = [];
	for ( let k = 0; k < 7; k ++ ) lobes.push( { d: dirAt( rng() * 1.2, rng() * TAU ), w: 0.08 + rng() * 0.1 } );
	const first = M.pos.length / 3, i0 = M.idx.length;
	blob( M, new THREE.Vector3( 0, - 0.04, 0 ), ( dir ) => {

		let r = 0.5;
		for ( const L of lobes ) r += L.w * Math.max( 0, dir.dot( L.d ) - 0.6 ) * 2.5;
		// squashed, the lower side flaring out onto the floor
		return r * ( dir.y > 0 ? 0.72 + 0.28 * ( 1 - dir.y ) : 1 );

	}, 9, 18, ( dir ) => [ 0, FLOOR_PART.DOME, 0.5, Math.max( dir.y, 0 ) ], 0 );
	// flatten what lies below the floor to it
	for ( let v = first; v < M.pos.length / 3; v ++ ) M.pos[ v * 3 + 1 ] = Math.max( M.pos[ v * 3 + 1 ] * 0.72, - 0.03 );
	smoothNormals( M, first, i0 );
	return M.build();

}

// A unit icosahedron's corners and its faces, wound outward.
const ICOSAHEDRON: readonly ( readonly number[] )[] = ( () => {

	const t = ( 1 + Math.sqrt( 5 ) ) / 2, l = Math.hypot( 1, t );
	return [ [ - 1, t, 0 ], [ 1, t, 0 ], [ - 1, - t, 0 ], [ 1, - t, 0 ], [ 0, - 1, t ], [ 0, 1, t ], [ 0, - 1, - t ], [ 0, 1, - t ], [ t, 0, - 1 ], [ t, 0, 1 ], [ - t, 0, - 1 ], [ - t, 0, 1 ] ].map( ( v ) => v.map( ( x ) => x / l ) );

} )();
const ICOSAHEDRON_FACES = [ [ 0, 11, 5 ], [ 0, 5, 1 ], [ 0, 1, 7 ], [ 0, 7, 10 ], [ 0, 10, 11 ], [ 1, 5, 9 ], [ 5, 11, 4 ], [ 11, 10, 2 ], [ 10, 7, 6 ], [ 7, 1, 8 ], [ 3, 9, 4 ], [ 3, 4, 2 ], [ 3, 2, 6 ], [ 3, 6, 8 ], [ 3, 8, 9 ], [ 4, 9, 5 ], [ 2, 4, 11 ], [ 6, 2, 10 ], [ 8, 6, 7 ], [ 9, 8, 1 ] ];

/** Dendronephthya: a pale stalk branching into clusters of coloured polyps, 0.35 m tall. */
export function softCoralGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0x50f7 );
	const trunk: THREE.Vector3[] = [];
	for ( let k = 0; k <= 3; k ++ ) trunk.push( new THREE.Vector3( 0.01 * Math.sin( k ), 0.14 * k / 3, 0 ) );
	tube( M, trunk, ( t ) => 0.03 - 0.012 * t, 7, ( t ) => [ 0.2 * t, FLOOR_PART.STALK, 0.5, t * 0.4 ] );
	const knob = ( c: THREE.Vector3, r: number, seed: number, flex: number ) => {

		// an icosahedron's corners, each pushed in or out a little: a lump of polyps (an octahedron's
		// six read as small cubes at the island's distances)
		const first = M.pos.length / 3;
		for ( const d of ICOSAHEDRON ) {

			const k = r * ( 0.85 + 0.3 * rng() );
			M.v( new THREE.Vector3( c.x + d[ 0 ] * k, c.y + d[ 1 ] * k, c.z + d[ 2 ] * k ), new THREE.Vector3( d[ 0 ], d[ 1 ], d[ 2 ] ), [ flex, FLOOR_PART.POLYP, seed, 1 ] );

		}
		for ( const f of ICOSAHEDRON_FACES ) M.tri( first + f[ 0 ], first + f[ 1 ], first + f[ 2 ] );

	};
	const top = trunk[ 3 ];
	const n = 5;
	for ( let i = 0; i < n; i ++ ) {

		const d = dirAt( 0.45 + rng() * 0.5, i / n * TAU + rng() * 0.8 );
		const pts = [ top.clone() ], q = top.clone(), dd = d.clone();
		for ( let k = 1; k <= 3; k ++ ) {

			dd.lerp( new THREE.Vector3( 0, 1, 0 ), 0.25 ).normalize();
			q.addScaledVector( dd, 0.05 );
			pts.push( q.clone() );

		}
		const seed = rng();
		tube( M, pts, ( t ) => 0.016 - 0.008 * t, 5, ( t ) => [ 0.2 + 0.3 * t, FLOOR_PART.STALK, seed, 0.4 + 0.4 * t ] );
		// the polyps' clusters along the branch's end and its twigs
		for ( let k = 0; k < 7; k ++ ) {

			const s = 0.45 + 0.55 * rng();
			const c = pts[ 2 ].clone().lerp( pts[ 3 ], s ).add( dirAt( rng() * 2.2, rng() * TAU ).multiplyScalar( 0.02 + rng() * 0.03 ) );
			knob( c, 0.012 + rng() * 0.01, seed, 0.5 + 0.3 * s );

		}

	}
	return M.build();

}

/** A gorgonian sea fan: thin branches dividing in one plane, 0.5 m tall. */
export function seaFanGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0xfa77 );
	const stem: THREE.Vector3[] = [ new THREE.Vector3( 0, 0, 0 ), new THREE.Vector3( 0.005, 0.04, 0 ), new THREE.Vector3( 0, 0.08, 0 ) ];
	tube( M, stem, ( t ) => 0.012 - 0.003 * t, 5, () => [ 0, FLOOR_PART.FAN, 0.5, 0 ] );
	for ( let i = 0; i < 3; i ++ ) {

		const d = new THREE.Vector3( ( i - 1 ) * 0.6, 1, 0 ).normalize();
		branches( M, rng, stem[ 2 ], d, 0.11, 0.007, 4, { split: 2, spread: 0.42, rise: 0.06, part: FLOOR_PART.FAN, sides: 3, plane: true } );

	}
	return M.build();

}

/** Diadema setosum: a dark test of 7 cm and long thin spines. */
export function urchinGeometry(): THREE.BufferGeometry {

	const M = new FloorMesh(), rng = mulberry32( 0xd1ad );
	blob( M, new THREE.Vector3( 0, 0.03, 0 ), ( dir ) => 0.035 * ( dir.y > 0 ? 0.85 : 0.7 ), 5, 9, ( dir ) => [ 0, FLOOR_PART.TEST, 0.5, ( dir.y + 1 ) / 2 ] );
	const n = 40;
	for ( let i = 0; i < n; i ++ ) {

		// over the upper side and round the ambitus, a golden-angle spread
		const y = 1 - ( i + 0.5 ) / n * 1.15, rr = Math.sqrt( Math.max( 0, 1 - y * y ) );
		const a = i * 2.39996;
		const d = new THREE.Vector3( rr * Math.cos( a ), y, rr * Math.sin( a ) ).normalize();
		const base = new THREE.Vector3( 0, 0.03, 0 ).addScaledVector( d, 0.028 );
		const L = 0.1 + rng() * 0.1, seed = rng();
		tube( M, [ base, base.clone().addScaledVector( d, L ) ], ( t ) => 0.0022 * ( 1 - 0.8 * t ), 3, ( t ) => [ 0, FLOOR_PART.SPINE, seed, t ], true );

	}
	return M.build();

}
