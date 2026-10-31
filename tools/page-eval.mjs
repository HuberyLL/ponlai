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
// the tool's --timeout by default, the time spent giving the GPU slot up not counted), `pipelines` (which pipelines an action built, tools/
// pipeline-trace.mjs: `const m = pipelines.mark()` installs the tracer on first use, and
// `pipelines.since( m )` lists every pipeline created after the mark with its kind, label, material,
// object, target, frame and the app's stack; pipelines created before the first mark are not listed).
// Value. Serialised in the page: cycles become "[cycle]", functions "[function]", bigints strings,
// typed arrays plain arrays (the first 64 entries), three's vectors, colours and matrices their
// `toArray()`, undefined null.
// Giving the GPU slot up (`slotBinding`, probe.mjs's shared hold only): while the page's frame loop
// is stopped (`P.loop.running` false), `until` and `sleep` call that binding (page.exposeFunction)
// at most once a second; node gives its shared slot up there if a request ranked before its next
// one waits, and resolves only once it holds the slot again. So a long wait on CPU work (worker
// generation with the loop stopped) does not keep an exclusive run waiting, and the eval's next line
// never renders without the slot. `frames` never offers it (it waits for rendering). capture.mjs
// passes no binding: its shots are short and leased already.
import { readFileSync } from 'node:fs';
import { installScript } from './pipeline-trace.mjs';

// (installed in the page on first use only: a probe that never asks pays nothing)
const TRACE = installScript();

/** An `--eval` argument's js: `@file` reads the file, anything else is the js itself. */
export const evalSource = ( text ) => text.startsWith( '@' ) ? readFileSync( text.slice( 1 ), 'utf8' ) : text;

/** Runs `js` in the page with the shared scope (see the header) and returns its value, serialised
 * in the page. `mode` 'until' polls it until truthy and returns `{ ms, frames }` instead. Rejects
 * when the js throws or an `until` times out (`timeout` ms). */
export function runInPage( page, js, { mode = 'eval', timeout = 60000, slotBinding = null } = {} ) {

	return page.evaluate( async ( { js, mode, timeout, trace, slotBinding } ) => {

		const frameNow = () => window.__PONLAI__?.renderer.info.frame ?? window.__THREE_GAME_DIAGNOSTICS__?.frame ?? 0;
		const pause = ( ms ) => new Promise( ( resolve ) => setTimeout( resolve, ms ) );
		// a frame, or 100 ms when the loop stands (rAF still fires, but no frame is rendered)
		const tick = () => new Promise( ( resolve ) => { const t = setTimeout( resolve, 100 ); requestAnimationFrame( () => { clearTimeout( t ); resolve(); } ); } );
		// Offers the GPU slot to node while the loop stands (see the header): resolves once node holds
		// it again, with the time it was given up (0: kept). Once a second, since each offer reads the
		// lock's queue.
		const giveUp = slotBinding ? window[ slotBinding ] : null;
		let offered = - Infinity;
		const offer = async () => {

			if ( ! giveUp || window.__PONLAI__?.loop?.running !== false || performance.now() - offered < 1000 ) return 0;
			const ms = await giveUp();
			offered = performance.now();
			return ms;

		};
		const sleep = async ( ms ) => {

			if ( ! giveUp ) return pause( ms );
			const end = performance.now() + ms;
			for ( let left = ms; left > 0; left = end - performance.now() ) {

				await offer();
				await pause( Math.min( left, 100 ) );

			}

		};
		const until = async ( fn, ms = timeout ) => {

			let deadline = performance.now() + ms;
			for ( ;; ) {

				const v = await fn();
				if ( v ) return v;
				if ( performance.now() > deadline ) throw new Error( `until: not true within ${ ms } ms` );
				// a wait for the slot is the queue's time, not the page's
				deadline += await offer();
				await tick();

			}

		};
		const tracer = () => window.__pipelineTrace ?? ( 0, eval )( trace );
		const pipelines = { mark: () => tracer().mark(), since: ( mark ) => tracer().since( mark ) };
		const frames = ( n ) => { const target = frameNow() + n; return until( () => frameNow() >= target ); };
		// an expression, else statements; a function value is called (the test parses as an async
		// function, so an expression with `await` is still an expression)
		const AsyncFunction = ( async () => {} ).constructor;
		let body;
		try { new AsyncFunction( `return (${ js }\n)` ); body = `return (${ js }\n);`; } catch { body = js; }
		const fn = new AsyncFunction( 'P', 'D', 'frames', 'sleep', 'until', 'pipelines', body );
		const value = async () => {

			const v = await fn( window.__PONLAI__, window.__THREE_GAME_DIAGNOSTICS__, frames, sleep, until, pipelines );
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

	}, { js, mode, timeout, trace: TRACE, slotBinding } ).then( ( text ) => text === undefined ? undefined : JSON.parse( text ) );

}
