// Builds the world geometry off the main thread from the grown land (IslandGrowth.ts): island and
// submerged stones (surface nets over their SDFs), the seabed heightfield, the shoreline distance
// field at sea level, and the anchors for the meadow vegetation and sparse branches overhanging the
// upper rim. Plants root on the top.

import { surfaceNets } from './SurfaceNets.ts';
import { makeRimTrails } from './RimTrails.ts';
import { buildRimGround, buildRimSkirt, coastPaths } from './RimGround.ts';
import {
	buildFootprint, makeIslandSDF, cliffSharpCells, makeRocks, makeRockSDF, makeSeabed,
	landCentroid, ISLAND_TOP, ISLAND_BOTTOM,
} from './WorldShapes.ts';
import { growLand } from './IslandGrowth.ts';
import { Field2D } from './Field2D.ts';
import { deepenSeabed, seabedBeds, shapeShelf } from './Bathymetry.ts';
import { mulberry32, type Rng } from './noise.ts';
import { boundedSceneField, contactVisibilitySampler, type SolidBounds } from '../lighting/SkyOcclusion.ts';
import { SEABED_WARP, VEGETATION_STRIDE, VEGETATION_SPACING } from './types.ts';
import { openWorldStore } from './WorldCache.ts';
import type { SDF, MeshData, MeshKind, NamedMesh, Rock, WorldData, WorldOptions } from './types.ts';

// The page's job (World.ts): the world's options and the cache key (null: no cache). The worker
// answers with a WorldReply. It looks the world up in the cache (WorldCache.ts) first; otherwise
// it only coordinates: it starts copies of itself for the island, the stones (dealt round-robin
// into sets) and the rest (meadow anchors, rim, sea floor, shore fields), and merges their
// results in the serial order, so the world is identical to the serial one, bit for bit, whatever
// the number of threads. It stays idle meanwhile, since a nested worker only starts while its
// parent's thread is free. Every part repeats the cheap shared setup (the land, footprint, SDFs,
// stones, contact solids) from the same seeds instead of receiving it.
//
// A message of bare WorldOptions (the node tools) builds the whole world here and posts the
// WorldData synchronously; with `part` it builds one part.
export interface PageJob {
	options: WorldOptions;
	cacheKey: string | null;
}

export interface WorldReply {
	world: WorldData;
	// 'hit': read from the cache; 'miss': generated and stored; 'error': generated, the store is
	// unavailable; 'off': generated without the cache
	cache: 'hit' | 'miss' | 'error' | 'off';
	// time spent reading the cache (a hit) or handing the world to it (a miss)
	cacheMs: number;
}

interface PartJob extends WorldOptions {
	part: WorldPart;
}

type WorldPart = 'island' | { rocks: number; sets: number } | 'rest';

interface RestPart {
	// the shared setup's land, seabed grid and stones, which the merged world carries
	land: Uint8Array;
	seabedPositions: Float32Array;
	seabedCentre: [ number, number ];
	stones: Rock[];
	vegetation: Float32Array;
	rimGround: WorldData[ 'rimGround' ];
	rimSkirt: WorldData[ 'rimSkirt' ];
	rimStrands: WorldData[ 'rimStrands' ];
	seabedAO: Float32Array;
	seabedBed: Float32Array;
	shore: WorldData[ 'shore' ];
	islandShore: WorldData[ 'islandShore' ];
	seabedField: WorldData[ 'seabedField' ];
}

interface PartResult { island?: MeshData; rocks?: MeshData[]; rest?: RestPart; timings: Record<string, number> }

self.onmessage = ( e: MessageEvent<PageJob | PartJob | WorldOptions | undefined> ) => {

	const job = e.data || {};
	if ( ( job as PartJob ).part !== undefined ) {

		const [ result, transfer ] = buildPart( job as PartJob, ( job as PartJob ).part );
		self.postMessage( result, { transfer } );

	} else if ( 'options' in job ) {

		void pageJob( job ).then( async ( [ reply, stored ] ) => {

			self.postMessage( reply, { transfer: buffersOf( reply.world ) } );
			// the page leaves this worker to close itself, once the cache has the world
			await stored;
			self.close();

		} ).catch( ( error: unknown ) => {

			// an uncaught error reaches the page's worker.onerror; a rejected promise would not
			setTimeout( () => { throw error; } );

		} );

	} else {

		const [ world, transfer ] = generateSerial( job as WorldOptions );
		self.postMessage( world, { transfer } );

	}

};

async function pageJob( { options, cacheKey }: PageJob ): Promise<[ WorldReply, Promise<void> ]> {

	let t = performance.now();
	const store = cacheKey !== null && typeof indexedDB !== 'undefined' ? await openWorldStore<WorldData>( cacheKey ) : null;
	const hit = await store?.read();
	if ( hit ) {

		store!.close();
		return [ { world: hit, cache: 'hit', cacheMs: performance.now() - t }, Promise.resolve() ];

	}
	const threads = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 4 : 1;
	// the island and the rest on a thread each, the stones on up to four
	const world = typeof Worker !== 'undefined' && threads >= 3 ? await generateParallel( options, Math.min( 4, threads - 2 ) ) : generateSerial( options )[ 0 ];
	if ( ! store ) return [ { world, cache: cacheKey === null ? 'off' : 'error', cacheMs: 0 }, Promise.resolve() ];
	t = performance.now();
	const stored = store.write( world );
	return [ { world, cache: 'miss', cacheMs: performance.now() - t }, stored ];

}

// Every buffer under a value, once each, to transfer it.
function buffersOf( value: unknown, out = new Set<ArrayBufferLike>() ): ArrayBuffer[] {

	if ( ArrayBuffer.isView( value ) ) out.add( value.buffer );
	else if ( value && typeof value === 'object' ) for ( const v of Object.values( value ) ) buffersOf( v, out );
	return [ ...out ] as ArrayBuffer[];

}

function buildPart( options: WorldOptions, part: WorldPart, ctx?: Setup ): [ PartResult, Transferable[] ] {

	const timings: Record<string, number> = {};
	ctx ??= setup( options, timings );
	const result: PartResult = { timings };
	const transfer: Transferable[] = [];
	if ( part === 'island' ) {

		result.island = buildIsland( ctx, timings );
		transferMesh( result.island, transfer );

	} else if ( part === 'rest' ) {

		result.rest = buildRest( ctx, timings );
		transferRest( result.rest, transfer );

	} else {

		const t = performance.now();
		result.rocks = buildRocks( ctx, part.rocks, part.sets );
		for ( const m of result.rocks ) transferMesh( m, transfer );
		timings.rocks = Math.round( performance.now() - t );

	}
	return [ result, transfer ];

}

function generateSerial( options: WorldOptions ): [ WorldData, Transferable[] ] {

	const t0 = performance.now();
	const timings: Record<string, number> = {};
	const ctx = setup( options, timings );
	const island = buildIsland( ctx, timings );
	let t = performance.now();
	const rocks = buildRocks( ctx, 0, 1 );
	timings.rocks = Math.round( performance.now() - t );
	const rest = buildRest( ctx, timings );
	t = performance.now();
	const world = assemble( island, rocks, rest, options, timings );
	timings.merge = Math.round( performance.now() - t );
	timings.total = Math.round( performance.now() - t0 );
	return world;

}

async function generateParallel( options: WorldOptions, sets: number ): Promise<WorldData> {

	const t0 = performance.now();
	// A part whose worker fails is built here instead, so the result never depends on the threads.
	let ctx: Setup | undefined;
	const local = ( part: WorldPart ) => buildPart( options, part, ctx ??= setup( options, {} ) )[ 0 ];
	const spawn = ( part: WorldPart ) => new Promise<PartResult>( ( resolve ) => {

		try {

			const worker = new Worker( self.location.href, { type: 'module' } );
			worker.onmessage = ( e: MessageEvent<PartResult> ) => { worker.terminate(); resolve( e.data ); };
			worker.onerror = ( e ) => { e.preventDefault(); worker.terminate(); resolve( local( part ) ); };
			// a reply that cannot be deserialised fires neither of the above
			worker.onmessageerror = () => { worker.terminate(); resolve( local( part ) ); };
			worker.postMessage( { ...options, part } satisfies PartJob );

		} catch {

			resolve( local( part ) );

		}

	} );
	const parts = [ spawn( 'island' ), spawn( 'rest' ), ...Array.from( { length: sets }, ( _, set ) => spawn( { rocks: set, sets } ) ) ];
	const [ island, rest, ...rockParts ] = await Promise.all( parts );

	const t = performance.now();
	// stone i went to set i % sets, as its ( i / sets )th mesh: deal them back into stone order
	const rocks = rest.rest!.stones.map( ( _, i ) => rockParts[ i % sets ].rocks![ Math.floor( i / sets ) ] );
	const timings: Record<string, number> = { ...rest.timings, island: island.timings.island, rocks: Math.max( ...rockParts.map( ( part ) => part.timings.rocks ) ) };
	const [ world ] = assemble( island.island!, rocks, rest.rest!, options, timings );
	timings.merge = Math.round( performance.now() - t );
	timings.total = Math.round( performance.now() - t0 );
	return world;

}

type Setup = ReturnType<typeof setup>;

const defaults = ( options: WorldOptions ) => {

	const { worldSeed = 1, step = 0, islandVoxel = 0.12, seabedRes = 320, seabedSize = 420, shoreCell = 0.125, contactOcclusion = true } = options;
	return { worldSeed, step, islandVoxel, seabedRes, seabedSize, shoreCell, contactOcclusion };

};

function setup( options: WorldOptions, timings: Record<string, number> ) {

	const { worldSeed, step, islandVoxel, seabedRes, seabedSize, shoreCell, contactOcclusion } = defaults( options );
	const mark = ( k: string, t: number ) => { timings[ k ] = Math.round( performance.now() - t ); };

	let t = performance.now();
	const { land } = growLand( worldSeed, step );
	mark( 'land', t );
	t = performance.now();
	const fp = buildFootprint( land );
	mark( 'footprint', t );

	const seabedHeight = shapeShelf( fp, deepenSeabed( fp, makeSeabed( fp ) ) );

	// --- seabed: a grid warped to be dense around the island and sparse toward the horizon
	t = performance.now();
	const n = seabedRes;
	const sb = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 );
	const warp = ( u: number ) => Math.sign( u ) * Math.pow( Math.abs( u ), SEABED_WARP );
	const centroid = landCentroid( land ), centre: [ number, number ] = [ centroid.x, centroid.z ];
	let floorCeiling = - Infinity;
	for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const x = centre[ 0 ] + warp( i / n * 2 - 1 ) * seabedSize / 2;
		const z = centre[ 1 ] + warp( j / n * 2 - 1 ) * seabedSize / 2;
		const k = ( j * ( n + 1 ) + i ) * 3;
		sb[ k ] = x; sb[ k + 1 ] = seabedHeight( x, z ); sb[ k + 2 ] = z;
		floorCeiling = Math.max( floorCeiling, sb[ k + 1 ] );

	}

	mark( 'seabedGeometry', t );

	// Ground each stone on the same triangles the renderer uses. Sampling the analytic
	// floor alone can hide a small crown beneath a coarser seabed mesh.
	const renderedFloor = seabedSampler( sb, n, seabedSize, centre );
	const islandSDF = makeIslandSDF( fp );
	const rocks = makeRocks( fp, renderedFloor, islandSDF );
	const rockSDFs = rocks.map( makeRockSDF );
	// The rendered grid's highest vertex bounds contact queries on the floor.
	t = performance.now();
	const b = fp.bounds, pad = 2.6;
	// Reuse the meshing bounds: contacts refer to the same fixed solids as the rendered world.
	const islandBounds: SolidBounds = {
		field: islandSDF, min: [ b.x0 - pad, ISLAND_BOTTOM - 0.3, b.z0 - pad ],
		max: [ b.x1 + pad, ISLAND_TOP + 0.6, b.z1 + pad ],
	};
	const rockBounds = rocks.map( ( r, i ): SolidBounds => {

		const R = r.s * 1.25 * 1.6 + 0.08, Ry = r.sy * 1.6 + 0.08;
		return { field: rockSDFs[ i ], min: [ r.x - R, Math.min( r.floor - 0.5, r.y - Ry ), r.z - R ], max: [ r.x + R, r.y + Ry, r.z + R ] };

	} );
	// A heightfield is a local distance proxy, not an exact signed-distance field. Shortened
	// steps reduce overshoot on its slopes; it also occludes the buried rock faces.
	const seabedSDF: SDF = ( x, y, z ) => y - renderedFloor( x, z );
	const solids: SolidBounds[] = [ islandBounds, ...rockBounds, {
		field: seabedSDF, min: [ centre[ 0 ] - seabedSize / 2, - 32, centre[ 1 ] - seabedSize / 2 ], max: [ centre[ 0 ] + seabedSize / 2, floorCeiling, centre[ 1 ] + seabedSize / 2 ],
	} ];
	const aoSdf = contactOcclusion ? boundedSceneField( solids ) : undefined;
	const contacts = ( receiver?: SDF ) => contactOcclusion ? contactVisibilitySampler( solids, receiver ) : undefined;
	mark( 'contactSetup', t );

	return { land, fp, n, sb, centre, seabedSize, shoreCell, islandVoxel, renderedFloor, islandSDF, rocks, rockSDFs, b, islandBounds, rockBounds, seabedSDF, aoSdf, contacts };

}

function buildIsland( ctx: Setup, timings: Record<string, number> ): MeshData {

	const { islandSDF, islandBounds, islandVoxel, fp, aoSdf, contacts } = ctx;
	const t = performance.now();
	const mesh = surfaceNets( islandSDF, {
		min: [ ...islandBounds.min ], max: [ ...islandBounds.max ], voxel: islandVoxel,
		// The cliff's scars meet at sharp edges: vertices placed on the edges and a short normal
		// step keep each facet flat up to its edge instead of rounding it off.
		normalStep: islandVoxel * 0.15, sharpen: cliffSharpCells( fp ),
		aoSdf, contactVisibility: contacts( islandSDF ),
	} );
	timings.island = Math.round( performance.now() - t );
	return mesh;

}

// The stones of one set (stone i belongs to set i % sets), each meshed on its own.
function buildRocks( ctx: Setup, set: number, sets: number ): MeshData[] {

	const { rocks, rockSDFs, rockBounds, aoSdf, contacts } = ctx;
	const parts: MeshData[] = [];
	for ( let i = set; i < rocks.length; i += sets ) {

		const r = rocks[ i ];
		parts.push( surfaceNets( rockSDFs[ i ], {
			min: [ ...rockBounds[ i ].min ], max: [ ...rockBounds[ i ].max ],
			// Small stones still need enough samples across their broad faces; one merged mesh
			// keeps their count independent of the draw budget. They lie at least 1.3 m under a
			// moving, refracting surface, so about five samples across a stone (4.5 - 15 cm) keep
			// its form; finer sampling only cost triangles and generation time.
			voxel: Math.max( 0.045, Math.min( 0.15, r.s * 0.2 ) ),
			aoSdf, contactVisibility: contacts( rockSDFs[ i ] ),
		} ) );

	}
	return parts;

}

// Everything but the meshes: meadow anchors, rim ground, skirt and trails, the sea floor's
// contact visibility and beds, and the shore fields.
function buildRest( ctx: Setup, timings: Record<string, number> ): RestPart {

	const { land, islandSDF, fp, b, contacts, n, sb, centre, seabedSDF, renderedFloor, shoreCell, rocks } = ctx;
	const mark = ( k: string, t: number ) => { timings[ k ] = Math.round( performance.now() - t ); };

	// --- vegetation anchors: island turf only; submerged stones stay bare.
	// March the field down from above for position, surface normal and distance to the rim.
	let t = performance.now();
	const rngV = mulberry32( 4242 );
	const veg: number[] = [];
	scatterTop( islandSDF, b.x0 - 0.6, b.x1 + 0.6, b.z0 - 0.6, b.z1 + 0.6, VEGETATION_SPACING, ISLAND_TOP, rngV, veg, ( x, z ) => fp.dist( x, z ), 0 );
	const vegetation = new Float32Array( veg.length / 8 * VEGETATION_STRIDE );
	// The raw eight-float anchors and random streams still determine all placement. Visibility
	// is appended only after scattering, and is a local scalar proxy for an entire small plant.
	const vegetationVisibility = contacts();
	for ( let i = 0; i < veg.length / 8; i ++ ) {

		const k = i * 8, dst = i * VEGETATION_STRIDE;
		for ( let j = 0; j < 8; j ++ ) vegetation[ dst + j ] = veg[ k + j ];
		vegetation[ dst + 8 ] = vegetationVisibility?.( veg[ k ], veg[ k + 1 ], veg[ k + 2 ], veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ) ?? 1;

	}
	mark( 'vegetation', t );

	t = performance.now();
	const rimGround = buildRimGround( islandSDF, b );
	// The turf skirt drapes over the coast this field traces.
	const rimSkirt = buildRimSkirt( islandSDF, rimGround );
	mark( 'rimGround', t );

	t = performance.now();
	// Bare runs between the trails are measured along the same traced coast.
	const rimStrands = makeRimTrails( islandSDF, fp, vegetation, coastPaths( rimGround ) );
	mark( 'rimFoliage', t );

	// --- seabed contact visibility; the warped geometry was generated before the mesh bake.
	t = performance.now();
	const sbAO = new Float32Array( ( n + 1 ) * ( n + 1 ) ).fill( 1 );
	const seabedVisibility = contacts( seabedSDF );
	if ( seabedVisibility ) for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const v = j * ( n + 1 ) + i, k = v * 3;
		// Match the rendered heightfield's finite-difference normal without re-evaluating its
		// noise. Distant grid points return visible before any hemisphere traces are performed.
		const l = ( j * ( n + 1 ) + Math.max( 0, i - 1 ) ) * 3, r = ( j * ( n + 1 ) + Math.min( n, i + 1 ) ) * 3;
		const d = ( Math.max( 0, j - 1 ) * ( n + 1 ) + i ) * 3, u = ( Math.min( n, j + 1 ) * ( n + 1 ) + i ) * 3;
		const nx = - ( sb[ r + 1 ] - sb[ l + 1 ] ) / ( sb[ r ] - sb[ l ] );
		const nz = - ( sb[ u + 1 ] - sb[ d + 1 ] ) / ( sb[ u + 2 ] - sb[ d + 2 ] );
		sbAO[ v ] = seabedVisibility( sb[ k ], sb[ k + 1 ], sb[ k + 2 ], nx, 1, nz );

	}
	const sbBed = new Float32Array( ( n + 1 ) * ( n + 1 ) * 2 );
	const beds = seabedBeds( fp );
	for ( let v = 0; v < ( n + 1 ) * ( n + 1 ); v ++ ) {

		const [ grass, pale ] = beds( sb[ v * 3 ], sb[ v * 3 + 2 ] );
		sbBed[ v * 2 ] = grass; sbBed[ v * 2 + 1 ] = pale;

	}
	mark( 'seabed', t );

	// --- shoreline: only the island intersects sea level. Submerged stones must not
	// damp surface waves or grow circular foam collars above their hidden silhouettes. The field
	// covers the land's box and 32 m round it, on a 32 m grid anchored to the world.
	t = performance.now();
	const out = ( v: number, round: ( v: number ) => number, by: number ) => round( ( v + by ) / 32 ) * 32;
	const shore = Field2D.covering( out( b.x0, Math.floor, - 32 ), out( b.x1, Math.ceil, 32 ), out( b.z0, Math.floor, - 32 ), out( b.z1, Math.ceil, 32 ), shoreCell )
		.fill( ( x: number, z: number ) => islandSDF( x, 0, z ) )
		.signedDistance();
	// Match the shoreline's world bounds at half resolution for the breaking-surf pass (its sides
	// are whole multiples of 32 m, so of two cells). Keeping its resolution separate preserves the
	// existing water sampling contract.
	const islandShore = new Field2D( shore.x0, shore.z0, shore.nx / 2, shore.nz / 2, shore.cell * 2 )
		.fill( ( x: number, z: number ) => islandSDF( x, 0, z ) )
		.signedDistance();
	// The rendered floor's height (its stones aside) over the same bounds at half resolution, for the
	// water's world-space estimate of where refracted rays the screen cannot follow meet the floor.
	const seabedField = new Field2D( shore.x0, shore.z0, shore.nx / 2, shore.nz / 2, shore.cell * 2 )
		.fill( renderedFloor );
	mark( 'shore', t );

	const field = ( f: Field2D ) => ( { data: f.data, nx: f.nx, nz: f.nz, x0: f.x0, z0: f.z0, cell: f.cell } );
	return {
		land: land.toBytes(), seabedPositions: sb, seabedCentre: centre, stones: rocks,
		vegetation, rimGround, rimSkirt, rimStrands, seabedAO: sbAO, seabedBed: sbBed,
		shore: field( shore ), islandShore: field( islandShore ), seabedField: field( seabedField ),
	};

}

function transferMesh( m: MeshData, transfer: Transferable[] ): void {

	transfer.push( m.positions.buffer, m.normals.buffer, m.ao.buffer, m.tint.buffer, m.curv.buffer, m.indices.buffer );
	if ( m.detail ) transfer.push( m.detail.buffer );
	if ( m.detail2 ) transfer.push( m.detail2.buffer );

}

function transferRest( rest: RestPart, transfer: Transferable[] ): void {

	transfer.push( rest.land.buffer, rest.seabedPositions.buffer, rest.vegetation.buffer, rest.rimGround.data.buffer, rest.rimSkirt.points.buffer, rest.rimSkirt.info.buffer, rest.rimSkirt.loops.buffer );
	for ( const strand of rest.rimStrands ) transfer.push( strand.points.buffer, ...( strand.clump ? [ strand.clump.buffer ] : [] ) );
	transfer.push( rest.seabedAO.buffer, rest.seabedBed.buffer, rest.shore.data.buffer, rest.islandShore.data.buffer, rest.seabedField.data.buffer );

}

function assemble( island: MeshData, rocks: MeshData[], rest: RestPart, options: WorldOptions, timings: Record<string, number> ): [ WorldData, Transferable[] ] {

	const meshes: NamedMesh[] = [];
	const transfer: Transferable[] = [];
	const push = ( name: string, m: MeshData, kind: MeshKind ) => {

		meshes.push( { name, kind, ...m } );
		transferMesh( m, transfer );

	};
	push( 'island', island, 'cliff' );
	// the stones merged into one mesh, in stone order
	push( 'rocks', mergeParts( rocks ), 'rock' );
	transferRest( rest, transfer );

	const { seabedRes, seabedSize } = defaults( options );
	const world: WorldData = {
		land: rest.land,
		meshes,
		rocks: rest.stones,
		seabed: { positions: rest.seabedPositions, ao: rest.seabedAO, bed: rest.seabedBed, res: seabedRes, size: seabedSize, centre: rest.seabedCentre },
		vegetation: rest.vegetation,
		rimStrands: rest.rimStrands,
		rimGround: rest.rimGround,
		rimSkirt: rest.rimSkirt,
		shore: rest.shore,
		islandShore: rest.islandShore,
		seabedField: rest.seabedField,
		timings,
	};
	return [ world, transfer ];

}

// The inverse warp locates the grid cell; interpolation then uses its stored world positions,
// rather than the warped grid fraction, to match buildWorldMeshes()'s two indexed triangles.
function seabedSampler( positions: Float32Array, n: number, size: number, centre: [ number, number ] ): ( x: number, z: number ) => number {

	const index = ( v: number ) => Math.max( 0, Math.min( n - 1,
		Math.floor( ( Math.sign( v ) * Math.pow( Math.abs( v / ( size / 2 ) ), 1 / SEABED_WARP ) + 1 ) * n / 2 ) ) );
	return ( x, z ) => {

		const i = index( x - centre[ 0 ] ), j = index( z - centre[ 1 ] );
		const a = ( j * ( n + 1 ) + i ) * 3, e = a + 3, s = a + ( n + 1 ) * 3, d = s + 3;
		const u = Math.max( 0, Math.min( 1, ( x - positions[ a ] ) / ( positions[ e ] - positions[ a ] ) ) );
		const v = Math.max( 0, Math.min( 1, ( z - positions[ a + 2 ] ) / ( positions[ s + 2 ] - positions[ a + 2 ] ) ) );
		return u + v <= 1
			? positions[ a + 1 ] + ( positions[ e + 1 ] - positions[ a + 1 ] ) * u + ( positions[ s + 1 ] - positions[ a + 1 ] ) * v
			: positions[ d + 1 ] + ( positions[ s + 1 ] - positions[ d + 1 ] ) * ( 1 - u ) + ( positions[ e + 1 ] - positions[ d + 1 ] ) * ( 1 - v );

	};

}

// jittered grid over [x0, x1] x [z0, z1]; for each sample march down to the surface and keep it
// if it faces up enough to hold turf (the rounded rim included). Appends x, y, z, nx, ny, nz, rim
// (signed distance to the shape's edge, negative inside), kind (0 island).
function scatterTop( sdf: SDF, x0: number, x1: number, z0: number, z1: number, spacing: number, yTop: number,
	rng: Rng, out: number[], rimDist: ( x: number, z: number ) => number, kind: number ): void {

	for ( let z = z0; z < z1; z += spacing ) for ( let x = x0; x < x1; x += spacing ) {

		const px = x + ( rng() - 0.5 ) * spacing * 0.95, pz = z + ( rng() - 0.5 ) * spacing * 0.95;
		let y = yTop + 1.2;
		let hit = false;
		for ( let i = 0; i < 80; i ++ ) {

			const d = sdf( px, y, pz );
			if ( d < 0.003 ) { hit = true; break; }
			y -= Math.max( d * 0.7, 0.004 );
			if ( y < yTop - 1.5 ) break;

		}

		if ( ! hit ) continue;
		const e = 0.04;
		let nx = sdf( px + e, y, pz ) - sdf( px - e, y, pz );
		let ny = sdf( px, y + e, pz ) - sdf( px, y - e, pz );
		let nz = sdf( px, y, pz + e ) - sdf( px, y, pz - e );
		const l = Math.hypot( nx, ny, nz ) || 1;
		nx /= l; ny /= l; nz /= l;
		if ( ny < 0.3 ) continue;
		out.push( px, y, pz, nx, ny, nz, rimDist( px, pz ), kind );

	}

}

function mergeParts( parts: MeshData[] ): MeshData {

	let nv = 0, ni = 0;
	for ( const p of parts ) { nv += p.positions.length / 3; ni += p.indices.length; }
	const positions = new Float32Array( nv * 3 ), normals = new Float32Array( nv * 3 ), ao = new Float32Array( nv );
	const tint = new Float32Array( nv ), curv = new Float32Array( nv );
	const indices = new Uint32Array( ni );
	let ov = 0, oi = 0;
	for ( const p of parts ) {

		positions.set( p.positions, ov * 3 );
		normals.set( p.normals, ov * 3 );
		ao.set( p.ao, ov );
		tint.set( p.tint, ov );
		curv.set( p.curv, ov );
		for ( let k = 0; k < p.indices.length; k ++ ) indices[ oi + k ] = p.indices[ k ] + ov;
		ov += p.positions.length / 3;
		oi += p.indices.length;

	}

	return { positions, normals, ao, tint, curv, indices };

}
