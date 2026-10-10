// Locality of the sea cliff (src/world/Cliff.ts), a case of tools/verify-world-local.mjs.
//
// The wall at a point must depend only on the coast within 25 m of it: a wall built for a box with
// `area` = the box grown by 25 m must equal, bit for bit, one built over the whole land. Over a few
// 16 m boxes on the coast the case samples a world lattice (0.25 m, columns within 5 m of the coast)
// and makes, per point:
//   solid    `CliffWall.solid()`: the whole box from a wall over the land grown by 60 m, each
//            sub-box from a wall over itself grown by 25 m, so the runner's comparison checks the
//            25 m area against a much larger one;
//   sdf      the island SDF (`makeIslandSDF( fp, area )`), every box over itself grown by 25 m: the
//            sub-box case proper;
//   detail   its per-vertex cliff detail (which scar's face the point lies on, how fresh, the bed,
//            the depth below the column's top), so a scar must also keep its identity.
// Setup also checks the scars' clamped reach on the land's wall, each on the surface it was placed
// on: the rock any scar cuts lies within its reach of its anchor (4.5 m for the joint faces and
// gullies, 3 m for the smaller generations), so the clamp of its box in `bounds()` trims nothing;
// and where a scar broke off along the octagon inside that reach, the rock its own planes would
// have cut beyond it above y -1 stays thin (TRIM_ABOVE). It reports the largest reach per kind and
// the deepest trims. A failure prints FAIL and sets the exit code.
import { growLand } from '../../src/world/IslandGrowth.ts';
import { buildFootprint, makeIslandSDF, coastWobble, islandSurfaceHeight, ISLAND_BOTTOM, ISLAND_TOP } from '../../src/world/WorldShapes.ts';
import { CliffWall } from '../../src/world/Cliff.ts';

export const name = 'cliff';

const CHUNK = 16, STEP = 0.25, PAD = 25;
const grow = ( b, m ) => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );
const REACH = ( s ) => s.level === 0 || s.kind === 'gully' ? 4.5 : 3.0;

export function setup( { seed, grow: steps } ) {

	const { land } = growLand( seed, steps );
	const fp = buildFootprint( land );
	const dist = ( x, z ) => fp.dist( x, z );
	const wide = new CliffWall( dist, coastWobble, islandSurfaceHeight, grow( fp.bounds, 60 ) );

	// 16 m boxes on the world's chunk grid that the coast crosses: the first, middle and last
	const coastal = [];
	const b = fp.bounds;
	for ( let cj = Math.floor( b.z0 / CHUNK ); cj <= Math.floor( b.z1 / CHUNK ); cj ++ ) for ( let ci = Math.floor( b.x0 / CHUNK ); ci <= Math.floor( b.x1 / CHUNK ); ci ++ ) {

		let inside = false, outside = false;
		for ( let z = 0.5; z < CHUNK; z ++ ) for ( let x = 0.5; x < CHUNK; x ++ ) {

			if ( fp.dist( ci * CHUNK + x, cj * CHUNK + z ) < 0 ) inside = true; else outside = true;

		}
		if ( inside && outside ) coastal.push( { x0: ci * CHUNK, z0: cj * CHUNK, x1: ( ci + 1 ) * CHUNK, z1: ( cj + 1 ) * CHUNK } );

	}
	const boxes = [ ...new Set( [ 0, coastal.length >> 1, coastal.length - 1 ] ) ].map( ( i ) => coastal[ i ] );

	checkReach( wide, dist, `${ name } seed ${ seed } grow ${ steps }` );
	return { fp, dist, wide, boxes };

}

export function build( ctx, box ) {

	const { fp, dist, wide } = ctx;
	const area = grow( box, PAD );
	// the whole box (the runner passes the very object from `boxes`) reads the land's wall
	const wall = ctx.boxes.includes( box ) ? wide : new CliffWall( dist, coastWobble, islandSurfaceHeight, area );
	const sdf = makeIslandSDF( fp, area );
	const pos = [], solid = [], value = [], detail = [], out = new Float64Array( 4 );
	const ny = Math.floor( ( ISLAND_TOP + 0.6 - ( ISLAND_BOTTOM + 0.1 ) ) / STEP );
	for ( let j = Math.ceil( box.z0 / STEP - 0.5 ); ( j + 0.5 ) * STEP < box.z1; j ++ ) for ( let i = Math.ceil( box.x0 / STEP - 0.5 ); ( i + 0.5 ) * STEP < box.x1; i ++ ) {

		const x = ( i + 0.5 ) * STEP, z = ( j + 0.5 ) * STEP;
		if ( Math.abs( fp.dist( x, z ) ) > 5 ) continue;
		for ( let k = 0; k <= ny; k ++ ) {

			const y = ISLAND_BOTTOM + 0.1 + k * STEP;
			pos.push( x, y, z );
			solid.push( wall.solid( x, y, z ) );
			value.push( sdf( x, y, z ) );
			sdf.detail( x, y, z, out, 0 );
			detail.push( ...out );

		}

	}
	return {
		pos: { records: new Float64Array( pos ), stride: 3 },
		solid: new Float64Array( solid ),
		sdf: new Float64Array( value ),
		detail: { records: new Float64Array( detail ), stride: 4 },
	};

}

// ------------------------------------------------------------------ the clamped reach

// The scar's polytope's box: its vertices, the triple plane intersections inside every plane.
function polytopeBox( p, n ) {

	let x0 = Infinity, x1 = - Infinity, z0 = Infinity, z1 = - Infinity;
	for ( let a = 0; a < n; a ++ ) for ( let b = a + 1; b < n; b ++ ) for ( let c = b + 1; c < n; c ++ ) {

		const [ ax, ay, az, ac ] = p.subarray( a * 4, a * 4 + 4 ), [ bx, by, bz, bc ] = p.subarray( b * 4, b * 4 + 4 ), [ cx, cy, cz, cc ] = p.subarray( c * 4, c * 4 + 4 );
		const det = ax * ( by * cz - bz * cy ) - ay * ( bx * cz - bz * cx ) + az * ( bx * cy - by * cx );
		if ( Math.abs( det ) < 1e-6 ) continue;
		const x = ( ac * ( by * cz - bz * cy ) - ay * ( bc * cz - bz * cc ) + az * ( bc * cy - by * cc ) ) / det;
		const y = ( ax * ( bc * cz - bz * cc ) - ac * ( bx * cz - bz * cx ) + az * ( bx * cc - bc * cx ) ) / det;
		const z = ( ax * ( by * cc - bc * cy ) - ay * ( bx * cc - bc * cx ) + ac * ( bx * cy - by * cx ) ) / det;
		let inside = true;
		for ( let k = 0; k < n && inside; k ++ ) if ( p[ k * 4 ] * x + p[ k * 4 + 1 ] * y + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ] > 1e-6 ) inside = false;
		if ( ! inside ) continue;
		x0 = Math.min( x0, x ); x1 = Math.max( x1, x ); z0 = Math.min( z0, z ); z1 = Math.max( z1, z );

	}
	return { x0, x1, z0, z1 };

}

// How many of the scar's planes are its own: bounds() appends the vertical end planes of the
// octagon round the anchor last, each at the octagon's apothem from it.
function ownPlanes( s ) {

	const apothem = ( REACH( s ) - 0.15 ) * Math.cos( Math.PI / 8 ), p = s.planes;
	let n = s.n;
	while ( n > 0 && p[ n * 4 - 3 ] === 0 && Math.abs( p[ n * 4 - 1 ] - p[ n * 4 - 4 ] * s.cx - p[ n * 4 - 2 ] * s.cz - apothem ) < 1e-9 ) n --;
	return n;

}

// The column ( x, z )'s span inside the first n planes grown by e, below the meadow's top.
function span( p, n, e, x, z ) {

	let lo = ISLAND_BOTTOM, hi = islandSurfaceHeight( x, z ) + 0.6;
	for ( let k = 0; k < n && lo <= hi; k ++ ) {

		const ny = p[ k * 4 + 1 ], rest = p[ k * 4 + 3 ] + e - p[ k * 4 ] * x - p[ k * 4 + 2 ] * z;
		if ( Math.abs( ny ) < 1e-9 ) { if ( rest < 0 ) hi = - Infinity; } else if ( ny > 0 ) hi = Math.min( hi, rest / ny ); else lo = Math.max( lo, rest / ny );

	}
	return [ lo, hi ];

}

// The deepest rock the octagon may keep above y -1 (m): a scar that would cut further keeps a
// step this thick at most where it breaks off. Over seeds 1 - 5 up to step 36 the deepest are
// 0.3 - 0.45 m; two checked in captures (one a joint face broken off up to the lip) read as a
// cross joint.
const TRIM_ABOVE = 0.6;

// Measures each scar on the surface it was placed on: tier A (level 0 and gullies) on the plain
// face, tier B on the face with tier A cut out.
//   reach  how far from its anchor (in x or z) the block as cut, end planes and all, takes rock: the
//          reach clamp of the scar's box must leave it whole (it is this far at most by construction,
//          the octagon's corners lying 0.15 m inside the reach: this guards that construction);
//   trim   where the octagon broke a scar off, how thick the rock is that its own planes would have
//          cut beyond the octagon (the least of its depth inside the rock and inside the block), the
//          deepest above y -1 held to TRIM_ABOVE: what the reach costs in the image.
function checkReach( wall, dist, label ) {

	const far = { x0: 1e5, z0: 1e5, x1: 1e5 + 1, z1: 1e5 + 1 }; // no coast: no scars
	const plain = new CliffWall( dist, coastWobble, islandSurfaceHeight, far );
	const tierA = new CliffWall( dist, coastWobble, islandSurfaceHeight, far );
	for ( const s of wall.scars ) if ( REACH( s ) === 4.5 ) tierA.add( s );
	const largest = {}, trims = [];
	let failed = 0, trimmed = 0;
	const fail = ( message ) => {

		if ( ++ failed <= 5 ) console.log( `FAIL ${ label }: ${ message }` );

	};
	for ( const s of wall.scars ) {

		const base = REACH( s ) === 4.5 ? plain : tierA, p = s.planes, h = 0.1;
		const where = `a ${ s.kind } (level ${ s.level }) at ( ${ s.cx.toFixed( 2 ) }, ${ s.cz.toFixed( 2 ) } )`;
		let box = polytopeBox( p, s.n ), reach = 0;
		for ( let z = Math.floor( box.z0 / h ) * h; z <= box.z1; z += h ) for ( let x = Math.floor( box.x0 / h ) * h; x <= box.x1; x += h ) {

			const r = Math.max( Math.abs( x - s.cx ), Math.abs( z - s.cz ) );
			if ( r <= reach ) continue;
			const [ lo, hi ] = span( p, s.n, 0.05, x, z );
			for ( let y = lo; y <= hi; y += 0.05 ) if ( base.solid( x, y, z ) < 0 ) { reach = r; break; }

		}
		const kind = `${ s.kind }${ s.level }`;
		largest[ kind ] = Math.max( largest[ kind ] ?? 0, reach );
		if ( reach > REACH( s ) ) fail( `${ where } cuts rock ${ reach.toFixed( 2 ) } m from its anchor, beyond its ${ REACH( s ) } m reach` );

		const own = ownPlanes( s );
		if ( own === s.n ) continue;
		box = polytopeBox( p, own );
		let deep = 0, top = - Infinity;
		for ( let z = Math.floor( box.z0 / h ) * h; z <= box.z1; z += h ) for ( let x = Math.floor( box.x0 / h ) * h; x <= box.x1; x += h ) {

			let beyond = false;
			for ( let k = own; k < s.n && ! beyond; k ++ ) beyond = p[ k * 4 ] * x + p[ k * 4 + 2 ] * z > p[ k * 4 + 3 ];
			if ( ! beyond ) continue;
			const [ lo, hi ] = span( p, own, 0, x, z );
			for ( let y = Math.max( lo, - 1 ); y <= hi; y += 0.02 ) {

				let block = - Infinity;
				for ( let k = 0; k < own; k ++ ) block = Math.max( block, p[ k * 4 ] * x + p[ k * 4 + 1 ] * y + p[ k * 4 + 2 ] * z - p[ k * 4 + 3 ] );
				const d = Math.min( - base.solid( x, y, z ), - block );
				if ( d > deep ) { deep = d; top = y; }

			}

		}
		trimmed ++;
		if ( deep > 0.01 ) trims.push( { kind, deep } );
		if ( deep > TRIM_ABOVE ) fail( `${ where } breaks off ${ deep.toFixed( 2 ) } m of rock above y -1 at its octagon (at y ${ top.toFixed( 2 ) }), more than ${ TRIM_ABOVE } m` );

	}
	const summary = Object.entries( largest ).sort().map( ( [ k, v ] ) => `${ k } ${ v.toFixed( 2 ) }` ).join( ', ' );
	console.log( `${ failed ? 'FAIL' : 'ok  ' } ${ label }: reach of the rock each scar cuts, largest per kind (m): ${ summary }` );
	const deepest = trims.sort( ( a, b ) => b.deep - a.deep ).slice( 0, 3 ).map( ( t ) => `${ t.kind } ${ t.deep.toFixed( 2 ) }` ).join( ', ' ) || 'none';
	console.log( `     ${ label }: ${ trimmed } of ${ wall.scars.length } scars meet their octagon, ${ trims.length } of them cut off rock above y -1, deepest (m): ${ deepest }` );
	if ( failed ) process.exitCode = 1;

}
