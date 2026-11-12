// The page: the one place that assembles it. It creates the three objects the page is built on
// (the renderer's parts, the island's, the page's own) and calls the stages that fill them in order:
// the renderer's (RenderStages.ts), the island's (IslandStages.ts) and the page's (app/: the camera
// views, the GUI, the frame, the scene jump, the diagnostics). Between the stages it does only what
// joins two layers: it hands one layer's parts to another's stage, and it starts the game, whose
// start takes what it needs from the renderer's and the island's parts.
// - The stages run in this order and no other: the renderer's and the island's alternate, and the
//   order materials first build in is part of the image (AGENTS.md, WebGPU / TSL pitfalls).
// - Every wait is here: a stage that ends in one returns its promise.
// - The imports below keep the order the page's modules have always loaded in, which the stage
//   files' own imports would otherwise change: a module that this file no longer names is imported
//   for its load alone. A new module is imported by the stage file that uses it, not here.
// On the dev server and with ?debug (or ?profile) the page hands the scene to the capture and
// profiling tools as `window.__PONLAI__` (app/Diagnostics.ts): `establishScene( query )` jumps to a
// whole scene as a fresh load of `?<query>` draws it (app/Scene.ts), and `loop` and `step` hold,
// resume and step the frame loop (app/Frame.ts).
// the page's settings, which its entry (Boot.ts) installed before this module's imports load
import { QUALITY_CHOICE } from './PageSettings.ts';
import { settings as params } from './Settings.ts';
import * as THREE from 'three/webgpu';
import 'lil-gui';
import './camera/FreeCameraControls.ts';
import './camera/IslandCameraControls.ts';
import './camera/IslandFraming.ts';
import './sky/Sky.ts';
import './sky/DayCycle.ts';
import './sky/Weather.ts';
import { type QualityTier, qualityProfile } from './Quality.ts';
import './QualityDetect.ts';
import './lighting/KeyCloud.ts';
import './weather/Wind.ts';
import './weather/Rain.ts';
import './ocean/OceanFFT.ts';
import './ocean/OceanSpectrum.ts';
import './ocean/ShoreWaves.ts';
import './ocean/WaveMaps.ts';
import './ocean/SeaDetail.ts';
import './ocean/Refraction.ts';
import './life/Wenyao.ts';
import { FallingLeaves, leavesPass } from './weather/FallingLeaves.ts';
import './ocean/Water.ts';
import './ocean/StormSea.ts';
import './materials/GroundTextures.ts';
import { setSoilStrength } from './materials/Soil.ts';
import { ISLAND_SEA } from './world/World.ts';
import './world/WorldFields.ts';
import './world/Growth.ts';
import { topFromTiles } from './game/sim/grid.ts';
import { worldJob, landOptions } from './WorldBoot.ts';
import './world/WorldStart.ts';
import './debug/ChunkBorders.ts';
import './debug/WindView.ts';
import './debug/WindArrows.ts';
import './world/Grass.ts';
import './world/Yunpeng.ts';
import './world/vegetation/LeafLight.ts';
import './materials/SwardTint.ts';
import './lighting/MeadowCanopy.ts';
import { Pipeline } from './post/Pipeline.ts';
import './post/LocalTone.ts';
import './weather/HazeKeys.ts';
import './post/RenderScale.ts';
import './post/DynamicResolution.ts';
import './post/FramePacer.ts';
import './post/SubmitBatch.ts';
import './three/ThreePatches.ts';
import './three/Internals.ts';
import './three/Backend.ts';
import './three/FrameLoop.ts';
import './debug/FrameStats.ts';
import { createShared, installShared } from './shared.ts';
import './lighting/SolarShadow.ts';
import './lighting/SunShadow.ts';
import './lighting/RefractedSun.ts';
import './lighting/GroundBounce.ts';
import { islandBounceGround } from './materials/BounceGround.ts';
import './materials/Meadow.ts';
import './lighting/AmbientGrade.ts';
import './lighting/LocalLights.ts';
import './lighting/KeyLift.ts';
import './lighting/SurfaceBRDF.ts';
import './lighting/AmbientVolume.ts';
import './lighting/AmbientSample.ts';
import './lighting/AmbientRelight.ts';
import { ISLAND_TOP, islandSurfaceHeight } from './world/WorldShapes.ts';
import './world/IslandGrowth.ts';
import './world/WalkPath.ts';
import './world/Bamboo.ts';
import './world/BambooGroves.ts';
import './world/BambooMaterials.ts';
import { Villagers, loadVillager } from './characters/Villagers.ts';
import './world/vegetation/Trample.ts';
import { PROPORTIONS } from './characters/Proportions.ts';
import './characters/Ages.ts';
import './characters/CharacterShadow.ts';
import './characters/CharacterMaterial.ts';
import './debug/DebugFlags.ts';
import './debug/TestMode.ts';
import './debug/Tune.ts';
import './sky/SkyRetune.ts';
import './post/Antialiasing.ts';
import './post/Motion.ts';
import './post/Jitter.ts';
import './post/TemporalRest.ts';
import './post/PreExposure.ts';
import { sceneEvent } from './post/SceneEvents.ts';
import './post/TemporalAA.ts';
import './post/Settled.ts';
import './lighting/Radiometry.ts';
import './lighting/SunDisc.ts';
import './post/graph/DebugView.ts';
import './world/VegetationPrepass.ts';
import './world/vegetation/Displacement.ts';
import './world/OpaquePrepass.ts';
import './post/GTAO.ts';
import './post/MeadowShade.ts';
import './world/vegetation/Registry.ts';
import './world/WindMotion.ts';
import './characters/looks.ts';
import type { PageParts } from './app/Page.ts';
import { type RenderParts, createRenderer, setUpRenderer, createScenes, createSky, createLight, createKey, createEnvironment, publishSkyLight, createSeaAndPipeline, createBounceAndShore, createAmbient, createWater, bakeWithHaze, awaitWarmUp, checkMotion, primeSharedBuilds } from './RenderStages.ts';
import { createIslandCamera, createTrample, createCharacterShadow, type IslandParts, bakeIslandGround, awaitWorld, createLand, createWorld, createWorldViews, createVegetation, createGrowth } from './IslandStages.ts';
import { createCameraViews } from './app/CameraViews.ts';
import { createFrameSizing, createFrame, startLoop, createLoopControls } from './app/Frame.ts';
import { createGui, addLookFolders, addHazeFolders } from './app/Gui.ts';
import { createDiagnostics, exposeDebugHandles } from './app/Diagnostics.ts';
import { createSceneControls } from './app/Scene.ts';

// the scene's uniforms, which every material reads: made here and installed before anything builds
const shared = createShared();
installShared( shared );

const render = {} as RenderParts;
const island = {} as IslandParts;
const page = {} as PageParts;


const ground = { soil: params.get( 'soil' ) !== '0' };
page.ground = ground;
setSoilStrength( ground.soil );
// GPU time per pass, tick time and startup marks for tools/profile-frame.mjs (?profile, or
// ?profile=frames without the GPU timestamps). The profiler loads only then; without it the
// renderer, its pipelines and the image are unchanged.
const profiler = params.has( 'profile' ) ? ( await import( './debug/FrameProfiler.ts' ) ).createFrameProfiler( THREE.InspectorBase, { timestamps: params.get( 'profile' ) !== 'frames' } ) : null;
render.profiler = profiler;
if ( profiler ) ( window as unknown as Record<string, unknown> ).__PONLAI_PROFILE__ = profiler.api;
render.mark = ( name: string ) => profiler?.mark( name );
// scene handles and frame diagnostics on window, for the capture tool and the console: dev server,
// ?debug or ?profile only
render.DEBUG = import.meta.env.DEV || params.has( 'debug' ) || profiler !== null;
// The quality tier (Quality.ts): its load knobs are read below as the parts they shape are built,
// its runtime ones applied by applySkyQuality. A change of tier reloads the page. Without ?quality
// it is high (QualityDetect.ts). The entry chose it with the settings (PageSettings.ts), since the
// anti-aliasing mode and other load knobs are read as the modules load, before this code runs.
const qualityChoice = QUALITY_CHOICE;
page.qualityChoice = qualityChoice;
const qualityTier: QualityTier = qualityChoice.tier;
render.qualityTier = qualityTier;
render.quality = qualityProfile( qualityTier );
const loading = document.getElementById( 'loading' );
page.loading = loading;
render.setStatus = ( s: string ) => { const el = loading?.querySelector( 'span' ); if ( el ) el.textContent = s; };
await createRenderer( render );
setUpRenderer( render );
// every render and compute pipeline the renderer creates, counted for the diagnostics (debug only)
page.pipelineCount = render.DEBUG ? ( await import( './debug/PipelineCounter.ts' ) ).installPipelineCounter( render.renderer ) : null;

// where the canvas goes and the size it starts at
const viewport = { host: document.getElementById( 'app' )!, width: innerWidth, height: innerHeight };
createScenes( render, { viewport } );
createIslandCamera( render, island );
createSky( render );
createTrample( island );
createCameraViews( render, island, page );
createLight( render );
createCharacterShadow( render, island );
createKey( render );
island.characterShadow.along = render.shadowDirection;
await createEnvironment( render );
publishSkyLight( render );
island.textures = await bakeIslandGround( render );
// The figures reach two metres above the meadow; the rain's ceiling keeps a margin over them and
// the plants, so no drop falls through their tops.
const rainCeiling = ISLAND_TOP + 4;
// The bamboo leaves the wind takes off the island (weather/FallingLeaves.ts), made once the world
// exists (the test mode leaves them out): their step is a pass the pipeline declares from this list.
island.fallingLeaves = null as FallingLeaves | null;
const extraPasses: ConstructorParameters<typeof Pipeline>[ 6 ] = [ leavesPass( () => island.fallingLeaves ) ];
createSeaAndPipeline( render, { rainCeiling, extraPasses } );
island.worldCache = await awaitWorld( render, island, { worldJob } );
createLand( render, island, { landOptions } );
const bounceGround = islandBounceGround( island.fields.beds, island.textures.soil );
const shoreData = island.data.shore;
createBounceAndShore( render, { fields: island.fields, bounceGround, shoreData } );
createWorld( render, island );
render.pipeline.waveMaps = render.waveMaps;
createWorldViews( render, island );
const ambientData = island.data.ambient;
await createAmbient( render, { ambientData, world: island.world } );
createVegetation( render, island );
// ?game turns the island into the game: its own islanders, a clock that drives the sky and the
// player's interface (src/game/ui/GameUi.ts); the GUI's Game folder and window.__PONLAI__.game
// drive the rest. Without it the scene stays the art-review scene with one islander walking a loop.
const GAME = params.has( 'game' );
page.GAME = GAME;
island.characters = null;
page.game = null;
if ( GAME ) {

	// loaded only here, so the art-review page does not carry the game's code
	const { Game } = await import( './game/Game.ts' );
	page.game = await Game.start( {
		params, scene: render.scene, camera: render.camera, canvas: render.renderer.domElement, land: island.land, top: topFromTiles( island.worldCache.version.chunks ),
		dayCycle: render.dayCycle, weather: render.weather, characterShadow: island.characterShadow, invalidateSunShadow: render.invalidateSunShadow, refreshEnvironment: render.refreshEnvironment, sceneEvent,
		// the island grows with the population (Growth.ts, made below: called from the frame loop on)
		pieces: landOptions.step,
		island: { approach: ( p ) => island.growth.approach( p ), grow: () => island.growth.grow() },
		// A prop can rise above all the island grows: the sun's map fits its casters and the sea's reflection marches its box, so both grow to hold it.
		holdOpaque: ( box ) => {

			island.heldOpaque.push( box.clone() );
			if ( ! island.sunCasters.containsBox( box ) ) render.sunShadow.setCasters( island.sunCasters.union( box ) );
			render.water?.hold( box );

		},
		// the game's props, for the scene's pass and the sun's map (see compileDraws)
		compileDraws: island.compileDraws,
		// every islander in the scene islander's proportions (the `islander` URL option). A figure
		// is handed over once its pipelines are built, off the frame (GameView "First draws"): it
		// arrives after the game's first frame, and each load brings its own material, so the frame
		// that first drew it built its skinned pipelines (the scene's pass, then the figures' map).
		loadLook: async ( look, body ) => {

			const dress = island.GAME_LOOKS[ look % island.GAME_LOOKS.length ];
			const figure = await loadVillager( dress.base, dress.parts, shared, PROPORTIONS[ island.islanderBuild.proportions ], dress.lit, dress.ages ? body : undefined );
			await render.latents.latent( 'opaque', [ figure.group ] );
			await island.characterShadow.compile( render.renderer, render.scene, figure.group );
			return figure;

		},
		lookColours: ( look ) => island.GAME_LOOKS[ look % island.GAME_LOOKS.length ].colours,
	} );

} else {

	island.characters = new Villagers( await island.buildIslander( island.islanderBuild.proportions ), island.walk, islandSurfaceHeight, island.characterShadow );
	render.scene.add( island.characters.group );

}
render.mark( 'villagers' );
const islandSea = ISLAND_SEA;
createWater( render, { fields: island.fields, landBox: island.landBox, islandSea, heldOpaque: island.heldOpaque } );
createGrowth( render, island, { landOptions, game: page.game } );
createFrameSizing( render, page );
createGui( render, island, page );
// the game's developer controls (GameDebug.ts)
if ( page.game ) await page.game.addDebugFolder( page.gui );
addLookFolders( render, page );
await bakeWithHaze( render );
addHazeFolders( render, page );
createFrame( render, island, page );
createDiagnostics( render, island, page );
await awaitWarmUp( render );
checkMotion( render );

if ( render.profiler ) {

	const { labelPonlaiPasses } = await import( './debug/FrameProfiler.ts' );
	labelPonlaiPasses( render.profiler, { scene: render.scene, waterScene: render.waterScene, rainScene: render.rainScene, pipeline: render.pipeline, sky: render.sky, rain: render.rain, sunShadow: render.sunShadow, refractedSun: render.refractedSun, fft: render.fft, stormSea: render.stormSea, shoreWaves: render.shoreWaves, groundBounce: render.groundBounce, characters: island.characters } );

}
primeSharedBuilds( render );
// The falling leaves, which the warm-up ran before they existed, and their kernels compile ahead
// as latents of the opaque pass, so the view that first finds them builds no pipeline.
if ( island.fallingLeaves ) await render.latents.latent( 'opaque', [ island.fallingLeaves.mesh ], [ island.fallingLeaves.kernel, island.fallingLeaves.prewarm ] );
startLoop( render, island, page );
createSceneControls( render, island, page );
createLoopControls( render, page );
exposeDebugHandles( render, island, page );
