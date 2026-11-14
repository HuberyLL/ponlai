// The page: the one place that assembles it, from the renderer's assembly and the island's stages.
//
// The page: the one place that assembles it. It hands the renderer's assembly (render/index.ts
// `startScene`) the island's content: the island's stages (IslandStages.ts) and the page's own parts
// (app/: the camera views, the GUI, its part of the frame, of the scene jump and of the diagnostics),
// each in the slot between the renderer's stages where its statements stand. Between them it does only
// what joins two layers: it hands one layer's parts to another's stage, and it starts the game, whose
// start takes what it needs from the renderer's and the island's parts.
// - The slots run in the assembly's order and no other: the renderer's stages and the island's
//   alternate, and the order materials first build in is part of the image
//   (docs/reference/three-behaviour.md, Build order).
// - Every wait is in a slot: a slot that ends in one returns its promise.
// - It takes each package through its exits (render/index.ts, render/setup.ts, render/browser.ts,
//   island/index.ts, island/land.ts, game/sim/index.ts, and the game's own, game/index.ts, by a dynamic
//   import when `?game` starts it), never a package's module by its path. An exit loads its whole
//   package, and no module does anything at load that depends on the order the modules load in.
// On the dev server and with ?debug (or ?profile) the assembly hands the scene to the capture and
// profiling tools as `window.__PONLAI__` with the island's handles (app/Diagnostics.ts):
// `establishScene( query )` jumps to a whole scene as a fresh load of `?<query>` draws it (the
// island's part: app/Scene.ts), and `loop` and `step` hold, resume and step the frame loop.
// the page's settings, which its entry (Boot.ts) installed before this module's imports load
import { QUALITY_CHOICE, PAGE_LOOK } from './PageSettings.ts';
import { startScene, type ExtraPass, type RenderParts } from '../packages/render/index.ts';
import { browserHost } from '../packages/render/browser.ts';
import { settings as params } from '../packages/render/setup.ts';
import { FallingLeaves, leavesPass, setSoilStrength, ISLAND_SEA, islandBounceGround, Villagers, loadVillager, PROPORTIONS, createIslandCamera, createTrample, createCharacterShadow, type IslandParts, bakeIslandGround, awaitWorld, createLand, createWorld, createWorldViews, createVegetation, createGrowth, holdOpaque } from '../packages/island/index.ts';
import { topFromTiles } from '../packages/game/sim/index.ts';
import { worldJob, landOptions } from './WorldBoot.ts';
import { ISLAND_TOP, islandSurfaceHeight } from '../packages/island/land.ts';
import type { PageParts } from './Page.ts';
import { createCameraViews } from './CameraViews.ts';
import { islandFrame, islandLoop, addKeys, sceneDefaults } from './Frame.ts';
import { createGui, addLookFolders, addHazeFolders } from './Gui.ts';
import { islandHandles } from './Diagnostics.ts';
import { islandJump } from './Scene.ts';

const island = {} as IslandParts;
const page = {} as PageParts;
// (the renderer's parts, as the assembly builds them: every slot below runs once they exist)
let render = {} as RenderParts;

const ground = { soil: params.get( 'soil' ) !== '0' };
page.ground = ground;
setSoilStrength( ground.soil );
// The quality tier (Quality.ts): without ?quality it is high (QualityDetect.ts). The entry chose it
// with the settings (PageSettings.ts), since the anti-aliasing mode and other load knobs are read as
// the modules load, before this code runs. A change of tier reloads the page.
page.qualityChoice = QUALITY_CHOICE;
page.detector = null;
// ?game turns the island into the game: its own islanders, a clock that drives the sky and the
// player's interface (packages/game/ui/GameUi.ts); the GUI's Game folder and window.__PONLAI__.game
// drive the rest. Without it the scene stays the art-review scene with one islander walking a loop.
const GAME = params.has( 'game' );
page.GAME = GAME;
island.characters = null;
page.game = null;
// The bamboo leaves the wind takes off the island (world/FallingLeaves.ts), made once the world
// exists (the test mode leaves them out): their step is a pass the pipeline declares from this list.
island.fallingLeaves = null as FallingLeaves | null;

const host = browserHost( { canvasHost: document.getElementById( 'app' )!, loading: document.getElementById( 'loading' ) } );
// The scene the query names (render/index.ts `sceneOptions`), the load's and a scene jump's alike,
// from the page's defaults (Frame.ts `sceneDefaults`); a parked weather loads on a debug page only.
await startScene( host, { look: PAGE_LOOK, defaults: sceneDefaults( GAME ) }, {
	afterScenes( scene ) {

		render = scene.render;
		page.shared = scene.shared;
		createIslandCamera( render, island );

	},
	afterSky() {

		createTrample( render, island );
		createCameraViews( render, island, page );

	},
	afterLight: () => createCharacterShadow( render, island ),
	afterKey() {

		island.characterShadow.along = render.shadowDirection;

	},
	async afterEnvironment() {

		island.textures = await bakeIslandGround( render );

	},
	// The figures reach two metres above the meadow; the rain's ceiling keeps a margin over them and
	// the plants, so no drop falls through their tops.
	passes: () => ( { rainCeiling: ISLAND_TOP + 4, extraPasses: [ leavesPass( () => island.fallingLeaves ) ] as ExtraPass[] } ),
	async ground() {

		island.worldCache = await awaitWorld( render, island, { worldJob } );
		createLand( render, island, { landOptions } );
		return { fields: island.fields, bounceGround: islandBounceGround( island.fields.beds, island.textures.soil ), shoreData: island.data.shore };

	},
	afterBounce: () => createWorld( render, island ),
	ambient() {

		createWorldViews( render, island );
		return { ambientData: island.data.ambient, world: island.world };

	},
	async afterAmbient() {

		createVegetation( render, island, { framing: page.framing } );
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
					const figure = await loadVillager( dress.base, dress.parts, page.shared, PROPORTIONS[ island.islanderBuild.proportions ], dress.lit, dress.ages ? body : undefined );
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

	},
	water: () => ( { fields: island.fields, landBox: island.landBox, seaShape: ISLAND_SEA, heldOpaque: island.heldOpaque } ),
	async afterWater( { sizing } ) {

		createGrowth( render, island, { landOptions, game: page.game, framing: page.framing } );
		page.resize = sizing.resize;
		createGui( render, island, page );
		// the game's developer controls (GameDebug.ts)
		if ( page.game ) await page.game.addDebugFolder( page.gui );
		addLookFolders( render, page );

	},
	afterHaze: () => addHazeFolders( render, page ),
	frame: () => islandFrame( render, island, page ),
	async afterWarmUp() {

		if ( ! render.profiler ) return;
		const { labelPasses } = await import( '../packages/render/debug/FrameProfiler.ts' );
		labelPasses( render.profiler, { scene: render.scene, waterScene: render.waterScene, rainScene: render.rainScene, pipeline: render.pipeline, sky: render.sky, rain: render.rain, sunShadow: render.sunShadow, refractedSun: render.refractedSun, fft: render.fft, stormSea: render.stormSea, shoreWaves: render.shoreWaves, groundBounce: render.groundBounce } );
		// the page's own parts: the islanders' update draws their shadow
		render.profiler.scope( island.characters, 'update', 'character shadow' );

	},
	async afterShared() {

		// The falling leaves, which the warm-up ran before they existed, and their kernels compile ahead
		// as latents of the opaque pass, so the view that first finds them builds no pipeline.
		if ( island.fallingLeaves ) await render.latents.latent( 'opaque', [ island.fallingLeaves.mesh ], [ island.fallingLeaves.kernel, island.fallingLeaves.prewarm ] );

	},
	...islandLoop( () => render, island, page ),
	jump: () => islandJump( render, island, page ),
	handles: () => islandHandles( render, island, page ),
} );
addKeys( render, page );
