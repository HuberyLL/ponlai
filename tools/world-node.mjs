// Helpers for running the world generators in plain node (CPU only, with TypeScript stripping):
// the worker shim, hashes of generated buffers and the weld that tells whether meshes close up
// (tools/verify-world-chunks.mjs).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// worldWorker.ts is written for a Web Worker: it sets `self.onmessage` and answers with
// `self.postMessage`. Install a `self` that keeps the reply and import the worker, once per process
// (the import is cached, so a second `self` would never get an `onmessage`); every caller shares the
// returned function, which runs one job synchronously (a plain WorldOptions message replies before
// returning).
let worldWorker;
export function loadWorldWorker() {

	worldWorker ??= ( async () => {

		let reply;
		globalThis.self = { postMessage( data, { transfer } ) {

			assert.equal( new Set( transfer ).size, transfer.length, 'Every worker buffer must be transferred only once.' );
			reply = data;

		} };
		await import( '../src/world/worldWorker.ts' );
		return ( options = {} ) => {

			reply = undefined;
			self.onmessage( { data: options } );
			return reply;

		};

	} )();
	return worldWorker;

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
