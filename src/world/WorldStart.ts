// The world's generation needs nothing from the page, so its workers start as the page's modules
// load: main.ts imports this module before any module that waits at the top level (the quality
// tier and anti-aliasing mode, post/Antialiasing.ts, ask the GPU adapter first), so they run while
// the adapter, renderer, sky, textures and frame graph are set up; main.ts awaits the result. The
// world worker's last result comes from IndexedDB while the generator and its options are
// unchanged (WorldCache.ts); ?worldCache=off generates it regardless, as on a first visit. A
// browser without WebGPU stops at the renderer, so it starts no workers.
import { loadWorld, type LoadedWorld } from './World.ts';

const cache = ! new URLSearchParams( location.search ).getAll( 'worldCache' ).some( ( v ) => v === 'off' || v === '0' );
export const worldJob: Promise<LoadedWorld> = 'gpu' in navigator ? loadWorld( {}, { cache } ) : new Promise( () => undefined );
worldJob.catch( () => undefined ); // reported where it is awaited, under main.ts's world section
