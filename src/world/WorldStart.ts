// The world's generation needs nothing from the page, so its workers start as the page's modules
// load: main.ts imports this module before any module that waits at the top level (the quality
// tier and anti-aliasing mode, post/Antialiasing.ts, ask the GPU adapter first), so they run while
// the adapter, renderer, sky, textures and frame graph are set up; main.ts awaits the result. The
// world worker's last result comes from IndexedDB while the generator and its options are
// unchanged (WorldCache.ts); ?worldCache=off generates it regardless, as on a first visit. A
// browser without WebGPU stops at the renderer, so it starts no workers.
//
// Debug pages (main.ts's DEBUG: the dev server, ?debug, ?profile) say when the world is in, as
// `window.__PONLAI_WORLD__` (`ready`, and `ms`, the page's clock then), set as this module runs: the
// capture tool loads a page with its GPU use held back and without a GPU slot, and takes the slot
// only once the world is generated (tools/capture.mjs, "The slot after the world").
import { loadWorld, type LoadedWorld } from './World.ts';

const params = new URLSearchParams( location.search );
const cache = ! params.getAll( 'worldCache' ).some( ( v ) => v === 'off' || v === '0' );
export const worldJob: Promise<LoadedWorld> = 'gpu' in navigator ? loadWorld( {}, { cache } ) : new Promise( () => undefined );
worldJob.catch( () => undefined ); // reported where it is awaited, under main.ts's world section
if ( import.meta.env.DEV || params.has( 'debug' ) || params.has( 'profile' ) ) {

	const state: { ready: boolean; ms?: number } = { ready: false };
	( window as unknown as { __PONLAI_WORLD__: typeof state } ).__PONLAI_WORLD__ = state;
	// (a failed world is in too: the page goes on and reports it)
	const done = () => { state.ready = true; state.ms = performance.now(); };
	worldJob.then( done, done );

}
