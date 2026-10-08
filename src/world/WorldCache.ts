// A cache of the generated world in IndexedDB, so a repeat visit skips generating it. The world
// worker reads and writes it (worldWorker.ts), off the main thread. The key (World.ts's
// worldCacheKey) changes whenever the generator could build something different: the hash of
// every source file the worker imports (this one included), its options, a format version, and
// the browser (its Math functions could differ between engines). One world is kept: storing a
// new one drops the others. The world is stored as the worker posts it (structured clone keeps
// every typed array bit for bit), before the page bakes anything into it. Any failure of the
// store (a private window, a full quota, blocked site data) falls back to generating.

const DB = 'soomi-world-cache';
const STORE = 'worlds';

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

				return await request( db.transaction( STORE, 'readonly' ).objectStore( STORE ).get( key ) ) as T | undefined;

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
				store.put( data, key );
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
