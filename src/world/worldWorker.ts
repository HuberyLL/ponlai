// Builds the world geometry off the main thread: island and submerged stones (surface nets over
// their SDFs), the seabed heightfield, the shoreline distance field at sea level, and the anchors
// for the meadow vegetation. Rendering restricts those anchors to the island top.

import { surfaceNets } from './SurfaceNets.ts';
import {
	buildFootprint, makeIslandSDF, makeRocks, makeRockSDF, makeSeabed,
	layoutBounds, ISLAND_TOP, ISLAND_BOTTOM,
} from './WorldShapes.ts';
import { Field2D } from './Field2D.ts';
import { deepenSeabed } from './Bathymetry.ts';
import { mulberry32, type Rng } from './noise.ts';
import type { SDF, MeshData, MeshKind, NamedMesh, WorldData, WorldOptions } from './types.ts';

self.onmessage = ( e: MessageEvent<WorldOptions> ) => {

	const { islandVoxel = 0.12, seabedRes = 320, seabedSize = 420, shoreSize = 96, shoreCell = 0.125 } = e.data || {};
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
	for ( let j = 0; j <= n; j ++ ) for ( let i = 0; i <= n; i ++ ) {

		const x = warp( i / n * 2 - 1 ) * seabedSize / 2;
		const z = warp( j / n * 2 - 1 ) * seabedSize / 2;
		const k = ( j * ( n + 1 ) + i ) * 3;
		sb[ k ] = x; sb[ k + 1 ] = seabedHeight( x, z ); sb[ k + 2 ] = z;

	}

	mark( 'seabed', t );

	// Ground each stone on the same triangles the renderer uses. Sampling the analytic
	// floor alone can hide a small crown beneath a coarser seabed mesh.
	const rocks = makeRocks( fp, seabedSampler( sb, n, seabedSize ) );
	const islandSDF = makeIslandSDF( fp );
	const rockSDFs = rocks.map( makeRockSDF );

	const meshes: NamedMesh[] = [];
	const transfer: Transferable[] = [ sb.buffer ];
	const push = ( name: string, m: MeshData, kind: MeshKind ) => {

		meshes.push( { name, kind, ...m } );
		transfer.push( m.positions.buffer, m.normals.buffer, m.ao.buffer, m.tint.buffer, m.curv.buffer, m.indices.buffer );

	};

	// --- island
	t = performance.now();
	const b = layoutBounds();
	const pad = 2.6;
	push( 'island', surfaceNets( islandSDF, {
		min: [ b.x0 - pad, ISLAND_BOTTOM - 0.3, b.z0 - pad ],
		max: [ b.x1 + pad, ISLAND_TOP + 0.6, b.z1 + pad ],
		voxel: islandVoxel,
	} ), 'cliff' );
	mark( 'island', t );

	// --- rocks: merged into one mesh
	t = performance.now();
	{

		const parts = rocks.map( ( r, i ) => {

			const R = r.s * 1.25 * 1.6 + 0.08, Ry = r.sy * 1.6 + 0.08;
			return surfaceNets( rockSDFs[ i ], {
				min: [ r.x - R, Math.min( r.floor - 0.5, r.y - Ry ), r.z - R ], max: [ r.x + R, r.y + Ry, r.z + R ],
				// Small stones still need enough samples across their broad faces; one merged mesh
				// keeps their count independent of the draw budget.
				voxel: Math.max( 0.025, Math.min( 0.11, r.s * 0.12 ) ),
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
	const vegetation = new Float32Array( veg );
	transfer.push( vegetation.buffer );
	mark( 'vegetation', t );

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
		seabed: { positions: sb, res: n, size: seabedSize },
		vegetation,
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
