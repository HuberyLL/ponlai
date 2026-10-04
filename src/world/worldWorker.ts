// Builds the world geometry off the main thread: island, sea stacks and rocks (surface nets over
// their SDFs), the seabed heightfield, the shoreline distance field at sea level, and the anchors
// for the vegetation (turf points on the island and stack tops, ivy strands down the cliffs).

import { surfaceNets } from './SurfaceNets.ts';
import {
	buildFootprint, makeIslandSDF, makeStacks, makeStackSDF, makeRocks, makeRockSDF, makeSeabed,
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

	const stacks = makeStacks();
	// Rock placement stays tied to the original shelf. Only the rendered floor between
	// those fixed anchors becomes deeper.
	const placementFloor = makeSeabed( fp, stacks );
	const rocks = makeRocks( fp, stacks, placementFloor );
	const seabedHeight = deepenSeabed( fp, rocks, placementFloor );
	const islandSDF = makeIslandSDF( fp );
	const stackSDFs = stacks.map( ( s, i ) => makeStackSDF( s, i + 1 ) );
	const rockSDFs = rocks.map( makeRockSDF );

	const meshes: NamedMesh[] = [];
	const transfer: Transferable[] = [];
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

	// --- stacks
	t = performance.now();
	stacks.forEach( ( s, i ) => {

		const R = s.r * 2.2 + 1.2;
		push( 'stack' + i, surfaceNets( stackSDFs[ i ], {
			min: [ s.x - R, - 7.0, s.z - R ], max: [ s.x + R, s.h + 0.8, s.z + R ], voxel: 0.11,
		} ), 'stack' );

	} );
	mark( 'stacks', t );

	// --- rocks: merged into one mesh
	t = performance.now();
	{

		const parts = rocks.map( ( r, i ) => {

			const R = r.s * 1.25 * 1.6 + 0.3, Ry = r.sy * 1.6 + 0.3;
			return surfaceNets( rockSDFs[ i ], {
				min: [ r.x - R, r.floor - 0.6, r.z - R ], max: [ r.x + R, r.y + Ry, r.z + R ],
				voxel: Math.max( 0.07, Math.min( 0.13, r.s * 0.085 ) ),
			} );

		} );
		push( 'rocks', mergeParts( parts ), 'rock' );

	}

	mark( 'rocks', t );

	// --- vegetation anchors: points on the turf of the island and the stack tops, found by
	// marching each shape's field down from above; position, surface normal, distance to the rim
	t = performance.now();
	const rngV = mulberry32( 4242 );
	const veg: number[] = [];
	scatterTop( islandSDF, b.x0 - 0.6, b.x1 + 0.6, b.z0 - 0.6, b.z1 + 0.6, 0.235, ISLAND_TOP, rngV, veg, ( x, z ) => fp.dist( x, z ), 0 );
	stacks.forEach( ( s, i ) => {

		const R = s.r * 1.5;
		scatterTop( stackSDFs[ i ], s.x - R, s.x + R, s.z - R, s.z + R, 0.2, s.h, rngV, veg, ( x, z ) => Math.hypot( x - s.x, z - s.z ) - s.r * 0.95, 1 + i );

	} );
	const vegetation = new Float32Array( veg );
	// ivy curtains hanging from the island's rim down its faces
	const ivyPts: number[] = [];
	hangIvy( islandSDF, veg, rngV, ivyPts );
	const ivy = new Float32Array( ivyPts );
	transfer.push( vegetation.buffer, ivy.buffer );
	mark( 'vegetation', t );

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

	transfer.push( sb.buffer );
	mark( 'seabed', t );

	// --- shoreline: horizontal distance (m) from open water to the nearest solid at sea level,
	// signed (negative inside rock). Feeds shore foam, wave damping and wet rock.
	t = performance.now();
	const allSolid = ( x: number, y: number, z: number ) => {

		let d = islandSDF( x, y, z );
		for ( let i = 0; i < stacks.length; i ++ ) {

			const s = stacks[ i ];
			if ( Math.abs( x - s.x ) < 5 && Math.abs( z - s.z ) < 5 ) d = Math.min( d, stackSDFs[ i ]( x, y, z ) );

		}

		for ( let i = 0; i < rocks.length; i ++ ) {

			const r = rocks[ i ];
			if ( Math.abs( x - r.x ) < r.s * 2.5 + 0.5 && Math.abs( z - r.z ) < r.s * 2.5 + 0.5 ) d = Math.min( d, rockSDFs[ i ]( x, y, z ) );

		}

		return d;

	};

	const shore = Field2D.covering( - shoreSize / 2, shoreSize / 2, - shoreSize / 2, shoreSize / 2, shoreCell )
		.fill( ( x: number, z: number ) => allSolid( x, 0.0, z ) )
		.signedDistance();
	transfer.push( shore.data.buffer );
	// Match the full shoreline's world bounds exactly at half resolution. A separate island
	// distance prevents local breaking surf from becoming a bright collar on scattered rocks.
	const islandRes = Math.ceil( shore.nx / 2 );
	const islandShore = new Field2D( shore.x0, shore.z0, islandRes, islandRes, shore.nx * shore.cell / islandRes )
		.fill( ( x: number, z: number ) => islandSDF( x, 0, z ) )
		.signedDistance();
	transfer.push( islandShore.data.buffer );
	mark( 'shore', t );

	timings.total = Math.round( performance.now() - t0 );

	const result: WorldData = {
		meshes,
		stacks,
		rocks,
		seabed: { positions: sb, res: n, size: seabedSize },
		vegetation,
		ivy,
		shore: { data: shore.data, nx: shore.nx, nz: shore.nz, x0: shore.x0, z0: shore.z0, cell: shore.cell },
		islandShore: { data: islandShore.data, nx: islandShore.nx, nz: islandShore.nz, x0: islandShore.x0, z0: islandShore.z0, cell: islandShore.cell },
		timings,
	};
	self.postMessage( result, { transfer } );

};

// jittered grid over [x0, x1] x [z0, z1]; for each sample march down to the surface and keep it
// if it faces up enough to hold turf (the rounded rim included). Appends x, y, z, nx, ny, nz, rim
// (signed distance to the shape's edge, negative inside), kind (0 island, 1 + i stack i).
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

// Curtains of ivy hanging from the rim: a few strands side by side, each followed down the rock
// by marching in from outside along the rim's outward direction, so the leaves hug the faces.
// Appends x, y, z, outward x, outward z, t (0 at the rim, 1 at the strand's tip).
function hangIvy( sdf: SDF, veg: ArrayLike<number>, rng: Rng, out: number[] ): void {

	const n = veg.length / 8;
	const curtains: number[][] = [];
	for ( let i = 0; i < n; i ++ ) {

		const k = i * 8;
		if ( veg[ k + 7 ] !== 0 || veg[ k + 6 ] < - 0.45 || rng() > 0.1 ) continue;
		const x = veg[ k ], y = veg[ k + 1 ], z = veg[ k + 2 ];
		let ox = veg[ k + 3 ], oz = veg[ k + 5 ];
		const ol = Math.hypot( ox, oz );
		if ( ol < 0.15 || curtains.some( ( c ) => Math.hypot( c[ 0 ] - x, c[ 1 ] - z ) < 1.4 ) ) continue;
		curtains.push( [ x, z ] );
		ox /= ol; oz /= ol;
		const tx = - oz, tz = ox;
		const strands = 4 + Math.floor( rng() * 4 );
		const width = 0.7 + rng() * 1.0;
		const length = 0.8 + Math.pow( rng(), 0.7 ) * 2.2;
		for ( let s = 0; s < strands; s ++ ) {

			const u = ( s / ( strands - 1 ) - 0.5 ) * width + ( rng() - 0.5 ) * 0.15;
			const L = length * ( 0.5 + rng() * 0.6 ) * ( 1 - Math.min( Math.abs( u ) / width, 0.5 ) * 0.8 );
			const sx = x + tx * u, sz = z + tz * u;
			for ( let dy = - 0.05; dy < L; dy += 0.12 ) {

				const yy = y - dy;
				if ( yy < 0.35 ) break; // stays above the spray
				let px = sx + ox * 1.2, pz = sz + oz * 1.2;
				let hit = false;
				for ( let it = 0; it < 40; it ++ ) {

					const d = sdf( px, yy, pz );
					if ( d < 0.02 ) { hit = true; break; }
					const step = Math.max( d * 0.8, 0.01 );
					px -= ox * step; pz -= oz * step;
					if ( ( px - sx ) * ox + ( pz - sz ) * oz < - 1.5 ) break;

				}

				if ( ! hit ) break;
				out.push( px + ox * 0.04, yy, pz + oz * 0.04, ox, oz, dy / L );

			}

		}

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
