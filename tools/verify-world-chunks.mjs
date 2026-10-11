// Chunk checks for the world generator (plain node, CPU only):
//   node tools/verify-world-chunks.mjs [--seeds 1,2] [--steps 0,12]
//
// The island is generated per chunk: S = 16 m squares on the world grid, each from its window (the
// chunk grown by R = 32 m) alone. Neighbouring chunks must meet as if the island had been made in
// one piece. For every seed and growth step the runner builds a case once (the land, its footprint,
// the chunks that meet the land and their meshes), then runs every check in CHECKS on it. A check
// prints `ok` / `FAIL` lines and returns whether it passed; any failure sets the exit code. Further
// checks (generation order, the dirty set, the other kinds of content) add entries to CHECKS and
// what they need to `buildCase`. So far a chunk is its island mesh alone, from the island SDF over
// its window and the footprint of the whole land, without the stones' contact AO.
//
//   columns  every chunk meshed with the inland column range (WorldShapes.islandColumnRange) is
//            byte-identical to the chunk meshed with whole columns and to a second call; prints the
//            time per chunk and what the range saves (both timed warm, back to back).
//   S1       the welded union of the chunks' island meshes is closed: no boundary edge, and at most
//            1.3 non-manifold edges per 1000 triangles (the ambiguous cells of surface nets). The
//            page's single island mesh has 0.65 - 0.88 per 1000 on seeds 1 - 2 at steps 0 and 12
//            once its bottom face is left out (0.46 - 0.69 with it): x 1.5. The chunks leave the
//            bottom face out by design (SurfaceNets.ts: never seen below the sea floor), so the
//            walls end open at the lattice's bottom row: a boundary edge with both ends in that row
//            (y < -5.1 + one voxel) is counted as the open foot instead.
//   S2       seams: every vertex that two chunks share (the same position bits) carries the same
//            bits in every attribute in both; and a 2 x 2 block meshed in one call on the same
//            lattice has exactly the vertices (all attributes) and triangles of its four chunks.
import { performance } from 'node:perf_hooks';
import { growLand } from '../src/world/IslandGrowth.ts';
import {
	buildFootprint, makeIslandSDF, cliffSharpCells, islandColumnRange, ISLAND_BOTTOM, ISLAND_TOP,
} from '../src/world/WorldShapes.ts';
import { surfaceNets } from '../src/world/SurfaceNets.ts';
import { hashBuffers, meshClosure, positionKey } from './world-node.mjs';

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return ( i < 0 ? fallback : process.argv[ i + 1 ] ).split( ',' ).map( Number );

};
const seeds = argument( '--seeds', '1,2' ), steps = argument( '--steps', '0,12' );

// the chunk grid and the island mesh's lattice (chunk design, sections 3.1 and 5.3)
const S = 16, R = 32, VOXEL = 0.125, CELLS = S / VOXEL, APRON = 3;
const Y0 = ISLAND_BOTTOM + 0.5, Y1 = ISLAND_TOP + 0.6;
// A chunk meets the land when land lies within this of it (m): the wall's wobble and fallen rock
// reach well under it, and a chunk left out next to a meshed one would show as boundary edges.
const MEETS = 4;
const NON_MANIFOLD_PER_1000 = 1.3;

const grow = ( b, m ) => ( { x0: b.x0 - m, z0: b.z0 - m, x1: b.x1 + m, z1: b.z1 + m } );
const ms = ( t ) => `${ t.toFixed( 0 ) } ms`;

// The island mesh owning the lattice columns `own`, from the island SDF over its window.
function islandMesh( fp, own, columns = true ) {

	const box = { x0: own[ 0 ] * VOXEL, z0: own[ 1 ] * VOXEL, x1: own[ 2 ] * VOXEL, z1: own[ 3 ] * VOXEL };
	let t = performance.now();
	const sdf = makeIslandSDF( fp, grow( box, R ), { local: true } );
	const sdfMs = performance.now() - t;
	t = performance.now();
	const mesh = surfaceNets( sdf, {
		min: [ 0, Y0, 0 ], max: [ 0, Y1, 0 ], voxel: VOXEL, own, apron: APRON,
		// as the page's island mesh (worldWorker.ts buildIsland), without the stones' contact AO
		normalStep: VOXEL * 0.15, sharpen: cliffSharpCells( fp ),
		columnRange: columns ? islandColumnRange( fp ) : undefined,
	} );
	return { mesh, sdfMs, netsMs: performance.now() - t };

}

const ownOf = ( ci, cj, n = 1 ) => [ ci * CELLS, cj * CELLS, ( ci + n ) * CELLS, ( cj + n ) * CELLS ];

function buildCase( seed, step ) {

	const { land } = growLand( seed, step );
	const fp = buildFootprint( land );
	const b = grow( fp.bounds, MEETS );
	const chunks = [];
	for ( let cj = Math.floor( b.z0 / S ); cj <= Math.floor( b.z1 / S ); cj ++ ) for ( let ci = Math.floor( b.x0 / S ); ci <= Math.floor( b.x1 / S ); ci ++ ) {

		let near = Infinity;
		for ( let z = - MEETS; z <= S + MEETS; z += 0.5 ) for ( let x = - MEETS; x <= S + MEETS; x += 0.5 ) {

			near = Math.min( near, fp.dist( ci * S + x, cj * S + z ) );

		}
		if ( near >= 0 ) continue;
		const { mesh, sdfMs, netsMs } = islandMesh( fp, ownOf( ci, cj ) );
		chunks.push( { ci, cj, mesh, sdfMs, netsMs } );

	}
	return { seed, step, label: `seed ${ seed } step ${ step }`, fp, chunks };

}

// ------------------------------------------------------------------ the checks

// Inland columns: the range must not change a bit, and should save most of an inland chunk's time.
function columns( ctx ) {

	const range = islandColumnRange( ctx.fp );
	let ok = true, sumWith = 0, sumWithout = 0, inlandWith = 0, inlandWithout = 0, inlandChunks = 0;
	for ( const c of ctx.chunks ) {

		// the share of the chunk's sampled columns that take the range
		let inland = 0, all = 0;
		for ( let k = c.cj * CELLS - APRON; k <= ( c.cj + 1 ) * CELLS + APRON; k ++ ) for ( let i = c.ci * CELLS - APRON; i <= ( c.ci + 1 ) * CELLS + APRON; i ++ ) {

			all ++;
			if ( range( i * VOXEL, k * VOXEL ) ) inland ++;

		}
		const tris = c.mesh.indices.length / 3;
		let line = `     chunk ( ${ c.ci }, ${ c.cj } ): ${ c.mesh.positions.length / 3 } vertices, ${ tris } triangles; scars ${ ms( c.sdfMs ) }, nets ${ ms( c.netsMs ) }`;
		if ( inland > 0 ) {

			// Timed again back to back, warm: the case's first meshes also pay for the JIT. The
			// second ranged mesh must repeat the first as well.
			const whole = islandMesh( ctx.fp, ownOf( c.ci, c.cj ), false );
			const again = islandMesh( ctx.fp, ownOf( c.ci, c.cj ) );
			const hash = hashBuffers( c.mesh );
			if ( hashBuffers( whole.mesh ) !== hash || hashBuffers( again.mesh ) !== hash ) {

				ok = false;
				console.log( `FAIL ${ ctx.label } chunk ( ${ c.ci }, ${ c.cj } ): the column range changes the mesh, or a second call does` );

			}
			line += `; again ${ ms( again.netsMs ) } against whole columns ${ ms( whole.netsMs ) } (${ ( 100 * inland / all ).toFixed( 0 ) } % of its columns inland)`;
			sumWith += again.netsMs; sumWithout += whole.netsMs;
			if ( inland === all ) { inlandChunks ++; inlandWith += again.netsMs; inlandWithout += whole.netsMs; }

		}
		console.log( line );

	}
	const saved = sumWithout ? `${ ( 100 * ( 1 - sumWith / sumWithout ) ).toFixed( 0 ) } % of the nets time on chunks with inland columns (${ ms( sumWithout ) } -> ${ ms( sumWith ) })` : 'no inland columns';
	const wholly = inlandChunks ? `; wholly inland chunks ${ ms( inlandWithout / inlandChunks ) } -> ${ ms( inlandWith / inlandChunks ) } each` : '';
	console.log( `${ ok ? 'ok  ' : 'FAIL' } columns ${ ctx.label }: identical with the range; it saves ${ saved }${ wholly }` );
	return ok;

}

// S1: the welded chunks close up.
function closed( ctx ) {

	const foot = Y0 + VOXEL;
	const c = meshClosure( ctx.chunks.map( ( k ) => k.mesh ), { open: ( p, q ) => p[ 1 ] < foot && q[ 1 ] < foot } );
	const rate = 1000 * c.nonManifold / c.triangles;
	const ok = c.boundary === 0 && rate <= NON_MANIFOLD_PER_1000;
	console.log( `${ ok ? 'ok  ' : 'FAIL' } S1 ${ ctx.label }: ${ ctx.chunks.length } chunks, ${ c.triangles } triangles, ${ c.welded } welded vertices: ` +
		`${ c.boundary } boundary edges (+ ${ c.open } along the open foot), ${ c.nonManifold } non-manifold (${ rate.toFixed( 2 ) } per 1000 triangles, at most ${ NON_MANIFOLD_PER_1000 }), ` +
		`${ c.flipped } flipped, ${ c.degenerate } degenerate` );
	return ok;

}

// Every attribute of vertex v as one key per attribute, by its float bits.
const ATTRIBUTES = [ [ 'normals', 3 ], [ 'ao', 1 ], [ 'tint', 1 ], [ 'curv', 1 ], [ 'detail', 4 ], [ 'detail2', 3 ] ];
function attributes( mesh, v ) {

	return ATTRIBUTES.map( ( [ name, n ] ) => {

		const a = mesh[ name ], bits = new Uint32Array( a.buffer, a.byteOffset, a.length );
		return Array.from( bits.subarray( v * n, v * n + n ) ).join( ',' );

	} );

}

// The vertices of a mesh by position key (a position twice in one mesh keeps every copy).
function byPosition( mesh ) {

	const map = new Map();
	for ( let v = 0; v < mesh.positions.length / 3; v ++ ) {

		const key = positionKey( mesh.positions, v );
		const list = map.get( key );
		if ( list ) list.push( v ); else map.set( key, [ v ] );

	}
	return map;

}

// Whether the copies of one position in two meshes agree: every copy on the side with fewer
// copies must equal one on the other side (a position duplicated in one chunk may be used by
// only one of the chunks across the border). Returns the first differing attribute's name or null.
function sameVertex( ma, va, mb, vb ) {

	const [ small, sv, large, lv ] = va.length <= vb.length ? [ ma, va, mb, vb ] : [ mb, vb, ma, va ];
	const others = lv.map( ( v ) => attributes( large, v ) );
	for ( const v of sv ) {

		const mine = attributes( small, v );
		if ( others.some( ( o ) => o.every( ( a, i ) => a === mine[ i ] ) ) ) continue;
		const nearest = others[ 0 ];
		return ATTRIBUTES[ mine.findIndex( ( a, i ) => a !== nearest[ i ] ) ][ 0 ];

	}
	return null;

}

// S2: chunks agree on their shared vertices, and a 2 x 2 block meshed whole equals its chunks.
function seams( ctx ) {

	let ok = true;
	const maps = ctx.chunks.map( ( c ) => byPosition( c.mesh ) );
	const index = new Map( ctx.chunks.map( ( c, n ) => [ `${ c.ci },${ c.cj }`, n ] ) );

	// shared vertices between every pair of neighbouring chunks (8-neighbourhood)
	let shared = 0, duplicated = 0, failures = 0;
	const differs = {};
	for ( let n = 0; n < ctx.chunks.length; n ++ ) {

		const a = ctx.chunks[ n ];
		for ( const [ di, dj ] of [ [ 1, 0 ], [ 0, 1 ], [ 1, 1 ], [ 1, - 1 ] ] ) {

			const m = index.get( `${ a.ci + di },${ a.cj + dj }` );
			if ( m === undefined ) continue;
			const mapB = maps[ m ];
			for ( const [ key, va ] of maps[ n ] ) {

				const vb = mapB.get( key );
				if ( ! vb ) continue;
				shared ++;
				if ( va.length > 1 || vb.length > 1 ) duplicated ++;
				const bad = sameVertex( a.mesh, va, ctx.chunks[ m ].mesh, vb );
				if ( bad ) {

					differs[ bad ] = ( differs[ bad ] ?? 0 ) + 1;
					if ( ++ failures <= 3 ) console.log( `FAIL S2 ${ ctx.label }: chunks ( ${ a.ci }, ${ a.cj } ) and ( ${ ctx.chunks[ m ].ci }, ${ ctx.chunks[ m ].cj } ) differ in ${ bad } at a shared vertex` );

				}

			}

		}

	}
	if ( failures ) ok = false;
	console.log( `${ failures ? 'FAIL' : 'ok  ' } S2 ${ ctx.label }: ${ shared } vertices shared by neighbouring chunks compared in position and ${ ATTRIBUTES.length } attributes, ` +
		`${ failures } differ${ failures ? ` (${ JSON.stringify( differs ) })` : '' }; ${ duplicated } of them sit twice at one position in a chunk` );

	// the 2 x 2 block whose chunks hold the most triangles, meshed in one call
	let best = null, most = - 1;
	for ( const c of ctx.chunks ) {

		const quad = [ [ 0, 0 ], [ 1, 0 ], [ 0, 1 ], [ 1, 1 ] ].map( ( [ di, dj ] ) => index.get( `${ c.ci + di },${ c.cj + dj }` ) );
		const tris = quad.reduce( ( sum, m ) => sum + ( m === undefined ? 0 : ctx.chunks[ m ].mesh.indices.length / 3 ), 0 );
		if ( tris > most ) { most = tris; best = { ci: c.ci, cj: c.cj, members: quad.filter( ( m ) => m !== undefined ) }; }

	}
	const block = islandMesh( ctx.fp, ownOf( best.ci, best.cj, 2 ) );
	const blockMap = byPosition( block.mesh );
	let compared = 0, missing = 0, wrong = 0;
	const wrongBy = {};
	const triangles = new Map();
	const triangleKeys = ( mesh, sign ) => {

		for ( let t = 0; t < mesh.indices.length; t += 3 ) {

			const key = [ 0, 1, 2 ].map( ( o ) => positionKey( mesh.positions, mesh.indices[ t + o ] ) ).join( '|' );
			triangles.set( key, ( triangles.get( key ) ?? 0 ) + sign );

		}

	};
	triangleKeys( block.mesh, 1 );
	const chunkKeys = new Set();
	for ( const m of best.members ) {

		const c = ctx.chunks[ m ];
		triangleKeys( c.mesh, - 1 );
		for ( const [ key, va ] of maps[ m ] ) {

			chunkKeys.add( key );
			const vb = blockMap.get( key );
			compared ++;
			if ( ! vb ) { missing ++; continue; }
			const bad = sameVertex( c.mesh, va, block.mesh, vb );
			if ( bad ) { wrong ++; wrongBy[ bad ] = ( wrongBy[ bad ] ?? 0 ) + 1; }

		}

	}
	let unmatched = 0;
	for ( const n of triangles.values() ) unmatched += Math.abs( n );
	const extra = [ ...blockMap.keys() ].filter( ( key ) => ! chunkKeys.has( key ) ).length;
	const blockOk = missing === 0 && wrong === 0 && unmatched === 0 && extra === 0;
	if ( ! blockOk ) ok = false;
	console.log( `${ blockOk ? 'ok  ' : 'FAIL' } S2 ${ ctx.label }: block ( ${ best.ci }, ${ best.cj } ) - ( ${ best.ci + 1 }, ${ best.cj + 1 } ) in one call ` +
		`(${ block.mesh.indices.length / 3 } triangles, nets ${ ms( block.netsMs ) }) against its ${ best.members.length } chunks: ` +
		`${ compared } chunk vertices compared, ${ missing } missing, ${ wrong } differ${ wrong ? ` (${ JSON.stringify( wrongBy ) })` : '' }, ${ extra } block vertices in no chunk, ${ unmatched } triangles unmatched` );
	return ok;

}

const CHECKS = [ columns, closed, seams ];

// ------------------------------------------------------------------ the run

let failed = 0;
for ( const seed of seeds ) for ( const step of steps ) {

	const start = performance.now();
	const ctx = buildCase( seed, step );
	const nets = ctx.chunks.reduce( ( s, c ) => s + c.netsMs, 0 ), scars = ctx.chunks.reduce( ( s, c ) => s + c.sdfMs, 0 );
	console.log( `---- ${ ctx.label }: ${ ctx.chunks.length } chunks meet the land; island meshes ${ ms( nets ) } (${ ms( nets / ctx.chunks.length ) } per chunk) + scars ${ ms( scars ) }` );
	for ( const check of CHECKS ) if ( ! check( ctx ) ) failed ++;
	console.log( `     ${ ctx.label } done in ${ ms( performance.now() - start ) }` );

}
if ( failed ) {

	console.log( `${ failed } checks failed.` );
	process.exit( 1 );

}
console.log( 'All chunk checks passed.' );
