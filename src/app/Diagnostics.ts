// The page's diagnostics and debug handles: `window.__THREE_GAME_DIAGNOSTICS__`, refreshed every
// 30 frames, and `window.__PONLAI__`, the scene's handles for the capture and profiling tools and
// the console. Both exist only on the dev server or with `?debug` / `?profile`.
import * as THREE from 'three/webgpu';
import { meadowCanopy, type GradeChanges, DynamicResolution, shared, ambientGrade, liftedKeyDirection, debugFlags, tuneApi, AA_MODE, AA_SOURCE, motionState, taaCut, motionCheck, jitter, restEpoch, preExposure, renderEvent, gtaoUniforms, type RenderParts } from '../render.ts';
import type { QualityProfile } from '../renderSetup.ts';
import { soilUniforms, setGroundGain, MEADOW_EXTENT, swardField, type IslandParts } from '../island.ts';
import type { PageParts } from './Page.ts';

// The dynamic scale's clock as a debug hook (`__PONLAI__.dynamicClock`): `suspend()` holds the
// controller's clock where it is, `resume()` lets it run on from there (the time between is skipped).
export function dynamicClock( d: DynamicResolution ): { suspend(): void; resume(): void; readonly suspended: boolean } {

	let skipped = 0, since = NaN;
	return {
		suspend() {

			if ( ! Number.isNaN( since ) ) return;
			since = performance.now() / 1000;
			const held = since - skipped;
			d.clock = () => held;

		},
		resume() {

			if ( Number.isNaN( since ) ) return;
			skipped += performance.now() / 1000 - since;
			since = NaN;
			d.clock = () => performance.now() / 1000 - skipped;

		},
		get suspended() { return ! Number.isNaN( since ); },
	};

}

/** The diagnostics snapshot the tools read. */
export function createDiagnostics( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { DEBUG, qualityTier, renderer, submitBatch, resolution, sky, dayCycle, weather, wind, pipeline } = render;
	const { worldCache, data, worldInfo } = island;
	const { pipelineCount, cameraSettings, dynamicResolution, pacer, frameTimes } = page;
	page.diagnostics = diagnostics;

	// The frame graph's state for the diagnostics: whether it is compiled and sized, its variant, its
	// passes (declared, culled, and run or skipped in the last frame), its graph-owned textures and
	// their memory, and its dev counters.
	function graphDiagnostics(): Record<string, unknown> {

		const g = pipeline.graph;
		const d = g.describe();
		const run = d.passes.filter( ( p ) => p.runs ).length;
		return {
			ready: d.ready,
			variant: d.variant,
			passes: d.passes.length,
			culled: d.culled,
			targets: d.resources.filter( ( r ) => ! r.imported ).map( ( r ) => ( { name: r.name, w: r.actual.width, h: r.actual.height, format: r.format, type: r.type, samples: r.samples } ) ),
			bytes: d.bytes,
			rebuilds: d.rebuilds,
			passesRun: run,
			passesSkipped: d.passes.length - d.culled.length - run,
			opsApplied: g.opsApplied,
			opsExpected: g.opsExpected,
			opsMismatchFrames: g.opsMismatchFrames,
			sizeErrors: g.sizeErrors,
		};

	}

	function diagnostics( now = false ): void {

		if ( ! DEBUG ) return;
		const current = ( window as unknown as Record<string, Record<string, unknown> | undefined> ).__THREE_GAME_DIAGNOSTICS__;
		if ( ! now && page.frame % 30 !== 1 ) {

			// the temporal resolve's state, the settled signal and the pre-exposure on every frame: the
			// capture tools wait for them
			if ( current && pipeline.resolver ) current.taa = pipeline.resolver.diagnostics();
			if ( current ) Object.assign( current, { settled: pipeline.settled.value, settle: pipeline.settled.diagnostics(), preExposure: preExposure.diagnostics() } );
			return;

		}
		const info = renderer.info;
		( window as unknown as Record<string, unknown> ).__THREE_GAME_DIAGNOSTICS__ = {
			frame: page.frame,
			frameMs: + ( frameTimes.reduce( ( a, b ) => a + b, 0 ) / frameTimes.length ).toFixed( 2 ),
			frameMsP95: + [ ...frameTimes ].sort( ( a, b ) => a - b )[ Math.floor( frameTimes.length * 0.95 ) ].toFixed( 2 ),
			canvas: [ renderer.domElement.width, renderer.domElement.height ],
			render: [ pipeline.width, pipeline.height ],
			upscaled: pipeline.upscaling,
			calls: info.render.drawCalls,
			triangles: info.render.triangles,
			computeCalls: info.compute.frameCalls,
			geometries: info.memory.geometries,
			textures: info.memory.textures,
			dpr: + ( pipeline.width / innerWidth ).toFixed( 4 ), // the render's pixel ratio
			renderScale: page.renderScale,
			dynamicResolution: dynamicResolution ? { scale: dynamicResolution.scale, source: dynamicResolution.source, changes: dynamicResolution.changes.length } : null,
			pacing: { target: pacer.target, rate: pacer.rate, mode: pacer.mode, refreshMs: + pacer.period.toFixed( 3 ), divisor: pacer.divisor, base: pacer.base, fallback: pacer.fallen, falls: pacer.falls, returns: pacer.returns, rendered: pacer.rendered, skipped: pacer.skipped, held: pacer.held, queued: pacer.queued, queueLimit: pacer.queueLimit },
			submits: { ...submitBatch.stats, why: { ...submitBatch.stats.why } },
			canvasDpr: renderer.getPixelRatio(),
			worldTriangles: worldInfo.worldTriangles,
			timings: data.timings,
			worldCache: worldCache.cache === 'off' ? 'off' : { cache: worldCache.cache, hits: worldCache.hits, chunks: worldCache.chunks, ms: + worldCache.ms.toFixed( 1 ) },
			backend: 'webgpu',
			hour: + dayCycle.hour.toFixed( 4 ),
			clockPaused: dayCycle.paused,
			scalePinned: resolution.full,
			skyBakeMs: + sky.lastBakeMs.toFixed( 2 ),
			skyBusy: sky.busy,
			skyTransitioning: sky.transitioning,
			quality: qualityTier,
			weather: weather.target,
			// the ambient grade's values (lighting/AmbientGrade.ts) and whether the GUI overrides them
			ambient: { ...ambientGrade.current, override: ambientGrade.override },
			weatherProgress: + weather.progress.toFixed( 3 ),
			rain: + sky.weather.rain.toFixed( 3 ),
			wetness: + shared.wetness.value.toFixed( 3 ),
			windSpeed: + wind.speed.toFixed( 3 ),
			windHeading: + wind.heading.toFixed( 2 ),
			windTarget: weather.windTarget,
			cameraMode: cameraSettings.mode,
			// the scene's anti-aliasing, the pipelines created so far and the frame graph's state and
			// dev counters, for the clip and first-use tools
			aa: AA_MODE,
			// where the mode came from: the URL (`aa`, `msaa`) or the quality tier's `aa` knob
			aaSource: AA_SOURCE,
			pipelines: pipelineCount?.total ?? 0,
			graph: graphDiagnostics(),
			// the temporal resolve: its mode, the rest (converged, frames, target), the jitter, the history's
			// resets, the input and output sizes and whether reactive inputs are read (TemporalAA.ts)
			taa: pipeline.resolver?.diagnostics() ?? null,
			// whether the paused page will draw the same frame from now on, and why not (post/Settled.ts)
			settled: pipeline.settled.value,
			settle: pipeline.settled.diagnostics(),
			// the pre-exposure's stops, the P the last reading asks for, whether it is pending, the
			// exposure EV last read back, its changes and its readings, the view and its quiet frames
			// (post/PreExposure.ts)
			preExposure: preExposure.diagnostics(),
		};

	}

}

/** The scene's handles on `window.__PONLAI__`. */
export function exposeDebugHandles( render: RenderParts, island: IslandParts, page: PageParts ) {

	const { DEBUG, quality, renderer, submitBatch, scene, camera, sky, dayCycle, weather, wind, applySkyQuality, sun, sunShadow, invalidateSunShadow, retuneSky, refreshEnvironment, applySun, setHour, setPreset, setWeather, setWind, fft, waveMaps, seaDetail, pipeline, groundBounce, shoreWaves, ambient, ambientRelight, refractedSun, stormSea, hazeKey, motionPasses } = render;
	const { controls, freeControls, landInfo, fields, wenyao, grass, yunpeng, bamboo, growth } = island;
	const { pipelineCount, cameraSettings, setCameraMode, setCameraView, weatherEffects, dynamicResolution, pacer, setTime, establishScene, loop, step } = page;

	if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__PONLAI__ = { land: landInfo, renderer, scene, camera, controls, freeControls, cameraSettings, setCameraMode, setCameraView, sky, sun, fft, shoreWaves, stormSea, waveMaps, water: render.water, pipeline, shared, refractedSun, groundBounce,
		// the direction the surfaces take the key's light from, the low key's lift included (lighting/KeyLift.ts)
		keyShading: () => liftedKeyDirection( sky.keyDir, sky.keyIsMoon, new THREE.Vector3() ),
		// the ambient grade (lighting/AmbientGrade.ts): `current`, `table`, `override` and `manual`
		ambient: ambientGrade,
		// the local lights (lighting/LocalLights.ts): `sources`, `gain`, `enabled`, `info()` (a promise: the
		// sources in view, the fullest cluster, the clusters that overflowed)
		localLights: render.localLights,
		// the screen-space ambient occlusion's knobs (post/GTAO.ts `gtaoUniforms`: cutoff, recede, base, maxTexels, fullDistance)
		gtao: gtaoUniforms,
		// the ambient light's probes (lighting/AmbientVolume.ts): `info()` and `hash()`
		ambientVolume: ambient,
		// their relight (lighting/AmbientRelight.ts): `readback()` and `hash()` of its output
		ambientRelight,
		// the look's knobs from a script (the GUI's raise their own events): the first table's grade
		// (GradeLut.ts), the meadow's and the cliff's albedos (groundGains), the leaves' (shared.leafGain)
		setGrade: ( changes?: GradeChanges ) => { pipeline.setGrade( changes ); renderEvent( 'retune' ); },
		setLawnGain: ( gain: number ) => { setGroundGain( 'lawnGain', gain ); groundBounce.invalidate(); renderEvent( 'retune' ); },
		setRockGain: ( gain: number ) => { setGroundGain( 'rockGain', gain ); renderEvent( 'retune' ); },
		setLeafGain: ( gain: number ) => { shared.leafGain.value = gain; renderEvent( 'retune' ); }, grass, wenyao, fallingLeaves: island.fallingLeaves, meadowCanopy, characters: island.characters, game: page.game, soilUniforms, dayCycle, weather, weatherEffects, wind, rain: render.rain, setWeather, setWind, establishScene, sceneJump: 1, applySun, refreshEnvironment, setHour, setPreset, sunShadow, invalidateSunShadow, setTime, clockTime: () => render.simTime, nominalScale: () => page.nominalScale, loop: Object.assign( loop, { step } ), pipelines: pipelineCount, flags: debugFlags,
		// the tunable parameters (debug/Tune.ts): set( { name: value } ), get, list, reset, query; a value
		// the environment's bakes depend on rebakes them at once (`retuneSky`, sky/SkyRetune.ts), as the
		// load bakes
		tune: tuneApi( () => {

			if ( ! retuneSky() ) renderEvent( 'retune' );

		} ),
		// the scene's linear radiance over screen boxes (debug/Radiance.ts), loaded on first call
		radiance: async ( options?: import( '../debug/Radiance.ts' ).RadianceOptions ) => ( await import( '../debug/Radiance.ts' ) ).readRadiance( renderer, pipeline, options, camera ),
		// the meadow map (world/SwardField.ts: RGBA bytes, G the sward's cover) and the extent it spans
		// round the origin, for tools that pick a view over the meadow
		meadowMap: async () => {

			const image = swardField.value.image as { data: Uint8Array; width: number };
			return { data: image.data, size: image.width, extent: MEADOW_EXTENT };

		},
		// where the bamboo's culms and shoots stand on the current land ( x, z, ... flat), for tools that keep a
		// view clear of the groves
		bambooSites: () => {

			const { culms, shoots } = bamboo.sites();
			return [ ...culms, ...shoots ].flatMap( ( c ) => [ c.x, c.z ] );

		},
		// where the yunpeng's clumps stand on the current land ( x, z, size per clump) and their lights
		yunpengSites: () => ( { clumps: yunpeng.sites().flatMap( ( c ) => [ c.x, c.z, c.size ] ), lights: yunpeng.lights().map( ( l ) => ( { position: l.position.toArray(), intensity: l.intensity.toArray(), range: l.range } ) ) } ),
		// the haze's key as the last frame set it (weather/HazeKeys.ts `hazeKeyAt`, `prepareHaze`): the
		// medium's amount and shape, the light's weights, the deck's shares; read, never written
		hazeKey,
		// the ambient light's irradiance on open level ground, from the probes (debug/AmbientProbe.ts)
		ambientProbe: async ( options?: Record<string, number> ) => ( await import( '../debug/AmbientProbe.ts' ) ).ambientProbe( { renderer, heightAt: ( x, z ) => controls.ground.heightAt( x, z ), land: island.landBox }, options ),
		// the wind's numbers for the vegetation (debug/WindProbe.ts), loaded on first call
		windProbe: async ( options?: Record<string, unknown> ) => ( await import( '../debug/WindProbe.ts' ) ).windProbe( { renderer, scene, shared, wind, weather, sky, fft, establishScene, setTime, data: () => island.shownData, seaDetail, land: () => island.landBox }, options ),
		// the island's growth: grow(), state, chunkHashes(), and the world fields' GPU bytes
		growth: Object.assign( growth, { fieldBytes: () => fields.bytes() } ),
		quality, dynamicResolution, pacer, submitBatch, jitter, motion: motionState, taaCut, motionCheck: () => motionCheck( motionPasses() ), applyQuality: ( overrides: Partial<QualityProfile> ) => applySkyQuality( { ...quality, ...overrides } ),
		// the temporal resolve (TemporalAA.ts, TemporalRest.ts): its live settings and knobs, the rest, the
		// epoch, and `restart()`, which starts the history and the rest over (a cut and an epoch bump)
		// (under fsr3 the same handles from FSR 3's upscaler, which has no knobs: the capture tools wait on
		// its rest through them)
		taa: pipeline.resolver ? {
			resolve: pipeline.resolver, settings: pipeline.resolver.settings, knobs: pipeline.temporal?.knobs ?? null, rest: pipeline.resolver.rest, epoch: restEpoch,
			get converged() { return pipeline.resolver!.converged; },
			restart: () => renderEvent( 'restart' ),
		} : null,
		// FSR 3 (post/fsr3/Fsr3Upscaler.ts, aa=fsr3): its rest, live settings and diagnostics()
		fsr3: pipeline.fsr3,
		// the profiler's A/B (profile-frame --compare): while it keeps this page stopped for the other
		// page's slices, the dynamic scale's clock stands still (DynamicResolution.ts `clock`), so its
		// holds and bars do not run out while the page draws nothing
		dynamicClock: dynamicResolution ? dynamicClock( dynamicResolution ) : null };

}
