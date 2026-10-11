import * as THREE from 'three/webgpu';
import { islandSurfaceHeight, ISLAND_TOP } from '../world/WorldShapes.ts';
import { S } from '../world/Chunks.ts';
import type { ShoreField, WorldData } from '../world/types.ts';

// A debug view of the world's chunks (src/world/Chunks.ts): every chunk's square drawn on the ground
// (the meadow's top, and the sea floor seen through the water) with a post at each corner, so a
// seam in the image can be told from a chunk border (GUI Ground folder, `chunkBorders` URL option).
// The cliff between the two is left out. main.ts builds it on first show, so its material's
// pipeline exists only then.

// samples along a border (m), and the lines' lift above the ground (m)
const STEP = 0.25, LIFT = 0.04;

// bilinear over the field's cell centres, the edge continued
function sample( f: ShoreField, x: number, z: number ): number {

	const fx = Math.min( Math.max( ( x - f.x0 ) / f.cell - 0.5, 0 ), f.nx - 1 ), fz = Math.min( Math.max( ( z - f.z0 ) / f.cell - 0.5, 0 ), f.nz - 1 );
	const i = Math.min( Math.floor( fx ), f.nx - 2 ), j = Math.min( Math.floor( fz ), f.nz - 2 ), u = fx - i, v = fz - j;
	const d = f.data, k = j * f.nx + i;
	return ( d[ k ] * ( 1 - u ) + d[ k + 1 ] * u ) * ( 1 - v ) + ( d[ k + f.nx ] * ( 1 - u ) + d[ k + f.nx + 1 ] * u ) * v;

}

/** Lines along the borders of the world's chunks ( `data.chunks` ), `side` metres each. */
export function buildChunkBorders( data: WorldData, side = S ): THREE.LineSegments {

	// the ground under a point: the meadow's top inside the coast, the floor outside, none on the cliff
	const ground = ( x: number, z: number ) => {

		const d = sample( data.shore, x, z );
		return d < - 0.6 ? islandSurfaceHeight( x, z ) + LIFT : d > 0.6 ? sample( data.seabedField, x, z ) + LIFT : null;

	};
	const edges = new Set<string>(), corners = new Set<string>(), points: number[] = [];
	const edge = ( x0: number, z0: number, x1: number, z1: number ) => {

		const key = `${ x0 },${ z0 },${ x1 },${ z1 }`;
		if ( edges.has( key ) ) return;
		edges.add( key );
		const n = Math.round( Math.hypot( x1 - x0, z1 - z0 ) / STEP );
		for ( let k = 0; k < n; k ++ ) {

			const xa = x0 + ( x1 - x0 ) * k / n, za = z0 + ( z1 - z0 ) * k / n, xb = x0 + ( x1 - x0 ) * ( k + 1 ) / n, zb = z0 + ( z1 - z0 ) * ( k + 1 ) / n;
			const ya = ground( xa, za ), yb = ground( xb, zb );
			if ( ya !== null && yb !== null && Math.abs( ya - yb ) < 1 ) points.push( xa, ya, za, xb, yb, zb );

		}

	};
	const { chunks } = data;
	for ( let k = 0; k < chunks.length; k += 2 ) {

		const x0 = chunks[ k ] * side, z0 = chunks[ k + 1 ] * side, x1 = x0 + side, z1 = z0 + side;
		edge( x0, z0, x1, z0 ); edge( x0, z1, x1, z1 ); edge( x0, z0, x0, z1 ); edge( x1, z0, x1, z1 );
		for ( const [ x, z ] of [ [ x0, z0 ], [ x1, z0 ], [ x0, z1 ], [ x1, z1 ] ] ) {

			if ( corners.has( `${ x },${ z }` ) ) continue;
			corners.add( `${ x },${ z }` );
			points.push( x, sample( data.seabedField, x, z ), z, x, ISLAND_TOP + 1, z );

		}

	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute( 'position', new THREE.Float32BufferAttribute( points, 3 ) );
	const material = new THREE.LineBasicNodeMaterial( { color: 0xff2a6d } );
	material.fog = false;
	const lines = new THREE.LineSegments( geometry, material );
	lines.name = 'chunk-borders';
	lines.frustumCulled = false;
	return lines;

}
