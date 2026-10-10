// Helpers for running the world generators in plain node (CPU only, with TypeScript stripping):
// the worker shim, hashes of generated buffers and the sub-box locality check that
// tools/verify-world-local.mjs runs for each case in tools/world-local/.
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

// A copy of a flat record array (`stride` values per record) with its records in lexicographic order
// of their values, the position first: two builds that make the same records in a different order
// then compare equal.
export function sortedByPosition( records, stride ) {

	return gather( records, stride, recordOrder( [ { records, stride } ] ) );

}

// The order of the records of parallel fields (each `stride` values per record, equal counts),
// compared value by value through the fields in turn, so one permutation sorts them all. Values are
// compared as numbers, ties keep their order.
function recordOrder( fields ) {

	const count = fields[ 0 ].records.length / fields[ 0 ].stride;
	for ( const { name = '', records, stride } of fields ) {

		assert.equal( records.length, count * stride, `Field ${ name } does not hold ${ count } records of ${ stride }.` );

	}
	const order = Array.from( { length: count }, ( _, i ) => i );
	order.sort( ( a, b ) => {

		for ( const { records, stride } of fields ) for ( let j = 0; j < stride; j ++ ) {

			const d = records[ a * stride + j ] - records[ b * stride + j ];
			if ( d !== 0 ) return d;

		}
		return 0;

	} );
	return order;

}

function gather( records, stride, order ) {

	const sorted = new records.constructor( records.length );
	for ( let i = 0; i < order.length; i ++ ) sorted.set( records.subarray( order[ i ] * stride, ( order[ i ] + 1 ) * stride ), i * stride );
	return sorted;

}

// Locality check: `build( box )` must make the records whose position lies in the half-open box
// `{ x0, z0, x1, z1 }` from that box alone. Build `box` whole and as split x split sub-boxes (each
// call sees only its own box) and compare the whole against the union as position-sorted record
// sets, bit for bit. `build` returns one record set as parallel fields, `{ field: typedArray }` (one
// value per record) or `{ field: { records, stride } }`, every field with the same record count and
// the position the first field. All fields are sorted by one permutation (the position first, then
// the other fields), so an attribute that lands on another record is a mismatch. Prints the first
// mismatch per field and returns whether everything matched.
export async function subBoxCheck( { build, box, split = 2, label = '' } ) {

	const fields = ( result ) => Object.entries( result ).map( ( [ name, value ] ) =>
		ArrayBuffer.isView( value ) ? { name, records: value, stride: 1 } : { name, ...value } );
	const whole = fields( await build( box ) );
	const parts = [];
	for ( let j = 0; j < split; j ++ ) for ( let i = 0; i < split; i ++ ) {

		const x = ( k ) => k === split ? box.x1 : box.x0 + ( box.x1 - box.x0 ) * k / split;
		const z = ( k ) => k === split ? box.z1 : box.z0 + ( box.z1 - box.z0 ) * k / split;
		parts.push( fields( await build( { x0: x( i ), z0: z( j ), x1: x( i + 1 ), z1: z( j + 1 ) } ) ) );

	}
	const names = whole.map( ( { name } ) => name ).join( ', ' );
	for ( const part of parts ) {

		const partNames = part.map( ( { name } ) => name ).join( ', ' );
		if ( partNames !== names ) {

			console.log( `${ label }fields differ: whole box [${ names }], a sub-box [${ partNames }]` );
			return false;

		}

	}
	const union = whole.map( ( { name, records, stride }, f ) => {

		const pieces = parts.map( ( part ) => part[ f ].records );
		const joined = new records.constructor( pieces.reduce( ( n, piece ) => n + piece.length, 0 ) );
		let offset = 0;
		for ( const piece of pieces ) {

			joined.set( piece, offset );
			offset += piece.length;

		}
		return { name, records: joined, stride };

	} );
	const wholeOrder = recordOrder( whole ), unionOrder = recordOrder( union );
	if ( wholeOrder.length !== unionOrder.length ) {

		console.log( `${ label }whole box has ${ wholeOrder.length } records, sub-boxes ${ unionOrder.length }` );
		return false;

	}
	let ok = true;
	for ( let f = 0; f < whole.length; f ++ ) {

		const { name, stride } = whole[ f ];
		const mismatch = compareRecords( gather( whole[ f ].records, stride, wholeOrder ), gather( union[ f ].records, stride, unionOrder ), stride );
		if ( mismatch ) {

			ok = false;
			console.log( `${ label }${ name }: ${ mismatch }` );

		}

	}
	return ok;

}

function compareRecords( a, b, stride ) {

	// Bitwise: view floats as integers, so -0 against 0 and differing NaNs count too.
	const bits = ( v ) => v instanceof Float64Array ? new BigUint64Array( v.buffer, v.byteOffset, v.length )
		: v instanceof Float32Array ? new Uint32Array( v.buffer, v.byteOffset, v.length )
			: v instanceof Float16Array ? new Uint16Array( v.buffer, v.byteOffset, v.length ) : v;
	const ba = bits( a ), bb = bits( b );
	let first = - 1, count = 0, largest = 0;
	for ( let i = 0; i < a.length; i ++ ) {

		if ( ba[ i ] === bb[ i ] ) continue;
		if ( first < 0 ) first = i;
		count ++;
		const d = Math.abs( Number( a[ i ] ) - Number( b[ i ] ) );
		if ( ! ( d <= largest ) ) largest = d;

	}
	if ( first < 0 ) return null;
	const record = Math.floor( first / stride );
	return `${ count } values differ; first at record ${ record } (value ${ first % stride }): ` +
		`whole ${ a[ first ] }, sub-boxes ${ b[ first ] }; largest difference ${ largest }`;

}
