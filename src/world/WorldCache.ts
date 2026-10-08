import { WORLD_GENERATOR_HASH } from 'virtual:world-generator';

// A cache of the world worker's result in IndexedDB, so a page load can skip the ten seconds of
// generation. The key changes whenever the generator could build something different: the hash
// of every source file the worker imports (WORLD_GENERATOR_HASH, see vite.config.ts), its
// options, a format version, and the browser (its Math functions could differ between engines).
// One world is kept: storing a new one drops the others. The data is stored as the worker posts
// it (structured clone keeps every typed array bit for bit), before the page bakes anything into
// it. Any failure of the store falls back to generating. Debug only for now (?worldCache);
// nothing here depends on the debug build, so it could become the shipped startup path.

const DB = 'soomi-world-cache';
const STORE = 'worlds';
const FORMAT = 1;

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

export function worldCacheKey( options: unknown ): string {

	return JSON.stringify( [ FORMAT, WORLD_GENERATOR_HASH, options ?? {}, navigator.userAgent ] );

}

export interface CachedWorld<T> {
	data: T;
	// 'hit': loaded from the cache; 'miss': generated and stored; 'error': generated, the store failed
	cache: 'hit' | 'miss' | 'error';
	// time spent reading the cache (a hit) or handing the result to it (a miss)
	ms: number;
}

/** The world for `options`, from the cache when it holds one, else from `generate()` (then stored). */
export async function cachedWorld<T>( options: unknown, generate: () => Promise<T> ): Promise<CachedWorld<T>> {

	const key = worldCacheKey( options );
	let db: IDBDatabase | null = null;
	const t0 = performance.now();
	try {

		db = await open();
		const hit = await request( db.transaction( STORE, 'readonly' ).objectStore( STORE ).get( key ) ) as T | undefined;
		if ( hit !== undefined ) {

			db.close();
			return { data: hit, cache: 'hit', ms: performance.now() - t0 };

		}

	} catch ( error ) {

		console.warn( 'world cache unavailable:', error );

	}
	const data = await generate();
	if ( ! db ) return { data, cache: 'error', ms: 0 };
	const t1 = performance.now();
	try {

		// put() clones the value now, so the caller may change it as soon as this returns
		const tx = db.transaction( STORE, 'readwrite' );
		const store = tx.objectStore( STORE );
		store.clear();
		store.put( data, key );
		const closing = db;
		tx.oncomplete = () => closing.close();
		tx.onerror = tx.onabort = () => { console.warn( 'world cache: storing failed', tx.error ); closing.close(); };
		return { data, cache: 'miss', ms: performance.now() - t1 };

	} catch ( error ) {

		console.warn( 'world cache: storing failed', error );
		db.close();
		return { data, cache: 'error', ms: performance.now() - t1 };

	}

}
