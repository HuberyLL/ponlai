// The page: the one place that assembles it. It creates the three objects the page is built on
// (the renderer's parts, the island's, the page's own) and calls the stages that fill them in order:
// the renderer's (RenderStages.ts), the island's (IslandStages.ts) and the page's (app/: the camera
// views, the GUI, the frame, the scene jump, the diagnostics). Between the stages it does only what
// joins two layers: it hands one layer's parts to another's stage, and it starts the game, whose
// start takes what it needs from the renderer's and the island's parts.
// - The stages run in this order and no other: the renderer's and the island's alternate, and the
//   order materials first build in is part of the image (docs/reference/three-behaviour.md, Build order).
// - Every wait is here: a stage that ends in one returns its promise.
// - It takes each package through its exits (render/index.ts, render/setup.ts, island/index.ts, island/land.ts,
//   game/sim/index.ts, and the game's own, game/index.ts, by a dynamic import when `?game` starts it), never a
//   package's module by its path. An exit loads its whole package, and no module does
//   anything at load that depends on the order the modules load in.
// On the dev server and with ?debug (or ?profile) the page hands the scene to the capture and
// profiling tools as `window.__PONLAI__` (app/Diagnostics.ts): `establishScene( query )` jumps to a
// whole scene as a fresh load of `?<query>` draws it (app/Scene.ts), and `loop` and `step` hold,
// resume and step the frame loop (app/Frame.ts).
// the page's settings, which its entry (Boot.ts) installed before this module's imports load
import { QUALITY_CHOICE, PAGE_LOOK } from './PageSettings.ts';
import { type ExtraPass, DAY_PRESETS, sceneOptions, createShared, installShared, type RenderParts, createRenderer, setUpRenderer, createScenes, createSky, createLight, createKey, createEnvironment, publishSkyLight, createSeaAndPipeline, createBounceAndShore, createAmbient, startWaveMaps, createWater, bakeWithHaze, awaitWarmUp, checkMotion, primeSharedBuilds } from '../packages/render/index.ts';
import { settings as params, type QualityTier, qualityProfile } from '../packages/render/setup.ts';
import * as THREE from 'three/webgpu';
import { FallingLeaves, leavesPass, setSoilStrength, ISLAND_SEA, islandBounceGround, Villagers, loadVillager, PROPORTIONS, createIslandCamera, createTrample, createCharacterShadow, type IslandParts, bakeIslandGround, awaitWorld, createLand, createWorld, createWorldViews, createVegetation, createGrowth, holdOpaque } from '../packages/island/index.ts';
import { topFromTiles } from '../packages/game/sim/index.ts';
import { worldJob, landOptions } from './WorldBoot.ts';
import { ISLAND_TOP, islandSurfaceHeight } from '../packages/island/land.ts';
import type { PageParts } from './Page.ts';
import { createCameraViews } from './CameraViews.ts';
import { createFrameSizing, createFrame, startLoop, createLoopControls } from './Frame.ts';
import { createGui, addLookFolders, addHazeFolders } from './Gui.ts';
import { createDiagnostics, exposeDebugHandles } from './Diagnostics.ts';
import { createSceneControls } from './Scene.ts';

// the scene's uniforms, which every material reads: made here, from the look the entry picked
// (PageSettings.ts), and installed before anything builds
const shared = createShared( PAGE_LOOK );
installShared( shared );

const render = {} as RenderParts;
const island = {} as IslandParts;
const page = {} as PageParts;


const ground = { soil: params.get( 'soil' ) !== '0' };
page.ground = ground;
setSoilStrength( ground.soil );
// GPU time per pass, tick time and startup marks for tools/render/profile-frame.mjs (?profile, or
// ?profile=frames without the GPU timestamps). The profiler loads only then; without it the
// renderer, its pipelines and the image are unchanged.
const profiler = params.has( 'profile' ) ? ( await import( '../packages/render/debug/FrameProfiler.ts' ) ).createFrameProfiler( THREE.InspectorBase, { timestamps: params.get( 'profile' ) !== 'frames' } ) : null;
if ( profiler ) ( window as unknown as Record<string, unknown> ).__PONLAI_PROFILE__ = profiler.api;
// scene handles and frame diagnostics on window, for the capture tool and the console: dev server,
// ?debug or ?profile only
const DEBUG = import.meta.env.DEV || params.has( 'debug' ) || profiler !== null;
// The quality tier (Quality.ts): its load knobs are read below as the parts they shape are built,
// its runtime ones applied by applySkyQuality. A change of tier reloads the page. Without ?quality
// it is high (QualityDetect.ts). The entry chose it with the settings (PageSettings.ts), since the
// anti-aliasing mode and other load knobs are read as the modules load, before this code runs.
const qualityChoice = QUALITY_CHOICE;
page.qualityChoice = qualityChoice;
const qualityTier: QualityTier = qualityChoice.tier;
const quality = qualityProfile( qualityTier );
const loading = document.getElementById( 'loading' );
page.loading = loading;
await createRenderer( render, {
	profiler, mark: ( name ) => profiler?.mark( name ), DEBUG, qualityTier, quality,
	setStatus: ( s ) => { const el = loading?.querySelector( 'span' ); if ( el ) el.textContent = s; },
} );
setUpRenderer( render );
// every render and compute pipeline the renderer creates, counted for the diagnostics (debug only)
page.pipelineCount = render.DEBUG ? ( await import( '../packages/render/debug/PipelineCounter.ts' ) ).installPipelineCounter( render.renderer ) : null;

// where the canvas goes and the size it starts at
const viewport = { host: document.getElementById( 'app' )!, width: innerWidth, height: innerHeight };
// `dpr`: the page's pixel ratio, pinned (captures), over the display's and the tier's
createScenes( render, { viewport, dpr: params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : null } );
createIslandCamera( render, island );
// ?game turns the island into the game (below).
const GAME = params.has( 'game' );
// The scene the query names (render/index.ts `sceneOptions`), the load's and a scene jump's alike. Where
// it names no hour or day length: a 48-minute day from the golden hour, as in many open-world
// games, slow enough to watch the light change; the game's day is 24 minutes at 1x, so a day's
// work and its evening fit one sitting, and it starts at 8 (Game.ts), so the sky is lit once for
// that hour. A parked weather loads on a debug page only.
const sceneDefaults = GAME ? { hour: 8, dayLength: 1440, parkedWeather: render.DEBUG } : { hour: DAY_PRESETS[ 'golden-hour' ], dayLength: 2880, parkedWeather: render.DEBUG };
page.sceneOptions = ( query ) => sceneOptions( query, sceneDefaults );
// the look's tables the exposure is made from: the set the entry picked (PageSettings.ts)
createSky( render, { scene: page.sceneOptions( params ), seaFog: params.has( 'seaFog' ), dayFog: params.has( 'dayFog' ), look: PAGE_LOOK } );
createTrample( render, island );
createCameraViews( render, island, page );
createLight( render, { look: PAGE_LOOK } );
createCharacterShadow( render, island );
createKey( render );
island.characterShadow.along = render.shadowDirection;
await createEnvironment( render );
publishSkyLight( render );
island.textures = await bakeIslandGround( render );
// The figures reach two metres above the meadow; the rain's ceiling keeps a margin over them and
// the plants, so no drop falls through their tops.
const rainCeiling = ISLAND_TOP + 4;
// The bamboo leaves the wind takes off the island (world/FallingLeaves.ts), made once the world
// exists (the test mode leaves them out): their step is a pass the pipeline declares from this list.
island.fallingLeaves = null as FallingLeaves | null;
const extraPasses: ExtraPass[] = [ leavesPass( () => island.fallingLeaves ) ];
createSeaAndPipeline( render, { rainCeiling, extraPasses, look: PAGE_LOOK } );
island.worldCache = await awaitWorld( render, island, { worldJob } );
createLand( render, island, { landOptions } );
const bounceGround = islandBounceGround( island.fields.beds, island.textures.soil );
const shoreData = island.data.shore;
createBounceAndShore( render, { fields: island.fields, bounceGround, shoreData } );
createWorld( render, island );
startWaveMaps( render );
createWorldViews( render, island );
const ambientData = island.data.ambient;
await createAmbient( render, { ambientData, world: island.world } );
createVegetation( render, island, { framing: page.framing } );
// ?game turns the island into the game: its own islanders, a clock that drives the sky and the
// player's interface (packages/game/ui/GameUi.ts); the GUI's Game folder and window.__PONLAI__.game
// drive the rest. Without it the scene stays the art-review scene with one islander walking a loop.
page.GAME = GAME;
island.characters = null;
page.game = null;
if ( GAME ) {

	// loaded only here, so the art-review page does not carry the game's code
	const { Game } = await import( '../packages/game/index.ts' );
	page.game = await Game.start( {
		params, scene: render.scene, camera: render.camera, canvas: render.renderer.domElement, land: island.land, top: topFromTiles( island.worldCache.version.chunks ),
		dayCycle: render.dayCycle, weather: render.weather, characterShadow: island.characterShadow, invalidateSunShadow: render.invalidateSunShadow, refreshEnvironment: render.refreshEnvironment,
		// the island grows with the population (Growth.ts, made below: called from the frame loop on)
		pieces: landOptions.step,
		island: { approach: ( p ) => island.growth.approach( p ), grow: () => island.growth.grow() },
		// A prop can rise above all the island grows: the sun's map fits its casters and the sea's reflection marches its box, so both grow to hold it.
		holdOpaque: ( box ) => holdOpaque( render, island, box ),
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
createGrowth( render, island, { landOptions, game: page.game, framing: page.framing } );
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

	const { labelPonlaiPasses } = await import( '../packages/render/debug/FrameProfiler.ts' );
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
