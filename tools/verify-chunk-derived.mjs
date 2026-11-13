// The chunks' derived products against today's main-thread builders (plain node, CPU only):
//   node tools/verify-chunk-derived.mjs [--seed 1] [--steps 0,8] [--threads n]
//
// Every chunk of the grown land is built on a pool of worker threads (Chunks.ts `buildChunk`), and
// its meshes are merged as one island, one stones mesh and one floor (the tiles, lattice order of
// the keys) for the builders the page runs today. Per step:
// The chunks take their caster columns and ground grid from the island as meshed, before it is
// simplified (Chunks.ts, IslandSimplify.ts): the workers mesh it again unsimplified
// (`chunkIsland( ..., { simplify: false } )`), and the columns' and the ground's walks below run over
// that, the subsets over the drawn (simplified) mesh.
//   columns   SunShadow's caster-depth columns: today's walk over the merged island mesh against
//             the chunks' `casterColumns` folded in (`setCasters( box, columns )`, the chunks'
//             meshes given without vertices, so nothing but the columns can fill them). Every
//             column of the walk is inside the folded one, and every folded column inside the
//             walk's columns of its 3 x 3 cells (within one cell); prints how many differ and by
//             how much.
//   subsets   RefractedSun's triangle subsets at the sea level: today's cut of the merged island,
//             stones and floor against the chunks' `refracted` subsets, offset and joined in the
//             merge's order: the same triangles, exactly. And `setCasters( root, subsets )` on the
//             chunks' own meshes draws each chunk's subset as given.
//   ground    IslandGround: `build` over the merged island mesh against `fromGrids` of the chunks'
//             `ground` grids: the same bounds and top, and every cell's height within one cell
//             (at each grid's cell centres, a height of one is at most the other's highest over
//             the 3 x 3 cells round it); prints the largest difference at a point.
// It also prints the time today's builders take on these meshes and what the merge takes instead.
// Exit code 1 on any failure.
// A pass is recorded (tools/verify-cache.mjs): a later run with the same arguments, node and source
// files (the script's whole import graph) prints that it was skipped and exits 0; --force runs it.
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildChunk, chunkIsland, chunkKeys, landField, landWindow, parseChunkKey } from '../packages/island/world/Chunks.ts';
import { growLand, LandLattice } from '../packages/island/world/IslandGrowth.ts';
import { tileIndices, TILE_SIDE } from '../packages/island/world/SeabedTile.ts';
import { FLOOR_STEP } from '../packages/island/world/Bathymetry.ts';
import { SEA_LEVEL } from '../packages/island/world/ChunkDerived.ts';
import { verifyCache } from './verify-cache.mjs';
import { simplifierReady } from '../packages/island/world/IslandSimplify.ts';

// the island's simplifier (wasm) is ready before any chunk is built, in every thread
await simplifierReady;

// ------------------------------------------------------------------ the worker

if ( ! isMainThread ) {

	let land = null, version = - 1;
	parentPort.on( 'message', ( job ) => {

		if ( job.version !== version ) { land = LandLattice.fromBytes( job.land ); version = job.version; }
		const c = buildChunk( job.window, land, job.ci, job.cj );
		const reply = {
			key: c.key, island: c.island && { positions: c.island.positions, indices: c.island.indices },
			stones: { positions: c.stones.mesh.positions, indices: c.stones.mesh.indices }, floor: c.floor && c.floor.height,
			casters: c.casters, casterColumns: c.casterColumns, refracted: c.refracted, ground: c.ground, ms: c.timings.total,
			// the island as meshed (positions do not depend on the contact shade)
			full: c.island && chunkIsland( job.window, job.ci, job.cj, 1, { contactOcclusion: false, simplify: false } ).positions,
		};
		parentPort.postMessage( reply );

	} );

}

// ------------------------------------------------------------------ the run

const argument = ( name, fallback ) => {

	const i = process.argv.indexOf( name );
	return i < 0 ? fallback : process.argv[ i + 1 ];

};

// The consumers import modules plain node cannot load (they read `import.meta.env`, and
// RefractedSun.ts has constructor parameter properties node's type stripping cannot erase), so they
// load through Vite's SSR loader on the main thread only, as tools/verify-world-stats.mjs loads its
// planting (they read the page's settings as a page without options: packages/render/Settings.ts).
// three's WebGPU build, written for a page, loads under node as it is.
async function loadConsumers() {

	const { createServer } = await import( 'vite' );
	const server = await createServer( {
		root: fileURLToPath( new URL( '../', import.meta.url ) ), configFile: false, logLevel: 'error', appType: 'custom',
		server: { middlewareMode: true, hmr: false, ws: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
	} );
	const THREE = await server.ssrLoadModule( 'three/webgpu' );
	const { SunShadow } = await server.ssrLoadModule( '/packages/render/lighting/SunShadow.ts' );
	const { RefractedSun } = await server.ssrLoadModule( '/packages/render/lighting/RefractedSun.ts' );
	const { IslandGround } = await server.ssrLoadModule( '/packages/island/camera/IslandGround.ts' );
	await server.close();
	return { THREE, SunShadow, RefractedSun, IslandGround };

}

async function buildChunks( land, version, threads ) {

	const field = landField( land ), bytes = land.toBytes(), keys = chunkKeys( land );
	const workers = Array.from( { length: Math.min( threads, keys.length ) }, () => new Worker( fileURLToPath( import.meta.url ) ) );
	const out = new Map();
	let next = 0;
	await Promise.all( workers.map( ( worker ) => new Promise( ( resolve, reject ) => {

		const send = () => {

			if ( next >= keys.length ) { worker.terminate(); resolve(); return; }
			const [ ci, cj ] = parseChunkKey( keys[ next ++ ] );
			const window = landWindow( field, ci, cj );
			worker.postMessage( { version, land: bytes, window, ci, cj }, [ window.data.buffer ] );

		};
		worker.on( 'message', ( reply ) => { out.set( reply.key, reply ); send(); } );
		worker.on( 'error', reject );
		send();

	} ) ) );
	return keys.map( ( key ) => out.get( key ) );

}

// Meshes merged in order, one index space, and each part's first vertex.
function merge( parts ) {

	let nv = 0, ni = 0;
	for ( const p of parts ) { nv += p.positions.length / 3; ni += p.indices.length; }
	const positions = new Float32Array( nv * 3 ), indices = new Uint32Array( ni ), offsets = [];
	let ov = 0, oi = 0;
	for ( const p of parts ) {

		offsets.push( ov );
		positions.set( p.positions, ov * 3 );
		for ( let k = 0; k < p.indices.length; k ++ ) indices[ oi + k ] = p.indices[ k ] + ov;
		ov += p.positions.length / 3;
		oi += p.indices.length;

	}
	return { positions, indices, offsets };

}

// A floor tile's mesh from its heights (the lattice's x and z do not matter to the cut).
const TILE_INDEX = tileIndices();
function floorMesh( height, ci, cj ) {

	const positions = new Float32Array( TILE_SIDE * TILE_SIDE * 3 );
	for ( let j = 0; j < TILE_SIDE; j ++ ) for ( let i = 0; i < TILE_SIDE; i ++ ) {

		const v = j * TILE_SIDE + i;
		positions.set( [ ( ci * ( TILE_SIDE - 1 ) + i ) * FLOOR_STEP, height[ v ], ( cj * ( TILE_SIDE - 1 ) + j ) * FLOOR_STEP ], v * 3 );

	}
	return { positions, indices: TILE_INDEX };

}

const time = ( f, n = 3 ) => {

	f();
	const t = performance.now();
	for ( let i = 0; i < n; i ++ ) f();
	return ( performance.now() - t ) / n;

};

async function main() {

	const cache = verifyCache( import.meta.url );
	cache.check();
	const seed = Number( argument( '--seed', '1' ) );
	const steps = argument( '--steps', '0,8' ).split( ',' ).map( Number );
	const threads = Number( argument( '--threads', String( Math.max( 1, Math.min( 8, availableParallelism() - 4 ) ) ) ) );
	const { THREE, SunShadow, RefractedSun, IslandGround } = await loadConsumers();
	let failures = 0;
	const check = ( ok, line ) => {

		console.log( `  ${ ok ? 'ok  ' : 'FAIL' } ${ line }` );
		if ( ! ok ) failures ++;

	};
	const meshOf = ( { positions, indices } ) => {

		const geometry = new THREE.BufferGeometry();
		geometry.setAttribute( 'position', new THREE.BufferAttribute( positions, 3 ) );
		geometry.setIndex( new THREE.BufferAttribute( indices, 1 ) );
		return geometry;

	};
	const receiver = new THREE.NodeMaterial();
	receiver.userData.refractedSolarReceiver = true;
	console.log( `seed ${ seed }, steps ${ steps.join( ', ' ) }, ${ threads } threads` );

	for ( const step of steps ) {

		const t0 = performance.now();
		const { land } = growLand( seed, step );
		const chunks = await buildChunks( land, seed * 1000 + step, threads );
		const islands = chunks.filter( ( c ) => c.island );
		const floors = chunks.filter( ( c ) => c.floor );
		const island = merge( islands.map( ( c ) => c.island ) );
		const full = merge( islands.map( ( c ) => ( { positions: c.full, indices: new Uint32Array( 0 ) } ) ) );
		const stones = merge( chunks.map( ( c ) => c.stones ) );
		const floor = merge( floors.map( ( c ) => {

			const [ ci, cj ] = parseChunkKey( c.key );
			return floorMesh( c.floor, ci, cj );

		} ) );
		console.log( `step ${ step }: ${ chunks.length } chunks (${ islands.length } with island, ${ floors.length } floor tiles), built in ${ ( ( performance.now() - t0 ) / 1000 ).toFixed( 1 ) } s; ` +
			`island triangles drawn ${ island.indices.length / 3 }, vertices drawn ${ island.positions.length / 3 } of ${ full.positions.length / 3 } meshed` );

		// --- columns
		{

			const box = new THREE.Box3();
			for ( const c of chunks ) box.union( new THREE.Box3( new THREE.Vector3( ...c.casters.slice( 0, 3 ) ), new THREE.Vector3( ...c.casters.slice( 3 ) ) ) );
			const sun = new THREE.DirectionalLight();
			const walked = new SunShadow( sun ), folded = new SunShadow( sun );
			const merged = new THREE.Mesh( meshOf( full ), receiver );
			merged.castShadow = true;
			const sceneA = new THREE.Scene().add( merged );
			walked.setCasters( box );
			const walkMs = time( () => walked.buildColumns( sceneA ) );
			const sceneB = new THREE.Scene(), given = new Map();
			for ( const c of islands ) {

				// no vertices: only the given columns can fill the grid
				const mesh = new THREE.Mesh( new THREE.BufferGeometry(), receiver );
				mesh.castShadow = true;
				sceneB.add( mesh );
				given.set( mesh, c.casterColumns );

			}
			folded.setCasters( box, given );
			const foldMs = time( () => folded.buildColumns( sceneB ) );
			const a = walked.columns, b = folded.columns;
			const { nx, nz } = a;
			let missing = 0, beyond = 0, differ = 0, maxLow = 0, maxHigh = 0, filled = 0;
			for ( let j = 0; j < nz; j ++ ) for ( let i = 0; i < nx; i ++ ) {

				const k = j * nx + i;
				const aFilled = a.high[ k ] >= a.low[ k ], bFilled = b.high[ k ] >= b.low[ k ];
				if ( aFilled ) filled ++;
				// the walk's column inside the folded one
				if ( aFilled && ! ( bFilled && b.low[ k ] <= a.low[ k ] && b.high[ k ] >= a.high[ k ] ) ) missing ++;
				if ( aFilled !== bFilled || ( aFilled && ( a.low[ k ] !== b.low[ k ] || a.high[ k ] !== b.high[ k ] ) ) ) {

					differ ++;
					if ( aFilled && bFilled ) { maxLow = Math.max( maxLow, a.low[ k ] - b.low[ k ] ); maxHigh = Math.max( maxHigh, b.high[ k ] - a.high[ k ] ); }

				}
				// the folded column inside the walk's 3 x 3
				if ( bFilled ) {

					let low = Infinity, high = - Infinity;
					for ( let y = Math.max( j - 1, 0 ); y <= Math.min( j + 1, nz - 1 ); y ++ ) for ( let x = Math.max( i - 1, 0 ); x <= Math.min( i + 1, nx - 1 ); x ++ ) {

						low = Math.min( low, a.low[ y * nx + x ] );
						high = Math.max( high, a.high[ y * nx + x ] );

					}
					if ( ! ( b.low[ k ] >= low && b.high[ k ] <= high ) ) beyond ++;

				}

			}
			check( a.nx === b.nx && a.nz === b.nz && a.cell === b.cell, `columns: one grid, ${ nx } x ${ nz } cells of ${ a.cell.toFixed( 3 ) } m (${ filled } filled)` );
			check( missing === 0, `columns: every walked column inside the folded one (${ missing } not)` );
			check( beyond === 0, `columns: every folded column within one cell of the walk's (${ beyond } beyond); ${ differ } cells differ, by up to ${ maxLow.toFixed( 3 ) } m lower and ${ maxHigh.toFixed( 3 ) } m higher` );
			console.log( `  time: walk ${ walkMs.toFixed( 1 ) } ms, fold ${ foldMs.toFixed( 1 ) } ms` );

		}

		// --- subsets
		{

			const renderer = { coordinateSystem: THREE.WebGPUCoordinateSystem };
			const shared = { waterLevel: { value: SEA_LEVEL }, sunDir: { value: new THREE.Vector3( 0, 1, 0 ) } };
			const parts = { island: [ island, islands, 'island' ], stones: [ stones, chunks, 'stones' ], floor: [ floor, floors, 'floor' ] };
			// today's cut of the merged meshes
			const root = new THREE.Group(), sources = {};
			for ( const [ name, [ mesh ] ] of Object.entries( parts ) ) {

				sources[ name ] = new THREE.Mesh( meshOf( mesh ), receiver );
				root.add( sources[ name ] );

			}
			const today = new RefractedSun( renderer, shared );
			today.setCasters( root );
			const cutMs = time( () => today.cutSubsets( SEA_LEVEL ) );
			const indexOf = ( sun ) => new Map( sun.casters.map( ( c ) => [ c.source, Array.from( c.proxy.geometry.getIndex().array ) ] ) );
			const cut = indexOf( today );
			// the chunks' subsets, joined
			for ( const [ name, [ mesh, owners, field ] ] of Object.entries( parts ) ) {

				const joined = [];
				owners.forEach( ( c, n ) => {

					const index = c.refracted[ field ] ?? ( field === 'floor' ? TILE_INDEX : c[ field ].indices );
					for ( const v of index ) joined.push( v + mesh.offsets[ n ] );

				} );
				const expected = cut.get( sources[ name ] );
				const same = expected.length === joined.length && expected.every( ( v, k ) => v === joined[ k ] );
				check( same, `subsets: ${ name }: ${ joined.length / 3 } of ${ mesh.indices.length / 3 } triangles, ${ same ? 'the same' : `today's cut has ${ expected.length / 3 }` }` );

			}
			// the new entry point on the chunks' own meshes
			const chunkRoot = new THREE.Group(), given = new Map(), wanted = new Map();
			for ( const [ name, [ , owners, field ] ] of Object.entries( parts ) ) owners.forEach( ( c ) => {

				const [ ci, cj ] = parseChunkKey( c.key );
				const part = field === 'floor' ? floorMesh( c.floor, ci, cj ) : c[ field ];
				const mesh = new THREE.Mesh( meshOf( part ), receiver );
				mesh.name = `${ name } ${ c.key }`;
				chunkRoot.add( mesh );
				given.set( mesh, { level: c.refracted.level, index: c.refracted[ field ] } );
				wanted.set( mesh, Array.from( c.refracted[ field ] ?? part.indices ) );

			} );
			const chunked = new RefractedSun( renderer, shared );
			chunked.setCasters( chunkRoot, given );
			const givenMs = time( () => chunked.cutSubsets( SEA_LEVEL ) );
			let wrong = 0;
			for ( const [ mesh, index ] of indexOf( chunked ) ) {

				const want = wanted.get( mesh );
				if ( want.length !== index.length || want.some( ( v, k ) => v !== index[ k ] ) ) wrong ++;

			}
			check( wrong === 0, `subsets: setCasters( root, subsets ) draws the given subsets (${ wrong } of ${ given.size } meshes not)` );
			console.log( `  time: cut ${ cutMs.toFixed( 1 ) } ms, given ${ givenMs.toFixed( 1 ) } ms` );

		}

		// --- ground
		{

			const merged = new THREE.Mesh( meshOf( full ), receiver );
			merged.updateMatrixWorld();
			const walked = new IslandGround(), joined = new IslandGround();
			const buildMs = time( () => walked.build( [ merged ] ) );
			const mergeMs = time( () => joined.fromGrids( islands.map( ( c ) => c.ground ) ) );
			check( walked.bounds.equals( joined.bounds ) && walked.top === joined.top, `ground: the same bounds and top (${ walked.top.toFixed( 3 ) } m)` );
			// at each grid's cell centres, the other's highest over the 3 x 3 cells round the point
			const CELL = 0.5;
			let beyond = 0, samples = 0, maxDiff = 0;
			const neighbourhood = ( ground, x, z ) => {

				let h = - Infinity;
				for ( let dz = - 1; dz <= 1; dz ++ ) for ( let dx = - 1; dx <= 1; dx ++ ) h = Math.max( h, ground.heightAt( x + dx * CELL, z + dz * CELL ) );
				return h;

			};
			for ( const [ a, b ] of [ [ walked, joined ], [ joined, walked ] ] ) {

				for ( let j = 0; j < a.nz; j ++ ) for ( let i = 0; i < a.nx; i ++ ) {

					const x = a.x0 + ( i + 0.5 ) * CELL, z = a.z0 + ( j + 0.5 ) * CELL;
					samples ++;
					const h = a.heightAt( x, z );
					maxDiff = Math.max( maxDiff, Math.abs( h - b.heightAt( x, z ) ) );
					if ( h > neighbourhood( b, x, z ) ) beyond ++;

				}

			}
			check( beyond === 0, `ground: every height within one cell of the other grid's (${ beyond } of ${ samples } samples beyond); largest difference at a point ${ maxDiff.toFixed( 3 ) } m` );
			console.log( `  time: build ${ buildMs.toFixed( 1 ) } ms, fromGrids ${ mergeMs.toFixed( 1 ) } ms` );

		}

	}
	console.log( failures ? `${ failures } FAILED` : 'all passed' );
	if ( ! failures ) cache.record();
	process.exit( failures ? 1 : 0 );

}

if ( isMainThread ) main();
