// The rim (src/world/RimGround.ts, FoliageSites.ts, RimTrails.ts), for tools/verify-world-local.mjs.
//
// The sub-box case: one record set holds three kinds, each built from the box's own window as a
// chunk would build it: the rim ground's texels whose centres lie in the box (the tile over the box
// and RIM_PAD round it), the rim bushes rooted in it (from the anchors within BUSH_REACH) and the
// trails whose lips' anchors lie in it (from the anchors and the coast traced within TRAIL_REACH,
// the bushes within TRAIL_BUSH_REACH). A record is the position (a texel's centre, a bush's anchor,
// a strand's root), the kind, every value the page draws from (padded to one stride) and, for a
// strand, a digest of its nodes, seed and leaf mound.
//
// `setup` also asserts, per seed and step:
//   - the page's build (the worker's: one lattice, the RIM_BOX boxes' tiles assembled, the trails
//     over the whole coast) holds the same records in each checked box as the box's window, bit
//     for bit;
//   - the turf skirt's pieces close across the borders of the box's 2 x 2 sub-boxes: every piece
//     that ends on an inner border meets exactly one piece that starts there in the neighbouring
//     sub-box, and the crossing rings (points, normals and sample data) agree within 1e-5; the
//     whole box's crossings on its outer border are the sub-boxes' crossings, rings alike;
//   - the trails over the whole coast: every patch holds 1 - 9 strands, no node sinks into the
//     cliff's lowest quarter (below a quarter of its root's height above the sea), the median bare
//     run is 0.4 - 4 m and none is longer than 4 m. A run counts at its length along the coast,
//     unless the straight line between its ends is under half that and the run bulges into the
//     land (its point farthest from that line lies inside the footprint and deeper in it than the
//     line's midpoint): the coast doubles back into a notch (a gully, the scar of a fallen column),
//     whose walls hold no lip (a lip looks out along the footprint's outward direction), and the
//     stone seen from the sea is the notch's mouth. A headland's bare run, which bulges out to sea,
//     counts at its length along the coast. A patch is the strands rooted at one lip (their
//     `anchor` cell) and their forks.
//
// Counts against integrate/isle-m3 (dart-thrown bushes from one running stream, the trails' lips
// from the bushes' stream) on the same islands: bushes, strands and the length hanging more than a
// quarter metre below the turf are printed per island and judged once the runner is done. Bushes:
// each grown island (step 8 on) within 10 %, and the sum over the islands run within 10 %. A
// starting island is printed only: it holds about 60 bushes, and across hash salts its count
// varies by 7 - 10 % (one sigma), so no one salt can promise 10 % there. Strands and hang: their
// sums over the islands run within 10 %.
//
// The anchors' sky visibility (computed by the worker from the world's solids) is left at 1.
import assert from 'node:assert/strict';
import { growLand } from '../../src/world/IslandGrowth.ts';
import { buildFootprint, makeIslandSDF, ISLAND_TOP } from '../../src/world/WorldShapes.ts';
import { RimLattice, RIM_PAD, RIM_CELL, SKIRT_RING, SKIRT_INFO, assembleRimGround, buildRimSkirt, coastChains, ownTexels, rimBoxes, rimGroundTile } from '../../src/world/RimGround.ts';
import { scatterTop } from '../../src/world/Anchors.ts';
import { pickBushes, BUSH_REACH, BUSH_STRIDE } from '../../src/world/FoliageSites.ts';
import { makeRimTrails, hanging, TRAIL_REACH, TRAIL_BUSH_REACH } from '../../src/world/RimTrails.ts';
import { VEGETATION_STRIDE } from '../../src/world/types.ts';

export const name = 'rim';

// integrate/isle-m3 at ad0c6ea, the worker's rim on the whole island, by seed / growth step: the
// bushes drawn, the trails' strands rooted in the turf and their hanging length (m).
const M3 = {
	'1/0': { bushes: 70, strands: 213, hang: 203.6 },
	'1/8': { bushes: 180, strands: 586, hang: 458.9 },
	'1/12': { bushes: 205, strands: 821, hang: 645.2 },
	'2/0': { bushes: 64, strands: 221, hang: 161.3 },
	'2/8': { bushes: 179, strands: 572, hang: 481.5 },
	'2/12': { bushes: 217, strands: 691, hang: 578.6 },
	'3/0': { bushes: 77, strands: 219, hang: 187.2 },
	'3/8': { bushes: 164, strands: 589, hang: 476.3 },
	'3/12': { bushes: 222, strands: 803, hang: 671.6 },
	'4/0': { bushes: 58, strands: 216, hang: 183.9 },
	'4/8': { bushes: 165, strands: 620, hang: 500.3 },
	'4/12': { bushes: 207, strands: 749, hang: 631.3 },
	'5/0': { bushes: 56, strands: 197, hang: 172.0 },
	'5/8': { bushes: 191, strands: 641, hang: 508.8 },
	'5/12': { bushes: 237, strands: 842, hang: 706.6 },
};

const VALUES = 15, TEXEL = 0, BUSH = 1, STRAND = 2;
const RING = 1e-5;

const grown = ( b, by ) => ( { x0: b.x0 - by, z0: b.z0 - by, x1: b.x1 + by, z1: b.z1 + by } );
const inBox = ( x, z, b ) => x >= b.x0 && x < b.x1 && z >= b.z0 && z < b.z1;

// The turf anchors whose jittered points lie in `box`, as the worker lays them out.
function anchorsIn( ctx, box ) {

	const raw = [];
	scatterTop( ctx.sdf, box, ISLAND_TOP, ( x, z ) => ctx.fp.dist( x, z ), raw );
	const anchors = new Float32Array( raw.length / 8 * VEGETATION_STRIDE );
	for ( let i = 0; i < raw.length / 8; i ++ ) {

		for ( let j = 0; j < 8; j ++ ) anchors[ i * VEGETATION_STRIDE + j ] = raw[ i * 8 + j ];
		anchors[ i * VEGETATION_STRIDE + 8 ] = 1;

	}
	return anchors;

}

// The worker's rim (worldWorker.ts `buildRim`): one lattice over the land's RIM_BOX boxes, their
// tiles, bushes and trails.
function pageRim( ctx ) {

	const b = ctx.fp.bounds;
	const anchors = anchorsIn( ctx, grown( b, 0.6 ) );
	const { boxes, lattice } = rimBoxes( ctx.sdf, b );
	const ground = assembleRimGround( boxes.map( ( box ) => ownTexels( rimGroundTile( lattice, box ), box ) ) );
	const owned = pickBushes( anchors, boxes );
	const bushes = new Float32Array( owned.reduce( ( n, part ) => n + part.length, 0 ) );
	owned.reduce( ( offset, part ) => { bushes.set( part, offset ); return offset + part.length; }, 0 );
	const coast = coastChains( lattice.signs(), 1 );
	const strands = [];
	for ( const list of makeRimTrails( ctx.sdf, ctx.fp, anchors, coast, bushes, boxes ) ) {

		const offset = strands.length;
		for ( const s of list ) strands.push( s.parent === undefined ? s : { ...s, parent: s.parent + offset } );

	}
	return { anchors, ground, bushes, coast, strands };

}

// FNV-1a over 32-bit words.
function digest( words, h = 0x811c9dc5 ) {

	for ( let k = 0; k < words.length; k ++ ) h = Math.imul( h ^ words[ k ], 0x01000193 ) >>> 0;
	return h;

}

const words = ( floats ) => new Uint32Array( floats.buffer, floats.byteOffset, floats.length );

// One record set from a box's texels (a field of own texels), bushes (BUSH_STRIDE each) and strands.
function records( texels, bushes, strands ) {

	const count = texels.nx * texels.nz + bushes.length / BUSH_STRIDE + strands.length;
	const position = new Float32Array( count * 3 ), kind = new Uint8Array( count ), values = new Float32Array( count * VALUES ), sums = new Uint32Array( count );
	let r = 0;
	const i0 = Math.round( texels.x0 / RIM_CELL ), j0 = Math.round( texels.z0 / RIM_CELL );
	for ( let j = 0; j < texels.nz; j ++ ) for ( let i = 0; i < texels.nx; i ++, r ++ ) {

		position.set( [ ( i0 + i + 0.5 ) * RIM_CELL, 0, ( j0 + j + 0.5 ) * RIM_CELL ], r * 3 );
		kind[ r ] = TEXEL;
		values.set( texels.data.subarray( ( j * texels.nx + i ) * 4, ( j * texels.nx + i + 1 ) * 4 ), r * VALUES );

	}
	for ( let k = 0; k < bushes.length; k += BUSH_STRIDE, r ++ ) {

		position.set( bushes.subarray( k, k + 3 ), r * 3 );
		kind[ r ] = BUSH;
		values.set( bushes.subarray( k + 3, k + BUSH_STRIDE ), r * VALUES );

	}
	for ( const s of strands ) {

		position.set( s.points.subarray( 0, 3 ), r * 3 );
		kind[ r ] = STRAND;
		// a fork names its parent by the parent's root, which no list order changes
		const parent = s.parent === undefined ? [ 0, 0, 0 ] : strands[ s.parent ].points.subarray( 0, 3 );
		values.set( [ s.points.length / 6, s.lip, s.from ?? - 1, s.parent === undefined ? 0 : 1, ...parent, s.clump ? s.clump.length / 6 : 0, ...( s.leaf ?? [ 0, 0, 0, 0, 0 ] ), ...( s.anchor ?? [ 0, 0 ] ) ], r * VALUES );
		sums[ r ] = digest( words( s.clump ?? new Float32Array( 0 ) ), digest( words( s.points ), digest( [ s.seed >>> 0 ] ) ) );
		r ++;

	}
	return { position: { records: position, stride: 3 }, kind, values: { records: values, stride: VALUES }, digest: sums };

}

// What a chunk builds for the box from its own window: the rim ground's tile, the bushes and the
// trails.
function windowRim( ctx, box ) {

	const tile = rimGroundTile( new RimLattice( ctx.sdf, grown( box, RIM_PAD ) ), box );
	const bushes = pickBushes( anchorsIn( ctx, grown( box, BUSH_REACH ) ), [ box ] )[ 0 ];
	const window = grown( box, TRAIL_REACH ), anchors = anchorsIn( ctx, window );
	const coast = coastChains( new RimLattice( ctx.sdf, window ).signs(), 1 );
	const near = pickBushes( anchors, [ grown( box, TRAIL_BUSH_REACH ) ] )[ 0 ];
	return { tile, bushes, strands: makeRimTrails( ctx.sdf, ctx.fp, anchors, coast, near, [ box ] )[ 0 ] };

}

// The box's share of the page's bushes and trails: the bushes rooted in the box, and the trails
// whose lips lie in it, chosen over the whole coast.
function pageShare( ctx, page, box ) {

	const bushes = [];
	for ( let k = 0; k < page.bushes.length; k += BUSH_STRIDE ) if ( inBox( page.bushes[ k ], page.bushes[ k + 2 ], box ) ) bushes.push( ...page.bushes.subarray( k, k + BUSH_STRIDE ) );
	return { bushes: new Float32Array( bushes ), strands: makeRimTrails( ctx.sdf, ctx.fp, page.anchors, page.coast, page.bushes, [ box ] )[ 0 ] };

}

// A record set in the order of its records' fields (the position first), as the runner compares
// them: the page and a chunk list a box's bushes and trails in their own orders.
function canonical( set ) {

	const fields = Object.values( set ).map( ( f ) => f.records ? f : { records: f, stride: 1 } );
	const order = Array.from( { length: set.kind.length }, ( _, i ) => i ).sort( ( p, q ) => {

		for ( const { records, stride } of fields ) for ( let j = 0; j < stride; j ++ ) {

			const d = records[ p * stride + j ] - records[ q * stride + j ];
			if ( d !== 0 ) return d;

		}
		return 0;

	} );
	return Object.fromEntries( Object.entries( set ).map( ( [ name, f ] ) => {

		const { records, stride = 1 } = f.records ? f : { records: f };
		const sorted = new records.constructor( records.length );
		order.forEach( ( from, to ) => sorted.set( records.subarray( from * stride, ( from + 1 ) * stride ), to * stride ) );
		return [ name, f.records ? { records: sorted, stride } : sorted ];

	} ) );

}

// The first difference between two record sets, or '' when they hold the same records bit for bit.
function difference( a, b ) {

	a = canonical( a ); b = canonical( b );

	const kinds = [ 'texels', 'bushes', 'strands' ], count = ( r, k ) => r.kind.filter( ( v ) => v === k ).length;
	for ( let k = 0; k < kinds.length; k ++ ) if ( count( a, k ) !== count( b, k ) ) return `${ count( a, k ) } ${ kinds[ k ] } against ${ count( b, k ) }`;
	for ( const field of Object.keys( a ) ) {

		const x = a[ field ].records ?? a[ field ], y = b[ field ].records ?? b[ field ], stride = a[ field ].stride ?? 1;
		const bx = x instanceof Float32Array ? words( x ) : x, by = y instanceof Float32Array ? words( y ) : y;
		for ( let i = 0; i < bx.length; i ++ ) {

			if ( bx[ i ] !== by[ i ] ) {

				const r = Math.floor( i / stride );
				return `${ kinds[ a.kind[ r ] ] } record at ( ${ Array.from( a.position.records.subarray( r * 3, r * 3 + 3 ) ).join( ', ' ) } ): ${ field } [${ i % stride }] ${ x[ i ] } against ${ y[ i ] }`;

			}

		}

	}
	return '';

}

// ------------------------------------------------------------------ turf skirt across sub-boxes

// The skirt's samples at the ends of each piece of a box: position, rings and sample data.
function pieceEnds( ctx, box ) {

	const tile = rimGroundTile( new RimLattice( ctx.sdf, grown( box, RIM_PAD ) ), box );
	const skirt = buildRimSkirt( ctx.sdf, tile, box );
	const sample = ( q ) => ( {
		x: skirt.info[ q * SKIRT_INFO ], z: skirt.info[ q * SKIRT_INFO + 1 ],
		data: [ ...skirt.points.subarray( q * SKIRT_RING * 3, ( q + 1 ) * SKIRT_RING * 3 ), ...skirt.normals.subarray( q * SKIRT_RING * 3, ( q + 1 ) * SKIRT_RING * 3 ), ...skirt.info.subarray( q * SKIRT_INFO, ( q + 1 ) * SKIRT_INFO ) ],
	} );
	const ends = [];
	for ( let k = 0; k < skirt.pieces.length; k += 2 ) {

		const first = skirt.pieces[ k ], last = first + skirt.pieces[ k + 1 ] - 1;
		const start = sample( first ), end = sample( last );
		// a loop inside the box ends where it starts
		if ( start.x === end.x && start.z === end.z ) continue;
		ends.push( { ...start, start: true }, { ...end, start: false } );

	}
	return ends;

}

const onLine = ( v, line ) => Math.abs( v - line ) < 1e-9;

function checkSkirt( ctx, box ) {

	const mx = ( box.x0 + box.x1 ) / 2, mz = ( box.z0 + box.z1 ) / 2;
	const subs = [ [ box.x0, box.z0, mx, mz ], [ mx, box.z0, box.x1, mz ], [ box.x0, mz, mx, box.z1 ], [ mx, mz, box.x1, box.z1 ] ]
		.map( ( [ x0, z0, x1, z1 ] ) => ( { x0, z0, x1, z1 } ) );
	const ends = subs.map( ( sub ) => pieceEnds( ctx, sub ) );
	const label = `rim box [${ box.x0 }, ${ box.z0 }]-[${ box.x1 }, ${ box.z1 }]`;
	let worst = 0;
	// the partner of an end among the other sub-boxes' ends: the opposite end at the same point
	const partner = ( e, s ) => {

		const found = [];
		ends.forEach( ( list, t ) => {

			if ( t === s ) return;
			for ( const o of list ) if ( o.start !== e.start && Math.abs( o.x - e.x ) <= RING && Math.abs( o.z - e.z ) <= RING ) found.push( o );

		} );
		return found;

	};
	const compare = ( a, b, what ) => {

		for ( let k = 0; k < a.data.length; k ++ ) {

			const d = Math.abs( a.data[ k ] - b.data[ k ] );
			worst = Math.max( worst, d );
			assert.ok( d <= RING, `${ label }: the skirt's rings at ${ what } ( ${ a.x }, ${ a.z } ) differ by ${ d } (value ${ k })` );

		}

	};
	let inner = 0;
	ends.forEach( ( list, s ) => {

		for ( const e of list ) {

			const outer = onLine( e.x, box.x0 ) || onLine( e.x, box.x1 ) || onLine( e.z, box.z0 ) || onLine( e.z, box.z1 );
			if ( outer || ! ( onLine( e.x, mx ) || onLine( e.z, mz ) ) ) continue;
			const found = partner( e, s );
			assert.equal( found.length, 1, `${ label }: a skirt piece ${ e.start ? 'starting' : 'ending' } on an inner border at ( ${ e.x }, ${ e.z } ) meets ${ found.length } pieces across it` );
			compare( e, found[ 0 ], 'an inner crossing' );
			inner ++;

		}

	} );
	// the whole box's crossings on its outer border, in the sub-box that holds them
	let outer = 0;
	for ( const e of pieceEnds( ctx, box ) ) {

		const all = ends.flat().filter( ( o ) => o.start === e.start && Math.abs( o.x - e.x ) <= RING && Math.abs( o.z - e.z ) <= RING );
		assert.equal( all.length, 1, `${ label }: the whole box's skirt crossing at ( ${ e.x }, ${ e.z } ) is ${ all.length } sub-box crossings` );
		compare( e, all[ 0 ], 'an outer crossing' );
		outer ++;

	}
	return { inner: inner / 2, outer, worst };

}

// ------------------------------------------------------------------ trail statistics

function trailStats( page, fp ) {

	// the coast's closed loops, with each vertex's arc position
	const loops = page.coast.filter( ( c ) => c.closed && c.x.length > 20 ).map( ( c ) => {

		const arc = [ 0 ];
		for ( let k = 1; k < c.x.length; k ++ ) arc.push( arc[ k - 1 ] + Math.hypot( c.x[ k ] - c.x[ k - 1 ], c.z[ k ] - c.z[ k - 1 ] ) );
		const n = c.x.length;
		return { c, arc, length: arc[ n - 1 ] + Math.hypot( c.x[ 0 ] - c.x[ n - 1 ], c.z[ 0 ] - c.z[ n - 1 ] ) };

	} );
	const cells = new Map(), key = ( i, j ) => `${ i },${ j }`;
	loops.forEach( ( { c }, l ) => c.x.forEach( ( x, k ) => {

		const id = key( Math.floor( x ), Math.floor( c.z[ k ] ) );
		if ( ! cells.has( id ) ) cells.set( id, [] );
		cells.get( id ).push( [ l, k ] );

	} ) );
	const locate = ( x, z ) => {

		let best = null, bestD = 1.5;
		for ( let j = Math.floor( z ) - 2; j <= Math.floor( z ) + 2; j ++ ) for ( let i = Math.floor( x ) - 2; i <= Math.floor( x ) + 2; i ++ ) {

			for ( const [ l, k ] of cells.get( key( i, j ) ) ?? [] ) {

				const d = Math.hypot( loops[ l ].c.x[ k ] - x, loops[ l ].c.z[ k ] - z );
				if ( d < bestD ) { bestD = d; best = [ l, k ]; }

			}

		}
		return best;

	};
	// patches: the strands rooted at one lip, named by its anchor cell (forks belong to their
	// parent's)
	const byAnchor = new Map();
	for ( const s of page.strands ) {

		if ( s.parent !== undefined ) continue;
		const id = key( ...s.anchor );
		if ( ! byAnchor.has( id ) ) byAnchor.set( id, [] );
		byAnchor.get( id ).push( s );

	}
	const patches = [ ...byAnchor.values() ];
	const sizes = patches.map( ( p ) => p.length );
	// the lowest node against its root's height above the sea (a fork against its parent's root)
	let lowest = Infinity;
	for ( const s of page.strands ) {

		const root = ( s.parent === undefined ? s : page.strands[ s.parent ] ).points[ 1 ];
		for ( let k = 1; k < s.points.length; k += 6 ) lowest = Math.min( lowest, s.points[ k ] / root );

	}
	// each patch's span along its loop (its strands' lip nodes, 8 cm either side), merged
	const spans = loops.map( () => [] );
	for ( const patch of patches ) {

		let loop = - 1, first = 0, lo = Infinity, hi = - Infinity;
		for ( const s of patch ) {

			const at = locate( s.points[ s.lip * 6 ], s.points[ s.lip * 6 + 2 ] );
			if ( ! at ) continue;
			if ( loop < 0 ) { loop = at[ 0 ]; first = loops[ loop ].arc[ at[ 1 ] ]; }
			if ( at[ 0 ] !== loop ) continue;
			const L = loops[ loop ].length;
			let a = loops[ loop ].arc[ at[ 1 ] ];
			while ( a - first > L / 2 ) a -= L;
			while ( first - a > L / 2 ) a += L;
			lo = Math.min( lo, a ); hi = Math.max( hi, a );

		}
		if ( loop >= 0 ) spans[ loop ].push( [ lo - 0.08, hi + 0.08 ] );

	}
	// the point at arc position a on a loop
	const pointAt = ( { c, arc, length }, a ) => {

		a = ( ( a % length ) + length ) % length;
		let k = 0;
		while ( k + 1 < arc.length && arc[ k + 1 ] < a ) k ++;
		const e = ( k + 1 ) % c.x.length, l = ( k + 1 < arc.length ? arc[ k + 1 ] : length ) - arc[ k ], f = l > 0 ? ( a - arc[ k ] ) / l : 0;
		return [ c.x[ k ] + ( c.x[ e ] - c.x[ k ] ) * f, c.z[ k ] + ( c.z[ e ] - c.z[ k ] ) * f ];

	};
	// whether the run from arc position a to b, whose ends are ( ax, az ) and ( bx, bz ), bulges
	// into the land: its point farthest from the mouth (the line between its ends) lies inside the
	// footprint, deeper than the mouth's midpoint
	const notch = ( loop, a, b, ax, az, bx, bz ) => {

		const ux = bx - ax, uz = bz - az, u = Math.hypot( ux, uz ) || 1;
		let deep = [ ax, az ], depth = - 1;
		for ( let t = a; t <= b; t += 0.05 ) {

			const [ x, z ] = pointAt( loop, t );
			const d = Math.abs( ( x - ax ) * uz - ( z - az ) * ux ) / u;
			if ( d > depth ) { depth = d; deep = [ x, z ]; }

		}
		const inside = fp.dist( deep[ 0 ], deep[ 1 ] );
		return inside < 0 && inside < fp.dist( ( ax + bx ) / 2, ( az + bz ) / 2 );

	};
	const runs = [];
	let coast = 0;
	loops.forEach( ( loop, l ) => {

		coast += loop.length;
		const L = loop.length;
		const list = spans[ l ].map( ( [ a, b ] ) => {

			const s = ( ( a % L ) + L ) % L;
			return [ s, s + b - a ];

		} ).sort( ( p, q ) => p[ 0 ] - q[ 0 ] );
		const merged = [];
		for ( const [ a, b ] of list ) {

			if ( merged.length && a <= merged[ merged.length - 1 ][ 1 ] ) merged[ merged.length - 1 ][ 1 ] = Math.max( merged[ merged.length - 1 ][ 1 ], b );
			else merged.push( [ a, b ] );

		}
		if ( ! merged.length ) {

			runs.push( { along: L, counted: L } );
			return;

		}
		for ( let i = 0; i < merged.length; i ++ ) {

			const from = merged[ i ][ 1 ], to = i + 1 < merged.length ? merged[ i + 1 ][ 0 ] : merged[ 0 ][ 0 ] + L;
			if ( to <= from ) continue;
			const [ ax, az ] = pointAt( loop, from ), [ bx, bz ] = pointAt( loop, to );
			const along = to - from, straight = Math.hypot( ax - bx, az - bz );
			runs.push( { along, counted: straight < along / 2 && notch( loop, from, to, ax, az, bx, bz ) ? straight : along } );

		}

	} );
	runs.sort( ( a, b ) => a.counted - b.counted );
	const median = runs.length ? runs[ Math.floor( runs.length / 2 ) ].counted : 0;
	return {
		coast, patches: patches.length, sizes, lowest, runs: runs.length, median,
		longest: Math.max( 0, ...runs.map( ( r ) => r.counted ) ), longestAlong: Math.max( 0, ...runs.map( ( r ) => r.along ) ),
		notches: runs.filter( ( r ) => r.counted < r.along ).length,
		strands: page.strands.filter( ( s ) => s.parent === undefined ).length, forks: page.strands.filter( ( s ) => s.parent !== undefined ).length,
		hang: hanging( page.strands, 0 ),
	};

}

// ------------------------------------------------------------------ counts against M3

const pooled = { all: {}, grown: [] };
process.once( 'beforeExit', () => {

	const sums = Object.entries( pooled.all );
	if ( ! sums.length ) {

		console.log( '     rim counts not judged: no island run has M3 counts' );
		return;

	}
	const off = sums.filter( ( [ , [ n, m ] ] ) => Math.abs( n / m - 1 ) > 0.1 );
	const grownOff = pooled.grown.filter( ( [ , n, m ] ) => Math.abs( n / m - 1 ) > 0.1 );
	const percent = ( n, m ) => `${ ( ( n / m - 1 ) * 100 ).toFixed( 1 ) } %`;
	console.log( `${ off.length || grownOff.length ? 'FAIL' : 'ok  ' } rim counts against M3, summed over the islands run: ${ sums.map( ( [ kind, [ n, m ] ] ) => `${ kind } ${ percent( n, m ) }` ).join( ', ' ) }; ` +
		`bushes on the grown islands: ${ pooled.grown.length ? pooled.grown.map( ( [ id, n, m ] ) => `${ id } ${ percent( n, m ) }` ).join( ', ' ) : 'none run' }` );
	if ( off.length || grownOff.length ) process.exitCode = 1;

} );

function judgeCounts( seed, grow, counts ) {

	const reference = M3[ `${ seed }/${ grow }` ];
	if ( ! reference ) return '';
	for ( const kind of Object.keys( counts ) ) {

		const sum = pooled.all[ kind ] ??= [ 0, 0 ];
		sum[ 0 ] += counts[ kind ]; sum[ 1 ] += reference[ kind ];

	}
	if ( grow >= 8 ) pooled.grown.push( [ `${ seed }/${ grow }`, counts.bushes, reference.bushes ] );
	return ` (${ Object.keys( counts ).map( ( kind ) => `${ kind } ${ ( ( counts[ kind ] / reference[ kind ] - 1 ) * 100 ).toFixed( 1 ) } %` ).join( ', ' ) } against M3)`;

}

// ------------------------------------------------------------------ the case

export function setup( { seed, grow } ) {

	const { land } = growLand( seed, grow );
	const fp = buildFootprint( land );
	const ctx = { fp, sdf: makeIslandSDF( fp ), cache: new Map() };
	const page = pageRim( ctx );

	const st = trailStats( page, fp );
	assert.ok( st.sizes.every( ( n ) => n >= 1 && n <= 9 ), `a trail patch holds ${ Math.max( ...st.sizes ) } strands` );
	assert.ok( st.lowest >= 0.25, `a trail sinks to ${ st.lowest.toFixed( 3 ) } of its root's height, into the cliff's lowest quarter` );
	assert.ok( st.median >= 0.4 && st.median <= 4, `the median bare run between trail patches is ${ st.median.toFixed( 2 ) } m` );
	assert.ok( st.longest <= 4, `a bare run between trail patches is ${ st.longest.toFixed( 2 ) } m long` );
	const counts = { bushes: page.bushes.length / BUSH_STRIDE, strands: st.strands, hang: st.hang };
	console.log( `     rim seed ${ seed } grow ${ grow }: ${ counts.bushes } bushes, ${ st.patches } trail patches of ${ Math.min( ...st.sizes ) } - ${ Math.max( ...st.sizes ) } strands ` +
		`(${ st.strands } strands, ${ st.forks } forks, ${ st.hang.toFixed( 1 ) } m hanging, ${ ( st.strands / st.coast ).toFixed( 2 ) } strands per m of ${ st.coast.toFixed( 1 ) } m of coast)${ judgeCounts( seed, grow, counts ) }; ` +
		`lowest node at ${ st.lowest.toFixed( 3 ) } of its root's height; ${ st.runs } bare runs, median ${ st.median.toFixed( 2 ) } m, longest ${ st.longest.toFixed( 2 ) } m ` +
		`(${ st.longestAlong.toFixed( 2 ) } m along the coast, ${ st.notches } across notches)` );

	// two boxes of 2 x 2 sub-boxes, off the 16 m grid, whose inner borders cross the coast: centred
	// a metre inside the land's southernmost and westernmost coast points
	let south = [ 0, Infinity ], west = [ Infinity, 0 ];
	for ( const c of page.coast ) c.x.forEach( ( x, k ) => {

		if ( c.z[ k ] < south[ 1 ] ) south = [ x, c.z[ k ] ];
		if ( x < west[ 0 ] ) west = [ x, c.z[ k ] ];

	} );
	const around = ( x, z ) => ( { x0: x - 16, z0: z - 16, x1: x + 16, z1: z + 16 } );
	ctx.boxes = [ around( Math.round( south[ 0 ] ), Math.ceil( south[ 1 ] ) + 1 ), around( Math.ceil( west[ 0 ] ) + 1, Math.round( west[ 1 ] ) ) ];
	// the page's assembled rim ground covers its own boxes, and holds the open sea's values beyond
	const g = page.ground, covered = { x0: g.x0, z0: g.z0, x1: g.x0 + g.nx * g.cell, z1: g.z0 + g.nz * g.cell };
	const skirt = [];
	for ( const box of ctx.boxes ) {

		const own = windowRim( ctx, box ), share = pageShare( ctx, page, box );
		ctx.cache.set( JSON.stringify( box ), records( ownTexels( own.tile, box ), own.bushes, own.strands ) );
		const region = { x0: Math.max( box.x0, covered.x0 ), z0: Math.max( box.z0, covered.z0 ), x1: Math.min( box.x1, covered.x1 ), z1: Math.min( box.z1, covered.z1 ) };
		const differs = difference( records( ownTexels( g, region ), share.bushes, share.strands ), records( ownTexels( own.tile, region ), own.bushes, own.strands ) );
		assert.equal( differs, '', `rim box [${ box.x0 }, ${ box.z0 }]-[${ box.x1 }, ${ box.z1 }]: the page's build differs from the box's window: ${ differs }` );
		skirt.push( checkSkirt( ctx, box ) );

	}
	assert.ok( skirt.reduce( ( n, s ) => n + s.inner, 0 ) > 0, 'no skirt piece crosses an inner border of the boxes' );
	console.log( `     rim seed ${ seed } grow ${ grow }: the page's build equals the boxes' windows; turf skirt across the sub-boxes: ` +
		`${ skirt.reduce( ( n, s ) => n + s.inner, 0 ) } inner crossings closed, ${ skirt.reduce( ( n, s ) => n + s.outer, 0 ) } outer crossings as the whole box's, ` +
		`rings within ${ Math.max( ...skirt.map( ( s ) => s.worst ) ).toExponential( 1 ) }` );
	return ctx;

}

export function build( ctx, box ) {

	const cached = ctx.cache.get( JSON.stringify( box ) );
	if ( cached ) return cached;
	const own = windowRim( ctx, box );
	return records( ownTexels( own.tile, box ), own.bushes, own.strands );

}
