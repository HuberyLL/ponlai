// The scene page: one test scene (TestScene.ts) on the renderer alone, which scenes.html loads
// behind its entry (ScenesBoot.ts). It is to a test scene what main.ts is to the island: the one
// place that assembles it, with the renderer's stages (RenderStages.ts) in the order the island's
// page calls them, on the renderer's neutral inputs (NeutralInputs.ts) where the island hands its
// world's. It draws no island, no game and no GUI.
// - The scene is `scene=<name>` (index.ts). The scene's options (`weather`, `hour`, `preset`,
//   `paused`, ...) are the island page's and read the same way (render/index.ts `sceneOptions`), with a
//   load at noon where the query names no hour.
// - The frame is the renderer's frame stages in the island page's order, with nothing between
//   them, at the tier's nominal render scale (no dynamic scale: the scenes are shot paused).
// - It keeps the island page's contract with the tools: the URL options, `window.__PONLAI__` and
//   `window.__THREE_GAME_DIAGNOSTICS__` with its `settled` signal, on the dev server or with
//   `?debug` / `?profile`. `__PONLAI__.establishScene( query )` jumps to a scene's hour and weather
//   as a fresh load of that query draws it, the camera back at the scene's first view;
//   `__PONLAI__.scenePage` holds the scene's own handles: its `views`, `times` and `readings`,
//   `setView( name )` and `read()`, which measures the readings the view's frame holds.
// - A scene stands on level ground or in the open sea (TestScene.ts `SceneGround`). Ground has no
//   end, so its sea is never seen: the water's surface is built, as the frame's passes need it,
//   and hidden. The open sea is far from any shore and equally deep everywhere (the fields, the
//   probes and the bounce's ground of NeutralInputs.ts); the water is drawn, its floor and what
//   reaches under its surface are the scene's own.
// - The scene's plant kinds join the registry before `placeVegetation` closes it, drawn with the
//   default plant (vegetation/DefaultPlant.ts), and cast into the sun's map with the scene's
//   casters.
import * as THREE from 'three/webgpu';
import { awaitWarmUp, bakeRainCollision, bakeWithHaze, checkMotion, createAmbient, createBounceAndShore, createEnvironment, createFrameStages, createKey, createLight, createRenderer, createScenes, createSeaAndPipeline, createShared, createSky, createWater, defaultPlant, installShared, placeVegetation, vegetationCasters, primeSharedBuilds, publishSkyLight, registerLightHistories, registerSceneHistories, sceneOptions, setUpRenderer, startWaveMaps, neutralBounceGround, neutralFields, neutralLattice, neutralSeaLattice, OPEN_SEA_SHORE, Vegetation, FramePacer, PAUSED_QUEUE, gpuDevice, threeAnimation, TEST_MODE, AA_MODE, preExposure, renderEvent, restEpoch, tuneApi, debugFlags, type RenderParts } from '../../packages/render/index.ts';
import { settings as params, type SettingName, type QualityTier, qualityProfile, renderPixelRatio, outputPixelRatio, installedLook } from '../../packages/render/setup.ts';
import { SCENES } from './index.ts';
import type { ReadingContext, SceneReading, Triple } from './TestScene.ts';

const name = params.get( 'scene' ) ?? '';
const loading = document.getElementById( 'loading' );
const setStatus = ( s: string ) => { const el = loading?.querySelector( 'span' ); if ( el ) el.textContent = s; };
const testScene = Object.hasOwn( SCENES, name ) ? SCENES[ name ] : null;
if ( ! testScene ) {

	setStatus( `scene=${ Object.keys( SCENES ).join( ' | ' ) }` );
	throw new Error( `scenes: no scene '${ name }' (scene=${ Object.keys( SCENES ).join( ' | ' ) })` );

}

// the scene's uniforms, which every material reads: made from the look the entry installed (the
// neutral set, or the island's under `renderLook=ponlai`) and installed before anything builds
const shared = createShared( installedLook() );
installShared( shared );
const render = {} as RenderParts;

const profiler = params.has( 'profile' ) ? ( await import( '../../packages/render/debug/FrameProfiler.ts' ) ).createFrameProfiler( THREE.InspectorBase, { timestamps: params.get( 'profile' ) !== 'frames' } ) : null;
if ( profiler ) ( window as unknown as Record<string, unknown> ).__PONLAI_PROFILE__ = profiler.api;
const DEBUG = import.meta.env.DEV || params.has( 'debug' ) || profiler !== null;
// the tier the entry chose with the settings (ScenesBoot.ts)
const qualityTier = params.tier as QualityTier;
const quality = qualityProfile( qualityTier );
await createRenderer( render, { profiler, mark: ( mark ) => profiler?.mark( mark ), DEBUG, qualityTier, quality, setStatus } );
setUpRenderer( render );
createScenes( render, { viewport: { host: document.getElementById( 'app' )!, width: innerWidth, height: innerHeight }, dpr: params.has( 'dpr' ) ? Number( params.get( 'dpr' ) ) : null } );
const { renderer, scene, camera } = render;

// The scene a query names, the load's and a jump's alike: noon where it names no hour, the island
// page's length of day.
const sceneDefaults = { hour: 12, dayLength: 2880, parkedWeather: DEBUG };
// the exposure takes the look the entry installed (ScenesBoot.ts: the neutral set, or the island's
// under `renderLook=ponlai`), which this page cannot name
createSky( render, { scene: sceneOptions( params, sceneDefaults ), seaFog: params.has( 'seaFog' ), dayFog: params.has( 'dayFog' ), look: installedLook() } );

// ------------------------------------------------------------------ the views

const views = testScene.views;
// (a jump poses the first view before the key is the new hour's: TestScene.ts `SceneView`)
if ( typeof views[ 0 ].eye === 'function' || typeof views[ 0 ].target === 'function' ) throw new Error( `scenes: '${ testScene.name }''s first view follows the key; the first view is fixed` );
let shownView = views[ 0 ].name;
function poseView( viewName: string ): void {

	const view = views.find( ( v ) => v.name === viewName );
	if ( ! view ) throw new RangeError( `scenes: '${ testScene!.name }' has no view '${ viewName }' (${ views.map( ( v ) => v.name ).join( ', ' ) })` );
	const place = ( p: Triple | ( ( key: THREE.Vector3 ) => Triple ) ) => typeof p === 'function' ? p( render.sky.keyDir ) : p;
	shownView = view.name;
	camera.fov = view.fov ?? 27;
	camera.position.set( ...place( view.eye ) );
	camera.up.set( 0, 1, 0 );
	camera.lookAt( ...place( view.target ) );
	camera.updateProjectionMatrix();
	camera.updateMatrixWorld();

}
poseView( shownView );

createLight( render, { look: installedLook() } );
createKey( render );
await createEnvironment( render );
publishSkyLight( render );
const { ground } = testScene;
const seaLevel = shared.waterLevel.value;
// the rain's ceiling: over the tallest thing a scene stands on its ground, or on the sea
createSeaAndPipeline( render, { rainCeiling: ( ground.kind === 'land' ? ground.height : seaLevel ) + 8, extraPasses: [], look: installedLook() } );

// ------------------------------------------------------------------ the neutral world

// On land, far inland everywhere: the shore is nowhere near and the floor is the ground. At sea,
// far from any shore everywhere, over the floor at the scene's depth.
const FIELD_HALF = 64;
// where the water would take the open sea to deepen (m): past the sea's farthest edge, so that the
// floor's depth holds everywhere
const OPEN_SEA_DEEPENING = { from: 1e5, to: 2e5 };
const neutral = ground.kind === 'land'
	? neutralFields( { half: FIELD_HALF, shore: - 1000, floor: ground.height, xform: shared.shoreXform.value } )
	: neutralFields( { half: FIELD_HALF, shore: OPEN_SEA_SHORE, floor: seaLevel - ground.depth, xform: shared.shoreXform.value } );
const bounceGround = ground.kind === 'land'
	? neutralBounceGround( { ground: ground.height, albedo: ground.albedo } )
	: neutralBounceGround( { ground: seaLevel - ground.depth, albedo: ground.floor } );
createBounceAndShore( render, { fields: neutral.fields, bounceGround, shoreData: neutral.shoreData } );
const content = testScene.build( render );
const world = new THREE.Group();
world.name = 'scene';
world.add( ...content.objects );
scene.add( world );
world.updateMatrixWorld( true );
startWaveMaps( render );
await createAmbient( render, { ambientData: ground.kind === 'land' ? neutralLattice( { ground: ground.height, albedo: ground.albedo } ) : neutralSeaLattice( { sea: seaLevel } ), world: { group: world } } );
// the scene's plant kinds, drawn with the default plant; the registry places them and closes
const vegetation = new Vegetation( ( sites, kindName ) => defaultPlant( shared, sites, kindName ) );
for ( const kind of content.plants ?? [] ) vegetation.add( kind );
placeVegetation( render, vegetation, { ground: content.objects } );
// What casts into the sun's map: the scene's casters and its plants; a scene with nothing on its
// ground gives the map a box to fit.
const surfaceHeight = ground.kind === 'land' ? ground.height : seaLevel;
const casting = content.casters !== null || vegetation.kinds.length > 0;
const casters = vegetation.kinds.length
	? vegetationCasters( vegetation, { ground: content.objects, box: new THREE.Box3() } ).union( content.casters ?? new THREE.Box3() )
	: content.casters ?? new THREE.Box3( new THREE.Vector3( - 1, surfaceHeight, - 1 ), new THREE.Vector3( 1, surfaceHeight + 1, 1 ) );
render.sunShadow.setCasters( casters );
bakeRainCollision( render, vegetation, { ground: content.objects, area: neutral.bounds } );
// the sea reflects what stands inside the box of everything on the ground or on the sea
const reach = casters;
createWater( render, {
	fields: neutral.fields,
	landBox: { x0: Math.min( reach.min.x, - 1 ), z0: Math.min( reach.min.z, - 1 ), x1: Math.max( reach.max.x, 1 ), z1: Math.max( reach.max.z, 1 ) },
	// at sea no shelf: the floor's depth everywhere, the open sea's deepening past the farthest view
	islandSea: { openSea: ground.kind === 'land' ? { from: 400, to: 800 } : OPEN_SEA_DEEPENING, reflectorTop: reach.max.y + 1 },
	heldOpaque: [],
} );
render.water!.mesh.visible = ground.kind === 'sea';

// ------------------------------------------------------------------ the frame

// The canvas at the window's size and the render at the tier's nominal scale (`dpr` pins it).
const canvasSize = new THREE.Vector2();
function resize(): void {

	const w = innerWidth, h = innerHeight;
	let nominal = renderPixelRatio( w, h, quality.render, render.resolution.full, render.DPR_CAP );
	if ( AA_MODE === 'gt' ) nominal = outputPixelRatio( nominal );
	renderer.setPixelRatio( outputPixelRatio( nominal ) );
	renderer.setSize( w, h );
	camera.aspect = w / h;
	camera.updateProjectionMatrix();
	renderer.getDrawingBufferSize( canvasSize );
	// at the display's ratio the render is the canvas, to the pixel, and nothing is upscaled
	const native = nominal === renderer.getPixelRatio();
	render.pipeline.setSize( native ? canvasSize.x : Math.floor( w * nominal ), native ? canvasSize.y : Math.floor( h * nominal ), canvasSize.x, canvasSize.y );

}
addEventListener( 'resize', () => {

	renderEvent( 'resize' );
	resize();

} );
resize();
await bakeWithHaze( render );

const gpuQueue = gpuDevice<{ queue: { onSubmittedWorkDone(): Promise<void> } }>( renderer ).queue;
const frameRateParam = params.get( 'frameRate' );
const pacer = new FramePacer( quality.frameRate, {
	rate: frameRateParam === null || frameRateParam === 'auto' ? 'auto' : Number( frameRateParam ),
	allowFallback: params.get( 'frameFallback' ) !== '0',
} );
let revealed = false;
const frames = createFrameStages( render, {
	weatherEffects: { rain: true, wetness: true },
	environmentLook: { exposure: true },
	interval: () => pacer.target > 0 ? 1000 / pacer.target : 1000 / 60,
	pending() {},
	shown() {

		// the loading screen covers the canvas until its fade (scenes.html) has ended
		if ( ! revealed ) revealed = loading === null || ( loading.classList.contains( 'done' ) && getComputedStyle( loading ).opacity === '0' );
		return revealed;

	},
} );
const clock = new THREE.Timer();
clock.connect( document );
let frame = 0;
// The frame: the renderer's stages in their order (RenderStages.ts `FrameStages`), as the island
// page's tick calls them (app/Frame.ts), with no local lights and nothing of a world's between.
function tick( time: number ): void {

	clock.update( time );
	// a jump's explicit bake in flight: no frame, and the clock holds
	if ( frames.held() ) return;
	// (the clock never runs backwards: app/Frame.ts)
	const rawDt = Math.max( clock.getDelta(), 0 );
	const dt = Math.min( rawDt, 1 / 20 );
	const environmentDt = Math.min( rawDt, 1 );
	frames.advanceClock( dt );
	frames.advanceDay( rawDt, null );
	const nightAmbient = frames.trackSky( environmentDt );
	frames.lightNight( 0, nightAmbient );
	frames.advanceWeatherAndSea( dt, environmentDt );
	frames.relight();
	frames.draw( rawDt, dt );
	frames.submit();
	// a paused page in the test mode keeps at most PAUSED_QUEUE frames queued on the GPU
	const bounded = render.paused && TEST_MODE;
	pacer.queueLimit = bounded ? PAUSED_QUEUE : 0;
	if ( bounded ) pacer.submitted( gpuQueue.onSubmittedWorkDone() );
	frame ++;
	diagnostics();

}

// The diagnostics the tools wait on, refreshed every frame (debug pages).
function diagnostics(): void {

	if ( ! DEBUG ) return;
	const { pipeline } = render;
	( window as unknown as Record<string, unknown> ).__THREE_GAME_DIAGNOSTICS__ = {
		frame,
		scene: testScene!.name,
		view: shownView,
		canvas: [ renderer.domElement.width, renderer.domElement.height ],
		render: [ pipeline.width, pipeline.height ],
		backend: 'webgpu',
		hour: + render.dayCycle.hour.toFixed( 4 ),
		clockPaused: render.dayCycle.paused,
		quality: qualityTier,
		weather: render.weather.target,
		skyBusy: render.sky.busy,
		aa: AA_MODE,
		taa: pipeline.resolver?.diagnostics() ?? null,
		// whether the paused page will draw the same frame from now on, and why not (post/Settled.ts)
		settled: pipeline.settled.value,
		settle: pipeline.settled.diagnostics(),
		preExposure: preExposure.diagnostics(),
	};

}

await awaitWarmUp( render );
checkMotion( render );
primeSharedBuilds( render );
const loopBody = profiler ? profiler.wrapLoop( tick ) : tick;
// three's loop asks the pacer for its animation frames, so the frames it skips never reach it
const animation = threeAnimation( renderer );
animation.setContext( pacer.context );
renderer.setAnimationLoop( loopBody );
renderEvent( 'loop start' );
// The loading screen lifts once the sun's map has drawn (where anything casts into it) and the
// ambient light's first relight is in, at most REVEAL_WAIT ms on; a paused page lifts it without
// its fade, so a capture never shoots through it.
const REVEAL_WAIT = 3000;
// eslint-disable-next-line ponlai/scene-clock -- the loading screen's longest wait: when it lifts, not what is drawn
const revealAt = performance.now() + REVEAL_WAIT;
const reveal = () => {

	// eslint-disable-next-line ponlai/scene-clock -- the loading screen's longest wait: when it lifts, not what is drawn
	const waiting = ( ( casting && render.sunShadow.draws === 0 ) || ! render.ambientRelight.ready ) && performance.now() < revealAt;
	if ( waiting ) { setTimeout( reveal, 50 ); return; }
	if ( render.paused && loading ) loading.style.transition = 'none';
	loading?.classList.add( 'done' );

};
reveal();

// ------------------------------------------------------------------ the scene jump and the tools' handles

// What a jump clears of the scenes before, in the order it is cleared (post/SceneHistory.ts).
registerSceneHistories( render );
registerLightHistories( render );
render.history.onJump( 'frame pacer', () => pacer.reset() );

// The options that make a scene here; any other a jump's query names must equal the page's own.
const SCENE_OPTIONS = [ 'weather', 'wind', 'windDir', 'preset', 'hour', 'moon', 't', 'clouds', 'dayLength', 'paused', 'clock' ];
/** Leaves the page as a fresh load of `?<query>` draws it, from any hour and weather before
 * (the island page's contract: app/Scene.ts), the camera at the scene's first view. */
async function establishScene( request: string | URLSearchParams ): Promise<void> {

	const query = typeof request === 'string' ? new URLSearchParams( request ) : request;
	const fixed = [ ...new Set( query.keys() ) ].filter( ( key ) => ! SCENE_OPTIONS.includes( key ) && query.getAll( key ).join( '&' ) !== params.getAll( key as SettingName ).join( '&' ) );
	if ( fixed.length ) throw new Error( `establishScene: ${ fixed.join( ', ' ) } differ from the page's and are read once at load: reload the page with them` );
	render.jumpsInFlight ++;
	try {

		const next = sceneOptions( query, sceneDefaults );
		render.cloudOverride = next.clouds;
		render.weather.establish( next.weather, next.wind );
		render.weather.auto = next.autoWeather;
		render.dayCycle.reset( next.day );
		if ( next.preset ) render.dayCycle.setPreset( next.preset );
		render.paused = next.paused;
		render.simTime = next.time;
		poseView( views[ 0 ].name );
		render.history.jump( 'before bake' );
		renderEvent( 'establish scene' );
		render.manualSun = false;
		await render.bakeExplicitly();
		render.history.jump( 'after bake' );

	} finally {

		render.jumpsInFlight --;

	}

}

/** Moves the camera to one of the scene's views. */
function setView( viewName: string ): void {

	poseView( viewName );
	renderEvent( 'view jump' );

}

// Stops and restarts the frame loop (the island page's `loop`: app/Frame.ts).
const loop = {
	running: true,
	async stop(): Promise<void> {

		if ( ! loop.running ) return;
		loop.running = false;
		animation.stop();
		// eslint-disable-next-line ponlai/scene-clock -- the timeout of the wait for the sky's bakes, not a scene state
		const until = performance.now() + 2000;
		// eslint-disable-next-line ponlai/scene-clock -- the timeout of the wait for the sky's bakes, not a scene state
		while ( render.sky.busy && performance.now() < until ) await new Promise( ( resolve ) => setTimeout( resolve, 10 ) );
		await gpuQueue.onSubmittedWorkDone();

	},
	start(): void {

		if ( loop.running ) return;
		loop.running = true;
		renderEvent( 'loop start' );
		clock.reset();
		animation.start();

	},
};

// A reading's box on the frame, in fractions from its top-left corner: `size` of the frame's height
// a side, round the reading's point or direction; null where the frame does not hold all of it.
const projected = new THREE.Vector3();
function readingBox( reading: SceneReading, context: ReadingContext ): [ number, number, number, number ] | null {

	const resolve = ( place: Triple | ( ( context: ReadingContext ) => Triple ) ) => typeof place === 'function' ? place( context ) : place;
	if ( reading.at ) projected.set( ...resolve( reading.at ) );
	else if ( reading.toward ) projected.set( ...resolve( reading.toward ) ).normalize().multiplyScalar( 1000 ).add( camera.position );
	else return null;
	// (behind the camera)
	if ( projected.clone().applyMatrix4( camera.matrixWorldInverse ).z >= - camera.near ) return null;
	projected.project( camera );
	const h = reading.size ?? 0.02, w = h / camera.aspect;
	const x = ( projected.x + 1 ) / 2 - w / 2, y = ( 1 - projected.y ) / 2 - h / 2;
	if ( x < 0 || y < 0 || x + w > 1 || y + h > 1 ) return null;
	return [ x, y, w, h ];

}

/** The readings the shown view's frame holds: each one's box (fractions of the frame from its
 * top-left corner), its linear radiance before the sea, the air and the display chain (`opaque`)
 * and after the composite (`hdr`), with the light they were taken under. For the frame drawn last:
 * on a paused page, wait for `settled` first. */
async function read(): Promise<unknown> {

	const { sky, pipeline } = render;
	camera.updateMatrixWorld();
	const context: ReadingContext = { key: sky.keyDir.clone(), camera };
	const boxes: Record<string, [ number, number, number, number ]> = {};
	for ( const reading of testScene!.readings ) {

		const box = readingBox( reading, context );
		if ( box ) boxes[ reading.name ] = box;

	}
	const { readRadiance } = await import( '../../packages/render/debug/Radiance.ts' );
	const opaque = await readRadiance( renderer, pipeline, { boxes, source: 'opaque' }, camera ) as { boxes: Record<string, unknown>; exposure: unknown; preExposure: number };
	const hdr = await readRadiance( renderer, pipeline, { boxes, source: 'hdr' }, camera ) as { boxes: Record<string, unknown> };
	return {
		scene: testScene!.name, view: shownView, boxes,
		opaque: opaque.boxes, hdr: hdr.boxes, exposure: opaque.exposure, preExposure: opaque.preExposure,
		light: {
			hour: render.dayCycle.hour,
			weather: render.weather.target,
			keyIsMoon: sky.keyIsMoon,
			keyDirection: sky.keyDir.toArray(),
			keyElevation: THREE.MathUtils.radToDeg( Math.asin( THREE.MathUtils.clamp( sky.keyDir.y, - 1, 1 ) ) ),
			keyColour: sky.keyColor.toArray(),
			sunElevation: sky.elevation,
			skyIrradiance: sky.skyIrradiance.toArray(),
		},
	};

}

if ( DEBUG ) ( window as unknown as Record<string, unknown> ).__PONLAI__ = {
	renderer, scene, camera, sky: render.sky, sun: render.sun, pipeline: render.pipeline, shared, water: render.water,
	dayCycle: render.dayCycle, weather: render.weather, wind: render.wind, sunShadow: render.sunShadow,
	ambientVolume: render.ambient, ambientRelight: render.ambientRelight, groundBounce: render.groundBounce,
	quality, pacer, flags: debugFlags,
	establishScene, sceneJump: 1, loop,
	clockTime: () => render.simTime,
	// the tunable parameters (debug/Tune.ts), as on the island page
	tune: tuneApi( () => {

		if ( ! render.retuneSky() ) renderEvent( 'retune' );

	} ),
	// the scene's linear radiance over screen boxes (debug/Radiance.ts), loaded on first call
	radiance: async ( options?: import( '../../packages/render/debug/Radiance.ts' ).RadianceOptions ) => ( await import( '../../packages/render/debug/Radiance.ts' ) ).readRadiance( renderer, render.pipeline, options, camera ),
	taa: render.pipeline.resolver ? {
		resolve: render.pipeline.resolver, settings: render.pipeline.resolver.settings, rest: render.pipeline.resolver.rest, epoch: restEpoch,
		get converged() { return render.pipeline.resolver!.converged; },
		restart: () => renderEvent( 'restart' ),
	} : null,
	// the test scene's own handles
	scenePage: {
		name: testScene.name, about: testScene.about,
		views: views.map( ( v ) => v.name ), times: testScene.times, readings: testScene.readings.map( ( r ) => r.name ),
		get view() { return shownView; },
		setView, read,
	},
};
