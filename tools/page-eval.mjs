// The page-side evaluation that tools/probe.mjs and tools/capture.mjs share, so an `--eval` means
// the same in both: the same forms, the same scope, the same value in the JSON. capture's `--eval`
// used to be Playwright's own string evaluation: inline js only (agents passed `$(cat file)`), no
// `until`, so eval scripts carried polling loops of their own, and its value was dropped.
//
// Forms. `js` is an expression (`D.timings`), a function (`async () => { ... }`, called), or
// statements with a `return`; `await` works in all three. `@file` reads it from a file
// (`evalSource`).
// Scope. `P` = `window.__PONLAI__`, `D` = `window.__THREE_GAME_DIAGNOSTICS__` as the step starts
// (the page rebuilds that object every 30 frames: most of its counters lag by up to 30 frames,
// `D.frame` is the frame it was built on; `settled`, `settle` and `taa` are current every frame;
// read live counters from `P`, such as `P.renderer.info.frame`), `frames( n )` (resolves after n
// rendered frames), `sleep( ms )`, `until( fn, timeoutMs )` (resolves with fn's first truthy value,
// checked every rendered frame, or every 100 ms while the loop is stopped; rejects after timeoutMs,
// the tool's --timeout by default).
// Value. Serialised in the page: cycles become "[cycle]", functions "[function]", bigints strings,
// typed arrays plain arrays (the first 64 entries), three's vectors, colours and matrices their
// `toArray()`, undefined null.
import { readFileSync } from 'node:fs';

/** An `--eval` argument's js: `@file` reads the file, anything else is the js itself. */
export const evalSource = ( text ) => text.startsWith( '@' ) ? readFileSync( text.slice( 1 ), 'utf8' ) : text;

/** Runs `js` in the page with the shared scope (see the header) and returns its value, serialised
 * in the page. `mode` 'until' polls it until truthy and returns `{ ms, frames }` instead. Rejects
 * when the js throws or an `until` times out (`timeout` ms). */
export function runInPage( page, js, { mode = 'eval', timeout = 60000 } = {} ) {

	return page.evaluate( async ( { js, mode, timeout } ) => {

		const frameNow = () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0;
		const sleep = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
		// a frame, or 100 ms when the loop stands (rAF still fires, but no frame is rendered)
		const tick = () => new Promise( ( resolve ) => { const t = setTimeout( resolve, 100 ); requestAnimationFrame( () => { clearTimeout( t ); resolve(); } ); } );
		const until = async ( fn, ms = timeout ) => {

			const deadline = performance.now() + ms;
			for ( ;; ) {

				const v = await fn();
				if ( v ) return v;
				if ( performance.now() > deadline ) throw new Error( `until: not true within ${ ms } ms` );
				await tick();

			}

		};
		const frames = ( n ) => { const target = frameNow() + n; return until( () => frameNow() >= target ); };
		// an expression, else statements; a function value is called
		let body;
		try { new Function( `return (${ js }\n)` ); body = `return (${ js }\n);`; } catch { body = js; }
		const AsyncFunction = ( async () => {} ).constructor;
		const fn = new AsyncFunction( 'P', 'D', 'frames', 'sleep', 'until', body );
		const value = async () => {

			const v = await fn( window.__PONLAI__, window.__THREE_GAME_DIAGNOSTICS__, frames, sleep, until );
			return typeof v === 'function' ? await v() : v;

		};
		const serialise = ( v ) => {

			const seen = new WeakSet();
			return JSON.stringify( v, function ( key, x ) {

				if ( typeof x === 'function' ) return '[function]';
				if ( typeof x === 'bigint' ) return String( x );
				if ( x === undefined && key === '' ) return null;
				if ( x && typeof x === 'object' ) {

					if ( ArrayBuffer.isView( x ) ) return Array.from( x.length > 64 ? x.subarray( 0, 64 ) : x );
					if ( ( x.isVector2 || x.isVector3 || x.isVector4 || x.isColor || x.isQuaternion || x.isMatrix3 || x.isMatrix4 || x.isEuler ) && x.toArray ) return x.toArray();
					if ( seen.has( x ) ) return '[cycle]';
					seen.add( x );

				}
				return x;

			} );

		};
		if ( mode === 'eval' ) return serialise( await value() );
		const from = frameNow(), start = performance.now();
		await until( value );
		return JSON.stringify( { ms: Math.round( performance.now() - start ), frames: frameNow() - from } );

	}, { js, mode, timeout } ).then( ( text ) => text === undefined ? undefined : JSON.parse( text ) );

}
