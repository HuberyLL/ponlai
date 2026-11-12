// The world's generation needs nothing from the page, so its workers start as the page's modules
// load: the page's entry calls `startWorld` (WorldBoot.ts, which main.ts imports before any module
// that waits at the top level: the quality tier and anti-aliasing mode, post/Antialiasing.ts, ask
// the GPU adapter first), so they run while the adapter, renderer, sky, textures and frame graph
// are set up; main.ts awaits the result. It
// comes in chunks (WorldChunks.ts), nearest the camera's pivot first, each from the browser's
// IndexedDB cache while the generator, its options and the land in the chunk's reach are unchanged
// (WorldCache.ts); ?worldCache=off generates every chunk regardless, as on a first visit. A
// browser without WebGPU stops at the renderer, so it starts no workers.
//
// The land's options and the framing it sets live here too, since the job asks for the camera's
// pivot as soon as the land is grown, which may be before main.ts runs. This module knows no save:
// the entry gives the pieces a resumed game's land has grown (`pieces`), which the land starts
// with unless the `grow` option says.
//
// Debug pages (main.ts's DEBUG: the dev server, ?debug, ?profile) say when the world is in, as
// `window.__PONLAI_WORLD__` (`ready`, and `ms`, the page's clock then), set as the world starts: the
// capture tool loads a page with its GPU use held back and without a GPU slot, and takes the slot
// only once the world is generated (tools/capture.mjs, "The slot after the world").
import * as THREE from 'three/webgpu';
import { loadWorld, type LoadedWorld } from './WorldChunks.ts';
import { GROWTH, type LandLattice } from './IslandGrowth.ts';
import { landArea, landCentroid } from './WorldShapes.ts';

const params = new URLSearchParams( location.search );
const intParam = ( name: string, fallback: number ) => {

	const value = Math.trunc( Number( params.get( name ) ?? fallback ) );
	return Number.isFinite( value ) ? value : fallback;

};

/** The island: the land a world seed grows in `grow` steps after the starting island
 * (IslandGrowth.ts; the `seed` and `grow` URL options, 1 and 0 by default; `pieces` without
 * `grow`). */
export interface LandOptions { worldSeed: number; step: number }

// The framing a land sets: the first island's (the tile layout's 384 m^2 round ( 1/3, -1 ), which
// the views were placed for) moved to the land's centroid and scaled by the ratio of their
// equivalent radii (a disc's of the same area).
const FIRST_ISLAND = { x: 1 / 3, z: - 1, radius: Math.sqrt( 384 / Math.PI ) };
export const landFraming = ( land: LandLattice ) => {

	const centroid = landCentroid( land ), scale = Math.sqrt( landArea( land ) / Math.PI ) / FIRST_ISLAND.radius;
	/** The first island's point ( x, y, z ) on this land. */
	const onLand = ( x: number, y: number, z: number ) => new THREE.Vector3( centroid.x + ( x - FIRST_ISLAND.x ) * scale, y, centroid.z + ( z - FIRST_ISLAND.z ) * scale );
	return { centroid, scale, onLand, pivot: onLand( 1.5, 0.5, 1 ) };

};

/** The chunks' progress (' done / total'), and who shows it once the loading screen reaches the
 * island (main.ts). */
export const worldProgress = { text: '', show: null as ( ( text: string ) => void ) | null };

/** Whether the world's chunks come from and go to the cache (`worldCache=off`: never). */
export const worldCacheOn = ! params.getAll( 'worldCache' ).some( ( v ) => v === 'off' || v === '0' );

/** Starts the world's generation, once, as the page's modules load: `pieces` is the land's step
 * when the `grow` option does not give one (the pieces a resumed game's save grew; 0 the starting
 * island). Returns the land's options and the job main.ts awaits. */
export function startWorld( start: { pieces: number } ): { landOptions: LandOptions; worldJob: Promise<LoadedWorld> } {

	const landOptions: LandOptions = { worldSeed: intParam( 'seed', 1 ), step: THREE.MathUtils.clamp( params.has( 'grow' ) ? intParam( 'grow', 0 ) : start.pieces, 0, GROWTH.maxSteps ) };
	const worldJob: Promise<LoadedWorld> = 'gpu' in navigator ? loadWorld( landOptions, {
		cache: worldCacheOn,
		pivot: ( land ) => landFraming( land ).pivot,
		progress: ( done, total ) => {

			worldProgress.text = ` ${ done } / ${ total }`;
			worldProgress.show?.( worldProgress.text );

		},
	} ) : new Promise( () => undefined );
	worldJob.catch( () => undefined ); // reported where it is awaited, under main.ts's world section
	if ( import.meta.env.DEV || params.has( 'debug' ) || params.has( 'profile' ) ) {

		const state: { ready: boolean; ms?: number } = { ready: false };
		( window as unknown as { __PONLAI_WORLD__: typeof state } ).__PONLAI_WORLD__ = state;
		// (a failed world is in too: the page goes on and reports it)
		const done = () => { state.ready = true; state.ms = performance.now(); };
		worldJob.then( done, done );

	}
	return { landOptions, worldJob };

}
