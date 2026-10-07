// Builds the world geometry off the main thread: island and submerged stones (surface nets over
// their SDFs), the seabed heightfield, the shoreline distance field at sea level, and the anchors
// for the meadow vegetation and sparse branches overhanging the upper rim. Plants root on the top.

import { surfaceNets } from './SurfaceNets.ts';
import { makeRimTrails } from './RimTrails.ts';
import { buildRimGround } from './RimGround.ts';
import {
	buildFootprint, makeIslandSDF, makeRocks, makeRockSDF, makeSeabed,
	layoutBounds, ISLAND_TOP, ISLAND_BOTTOM,
} from './WorldShapes.ts';
import { Field2D } from './Field2D.ts';
import { deepenSeabed, seabedBeds } from './Bathymetry.ts';
import { mulberry32, type Rng } from './noise.ts';
import { boundedSceneField, contactVisibilitySampler, type SolidBounds } from '../lighting/SkyOcclusion.ts';
import { VEGETATION_STRIDE } from './types.ts';
import type { SDF, MeshData, MeshKind, NamedMesh, WorldData, WorldOptions } from './types.ts';

self.onmessage = ( e: MessageEvent<WorldOptions> ) => {

	const { islandVoxel = 0.12, seabedRes = 320, seabedSize = 420, shoreSize = 96, shoreCell = 0.125, contactOcclusion = true } = e.data || {};
	const t0 = performance.now();
	const timings: Record<string, number> = {};
	const mark = ( k: string, t: number ) => { timings[ k ] = Math.round( performance.now() - t ); };

	let t = performance.now();
	const fp = buildFootprint();
	mark( 'footprint', t );

	const seabedHeight = deepenSeabed( fp, makeSeabed( fp ) );

	// --- seabed: a grid warped to be dense around the island and sparse toward the horizon
	t = performance.now();
	const n = seabedRes;
	const sb = new Float32Array( ( n + 1 ) * ( n + 1 ) * 3 );
	const warp = ( u: number ) => Math.sign( u ) * Math.pow( Math.abs( u ), 1.9 );
	let floorCeiling = - Infinity;
	for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const x = warp( i / n * 2 - 1 ) * seabedSize / 2;
		const z = warp( j / n * 2 - 1 ) * seabedSize / 2;
		const k = ( j * ( n + 1 ) + i ) * 3;
		sb[ k ] = x; sb[ k + 1 ] = seabedHeight( x, z ); sb[ k + 2 ] = z;
		floorCeiling = Math.max( floorCeiling, sb[ k + 1 ] );

	}

	mark( 'seabedGeometry', t );

	// Ground each stone on the same triangles the renderer uses. Sampling the analytic
	// floor alone can hide a small crown beneath a coarser seabed mesh.
	const renderedFloor = seabedSampler( sb, n, seabedSize );
	const rocks = makeRocks( fp, renderedFloor );
	const islandSDF = makeIslandSDF( fp );
	const rockSDFs = rocks.map( makeRockSDF );
	// The rendered grid's highest vertex bounds contact queries on the floor.
	t = performance.now();
	const b = layoutBounds(), pad = 2.6;
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
		field: seabedSDF, min: [ - seabedSize / 2, - 32, - seabedSize / 2 ], max: [ seabedSize / 2, floorCeiling, seabedSize / 2 ],
	} ];
	const aoSdf = contactOcclusion ? boundedSceneField( solids ) : undefined;
	const contacts = ( receiver?: SDF ) => contactOcclusion ? contactVisibilitySampler( solids, receiver ) : undefined;
	mark( 'contactSetup', t );

	const meshes: NamedMesh[] = [];
	const transfer: Transferable[] = [];
	const push = ( name: string, m: MeshData, kind: MeshKind ) => {

		meshes.push( { name, kind, ...m } );
		transfer.push( m.positions.buffer, m.normals.buffer, m.ao.buffer, m.tint.buffer, m.curv.buffer, m.indices.buffer );

	};

	// --- island
	t = performance.now();
	push( 'island', surfaceNets( islandSDF, {
		min: [ ...islandBounds.min ], max: [ ...islandBounds.max ], voxel: islandVoxel,
		aoSdf, contactVisibility: contacts( islandSDF ),
	} ), 'cliff' );
	mark( 'island', t );

	// --- rocks: merged into one mesh
	t = performance.now();
	{

		const parts = rocks.map( ( r, i ) => {

			return surfaceNets( rockSDFs[ i ], {
				min: [ ...rockBounds[ i ].min ], max: [ ...rockBounds[ i ].max ],
				// Small stones still need enough samples across their broad faces; one merged mesh
				// keeps their count independent of the draw budget.
				voxel: Math.max( 0.025, Math.min( 0.11, r.s * 0.12 ) ),
				aoSdf, contactVisibility: contacts( rockSDFs[ i ] ),
			} );

		} );
		push( 'rocks', mergeParts( parts ), 'rock' );

	}

	mark( 'rocks', t );

	// --- vegetation anchors: island turf only; submerged stones stay bare.
	// March the field down from above for position, surface normal and distance to the rim.
	t = performance.now();
	const rngV = mulberry32( 4242 );
	const veg: number[] = [];
	scatterTop( islandSDF, b.x0 - 0.6, b.x1 + 0.6, b.z0 - 0.6, b.z1 + 0.6, 0.235, ISLAND_TOP, rngV, veg, ( x, z ) => fp.dist( x, z ), 0 );
	const vegetation = new Float32Array( veg.length / 8 * VEGETATION_STRIDE );
	// The raw eight-float anchors and random streams still determine all placement. Visibility
	// is appended only after scattering, and is a local scalar proxy for an entire small plant.
	const vegetationVisibility = contacts();
	for ( let i = 0; i < veg.length / 8; i ++ ) {

		const k = i * 8, dst = i * VEGETATION_STRIDE;
		for ( let j = 0; j < 8; j ++ ) vegetation[ dst + j ] = veg[ k + j ];
		vegetation[ dst + 8 ] = vegetationVisibility?.( veg[ k ], veg[ k + 1 ], veg[ k + 2 ], veg[ k + 3 ], veg[ k + 4 ], veg[ k + 5 ] ) ?? 1;

	}
	transfer.push( vegetation.buffer );
	mark( 'vegetation', t );

	t = performance.now();
	const rimStrands = makeRimTrails( islandSDF, fp, vegetation );
	for ( const strand of rimStrands ) transfer.push( strand.points.buffer );
	mark( 'rimFoliage', t );

	t = performance.now();
	const rimGround = buildRimGround( islandSDF );
	transfer.push( rimGround.data.buffer );
	mark( 'rimGround', t );

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
	transfer.push( sb.buffer, sbAO.buffer, sbBed.buffer );
	mark( 'seabed', t );

	// --- shoreline: only the island intersects sea level. Submerged stones must not
	// damp surface waves or grow circular foam collars above their hidden silhouettes.
	t = performance.now();
	const shore = Field2D.covering( - shoreSize / 2, shoreSize / 2, - shoreSize / 2, shoreSize / 2, shoreCell )
		.fill( ( x: number, z: number ) => islandSDF( x, 0, z ) )
		.signedDistance();
	transfer.push( shore.data.buffer );
	// Match the shoreline's world bounds at half resolution for the breaking-surf pass.
	// Keeping its resolution separate preserves the existing water sampling contract.
	const islandRes = Math.ceil( shore.nx / 2 );
	const islandShore = new Field2D( shore.x0, shore.z0, islandRes, islandRes, shore.nx * shore.cell / islandRes )
		.fill( ( x: number, z: number ) => islandSDF( x, 0, z ) )
		.signedDistance();
	transfer.push( islandShore.data.buffer );
	mark( 'shore', t );

	timings.total = Math.round( performance.now() - t0 );

	const result: WorldData = {
		meshes,
		rocks,
		seabed: { positions: sb, ao: sbAO, bed: sbBed, res: n, size: seabedSize },
		vegetation,
		rimStrands,
		rimGround,
		shore: { data: shore.data, nx: shore.nx, nz: shore.nz, x0: shore.x0, z0: shore.z0, cell: shore.cell },
		islandShore: { data: islandShore.data, nx: islandShore.nx, nz: islandShore.nz, x0: islandShore.x0, z0: islandShore.z0, cell: islandShore.cell },
		timings,
	};
	self.postMessage( result, { transfer } );

};

// The inverse warp locates the grid cell; interpolation then uses its stored world positions,
// rather than the warped grid fraction, to match buildWorldMeshes()'s two indexed triangles.
function seabedSampler( positions: Float32Array, n: number, size: number ): ( x: number, z: number ) => number {

	const index = ( v: number ) => Math.max( 0, Math.min( n - 1,
		Math.floor( ( Math.sign( v ) * Math.pow( Math.abs( v / ( size / 2 ) ), 1 / 1.9 ) + 1 ) * n / 2 ) ) );
	return ( x, z ) => {

		const i = index( x ), j = index( z );
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
