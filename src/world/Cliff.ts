// The jointed and bedded structure of the island's cliffs, derived from the footprint alone, so a
// larger or different tile layout gets the same kind of wall with no hand-placed features.
//
// Sea cliffs in bedded limestone break along two kinds of planes: near-vertical joints, which
// split the wall into blocky columns, and bedding partings, which run along the whole coast at
// nearly one height and give the columns ledges, small overhangs and recessed softer beds. The
// sea undercuts the foot, and the columns retreat one by one, so the lip steps down where a block
// has fallen (down to a parting) and gullies open along wider joints. Here the columns are the
// cells of a Voronoi partition seeded along the coast line, so the joints meet the wall roughly
// square, leaning and twisting a little and some dying out at a parting; each column is a stack
// of blocks, one per bed or several welded together, each with its own face. Without that the
// wall read as dressed masonry: plumb joints through the full height and every parting coursing
// across every column.
//
// The wall is built as constructive solid geometry (union of cell-clipped, bed-sliced blocks
// with chamfered edges) rather than by blending offsets: the field stays close to a true
// distance (gradient ~1), so the 0.12 m surface nets keep ledges and joints crisp instead of
// stair-stepping them, and the vertex normals, which come from the field's gradient, stay flat
// on each block face.
//
// Art direction after observed coastal landforms (joint-controlled retreat, bedding ledges and
// wave-cut notches); no erosion is simulated:
// https://www.usgs.gov/media/images/factors-affecting-sea-cliff-erosion
// https://www.nps.gov/articles/coastal-processes-erosion.htm

import { hash3i, noise3, smoothstep } from './noise.ts';

// ------------------------------------------------------------------ bedding

// Partings sit at whole numbers of bedCoordinate( y + bedShift( x, z ) ). Two sines of unrelated
// periods make the beds' thickness vary without a rhythm, between ~0.6 and ~2 m up the wall; the
// shift is a gentle dip (about 2 degrees) plus a slow warp, so a parting crosses the coast at
// different heights.
const BED = { spacing: 0.95, amplitude: 0.17, period: 2.9, phase: 1.3, amplitude2: 0.06, period2: 1.73, phase2: 4.1, dipX: 0.028, dipZ: 0.021 };
const BED_W = 2 * Math.PI / BED.period, BED_W2 = 2 * Math.PI / BED.period2;

export function bedCoordinate( y: number ): number {

	return y / BED.spacing + Math.sin( y * BED_W + BED.phase ) * BED.amplitude + Math.sin( y * BED_W2 + BED.phase2 ) * BED.amplitude2;

}

// beds per metre at a height (always positive: the coordinate rises monotonically)
function bedRate( y: number ): number {

	return 1 / BED.spacing + Math.cos( y * BED_W + BED.phase ) * BED.amplitude * BED_W + Math.cos( y * BED_W2 + BED.phase2 ) * BED.amplitude2 * BED_W2;

}

// Both tabulated for the wall's hot loop (two sines each per sample otherwise); linear
// interpolation at 4 mm is exact to ~1e-5 bed.
const LUT_Y0 = - 14, LUT_STEP = 0.004, LUT_N = 6001;
const LUT_BETA = new Float64Array( LUT_N ), LUT_RATE = new Float64Array( LUT_N );
for ( let i = 0; i < LUT_N; i ++ ) {

	LUT_BETA[ i ] = bedCoordinate( LUT_Y0 + i * LUT_STEP );
	LUT_RATE[ i ] = bedRate( LUT_Y0 + i * LUT_STEP );

}

// bedCoordinate and bedRate at a height, written to out[ 0 ] and out[ 1 ]
function bedAt( y: number, out: Float64Array ): void {

	const u = ( y - LUT_Y0 ) / LUT_STEP, i = Math.floor( u );
	if ( i < 0 || i >= LUT_N - 1 ) { out[ 0 ] = bedCoordinate( y ); out[ 1 ] = bedRate( y ); return; }
	const t = u - i;
	out[ 0 ] = LUT_BETA[ i ] + ( LUT_BETA[ i + 1 ] - LUT_BETA[ i ] ) * t;
	out[ 1 ] = LUT_RATE[ i ] + ( LUT_RATE[ i + 1 ] - LUT_RATE[ i ] ) * t;

}

// the height at which bedCoordinate reaches beta
function bedHeight( beta: number ): number {

	let y = beta * BED.spacing;
	for ( let i = 0; i < 6; i ++ ) y -= ( bedCoordinate( y ) - beta ) / bedRate( y );
	return y;

}

export function bedShift( x: number, z: number ): number {

	// a slow warp and a shorter one, so a parting undulates instead of ruling a line
	return x * BED.dipX + z * BED.dipZ + noise3( x * 0.11 + 4.4, 6.1, z * 0.11 - 2.7 ) * 0.14
		+ noise3( x * 0.37 - 1.1, 2.9, z * 0.37 + 5.5 ) * 0.06;

}

// Beds below and above these indices take the nearest one's values (the wall spans ~-6..3.7 m).
const BED_MIN = - 10, BED_COUNT = 18;
const bedSlot = ( b: number ) => Math.max( 0, Math.min( BED_COUNT - 1, b - BED_MIN ) );

// A third of the beds are softer and weather back along the whole coast, leaving the bed above
// as a small overhang.
function softBed( b: number ): number {

	const r = hash3i( b, 17, 4409 );
	return r < 0.3 ? 0.07 + r / 0.3 * 0.1 : 0;

}

// ------------------------------------------------------------------ columns

export interface CoastColumn {
	key: number; // hashed from the quantised seed position: stable when the island grows elsewhere
	x: number; z: number; // seed on the wobbled coast
	nx: number; nz: number; // outward face normal (before the column's yaw)
	offset: number; // recess (+) or projection (-) of the whole column, m
	yaw: number; // face slope along the coast, m per m
	batter: number; // backward lean of the wall, m per m of drop
	steps: Float32Array; // per bed: extra recess (+) or projection (-), m
	pitch: Float32Array; // per bed: face lean across the bed (+: the bed's top recedes), m per bed
	// per bed: chamfer of the block's top and bottom edges (0: a sharp, broken edge), m, and how
	// much a weathering noise chips further into its edges
	parting: Float32Array; under: Float32Array; chipEdge: Float32Array;
	// per bed: a spall, an oblique plane that has broken one edge of the block off (NaN: none):
	// its tilt from the face (cosine, sine), its direction across the face (along the coast,
	// up) and where it starts from the block's centre, m
	spall: Float32Array;
	// per bed: a minor joint that splits the block (NaN: none): where along the coast from the
	// seed, the second part's extra recess and the joint's groove, m
	split: Float32Array;
	// wave-cut notch: depth, height of its back, and how far it reaches up (a sharp roof) and
	// down (a sloping floor), m
	notchDepth: number; notchY: number; notchUp: number; notchDown: number;
	chip: number; // small lowering of an intact lip, m
	lip: number; // chamfer of the lip, m
	dropBed: number; // NaN, or the parting (bed coordinate) a fallen column's stump stops at
	dropDepth: number; // how far behind the face the fallen block reached, m
	// the break narrows away from its deepest point (along the coast from the seed, m) beyond a
	// half width, by a taper (m of depth per m), so the scar is a wedge rather than a box
	// (each side its own), and the scar's back leans away from the face higher up (m per m), so
	// a broken slope rather than a vertical wall faces the sea
	dropAt: number; dropWidth: number; dropTaper: number; dropTaper2: number; dropLean: number;
}

const h = ( key: number, salt: number, k = 0 ) => hash3i( key, salt + k * 131, 7741 );

function gradient( f: ( x: number, z: number ) => number, x: number, z: number, e: number ): [ number, number ] {

	const gx = f( x + e, z ) - f( x - e, z ), gz = f( x, z + e ) - f( x, z - e );
	const l = Math.hypot( gx, gz ) || 1;
	return [ gx / l, gz / l ];

}

// Joint opening between two columns (groove depth at the face, m): about a third are closed,
// so two columns stand fused into one broader mass.
export function jointDepth( a: CoastColumn, b: CoastColumn ): number {

	const pair = hash3i( Math.min( a.key, b.key ), Math.max( a.key, b.key ), 5113 );
	return pair < 0.3 ? 0.012 : 0.04 + ( pair - 0.3 ) / 0.7 * 0.11;

}

// The joint between two columns is no plumb plane: it leans (m per m of height) and twists (its
// lean changes going inland), and a little under half of the joints die out at a parting, below
// which the columns stand fused along a tight seam a little to one side. Displacements are
// toward the column with the higher key (identical from both sides). [ lean, twist, the bed
// below which the joint is closed (-Infinity: open all the way down), its sideways jog there ]
export function jointShape( a: CoastColumn, b: CoastColumn, out: Float64Array, o: number ): void {

	const lo = Math.min( a.key, b.key ), hi = Math.max( a.key, b.key );
	const r = ( salt: number ) => hash3i( lo, hi, salt );
	out[ o ] = ( r( 5201 ) - 0.5 ) * 0.26;
	out[ o + 1 ] = ( r( 5202 ) - 0.5 ) * 0.16;
	const ends = r( 5203 ) < 0.45;
	out[ o + 2 ] = ends ? - 3 + Math.floor( r( 5204 ) * 5 ) : - Infinity;
	out[ o + 3 ] = ends ? ( r( 5205 ) > 0.5 ? 1 : - 1 ) * ( 0.15 + r( 5206 ) * 0.2 ) : 0;

}

// The coast columns of a footprint. `dist` is the footprint's signed distance, `coast` the
// macro wobble the island SDF adds to it (the wall sits at dist = coast) and `top` the meadow
// height. Everything is hashed from positions, so an unchanged stretch of coast keeps its
// columns whatever the rest of the layout is.
export class CoastColumns {

	columns: CoastColumn[] = [];
	private grid = new Map<number, number[]>();
	private cell = 2;

	constructor( dist: ( x: number, z: number ) => number, coast: ( x: number, z: number ) => number,
		top: ( x: number, z: number ) => number, bounds: { x0: number; z0: number; x1: number; z1: number } ) {

		// Candidate seeds where the footprint edge crosses a fine grid, thinned by dart throwing in
		// the order of a priority hashed from each candidate's own position.
		// The grid is anchored to the world, not to the layout's bounds, so the same stretch of
		// coast yields the same candidates when the island grows; its half-step offset keeps the
		// tile edges between its points.
		const step = 0.2, e = 0.12;
		const cand: { x: number; z: number; key: number; prio: number; r: number }[] = [];
		const i0 = Math.floor( ( bounds.x0 - 1 ) / step ), i1 = Math.ceil( ( bounds.x1 + 1 ) / step );
		const j0 = Math.floor( ( bounds.z0 - 1 ) / step ), j1 = Math.ceil( ( bounds.z1 + 1 ) / step );
		for ( let j = j0; j < j1; j ++ ) for ( let i = i0; i < i1; i ++ ) {

			const x = ( i + 0.5 ) * step, z = ( j + 0.5 ) * step;
			const d = dist( x, z );
			if ( Math.abs( d ) > step * 1.5 ) continue;
			for ( let axis = 0; axis < 2; axis ++ ) {

				const d1 = dist( x + ( axis === 0 ? step : 0 ), z + ( axis === 1 ? step : 0 ) );
				if ( d * d1 >= 0 ) continue;
				const t = d / ( d - d1 );
				const px = x + ( axis === 0 ? step * t : 0 ), pz = z + ( axis === 1 ? step * t : 0 );
				const key = hash3i( Math.round( px * 10 ), Math.round( pz * 10 ), 911 ) * 0x7fffffff | 0;
				// Columns mostly 0.8 - 2 m apart, unevenly; one in nine stands as a broad,
				// unjointed mass.
				const r = h( key, 1 ) < 0.11 ? 1.5 + h( key, 2 ) * 0.6 : 0.62 + h( key, 2 ) * h( key, 2 ) * 0.85;
				cand.push( { x: px, z: pz, key, prio: h( key, 3 ), r } );

			}

		}
		cand.sort( ( p, q ) => p.prio - q.prio );
		const accepted: { x: number; z: number; r: number; key: number }[] = [];
		const near = new Map<number, number[]>();
		const ck = ( i: number, j: number ) => ( i + 512 ) * 1024 + ( j + 512 );
		for ( const c of cand ) {

			const i = Math.floor( c.x / 2.5 ), j = Math.floor( c.z / 2.5 );
			let ok = true;
			for ( let dj = - 1; dj <= 1 && ok; dj ++ ) for ( let di = - 1; di <= 1 && ok; di ++ ) {

				for ( const a of near.get( ck( i + di, j + dj ) ) ?? [] ) {

					const o = accepted[ a ];
					if ( Math.hypot( o.x - c.x, o.z - c.z ) < ( o.r + c.r ) * 0.5 ) { ok = false; break; }

				}

			}
			if ( ! ok ) continue;
			const list = near.get( ck( i, j ) ) ?? [];
			list.push( accepted.length );
			near.set( ck( i, j ), list );
			accepted.push( c );

		}

		// Wide features (a gully or a buttress) keep several metres apart and stay off the
		// corners, where the wall turns: there they would read as damage to the plan.
		const features: { x: number; z: number }[] = [];
		const order = accepted.slice().sort( ( p, q ) => h( p.key, 4 ) - h( q.key, 4 ) );
		const role = new Map<number, 'gully' | 'buttress'>();
		for ( const s of order ) {

			const roll = h( s.key, 5 );
			if ( roll > 0.85 ) continue;
			const g = gradient( dist, s.x, s.z, e );
			let turn = 0;
			for ( const side of [ - 1, 1 ] ) {

				const q = gradient( dist, s.x - g[ 1 ] * side * 1.2, s.z + g[ 0 ] * side * 1.2, e );
				turn = Math.max( turn, Math.acos( Math.max( - 1, Math.min( 1, q[ 0 ] * g[ 0 ] + q[ 1 ] * g[ 1 ] ) ) ) );

			}
			if ( turn > 0.4 ) continue;
			if ( features.some( ( f ) => Math.hypot( f.x - s.x, f.z - s.z ) < 5.5 ) ) continue;
			// Half of them each, from the feature's own hash: a global count would swap the roles
			// of distant features whenever the layout grows.
			role.set( s.key, h( s.key, 38 ) < 0.5 ? 'gully' : 'buttress' );
			features.push( s );

		}

		for ( const s of accepted ) {

			const g = gradient( dist, s.x, s.z, e );
			// The wall sits at dist = coast: put the seed there, facing the wobbled coast's normal.
			const w = coast( s.x, s.z );
			const x = s.x + g[ 0 ] * w, z = s.z + g[ 1 ] * w;
			const gc = gradient( ( px, pz ) => dist( px, pz ) - coast( px, pz ), x, z, e );
			const k = s.key;
			const kind = role.get( k );
			// Softer beds weather back along the whole coast; a slow field decides how far here.
			const soft = 0.55 + 0.45 * noise3( x * 0.17 + 1.9, 2.2, z * 0.17 - 5.3 );
			const steps = new Float32Array( BED_COUNT ), pitch = new Float32Array( BED_COUNT );
			const parting = new Float32Array( BED_COUNT ), under = new Float32Array( BED_COUNT ), chipEdge = new Float32Array( BED_COUNT );
			const spall = new Float32Array( BED_COUNT * 5 ).fill( NaN );
			const split = new Float32Array( BED_COUNT * 3 ).fill( NaN );
			let walk = ( h( k, 6 ) - 0.5 ) * 0.2;
			const lean = ( h( k, 9 ) - 0.4 ) * 0.12;
			for ( let b = 0; b < BED_COUNT; b ++ ) {

				// The face's recess wanders from bed to bed instead of jumping independently,
				// and most partings pass without a step, so a column reads as one stack of
				// related blocks, not loose bricks.
				if ( h( k, 7, b ) < 0.38 ) walk += ( h( k, 8, b ) > 0.5 ? 1 : - 1 ) * ( 0.1 + h( k, 24, b ) * 0.14 );
				walk = Math.max( - 0.2, Math.min( 0.2, walk ) );
				steps[ b ] = walk + softBed( b + BED_MIN ) * soft;
				// A column keeps its lean; a quarter of its blocks have tilted on their own.
				pitch[ b ] = lean + ( h( k, 10, b ) < 0.25 ? ( h( k, 25, b ) - 0.45 ) * 0.4 : ( h( k, 25, b ) - 0.5 ) * 0.06 );
				// Most partings are tight lines; some open into a groove along a few columns. A
				// block's top and bottom edges are worn independently: many stay sharp and broken,
				// a few are rounded off, and the weathering noise chips into them unevenly, so no
				// block reads as a cushion with one even bevel.
				const open = hash3i( b + BED_MIN, 23, 3301 ) * 0.45 + h( k, 11, b ) * 0.55;
				parting[ b ] = open < 0.55 ? 0.004 + h( k, 39, b ) * 0.02 : 0.03 + ( open - 0.55 ) * 0.17;
				const low = h( k, 40, b );
				under[ b ] = low < 0.5 ? 0.004 : low < 0.85 ? 0.02 + ( low - 0.5 ) * 0.1 : 0.07 + ( low - 0.85 ) * 0.5;
				chipEdge[ b ] = h( k, 41, b ) < 0.6 ? 0.03 + h( k, 42, b ) * 0.12 : 0;
				// Only the partings that open along the coast cut every column. On most columns
				// over half of the others are welded: the beds on either side stand as one block
				// with one face, so the blocks' heights differ from column to column instead of
				// coursing like masonry.
				if ( b > 0 && hash3i( b - 1 + BED_MIN, 23, 3301 ) < 0.62 && softBed( b - 1 + BED_MIN ) === 0
					&& softBed( b + BED_MIN ) === 0 && h( k, 45, b ) < 0.6 ) {

					pitch[ b ] = pitch[ b - 1 ];
					steps[ b ] = steps[ b - 1 ] + pitch[ b - 1 ];
					walk = Math.max( - 0.25, Math.min( 0.25, steps[ b ] ) );
					parting[ b - 1 ] = 0;
					under[ b ] = 0;

				}
				// Nearly half the blocks have lost an edge or a corner along an oblique fracture.
				if ( h( k, 26, b ) < 0.45 ) {

					const tilt = 0.35 + h( k, 27, b ) * 0.45, dir = h( k, 28, b ) * Math.PI * 2;
					spall.set( [ Math.cos( tilt ), Math.sin( tilt ), Math.cos( dir ), Math.sin( dir ), 0.12 + h( k, 29, b ) * 0.35 ], b * 5 );

				}
				// A minor joint that does not run through the column breaks up the grid of blocks.
				if ( h( k, 30, b ) < 0.28 ) {

					const shift = ( h( k, 32, b ) > 0.5 ? 1 : - 1 ) * ( 0.05 + h( k, 33, b ) * 0.12 );
					split.set( [ ( h( k, 31, b ) - 0.5 ) * 0.7, shift, 0.02 + h( k, 34, b ) * 0.06 ], b * 3 );

				}

			}
			let offset = ( h( k, 12 ) - 0.5 ) * 0.3;
			if ( kind === 'gully' ) offset = 0.5 + h( k, 13 ) * 0.3;
			else if ( kind === 'buttress' ) offset = - 0.22 - h( k, 13 ) * 0.16;
			// A fallen column leaves a stump whose top is a parting below the meadow's planting
			// height (2.8 m), so no grass is left on a bare step. Gullies always lose their head;
			// intact columns only show small chips.
			const fallen = kind === 'gully' || ( kind !== 'buttress' && h( k, 14 ) < 0.22 );
			let dropBed = NaN;
			if ( fallen ) {

				const shift = bedShift( x, z ), t = top( x, z );
				// (a few centimetres under 2.8 m, which the weathering relief must not reach)
				const highest = Math.min( t - ( kind === 'gully' ? 0.7 : 0.36 ), 2.62 );
				const bed = Math.floor( bedCoordinate( highest + shift ) );
				// A thick bed would leave a stump far below the meadow: drop to it only where
				// the step stays within ~1.2 m.
				if ( t - ( bedHeight( bed ) - shift ) < 1.25 ) dropBed = bed;

			}
			this.columns.push( {
				key: k, x, z, nx: gc[ 0 ], nz: gc[ 1 ],
				offset, yaw: ( h( k, 15 ) - 0.5 ) * 0.34,
				batter: 0.02 + h( k, 16 ) * 0.07,
				steps, pitch, parting, under, chipEdge, spall, split,
				notchDepth: h( k, 17 ) < 0.8 ? 0.1 + h( k, 18 ) * 0.22 : 0,
				// The notch's sharp roof stays above the calm sea's crests (~0.3 m): a roof grazing
				// the surface left a bright seam along the waterline. The water meets its sloping floor.
				notchY: 0.2 + h( k, 19 ) * 0.2, notchUp: 0.13 + h( k, 20 ) * 0.1, notchDown: 0.4 + h( k, 20 ) * 0.25,
				chip: Number.isNaN( dropBed ) ? h( k, 21 ) * h( k, 21 ) * 0.08 : 0,
				lip: 0.02 + h( k, 22 ) * 0.07,
				dropBed,
				dropDepth: kind === 'gully' ? 0.7 + h( k, 23 ) * 0.35 : 0.3 + h( k, 23 ) * 0.45,
				dropAt: ( h( k, 35 ) - 0.5 ) * 0.6, dropWidth: 0.05 + h( k, 36 ) * 0.25,
				dropTaper: 1.1 + h( k, 37 ) * 1.3, dropTaper2: 0.7 + h( k, 43 ) * 1.6,
				dropLean: 0.15 + h( k, 44 ) * 0.35,
			} );

		}

		for ( let i = 0; i < this.columns.length; i ++ ) {

			const c = this.columns[ i ];
			const key = this.gridKey( Math.floor( c.x / this.cell ), Math.floor( c.z / this.cell ) );
			const list = this.grid.get( key ) ?? [];
			list.push( i );
			this.grid.set( key, list );

		}

	}

	private gridKey( i: number, j: number ): number {

		return ( i + 512 ) * 1024 + ( j + 512 );

	}

	// Indices of the three nearest columns, nearest first (-1 where missing). The search reaches
	// ~4 m; the island SDF only asks within ~3.5 m of the coast.
	nearest( x: number, z: number, out: Int32Array ): void {

		const ci = Math.floor( x / this.cell ), cj = Math.floor( z / this.cell );
		let d1 = Infinity, d2 = Infinity, d3 = Infinity, i1 = - 1, i2 = - 1, i3 = - 1;
		for ( let j = cj - 2; j <= cj + 2; j ++ ) for ( let i = ci - 2; i <= ci + 2; i ++ ) {

			const list = this.grid.get( this.gridKey( i, j ) );
			if ( ! list ) continue;
			for ( const n of list ) {

				const c = this.columns[ n ];
				const d = ( c.x - x ) * ( c.x - x ) + ( c.z - z ) * ( c.z - z );
				if ( d < d1 ) { d3 = d2; i3 = i2; d2 = d1; i2 = i1; d1 = d; i1 = n; } else if ( d < d2 ) { d3 = d2; i3 = i2; d2 = d; i2 = n; } else if ( d < d3 ) { d3 = d; i3 = n; }

			}

		}
		out[ 0 ] = i1; out[ 1 ] = i2; out[ 2 ] = i3;

	}

}

// ------------------------------------------------------------------ the wall

const K = Math.SQRT1_2;
// Neighbouring blocks overlap a little behind their chamfered edges. Touching solids would
// leave the union's field at zero on every internal parting and joint, where the weathering
// noise then raises stray surfaces inside the rock.
const BED_OVERLAP = 0.1, CELL_OVERLAP = 0.15;
// joints lean about this height (m), near the middle of the exposed wall
const JOINT_PIVOT = 1, JOINT_FLOOR = - 1.2;

// A block between two partings with face distance g, `above` / `below` its top and bottom
// (m, + outside), its top and bottom edges chamfered by pTop and pBot, overlapping the blocks
// above and below by `lap`.
function block( g: number, above: number, below: number, pTop: number, pBot: number, lap: number ): number {

	return Math.max( g, above - lap, below - lap, ( g + above + pTop ) * K, ( g + below + pBot ) * K );

}

// The cliff wall around a set of coast columns: a signed distance near the coast that
// already includes the meadow's top. Per-(x, z) work is cached across the vertical sample
// column the mesher runs through (y is innermost there).
export class CliffWall {

	// after each evaluation: the column the surface belongs to, its bed, how deep inside a joint
	// groove the point lies (0 .. 1), the bed coordinate and the height of that column's own top
	owner = - 1; bed = 0; joint = 0; beta = 0; lipY = 0;

	private cols: CoastColumns;
	private near = new Int32Array( 3 );
	private n = 0;
	private cx = NaN; private cz = NaN;
	private shift = 0; private topY = 0;
	// per neighbour: face distance, along the coast, rim, fallen cut distance, fallen floor
	private face = new Float64Array( 3 );
	private along = new Float64Array( 3 );
	private rim = new Float64Array( 3 );
	private cut = new Float64Array( 3 );
	private floor = new Float64Array( 3 );
	// per neighbour and each of its two others: the bisector's distance (+ inside), its sign
	// toward the higher key, the joint's lean here (m per m), the bed it closes below, the jog
	// there and the joint's opening at the face
	private bis = new Float64Array( 6 );
	private sgn = new Float64Array( 6 );
	private lean = new Float64Array( 6 );
	private closeBed = new Float64Array( 6 );
	private jog = new Float64Array( 6 );
	private jointC = new Float64Array( 6 );
	private shape = new Float64Array( 4 );
	private bedVal = new Float64Array( 2 );
	private exposed = false; // whether the nearest face lies within reach of the surface

	constructor( columns: CoastColumns ) {

		this.cols = columns;

	}

	private column( x: number, z: number, top: number ): void {

		if ( x === this.cx && z === this.cz ) return;
		this.cx = x; this.cz = z;
		this.cols.nearest( x, z, this.near );
		const cols = this.cols.columns;
		this.n = this.near[ 2 ] >= 0 ? 3 : this.near[ 1 ] >= 0 ? 2 : this.near[ 0 ] >= 0 ? 1 : 0;
		this.shift = bedShift( x, z );
		this.topY = top;
		this.exposed = false;
		for ( let i = 0; i < this.n; i ++ ) {

			const c = cols[ this.near[ i ] ];
			const dx = x - c.x, dz = z - c.z;
			// plane through the seed, turned by the column's yaw: a flat face per block
			const t = - dx * c.nz + dz * c.nx;
			const f = dx * c.nx + dz * c.nz + t * c.yaw + c.offset;
			this.face[ i ] = f;
			this.along[ i ] = t;
			// (the batter, notch, steps and fallen scars reach ~1.5 m behind the seed's plane)
			if ( f > - 1.8 && f < 1.2 ) this.exposed = true;
			// the cell's sides: the bisectors with the other two nearest columns
			let m = i * 2;
			this.bis[ m ] = this.bis[ m + 1 ] = Infinity;
			for ( let j = 0; j < this.n; j ++ ) {

				if ( j === i ) continue;
				const o = cols[ this.near[ j ] ];
				const ex = c.x - o.x, ez = c.z - o.z, el = Math.hypot( ex, ez ) || 1;
				const mx = x - ( c.x + o.x ) * 0.5, mz = z - ( c.z + o.z ) * 0.5;
				jointShape( c, o, this.shape, 0 );
				this.bis[ m ] = ( mx * ex + mz * ez ) / el;
				this.sgn[ m ] = c.key < o.key ? 1 : - 1;
				// the twist runs along the joint, outward from the pair's midpoint
				const out = Math.max( - 1.5, Math.min( 1.5, ( mx * ( c.nx + o.nx ) + mz * ( c.nz + o.nz ) ) * 0.5 ) );
				this.lean[ m ] = this.shape[ 0 ] + this.shape[ 1 ] * out;
				this.closeBed[ m ] = this.shape[ 2 ];
				this.jog[ m ] = this.shape[ 3 ];
				// Joints open toward the face; inland they close, so no trench runs across the meadow.
				this.jointC[ m ] = jointDepth( c, o ) * ( 1 - smoothstep( 0.2, 0.75, - f ) );
				m ++;

			}
			// Intact lips lose a few centimetres here and there.
			this.rim[ i ] = this.topY - c.chip * smoothstep( - 0.9, - 0.1, f );
			// A fallen block reached a broken, uneven line behind the face, deepest at one point
			// and narrowing to each side at its own rate.
			if ( Number.isNaN( c.dropBed ) ) this.cut[ i ] = - Infinity;
			else {

				const a = t - c.dropAt;
				this.cut[ i ] = - f - c.dropDepth + Math.max( 0, Math.abs( a ) - c.dropWidth ) * ( a > 0 ? c.dropTaper : c.dropTaper2 )
					- noise3( x * 1.7 + c.key % 97, 3.3, z * 1.7 ) * 0.16;
				this.floor[ i ] = bedHeight( c.dropBed ) - this.shift;

			}

		}

	}

	// Signed distance of the wall (with the meadow's top, `top` m high here) at a point.
	at( x: number, y: number, z: number, top: number ): number {

		this.column( x, z, top );
		const cols = this.cols.columns;
		const drop = this.topY - y;
		// The wall continues below the water with a lean that eases off toward the toe.
		const wallHeight = drop <= 2.8 ? drop : 2.8 + ( 1 - Math.exp( - ( drop - 2.8 ) / 1.2 ) ) * 1.2;
		const by = y + this.shift;
		bedAt( by, this.bedVal );
		const beta = this.bedVal[ 0 ], rate = this.bedVal[ 1 ];
		const k = Math.floor( beta );
		// The lean stops below the visible wall: deeper down it would pinch cells shut.
		const ly = Math.max( y, JOINT_FLOOR ) - JOINT_PIVOT;
		// Weathering chips into the blocks' edges unevenly along their length (only near the
		// face: behind it the chamfers it widens play no part).
		const wear = this.exposed ? noise3( x * 2.6 + 1.7, y * 2.6, z * 2.6 - 3.2 ) : 0;
		const chipP = Math.max( 0, wear ), chipJ = Math.max( 0, - wear );
		const rise = 0.6 + 0.4 * smoothstep( 0.2, 2.6, y );
		let best = Infinity;
		for ( let i = 0; i < this.n; i ++ ) {

			// Behind the face the blocks overlap generously: where leaning joints meet inland,
			// their displaced sides would otherwise leave slivers of no cell inside the rock, and
			// a parting just under the meadow would bring the field near zero there, where the
			// lip's chamfer then lifts it into a flat, folded skin.
			const deep = 0.6 * smoothstep( 0.4, 1.2, - this.face[ i ] );
			const overlap = CELL_OVERLAP + deep, lap = BED_OVERLAP + deep;
			// A column cannot come nearer than its cell's side: skip those that cannot win.
			const m0 = i * 2;
			let reach = Infinity;
			for ( let m = m0; m < m0 + 2; m ++ ) reach = Math.min( reach, this.bis[ m ] + Math.abs( this.lean[ m ] * ly ) + Math.abs( this.jog[ m ] ) );
			if ( - reach - overlap >= best ) continue;
			const c = cols[ this.near[ i ] ];
			const notch = ( y - c.notchY ) / ( y > c.notchY ? c.notchUp : c.notchDown );
			const base = this.face[ i ] - c.batter * wallHeight + c.notchDepth * Math.exp( - notch * notch );
			// one block per bed: its own face plane, sliced at the partings, edges chamfered
			let d = Infinity, owned = k, ownInside = 0, ownOpen = 0;
			for ( let b = k - 1; b <= k + 1; b ++ ) {

				const s = bedSlot( b );
				const mid = ( beta - b - 0.5 ) / rate; // height above the block's middle, m
				const f = base + c.steps[ s ] + c.pitch[ s ] * ( beta - b - 0.5 );
				const above = ( beta - b - 1 ) / rate, below = ( b - beta ) / rate;
				// (a welded parting, chamfer 0, takes no chips)
				const pTop = c.parting[ s ] > 0 ? c.parting[ s ] + c.chipEdge[ s ] * chipP : 0;
				const pBot = c.under[ s ] > 0 ? c.under[ s ] + c.chipEdge[ s ] * chipJ : 0;
				let v = block( f, above, below, pTop, pBot, lap );
				const sp = s * 5;
				if ( c.spall[ sp ] === c.spall[ sp ] ) {

					const u = this.along[ i ] * c.spall[ sp + 2 ] + mid * c.spall[ sp + 3 ];
					v = Math.max( v, f * c.spall[ sp ] + ( u - c.spall[ sp + 4 ] ) * c.spall[ sp + 1 ] );

				}
				const sj = s * 3;
				if ( c.split[ sj ] === c.split[ sj ] ) {

					// the two parts of a split block, each clipped at the minor joint and chamfered
					const a = this.along[ i ] - c.split[ sj ], g = c.split[ sj + 2 ];
					const v2 = block( f + c.split[ sj + 1 ], above, below, pTop, pBot, lap );
					v = Math.min( Math.max( v, a - CELL_OVERLAP, ( v + a + g ) * K ),
						Math.max( v2, - a - CELL_OVERLAP, ( v2 - a + g ) * K ) );

				}
				// Clipped to the column's cell at this bed, the joint edges chamfered. Joints open
				// wider toward the top, where water and roots work them from above; below the
				// parting where a joint dies out it is a tight seam, a little to one side.
				let inside = Infinity, open = 0;
				for ( let m = m0; m < m0 + 2; m ++ ) {

					const closed = b < this.closeBed[ m ];
					const dm = this.bis[ m ] + this.sgn[ m ] * ( this.lean[ m ] * ly + ( closed ? this.jog[ m ] : 0 ) );
					if ( dm < inside ) { inside = dm; open = this.jointC[ m ] * ( closed ? 0.12 : 1 ); }

				}
				open = open * rise + c.chipEdge[ s ] * chipJ * smoothstep( 0.01, 0.06, open );
				v = Math.max( v, - inside - overlap, ( v - inside + open ) * K );
				if ( v < d ) { d = v; owned = b; ownInside = inside; ownOpen = open; }

			}
			// the lip
			const lid = y - this.rim[ i ];
			d = Math.max( d, lid, ( d + lid + c.lip + 0.1 * chipP ) * K );
			// What is left of a fallen column: the stump stops at a parting, and the scar's back
			// slopes away from the face toward the top.
			let back = - Infinity;
			if ( this.cut[ i ] > - Infinity ) {

				back = this.cut[ i ] - c.dropLean * Math.max( 0, y - this.floor[ i ] );
				const cut = Math.max( ( c.dropBed - beta ) / rate, back );
				d = Math.max( d, - cut, ( d - cut + 0.06 ) * K );

			}
			if ( d < best ) {

				best = d;
				this.owner = this.near[ i ];
				this.bed = owned;
				this.joint = ownOpen > 0.02 ? 1 - smoothstep( 0, ownOpen * 1.4 + 0.04, ownInside ) : 0;
				this.lipY = back > - 0.05 ? this.floor[ i ] : this.rim[ i ];

			}

		}
		this.beta = beta;
		return best;

	}

}
