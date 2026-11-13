// A cache of the world's chunks in IndexedDB, read and written by the chunk workers.
//
// A cache of the world's chunks in IndexedDB, so a repeat visit, or a land that grew by a piece,
// skips generating every chunk the change left as it was. The chunk workers read and write it
// (chunkWorker.ts), never the main thread. One record per chunk in the object store `chunks`,
// under the key WorldChunks.ts makes: a format version, the generator's hash, the options, the
// browser (its Math functions could differ between engines), the chunk and the growth steps whose
// pieces lie in its window (so the land it reads). The land of a seed and step has a record of its
// own there too. A chunk is stored as the worker posts it (structured clone keeps every typed array
// bit for bit), before the page merges anything.
//
// One generator is kept: the `meta` store holds the identity of the generator that wrote the
// chunks (its hash and the browser, both of which the keys name), and opening the cache with
// another identity clears them (a changed generator, or a browser update, would never read them
// again). Every worker checks it on opening, in one transaction with the clearing, so the first
// to open clears and the others find the new identity. Any failure (a private window, a full quota,
// blocked site data) falls back to generating: the reader sees a miss, a failed write is dropped.
//
// Reads: the same transaction lists the store's keys, and a read of a key not in that list misses
// at once, without a request. A request would wait: IndexedDB starts a transaction only after every
// overlapping read-write transaction created before it, from any connection, has finished, and a
// chunk's write (0.5-2.5 MB) takes up to seconds to land. On a cold load the chunks are looked up
// while the land field is built and again once it has come (WorldChunks.ts), and those second
// lookups queued behind the other workers' writes: the pool all but serialised on the store, and the
// load took three to four times as long as one without the cache. A key written after the listing
// (another tab) reads as a miss and is built again; one deleted since (eviction) reads undefined, a
// miss too. Writes keep the default durability: 'relaxed' measured no faster here.
//
// Eviction: every land version a page loads adds its land and chunk records (some 35 chunks, tens
// of MB), and a game that grows step by step would pile them up to gigabytes. After a load the page
// sends one `keep` job with the keys of the version it loaded (WorldChunks.ts), and the store keeps
// the records of the two most recently loaded versions only: the `meta` store's `recent` lists their
// keys, newest first; `keep` puts this load's keys first, keeps the most recent other version (a
// version is named by its first key, the land's) and deletes every record in neither, in one
// transaction. Only keys are listed (a few hundred at most), never the records. The two versions are
// the one shown and the one before it, so stepping back a step, or a reload, still hits (the
// growth makes them the current and the pending version). Another tab that loads at the same time
// can have its records deleted: that costs it a miss on its next load, never a wrong world.

const DB = 'ponlai-world-cache';
// version 2: the chunk stores replace version 1's one-world store `worlds`
const VERSION = 2;
const CHUNKS = 'chunks';
const META = 'meta';
const GENERATOR = 'generator';
// the keys of the most recently loaded land versions, newest first
const RECENT = 'recent';
// how many land versions the cache keeps
const VERSIONS = 2;

function request<T>( r: IDBRequest<T> ): Promise<T> {

	return new Promise( ( resolve, reject ) => {

		r.onsuccess = () => resolve( r.result );
		r.onerror = () => reject( r.error );

	} );

}

function done( tx: IDBTransaction ): Promise<void> {

	return new Promise( ( resolve, reject ) => {

		tx.oncomplete = () => resolve();
		tx.onerror = tx.onabort = () => reject( tx.error );

	} );

}

function open(): Promise<IDBDatabase> {

	const r = indexedDB.open( DB, VERSION );
	r.onupgradeneeded = () => {

		const db = r.result;
		for ( const name of [ ...db.objectStoreNames ] ) db.deleteObjectStore( name );
		db.createObjectStore( CHUNKS );
		db.createObjectStore( META );

	};
	// a tab still holding the older version open would keep this one waiting (its workers too):
	// generate instead
	const opened = request( r );
	return new Promise( ( resolve, reject ) => {

		r.onblocked = () => reject( new Error( 'world cache blocked by another tab' ) );
		opened.then( resolve, reject );

	} );

}

export interface ChunkStore {
	// the record under `key`, or undefined; undefined at once for a key the store did not hold when
	// it was opened
	read<T>( key: string ): Promise<T | undefined>;
	// stores `value` under `key`; it is cloned before this returns, so its buffers may be
	// transferred right after. The promise settles once the store has written it (the worker must
	// live until then), and never rejects.
	write( key: string, value: unknown ): Promise<void>;
	// records that a land version with the records `keys` (its land's first) was loaded, and deletes
	// the records of every version but the VERSIONS most recently loaded. Never rejects.
	keep( keys: string[] ): Promise<void>;
	close(): void;
}

/** The browser the cache's records were made in, which their keys and the store's identity name
 * (its Math functions could differ between engines). */
export const cacheBrowser = (): string => navigator.userAgent;

/** The chunk cache of the generator `generator` (its records of any other generator cleared), or
 * null when IndexedDB is unavailable. */
export async function openChunkStore( generator: string ): Promise<ChunkStore | null> {

	if ( typeof indexedDB === 'undefined' ) return null;
	let db: IDBDatabase;
	// the keys the store held on opening: a read of any other key misses without a request
	let present: Set<IDBValidKey>;
	try {

		db = await open();
		// another page that opens a newer version must not wait for this one
		db.onversionchange = () => db.close();
		const tx = db.transaction( [ META, CHUNKS ], 'readwrite' );
		const meta = tx.objectStore( META ), chunks = tx.objectStore( CHUNKS ), identity = generator + '\n' + cacheBrowser();
		if ( await request( meta.get( GENERATOR ) ) !== identity ) {

			chunks.clear();
			meta.put( identity, GENERATOR );
			present = new Set();

		} else {

			present = new Set( await request( chunks.getAllKeys() ) );

		}
		await done( tx );

	} catch ( error ) {

		console.warn( 'world cache unavailable:', error );
		return null;

	}
	return {
		async read<T>( key: string ) {

			// a request would wait for every write queued before it, of any worker
			if ( ! present.has( key ) ) return undefined;
			try {

				return await request( db.transaction( CHUNKS, 'readonly' ).objectStore( CHUNKS ).get( key ) ) as T | undefined;

			} catch ( error ) {

				console.warn( 'world cache: reading failed', error );
				return undefined;

			}

		},
		write( key, value ) {

			try {

				const tx = db.transaction( CHUNKS, 'readwrite' );
				tx.objectStore( CHUNKS ).put( value, key );
				return done( tx ).catch( ( error ) => console.warn( 'world cache: storing failed', error ) );

			} catch ( error ) {

				console.warn( 'world cache: storing failed', error );
				return Promise.resolve();

			}

		},
		async keep( keys ) {

			try {

				const tx = db.transaction( [ META, CHUNKS ], 'readwrite' );
				const meta = tx.objectStore( META ), chunks = tx.objectStore( CHUNKS );
				const recent = ( await request( meta.get( RECENT ) ) as string[][] | undefined ) ?? [];
				// a reload of the newest version must not push the one before it out
				const kept = [ keys, ...recent.filter( ( version ) => version[ 0 ] !== keys[ 0 ] ) ].slice( 0, VERSIONS );
				meta.put( kept, RECENT );
				const live = new Set( kept.flat() );
				for ( const key of await request( chunks.getAllKeys() ) ) {

					if ( ! live.has( key as string ) ) chunks.delete( key );

				}
				await done( tx );

			} catch ( error ) {

				console.warn( 'world cache: evicting failed', error );

			}

		},
		close() {

			db.close();

		},
	};

}
