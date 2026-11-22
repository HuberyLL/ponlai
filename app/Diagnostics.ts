// The island page's diagnostics and debug handles for the tools and the console, on debug pages only.
//
// The island page's part of the diagnostics and the handles (render/index.ts `startScene`, which
// publishes the render pipeline's: packages/render/assemble/SceneHandles.ts): the world's fields in
// `window.__THREE_GAME_DIAGNOSTICS__` (its triangles, its timings, the world cache, the camera
// mode), and in `window.__PONLAI__` the island's handles for the capture and profiling tools and
// the console. Both exist only on the dev server or with `?debug` / `?profile`.
import { renderEvent, type RenderParts, type SceneHandlesContent } from '../packages/render/index.ts';
import { soilUniforms, setGroundGain, MEADOW_EXTENT, swardField, type IslandParts } from '../packages/island/index.ts';
import type { PageParts } from './Page.ts';

/** The island page's diagnostics and handles. */
export function islandHandles( render: RenderParts, island: IslandParts, page: PageParts ): SceneHandlesContent {

	const { renderer, scene, sky, wind, weather, fft, seaDetail, groundBounce } = render;
	return {
		diagnostics() {

			const { worldCache, data, worldInfo } = island;
			return {
				worldTriangles: worldInfo.worldTriangles,
				timings: data.timings,
				worldCache: worldCache.cache === 'off' ? 'off' : { cache: worldCache.cache, hits: worldCache.hits, chunks: worldCache.chunks, ms: + worldCache.ms.toFixed( 1 ) },
				cameraMode: page.cameraSettings.mode,
			};

		},
		handles( jump ) {

			const { controls, freeControls, landInfo, fields, grass, yunpeng, bamboo, growth } = island;
			const { establishScene, setTime } = jump;
			return {
				land: landInfo, controls, freeControls, cameraSettings: page.cameraSettings, setCameraMode: page.setCameraMode, setCameraView: page.setCameraView,
				// the meadow's and the cliff's albedos (groundGains)
				setLawnGain: ( gain: number ) => { setGroundGain( 'lawnGain', gain ); groundBounce.invalidate(); renderEvent( 'retune' ); },
				setRockGain: ( gain: number ) => { setGroundGain( 'rockGain', gain ); renderEvent( 'retune' ); },
				grass, fallingLeaves: island.fallingLeaves, seaLife: island.seaLife, floorLife: island.floorLife, characters: island.characters, game: page.game, soilUniforms, weatherEffects: page.weatherEffects,
				// the meadow map (world/SwardField.ts: RGBA bytes, G the sward's cover) and the extent it spans
				// round the origin, for tools that pick a view over the meadow
				meadowMap: async () => {

					const image = swardField.value.image as { data: Uint8Array; width: number };
					return { data: image.data, size: image.width, extent: MEADOW_EXTENT };

				},
				// where the bamboo's culms stand on the current land ( x, z, ... flat), for tools that keep a
				// view clear of the groves
				bambooSites: () => {

					return bamboo.sites().culms.flatMap( ( c ) => [ c.x, c.z ] );

				},
				// where the yunpeng's clumps stand on the current land ( x, z, size per clump) and their lights
				yunpengSites: () => ( { clumps: yunpeng.sites().flatMap( ( c ) => [ c.x, c.z, c.size ] ), lights: yunpeng.lights().map( ( l ) => ( { position: l.position.toArray(), intensity: l.intensity.toArray(), range: l.range } ) ) } ),
				// the ambient light's irradiance on open level ground, from the probes (debug/AmbientProbe.ts)
				ambientProbe: async ( options?: Record<string, number> ) => ( await import( '../packages/render/debug/AmbientProbe.ts' ) ).ambientProbe( { renderer, heightAt: ( x, z ) => controls.ground.heightAt( x, z ), land: island.landBox }, options ),
				// the wind's numbers for the vegetation (debug/WindProbe.ts), loaded on first call
				windProbe: async ( options?: Record<string, unknown> ) => ( await import( '../packages/island/debug/WindProbe.ts' ) ).windProbe( { renderer, scene, shared: page.shared, wind, weather, sky, fft, establishScene, setTime, data: () => island.shownData, seaDetail, land: () => island.landBox }, options ),
				// the island's growth: grow(), state, chunkHashes(), and the world fields' GPU bytes
				growth: Object.assign( growth, { fieldBytes: () => fields.bytes() } ),
			};

		},
	};

}
