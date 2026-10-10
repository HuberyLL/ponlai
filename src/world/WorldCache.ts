// A cache of the generated world in IndexedDB, so a repeat visit skips generating it. The world
// worker reads and writes it (worldWorker.ts), off the main thread. The key (World.ts's
// worldCacheKey) changes whenever the generator could build something different: the hash of
// every source file the worker imports (this one included), its options, a format version, and
// the browser (its Math functions could differ between engines). One world is kept: storing a
// new one drops the others. The world is stored as the worker posts it (structured clone keeps
// every typed array bit for bit), before the page bakes anything into it. Any failure of the
// store (a private window, a full quota, blocked site data) falls back to generating.
// Chrome refuses a single value over about 133 MB, and a grown island's world passes that from
// about 20 steps, so the world is stored in parts: its typed arrays packed into records of about
// PART_BYTES each (keyed [ key, i ]), and under the key itself the rest, each array replaced by
// its index.

const DB = 'ponlai-world-cache';
const STORE = 'worlds';
const PART_BYTES = 64 << 20;

interface Head { value: unknown; parts: number }

// marks an array's place in the head
const ARRAY = '$array';

// The value with its typed arrays replaced by { $array: index } into `arrays`.
function strip( value: unknown, arrays: ArrayBufferView[] ): unknown {

	if ( ArrayBuffer.isView( value ) ) return { [ ARRAY ]: arrays.push( value ) - 1 };
	if ( Array.isArray( value ) ) return value.map( ( v ) => strip( v, arrays ) );
	if ( value && typeof value === 'object' ) return Object.fromEntries( Object.entries( value ).map( ( [ k, v ] ) => [ k, strip( v, arrays ) ] ) );
	return value;

}

function restore( value: unknown, arrays: ArrayBufferView[] ): unknown {

	if ( Array.isArray( value ) ) return value.map( ( v ) => restore( v, arrays ) );
	if ( value && typeof value === 'object' ) {

		if ( ARRAY in value ) return arrays[ ( value as Record<string, number> )[ ARRAY ] ];
		return Object.fromEntries( Object.entries( value ).map( ( [ k, v ] ) => [ k, restore( v, arrays ) ] ) );

	}
	return value;

}

function request<T>( r: IDBRequest<T> ): Promise<T> {

	return new Promise( ( resolve, reject ) => {

		r.onsuccess = () => resolve( r.result );
		r.onerror = () => reject( r.error );

	} );

}

function open(): Promise<IDBDatabase> {

	const r = indexedDB.open( DB, 1 );
	r.onupgradeneeded = () => { r.result.createObjectStore( STORE ); };
	return request( r );

}

export interface WorldStore<T> {
	// the cached world for the key, or undefined
	read(): Promise<T | undefined>;
	// stores the world under the key in place of any other; it is cloned before this returns, so
	// its buffers may be transferred right after. The promise settles once the store has written
	// it (the worker must live until then).
	write( data: T ): Promise<void>;
	// closes the store without writing
	close(): void;
}

/** The cache's entry for `key`, or null when IndexedDB is unavailable. */
export async function openWorldStore<T>( key: string ): Promise<WorldStore<T> | null> {

	let db: IDBDatabase;
	try {

		db = await open();

	} catch ( error ) {

		console.warn( 'world cache unavailable:', error );
		return null;

	}
	return {
		async read() {

			try {

				const store = db.transaction( STORE, 'readonly' ).objectStore( STORE );
				const head = await request( store.get( key ) ) as Head | undefined;
				if ( ! head ) return undefined;
				const parts = await Promise.all( Array.from( { length: head.parts }, ( _, i ) => request( store.get( [ key, i ] ) ) as Promise<ArrayBufferView[]> ) );
				return restore( head.value, parts.flat() ) as T;

			} catch ( error ) {

				console.warn( 'world cache: reading failed', error );
				return undefined;

			}

		},
		write( data ) {

			try {

				const tx = db.transaction( STORE, 'readwrite' );
				const store = tx.objectStore( STORE );
				store.clear();
				const arrays: ArrayBufferView[] = [];
				const value = strip( data, arrays );
				let part: ArrayBufferView[] = [], bytes = 0, parts = 0;
				for ( const array of arrays ) {

					if ( bytes > 0 && bytes + array.byteLength > PART_BYTES ) {

						store.put( part, [ key, parts ++ ] );
						part = [];
						bytes = 0;

					}
					part.push( array );
					bytes += array.byteLength;

				}
				if ( part.length > 0 ) store.put( part, [ key, parts ++ ] );
				store.put( { value, parts } satisfies Head, key );
				return new Promise( ( resolve ) => {

					tx.oncomplete = () => { db.close(); resolve(); };
					tx.onerror = tx.onabort = () => { console.warn( 'world cache: storing failed', tx.error ); db.close(); resolve(); };

				} );

			} catch ( error ) {

				console.warn( 'world cache: storing failed', error );
				db.close();
				return Promise.resolve();

			}

		},
		close() {

			db.close();

		},
	};

}
