// Checks the local lights' clusters on the CPU against a replica of the kernel and the lookup.
//
// It covers packages/render/lighting/LocalLightClusters.ts and the kernel and lookup in
// packages/render/lighting/LocalLights.ts: the frame's sort of the sources in view (the view widened
// by the refraction's guard band, by depth then index, repeatable), every slice's range in it, and
// a replica of the kernel's boxes and the fragments' lookup in doubles. Every fragment, on screen or
// in the guard band, must find in its cluster every source whose range holds it; a full cluster
// keeps the nearest sources and counts the rest. Run it after a change to the clusters, the kernel
// or the lookup; it is part of `npm run check`.
//
// Usage:
//   node tools/render/verify-local-lights.mjs [seed]
//
// Options:
//   seed   the seed of the random scenes the checks draw (default 1)
//
// The replica mirrors the TSL by hand: a change to the kernel or the lookup changes it too.
//
// Output: on stdout, `ok` or `FAIL` per check (a failure with its message), the fragment counts of
// the lookup check, then the count passed (with the seed) or failed.
//
// GPU lock and browser: neither.
//
// Cost: seconds, CPU only.
//
// Exit codes: 0 every check passes; 1 a check failed.
import '../kit/help.mjs';

import '../kit/qos.mjs';
import { GRID, PER_CLUSTER, GUARD, slicesFor, sliceStart, sliceAt, sortInView } from '../../packages/render/lighting/LocalLightClusters.ts';

const seed = Number( process.argv[ 2 ] ?? 1 );

// a seeded stream (mulberry32)
function stream( s ) {

	return () => {

		s = ( s + 0x6d2b79f5 ) | 0;
		let t = Math.imul( s ^ ( s >>> 15 ), 1 | s );
		t = ( t + Math.imul( t ^ ( t >>> 7 ), 61 | t ) ) ^ t;
		return ( ( t ^ ( t >>> 14 ) ) >>> 0 ) / 4294967296;

	};

}

// the main camera's projection (27 degrees, 16:9), its elements as the pass reads them; an
// off-centre one too (a sub-pixel jitter's P20, P21), which the maths must take whatever it is
function lens( dx = 0, dy = 0 ) {

	const f = 1 / Math.tan( 27 / 2 * Math.PI / 180 );
	const e = new Array( 16 ).fill( 0 );
	e[ 0 ] = f / ( 16 / 9 ); e[ 5 ] = f; e[ 8 ] = dx; e[ 9 ] = dy;
	return e;

}
const NEAR = 1;

// a view-space point through NDC ( nx, ny ) at depth d
const at = ( e, nx, ny, d ) => [ d * ( nx + e[ 8 ] ) / e[ 0 ], d * ( ny + e[ 9 ] ) / e[ 5 ], - d ];

// the kernel: cluster c's box in view space and its list (the first PER_CLUSTER sources of its
// slice's range that touch it, and the count of all that do)
function cluster( c, view, e, { order, ranges, slices } ) {

	const cx = c % GRID.x, cy = Math.floor( c / GRID.x ) % GRID.y, cz = Math.floor( c / ( GRID.x * GRID.y ) );
	const x0 = cx === 0 ? - 1 - GUARD.left : cx * 2 / GRID.x - 1;
	const x1 = cx === GRID.x - 1 ? 1 + GUARD.right : ( cx + 1 ) * 2 / GRID.x - 1;
	const y1 = cy === 0 ? 1 + GUARD.top : 1 - cy * 2 / GRID.y;
	const y0 = cy === GRID.y - 1 ? - 1 - GUARD.bottom : 1 - ( cy + 1 ) * 2 / GRID.y;
	const depth = ( s ) => slices[ 0 ] * Math.exp( ( s - 1 ) / slices[ 2 ] );
	const near = cz === 0 ? 0 : depth( cz ), far = depth( cz + 1 );
	const ax0 = ( x0 + e[ 8 ] ) / e[ 0 ], ax1 = ( x1 + e[ 8 ] ) / e[ 0 ];
	const ay0 = ( y0 + e[ 9 ] ) / e[ 5 ], ay1 = ( y1 + e[ 9 ] ) / e[ 5 ];
	const lo = [ Math.min( ax0 * near, ax0 * far ), Math.min( ay0 * near, ay0 * far ), - far ];
	const hi = [ Math.max( ax1 * near, ax1 * far ), Math.max( ay1 * near, ay1 * far ), - near ];
	const list = [];
	let n = 0;
	for ( let k = ranges[ 2 * cz ]; k < ranges[ 2 * cz + 1 ]; k ++ ) {

		const i = order[ k ];
		let d2 = 0;
		for ( let a = 0; a < 3; a ++ ) {

			const p = view[ i * 4 + a ];
			d2 += ( p - Math.min( Math.max( p, lo[ a ] ), hi[ a ] ) ) ** 2;

		}
		if ( d2 <= view[ i * 4 + 3 ] ** 2 ) {

			if ( n < PER_CLUSTER ) list.push( i );
			n ++;

		}

	}
	return { list, n };

}

// the fragment's lookup: its cluster, or -1 past the last slice
function lookup( p, e, slices ) {

	const depth = - p[ 2 ];
	if ( depth >= slices[ 1 ] ) return - 1;
	const d = Math.max( depth, 1e-6 );
	const nx = p[ 0 ] * e[ 0 ] / d - e[ 8 ], ny = p[ 1 ] * e[ 5 ] / d - e[ 9 ];
	const tx = Math.min( Math.max( Math.floor( ( nx * 0.5 + 0.5 ) * GRID.x ), 0 ), GRID.x - 1 );
	const ty = Math.min( Math.max( Math.floor( ( ny * - 0.5 + 0.5 ) * GRID.y ), 0 ), GRID.y - 1 );
	return tx + ty * GRID.x + sliceAt( depth, slices ) * GRID.x * GRID.y;

}

// n sources scattered through the widened view out to `deep` m, a few behind the camera or off to the
// side, ranges as the yunpeng's or larger
function scatter( random, e, n, deep ) {

	const view = new Float64Array( n * 4 );
	for ( let i = 0; i < n; i ++ ) {

		const d = - 3 + ( deep + 3 ) * random() ** 2;
		const p = at( e, ( random() * 2 - 1 ) * 1.6, ( random() * 2 - 1 ) * 1.9 - 0.3, d );
		view.set( [ ...p, 2 + 10 * random() ], i * 4 );

	}
	return view;

}

const checks = [];
const check = ( name, run ) => checks.push( [ name, run ] );
const assert = ( ok, message ) => {

	if ( ! ok ) throw new Error( message );

};

check( 'slices: contiguous, exponential, the first FIRST_SLICE m', () => {

	for ( const reach of [ 0, 7, 60, 400, 5000 ] ) {

		const s = slicesFor( reach );
		assert( sliceStart( 0, s ) === 0 && Math.abs( sliceStart( 1, s ) - s[ 0 ] ) < 1e-9, `reach ${ reach }: first slice` );
		assert( Math.abs( sliceStart( GRID.z, s ) - s[ 1 ] ) < 1e-6 * s[ 1 ], `reach ${ reach }: the last ends at ${ sliceStart( GRID.z, s ) }, not ${ s[ 1 ] }` );
		assert( s[ 1 ] >= reach, `reach ${ reach }: the slices end short of it` );
		for ( let z = 1; z < GRID.z; z ++ ) {

			const a = sliceStart( z, s ), b = sliceStart( z + 1, s );
			assert( sliceAt( ( a + b ) / 2, s ) === z, `reach ${ reach }: depth ${ ( a + b ) / 2 } not in slice ${ z }` );

		}

	}

} );

check( 'sort: depth, then index, repeatable', () => {

	const random = stream( seed );
	const e = lens();
	const view = scatter( random, e, 300, 120 );
	// ties: every fifth source at the depth of the one before
	for ( let i = 5; i < 300; i += 5 ) view[ i * 4 + 2 ] = view[ ( i - 1 ) * 4 + 2 ];
	const a = sortInView( view, 300, e, NEAR ), b = sortInView( view, 300, e, NEAR );
	assert( a.order.join() === b.order.join() && a.ranges.join() === b.ranges.join(), 'two sorts differ' );
	for ( let q = 1; q < a.order.length; q ++ ) {

		const i = a.order[ q - 1 ], j = a.order[ q ];
		const di = - view[ i * 4 + 2 ], dj = - view[ j * 4 + 2 ];
		assert( di < dj || ( di === dj && i < j ), `order ${ q }: ${ i } at ${ di } before ${ j } at ${ dj }` );

	}

} );

check( 'cull: the spheres that meet the widened view, past the near plane', () => {

	const random = stream( seed + 1 );
	for ( const e of [ lens(), lens( 0.003, - 0.002 ) ] ) {

		const view = scatter( random, e, 2000, 200 );
		const { order } = sortInView( view, 2000, e, NEAR );
		const kept = new Set( order );
		for ( let i = 0; i < 2000; i ++ ) {

			// sample the sphere: a point of it inside the widened view past near keeps it; a kept one
			// with no such point is only a sphere that grazes a plane's outside near an edge (allowed)
			const r = view[ i * 4 + 3 ];
			let inside = false;
			for ( let t = 0; t < 400 && ! inside; t ++ ) {

				const u = random() * 2 - 1, phi = random() * 2 * Math.PI, rr = r * Math.cbrt( random() );
				const s = Math.sqrt( 1 - u * u );
				const p = [ view[ i * 4 ] + rr * s * Math.cos( phi ), view[ i * 4 + 1 ] + rr * s * Math.sin( phi ), view[ i * 4 + 2 ] + rr * u ];
				const d = - p[ 2 ];
				if ( d < NEAR ) continue;
				const nx = p[ 0 ] * e[ 0 ] / d - e[ 8 ], ny = p[ 1 ] * e[ 5 ] / d - e[ 9 ];
				inside = nx >= - 1 - GUARD.left && nx <= 1 + GUARD.right && ny >= - 1 - GUARD.bottom && ny <= 1 + GUARD.top;

			}
			assert( ! inside || kept.has( i ), `source ${ i } reaches into the view but was culled` );

		}
		// one well behind the camera and one far to the side go
		const out = new Float64Array( [ 0, 0, 20, 5, 1000, 0, - 50, 5 ] );
		assert( sortInView( out, 2, e, NEAR ).order.length === 0, 'a source behind or beside the view was kept' );

	}

} );

check( 'ranges: every slice\'s range holds every source that reaches into it', () => {

	const random = stream( seed + 2 );
	const e = lens();
	const view = scatter( random, e, 500, 150 );
	const { order, ranges, slices } = sortInView( view, 500, e, NEAR );
	for ( let s = 0; s < GRID.z; s ++ ) {

		const z0 = sliceStart( s, slices ), z1 = s === GRID.z - 1 ? Infinity : sliceStart( s + 1, slices );
		order.forEach( ( i, q ) => {

			const d = - view[ i * 4 + 2 ], r = view[ i * 4 + 3 ];
			if ( d + r >= z0 && d - r <= z1 ) assert( q >= ranges[ 2 * s ] && q < ranges[ 2 * s + 1 ], `slice ${ s }: source ${ i } outside its range` );

		} );
		assert( ranges[ 2 * s ] <= ranges[ 2 * s + 1 ] && ranges[ 2 * s + 1 ] <= order.length, `slice ${ s }: range out of order` );

	}

} );

check( 'lookup: a fragment finds every source whose range holds it, on screen and in the guard band', () => {

	const random = stream( seed + 3 );
	for ( const e of [ lens(), lens( - 0.004, 0.003 ) ] ) {

		const n = 150;
		const view = scatter( random, e, n, 150 );
		const inView = sortInView( view, n, e, NEAR );
		const lists = new Map();
		let fragments = 0, lit = 0, excused = 0;
		for ( let t = 0; t < 40000; t ++ ) {

			// a fragment near a random source (most fragments far from any are lit by none)
			const j = Math.floor( random() * n );
			const p = [ 0, 1, 2 ].map( ( a ) => view[ j * 4 + a ] + ( random() * 2 - 1 ) * view[ j * 4 + 3 ] );
			const d = - p[ 2 ];
			if ( d < NEAR ) continue;
			const nx = p[ 0 ] * e[ 0 ] / d - e[ 8 ], ny = p[ 1 ] * e[ 5 ] / d - e[ 9 ];
			if ( nx < - 1 - GUARD.left || nx > 1 + GUARD.right || ny < - 1 - GUARD.bottom || ny > 1 + GUARD.top ) continue;
			fragments ++;
			const c = lookup( p, e, inView.slices );
			const own = c < 0 ? { list: [], n: 0 } : lists.get( c ) ?? cluster( c, view, e, inView );
			if ( c >= 0 ) lists.set( c, own );
			const listed = new Set( own.list );
			for ( let i = 0; i < n; i ++ ) {

				// strictly within the range (the window is 0 at its edge); a full cluster is checked below
				const r = view[ i * 4 + 3 ];
				const d2 = ( p[ 0 ] - view[ i * 4 ] ) ** 2 + ( p[ 1 ] - view[ i * 4 + 1 ] ) ** 2 + ( p[ 2 ] - view[ i * 4 + 2 ] ) ** 2;
				if ( d2 >= ( r * 0.999 ) ** 2 ) continue;
				lit ++;
				assert( c >= 0, `fragment at depth ${ d } past the last slice ${ inView.slices[ 1 ] } is lit by ${ i }` );
				assert( listed.has( i ) || own.n > PER_CLUSTER, `fragment in cluster ${ c } misses source ${ i }` );
				if ( ! listed.has( i ) ) excused ++;

			}

		}
		assert( fragments > 10000 && excused < lit / 4, `too few fragments tested, or too many in full clusters (${ fragments }, ${ lit } lit, ${ excused } in full clusters)` );
		console.log( `      ${ fragments } fragments, ${ lit } lit by a source, ${ excused } of those dropped by a full cluster` );

	}

} );

check( 'overflow: a full cluster keeps the nearest, in order, and counts all', () => {

	const e = lens();
	// 40 sources stacked along the axis at 20-23.9 m, all reaching the centre's clusters there
	const n = 40;
	const view = new Float64Array( n * 4 );
	for ( let i = 0; i < n; i ++ ) view.set( [ 0, 0, - ( 20 + ( ( i * 7 ) % n ) * 0.1 ), 6 ], i * 4 );
	const inView = sortInView( view, n, e, NEAR );
	const c = lookup( [ 0, 0, - 22 ], e, inView.slices );
	const { list, n: touching } = cluster( c, view, e, inView );
	assert( touching === n, `counted ${ touching }, not ${ n }` );
	assert( list.length === PER_CLUSTER, `listed ${ list.length }` );
	assert( list.join() === inView.order.slice( 0, PER_CLUSTER ).join(), 'the list is not the nearest in order' );

} );

let failed = 0;
for ( const [ name, run ] of checks ) {

	try {

		run();
		console.log( `ok    ${ name }` );

	} catch ( error ) {

		failed ++;
		console.log( `FAIL  ${ name }\n      ${ error.message }` );

	}

}
console.log( failed ? `${ failed } of ${ checks.length } failed` : `${ checks.length } passed (seed ${ seed })` );
process.exit( failed ? 1 : 0 );
