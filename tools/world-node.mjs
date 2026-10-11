// Helpers for running the world generators in plain node (CPU only, with TypeScript stripping):
// the page's world built serially, hashes of generated buffers and the weld that tells whether
// meshes close up (tools/verify-world-chunks.mjs).
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildLand } from '../src/world/chunkWorker.ts';
import { mergeChunks } from '../src/world/ChunkMerge.ts';
import { buildChunk, landField, landWindow } from '../src/world/Chunks.ts';
import { LandLattice } from '../src/world/IslandGrowth.ts';

// The page's world (src/world/WorldChunks.ts) without its workers and cache: the land, its field
// and every chunk built here one after another, then merged as the page merges them. The result
// is the page's WorldData bit for bit (each chunk is a function of its window, the merge of the
// chunks' order), with the stages' times summed over the chunks.
export function generateWorld( { worldSeed = 1, step = 0, contactOcclusion = true } = {} ) {

	const t0 = performance.now();
	const land = buildLand( worldSeed, step );
	const lattice = LandLattice.fromBytes( land.land );
	const field = landField( lattice );
	const chunks = [], timings = {};
	for ( let k = 0; k < land.chunks.length; k += 2 ) {

		const ci = land.chunks[ k ], cj = land.chunks[ k + 1 ];
		const chunk = buildChunk( landWindow( field, ci, cj ), lattice, ci, cj, { version: step, contactOcclusion } );
		for ( const [ stage, ms ] of Object.entries( chunk.timings ) ) timings[ stage ] = ( timings[ stage ] ?? 0 ) + ms;
		chunks.push( chunk );

	}
	const world = mergeChunks( land, chunks );
	world.timings = { ...timings, merge: world.timings.merge, total: Math.round( performance.now() - t0 ) };
	return world;

}

// SHA-256 over a generated object: typed arrays by their raw bytes, everything else by value, keys in
// sorted order so the hash does not depend on construction order; `timings` are left out.
export function hashBuffers( obj ) {

	const hash = createHash( 'sha256' );
	const visit = ( value ) => {

		if ( ArrayBuffer.isView( value ) ) {

			hash.update( `${ value.constructor.name }:${ value.length }:` );
			hash.update( new Uint8Array( value.buffer, value.byteOffset, value.byteLength ) );

		} else if ( Array.isArray( value ) ) {

			hash.update( `[${ value.length }:` );
			for ( const item of value ) visit( item );
			hash.update( ']' );

		} else if ( value !== null && typeof value === 'object' ) {

			hash.update( '{' );
			for ( const key of Object.keys( value ).sort() ) {

				if ( key === 'timings' ) continue;
				hash.update( `${ JSON.stringify( key ) }:` );
				visit( value[ key ] );

			}
			hash.update( '}' );

		} else {

			hash.update( `${ typeof value }:${ String( value ) };` );

		}

	};
	visit( obj );
	return hash.digest( 'hex' );

}

// The key of a vertex position by the exact bits of its three floats: meshes that meet are welded
// where their vertices are bit-identical, as chunks of one surface must be.
export function positionKey( positions, v ) {

	const bits = new Uint32Array( positions.buffer, positions.byteOffset, positions.length );
	return `${ bits[ v * 3 ] },${ bits[ v * 3 + 1 ] },${ bits[ v * 3 + 2 ] }`;

}

// Welds meshes ({ positions, indices }) by `positionKey` and counts how many triangles use each
// undirected edge: `boundary` edges have one (a crack or a hole), `nonManifold` three or more,
// `flipped` two that run it the same way (an inconsistent winding); `degenerate` triangles repeat a
// welded vertex and are skipped. `open( p, q )`, given a boundary edge's two positions ([ x, y, z ]),
// says whether the edge is open by design; those are counted as `open`, not `boundary`.
export function meshClosure( meshes, { open = () => false } = {} ) {

	const ids = new Map(), at = [];
	const edges = new Map();
	let triangles = 0, degenerate = 0;
	for ( const m of meshes ) {

		const id = new Uint32Array( m.positions.length / 3 );
		for ( let v = 0; v < id.length; v ++ ) {

			const key = positionKey( m.positions, v );
			let w = ids.get( key );
			if ( w === undefined ) {

				w = ids.size;
				ids.set( key, w );
				at.push( m.positions[ v * 3 ], m.positions[ v * 3 + 1 ], m.positions[ v * 3 + 2 ] );

			}
			id[ v ] = w;

		}
		for ( let t = 0; t < m.indices.length; t += 3 ) {

			const a = id[ m.indices[ t ] ], b = id[ m.indices[ t + 1 ] ], c = id[ m.indices[ t + 2 ] ];
			triangles ++;
			if ( a === b || b === c || c === a ) { degenerate ++; continue; }
			for ( const [ p, q ] of [ [ a, b ], [ b, c ], [ c, a ] ] ) {

				// forward and reverse uses, packed in one number per edge
				const key = p < q ? p * 0x4000000 + q : q * 0x4000000 + p;
				edges.set( key, ( edges.get( key ) ?? 0 ) + ( p < q ? 1 : 0x10000 ) );

			}

		}

	}
	let boundary = 0, openEdges = 0, nonManifold = 0, flipped = 0;
	for ( const [ key, uses ] of edges ) {

		const forward = uses & 0xffff, reverse = uses >>> 16, n = forward + reverse;
		if ( n === 1 ) {

			const p = Math.floor( key / 0x4000000 ), q = key % 0x4000000;
			if ( open( at.slice( p * 3, p * 3 + 3 ), at.slice( q * 3, q * 3 + 3 ) ) ) openEdges ++; else boundary ++;

		} else if ( n > 2 ) nonManifold ++;
		else if ( forward !== 1 ) flipped ++;

	}
	return { welded: ids.size, triangles, degenerate, boundary, open: openEdges, nonManifold, flipped };

}
